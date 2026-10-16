import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { financialYear, formatINR, type Me } from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PaymentsService } from '../proposals/payments.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { InvoiceEvents, type PaidHandler } from '../service/invoice-events.js';
import { clientVisibleInvoiceWhere, readInvoiceBranding } from '../service/invoice-branding.service.js';

type Tx = Prisma.TransactionClient;
export type InvoiceLine = { label: string; amountPaise: number };
export type { PaidHandler };

export type IssueInvoiceInput = { orgId: string; clientOrgId: string; engagementId?: string; requestId?: string; kind: string; lines: InvoiceLine[]; dueInDays?: number; period?: string };

/** Creates an issued invoice inside a transaction. GST at the organisation rate (default 18%), shown as its own line. */
export async function issueInvoiceTx(tx: Tx, input: IssueInvoiceInput, gst?: { ratePct: number; invoicePrefix: string }) {
  const fy = financialYear(new Date());
  const prefix = gst?.invoicePrefix?.trim() || 'BMU';
  const rate = gst?.ratePct ?? 18;
  // Numbers are unique per org; count all of this FY's invoices (any prefix) so a renamed prefix never collides.
  const existing = await tx.invoice.findMany({ where: { orgId: input.orgId, number: { contains: `/${fy}/` } }, select: { number: true } });
  const seq = existing.reduce((m, i) => Math.max(m, Number(i.number.split('/').at(-1)) || 0), 0) + 1;
  const subtotal = input.lines.reduce((s, l) => s + l.amountPaise, 0);
  const gstPaise = Math.round((subtotal * rate) / 100);
  return tx.invoice.create({
    data: {
      orgId: input.orgId,
      clientOrgId: input.clientOrgId,
      engagementId: input.engagementId,
      requestId: input.requestId,
      kind: input.kind,
      period: input.period,
      number: `${prefix}/${fy}/${String(seq).padStart(4, '0')}`,
      lines: [...input.lines, { label: `GST ${rate}%`, amountPaise: gstPaise }],
      subtotalPaise: subtotal,
      gstPaise,
      totalPaise: subtotal + gstPaise,
      dueDate: new Date(Date.now() + (input.dueInDays ?? 7) * 86_400_000),
      status: 'issued',
    },
  });
}

/** Invoices after the first payment: add-ons, project balances. GST 18% shown separately. */
@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly payments: PaymentsService,
    private readonly notifications: NotificationsService,
    private readonly events: InvoiceEvents,
    private readonly settings: SettingsService,
  ) {}

  /** Other services react to payments (add-on → tasks, balance → Gate 5). Fires for online AND manual payments. */
  onPaid(handler: PaidHandler) {
    this.events.onPaid(handler);
  }

  async issue(tx: Tx, input: IssueInvoiceInput) {
    return issueInvoiceTx(tx, input, await this.settings.get(input.orgId, 'gst'));
  }

  private async clientInvoice(me: Me, id: string) {
    if (!me.clientOrg) throw new ForbiddenException('Client accounts only');
    if ((me.permissions.invoices_payments?.scope ?? 'none') === 'none') throw new ForbiddenException('Billing is not part of your access');
    // v28: an invoice still waiting for the seal and signature cannot be seen or paid yet.
    const inv = await this.prisma.invoice.findFirst({ where: { id, clientOrgId: me.clientOrg.id, ...clientVisibleInvoiceWhere(await readInvoiceBranding(this.prisma, me.orgId)) }, include: { payments: true } });
    if (!inv) throw new NotFoundException('Invoice not found');
    const credited = (await this.prisma.creditNote.aggregate({ where: { invoiceId: id }, _sum: { totalPaise: true } }))._sum.totalPaise ?? 0;
    const paid = inv.payments.reduce((s, p) => s + p.amountPaise, 0);
    return { ...inv, balancePaise: Math.max(0, inv.totalPaise - paid - credited) };
  }

  private assertPayable(inv: { status: string; balancePaise: number }) {
    if (inv.status === 'void') throw new BadRequestException('This invoice was cancelled');
    if (inv.status === 'draft') throw new BadRequestException('This invoice is not issued yet');
    if (inv.balancePaise <= 0 || inv.status === 'paid' || inv.status === 'credit_noted') throw new BadRequestException('Nothing is due on this invoice');
  }

  async checkout(me: Me, id: string) {
    const inv = await this.clientInvoice(me, id);
    if (inv.balancePaise <= 0 || inv.status === 'paid') return { mode: 'paid' as const };
    this.assertPayable(inv);
    if (this.payments.enabled) {
      // Charge only what is still owed (after part payments and credit notes).
      const order = await this.payments.createOrder(inv.balancePaise, inv.number);
      await this.prisma.invoice.update({ where: { id }, data: { razorpayRef: order.id } });
      return { mode: 'razorpay' as const, keyId: this.payments.keyId!, orderId: order.id, amountPaise: inv.balancePaise, invoiceNumber: inv.number, prefill: { name: me.name, email: me.email ?? undefined, contact: me.phone ?? undefined } };
    }
    return { mode: this.payments.testMode ? ('test' as const) : ('unavailable' as const) };
  }

  async verify(me: Me, id: string, body: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) {
    const inv = await this.clientInvoice(me, id);
    if (!this.payments.enabled || inv.razorpayRef !== body.razorpay_order_id || !this.payments.verifySignature(body.razorpay_order_id, body.razorpay_payment_id, body.razorpay_signature)) {
      throw new BadRequestException('Payment could not be verified');
    }
    // The order was created for the balance at checkout time; fetch the real captured amount from Razorpay.
    const amount = (await this.payments.orderAmount(body.razorpay_order_id)) ?? inv.balancePaise;
    await this.recordPayment(inv.id, amount, 'razorpay', body.razorpay_payment_id);
    return { ok: true };
  }

  async payTest(me: Me, id: string) {
    if (!this.payments.testMode) throw new ForbiddenException('Test payments are disabled');
    const inv = await this.clientInvoice(me, id);
    this.assertPayable(inv);
    await this.recordPayment(inv.id, inv.balancePaise, 'test', `test_${Date.now()}`);
    return { ok: true };
  }

  /** Idempotent per reference. Marks the invoice paid (counting credit notes) and runs follow-up automations. */
  async recordPayment(invoiceId: string, amountPaise: number, method: string, ref: string) {
    const inv = await this.prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { payments: true, clientOrg: { select: { name: true, amUserId: true } } } });
    if (inv.payments.some((p) => p.ref === ref)) return;
    const credited = (await this.prisma.creditNote.aggregate({ where: { invoiceId }, _sum: { totalPaise: true } }))._sum.totalPaise ?? 0;
    const paid = inv.payments.reduce((s, p) => s + p.amountPaise, 0) + amountPaise;
    const settled = paid + credited >= inv.totalPaise;
    await this.prisma.$transaction([
      this.prisma.payment.create({ data: { orgId: inv.orgId, invoiceId, amountPaise, method, ref } }),
      this.prisma.invoice.update({ where: { id: invoiceId }, data: { status: settled ? 'paid' : 'partially_paid' } }),
    ]);
    await this.audit.logSystem(inv.orgId, 'invoice.paid', 'Invoice', invoiceId, { amountPaise, method, settled });
    const finance = await this.prisma.user.findMany({ where: { orgId: inv.orgId, type: 'staff', status: 'active', deletedAt: null, roles: { some: { role: { baseRole: 'finance' } } } }, select: { id: true } });
    const notice = {
      kind: 'payment_received',
      title: `${inv.clientOrg?.name ?? 'A client'} paid ${formatINR(amountPaise)} on ${inv.number}`,
      body: settled ? 'The invoice is now fully paid.' : 'Part payment: some balance is still due.',
    };
    await this.notifications.notify(inv.orgId, finance.map((f) => f.id), { ...notice, link: `/admin/finance/invoices/${invoiceId}` });
    if (inv.clientOrgId) await this.notifications.notify(inv.orgId, [inv.clientOrg?.amUserId], { ...notice, link: `/team/clients/${inv.clientOrgId}` });
    if (settled) await this.events.paid(inv);
  }
}
