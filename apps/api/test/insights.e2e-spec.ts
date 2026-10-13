// Command Centre analytics and the Finance desk: numbers, offline payments, cancellations, credit notes, payouts,
// reminders, exports and who may see or change what.
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { financialYear } from '@bmu/shared';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

let app: INestApplication;
let prisma: PrismaService;
const tokens: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
let orgId: string;
let clientId: string;
let ownerId: string;
let overdueId: string;
let openId: string;
let creatorId: string;
const stamp = Date.now();

async function signIn(email: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier: email }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier: email, code: otp.body.devCode }).expect(200)).body.token as string;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();

  prisma = app.get(PrismaService);
  const org = await prisma.organisation.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  orgId = org.id;
  const am = await prisma.user.findFirstOrThrow({ where: { email: 'am@bmu.demo' } });
  const role = (baseRole: string) => prisma.role.findFirstOrThrow({ where: { orgId, baseRole, isCustom: false } });
  const client = await prisma.clientOrg.create({ data: { orgId, name: `Finance Test ${stamp}`, amUserId: am.id } });
  clientId = client.id;
  const owner = await prisma.user.create({
    data: { orgId, type: 'client', name: 'Owner', email: `fin.owner.${stamp}@example.com`, status: 'active', roles: { create: { roleId: (await role('client_owner')).id } } },
  });
  ownerId = owner.id;
  await prisma.clientUser.create({ data: { userId: owner.id, orgId, clientOrgId: client.id, clientRole: 'client_owner', brandScope: [] } });
  tokens.owner = await signIn(owner.email!);

  const mk = async (suffix: string, dueDays: number) =>
    (
      await prisma.invoice.create({
        data: {
          orgId,
          clientOrgId: client.id,
          number: `TEST/${stamp}/${suffix}`,
          kind: 'addon',
          lines: [{ label: 'Work', amountPaise: 100_000 }, { label: 'GST 18%', amountPaise: 18_000 }],
          subtotalPaise: 100_000,
          gstPaise: 18_000,
          totalPaise: 118_000,
          dueDate: new Date(Date.now() + dueDays * 86_400_000),
          status: 'issued',
        },
      })
    ).id;
  overdueId = await mk('A', -40);
  openId = await mk('B', 7);

  const cu = await prisma.user.create({ data: { orgId, type: 'creator', name: `Creator ${stamp}`, email: `creator.${stamp}@example.com`, status: 'active' } });
  creatorId = (await prisma.creator.create({ data: { orgId, userId: cu.id, niche: ['food'] } })).id;

  for (const who of ['founder', 'admin', 'finance', 'am', 'producer', 'design.head']) tokens[who] = await signIn(`${who}@bmu.demo`);
});

afterAll(async () => {
  // Leave the demo dashboards as they were.
  const invoiceIds = (await prisma.invoice.findMany({ where: { clientOrgId: clientId }, select: { id: true } })).map((i) => i.id);
  await prisma.payment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
  await prisma.creditNote.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
  await prisma.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
  await prisma.notification.deleteMany({ where: { userId: ownerId } });
  await prisma.clientUser.deleteMany({ where: { clientOrgId: clientId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
  await prisma.message.deleteMany({ where: { thread: { clientOrgId: clientId } } });
  await prisma.thread.deleteMany({ where: { clientOrgId: clientId } });
  await prisma.clientOrg.delete({ where: { id: clientId } });
  const creator = await prisma.creator.findUnique({ where: { id: creatorId } });
  await prisma.creatorPayout.deleteMany({ where: { creatorId } });
  await prisma.creator.delete({ where: { id: creatorId } });
  if (creator) await prisma.user.delete({ where: { id: creator.userId } });
  await app.close();
});

describe('Command Centre dashboards', () => {
  it('Weekly Review shows money to the founder and hides it from a department head', async () => {
    const f = await http().get('/insights/weekly').set(as('founder')).expect(200);
    expect(f.body.money.byMonth).toHaveLength(6);
    expect(f.body.attention.overdueInvoices.some((i: { id: string }) => i.id === overdueId)).toBe(true);
    expect(f.body.pipeline.length).toBeGreaterThan(3);
    const d = await http().get('/insights/weekly').set(as('design.head')).expect(200);
    expect(d.body.money).toBeNull();
    expect(d.body.attention.overdueInvoices).toBeNull();
  });

  it('revenue and collections are for Founder, Branch Manager and Finance only', async () => {
    await http().get('/insights/revenue').set(as('design.head')).expect(403);
    await http().get('/insights/collections').set(as('am')).expect(403);
    await http().get('/insights/revenue').set(as('owner')).expect(403);
    const r = await http().get('/insights/revenue?period=fy').set(as('finance')).expect(200);
    expect(r.body.period).toBe('fy');
    expect(r.body.byMonth.length).toBeGreaterThan(0);
    const c = await http().get('/insights/collections').set(as('admin')).expect(200);
    const row = c.body.unpaid.find((u: { id: string }) => u.id === overdueId);
    expect(row.daysOverdue).toBeGreaterThanOrEqual(39);
    expect(c.body.aging.find((a: { label: string }) => a.label === '31–60 days late').valuePaise).toBeGreaterThanOrEqual(118_000);
  });

  it('capacity, quality and client health are readable by the Command Centre, not by producers or clients', async () => {
    await http().get('/insights/capacity').set(as('producer')).expect(403);
    await http().get('/insights/quality').set(as('owner')).expect(403);
    const cap = await http().get('/insights/capacity').set(as('founder')).expect(200);
    expect(cap.body.weekHours).toBe(45);
    // A department head sees only their own department.
    const dh = await http().get('/insights/capacity').set(as('design.head')).expect(200);
    expect(dh.body.departments.every((d: { name: string }) => d.name === 'Creative / Design')).toBe(true);
    await http().get('/insights/quality').set(as('admin')).expect(200);
    const health = await http().get('/insights/client-health').set(as('founder')).expect(200);
    const mine = health.body.find((h: { id: string }) => h.id === clientId);
    expect(mine.score).toBeLessThan(100);
    expect(mine.reasons.join(' ')).toMatch(/overdue invoice/);
  });
});

describe('finance desk', () => {
  it('only Founder, Branch Manager and Finance can open it; others get 403', async () => {
    await http().get('/finance/invoices').set(as('am')).expect(403);
    await http().get('/finance/invoices').set(as('owner')).expect(403);
    await http().get('/finance/payments').set(as('design.head')).expect(403);
    const list = await http().get(`/finance/invoices?clientId=${clientId}`).set(as('finance')).expect(200);
    expect(list.body.rows).toHaveLength(2);
    expect(list.body.rows.find((r: { id: string }) => r.id === overdueId).status).toBe('overdue');
    expect(list.body.totals.balancePaise).toBe(236_000);
  });

  it('records an offline payment once per reference and marks the invoice paid when settled', async () => {
    await http().post(`/finance/invoices/${overdueId}/payments`).set(as('am')).send({ amountPaise: 1000, method: 'upi', ref: 'X1' }).expect(403);
    await http().post(`/finance/invoices/${overdueId}/payments`).set(as('finance')).send({ amountPaise: 200_000, method: 'bank', ref: 'UTR-BIG' }).expect(400);
    const part = await http().post(`/finance/invoices/${overdueId}/payments`).set(as('finance')).send({ amountPaise: 18_000, method: 'upi', ref: `UPI-${stamp}` }).expect(200);
    expect(part.body.status).toBe('overdue');
    expect(part.body.balancePaise).toBe(100_000);
    // Same reference again: nothing new.
    await http().post(`/finance/invoices/${overdueId}/payments`).set(as('finance')).send({ amountPaise: 18_000, method: 'upi', ref: `UPI-${stamp}` }).expect(200);
    expect(await prisma.payment.count({ where: { invoiceId: overdueId } })).toBe(1);
    const full = await http().post(`/finance/invoices/${overdueId}/payments`).set(as('admin')).send({ amountPaise: 100_000, method: 'cheque', ref: `CHQ-${stamp}` }).expect(200);
    expect(full.body.status).toBe('paid');
    expect(full.body.payments).toHaveLength(2);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: overdueId } })).status).toBe('paid');
    expect(await prisma.auditEvent.count({ where: { entity: 'Invoice', entityId: overdueId, action: 'invoice.payment_recorded' } })).toBe(2);
  });

  it('cannot cancel an invoice with payments; cancels an unpaid one with a reason', async () => {
    await http().post(`/finance/invoices/${overdueId}/cancel`).set(as('finance')).send({ reason: 'Raised by mistake' }).expect(400);
    await http().post(`/finance/invoices/${openId}/cancel`).set(as('finance')).send({ reason: 'no' }).expect(400);
    const extra = await prisma.invoice.create({
      data: { orgId, clientOrgId: clientId, number: `TEST/${stamp}/C`, lines: [], subtotalPaise: 10_000, gstPaise: 1_800, totalPaise: 11_800, dueDate: new Date(), status: 'issued' },
    });
    const r = await http().post(`/finance/invoices/${extra.id}/cancel`).set(as('founder')).send({ reason: 'Raised twice by mistake' }).expect(200);
    expect(r.body.status).toBe('void');
    expect(r.body.cancelReason).toBe('Raised twice by mistake');
    await http().post(`/finance/invoices/${extra.id}/payments`).set(as('finance')).send({ amountPaise: 1000, method: 'cash', ref: 'CASH-1' }).expect(400);
  });

  it('issues numbered credit notes with GST and never more than the invoice total', async () => {
    await http().post('/finance/credit-notes').set(as('am')).send({ invoiceId: openId, amountPaise: 10_000, reason: 'Goodwill credit' }).expect(403);
    // v11: Finance's credit notes wait for a Branch Manager; the note is issued on approval.
    const req = await http().post('/finance/credit-notes').set(as('finance')).send({ invoiceId: openId, amountPaise: 50_000, reason: 'One post dropped' }).expect(201);
    expect(req.body.pending).toBe(true);
    expect(await prisma.creditNote.count({ where: { invoiceId: openId } })).toBe(0);
    await http().post(`/actions/approvals/${req.body.approvalId}/decide`).set(as('admin')).send({ decision: 'approve' }).expect(200);
    const note = await prisma.creditNote.findFirstOrThrow({ where: { invoiceId: openId } });
    expect(note.number).toMatch(new RegExp(`^CN/${financialYear(new Date())}/\\d{4}$`));
    expect(note.gstPaise).toBe(9_000);
    expect(note.totalPaise).toBe(59_000);
    // 59,000 left; 50,001 + GST would exceed it.
    await http().post('/finance/credit-notes').set(as('finance')).send({ invoiceId: openId, amountPaise: 50_001, reason: 'Too much credit' }).expect(400);
    const direct = await http().post('/finance/credit-notes').set(as('admin')).send({ invoiceId: openId, amountPaise: 50_000, reason: 'Rest of the invoice' }).expect(201);
    expect(direct.body.pending).toBe(false);
    const inv = await http().get(`/finance/invoices/${openId}`).set(as('finance')).expect(200);
    expect(inv.body.status).toBe('credit_noted');
    expect(inv.body.balancePaise).toBe(0);
    expect(inv.body.creditNotes).toHaveLength(2);
  });

  it('sends a payment reminder to the client owner as an in-app notification', async () => {
    const inv = await prisma.invoice.create({
      data: { orgId, clientOrgId: clientId, number: `TEST/${stamp}/D`, lines: [], subtotalPaise: 10_000, gstPaise: 1_800, totalPaise: 11_800, dueDate: new Date(Date.now() - 5 * 86_400_000), status: 'issued' },
    });
    await http().post(`/finance/invoices/${inv.id}/remind`).set(as('design.head')).expect(403);
    const r = await http().post(`/finance/invoices/${inv.id}/remind`).set(as('finance')).expect(200);
    expect(r.body.notified).toBe(1);
    const n = await prisma.notification.findFirstOrThrow({ where: { userId: ownerId, kind: 'invoice_reminder' } });
    expect(n.title).toContain(inv.number);
    await http().post(`/finance/invoices/${overdueId}/remind`).set(as('finance')).expect(400); // already paid
  });

  it('adds creator payouts with 10% TDS and marks them paid', async () => {
    await http().post('/finance/payouts').set(as('am')).send({ creatorId, amountPaise: 100_000 }).expect(403);
    const p = await http().post('/finance/payouts').set(as('finance')).send({ creatorId, amountPaise: 100_000 }).expect(201);
    const row = await prisma.creatorPayout.findUniqueOrThrow({ where: { id: p.body.id } });
    expect(row.tdsPaise).toBe(10_000);
    expect(row.netPaise).toBe(90_000);
    await http().post(`/finance/payouts/${p.body.id}/pay`).set(as('finance')).send({ ref: 'NEFT-123' }).expect(200);
    await http().post(`/finance/payouts/${p.body.id}/pay`).set(as('finance')).send({ ref: 'NEFT-999' }).expect(400);
    const list = await http().get('/finance/payouts').set(as('admin')).expect(200);
    expect(list.body.rows.find((r: { id: string }) => r.id === p.body.id).status).toBe('paid');
  });

  it('summarises GST for a month and exports CSVs for GSTR-1 and accounting', async () => {
    const month = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 7);
    const g = await http().get(`/finance/gst?month=${month}`).set(as('finance')).expect(200);
    expect(g.body.rows.some((r: { id: string }) => r.id === openId)).toBe(true);
    expect(g.body.gstPaise).toBeGreaterThanOrEqual(18_000);
    const csv = await http().get(`/finance/gst.csv?month=${month}`).set(as('finance')).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain(`TEST/${stamp}/B`);
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const exp = await http().get(`/finance/export.csv?from=${today}&to=${today}`).set(as('admin')).expect(200);
    expect(exp.text).toContain('Voucher type');
    expect(exp.text).toContain(`CHQ-${stamp}`);
    await http().get('/finance/export.csv?from=bad&to=x').set(as('admin')).expect(400);
    await http().get(`/finance/gst.csv?month=${month}`).set(as('am')).expect(403);
  });
});
