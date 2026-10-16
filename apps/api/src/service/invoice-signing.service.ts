// v28: adding the company seal and the Founder's signature to an invoice needs the signing password. Whoever handles
// invoices (Founder now; Branch Manager or Finance later) enters it; only then is a held invoice delivered to the
// client. Every wrong password is logged; from the third wrong try in 30 minutes the Founders are alerted in the app
// (WhatsApp and email alerts come later). There is no lock-out.
// v29: a Client Manager signs invoices of their own clients with their own signature and their own signing password
// ("Client Manager" under it, with the company seal). Each signed invoice keeps what was printed.
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { formatINR, invoiceSignSchema, type InvoiceSignResult, type Me } from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { parse } from '../common/zod.js';
import { canWriteFinance } from '../insights/access.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { cmDesignation, cmOwnsClient, checkProfilePassword } from './cm-signing.service.js';
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
    const { password } = parse(invoiceSignSchema, body);
    const inv = await this.prisma.invoice.findFirst({ where: { id, orgId: me.orgId }, include: { clientOrg: { select: { name: true } } } });
    if (!inv) throw new NotFoundException('Invoice not found');
    // Founder / Branch Manager / Finance sign with the company password and the Founder's signature; a Client Manager
    // signs their own clients' invoices with their own password and signature.
    const asCompany = canWriteFinance(me);
    const asCm = !asCompany && (await cmOwnsClient(this.prisma, me, inv.clientOrgId));
    if (!asCompany && !asCm) throw new ForbiddenException("Only the people who handle invoices, or the client's Client Manager, can sign it");
    if (inv.status === 'void') throw new BadRequestException('This invoice was cancelled');
    if (inv.signedAt) throw new BadRequestException(`Invoice ${inv.number} is already signed`);
    const b = await readInvoiceBranding(this.prisma, me.orgId);
    if (!b.sealFileId) throw new BadRequestException('A Founder has not uploaded the company seal yet (Command Centre → Finance → GST & Invoice Settings)');
    const profile = asCm ? await this.prisma.signingProfile.findUnique({ where: { userId: me.id } }) : null;
    if (asCompany) {
      if (!b.passwordHash) throw new BadRequestException('A Founder has not set the signing password yet (Command Centre → Finance → GST & Invoice Settings)');
      if (!b.signatureFileId) throw new BadRequestException("Upload the Founder's signature first (Command Centre → Finance → GST & Invoice Settings)");
    } else {
      if (!profile?.passwordHash) throw new BadRequestException('Set your signing password first (Invoices → My signature)');
      if (!profile.signatureFileId) throw new BadRequestException('Upload your signature first (Invoices → My signature)');
    }

    const ok = asCompany ? checkSigningPassword(b, password) : checkProfilePassword(profile!, password);
    if (!ok) {
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

    // What is printed is kept on the invoice: a later change of signature never alters a signed invoice.
    const founderName = b.signatoryName || (await this.prisma.user.findFirst({ where: { orgId: me.orgId, type: 'staff', deletedAt: null, roles: { some: { role: { baseRole: 'founder' } } }, NOT: { name: { equals: 'BMU Owner', mode: 'insensitive' } } }, orderBy: { createdAt: 'asc' }, select: { name: true } }))?.name || '';
    const printed = asCompany
      ? { signedRole: 'founder', signatureFileId: b.signatureFileId, signatoryName: founderName, signatoryDesignation: b.designation || 'Founder' }
      : { signedRole: 'client_manager', signatureFileId: profile!.signatureFileId, signatoryName: me.name, signatoryDesignation: cmDesignation(me) };
    await this.prisma.invoice.update({ where: { id: inv.id }, data: { signedAt: new Date(), signedById: me.id, deliveryHeldAt: null, sealFileId: b.sealFileId, ...printed } });
    await this.audit.log(me, 'invoice.signed', 'Invoice', inv.id, { signedAt: null }, { number: inv.number, delivered: !!inv.deliveryHeldAt, as: printed.signedRole }, ip);
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
