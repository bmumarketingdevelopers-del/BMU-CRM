// v37 manual hand-off: when the plan is approved nobody is picked automatically (except the Client Manager's client
// review); the Client Manager sends the work to the Department Head with the requirements; the head picks people from
// their own department and a QC reviewer (or themselves) for QC, never the maker; production starts once every step has
// a person; the Client Manager sees it all; a later month of the same project reuses the team; a head who has not
// assigned within a working day is reminded once.
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { HandoffDeliverable, HandoffInbox, HandoffOptions, ProjectHandoffView } from '@bmu/shared';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { generateProductionTasks } from '../src/production/generate.js';
import { HandoffService } from '../src/deliver/handoff.service.js';

let app: INestApplication;
let prisma: PrismaService;
const tokens: Record<string, string> = {};
const users: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const since = new Date();
/** Unique per run: the app holds back an identical unread alert sent within 10 minutes. */
const run = String(Date.now() % 100000);
const EMAILS = { am: 'am@bmu.demo', designHead: 'design.head@bmu.demo', producer: 'producer@bmu.demo', design: 'design@bmu.demo', qc: 'qc@bmu.demo', dev: 'dev@bmu.demo', sales: 'sales@bmu.demo', founder: 'founder@bmu.demo' };

let engagementId = '';
let designDept = '';
let clientClean = false;
const cycles: string[] = [];

async function signIn(email: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier: email }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier: email, code: otp.body.devCode }).expect(200)).body.token as string;
}
const told = (userId: string, title: string) => prisma.notification.count({ where: { userId, createdAt: { gte: since }, title: { contains: title } } });

async function newMonth(period: string, titles: string[]) {
  const c = await prisma.cycle.create({ data: { orgId: (await prisma.engagement.findUniqueOrThrow({ where: { id: engagementId } })).orgId, engagementId, period, status: 'production' } });
  cycles.push(c.id);
  for (const title of titles) await prisma.deliverable.create({ data: { orgId: c.orgId, cycleId: c.id, type: 'post', title } });
  return c.id;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  prisma = app.get(PrismaService);
  for (const [k, email] of Object.entries(EMAILS)) {
    tokens[k] = await signIn(email);
    users[k] = (await prisma.user.findFirstOrThrow({ where: { email } })).id;
  }
  designDept = (await prisma.department.findFirstOrThrow({ where: { headUserId: users.designHead } })).id;
  // A fresh project for one of the Client Manager's clients (prefer a client with nothing overdue, so Gate 3 can pass).
  const bases = await prisma.engagement.findMany({ where: { amId: users.am, deletedAt: null }, select: { orgId: true, clientOrgId: true, serviceId: true, tier: true, billingType: true } });
  let base = bases[0];
  for (const b of bases) {
    const overdue = await prisma.invoice.count({ where: { clientOrgId: b.clientOrgId, OR: [{ status: 'overdue' }, { status: { in: ['issued', 'partially_paid'] }, dueDate: { lt: new Date() } }] } });
    if (!overdue) {
      base = b;
      clientClean = true;
      break;
    }
  }
  const e = await prisma.engagement.create({ data: { ...base, amId: users.am, status: 'in_production', currentGate: 'G3' } });
  engagementId = e.id;
});

afterAll(async () => {
  await prisma.task.deleteMany({ where: { engagementId } });
  await prisma.deliverable.deleteMany({ where: { cycleId: { in: cycles } } });
  await prisma.cycle.deleteMany({ where: { id: { in: cycles } } });
  await prisma.engagement.delete({ where: { id: engagementId } });
  await app.close();
});

describe('manual hand-off', () => {
  let d: HandoffDeliverable;

  it('an approved plan picks nobody automatically, except the Client Manager for the client review', async () => {
    const cycleId = await newMonth('2026-11', [`Diwali post ${run}`, `Offer carousel ${run}`]);
    const r = await generateProductionTasks(prisma, cycleId);
    expect(r.created).toBeGreaterThan(0);
    expect(r.g3Passed).toBe(false);
    const tasks = await prisma.task.findMany({ where: { deliverable: { cycleId } } });
    for (const t of tasks) expect(t.ownerId, t.title).toBe(t.kind === 'client_review' ? users.am : null);
    const v = (await http().get(`/handoff/projects/${engagementId}`).set(as('am')).expect(200)).body as ProjectHandoffView;
    expect(v.canSend).toBe(true);
    expect(v.deliverables.map((x) => x.status)).toEqual(['not_sent', 'not_sent']);
    d = v.deliverables[0];
    expect(d.department?.id).toBe(designDept);
    const inbox = (await http().get('/handoff/inbox').set(as('am')).expect(200)).body as HandoffInbox;
    expect(inbox.notSent.some((x) => x.id === d.id)).toBe(true);
  });

  it('only the Client Manager sends the work, with the requirements, to the Department Head', async () => {
    await http().post(`/handoff/projects/${engagementId}/send`).set(as('producer')).send({ items: [{ deliverableId: d.id, departmentId: designDept }] }).expect(403);
    const v = (await http().post(`/handoff/projects/${engagementId}/send`).set(as('am')).send({ items: [{ deliverableId: d.id, departmentId: designDept }], note: 'Festive look, client logo top right, CTA "Order now".' }).expect(200)).body as ProjectHandoffView;
    d = v.deliverables.find((x) => x.id === d.id)!;
    expect(d).toMatchObject({ status: 'waiting', head: { id: users.designHead }, note: 'Festive look, client logo top right, CTA "Order now".', sentBy: { id: users.am } });
    expect(await told(users.designHead, 'sent you work')).toBe(1);
    const head = (await http().get('/handoff/inbox').set(as('designHead')).expect(200)).body as HandoffInbox;
    expect(head.isHead).toBe(true);
    expect(head.toAssign.some((x) => x.id === d.id && x.can.assign)).toBe(true);
    const cm = (await http().get('/handoff/inbox').set(as('am')).expect(200)).body as HandoffInbox;
    expect(cm.waitingForHeads.some((x) => x.id === d.id)).toBe(true);
    // Another department's head sees nothing of it.
    expect(((await http().get('/handoff/inbox').set(as('sales')).expect(200)).body as HandoffInbox).toAssign).toHaveLength(0);
  });

  it('the Department Head picks people from their department, a QC reviewer or themselves for QC, never the maker', async () => {
    await http().get(`/handoff/deliverables/${d.id}/options`).set(as('sales')).expect(403);
    const o = (await http().get(`/handoff/deliverables/${d.id}/options`).set(as('designHead')).expect(200)).body as HandoffOptions;
    const deptPeople = (await prisma.user.findMany({ where: { departmentId: designDept }, select: { id: true } })).map((u) => u.id);
    expect(o.makers.every((p) => deptPeople.includes(p.id))).toBe(true);
    expect(o.makers.map((p) => p.id)).not.toContain(users.dev);
    expect(o.qc.map((p) => p.id)).toEqual(expect.arrayContaining([users.qc, users.designHead]));
    const step = (kind: string, i = 0) => d.steps.filter((s) => s.kind === kind)[i];
    const works = d.steps.filter((s) => s.kind === 'work');
    let r = await http().post(`/handoff/deliverables/${d.id}/assign`).set(as('designHead')).send({ steps: [{ taskId: works[0].taskId, ownerId: users.dev }] }).expect(400);
    expect(r.body.message).toContain('own department');
    r = await http().post(`/handoff/deliverables/${d.id}/assign`).set(as('designHead')).send({ steps: [...works.map((w) => ({ taskId: w.taskId, ownerId: users.producer })), { taskId: step('qc').taskId, ownerId: users.producer }] }).expect(400);
    expect(r.body.message).toMatch(/QC/);
    await http().post(`/handoff/deliverables/${d.id}/assign`).set(as('designHead')).send({ steps: [{ taskId: step('client_review').taskId, ownerId: users.producer }] }).expect(400);
    // Part of the team first: still waiting.
    const half = (await http().post(`/handoff/deliverables/${d.id}/assign`).set(as('designHead')).send({ steps: [{ taskId: works[0].taskId, ownerId: users.design }] }).expect(200)).body as HandoffDeliverable;
    expect(half.status).toBe('waiting');
    const full = (await http().post(`/handoff/deliverables/${d.id}/assign`).set(as('designHead')).send({ steps: [...works.map((w) => ({ taskId: w.taskId, ownerId: users.producer })), { taskId: step('qc').taskId, ownerId: users.qc }] }).expect(200)).body as HandoffDeliverable;
    expect(full.status).toBe('assigned');
    expect(full.steps.find((s) => s.kind === 'qc')?.owner?.id).toBe(users.qc);
    expect(await told(users.producer, 'put you on')).toBeGreaterThanOrEqual(1);
    expect(await told(users.qc, 'put you on')).toBe(1);
    expect(await told(users.am, 'assigned the team for')).toBe(1);
  });

  it('production starts once every step of the project has a person; the CM sees each status', async () => {
    let v = (await http().get(`/handoff/projects/${engagementId}`).set(as('am')).expect(200)).body as ProjectHandoffView;
    expect(v.deliverables.map((x) => x.status).sort()).toEqual(['assigned', 'not_sent']);
    expect((await prisma.engagement.findUniqueOrThrow({ where: { id: engagementId } })).currentGate).toBe('G3');
    const other = v.deliverables.find((x) => x.status === 'not_sent')!;
    await http().post(`/handoff/projects/${engagementId}/send`).set(as('am')).send({ items: [{ deliverableId: other.id, departmentId: designDept }] }).expect(200);
    const works = other.steps.filter((s) => s.kind === 'work');
    const qc = other.steps.find((s) => s.kind === 'qc')!;
    // The head can also do QC themselves.
    await http().post(`/handoff/deliverables/${other.id}/assign`).set(as('designHead')).send({ steps: [...works.map((w) => ({ taskId: w.taskId, ownerId: users.producer })), { taskId: qc.taskId, ownerId: users.designHead }] }).expect(200);
    await http().post(`/handoff/deliverables/${other.id}/assign`).set(as('designHead')).send({ steps: [{ taskId: qc.taskId, ownerId: users.qc }] }).expect(200);
    v = (await http().get(`/handoff/projects/${engagementId}`).set(as('am')).expect(200)).body as ProjectHandoffView;
    expect(v.deliverables.every((x) => x.status === 'assigned')).toBe(true);
    if (clientClean) {
      expect((await prisma.engagement.findUniqueOrThrow({ where: { id: engagementId } })).currentGate).toBe('G4');
      expect(await told(users.am, 'Production started')).toBe(1);
    }
  });

  it("the project's next month reuses the same team, with nothing to send", async () => {
    const cycleId = await newMonth('2026-12', [`New year post ${run}`]);
    await prisma.engagement.update({ where: { id: engagementId }, data: { currentGate: 'G3' } });
    const r = await generateProductionTasks(prisma, cycleId);
    expect(r.unassigned).toBe(0);
    const tasks = await prisma.task.findMany({ where: { deliverable: { cycleId } } });
    expect(tasks.find((t) => t.kind === 'qc')?.ownerId).toBe(users.qc);
    expect(tasks.filter((t) => t.kind === 'work').every((t) => t.ownerId === users.producer)).toBe(true);
    const v = (await http().get(`/handoff/projects/${engagementId}`).set(as('am')).expect(200)).body as ProjectHandoffView;
    expect(v.deliverables).toEqual([expect.objectContaining({ status: 'assigned', assignedAt: expect.any(String) })]);
  });

  it('a Department Head who has not picked the team within a working day is reminded once, and the CM is told', async () => {
    const cycleId = await newMonth('2027-01', [`Late post ${run}`]);
    await prisma.task.deleteMany({ where: { engagementId, deliverable: { cycleId: { in: cycles.slice(0, 2) } } } });
    await generateProductionTasks(prisma, cycleId);
    const late = await prisma.deliverable.findFirstOrThrow({ where: { cycleId } });
    await prisma.deliverable.update({ where: { id: late.id }, data: { handoffAt: new Date(Date.now() - 4 * 86_400_000), handoffHeadId: users.designHead, departmentId: designDept } });
    const svc = app.get(HandoffService);
    expect(await svc.remind()).toBeGreaterThanOrEqual(1);
    expect(await svc.remind()).toBe(0);
    expect(await told(users.designHead, `Reminder: pick the team for Late post ${run}`)).toBe(1);
    expect(await told(users.am, `has not picked the team for Late post ${run}`)).toBe(1);
  });
});
