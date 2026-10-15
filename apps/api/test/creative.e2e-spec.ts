// v16 creative studio: the asset library (resumable uploads, versions, collections, rights, who sees what), proofing
// (a client pin at 0:12 of a video with a drawing, open comments carried to the next version, one-tap approval from
// the email link, the approval certificate), approved work landing in the library, the content calendar rules
// (approval before scheduling and publishing, BMU approval only where the client allows it, results), brand kits
// and the Creative reviewer agent in basic mode.
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { ApprovalCertificateView, AssetDetail, AssetList, DeliverableDetail, ProofLinkView, UploadSessionView } from '@bmu/shared';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { generateProductionTasks } from '../src/production/generate.js';

delete process.env.ANTHROPIC_API_KEY;

let app: INestApplication;
let prisma: PrismaService;
let orgId: string;
let clientId: string;
let otherClientId: string;
let ownerEmail: string;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const stamp = Date.now();
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a00000000049454e44ae426082', 'hex');
const mp4 = Buffer.concat([Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex'), Buffer.alloc(2000, 1)]);

async function signIn(email: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier: email }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier: email, code: otp.body.devCode }).expect(200)).body.token as string;
}

/** Uploads a buffer in pieces through the resumable upload API. */
async function upload(who: string, data: Buffer, name: string, mimeType: string, extra: Record<string, unknown> = {}) {
  const s = (await http().post('/assets/uploads').set(as(who)).send({ name, size: data.length, mimeType, ...extra }).expect(201)).body as UploadSessionView;
  const piece = Math.ceil(data.length / 3);
  let offset = 0;
  while (offset < data.length) {
    const r = await http()
      .put(`/assets/uploads/${s.id}?offset=${offset}`)
      .set(as(who))
      .set('Content-Type', 'application/octet-stream')
      .send(data.subarray(offset, offset + piece))
      .expect(200);
    offset = (r.body as UploadSessionView).received;
  }
  return (await http().post(`/assets/uploads/${s.id}/complete`).set(as(who)).expect(200)).body as AssetDetail;
}

async function deliverable(type: string, title: string) {
  const cycle = await prisma.cycle.findFirstOrThrow({ where: { engagement: { clientOrgId: clientId } } });
  const d = await prisma.deliverable.create({ data: { orgId, cycleId: cycle.id, type, title } });
  await generateProductionTasks(prisma, cycle.id);
  return d.id;
}

async function toClient(deliverableId: string, file: Buffer, name: string, mime: string) {
  const up = (await http().post(`/deliverables/${deliverableId}/versions`).set(as('am')).attach('file', file, { filename: name, contentType: mime }).expect(201)).body as DeliverableDetail;
  const v = up.versions.at(-1)!;
  await http().post(`/deliverables/versions/${v.id}/qc`).set(as('qc')).send({ items: [{ label: 'Brand', ok: true }] }).expect(200);
  return (await http().post(`/deliverables/versions/${v.id}/send`).set(as('am')).expect(200)).body as DeliverableDetail;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  prisma = app.get(PrismaService);
  const org = await prisma.organisation.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  orgId = org.id;
  const am = await prisma.user.findFirstOrThrow({ where: { email: 'am@bmu.demo' } });
  const ownerRole = await prisma.role.findFirstOrThrow({ where: { orgId, baseRole: 'client_owner', isCustom: false } });
  const service = await prisma.service.findFirstOrThrow({ where: { key: 'smm', priceBook: { orgId, status: 'active' } } });
  const client = await prisma.clientOrg.create({ data: { orgId, name: `Creative Test ${stamp}`, amUserId: am.id } });
  clientId = client.id;
  otherClientId = (await prisma.clientOrg.create({ data: { orgId, name: `Other Creative ${stamp}` } })).id;
  ownerEmail = `creative.${stamp}@example.com`;
  const owner = await prisma.user.create({ data: { orgId, type: 'client', name: 'Meera Owner', email: ownerEmail, phone: `9${String(stamp).slice(-9)}`, status: 'active', roles: { create: { roleId: ownerRole.id } } } });
  await prisma.clientUser.create({ data: { userId: owner.id, orgId, clientOrgId: client.id, clientRole: 'client_owner', brandScope: [] } });
  await prisma.engagement.create({
    data: { orgId, clientOrgId: client.id, serviceId: service.id, tier: 'growth', billingType: 'monthly', status: 'in_production', currentGate: 'G3', amId: am.id, cycles: { create: { orgId, period: '2026-10', rcdAt: new Date(), status: 'production' } } },
  });
  for (const who of ['am', 'producer', 'qc', 'founder', 'sales', 'admin']) tokens[who] = await signIn(`${who}@bmu.demo`);
  tokens.client = await signIn(ownerEmail);
});

afterAll(async () => {
  await app.close();
});

describe('asset library', () => {
  it('uploads a file in pieces, resumes after a wrong offset and creates the asset', async () => {
    const s = (await http().post('/assets/uploads').set(as('am')).send({ name: 'diwali-banner.png', size: png.length, mimeType: 'image/png', clientOrgId: clientId, tags: ['Diwali'] }).expect(201)).body as UploadSessionView;
    expect(s.received).toBe(0);
    const first = await http().put(`/assets/uploads/${s.id}?offset=0`).set(as('am')).set('Content-Type', 'application/octet-stream').send(png.subarray(0, 30)).expect(200);
    expect(first.body.received).toBe(30);
    // A piece sent for the wrong position is ignored; the answer says where to carry on.
    const wrong = await http().put(`/assets/uploads/${s.id}?offset=10`).set(as('am')).set('Content-Type', 'application/octet-stream').send(png.subarray(10, 20)).expect(200);
    expect(wrong.body.received).toBe(30);
    await http().post(`/assets/uploads/${s.id}/complete`).set(as('am')).expect(400);
    await http().put(`/assets/uploads/${s.id}?offset=30`).set(as('am')).set('Content-Type', 'application/octet-stream').send(png.subarray(30)).expect(200);
    // Someone else cannot touch my upload.
    await http().get(`/assets/uploads/${s.id}`).set(as('producer')).expect(404);
    const a = (await http().post(`/assets/uploads/${s.id}/complete`).set(as('am')).expect(200)).body as AssetDetail;
    expect(a.title).toBe('diwali-banner');
    expect(a.kind).toBe('image');
    expect(a.tags).toEqual(['diwali']);
    expect(a.client?.id).toBe(clientId);
    expect(a.versions).toBe(1);
    expect(a.current.url).toMatch(/^\/api\/files\//);
    ids.asset = a.id;
    await http().get(a.current.url.replace('/api', '')).set(as('am')).expect(200);
  });

  it('refuses files over 5 GB', async () => {
    await http().post('/assets/uploads').set(as('am')).send({ name: 'huge.mov', size: 6 * 1024 ** 3, mimeType: 'video/quicktime' }).expect(400);
  });

  it('adds a new version, makes an older one current and keeps the history', async () => {
    const v2 = await upload('am', png, 'diwali-banner-v2.png', 'image/png', { assetId: ids.asset, note: 'Brighter' });
    expect(v2.versions).toBe(2);
    expect(v2.current.number).toBe(2);
    expect(v2.history.map((h) => h.number)).toEqual([2, 1]);
    const back = (await http().post(`/assets/${ids.asset}/versions/${v2.history[1].id}/current`).set(as('am')).expect(200)).body as AssetDetail;
    expect(back.current.number).toBe(1);
  });

  it('collections, tags, usage rights and search', async () => {
    const col = (await http().post('/assets/collections').set(as('am')).send({ name: `Diwali ${stamp}`, clientOrgId: clientId }).expect(201)).body;
    await http().post('/assets/collections').set(as('am')).send({ name: 'x' }).expect(400);
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const a = (await http().patch(`/assets/${ids.asset}`).set(as('am')).send({ collectionId: col.id, tags: ['diwali', 'festive'], rightsNote: 'Licensed photo, 6 months', rightsExpireAt: soon }).expect(200)).body as AssetDetail;
    expect(a.collection?.name).toBe(`Diwali ${stamp}`);
    expect(a.rights.state).toBe('expiring');
    const byTag = (await http().get('/assets?tag=festive').set(as('am')).expect(200)).body as AssetList;
    expect(byTag.items.map((i) => i.id)).toContain(ids.asset);
    const byText = (await http().get('/assets?q=banner').set(as('am')).expect(200)).body as AssetList;
    expect(byText.items.map((i) => i.id)).toContain(ids.asset);
    const expiring = (await http().get('/assets?rights=expiring').set(as('am')).expect(200)).body as AssetList;
    expect(expiring.items.map((i) => i.id)).toContain(ids.asset);
    expect(expiring.rightsEnding).toBeGreaterThan(0);
    // A collection of another client cannot hold this client's asset.
    const other = (await http().post('/assets/collections').set(as('admin')).send({ name: `Other ${stamp}`, clientOrgId: otherClientId }).expect(201)).body;
    await http().patch(`/assets/${ids.asset}`).set(as('am')).send({ collectionId: other.id }).expect(400);
  });

  it('links can be assets too, and BMU-wide assets have no client', async () => {
    const link = (await http().post('/assets/link').set(as('am')).send({ url: 'https://www.figma.com/file/abc', title: 'Brand deck' }).expect(201)).body as AssetDetail;
    expect(link.kind).toBe('link');
    expect(link.client).toBeNull();
    ids.link = link.id;
  });

  it('people only see assets of clients they work on; clients only what is shared with them', async () => {
    await http().get(`/assets/${ids.asset}`).set(as('sales')).expect(404);
    await http().get(`/assets/${ids.link}`).set(as('sales')).expect(200);
    await http().post('/assets/uploads').set(as('sales')).send({ name: 'x.png', size: 10, clientOrgId: clientId }).expect(403);
    await http().get(`/client/assets/${ids.asset}`).set(as('client')).expect(404);
    const fileUrl = ((await http().get(`/assets/${ids.asset}`).set(as('am')).expect(200)).body as AssetDetail).current.url.replace('/api', '');
    await http().get(fileUrl).set(as('client')).expect(404);
    await http().patch(`/assets/${ids.asset}`).set(as('am')).send({ clientVisible: true }).expect(200);
    const mine = (await http().get('/client/assets').set(as('client')).expect(200)).body as AssetList;
    expect(mine.items.map((i) => i.id)).toEqual([ids.asset]);
    expect(mine.items[0].createdBy).toBe('BMU team');
    await http().get(fileUrl).set(as('client')).expect(200);
    await http().get('/assets').set(as('client')).expect(403);
  });

  it('archive hides it; only the uploader, CM, heads or leadership can archive', async () => {
    await http().post(`/assets/${ids.asset}/archive`).set(as('producer')).expect(404); // producer has no tasks on this client yet
    await http().post(`/assets/${ids.asset}/archive`).set(as('am')).expect(200);
    const list = (await http().get('/assets').set(as('am')).expect(200)).body as AssetList;
    expect(list.items.map((i) => i.id)).not.toContain(ids.asset);
    const archived = (await http().get('/assets?archived=1').set(as('am')).expect(200)).body as AssetList;
    expect(archived.items.map((i) => i.id)).toContain(ids.asset);
    await http().post(`/assets/${ids.asset}/restore`).set(as('am')).expect(200);
  });
});

describe('proofing a video', () => {
  it('a client pins a comment at 0:12 with a drawing; the team sees it on that frame', async () => {
    ids.reel = await deliverable('reel', `Diwali reel ${stamp}`);
    const d = await toClient(ids.reel, mp4, 'reel.mp4', 'video/mp4');
    expect(d.status).toBe('ready_for_client');
    ids.reelV1 = d.versions[0].id;
    const drawing = [
      [
        [40, 40],
        [50, 45],
        [60, 52],
      ],
    ];
    await http().post(`/client/reviews/${ids.reel}/comments`).set(as('client')).send({ versionId: ids.reelV1, body: 'Logo too small here', anchor: { t: 12, x: 50, y: 45, drawing } }).expect(201);
    await http().post(`/client/reviews/${ids.reel}/comments`).set(as('client')).send({ versionId: ids.reelV1, body: 'Music is great' }).expect(201);
    await http().post(`/client/reviews/${ids.reel}/comments`).set(as('client')).send({ versionId: ids.reelV1, body: 'bad', anchor: { x: 50 } }).expect(400);
    const team = (await http().get(`/deliverables/${ids.reel}`).set(as('am')).expect(200)).body as DeliverableDetail;
    const pin = team.comments.find((c) => c.body === 'Logo too small here')!;
    expect(pin.anchor).toEqual({ t: 12, x: 50, y: 45, drawing });
    expect(pin.author.isClient).toBe(true);
    expect(team.rounds?.[0]).toMatchObject({ number: 1, internal: { result: 'pass' }, comments: 2, openComments: 2 });
  });

  it('a new version carries the open comments over (resolved ones stay behind)', async () => {
    const team = (await http().get(`/deliverables/${ids.reel}`).set(as('am')).expect(200)).body as DeliverableDetail;
    const praise = team.comments.find((c) => c.body === 'Music is great')!;
    await http().post(`/client/reviews/${ids.reel}/request-changes`).set(as('client')).send({ comment: 'Please fix the logo' }).expect(200);
    await http().post(`/craft/comments/${praise.id}/resolve`).set(as('am')).expect(200);
    const v2 = (await http().post(`/deliverables/${ids.reel}/versions`).set(as('am')).attach('file', mp4, { filename: 'reel-v2.mp4', contentType: 'video/mp4' }).expect(201)).body as DeliverableDetail;
    const v2Id = v2.versions.at(-1)!.id;
    const carried = v2.comments.filter((c) => c.versionId === v2Id);
    expect(carried.map((c) => c.body).sort()).toEqual(['Logo too small here', 'Please fix the logo']);
    expect(carried.every((c) => c.carriedFrom === 1)).toBe(true);
    expect(carried.find((c) => c.body === 'Logo too small here')!.anchor).toMatchObject({ t: 12, x: 50, y: 45 });
    expect(v2.rounds?.[0].client?.decision).toBe('changes_requested');
    expect(v2.rounds?.[1].carriedOver).toBe(2);
    ids.reelV2 = v2Id;
  });

  it('sending v2 emails each approver a one-tap link; approving from it is recorded with a certificate', async () => {
    const since = new Date();
    await http().post(`/deliverables/versions/${ids.reelV2}/qc`).set(as('qc')).send({ items: [{ label: 'Brand', ok: true }] }).expect(200);
    await http().post(`/deliverables/versions/${ids.reelV2}/send`).set(as('am')).expect(200);
    const mail = await prisma.emailOutbox.findFirstOrThrow({ where: { toEmail: ownerEmail, createdAt: { gte: since } }, orderBy: { createdAt: 'desc' } });
    const token = /\/proof\/([\w-]+)/.exec(mail.text)?.[1];
    expect(token).toBeTruthy();
    const wa = await prisma.whatsAppMessage.findFirst({ where: { entityId: ids.reel, source: 'proofing', createdAt: { gte: since } } });
    expect(wa?.body).toMatch(/\/proof\//);

    const view = (await http().get(`/public/proof/${token}`).expect(200)).body as ProofLinkView;
    expect(view).toMatchObject({ title: `Diwali reel ${stamp}`, status: 'waiting', forName: 'Meera Owner', version: { number: 2, kind: 'video' } });
    expect(view.openComments).toBe(2);
    await http().get(view.version.url.replace('/api', '')).expect(200);
    await http().get('/public/proof/not-a-real-token').expect(404);
    await http().post(`/public/proof/${token}/decide`).send({ decision: 'changes' }).expect(400);

    const done = (await http().post(`/public/proof/${token}/decide`).send({ decision: 'approve' }).expect(200)).body as ProofLinkView;
    expect(done.status).toBe('approved');
    const d = (await http().get(`/deliverables/${ids.reel}`).set(as('am')).expect(200)).body as DeliverableDetail;
    expect(d.status).toBe('approved');
    expect(d.rounds?.[1].client).toMatchObject({ decision: 'approved', by: 'Meera Owner', via: 'email' });
    expect(d.certificate?.code).toMatch(/^BMU-\d{8}-[0-9A-F]{8}$/);
    // The link cannot be used twice.
    await http().post(`/public/proof/${token}/decide`).send({ decision: 'approve' }).expect(400);
  });

  it('the certificate names the exact file, the approver and how they approved, and checks its seal', async () => {
    const c = (await http().get(`/deliverables/${ids.reel}/certificate`).set(as('am')).expect(200)).body as ApprovalCertificateView;
    expect(c.valid).toBe(true);
    expect(c.version.number).toBe(2);
    expect(c.version.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(c.approvals).toHaveLength(1);
    expect(c.approvals[0]).toMatchObject({ name: 'Meera Owner', email: ownerEmail, via: 'email' });
    expect(c.internal?.by).toBeTruthy();
    expect(c.rounds).toBe(2);
    expect(c.hash).toMatch(/^[0-9a-f]{64}$/);
    const mine = (await http().get(`/client/reviews/${ids.reel}/certificate`).set(as('client')).expect(200)).body as ApprovalCertificateView;
    expect(mine.code).toBe(c.code);
    await http().get(`/deliverables/${ids.reel}/certificate`).set(as('sales')).expect(404);
    // Tampering with the stored record shows.
    const row = await prisma.approvalCertificate.findUniqueOrThrow({ where: { code: c.code } });
    await prisma.approvalCertificate.update({ where: { id: row.id }, data: { data: { ...(row.data as object), rounds: 1 } } });
    expect(((await http().get(`/deliverables/${ids.reel}/certificate`).set(as('am')).expect(200)).body as ApprovalCertificateView).valid).toBe(false);
    await prisma.approvalCertificate.update({ where: { id: row.id }, data: { data: row.data as object } });
  });

  it('the approved file lands in the client library, shared with the client', async () => {
    const a = await prisma.asset.findUniqueOrThrow({ where: { deliverableId: ids.reel } });
    expect(a).toMatchObject({ source: 'deliverable', clientVisible: true, kind: 'video', clientOrgId: clientId });
    const mine = (await http().get('/client/assets').set(as('client')).expect(200)).body as AssetList;
    expect(mine.items.map((i) => i.id)).toContain(a.id);
  });
});

describe('content calendar rules', () => {
  it('approved posts can be scheduled and published; unapproved ones cannot', async () => {
    const at = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const scheduled = await http().patch(`/deliver/deliverables/${ids.reel}/schedule`).set(as('am')).send({ scheduledAt: at, channel: 'instagram' }).expect(200);
    expect(scheduled.body).toMatchObject({ status: 'scheduled', approved: true });
    ids.post = await deliverable('post', 'Offer post');
    await toClient(ids.post, png, 'offer.png', 'image/png');
    await http().patch(`/deliver/deliverables/${ids.post}/schedule`).set(as('am')).send({ scheduledAt: at, channel: 'instagram' }).expect(400);
    // Even if someone forces the status, publishing still needs an approval on record.
    await prisma.deliverable.update({ where: { id: ids.post }, data: { status: 'scheduled', scheduledAt: new Date(at) } });
    await http().post(`/deliver/deliverables/${ids.post}/publish`).set(as('am')).send({ liveUrl: 'https://instagram.com/p/x' }).expect(400);
    await prisma.deliverable.update({ where: { id: ids.post }, data: { status: 'ready_for_client', scheduledAt: null } });
  });

  it('BMU can approve posts only for clients who allow it', async () => {
    await http().post(`/creative/posts/${ids.post}/approve`).set(as('am')).expect(403);
    await http().put(`/creative/clients/${clientId}/publish-rule`).set(as('producer')).send({ publishNeedsApproval: false }).expect(403);
    await http().put(`/creative/clients/${clientId}/publish-rule`).set(as('am')).send({ publishNeedsApproval: false }).expect(200);
    const item = (await http().post(`/creative/posts/${ids.post}/approve`).set(as('am')).expect(200)).body;
    expect(item.status).toBe('approved');
    const cert = (await http().get(`/deliverables/${ids.post}/certificate`).set(as('am')).expect(200)).body as ApprovalCertificateView;
    expect(cert.approvals[0].via).toBe('bmu');
    await http().put(`/creative/clients/${clientId}/publish-rule`).set(as('am')).send({ publishNeedsApproval: true }).expect(200);
  });

  it('captions, channels, due-to-post reminders and results', async () => {
    const cap = (await http().put(`/creative/posts/${ids.reel}/caption`).set(as('am')).send({ caption: 'Light up this Diwali ✨ #festive' }).expect(200)).body;
    expect(cap.caption).toContain('Diwali');
    const s = (await http().post('/creative/channels').set(as('am')).send({ clientOrgId: clientId, platform: 'instagram', handle: '@creativetest' }).expect(201)).body;
    expect(s.channels.some((c: { handle: string }) => c.handle === '@creativetest')).toBe(true);
    await http().post('/creative/channels').set(as('am')).send({ clientOrgId: clientId, platform: 'instagram', handle: '@creativetest' }).expect(400);
    await http().post('/creative/channels').set(as('sales')).send({ clientOrgId: clientId, platform: 'facebook', handle: 'x' }).expect(403);

    await prisma.deliverable.update({ where: { id: ids.reel }, data: { scheduledAt: new Date(Date.now() - 60_000) } });
    const cal = (await http().get('/deliver/calendar').set(as('am')).expect(200)).body;
    expect(cal.dueToPublish.map((i: { deliverableId: string }) => i.deliverableId)).toContain(ids.reel);
    const timers = (await http().post('/creative/timers/run').set(as('founder')).expect(200)).body;
    expect(timers.due).toBeGreaterThanOrEqual(1);
    const am = await prisma.user.findFirstOrThrow({ where: { email: 'am@bmu.demo' } });
    expect(await prisma.notification.count({ where: { userId: am.id, kind: 'post_due', title: { contains: `Diwali reel ${stamp}` } } })).toBe(1);
    await http().post('/creative/timers/run').set(as('founder')).expect(200);
    expect(await prisma.notification.count({ where: { userId: am.id, kind: 'post_due', title: { contains: `Diwali reel ${stamp}` } } })).toBe(1);

    await http().put(`/creative/posts/${ids.reel}/results`).set(as('am')).send({ reach: 100 }).expect(400);
    await http().post(`/deliver/deliverables/${ids.reel}/publish`).set(as('am')).send({ liveUrl: 'https://instagram.com/p/reel1' }).expect(200);
    const res = (await http().put(`/creative/posts/${ids.reel}/results`).set(as('am')).send({ reach: 5400, impressions: 8000, engagement: 640, clicks: 85, spendRupees: 1500 }).expect(200)).body;
    expect(res.metrics).toMatchObject({ reach: 5400, engagement: 640, spendPaise: 150000 });
    const sum = (await http().get('/creative/results').set(as('am')).expect(200)).body;
    expect(sum.top.some((t: { deliverableId: string }) => t.deliverableId === ids.reel)).toBe(true);
    const client = (await http().get('/client/post-results').set(as('client')).expect(200)).body;
    expect(client).toMatchObject({ posts: 1, withResults: 1, totals: { reach: 5400 } });
  });
});

describe('brand kits and the Creative reviewer', () => {
  it('the brand kit keeps tone, do and don’t lists and competitors; the client can see it', async () => {
    const kit = (await http().put(`/craft/brand/${clientId}`).set(as('am')).send({ colours: ['#8BB72C'], fonts: ['Inter'], tone: 'Warm and festive', dos: ['Show the product'], donts: ['No red backgrounds'], competitors: ['Rival Sweets'] }).expect(200)).body;
    expect(kit).toMatchObject({ tone: 'Warm and festive', dos: ['Show the product'], donts: ['No red backgrounds'], competitors: ['Rival Sweets'] });
    const list = (await http().get('/creative/brand-kits').set(as('am')).expect(200)).body as { clientId: string; complete: number }[];
    expect(list.find((k) => k.clientId === clientId)?.complete).toBeGreaterThanOrEqual(80);
    const mine = (await http().get('/client/brand-kit').set(as('client')).expect(200)).body;
    expect(mine.donts).toEqual(['No red backgrounds']);
  });

  it('checks a new draft against the brand kit, flags a picture uploaded for a reel and tells the maker', async () => {
    ids.reel2 = await deliverable('reel', `Offer reel ${stamp}`);
    const up = (await http().post(`/deliverables/${ids.reel2}/versions`).set(as('am')).attach('file', png, { filename: 'frame.png', contentType: 'image/png' }).expect(201)).body as DeliverableDetail;
    const v = up.versions.at(-1)!;
    const runs = (await http().post('/agents/creative_reviewer/run').set(as('founder')).send({ subjectId: v.id }).expect(200)).body;
    expect(runs[0]).toMatchObject({ status: 'done', mode: 'basic', subject: { type: 'Version', link: `/team/deliverables/${ids.reel2}` } });
    const d = (await http().get(`/deliverables/${ids.reel2}`).set(as('am')).expect(200)).body as DeliverableDetail;
    const note = d.comments.find((c) => c.body.startsWith('Creative reviewer:'))!;
    expect(note.internal).toBe(true);
    expect(note.body).toContain('not a video');
    expect(note.body).toContain('No red backgrounds');
    const maker = await prisma.user.findFirstOrThrow({ where: { email: 'am@bmu.demo' } });
    expect(await prisma.notification.count({ where: { userId: maker.id, kind: 'agent', title: { contains: `Offer reel ${stamp}` } } })).toBe(1);
    // The client never sees agent notes.
    const client = await prisma.comment.findFirstOrThrow({ where: { id: note.id } });
    expect(client.isInternal).toBe(true);
    // Undo from the run log removes the note.
    await http().post(`/agents/runs/${runs[0].id}/undo`).set(as("founder")).expect(200);
    expect(await prisma.comment.count({ where: { id: note.id } })).toBe(0);
  });
});

