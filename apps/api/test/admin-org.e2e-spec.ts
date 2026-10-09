// Command Centre: departments & teams, branches, attendance & leave, AM assignment, offboarding, discount approvals.
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

let app: INestApplication;
let prisma: PrismaService;
let orgId: string;
const tokens: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const stamp = Date.now();

async function signIn(email: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier: email }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier: email, code: otp.body.devCode }).expect(200)).body.token as string;
}
const userId = async (email: string) => (await prisma.user.findFirstOrThrow({ where: { email } })).id;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  prisma = app.get(PrismaService);
  orgId = (await prisma.organisation.findFirstOrThrow({ orderBy: { createdAt: 'asc' } })).id;
  for (const who of ['founder', 'admin', 'hr', 'am', 'am.lead', 'producer', 'design.head']) tokens[who] = await signIn(`${who}@bmu.demo`);
  tokens.client = await signIn('client@sunrise.demo');
});

afterAll(async () => {
  // Remove what this run created so the demo screens stay tidy.
  await prisma.leaveRequest.deleteMany({ where: { reason: null, OR: [{ userId: { in: testUsers } }, { userId: hrId, from: new Date('2026-12-01T00:00:00Z') }] } });
  await prisma.notification.deleteMany({ where: { userId: { in: testUsers } } });
  await prisma.user.deleteMany({ where: { id: { in: testUsers } } });
  const branches = await prisma.branch.findMany({ where: { name: { startsWith: 'Pune ' }, city: { startsWith: 'Pune' } } });
  await prisma.team.deleteMany({ where: { department: { branchId: { in: branches.map((b) => b.id) } } } });
  await prisma.department.deleteMany({ where: { branchId: { in: branches.map((b) => b.id) } } });
  await prisma.branch.deleteMany({ where: { id: { in: branches.map((b) => b.id) } } });
  const clients = await prisma.clientOrg.findMany({ where: { name: { startsWith: 'Admin Test ' } } });
  await prisma.invoice.deleteMany({ where: { clientOrgId: { in: clients.map((c) => c.id) } } });
  await prisma.engagement.deleteMany({ where: { clientOrgId: { in: clients.map((c) => c.id) } } });
  await prisma.clientOrg.deleteMany({ where: { id: { in: clients.map((c) => c.id) } } });
  await app.close();
});
const testUsers: string[] = [];
let hrId = '';

describe('departments, teams and branches', () => {
  it('lets HR build a department and team, and keeps others out', async () => {
    const view = await http().get('/admin-org/structure').set(as('hr')).expect(200);
    expect(view.body.canEdit).toBe(true);
    expect(view.body.branches.map((b: { name: string }) => b.name)).toContain('Mumbai Studio');
    await http().get('/admin-org/structure').set(as('producer')).expect(403);
    await http().get('/admin-org/structure').set(as('client')).expect(403);
    const ro = await http().get('/admin-org/structure').set(as('design.head')).expect(200);
    expect(ro.body.canEdit).toBe(false);

    const branch = await http().post('/admin-org/branches').set(as('hr')).send({ name: `Pune ${stamp}`, city: 'Pune' }).expect(201);
    const pune = branch.body.branches.find((b: { name: string }) => b.name === `Pune ${stamp}`);
    await http().post('/admin-org/branches').set(as('producer')).send({ name: 'Nope', city: 'Goa' }).expect(403);
    await http().patch(`/admin-org/branches/${pune.id}`).set(as('admin')).send({ city: 'Pune West' }).expect(200);

    const withDept = await http().post('/admin-org/departments').set(as('hr')).send({ branchId: pune.id, name: 'Video' }).expect(201);
    const dept = withDept.body.branches.find((b: { id: string }) => b.id === pune.id).departments[0];
    await http().post('/admin-org/departments').set(as('design.head')).send({ branchId: pune.id, name: 'Other' }).expect(403);
    await http().post('/admin-org/departments').set(as('hr')).send({ branchId: pune.id, name: 'Video' }).expect(409);

    const producer = await userId('producer@bmu.demo');
    const before = await prisma.user.findUniqueOrThrow({ where: { id: producer } });
    const withTeam = await http().post('/admin-org/teams').set(as('hr')).send({ departmentId: dept.id, name: 'Reels pod' }).expect(201);
    const team = withTeam.body.branches.find((b: { id: string }) => b.id === pune.id).departments[0].teams[0];
    await http().patch(`/admin-org/departments/${dept.id}`).set(as('hr')).send({ headUserId: producer }).expect(200);
    const moved = await http().post('/admin-org/members/move').set(as('hr')).send({ userId: producer, teamId: team.id }).expect(201);
    const pod = moved.body.branches.find((b: { id: string }) => b.id === pune.id).departments[0];
    expect(pod.teams[0].members.map((m: { id: string }) => m.id)).toEqual([producer]);
    expect(pod.head.id).toBe(producer);

    // Only empty departments and teams can be removed.
    await http().delete(`/admin-org/departments/${dept.id}`).set(as('hr')).expect(409);
    await http().delete(`/admin-org/teams/${team.id}`).set(as('hr')).expect(409);
    await http().post('/admin-org/members/move').set(as('hr')).send({ userId: producer, teamId: before.teamId, departmentId: before.departmentId }).expect(201);
    await prisma.user.update({ where: { id: producer }, data: { departmentId: before.departmentId, teamId: before.teamId, branchId: before.branchId } });
    await http().delete(`/admin-org/teams/${team.id}`).set(as('hr')).expect(200);
    await http().delete(`/admin-org/departments/${dept.id}`).set(as('hr')).expect(200);
    expect((await prisma.department.findUniqueOrThrow({ where: { id: dept.id } })).deletedAt).not.toBeNull();
    expect(await prisma.auditEvent.count({ where: { entity: 'Department', entityId: dept.id } })).toBeGreaterThanOrEqual(3);
  });
});

describe('attendance and leave', () => {
  let staffId: string;

  beforeAll(async () => {
    const manager = await userId('design.head@bmu.demo');
    staffId = (await prisma.user.create({ data: { orgId, type: 'staff', name: `Leave Tester ${stamp}`, email: `leave.${stamp}@example.com`, status: 'active', managerId: manager } })).id;
    testUsers.push(staffId);
  });

  it('shows the board, the month grid and balances to HR only', async () => {
    const r = await http().get('/admin-org/attendance').set(as('hr')).expect(200);
    expect(r.body.board.length).toBeGreaterThan(5);
    expect(r.body.grid[0].cells).toHaveLength(r.body.days.length);
    expect(r.body.days.find((d: { date: string }) => d.date.endsWith('-02') && r.body.month === '2026-10')?.kind ?? 'holiday').toBe('holiday');
    expect(r.body.balances[0].casualLeft).toBeLessThanOrEqual(12);
    await http().get('/admin-org/attendance').set(as('am')).expect(403);
    await http().get('/admin-org/attendance?month=2026-13').set(as('hr')).expect(400);
  });

  it('lets the manager or HR decide, notifies the requester and counts working days', async () => {
    // Mon 2 Nov 2026 to Sat 7 Nov 2026: 6 working days; Sun 8 Nov (Diwali) is excluded.
    const leave = await prisma.leaveRequest.create({ data: { orgId, userId: staffId, from: new Date('2026-11-02T00:00:00Z'), to: new Date('2026-11-08T00:00:00Z'), type: 'casual' } });
    await http().post(`/admin-org/leave/${leave.id}/decide`).set(as('producer')).send({ decision: 'approve' }).expect(403);
    await http().post(`/admin-org/leave/${leave.id}/decide`).set(as('am')).send({ decision: 'approve' }).expect(403);
    const managerList = await http().get('/admin-org/leave').set(as('design.head')).expect(200);
    const mine = managerList.body.find((l: { id: string }) => l.id === leave.id);
    expect(mine.canDecide).toBe(true);
    expect(mine.workingDays).toBe(6);

    // v10 chain: more than 3 working days, so the manager's approval sends it on to HR.
    const first = await http().post(`/admin-org/leave/${leave.id}/decide`).set(as('design.head')).send({ decision: 'approve', note: 'Enjoy' }).expect(201);
    expect(first.body).toMatchObject({ status: 'pending', stage: 'hr', canDecide: false });
    expect(first.body.managerDecidedBy.id).toBe(await userId('design.head@bmu.demo'));
    await http().post(`/admin-org/leave/${leave.id}/decide`).set(as('design.head')).send({ decision: 'approve' }).expect(403);
    const ok = await http().post(`/admin-org/leave/${leave.id}/decide`).set(as('hr')).send({ decision: 'approve' }).expect(201);
    expect(ok.body.status).toBe('approved');
    expect(ok.body.decidedBy.id).toBe(await userId('hr@bmu.demo'));
    await http().post(`/admin-org/leave/${leave.id}/decide`).set(as('hr')).send({ decision: 'reject' }).expect(409);
    const note = await prisma.notification.findFirstOrThrow({ where: { userId: staffId }, orderBy: { createdAt: 'desc' } });
    expect(note.title).toMatch(/approved/);
    expect(note.link).toBe('/team/profile');

    const nov = await http().get('/admin-org/attendance?month=2026-11').set(as('hr')).expect(200);
    const bal = nov.body.balances.find((b: { user: { id: string } }) => b.user.id === staffId);
    expect(bal.casualUsed).toBe(6);
    expect(bal.casualLeft).toBe(6);
    const row = nov.body.grid.find((g: { user: { id: string } }) => g.user.id === staffId);
    expect(row.cells[1]).toBe('leave');
  });

  it('never lets someone decide their own leave', async () => {
    const hr = await userId('hr@bmu.demo');
    hrId = hr;
    const own = await prisma.leaveRequest.create({ data: { orgId, userId: hr, from: new Date('2026-12-01T00:00:00Z'), to: new Date('2026-12-01T00:00:00Z'), type: 'sick' } });
    await http().post(`/admin-org/leave/${own.id}/decide`).set(as('hr')).send({ decision: 'approve' }).expect(403);
    const r = await http().post(`/admin-org/leave/${own.id}/decide`).set(as('admin')).send({ decision: 'reject' }).expect(201);
    expect(r.body.status).toBe('rejected');
  });
});

describe('clients admin', () => {
  let clientId: string;
  let openId: string;
  let closedId: string;
  let invoiceId: string;

  beforeAll(async () => {
    const am = await userId('am@bmu.demo');
    const smm = await prisma.service.findFirstOrThrow({ where: { key: 'smm', priceBook: { orgId, status: 'active' } } });
    const client = await prisma.clientOrg.create({ data: { orgId, name: `Admin Test ${stamp}`, amUserId: am } });
    clientId = client.id;
    const base = { orgId, clientOrgId: client.id, serviceId: smm.id, tier: 'growth' as const, billingType: 'monthly' as const, amId: am };
    openId = (await prisma.engagement.create({ data: { ...base, status: 'active_retainer', currentGate: 'G4' } })).id;
    closedId = (await prisma.engagement.create({ data: { ...base, status: 'closed' } })).id;
    invoiceId = (
      await prisma.invoice.create({
        data: { orgId, clientOrgId: client.id, engagementId: openId, number: `TEST/${stamp}`, lines: [], subtotalPaise: 100, gstPaise: 18, totalPaise: 118, dueDate: new Date(), status: 'issued' },
      })
    ).id;
  });

  it('lists engagements for Founder/Admin/AM Lead only', async () => {
    const r = await http().get('/admin-org/engagements').set(as('am.lead')).expect(200);
    expect(r.body.find((e: { id: string }) => e.id === openId).client.name).toBe(`Admin Test ${stamp}`);
    await http().get('/admin-org/engagements').set(as('am')).expect(403);
    await http().get('/admin-org/engagements').set(as('client')).expect(403);
  });

  it('reassigns the AM on the client and its open engagements, and tells the new AM', async () => {
    const lead = await userId('am.lead@bmu.demo');
    await http().post(`/admin-org/clients/${clientId}/am`).set(as('am')).send({ amUserId: lead }).expect(403);
    await http().post(`/admin-org/clients/${clientId}/am`).set(as('admin')).send({ amUserId: await userId('producer@bmu.demo') }).expect(400);
    const r = await http().post(`/admin-org/clients/${clientId}/am`).set(as('admin')).send({ amUserId: lead }).expect(201);
    expect(r.body.clients.find((c: { id: string }) => c.id === clientId).am.id).toBe(lead);
    expect((await prisma.engagement.findUniqueOrThrow({ where: { id: openId } })).amId).toBe(lead);
    expect((await prisma.engagement.findUniqueOrThrow({ where: { id: closedId } })).amId).toBe(await userId('am@bmu.demo'));
    expect(await prisma.notification.count({ where: { userId: lead, title: { contains: `Admin Test ${stamp}` } } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { action: 'client.am_reassigned', entityId: clientId } })).toBe(1);
  });

  it('pauses, reactivates, offboards and closes only once invoices are paid', async () => {
    const go = (action: string, reason?: string) => http().post(`/admin-org/engagements/${openId}/lifecycle`).set(as('am.lead')).send({ action, reason });
    await http().post(`/admin-org/engagements/${openId}/lifecycle`).set(as('am')).send({ action: 'pause' }).expect(403);
    expect((await go('pause').expect(201)).body.status).toBe('paused');
    await go('pause').expect(409);
    expect((await go('reactivate').expect(201)).body.status).toBe('active_retainer');
    const off = await go('offboard', 'Contract ends').expect(201);
    expect(off.body.status).toBe('offboarding');
    expect(off.body.closeBlockedReason).toMatch(/unpaid invoice/);
    expect(off.body.can.close).toBe(false);
    const blocked = await go('close', 'Done').expect(409);
    expect(blocked.body.message).toMatch(/unpaid invoice/);

    const ticked = await http().post(`/admin-org/engagements/${openId}/offboarding-checklist`).set(as('am.lead')).send({ key: 'access_returned', done: true }).expect(201);
    expect(ticked.body.checklist.access_returned.done).toBe(true);
    expect(ticked.body.checklist.feedback.done).toBe(false);

    await prisma.invoice.update({ where: { id: invoiceId }, data: { status: 'paid' } });
    await go('close').expect(400);
    const closed = await go('close', 'Contract finished').expect(201);
    expect(closed.body.status).toBe('closed');
    expect(closed.body.lastChange.reason).toBe('Contract finished');
    expect(closed.body.checklist.access_returned.done).toBe(true);
    expect((await prisma.engagement.findUniqueOrThrow({ where: { id: openId } })).endDate).not.toBeNull();
    // Reactivating restores the status it had before it was stopped.
    expect((await go('reactivate').expect(201)).body.status).toBe('active_retainer');
  });
});

describe('catalogue', () => {
  it('shows discount approvals to catalogue owners only', async () => {
    await http().get('/admin-org/discount-approvals').set(as('founder')).expect(200);
    await http().get('/admin-org/discount-approvals').set(as('am.lead')).expect(403);
  });
});
