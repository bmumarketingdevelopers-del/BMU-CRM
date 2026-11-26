// v53 Discussions: nobody is notified about a message while they have that discussion open in a tab they are
// looking at; and a team member can chat with a client they work on (the client sees it in Messages), never with others.
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
const made: string[] = [];

async function signIn(email: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier: email }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier: email, code: otp.body.devCode }).expect(200)).body.token as string;
}
const notices = (who: string, threadId: string) => prisma.notification.count({ where: { userId: ids[who], link: { contains: threadId } } });

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  prisma = app.get(PrismaService);
  const people = { founder: 'founder@bmu.demo', am: 'am@bmu.demo', designer: 'design@bmu.demo', producer: 'producer@bmu.demo', client: 'client@sunrise.demo' };
  for (const [k, email] of Object.entries(people)) {
    tokens[k] = await signIn(email);
    ids[k] = (await prisma.user.findFirstOrThrow({ where: { email } })).id;
  }
  ids.org = (await prisma.user.findUniqueOrThrow({ where: { id: ids.am } })).orgId;
  ids.sunrise = (await prisma.clientUser.findFirstOrThrow({ where: { userId: ids.client } })).clientOrgId;
  // The designer works on Sunrise (a task there); another client they don't work on.
  const eng = await prisma.engagement.findFirstOrThrow({ where: { clientOrgId: ids.sunrise, deletedAt: null } });
  ids.task = (await prisma.task.create({ data: { orgId: ids.org, engagementId: eng.id, ownerId: ids.designer, title: `Chat test ${stamp}` } })).id;
  ids.other = (await prisma.clientOrg.create({ data: { orgId: ids.org, name: `Not theirs ${stamp}` } })).id;
});

afterAll(async () => {
  await prisma.message.deleteMany({ where: { threadId: { in: made } } });
  await prisma.threadRead.deleteMany({ where: { threadId: { in: made } } });
  await prisma.notification.deleteMany({ where: { OR: made.map((id) => ({ link: { contains: id } })) } });
  await prisma.thread.deleteMany({ where: { id: { in: made } } });
  await prisma.task.deleteMany({ where: { id: ids.task } });
  await prisma.clientOrg.deleteMany({ where: { id: ids.other } });
  await app.close();
});

describe('notifications in Discussions', () => {
  it('nobody is notified while they have the discussion open and are looking at it; they are once they leave', async () => {
    const t = (await http().post('/ops/threads').set(as('am')).send({ kind: 'internal', clientOrgId: ids.sunrise, title: `Live ${stamp}`, participantIds: [ids.producer] }).expect(201)).body;
    made.push(t.id);
    const before = await notices('producer', t.id);
    // The producer has it open in a tab they are looking at: no notification.
    const k1 = (await http().post(`/ops/threads/${t.id}/pulse`).set(as('producer')).send({ active: true }).expect(200)).body.last;
    await http().post(`/ops/threads/${t.id}/messages`).set(as('am')).send({ body: 'First' }).expect(201);
    expect(await notices('producer', t.id)).toBe(before);
    // ...and their screen sees there is something new (it reloads within seconds).
    const k2 = (await http().post(`/ops/threads/${t.id}/pulse`).set(as('producer')).send({ active: true }).expect(200)).body.last;
    expect(k2).not.toBe(k1);
    // They switch tab, app or window: notified again.
    await http().post(`/ops/threads/${t.id}/pulse`).set(as('producer')).send({ active: false }).expect(200);
    await http().post(`/ops/threads/${t.id}/messages`).set(as('am')).send({ body: 'Second' }).expect(201);
    expect(await notices('producer', t.id)).toBe(before + 1);
    // An old heartbeat (they closed the browser) stops counting after 20 seconds.
    await http().post(`/ops/threads/${t.id}/pulse`).set(as('producer')).send({ active: true }).expect(200);
    await prisma.threadRead.update({ where: { threadId_userId: { threadId: t.id, userId: ids.producer } }, data: { viewingAt: new Date(Date.now() - 60_000) } });
    await http().post(`/ops/threads/${t.id}/messages`).set(as('am')).send({ body: 'Third' }).expect(201);
    expect(await notices('producer', t.id)).toBe(before + 2);
    // Only people who can see the discussion can say they are reading it.
    await http().post(`/ops/threads/${t.id}/pulse`).set(as('designer')).send({ active: true }).expect(404);
  });
});

describe('a team member talks to a client they work on', () => {
  it('only clients they work on; the client sees it in Messages and replies; their Client Manager can read it, others cannot', async () => {
    await http().post('/ops/threads').set(as('designer')).send({ kind: 'client_staff', clientOrgId: ids.other, title: 'Chat with them' }).expect(403);
    const opts = (await http().get('/ops/threads/options').set(as('designer')).expect(200)).body as { clients: { id: string }[] };
    expect(opts.clients.some((c) => c.id === ids.sunrise)).toBe(true);
    expect(opts.clients.some((c) => c.id === ids.other)).toBe(false);

    const t = (await http().post('/ops/threads').set(as('designer')).send({ kind: 'client_staff', clientOrgId: ids.sunrise, title: 'Chat with Sunrise' }).expect(201)).body;
    made.push(t.id);
    // Starting it again opens the same chat.
    expect((await http().post('/ops/threads').set(as('designer')).send({ kind: 'client_staff', clientOrgId: ids.sunrise, title: 'Chat with Sunrise' }).expect(201)).body.id).toBe(t.id);
    // Not shown to the client until the team member writes.
    expect(((await http().get('/client/chats').set(as('client')).expect(200)).body.staff as { id: string }[]).some((c) => c.id === t.id)).toBe(false);

    const clientBefore = await prisma.notification.count({ where: { userId: ids.client, link: `/client/messages?chat=${t.id}` } });
    await http().post(`/ops/threads/${t.id}/messages`).set(as('designer')).send({ body: `Hello, this is the designer ${stamp}` }).expect(201);
    expect(await prisma.notification.count({ where: { userId: ids.client, link: `/client/messages?chat=${t.id}` } })).toBe(clientBefore + 1);
    const chats = (await http().get('/client/chats').set(as('client')).expect(200)).body;
    const row = (chats.staff as { id: string; name: string; unread: number }[]).find((c) => c.id === t.id)!;
    expect(row).toMatchObject({ name: expect.any(String), unread: 1 });
    const view = (await http().get(`/client/chats/${t.id}`).set(as('client')).expect(200)).body;
    expect(view.messages.map((m: { body: string }) => m.body)).toEqual([`Hello, this is the designer ${stamp}`]);

    // The client replies; the designer (not looking at it) is told, and sees it marked as from the client.
    const designerBefore = await notices('designer', t.id);
    await http().post(`/client/chats/${t.id}/messages`).set(as('client')).send({ body: 'Thanks!' }).expect(201);
    expect(await notices('designer', t.id)).toBe(designerBefore + 1);
    const seen = (await http().get(`/ops/threads/${t.id}`).set(as('designer')).expect(200)).body;
    expect(seen.messages.at(-1)).toMatchObject({ body: 'Thanks!', fromClient: true });
    expect(seen.messages[0]).toMatchObject({ mine: true, seen: true });

    // Their Client Manager and the Founder can read it; another team member cannot; another client cannot.
    await http().get(`/ops/threads/${t.id}`).set(as('am')).expect(200);
    await http().get(`/ops/threads/${t.id}`).set(as('founder')).expect(200);
    await http().get(`/ops/threads/${t.id}`).set(as('producer')).expect(404);
    await http().post(`/ops/threads/${t.id}/messages`).set(as('producer')).send({ body: 'x' }).expect(404);
    // The client's own Client Manager chat is unchanged and separate.
    const cm = (await http().get('/client/thread').set(as('client')).expect(200)).body;
    expect(cm.messages.some((m: { body: string }) => m.body.includes(`${stamp}`))).toBe(false);

    // A file sent in the chat opens for the client.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const f = (await http().post(`/ops/threads/${t.id}/attachments`).set(as('designer')).attach('file', png, { filename: 'mock.png', contentType: 'image/png' }).expect(201)).body;
    await http().post(`/ops/threads/${t.id}/messages`).set(as('designer')).send({ body: 'The mock-up', attachmentIds: [f.id] }).expect(201);
    const withFile = (await http().get(`/client/chats/${t.id}`).set(as('client')).expect(200)).body;
    const url = withFile.messages.at(-1).attachments[0].url as string;
    expect(url).toBe(`/api/thread-files/${f.id}`);
    await http().get(url.replace(/^\/api/, '')).set(as('client')).expect((r) => expect([200, 302]).toContain(r.status));
    await http().get(url.replace(/^\/api/, '')).set(as('producer')).expect(404);
  });
});
