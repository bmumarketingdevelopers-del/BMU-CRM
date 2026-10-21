// v39: before a ONE-TIME project's final payment, clients get the work view only: pictures, PDFs and videos open in
// the app (inline, never cached), other types wait, and nothing downloads. Retainer clients and released files are open.
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { absPath } from '../src/storage/file-store.js';

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

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  prisma = app.get(PrismaService);
  const org = await prisma.organisation.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  tokens.client = await signIn('client@sunrise.demo');
  tokens.am = await signIn('am@bmu.demo');
  const clientUser = await prisma.user.findFirstOrThrow({ where: { email: 'client@sunrise.demo' }, include: { clientUser: true } });
  const clientOrgId = clientUser.clientUser!.clientOrgId;
  const am = await prisma.user.findFirstOrThrow({ where: { email: 'am@bmu.demo' } });
  const svc = await prisma.service.findFirstOrThrow({ where: { orgId: org.id, key: 'website' } });
  // A real PNG on disk (tests use local storage).
  const store = (rel: string, bytes: Buffer | string) => {
    mkdirSync(dirname(absPath(rel)), { recursive: true });
    writeFileSync(absPath(rel), bytes);
  };
  const work = async (billingType: 'one_time' | 'monthly', name: string, mimeType: string, kind: string, bytes: Buffer | string) => {
    const eng = await prisma.engagement.create({ data: { orgId: org.id, clientOrgId, serviceId: svc.id, tier: 'growth', billingType, status: 'in_review', currentGate: 'G4', amId: am.id } });
    const cycle = await prisma.cycle.create({ data: { orgId: org.id, engagementId: eng.id, period: billingType === 'one_time' ? 'project' : '2026-10' } });
    const rel = `test-preview/${stamp}-${name}`;
    store(rel, bytes);
    const file = await prisma.file.create({ data: { orgId: org.id, clientOrgId, path: rel, kind, name, mimeType, sizeBytes: bytes.length } });
    const d = await prisma.deliverable.create({ data: { orgId: org.id, cycleId: cycle.id, type: 'post', title: `Preview ${name} ${stamp}`, status: 'ready_for_client' } });
    await prisma.version.create({ data: { orgId: org.id, deliverableId: d.id, fileId: file.id, number: 1, uploadedById: am.id, sentToClientAt: new Date(), sentById: am.id } });
    return { eng: eng.id, file: file.id, deliverable: d.id };
  };
  const img = await work('one_time', 'poster.png', 'image/png', 'image', png);
  Object.assign(ids, { projEng: img.eng, imgFile: img.file, imgDel: img.deliverable });
  ids.videoFile = (await work('one_time', 'reel.mp4', 'video/mp4', 'video', Buffer.from('not really a video'))).file;
  ids.zipFile = (await work('one_time', 'source.zip', 'application/zip', 'other', Buffer.from('PK'))).file;
  const retainer = await work('monthly', 'monthly-post.png', 'image/png', 'image', png);
  ids.retainerFile = retainer.file;
});

afterAll(async () => {
  const ds = await prisma.deliverable.findMany({ where: { title: { contains: `${stamp}` } }, select: { id: true, cycleId: true, cycle: { select: { engagementId: true } } } });
  await prisma.version.deleteMany({ where: { deliverableId: { in: ds.map((d) => d.id) } } });
  await prisma.deliverable.deleteMany({ where: { id: { in: ds.map((d) => d.id) } } });
  await prisma.file.deleteMany({ where: { path: { contains: `test-preview/${stamp}` } } });
  await prisma.cycle.deleteMany({ where: { id: { in: ds.map((d) => d.cycleId) } } });
  await prisma.engagement.deleteMany({ where: { id: { in: [...new Set(ds.map((d) => d.cycle.engagementId))] } } });
  await app.close();
});

describe('client previews before the final payment', () => {
  it('a one-time project image is view only: shown inline, never cached, and cannot be downloaded', async () => {
    const r = await http().get(`/files/${ids.imgFile}`).set(as('client')).buffer(true).expect(200);
    expect(r.headers['x-bmu-preview']).toBe('view');
    expect(r.headers['content-type']).toMatch(/image\/png/);
    expect(r.headers['content-disposition']).toMatch(/^inline/);
    expect(r.headers['cache-control']).toBe('no-store');
    // The clean file, no watermark.
    expect((r.body as Buffer).equals(png)).toBe(true);
    await http().get(`/files/${ids.imgFile}?download=1`).set(as('client')).expect(403);
  });

  it('videos stream for the in-app player only; other types wait for payment', async () => {
    const v = await http().get(`/files/${ids.videoFile}`).set(as('client'));
    expect(v.headers['x-bmu-preview']).toBe('view');
    await http().get(`/files/${ids.zipFile}`).set(as('client')).expect(403);
  });

  it('the team, retainer clients and released files get the original', async () => {
    const team = await http().get(`/files/${ids.imgFile}`).set(as('am')).expect(200);
    expect(team.headers['x-bmu-preview']).toBeUndefined();
    const retainer = await http().get(`/files/${ids.retainerFile}`).set(as('client')).expect(200);
    expect(retainer.headers['x-bmu-preview']).toBeUndefined();
    expect(retainer.headers['content-type']).toMatch(/image\/png/);
  });

  it('client views say it is view only; delivery (balance paid) unlocks the original', async () => {
    const rev = (await http().get(`/client/reviews/${ids.imgDel}`).set(as('client')).expect(200)).body;
    expect(rev.preview).toBe(true);
    const files = (await http().get('/client/files').set(as('client')).expect(200)).body as { id: string; preview?: boolean }[];
    expect(files.find((f) => f.id === ids.imgFile)?.preview).toBe(true);
    await prisma.engagement.update({ where: { id: ids.projEng }, data: { status: 'delivered', currentGate: 'G5' } });
    await prisma.file.update({ where: { id: ids.imgFile }, data: { released: true } });
    const r = await http().get(`/files/${ids.imgFile}`).set(as('client')).expect(200);
    expect(r.headers['x-bmu-preview']).toBeUndefined();
    await http().get(`/files/${ids.imgFile}?download=1`).set(as('client')).expect(200);
  });
});
