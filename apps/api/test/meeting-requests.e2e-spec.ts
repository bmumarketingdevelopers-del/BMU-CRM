// v23 meeting requests: a client asks for a meeting at a time in their own time zone, the Client Manager and Founders
// are told, the Client Manager brings in a department (its head confirms) and a Founder, the head asks for another
// time the same day, the Client Manager fixes it there (client gets an apology), then sends the meeting link to
// everyone in one click (only the respective branch's Branch Manager), the Branch Manager joins, the Department Head
// adds a team member, and a Founder asks for a client meeting through the Client Manager.
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { zonedTimeToUtc, type MeetingArrangeOptions, type MeetingList, type MeetingView } from '@bmu/shared';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

let app: INestApplication;
let prisma: PrismaService;
const tokens: Record<string, string> = {};
const users: Record<string, string> = {};
const made: string[] = [];
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const since = new Date();

const EMAILS = { client: 'client@sunrise.demo', am: 'am@bmu.demo', founder: 'founder@bmu.demo', head: 'design.head@bmu.demo', producer: 'producer@bmu.demo', admin: 'admin@bmu.demo', sales: 'sales@bmu.demo' };

async function signIn(email: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier: email }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier: email, code: otp.body.devCode }).expect(200)).body.token as string;
}

/** A date 3 days ahead (YYYY-MM-DD), so every time that day is in the future. */
const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
/** A different minute each run, so the app's duplicate-notice guard never hides this run's notices. */
const mm = String(Date.now() % 50).padStart(2, '0');

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  prisma = app.get(PrismaService);
  for (const [k, email] of Object.entries(EMAILS)) {
    tokens[k] = await signIn(email);
    users[k] = (await prisma.user.findFirstOrThrow({ where: { email } })).id;
  }
});

afterAll(async () => {
  await prisma.meeting.deleteMany({ where: { id: { in: made } } });
  await app.close();
});

describe('meeting requests', () => {
  let m: MeetingView;

  it('client asks for a meeting in their own time zone; Client Manager and Founder are told', async () => {
    await http().post('/client/meetings/request').set(as('client')).send({ startAt: zonedTimeToUtc(day, `09:${mm}`, 'America/New_York'), timeZone: 'Mars/Olympus', durationMin: 45, requirements: 'Website checkout changes' }).expect(400);
    await http().post('/client/meetings/request').set(as('client')).send({ startAt: zonedTimeToUtc(day, `09:${mm}`, 'America/New_York'), timeZone: 'America/New_York', durationMin: 45, requirements: 'short' }).expect(400);
    m = (await http().post('/client/meetings/request').set(as('client')).send({ startAt: zonedTimeToUtc(day, `09:${mm}`, 'America/New_York'), timeZone: 'America/New_York', durationMin: 45, requirements: 'Website checkout changes and a Diwali landing page' }).expect(201)).body;
    made.push(m.id);
    expect(m.status).toBe('requested');
    expect(m.timeZone).toBe('America/New_York');
    expect(m.durationMin).toBe(45);
    // 09:00 in New York is 18:30 or 19:30 in India, depending on daylight saving.
    expect([`13:${mm}`, `14:${mm}`]).toContain(m.startAt.slice(11, 16));
    for (const who of ['am', 'founder']) {
      expect(await prisma.notification.findFirst({ where: { userId: users[who], kind: 'meeting', createdAt: { gte: since }, title: { contains: 'meeting', mode: 'insensitive' } } })).toBeTruthy();
    }
    const client = (await http().get('/client/meetings').set(as('client')).expect(200)).body as MeetingList;
    expect(client.requests.some((x) => x.id === m.id)).toBe(true);
  });

  it('only the Client Manager arranges; Department Head and Founder are asked to confirm', async () => {
    const list = (await http().get('/meetings').set(as('am')).expect(200)).body as MeetingList;
    expect(list.requests.find((x) => x.id === m.id)?.can.arrange).toBe(true);
    const opts = (await http().get('/meetings/arrange-options').set(as('am')).expect(200)).body as MeetingArrangeOptions;
    const design = opts.departments.find((d) => d.head?.id === users.head);
    expect(design).toBeTruthy();
    expect(opts.founders.some((f) => f.id === users.founder)).toBe(true);
    await http().post(`/meetings/${m.id}/arrange`).set(as('sales')).send({ departmentId: design!.id }).expect((r) => expect([403, 404]).toContain(r.status));
    await http().post(`/meetings/${m.id}/arrange`).set(as('am')).send({}).expect(400);
    m = (await http().post(`/meetings/${m.id}/arrange`).set(as('am')).send({ departmentId: design!.id, founderId: users.founder }).expect(200)).body;
    expect(m.status).toBe('awaiting');
    expect(m.participants.map((p) => [p.role, p.status]).sort()).toEqual([['department_head', 'pending'], ['founder', 'pending']]);
    expect(await prisma.notification.findFirst({ where: { userId: users.head, kind: 'meeting', createdAt: { gte: since }, title: { contains: 'can you join' } } })).toBeTruthy();
    await http().post(`/meetings/${m.id}/fix`).set(as('am')).send({}).expect(400);
  });

  it('Department Head asks for another time the same day; Founder accepts; the Client Manager fixes it', async () => {
    await http().post(`/meetings/${m.id}/respond`).set(as('producer')).send({ decision: 'accept' }).expect((r) => expect([403, 404]).toContain(r.status));
    const nextDay = new Date(new Date(m.startAt).getTime() + 86_400_000).toISOString();
    await http().post(`/meetings/${m.id}/respond`).set(as('head')).send({ decision: 'reschedule', proposedStartAt: nextDay }).expect(400);
    const later = new Date(new Date(m.startAt).getTime() + 3_600_000).toISOString();
    m = (await http().post(`/meetings/${m.id}/respond`).set(as('head')).send({ decision: 'reschedule', proposedStartAt: later, note: 'Team stand-up then' }).expect(200)).body;
    m = (await http().post(`/meetings/${m.id}/respond`).set(as('founder')).send({ decision: 'accept' }).expect(200)).body;
    expect(m.status).toBe('awaiting'); // a new time waits for the Client Manager
    await http().post(`/meetings/${m.id}/fix`).set(as('am')).send({}).expect(400);
    // No link before everyone has accepted and the meeting is fixed.
    await http().post(`/meetings/${m.id}/link`).set(as('am')).send({ joinUrl: 'https://meet.google.com/abc-defg-hij' }).expect(403);
    // v25: moving it needs a reason for the client.
    await http().post(`/meetings/${m.id}/fix`).set(as('am')).send({ startAt: later }).expect(400);
    m = (await http().post(`/meetings/${m.id}/fix`).set(as('am')).send({ startAt: later, reason: 'Our team stand-up runs at that time' }).expect(200)).body;
    expect(m.status).toBe('booked');
    expect(m.rescheduleReason).toBe('Our team stand-up runs at that time');
    expect(m.startAt).toBe(later);
    expect(m.durationMin).toBe(45);
    expect(m.rescheduledAt).toBeTruthy();
    expect(m.joinUrl).toBeNull();
    expect(m.can.shareLink).toBe(true);
    // Only the Branch Manager of the respective branch is brought in.
    const bms = m.participants.filter((p) => p.role === 'branch_manager');
    const branchId = (await prisma.clientOrg.findFirstOrThrow({ where: { id: m.client!.id }, select: { branchId: true } })).branchId ?? (await prisma.user.findUniqueOrThrow({ where: { id: users.am } })).branchId;
    for (const b of bms) expect((await prisma.user.findUniqueOrThrow({ where: { id: b.userId } })).branchId).toBe(branchId);
    expect(bms.find((b) => b.userId === users.admin)?.status).toBe('invited');
    const sorry = await prisma.notification.findFirst({ where: { userId: users.client, kind: 'meeting', createdAt: { gte: since }, title: 'Sorry, we had to move your meeting' } });
    expect(sorry?.body).toContain('Reason: Our team stand-up runs at that time');
    expect(await prisma.notification.findFirst({ where: { userId: users.founder, createdAt: { gte: since }, title: { startsWith: 'Meeting moved' }, body: { contains: 'Our team stand-up runs at that time' } } })).toBeTruthy();
  });

  it('the Client Manager sends the meeting link to everyone in one click', async () => {
    await http().post(`/meetings/${m.id}/link`).set(as('head')).send({ joinUrl: 'https://meet.google.com/abc-defg-hij' }).expect(403);
    await http().post(`/meetings/${m.id}/link`).set(as('am')).send({ joinUrl: 'not a link' }).expect(400);
    await http().post(`/meetings/${m.id}/link`).set(as('am')).send({ joinUrl: 'http://meet.google.com/abc-defg-hij' }).expect(400);
    m = (await http().post(`/meetings/${m.id}/link`).set(as('am')).send({ joinUrl: 'https://meet.google.com/abc-defg-hij' }).expect(200)).body;
    expect(m.joinUrl).toBe('https://meet.google.com/abc-defg-hij');
    for (const who of ['client', 'founder', 'head', 'admin']) {
      const n = await prisma.notification.findFirst({ where: { userId: users[who], createdAt: { gte: since }, body: { contains: 'meet.google.com/abc-defg-hij' } } });
      expect(n, who).toBeTruthy();
    }
    expect(await prisma.notification.findFirst({ where: { userId: users.admin, createdAt: { gte: since }, title: { contains: 'join now' } } })).toBeTruthy();
    expect(await prisma.emailOutbox.findFirst({ where: { kind: 'meeting', createdAt: { gte: since }, text: { contains: 'meet.google.com/abc-defg-hij' } } })).toBeTruthy();
  });

  it('client sees the fixed time in their zone with the link; Branch Manager joins; Department Head adds a team member', async () => {
    const client = (await http().get('/client/meetings').set(as('client')).expect(200)).body as MeetingList;
    const mine = client.upcoming.find((x) => x.id === m.id)!;
    expect(mine.joinUrl).toBe('https://meet.google.com/abc-defg-hij');
    expect(mine.participants.some((p) => p.role === 'branch_manager')).toBe(false); // invited, not yet joining
    expect(mine.participants.every((p) => p.note === null)).toBe(true);

    m = (await http().post(`/meetings/${m.id}/join`).set(as('admin')).send({ decision: 'join' }).expect(200)).body;
    expect(m.participants.find((p) => p.userId === users.admin)?.status).toBe('joined');

    await http().get(`/meetings/${m.id}/member-options`).set(as('am')).expect(403);
    const options = (await http().get(`/meetings/${m.id}/member-options`).set(as('head')).expect(200)).body as { id: string }[];
    expect(options.some((o) => o.id === users.producer)).toBe(true);
    await http().post(`/meetings/${m.id}/members`).set(as('head')).send({ userIds: [users.sales] }).expect(400);
    m = (await http().post(`/meetings/${m.id}/members`).set(as('head')).send({ userIds: [users.producer] }).expect(200)).body;
    expect(m.participants.find((p) => p.userId === users.producer)?.role).toBe('member');
    const producerList = (await http().get('/meetings').set(as('producer')).expect(200)).body as MeetingList;
    expect(producerList.upcoming.some((x) => x.id === m.id)).toBe(true);
  });

  it('a Founder asks for a client meeting through the Client Manager', async () => {
    const sunrise = (await prisma.user.findFirstOrThrow({ where: { id: users.client }, select: { clientUser: { select: { clientOrgId: true } } } })).clientUser!.clientOrgId;
    const body = { clientOrgId: sunrise, startAt: zonedTimeToUtc(day, `15:${mm}`, 'Asia/Kolkata'), durationMin: 30, requirements: 'Quarterly review with the owner' };
    await http().post('/meetings/founder-request').set(as('am')).send(body).expect(403);
    const f = (await http().post('/meetings/founder-request').set(as('founder')).send(body).expect(201)).body as MeetingView;
    made.push(f.id);
    expect(f.status).toBe('requested');
    expect(f.bookedVia).toBe('founder');
    expect(f.host.id).toBe(users.am);
    expect(f.participants).toEqual([expect.objectContaining({ userId: users.founder, role: 'founder', status: 'accepted' })]);
    expect(await prisma.notification.findFirst({ where: { userId: users.am, createdAt: { gte: since }, title: { contains: 'wants a meeting with' } } })).toBeTruthy();
    // The Client Manager agrees the time with the client and fixes it; the client is told it is scheduled.
    const fixed = (await http().post(`/meetings/${f.id}/fix`).set(as('am')).send({}).expect(200)).body as MeetingView;
    expect(fixed.status).toBe('booked');
    expect(await prisma.notification.findFirst({ where: { userId: users.client, createdAt: { gte: since }, title: 'Your meeting is scheduled' } })).toBeTruthy();
  });

  it('cancelling tells everyone brought in', async () => {
    await http().post(`/meetings/${m.id}/cancel`).set(as('am')).expect(200);
    expect(await prisma.notification.findFirst({ where: { userId: users.producer, createdAt: { gte: since }, title: { startsWith: 'Meeting cancelled' } } })).toBeTruthy();
  });
});
