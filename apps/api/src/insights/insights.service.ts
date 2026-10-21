import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  LEAD_STAGES,
  leadStageLabels,
  type CapacityView,
  type ClientHealthRow,
  type CollectionsView,
  type HealthRisk,
  type Me,
  type MonthPoint,
  type QualityView,
  type RevenuePeriod,
  type RevenueView,
  type WeeklyReviewView,
  type NewClientRow,
  type NewClientsView,
} from '@bmu/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertCommand, assertMoney, canSeeMoney, canWriteFinance, seesAllDepartments } from './access.js';
import { DAY, daysBetween, dayLabel, monthKey, monthLabel, startOfDay, startOfFy, startOfMonth, startOfQuarter, startOfWeek } from './ist.js';
import { isBillable, loadLedger, revenueBucket, type LedgerInvoice } from './ledger.js';

const OPEN_TASK = { notIn: ['done', 'cancelled'] as ('done' | 'cancelled')[] };
const WEEK_HOURS = 45;
const OVERLOAD_AT = 8;
/** Engagement states that count as a live retainer for MRR. */
const LIVE_RETAINER = ['onboarding', 'blocked', 'planning', 'awaiting_plan_approval', 'in_production', 'in_review', 'delivered', 'active_retainer'] as const;
const ACTIVE_ENGAGEMENT = [...LIVE_RETAINER, 'awaiting_final_payment'] as const;

const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : null);

@Injectable()
export class InsightsService {
  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Money building blocks

  private async creditNotes(orgId: string) {
    return this.prisma.creditNote.findMany({ where: { orgId } });
  }

  /** Invoiced (after credit notes) and collected per month, oldest first. */
  private monthSeries(ledger: LedgerInvoice[], notes: { createdAt: Date; totalPaise: number }[], from: Date, months: number): MonthPoint[] {
    const out: MonthPoint[] = [];
    for (let k = 0; k < months; k++) {
      const start = startOfMonth(from, k);
      const end = startOfMonth(from, k + 1);
      const inRange = (d: Date) => d >= start && d < end;
      const invoiced =
        ledger.filter((i) => isBillable(i) && inRange(i.createdAt)).reduce((s, i) => s + i.totalPaise, 0) -
        notes.filter((n) => inRange(n.createdAt)).reduce((s, n) => s + n.totalPaise, 0);
      const collected = ledger.flatMap((i) => i.payments).filter((p) => inRange(p.at)).reduce((s, p) => s + p.amountPaise, 0);
      out.push({ month: monthKey(start), label: monthLabel(start), invoicedPaise: invoiced, collectedPaise: collected });
    }
    return out;
  }

  private revenueBetween(ledger: LedgerInvoice[], notes: { createdAt: Date; amountPaise: number }[], start: Date, end: Date) {
    const inRange = (d: Date) => d >= start && d < end;
    return (
      ledger.filter((i) => isBillable(i) && inRange(i.createdAt)).reduce((s, i) => s + i.subtotalPaise, 0) -
      notes.filter((n) => inRange(n.createdAt)).reduce((s, n) => s + n.amountPaise, 0)
    );
  }

  // -------------------------------------------------------------------------
  // Weekly Review

  /** v33: clients added recently and who added them (Founder, Branch Manager, CM Lead, Finance). */
  async newClients(me: Me): Promise<NewClientsView> {
    assertCommand(me);
    if (!seesAllDepartments(me)) throw new ForbiddenException('New clients are for the Founder, Branch Manager, CM Lead and Finance');
    const days = 30;
    const events = await this.prisma.auditEvent.findMany({
      where: { orgId: me.orgId, entity: 'ClientOrg', action: { in: ['client.created', 'client.migrated', 'client.converted_from_lead'] }, at: { gte: new Date(Date.now() - days * DAY) } },
      orderBy: { at: 'desc' },
      take: 50,
      select: { entityId: true, actorId: true, action: true, at: true },
    });
    const clientIds = [...new Set(events.map((e) => e.entityId))];
    const [clients, engs] = await Promise.all([
      this.prisma.clientOrg.findMany({ where: { id: { in: clientIds }, orgId: me.orgId, deletedAt: null }, select: { id: true, name: true, amUserId: true } }),
      this.prisma.engagement.groupBy({ by: ['clientOrgId'], where: { clientOrgId: { in: clientIds }, deletedAt: null }, _count: { _all: true } }),
    ]);
    const userIds = [...new Set([...events.map((e) => e.actorId), ...clients.map((c) => c.amUserId)].filter((x): x is string => !!x))];
    const users = await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, roles: { select: { role: { select: { baseRole: true } } } } } });
    const roleLabel = (roles: string[]) =>
      roles.includes('founder') ? 'Founder' : roles.includes('admin') ? 'Branch Manager' : roles.includes('am_lead') ? 'CM Lead' : roles.includes('sales_manager') ? 'Sales Manager' : roles.includes('account_manager') ? 'Client Manager' : 'Team';
    const seen = new Set<string>();
    const rows: NewClientRow[] = [];
    for (const e of events) {
      const c = clients.find((x) => x.id === e.entityId);
      if (!c || seen.has(c.id)) continue;
      seen.add(c.id);
      const by = users.find((u) => u.id === e.actorId);
      const cm = users.find((u) => u.id === c.amUserId);
      rows.push({
        id: c.id,
        name: c.name,
        addedAt: e.at.toISOString(),
        how: e.action === 'client.migrated' ? 'migrated' : e.action === 'client.converted_from_lead' ? 'from_lead' : 'new',
        addedBy: by ? { id: by.id, name: by.name, role: roleLabel(by.roles.map((r) => r.role.baseRole)) } : null,
        cm: cm ? { id: cm.id, name: cm.name } : null,
        services: engs.find((g) => g.clientOrgId === c.id)?._count._all ?? 0,
      });
    }
    return { days, rows: rows.slice(0, 20), total: rows.length, byCm: rows.filter((r) => r.addedBy?.role === 'Client Manager').length };
  }

  async weekly(me: Me): Promise<WeeklyReviewView> {
    assertCommand(me);
    const orgId = me.orgId;
    const now = new Date();
    const weekStart = startOfWeek(now);
    const weekEnd = startOfWeek(now, 1);

    const [activeClients, leads, overdueTasks, blocked, requests, qc, health] = await Promise.all([
      this.prisma.clientOrg.count({ where: { orgId, deletedAt: null, engagements: { some: { deletedAt: null, status: { in: [...ACTIVE_ENGAGEMENT] } } } } }),
      this.prisma.lead.groupBy({ by: ['stage'], where: { orgId, deletedAt: null }, _count: true }),
      this.prisma.task.count({ where: { orgId, status: OPEN_TASK, deadline: { lt: now } } }),
      this.prisma.task.findMany({ where: { orgId, status: 'blocked' }, include: { owner: { select: { name: true } } }, orderBy: { updatedAt: 'asc' }, take: 6 }),
      this.prisma.request.findMany({
        where: { orgId, slaDue: { not: null, lt: weekEnd } },
        include: { engagement: { select: { clientOrg: { select: { name: true } } } } },
        orderBy: { slaDue: 'asc' },
      }),
      this.prisma.qCResult.findMany({ where: { orgId, createdAt: { gte: weekStart, lt: weekEnd } }, select: { result: true } }),
      this.health(orgId),
    ]);

    const breaches = requests.filter((r) => r.slaDue! >= weekStart && (r.firstReplyAt ? r.firstReplyAt > r.slaDue! : r.slaDue! < now));
    const pastSla = requests.filter((r) => !r.firstReplyAt && r.slaDue! < now && !['done', 'declined'].includes(r.status));
    const count = (stage: string) => leads.find((l) => l.stage === stage)?._count ?? 0;

    let money: WeeklyReviewView['money'] = null;
    let overdueInvoices: WeeklyReviewView['attention']['overdueInvoices'] = null;
    if (canSeeMoney(me)) {
      const [ledger, notes] = await Promise.all([loadLedger(this.prisma, orgId), this.creditNotes(orgId)]);
      const thisMonth = startOfMonth(now);
      const series = this.monthSeries(ledger, notes, startOfMonth(now, -5), 6);
      money = {
        revenueThisMonthPaise: this.revenueBetween(ledger, notes, thisMonth, startOfMonth(now, 1)),
        revenueLastMonthPaise: this.revenueBetween(ledger, notes, startOfMonth(now, -1), thisMonth),
        collectedThisMonthPaise: series.at(-1)!.collectedPaise,
        outstandingPaise: ledger.reduce((s, i) => s + i.balancePaise, 0),
        byMonth: series,
      };
      overdueInvoices = ledger
        .filter((i) => i.displayStatus === 'overdue')
        .sort((a, b) => b.daysOverdue - a.daysOverdue)
        .slice(0, 6)
        .map((i) => ({ id: i.id, number: i.number, client: i.clientOrg?.name ?? '—', balancePaise: i.balancePaise, daysOverdue: i.daysOverdue }));
    }

    return {
      money,
      activeClients,
      openLeads: leads.filter((l) => l.stage !== 'won' && l.stage !== 'lost').reduce((s, l) => s + l._count, 0),
      overdueTasks,
      slaBreachesThisWeek: breaches.length,
      qcPassRate: pct(qc.filter((q) => q.result === 'pass').length, qc.length),
      qcChecksThisWeek: qc.length,
      pipeline: LEAD_STAGES.map((stage) => ({ stage, label: leadStageLabels[stage], count: count(stage) })),
      attention: {
        overdueInvoices,
        atRiskClients: health
          .filter((h) => h.risk !== 'healthy')
          .slice(0, 6)
          .map((h) => ({ id: h.id, name: h.name, score: h.score, reasons: h.reasons })),
        blockedTasks: blocked.map((t) => ({ id: t.id, title: t.title, owner: t.owner?.name ?? null, reason: t.blockedReason, deliverableId: t.deliverableId })),
        slaRequests: pastSla.slice(0, 6).map((r) => ({ id: r.id, client: r.engagement.clientOrg.name, type: r.type, description: r.description, slaDue: r.slaDue!.toISOString() })),
      },
    };
  }

  // -------------------------------------------------------------------------
  // Revenue

  async revenue(me: Me, period: RevenuePeriod): Promise<RevenueView> {
    assertMoney(me);
    const orgId = me.orgId;
    const now = new Date();
    const start = period === 'fy' ? startOfFy(now) : period === 'quarter' ? startOfQuarter(now) : startOfMonth(now);
    const end = startOfMonth(now, 1);
    const [ledger, notes, retainers] = await Promise.all([
      loadLedger(this.prisma, orgId),
      this.creditNotes(orgId),
      this.prisma.engagement.findMany({
        where: { orgId, deletedAt: null, billingType: 'monthly', status: { in: [...LIVE_RETAINER] } },
        include: { clientOrg: { select: { name: true } }, service: { select: { name: true, tiers: true } } },
      }),
    ]);
    const inRange = (d: Date) => d >= start && d < end;
    const billable = ledger.filter((i) => isBillable(i) && inRange(i.createdAt));
    const periodNotes = notes.filter((n) => inRange(n.createdAt));
    const byInvoice = new Map(ledger.map((i) => [i.id, i]));

    const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
    const service = new Map<string, number>();
    const client = new Map<string, number>();
    const clientNames = new Map<string, string>();
    const split = new Map<string, number>();
    const tally = (i: LedgerInvoice, v: number) => {
      add(service, i.engagement?.service.name ?? (i.kind === 'addon' ? 'Add-ons' : 'Not linked to a service'), v);
      const cid = i.clientOrgId ?? 'none';
      clientNames.set(cid, i.clientOrg?.name ?? 'No client yet');
      add(client, cid, v);
      add(split, revenueBucket(i), v);
    };
    for (const i of billable) tally(i, i.subtotalPaise);
    for (const n of periodNotes) {
      const i = byInvoice.get(n.invoiceId);
      if (i) tally(i, -n.amountPaise);
    }
    const sorted = (m: Map<string, number>) => [...m.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);

    const retainerRows = retainers.map((e) => ({
      engagementId: e.id,
      client: e.clientOrg.name,
      service: e.service.name,
      tier: e.tier,
      pricePaise: e.service.tiers.find((t) => t.tier === e.tier)?.pricePaise ?? 0,
    }));
    const months = period === 'fy' ? Math.max(1, daysToMonths(startOfFy(now), now)) : 6;
    const periodLabel = period === 'month' ? monthLabel(start, true) : period === 'quarter' ? `${monthLabel(start)}–${monthLabel(startOfMonth(start, 2), true)}` : `FY ${monthLabel(start, true)} – now`;

    return {
      period,
      periodLabel,
      invoicedPaise: billable.reduce((s, i) => s + i.totalPaise, 0) - periodNotes.reduce((s, n) => s + n.totalPaise, 0),
      revenuePaise: billable.reduce((s, i) => s + i.subtotalPaise, 0) - periodNotes.reduce((s, n) => s + n.amountPaise, 0),
      collectedPaise: ledger.flatMap((i) => i.payments).filter((p) => inRange(p.at)).reduce((s, p) => s + p.amountPaise, 0),
      gstPaise: billable.reduce((s, i) => s + i.gstPaise, 0) - periodNotes.reduce((s, n) => s + n.gstPaise, 0),
      creditNotesPaise: periodNotes.reduce((s, n) => s + n.totalPaise, 0),
      mrrPaise: retainerRows.reduce((s, r) => s + r.pricePaise, 0),
      activeRetainers: retainerRows.length,
      retainers: retainerRows.sort((a, b) => b.pricePaise - a.pricePaise),
      byMonth: this.monthSeries(ledger, notes, startOfMonth(now, -(months - 1)), months),
      byService: sorted(service).map(([label, valuePaise]) => ({ label, valuePaise })),
      byClient: sorted(client).map(([id, valuePaise]) => ({ id, label: clientNames.get(id)!, valuePaise })),
      split: ['Retainers', 'Projects', 'Add-ons', 'Other'].map((label) => ({ label, valuePaise: Math.max(0, split.get(label) ?? 0) })),
    };
  }

  // -------------------------------------------------------------------------
  // Collections

  async collections(me: Me): Promise<CollectionsView> {
    assertMoney(me);
    const now = new Date();
    const ledger = await loadLedger(this.prisma, me.orgId);
    const unpaid = ledger.filter((i) => i.balancePaise > 0);
    const buckets = [
      { label: 'Not yet due', test: (i: LedgerInvoice) => i.daysOverdue === 0 },
      { label: '0–15 days late', test: (i: LedgerInvoice) => i.daysOverdue >= 1 && i.daysOverdue <= 15 },
      { label: '16–30 days late', test: (i: LedgerInvoice) => i.daysOverdue >= 16 && i.daysOverdue <= 30 },
      { label: '31–60 days late', test: (i: LedgerInvoice) => i.daysOverdue >= 31 && i.daysOverdue <= 60 },
      { label: 'Over 60 days late', test: (i: LedgerInvoice) => i.daysOverdue > 60 },
    ];
    const since = startOfMonth(now, -5);
    const paidRecently = ledger.filter((i) => i.status === 'paid' && i.payments.length && i.payments.at(-1)!.at >= since);
    const days = paidRecently.map((i) => Math.max(0, daysBetween(i.createdAt, i.payments.at(-1)!.at)));
    const monthStart = startOfMonth(now);
    return {
      outstandingPaise: unpaid.reduce((s, i) => s + i.balancePaise, 0),
      overduePaise: unpaid.filter((i) => i.daysOverdue > 0).reduce((s, i) => s + i.balancePaise, 0),
      aging: buckets.map((b) => {
        const rows = unpaid.filter(b.test);
        return { label: b.label, valuePaise: rows.reduce((s, i) => s + i.balancePaise, 0), count: rows.length };
      }),
      unpaid: unpaid
        .sort((a, b) => b.daysOverdue - a.daysOverdue || a.dueDate.getTime() - b.dueDate.getTime())
        .map((i) => ({
          id: i.id,
          number: i.number,
          clientId: i.clientOrgId,
          client: i.clientOrg?.name ?? 'No client yet',
          kind: i.kind,
          dueDate: i.dueDate.toISOString(),
          daysOverdue: i.daysOverdue,
          totalPaise: i.totalPaise,
          paidPaise: i.paidPaise,
          balancePaise: i.balancePaise,
        })),
      collectedThisMonthPaise: ledger.flatMap((i) => i.payments).filter((p) => p.at >= monthStart).reduce((s, p) => s + p.amountPaise, 0),
      avgDaysToPay: days.length ? Math.round((days.reduce((s, d) => s + d, 0) / days.length) * 10) / 10 : null,
      canAct: canWriteFinance(me),
    };
  }

  // -------------------------------------------------------------------------
  // Capacity

  async capacity(me: Me): Promise<CapacityView> {
    assertCommand(me);
    const orgId = me.orgId;
    const now = new Date();
    const weekStart = startOfWeek(now);
    const weekEnd = startOfWeek(now, 1);
    let deptFilter: string | undefined;
    if (!seesAllDepartments(me)) {
      const self = await this.prisma.user.findUnique({ where: { id: me.id }, select: { departmentId: true } });
      deptFilter = self?.departmentId ?? '__none__';
    }
    const [users, depts, tasks, attendance] = await Promise.all([
      this.prisma.user.findMany({
        where: { orgId, type: 'staff', status: 'active', deletedAt: null, ...(deptFilter ? { departmentId: deptFilter } : {}) },
        select: { id: true, name: true, departmentId: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.department.findMany({ where: { orgId, deletedAt: null }, select: { id: true, name: true } }),
      this.prisma.task.findMany({
        where: { orgId, ownerId: { not: null }, OR: [{ status: OPEN_TASK }, { updatedAt: { gte: weekStart } }] },
        select: { ownerId: true, status: true, deadline: true, timeLoggedMin: true, updatedAt: true },
      }),
      this.prisma.attendance.findMany({ where: { orgId, date: startOfDayUtcDate(now), checkIn: { not: null } }, select: { userId: true } }),
    ]);
    const deptName = new Map(depts.map((d) => [d.id, d.name]));
    const present = new Set(attendance.map((a) => a.userId));
    const people = users.map((u) => {
      const mine = tasks.filter((t) => t.ownerId === u.id);
      const open = mine.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
      const minutes = mine.filter((t) => t.updatedAt >= weekStart).reduce((s, t) => s + t.timeLoggedMin, 0);
      const hours = Math.round((minutes / 60) * 10) / 10;
      return {
        id: u.id,
        name: u.name,
        department: u.departmentId ? (deptName.get(u.departmentId) ?? null) : null,
        departmentId: u.departmentId,
        openTasks: open.length,
        dueThisWeek: open.filter((t) => t.deadline && t.deadline >= weekStart && t.deadline < weekEnd).length,
        overdue: open.filter((t) => t.deadline && t.deadline < now).length,
        hoursThisWeek: hours,
        utilisation: Math.round((hours / WEEK_HOURS) * 100),
        checkedIn: present.has(u.id),
        flag: open.length > OVERLOAD_AT ? ('overloaded' as const) : open.length === 0 ? ('idle' as const) : null,
      };
    });
    const groups = new Map<string, typeof people>();
    for (const p of people) groups.set(p.departmentId ?? '', [...(groups.get(p.departmentId ?? '') ?? []), p]);
    const departments = [...groups.entries()]
      .map(([id, ps]) => {
        const hours = ps.reduce((s, p) => s + p.hoursThisWeek, 0);
        return {
          id: id || null,
          name: id ? (deptName.get(id) ?? 'Department') : 'No department',
          people: ps.length,
          openTasks: ps.reduce((s, p) => s + p.openTasks, 0),
          dueThisWeek: ps.reduce((s, p) => s + p.dueThisWeek, 0),
          overdue: ps.reduce((s, p) => s + p.overdue, 0),
          hoursThisWeek: Math.round(hours * 10) / 10,
          utilisation: Math.round((hours / (WEEK_HOURS * ps.length)) * 100),
          checkedIn: ps.filter((p) => p.checkedIn).length,
        };
      })
      .sort((a, b) => b.openTasks - a.openTasks || a.name.localeCompare(b.name));
    return {
      weekHours: WEEK_HOURS,
      overloadAt: OVERLOAD_AT,
      departments,
      people: people.map(({ departmentId: _d, ...p }) => p).sort((a, b) => b.openTasks - a.openTasks || a.name.localeCompare(b.name)),
    };
  }

  // -------------------------------------------------------------------------
  // Quality

  async quality(me: Me): Promise<QualityView> {
    assertCommand(me);
    const orgId = me.orgId;
    const now = new Date();
    const since = startOfWeek(now, -11);
    const [results, depts, deliverables, changeRequests] = await Promise.all([
      this.prisma.qCResult.findMany({
        where: { orgId, createdAt: { gte: since } },
        include: { version: { select: { number: true, deliverableId: true, deliverable: { select: { departmentId: true, flowKey: true, type: true } } } } },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.department.findMany({ where: { orgId }, select: { id: true, name: true } }),
      this.prisma.deliverable.findMany({ where: { orgId, versions: { some: {} } }, select: { revisionRoundsUsed: true } }),
      this.prisma.request.count({ where: { orgId, type: 'change', createdAt: { gte: since } } }),
    ]);
    const deptName = new Map(depts.map((d) => [d.id, d.name]));
    const group = (key: (r: (typeof results)[number]) => string) => {
      const m = new Map<string, { checks: number; pass: number }>();
      for (const r of results) {
        const k = key(r);
        const g = m.get(k) ?? { checks: 0, pass: 0 };
        g.checks++;
        if (r.result === 'pass') g.pass++;
        m.set(k, g);
      }
      return [...m.entries()].map(([label, g]) => ({ label, checks: g.checks, passRate: pct(g.pass, g.checks) ?? 0 })).sort((a, b) => b.checks - a.checks);
    };
    // First-time right: the first QC on version 1 of a deliverable passed.
    const firstOnV1 = new Map<string, boolean>();
    for (const r of results) if (r.version.number === 1 && !firstOnV1.has(r.version.deliverableId)) firstOnV1.set(r.version.deliverableId, r.result === 'pass');
    const failures = new Map<string, number>();
    for (const r of results) {
      const list = ((r.items as { list?: { label: string; ok: boolean }[] } | null)?.list ?? []).filter((i) => i && i.ok === false);
      for (const i of list) failures.set(i.label, (failures.get(i.label) ?? 0) + 1);
    }
    const trend: QualityView['trend'] = [];
    for (let w = -11; w <= 0; w++) {
      const s = startOfWeek(now, w);
      const e = startOfWeek(now, w + 1);
      const inWeek = results.filter((r) => r.createdAt >= s && r.createdAt < e);
      trend.push({ week: s.toISOString(), label: dayLabel(s), checks: inWeek.length, passRate: pct(inWeek.filter((r) => r.result === 'pass').length, inWeek.length) });
    }
    return {
      checks: results.length,
      passRate: pct(results.filter((r) => r.result === 'pass').length, results.length),
      firstTimeRight: pct([...firstOnV1.values()].filter(Boolean).length, firstOnV1.size),
      avgRevisionRounds: deliverables.length ? Math.round((deliverables.reduce((s, d) => s + d.revisionRoundsUsed, 0) / deliverables.length) * 10) / 10 : null,
      clientChangeRequests: changeRequests,
      byDepartment: group((r) => (r.version.deliverable.departmentId ? (deptName.get(r.version.deliverable.departmentId) ?? 'Department') : 'No department')),
      byFlow: group((r) => r.version.deliverable.flowKey ?? r.version.deliverable.type),
      topFailures: [...failures.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label, count]) => ({ label, count })),
      trend,
    };
  }

  // -------------------------------------------------------------------------
  // Client health

  async clientHealth(me: Me): Promise<ClientHealthRow[]> {
    assertCommand(me);
    return this.health(me.orgId);
  }

  /** Score 0–100 per client: starts at 100, loses points for each problem, with the reasons spelled out. */
  private async health(orgId: string): Promise<ClientHealthRow[]> {
    const now = new Date();
    const [clients, invoices, requests, deliverables, requirements, messages, approvals] = await Promise.all([
      this.prisma.clientOrg.findMany({
        where: { orgId, deletedAt: null },
        include: { am: { select: { name: true } }, users: { select: { userId: true } }, engagements: { where: { deletedAt: null }, select: { id: true, status: true } } },
        orderBy: { name: 'asc' },
      }),
      loadLedger(this.prisma, orgId, { clientOrgId: { not: null } }),
      this.prisma.request.findMany({
        where: { orgId, slaDue: { not: null, gte: new Date(now.getTime() - 30 * DAY), lt: now } },
        select: { slaDue: true, firstReplyAt: true, engagement: { select: { clientOrgId: true } } },
      }),
      this.prisma.deliverable.findMany({
        where: { orgId },
        select: { revisionRoundsUsed: true, cycle: { select: { engagement: { select: { clientOrgId: true, tier: true, service: { select: { tiers: { select: { tier: true, revisionRounds: true } } } } } } } } },
      }),
      this.prisma.requirementItem.findMany({ where: { orgId, status: 'blocked' }, select: { cycle: { select: { engagement: { select: { clientOrgId: true } } } } } }),
      this.prisma.message.findMany({
        where: { orgId, isInternal: false },
        select: { authorId: true, createdAt: true, thread: { select: { clientOrgId: true } } },
        orderBy: { createdAt: 'desc' },
        take: 2000,
      }),
      this.prisma.approval.findMany({ where: { orgId }, select: { userId: true, at: true }, orderBy: { at: 'desc' }, take: 2000 }),
    ]);
    // v10: client satisfaction on finished requests (thumbs down in the last 90 days costs points).
    const ratings = await this.prisma.request.findMany({ where: { orgId, rating: { not: null }, ratedAt: { gte: new Date(now.getTime() - 90 * DAY) } }, select: { rating: true, engagement: { select: { clientOrgId: true } } } });
    // v10 deliver: client feedback (0-10) from the final delivery step.
    const feedback = await this.prisma.deliverFeedback.findMany({ where: { orgId }, select: { clientOrgId: true, score: true }, orderBy: { createdAt: 'desc' } });
    // v10 AI Copilot: unhappy client messages/requests flagged by the tone check in the last 30 days.
    const toneFlags = await this.prisma.aiSignal.groupBy({ by: ['clientOrgId'], where: { orgId, tone: 'negative', createdAt: { gte: new Date(now.getTime() - 30 * DAY) } }, _count: { _all: true } });

    return clients
      .map((c) => {
        const reasons: string[] = [];
        let score = 100;
        const lose = (pts: number, why: string) => {
          if (pts <= 0) return;
          score -= pts;
          reasons.push(why);
        };
        const clientUserIds = new Set(c.users.map((u) => u.userId));

        const overdue = invoices.filter((i) => i.clientOrgId === c.id && i.displayStatus === 'overdue');
        lose(Math.min(30, overdue.length * 15), `${overdue.length} overdue invoice${overdue.length === 1 ? '' : 's'}`);

        const breaches = requests.filter((r) => r.engagement.clientOrgId === c.id && (r.firstReplyAt ? r.firstReplyAt > r.slaDue! : true));
        lose(Math.min(20, breaches.length * 10), `${breaches.length} reply time${breaches.length === 1 ? '' : 's'} missed in 30 days`);

        const over = deliverables.filter((d) => {
          const e = d.cycle.engagement;
          if (e.clientOrgId !== c.id) return false;
          const included = e.service.tiers.find((t) => t.tier === e.tier)?.revisionRounds ?? 2;
          return d.revisionRoundsUsed > included;
        });
        lose(Math.min(15, over.length * 5), `${over.length} deliverable${over.length === 1 ? '' : 's'} past included revisions`);

        const unhappy = ratings.filter((r) => r.engagement.clientOrgId === c.id && (r.rating ?? 0) < 0).length;
        lose(Math.min(15, unhappy * 5), `${unhappy} request${unhappy === 1 ? '' : 's'} rated thumbs down in 90 days`);

        const blocked = requirements.filter((r) => r.cycle.engagement.clientOrgId === c.id);
        lose(Math.min(15, blocked.length * 5), `${blocked.length} blocked requirement${blocked.length === 1 ? '' : 's'}`);

        const lastMsg = messages.find((m) => m.thread.clientOrgId === c.id && clientUserIds.has(m.authorId))?.createdAt;
        const lastApproval = approvals.find((a) => clientUserIds.has(a.userId))?.at;
        const last = [lastMsg, lastApproval].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
        const quietDays = last ? daysBetween(last, now) : c.tenureStart ? daysBetween(c.tenureStart, now) : daysBetween(c.createdAt, now);
        if (quietDays > 30) lose(20, last ? `No reply or approval from the client in ${quietDays} days` : 'Client has not replied or approved anything yet');
        else if (quietDays > 14) lose(10, last ? `No reply or approval from the client in ${quietDays} days` : 'Client has not replied or approved anything yet');

        const latestScore = feedback.find((f) => f.clientOrgId === c.id)?.score;
        if (latestScore !== undefined && latestScore <= 6) lose(15, `Client rated us ${latestScore}/10`);
        else if (latestScore !== undefined && latestScore <= 8) lose(5, `Client rated us ${latestScore}/10`);
        const sour = toneFlags.find((u) => u.clientOrgId === c.id)?._count._all ?? 0;
        lose(Math.min(15, sour * 5), `${sour} unhappy client message${sour === 1 ? '' : 's'} in 30 days (tone flag)`);

        const statuses = c.engagements.map((e) => e.status);
        if (statuses.includes('offboarding')) lose(20, 'Offboarding');
        if (statuses.includes('blocked')) lose(10, 'Work is blocked');
        if (statuses.includes('paused')) lose(10, 'Engagement paused');
        const active = statuses.filter((s) => (ACTIVE_ENGAGEMENT as readonly string[]).includes(s)).length;
        if (!active && !statuses.includes('pending_payment')) lose(10, 'No active engagement');

        score = Math.max(0, Math.min(100, score));
        const risk: HealthRisk = score >= 75 ? 'healthy' : score >= 50 ? 'watch' : 'at_risk';
        return {
          id: c.id,
          name: c.name,
          am: c.am?.name ?? null,
          score,
          risk,
          reasons,
          activeEngagements: active,
          overdueInvoices: overdue.length,
          lastClientActivityAt: last ? last.toISOString() : null,
        };
      })
      .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  }
}

/** Attendance.date is a DATE column: today's IST calendar date at UTC midnight. */
function startOfDayUtcDate(now: Date) {
  const d = startOfDay(now);
  const ist = new Date(d.getTime() + 330 * 60_000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}

function daysToMonths(from: Date, to: Date) {
  let n = 0;
  while (startOfMonth(from, n) <= to) n++;
  return n;
}
