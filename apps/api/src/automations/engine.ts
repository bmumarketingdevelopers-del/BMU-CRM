// The automation engine: every 60 seconds, for each switched-on rule, find matching records and run the
// actions once per (rule, record, dedupeKey). One bad rule never stops the others.
import { ConflictException, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { AiDigestService } from '../ai/ai-digest.js';
import {
  automationActionSchema,
  automationConditionSchema,
  automationTrigger,
  type AutomationAction,
  type AutomationCondition,
  type AutomationRunDetail,
  type AutomationRunNowResult,
  type AutomationRunStatus,
  type AutomationStep,
  type AutomationTestMatch,
  type AutomationTriggerKey,
} from '@bmu/shared';
import { z } from 'zod';
import { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { calendarFor } from '../production/generate.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { EmailService } from '../service/email.service.js';
import { checkConditions, runAction, type ActionCtx } from './actions.js';
import { findSubjects, type Subject } from './subjects.js';
import { startJob, type JobHandle } from '../runtime/jobs.js';

const DAY = 86_400_000;
const INTERVAL_MS = 60_000;
/** Event triggers never look back further than this, even if the rule is older (keeps sweeps cheap). */
const EVENT_LOOKBACK_MS = 14 * DAY;
/** State triggers (overdue, idle) also catch records that crossed the line up to a week before the rule was switched on. */
const STATE_CATCH_UP_MS = 7 * DAY;

export type RuleLike = {
  id: string;
  orgId: string;
  name: string;
  trigger: string;
  triggerArgs: unknown;
  conditions: unknown;
  actions: unknown;
  watermark: Date;
  createdById: string | null;
};

const parsedActions = (raw: unknown): AutomationAction[] => z.array(automationActionSchema).catch([]).parse(raw);
const parsedConditions = (raw: unknown): AutomationCondition[] => z.array(automationConditionSchema).catch([]).parse(raw);
const parsedArgs = (raw: unknown) => (raw && typeof raw === 'object' ? (raw as Record<string, string | number>) : {});

@Injectable()
export class AutomationsEngine implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Automations');
  private job?: JobHandle;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
    @Optional() private readonly ai?: AiDigestService,
  ) {}

  onModuleInit() {
    this.job = startJob({ name: 'automations.engine', hint: 'Runs automation rules, reminders and digests', everyMs: INTERVAL_MS, run: () => this.sweep() });
    if (this.job) this.log.log('Automation engine started (every 60 seconds)');
  }

  onModuleDestroy() {
    this.job?.stop();
  }

  /** Runs every enabled rule (optionally one org / one rule). Returns null when a sweep is already running. */
  async sweep(opts: { orgId?: string; ruleId?: string } = {}): Promise<AutomationRunNowResult | null> {
    if (this.running) return null;
    this.running = true;
    const started = Date.now();
    const total: AutomationRunNowResult = { rules: 0, fired: 0, failed: 0, skipped: 0, tookMs: 0 };
    try {
      const rules = await this.prisma.automationRule.findMany({
        where: { enabled: true, deletedAt: null, ...(opts.orgId ? { orgId: opts.orgId } : {}), ...(opts.ruleId ? { id: opts.ruleId } : {}) },
        orderBy: { createdAt: 'asc' },
      });
      const lastAssigned = new Map<string, string>();
      for (const rule of rules) {
        total.rules++;
        try {
          const r = await this.runRule(rule, lastAssigned);
          total.fired += r.success;
          total.failed += r.failed;
          total.skipped += r.skipped;
        } catch (e) {
          total.failed++;
          this.log.error(`Rule "${rule.name}" (${rule.id}) failed: ${(e as Error).message}`);
        }
      }
    } finally {
      this.running = false;
    }
    total.tookMs = Date.now() - started;
    if (total.fired + total.failed + total.skipped > 0) this.log.log(`Sweep: ${total.fired} done, ${total.failed} failed, ${total.skipped} skipped across ${total.rules} rules`);
    return total;
  }

  /** run-now for an org: refuses politely when the background sweep is mid-run. */
  async runNow(orgId: string, ruleId?: string) {
    const r = await this.sweep({ orgId, ruleId });
    if (!r) throw new ConflictException('Automations are already running. Try again in a few seconds.');
    return r;
  }

  private bounds(rule: RuleLike, now: Date) {
    const def = automationTrigger(rule.trigger);
    const event = def?.event ?? true;
    const start = event ? new Date(Math.max(rule.watermark.getTime(), now.getTime() - EVENT_LOOKBACK_MS)) : new Date(rule.watermark.getTime() - STATE_CATCH_UP_MS);
    return { event, start };
  }

  private async systemAuthor(orgId: string) {
    const f = await this.prisma.user.findFirst({ where: { orgId, deletedAt: null, type: 'staff', roles: { some: { role: { baseRole: 'founder' } } } }, select: { id: true } });
    return f?.id ?? null;
  }

  private async runRule(rule: RuleLike, lastAssigned: Map<string, string>) {
    const now = new Date();
    const counts = { success: 0, failed: 0, skipped: 0 };
    const { start } = this.bounds(rule, now);
    const subjects = await findSubjects(rule.trigger as AutomationTriggerKey, { prisma: this.prisma, orgId: rule.orgId, args: parsedArgs(rule.triggerArgs), from: start, now });
    if (!subjects.length) return counts;
    const conditions = parsedConditions(rule.conditions);
    const actions = parsedActions(rule.actions);
    const done = await this.prisma.automationRun.findMany({
      where: { ruleId: rule.id, entityId: { in: subjects.map((s) => s.entityId) } },
      select: { entity: true, entityId: true, dedupeKey: true },
    });
    const seen = new Set(done.map((d) => `${d.entity}|${d.entityId}|${d.dedupeKey}`));
    const calendar = await calendarFor(this.prisma, rule.orgId);
    const systemAuthorId = await this.systemAuthor(rule.orgId);

    for (const s of subjects) {
      if (seen.has(`${s.entity}|${s.entityId}|${s.dedupeKey}`)) continue;
      if (s.at < start) continue;
      if (!checkConditions(rule.trigger, conditions, s).passes) continue;
      seen.add(`${s.entity}|${s.entityId}|${s.dedupeKey}`);
      // Claim the (rule, record, key) first so two sweeps can never both act.
      let runId: string;
      try {
        runId = (
          await this.prisma.automationRun.create({
            data: { orgId: rule.orgId, ruleId: rule.id, entity: s.entity, entityId: s.entityId, dedupeKey: s.dedupeKey, status: 'skipped', detail: { summary: 'Running…', record: s.record, link: s.link } },
          })
        ).id;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
        throw e;
      }
      const meta: Record<string, string> = {};
      const steps: AutomationStep[] = [];
      for (const a of actions) {
        const ctx: ActionCtx = { prisma: this.prisma, audit: this.audit, orgId: rule.orgId, rule, subject: s, dryRun: false, now, calendar, lastAssigned, systemAuthorId, meta, notifications: this.notifications, email: this.email, ai: this.ai };
        try {
          steps.push(await runAction(ctx, a));
        } catch (e) {
          steps.push({ action: a.type, ok: false, text: `Could not ${a.type.replace(/_/g, ' ')}: ${(e as Error).message.split('\n')[0].slice(0, 200)}` });
        }
      }
      const status: AutomationRunStatus = steps.some((x) => !x.ok) ? 'failed' : steps.length && steps.every((x) => x.skipped) ? 'skipped' : 'success';
      const doneSteps = steps.filter((x) => x.ok && !x.skipped).length;
      const summary =
        status === 'success'
          ? `${doneSteps} action${doneSteps === 1 ? '' : 's'} done for ${s.record}`
          : status === 'failed'
            ? `${steps.filter((x) => !x.ok).length} of ${steps.length} actions failed for ${s.record}`
            : `Nothing to do for ${s.record}`;
      const detail: AutomationRunDetail & { meta?: Record<string, string> } = { summary, record: s.record, link: s.link, steps, ...(Object.keys(meta).length ? { meta } : {}) };
      await this.prisma.automationRun.update({ where: { id: runId }, data: { status, detail: JSON.parse(JSON.stringify(detail)), at: new Date() } });
      counts[status]++;
    }
    const fired = counts.success + counts.failed + counts.skipped;
    if (fired) await this.prisma.automationRule.update({ where: { id: rule.id }, data: { runCount: { increment: fired }, lastRunAt: new Date() } });
    return counts;
  }

  /** Dry run: which records match right now and what would happen. Changes nothing. */
  async dryRun(rule: RuleLike): Promise<{ considered: number; matches: AutomationTestMatch[] }> {
    const now = new Date();
    const { event, start } = this.bounds(rule, now);
    // For testing, also show recent records from before the rule started (flagged, never acted on).
    const testFrom = event ? new Date(Math.min(start.getTime(), now.getTime() - 7 * DAY)) : new Date(Math.min(start.getTime(), now.getTime() - 30 * DAY));
    const subjects = await findSubjects(rule.trigger as AutomationTriggerKey, { prisma: this.prisma, orgId: rule.orgId, args: parsedArgs(rule.triggerArgs), from: testFrom, now });
    const conditions = parsedConditions(rule.conditions);
    const actions = parsedActions(rule.actions);
    const done = rule.id
      ? await this.prisma.automationRun.findMany({ where: { ruleId: rule.id, entityId: { in: subjects.map((s) => s.entityId) } }, select: { entity: true, entityId: true, dedupeKey: true } })
      : [];
    const seen = new Set(done.map((d) => `${d.entity}|${d.entityId}|${d.dedupeKey}`));
    const calendar = await calendarFor(this.prisma, rule.orgId);
    const systemAuthorId = await this.systemAuthor(rule.orgId);
    const matches: AutomationTestMatch[] = [];
    for (const s of subjects.slice(0, 50)) {
      const alreadyDone = seen.has(`${s.entity}|${s.entityId}|${s.dedupeKey}`);
      const beforeStart = s.at < start;
      const cond = checkConditions(rule.trigger, conditions, s);
      const wouldDo: string[] = [];
      if (cond.passes && !alreadyDone) {
        for (const a of actions) {
          const ctx: ActionCtx = { prisma: this.prisma, audit: this.audit, orgId: rule.orgId, rule, subject: s, dryRun: true, now, calendar, lastAssigned: new Map(), systemAuthorId, meta: {}, email: this.email };
          try {
            wouldDo.push((await runAction(ctx, a)).text);
          } catch (e) {
            wouldDo.push(`Would fail: ${(e as Error).message}`);
          }
        }
      }
      matches.push({ entity: s.entity, entityId: s.entityId, record: s.record, link: s.link, alreadyDone, beforeStart, passes: cond.passes, failedCondition: cond.failed, wouldDo });
    }
    return { considered: subjects.length, matches };
  }
}

export type { Subject };
