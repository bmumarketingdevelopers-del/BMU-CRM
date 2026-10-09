import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  formatINR,
  invoiceKindLabels,
  serviceBillingDetailsSchema,
  type Me,
  type ServiceBillingDetails,
  type ServiceClientBilling,
  type ServiceTaxInvoice,
} from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { parse } from '../common/zod.js';
import { assertFinanceRead, assertFinanceWrite, canWriteFinance } from '../insights/access.js';
import { loadLedger } from '../insights/ledger.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PaymentsService } from '../proposals/payments.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { EmailService } from './email.service.js';
import { buildTaxInvoice, taxInvoiceEmailHtml, taxInvoiceEmailText } from './tax-invoice.js';

const BILLING_ROLES = ['client_owner', 'client_finance'];

/** Client billing page, client billing details, printable GST tax invoices and invoice emails. */
@Injectable()
export class ServiceBillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly payments: PaymentsService,
    private readonly email: EmailService,
  ) {}

  private clientOrgId(me: Me) {
    if (me.type !== 'client' || !me.clientOrg) throw new ForbiddenException('Client accounts only');
    if ((me.permissions.invoices_payments?.scope ?? 'none') === 'none') throw new ForbiddenException('Billing is not part of your access. Ask your account owner.');
    return me.clientOrg.id;
  }

  private async details(clientOrgId: string, canEdit: boolean): Promise<ServiceBillingDetails> {
    const c = await this.prisma.clientOrg.findUniqueOrThrow({ where: { id: clientOrgId } });
    return { name: c.name, legalName: c.legalName, gstin: c.gstin, billingAddress: c.billingAddress, placeOfSupply: c.placeOfSupply, billingEmail: c.billingEmail, canEdit };
  }

  async clientBilling(me: Me): Promise<ServiceClientBilling> {
    const clientOrgId = this.clientOrgId(me);
    const ledger = await loadLedger(this.prisma, me.orgId, { clientOrgId });
    const fyStart = (() => {
      const n = new Date();
      const y = n.getUTCMonth() >= 3 ? n.getUTCFullYear() : n.getUTCFullYear() - 1;
      return new Date(`${y}-04-01T00:00:00+05:30`);
    })();
    const invoices = ledger.map((i) => {
      const firstLine = ((i.lines as { label: string }[] | null) ?? [])[0]?.label;
      return {
        id: i.id,
        number: i.number,
        kind: i.kind,
        status: i.displayStatus,
        createdAt: i.createdAt.toISOString(),
        dueDate: i.dueDate.toISOString(),
        subtotalPaise: i.subtotalPaise,
        gstPaise: i.gstPaise,
        totalPaise: i.totalPaise,
        paidPaise: i.paidPaise,
        creditedPaise: i.creditedPaise,
        balancePaise: i.balancePaise,
        daysOverdue: i.daysOverdue,
        label: firstLine ?? invoiceKindLabels[i.kind] ?? i.kind,
      };
    });
    return {
      invoices,
      duePaise: invoices.reduce((s, i) => s + i.balancePaise, 0),
      overduePaise: invoices.filter((i) => i.status === 'overdue').reduce((s, i) => s + i.balancePaise, 0),
      paidThisYearPaise: ledger.flatMap((i) => i.payments).filter((p) => p.at >= fyStart).reduce((s, p) => s + p.amountPaise, 0),
      details: await this.details(clientOrgId, BILLING_ROLES.includes(me.clientOrg!.role)),
      online: this.payments.enabled ? 'razorpay' : this.payments.testMode ? 'test' : 'unavailable',
    };
  }

  async clientTaxInvoice(me: Me, id: string): Promise<ServiceTaxInvoice> {
    const clientOrgId = this.clientOrgId(me);
    const inv = await this.prisma.invoice.findFirst({ where: { id, clientOrgId, status: { not: 'draft' } }, select: { id: true } });
    if (!inv) throw new NotFoundException('Invoice not found');
    return (await buildTaxInvoice(this.prisma, this.settings, me.orgId, id, `/client/billing/${id}`))!;
  }

  async saveClientDetails(me: Me, body: unknown, ip?: string) {
    const clientOrgId = this.clientOrgId(me);
    if (!BILLING_ROLES.includes(me.clientOrg!.role)) throw new ForbiddenException('Only the account owner or your finance person can change billing details');
    return this.saveDetails(me, clientOrgId, body, ip);
  }

  private async saveDetails(me: Me, clientOrgId: string, body: unknown, ip?: string) {
    const input = parse(serviceBillingDetailsSchema, body);
    const before = await this.details(clientOrgId, true);
    const clean = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() ? v.trim() : null);
    const data = {
      legalName: clean(input.legalName),
      gstin: clean(input.gstin)?.toUpperCase() ?? (input.gstin === undefined ? undefined : null),
      billingAddress: clean(input.billingAddress),
      placeOfSupply: clean(input.placeOfSupply),
      billingEmail: clean(input.billingEmail),
    };
    // A GSTIN starts with the state code: default the place of supply from it.
    if (data.gstin && !data.placeOfSupply && !before.placeOfSupply) data.placeOfSupply = data.gstin.slice(0, 2);
    await this.prisma.clientOrg.update({ where: { id: clientOrgId }, data });
    await this.audit.log(me, 'client.billing_details_updated', 'ClientOrg', clientOrgId, before, data, ip);
    return this.details(clientOrgId, true);
  }

  // Finance side

  async financeTaxInvoice(me: Me, id: string) {
    assertFinanceRead(me);
    const t = await buildTaxInvoice(this.prisma, this.settings, me.orgId, id, `/client/billing/${id}`);
    if (!t) throw new NotFoundException('Invoice not found');
    return t;
  }

  async financeDetails(me: Me, clientOrgId: string) {
    assertFinanceRead(me);
    const c = await this.prisma.clientOrg.findFirst({ where: { id: clientOrgId, orgId: me.orgId } });
    if (!c) throw new NotFoundException('Client not found');
    return this.details(c.id, canWriteFinance(me));
  }

  async saveFinanceDetails(me: Me, clientOrgId: string, body: unknown, ip?: string) {
    assertFinanceWrite(me);
    const c = await this.prisma.clientOrg.findFirst({ where: { id: clientOrgId, orgId: me.orgId } });
    if (!c) throw new NotFoundException('Client not found');
    return this.saveDetails(me, c.id, body, ip);
  }

  /** Finance sends (or re-sends) the invoice email with the tax invoice inside. */
  async emailInvoice(me: Me, id: string, ip?: string) {
    assertFinanceWrite(me);
    const inv = await this.prisma.invoice.findFirst({ where: { id, orgId: me.orgId } });
    if (!inv) throw new NotFoundException('Invoice not found');
    if (!inv.clientOrgId) throw new BadRequestException('This invoice has no client account yet');
    if (inv.status === 'void') throw new BadRequestException('This invoice was cancelled');
    const sent = await this.invoiceIssued(id, { force: true });
    await this.audit.log(me, 'invoice.emailed', 'Invoice', id, undefined, { recipients: sent }, ip);
    return { sent };
  }

  /**
   * "Invoice issued" notice + email to the client's owner and finance people. Uses the notification template
   * for invoice_issued (email on by default) and each person's preferences. Returns how many people it went to.
   */
  async invoiceIssued(invoiceId: string, opts: { force?: boolean } = {}) {
    const inv = await this.prisma.invoice.findUnique({ where: { id: invoiceId }, include: { clientOrg: true } });
    if (!inv?.clientOrgId) return 0;
    const t = await buildTaxInvoice(this.prisma, this.settings, inv.orgId, inv.id, `/client/billing/${inv.id}`);
    if (!t) return 0;
    const people = await this.notifications.clientBilling(inv.clientOrgId);
    const emails = await this.prisma.user.findMany({ where: { id: { in: people } }, select: { email: true } });
    const extra = inv.clientOrg?.billingEmail && !emails.some((e) => e.email?.toLowerCase() === inv.clientOrg!.billingEmail!.toLowerCase()) ? inv.clientOrg.billingEmail : null;
    const mail = {
      subject: `Tax invoice ${inv.number} from ${t.seller.legalName}: ${formatINR(t.totalPaise)}`,
      heading: `Tax invoice ${inv.number}`,
      htmlBlock: taxInvoiceEmailHtml(t),
      textBlock: taxInvoiceEmailText(t),
      button: { label: t.balancePaise > 0 ? `View and pay ${formatINR(t.balancePaise)}` : 'View invoice', url: `/client/billing/${inv.id}` },
      entity: 'Invoice',
      entityId: inv.id,
    };
    if (extra) {
      const tpl = (await this.settings.get(inv.orgId, 'notificationTemplates')).invoice_issued;
      if (opts.force || tpl?.email !== false) await this.email.send({ orgId: inv.orgId, to: extra, toName: t.buyer.legalName, kind: 'invoice_issued', paragraphs: [`Please find invoice ${inv.number} below.`], ...mail });
    }
    await this.notifications.notify(inv.orgId, people, {
      kind: 'invoice_issued',
      title: `Invoice ${inv.number} for ${formatINR(t.totalPaise)}`,
      body: `Due ${new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'Asia/Kolkata' }).format(inv.dueDate)}. Pay online or by bank transfer / UPI.`,
      link: `/client/billing/${inv.id}`,
      forceEmail: opts.force,
      email: mail,
    });
    return people.length + (extra ? 1 : 0);
  }
}
