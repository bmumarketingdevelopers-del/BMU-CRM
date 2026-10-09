import { BadRequestException, Injectable } from '@nestjs/common';
import type { Me, PersonProfitRow, ProfitRow, ProfitView } from '@bmu/shared';
import { assertMoney } from '../insights/access.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { addDays, dbDate, todayIst } from './dates.js';

const ROLE_ALIASES: Record<string, string> = { qc_reviewer: 'qc' };
const IST = 330 * 60_000;
/** UTC instant of IST midnight at the start of a YYYY-MM-DD. */
const istStart = (iso: string) => new Date(dbDate(iso).getTime() - IST);
const round1 = (n: number) => Math.round(n * 10) / 10;

export const PROFIT_FORMULA = [
  'Revenue = invoice amounts before GST (invoices dated in the period, not cancelled) minus pass-through lines (ad spend, creator fees at cost) minus credit notes dated in the period.',
  'Team cost = hours in time entries dated in the period × the hourly cost of that person’s role (Settings → Cost rates) × (1 + overhead %).',
  'Creator payouts = payouts booked in the period for briefs of that client.',
  'Expenses = approved or paid expenses and vendor bills dated in the period that are tied to the client, before GST (GST is claimed back). Re-billed expenses also appear in revenue, so they net to zero.',
  'Profit = Revenue − Team cost − Creator payouts − Expenses. Margin = Profit ÷ Revenue.',
];

type Acc = { key: string; label: string; sub?: string; revenue: number; labour: number; payouts: number; expenses: number; minutes: number };

/** v18 profit 2.0: per client, project, service and person, with one written formula a person can check by hand. */
@Injectable()
export class ProfitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  async profit(me: Me, fromRaw?: string, toRaw?: string): Promise<ProfitView> {
    assertMoney(me);
    const today = todayIst();
    const re = /^\d{4}-\d{2}-\d{2}$/;
    const from = fromRaw && re.test(fromRaw) ? fromRaw : `${addDays(`${today.slice(0, 7)}-01`, -62).slice(0, 7)}-01`;
    const to = toRaw && re.test(toRaw) ? toRaw : today;
    if (from > to) throw new BadRequestException('The start date is after the end date');
    return this.compute(me.orgId, from, to);
  }

  async compute(orgId: string, from: string, to: string): Promise<ProfitView> {
    const start = istStart(from);
    const end = istStart(addDays(to, 1));
    const rates = await this.settings.get(orgId, 'costRates');
    const overhead = 1 + rates.overheadPct / 100;
    const [invoices, notes, entries, payouts, expenses, engagements, users] = await Promise.all([
      this.prisma.invoice.findMany({ where: { orgId, status: { notIn: ['draft', 'void'] }, createdAt: { gte: start, lt: end } }, select: { id: true, clientOrgId: true, engagementId: true, subtotalPaise: true, lines: true } }),
      this.prisma.creditNote.findMany({ where: { orgId, createdAt: { gte: start, lt: end } }, select: { invoiceId: true, amountPaise: true } }),
      this.prisma.timeEntry.findMany({ where: { orgId, date: { gte: dbDate(from), lte: dbDate(to) } }, select: { userId: true, minutes: true, engagementId: true } }),
      this.prisma.creatorPayout.findMany({ where: { orgId, briefId: { not: null }, createdAt: { gte: start, lt: end } }, select: { briefId: true, amountPaise: true } }),
      this.prisma.expense.findMany({ where: { orgId, status: { in: ['approved', 'paid'] }, clientOrgId: { not: null }, date: { gte: dbDate(from), lte: dbDate(to) } }, select: { clientOrgId: true, engagementId: true, amountPaise: true } }),
      this.prisma.engagement.findMany({ where: { orgId }, select: { id: true, clientOrgId: true, clientOrg: { select: { name: true } }, service: { select: { name: true } } } }),
      this.prisma.user.findMany({ where: { orgId, type: 'staff' }, select: { id: true, name: true, roles: { select: { role: { select: { baseRole: true } } } } } }),
    ]);
    const noteInvoices = notes.length ? await this.prisma.invoice.findMany({ where: { id: { in: [...new Set(notes.map((n) => n.invoiceId))] } }, select: { id: true, clientOrgId: true, engagementId: true } }) : [];
    const briefs = payouts.length ? await this.prisma.creatorBrief.findMany({ where: { id: { in: payouts.map((p) => p.briefId!) } }, select: { id: true, clientOrgId: true, engagementId: true } }) : [];
    const clientIds = new Set<string>([...invoices, ...noteInvoices].map((i) => i.clientOrgId).filter((x): x is string => !!x));
    for (const e of expenses) clientIds.add(e.clientOrgId!);
    for (const b of briefs) if (b.clientOrgId) clientIds.add(b.clientOrgId);
    const clientNames = new Map((await this.prisma.clientOrg.findMany({ where: { id: { in: [...clientIds] } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
    const engById = new Map(engagements.map((e) => [e.id, e]));
    for (const e of engagements) clientNames.set(e.clientOrgId, e.clientOrg.name);

    const rateFor = new Map(
      users.map((u) => {
        const keys = u.roles.map((r) => ROLE_ALIASES[r.role.baseRole] ?? r.role.baseRole).filter((k) => rates.hourlyPaise[k] !== undefined);
        const role = keys.sort((a, b) => rates.hourlyPaise[b] - rates.hourlyPaise[a])[0] ?? 'default';
        return [u.id, { name: u.name, role, rate: rates.hourlyPaise[role] ?? rates.hourlyPaise.default ?? 0 }];
      }),
    );

    const maps = { client: new Map<string, Acc>(), eng: new Map<string, Acc>(), service: new Map<string, Acc>() };
    const get = (m: Map<string, Acc>, key: string, label: string, sub?: string) => {
      let a = m.get(key);
      if (!a) m.set(key, (a = { key, label, sub, revenue: 0, labour: 0, payouts: 0, expenses: 0, minutes: 0 }));
      return a;
    };
    /** Every amount lands on the client, the project (when known) and the service (or "Not linked to a project"). */
    const targets = (clientOrgId: string | null | undefined, engagementId: string | null | undefined) => {
      const eng = engagementId ? engById.get(engagementId) : undefined;
      const cid = clientOrgId ?? eng?.clientOrgId;
      const out: Acc[] = [];
      if (cid) out.push(get(maps.client, cid, clientNames.get(cid) ?? 'Client'));
      if (eng) {
        out.push(get(maps.eng, eng.id, eng.service.name, eng.clientOrg.name));
        out.push(get(maps.service, eng.service.name, eng.service.name));
      } else if (cid) out.push(get(maps.service, '_none', 'Not linked to a project'));
      return out;
    };

    for (const i of invoices) {
      const pass = ((i.lines ?? []) as { amountPaise?: number; passThrough?: boolean }[]).filter((l) => l.passThrough).reduce((s, l) => s + (l.amountPaise ?? 0), 0);
      for (const a of targets(i.clientOrgId, i.engagementId)) a.revenue += i.subtotalPaise - pass;
    }
    const noteInv = new Map(noteInvoices.map((i) => [i.id, i]));
    for (const n of notes) {
      const i = noteInv.get(n.invoiceId);
      if (i) for (const a of targets(i.clientOrgId, i.engagementId)) a.revenue -= n.amountPaise;
    }
    const people = new Map<string, { minutes: number; clientMinutes: number; cost: number }>();
    for (const e of entries) {
      const who = rateFor.get(e.userId) ?? { name: 'Former member', role: 'default', rate: rates.hourlyPaise.default ?? 0 };
      const cost = (e.minutes / 60) * who.rate * overhead;
      const p = people.get(e.userId) ?? { minutes: 0, clientMinutes: 0, cost: 0 };
      p.minutes += e.minutes;
      p.cost += cost;
      if (e.engagementId && engById.has(e.engagementId)) p.clientMinutes += e.minutes;
      people.set(e.userId, p);
      if (!e.engagementId || !engById.has(e.engagementId)) continue;
      for (const a of targets(null, e.engagementId)) {
        a.labour += cost;
        a.minutes += e.minutes;
      }
    }
    const briefById = new Map(briefs.map((b) => [b.id, b]));
    for (const po of payouts) {
      const b = briefById.get(po.briefId!);
      if (b) for (const a of targets(b.clientOrgId, b.engagementId)) a.payouts += po.amountPaise;
    }
    for (const x of expenses) for (const a of targets(x.clientOrgId, x.engagementId)) a.expenses += x.amountPaise;

    const row = (a: Acc): ProfitRow => {
      const revenue = Math.round(a.revenue);
      const labour = Math.round(a.labour);
      const profit = revenue - labour - a.payouts - a.expenses;
      return { key: a.key, label: a.label, sub: a.sub, revenuePaise: revenue, labourPaise: labour, payoutsPaise: a.payouts, expensesPaise: a.expenses, profitPaise: profit, marginPct: revenue > 0 ? round1((profit / revenue) * 100) : null, hours: round1(a.minutes / 60) };
    };
    const sorted = (m: Map<string, Acc>) => [...m.values()].map(row).sort((x, y) => y.revenuePaise - x.revenuePaise || y.labourPaise - x.labourPaise);
    const byClient = sorted(maps.client);
    const sum = byClient.reduce(
      (s, r) => ({ revenuePaise: s.revenuePaise + r.revenuePaise, labourPaise: s.labourPaise + r.labourPaise, payoutsPaise: s.payoutsPaise + r.payoutsPaise, expensesPaise: s.expensesPaise + r.expensesPaise, hours: s.hours + r.hours }),
      { revenuePaise: 0, labourPaise: 0, payoutsPaise: 0, expensesPaise: 0, hours: 0 },
    );
    const profit = sum.revenuePaise - sum.labourPaise - sum.payoutsPaise - sum.expensesPaise;
    const byPerson: PersonProfitRow[] = [...people.entries()]
      .map(([userId, p]) => {
        const who = rateFor.get(userId) ?? { name: 'Former member', role: 'default', rate: rates.hourlyPaise.default ?? 0 };
        return { userId, name: who.name, role: who.role, hours: round1(p.minutes / 60), clientHours: round1(p.clientMinutes / 60), ratePaise: who.rate, costPaise: Math.round(p.cost), utilisationPct: p.minutes ? Math.round((p.clientMinutes / p.minutes) * 100) : 0 };
      })
      .sort((a, b) => b.costPaise - a.costPaise);
    return {
      from,
      to,
      formula: PROFIT_FORMULA,
      totals: { ...sum, hours: round1(sum.hours), profitPaise: profit, marginPct: sum.revenuePaise > 0 ? round1((profit / sum.revenuePaise) * 100) : null },
      byClient,
      byEngagement: sorted(maps.eng),
      byService: sorted(maps.service),
      byPerson,
    };
  }
}
