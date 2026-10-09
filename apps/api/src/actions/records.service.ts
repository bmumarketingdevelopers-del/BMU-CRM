// v11 core: per-user drafts (form autosave), saved views (per user, shareable), watchers and tags on any record,
// and the generic archive / restore endpoints for entities registered in ActionsRegistry.
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { CoreDraft, CoreSavedView, CoreSavedViewInput, CoreTag, CoreWatchers, Me } from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ActionsRegistry } from './registry.js';
import { UndoService } from './undo.service.js';

const ENTITY = /^[a-z][a-z0-9_-]{1,40}$/;
const check = (entity: string) => {
  if (!ENTITY.test(entity)) throw new BadRequestException('Unknown record type');
  return entity;
};
const staff = (me: Me) => {
  if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
};

/** Who can see a record, for watchers/tags. Registered by type; unregistered types fall back to "staff only". */
export type VisibilityCheck = (me: Me, id: string) => Promise<void>;

@Injectable()
export class RecordsService {
  /** Optional per-type visibility checks for watchers and tags (core registers `task`). */
  readonly visibility = new Map<string, VisibilityCheck>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly registry: ActionsRegistry,
    private readonly undo: UndoService,
  ) {}

  private async canSee(me: Me, type: string, id: string) {
    staff(me);
    const v = this.visibility.get(type);
    if (v) await v(me, id);
  }

  // Drafts --------------------------------------------------------------------
  async getDraft(me: Me, entity: string, key = 'new'): Promise<CoreDraft | null> {
    const d = await this.prisma.draft.findUnique({ where: { userId_entity_key: { userId: me.id, entity: check(entity), key } } });
    return d ? { entity: d.entity, key: d.key, payload: d.payload as Record<string, unknown>, updatedAt: d.updatedAt.toISOString() } : null;
  }

  async saveDraft(me: Me, entity: string, key: string, payload: Record<string, unknown>): Promise<CoreDraft> {
    if (JSON.stringify(payload).length > 200_000) throw new BadRequestException('This draft is too big to save');
    const d = await this.prisma.draft.upsert({
      where: { userId_entity_key: { userId: me.id, entity: check(entity), key } },
      create: { orgId: me.orgId, userId: me.id, entity, key, payload: JSON.parse(JSON.stringify(payload)) },
      update: { payload: JSON.parse(JSON.stringify(payload)) },
    });
    return { entity: d.entity, key: d.key, payload: d.payload as Record<string, unknown>, updatedAt: d.updatedAt.toISOString() };
  }

  async removeDraft(me: Me, entity: string, key = 'new') {
    await this.prisma.draft.deleteMany({ where: { userId: me.id, entity: check(entity), key } });
    return { ok: true as const };
  }

  // Saved views ---------------------------------------------------------------
  private async viewOut(me: Me, rows: { id: string; entity: string; name: string; filters: unknown; columns: unknown; isShared: boolean; userId: string }[]): Promise<CoreSavedView[]> {
    const owners = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.userId))] } }, select: { id: true, name: true } });
    return rows.map((r) => ({ id: r.id, entity: r.entity, name: r.name, filters: (r.filters ?? {}) as Record<string, unknown>, columns: (r.columns ?? []) as string[], isShared: r.isShared, mine: r.userId === me.id, owner: owners.find((o) => o.id === r.userId)?.name ?? '' }));
  }

  async views(me: Me, entity: string) {
    staff(me);
    const rows = await this.prisma.savedView.findMany({ where: { orgId: me.orgId, entity: check(entity), OR: [{ userId: me.id }, { isShared: true }] }, orderBy: [{ name: 'asc' }] });
    return this.viewOut(me, rows);
  }

  async createView(me: Me, entity: string, input: Required<CoreSavedViewInput>) {
    staff(me);
    const v = await this.prisma.savedView.create({ data: { orgId: me.orgId, userId: me.id, entity: check(entity), name: input.name, filters: JSON.parse(JSON.stringify(input.filters)), columns: input.columns, isShared: input.isShared } });
    return (await this.viewOut(me, [v]))[0];
  }

  async updateView(me: Me, id: string, input: Partial<CoreSavedViewInput>) {
    const v = await this.prisma.savedView.findFirst({ where: { id, orgId: me.orgId } });
    if (!v) throw new NotFoundException('View not found');
    if (v.userId !== me.id) throw new ForbiddenException('Only the person who saved this view can change it');
    const u = await this.prisma.savedView.update({
      where: { id },
      data: { name: input.name ?? undefined, filters: input.filters ? JSON.parse(JSON.stringify(input.filters)) : undefined, columns: input.columns ?? undefined, isShared: input.isShared ?? undefined },
    });
    return (await this.viewOut(me, [u]))[0];
  }

  async removeView(me: Me, id: string) {
    const v = await this.prisma.savedView.findFirst({ where: { id, orgId: me.orgId } });
    if (!v) throw new NotFoundException('View not found');
    if (v.userId !== me.id) throw new ForbiddenException('Only the person who saved this view can delete it');
    await this.prisma.savedView.delete({ where: { id } });
    return { ok: true as const };
  }

  // Watchers ------------------------------------------------------------------
  async watchers(me: Me, type: string, id: string): Promise<CoreWatchers> {
    await this.canSee(me, check(type), id);
    const rows = await this.prisma.watcher.findMany({ where: { orgId: me.orgId, targetType: type, targetId: id } });
    const people = await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
    return { watching: rows.some((r) => r.userId === me.id), people };
  }

  /** Adds watchers (yourself by default). Adding other people needs the record's manage rights (checked by the caller type). */
  async watch(me: Me, type: string, id: string, userIds?: string[]) {
    await this.canSee(me, check(type), id);
    const ids = userIds?.length ? userIds : [me.id];
    const valid = await this.prisma.user.findMany({ where: { id: { in: ids }, orgId: me.orgId, type: 'staff', deletedAt: null }, select: { id: true } });
    if (!valid.length) throw new BadRequestException('Pick team members to add');
    await this.prisma.watcher.createMany({ data: valid.map((u) => ({ orgId: me.orgId, userId: u.id, targetType: type, targetId: id })), skipDuplicates: true });
    return this.watchers(me, type, id);
  }

  async unwatch(me: Me, type: string, id: string, userId?: string) {
    await this.canSee(me, check(type), id);
    await this.prisma.watcher.deleteMany({ where: { orgId: me.orgId, targetType: type, targetId: id, userId: userId ?? me.id } });
    return this.watchers(me, type, id);
  }

  /** Watchers of a record (for notifications). */
  async watcherIds(orgId: string, type: string, id: string) {
    return (await this.prisma.watcher.findMany({ where: { orgId, targetType: type, targetId: id }, select: { userId: true } })).map((w) => w.userId);
  }

  // Tags ----------------------------------------------------------------------
  async tags(me: Me): Promise<CoreTag[]> {
    staff(me);
    return (await this.prisma.tag.findMany({ where: { orgId: me.orgId }, orderBy: { name: 'asc' } })) as CoreTag[];
  }

  async createTag(me: Me, name: string, color: string) {
    staff(me);
    const existing = await this.prisma.tag.findFirst({ where: { orgId: me.orgId, name: { equals: name, mode: 'insensitive' } } });
    if (existing) return existing as CoreTag;
    return (await this.prisma.tag.create({ data: { orgId: me.orgId, name, color } })) as CoreTag;
  }

  async tagsOf(me: Me, type: string, id: string): Promise<CoreTag[]> {
    await this.canSee(me, check(type), id);
    const links = await this.prisma.tagLink.findMany({ where: { orgId: me.orgId, targetType: type, targetId: id }, include: { tag: true } });
    return links.map((l) => l.tag as CoreTag).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Tags per record for a list (one query). */
  async tagsFor(orgId: string, type: string, ids: string[]) {
    const map = new Map<string, CoreTag[]>();
    if (!ids.length) return map;
    const links = await this.prisma.tagLink.findMany({ where: { orgId, targetType: type, targetId: { in: ids } }, include: { tag: true } });
    for (const l of links) map.set(l.targetId, [...(map.get(l.targetId) ?? []), l.tag as CoreTag]);
    return map;
  }

  async setTags(me: Me, type: string, id: string, input: { tagIds: string[]; names: string[] }, ip?: string) {
    await this.canSee(me, check(type), id);
    const created = await Promise.all(input.names.map((n) => this.createTag(me, n, 'neutral')));
    const ids = [...new Set([...input.tagIds, ...created.map((t) => t.id)])];
    const valid = await this.prisma.tag.findMany({ where: { orgId: me.orgId, id: { in: ids } }, select: { id: true, name: true } });
    const before = await this.tagsOf(me, type, id);
    await this.prisma.$transaction([
      this.prisma.tagLink.deleteMany({ where: { orgId: me.orgId, targetType: type, targetId: id, tagId: { notIn: valid.map((v) => v.id) } } }),
      this.prisma.tagLink.createMany({ data: valid.map((v) => ({ orgId: me.orgId, tagId: v.id, targetType: type, targetId: id, byId: me.id })), skipDuplicates: true }),
    ]);
    await this.audit.log(me, 'record.tagged', type.replace(/(^|_)(\w)/g, (_, _u: string, c: string) => c.toUpperCase()), id, { tags: before.map((t) => t.name) }, { tags: valid.map((v) => v.name) }, ip);
    return this.tagsOf(me, type, id);
  }

  /** Adds one tag to many records (bulk action). */
  async addTag(me: Me, type: string, ids: string[], name: string) {
    const tag = await this.createTag(me, name, 'neutral');
    await this.prisma.tagLink.createMany({ data: ids.map((id) => ({ orgId: me.orgId, tagId: tag.id, targetType: type, targetId: id, byId: me.id })), skipDuplicates: true });
    return tag;
  }

  // Archive / restore (generic) ------------------------------------------------
  private archiveEntity(entity: string) {
    const e = this.registry.archiveEntities.get(entity);
    if (!e) throw new NotFoundException(`"${entity}" can't be archived here`);
    return e;
  }

  async archive(me: Me, entity: string, id: string, reason: string, ip?: string) {
    staff(me);
    const e = this.archiveEntity(entity);
    await e.assertCan(me, id, 'archive');
    await e.beforeArchive?.(me, id);
    const delegate = (this.prisma as unknown as Record<string, { findFirst: (a: unknown) => Promise<{ archivedAt: Date | null; archivedReason: string | null } | null>; update: (a: unknown) => Promise<unknown> }>)[e.model];
    const row = await delegate.findFirst({ where: { id, orgId: me.orgId }, select: { archivedAt: true, archivedReason: true } });
    if (!row) throw new NotFoundException('Record not found');
    if (row.archivedAt) throw new BadRequestException('Already archived');
    await delegate.update({ where: { id }, data: { archivedAt: new Date(), archivedReason: reason } });
    await this.audit.log(me, `${entity}.archived`, e.auditEntity, id, { archivedAt: null }, { archivedAt: new Date(), reason }, ip);
    const undo = await this.undo.create(me, `Archived ${entity.replace(/_/g, ' ')}`, [{ model: e.model, id, data: { archivedAt: null, archivedReason: null } }]);
    return { ok: true as const, undo };
  }

  async restore(me: Me, entity: string, id: string, ip?: string) {
    staff(me);
    const e = this.archiveEntity(entity);
    await e.assertCan(me, id, 'restore');
    const delegate = (this.prisma as unknown as Record<string, { findFirst: (a: unknown) => Promise<{ archivedAt: Date | null; archivedReason: string | null } | null>; update: (a: unknown) => Promise<unknown> }>)[e.model];
    const row = await delegate.findFirst({ where: { id, orgId: me.orgId }, select: { archivedAt: true, archivedReason: true } });
    if (!row) throw new NotFoundException('Record not found');
    if (!row.archivedAt) throw new BadRequestException('This is not archived');
    await delegate.update({ where: { id }, data: { archivedAt: null, archivedReason: null } });
    await this.audit.log(me, `${entity}.restored`, e.auditEntity, id, { archivedAt: row.archivedAt, reason: row.archivedReason }, { archivedAt: null }, ip);
    return { ok: true as const };
  }
}
