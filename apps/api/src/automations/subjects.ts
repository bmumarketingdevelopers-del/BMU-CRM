// Trigger finders: for each trigger, the records that match right now, as uniform "subjects" the engine
// can check conditions on and act on. Sweep-based, so no other area's service has to call us.
import { aiToneOf, formatINR, LEAD_STAGES, leadStageLabels, requestTypeLabels, services as catalogue, type AutomationTriggerKey, type RequestType } from '@bmu/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { clientVisibleInvoiceWhere, readInvoiceBranding } from '../service/invoice-branding.service.js';

export type SubjectPeople = { am?: string | null; owner?: string | null; assignee?: string | null; manager?: string | null; department_head?: string | null };

export type Subject = {
  entity: string;
  entityId: string;
  dedupeKey: string;
  /** Short plain description, e.g. "Invoice BMU-0012 · Sunrise Bakery". */
  record: string;
  /** Staff link to the record. */
  link: string | null;
  /** Client-facing link (used in messages to the client). */
  clientLink?: string;
  /** When the event happened, or when the record crossed the line (state triggers). */
  at: Date;
  fields: Record<string, string | number | null>;
  vars: Record<string, string | number | null>;
  people: SubjectPeople;
  clientOrgId?: string | null;
  engagementId?: string | null;
  leadId?: string | null;
  /** Prefer the client's billing contacts for client messages and emails. */
  billing?: boolean;
};

const DAY = 86_400_000;
const HOUR = 3_600_000;
const TAKE = 300;
const dFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
export const fmtDay = (d: Date | null | undefined) => (d ? dFmt.format(d) : '');
const serviceName = (key: string) => catalogue.find((s) => s.id === key)?.name ?? key;
const contactOf = (c: unknown) => (c ?? {}) as { name?: string; email?: string; phone?: string; company?: string };

type Args = Record<string, string | number>;
const num = (args: Args, key: string, def: number) => {
  const n = Number(args[key] ?? def);
  return Number.isFinite(n) ? n : def;
};

/** Department heads by department id (headUserId, else an active department_head in that department). */
async function headsByDepartment(prisma: PrismaService, orgId: string) {
  const [depts, heads] = await Promise.all([
    prisma.department.findMany({ where: { orgId, deletedAt: null }, select: { id: true, name: true, headUserId: true } }),
    prisma.user.findMany({ where: { orgId, deletedAt: null, status: 'active', roles: { some: { role: { baseRole: 'department_head' } } } }, select: { id: true, departmentId: true } }),
  ]);
  const map = new Map<string, { name: string; head: string | null }>();
  for (const d of depts) map.set(d.id, { name: d.name, head: d.headUserId ?? heads.find((h) => h.departmentId === d.id)?.id ?? null });
  return map;
}

type Ctx = { prisma: PrismaService; orgId: string; args: Args; from: Date; now: Date };

/** Records matching a trigger whose event/crossing moment is at or after `from`. */
export async function findSubjects(trigger: AutomationTriggerKey, ctx: Ctx): Promise<Subject[]> {
  const f = finders[trigger];
  return f ? f(ctx) : [];
}

const finders: Record<AutomationTriggerKey, (ctx: Ctx) => Promise<Subject[]>> = {
  // ------------------------------------------------------------------- Sales
  async lead_created({ prisma, orgId, from }) {
    const leads = await prisma.lead.findMany({ where: { orgId, deletedAt: null, createdAt: { gte: from } }, include: { owner: { select: { id: true, name: true, managerId: true } } }, orderBy: { createdAt: 'asc' }, take: TAKE });
    return leads.map((l) => leadSubject(l, l.createdAt, 'created', {}));
  },

  async lead_idle({ prisma, orgId, args, from, now }) {
    const days = num(args, 'days', 5);
    const open = LEAD_STAGES.filter((s) => s !== 'won' && s !== 'lost');
    const leads = await prisma.lead.findMany({ where: { orgId, deletedAt: null, stage: { in: [...open] } }, include: { owner: { select: { id: true, name: true, managerId: true } } }, take: 1000 });
    if (!leads.length) return [];
    const events = await prisma.auditEvent.findMany({
      where: { orgId, entity: 'Lead', entityId: { in: leads.map((l) => l.id) }, action: { in: LEAD_STAGES.map((s) => `lead.${s}`) } },
      select: { entityId: true, at: true },
      orderBy: { at: 'desc' },
    });
    const out: Subject[] = [];
    for (const l of leads) {
      const last = events.find((e) => e.entityId === l.id)?.at ?? l.createdAt;
      const crossing = new Date(last.getTime() + days * DAY);
      if (crossing > now || crossing < from) continue;
      const idleDays = Math.floor((now.getTime() - last.getTime()) / DAY);
      out.push(leadSubject(l, crossing, `idle${days}d:${last.toISOString()}`, { days: idleDays }));
    }
    return out.slice(0, TAKE);
  },

  async proposal_sent_not_accepted({ prisma, orgId, args, from, now }) {
    const days = num(args, 'days', 3);
    const rows = await prisma.proposal.findMany({
      where: { orgId, deletedAt: null, status: 'sent', sentAt: { lte: new Date(now.getTime() - days * DAY), gte: new Date(from.getTime() - days * DAY) } },
      include: { lead: { include: { owner: { select: { id: true, name: true, managerId: true } } } } },
      take: TAKE,
    });
    return rows.map((p) => proposalSubject(p, new Date(p.sentAt!.getTime() + days * DAY), `sent${days}d:v${p.version}:${p.sentAt!.toISOString()}`, { days: Math.floor((now.getTime() - p.sentAt!.getTime()) / DAY) }));
  },

  async proposal_accepted({ prisma, orgId, from }) {
    const rows = await prisma.proposal.findMany({
      where: { orgId, deletedAt: null, status: 'accepted', acceptedAt: { gte: from } },
      include: { lead: { include: { owner: { select: { id: true, name: true, managerId: true } } } } },
      take: TAKE,
    });
    return rows.map((p) => proposalSubject(p, p.acceptedAt!, 'accepted', {}));
  },

  // ------------------------------------------------------------------- Money
  async invoice_issued({ prisma, orgId, from }) {
    // v28: an invoice waiting for the seal and signature has not been issued to the client yet.
    const visible = clientVisibleInvoiceWhere(await readInvoiceBranding(prisma, orgId));
    const rows = await prisma.invoice.findMany({
      where: { orgId, createdAt: { gte: from }, status: { notIn: ['draft', 'void'] }, ...visible },
      include: { clientOrg: { select: { id: true, name: true, amUserId: true } }, proposal: { select: { lead: { select: { contact: true, ownerId: true } } } } },
      take: TAKE,
    });
    return rows.map((i) => invoiceSubject(i, i.createdAt, 'issued', i.totalPaise, {}));
  },

  async invoice_overdue({ prisma, orgId, args, from, now }) {
    const days = num(args, 'days', 3);
    const visible = clientVisibleInvoiceWhere(await readInvoiceBranding(prisma, orgId));
    const rows = await prisma.invoice.findMany({
      where: { orgId, status: { in: ['issued', 'partially_paid', 'overdue'] }, dueDate: { lte: new Date(now.getTime() - days * DAY), gte: new Date(from.getTime() - days * DAY) }, ...visible },
      include: { payments: { select: { amountPaise: true } }, clientOrg: { select: { id: true, name: true, amUserId: true } }, proposal: { select: { lead: { select: { contact: true, ownerId: true } } } } },
      take: TAKE,
    });
    const notes = rows.length ? await prisma.creditNote.findMany({ where: { orgId, invoiceId: { in: rows.map((r) => r.id) } }, select: { invoiceId: true, totalPaise: true } }) : [];
    const out: Subject[] = [];
    for (const i of rows) {
      const paid = i.payments.reduce((s, p) => s + p.amountPaise, 0);
      const credited = notes.filter((n) => n.invoiceId === i.id).reduce((s, n) => s + n.totalPaise, 0);
      const balance = Math.max(0, i.totalPaise - paid - credited);
      if (balance <= 0) continue;
      const late = Math.floor((now.getTime() - i.dueDate.getTime()) / DAY);
      out.push(invoiceSubject(i, new Date(i.dueDate.getTime() + days * DAY), `overdue${days}d`, balance, { days: late }));
    }
    return out;
  },

  async payment_received({ prisma, orgId, from }) {
    const rows = await prisma.payment.findMany({
      where: { orgId, at: { gte: from } },
      include: { invoice: { include: { clientOrg: { select: { id: true, name: true, amUserId: true } }, proposal: { select: { lead: { select: { contact: true, ownerId: true } } } } } } },
      take: TAKE,
    });
    return rows.map((p) => {
      const s = invoiceSubject(p.invoice, p.at, 'paid', p.invoice.totalPaise, {});
      return {
        ...s,
        entity: 'Payment',
        entityId: p.id,
        record: `Payment ${formatINR(p.amountPaise)} · ${s.vars.client}`,
        fields: { ...s.fields, amount: p.amountPaise, method: p.method },
        vars: { ...s.vars, amount: formatINR(p.amountPaise), method: p.method },
      };
    });
  },

  // ---------------------------------------------------------------- Delivery
  async task_overdue({ prisma, orgId, args, from, now }) {
    const hours = num(args, 'hours', 24);
    const rows = await prisma.task.findMany({
      where: { orgId, status: { notIn: ['done', 'cancelled'] }, deadline: { lte: new Date(now.getTime() - hours * HOUR), gte: new Date(from.getTime() - hours * HOUR) } },
      include: taskInclude,
      take: TAKE,
    });
    const heads = await headsByDepartment(prisma, orgId);
    const clients = await engagementClients(prisma, rows);
    return rows.map((t) => taskSubject(t, heads, clients, new Date(t.deadline!.getTime() + hours * HOUR), `late${hours}h:${t.deadline!.toISOString()}`, { hours: Math.floor((now.getTime() - t.deadline!.getTime()) / HOUR) }));
  },

  async task_blocked({ prisma, orgId, from }) {
    const rows = await prisma.task.findMany({ where: { orgId, status: 'blocked', updatedAt: { gte: from } }, include: taskInclude, take: TAKE });
    const heads = await headsByDepartment(prisma, orgId);
    const clients = await engagementClients(prisma, rows);
    return rows.map((t) => taskSubject(t, heads, clients, t.updatedAt, `blocked:${(t.blockedReason ?? '').slice(0, 60)}`, {}));
  },

  async deliverable_changes_requested({ prisma, orgId, args, from }) {
    const round = num(args, 'round', 3);
    const events = await prisma.auditEvent.findMany({ where: { orgId, action: 'deliverable.changes_requested', at: { gte: from } }, orderBy: { at: 'asc' }, take: TAKE });
    const hits = events.map((e) => ({ e, round: Number((e.after as { round?: number } | null)?.round ?? 0) })).filter((x) => x.round >= round);
    if (!hits.length) return [];
    const ds = await prisma.deliverable.findMany({
      where: { id: { in: hits.map((h) => h.e.entityId) } },
      include: { cycle: { select: { engagement: { select: { id: true, amId: true, clientOrg: { select: { id: true, name: true, amUserId: true } } } } } } },
    });
    const out: Subject[] = [];
    for (const { e, round: r } of hits) {
      const d = ds.find((x) => x.id === e.entityId);
      if (!d) continue;
      const eng = d.cycle.engagement;
      out.push({
        entity: 'Deliverable',
        entityId: d.id,
        dedupeKey: `round:${r}`,
        record: `${d.title} · ${eng.clientOrg.name} (round ${r})`,
        link: `/team/deliverables/${d.id}`,
        clientLink: `/client/reviews`,
        at: e.at,
        fields: { client: eng.clientOrg.name, title: d.title, type: d.type, round: r },
        vars: { client: eng.clientOrg.name, title: d.title, round: r, link: `/team/deliverables/${d.id}` },
        people: { am: eng.clientOrg.amUserId ?? eng.amId },
        clientOrgId: eng.clientOrg.id,
        engagementId: eng.id,
      });
    }
    return out;
  },

  async engagement_gate_reached({ prisma, orgId, args, from }) {
    const gate = String(args.gate || 'G5');
    const events = await prisma.auditEvent.findMany({ where: { orgId, action: `gate.${gate}.passed`, at: { gte: from } }, orderBy: { at: 'asc' }, take: TAKE });
    if (!events.length) return [];
    const planIds = events.filter((e) => e.entity === 'Plan').map((e) => e.entityId);
    const plans = planIds.length ? await prisma.plan.findMany({ where: { id: { in: planIds } }, select: { id: true, cycle: { select: { engagementId: true } } } }) : [];
    const engId = (e: (typeof events)[number]) => (e.entity === 'Plan' ? plans.find((p) => p.id === e.entityId)?.cycle.engagementId : e.entityId);
    const ids = [...new Set(events.map(engId).filter((x): x is string => !!x))];
    const engs = await prisma.engagement.findMany({ where: { id: { in: ids } }, include: { clientOrg: { select: { id: true, name: true, amUserId: true } }, service: { select: { name: true } } } });
    const out: Subject[] = [];
    for (const e of events) {
      const g = engs.find((x) => x.id === engId(e));
      if (!g) continue;
      out.push({
        entity: 'Engagement',
        entityId: g.id,
        dedupeKey: `gate:${gate}:${e.id}`,
        record: `${g.clientOrg.name} · ${g.service.name} passed ${gate}`,
        link: `/team/projects/${g.id}`,
        clientLink: '/client',
        at: e.at,
        fields: { client: g.clientOrg.name, service: g.service.name, billing: g.billingType },
        vars: { client: g.clientOrg.name, service: g.service.name, gate, link: `/team/projects/${g.id}` },
        people: { am: g.amId ?? g.clientOrg.amUserId },
        clientOrgId: g.clientOrg.id,
        engagementId: g.id,
      });
    }
    return out;
  },

  // --------------------------------------------------------- Client requests
  async request_created({ prisma, orgId, args, from }) {
    const type = String(args.type ?? '');
    const rows = await prisma.request.findMany({ where: { orgId, createdAt: { gte: from }, ...(type ? { type } : {}) }, include: requestInclude, take: TAKE });
    return rows.map((r) => requestSubject(r, r.createdAt, 'created'));
  },

  async request_sla_breached({ prisma, orgId, from, now }) {
    const rows = await prisma.request.findMany({ where: { orgId, slaDue: { gte: from, lt: now } }, include: requestInclude, take: 1000 });
    return rows.filter((r) => !r.firstReplyAt || r.firstReplyAt > r.slaDue!).map((r) => requestSubject(r, r.slaDue!, 'sla')).slice(0, TAKE);
  },

  async client_health_dropped({ prisma, orgId, now }) {
    const rows = await clientHealth(prisma, orgId, now);
    const month = now.toISOString().slice(0, 7);
    return rows
      .filter((c) => c.score < 50)
      .map((c) => ({
        entity: 'Client',
        entityId: c.id,
        dedupeKey: `at_risk:${month}`,
        record: `${c.name} · health ${c.score}`,
        link: `/team/clients/${c.id}`,
        at: now,
        fields: { client: c.name, score: c.score, industry: c.industry },
        vars: { client: c.name, score: c.score, reasons: c.reasons.join('; '), link: `/team/clients/${c.id}` },
        people: { am: c.amUserId },
        clientOrgId: c.id,
      }));
  },

  // -------------------------------------------------------------------- Team
  async leave_requested({ prisma, orgId, from }) {
    const rows = await prisma.leaveRequest.findMany({ where: { orgId, createdAt: { gte: from }, status: { not: 'cancelled' } }, take: TAKE });
    if (!rows.length) return [];
    const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, name: true, managerId: true, departmentId: true } });
    const heads = await headsByDepartment(prisma, orgId);
    return rows.map((r) => {
      const u = users.find((x) => x.id === r.userId);
      const dept = u?.departmentId ? heads.get(u.departmentId) : undefined;
      const days = Math.round((r.to.getTime() - r.from.getTime()) / DAY) + 1;
      const name = u?.name ?? 'Someone';
      return {
        entity: 'LeaveRequest',
        entityId: r.id,
        dedupeKey: 'requested',
        record: `${name} · ${r.type} leave ${fmtDay(r.from)} to ${fmtDay(r.to)}`,
        link: '/admin/attendance',
        at: r.createdAt,
        fields: { person: name, type: r.type, days, department: dept?.name ?? null },
        vars: { person: name, type: r.type, from: fmtDay(r.from), to: fmtDay(r.to), days, link: '/admin/attendance' },
        people: { owner: r.userId, manager: u?.managerId ?? null, department_head: dept?.head ?? null },
      };
    });
  },
  // ---------------------------------------------------------- v14 workflows
  async proposal_sent({ prisma, orgId, from }) {
    const rows = await prisma.proposal.findMany({
      where: { orgId, deletedAt: null, sentAt: { gte: from }, status: { not: 'draft' } },
      include: { lead: { include: { owner: { select: { id: true, name: true, managerId: true } } } } },
      take: TAKE,
    });
    return rows.map((p) => proposalSubject(p, p.sentAt!, `sent:v${p.version}:${p.sentAt!.toISOString()}`, {}));
  },

  async deliverable_approved({ prisma, orgId, from }) {
    const events = await prisma.auditEvent.findMany({ where: { orgId, action: 'deliverable.approved', at: { gte: from } }, orderBy: { at: 'asc' }, take: TAKE });
    if (!events.length) return [];
    const ds = await prisma.deliverable.findMany({
      where: { id: { in: events.map((e) => e.entityId) } },
      include: { cycle: { select: { engagement: { select: { id: true, amId: true, clientOrg: { select: { id: true, name: true, amUserId: true } } } } } } },
    });
    const out: Subject[] = [];
    for (const e of events) {
      const d = ds.find((x) => x.id === e.entityId);
      if (!d) continue;
      const eng = d.cycle.engagement;
      out.push({
        entity: 'Deliverable',
        entityId: d.id,
        dedupeKey: `approved:${e.id}`,
        record: `${d.title} · ${eng.clientOrg.name}`,
        link: `/team/deliverables/${d.id}`,
        clientLink: '/client/reviews',
        at: e.at,
        fields: { client: eng.clientOrg.name, title: d.title, type: d.type, channel: d.channel },
        vars: { client: eng.clientOrg.name, title: d.title, link: `/team/deliverables/${d.id}` },
        people: { am: eng.clientOrg.amUserId ?? eng.amId },
        clientOrgId: eng.clientOrg.id,
        engagementId: eng.id,
      });
    }
    return out;
  },

  async request_sla_warning({ prisma, orgId, from, now }) {
    const rows = await prisma.request.findMany({ where: { orgId, slaDue: { gte: from }, firstReplyAt: null, status: { notIn: ['done', 'declined'] } }, include: requestInclude, take: 1000 });
    const out: Subject[] = [];
    for (const r of rows) {
      const warnAt = new Date(r.createdAt.getTime() + 0.75 * (r.slaDue!.getTime() - r.createdAt.getTime()));
      if (warnAt > now || warnAt < from) continue;
      const s = requestSubject(r, warnAt, 'sla75');
      s.people.assignee = r.assigneeId;
      out.push(s);
    }
    return out.slice(0, TAKE);
  },

  async engagement_renewal_due({ prisma, orgId, args, from, now }) {
    const days = num(args, 'days', 30);
    const rows = await prisma.engagement.findMany({
      where: { orgId, deletedAt: null, archivedAt: null, status: { notIn: ['closed', 'offboarding'] }, endDate: { lte: new Date(now.getTime() + days * DAY), gte: new Date(from.getTime() + days * DAY) } },
      include: { clientOrg: { select: { id: true, name: true, amUserId: true } }, service: { select: { name: true } } },
      take: TAKE,
    });
    return rows.map((g) => {
      const crossing = new Date(g.endDate!.getTime() - days * DAY);
      return {
        entity: 'Engagement',
        entityId: g.id,
        dedupeKey: `renewal${days}d:${g.endDate!.toISOString().slice(0, 10)}`,
        record: `${g.clientOrg.name} · ${g.service.name} ends ${fmtDay(g.endDate)}`,
        link: `/team/projects/${g.id}`,
        clientLink: '/client',
        at: crossing,
        fields: { client: g.clientOrg.name, service: g.service.name, billing: g.billingType },
        vars: { client: g.clientOrg.name, service: g.service.name, end: fmtDay(g.endDate), days: Math.max(0, Math.round((g.endDate!.getTime() - now.getTime()) / DAY)), renewal_count: g.renewalCount, link: `/team/projects/${g.id}` },
        people: { am: g.amId ?? g.clientOrg.amUserId },
        clientOrgId: g.clientOrg.id,
        engagementId: g.id,
      };
    });
  },

  async offboarding_started({ prisma, orgId, from }) {
    const rows = await prisma.peopleProcess.findMany({ where: { orgId, kind: 'offboarding', createdAt: { gte: from }, status: { not: 'cancelled' } }, take: TAKE });
    if (!rows.length) return [];
    const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, name: true, managerId: true, departmentId: true } });
    const heads = await headsByDepartment(prisma, orgId);
    return rows.map((r) => {
      const u = users.find((x) => x.id === r.userId);
      const dept = u?.departmentId ? heads.get(u.departmentId) : undefined;
      const name = u?.name ?? 'Someone';
      return {
        entity: 'User',
        entityId: r.userId,
        dedupeKey: `offboarding:${r.id}`,
        record: `${name} · offboarding`,
        link: `/admin/people`,
        at: r.createdAt,
        fields: { person: name, department: dept?.name ?? null },
        vars: { person: name, last_day: r.lastDay ? fmtDay(r.lastDay) : 'not set', reason: r.note ?? '', link: '/admin/people' },
        people: { owner: r.userId, manager: u?.managerId ?? null, department_head: dept?.head ?? null },
      };
    });
  },

  async form_submitted({ prisma, orgId, args, from }) {
    const formId = String(args.formId ?? '');
    const subs = await prisma.formSubmission.findMany({ where: { orgId, createdAt: { gte: from }, leadId: { not: null }, ...(formId ? { formId } : {}) }, include: { form: { select: { name: true } } }, orderBy: { createdAt: 'asc' }, take: TAKE });
    if (!subs.length) return [];
    const leads = await prisma.lead.findMany({ where: { id: { in: subs.map((x) => x.leadId!) }, deletedAt: null }, include: { owner: { select: { id: true, name: true, managerId: true } } } });
    const out: Subject[] = [];
    for (const sub of subs) {
      const l = leads.find((x) => x.id === sub.leadId);
      if (!l) continue;
      const s = leadSubject(l, sub.createdAt, `form:${sub.id}`, { form: sub.form.name });
      s.fields.form = sub.form.name;
      out.push(s);
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Builders

type LeadRow = { id: string; source: string; contact: unknown; budgetPaise: number | null; score: number; stage: string; serviceIds: string[]; ownerId: string | null; owner: { id: string; name: string; managerId: string | null } | null };

export function leadSubject(l: LeadRow, at: Date, dedupeKey: string, extra: Record<string, string | number>): Subject {
  const c = contactOf(l.contact);
  const name = c.name || c.company || 'New lead';
  const service = l.serviceIds.map(serviceName).join(', ');
  return {
    entity: 'Lead',
    entityId: l.id,
    dedupeKey,
    record: `Lead ${name}${c.company && c.company !== name ? ` · ${c.company}` : ''}`,
    link: `/team/leads/${l.id}`,
    at,
    fields: { source: l.source, budget: l.budgetPaise, service, company: c.company ?? null, score: l.score, stage: l.stage },
    vars: {
      lead: name,
      company: c.company || name,
      source: l.source,
      budget: l.budgetPaise ? formatINR(l.budgetPaise) : 'not given',
      service: service || 'our services',
      stage: leadStageLabels[l.stage as keyof typeof leadStageLabels] ?? l.stage,
      owner: l.owner?.name ?? 'unassigned',
      link: `/team/leads/${l.id}`,
      ...extra,
    },
    people: { owner: l.ownerId, manager: l.owner?.managerId ?? null },
    leadId: l.id,
  };
}

type ProposalRow = { id: string; totalPaise: number; lines: unknown; createdById: string | null; lead: LeadRow };

function proposalSubject(p: ProposalRow, at: Date, dedupeKey: string, extra: Record<string, string | number>): Subject {
  const base = leadSubject(p.lead, at, dedupeKey, extra);
  const lines = Array.isArray(p.lines) ? (p.lines as { name?: string; serviceName?: string }[]) : [];
  const service = lines.map((x) => x.serviceName ?? x.name).filter(Boolean).join(', ') || String(base.fields.service ?? '');
  const client = String(base.vars.company);
  return {
    ...base,
    entity: 'Proposal',
    entityId: p.id,
    record: `Proposal ${formatINR(p.totalPaise)} · ${client}`,
    link: `/team/proposals/${p.id}`,
    fields: { client, amount: p.totalPaise, service, source: p.lead.source },
    vars: { ...base.vars, client, amount: formatINR(p.totalPaise), service, link: `/team/proposals/${p.id}` },
    people: { owner: p.lead.ownerId ?? p.createdById, manager: p.lead.owner?.managerId ?? null },
  };
}

type InvoiceRow = {
  id: string;
  number: string;
  totalPaise: number;
  dueDate: Date;
  kind: string;
  engagementId: string | null;
  clientOrg: { id: string; name: string; amUserId: string | null } | null;
  proposal: { lead: { contact: unknown; ownerId: string | null } } | null;
};

function invoiceSubject(i: InvoiceRow, at: Date, dedupeKey: string, balance: number, extra: Record<string, string | number>): Subject {
  const client = i.clientOrg?.name ?? contactOf(i.proposal?.lead.contact).company ?? contactOf(i.proposal?.lead.contact).name ?? 'Client';
  return {
    entity: 'Invoice',
    entityId: i.id,
    dedupeKey,
    record: `Invoice ${i.number} · ${client}`,
    link: `/admin/finance/invoices/${i.id}`,
    clientLink: '/client/billing',
    at,
    fields: { client, amount: i.totalPaise, balance, kind: i.kind },
    vars: { invoice: i.number, client, amount: formatINR(i.totalPaise), balance: formatINR(balance), due: fmtDay(i.dueDate), link: `/admin/finance/invoices/${i.id}`, ...extra },
    people: { am: i.clientOrg?.amUserId ?? null, owner: i.proposal?.lead.ownerId ?? null },
    clientOrgId: i.clientOrg?.id ?? null,
    engagementId: i.engagementId,
    billing: true,
  };
}

const taskInclude = {
  owner: { select: { id: true, name: true, managerId: true } },
  deliverable: { select: { id: true, cycle: { select: { engagement: { select: { id: true, amId: true, clientOrg: { select: { id: true, name: true, amUserId: true } } } } } } } },
} as const;
type TaskRow = {
  id: string;
  title: string;
  kind: string;
  deadline: Date | null;
  blockedReason: string | null;
  departmentId: string | null;
  engagementId: string | null;
  ownerId: string | null;
  owner: { id: string; name: string; managerId: string | null } | null;
  deliverable: { id: string; cycle: { engagement: { id: string; amId: string | null; clientOrg: { id: string; name: string; amUserId: string | null } } } } | null;
};
type EngClient = { id: string; amId: string | null; clientOrg: { id: string; name: string; amUserId: string | null } };

async function engagementClients(prisma: PrismaService, rows: TaskRow[]) {
  const ids = [...new Set(rows.filter((t) => !t.deliverable && t.engagementId).map((t) => t.engagementId!))];
  const engs = ids.length ? await prisma.engagement.findMany({ where: { id: { in: ids } }, select: { id: true, amId: true, clientOrg: { select: { id: true, name: true, amUserId: true } } } }) : [];
  return new Map<string, EngClient>(engs.map((e) => [e.id, e]));
}

function taskSubject(t: TaskRow, heads: Map<string, { name: string; head: string | null }>, clients: Map<string, EngClient>, at: Date, dedupeKey: string, extra: Record<string, string | number>): Subject {
  const eng = t.deliverable?.cycle.engagement ?? (t.engagementId ? clients.get(t.engagementId) : undefined);
  const dept = t.departmentId ? heads.get(t.departmentId) : undefined;
  const link = t.deliverable ? `/team/deliverables/${t.deliverable.id}` : eng ? `/team/projects/${eng.id}` : '/team/tasks';
  const client = eng?.clientOrg.name ?? null;
  return {
    entity: 'Task',
    entityId: t.id,
    dedupeKey,
    record: `Task "${t.title}"${client ? ` · ${client}` : ''}`,
    link,
    at,
    fields: { title: t.title, department: dept?.name ?? null, client, kind: t.kind },
    vars: { title: t.title, client: client ?? 'internal', assignee: t.owner?.name ?? 'nobody', reason: t.blockedReason ?? 'no reason given', due: fmtDay(t.deadline), link, ...extra },
    people: { assignee: t.ownerId, owner: t.ownerId, am: eng ? (eng.clientOrg.amUserId ?? eng.amId) : null, manager: t.owner?.managerId ?? null, department_head: dept?.head ?? null },
    clientOrgId: eng?.clientOrg.id ?? null,
    engagementId: eng?.id ?? t.engagementId,
  };
}

const requestInclude = { engagement: { select: { id: true, amId: true, service: { select: { name: true } }, clientOrg: { select: { id: true, name: true, amUserId: true } } } } } as const;
type RequestRow = { id: string; type: string; description: string; slaDue: Date | null; engagement: { id: string; amId: string | null; service: { name: string }; clientOrg: { id: string; name: string; amUserId: string | null } } };

function requestSubject(r: RequestRow, at: Date, dedupeKey: string): Subject {
  const e = r.engagement;
  const typeLabel = requestTypeLabels[r.type as RequestType]?.team ?? r.type;
  return {
    entity: 'Request',
    entityId: r.id,
    dedupeKey,
    record: `${typeLabel} request · ${e.clientOrg.name}`,
    link: `/team/requests/${r.id}`,
    clientLink: `/client/requests/${r.id}`,
    at,
    fields: { type: r.type, client: e.clientOrg.name, service: e.service.name, description: r.description, tone: aiToneOf(r.description).tone },
    vars: { client: e.clientOrg.name, type: typeLabel.toLowerCase(), description: r.description.slice(0, 140), service: e.service.name, due: fmtDay(r.slaDue), link: `/team/requests/${r.id}` },
    people: { am: e.clientOrg.amUserId ?? e.amId },
    clientOrgId: e.clientOrg.id,
    engagementId: e.id,
  };
}

// ---------------------------------------------------------------------------
// Client health (same signals as Command Centre → Client Health, simplified)

export async function clientHealth(prisma: PrismaService, orgId: string, now: Date) {
  const [clients, invoices, requests, blocked, messages] = await Promise.all([
    prisma.clientOrg.findMany({
      where: { orgId, deletedAt: null },
      select: { id: true, name: true, industry: true, amUserId: true, createdAt: true, tenureStart: true, users: { select: { userId: true } }, engagements: { where: { deletedAt: null }, select: { status: true } } },
    }),
    prisma.invoice.findMany({ where: { orgId, clientOrgId: { not: null }, status: { in: ['issued', 'partially_paid', 'overdue'] }, dueDate: { lt: now } }, select: { clientOrgId: true } }),
    prisma.request.findMany({ where: { orgId, slaDue: { not: null, gte: new Date(now.getTime() - 30 * DAY), lt: now } }, select: { slaDue: true, firstReplyAt: true, engagement: { select: { clientOrgId: true } } } }),
    prisma.requirementItem.findMany({ where: { orgId, status: 'blocked' }, select: { cycle: { select: { engagement: { select: { clientOrgId: true } } } } } }),
    prisma.message.findMany({ where: { orgId, isInternal: false }, select: { authorId: true, createdAt: true, thread: { select: { clientOrgId: true } } }, orderBy: { createdAt: 'desc' }, take: 2000 }),
  ]);
  return clients.map((c) => {
    let score = 100;
    const reasons: string[] = [];
    const lose = (pts: number, why: string) => {
      if (pts <= 0) return;
      score -= pts;
      reasons.push(why);
    };
    const overdue = invoices.filter((i) => i.clientOrgId === c.id).length;
    lose(Math.min(30, overdue * 15), `${overdue} overdue invoice${overdue === 1 ? '' : 's'}`);
    const breaches = requests.filter((r) => r.engagement.clientOrgId === c.id && (!r.firstReplyAt || r.firstReplyAt > r.slaDue!)).length;
    lose(Math.min(20, breaches * 10), `${breaches} reply time${breaches === 1 ? '' : 's'} missed`);
    const blockedN = blocked.filter((b) => b.cycle.engagement.clientOrgId === c.id).length;
    lose(Math.min(15, blockedN * 5), `${blockedN} blocked requirement${blockedN === 1 ? '' : 's'}`);
    const ids = new Set(c.users.map((u) => u.userId));
    const last = messages.find((m) => m.thread.clientOrgId === c.id && ids.has(m.authorId))?.createdAt ?? c.tenureStart ?? c.createdAt;
    const quiet = Math.floor((now.getTime() - last.getTime()) / DAY);
    if (quiet > 30) lose(20, `quiet for ${quiet} days`);
    else if (quiet > 14) lose(10, `quiet for ${quiet} days`);
    const st = c.engagements.map((e) => e.status as string);
    if (st.includes('offboarding')) lose(20, 'offboarding');
    if (st.includes('blocked')) lose(10, 'work is blocked');
    if (st.includes('paused')) lose(10, 'engagement paused');
    return { id: c.id, name: c.name, industry: c.industry, amUserId: c.amUserId, score: Math.max(0, score), reasons };
  });
}
