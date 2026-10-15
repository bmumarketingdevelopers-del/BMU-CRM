// v10 team flows: sign-in for every role, users & permissions, leave approval chain & cover, timesheets,
// onboarding/offboarding, global search, activity feed, settings that take effect, catalogue versions,
// SOP publishing, the creator brief → payout loop and branding.
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { istDate } from '@bmu/shared';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

let app: INestApplication;
let prisma: PrismaService;
const tokens: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const stamp = Date.now();
const mail = (who: string) => `team.${who}.${stamp}@example.com`;
let orgId: string;
let savedSettings: unknown;
const DAY = 86_400_000;
const today = istDate(new Date());
const addDays = (ymd: string, n: number) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() + n * DAY).toISOString().slice(0, 10);
/** Next Monday at least `weeks` weeks ahead (a clean working week, clear of seeded leave). */
const futureMonday = (weeks: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  const add = ((8 - d.getUTCDay()) % 7 || 7) + 7 * weeks;
  return addDays(today, add);
};

async function signIn(identifier: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier, code: otp.body.devCode }).expect(200)).body.token as string;
}
const role = (baseRole: string) => prisma.role.findFirstOrThrow({ where: { orgId, baseRole, isCustom: false } });
const userId = async (email: string) => (await prisma.user.findFirstOrThrow({ where: { email } })).id;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  prisma = app.get(PrismaService);
  const org = await prisma.organisation.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  orgId = org.id;
  savedSettings = org.settings;
  for (const who of ['founder', 'admin', 'hr', 'design.head', 'am.lead', 'producer', 'finance', 'am', 'creator']) tokens[who] = await signIn(`${who}@bmu.demo`);
  tokens.client = await signIn('client@sunrise.demo');
});

afterAll(async () => {
  // Put settings back and keep test staff out of other specs' assignment pools.
  await prisma.organisation.update({ where: { id: orgId }, data: { settings: savedSettings as object } });
  await prisma.user.updateMany({ where: { email: { contains: `.${stamp}@example.com` } }, data: { deletedAt: new Date(), status: 'suspended' } });
  await app.close();
});

describe('sign in', () => {
  it('lands every role on the right home', async () => {
    const homes: Record<string, string> = { founder: 'staff', hr: 'staff', 'design.head': 'staff', 'am.lead': 'staff', producer: 'staff', finance: 'staff', creator: 'creator', client: 'client' };
    for (const [who, type] of Object.entries(homes)) {
      const me = await http().get('/auth/me').set(as(who)).expect(200);
      expect(me.body.type).toBe(type);
    }
  });

  it('signs in with a mobile number in any common format', async () => {
    const token = await signIn('98000 00003');
    const me = await http().get('/auth/me').set({ Authorization: `Bearer ${token}` }).expect(200);
    expect(me.body.email).toBe('hr@bmu.demo');
    await signIn('+91 9800000006');
  });

  it('explains wrong codes, unknown accounts and expired sessions in plain words', async () => {
    await http().post('/auth/otp/request').send({ identifier: 'producer@bmu.demo' }).expect(200);
    const wrong = await http().post('/auth/otp/verify').send({ identifier: 'producer@bmu.demo', code: '000001' }).expect(400);
    expect(wrong.body.message).toBe('That code is not right');
    const unknown = await http().post('/auth/otp/request').send({ identifier: 'nobody.here@example.com' }).expect(404);
    expect(unknown.body.message).toMatch(/No BMU account/);
    await http().post('/auth/otp/request').send({ identifier: 'not an email' }).expect(400);
    const expired = await new JwtService({ secret: process.env.JWT_SECRET ?? 'dev-only-change-me' }).signAsync({ sub: await userId('producer@bmu.demo'), org: orgId, exp: Math.floor(Date.now() / 1000) - 60 });
    const r = await http().get('/auth/me').set({ Authorization: `Bearer ${expired}` }).expect(401);
    expect(r.body.message).toMatch(/session has expired/);
  });

  it('gives the OWNER_EMAIL a Founder login', async () => {
    const owner = process.env.OWNER_EMAIL?.trim().toLowerCase();
    if (!owner) return;
    const token = await signIn(owner);
    const me = await http().get('/auth/me').set({ Authorization: `Bearer ${token}` }).expect(200);
    expect(me.body.roles).toContain('founder');
  });
});

describe('users, roles and permissions', () => {
  let invitedId: string;

  it('the Founder invites a team member who can then sign in; other HR members use Add person (approval)', async () => {
    const producerRole = await role('producer');
    await http().post('/org/users').set(as('hr')).send({ name: 'Invited Person', email: mail('invited'), roleId: producerRole.id }).expect(403);
    await http().post('/org/users').set(as('founder')).send({ name: 'Bad Phone', phone: '12345', roleId: producerRole.id }).expect(400);
    const r = await http().post('/org/users').set(as('founder')).send({ name: 'Invited Person', email: mail('invited'), roleId: producerRole.id, managerId: await userId('design.head@bmu.demo') }).expect(201);
    invitedId = r.body.id;
    expect(r.body.status).toBe('invited');
    tokens.invited = await signIn(mail('invited'));
    expect((await prisma.user.findUniqueOrThrow({ where: { id: invitedId } })).status).toBe('active');
  });

  it('edits role, department and manager; HR cannot change roles; loops are refused', async () => {
    const dept = await prisma.department.findFirstOrThrow({ where: { orgId, deletedAt: null } });
    await http().patch(`/org/users/${invitedId}`).set(as('hr')).send({ roleId: (await role('qc_reviewer')).id }).expect(403);
    const r = await http().patch(`/org/users/${invitedId}`).set(as('founder')).send({ roleId: (await role('qc_reviewer')).id, departmentId: dept.id }).expect(200);
    expect(r.body.roles[0].baseRole).toBe('qc_reviewer');
    expect(r.body.departmentId).toBe(dept.id);
    const hrId = await userId('hr@bmu.demo');
    await http().patch(`/org/users/${hrId}`).set(as('founder')).send({ managerId: invitedId }).expect(200);
    await http().patch(`/org/users/${invitedId}`).set(as('founder')).send({ managerId: hrId }).expect(400);
    await http().patch(`/org/users/${hrId}`).set(as('founder')).send({ managerId: await userId('admin@bmu.demo') }).expect(200);
    await http().patch(`/org/users/${await userId('founder@bmu.demo')}`).set(as('founder')).send({ status: 'suspended' }).expect(400);
  });

  it('suspends (session stops working, no new codes) and reactivates', async () => {
    await http().patch(`/org/users/${invitedId}`).set(as('hr')).send({ status: 'suspended' }).expect(200);
    await http().get('/auth/me').set(as('invited')).expect(401);
    await http().post('/auth/otp/request').send({ identifier: mail('invited') }).expect(404);
    await http().patch(`/org/users/${invitedId}`).set(as('hr')).send({ status: 'active' }).expect(200);
    tokens.invited = await signIn(mail('invited'));
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: invitedId, action: 'user.reactivated' } });
    expect(audit.actorId).toBe(await userId('hr@bmu.demo'));
  });

  it('matrix edits change access on the next request, and roles can be cloned', async () => {
    const qc = await role('qc_reviewer');
    const before = await prisma.permission.findUnique({ where: { roleId_capability: { roleId: qc.id, capability: 'leads_pipeline' } } });
    await http().get('/leads').set(as('invited')).expect(403);
    await http().patch(`/org/roles/${qc.id}/permissions`).set(as('hr')).send({ capability: 'leads_pipeline', scope: 'all' }).expect(403);
    await http().patch(`/org/roles/${qc.id}/permissions`).set(as('founder')).send({ capability: 'leads_pipeline', scope: 'all' }).expect(200);
    await http().get('/leads').set(as('invited')).expect(200);
    await http().patch(`/org/roles/${qc.id}/permissions`).set(as('founder')).send({ capability: 'leads_pipeline', scope: before?.scope ?? 'none' }).expect(200);
    if (before) await prisma.permission.update({ where: { roleId_capability: { roleId: qc.id, capability: 'leads_pipeline' } }, data: { rule: before.rule } });
    await http().get('/leads').set(as('invited')).expect(403);
    const clone = await http().post(`/org/roles/${qc.id}/clone`).set(as('founder')).send({ name: `QC custom ${stamp}` }).expect(201);
    expect(clone.body).toMatchObject({ isCustom: true, baseRole: 'qc_reviewer' });
    await prisma.role.delete({ where: { id: clone.body.id } });
  });
});

describe('leave approval chain and cover', () => {
  let managerToken: string;
  let staffId: string;
  let managerId: string;

  beforeAll(async () => {
    const producerRole = await role('producer');
    managerId = (await prisma.user.create({ data: { orgId, type: 'staff', name: `Pod Lead ${stamp}`, email: mail('lead'), status: 'active', roles: { create: { roleId: producerRole.id } } } })).id;
    staffId = (await prisma.user.create({ data: { orgId, type: 'staff', name: `Leaver Test ${stamp}`, email: mail('staff'), status: 'active', managerId, roles: { create: { roleId: producerRole.id } } } })).id;
    managerToken = await signIn(mail('lead'));
    tokens.staff = await signIn(mail('staff'));
    tokens.lead = managerToken;
  });

  it('long leave: manager first, then HR; manager notified on the team Approvals page', async () => {
    const mon = futureMonday(3);
    const r = await http().post('/workspace/leave').set(as('staff')).send({ from: mon, to: addDays(mon, 4), type: 'casual', reason: 'Trip' }).expect(201);
    const req = r.body.leave.requests[0];
    expect(req).toMatchObject({ status: 'pending', stage: 'manager', days: 5 });
    const note = await prisma.notification.findFirstOrThrow({ where: { userId: managerId, kind: 'leave_request' }, orderBy: { createdAt: 'desc' } });
    expect(note.link).toBe('/team/approvals');

    const list = await http().get('/admin-org/leave').set(as('lead')).expect(200);
    expect(list.body.find((l: { id: string }) => l.id === req.id).canDecide).toBe(true);
    const step1 = await http().post(`/admin-org/leave/${req.id}/decide`).set(as('lead')).send({ decision: 'approve' }).expect(201);
    expect(step1.body).toMatchObject({ status: 'pending', stage: 'hr' });
    await http().post(`/admin-org/leave/${req.id}/decide`).set(as('lead')).send({ decision: 'approve' }).expect(403);
    const mine = await http().get('/workspace/profile').set(as('staff')).expect(200);
    expect(mine.body.leave.requests[0]).toMatchObject({ stage: 'hr', waitingOn: 'HR' });

    // A task due during the leave gets flagged to the manager for cover.
    const task = await prisma.task.create({ data: { orgId, title: `Cover me ${stamp}`, ownerId: staffId, deadline: new Date(`${addDays(mon, 2)}T15:00:00+05:30`) } });
    const ok = await http().post(`/admin-org/leave/${req.id}/decide`).set(as('hr')).send({ decision: 'approve' }).expect(201);
    expect(ok.body).toMatchObject({ status: 'approved', stage: 'done', tasksDuringLeave: 1 });
    const cover = await prisma.notification.findFirstOrThrow({ where: { userId: managerId, kind: 'leave_cover' } });
    expect(cover.link).toBe(`/team/leave/${req.id}/cover`);

    const c = await http().get(`/team-flows/leave/${req.id}/cover`).set(as('lead')).expect(200);
    expect(c.body.tasks.map((t: { id: string }) => t.id)).toEqual([task.id]);
    await http().get(`/team-flows/leave/${req.id}/cover`).set(as('producer')).expect(403);
    await http().post(`/team-flows/leave/${req.id}/reassign`).set(as('lead')).send({ taskIds: [task.id], toUserId: staffId }).expect(400);
    const moved = await http().post(`/team-flows/leave/${req.id}/reassign`).set(as('lead')).send({ taskIds: [task.id], toUserId: await userId('producer@bmu.demo') }).expect(200);
    expect(moved.body.tasks).toHaveLength(0);
    await prisma.task.update({ where: { id: task.id }, data: { status: 'cancelled' } });

    const out = await http().get(`/team-flows/leave/out?from=${mon}&to=${addDays(mon, 6)}`).set(as('producer')).expect(200);
    expect(out.body[0].people.some((p: { id: string }) => p.id === staffId)).toBe(true);
    const profile = await http().get('/workspace/profile').set(as('staff')).expect(200);
    expect(profile.body.leave.balance[0]).toMatchObject({ type: 'casual', used: 5 });
  });

  it('short leave is final with the manager; rejection is final at any stage', async () => {
    const mon = futureMonday(5);
    const a = (await http().post('/workspace/leave').set(as('staff')).send({ from: mon, to: mon, type: 'sick' }).expect(201)).body.leave.requests[0];
    const r1 = await http().post(`/admin-org/leave/${a.id}/decide`).set(as('lead')).send({ decision: 'approve' }).expect(201);
    expect(r1.body.status).toBe('approved');
    const b = (await http().post('/workspace/leave').set(as('staff')).send({ from: addDays(mon, 1), to: addDays(mon, 1), type: 'sick' }).expect(201)).body.leave.requests.find((x: { from: string }) => x.from === addDays(mon, 1));
    const r2 = await http().post(`/admin-org/leave/${b.id}/decide`).set(as('lead')).send({ decision: 'reject', note: 'Deadline week' }).expect(201);
    expect(r2.body).toMatchObject({ status: 'rejected', decisionNote: 'Deadline week' });
  });
});

describe('timesheets', () => {
  let taskId: string;
  let sheetId: string;
  const lastMonday = addDays(today, -(((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7)));

  beforeAll(async () => {
    taskId = (await prisma.task.create({ data: { orgId, title: `Timesheet task ${stamp}`, ownerId: await userId(mail('staff')), deadline: new Date(Date.now() + 3 * DAY) } })).id;
  });

  it('builds the week from task time logs plus manual entries', async () => {
    await http().patch(`/tasks/${taskId}`).set(as('staff')).send({ logMinutes: 90 }).expect(200);
    const w = await http().post('/team-flows/timesheets/entries').set(as('staff')).send({ date: today, minutes: 30, category: 'admin', note: 'Inbox' }).expect(201);
    expect(w.body.weekStart).toBe(lastMonday);
    expect(w.body.totalMinutes).toBe(120);
    expect(w.body.entries.map((e: { source: string }) => e.source).sort()).toEqual(['manual', 'task_log']);
    await http().post('/team-flows/timesheets/entries').set(as('staff')).send({ date: addDays(today, 2), minutes: 30, category: 'admin' }).expect(400);
    await http().post('/team-flows/timesheets/entries').set(as('staff')).send({ date: today, minutes: 30, category: 'task' }).expect(400);
  });

  it('submit → manager returns with a comment → resubmit → approve', async () => {
    const s = await http().post('/team-flows/timesheets/submit').set(as('staff')).send({ weekStart: lastMonday }).expect(200);
    expect(s.body.status).toBe('submitted');
    sheetId = s.body.id;
    await http().post('/team-flows/timesheets/entries').set(as('staff')).send({ date: today, minutes: 15, category: 'meeting' }).expect(409);
    const queue = await http().get('/team-flows/timesheets/approvals').set(as('lead')).expect(200);
    expect(queue.body.map((r: { id: string }) => r.id)).toContain(sheetId);
    await http().post(`/team-flows/timesheets/${sheetId}/decide`).set(as('producer')).send({ decision: 'approve' }).expect(403);
    await http().post(`/team-flows/timesheets/${sheetId}/decide`).set(as('lead')).send({ decision: 'return' }).expect(400);
    const back = await http().post(`/team-flows/timesheets/${sheetId}/decide`).set(as('lead')).send({ decision: 'return', comment: 'Add the client call' }).expect(200);
    expect(back.body).toMatchObject({ status: 'returned', comment: 'Add the client call' });
    // The client call is tagged to a client; its hours reach that client's profitability only once approved.
    const listed = (await http().get(`/analytics/profitability?from=${lastMonday}&to=${today}`).set(as('founder')).expect(200)).body.clients.map((c: { id: string }) => c.id) as string[];
    const eng = await prisma.engagement.findFirstOrThrow({ where: { clientOrgId: { in: listed } }, select: { id: true, clientOrgId: true } });
    await http().post('/team-flows/timesheets/entries').set(as('staff')).send({ date: today, minutes: 30, category: 'meeting', note: 'Client call', engagementId: 'nope' }).expect(400);
    await http().post('/team-flows/timesheets/entries').set(as('staff')).send({ date: today, minutes: 30, category: 'meeting', note: 'Client call', engagementId: eng.id }).expect(201);
    await http().post('/team-flows/timesheets/submit').set(as('staff')).send({ weekStart: lastMonday }).expect(200);
    const hoursFor = async () =>
      ((await http().get(`/analytics/profitability?from=${lastMonday}&to=${today}`).set(as('founder')).expect(200)).body.clients.find((c: { id: string }) => c.id === eng.clientOrgId)?.hours as number | undefined) ?? 0;
    const beforeApproval = await hoursFor();
    const ok = await http().post(`/team-flows/timesheets/${sheetId}/decide`).set(as('lead')).send({ decision: 'approve' }).expect(200);
    expect((await hoursFor()) - beforeApproval).toBeCloseTo(0.5, 1);
    expect(ok.body).toMatchObject({ status: 'approved', totalMinutes: 150, canEdit: false });
    const note = await prisma.notification.findFirstOrThrow({ where: { userId: await userId(mail('staff')), kind: 'timesheet_decided' }, orderBy: { createdAt: 'desc' } });
    expect(note.title).toMatch(/approved/);
    await http().get(`/team-flows/timesheets/week?userId=${await userId(mail('staff'))}`).set(as('producer')).expect(403);
  });
});

describe('onboarding and offboarding', () => {
  let processId: string;
  let sopId: string;

  it('a new hire is onboarded with SOPs to read (by the Founder: other HR members add people through approval); the hire acknowledges them', async () => {
    const sop = await prisma.sOP.findFirstOrThrow({ where: { orgId, status: 'published' } });
    sopId = sop.id;
    await http().post('/team-flows/people/onboarding').set(as('producer')).send({ newHire: { name: 'Nope', email: mail('nope'), roleId: (await role('producer')).id } }).expect(403);
    await http().post('/team-flows/people/onboarding').set(as('hr')).send({ newHire: { name: 'Nope', email: mail('nope2'), roleId: (await role('producer')).id } }).expect(403);
    const r = await http()
      .post('/team-flows/people/onboarding')
      .set(as('founder'))
      .send({ newHire: { name: `New Hire ${stamp}`, email: mail('hire'), roleId: (await role('producer')).id }, buddyId: await userId('producer@bmu.demo'), sopIds: [sop.id] })
      .expect(201);
    processId = r.body.id;
    expect(r.body.items.find((i: { key: string }) => i.key === 'buddy_assigned').done).toBe(true);
    expect(r.body.items.find((i: { key: string }) => i.key === 'hub_login').done).toBe(false);
    tokens.hire = await signIn(mail('hire'));
    const mine = await http().get('/team-flows/people/mine').set(as('hire')).expect(200);
    expect(mine.body[0].items.find((i: { key: string }) => i.key === 'hub_login').done).toBe(true);
    await http().post(`/team-flows/people/${processId}/tick`).set(as('hr')).send({ key: `sop_${sop.id}`, done: true }).expect(400);
    await http().post(`/team-flows/sops/${sop.id}/acknowledge`).set(as('hire')).expect(200);
    const after = await http().get(`/team-flows/people/${processId}`).set(as('hr')).expect(200);
    expect(after.body.items.find((i: { key: string }) => i.key === `sop_${sop.id}`).done).toBe(true);
    const detail = await http().get(`/workspace/sops/${sop.id}`).set(as('hire')).expect(200);
    expect(detail.body.acknowledgedVersion).toBe(sop.version);
  });

  it('cannot complete with open items; completes once everything is ticked', async () => {
    await http().post(`/team-flows/people/${processId}/complete`).set(as('hr')).expect(400);
    const p = (await http().get(`/team-flows/people/${processId}`).set(as('hr')).expect(200)).body;
    for (const it of p.items.filter((i: { done: boolean }) => !i.done)) await http().post(`/team-flows/people/${processId}/tick`).set(as('hr')).send({ key: it.key, done: true }).expect(200);
    const done = await http().post(`/team-flows/people/${processId}/complete`).set(as('hr')).expect(200);
    expect(done.body).toMatchObject({ status: 'done', progressPct: 100 });
    await http().get(`/team-flows/people/${processId}`).set(as('design.head')).expect(200);
    await http().get(`/team-flows/people/${processId}`).set(as('am')).expect(403);
  });

  it('offboarding hands over tasks, clients and leads, then suspends access on the last day', async () => {
    const amRole = await role('account_manager');
    const leaver = await prisma.user.create({ data: { orgId, type: 'staff', name: `Leaving CM ${stamp}`, email: mail('leaver'), status: 'active', roles: { create: { roleId: amRole.id } } } });
    tokens.leaver = await signIn(mail('leaver'));
    const task = await prisma.task.create({ data: { orgId, title: `Leaver task ${stamp}`, ownerId: leaver.id, deadline: new Date(Date.now() + 2 * DAY) } });
    const client = await prisma.clientOrg.create({ data: { orgId, name: `Leaver Client ${stamp}`, amUserId: leaver.id } });
    const lead = await prisma.lead.create({ data: { orgId, source: 'test', contact: { name: 'L', company: `Leaver Lead ${stamp}` }, need: 'x', ownerId: leaver.id } });
    // v11: login stops at the end of the last day, so a last day of yesterday suspends straight away.
    const r = await http().post('/team-flows/people/offboarding').set(as('hr')).send({ userId: leaver.id, lastDay: istDate(new Date(Date.now() - DAY)) }).expect(201);
    const id = r.body.id;
    expect(r.body.openWork.tasks).toHaveLength(1);
    expect(r.body.openWork.clients).toHaveLength(1);
    expect(r.body.openWork.leads).toHaveLength(1);
    // Last day was yesterday, so access is suspended straight away.
    await http().get('/auth/me').set(as('leaver')).expect(401);
    expect(r.body.items.find((i: { key: string }) => i.key === 'access_suspended').done).toBe(true);

    const amId = await userId('am@bmu.demo');
    await http().post(`/team-flows/people/${id}/reassign`).set(as('hr')).send({ kind: 'clients', ids: [client.id], toUserId: await userId('producer@bmu.demo') }).expect(400);
    await http().post(`/team-flows/people/${id}/reassign`).set(as('hr')).send({ kind: 'tasks', ids: [task.id], toUserId: amId }).expect(200);
    await http().post(`/team-flows/people/${id}/reassign`).set(as('hr')).send({ kind: 'clients', ids: [client.id], toUserId: amId }).expect(200);
    const last = await http().post(`/team-flows/people/${id}/reassign`).set(as('hr')).send({ kind: 'leads', ids: [lead.id], toUserId: amId }).expect(200);
    expect(last.body.openWork).toEqual({ tasks: [], clients: [], leads: [] });
    expect(last.body.items.filter((i: { group: string; key: string }) => i.group === 'handover' && i.key !== 'handover_notes').every((i: { done: boolean }) => i.done)).toBe(true);
    expect((await prisma.clientOrg.findUniqueOrThrow({ where: { id: client.id } })).amUserId).toBe(amId);
    await prisma.task.update({ where: { id: task.id }, data: { status: 'cancelled' } });
    await prisma.lead.update({ where: { id: lead.id }, data: { deletedAt: new Date() } });
    await prisma.clientOrg.update({ where: { id: client.id }, data: { deletedAt: new Date() } });
  });

  it('SOP drafts stay out of the team library until published', async () => {
    const dept = (await prisma.sOP.findUniqueOrThrow({ where: { id: sopId } })).departmentId;
    const d = await http().post('/admin-platform/sops').set(as('founder')).send({ title: `Draft SOP ${stamp}`, body: 'Step one, step two, step three.', departmentId: dept, status: 'draft' }).expect(201);
    expect(d.body.status).toBe('draft');
    const team = await http().get('/workspace/sops').set(as('producer')).expect(200);
    expect(team.body.some((s: { id: string }) => s.id === d.body.id)).toBe(false);
    await http().get(`/admin-platform/sops/${d.body.id}`).set(as('producer')).expect(404);
    await http().post(`/admin-platform/sops/${d.body.id}/status`).set(as('producer')).send({ status: 'published' }).expect(403);
    await http().post(`/admin-platform/sops/${d.body.id}/status`).set(as('founder')).send({ status: 'published' }).expect(200);
    const team2 = await http().get('/workspace/sops').set(as('producer')).expect(200);
    expect(team2.body.some((s: { id: string }) => s.id === d.body.id)).toBe(true);
    await prisma.sOP.delete({ where: { id: d.body.id } });
  });
});

describe('global search and activity', () => {
  it('returns permission-aware groups', async () => {
    const f = await http().get('/team-flows/search?q=Sunrise').set(as('founder')).expect(200);
    expect(f.body.groups.map((g: { kind: string }) => g.kind)).toContain('client');
    const p = await http().get('/team-flows/search?q=Sunrise').set(as('producer')).expect(200);
    expect(p.body.groups.map((g: { kind: string }) => g.kind)).not.toContain('client');
    expect(p.body.groups.map((g: { kind: string }) => g.kind)).not.toContain('invoice');
    const fin = await http().get('/team-flows/search?q=BMU').set(as('finance')).expect(200);
    expect(fin.body.groups.find((g: { kind: string }) => g.kind === 'invoice')?.items.length ?? 0).toBeGreaterThan(0);
    const people = await http().get('/team-flows/search?q=Priya').set(as('producer')).expect(200);
    expect(JSON.stringify(people.body)).not.toContain('@bmu.demo');
    await http().get('/team-flows/search?q=Sunrise').set(as('client')).expect(403);
    expect((await http().get('/team-flows/search?q=a').set(as('founder')).expect(200)).body.groups).toEqual([]);
  });

  it('reads the audit trail for a client, lead, engagement and invoice with plain sentences', async () => {
    const client = await prisma.clientOrg.findFirstOrThrow({ where: { orgId, name: 'Sunrise Realty Pvt Ltd' } });
    const a = await http().get(`/team-flows/activity?entity=ClientOrg&id=${client.id}`).set(as('founder')).expect(200);
    expect(a.body.items.length).toBeGreaterThan(0);
    expect(typeof a.body.items[0].summary).toBe('string');
    await http().get(`/team-flows/activity?entity=ClientOrg&id=${client.id}`).set(as('producer')).expect(403);
    await http().get(`/team-flows/activity?entity=Nope&id=${client.id}`).set(as('founder')).expect(400);
    const lead = await prisma.auditEvent.findFirstOrThrow({ where: { orgId, entity: 'Lead' } });
    const l = await http().get(`/team-flows/activity?entity=Lead&id=${lead.entityId}`).set(as('founder')).expect(200);
    expect(l.body.items.some((i: { entityId: string }) => i.entityId === lead.entityId)).toBe(true);
    const inv = await prisma.invoice.findFirstOrThrow({ where: { orgId } });
    await http().get(`/team-flows/activity?entity=Invoice&id=${inv.id}`).set(as('finance')).expect(200);
    await http().get(`/team-flows/activity?entity=Invoice&id=${inv.id}`).set(as('producer')).expect(403);
    const eng = await prisma.engagement.findFirstOrThrow({ where: { orgId, clientOrgId: client.id } });
    await http().get(`/team-flows/activity?entity=Engagement&id=${eng.id}`).set(as('am.lead')).expect(200);
  });
});

describe('settings take effect', () => {
  it('notification templates switch alerts off and change the wording', async () => {
    const all = (await http().get('/settings').set(as('founder')).expect(200)).body;
    const templates = { ...all.notificationTemplates, leave_request: { inApp: true, email: false, whatsapp: false, text: 'Please review this leave in BMU Hub.' } };
    await http().put('/admin-platform/settings/notificationTemplates').set(as('founder')).send(templates).expect(200);
    const mon = futureMonday(7);
    await http().post('/workspace/leave').set(as('staff')).send({ from: mon, to: mon, type: 'casual' }).expect(201);
    const lead = await userId(mail('lead'));
    const n1 = await prisma.notification.findFirstOrThrow({ where: { userId: lead, kind: 'leave_request' }, orderBy: { createdAt: 'desc' } });
    expect(n1.body).toBe('Please review this leave in BMU Hub.');
    await http().put('/admin-platform/settings/notificationTemplates').set(as('founder')).send({ ...templates, leave_request: { ...templates.leave_request, inApp: false } }).expect(200);
    const count = await prisma.notification.count({ where: { userId: lead, kind: 'leave_request' } });
    await http().post('/workspace/leave').set(as('staff')).send({ from: addDays(mon, 1), to: addDays(mon, 1), type: 'casual' }).expect(201);
    expect(await prisma.notification.count({ where: { userId: lead, kind: 'leave_request' } })).toBe(count);
    await http().put('/admin-platform/settings/notificationTemplates').set(as('founder')).send(all.notificationTemplates).expect(200);
  });

  it('working days change leave maths; holidays are skipped', async () => {
    const all = (await http().get('/settings').set(as('hr')).expect(200)).body;
    const sat = addDays(futureMonday(9), 5);
    await http().put('/settings/workingHours').set(as('hr')).send({ ...all.workingHours, days: [1, 2, 3, 4, 5] }).expect(200);
    const r = await http().post('/workspace/leave').set(as('staff')).send({ from: sat, to: sat, type: 'casual' }).expect(400);
    expect(r.body.message).toMatch(/days off or holidays/);
    await http().put('/settings/workingHours').set(as('hr')).send(all.workingHours).expect(200);
    await http().put('/settings/holidays').set(as('hr')).send({ list: [...all.holidays.list, { date: sat, name: 'Test holiday' }] }).expect(200);
    await http().post('/workspace/leave').set(as('staff')).send({ from: sat, to: sat, type: 'casual' }).expect(400);
    await http().put('/settings/holidays').set(as('hr')).send(all.holidays).expect(200);
    await http().put('/settings/workingHours').set(as('producer')).send(all.workingHours).expect(403);
  });

  it('shows the client app name and colours to clients', async () => {
    const all = (await http().get('/settings').set(as('founder')).expect(200)).body;
    await http().put('/admin-platform/settings/branding').set(as('founder')).send({ ...all.branding, clientAppName: 'Sunrise Hub', accent: '#336699' }).expect(200);
    const b = await http().get('/team-flows/branding').set(as('client')).expect(200);
    expect(b.body).toMatchObject({ clientAppName: 'Sunrise Hub', accent: '#336699' });
    await http().put('/admin-platform/settings/branding').set(as('founder')).send(all.branding).expect(200);
  });
});

describe('catalogue versions', () => {
  it('bundle and add-on changes create a new price book version used by new proposals', async () => {
    const before = (await http().get('/catalogue/admin').set(as('founder')).expect(200)).body;
    const bundle = before.bundles[0];
    await http().patch(`/catalogue/bundles/${bundle.key}`).set(as('admin')).send({ discountPct: bundle.discountPct + 1 }).expect(403);
    const b = await http().patch(`/catalogue/bundles/${bundle.key}`).set(as('founder')).send({ discountPct: bundle.discountPct + 1 }).expect(200);
    expect(b.body.priceBook.version).not.toBe(before.priceBook.version);
    expect(b.body.bundles.find((x: { key: string }) => x.key === bundle.key).discountPct).toBe(bundle.discountPct + 1);
    const name = `Test add-on ${stamp}`;
    const a = await http().put(`/catalogue/add-ons/${encodeURIComponent(name)}`).set(as('founder')).send({ name, priceRupees: 1500, unit: 'per item', isCustomQuote: false }).expect(200);
    expect(a.body.addOns.find((x: { name: string }) => x.name === name).pricePaise).toBe(150000);
    const pricing = await http().get('/proposals/pricing').set(as('founder')).expect(200);
    expect(pricing.body.priceBookId).toBe((await prisma.priceBook.findFirstOrThrow({ where: { orgId, status: 'active' } })).id);
    expect(pricing.body.addOns.some((x: { name: string }) => x.name === name)).toBe(true);
    await http().delete(`/catalogue/add-ons/${encodeURIComponent(name)}`).set(as('founder')).expect(200);
    const back = await http().patch(`/catalogue/bundles/${bundle.key}`).set(as('founder')).send({ discountPct: bundle.discountPct }).expect(200);
    expect(back.body.addOns.some((x: { name: string }) => x.name === name)).toBe(false);
    const versions = await http().get('/catalogue/versions').set(as('founder')).expect(200);
    expect(versions.body.filter((v: { status: string }) => v.status === 'active')).toHaveLength(1);
  });
});

describe('creator brief to payout', () => {
  it('CM briefs → creator accepts → submits → revision → approve → finance pays with TDS → creator sees it', async () => {
    const creator = await prisma.creator.findFirstOrThrow({ where: { user: { email: 'creator@bmu.demo' } } });
    const brief = await http().post('/workspace/briefs').set(as('am')).send({ creatorId: creator.id, title: `Reel ${stamp}`, brief: 'One 30 second reel for the launch.', deliverables: ['1 reel'], feeRupees: 5000 }).expect(201);
    const id = brief.body.id;
    await http().post(`/workspace/creator/briefs/${id}/submissions/link`).set(as('creator')).send({ url: 'https://example.com/v1' }).expect(400);
    await http().post(`/workspace/creator/briefs/${id}/accept`).set(as('creator')).expect(200);
    await http().post(`/workspace/creator/briefs/${id}/submissions/link`).set(as('creator')).send({ url: 'https://example.com/v1' }).expect((r) => expect([200, 201]).toContain(r.status));
    await http().post(`/workspace/briefs/${id}/feedback`).set(as('am')).send({ feedback: 'Shorter hook please' }).expect(200);
    await http().post(`/workspace/creator/briefs/${id}/submissions/link`).set(as('creator')).send({ url: 'https://example.com/v2' }).expect(201);
    const ok = await http().post(`/workspace/briefs/${id}/approve`).set(as('am')).expect(200);
    expect(ok.body.payout).toMatchObject({ amountPaise: 500000, tdsPaise: 50000, netPaise: 450000, status: 'pending' });
    await http().post(`/finance/payouts/${ok.body.payout.id}/pay`).set(as('am')).send({ ref: 'UTR123456' }).expect(403);
    await http().post(`/finance/payouts/${ok.body.payout.id}/pay`).set(as('finance')).send({ ref: 'UTR123456' }).expect(200);
    const mine = await http().get('/workspace/creator/payouts').set(as('creator')).expect(200);
    expect(mine.body.items.find((p: { id: string }) => p.id === ok.body.payout.id)).toMatchObject({ status: 'paid', netPaise: 450000 });
    const b = await http().get(`/workspace/creator/briefs/${id}`).set(as('creator')).expect(200);
    expect(b.body.status).toBe('paid');
    const note = await prisma.notification.findFirstOrThrow({ where: { userId: await userId('creator@bmu.demo'), kind: 'payout_paid' }, orderBy: { createdAt: 'desc' } });
    expect(note.link).toBe('/creator/payouts');
  });
});
