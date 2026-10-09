// v18 Finance collector agent and the Producer's booking step: facts, the basic plan (no AI key needed) and the
// AI-mode instructions. Every change goes through the runtime gate (h.act), so payments matched and reminders sent
// always wait for a person in the Agent Inbox.
import { formatINR } from '@bmu/shared';
import { loadLedger } from '../insights/ledger.js';
import { CapacityService } from '../money/capacity.service.js';
import { addDays, dbDate, mondayOf, todayIst } from '../money/dates.js';
import { PaymentsHubService } from '../money/payments-hub.service.js';
import { ProfitService } from '../money/profit.service.js';
import type { BasicResult, PlanHelpers } from './plans.js';

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export async function financeFacts(h: PlanHelpers) {
  const orgId = h.acting.orgId;
  const hub = h.ref.get(PaymentsHubService, { strict: false });
  const today = todayIst(h.now);
  const unmatchedRows = await h.prisma.unmatchedPayment.findMany({ where: { orgId, matchedAt: null, ignoredAt: null }, orderBy: { receivedAt: 'asc' }, take: 20 });
  const open = (await loadLedger(h.prisma, orgId, { status: { in: ['issued', 'partially_paid', 'overdue'] } })).filter((i) => i.balancePaise > 0);
  const unmatched = [];
  for (const u of unmatchedRows) unmatched.push({ id: u.id, amountPaise: u.amountPaise, ref: u.ref, payer: u.payerName ?? u.payerEmail ?? u.payerPhone ?? null, suggestions: await hub.suggestionsFor(orgId, u, open) });

  const weekAgo = new Date(h.now.getTime() - 7 * 86_400_000);
  const late = open.filter((i) => i.daysOverdue >= 3 && i.clientOrgId).sort((a, b) => b.daysOverdue - a.daysOverdue);
  const [recent, promises] = await Promise.all([
    h.prisma.invoiceReminder.findMany({ where: { invoiceId: { in: late.map((i) => i.id) }, createdAt: { gte: weekAgo } }, select: { invoiceId: true } }),
    h.prisma.paymentPromise.findMany({ where: { invoiceId: { in: late.map((i) => i.id) }, promisedFor: { gte: dbDate(today) } }, select: { invoiceId: true } }),
  ]);
  const skip = new Set([...recent, ...promises].map((r) => r.invoiceId));
  const overdue = late.filter((i) => !skip.has(i.id)).slice(0, 10).map((i) => ({ id: i.id, number: i.number, client: i.clientOrg?.name ?? '', balancePaise: i.balancePaise, daysOverdue: i.daysOverdue }));

  const unbilledRows = await h.prisma.expense.findMany({ where: { orgId, billable: true, invoiceId: null, status: { in: ['approved', 'paid'] }, clientOrgId: { not: null } }, select: { clientOrgId: true, amountPaise: true } });
  const byClient = new Map<string, number>();
  for (const e of unbilledRows) byClient.set(e.clientOrgId!, (byClient.get(e.clientOrgId!) ?? 0) + e.amountPaise);
  const names = new Map((await h.prisma.clientOrg.findMany({ where: { id: { in: [...byClient.keys()] } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  const unbilled = [...byClient.entries()].map(([clientId, paise]) => ({ clientId, client: names.get(clientId) ?? 'Client', paise })).sort((a, b) => b.paise - a.paise);

  // Scope creep: projects whose costs in the last 90 days are more than they billed.
  const profit = await h.ref.get(ProfitService, { strict: false }).compute(orgId, addDays(today, -90), today);
  const overrun = profit.byEngagement.filter((r) => r.revenuePaise > 0 && r.profitPaise < 0).slice(0, 5).map((r) => ({ engagementId: r.key, label: `${r.sub} · ${r.label}`, revenuePaise: r.revenuePaise, costPaise: r.revenuePaise - r.profitPaise, hours: r.hours }));
  return { unmatched, overdue, unbilled, overrun };
}

export async function financeBasic(h: PlanHelpers): Promise<BasicResult> {
  const f = await financeFacts(h);
  let matched = 0;
  for (const u of f.unmatched) {
    const best = u.suggestions[0];
    if (!best || best.balancePaise < u.amountPaise) continue;
    const r = await h.act('match_payment', { unmatchedId: u.id, invoiceId: best.invoiceId, reason: `${formatINR(u.amountPaise)} looks like ${best.number} (${best.client}): ${best.reason}.` });
    if (r.status === 'proposed') matched++;
  }
  let reminders = 0;
  for (const i of f.overdue) {
    const r = await h.act('send_payment_reminder', { invoiceId: i.id, note: `${i.daysOverdue} days late with ${formatINR(i.balancePaise)} due and no reminder or promise this week.` });
    if (r.status === 'proposed') reminders++;
  }
  const today = todayIst(h.now);
  const lines: string[] = [];
  if (f.unbilled.length) lines.push(`Billable expenses not re-billed yet: ${f.unbilled.slice(0, 4).map((u) => `${u.client} ${formatINR(u.paise)}`).join(', ')}.`);
  if (f.overrun.length) lines.push(`Costs running past the fee (last 90 days): ${f.overrun.slice(0, 3).map((o) => `${o.label} billed ${formatINR(o.revenuePaise)}, cost ${formatINR(o.costPaise)}`).join('; ')}.`);
  if (lines.length) {
    const already = await h.prisma.notification.findFirst({ where: { orgId: h.acting.orgId, userId: h.acting.id, kind: 'agent', title: { contains: 'money to look at' }, createdAt: { gte: new Date(`${today}T00:00:00+05:30`) } } });
    if (!already) await h.act('notify_person', { userId: h.acting.id, title: 'Finance: money to look at today', body: lines.join(' ').slice(0, 590), link: f.unbilled.length ? '/admin/finance/expenses' : '/admin/finance/profit' });
  }
  const parts = [
    f.unmatched.length ? `${plural(f.unmatched.length, 'unmatched payment')}, ${plural(matched, 'match')} suggested` : 'No unmatched payments',
    f.overdue.length ? `${plural(reminders, 'reminder')} suggested` : 'no reminders due',
    f.unbilled.length ? `${plural(f.unbilled.length, 'client')} with unbilled expenses` : null,
    f.overrun.length ? `${plural(f.overrun.length, 'project')} over budget` : null,
  ].filter(Boolean);
  return { summary: parts.join('; ') };
}

export function financePrompt(f: Awaited<ReturnType<typeof financeFacts>>) {
  const inr = (p: number) => formatINR(p);
  return `Do the morning collections check. Facts (ids are exact):
Unmatched payments: ${f.unmatched.length ? f.unmatched.map((u) => `\n- id ${u.id}: ${inr(u.amountPaise)}, ref ${u.ref}${u.payer ? `, payer ${u.payer}` : ''}; possible invoices: ${u.suggestions.map((s) => `${s.invoiceId} (${s.number}, ${s.client}, ${inr(s.balancePaise)} due: ${s.reason})`).join('; ') || 'none'}`).join('') : 'none'}
Overdue invoices with no reminder or promise this week: ${f.overdue.length ? f.overdue.map((i) => `\n- id ${i.id}: ${i.number}, ${i.client}, ${inr(i.balancePaise)} due, ${i.daysOverdue} days late`).join('') : 'none'}
Billable expenses not re-billed: ${f.unbilled.length ? f.unbilled.map((u) => `${u.client} ${inr(u.paise)}`).join(', ') : 'none'}
Projects costing more than they billed (90 days): ${f.overrun.length ? f.overrun.map((o) => `${o.label}: billed ${inr(o.revenuePaise)}, cost ${inr(o.costPaise)}, ${o.hours}h`).join('; ') : 'none'}

Do this:
1. For each unmatched payment with a clear match (same amount, the invoice number in the reference, or the payer's email), suggest match_payment with a one-line reason. Skip it when unsure.
2. For each overdue invoice listed, suggest send_payment_reminder with a one-line note.
3. If there are unbilled expenses or projects over budget, notify_person the person you act for once (link /admin/finance/expenses or /admin/finance/profit).
Finish with one line saying what you did.`;
}

/** Producer: fill skill requests on the workload board with the best free person (never someone on approved leave). */
export async function producerBookings(h: PlanHelpers): Promise<number> {
  const orgId = h.acting.orgId;
  const cap = h.ref.get(CapacityService, { strict: false });
  if (!cap.canBook(h.acting)) return 0;
  const thisWeek = mondayOf(todayIst(h.now));
  const requests = await h.prisma.resourceBooking.findMany({ where: { orgId, status: 'requested', weekStart: { gte: dbDate(thisWeek), lte: dbDate(addDays(thisWeek, 28)) } }, orderBy: { weekStart: 'asc' }, take: 10 });
  let proposed = 0;
  for (const r of requests) {
    const week = r.weekStart.toISOString().slice(0, 10);
    const s = await cap.suggestCore(orgId, week, r.specialty, r.hours);
    const best = s.candidates[0];
    if (!best) continue;
    const out = await h.act('book_person', { engagementId: r.engagementId, userId: best.userId, weekStart: week, hours: r.hours, requestId: r.id, note: `Best fit for the ${r.specialty?.replaceAll('_', ' ') ?? 'skill'} request: ${best.reason}.` });
    if (out.status === 'proposed') proposed++;
  }
  return proposed;
}
