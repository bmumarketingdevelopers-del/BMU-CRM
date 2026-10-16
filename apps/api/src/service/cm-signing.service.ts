// v29: Client Managers create and sign invoices for their own clients (the CM Lead for every client) with their own
// signature and their own signing password. Founders keep the company signing password in Command Centre.
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import { INVOICE_IMAGE_MAX_BYTES, INVOICE_IMAGE_TYPES, invoiceSigningPasswordSchema, opsCanInvoiceAsCm, type CmInvoiceList, type CmInvoiceRow, type Me, type ServiceTaxInvoice, type SigningProfileView } from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { parse } from '../common/zod.js';
import { relPath, sha256, type OpsUpload } from '../ops-actions/ops-util.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { sendStoredFile } from '../storage/file-store.js';
import { invoiceHeld, readInvoiceBranding } from './invoice-branding.service.js';
import { buildTaxInvoice } from './tax-invoice.js';

const hash = (password: string, salt: string) => scryptSync(password, salt, 64).toString('hex');

/** Signature and seal images that invoices may show (by file id): only files uploaded for invoice signing. */
export const SIGNING_FILE_TAGS = ['invoice-signature', 'invoice-seal', 'cm-signature'];
export const signingFileUrl = (fileId: string) => `/api/invoice-branding/file/${fileId}`;

/** "Client Manager", or "Client Manager Lead" for the CM Lead. */
export const cmDesignation = (me: { roles: string[] }) => (me.roles.includes('am_lead') && !me.roles.includes('account_manager') ? 'Client Manager Lead' : 'Client Manager');

/** Clients a Client Manager may invoice: their own; the CM Lead every client. Null = not a Client Manager. */
export function cmClientWhere(me: Me): Prisma.ClientOrgWhereInput | null {
  if (!opsCanInvoiceAsCm(me)) return null;
  return me.roles.includes('am_lead') ? { orgId: me.orgId } : { orgId: me.orgId, amUserId: me.id };
}

export async function cmOwnsClient(prisma: PrismaService, me: Me, clientOrgId: string | null) {
  const where = cmClientWhere(me);
  if (!where || !clientOrgId) return false;
  return !!(await prisma.clientOrg.findFirst({ where: { ...where, id: clientOrgId }, select: { id: true } }));
}

export function checkProfilePassword(p: { passwordHash: string | null; passwordSalt: string | null }, password: string) {
  if (!p.passwordHash || !p.passwordSalt) return false;
  const a = Buffer.from(hash(password, p.passwordSalt), 'hex');
  const e = Buffer.from(p.passwordHash, 'hex');
  return a.length === e.length && timingSafeEqual(a, e);
}

@Injectable()
export class CmSigningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  private assertCm(me: Me) {
    if (!opsCanInvoiceAsCm(me)) throw new ForbiddenException('For Client Managers');
  }

  private async profile(me: Me) {
    return this.prisma.signingProfile.upsert({ where: { userId: me.id }, create: { orgId: me.orgId, userId: me.id }, update: {} });
  }

  async view(me: Me): Promise<SigningProfileView> {
    this.assertCm(me);
    const [p, b] = await Promise.all([this.profile(me), readInvoiceBranding(this.prisma, me.orgId)]);
    const f = p.signatureFileId ? await this.prisma.file.findUnique({ where: { id: p.signatureFileId }, select: { id: true, name: true, createdAt: true } }) : null;
    const signature = f ? { url: signingFileUrl(f.id), name: f.name ?? 'signature', updatedAt: f.createdAt.toISOString() } : null;
    return { name: me.name, designation: cmDesignation(me), signature, passwordSet: !!p.passwordHash, companySeal: !!b.sealFileId, ready: !!signature && !!p.passwordHash && !!b.sealFileId };
  }

  async uploadSignature(me: Me, file: OpsUpload | undefined, ip?: string) {
    this.assertCm(me);
    if (!file) throw new BadRequestException('Choose your signature image');
    if (!INVOICE_IMAGE_TYPES.includes(file.mimetype)) throw new BadRequestException('Upload a PNG, JPG or WebP image (PNG with a transparent background looks best)');
    if (file.size > INVOICE_IMAGE_MAX_BYTES) throw new BadRequestException('The image must be 2 MB or smaller');
    const f = await this.prisma.file.create({
      data: { orgId: me.orgId, path: relPath(file.path), kind: 'image', name: file.originalname.slice(0, 200), mimeType: file.mimetype, sizeBytes: file.size, checksum: await sha256(file.path), folder: 'general', tags: ['cm-signature'], uploadedById: me.id },
    });
    const before = await this.profile(me);
    await this.prisma.signingProfile.update({ where: { id: before.id }, data: { signatureFileId: f.id } });
    await this.audit.log(me, 'signing_profile.signature_uploaded', 'File', f.id, { fileId: before.signatureFileId }, { fileId: f.id }, ip);
    return this.view(me);
  }

  async removeSignature(me: Me, ip?: string) {
    this.assertCm(me);
    const p = await this.profile(me);
    await this.prisma.signingProfile.update({ where: { id: p.id }, data: { signatureFileId: null } });
    await this.audit.log(me, 'signing_profile.signature_removed', 'User', me.id, { fileId: p.signatureFileId }, null, ip);
    return this.view(me);
  }

  async setPassword(me: Me, body: unknown, ip?: string) {
    this.assertCm(me);
    const { password } = parse(invoiceSigningPasswordSchema, body);
    const p = await this.profile(me);
    const salt = randomBytes(16).toString('hex');
    await this.prisma.signingProfile.update({ where: { id: p.id }, data: { passwordHash: hash(password, salt), passwordSalt: salt, passwordSetAt: new Date() } });
    await this.audit.log(me, p.passwordHash ? 'signing_profile.password_changed' : 'signing_profile.password_set', 'User', me.id, null, null, ip);
    return this.view(me);
  }

  /** The invoices of the Client Manager's clients: those waiting for a signature, and the latest ones. */
  async invoices(me: Me): Promise<CmInvoiceList> {
    const where = cmClientWhere(me);
    if (!where) throw new ForbiddenException('For Client Managers');
    const b = await readInvoiceBranding(this.prisma, me.orgId);
    const rows = await this.prisma.invoice.findMany({
      where: { orgId: me.orgId, clientOrg: where, status: { not: 'void' } },
      include: { clientOrg: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 150,
    });
    const signers = await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.signedById).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
    const view = (i: (typeof rows)[number]): CmInvoiceRow => ({
      id: i.id,
      number: i.number,
      client: i.clientOrg?.name ?? 'Client',
      kind: i.kind,
      status: i.status,
      totalPaise: i.totalPaise,
      dueDate: i.dueDate.toISOString(),
      createdAt: i.createdAt.toISOString(),
      signed: !!i.signedAt,
      signedBy: signers.find((s) => s.id === i.signedById)?.name ?? null,
      held: i.status !== 'draft' && invoiceHeld(b, i),
    });
    const all = rows.map(view);
    return { waiting: all.filter((r) => r.held), recent: all.filter((r) => !r.held).slice(0, 40), requireSignature: b.requireSignature };
  }

  async taxInvoice(me: Me, id: string): Promise<ServiceTaxInvoice> {
    const where = cmClientWhere(me);
    if (!where) throw new ForbiddenException('For Client Managers');
    const inv = await this.prisma.invoice.findFirst({ where: { id, orgId: me.orgId, clientOrg: where } });
    if (!inv) throw new NotFoundException('Invoice not found');
    const t = (await buildTaxInvoice(this.prisma, this.settings, me.orgId, id, `/client/billing/${id}`))!;
    const ready = (await this.view(me)).ready;
    t.signing.canSign = ready && !t.signing.signed && t.status !== 'void';
    return t;
  }

  /** A signature or seal image printed on a signed invoice, for any signed-in person of the organisation. */
  async file(me: Me, fileId: string, res: Response) {
    const f = await this.prisma.file.findFirst({ where: { id: fileId, orgId: me.orgId, tags: { hasSome: SIGNING_FILE_TAGS } } });
    if (!f) throw new NotFoundException('Image not found');
    return sendStoredFile(res, f, { disposition: 'inline', cache: 'private, max-age=86400' });
  }
}
