// Sales funnel facts: for every lead, the furthest stage it reached and when it reached each stage.
// Times come from the audit log (lead.contacted, lead.discovery, lead.proposal_sent, lead.won, lead.lost),
// proposal timestamps (sentAt, acceptedAt) and the first payment that turned the lead into a client.
import type { SalesFunnelStageKey } from '@bmu/shared';
import type { PrismaService } from '../prisma/prisma.service.js';

export const FUNNEL: { key: SalesFunnelStageKey; label: string }[] = [
  { key: 'lead', label: 'Leads' },
  { key: 'contacted', label: 'Contacted' },
  { key: 'discovery', label: 'Discovery' },
  { key: 'proposal_sent', label: 'Proposal sent' },
  { key: 'won', label: 'Won (accepted)' },
  { key: 'paid', label: 'Paid' },
];

const STAGE_INDEX: Record<string, number> = { new: 0, contacted: 1, discovery: 2, proposal_sent: 3, won: 5 };
const TOUCH = ['lead.contacted', 'lead.discovery', 'lead.proposal_sent', 'lead.won', 'lead.lost'];

export type LeadFact = {
  id: string;
  name: string;
  company: string | null;
  source: string;
  stage: string;
  serviceIds: string[];
  budgetPaise: number | null;
  owner: string | null;
  lostReason: string | null;
  createdAt: Date;
  /** Index into FUNNEL of the furthest stage reached. */
  reached: number;
  times: (Date | null)[];
  lost: boolean;
  lostAt: Date | null;
  /** Accepted (or paid when there was no proposal). */
  wonAt: Date | null;
  firstTouchAt: Date | null;
  /** Latest proposal value before GST, else the stated budget. */
  valuePaise: number | null;
  wonValuePaise: number;
  wonLines: { key: string; netPaise: number }[];
  clientId: string | null;
};

export async function loadLeadFacts(prisma: PrismaService, orgId: string): Promise<LeadFact[]> {
  const [leads, events, proposals, clients, firstPayments] = await Promise.all([
    prisma.lead.findMany({ where: { orgId, deletedAt: null }, include: { owner: { select: { name: true } } } }),
    prisma.auditEvent.findMany({ where: { orgId, entity: 'Lead', action: { startsWith: 'lead.' } }, select: { entityId: true, action: true, at: true, before: true }, orderBy: { at: 'asc' } }),
    prisma.proposal.findMany({
      where: { orgId, deletedAt: null },
      select: { id: true, leadId: true, status: true, sentAt: true, acceptedAt: true, createdAt: true, subtotalPaise: true, discountPaise: true, lines: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.clientOrg.findMany({ where: { orgId, leadId: { not: null } }, select: { id: true, leadId: true, createdAt: true, tenureStart: true } }),
    prisma.invoice.findMany({ where: { orgId, kind: 'first_payment', proposalId: { not: null } }, select: { proposalId: true, payments: { select: { at: true }, orderBy: { at: 'asc' }, take: 1 } } }),
  ]);
  const evByLead = group(events, (e) => e.entityId);
  const propByLead = group(proposals, (p) => p.leadId);
  const clientByLead = new Map(clients.map((c) => [c.leadId!, c]));
  const paidAtByProposal = new Map(firstPayments.filter((i) => i.payments.length).map((i) => [i.proposalId!, i.payments[0].at]));
  const min = (a: Date | null, b: Date | null | undefined) => (!b ? a : !a || b < a ? b : a);

  return leads.map((l) => {
    const contact = (l.contact ?? {}) as { name?: string; company?: string };
    const times: (Date | null)[] = [l.createdAt, null, null, null, null, null];
    let reached = l.stage === 'lost' ? 0 : (STAGE_INDEX[l.stage] ?? 0);
    let lostAt: Date | null = null;
    let firstTouchAt: Date | null = null;
    for (const e of evByLead.get(l.id) ?? []) {
      if (TOUCH.includes(e.action)) firstTouchAt = min(firstTouchAt, e.at);
      const stage = e.action.slice(5);
      if (stage === 'lost') {
        lostAt = e.at;
        const before = (e.before as { stage?: string } | null)?.stage;
        if (before && before !== 'lost') reached = Math.max(reached, STAGE_INDEX[before] ?? 0);
        continue;
      }
      const idx = STAGE_INDEX[stage];
      if (idx === undefined) continue;
      reached = Math.max(reached, idx);
      times[idx] = min(times[idx], e.at);
    }
    const props = propByLead.get(l.id) ?? [];
    let wonValuePaise = 0;
    let wonLines: { key: string; netPaise: number }[] = [];
    for (const p of props) {
      if (p.sentAt && p.status !== 'draft') {
        reached = Math.max(reached, 3);
        times[3] = min(times[3], p.sentAt);
      }
      if (p.status === 'accepted') {
        reached = Math.max(reached, 4);
        times[4] = min(times[4], p.acceptedAt ?? p.sentAt ?? p.createdAt);
        wonValuePaise = p.subtotalPaise - p.discountPaise;
        wonLines = ((p.lines ?? []) as { kind?: string; key?: string; netPaise?: number }[]).filter((x) => x.kind === 'service' && x.key).map((x) => ({ key: x.key!, netPaise: x.netPaise ?? 0 }));
        const paidAt = paidAtByProposal.get(p.id);
        if (paidAt) {
          reached = 5;
          times[5] = min(times[5], paidAt);
        }
      }
    }
    const client = clientByLead.get(l.id);
    if (client) {
      reached = 5;
      times[5] ??= client.tenureStart ?? client.createdAt;
    }
    if (l.stage === 'won') times[5] ??= times[4];
    const latest = props.filter((p) => p.status !== 'draft').at(-1) ?? props.at(-1);
    const lost = l.stage === 'lost';
    return {
      id: l.id,
      name: contact.name ?? 'Unnamed lead',
      company: contact.company || null,
      source: l.source,
      stage: l.stage,
      serviceIds: l.serviceIds,
      budgetPaise: l.budgetPaise,
      owner: l.owner?.name ?? null,
      lostReason: l.lostReason,
      createdAt: l.createdAt,
      reached,
      times,
      lost,
      lostAt: lost ? (lostAt ?? l.updatedAt) : null,
      wonAt: reached >= 4 ? (times[4] ?? times[5]) : null,
      firstTouchAt,
      valuePaise: latest ? latest.subtotalPaise - latest.discountPaise : l.budgetPaise,
      wonValuePaise,
      wonLines,
      clientId: client?.id ?? null,
    };
  });
}

function group<T>(rows: T[], key: (r: T) => string) {
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
  return m;
}

const SOURCE_LABELS: Record<string, string> = {
  website: 'Website',
  referral: 'Referral',
  instagram: 'Instagram',
  google_ads: 'Google Ads',
  linkedin: 'LinkedIn',
  events: 'Events',
  whatsapp: 'WhatsApp',
  package_builder: 'Package builder',
};
export const sourceLabel = (s: string) => SOURCE_LABELS[s] ?? s.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
