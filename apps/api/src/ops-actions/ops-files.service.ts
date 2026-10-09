// v11 ops: files & content. Team uploads (+ New → File upload, client and project pages), client uploads that land in
// "From client" and tick the matching onboarding item, move / rename / tag, release final files after Gate 5, archive
// and external share links with an expiry and optional password (public page checks both).
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { BadRequestException, ForbiddenException, GoneException, Injectable, NotFoundException, UnauthorizedException, type OnModuleInit } from '@nestjs/common';
import {
  fileKindFromMime,
  OPS_FILE_FOLDERS,
  OPS_FILE_MANAGER_ROLES,
  opsFileUpdateSchema,
  opsShareCreateSchema,
  type Me,
  type OpsFileFolder,
  type OpsFileList,
  type OpsFileRow,
  type OpsPublicShare,
  type OpsShareLinkView,
} from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { ActionsRegistry } from '../actions/registry.js';
import { AuditService } from '../audit/audit.service.js';
import { parse } from '../common/zod.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ATTACHMENT_KIND } from '../requests/messages.service.js';
import { appUrl } from '../service/email.service.js';
import { day, hasRole, isLeadership, lc, relPath, sha256, type OpsUpload } from './ops-util.js';

const fileInclude = { versions: { select: { id: true } } } as const;
type FileFull = Prisma.FileGetPayload<{ include: typeof fileInclude }>;
const SECRET = () => process.env.JWT_SECRET ?? 'dev-only-change-me';

const hashPassword = (pw: string) => {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pw, salt, 32).toString('hex')}`;
};
const checkPassword = (pw: string, stored: string) => {
  const [salt, hash] = stored.split(':');
  const a = Buffer.from(hash, 'hex');
  const b = scryptSync(pw, salt, 32);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Engagement has passed Gate 5: final sign-off given and no unpaid balance invoice. */
async function gate5Passed(prisma: PrismaService, e: { id: string; currentGate: string; finalSignedOffAt: Date | null; status: string }) {
  if (e.status === 'delivered') return true;
  if (e.currentGate !== 'G5' || !e.finalSignedOffAt) return false;
  const unpaid = await prisma.invoice.count({ where: { engagementId: e.id, kind: 'project_balance', status: { not: 'paid' } } });
  return unpaid === 0;
}

@Injectable()
export class OpsFilesService implements OnModuleInit {
  private readonly attempts = new Map<string, { n: number; until: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly registry: ActionsRegistry,
  ) {}

  onModuleInit() {
    this.registry.registerArchiveEntity({
      entity: 'file',
      model: 'file',
      auditEntity: 'File',
      assertCan: async (me, id) => {
        const f = await this.staffFile(me, id);
        if (!(await this.canEdit(me, f))) throw new ForbiddenException('Only the uploader, the Account Manager or a Department Head can archive this file');
      },
    });
  }

  // -------------------------------------------------------------------------
  // Scope

  /** Client ids a team member works on ('all' for leadership, department heads, finance). */
  private async clientScope(me: Me): Promise<'all' | string[]> {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    if (isLeadership(me) || hasRole(me, 'department_head', 'finance')) return 'all';
    const [clients, engs, tasks] = await Promise.all([
      this.prisma.clientOrg.findMany({ where: { orgId: me.orgId, amUserId: me.id }, select: { id: true } }),
      this.prisma.engagement.findMany({ where: { orgId: me.orgId, amId: me.id }, select: { clientOrgId: true } }),
      this.prisma.task.findMany({ where: { orgId: me.orgId, ownerId: me.id, engagementId: { not: null } }, select: { engagementId: true }, distinct: ['engagementId'] }),
    ]);
    const taskEngs = tasks.length ? await this.prisma.engagement.findMany({ where: { id: { in: tasks.map((t) => t.engagementId!) } }, select: { clientOrgId: true } }) : [];
    return [...new Set([...clients.map((c) => c.id), ...engs.map((e) => e.clientOrgId), ...taskEngs.map((e) => e.clientOrgId)])];
  }

  private async assertClient(me: Me, clientOrgId: string) {
    const scope = await this.clientScope(me);
    if (scope !== 'all' && !scope.includes(clientOrgId)) throw new ForbiddenException('You can only upload files for clients you work on');
    const c = await this.prisma.clientOrg.findFirst({ where: { id: clientOrgId, orgId: me.orgId, deletedAt: null } });
    if (!c) throw new BadRequestException('Pick a client');
    return c;
  }

  private async staffFile(me: Me, id: string) {
    const f = await this.prisma.file.findFirst({ where: { id, orgId: me.orgId, kind: { not: ATTACHMENT_KIND } }, include: fileInclude });
    if (!f) throw new NotFoundException('File not found');
    const scope = await this.clientScope(me);
    if (scope !== 'all' && f.uploadedById !== me.id && !(f.clientOrgId && scope.includes(f.clientOrgId))) throw new NotFoundException('File not found');
    return f;
  }

  private async amOf(clientOrgId: string | null, engagementId: string | null) {
    if (engagementId) {
      const e = await this.prisma.engagement.findUnique({ where: { id: engagementId }, select: { amId: true } });
      if (e?.amId) return e.amId;
    }
    if (!clientOrgId) return null;
    return (await this.prisma.clientOrg.findUnique({ where: { id: clientOrgId }, select: { amUserId: true } }))?.amUserId ?? null;
  }

  private async canEdit(me: Me, f: { uploadedById: string | null; clientOrgId: string | null; engagementId: string | null }) {
    if (f.uploadedById === me.id || isLeadership(me) || hasRole(me, 'department_head')) return true;
    return hasRole(me, 'account_manager') && (await this.amOf(f.clientOrgId, f.engagementId)) === me.id;
  }

  private async canManageClient(me: Me, f: { clientOrgId: string | null; engagementId: string | null }) {
    if (hasRole(me, 'founder', 'admin', 'am_lead')) return true;
    return hasRole(me, 'account_manager') && (await this.amOf(f.clientOrgId, f.engagementId)) === me.id;
  }

  private folderOf(f: FileFull): OpsFileFolder {
    if (f.folder !== 'general') return (OPS_FILE_FOLDERS as readonly string[]).includes(f.folder) ? (f.folder as OpsFileFolder) : 'general';
    if (f.tags.includes('brand')) return 'brand';
    if (f.versions.length) return f.released ? 'final' : 'working';
    if (f.clientOrgId && !f.uploadedById && !f.tags.length) return 'from_client';
    return 'general';
  }

  // -------------------------------------------------------------------------
  // List

  async list(me: Me, q: { clientOrgId?: string; engagementId?: string; folder?: string; archived?: string }): Promise<OpsFileList> {
    const scope = await this.clientScope(me);
    const where: Prisma.FileWhereInput = {
      orgId: me.orgId,
      kind: { not: ATTACHMENT_KIND },
      archivedAt: q.archived === '1' ? { not: null } : null,
      AND: [
        // Files that belong to a client (or were uploaded through ops); creator submissions and payment proofs stay where they are.
        { OR: [{ clientOrgId: { not: null } }, { uploadedById: { not: null } }] },
        { NOT: { tags: { has: 'payment-proof' } } },
        scope === 'all' ? {} : { OR: [{ clientOrgId: { in: scope } }, { uploadedById: me.id }] },
        q.clientOrgId ? { clientOrgId: q.clientOrgId } : {},
        q.engagementId ? { engagementId: q.engagementId } : {},
      ],
    };
    const rows = await this.prisma.file.findMany({ where, include: fileInclude, orderBy: { createdAt: 'desc' }, take: 500 });
    const clientIds = [...new Set(rows.map((r) => r.clientOrgId).filter((x): x is string => !!x))];
    const [clients, users, shares, scopeClients] = await Promise.all([
      this.prisma.clientOrg.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true, amUserId: true } }),
      this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.uploadedById).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
      this.prisma.opsShareLink.groupBy({ by: ['fileId'], where: { fileId: { in: rows.map((r) => r.id) }, revokedAt: null, expiresAt: { gt: new Date() } }, _count: true }),
      this.prisma.clientOrg.findMany({
        where: { orgId: me.orgId, deletedAt: null, archivedAt: null, ...(scope === 'all' ? {} : { id: { in: scope } }) },
        select: { id: true, name: true, engagements: { where: { deletedAt: null }, select: { id: true, currentGate: true, finalSignedOffAt: true, status: true, amId: true, service: { select: { name: true } } } } },
        orderBy: { name: 'asc' },
      }),
    ]);
    const engIds = [...new Set(rows.map((r) => r.engagementId).filter((x): x is string => !!x))];
    const engs = await this.prisma.engagement.findMany({ where: { id: { in: engIds } }, select: { id: true, currentGate: true, finalSignedOffAt: true, status: true, amId: true, clientOrgId: true, service: { select: { name: true } } } });
    const g5 = new Map<string, boolean>();
    for (const e of engs) g5.set(e.id, await gate5Passed(this.prisma, e));
    const leader = isLeadership(me);
    const head = hasRole(me, 'department_head');
    const isAm = hasRole(me, 'account_manager');
    const out: OpsFileRow[] = rows
      .filter((f) => !q.folder || this.folderOf(f) === q.folder)
      .map((f) => {
        const client = clients.find((c) => c.id === f.clientOrgId) ?? null;
        const eng = engs.find((e) => e.id === f.engagementId) ?? null;
        const amId = eng?.amId ?? client?.amUserId ?? null;
        const manages = hasRole(me, 'founder', 'admin', 'am_lead') || (isAm && amId === me.id);
        const folder = this.folderOf(f);
        const releaseBlockedReason =
          f.released ? null : folder !== 'final' ? 'Move it to Final files first' : !eng ? 'Link the file to a project first' : !g5.get(eng.id) ? `${eng.service.name} has not passed Gate 5 (final sign-off and balance paid)` : null;
        return {
          id: f.id,
          name: f.name ?? 'file',
          folder,
          kind: f.kind,
          mimeType: f.mimeType,
          sizeBytes: f.sizeBytes,
          tags: f.tags.filter((t) => t !== 'brand'),
          client: client ? { id: client.id, name: client.name } : null,
          engagement: eng ? { id: eng.id, name: eng.service.name } : null,
          uploadedBy: users.find((u) => u.id === f.uploadedById)?.name ?? (f.uploadedById ? 'Team' : f.clientOrgId && folder === 'from_client' ? 'Client' : null),
          createdAt: f.createdAt.toISOString(),
          released: f.released,
          archivedAt: f.archivedAt?.toISOString() ?? null,
          url: `/api/files/${f.id}`,
          shares: shares.find((s) => s.fileId === f.id)?._count ?? 0,
          can: {
            edit: f.uploadedById === me.id || leader || head || manages,
            release: manages && !f.released && !releaseBlockedReason,
            share: hasRole(me, 'founder', 'admin') || manages,
            archive: f.uploadedById === me.id || leader || head || manages,
          },
          releaseBlockedReason: manages ? releaseBlockedReason : f.released ? null : 'Only the Account Manager releases final files',
        };
      });
    return {
      rows: out,
      clients: scopeClients.map((c) => ({ id: c.id, name: c.name, engagements: c.engagements.map((e) => ({ id: e.id, name: e.service.name, gate: e.currentGate })) })),
    };
  }

  // -------------------------------------------------------------------------
  // Upload

  private parseTags(raw: unknown): string[] {
    const arr = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
    return [...new Set(arr.map((t) => String(t).trim().toLowerCase()).filter((t) => t && t.length <= 40))].slice(0, 20);
  }

  async upload(me: Me, file: OpsUpload | undefined, body: { clientOrgId?: string; engagementId?: string; folder?: string; tags?: unknown; name?: string }, ip?: string) {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    if (!file) throw new BadRequestException('Choose a file to upload');
    if (!body.clientOrgId) throw new BadRequestException('Pick the client the file is for');
    const client = await this.assertClient(me, body.clientOrgId);
    let engagementId: string | null = null;
    if (body.engagementId) {
      const e = await this.prisma.engagement.findFirst({ where: { id: body.engagementId, clientOrgId: client.id, deletedAt: null } });
      if (!e) throw new BadRequestException('That project does not belong to this client');
      engagementId = e.id;
    }
    const folder = (OPS_FILE_FOLDERS as readonly string[]).includes(body.folder ?? '') ? (body.folder as OpsFileFolder) : 'working';
    const tags = this.parseTags(body.tags);
    const f = await this.prisma.file.create({
      data: {
        orgId: me.orgId,
        clientOrgId: client.id,
        engagementId,
        path: relPath(file.path),
        kind: fileKindFromMime(file.mimetype),
        name: (body.name?.trim() || file.originalname).slice(0, 200),
        mimeType: file.mimetype,
        sizeBytes: file.size,
        checksum: await sha256(file.path),
        folder,
        tags: folder === 'brand' ? [...new Set([...tags, 'brand'])] : tags,
        uploadedById: me.id,
      },
    });
    await this.audit.log(me, 'file.uploaded', 'File', f.id, undefined, { name: f.name, clientOrgId: client.id, engagementId, folder, sizeBytes: f.sizeBytes }, ip);
    return { id: f.id, name: f.name, message: `${f.name} uploaded to ${client.name}` };
  }

  /** A client uploads into "From client"; tagging it with an onboarding item ticks that item. */
  async clientUpload(me: Me, file: OpsUpload | undefined, body: { engagementId?: string; requirementItemId?: string; tags?: unknown; note?: string }, ip?: string) {
    if (me.type !== 'client' || !me.clientOrg) throw new ForbiddenException('Client accounts only');
    if (!file) throw new BadRequestException('Choose a file to upload');
    const clientOrgId = me.clientOrg.id;
    let engagementId: string | null = null;
    if (body.engagementId) {
      const e = await this.prisma.engagement.findFirst({ where: { id: body.engagementId, clientOrgId, deletedAt: null } });
      if (!e) throw new BadRequestException('Pick one of your services');
      engagementId = e.id;
    }
    const tags = this.parseTags(body.tags);
    const f = await this.prisma.file.create({
      data: {
        orgId: me.orgId,
        clientOrgId,
        engagementId,
        path: relPath(file.path),
        kind: fileKindFromMime(file.mimetype),
        name: file.originalname.slice(0, 200),
        mimeType: file.mimetype,
        sizeBytes: file.size,
        checksum: await sha256(file.path),
        folder: 'from_client',
        tags,
        uploadedById: me.id,
      },
    });
    // Matching onboarding items: the one picked, or pending items whose label matches a tag.
    const pending = await this.prisma.requirementItem.findMany({
      where: { orgId: me.orgId, status: { in: ['pending', 'blocked', 'waiting'] }, cycle: { engagement: { clientOrgId, deletedAt: null, ...(engagementId ? { id: engagementId } : {}) } } },
      include: { cycle: { select: { engagementId: true } } },
    });
    const ticked = pending.filter((i) => i.id === body.requirementItemId || tags.some((t) => t.length >= 3 && (lc(i.label).includes(t) || t.includes(lc(i.label)))));
    if (body.requirementItemId && !ticked.some((i) => i.id === body.requirementItemId)) throw new BadRequestException('That checklist item is already done or not yours');
    for (const i of ticked) {
      await this.prisma.$transaction([
        this.prisma.requirementItem.update({ where: { id: i.id }, data: { status: 'received', waitingFor: null, blockedReason: null } }),
        this.prisma.comment.create({ data: { orgId: me.orgId, targetType: 'requirement', targetId: i.id, body: `${body.note ? `${body.note} · ` : ''}File: ${f.name} /api/files/${f.id}`, authorId: me.id } }),
      ]);
      await this.audit.log(me, 'requirement.received_by_upload', 'RequirementItem', i.id, { status: i.status }, { status: 'received', fileId: f.id }, ip);
    }
    if (ticked.length && !f.engagementId) await this.prisma.file.update({ where: { id: f.id }, data: { engagementId: ticked[0].cycle.engagementId } });
    await this.audit.log(me, 'file.uploaded_by_client', 'File', f.id, undefined, { name: f.name, clientOrgId, ticked: ticked.map((i) => i.label) }, ip);
    const am = await this.amOf(clientOrgId, engagementId ?? ticked[0]?.cycle.engagementId ?? null);
    await this.notifications.notify(me.orgId, [am], {
      kind: 'requirement_sent',
      title: `${me.clientOrg.name} uploaded ${f.name}`,
      body: ticked.length ? `Ticked: ${ticked.map((i) => i.label).join(', ')}. Check the file.` : 'It is in From client.',
      link: `/team/files?client=${clientOrgId}`,
    });
    return { id: f.id, name: f.name, ticked: ticked.map((i) => i.label), message: ticked.length ? `Uploaded. Ticked off: ${ticked.map((i) => i.label).join(', ')}` : 'Uploaded. Your account manager has been told.' };
  }

  /** The client's own uploads and the final files released to them by the team. */
  async clientList(me: Me) {
    if (me.type !== 'client' || !me.clientOrg) throw new ForbiddenException('Client accounts only');
    const rows = await this.prisma.file.findMany({
      where: { orgId: me.orgId, clientOrgId: me.clientOrg.id, archivedAt: null, uploadedById: { not: null }, OR: [{ folder: 'from_client' }, { folder: 'final', released: true }] },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    const items = await this.prisma.requirementItem.findMany({
      where: { orgId: me.orgId, status: { in: ['pending', 'blocked', 'waiting'] }, type: { in: ['asset', 'access', 'info'] }, cycle: { engagement: { clientOrgId: me.clientOrg.id, deletedAt: null } } },
      select: { id: true, label: true, cycle: { select: { engagement: { select: { id: true, service: { select: { name: true } } } } } } },
    });
    const engs = await this.prisma.engagement.findMany({ where: { clientOrgId: me.clientOrg.id, deletedAt: null }, select: { id: true, service: { select: { name: true } } } });
    return {
      uploads: rows.filter((f) => f.folder === 'from_client').map((f) => ({ id: f.id, name: f.name ?? 'file', tags: f.tags, sizeBytes: f.sizeBytes, at: f.createdAt.toISOString(), url: `/api/files/${f.id}` })),
      released: rows.filter((f) => f.folder === 'final').map((f) => ({ id: f.id, name: f.name ?? 'file', tags: f.tags, sizeBytes: f.sizeBytes, at: f.createdAt.toISOString(), url: `/api/files/${f.id}?download=1` })),
      openItems: items.map((i) => ({ id: i.id, label: i.label, service: i.cycle.engagement.service.name, engagementId: i.cycle.engagement.id })),
      services: engs.map((e) => ({ id: e.id, name: e.service.name })),
    };
  }

  /** Generic proof upload (payment slips, cheque photos) for Finance and Sales. Returns the file id. */
  async proof(me: Me, file: OpsUpload | undefined, ip?: string) {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    if (!file) throw new BadRequestException('Choose the proof file');
    if (!/^(image\/|application\/pdf)/.test(file.mimetype)) throw new BadRequestException('Upload a photo or PDF of the proof');
    const f = await this.prisma.file.create({
      data: { orgId: me.orgId, path: relPath(file.path), kind: fileKindFromMime(file.mimetype), name: file.originalname.slice(0, 200), mimeType: file.mimetype, sizeBytes: file.size, checksum: await sha256(file.path), folder: 'general', tags: ['payment-proof'], uploadedById: me.id },
    });
    await this.audit.log(me, 'file.proof_uploaded', 'File', f.id, undefined, { name: f.name }, ip);
    return { id: f.id, name: f.name ?? 'proof', url: `/api/files/${f.id}` };
  }

  // -------------------------------------------------------------------------
  // Move / rename / tag / release

  async update(me: Me, id: string, body: unknown, ip?: string) {
    const input = parse(opsFileUpdateSchema, body);
    const f = await this.staffFile(me, id);
    if (!(await this.canEdit(me, f))) throw new ForbiddenException('Only the uploader, the Account Manager or a Department Head can change this file');
    if (f.archivedAt) throw new BadRequestException('Restore the file first');
    if (f.released && input.folder && input.folder !== 'final') throw new BadRequestException('This file was released to the client. It stays in Final files.');
    let engagementId: string | null | undefined;
    if (input.engagementId !== undefined) {
      if (input.engagementId === null) engagementId = null;
      else {
        const e = await this.prisma.engagement.findFirst({ where: { id: input.engagementId, clientOrgId: f.clientOrgId ?? '', deletedAt: null } });
        if (!e) throw new BadRequestException('That project does not belong to this client');
        engagementId = e.id;
      }
    }
    const tags = input.tags ? [...new Set(input.tags.map((t) => t.toLowerCase()))] : undefined;
    const data: Prisma.FileUpdateInput = {
      ...(input.name ? { name: input.name } : {}),
      ...(input.folder ? { folder: input.folder } : {}),
      ...(tags ? { tags: input.folder === 'brand' || (f.tags.includes('brand') && input.folder === undefined) ? [...tags, 'brand'] : tags } : {}),
      ...(engagementId !== undefined ? { engagementId } : {}),
    };
    await this.prisma.file.update({ where: { id }, data });
    const before = { name: f.name, folder: this.folderOf(f), tags: f.tags, engagementId: f.engagementId };
    await this.audit.log(me, input.folder && input.folder !== before.folder ? 'file.moved' : input.name && input.name !== f.name ? 'file.renamed' : 'file.updated', 'File', id, before, input, ip);
    return { id, message: input.folder ? `Moved to ${input.folder.replace('_', ' ')}` : 'Saved' };
  }

  async release(me: Me, id: string, ip?: string) {
    const f = await this.staffFile(me, id);
    if (!(await this.canManageClient(me, f))) throw new ForbiddenException("Only the client's Account Manager can release final files");
    if (f.released) throw new BadRequestException('Already released');
    if (this.folderOf(f) !== 'final') throw new BadRequestException('Move the file to Final files before releasing it');
    if (!f.engagementId) throw new BadRequestException('Link the file to a project first');
    const e = await this.prisma.engagement.findUniqueOrThrow({ where: { id: f.engagementId }, include: { service: { select: { name: true } } } });
    if (!(await gate5Passed(this.prisma, e))) throw new BadRequestException(`${e.service.name} has not passed Gate 5 yet. Final files release after sign-off and the final payment.`);
    await this.prisma.file.update({ where: { id }, data: { released: true, folder: 'final' } });
    await this.audit.log(me, 'file.released', 'File', id, { released: false }, { released: true, engagementId: e.id }, ip);
    await this.notifications.notify(me.orgId, await this.notifications.clientDeciders(e.clientOrgId), { kind: 'final_delivery', title: `${e.service.name}: ${f.name} is ready to download`, link: '/client/files' });
    return { id, message: `${f.name} released to the client` };
  }

  // -------------------------------------------------------------------------
  // Share links

  private async assertShare(me: Me, id: string) {
    const f = await this.staffFile(me, id);
    if (!hasRole(me, 'founder', 'admin') && !(await this.canManageClient(me, f))) throw new ForbiddenException('Only the Account Manager or an Admin can share files outside BMU');
    if (f.archivedAt) throw new BadRequestException('Restore the file first');
    if (f.kind === 'link') throw new BadRequestException('This is already a link');
    return f;
  }

  private shareView(s: Prisma.OpsShareLinkGetPayload<object>, by: string): OpsShareLinkView {
    return { id: s.id, token: s.token, url: appUrl(`/s/${s.token}`), expiresAt: s.expiresAt.toISOString(), hasPassword: !!s.passwordHash, revoked: !!s.revokedAt, views: s.views, createdBy: by, createdAt: s.createdAt.toISOString() };
  }

  async shares(me: Me, fileId: string) {
    await this.assertShare(me, fileId);
    const rows = await this.prisma.opsShareLink.findMany({ where: { fileId }, orderBy: { createdAt: 'desc' } });
    const users = await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.createdById) } }, select: { id: true, name: true } });
    return rows.map((r) => this.shareView(r, users.find((u) => u.id === r.createdById)?.name ?? 'Team'));
  }

  async createShare(me: Me, fileId: string, body: unknown, ip?: string) {
    const input = parse(opsShareCreateSchema, body);
    const f = await this.assertShare(me, fileId);
    const token = randomBytes(18).toString('base64url');
    const expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000);
    const s = await this.prisma.opsShareLink.create({ data: { orgId: me.orgId, fileId, token, expiresAt, passwordHash: input.password ? hashPassword(input.password) : null, createdById: me.id } });
    await this.audit.log(me, 'file.share_link_created', 'File', fileId, undefined, { shareId: s.id, expiresAt, password: !!input.password, name: f.name }, ip);
    return { ...this.shareView(s, me.name), message: `Link ready. It stops working on ${day(expiresAt)}.` };
  }

  async revokeShare(me: Me, shareId: string, ip?: string) {
    const s = await this.prisma.opsShareLink.findFirst({ where: { id: shareId, orgId: me.orgId } });
    if (!s) throw new NotFoundException('Link not found');
    await this.assertShare(me, s.fileId);
    if (s.revokedAt) throw new BadRequestException('Already turned off');
    await this.prisma.opsShareLink.update({ where: { id: shareId }, data: { revokedAt: new Date() } });
    await this.audit.log(me, 'file.share_link_revoked', 'File', s.fileId, { shareId }, { revokedAt: new Date() }, ip);
    return { ok: true, message: 'Link turned off' };
  }

  // Public side ----------------------------------------------------------------

  private key(token: string, expiresAt: Date) {
    return createHmac('sha256', SECRET()).update(`share:${token}:${expiresAt.getTime()}`).digest('base64url').slice(0, 32);
  }

  private async liveShare(token: string) {
    const s = await this.prisma.opsShareLink.findUnique({ where: { token } });
    if (!s) throw new NotFoundException('This link does not exist');
    if (s.revokedAt) throw new GoneException('This link was turned off by BMU');
    if (s.expiresAt < new Date()) throw new GoneException(`This link expired on ${day(s.expiresAt)}`);
    const f = await this.prisma.file.findFirst({ where: { id: s.fileId, archivedAt: null } });
    if (!f) throw new GoneException('The file is no longer available');
    return { s, f };
  }

  async publicView(token: string): Promise<OpsPublicShare> {
    const { s, f } = await this.liveShare(token);
    await this.prisma.opsShareLink.update({ where: { id: s.id }, data: { views: { increment: 1 }, lastViewedAt: new Date() } });
    return {
      name: f.name ?? 'file',
      mimeType: f.mimeType,
      sizeBytes: f.sizeBytes,
      expiresAt: s.expiresAt.toISOString(),
      needsPassword: !!s.passwordHash,
      downloadUrl: s.passwordHash ? null : `/api/ops/public/share/${token}/file?k=${this.key(token, s.expiresAt)}`,
      from: 'BMU',
    };
  }

  async unlock(token: string, password: string | undefined, ip?: string) {
    const { s } = await this.liveShare(token);
    if (!s.passwordHash) return { downloadUrl: `/api/ops/public/share/${token}/file?k=${this.key(token, s.expiresAt)}` };
    const slot = `${token}:${ip ?? ''}`;
    const a = this.attempts.get(slot);
    if (a && a.n >= 8 && a.until > Date.now()) throw new UnauthorizedException('Too many wrong passwords. Try again in 15 minutes.');
    if (!password || !checkPassword(password, s.passwordHash)) {
      this.attempts.set(slot, { n: (a && a.until > Date.now() ? a.n : 0) + 1, until: Date.now() + 15 * 60_000 });
      throw new UnauthorizedException('Wrong password');
    }
    this.attempts.delete(slot);
    await this.audit.logSystem(s.orgId, 'file.share_link_opened', 'File', s.fileId, { shareId: s.id });
    return { downloadUrl: `/api/ops/public/share/${token}/file?k=${this.key(token, s.expiresAt)}` };
  }

  async publicFile(token: string, k: string | undefined) {
    const { s, f } = await this.liveShare(token);
    const want = this.key(token, s.expiresAt);
    if (!k || k.length !== want.length || !timingSafeEqual(Buffer.from(k), Buffer.from(want))) throw new UnauthorizedException(s.passwordHash ? 'Enter the password first' : 'Open the link again');
    return f;
  }
}
