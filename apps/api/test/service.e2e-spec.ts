// v10 service flows: notification preferences, the email Outbox, GST tax invoices, billing details,
// partial payments + credit notes (one "paid" event), dunning, promise to pay, the billing run,
// ratings + reopen, message attachments and unread counts.
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { issueInvoiceTx } from '../src/requests/billing.service.js';
import { InvoiceEvents, type PaidInvoice } from '../src/service/invoice-events.js';
import { currentPeriod } from '../src/service/billing-run.service.js';

let app: INestApplication;
let prisma: PrismaService;
const tokens: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const DAY = 86_400_000;
const stamp = Date.now();
let orgId: string;
let amId: string;
let homeClient: string; // Karnataka (CGST + SGST)
let goaClient: string; // Goa (IGST)
let otherClient: string;
let retainerId: string;
const paidEvents: PaidInvoice[] = [];
const clientIds: string[] = [];

async function signIn(email: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier: email }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier: email, code: otp.body.devCode }).expect(200)).body.token as string;
}

async function invoice(clientOrgId: string, amountPaise: number, opts: { dueDaysAgo?: number; engagementId?: string } = {}) {
  const inv = await prisma.$transaction((tx) => issueInvoiceTx(tx, { orgId, clientOrgId, engagementId: opts.engagementId, kind: 'addon', lines: [{ label: `Test work ${stamp}`, amountPaise }] }, { ratePct: 18, invoicePrefix: 'BMU' }));
  if (opts.dueDaysAgo !== undefined) return prisma.invoice.update({ where: { id: inv.id }, data: { dueDate: new Date(Date.now() - opts.dueDaysAgo * DAY) } });
  return inv;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  prisma = app.get(PrismaService);
  app.get(InvoiceEvents).onPaid(async (i) => {
    paidEvents.push(i);
  });

  const org = await prisma.organisation.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  orgId = org.id;
  amId = (await prisma.user.findFirstOrThrow({ where: { email: 'am@bmu.demo' } })).id;
  const role = (baseRole: string) => prisma.role.findFirstOrThrow({ where: { orgId, baseRole, isCustom: false } });
  const smm = await prisma.service.findFirstOrThrow({ where: { key: 'smm', priceBook: { orgId, status: 'active' } } });

  const mkClient = async (name: string, data: Record<string, string> = {}) => {
    const c = await prisma.clientOrg.create({ data: { orgId, name: `${name} ${stamp}`, amUserId: amId, ...data } });
    clientIds.push(c.id);
    return c.id;
  };
  homeClient = await mkClient('Service Home', { gstin: '29AAKCS9999M1Z5', placeOfSupply: '29', legalName: 'Service Home Pvt Ltd' });
  goaClient = await mkClient('Service Goa', { gstin: '30AAQFC9999K1Z2', placeOfSupply: '30' });
  otherClient = await mkClient('Service Other');

  const people: [string, string, string][] = [
    ['owner', 'client_owner', homeClient],
    ['approver', 'client_approver', homeClient],
    ['other', 'client_owner', otherClient],
  ];
  for (const [who, clientRole, clientOrgId] of people) {
    const u = await prisma.user.create({
      data: { orgId, type: 'client', name: `${who} person`, email: `svc.${who}.${stamp}@example.com`, status: 'active', roles: { create: { roleId: (await role(clientRole)).id } } },
    });
    await prisma.clientUser.create({ data: { userId: u.id, orgId, clientOrgId, clientRole, brandScope: [] } });
    tokens[who] = await signIn(u.email!);
  }
  const lastMonth = new Date(Date.now() - 40 * DAY);
  retainerId = (await prisma.engagement.create({ data: { orgId, clientOrgId: homeClient, serviceId: smm.id, tier: 'growth', amId, billingType: 'monthly', status: 'in_production', currentGate: 'G4', startDate: lastMonth, createdAt: lastMonth } })).id;
  for (const who of ['am', 'admin', 'finance']) tokens[who] = await signIn(`${who}@bmu.demo`);
});

afterAll(async () => {
  // Test clients and their people are soft-deleted so the demo lists stay clean.
  await prisma.engagement.updateMany({ where: { clientOrgId: { in: clientIds } }, data: { deletedAt: new Date() } });
  await prisma.user.updateMany({ where: { email: { contains: `.${stamp}@example.com` } }, data: { deletedAt: new Date() } });
  await prisma.clientOrg.updateMany({ where: { id: { in: clientIds } }, data: { deletedAt: new Date() } });
  await app.close();
});

describe('notification preferences', () => {
  it('lists client kinds, keeps money alerts on in the app, and respects a switched-off email', async () => {
    const view = (await http().get('/service/notification-preferences').set(as('owner')).expect(200)).body;
    expect(view.audience).toBe('client');
    expect(view.prefs.map((p: { kind: string }) => p.kind)).toContain('message');
    const saved = (
      await http()
        .put('/service/notification-preferences')
        .set(as('owner'))
        .send({ prefs: [{ kind: 'invoice_reminder', inApp: false, email: false }, { kind: 'message', inApp: false, email: false }, { kind: 'qc_waiting', inApp: false, email: false }] })
        .expect(200)
    ).body;
    const pick = (k: string) => saved.prefs.find((p: { kind: string }) => p.kind === k);
    expect(pick('invoice_reminder')).toMatchObject({ inApp: true, email: false, locked: true });
    expect(pick('message')).toMatchObject({ inApp: false, email: false });
    expect(pick('qc_waiting')).toBeUndefined(); // a team kind is ignored for a client

    // The AM writes: the owner (message alerts off) gets nothing; the approver does.
    const thread = (await http().get('/client/thread').set(as('approver')).expect(200)).body;
    await http().post(`/threads/${thread.id}/messages`).set(as('am')).send({ body: `Hello from the AM ${stamp}` }).expect(201);
    const owner = await prisma.user.findFirstOrThrow({ where: { email: `svc.owner.${stamp}@example.com` } });
    const approver = await prisma.user.findFirstOrThrow({ where: { email: `svc.approver.${stamp}@example.com` } });
    expect(await prisma.notification.count({ where: { userId: owner.id, kind: 'message' } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId: approver.id, kind: 'message' } })).toBe(1);
    expect(await prisma.emailOutbox.count({ where: { toUserId: owner.id, kind: 'message' } })).toBe(0);
  });
});

describe('Outbox', () => {
  it('is for Founder/Admin only and never shows sign-in codes', async () => {
    await http().get('/service/outbox').set(as('am')).expect(403);
    await http().get('/service/outbox').set(as('finance')).expect(403);
    const list = (await http().get(`/service/outbox?kind=otp&q=${stamp}`).set(as('admin')).expect(200)).body;
    const otp = list.rows.find((r: { to: string }) => r.to === `svc.owner.${stamp}@example.com`);
    expect(otp).toBeTruthy();
    expect(otp.subject).not.toMatch(/\d{6}/);
    const detail = (await http().get(`/service/outbox/${otp.id}`).set(as('admin')).expect(200)).body;
    expect(detail.text).not.toMatch(/\b\d{6}\b/);
    expect(detail.html).not.toMatch(/\b\d{6}\b/);
    const resend = await http().post(`/service/outbox/${otp.id}/resend`).set(as('admin'));
    expect(resend.status).toBeGreaterThanOrEqual(400);
  });
});

describe('GST tax invoice and billing details', () => {
  it('splits CGST + SGST inside Karnataka and charges IGST to Goa', async () => {
    const home = await invoice(homeClient, 100_001);
    const goa = await invoice(goaClient, 100_000);
    const h = (await http().get(`/service/finance/invoices/${home.id}/tax-invoice`).set(as('finance')).expect(200)).body;
    expect(h.interState).toBe(false);
    expect(h.igstPaise).toBe(0);
    expect(h.cgstPaise + h.sgstPaise).toBe(h.gstPaise);
    expect(Math.abs(h.cgstPaise - h.sgstPaise)).toBeLessThanOrEqual(1);
    expect(h.buyer.legalName).toBe('Service Home Pvt Ltd');
    const g = (await http().get(`/service/finance/invoices/${goa.id}/tax-invoice`).set(as('finance')).expect(200)).body;
    expect(g.interState).toBe(true);
    expect(g.igstPaise).toBe(g.gstPaise);
    expect(g.cgstPaise + g.sgstPaise).toBe(0);
    // Clients see only their own tax invoices.
    await http().get(`/service/client/invoices/${home.id}/tax-invoice`).set(as('owner')).expect(200);
    await http().get(`/service/client/invoices/${home.id}/tax-invoice`).set(as('other')).expect(404);
  });

  it('lets the account owner and Finance edit billing details, not an approver or AM', async () => {
    await http().put('/service/client/billing-details').set(as('approver')).send({ legalName: 'Nope' }).expect(403);
    await http().put('/service/client/billing-details').set(as('owner')).send({ gstin: 'NOT-A-GSTIN' }).expect(400);
    await http().put('/service/client/billing-details').set(as('owner')).send({ legalName: 'Service Home Private Limited', billingEmail: `accounts.${stamp}@example.com` }).expect(200);
    await http().put(`/service/finance/clients/${homeClient}/billing-details`).set(as('am')).send({ legalName: 'Nope' }).expect(403);
    await http().put(`/service/finance/clients/${homeClient}/billing-details`).set(as('finance')).send({ placeOfSupply: '29' }).expect(200);
    const c = await prisma.clientOrg.findUniqueOrThrow({ where: { id: homeClient } });
    expect(c.legalName).toBe('Service Home Private Limited');
  });

  it('emails the tax invoice to the client and its billing address', async () => {
    const inv = await invoice(homeClient, 50_000);
    await http().post(`/service/finance/invoices/${inv.id}/email`).set(as('finance')).expect(200);
    const mails = await prisma.emailOutbox.findMany({ where: { entityId: inv.id, kind: 'invoice_issued' } });
    expect(mails.map((m) => m.toEmail)).toContain(`accounts.${stamp}@example.com`);
    expect(mails.some((m) => m.html.includes(inv.number))).toBe(true);
  });
});

describe('partial payments and credit notes', () => {
  it('charges only the balance, and fires one paid event when a credit note settles the rest', async () => {
    const inv = await invoice(homeClient, 100_000);
    await http().post(`/finance/invoices/${inv.id}/payments`).set(as('finance')).send({ amountPaise: 50_000, method: 'upi', ref: `UPI-${stamp}` }).expect(200);
    const bill = (await http().get('/service/client/billing').set(as('owner')).expect(200)).body;
    const row = bill.invoices.find((i: { id: string }) => i.id === inv.id);
    expect(row.balancePaise).toBe(inv.totalPaise - 50_000);
    expect(paidEvents.some((e) => e.id === inv.id)).toBe(false);
    await http().post('/finance/credit-notes').set(as('admin')).send({ invoiceId: inv.id, amountPaise: Math.round((inv.totalPaise - 50_000) / 1.18), reason: 'Goodwill' }).expect(201);
    const after = (await http().get(`/finance/invoices/${inv.id}`).set(as('finance')).expect(200)).body;
    if (after.balancePaise > 0) await http().post(`/finance/invoices/${inv.id}/payments`).set(as('finance')).send({ amountPaise: after.balancePaise, method: 'bank', ref: `NEFT-${stamp}` }).expect(200);
    expect(paidEvents.filter((e) => e.id === inv.id)).toHaveLength(1);
    const tax = (await http().get(`/service/finance/invoices/${inv.id}/tax-invoice`).set(as('finance')).expect(200)).body;
    expect(tax.payments.length).toBeGreaterThanOrEqual(1);
    expect(tax.creditNotes).toHaveLength(1);
    expect(tax.balancePaise).toBe(0);
  });
});

describe('dunning and promise to pay', () => {
  it('sends only the highest due reminder once, pauses for a promise, and skips paid invoices', async () => {
    const late = await invoice(homeClient, 20_000, { dueDaysAgo: 40 });
    const promised = await invoice(homeClient, 20_000, { dueDaysAgo: 15 });
    const paid = await invoice(homeClient, 20_000, { dueDaysAgo: 40 });
    await http().post(`/finance/invoices/${paid.id}/payments`).set(as('finance')).send({ amountPaise: paid.totalPaise, method: 'upi', ref: `UPI-P-${stamp}` }).expect(200);

    const past = new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10);
    await http().post(`/service/finance/invoices/${promised.id}/promise`).set(as('finance')).send({ promisedFor: past }).expect(400);
    const future = new Date(Date.now() + 5 * DAY).toISOString().slice(0, 10);
    await http().post(`/service/finance/invoices/${promised.id}/promise`).set(as('am')).send({ promisedFor: future }).expect(403);
    await http().post(`/service/finance/invoices/${promised.id}/promise`).set(as('finance')).send({ promisedFor: future, note: 'Paying Friday' }).expect(200);

    const run = (await http().post('/service/finance/dunning/run').set(as('finance')).expect(200)).body;
    expect(run.details.some((d: string) => d.startsWith(late.number))).toBe(true);
    const reminders = await prisma.invoiceReminder.findMany({ where: { invoiceId: { in: [late.id, promised.id, paid.id] } } });
    expect(reminders.filter((r) => r.invoiceId === late.id).map((r) => r.step)).toEqual([3]);
    expect(reminders.filter((r) => r.invoiceId !== late.id)).toHaveLength(0);

    const again = (await http().post('/service/finance/dunning/run').set(as('finance')).expect(200)).body;
    expect(again.details.some((d: string) => d.startsWith(late.number))).toBe(false);
    expect(await prisma.invoiceReminder.count({ where: { invoiceId: late.id } })).toBe(1);

    // The client hears about it in their messages, Finance gets an alert.
    const thread = (await http().get('/client/thread').set(as('owner')).expect(200)).body;
    expect(thread.messages.some((m: { body: string }) => m.body.includes(late.number))).toBe(true);
    const fin = await prisma.user.findFirstOrThrow({ where: { email: 'finance@bmu.demo' } });
    expect(await prisma.notification.count({ where: { userId: fin.id, kind: 'dunning_alert', link: { contains: late.id } } })).toBeGreaterThanOrEqual(1);

    const col = (await http().get('/service/finance/collections').set(as('finance')).expect(200)).body;
    expect(JSON.stringify(col)).toContain(future);
  });

  it('lets Finance send a reminder by hand', async () => {
    const inv = await invoice(homeClient, 10_000, { dueDaysAgo: 3 });
    await http().post(`/service/finance/invoices/${inv.id}/remind`).set(as('am')).expect(403);
    await http().post(`/service/finance/invoices/${inv.id}/remind`).set(as('finance')).expect(200);
    const r = await prisma.invoiceReminder.findMany({ where: { invoiceId: inv.id } });
    expect(r).toHaveLength(1);
    expect(r[0].manual).toBe(true);
  });
});

describe('billing run', () => {
  it('bills a retainer once per month, even when asked twice or billed elsewhere', async () => {
    await http().get('/service/finance/billing-run').set(as('am')).expect(403);
    const preview = (await http().get('/service/finance/billing-run').set(as('finance')).expect(200)).body;
    expect(preview.period).toBe(currentPeriod());
    const line = preview.lines.find((l: { engagementId: string }) => l.engagementId === retainerId);
    expect(line.status).toBe('ready');
    expect(line.amountPaise).toBeGreaterThan(0);

    const [a, b] = await Promise.all([
      http().post('/service/finance/billing-run').set(as('finance')).send({ period: preview.period, engagementIds: [retainerId] }),
      http().post('/service/finance/billing-run').set(as('finance')).send({ period: preview.period, engagementIds: [retainerId] }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.issued.length + b.body.issued.length).toBe(1);
    expect(await prisma.invoice.count({ where: { engagementId: retainerId, period: preview.period } })).toBe(1);

    const again = (await http().get('/service/finance/billing-run').set(as('finance')).expect(200)).body;
    expect(again.lines.find((l: { engagementId: string }) => l.engagementId === retainerId).status).toBe('already_issued');
    const runs = (await http().get('/service/finance/billing-runs').set(as('finance')).expect(200)).body;
    expect(runs[0].period).toBe(preview.period);
  });

  it('treats a cycle-start retainer invoice (no period) as already billed', async () => {
    const smm = await prisma.engagement.findUniqueOrThrow({ where: { id: retainerId } });
    const eng = await prisma.engagement.create({ data: { orgId, clientOrgId: goaClient, serviceId: smm.serviceId, tier: 'growth', amId, billingType: 'monthly', status: 'active_retainer', currentGate: 'G5', startDate: new Date(Date.now() - 60 * DAY), createdAt: new Date(Date.now() - 60 * DAY) } });
    await prisma.$transaction((tx) => issueInvoiceTx(tx, { orgId, clientOrgId: goaClient, engagementId: eng.id, kind: 'retainer', lines: [{ label: 'Social media (growth): retainer for this month', amountPaise: 1000 }] }));
    const preview = (await http().get('/service/finance/billing-run').set(as('finance')).expect(200)).body;
    expect(preview.lines.find((l: { engagementId: string }) => l.engagementId === eng.id).status).toBe('already_issued');
    const r = (await http().post('/service/finance/billing-run').set(as('finance')).send({ period: preview.period, engagementIds: [eng.id] }).expect(200)).body;
    expect(r.issued).toHaveLength(0);
    expect(r.skipped).toHaveLength(1);
  });
});

describe('ratings and reopen', () => {
  it('rates a done request, feeds satisfaction, and reopens within 7 days only', async () => {
    const r = (await http().post('/client/requests').set(as('owner')).send({ engagementId: retainerId, type: 'change', description: `Swap the cover photo ${stamp}` }).expect(201)).body;
    await http().post(`/client/requests/${r.id}/rate`).set(as('owner')).send({ rating: 'up' }).expect(400); // not done yet
    await prisma.request.update({ where: { id: r.id }, data: { status: 'done', resolvedAt: new Date() } });
    await http().post(`/client/requests/${r.id}/rate`).set(as('other')).send({ rating: 'up' }).expect(404);
    await http().post(`/client/requests/${r.id}/rate`).set(as('am')).send({ rating: 'up' }).expect(403);
    await http().post(`/client/requests/${r.id}/rate`).set(as('owner')).send({ rating: 'down', comment: 'Wrong photo' }).expect(200);
    const view = (await http().get(`/client/requests/${r.id}`).set(as('owner')).expect(200)).body;
    expect(view.rating).toMatchObject({ value: 'down', comment: 'Wrong photo' });
    expect(view.can.reopen).toBe(true);
    const sat = (await http().get('/service/satisfaction').set(as('admin')).expect(200)).body;
    expect(sat.down).toBeGreaterThanOrEqual(1);

    await http().post(`/client/requests/${r.id}/reopen`).set(as('owner')).send({ reason: 'x' }).expect(400);
    await http().post(`/client/requests/${r.id}/reopen`).set(as('owner')).send({ reason: 'Still the old photo on Instagram' }).expect(200);
    const reopened = await prisma.request.findUniqueOrThrow({ where: { id: r.id } });
    expect(reopened).toMatchObject({ status: 'in_progress', reopenCount: 1, rating: null });

    const old = (await http().post('/client/requests').set(as('owner')).send({ engagementId: retainerId, type: 'change', description: `Old one ${stamp}` }).expect(201)).body;
    await prisma.request.update({ where: { id: old.id }, data: { status: 'done', resolvedAt: new Date(Date.now() - 8 * DAY) } });
    await http().post(`/client/requests/${old.id}/reopen`).set(as('owner')).send({ reason: 'Please look again' }).expect(400);
  });
});

describe('messages: attachments and unread', () => {
  it('shares files on the thread and keeps internal-note files from the client', async () => {
    const up = (await http().post('/client/thread/attachments').set(as('owner')).attach('file', Buffer.from('brief'), 'brief.txt').expect(201)).body;
    await http().post('/client/thread/messages').set(as('owner')).send({ body: '', attachmentIds: [up.id] }).expect(201);
    await http().get(`/thread-files/${up.id}`).set(as('owner')).expect(200);
    await http().get(`/thread-files/${up.id}`).set(as('am')).expect(200);
    const denied = await http().get(`/thread-files/${up.id}`).set(as('other'));
    expect([403, 404]).toContain(denied.status);

    const thread = (await http().get('/client/thread').set(as('owner')).expect(200)).body;
    const note = (await http().post(`/threads/${thread.id}/attachments`).set(as('am')).attach('file', Buffer.from('margin'), 'margin.txt').expect(201)).body;
    await http().post(`/threads/${thread.id}/messages`).set(as('am')).send({ body: 'Internal margin sheet', internal: true, attachmentIds: [note.id] }).expect(201);
    const hidden = await http().get(`/thread-files/${note.id}`).set(as('owner'));
    expect([403, 404]).toContain(hidden.status);
    const clientView = (await http().get('/client/thread').set(as('owner')).expect(200)).body;
    expect(clientView.messages.some((m: { body: string }) => m.body === 'Internal margin sheet')).toBe(false);
  });

  it('counts unread messages until the thread is opened', async () => {
    const thread = (await http().get('/client/thread').set(as('owner')).expect(200)).body;
    await http().get(`/threads/${thread.id}`).set(as('am')).expect(200);
    await http().post('/client/thread/messages').set(as('owner')).send({ body: `Any update? ${stamp}` }).expect(201);
    const before = (await http().get('/threads').set(as('am')).expect(200)).body.find((t: { id: string }) => t.id === thread.id);
    expect(before.unread).toBe(1);
    expect((await http().get('/service/unread').set(as('am')).expect(200)).body.messages).toBeGreaterThanOrEqual(1);
    await http().get(`/threads/${thread.id}`).set(as('am')).expect(200);
    const after = (await http().get('/threads').set(as('am')).expect(200)).body.find((t: { id: string }) => t.id === thread.id);
    expect(after.unread).toBe(0);
  });
});
