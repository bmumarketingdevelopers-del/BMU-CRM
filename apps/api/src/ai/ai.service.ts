// AI Copilot core: on/off and feature switches, budget and token caps, per-user rate limit, the model call with
// logging (every call, basic answer and blocked attempt becomes an AiLog row), usage for the Command Centre page.
import type Anthropic from '@anthropic-ai/sdk';
import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import {
  AI_BASIC_NOTICE,
  AI_FEATURE_GROUPS,
  aiFeatureInfo,
  formatINR,
  type AiCitation,
  type AiFeature,
  type AiResult,
  type AiSettings,
  type AiStatus,
  type AiStructured,
  type AiUsageView,
  type Me,
} from '@bmu/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { startOfMonth } from '../insights/ist.js';
import { AI_CLIENT, aiFastModel, aiModel, estimateCostPaise, type AiClient, type AiRunParams } from './ai-client.js';

export type AiWho = { orgId: string; userId: string | null; me?: Me };
export type AiOut = { text: string; data?: AiStructured | null; citations?: AiCitation[] };
export type AiRunner = (p: Omit<AiRunParams, 'model'> & { fast?: boolean }) => Promise<Anthropic.Beta.BetaMessage>;

/** Thrown when AI Copilot (or this feature) is switched off for the organisation. */
export class AiOffError extends ForbiddenException {}
export class AiRefusal extends Error {}

const HOUR = 3_600_000;
const MANAGERS = ['founder', 'admin'];

export const textOf = (m: Anthropic.Beta.BetaMessage) =>
  m.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

/** Parses a structured-output reply; null when it is not valid JSON. */
export function jsonOf<T>(m: Anthropic.Beta.BetaMessage): T | null {
  try {
    return JSON.parse(textOf(m)) as T;
  } catch {
    return null;
  }
}

@Injectable()
export class AiService {
  private readonly log = new Logger('AI');

  constructor(
    private readonly prisma: PrismaService,
    private readonly settingsService: SettingsService,
    @Inject(AI_CLIENT) private readonly client: AiClient,
  ) {}

  settings(orgId: string): Promise<AiSettings> {
    return this.settingsService.get(orgId, 'ai');
  }

  connected() {
    return this.client.available();
  }

  canManage(me: Me) {
    return me.type === 'staff' && me.roles.some((r) => MANAGERS.includes(r));
  }

  async status(me: Me): Promise<AiStatus> {
    const s = await this.settings(me.orgId);
    const connected = this.connected();
    const features = Object.fromEntries(AI_FEATURE_GROUPS.map((g) => [g, s.enabled && s.features[g]])) as AiStatus['features'];
    if (me.type === 'client') for (const g of AI_FEATURE_GROUPS) if (g !== 'clientPortal') features[g] = false;
    if (me.type === 'staff') features.clientPortal = false;
    if (me.type === 'creator') for (const g of AI_FEATURE_GROUPS) features[g] = false;
    return {
      enabled: s.enabled,
      connected,
      mode: !s.enabled ? 'off' : connected ? 'ai' : 'basic',
      model: aiModel(),
      fastModel: aiFastModel(),
      features,
      canManage: this.canManage(me),
      notice: !s.enabled ? 'AI Copilot is switched off for your organisation.' : connected ? null : AI_BASIC_NOTICE,
    };
  }

  /** Throws a plain-English 403 when the feature is switched off or not for this kind of user. */
  async assertOn(who: AiWho, feature: AiFeature): Promise<AiSettings> {
    const s = await this.settings(who.orgId);
    const group = aiFeatureInfo[feature].group;
    if (who.me?.type === 'creator') throw new AiOffError('AI Copilot is not available in the creator portal');
    if (who.me?.type === 'client' && group !== 'clientPortal') throw new AiOffError('This assistant is for the BMU team');
    if (who.me?.type === 'staff' && group === 'clientPortal') throw new AiOffError('This assistant is for client accounts');
    if (!s.enabled) throw new AiOffError('AI Copilot is switched off for your organisation. A Founder or Admin can turn it on in Command Centre → AI Copilot.');
    if (!s.features[group]) throw new AiOffError(`This AI feature is switched off. A Founder or Admin can turn it on in Command Centre → AI Copilot.`);
    return s;
  }

  private async monthSpend(orgId: string) {
    const agg = await this.prisma.aiLog.aggregate({
      where: { orgId, createdAt: { gte: startOfMonth(new Date()) }, mode: 'ai' },
      _sum: { costPaise: true, inputTokens: true, outputTokens: true },
    });
    return { costPaise: agg._sum.costPaise ?? 0, tokens: (agg._sum.inputTokens ?? 0) + (agg._sum.outputTokens ?? 0) };
  }

  /** Why this call must use basic mode (no key, budget used up, hourly limit), or null when AI may run. */
  private async blocker(who: AiWho, s: AiSettings): Promise<{ notice: string; status: 'basic' | 'blocked' } | null> {
    if (!this.connected()) return { notice: AI_BASIC_NOTICE, status: 'basic' };
    const spend = await this.monthSpend(who.orgId);
    if (s.monthlyBudgetPaise > 0 && spend.costPaise >= s.monthlyBudgetPaise)
      return { notice: `This month's AI budget (${formatINR(s.monthlyBudgetPaise)}) is used up, so these are basic suggestions. A Founder or Admin can raise it in Command Centre → AI Copilot.`, status: 'blocked' };
    if (s.monthlyTokenCap > 0 && spend.tokens >= s.monthlyTokenCap)
      return { notice: `This month's AI token limit is used up, so these are basic suggestions. A Founder or Admin can raise it in Command Centre → AI Copilot.`, status: 'blocked' };
    if (who.userId) {
      const recent = await this.prisma.aiLog.count({ where: { userId: who.userId, mode: 'ai', createdAt: { gte: new Date(Date.now() - HOUR) } } });
      if (recent >= s.perUserPerHour) return { notice: `You have used your ${s.perUserPerHour} AI answers for this hour, so these are basic suggestions. Try again a little later.`, status: 'blocked' };
    }
    return null;
  }

  /**
   * Runs one feature: AI when allowed, otherwise (or if the model fails) the deterministic basic version.
   * Always returns something useful and always writes one AiLog row.
   */
  async execute(
    who: AiWho,
    feature: AiFeature,
    opts: { target?: { type: string; id: string }; basic: () => Promise<AiOut> | AiOut; ai: (run: AiRunner) => Promise<AiOut>; forceBasic?: string | null },
  ): Promise<AiResult> {
    const s = await this.assertOn(who, feature);
    const started = Date.now();
    const base = { orgId: who.orgId, userId: who.userId, feature, targetType: opts.target?.type ?? null, targetId: opts.target?.id ?? null };
    const basic = async (notice: string, status: string, error?: string, usage?: Usage): Promise<AiResult> => {
      const out = await opts.basic();
      const row = await this.prisma.aiLog.create({
        data: {
          ...base,
          mode: usage?.calls ? 'ai' : 'basic',
          status,
          model: usage?.model ?? null,
          inputTokens: usage?.input ?? 0,
          outputTokens: usage?.output ?? 0,
          cacheReadTokens: usage?.cacheRead ?? 0,
          costPaise: usage?.cost ?? 0,
          latencyMs: Date.now() - started,
          error: error ?? null,
        },
      });
      return { feature, mode: 'basic', text: out.text, data: out.data ?? null, citations: out.citations ?? [], notice, logId: row.id };
    };

    // v15: a caller-side limit (e.g. an agent's own monthly budget) keeps this call in basic mode.
    if (opts.forceBasic) return basic(opts.forceBasic, 'blocked', opts.forceBasic);
    const blocked = await this.blocker(who, s);
    if (blocked) return basic(blocked.notice, blocked.status === 'basic' ? 'ok' : 'blocked', blocked.status === 'blocked' ? blocked.notice : undefined);

    const usage: Usage = { calls: 0, input: 0, output: 0, cacheRead: 0, cost: 0, model: null };
    const run: AiRunner = async ({ fast, ...p }) => {
      const model = (fast ?? aiFeatureInfo[feature].fast) ? aiFastModel() : aiModel();
      const msg = await this.client.run({ ...p, model });
      const u = msg.usage;
      usage.calls++;
      usage.model = model;
      usage.input += u.input_tokens ?? 0;
      usage.output += u.output_tokens ?? 0;
      usage.cacheRead += u.cache_read_input_tokens ?? 0;
      usage.cost += estimateCostPaise(model, u.input_tokens ?? 0, u.output_tokens ?? 0, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0);
      if (msg.stop_reason === 'refusal') throw new AiRefusal('The AI declined this request');
      return msg;
    };
    try {
      const out = await opts.ai(run);
      const row = await this.prisma.aiLog.create({
        data: {
          ...base,
          mode: 'ai',
          status: 'ok',
          model: usage.model,
          inputTokens: usage.input,
          outputTokens: usage.output,
          cacheReadTokens: usage.cacheRead,
          costPaise: usage.cost,
          latencyMs: Date.now() - started,
        },
      });
      return { feature, mode: 'ai', text: out.text, data: out.data ?? null, citations: out.citations ?? [], notice: null, logId: row.id };
    } catch (e) {
      const { notice, status, detail } = this.explain(e);
      this.log.warn(`${feature} fell back to basic mode: ${detail}`);
      return basic(notice, status, detail, usage);
    }
  }

  /** Plain words for a failed model call. Never includes the key or raw stack traces. */
  private explain(e: unknown): { notice: string; status: string; detail: string } {
    const err = e as { status?: number; name?: string; message?: string };
    if (e instanceof AiRefusal) return { notice: 'The AI declined to answer this one, so here are basic suggestions instead.', status: 'refused', detail: 'refusal' };
    const detail = `${err.name ?? 'Error'}${err.status ? ` ${err.status}` : ''}: ${String(err.message ?? '').replace(/sk-[A-Za-z0-9_-]+/g, '[key]').slice(0, 300)}`;
    if (err.status === 401 || err.status === 403)
      return { notice: 'The AI key was not accepted. Check ANTHROPIC_API_KEY in apps/api/.env (see Command Centre → AI Copilot). Showing basic suggestions.', status: 'error', detail };
    if (err.status === 429) return { notice: 'The AI service is busy right now. Showing basic suggestions; try again in a minute.', status: 'error', detail };
    return { notice: 'The AI could not answer just now, so here are basic suggestions. Try again in a minute.', status: 'error', detail };
  }

  // -------------------------------------------------------------------------
  // Command Centre → AI Copilot

  private assertManager(me: Me) {
    if (!this.canManage(me)) throw new ForbiddenException('AI Copilot settings are for the Founder and Admins');
  }

  async usage(me: Me): Promise<AiUsageView> {
    this.assertManager(me);
    const settings = await this.settings(me.orgId);
    const now = new Date();
    const from = startOfMonth(now);
    const rows = await this.prisma.aiLog.findMany({ where: { orgId: me.orgId, createdAt: { gte: from } }, orderBy: { createdAt: 'desc' } });
    const users = new Map(
      (await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.userId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]),
    );
    const ai = rows.filter((r) => r.mode === 'ai');
    const sum = (list: typeof rows, k: 'costPaise' | 'inputTokens' | 'outputTokens' | 'latencyMs') => list.reduce((s, r) => s + r[k], 0);
    const cost = sum(ai, 'costPaise');
    const tokens = sum(ai, 'inputTokens') + sum(ai, 'outputTokens');

    const byFeature = new Map<string, { calls: number; costPaise: number; latency: number }>();
    const byUser = new Map<string, { calls: number; costPaise: number }>();
    for (const r of rows) {
      const f = byFeature.get(r.feature) ?? { calls: 0, costPaise: 0, latency: 0 };
      f.calls++;
      f.costPaise += r.costPaise;
      f.latency += r.latencyMs;
      byFeature.set(r.feature, f);
      if (r.userId) {
        const u = byUser.get(r.userId) ?? { calls: 0, costPaise: 0 };
        u.calls++;
        u.costPaise += r.costPaise;
        byUser.set(r.userId, u);
      }
    }
    const days = Math.max(1, Math.ceil((now.getTime() - from.getTime()) / 86_400_000));
    const labels: string[] = [];
    const calls: number[] = [];
    for (let i = 0; i < days; i++) {
      const start = new Date(from.getTime() + i * 86_400_000);
      const end = new Date(start.getTime() + 86_400_000);
      labels.push(new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }).format(start));
      calls.push(rows.filter((r) => r.createdAt >= start && r.createdAt < end).length);
    }
    const label = (f: string) => (aiFeatureInfo as Record<string, { label: string }>)[f]?.label ?? f;
    return {
      settings,
      connected: this.connected(),
      model: aiModel(),
      fastModel: aiFastModel(),
      canEdit: this.canManage(me),
      month: {
        label: new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(now),
        calls: rows.length,
        aiCalls: ai.length,
        basicCalls: rows.filter((r) => r.mode === 'basic').length,
        blocked: rows.filter((r) => r.status === 'blocked').length,
        errors: rows.filter((r) => r.status === 'error').length,
        inputTokens: sum(ai, 'inputTokens'),
        outputTokens: sum(ai, 'outputTokens'),
        costPaise: cost,
        budgetPct: settings.monthlyBudgetPaise > 0 ? Math.round((cost / settings.monthlyBudgetPaise) * 100) : null,
        tokenPct: settings.monthlyTokenCap > 0 ? Math.round((tokens / settings.monthlyTokenCap) * 100) : null,
        avgLatencyMs: ai.length ? Math.round(sum(ai, 'latencyMs') / ai.length) : null,
      },
      byFeature: [...byFeature.entries()]
        .map(([feature, v]) => ({ feature, label: label(feature), calls: v.calls, costPaise: v.costPaise, avgLatencyMs: Math.round(v.latency / v.calls) }))
        .sort((a, b) => b.calls - a.calls),
      byUser: [...byUser.entries()].map(([userId, v]) => ({ userId, name: users.get(userId) ?? 'Former user', ...v })).sort((a, b) => b.calls - a.calls),
      daily: { labels, calls },
      recent: rows.slice(0, 50).map((r) => ({
        id: r.id,
        at: r.createdAt.toISOString(),
        user: r.userId ? (users.get(r.userId) ?? 'Former user') : 'Automation',
        feature: r.feature,
        featureLabel: label(r.feature),
        mode: r.mode,
        status: r.status,
        model: r.model,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        costPaise: r.costPaise,
        latencyMs: r.latencyMs,
        error: r.error,
      })),
    };
  }

  async saveSettings(me: Me, body: unknown, ip?: string) {
    this.assertManager(me);
    await this.settingsService.save(me, 'ai', body, ip);
    return this.usage(me);
  }
}

type Usage = { calls: number; input: number; output: number; cacheRead: number; cost: number; model: string | null };
