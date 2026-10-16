import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { addWorkingDays, formatINR, type FlowJourney, type FlowJourneyEvent, type FlowJourneyGate, type FlowJourneyOption, type Me } from '@bmu/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { visibleEngagementWhere } from '../engagements/engagement-access.js';
import { fmtDay, istDayDiff, maxDate, minDate } from './flow-util.js';
import { clientVisibleInvoiceWhere, readInvoiceBranding } from '../service/invoice-branding.service.js';

export const JOURNEY_GATES = [
  { gate: 'G1', name: 'Requirements complete' },
  { gate: 'G2', name: 'Plan approved' },
  { gate: 'G3', name: 'Production started' },
  { gate: 'G4', name: 'All work approved' },
  { gate: 'G5', name: 'Final delivery' },
] as const;

const INVOICE_KIND: Record<string, string> = { first_payment: 'Advance', retainer: 'Monthly retainer', project_balance: 'Project balance', addon: 'Extra request', standard: 'Invoice' };

type Draft = Omit<FlowJourneyEvent, 'state' | 'timing' | 'varianceDays' | 'at' | 'plannedAt'> & { at: Date | null; plannedAt?: Date | null };

@Injectable()
export class JourneyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /** Engagements whose journey this user may open: staff by visibility (optionally one client), clients their own. */
  async options(me: Me, clientId?: string): Promise<FlowJourneyOption[]> {
    let where;
    if (me.type === 'client') {
      if (!me.clientOrg) throw new ForbiddenException('Client accounts only');
      where = { orgId: me.orgId, clientOrgId: me.clientOrg.id, deletedAt: null };
    } else if (me.type === 'staff') {
      where = { AND: [await visibleEngagementWhere(this.prisma, me), ...(clientId ? [{ clientOrgId: clientId }] : [])] };
    } else throw new ForbiddenException('Not available for your account');
    const rows = await this.prisma.engagement.findMany({ where, include: { service: { select: { name: true } }, clientOrg: { select: { name: true } } }, orderBy: { createdAt: 'desc' } });
    return rows.map((e) => ({ id: e.id, serviceName: e.service.name, status: e.status, currentGate: e.currentGate, clientName: e.clientOrg.name }));
  }

  async journey(me: Me, id: string): Promise<FlowJourney> {
    let scope;
    if (me.type === 'client') {
      if (!me.clientOrg) throw new ForbiddenException('Client accounts only');
      scope = { orgId: me.orgId, clientOrgId: me.clientOrg.id, deletedAt: null };
    } else if (me.type === 'staff') scope = await visibleEngagementWhere(this.prisma, me);
    else throw new ForbiddenException('Not available for your account');
    const e = await this.prisma.engagement.findFirst({
      where: { AND: [scope, { id }] },
      include: {
        clientOrg: true,
        service: true,
        cycles: {
          orderBy: { period: 'asc' },
          include: {
            requirements: true,
            plans: true,
            deliverables: { include: { versions: { include: { qcResults: true }, orderBy: { number: 'asc' } }, tasks: { select: { id: true, createdAt: true } } } },
          },
        },
      },
    });
    if (!e) throw new NotFoundException('Engagement not found');
    const internalOk = me.type === 'staff';
    const now = new Date();
    const holidays = (await this.settings.get(me.orgId, 'holidays')).list.map((h) => h.date);

    const cycles = e.cycles;
    const latest = cycles.at(-1);
    const plans = cycles.flatMap((c) => c.plans);
    const deliverables = cycles.flatMap((c) => c.deliverables);
    const versions = deliverables.flatMap((d) => d.versions.map((v) => ({ ...v, deliverable: d })));
    const reqs = cycles.flatMap((c) => c.requirements.map((r) => ({ ...r, rcdAt: c.rcdAt })));

    // Proposal and advance invoice that started this engagement.
    const started = e.startDate ?? e.createdAt;
    const proposals = e.clientOrg.leadId
      ? await this.prisma.proposal.findMany({ where: { leadId: e.clientOrg.leadId, status: 'accepted', deletedAt: null }, orderBy: { acceptedAt: 'asc' } })
      : [];
    // Only a proposal that actually sold this service, accepted before the engagement started.
    const sold = proposals.filter((p) => ((p.lines ?? []) as { kind?: string; key?: string }[]).some((l) => l.kind === 'service' && l.key === e.service.key));
    const proposal = [...sold].reverse().find((p) => p.acceptedAt && p.acceptedAt.getTime() <= started.getTime() + 86_400_000) ?? null;
    const invoices = await this.prisma.invoice.findMany({
      // v28: clients do not see invoices still waiting for the seal and signature.
      where: { orgId: e.orgId, OR: [{ engagementId: e.id }, ...(proposal ? [{ proposalId: proposal.id, kind: 'first_payment' }] : [])], status: { notIn: ['draft', 'void'] }, ...(me.type === 'client' ? { AND: [clientVisibleInvoiceWhere(await readInvoiceBranding(this.prisma, e.orgId))] } : {}) },
      include: { payments: { orderBy: { at: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    });

    const planIds = plans.map((p) => p.id);
    const cycleIds = cycles.map((c) => c.id);
    const delivIds = deliverables.map((d) => d.id);
    const [approvals, audits] = await Promise.all([
      this.prisma.approval.findMany({
        where: { orgId: e.orgId, OR: [{ targetType: 'engagement', targetId: e.id }, { targetType: 'plan', targetId: { in: [...planIds, ...cycleIds] } }, { targetType: 'deliverable', targetId: { in: delivIds } }] },
        orderBy: { at: 'asc' },
      }),
      this.prisma.auditEvent.findMany({
        where: {
          orgId: e.orgId,
          OR: [
            { entity: 'Engagement', entityId: e.id },
            { entity: 'Plan', entityId: { in: planIds } },
            { entity: 'Deliverable', entityId: { in: delivIds } },
            { entity: 'RequirementItem', entityId: { in: reqs.map((r) => r.id) } },
          ],
        },
        orderBy: { at: 'asc' },
      }),
    ]);
    const userIds = [...new Set([...approvals.map((a) => a.userId), ...plans.map((p) => p.approvedById).filter((x): x is string => !!x)])];
    const users = new Map((await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    const audit = (action: string, entityId?: string) => audits.filter((a) => a.action === action && (!entityId || a.entityId === entityId));

    const drafts: Draft[] = [];
    const push = (d: Omit<Draft, 'gate' | 'internal' | 'detail'> & Partial<Pick<Draft, 'gate' | 'internal' | 'detail'>>) =>
      drafts.push({ gate: null, internal: false, detail: null, ...d });

    // Sell
    if (proposal?.acceptedAt)
      push({ id: `prop-${proposal.id}`, kind: 'proposal_accepted', title: 'Proposal accepted and agreement signed', detail: `${formatINR(proposal.totalPaise - proposal.gstPaise)} + GST`, at: proposal.acceptedAt });
    for (const inv of invoices) {
      const paidPaise = inv.payments.reduce((s, p) => s + p.amountPaise, 0);
      const label = INVOICE_KIND[inv.kind] ?? 'Invoice';
      if (inv.kind !== 'first_payment') push({ id: `inv-${inv.id}`, kind: 'invoice_issued', title: `${label} invoice ${inv.number} issued`, detail: `${formatINR(inv.totalPaise)} incl. GST, due ${fmtDay(inv.dueDate)}`, at: inv.createdAt });
      const last = inv.payments.at(-1);
      if (last && paidPaise >= inv.totalPaise)
        push({ id: `paid-${inv.id}`, kind: inv.kind === 'first_payment' ? 'paid' : 'invoice_paid', title: inv.kind === 'first_payment' ? 'Advance paid' : `${label} invoice ${inv.number} paid`, detail: formatINR(paidPaise), at: last.at });
      else if (last) push({ id: `part-${inv.id}`, kind: 'invoice_paid', title: `Part payment on ${inv.number}`, detail: `${formatINR(paidPaise)} of ${formatINR(inv.totalPaise)}`, at: last.at });
    }
    push({ id: `start-${e.id}`, kind: 'started', title: 'Onboarding started', detail: `${e.service.name} account set up and requirements requested`, at: started });

    // G1 requirements
    for (const r of reqs) {
      const ev = [...audit('requirement.received', r.id), ...audit('requirement.submitted_by_client', r.id)].sort((a, b) => a.at.getTime() - b.at.getTime()).at(-1);
      if (r.status === 'received') push({ id: `req-${r.id}`, kind: 'requirement', title: `Received: ${r.label}`, at: ev?.at ?? r.rcdAt ?? r.dateRequested });
      for (const b of audit('requirement.blocked', r.id))
        push({ id: `reqb-${b.id}`, kind: 'requirement', title: `Blocked: ${r.label}`, detail: (b.after as { blockedReason?: string } | null)?.blockedReason ?? null, at: b.at, internal: true });
    }
    const g1 = approvals.find((a) => a.targetType === 'engagement' && a.gate === 'G1')?.at ?? audit('gate.G1.passed')[0]?.at ?? minDate(cycles.map((c) => c.rcdAt));
    const planningDue = cycles.find((c) => c.rcdAt)?.planningDue ?? latest?.planningDue ?? null;

    // G2 plan
    for (const a of audit('plan.submitted')) push({ id: `plans-${a.id}`, kind: 'plan_internal', title: 'Plan submitted for internal review', at: a.at, internal: true });
    for (const a of audit('plan.sent_to_client')) push({ id: `plansent-${a.id}`, kind: 'plan_sent', title: 'Plan shared for approval', at: a.at });
    for (const a of audits.filter((x) => x.entity === 'Plan' && x.action === 'plan.changes_requested'))
      push({ id: `planch-${a.id}`, kind: 'plan_changes', title: 'Changes requested on the plan', detail: (a.after as { comment?: string } | null)?.comment ?? null, at: a.at });
    const approvedPlan = plans.filter((p) => p.status === 'approved' && p.approvedAt).sort((a, b) => a.approvedAt!.getTime() - b.approvedAt!.getTime())[0];
    const g2Approval = approvals.find((a) => a.gate === 'G2');
    const g2 = approvedPlan?.approvedAt ?? g2Approval?.at ?? null;
    const g2By = approvedPlan?.approvedById ? users.get(approvedPlan.approvedById) : g2Approval ? users.get(g2Approval.userId) : undefined;

    // G3 production
    const tasks = deliverables.flatMap((d) => d.tasks);
    const g3Audit = audit('gate.G3.passed')[0] ?? audit('gate.G3.waiting')[0];
    const tasksAt = g3Audit?.at ?? minDate(tasks.map((t) => t.createdAt));
    if (tasksAt && tasks.length) push({ id: `tasks-${e.id}`, kind: 'tasks_generated', title: `${tasks.length} production tasks generated`, detail: 'From department flow templates', at: tasksAt, internal: true });
    const g3 = audit('gate.G3.passed')[0]?.at ?? (['G4', 'G5'].includes(e.currentGate) || ['in_review', 'awaiting_final_payment', 'delivered', 'active_retainer'].includes(e.status) ? tasksAt : null);

    // Versions, QC and client decisions
    for (const v of versions) {
      const name = `V${v.number} of ${v.deliverable.title}`;
      push({ id: `ver-${v.id}`, kind: 'version_uploaded', title: `${name} uploaded`, at: v.createdAt, internal: true });
      for (const q of v.qcResults) push({ id: `qc-${q.id}`, kind: 'qc', title: `QC ${q.result === 'pass' ? 'passed' : 'failed'} on ${name}`, at: q.createdAt, internal: true });
      if (v.sentToClientAt) push({ id: `sent-${v.id}`, kind: 'version_sent', title: `${name} sent for review`, at: v.sentToClientAt });
    }
    for (const a of audits.filter((x) => x.entity === 'Deliverable' && x.action === 'deliverable.changes_requested')) {
      const d = deliverables.find((x) => x.id === a.entityId);
      const round = (a.after as { round?: number } | null)?.round;
      push({ id: `chg-${a.id}`, kind: 'version_changes', title: `Changes requested on ${d?.title ?? 'a deliverable'}`, detail: round ? `Revision round ${round}` : null, at: a.at });
    }
    for (const a of approvals.filter((x) => x.targetType === 'deliverable')) {
      const d = deliverables.find((x) => x.id === a.targetId);
      const v = versions.find((x) => x.id === a.versionId);
      push({ id: `appr-${a.id}`, kind: 'version_approved', title: `${d?.title ?? 'Deliverable'} approved${v ? ` (V${v.number})` : ''}`, detail: users.get(a.userId) ? `By ${users.get(a.userId)}` : null, at: a.at });
    }
    const allApproved = deliverables.length > 0 && deliverables.every((d) => ['approved', 'scheduled', 'published'].includes(d.status));
    const g4 = audit('gate.G4.passed')[0]?.at ?? (allApproved ? maxDate(approvals.filter((a) => a.targetType === 'deliverable').map((a) => a.at)) : null);

    // G5
    const signOff = approvals.find((a) => a.targetType === 'engagement' && a.gate === 'G5');
    if (signOff || e.finalSignedOffAt) push({ id: `sign-${e.id}`, kind: 'sign_off', title: 'Final sign-off given', detail: signOff ? `By ${users.get(signOff.userId) ?? 'client'}` : null, at: signOff?.at ?? e.finalSignedOffAt });
    const released = audit('gate.G5.passed')[0];
    if (released) {
      const n = (released.after as { filesReleased?: number } | null)?.filesReleased;
      push({ id: `rel-${released.id}`, kind: 'files_released', title: 'Final files released', detail: n ? `${n} file${n === 1 ? '' : 's'} ready to download` : null, at: released.at });
    }
    const g5 = released?.at ?? (e.status === 'delivered' || e.status === 'closed' ? (e.finalSignedOffAt ?? null) : null);

    // Planned dates per gate
    const balance = invoices.find((i) => i.kind === 'project_balance');
    const dueMax = maxDate(deliverables.map((d) => d.dueAt));
    const planned: Record<string, Date | null> = {
      G1: null,
      G2: planningDue,
      G3: g2 ? addWorkingDays(g2, 1, holidays) : planningDue ? addWorkingDays(planningDue, 1, holidays) : null,
      G4: dueMax ?? (latest?.firstDraftDue ? addWorkingDays(latest.firstDraftDue, 3, holidays) : null),
      G5: null,
    };
    planned.G5 = balance?.dueDate ?? (g4 ?? planned.G4 ? addWorkingDays((g4 ?? planned.G4)!, 5, holidays) : null);
    const passed: Record<string, Date | null> = { G1: g1, G2: g2, G3: g3, G4: g4, G5: g5 };
    const details: Record<string, string | null> = {
      G1: planningDue ? `Project clock started; plan due ${fmtDay(planningDue)}` : 'Every requirement received; project clock started',
      G2: g2By ? `Approved by ${g2By}` : null,
      G3: tasks.length ? `${tasks.length} tasks assigned to the team` : 'Team assigned to the work',
      G4: deliverables.length ? `${deliverables.filter((d) => ['approved', 'scheduled', 'published'].includes(d.status)).length} of ${deliverables.length} deliverables approved` : null,
      G5: e.billingType === 'one_time' ? 'Sign-off and balance received, files released' : 'Final sign-off',
    };
    const currentIdx = JOURNEY_GATES.findIndex((g) => !passed[g.gate]);
    JOURNEY_GATES.forEach((g, i) => {
      // A gate passed later than a following gate keeps its own date; gates after the first open one are upcoming.
      const at = i < currentIdx || currentIdx === -1 ? passed[g.gate] : null;
      push({ id: `gate-${g.gate}`, kind: 'gate', gate: g.gate, title: g.name, detail: at || i === currentIdx ? details[g.gate] : null, at, plannedAt: planned[g.gate] });
    });

    // Order, then derive state and timing.
    const visible = drafts.filter((d) => internalOk || !d.internal);
    const done = visible.filter((d) => d.at).sort((a, b) => a.at!.getTime() - b.at!.getTime() || (a.gate ? 1 : 0) - (b.gate ? 1 : 0));
    const future = visible.filter((d) => !d.at);
    const events: FlowJourneyEvent[] = [...done, ...future].map((d) => {
      const isCurrent = !d.at && d.gate === JOURNEY_GATES[currentIdx]?.gate;
      const p = d.plannedAt ?? null;
      let varianceDays: number | null = null;
      if (p && d.at) varianceDays = istDayDiff(p, d.at);
      else if (p && !d.at && p < now) varianceDays = istDayDiff(p, now);
      let timing: FlowJourneyEvent['timing'] = varianceDays === null ? null : varianceDays > 0 ? 'late' : varianceDays < 0 ? (d.at ? 'early' : null) : d.at ? 'on_time' : null;
      // Production is due to start within a working day of plan approval; starting sooner is simply on time.
      if (d.gate === 'G3' && timing === 'early') timing = 'on_time';
      return {
        ...d,
        at: d.at?.toISOString() ?? null,
        plannedAt: p?.toISOString() ?? null,
        state: d.at ? 'done' : isCurrent ? 'current' : 'upcoming',
        timing,
        varianceDays: timing ? varianceDays : null,
      };
    });

    let prevAt: Date = started;
    const gates: FlowJourneyGate[] = JOURNEY_GATES.map((g, i) => {
      const at = i < currentIdx || currentIdx === -1 ? passed[g.gate] : null;
      const out = { gate: g.gate, name: g.name, passedAt: at?.toISOString() ?? null, plannedAt: planned[g.gate]?.toISOString() ?? null, daysFromPrevious: at ? Math.max(0, istDayDiff(prevAt, at)) : null };
      if (at) prevAt = at;
      return out;
    });

    const cur = JOURNEY_GATES[currentIdx];
    const curEvent = events.find((x) => x.state === 'current');
    const summary =
      currentIdx === -1
        ? `All five milestones done. ${g5 ? `Delivered ${istDayDiff(started, g5)} days after onboarding started.` : ''}`.trim()
        : `Now working on milestone ${currentIdx + 1} of 5: ${cur.name}.${curEvent?.timing === 'late' ? ` Running ${curEvent.varianceDays} day${curEvent.varianceDays === 1 ? '' : 's'} behind plan.` : curEvent?.plannedAt ? ` Expected by ${fmtDay(curEvent.plannedAt)}.` : ''}`;

    return {
      engagement: { id: e.id, serviceName: e.service.name, tier: e.tier, billingType: e.billingType, status: e.status, currentGate: e.currentGate, clientName: e.clientOrg.name, startDate: started.toISOString() },
      gates,
      events,
      summary,
    };
  }
}
