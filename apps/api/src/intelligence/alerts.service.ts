// v20 anomaly alerts: rules on any metric ("a client's activity drops 40%", "missed reply times double"), checked
// every morning; a firing rule notifies the chosen roles and people, at most once per window for the same subject.
import { ForbiddenException, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { alertFires, BUILT_IN_ALERTS, describeAlert, formatMetric, metricAlertSchema, metricDef, type AlertCondition, type Me, type MetricAlertEventView, type MetricAlertView } from '@bmu/shared';
import type { MetricAlert } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { MeService } from '../auth/me.service.js';
import { parse } from '../common/zod.js';
import { assertCommand } from '../insights/access.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { todayIst } from '../money/dates.js';
import { MetricsService, windowOf } from './metrics.service.js';
import { systemActor } from './actor.js';
import { claimOnce } from '../runtime/claims.js';
import { startJob, type JobHandle } from '../runtime/jobs.js';

const DAY = 86_400_000;
const EDITORS = ['founder', 'admin'];

@Injectable()
export class AlertsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Alerts');
  private job?: JobHandle;
  private lastRunDay = '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly meService: MeService,
    private readonly metrics: MetricsService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    this.job = startJob({ name: 'intelligence.alerts', hint: 'Daily metric alerts (after 08:00 IST)', everyMs: 30 * 60_000, run: () => this.daily() });
    // Checked once a day after 08:00 IST, so alerts arrive with the working day.
  }

  onModuleDestroy() {
    this.job?.stop();
  }

  private async daily() {
    const day = todayIst();
    if (this.lastRunDay === day || new Date(Date.now() + 330 * 60_000).getUTCHours() < 8) return;
    this.lastRunDay = day;
    if (!(await claimOnce(this.prisma, `intelligence.alerts:${day}`))) return;
    for (const o of await this.prisma.organisation.findMany({ select: { id: true } })) await this.check(o.id);
  }

  private canEdit(me: Me) {
    return me.type === 'staff' && me.roles.some((r) => EDITORS.includes(r));
  }

  async ensureBuiltIns(orgId: string) {
    if (await this.prisma.metricAlert.count({ where: { orgId, builtIn: true } })) return;
    await this.prisma.metricAlert.createMany({ data: BUILT_IN_ALERTS.map((a) => ({ orgId, name: a.name, metricKey: a.metricKey, scope: a.scope ?? 'org', condition: a.condition, threshold: a.threshold, windowDays: a.windowDays ?? 7, roles: a.roles ?? [], userIds: a.userIds ?? [], builtIn: true })) });
  }

  private async view(a: MetricAlert, clients?: Map<string, string>): Promise<MetricAlertView> {
    const clientName = a.clientOrgId ? (clients?.get(a.clientOrgId) ?? (await this.prisma.clientOrg.findUnique({ where: { id: a.clientOrgId }, select: { name: true } }))?.name ?? null) : null;
    return {
      id: a.id,
      name: a.name,
      metricKey: a.metricKey,
      metricLabel: metricDef(a.metricKey)?.label ?? a.metricKey,
      scope: a.scope as MetricAlertView['scope'],
      clientOrgId: a.clientOrgId,
      clientName,
      condition: a.condition as AlertCondition,
      threshold: a.threshold,
      windowDays: a.windowDays,
      roles: a.roles,
      userIds: a.userIds,
      active: a.active,
      builtIn: a.builtIn,
      lastValue: a.lastValue,
      lastCheckedAt: a.lastCheckedAt?.toISOString() ?? null,
      lastFiredAt: a.lastFiredAt?.toISOString() ?? null,
      summary: describeAlert({ metricKey: a.metricKey, scope: a.scope, condition: a.condition as AlertCondition, threshold: a.threshold, windowDays: a.windowDays }, clientName),
    };
  }

  async list(me: Me): Promise<{ alerts: MetricAlertView[]; events: MetricAlertEventView[]; canEdit: boolean }> {
    assertCommand(me);
    await this.ensureBuiltIns(me.orgId);
    const visible = new Set((await this.metrics.visible(me)).map((m) => m.key));
    const rows = (await this.prisma.metricAlert.findMany({ where: { orgId: me.orgId }, orderBy: [{ builtIn: 'desc' }, { createdAt: 'asc' }] })).filter((a) => visible.has(a.metricKey));
    const clients = new Map((await this.prisma.clientOrg.findMany({ where: { orgId: me.orgId }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
    return { alerts: await Promise.all(rows.map((a) => this.view(a, clients))), events: await this.events(me, rows.map((r) => r.id)), canEdit: this.canEdit(me) };
  }

  /** Recent alerts on metrics this person may see. */
  async visibleEvents(me: Me, take = 10) {
    const visible = new Set((await this.metrics.visible(me)).map((m) => m.key));
    const ids = (await this.prisma.metricAlert.findMany({ where: { orgId: me.orgId }, select: { id: true, metricKey: true } })).filter((a) => visible.has(a.metricKey)).map((a) => a.id);
    return this.events(me, ids, take);
  }

  async events(me: Me, alertIds?: string[], take = 30): Promise<MetricAlertEventView[]> {
    const rows = await this.prisma.metricAlertEvent.findMany({ where: { orgId: me.orgId, ...(alertIds ? { alertId: { in: alertIds } } : {}) }, orderBy: { createdAt: 'desc' }, take });
    const names = new Map((await this.prisma.metricAlert.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.alertId))] } }, select: { id: true, name: true } })).map((a) => [a.id, a.name]));
    return rows.map((r) => ({ id: r.id, alertId: r.alertId, alertName: names.get(r.alertId) ?? 'Alert', subject: r.subject, value: r.value, baseline: r.baseline, message: r.message, createdAt: r.createdAt.toISOString() }));
  }

  async create(me: Me, body: unknown, ip?: string) {
    if (!this.canEdit(me)) throw new ForbiddenException('Only the Founder or an Admin can set up alerts');
    const input = parse(metricAlertSchema, body);
    await this.metrics.assertCanSee(me, input.metricKey);
    const a = await this.prisma.metricAlert.create({ data: { orgId: me.orgId, ...input, clientOrgId: input.scope === 'client' ? input.clientOrgId : null, createdById: me.id } });
    await this.audit.log(me, 'alert.created', 'MetricAlert', a.id, undefined, input, ip);
    return this.view(a);
  }

  async update(me: Me, id: string, body: unknown, ip?: string) {
    if (!this.canEdit(me)) throw new ForbiddenException('Only the Founder or an Admin can change alerts');
    const before = await this.prisma.metricAlert.findFirst({ where: { id, orgId: me.orgId } });
    if (!before) throw new NotFoundException('Alert not found');
    const input = parse(metricAlertSchema, { ...before, clientOrgId: before.clientOrgId, ...(body as object) });
    const a = await this.prisma.metricAlert.update({ where: { id }, data: { name: input.name, metricKey: input.metricKey, scope: input.scope, clientOrgId: input.scope === 'client' ? input.clientOrgId : null, condition: input.condition, threshold: input.threshold, windowDays: input.windowDays, roles: input.roles, userIds: input.userIds, active: input.active } });
    await this.audit.log(me, 'alert.updated', 'MetricAlert', id, before, a, ip);
    return this.view(a);
  }

  async remove(me: Me, id: string, ip?: string) {
    if (!this.canEdit(me)) throw new ForbiddenException('Only the Founder or an Admin can delete alerts');
    const a = await this.prisma.metricAlert.findFirst({ where: { id, orgId: me.orgId } });
    if (!a) throw new NotFoundException('Alert not found');
    if (a.builtIn) throw new ForbiddenException('Built-in alerts can be switched off but not deleted');
    await this.prisma.metricAlertEvent.deleteMany({ where: { alertId: id } });
    await this.prisma.metricAlert.delete({ where: { id } });
    await this.audit.log(me, 'alert.deleted', 'MetricAlert', id, a, undefined, ip);
    return { ok: true as const };
  }

  /** Evaluates every active alert now. Returns the events created. */
  async check(orgId: string): Promise<MetricAlertEventView[]> {
    await this.ensureBuiltIns(orgId);
    const actor = await systemActor(this.prisma, this.meService, orgId);
    if (!actor) return [];
    const alerts = await this.prisma.metricAlert.findMany({ where: { orgId, active: true } });
    const fired: MetricAlertEventView[] = [];
    for (const a of alerts) {
      try {
        fired.push(...(await this.checkOne(actor, a)));
      } catch (e) {
        this.log.warn(`Alert "${a.name}" could not be checked: ${(e as Error).message}`);
      }
    }
    return fired;
  }

  private async checkOne(actor: Me, a: MetricAlert): Promise<MetricAlertEventView[]> {
    const def = metricDef(a.metricKey);
    if (!def) return [];
    const period = windowOf(a.windowDays);
    const subjects: { subject: string; label: string; link: string; value: number | null; previous: number | null }[] = [];
    if (a.scope === 'each_client') {
      const values = await this.metrics.perClient(actor, def, period);
      const names = new Map((await this.prisma.clientOrg.findMany({ where: { id: { in: [...values.keys()] }, deletedAt: null, archivedAt: null }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
      for (const [id, v] of values) if (names.has(id)) subjects.push({ subject: id, label: names.get(id)!, link: `/team/clients/${id}`, ...v });
    } else {
      const v = await this.metrics.pair(actor, def, period, a.scope === 'client' ? a.clientOrgId : null);
      const name = a.clientOrgId ? (await this.prisma.clientOrg.findUnique({ where: { id: a.clientOrgId }, select: { name: true } }))?.name : null;
      subjects.push({ subject: a.clientOrgId ?? 'org', label: name ?? 'the business', link: a.clientOrgId ? `/team/clients/${a.clientOrgId}` : '/admin/intelligence', ...v });
    }
    const now = new Date();
    const out: MetricAlertEventView[] = [];
    const quiet = Math.max(1, a.windowDays) * DAY;
    for (const s of subjects) {
      if (!alertFires(a.condition as AlertCondition, a.threshold, s.value, s.previous)) continue;
      const recent = await this.prisma.metricAlertEvent.findFirst({ where: { alertId: a.id, subject: s.subject, createdAt: { gte: new Date(now.getTime() - quiet) } } });
      if (recent) continue;
      const v = formatMetric(s.value, def.unit);
      const p = formatMetric(s.previous, def.unit);
      const change = s.previous ? Math.round((((s.value ?? 0) - s.previous) / s.previous) * 100) : null;
      const message =
        a.condition === 'drop_pct' || a.condition === 'rise_pct'
          ? `${def.label} for ${s.label} ${change! < 0 ? 'fell' : 'rose'} ${Math.abs(change ?? 0)}% (${p} → ${v}) in the last ${a.windowDays} days compared with the ${a.windowDays} before.`
          : `${def.label} for ${s.label} is ${v}, ${a.condition === 'above' ? 'above' : 'below'} the limit of ${formatMetric(a.threshold, def.unit)}.`;
      const e = await this.prisma.metricAlertEvent.create({ data: { orgId: a.orgId, alertId: a.id, subject: s.subject, value: s.value ?? 0, baseline: s.previous, message } });
      out.push({ id: e.id, alertId: a.id, alertName: a.name, subject: s.subject, value: e.value, baseline: e.baseline, message, createdAt: e.createdAt.toISOString() });
      const people = await this.prisma.user.findMany({ where: { orgId: a.orgId, deletedAt: null, status: 'active', OR: [{ id: { in: a.userIds } }, { roles: { some: { role: { baseRole: { in: a.roles } } } } }] }, select: { id: true } });
      await this.notifications.notify(a.orgId, people.map((x) => x.id), { kind: 'automation', title: a.name, body: message, link: s.link });
      await this.audit.logSystem(a.orgId, 'alert.fired', 'MetricAlert', a.id, { subject: s.subject, value: s.value, previous: s.previous });
    }
    const first = subjects.length === 1 ? subjects[0].value : null;
    await this.prisma.metricAlert.update({ where: { id: a.id }, data: { lastCheckedAt: now, lastValue: first, ...(out.length ? { lastFiredAt: now } : {}) } });
    return out;
  }
}
