// v28: adding the company seal and the Founder's signature to an invoice needs the signing password. Whoever handles
// invoices (Founder now; Branch Manager or Finance later) enters it; only then is a held invoice delivered to the
// client. Every wrong password is logged; from the third wrong try in 30 minutes the Founders are alerted in the app
// (WhatsApp and email alerts come later). There is no lock-out.
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { formatINR, invoiceSignSchema, type InvoiceSignResult, type Me } from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { parse } from '../common/zod.js';
import { canWriteFinance } from '../insights/access.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { checkSigningPassword, readInvoiceBranding } from './invoice-branding.service.js';
import { ServiceBillingService } from './service-billing.service.js';

const WINDOW_MS = 30 * 60_000;
const ALERT_AFTER = 3;

@Injectable()
export class InvoiceSigningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly billing: ServiceBillingService,
  ) {}

  private founders(orgId: string) {
    return this.prisma.user.findMany({ where: { orgId, type: 'staff', deletedAt: null, status: { not: 'suspended' }, roles: { some: { role: { baseRole: 'founder' } } } }, select: { id: true } }).then((r) => r.map((u) => u.id));
  }

  async sign(me: Me, id: string, body: unknown, ip?: string): Promise<InvoiceSignResult> {
    if (!canWriteFinance(me)) throw new ForbiddenException('Only the people who handle invoices can sign them');
    const { password } = parse(invoiceSignSchema, body);
    const inv = await this.prisma.invoice.findFirst({ where: { id, orgId: me.orgId }, include: { clientOrg: { select: { name: true } } } });
    if (!inv) throw new NotFoundException('Invoice not found');
    if (inv.status === 'void') throw new BadRequestException('This invoice was cancelled');
    if (inv.signedAt) throw new BadRequestException(`Invoice ${inv.number} is already signed`);
    const b = await readInvoiceBranding(this.prisma, me.orgId);
    if (!b.passwordHash) throw new BadRequestException('A Founder has not set the signing password yet (Command Centre → Finance → GST & Invoice Settings)');
    if (!b.signatureFileId || !b.sealFileId) throw new BadRequestException('Upload the signature and the company seal first (Command Centre → Finance → GST & Invoice Settings)');

    if (!checkSigningPassword(b, password)) {
      await this.audit.log(me, 'invoice.sign_failed', 'Invoice', inv.id, null, { number: inv.number }, ip);
      const fails = await this.prisma.auditEvent.count({ where: { orgId: me.orgId, actorId: me.id, action: 'invoice.sign_failed', at: { gte: new Date(Date.now() - WINDOW_MS) } } });
      if (fails >= ALERT_AFTER) {
        await this.notifications.notify(me.orgId, await this.founders(me.orgId), {
          kind: 'security',
          title: `Signing password entered wrongly ${fails} times`,
          body: `${me.name} entered a wrong signing password ${fails} times in the last 30 minutes, last on invoice ${inv.number} (${inv.clientOrg?.name ?? 'no client'}). If this was not expected, change the signing password in GST & Invoice Settings.`,
          link: '/admin/finance/gst',
          critical: true,
        });
      }
      throw new ForbiddenException(fails >= ALERT_AFTER ? 'Wrong signing password. The Founders have been alerted.' : 'Wrong signing password');
    }

    await this.prisma.invoice.update({ where: { id: inv.id }, data: { signedAt: new Date(), signedById: me.id, deliveryHeldAt: null } });
    await this.audit.log(me, 'invoice.signed', 'Invoice', inv.id, { signedAt: null }, { number: inv.number, delivered: !!inv.deliveryHeldAt }, ip);
    // A held invoice goes to the client now, with the seal and signature.
    const deliver = !!inv.deliveryHeldAt && inv.status !== 'draft';
    const sent = deliver ? await this.billing.invoiceIssued(inv.id) : 0;
    return {
      signed: true,
      number: inv.number,
      delivered: deliver,
      message: deliver
        ? `Invoice ${inv.number} signed and sent to ${inv.clientOrg?.name ?? 'the client'} (${formatINR(inv.totalPaise)}${sent ? `, ${sent} recipient${sent === 1 ? '' : 's'}` : ''}).`
        : `Invoice ${inv.number} signed. The seal and signature are on it.`,
    };
  }
}
