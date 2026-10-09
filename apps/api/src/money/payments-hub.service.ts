import { randomBytes } from 'node:crypto';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import {
  CRAFT_SPECIALTY_OPTIONS,
  formatINR,
  matchPaymentSchema,
  unmatchedCreateSchema,
  type Me,
  type MoneyOptions,
  type PaymentLinkView,
  type PublicPayView,
  type UnmatchedList,
  type UnmatchedPaymentRow,
} from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { parse } from '../common/zod.js';
import { clientScope } from '../creative/scope.js';
import type { PaymentLink, UnmatchedPayment } from '../generated/prisma/client.js';
import { assertFinanceRead, assertFinanceWrite } from '../insights/access.js';
import { loadLedger, type LedgerInvoice } from '../insights/ledger.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PaymentsService } from '../proposals/payments.service.js';
import { BillingService } from '../requests/billing.service.js';
import { appUrl } from '../service/email.service.js';
import { InvoiceEvents, type PaidInvoice } from '../service/invoice-events.js';

const OPEN = ['issued', 'partially_paid', 'overdue'];

/** What Razorpay sends to the webhook (only the fields we read). */
export type RazorpayEvent = {
  event?: string;
  payload?: {
    payment?: { entity?: { id?: string; amount?: number; order_id?: string | null; email?: string | null; contact?: string | null; notes?: Record<string, string> | unknown[]; description?: string | null; status?: string } };
    payment_link?: { entity?: { id?: string; reference_id?: string; notes?: Record<string, string> | unknown[] } };
  };
};

const notesOf = (n: unknown): Record<string, string> => (n && typeof n === 'object' && !Array.isArray(n) ? (n as Record<string, string>) : {});

/**
 * v18 money in: pay-by-link (Razorpay Payment Links, or a test link in development), the Razorpay webhook that marks
 * invoices paid on its own, payments nobody could match, and the "Payment received" note on the client's thread.
 */
@Injectable()
export class PaymentsHubService implements OnModuleInit {
  private readonly log = new Logger('PaymentsHub');
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly payments: PaymentsService,
    private readonly billing: BillingService,
    private readonly notifications: NotificationsService,
    private readonly events: InvoiceEvents,
  ) {}

  onModuleInit() {
    this.events.onPaid((inv) => this.onInvoicePaid(inv));
  }

  // ---------------------------------------------------------------------------
  // Paid → client thread

  /** Fully paid: close its pay links and thank the client on their Account Manager thread. */
  async onInvoicePaid(paid: PaidInvoice) {
    const inv = await this.prisma.invoice.findUnique({ where: { id: paid.id }, include: { payments: { orderBy: { at: 'desc' }, take: 1 }, clientOrg: { select: { id: true, amUserId: true } } } });
    if (!inv) return;
    await this.prisma.paymentLink.updateMany({ where: { invoiceId: inv.id, status: 'active' }, data: { status: 'paid', paidAt: new Date() } });
    // The first payment (proposal accepted) opens the account with its own welcome; no thank-you on top of it.
    if (!inv.clientOrgId || inv.kind === 'first_payment') return;
    const author =
      inv.clientOrg?.amUserId ??
      (await this.prisma.user.findFirst({ where: { orgId: inv.orgId, type: 'staff', deletedAt: null, roles: { some: { role: { baseRole: 'founder' } } } }, select: { id: true } }))?.id;
    if (!author) return;
    const thread =
      (await this.prisma.thread.findFirst({ where: { clientOrgId: inv.clientOrgId, type: 'client_am' }, orderBy: { id: 'asc' } })) ??
      (await this.prisma.thread.create({ data: { orgId: inv.orgId, clientOrgId: inv.clientOrgId, type: 'client_am' } }));
    const last = inv.payments[0];
    const how = last?.method === 'razorpay' ? ' online' : last?.method === 'test' ? ' (test payment)' : '';
    await this.prisma.message.create({
      data: { orgId: inv.orgId, threadId: thread.id, authorId: author, body: `Payment received${how}: invoice ${inv.number} (${formatINR(inv.totalPaise)}) is now fully paid. Thank you!` },
    });
  }

  /** Clients (with projects) the person works on, and active team members, for the v18 forms. */
  async options(me: Me): Promise<MoneyOptions> {
    if (me.type !== 'staff') throw new ForbiddenException('Team only');
    const scope = await clientScope(this.prisma, me);
    const [clients, people] = await Promise.all([
      this.prisma.clientOrg.findMany({
        where: { orgId: me.orgId, deletedAt: null, archivedAt: null, ...(scope === 'all' ? {} : { id: { in: scope } }) },
        select: { id: true, name: true, engagements: { where: { deletedAt: null }, select: { id: true, service: { select: { name: true } } }, orderBy: { createdAt: 'desc' } } },
        orderBy: { name: 'asc' },
        take: 500,
      }),
      this.prisma.user.findMany({ where: { orgId: me.orgId, type: 'staff', status: 'active', deletedAt: null }, select: { id: true, name: true, specialty: true }, orderBy: { name: 'asc' }, take: 500 }),
    ]);
    return {
      clients: clients.map((c) => ({ id: c.id, name: c.name, projects: c.engagements.map((e) => ({ id: e.id, label: e.service.name })) })),
      people,
      specialties: CRAFT_SPECIALTY_OPTIONS.map((s) => ({ id: s.id, label: s.label })),
    };
  }

  // ---------------------------------------------------------------------------
  // Pay links

  private view(l: PaymentLink, number: string): PaymentLinkView {
    return {
      id: l.id,
      invoiceId: l.invoiceId,
      invoiceNumber: number,
      url: appUrl(`/pay/${l.token}`),
      shortUrl: l.shortUrl,
      provider: l.provider === 'razorpay' ? 'razorpay' : 'test',
      amountPaise: l.amountPaise,
      status: l.status as PaymentLinkView['status'],
      createdAt: l.createdAt.toISOString(),
      paidAt: l.paidAt?.toISOString() ?? null,
    };
  }

  private async ledgerOne(orgId: string, id: string) {
    const [inv] = await loadLedger(this.prisma, orgId, { id });
    if (!inv) throw new NotFoundException('Invoice not found');
    return inv;
  }

  async links(me: Me, invoiceId: string) {
    assertFinanceRead(me);
    const inv = await this.ledgerOne(me.orgId, invoiceId);
    const rows = await this.prisma.paymentLink.findMany({ where: { invoiceId }, orderBy: { createdAt: 'desc' } });
    return rows.map((l) => this.view(l, inv.number));
  }

  /** One active link per invoice; a new one replaces the old one when the balance changed. */
  async createLink(me: Me | null, invoiceId: string, orgId = me?.orgId, ip?: string) {
    if (me) assertFinanceWrite(me);
    const inv = await this.ledgerOne(orgId!, invoiceId);
    if (!OPEN.includes(inv.status) || inv.balancePaise <= 0) throw new BadRequestException('Nothing is due on this invoice');
    const active = await this.prisma.paymentLink.findFirst({ where: { invoiceId, status: 'active' }, orderBy: { createdAt: 'desc' } });
    if (active && active.amountPaise === inv.balancePaise) return this.view(active, inv.number);
    if (active) await this.cancelOne(active);
    const token = randomBytes(18).toString('base64url');
    let externalId: string | null = null;
    let shortUrl: string | null = null;
    if (this.payments.enabled) {
      const r = await this.razorpayLink(inv, token);
      externalId = r.id;
      shortUrl = r.short_url ?? null;
    } else if (process.env.NODE_ENV === 'production') {
      throw new BadRequestException('Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to create payment links');
    }
    const link = await this.prisma.paymentLink.create({
      data: { orgId: inv.orgId, invoiceId, token, provider: externalId ? 'razorpay' : 'test', externalId, shortUrl, amountPaise: inv.balancePaise, createdById: me?.id ?? null },
    });
    if (me) await this.audit.log(me, 'invoice.pay_link_created', 'Invoice', invoiceId, undefined, { linkId: link.id, amountPaise: link.amountPaise, provider: link.provider }, ip);
    else await this.audit.logSystem(inv.orgId, 'invoice.pay_link_created', 'Invoice', invoiceId, { linkId: link.id, amountPaise: link.amountPaise, provider: link.provider });
    return this.view(link, inv.number);
  }

  private async razorpayLink(inv: LedgerInvoice, token: string): Promise<{ id: string; short_url?: string }> {
    const contact = await this.prisma.clientOrg.findUnique({ where: { id: inv.clientOrgId ?? '' }, select: { name: true, billingEmail: true } }).catch(() => null);
    const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
    const res = await fetch('https://api.razorpay.com/v1/payment_links', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: inv.balancePaise,
        currency: 'INR',
        accept_partial: false,
        reference_id: `${inv.number}-${token.slice(0, 6)}`.slice(0, 40),
        description: `Invoice ${inv.number}`,
        customer: { name: contact?.name ?? inv.clientOrg?.name ?? undefined, email: contact?.billingEmail ?? undefined },
        notify: { sms: false, email: false },
        reminder_enable: false,
        notes: { invoiceId: inv.id, token },
        callback_url: appUrl(`/pay/${token}`),
        callback_method: 'get',
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new BadRequestException('Razorpay could not create the payment link. Check the keys and try again.');
    return (await res.json()) as { id: string; short_url?: string };
  }

  private async cancelOne(l: PaymentLink) {
    if (l.externalId && this.payments.enabled) {
      const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
      await fetch(`https://api.razorpay.com/v1/payment_links/${encodeURIComponent(l.externalId)}/cancel`, { method: 'POST', headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(8000) }).catch(() => null);
    }
    return this.prisma.paymentLink.update({ where: { id: l.id }, data: { status: 'cancelled' } });
  }

  async cancelLink(me: Me, id: string, ip?: string) {
    assertFinanceWrite(me);
    const l = await this.prisma.paymentLink.findFirst({ where: { id, orgId: me.orgId } });
    if (!l) throw new NotFoundException('Link not found');
    if (l.status !== 'active') throw new BadRequestException('This link is no longer active');
    const done = await this.cancelOne(l);
    await this.audit.log(me, 'invoice.pay_link_cancelled', 'Invoice', l.invoiceId, { status: 'active' }, { status: 'cancelled', linkId: id }, ip);
    const inv = await this.prisma.invoice.findUniqueOrThrow({ where: { id: l.invoiceId }, select: { number: true } });
    return this.view(done, inv.number);
  }

  // ---------------------------------------------------------------------------
  // Public pay page

  private async byToken(token: string) {
    const link = await this.prisma.paymentLink.findUnique({ where: { token } });
    if (!link) throw new NotFoundException('This payment link does not exist');
    const inv = await this.ledgerOne(link.orgId, link.invoiceId);
    return { link, inv };
  }

  async publicView(token: string): Promise<PublicPayView> {
    const { link, inv } = await this.byToken(token);
    const org = await this.prisma.organisation.findUnique({ where: { id: link.orgId }, select: { name: true } });
    const paid = inv.status === 'paid' || inv.status === 'credit_noted' || (OPEN.includes(inv.status) && inv.balancePaise <= 0);
    const status: PublicPayView['status'] = paid ? 'paid' : link.status === 'cancelled' || inv.status === 'void' ? 'cancelled' : 'due';
    return {
      invoiceNumber: inv.number,
      client: inv.clientOrg?.name ?? '',
      company: org?.name ?? 'BMU',
      totalPaise: inv.totalPaise,
      balancePaise: inv.balancePaise,
      dueDate: inv.dueDate.toISOString(),
      status,
      provider: link.provider === 'razorpay' ? 'razorpay' : 'test',
      shortUrl: link.shortUrl,
      testMode: this.payments.testMode && link.provider === 'test',
    };
  }

  /** Development only (no Razorpay keys): pays the balance as a test payment, exactly like the webhook would. */
  async publicTest(token: string) {
    if (!this.payments.testMode) throw new ForbiddenException('Test payments are disabled');
    const { link, inv } = await this.byToken(token);
    if (link.status !== 'active' || inv.balancePaise <= 0) throw new BadRequestException('Nothing is due on this link');
    await this.billing.recordPayment(inv.id, inv.balancePaise, 'test', `testlink_${link.id}_${Date.now()}`);
    return this.publicView(token);
  }

  // ---------------------------------------------------------------------------
  // Razorpay webhook

  /** Maps a captured payment to an invoice (notes → link → order) and records it; anything else waits as unmatched. */
  async onRazorpay(evt: RazorpayEvent) {
    const kind = evt.event ?? '';
    if (kind !== 'payment_link.paid' && kind !== 'payment.captured') return { ok: true, ignored: kind || 'unknown' };
    const pay = evt.payload?.payment?.entity;
    if (!pay?.id || !pay.amount) return { ok: true, ignored: 'no payment' };
    const plink = evt.payload?.payment_link?.entity;
    const notes = { ...notesOf(pay.notes), ...notesOf(plink?.notes) };
    let link = plink?.id ? await this.prisma.paymentLink.findUnique({ where: { externalId: plink.id } }) : null;
    if (!link && notes.token) link = await this.prisma.paymentLink.findUnique({ where: { token: notes.token } });
    let invoiceId = link?.invoiceId ?? null;
    if (!invoiceId && notes.invoiceId) invoiceId = (await this.prisma.invoice.findUnique({ where: { id: notes.invoiceId }, select: { id: true } }))?.id ?? null;
    if (!invoiceId && pay.order_id) invoiceId = (await this.prisma.invoice.findFirst({ where: { razorpayRef: pay.order_id }, select: { id: true } }))?.id ?? null;
    // A payment_link.paid always comes with a payment.captured for the same payment; one record is enough.
    if (invoiceId) {
      const inv = await this.prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { status: true, orgId: true } });
      if (inv.status !== 'void') {
        await this.billing.recordPayment(invoiceId, pay.amount, 'razorpay', pay.id);
        if (link && link.status === 'active') await this.prisma.paymentLink.update({ where: { id: link.id }, data: { status: 'paid', paidAt: new Date() } });
        return { ok: true, invoiceId };
      }
    }
    // Already recorded through checkout/verify?
    if (await this.prisma.payment.findFirst({ where: { ref: pay.id }, select: { id: true } })) return { ok: true, duplicate: true };
    const org = link ? { id: link.orgId } : await this.prisma.organisation.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } });
    if (!org) return { ok: true, ignored: 'no organisation' };
    const row = await this.prisma.unmatchedPayment.upsert({
      where: { orgId_provider_ref: { orgId: org.id, provider: 'razorpay', ref: pay.id } },
      update: {},
      create: { orgId: org.id, provider: 'razorpay', ref: pay.id, amountPaise: pay.amount, payerEmail: pay.email ?? null, payerPhone: pay.contact ?? null, note: pay.description ?? null },
    });
    await this.alertUnmatched(row);
    return { ok: true, unmatched: row.id };
  }

  private async alertUnmatched(row: UnmatchedPayment) {
    const finance = await this.prisma.user.findMany({ where: { orgId: row.orgId, type: 'staff', status: 'active', deletedAt: null, roles: { some: { role: { baseRole: 'finance' } } } }, select: { id: true } });
    await this.notifications.notify(row.orgId, finance.map((f) => f.id), {
      kind: 'payment_received',
      title: `${formatINR(row.amountPaise)} received but not matched to an invoice`,
      body: `Reference ${row.ref}${row.payerEmail ? ` from ${row.payerEmail}` : ''}. Match it in Finance → Payments to match.`,
      link: '/admin/finance/reconcile',
    });
  }

  // ---------------------------------------------------------------------------
  // Unmatched payments

  async suggestionsFor(orgId: string, row: { amountPaise: number; ref: string; payerEmail: string | null; payerPhone: string | null; payerName: string | null; note: string | null }, open?: LedgerInvoice[]) {
    const ledger = open ?? (await loadLedger(this.prisma, orgId, { status: { in: ['issued', 'partially_paid', 'overdue'] } })).filter((i) => i.balancePaise > 0);
    const emails = row.payerEmail ? await this.prisma.clientUser.findMany({ where: { user: { email: { equals: row.payerEmail, mode: 'insensitive' } } }, select: { clientOrgId: true } }) : [];
    const billing = row.payerEmail ? await this.prisma.clientOrg.findMany({ where: { orgId, billingEmail: { equals: row.payerEmail, mode: 'insensitive' } }, select: { id: true } }) : [];
    const payerClients = new Set([...emails.map((e) => e.clientOrgId), ...billing.map((b) => b.id)]);
    const text = `${row.ref} ${row.note ?? ''} ${row.payerName ?? ''}`.toLowerCase();
    const scored = ledger
      .map((i) => {
        const reasons: string[] = [];
        let score = 0;
        if (text.includes(i.number.toLowerCase())) {
          score += 5;
          reasons.push('reference has the invoice number');
        }
        if (i.clientOrgId && payerClients.has(i.clientOrgId)) {
          score += 3;
          reasons.push("payer's email belongs to this client");
        }
        if (i.balancePaise === row.amountPaise) {
          score += 2;
          reasons.push('same amount as the balance');
        }
        if (row.payerName && i.clientOrg?.name && text.includes(i.clientOrg.name.toLowerCase().split(' ')[0])) {
          score += 1;
          reasons.push('payer name looks like the client');
        }
        return { i, score, reasons };
      })
      .filter((s) => s.score >= 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    return scored.map((s) => ({ invoiceId: s.i.id, number: s.i.number, client: s.i.clientOrg?.name ?? '', balancePaise: s.i.balancePaise, reason: s.reasons.join(', ') }));
  }

  async unmatched(me: Me): Promise<UnmatchedList> {
    assertFinanceRead(me);
    const rows = await this.prisma.unmatchedPayment.findMany({ where: { orgId: me.orgId }, orderBy: { receivedAt: 'desc' }, take: 200 });
    const open = (await loadLedger(this.prisma, me.orgId, { status: { in: ['issued', 'partially_paid', 'overdue'] } })).filter((i) => i.balancePaise > 0);
    const numbers = new Map((await this.prisma.invoice.findMany({ where: { id: { in: rows.map((r) => r.invoiceId).filter((x): x is string => !!x) } }, select: { id: true, number: true } })).map((i) => [i.id, i.number]));
    const out: UnmatchedPaymentRow[] = [];
    for (const r of rows) {
      const status = r.matchedAt ? 'matched' : r.ignoredAt ? 'ignored' : 'open';
      out.push({
        id: r.id,
        provider: r.provider,
        ref: r.ref,
        amountPaise: r.amountPaise,
        payerName: r.payerName,
        payerEmail: r.payerEmail,
        payerPhone: r.payerPhone,
        note: r.note,
        receivedAt: r.receivedAt.toISOString(),
        status,
        invoiceId: r.invoiceId,
        invoiceNumber: r.invoiceId ? (numbers.get(r.invoiceId) ?? null) : null,
        suggestions: status === 'open' ? await this.suggestionsFor(me.orgId, r, open) : [],
      });
    }
    return { open: out.filter((r) => r.status === 'open'), done: out.filter((r) => r.status !== 'open') };
  }

  async addUnmatched(me: Me, body: unknown, ip?: string) {
    assertFinanceWrite(me);
    const input = parse(unmatchedCreateSchema, body);
    const ref = input.ref.trim();
    if (await this.prisma.unmatchedPayment.findUnique({ where: { orgId_provider_ref: { orgId: me.orgId, provider: 'bank', ref } } })) throw new BadRequestException('That reference is already in the list');
    const row = await this.prisma.unmatchedPayment.create({
      data: { orgId: me.orgId, provider: 'bank', ref, amountPaise: input.amountPaise, payerName: input.payerName?.trim() || null, note: input.note?.trim() || null, receivedAt: input.receivedOn ? new Date(`${input.receivedOn}T12:00:00+05:30`) : new Date() },
    });
    await this.audit.log(me, 'payment.unmatched_added', 'UnmatchedPayment', row.id, undefined, { amountPaise: row.amountPaise, ref }, ip);
    return this.unmatched(me);
  }

  /** Records the money on the chosen invoice (Finance, or the Finance collector agent after a person confirms). */
  async match(me: Me, id: string, body: unknown, ip?: string) {
    assertFinanceWrite(me);
    const { invoiceId } = parse(matchPaymentSchema, body);
    await this.matchCore(me.orgId, id, invoiceId, me.id);
    await this.audit.log(me, 'payment.matched', 'UnmatchedPayment', id, undefined, { invoiceId }, ip);
    return this.unmatched(me);
  }

  async matchCore(orgId: string, id: string, invoiceId: string, byId: string | null) {
    const row = await this.prisma.unmatchedPayment.findFirst({ where: { id, orgId } });
    if (!row) throw new NotFoundException('Payment not found');
    if (row.matchedAt || row.ignoredAt) throw new BadRequestException('This payment is already handled');
    const inv = await this.ledgerOne(orgId, invoiceId);
    if (!OPEN.includes(inv.status) || inv.balancePaise <= 0) throw new BadRequestException('Nothing is due on that invoice');
    if (row.amountPaise > inv.balancePaise) throw new BadRequestException(`That is more than the balance due on ${inv.number} (${formatINR(inv.balancePaise)})`);
    await this.billing.recordPayment(invoiceId, row.amountPaise, row.provider === 'razorpay' ? 'razorpay' : 'bank', row.ref);
    await this.prisma.unmatchedPayment.update({ where: { id }, data: { invoiceId, matchedAt: new Date(), matchedById: byId } });
    return { invoiceNumber: inv.number, amountPaise: row.amountPaise };
  }

  async ignore(me: Me, id: string, ip?: string) {
    assertFinanceWrite(me);
    const row = await this.prisma.unmatchedPayment.findFirst({ where: { id, orgId: me.orgId } });
    if (!row) throw new NotFoundException('Payment not found');
    if (row.matchedAt) throw new BadRequestException('This payment is already matched');
    await this.prisma.unmatchedPayment.update({ where: { id }, data: { ignoredAt: new Date() } });
    await this.audit.log(me, 'payment.unmatched_ignored', 'UnmatchedPayment', id, undefined, { ref: row.ref }, ip);
    return this.unmatched(me);
  }
}

