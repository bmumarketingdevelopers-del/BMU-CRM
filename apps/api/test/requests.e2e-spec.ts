// Request desk, extra requests (add-ons), messaging, notifications and final delivery (Gate 5).
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { workingMinutesBetween } from '@bmu/shared';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

let app: INestApplication;
let prisma: PrismaService;
const tokens: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
let retainerId: string;
let projectId: string;
let fileId: string;
let addOnId: string;
let addOnPrice: number;

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
  const stamp = Date.now();
  const org = await prisma.organisation.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  const am = await prisma.user.findFirstOrThrow({ where: { email: 'am@bmu.demo' } });
  const role = (baseRole: string) => prisma.role.findFirstOrThrow({ where: { orgId: org.id, baseRole, isCustom: false } });
  const smm = await prisma.service.findFirstOrThrow({ where: { key: 'smm', priceBook: { orgId: org.id, status: 'active' } } });
  const addOn = await prisma.addOn.findFirstOrThrow({ where: { orgId: org.id, pricePaise: { not: null }, priceBook: { status: 'active' } } });
  addOnId = addOn.id;
  addOnPrice = addOn.pricePaise!;
  const client = await prisma.clientOrg.create({ data: { orgId: org.id, name: `Desk Test ${stamp}`, amUserId: am.id } });
  for (const [who, clientRole] of [
    ['owner', 'client_owner'],
    ['approver', 'client_approver'],
  ] as const) {
    const u = await prisma.user.create({
      data: { orgId: org.id, type: 'client', name: who, email: `desk.${who}.${stamp}@example.com`, status: 'active', roles: { create: { roleId: (await role(clientRole)).id } } },
    });
    await prisma.clientUser.create({ data: { userId: u.id, orgId: org.id, clientOrgId: client.id, clientRole, brandScope: [] } });
    tokens[who] = await signIn(u.email!);
  }
  const base = { orgId: org.id, clientOrgId: client.id, serviceId: smm.id, tier: 'growth' as const, amId: am.id };
  retainerId = (await prisma.engagement.create({ data: { ...base, billingType: 'monthly', status: 'in_production', currentGate: 'G4' } })).id;

  // A one-time project with every deliverable approved: Gate 4 passed, balance due.
  const project = await prisma.engagement.create({
    data: { ...base, billingType: 'one_time', status: 'in_review', currentGate: 'G4', cycles: { create: { orgId: org.id, period: '2026-10', rcdAt: new Date(), status: 'production' } } },
    include: { cycles: true },
  });
  projectId = project.id;
  const file = await prisma.file.create({ data: { orgId: org.id, clientOrgId: client.id, path: 'missing/final.png', kind: 'image', name: 'final.png', mimeType: 'image/png' } });
  fileId = file.id;
  const d = await prisma.deliverable.create({ data: { orgId: org.id, cycleId: project.cycles[0].id, type: 'post', title: 'Final logo', status: 'approved' } });
  const v = await prisma.version.create({ data: { orgId: org.id, deliverableId: d.id, fileId: file.id, number: 1, uploadedById: am.id, sentToClientAt: new Date() } });
  await prisma.deliverable.update({ where: { id: d.id }, data: { approvedVersionId: v.id } });

  for (const who of ['am', 'admin', 'producer']) tokens[who] = await signIn(`${who}@bmu.demo`);
});

afterAll(async () => {
  await app.close();
});

describe('request desk', () => {
  it('sets the first-reply SLA in working hours and alerts the CM', async () => {
    const r = await http().post('/client/requests').set(as('approver')).send({ engagementId: retainerId, type: 'urgent', description: 'Fix the typo in today’s post' }).expect(201);
    expect(r.body.status).toBe('received');
    expect(r.body.sla.state).toBe('due');
    const minutes = workingMinutesBetween(new Date(r.body.createdAt), new Date(r.body.sla.firstReplyDue), []);
    expect(minutes).toBeGreaterThanOrEqual(119);
    expect(minutes).toBeLessThanOrEqual(120);
    const notes = await http().get('/notifications').set(as('am')).expect(200);
    expect(notes.body.items[0].title).toMatch(/URGENT/);
    expect(notes.body.items[0].link).toBe(`/team/requests/${r.body.id}`);

    const accepted = await http().post(`/requests/${r.body.id}/decide`).set(as('am')).send({ action: 'accept_urgent', message: 'On it' }).expect(200);
    expect(accepted.body.status).toBe('in_progress');
    expect(accepted.body.sla.state).toBe('met');
  });

  it('keeps internal replies away from the client and other CMs out', async () => {
    const r = await http().post('/client/requests').set(as('owner')).send({ engagementId: retainerId, type: 'question', description: 'When is the next shoot?' }).expect(201);
    await http().post(`/requests/${r.body.id}/decide`).set(as('am')).send({ action: 'reply', message: 'Check the crew calendar first', internal: true }).expect(200);
    let client = await http().get(`/client/requests/${r.body.id}`).set(as('owner')).expect(200);
    expect(client.body.comments).toHaveLength(0);
    expect(client.body.sla.firstReplyAt).toBeNull();
    await http().post(`/requests/${r.body.id}/decide`).set(as('am')).send({ action: 'reply', message: 'Thursday 11am' }).expect(200);
    client = await http().get(`/client/requests/${r.body.id}`).set(as('owner')).expect(200);
    expect(client.body.comments.map((c: { body: string }) => c.body)).toEqual(['Thursday 11am']);
    await http().get(`/requests/${r.body.id}`).set(as('producer')).expect(403);
  });
});

describe('extra requests', () => {
  let requestId: string;

  it('cannot be marked in scope, and CMs quote only from the price list', async () => {
    const r = await http().post('/client/requests').set(as('approver')).send({ engagementId: retainerId, type: 'new_scope', description: 'Add a festive reel for Diwali' }).expect(201);
    requestId = r.body.id;
    expect(r.body.status).toBe('scope_check');
    await http().post(`/requests/${requestId}/decide`).set(as('am')).send({ action: 'in_scope' }).expect(400);
    await http().post(`/requests/${requestId}/decide`).set(as('am')).send({ action: 'quote', customAmountPaise: 100, timeline: '3 working days' }).expect(403);
    const quoted = await http().post(`/requests/${requestId}/decide`).set(as('am')).send({ action: 'quote', addOnId, quantity: 2, timeline: '3 working days' }).expect(200);
    expect(quoted.body.status).toBe('quoted');
    expect(quoted.body.quote.amountPaise).toBe(addOnPrice * 2);
    expect(quoted.body.quote.gstPaise).toBe(Math.round(addOnPrice * 2 * 0.18));
  });

  it('needs the client owner’s written approval and payment before any task exists', async () => {
    const tasks = () => prisma.task.count({ where: { flowStep: `request:${requestId}` } });
    expect(await tasks()).toBe(0);
    await http().post(`/requests/${requestId}/decide`).set(as('am')).send({ action: 'done' }).expect(400);
    await http().post(`/client/requests/${requestId}/approve-quote`).set(as('approver')).expect(403);
    const approved = await http().post(`/client/requests/${requestId}/approve-quote`).set(as('owner')).expect(200);
    expect(approved.body.status).toBe('approved');
    expect(approved.body.approval.by).toBe('owner');
    expect(approved.body.invoice.number).toMatch(/^BMU\/\d{4}-\d{2}\/\d{4}$/);
    expect(await tasks()).toBe(0);
    expect(await prisma.approval.count({ where: { targetType: 'request', targetId: requestId } })).toBe(1);

    await http().post(`/client/invoices/${approved.body.invoice.id}/pay-test`).set(as('owner')).expect(200);
    const paid = await http().get(`/client/requests/${requestId}`).set(as('owner')).expect(200);
    expect(paid.body.status).toBe('paid');
    expect(paid.body.invoice.status).toBe('paid');
    expect(await tasks()).toBe(1);
  });

  it('lets only Founder/Admin set a custom price', async () => {
    const r = await http().post('/client/requests').set(as('owner')).send({ engagementId: retainerId, type: 'new_scope', description: 'A one-off landing page' }).expect(201);
    const quoted = await http().post(`/requests/${r.body.id}/decide`).set(as('admin')).send({ action: 'quote', customAmountPaise: 2500000, timeline: '2 weeks' }).expect(200);
    expect(quoted.body.quote.amountPaise).toBe(2500000);
    const declined = await http().post(`/client/requests/${r.body.id}/decline-quote`).set(as('owner')).send({ reason: 'Not this month' }).expect(200);
    expect(declined.body.status).toBe('declined');
  });
});

describe('messages', () => {
  it('threads client and CM, hides internal notes, and tracks the reply target', async () => {
    const sent = await http().post('/client/thread/messages').set(as('owner')).send({ body: 'Can we talk about next month?' }).expect(201);
    expect(sent.body.awaitingReply).toBeNull(); // the reply target is a team-side view
    const threadId = sent.body.id;
    const list = await http().get('/threads').set(as('am')).expect(200);
    expect(list.body.some((t: { id: string; awaitingReply: unknown }) => t.id === threadId && t.awaitingReply)).toBe(true);
    await http().post(`/threads/${threadId}/messages`).set(as('am')).send({ body: 'Upsell chance: festive bundle', internal: true }).expect(201);
    await http().post(`/threads/${threadId}/messages`).set(as('am')).send({ body: 'Sure, 4pm today?' }).expect(201);
    const client = await http().get('/client/thread').set(as('owner')).expect(200);
    // v18: the extra request paid above left a "Payment received" note from the CM at the top of the thread.
    const bodies = client.body.messages.map((m: { body: string }) => m.body) as string[];
    expect(bodies.filter((b) => !b.startsWith('Payment received'))).toEqual(['Can we talk about next month?', 'Sure, 4pm today?']);
    expect(bodies.filter((b) => b.startsWith('Payment received'))).toHaveLength(1);
    expect((await http().get(`/threads/${threadId}`).set(as('am')).expect(200)).body.awaitingReply).toBeNull();
    await http().post('/client/thread/messages').set(as('owner')).send({ body: 'x', internal: true }).expect(201);
    const again = await http().get(`/threads/${threadId}`).set(as('am')).expect(200);
    expect(again.body.messages.at(-1).internal).toBe(false);
  });

  it('marks notifications read', async () => {
    const before = await http().get('/notifications').set(as('owner')).expect(200);
    expect(before.body.unread).toBeGreaterThan(0);
    const after = await http().post('/notifications/read').set(as('owner')).send({ ids: 'all' }).expect(200);
    expect(after.body.unread).toBe(0);
  });
});

describe('final delivery (Gate 5)', () => {
  it('issues the balance invoice when Gate 4 passes', async () => {
    const production = app.get((await import('../src/requests/delivery.service.js')).DeliveryService);
    await production.onGate4Passed(projectId);
    await production.onGate4Passed(projectId);
    expect(await prisma.invoice.count({ where: { engagementId: projectId, kind: 'project_balance' } })).toBe(1);
    const delivery = await http().get('/client/delivery').set(as('owner')).expect(200);
    const row = delivery.body.find((x: { engagementId: string }) => x.engagementId === projectId);
    expect(row.allApproved).toBe(true);
    expect(row.balanceInvoice.status).toBe('issued');
    expect(row.filesReleased).toBe(false);
  });

  it('releases files only after sign-off AND payment', async () => {
    const files = async () => (await http().get('/client/files').set(as('owner')).expect(200)).body.find((f: { id: string }) => f.id === fileId);
    expect((await files()).downloadUrl).toBeNull();
    await http().get(`/files/${fileId}?download=1`).set(as('owner')).expect(403);

    await http().post(`/client/engagements/${projectId}/sign-off`).set(as('owner')).expect(200);
    expect((await files()).downloadUrl).toBeNull();
    await http().get(`/files/${fileId}?download=1`).set(as('owner')).expect(403);

    const inv = await prisma.invoice.findFirstOrThrow({ where: { engagementId: projectId, kind: 'project_balance' } });
    await http().post(`/client/invoices/${inv.id}/pay-test`).set(as('owner')).expect(200);
    expect((await files()).downloadUrl).toBe(`/api/files/${fileId}?download=1`);
    const e = await prisma.engagement.findUniqueOrThrow({ where: { id: projectId } });
    expect(e.status).toBe('delivered');
    expect(await prisma.approval.count({ where: { targetType: 'engagement', targetId: projectId, gate: 'G5' } })).toBe(1);
    const overview = await http().get('/client/overview').set(as('owner')).expect(200);
    const track = overview.body.engagements.find((x: { id: string }) => x.id === projectId).track;
    expect(Object.values(track).every((s) => s === 'passed')).toBe(true);
  });
});
