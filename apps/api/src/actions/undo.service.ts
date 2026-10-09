// v11 core: undo for edit, move, reassign, archive and bulk actions. The before-state is stored server-side and an
// undo token is returned; POST /actions/undo/:token restores it within the window (the toast shows for 10 seconds).
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { CoreUndo, Me } from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ActionsRegistry, type UndoRow } from './registry.js';

/** Server-side window (the toast is shorter; this leaves room for slow networks). */
export const UNDO_WINDOW_MS = 60_000;

@Injectable()
export class UndoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly registry: ActionsRegistry,
  ) {}

  /** Stores the before-state and returns the token for the toast. Rows on unregistered models are refused. */
  async create(me: Me, label: string, rows: UndoRow[]): Promise<CoreUndo | null> {
    if (!rows.length) return null;
    for (const r of rows) if (!this.registry.undoModels.has(r.model)) throw new Error(`Undo is not registered for model ${r.model}`);
    const expiresAt = new Date(Date.now() + UNDO_WINDOW_MS);
    const e = await this.prisma.undoEntry.create({ data: { orgId: me.orgId, userId: me.id, label, before: JSON.parse(JSON.stringify(rows)), expiresAt } });
    return { token: e.id, label, expiresAt: expiresAt.toISOString() };
  }

  async undo(me: Me, token: string, ip?: string) {
    const e = await this.prisma.undoEntry.findFirst({ where: { id: token, orgId: me.orgId } });
    if (!e) throw new NotFoundException('Nothing to undo');
    if (e.userId !== me.id) throw new ForbiddenException('Only the person who made the change can undo it');
    if (e.usedAt) throw new BadRequestException('Already undone');
    if (e.expiresAt < new Date()) throw new BadRequestException('Too late to undo. Make the change again by hand.');
    const rows = e.before as unknown as UndoRow[];
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.undoEntry.updateMany({ where: { id: e.id, usedAt: null }, data: { usedAt: new Date() } });
      if (!claimed.count) throw new BadRequestException('Already undone');
      // Reverse order: later rows were written after earlier ones.
      for (const r of [...rows].reverse()) {
        if (!this.registry.undoModels.has(r.model)) continue;
        const delegate = (tx as unknown as Record<string, { update: (a: unknown) => Promise<unknown>; deleteMany: (a: unknown) => Promise<unknown> }>)[r.model];
        if (!delegate) continue;
        if (r.delete) await delegate.deleteMany({ where: { id: r.id } });
        else if (r.data) await delegate.update({ where: { id: r.id }, data: r.data });
      }
    });
    const entity = rows[0]?.model === 'task' ? 'Task' : (rows[0]?.model ?? 'Record');
    for (const id of [...new Set(rows.filter((r) => !r.delete && r.model === rows[0]?.model).map((r) => r.id))].slice(0, 50)) {
      await this.audit.log(me, `${entity.toLowerCase()}.undone`, entity.charAt(0).toUpperCase() + entity.slice(1), id, null, { undid: e.label }, ip);
    }
    return { ok: true as const, message: `Undone: ${e.label}` };
  }
}
