import { settingsDefaults } from '@bmu/shared';
import type { Prisma, PrismaClient } from '../../src/generated/prisma/client.js';

// v10 AI Copilot demo data: AI settings (on, basic mode until a key is added), ~40 usage rows over this month
// so Command Centre → AI Copilot shows something, and one "AI draft" automation. Idempotent.

const DAY = 86_400_000;
const FEATURES: { feature: string; ai: boolean; inTok: number; outTok: number; model: string }[] = [
  { feature: 'copilot', ai: true, inTok: 5200, outTok: 420, model: 'claude-opus-5-5' },
  { feature: 'lead_brief', ai: true, inTok: 1800, outTok: 260, model: 'claude-opus-5-5' },
  { feature: 'lead_followup', ai: true, inTok: 1300, outTok: 180, model: 'claude-haiku-4-5' },
  { feature: 'reply_suggest', ai: true, inTok: 1500, outTok: 150, model: 'claude-haiku-4-5' },
  { feature: 'social_captions', ai: false, inTok: 0, outTok: 0, model: '' },
  { feature: 'request_triage', ai: false, inTok: 0, outTok: 0, model: '' },
  { feature: 'copilot', ai: false, inTok: 0, outTok: 0, model: '' },
  { feature: 'weekly_digest', ai: true, inTok: 2600, outTok: 380, model: 'claude-opus-5-5' },
];
const PRICE: Record<string, [number, number]> = { 'claude-opus-5-5': [4, 20], 'claude-haiku-4-5': [1, 5] };

export async function seedAi(prisma: PrismaClient, orgId: string) {
  const org = await prisma.organisation.findUniqueOrThrow({ where: { id: orgId }, select: { settings: true } });
  const settings = (org.settings ?? {}) as Record<string, unknown>;
  const v8 = (settings.v8 ?? {}) as Record<string, unknown>;
  if (!v8.ai) await prisma.organisation.update({ where: { id: orgId }, data: { settings: { ...settings, v8: { ...v8, ai: settingsDefaults.ai } } as Prisma.InputJsonValue } });

  if (!(await prisma.aiLog.count({ where: { orgId, targetType: 'DemoSeed' } }))) {
    const users = await prisma.user.findMany({ where: { orgId, email: { in: ['founder@bmu.demo', 'am@bmu.demo', 'admin@bmu.demo', 'strategist@bmu.demo'] } }, select: { id: true } });
    const now = Date.now();
    const monthStart = new Date(new Date().toISOString().slice(0, 8) + '01T00:00:00+05:30').getTime();
    const span = Math.max(DAY, now - monthStart - 3_600_000);
    const rows: Prisma.AiLogCreateManyInput[] = [];
    for (let i = 0; i < 40; i++) {
      const f = FEATURES[i % FEATURES.length];
      const [pi, po] = PRICE[f.model] ?? [0, 0];
      const cost = f.ai ? Math.round(((f.inTok * pi + f.outTok * po) / 1_000_000) * 88 * 100) : 0;
      rows.push({
        orgId,
        userId: users.length ? users[i % users.length].id : null,
        feature: f.feature,
        mode: f.ai ? 'ai' : 'basic',
        status: i === 13 ? 'error' : 'ok',
        model: f.ai ? f.model : null,
        inputTokens: f.inTok,
        outputTokens: f.outTok,
        costPaise: cost,
        latencyMs: f.ai ? 1800 + ((i * 377) % 4000) : 40 + ((i * 13) % 120),
        error: i === 13 ? 'APIConnectionError: demo row' : null,
        targetType: 'DemoSeed',
        createdAt: new Date(now - span + Math.round((span / 40) * i)),
      });
    }
    await prisma.aiLog.createMany({ data: rows });
  }

  const founder = await prisma.user.findFirst({ where: { orgId, email: 'founder@bmu.demo' }, select: { id: true } });
  if (!(await prisma.automationRule.findFirst({ where: { orgId, templateKey: 'ai_draft_unhappy_request' } }))) {
    await prisma.automationRule.create({
      data: {
        orgId,
        name: 'AI drafts a reply to unhappy requests',
        description: 'When a client request sounds unhappy, AI Copilot drafts a calm reply and sends it to the account manager to review. Nothing goes to the client automatically.',
        trigger: 'request_created',
        conditions: [{ field: 'tone', op: 'equals', value: 'negative' }],
        actions: [{ type: 'ai_draft', draft: 'client_message', to: 'am', instruction: 'Apologise, acknowledge the issue and promise a call today.' }],
        templateKey: 'ai_draft_unhappy_request',
        createdById: founder?.id ?? null,
      },
    });
  }
}
