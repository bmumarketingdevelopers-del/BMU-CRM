// v16 asset library: every image, video, design, document and link, by client, collection (campaign) and tags, with
// versions, usage rights and resumable uploads up to 5 GB. Files stay on the API's disk (STORAGE_DIR); approved work
// lands here automatically. Share links reuse the Files share links (expiry and password).
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import { rename, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  ASSET_CHUNK_BYTES,
  assetCollectionInputSchema,
  assetLinkSchema,
  assetUpdateSchema,
  fileKindFromMime,
  uploadStartSchema,
  type AssetCollectionView,
  type AssetDetail,
  type AssetFileView,
  type AssetList,
  type AssetQuery,
  type AssetRightsState,
  type AssetRow,
  type AssetSource,
  type FileKind,
  type Me,
  type UploadSessionView,
} from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { AiService } from '../ai/ai.service.js';
import { AuditService } from '../audit/audit.service.js';
import { parse } from '../common/zod.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { storageRoot } from '../production/production.controller.js';
import { amOf, clientScope, hasRole, inScope, isLeadership } from './scope.js';
import { localFile, putFile, relPathOf } from '../storage/file-store.js';
import { uploaderDepartment } from '../ops-actions/file-access.js';

const DAY = 86_400_000;
const include = { collection: { select: { id: true, name: true } }, versions: { orderBy: { number: 'asc' } } } satisfies Prisma.AssetInclude;
type AssetFull = Prisma.AssetGetPayload<{ include: typeof include }>;
type FileRow = { id: string; kind: string; name: string | null; mimeType: string | null; sizeBytes: number | null; path: string; checksum: string | null };
type Lookups = { files: Map<string, FileRow>; users: Map<string, string>; clients: Map<string, string>; creators: Map<string, string> };

/** Images up to this size are sent to the AI for tags (the API limit is 5 MB of base64). */
const AI_IMAGE_MAX = 3_700_000;
const AI_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

export const tmpDir = () => join(storageRoot(), 'tmp-uploads');

export function rightsState(expiresAt: Date | null, note: string | null, now = new Date()): AssetRightsState {
  if (!expiresAt) return note ? 'ok' : 'none';
  if (expiresAt.getTime() < now.getTime()) return 'expired';
  if (expiresAt.getTime() < now.getTime() + 30 * DAY) return 'expiring';
  return 'ok';
}

/** Streams a file through SHA-256 (for version checks and approval certificates). */
export const sha256File = (abs: string) =>
  new Promise<string>((ok, fail) => {
    const h = createHash('sha256');
    createReadStream(abs)
      .on('data', (c) => h.update(c))
      .on('end', () => ok(h.digest('hex')))
      .on('error', fail);
  });

@Injectable()
export class AssetsService {
  private readonly log = new Logger('Assets');
  /** Upload sessions with a piece being written right now (one at a time per upload). */
  private writing = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ai: AiService,
  ) {}

  // ------------------------------------------------------------------------------------------------ views

  private async lookups(assets: AssetFull[]): Promise<Lookups> {
    const fileIds = [...new Set(assets.flatMap((a) => a.versions.map((v) => v.fileId)))];
    const userIds = [...new Set(assets.flatMap((a) => [a.createdById, ...a.versions.map((v) => v.uploadedById)]))];
    const clientIds = [...new Set(assets.map((a) => a.clientOrgId).filter((x): x is string => !!x))];
    const creatorIds = [...new Set(assets.map((a) => a.creatorId).filter((x): x is string => !!x))];
    const [files, users, clients, creators] = await Promise.all([
      this.prisma.file.findMany({ where: { id: { in: fileIds } }, select: { id: true, kind: true, name: true, mimeType: true, sizeBytes: true, path: true, checksum: true } }),
      this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }),
      this.prisma.clientOrg.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true } }),
      this.prisma.creator.findMany({ where: { id: { in: creatorIds } }, select: { id: true, user: { select: { name: true } } } }),
    ]);
    return {
      files: new Map(files.map((f) => [f.id, f])),
      users: new Map(users.map((u) => [u.id, u.name])),
      clients: new Map(clients.map((c) => [c.id, c.name])),
      creators: new Map(creators.map((c) => [c.id, c.user.name])),
    };
  }

  private fileView(v: AssetFull['versions'][number], l: Lookups, client: boolean): AssetFileView {
    const f = l.files.get(v.fileId);
    const kind = (f?.kind ?? 'other') as FileKind;
    return {
      id: v.id,
      number: v.number,
      kind,
      name: f?.name ?? null,
      mimeType: f?.mimeType ?? null,
      sizeBytes: f?.sizeBytes ?? null,
      url: kind === 'link' ? (f?.path ?? '') : `/api/files/${v.fileId}`,
      note: v.note,
      uploadedBy: client ? 'BMU team' : (l.users.get(v.uploadedById) ?? 'Team'),
      at: v.createdAt.toISOString(),
    };
  }

  private toRow(a: AssetFull, l: Lookups, client = false): AssetRow {
    const current = a.versions.find((v) => v.id === a.currentVersionId) ?? a.versions.at(-1)!;
    return {
      id: a.id,
      title: a.title,
      kind: a.kind as FileKind,
      client: a.clientOrgId ? { id: a.clientOrgId, name: l.clients.get(a.clientOrgId) ?? 'Client' } : null,
      collection: a.collection,
      tags: a.tags,
      aiTags: a.aiTags,
      source: a.source as AssetSource,
      clientVisible: a.clientVisible,
      versions: a.versions.length,
      current: this.fileView(current, l, client),
      rights: {
        note: a.rightsNote,
        expiresAt: a.rightsExpireAt?.toISOString().slice(0, 10) ?? null,
        creator: a.creatorId ? { id: a.creatorId, name: l.creators.get(a.creatorId) ?? 'Creator' } : null,
        state: rightsState(a.rightsExpireAt, a.rightsNote),
      },
      createdBy: client ? 'BMU team' : (l.users.get(a.createdById) ?? 'Team'),
      updatedAt: a.updatedAt.toISOString(),
    };
  }

  private async detail(me: Me, a: AssetFull): Promise<AssetDetail> {
    const l = await this.lookups([a]);
    const client = me.type === 'client';
    const row = this.toRow(a, l, client);
    const d = a.deliverableId && !client ? await this.prisma.deliverable.findUnique({ where: { id: a.deliverableId }, select: { id: true, title: true } }) : null;
    const current = a.versions.find((v) => v.id === a.currentVersionId) ?? a.versions.at(-1)!;
    const manage = !client && (await this.canManage(me, a));
    return {
      ...row,
      history: [...a.versions].reverse().map((v) => this.fileView(v, l, client)),
      deliverable: d,
      fileId: current.fileId,
      archived: !!a.archivedAt,
      can: {
        edit: !client,
        share: !client && (hasRole(me, 'founder', 'admin', 'am_lead') || (hasRole(me, 'account_manager') && (await amOf(this.prisma, a.clientOrgId)) === me.id)),
        archive: manage,
        newVersion: !client && !a.archivedAt,
      },
    };
  }

  private async canManage(me: Me, a: { createdById: string; clientOrgId: string | null }) {
    if (a.createdById === me.id || isLeadership(me) || hasRole(me, 'department_head')) return true;
    return hasRole(me, 'account_manager') && (await amOf(this.prisma, a.clientOrgId)) === me.id;
  }

  private async load(me: Me, id: string): Promise<AssetFull> {
    const a = await this.prisma.asset.findFirst({ where: { id, orgId: me.orgId }, include });
    if (!a) throw new NotFoundException('Asset not found');
    if (me.type === 'client') {
      if (a.clientOrgId !== me.clientOrg?.id || !a.clientVisible || a.archivedAt) throw new NotFoundException('Asset not found');
      return a;
    }
    if (!inScope(await clientScope(this.prisma, me), a.clientOrgId)) throw new NotFoundException('Asset not found');
    return a;
  }

  private async assertClient(me: Me, clientOrgId: string | null | undefined) {
    if (!clientOrgId) return null;
    if (!inScope(await clientScope(this.prisma, me), clientOrgId)) throw new ForbiddenException('You can only add assets for clients you work on');
    const c = await this.prisma.clientOrg.findFirst({ where: { id: clientOrgId, orgId: me.orgId, deletedAt: null }, select: { id: true } });
    if (!c) throw new BadRequestException('Pick a client');
    return c.id;
  }

  private async assertCollection(me: Me, collectionId: string | null | undefined, clientOrgId: string | null) {
    if (!collectionId) return null;
    const c = await this.prisma.assetCollection.findFirst({ where: { id: collectionId, orgId: me.orgId, archivedAt: null } });
    if (!c) throw new BadRequestException('Collection not found');
    if (c.clientOrgId && clientOrgId && c.clientOrgId !== clientOrgId) throw new BadRequestException(`That collection belongs to another client`);
    return c.id;
  }

  // ------------------------------------------------------------------------------------------------ list

  private where(q: AssetQuery): Prisma.AssetWhereInput[] {
    const and: Prisma.AssetWhereInput[] = [];
    const now = new Date();
    if (q.clientId) and.push({ clientOrgId: q.clientId === 'bmu' ? null : q.clientId });
    if (q.collectionId) and.push({ collectionId: q.collectionId });
    if (q.kind) and.push({ kind: q.kind });
    if (q.tag) and.push({ OR: [{ tags: { has: q.tag.toLowerCase() } }, { aiTags: { has: q.tag.toLowerCase() } }] });
    if (q.rights === 'expiring') and.push({ rightsExpireAt: { gte: now, lt: new Date(now.getTime() + 30 * DAY) } });
    if (q.rights === 'expired') and.push({ rightsExpireAt: { lt: now } });
    const text = q.q?.trim();
    if (text) {
      const words = text.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
      for (const w of words) and.push({ OR: [{ title: { contains: w, mode: 'insensitive' } }, { tags: { has: w } }, { aiTags: { has: w } }, { rightsNote: { contains: w, mode: 'insensitive' } }] });
    }
    return and;
  }

  private async listFrom(me: Me, base: Prisma.AssetWhereInput, q: AssetQuery, client: boolean): Promise<AssetList> {
    const where: Prisma.AssetWhereInput = { AND: [base, { archivedAt: q.archived === '1' && !client ? { not: null } : null }, ...this.where(q)] };
    const [rows, total, all, collections] = await Promise.all([
      this.prisma.asset.findMany({ where, include, orderBy: { updatedAt: 'desc' }, take: 200 }),
      this.prisma.asset.count({ where }),
      this.prisma.asset.findMany({ where: { AND: [base, { archivedAt: null }] }, select: { tags: true, aiTags: true, clientOrgId: true, collectionId: true, rightsExpireAt: true }, take: 5000 }),
      this.prisma.assetCollection.findMany({ where: { orgId: me.orgId, archivedAt: null }, orderBy: { name: 'asc' } }),
    ]);
    const l = await this.lookups(rows);
    const counts = new Map<string, number>();
    for (const a of all) for (const t of new Set([...a.tags, ...a.aiTags])) counts.set(t, (counts.get(t) ?? 0) + 1);
    const clientIds = [...new Set(all.map((a) => a.clientOrgId).filter((x): x is string => !!x))];
    const scope = client ? [me.clientOrg!.id] : await clientScope(this.prisma, me);
    const visibleCollections = collections.filter((c) => (client ? all.some((a) => a.collectionId === c.id) : inScope(scope, c.clientOrgId)));
    const [clients, creators] = await Promise.all([
      client ? [] : this.prisma.clientOrg.findMany({ where: { orgId: me.orgId, deletedAt: null, archivedAt: null, ...(scope === 'all' ? {} : { id: { in: scope } }) }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      client ? [] : this.prisma.creator.findMany({ where: { orgId: me.orgId, archivedAt: null }, select: { id: true, user: { select: { name: true } } }, take: 200 }),
    ]);
    const clientNames = new Map([...clients.map((c) => [c.id, c.name] as const), ...l.clients]);
    const now = Date.now();
    return {
      items: rows.map((a) => this.toRow(a, l, client)),
      total,
      collections: visibleCollections.map((c) => ({ id: c.id, name: c.name, description: c.description, client: c.clientOrgId ? { id: c.clientOrgId, name: clientNames.get(c.clientOrgId) ?? 'Client' } : null, count: all.filter((a) => a.collectionId === c.id).length })),
      tags: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 40).map(([tag, count]) => ({ tag, count })),
      clients: client ? [] : clients.length ? clients : clientIds.map((id) => ({ id, name: clientNames.get(id) ?? 'Client' })),
      creators: creators.map((c) => ({ id: c.id, name: c.user.name })),
      rightsEnding: all.filter((a) => a.rightsExpireAt && a.rightsExpireAt.getTime() >= now && a.rightsExpireAt.getTime() < now + 30 * DAY).length,
      canUpload: !client,
    };
  }

  async list(me: Me, q: AssetQuery): Promise<AssetList> {
    const scope = await clientScope(this.prisma, me);
    const base: Prisma.AssetWhereInput = { orgId: me.orgId, ...(scope === 'all' ? {} : { OR: [{ clientOrgId: null }, { clientOrgId: { in: scope } }] }) };
    return this.listFrom(me, base, q, false);
  }

  async clientList(me: Me, q: AssetQuery): Promise<AssetList> {
    if (!me.clientOrg) throw new ForbiddenException('Client accounts only');
    return this.listFrom(me, { orgId: me.orgId, clientOrgId: me.clientOrg.id, clientVisible: true }, q, true);
  }

  async get(me: Me, id: string) {
    return this.detail(me, await this.load(me, id));
  }

  // ------------------------------------------------------------------------------------------------ edit

  async update(me: Me, id: string, body: unknown, ip?: string) {
    const input = parse(assetUpdateSchema, body);
    const a = await this.load(me, id);
    if (a.archivedAt) throw new BadRequestException('Restore the asset first');
    const clientOrgId = input.clientOrgId !== undefined ? await this.assertClient(me, input.clientOrgId) : a.clientOrgId;
    if (input.clientOrgId !== undefined && a.source === 'deliverable' && clientOrgId !== a.clientOrgId) throw new BadRequestException("Approved work stays with its client");
    const collectionId = input.collectionId !== undefined ? await this.assertCollection(me, input.collectionId, clientOrgId) : a.collectionId;
    if (input.creatorId) {
      const c = await this.prisma.creator.findFirst({ where: { id: input.creatorId, orgId: me.orgId } });
      if (!c) throw new BadRequestException('Creator not found');
    }
    if (input.clientVisible && !clientOrgId) throw new BadRequestException('Pick a client before sharing it with them');
    const data: Prisma.AssetUncheckedUpdateInput = {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.tags !== undefined ? { tags: [...new Set(input.tags)] } : {}),
      ...(input.clientOrgId !== undefined ? { clientOrgId } : {}),
      ...(input.collectionId !== undefined ? { collectionId } : {}),
      ...(input.clientVisible !== undefined ? { clientVisible: input.clientVisible } : {}),
      ...(input.rightsNote !== undefined ? { rightsNote: input.rightsNote || null } : {}),
      ...(input.rightsExpireAt !== undefined ? { rightsExpireAt: input.rightsExpireAt ? new Date(`${input.rightsExpireAt}T23:59:59+05:30`) : null, rightsWarnedAt: null } : {}),
      ...(input.creatorId !== undefined ? { creatorId: input.creatorId } : {}),
    };
    await this.prisma.asset.update({ where: { id }, data });
    await this.audit.log(me, 'asset.updated', 'Asset', id, { title: a.title, tags: a.tags, clientOrgId: a.clientOrgId, collectionId: a.collectionId, rightsExpireAt: a.rightsExpireAt }, input, ip);
    return this.get(me, id);
  }

  async archive(me: Me, id: string, archived: boolean, ip?: string) {
    const a = await this.load(me, id);
    if (!(await this.canManage(me, a))) throw new ForbiddenException('Only the person who added it, the Client Manager, department heads or leadership can archive assets');
    await this.prisma.asset.update({ where: { id }, data: { archivedAt: archived ? new Date() : null } });
    await this.audit.log(me, archived ? 'asset.archived' : 'asset.restored', 'Asset', id, undefined, { title: a.title }, ip);
    return this.get(me, id);
  }

  async makeCurrent(me: Me, id: string, versionId: string, ip?: string) {
    const a = await this.load(me, id);
    const v = a.versions.find((x) => x.id === versionId);
    if (!v) throw new NotFoundException('Version not found');
    const kind = (await this.prisma.file.findUnique({ where: { id: v.fileId }, select: { kind: true } }))?.kind ?? a.kind;
    await this.prisma.asset.update({ where: { id }, data: { currentVersionId: v.id, kind } });
    await this.audit.log(me, 'asset.version_made_current', 'Asset', id, { currentVersionId: a.currentVersionId }, { currentVersionId: v.id, number: v.number }, ip);
    return this.get(me, id);
  }

  // ------------------------------------------------------------------------------------------------ collections

  async collections(me: Me): Promise<AssetCollectionView[]> {
    return (await this.list(me, {})).collections;
  }

  async createCollection(me: Me, body: unknown, ip?: string) {
    const input = parse(assetCollectionInputSchema, body);
    const clientOrgId = await this.assertClient(me, input.clientOrgId);
    const c = await this.prisma.assetCollection.create({ data: { orgId: me.orgId, clientOrgId, name: input.name, description: input.description ?? null, createdById: me.id } });
    await this.audit.log(me, 'asset_collection.created', 'AssetCollection', c.id, undefined, { name: c.name }, ip);
    return (await this.collections(me)).find((x) => x.id === c.id)!;
  }

  async updateCollection(me: Me, id: string, body: unknown, ip?: string) {
    const input = parse(assetCollectionInputSchema, body);
    const c = await this.prisma.assetCollection.findFirst({ where: { id, orgId: me.orgId, archivedAt: null } });
    if (!c) throw new NotFoundException('Collection not found');
    if (!inScope(await clientScope(this.prisma, me), c.clientOrgId)) throw new NotFoundException('Collection not found');
    const clientOrgId = input.clientOrgId !== undefined ? await this.assertClient(me, input.clientOrgId) : c.clientOrgId;
    await this.prisma.assetCollection.update({ where: { id }, data: { name: input.name, description: input.description ?? null, clientOrgId } });
    await this.audit.log(me, 'asset_collection.updated', 'AssetCollection', id, { name: c.name }, { name: input.name }, ip);
    return (await this.collections(me)).find((x) => x.id === id)!;
  }

  async deleteCollection(me: Me, id: string, ip?: string) {
    const c = await this.prisma.assetCollection.findFirst({ where: { id, orgId: me.orgId, archivedAt: null } });
    if (!c) throw new NotFoundException('Collection not found');
    if (c.createdById !== me.id && !isLeadership(me) && !hasRole(me, 'department_head')) throw new ForbiddenException('Only the person who made it or leadership can remove a collection');
    await this.prisma.$transaction([this.prisma.asset.updateMany({ where: { collectionId: id }, data: { collectionId: null } }), this.prisma.assetCollection.update({ where: { id }, data: { archivedAt: new Date() } })]);
    await this.audit.log(me, 'asset_collection.removed', 'AssetCollection', id, { name: c.name }, undefined, ip);
    return { ok: true as const };
  }

  // ------------------------------------------------------------------------------------------------ adding files

  /** Adds a stored file as a new asset, or as the next version of `assetId`. */
  private async attach(me: Me, fileIn: Prisma.FileUncheckedCreateInput, t: { assetId?: string; title?: string; clientOrgId?: string | null; collectionId?: string | null; tags?: string[]; note?: string }, ip?: string) {
    // v36: asset files belong to the uploader's department.
    const file: Prisma.FileUncheckedCreateInput = { ...fileIn, departmentId: fileIn.departmentId ?? (await uploaderDepartment(this.prisma, me.id)) };
    if (t.assetId) {
      const a = await this.load(me, t.assetId);
      if (a.archivedAt) throw new BadRequestException('Restore the asset first');
      const number = (a.versions.at(-1)?.number ?? 0) + 1;
      const v = await this.prisma.$transaction(async (tx) => {
        const f = await tx.file.create({ data: { ...file, clientOrgId: a.clientOrgId } });
        const v = await tx.assetVersion.create({ data: { orgId: me.orgId, assetId: a.id, number, fileId: f.id, note: t.note ?? null, uploadedById: me.id } });
        await tx.asset.update({ where: { id: a.id }, data: { currentVersionId: v.id, kind: String(file.kind) } });
        return v;
      });
      await this.audit.log(me, 'asset.version_added', 'Asset', a.id, undefined, { number, name: file.name }, ip);
      void this.autoTag(me.orgId, a.id, v.fileId);
      return this.get(me, a.id);
    }
    const clientOrgId = await this.assertClient(me, t.clientOrgId);
    const collectionId = await this.assertCollection(me, t.collectionId, clientOrgId);
    const title = (t.title || String(file.name ?? 'Untitled').replace(/\.[a-z0-9]{1,6}$/i, '')).slice(0, 160);
    const asset = await this.prisma.$transaction(async (tx) => {
      const f = await tx.file.create({ data: { ...file, clientOrgId } });
      const a = await tx.asset.create({ data: { orgId: me.orgId, clientOrgId, collectionId, title, kind: String(file.kind), tags: [...new Set(t.tags ?? [])], createdById: me.id } });
      const v = await tx.assetVersion.create({ data: { orgId: me.orgId, assetId: a.id, number: 1, fileId: f.id, note: t.note ?? null, uploadedById: me.id } });
      await tx.asset.update({ where: { id: a.id }, data: { currentVersionId: v.id } });
      return { a, fileId: f.id };
    });
    await this.audit.log(me, 'asset.created', 'Asset', asset.a.id, undefined, { title, kind: file.kind, clientOrgId }, ip);
    void this.autoTag(me.orgId, asset.a.id, asset.fileId);
    return this.get(me, asset.a.id);
  }

  async addLink(me: Me, body: unknown, ip?: string) {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    const input = parse(assetLinkSchema, body);
    return this.attach(me, { orgId: me.orgId, path: input.url, kind: 'link', name: input.title ?? input.url, uploadedById: me.id }, { ...input, title: input.title ?? new URL(input.url).hostname }, ip);
  }

  // ------------------------------------------------------------------------------------------------ resumable uploads

  private sessionView(s: { id: string; name: string; size: bigint; received: bigint; completedAt: Date | null; target: Prisma.JsonValue }): UploadSessionView {
    return { id: s.id, name: s.name, size: Number(s.size), received: Number(s.received), chunkSize: ASSET_CHUNK_BYTES, done: !!s.completedAt, assetId: ((s.target ?? {}) as { assetId?: string }).assetId ?? null };
  }

  private async session(me: Me, id: string) {
    const s = await this.prisma.uploadSession.findFirst({ where: { id, orgId: me.orgId, userId: me.id } });
    if (!s) throw new NotFoundException('Upload not found. Start it again.');
    return s;
  }

  async startUpload(me: Me, body: unknown) {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    const input = parse(uploadStartSchema, body);
    if (input.assetId) await this.load(me, input.assetId);
    else {
      const clientOrgId = await this.assertClient(me, input.clientOrgId);
      await this.assertCollection(me, input.collectionId, clientOrgId);
    }
    await this.cleanup(me.orgId);
    mkdirSync(tmpDir(), { recursive: true });
    const id = randomUUID();
    const tmpPath = join(tmpDir(), `${id}.part`);
    await writeFile(tmpPath, '');
    const s = await this.prisma.uploadSession.create({
      data: { id, orgId: me.orgId, userId: me.id, name: input.name, mimeType: input.mimeType || 'application/octet-stream', size: BigInt(input.size), tmpPath, target: { assetId: input.assetId, title: input.title, clientOrgId: input.clientOrgId, collectionId: input.collectionId, tags: input.tags, note: input.note } },
    });
    return this.sessionView(s);
  }

  async uploadStatus(me: Me, id: string) {
    const s = await this.session(me, id);
    // The file on disk is the truth: a piece cut off half-way only counts what arrived.
    const onDisk = await stat(s.tmpPath).then((x) => x.size, () => 0);
    if (!s.completedAt && BigInt(onDisk) !== s.received) return this.sessionView(await this.prisma.uploadSession.update({ where: { id }, data: { received: BigInt(onDisk) } }));
    return this.sessionView(s);
  }

  /** Appends one piece at `offset`. A piece at the wrong offset is ignored and the current position returned. */
  async uploadChunk(me: Me, id: string, offset: number, body: Readable) {
    const s = await this.session(me, id);
    if (s.completedAt) throw new BadRequestException('This upload is already finished');
    if (this.writing.has(id)) throw new BadRequestException('Another piece of this upload is still arriving');
    const onDisk = await stat(s.tmpPath).then((x) => x.size, () => -1);
    if (onDisk < 0) throw new BadRequestException('The upload expired. Start it again.');
    if (!Number.isFinite(offset) || offset !== onDisk) {
      body.resume();
      return this.sessionView(await this.prisma.uploadSession.update({ where: { id }, data: { received: BigInt(onDisk) } }));
    }
    const limit = Math.min(ASSET_CHUNK_BYTES * 2, Number(s.size) - onDisk);
    this.writing.add(id);
    try {
      await new Promise<void>((ok, fail) => {
        let n = 0;
        const out = createWriteStream(s.tmpPath, { flags: 'a' });
        body.on('data', (c: Buffer) => {
          n += c.length;
          if (n > limit) {
            body.unpipe(out);
            out.end();
            fail(new BadRequestException('That piece is bigger than the file'));
          }
        });
        body.on('error', fail);
        out.on('error', fail);
        out.on('finish', ok);
        body.pipe(out);
      });
    } catch (e) {
      // Keep only whole bytes written so far; the next status call reports them.
      await this.uploadStatus(me, id).catch(() => undefined);
      throw e;
    } finally {
      this.writing.delete(id);
    }
    const size = (await stat(s.tmpPath)).size;
    if (size > Number(s.size)) {
      await rm(s.tmpPath, { force: true });
      await this.prisma.uploadSession.delete({ where: { id } });
      throw new BadRequestException('More data arrived than the file size. Start the upload again.');
    }
    return this.sessionView(await this.prisma.uploadSession.update({ where: { id }, data: { received: BigInt(size) } }));
  }

  /**
   * Finishes an upload: from the pieces sent to this server, or (v22, `stored`) from the whole file the browser put
   * straight into Supabase Storage, which is how uploads work when the API runs on Vercel.
   */
  async completeUpload(me: Me, id: string, ip?: string, stored?: { path: string; size: number }) {
    const s = await this.session(me, id);
    if (s.completedAt) throw new BadRequestException('This upload is already finished');
    let abs: string;
    let rel: string;
    let size: number;
    if (stored) {
      size = stored.size;
      if (size !== Number(s.size)) throw new BadRequestException(`The stored file has ${size} bytes, not ${s.size}. Upload it again.`);
      abs = stored.path;
      rel = relPathOf(abs);
      await rm(s.tmpPath, { force: true });
    } else {
      size = await stat(s.tmpPath).then((x) => x.size, () => -1);
      if (size !== Number(s.size)) throw new BadRequestException(`Only ${Math.max(0, size)} of ${s.size} bytes arrived. Keep uploading.`);
      const month = new Date().toISOString().slice(0, 7);
      const dir = join(storageRoot(), 'assets', month);
      mkdirSync(dir, { recursive: true });
      const name = `${randomUUID()}${extname(s.name).toLowerCase().slice(0, 10)}`;
      abs = join(dir, name);
      rel = join('assets', month, name);
      await rename(s.tmpPath, abs);
      await putFile(relPathOf(abs), abs, s.mimeType);
    }
    const checksum = await sha256File(abs);
    await this.prisma.uploadSession.update({ where: { id }, data: { completedAt: new Date(), received: s.size } });
    const t = (s.target ?? {}) as { assetId?: string; title?: string; clientOrgId?: string | null; collectionId?: string | null; tags?: string[]; note?: string };
    const mime = s.mimeType === 'application/octet-stream' ? guessMime(s.name) : s.mimeType;
    return this.attach(
      me,
      { orgId: me.orgId, path: rel, kind: fileKindFromMime(mime), name: s.name, mimeType: mime, sizeBytes: size > 2_147_483_647 ? null : size, checksum, uploadedById: me.id, tags: t.tags ?? [] },
      t,
      ip,
    );
  }

  async cancelUpload(me: Me, id: string) {
    const s = await this.session(me, id);
    if (!s.completedAt) await rm(s.tmpPath, { force: true });
    await this.prisma.uploadSession.delete({ where: { id } });
    return { ok: true as const };
  }

  /** Unfinished uploads older than two days are removed. */
  private async cleanup(orgId: string) {
    const old = await this.prisma.uploadSession.findMany({ where: { orgId, completedAt: null, updatedAt: { lt: new Date(Date.now() - 2 * DAY) } }, take: 50 });
    for (const s of old) await rm(s.tmpPath, { force: true }).catch(() => undefined);
    if (old.length) await this.prisma.uploadSession.deleteMany({ where: { id: { in: old.map((s) => s.id) } } });
  }

  // ------------------------------------------------------------------------------------------------ approved work lands in the library

  /** Called when a client finally approves a deliverable: the approved file becomes (or updates) its library asset. */
  async fromApprovedDeliverable(deliverableId: string) {
    const d = await this.prisma.deliverable.findUnique({
      where: { id: deliverableId },
      include: { cycle: { select: { engagement: { select: { clientOrgId: true, amId: true } } } }, versions: { include: { file: true } } },
    });
    const v = d?.versions.find((x) => x.id === d.approvedVersionId);
    if (!d || !v) return null;
    const existing = await this.prisma.asset.findUnique({ where: { deliverableId }, include: { versions: true } });
    if (existing) {
      if (existing.versions.some((x) => x.fileId === v.fileId)) return existing.id;
      const nv = await this.prisma.assetVersion.create({ data: { orgId: d.orgId, assetId: existing.id, number: (existing.versions.at(-1)?.number ?? 0) + 1, fileId: v.fileId, note: `Approved v${v.number}`, uploadedById: v.uploadedById } });
      await this.prisma.asset.update({ where: { id: existing.id }, data: { currentVersionId: nv.id, kind: v.file.kind, archivedAt: null } });
      return existing.id;
    }
    const a = await this.prisma.asset.create({
      data: { orgId: d.orgId, clientOrgId: d.cycle.engagement.clientOrgId, title: d.title, kind: v.file.kind, tags: [d.type.toLowerCase()], source: 'deliverable', deliverableId: d.id, clientVisible: true, createdById: v.uploadedById },
    });
    const nv = await this.prisma.assetVersion.create({ data: { orgId: d.orgId, assetId: a.id, number: 1, fileId: v.fileId, note: `Approved v${v.number}`, uploadedById: v.uploadedById } });
    await this.prisma.asset.update({ where: { id: a.id }, data: { currentVersionId: nv.id } });
    void this.autoTag(d.orgId, a.id, v.fileId);
    return a.id;
  }

  // ------------------------------------------------------------------------------------------------ AI tags

  async aiTags(me: Me, id: string) {
    const a = await this.load(me, id);
    const current = a.versions.find((v) => v.id === a.currentVersionId) ?? a.versions.at(-1)!;
    const r = await this.tagWithAi(a.orgId, me, a.id, current.fileId, true);
    const out = await this.get(me, id);
    return r?.notice ? { ...out, notice: r.notice } : out;
  }

  private async autoTag(orgId: string, assetId: string, fileId: string) {
    if (process.env.NODE_ENV === 'test' || process.env.VITEST) return;
    try {
      await this.tagWithAi(orgId, null, assetId, fileId, false);
    } catch (e) {
      this.log.warn(`Auto tags failed: ${(e as Error).message}`);
    }
  }

  /** AI looks at the picture and suggests up to 8 plain tags. Without a key (or for non-images) nothing changes. */
  private async tagWithAi(orgId: string, me: Me | null, assetId: string, fileId: string, explicit: boolean) {
    const f = await this.prisma.file.findUnique({ where: { id: fileId } });
    if (!f || f.kind !== 'image' || !f.mimeType || !AI_IMAGE_TYPES.includes(f.mimeType) || (f.sizeBytes ?? 0) > AI_IMAGE_MAX) {
      if (explicit) throw new BadRequestException('AI tags work on JPG, PNG, GIF or WebP pictures up to 3.7 MB');
      return null;
    }
    if (!explicit && !this.ai.connected()) return null;
    const data = (await readFile(await localFile(f.path))).toString('base64');
    let tags: string[] = [];
    const res = await this.ai.execute({ orgId, userId: me?.id ?? null, me: me ?? undefined }, 'asset_tags', {
      target: { type: 'Asset', id: assetId },
      basic: () => ({ text: '' }),
      ai: async (run) => {
        const msg = await run({
          system: 'You tag pictures for a marketing agency asset library. Reply with JSON only.',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: f.mimeType as 'image/png', data } },
                { type: 'text', text: 'Give up to 8 short lowercase tags (one or two words each) for what is in this picture: subject, setting, colours, style, and any visible brand or product type. No people names.' },
              ],
            },
          ],
          maxTokens: 400,
          schema: { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } }, required: ['tags'], additionalProperties: false },
        });
        const text = msg.content.find((b) => b.type === 'text')?.text ?? '{}';
        const parsed = JSON.parse(text) as { tags?: unknown };
        tags = Array.isArray(parsed.tags) ? parsed.tags.filter((t): t is string => typeof t === 'string') : [];
        return { text: tags.join(', ') };
      },
    });
    const clean = [...new Set(tags.map((t) => t.toLowerCase().trim().replace(/[^a-z0-9 &-]/g, '').slice(0, 30)).filter((t) => t.length >= 2))].slice(0, 8);
    if (res.mode === 'ai' && clean.length) await this.prisma.asset.update({ where: { id: assetId }, data: { aiTags: clean } });
    return { notice: res.mode === 'ai' ? null : (res.notice ?? 'AI tags need an AI key (Command Centre → AI Copilot).') };
  }
}

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
};
export const guessMime = (name: string) => MIME[extname(name).toLowerCase()] ?? 'application/octet-stream';
