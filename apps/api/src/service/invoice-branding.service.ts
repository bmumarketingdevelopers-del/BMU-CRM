// v27: the Founder's signature and the company seal on invoices. Founders upload them (and change them whenever they
// want) in Command Centre → Finance → GST & invoices; every invoice then shows them above "Authorised signatory".
// Stored in Organisation.settings.v8.invoiceBranding; the images are ordinary stored files.
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { INVOICE_IMAGE_MAX_BYTES, INVOICE_IMAGE_TYPES, invoiceBrandingSchema, type InvoiceBrandingKind, type InvoiceBrandingView, type Me } from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { parse } from '../common/zod.js';
import { relPath, sha256, type OpsUpload } from '../ops-actions/ops-util.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { sendStoredFile } from '../storage/file-store.js';

export type InvoiceBranding = {
  signatoryName: string;
  designation: string;
  signatureFileId: string | null;
  sealFileId: string | null;
  updatedAt: string | null;
};

const EMPTY: InvoiceBranding = { signatoryName: '', designation: 'Founder', signatureFileId: null, sealFileId: null, updatedAt: null };

/** Reads the branding straight from the organisation settings (used by the tax invoice builder too). */
export async function readInvoiceBranding(prisma: PrismaService, orgId: string): Promise<InvoiceBranding> {
  const org = await prisma.organisation.findUnique({ where: { id: orgId }, select: { settings: true } });
  const v8 = ((org?.settings as Record<string, unknown> | null)?.v8 ?? {}) as Record<string, unknown>;
  return { ...EMPTY, ...(v8.invoiceBranding as Partial<InvoiceBranding> | undefined) };
}

/** Image links the invoice uses (the version in the link makes a changed signature show at once). */
export const invoiceBrandingUrl = (kind: InvoiceBrandingKind, fileId: string) => `/api/invoice-branding/${kind}?v=${fileId}`;

@Injectable()
export class InvoiceBrandingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private canEdit(me: Me) {
    return me.type === 'staff' && me.roles.includes('founder');
  }

  private assertEdit(me: Me) {
    if (!this.canEdit(me)) throw new ForbiddenException('Only a Founder can change the signature and seal on invoices');
  }

  private async write(me: Me, next: InvoiceBranding) {
    const org = await this.prisma.organisation.findUniqueOrThrow({ where: { id: me.orgId }, select: { settings: true } });
    const settings = (org.settings as Record<string, unknown> | null) ?? {};
    const v8 = (settings.v8 as Record<string, unknown> | undefined) ?? {};
    const value = { ...settings, v8: { ...v8, invoiceBranding: { ...next, updatedAt: new Date().toISOString() } } };
    await this.prisma.organisation.update({ where: { id: me.orgId }, data: { settings: value as Prisma.InputJsonValue } });
  }

  async view(me: Me): Promise<InvoiceBrandingView> {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    const b = await readInvoiceBranding(this.prisma, me.orgId);
    const files = await this.prisma.file.findMany({ where: { id: { in: [b.signatureFileId, b.sealFileId].filter((x): x is string => !!x) } }, select: { id: true, name: true, createdAt: true } });
    const one = (kind: InvoiceBrandingKind, id: string | null) => {
      const f = id ? files.find((x) => x.id === id) : null;
      return f ? { url: invoiceBrandingUrl(kind, f.id), name: f.name ?? kind, updatedAt: f.createdAt.toISOString() } : null;
    };
    return { signatoryName: b.signatoryName, designation: b.designation, signature: one('signature', b.signatureFileId), seal: one('seal', b.sealFileId), canEdit: this.canEdit(me) };
  }

  async save(me: Me, body: unknown, ip?: string) {
    this.assertEdit(me);
    const input = parse(invoiceBrandingSchema, body);
    const before = await readInvoiceBranding(this.prisma, me.orgId);
    await this.write(me, { ...before, signatoryName: input.signatoryName, designation: input.designation || 'Founder' });
    await this.audit.log(me, 'invoice_branding.updated', 'Organisation', me.orgId, { signatoryName: before.signatoryName, designation: before.designation }, input, ip);
    return this.view(me);
  }

  async upload(me: Me, kind: InvoiceBrandingKind, file: OpsUpload | undefined, ip?: string) {
    this.assertEdit(me);
    if (!file) throw new BadRequestException(`Choose the ${kind} image`);
    if (!INVOICE_IMAGE_TYPES.includes(file.mimetype)) throw new BadRequestException('Upload a PNG, JPG or WebP image (PNG with a transparent background looks best)');
    if (file.size > INVOICE_IMAGE_MAX_BYTES) throw new BadRequestException('The image must be 2 MB or smaller');
    const f = await this.prisma.file.create({
      data: { orgId: me.orgId, path: relPath(file.path), kind: 'image', name: file.originalname.slice(0, 200), mimeType: file.mimetype, sizeBytes: file.size, checksum: await sha256(file.path), folder: 'general', tags: [`invoice-${kind}`], uploadedById: me.id },
    });
    const before = await readInvoiceBranding(this.prisma, me.orgId);
    await this.write(me, { ...before, ...(kind === 'signature' ? { signatureFileId: f.id } : { sealFileId: f.id }) });
    await this.audit.log(me, `invoice_branding.${kind}_uploaded`, 'File', f.id, { fileId: kind === 'signature' ? before.signatureFileId : before.sealFileId }, { fileId: f.id, name: f.name }, ip);
    return this.view(me);
  }

  async remove(me: Me, kind: InvoiceBrandingKind, ip?: string) {
    this.assertEdit(me);
    const before = await readInvoiceBranding(this.prisma, me.orgId);
    await this.write(me, { ...before, ...(kind === 'signature' ? { signatureFileId: null } : { sealFileId: null }) });
    await this.audit.log(me, `invoice_branding.${kind}_removed`, 'Organisation', me.orgId, { fileId: kind === 'signature' ? before.signatureFileId : before.sealFileId }, null, ip);
    return this.view(me);
  }

  /** The image for any signed-in person of the organisation (clients see it on their invoices). */
  async image(me: Me, kind: InvoiceBrandingKind, res: Response) {
    const b = await readInvoiceBranding(this.prisma, me.orgId);
    const id = kind === 'signature' ? b.signatureFileId : b.sealFileId;
    const f = id ? await this.prisma.file.findFirst({ where: { id, orgId: me.orgId } }) : null;
    if (!f) throw new NotFoundException(`No ${kind} uploaded yet`);
    return sendStoredFile(res, f, { disposition: 'inline', cache: 'private, max-age=86400' });
  }
}
