// v20 mobile parity:
// - a task edited offline on the phone syncs correctly when back online (merge, idempotent resend, conflicts);
// - push notifications with quick actions (done, reply, snooze) through the Expo push service.
import 'dotenv/config';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { OfflineError, SyncQueue, taskSnapshot, withPending, type NotificationView, type QueuedOp, type SyncOpResult, type SyncPullView, type TaskView } from '@bmu/shared';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { PushService } from '../src/devices/push.service.js';

let app: INestApplication;
let prisma: PrismaService;
let orgId: string;
const tokens: Record<string, string> = {};
const users: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const stamp = Date.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let expo: Server;
const pushed: { to: string; title: string; categoryId: string; data: { notificationId: string; category: string; ref: string | null; actions: string[] } }[] = [];

async function signIn(email: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier: email }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier: email, code: otp.body.devCode }).expect(200)).body.token as string;
}
const op = (taskId: string, base: object, changes: object, id = `op-${Math.random().toString(36).slice(2, 12)}`) => ({ clientOpId: id, entity: 'task', entityId: taskId, op: 'update', base, changes, at: new Date().toISOString() });

beforeAll(async () => {
  // A stand-in for the Expo push service.
  expo = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msgs = JSON.parse(body) as typeof pushed;
      pushed.push(...msgs);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: msgs.map((m) => (m.to.includes('gone') ? { status: 'error', details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: 'x' })) }));
    });
  }).listen(0);
  process.env.EXPO_PUSH_URL = `http://127.0.0.1:${(expo.address() as AddressInfo).port}/push`;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ rawBody: true });
  app.use(cookieParser());
  await app.init();
  prisma = app.get(PrismaService);
  orgId = (await prisma.organisation.findFirstOrThrow({ orderBy: { createdAt: 'asc' } })).id;
  for (const [k, email] of Object.entries({ founder: 'founder@bmu.demo', design: 'design@bmu.demo', video: 'video@bmu.demo', am: 'am@bmu.demo' })) {
    tokens[k] = await signIn(email);
    users[k] = (await prisma.user.findFirstOrThrow({ where: { email } })).id;
  }
});

afterAll(async () => {
  delete process.env.EXPO_PUSH_URL;
  expo.close();
  await app.close();
});

const newTask = (title: string, ownerId = users.design) =>
  prisma.task.create({ data: { orgId, title, ownerId, status: 'todo', kind: 'work', isInternal: true, checklist: [{ id: 'a', label: 'Rough cut', done: false }, { id: 'b', label: 'Music', done: false }] } });

describe('Offline task edits sync when back online', () => {
  it('merges an offline edit with a change made online meanwhile', async () => {
    const t = await newTask(`Offline reel ${stamp}`);
    // What the phone saw before going offline.
    const base = { status: 'todo', title: t.title, checklist: [{ id: 'a', label: 'Rough cut', done: false }, { id: 'b', label: 'Music', done: false }] };
    // Offline on the phone: started it, ticked "Rough cut", added an item, logged 30 minutes.
    const offline = op(t.id, base, { status: 'in_progress', checklist: [{ id: 'a', label: 'Rough cut', done: true }, { id: 'b', label: 'Music', done: false }, { id: 'p1', label: 'Export vertical', done: false }], logMinutes: 30 });
    // Meanwhile the manager renamed it and added a checklist item on the website.
    await http().patch(`/tasks/${t.id}`).set(as('founder')).send({ title: `Offline reel ${stamp} (final)`, checklist: [{ id: 'a', label: 'Rough cut', done: false }, { id: 'b', label: 'Music', done: false }, { id: 'w1', label: 'Client logo', done: false }] }).expect(200);

    // Back online.
    const r = (await http().post('/sync/push').set(as('design')).send({ ops: [offline] }).expect(200)).body.results as SyncOpResult[];
    expect(r[0].status).toBe('merged');
    expect(r[0].conflicts.map((c) => c.field)).toEqual(['checklist']);
    const after = await prisma.task.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.status).toBe('in_progress');
    expect(after.title).toBe(`Offline reel ${stamp} (final)`);
    expect(after.timeLoggedMin).toBe(30);
    expect(after.checklist).toEqual([
      { id: 'a', label: 'Rough cut', done: true },
      { id: 'b', label: 'Music', done: false },
      { id: 'w1', label: 'Client logo', done: false },
      { id: 'p1', label: 'Export vertical', done: false },
    ]);
    expect(r[0].task?.status).toBe('in_progress');
    // The change is in the audit log as the person, like an online edit.
    expect(await prisma.auditEvent.count({ where: { entityId: t.id, actorId: users.design, action: 'task.updated' } })).toBe(1);

    // The phone lost the answer and sends the same op again: nothing is applied twice.
    const again = (await http().post('/sync/push').set(as('design')).send({ ops: [offline] }).expect(200)).body.results as SyncOpResult[];
    expect(again[0].status).toBe('merged');
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).timeLoggedMin).toBe(30);
  });

  it("the phone's own outbox: edits made with no signal wait, show at once, and sync when back online", async () => {
    const t = await newTask(`Outbox reel ${stamp}`);
    const view = (await http().get('/sync/pull').set(as('design')).expect(200)).body.tasks.find((x: TaskView) => x.id === t.id) as TaskView;
    let online = false;
    let saved: QueuedOp[] = [];
    const queue = new SyncQueue(
      { load: async () => saved, save: async (ops) => void (saved = JSON.parse(JSON.stringify(ops))) },
      async (ops) => {
        if (!online) throw new OfflineError();
        return (await http().post('/sync/push').set(as('design')).send({ ops }).expect(200)).body.results as SyncOpResult[];
      },
    );
    // No signal: start the task, then log time twice. The queue combines them into one change.
    await queue.enqueueTask(t.id, taskSnapshot(view), { status: 'in_progress' });
    await queue.enqueueTask(t.id, taskSnapshot(view), { logMinutes: 20 });
    await queue.enqueueTask(t.id, taskSnapshot(view), { logMinutes: 25 });
    expect(await queue.flush()).toEqual([]);
    expect(queue.pending()).toBe(1);
    expect(saved).toHaveLength(1); // kept on the phone if the app is closed
    const shown = withPending(view, queue.list());
    expect(shown.status).toBe('in_progress');
    expect(shown.pendingSync).toBe(true);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('todo');

    // The app restarts while still offline: the outbox comes back from storage.
    const reopened = new SyncQueue({ load: async () => saved, save: async (ops) => void (saved = JSON.parse(JSON.stringify(ops))) }, async (ops) => {
      if (!online) throw new OfflineError();
      return (await http().post('/sync/push').set(as('design')).send({ ops }).expect(200)).body.results as SyncOpResult[];
    });
    await reopened.init();
    expect(reopened.pending()).toBe(1);

    // Back online.
    online = true;
    const results = await reopened.flush();
    expect(results[0].status).toBe('applied');
    expect(reopened.pending()).toBe(0);
    const after = await prisma.task.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.status).toBe('in_progress');
    expect(after.timeLoggedMin).toBe(45);
  });

  it('a task finished elsewhere stays finished; the phone is told', async () => {
    const t = await newTask(`Finished elsewhere ${stamp}`);
    await http().patch(`/tasks/${t.id}`).set(as('founder')).send({ status: 'done' }).expect(200);
    const r = (await http().post('/sync/push').set(as('design')).send({ ops: [op(t.id, { status: 'todo' }, { status: 'blocked', blockedReason: 'Waiting for the logo' })] }).expect(200)).body.results as SyncOpResult[];
    expect(r[0].status).toBe('conflict');
    expect(r[0].conflicts[0]).toMatchObject({ field: 'status', yours: 'blocked', theirs: 'done', kept: 'theirs' });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('done');
  });

  it('several offline changes apply in the order they were made; refused ones come back as rejected', async () => {
    const t = await newTask(`Ordered ${stamp}`);
    const other = await newTask(`Not mine ${stamp}`, users.video);
    const first = { ...op(t.id, { status: 'todo' }, { status: 'in_progress' }), at: new Date(Date.now() - 60_000).toISOString() };
    const second = { ...op(t.id, { status: 'in_progress' }, { status: 'done' }), at: new Date().toISOString() };
    const r = (await http().post('/sync/push').set(as('design')).send({ ops: [second, first, op(other.id, { status: 'todo' }, { status: 'done' })] }).expect(200)).body.results as SyncOpResult[];
    expect(r.map((x) => x.status)).toEqual(['applied', 'applied', 'rejected']);
    expect(r[2].message).toMatch(/not found|owner/i);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('done');
    expect((await prisma.task.findUniqueOrThrow({ where: { id: other.id } })).status).toBe('todo');
    await http().post('/sync/push').set(as('design')).send({ ops: [] }).expect(400);
  });

  it('pull gives the phone its tasks to keep offline', async () => {
    const p = (await http().get('/sync/pull').set(as('design')).expect(200)).body as SyncPullView;
    expect(p.tasks.some((t: TaskView) => t.title === `Offline reel ${stamp} (final)`)).toBe(true);
    const since = (await http().get('/sync/pull').query({ since: p.now }).set(as('design')).expect(200)).body as SyncPullView;
    expect(since.tasks.length).toBeLessThan(p.tasks.length);
  });
});

describe('Push quick actions', () => {
  it('pushes notifications with the right buttons and handles Done, Reply and Snooze', async () => {
    await http().post('/devices/push-token').set(as('design')).send({ token: `ExponentPushToken[design-${stamp}]`, platform: 'android' }).expect(200);
    await http().post('/devices/push-token').set(as('design')).send({ token: `ExponentPushToken[gone-${stamp}]`, platform: 'ios' }).expect(200);
    const t = await newTask(`Push me ${stamp}`);
    await app.get(NotificationsService).notify(orgId, [users.design], { kind: 'task_assigned', title: `New task: Push me ${stamp}`, link: `/team/tasks/${t.id}` });
    for (let i = 0; i < 30 && !pushed.some((p) => p.title.includes(`Push me ${stamp}`)); i++) await sleep(50);
    const msg = pushed.find((p) => p.title.includes(`Push me ${stamp}`) && p.to.includes('design'))!;
    expect(msg.categoryId).toBe('task');
    expect(msg.data).toMatchObject({ category: 'task', ref: t.id, actions: ['done', 'snooze'] });
    // The uninstalled app's token is dropped.
    await sleep(100);
    expect(await prisma.pushToken.count({ where: { token: `ExponentPushToken[gone-${stamp}]` } })).toBe(0);

    await http().post('/devices/quick-action').set(as('design')).send({ notificationId: msg.data.notificationId, action: 'reply', text: 'hi' }).expect(403);
    const done = await http().post('/devices/quick-action').set(as('design')).send({ notificationId: msg.data.notificationId, action: 'done' }).expect(200);
    expect(done.body.message).toBe('Marked done');
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('done');
    await http().post('/devices/quick-action').set(as('video')).send({ notificationId: msg.data.notificationId, action: 'done' }).expect(404);

    // Reply to a client message from the lock screen.
    const thread = await prisma.thread.findFirstOrThrow({ where: { orgId, clientOrg: { amUserId: users.am }, type: 'client_am' } });
    await http().post('/devices/push-token').set(as('am')).send({ token: `ExponentPushToken[am-${stamp}]`, platform: 'ios' }).expect(200);
    await app.get(NotificationsService).notify(orgId, [users.am], { kind: 'message', title: `Message ${stamp}`, body: 'Can we move the shoot?', link: `/team/messages/${thread.id}` });
    for (let i = 0; i < 30 && !pushed.some((p) => p.title === `Message ${stamp}`); i++) await sleep(50);
    const m = pushed.find((p) => p.title === `Message ${stamp}`)!;
    expect(m.data.actions).toEqual(['reply', 'snooze']);
    await http().post('/devices/quick-action').set(as('am')).send({ notificationId: m.data.notificationId, action: 'reply', text: `Yes, Thursday works ${stamp}` }).expect(200);
    expect(await prisma.message.count({ where: { threadId: thread.id, authorId: users.am, body: `Yes, Thursday works ${stamp}` } })).toBe(1);

    // Snooze: hidden for an hour, then back (and pushed again).
    await app.get(NotificationsService).notify(orgId, [users.am], { kind: 'message', title: `Later ${stamp}`, link: `/team/messages/${thread.id}` });
    for (let i = 0; i < 30 && !pushed.some((p) => p.title === `Later ${stamp}`); i++) await sleep(50);
    const later = pushed.find((p) => p.title === `Later ${stamp}`)!;
    await http().post('/devices/quick-action').set(as('am')).send({ notificationId: later.data.notificationId, action: 'snooze' }).expect(200);
    const list = (await http().get('/notifications').set(as('am')).expect(200)).body as { items: NotificationView[] };
    expect(list.items.some((n) => n.id === later.data.notificationId)).toBe(false);
    const before = pushed.filter((p) => p.title === `Later ${stamp}`).length;
    expect(await app.get(PushService).wakeSnoozed(new Date(Date.now() + 61 * 60_000))).toBeGreaterThanOrEqual(1);
    expect(pushed.filter((p) => p.title === `Later ${stamp}`).length).toBe(before + 1);
    const back = (await http().get('/notifications').set(as('am')).expect(200)).body as { items: NotificationView[] };
    expect(back.items.some((n) => n.id === later.data.notificationId)).toBe(true);
  });
});
