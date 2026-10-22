// v40 project flow: the Client Manager asks Department Heads for a finish date and shares it with the client; heads
// give hours per step (Workload counts only assigned task hours); heads share finished parts the client approves or
// asks changes for (a task for the head).
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
const ids: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const stamp = Date.now();
const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const inDays = (n: number) => new Date(Date.now() + 330 * 60_000 + n * 86400000).toISOString().slice(0, 10);

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
  const people = { am: 'am@bmu.demo', head: 'design.head@bmu.demo', designer: 'design@bmu.demo', producer: 'producer@bmu.demo', sales: 'sales@bmu.demo', client: 'client@sunrise.demo' };
  for (const [k, email] of Object.entries(people)) {
    tokens[k] = await signIn(email);
    ids[k] = (await prisma.user.findFirstOrThrow({ where: { email } })).id;
  }
  const org = await prisma.organisation.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  ids.org = org.id;
  ids.sunrise = (await prisma.clientUser.findFirstOrThrow({ where: { userId: ids.client } })).clientOrgId;
  ids.dept = (await prisma.department.findFirstOrThrow({ where: { headUserId: ids.head, deletedAt: null } })).id;
  const svc = await prisma.service.findFirstOrThrow({ where: { orgId: org.id, key: 'website' } });
  ids.eng = (await prisma.engagement.create({ data: { orgId: org.id, clientOrgId: ids.sunrise, serviceId: svc.id, tier: 'growth', billingType: 'monthly', status: 'in_production', currentGate: 'G4', amId: ids.am } })).id;
});

afterAll(async () => {
  await prisma.projectMilestone.deleteMany({ where: { engagementId: ids.eng } });
  await prisma.projectEstimate.deleteMany({ where: { engagementId: ids.eng } });
  await prisma.task.deleteMany({ where: { OR: [{ engagementId: ids.eng }, { title: { contains: `${stamp}` } }] } });
  await prisma.file.deleteMany({ where: { engagementId: ids.eng } });
  await prisma.notification.deleteMany({ where: { link: { contains: ids.eng } } });
  await prisma.engagement.deleteMany({ where: { id: ids.eng } });
  await app.close();
});

describe('finish dates', () => {
  it('the CM asks the Department Head, the head gives a date, the CM shares it with the client', async () => {
    await http().post(`/project-flow/projects/${ids.eng}/estimates`).set(as('producer')).send({ departmentIds: [ids.dept] }).expect(403);
    const v = await http().post(`/project-flow/projects/${ids.eng}/estimates`).set(as('am')).send({ departmentIds: [ids.dept], note: `Landing + login ${stamp}` }).expect(200);
    expect(v.body.estimates).toHaveLength(1);
    expect(v.body.estimates[0].status).toBe('waiting');
    ids.estimate = v.body.estimates[0].id;
    expect(await prisma.notification.count({ where: { userId: ids.head, kind: 'estimate_requested', link: `/team/projects/${ids.eng}` } })).toBe(1);
    // The head sees it waiting on Work hand-off.
    expect(((await http().get('/project-flow/inbox').set(as('head')).expect(200)).body as { id: string }[]).some((r) => r.id === ids.estimate)).toBe(true);

    await http().post(`/project-flow/estimates/${ids.estimate}`).set(as('producer')).send({ finishBy: inDays(30) }).expect(403);
    await http().post(`/project-flow/estimates/${ids.estimate}`).set(as('head')).send({ finishBy: inDays(-2) }).expect(400);
    const g = await http().post(`/project-flow/estimates/${ids.estimate}`).set(as('head')).send({ finishBy: inDays(30), note: 'Two designers' }).expect(200);
    expect(g.body.estimates[0]).toMatchObject({ status: 'estimated', finishBy: inDays(30) });
    expect(await prisma.notification.count({ where: { userId: ids.am, kind: 'estimate_given', link: `/team/projects/${ids.eng}` } })).toBe(1);

    // Not shared yet: the client doesn't see it.
    const before = (await http().get('/project-flow/client/progress').set(as('client')).expect(200)).body.projects.find((p: { engagementId: string }) => p.engagementId === ids.eng);
    expect(before?.estimates ?? []).toHaveLength(0);
    const s = await http().post(`/project-flow/projects/${ids.eng}/estimates/share`).set(as('am')).send({ ids: [ids.estimate] }).expect(200);
    expect(s.body.estimates[0].status).toBe('shared');
    const after = (await http().get('/project-flow/client/progress').set(as('client')).expect(200)).body.projects.find((p: { engagementId: string }) => p.engagementId === ids.eng);
    expect(after.estimates[0]).toMatchObject({ finishBy: inDays(30), note: 'Two designers' });
  });
});

describe('requirements and tasks on the project page (v41)', () => {
  it('the CM sends requirement documents; the head opens them and gives tasks to the team with hours', async () => {
    const doc = await http().post(`/project-flow/projects/${ids.eng}/brief-files`).set(as('am')).attach('file', png, { filename: `brief-${stamp}.png`, contentType: 'image/png' }).expect(201);
    const link = await http().post(`/project-flow/projects/${ids.eng}/brief-links`).set(as('am')).send({ url: `https://docs.google.com/document/d/${stamp}` }).expect(201);
    const v = await http().post(`/project-flow/projects/${ids.eng}/estimates`).set(as('am')).send({ departmentIds: [ids.dept], note: 'Website, 5 pages', fileIds: [doc.body.id, link.body.id] }).expect(200);
    expect(v.body.estimates[0].docs.map((d: { kind: string }) => d.kind).sort()).toEqual(['image', 'link']);
    // The head can open the documents (and the client's team, as with other client files); someone outside can't.
    await http().get(`/files/${doc.body.id}`).set(as('head')).expect(200);
    await http().get(`/files/${doc.body.id}`).set(as('sales')).expect(404);

    // The head adds a task for their team: who, hours, deadline. Only people from the department.
    const view = (await http().get(`/project-flow/projects/${ids.eng}`).set(as('head')).expect(200)).body;
    expect(view.teams[0].people.some((p: { id: string }) => p.id === ids.designer)).toBe(true);
    await http().post(`/project-flow/projects/${ids.eng}/tasks`).set(as('head')).send({ departmentId: ids.dept, title: `Home page ${stamp}`, ownerId: ids.sales, hours: 8, deadline: inDays(5) }).expect(400);
    await http().post(`/project-flow/projects/${ids.eng}/tasks`).set(as('sales')).send({ departmentId: ids.dept, title: `Home page ${stamp}`, ownerId: ids.designer, hours: 8, deadline: inDays(5) }).expect(403);
    const added = await http().post(`/project-flow/projects/${ids.eng}/tasks`).set(as('head')).send({ departmentId: ids.dept, title: `Home page ${stamp}`, ownerId: ids.designer, hours: 8, deadline: inDays(5) }).expect(200);
    const t = added.body.tasks.find((x: { title: string }) => x.title === `Home page ${stamp}`);
    expect(t).toMatchObject({ hours: 8, deadline: inDays(5), owner: { id: ids.designer }, fromPlan: false });
    expect(await prisma.notification.count({ where: { userId: ids.designer, kind: 'task_assigned', link: `/team/tasks/${t.id}` } })).toBe(1);

    // A step from the approved plan (no person yet): the head gives it a person and hours here.
    const cycle = await prisma.cycle.create({ data: { orgId: ids.org, engagementId: ids.eng, period: `p-${stamp}` } });
    const d = await prisma.deliverable.create({ data: { orgId: ids.org, cycleId: cycle.id, type: 'post', title: `Menu page ${stamp}`, departmentId: ids.dept } });
    const make = await prisma.task.create({ data: { orgId: ids.org, title: `Design: Menu page ${stamp}`, deliverableId: d.id, departmentId: ids.dept, kind: 'work', status: 'todo' } });
    const qc = await prisma.task.create({ data: { orgId: ids.org, title: `QC: Menu page ${stamp}`, deliverableId: d.id, departmentId: ids.dept, kind: 'qc', status: 'todo' } });
    const before = (await http().get(`/project-flow/projects/${ids.eng}`).set(as('head')).expect(200)).body.tasks.find((x: { id: string }) => x.id === make.id);
    expect(before).toMatchObject({ owner: null, fromPlan: true });
    await http().post(`/project-flow/tasks/${make.id}/assign`).set(as('head')).send({ ownerId: ids.designer, hours: 6 }).expect(200);
    // QC can't go to the person who made it.
    await http().post(`/project-flow/tasks/${qc.id}/assign`).set(as('head')).send({ ownerId: ids.designer, hours: 1 }).expect(400);
    await http().post(`/project-flow/tasks/${qc.id}/assign`).set(as('head')).send({ ownerId: ids.head, hours: 1 }).expect(200);
    expect(await prisma.task.findUniqueOrThrow({ where: { id: make.id } })).toMatchObject({ ownerId: ids.designer, estimateMin: 360 });
    await prisma.task.deleteMany({ where: { deliverableId: d.id } });
    await prisma.deliverable.delete({ where: { id: d.id } });
    await prisma.cycle.delete({ where: { id: cycle.id } });
  });
});

describe('finished parts', () => {
  it('the head shares a demo; the client asks for changes (a task for the head), then approves the next one', async () => {
    const link = await http().post(`/project-flow/projects/${ids.eng}/milestone-links`).set(as('head')).send({ url: `https://staging.example.com/login-${stamp}` }).expect(201);
    const file = await http().post(`/project-flow/projects/${ids.eng}/milestone-files`).set(as('head')).attach('file', png, { filename: `login-${stamp}.png`, contentType: 'image/png' }).expect(201);
    // Before it is shared, the client can't open the file.
    await http().get(`/files/${file.body.id}`).set(as('client')).expect(404);
    await http().post(`/project-flow/projects/${ids.eng}/milestones`).set(as('producer')).send({ departmentId: ids.dept, title: 'Login page', fileIds: [link.body.id] }).expect(403);
    await http().post(`/project-flow/projects/${ids.eng}/milestones`).set(as('head')).send({ departmentId: ids.dept, title: 'Login page', fileIds: [] }).expect(400);
    const v = await http().post(`/project-flow/projects/${ids.eng}/milestones`).set(as('head')).send({ departmentId: ids.dept, title: `Login page ${stamp}`, note: 'Try signing in', fileIds: [link.body.id, file.body.id] }).expect(200);
    expect(v.body.milestones[0]).toMatchObject({ status: 'shared', title: `Login page ${stamp}` });
    expect(v.body.milestones[0].files).toHaveLength(2);
    expect(await prisma.notification.count({ where: { userId: ids.client, kind: 'milestone_shared' } })).toBeGreaterThan(0);
    // The client can open the demo file now; it's in Files as a Progress demo sent to the client.
    await http().get(`/files/${file.body.id}`).set(as('client')).expect(200);
    const rows = (await http().get('/ops/files').set(as('am')).expect(200)).body.rows as { id: string; source?: string; direction?: string }[];
    expect(rows.find((r) => r.id === file.body.id)).toMatchObject({ source: 'milestone', direction: 'to_client' });

    const progress = (await http().get('/project-flow/client/progress').set(as('client')).expect(200)).body.projects.find((p: { engagementId: string }) => p.engagementId === ids.eng);
    const m = progress.milestones[0];
    expect(m.canDecide).toBe(true);
    await http().post(`/project-flow/client/milestones/${m.id}/decision`).set(as('client')).send({ decision: 'changes' }).expect(400);
    const d = await http().post(`/project-flow/client/milestones/${m.id}/decision`).set(as('client')).send({ decision: 'changes', comment: 'Make the button bigger' }).expect(200);
    const after = d.body.projects.find((p: { engagementId: string }) => p.engagementId === ids.eng).milestones[0];
    expect(after).toMatchObject({ status: 'changes_requested', canDecide: false, clientComment: 'Make the button bigger' });
    const task = await prisma.task.findUniqueOrThrow({ where: { id: after.changeTaskId } });
    expect(task).toMatchObject({ ownerId: ids.head, engagementId: ids.eng, departmentId: ids.dept });
    expect(task.description).toContain('Make the button bigger');
    await http().post(`/project-flow/client/milestones/${m.id}/decision`).set(as('client')).send({ decision: 'approve' }).expect(400);

    const link2 = await http().post(`/project-flow/projects/${ids.eng}/milestone-links`).set(as('head')).send({ url: `https://staging.example.com/login-v2-${stamp}` }).expect(201);
    const v2 = await http().post(`/project-flow/projects/${ids.eng}/milestones`).set(as('head')).send({ departmentId: ids.dept, title: `Login page v2 ${stamp}`, fileIds: [link2.body.id] }).expect(200);
    const ok = await http().post(`/project-flow/client/milestones/${v2.body.milestones[0].id}/decision`).set(as('client')).send({ decision: 'approve' }).expect(200);
    expect(ok.body.projects.find((p: { engagementId: string }) => p.engagementId === ids.eng).milestones.find((x: { id: string }) => x.id === v2.body.milestones[0].id).status).toBe('approved');
    expect(await prisma.notification.count({ where: { userId: ids.head, kind: 'milestone_approved' } })).toBeGreaterThan(0);
  });
});

describe('Workload counts only assigned task hours', () => {
  it('the hours the head gives a task fill the person’s week; bookings are hidden', async () => {
    await prisma.task.create({ data: { orgId: ids.org, title: `Build hero ${stamp}`, ownerId: ids.designer, createdById: ids.head, engagementId: ids.eng, departmentId: ids.dept, kind: 'work', status: 'todo', estimateMin: 600, deadline: new Date(`${inDays(10)}T12:00:00Z`) } });
    await prisma.task.create({ data: { orgId: ids.org, title: `No hours ${stamp}`, ownerId: ids.designer, createdById: ids.head, kind: 'work', status: 'todo', deadline: new Date(`${inDays(3)}T12:00:00Z`) } });
    const w = (await http().get('/capacity/workload?weeks=6').set(as('head')).expect(200)).body;
    expect(w.mode).toBe('assigned_tasks');
    // Bookings still exist underneath (booking keeps working), but no booked hours fill the week.
    const row = w.people.find((p: { userId: string }) => p.userId === ids.designer);
    const cells = row.cells as { bookedHours: number; taskHours: number; noHoursTasks?: number }[];
    expect(cells.every((c) => c.bookedHours === 0)).toBe(true);
    // The 10h task is spread up to its deadline (other tasks of this person may add more).
    expect(cells.reduce((s, c) => s + c.taskHours, 0)).toBeGreaterThanOrEqual(9.9);
    expect(cells.reduce((s, c) => s + (c.noHoursTasks ?? 0), 0)).toBeGreaterThanOrEqual(1);
    expect((row.tasks as { title: string; hours: number | null }[]).find((t) => t.title === `Build hero ${stamp}`)?.hours).toBe(10);
  });
});
