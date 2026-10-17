// v32: who may be given a task. Department Heads: their own team (or themselves). The Founder, Branch Manager and
// client leads: only the chosen departments' heads, one copy each when several departments are picked.
// Also: Founders don't ask for attendance corrections.
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
const tag = (s: string) => `${s} ${stamp}`;
const due = new Date(Date.now() + 45 * 86_400_000 + 330 * 60_000).toISOString().slice(0, 10);

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
  ids.org = org.id;
  for (const [k, email] of Object.entries({ founder: 'founder@bmu.demo', admin: 'admin@bmu.demo', am: 'am@bmu.demo', head: 'design.head@bmu.demo', producer: 'producer@bmu.demo' })) {
    tokens[k] = await signIn(email);
    ids[k] = (await prisma.user.findFirstOrThrow({ where: { email } })).id;
  }
  // The design head's department, plus a second department with its own head and one with no head (all in one branch).
  const head = await prisma.user.findFirstOrThrow({ where: { id: ids.head }, include: { department: true } });
  const headed = await prisma.department.findFirst({ where: { headUserId: ids.head, deletedAt: null } });
  ids.deptA = headed?.id ?? head.departmentId!;
  const branchId = (await prisma.department.findUniqueOrThrow({ where: { id: ids.deptA } })).branchId;
  const headRole = await prisma.role.findFirstOrThrow({ where: { orgId: org.id, baseRole: 'department_head', isCustom: false } });
  const producerRole = await prisma.role.findFirstOrThrow({ where: { orgId: org.id, baseRole: 'producer', isCustom: false } });
  ids.headB = (await prisma.user.create({ data: { orgId: org.id, type: 'staff', name: tag('Head B'), email: `assign.headb.${stamp}@example.com`, status: 'active', branchId, roles: { create: { roleId: headRole.id } } } })).id;
  ids.deptB = (await prisma.department.create({ data: { orgId: org.id, branchId, name: tag('Dept B'), headUserId: ids.headB } })).id;
  ids.deptNone = (await prisma.department.create({ data: { orgId: org.id, branchId, name: tag('Dept None') } })).id;
  await prisma.user.update({ where: { id: ids.headB }, data: { departmentId: ids.deptB } });
  ids.teamA = (await prisma.user.create({ data: { orgId: org.id, type: 'staff', name: tag('Team A'), email: `assign.teama.${stamp}@example.com`, status: 'active', departmentId: ids.deptA, roles: { create: { roleId: producerRole.id } } } })).id;
  ids.teamB = (await prisma.user.create({ data: { orgId: org.id, type: 'staff', name: tag('Team B'), email: `assign.teamb.${stamp}@example.com`, status: 'active', departmentId: ids.deptB, roles: { create: { roleId: producerRole.id } } } })).id;
});

afterAll(async () => {
  const tasks = await prisma.task.findMany({ where: { title: { contains: `${stamp}` } }, select: { id: true } });
  const t = tasks.map((x) => x.id);
  await prisma.approvalRequest.deleteMany({ where: { targetId: { in: t } } });
  await prisma.assignment.deleteMany({ where: { targetId: { in: t } } });
  await prisma.task.deleteMany({ where: { id: { in: t } } });
  await prisma.notification.deleteMany({ where: { title: { contains: `${stamp}` } } });
  await prisma.user.updateMany({ where: { email: { contains: `.${stamp}@example.com` } }, data: { deletedAt: new Date(), status: 'suspended', departmentId: null } });
  await prisma.department.updateMany({ where: { id: { in: [ids.deptB, ids.deptNone] } }, data: { deletedAt: new Date(), headUserId: null } });
  await app.close();
});

const task = (title: string, extra: Record<string, unknown>) => ({ title: tag(title), internal: true, deadline: due, estimateHours: 1, ...extra });

describe('who can be given a task', () => {
  it('tells each person how they assign, with each department head', async () => {
    const f = (await http().get('/tasks/form-options').set(as('founder')).expect(200)).body;
    expect(f.assignMode).toBe('heads');
    expect(f.departments.find((d: { id: string }) => d.id === ids.deptB).head).toMatchObject({ id: ids.headB });
    expect(f.departments.find((d: { id: string }) => d.id === ids.deptNone).head).toBeNull();
    const h = (await http().get('/tasks/form-options').set(as('head')).expect(200)).body;
    expect(h.assignMode).toBe('team');
    expect(h.teamDepartmentIds).toContain(ids.deptA);
    expect((await http().get('/tasks/form-options').set(as('producer')).expect(200)).body.assignMode).toBe('self');
    expect((await http().get('/tasks/form-options').set(as('am')).expect(200)).body.assignMode).toBe('heads');
  });

  it('lists only the chosen department head for the Founder, and only the team for a Department Head', async () => {
    const f = (await http().get(`/actions/reassign/task/candidates?departmentId=${ids.deptB}`).set(as('founder')).expect(200)).body;
    expect(f.candidates.map((c: { id: string }) => c.id)).toEqual([ids.headB]);
    const h = (await http().get(`/actions/reassign/task/candidates?departmentId=${ids.deptA}`).set(as('head')).expect(200)).body;
    const list = h.candidates.map((c: { id: string }) => c.id);
    expect(list).toContain(ids.teamA);
    expect(list).toContain(ids.head);
    expect(list).not.toContain(ids.teamB);
    expect(list).not.toContain(ids.headB);
  });

  it('the Founder, Branch Manager and Client Managers give tasks only to Department Heads', async () => {
    await http().post('/tasks').set(as('founder')).send(task('Founder to team', { departmentId: ids.deptB, ownerId: ids.teamB })).expect(403);
    await http().post('/tasks').set(as('founder')).send(task('Founder to wrong head', { departmentId: ids.deptB, ownerId: ids.head })).expect(403);
    const ok = (await http().post('/tasks').set(as('founder')).send(task('Founder to head', { departmentId: ids.deptB, ownerId: ids.headB })).expect(201)).body;
    expect(ok.task.owner?.id ?? (await prisma.task.findUniqueOrThrow({ where: { id: ok.task.id } })).ownerId).toBe(ids.headB);
    await http().post('/tasks').set(as('admin')).send(task('Admin to team', { departmentId: ids.deptA, ownerId: ids.teamA })).expect(403);
    await http().post('/tasks').set(as('am')).send(task('CM to team', { departmentId: ids.deptA, ownerId: ids.teamA })).expect(403);
    await http().post('/tasks').set(as('founder')).send(task('No head', { departmentId: ids.deptNone, ownerId: ids.headB })).expect(400);
  });

  it('sends one copy to each chosen Department Head, all or none', async () => {
    const r = (await http().post('/tasks').set(as('founder')).send(task('Two heads', { departmentId: ids.deptA, departmentIds: [ids.deptA, ids.deptB], ownerId: ids.head })).expect(201)).body;
    expect(r.message).toMatch(/2 Department Heads/);
    const copies = await prisma.task.findMany({ where: { title: tag('Two heads') }, select: { ownerId: true, departmentId: true } });
    expect(copies.map((c) => c.ownerId).sort()).toEqual([ids.head, ids.headB].sort());
    expect(copies.map((c) => c.departmentId).sort()).toEqual([ids.deptA, ids.deptB].sort());
    // A department without a head: nothing is created.
    await http().post('/tasks').set(as('founder')).send(task('Missing head', { departmentId: ids.deptA, departmentIds: [ids.deptA, ids.deptNone], ownerId: ids.head })).expect(400);
    expect(await prisma.task.count({ where: { title: tag('Missing head') } })).toBe(0);
    // Only those who send work to heads can fan out.
    await http().post('/tasks').set(as('head')).send(task('Head fan-out', { departmentId: ids.deptA, departmentIds: [ids.deptA, ids.deptB], ownerId: ids.head })).expect(403);
  });

  it('a Department Head gives work to their own team or keeps it', async () => {
    await http().post('/tasks').set(as('head')).send(task('Head to team', { departmentId: ids.deptA, ownerId: ids.teamA })).expect(201);
    await http().post('/tasks').set(as('head')).send(task('Head to self', { departmentId: ids.deptA, ownerId: ids.head })).expect(201);
    await http().post('/tasks').set(as('head')).send(task('Head to outsider', { departmentId: ids.deptA, ownerId: ids.teamB })).expect(403);
  });

  it('reassigning follows the same rules', async () => {
    const t = await prisma.task.findFirstOrThrow({ where: { title: tag('Founder to head') } });
    const pre = await http().post('/actions/reassign/task/preview').set(as('founder')).send({ ids: [t.id], toUserId: ids.teamB }).expect(400);
    expect(pre.body.message).toMatch(/can't take this kind of work/);
    await http().patch(`/tasks/${t.id}`).set(as('founder')).send({ ownerId: ids.teamB }).expect(403);
  });
});

describe('attendance corrections', () => {
  it('are not for Founders', async () => {
    await http().post('/admin-org/attendance/corrections').set(as('founder')).send({ date: new Date(Date.now() + 330 * 60_000 - 86_400_000).toISOString().slice(0, 10), checkIn: '09:30', checkOut: '18:30', reason: 'Testing founders' }).expect(403);
    expect((await http().get('/workspace/profile').set(as('founder')).expect(200)).body.leave.canApply).toBe(false);
  });
});
