// Ask BMU: natural-language questions over the CRM with Claude tool use (manual loop, read-only tools in the
// person's own scope), conversation history per user, and a keyword-based basic mode when no key is set.
import type Anthropic from '@anthropic-ai/sdk';
import { Injectable, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { formatINR, type AiAskInput, type AiChatMessage, type AiCitation, type AiConversationSummary, type AiConversationView, type AiResult, type AiStreamEvent, type Me } from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SAFETY_RULES } from './ai-safety.js';
import { clientTools, staffTools, toolDefs, type CopilotTool, type ToolOutput } from './ai-tools.js';
import { AiRefusal, AiService, textOf, type AiOut, type AiRunner } from './ai.service.js';

type Emit = (e: AiStreamEvent) => void;

const STAFF_SYSTEM = `You are "Ask BMU", the assistant inside BMU Hub, the CRM of BMU Marketing, a marketing agency in Bengaluru (social media, branding, web, video, SEO, ads; monthly retainers and one-time projects with five milestones G1-G5).
You answer questions from the BMU team about their clients, leads, invoices, tasks, requests and business numbers.

How to work:
- Use the tools to look things up. They only return what the person asking is allowed to see. Call several tools when a question needs it.
- If a tool says "not allowed", tell the person plainly that their role cannot see that information and suggest who can (Founder, Branch Manager or Finance for money). Do not guess the missing data.
- Answer in a few short lines or a short bullet list. Lead with the answer, then the reasons.
- Cite every record you mention as a markdown link using the exact "link" value from the tool result, for example [Metro Dental](/team/clients/abc123). Never make up links.
- Money is already formatted in rupees in tool results; repeat it as given.

${SAFETY_RULES}`;

const CLIENT_SYSTEM = `You are the assistant in the BMU Hub client app. BMU Marketing is the client's marketing agency.
You answer the client's questions about their own account only: services and milestones, drafts waiting for approval, requests and invoices.

How to work:
- Use the tools; they only return this client's own data. If a tool says "not allowed", explain that their user role cannot see it and that the account owner can.
- Never discuss other clients, BMU's internal costs, staff workload or anything not returned by the tools.
- Be warm and brief. Cite pages as markdown links using the exact "link" values, e.g. [Billing](/client/billing).
- For anything you cannot answer, suggest messaging their client manager from Messages.

${SAFETY_RULES}`;

const MAX_TURNS = 6;
const LINK = /\[([^\]]{1,120})\]\((\/[^)\s]{1,200})\)/g;
const dateLine = () =>
  new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date());

/** Keeps only links that came from tool results (or are known pages); others become plain text. */
export function cleanLinks(text: string, allowed: Set<string>): { text: string; citations: AiCitation[] } {
  const citations: AiCitation[] = [];
  const out = text.replace(LINK, (_, label: string, href: string) => {
    if (!allowed.has(href)) return label;
    if (!citations.some((c) => c.href === href)) citations.push({ label, href });
    return `[${label}](${href})`;
  });
  return { text: out, citations };
}

@Injectable()
export class AiCopilotService {
  constructor(
    private readonly ai: AiService,
    private readonly prisma: PrismaService,
    private readonly ref: ModuleRef,
  ) {}

  // ------------------------------------------------------------------ conversations

  async conversations(me: Me): Promise<AiConversationSummary[]> {
    const rows = await this.prisma.aiConversation.findMany({ where: { userId: me.id, deletedAt: null }, orderBy: { updatedAt: 'desc' }, take: 30, select: { id: true, title: true, updatedAt: true } });
    return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt.toISOString() }));
  }

  private async own(me: Me, id: string) {
    const c = await this.prisma.aiConversation.findFirst({ where: { id, userId: me.id, deletedAt: null } });
    if (!c) throw new NotFoundException('Conversation not found');
    return c;
  }

  async conversation(me: Me, id: string): Promise<AiConversationView> {
    const c = await this.own(me, id);
    // Older conversations saved the "connect AI" notice for everyone; only Founder / Branch Manager see it now.
    const messages = (c.messages as AiChatMessage[]).map((m) => (m.notice ? { ...m, notice: this.ai.noticeFor(me, m.notice) } : m));
    return { id: c.id, title: c.title, updatedAt: c.updatedAt.toISOString(), messages };
  }

  async remove(me: Me, id: string) {
    await this.own(me, id);
    await this.prisma.aiConversation.update({ where: { id }, data: { deletedAt: new Date() } });
    return { ok: true as const };
  }

  // ------------------------------------------------------------------ ask

  async ask(me: Me, input: AiAskInput, emit: Emit = () => {}): Promise<AiResult> {
    const client = me.type === 'client';
    const feature = client ? 'client_ask' : 'copilot';
    await this.ai.assertOn({ orgId: me.orgId, userId: me.id, me }, feature);
    const convo = input.conversationId ? await this.own(me, input.conversationId) : null;
    const history = ((convo?.messages ?? []) as AiChatMessage[]).slice(-10);
    const tools = client ? clientTools(this.ref, me) : staffTools(this.ref, me);

    const result = await this.ai.execute({ orgId: me.orgId, userId: me.id, me }, feature, {
      target: convo ? { type: 'AiConversation', id: convo.id } : undefined,
      basic: () => (client ? this.basicClient(input.question, tools, emit) : this.basicStaff(me, input.question, tools, emit)),
      ai: (run) => this.loop(me, client, input.question, history, tools, run, emit),
    });

    const now = new Date().toISOString();
    const messages: AiChatMessage[] = [
      ...((convo?.messages ?? []) as AiChatMessage[]),
      { role: 'user' as const, text: input.question, citations: [], at: now },
      { role: 'assistant' as const, text: result.text, citations: result.citations, mode: result.mode, notice: result.notice, at: now },
    ].slice(-60);
    const saved = convo
      ? await this.prisma.aiConversation.update({ where: { id: convo.id }, data: { messages: messages as unknown as Prisma.InputJsonValue } })
      : await this.prisma.aiConversation.create({ data: { orgId: me.orgId, userId: me.id, title: input.question.slice(0, 80), messages: messages as unknown as Prisma.InputJsonValue } });
    return { ...result, conversationId: saved.id };
  }

  private async loop(me: Me, client: boolean, question: string, history: AiChatMessage[], tools: CopilotTool[], run: AiRunner, emit: Emit): Promise<AiOut> {
    const byName = new Map(tools.map((t) => [t.name, t]));
    const allowed = new Set<string>(client ? ['/client', '/client/billing', '/client/requests', '/client/reviews', '/client/messages'] : ['/admin', '/team/tasks']);
    const messages: Anthropic.Beta.BetaMessageParam[] = history.map((m) => ({ role: m.role, content: m.text || '…' }));
    messages.push({
      role: 'user',
      content: `Today is ${dateLine()} (IST). ${client ? `The person asking is a ${me.clientOrg?.role.replace('client_', '')} user of ${me.clientOrg?.name}.` : `The person asking is ${me.name} (role: ${me.roles.join(', ').replaceAll('_', ' ')}).`}\n\nQuestion: ${question}`,
    });
    let final: Anthropic.Beta.BetaMessage | null = null;
    let jsonRetries = 0;
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      let msg: Anthropic.Beta.BetaMessage;
      try {
        msg = await run({ system: client ? CLIENT_SYSTEM : STAFF_SYSTEM, messages, tools: toolDefs(tools), maxTokens: 16_000, effort: 'medium', onText: (text) => emit({ t: 'delta', text }) });
        jsonRetries = 0;
      } catch (e) {
        // With eager input streaming a tool input can arrive as unparseable JSON; re-issue that turn (max twice).
        if ((e as { status?: number }).status || e instanceof AiRefusal || jsonRetries++ >= 2) throw e;
        continue;
      }
      final = msg;
      const uses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      if (msg.stop_reason !== 'tool_use' || !uses.length) break;
      messages.push({ role: 'assistant', content: msg.content });
      const results = await Promise.all(
        uses.map(async (u): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
          const tool = byName.get(u.name);
          const parsed = tool?.schema.safeParse(u.input ?? {});
          if (!tool || !parsed?.success) return { type: 'tool_result', tool_use_id: u.id, is_error: true, content: tool ? 'Invalid input for this tool' : 'Unknown tool' };
          emit({ t: 'status', text: tool.status });
          const out = await tool.run(parsed.data as Record<string, unknown>);
          const json = JSON.stringify(out.data);
          for (const m of json.matchAll(/"link":"(\/[^"]+)"/g)) allowed.add(m[1]);
          for (const c of out.citations) allowed.add(c.href);
          return { type: 'tool_result', tool_use_id: u.id, content: json.slice(0, 30_000) };
        }),
      );
      messages.push({ role: 'user', content: results });
      emit({ t: 'delta', text: '\n\n' });
    }
    const raw = final ? textOf(final) : '';
    const cleaned = cleanLinks(raw || 'I could not find an answer to that. Try asking about a specific client, lead, invoice or person.', allowed);
    return { text: cleaned.text, citations: cleaned.citations };
  }

  // ------------------------------------------------------------------ basic mode

  private async call(tools: CopilotTool[], name: string, input: Record<string, unknown>, emit: Emit): Promise<ToolOutput> {
    const t = tools.find((x) => x.name === name)!;
    emit({ t: 'status', text: t.status });
    return t.run(input);
  }

  /** Keyword-based answer without the model (also used by the Analyst agent in basic mode). */
  async basicStaff(me: Me, question: string, tools: CopilotTool[], emit: Emit): Promise<AiOut> {
    const q = question.toLowerCase();
    const clientsOut = await this.call(tools, 'find_clients', {}, () => {});
    const clientList = (Array.isArray(clientsOut.data) ? clientsOut.data : []) as { id: string; name: string; health: string; am: string | null; link: string }[];
    const client = clientList.find((c) => q.includes(c.name.toLowerCase())) ?? clientList.find((c) => c.name.split(/\s+/).some((w) => w.length > 3 && q.includes(w.toLowerCase())));
    const staff = await this.prisma.user.findMany({ where: { orgId: me.orgId, type: 'staff', deletedAt: null }, select: { name: true } });
    const person = staff.find((u) => q.includes(u.name.toLowerCase())) ?? staff.find((u) => u.name.split(/\s+/)[0].length > 2 && new RegExp(`\\b${u.name.split(/\s+/)[0].toLowerCase()}\\b`).test(q));
    const notAllowed = (o: ToolOutput) => (o.data as { notAllowed?: boolean; message?: string })?.notAllowed;
    // v55: anything the role can't see is said once, then the answer comes from the person's own work (My Day).
    const mine = async (lead?: string): Promise<AiOut> => {
      const out = await this.call(tools, 'my_week', {}, emit);
      const text = myWeekText(out.data as MyWeek);
      return { text: lead ? `${lead}

${text}` : text, citations: out.citations };
    };
    const deny = (what: string, who = 'the Founder, a Branch Manager or Finance') => mine(`Your role can't see ${what} (${who} can). Here is what you can see, from your own work:`);
    // One My Day lookup per question, shared by the dashboard answers below.
    let weekOut: ToolOutput | undefined;
    const fromMyDay = async (render: (w: MyWeek) => string): Promise<AiOut> => {
      weekOut ??= await this.call(tools, 'my_week', {}, emit);
      return { text: render(weekOut.data as MyWeek), citations: weekOut.citations };
    };
    const other = person && person.name !== me.name ? person : undefined;
    const aboutTasks = STAFF_KEYWORDS.tasks.test(q);

    if (STAFF_KEYWORDS.help.test(q)) return { text: staffHelp(clientList[0]?.name, staff[0]?.name), citations: [] };
    if (STAFF_KEYWORDS.attendance.test(q)) return fromMyDay(attendanceText);
    if (STAFF_KEYWORDS.eod.test(q)) return fromMyDay(eodText);
    if (STAFF_KEYWORDS.qc.test(q) && !other) return fromMyDay(qcText);
    if (STAFF_KEYWORDS.sendToClient.test(q)) return fromMyDay((w) => (w.sendToClientWaiting ? `${w.sendToClientWaiting} version${w.sendToClientWaiting === 1 ? '' : 's'} passed QC and ${w.sendToClientWaiting === 1 ? 'is' : 'are'} ready to send to the client. Open [Review Studio](/team/reviews).` : 'Nothing is waiting to be sent to a client right now.'));
    if (!other && !client) {
      if (aboutTasks && /\b(overdue|late|missed|past due|delayed|behind)\b/.test(q)) return fromMyDay((w) => taskList('Overdue', w.tasks.overdue, 'Nothing of yours is overdue. Well done!'));
      if (aboutTasks && /\b(blocked|stuck|on hold|can'?t (start|continue))\b/.test(q)) return fromMyDay((w) => taskList('Blocked', w.tasks.blocked, 'None of your tasks is blocked.'));
      if (aboutTasks && /\b(done|completed|finished|closed)\b/.test(q)) return fromMyDay((w) => `You finished ${w.tasks.doneRecently} task${w.tasks.doneRecently === 1 ? '' : 's'} in the last 2 weeks, and have ${w.tasks.open} open. See [My tasks](/team/tasks).`);
      if ((aboutTasks || /\bdue\b/.test(q)) && /\b(today|tonight|now)\b/.test(q)) return fromMyDay((w) => taskList('Due today', w.tasks.dueToday, 'Nothing of yours is due today.'));
      if ((aboutTasks || /\bdue\b/.test(q)) && /\b(this week|upcoming|coming up|next (few |7 )?days|tomorrow|soon|deadlines?)\b/.test(q)) return fromMyDay((w) => taskList('Due in the next 7 days', w.tasks.dueThisWeek, 'Nothing of yours is due in the next 7 days.'));
      if (STAFF_KEYWORDS.delivery.test(q)) return fromMyDay(deliveryText);
    }
    if (STAFF_KEYWORDS.mine.test(q) && !other) return mine();
    if (/\b(risk|risky|health|healthy|churn|unhappy|at-risk|red|amber|need(s)? attention|losing|leaving)\b/.test(q)) {
      const out = await this.call(tools, 'clients_at_risk', {}, emit);
      if (notAllowed(out)) {
        const amber = clientList.filter((c) => c.health !== 'green');
        if (!amber.length) return { text: 'None of your clients is marked amber or red right now.', citations: [] };
        return { text: `Clients marked amber or red:\n${amber.map((c) => `- [${c.name}](${c.link}): ${c.health}`).join('\n')}`, citations: amber.map((c) => ({ label: c.name, href: c.link })) };
      }
      const d = out.data as { atRiskOrWatch: { name: string; score: number; risk: string; reasons: string[]; link: string }[]; healthyCount: number };
      if (!d.atRiskOrWatch.length) return { text: `All clients look healthy right now (${d.healthyCount} checked).`, citations: [] };
      const lines = d.atRiskOrWatch.map((c) => `- [${c.name}](${c.link}) — health ${c.score}/100 (${c.risk === 'at_risk' ? 'at risk' : 'watch'}): ${c.reasons.join('; ') || 'no specific reason'}`);
      return { text: `${d.atRiskOrWatch.filter((c) => c.risk === 'at_risk').length} at risk, ${d.atRiskOrWatch.filter((c) => c.risk === 'watch').length} to watch:\n${lines.join('\n')}`, citations: out.citations };
    }
    if (STAFF_KEYWORDS.money.test(q) && !aboutTasks && !/\b(requests?|tickets?|repl(y|ies))\b/.test(q)) {
      const out = await this.call(tools, 'find_invoices', { client: client?.name, status: q.includes('overdue') ? 'overdue' : undefined }, emit);
      if (notAllowed(out)) return deny('invoices');
      const d = out.data as { count: number; totalOwed: string; invoices: { number: string; client: string; status: string; balance: string; due: string; link: string }[] };
      if (!d.count) return { text: `Nothing ${q.includes('overdue') ? 'overdue' : 'owed'}${client ? ` from ${client.name}` : ''} right now.`, citations: [] };
      return {
        text: `${client ? `${client.name} owes` : 'Total owed:'} ${d.totalOwed} across ${d.count} invoice${d.count === 1 ? '' : 's'}:\n${d.invoices.slice(0, 10).map((i) => `- [${i.number}](${i.link}) · ${i.client} · ${i.balance} (${i.status.replace('_', ' ')}, due ${i.due})`).join('\n')}`,
        citations: out.citations,
      };
    }
    if (other && /\b(working|work|tasks?|doing|busy|plate|assigned|up to|handling|workload|load|overdue|pending|deadlines?|free|available)\b/.test(q)) {
      const person = other;
      const out = await this.call(tools, 'find_tasks', { person: person.name.split(/\s+/)[0] }, emit);
      if (notAllowed(out)) return deny("other people's tasks", 'their Department Head');
      const rows = out.data as { title: string; client: string | null; status: string; due: string | null; overdue: boolean; link: string }[];
      if (!rows.length) return { text: `${person.name} has no open tasks you can see.`, citations: [] };
      return {
        text: `${person.name} has ${rows.length} open task${rows.length === 1 ? '' : 's'}${rows.some((r) => r.overdue) ? ` (${rows.filter((r) => r.overdue).length} overdue)` : ''}:\n${rows.slice(0, 12).map((t) => `- [${t.title}](${t.link})${t.client ? ` · ${t.client}` : ''} · ${t.status.replace('_', ' ')}${t.due ? ` · due ${t.due}` : ''}${t.overdue ? ' · overdue' : ''}`).join('\n')}`,
        citations: out.citations,
      };
    }
    if (STAFF_KEYWORDS.leads.test(q)) {
      const out = await this.call(tools, 'find_leads', {}, emit);
      if (notAllowed(out)) return deny('leads', 'the sales team');
      const rows = (out.data as { name: string; company: string | null; stage: string; score: number; nextFollowUp: string | null; link: string }[]).filter((l) => !['Won', 'Lost'].includes(l.stage));
      return {
        text: rows.length ? `${rows.length} open leads. Highest scores first:\n${[...rows].sort((a, b) => b.score - a.score).slice(0, 10).map((l) => `- [${l.company || l.name}](${l.link}) · ${l.stage} · score ${l.score}${l.nextFollowUp ? ` · follow up ${l.nextFollowUp}` : ''}`).join('\n')}` : 'No open leads right now.',
        citations: out.citations,
      };
    }
    if (STAFF_KEYWORDS.requests.test(q)) {
      const out = await this.call(tools, 'find_requests', { client: client?.name }, emit);
      if (notAllowed(out)) return deny('the requests desk', 'Client Managers and leadership');
      const rows = out.data as { client: string; type: string; status: string; text: string; replyTime: string; link: string }[];
      return {
        text: rows.length ? `${rows.length} open request${rows.length === 1 ? '' : 's'}:\n${rows.slice(0, 10).map((r) => `- [${r.client}: ${r.text.slice(0, 60)}](${r.link}) · ${r.type.replace('_', ' ')} · ${r.status.replace('_', ' ')}${r.replyTime === 'overdue' ? ' · reply overdue' : ''}`).join('\n')}` : 'No open requests.',
        citations: out.citations,
      };
    }
    if (client) {
      const out = await this.call(tools, 'client_360', { client: client.id }, emit);
      if (notAllowed(out)) return deny('this client', 'the people who work on it');
      const d = out.data as { client: { name: string; health: string; am: string | null }; stats: { activeServices: number; openRequests: number; draftsWaiting: number; outstanding: string }; deliverables: { title: string; overdue: boolean }[]; link: string };
      const overdue = d.deliverables.filter((x) => x.overdue).length;
      return {
        text: `[${d.client.name}](${d.link}) — health ${d.client.health}, client manager ${d.client.am ?? 'not assigned'}.\n- ${d.stats.activeServices} active service${d.stats.activeServices === 1 ? '' : 's'}, ${d.stats.openRequests} open request${d.stats.openRequests === 1 ? '' : 's'}, ${d.stats.draftsWaiting} draft${d.stats.draftsWaiting === 1 ? '' : 's'} waiting for the client\n- Outstanding: ${d.stats.outstanding}${overdue ? `\n- ${overdue} deliverable${overdue === 1 ? ' is' : 's are'} overdue` : ''}`,
        citations: out.citations,
      };
    }
    if (STAFF_KEYWORDS.sales.test(q)) {
      const out = await this.call(tools, 'sales_numbers', {}, emit);
      if (notAllowed(out)) return deny('the sales scorecard');
      const d = out.data as { month: { revenue: string; target: string; projected: string }; kpis: { label: string; value: number | null; previous: number | null; unit: string }[] };
      const kpi = (v: number | null, unit: string) =>
        v === null || v === undefined ? '—' : unit === 'paise' ? formatINR(v) : unit === 'pct' ? `${Math.round(v)}%` : unit === 'days' ? `${Math.round(v * 10) / 10} days` : unit === 'ratio' ? `${Math.round(v * 100) / 100}×` : String(v);
      return {
        text: `This month: revenue ${d.month.revenue} against a target of ${d.month.target}, heading for ${d.month.projected}.\n${d.kpis.slice(0, 8).map((k) => `- ${k.label}: ${kpi(k.value, k.unit)} (before: ${kpi(k.previous, k.unit)})`).join('\n')}\nSee the [Scorecard](/admin/analytics).`,
        citations: out.citations,
      };
    }
    if (STAFF_KEYWORDS.team.test(q)) {
      const out = await this.call(tools, 'team_performance', {}, emit);
      if (notAllowed(out)) return deny('team performance', 'the Founder, a Branch Manager or a Department Head');
      const d = out.data as { totals: { overdueNow: number; completed: { value: number | null }; onTimePct: { value: number | null } }; people: { name: string; completed: number; onTimePct: number | null; utilisation: number; overdueNow: number; openTasks: number }[] };
      const pct = (n: number | null) => (n === null ? '—' : `${Math.round(n)}%`);
      const busiest = [...d.people].sort((a, b) => b.utilisation - a.utilisation);
      return {
        text: `Last 30 days: ${d.totals.completed.value ?? 0} tasks completed, ${pct(d.totals.onTimePct.value)} on time, ${d.totals.overdueNow} overdue now.\nBy use of time (busiest first):\n${busiest.slice(0, 10).map((p) => `- ${p.name}: ${pct(p.utilisation)} used, ${p.openTasks} open (${p.overdueNow} overdue), ${p.completed} done, ${pct(p.onTimePct)} on time`).join('\n')}\nSee [Team Performance](/admin/analytics/team).`,
        citations: out.citations,
      };
    }
    if (STAFF_KEYWORDS.clients.test(q) && /\b(list|all|how many|which|show|active|count|total|my|our)\b/.test(q)) {
      if (!clientList.length) return { text: 'You have no clients you can see yet.', citations: [] };
      const byHealth = (h: string) => clientList.filter((c) => c.health === h).length;
      return {
        text: `${clientList.length} client${clientList.length === 1 ? '' : 's'} you can see (${byHealth('green')} green, ${byHealth('amber')} amber, ${byHealth('red')} red):\n${clientList.slice(0, 20).map((c) => `- [${c.name}](${c.link}) · ${c.health}${c.am ? ` · CM ${c.am}` : ''}`).join('\n')}`,
        citations: clientList.slice(0, 10).map((c) => ({ label: c.name, href: c.link })),
      };
    }
    if (STAFF_KEYWORDS.summary.test(q)) {
      const out = await this.call(tools, 'business_summary', {}, emit);
      // v55: everyone gets a summary: the company's for those who can see it, otherwise their own week.
      if (notAllowed(out)) return mine();
      const d = out.data as {
        money: { revenueThisMonth: string; revenueLastMonth: string; outstanding: string } | string;
        activeClients?: number;
        openLeads?: number;
        teamClients?: number;
        openDepartmentTasks?: number;
        openTasks?: number;
        overdueTasks: number;
        replyTimeBreachesThisWeek: number;
      };
      const money = typeof d.money === 'string' ? '' : `Revenue this month ${d.money.revenueThisMonth} (last month ${d.money.revenueLastMonth}); ${d.money.outstanding} outstanding.\n`;
      // A Department Head gets their team's clients and open tasks instead of active clients and leads.
      const head =
        d.teamClients !== undefined
          ? `${d.teamClients} clients your team works on, ${d.openDepartmentTasks ?? 0} open tasks in your department`
          : d.openLeads !== undefined
            ? `${d.activeClients} active clients, ${d.openLeads} open leads`
            : `${d.activeClients} active clients, ${d.openTasks ?? 0} open tasks`;
      return { text: `${money}${head}, ${d.overdueTasks} overdue tasks, ${d.replyTimeBreachesThisWeek} reply-time misses this week. See the [Weekly Review](/admin).`, citations: out.citations };
    }
    // A question about the person's own day that matched nothing more specific: answer from My Day.
    if (/\b(today|tomorrow|this week|pending|priority|priorities|important|urgent|update|status)\b/.test(q) && !other) return mine();
    return { text: staffHelp(clientList[0]?.name, staff[0]?.name), citations: [] };
  }

  private async basicClient(question: string, tools: CopilotTool[], emit: Emit): Promise<AiOut> {
    const q = question.toLowerCase();
    if (CLIENT_KEYWORDS.help.test(q)) return { text: CLIENT_HELP, citations: [] };
    if (CLIENT_KEYWORDS.contact.test(q)) {
      const out = await this.call(tools, 'my_account', {}, emit);
      const d = out.data as { accountManager: string | null; accountManagerContact: { email: string | null; phone: string | null } | null };
      if (!d.accountManager) return { text: 'Your client manager is being assigned. Meanwhile, write to us from [Messages](/client/messages).', citations: [{ label: 'Messages', href: '/client/messages' }] };
      const ways = [d.accountManagerContact?.email && `email ${d.accountManagerContact.email}`, d.accountManagerContact?.phone && `phone ${d.accountManagerContact.phone}`].filter(Boolean).join(', ');
      return { text: `Your client manager is ${d.accountManager}${ways ? ` (${ways})` : ''}. You can also write to them from [Messages](/client/messages) or book a call from [Meetings](/client/meetings).`, citations: [{ label: 'Messages', href: '/client/messages' }, { label: 'Meetings', href: '/client/meetings' }] };
    }
    if (CLIENT_KEYWORDS.plans.test(q)) {
      const out = await this.call(tools, 'my_plans', {}, emit);
      const rows = out.data as { service: string; period: string | null; status: string; youApproved: boolean }[];
      if (!rows.length) return { text: 'No plan has been shared with you yet. Your client manager will send it for your approval when it is ready.', citations: out.citations };
      const label = (r: (typeof rows)[number]) => (r.status === 'approved' ? 'approved' : r.status === 'changes_requested' ? 'changes requested, BMU is updating it' : r.youApproved ? 'you approved it, waiting for the other approvers' : 'waiting for your approval');
      const waiting = rows.filter((r) => r.status === 'sent_to_client' && !r.youApproved).length;
      return { text: `${waiting ? `${waiting} plan${waiting === 1 ? ' is' : 's are'} waiting for your approval.\n` : ''}${rows.map((r) => `- ${r.service}${r.period && r.period !== 'project' ? ` (${r.period})` : ''}: ${label(r)}`).join('\n')}\nSee [Approvals](/client/approvals).`, citations: out.citations };
    }
    if (CLIENT_KEYWORDS.requirements.test(q)) {
      const out = await this.call(tools, 'my_requirements', {}, emit);
      const rows = out.data as { service: string; needed: { item: string; status: string; note: string | null }[]; received: number }[];
      const needed = rows.filter((r) => r.needed.length);
      if (!needed.length) return { text: 'We have everything we need from you right now. Thank you!', citations: out.citations };
      return { text: `What we still need from you:\n${needed.map((r) => `**${r.service}**\n${r.needed.map((n) => `- ${n.item}${n.status !== 'pending' ? ` (${n.status})` : ''}${n.note ? `: ${n.note}` : ''}`).join('\n')}`).join('\n')}\nSend them from [Onboarding](/client/onboarding) or [Files](/client/files).`, citations: [...out.citations, { label: 'Files', href: '/client/files' }] };
    }
    if (CLIENT_KEYWORDS.approvals.test(q) && !CLIENT_KEYWORDS.money.test(q)) {
      const out = await this.call(tools, 'my_reviews', {}, emit);
      const all = out.data as { title: string; status: string; waitingOnYou: boolean; link: string }[];
      const rows = all.filter((d) => d.waitingOnYou);
      if (/\b(all|list|how many|recent|status)\b/.test(q) && !rows.length && all.length) return { text: `Your recent work:\n${all.slice(0, 10).map((d) => `- [${d.title}](${d.link}): ${d.status}`).join('\n')}\nNothing is waiting for your approval right now.`, citations: out.citations };
      return { text: rows.length ? `${rows.length} draft${rows.length === 1 ? ' is' : 's are'} waiting for your approval:\n${rows.map((d) => `- [${d.title}](${d.link})`).join('\n')}` : 'Nothing is waiting for your approval right now.', citations: out.citations };
    }
    if (CLIENT_KEYWORDS.money.test(q)) {
      const out = await this.call(tools, 'my_invoices', {}, emit);
      if ((out.data as { notAllowed?: boolean }).notAllowed) return { text: 'Your user role cannot see billing. Your account owner can, or ask your client manager in [Messages](/client/messages).', citations: [{ label: 'Messages', href: '/client/messages' }] };
      const rows = out.data as { number: string; status: string; total: string; paid: string; due: string }[];
      const open = rows.filter((r) => !['paid', 'void', 'credit_noted'].includes(r.status));
      return { text: open.length ? `You have ${open.length} invoice${open.length === 1 ? '' : 's'} to pay:\n${open.map((r) => `- ${r.number}: ${r.total} (paid ${r.paid}), due ${r.due}`).join('\n')}\nPay from [Billing](/client/billing).` : 'All your invoices are paid. Thank you!', citations: [{ label: 'Billing', href: '/client/billing' }] };
    }
    if (CLIENT_KEYWORDS.requests.test(q)) {
      const out = await this.call(tools, 'my_requests', {}, emit);
      const rows = out.data as { status: string; text: string; link: string }[];
      return { text: rows.length ? `Your requests:\n${rows.slice(0, 8).map((r) => `- [${r.text.slice(0, 60)}](${r.link}): ${r.status.replace('_', ' ')}`).join('\n')}` : 'You have no requests yet.', citations: out.citations };
    }
    if (/\bwaiting\b/.test(q)) {
      const out = await this.call(tools, 'my_reviews', {}, emit);
      const rows = (out.data as { title: string; status: string; waitingOnYou: boolean; link: string }[]).filter((d) => d.waitingOnYou);
      return { text: rows.length ? `${rows.length} draft${rows.length === 1 ? ' is' : 's are'} waiting for your approval:\n${rows.map((d) => `- [${d.title}](${d.link})`).join('\n')}` : 'Nothing is waiting for your approval right now.', citations: out.citations };
    }
    // Services, progress, milestones, "how is my project going" and anything else: the account overview.
    const out = await this.call(tools, 'my_account', {}, emit);
    const d = out.data as { company: string; accountManager: string | null; services: { service: string; status: string; milestone: string; requirementsPending: number }[]; invoicesDue: { number: string; total: string }[] };
    return {
      text: `${d.company}: ${d.services.length} service${d.services.length === 1 ? '' : 's'} with BMU.\n${d.services.map((s) => `- ${s.service}: ${s.status.replaceAll('_', ' ')} (milestone ${s.milestone})${s.requirementsPending ? `, ${s.requirementsPending} item${s.requirementsPending === 1 ? '' : 's'} needed from you` : ''}`).join('\n')}${d.invoicesDue.length ? `\n${d.invoicesDue.length} invoice${d.invoicesDue.length === 1 ? '' : 's'} due — see [Billing](/client/billing).` : ''}\nYour client manager is ${d.accountManager ?? 'being assigned'}.`,
      citations: out.citations,
    };
  }
}

type TaskLine = { title: string; client: string | null; status: string; due: string | null; link: string; reason?: string | null };
type MyWeek = {
  name: string;
  tasks: { open: number; overdue: TaskLine[]; dueToday: TaskLine[]; dueThisWeek: TaskLine[]; blocked: TaskLine[]; doneRecently: number };
  qc: { sentBackToMe: { id: string; title: string; note: string | null; reviewer: string | null }[]; waitingForMyCheck: { id: string; title: string; owner: string | null }[]; versionsWaitingForQc: number };
  myClients?: { name: string; health: string; link: string }[];
  openRequests?: { count: number; replyOverdue: number };
  leads?: { open: number; followUpsThisWeek: { name: string; due: string | null; link: string }[] };
  deliveryAtRisk: { title: string; state: string; client: string }[];
  sendToClientWaiting: number;
  onLeave: { label: string; until: string } | null;
  attendance: {
    workday: 'working' | 'weekend' | 'holiday';
    holiday: string | null;
    checkIn: string | null;
    checkOut: string | null;
    late: boolean;
    wfh: boolean;
    workingHours: string | null;
    missedCheckOut: string | null;
    nextCheckIn: string | null;
    leaveDecision: { status: 'approved' | 'rejected'; title: string } | null;
  };
  eod: { submitted: boolean; exempt: boolean; completed: number; pending: number; blocked: number; waiting: number };
  teamReports: { submitted: number; total: number } | null;
};

/**
 * Basic-mode (no AI key) keywords, one group per part of the team dashboard. The order the groups are checked in
 * lives in basicStaff; a question that fits nothing gets the help list.
 */
export const STAFF_KEYWORDS = {
  help: /^(hi|hello|hey|help|menu|hii+)\b|\bwhat (can|do) you (do|answer|know)\b|\bhow (do|can) i use (you|this)\b|\bwhat (questions|can i ask)\b/,
  attendance:
    /\b(check[- ]?ins?|checked (in|out)|check[- ]?outs?|attendance|punch(ed)?( in| out)?|clock(ed)?[- ]?(in|out)|late (today|mark|coming)|was i late|am i late|came late|working hours|office (hours|timings?|time)|shift|holidays?|weekly off|day off|week ?off|wfh|work(ing)? from home|leaves?|on leave|time off|vacation|sick)\b/,
  eod: /\b(eod|end[- ]of[- ](the[- ])?day|daily (report|update|status)s?|day report|stand-?up|team reports?|who (has |have )?(filed|submitted|sent))\b/,
  qc: /\b(qc|quality( checks?)?|sent back|send back|rework|redo|rejected by qc|review queue|to review|checks? (waiting|pending)|my checks?)\b/,
  sendToClient: /\b(ready to send|send(ing)? to (the )?clients?|sent to (the )?clients?|share with (the )?clients?|waiting to (be )?sen[dt])\b/,
  tasks: /\b(tasks?|to ?dos?|work|assignments?|jobs?|deadlines?|plate|pending)\b/,
  delivery: /\b(deliver(y|ies|ables?)|delayed|behind schedule|due soon|milestones?|at risk delivery|slipping)\b/,
  mine: /\b(my (tasks?|work|day|week|clients?|leads?|summary|dashboard|status|update|pending|follow[- ]?ups?|plan|priorities|schedule|agenda)|what should i|what do i have|what('s| is) (on|in) my|my to ?do|pending (for|on) me|on my plate|what (do|should) i (do|work on|focus on)|what to do (today|next|now)|plan for (today|the day)|good morning)\b/,
  money:
    /\b(overdue|owe|owes|owed|outstanding|invoices?|payments?|due|collect(ion|ions)?|bills?|billing|receivables?|dues|unpaid|pending (payments?|amount)|money|balance|gst|paid|receipts?|cash ?flow|amount (due|pending))\b/,
  leads: /\b(leads?|pipeline|follow[- ]?ups?|follow up|prospects?|deals?|enquir(y|ies)|inquir(y|ies)|opportunit(y|ies)|proposals?|quotes?|quotations?|hot|cold|won|lost|new business|conversion)\b/,
  requests: /\b(requests?|tickets?|complaints?|escalations?|change requests?|quer(y|ies)|issues?|support|reply time|first reply|sla|unanswered)\b/,
  sales: /\b(target|targets|scorecard|kpis?|projection|projected|forecast|sales (numbers|figures|this month|performance|report)|run rate|how (are|is) (we|sales) doing)\b/,
  team: /\b(team performance|performance|utili[sz]ation|productivity|on[- ]time|who (is|are) (busy|free|overloaded|available)|capacity|workload|top performers?|hours logged|team (load|status))\b/,
  clients: /\b(clients?|accounts?|customers?|brands?)\b/,
  summary: /\b(week|weekly|summary|summarise|summarize|how are we|revenue|business|numbers|overview|dashboard|recap|highlights|this month|monthly|what('s| is) happening|anything important|report)\b/,
};

export const CLIENT_KEYWORDS = {
  help: /^(hi|hello|hey|help|menu|hii+)\b|\bwhat (can|do) you (do|answer|know)\b|\bwhat (questions|can i ask)\b/,
  contact:
    /\b(client manager|account manager|my manager|contact|reach|call (you|bmu|them|my)|phone( number)?|contact number|email|e-mail|who (is|handles|manages|looks after)|talk to|speak to|whatsapp|meeting|book a call)\b/,
  plans: /\b(plans?|content calendar|calendar|monthly plan|strategy|schedule|posting schedule)\b/,
  requirements:
    /\b(requirements?|checklist|onboarding|documents?|docs|logins?|access|credentials|passwords?|what do you need|need from (me|us)|pending from (me|us)|send you|upload|brand (files|assets|kit)|materials?|assets)\b/,
  approvals:
    /\b(approv(e|al|als|ed)|drafts?|reviews?|feedback|sign[- ]?off|creatives?|designs?|posts?|videos?|reels?|deliverables?|revisions?|changes to|content)\b/,
  money:
    /\b(invoices?|pay|paid|payments?|due|bills?|billing|owe|amount|balance|receipts?|gst|outstanding|charges|fees|price|cost|refund|pending amount|dues)\b/,
  requests: /\b(requests?|tickets?|complaints?|issues?|problems?|change requests?|asked for|quer(y|ies)|support)\b/,
};

const CLIENT_HELP = `I can help with your account. Try asking:
- What is waiting for my approval?
- Do I have any invoices due? / What have I paid?
- What do you still need from me?
- Is my monthly plan ready?
- What is the status of my requests?
- How is my project going? Which milestone are we at?
- Who is my client manager and how do I reach them?`;

function staffHelp(client?: string, person?: string) {
  return `In basic mode I can answer questions about what is on your dashboard:
- **Your day:** What should I do today? What is overdue? What is due this week? Anything blocked?
- **Attendance and leave:** Did I check in today? Was I late? Is today a holiday? Is my leave approved?
- **End-of-day report:** Have I filed my EOD? How many of my team filed theirs?
- **QC:** What was sent back by QC? What is waiting for my check? What is ready to send to the client?
- **Delivery:** Which deliverables are at risk?
- **Clients:** List my clients. Which clients are at risk and why? Tell me about ${client ?? 'Metro Dental'}.
- **Money** (Founder, Branch Manager, Finance): How much is overdue from ${client ?? 'Metro Dental'}?
- **Sales:** Show open leads and follow-ups. How are we doing against target?
- **Requests:** Show open requests. Which replies are overdue?
- **Team** (leadership): What is ${person?.split(' ')[0] ?? 'Meera'} working on? Team performance and workload.
- **Summary of the week**`;
}

const TaskLineText = (x: TaskLine) => `- [${x.title}](${x.link})${x.client ? ` · ${x.client}` : ''}${x.due ? ` · due ${x.due}` : ''}${x.reason ? ` · ${x.reason}` : ''}`;

function taskList(title: string, rows: TaskLine[], empty: string) {
  if (!rows.length) return empty;
  return `${title} (${rows.length}):\n${rows.slice(0, 12).map(TaskLineText).join('\n')}${rows.length > 12 ? `\n…and ${rows.length - 12} more in [My tasks](/team/tasks).` : ''}`;
}

function attendanceText(d: MyWeek) {
  const a = d.attendance;
  const out: string[] = [];
  if (d.onLeave) out.push(`You are on ${d.onLeave.label.toLowerCase()} until ${d.onLeave.until}, so check-in is closed.`);
  else if (a.workday === 'holiday') out.push(`Today is a holiday${a.holiday ? ` (${a.holiday})` : ''}.${a.nextCheckIn ? ` Check-in opens again on ${a.nextCheckIn}.` : ''}`);
  else if (a.workday === 'weekend') out.push(`Today is your weekly off.${a.nextCheckIn ? ` Check-in opens again on ${a.nextCheckIn}.` : ''}`);
  else if (a.checkIn) out.push(`You checked in at ${a.checkIn}${a.late ? ' (marked late)' : ' (on time)'}${a.wfh ? ', working from home' : ''}.${a.checkOut ? ` You checked out at ${a.checkOut}.` : ' You have not checked out yet.'}`);
  else out.push(`You have not checked in today.${a.wfh ? ' You are working from home today.' : ''} Check in from [My Day](/team).`);
  if (a.workingHours) out.push(`Working hours: ${a.workingHours}.`);
  if (a.missedCheckOut) out.push(`You missed checking out on ${a.missedCheckOut}. Ask for a correction from [My Day](/team).`);
  if (a.leaveDecision) out.push(`Your leave request "${a.leaveDecision.title}" was ${a.leaveDecision.status}. See [Leave](/team/leave).`);
  else out.push('Leave requests and balances are on [Leave](/team/leave).');
  return out.join('\n');
}

function eodText(d: MyWeek) {
  const e = d.eod;
  const out: string[] = [];
  if (e.exempt) out.push('You do not need to file an end-of-day report.');
  else if (e.submitted) out.push(`You have filed today's end-of-day report: ${e.completed} done, ${e.pending} pending, ${e.blocked} blocked, ${e.waiting} waiting on others.`);
  else out.push(`You have not filed today's end-of-day report yet${e.completed + e.pending + e.blocked + e.waiting ? ` (draft: ${e.completed} done, ${e.pending} pending, ${e.blocked} blocked)` : ''}. File it from [My Day](/team).`);
  if (d.teamReports) out.push(`Your team: ${d.teamReports.submitted} of ${d.teamReports.total} have filed today's report. See [Daily reports](/team/reports).`);
  return out.join('\n');
}

function qcText(d: MyWeek) {
  const out: string[] = [];
  if (d.qc.sentBackToMe.length) out.push(`Sent back to you by QC:\n${d.qc.sentBackToMe.map((x) => `- [${x.title}](/team/tasks/${x.id})${x.note ? ` · ${x.reviewer ? `${x.reviewer}: ` : ''}${x.note.slice(0, 120)}` : ''}`).join('\n')}`);
  if (d.qc.waitingForMyCheck.length) out.push(`Waiting for your QC check:\n${d.qc.waitingForMyCheck.map((x) => `- [${x.title}](/team/tasks/${x.id})${x.owner ? ` · done by ${x.owner}` : ''}`).join('\n')}`);
  if (d.qc.versionsWaitingForQc) out.push(`${d.qc.versionsWaitingForQc} version${d.qc.versionsWaitingForQc === 1 ? ' is' : 's are'} waiting in the [QC queue](/team/qc).`);
  if (d.sendToClientWaiting) out.push(`${d.sendToClientWaiting} passed QC and ${d.sendToClientWaiting === 1 ? 'is' : 'are'} ready to send to the client ([Review Studio](/team/reviews)).`);
  return out.length ? out.join('\n\n') : 'Nothing is waiting on QC for you: no tasks sent back and no checks to do.';
}

function deliveryText(d: MyWeek) {
  if (!d.deliveryAtRisk.length) return 'No delivery step of yours is late or due soon.';
  return `Delivery steps to watch:\n${d.deliveryAtRisk.map((x) => `- ${x.title} · ${x.client} · ${x.state === 'overdue' ? 'late' : 'due soon'}`).join('\n')}`;
}

/** v55: "Summary of the week" for anyone: their own tasks, QC, clients, requests and leads (what My Day shows). */
export function myWeekText(d: MyWeek): string {
  const t = (x: TaskLine) => `- [${x.title}](${x.link})${x.client ? ` · ${x.client}` : ''}${x.due ? ` · due ${x.due}` : ''}${x.reason ? ` · ${x.reason}` : ''}`;
  const out: string[] = [];
  if (d.onLeave) out.push(`You are on ${d.onLeave.label.toLowerCase()} until ${d.onLeave.until}.`);
  out.push(`**Your week, ${d.name.split(' ')[0]}:** ${d.tasks.open} open task${d.tasks.open === 1 ? '' : 's'}, ${d.tasks.overdue.length} overdue, ${d.tasks.dueToday.length} due today, ${d.tasks.dueThisWeek.length} due in the next 7 days, ${d.tasks.blocked.length} blocked. ${d.tasks.doneRecently} done in the last 2 weeks.`);
  if (d.tasks.overdue.length) out.push(`Overdue first:\n${d.tasks.overdue.slice(0, 6).map(t).join('\n')}`);
  if (d.tasks.dueToday.length) out.push(`Due today:\n${d.tasks.dueToday.slice(0, 6).map(t).join('\n')}`);
  if (d.tasks.dueThisWeek.length) out.push(`Coming up this week:\n${d.tasks.dueThisWeek.slice(0, 6).map(t).join('\n')}`);
  if (d.tasks.blocked.length) out.push(`Blocked:\n${d.tasks.blocked.slice(0, 4).map(t).join('\n')}`);
  if (d.qc.sentBackToMe.length) out.push(`Sent back by QC:\n${d.qc.sentBackToMe.map((x) => `- [${x.title}](/team/tasks/${x.id})${x.note ? ` · ${x.reviewer ? `${x.reviewer}: ` : ''}${x.note.slice(0, 120)}` : ''}`).join('\n')}`);
  if (d.qc.waitingForMyCheck.length) out.push(`Waiting for your QC check:\n${d.qc.waitingForMyCheck.map((x) => `- [${x.title}](/team/tasks/${x.id})${x.owner ? ` · done by ${x.owner}` : ''}`).join('\n')}`);
  if (d.qc.versionsWaitingForQc) out.push(`${d.qc.versionsWaitingForQc} version${d.qc.versionsWaitingForQc === 1 ? ' is' : 's are'} waiting in the [QC queue](/team/qc).`);
  if (d.myClients?.length) {
    const watch = d.myClients.filter((c) => c.health !== 'green');
    out.push(`You manage ${d.myClients.length} client${d.myClients.length === 1 ? '' : 's'}${watch.length ? `; ${watch.length} need attention: ${watch.map((c) => `[${c.name}](${c.link}) (${c.health})`).join(', ')}` : ', all green'}.`);
  }
  if (d.openRequests?.count) out.push(`${d.openRequests.count} open client request${d.openRequests.count === 1 ? '' : 's'}${d.openRequests.replyOverdue ? `, ${d.openRequests.replyOverdue} with the first reply overdue` : ''}. See [Requests](/team/requests).`);
  if (d.leads) out.push(`${d.leads.open} open lead${d.leads.open === 1 ? '' : 's'} of yours${d.leads.followUpsThisWeek.length ? `; follow-ups due this week:\n${d.leads.followUpsThisWeek.slice(0, 6).map((l) => `- [${l.name}](${l.link})${l.due ? ` · ${l.due}` : ''}`).join('\n')}` : '.'}`);
  if (d.deliveryAtRisk.length) out.push(`Delivery steps to watch: ${d.deliveryAtRisk.slice(0, 4).map((x) => `${x.title} (${x.client}, ${x.state === 'overdue' ? 'late' : 'due soon'})`).join('; ')}.`);
  if (!d.tasks.open && !d.qc.waitingForMyCheck.length && !d.myClients?.length && !d.leads?.open) out.push('Nothing is waiting on you right now.');
  return out.join('\n\n');
}
