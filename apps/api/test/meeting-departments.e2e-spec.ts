// v24 meetings: the Client Manager brings several departments (each Department Head confirms) and a Founder into a
// client meeting, here from "+ New → Meeting"; once everyone accepts it is fixed and only the Branch Manager of the
// client's branch is asked to join or ignore; Department Heads add only people working on the client's projects; and
// another branch's Branch Manager can be added only by the Client Manager or the client's Branch Manager.
// v26: everyone taking part is reminded 15 minutes before with the link, and once a meeting ends its link closes and
// it is in Past as completed.
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { zonedTimeToUtc, type MeetingBranchManagerOption, type MeetingList, type MeetingMemberOption, type MeetingView } from '@bmu/shared';
import { AppModule } from '../src/app.module.js';
import { MeetingsService } from '../src/comms/meetings.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

let app: INestApplication;
let prisma: PrismaService;
let orgId: string;
const tokens: Record<string, string> = {};
const users: Record<string, string> = {};
const ids: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const stamp = Date.now();
const since = new Date();
const mm = String(stamp % 50).padStart(2, '0');
const day = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);

async function signIn(email: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier: email }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier: email, code: otp.body.devCode }).expect(200)).body.token as string;
}

async function staff(key: string, name: string, baseRole: string, extra: { branchId?: string; departmentId?: string } = {}) {
  const role = await prisma.role.findFirstOrThrow({ where: { orgId, baseRole, isCustom: false } });
  const email = `v24.${key.toLowerCase()}.${stamp}@example.com`;
  const u = await prisma.user.create({ data: { orgId, type: 'staff', name, email, status: 'active', ...extra, roles: { create: { roleId: role.id } } } });
  users[key] = u.id;
  tokens[key] = await signIn(email);
  return u;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  prisma = app.get(PrismaService);
  const org = await prisma.organisation.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  orgId = org.id;
  for (const [key, email] of Object.entries({ am: 'am@bmu.demo', founder: 'founder@bmu.demo', designHead: 'design.head@bmu.demo' })) {
    tokens[key] = await signIn(email);
    users[key] = (await prisma.user.findFirstOrThrow({ where: { email } })).id;
  }
  const local = await prisma.branch.create({ data: { orgId, name: `Local ${stamp}`, city: 'Bengaluru' } });
  const other = await prisma.branch.create({ data: { orgId, name: `Other ${stamp}`, city: 'Mumbai' } });
  ids.local = local.id;
  await staff('localBm', 'Lena Local', 'admin', { branchId: local.id });
  await staff('otherBm', 'Omar Other', 'admin', { branchId: other.id });
  // A second department with its own head, next to the demo Creative / Design department.
  const design = await prisma.department.findFirstOrThrow({ where: { orgId, headUserId: users.designHead, deletedAt: null } });
  ids.design = design.id;
  const dev = await prisma.department.create({ data: { orgId, branchId: local.id, name: `Dev ${stamp}` } });
  ids.dev = dev.id;
  await staff('devHead', 'Dev Head', 'department_head', { departmentId: dev.id, branchId: local.id });
  await prisma.department.update({ where: { id: dev.id }, data: { headUserId: users.devHead } });
  await staff('worker', 'Wendy Worker', 'producer', { departmentId: design.id });
  await staff('idle', 'Ivan Idle', 'producer', { departmentId: design.id });
  await staff('devWorker', 'Dina Dev', 'producer', { departmentId: dev.id });
  // The client, in the local branch, with a project the worker has a task on.
  const client = await prisma.clientOrg.create({ data: { orgId, name: `Dept Test ${stamp}`, amUserId: users.am, branchId: local.id } });
  ids.client = client.id;
  const service = await prisma.service.findFirstOrThrow({ where: { key: 'smm', priceBook: { orgId, status: 'active' } } });
  const eng = await prisma.engagement.create({ data: { orgId, clientOrgId: client.id, serviceId: service.id, tier: 'growth', billingType: 'monthly', status: 'in_production', currentGate: 'G3', amId: users.am } });
  for (const owner of [users.worker, users.devWorker]) {
    await prisma.task.create({ data: { orgId, title: `Landing page ${stamp}`, ownerId: owner, engagementId: eng.id, deadline: new Date(Date.now() + 5 * 86_400_000) } });
  }
});

afterAll(async () => {
  await prisma.meeting.deleteMany({ where: { clientOrgId: ids.client } });
  await prisma.user.updateMany({ where: { email: { endsWith: `.${stamp}@example.com` } }, data: { status: 'suspended', deletedAt: new Date() } });
  await app.close();
});

describe('meetings with several departments', () => {
  let m: MeetingView;

  it('the Client Manager brings in two departments and the Founder from "+ New → Meeting"; they confirm first', async () => {
    const body = { title: `Website rebuild ${stamp}`, startAt: zonedTimeToUtc(day, `15:${mm}`, 'Asia/Kolkata'), durationMin: 60, clientOrgId: ids.client, departmentIds: [ids.design, ids.dev], founderId: users.founder, addMeet: false };
    m = (await http().post('/meetings').set(as('am')).send(body).expect(201)).body;
    expect(m.status).toBe('awaiting');
    expect(m.departments.map((d) => d.id).sort()).toEqual([ids.design, ids.dev].sort());
    const asked = m.participants.map((p) => [p.userId, p.role, p.status, p.department?.id ?? null]);
    expect(asked).toEqual(expect.arrayContaining([[users.designHead, 'department_head', 'pending', ids.design], [users.devHead, 'department_head', 'pending', ids.dev], [users.founder, 'founder', 'pending', null]]));
    // Nobody else is in it yet: no Branch Manager before it is fixed.
    expect(m.participants.some((p) => p.role === 'branch_manager')).toBe(false);
    for (const who of ['designHead', 'devHead', 'founder']) {
      expect(await prisma.notification.findFirst({ where: { userId: users[who], createdAt: { gte: since }, title: { contains: 'can you join' } } }), who).toBeTruthy();
    }
    const list = (await http().get('/meetings').set(as('am')).expect(200)).body as MeetingList;
    expect(list.requests.find((x) => x.id === m.id)?.can.arrange).toBe(true);
  });

  it('once all three accept it is fixed, and only the client branch Branch Manager is asked to join', async () => {
    for (const who of ['designHead', 'devHead']) m = (await http().post(`/meetings/${m.id}/respond`).set(as(who)).send({ decision: 'accept' }).expect(200)).body;
    expect(m.status).toBe('awaiting');
    m = (await http().post(`/meetings/${m.id}/respond`).set(as('founder')).send({ decision: 'accept' }).expect(200)).body;
    expect(m.status).toBe('booked');
    const bms = m.participants.filter((p) => p.role === 'branch_manager').map((p) => p.userId);
    expect(bms).toContain(users.localBm);
    expect(bms).not.toContain(users.otherBm);
    const local = (await http().get('/meetings').set(as('localBm')).expect(200)).body as MeetingList;
    const seen = local.upcoming.find((x) => x.id === m.id)!;
    expect(seen.can.join).toBe(true);
    expect(seen.can.addBranchManagers).toBe(true);
    expect(await prisma.notification.findFirst({ where: { userId: users.localBm, createdAt: { gte: since }, title: { contains: 'join now' } } })).toBeTruthy();
    expect(await prisma.notification.findFirst({ where: { userId: users.otherBm, createdAt: { gte: since }, title: { contains: 'join now' } } })).toBeNull();
  });

  it('each Department Head adds anyone from their own department; people on the client projects come first', async () => {
    const design = (await http().get(`/meetings/${m.id}/member-options`).set(as('designHead')).expect(200)).body as MeetingMemberOption[];
    const ids2 = design.map((o) => o.id);
    expect(ids2).toContain(users.worker);
    expect(ids2).toContain(users.idle); // v25: same department, even without work for this client
    expect(ids2).not.toContain(users.devWorker); // other department
    expect(design.find((o) => o.id === users.worker)?.why).toMatch(/task/);
    expect(design.find((o) => o.id === users.idle)?.why).toBeNull();
    expect(ids2.indexOf(users.worker)).toBeLessThan(ids2.indexOf(users.idle));
    const dev = (await http().get(`/meetings/${m.id}/member-options`).set(as('devHead')).expect(200)).body as MeetingMemberOption[];
    expect(dev.map((o) => o.id)).toEqual([users.devWorker]);
    await http().post(`/meetings/${m.id}/members`).set(as('designHead')).send({ userIds: [users.devWorker] }).expect(400);
    await http().get(`/meetings/${m.id}/member-options`).set(as('am')).expect(403);
    m = (await http().post(`/meetings/${m.id}/members`).set(as('designHead')).send({ userIds: [users.worker] }).expect(200)).body;
    expect(m.participants.find((p) => p.userId === users.worker)).toMatchObject({ role: 'member', addedBy: 'Arjun Das' });
  });

  it("another branch's Branch Manager is added only by the Client Manager or the client's Branch Manager", async () => {
    // Other people cannot.
    await http().get(`/meetings/${m.id}/branch-manager-options`).set(as('designHead')).expect(403);
    await http().post(`/meetings/${m.id}/branch-managers`).set(as('otherBm')).send({ userIds: [users.otherBm] }).expect((r) => expect([403, 404]).toContain(r.status));
    // The client's Branch Manager can.
    const opts = (await http().get(`/meetings/${m.id}/branch-manager-options`).set(as('localBm')).expect(200)).body as MeetingBranchManagerOption[];
    expect(opts.find((o) => o.id === users.otherBm)?.branch).toBe(`Other ${stamp}`);
    expect(opts.some((o) => o.id === users.localBm)).toBe(false);
    m = (await http().post(`/meetings/${m.id}/branch-managers`).set(as('localBm')).send({ userIds: [users.otherBm] }).expect(200)).body;
    expect(m.participants.find((p) => p.userId === users.otherBm)).toMatchObject({ role: 'branch_manager', status: 'invited', addedBy: 'Lena Local' });
    expect(await prisma.notification.findFirst({ where: { userId: users.otherBm, createdAt: { gte: since }, title: { contains: 'join now' } } })).toBeTruthy();
    // The added Branch Manager joins or ignores, but cannot add others.
    const theirs = ((await http().get('/meetings').set(as('otherBm')).expect(200)).body as MeetingList).upcoming.find((x) => x.id === m.id)!;
    expect(theirs.can.join).toBe(true);
    expect(theirs.can.addBranchManagers).toBe(false);
    m = (await http().post(`/meetings/${m.id}/join`).set(as('otherBm')).send({ decision: 'join' }).expect(200)).body;
    expect(m.participants.find((p) => p.userId === users.otherBm)?.status).toBe('joined');
    // The Client Manager can add too (nobody left to add here).
    expect(((await http().get(`/meetings/${m.id}/branch-manager-options`).set(as('am')).expect(200)).body as MeetingBranchManagerOption[]).some((o) => o.id === users.otherBm)).toBe(false);
  });

  it('a client request is arranged with several departments too', async () => {
    const owner = await prisma.role.findFirstOrThrow({ where: { orgId, baseRole: 'client_owner', isCustom: false } });
    const email = `v24.client.${stamp}@example.com`;
    const u = await prisma.user.create({ data: { orgId, type: 'client', name: 'Cara Client', email, status: 'active', roles: { create: { roleId: owner.id } } } });
    await prisma.clientUser.create({ data: { userId: u.id, orgId, clientOrgId: ids.client, clientRole: 'client_owner', brandScope: [] } });
    tokens.client = await signIn(email);
    let r = (await http().post('/client/meetings/request').set(as('client')).send({ startAt: zonedTimeToUtc(day, `17:${mm}`, 'Asia/Kolkata'), timeZone: 'Asia/Kolkata', durationMin: 30, requirements: 'Design and development review' }).expect(201)).body as MeetingView;
    r = (await http().post(`/meetings/${r.id}/arrange`).set(as('am')).send({ departmentIds: [ids.design, ids.dev] }).expect(200)).body;
    expect(r.status).toBe('awaiting');
    expect(r.participants.filter((p) => p.role === 'department_head').map((p) => p.department?.id).sort()).toEqual([ids.design, ids.dev].sort());
    // Asking again with one department drops the other head and keeps the answer of the one still asked.
    await http().post(`/meetings/${r.id}/respond`).set(as('designHead')).send({ decision: 'accept' }).expect(200);
    r = (await http().post(`/meetings/${r.id}/arrange`).set(as('am')).send({ departmentIds: [ids.design] }).expect(200)).body;
    expect(r.participants.filter((p) => p.role === 'department_head').map((p) => [p.userId, p.status])).toEqual([[users.designHead, 'accepted']]);
  });

  it('two departments: one head asks for another time; the Client Manager moves it the same day and tells the client why', async () => {
    const start = zonedTimeToUtc(day, `11:${mm}`, 'Asia/Kolkata');
    let r = (await http().post('/meetings').set(as('am')).send({ title: `Two teams ${stamp}`, startAt: start, durationMin: 45, clientOrgId: ids.client, departmentIds: [ids.design, ids.dev], addMeet: false }).expect(201)).body as MeetingView;
    await http().post(`/meetings/${r.id}/respond`).set(as('designHead')).send({ decision: 'accept' }).expect(200);
    const later = zonedTimeToUtc(day, `14:${mm}`, 'Asia/Kolkata');
    r = (await http().post(`/meetings/${r.id}/respond`).set(as('devHead')).send({ decision: 'reschedule', proposedStartAt: later, note: 'Release in the morning' }).expect(200)).body;
    expect(r.status).toBe('awaiting');
    expect(await prisma.notification.findFirst({ where: { userId: users.am, createdAt: { gte: since }, title: { contains: 'asks to move' }, body: { contains: 'Release in the morning' } } })).toBeTruthy();
    // Same day only, and a reason is required.
    const nextDay = new Date(new Date(later).getTime() + 86_400_000).toISOString();
    await http().post(`/meetings/${r.id}/fix`).set(as('am')).send({ startAt: nextDay, reason: 'Release in the morning' }).expect(400);
    await http().post(`/meetings/${r.id}/fix`).set(as('am')).send({ startAt: later }).expect(400);
    r = (await http().post(`/meetings/${r.id}/fix`).set(as('am')).send({ startAt: later, reason: 'Our developers have a release in the morning' }).expect(200)).body;
    expect(r.status).toBe('booked');
    expect(r.startAt).toBe(later);
    expect(r.rescheduleReason).toBe('Our developers have a release in the morning');
    // The client (Cara, from the request above) gets the apology with the reason, in the app and by email.
    const cara = await prisma.user.findFirstOrThrow({ where: { email: `v24.client.${stamp}@example.com` } });
    const sorry = await prisma.notification.findFirst({ where: { userId: cara.id, createdAt: { gte: since }, title: 'Sorry, we had to move your meeting' }, orderBy: { createdAt: 'desc' } });
    expect(sorry?.body).toContain('Reason: Our developers have a release in the morning');
    expect(await prisma.emailOutbox.findFirst({ where: { toEmail: `v24.client.${stamp}@example.com`, createdAt: { gte: since }, text: { contains: 'Reason: Our developers have a release in the morning' } } })).toBeTruthy();
    const mine = ((await http().get('/client/meetings').set(as('client')).expect(200)).body as MeetingList).upcoming.find((x) => x.id === r.id)!;
    expect(mine.rescheduleReason).toBe('Our developers have a release in the morning');
    // The head who had accepted the old time hears it moved, and why.
    expect(await prisma.notification.findFirst({ where: { userId: users.designHead, createdAt: { gte: since }, title: { startsWith: 'Meeting moved' }, body: { contains: 'release in the morning' } } })).toBeTruthy();
  });
});

describe('15-minute reminder and ended meetings', () => {
  it('everyone taking part hears 15 minutes before, with the link; people not coming do not', async () => {
    const soon = new Date(Date.now() + 12 * 60_000);
    const r = (await http().post('/meetings').set(as('am')).send({ title: `Soon ${stamp}`, startAt: new Date(Date.now() + 2 * 86_400_000).toISOString(), durationMin: 30, clientOrgId: ids.client, attendeeIds: [users.worker], addMeet: false }).expect(201)).body as MeetingView;
    // Bring it forward to start in 12 minutes, with a link, and have the Branch Manager ignore it.
    await prisma.meeting.update({ where: { id: r.id }, data: { startAt: soon, endAt: new Date(soon.getTime() + 30 * 60_000), joinUrl: 'https://meet.google.com/soo-nnnn-mmm', reminderAt: null, soonReminderAt: null } });
    await http().post(`/meetings/${r.id}/join`).set(as('localBm')).send({ decision: 'ignore' }).expect(200);
    const svc = app.get(MeetingsService);
    await svc.remindSoon(); // the app's own minute job may have sent it already: either way it goes out once
    const got = async (userId: string) => prisma.notification.findFirst({ where: { userId, createdAt: { gte: since }, title: { contains: `Soon ${stamp}` }, body: { contains: 'meet.google.com/soo-nnnn-mmm' } } });
    expect(await got(users.am), 'host').toBeTruthy();
    expect(await got(users.worker), 'team member').toBeTruthy();
    expect(await got(users.localBm), 'Branch Manager who ignored').toBeNull();
    const cara = await prisma.user.findFirstOrThrow({ where: { email: `v24.client.${stamp}@example.com` } });
    expect(await prisma.notification.findFirst({ where: { userId: cara.id, createdAt: { gte: since }, title: { startsWith: 'Your meeting starts in' }, body: { contains: 'meet.google.com/soo-nnnn-mmm' } } })).toBeTruthy();
    expect(await prisma.emailOutbox.findFirst({ where: { toEmail: cara.email!, createdAt: { gte: since }, subject: { contains: `Soon ${stamp}` } } })).toBeTruthy();
    // Sent once; and the hour reminder does not also go out right before it.
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: r.id } })).soonReminderAt).toBeTruthy();
    await svc.remindSoon();
    await svc.remind();
    expect(await prisma.notification.count({ where: { userId: users.worker, createdAt: { gte: since }, title: { startsWith: 'In ', endsWith: `: Soon ${stamp}` } } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: users.worker, createdAt: { gte: since }, title: `Starting soon: Soon ${stamp}` } })).toBe(0);
  });

  it('once a meeting ends its link is closed and it is in Past as completed', async () => {
    const r = (await http().post('/meetings').set(as('am')).send({ title: `Ended ${stamp}`, startAt: new Date(Date.now() + 2 * 86_400_000).toISOString(), durationMin: 30, clientOrgId: ids.client, attendeeIds: [users.worker], addMeet: false }).expect(201)).body as MeetingView;
    await prisma.meeting.update({ where: { id: r.id }, data: { joinUrl: 'https://meet.google.com/end-dddd-ddd' } });
    const live = ((await http().get('/meetings').set(as('worker')).expect(200)).body as MeetingList).upcoming.find((x) => x.id === r.id)!;
    expect(live.joinUrl).toBe('https://meet.google.com/end-dddd-ddd');
    expect(live.ended).toBe(false);
    // It took place an hour ago.
    await prisma.meeting.update({ where: { id: r.id }, data: { startAt: new Date(Date.now() - 90 * 60_000), endAt: new Date(Date.now() - 60 * 60_000) } });
    for (const who of ['worker', 'am', 'client']) {
      const list = (await http().get(who === 'client' ? '/client/meetings' : '/meetings').set(as(who)).expect(200)).body as MeetingList;
      expect(list.upcoming.some((x) => x.id === r.id), who).toBe(false);
      const past = list.past.find((x) => x.id === r.id)!;
      expect(past, who).toBeTruthy();
      expect(past.ended).toBe(true);
      expect(past.joinUrl).toBeNull();
      expect(past.joinAs).toBeNull();
      expect(past.can.shareLink).toBe(false);
      expect(past.can.join).toBe(false);
    }
  });
});
