import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  financialYear,
  formatINR,
  priceProposal,
  sellFirstPaymentNote,
  sellPaymentPlan,
  type CreateProposal,
  type Me,
  type ProposalLine,
  type ProposalView,
  type SellApprovalLevel,
  type SellReviseInput,
} from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { CatalogueService } from '../catalogue/catalogue.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { OnboardingService } from './onboarding.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { PaymentsService } from './payments.service.js';
import { DiscountApprovalsService } from './discounts.service.js';
import { logLeadActivity } from './lead-activity.js';

const include = {
  lead: { include: { owner: { select: { id: true, name: true } } } },
  invoices: { include: { payments: true } },
  agreement: true,
  changeRequests: { orderBy: { createdAt: 'desc' } },
} as const;
type ProposalFull = Prisma.ProposalGetPayload<{ include: typeof include }>;

const DAY = 86_400_000;
const OPEN = ['draft', 'sent', 'expired'];
const clientName = (c: unknown) => {
  const x = (c ?? {}) as { company?: string; name?: string };
  return x.company || x.name || 'Client';
};

export function toView(p: ProposalFull): ProposalView {
  const lines = p.lines as unknown as ProposalLine[];
  const plan = sellPaymentPlan(lines);
  const invoice = p.invoices.find((i) => i.kind === 'first_payment') ?? null;
  const signer = (p.agreement?.signer ?? null) as ProposalView['signer'];
  return {
    id: p.id,
    status: p.status,
    publicToken: p.publicToken,
    version: p.version,
    client: p.lead.contact as ProposalView['client'],
    lines,
    subtotalPaise: p.subtotalPaise,
    bundleDiscountPaise: p.bundleDiscountPaise,
    extraDiscountPct: p.extraDiscountPct,
    discountPaise: p.discountPaise,
    gstPaise: p.gstPaise,
    totalPaise: p.totalPaise,
    firstPayment: { netPaise: plan.now.netPaise, gstPaise: plan.now.gstPaise, totalPaise: plan.now.totalPaise },
    validUntil: p.validUntil.toISOString(),
    discountNeedsApproval: p.discountNeedsApproval,
    discountApproved: !!p.discountApprovedById,
    sentAt: p.sentAt?.toISOString() ?? null,
    viewedAt: p.viewedAt?.toISOString() ?? null,
    acceptedAt: p.acceptedAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
    leadId: p.leadId,
    invoice: invoice ? { id: invoice.id, number: invoice.number, status: invoice.status, totalPaise: invoice.totalPaise } : null,
    paid: invoice?.status === 'paid',
    kind: p.kind === 'renewal' ? 'renewal' : 'new',
    rootId: p.rootId,
    supersededById: p.supersededById,
    changeNote: p.changeNote,
    viewCount: p.viewCount,
    lastViewedAt: p.lastViewedAt?.toISOString() ?? null,
    discountStatus: p.discountStatus as ProposalView['discountStatus'],
    paymentPlan: plan,
    signer: signer ?? null,
    changeRequests: p.changeRequests.map((c) => ({ id: c.id, comment: c.comment, byName: c.byName, byEmail: c.byEmail, at: c.createdAt.toISOString(), resolvedAt: c.resolvedAt?.toISOString() ?? null, revisionId: c.revisionId, version: p.version })),
    owner: p.lead.owner,
  };
}

/** What the client may see on the public link: no internal approval or team details. */
function publicView(p: ProposalFull, latestToken: string | null): ProposalView {
  const v = toView(p);
  delete v.owner;
  delete v.approvalSteps;
  delete v.versions;
  const signer = v.signer ? { name: v.signer.name, email: v.signer.email, designation: v.signer.designation, at: v.signer.at } : null;
  return { ...v, signer, latestToken, changeRequests: v.changeRequests?.map((c) => ({ ...c, byEmail: null })) };
}

type CreateExtra = { version?: number; rootId?: string | null; changeNote?: string; kind?: 'new' | 'renewal'; renewalClientOrgId?: string; renewalEngagementIds?: string[] };

@Injectable()
export class ProposalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalogue: CatalogueService,
    private readonly audit: AuditService,
    private readonly payments: PaymentsService,
    private readonly onboarding: OnboardingService,
    private readonly settings: SettingsService,
    private readonly discounts: DiscountApprovalsService,
    private readonly notifications: NotificationsService,
  ) {}

  leadScope(me: Me): Prisma.LeadWhereInput {
    const scope = me.permissions.leads_pipeline?.scope ?? 'none';
    if (scope === 'none') throw new ForbiddenException("You don't have access to proposals");
    return { orgId: me.orgId, deletedAt: null, ...(scope === 'own' ? { ownerId: me.id } : {}) };
  }

  /** Sent proposals past their valid-until date become "expired" (also swept every minute by the sell scheduler). */
  async expireDue(orgId?: string) {
    const due = await this.prisma.proposal.findMany({
      where: { ...(orgId ? { orgId } : {}), status: 'sent', validUntil: { lt: new Date() }, deletedAt: null },
      include: { lead: true },
      take: 200,
    });
    for (const p of due) {
      const res = await this.prisma.proposal.updateMany({ where: { id: p.id, status: 'sent' }, data: { status: 'expired' } });
      if (!res.count) continue;
      await this.audit.logSystem(p.orgId, 'proposal.expired', 'Proposal', p.id, { validUntil: p.validUntil.toISOString() });
      await logLeadActivity(this.prisma, { orgId: p.orgId, leadId: p.leadId, kind: 'system', body: `Proposal v${p.version} expired without a decision` });
      await this.notifications.notify(p.orgId, [p.lead.ownerId ?? p.createdById], {
        kind: 'proposal_expired',
        title: `Proposal for ${clientName(p.lead.contact)} expired`,
        body: 'Extend it or send a new version.',
        link: `/team/proposals/${p.id}`,
      });
    }
    return due.length;
  }

  async list(me: Me): Promise<ProposalView[]> {
    await this.expireDue(me.orgId);
    const rows = await this.prisma.proposal.findMany({
      where: { deletedAt: null, status: { not: 'superseded' }, lead: this.leadScope(me) },
      include,
      orderBy: { createdAt: 'desc' },
    });
    const steps = await this.discounts.steps(rows.filter((r) => r.discountNeedsApproval).map((r) => r.id));
    return rows.map((r) => ({ ...toView(r), approvalSteps: steps.get(r.id) ?? [] }));
  }

  private async chain(p: { id: string; rootId: string | null }) {
    const root = p.rootId ?? p.id;
    return this.prisma.proposal.findMany({ where: { OR: [{ id: root }, { rootId: root }], deletedAt: null }, orderBy: { version: 'asc' } });
  }

  async get(me: Me, id: string): Promise<ProposalView> {
    await this.expireDue(me.orgId);
    const p = await this.prisma.proposal.findFirst({ where: { id, deletedAt: null, lead: this.leadScope(me) }, include });
    if (!p) throw new NotFoundException('Proposal not found');
    const [versions, steps] = await Promise.all([this.chain(p), this.discounts.steps([p.id])]);
    const crs = versions.length > 1 ? await this.prisma.proposalChangeRequest.findMany({ where: { proposalId: { in: versions.map((v) => v.id) } }, orderBy: { createdAt: 'desc' } }) : null;
    const versionOf = new Map(versions.map((v) => [v.id, v.version]));
    const view = toView(p);
    return {
      ...view,
      versions: versions.map((v) => ({ id: v.id, version: v.version, status: v.status, totalPaise: v.totalPaise, createdAt: v.createdAt.toISOString(), sentAt: v.sentAt?.toISOString() ?? null, changeNote: v.changeNote })),
      approvalSteps: steps.get(p.id) ?? [],
      changeRequests: crs
        ? crs.map((c) => ({ id: c.id, comment: c.comment, byName: c.byName, byEmail: c.byEmail, at: c.createdAt.toISOString(), resolvedAt: c.resolvedAt?.toISOString() ?? null, revisionId: c.revisionId, version: versionOf.get(c.proposalId) ?? 0 }))
        : view.changeRequests,
    };
  }

  async create(me: Me, input: CreateProposal, ip?: string): Promise<ProposalView> {
    const lead = await this.prisma.lead.findFirst({ where: { ...this.leadScope(me), id: input.leadId } });
    if (!lead) throw new NotFoundException('Lead not found');
    if (lead.stage === 'won' || lead.stage === 'lost') throw new BadRequestException(`This lead is already ${lead.stage}`);
    const previous = await this.prisma.proposal.count({ where: { leadId: lead.id } });
    return this.createFor(me, lead, input, { version: previous + 1 }, ip);
  }

  /** Prices and saves a draft proposal (new, revision or renewal) and starts any discount approval. */
  async createFor(me: Me, lead: { id: string; contact: unknown }, input: Omit<CreateProposal, 'leadId'>, extra: CreateExtra, ip?: string): Promise<ProposalView> {
    const book = await this.catalogue.pricing(me.orgId);
    let pricing;
    try {
      pricing = priceProposal({ ...book, serviceLines: input.lines, addOnLines: input.addOns, extraDiscountPct: input.extraDiscountPct });
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const chain: SellApprovalLevel[] = await this.discounts.chainFor(me, input.extraDiscountPct);
    const proposal = await this.prisma.proposal.create({
      data: {
        orgId: me.orgId,
        leadId: lead.id,
        priceBookId: book.priceBookId,
        lines: pricing.lines as unknown as Prisma.InputJsonValue,
        subtotalPaise: pricing.subtotalPaise,
        bundleDiscountPaise: pricing.bundleDiscountPaise,
        extraDiscountPct: input.extraDiscountPct,
        discountPaise: pricing.discountPaise,
        gstPaise: pricing.gstPaise,
        totalPaise: pricing.totalPaise,
        validUntil: new Date(Date.now() + input.validDays * DAY),
        version: extra.version ?? 1,
        rootId: extra.rootId ?? null,
        changeNote: extra.changeNote ?? null,
        kind: extra.kind ?? 'new',
        renewalClientOrgId: extra.renewalClientOrgId ?? null,
        renewalEngagementIds: extra.renewalEngagementIds ?? [],
        discountNeedsApproval: chain.length > 0,
        discountStatus: chain.length ? 'pending' : 'none',
        createdById: me.id,
      },
      include,
    });
    await this.discounts.start(me.orgId, proposal.id, chain, me.id, { client: clientName(lead.contact), pct: input.extraDiscountPct, version: proposal.version });
    await this.audit.log(me, extra.rootId ? 'proposal.revised' : 'proposal.created', 'Proposal', proposal.id, undefined, { totalPaise: proposal.totalPaise, extraDiscountPct: input.extraDiscountPct, version: proposal.version, approvals: chain }, ip);
    await logLeadActivity(this.prisma, {
      orgId: me.orgId,
      leadId: lead.id,
      kind: 'system',
      userId: me.id,
      body: `${me.name} drafted proposal v${proposal.version}${extra.changeNote ? `: ${extra.changeNote}` : ''}${chain.length ? ` (${input.extraDiscountPct}% discount sent for approval)` : ''}`,
    });
    return this.get(me, proposal.id);
  }

  /** A new version of a proposal (after the client asked for changes, or to change the offer). */
  async revise(me: Me, id: string, input: SellReviseInput, ip?: string) {
    const p = await this.prisma.proposal.findFirst({ where: { id, deletedAt: null, lead: this.leadScope(me) }, include: { lead: true } });
    if (!p) throw new NotFoundException('Proposal not found');
    if (p.lead.stage === 'won') throw new BadRequestException('This client has already signed up');
    if (p.lead.stage === 'lost') throw new BadRequestException('This lead is marked lost. Move it back to an open stage first.');
    const versions = await this.chain(p);
    if (versions.some((v) => v.status === 'accepted')) throw new BadRequestException('A version of this proposal is already accepted');
    const maxVersion = Math.max(...versions.map((v) => v.version));
    return this.createFor(
      me,
      p.lead,
      input,
      { version: maxVersion + 1, rootId: p.rootId ?? p.id, changeNote: input.changeNote, kind: p.kind === 'renewal' ? 'renewal' : 'new', renewalClientOrgId: p.renewalClientOrgId ?? undefined, renewalEngagementIds: p.renewalEngagementIds },
      ip,
    );
  }

  async extend(me: Me, id: string, days: number, ip?: string) {
    const p = await this.get(me, id);
    if (!['draft', 'sent', 'expired'].includes(p.status)) throw new BadRequestException(`A ${p.status} proposal can't be extended`);
    const base = Math.max(Date.now(), new Date(p.validUntil).getTime());
    const validUntil = new Date(base + days * DAY);
    await this.prisma.proposal.update({ where: { id }, data: { validUntil, ...(p.status === 'expired' ? { status: 'sent' } : {}) } });
    await this.audit.log(me, 'proposal.extended', 'Proposal', id, { validUntil: p.validUntil, status: p.status }, { validUntil: validUntil.toISOString() }, ip);
    await logLeadActivity(this.prisma, { orgId: me.orgId, leadId: p.leadId, kind: 'system', userId: me.id, body: `${me.name} extended proposal v${p.version} by ${days} days` });
    return this.get(me, id);
  }

  async approveDiscount(me: Me, id: string, ip?: string) {
    await this.get(me, id);
    await this.discounts.approveCurrent(me, id, ip);
    return this.get(me, id);
  }

  async send(me: Me, id: string, ip?: string) {
    const p = await this.get(me, id);
    if (p.status !== 'draft') throw new BadRequestException('Only draft proposals can be sent');
    if (p.discountStatus === 'rejected') throw new BadRequestException('The discount was rejected. Make a new version with a smaller discount.');
    if (p.discountNeedsApproval && !p.discountApproved) {
      const open = p.approvalSteps?.find((s) => s.status === 'pending');
      throw new BadRequestException(open ? `The discount is waiting for ${open.level === 'founder' ? 'the Founder' : 'a sales manager'} to approve` : 'The discount needs approval before sending');
    }
    const lead = await this.prisma.lead.findUniqueOrThrow({ where: { id: p.leadId } });
    const now = new Date();
    const older = (p.versions ?? []).filter((v) => v.id !== id && OPEN.includes(v.status)).map((v) => v.id);
    const moveLead = lead.stage !== 'won' && lead.stage !== 'proposal_sent';
    await this.prisma.$transaction(async (tx) => {
      await tx.proposal.update({ where: { id }, data: { status: 'sent', sentAt: now } });
      if (older.length) {
        await tx.proposal.updateMany({ where: { id: { in: older } }, data: { status: 'superseded', supersededById: id, supersededAt: now } });
        await tx.proposalChangeRequest.updateMany({ where: { proposalId: { in: older }, resolvedAt: null }, data: { resolvedAt: now, revisionId: id } });
      }
      if (moveLead) await tx.lead.update({ where: { id: lead.id }, data: { stage: 'proposal_sent' } });
    });
    if (moveLead) await this.audit.log(me, 'lead.proposal_sent', 'Lead', lead.id, { stage: lead.stage }, { stage: 'proposal_sent' }, ip);
    await this.audit.log(me, 'proposal.sent', 'Proposal', id, undefined, { to: p.client.email ?? p.client.phone, version: p.version, superseded: older }, ip);
    await logLeadActivity(this.prisma, { orgId: me.orgId, leadId: p.leadId, kind: 'system', userId: me.id, body: `${me.name} sent proposal v${p.version} to the client${older.length ? ' (earlier versions are now superseded)' : ''}` });
    // Email/WhatsApp delivery to the client goes through the messaging hook; the link works right away.
    return this.get(me, id);
  }

  // ---- Public link (client side, no sign-in) ----

  private async byToken(token: string) {
    const p = await this.prisma.proposal.findFirst({ where: { publicToken: token, deletedAt: null }, include });
    if (!p || p.status === 'draft') throw new NotFoundException('This proposal link is not valid');
    if (p.status === 'sent' && p.validUntil < new Date()) {
      await this.expireDue(p.orgId);
      p.status = 'expired';
    }
    return p;
  }

  /** For a superseded link: the token of the newest version the client can open. */
  private async latestToken(p: ProposalFull) {
    if (p.status !== 'superseded') return null;
    const versions = await this.chain(p);
    const latest = versions.filter((v) => v.status !== 'draft' && v.status !== 'superseded').at(-1);
    return latest?.publicToken ?? null;
  }

  async viewPublic(token: string, preview = false) {
    const p = await this.byToken(token);
    if (!preview) {
      const now = new Date();
      await this.prisma.proposal.update({ where: { id: p.id }, data: { viewCount: { increment: 1 }, lastViewedAt: now, ...(p.viewedAt ? {} : { viewedAt: now }) } });
      if (!p.viewedAt) {
        p.viewedAt = now;
        await this.audit.logSystem(p.orgId, 'proposal.viewed', 'Proposal', p.id, { version: p.version });
        await logLeadActivity(this.prisma, { orgId: p.orgId, leadId: p.leadId, kind: 'system', body: `Client opened proposal v${p.version} for the first time` });
        await this.notifications.notify(p.orgId, await this.salesPeople(p), {
          kind: 'proposal_viewed',
          title: `${clientName(p.lead.contact)} opened your proposal`,
          body: `Proposal v${p.version}. A quick call now helps close it.`,
          link: `/team/proposals/${p.id}`,
        });
      }
      p.viewCount += 1;
      p.lastViewedAt = now;
    }
    const t = await this.settings.get(p.orgId, 'documentTemplates');
    return {
      proposal: publicView(p, await this.latestToken(p)),
      payments: { razorpay: this.payments.enabled, testMode: this.payments.testMode },
      documents: { intro: t.proposalIntro, terms: t.proposalTerms, agreement: t.agreementBody },
    };
  }

  private async salesPeople(p: { orgId: string; createdById: string | null; lead: { ownerId: string | null } }) {
    const ids = [p.lead.ownerId, p.createdById].filter((x): x is string => !!x);
    if (ids.length) return ids;
    const managers = await this.prisma.user.findMany({ where: { orgId: p.orgId, deletedAt: null, status: 'active', roles: { some: { role: { baseRole: 'sales_manager' } } } }, select: { id: true } });
    return managers.map((m) => m.id);
  }

  async requestChanges(token: string, input: { name: string; email?: string; comment: string }, ip?: string) {
    const p = await this.byToken(token);
    if (p.status === 'superseded') throw new BadRequestException('A newer version of this proposal has been sent. Please open the latest one.');
    if (p.status === 'accepted') throw new BadRequestException('This proposal is already accepted. Message your account manager for changes.');
    if (p.status !== 'sent' && p.status !== 'expired') throw new BadRequestException('Changes can no longer be requested on this proposal');
    const open = await this.prisma.proposalChangeRequest.count({ where: { proposalId: p.id, resolvedAt: null } });
    if (open >= 5) throw new BadRequestException('You have already sent several requests. We will get back to you shortly.');
    await this.prisma.proposalChangeRequest.create({ data: { orgId: p.orgId, proposalId: p.id, comment: input.comment, byName: input.name, byEmail: input.email ?? null, ip } });
    await this.audit.logSystem(p.orgId, 'proposal.changes_requested', 'Proposal', p.id, { by: input.name, comment: input.comment.slice(0, 200) }, ip);
    await logLeadActivity(this.prisma, { orgId: p.orgId, leadId: p.leadId, kind: 'system', outcome: 'changes_requested', body: `${input.name} asked for changes on proposal v${p.version}: “${input.comment}”` });
    await this.notifications.notify(p.orgId, await this.salesPeople(p), {
      kind: 'proposal_changes_requested',
      title: `${clientName(p.lead.contact)} asked for changes to the proposal`,
      body: input.comment.slice(0, 140),
      link: `/team/proposals/${p.id}`,
      critical: true,
    });
    return this.viewPublic(token, true);
  }

  async agreement(token: string) {
    const p = await this.byToken(token);
    const [t, tenant, gst] = await Promise.all([this.settings.get(p.orgId, 'documentTemplates'), this.settings.get(p.orgId, 'tenant'), this.settings.get(p.orgId, 'gst')]);
    // The signed copy records the signer's IP address (shown only on the agreement itself).
    return {
      proposal: { ...publicView(p, await this.latestToken(p)), signer: toView(p).signer },
      company: { name: gst.legalName || tenant.name, address: tenant.address || null, gstin: gst.gstin || null },
      agreementText: t.agreementBody,
      termsText: t.proposalTerms,
      signed: !!p.agreement?.signedAt,
    };
  }

  async accept(token: string, signer: { signerName: string; signerEmail: string; signerDesignation?: string }, ip?: string, userAgent?: string) {
    const p = await this.byToken(token);
    if (p.status === 'expired') throw new BadRequestException('This proposal has expired. Ask BMU for a fresh one.');
    if (p.status === 'superseded') throw new BadRequestException('A newer version of this proposal has been sent. Please open the latest one to sign.');
    if (p.status !== 'sent') return this.viewPublic(token, true);

    const view = toView(p);
    const now = new Date();
    const accepted = await this.prisma.$transaction(async (tx) => {
      const res = await tx.proposal.updateMany({ where: { id: p.id, status: 'sent' }, data: { status: 'accepted', acceptedAt: now } });
      if (!res.count) return false;
      await tx.agreement.create({
        data: {
          orgId: p.orgId,
          proposalId: p.id,
          signedAt: now,
          signer: { name: signer.signerName, email: signer.signerEmail, designation: signer.signerDesignation || undefined, ip, userAgent: userAgent?.slice(0, 200), at: now.toISOString() },
        },
      });
      // Approvals are immutable records (acceptance criteria): who, when, what.
      await tx.approval.create({ data: { orgId: p.orgId, targetType: 'proposal', targetId: p.id, userId: `external:${signer.signerEmail}`, at: now } });
      const fy = financialYear(now);
      const seq = (await tx.invoice.count({ where: { orgId: p.orgId, number: { startsWith: `BMU/${fy}/` } } })) + 1;
      await tx.invoice.create({
        data: {
          orgId: p.orgId,
          proposalId: p.id,
          kind: 'first_payment',
          number: `BMU/${fy}/${String(seq).padStart(4, '0')}`,
          lines: view.lines.filter((l) => l.dueNowPaise > 0).map((l) => ({ name: l.name, tier: l.tier, billingType: l.billingType, amountPaise: l.dueNowPaise, note: sellFirstPaymentNote(l) })),
          subtotalPaise: view.firstPayment.netPaise,
          gstPaise: view.firstPayment.gstPaise,
          totalPaise: view.firstPayment.totalPaise,
          dueDate: new Date(now.getTime() + 3 * DAY),
          status: 'issued',
        },
      });
      return true;
    });
    if (accepted) {
      await this.audit.logSystem(p.orgId, 'proposal.accepted', 'Proposal', p.id, { signer: signer.signerName, email: signer.signerEmail, designation: signer.signerDesignation }, ip);
      await logLeadActivity(this.prisma, { orgId: p.orgId, leadId: p.leadId, kind: 'system', body: `${signer.signerName}${signer.signerDesignation ? ` (${signer.signerDesignation})` : ''} accepted and e-signed proposal v${p.version}. First invoice issued.` });
      await this.notifications.notify(p.orgId, await this.salesPeople(p), {
        kind: 'proposal_accepted',
        title: `${clientName(p.lead.contact)} accepted and signed the proposal`,
        body: `Waiting for the first payment of ${formatINR(view.firstPayment.totalPaise)}.`,
        link: `/team/proposals/${p.id}`,
      });
    }
    return this.viewPublic(token, true);
  }

  private async unpaidInvoice(token: string) {
    const p = await this.byToken(token);
    const invoice = p.invoices.find((i) => i.kind === 'first_payment');
    if (p.status !== 'accepted' || !invoice) throw new BadRequestException('Accept the proposal first');
    return { p, invoice };
  }

  async checkout(token: string) {
    const { p, invoice } = await this.unpaidInvoice(token);
    if (invoice.status === 'paid') return { mode: 'paid' as const };
    if (!this.payments.enabled) return { mode: this.payments.testMode ? ('test' as const) : ('unavailable' as const) };
    const order = await this.payments.createOrder(invoice.totalPaise, invoice.number);
    await this.prisma.invoice.update({ where: { id: invoice.id }, data: { razorpayRef: order.id } });
    const contact = p.lead.contact as { name?: string; email?: string; phone?: string };
    return {
      mode: 'razorpay' as const,
      keyId: this.payments.keyId!,
      orderId: order.id,
      amountPaise: invoice.totalPaise,
      invoiceNumber: invoice.number,
      prefill: { name: contact.name, email: contact.email, contact: contact.phone },
    };
  }

  async verifyRazorpay(token: string, orderId: string, paymentId: string, signature: string) {
    const { invoice } = await this.unpaidInvoice(token);
    if (invoice.status === 'paid') return this.viewPublic(token, true);
    if (invoice.razorpayRef !== orderId || !this.payments.verifySignature(orderId, paymentId, signature)) {
      throw new BadRequestException('Payment could not be verified');
    }
    await this.onboarding.recordFirstPayment(invoice.id, invoice.totalPaise, 'razorpay', paymentId);
    return this.viewPublic(token, true);
  }

  async payTest(token: string) {
    if (!this.payments.testMode) throw new ForbiddenException('Test payments are disabled');
    const { invoice } = await this.unpaidInvoice(token);
    await this.onboarding.recordFirstPayment(invoice.id, invoice.totalPaise, 'test', `test_${Date.now()}`);
    return this.viewPublic(token, true);
  }
}
