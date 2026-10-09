// Building blocks shared by the sales analytics views: engagement prices and active periods (for MRR, cohorts
// and the forecast), revenue from the invoice ledger, and short rupee text for insight sentences.
import type { ProposalLine } from '@bmu/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { DAY } from '../insights/ist.js';
import { isBillable, type LedgerInvoice } from '../insights/ledger.js';
import type { Range } from './period.js';

/** Statuses where work (and billing) is still running. Same list the Revenue dashboard uses for MRR, plus final payment. */
export const LIVE = ['onboarding', 'blocked', 'planning', 'awaiting_plan_approval', 'in_production', 'in_review', 'delivered', 'active_retainer'] as const;
const ONGOING: readonly string[] = [...LIVE, 'awaiting_final_payment'];

export type EngagementFact = {
  id: string;
  clientId: string;
  client: string;
  serviceKey: string;
  service: string;
  tier: string;
  billingType: string;
  status: string;
  /** Monthly price for retainers; full project price for one-time work. Before GST. */
  pricePaise: number;
  /** For one-time work: the balance still to invoice at handover (when no balance invoice exists yet). */
  balancePaise: number;
  hasBalanceInvoice: boolean;
  start: Date;
  /** When the engagement stopped (null = still running). */
  end: Date | null;
  live: boolean;
};

/**
 * Every started engagement with its price and active period. Prices come from the accepted proposal line when the
 * client came through a proposal (so discounts count), else from the engagement's price-book tier.
 * End date: the recorded end date, else final sign-off for projects, else (when closed, paused or offboarding)
 * a month after its last invoice.
 */
export async function loadEngagements(prisma: PrismaService, orgId: string, now = new Date()): Promise<EngagementFact[]> {
  const rows = await prisma.engagement.findMany({
    where: { orgId, deletedAt: null, status: { not: 'pending_payment' }, clientOrg: { deletedAt: null } },
    include: { clientOrg: { select: { id: true, name: true, leadId: true } }, service: { select: { key: true, name: true, tiers: true } } },
  });
  const leadIds = [...new Set(rows.map((r) => r.clientOrg.leadId).filter((x): x is string => !!x))];
  const [proposals, invoices] = await Promise.all([
    leadIds.length ? prisma.proposal.findMany({ where: { leadId: { in: leadIds }, status: 'accepted' }, orderBy: { acceptedAt: 'desc' }, select: { leadId: true, lines: true } }) : [],
    prisma.invoice.findMany({ where: { orgId, engagementId: { in: rows.map((r) => r.id) }, status: { not: 'void' } }, select: { engagementId: true, kind: true, createdAt: true } }),
  ]);
  const lastInvoice = new Map<string, Date>();
  const balanced = new Set<string>();
  for (const i of invoices) {
    if (!i.engagementId) continue;
    if (i.kind === 'project_balance') balanced.add(i.engagementId);
    const prev = lastInvoice.get(i.engagementId);
    if (!prev || i.createdAt > prev) lastInvoice.set(i.engagementId, i.createdAt);
  }
  return rows.map((e) => {
    const tierPrice = e.service.tiers.find((t) => t.tier === e.tier)?.pricePaise ?? 0;
    const lines = (proposals.find((p) => p.leadId === e.clientOrg.leadId)?.lines ?? []) as unknown as ProposalLine[];
    const line = lines.find((l) => l.kind === 'service' && l.key === e.service.key);
    const pricePaise = line ? line.netPaise : tierPrice;
    const balancePaise = e.billingType === 'one_time' ? (line ? line.netPaise - line.dueNowPaise : Math.round(tierPrice / 2)) : 0;
    const start = e.startDate ?? e.createdAt;
    let end: Date | null = e.endDate ?? (e.billingType === 'one_time' ? e.finalSignedOffAt : null);
    if (!end && !ONGOING.includes(e.status)) {
      const last = lastInvoice.get(e.id) ?? start;
      end = new Date(Math.min(now.getTime() - 60_000, last.getTime() + 30 * DAY));
    }
    if (end && end < start) end = start;
    return {
      id: e.id,
      clientId: e.clientOrg.id,
      client: e.clientOrg.name,
      serviceKey: e.service.key,
      service: e.service.name,
      tier: e.tier,
      billingType: e.billingType,
      status: e.status,
      pricePaise,
      balancePaise,
      hasBalanceInvoice: balanced.has(e.id),
      start,
      end,
      live: (LIVE as readonly string[]).includes(e.status),
    };
  });
}

export const activeAt = (e: EngagementFact, d: Date) => e.start <= d && (!e.end || e.end > d);

/** Monthly recurring revenue per client at moment d (retainers only). */
export function mrrByClient(engagements: EngagementFact[], d: Date) {
  const m = new Map<string, number>();
  for (const e of engagements) if (e.billingType === 'monthly' && activeAt(e, d)) m.set(e.clientId, (m.get(e.clientId) ?? 0) + e.pricePaise);
  return m;
}
export const sumMap = (m: Map<string, number>) => [...m.values()].reduce((s, v) => s + v, 0);

/** Revenue (before GST, after credit notes) per invoice in a range, keyed by invoice. */
export function revenueIn(ledger: LedgerInvoice[], notes: { invoiceId: string; createdAt: Date; amountPaise: number }[], r: Range) {
  const inR = (d: Date) => d >= r.start && d < r.end;
  const byInvoice = new Map<string, number>();
  for (const i of ledger) if (isBillable(i) && inR(i.createdAt)) byInvoice.set(i.id, (byInvoice.get(i.id) ?? 0) + i.subtotalPaise);
  for (const n of notes) if (inR(n.createdAt)) byInvoice.set(n.invoiceId, (byInvoice.get(n.invoiceId) ?? 0) - n.amountPaise);
  return byInvoice;
}

export function revenueTotal(ledger: LedgerInvoice[], notes: { invoiceId: string; createdAt: Date; amountPaise: number }[], r: Range) {
  return sumMap(revenueIn(ledger, notes, r));
}

/** ₹4.2L / ₹85k / ₹1.2Cr for sentences. */
export function inrShort(paise: number) {
  const r = paise / 100;
  const sign = r < 0 ? '−' : '';
  const a = Math.abs(r);
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(a >= 1e8 ? 0 : 1)}Cr`;
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(a >= 1e6 ? 0 : 1)}L`;
  if (a >= 1e3) return `${sign}₹${Math.round(a / 1e3)}k`;
  return `${sign}₹${Math.round(a)}`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
