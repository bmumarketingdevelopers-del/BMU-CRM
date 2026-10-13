// v13 foundation: event bus, live stream (server-sent events), presence, feature flags, smart search and System health.
// Streams are read over a real HTTP connection; every flag, failure row and record this spec creates is removed after.
import 'dotenv/config';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { LiveMessage } from '@bmu/shared';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { eventBus, type BusEvent } from '../src/platform/event-bus.js';
import { SearchIndexService } from '../src/platform/search-index.service.js';

let app: INestApplication;
let prisma: PrismaService;
let port: number;
let orgId: string;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
const api = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const stamp = Date.now();
const createdLeads: string[] = [];
const createdRequests: string[] = [];
const streams: Stream[] = [];

async function signIn(identifier: string) {
  const otp = await api().post('/auth/otp/request').send({ identifier }).expect(200);
  return (await api().post('/auth/otp/verify').send({ identifier, code: otp.body.devCode }).expect(200)).body.token as string;
}

type Stream = { messages: LiveMessage[]; connId: string; close: () => void; waitFor: (fn: (m: LiveMessage) => boolean, ms?: number) => Promise<LiveMessage> };

/** Opens GET /realtime/stream as `who` and collects messages. */
function openStream(who: string): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const messages: LiveMessage[] = [];
    const waiters: { fn: (m: LiveMessage) => boolean; done: (m: LiveMessage) => void }[] = [];
    let buf = '';
    const req = http.get({ host: '127.0.0.1', port, path: '/realtime/stream', headers: { Authorization: `Bearer ${tokens[who]}`, Accept: 'text/event-stream' } }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`stream ${res.statusCode}`));
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const p of parts) {
          const line = p.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const msg = JSON.parse(line.slice(6)) as LiveMessage;
          messages.push(msg);
          for (const w of waiters) if (w.fn(msg)) w.done(msg);
          if (msg.kind === 'hello' && !stream.connId) {
            stream.connId = msg.connId;
            resolve(stream);
          }
        }
      });
    });
    req.on('error', () => undefined);
    const stream: Stream = {
      messages,
      connId: '',
      close: () => req.destroy(),
      waitFor: (fn, ms = 5000) =>
        new Promise((ok, fail) => {
          const hit = messages.find(fn);
          if (hit) return ok(hit);
          const t = setTimeout(() => fail(new Error('timed out waiting for a live message')), ms);
          waiters.push({ fn, done: (m) => (clearTimeout(t), ok(m)) });
        }),
    };
    streams.push(stream);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const changeOf = (entity: string, id?: string) => (m: LiveMessage) => m.kind === 'change' && m.entity === entity && (!id || m.ids.includes(id));

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.listen(0, '127.0.0.1');
  port = (app.getHttpServer().address() as AddressInfo).port;
  prisma = app.get(PrismaService);
  const people: Record<string, string> = { founder: 'founder@bmu.demo', admin: 'admin@bmu.demo', sales: 'sales@bmu.demo', salesManager: 'sales.manager@bmu.demo', video: 'video@bmu.demo', client: 'client@sunrise.demo' };
  for (const [k, v] of Object.entries(people)) tokens[k] = await signIn(v);
  const founder = await prisma.user.findFirstOrThrow({ where: { email: 'founder@bmu.demo' } });
  orgId = founder.orgId;
  const clientUser = await prisma.clientUser.findFirstOrThrow({ where: { user: { email: 'client@sunrise.demo' } } });
  ids.clientOrg = clientUser.clientOrgId;
  ids.clientEngagement = (await prisma.engagement.findFirstOrThrow({ where: { clientOrgId: clientUser.clientOrgId, deletedAt: null, status: { in: ['in_production', 'active_retainer', 'onboarding', 'planning'] } } })).id;
  const lead = await prisma.lead.findFirstOrThrow({ where: { orgId, stage: 'new', deletedAt: null } });
  ids.lead = lead.id;
});

afterAll(async () => {
  for (const s of streams) s.close();
  await prisma.featureFlag.deleteMany({ where: { orgId } });
  await prisma.eventFailure.deleteMany({ where: { subscriber: { startsWith: 'test_' } } });
  if (ids.lead) await prisma.lead.update({ where: { id: ids.lead }, data: { stage: 'new' } });
  if (createdRequests.length) await prisma.request.deleteMany({ where: { id: { in: createdRequests } } });
  if (createdLeads.length) {
    await prisma.leadActivity.deleteMany({ where: { leadId: { in: createdLeads } } });
    await prisma.lead.deleteMany({ where: { id: { in: createdLeads } } });
  }
  await app.close();
});

describe('Live stream', () => {
  it('says hello with this person’s feature flags and needs a sign-in', async () => {
    const s = await openStream('salesManager');
    const hello = s.messages[0];
    expect(hello).toMatchObject({ kind: 'hello', flags: { live_updates: true, presence: true, smart_search: true } });
    await api().get('/realtime/stream').expect(401);
  });

  it('tells other team members when a record changes, with ids but no record data', async () => {
    const manager = await openStream('salesManager');
    await api().patch(`/leads/${ids.lead}`).set(as('founder')).send({ stage: 'contacted' }).expect(200);
    const msg = await manager.waitFor(changeOf('Lead', ids.lead));
    expect(msg).toMatchObject({ kind: 'change', entity: 'Lead', op: 'update', ids: [ids.lead] });
    expect(Object.keys(msg).sort()).toEqual(['actorId', 'at', 'entity', 'ids', 'kind', 'op']);
    const founder = await prisma.user.findFirstOrThrow({ where: { email: 'founder@bmu.demo' } });
    expect((msg as { actorId: string }).actorId).toBe(founder.id);
  });

  it('sends a client only changes on their own account', async () => {
    const client = await openStream('client');
    await api().patch(`/leads/${ids.lead}`).set(as('founder')).send({ stage: 'discovery' }).expect(200);
    const r = (await api().post('/client/requests').set(as('client')).send({ engagementId: ids.clientEngagement, type: 'question', description: `Live test ${stamp}: when is the next post?` }).expect(201)).body;
    createdRequests.push(r.id);
    await client.waitFor(changeOf('Request', r.id));
    await sleep(300);
    expect(client.messages.some(changeOf('Lead'))).toBe(false);
  });

  it('keeps personal records (notifications) to their owner', async () => {
    const sales = await openStream('sales');
    const manager = await openStream('salesManager');
    const salesUser = await prisma.user.findFirstOrThrow({ where: { email: 'sales@bmu.demo' } });
    const n = await prisma.notification.create({ data: { orgId, userId: salesUser.id, kind: 'message', title: `Live test ${stamp}`, body: 'Only for you' } });
    await sales.waitFor(changeOf('Notification', n.id));
    await sleep(300);
    expect(manager.messages.some(changeOf('Notification', n.id))).toBe(false);
    await prisma.notification.delete({ where: { id: n.id } });
  });

  it('publishes a domain event for every audited action', async () => {
    const seen: BusEvent[] = [];
    const off = eventBus.subscribe('test_domain', (e) => void seen.push(e), ['domain']);
    await api().patch(`/leads/${ids.lead}`).set(as('founder')).send({ stage: 'contacted' }).expect(200);
    await sleep(200);
    off();
    const lead = seen.find((e) => e.kind === 'domain' && e.entity === 'Lead' && e.entityId === ids.lead);
    expect(lead).toBeTruthy();
  });
});

describe('Presence', () => {
  it('shows teammates on the same record to each other', async () => {
    const a = await openStream('founder');
    const b = await openStream('salesManager');
    const room = `Lead:${ids.lead}`;
    await api().post('/realtime/presence').set(as('founder')).send({ connId: a.connId, rooms: [room] }).expect(201);
    await api().post('/realtime/presence').set(as('salesManager')).send({ connId: b.connId, rooms: [room] }).expect(201);
    const both = (m: LiveMessage) => m.kind === 'presence' && m.room === room && m.users.length === 2;
    await a.waitFor(both);
    await b.waitFor(both);
    // Leaving updates the other person.
    await api().post('/realtime/presence').set(as('salesManager')).send({ connId: b.connId, rooms: [] }).expect(201);
    await a.waitFor((m) => m.kind === 'presence' && m.room === room && m.users.length === 1 && a.messages.indexOf(m) > a.messages.findIndex(both));
  });

  it('refuses someone else’s connection and bad room names', async () => {
    const a = await openStream('founder');
    await api().post('/realtime/presence').set(as('salesManager')).send({ connId: a.connId, rooms: ['Lead:x'] }).expect(403);
    await api().post('/realtime/presence').set(as('founder')).send({ connId: a.connId, rooms: ['not a room'] }).expect(400);
  });
});

describe('Feature flags', () => {
  it('only Founders and Branch Managers change them', async () => {
    await api().patch('/system/flags/presence').set(as('sales')).send({ enabled: false }).expect(403);
    await api().get('/system/flags/all').set(as('sales')).expect(403);
    await api().patch('/system/flags/nope').set(as('founder')).send({ enabled: false }).expect(404);
  });

  it('switching live updates off for a role reaches open screens and stops their change messages', async () => {
    const manager = await openStream('salesManager');
    const founder = await openStream('founder');
    const row = (await api().patch('/system/flags/live_updates').set(as('founder')).send({ enabled: true, roles: ['founder', 'admin'] }).expect(200)).body;
    expect(row).toMatchObject({ key: 'live_updates', enabled: true, roles: ['founder', 'admin'], isDefault: false });
    await manager.waitFor((m) => m.kind === 'hello' && m.flags.live_updates === false);
    expect((await api().get('/system/flags').set(as('salesManager')).expect(200)).body.live_updates).toBe(false);
    expect((await api().get('/system/flags').set(as('founder')).expect(200)).body.live_updates).toBe(true);
    const before = manager.messages.length;
    await api().patch(`/leads/${ids.lead}`).set(as('admin')).send({ stage: 'discovery' }).expect(200);
    await founder.waitFor(changeOf('Lead', ids.lead));
    await sleep(300);
    expect(manager.messages.slice(before).some(changeOf('Lead'))).toBe(false);
    const audit = await prisma.auditEvent.findFirst({ where: { orgId, action: 'feature_flag.changed', entityId: 'live_updates' }, orderBy: { at: 'desc' } });
    expect(audit).toBeTruthy();
    await api().patch('/system/flags/live_updates').set(as('founder')).send({ enabled: true, roles: [] }).expect(200);
    await manager.waitFor((m) => m.kind === 'hello' && m.flags.live_updates === true);
  });
});

describe('Smart search', () => {
  it('finds a client despite a typo and marks it as a close match', async () => {
    const r = (await api().get('/team-flows/search').query({ q: 'sunrse realty' }).set(as('founder')).expect(200)).body;
    const clients = r.groups.find((g: { kind: string }) => g.kind === 'client');
    expect(clients.items[0].title).toMatch(/Sunrise Realty/);
    expect(clients.items[0].fuzzy).toBe(true);
    const exact = (await api().get('/team-flows/search').query({ q: 'Sunrise' }).set(as('founder')).expect(200)).body;
    expect(exact.groups.find((g: { kind: string }) => g.kind === 'client').items[0].fuzzy).toBeUndefined();
  });

  it('searches projects, requests and creators, and filters by type', async () => {
    const r = (await api().get('/team-flows/search').query({ q: 'sunrise' }).set(as('founder')).expect(200)).body;
    const kinds = r.groups.map((g: { kind: string }) => g.kind);
    expect(kinds).toEqual(expect.arrayContaining(['client', 'project']));
    const only = (await api().get('/team-flows/search').query({ q: 'sunrise', kinds: 'project' }).set(as('founder')).expect(200)).body;
    expect(only.groups.map((g: { kind: string }) => g.kind)).toEqual(['project']);
  });

  it('keeps each area’s access rules for close matches', async () => {
    const video = (await api().get('/team-flows/search').query({ q: 'sunrse realty' }).set(as('video')).expect(200)).body;
    expect(video.groups.map((g: { kind: string }) => g.kind)).not.toContain('client');
    expect(video.groups.map((g: { kind: string }) => g.kind)).not.toContain('invoice');
    const sales = (await api().get('/team-flows/search').query({ q: 'sunrse', kinds: 'invoice,request' }).set(as('sales')).expect(200)).body;
    expect(sales.groups).toEqual([]);
    await api().get('/team-flows/search').query({ q: 'sunrise' }).set(as('client')).expect(403);
  });

  it('indexes a new record within seconds of it being created', async () => {
    const name = `Zephyrine Bakehouse ${stamp}`;
    await api().post('/leads/enquiry').send({ name: 'Live Search Owner', email: `live.search.${stamp}@example.com`, phone: `96${String(stamp).slice(-8)}`, company: name, need: 'Instagram', serviceIds: [] }).expect(201);
    const lead = await prisma.lead.findFirstOrThrow({ where: { orgId, contact: { path: ['company'], equals: name } } });
    createdLeads.push(lead.id);
    await app.get(SearchIndexService).flush();
    const r = (await api().get('/team-flows/search').query({ q: 'zephyrin bakhouse' }).set(as('founder')).expect(200)).body;
    const leads = r.groups.find((g: { kind: string }) => g.kind === 'lead');
    expect(leads?.items.map((i: { id: string }) => i.id)).toContain(lead.id);
  });

  it('turning smart search off falls back to exact matching', async () => {
    await api().patch('/system/flags/smart_search').set(as('founder')).send({ enabled: false, roles: [] }).expect(200);
    const r = (await api().get('/team-flows/search').query({ q: 'sunrse realty' }).set(as('founder')).expect(200)).body;
    expect(r.groups).toEqual([]);
    await api().patch('/system/flags/smart_search').set(as('founder')).send({ enabled: true, roles: [] }).expect(200);
  });
});

describe('System health', () => {
  it('shows the bus, live connections, search and flags to Founders and Branch Managers only', async () => {
    await openStream('admin');
    const h = (await api().get('/system/health').set(as('admin')).expect(200)).body;
    expect(h.database.ok).toBe(true);
    expect(h.events.subscribers.map((s: { name: string }) => s.name)).toEqual(expect.arrayContaining(['Live updates', 'Search index']));
    expect(h.events.lastHour).toBeGreaterThan(0);
    expect(h.realtime.connections).toBeGreaterThan(0);
    expect(h.search.documents).toBeGreaterThan(0);
    expect(h.flags.map((f: { key: string }) => f.key)).toEqual(['live_updates', 'presence', 'smart_search']);
    await api().get('/system/health').set(as('sales')).expect(403);
    await api().get('/system/health').set(as('client')).expect(403);
  });

  it('records a failing listener, retries it and lets an admin dismiss it', async () => {
    let fail = true;
    const off = eventBus.subscribe('test_flaky', () => {
      if (fail) throw new Error('listener is down');
    }, ['change']);
    await api().patch(`/leads/${ids.lead}`).set(as('founder')).send({ stage: 'contacted' }).expect(200);
    let row = null;
    for (let i = 0; i < 20 && !row; i++) {
      await sleep(100);
      row = await prisma.eventFailure.findFirst({ where: { subscriber: 'test_flaky' }, orderBy: { createdAt: 'desc' } });
    }
    expect(row).toMatchObject({ status: 'retrying', attempts: 1, error: 'listener is down' });
    const listed = (await api().get('/system/health').set(as('founder')).expect(200)).body.events.failures;
    expect(listed.some((f: { id: string }) => f.id === row!.id)).toBe(true);
    // Still failing: the attempt is counted.
    expect((await api().post(`/system/events/failures/${row!.id}/retry`).set(as('founder')).expect(201)).body.ok).toBe(false);
    expect((await prisma.eventFailure.findUniqueOrThrow({ where: { id: row!.id } })).attempts).toBe(2);
    // Fixed: the retry delivers it.
    fail = false;
    expect((await api().post(`/system/events/failures/${row!.id}/retry`).set(as('founder')).expect(201)).body.ok).toBe(true);
    expect((await prisma.eventFailure.findUniqueOrThrow({ where: { id: row!.id } })).status).toBe('resolved');
    off();
    // Dismiss
    const other = await prisma.eventFailure.create({ data: { orgId, subscriber: 'test_gone', eventKind: 'Lead.update', entity: 'Lead', event: {}, error: 'x', status: 'dead' } });
    await api().post(`/system/events/failures/${other.id}/dismiss`).set(as('sales')).expect(403);
    await api().post(`/system/events/failures/${other.id}/dismiss`).set(as('admin')).expect(201);
    expect((await prisma.eventFailure.findUniqueOrThrow({ where: { id: other.id } })).status).toBe('dismissed');
  });

  it('rebuilds the search index on request', async () => {
    await api().post('/system/search/rebuild').set(as('sales')).expect(403);
    const r = (await api().post('/system/search/rebuild').set(as('founder')).expect(201)).body;
    expect(r.documents).toBeGreaterThan(10);
  });
});
