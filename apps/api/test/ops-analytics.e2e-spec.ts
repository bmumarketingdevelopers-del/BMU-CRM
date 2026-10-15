// v9 operations analytics: who can read what, the report builder's validation and money rule,
// saved report sharing, client insights without internal data, and the on-time maths on known tasks.
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

let app: INestApplication;
let prisma: PrismaService;
const tokens: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const DAY = 86_400_000;

let personId: string;
let personDeptId: string;
let otherDeptId: string;
let clientOrgId: string;
const window = { from: '', to: '' };
const reportIds: string[] = [];

async function signIn(email: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier: email }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier: email, code: otp.body.devCode }).expect(200)).body.token as string;
}

/** IST yyyy-mm-dd of a moment. */
const istDay = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  prisma = app.get(PrismaService);

  const stamp = Date.now();
  const org = await prisma.organisation.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  const role = (baseRole: string) => prisma.role.findFirstOrThrow({ where: { orgId: org.id, baseRole, isCustom: false } });
  const hr = await prisma.department.findFirstOrThrow({ where: { orgId: org.id, name: 'HR / Ops' } });
  personDeptId = hr.id;
  otherDeptId = hr.id;

  // A temporary staff member (HR / Ops, so no flow ever assigns them work) with known tasks 40–20 days ago.
  const person = await prisma.user.create({
    data: { orgId: org.id, type: 'staff', name: `Ops Test ${stamp}`, email: `ops.test.${stamp}@example.com`, status: 'active', departmentId: hr.id, roles: { create: { roleId: (await role('hr_ops')).id } } },
  });
  personId = person.id;
  const base = new Date(Date.now() - 40 * DAY);
  const at = (days: number, hours = 0) => new Date(base.getTime() + days * DAY + hours * 3600_000);
  const tasks = [
    { deadline: at(5), started: at(1), done: at(3), min: 120 }, // on time
    { deadline: at(6), started: at(2), done: at(4), min: 180 }, // on time
    { deadline: at(8), started: at(4), done: at(6), min: 60 }, // on time
    { deadline: at(8), started: at(8), done: at(10), min: 240 }, // late
  ];
  for (const [i, t] of tasks.entries()) {
    await prisma.task.create({ data: { orgId: org.id, title: `Ops test task ${i}`, ownerId: person.id, departmentId: hr.id, deadline: t.deadline, status: 'done', startedAt: t.started, completedAt: t.done, timeLoggedMin: t.min, createdAt: t.started } });
  }
  await prisma.task.create({ data: { orgId: org.id, title: 'Ops test overdue', ownerId: person.id, departmentId: hr.id, deadline: new Date(Date.now() - 2 * DAY), status: 'in_progress', createdAt: at(0) } });
  window.from = istDay(at(-1));
  window.to = istDay(at(15));

  // A client with one approved deliverable, a request and an invoice.
  const am = await prisma.user.findFirstOrThrow({ where: { email: 'am@bmu.demo' } });
  const smm = await prisma.service.findFirstOrThrow({ where: { key: 'smm', priceBook: { orgId: org.id, status: 'active' } } });
  const client = await prisma.clientOrg.create({ data: { orgId: org.id, name: `Insight Test ${stamp}`, amUserId: am.id } });
  clientOrgId = client.id;
  for (const [who, clientRole] of [
    ['owner', 'client_owner'],
    ['approver', 'client_approver'],
  ] as const) {
    const u = await prisma.user.create({
      data: { orgId: org.id, type: 'client', name: who, email: `ops.${who}.${stamp}@example.com`, status: 'active', roles: { create: { roleId: (await role(clientRole)).id } } },
    });
    await prisma.clientUser.create({ data: { userId: u.id, orgId: org.id, clientOrgId: client.id, clientRole, brandScope: [] } });
    tokens[who] = await signIn(u.email!);
  }
  const owner = await prisma.user.findFirstOrThrow({ where: { email: `ops.owner.${stamp}@example.com` } });
  const engagement = await prisma.engagement.create({
    data: { orgId: org.id, clientOrgId: client.id, serviceId: smm.id, tier: 'growth', billingType: 'monthly', status: 'active_retainer', currentGate: 'G4', amId: am.id, cycles: { create: { orgId: org.id, period: 'test', rcdAt: at(0) } } },
    include: { cycles: true },
  });
  const deliverable = await prisma.deliverable.create({ data: { orgId: org.id, cycleId: engagement.cycles[0].id, type: 'post', title: 'Insight test post', status: 'approved', revisionRoundsUsed: 1, dueAt: at(9) } });
  const file = await prisma.file.create({ data: { orgId: org.id, clientOrgId: client.id, path: `test/${stamp}.png`, kind: 'image' } });
  const v = await prisma.version.create({ data: { orgId: org.id, deliverableId: deliverable.id, fileId: file.id, number: 1, uploadedById: am.id, createdAt: at(3), sentToClientAt: at(4) } });
  await prisma.qCResult.create({ data: { orgId: org.id, versionId: v.id, checklistId: 'design', items: { list: [] }, result: 'pass', reviewerId: am.id, createdAt: at(3, 2) } });
  await prisma.approval.create({ data: { orgId: org.id, targetType: 'deliverable', targetId: deliverable.id, gate: 'G4', userId: owner.id, at: at(6), versionId: v.id } });
  await prisma.request.create({ data: { orgId: org.id, engagementId: engagement.id, type: 'question', description: 'Test question', createdAt: at(2), firstReplyAt: at(2, 2), slaDue: at(3), status: 'done' } });
  await prisma.invoice.create({
    data: { orgId: org.id, clientOrgId: client.id, engagementId: engagement.id, number: `TEST/OPS/${stamp}`, lines: [], subtotalPaise: 100_000, gstPaise: 18_000, totalPaise: 118_000, dueDate: at(10), status: 'issued', createdAt: at(3) },
  });

  for (const who of ['founder', 'producer', 'am', 'finance']) tokens[who] = await signIn(`${who}@bmu.demo`);
  tokens.head = await signIn('design.head@bmu.demo');
  tokens.amLead = await signIn('am.lead@bmu.demo');
});

afterAll(async () => {
  if (reportIds.length) await prisma.savedReport.deleteMany({ where: { id: { in: reportIds } } });
  if (personId) await prisma.user.update({ where: { id: personId }, data: { deletedAt: new Date(), status: 'suspended' } });
  await app.close();
});

describe('who can read the operations analytics', () => {
  it('a producer cannot open the admin analytics but sees their own performance', async () => {
    for (const path of ['team', 'delivery', 'sla', 'reports']) await http().get(`/ops-analytics/${path}`).set(as('producer')).expect(403);
    await http().post('/ops-analytics/explore').set(as('producer')).send({ metric: 'leads', dimension: 'month', from: '2026-01-01', to: '2026-03-01' }).expect(403);
    const mine = (await http().get('/ops-analytics/me').set(as('producer')).expect(200)).body;
    expect(mine.name).toBe((await prisma.user.findFirstOrThrow({ where: { email: 'producer@bmu.demo' } })).name);
    expect(mine.teamAverage).toBeDefined();
    expect(JSON.stringify(mine)).not.toContain('@'); // no colleague emails or names list
  });

  it('clients only reach their own insights', async () => {
    for (const path of ['team', 'delivery', 'sla', 'me', 'reports']) await http().get(`/ops-analytics/${path}`).set(as('owner')).expect(403);
    await http().get('/ops-analytics/client').set(as('founder')).expect(403);
  });

  it('a client manager is not a Command Centre reader', async () => {
    await http().get('/ops-analytics/delivery').set(as('am')).expect(403);
    await http().get('/ops-analytics/team').set(as('am')).expect(403);
  });

  it('rejects a broken period', async () => {
    await http().get('/ops-analytics/delivery?from=2026-05-01&to=2026-04-01').set(as('founder')).expect(400);
    await http().get('/ops-analytics/sla?from=yesterday').set(as('founder')).expect(400);
  });
});

describe('team performance', () => {
  it('computes on-time %, cycle time, hours and overdue for known tasks', async () => {
    const res = await http().get(`/ops-analytics/team?from=${window.from}&to=${window.to}&departmentId=${personDeptId}`).set(as('founder')).expect(200);
    const row = res.body.people.find((p: { id: string }) => p.id === personId);
    expect(row).toBeDefined();
    expect(row.completed).toBe(4);
    expect(row.onTimePct).toBe(75);
    expect(row.avgCycleDays).toBe(2);
    expect(row.hours).toBe(10);
    expect(row.overdueNow).toBe(1);
    expect(res.body.people.every((p: { departmentId: string }) => p.departmentId === personDeptId)).toBe(true);
    expect(res.body.insights.length).toBeGreaterThan(0);
    expect(res.body.throughput.labels.length).toBe(res.body.throughput.series[0].values.length);
  });

  it('a department head only sees their own department', async () => {
    const res = await http().get(`/ops-analytics/team?departmentId=${otherDeptId}`).set(as('head')).expect(200);
    const head = await prisma.user.findFirstOrThrow({ where: { email: 'design.head@bmu.demo' } });
    expect(res.body.lockedDepartmentId).toBe(head.departmentId);
    expect(res.body.people.every((p: { departmentId: string }) => p.departmentId === head.departmentId)).toBe(true);
    expect(res.body.people.some((p: { id: string }) => p.id === personId)).toBe(false);
  });

  it('delivery and SLA views answer with a previous-period comparison', async () => {
    const d = (await http().get('/ops-analytics/delivery').set(as('amLead')).expect(200)).body;
    expect(d.steps.map((s: { key: string }) => s.key)).toEqual(['G1', 'G2', 'G3', 'G4', 'G5']);
    expect(d.totals.approved).toHaveProperty('prev');
    const s = (await http().get('/ops-analytics/sla').set(as('founder')).expect(200)).body;
    expect(s.heatmap.requests).toHaveLength(7);
    expect(s.heatmap.requests[0]).toHaveLength(24);
    expect(s.totals.withinPct).toHaveProperty('prev');
  });
});

describe('client insights', () => {
  it('the owner sees delivered work and spend for their own account only', async () => {
    const res = await http().get(`/ops-analytics/client?from=${window.from}&to=${window.to}`).set(as('owner')).expect(200);
    expect(res.body.clientName).toContain('Insight Test');
    expect(res.body.totals.approved.value).toBe(1);
    expect(res.body.delivered[0].title).toBe('Insight test post');
    expect(res.body.revisions).toEqual({ used: 1, allowance: 2, overAllowance: 0 });
    expect(res.body.totals.onTimePct.value).toBe(100);
    expect(res.body.canSeeMoney).toBe(true);
    expect(res.body.spendTotalPaise).toBe(118_000);
    const text = JSON.stringify(res.body);
    for (const internal of ['QC', 'qcPass', 'uploadedBy', 'reviewer', 'timeLogged']) expect(text).not.toContain(internal);
  });

  it('an approver sees the same work but no money', async () => {
    const res = await http().get(`/ops-analytics/client?from=${window.from}&to=${window.to}`).set(as('approver')).expect(200);
    expect(res.body.totals.approved.value).toBe(1);
    expect(res.body.canSeeMoney).toBe(false);
    expect(res.body.spendByMonth).toBeNull();
    expect(res.body.spendTotalPaise).toBeNull();
  });

  it('client data never leaks across accounts', async () => {
    const sunrise = await signIn('client@sunrise.demo');
    const res = await http().get(`/ops-analytics/client?from=${window.from}&to=${window.to}`).set({ Authorization: `Bearer ${sunrise}` }).expect(200);
    expect(res.body.delivered.some((d: { title: string }) => d.title === 'Insight test post')).toBe(false);
    expect(clientOrgId).toBeTruthy();
  });
});

describe('report builder', () => {
  it('validates the config', async () => {
    await http().post('/ops-analytics/explore').set(as('founder')).send({ metric: 'nonsense', dimension: 'month', from: '2026-01-01', to: '2026-02-01' }).expect(400);
    const combo = await http().post('/ops-analytics/explore').set(as('founder')).send({ metric: 'leads', dimension: 'department', from: '2026-01-01', to: '2026-02-01' }).expect(400);
    expect(combo.body.message).toContain('not available');
    await http().post('/ops-analytics/explore').set(as('founder')).send({ metric: 'leads', dimension: 'month', from: '2026-03-01', to: '2026-02-01' }).expect(400);
  });

  it('money metrics are for Founder, Branch Manager and Finance only', async () => {
    const cfg = { metric: 'revenue_collected', dimension: 'month', from: window.from, to: window.to, chart: 'columns' };
    await http().post('/ops-analytics/explore').set(as('head')).send(cfg).expect(403);
    await http().post('/ops-analytics/explore').set(as('amLead')).send(cfg).expect(403);
    const fin = await http().post('/ops-analytics/explore').set(as('finance')).send(cfg).expect(200);
    expect(fin.body.unit).toBe('paise');
    expect(fin.body.rows.length).toBeGreaterThan(0);
  });

  it('groups tasks by person with known numbers', async () => {
    const res = await http().post('/ops-analytics/explore').set(as('founder')).send({ metric: 'hours_logged', dimension: 'person', from: window.from, to: window.to, chart: 'bars' }).expect(200);
    const row = res.body.rows.find((r: { key: string }) => r.key === personId);
    expect(row.value).toBe(10);
    expect(res.body.prevTotal).not.toBeUndefined();
  });

  it('saved reports are private until shared, and only the owner can change them', async () => {
    const config = { metric: 'tasks_completed', dimension: 'department', from: window.from, to: window.to, chart: 'bars' };
    const created = (await http().post('/ops-analytics/reports').set(as('founder')).send({ name: 'E2E tasks by department', config }).expect(201)).body;
    reportIds.push(created.id);
    expect(created.mine).toBe(true);

    let head = (await http().get('/ops-analytics/reports').set(as('head')).expect(200)).body;
    expect([...head.mine, ...head.shared].some((r: { id: string }) => r.id === created.id)).toBe(false);
    await http().get(`/ops-analytics/reports/${created.id}`).set(as('head')).expect(404);

    const shared = (await http().patch(`/ops-analytics/reports/${created.id}`).set(as('founder')).send({ shared: true, pinned: true }).expect(200)).body;
    expect(shared.shared).toBe(true);
    expect(shared.pinned).toBe(true);
    head = (await http().get('/ops-analytics/reports').set(as('head')).expect(200)).body;
    expect(head.shared.some((r: { id: string; owner: string }) => r.id === created.id)).toBe(true);
    await http().get(`/ops-analytics/reports/${created.id}`).set(as('head')).expect(200);
    await http().patch(`/ops-analytics/reports/${created.id}`).set(as('head')).send({ name: 'Mine now' }).expect(403);
    await http().delete(`/ops-analytics/reports/${created.id}`).set(as('head')).expect(403);

    // A shared money report stays hidden from people who cannot see money, and they cannot save one.
    const money = (await http().post('/ops-analytics/reports').set(as('founder')).send({ name: 'E2E collections', shared: true, config: { ...config, metric: 'revenue_collected', dimension: 'month' } }).expect(201)).body;
    reportIds.push(money.id);
    head = (await http().get('/ops-analytics/reports').set(as('head')).expect(200)).body;
    expect(head.shared.some((r: { id: string }) => r.id === money.id)).toBe(false);
    await http().get(`/ops-analytics/reports/${money.id}`).set(as('head')).expect(403);
    await http().post('/ops-analytics/reports').set(as('head')).send({ name: 'Sneaky', config: { ...config, metric: 'revenue_raised', dimension: 'month' } }).expect(403);
    await http().post('/ops-analytics/reports').set(as('head')).send({ name: '', config }).expect(400);

    await http().delete(`/ops-analytics/reports/${created.id}`).set(as('founder')).expect(200);
    await http().get(`/ops-analytics/reports/${created.id}`).set(as('founder')).expect(404);
    const audit = await prisma.auditEvent.findFirst({ where: { entity: 'SavedReport', entityId: created.id, action: 'report.deleted' } });
    expect(audit).not.toBeNull();
  });
});
