// v20 offline sync (server side): applies a batch of changes the phone queued while offline. Each op is idempotent
// (the phone may resend after a dropped connection) and merges field by field against what the phone last saw,
// using the shared rules in packages/shared/src/sync. Changes go through the normal task actions, so permissions,
// validation, audit and live updates are exactly the same as an online edit.
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { mergeTask, syncOutcome, syncPushSchema, type Me, type SyncOpInput, type SyncOpResult, type SyncPullView, type TaskSnapshot } from '@bmu/shared';
import { parse } from '../common/zod.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductionService } from '../production/production.service.js';
import { TasksActionsService } from '../actions/tasks/tasks.service.js';

@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ref: ModuleRef,
  ) {}

  private get production() {
    return this.ref.get(ProductionService, { strict: false });
  }
  private get taskActions() {
    return this.ref.get(TasksActionsService, { strict: false });
  }

  async push(me: Me, body: unknown, ip?: string): Promise<{ results: SyncOpResult[] }> {
    if (me.type !== 'staff') throw new ForbiddenException('Offline sync is for the BMU team app');
    const { ops } = parse(syncPushSchema, body);
    const results: SyncOpResult[] = [];
    // In the order they were made on the phone.
    for (const op of [...ops].sort((a, b) => a.at.localeCompare(b.at))) results.push(await this.one(me, op, ip));
    return { results };
  }

  private async one(me: Me, op: SyncOpInput, ip?: string): Promise<SyncOpResult> {
    const seen = await this.prisma.syncOp.findUnique({ where: { userId_clientOpId: { userId: me.id, clientOpId: op.clientOpId } } });
    if (seen) return { ...(seen.result as SyncOpResult), task: await this.production.taskView(me, op.entityId) };
    let result: SyncOpResult;
    try {
      result = await this.applyTask(me, op, ip);
    } catch (e) {
      const known = e instanceof BadRequestException || e instanceof ForbiddenException || e instanceof NotFoundException;
      if (!known) throw e;
      const res = e.getResponse() as { message?: string | string[] } | string;
      const message = typeof res === 'string' ? res : Array.isArray(res.message) ? res.message.join('; ') : (res.message ?? e.message);
      result = { clientOpId: op.clientOpId, status: 'rejected', message, conflicts: [], task: await this.production.taskView(me, op.entityId) };
    }
    const { task: _t, ...stored } = result;
    await this.prisma.syncOp
      .create({ data: { orgId: me.orgId, userId: me.id, clientOpId: op.clientOpId, entity: op.entity, entityId: op.entityId, op: op.op, payload: { base: op.base, changes: op.changes, at: op.at } as never, status: result.status, result: stored as never } })
      .catch(() => undefined); // a parallel resend already stored it
    return result;
  }

  private async applyTask(me: Me, op: SyncOpInput, ip?: string): Promise<SyncOpResult> {
    const row = await this.prisma.task.findFirst({ where: { id: op.entityId, orgId: me.orgId }, select: { status: true, blockedReason: true, title: true, description: true, checklist: true, priority: true } });
    if (!row) throw new NotFoundException('Task not found');
    const server: TaskSnapshot = { status: row.status, blockedReason: row.blockedReason, title: row.title, description: row.description, checklist: (row.checklist ?? []) as TaskSnapshot['checklist'], priority: row.priority as TaskSnapshot['priority'] };
    const { logMinutes, ...changes } = op.changes;
    const { patch, conflicts } = mergeTask(server, op.base, changes);
    const edit: Record<string, unknown> = {};
    for (const k of ['title', 'description', 'checklist', 'priority'] as const) if (k in patch) edit[k] = patch[k];
    if (Object.keys(edit).length) await this.taskActions.edit(me, op.entityId, edit as never, ip);
    if (patch.status || logMinutes) {
      const status = patch.status;
      await this.production.updateTask(me, op.entityId, { ...(status ? { status, blockedReason: status === 'blocked' ? (patch.blockedReason ?? changes.blockedReason ?? 'Blocked (set offline)') : undefined } : {}), ...(logMinutes ? { logMinutes } : {}) } as never, ip);
    }
    const status = syncOutcome(conflicts);
    const message = status === 'applied' ? null : conflicts.map((c) => `${c.field}: ${c.kept === 'theirs' ? 'kept the change made elsewhere' : c.kept === 'both' ? 'combined both' : 'kept yours'}`).join('; ');
    return { clientOpId: op.clientOpId, status, message, conflicts, task: await this.production.taskView(me, op.entityId) };
  }

  /** What the phone needs to work offline: the person's tasks (changed since `since`, or all) and unread count. */
  async pull(me: Me, since?: string): Promise<SyncPullView> {
    if (me.type !== 'staff') throw new ForbiddenException('Offline sync is for the BMU team app');
    const now = new Date();
    const all = await this.production.tasks(me, 'mine');
    let tasks = all;
    if (since && !Number.isNaN(Date.parse(since))) {
      const changed = new Set((await this.prisma.task.findMany({ where: { id: { in: all.map((t) => t.id) }, updatedAt: { gt: new Date(since) } }, select: { id: true } })).map((t) => t.id));
      tasks = all.filter((t) => changed.has(t.id));
    }
    const unread = await this.prisma.notification.count({ where: { userId: me.id, readAt: null, OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }] } });
    return { now: now.toISOString(), tasks, unread };
  }
}
