// v10 deliver: monthly retainer cycles that roll over.
// For active retainers the month's Cycle is created automatically (job) or by the AM ("Start next month"):
// deliverables from the tier's monthly quota (+ unused quota carried over), a draft plan to approve (the normal
// plan flow → tasks), and the month's retainer invoice. Idempotent: one cycle per engagement per month.
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import {
  addWorkingDays,
  deliverNextPeriod,
  deliverPeriodLabel,
  deliverQuotaFor,
  istDate,
  planContentSchema,
  type DeliverCycleSummary,
  type DeliverCyclesView,
  type DeliverQuotaItem,
  type DeliverRetainerRun,
  type Me,
  type PlanContent,
} from '@bmu/shared';
import { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { BillingService } from '../requests/billing.service.js';
import { isLeadership, visibleEngagementWhere } from '../engagements/engagement-access.js';

/** Statuses of a retainer that is running (new months start automatically). */
const RUNNING = ['planning', 'awaiting_plan_approval', 'in_production', 'in_review', 'active_retainer', 'delivered', 'awaiting_final_payment'];
const DONE_D = ['approved', 'scheduled', 'published'];

export const istMonth = (d = new Date()) => istDate(d).slice(0, 7);

type Carry = { type: string; count: number; fromPeriod: string };

@Injectable()
export class DeliverCyclesService implements OnModuleInit {
  private readonly log = new Logger('Retainers');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly billing: BillingService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit() {
    // A paid invoice can release production that Gate 3 held for an overdue invoice.
    this.billing.onPaid(async (inv) => {
      const full = await this.prisma.invoice.findUnique({ where: { id: inv.id }, select: { clientOrgId: true } });
      if (full?.clientOrgId) await this.recheckGate3(full.clientOrgId);
    });
  }

  // -------------------------------------------------------------------------
  // Helpers

  private async quotaFor(serviceId: string, serviceKey: string, tier: string): Promise<DeliverQuotaItem[]> {
    const t = await this.prisma.serviceTier.findUnique({ where: { serviceId_tier: { serviceId, tier: tier as never } }, select: { deliverables: true } });
    return deliverQuotaFor(serviceKey, tier, t?.deliverables ?? []);
  }

  /** Monthly price: the accepted proposal line (after discounts) when there is one, else the tier price. */
  private async monthlyPricePaise(e: { serviceId: string; tier: string; service: { key: string }; clientOrg: { leadId: string | null } }) {
    if (e.clientOrg.leadId) {
      const p = await this.prisma.proposal.findFirst({ where: { leadId: e.clientOrg.leadId, status: 'accepted' }, orderBy: { acceptedAt: 'desc' } });
      const line = (p?.lines as { kind?: string; key?: string; netPaise?: number }[] | undefined)?.find((l) => l.kind === 'service' && l.key === e.service.key);
      if (line?.netPaise) return line.netPaise;
    }
    const tier = await this.prisma.serviceTier.findUnique({ where: { serviceId_tier: { serviceId: e.serviceId, tier: e.tier as never } } });
    return tier?.pricePaise ?? 0;
  }

  private async overdueInvoices(clientOrgId: string, excludeId?: string) {
    return this.prisma.invoice.findMany({
      where: {
        clientOrgId,
        ...(excludeId ? { id: { not: excludeId } } : {}),
        OR: [{ status: 'overdue' }, { status: { in: ['issued', 'partially_paid'] }, dueDate: { lt: new Date() } }],
      },
      select: { number: true },
    });
  }

  private async heldMessage(clientOrgId: string, excludeId?: string) {
    const { blockProductionOnOverdueInvoice } = await this.settings.get((await this.prisma.clientOrg.findUniqueOrThrow({ where: { id: clientOrgId } })).orgId, 'gateRules');
    if (!blockProductionOnOverdueInvoice) return null;
    const overdue = await this.overdueInvoices(clientOrgId, excludeId);
    return overdue.length ? `Production waits until overdue invoice ${overdue.map((i) => i.number).join(', ')} is paid (Gate rules).` : null;
  }

  private canStart(me: Me, e: { amId: string | null }) {
    return me.type === 'staff' && (e.amId === me.id || isLeadership(me));
  }

  // -------------------------------------------------------------------------
  // View

  async view(me: Me, engagementId: string): Promise<DeliverCyclesView> {
    const e = await this.prisma.engagement.findFirst({
      where: { AND: [await visibleEngagementWhere(this.prisma, me), { id: engagementId }] },
      include: {
        service: true,
        clientOrg: true,
        cycles: { orderBy: { period: 'desc' }, take: 12, include: { plans: { orderBy: { id: 'desc' }, take: 1 }, deliverables: { orderBy: { dueAt: 'asc' } } } },
      },
    });
    if (!e) throw new NotFoundException('Engagement not found');
    const isRetainer = e.billingType === 'monthly';
    const quota = isRetainer ? await this.quotaFor(e.serviceId, e.service.key, e.tier) : [];
    const invoiceIds = e.cycles.map((c) => c.invoiceId).filter((x): x is string => !!x);
    const invoices = invoiceIds.length ? await this.prisma.invoice.findMany({ where: { id: { in: invoiceIds } } }) : [];
    const held = isRetainer ? await this.heldMessage(e.clientOrgId) : null;
    const cycles: DeliverCycleSummary[] = e.cycles.map((c, i) => {
      const carried = (c.carriedOver ?? []) as Carry[];
      const planDeliverables = c.plans[0] ? planContentSchema.parse(c.plans[0].content).deliverables : [];
      const counted = c.deliverables.length ? c.deliverables : planDeliverables.map((d) => ({ type: d.type, status: 'planned' }));
      const types = [...new Set([...quota.map((q) => q.type), ...carried.map((x) => x.type)])];
      const rows = types.map((type) => {
        const base = quota.find((q) => q.type === type);
        const extra = carried.filter((x) => x.type === type).reduce((s, x) => s + x.count, 0);
        return {
          type,
          label: base?.label ?? type,
          count: (base?.count ?? 0) + extra,
          planned: counted.filter((d) => d.type === type).length,
          approved: c.deliverables.filter((d) => d.type === type && DONE_D.includes(d.status)).length,
        };
      });
      const inv = invoices.find((x) => x.id === c.invoiceId);
      return {
        id: c.id,
        period: c.period,
        label: deliverPeriodLabel(c.period),
        status: c.status,
        startedBy: c.startedBy,
        startedAt: (c.rcdAt ?? c.createdAt).toISOString(),
        planStatus: c.plans[0]?.status ?? null,
        invoice: inv ? { id: inv.id, number: inv.number, status: inv.status, totalPaise: inv.totalPaise } : null,
        quota: rows,
        carriedOver: carried,
        unused: c.plans[0]?.status === 'approved' ? rows.filter((r) => r.count > r.planned).map((r) => ({ type: r.type, count: r.count - r.planned })) : [],
        deliverables: {
          total: c.deliverables.length,
          approved: c.deliverables.filter((d) => DONE_D.includes(d.status)).length,
          inProgress: c.deliverables.filter((d) => !DONE_D.includes(d.status)).length,
        },
        openDeliverables: c.deliverables
          .filter((d) => !DONE_D.includes(d.status))
          .map((d) => ({ id: d.id, title: d.title, type: d.type, status: d.status, dueAt: d.dueAt?.toISOString() ?? null })),
        heldForPayment: i === 0 ? held : null,
      };
    });
    const latest = e.cycles[0];
    const next = isRetainer && latest && /^\d{4}-\d{2}$/.test(latest.period) ? deliverNextPeriod(latest.period) : isRetainer && latest ? deliverNextPeriod(istMonth()) : null;
    const blocked = !isRetainer
      ? 'One-time projects have a single cycle.'
      : !latest?.rcdAt && e.cycles.length <= 1
        ? 'Finish onboarding (project start date) first.'
        : !RUNNING.includes(e.status)
          ? `This retainer is ${e.status.replace(/_/g, ' ')}.`
          : next && next > deliverNextPeriod(istMonth())
            ? `${deliverPeriodLabel(latest.period)} has already been started. ${deliverPeriodLabel(next)} can be started once ${deliverPeriodLabel(latest.period)} begins.`
            : null;
    return { engagementId: e.id, billingType: e.billingType, isRetainer, cycles, nextPeriod: next, can: { startNext: !blocked && this.canStart(me, e) }, startNextBlocked: blocked };
  }

  // -------------------------------------------------------------------------
  // Start a month

  async startNext(me: Me, engagementId: string, ip?: string): Promise<DeliverCyclesView> {
    const v = await this.view(me, engagementId);
    const e = await this.prisma.engagement.findUniqueOrThrow({ where: { id: engagementId } });
    if (!this.canStart(me, e)) throw new ForbiddenException("Only the client's Account Manager or leadership can start the next month");
    if (v.startNextBlocked || !v.nextPeriod) throw new BadRequestException(v.startNextBlocked ?? 'Nothing to start');
    const res = await this.createCycle(engagementId, v.nextPeriod, 'manual', me);
    if (!res) throw new BadRequestException(`${deliverPeriodLabel(v.nextPeriod)} has already been started`);
    await this.audit.log(me, 'cycle.started', 'Engagement', engagementId, undefined, { period: v.nextPeriod, invoice: res.invoiceNumber, startedBy: 'manual' }, ip);
    return this.view(me, engagementId);
  }

  /** Scheduled job: every running retainer gets this month's cycle if it doesn't have one yet. */
  async runAuto(now = new Date(), only?: string[], onlyOrgId?: string): Promise<DeliverRetainerRun> {
    const month = istMonth(now);
    const rows = await this.prisma.engagement.findMany({
      where: { billingType: 'monthly', deletedAt: null, status: { in: RUNNING as never[] }, ...(only ? { id: { in: only } } : {}), ...(onlyOrgId ? { orgId: onlyOrgId } : {}) },
      include: { clientOrg: { select: { name: true } }, cycles: { orderBy: { period: 'desc' }, take: 1, select: { period: true, rcdAt: true } } },
    });
    const out: DeliverRetainerRun = { created: [], skipped: 0 };
    for (const e of rows) {
      const latest = e.cycles[0];
      if (!latest?.rcdAt || !/^\d{4}-\d{2}$/.test(latest.period) || latest.period >= month) {
        out.skipped++;
        continue;
      }
      try {
        const res = await this.createCycle(e.id, month, 'auto');
        if (res) {
          out.created.push({ engagementId: e.id, client: e.clientOrg.name, period: month, invoiceNumber: res.invoiceNumber });
          await this.audit.logSystem(e.orgId, 'cycle.started', 'Engagement', e.id, { period: month, invoice: res.invoiceNumber, startedBy: 'auto' });
        } else out.skipped++;
      } catch (err) {
        this.log.warn(`Could not start ${month} for engagement ${e.id}: ${(err as Error).message}`);
      }
    }
    if (out.created.length) this.log.log(`Started ${out.created.length} retainer month(s) for ${month}`);
    return out;
  }

  /** Creates the cycle, draft plan, planning task and invoice. Returns null when the month already exists. */
  async createCycle(engagementId: string, period: string, startedBy: 'auto' | 'manual', actor?: Me) {
    const e = await this.prisma.engagement.findUniqueOrThrow({
      where: { id: engagementId },
      include: { service: true, clientOrg: true, cycles: { orderBy: { period: 'desc' }, take: 1, include: { plans: { orderBy: { id: 'desc' }, take: 1 }, deliverables: { select: { type: true } } } } },
    });
    const prev = e.cycles[0];
    const quota = await this.quotaFor(e.serviceId, e.service.key, e.tier);
    // Unused quota from last month rolls over (capped at one month's quota per type).
    const carried: Carry[] = [];
    if (prev && /^\d{4}-\d{2}$/.test(prev.period)) {
      const prevCarry = (prev.carriedOver ?? []) as Carry[];
      const planned = prev.deliverables.length ? prev.deliverables : prev.plans[0] ? planContentSchema.parse(prev.plans[0].content).deliverables : [];
      for (const q of quota) {
        const allowed = q.count + prevCarry.filter((c) => c.type === q.type).reduce((s, c) => s + c.count, 0);
        const unused = Math.min(q.count, Math.max(0, allowed - planned.filter((d) => d.type === q.type).length));
        if (unused > 0) carried.push({ type: q.type, count: unused, fromPeriod: prev.period });
      }
    }
    const month = new Date(`${period}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' });
    const items = [...quota.map((q) => ({ ...q, carried: false })), ...carried.map((c) => ({ type: c.type, label: quota.find((q) => q.type === c.type)?.label ?? c.type, count: c.count, carried: true }))];
    const total = items.reduce((s, i) => s + i.count, 0);
    let k = 0;
    const deliverables: PlanContent['deliverables'] = [];
    for (const it of items) {
      for (let i = 1; i <= it.count; i++) {
        k++;
        const day = Math.min(28, Math.max(3, Math.round((k * 27) / (total + 1)) + 1));
        deliverables.push({ type: it.type, title: `${it.label.replace(/s$/, '')} ${i} · ${month}${it.carried ? ' (carried over)' : ''}`, due: `${period}-${String(day).padStart(2, '0')}` });
      }
    }
    const content: PlanContent = {
      objectives: `${e.service.name} for ${deliverPeriodLabel(period)}.`,
      audience: '',
      pillars: [],
      creativeDirection: '',
      deliverables,
    };

    const holidays = ((await this.prisma.organisation.findUniqueOrThrow({ where: { id: e.orgId }, select: { settings: true } })).settings as { holidays?: string[] }).holidays ?? [];
    const { planDeadlineWorkingDays } = await this.settings.get(e.orgId, 'gateRules');
    const now = new Date();
    const startAt = period > istMonth(now) ? new Date(`${period}-01T09:30:00+05:30`) : now;
    const planningDue = addWorkingDays(now, planDeadlineWorkingDays, holidays);
    const am = e.amId ? await this.prisma.user.findUnique({ where: { id: e.amId }, select: { teamId: true } }) : null;
    const strategist = am?.teamId
      ? await this.prisma.user.findFirst({ where: { teamId: am.teamId, status: 'active', deletedAt: null, roles: { some: { role: { baseRole: 'strategist' } } } } })
      : null;
    const priceP = await this.monthlyPricePaise(e);
    const [monthStart, monthEnd] = [new Date(`${period}-01T00:00:00+05:30`), new Date(`${deliverNextPeriod(period)}-01T00:00:00+05:30`)];

    let created: { cycleId: string; invoiceId: string | null; invoiceNumber: string | null; invoiceTotal: number };
    try {
      created = await this.prisma.$transaction(async (tx) => {
        // One cycle per engagement per month, even if the job and the AM's button race.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cycle:${engagementId}`}))`;
        if (await tx.cycle.findUnique({ where: { engagementId_period: { engagementId, period } } })) throw new AlreadyStarted();
        const cycle = await tx.cycle.create({
          data: { orgId: e.orgId, engagementId, period, rcdAt: startAt, planningDue, status: 'planning', startedBy, carriedOver: carried as unknown as Prisma.InputJsonValue },
        });
        await tx.plan.create({ data: { orgId: e.orgId, cycleId: cycle.id, content: content as unknown as Prisma.InputJsonValue } });
        await tx.task.create({
          data: {
            orgId: e.orgId,
            title: `Plan ${deliverPeriodLabel(period)}: ${e.service.name} for ${e.clientOrg.name}`,
            flowStep: 'planning',
            kind: 'planning',
            engagementId,
            ownerId: strategist?.id ?? e.amId,
            deadline: planningDue,
          },
        });
        await tx.engagement.update({ where: { id: engagementId }, data: { status: 'planning', currentGate: 'G2' } });
        // The month's retainer invoice, unless one was already issued for this month (e.g. by Finance's billing run).
        // Same lock as Finance's billing run, so the two can never bill one month twice.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${engagementId}:${period}`}))`;
        const retainerInvoices = await tx.invoice.findMany({ where: { engagementId, kind: 'retainer', status: { notIn: ['void', 'credit_noted'] } } });
        const existing =
          retainerInvoices.find((i) => i.period === period) ??
          retainerInvoices.find((i) => JSON.stringify(i.lines).includes(`(${period})`)) ??
          retainerInvoices.find((i) => i.createdAt >= monthStart && i.createdAt < monthEnd && !/\(\d{4}-\d{2}\)/.test(JSON.stringify(i.lines))) ??
          null;
        let inv = existing;
        if (!inv && priceP > 0) {
          inv = await this.billing.issue(tx, {
            orgId: e.orgId,
            clientOrgId: e.clientOrgId,
            engagementId,
            kind: 'retainer',
            lines: [{ label: `${e.service.name} (${e.tier}) retainer for ${deliverPeriodLabel(period)} (${period})`, amountPaise: priceP }],
          });
        }
        if (inv && !existing) await tx.invoice.update({ where: { id: inv.id }, data: { period } });
        if (inv) await tx.cycle.update({ where: { id: cycle.id }, data: { invoiceId: inv.id } });
        return { cycleId: cycle.id, invoiceId: inv?.id ?? null, invoiceNumber: inv?.number ?? null, invoiceTotal: inv?.totalPaise ?? 0, newInvoice: !existing && !!inv };
      });
    } catch (err) {
      if (err instanceof AlreadyStarted) return null;
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
      throw err;
    }

    const held = await this.heldMessage(e.clientOrgId, created.invoiceId ?? undefined);
    if (created.invoiceId) await this.audit.logSystem(e.orgId, 'invoice.issued', 'Invoice', created.invoiceId, { kind: 'retainer', period, totalPaise: created.invoiceTotal });
    const label = deliverPeriodLabel(period);
    await this.notifications.notify(e.orgId, [e.amId, strategist?.id].filter((x) => x !== actor?.id), {
      kind: 'cycle_started',
      title: `${e.clientOrg.name}: ${label} has started`,
      body: `${deliverables.length} deliverables drafted from the ${e.tier} quota${carried.length ? ` (${carried.reduce((s, c) => s + c.count, 0)} carried over)` : ''}. Finish the plan and send it for approval.${held ? ` ${held}` : ''}`,
      link: `/team/projects/${engagementId}`,
      critical: !!held,
    });
    if (created.invoiceId) {
      await this.notifications.notify(e.orgId, await this.notifications.clientBilling(e.clientOrgId), {
        kind: 'invoice_issued',
        title: `Invoice ${created.invoiceNumber} for ${e.service.name}, ${label}`,
        body: 'Your monthly retainer invoice.',
        link: '/client/billing',
      });
    }
    return created;
  }

  /** After a payment: engagements held at Gate 3 for an overdue invoice move on when nothing is overdue any more. */
  async recheckGate3(clientOrgId: string) {
    if (await this.heldMessage(clientOrgId)) return;
    const held = await this.prisma.engagement.findMany({ where: { clientOrgId, currentGate: 'G3', status: 'in_production', deletedAt: null } });
    for (const e of held) {
      const latest = await this.prisma.cycle.findFirst({ where: { engagementId: e.id }, orderBy: { period: 'desc' }, include: { deliverables: { include: { tasks: { select: { ownerId: true, status: true } } } } } });
      if (!latest?.deliverables.length) continue;
      const unassigned = latest.deliverables.flatMap((d) => d.tasks).filter((t) => !t.ownerId && !['done', 'cancelled'].includes(t.status)).length;
      if (unassigned) continue;
      await this.prisma.engagement.update({ where: { id: e.id }, data: { currentGate: 'G4' } });
      await this.audit.logSystem(e.orgId, 'gate.G3.passed', 'Engagement', e.id, { reason: 'overdue invoice paid' });
      await this.notifications.notify(e.orgId, [e.amId], { kind: 'production_released', title: 'Overdue invoice paid: production can go ahead', link: `/team/projects/${e.id}` });
    }
  }
}

class AlreadyStarted extends Error {}
