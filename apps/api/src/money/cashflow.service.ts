import { Injectable } from '@nestjs/common';
import { formatINR, type CashflowItem, type CashflowView, type CashflowWeek, type Me } from '@bmu/shared';
import { assertFinanceRead } from '../insights/access.js';
import { loadLedger } from '../insights/ledger.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { addDays, DAY, isoOf, mondayOf, todayIst } from './dates.js';

const WEEKS = 13;
const istIso = (d: Date) => isoOf(new Date(d.getTime() + 330 * 60_000));

/**
 * v18 13-week cash-flow forecast. Money in: open invoice balances on the day each client usually pays (their average
 * days late), and planned instalments (issued on their date, paid a week later plus the same lateness). Money out:
 * approved unpaid expenses and vendor bills on their due date, pending creator payouts next, and monthly payroll and
 * overheads from Settings on the 1st.
 */
@Injectable()
export class CashflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  async forecast(me: Me): Promise<CashflowView> {
    assertFinanceRead(me);
    const orgId = me.orgId;
    const today = todayIst();
    const first = mondayOf(today);
    const weeks: CashflowWeek[] = Array.from({ length: WEEKS }, (_, i) => ({ weekStart: addDays(first, i * 7), inPaise: 0, outPaise: 0, netPaise: 0, closingPaise: 0, items: [] }));
    const last = addDays(first, WEEKS * 7 - 1);
    const place = (iso: string, item: CashflowItem, dir: 'in' | 'out') => {
      if (iso > last) return;
      const idx = Math.max(0, Math.floor((new Date(`${iso}T00:00:00Z`).getTime() - new Date(`${first}T00:00:00Z`).getTime()) / (7 * DAY)));
      const w = weeks[idx];
      if (dir === 'in') w.inPaise += item.amountPaise;
      else w.outPaise += item.amountPaise;
      w.items.push({ ...item, amountPaise: dir === 'in' ? item.amountPaise : -item.amountPaise });
    };

    const [cfg, gst, ledger, schedules, bills, payouts] = await Promise.all([
      this.settings.get(orgId, 'cashflow'),
      this.settings.get(orgId, 'gst'),
      loadLedger(this.prisma, orgId),
      this.prisma.invoiceSchedule.findMany({ where: { orgId, status: 'planned' } }),
      this.prisma.expense.findMany({ where: { orgId, status: 'approved' } }),
      this.prisma.creatorPayout.findMany({ where: { orgId, status: 'pending' } }),
    ]);

    // How late each client usually pays (days after the due date), from fully paid invoices.
    const late = new Map<string, number[]>();
    for (const i of ledger) {
      if (i.status !== 'paid' || !i.clientOrgId || !i.payments.length) continue;
      const paidAt = i.payments[i.payments.length - 1].at;
      const days = Math.max(0, Math.round((paidAt.getTime() - i.dueDate.getTime()) / DAY));
      late.set(i.clientOrgId, [...(late.get(i.clientOrgId) ?? []), days]);
    }
    const lateFor = (clientId: string | null) => {
      const l = clientId ? late.get(clientId) : undefined;
      return l?.length ? Math.round(l.reduce((s, x) => s + x, 0) / l.length) : 0;
    };

    for (const i of ledger) {
      if (i.balancePaise <= 0) continue;
      const lateDays = lateFor(i.clientOrgId);
      const expected = addDays(istIso(i.dueDate), lateDays);
      place(expected < today ? today : expected, { label: `${i.clientOrg?.name ?? 'Client'}: ${i.number}${lateDays ? ` (usually ${lateDays} days late)` : ''}`, amountPaise: i.balancePaise, kind: 'invoice', link: `/admin/finance/invoices/${i.id}` }, 'in');
    }
    const clientNames = new Map((await this.prisma.clientOrg.findMany({ where: { id: { in: schedules.map((s) => s.clientOrgId) } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
    for (const s of schedules) {
      const withGst = s.amountPaise + Math.round((s.amountPaise * gst.ratePct) / 100);
      const expected = addDays(isoOf(s.dueOn), 7 + lateFor(s.clientOrgId));
      place(expected < today ? today : expected, { label: `${clientNames.get(s.clientOrgId) ?? 'Client'}: ${s.label} (planned)`, amountPaise: withGst, kind: 'schedule' }, 'in');
    }
    for (const b of bills) {
      const due = b.dueDate ? isoOf(b.dueDate) : addDays(isoOf(b.date), b.kind === 'vendor_bill' ? 30 : 7);
      place(due < today ? today : due, { label: `${b.kind === 'vendor_bill' ? (b.vendorName ?? 'Vendor') : 'Expense claim'}: ${b.description}`, amountPaise: b.amountPaise + b.gstPaise - b.tdsPaise, kind: 'bill' }, 'out');
    }
    for (const p of payouts) place(addDays(today, 3), { label: 'Creator payout', amountPaise: p.netPaise, kind: 'payout' }, 'out');
    for (let m = 0; m < 4; m++) {
      const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + m + 1);
      const iso = isoOf(d);
      if (cfg.monthlyPayrollPaise) place(iso, { label: 'Salaries', amountPaise: cfg.monthlyPayrollPaise, kind: 'payroll' }, 'out');
      if (cfg.monthlyOverheadsPaise) place(iso, { label: 'Rent, tools and other fixed costs', amountPaise: cfg.monthlyOverheadsPaise, kind: 'overheads' }, 'out');
    }

    let balance = cfg.openingBalancePaise;
    let lowest = balance;
    let lowestWeek = first;
    for (const w of weeks) {
      w.netPaise = w.inPaise - w.outPaise;
      balance += w.netPaise;
      w.closingPaise = balance;
      w.items.sort((a, b) => b.amountPaise - a.amountPaise);
      if (balance < lowest) {
        lowest = balance;
        lowestWeek = w.weekStart;
      }
    }
    const assumptions = [
      cfg.asOf ? `Starting bank balance ${formatINR(cfg.openingBalancePaise)} as of ${cfg.asOf} (Settings → Cash flow).` : 'No starting bank balance set yet (Settings → Cash flow), so the forecast starts from ₹0.',
      'Open invoices arrive on their due date plus how late that client paid on average before; overdue ones are expected this week.',
      `Planned instalments are invoiced on their date with ${gst.ratePct}% GST and paid a week later.`,
      'Approved expenses and vendor bills are paid on their due date (vendor bills without one: 30 days after the bill date).',
      cfg.monthlyPayrollPaise || cfg.monthlyOverheadsPaise ? 'Salaries and fixed costs go out on the 1st of each month.' : 'Salaries and fixed costs are not set (Settings → Cash flow).',
    ];
    return { openingPaise: cfg.openingBalancePaise, asOf: cfg.asOf || today, weeks, lowestPaise: lowest, lowestWeek, assumptions };
  }
}
