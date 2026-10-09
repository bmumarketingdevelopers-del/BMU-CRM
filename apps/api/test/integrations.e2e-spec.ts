// v19 integrations, publishing and public API:
// - a scheduled post publishes to a (test) connected account and its results appear the next day;
// - an API key limited to reading leads cannot create one (and keys, scopes, rate limits, OpenAPI);
// - webhook deliveries are signed and retried;
// plus the integrations hub, ad/GA4 results for client dashboards and the Tally / Zoho exports.
import 'dotenv/config';
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { AdResultsView, ApiKeyCreated, IntegrationAccountView, IntegrationsHubView, PublicationView, PublicLead, PublicPage, SyncJobView, WebhookCreated, WebhookDeliveryView } from '@bmu/shared';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { PublisherService } from '../src/integrations/publisher.service.js';
import { MetricsSyncService } from '../src/integrations/metrics-sync.service.js';
import { WebhooksService } from '../src/integrations/webhooks.service.js';
import { openApiDocument } from '../src/integrations/openapi.js';

delete process.env.META_APP_ID;
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.LINKEDIN_CLIENT_ID;

let app: INestApplication;
let prisma: PrismaService;
let orgId: string;
let clientId: string;
let engId: string;
const tokens: Record<string, string> = {};
const users: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });
const stamp = Date.now();
const DAY = 86_400_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function signIn(email: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier: email }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier: email, code: otp.body.devCode }).expect(200)).body.token as string;
}

/** An approved Instagram post scheduled for `at`. */
async function approvedPost(title: string, at: Date, caption = 'Launch day! #bmu') {
  const cycle = await prisma.cycle.upsert({ where: { engagementId_period: { engagementId: engId, period: '2026-10' } }, create: { orgId, engagementId: engId, period: '2026-10' }, update: {} });
  const d = await prisma.deliverable.create({ data: { orgId, cycleId: cycle.id, type: 'social_post', title, status: 'scheduled', scheduledAt: at, channel: 'instagram', caption } });
  const file = await prisma.file.create({ data: { orgId, clientOrgId: clientId, path: '2026-10/none.png', kind: 'upload', name: 'post.png', mimeType: 'image/png' } });
  const v = await prisma.version.create({ data: { orgId, deliverableId: d.id, fileId: file.id, number: 1, uploadedById: users.am } });
  await prisma.deliverable.update({ where: { id: d.id }, data: { approvedVersionId: v.id } });
  return d.id;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ rawBody: true });
  app.use(cookieParser());
  await app.init();
  prisma = app.get(PrismaService);
  orgId = (await prisma.organisation.findFirstOrThrow({ orderBy: { createdAt: 'asc' } })).id;
  for (const [k, email] of Object.entries({ founder: 'founder@bmu.demo', admin: 'admin@bmu.demo', finance: 'finance@bmu.demo', am: 'am@bmu.demo', producer: 'producer@bmu.demo', sales: 'sales@bmu.demo' })) {
    tokens[k] = await signIn(email);
    users[k] = (await prisma.user.findFirstOrThrow({ where: { email } })).id;
  }
  const service = await prisma.service.findFirstOrThrow({ where: { orgId } });
  clientId = (await prisma.clientOrg.create({ data: { orgId, name: `Integrations Test ${stamp}`, amUserId: users.am, gstin: '27ABCDE1234F1Z5' } })).id;
  engId = (await prisma.engagement.create({ data: { orgId, clientOrgId: clientId, serviceId: service.id, tier: 'growth', billingType: 'monthly', status: 'in_production', amId: users.am } })).id;
});

afterAll(async () => {
  await prisma.webhookDelivery.deleteMany({ where: { orgId } });
  await prisma.webhookSubscription.deleteMany({ where: { orgId } });
  await app.close();
});

describe('Integrations hub', () => {
  it('lists connectors with what is missing, and refuses Connect without keys', async () => {
    const hub = (await http().get('/integrations').set(as('founder')).expect(200)).body as IntegrationsHubView;
    const ig = hub.connectors.find((c) => c.provider === 'instagram')!;
    expect(ig.configured).toBe(false);
    expect(ig.missingEnv).toEqual(['META_APP_ID', 'META_APP_SECRET']);
    expect(hub.testAccountsAllowed).toBe(true);
    const r = await http().post('/integrations/oauth/start').set(as('founder')).send({ provider: 'instagram', clientOrgId: clientId }).expect(400);
    expect(r.body.message).toMatch(/META_APP_ID/);
    await http().get('/integrations').set(as('producer')).expect(403);
  });

  it('with keys, Connect returns the provider sign-in link; a bad state comes back as an error', async () => {
    process.env.META_APP_ID = 'app123';
    process.env.META_APP_SECRET = 'secret';
    try {
      const r = (await http().post('/integrations/oauth/start').set(as('founder')).send({ provider: 'facebook', clientOrgId: clientId }).expect(201)).body as { url: string };
      expect(r.url).toMatch(/^https:\/\/www\.facebook\.com\/v21\.0\/dialog\/oauth\?/);
      expect(new URL(r.url).searchParams.get('redirect_uri')).toMatch(/\/integrations\/oauth\/callback$/);
      const back = await http().get('/integrations/oauth/callback?code=x&state=forged.bad').expect(302);
      expect(back.headers.location).toMatch(/\/admin\/integrations\?error=/);
    } finally {
      delete process.env.META_APP_ID;
      delete process.env.META_APP_SECRET;
    }
  });

  it('an Account Manager connects a test account only for their own client', async () => {
    const other = await prisma.clientOrg.findFirstOrThrow({ where: { orgId, amUserId: { not: users.am }, deletedAt: null } });
    await http().post('/integrations/test-accounts').set(as('am')).send({ provider: 'instagram', clientOrgId: other.id }).expect(403);
    const a = (await http().post('/integrations/test-accounts').set(as('am')).send({ provider: 'instagram', clientOrgId: clientId }).expect(201)).body as IntegrationAccountView;
    expect(a).toMatchObject({ mode: 'test', provider: 'instagram', status: 'connected', client: { id: clientId } });
  });
});

describe('Publishing', () => {
  it('a scheduled post publishes to the test account and its results appear the next day', async () => {
    const id = await approvedPost(`Launch post ${stamp}`, new Date(Date.now() - 60_000));
    const publisher = app.get(PublisherService, { strict: false });
    const sent = await publisher.tick();
    expect(sent).toBeGreaterThanOrEqual(1);
    const d = await prisma.deliverable.findUniqueOrThrow({ where: { id } });
    expect(d.status).toBe('published');
    expect(d.liveUrl).toMatch(/\/test-account\/test-instagram-/);
    const pub = (await http().get(`/integrations/publications/by-post/${id}`).set(as('am')).expect(200)).body as PublicationView;
    expect(pub).toMatchObject({ status: 'published', attempts: 1, provider: 'instagram' });
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: id, action: 'deliverable.published' } });
    expect((audit.after as { auto?: boolean }).auto).toBe(true);
    // Running again never sends it twice.
    await publisher.tick();
    const accountId = (await prisma.postPublication.findUniqueOrThrow({ where: { deliverableId: id } })).accountId;
    expect(await prisma.syncJob.count({ where: { kind: 'publish', accountId } })).toBe(1);

    // Same day: platforms have nothing yet.
    const sync = app.get(MetricsSyncService, { strict: false });
    await sync.runAll(new Date());
    expect(await prisma.postMetric.count({ where: { deliverableId: id } })).toBe(0);
    // Next day: the results land as provider metrics and show in Results.
    const tomorrow = new Date(Date.now() + DAY + 3600_000);
    await prisma.postPublication.update({ where: { deliverableId: id }, data: { publishedAt: new Date(Date.now() - DAY - 3600_000) } });
    await sync.runAll(tomorrow);
    const m = await prisma.postMetric.findMany({ where: { deliverableId: id } });
    expect(m).toHaveLength(1);
    expect(m[0].source).toBe('instagram');
    expect(m[0].reach).toBeGreaterThan(100);
    // Re-running the same day updates the row instead of adding one.
    await sync.runAll(tomorrow);
    expect(await prisma.postMetric.count({ where: { deliverableId: id } })).toBe(1);
  });

  it('failures retry, then stop and tell the AM; Retry publishes once fixed', async () => {
    const id = await approvedPost(`Broken post ${stamp}`, new Date(Date.now() - 60_000), 'This one fails [fail]');
    const publisher = app.get(PublisherService, { strict: false });
    const t0 = new Date();
    await publisher.tick(t0);
    let p = await prisma.postPublication.findUniqueOrThrow({ where: { deliverableId: id } });
    expect(p).toMatchObject({ status: 'queued', attempts: 1 });
    expect(p.nextAttemptAt!.getTime() - t0.getTime()).toBeGreaterThanOrEqual(5 * 60_000 - 1000);
    await publisher.tick(new Date(t0.getTime() + 6 * 60_000));
    await publisher.tick(new Date(t0.getTime() + 30 * 60_000));
    p = await prisma.postPublication.findUniqueOrThrow({ where: { deliverableId: id } });
    expect(p).toMatchObject({ status: 'failed', attempts: 3 });
    expect(p.error).toMatch(/\[fail\]/);
    const note = await prisma.notification.findFirst({ where: { userId: users.am, kind: 'integration', title: { contains: 'Broken post' } } });
    expect(note).not.toBeNull();
    expect((await prisma.deliverable.findUniqueOrThrow({ where: { id } })).status).toBe('scheduled');
    await prisma.deliverable.update({ where: { id }, data: { caption: 'Fixed caption' } });
    await http().post(`/integrations/publications/${p.id}/retry`).set(as('producer')).expect(403);
    const r = (await http().post(`/integrations/publications/${p.id}/retry`).set(as('am')).expect(201)).body as PublicationView;
    expect(r.status).toBe('published');
  });

  it('Publish now needs a connected account for the channel', async () => {
    const id = await approvedPost(`LinkedIn post ${stamp}`, new Date(Date.now() + DAY));
    await prisma.deliverable.update({ where: { id }, data: { channel: 'linkedin' } });
    const r = await http().post(`/integrations/publish/${id}`).set(as('am')).expect(400);
    expect(r.body.message).toMatch(/No linkedin account is connected/);
  });
});

describe('Ads and website results', () => {
  it('Meta Ads and GA4 test accounts fill the client dashboard numbers', async () => {
    const ads = (await http().post('/integrations/test-accounts').set(as('founder')).send({ provider: 'meta_ads', clientOrgId: clientId }).expect(201)).body as IntegrationAccountView;
    await http().post('/integrations/test-accounts').set(as('founder')).send({ provider: 'ga4', clientOrgId: clientId }).expect(201);
    const jobs = (await http().post(`/integrations/accounts/${ads.id}/sync`).set(as('founder')).expect(201)).body as SyncJobView[];
    expect(jobs[0]).toMatchObject({ kind: 'ad_metrics', status: 'ok', items: 60 });
    const sync = app.get(MetricsSyncService, { strict: false });
    await sync.runAll();
    const view = (await http().get(`/integrations/results?clientOrgId=${clientId}`).set(as('am')).expect(200)).body as AdResultsView;
    expect(view.hasData).toBe(true);
    expect(view.daily).toHaveLength(30);
    const rows = await prisma.adMetricDaily.findMany({ where: { clientOrgId: clientId } });
    expect(view.totals.spendPaise).toBe(rows.reduce((s, r) => s + r.spendPaise, 0));
    expect(view.totals.sessions).toBeGreaterThan(0);
    expect(view.campaigns.map((c) => c.campaign).sort()).toEqual(['Brand awareness', 'Lead generation']);
    expect(view.totals.cpcPaise).toBe(Math.round(view.totals.spendPaise / view.totals.clicks));
    // Re-sync refreshes the last 3 days without duplicating.
    await http().post(`/integrations/accounts/${ads.id}/sync`).set(as('founder')).expect(201);
    expect(await prisma.adMetricDaily.count({ where: { accountId: ads.id } })).toBe(60);
    // The client sees their own numbers; other team members only for clients they work on.
    const owner = await prisma.user.create({ data: { orgId, type: 'client', name: `Owner ${stamp}`, email: `owner.${stamp}@int.demo`, status: 'active', clientUser: { create: { orgId, clientOrgId: clientId, clientRole: 'client_owner', brandScope: [] } } } });
    tokens.client = await signIn(owner.email!);
    const mine = (await http().get('/client/ad-results').set(as('client')).expect(200)).body as AdResultsView;
    expect(mine.totals.spendPaise).toBe(view.totals.spendPaise);
    await http().get(`/integrations/results?clientOrgId=${clientId}`).set(as('sales')).expect(403);
  });
});

describe('Public API v1', () => {
  let readKey = '';
  let writeKey = '';

  it('only Founder and Admin make keys; the key is shown once and stored hashed', async () => {
    await http().post('/developer/keys').set(as('am')).send({ name: 'Nope', scopes: ['leads:read'] }).expect(403);
    const r = (await http().post('/developer/keys').set(as('founder')).send({ name: 'Read leads only', scopes: ['leads:read'] }).expect(201)).body as ApiKeyCreated;
    readKey = r.key;
    expect(readKey).toMatch(/^bmu_/);
    expect(r.row.prefix).toBe(`${readKey.slice(0, 12)}…`);
    const row = await prisma.apiKey.findUniqueOrThrow({ where: { id: r.row.id } });
    expect(row.hash).not.toContain(readKey);
    writeKey = ((await http().post('/developer/keys').set(as('founder')).send({ name: 'Website form', scopes: ['leads:read', 'leads:write'], rateLimitPerMin: 10 }).expect(201)).body as ApiKeyCreated).key;
  });

  it('an API key limited to read leads cannot create one', async () => {
    const list = (await http().get('/v1/leads?limit=2').set(bearer(readKey)).expect(200)).body as PublicPage<PublicLead>;
    expect(list.data.length).toBeLessThanOrEqual(2);
    expect(Object.keys(list.data[0]).sort()).toEqual(['company', 'createdAt', 'email', 'id', 'name', 'owner', 'phone', 'source', 'stage', 'updatedAt']);
    if (list.nextCursor) {
      const next = (await http().get(`/v1/leads?limit=2&cursor=${list.nextCursor}`).set(bearer(readKey)).expect(200)).body as PublicPage<PublicLead>;
      expect(next.data[0].id).not.toBe(list.data[0].id);
    }
    const before = await prisma.lead.count({ where: { orgId } });
    const r = await http().post('/v1/leads').set(bearer(readKey)).send({ name: 'Api Person', phone: '9876501234', company: 'Api Co', serviceIds: ['smm'] }).expect(403);
    expect(r.body.message).toMatch(/leads:write/);
    expect(await prisma.lead.count({ where: { orgId } })).toBe(before);
    await http().get('/v1/clients').set(bearer(readKey)).expect(403);
  });

  it('a key with leads:write creates a lead through the normal lead rules', async () => {
    const services = (await http().get('/v1/services').set(bearer(writeKey)).expect(200)).body as { id: string }[];
    const r = (await http().post('/v1/leads').set(bearer(writeKey)).send({ name: 'Api Person', phone: `98${String(stamp).slice(-8)}`, company: `Api Co ${stamp}`, source: 'website', serviceIds: [services[0].id] }).expect(201)).body as PublicLead;
    expect(r).toMatchObject({ name: 'Api Person', stage: 'new', source: 'website' });
    const bad = await http().post('/v1/leads').set(bearer(writeKey)).send({ name: 'X', phone: '1', company: 'Y', serviceIds: [] }).expect(400);
    expect(bad.body.message).toBeTruthy();
    expect(await prisma.auditEvent.count({ where: { entityId: r.id, action: 'lead.created' } })).toBe(1);
  });

  it('keys only work on /v1, /v1 needs a key, revoked keys stop, and limits apply', async () => {
    await http().get('/integrations').set(bearer(readKey)).expect(403);
    await http().get('/v1/leads').set(as('founder')).expect(401);
    await http().get('/v1/leads').set(bearer('bmu_nonsense')).expect(401);
    const me = (await http().get('/v1/me').set(bearer(writeKey)).expect(200));
    expect(me.body.key.rateLimitPerMin).toBe(10);
    expect(me.headers['x-ratelimit-limit']).toBe('10');
    let limited = false;
    for (let i = 0; i < 12 && !limited; i++) limited = (await http().get('/v1/me').set(bearer(writeKey))).status === 429;
    expect(limited).toBe(true);
    const keys = (await http().get('/developer/keys').set(as('founder')).expect(200)).body as { id: string; name: string }[];
    await http().post(`/developer/keys/${keys.find((k) => k.name === 'Read leads only')!.id}/revoke`).set(as('founder')).expect(201);
    await http().get('/v1/leads').set(bearer(readKey)).expect(401);
  });

  it('a Finance key reads invoices; the OpenAPI document lists every route', async () => {
    const key = ((await http().post('/developer/keys').set(as('admin')).send({ name: 'Accounts', scopes: ['invoices:read', 'clients:read', 'projects:read', 'tasks:read', 'content:read'] }).expect(201)).body as ApiKeyCreated).key;
    // Acts as the Admin, who can read finance.
    const inv = await http().get('/v1/invoices?limit=1').set(bearer(key)).expect(200);
    expect(Array.isArray(inv.body.data)).toBe(true);
    await http().get('/v1/clients?limit=1').set(bearer(key)).expect(200);
    await http().get('/v1/projects?limit=1').set(bearer(key)).expect(200);
    await http().get('/v1/tasks?limit=1').set(bearer(key)).expect(200);
    await http().get('/v1/posts?limit=1').set(bearer(key)).expect(200);
    const doc = (await http().get('/v1/openapi.json').expect(200)).body as ReturnType<typeof openApiDocument>;
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toContain('/v1/leads');
    expect((doc.paths['/v1/leads'] as { post: { description: string } }).post.description).toMatch(/leads:write/);
  });
});

describe('Outgoing webhooks', () => {
  let server: Server;
  let url = '';
  const received: { headers: IncomingMessage['headers']; body: string }[] = [];
  let failNext = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        if (failNext > 0) {
          failNext--;
          res.writeHead(500).end('busy');
        } else res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('deliveries are signed and retried', async () => {
    await http().post('/developer/webhooks').set(as('am')).send({ url, events: ['lead.created'] }).expect(403);
    const created = (await http().post('/developer/webhooks').set(as('founder')).send({ url, events: ['lead.*'], description: 'CRM sync' }).expect(201)).body as WebhookCreated;
    expect(created.secret).toMatch(/^whsec_/);
    failNext = 1;
    // A lead created in the app → domain event → one delivery.
    await http().post('/leads/enquiry').send({ name: 'Hook Person', email: `hook.${stamp}@int.demo`, phone: `97${String(stamp).slice(-8)}`, company: `Hook Co ${stamp}`, need: 'Website and social media for our new store', serviceIds: ['smm'] }).expect(201);
    let delivery = null;
    for (let i = 0; i < 40 && !delivery; i++) {
      await sleep(50);
      delivery = await prisma.webhookDelivery.findFirst({ where: { subscriptionId: created.row.id, type: 'lead.created' } });
    }
    expect(delivery).not.toBeNull();
    const hooks = app.get(WebhooksService, { strict: false });
    const t0 = new Date();
    await hooks.dispatchDue(t0);
    let d = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery!.id } });
    expect(d).toMatchObject({ status: 'pending', attempts: 1, lastStatus: 500 });
    expect(d.nextAttemptAt.getTime() - t0.getTime()).toBeGreaterThanOrEqual(59_000);
    // Not due yet: nothing is sent.
    await hooks.dispatchDue(new Date(t0.getTime() + 10_000));
    expect(received).toHaveLength(1);
    await hooks.dispatchDue(new Date(t0.getTime() + 61_000));
    d = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery!.id } });
    expect(d).toMatchObject({ status: 'delivered', attempts: 2, lastStatus: 200 });
    expect(received).toHaveLength(2);
    // Signature: sha256=HMAC(secret, `${timestamp}.${body}`), same event id on the retry.
    for (const r of received) {
      const expected = `sha256=${createHmac('sha256', created.secret).update(`${r.headers['x-bmu-timestamp']}.${r.body}`).digest('hex')}`;
      expect(r.headers['x-bmu-signature']).toBe(expected);
      expect(r.headers['x-bmu-event']).toBe('lead.created');
    }
    const payload = JSON.parse(received[1].body) as { id: string; type: string; data: { company: string } };
    expect(payload.id).toBe(JSON.parse(received[0].body).id);
    expect(payload.data.company).toBe(`Hook Co ${stamp}`);
    // The failure told Founder/Admin once; the success cleared it.
    expect((await prisma.webhookSubscription.findUniqueOrThrow({ where: { id: created.row.id } })).failingSince).toBeNull();
  });

  it('after 7 failed tries a delivery is dead; test and redeliver work; rotate changes the secret', async () => {
    const [sub] = await prisma.webhookSubscription.findMany({ where: { orgId, url } });
    const hooks = app.get(WebhooksService, { strict: false });
    failNext = 100;
    const ping = (await http().post(`/developer/webhooks/${sub.id}/test`).set(as('founder')).expect(201)).body as WebhookDeliveryView;
    expect(ping).toMatchObject({ status: 'pending', attempts: 1, lastStatus: 500 });
    let at = Date.now();
    for (let i = 0; i < 8; i++) {
      at += 13 * 3600_000;
      await hooks.dispatchDue(new Date(at));
    }
    const dead = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: ping.id } });
    expect(dead).toMatchObject({ status: 'dead', attempts: 7 });
    failNext = 0;
    const again = (await http().post(`/developer/deliveries/${ping.id}/redeliver`).set(as('founder')).expect(201)).body as WebhookDeliveryView;
    expect(again.status).toBe('delivered');
    const rotated = (await http().post(`/developer/webhooks/${sub.id}/rotate`).set(as('founder')).expect(201)).body as WebhookCreated;
    expect(rotated.secret).not.toBe('');
    await http().post(`/developer/webhooks/${sub.id}/test`).set(as('founder')).expect(201);
    const last = received.at(-1)!;
    expect(last.headers['x-bmu-signature']).toBe(`sha256=${createHmac('sha256', rotated.secret).update(`${last.headers['x-bmu-timestamp']}.${last.body}`).digest('hex')}`);
    const list = (await http().get(`/developer/webhooks/${sub.id}/deliveries`).set(as('founder')).expect(200)).body as WebhookDeliveryView[];
    expect(list.some((x) => x.status === 'dead')).toBe(true);
    await http().post('/developer/webhooks').set(as('founder')).send({ url: 'ftp://example.com', events: ['*'] }).expect(400);
    await http().post('/developer/webhooks').set(as('founder')).send({ url, events: ['Lead Created'] }).expect(400);
  });
});

describe('Accounting exports', () => {
  it('Tally XML splits IGST for another state; Zoho CSVs have one row per line and per payment', async () => {
    const day = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const inv = await prisma.invoice.create({ data: { orgId, clientOrgId: clientId, number: `INT/${stamp}`, lines: [{ label: 'Social media retainer', amountPaise: 100_000_00, kind: 'service' }], subtotalPaise: 100_000_00, gstPaise: 18_000_00, totalPaise: 118_000_00, dueDate: new Date(Date.now() + 7 * DAY), status: 'issued' } });
    await prisma.payment.create({ data: { orgId, invoiceId: inv.id, amountPaise: 50_000_00, method: 'bank', ref: `UTR${stamp}` } });
    const tally = await http().get(`/finance/export.csv?from=${day}&to=${day}&format=tally_xml`).set(as('finance')).expect(200);
    expect(tally.headers['content-type']).toMatch(/xml/);
    const x = tally.text;
    expect(x).toContain(`<VOUCHERNUMBER>INT/${stamp}</VOUCHERNUMBER>`);
    // Client GSTIN starts 27 (Maharashtra), BMU is 29 (Karnataka): IGST.
    expect(x).toMatch(new RegExp(`INT/${stamp}</VOUCHERNUMBER>.*?<LEDGERNAME>Output IGST</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>18000.00</AMOUNT>`, 's'));
    expect(x).toContain('<PARENT>Sundry Debtors</PARENT>');
    expect(x).toContain(`<VOUCHERNUMBER>UTR${stamp}</VOUCHERNUMBER>`);
    const zi = await http().get(`/finance/export.csv?from=${day}&to=${day}&format=zoho_invoices`).set(as('finance')).expect(200);
    const line = zi.text.split('\r\n').find((l) => l.includes(`INT/${stamp}`))!;
    expect(line).toContain('business_gst');
    expect(line).toContain(',MH,');
    expect(line).toContain('IGST18');
    const zp = await http().get(`/finance/export.csv?from=${day}&to=${day}&format=zoho_payments`).set(as('finance')).expect(200);
    expect(zp.text).toContain(`UTR${stamp}`);
    await http().get(`/finance/export.csv?from=${day}&to=${day}&format=excel`).set(as('finance')).expect(400);
  });
});
