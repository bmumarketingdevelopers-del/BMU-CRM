// Command Centre: departments & teams, branches, attendance & leave, CM assignment, offboarding, discount approvals.
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
  await prisma.attendanceCorrection.deleteMany({ where: { userId: { in: testUsers } } });
  await prisma.attendance.deleteMany({ where: { userId: { in: testUsers } } });
  await prisma.notification.deleteMany({ where: { title: { contains: `Leave Tester ${stamp}` } } });
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
    // v31: leave goes to the Department Head of the person's department first.
    const headed = await prisma.department.findFirst({ where: { headUserId: manager, deletedAt: null } });
    const dept = headed?.id ?? (await prisma.user.findUniqueOrThrow({ where: { id: manager } })).departmentId;
    staffId = (await prisma.user.create({ data: { orgId, type: 'staff', name: `Leave Tester ${stamp}`, email: `leave.${stamp}@example.com`, status: 'active', managerId: manager, departmentId: dept } })).id;
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

  it('the Department Head decides first, then HR; the requester hears only the result', async () => {
    // Mon 2 Nov 2026 to Sat 7 Nov 2026: 6 working days; Sun 8 Nov (Diwali) is excluded.
    const leave = await prisma.leaveRequest.create({ data: { orgId, userId: staffId, from: new Date('2026-11-02T00:00:00Z'), to: new Date('2026-11-08T00:00:00Z'), type: 'casual' } });
    await http().post(`/admin-org/leave/${leave.id}/decide`).set(as('producer')).send({ decision: 'approve' }).expect(403);
    await http().post(`/admin-org/leave/${leave.id}/decide`).set(as('am')).send({ decision: 'approve' }).expect(403);
    await http().post(`/admin-org/leave/${leave.id}/decide`).set(as('hr')).send({ decision: 'approve' }).expect(403);
    await http().post(`/admin-org/leave/${leave.id}/decide`).set(as('admin')).send({ decision: 'approve' }).expect(403);
    const managerList = await http().get('/admin-org/leave').set(as('design.head')).expect(200);
    const mine = managerList.body.find((l: { id: string }) => l.id === leave.id);
    expect(mine).toMatchObject({ canDecide: true, stage: 'head' });
    expect(mine.workingDays).toBe(6);

    // v31 chain: the Department Head's approval sends it on to HR for the final call.
    const first = await http().post(`/admin-org/leave/${leave.id}/decide`).set(as('design.head')).send({ decision: 'approve', note: 'Enjoy' }).expect(201);
    expect(first.body).toMatchObject({ status: 'pending', stage: 'hr', canDecide: false });
    expect(await prisma.notification.count({ where: { userId: staffId } })).toBe(0);
    expect(first.body.managerDecidedBy.id).toBe(await userId('design.head@bmu.demo'));
    await http().post(`/admin-org/leave/${leave.id}/decide`).set(as('design.head')).send({ decision: 'approve' }).expect(403);
    const ok = await http().post(`/admin-org/leave/${leave.id}/decide`).set(as('hr')).send({ decision: 'approve' }).expect(201);
    expect(ok.body.status).toBe('approved');
    expect(ok.body.decidedBy.id).toBe(await userId('hr@bmu.demo'));
    await http().post(`/admin-org/leave/${leave.id}/decide`).set(as('hr')).send({ decision: 'reject' }).expect(409);
    const note = await prisma.notification.findFirstOrThrow({ where: { userId: staffId }, orderBy: { createdAt: 'desc' } });
    expect(note.title).toMatch(/Your casual leave .* is approved/);
    expect(note.body).not.toMatch(/Enjoy$|HR|design/i);
    expect(note.link).toBe('/team/profile');

    const nov = await http().get('/admin-org/attendance?month=2026-11').set(as('hr')).expect(200);
    const bal = nov.body.balances.find((b: { user: { id: string } }) => b.user.id === staffId);
    // v31: 1 paid casual day a month, carried over (older requests without a split count as paid).
    const nowIst = new Date(Date.now() + 330 * 60_000).toISOString();
    const accrued = nowIst.startsWith('2026') ? Number(nowIst.slice(5, 7)) : 12;
    expect(bal).toMatchObject({ casualUsed: 6, casualAccrued: accrued, casualLeft: Math.max(0, accrued - 6) });
    const row = nov.body.grid.find((g: { user: { id: string } }) => g.user.id === staffId);
    expect(row.cells[1]).toBe('leave');
  });

  // ---------------------------------------------------------------------------
  // v30: Department Head scope, grace period, missed check-out, records sheet, check-in once a day, corrections.

  type Day = { date: string; kind: string; status: string; lateMinutes: number; corrected: boolean; checkOut: string | null };
  type Person = { user: { id: string }; designation: string; days: Day[]; totals: { late: number; missedOut: number; present: number } };
  type Dept = { id: string | null; name: string; people: Person[] };
  const ymd = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  const back = (n: number) => ymd(new Date(Date.now() - n * 86_400_000));
  const staffRow = (body: { departments: Dept[] }) => body.departments.flatMap((d) => d.people).find((p) => p.user.id === staffId)!;
  let headDept = '';
  let staffToken = '';

  it('shows a Department Head only their own team; records and downloads are for the Founder and HR', async () => {
    const head = await userId('design.head@bmu.demo');
    const headed = await prisma.department.findFirst({ where: { headUserId: head, deletedAt: null } });
    headDept = headed?.id ?? (await prisma.user.findUniqueOrThrow({ where: { id: head } })).departmentId!;
    await prisma.user.update({ where: { id: staffId }, data: { departmentId: headDept } });
    const deptName = (await prisma.department.findUniqueOrThrow({ where: { id: headDept } })).name;

    const hr = (await http().get('/admin-org/attendance').set(as('hr')).expect(200)).body;
    expect(hr.scope.all).toBe(true);
    expect(hr).toMatchObject({ canRecords: true, canDownload: true });
    expect(hr.workingHours.graceMinutes).toBe(15);
    const dh = (await http().get('/admin-org/attendance').set(as('design.head')).expect(200)).body;
    expect(dh.scope.all).toBe(false);
    expect(dh).toMatchObject({ canRecords: true, canDownload: false });
    expect(dh.board.length).toBeGreaterThan(0);
    expect(dh.board.length).toBeLessThan(hr.board.length);
    expect(dh.board.every((b: { user: { department: string } }) => b.user.department === deptName)).toBe(true);
    expect(dh.board.some((b: { user: { id: string } }) => b.user.id === staffId)).toBe(true);
    const admin = (await http().get('/admin-org/attendance').set(as('admin')).expect(200)).body;
    expect(admin).toMatchObject({ canRecords: false, canDownload: false });

    // Today by department (Founder's and HR's dashboards).
    const today = (await http().get('/admin-org/attendance/today').set(as('founder')).expect(200)).body;
    expect(today.scope.all).toBe(true);
    expect(today.departments.length).toBeGreaterThan(1);
    expect(today.totals.total).toBe(today.departments.reduce((s: number, d: { total: number }) => s + d.total, 0));
    const todayDh = (await http().get('/admin-org/attendance/today').set(as('design.head')).expect(200)).body;
    expect(todayDh.departments.map((d: { name: string }) => d.name)).toEqual([deptName]);
    await http().get('/admin-org/attendance/today').set(as('am')).expect(403);

    // Records: everyone for HR / Founder; the Department Head only their department, without download.
    const rec = (await http().get(`/admin-org/attendance/records?from=${back(10)}&to=${back(1)}`).set(as('hr')).expect(200)).body;
    expect(rec.canDownload).toBe(true);
    expect(rec.departments.length).toBeGreaterThan(1);
    expect(staffRow(rec).designation).toBeTruthy();
    expect(staffRow(rec).days).toHaveLength(10);
    const recDh = (await http().get(`/admin-org/attendance/records?from=${back(10)}&to=${back(1)}`).set(as('design.head')).expect(200)).body;
    expect(recDh.canDownload).toBe(false);
    expect(recDh.departments.map((d: Dept) => d.id)).toEqual([headDept]);
    const other = rec.departments.find((d: Dept) => d.id && d.id !== headDept);
    await http().get(`/admin-org/attendance/records?departmentId=${other.id}`).set(as('design.head')).expect(403);
    const one = (await http().get(`/admin-org/attendance/records?departmentId=${other.id}`).set(as('founder')).expect(200)).body;
    expect(one.departments.map((d: Dept) => d.id)).toEqual([other.id]);
    await http().get('/admin-org/attendance/records').set(as('admin')).expect(403);
    await http().get('/admin-org/attendance/records').set(as('am')).expect(403);
    await http().get(`/admin-org/attendance/records?from=${back(1)}&to=${back(3)}`).set(as('hr')).expect(400);
  });

  it('counts late only after the 15-minute grace and flags a missed check-out', async () => {
    const rec = (await http().get(`/admin-org/attendance/records?from=${back(14)}&to=${back(1)}`).set(as('hr')).expect(200)).body;
    const working = staffRow(rec).days.filter((d) => d.kind === 'working').map((d) => d.date);
    const [onTime, late, missed] = working;
    const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+05:30`);
    await prisma.attendance.createMany({
      data: [
        { orgId, userId: staffId, date: new Date(`${onTime}T00:00:00Z`), checkIn: at(onTime, '09:44'), checkOut: at(onTime, '18:40') },
        { orgId, userId: staffId, date: new Date(`${late}T00:00:00Z`), checkIn: at(late, '09:46'), checkOut: at(late, '18:35') },
        { orgId, userId: staffId, date: new Date(`${missed}T00:00:00Z`), checkIn: at(missed, '09:30') },
      ],
    });
    const after = staffRow((await http().get(`/admin-org/attendance/records?from=${back(14)}&to=${back(1)}`).set(as('hr')).expect(200)).body);
    const day = (d: string) => after.days.find((x) => x.date === d)!;
    expect(day(onTime)).toMatchObject({ status: 'present', lateMinutes: 0 });
    expect(day(late)).toMatchObject({ status: 'late', lateMinutes: 16 });
    expect(day(missed)).toMatchObject({ status: 'missed_out' });
    expect(after.totals).toMatchObject({ present: 3, late: 1, missedOut: 1 });
    // The month grid shows it too.
    const month = missed.slice(0, 7);
    const grid = (await http().get(`/admin-org/attendance?month=${month}`).set(as('hr')).expect(200)).body;
    const row = grid.grid.find((g: { user: { id: string } }) => g.user.id === staffId);
    expect(row.cells[Number(missed.slice(8)) - 1]).toBe('missed_out');
  });

  it('allows one check-in and one check-out a day, only on working days, and only the Founder changes the working time', async () => {
    const email = `leave.${stamp}@example.com`;
    staffToken = await signIn(email);
    const me = { Authorization: `Bearer ${staffToken}` };
    const day = (await http().get('/my-day').set(me).expect(200)).body;
    expect(day.workingHours.graceMinutes).toBe(15);
    if (day.workday.kind === 'working') {
      expect(day.canCheckIn).toBe(true);
      await http().post('/my-day/check-in').set(me).expect(200);
      await http().post('/my-day/check-in').set(me).expect(400);
      const out = (await http().post('/my-day/check-out').set(me).expect(200)).body;
      expect(out).toMatchObject({ canCheckIn: false, canCheckOut: false });
      expect(out.nextCheckIn > out.date).toBe(true);
      const again = await http().post('/my-day/check-in').set(me).expect(400);
      expect(again.body.message).toMatch(/already checked in and out today\. Check-in opens on/);
      await http().post('/my-day/check-out').set(me).expect(400);
    } else {
      expect(day.canCheckIn).toBe(false);
      const r = await http().post('/my-day/check-in').set(me).expect(400);
      expect(r.body.message).toMatch(/No check-in is needed/);
    }
    // Working hours: Founder only.
    const all = (await http().get('/settings').set(as('founder')).expect(200)).body;
    expect(all.canEdit.workingHours).toBe(true);
    expect((await http().get('/settings').set(as('hr')).expect(200)).body.canEdit.workingHours).toBe(false);
    await http().put('/settings/workingHours').set(as('hr')).send(all.workingHours).expect(403);
    await http().put('/settings/workingHours').set(as('admin')).send(all.workingHours).expect(403);
    await http().put('/settings/workingHours').set(as('founder')).send({ ...all.workingHours, graceMinutes: 15 }).expect(200);
  });

  it('lets the employee ask for a correction and their manager approve it into the records', async () => {
    const me = { Authorization: `Bearer ${staffToken}` };
    const rec = staffRow((await http().get(`/admin-org/attendance/records?from=${back(14)}&to=${back(1)}`).set(as('hr')).expect(200)).body);
    const missed = rec.days.find((d) => d.status === 'missed_out')!.date;
    const weekend = rec.days.find((d) => d.kind !== 'working');
    const body = { date: missed, checkIn: '09:30', checkOut: '18:45', reason: 'Forgot to check out' };
    await http().post('/admin-org/attendance/corrections').set(me).send({ ...body, reason: 'no' }).expect(400);
    await http().post('/admin-org/attendance/corrections').set(me).send({ ...body, date: back(-2) }).expect(400);
    if (weekend) await http().post('/admin-org/attendance/corrections').set(me).send({ ...body, date: weekend.date }).expect(400);
    const mine = (await http().post('/admin-org/attendance/corrections').set(me).send(body).expect(201)).body;
    expect(mine[0]).toMatchObject({ date: missed, status: 'pending' });
    expect(mine[0].recorded.checkOut).toBeNull();
    await http().post('/admin-org/attendance/corrections').set(me).send(body).expect(400);
    const note = await prisma.notification.findFirst({ where: { userId: await userId('design.head@bmu.demo'), kind: 'attendance_correction' }, orderBy: { createdAt: 'desc' } });
    expect(note?.title).toMatch(`Leave Tester ${stamp}`);

    // My Day no longer nags about the missed check-out once a correction is asked.
    expect((await http().get('/my-day').set(me).expect(200)).body.missedCheckOut).toBeNull();

    const list = (await http().get('/admin-org/attendance/corrections').set(as('design.head')).expect(200)).body;
    const row = list.find((c: { id: string }) => c.id === mine[0].id);
    expect(row.canDecide).toBe(true);
    await http().post(`/admin-org/attendance/corrections/${row.id}/decide`).set(as('am')).send({ decision: 'approve' }).expect(403);
    await http().post(`/admin-org/attendance/corrections/${row.id}/decide`).set(me).send({ decision: 'approve' }).expect(403);
    const ok = (await http().post(`/admin-org/attendance/corrections/${row.id}/decide`).set(as('design.head')).send({ decision: 'approve' }).expect(201)).body;
    expect(ok.status).toBe('approved');
    await http().post(`/admin-org/attendance/corrections/${row.id}/decide`).set(as('hr')).send({ decision: 'reject' }).expect(409);
    const fixed = staffRow((await http().get(`/admin-org/attendance/records?from=${missed}&to=${missed}`).set(as('hr')).expect(200)).body).days[0];
    expect(fixed).toMatchObject({ status: 'present', corrected: true });
    expect(fixed.checkOut).toBe(new Date(`${missed}T18:45:00+05:30`).toISOString());

    // Cancel a second request; HR sees everyone's requests.
    const other = rec.days.find((d) => d.kind === 'working' && d.status === 'not_tracked' || (d.kind === 'working' && d.status === 'absent'));
    if (other) {
      const asked = (await http().post('/admin-org/attendance/corrections').set(me).send({ ...body, date: other.date }).expect(201)).body;
      const cancelled = (await http().post(`/admin-org/attendance/corrections/${asked[0].id}/cancel`).set(me).expect(201)).body;
      expect(cancelled[0].status).toBe('cancelled');
    }
    const hrList = (await http().get('/admin-org/attendance/corrections').set(as('hr')).expect(200)).body;
    expect(hrList.some((c: { id: string }) => c.id === row.id)).toBe(true);
    expect((await http().get('/admin-org/attendance/corrections').set(as('am')).expect(200)).body).toEqual([]);
  });

  it('never lets someone decide their own leave', async () => {
    const hr = await userId('hr@bmu.demo');
    hrId = hr;
    const own = await prisma.leaveRequest.create({ data: { orgId, userId: hr, from: new Date('2026-12-01T00:00:00Z'), to: new Date('2026-12-01T00:00:00Z'), type: 'sick' } });
    await http().post(`/admin-org/leave/${own.id}/decide`).set(as('hr')).send({ decision: 'approve' }).expect(403);
    // v31: Branch Managers are not in the leave flow; another HR (or the Founder when there is none) decides.
    await http().post(`/admin-org/leave/${own.id}/decide`).set(as('admin')).send({ decision: 'reject' }).expect(403);
    const founderView = (await http().get('/admin-org/leave').set(as('founder')).expect(200)).body.find((l: { id: string }) => l.id === own.id);
    if (founderView.canDecide) {
      const r = await http().post(`/admin-org/leave/${own.id}/decide`).set(as('founder')).send({ decision: 'reject' }).expect(201);
      expect(r.body.status).toBe('rejected');
    }
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

  it('lists engagements for Founder/Admin/CM Lead only', async () => {
    const r = await http().get('/admin-org/engagements').set(as('am.lead')).expect(200);
    expect(r.body.find((e: { id: string }) => e.id === openId).client.name).toBe(`Admin Test ${stamp}`);
    await http().get('/admin-org/engagements').set(as('am')).expect(403);
    await http().get('/admin-org/engagements').set(as('client')).expect(403);
  });

  it('reassigns the CM on the client and its open engagements, and tells the new CM', async () => {
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
