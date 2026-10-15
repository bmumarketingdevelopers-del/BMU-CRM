// Weekly AI digest for the founder (Monday-morning job + on demand from the Weekly Review), the tone sweep that
// flags unhappy/urgent client messages for Client Health, and the "AI draft" automation action.
import { ForbiddenException, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { aiToneOf, automationAiDraftLabels, formatINR, type AiCitation, type AiDigestView, type AiTone, type AutomationAiDraftKind, type Me } from '@bmu/shared';
import { z } from 'zod';
import { MeService } from '../auth/me.service.js';
import { canReadCommand } from '../insights/access.js';
import { InsightsService } from '../insights/insights.service.js';
import { istParts, startOfWeek } from '../insights/ist.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { cleanLinks } from './ai-copilot.js';
import { fence, redact, SAFETY_RULES } from './ai-safety.js';
import { AiService, jsonOf, textOf } from './ai.service.js';
import { startJob, type JobHandle } from '../runtime/jobs.js';

const DAY = 86_400_000;
const get = <T>(ref: ModuleRef, cls: new (...args: never[]) => T): T => ref.get(cls as never, { strict: false }) as T;

const DIGEST_SYSTEM = `You write the Monday-morning digest for the founder of BMU Marketing, a marketing agency in Bengaluru, from the numbers and lists given (nothing else).
Sections, each a bold label followed by "- " bullets: **What changed this week**, **Risks**, **Wins**, **5 recommended actions** (numbered 1-5, each concrete, with an owner role and a markdown link to the record using the exact links given).
Under 300 words. Be direct.

${SAFETY_RULES}`;

const DRAFT_SYSTEM = `You draft text for the BMU Marketing team from an automation event (a record in the CRM). A person will review and send it; it is never sent automatically.
Write only the draft itself, no preamble.

${SAFETY_RULES}`;

export type DigestFacts = { text: string; links: Set<string>; basic: string; citations: AiCitation[] };

@Injectable()
export class AiDigestService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('AiDigest');
  private job?: JobHandle;
  private running = false;

  constructor(
    private readonly ai: AiService,
    private readonly prisma: PrismaService,
    private readonly ref: ModuleRef,
  ) {}

  onModuleInit() {
    this.job = startJob({ name: 'ai.digest', hint: 'Sends AI daily digests and summaries', everyMs: 5 * 60_000, firstAfterMs: 20_000, run: () => this.tick() });
  }

  onModuleDestroy() {
    this.job?.stop();
  }

  /** Every 5 minutes: Monday-morning digests and the tone sweep. Never throws. */
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const orgs = await this.prisma.organisation.findMany({ where: { deletedAt: null }, select: { id: true } });
      for (const o of orgs) {
        await this.mondayDigest(o.id).catch((e: Error) => this.log.warn(`Digest skipped: ${e.message}`));
        await this.toneSweep(o.id).catch((e: Error) => this.log.warn(`Tone sweep skipped: ${e.message}`));
      }
    } finally {
      this.running = false;
    }
  }

  // ---------------------------------------------------------------- digest

  private view(d: { id: string; text: string; mode: string; createdAt: Date; weekStart: Date; data: unknown }): AiDigestView {
    const data = (d.data ?? {}) as { citations?: AiCitation[]; notice?: string | null };
    return { id: d.id, text: d.text, mode: d.mode === 'ai' ? 'ai' : 'basic', createdAt: d.createdAt.toISOString(), weekStart: d.weekStart.toISOString(), citations: data.citations ?? [], notice: data.notice ?? null };
  }

  private assertReader(me: Me) {
    if (!canReadCommand(me)) throw new ForbiddenException('The weekly digest is for the Command Centre team');
  }

  async latest(me: Me): Promise<AiDigestView | null> {
    this.assertReader(me);
    const d = await this.prisma.aiDigest.findFirst({ where: { orgId: me.orgId }, orderBy: { createdAt: 'desc' } });
    return d ? this.view(d) : null;
  }

  async make(me: Me): Promise<AiDigestView> {
    this.assertReader(me);
    const facts = await this.facts(me);
    const result = await this.ai.execute({ orgId: me.orgId, userId: me.id, me }, 'weekly_digest', {
      target: { type: 'Organisation', id: me.orgId },
      basic: () => ({ text: facts.basic, citations: facts.citations }),
      ai: async (run) => {
        const msg = await run({ system: DIGEST_SYSTEM, messages: [{ role: 'user', content: facts.text }], maxTokens: 16_000, effort: 'medium' });
        return cleanLinks(textOf(msg), facts.links);
      },
    });
    const d = await this.prisma.aiDigest.create({
      data: { orgId: me.orgId, weekStart: startOfWeek(new Date()), text: result.text, mode: result.mode, createdById: me.id, data: { citations: result.citations, notice: result.notice } },
    });
    return this.view(d);
  }

  /** The numbers behind the digest, read with the person's own permissions. */
  async facts(me: Me): Promise<DigestFacts> {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * DAY);
    const insights = get(this.ref, InsightsService);
    const w = await insights.weekly(me);
    const [newLeads, won, sent, approved, newRequests, payments] = await Promise.all([
      this.prisma.lead.count({ where: { orgId: me.orgId, deletedAt: null, createdAt: { gte: weekAgo } } }),
      this.prisma.lead.count({ where: { orgId: me.orgId, deletedAt: null, stage: 'won', updatedAt: { gte: weekAgo } } }),
      this.prisma.proposal.count({ where: { orgId: me.orgId, sentAt: { gte: weekAgo } } }),
      this.prisma.approval.count({ where: { orgId: me.orgId, targetType: 'deliverable', at: { gte: weekAgo } } }),
      this.prisma.request.count({ where: { orgId: me.orgId, createdAt: { gte: weekAgo } } }),
      w.money ? this.prisma.payment.aggregate({ where: { orgId: me.orgId, at: { gte: weekAgo } }, _sum: { amountPaise: true } }) : null,
    ]);
    const unhappy = await this.prisma.aiSignal.count({ where: { orgId: me.orgId, tone: 'negative', createdAt: { gte: weekAgo } } });
    const links = new Set<string>(['/admin', '/team/leads', '/team/requests', '/admin/client-health', '/admin/collections']);
    const atRisk = w.attention.atRiskClients.slice(0, 6);
    atRisk.forEach((c) => links.add(`/team/clients/${c.id}`));
    const overdue = (w.attention.overdueInvoices ?? []).slice(0, 6);
    overdue.forEach((i) => links.add(`/admin/finance/invoices/${i.id}`));
    const blocked = w.attention.blockedTasks.slice(0, 5);
    blocked.forEach((t) => t.deliverableId && links.add(`/team/deliverables/${t.deliverableId}`));
    const sla = w.attention.slaRequests.slice(0, 5);
    sla.forEach((r) => links.add(`/team/requests/${r.id}`));
    const paid = payments?._sum.amountPaise ?? null;

    const text = [
      `Week ending ${new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(now)}.`,
      w.money ? `Money: revenue this month ${formatINR(w.money.revenueThisMonthPaise)} (last month ${formatINR(w.money.revenueLastMonthPaise)}), collected this month ${formatINR(w.money.collectedThisMonthPaise)}, received in the last 7 days ${formatINR(paid ?? 0)}, outstanding ${formatINR(w.money.outstandingPaise)}.` : 'Money: not visible to this role.',
      `Last 7 days: ${newLeads} new leads, ${won} won, ${sent} proposals sent, ${approved} deliverables approved by clients, ${newRequests} client requests, ${unhappy} unhappy client messages flagged.`,
      `Now: ${w.activeClients} active clients, ${w.openLeads} open leads, ${w.overdueTasks} overdue tasks, ${w.slaBreachesThisWeek} reply-time misses this week, QC pass rate ${w.qcPassRate ?? '—'}%.`,
      `At-risk clients:\n${atRisk.map((c) => `- ${c.name} (health ${c.score}): ${c.reasons.join('; ')} — link /team/clients/${c.id}`).join('\n') || '- none'}`,
      `Overdue invoices:\n${overdue.map((i) => `- ${i.number} ${i.client}: ${formatINR(i.balancePaise)}, ${i.daysOverdue} days — link /admin/finance/invoices/${i.id}`).join('\n') || '- none'}`,
      `Blocked tasks:\n${blocked.map((t) => `- ${t.title} (${t.owner ?? 'unassigned'}): ${redact(t.reason ?? '')}${t.deliverableId ? ` — link /team/deliverables/${t.deliverableId}` : ''}`).join('\n') || '- none'}`,
      `Requests past reply time:\n${sla.map((r) => `- ${r.client}: ${redact(r.description).slice(0, 80)} — link /team/requests/${r.id}`).join('\n') || '- none'}`,
    ].join('\n');

    const actions: string[] = [];
    if (atRisk[0]) actions.push(`Call [${atRisk[0].name}](/team/clients/${atRisk[0].id}) this week (CM + Founder): ${atRisk[0].reasons[0] ?? 'health is low'}.`);
    if (overdue[0]) actions.push(`Chase [${overdue[0].number} · ${overdue[0].client}](/admin/finance/invoices/${overdue[0].id}) — ${formatINR(overdue[0].balancePaise)}, ${overdue[0].daysOverdue} days overdue (Finance).`);
    if (sla.length) actions.push(`Reply to the ${sla.length} request${sla.length === 1 ? '' : 's'} past reply time on the [requests desk](/team/requests) (CMs).`);
    if (blocked.length) actions.push(`Unblock ${blocked.length} task${blocked.length === 1 ? '' : 's'}${blocked[0].deliverableId ? `, starting with [${blocked[0].title}](/team/deliverables/${blocked[0].deliverableId})` : ''} (department heads).`);
    if (w.openLeads) actions.push(`Review the ${w.openLeads} open [leads](/team/leads) and make sure each has a follow-up date (Sales).`);
    actions.push('Look at [Client Health](/admin/client-health) and thank one happy client for a referral (Founder).');
    actions.push('Check [Collections](/admin/collections) and confirm next week’s expected payments (Finance).');
    const basic = [
      `**What changed this week**\n- ${newLeads} new leads, ${won} won, ${sent} proposals sent.\n- ${approved} deliverables approved by clients; ${newRequests} new client requests.${w.money ? `\n- Revenue this month ${formatINR(w.money.revenueThisMonthPaise)} vs ${formatINR(w.money.revenueLastMonthPaise)} last month.` : ''}`,
      `**Risks**\n${[
        ...atRisk.slice(0, 3).map((c) => `- [${c.name}](/team/clients/${c.id}) — health ${c.score}: ${c.reasons.slice(0, 2).join('; ')}`),
        ...(w.money && w.money.outstandingPaise ? [`- ${formatINR(w.money.outstandingPaise)} outstanding${overdue.length ? `, ${overdue.length} invoice${overdue.length === 1 ? '' : 's'} overdue` : ''}.`] : []),
        ...(w.overdueTasks ? [`- ${w.overdueTasks} overdue tasks.`] : []),
        ...(unhappy ? [`- ${unhappy} unhappy client message${unhappy === 1 ? '' : 's'} flagged this week.`] : []),
      ].join('\n') || '- Nothing serious this week.'}`,
      `**Wins**\n${[won ? `- ${won} lead${won === 1 ? '' : 's'} won.` : '', approved ? `- ${approved} deliverable${approved === 1 ? '' : 's'} approved by clients.` : '', paid ? `- ${formatINR(paid)} received in the last 7 days.` : ''].filter(Boolean).join('\n') || '- Keep going — no big wins logged this week.'}`,
      `**5 recommended actions**\n${actions.slice(0, 5).map((a, i) => `${i + 1}. ${a}`).join('\n')}`,
    ].join('\n\n');
    const citations = cleanLinks(basic, links).citations;
    return { text, links, basic, citations };
  }

  private async mondayDigest(orgId: string) {
    const now = new Date();
    const p = istParts(now);
    const istHour = new Date(now.getTime() + 330 * 60_000).getUTCHours();
    if (p.dow !== 1 || istHour < 9) return;
    const weekStart = startOfWeek(now);
    if (await this.prisma.aiDigest.findFirst({ where: { orgId, weekStart } })) return;
    const s = await this.ai.settings(orgId);
    if (!s.enabled || !s.features.management) return;
    const founder = await this.prisma.user.findFirst({ where: { orgId, type: 'staff', deletedAt: null, status: 'active', roles: { some: { role: { baseRole: 'founder' } } } }, orderBy: { createdAt: 'asc' } });
    if (!founder) return;
    const me = await get(this.ref, MeService).load(founder.id);
    if (!me) return;
    await this.make(me);
    await get(this.ref, NotificationsService).notify(orgId, [founder.id], { kind: 'ai_digest', title: 'Your weekly AI digest is ready', body: 'What changed, risks, wins and 5 recommended actions for this week.', link: '/admin#ai-digest' });
    this.log.log(`Weekly digest created for ${founder.name}`);
  }

  // ---------------------------------------------------------------- tone sweep (feeds Client Health)

  /** Flags the tone of recent client messages and requests once each. AI (fast model) when allowed, else the tone check. */
  async toneSweep(orgId: string, limit = 25): Promise<number> {
    const s = await this.ai.settings(orgId);
    if (!s.enabled || !s.features.clientService) return 0;
    const since = new Date(Date.now() - 14 * DAY);
    const done = new Set((await this.prisma.aiSignal.findMany({ where: { orgId, createdAt: { gte: new Date(since.getTime() - DAY) } }, select: { sourceId: true } })).map((x) => x.sourceId));
    const clientIds = new Set((await this.prisma.user.findMany({ where: { orgId, type: 'client' }, select: { id: true } })).map((u) => u.id));
    const messages = (
      await this.prisma.message.findMany({ where: { orgId, isInternal: false, createdAt: { gte: since } }, select: { id: true, body: true, authorId: true, thread: { select: { clientOrgId: true } } }, orderBy: { createdAt: 'desc' }, take: 300 })
    ).filter((m) => clientIds.has(m.authorId) && !done.has(m.id));
    const requests = (await this.prisma.request.findMany({ where: { orgId, createdAt: { gte: since } }, select: { id: true, description: true, engagement: { select: { clientOrgId: true } } }, orderBy: { createdAt: 'desc' }, take: 100 })).filter(
      (r) => !done.has(r.id),
    );
    const items = [
      ...messages.map((m) => ({ sourceType: 'message', id: m.id, text: m.body, clientOrgId: m.thread.clientOrgId })),
      ...requests.map((r) => ({ sourceType: 'request', id: r.id, text: r.description, clientOrgId: r.engagement.clientOrgId })),
    ].slice(0, limit);
    if (!items.length) return 0;

    const tones = new Map<string, { tone: AiTone; reason: string }>(items.map((i) => [i.id, aiToneOf(i.text)]));
    let mode = 'basic';
    const result = await this.ai.execute({ orgId, userId: null }, 'sentiment', {
      basic: () => ({ text: `${items.length} messages checked with the tone check` }),
      ai: async (run) => {
        const msg = await run({
          system: `Classify the tone of each client message for an agency's client-health score.\n\n${SAFETY_RULES}`,
          messages: [{ role: 'user', content: `Return JSON {items: [{id, tone: negative|urgent|positive|neutral, reason}]}.\n\n${items.map((i) => `id ${i.id}:\n${fence('client message', i.text, 800)}`).join('\n')}` }],
          maxTokens: 4000,
          fast: true,
          schema: {
            type: 'object',
            properties: { items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, tone: { type: 'string', enum: ['negative', 'urgent', 'positive', 'neutral'] }, reason: { type: 'string' } }, required: ['id', 'tone', 'reason'], additionalProperties: false } } },
            required: ['items'],
            additionalProperties: false,
          },
        });
        const parsed = z.object({ items: z.array(z.object({ id: z.string(), tone: z.enum(['negative', 'urgent', 'positive', 'neutral']), reason: z.string() })) }).safeParse(jsonOf(msg));
        if (!parsed.success) throw new Error('Tone reply was not valid JSON');
        for (const it of parsed.data.items) if (tones.has(it.id)) tones.set(it.id, { tone: it.tone, reason: it.reason.slice(0, 200) });
        return { text: `${parsed.data.items.length} messages classified` };
      },
    });
    mode = result.mode;
    await this.prisma.aiSignal.createMany({
      data: items.map((i) => ({ orgId, clientOrgId: i.clientOrgId, sourceType: i.sourceType, sourceId: i.id, tone: tones.get(i.id)!.tone, reason: tones.get(i.id)!.reason, mode })),
      skipDuplicates: true,
    });
    return items.length;
  }

  // ---------------------------------------------------------------- automations: AI draft

  /** Drafts text for an automation step. Never sends anything; the engine sends the draft to people as an alert. */
  async automationDraft(orgId: string, rule: { id: string; name: string }, kind: AutomationAiDraftKind, instruction: string, subject: { entity: string; entityId: string; record: string; vars: Record<string, string | number | null> }) {
    const vars = Object.entries(subject.vars)
      .filter(([k, v]) => v !== null && v !== '' && !['link'].includes(k))
      .map(([k, v]) => (k === 'description' ? `${k}:\n${fence('client text', String(v), 1500)}` : `${k}: ${redact(String(v)).slice(0, 200)}`))
      .join('\n');
    const label = automationAiDraftLabels[kind].toLowerCase();
    return this.ai.execute({ orgId, userId: null }, 'automation_draft', {
      target: { type: subject.entity, id: subject.entityId },
      basic: () => ({ text: basicDraft(kind, subject.vars) }),
      ai: async (run) => {
        const msg = await run({
          system: DRAFT_SYSTEM,
          messages: [{ role: 'user', content: `Draft ${label} for this event.\nAutomation: ${rule.name}.\nRecord: ${subject.record}\n${vars}\n${instruction ? `Instruction from the admin: ${instruction.slice(0, 500)}` : ''}\n${kind === 'client_message' ? 'Polite, under 90 words, signed "Team BMU".' : kind === 'task_description' ? 'A task description: 1 line goal, then 3-5 "- " steps.' : 'A short internal note for the team, under 60 words.'}` }],
          maxTokens: 2000,
          fast: true,
        });
        return { text: textOf(msg) };
      },
    });
  }
}

export function basicDraft(kind: AutomationAiDraftKind, v: Record<string, string | number | null>): string {
  const client = v.client ?? v.company ?? v.lead ?? 'there';
  if (kind === 'client_message') {
    if (v.invoice) return `Hi ${client} team, a gentle reminder that invoice ${v.invoice}${v.balance ? ` (${v.balance} pending)` : ''} is due${v.due ? ` since ${v.due}` : ''}. You can pay securely from the Billing page in your BMU Hub app. Please ignore if already paid. Thank you! — Team BMU`;
    if (v.description) return `Hi ${client} team, thank you for your request. We have received it and our team is looking into it. We will get back to you with the next steps shortly. — Team BMU`;
    return `Hi ${client} team, a quick update from BMU Marketing about ${v.service ?? 'your project'}. Please let us know if you have any questions. — Team BMU`;
  }
  if (kind === 'task_description') return `Follow up on ${client}${v.service ? ` (${v.service})` : ''}.\n- Review the record and latest messages\n- Contact the right person today\n- Log the outcome and next step in BMU Hub`;
  return `Heads-up on ${client}: ${v.description ? String(v.description).slice(0, 120) : 'this record needs attention'}. Please check and update the team.`;
}

