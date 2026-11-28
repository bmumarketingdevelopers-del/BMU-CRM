// Ask BMU page skills: see ./types.ts for the contract and ./access.ts for who sees each tab.
// Command Centre → Finance and Platform. Every lookup goes through the same service (or controller) and permission
// check the page uses. Secrets (API keys, webhook secrets, tokens, bank account numbers) are never returned: only
// names, counts and on/off/connected states.
import { ForbiddenException } from '@nestjs/common';
import { formatINR, NOTIFICATION_KINDS, type Me } from '@bmu/shared';
import { AuditController } from '../../audit/audit.controller.js';
import { PlatformController } from '../../admin-platform/platform.controller.js';
import { canReadFinance } from '../../insights/access.js';
import { FinanceService } from '../../insights/finance.service.js';
import { ApiKeysService } from '../../integrations/api-keys.service.js';
import { WebhooksService } from '../../integrations/webhooks.service.js';
import { CashflowService } from '../../money/cashflow.service.js';
import { ExpensesService } from '../../money/expenses.service.js';
import { PaymentsHubService } from '../../money/payments-hub.service.js';
import { ProfitService } from '../../money/profit.service.js';
import { SchedulesService } from '../../money/schedules.service.js';
import { SystemService } from '../../platform/system.service.js';
import { DpdpService } from '../../security/dpdp.service.js';
import { SecurityAdminController } from '../../security/security-admin.controller.js';
import { BillingRunService } from '../../service/billing-run.service.js';
import { ServiceController } from '../../service/service.controller.js';
import { SettingsService } from '../../settings/settings.service.js';
import { redact } from '../ai-safety.js';
import { AiService } from '../ai.service.js';
import { admin } from './access.js';
import { bullets, day, link, plural, svc, type PageSkill } from './types.js';

const pct = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${Math.round(n)}%`);
const yes = (b: boolean) => (b ? 'yes' : 'no');
const words = (s: string) => s.replaceAll('_', ' ');
const end = (label: string, href: string) => `\n\nOpen ${link(label, href)}.`;
/** Host only: a webhook URL can carry a token in its path or query. */
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return 'a URL';
  }
};

// ---------------------------------------------------------------------------------------------------------- data

export type InvoicePlansData = {
  plannedCount: number;
  plannedTotal: string;
  issuedCount: number;
  skippedCount: number;
  failedCount: number;
  next: { client: string; label: string; amount: string; due: string | null; project: string | null }[];
  failed: { client: string; label: string; error: string }[];
};
export type BillingRunData = {
  period: string;
  readyCount: number;
  readyTotal: string;
  alreadyIssued: number;
  noPrice: number;
  startedThisMonth: number;
  ready: { client: string; service: string; total: string }[];
  lastRun: { period: string; by: string; when: string | null; issued: number; skipped: number; total: string } | null;
};
export type PaymentsData = {
  thisMonth: string;
  allTime: string;
  count: number;
  online: string;
  offline: string;
  byMethod: { label: string; amount: string; count: number }[];
  latest: { invoice: string; client: string; amount: string; method: string; when: string | null }[];
};
export type MatchData = {
  openCount: number;
  openTotal: string;
  open: { amount: string; payer: string; ref: string; received: string | null; suggestion: string | null }[];
  doneCount: number;
};
export type BillsData = {
  waiting: string;
  approvedUnpaid: string;
  paidThisMonth: string;
  billableUnbilled: string;
  waitingCount: number;
  toPay: { vendor: string; bill: string | null; amount: string; due: string | null; kind: string; status: string }[];
  allCompany: boolean;
};
export type CreditNotesData = { count: number; total: string; latest: { number: string; invoice: string; client: string; total: string; reason: string; when: string | null }[] };
export type PayoutsData = { pending: string; paid: string; tds: string; pendingCount: number; onHoldCount: number; pendingRows: { creator: string; brief: string | null; net: string; since: string | null }[] };
export type ProfitData = {
  from: string | null;
  to: string | null;
  revenue: string;
  costs: string;
  profit: string;
  margin: string;
  hours: number;
  topClients: { name: string; profit: string; margin: string }[];
  lowClients: { name: string; profit: string; margin: string }[];
};
export type CashflowData = {
  opening: string;
  asOf: string | null;
  lowest: string;
  lowestWeek: string | null;
  negative: boolean;
  weeks: { week: string | null; in: string; out: string; closing: string }[];
};
export type GstData = {
  month: string;
  ratePct: number;
  invoiceCount: number;
  taxable: string;
  gst: string;
  total: string;
  creditNotes: { count: number; gst: string };
  settings: { gstin: string | null; legalName: string; state: string; sacCode: string; invoicePrefix: string; bankDetailsSet: boolean; upiSet: boolean };
};
export type AccountingData = { tool: string; connected: boolean; lastExport: string | null };
export type HealthData = {
  version: string;
  database: { ok: boolean; ms: number };
  eventsLastHour: number;
  failures: { subscriber: string; event: string; status: string; error: string }[];
  failureCount: number;
  jobsOff: string[];
  processes: { alive: number; total: number };
  search: { documents: number; building: boolean };
  realtime: { people: number };
};
export type AiUsageData = {
  month: string;
  connected: boolean;
  enabled: boolean;
  calls: number;
  aiCalls: number;
  basicCalls: number;
  blocked: number;
  errors: number;
  cost: string;
  budget: string;
  budgetPct: number | null;
  topFeatures: { label: string; calls: number }[];
  topUsers: { name: string; calls: number }[];
};
export type TemplatesData = { total: number; email: number; whatsapp: number; inAppOff: number; custom: number; templates: { label: string; audience: string; channels: string }[] };
export type OutboxData = { emailReady: boolean; total: number; last7Days: number; failed: number; byKind: { kind: string; count: number }[]; recentFailed: { subject: string; kind: string; when: string | null; error: string }[] };
export type IntegrationsData = { rows: { name: string; connected: boolean; note: string | null }[] };
export type DeveloperData = {
  activeKeys: number;
  revokedKeys: number;
  keys: { name: string; scopes: number; lastUsed: string | null; expires: string | null }[];
  webhooks: { host: string; events: number; active: boolean; failingSince: string | null; delivered: number; dead: number }[];
};
export type BrandingData = { clientAppName: string; primary: string; accent: string; background: string; logoSet: boolean };
export type SecurityData = { twoFactorRoles: string[]; sessionDays: number; restrictedFields: number; totalFields: number; examples: string[] };
export type AuditData = { total: number; scope: 'all' | 'branch'; latest: { action: string; record: string; who: string; when: string | null }[] };
export type PrivacyData = {
  open: number;
  overdue: number;
  requests: { kind: string; requester: string; status: string; due: string | null; overdue: boolean }[];
  consents: { total: number; marketing: number; withdrawn: number };
  retentionOn: number;
  retentionTotal: number;
};
export type DataExportData = { clients: number; retentionDays: number; anonymisedUsers: number; rows: { name: string; users: number; engagements: number; unpaidInvoices: number }[] };
export type TenantData = { name: string; supportEmail: string; supportPhone: string; website: string; retentionDays: number; plan: string | null; clients: number | null; staff: number | null };

const settingsOf = (ref: Parameters<PageSkill['load']>[0], me: Me) => svc(ref, SettingsService).all(me);
const dateTime = (iso: string | null | undefined) =>
  iso ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(iso)) : null;

// ---------------------------------------------------------------------------------------------------------- skills

export const SKILLS: PageSkill[] = [
  // ------------------------------------------------------------------------------------------------ Finance
  {
    name: 'page_invoice_plans',
    label: 'Invoice Plans',
    href: '/admin/finance/schedules',
    surface: 'admin',
    can: admin('Invoice Plans'),
    keywords: /\b(invoice plans?|invoice schedules?|planned invoices?|scheduled invoices?|instal+ments?)\b/,
    examples: ['Which invoice plans are coming up?', 'What instalments are planned next?'],
    description: 'Planned invoices (milestones and instalments) still to be issued with their totals, the next ones by date, and any that failed to issue.',
    load: async (ref, me): Promise<InvoicePlansData> => {
      const rows = await svc(ref, SchedulesService).list(me, {});
      const planned = rows.filter((r) => r.status === 'planned').sort((a, b) => a.dueOn.localeCompare(b.dueOn));
      const failed = planned.filter((r) => r.error);
      return {
        plannedCount: planned.length,
        plannedTotal: formatINR(planned.reduce((s, r) => s + r.amountPaise, 0)),
        issuedCount: rows.filter((r) => r.status === 'issued').length,
        skippedCount: rows.filter((r) => r.status === 'skipped').length,
        failedCount: failed.length,
        next: planned.slice(0, 10).map((r) => ({ client: r.client, label: redact(r.label), amount: formatINR(r.amountPaise), due: day(r.dueOn), project: r.project })),
        failed: failed.slice(0, 5).map((r) => ({ client: r.client, label: redact(r.label), error: redact(r.error) })),
      };
    },
    answer: (d: InvoicePlansData) => {
      const href = '/admin/finance/schedules';
      if (!d.plannedCount) return `No invoices are planned right now (${plural(d.issuedCount, 'plan')} already issued).${end('Invoice Plans', href)}`;
      const next = bullets(d.next.map((r) => `${r.client}: ${r.label} · ${r.amount}${r.due ? ` · on ${r.due}` : ''}`));
      const failed = d.failedCount ? `\n\n${plural(d.failedCount, 'plan')} could not be issued:\n${bullets(d.failed.map((r) => `${r.client}: ${r.label} (${r.error})`))}` : '';
      return `${plural(d.plannedCount, 'planned invoice')} still to issue, ${d.plannedTotal} in all (${d.issuedCount} issued so far). Next up:\n${next}${failed}${end('Invoice Plans', href)}`;
    },
  },
  {
    name: 'page_billing_run',
    label: 'Billing Run',
    href: '/admin/finance/billing-run',
    surface: 'admin',
    can: admin('Billing Run'),
    keywords: /\b(billing runs?|retainer billing|monthly billing|retainers? (ready|to bill))\b/,
    examples: ["What's ready in the billing run?", 'When was the last billing run?'],
    description: "This month's retainer billing run: how many retainers are ready to invoice and for how much, what is already issued, and the last run.",
    load: async (ref, me): Promise<BillingRunData> => {
      const runs = svc(ref, BillingRunService);
      const [p, log] = await Promise.all([runs.preview(me), runs.runs(me)]);
      const ready = p.lines.filter((l) => l.status === 'ready');
      const last = log[0];
      return {
        period: p.periodLabel,
        readyCount: p.readyCount,
        readyTotal: formatINR(p.readyTotalPaise),
        alreadyIssued: p.lines.filter((l) => l.status === 'already_issued').length,
        noPrice: p.lines.filter((l) => l.status === 'no_price').length,
        startedThisMonth: p.lines.filter((l) => l.status === 'started_this_month').length,
        ready: ready.slice(0, 10).map((l) => ({ client: l.client, service: l.service, total: formatINR(l.totalPaise) })),
        lastRun: last ? { period: last.period, by: last.by, when: day(last.createdAt), issued: last.issuedCount, skipped: last.skippedCount, total: formatINR(last.totalPaise) } : null,
      };
    },
    answer: (d: BillingRunData) => {
      const lines = [
        d.readyCount ? `${d.period}: ${plural(d.readyCount, 'retainer')} ready to invoice, ${d.readyTotal} with GST.` : `${d.period}: no retainers are waiting to be invoiced.`,
        d.alreadyIssued ? `${d.alreadyIssued} already invoiced this month.` : '',
        d.noPrice ? `${plural(d.noPrice, 'retainer')} ${d.noPrice === 1 ? 'has' : 'have'} no price set.` : '',
        d.startedThisMonth ? `${d.startedThisMonth} started this month (billed separately).` : '',
      ].filter(Boolean);
      const ready = d.ready.length ? `\n${bullets(d.ready.map((r) => `${r.client} · ${r.service} · ${r.total}`))}` : '';
      const last = d.lastRun ? `\n\nLast run: ${d.lastRun.period}, by ${d.lastRun.by}${d.lastRun.when ? ` on ${d.lastRun.when}` : ''}: ${d.lastRun.issued} issued, ${d.lastRun.skipped} skipped, ${d.lastRun.total}.` : '\n\nNo billing run has been done yet.';
      return `${lines.join(' ')}${ready}${last}${end('Billing Run', '/admin/finance/billing-run')}`;
    },
  },
  {
    name: 'page_payments',
    label: 'Payments',
    href: '/admin/finance/payments',
    surface: 'admin',
    can: admin('Payments'),
    keywords: /\b(payments? (received|collected|recorded|came in|this month)|received payments?|payment methods?|how (were we|did clients) pa(id|y))\b/,
    examples: ['Show payments received this month', 'Which payment methods do clients use?'],
    description: 'Payments recorded against invoices: received this month and in all, online vs offline, by method, and the latest payments.',
    load: async (ref, me): Promise<PaymentsData> => {
      const v = await svc(ref, FinanceService).payments(me);
      return {
        thisMonth: formatINR(v.thisMonthPaise),
        allTime: formatINR(v.totalPaise),
        count: v.rows.length,
        online: formatINR(v.razorpayPaise),
        offline: formatINR(v.offlinePaise),
        byMethod: v.byMethod.map((m) => ({ label: m.label, amount: formatINR(m.valuePaise), count: m.count })),
        latest: v.rows.slice(0, 10).map((p) => ({ invoice: p.invoiceNumber, client: p.client, amount: formatINR(p.amountPaise), method: words(p.method), when: day(p.at) })),
      };
    },
    answer: (d: PaymentsData) => {
      const href = '/admin/finance/payments';
      if (!d.count) return `No payments have been recorded yet.${end('Payments', href)}`;
      const methods = d.byMethod.length ? `\n\nBy method:\n${bullets(d.byMethod.map((m) => `${m.label}: ${m.amount} (${plural(m.count, 'payment')})`))}` : '';
      return `Received this month: ${d.thisMonth} (all time ${d.allTime}; online ${d.online}, offline ${d.offline}).${methods}\n\nLatest:\n${bullets(d.latest.map((p) => `${p.invoice} · ${p.client} · ${p.amount} · ${p.method}${p.when ? ` · ${p.when}` : ''}`))}${end('Payments', href)}`;
    },
  },
  {
    name: 'page_payments_to_match',
    label: 'Payments to Match',
    href: '/admin/finance/reconcile',
    surface: 'admin',
    can: admin('Payments to Match'),
    keywords: /\b(unmatched( bank)? payments?|payments? to match|unmatched|reconcil(e|iation)|bank credits?|(waiting|left) to (be )?match(ed)?)\b/,
    examples: ['Any unmatched bank payments?', 'Show the payments waiting to be matched'],
    description: 'Bank/UPI credits not yet matched to an invoice: count, total, each with payer, reference and the best invoice suggestion.',
    load: async (ref, me): Promise<MatchData> => {
      const v = await svc(ref, PaymentsHubService).unmatched(me);
      return {
        openCount: v.open.length,
        openTotal: formatINR(v.open.reduce((s, r) => s + r.amountPaise, 0)),
        open: v.open.slice(0, 10).map((r) => ({
          amount: formatINR(r.amountPaise),
          payer: redact(r.payerName) || 'unknown payer',
          ref: redact(r.ref),
          received: day(r.receivedAt),
          suggestion: r.suggestions[0] ? `${r.suggestions[0].number} (${r.suggestions[0].client})` : null,
        })),
        doneCount: v.done.length,
      };
    },
    answer: (d: MatchData) => {
      const href = '/admin/finance/reconcile';
      if (!d.openCount) return `Every bank payment is matched to an invoice. Nothing to match right now.${end('Payments to Match', href)}`;
      return `${plural(d.openCount, 'payment')} (${d.openTotal}) still to match to an invoice:\n${bullets(d.open.map((r) => `${r.amount} from ${r.payer} · ref ${r.ref}${r.received ? ` · ${r.received}` : ''}${r.suggestion ? ` · likely ${r.suggestion}` : ''}`))}${end('Payments to Match', href)}`;
    },
  },
  {
    name: 'page_expenses_bills',
    label: 'Expenses & Bills',
    href: '/admin/finance/expenses',
    surface: 'admin',
    can: admin('Expenses & Bills'),
    keywords: /\b(vendor bills?|vendors?|bills? to pay|payables?|company expenses|expenses (and|&) bills)\b/,
    examples: ['Which vendor bills do we have to pay?', 'Show company expenses this month'],
    description: 'Company expenses and vendor bills: waiting for a decision, approved but not paid, paid this month, billable not yet re-billed, and the bills to pay next.',
    load: async (ref, me): Promise<BillsData> => {
      const v = await svc(ref, ExpensesService).list(me, {});
      const toPay = v.rows.filter((r) => r.status === 'approved' || r.status === 'submitted').sort((a, b) => (a.dueDate ?? a.date).localeCompare(b.dueDate ?? b.date));
      return {
        waiting: formatINR(v.totals.waitingPaise),
        approvedUnpaid: formatINR(v.totals.approvedUnpaidPaise),
        paidThisMonth: formatINR(v.totals.paidThisMonthPaise),
        billableUnbilled: formatINR(v.totals.billableUnbilledPaise),
        waitingCount: v.rows.filter((r) => r.status === 'submitted').length,
        toPay: toPay.slice(0, 10).map((r) => ({
          vendor: redact(r.vendorName) || redact(r.description).slice(0, 60),
          bill: r.billNumber ? redact(r.billNumber) : null,
          amount: formatINR(r.payablePaise),
          due: day(r.dueDate),
          kind: r.kind === 'vendor_bill' ? 'bill' : 'expense',
          status: r.status === 'submitted' ? 'waiting for a decision' : 'approved, not paid',
        })),
        allCompany: canReadFinance(me),
      };
    },
    answer: (d: BillsData) => {
      const head = `${d.allCompany ? 'Company' : 'Your'} expenses and bills: ${d.approvedUnpaid} approved and not paid yet, ${d.waiting} waiting for a decision (${d.waitingCount}), ${d.paidThisMonth} paid this month. Billable to clients, not re-billed yet: ${d.billableUnbilled}.`;
      const rows = d.toPay.length ? `\n\nTo pay or decide:\n${bullets(d.toPay.map((r) => `${r.vendor}${r.bill ? ` (${r.bill})` : ''} · ${r.amount} · ${r.kind}, ${r.status}${r.due ? ` · due ${r.due}` : ''}`))}` : '\n\nNothing is waiting to be paid.';
      return `${head}${rows}${end('Expenses & Bills', '/admin/finance/expenses')}`;
    },
  },
  {
    name: 'page_credit_notes',
    label: 'Credit Notes',
    href: '/admin/finance/credit-notes',
    surface: 'admin',
    can: admin('Credit Notes'),
    keywords: /\bcredit ?notes?\b/,
    examples: ['Show the credit notes', 'How much have we given in credit notes?'],
    description: 'Credit notes issued against invoices: count, total and the latest with their reasons.',
    load: async (ref, me): Promise<CreditNotesData> => {
      const v = await svc(ref, FinanceService).creditNotes(me);
      return {
        count: v.rows.length,
        total: formatINR(v.totalPaise),
        latest: v.rows.slice(0, 10).map((n) => ({ number: n.number, invoice: n.invoiceNumber, client: n.client, total: formatINR(n.totalPaise), reason: redact(n.reason).slice(0, 120), when: day(n.createdAt) })),
      };
    },
    answer: (d: CreditNotesData) => {
      const href = '/admin/finance/credit-notes';
      if (!d.count) return `No credit notes have been issued.${end('Credit Notes', href)}`;
      return `${plural(d.count, 'credit note')}, ${d.total} in all (with GST). Latest:\n${bullets(d.latest.map((n) => `${n.number} on ${n.invoice} · ${n.client} · ${n.total}${n.when ? ` · ${n.when}` : ''}: ${n.reason}`))}${end('Credit Notes', href)}`;
    },
  },
  {
    name: 'page_creator_payouts',
    label: 'Creator Payouts',
    href: '/admin/finance/payouts',
    surface: 'admin',
    can: admin('Creator Payouts'),
    keywords: /\b(creator payouts?|payouts?|pay(ing)? (the )?creators?)\b/,
    examples: ['Show creator payouts', 'How much is left to pay in creator payouts?'],
    description: 'Payouts to creators: pending and paid (net of TDS), TDS deducted, and the pending payouts by creator.',
    load: async (ref, me): Promise<PayoutsData> => {
      const v = await svc(ref, FinanceService).payouts(me);
      const pending = v.rows.filter((r) => r.status === 'pending');
      return {
        pending: formatINR(v.pendingNetPaise),
        paid: formatINR(v.paidNetPaise),
        tds: formatINR(v.tdsPaise),
        pendingCount: pending.length,
        onHoldCount: v.rows.filter((r) => r.status === 'on_hold').length,
        pendingRows: pending.slice(0, 10).map((r) => ({ creator: r.creator, brief: r.brief ? redact(r.brief).slice(0, 80) : null, net: formatINR(r.netPaise), since: day(r.createdAt) })),
      };
    },
    answer: (d: PayoutsData) => {
      const head = `Creator payouts: ${d.pending} still to pay (${plural(d.pendingCount, 'payout')}${d.onHoldCount ? `, ${d.onHoldCount} on hold` : ''}), ${d.paid} paid so far, ${d.tds} TDS deducted.`;
      const rows = d.pendingRows.length ? `\n\nTo pay:\n${bullets(d.pendingRows.map((r) => `${r.creator}${r.brief ? ` · ${r.brief}` : ''} · ${r.net}${r.since ? ` · added ${r.since}` : ''}`))}` : '';
      return `${head}${rows}${end('Creator Payouts', '/admin/finance/payouts')}`;
    },
  },
  {
    name: 'page_profit',
    label: 'Profit',
    href: '/admin/finance/profit',
    surface: 'admin',
    can: admin('Profit'),
    keywords: /\b(profit|profits|net margin|profit margin|labour cost|making (a )?loss|loss[- ]making)\b/,
    examples: ['How much profit did we make?', 'What is our profit by client?'],
    description: 'Profit for the last three months: revenue, costs (labour, payouts, expenses), profit and margin, with the most and least profitable clients.',
    load: async (ref, me): Promise<ProfitData> => {
      const v = await svc(ref, ProfitService).profit(me);
      const t = v.totals;
      const rows = v.byClient.map((c) => ({ name: c.label, profitPaise: c.profitPaise, profit: formatINR(c.profitPaise), margin: pct(c.marginPct) }));
      const sorted = [...rows].sort((a, b) => b.profitPaise - a.profitPaise);
      const strip = (r: (typeof rows)[number]) => ({ name: r.name, profit: r.profit, margin: r.margin });
      return {
        from: day(v.from),
        to: day(v.to),
        revenue: formatINR(t.revenuePaise),
        costs: formatINR(t.labourPaise + t.payoutsPaise + t.expensesPaise),
        profit: formatINR(t.profitPaise),
        margin: pct(t.marginPct),
        hours: Math.round(t.hours),
        topClients: sorted.slice(0, 5).map(strip),
        lowClients: sorted.length > 5 ? sorted.slice(-3).reverse().map(strip) : [],
      };
    },
    answer: (d: ProfitData) => {
      const head = `${d.from && d.to ? `${d.from} – ${d.to}` : 'This period'}: revenue ${d.revenue}, costs ${d.costs}, profit ${d.profit} (margin ${d.margin}, ${d.hours} hours logged).`;
      const top = d.topClients.length ? `\n\nMost profitable clients:\n${bullets(d.topClients.map((c) => `${c.name}: ${c.profit} (${c.margin})`))}` : '\n\nNo client revenue in this period.';
      const low = d.lowClients.length ? `\n\nLeast profitable:\n${bullets(d.lowClients.map((c) => `${c.name}: ${c.profit} (${c.margin})`))}` : '';
      return `${head}${top}${low}${end('Profit', '/admin/finance/profit')}`;
    },
  },
  {
    name: 'page_cash_flow',
    label: 'Cash Flow',
    href: '/admin/finance/cashflow',
    surface: 'admin',
    can: admin('Cash Flow'),
    keywords: /\b(cash ?flow|bank balance|cash forecast|run out of cash|lowest balance|cash position)\b/,
    examples: ['What does our cash flow look like?', 'When is our lowest bank balance?'],
    description: 'Weekly cash-flow forecast: opening balance, money in and out each week, and the lowest balance ahead.',
    load: async (ref, me): Promise<CashflowData> => {
      const v = await svc(ref, CashflowService).forecast(me);
      return {
        opening: formatINR(v.openingPaise),
        asOf: day(v.asOf),
        lowest: formatINR(v.lowestPaise),
        lowestWeek: day(v.lowestWeek),
        negative: v.lowestPaise < 0,
        weeks: v.weeks.slice(0, 6).map((w) => ({ week: day(w.weekStart), in: formatINR(w.inPaise), out: formatINR(w.outPaise), closing: formatINR(w.closingPaise) })),
      };
    },
    answer: (d: CashflowData) => {
      const low = `Lowest balance ahead: ${d.lowest}${d.lowestWeek ? ` (week of ${d.lowestWeek})` : ''}${d.negative ? ' — the bank goes below zero, plan collections or delay bills.' : '.'}`;
      return `Opening balance ${d.opening}${d.asOf ? ` (as of ${d.asOf})` : ''}. ${low}\n\nNext weeks:\n${bullets(d.weeks.map((w) => `Week of ${w.week}: in ${w.in}, out ${w.out}, closing ${w.closing}`))}${end('Cash Flow', '/admin/finance/cashflow')}`;
    },
  },
  {
    name: 'page_gst_settings',
    label: 'GST & Invoice Settings',
    href: '/admin/finance/gst',
    surface: 'admin',
    can: admin('GST & Invoice Settings'),
    keywords: /\b(gst (settings|summary|for|this month|last month|collected|filing|returns?|rate|number|details|report)|gstin|sac code|invoice (prefix|numbering|settings))\b/,
    examples: ["What's our GST summary this month?", 'What GSTIN and invoice prefix do we use?'],
    description: "This month's GST summary (invoices, taxable value, GST, credit notes) and the GST and invoice settings (GSTIN, state, rate, SAC, prefix). Bank details are only reported as set or not.",
    load: async (ref, me): Promise<GstData> => {
      const [g, all] = await Promise.all([svc(ref, FinanceService).gst(me), settingsOf(ref, me)]);
      const s = all.gst;
      return {
        month: g.monthLabel,
        ratePct: g.ratePct,
        invoiceCount: g.invoiceCount,
        taxable: formatINR(g.taxablePaise),
        gst: formatINR(g.gstPaise),
        total: formatINR(g.totalPaise),
        creditNotes: { count: g.creditNotes.count, gst: formatINR(g.creditNotes.gstPaise) },
        settings: { gstin: s.gstin || null, legalName: s.legalName, state: s.state, sacCode: s.sacCode, invoicePrefix: s.invoicePrefix, bankDetailsSet: !!(s.bankAccount && s.bankIfsc), upiSet: !!s.upiId },
      };
    },
    answer: (d: GstData) => {
      const s = d.settings;
      const cn = d.creditNotes.count ? ` ${plural(d.creditNotes.count, 'credit note')} reduce GST by ${d.creditNotes.gst}.` : '';
      return `${d.month}: ${plural(d.invoiceCount, 'invoice')}, taxable ${d.taxable}, GST ${d.gst} at ${d.ratePct}% (total ${d.total}).${cn}\n\nSettings:\n${bullets([
        `GSTIN: ${s.gstin ?? 'not set'} · ${s.legalName}, ${s.state}`,
        `SAC code ${s.sacCode || 'not set'} · invoice prefix ${s.invoicePrefix}`,
        `Bank details on invoices: ${yes(s.bankDetailsSet)} · UPI ID: ${yes(s.upiSet)}`,
      ])}${end('GST & Invoice Settings', '/admin/finance/gst')}`;
    },
  },
  {
    name: 'page_accounting_sync',
    label: 'Accounting Sync',
    href: '/admin/finance/accounting',
    surface: 'admin',
    can: admin('Accounting Sync'),
    keywords: /\b(accounting (sync|tool|export|software)|tally|zoho books|quickbooks|export to (tally|accounting|zoho|quickbooks))\b/,
    examples: ['Which accounting tool are we syncing to?', 'When did we last export to Tally?'],
    description: 'Which accounting tool (Tally, Zoho Books, QuickBooks or none) the books are exported to, and when the last export was.',
    load: async (ref, me): Promise<AccountingData> => {
      const a = (await settingsOf(ref, me)).accounting;
      const names: Record<string, string> = { none: 'none', tally: 'Tally', zoho_books: 'Zoho Books', quickbooks: 'QuickBooks' };
      return { tool: names[a.tool] ?? a.tool, connected: a.tool !== 'none', lastExport: day(a.lastExportAt) };
    },
    answer: (d: AccountingData) =>
      `${d.connected ? `Accounting tool: ${d.tool}.` : 'No accounting tool is chosen yet.'} ${d.lastExport ? `Last export: ${d.lastExport}.` : 'Nothing has been exported yet.'}${end('Accounting Sync', '/admin/finance/accounting')}`,
  },

  // ------------------------------------------------------------------------------------------------ Platform
  {
    name: 'page_system_health',
    label: 'System Health',
    href: '/admin/system',
    surface: 'admin',
    can: admin('System Health'),
    keywords: /\b(system health|system (status|healthy|ok)|is the system|background jobs?|failed events?|event failures?|search index|server (health|status))\b/,
    examples: ['Is the system healthy?', 'Show system health'],
    description: 'System health: database, background jobs that are off, failed events, running processes and the search index.',
    load: async (ref, me): Promise<HealthData> => {
      const h = await svc(ref, SystemService).health(me);
      return {
        version: h.version,
        database: h.database,
        eventsLastHour: h.events.lastHour,
        failureCount: h.events.failures.length,
        failures: h.events.failures.slice(0, 5).map((f) => ({ subscriber: f.subscriber, event: f.eventKind, status: f.status, error: redact(f.error).slice(0, 120) })),
        jobsOff: h.jobs.filter((j) => !j.on).map((j) => j.name),
        processes: { alive: (h.processes ?? []).filter((p) => p.alive).length, total: (h.processes ?? []).length },
        search: { documents: h.search.documents, building: h.search.building },
        realtime: { people: h.realtime.people },
      };
    },
    answer: (d: HealthData) => {
      const ok = d.database.ok && !d.failureCount;
      const lines = [
        `Database: ${d.database.ok ? `OK (${d.database.ms} ms)` : 'not answering'}`,
        `Events in the last hour: ${d.eventsLastHour}; failed: ${d.failureCount}`,
        d.processes.total ? `Backend processes alive: ${d.processes.alive} of ${d.processes.total}` : '',
        d.jobsOff.length ? `Background jobs switched off: ${d.jobsOff.join(', ')}` : 'All background jobs are on',
        `Search index: ${d.search.documents} records${d.search.building ? ' (rebuilding)' : ''}`,
        `People online now: ${d.realtime.people}`,
      ].filter(Boolean);
      const failures = d.failures.length ? `\n\nFailed events:\n${bullets(d.failures.map((f) => `${f.subscriber} · ${f.event} · ${f.status}: ${f.error}`))}` : '';
      return `${ok ? 'The system looks healthy' : 'The system needs a look'} (version ${d.version}).\n${bullets(lines)}${failures}${end('System Health', '/admin/system')}`;
    },
  },
  {
    name: 'page_ai_copilot',
    label: 'AI Copilot',
    href: '/admin/ai',
    surface: 'admin',
    can: admin('AI Copilot'),
    keywords: /\b(ai (usage|copilot|cost|costs|spend|budget|calls)|copilot (usage|settings|cost)|ask bmu usage|tokens? used)\b/,
    examples: ['How much AI usage this month?', 'What is the AI budget used so far?'],
    description: "Ask BMU / AI usage this month: calls (AI vs basic mode), blocked and errors, cost against the budget, top features and users, and whether an AI key is connected (never the key).",
    load: async (ref, me): Promise<AiUsageData> => {
      const u = await svc(ref, AiService).usage(me);
      return {
        month: u.month.label,
        connected: u.connected,
        enabled: u.settings.enabled,
        calls: u.month.calls,
        aiCalls: u.month.aiCalls,
        basicCalls: u.month.basicCalls,
        blocked: u.month.blocked,
        errors: u.month.errors,
        cost: formatINR(u.month.costPaise),
        budget: u.settings.monthlyBudgetPaise ? formatINR(u.settings.monthlyBudgetPaise) : 'no limit',
        budgetPct: u.month.budgetPct,
        topFeatures: [...u.byFeature].sort((a, b) => b.calls - a.calls).slice(0, 5).map((f) => ({ label: f.label, calls: f.calls })),
        topUsers: [...u.byUser].sort((a, b) => b.calls - a.calls).slice(0, 5).map((x) => ({ name: x.name, calls: x.calls })),
      };
    },
    answer: (d: AiUsageData) => {
      const state = !d.enabled ? 'AI is switched off.' : d.connected ? 'An AI key is connected.' : 'No AI key is connected, so Ask BMU runs in basic mode.';
      const head = `${d.month}: ${plural(d.calls, 'call')} (${d.aiCalls} AI, ${d.basicCalls} basic mode${d.blocked ? `, ${d.blocked} blocked` : ''}${d.errors ? `, ${d.errors} errors` : ''}). Cost ${d.cost} of ${d.budget}${d.budgetPct !== null ? ` (${pct(d.budgetPct)})` : ''}. ${state}`;
      const feats = d.topFeatures.length ? `\n\nMost used:\n${bullets(d.topFeatures.map((f) => `${f.label}: ${f.calls}`))}` : '';
      const users = d.topUsers.length ? `\n\nTop users:\n${bullets(d.topUsers.map((x) => `${x.name}: ${x.calls}`))}` : '';
      return `${head}${feats}${users}${end('AI Copilot', '/admin/ai')}`;
    },
  },
  {
    name: 'page_notification_templates',
    label: 'Notification Templates',
    href: '/admin/notification-templates',
    surface: 'admin',
    can: admin('Notification Templates'),
    keywords: /\b(notification templates?|notification (channels?|settings)|message templates?|whatsapp templates?)\b/,
    examples: ['Which notification templates send WhatsApp?', 'Show notification templates'],
    description: 'Notification templates: for each kind of notice, whether it goes in-app, by email and by WhatsApp, and whether its text is customised.',
    load: async (ref, me): Promise<TemplatesData> => {
      const t = (await settingsOf(ref, me)).notificationTemplates;
      const rows = NOTIFICATION_KINDS.map((k) => ({ k, v: t[k.key] })).filter((r) => r.v);
      return {
        total: rows.length,
        email: rows.filter((r) => r.v.email).length,
        whatsapp: rows.filter((r) => r.v.whatsapp).length,
        inAppOff: rows.filter((r) => !r.v.inApp).length,
        custom: rows.filter((r) => r.v.text.trim()).length,
        templates: rows.map(({ k, v }) => ({ label: k.label, audience: k.audience, channels: [v.inApp && 'in-app', v.email && 'email', v.whatsapp && 'WhatsApp'].filter(Boolean).join(', ') || 'off' })),
      };
    },
    answer: (d: TemplatesData, q: string) => {
      const href = '/admin/notification-templates';
      if (!d.total) return `No notification templates are set up.${end('Notification Templates', href)}`;
      const list = /whatsapp/.test(q) ? d.templates.filter((t) => /WhatsApp/.test(t.channels)) : d.templates;
      const head = `${plural(d.total, 'notification')}: ${d.email} by email, ${d.whatsapp} by WhatsApp${d.inAppOff ? `, ${d.inAppOff} with in-app off` : ''}; ${d.custom} with custom text.`;
      const rows = list.length ? `\n${bullets(list.map((t) => `${t.label} (${t.audience}): ${t.channels}`), 15)}` : '\nNone of them is sent by WhatsApp yet.';
      return `${head}${rows}${end('Notification Templates', href)}`;
    },
  },
  {
    name: 'page_outbox',
    label: 'Outbox',
    href: '/admin/outbox',
    surface: 'admin',
    can: admin('Outbox'),
    keywords: /\b(outbox|emails? (sent|failed|bounced|queue)|failed emails?|email queue|smtp)\b/,
    examples: ['Any failed emails in the outbox?', 'Show the email queue'],
    description: 'Email outbox: whether email sending is set up, emails in the last 7 days, failed emails and their errors, by kind.',
    load: async (ref, me): Promise<OutboxData> => {
      const v = await svc(ref, ServiceController).outbox(me);
      return {
        emailReady: v.smtp.configured,
        total: v.counts.total,
        last7Days: v.counts.last7Days,
        failed: v.counts.failed,
        byKind: v.counts.byKind.slice(0, 6).map((k) => ({ kind: words(k.kind), count: k.count })),
        recentFailed: v.rows.filter((r) => r.status === 'failed').slice(0, 5).map((r) => ({ subject: redact(r.subject).slice(0, 80), kind: words(r.kind), when: dateTime(r.createdAt), error: redact(r.error).slice(0, 120) })),
      };
    },
    answer: (d: OutboxData) => {
      const head = `${d.emailReady ? 'Email sending is set up.' : 'Email sending is not set up yet, so emails wait in the outbox.'} ${plural(d.last7Days, 'email')} in the last 7 days, ${d.total} in all, ${d.failed} failed.`;
      const kinds = d.byKind.length ? `\n\nBy kind:\n${bullets(d.byKind.map((k) => `${k.kind}: ${k.count}`))}` : '';
      const failed = d.recentFailed.length ? `\n\nRecent failures:\n${bullets(d.recentFailed.map((f) => `${f.subject} (${f.kind}${f.when ? `, ${f.when}` : ''}): ${f.error || 'no error text'}`))}` : '';
      return `${head}${kinds}${failed}${end('Outbox', '/admin/outbox')}`;
    },
  },
  {
    name: 'page_integrations',
    label: 'Integrations',
    href: '/admin/integrations',
    surface: 'admin',
    can: admin('Integrations'),
    keywords: /\b(integrations?|is (razorpay|whatsapp|email|smtp|storage) (connected|set ?up|configured|on)|razorpay (connected|set ?up|configured))\b/,
    examples: ['Which integrations are connected?', 'Is Razorpay set up?'],
    description: 'Which integrations are connected (Razorpay, email, WhatsApp, file storage, accounting). On/off only, never keys.',
    load: async (ref, me): Promise<IntegrationsData> => {
      const rows = await svc(ref, PlatformController).integrations(me);
      const names: Record<string, string> = { razorpay: 'Razorpay (online payments)', email: 'Email (SMTP)', whatsapp: 'WhatsApp', storage: 'File storage', accounting: 'Accounting export' };
      return {
        rows: rows.map((r) => ({
          name: names[r.key] ?? r.key,
          connected: r.configured,
          note: r.key === 'storage' && r.usingDefault ? 'default folder' : r.key === 'accounting' && r.accountingTool && r.accountingTool !== 'none' ? words(r.accountingTool) : null,
        })),
      };
    },
    answer: (d: IntegrationsData) => {
      const on = d.rows.filter((r) => r.connected).length;
      return `${on} of ${d.rows.length} integrations connected:\n${bullets(d.rows.map((r) => `${r.name}: ${r.connected ? 'connected' : 'not connected'}${r.note ? ` (${r.note})` : ''}`))}${end('Integrations', '/admin/integrations')}`;
    },
  },
  {
    name: 'page_api_webhooks',
    label: 'API & Webhooks',
    href: '/admin/developer',
    surface: 'admin',
    can: admin('API & Webhooks'),
    keywords: /\b(api keys?|webhooks?|developer (settings|keys|page))\b/,
    examples: ['How many API keys are active?', 'Are any webhooks failing?'],
    description: 'API keys (names, scopes count, last used, expiry; never the key) and webhooks (host, events, on/off, failing, deliveries; never the secret).',
    load: async (ref, me): Promise<DeveloperData> => {
      const [keys, hooks] = await Promise.all([svc(ref, ApiKeysService).list(me), svc(ref, WebhooksService).list(me)]);
      const now = Date.now();
      const active = keys.filter((k) => !k.revokedAt && (!k.expiresAt || new Date(k.expiresAt).getTime() > now));
      return {
        activeKeys: active.length,
        revokedKeys: keys.filter((k) => k.revokedAt).length,
        keys: active.slice(0, 10).map((k) => ({ name: redact(k.name), scopes: k.scopes.length, lastUsed: day(k.lastUsedAt), expires: day(k.expiresAt) })),
        webhooks: hooks.slice(0, 10).map((w) => ({ host: hostOf(w.url), events: w.events.length, active: w.active, failingSince: day(w.failingSince), delivered: w.stats.delivered, dead: w.stats.dead })),
      };
    },
    answer: (d: DeveloperData) => {
      const keys = d.activeKeys ? `${plural(d.activeKeys, 'active API key')}${d.revokedKeys ? ` (${d.revokedKeys} revoked)` : ''}:\n${bullets(d.keys.map((k) => `${k.name} · ${plural(k.scopes, 'scope')} · ${k.lastUsed ? `last used ${k.lastUsed}` : 'never used'}${k.expires ? ` · expires ${k.expires}` : ''}`))}` : 'No active API keys.';
      const failing = d.webhooks.filter((w) => w.failingSince).length;
      const hooks = d.webhooks.length
        ? `${plural(d.webhooks.length, 'webhook')}${failing ? `, ${failing} failing` : ', none failing'}:\n${bullets(d.webhooks.map((w) => `${w.host} · ${plural(w.events, 'event')} · ${w.active ? 'on' : 'off'}${w.failingSince ? ` · failing since ${w.failingSince}` : ''} · ${w.delivered} delivered${w.dead ? `, ${w.dead} gave up` : ''}`))}`
        : 'No webhooks.';
      return `${keys}\n\n${hooks}${end('API & Webhooks', '/admin/developer')}`;
    },
  },
  {
    name: 'page_branding',
    label: 'Branding & Theme',
    href: '/admin/branding',
    surface: 'admin',
    can: admin('Branding & Theme'),
    keywords: /\b(branding|theme colou?rs?|our theme|logo|client app name|app colou?rs?)\b/,
    examples: ['Show our branding and theme', 'What logo do clients see?'],
    description: 'Branding used on client-facing screens and documents: client app name, colours and whether a logo is set.',
    load: async (ref, me): Promise<BrandingData> => {
      const b = (await settingsOf(ref, me)).branding;
      return { clientAppName: b.clientAppName, primary: b.primary, accent: b.accent, background: b.background, logoSet: !!b.logoUrl.trim() };
    },
    answer: (d: BrandingData) =>
      `Clients see the app as "${d.clientAppName}". Colours: primary ${d.primary}, accent ${d.accent}, background ${d.background}. ${d.logoSet ? 'A logo is set.' : 'No logo is set yet (the default is used).'}${end('Branding & Theme', '/admin/branding')}`,
  },
  {
    name: 'page_security',
    label: 'Security',
    href: '/admin/security',
    surface: 'admin',
    can: admin('Security'),
    keywords: /\b(security settings|security page|two[- ]factor|2fa|session (length|days|timeout)|sign[- ]in security|field access|hidden fields)\b/,
    examples: ['Which roles need two-factor sign-in?', 'Show security settings'],
    description: 'Sign-in security (roles that must use two-factor, session length) and how many protected fields are hidden or read-only for some roles.',
    load: async (ref, me): Promise<SecurityData> => {
      const [all, f] = await Promise.all([settingsOf(ref, me), svc(ref, SecurityAdminController).fieldAccess(me)]);
      const label = new Map(f.roles.map((r) => [r.id, r.label]));
      const restricted = f.fields.filter((x) => Object.values(x.modes).some((m) => m !== 'edit'));
      return {
        twoFactorRoles: all.security.require2faRoles.map((r) => label.get(r) ?? words(r)),
        sessionDays: all.security.sessionDays,
        restrictedFields: restricted.length,
        totalFields: f.fields.length,
        examples: restricted.slice(0, 5).map((x) => x.label),
      };
    },
    answer: (d: SecurityData) => {
      const tfa = d.twoFactorRoles.length ? `Two-factor sign-in is required for: ${d.twoFactorRoles.join(', ')}.` : 'No role is required to use two-factor sign-in.';
      const fields = `${d.restrictedFields} of ${d.totalFields} protected fields are hidden or read-only for some roles${d.examples.length ? ` (e.g. ${d.examples.join(', ')})` : ''}.`;
      return `${tfa} Sessions last ${plural(d.sessionDays, 'day')}. ${fields}${end('Security', '/admin/security')}`;
    },
  },
  {
    name: 'page_audit_log',
    label: 'Audit Log',
    href: '/admin/audit',
    surface: 'admin',
    can: admin('Audit Log'),
    keywords: /\b(audit (log|trail)|who changed|change history|changes made)\b/,
    examples: ['Show the audit log', 'Who changed what recently?'],
    description: 'The latest audit log entries (who did what, on which record, when) within this person’s scope; record contents are not included.',
    load: async (ref, me): Promise<AuditData> => {
      // The route's guard checks the audit_log capability; calling the controller directly, so check it here too.
      if ((me.permissions.audit_log?.scope ?? 'none') === 'none') throw new ForbiddenException("You don't have access to the audit log");
      const p = await svc(ref, AuditController).search(me, {});
      return {
        total: p.total,
        scope: p.scope,
        latest: p.rows.slice(0, 10).map((r) => ({ action: words(r.action).replaceAll('.', ' · '), record: r.entity, who: r.actor?.name ?? 'System', when: dateTime(r.at) })),
      };
    },
    answer: (d: AuditData) => {
      const href = '/admin/audit';
      if (!d.total) return `The audit log is empty.${end('Audit Log', href)}`;
      return `${plural(d.total, 'entry', 'entries')}${d.scope === 'branch' ? ' (changes by people in your branch)' : ''}. Latest:\n${bullets(d.latest.map((r) => `${r.when ?? ''} · ${r.who}: ${r.action} (${r.record})`))}${end('Audit Log', href)}`;
    },
  },
  {
    name: 'page_data_export',
    label: 'Data Export / Deletion (DPDP)',
    href: '/admin/data',
    surface: 'admin',
    can: admin('Data Export / Deletion (DPDP)'),
    keywords: /\b(data (export|deletion)|export (a |the )?(client'?s? )?data|delete (a |the )?client'?s? data|anonymi[sz](e|ed|ation)|client data)\b/,
    examples: ['Show data export and deletion', 'Which clients have anonymised users?'],
    description: 'Clients whose data this person can export or delete (DPDP): users, anonymised users, engagements, unpaid invoices, and the retention period.',
    load: async (ref, me): Promise<DataExportData> => {
      const v = await svc(ref, PlatformController).dataClients(me);
      return {
        clients: v.clients.length,
        retentionDays: v.retentionDays,
        anonymisedUsers: v.clients.reduce((s, c) => s + c.anonymisedUsers, 0),
        rows: v.clients.slice(0, 10).map((c) => ({ name: c.name, users: c.users, engagements: c.engagements, unpaidInvoices: c.unpaidInvoices })),
      };
    },
    answer: (d: DataExportData) => {
      const href = '/admin/data';
      if (!d.clients) return `There are no clients whose data you can export or delete.${end('Data Export / Deletion (DPDP)', href)}`;
      return `${plural(d.clients, 'client')} you can export or delete data for; ${plural(d.anonymisedUsers, 'user')} already anonymised. Data is kept for ${d.retentionDays} days.\n${bullets(d.rows.map((c) => `${c.name}: ${plural(c.users, 'user')}, ${plural(c.engagements, 'engagement')}${c.unpaidInvoices ? `, ${plural(c.unpaidInvoices, 'unpaid invoice')} (settle before deleting)` : ''}`))}${end('Data Export / Deletion (DPDP)', href)}`;
    },
  },
  {
    name: 'page_admin_privacy',
    label: 'Privacy (DPDP)',
    href: '/admin/privacy',
    surface: 'admin',
    can: admin('Privacy (DPDP)'),
    keywords: /\b(dpdp|privacy|consents?|retention rules?|data protection|data requests?)\b/,
    examples: ['How many people withdrew consent?', 'Show the DPDP privacy page'],
    description: 'Privacy (DPDP): open data requests and which are overdue, consents given and withdrawn, and retention rules switched on.',
    load: async (ref, me): Promise<PrivacyData> => {
      const v = await svc(ref, DpdpService).overview(me);
      const open = v.requests.filter((r) => r.status === 'open' || r.status === 'in_progress');
      return {
        open: open.length,
        overdue: open.filter((r) => r.overdue).length,
        requests: open.slice(0, 10).map((r) => ({ kind: words(r.kind), requester: redact(r.requesterName), status: words(r.status), due: day(r.dueAt), overdue: r.overdue })),
        consents: { total: v.consents.total, marketing: v.consents.marketing, withdrawn: v.consents.withdrawn },
        retentionOn: v.retention.filter((r) => r.enabled).length,
        retentionTotal: v.retention.length,
      };
    },
    answer: (d: PrivacyData) => {
      const req = d.open ? `${plural(d.open, 'data request')} open${d.overdue ? `, ${d.overdue} past the due date` : ''}:\n${bullets(d.requests.map((r) => `${r.kind} from ${r.requester} · ${r.status}${r.due ? ` · due ${r.due}` : ''}${r.overdue ? ' · overdue' : ''}`))}` : 'No open data requests.';
      return `${req}\n\nConsents: ${d.consents.total} recorded, ${d.consents.marketing} active for marketing, ${d.consents.withdrawn} withdrawn. Retention rules on: ${d.retentionOn} of ${d.retentionTotal}.${end('Privacy (DPDP)', '/admin/privacy')}`;
    },
  },
  {
    name: 'page_tenant_settings',
    label: 'Tenant Settings',
    href: '/admin/tenant',
    surface: 'admin',
    can: admin('Tenant Settings'),
    keywords: /\b(tenant|company (details|name|settings|profile)|support (email|phone|number)|data retention|our plan|organi[sz]ation settings)\b/,
    examples: ['Show tenant settings', 'What support email and phone do clients see?'],
    description: 'Tenant settings: company name, support email, phone and website shown to clients, data retention, plan, and client and staff counts.',
    load: async (ref, me): Promise<TenantData> => {
      const [all, info] = await Promise.all([settingsOf(ref, me), svc(ref, PlatformController).tenant(me).catch(() => null)]);
      const t = all.tenant;
      return { name: t.name, supportEmail: t.supportEmail, supportPhone: t.supportPhone, website: t.website, retentionDays: t.dataRetentionDays, plan: info?.plan ?? null, clients: info?.clients ?? null, staff: info?.staff ?? null };
    },
    answer: (d: TenantData) => {
      const rows = [
        `Company name: ${d.name}`,
        `Support email: ${d.supportEmail || 'not set'} · phone: ${d.supportPhone || 'not set'}`,
        `Website: ${d.website || 'not set'}`,
        `Data kept for ${d.retentionDays} days`,
        d.plan ? `Plan: ${d.plan}${d.clients !== null ? ` · ${plural(d.clients, 'client')}, ${plural(d.staff ?? 0, 'team member')}` : ''}` : '',
      ].filter(Boolean);
      return `Tenant settings:\n${bullets(rows)}${end('Tenant Settings', '/admin/tenant')}`;
    },
  },
];
