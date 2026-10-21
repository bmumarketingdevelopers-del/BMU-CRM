// v34: meetings and social posts on the team Calendar, and the Founder's "Content this week".
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
const tag = (s: string) => `${s} ${stamp}`;
const DAY = 86_400_000;
const istDay = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);

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
  for (const [k, email] of Object.entries({ founder: 'founder@bmu.demo', am: 'am@bmu.demo', producer: 'producer@bmu.demo' })) {
    tokens[k] = await signIn(email);
    ids[k] = (await prisma.user.findFirstOrThrow({ where: { email } })).id;
  }
  const cycle = await prisma.cycle.findFirstOrThrow({ where: { orgId: org.id, engagement: { amId: ids.am, deletedAt: null } }, orderBy: { createdAt: 'desc' } });
  // A meeting the producer takes part in, a post scheduled in 2 days, and one waiting on the client.
  const start = new Date(Date.now() + 2 * DAY);
  ids.meeting = (await prisma.meeting.create({ data: { orgId: org.id, title: tag('Kick-off call'), hostId: ids.am, startAt: start, endAt: new Date(start.getTime() + 3_600_000), status: 'booked', participants: { create: { userId: ids.producer, role: 'member', status: 'accepted' } } } })).id;
  ids.post = (await prisma.deliverable.create({ data: { orgId: org.id, cycleId: cycle.id, type: 'post', title: tag('Launch post'), status: 'scheduled', scheduledAt: start, channel: 'instagram' } })).id;
  ids.waiting = (await prisma.deliverable.create({ data: { orgId: org.id, cycleId: cycle.id, type: 'reel', title: tag('Teaser reel'), status: 'ready_for_client' } })).id;
  ids.when = istDay(start);
});

afterAll(async () => {
  await prisma.meetingParticipant.deleteMany({ where: { meetingId: ids.meeting } });
  await prisma.meeting.deleteMany({ where: { id: ids.meeting } });
  await prisma.deliverable.deleteMany({ where: { id: { in: [ids.post, ids.waiting] } } });
  await app.close();
});

describe('team Calendar', () => {
  it('shows meetings for the host and for team members taking part', async () => {
    const month = ids.when.slice(0, 7);
    const mine = (await http().get(`/workspace/calendar?month=${month}&view=mine`).set(as('producer')).expect(200)).body;
    const m = mine.items.find((i: { id: string }) => i.id === `m-${ids.meeting}`);
    expect(m).toMatchObject({ kind: 'meeting', date: ids.when, title: tag('Kick-off call') });
    expect(m.time).toMatch(/^\d{2}:\d{2}$/);
    const host = (await http().get(`/workspace/calendar?month=${month}&view=mine`).set(as('am')).expect(200)).body;
    expect(host.items.some((i: { id: string }) => i.id === `m-${ids.meeting}`)).toBe(true);
  });

  it("shows scheduled social posts for the client's Client Manager and for the Founder's whole team", async () => {
    const month = ids.when.slice(0, 7);
    const cm = (await http().get(`/workspace/calendar?month=${month}&view=mine`).set(as('am')).expect(200)).body;
    expect(cm.items.find((i: { id: string }) => i.id === `p-${ids.post}`)).toMatchObject({ kind: 'post', date: ids.when, done: false });
    const all = (await http().get(`/workspace/calendar?month=${month}&view=team`).set(as('founder')).expect(200)).body;
    expect(all.items.some((i: { id: string }) => i.id === `p-${ids.post}`)).toBe(true);
    // Not someone else's work.
    const other = (await http().get(`/workspace/calendar?month=${month}&view=mine`).set(as('producer')).expect(200)).body;
    expect(other.items.some((i: { id: string }) => i.id === `p-${ids.post}`)).toBe(false);
  });
});

describe("Founder's Content this week", () => {
  it('counts posts coming up and work waiting on clients, for leadership only', async () => {
    const d = (await http().get('/insights/content-week').set(as('founder')).expect(200)).body;
    expect(d.scheduledCount).toBeGreaterThan(0);
    expect(d.waitingCount).toBeGreaterThan(0);
    expect(Array.isArray(d.failed) && Array.isArray(d.dueToPost)).toBe(true);
    await http().get('/insights/content-week').set(as('am')).expect(403);
    await http().get('/insights/content-week').set(as('producer')).expect(403);
  });
});
