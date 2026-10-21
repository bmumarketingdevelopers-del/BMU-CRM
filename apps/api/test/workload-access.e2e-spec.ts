// Workload (weekly hours) access: Founders, Branch Managers, HR, the CM Lead, Client Managers and producers see
// everyone; a Department Head sees, books and sets the weekly hours of only their own department's people; anyone
// else sees only their own row.
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { WorkloadView } from '@bmu/shared';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

let app: INestApplication;
let prisma: PrismaService;
const tokens: Record<string, string> = {};
const users: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

const EMAILS = {
  founder: 'founder@bmu.demo',
  admin: 'admin@bmu.demo',
  hr: 'hr@bmu.demo',
  amLead: 'am.lead@bmu.demo',
  am: 'am@bmu.demo',
  producer: 'producer@bmu.demo',
  designHead: 'design.head@bmu.demo',
  design: 'design@bmu.demo',
  dev: 'dev@bmu.demo',
  sales: 'sales@bmu.demo',
  finance: 'finance@bmu.demo',
  qc: 'qc@bmu.demo',
};

async function signIn(email: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier: email }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier: email, code: otp.body.devCode }).expect(200)).body.token as string;
}

const people = async (who: string) => ((await http().get('/capacity/workload?weeks=1').set(as(who)).expect(200)).body as WorkloadView).people.map((p) => p.userId);
let designDept: string[] = [];
const hoursBefore: Record<string, number> = {};

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  prisma = app.get(PrismaService);
  for (const [k, email] of Object.entries(EMAILS)) {
    tokens[k] = await signIn(email);
    const u = await prisma.user.findFirstOrThrow({ where: { email }, select: { id: true, weeklyHours: true } });
    users[k] = u.id;
    hoursBefore[k] = u.weeklyHours;
  }
  const head = await prisma.department.findFirstOrThrow({ where: { headUserId: users.designHead }, select: { id: true } });
  designDept = (await prisma.user.findMany({ where: { departmentId: head.id, type: 'staff' }, select: { id: true } })).map((u) => u.id);
});

afterAll(async () => {
  for (const k of ['design', 'dev']) await prisma.user.update({ where: { id: users[k] }, data: { weeklyHours: hoursBefore[k] } });
  await app.close();
});

describe('who sees weekly hours on Workload', () => {
  it('Founders, Branch Managers, HR, the CM Lead, Client Managers and producers see every department', async () => {
    for (const who of ['founder', 'admin', 'hr', 'amLead', 'am', 'producer']) {
      const ids = await people(who);
      expect(ids, who).toEqual(expect.arrayContaining([users.design, users.dev, users.sales]));
    }
  });

  it('a Department Head sees only their own department', async () => {
    const ids = await people('designHead');
    expect(ids).toEqual(expect.arrayContaining([users.designHead, users.design, users.producer]));
    expect(ids.every((id) => designDept.includes(id) || id === users.designHead)).toBe(true);
    expect(ids).not.toContain(users.dev);
    expect(ids).not.toContain(users.sales);
  });

  it('everyone else sees only their own row', async () => {
    for (const who of ['finance', 'qc', 'sales']) expect(await people(who), who).toEqual([users[who]]);
  });

  it("a Department Head sets only their department's weekly hours; HR and leadership set anyone's", async () => {
    await http().put(`/capacity/people/${users.design}/hours`).set(as('designHead')).send({ weeklyHours: 42 }).expect(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: users.design } })).weeklyHours).toBe(42);
    const no = await http().put(`/capacity/people/${users.dev}/hours`).set(as('designHead')).send({ weeklyHours: 10 }).expect(403);
    expect(no.body.message).toContain('own department');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: users.dev } })).weeklyHours).toBe(hoursBefore.dev);
    for (const who of ['hr', 'admin', 'founder']) await http().put(`/capacity/people/${users.dev}/hours`).set(as(who)).send({ weeklyHours: 40 }).expect(200);
    await http().put(`/capacity/people/${users.dev}/hours`).set(as('finance')).send({ weeklyHours: 40 }).expect(403);
  });

  it("a Department Head is offered and can book only their department's people", async () => {
    const monday = (() => {
      const d = new Date(Date.now() + 7 * 86_400_000);
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      return d.toISOString().slice(0, 10);
    })();
    const s = (await http().get(`/capacity/suggest?weekStart=${monday}`).set(as('designHead')).expect(200)).body as { candidates: { userId: string }[] };
    expect(s.candidates.every((c) => designDept.includes(c.userId))).toBe(true);
    const eng = await prisma.engagement.findFirstOrThrow({ where: { deletedAt: null }, select: { id: true } });
    const out = await http().post('/capacity/bookings').set(as('designHead')).send({ engagementId: eng.id, userId: users.dev, weekStart: monday, weeks: 1, hours: 2 }).expect(403);
    expect(out.body.message).toContain('own department');
  });
});

describe('skill requests', () => {
  it("a request tells the project's Client Manager, the CM Lead and the skill's Department Head; filling it tells the asker and the person", async () => {
    const since = new Date();
    const specialty = (await prisma.user.findUniqueOrThrow({ where: { id: users.design }, select: { specialty: true } })).specialty!;
    const eng = await prisma.engagement.findFirstOrThrow({ where: { deletedAt: null, amId: { not: null } }, select: { id: true, amId: true } });
    const d = new Date(Date.now() + 14 * 86_400_000);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const monday = d.toISOString().slice(0, 10);
    const posted = (await http().post('/capacity/bookings').set(as('founder')).send({ engagementId: eng.id, specialty, weekStart: monday, weeks: 1, hours: 1 }).expect(201)).body as { created: { id: string }[] };
    const requestId = posted.created[0].id;
    const told = async (userId: string, title: string) => prisma.notification.count({ where: { userId, createdAt: { gte: since }, title: { contains: title } } });
    for (const id of [eng.amId!, users.amLead, users.designHead]) expect(await told(id, 'needs a'), id).toBe(1);
    expect(await told(users.founder, 'needs a')).toBe(0); // not the person who asked
    expect(await told(users.dev, 'needs a')).toBe(0);
    // The design head sees it, finds someone free in their department and fills it.
    const view = (await http().get(`/capacity/workload?from=${monday}&weeks=1`).set(as('designHead')).expect(200)).body as WorkloadView;
    expect(view.requests.some((r) => r.id === requestId)).toBe(true);
    const s = (await http().get(`/capacity/suggest?weekStart=${monday}&specialty=${specialty}&hours=1`).set(as('designHead')).expect(200)).body as { candidates: { userId: string }[] };
    const pick = s.candidates[0]?.userId;
    expect(pick && designDept.includes(pick)).toBe(true);
    await http().patch(`/capacity/bookings/${requestId}`).set(as('designHead')).send({ userId: pick }).expect(200);
    expect(await told(users.founder, 'is booked for your')).toBe(1);
    if (pick !== users.designHead) expect(await told(pick!, 'Booked 1h on')).toBe(1);
    await prisma.resourceBooking.delete({ where: { id: requestId } });
  });
});
