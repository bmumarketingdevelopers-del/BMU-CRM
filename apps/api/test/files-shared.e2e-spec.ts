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
  for (const [k, email] of Object.entries({ founder: 'founder@bmu.demo', am: 'am@bmu.demo', pm: 'pm@bmu.demo', finance: 'finance@bmu.demo', design: 'design@bmu.demo', head: 'design.head@bmu.demo' })) {
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
  // v36: departments. The designer works on this client (a task); Design files, another department's file, a Client file.
  const headed = await prisma.department.findFirst({ where: { headUserId: ids.head, deletedAt: null } });
  ids.designDept = headed?.id ?? (await prisma.user.findUniqueOrThrow({ where: { id: ids.head } })).departmentId!;
  await prisma.user.update({ where: { id: ids.design }, data: { departmentId: ids.designDept } });
  const branchId = (await prisma.department.findUniqueOrThrow({ where: { id: ids.designDept } })).branchId;
  ids.otherDept = (await prisma.department.create({ data: { orgId: org.id, branchId, name: tag('Other dept') } })).id;
  const eng = await prisma.engagement.findFirstOrThrow({ where: { clientOrgId: client.id, deletedAt: null } });
  ids.task = (await prisma.task.create({ data: { orgId: org.id, title: tag('Design work'), ownerId: ids.design, engagementId: eng.id, departmentId: ids.designDept, status: 'todo' } })).id;
  const deptFile = (name: string, departmentId: string | null, clientOrgId: string | null = client.id) =>
    prisma.file.create({ data: { orgId: org.id, clientOrgId, departmentId, path: `test/${name}`, kind: 'image', name: tag(name), uploadedById: ids.am, folder: 'working' } });
  ids.designFile = (await deptFile('design-board.png', ids.designDept)).id;
  ids.otherFile = (await deptFile('other-dept.png', ids.otherDept)).id;
  ids.clientFile = (await deptFile('client-logo.png', null)).id;
  // Another client's Design file: the head sees it, the designer (not on that client) does not.
  const elsewhere = await prisma.clientOrg.findFirstOrThrow({ where: { id: { not: client.id }, orgId: org.id, deletedAt: null } });
  ids.elsewhereFile = (await deptFile('elsewhere-design.png', ids.designDept, elsewhere.id)).id;
  // v37: another department's file on a client the Design department does not work on.
  const designEngs = (await prisma.task.findMany({ where: { departmentId: ids.designDept, engagementId: { not: null } }, select: { engagementId: true } })).map((t) => t.engagementId!);
  const notDesign = await prisma.clientOrg.findFirstOrThrow({
    where: { orgId: org.id, deletedAt: null, engagements: { none: { OR: [{ id: { in: designEngs } }, { cycles: { some: { deliverables: { some: { departmentId: ids.designDept } } } } }] } } },
  });
  ids.notDesignFile = (await deptFile('not-design-client.png', ids.otherDept, notDesign.id)).id;
  // Fix 2: a file in a team-only project thread is not a client file.
  const projectThread = await prisma.thread.create({ data: { orgId: org.id, clientOrgId: client.id, type: 'project', title: tag('Project chat') } });
  ids.projectThread = projectThread.id;
  ids.teamChatFile = (await file(tag('team-chat.png'))).id;
  await prisma.message.create({ data: { orgId: org.id, threadId: projectThread.id, authorId: ids.am, body: tag('team file'), attachments: [ids.teamChatFile] } });
  ids.signature = (await prisma.file.create({ data: { orgId: org.id, path: 'test/sig', kind: 'image', name: tag('sig.png'), tags: ['cm-signature'], uploadedById: ids.am } })).id;
});

afterAll(async () => {
  await prisma.message.deleteMany({ where: { body: { contains: `${stamp}` } } });
  await prisma.thread.deleteMany({ where: { id: ids.projectThread } });
  await prisma.task.deleteMany({ where: { id: ids.task } });
  await prisma.file.deleteMany({ where: { name: { contains: `${stamp}` } } });
  await prisma.department.update({ where: { id: ids.otherDept }, data: { deletedAt: new Date() } });
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

describe('files by department (v36)', () => {
  const sees = async (who: string, id: string) => (await list(who)).some((r) => r.id === id);

  it('team members see their department and Client files of clients they work on; not other departments', async () => {
    expect(await sees('design', ids.designFile)).toBe(true);
    expect(await sees('design', ids.clientFile)).toBe(true);
    expect(await sees('design', ids.otherFile)).toBe(false);
    expect(await sees('design', ids.elsewhereFile)).toBe(false);
  });

  it("Department Heads see their department's files across clients; Client Managers all of their clients'; leadership everything", async () => {
    expect(await sees('head', ids.designFile)).toBe(true);
    expect(await sees('head', ids.elsewhereFile)).toBe(true);
    // v37: every department's files on clients the head's department works on; not on other clients.
    expect(await sees('head', ids.otherFile)).toBe(true);
    expect(await sees('head', ids.notDesignFile)).toBe(false);
    for (const id of [ids.designFile, ids.otherFile, ids.clientFile]) expect(await sees('am', id)).toBe(true);
    for (const id of [ids.designFile, ids.otherFile, ids.elsewhereFile]) expect(await sees('founder', id)).toBe(true);
    const row = (await list('am')).find((r) => r.id === ids.designFile) as Row & { department?: { id: string } };
    expect(row.department?.id).toBe(ids.designDept);
  });

  it('direct links follow the same rules', async () => {
    const refused = (r: request.Response) => r.status === 404 && /File not found/.test(JSON.stringify(r.body));
    expect(refused(await http().get(`/files/${ids.otherFile}`).set(as('design')))).toBe(true);
    expect(refused(await http().get(`/files/${ids.designFile}`).set(as('design')))).toBe(false);
    expect(refused(await http().get(`/files/${ids.otherFile}`).set(as('founder')))).toBe(false);
  });

  it('files in team-only threads are not client files', async () => {
    expect((await list('founder')).some((r) => r.id === ids.teamChatFile)).toBe(false);
  });
});

