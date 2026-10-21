// v35: every client file in Files (including files shared in client chats), labelled sent to / from the client,
// visible by role; the Founder sees them all and gets a daily summary. Signatures and seals stay out of Files.
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
const tag = (s: string) => `${s}-${stamp}`;
type Row = { id: string; direction: string; source: string; url: string; sharedBy: string | null; can: { edit: boolean } };

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
  for (const [k, email] of Object.entries({ founder: 'founder@bmu.demo', am: 'am@bmu.demo', pm: 'pm@bmu.demo', finance: 'finance@bmu.demo' })) {
    tokens[k] = await signIn(email);
    ids[k] = (await prisma.user.findFirstOrThrow({ where: { email } })).id;
  }
  // A client of am@ with a conversation: the client sends a file, the CM sends one back, and one internal note file.
  const clientUser = await prisma.clientUser.findFirstOrThrow({ where: { clientOrg: { amUserId: ids.am, deletedAt: null } }, include: { clientOrg: true } });
  const client = clientUser.clientOrg;
  ids.client = client.id;
  const thread = (await prisma.thread.findFirst({ where: { clientOrgId: client.id } })) ?? (await prisma.thread.create({ data: { orgId: org.id, clientOrgId: client.id } }));
  const file = (name: string, extra: Record<string, unknown> = {}) =>
    prisma.file.create({ data: { orgId: org.id, clientOrgId: client.id, path: `test/${name}`, kind: 'message_attachment', name, mimeType: 'image/png', sizeBytes: 2048, released: true, ...extra } });
  ids.fromClient = (await file(tag('menu-photo.png'))).id;
  ids.toClient = (await file(tag('draft-poster.png'))).id;
  ids.internalNote = (await file(tag('internal-note.png'))).id;
  ids.unsent = (await file(tag('never-sent.png'))).id;
  await prisma.message.create({ data: { orgId: org.id, threadId: thread.id, authorId: clientUser.userId, body: tag('Here is our menu'), attachments: [ids.fromClient] } });
  await prisma.message.create({ data: { orgId: org.id, threadId: thread.id, authorId: ids.am, body: tag('Draft for you'), attachments: [ids.toClient] } });
  await prisma.message.create({ data: { orgId: org.id, threadId: thread.id, authorId: ids.am, body: tag('Team note'), attachments: [ids.internalNote], isInternal: true } });
  // A payment proof and a signature image (settings, never listed).
  ids.proof = (await prisma.file.create({ data: { orgId: org.id, clientOrgId: client.id, path: 'test/proof', kind: 'image', name: tag('utr.png'), tags: ['payment-proof'], uploadedById: ids.am } })).id;
  ids.signature = (await prisma.file.create({ data: { orgId: org.id, path: 'test/sig', kind: 'image', name: tag('sig.png'), tags: ['cm-signature'], uploadedById: ids.am } })).id;
});

afterAll(async () => {
  await prisma.message.deleteMany({ where: { body: { contains: `${stamp}` } } });
  await prisma.file.deleteMany({ where: { name: { contains: `${stamp}` } } });
  await app.close();
});

const list = async (who: string, q = '') => ((await http().get(`/ops/files${q}`).set(as(who)).expect(200)).body.rows as Row[]);

describe('every client file in Files', () => {
  it('lists files shared in client chats, labelled by direction; unsent chat files and signatures stay out', async () => {
    const rows = await list('am', `?clientOrgId=${ids.client}`);
    const row = (id: string) => rows.find((r) => r.id === id);
    expect(row(ids.fromClient)).toMatchObject({ direction: 'from_client', source: 'chat', url: `/api/thread-files/${ids.fromClient}` });
    expect(row(ids.toClient)).toMatchObject({ direction: 'to_client', source: 'chat' });
    expect(row(ids.internalNote)).toMatchObject({ direction: 'internal', source: 'chat' });
    expect(row(ids.toClient)!.can.edit).toBe(false);
    expect(row(ids.unsent)).toBeUndefined();
    expect(row(ids.signature)).toBeUndefined();
    // Filter by direction on the server.
    const fromClients = await list('am', `?clientOrgId=${ids.client}&direction=from_client`);
    expect(fromClients.every((r) => r.direction === 'from_client')).toBe(true);
    expect(fromClients.some((r) => r.id === ids.fromClient)).toBe(true);
  });

  it('shows files only to people who work on the client; payment proofs only to money roles', async () => {
    expect((await list('pm')).some((r) => r.id === ids.toClient)).toBe(false);
    expect((await list('am')).some((r) => r.id === ids.proof)).toBe(false);
    expect((await list('finance')).some((r) => r.id === ids.proof)).toBe(true);
    expect((await list('founder')).some((r) => r.id === ids.proof)).toBe(true);
  });
});

describe("the Founder's client files", () => {
  it('shows every file sent to and received from clients, by anyone, and only to the Founder', async () => {
    const feed = (await http().get('/ops/files/client-feed?days=1').set(as('founder')).expect(200)).body as { sent: number; received: number; rows: Row[] };
    expect(feed.rows.find((r) => r.id === ids.fromClient)).toMatchObject({ direction: 'from_client' });
    expect(feed.rows.find((r) => r.id === ids.toClient)).toMatchObject({ direction: 'to_client', sharedBy: expect.any(String) });
    expect(feed.rows.some((r) => r.id === ids.internalNote)).toBe(false);
    expect(feed.sent).toBeGreaterThan(0);
    expect(feed.received).toBeGreaterThan(0);
    // The Founder can open a chat file.
    // (The test file has no bytes on disk, so a permitted request may still end in a storage error; a refusal is a 404 "File not found".)
    const open = await http().get(`/thread-files/${ids.toClient}`).set(as('founder'));
    expect(open.status === 404 && /File not found/.test(JSON.stringify(open.body))).toBe(false);
    const denied = await http().get(`/thread-files/${ids.toClient}`).set(as('pm'));
    expect(denied.status).toBe(404);
    await http().get('/ops/files/client-feed').set(as('am')).expect(403);
    await http().get('/ops/files/client-feed').set(as('finance')).expect(403);
  });
});
