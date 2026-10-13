import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AUTOMATION_TEMPLATES,
  automationRuleInputSchema,
  automationSentence,
  automationTrigger,
  hierarchyData,
  istDate,
  type AutomationAction,
  type AutomationCondition,
  type AutomationOptions,
  type AutomationOverview,
  type AutomationRuleData,
  type AutomationRuleDetail,
  type AutomationRuleRow,
  type AutomationRunDetail,
  type AutomationRunFilters,
  type AutomationRunRow,
  type AutomationRunStatus,
  type AutomationTestResult,
  type AutomationTriggerKey,
  type Me,
} from '@bmu/shared';
import type { AutomationRule, AutomationRun, Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AutomationsEngine } from './engine.js';
import { webhookUrlProblem } from './url-guard.js';

const DAY = 86_400_000;
const MANAGERS = ['founder', 'admin'];
const VIEWERS = [...MANAGERS, 'department_head', 'am_lead', 'finance'];

export const canManageAutomations = (me: Me) => me.type === 'staff' && me.roles.some((r) => MANAGERS.includes(r));
export const canViewAutomations = (me: Me) => me.type === 'staff' && me.roles.some((r) => VIEWERS.includes(r));

function assertView(me: Me) {
  if (!canViewAutomations(me)) throw new ForbiddenException('Automations are for Founder, Branch Manager, department heads, the AM Lead and Finance');
}
function assertManage(me: Me) {
  if (!canManageAutomations(me)) throw new ForbiddenException('Only the Founder and Branch Managers can change automations');
}

const snapshot = (r: AutomationRule) => ({ name: r.name, enabled: r.enabled, trigger: r.trigger, triggerArgs: r.triggerArgs, conditions: r.conditions, actions: r.actions });

@Injectable()
export class AutomationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: AutomationsEngine,
  ) {}

  private async userNames(orgId: string) {
    const users = await this.prisma.user.findMany({ where: { orgId, type: 'staff' }, select: { id: true, name: true } });
    return Object.fromEntries(users.map((u) => [u.id, u.name]));
  }

  private row(r: AutomationRule, names: Record<string, string>, failures30d = 0): AutomationRuleRow {
    const t = automationTrigger(r.trigger);
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      enabled: r.enabled,
      trigger: r.trigger as AutomationTriggerKey,
      triggerLabel: t?.label ?? r.trigger,
      area: t?.area ?? 'Sales',
      sentence: automationSentence({ trigger: r.trigger, triggerArgs: r.triggerArgs as Record<string, unknown>, conditions: r.conditions as AutomationCondition[], actions: r.actions as AutomationAction[] }, names),
      templateKey: r.templateKey,
      runCount: r.runCount,
      failures30d,
      lastRunAt: r.lastRunAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  }

  private runRow(r: AutomationRun & { rule: { name: string } }): AutomationRunRow {
    const d = (r.detail ?? {}) as AutomationRunDetail;
    return {
      id: r.id,
      ruleId: r.ruleId,
      ruleName: r.rule.name,
      entity: r.entity,
      entityId: r.entityId,
      status: r.status as AutomationRunStatus,
      summary: d.summary ?? '',
      record: d.record ?? null,
      link: d.link ?? null,
      steps: d.steps ?? [],
      at: r.at.toISOString(),
    };
  }

  private async findRule(me: Me, id: string) {
    const r = await this.prisma.automationRule.findFirst({ where: { id, orgId: me.orgId, deletedAt: null } });
    if (!r) throw new NotFoundException('Automation not found');
    return r;
  }

  // -------------------------------------------------------------------------
  // Read

  async overview(me: Me): Promise<AutomationOverview> {
    assertView(me);
    const now = new Date();
    const since30 = new Date(now.getTime() - 30 * DAY);
    const since7 = new Date(now.getTime() - 7 * DAY);
    const since14 = new Date(now.getTime() - 14 * DAY);
    const [rules, runs, names] = await Promise.all([
      this.prisma.automationRule.findMany({ where: { orgId: me.orgId, deletedAt: null }, orderBy: [{ enabled: 'desc' }, { createdAt: 'asc' }] }),
      this.prisma.automationRun.findMany({ where: { orgId: me.orgId, at: { gte: since30 }, rule: { deletedAt: null } }, select: { ruleId: true, status: true, at: true, detail: true } }),
      this.userNames(me.orgId),
    ]);
    const last7 = runs.filter((r) => r.at >= since7);
    const prev7 = runs.filter((r) => r.at >= since14 && r.at < since7);
    const actions7d = last7.reduce((s, r) => s + ((r.detail as AutomationRunDetail).steps ?? []).filter((x) => x.ok && !x.skipped).length, 0);

    const daily: AutomationOverview['daily'] = [];
    for (let i = 29; i >= 0; i--) daily.push({ date: istDate(new Date(now.getTime() - i * DAY)), success: 0, failed: 0, skipped: 0 });
    for (const r of runs) {
      const d = daily.find((x) => x.date === istDate(r.at));
      if (d && (r.status === 'success' || r.status === 'failed' || r.status === 'skipped')) d[r.status]++;
    }

    const installed = new Set(rules.map((r) => r.templateKey).filter(Boolean));
    const byRule = new Map<string, number>();
    for (const r of runs) byRule.set(r.ruleId, (byRule.get(r.ruleId) ?? 0) + 1);
    return {
      canManage: canManageAutomations(me),
      stats: { activeRules: rules.filter((r) => r.enabled).length, totalRules: rules.length, runs7d: last7.length, runsPrev7d: prev7.length, actions7d, failures7d: last7.filter((r) => r.status === 'failed').length },
      rules: rules.map((r) => this.row(r, names, runs.filter((x) => x.ruleId === r.id && x.status === 'failed').length)),
      daily,
      templates: AUTOMATION_TEMPLATES.map((t) => ({ ...t, installed: installed.has(t.key), sentence: automationSentence(automationRuleInputSchema.parse(t.rule)) })),
      topRules: [...byRule.entries()]
        .map(([id, n]) => ({ id, name: rules.find((r) => r.id === id)?.name ?? 'Deleted rule', runs: n }))
        .sort((a, b) => b.runs - a.runs)
        .slice(0, 5),
    };
  }

  async options(me: Me): Promise<AutomationOptions> {
    assertView(me);
    const users = await this.prisma.user.findMany({
      where: { orgId: me.orgId, type: 'staff', deletedAt: null, status: { not: 'suspended' } },
      select: { id: true, name: true, roles: { select: { role: { select: { baseRole: true } } } } },
      orderBy: { name: 'asc' },
    });
    return {
      canManage: canManageAutomations(me),
      users: users.map((u) => ({ id: u.id, name: u.name, roles: [...new Set(u.roles.map((r) => r.role.baseRole))] })),
      roles: hierarchyData.team_roles.map((r) => ({ value: r.id, label: r.name })),
    };
  }

  async get(me: Me, id: string): Promise<AutomationRuleDetail> {
    assertView(me);
    const r = await this.findRule(me, id);
    const [names, runs, failures, creator] = await Promise.all([
      this.userNames(me.orgId),
      this.prisma.automationRun.findMany({ where: { ruleId: r.id }, orderBy: { at: 'desc' }, take: 50, include: { rule: { select: { name: true } } } }),
      this.prisma.automationRun.count({ where: { ruleId: r.id, status: 'failed', at: { gte: new Date(Date.now() - 30 * DAY) } } }),
      r.createdById ? this.prisma.user.findUnique({ where: { id: r.createdById }, select: { name: true } }) : null,
    ]);
    return {
      ...this.row(r, names, failures),
      triggerArgs: r.triggerArgs as Record<string, string | number>,
      conditions: r.conditions as AutomationCondition[],
      actions: r.actions as AutomationAction[],
      watermark: r.watermark.toISOString(),
      createdBy: creator?.name ?? null,
      runs: runs.map((x) => this.runRow(x)),
    };
  }

  async runs(me: Me, f: AutomationRunFilters): Promise<AutomationRunRow[]> {
    assertView(me);
    const where: Prisma.AutomationRunWhereInput = { orgId: me.orgId };
    if (f.ruleId) where.ruleId = f.ruleId;
    if (f.status && ['success', 'failed', 'skipped'].includes(f.status)) where.status = f.status;
    const at: Prisma.DateTimeFilter = {};
    if (f.from && /^\d{4}-\d{2}-\d{2}$/.test(f.from)) at.gte = new Date(`${f.from}T00:00:00+05:30`);
    if (f.to && /^\d{4}-\d{2}-\d{2}$/.test(f.to)) at.lte = new Date(`${f.to}T23:59:59.999+05:30`);
    if (at.gte || at.lte) where.at = at;
    const rows = await this.prisma.automationRun.findMany({ where, orderBy: { at: 'desc' }, take: 500, include: { rule: { select: { name: true } } } });
    return rows.map((r) => this.runRow(r));
  }

  // -------------------------------------------------------------------------
  // Write

  private async validate(me: Me, raw: unknown): Promise<AutomationRuleData> {
    const parsed = automationRuleInputSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message ?? 'Check the rule');
    const data = parsed.data;
    const ids = new Set<string>();
    for (const a of data.actions) {
      if (a.type === 'webhook') {
        const p = webhookUrlProblem(a.url);
        if (p) throw new BadRequestException(p);
      }
      if ((a.type === 'notify' || a.type === 'email') && a.to === 'users') a.userIds?.forEach((x) => ids.add(x));
      if (a.type === 'create_task' && a.assignTo === 'user' && a.userId) ids.add(a.userId);
    }
    if (ids.size) {
      const n = await this.prisma.user.count({ where: { id: { in: [...ids] }, orgId: me.orgId, type: 'staff', deletedAt: null } });
      if (n !== ids.size) throw new BadRequestException('One of the chosen people is not on the team');
    }
    return data;
  }

  private dbData(d: AutomationRuleData) {
    return {
      name: d.name,
      description: d.description ?? null,
      enabled: d.enabled,
      trigger: d.trigger,
      triggerArgs: d.triggerArgs as Prisma.InputJsonValue,
      conditions: d.conditions as unknown as Prisma.InputJsonValue,
      actions: d.actions as unknown as Prisma.InputJsonValue,
    };
  }

  async create(me: Me, raw: unknown, ip?: string, templateKey?: string) {
    assertManage(me);
    const d = await this.validate(me, raw);
    const r = await this.prisma.automationRule.create({ data: { ...this.dbData(d), orgId: me.orgId, createdById: me.id, templateKey: templateKey ?? null, watermark: new Date() } });
    await this.audit.log(me, 'automation.created', 'AutomationRule', r.id, undefined, snapshot(r), ip);
    return this.get(me, r.id);
  }

  async fromTemplate(me: Me, templateKey: string, ip?: string) {
    assertManage(me);
    const t = AUTOMATION_TEMPLATES.find((x) => x.key === templateKey);
    if (!t) throw new NotFoundException('Template not found');
    return this.create(me, { ...t.rule, description: t.description, enabled: true }, ip, t.key);
  }

  async update(me: Me, id: string, raw: unknown, ip?: string) {
    assertManage(me);
    const before = await this.findRule(me, id);
    const d = await this.validate(me, raw);
    const restart = (!before.enabled && d.enabled) || before.trigger !== d.trigger;
    const r = await this.prisma.automationRule.update({ where: { id }, data: { ...this.dbData(d), ...(restart ? { watermark: new Date() } : {}) } });
    await this.audit.log(me, 'automation.updated', 'AutomationRule', id, snapshot(before), snapshot(r), ip);
    return this.get(me, id);
  }

  async setEnabled(me: Me, id: string, enabled: boolean, ip?: string) {
    assertManage(me);
    const before = await this.findRule(me, id);
    if (before.enabled !== enabled) {
      await this.prisma.automationRule.update({ where: { id }, data: { enabled, ...(enabled ? { watermark: new Date() } : {}) } });
      await this.audit.log(me, enabled ? 'automation.enabled' : 'automation.disabled', 'AutomationRule', id, { enabled: before.enabled }, { enabled }, ip);
    }
    return this.get(me, id);
  }

  async remove(me: Me, id: string, ip?: string) {
    assertManage(me);
    const before = await this.findRule(me, id);
    await this.prisma.automationRule.update({ where: { id }, data: { deletedAt: new Date(), enabled: false } });
    await this.audit.log(me, 'automation.deleted', 'AutomationRule', id, snapshot(before), undefined, ip);
    return { ok: true as const };
  }

  // -------------------------------------------------------------------------
  // Dry runs and run now

  private async testResult(me: Me, rule: Parameters<AutomationsEngine['dryRun']>[0], d: { trigger: string; triggerArgs: Record<string, unknown>; conditions: AutomationCondition[]; actions: AutomationAction[] }): Promise<AutomationTestResult> {
    const { considered, matches } = await this.engine.dryRun(rule);
    const names = await this.userNames(me.orgId);
    const t = automationTrigger(d.trigger);
    const willRun = matches.filter((m) => m.passes && !m.alreadyDone && !m.beforeStart).length;
    const note = t?.event
      ? 'This trigger acts only on records that arrive after the rule is switched on. Recent older records are shown as examples and will not be acted on.'
      : 'This trigger checks every open record. When a rule is switched on it also catches records that crossed the line in the 7 days before.';
    return { sentence: automationSentence(d, names), considered, willRun, matches, note };
  }

  async test(me: Me, id: string): Promise<AutomationTestResult> {
    assertView(me);
    const r = await this.findRule(me, id);
    return this.testResult(me, r, { trigger: r.trigger, triggerArgs: r.triggerArgs as Record<string, unknown>, conditions: r.conditions as AutomationCondition[], actions: r.actions as AutomationAction[] });
  }

  async testDraft(me: Me, raw: unknown): Promise<AutomationTestResult> {
    assertView(me);
    const d = await this.validate(me, raw);
    const draft = { id: '', orgId: me.orgId, name: d.name, trigger: d.trigger, triggerArgs: d.triggerArgs, conditions: d.conditions, actions: d.actions, watermark: new Date(), createdById: me.id };
    return this.testResult(me, draft, d);
  }

  async runNow(me: Me, ruleId?: string, ip?: string) {
    assertManage(me);
    if (ruleId) await this.findRule(me, ruleId);
    const r = await this.engine.runNow(me.orgId, ruleId);
    await this.audit.log(me, 'automation.run_now', 'AutomationRule', ruleId ?? 'all', undefined, r, ip);
    return r;
  }
}
