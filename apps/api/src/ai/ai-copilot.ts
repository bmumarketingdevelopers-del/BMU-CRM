// Ask BMU: natural-language questions over the CRM with Claude tool use (manual loop, read-only tools in the
// person's own scope), conversation history per user, and a keyword-based basic mode when no key is set.
import type Anthropic from '@anthropic-ai/sdk';
import { Injectable, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { type AiAskInput, type AiChatMessage, type AiCitation, type AiConversationSummary, type AiConversationView, type AiResult, type AiStreamEvent, type Me } from '@bmu/shared';
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
- For anything you cannot answer, suggest messaging their account manager from Messages.

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
    return { id: c.id, title: c.title, updatedAt: c.updatedAt.toISOString(), messages: c.messages as AiChatMessage[] };
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
    const deny = (what: string) => ({ text: `Your role cannot see ${what}. The Founder, Branch Manager or Finance team can.`, citations: [] });

    if (/\b(risk|health|churn|unhappy|at-risk)\b/.test(q)) {
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
    if (/\b(overdue|owe|owes|outstanding|invoice|invoices|payment|payments|due|collect)\b/.test(q) && !/\btask/.test(q)) {
      const out = await this.call(tools, 'find_invoices', { client: client?.name, status: q.includes('overdue') ? 'overdue' : undefined }, emit);
      if (notAllowed(out)) return deny('invoices');
      const d = out.data as { count: number; totalOwed: string; invoices: { number: string; client: string; status: string; balance: string; due: string; link: string }[] };
      if (!d.count) return { text: `Nothing ${q.includes('overdue') ? 'overdue' : 'owed'}${client ? ` from ${client.name}` : ''} right now.`, citations: [] };
      return {
        text: `${client ? `${client.name} owes` : 'Total owed:'} ${d.totalOwed} across ${d.count} invoice${d.count === 1 ? '' : 's'}:\n${d.invoices.slice(0, 10).map((i) => `- [${i.number}](${i.link}) · ${i.client} · ${i.balance} (${i.status.replace('_', ' ')}, due ${i.due})`).join('\n')}`,
        citations: out.citations,
      };
    }
    if (person && /\b(working|work|tasks?|doing|busy|plate|assigned)\b/.test(q)) {
      const out = await this.call(tools, 'find_tasks', { person: person.name.split(/\s+/)[0] }, emit);
      if (notAllowed(out)) return deny("other people's tasks");
      const rows = out.data as { title: string; client: string | null; status: string; due: string | null; overdue: boolean; link: string }[];
      if (!rows.length) return { text: `${person.name} has no open tasks you can see.`, citations: [] };
      return {
        text: `${person.name} has ${rows.length} open task${rows.length === 1 ? '' : 's'}${rows.some((r) => r.overdue) ? ` (${rows.filter((r) => r.overdue).length} overdue)` : ''}:\n${rows.slice(0, 12).map((t) => `- [${t.title}](${t.link})${t.client ? ` · ${t.client}` : ''} · ${t.status.replace('_', ' ')}${t.due ? ` · due ${t.due}` : ''}${t.overdue ? ' · overdue' : ''}`).join('\n')}`,
        citations: out.citations,
      };
    }
    if (/\b(lead|leads|pipeline|follow|prospect)/.test(q)) {
      const out = await this.call(tools, 'find_leads', {}, emit);
      if (notAllowed(out)) return deny('leads');
      const rows = (out.data as { name: string; company: string | null; stage: string; score: number; nextFollowUp: string | null; link: string }[]).filter((l) => !['Won', 'Lost'].includes(l.stage));
      return {
        text: rows.length ? `${rows.length} open leads. Highest scores first:\n${[...rows].sort((a, b) => b.score - a.score).slice(0, 10).map((l) => `- [${l.company || l.name}](${l.link}) · ${l.stage} · score ${l.score}${l.nextFollowUp ? ` · follow up ${l.nextFollowUp}` : ''}`).join('\n')}` : 'No open leads right now.',
        citations: out.citations,
      };
    }
    if (/\brequests?\b/.test(q)) {
      const out = await this.call(tools, 'find_requests', { client: client?.name }, emit);
      if (notAllowed(out)) return deny('the requests desk');
      const rows = out.data as { client: string; type: string; status: string; text: string; replyTime: string; link: string }[];
      return {
        text: rows.length ? `${rows.length} open request${rows.length === 1 ? '' : 's'}:\n${rows.slice(0, 10).map((r) => `- [${r.client}: ${r.text.slice(0, 60)}](${r.link}) · ${r.type.replace('_', ' ')} · ${r.status.replace('_', ' ')}${r.replyTime === 'overdue' ? ' · reply overdue' : ''}`).join('\n')}` : 'No open requests.',
        citations: out.citations,
      };
    }
    if (client) {
      const out = await this.call(tools, 'client_360', { client: client.id }, emit);
      if (notAllowed(out)) return deny('this client');
      const d = out.data as { client: { name: string; health: string; am: string | null }; stats: { activeServices: number; openRequests: number; draftsWaiting: number; outstanding: string }; deliverables: { title: string; overdue: boolean }[]; link: string };
      const overdue = d.deliverables.filter((x) => x.overdue).length;
      return {
        text: `[${d.client.name}](${d.link}) — health ${d.client.health}, account manager ${d.client.am ?? 'not assigned'}.\n- ${d.stats.activeServices} active service${d.stats.activeServices === 1 ? '' : 's'}, ${d.stats.openRequests} open request${d.stats.openRequests === 1 ? '' : 's'}, ${d.stats.draftsWaiting} draft${d.stats.draftsWaiting === 1 ? '' : 's'} waiting for the client\n- Outstanding: ${d.stats.outstanding}${overdue ? `\n- ${overdue} deliverable${overdue === 1 ? ' is' : 's are'} overdue` : ''}`,
        citations: out.citations,
      };
    }
    if (/\b(week|summary|how are we|revenue|business|numbers|overview)\b/.test(q)) {
      const out = await this.call(tools, 'business_summary', {}, emit);
      if (notAllowed(out)) return deny('the business summary');
      const d = out.data as { money: { revenueThisMonth: string; revenueLastMonth: string; outstanding: string } | string; activeClients: number; openLeads: number; overdueTasks: number; replyTimeBreachesThisWeek: number };
      const money = typeof d.money === 'string' ? '' : `Revenue this month ${d.money.revenueThisMonth} (last month ${d.money.revenueLastMonth}); ${d.money.outstanding} outstanding.\n`;
      return { text: `${money}${d.activeClients} active clients, ${d.openLeads} open leads, ${d.overdueTasks} overdue tasks, ${d.replyTimeBreachesThisWeek} reply-time misses this week. See the [Weekly Review](/admin).`, citations: out.citations };
    }
    return {
      text: `In basic mode I can answer questions like:\n- Which clients are at risk this month and why?\n- How much is overdue from ${clientList[0]?.name ?? 'Metro Dental'}?\n- What is ${staff[0]?.name.split(' ')[0] ?? 'Meera'} working on?\n- Show open leads / open requests\n- Summary of the week`,
      citations: [],
    };
  }

  private async basicClient(question: string, tools: CopilotTool[], emit: Emit): Promise<AiOut> {
    const q = question.toLowerCase();
    if (/\b(invoice|invoices|pay|paid|payment|due|bill|billing|owe)\b/.test(q)) {
      const out = await this.call(tools, 'my_invoices', {}, emit);
      if ((out.data as { notAllowed?: boolean }).notAllowed) return { text: 'Your user role cannot see billing. Your account owner can, or ask your account manager in [Messages](/client/messages).', citations: [{ label: 'Messages', href: '/client/messages' }] };
      const rows = out.data as { number: string; status: string; total: string; paid: string; due: string }[];
      const open = rows.filter((r) => !['paid', 'void', 'credit_noted'].includes(r.status));
      return { text: open.length ? `You have ${open.length} invoice${open.length === 1 ? '' : 's'} to pay:\n${open.map((r) => `- ${r.number}: ${r.total} (paid ${r.paid}), due ${r.due}`).join('\n')}\nPay from [Billing](/client/billing).` : 'All your invoices are paid. Thank you!', citations: [{ label: 'Billing', href: '/client/billing' }] };
    }
    if (/\brequests?\b/.test(q)) {
      const out = await this.call(tools, 'my_requests', {}, emit);
      const rows = out.data as { status: string; text: string; link: string }[];
      return { text: rows.length ? `Your requests:\n${rows.slice(0, 8).map((r) => `- [${r.text.slice(0, 60)}](${r.link}): ${r.status.replace('_', ' ')}`).join('\n')}` : 'You have no requests yet.', citations: out.citations };
    }
    if (/\b(approve|approval|draft|drafts|review|waiting)\b/.test(q)) {
      const out = await this.call(tools, 'my_reviews', {}, emit);
      const rows = (out.data as { title: string; status: string; waitingOnYou: boolean; link: string }[]).filter((d) => d.waitingOnYou);
      return { text: rows.length ? `${rows.length} draft${rows.length === 1 ? ' is' : 's are'} waiting for your approval:\n${rows.map((d) => `- [${d.title}](${d.link})`).join('\n')}` : 'Nothing is waiting for your approval right now.', citations: out.citations };
    }
    const out = await this.call(tools, 'my_account', {}, emit);
    const d = out.data as { company: string; accountManager: string | null; services: { service: string; status: string; milestone: string; requirementsPending: number }[]; invoicesDue: { number: string; total: string }[] };
    return {
      text: `${d.company}: ${d.services.length} service${d.services.length === 1 ? '' : 's'} with BMU.\n${d.services.map((s) => `- ${s.service}: ${s.status.replaceAll('_', ' ')} (milestone ${s.milestone})${s.requirementsPending ? `, ${s.requirementsPending} item${s.requirementsPending === 1 ? '' : 's'} needed from you` : ''}`).join('\n')}${d.invoicesDue.length ? `\n${d.invoicesDue.length} invoice${d.invoicesDue.length === 1 ? '' : 's'} due — see [Billing](/client/billing).` : ''}\nYour account manager is ${d.accountManager ?? 'being assigned'}.`,
      citations: out.citations,
    };
  }
}
