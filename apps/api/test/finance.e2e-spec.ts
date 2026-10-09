// v18 finance 2.0 and capacity: a Razorpay webhook marks the invoice paid and thanks the client on their thread;
// pay links and the public pay page; unmatched payments and matching; profit per client checked against a hand
// calculation; expenses, vendor bills and re-billing; TDS on payments; invoice schedules; the stopwatch; cash flow;
// the workload heatmap, booking (refused on approved leave) and the Producer / Finance collector agents.
import 'dotenv/config';
import { createHmac } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { AgentEvalResult, AgentProposalView, BookingResult, CashflowView, ExpenseList, ExpenseRow, InvoiceScheduleRow, PaymentLinkView, ProfitView, PublicPayView, TimerStopResult, TimerView, UnmatchedList, WorkloadView } from '@bmu/shared';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { BillingService } from '../src/requests/billing.service.js';
import { SettingsService } from '../src/settings/settings.service.js';
import { SchedulesService } from '../src/money/schedules.service.js';
import { addDays, dbDate, mondayOf, todayIst } from '../src/money/dates.js';

delete process.env.ANTHROPIC_API_KEY;
delete process.env.RAZORPAY_KEY_ID;
delete process.env.RAZORPAY_KEY_SECRET;
const SECRET = 'whsec_test_v18';
process.env.RAZORPAY_WEBHOOK_SECRET = SECRET;

let app: INestApplication;
let prisma: PrismaService;
let orgId: string;
let clientId: string;
let engId: string;
const tokens: Record<string, string> = {};
const users: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const stamp = Date.now();
const today = todayIst();
const cleanup: { leaves: string[]; bookings: string[] } = { leaves: [], bookings: [] };

async function signIn(email: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier: email }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier: email, code: otp.body.devCode }).expect(200)).body.token as string;
}

const sign = (body: unknown) => createHmac('sha256', SECRET).update(JSON.stringify(body)).digest('hex');
const webhook = (body: unknown, signature = sign(body)) => http().post('/webhooks/razorpay').set('Content-Type', 'application/json').set('X-Razorpay-Signature', signature).send(JSON.stringify(body));

async function issue(amountPaise: number, extra: { dueInDays?: number; client?: string; engagementId?: string | null } = {}) {
  const billing = app.get(BillingService, { strict: false });
  return prisma.$transaction((tx) => billing.issue(tx, { orgId, clientOrgId: extra.client ?? clientId, engagementId: extra.engagementId === null ? undefined : (extra.engagementId ?? engId), kind: 'standard', lines: [{ label: `Test work ${stamp}`, amountPaise }], dueInDays: extra.dueInDays ?? 7 }));
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ rawBody: true });
  app.use(cookieParser());
  await app.init();
  prisma = app.get(PrismaService);
  const org = await prisma.organisation.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  orgId = org.id;
  for (const [k, email] of Object.entries({ founder: 'founder@bmu.demo', finance: 'finance@bmu.demo', am: 'am@bmu.demo', producer: 'producer@bmu.demo', design: 'design@bmu.demo', sales: 'sales@bmu.demo' })) {
    tokens[k] = await signIn(email);
    users[k] = (await prisma.user.findFirstOrThrow({ where: { email } })).id;
  }
  const service = await prisma.service.findFirstOrThrow({ where: { orgId } });
  const client = await prisma.clientOrg.create({ data: { orgId, name: `Finance Test ${stamp}`, amUserId: users.am } });
  clientId = client.id;
  const eng = await prisma.engagement.create({ data: { orgId, clientOrgId: clientId, serviceId: service.id, tier: 'growth', billingType: 'one_time', status: 'in_production', amId: users.am } });
  engId = eng.id;
});

afterAll(async () => {
  await prisma.leaveRequest.deleteMany({ where: { id: { in: cleanup.leaves } } });
  await prisma.resourceBooking.deleteMany({ where: { OR: [{ id: { in: cleanup.bookings } }, { engagementId: engId }] } });
  await prisma.activeTimer.deleteMany({ where: { userId: users.producer } });
  await app.close();
});

describe('Payments', () => {
  it('a Razorpay payment_link.paid webhook marks the invoice paid and posts on the client thread (once)', async () => {
    const inv = await issue(50_000_00);
    const link = (await http().post(`/money/invoices/${inv.id}/links`).set(as('finance')).expect(201)).body as PaymentLinkView;
    expect(link.provider).toBe('test');
    expect(link.amountPaise).toBe(inv.totalPaise);
    expect(link.url).toContain('/pay/');
    const token = link.url.split('/pay/')[1];
    const body = {
      event: 'payment_link.paid',
      payload: {
        payment_link: { entity: { id: `plink_${stamp}`, notes: { invoiceId: inv.id, token } } },
        payment: { entity: { id: `pay_${stamp}`, amount: inv.totalPaise, status: 'captured', notes: { invoiceId: inv.id, token } } },
      },
    };
    await webhook(body, 'bad').expect(401);
    await http().post('/webhooks/razorpay').send(body).expect(401);
    expect((await webhook(body).expect(200)).body.invoiceId).toBe(inv.id);
    await webhook(body).expect(200);
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id }, include: { payments: true } });
    expect(after.status).toBe('paid');
    expect(after.payments).toHaveLength(1);
    expect(after.payments[0].method).toBe('razorpay');
    const thread = await prisma.thread.findFirstOrThrow({ where: { clientOrgId: clientId, type: 'client_am' } });
    const msgs = await prisma.message.findMany({ where: { threadId: thread.id, body: { contains: inv.number } } });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body).toMatch(/^Payment received online: invoice .* is now fully paid/);
    expect(msgs[0].authorId).toBe(users.am);
    expect((await prisma.paymentLink.findUniqueOrThrow({ where: { token } })).status).toBe('paid');
    const pub = (await http().get(`/public/pay/${token}`).expect(200)).body as PublicPayView;
    expect(pub.status).toBe('paid');
  });

  it('the public pay page shows the balance and takes a test payment without Razorpay keys', async () => {
    const inv = await issue(12_000_00);
    const link = (await http().post(`/money/invoices/${inv.id}/links`).set(as('finance')).expect(201)).body as PaymentLinkView;
    const again = (await http().post(`/money/invoices/${inv.id}/links`).set(as('finance')).expect(201)).body as PaymentLinkView;
    expect(again.id).toBe(link.id);
    await http().post(`/money/invoices/${inv.id}/links`).set(as('am')).expect(403);
    const token = link.url.split('/pay/')[1];
    const view = (await http().get(`/public/pay/${token}`).expect(200)).body as PublicPayView;
    expect(view).toMatchObject({ status: 'due', balancePaise: inv.totalPaise, testMode: true, invoiceNumber: inv.number });
    const paid = (await http().post(`/public/pay/${token}/test`).expect(200)).body as PublicPayView;
    expect(paid.status).toBe('paid');
    await http().post(`/public/pay/${token}/test`).expect(400);
    await http().get('/public/pay/nope').expect(404);
  });

  it('money nobody can tie to an invoice waits as unmatched, with a suggestion, until Finance matches it', async () => {
    const inv = await issue(33_333_00);
    const body = { event: 'payment.captured', payload: { payment: { entity: { id: `pay_un_${stamp}`, amount: inv.totalPaise, status: 'captured', email: 'someone@example.com', order_id: `order_none_${stamp}` } } } };
    const r = (await webhook(body).expect(200)).body as { unmatched: string };
    expect(r.unmatched).toBeTruthy();
    await webhook(body).expect(200);
    expect(await prisma.unmatchedPayment.count({ where: { ref: `pay_un_${stamp}` } })).toBe(1);
    await http().get('/money/unmatched').set(as('am')).expect(403);
    const list = (await http().get('/money/unmatched').set(as('finance')).expect(200)).body as UnmatchedList;
    const row = list.open.find((u) => u.id === r.unmatched)!;
    expect(row.suggestions.some((s) => s.invoiceId === inv.id && /same amount/.test(s.reason))).toBe(true);
    const done = (await http().post(`/money/unmatched/${row.id}/match`).set(as('finance')).send({ invoiceId: inv.id }).expect(201)).body as UnmatchedList;
    expect(done.done.find((u) => u.id === row.id)?.invoiceNumber).toBe(inv.number);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('paid');
    await http().post(`/money/unmatched/${row.id}/match`).set(as('finance')).send({ invoiceId: inv.id }).expect(400);

    // A bank credit typed in by hand can be ignored.
    const added = (await http().post('/money/unmatched').set(as('finance')).send({ amountPaise: 1_000_00, ref: `NEFT ${stamp}` }).expect(201)).body as UnmatchedList;
    const manual = added.open.find((u) => u.ref === `NEFT ${stamp}`)!;
    await http().post(`/money/unmatched/${manual.id}/ignore`).set(as('finance')).expect(201);
  });

  it('records TDS deducted by the client as its own line that settles the invoice', async () => {
    const inv = await issue(10_000_00);
    const tds = 1_000_00;
    await http().post(`/finance/invoices/${inv.id}/payments`).set(as('finance')).send({ amountPaise: inv.totalPaise - tds, tdsPaise: tds, method: 'bank', ref: `TDS${stamp}` }).expect(200);
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id }, include: { payments: true } });
    expect(after.status).toBe('paid');
    expect(after.payments.map((p) => p.method).sort()).toEqual(['bank', 'tds']);
    expect(after.payments.find((p) => p.method === 'tds')?.amountPaise).toBe(tds);
  });
});

describe('Invoice schedules', () => {
  it('splits a fee into instalments that add up exactly, issues on demand and on the due date', async () => {
    const parts = [
      { label: 'Kickoff (50%)', pct: 50, dueOn: addDays(today, 30) },
      { label: 'Midway (30%)', pct: 30, dueOn: addDays(today, 60) },
      { label: 'Handover (20%)', pct: 20, dueOn: addDays(today, 90) },
    ];
    await http().post('/money/schedules/plan').set(as('am')).send({ clientOrgId: clientId, engagementId: engId, totalPaise: 1_00_001_00 + 1, parts }).expect(403);
    await http().post('/money/schedules/plan').set(as('finance')).send({ clientOrgId: clientId, engagementId: engId, totalPaise: 1_000_00, parts: parts.slice(0, 2) }).expect(400);
    const rows = (await http().post('/money/schedules/plan').set(as('finance')).send({ clientOrgId: clientId, engagementId: engId, totalPaise: 1_00_001_01, parts }).expect(201)).body as InvoiceScheduleRow[];
    expect(rows.reduce((s, r) => s + r.amountPaise, 0)).toBe(1_00_001_01);
    expect(rows.map((r) => r.status)).toEqual(['planned', 'planned', 'planned']);
    const amList = (await http().get(`/money/schedules?engagementId=${engId}`).set(as('am')).expect(200)).body as InvoiceScheduleRow[];
    expect(amList.length).toBeGreaterThanOrEqual(3);
    await http().get(`/money/schedules?engagementId=${engId}`).set(as('sales')).expect(403);
    const issued = (await http().post(`/money/schedules/${rows[0].id}/issue`).set(as('finance')).expect(201)).body as InvoiceScheduleRow;
    expect(issued.status).toBe('issued');
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: issued.invoiceId! } });
    expect(inv.subtotalPaise).toBe(rows[0].amountPaise);
    expect(inv.engagementId).toBe(engId);
    await http().post(`/money/schedules/${rows[0].id}/issue`).set(as('finance')).expect(400);
    await http().patch(`/money/schedules/${rows[0].id}`).set(as('finance')).send({ amountPaise: 5_00 }).expect(400);
    await http().patch(`/money/schedules/${rows[2].id}`).set(as('finance')).send({ status: 'skipped' }).expect(200);

    // The timer issues anything due today or earlier.
    const due = (await http().post('/money/schedules').set(as('finance')).send({ clientOrgId: clientId, label: `Due today ${stamp}`, amountPaise: 7_000_00, dueOn: today }).expect(201)).body as InvoiceScheduleRow;
    await app.get(SchedulesService, { strict: false }).tick();
    const after = await prisma.invoiceSchedule.findUniqueOrThrow({ where: { id: due.id } });
    expect(after.status).toBe('issued');
    expect(after.invoiceId).toBeTruthy();
    expect((await prisma.invoiceSchedule.findUniqueOrThrow({ where: { id: rows[2].id } })).status).toBe('skipped');
  });
});

describe('Expenses and vendor bills', () => {
  it('a claim is approved by Finance (not by the claimant), paid, and billable ones are re-billed', async () => {
    const claim = (await http().post('/money/expenses').set(as('am')).send({ category: 'travel', description: `Cab to shoot ${stamp}`, date: today, amountPaise: 900_00, clientOrgId: clientId, engagementId: engId, billable: true }).expect(201)).body as ExpenseRow;
    expect(claim.status).toBe('submitted');
    await http().post('/money/expenses').set(as('am')).send({ kind: 'vendor_bill', category: 'software', vendorName: 'X', description: 'Not allowed', date: today, amountPaise: 100_00 }).expect(403);
    await http().post('/money/expenses').set(as('am')).send({ category: 'travel', description: 'Future', date: addDays(today, 3), amountPaise: 100_00 }).expect(400);
    await http().post(`/money/expenses/${claim.id}/decide`).set(as('am')).send({ approve: true }).expect(403);
    const mine = (await http().get('/money/expenses').set(as('am')).expect(200)).body as ExpenseList;
    expect(mine.canDecide).toBe(false);
    expect(mine.rows.every((r) => r.createdById === users.am)).toBe(true);
    await http().post(`/money/expenses/${claim.id}/decide`).set(as('finance')).send({ approve: false }).expect(400);
    const ok = (await http().post(`/money/expenses/${claim.id}/decide`).set(as('finance')).send({ approve: true }).expect(201)).body as ExpenseRow;
    expect(ok.status).toBe('approved');
    await http().put(`/money/expenses/${claim.id}`).set(as('am')).send({ category: 'travel', description: 'Changed', date: today, amountPaise: 1_00 }).expect(403);
    const paid = (await http().post(`/money/expenses/${claim.id}/paid`).set(as('finance')).send({ ref: `UPI${stamp}` }).expect(201)).body as ExpenseRow;
    expect(paid.status).toBe('paid');
    const r = (await http().post('/money/expenses/rebill').set(as('finance')).send({ clientOrgId: clientId }).expect(201)).body as { invoiceId: string; count: number };
    expect(r.count).toBe(1);
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: r.invoiceId } });
    expect(inv.subtotalPaise).toBe(900_00);
    expect(JSON.stringify(inv.lines)).toContain('Re-billed: Cab to shoot');
    await http().post('/money/expenses/rebill').set(as('finance')).send({ clientOrgId: clientId }).expect(400);
    await http().delete(`/money/expenses/${claim.id}`).set(as('finance')).expect(400);

    const bill = (await http().post('/money/expenses').set(as('finance')).send({ kind: 'vendor_bill', category: 'freelancer', vendorName: 'Freelance editor', description: 'Reels', date: today, dueDate: addDays(today, 15), amountPaise: 10_000_00, tdsPaise: 1_000_00 }).expect(201)).body as ExpenseRow;
    expect(bill).toMatchObject({ status: 'approved', payablePaise: 9_000_00 });
    const all = (await http().get('/money/expenses?kind=vendor_bill').set(as('finance')).expect(200)).body as ExpenseList;
    expect(all.rows.some((x) => x.id === bill.id)).toBe(true);
    expect(all.totals.approvedUnpaidPaise).toBeGreaterThanOrEqual(9_000_00);
  });
});

describe('Profit per client', () => {
  it('matches a hand calculation: revenue minus team cost, creator payouts and expenses', async () => {
    const client = await prisma.clientOrg.create({ data: { orgId, name: `Profit Test ${stamp}`, amUserId: users.am } });
    const service = await prisma.service.findFirstOrThrow({ where: { orgId } });
    const eng = await prisma.engagement.create({ data: { orgId, clientOrgId: client.id, serviceId: service.id, tier: 'starter', billingType: 'monthly', status: 'in_production' } });
    // ₹1,00,000 fee + ₹20,000 ad spend at cost (pass-through), ₹10,000 credit note; a cancelled invoice is ignored.
    const inv = await prisma.invoice.create({
      data: { orgId, clientOrgId: client.id, engagementId: eng.id, number: `PT/${stamp}/1`, kind: 'standard', status: 'issued', dueDate: new Date(), subtotalPaise: 1_20_000_00, gstPaise: 18_000_00, totalPaise: 1_38_000_00, lines: [{ label: 'Fee', amountPaise: 1_00_000_00 }, { label: 'Ad spend', amountPaise: 20_000_00, passThrough: true }, { label: 'GST 18%', amountPaise: 18_000_00 }] },
    });
    await prisma.invoice.create({ data: { orgId, clientOrgId: client.id, engagementId: eng.id, number: `PT/${stamp}/2`, kind: 'standard', status: 'void', dueDate: new Date(), subtotalPaise: 50_000_00, gstPaise: 9_000_00, totalPaise: 59_000_00, lines: [] } });
    await prisma.creditNote.create({ data: { orgId, invoiceId: inv.id, number: `PTCN/${stamp}`, amountPaise: 10_000_00, gstPaise: 1_800_00, totalPaise: 11_800_00, reason: 'Goodwill', createdById: users.finance } });
    // 6 h producer + 3 h designer on the project; 2 h internal producer time does not count for the client.
    await prisma.timeEntry.createMany({
      data: [
        { orgId, userId: users.producer, date: dbDate(today), minutes: 360, engagementId: eng.id, category: 'task' },
        { orgId, userId: users.design, date: dbDate(today), minutes: 180, engagementId: eng.id, category: 'task', source: 'timer' },
        { orgId, userId: users.producer, date: dbDate(today), minutes: 120, category: 'internal' },
      ],
    });
    // A creator payout of ₹8,000 for a brief on this client.
    const creator = await prisma.creator.findFirst({ where: { orgId } });
    let payout = 0;
    if (creator) {
      const brief = await prisma.creatorBrief.create({ data: { orgId, creatorId: creator.id, clientOrgId: client.id, engagementId: eng.id, title: 'Reel', brief: 'One reel', deliverables: [], feePaise: 8_000_00, createdById: users.founder } });
      await prisma.creatorPayout.create({ data: { orgId, creatorId: creator.id, briefId: brief.id, amountPaise: 8_000_00, tdsPaise: 800_00, netPaise: 7_200_00 } });
      payout = 8_000_00;
    }
    // ₹5,000 approved expense (GST is not a cost); a waiting claim and a rejected one are ignored.
    await prisma.expense.createMany({
      data: [
        { orgId, category: 'production', description: 'Props', date: dbDate(today), amountPaise: 5_000_00, gstPaise: 900_00, clientOrgId: client.id, engagementId: eng.id, status: 'approved', createdById: users.am },
        { orgId, category: 'travel', description: 'Waiting', date: dbDate(today), amountPaise: 2_000_00, clientOrgId: client.id, status: 'submitted', createdById: users.am },
        { orgId, category: 'food', description: 'Rejected', date: dbDate(today), amountPaise: 3_000_00, clientOrgId: client.id, status: 'rejected', createdById: users.am },
      ],
    });

    const rates = await app.get(SettingsService).get(orgId, 'costRates');
    const producerRate = rates.hourlyPaise.producer ?? rates.hourlyPaise.default;
    const labour = Math.round((6 + 3) * producerRate * (1 + rates.overheadPct / 100));
    const revenue = 1_00_000_00 - 10_000_00;
    const expected = revenue - labour - payout - 5_000_00;

    await http().get(`/money/profit?from=${today}&to=${today}`).set(as('am')).expect(403);
    const view = (await http().get(`/money/profit?from=${today}&to=${today}`).set(as('founder')).expect(200)).body as ProfitView;
    const row = view.byClient.find((r) => r.key === client.id)!;
    expect(row).toMatchObject({ revenuePaise: revenue, labourPaise: labour, payoutsPaise: payout, expensesPaise: 5_000_00, profitPaise: expected, hours: 9 });
    expect(row.marginPct).toBeCloseTo(Math.round((expected / revenue) * 1000) / 10, 1);
    const project = view.byEngagement.find((r) => r.key === eng.id)!;
    expect(project.profitPaise).toBe(expected);
    expect(project.sub).toBe(client.name);
    expect(view.byService.find((r) => r.key === service.name)!.revenuePaise).toBeGreaterThanOrEqual(revenue);
    const person = view.byPerson.find((p) => p.userId === users.producer)!;
    expect(person.hours).toBeGreaterThanOrEqual(8);
    expect(view.formula.length).toBeGreaterThanOrEqual(4);
  });
});

describe('Stopwatch', () => {
  it('stopping the timer logs the time on the task and the timesheet', async () => {
    const task = await prisma.task.create({ data: { orgId, title: `Timer task ${stamp}`, ownerId: users.producer, isInternal: true } });
    const started = (await http().post('/timer/start').set(as('producer')).send({ taskId: task.id, note: 'Editing' }).expect(201)).body as TimerView;
    expect(started.running?.taskTitle).toBe(task.title);
    await prisma.activeTimer.update({ where: { userId: users.producer }, data: { startedAt: new Date(Date.now() - 37 * 60_000) } });
    const stop = (await http().post('/timer/stop').set(as('producer')).expect(201)).body as TimerStopResult;
    expect(stop.minutes).toBe(37);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).timeLoggedMin).toBe(37);
    const entry = await prisma.timeEntry.findUniqueOrThrow({ where: { id: stop.entryId! } });
    expect(entry).toMatchObject({ source: 'timer', minutes: 37, taskId: task.id, category: 'task' });
    await http().post('/timer/stop').set(as('producer')).expect(400);
    expect(((await http().get('/timer').set(as('producer')).expect(200)).body as TimerView).running).toBeNull();
    // Time on a task stays on the task.
    await http().delete(`/team-flows/timesheets/entries/${entry.id}`).set(as('producer')).expect((r) => expect([400, 404]).toContain(r.status));
  });
});

describe('Cash flow', () => {
  it('forecasts 13 weeks from the opening balance', async () => {
    await http().get('/money/cashflow').set(as('am')).expect(403);
    const v = (await http().get('/money/cashflow').set(as('finance')).expect(200)).body as CashflowView;
    expect(v.weeks).toHaveLength(13);
    expect(v.weeks[0].weekStart).toBe(mondayOf(today));
    expect(v.weeks[0].closingPaise).toBe(v.openingPaise + v.weeks[0].netPaise);
    expect(v.weeks[12].closingPaise).toBe(v.openingPaise + v.weeks.reduce((s, w) => s + w.netPaise, 0));
    expect(v.weeks.some((w) => w.items.some((i) => i.kind === 'invoice'))).toBe(true);
    expect(v.assumptions.length).toBeGreaterThanOrEqual(4);
  });
});

describe('Capacity', () => {
  const leaveWeek = addDays(mondayOf(today), 21);
  const partWeek = addDays(mondayOf(today), 28);

  it('shows leave in the heatmap and refuses to book someone on approved leave or past their free hours', async () => {
    const full = await prisma.leaveRequest.create({ data: { orgId, userId: users.design, from: dbDate(leaveWeek), to: dbDate(addDays(leaveWeek, 6)), status: 'approved', stage: 'done', reason: `test ${stamp}` } });
    const part = await prisma.leaveRequest.create({ data: { orgId, userId: users.design, from: dbDate(partWeek), to: dbDate(addDays(partWeek, 2)), status: 'approved', stage: 'done', reason: `test ${stamp}` } });
    cleanup.leaves.push(full.id, part.id);

    const view = (await http().get(`/capacity/workload?from=${leaveWeek}&weeks=2`).set(as('producer')).expect(200)).body as WorkloadView;
    expect(view.canBook).toBe(true);
    const me = view.people.find((p) => p.userId === users.design)!;
    expect(me.cells[0]).toMatchObject({ weekStart: leaveWeek, availableHours: 0 });
    expect(me.cells[0].leaveDays).toBeGreaterThan(0);
    expect(me.cells[1].leaveDays).toBe(3);

    const refused = await http().post('/capacity/bookings').set(as('producer')).send({ engagementId: engId, userId: users.design, weekStart: leaveWeek, hours: 4 }).expect(400);
    expect(refused.body.message).toMatch(/approved leave/);
    await http().post('/capacity/bookings').set(as('producer')).send({ engagementId: engId, userId: users.design, weekStart: addDays(leaveWeek, 1), hours: 4 }).expect(400);
    await http().post('/capacity/bookings').set(as('sales')).send({ engagementId: engId, userId: users.design, weekStart: partWeek, hours: 4 }).expect(403);

    const free = Math.floor(me.cells[1].availableHours - me.cells[1].bookedHours);
    const ok = (await http().post('/capacity/bookings').set(as('producer')).send({ engagementId: engId, userId: users.design, weekStart: partWeek, hours: free }).expect(201)).body as BookingResult;
    expect(ok.created).toHaveLength(1);
    cleanup.bookings.push(ok.created[0].id);
    const over = await http().post('/capacity/bookings').set(as('producer')).send({ engagementId: engId, userId: users.design, weekStart: partWeek, hours: 1 }).expect(400);
    expect(over.body.message).toMatch(/only .* hours free/);

    // Several weeks at once: leave weeks are skipped, the rest are booked.
    const multi = (await http().post('/capacity/bookings').set(as('producer')).send({ engagementId: engId, userId: users.design, weekStart: addDays(leaveWeek, -7), weeks: 2, hours: 2 }).expect(201)).body as BookingResult;
    cleanup.bookings.push(...multi.created.map((b) => b.id));
    expect(multi.skipped.some((s) => s.weekStart === leaveWeek && /leave/.test(s.reason))).toBe(true);

    const suggest = (await http().get(`/capacity/suggest?weekStart=${leaveWeek}&specialty=graphic_designer`).set(as('producer')).expect(200)).body as { candidates: { userId: string }[] };
    expect(suggest.candidates.some((c) => c.userId === users.design)).toBe(false);
  });

  it('the Producer agent never proposes booking someone on leave; the safety check proves it refuses', async () => {
    const req = (await http().post('/capacity/bookings').set(as('producer')).send({ engagementId: engId, specialty: 'graphic_designer', weekStart: leaveWeek, hours: 6 }).expect(201)).body as BookingResult;
    expect(req.created[0].status).toBe('requested');
    cleanup.bookings.push(req.created[0].id);
    await http().patch('/agents/producer').set(as('founder')).send({ actsForUserId: users.founder }).expect(200);
    await http().post('/agents/producer/run').set(as('founder')).send({}).expect(200);
    const inbox = (await http().get('/agents/inbox').set(as('founder')).expect(200)).body as AgentProposalView[];
    expect(inbox.some((p) => p.action === 'book_person' && p.payload.userId === users.design && p.payload.weekStart === leaveWeek)).toBe(false);
    // Filling the request by hand for someone on leave is refused too.
    await http().patch(`/capacity/bookings/${req.created[0].id}`).set(as('producer')).send({ userId: users.design }).expect(400);

    const evals = (await http().post('/agents/evals').set(as('founder')).expect(200)).body as AgentEvalResult;
    const c = evals.cases.find((x) => x.key === 'no_booking_on_leave')!;
    expect(c.passed).toBe(true);
    expect(c.detail).toMatch(/leave/);
  });
});

describe('Finance collector agent', () => {
  it('suggests matching an unmatched payment and reminding an overdue invoice; approving the match records it', async () => {
    const inv = await issue(41_000_00, { dueInDays: -10 });
    const u = await prisma.unmatchedPayment.create({ data: { orgId, provider: 'bank', ref: `IMPS ${inv.number} ${stamp}`, amountPaise: inv.totalPaise } });
    await http().patch('/agents/finance_collector').set(as('founder')).send({ actsForUserId: users.founder }).expect(200);
    const runs = (await http().post('/agents/finance_collector/run').set(as('founder')).send({}).expect(200)).body as { status: string; summary: string | null }[];
    expect(runs[0].status).toBe('done');
    const inbox = (await http().get('/agents/inbox').set(as('founder')).expect(200)).body as AgentProposalView[];
    const match = inbox.find((p) => p.action === 'match_payment' && p.payload.unmatchedId === u.id)!;
    expect(match.payload.invoiceId).toBe(inv.id);
    expect(inbox.some((p) => p.action === 'send_payment_reminder' && p.payload.invoiceId === inv.id)).toBe(true);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('issued');
    await http().post(`/agents/inbox/${match.id}/decide`).set(as('founder')).send({ decision: 'approve' }).expect(200);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('paid');
    expect((await prisma.unmatchedPayment.findUniqueOrThrow({ where: { id: u.id } })).matchedAt).not.toBeNull();
    const reminder = inbox.find((p) => p.action === 'send_payment_reminder' && p.payload.invoiceId === inv.id)!;
    await http().post(`/agents/inbox/${reminder.id}/decide`).set(as('founder')).send({ decision: 'reject' }).expect(200);
  });
});
