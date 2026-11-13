// v51 custom charts: extra org charts from existing team members, apart from the real hierarchy (chart only).
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
const ids: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const stamp = Date.now();
const chartIds: string[] = [];

async function signIn(identifier: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier, code: otp.body.devCode }).expect(200)).body.token as string;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  prisma = app.get(PrismaService);
  for (const who of ['founder', 'admin', 'design.head', 'producer', 'am']) {
    tokens[who] = await signIn(`${who}@bmu.demo`);
    ids[who] = (await http().get('/auth/me').set(as(who)).expect(200)).body.id;
  }
});

afterAll(async () => {
  if (chartIds.length) await prisma.orgChart.deleteMany({ where: { id: { in: chartIds } } });
  await app.close();
});

describe('custom charts', () => {
  let chartId: string;

  it('a Branch Manager builds a chart: top person, people under them, a label', async () => {
    const c = (await http().post('/admin-org/charts').set(as('admin')).send({ name: `Diwali team ${stamp}`, description: 'October launch' }).expect(201)).body;
    chartId = c.id;
    chartIds.push(c.id);
    expect(c.members).toHaveLength(0);
    await http().post(`/admin-org/charts/${chartId}/members`).set(as('admin')).send({ userId: ids['design.head'], label: 'Campaign lead' }).expect(201);
    await http().post(`/admin-org/charts/${chartId}/members`).set(as('admin')).send({ userId: ids.am, parentUserId: ids['design.head'] }).expect(201);
    const v = (await http().post(`/admin-org/charts/${chartId}/members`).set(as('admin')).send({ userId: ids.producer, parentUserId: ids.am }).expect(201)).body;
    const by = new Map(v.members.map((m: { userId: string }) => [m.userId, m]));
    expect(by.get(ids['design.head'])).toMatchObject({ parentUserId: null, label: 'Campaign lead' });
    expect(by.get(ids.producer)).toMatchObject({ parentUserId: ids.am });
  });

  it('the real hierarchy is untouched', async () => {
    const producer = await prisma.user.findUniqueOrThrow({ where: { id: ids.producer }, select: { managerId: true } });
    expect(producer.managerId).not.toBe(ids.am);
  });

  it('no one can sit under their own reports, and no one is added twice', async () => {
    await http().patch(`/admin-org/charts/${chartId}/members/${ids['design.head']}`).set(as('admin')).send({ parentUserId: ids.producer }).expect(400);
    await http().post(`/admin-org/charts/${chartId}/members`).set(as('admin')).send({ userId: ids.am }).expect(409);
  });

  it('removing someone moves the people under them up a level', async () => {
    const v = (await http().delete(`/admin-org/charts/${chartId}/members/${ids.am}`).set(as('admin')).expect(200)).body;
    expect(v.members.find((m: { userId: string }) => m.userId === ids.producer).parentUserId).toBe(ids['design.head']);
  });

  it('Department Heads can look but not change; people without the Hierarchy page cannot look', async () => {
    const list = (await http().get('/admin-org/charts').set(as('design.head')).expect(200)).body;
    expect(list.canEdit).toBe(false);
    expect(list.charts.some((c: { id: string }) => c.id === chartId)).toBe(true);
    await http().post(`/admin-org/charts/${chartId}/members`).set(as('design.head')).send({ userId: ids.founder }).expect(403);
    await http().get('/admin-org/charts').set(as('producer')).expect(403);
  });

  it('a chart can start from a copy of the reporting lines, and names are unique', async () => {
    await http().post('/admin-org/charts').set(as('founder')).send({ name: `diwali TEAM ${stamp}` }).expect(409);
    const c = (await http().post('/admin-org/charts').set(as('founder')).send({ name: `Copy ${stamp}`, startFrom: 'reporting' }).expect(201)).body;
    chartIds.push(c.id);
    const producer = await prisma.user.findUniqueOrThrow({ where: { id: ids.producer }, select: { managerId: true } });
    expect(c.members.find((m: { userId: string }) => m.userId === ids.producer).parentUserId).toBe(producer.managerId);
  });

  it('deleting a chart leaves everyone where they were', async () => {
    await http().delete(`/admin-org/charts/${chartId}`).set(as('admin')).expect(200);
    await http().get(`/admin-org/charts/${chartId}`).set(as('admin')).expect(404);
    expect(await prisma.orgChartMember.count({ where: { chartId } })).toBe(0);
  });
});
