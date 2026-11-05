// v45 quotations.
// 1. The client's Client Manager (or leadership / Finance) makes a quotation for a client from a template per service,
//    edits it and sends it. The client's Owner and Finance users are told; it shows on their portal.
// 2. The client's Owner accepts it in the app (typing their name) or declines it with a reason.
// 3. v49: accepting needs the Owner's signature (and seal), or the signed copy uploaded; they can also ask for changes,
//    which sends it back to the manager to edit and send again. It is signed for BMU by whoever sends it.
// 4. The client pays and says so ("I have paid"); the CM and Founders are told. The CM or a Founder then sends the advance
//    and balance invoices from the quotation, in its design, and what the client reported is recorded on them.
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import {
  BMU_ADDRESS,
  DEFAULT_QUOTE_TEMPLATE,
  INVOICE_IMAGE_MAX_BYTES,
  INVOICE_IMAGE_TYPES,
  QUOTE_ACCEPT_FILE_KINDS,
  QUOTE_SIGNED_COPY_MAX_BYTES,
  quotePaidSchema,
  type QuoteAcceptFileKind,
  type QuotePaymentNote,
  QUOTE_FIXED_TERMS,
  QUOTE_OVERVIEW_MAX,
  quoteOverviewSchema,
  type QuoteClientDetails,
  quoteContentSchema,
  quoteDecisionSchema,
  quoteSaveSchema,
  quoteTemplateSchema,
  quoteTotals,
  serviceAmountInWords,
  type Me,
  type QuoteContent,
  type QuoteRow,
  type QuoteStatus,
  type QuoteTemplateRow,
  type QuoteView,
} from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { AiService, textOf } from '../ai/ai.service.js';
import { AuditService } from '../audit/audit.service.js';
import { parse } from '../common/zod.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { relPath, sha256, type OpsUpload } from '../ops-actions/ops-util.js';
import { BillingService, issueInvoiceTx } from '../requests/billing.service.js';
import { cmDesignation, signingFileUrl } from '../service/cm-signing.service.js';
import { sendStoredFile } from '../storage/file-store.js';
import { readInvoiceBranding } from '../service/invoice-branding.service.js';
import { ServiceBillingService } from '../service/service-billing.service.js';
import { SettingsService } from '../settings/settings.service.js';

type QuoteDb = NonNullable<Awaited<ReturnType<PrismaService['quotation']['findFirst']>>>;
const has = (me: Me, ...roles: string[]) => me.roles.some((r) => roles.includes(r));
const LEAD = ['founder', 'admin', 'am_lead'];
type Signer = { name: string; role: string; signatureFileId: string | null; sealFileId: string | null };
type Stamped = { clientDetails?: QuoteClientDetails; signedBy?: Signer };
const ACCEPT_TAGS: Record<QuoteAcceptFileKind, string> = { signature: 'quote-client-signature', seal: 'quote-client-seal', signed_copy: 'quote-signed-copy' };
const notesOf = (q: { paymentNotes: unknown }) => (q.paymentNotes ?? []) as QuotePaymentNote[];
const ymdIst = (d = new Date()) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);

@Injectable()
export class QuotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly billing: ServiceBillingService,
    private readonly payments: BillingService,
    private readonly ai: AiService,
  ) {}

  // ------------------------------------------------------------------------------------------------ access

  private assertStaff(me: Me) {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
  }

  /** The client's Client Manager, leadership (Founder, Branch Manager, CM Lead) and Finance. */
  private async canManage(me: Me, clientOrgId: string) {
    if (has(me, ...LEAD, 'finance')) return true;
    if (!has(me, 'account_manager')) return false;
    return (await this.prisma.clientOrg.count({ where: { id: clientOrgId, orgId: me.orgId, amUserId: me.id } })) > 0;
  }

  private async assertManage(me: Me, clientOrgId: string) {
    this.assertStaff(me);
    if (!(await this.canManage(me, clientOrgId))) throw new ForbiddenException("Only the client's Client Manager, leadership or Finance can do this");
  }

  private canTemplates(me: Me) {
    return me.type === 'staff' && has(me, ...LEAD);
  }

  private status(q: { status: string; validUntil: Date }): QuoteStatus {
    if (q.status === 'sent' && ymdIst() > q.validUntil.toISOString().slice(0, 10)) return 'expired';
    return q.status as QuoteStatus;
  }

  private async load(me: Me, id: string) {
    const q = await this.prisma.quotation.findFirst({ where: { id, orgId: me.orgId } });
    if (!q) throw new NotFoundException('Quotation not found');
    return q;
  }

  // ------------------------------------------------------------------------------------------------ views

  /** v48: who the quotation is prepared for, from the client's record: its contact, else the lead's, else its Owner's login. */
  private async clientDetails(clientOrgId: string): Promise<QuoteClientDetails> {
    const c = await this.prisma.clientOrg.findUniqueOrThrow({ where: { id: clientOrgId }, select: { name: true, legalName: true, billingAddress: true, billingEmail: true, primaryContact: true, leadId: true } });
    type Contact = { name?: string | null; email?: string | null } | null;
    const lead = !c.primaryContact && c.leadId ? await this.prisma.lead.findUnique({ where: { id: c.leadId }, select: { contact: true } }) : null;
    const contact = (c.primaryContact ?? lead?.contact ?? null) as Contact;
    const owner = await this.prisma.clientUser.findFirst({ where: { clientOrgId, clientRole: 'client_owner', user: { deletedAt: null } }, select: { user: { select: { name: true, email: true } } } });
    return { company: c.legalName || c.name, owner: contact?.name || owner?.user.name || null, email: contact?.email || c.billingEmail || owner?.user.email || null, address: c.billingAddress || null };
  }

  /** v49: two lines on what BMU will do for the client, for the manager to keep or edit. Plain wording when AI is off. */
  async overview(me: Me, body: unknown) {
    this.assertStaff(me);
    if (!has(me, ...LEAD, 'finance', 'account_manager')) throw new ForbiddenException('Only Client Managers, leadership or Finance can do this');
    const input = parse(quoteOverviewSchema, body);
    const names = input.lines.map((l) => l.title).filter(Boolean);
    if (!names.length && !input.title) throw new BadRequestException('Tick a service or add a cost line first');
    const client = input.clientOrgId ? await this.prisma.clientOrg.findFirst({ where: { id: input.clientOrgId, orgId: me.orgId }, select: { name: true, industry: true } }) : null;
    const basic = `BMU Marketing will deliver ${names.length ? names.join(', ') : input.title}${client ? ` for ${client.name}` : ''}, planned and reported by one team.`.slice(0, QUOTE_OVERVIEW_MAX);
    const r = await this.ai.execute({ orgId: me.orgId, userId: me.id, me }, 'quote_overview', {
      basic: () => ({ text: basic }),
      ai: async (run) => {
        const msg = await run({
          fast: true,
          system:
            'You write the "Project overview" on quotations of BMU Marketing, a digital marketing agency in Bengaluru. Write two plain sentences, at most 35 words and 230 characters in all, saying what BMU will do for this client and why it helps them. ' +
            'Use only the services given; do not invent numbers, prices, dates or promised results. Indian English. Return only the text.',
          messages: [{ role: 'user', content: `Client: ${client?.name ?? 'not given'}${client?.industry ? ` (${client.industry})` : ''}\nProject: ${input.title || 'not given'}\n\nServices:\n${input.lines.map((l) => `- ${l.title}${l.details ? `: ${l.details}` : ''}`).join('\n')}` }],
          maxTokens: 200,
        });
        return { text: textOf(msg) };
      },
    });
    return { text: (r.text || basic).trim().slice(0, QUOTE_OVERVIEW_MAX), ai: r.mode === 'ai' };
  }

  /** v49: who signs a quotation for BMU: a Founder or Admin with the company signature, anyone else with their own. */
  private async signerFor(me: Me): Promise<Signer> {
    const b = await readInvoiceBranding(this.prisma, me.orgId);
    if (has(me, 'founder', 'admin')) return { name: b.signatoryName || me.name, role: b.designation || (has(me, 'founder') ? 'Founder' : 'Admin'), signatureFileId: b.signatureFileId, sealFileId: b.sealFileId };
    const p = await this.prisma.signingProfile.findUnique({ where: { userId: me.id }, select: { signatureFileId: true } });
    return { name: me.name, role: has(me, 'am_lead', 'account_manager') ? cmDesignation(me) : 'Finance', signatureFileId: p?.signatureFileId ?? null, sealFileId: b.sealFileId };
  }

  private async view(me: Me, q: QuoteDb): Promise<QuoteView> {
    const [gst, tenant, branding, client, details, invoices, creator, engagements] = await Promise.all([
      this.settings.get(q.orgId, 'gst'),
      this.settings.get(q.orgId, 'tenant'),
      readInvoiceBranding(this.prisma, q.orgId),
      this.prisma.clientOrg.findUniqueOrThrow({ where: { id: q.clientOrgId }, select: { id: true, name: true } }),
      (q.content as Stamped).clientDetails ?? this.clientDetails(q.clientOrgId),
      this.prisma.invoice.findMany({ where: { id: { in: [q.advanceInvoiceId, q.balanceInvoiceId].filter((x): x is string => !!x) } }, select: { id: true, number: true, status: true, totalPaise: true } }),
      q.createdById ? this.prisma.user.findUnique({ where: { id: q.createdById }, select: { name: true } }) : null,
      q.engagementIds.length ? this.prisma.engagement.findMany({ where: { id: { in: q.engagementIds } }, select: { id: true, service: { select: { name: true } } } }) : [],
    ]);
    const stored = q.content as unknown as QuoteContent;
    // v46: the fixed terms (a quotation keeps the wording it was sent with).
    const content = { ...stored, terms: stored.terms?.length && q.status !== 'draft' ? stored.terms : QUOTE_FIXED_TERMS };
    const t = quoteTotals(content.lines, q.gstRatePct);
    const status = this.status(q);
    const founder = branding.signatoryName ? null : await this.prisma.user.findFirst({ where: { orgId: q.orgId, type: 'staff', deletedAt: null, roles: { some: { role: { baseRole: 'founder' } } } }, select: { name: true }, orderBy: { createdAt: 'asc' } });
    const signatory = `${branding.signatoryName || founder?.name || gst.legalName || tenant.name}${branding.designation ? `, ${branding.designation}` : ''}`;
    const address = (gst.address?.trim() || BMU_ADDRESS).split(/\n|,\s*(?=\S)/).map((s) => s.trim()).filter(Boolean);
    const upiId = gst.upiId?.trim() || null;
    const payee = gst.bankAccountName?.trim() || gst.legalName || tenant.name;
    const staff = me.type === 'staff';
    const manage = staff && (await this.canManage(me, q.clientOrgId));
    // v49: a draft shows who would sign it; older sent quotations only have the company's name.
    const stamped = (q.content as Stamped).signedBy ?? (staff && q.status === 'draft' ? await this.signerFor(me) : null);
    const notes = notesOf(q);
    const quoteInvoices = [q.advanceInvoiceId, q.balanceInvoiceId].filter((x): x is string => !!x);
    const recorded = quoteInvoices.length ? ((await this.prisma.payment.aggregate({ where: { invoiceId: { in: quoteInvoices } }, _sum: { amountPaise: true } }))._sum.amountPaise ?? 0) : 0;
    const reported = notes.reduce((s, n) => s + n.amountPaise, 0);
    const openInvoice = invoices.some((i) => ['issued', 'partially_paid', 'overdue'].includes(i.status));
    const advance = invoices.find((i) => i.id === q.advanceInvoiceId);
    const balance = invoices.find((i) => i.id === q.balanceInvoiceId);
    return {
      id: q.id,
      number: q.number,
      status,
      date: (q.sentAt ?? q.createdAt).toISOString(),
      validUntil: q.validUntil.toISOString().slice(0, 10),
      seller: { name: gst.legalName || tenant.name, addressLines: address, website: gst.website?.trim() || 'www.bmumarketing.in', gstin: gst.gstin?.trim() || null, signatory },
      client: { id: client.id, name: client.name, preparedFor: q.preparedFor, ...details },
      signer: stamped
        ? { name: stamped.name, role: stamped.role, signatureUrl: stamped.signatureFileId ? signingFileUrl(stamped.signatureFileId) : null, sealUrl: stamped.sealFileId ? signingFileUrl(stamped.sealFileId) : null }
        : { name: signatory, role: '', signatureUrl: null, sealUrl: null },
      acceptance: {
        signatureUrl: q.clientSignatureFileId ? signingFileUrl(q.clientSignatureFileId) : null,
        sealUrl: q.clientSealFileId ? signingFileUrl(q.clientSealFileId) : null,
        signedCopyUrl: q.signedCopyFileId ? `/api/${staff ? 'quotes' : 'client/quotes'}/${q.id}/signed-copy` : null,
      },
      changeRequest: q.changeRequest,
      paymentNotes: notes,
      engagementIds: q.engagementIds,
      services: q.engagementIds.map((id) => engagements.find((e) => e.id === id)?.service.name).filter((x): x is string => !!x),
      templateId: q.templateId,
      content,
      amounts: t.amounts,
      subtotalPaise: q.subtotalPaise,
      gstRatePct: q.gstRatePct,
      gstPaise: q.gstPaise,
      totalPaise: q.totalPaise,
      amountInWords: serviceAmountInWords(q.totalPaise).replace(/^Rupees/, 'Indian Rupees'),
      payment: {
        accountName: gst.bankAccountName?.trim() || null,
        accountNumber: gst.bankAccount?.trim() || null,
        ifsc: gst.bankIfsc?.trim() || null,
        swift: gst.bankSwift?.trim() || null,
        bank: [gst.bankName?.trim(), gst.bankBranch?.trim()].filter(Boolean).join(', ') || null,
        upiId,
        upiUri: upiId ? `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(payee)}&am=${(q.totalPaise / 100).toFixed(2)}&cu=INR&tn=${encodeURIComponent(`Quotation ${q.number}`)}` : null,
      },
      acceptedAt: q.acceptedAt?.toISOString() ?? null,
      acceptedName: q.acceptedName,
      declinedAt: q.declinedAt?.toISOString() ?? null,
      declineReason: q.declineReason,
      advanceInvoice: advance ?? null,
      balanceInvoice: balance ?? null,
      createdBy: creator?.name ?? null,
      can: {
        edit: manage && q.status === 'draft',
        send: manage && (q.status === 'draft' || status === 'sent'),
        cancel: manage && ['draft', 'sent'].includes(q.status),
        raiseAdvance: manage && q.status === 'accepted' && !q.advanceInvoiceId && content.advancePct > 0,
        raiseBalance: manage && q.status === 'accepted' && !q.balanceInvoiceId && content.advancePct < 100 && (!!q.advanceInvoiceId || content.advancePct === 0),
        confirmPayment: manage && openInvoice && reported > recorded,
        decide: me.type === 'client' && me.clientOrg?.role === 'client_owner' && status === 'sent',
        notifyPaid: me.type === 'client' && ['client_owner', 'client_finance'].includes(me.clientOrg?.role ?? '') && q.status === 'accepted',
      },
    };
  }

  private row(q: QuoteDb & { client?: { id: string; name: string } }, names: Map<string, string>): QuoteRow {
    const content = q.content as unknown as QuoteContent;
    return {
      id: q.id,
      number: q.number,
      title: content.title,
      client: q.client ?? { id: q.clientOrgId, name: '' },
      status: this.status(q),
      totalPaise: q.totalPaise,
      date: (q.sentAt ?? q.createdAt).toISOString(),
      validUntil: q.validUntil.toISOString().slice(0, 10),
      createdBy: q.createdById ? (names.get(q.createdById) ?? null) : null,
    };
  }

  private async rows(where: Prisma.QuotationWhereInput) {
    const list = await this.prisma.quotation.findMany({ where, orderBy: { createdAt: 'desc' }, take: 300 });
    const [clients, users] = await Promise.all([
      this.prisma.clientOrg.findMany({ where: { id: { in: [...new Set(list.map((q) => q.clientOrgId))] } }, select: { id: true, name: true } }),
      this.prisma.user.findMany({ where: { id: { in: [...new Set(list.map((q) => q.createdById).filter((x): x is string => !!x))] } }, select: { id: true, name: true } }),
    ]);
    const names = new Map(users.map((u) => [u.id, u.name]));
    return list.map((q) => this.row({ ...q, client: clients.find((c) => c.id === q.clientOrgId) }, names));
  }

  // ------------------------------------------------------------------------------------------------ team

  async list(me: Me, q: { clientOrgId?: string; status?: string }) {
    this.assertStaff(me);
    const where: Prisma.QuotationWhereInput = { orgId: me.orgId, ...(q.clientOrgId ? { clientOrgId: q.clientOrgId } : {}) };
    if (!has(me, ...LEAD, 'finance')) {
      if (!has(me, 'account_manager')) throw new ForbiddenException('Client Managers, leadership and Finance see quotations');
      where.clientOrgId = { in: (await this.prisma.clientOrg.findMany({ where: { orgId: me.orgId, amUserId: me.id }, select: { id: true } })).map((c) => c.id).filter((id) => !q.clientOrgId || id === q.clientOrgId) };
    }
    const rows = await this.rows(where);
    return q.status ? rows.filter((r) => r.status === q.status) : rows;
  }

  async get(me: Me, id: string) {
    this.assertStaff(me);
    const q = await this.load(me, id);
    await this.assertManage(me, q.clientOrgId);
    return this.view(me, q);
  }

  /** Next number: BMU/Q/<year>/<NNNN>, from 1001 each year (serialised so two quotes never share one). */
  private async nextNumber(tx: Prisma.TransactionClient, orgId: string) {
    const year = ymdIst().slice(0, 4);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`quote-number:${orgId}`}))`;
    const existing = await tx.quotation.findMany({ where: { orgId, number: { startsWith: `BMU/Q/${year}/` } }, select: { number: true } });
    const seq = existing.reduce((m, x) => Math.max(m, Number(x.number.split('/').at(-1)) || 0), 1000) + 1;
    return `BMU/Q/${year}/${seq}`;
  }

  private async prepared(me: Me, body: unknown) {
    const input = parse(quoteSaveSchema, body);
    await this.assertManage(me, input.clientOrgId);
    const client = await this.prisma.clientOrg.findFirst({ where: { id: input.clientOrgId, orgId: me.orgId, deletedAt: null } });
    if (!client) throw new BadRequestException('Pick the client');
    const serviceIds = [...new Set(input.engagementIds ?? [])];
    if (serviceIds.length && (await this.prisma.engagement.count({ where: { id: { in: serviceIds }, clientOrgId: client.id, deletedAt: null } })) !== serviceIds.length) throw new BadRequestException('Pick services this client signed up for');
    if (input.validUntil < ymdIst()) throw new BadRequestException('The valid-until date is in the past');
    const gst = await this.settings.get(me.orgId, 'gst');
    const { clientOrgId, engagementIds: _services, templateId, preparedFor, validUntil, ...rest } = input;
    // v46: the terms are fixed; whatever was sent, every quotation carries BMU's terms.
    const content = { ...(parse(quoteContentSchema, rest) as QuoteContent), terms: QUOTE_FIXED_TERMS };
    const t = quoteTotals(content.lines, gst.ratePct ?? 18);
    if (t.subtotalPaise <= 0) throw new BadRequestException('The total is zero; add the rates');
    return {
      clientOrgId,
      engagementId: serviceIds[0] ?? null,
      engagementIds: serviceIds,
      templateId: templateId || null,
      preparedFor: (preparedFor ?? []).filter(Boolean),
      validUntil: new Date(`${validUntil}T00:00:00Z`),
      content: content as unknown as Prisma.InputJsonValue,
      subtotalPaise: t.subtotalPaise,
      gstPaise: t.gstPaise,
      totalPaise: t.totalPaise,
      gstRatePct: gst.ratePct ?? 18,
    };
  }

  async create(me: Me, body: unknown, ip?: string) {
    this.assertStaff(me);
    const data = await this.prepared(me, body);
    const q = await this.prisma.$transaction(async (tx) => tx.quotation.create({ data: { ...data, orgId: me.orgId, number: await this.nextNumber(tx, me.orgId), createdById: me.id } }));
    await this.audit.log(me, 'quote.created', 'Quotation', q.id, null, { number: q.number, clientOrgId: q.clientOrgId, totalPaise: q.totalPaise }, ip);
    return this.view(me, q);
  }

  async update(me: Me, id: string, body: unknown, ip?: string) {
    this.assertStaff(me);
    const before = await this.load(me, id);
    await this.assertManage(me, before.clientOrgId);
    if (before.status !== 'draft') throw new BadRequestException('Only drafts can be changed. Cancel it and make a new quotation.');
    const data = await this.prepared(me, body);
    if (data.clientOrgId !== before.clientOrgId) throw new BadRequestException('A quotation stays with its client');
    const q = await this.prisma.quotation.update({ where: { id }, data });
    await this.audit.log(me, 'quote.updated', 'Quotation', id, { totalPaise: before.totalPaise }, { totalPaise: q.totalPaise }, ip);
    return this.view(me, q);
  }

  private async clientUsers(clientOrgId: string) {
    return (await this.prisma.clientUser.findMany({ where: { clientOrgId, clientRole: { in: ['client_owner', 'client_finance'] } }, select: { userId: true } })).map((c) => c.userId);
  }

  /** Sends (or sends again) the quotation: the client's Owner and Finance users see it in their portal. */
  async send(me: Me, id: string, ip?: string) {
    this.assertStaff(me);
    const before = await this.load(me, id);
    await this.assertManage(me, before.clientOrgId);
    if (!['draft', 'sent'].includes(before.status)) throw new BadRequestException(`This quotation is ${before.status}`);
    if (this.status(before) === 'expired') throw new BadRequestException('It has expired. Make a new quotation with a new valid-until date.');
    // v46: the wording it goes out with is kept on the quotation.
    const fixedContent = before.status === 'draft' ? { ...(before.content as unknown as QuoteContent), terms: QUOTE_FIXED_TERMS, clientDetails: await this.clientDetails(before.clientOrgId), signedBy: await this.signerFor(me) } : (before.content as unknown as QuoteContent);
    const q = await this.prisma.quotation.update({ where: { id }, data: { status: 'sent', sentAt: before.sentAt ?? new Date(), sentById: me.id, changeRequest: null, content: fixedContent as unknown as Prisma.InputJsonValue } });
    const content = q.content as unknown as QuoteContent;
    const total = `₹${Math.round(q.totalPaise / 100).toLocaleString('en-IN')}`;
    await this.notifications.notify(q.orgId, await this.clientUsers(q.clientOrgId), {
      kind: 'quote_ready',
      title: `Quotation ${q.number}: ${content.title}`,
      body: `${total} incl. GST, valid until ${q.validUntil.toISOString().slice(0, 10)}. Open it to accept or decline.`,
      link: `/client/quotes/${q.id}`,
      critical: true,
    });
    await this.audit.log(me, before.status === 'sent' ? 'quote.resent' : 'quote.sent', 'Quotation', id, { status: before.status }, { status: 'sent' }, ip);
    return { ...(await this.view(me, q)), message: before.status === 'sent' ? 'Sent again to the client.' : 'Sent. The client can accept it in their app.' };
  }

  async cancel(me: Me, id: string, ip?: string) {
    this.assertStaff(me);
    const before = await this.load(me, id);
    await this.assertManage(me, before.clientOrgId);
    if (!['draft', 'sent'].includes(before.status)) throw new BadRequestException(`This quotation is ${before.status}`);
    const q = await this.prisma.quotation.update({ where: { id }, data: { status: 'cancelled' } });
    await this.audit.log(me, 'quote.cancelled', 'Quotation', id, { status: before.status }, { status: 'cancelled' }, ip);
    return this.view(me, q);
  }

  /** Creates and sends an invoice for part of the quotation (advance on accept; balance by the CM). */
  private async invoiceFor(q: QuoteDb, part: 'advance' | 'balance') {
    const content = q.content as unknown as QuoteContent;
    const gst = await this.settings.get(q.orgId, 'gst');
    const advance = Math.round((q.subtotalPaise * content.advancePct) / 100);
    const amount = part === 'advance' ? advance : q.subtotalPaise - advance;
    if (amount <= 0) return null;
    const label =
      part === 'advance'
        ? `${content.advancePct === 100 ? 'Full payment' : `Advance ${content.advancePct}%`}: ${content.title} (Quotation ${q.number})`
        : `Balance ${100 - content.advancePct}%: ${content.title} (Quotation ${q.number})`;
    const inv = await this.prisma.$transaction((tx) =>
      issueInvoiceTx(tx, { orgId: q.orgId, clientOrgId: q.clientOrgId, engagementId: q.engagementId ?? undefined, kind: part === 'advance' ? 'quote_advance' : 'quote_balance', lines: [{ label, title: label, details: content.lines.map((l) => l.title).join(', ').slice(0, 300), amountPaise: amount } as never], dueInDays: 7 }, { ratePct: q.gstRatePct, invoicePrefix: gst.invoicePrefix }),
    );
    await this.billing.invoiceIssued(inv.id);
    return inv;
  }

  /** v49: records what the client reported paying (and has not been recorded yet) on an invoice of this quotation. */
  private async applyReported(q: QuoteDb, invoiceId: string) {
    const notes = notesOf(q);
    if (!notes.length) return 0;
    const ids = [q.advanceInvoiceId, q.balanceInvoiceId, invoiceId].filter((x): x is string => !!x);
    const recorded = (await this.prisma.payment.aggregate({ where: { invoiceId: { in: ids } }, _sum: { amountPaise: true } }))._sum.amountPaise ?? 0;
    const inv = await this.prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { payments: true } });
    const due = inv.totalPaise - inv.payments.reduce((s, p) => s + p.amountPaise, 0);
    const amount = Math.min(notes.reduce((s, n) => s + n.amountPaise, 0) - recorded, due);
    if (amount <= 0) return 0;
    await this.payments.recordPayment(invoiceId, amount, 'bank', `${notes.map((n) => n.reference).join(', ').slice(0, 150)} (${inv.number}, ${inv.payments.length + 1})`);
    return amount;
  }

  /** v49: the CM or a Founder sends the invoice once the client has accepted (and usually paid). */
  private async raise(me: Me, id: string, part: 'advance' | 'balance', ip?: string) {
    this.assertStaff(me);
    const q = await this.load(me, id);
    await this.assertManage(me, q.clientOrgId);
    if (q.status !== 'accepted') throw new BadRequestException('The client has not accepted this quotation yet');
    if (part === 'advance' && q.advanceInvoiceId) throw new BadRequestException('The advance invoice was already raised');
    if (part === 'balance' && q.balanceInvoiceId) throw new BadRequestException('The balance invoice was already raised');
    if (part === 'balance' && !q.advanceInvoiceId && (q.content as unknown as QuoteContent).advancePct > 0) throw new BadRequestException('Send the advance invoice first');
    const inv = await this.invoiceFor(q, part);
    if (!inv) throw new BadRequestException('Nothing is left to invoice');
    const updated = await this.prisma.quotation.update({ where: { id }, data: part === 'advance' ? { advanceInvoiceId: inv.id } : { balanceInvoiceId: inv.id } });
    const paid = await this.applyReported(updated, inv.id);
    await this.audit.log(me, `quote.${part}_invoiced`, 'Quotation', id, null, { invoiceId: inv.id, number: inv.number, totalPaise: inv.totalPaise, paidPaise: paid }, ip);
    return { ...(await this.view(me, updated)), message: `${part === 'advance' ? 'Advance' : 'Balance'} invoice ${inv.number} raised and sent.${paid ? ' The payment the client reported is recorded on it.' : ''}` };
  }

  raiseAdvance(me: Me, id: string, ip?: string) {
    return this.raise(me, id, 'advance', ip);
  }

  raiseBalance(me: Me, id: string, ip?: string) {
    return this.raise(me, id, 'balance', ip);
  }

  /** v49: the client reported a payment after the invoice went out: the team confirms it arrived. */
  async confirmPayment(me: Me, id: string, ip?: string) {
    this.assertStaff(me);
    const q = await this.load(me, id);
    await this.assertManage(me, q.clientOrgId);
    let paid = 0;
    for (const invoiceId of [q.advanceInvoiceId, q.balanceInvoiceId].filter((x): x is string => !!x)) paid += await this.applyReported(q, invoiceId);
    if (!paid) throw new BadRequestException('There is no reported payment left to record');
    await this.audit.log(me, 'quote.payment_confirmed', 'Quotation', id, null, { paidPaise: paid }, ip);
    return { ...(await this.view(me, q)), message: 'Payment recorded on the invoice.' };
  }

  // ------------------------------------------------------------------------------------------------ templates

  async templates(me: Me): Promise<QuoteTemplateRow[]> {
    this.assertStaff(me);
    let rows = await this.prisma.quoteTemplate.findMany({ where: { orgId: me.orgId }, orderBy: { name: 'asc' } });
    // The first time, BMU's influencer-campaign quotation is added as a starting template.
    if (!rows.length) {
      const { name, serviceKey, ...content } = parse(quoteTemplateSchema, DEFAULT_QUOTE_TEMPLATE);
      await this.prisma.quoteTemplate.create({ data: { orgId: me.orgId, name, serviceKey: serviceKey ?? null, content: content as unknown as Prisma.InputJsonValue } });
      rows = await this.prisma.quoteTemplate.findMany({ where: { orgId: me.orgId }, orderBy: { name: 'asc' } });
    }
    return rows.map((t) => ({ ...(t.content as unknown as QuoteContent), id: t.id, name: t.name, serviceKey: t.serviceKey, updatedAt: t.updatedAt.toISOString() }));
  }

  async saveTemplate(me: Me, body: unknown, id?: string, ip?: string) {
    if (!this.canTemplates(me)) throw new ForbiddenException('Founders, Branch Managers and the CM Lead manage quotation templates');
    const { name, serviceKey, ...content } = parse(quoteTemplateSchema, body);
    const data = { name, serviceKey: serviceKey || null, content: content as unknown as Prisma.InputJsonValue };
    const t = id
      ? await this.prisma.quoteTemplate.update({ where: { id: (await this.prisma.quoteTemplate.findFirstOrThrow({ where: { id, orgId: me.orgId } })).id }, data })
      : await this.prisma.quoteTemplate.create({ data: { ...data, orgId: me.orgId, createdById: me.id } });
    await this.audit.log(me, id ? 'quote_template.updated' : 'quote_template.created', 'QuoteTemplate', t.id, null, { name }, ip);
    return { ...(t.content as unknown as QuoteContent), id: t.id, name: t.name, serviceKey: t.serviceKey, updatedAt: t.updatedAt.toISOString() };
  }

  async deleteTemplate(me: Me, id: string, ip?: string) {
    if (!this.canTemplates(me)) throw new ForbiddenException('Founders, Branch Managers and the CM Lead manage quotation templates');
    const t = await this.prisma.quoteTemplate.findFirst({ where: { id, orgId: me.orgId } });
    if (!t) throw new NotFoundException('Template not found');
    await this.prisma.quoteTemplate.delete({ where: { id } });
    await this.audit.log(me, 'quote_template.deleted', 'QuoteTemplate', id, { name: t.name }, null, ip);
    return { ok: true as const };
  }

  // ------------------------------------------------------------------------------------------------ client

  private clientOrg(me: Me) {
    if (me.type !== 'client' || !me.clientOrg) throw new ForbiddenException('Client accounts only');
    return me.clientOrg.id;
  }

  async mine(me: Me) {
    const clientOrgId = this.clientOrg(me);
    return this.rows({ orgId: me.orgId, clientOrgId, status: { in: ['sent', 'accepted', 'declined'] } });
  }

  async mineOne(me: Me, id: string) {
    const clientOrgId = this.clientOrg(me);
    const q = await this.prisma.quotation.findFirst({ where: { id, orgId: me.orgId, clientOrgId, status: { in: ['sent', 'accepted', 'declined'] } } });
    if (!q) throw new NotFoundException('Quotation not found');
    return this.view(me, q);
  }

  /** The client's Owner accepts (name plus signature or signed copy), asks for changes, or declines (with a reason). */
  async decide(me: Me, id: string, body: unknown, ip?: string) {
    const clientOrgId = this.clientOrg(me);
    if (me.clientOrg?.role !== 'client_owner') throw new ForbiddenException('Only the account Owner can accept or decline a quotation');
    const input = parse(quoteDecisionSchema, body);
    const q = await this.prisma.quotation.findFirst({ where: { id, orgId: me.orgId, clientOrgId } });
    if (!q) throw new NotFoundException('Quotation not found');
    const status = this.status(q);
    if (status === 'expired') throw new BadRequestException('This quotation has expired. Ask your Client Manager for a new one.');
    if (status !== 'sent') throw new BadRequestException(`This quotation is already ${status}`);
    const content = q.content as unknown as QuoteContent;
    const c = await this.prisma.clientOrg.findUniqueOrThrow({ where: { id: clientOrgId }, select: { name: true, amUserId: true } });
    const team = [...new Set([c.amUserId, q.createdById, q.sentById].filter((x): x is string => !!x))];
    if (input.decision === 'changes') {
      // Back to the manager as a draft: they edit it and send it again (who signs and the client details are stamped afresh).
      const { clientDetails: _c, signedBy: _s, ...rest } = q.content as unknown as QuoteContent & Stamped;
      const updated = await this.prisma.quotation.update({ where: { id }, data: { status: 'draft', changeRequest: input.reason, content: rest as unknown as Prisma.InputJsonValue } });
      await this.audit.log(me, 'quote.changes_requested', 'Quotation', id, { status: 'sent' }, { status: 'draft', reason: input.reason }, ip);
      await this.notifications.notify(q.orgId, await this.withFounders(q.orgId, team), { kind: 'quote_changes', title: `${c.name} asked for changes to ${q.number}`, body: input.reason, link: `/team/quotes/${id}`, critical: true });
      return { ...(await this.view(me, updated)), message: 'Sent to your Client Manager. You will get the updated quotation here.' };
    }
    if (input.decision === 'decline') {
      const updated = await this.prisma.quotation.update({ where: { id }, data: { status: 'declined', declinedAt: new Date(), declineReason: input.reason || null } });
      await this.audit.log(me, 'quote.declined', 'Quotation', id, { status: 'sent' }, { status: 'declined', reason: input.reason ?? null }, ip);
      await this.notifications.notify(q.orgId, team, { kind: 'quote_declined', title: `${c.name} declined quotation ${q.number}`, body: input.reason || content.title, link: `/team/quotes/${id}` });
      return { ...(await this.view(me, updated)), message: 'Declined. Your Client Manager has been told.' };
    }
    // Accept: claim it first so a double click counts once. The invoices follow once the client has paid.
    const fileIds = [input.signatureFileId, input.sealFileId, input.signedCopyFileId].filter((x): x is string => !!x);
    const files = await this.prisma.file.count({ where: { id: { in: fileIds }, orgId: me.orgId, clientOrgId } });
    if (files !== fileIds.length) throw new BadRequestException('Upload your signature again');
    const claimed = await this.prisma.quotation.updateMany({
      where: { id, status: 'sent' },
      data: { status: 'accepted', acceptedAt: new Date(), acceptedById: me.id, acceptedName: input.name, clientSignatureFileId: input.signatureFileId ?? null, clientSealFileId: input.sealFileId ?? null, signedCopyFileId: input.signedCopyFileId ?? null },
    });
    if (!claimed.count) throw new BadRequestException('This quotation was already answered');
    const updated = await this.prisma.quotation.findUniqueOrThrow({ where: { id } });
    await this.audit.log(me, 'quote.accepted', 'Quotation', id, { status: 'sent' }, { status: 'accepted', name: input.name, signed: !!input.signatureFileId, signedCopy: !!input.signedCopyFileId }, ip);
    await this.notifications.notify(q.orgId, await this.withFounders(q.orgId, team), {
      kind: 'quote_accepted',
      title: `${c.name} accepted quotation ${q.number}`,
      body: `${content.title}. Accepted by ${input.name}. Send the invoice once they have paid.`,
      link: `/team/quotes/${id}`,
      critical: true,
    });
    return { ...(await this.view(me, updated)), message: 'Accepted. Please pay using the details on the quotation, then tell us below.' };
  }

  private async withFounders(orgId: string, ids: string[]) {
    const founders = await this.prisma.user.findMany({ where: { orgId, type: 'staff', status: 'active', deletedAt: null, roles: { some: { role: { baseRole: 'founder' } } } }, select: { id: true } });
    return [...new Set([...ids, ...founders.map((f) => f.id)])];
  }

  /** v49: the signature, seal or signed copy the Owner adds before accepting. */
  async acceptanceFile(me: Me, id: string, kind: string, file: OpsUpload | undefined, ip?: string) {
    const clientOrgId = this.clientOrg(me);
    if (me.clientOrg?.role !== 'client_owner') throw new ForbiddenException('Only the account Owner can accept a quotation');
    if (!QUOTE_ACCEPT_FILE_KINDS.includes(kind as QuoteAcceptFileKind)) throw new NotFoundException('Not found');
    const q = await this.prisma.quotation.findFirst({ where: { id, orgId: me.orgId, clientOrgId } });
    if (!q || this.status(q) !== 'sent') throw new BadRequestException('This quotation is not waiting for you');
    if (!file) throw new BadRequestException('Choose a file');
    const copy = kind === 'signed_copy';
    if (copy ? ![...INVOICE_IMAGE_TYPES, 'application/pdf'].includes(file.mimetype) : !INVOICE_IMAGE_TYPES.includes(file.mimetype)) throw new BadRequestException(copy ? 'Upload a PDF or an image' : 'Upload a PNG, JPG or WebP image');
    if (file.size > (copy ? QUOTE_SIGNED_COPY_MAX_BYTES : INVOICE_IMAGE_MAX_BYTES)) throw new BadRequestException(`The file must be ${copy ? '4' : '2'} MB or smaller`);
    const f = await this.prisma.file.create({
      data: { orgId: me.orgId, clientOrgId, path: relPath(file.path), kind: copy ? 'document' : 'image', name: file.originalname.slice(0, 200), mimeType: file.mimetype, sizeBytes: file.size, checksum: await sha256(file.path), folder: 'general', tags: [ACCEPT_TAGS[kind as QuoteAcceptFileKind]], uploadedById: me.id },
    });
    await this.audit.log(me, 'quote.acceptance_file', 'Quotation', id, null, { kind, fileId: f.id }, ip);
    return { fileId: f.id };
  }

  /** The signed quotation the client uploaded (the team, or the client's own account). */
  async signedCopy(me: Me, id: string, res: Response) {
    const q = me.type === 'client' ? await this.prisma.quotation.findFirst({ where: { id, orgId: me.orgId, clientOrgId: this.clientOrg(me) } }) : await this.load(me, id);
    if (!q) throw new NotFoundException('Quotation not found');
    if (me.type !== 'client') await this.assertManage(me, q.clientOrgId);
    const f = q.signedCopyFileId ? await this.prisma.file.findFirst({ where: { id: q.signedCopyFileId, orgId: me.orgId } }) : null;
    if (!f) throw new NotFoundException('No signed copy');
    return sendStoredFile(res, f, { disposition: 'attachment', cache: 'private, max-age=3600' });
  }

  /** v49: the client tells the team they have paid. The CM and Founders are told, and send the invoice. */
  async notifyPaid(me: Me, id: string, body: unknown, ip?: string) {
    const clientOrgId = this.clientOrg(me);
    if (!['client_owner', 'client_finance'].includes(me.clientOrg?.role ?? '')) throw new ForbiddenException('Only the account Owner or Finance can do this');
    const input = parse(quotePaidSchema, body);
    const q = await this.prisma.quotation.findFirst({ where: { id, orgId: me.orgId, clientOrgId } });
    if (!q) throw new NotFoundException('Quotation not found');
    if (q.status !== 'accepted') throw new BadRequestException('Accept the quotation first');
    const notes = [...notesOf(q), { amountPaise: input.amountPaise, reference: input.reference, at: new Date().toISOString(), by: me.name }];
    const updated = await this.prisma.quotation.update({ where: { id }, data: { paymentNotes: notes as unknown as Prisma.InputJsonValue } });
    await this.audit.log(me, 'quote.payment_reported', 'Quotation', id, null, { amountPaise: input.amountPaise, reference: input.reference }, ip);
    const c = await this.prisma.clientOrg.findUniqueOrThrow({ where: { id: clientOrgId }, select: { name: true, amUserId: true } });
    const team = [c.amUserId, q.createdById, q.sentById].filter((x): x is string => !!x);
    await this.notifications.notify(q.orgId, await this.withFounders(q.orgId, team), { kind: 'quote_paid', title: `${c.name} says they paid ₹${Math.round(input.amountPaise / 100).toLocaleString('en-IN')}`, body: `Quotation ${q.number}, reference ${input.reference}. Check it arrived, then send the invoice.`, link: `/team/quotes/${id}`, critical: true });
    return { ...(await this.view(me, updated)), message: 'Thank you. Your Client Manager has been told and will send your invoice.' };
  }
}
