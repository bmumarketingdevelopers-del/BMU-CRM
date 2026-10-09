// v11 people & hierarchy actions: add person (required fields, duplicates, onboarding, invite, HR and Department
// Head rules with Admin approval, Admin role needs the Founder), edit (self contact only), move (preview, undo,
// cross-department approval, effective dates), change role (diff, rank rule, Founder for Admin), units, client pods
// and the task default-assignee hook, offboarding that can't finish while anything is open, custom roles, CSV import,
// bulk, the tree and History.
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { istDate } from '@bmu/shared';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { podDefaultAssignee } from '../src/people-actions/pod-defaults.js';

let app: INestApplication;
let prisma: PrismaService;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const stamp = Date.now();
const DAY = 86_400_000;
const today = istDate(new Date());
const inDays = (n: number) => istDate(new Date(Date.now() + n * DAY));
const mail = (k: string) => `people.${k}.${stamp}@example.com`;
let phoneSeq = 0;
const phone = () => `9${String(stamp).slice(-7)}${String(phoneSeq++).padStart(2, '0')}`;

async function signIn(email: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier: email }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier: email, code: otp.body.devCode }).expect(200)).body.token as string;
}
const role = (baseRole: string) => prisma.role.findFirstOrThrow({ where: { orgId: ids.org, baseRole, isCustom: false } });
/** Fails with the server's message when the status is not the expected one. */
const want = (code: number) => (r: request.Response) => {
  if (r.status !== code) throw new Error(`expected ${code}, got ${r.status}: ${JSON.stringify(r.body)}`);
};
const approve = (who: string, id: string, expect = 200) => http().post(`/actions/approvals/${id}/decide`).set(as(who)).send({ decision: 'approve' }).expect(expect);

/** A valid add-person body in Creative / Design (Brand Pod). */
async function body(k: string, extra: Record<string, unknown> = {}) {
  return {
    name: `People ${k} ${stamp}`,
    email: mail(k),
    phone: phone(),
    roleIds: [(await role('producer')).id],
    departmentId: ids.design,
    teamId: ids.brandPod,
    managerId: ids.head,
    branchId: ids.branch,
    joiningDate: inDays(7),
    employmentType: 'full_time',
    onboarding: { enabled: true, items: ['laptop', 'shadowing'], buddyId: ids.producer },
    ...extra,
  };
}

/** A throwaway active staff member (soft-deleted in afterAll). */
async function temp(k: string, data: Record<string, unknown> = {}, baseRole = 'producer') {
  const u = await prisma.user.create({ data: { orgId: ids.org, type: 'staff', name: `People ${k} ${stamp}`, email: mail(k), status: 'active', departmentId: ids.design, branchId: ids.branch, teamId: ids.brandPod, managerId: ids.head, roles: { create: { roleId: (await role(baseRole)).id } }, ...data } });
  ids[k] = u.id;
  return u;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  prisma = app.get(PrismaService);
  const org = await prisma.organisation.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  ids.org = org.id;
  const people: Record<string, string> = { founder: 'founder@bmu.demo', admin: 'admin@bmu.demo', hr: 'hr@bmu.demo', head: 'design.head@bmu.demo', producer: 'producer@bmu.demo', am: 'am@bmu.demo', amLead: 'am.lead@bmu.demo', strategist: 'strategist@bmu.demo', designer: 'design@bmu.demo' };
  for (const [k, email] of Object.entries(people)) {
    tokens[k] = await signIn(email);
    ids[k] = (await prisma.user.findFirstOrThrow({ where: { email } })).id;
  }
  const head = await prisma.user.findUniqueOrThrow({ where: { id: ids.head } });
  ids.design = head.departmentId!;
  ids.branch = head.branchId!;
  ids.brandPod = (await prisma.team.findFirstOrThrow({ where: { departmentId: ids.design, deletedAt: null } })).id;
  ids.strategy = (await prisma.department.findFirstOrThrow({ where: { orgId: org.id, name: 'Strategy', branchId: ids.branch } })).id;
  ids.qcDept = (await prisma.department.findFirstOrThrow({ where: { orgId: org.id, name: 'QC', branchId: ids.branch } })).id;
});

afterAll(async () => {
  const users = await prisma.user.findMany({ where: { OR: [{ email: { contains: `${stamp}` } }, { name: { contains: `${stamp}` } }] }, select: { id: true } });
  const uids = users.map((u) => u.id);
  await prisma.task.updateMany({ where: { OR: [{ title: { contains: `${stamp}` } }, { ownerId: { in: uids } }] }, data: { status: 'cancelled', archivedAt: new Date() } });
  await prisma.approvalRequest.updateMany({ where: { OR: [{ summary: { contains: `${stamp}` } }, { targetId: { in: uids } }], status: 'pending' }, data: { status: 'cancelled' } });
  await prisma.peopleScheduledChange.updateMany({ where: { userId: { in: uids }, status: 'scheduled' }, data: { status: 'cancelled' } });
  await prisma.peopleProcess.updateMany({ where: { userId: { in: uids }, status: 'open' }, data: { status: 'cancelled' } });
  await prisma.clientPod.updateMany({ where: { name: { contains: `${stamp}` } }, data: { deletedAt: new Date() } });
  await prisma.team.updateMany({ where: { name: { contains: `${stamp}` } }, data: { deletedAt: new Date() } });
  await prisma.department.updateMany({ where: { name: { contains: `${stamp}` } }, data: { deletedAt: new Date(), headUserId: null } });
  await prisma.branch.updateMany({ where: { name: { contains: `${stamp}` } }, data: { deletedAt: new Date() } });
  await prisma.user.updateMany({ where: { id: { in: uids } }, data: { deletedAt: new Date(), status: 'suspended' } });
  await app.close();
});

describe('add person', () => {
  it('shows each role as allowed or not for the person adding', async () => {
    const f = (await http().get('/people-actions/options').set(as('founder')).expect(200)).body;
    expect(f.roles.find((r: { baseRole: string }) => r.baseRole === 'admin')).toMatchObject({ assignable: true, needsApproval: false });
    const hr = (await http().get('/people-actions/options').set(as('hr')).expect(200)).body;
    expect(hr.roles.find((r: { baseRole: string }) => r.baseRole === 'admin').assignable).toBe(false);
    expect(hr.roles.find((r: { baseRole: string }) => r.baseRole === 'founder').assignable).toBe(false);
    expect(hr.roles.some((r: { baseRole: string }) => r.baseRole.startsWith('client_'))).toBe(false);
    const admin = (await http().get('/people-actions/options').set(as('admin')).expect(200)).body;
    expect(admin.roles.find((r: { baseRole: string }) => r.baseRole === 'admin')).toMatchObject({ assignable: true, needsApproval: true });
    expect(admin.can).toMatchObject({ addPerson: true, changeRole: true, addUnit: true });
    const head = (await http().get('/people-actions/options').set(as('head')).expect(200)).body;
    expect(head.can).toMatchObject({ addPerson: true, addNeedsApproval: true, changeRole: false, offboard: false });
    await http().get('/people-actions/options').set(as('producer')).expect(403);
  });

  it('needs every required field, the team when the department has teams, and a matching branch', async () => {
    const b = await body('req');
    for (const k of ['phone', 'email', 'roleIds', 'managerId', 'joiningDate', 'employmentType', 'departmentId', 'branchId']) {
      const r = await http().post('/people-actions/people').set(as('founder')).send({ ...b, [k]: undefined }).expect(400);
      expect(r.body.message).toBeTruthy();
    }
    const noTeam = await http().post('/people-actions/people').set(as('founder')).send({ ...b, teamId: null }).expect(400);
    expect(noTeam.body.message).toMatch(/team or pod/);
    await http().post('/people-actions/people').set(as('founder')).send({ ...b, phone: '12345' }).expect(400);
  });

  it('creates an invited person with roles, onboarding checklist, HR and manager tasks and an email + SMS invite', async () => {
    const b = await body('new', { roleIds: [(await role('producer')).id, (await role('qc_reviewer')).id] });
    const r = await http().post('/people-actions/people').set(as('founder')).send(b).expect(201);
    expect(r.body).toMatchObject({ outcome: 'applied' });
    ids.newbie = r.body.id;
    const u = await prisma.user.findUniqueOrThrow({ where: { id: ids.newbie }, include: { roles: true } });
    expect(u).toMatchObject({ status: 'invited', employmentType: 'full_time', teamId: ids.brandPod, managerId: ids.head, departmentId: ids.design });
    expect(u.roles).toHaveLength(2);
    expect(u.joiningDate?.toISOString().slice(0, 10)).toBe(b.joiningDate);
    const proc = await prisma.peopleProcess.findFirstOrThrow({ where: { userId: ids.newbie, kind: 'onboarding' } });
    const keys = (proc.items as { key: string }[]).map((i) => i.key);
    expect(keys).toEqual(expect.arrayContaining(['offer_letter', 'laptop_issued', 'buddy_assigned', 'shadowing']));
    expect(keys).not.toContain('workspace_account');
    const tasks = await prisma.task.findMany({ where: { title: { contains: `People new ${stamp}` } } });
    expect(tasks.map((t) => t.ownerId).sort()).toEqual([ids.hr, ids.head].sort());
    expect(await prisma.emailOutbox.count({ where: { toEmail: mail('new'), kind: 'staff_invite' } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { entity: 'User', entityId: ids.newbie, action: { in: ['user.invited', 'user.invite_sms', 'onboarding.started'] } } })).toBe(3);
    const tree = (await http().get('/people-actions/tree').set(as('founder')).expect(200)).body;
    const team = tree.branches.flatMap((x: { departments: { teams: { id: string; memberIds: string[] }[] }[] }) => x.departments).flatMap((d: { teams: { id: string; memberIds: string[] }[] }) => d.teams).find((t: { id: string }) => t.id === ids.brandPod);
    expect(team.memberIds).toContain(ids.newbie);
  });

  it('flags duplicates on email and mobile', async () => {
    const dup = await http().post('/people-actions/people').set(as('founder')).send(await body('dup', { email: mail('new') })).expect(409);
    expect(dup.body.message).toMatch(/Possible duplicate/);
    const hits = (await http().post('/people-actions/people/duplicates').set(as('hr')).send({ email: mail('new') }).expect(200)).body;
    expect(hits[0]).toMatchObject({ id: ids.newbie, match: 'email' });
  });

  it('HR adds team members but cannot give Founder, Admin or client roles, and cannot change roles', async () => {
    await http().post('/people-actions/people').set(as('hr')).send(await body('hradmin', { roleIds: [(await role('admin')).id] })).expect(403);
    const ok = await http().post('/people-actions/people').set(as('hr')).send(await body('hr')).expect(201);
    expect(ok.body.outcome).toBe('applied');
    await http().post(`/people-actions/people/${ok.body.id}/role`).set(as('hr')).send({ roleIds: [(await role('qc_reviewer')).id], effectiveDate: today, reason: 'promotion' }).expect(403);
    await http().post('/people-actions/people').set(as('producer')).send(await body('nope')).expect(403);
  });

  it("a Department Head's add goes to an Admin; only their own department", async () => {
    await http().post('/people-actions/people').set(as('head')).send(await body('headother', { departmentId: ids.strategy, teamId: null })).expect(403);
    await http().post('/people-actions/people').set(as('head')).send(await body('headlead', { roleIds: [(await role('department_head')).id] })).expect(403);
    const r = await http().post('/people-actions/people').set(as('head')).send(await body('byhead')).expect(201);
    expect(r.body.outcome).toBe('approval');
    expect(await prisma.user.count({ where: { email: mail('byhead') } })).toBe(0);
    const mine = (await http().get('/actions/approvals').set(as('admin')).expect(200)).body;
    expect(mine.some((a: { id: string }) => a.id === r.body.approval.id)).toBe(true);
    await approve('head', r.body.approval.id, 403);
    await approve('admin', r.body.approval.id);
    const u = await prisma.user.findFirstOrThrow({ where: { email: mail('byhead') } });
    expect(u.status).toBe('invited');
  });

  it("an Admin adding someone as Admin needs the Founder's approval", async () => {
    const r = await http().post('/people-actions/people').set(as('admin')).send(await body('newadmin', { roleIds: [(await role('admin')).id], departmentId: ids.qcDept, teamId: null })).expect(201);
    expect(r.body.outcome).toBe('approval');
    await approve('founder', r.body.approval.id);
    expect(await prisma.user.count({ where: { email: mail('newadmin'), roles: { some: { role: { baseRole: 'admin' } } } } })).toBe(1);
  });
});

describe('edit person', () => {
  it('lets someone change their own contact details and photo only', async () => {
    await temp('self');
    tokens.self = await signIn(mail('self'));
    const r = await http().patch(`/people-actions/people/${ids.self}`).set(as('self')).send({ phone: phone(), photoUrl: 'https://example.com/me.jpg' }).expect(200);
    expect(r.body.undo).toBeTruthy();
    await http().patch(`/people-actions/people/${ids.self}`).set(as('self')).send({ name: 'Someone else' }).expect(403);
    await http().patch(`/people-actions/people/${ids.producer}`).set(as('self')).send({ phone: phone() }).expect(403);
    const hr = await http().patch(`/people-actions/people/${ids.self}`).set(as('hr')).send({ employmentType: 'contract', joiningDate: inDays(-30) }).expect(200);
    await http().post(`/actions/undo/${hr.body.undo.token}`).set(as('hr')).expect(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ids.self } })).employmentType).toBeNull();
    await http().patch(`/people-actions/people/${ids.founder}`).set(as('hr')).send({ name: 'X Y' }).expect(403);
  });
});

describe('move person', () => {
  it('previews access changes and applies with undo (Founder / Admin)', async () => {
    await temp('mover');
    const pv = (await http().post(`/people-actions/people/${ids.mover}/move/preview`).set(as('founder')).send({ departmentId: ids.strategy, teamId: null, managerId: ids.amLead, effectiveDate: today, reason: 'Moving to strategy' }).expect(200)).body;
    expect(pv.crossDepartment).toBe(true);
    expect(pv.gains.join(' ')).toMatch(/manager/);
    expect(pv.loses.length).toBeGreaterThan(0);
    expect(pv.needsApproval).toBeNull();
    const r = (await http().post(`/people-actions/people/${ids.mover}/move`).set(as('founder')).send({ departmentId: ids.strategy, teamId: null, managerId: ids.amLead, effectiveDate: today, reason: 'Moving to strategy' }).expect(200)).body;
    expect(r.outcome).toBe('applied');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ids.mover } })).departmentId).toBe(ids.strategy);
    await http().post(`/actions/undo/${r.undo.token}`).set(as('founder')).expect(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ids.mover } })).departmentId).toBe(ids.design);
    await http().post(`/people-actions/people/${ids.mover}/move`).set(as('founder')).send({ departmentId: ids.strategy, effectiveDate: today }).expect(400);
    await http().post(`/people-actions/people/${ids.mover}/move`).set(as('founder')).send({ departmentId: ids.design, teamId: ids.brandPod, managerId: ids.mover, effectiveDate: today, reason: 'loop' }).expect(400);
  });

  it('Department Head moves within their department; across departments needs an Admin', async () => {
    const within = (await http().post(`/people-actions/people/${ids.mover}/move`).set(as('head')).send({ departmentId: ids.design, teamId: null, managerId: ids.head, effectiveDate: today, reason: 'Out of the pod' }).expect(200)).body;
    expect(within.outcome).toBe('applied');
    const cross = (await http().post(`/people-actions/people/${ids.mover}/move`).set(as('head')).send({ departmentId: ids.strategy, teamId: null, managerId: ids.amLead, effectiveDate: today, reason: 'Strategy needs help' }).expect(200)).body;
    expect(cross.outcome).toBe('approval');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ids.mover } })).departmentId).toBe(ids.design);
    await approve('admin', cross.approval.id);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ids.mover } })).departmentId).toBe(ids.strategy);
    // Now outside the head's department: they can't move them any more.
    const no = await http().post(`/people-actions/people/${ids.mover}/move`).set(as('head')).send({ departmentId: ids.design, teamId: null, effectiveDate: today, reason: 'Back please' }).expect(403);
    expect(no.body.message).toMatch(/not in your department/);
    await http().post(`/people-actions/people/${ids.mover}/move`).set(as('hr')).send({ departmentId: ids.design, effectiveDate: today, reason: 'x y z' }).expect(403);
    const hist = (await http().get(`/team-flows/activity?entity=User&id=${ids.mover}`).set(as('founder')).expect(200)).body;
    expect(hist.items.length).toBeGreaterThan(2);
  });

  it('a future effective date schedules the move; it applies on that day', async () => {
    const r = (await http().post(`/people-actions/people/${ids.mover}/move`).set(as('founder')).send({ departmentId: ids.design, teamId: ids.brandPod, managerId: ids.head, effectiveDate: inDays(5), reason: 'Back next week' }).expect(200)).body;
    expect(r.outcome).toBe('scheduled');
    const detail = (await http().get(`/people-actions/people/${ids.mover}`).set(as('founder')).expect(200)).body;
    expect(detail.scheduled).toHaveLength(1);
    await prisma.peopleScheduledChange.updateMany({ where: { userId: ids.mover, status: 'scheduled' }, data: { effectiveDate: new Date(`${today}T00:00:00Z`) } });
    const run = (await http().post('/people-actions/jobs/run').set(as('founder')).expect(200)).body;
    expect(run.applied).toBeGreaterThanOrEqual(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ids.mover } })).teamId).toBe(ids.brandPod);
    await http().post('/people-actions/jobs/run').set(as('hr')).expect(403);
  });
});

describe('change role', () => {
  it('shows the permission diff, needs a reason and applies with secondary roles', async () => {
    await temp('promo');
    const qc = await role('qc_reviewer');
    const prod = await role('producer');
    const pv = (await http().post(`/people-actions/people/${ids.promo}/role/preview`).set(as('admin')).send({ roleIds: [prod.id, qc.id], effectiveDate: today, reason: 'Also does QC' }).expect(200)).body;
    expect(pv.diff.some((d: { capability: string; change: string }) => d.capability === 'qc_pass_fail' && d.change === 'gain')).toBe(true);
    await http().post(`/people-actions/people/${ids.promo}/role`).set(as('admin')).send({ roleIds: [prod.id, qc.id], effectiveDate: today }).expect(400);
    const r = (await http().post(`/people-actions/people/${ids.promo}/role`).set(as('admin')).send({ roleIds: [prod.id, qc.id], effectiveDate: today, reason: 'Also does QC' }).expect(200)).body;
    expect(r.outcome).toBe('applied');
    expect(await prisma.userRole.count({ where: { userId: ids.promo } })).toBe(2);
    await http().post(`/people-actions/people/${ids.promo}/role`).set(as('admin')).send({ roleIds: [prod.id, qc.id], effectiveDate: today, reason: 'Same again' }).expect(400);
  });

  it('the Admin role needs the Founder; nobody but the Founder touches the Founder role; never your own', async () => {
    const adminRole = await role('admin');
    const founderRole = await role('founder');
    const r = (await http().post(`/people-actions/people/${ids.promo}/role`).set(as('admin')).send({ roleIds: [adminRole.id], effectiveDate: today, reason: 'Runs the branch' }).expect(200)).body;
    expect(r.outcome).toBe('approval');
    expect(r.approval.summary).toMatch(/Admin/);
    await approve('founder', r.approval.id);
    expect(await prisma.userRole.count({ where: { userId: ids.promo, roleId: adminRole.id } })).toBe(1);
    await http().post(`/people-actions/people/${ids.promo}/role`).set(as('admin')).send({ roleIds: [founderRole.id], effectiveDate: today, reason: 'nope nope' }).expect(403);
    await http().post(`/people-actions/people/${ids.founder}/role`).set(as('admin')).send({ roleIds: [adminRole.id], effectiveDate: today, reason: 'nope nope' }).expect(403);
    await http().post(`/people-actions/people/${ids.admin}/role`).set(as('admin')).send({ roleIds: [(await role('producer')).id], effectiveDate: today, reason: 'self' }).expect(403);
    await http().post(`/people-actions/people/${ids.promo}/role`).set(as('head')).send({ roleIds: [(await role('producer')).id], effectiveDate: today, reason: 'head' }).expect(403);
    // The old Users page route can't make someone Admin without the Founder either.
    await http().patch(`/org/users/${ids.mover}`).set(as('admin')).send({ roleId: adminRole.id }).expect(403);
  });
});

describe('branches, departments, teams and client pods', () => {
  it('creates a branch with working hours, a department with templates copied, and a team with its lead', async () => {
    await http().post('/people-actions/units').set(as('hr')).send({ kind: 'branch', name: `Branch ${stamp}`, city: 'Pune', workingHours: { start: '10:00', end: '19:00', days: [1, 2, 3, 4, 5, 6] } }).expect(403);
    await http().post('/people-actions/units').set(as('founder')).send({ kind: 'branch', name: `Branch ${stamp}`, city: 'Pune', workingHours: { start: '19:00', end: '10:00', days: [1] } }).expect(400);
    const b = (await http().post('/people-actions/units').set(as('founder')).send({ kind: 'branch', name: `Branch ${stamp}`, city: 'Pune', workingHours: { start: '10:00', end: '19:00', days: [1, 2, 3, 4, 5, 6] } }).expect(201)).body;
    expect((await prisma.branch.findUniqueOrThrow({ where: { id: b.id } })).workDays).toEqual([1, 2, 3, 4, 5, 6]);
    const flow = await prisma.flowTemplate.findFirstOrThrow({ where: { orgId: ids.org, active: true } });
    const qc = await prisma.checklistTemplate.findFirstOrThrow({ where: { orgId: ids.org, kind: 'qc' } });
    await http().post('/people-actions/units').set(as('admin')).send({ kind: 'department', name: `Dept ${stamp}`, branchId: b.id }).expect(400);
    const d = (await http().post('/people-actions/units').set(as('admin')).send({ kind: 'department', name: `Dept ${stamp}`, branchId: b.id, headUserId: ids.head, copyFlowTemplateIds: [flow.id], copyQcChecklistIds: [qc.id] }).expect(201)).body;
    expect(await prisma.flowTemplate.count({ where: { departmentId: d.id, name: flow.name } })).toBe(1);
    expect(await prisma.checklistTemplate.count({ where: { departmentId: d.id, kind: 'qc' } })).toBe(1);
    await temp('lead', { departmentId: null, teamId: null });
    const t = (await http().post('/people-actions/units').set(as('admin')).send({ kind: 'team', name: `Team ${stamp}`, departmentId: d.id, leadUserId: ids.lead }).expect(201)).body;
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ids.lead } })).teamId).toBe(t.id);
    await http().post('/people-actions/units').set(as('admin')).send({ kind: 'team', name: `Team ${stamp}`, departmentId: d.id, leadUserId: ids.lead }).expect(409);
    await prisma.flowTemplate.deleteMany({ where: { departmentId: d.id } });
    await prisma.checklistTemplate.deleteMany({ where: { departmentId: d.id } });
  });

  it('creates a client pod; new tasks for its clients default to a pod member', async () => {
    const client = await prisma.clientOrg.findFirstOrThrow({ where: { orgId: ids.org, deletedAt: null, name: 'Saffron Table Restaurants' } });
    const already = await prisma.clientPod.findFirst({ where: { deletedAt: null, clientIds: { has: client.id } } });
    if (already) await prisma.clientPod.update({ where: { id: already.id }, data: { clientIds: already.clientIds.filter((c) => c !== client.id) } });
    await http().post('/people-actions/pods').set(as('producer')).send({ name: `Pod ${stamp}`, amUserId: ids.am, strategistUserId: ids.strategist, producerIds: [ids.designer], clientIds: [client.id] }).expect(403);
    await http().post('/people-actions/pods').set(as('amLead')).send({ name: `Pod ${stamp}`, amUserId: ids.producer, strategistUserId: ids.strategist, producerIds: [ids.designer], clientIds: [client.id] }).expect(400);
    const p = (await http().post('/people-actions/pods').set(as('amLead')).send({ name: `Pod ${stamp}`, amUserId: ids.am, strategistUserId: ids.strategist, producerIds: [ids.designer], clientIds: [client.id] }).expect(want(201))).body;
    await http().post('/people-actions/pods').set(as('amLead')).send({ name: `Pod2 ${stamp}`, amUserId: ids.am, strategistUserId: ids.strategist, producerIds: [ids.designer], clientIds: [client.id] }).expect(409);
    expect(await podDefaultAssignee(prisma, ids.org, client.id, ids.design)).toBe(ids.designer);
    expect(await podDefaultAssignee(prisma, ids.org, client.id, ids.strategy)).toBe(ids.strategist);
    const eng = await prisma.engagement.findFirstOrThrow({ where: { clientOrgId: client.id, deletedAt: null } });
    const opts = (await http().get(`/tasks/form-options?engagementId=${eng.id}`).set(as('head')).expect(200)).body;
    expect(opts.engagements.find((e: { id: string }) => e.id === eng.id)?.podMemberIds).toContain(ids.designer);
    const pods = (await http().get('/people-actions/pods').set(as('founder')).expect(200)).body;
    expect(pods.find((x: { id: string }) => x.id === p.id).clients[0].name).toBe(client.name);
    await http().delete(`/people-actions/pods/${p.id}`).set(as('amLead')).expect(200);
  });
});

describe('offboarding', () => {
  it("can't finish while the person owns any open record; HR's finish needs an Admin; login stops after the last day", async () => {
    const leaver = await temp('leaver', {}, 'account_manager');
    const task = await prisma.task.create({ data: { orgId: ids.org, title: `Leaver task ${stamp}`, ownerId: leaver.id, departmentId: ids.design, deadline: new Date(Date.now() + 3 * DAY), isInternal: true } });
    const client = await prisma.clientOrg.create({ data: { orgId: ids.org, name: `Leaver client ${stamp}`, amUserId: leaver.id } });
    const lead = await prisma.lead.create({ data: { orgId: ids.org, source: 'test', contact: { name: 'L', company: `Leaver lead ${stamp}` }, need: 'x', ownerId: leaver.id } });
    const appr = await prisma.approvalRequest.create({ data: { orgId: ids.org, action: 'reassign.approval', targetType: 'task', targetId: task.id, summary: `Leaver approval ${stamp}`, requestedById: ids.producer, approverId: leaver.id, expiresAt: new Date(Date.now() + 5 * DAY) } });

    await http().post(`/people-actions/people/${leaver.id}/offboard`).set(as('head')).send({ lastDay: inDays(-1), reason: 'Resigned' }).expect(403);
    await http().post(`/people-actions/people/${leaver.id}/offboard`).set(as('hr')).send({ lastDay: inDays(-1) }).expect(400);
    const s = (await http().post(`/people-actions/people/${leaver.id}/offboard`).set(as('hr')).send({ lastDay: inDays(-1), reason: 'Resigned' }).expect(200)).body;
    expect(s.openRecords).toMatchObject({ total: 4 });
    expect(s.canConfirm).toBe(false);
    // Login is disabled at the end of the last day (yesterday) and they show as Former.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: leaver.id } })).status).toBe('suspended');

    const blocked = await http().post(`/people-actions/people/${leaver.id}/offboard/confirm`).set(as('admin')).expect(400);
    expect(blocked.body.message).toMatch(/still owns 1 open task, 1 client \(as AM\), 1 open lead, 1 approval/);
    await http().post(`/team-flows/people/${s.processId}/complete`).set(as('admin')).expect(400);

    // Hand everything over: the task through the engine, clients and leads through the v10 handover, the approval here.
    await http().post('/actions/reassign/task/apply').set(as('founder')).send({ ids: [task.id], toUserId: ids.designer, reason: 'offboarding' }).expect(want(200));
    await http().post(`/team-flows/people/${s.processId}/reassign`).set(as('hr')).send({ kind: 'clients', ids: [client.id], toUserId: ids.am }).expect(200);
    await http().post(`/team-flows/people/${s.processId}/reassign`).set(as('hr')).send({ kind: 'leads', ids: [lead.id], toUserId: ids.am }).expect(200);
    await http().post(`/people-actions/people/${leaver.id}/handover`).set(as('hr')).send({ kind: 'approvals', toUserId: ids.producer }).expect(400);
    const after = (await http().post(`/people-actions/people/${leaver.id}/handover`).set(as('hr')).send({ kind: 'approvals', toUserId: ids.head }).expect(200)).body;
    expect(after.openRecords.total).toBe(0);
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: appr.id } })).approverId).toBe(ids.head);

    // Checklist items still open block it too.
    await http().post(`/people-actions/people/${leaver.id}/offboard/confirm`).set(as('hr')).expect(400);
    const proc = (await http().get(`/team-flows/people/${s.processId}`).set(as('hr')).expect(200)).body;
    for (const it of proc.items.filter((i: { done: boolean; auto?: boolean }) => !i.done && !i.auto)) await http().post(`/team-flows/people/${s.processId}/tick`).set(as('hr')).send({ key: it.key, done: true }).expect(200);
    const hrConfirm = (await http().post(`/people-actions/people/${leaver.id}/offboard/confirm`).set(as('hr')).expect(200)).body;
    expect(hrConfirm.outcome).toBe('approval');
    await http().post(`/team-flows/people/${s.processId}/complete`).set(as('hr')).expect(400);
    await approve('admin', hrConfirm.approval.id);
    expect((await prisma.peopleProcess.findUniqueOrThrow({ where: { id: s.processId } })).status).toBe('done');
    const u = await prisma.user.findUniqueOrThrow({ where: { id: leaver.id } });
    expect(u.leftAt).toBeTruthy();
    const tree = (await http().get('/people-actions/tree').set(as('founder')).expect(200)).body;
    expect(tree.former.some((p: { id: string }) => p.id === leaver.id)).toBe(true);
    expect(tree.people.some((p: { id: string }) => p.id === leaver.id)).toBe(false);
    await prisma.approvalRequest.update({ where: { id: appr.id }, data: { status: 'cancelled' } });
    await prisma.lead.update({ where: { id: lead.id }, data: { deletedAt: new Date() } });
    await prisma.clientOrg.update({ where: { id: client.id }, data: { deletedAt: new Date() } });
  });
});

describe('custom roles, import, bulk, tree', () => {
  it("an Admin's custom role needs the Founder; the Founder creates directly", async () => {
    const prod = await role('producer');
    const r = (await http().post('/people-actions/roles').set(as('admin')).send({ name: `Senior designer ${stamp}`, cloneFromRoleId: prod.id, scopes: { leads_pipeline: 'own' } }).expect(201)).body;
    expect(r.outcome).toBe('approval');
    await approve('admin', r.approval.id, 403);
    await approve('founder', r.approval.id);
    const created = await prisma.role.findFirstOrThrow({ where: { name: `Senior designer ${stamp}` }, include: { permissions: true } });
    expect(created.isCustom).toBe(true);
    expect(created.permissions.find((p) => p.capability === 'leads_pipeline')?.scope).toBe('own');
    const f = (await http().post('/people-actions/roles').set(as('founder')).send({ name: `Lead editor ${stamp}`, cloneFromRoleId: prod.id }).expect(201)).body;
    expect(f.outcome).toBe('applied');
    await http().post('/people-actions/roles').set(as('hr')).send({ name: `HR role ${stamp}`, cloneFromRoleId: prod.id }).expect(403);
    await prisma.role.deleteMany({ where: { name: { contains: `${stamp}` } } });
  });

  it('imports people from CSV with duplicate check', async () => {
    const csv = `Full name,Email,Mobile,Role,Department,Team or pod,Reports to,Joining date,Employment type\nPeople csv1 ${stamp},${mail('csv1')},${phone()},Producer,Creative / Design,Brand Pod,design.head@bmu.demo,${inDays(10)},intern\nPeople csv2 ${stamp},${mail('new')},${phone()},Producer,Creative / Design,Brand Pod,design.head@bmu.demo,${inDays(10)},full-time\nPeople csv3 ${stamp},${mail('csv3')},${phone()},Admin,Strategy,,founder@bmu.demo,${inDays(10)},full-time\n`;
    await http().post('/imports/people').set(as('head')).send({ csv }).expect(403);
    const job = (await http().post('/imports/people').set(as('hr')).send({ csv, fileName: 'people.csv' }).expect(200)).body;
    expect(job.rows[0].ok).toBe(true);
    expect(job.rows[1].duplicate).toMatch(/already uses/);
    expect(job.rows[2].errors.join(' ')).toMatch(/HR cannot/);
    const done = (await http().post(`/imports/jobs/${job.id}/commit`).set(as('hr')).send({ skipDuplicates: true }).expect(200)).body;
    expect(done.rowsOk).toBe(1);
    expect(await prisma.user.findFirstOrThrow({ where: { email: mail('csv1') } })).toMatchObject({ status: 'invited', employmentType: 'intern' });
  });

  it('bulk moves people with one undo', async () => {
    await temp('bulk1');
    await temp('bulk2');
    const r = (await http().post('/people-actions/bulk').set(as('founder')).send({ action: 'move', userIds: [ids.bulk1, ids.bulk2], move: { departmentId: ids.design, teamId: null, effectiveDate: today, reason: 'Pod reshuffle' } }).expect(200)).body;
    expect(r.applied).toBe(2);
    expect(await prisma.user.count({ where: { id: { in: [ids.bulk1, ids.bulk2] }, teamId: null } })).toBe(2);
    await http().post(`/actions/undo/${r.undo.token}`).set(as('founder')).expect(200);
    expect(await prisma.user.count({ where: { id: { in: [ids.bulk1, ids.bulk2] }, teamId: ids.brandPod } })).toBe(2);
    const roleRes = (await http().post('/people-actions/bulk').set(as('head')).send({ action: 'add_role', userIds: [ids.bulk1], roleId: (await role('qc_reviewer')).id, effectiveDate: today, reason: 'More QC' }).expect(200)).body;
    expect(roleRes.failed).toHaveLength(1);
  });

  it('the tree shows load and leave; a Department Head sees their own department; others are kept out', async () => {
    const f = (await http().get('/people-actions/tree').set(as('founder')).expect(200)).body;
    const p = f.people.find((x: { id: string }) => x.id === ids.producer);
    expect(typeof p.loadPct).toBe('number');
    expect(f.can.addUnit).toBe(true);
    const h = (await http().get('/people-actions/tree').set(as('head')).expect(200)).body;
    expect(h.people.every((x: { department: { id: string } | null; id: string }) => x.department?.id === ids.design || x.id === ids.head)).toBe(true);
    expect(h.can).toMatchObject({ addPerson: true, addUnit: false, move: true });
    await http().get('/people-actions/tree').set(as('producer')).expect(403);
    const list = (await http().get(`/people-actions/people?q=${encodeURIComponent(`People mover ${stamp}`)}`).set(as('hr')).expect(200)).body;
    expect(list).toHaveLength(1);
    const detail = (await http().get(`/people-actions/people/${ids.producer}`).set(as('producer')).expect(200)).body;
    expect(detail.can.self).toBe(true);
    await http().get(`/people-actions/people/${ids.head}`).set(as('producer')).expect(403);
  });
});
