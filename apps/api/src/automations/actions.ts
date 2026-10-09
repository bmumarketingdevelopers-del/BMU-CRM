// Conditions and actions. Each action first works out, read-only, what it would do (for dry runs and
// the log), then does it unless this is a dry run. Every step is described in plain words.
import {
  addWorkingDays,
  automationActionInfo,
  automationAiDraftLabels,
  automationFill,
  automationOpLabels,
  automationTrigger,
  endOfWorkingDay,
  leadStageLabels,
  type AutomationAction,
  type AutomationCondition,
  type AutomationStep,
  type WorkCalendar,
} from '@bmu/shared';
import type { AuditService } from '../audit/audit.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import type { EmailService } from '../service/email.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { Subject } from './subjects.js';
import type { AiDigestService } from '../ai/ai-digest.js';
import { AiOffError } from '../ai/ai.service.js';
import { assertPublicUrl } from './url-guard.js';

const OPEN_TASK = ['todo', 'in_progress', 'blocked', 'waiting', 'in_qc'] as const;
const SALES_ROLES = ['sales_executive', 'sales_manager'];

// ---------------------------------------------------------------------------
// Conditions

export function checkConditions(trigger: string, conditions: AutomationCondition[], s: Subject): { passes: boolean; failed?: string } {
  const t = automationTrigger(trigger);
  for (const c of conditions) {
    const spec = t?.fields.find((f) => f.key === c.field);
    const raw = s.fields[c.field];
    const want = c.value ?? '';
    const label = spec?.label.replace(/ \(₹\)$/, '') ?? c.field;
    const isNum = spec?.type === 'number' || spec?.type === 'money';
    const wantNum = spec?.type === 'money' ? Math.round(Number(want) * 100) : Number(want);
    const haveStr = raw === null || raw === undefined ? '' : String(raw).toLowerCase();
    const wantStr = want.trim().toLowerCase();
    let ok: boolean;
    switch (c.op) {
      case 'is_empty':
        ok = raw === null || raw === undefined || raw === '';
        break;
      case 'equals':
        ok = isNum ? raw !== null && Number(raw) === wantNum : haveStr === wantStr;
        break;
      case 'not_equals':
        ok = isNum ? raw === null || Number(raw) !== wantNum : haveStr !== wantStr;
        break;
      case 'contains':
        ok = !!wantStr && haveStr.includes(wantStr);
        break;
      case 'greater_than':
        ok = raw !== null && raw !== undefined && raw !== '' && Number(raw) > wantNum;
        break;
      case 'less_than':
        ok = raw !== null && raw !== undefined && raw !== '' && Number(raw) < wantNum;
        break;
      default:
        ok = false;
    }
    if (!ok) {
      const shown = raw === null || raw === undefined || raw === '' ? 'empty' : spec?.type === 'money' ? `₹${(Number(raw) / 100).toLocaleString('en-IN')}` : String(raw);
      return { passes: false, failed: `${label} ${automationOpLabels[c.op]}${c.op === 'is_empty' ? '' : ` ${spec?.type === 'money' ? `₹${want}` : `"${want}"`}`} (it is ${shown})` };
    }
  }
  return { passes: true };
}

// ---------------------------------------------------------------------------
// Actions

export type ActionCtx = {
  prisma: PrismaService;
  audit: AuditService;
  orgId: string;
  rule: { id: string; name: string; trigger: string; createdById: string | null };
  subject: Subject;
  dryRun: boolean;
  now: Date;
  calendar: WorkCalendar;
  /** Round-robin pointer per rule within one sweep. */
  lastAssigned: Map<string, string>;
  /** Fallback author for messages (the founder). */
  systemAuthorId: string | null;
  meta: Record<string, string>;
  /** v10: delivers alerts through the notification service (templates + personal preferences). */
  notifications?: NotificationsService;
  /** v10: the email outbox / SMTP sender. */
  email?: EmailService;
  /** v10 AI Copilot (drafts for the "AI draft" action). */
  ai?: AiDigestService;
};

type StaffUser = { id: string; name: string; email: string | null };

async function staffByIds(ctx: ActionCtx, ids: (string | null | undefined)[]): Promise<StaffUser[]> {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (!list.length) return [];
  return ctx.prisma.user.findMany({ where: { id: { in: list }, orgId: ctx.orgId, deletedAt: null, type: 'staff', status: { not: 'suspended' } }, select: { id: true, name: true, email: true } });
}

async function staffByRole(ctx: ActionCtx, roles: string[]): Promise<(StaffUser & { departmentId: string | null })[]> {
  return ctx.prisma.user.findMany({
    where: { orgId: ctx.orgId, deletedAt: null, type: 'staff', status: 'active', roles: { some: { role: { baseRole: { in: roles } } } } },
    select: { id: true, name: true, email: true, departmentId: true },
    orderBy: { name: 'asc' },
  });
}

const personWord: Record<string, string> = { am: 'account manager', owner: 'owner', assignee: 'assignee', manager: 'manager', department_head: 'department head' };

async function recipients(ctx: ActionCtx, to: string, role?: string, userIds?: string[]): Promise<{ users: StaffUser[]; missing?: string }> {
  if (to === 'role') {
    const users = await staffByRole(ctx, [role ?? '']);
    return { users, missing: users.length ? undefined : `nobody has the ${role} role` };
  }
  if (to === 'users') {
    const users = await staffByIds(ctx, userIds ?? []);
    return { users, missing: users.length ? undefined : 'none of the chosen people are active' };
  }
  const id = ctx.subject.people[to as keyof Subject['people']];
  const users = await staffByIds(ctx, [id]);
  return { users, missing: users.length ? undefined : `this ${ctx.subject.entity.toLowerCase()} has no ${personWord[to] ?? to}` };
}

const names = (u: { name: string }[]) => (u.length > 3 ? `${u.slice(0, 3).map((x) => x.name).join(', ')} and ${u.length - 3} more` : u.map((x) => x.name).join(', '));

async function clientThread(ctx: ActionCtx) {
  const s = ctx.subject;
  const existing = await ctx.prisma.thread.findFirst({ where: { clientOrgId: s.clientOrgId!, type: 'client_am' }, orderBy: { id: 'asc' } });
  if (existing || ctx.dryRun) return existing;
  return ctx.prisma.thread.create({ data: { orgId: ctx.orgId, clientOrgId: s.clientOrgId!, type: 'client_am' } });
}

async function messageAuthor(ctx: ActionCtx) {
  const am = ctx.subject.people.am ? await staffByIds(ctx, [ctx.subject.people.am]) : [];
  if (am[0]) return am[0];
  const fallback = await staffByIds(ctx, [ctx.rule.createdById, ctx.systemAuthorId]);
  return fallback[0] ?? null;
}

async function clientContacts(ctx: ActionCtx) {
  const s = ctx.subject;
  if (!s.clientOrgId) return [];
  const roles = s.billing ? ['client_owner', 'client_finance'] : ['client_owner', 'client_approver'];
  const rows = await ctx.prisma.clientUser.findMany({ where: { clientOrgId: s.clientOrgId, clientRole: { in: roles }, user: { deletedAt: null, status: { not: 'suspended' } } }, select: { user: { select: { id: true, name: true, email: true } } } });
  return rows.map((r) => r.user);
}

async function notifyUsers(ctx: ActionCtx, ids: string[], title: string, body: string, link: string | null, kind = 'automation') {
  if (!ids.length) return;
  if (ctx.notifications) {
    // Emails for automations are sent by the "email" action only, never as a side effect of an alert.
    await ctx.notifications.notify(ctx.orgId, ids, { kind, title, body, link: link ?? undefined, noEmail: true });
    return;
  }
  await ctx.prisma.notification.createMany({ data: [...new Set(ids)].map((userId) => ({ orgId: ctx.orgId, userId, kind, title, body, link })) });
}

const step = (action: AutomationAction['type'], ok: boolean, text: string, skipped = false): AutomationStep => ({ action, ok, text, ...(skipped ? { skipped: true } : {}) });
const would = (ctx: ActionCtx, done: string, plan: string) => (ctx.dryRun ? `Would ${plan}` : done);

export async function runAction(ctx: ActionCtx, a: AutomationAction): Promise<AutomationStep> {
  const s = ctx.subject;
  const fill = (tpl: string, overrides: Record<string, string | number | null> = {}) => automationFill(tpl, { record: s.record, ...s.vars, ...overrides });
  const info = automationActionInfo[a.type];
  if (info.needsClient && !s.clientOrgId) return step(a.type, true, `Skipped ${info.label.toLowerCase()}: this record has no client account yet`, true);

  switch (a.type) {
    case 'notify': {
      const { users, missing } = await recipients(ctx, a.to, a.role, a.userIds);
      if (!users.length) return step(a.type, true, `Skipped alert: ${missing}`, true);
      const body = fill(a.message);
      if (!ctx.dryRun) await notifyUsers(ctx, users.map((u) => u.id), ctx.rule.name, body, s.link);
      return step(a.type, true, would(ctx, `Alerted ${names(users)}: "${body}"`, `alert ${names(users)}: "${body}"`));
    }

    case 'create_task': {
      let owner: (StaffUser & { departmentId?: string | null }) | null = null;
      if (a.assignTo === 'user') owner = (await staffByIds(ctx, [a.userId]))[0] ?? null;
      else if (a.assignTo === 'role') {
        const pool = await staffByRole(ctx, [a.role ?? '']);
        let best: { u: (typeof pool)[number]; load: number } | null = null;
        for (const u of pool) {
          const load = await ctx.prisma.task.count({ where: { ownerId: u.id, status: { in: [...OPEN_TASK] } } });
          if (!best || load < best.load) best = { u, load };
        }
        owner = best?.u ?? null;
      } else owner = (await staffByIds(ctx, [s.people[a.assignTo]]))[0] ?? null;
      if (!owner) return step(a.type, true, `Skipped task: nobody to give it to (${a.assignTo === 'role' ? `no active ${a.role}` : `no ${personWord[a.assignTo] ?? a.assignTo}`})`, true);
      const title = fill(a.title).slice(0, 200);
      const deadline = a.dueInDays <= 0 ? endOfWorkingDay(ctx.now, ctx.calendar) : addWorkingDays(ctx.now, a.dueInDays, ctx.calendar);
      const due = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }).format(deadline);
      if (!ctx.dryRun) {
        const dept = owner.departmentId === undefined ? (await ctx.prisma.user.findUnique({ where: { id: owner.id }, select: { departmentId: true } }))?.departmentId : owner.departmentId;
        const task = await ctx.prisma.task.create({ data: { orgId: ctx.orgId, title, ownerId: owner.id, deadline, engagementId: s.engagementId ?? null, departmentId: dept ?? null, kind: 'work' } });
        await ctx.audit.logSystem(ctx.orgId, 'automation.task_created', 'Task', task.id, { ruleId: ctx.rule.id, title, ownerId: owner.id });
        await notifyUsers(ctx, [owner.id], `New task: ${title}`, `Created automatically by "${ctx.rule.name}". Due ${due}.`, '/team/tasks', 'task_assigned');
      }
      return step(a.type, true, would(ctx, `Created task "${title}" for ${owner.name}, due ${due}`, `create task "${title}" for ${owner.name}, due ${due}`));
    }

    case 'assign_lead_owner': {
      if (!s.leadId) return step(a.type, true, 'Skipped: no lead on this record', true);
      const lead = await ctx.prisma.lead.findUnique({ where: { id: s.leadId }, select: { ownerId: true, owner: { select: { name: true } } } });
      if (!lead) return step(a.type, false, 'The lead no longer exists');
      if (lead.ownerId) return step(a.type, true, `Skipped: the lead already belongs to ${lead.owner?.name ?? 'someone'}`, true);
      const pool = await staffByRole(ctx, a.roles?.length ? a.roles : SALES_ROLES);
      if (!pool.length) return step(a.type, true, 'Skipped: no active sales people to assign', true);
      const sorted = [...pool].sort((x, y) => x.id.localeCompare(y.id));
      let last = ctx.lastAssigned.get(ctx.rule.id);
      if (!last) {
        const prev = await ctx.prisma.automationRun.findMany({ where: { ruleId: ctx.rule.id, status: 'success' }, orderBy: { at: 'desc' }, take: 50, select: { detail: true } });
        last = prev.map((p) => (p.detail as { meta?: { assignedUserId?: string } }).meta?.assignedUserId).find(Boolean);
      }
      const idx = last ? sorted.findIndex((u) => u.id === last) : -1;
      const next = sorted[(idx + 1) % sorted.length];
      if (!ctx.dryRun) {
        ctx.lastAssigned.set(ctx.rule.id, next.id);
        await ctx.prisma.lead.update({ where: { id: s.leadId }, data: { ownerId: next.id } });
        await ctx.audit.logSystem(ctx.orgId, 'automation.lead_assigned', 'Lead', s.leadId, { ruleId: ctx.rule.id, ownerId: next.id });
        await notifyUsers(ctx, [next.id], `New lead for you: ${s.vars.lead}`, `${s.vars.company} asked about ${s.vars.service}. Assigned by "${ctx.rule.name}".`, s.link, 'lead_assigned');
      }
      ctx.meta.assignedUserId = next.id;
      s.people.owner = next.id;
      s.vars.owner = next.name;
      return step(a.type, true, would(ctx, `Assigned the lead to ${next.name} (next in turn)`, `assign the lead to ${next.name} (next in turn)`));
    }

    case 'change_lead_stage': {
      if (!s.leadId) return step(a.type, true, 'Skipped: no lead on this record', true);
      const lead = await ctx.prisma.lead.findUnique({ where: { id: s.leadId }, select: { stage: true } });
      if (!lead) return step(a.type, false, 'The lead no longer exists');
      const label = leadStageLabels[a.stage];
      if (lead.stage === a.stage) return step(a.type, true, `Skipped: the lead is already in ${label}`, true);
      if (!ctx.dryRun) {
        await ctx.prisma.lead.update({ where: { id: s.leadId }, data: { stage: a.stage } });
        await ctx.audit.logSystem(ctx.orgId, `lead.${a.stage}`, 'Lead', s.leadId, { stage: a.stage, from: lead.stage, byAutomation: ctx.rule.id });
      }
      return step(a.type, true, would(ctx, `Moved the lead from ${leadStageLabels[lead.stage]} to ${label}`, `move the lead from ${leadStageLabels[lead.stage]} to ${label}`));
    }

    case 'post_internal_note': {
      const author = await messageAuthor(ctx);
      if (!author) return step(a.type, true, 'Skipped: no team member to post as', true);
      const body = `${fill(a.message)}\n\n(Automation: ${ctx.rule.name})`;
      if (!ctx.dryRun) {
        const t = await clientThread(ctx);
        await ctx.prisma.message.create({ data: { orgId: ctx.orgId, threadId: t!.id, authorId: author.id, body, isInternal: true } });
      }
      return step(a.type, true, would(ctx, `Posted an internal note on ${s.vars.client ?? 'the client'}'s thread (team only)`, `post a team-only note on ${s.vars.client ?? 'the client'}'s thread`));
    }

    case 'send_client_reminder': {
      const author = await messageAuthor(ctx);
      if (!author) return step(a.type, true, 'Skipped: no team member to send as', true);
      const body = fill(a.message, { link: s.clientLink ?? '/client' });
      const contacts = await clientContacts(ctx);
      if (!ctx.dryRun) {
        const t = await clientThread(ctx);
        await ctx.prisma.message.create({ data: { orgId: ctx.orgId, threadId: t!.id, authorId: author.id, body, isInternal: false } });
        const clientUsers = await ctx.prisma.clientUser.findMany({ where: { clientOrgId: s.clientOrgId! }, select: { userId: true } });
        await notifyUsers(ctx, clientUsers.map((c) => c.userId), `New message from ${author.name}`, body.slice(0, 140), '/client/messages', 'message');
        await ctx.audit.logSystem(ctx.orgId, 'automation.client_message', 'Thread', t!.id, { ruleId: ctx.rule.id });
      }
      const who = contacts.length ? names(contacts) : 'the client';
      return step(a.type, true, would(ctx, `Sent ${who} a message from ${author.name}: "${body.slice(0, 120)}${body.length > 120 ? '…' : ''}"`, `send ${who} a message from ${author.name}: "${body.slice(0, 120)}${body.length > 120 ? '…' : ''}"`));
    }

    case 'email': {
      let people: StaffUser[];
      let missing: string | undefined;
      if (a.to === 'client') {
        people = await clientContacts(ctx);
        missing = people.length ? undefined : 'the client has no contact to email';
      } else ({ users: people, missing } = await recipients(ctx, a.to, a.role, a.userIds));
      if (!people.length) return step(a.type, true, `Skipped email: ${missing}`, true);
      const subject = fill(a.subject);
      const withEmail = people.filter((p) => p.email);
      const to = withEmail.length ? withEmail.map((p) => p.email).join(', ') : names(people);
      const link = a.to === 'client' ? (s.clientLink ?? '/client') : s.link;
      const text = fill(a.message, a.to === 'client' ? { link: s.clientLink ?? '/client' } : {});
      if (!withEmail.length) return step(a.type, true, `Skipped email: ${names(people)} ${people.length === 1 ? 'has' : 'have'} no email address`, true);
      if (!ctx.dryRun) {
        // People who switched this kind of email off in their profile are respected.
        const off = await ctx.prisma.notificationPreference.findMany({ where: { userId: { in: withEmail.map((p) => p.id) }, kind: 'automation', email: false }, select: { userId: true } });
        for (const p of withEmail) {
          if (off.some((o) => o.userId === p.id)) continue;
          if (ctx.email) {
            await ctx.email.send({ orgId: ctx.orgId, to: p.email!, toName: p.name, toUserId: p.id, subject, paragraphs: [`Hi ${p.name.split(' ')[0]},`, text], button: link ? { label: 'Open in BMU Hub', url: link } : undefined, kind: 'automation', entity: s.entity, entityId: s.entityId });
          }
        }
        await notifyUsers(ctx, people.map((p) => p.id), subject, text.slice(0, 500), link);
      }
      const mode = ctx.email?.configured ? 'sent' : 'saved to the Outbox (no email server set up yet)';
      return step(a.type, true, would(ctx, `Emailed ${to}: "${subject}" (${mode}; in-app alert too)`, `email ${to}: "${subject}" and send an in-app alert`));
    }

    case 'ai_draft': {
      const { users, missing } = await recipients(ctx, a.to, a.role, a.userIds);
      if (!users.length) return step(a.type, true, `Skipped AI draft: ${missing}`, true);
      const what = automationAiDraftLabels[a.draft].toLowerCase();
      if (ctx.dryRun) return step(a.type, true, `Would ask AI Copilot to draft ${what} and send it to ${names(users)} to review (nothing goes to the client automatically)`);
      if (!ctx.ai) return step(a.type, true, 'Skipped AI draft: AI Copilot is not available', true);
      try {
        const r = await ctx.ai.automationDraft(ctx.orgId, ctx.rule, a.draft, a.instruction ?? '', s);
        const header = a.draft === 'client_message' ? 'Review, edit and send this from the client thread if it looks right:' : 'Review and use this draft if it looks right:';
        await notifyUsers(ctx, users.map((u) => u.id), `AI draft: ${ctx.rule.name}`, `${header}\n\n${r.text}`.slice(0, 2000), s.link, 'ai_draft');
        await ctx.audit.logSystem(ctx.orgId, 'automation.ai_draft', s.entity, s.entityId, { ruleId: ctx.rule.id, draft: a.draft, mode: r.mode, logId: r.logId });
        return step(a.type, true, `Drafted ${what} with AI Copilot (${r.mode === 'ai' ? 'AI' : 'basic mode'}) and sent it to ${names(users)} to review`);
      } catch (e) {
        if (e instanceof AiOffError) return step(a.type, true, `Skipped AI draft: ${e.message}`, true);
        return step(a.type, false, `AI draft failed: ${(e as Error).message}`);
      }
    }

    case 'webhook': {
      let host = a.url;
      try {
        host = new URL(a.url).host;
      } catch {
        /* reported below */
      }
      try {
        await assertPublicUrl(a.url);
      } catch (e) {
        return step(a.type, false, `Webhook to ${host} blocked: ${(e as Error).message}`);
      }
      if (ctx.dryRun) return step(a.type, true, `Would POST the record as JSON to ${host}`);
      try {
        const res = await fetch(a.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': 'BMU-Hub-Automations/1' },
          body: JSON.stringify({ rule: { id: ctx.rule.id, name: ctx.rule.name, trigger: ctx.rule.trigger }, record: { entity: s.entity, id: s.entityId, label: s.record, link: s.link }, fields: s.fields, at: ctx.now.toISOString() }),
          signal: AbortSignal.timeout(5000),
          redirect: 'manual',
        });
        return step(a.type, res.ok, res.ok ? `Webhook to ${host} answered ${res.status}` : `Webhook to ${host} failed with status ${res.status}`);
      } catch (e) {
        const err = e as Error;
        return step(a.type, false, `Webhook to ${host} failed: ${err.name === 'TimeoutError' ? 'no answer within 5 seconds' : err.message}`);
      }
    }
  }
}
