// v23 Google Meet with meeting requests, against a fake Google Calendar: the Client Manager connects their calendar,
// a client's request is fixed and becomes a Google event with a Meet link (in joinUrl) and everyone in it invited,
// a team member added later and a Branch Manager who ignores it change the guest list (other replies kept), replies
// are read back, cancelling cancels the event, team-added meetings invite the people picked, a host without a
// calendar gets a clear reason, and the connect / disconnect / sign-in return paths work.
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { vi } from 'vitest';
import { zonedTimeToUtc, type CalendarConnectionView, type MeetingArrangeOptions, type MeetingView } from '@bmu/shared';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { MeetingsService } from '../src/comms/meetings.service.js';
import { seal, signToken } from '../src/integrations/crypto.js';

let app: INestApplication;
let prisma: PrismaService;
const tokens: Record<string, string> = {};
const users: Record<string, string> = {};
const made: string[] = [];
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const since = new Date();

const EMAILS = { client: 'client@sunrise.demo', am: 'am@bmu.demo', founder: 'founder@bmu.demo', head: 'design.head@bmu.demo', producer: 'producer@bmu.demo', admin: 'admin@bmu.demo' };

// ------------------------------------------------------------------------------------------------ fake Google
type FakeEvent = { id: string; summary: string; hangoutLink: string; attendees: { email: string; displayName?: string; responseStatus: string }[]; deleted: boolean; body: Record<string, unknown> };
const events = new Map<string, FakeEvent>();
const calls: { method: string; url: string }[] = [];
const realFetch = globalThis.fetch;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

function fakeGoogle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (!/googleapis\.com/.test(url)) return realFetch(input, init);
  const method = (init?.method ?? 'GET').toUpperCase();
  calls.push({ method, url });
  if (url.startsWith('https://oauth2.googleapis.com/revoke')) return Promise.resolve(new Response(null, { status: 200 }));
  const m = url.match(/calendars\/primary\/events(?:\/([^?]+))?/);
  if (!m) return Promise.resolve(json({ error: { message: 'unexpected Google call' } }, 400));
  const id = m[1] ? decodeURIComponent(m[1]) : null;
  if (!id && method === 'POST') {
    const body = JSON.parse(String(init?.body)) as { summary: string; attendees: { email: string; displayName?: string }[] };
    const e: FakeEvent = { id: `evt${events.size + 1}`, summary: body.summary, hangoutLink: `https://meet.google.com/bmu-test-00${events.size + 1}`, attendees: body.attendees.map((a) => ({ ...a, responseStatus: 'needsAction' })), deleted: false, body };
    events.set(e.id, e);
    return Promise.resolve(json(e));
  }
  const e = id ? events.get(id) : undefined;
  if (!e || e.deleted) return Promise.resolve(json({ error: { message: 'Not Found' } }, 404));
  if (method === 'GET') return Promise.resolve(json(e));
  if (method === 'PATCH') {
    e.attendees = (JSON.parse(String(init?.body)) as { attendees: FakeEvent['attendees'] }).attendees.map((a) => ({ ...a, responseStatus: a.responseStatus ?? 'needsAction' }));
    return Promise.resolve(json(e));
  }
  if (method === 'DELETE') {
    e.deleted = true;
    return Promise.resolve(new Response(null, { status: 204 }));
  }
  return Promise.resolve(json({ error: { message: 'unexpected method' } }, 400));
}
const emailsOn = (e: FakeEvent) => e.attendees.map((a) => a.email).sort();
const lastEvent = () => [...events.values()].at(-1)!;

async function signIn(email: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier: email }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier: email, code: otp.body.devCode }).expect(200)).body.token as string;
}

const day = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);
const mm = String((Date.now() + 25) % 50).padStart(2, '0');

beforeAll(async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(fakeGoogle as typeof fetch);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  prisma = app.get(PrismaService);
  for (const [k, email] of Object.entries(EMAILS)) {
    tokens[k] = await signIn(email);
    users[k] = (await prisma.user.findFirstOrThrow({ where: { email } })).id;
  }
  const orgId = (await prisma.user.findUniqueOrThrow({ where: { id: users.am } })).orgId;
  // The Client Manager has connected Google Calendar (a token that does not need refreshing yet).
  const conn = { email: 'am@bmu.demo', tokenEnc: seal('fake-access'), refreshEnc: seal('fake-refresh'), tokenExpiresAt: new Date(Date.now() + 3_600_000), status: 'connected', lastError: null };
  await prisma.calendarConnection.upsert({ where: { userId: users.am }, create: { orgId, userId: users.am, ...conn }, update: conn });
  await prisma.calendarConnection.deleteMany({ where: { userId: users.producer } });
});

afterAll(async () => {
  await prisma.meeting.deleteMany({ where: { id: { in: made } } });
  await prisma.calendarConnection.deleteMany({ where: { userId: users.am } });
  await app.close();
  vi.restoreAllMocks();
});

describe('Google Meet', () => {
  let m: MeetingView;

  it('shows the Client Manager as connected', async () => {
    const g = (await http().get('/meetings/google').set(as('am')).expect(200)).body as CalendarConnectionView;
    expect(g).toMatchObject({ available: true, connected: true, email: 'am@bmu.demo' });
    const p = (await http().get('/meetings/google').set(as('producer')).expect(200)).body as CalendarConnectionView;
    expect(p.connected).toBe(false);
    await http().get('/meetings/google').set(as('client')).expect(403);
  });

  it('a request stays out of Google until it is fixed, then gets a Meet link and everyone is invited', async () => {
    m = (await http().post('/client/meetings/request').set(as('client')).send({ startAt: zonedTimeToUtc(day, `10:${mm}`, 'Asia/Kolkata'), timeZone: 'Asia/Kolkata', durationMin: 30, requirements: 'Plan the Diwali campaign together' }).expect(201)).body;
    made.push(m.id);
    const opts = (await http().get('/meetings/arrange-options').set(as('am')).expect(200)).body as MeetingArrangeOptions;
    const design = opts.departments.find((d) => d.head?.id === users.head)!;
    m = (await http().post(`/meetings/${m.id}/arrange`).set(as('am')).send({ departmentId: design.id, founderId: users.founder }).expect(200)).body;
    m = (await http().post(`/meetings/${m.id}/respond`).set(as('head')).send({ decision: 'accept' }).expect(200)).body;
    expect(events.size).toBe(0);
    expect(m.joinUrl).toBeNull();
    // The last acceptance fixes it: the Google event is made in the Client Manager's calendar.
    m = (await http().post(`/meetings/${m.id}/respond`).set(as('founder')).send({ decision: 'accept' }).expect(200)).body;
    expect(m.status).toBe('booked');
    expect(events.size).toBe(1);
    const e = lastEvent();
    expect(m.joinUrl).toBe(e.hangoutLink);
    expect(m.google).toEqual({ synced: true, error: null });
    const call = calls.find((c) => c.method === 'POST')!;
    expect(call.url).toContain('conferenceDataVersion=1');
    expect(call.url).toContain('sendUpdates=all');
    expect((e.body.conferenceData as { createRequest: { requestId: string } }).createRequest.requestId).toBe(`bmu-${m.id}`);
    // Client (who asked), Founder, Department Head and the branch's Branch Manager; never the host themself.
    expect(emailsOn(e)).toEqual(expect.arrayContaining(['client@sunrise.demo', 'founder@bmu.demo', 'design.head@bmu.demo']));
    expect(emailsOn(e)).not.toContain('am@bmu.demo');
    const bm = m.participants.find((p) => p.role === 'branch_manager');
    if (bm) expect(emailsOn(e)).toContain((await prisma.user.findUniqueOrThrow({ where: { id: bm.userId } })).email!.toLowerCase());
    expect(m.attendees).toEqual([expect.objectContaining({ email: 'client@sunrise.demo', kind: 'client', response: 'needsAction' })]);
    // Everyone hears with the link (the Founder fixed it by accepting last, so is not told their own news).
    expect(await prisma.notification.findFirst({ where: { userId: users.head, createdAt: { gte: since }, body: { contains: e.hangoutLink } } })).toBeTruthy();
    expect(await prisma.notification.findFirst({ where: { userId: users.client, createdAt: { gte: since }, body: { contains: e.hangoutLink } } })).toBeTruthy();
    const client = (await http().get('/client/meetings').set(as('client')).expect(200)).body as { upcoming: MeetingView[] };
    const mine = client.upcoming.find((x) => x.id === m.id)!;
    expect(mine.joinUrl).toBe(e.hangoutLink);
    expect(mine.google).toBeNull();
    expect(mine.attendees.every((a) => a.email === null)).toBe(true);
  });

  it('a team member added later joins the Google event; earlier replies are kept', async () => {
    const e = lastEvent();
    e.attendees.find((a) => a.email === 'founder@bmu.demo')!.responseStatus = 'accepted';
    m = (await http().post(`/meetings/${m.id}/members`).set(as('head')).send({ userIds: [users.producer] }).expect(200)).body;
    expect(emailsOn(e)).toContain('producer@bmu.demo');
    expect(e.attendees.find((a) => a.email === 'founder@bmu.demo')!.responseStatus).toBe('accepted');
    expect(calls.at(-1)!.method).toBe('PATCH');
    expect(calls.at(-1)!.url).toContain('sendUpdates=all');
  });

  it('a Branch Manager who ignores it is taken off the Google event', async () => {
    const bm = m.participants.find((p) => p.role === 'branch_manager');
    if (!bm) return; // the demo branch has no Branch Manager
    const who = Object.entries(users).find(([, id]) => id === bm.userId)?.[0];
    if (!who) return;
    const bmEmail = (await prisma.user.findUniqueOrThrow({ where: { id: bm.userId } })).email!.toLowerCase();
    m = (await http().post(`/meetings/${m.id}/join`).set(as(who)).send({ decision: 'ignore' }).expect(200)).body;
    expect(emailsOn(lastEvent())).not.toContain(bmEmail);
    expect(emailsOn(lastEvent())).toContain('producer@bmu.demo');
  });

  it('reads replies back from Google Calendar', async () => {
    const e = lastEvent();
    e.attendees.find((a) => a.email === 'client@sunrise.demo')!.responseStatus = 'accepted';
    e.attendees.find((a) => a.email === 'producer@bmu.demo')!.responseStatus = 'declined';
    expect(await app.get(MeetingsService).syncReplies()).toBeGreaterThanOrEqual(3);
    m = (await http().get(`/meetings/${m.id}`).set(as('am')).expect(200)).body;
    expect(m.attendees.find((a) => a.email === 'client@sunrise.demo')?.response).toBe('accepted');
    expect(m.participants.find((p) => p.userId === users.producer)?.googleResponse).toBe('declined');
    expect(m.participants.find((p) => p.userId === users.founder)?.googleResponse).toBe('accepted');
  });

  it('a pasted link still replaces the Meet link when needed', async () => {
    m = (await http().post(`/meetings/${m.id}/link`).set(as('am')).send({ joinUrl: 'https://zoom.us/j/123456' }).expect(200)).body;
    expect(m.joinUrl).toBe('https://zoom.us/j/123456');
  });

  it('cancelling cancels the Google event for everyone', async () => {
    await http().post(`/meetings/${m.id}/cancel`).set(as('am')).expect(200);
    expect(lastEvent().deleted).toBe(true);
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE' });
    expect(calls.at(-1)!.url).toContain('sendUpdates=all');
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: m.id } })).googleError).toBeNull();
  });

  it('a meeting the team adds invites the people picked and the client, with a Meet link', async () => {
    const sunrise = (await prisma.user.findFirstOrThrow({ where: { id: users.client }, select: { clientUser: { select: { clientOrgId: true } } } })).clientUser!.clientOrgId;
    const people = (await http().get('/meetings/people').set(as('am')).expect(200)).body as { id: string }[];
    expect(people.some((p) => p.id === users.producer)).toBe(true);
    const startAt = zonedTimeToUtc(day, `16:${mm}`, 'Asia/Kolkata');
    await http().post('/meetings').set(as('am')).send({ title: 'Kick-off', startAt, durationMin: 30, attendeeIds: ['nobody'] }).expect(400);
    const t = (await http().post('/meetings').set(as('am')).send({ title: 'Kick-off', startAt, durationMin: 30, clientOrgId: sunrise, attendeeIds: [users.producer, users.am] }).expect(201)).body as MeetingView;
    made.push(t.id);
    expect(t.participants).toEqual(expect.arrayContaining([expect.objectContaining({ userId: users.producer, role: 'member', status: 'invited' })]));
    // v24: a client meeting also asks the client's branch Branch Manager to join or ignore; nobody else is added.
    expect(t.participants.filter((p) => p.userId !== users.producer).every((p) => p.role === 'branch_manager' && p.status === 'invited')).toBe(true);
    expect(t.attendees.some((a) => a.email === 'client@sunrise.demo')).toBe(true);
    expect(t.joinUrl).toBe(lastEvent().hangoutLink);
    expect(emailsOn(lastEvent())).toEqual(expect.arrayContaining(['producer@bmu.demo', 'client@sunrise.demo']));
    expect(await prisma.notification.findFirst({ where: { userId: users.producer, createdAt: { gte: since }, title: { contains: 'invited you: Kick-off' } } })).toBeTruthy();
    const producer = (await http().get('/meetings').set(as('producer')).expect(200)).body as { upcoming: MeetingView[] };
    expect(producer.upcoming.some((x) => x.id === t.id)).toBe(true);
    // The host joins with the organiser Google account (Meet host); invited people just get the link.
    expect(t.joinAs).toBe('am@bmu.demo');
    expect(producer.upcoming.find((x) => x.id === t.id)?.joinAs).toBeNull();
    // Without a Meet link: no Google event, and the client is emailed by the CRM instead.
    const before = events.size;
    const n = (await http().post('/meetings').set(as('am')).send({ title: 'Office visit', startAt, durationMin: 30, clientOrgId: sunrise, location: 'Indiranagar office', addMeet: false }).expect(201)).body as MeetingView;
    made.push(n.id);
    expect(events.size).toBe(before);
    expect(n.joinUrl).toBeNull();
    expect(await prisma.emailOutbox.findFirst({ where: { kind: 'meeting', entityId: n.id, text: { contains: 'Indiranagar office' } } })).toBeTruthy();
  });

  it('pressing Add meeting many times makes one meeting, one Meet link and one notice each', async () => {
    const sunrise = (await prisma.user.findFirstOrThrow({ where: { id: users.client }, select: { clientUser: { select: { clientOrgId: true } } } })).clientUser!.clientOrgId;
    const startAt = zonedTimeToUtc(day, `18:${mm}`, 'Asia/Kolkata');
    const title = `Design review ${mm}`;
    const before = events.size;
    const body = { title, startAt, durationMin: 30, clientOrgId: sunrise, attendeeIds: [users.producer] };
    const replies = await Promise.all(Array.from({ length: 6 }, () => http().post('/meetings').set(as('am')).send(body)));
    for (const r of replies) expect(r.status).toBe(201);
    const ids = [...new Set(replies.map((r) => (r.body as MeetingView).id))];
    made.push(...ids);
    expect(ids).toHaveLength(1);
    expect(await prisma.meeting.count({ where: { title, startAt: new Date(startAt) } })).toBe(1);
    expect(events.size).toBe(before + 1);
    // Everyone invited sees that one meeting, with the link, in their own Meetings, and hears about it once.
    const producer = (await http().get('/meetings').set(as('producer')).expect(200)).body as { upcoming: MeetingView[] };
    const theirs = producer.upcoming.filter((x) => x.title === title);
    expect(theirs).toHaveLength(1);
    expect(theirs[0].joinUrl).toBe(lastEvent().hangoutLink);
    expect(await prisma.notification.count({ where: { userId: users.producer, createdAt: { gte: since }, title: { contains: `invited you: ${title}` } } })).toBe(1);
    const client = (await http().get('/client/meetings').set(as('client')).expect(200)).body as { upcoming: MeetingView[] };
    expect(client.upcoming.filter((x) => x.title === title)).toHaveLength(1);
    expect(await prisma.notification.count({ where: { userId: users.client, createdAt: { gte: since }, title: `Meeting with BMU: ${title}` } })).toBe(1);
    // A genuinely different meeting (another time) is still made.
    const other = (await http().post('/meetings').set(as('am')).send({ ...body, startAt: zonedTimeToUtc(day, `19:${mm}`, 'Asia/Kolkata') }).expect(201)).body as MeetingView;
    made.push(other.id);
    expect(other.id).not.toBe(ids[0]);
  });

  it('a host without Google Calendar gets the meeting with a clear reason instead of a link', async () => {
    const x = (await http().post('/meetings').set(as('producer')).send({ title: 'Edit review', startAt: zonedTimeToUtc(day, `17:${mm}`, 'Asia/Kolkata'), durationMin: 30 }).expect(201)).body as MeetingView;
    made.push(x.id);
    expect(x.joinUrl).toBeNull();
    expect(x.google?.error).toContain('has not connected Google Calendar');
  });

  it('connect link, sign-in return and disconnect', async () => {
    const { url } = (await http().post('/meetings/google/connect').set(as('producer')).expect(200)).body as { url: string };
    const u = new URL(url);
    expect(u.origin).toBe('https://accounts.google.com');
    expect(u.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/calendar.events');
    expect(u.searchParams.get('redirect_uri')).toMatch(/\/integrations\/oauth\/callback$/);
    expect(u.searchParams.get('access_type')).toBe('offline');
    const cancelled = await http().get('/integrations/oauth/callback').query({ state: u.searchParams.get('state'), error: 'access_denied' }).expect(302);
    expect(cancelled.headers.location).toContain('/team/meetings?calendarError=access_denied');
    const forged = signToken({ k: 'calendar', o: 'x', u: users.producer, n: 'n' }, 600).replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    const bad = await http().get('/integrations/oauth/callback').query({ state: forged, code: 'abc' }).expect(302);
    expect(bad.headers.location).toContain('/admin/integrations?error=');
    const off = (await http().post('/meetings/google/disconnect').set(as('am')).expect(200)).body as CalendarConnectionView;
    expect(off.connected).toBe(false);
    expect(calls.some((c) => c.url.startsWith('https://oauth2.googleapis.com/revoke'))).toBe(true);
    const row = await prisma.calendarConnection.findUniqueOrThrow({ where: { userId: users.am } });
    expect(row.tokenEnc).toBeNull();
    expect(row.refreshEnc).toBeNull();
  });
});
