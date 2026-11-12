// v50: Daily reports (end-of-day reports go up the reporting line; Founders file none) and Raise an issue with HR
// (confidential: the person and HR only).
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
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
const ids: Record<string, string> = {};
const stamp = Date.now().toString(36);
let tempUserId: string;
let designDept: { id: string; headUserId: string | null };
const issueIds: string[] = [];

async function signIn(email: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier: email }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier: email, code: otp.body.devCode }).expect(200)).body.token as string;
}

const PEOPLE = { founder: 'founder@bmu.demo', admin: 'admin@bmu.demo', head: 'design.head@bmu.demo', producer: 'producer@bmu.demo', hr: 'hr@bmu.demo', amLead: 'am.lead@bmu.demo', am: 'am@bmu.demo', client: 'client@sunrise.demo' };

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  prisma = app.get(PrismaService);

  for (const [k, email] of Object.entries(PEOPLE)) {
    const u = await prisma.user.findFirst({ where: { email } });
    if (u) ids[k] = u.id;
  }
  // Seeded reporting lines: Branch Manager → Founder, Design Head → Branch Manager, Producer → Design Head,
  // HR → Branch Manager, Client Manager Lead → Branch Manager, Client Manager → Client Manager Lead.
  const producer = await prisma.user.findUniqueOrThrow({ where: { id: ids.producer }, select: { departmentId: true, orgId: true } });
  designDept = await prisma.department.findUniqueOrThrow({ where: { id: producer.departmentId! }, select: { id: true, headUserId: true } });
  // The Design Head heads the producer's department; a new joiner there reports to the Branch Manager instead.
  await prisma.department.update({ where: { id: designDept.id }, data: { headUserId: ids.head } });
  const producerRole = await prisma.role.findFirstOrThrow({ where: { orgId: producer.orgId, baseRole: 'producer', isCustom: false } });
  const temp = await prisma.user.create({
    data: { orgId: producer.orgId, type: 'staff', name: `Dept Joiner ${stamp}`, email: `joiner.${stamp}@example.com`, status: 'active', departmentId: designDept.id, managerId: ids.admin, roles: { create: { roleId: producerRole.id } } },
  });
  tempUserId = temp.id;

  for (const k of Object.keys(PEOPLE)) tokens[k] = await signIn(PEOPLE[k as keyof typeof PEOPLE]);
});

afterAll(async () => {
  if (issueIds.length) await prisma.hrIssue.deleteMany({ where: { id: { in: issueIds } } });
  if (tempUserId) {
    await prisma.eODReport.deleteMany({ where: { userId: tempUserId } });
    await prisma.userRole.deleteMany({ where: { userId: tempUserId } });
    await prisma.userSession.deleteMany({ where: { userId: tempUserId } });
    await prisma.user.delete({ where: { id: tempUserId } }).catch(() => {});
  }
  if (designDept) await prisma.department.update({ where: { id: designDept.id }, data: { headUserId: designDept.headUserId } });
  await app.close();
});

const eod = { completed: ['Reel cut v2'], pending: ['Thumbnail'], blocked: ['Music licence (waiting on client)'], waiting: [] };
type Person = { id: string; name: string; role: string; report: typeof eod | null };
const team = async (who: string, date?: string) => (await http().get(`/my-day/eod/team${date ? `?date=${date}` : ''}`).set(as(who)).expect(200)).body as { date: string; today: string; people: Person[] };
const idsOf = (v: { people: Person[] }) => v.people.map((p) => p.id);

describe('Daily reports', () => {
  it('Founders file no end-of-day report and see the people who report to them', async () => {
    const day = (await http().get('/my-day').set(as('founder')).expect(200)).body;
    expect(day.eodExempt).toBe(true);
    await http().put('/my-day/eod').set(as('founder')).send(eod).expect(403);
    const v = await team('founder');
    expect(idsOf(v)).toContain(ids.admin);
    // Only their direct reports, not the whole company.
    expect(idsOf(v)).not.toContain(ids.producer);
    expect(idsOf(v)).not.toContain(ids.head);
    expect(idsOf(v)).not.toContain(ids.founder);
    expect(day.teamReports.total).toBe(v.people.length);
  });

  it('a report goes up to the person they report to, and to their Department Head', async () => {
    await http().put('/my-day/eod').set(as('producer')).send(eod).expect(200);
    const head = await team('head');
    const mine = head.people.find((p) => p.id === ids.producer)!;
    expect(mine.report).toMatchObject(eod);
    expect(mine.role).toBeTruthy();
    // Someone in the department they head, even though that person reports to the Branch Manager.
    expect(idsOf(head)).toContain(tempUserId);
    expect(head.people.find((p) => p.id === tempUserId)!.report).toBeNull();
    // The Branch Manager sees their own reports (the Design Head, the joiner), not the producer two levels down.
    const admin = await team('admin');
    expect(idsOf(admin)).toEqual(expect.arrayContaining([ids.head, ids.hr, ids.amLead, tempUserId]));
    expect(idsOf(admin)).not.toContain(ids.producer);
    // The Client Manager Lead sees their Client Managers.
    expect(idsOf(await team('amLead'))).toContain(ids.am);
    const day = (await http().get('/my-day').set(as('head')).expect(200)).body;
    expect(day.eodExempt).toBeFalsy();
    expect(day.teamReports.submitted).toBeGreaterThanOrEqual(1);
  });

  it('people with no one under them see an empty list; the menu follows', async () => {
    expect((await team('producer')).people).toEqual([]);
    expect((await http().get('/my-day').set(as('producer')).expect(200)).body.teamReports).toBeNull();
    expect((await http().get('/auth/me').set(as('producer')).expect(200)).body.leadsPeople).toBe(false);
    expect((await http().get('/auth/me').set(as('head')).expect(200)).body.leadsPeople).toBe(true);
    expect((await http().get('/auth/me').set(as('founder')).expect(200)).body.leadsPeople).toBe(true);
  });

  it('past days, future days and bad dates', async () => {
    const today = istDate(new Date());
    const past = await team('head', '2026-01-05');
    expect(past.date).toBe('2026-01-05');
    expect(past.people.find((p) => p.id === ids.producer)!.report).toBeNull();
    expect((await team('head', '2999-01-01')).date).toBe(today);
    await http().get('/my-day/eod/team?date=yesterday').set(as('head')).expect(400);
    await http().get('/my-day/eod/team').set(as('client')).expect(403);
  });
});

describe('Raise an issue with HR', () => {
  const issue = { category: 'workload', subject: `Too many weekend shoots ${stamp}`, details: 'Three weekends in a row on shoots, no comp-off yet.' };
  type Issue = { id: string; status: string; response: string | null; resolvedAt: string | null; from?: { id: string; name: string } };

  it('any team member raises one; HR are told; only they and HR can see it', async () => {
    const raised = (await http().post('/hr-issues').set(as('producer')).send(issue).expect(201)).body as Issue;
    issueIds.push(raised.id);
    expect(raised).toMatchObject({ status: 'open', response: null });
    expect(raised.from).toBeUndefined();
    const told = await prisma.notification.findFirst({ where: { userId: ids.hr, kind: 'hr_issue', title: { contains: issue.subject } } });
    expect(told?.link).toBe('/team/hr-issues');
    expect(((await http().get('/hr-issues/mine').set(as('producer')).expect(200)).body as Issue[]).map((i) => i.id)).toContain(raised.id);
    // HR's list says who raised it.
    const inbox = (await http().get('/hr-issues').set(as('hr')).expect(200)).body as Issue[];
    expect(inbox.find((i) => i.id === raised.id)?.from?.id).toBe(ids.producer);
    // Confidential: not their Department Head, the Branch Manager or the Founder; and not in the Audit Log.
    for (const who of ['head', 'admin', 'founder']) await http().get('/hr-issues').set(as(who)).expect(403);
    await http().patch(`/hr-issues/${raised.id}`).set(as('producer')).send({ status: 'resolved' }).expect(403);
    expect(await prisma.auditEvent.count({ where: { entityId: raised.id } })).toBe(0);
  });

  it('HR reply (the person is told), then resolve', async () => {
    const id = issueIds[0];
    const replied = (await http().patch(`/hr-issues/${id}`).set(as('hr')).send({ response: 'Thanks for telling us. Comp-off approved for next Friday.' }).expect(200)).body as Issue;
    expect(replied.status).toBe('in_progress');
    expect(await prisma.notification.findFirst({ where: { userId: ids.producer, kind: 'hr_issue_update', title: { contains: 'HR replied' } } })).toBeTruthy();
    const done = (await http().patch(`/hr-issues/${id}`).set(as('hr')).send({ status: 'resolved' }).expect(200)).body as Issue;
    expect(done.status).toBe('resolved');
    expect(done.resolvedAt).toBeTruthy();
    const mine = ((await http().get('/hr-issues/mine').set(as('producer')).expect(200)).body as Issue[]).find((i) => i.id === id)!;
    expect(mine).toMatchObject({ status: 'resolved', response: 'Thanks for telling us. Comp-off approved for next Friday.' });
    // Resolved issues leave HR's open list.
    expect(((await http().get('/hr-issues').set(as('hr')).expect(200)).body as Issue[]).map((i) => i.id)).not.toContain(id);
    expect(((await http().get('/hr-issues?status=resolved').set(as('hr')).expect(200)).body as Issue[]).map((i) => i.id)).toContain(id);
  });

  it('checks what is sent; clients cannot use it', async () => {
    await http().post('/hr-issues').set(as('producer')).send({ ...issue, details: 'short' }).expect(400);
    await http().post('/hr-issues').set(as('producer')).send({ ...issue, category: 'gossip' }).expect(400);
    await http().post('/hr-issues').set(as('client')).send(issue).expect(403);
  });

  it("HR's own issue goes to the rest of HR, never to themselves", async () => {
    const otherHr = await prisma.user.count({ where: { id: { not: ids.hr }, type: 'staff', status: 'active', deletedAt: null, roles: { some: { role: { baseRole: 'hr_ops' } } } } });
    const res = await http().post('/hr-issues').set(as('hr')).send({ ...issue, subject: `HR own ${stamp}` });
    if (!otherHr) return expect(res.status).toBe(400);
    expect(res.status).toBe(201);
    issueIds.push(res.body.id);
    expect(((await http().get('/hr-issues').set(as('hr')).expect(200)).body as Issue[]).map((i) => i.id)).not.toContain(res.body.id);
    await http().patch(`/hr-issues/${res.body.id}`).set(as('hr')).send({ status: 'resolved' }).expect(403);
  });
});
