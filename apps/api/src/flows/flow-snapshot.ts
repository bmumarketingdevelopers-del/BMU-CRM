// Loads the whole business flow once and works out, for every lead, proposal and engagement,
// which stage it sits in, since when, against which deadline, plus the gate entry/exit dates
// used for conversion and throughput. Shared by the flow map, the projects gate strip and the pulse.
import type { FlowItem, FlowSeverity, FlowStageKey } from '@bmu/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { avg, contactName, daysSince, DAY_MS, maxDate, minDate } from './flow-util.js';

export const GATE_KEYS = ['g1', 'g2', 'g3', 'g4', 'g5'] as const;
export type GateKey = (typeof GATE_KEYS)[number];

export const STAGE_META: Record<FlowStageKey, { label: string; tag: string; hint: string; minStuckDays: number; stuckRule: string }> = {
  leads: { label: 'Leads', tag: 'Sell', hint: 'New, contacted and in discovery', minStuckDays: 10, stuckRule: 'No stage change for over 2× the usual time (at least 10 days).' },
  proposals: { label: 'Proposals sent', tag: 'Sell', hint: 'Waiting for the client to decide', minStuckDays: 7, stuckRule: 'Past its validity date, or out for over 2× the usual time (at least 7 days).' },
  won: { label: 'Won & paid', tag: 'Sell', hint: 'Accepted, waiting for the advance', minStuckDays: 3, stuckRule: 'Advance invoice past its due date, or waiting over 3 days.' },
  g1: { label: 'Requirements', tag: 'G1', hint: 'Collecting inputs before the project clock starts', minStuckDays: 7, stuckRule: 'Waiting on inputs for over 2× the usual time (at least 7 days).' },
  g2: { label: 'Plan approved', tag: 'G2', hint: 'Planning and client plan approval', minStuckDays: 7, stuckRule: 'Past the plan deadline, or over 2× the usual time.' },
  g3: { label: 'Production', tag: 'G3', hint: 'Tasks assigned, work in progress', minStuckDays: 14, stuckRule: 'Past the first-draft deadline, or over 2× the usual time.' },
  g4: { label: 'Client review', tag: 'G4', hint: 'Drafts with the client', minStuckDays: 5, stuckRule: 'Past the deliverable due date, or with the client over 2× the usual time.' },
  g5: { label: 'Final delivery', tag: 'G5', hint: 'Sign-off and balance before files are released', minStuckDays: 7, stuckRule: 'Balance invoice past due, or waiting over 2× the usual time.' },
  retainer: { label: 'Retainer', tag: 'Active', hint: 'Monthly clients in steady state', minStuckDays: Infinity, stuckRule: 'Flagged when the client has an overdue invoice.' },
  offboarding: { label: 'Offboarding', tag: 'Exit', hint: 'Wrapping up and handing over', minStuckDays: 14, stuckRule: 'Offboarding for over 14 days.' },
};

export type EngagementFacts = {
  id: string;
  clientOrgId: string;
  clientName: string;
  serviceName: string;
  billingType: string;
  status: string;
  currentGate: string;
  amName: string | null;
  amId: string | null;
  valuePaise: number;
  started: Date;
  /** When each gate was passed (exit of that stage). */
  passed: Record<GateKey, Date | null>;
  offboardedAt: Date | null;
  stage: FlowStageKey | null;
  since: Date;
  deadline: Date | null;
  overdueInvoice: boolean;
};

type RawItem = Omit<FlowItem, 'severity' | 'reason' | 'days' | 'since' | 'deadline'> & { sinceDate: Date; deadlineDate: Date | null; forceRed?: string | null };

export type Snapshot = {
  now: Date;
  leads: { id: string; createdAt: Date; stage: string; name: string; proposalSentAt: Date | null }[];
  proposals: { id: string; leadId: string; status: string; netPaise: number; sentAt: Date | null; acceptedAt: Date | null; leadCreatedAt: Date; name: string }[];
  firstPayments: { proposalId: string; at: Date; amountPaise: number; leadCreatedAt: Date }[];
  engagements: EngagementFacts[];
  stages: Record<FlowStageKey, FlowItem[]>;
};

const severityFor = (key: FlowStageKey, items: RawItem[], now: Date): FlowItem[] => {
  const meta = STAGE_META[key];
  const typical = avg(items.map((i) => daysSince(i.sinceDate, now))) ?? 0;
  const threshold = Math.max(2 * typical, meta.minStuckDays);
  return items
    .map((i): FlowItem => {
      const days = daysSince(i.sinceDate, now);
      let severity: FlowSeverity = 'ok';
      let reason: string | null = null;
      const late = i.deadlineDate && i.deadlineDate < now ? Math.max(1, Math.round((now.getTime() - i.deadlineDate.getTime()) / DAY_MS)) : 0;
      if (i.forceRed) {
        severity = 'red';
        reason = i.forceRed;
      } else if (late > 0) {
        severity = 'red';
        reason = `Past deadline by ${late} day${late === 1 ? '' : 's'}`;
      } else if (Number.isFinite(threshold) && days > threshold) {
        severity = days > 2 * threshold ? 'red' : 'amber';
        reason = `${Math.round(days)} days here, usual is about ${Math.max(1, Math.round(typical))}`;
      }
      const { sinceDate, deadlineDate, forceRed, ...rest } = i;
      void forceRed;
      return { ...rest, since: sinceDate.toISOString(), deadline: deadlineDate?.toISOString() ?? null, days, severity, reason };
    })
    .sort((a, b) => (a.severity === b.severity ? b.days - a.days : a.severity === 'red' ? -1 : b.severity === 'red' ? 1 : a.severity === 'amber' ? -1 : 1));
};

function stageOf(status: string): FlowStageKey | null {
  switch (status) {
    case 'pending_payment':
    case 'onboarding':
    case 'blocked':
      return 'g1';
    case 'planning':
    case 'awaiting_plan_approval':
      return 'g2';
    case 'in_production':
      return 'g3';
    case 'in_review':
      return 'g4';
    case 'awaiting_final_payment':
      return 'g5';
    case 'active_retainer':
      return 'retainer';
    case 'offboarding':
      return 'offboarding';
    default:
      return null;
  }
}

/** Load everything the flow needs for one organisation. `engagementWhere` narrows engagements (visibility). */
export async function loadSnapshot(prisma: PrismaService, orgId: string, opts: { engagementIds?: string[] } = {}): Promise<Snapshot> {
  const now = new Date();
  const [leadRows, proposalRows, firstInvoices, engagementRows] = await Promise.all([
    prisma.lead.findMany({ where: { orgId, deletedAt: null }, include: { owner: { select: { name: true } } } }),
    prisma.proposal.findMany({ where: { orgId, deletedAt: null }, include: { lead: { include: { owner: { select: { name: true } } } } } }),
    prisma.invoice.findMany({ where: { orgId, kind: 'first_payment' }, include: { payments: true } }),
    prisma.engagement.findMany({
      where: { orgId, deletedAt: null, ...(opts.engagementIds ? { id: { in: opts.engagementIds } } : {}) },
      include: {
        clientOrg: { select: { id: true, name: true } },
        service: { include: { tiers: true } },
        am: { select: { id: true, name: true } },
        cycles: { include: { plans: true, deliverables: { include: { versions: { select: { sentToClientAt: true } } } } } },
      },
    }),
  ]);
  const engIds = engagementRows.map((e) => e.id);
  const planToEng = new Map<string, string>();
  const cycleToEng = new Map<string, string>();
  const delivToEng = new Map<string, string>();
  for (const e of engagementRows)
    for (const c of e.cycles) {
      cycleToEng.set(c.id, e.id);
      for (const p of c.plans) planToEng.set(p.id, e.id);
      for (const d of c.deliverables) delivToEng.set(d.id, e.id);
    }
  const [approvals, audits, invoices] = await Promise.all([
    prisma.approval.findMany({ where: { orgId, gate: { not: null }, targetType: { in: ['engagement', 'plan', 'deliverable'] } }, orderBy: { at: 'asc' } }),
    prisma.auditEvent.findMany({
      where: {
        orgId,
        OR: [
          { entity: 'Engagement', entityId: { in: engIds }, action: { in: ['gate.G1.passed', 'gate.G3.passed', 'gate.G4.passed', 'gate.G5.passed', 'engagement.lifecycle.offboard'] } },
          { entity: 'Lead', action: { startsWith: 'lead.' } },
        ],
      },
      orderBy: { at: 'asc' },
    }),
    prisma.invoice.findMany({ where: { orgId, status: { in: ['issued', 'partially_paid', 'overdue'] } }, select: { id: true, clientOrgId: true, engagementId: true, kind: true, status: true, dueDate: true } }),
  ]);

  // ---------------------------------------------------------------- leads
  const leadMoved = new Map<string, Date>();
  for (const a of audits) if (a.entity === 'Lead' && /^lead\.(new|contacted|discovery|proposal_sent|won|lost)$/.test(a.action)) leadMoved.set(a.entityId, a.at);
  const sentByLead = new Map<string, Date>();
  for (const p of proposalRows) if (p.sentAt && (!sentByLead.get(p.leadId) || p.sentAt < sentByLead.get(p.leadId)!)) sentByLead.set(p.leadId, p.sentAt);

  const stagesRaw: Record<FlowStageKey, RawItem[]> = { leads: [], proposals: [], won: [], g1: [], g2: [], g3: [], g4: [], g5: [], retainer: [], offboarding: [] };
  for (const l of leadRows) {
    if (!['new', 'contacted', 'discovery'].includes(l.stage)) continue;
    const since = leadMoved.get(l.id) ?? l.createdAt;
    stagesRaw.leads.push({
      id: l.id,
      kind: 'lead',
      title: contactName(l.contact),
      subtitle: `${l.stage === 'new' ? 'New' : l.stage === 'contacted' ? 'Contacted' : 'Discovery'} · ${l.need}`.slice(0, 120),
      href: '/team/leads',
      clientHref: null,
      valuePaise: l.budgetPaise,
      owner: l.owner?.name ?? null,
      sinceDate: since,
      deadlineDate: null,
    });
  }

  // ------------------------------------------------------------ proposals
  const paymentByProposal = new Map<string, { at: Date; amountPaise: number; dueDate: Date; paid: boolean }>();
  for (const inv of firstInvoices) {
    if (!inv.proposalId) continue;
    const first = [...inv.payments].sort((a, b) => a.at.getTime() - b.at.getTime())[0];
    paymentByProposal.set(inv.proposalId, { at: first?.at ?? inv.createdAt, amountPaise: inv.payments.reduce((s, p) => s + p.amountPaise, 0), dueDate: inv.dueDate, paid: inv.status === 'paid' || !!first });
  }
  for (const p of proposalRows) {
    const net = p.totalPaise - p.gstPaise;
    // Expired proposals (v10: swept automatically) stay on the map as stuck until extended or replaced.
    if (p.status === 'sent' || p.status === 'expired') {
      const expired = p.status === 'expired' || p.validUntil < now;
      stagesRaw.proposals.push({
        id: p.id,
        kind: 'proposal',
        title: contactName(p.lead.contact),
        subtitle: `Proposal v${p.version}${p.viewedAt ? ' · viewed' : ' · not opened yet'}`,
        href: `/team/proposals/${p.id}`,
        clientHref: null,
        valuePaise: net,
        owner: p.lead.owner?.name ?? null,
        sinceDate: p.sentAt ?? p.createdAt,
        deadlineDate: null,
        forceRed: expired ? `Validity ended ${Math.round((now.getTime() - p.validUntil.getTime()) / DAY_MS)} days ago` : null,
      });
    } else if (p.status === 'accepted' && !paymentByProposal.get(p.id)?.paid) {
      const pay = paymentByProposal.get(p.id);
      stagesRaw.won.push({
        id: p.id,
        kind: 'proposal',
        title: contactName(p.lead.contact),
        subtitle: 'Accepted, advance not paid yet',
        href: `/team/proposals/${p.id}`,
        clientHref: null,
        valuePaise: net,
        owner: p.lead.owner?.name ?? null,
        sinceDate: p.acceptedAt ?? p.updatedAt,
        deadlineDate: pay?.dueDate ?? null,
      });
    }
  }

  // ----------------------------------------------------------- engagements
  const firstApproval = (pred: (a: (typeof approvals)[number]) => boolean) => approvals.find(pred)?.at ?? null;
  const auditAt = (engId: string, action: string, last = false) => {
    const list = audits.filter((a) => a.entityId === engId && a.action === action);
    return (last ? list.at(-1) : list[0])?.at ?? null;
  };
  const engagements: EngagementFacts[] = engagementRows.map((e) => {
    const cycles = [...e.cycles].sort((a, b) => b.period.localeCompare(a.period));
    const latest = cycles[0];
    const plans = e.cycles.flatMap((c) => c.plans);
    const deliverables = e.cycles.flatMap((c) => c.deliverables);
    const started = e.startDate ?? e.createdAt;
    const g1 = firstApproval((a) => a.targetType === 'engagement' && a.targetId === e.id && a.gate === 'G1') ?? auditAt(e.id, 'gate.G1.passed') ?? minDate(e.cycles.map((c) => c.rcdAt));
    const g2 =
      minDate(plans.map((p) => (p.status === 'approved' ? p.approvedAt : null))) ??
      firstApproval((a) => a.gate === 'G2' && (planToEng.get(a.targetId) === e.id || cycleToEng.get(a.targetId) === e.id));
    const g3 = minDate(deliverables.flatMap((d) => d.versions.map((v) => v.sentToClientAt)));
    const allApproved = deliverables.length > 0 && deliverables.every((d) => ['approved', 'scheduled', 'published'].includes(d.status));
    const g4 =
      auditAt(e.id, 'gate.G4.passed') ??
      (allApproved ? maxDate(deliverables.map((d) => firstApproval((a) => a.targetType === 'deliverable' && a.targetId === d.id && a.gate === 'G4'))) : null);
    const g5 = auditAt(e.id, 'gate.G5.passed') ?? (e.status === 'delivered' || e.status === 'closed' ? (e.finalSignedOffAt ?? null) : null);
    const offboardedAt = auditAt(e.id, 'engagement.lifecycle.offboard', true);
    const stage = stageOf(e.status);
    const unpaid = invoices.filter((i) => i.engagementId === e.id || (i.clientOrgId === e.clientOrgId && !i.engagementId));
    const overdueInvoice = unpaid.some((i) => i.status === 'overdue' || i.dueDate < now);
    let since = started;
    let deadline: Date | null = null;
    if (stage === 'g2') {
      since = g1 ?? started;
      deadline = latest?.planningDue ?? null;
    } else if (stage === 'g3') {
      since = g2 ?? g1 ?? started;
      deadline = latest?.firstDraftDue ?? null;
    } else if (stage === 'g4') {
      const waiting = latest?.deliverables.filter((d) => d.status === 'ready_for_client') ?? [];
      since = maxDate(waiting.flatMap((d) => d.versions.map((v) => v.sentToClientAt))) ?? g3 ?? g2 ?? started;
      deadline = maxDate((latest?.deliverables ?? []).map((d) => d.dueAt));
    } else if (stage === 'g5') {
      since = g4 ?? g3 ?? started;
      deadline = minDate(unpaid.filter((i) => i.kind === 'project_balance' && i.engagementId === e.id).map((i) => i.dueDate));
    } else if (stage === 'retainer') {
      since = g4 ?? started;
    } else if (stage === 'offboarding') {
      since = offboardedAt ?? started;
    }
    const tier = e.service.tiers.find((t) => t.tier === e.tier);
    return {
      id: e.id,
      clientOrgId: e.clientOrgId,
      clientName: e.clientOrg.name,
      serviceName: e.service.name,
      billingType: e.billingType,
      status: e.status,
      currentGate: e.currentGate,
      amName: e.am?.name ?? null,
      amId: e.am?.id ?? null,
      valuePaise: tier?.pricePaise ?? 0,
      started,
      passed: { g1, g2, g3, g4, g5 },
      offboardedAt,
      stage,
      since,
      deadline,
      overdueInvoice,
    };
  });

  const statusText: Record<string, string> = {
    pending_payment: 'Waiting for payment',
    onboarding: 'Collecting requirements',
    blocked: 'Blocked on client inputs',
    planning: 'Plan in progress',
    awaiting_plan_approval: 'Plan with the client',
    in_production: 'In production',
    in_review: 'Drafts with the client',
    awaiting_final_payment: 'Waiting for sign-off and balance',
    active_retainer: 'Active retainer',
    offboarding: 'Offboarding',
  };
  for (const f of engagements) {
    if (!f.stage) continue;
    stagesRaw[f.stage].push({
      id: f.id,
      kind: 'engagement',
      title: f.clientName,
      subtitle: `${f.serviceName} · ${statusText[f.status] ?? f.status}`,
      href: `/team/projects/${f.id}`,
      clientHref: `/team/clients/${f.clientOrgId}`,
      valuePaise: f.valuePaise || null,
      owner: f.amName,
      sinceDate: f.since,
      deadlineDate: f.deadline,
      forceRed: f.stage === 'retainer' && f.overdueInvoice ? 'Has an overdue invoice' : null,
    });
  }

  const stages = Object.fromEntries((Object.keys(stagesRaw) as FlowStageKey[]).map((k) => [k, severityFor(k, stagesRaw[k], now)])) as Record<FlowStageKey, FlowItem[]>;

  const leadById = new Map(leadRows.map((l) => [l.id, l]));
  return {
    now,
    stages,
    engagements,
    leads: leadRows.map((l) => ({ id: l.id, createdAt: l.createdAt, stage: l.stage, name: contactName(l.contact), proposalSentAt: sentByLead.get(l.id) ?? null })),
    proposals: proposalRows.map((p) => ({ id: p.id, leadId: p.leadId, status: p.status, netPaise: p.totalPaise - p.gstPaise, sentAt: p.sentAt, acceptedAt: p.acceptedAt, leadCreatedAt: p.lead.createdAt, name: contactName(p.lead.contact) })),
    firstPayments: [...paymentByProposal.entries()]
      .filter(([, v]) => v.paid)
      .map(([proposalId, v]) => {
        const p = proposalRows.find((x) => x.id === proposalId);
        return { proposalId, at: v.at, amountPaise: v.amountPaise, leadCreatedAt: (p && leadById.get(p.leadId)?.createdAt) ?? p?.createdAt ?? v.at };
      }),
  };
}
