// v54: a QC reviewer picked when a task is assigned. "Done" sends it to them; it counts as done only once they pass
// it. Not passed: back in progress with their notes, shown as "QC not passed"; the person (and whoever assigned it) is
// told either way. Also: tasks from a meeting can go to someone else, and copies tell their owner.
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
const notes = (who: string, taskId: string, kind: string) => prisma.notification.count({ where: { userId: ids[who], link: `/team/tasks/${taskId}`, kind } });

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  prisma = app.get(PrismaService);
  for (const [k, email] of Object.entries({ am: 'am@bmu.demo', producer: 'producer@bmu.demo', qc: 'qc@bmu.demo', head: 'design.head@bmu.demo' })) {
    tokens[k] = await signIn(email);
    ids[k] = (await prisma.user.findFirstOrThrow({ where: { email } })).id;
  }
  ids.dept = (await prisma.user.findUniqueOrThrow({ where: { id: ids.producer } })).departmentId!;
});

afterAll(async () => {
  const t = (await prisma.task.findMany({ where: { title: { contains: `${stamp}` } }, select: { id: true } })).map((x) => x.id);
  await prisma.taskQcReview.deleteMany({ where: { taskId: { in: t } } });
  await prisma.approvalRequest.deleteMany({ where: { targetId: { in: t } } });
  await prisma.assignment.deleteMany({ where: { targetId: { in: t } } });
  await prisma.notification.deleteMany({ where: { OR: t.map((id) => ({ link: { contains: id } })) } });
  await prisma.task.deleteMany({ where: { id: { in: t } } });
  await app.close();
});

const task = (title: string, extra: Record<string, unknown> = {}) => ({ title: tag(title), internal: true, deadline: due, estimateHours: 1, departmentId: ids.dept, ownerId: ids.producer, ...extra });

describe('QC check on a task', () => {
  it('passes only after the QC reviewer passes it; not passed sends it back with notes', async () => {
    // The reviewer can't be the person doing it.
    await http().post('/tasks').set(as('am')).send(task('Self review', { qcReviewerId: ids.producer })).expect(400);

    const made = (await http().post('/tasks').set(as('am')).send(task('Poster', { qcReviewerId: ids.qc })).expect(201)).body;
    const id = made.task.id as string;
    expect(made.task.qc).toMatchObject({ reviewer: { id: ids.qc }, state: null });
    // The reviewer is told they'll check it, and can open it.
    expect(await notes('qc', id, 'task_qc_waiting')).toBe(1);
    await http().get(`/tasks/${id}`).set(as('qc')).expect(200);

    // "Done" sends it for QC: not done yet.
    await http().post(`/tasks/${id}/status`).set(as('producer')).send({ status: 'in_progress' }).expect(200);
    const sent = (await http().post(`/tasks/${id}/status`).set(as('producer')).send({ status: 'done' }).expect(200)).body;
    expect(sent.message).toMatch(/for QC/);
    expect(sent.task).toMatchObject({ status: 'in_qc', qc: { state: 'waiting' } });
    expect((await prisma.task.findUniqueOrThrow({ where: { id } })).completedAt).toBeNull();
    expect(await notes('qc', id, 'task_qc_waiting')).toBe(2);
    await http().post(`/tasks/${id}/status`).set(as('producer')).send({ status: 'done' }).expect(400);
    // Only the reviewer checks it.
    await http().post(`/tasks/${id}/qc`).set(as('producer')).send({ result: 'pass' }).expect(403);
    await http().post(`/tasks/${id}/qc`).set(as('am')).send({ result: 'pass' }).expect(403);
    // It is on the reviewer's own list.
    const mine = (await http().get('/tasks/query?scope=mine').set(as('qc')).expect(200)).body as { id: string; qc: { mineToReview: boolean } }[];
    expect(mine.find((r) => r.id === id)?.qc.mineToReview).toBe(true);

    // Not passed: needs a note; back in progress with it; the person and whoever assigned it are told.
    await http().post(`/tasks/${id}/qc`).set(as('qc')).send({ result: 'fail' }).expect(400);
    const failed = (await http().post(`/tasks/${id}/qc`).set(as('qc')).send({ result: 'fail', note: 'Logo is cropped. Use the brand blue.' }).expect(200)).body;
    expect(failed.task).toMatchObject({ status: 'in_progress', qc: { state: 'failed', note: 'Logo is cropped. Use the brand blue.' } });
    expect(await notes('producer', id, 'task_qc_failed')).toBe(1);
    expect(await notes('am', id, 'task_qc_failed')).toBe(1);
    const told = await prisma.notification.findFirstOrThrow({ where: { userId: ids.producer, link: `/team/tasks/${id}`, kind: 'task_qc_failed' } });
    expect(told.body).toContain('Logo is cropped');
    // On the person's own list it shows "QC not passed", with the notes.
    const theirs = (await http().get('/tasks/query?scope=mine').set(as('producer')).expect(200)).body as { id: string; qc: { state: string; note: string } }[];
    expect(theirs.find((r) => r.id === id)?.qc).toMatchObject({ state: 'failed', note: 'Logo is cropped. Use the brand blue.' });

    // Fixed and sent again; passed: done, and the person is told.
    await http().post(`/tasks/${id}/status`).set(as('producer')).send({ status: 'done' }).expect(200);
    const passed = (await http().post(`/tasks/${id}/qc`).set(as('qc')).send({ result: 'pass', note: 'Looks good' }).expect(200)).body;
    expect(passed.task).toMatchObject({ status: 'done', qc: { state: 'passed' } });
    expect((await prisma.task.findUniqueOrThrow({ where: { id } })).completedAt).not.toBeNull();
    expect(await notes('producer', id, 'task_qc_passed')).toBe(1);
    const detail = (await http().get(`/tasks/${id}`).set(as('producer')).expect(200)).body;
    expect(detail.qcHistory.map((h: { result: string }) => h.result)).toEqual(['pass', 'fail']);
    await http().post(`/tasks/${id}/qc`).set(as('qc')).send({ result: 'pass' }).expect(400);
  });

  it('a task without a QC reviewer is done straight away; a manager can add a reviewer later', async () => {
    const id = (await http().post('/tasks').set(as('am')).send(task('No QC')).expect(201)).body.task.id as string;
    await http().post(`/tasks/${id}/status`).set(as('producer')).send({ status: 'in_progress' }).expect(200);
    const second = (await http().post('/tasks').set(as('am')).send(task('Add QC later')).expect(201)).body.task.id as string;
    await http().patch(`/tasks/${second}/details`).set(as('am')).send({ qcReviewerId: ids.qc }).expect(200);
    expect(await notes('qc', second, 'task_qc_waiting')).toBe(1);
    expect((await http().post(`/tasks/${id}/status`).set(as('producer')).send({ status: 'done' }).expect(200)).body.task.status).toBe('done');
  });

  it('shows on the dashboards: waiting for my check, and not passed', async () => {
    const id = (await http().post('/tasks').set(as('am')).send(task('Dashboard QC', { qcReviewerId: ids.head })).expect(201)).body.task.id as string;
    await http().post(`/tasks/${id}/status`).set(as('producer')).send({ status: 'in_progress' }).expect(200);
    await http().post(`/tasks/${id}/status`).set(as('producer')).send({ status: 'done' }).expect(200);
    // The reviewer (a Department Head, on the manager workspace) sees it to check.
    const mgr = (await http().get('/craft/manager').set(as('head')).expect(200)).body as { today: { kind: string; taskId?: string }[] };
    expect(mgr.today.some((i) => i.kind === 'qc_review' && i.taskId === id)).toBe(true);
    await http().post(`/tasks/${id}/qc`).set(as('head')).send({ result: 'fail', note: 'Wrong size' }).expect(200);
    // The person doing it (My work) sees it came back.
    const mine = (await http().get('/craft/dashboard').set(as('producer')).expect(200)).body as { next: { kind: string; href: string; detail: string }[] };
    const item = mine.next.find((i) => i.kind === 'qc_failed' && i.href === `/team/tasks/${id}`);
    expect(item?.detail).toContain('Wrong size');
  });

  it('"Mark done" on My Day and the task board also sends it to QC; My Day lists QC items', async () => {
    const id = (await http().post('/tasks').set(as('am')).send(task('Board QC', { qcReviewerId: ids.qc })).expect(201)).body.task.id as string;
    await http().patch(`/tasks/${id}`).set(as('producer')).send({ status: 'in_progress' }).expect(200);
    const done = (await http().patch(`/tasks/${id}`).set(as('producer')).send({ status: 'done' }).expect(200)).body;
    expect(done.status).toBe('in_qc');
    expect((await prisma.task.findUniqueOrThrow({ where: { id } })).completedAt).toBeNull();
    expect(await notes('qc', id, 'task_qc_waiting')).toBe(2);
    const reviewerDay = (await http().get('/my-day').set(as('qc')).expect(200)).body;
    expect(reviewerDay.taskQc.toReview.some((t: { id: string }) => t.id === id)).toBe(true);
    await http().post(`/tasks/${id}/qc`).set(as('qc')).send({ result: 'fail', note: 'Colours are off' }).expect(200);
    const myDay = (await http().get('/my-day').set(as('producer')).expect(200)).body;
    expect(myDay.taskQc.failed.find((t: { id: string }) => t.id === id)).toMatchObject({ note: 'Colours are off' });
  });

  it('copies of a task tell the person who gets them', async () => {
    const id = (await http().post('/tasks').set(as('am')).send(task('Copy me')).expect(201)).body.task.id as string;
    const r = (await http().post(`/tasks/${id}/duplicate`).set(as('am')).send({ count: 1 }).expect(201)).body as { ids: string[] };
    expect(await prisma.notification.count({ where: { userId: ids.producer, link: `/team/tasks/${r.ids[0]}`, kind: 'task_assigned' } })).toBe(1);
  });
});
