// v38: files sent in a discussion or on a task land in Files for the people they were sent to (and the sender, the
// Founder and Branch Managers) and nobody else: not the department, not other leadership, not the client.
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

async function signIn(email: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier: email }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier: email, code: otp.body.devCode }).expect(200)).body.token as string;
}

const listed = async (who: string, fileId: string) => ((await http().get('/ops/files').set(as(who)).expect(200)).body.rows as { id: string; source?: string }[]).find((r) => r.id === fileId);

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  prisma = app.get(PrismaService);
  const people = { am: 'am@bmu.demo', head: 'design.head@bmu.demo', designer: 'design@bmu.demo', producer: 'producer@bmu.demo', founder: 'founder@bmu.demo', admin: 'admin@bmu.demo', finance: 'finance@bmu.demo', client: 'client@sunrise.demo' };
  for (const [k, email] of Object.entries(people)) {
    tokens[k] = await signIn(email);
    ids[k] = (await prisma.user.findFirstOrThrow({ where: { email } })).id;
  }
  ids.sunrise = (await prisma.clientUser.findFirstOrThrow({ where: { userId: ids.client } })).clientOrgId;
});

afterAll(async () => {
  const files = await prisma.file.findMany({ where: { name: { contains: `${stamp}` } }, select: { id: true } });
  await prisma.message.deleteMany({ where: { thread: { title: { contains: `${stamp}` } } } });
  await prisma.thread.deleteMany({ where: { title: { contains: `${stamp}` } } });
  await prisma.watcher.deleteMany({ where: { targetType: 'task', targetId: ids.task ?? '' } });
  await prisma.task.deleteMany({ where: { title: { contains: `${stamp}` } } });
  await prisma.notification.deleteMany({ where: { title: { contains: `${stamp}` } } });
  await prisma.file.deleteMany({ where: { id: { in: files.map((f) => f.id) } } });
  await app.close();
});

describe('files sent in a discussion', () => {
  it('reach the people in the discussion and leadership only', async () => {
    const t = await http().post('/ops/threads').set(as('am')).send({ kind: 'internal', clientOrgId: ids.sunrise, title: `Brief ${stamp}`, message: 'See the file', participantIds: [ids.head] }).expect(201);
    ids.thread = t.body.id;
    const f = await http().post(`/ops/threads/${ids.thread}/attachments`).set(as('am')).attach('file', png, { filename: `moodboard-${stamp}.png`, contentType: 'image/png' }).expect(201);
    ids.discussionFile = f.body.id;
    // Someone else can't send a file they didn't upload here.
    await http().post(`/ops/threads/${ids.thread}/messages`).set(as('head')).send({ body: '', attachmentIds: [ids.discussionFile] }).expect(400);
    const v = await http().post(`/ops/threads/${ids.thread}/messages`).set(as('am')).send({ body: '', attachmentIds: [ids.discussionFile] }).expect(201);
    expect(v.body.messages.at(-1).attachments).toEqual([expect.objectContaining({ id: ids.discussionFile, url: `/api/files/${ids.discussionFile}` })]);

    // In the discussion: the Department Head sees it in Files and can open it.
    expect((await listed('head', ids.discussionFile))?.source).toBe('discussion');
    await http().get(`/files/${ids.discussionFile}`).set(as('head')).expect(200);
    // Leadership: Founder and Branch Manager yes; Finance (sees every other file) no.
    expect(await listed('founder', ids.discussionFile)).toBeTruthy();
    await http().get(`/files/${ids.discussionFile}`).set(as('admin')).expect(200);
    expect(await listed('finance', ids.discussionFile)).toBeUndefined();
    await http().get(`/files/${ids.discussionFile}`).set(as('finance')).expect(404);
    // Not in it: a producer, the client.
    expect(await listed('producer', ids.discussionFile)).toBeUndefined();
    await http().get(`/files/${ids.discussionFile}`).set(as('producer')).expect(404);
    await http().get(`/files/${ids.discussionFile}`).set(as('client')).expect(404);
  });
});

describe('files sent on a task', () => {
  it('reach the owner, creator and watchers, who are told', async () => {
    const task = await prisma.task.create({ data: { orgId: (await prisma.user.findUniqueOrThrow({ where: { id: ids.am } })).orgId, title: `Banner ${stamp}`, ownerId: ids.designer, createdById: ids.am, kind: 'work', status: 'todo', isInternal: true } });
    ids.task = task.id;
    const r = await http().post(`/tasks/${task.id}/files`).set(as('am')).attach('file', png, { filename: `banner-${stamp}.png`, contentType: 'image/png' }).expect(201);
    expect(r.body.task.files).toHaveLength(1);
    ids.taskFile = r.body.task.files[0].id;
    expect(await prisma.notification.count({ where: { userId: ids.designer, kind: 'task_file', title: { contains: `${stamp}` } } })).toBe(1);

    // The owner finds it in Files, labelled Task.
    expect((await listed('designer', ids.taskFile))?.source).toBe('task');
    await http().get(`/files/${ids.taskFile}`).set(as('designer')).expect(200);
    expect((await http().get(`/tasks/${task.id}`).set(as('designer')).expect(200)).body.files).toHaveLength(1);
    // The department's head and a producer aren't on the task.
    await http().get(`/files/${ids.taskFile}`).set(as('head')).expect(404);
    await http().get(`/files/${ids.taskFile}`).set(as('producer')).expect(404);
    // Watching the task opens it.
    await prisma.watcher.create({ data: { orgId: task.orgId, userId: ids.producer, targetType: 'task', targetId: task.id } });
    await http().get(`/files/${ids.taskFile}`).set(as('producer')).expect(200);
    await http().get(`/files/${ids.taskFile}`).set(as('founder')).expect(200);
  });
});
