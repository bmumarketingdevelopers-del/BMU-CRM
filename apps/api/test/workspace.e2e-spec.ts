// Workspace: Client 360, calendar, capacity, SOPs, leave, creator briefs and payouts, client reports and team users.
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
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const stamp = Date.now();
let orgId: string;
let clientId: string;
let otherClientId: string;
let creatorId: string;
let amId: string;
let ownerId: string;

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
  orgId = org.id;
  const am = await prisma.user.findFirstOrThrow({ where: { email: 'am@bmu.demo' } });
  amId = am.id;
  const lead = await prisma.user.findFirstOrThrow({ where: { email: 'am.lead@bmu.demo' } });
  const role = (baseRole: string) => prisma.role.findFirstOrThrow({ where: { orgId, baseRole, isCustom: false } });

  const client = await prisma.clientOrg.create({ data: { orgId, name: `Workspace Test ${stamp}`, amUserId: am.id } });
  clientId = client.id;
  otherClientId = (await prisma.clientOrg.create({ data: { orgId, name: `Other CM Client ${stamp}`, amUserId: lead.id } })).id;
  for (const [who, clientRole] of [
    ['owner', 'client_owner'],
    ['viewer', 'client_viewer'],
  ] as const) {
    const u = await prisma.user.create({
      data: { orgId, type: 'client', name: `Test ${who}`, email: `ws.${who}.${stamp}@example.com`, status: 'active', roles: { create: { roleId: (await role(clientRole)).id } } },
    });
    await prisma.clientUser.create({ data: { userId: u.id, orgId, clientOrgId: client.id, clientRole, brandScope: [] } });
    if (who === 'owner') ownerId = u.id;
    tokens[who] = await signIn(u.email!);
  }

  // A fresh staff member (manager: the CM) so leave tests start with a full balance.
  const staff = await prisma.user.create({
    data: { orgId, type: 'staff', name: 'Leave Tester', email: `ws.staff.${stamp}@example.com`, status: 'active', managerId: am.id, roles: { create: { roleId: (await role('producer')).id } } },
  });
  tokens.staff = await signIn(staff.email!);

  for (const who of ['one', 'two']) {
    const u = await prisma.user.create({ data: { orgId, type: 'creator', name: `Creator ${who}`, email: `ws.creator.${who}.${stamp}@example.com`, status: 'active' } });
    const c = await prisma.creator.create({ data: { orgId, userId: u.id, niche: ['Food'] } });
    if (who === 'one') creatorId = c.id;
    tokens[`creator_${who}`] = await signIn(u.email!);
  }

  for (const who of ['am', 'founder', 'producer', 'am.lead']) tokens[who] = await signIn(`${who}@bmu.demo`);
});

afterAll(async () => {
  // Keep the test staff member out of other specs' task assignment pools.
  await prisma.user.updateMany({ where: { email: `ws.staff.${stamp}@example.com` }, data: { deletedAt: new Date() } });
  await app.close();
});

describe('Client 360', () => {
  it('lets the CM open their own client with stats, services and users', async () => {
    const r = await http().get(`/workspace/clients/${clientId}`).set(as('am')).expect(200);
    expect(r.body.client.name).toContain('Workspace Test');
    expect(r.body.stats).toMatchObject({ activeServices: 0, openRequests: 0, draftsWaiting: 0 });
    expect(r.body.users).toHaveLength(2);
  });

  it("stops a CM opening another CM's client, and non-client roles entirely", async () => {
    await http().get(`/workspace/clients/${otherClientId}`).set(as('am')).expect(403);
    await http().get(`/workspace/clients/${clientId}`).set(as('producer')).expect(403);
    await http().get(`/workspace/clients/${clientId}`).set(as('owner')).expect(403);
  });

  it('lets the founder and CM lead see every client', async () => {
    await http().get(`/workspace/clients/${otherClientId}`).set(as('founder')).expect(200);
    await http().get(`/workspace/clients/${clientId}`).set(as('am.lead')).expect(200);
  });
});

describe('calendar, capacity and SOPs', () => {
  it('shows holidays and items for the month', async () => {
    const r = await http().get('/workspace/calendar?month=2026-10&view=team').set(as('am')).expect(200);
    expect(r.body.month).toBe('2026-10');
    expect(r.body.items.some((i: { kind: string }) => i.kind === 'holiday')).toBe(true);
    await http().get('/workspace/calendar?month=2026-13').set(as('am')).expect(400);
    await http().get('/workspace/calendar?month=2026-10').set(as('owner')).expect(403);
  });

  it('gives everyone their own load card and leads their department', async () => {
    const mine = await http().get('/workspace/capacity').set(as('producer')).expect(200);
    expect(mine.body.me.name).toBe('Meera Nair');
    const lead = await http().get('/workspace/capacity').set(as('am.lead')).expect(200);
    expect(lead.body.scope).toBe('department');
    expect(lead.body.people.some((p: { id: string }) => p.id === amId)).toBe(true);
    const founder = await http().get('/workspace/capacity').set(as('founder')).expect(200);
    expect(founder.body.scope).toBe('all');
  });

  it('serves the SOP library to staff only', async () => {
    const list = await http().get('/workspace/sops').set(as('producer')).expect(200);
    expect(Array.isArray(list.body)).toBe(true);
    if (list.body.length) {
      const one = await http().get(`/workspace/sops/${list.body[0].id}`).set(as('producer')).expect(200);
      expect(one.body.body.length).toBeGreaterThan(0);
      expect(one.body.department.name).toBeTruthy();
    }
    await http().get('/workspace/sops').set(as('owner')).expect(403);
    await http().get('/workspace/sops').set(as('creator_one')).expect(403);
  });
});

describe('profile and leave', () => {
  let leaveId: string;

  it('builds up 1 paid casual and 1 paid sick day a month', async () => {
    const r = await http().get('/workspace/profile').set(as('staff')).expect(200);
    const month = Number(new Date(Date.now() + 330 * 60_000).toISOString().slice(5, 7));
    expect(r.body.leave.balance).toEqual([
      expect.objectContaining({ type: 'casual', allowed: month, used: 0, left: month }),
      expect.objectContaining({ type: 'sick', allowed: month, used: 0, left: month }),
    ]);
    expect(r.body.leave.canApply).toBe(true);
    expect(r.body.user.manager.name).toBe('Neha Iyer');
  });

  it('applies for leave, counts working days only and notifies HR when there is no Department Head', async () => {
    // Mon 16 Nov – Sun 22 Nov 2026: six working days (Sunday is off).
    const r = await http().post('/workspace/leave').set(as('staff')).send({ from: '2026-11-16', to: '2026-11-22', type: 'casual', reason: 'Trip' }).expect(201);
    const req = r.body.leave.requests[0];
    expect(req).toMatchObject({ status: 'pending', days: 6, paidDays: 6, unpaidDays: 0 });
    leaveId = req.id;
    expect(r.body.leave.balance[0]).toMatchObject({ pending: 6, used: 0 });
    // v31: no department (so no Department Head): straight to HR.
    const hr = await prisma.user.findFirstOrThrow({ where: { email: 'hr@bmu.demo' } });
    const note = await prisma.notification.findFirst({ where: { userId: hr.id, kind: 'leave_request' }, orderBy: { createdAt: 'desc' } });
    expect(note?.title).toContain('Leave Tester');
    expect(note?.link).toBe('/admin/attendance#leave');
  });

  it('rejects overlapping, Sunday-only and backwards requests; days beyond the paid ones are unpaid', async () => {
    await http().post('/workspace/leave').set(as('staff')).send({ from: '2026-11-20', to: '2026-11-24', type: 'sick' }).expect(400);
    await http().post('/workspace/leave').set(as('staff')).send({ from: '2026-11-29', to: '2026-11-29', type: 'casual' }).expect(400);
    await http().post('/workspace/leave').set(as('staff')).send({ from: '2026-12-10', to: '2026-12-01', type: 'casual' }).expect(400);
    // v31: 12 paid casual days built up by December, 6 already asked for: 9 working days = 6 paid + 3 unpaid.
    const dec = (await http().post('/workspace/leave').set(as('staff')).send({ from: '2026-12-01', to: '2026-12-10', type: 'casual' }).expect(201)).body.leave.requests.find((x: { from: string }) => x.from === '2026-12-01');
    expect(dec).toMatchObject({ days: 9, paidDays: 6, unpaidDays: 3 });
    await http().post(`/workspace/leave/${dec.id}/cancel`).set(as('staff')).expect(200);
    await http().post('/workspace/leave').set(as('owner')).send({ from: '2026-12-01', to: '2026-12-02', type: 'casual' }).expect(403);
  });

  it('cancels a pending request, but not twice', async () => {
    const r = await http().post(`/workspace/leave/${leaveId}/cancel`).set(as('staff')).expect(200);
    expect(r.body.leave.requests.find((x: { id: string }) => x.id === leaveId).status).toBe('cancelled');
    await http().post(`/workspace/leave/${leaveId}/cancel`).set(as('staff')).expect(400);
    await http().post(`/workspace/leave/${leaveId}/cancel`).set(as('producer')).expect(404);
  });

  it('updates my own name and phone', async () => {
    const digits = `9${String(stamp).slice(-9)}`;
    await http().patch('/workspace/me').set(as('staff')).send({ name: 'Leave Tester', phone: `${digits.slice(0, 5)} ${digits.slice(5)}` }).expect(200);
    const u = await prisma.user.findFirstOrThrow({ where: { email: `ws.staff.${stamp}@example.com` } });
    expect(u.phone).toBe(`+91${digits}`);
    await http().patch('/workspace/me').set(as('staff')).send({ name: 'L', phone: '' }).expect(400);
    // Team members can't rename themselves (HR or a Branch Manager does that).
    await http().patch('/workspace/me').set(as('staff')).send({ name: 'Someone Else', phone: '' }).expect(403);
  });
});

describe('creator briefs and payouts', () => {
  let briefId: string;

  it('lets CMs brief a creator and notifies the creator; others cannot', async () => {
    await http().get('/workspace/creators').set(as('producer')).expect(403);
    await http().post('/workspace/briefs').set(as('am')).send({ creatorId, title: 'Not yours', brief: 'For another CM client', deliverables: ['1 reel'], feeRupees: 1000, clientOrgId: otherClientId }).expect(403);
    const r = await http()
      .post('/workspace/briefs')
      .set(as('am'))
      .send({ creatorId, title: `Test reel ${stamp}`, brief: 'A short food reel for the launch', deliverables: ['1 reel'], dueAt: '2026-10-20', feeRupees: 10000, clientOrgId: clientId })
      .expect(201);
    expect(r.body).toMatchObject({ status: 'offered', feePaise: 1_000_000 });
    briefId = r.body.id;
    const creatorUser = await prisma.creator.findUniqueOrThrow({ where: { id: creatorId } });
    expect(await prisma.notification.count({ where: { userId: creatorUser.userId, link: `/creator/briefs/${briefId}` } })).toBe(1);
  });

  it('shows creators only their own briefs', async () => {
    const mine = await http().get('/workspace/creator/briefs').set(as('creator_one')).expect(200);
    expect(mine.body.some((b: { id: string }) => b.id === briefId)).toBe(true);
    await http().get(`/workspace/creator/briefs/${briefId}`).set(as('creator_two')).expect(404);
    await http().post(`/workspace/creator/briefs/${briefId}/accept`).set(as('creator_two')).expect(404);
    await http().get('/workspace/creator/briefs').set(as('am')).expect(403);
  });

  it('needs the brief accepted before work is sent', async () => {
    await http().post(`/workspace/creator/briefs/${briefId}/submissions/link`).set(as('creator_one')).send({ url: 'https://example.com/v1' }).expect(400);
    const r = await http().post(`/workspace/creator/briefs/${briefId}/accept`).set(as('creator_one')).expect(200);
    expect(r.body.status).toBe('accepted');
    await http().post(`/workspace/creator/briefs/${briefId}/decline`).set(as('creator_one')).expect(400);
  });

  it('runs submit → revision → resubmit (file) → approve, booking one payout with 10% TDS', async () => {
    let r = await http().post(`/workspace/creator/briefs/${briefId}/submissions/link`).set(as('creator_one')).send({ url: 'https://example.com/v1', note: 'First cut' }).expect(201);
    expect(r.body.status).toBe('submitted');
    await http().post(`/workspace/creator/briefs/${briefId}/submissions/link`).set(as('creator_one')).send({ url: 'https://example.com/v1b' }).expect(400);
    await http().post(`/workspace/briefs/${briefId}/approve`).set(as('producer')).expect(403);
    r = await http().post(`/workspace/briefs/${briefId}/feedback`).set(as('am')).send({ feedback: 'Shorter intro please' }).expect(200);
    expect(r.body.status).toBe('revision');
    expect(r.body.submissionList[0]).toMatchObject({ feedback: 'Shorter intro please', approved: false });
    r = await http()
      .post(`/workspace/creator/briefs/${briefId}/submissions`)
      .set(as('creator_one'))
      .field('note', 'Second cut')
      .attach('file', Buffer.from('fake video'), { filename: 'reel-v2.mp4', contentType: 'video/mp4' })
      .expect(201);
    expect(r.body.submissionList).toHaveLength(2);
    const fileUrl: string = r.body.submissionList[1].fileUrl;
    expect(fileUrl).toMatch(/\/api\/workspace\/submissions\/.+\/file$/);
    const path = fileUrl.replace('/api', '');
    await http().get(path).set(as('creator_one')).expect(200);
    await http().get(path).set(as('creator_two')).expect(404);
    await http().get(path).set(as('am')).expect(200);

    r = await http().post(`/workspace/briefs/${briefId}/approve`).set(as('am')).expect(200);
    expect(r.body.status).toBe('approved');
    expect(r.body.payout).toMatchObject({ amountPaise: 1_000_000, tdsPaise: 100_000, netPaise: 900_000, status: 'pending' });
    await http().post(`/workspace/briefs/${briefId}/approve`).set(as('am')).expect(400);
    expect(await prisma.creatorPayout.count({ where: { briefId } })).toBe(1);

    const payouts = await http().get('/workspace/creator/payouts').set(as('creator_one')).expect(200);
    expect(payouts.body.totals).toMatchObject({ pendingPaise: 900_000, tdsPaise: 100_000 });
    const other = await http().get('/workspace/creator/payouts').set(as('creator_two')).expect(200);
    expect(other.body.items).toHaveLength(0);
  });

  it('lets creators edit their niche and rates', async () => {
    const r = await http().put('/workspace/creator/profile').set(as('creator_two')).send({ niche: ['Travel'], rates: [{ label: 'Reel', pricePaise: 500000 }] }).expect(200);
    expect(r.body).toMatchObject({ niche: ['Travel'], rates: [{ label: 'Reel', pricePaise: 500000 }] });
  });
});

describe('client report and team users', () => {
  it('builds a monthly report for the client only', async () => {
    const r = await http().get('/workspace/client/report?month=2026-10').set(as('owner')).expect(200);
    expect(r.body.period).toBe('2026-10');
    expect(r.body.stats).toMatchObject({ deliverablesApproved: 0, requestsResolved: 0 });
    expect(r.body.spend).not.toBeNull();
    const viewer = await http().get('/workspace/client/report?month=2026-10').set(as('viewer')).expect(200);
    expect(viewer.body.spend).toBeNull();
    await http().get('/workspace/client/report').set(as('am')).expect(403);
  });

  let invitedId: string;
  it('lets only the owner invite team users', async () => {
    await http().post('/workspace/client/team').set(as('viewer')).send({ name: 'Nope', email: `nope.${stamp}@example.com`, role: 'client_viewer' }).expect(403);
    const r = await http().post('/workspace/client/team').set(as('owner')).send({ name: 'New Approver', email: `ws.new.${stamp}@example.com`, role: 'client_approver' }).expect(201);
    const added = r.body.members.find((m: { email: string }) => m.email === `ws.new.${stamp}@example.com`);
    expect(added).toMatchObject({ role: 'client_approver', status: 'active' });
    invitedId = added.id;
    const u = await prisma.user.findUniqueOrThrow({ where: { id: invitedId }, include: { roles: { include: { role: true } } } });
    expect(u.type).toBe('client');
    expect(u.roles.map((x) => x.role.baseRole)).toEqual(['client_approver']);
    await http().post('/workspace/client/team').set(as('owner')).send({ name: 'Dup', email: `ws.new.${stamp}@example.com`, role: 'client_viewer' }).expect(400);
    const view = await http().get('/workspace/client/team').set(as('viewer')).expect(200);
    expect(view.body.canManage).toBe(false);
  });

  it('changes roles and deactivates, but never removes the last owner', async () => {
    await http().patch(`/workspace/client/team/${ownerId}`).set(as('owner')).send({ active: false }).expect(400);
    await http().patch(`/workspace/client/team/${ownerId}`).set(as('owner')).send({ role: 'client_viewer' }).expect(400);
    let r = await http().patch(`/workspace/client/team/${invitedId}`).set(as('owner')).send({ role: 'client_finance' }).expect(200);
    expect(r.body.members.find((m: { id: string }) => m.id === invitedId).role).toBe('client_finance');
    const roles = await prisma.userRole.findMany({ where: { userId: invitedId }, include: { role: true } });
    expect(roles.map((x) => x.role.baseRole)).toEqual(['client_finance']);
    r = await http().patch(`/workspace/client/team/${invitedId}`).set(as('owner')).send({ active: false }).expect(200);
    expect(r.body.members.find((m: { id: string }) => m.id === invitedId).status).toBe('suspended');
    await http().patch(`/workspace/client/team/${invitedId}`).set(as('viewer')).send({ active: true }).expect(403);
  });
});
