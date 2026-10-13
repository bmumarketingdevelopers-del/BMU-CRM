import { BadRequestException, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { ApprovalsService } from '../actions/approvals.service.js';
import { ActionsRegistry } from '../actions/registry.js';
import { applyNotificationTemplate } from '../notifications/notifications.service.js';
import {
  ACCOUNTING_FORMATS,
  financialYear,
  formatINR,
  paymentMethodLabels,
  type CreateCreditNote,
  type CreatePayout,
  type CreditNoteRow,
  type CreditNotesView,
  type FinanceInvoiceDetail,
  type FinanceInvoiceList,
  type GstSummaryView,
  type Me,
  type PaymentRow,
  type PaymentsView,
  type PayoutsView,
  type RecordPayment,
} from '@bmu/shared';
import {
  cancelInvoiceSchema,
  createCreditNoteSchema,
  createPayoutSchema,
  markPayoutPaidSchema,
  recordPaymentSchema,
} from '@bmu/shared';
import { parse } from '../common/zod.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { InvoiceEvents } from '../service/invoice-events.js';
import { assertFinanceRead, assertFinanceWrite, canWriteFinance } from './access.js';
import { isoDay, monthLabel, startOfMonth } from './ist.js';
import { isBillable, loadLedger, toRow, type LedgerInvoice } from './ledger.js';
import { tallyXml, zohoInvoiceRows, zohoPaymentRows } from './accounting-formats.js';

const TDS_RATE = 0.1;

/** Finance desk: invoices, offline payments, cancellations, credit notes, creator payouts, GST and accounting exports. */
@Injectable()
export class FinanceService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly events: InvoiceEvents,
    private readonly approvals: ApprovalsService,
    private readonly registry: ActionsRegistry,
  ) {}

  /** v11 ops: credit notes need Branch Manager approval (approval_matrix); Founders and Branch Managers issue them directly. */
  onModuleInit() {
    this.registry.registerApprovalHandler({
      action: 'invoice.credit_note',
      label: 'Credit note',
      href: (r) => `/admin/finance/invoices/${r.targetId}`,
      apply: async ({ approver, req }) => {
        const p = req.payload as { invoiceId: string; amountPaise: number; reason: string; requestedById: string };
        return this.applyCreditNote(approver, { invoiceId: p.invoiceId, amountPaise: p.amountPaise, reason: p.reason }, req.requestedById);
      },
    });
  }

  // -------------------------------------------------------------------------
  // Invoices

  async invoices(me: Me, f: { status?: string; kind?: string; clientId?: string; q?: string }): Promise<FinanceInvoiceList> {
    assertFinanceRead(me);
    const ledger = await loadLedger(this.prisma, me.orgId, {
      ...(f.kind ? { kind: f.kind } : {}),
      ...(f.clientId ? { clientOrgId: f.clientId } : {}),
    });
    const q = f.q?.trim().toLowerCase();
    const rows = ledger
      .filter((i) => !f.status || i.displayStatus === f.status || (f.status === 'unpaid' && i.balancePaise > 0))
      .filter((i) => !q || i.number.toLowerCase().includes(q) || (i.clientOrg?.name ?? '').toLowerCase().includes(q))
      .map(toRow);
    const clients = await this.prisma.clientOrg.findMany({ where: { orgId: me.orgId, deletedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
    const billable = rows.filter((r) => r.status !== 'void');
    return {
      rows,
      totals: {
        count: rows.length,
        totalPaise: billable.reduce((s, r) => s + r.totalPaise - r.creditedPaise, 0),
        paidPaise: billable.reduce((s, r) => s + r.paidPaise, 0),
        balancePaise: billable.reduce((s, r) => s + r.balancePaise, 0),
      },
      clients,
      canEdit: canWriteFinance(me),
    };
  }

  private async ledgerOne(me: Me, id: string) {
    const [inv] = await loadLedger(this.prisma, me.orgId, { id });
    if (!inv) throw new NotFoundException('Invoice not found');
    return inv;
  }

  async invoice(me: Me, id: string): Promise<FinanceInvoiceDetail> {
    assertFinanceRead(me);
    const inv = await this.ledgerOne(me, id);
    const [cancel, users, gst] = await Promise.all([
      inv.status === 'void'
        ? this.prisma.auditEvent.findFirst({ where: { orgId: me.orgId, entity: 'Invoice', entityId: id, action: 'invoice.cancelled' }, orderBy: { at: 'desc' } })
        : null,
      this.userNames(inv.creditNotes.map((n) => n.createdById)),
      this.settings.get(me.orgId, 'gst'),
    ]);
    const client = inv.clientOrg?.name ?? 'No client yet';
    return {
      ...toRow(inv),
      lines: ((inv.lines as { label: string; amountPaise: number }[] | null) ?? []).filter((l) => l && typeof l.amountPaise === 'number'),
      service: inv.engagement?.service.name ?? null,
      payments: inv.payments.map((p) => paymentRow(p, inv.number, client)),
      creditNotes: inv.creditNotes.map((n) => creditRow(n, inv.number, client, users)),
      cancelReason: (cancel?.after as { reason?: string } | null)?.reason ?? null,
      creditableTotalPaise: creditable(inv),
      gstRatePct: gst.ratePct,
      canEdit: canWriteFinance(me),
    };
  }

  /** Offline payment (bank, UPI, cash, cheque). Idempotent by reference; marks the invoice paid once fully settled. */
  async recordPayment(me: Me, id: string, body: unknown, ip?: string) {
    assertFinanceWrite(me);
    const input: RecordPayment = parse(recordPaymentSchema, body);
    const inv = await this.ledgerOne(me, id);
    const ref = input.ref.trim();
    const existing = await this.prisma.payment.findFirst({ where: { orgId: me.orgId, invoiceId: id, ref } });
    if (existing) return this.invoice(me, id);
    if (!['issued', 'partially_paid', 'overdue'].includes(inv.status)) throw new BadRequestException('This invoice is not open for payment');
    const tds = input.tdsPaise ?? 0;
    if (input.amountPaise + tds > inv.balancePaise) throw new BadRequestException(`That is more than the balance due (${formatINR(inv.balancePaise)})`);
    const at = input.at ? new Date(`${input.at}T12:00:00+05:30`) : new Date();
    if (at.getTime() > Date.now() + 86_400_000) throw new BadRequestException('Payment date cannot be in the future');
    const settled = inv.paidPaise + inv.creditedPaise + input.amountPaise + tds >= inv.totalPaise;
    const status = settled ? 'paid' : 'partially_paid';
    // v18: TDS the client deducted is its own "tds" line, so every balance calculation counts it without changes.
    const [payment] = await this.prisma.$transaction([
      this.prisma.payment.create({ data: { orgId: me.orgId, invoiceId: id, amountPaise: input.amountPaise, method: input.method, ref, at } }),
      ...(tds > 0 ? [this.prisma.payment.create({ data: { orgId: me.orgId, invoiceId: id, amountPaise: tds, method: 'tds', ref: `${ref}-tds`, at } })] : []),
      this.prisma.invoice.update({ where: { id }, data: { status } }),
    ]);
    await this.audit.log(me, 'invoice.payment_recorded', 'Invoice', id, { status: inv.status }, { paymentId: payment.id, amountPaise: input.amountPaise, tdsPaise: tds, method: input.method, ref, status }, ip);
    // v10: a manual payment that settles the invoice starts the same follow-ups as an online one
    // (extra request → work task, project balance → Gate 5 / files released).
    if (settled) await this.events.paid(inv);
    return this.invoice(me, id);
  }

  async cancel(me: Me, id: string, body: unknown, ip?: string) {
    assertFinanceWrite(me);
    const { reason } = parse(cancelInvoiceSchema, body);
    const inv = await this.ledgerOne(me, id);
    if (inv.status === 'void') throw new BadRequestException('This invoice is already cancelled');
    if (inv.payments.length) throw new BadRequestException('This invoice has payments. Issue a credit note instead.');
    if (inv.creditNotes.length) throw new BadRequestException('This invoice has credit notes. Issue a credit note for the rest instead.');
    await this.prisma.invoice.update({ where: { id }, data: { status: 'void' } });
    await this.audit.log(me, 'invoice.cancelled', 'Invoice', id, { status: inv.status }, { status: 'void', reason }, ip);
    return this.invoice(me, id);
  }

  /** In-app reminder to the client's owner and finance people. */
  async remind(me: Me, id: string, ip?: string) {
    assertFinanceWrite(me);
    const inv = await this.ledgerOne(me, id);
    if (inv.balancePaise <= 0) throw new BadRequestException('Nothing is due on this invoice');
    if (!inv.clientOrgId) throw new BadRequestException('This invoice has no client account yet');
    const people = await this.prisma.clientUser.findMany({
      where: { clientOrgId: inv.clientOrgId, clientRole: { in: ['client_owner', 'client_finance'] }, user: { status: 'active', deletedAt: null } },
      select: { userId: true },
    });
    if (!people.length) throw new BadRequestException('No owner or finance person on this client account to remind');
    const late = inv.daysOverdue > 0 ? ` It was due ${inv.daysOverdue} day${inv.daysOverdue === 1 ? '' : 's'} ago.` : '';
    for (const p of people) {
      await this.prisma.notification.create({
        data: {
          orgId: me.orgId,
          userId: p.userId,
          kind: 'invoice_reminder',
          title: `Payment reminder: invoice ${inv.number}`,
          body: `${formatINR(inv.balancePaise)} is due on invoice ${inv.number}.${late}`,
          link: `/client/billing/${inv.id}`,
          critical: inv.daysOverdue > 30,
        },
      });
    }
    await this.audit.log(me, 'invoice.reminder_sent', 'Invoice', id, undefined, { notified: people.length, balancePaise: inv.balancePaise }, ip);
    return { notified: people.length };
  }

  // -------------------------------------------------------------------------
  // Payments

  async payments(me: Me): Promise<PaymentsView> {
    assertFinanceRead(me);
    const rows = await this.prisma.payment.findMany({
      where: { orgId: me.orgId },
      include: { invoice: { select: { number: true, clientOrg: { select: { name: true } } } } },
      orderBy: { at: 'desc' },
    });
    const monthStart = startOfMonth(new Date());
    const methods = new Map<string, { valuePaise: number; count: number }>();
    for (const p of rows) {
      const m = methods.get(p.method) ?? { valuePaise: 0, count: 0 };
      m.valuePaise += p.amountPaise;
      m.count++;
      methods.set(p.method, m);
    }
    const online = (m: string) => m === 'razorpay';
    return {
      rows: rows.map((p) => paymentRow(p, p.invoice.number, p.invoice.clientOrg?.name ?? 'No client yet')),
      thisMonthPaise: rows.filter((p) => p.at >= monthStart).reduce((s, p) => s + p.amountPaise, 0),
      totalPaise: rows.reduce((s, p) => s + p.amountPaise, 0),
      byMethod: [...methods.entries()].map(([method, v]) => ({ method, label: paymentMethodLabels[method] ?? method, ...v })).sort((a, b) => b.valuePaise - a.valuePaise),
      razorpayPaise: rows.filter((p) => online(p.method)).reduce((s, p) => s + p.amountPaise, 0),
      offlinePaise: rows.filter((p) => !online(p.method)).reduce((s, p) => s + p.amountPaise, 0),
    };
  }

  // -------------------------------------------------------------------------
  // Credit notes

  async creditNotes(me: Me): Promise<CreditNotesView> {
    assertFinanceRead(me);
    const [ledger, gst] = await Promise.all([loadLedger(this.prisma, me.orgId), this.settings.get(me.orgId, 'gst')]);
    const notes = ledger.flatMap((i) => i.creditNotes.map((n) => ({ n, i })));
    const users = await this.userNames(notes.map(({ n }) => n.createdById));
    const rows = notes
      .map(({ n, i }) => creditRow(n, i.number, i.clientOrg?.name ?? 'No client yet', users))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      rows,
      totalPaise: rows.reduce((s, r) => s + r.totalPaise, 0),
      gstRatePct: gst.ratePct,
      invoices: ledger
        .filter((i) => isBillable(i) && creditable(i) > 0)
        .map((i) => ({ id: i.id, number: i.number, client: i.clientOrg?.name ?? 'No client yet', creditableTotalPaise: creditable(i) })),
      canEdit: canWriteFinance(me),
    };
  }

  /**
   * Amount is before GST; GST is added at the organisation rate. Total can't exceed what is left to credit.
   * v11 ops: Finance's credit notes go to a Branch Manager for approval first (the note is created on approval).
   */
  async issueCreditNote(me: Me, body: unknown, ip?: string): Promise<{ id: string | null; number: string | null; pending: boolean; approvalId: string | null; message: string }> {
    assertFinanceWrite(me);
    const input: CreateCreditNote = parse(createCreditNoteSchema, body);
    const { inv, totalPaise } = await this.checkCreditNote(me, input);
    if (me.roles.some((r) => r === 'founder' || r === 'admin')) {
      const note = await this.applyCreditNote(me, input, me.id, ip);
      return { ...note, pending: false, approvalId: null, message: `Credit note ${note.number} issued` };
    }
    const req = await this.approvals.create(
      me,
      {
        action: 'invoice.credit_note',
        targetType: 'invoice',
        targetId: inv.id,
        summary: `Credit note of ${formatINR(totalPaise)} on invoice ${inv.number}`,
        payload: { ...input, requestedById: me.id },
        reason: input.reason,
        approverId: null,
        approverRoles: ['admin'],
        diff: [{ field: 'Balance due', before: formatINR(inv.balancePaise), after: formatINR(Math.max(0, inv.balancePaise - totalPaise)) }],
      },
      ip,
    );
    return { id: null, number: null, pending: true, approvalId: req.id, message: 'Sent to a Branch Manager for approval. The credit note is issued once they approve.' };
  }

  private async checkCreditNote(me: Me, input: CreateCreditNote) {
    const inv = await this.ledgerOne(me, input.invoiceId);
    if (!isBillable(inv)) throw new BadRequestException('Cancelled invoices cannot be credited');
    const gst = await this.settings.get(me.orgId, 'gst');
    const gstPaise = Math.round((input.amountPaise * gst.ratePct) / 100);
    const totalPaise = input.amountPaise + gstPaise;
    const left = creditable(inv);
    if (totalPaise > left) throw new BadRequestException(`That is more than can be credited on this invoice (${formatINR(left)} including GST)`);
    return { inv, gstPaise, totalPaise };
  }

  private async applyCreditNote(me: Me, input: CreateCreditNote, createdById: string, ip?: string) {
    const { inv, gstPaise, totalPaise } = await this.checkCreditNote(me, input);
    const note = await this.prisma.$transaction(async (tx) => {
      const fy = financialYear(new Date());
      const prefix = `CN/${fy}/`;
      const seq = (await tx.creditNote.count({ where: { orgId: me.orgId, number: { startsWith: prefix } } })) + 1;
      const created = await tx.creditNote.create({
        data: {
          orgId: me.orgId,
          invoiceId: inv.id,
          number: `${prefix}${String(seq).padStart(4, '0')}`,
          amountPaise: input.amountPaise,
          gstPaise,
          totalPaise,
          reason: input.reason,
          createdById,
        },
      });
      const credited = inv.creditedPaise + totalPaise;
      let status = inv.status;
      if (credited >= inv.totalPaise) status = 'credit_noted';
      else if (inv.status !== 'paid' && inv.paidPaise + credited >= inv.totalPaise) status = 'paid';
      if (status !== inv.status) await tx.invoice.update({ where: { id: inv.id }, data: { status } });
      return created;
    });
    await this.audit.log(me, 'credit_note.issued', 'CreditNote', note.id, undefined, { invoiceId: inv.id, number: note.number, amountPaise: note.amountPaise, gstPaise, totalPaise, reason: input.reason }, ip);
    await this.audit.log(me, 'invoice.credit_note_issued', 'Invoice', inv.id, { creditedPaise: inv.creditedPaise }, { creditNote: note.number, totalPaise, reason: input.reason }, ip);
    // A credit note that settles the rest of an open invoice counts as paid for the follow-ups.
    if (inv.status !== 'paid' && inv.paidPaise > 0 && inv.paidPaise + inv.creditedPaise + totalPaise >= inv.totalPaise && inv.creditedPaise + totalPaise < inv.totalPaise) await this.events.paid(inv);
    return { id: note.id, number: note.number };
  }

  // -------------------------------------------------------------------------
  // Creator payouts

  async payouts(me: Me): Promise<PayoutsView> {
    assertFinanceRead(me);
    const [rows, creators] = await Promise.all([
      this.prisma.creatorPayout.findMany({ where: { orgId: me.orgId }, orderBy: { createdAt: 'desc' } }),
      this.prisma.creator.findMany({ where: { orgId: me.orgId }, include: { user: { select: { name: true } } } }),
    ]);
    const briefIds = rows.map((r) => r.briefId).filter((x): x is string => !!x);
    const briefs = briefIds.length ? await this.prisma.creatorBrief.findMany({ where: { id: { in: briefIds } }, select: { id: true, title: true } }) : [];
    const creatorName = new Map(creators.map((c) => [c.id, c.user.name]));
    const briefTitle = new Map(briefs.map((b) => [b.id, b.title]));
    return {
      rows: rows.map((r) => ({
        id: r.id,
        creatorId: r.creatorId,
        creator: creatorName.get(r.creatorId) ?? 'Creator',
        brief: r.briefId ? (briefTitle.get(r.briefId) ?? null) : null,
        amountPaise: r.amountPaise,
        tdsPaise: r.tdsPaise,
        netPaise: r.netPaise,
        status: r.status,
        paidAt: r.paidAt?.toISOString() ?? null,
        ref: r.ref,
        createdAt: r.createdAt.toISOString(),
      })),
      pendingNetPaise: rows.filter((r) => r.status !== 'paid').reduce((s, r) => s + r.netPaise, 0),
      paidNetPaise: rows.filter((r) => r.status === 'paid').reduce((s, r) => s + r.netPaise, 0),
      tdsPaise: rows.reduce((s, r) => s + r.tdsPaise, 0),
      creators: creators.map((c) => ({ id: c.id, name: c.user.name })).sort((a, b) => a.name.localeCompare(b.name)),
      canEdit: canWriteFinance(me),
    };
  }

  /** Manual payout; TDS 10% is held back. */
  async addPayout(me: Me, body: unknown, ip?: string) {
    assertFinanceWrite(me);
    const input: CreatePayout = parse(createPayoutSchema, body);
    const creator = await this.prisma.creator.findFirst({ where: { id: input.creatorId, orgId: me.orgId } });
    if (!creator) throw new NotFoundException('Creator not found');
    const tdsPaise = Math.round(input.amountPaise * TDS_RATE);
    const payout = await this.prisma.creatorPayout.create({
      data: { orgId: me.orgId, creatorId: creator.id, amountPaise: input.amountPaise, tdsPaise, netPaise: input.amountPaise - tdsPaise },
    });
    await this.audit.log(me, 'payout.created', 'CreatorPayout', payout.id, undefined, { creatorId: creator.id, amountPaise: input.amountPaise, tdsPaise }, ip);
    return { id: payout.id };
  }

  async markPayoutPaid(me: Me, id: string, body: unknown, ip?: string) {
    assertFinanceWrite(me);
    const { ref } = parse(markPayoutPaidSchema, body);
    const p = await this.prisma.creatorPayout.findFirst({ where: { id, orgId: me.orgId } });
    if (!p) throw new NotFoundException('Payout not found');
    if (p.status === 'paid') {
      if (p.ref === ref) return { id };
      throw new BadRequestException('This payout is already marked paid');
    }
    await this.prisma.creatorPayout.update({ where: { id }, data: { status: 'paid', paidAt: new Date(), ref } });
    await this.audit.log(me, 'payout.paid', 'CreatorPayout', id, { status: p.status }, { status: 'paid', ref }, ip);
    // The brief is closed as paid and the creator sees it in their portal.
    if (p.briefId) await this.prisma.creatorBrief.updateMany({ where: { id: p.briefId, status: 'approved' }, data: { status: 'paid' } });
    const creator = await this.prisma.creator.findUnique({ where: { id: p.creatorId }, select: { userId: true } });
    if (creator) {
      // Goes through the org's notification templates like every other notice.
      const n = await applyNotificationTemplate(this.prisma, me.orgId, { kind: 'payout_paid', title: `Payout of ${formatINR(p.netPaise)} sent`, body: `${formatINR(p.tdsPaise)} TDS deducted. Reference ${ref}.`, link: '/creator/payouts' });
      if (n?.channels.includes('inApp')) await this.prisma.notification.create({ data: { orgId: me.orgId, userId: creator.userId, kind: n.kind, title: n.title, body: n.body, link: n.link } });
    }
    return { id };
  }

  // -------------------------------------------------------------------------
  // GST and accounting

  async gst(me: Me, month?: string): Promise<GstSummaryView> {
    assertFinanceRead(me);
    const { start, end, key } = monthRange(month);
    const [ledger, gst, notes] = await Promise.all([
      loadLedger(this.prisma, me.orgId, { createdAt: { gte: start, lt: end }, status: { notIn: ['draft', 'void'] } }),
      this.settings.get(me.orgId, 'gst'),
      this.prisma.creditNote.findMany({ where: { orgId: me.orgId, createdAt: { gte: start, lt: end } } }),
    ]);
    const rows = ledger
      .slice()
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((i) => ({
        id: i.id,
        number: i.number,
        date: isoDay(i.createdAt),
        client: i.clientOrg?.name ?? 'No client yet',
        gstin: i.clientOrg?.gstin ?? null,
        taxablePaise: i.subtotalPaise,
        gstPaise: i.gstPaise,
        totalPaise: i.totalPaise,
        status: i.displayStatus,
      }));
    return {
      month: key,
      monthLabel: monthLabel(start, true),
      ratePct: gst.ratePct,
      invoiceCount: rows.length,
      taxablePaise: rows.reduce((s, r) => s + r.taxablePaise, 0),
      gstPaise: rows.reduce((s, r) => s + r.gstPaise, 0),
      totalPaise: rows.reduce((s, r) => s + r.totalPaise, 0),
      creditNotes: { count: notes.length, taxablePaise: notes.reduce((s, n) => s + n.amountPaise, 0), gstPaise: notes.reduce((s, n) => s + n.gstPaise, 0) },
      rows,
    };
  }

  async gstCsv(me: Me, month?: string, ip?: string) {
    const view = await this.gst(me, month);
    const gst = await this.settings.get(me.orgId, 'gst');
    const header = ['Invoice number', 'Invoice date', 'Customer name', 'Customer GSTIN', 'Place of supply', 'SAC', 'Rate %', 'Taxable value', 'GST amount', 'Invoice value', 'Status'];
    const lines = view.rows.map((r) => [r.number, r.date, r.client, r.gstin ?? '', '', gst.sacCode, String(view.ratePct), rupees(r.taxablePaise), rupees(r.gstPaise), rupees(r.totalPaise), r.status]);
    await this.audit.log(me, 'finance.gst_exported', 'Organisation', me.orgId, undefined, { month: view.month, rows: lines.length }, ip);
    return { filename: `gstr1-invoices-${view.month}.csv`, body: toCsv([header, ...lines]) };
  }

  /** Tally-friendly voucher list: sales invoices, receipts and credit notes in a date range. */
  async exportCsv(me: Me, from?: string, to?: string, ip?: string, format = 'csv'): Promise<{ filename: string; body: string; contentType?: string }> {
    assertFinanceRead(me);
    if (!(ACCOUNTING_FORMATS as readonly string[]).includes(format)) throw new BadRequestException('Unknown export format');
    const day = /^\d{4}-\d{2}-\d{2}$/;
    if (!from || !to || !day.test(from) || !day.test(to)) throw new BadRequestException('Pick a start and end date');
    const start = new Date(`${from}T00:00:00+05:30`);
    const end = new Date(new Date(`${to}T00:00:00+05:30`).getTime() + 86_400_000);
    if (end <= start) throw new BadRequestException('The end date must be after the start date');
    const gst = await this.settings.get(me.orgId, 'gst');
    const ledger = await loadLedger(this.prisma, me.orgId, { status: { notIn: ['draft', 'void'] } });
    if (format !== 'csv') {
      const range = { start, end };
      const pos = new Map((await this.prisma.clientOrg.findMany({ where: { orgId: me.orgId }, select: { id: true, placeOfSupply: true } })).map((c) => [c.id, c.placeOfSupply]));
      await this.audit.log(me, 'finance.accounting_exported', 'Organisation', me.orgId, undefined, { from, to, format }, ip);
      if (format === 'tally_xml') return { filename: `bmu-tally-${from}-to-${to}.xml`, body: tallyXml(ledger, range, gst, pos, gst.legalName || 'BMU Marketing'), contentType: 'application/xml; charset=utf-8' };
      if (format === 'zoho_invoices') return { filename: `bmu-zoho-invoices-${from}-to-${to}.csv`, body: toCsv(zohoInvoiceRows(ledger, range, gst, pos)) };
      return { filename: `bmu-zoho-payments-${from}-to-${to}.csv`, body: toCsv(zohoPaymentRows(ledger, range)) };
    }
    type Row = { date: Date; cells: string[] };
    const out: Row[] = [];
    for (const i of ledger) {
      const party = i.clientOrg?.name ?? 'Unregistered customer';
      const gstin = i.clientOrg?.gstin ?? '';
      if (i.createdAt >= start && i.createdAt < end) {
        out.push({ date: i.createdAt, cells: [isoDay(i.createdAt), 'Sales', i.number, party, gstin, 'Sales - Services', rupees(i.subtotalPaise), String(gst.ratePct), rupees(i.gstPaise), rupees(i.totalPaise), '', '', `${kindNarration(i)}`] });
      }
      for (const p of i.payments) {
        if (p.at < start || p.at >= end) continue;
        out.push({ date: p.at, cells: [isoDay(p.at), 'Receipt', i.number, party, gstin, p.method === 'cash' ? 'Cash' : 'Bank', '', '', '', rupees(p.amountPaise), paymentMethodLabels[p.method] ?? p.method, p.ref ?? '', `Against invoice ${i.number}`] });
      }
      for (const n of i.creditNotes) {
        if (n.createdAt < start || n.createdAt >= end) continue;
        out.push({ date: n.createdAt, cells: [isoDay(n.createdAt), 'Credit Note', n.number, party, gstin, 'Sales - Services', rupees(n.amountPaise), String(gst.ratePct), rupees(n.gstPaise), rupees(n.totalPaise), '', i.number, n.reason] });
      }
    }
    out.sort((a, b) => a.date.getTime() - b.date.getTime());
    const header = ['Date', 'Voucher type', 'Voucher number', 'Party name', 'Party GSTIN', 'Ledger', 'Taxable value', 'GST rate %', 'GST amount', 'Amount', 'Payment mode', 'Reference', 'Narration'];
    await this.audit.log(me, 'finance.accounting_exported', 'Organisation', me.orgId, undefined, { from, to, rows: out.length }, ip);
    return { filename: `bmu-accounting-${from}-to-${to}.csv`, body: toCsv([header, ...out.map((r) => r.cells)]) };
  }

  private async userNames(ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map<string, string>();
    const users = await this.prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
    return new Map(users.map((u) => [u.id, u.name]));
  }
}

// ---------------------------------------------------------------------------

function creditable(i: LedgerInvoice) {
  return isBillable(i) ? Math.max(0, i.totalPaise - i.creditedPaise) : 0;
}

function paymentRow(p: { id: string; invoiceId: string; amountPaise: number; method: string; ref: string | null; at: Date }, invoiceNumber: string, client: string): PaymentRow {
  return { id: p.id, invoiceId: p.invoiceId, invoiceNumber, client, amountPaise: p.amountPaise, method: p.method, ref: p.ref, at: p.at.toISOString() };
}

function creditRow(
  n: { id: string; number: string; invoiceId: string; amountPaise: number; gstPaise: number; totalPaise: number; reason: string; createdById: string; createdAt: Date },
  invoiceNumber: string,
  client: string,
  users: Map<string, string>,
): CreditNoteRow {
  return {
    id: n.id,
    number: n.number,
    invoiceId: n.invoiceId,
    invoiceNumber,
    client,
    amountPaise: n.amountPaise,
    gstPaise: n.gstPaise,
    totalPaise: n.totalPaise,
    reason: n.reason,
    createdBy: users.get(n.createdById) ?? null,
    createdAt: n.createdAt.toISOString(),
  };
}

function monthRange(month?: string) {
  const now = new Date();
  if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new BadRequestException('Pick a month');
  const start = month ? new Date(`${month}-01T00:00:00+05:30`) : startOfMonth(now);
  const end = startOfMonth(start, 1);
  return { start, end, key: month ?? `${isoDay(start).slice(0, 7)}` };
}

const rupees = (paise: number) => (paise / 100).toFixed(2);
const kindNarration = (i: LedgerInvoice) => (i.engagement ? `${i.engagement.service.name} (${i.kind.replace(/_/g, ' ')})` : i.kind.replace(/_/g, ' '));

function toCsv(rows: string[][]) {
  const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
