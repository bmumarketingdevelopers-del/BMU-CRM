// v15 agent action catalogue. Every action an agent can take is defined here once: its input, a permission check
// that runs as a given person (the agent's acting person when proposing, and the approver again when approving),
// and how to apply it through the existing services, returning the rows needed to undo it.
// Policies live in @bmu/shared (agentActionInfo): auto actions run straight away, confirm actions wait in the
// Agent Inbox, never actions have no implementation at all.
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { agentActionInfo, formatINR, REQUEST_TYPES, type AgentAction, type AgentProposalField, type Me, type RequestType } from '@bmu/shared';
import { z } from 'zod';
import { ReassignService } from '../actions/reassign.service.js';
import type { UndoRow } from '../actions/registry.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductionService } from '../production/production.service.js';
import { RequestsService } from '../requests/requests.service.js';
import { SellService } from '../sell/sell.service.js';
import { EmailService } from '../service/email.service.js';
import { DunningService } from '../service/dunning.service.js';
import { canWriteFinance } from '../insights/access.js';
import { loadLedger } from '../insights/ledger.js';
import { CapacityService } from '../money/capacity.service.js';
import { isMonday, mondayOf, todayIst } from '../money/dates.js';
import { PaymentsHubService } from '../money/payments-hub.service.js';

export type ActCtx = { me: Me; ref: ModuleRef; agentLabel: string };
export type ActResult = { message: string; link: string | null; undo: UndoRow[] | null; output?: unknown };
export type ActDescribe = { title: string; summary: string; link: string | null; target: { type: string; id: string } | null };

export type ActionImpl = {
  name: AgentAction;
  description: string;
  schema: z.ZodType<Record<string, unknown>>;
  /** JSON schema properties for the model's tool definition. */
  properties: Record<string, unknown>;
  required: string[];
  /** Fields the person deciding may edit in the Agent Inbox. */
  fields?: (input: Record<string, unknown>, ctx: ActCtx) => Promise<AgentProposalField[]>;
  /** Besides the Founder and Admins, who may decide the proposal (always includes the acting person). */
  deciders?: (input: Record<string, unknown>, ctx: ActCtx) => Promise<(string | null | undefined)[]>;
  describe: (input: Record<string, unknown>, ctx: ActCtx) => Promise<ActDescribe>;
  /** Throws (403/404/400) when this person may not do it. Runs before anything changes. */
  check: (input: Record<string, unknown>, ctx: ActCtx) => Promise<void>;
  apply: (input: Record<string, unknown>, ctx: ActCtx) => Promise<ActResult>;
};

const get = <T>(ref: ModuleRef, cls: new (...args: never[]) => T): T => ref.get(cls as never, { strict: false }) as T;
const str = (d: string) => ({ type: 'string', description: d });
const day = (d: Date) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }).format(d);
const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const DAY = 86_400_000;

const leadName = (l: { contact: unknown }) => {
  const c = l.contact as { company?: string; name?: string };
  return c.company || c.name || 'Lead';
};

async function leadFor(ctx: ActCtx, id: string) {
  // The Sell service applies the person's own lead scope (own leads for sales executives) and 404s otherwise.
  await get(ctx.ref, SellService).detail(ctx.me, id);
  return get(ctx.ref, PrismaService).lead.findFirstOrThrow({ where: { id, orgId: ctx.me.orgId } });
}

function assertLeads(me: Me) {
  if (me.type !== 'staff' || (me.permissions.leads_pipeline?.scope ?? 'none') === 'none') throw new ForbiddenException('This person cannot work on leads');
}

async function requestFor(ctx: ActCtx, id: string) {
  if (ctx.me.type !== 'staff') throw new ForbiddenException('Team accounts only');
  return get(ctx.ref, RequestsService).get(ctx.me, id);
}

/** A draft version the person can open (the Review Studio applies their own client scope). */
async function versionFor(ctx: ActCtx, id: string) {
  if (ctx.me.type !== 'staff') throw new ForbiddenException('Team accounts only');
  const v = await get(ctx.ref, PrismaService).version.findFirst({ where: { id, orgId: ctx.me.orgId }, select: { id: true, number: true, deliverableId: true } });
  if (!v) throw new NotFoundException('Version not found');
  const d = await get(ctx.ref, ProductionService).deliverable(ctx.me, v.deliverableId);
  return { ...v, title: d.title };
}

async function staffName(ctx: ActCtx, id: string) {
  const u = await get(ctx.ref, PrismaService).user.findFirst({ where: { id, orgId: ctx.me.orgId, type: 'staff', deletedAt: null }, select: { name: true } });
  return u?.name ?? 'someone';
}

async function candidateFields(ctx: ActCtx, type: string, id: string, key: string, label: string): Promise<AgentProposalField[]> {
  const c = await get(ctx.ref, ReassignService)
    .candidates(ctx.me, type, [id], {})
    .catch(() => null);
  const options = (c?.candidates ?? []).filter((p) => !p.blockedReason && !p.current).map((p) => ({ value: p.id, label: `${p.name}${p.role ? ` · ${p.role}` : ''} · ${p.loadPct}% busy` }));
  return [{ key, label, kind: 'person', options }];
}

async function reassign(ctx: ActCtx, type: string, id: string, toUserId: string, reason: 'leave' | 'overload' | 'other', note: string): Promise<ActResult & { pendingApproval?: boolean }> {
  const r = await get(ctx.ref, ReassignService).run(ctx.me, type, { ids: [id], toUserId, reason, note, handoverNote: note, deadline: { mode: 'keep' } }, { skipUndo: true });
  if (r.approval) return { message: r.message, link: null, undo: null, pendingApproval: true };
  return { message: r.message, link: null, undo: r.undoRows ?? null };
}

async function audit(ctx: ActCtx, action: AgentAction, entity: string, id: string, before: unknown, after: unknown) {
  await get(ctx.ref, AuditService).log(ctx.me, `agent.${action}`, entity, id, before ?? null, { ...(after as object), agent: ctx.agentLabel });
}

const never = (name: AgentAction): ActionImpl => ({
  name,
  description: agentActionInfo[name].label,
  schema: z.record(z.string(), z.unknown()),
  properties: {},
  required: [],
  describe: async () => ({ title: agentActionInfo[name].label, summary: agentActionInfo[name].why, link: null, target: null }),
  check: async () => {
    throw new ForbiddenException(`Agents are never allowed to: ${agentActionInfo[name].label.toLowerCase()}`);
  },
  apply: async () => {
    throw new ForbiddenException(`Agents are never allowed to: ${agentActionInfo[name].label.toLowerCase()}`);
  },
});

const requestTypeLabels: Record<RequestType, string> = { change: 'Change to current work', new_scope: 'New scope (needs a quote)', urgent: 'Urgent', question: 'Question', billing: 'Billing' };

export const ACTIONS: Record<AgentAction, ActionImpl> = {
  add_lead_note: {
    name: 'add_lead_note',
    description: 'Add an internal note to a lead (a short brief, what you found, the next best step). Internal only.',
    schema: z.object({ leadId: z.string().min(1), text: z.string().trim().min(2).max(3000) }),
    properties: { leadId: str('Lead id'), text: str('The note, a few short lines') },
    required: ['leadId', 'text'],
    describe: async (i, ctx) => {
      const l = await get(ctx.ref, PrismaService).lead.findFirst({ where: { id: String(i.leadId), orgId: ctx.me.orgId } });
      return { title: `Added a note to ${l ? leadName(l) : 'the lead'}`, summary: clip(String(i.text), 200), link: `/team/leads/${i.leadId}`, target: { type: 'Lead', id: String(i.leadId) } };
    },
    check: async (i, ctx) => {
      assertLeads(ctx.me);
      await leadFor(ctx, String(i.leadId));
    },
    apply: async (i, ctx) => {
      const lead = await leadFor(ctx, String(i.leadId));
      // Not logLeadActivity: an agent note is not a conversation, so it must not reset "last activity" (stalled deals).
      const a = await get(ctx.ref, PrismaService).leadActivity.create({ data: { orgId: ctx.me.orgId, leadId: lead.id, kind: 'note', body: `${ctx.agentLabel}: ${String(i.text)}`, userId: ctx.me.id } });
      return { message: 'Note added', link: `/team/leads/${lead.id}`, undo: [{ model: 'leadActivity', id: a.id, delete: true }] };
    },
  },

  set_lead_score: {
    name: 'set_lead_score',
    description: 'Set the lead score (0-100) with a one-line reason.',
    schema: z.object({ leadId: z.string().min(1), score: z.number().int().min(0).max(100), reason: z.string().trim().max(300).optional() }),
    properties: { leadId: str('Lead id'), score: { type: 'integer', description: 'Score from 0 to 100' }, reason: str('One-line reason') },
    required: ['leadId', 'score'],
    describe: async (i, ctx) => {
      const l = await get(ctx.ref, PrismaService).lead.findFirst({ where: { id: String(i.leadId), orgId: ctx.me.orgId } });
      return { title: `Scored ${l ? leadName(l) : 'the lead'} ${String(i.score)}/100`, summary: String(i.reason ?? ''), link: `/team/leads/${i.leadId}`, target: { type: 'Lead', id: String(i.leadId) } };
    },
    check: async (i, ctx) => {
      assertLeads(ctx.me);
      await leadFor(ctx, String(i.leadId));
    },
    apply: async (i, ctx) => {
      const lead = await leadFor(ctx, String(i.leadId));
      await get(ctx.ref, PrismaService).lead.update({ where: { id: lead.id }, data: { score: Number(i.score) } });
      await audit(ctx, 'set_lead_score', 'Lead', lead.id, { score: lead.score }, { score: i.score });
      return { message: `Score ${lead.score} → ${String(i.score)}`, link: `/team/leads/${lead.id}`, undo: [{ model: 'lead', id: lead.id, data: { score: lead.score } }] };
    },
  },

  set_lead_follow_up: {
    name: 'set_lead_follow_up',
    description: 'Set the next follow-up date for a lead (YYYY-MM-DD, today or later).',
    schema: z.object({ leadId: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
    properties: { leadId: str('Lead id'), date: str('Date as YYYY-MM-DD') },
    required: ['leadId', 'date'],
    describe: async (i, ctx) => {
      const l = await get(ctx.ref, PrismaService).lead.findFirst({ where: { id: String(i.leadId), orgId: ctx.me.orgId } });
      return { title: `Set a follow-up for ${l ? leadName(l) : 'the lead'} on ${day(new Date(`${String(i.date)}T10:00:00+05:30`))}`, summary: '', link: `/team/leads/${i.leadId}`, target: { type: 'Lead', id: String(i.leadId) } };
    },
    check: async (i, ctx) => {
      assertLeads(ctx.me);
      await leadFor(ctx, String(i.leadId));
      if (new Date(`${String(i.date)}T23:59:59+05:30`).getTime() < Date.now()) throw new BadRequestException('Pick a follow-up date from today onwards');
    },
    apply: async (i, ctx) => {
      const lead = await leadFor(ctx, String(i.leadId));
      const at = new Date(`${String(i.date)}T10:00:00+05:30`);
      await get(ctx.ref, PrismaService).lead.update({ where: { id: lead.id }, data: { nextFollowUpAt: at, followUpNotifiedAt: null } });
      await audit(ctx, 'set_lead_follow_up', 'Lead', lead.id, { nextFollowUpAt: lead.nextFollowUpAt }, { nextFollowUpAt: at });
      return { message: `Follow-up on ${day(at)}`, link: `/team/leads/${lead.id}`, undo: [{ model: 'lead', id: lead.id, data: { nextFollowUpAt: lead.nextFollowUpAt, followUpNotifiedAt: lead.followUpNotifiedAt } }] };
    },
  },

  add_request_note: {
    name: 'add_request_note',
    description: 'Add an internal note to a client request (type, urgency, scope, suggested next step). The client never sees it.',
    schema: z.object({ requestId: z.string().min(1), text: z.string().trim().min(2).max(3000) }),
    properties: { requestId: str('Request id'), text: str('The internal note') },
    required: ['requestId', 'text'],
    describe: async (i) => ({ title: 'Added an internal note to the request', summary: clip(String(i.text), 200), link: `/team/requests/${i.requestId}`, target: { type: 'Request', id: String(i.requestId) } }),
    check: async (i, ctx) => {
      await requestFor(ctx, String(i.requestId));
    },
    apply: async (i, ctx) => {
      const r = await requestFor(ctx, String(i.requestId));
      const c = await get(ctx.ref, PrismaService).comment.create({ data: { orgId: ctx.me.orgId, targetType: 'request', targetId: r.id, body: `${ctx.agentLabel}: ${String(i.text)}`, isInternal: true, authorId: ctx.me.id } });
      return { message: 'Internal note added', link: `/team/requests/${r.id}`, undo: [{ model: 'comment', id: c.id, delete: true }] };
    },
  },

  add_version_note: {
    name: 'add_version_note',
    description: 'Add an internal note on a draft version in the Review Studio (brand check, things for QC to look at). The client never sees it.',
    schema: z.object({ versionId: z.string().min(1), text: z.string().trim().min(2).max(4000) }),
    properties: { versionId: str('Version id'), text: str('The internal note') },
    required: ['versionId', 'text'],
    describe: async (i, ctx) => {
      const v = await versionFor(ctx, String(i.versionId)).catch(() => null);
      return { title: v ? `Added a brand check note on ${clip(v.title, 60)} v${v.number}` : 'Added a note on a draft', summary: clip(String(i.text), 200), link: v ? `/team/deliverables/${v.deliverableId}` : null, target: { type: 'Version', id: String(i.versionId) } };
    },
    check: async (i, ctx) => {
      await versionFor(ctx, String(i.versionId));
    },
    apply: async (i, ctx) => {
      const v = await versionFor(ctx, String(i.versionId));
      const c = await get(ctx.ref, PrismaService).comment.create({ data: { orgId: ctx.me.orgId, targetType: 'version', targetId: v.id, body: `${ctx.agentLabel}: ${String(i.text)}`, isInternal: true, authorId: ctx.me.id } });
      return { message: 'Internal note added', link: `/team/deliverables/${v.deliverableId}`, undo: [{ model: 'comment', id: c.id, delete: true }] };
    },
  },

  notify_person: {
    name: 'notify_person',
    description: 'Send an in-app notification to a team member (reminders, heads-ups). Internal only; never to clients.',
    schema: z.object({ userId: z.string().min(1), title: z.string().trim().min(2).max(160), body: z.string().trim().max(600).optional(), link: z.string().regex(/^\/[\w\-/?=&.]*$/).max(200).optional() }),
    properties: { userId: str('Team member id'), title: str('Short title'), body: str('One or two lines'), link: str('App link starting with /, from a tool result') },
    required: ['userId', 'title'],
    describe: async (i, ctx) => ({ title: `Notified ${await staffName(ctx, String(i.userId))}: ${clip(String(i.title), 80)}`, summary: String(i.body ?? ''), link: (i.link as string | undefined) ?? null, target: { type: 'User', id: String(i.userId) } }),
    check: async (i, ctx) => {
      if (ctx.me.type !== 'staff') throw new ForbiddenException('Team accounts only');
      const u = await get(ctx.ref, PrismaService).user.findFirst({ where: { id: String(i.userId), orgId: ctx.me.orgId, type: 'staff', deletedAt: null, status: 'active' } });
      if (!u) throw new BadRequestException('Notifications only go to active team members');
    },
    apply: async (i, ctx) => {
      const n = await get(ctx.ref, PrismaService).notification.create({
        data: { orgId: ctx.me.orgId, userId: String(i.userId), kind: 'agent', title: `${ctx.agentLabel}: ${String(i.title)}`, body: (i.body as string | undefined) ?? null, link: (i.link as string | undefined) ?? null },
      });
      return { message: 'Notification sent', link: (i.link as string | undefined) ?? null, undo: [{ model: 'notification', id: n.id, delete: true }] };
    },
  },

  send_lead_reply: {
    name: 'send_lead_reply',
    description: 'Draft a reply to a lead (email or WhatsApp). It waits in the Agent Inbox; a person approves or edits it before it goes.',
    schema: z.object({ leadId: z.string().min(1), channel: z.enum(['email', 'whatsapp']), subject: z.string().trim().max(160).optional(), text: z.string().trim().min(10).max(4000) }),
    properties: { leadId: str('Lead id'), channel: { type: 'string', enum: ['email', 'whatsapp'] }, subject: str('Email subject (email only)'), text: str('The message, signed "Team BMU Marketing"') },
    required: ['leadId', 'channel', 'text'],
    fields: async (i) => [
      { key: 'channel', label: 'Send by', kind: 'select', options: [{ value: 'email', label: 'Email' }, { value: 'whatsapp', label: 'WhatsApp (logged, you send it)' }] },
      ...(i.channel === 'email' ? [{ key: 'subject', label: 'Subject', kind: 'text' as const }] : []),
      { key: 'text', label: 'Message', kind: 'longtext' },
    ],
    deciders: async (i, ctx) => {
      const l = await get(ctx.ref, PrismaService).lead.findFirst({ where: { id: String(i.leadId), orgId: ctx.me.orgId }, select: { ownerId: true } });
      return [l?.ownerId];
    },
    describe: async (i, ctx) => {
      const l = await get(ctx.ref, PrismaService).lead.findFirst({ where: { id: String(i.leadId), orgId: ctx.me.orgId } });
      return { title: `Reply to ${l ? leadName(l) : 'the lead'} by ${i.channel === 'email' ? 'email' : 'WhatsApp'}`, summary: clip(String(i.text), 400), link: `/team/leads/${i.leadId}`, target: { type: 'Lead', id: String(i.leadId) } };
    },
    check: async (i, ctx) => {
      assertLeads(ctx.me);
      const l = await leadFor(ctx, String(i.leadId));
      if (l.stage === 'won' || l.stage === 'lost') throw new BadRequestException('This lead is closed');
    },
    apply: async (i, ctx) => {
      const lead = await leadFor(ctx, String(i.leadId));
      const channel = i.channel as 'email' | 'whatsapp';
      const text = String(i.text);
      const contact = lead.contact as { name?: string; email?: string };
      let queued = false;
      if (channel === 'email' && contact.email) {
        await get(ctx.ref, EmailService).send({ orgId: ctx.me.orgId, to: contact.email, toName: contact.name ?? null, subject: String(i.subject || 'Thanks for contacting BMU Marketing'), paragraphs: text.split(/\n{2,}/), kind: 'lead_reply', entity: 'Lead', entityId: lead.id });
        queued = true;
      }
      await get(ctx.ref, SellService).logActivity(ctx.me, lead.id, { kind: channel, body: text, nextFollowUpAt: new Date(Date.now() + 2 * DAY).toISOString() });
      // A message to a prospect can't be taken back, so there is nothing to undo.
      return { message: queued ? 'Email queued in the Outbox and logged on the lead' : channel === 'email' ? 'Logged on the lead (no email address on file, so nothing was sent)' : 'Logged on the lead. Send it on WhatsApp from the lead page.', link: `/team/leads/${lead.id}`, undo: null };
    },
  },

  reply_to_request: {
    name: 'reply_to_request',
    description: 'Draft a reply to the client on their request. It waits in the Agent Inbox; a person approves or edits it before the client sees it.',
    schema: z.object({ requestId: z.string().min(1), text: z.string().trim().min(10).max(4000) }),
    properties: { requestId: str('Request id'), text: str('The reply to the client') },
    required: ['requestId', 'text'],
    fields: async () => [{ key: 'text', label: 'Reply to the client', kind: 'longtext' }],
    deciders: async (i, ctx) => {
      const r = await get(ctx.ref, PrismaService).request.findFirst({ where: { id: String(i.requestId), orgId: ctx.me.orgId }, select: { assigneeId: true, engagement: { select: { amId: true } } } });
      return [r?.assigneeId, r?.engagement.amId];
    },
    describe: async (i, ctx) => {
      const r = await get(ctx.ref, PrismaService).request.findFirst({ where: { id: String(i.requestId), orgId: ctx.me.orgId }, select: { engagement: { select: { clientOrg: { select: { name: true } } } } } });
      return { title: `Reply to ${r?.engagement.clientOrg.name ?? 'the client'} on their request`, summary: clip(String(i.text), 400), link: `/team/requests/${i.requestId}`, target: { type: 'Request', id: String(i.requestId) } };
    },
    check: async (i, ctx) => {
      const r = await requestFor(ctx, String(i.requestId));
      if (!r.can.decide) throw new ForbiddenException("Only the client's Account Manager or leadership can reply to this request");
    },
    apply: async (i, ctx) => {
      await get(ctx.ref, RequestsService).decide(ctx.me, String(i.requestId), { action: 'reply', internal: false, message: String(i.text) });
      return { message: 'Reply sent to the client', link: `/team/requests/${i.requestId}`, undo: null };
    },
  },

  assign_lead: {
    name: 'assign_lead',
    description: 'Suggest giving a lead to a salesperson. It waits in the Agent Inbox.',
    schema: z.object({ leadId: z.string().min(1), ownerId: z.string().min(1), reason: z.string().trim().max(300).optional() }),
    properties: { leadId: str('Lead id'), ownerId: str('Team member id of the new owner'), reason: str('Why this person') },
    required: ['leadId', 'ownerId'],
    fields: (i, ctx) => candidateFields(ctx, 'lead_owner', String(i.leadId), 'ownerId', 'Give to'),
    describe: async (i, ctx) => {
      const l = await get(ctx.ref, PrismaService).lead.findFirst({ where: { id: String(i.leadId), orgId: ctx.me.orgId } });
      return { title: `Give ${l ? leadName(l) : 'the lead'} to ${await staffName(ctx, String(i.ownerId))}`, summary: String(i.reason ?? ''), link: `/team/leads/${i.leadId}`, target: { type: 'Lead', id: String(i.leadId) } };
    },
    check: async (i, ctx) => {
      await get(ctx.ref, ReassignService).preview(ctx.me, 'lead_owner', { ids: [String(i.leadId)], toUserId: String(i.ownerId) });
    },
    apply: (i, ctx) => reassign(ctx, 'lead_owner', String(i.leadId), String(i.ownerId), 'other', `Suggested by the ${ctx.agentLabel}${i.reason ? `: ${String(i.reason)}` : ''}`),
  },

  assign_request: {
    name: 'assign_request',
    description: 'Suggest who should handle a client request. It waits in the Agent Inbox.',
    schema: z.object({ requestId: z.string().min(1), assigneeId: z.string().min(1), reason: z.string().trim().max(300).optional() }),
    properties: { requestId: str('Request id'), assigneeId: str('Team member id'), reason: str('Why this person') },
    required: ['requestId', 'assigneeId'],
    fields: (i, ctx) => candidateFields(ctx, 'request', String(i.requestId), 'assigneeId', 'Give to'),
    describe: async (i, ctx) => ({ title: `Give the request to ${await staffName(ctx, String(i.assigneeId))}`, summary: String(i.reason ?? ''), link: `/team/requests/${i.requestId}`, target: { type: 'Request', id: String(i.requestId) } }),
    check: async (i, ctx) => {
      await get(ctx.ref, ReassignService).preview(ctx.me, 'request', { ids: [String(i.requestId)], toUserId: String(i.assigneeId) });
    },
    apply: (i, ctx) => reassign(ctx, 'request', String(i.requestId), String(i.assigneeId), 'other', `Suggested by ${ctx.agentLabel}${i.reason ? `: ${String(i.reason)}` : ''}`),
  },

  set_request_type: {
    name: 'set_request_type',
    description: 'Suggest changing the request type (change, new_scope, urgent, question, billing). The client sees the type, so it waits in the Agent Inbox.',
    schema: z.object({ requestId: z.string().min(1), type: z.enum(REQUEST_TYPES), reason: z.string().trim().max(400).optional() }),
    properties: { requestId: str('Request id'), type: { type: 'string', enum: [...REQUEST_TYPES] }, reason: str('Why') },
    required: ['requestId', 'type'],
    fields: async () => [{ key: 'type', label: 'Type', kind: 'select', options: REQUEST_TYPES.map((t) => ({ value: t, label: requestTypeLabels[t] })) }],
    deciders: async (i, ctx) => {
      const r = await get(ctx.ref, PrismaService).request.findFirst({ where: { id: String(i.requestId), orgId: ctx.me.orgId }, select: { assigneeId: true, engagement: { select: { amId: true } } } });
      return [r?.assigneeId, r?.engagement.amId];
    },
    describe: async (i) => ({ title: `Mark the request as "${requestTypeLabels[i.type as RequestType]}"`, summary: String(i.reason ?? ''), link: `/team/requests/${i.requestId}`, target: { type: 'Request', id: String(i.requestId) } }),
    check: async (i, ctx) => {
      const r = await requestFor(ctx, String(i.requestId));
      if (!r.can.decide) throw new ForbiddenException("Only the client's Account Manager or leadership can change this request");
      if (['done', 'declined', 'paid', 'approved', 'quoted'].includes(r.status)) throw new BadRequestException('This request has moved on; its type can no longer change');
    },
    apply: async (i, ctx) => {
      const r = await requestFor(ctx, String(i.requestId));
      await get(ctx.ref, PrismaService).request.update({ where: { id: r.id }, data: { type: i.type as RequestType } });
      await audit(ctx, 'set_request_type', 'Request', r.id, { type: r.type }, { type: i.type });
      return { message: `Type ${r.type} → ${String(i.type)}`, link: `/team/requests/${r.id}`, undo: [{ model: 'request', id: r.id, data: { type: r.type } }] };
    },
  },

  reassign_task: {
    name: 'reassign_task',
    description: 'Suggest moving a task to someone else (leave or overload). It waits in the Agent Inbox.',
    schema: z.object({ taskId: z.string().min(1), toUserId: z.string().min(1), reason: z.enum(['leave', 'overload']), note: z.string().trim().min(3).max(500) }),
    properties: { taskId: str('Task id'), toUserId: str('Team member id'), reason: { type: 'string', enum: ['leave', 'overload'] }, note: str('Why, one line (shown as the handover note)') },
    required: ['taskId', 'toUserId', 'reason', 'note'],
    fields: (i, ctx) => candidateFields(ctx, 'task', String(i.taskId), 'toUserId', 'Move to'),
    deciders: async (i, ctx) => {
      const t = await get(ctx.ref, PrismaService).task.findFirst({ where: { id: String(i.taskId), orgId: ctx.me.orgId }, select: { departmentId: true } });
      if (!t?.departmentId) return [];
      const d = await get(ctx.ref, PrismaService).department.findFirst({ where: { id: t.departmentId }, select: { headUserId: true } });
      return [d?.headUserId];
    },
    describe: async (i, ctx) => {
      const t = await get(ctx.ref, PrismaService).task.findFirst({ where: { id: String(i.taskId), orgId: ctx.me.orgId }, select: { title: true } });
      return { title: `Move "${clip(t?.title ?? 'task', 60)}" to ${await staffName(ctx, String(i.toUserId))}`, summary: String(i.note), link: `/team/tasks?task=${i.taskId}`, target: { type: 'Task', id: String(i.taskId) } };
    },
    check: async (i, ctx) => {
      await get(ctx.ref, ReassignService).preview(ctx.me, 'task', { ids: [String(i.taskId)], toUserId: String(i.toUserId) });
    },
    apply: (i, ctx) => reassign(ctx, 'task', String(i.taskId), String(i.toUserId), i.reason as 'leave' | 'overload', String(i.note)),
  },

  book_person: {
    name: 'book_person',
    description: 'Suggest booking a team member for some hours in one week on a project (or filling a skill request on the workload board). It waits in the Agent Inbox. People on approved leave or with no free hours are refused.',
    schema: z.object({ engagementId: z.string().min(1), userId: z.string().min(1), weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), hours: z.number().int().min(1).max(80), note: z.string().trim().min(3).max(300), requestId: z.string().min(1).optional() }),
    properties: { engagementId: str('Project (engagement) id'), userId: str('Team member id'), weekStart: str('Monday of the week, YYYY-MM-DD'), hours: { type: 'integer', description: 'Hours that week' }, note: str('Why this person, one line'), requestId: str('The skill request (booking) id when filling one') },
    required: ['engagementId', 'userId', 'weekStart', 'hours', 'note'],
    fields: async (i, ctx) => {
      const s = await get(ctx.ref, CapacityService).suggestCore(ctx.me.orgId, String(i.weekStart), null, Number(i.hours));
      return [{ key: 'userId', label: 'Book', kind: 'person', options: s.candidates.map((c) => ({ value: c.userId, label: `${c.name} · ${c.reason}` })) }, { key: 'note', label: 'Why', kind: 'text' }];
    },
    describe: async (i, ctx) => {
      const e = await get(ctx.ref, PrismaService).engagement.findFirst({ where: { id: String(i.engagementId), orgId: ctx.me.orgId }, select: { clientOrg: { select: { name: true } }, service: { select: { name: true } } } });
      const target = i.requestId ? { type: 'ResourceBooking', id: String(i.requestId) } : { type: 'Booking', id: `${String(i.engagementId)}:${String(i.userId)}:${String(i.weekStart)}` };
      return { title: `Book ${await staffName(ctx, String(i.userId))} for ${String(i.hours)}h on ${e ? `${e.clientOrg.name} · ${e.service.name}` : 'a project'} (week of ${String(i.weekStart)})`, summary: String(i.note), link: '/team/workload', target };
    },
    check: async (i, ctx) => {
      const cap = get(ctx.ref, CapacityService);
      if (!cap.canBook(ctx.me)) throw new ForbiddenException('Only producers, Account Managers and leadership book people');
      const e = await get(ctx.ref, PrismaService).engagement.findFirst({ where: { id: String(i.engagementId), orgId: ctx.me.orgId, deletedAt: null }, select: { id: true } });
      if (!e) throw new NotFoundException('Project not found');
      const week = String(i.weekStart);
      if (!isMonday(week)) throw new BadRequestException('Bookings start on a Monday');
      if (week < mondayOf(todayIst())) throw new BadRequestException('That week is already over');
      if (i.requestId) {
        const r = await get(ctx.ref, PrismaService).resourceBooking.findFirst({ where: { id: String(i.requestId), orgId: ctx.me.orgId } });
        if (!r || r.status !== 'requested') throw new BadRequestException('That skill request is already filled');
      }
      // Same rule as the booking form: never someone on approved leave, never more than their free hours.
      const why = await cap.refusal(ctx.me.orgId, String(i.userId), week, Number(i.hours));
      if (why) throw new BadRequestException(why);
    },
    apply: async (i, ctx) => {
      const cap = get(ctx.ref, CapacityService);
      if (i.requestId) {
        const before = await get(ctx.ref, PrismaService).resourceBooking.findUniqueOrThrow({ where: { id: String(i.requestId) } });
        const row = await cap.update(ctx.me, String(i.requestId), { userId: String(i.userId), hours: Number(i.hours) });
        return { message: `Booked ${row.person} for ${row.hours}h`, link: '/team/workload', undo: [{ model: 'resourceBooking', id: row.id, data: { userId: null, status: 'requested', specialty: before.specialty, hours: before.hours } }] };
      }
      const r = await cap.book(ctx.me, { engagementId: String(i.engagementId), userId: String(i.userId), weekStart: String(i.weekStart), hours: Number(i.hours), weeks: 1, note: String(i.note) }, undefined, { via: ctx.agentLabel });
      const row = r.created[0];
      if (!row) throw new BadRequestException(r.skipped[0]?.reason ?? 'Could not book');
      return { message: `Booked ${row.person} for ${row.hours}h`, link: '/team/workload', undo: [{ model: 'resourceBooking', id: row.id, delete: true }] };
    },
  },

  send_payment_reminder: {
    name: 'send_payment_reminder',
    description: "Suggest sending the client a payment reminder for an overdue invoice (in-app, email and the client's message thread, using the reminder wording in Settings). It waits in the Agent Inbox.",
    schema: z.object({ invoiceId: z.string().min(1), note: z.string().trim().min(3).max(300) }),
    properties: { invoiceId: str('Invoice id'), note: str('Why now, one line (for the person approving)') },
    required: ['invoiceId', 'note'],
    describe: async (i, ctx) => {
      const [inv] = await loadLedger(get(ctx.ref, PrismaService), ctx.me.orgId, { id: String(i.invoiceId) });
      return { title: `Remind ${inv?.clientOrg?.name ?? 'the client'} about ${inv?.number ?? 'an invoice'} (${formatINR(inv?.balancePaise ?? 0)} due${inv?.daysOverdue ? `, ${inv.daysOverdue} days late` : ''})`, summary: String(i.note), link: `/admin/finance/invoices/${String(i.invoiceId)}`, target: { type: 'Invoice', id: String(i.invoiceId) } };
    },
    check: async (i, ctx) => {
      if (!canWriteFinance(ctx.me)) throw new ForbiddenException('Only Founder, Admin and Finance send payment reminders');
      const [inv] = await loadLedger(get(ctx.ref, PrismaService), ctx.me.orgId, { id: String(i.invoiceId) });
      if (!inv) throw new NotFoundException('Invoice not found');
      if (inv.balancePaise <= 0) throw new BadRequestException('Nothing is due on this invoice');
      if (!inv.clientOrgId) throw new BadRequestException('This invoice has no client account yet');
    },
    apply: async (i, ctx) => {
      const r = await get(ctx.ref, DunningService).remindNow(ctx.me, String(i.invoiceId));
      return { message: `Reminder sent to ${r.notified} ${r.notified === 1 ? 'person' : 'people'}`, link: `/admin/finance/invoices/${String(i.invoiceId)}`, undo: null };
    },
  },

  match_payment: {
    name: 'match_payment',
    description: 'Suggest which open invoice a payment that came in without one belongs to. Approving records the payment on that invoice. It waits in the Agent Inbox.',
    schema: z.object({ unmatchedId: z.string().min(1), invoiceId: z.string().min(1), reason: z.string().trim().min(3).max(300) }),
    properties: { unmatchedId: str('Unmatched payment id'), invoiceId: str('Invoice id'), reason: str('Why this invoice, one line') },
    required: ['unmatchedId', 'invoiceId', 'reason'],
    describe: async (i, ctx) => {
      const prisma = get(ctx.ref, PrismaService);
      const [u, inv] = await Promise.all([prisma.unmatchedPayment.findFirst({ where: { id: String(i.unmatchedId), orgId: ctx.me.orgId } }), prisma.invoice.findFirst({ where: { id: String(i.invoiceId), orgId: ctx.me.orgId }, select: { number: true, clientOrg: { select: { name: true } } } })]);
      return { title: `Match ${formatINR(u?.amountPaise ?? 0)} (${u?.ref ?? 'payment'}) to ${inv?.number ?? 'an invoice'}${inv?.clientOrg ? ` (${inv.clientOrg.name})` : ''}`, summary: String(i.reason), link: '/admin/finance/reconcile', target: { type: 'UnmatchedPayment', id: String(i.unmatchedId) } };
    },
    check: async (i, ctx) => {
      if (!canWriteFinance(ctx.me)) throw new ForbiddenException('Only Founder, Admin and Finance match payments');
      const prisma = get(ctx.ref, PrismaService);
      const u = await prisma.unmatchedPayment.findFirst({ where: { id: String(i.unmatchedId), orgId: ctx.me.orgId } });
      if (!u) throw new NotFoundException('Payment not found');
      if (u.matchedAt || u.ignoredAt) throw new BadRequestException('This payment is already handled');
      const [inv] = await loadLedger(prisma, ctx.me.orgId, { id: String(i.invoiceId) });
      if (!inv) throw new NotFoundException('Invoice not found');
      if (inv.balancePaise < u.amountPaise) throw new BadRequestException(`That is more than the balance due on ${inv.number}`);
    },
    apply: async (i, ctx) => {
      const r = await get(ctx.ref, PaymentsHubService).matchCore(ctx.me.orgId, String(i.unmatchedId), String(i.invoiceId), ctx.me.id);
      await audit(ctx, 'match_payment', 'UnmatchedPayment', String(i.unmatchedId), null, { invoiceId: i.invoiceId });
      return { message: `Recorded ${formatINR(r.amountPaise)} on ${r.invoiceNumber}`, link: `/admin/finance/invoices/${String(i.invoiceId)}`, undo: null };
    },
  },

  delete_record: never('delete_record'),
  change_price: never('change_price'),
  create_invoice: never('create_invoice'),
  issue_refund: never('issue_refund'),
  change_role: never('change_role'),
};

/** Models agent undo may write to (anything else in a stored undo row is ignored). */
export const AGENT_UNDO_MODELS = new Set(['lead', 'leadActivity', 'comment', 'notification', 'request', 'task', 'deliverable', 'assignment', 'clientOrg', 'engagement', 'resourceBooking']);

export const isNotAllowed = (e: unknown) => e instanceof ForbiddenException || e instanceof NotFoundException;
