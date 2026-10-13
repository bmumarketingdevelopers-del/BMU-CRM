// v20 goals: company, team and personal goals. Company goals can follow a metric automatically; team and personal
// goals move with check-ins. Progress compares how far the number has come with how much of the time has gone.
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { formatMetric, goalCheckInSchema, goalProgress, goalSchema, goalStatus, metricDef, type GoalLevel, type GoalView, type Me } from '@bmu/shared';
import type { Goal, GoalCheckIn } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { MeService } from '../auth/me.service.js';
import { parse } from '../common/zod.js';
import { canReadCommand } from '../insights/access.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { todayIst } from '../money/dates.js';
import { MetricsService } from './metrics.service.js';
import { systemActor } from './actor.js';

const isoOf = (d: Date) => d.toISOString().slice(0, 10);
const ADMIN = ['founder', 'admin'];
type Full = Goal & { checkIns: GoalCheckIn[] };

const valueCache = new Map<string, { value: number | null; at: number }>();

@Injectable()
export class GoalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
    private readonly meService: MeService,
    private readonly audit: AuditService,
  ) {}

  private isAdmin(me: Me) {
    return me.roles.some((r) => ADMIN.includes(r));
  }

  private async headOf(me: Me) {
    return (await this.prisma.department.findMany({ where: { orgId: me.orgId, headUserId: me.id }, select: { id: true } })).map((d) => d.id);
  }

  /** Who may change a goal: Founder/Admin anything; department heads their team's and people's goals; people their own. */
  private async canEdit(me: Me, g: { level: string; ownerId: string | null; departmentId: string | null }) {
    if (this.isAdmin(me)) return true;
    if (g.level === 'company') return false;
    const heads = await this.headOf(me);
    if (g.level === 'team') return !!g.departmentId && heads.includes(g.departmentId);
    if (g.ownerId === me.id) return true;
    if (!g.ownerId) return false;
    const owner = await this.prisma.user.findUnique({ where: { id: g.ownerId }, select: { departmentId: true, managerId: true } });
    return owner?.managerId === me.id || (!!owner?.departmentId && heads.includes(owner.departmentId));
  }

  private async view(me: Me, g: Full, visibleMetrics: Set<string>, values: Map<string, number | null>): Promise<GoalView> {
    const def = g.metricKey ? metricDef(g.metricKey) : null;
    const hidden = !!def && !visibleMetrics.has(def.key);
    const last = [...g.checkIns].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    const current = def ? (hidden ? null : (values.get(g.id) ?? null)) : (last?.value ?? null);
    const progress = goalProgress(g, current);
    const unit = def?.unit ?? null;
    const show = (v: number | null) => (hidden ? 'not shown to your role' : unit ? formatMetric(v, unit) : v === null ? '—' : `${Math.round(v * 100) / 100}${g.unit ? ` ${g.unit}` : ''}`);
    const [owner, department, names] = await Promise.all([
      g.ownerId ? this.prisma.user.findUnique({ where: { id: g.ownerId }, select: { id: true, name: true } }) : null,
      g.departmentId ? this.prisma.department.findUnique({ where: { id: g.departmentId }, select: { id: true, name: true } }) : null,
      this.prisma.user.findMany({ where: { id: { in: g.checkIns.map((c) => c.byId) } }, select: { id: true, name: true } }),
    ]);
    const canEdit = await this.canEdit(me, g);
    return {
      id: g.id,
      title: g.title,
      level: g.level as GoalLevel,
      owner,
      department,
      metricKey: g.metricKey,
      metricLabel: def?.label ?? null,
      direction: g.direction as 'higher' | 'lower',
      startValue: g.startValue,
      target: g.target,
      current,
      unit: g.unit,
      display: { current: show(current), target: hidden ? 'not shown to your role' : unit ? formatMetric(g.target, unit) : show(g.target) },
      progress: hidden ? 0 : progress,
      status: goalStatus(hidden ? 0 : progress, isoOf(g.startDate), isoOf(g.endDate)),
      startDate: isoOf(g.startDate),
      endDate: isoOf(g.endDate),
      checkIns: g.checkIns
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, 20)
        .map((c) => ({ id: c.id, value: c.value, note: c.note, by: names.find((n) => n.id === c.byId)?.name ?? 'Someone', createdAt: c.createdAt.toISOString() })),
      canEdit,
      canCheckIn: !def && (canEdit || g.ownerId === me.id),
    };
  }

  /** Metric-linked goals: the metric's value from the goal's start to today (or its end). */
  private async metricValues(orgId: string, goals: Goal[]) {
    const out = new Map<string, number | null>();
    const linked = goals.filter((g) => g.metricKey);
    if (!linked.length) return out;
    const actor = await systemActor(this.prisma, this.meService, orgId);
    if (!actor) return out;
    const today = todayIst();
    for (const g of linked) {
      const def = metricDef(g.metricKey!)!;
      const to = isoOf(g.endDate) < today ? isoOf(g.endDate) : today;
      const from = isoOf(g.startDate) > to ? to : isoOf(g.startDate);
      // Metric values are worked out at most once every 5 minutes per goal (dashboards ask often).
      const key = `${g.id}|${g.metricKey}|${from}|${to}`;
      const hit = valueCache.get(key);
      if (hit && Date.now() - hit.at < 300_000) {
        out.set(g.id, hit.value);
        continue;
      }
      const value = (await this.metrics.pair(actor, def, { from, to }, null).catch(() => ({ value: null }))).value;
      valueCache.set(key, { value, at: Date.now() });
      out.set(g.id, value);
    }
    return out;
  }

  async list(me: Me, q: { archived?: string } = {}): Promise<{ goals: GoalView[]; canCreateCompany: boolean }> {
    if (me.type !== 'staff') throw new ForbiddenException('Goals are for the BMU team');
    const everything = canReadCommand(me);
    const dept = everything ? null : (await this.prisma.user.findUnique({ where: { id: me.id }, select: { departmentId: true } }))?.departmentId;
    const where = everything
      ? {}
      : { OR: [{ level: 'company' }, { level: 'team', departmentId: dept ?? '__none__' }, { level: 'person', ownerId: me.id }, { createdById: me.id }] };
    const rows = await this.prisma.goal.findMany({ where: { orgId: me.orgId, archivedAt: q.archived === '1' ? { not: null } : null, ...where }, include: { checkIns: true }, orderBy: [{ level: 'asc' }, { endDate: 'asc' }] });
    const visible = new Set((await this.metrics.visible(me)).map((m) => m.key));
    const values = await this.metricValues(me.orgId, rows);
    const goals = await Promise.all(rows.map((g) => this.view(me, g, visible, values)));
    const order: Record<string, number> = { company: 0, team: 1, person: 2 };
    goals.sort((a, b) => order[a.level] - order[b.level] || a.endDate.localeCompare(b.endDate));
    return { goals, canCreateCompany: this.isAdmin(me) };
  }

  async create(me: Me, body: unknown, ip?: string) {
    const input = parse(goalSchema, body);
    const ownerId = input.level === 'person' ? (input.ownerId ?? me.id) : null;
    const departmentId = input.level === 'team' ? (input.departmentId ?? null) : null;
    if (!(await this.canEdit(me, { level: input.level, ownerId, departmentId }))) throw new ForbiddenException(input.level === 'company' ? 'Only the Founder or a Branch Manager can set company goals' : 'You can set goals for yourself, or for your team if you lead it');
    if (input.metricKey) await this.metrics.assertCanSee(me, input.metricKey);
    const g = await this.prisma.goal.create({
      data: { orgId: me.orgId, title: input.title, level: input.level, ownerId, departmentId, metricKey: input.metricKey ?? null, direction: input.direction, startValue: input.startValue, target: input.target, unit: input.unit, startDate: new Date(`${input.startDate}T00:00:00Z`), endDate: new Date(`${input.endDate}T00:00:00Z`), createdById: me.id },
      include: { checkIns: true },
    });
    await this.audit.log(me, 'goal.created', 'Goal', g.id, undefined, input, ip);
    return this.one(me, g.id);
  }

  async one(me: Me, id: string): Promise<GoalView> {
    const g = await this.prisma.goal.findFirst({ where: { id, orgId: me.orgId }, include: { checkIns: true } });
    if (!g) throw new NotFoundException('Goal not found');
    const visible = new Set((await this.metrics.visible(me)).map((m) => m.key));
    return this.view(me, g, visible, await this.metricValues(me.orgId, [g]));
  }

  async update(me: Me, id: string, body: unknown, ip?: string) {
    const before = await this.prisma.goal.findFirst({ where: { id, orgId: me.orgId } });
    if (!before) throw new NotFoundException('Goal not found');
    if (!(await this.canEdit(me, before))) throw new ForbiddenException("You can't change this goal");
    const b = body as { archived?: boolean };
    if (typeof b.archived === 'boolean') {
      await this.prisma.goal.update({ where: { id }, data: { archivedAt: b.archived ? new Date() : null } });
      await this.audit.log(me, b.archived ? 'goal.archived' : 'goal.restored', 'Goal', id, undefined, undefined, ip);
      return this.one(me, id);
    }
    const input = parse(goalSchema, { ...before, startDate: isoOf(before.startDate), endDate: isoOf(before.endDate), ...(body as object) });
    if (input.level !== before.level && !this.isAdmin(me)) throw new ForbiddenException('Only the Founder or a Branch Manager can change what a goal is for');
    const g = await this.prisma.goal.update({
      where: { id },
      data: { title: input.title, direction: input.direction, startValue: input.startValue, target: input.target, unit: input.unit, metricKey: input.metricKey ?? null, startDate: new Date(`${input.startDate}T00:00:00Z`), endDate: new Date(`${input.endDate}T00:00:00Z`) },
    });
    await this.audit.log(me, 'goal.updated', 'Goal', id, before, g, ip);
    return this.one(me, id);
  }

  async checkIn(me: Me, id: string, body: unknown, ip?: string) {
    const g = await this.prisma.goal.findFirst({ where: { id, orgId: me.orgId } });
    if (!g) throw new NotFoundException('Goal not found');
    if (g.metricKey) throw new ForbiddenException('This goal follows its metric automatically');
    if (g.ownerId !== me.id && !(await this.canEdit(me, g))) throw new ForbiddenException("You can't update this goal");
    const input = parse(goalCheckInSchema, body);
    await this.prisma.goalCheckIn.create({ data: { goalId: id, value: input.value, note: input.note ?? null, byId: me.id } });
    await this.audit.log(me, 'goal.checked_in', 'Goal', id, undefined, input, ip);
    return this.one(me, id);
  }
}
