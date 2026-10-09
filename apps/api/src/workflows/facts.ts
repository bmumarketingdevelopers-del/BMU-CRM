// Live facts about a workflow's record, re-read whenever a check or a "wait until" step needs them.
// The trigger's own fields are a snapshot taken when the run started; record.* and custom.* are read fresh.
import { automationOpLabels, LEAD_STAGES, type AutomationFieldSpec, type CustomFieldEntity, type WorkflowCondition, type WorkflowMatch } from '@bmu/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { Subject } from '../automations/subjects.js';

const DAY = 86_400_000;
const OPEN_TASK = ['todo', 'in_progress', 'blocked', 'waiting', 'in_qc'] as const;
const OPEN_LEAD = ['new', 'contacted', 'discovery', 'proposal_sent'] as const;

export type Facts = { values: Record<string, string | number | null>; dates: Record<string, Date | null> };

/** The custom-field record (entity + id) a subject reaches for an entity, if any. */
export function customTarget(s: Subject, entity: CustomFieldEntity): string | null {
  switch (entity) {
    case 'lead':
      return s.leadId ?? null;
    case 'client':
      return s.clientOrgId ?? null;
    case 'engagement':
      return s.engagementId ?? null;
    case 'request':
      return s.entity === 'Request' ? s.entityId : null;
    case 'creator':
      return s.entity === 'Creator' ? s.entityId : null;
  }
}

export const CUSTOM_MODEL: Record<CustomFieldEntity, 'lead' | 'clientOrg' | 'engagement' | 'request' | 'creator'> = {
  lead: 'lead',
  client: 'clientOrg',
  engagement: 'engagement',
  request: 'request',
  creator: 'creator',
};

export async function readCustomValues(prisma: PrismaService, entity: CustomFieldEntity, id: string): Promise<Record<string, unknown> | null> {
  const where = { where: { id }, select: { customFields: true } } as const;
  const row =
    entity === 'lead'
      ? await prisma.lead.findUnique(where)
      : entity === 'client'
        ? await prisma.clientOrg.findUnique(where)
        : entity === 'engagement'
          ? await prisma.engagement.findUnique(where)
          : entity === 'request'
            ? await prisma.request.findUnique(where)
            : await prisma.creator.findUnique(where);
  return row ? ((row.customFields ?? {}) as Record<string, unknown>) : null;
}

/** Reads the facts the given field keys need (record.* in one query, custom.* per record type). */
export async function loadFacts(prisma: PrismaService, s: Subject, keys: string[], at: Date = new Date()): Promise<Facts> {
  const facts: Facts = { values: { ...s.fields }, dates: {} };
  if (keys.some((k) => k.startsWith('record.'))) Object.assign(facts, await recordFacts(prisma, s, facts, at.getTime()));
  const custom = [...new Set(keys.filter((k) => k.startsWith('custom.')).map((k) => k.split('.')[1] as CustomFieldEntity))];
  for (const entity of custom) {
    const id = customTarget(s, entity);
    const values = id ? await readCustomValues(prisma, entity, id) : null;
    for (const k of keys.filter((x) => x.startsWith(`custom.${entity}.`))) {
      const v = values?.[k.split('.')[2]];
      facts.values[k] = v === undefined || v === null || v === '' ? null : typeof v === 'boolean' ? (v ? 'yes' : 'no') : (v as string | number);
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) facts.dates[k] = new Date(`${v}T03:30:00Z`); // 9:00 IST
    }
  }
  return facts;
}

async function recordFacts(prisma: PrismaService, s: Subject, base: Facts, now: number): Promise<Facts> {
  const v = base.values;
  const d = base.dates;
  switch (s.entity) {
    case 'Lead': {
      const l = await prisma.lead.findUnique({ where: { id: s.entityId }, select: { stage: true, score: true, ownerId: true, firstReplyAt: true, nextFollowUpAt: true, createdAt: true, lastActivityAt: true } });
      if (!l) break;
      const moved = await prisma.auditEvent.findFirst({ where: { entity: 'Lead', entityId: s.entityId, action: { in: LEAD_STAGES.map((x) => `lead.${x}`) } }, orderBy: { at: 'desc' }, select: { at: true } });
      v['record.stage'] = l.stage;
      v['record.score'] = l.score;
      v['record.has_owner'] = l.ownerId ? 'yes' : 'no';
      // A logged call, message or note counts as a first reply too.
      v['record.replied'] = l.firstReplyAt || (l.lastActivityAt && l.lastActivityAt > l.createdAt && l.stage !== 'new') ? 'yes' : 'no';
      v['record.days_in_stage'] = Math.floor((now - (moved?.at ?? l.createdAt).getTime()) / DAY);
      d['record.next_follow_up'] = l.nextFollowUpAt;
      break;
    }
    case 'Proposal': {
      const p = await prisma.proposal.findUnique({ where: { id: s.entityId }, select: { status: true, sentAt: true, validUntil: true } });
      if (!p) break;
      v['record.status'] = p.status;
      v['record.days_since_sent'] = p.sentAt ? Math.floor((now - p.sentAt.getTime()) / DAY) : null;
      d['record.valid_until'] = p.validUntil;
      break;
    }
    case 'Invoice': {
      const i = await prisma.invoice.findUnique({ where: { id: s.entityId }, select: { status: true, totalPaise: true, dueDate: true, payments: { select: { amountPaise: true } } } });
      if (!i) break;
      const credited = await prisma.creditNote.aggregate({ where: { invoiceId: s.entityId }, _sum: { totalPaise: true } });
      const balance = Math.max(0, i.totalPaise - i.payments.reduce((a, p) => a + p.amountPaise, 0) - (credited._sum.totalPaise ?? 0));
      v['record.status'] = balance <= 0 && i.status !== 'void' ? 'paid' : i.status;
      v['record.balance'] = i.status === 'void' || i.status === 'credit_noted' ? 0 : balance;
      v['record.days_overdue'] = Math.max(0, Math.floor((now - i.dueDate.getTime()) / DAY));
      d['record.due'] = i.dueDate;
      break;
    }
    case 'Task': {
      const t = await prisma.task.findUnique({ where: { id: s.entityId }, select: { status: true, deadline: true } });
      if (!t) break;
      v['record.status'] = t.status;
      d['record.deadline'] = t.deadline;
      break;
    }
    case 'Deliverable': {
      const x = await prisma.deliverable.findUnique({ where: { id: s.entityId }, select: { status: true, dueAt: true, scheduledAt: true } });
      if (!x) break;
      v['record.status'] = x.status;
      d['record.due'] = x.dueAt;
      d['record.scheduled'] = x.scheduledAt;
      break;
    }
    case 'Engagement': {
      const g = await prisma.engagement.findUnique({ where: { id: s.entityId }, select: { status: true, endDate: true, renewalCount: true } });
      if (!g) break;
      const startCount = Number(s.vars.renewal_count ?? g.renewalCount);
      v['record.status'] = g.status;
      v['record.days_to_end'] = g.endDate ? Math.ceil((g.endDate.getTime() - now) / DAY) : null;
      v['record.renewed'] = g.renewalCount > startCount ? 'yes' : 'no';
      d['record.end'] = g.endDate;
      break;
    }
    case 'Request': {
      const r = await prisma.request.findUnique({ where: { id: s.entityId }, select: { status: true, firstReplyAt: true, slaDue: true } });
      if (!r) break;
      v['record.status'] = r.status;
      v['record.replied'] = r.firstReplyAt ? 'yes' : 'no';
      d['record.reply_due'] = r.slaDue;
      break;
    }
    case 'LeaveRequest': {
      const r = await prisma.leaveRequest.findUnique({ where: { id: s.entityId }, select: { status: true } });
      if (r) v['record.status'] = r.status;
      break;
    }
    case 'User': {
      const [tasks, leads, process] = await Promise.all([
        prisma.task.count({ where: { ownerId: s.entityId, status: { in: [...OPEN_TASK] }, archivedAt: null } }),
        prisma.lead.count({ where: { ownerId: s.entityId, stage: { in: [...OPEN_LEAD] }, deletedAt: null, archivedAt: null } }),
        prisma.peopleProcess.findFirst({ where: { userId: s.entityId, kind: 'offboarding' }, orderBy: { createdAt: 'desc' }, select: { lastDay: true } }),
      ]);
      v['record.open_work'] = tasks + leads;
      d['record.last_day'] = process?.lastDay ? new Date(`${process.lastDay.toISOString().slice(0, 10)}T12:30:00Z`) : null; // 18:00 IST
      break;
    }
  }
  return base;
}

/** Field keys a list of conditions needs. */
export const conditionKeys = (conditions: WorkflowCondition[]) => conditions.map((c) => c.field);

/** Same rules as the automation conditions, over any fields, with all/any. Returns the first failure in words. */
export function evaluate(conditions: WorkflowCondition[], match: WorkflowMatch, facts: Facts, specs: AutomationFieldSpec[]): { passes: boolean; text: string } {
  if (!conditions.length) return { passes: true, text: 'no checks' };
  const results = conditions.map((c) => one(c, facts.values[c.field], specs.find((f) => f.key === c.field)));
  const passes = match === 'any' ? results.some((r) => r.ok) : results.every((r) => r.ok);
  const shown = match === 'any' ? (passes ? results.filter((r) => r.ok) : results) : passes ? results : results.filter((r) => !r.ok);
  return { passes, text: shown.map((r) => r.text).join(match === 'any' ? ' or ' : ' and ') };
}

function one(c: WorkflowCondition, raw: string | number | null | undefined, spec?: AutomationFieldSpec): { ok: boolean; text: string } {
  const want = c.value ?? '';
  const label = (spec?.label ?? c.field).replace(/ \(₹\)$/, '');
  const isNum = spec?.type === 'number' || spec?.type === 'money';
  const wantNum = spec?.type === 'money' ? Math.round(Number(want) * 100) : Number(want);
  const empty = raw === null || raw === undefined || raw === '';
  const haveStr = empty ? '' : String(raw).toLowerCase();
  const wantStr = want.trim().toLowerCase();
  let ok: boolean;
  switch (c.op) {
    case 'is_empty':
      ok = empty;
      break;
    case 'equals':
      ok = isNum ? !empty && Number(raw) === wantNum : haveStr === wantStr;
      break;
    case 'not_equals':
      ok = isNum ? empty || Number(raw) !== wantNum : haveStr !== wantStr;
      break;
    case 'contains':
      ok = !!wantStr && haveStr.includes(wantStr);
      break;
    case 'greater_than':
      ok = !empty && Number(raw) > wantNum;
      break;
    case 'less_than':
      ok = !empty && Number(raw) < wantNum;
      break;
    default:
      ok = false;
  }
  const optLabel = (x: string) => spec?.options?.find((o) => o.value === x)?.label ?? x;
  const shown = empty ? 'empty' : spec?.type === 'money' ? `₹${(Number(raw) / 100).toLocaleString('en-IN')}` : optLabel(String(raw));
  const wantShown = spec?.type === 'money' ? `₹${want}` : `"${optLabel(want)}"`;
  return { ok, text: `${label} ${automationOpLabels[c.op]}${c.op === 'is_empty' ? '' : ` ${wantShown}`} (it is ${shown})` };
}
