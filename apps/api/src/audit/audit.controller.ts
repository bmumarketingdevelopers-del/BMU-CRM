import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuditPage, AuditRow, Me } from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { CurrentUser, RequireCapability } from '../common/decorators.js';
import { PrismaService } from '../prisma/prisma.service.js';

const PAGE_SIZE = 50;
const EXPORT_MAX = 20_000;
const DAY = 86_400_000;

type Filters = { q?: string; actor?: string; area?: string; from?: string; to?: string; page?: string };

/** "YYYY-MM-DD" as the start of that day in India (UTC+5:30). */
const istDay = (d: string | undefined) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T00:00:00+05:30`) : null);
const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const istTime = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Asia/Kolkata' });

@Controller('audit')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Which entries this person may see (audit_log permission): the Founder everything; a Branch Manager the changes made
   * by people in their branch (everything when they have no branch set).
   */
  private async scope(me: Me): Promise<{ where: Prisma.AuditEventWhereInput; scope: 'all' | 'branch' }> {
    const base: Prisma.AuditEventWhereInput = { orgId: me.orgId };
    if (me.roles.includes('founder')) return { where: base, scope: 'all' };
    const self = await this.prisma.user.findUnique({ where: { id: me.id }, select: { branchId: true } });
    if (!self?.branchId) return { where: base, scope: 'all' };
    const people = await this.prisma.user.findMany({ where: { orgId: me.orgId, branchId: self.branchId }, select: { id: true } });
    return { where: { ...base, actorId: { in: people.map((p) => p.id) } }, scope: 'branch' };
  }

  /** The filters from the page: free text, person ("system" for automatic entries), area (action prefix), dates. */
  private filterWhere(f: Filters): Prisma.AuditEventWhereInput[] {
    const and: Prisma.AuditEventWhereInput[] = [];
    const q = f.q?.trim();
    if (q) and.push({ OR: [{ action: { contains: q, mode: 'insensitive' } }, { entity: { contains: q, mode: 'insensitive' } }, { entityId: { contains: q } }] });
    if (f.actor === 'system') and.push({ actorId: null });
    else if (f.actor) and.push({ actorId: f.actor });
    if (f.area) and.push({ action: { startsWith: `${f.area}.` } });
    const from = istDay(f.from);
    const to = istDay(f.to);
    if (from) and.push({ at: { gte: from } });
    if (to) and.push({ at: { lt: new Date(to.getTime() + DAY) } });
    return and;
  }

  private async rows(list: Awaited<ReturnType<PrismaService['auditEvent']['findMany']>>): Promise<AuditRow[]> {
    const actorIds = [...new Set(list.map((r) => r.actorId).filter((x): x is string => !!x))];
    const actors = await this.prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } });
    const byId = new Map(actors.map((a) => [a.id, a]));
    return list.map((r) => ({
      id: r.id,
      action: r.action,
      entity: r.entity,
      entityId: r.entityId,
      at: r.at.toISOString(),
      actor: r.actorId ? (byId.get(r.actorId) ?? null) : null,
      before: r.before,
      after: r.after,
    }));
  }

  /** Latest 200 entries (kept for older screens). */
  @Get()
  @RequireCapability('audit_log')
  async list(@CurrentUser() me: Me): Promise<AuditRow[]> {
    const { where } = await this.scope(me);
    return this.rows(await this.prisma.auditEvent.findMany({ where, orderBy: { at: 'desc' }, take: 200 }));
  }

  /** v44: search, filter and page through every entry, with the choices for the Person and Area menus. */
  @Get('search')
  @RequireCapability('audit_log')
  async search(@CurrentUser() me: Me, @Query() f: Filters): Promise<AuditPage> {
    const { where: scoped, scope } = await this.scope(me);
    const where: Prisma.AuditEventWhereInput = { AND: [scoped, ...this.filterWhere(f)] };
    const page = Math.max(1, Math.floor(Number(f.page) || 1));
    const [total, list, byActor, byAction] = await Promise.all([
      this.prisma.auditEvent.count({ where }),
      this.prisma.auditEvent.findMany({ where, orderBy: { at: 'desc' }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
      this.prisma.auditEvent.groupBy({ by: ['actorId'], where: scoped }),
      this.prisma.auditEvent.groupBy({ by: ['action'], where: scoped }),
    ]);
    const people = await this.prisma.user.findMany({ where: { id: { in: byActor.map((a) => a.actorId).filter((x): x is string => !!x) } }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
    return {
      rows: await this.rows(list),
      total,
      page,
      size: PAGE_SIZE,
      scope,
      actors: people,
      areas: [...new Set(byAction.map((a) => a.action.split('.')[0]))].sort(),
    };
  }

  /** v44: every entry matching the filters as a CSV file (up to 20,000 rows, newest first). */
  @Get('export.csv')
  @RequireCapability('audit_log')
  async export(@CurrentUser() me: Me, @Query() f: Filters, @Res() res: Response) {
    const { where: scoped } = await this.scope(me);
    const list = await this.prisma.auditEvent.findMany({ where: { AND: [scoped, ...this.filterWhere(f)] }, orderBy: { at: 'desc' }, take: EXPORT_MAX });
    const rows = await this.rows(list);
    const lines = [
      ['When (IST)', 'Who', 'Action', 'Record type', 'Record id', 'Before', 'After'].join(','),
      ...rows.map((r) => [istTime.format(new Date(r.at)), r.actor?.name ?? 'System', r.action, r.entity, r.entityId, r.before, r.after].map(csvCell).join(',')),
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
    // A byte-order mark so Excel opens names and ₹ correctly.
    res.send(`﻿${lines.join('\r\n')}\r\n`);
  }
}
