// Build phase: flow templates → tasks → versions → QC → client Review Studio (Gate 4).
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { generateProductionTasks } from '../src/production/generate.js';

let app: INestApplication;
const tokens: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
let engagementId: string;
let logoId: string;
let guideId: string;
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a00000000049454e44ae426082', 'hex');

async function signIn(email: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier: email }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier: email, code: otp.body.devCode }).expect(200)).body.token as string;
}

const tasksOf = async (who: string, deliverableId: string) =>
  ((await http().get('/tasks?view=team').set(as(who)).expect(200)).body as { id: string; deliverable: { id: string } | null; kind: string; status: string; flowStep: string; ready: boolean }[]).filter(
    (t) => t.deliverable?.id === deliverableId,
  );

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();

  const prisma = app.get(PrismaService);
  const stamp = Date.now();
  const org = await prisma.organisation.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  const am = await prisma.user.findFirstOrThrow({ where: { email: 'am@bmu.demo' } });
  const ownerRole = await prisma.role.findFirstOrThrow({ where: { orgId: org.id, baseRole: 'client_owner', isCustom: false } });
  const service = await prisma.service.findFirstOrThrow({ where: { key: 'smm', priceBook: { orgId: org.id, status: 'active' } } });
  const client = await prisma.clientOrg.create({ data: { orgId: org.id, name: `Production Test ${stamp}`, amUserId: am.id } });
  const owner = await prisma.user.create({
    data: { orgId: org.id, type: 'client', name: 'Owner', email: `prod.${stamp}@example.com`, status: 'active', roles: { create: { roleId: ownerRole.id } } },
  });
  await prisma.clientUser.create({ data: { userId: owner.id, orgId: org.id, clientOrgId: client.id, clientRole: 'client_owner', brandScope: [] } });
  const engagement = await prisma.engagement.create({
    data: {
      orgId: org.id,
      clientOrgId: client.id,
      serviceId: service.id,
      tier: 'growth',
      billingType: 'monthly',
      status: 'in_production',
      currentGate: 'G3',
      amId: am.id,
      cycles: { create: { orgId: org.id, period: '2026-10', rcdAt: new Date(), status: 'production' } },
    },
    include: { cycles: true },
  });
  engagementId = engagement.id;
  const cycleId = engagement.cycles[0].id;
  logoId = (await prisma.deliverable.create({ data: { orgId: org.id, cycleId, type: 'post', title: 'Launch post' } })).id;
  guideId = (await prisma.deliverable.create({ data: { orgId: org.id, cycleId, type: 'blog', title: 'Launch blog' } })).id;
  const result = await generateProductionTasks(prisma, cycleId, new Date(), { autoAssign: true });
  expect(result.g3Passed).toBe(true);

  for (const who of ['am', 'strategist', 'producer', 'sales', 'qc', 'admin']) tokens[who] = await signIn(`${who}@bmu.demo`);
  tokens.client = await signIn(owner.email!);
});

afterAll(async () => {
  await app.close();
});

describe('tasks from flow templates', () => {
  it('creates a chained, assigned task list per deliverable and passes Gate 3', async () => {
    const tasks = await tasksOf('am', logoId);
    expect(tasks.map((t) => t.flowStep)).toEqual(['brief', 'design', 'qc', 'client']);
    expect(tasks[0].ready).toBe(true);
    expect(tasks[1].ready).toBe(false);
    const e = (await http().get(`/engagements/${engagementId}`).set(as('am')).expect(200)).body;
    expect(e.currentGate).toBe('G4');
  });

  it('people only see their own tasks unless they manage the work', async () => {
    const sales = (await http().get('/tasks?view=team').set(as('sales')).expect(200)).body;
    expect(sales).toHaveLength(0);
    const mine = (await http().get('/tasks').set(as('producer')).expect(200)).body as { deliverable: { id: string } | null }[];
    expect(mine.some((t) => t.deliverable?.id === logoId)).toBe(true);
  });

  it('a step cannot start before the one it depends on, and blocking needs a reason', async () => {
    const [brief, design] = await tasksOf('am', logoId);
    await http().patch(`/tasks/${design.id}`).set(as('producer')).send({ status: 'in_progress' }).expect(400);
    await http().patch(`/tasks/${brief.id}`).set(as('producer')).send({ status: 'done' }).expect(404); // not the producer's task
    await http().patch(`/tasks/${brief.id}`).set(as('strategist')).send({ status: 'done', logMinutes: 45 }).expect(200);
    await http().patch(`/tasks/${design.id}`).set(as('producer')).send({ status: 'blocked' }).expect(400);
    const started = await http().patch(`/tasks/${design.id}`).set(as('producer')).send({ status: 'in_progress' }).expect(200);
    expect(started.body.status).toBe('in_progress');
  });
});

describe('QC before the client sees anything', () => {
  let v1: { id: string; url: string };

  it('the client sees the deliverable as in production but cannot open it', async () => {
    const list = (await http().get('/client/reviews').set(as('client')).expect(200)).body;
    expect(list.find((d: { id: string }) => d.id === logoId).statusLabel).toBe('In production');
    await http().get(`/client/reviews/${logoId}`).set(as('client')).expect(404);
  });

  it('the maker uploads version 1; it goes to QC', async () => {
    const res = await http().post(`/deliverables/${logoId}/versions`).set(as('producer')).field('note', 'First pass').attach('file', png, { filename: 'post.png', contentType: 'image/png' }).expect(201);
    expect(res.body.status).toBe('in_qc');
    v1 = res.body.versions[0];
    expect(v1.url).toMatch(/^\/api\/files\//);
    const queue = (await http().get('/qc/queue').set(as('qc')).expect(200)).body;
    expect(queue.some((q: { deliverableId: string }) => q.deliverableId === logoId)).toBe(true);
    await http().get('/qc/queue').set(as('producer')).expect(403);
  });

  it("'Send to client' is impossible without a QC pass", async () => {
    await http().post(`/deliverables/versions/${v1.id}/send`).set(as('am')).expect(400);
  });

  it('a QC fail needs notes and returns the work to the maker', async () => {
    const items = [{ label: 'Brand colours', ok: false }, { label: 'Spelling', ok: true }];
    await http().post(`/deliverables/versions/${v1.id}/qc`).set(as('producer')).send({ items, note: 'x' }).expect(403);
    await http().post(`/deliverables/versions/${v1.id}/qc`).set(as('qc')).send({ items }).expect(400);
    const res = await http().post(`/deliverables/versions/${v1.id}/qc`).set(as('qc')).send({ items, note: 'Use the brand green' }).expect(200);
    expect(res.body.status).toBe('qc_failed');
    expect(res.body.tasks.find((t: { flowStep: string }) => t.flowStep === 'design').status).toBe('in_progress');
    expect(res.body.comments.some((c: { internal: boolean; body: string }) => c.internal && c.body.includes('brand green'))).toBe(true);
  });

  it('files of versions never sent are hidden from the client', async () => {
    const fileId = v1.url.split('/').pop();
    await http().get(`/files/${fileId}`).set(as('am')).expect(200);
    await http().get(`/files/${fileId}`).set(as('client')).expect(404);
  });
});

describe('Review Studio and Gate 4', () => {
  let v2: { id: string; url: string };

  it('version 2 passes QC and the CM sends it', async () => {
    let res = await http().post(`/deliverables/${logoId}/versions`).set(as('producer')).attach('file', png, { filename: 'post-v2.png', contentType: 'image/png' }).expect(201);
    v2 = res.body.versions[1];
    res = await http().post(`/deliverables/versions/${v2.id}/qc`).set(as('qc')).send({ items: [{ label: 'Brand colours', ok: true }] }).expect(200);
    expect(res.body.status).toBe('qc_passed');
    await http().post(`/deliverables/versions/${v2.id}/send`).set(as('producer')).expect(403);
    res = await http().post(`/deliverables/versions/${v2.id}/send`).set(as('am')).expect(200);
    expect(res.body.status).toBe('ready_for_client');
  });

  it('the client sees only sent versions, with no QC results or internal notes', async () => {
    await http().post(`/deliverables/${logoId}/comments`).set(as('am')).send({ versionId: v2.id, body: 'Internal: client is picky about green', internal: true }).expect(201);
    const res = await http().get(`/client/reviews/${logoId}`).set(as('client')).expect(200);
    expect(res.body.versions).toHaveLength(1);
    expect(res.body.versions[0].qc).toEqual([]);
    expect(res.body.comments.every((c: { internal: boolean }) => !c.internal)).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('picky');
    expect(res.body).not.toHaveProperty('tasks');
    await http().get(`/files/${v2.url.split('/').pop()}`).set(as('client')).expect(200);
  });

  it('pinned feedback and a change request use a revision round', async () => {
    await http().post(`/client/reviews/${logoId}/comments`).set(as('client')).send({ versionId: v2.id, body: 'Make the logo bigger', anchor: { x: 40, y: 22 } }).expect(201);
    const res = await http().post(`/client/reviews/${logoId}/request-changes`).set(as('client')).send({}).expect(200);
    expect(res.body.status).toBe('changes_requested');
    expect(res.body.revisionRounds.used).toBe(1);
    expect(res.body.comments[0].anchor).toEqual({ x: 40, y: 22 });
    const tasks = await tasksOf('am', logoId);
    expect(tasks.find((t) => t.flowStep === 'design')!.status).toBe('in_progress');
  });

  it('approving the latest version is stored immutably and locks the deliverable', async () => {
    let res = await http().post(`/deliverables/${logoId}/versions/link`).set(as('producer')).send({ url: 'https://example.com/post-v3.png' }).expect(201);
    const v3 = res.body.versions[2];
    await http().post(`/deliverables/versions/${v3.id}/qc`).set(as('qc')).send({ items: [{ label: 'All good', ok: true }] }).expect(200);
    await http().post(`/deliverables/versions/${v3.id}/send`).set(as('am')).expect(200);
    await http().post(`/client/reviews/${logoId}/approve`).set(as('client')).send({ versionId: v2.id }).expect(400);
    res = await http().post(`/client/reviews/${logoId}/approve`).set(as('client')).send({ versionId: v3.id }).expect(200);
    expect(res.body.status).toBe('approved');
    expect(res.body.versions.at(-1).approved.by).toBe('Owner');
    await http().post(`/deliverables/${logoId}/versions/link`).set(as('producer')).send({ url: 'https://example.com/v4.png' }).expect(400);
    const approvals = await app.get(PrismaService).approval.findMany({ where: { targetType: 'deliverable', targetId: logoId } });
    expect(approvals).toHaveLength(1);
    expect(approvals[0].versionId).toBe(v3.id);
    const e = (await http().get(`/engagements/${engagementId}`).set(as('am')).expect(200)).body;
    expect(e.currentGate).toBe('G4'); // the blog is still in production
  });

  it('when every deliverable is approved, Gate 4 passes', async () => {
    const tasks = await tasksOf('am', guideId);
    for (const t of tasks.filter((x) => x.kind === 'work')) await http().patch(`/tasks/${t.id}`).set(as('admin')).send({ status: 'done' }).expect(200);
    let res = await http().post(`/deliverables/${guideId}/versions/link`).set(as('producer')).send({ url: 'https://docs.example.com/blog' }).expect(201);
    const v = res.body.versions[0];
    await http().post(`/deliverables/versions/${v.id}/qc`).set(as('qc')).send({ items: [{ label: 'Plagiarism check', ok: true }] }).expect(200);
    await http().post(`/deliverables/versions/${v.id}/send`).set(as('am')).expect(200);
    res = await http().post(`/client/reviews/${guideId}/approve`).set(as('client')).send({ versionId: v.id }).expect(200);
    const e = (await http().get(`/engagements/${engagementId}`).set(as('am')).expect(200)).body;
    expect(e.currentGate).toBe('G5');
    expect(e.status).toBe('active_retainer');
  });
});

describe('templates', () => {
  it('only Founder/Admin/department heads edit flows; edits make a new version and keep a QC step', async () => {
    const flows = (await http().get('/templates/flows').set(as('producer')).expect(200)).body;
    const design = flows.find((f: { key: string }) => f.key === 'design');
    const input = { name: design.name, department: design.department, deliverableTypes: design.deliverableTypes, steps: design.steps };
    await http().put('/templates/flows/design').set(as('producer')).send(input).expect(403);
    await http().put('/templates/flows/design').set(as('admin')).send({ ...input, steps: input.steps.filter((s: { kind: string }) => s.kind !== 'qc') }).expect(400);
    const saved = (await http().put('/templates/flows/design').set(as('admin')).send(input).expect(200)).body;
    expect(saved.find((f: { key: string }) => f.key === 'design').version).toBe(design.version + 1);
  });
});

describe('My Day', () => {
  it('checks in and out once a day and pre-fills the end-of-day report', async () => {
    const day = (await http().get('/my-day').set(as('producer')).expect(200)).body;
    if (!day.checkIn) await http().post('/my-day/check-in').set(as('producer')).expect(200);
    await http().post('/my-day/check-in').set(as('producer')).expect(400);
    const eod = (await http().put('/my-day/eod').set(as('producer')).send({ completed: ['Launch post v3'], pending: [], blocked: [], waiting: [] }).expect(200)).body;
    expect(eod.eod.submitted).toBe(true);
    await http().get('/my-day').set(as('client')).expect(403);
  });
});
