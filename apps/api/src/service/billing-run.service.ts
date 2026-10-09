// Finance "Billing run": preview this month's retainer invoices, issue all or some, and keep a log.
// Never double-bills: an engagement already billed for the period (by this page or by the cycle-start job)
// is skipped. Checked by engagement + period inside a transaction with an advisory lock on (engagement, period).
import { BadRequestException, Injectable } from '@nestjs/common';
import { serviceBillingRunSchema, type Me, type ServiceBillingRunLine, type ServiceBillingRunLog, type ServiceBillingRunPreview, type ServiceBillingRunResult } from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { parse } from '../common/zod.js';
import { assertFinanceRead, assertFinanceWrite, canWriteFinance } from '../insights/access.js';
import { istDate as istMidnight, monthLabel } from '../insights/ist.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { issueInvoiceTx } from '../requests/billing.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { ServiceBillingService } from './service-billing.service.js';

/** Retainers in these states are billed every month. */
const BILLABLE = ['onboarding', 'blocked', 'planning', 'awaiting_plan_approval', 'in_production', 'in_review', 'active_retainer'] as const;

type Tx = Prisma.TransactionClient;

function periodBounds(period: string) {
  const [y, m] = period.split('-').map(Number);
  return { start: istMidnight(y, m - 1, 1), end: istMidnight(y, m, 1) };
}

export function currentPeriod(now = new Date()) {
  const ist = new Date(now.getTime() + 330 * 60_000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** An invoice that already bills this engagement for this period (any source). */
export async function existingRetainerInvoice(db: Tx | PrismaService, engagementId: string, period: string) {
  const { start, end } = periodBounds(period);
  return db.invoice.findFirst({
    where: {
      engagementId,
      status: { not: 'void' },
      OR: [{ period }, { kind: 'retainer', period: null, createdAt: { gte: start, lt: end } }],
    },
    select: { id: true, number: true },
  });
}

@Injectable()
export class BillingRunService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly billing: ServiceBillingService,
  ) {}

  private async monthlyPrice(e: { serviceId: string; tier: Prisma.EngagementGetPayload<object>['tier']; service: { key: string }; clientOrg: { leadId: string | null } }) {
    if (e.clientOrg.leadId) {
      const p = await this.prisma.proposal.findFirst({ where: { leadId: e.clientOrg.leadId, status: 'accepted' }, orderBy: { acceptedAt: 'desc' } });
      const line = (p?.lines as { kind?: string; key?: string; billingType?: string; netPaise?: number }[] | undefined)?.find((l) => l.kind === 'service' && l.key === e.service.key);
      if (line?.netPaise && line.billingType === 'monthly') return line.netPaise;
    }
    const tier = await this.prisma.serviceTier.findUnique({ where: { serviceId_tier: { serviceId: e.serviceId, tier: e.tier } } });
    return tier?.pricePaise ?? 0;
  }

  async preview(me: Me, period?: string): Promise<ServiceBillingRunPreview> {
    assertFinanceRead(me);
    const p = period && /^\d{4}-(0[1-9]|1[0-2])$/.test(period) ? period : currentPeriod();
    const { start, end } = periodBounds(p);
    const gst = await this.settings.get(me.orgId, 'gst');
    const rows = await this.prisma.engagement.findMany({
      where: { orgId: me.orgId, deletedAt: null, billingType: 'monthly', status: { in: [...BILLABLE] }, clientOrg: { deletedAt: null } },
      include: { service: { select: { name: true, key: true } }, clientOrg: { select: { id: true, name: true, leadId: true } } },
      orderBy: [{ clientOrg: { name: 'asc' } }, { createdAt: 'asc' }],
    });
    const lines: ServiceBillingRunLine[] = [];
    for (const e of rows) {
      const amount = await this.monthlyPrice(e);
      const gstPaise = Math.round((amount * gst.ratePct) / 100);
      const existing = await existingRetainerInvoice(this.prisma, e.id, p);
      const startedThisMonth = (e.startDate ?? e.createdAt) >= start && (e.startDate ?? e.createdAt) < end;
      const status: ServiceBillingRunLine['status'] = existing ? 'already_issued' : startedThisMonth ? 'started_this_month' : amount <= 0 ? 'no_price' : 'ready';
      lines.push({
        engagementId: e.id,
        clientId: e.clientOrg.id,
        client: e.clientOrg.name,
        service: e.service.name,
        tier: e.tier,
        amountPaise: amount,
        gstPaise,
        totalPaise: amount + gstPaise,
        status,
        existingInvoice: existing,
        note:
          status === 'already_issued'
            ? `Already billed: ${existing!.number}`
            : status === 'started_this_month'
              ? 'Started this month: the first payment covers it'
              : status === 'no_price'
                ? 'No monthly price found for this service tier'
                : 'Ready to bill',
      });
    }
    const ready = lines.filter((l) => l.status === 'ready');
    return { period: p, periodLabel: monthLabel(start, true), lines, readyCount: ready.length, readyTotalPaise: ready.reduce((s, l) => s + l.totalPaise, 0), canIssue: canWriteFinance(me) };
  }

  async issue(me: Me, body: unknown, ip?: string): Promise<ServiceBillingRunResult> {
    assertFinanceWrite(me);
    const input = parse(serviceBillingRunSchema, body);
    const preview = await this.preview(me, input.period);
    const wanted = new Set(input.engagementIds);
    const gst = await this.settings.get(me.orgId, 'gst');
    const issued: ServiceBillingRunResult['issued'] = [];
    const skipped: ServiceBillingRunResult['skipped'] = [];
    for (const id of wanted) {
      const line = preview.lines.find((l) => l.engagementId === id);
      if (!line) {
        skipped.push({ engagementId: id, reason: 'Not an active retainer' });
        continue;
      }
      if (line.status !== 'ready') {
        skipped.push({ engagementId: id, reason: line.note });
        continue;
      }
      const inv = await this.prisma.$transaction(async (tx) => {
        // Same lock key the cycle-start job can use: hashtext('<engagementId>:<period>').
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${id}:${input.period}`}))`;
        if (await existingRetainerInvoice(tx, id, input.period)) return null;
        return issueInvoiceTx(
          tx,
          {
            orgId: me.orgId,
            clientOrgId: line.clientId,
            engagementId: id,
            kind: 'retainer',
            period: input.period,
            dueInDays: input.dueInDays,
            lines: [{ label: `${line.service} (${line.tier}): retainer for ${input.period}`, amountPaise: line.amountPaise }],
          },
          gst,
        );
      });
      if (!inv) {
        skipped.push({ engagementId: id, reason: 'Billed by someone else a moment ago' });
        continue;
      }
      issued.push({ id: inv.id, number: inv.number, client: line.client });
      await this.audit.log(me, 'invoice.issued', 'Invoice', inv.id, undefined, { kind: 'retainer', period: input.period, totalPaise: inv.totalPaise, billingRun: true }, ip);
    }
    if (!issued.length && !skipped.length) throw new BadRequestException('Nothing to bill');
    const total = await this.prisma.invoice.aggregate({ where: { id: { in: issued.map((i) => i.id) } }, _sum: { totalPaise: true } });
    const run = await this.prisma.billingRun.create({
      data: {
        orgId: me.orgId,
        period: input.period,
        createdById: me.id,
        issuedCount: issued.length,
        skippedCount: skipped.length,
        totalPaise: total._sum.totalPaise ?? 0,
        invoiceIds: issued.map((i) => i.id),
        detail: JSON.parse(JSON.stringify({ issued, skipped })),
      },
    });
    await this.audit.log(me, 'finance.billing_run', 'BillingRun', run.id, undefined, { period: input.period, issued: issued.length, skipped: skipped.length }, ip);
    // Emails go out after the invoices exist (tax invoice inside, respects templates and preferences).
    for (const i of issued) await this.billing.invoiceIssued(i.id);
    return { runId: run.id, issued, skipped };
  }

  async runs(me: Me): Promise<ServiceBillingRunLog[]> {
    assertFinanceRead(me);
    const rows = await this.prisma.billingRun.findMany({ where: { orgId: me.orgId }, orderBy: { createdAt: 'desc' }, take: 50 });
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.createdById))] } }, select: { id: true, name: true } });
    return rows.map((r) => {
      const d = r.detail as { issued?: { id: string; number: string; client: string }[] };
      return {
        id: r.id,
        period: r.period,
        by: users.find((u) => u.id === r.createdById)?.name ?? '',
        issuedCount: r.issuedCount,
        skippedCount: r.skippedCount,
        totalPaise: r.totalPaise,
        createdAt: r.createdAt.toISOString(),
        invoices: d.issued ?? [],
      };
    });
  }
}
