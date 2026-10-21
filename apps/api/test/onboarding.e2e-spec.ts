// Onboarding to plan approval: requirements → RCD (Gate 1) → plan → client approval (Gate 2).
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { fillOpenStepsAutomatically } from '../src/production/generate.js';

let app: INestApplication;
const tokens: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
let engagementId: string;
let itemIds: string[];

async function signIn(email: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier: email }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier: email, code: otp.body.devCode }).expect(200)).body.token as string;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();

  // A fresh client with one engagement for each run.
  const prisma = app.get(PrismaService);
  const stamp = Date.now();
  const org = await prisma.organisation.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  const am = await prisma.user.findFirstOrThrow({ where: { email: 'am@bmu.demo' } });
  const ownerRole = await prisma.role.findFirstOrThrow({ where: { orgId: org.id, baseRole: 'client_owner', isCustom: false } });
  const service = await prisma.service.findFirstOrThrow({ where: { key: 'seo', priceBook: { orgId: org.id, status: 'active' } } });
  const client = await prisma.clientOrg.create({ data: { orgId: org.id, name: `Onboarding Test ${stamp}`, amUserId: am.id } });
  const owner = await prisma.user.create({
    data: { orgId: org.id, type: 'client', name: 'Owner', email: `onb.${stamp}@example.com`, status: 'active', roles: { create: { roleId: ownerRole.id } } },
  });
  await prisma.clientUser.create({ data: { userId: owner.id, orgId: org.id, clientOrgId: client.id, clientRole: 'client_owner', brandScope: [] } });
  const engagement = await prisma.engagement.create({
    data: {
      orgId: org.id,
      clientOrgId: client.id,
      serviceId: service.id,
      tier: 'growth',
      billingType: 'monthly',
      status: 'onboarding',
      amId: am.id,
      cycles: {
        create: {
          orgId: org.id,
          period: '2026-10',
          requirements: { create: [{ orgId: org.id, label: 'Questionnaire', type: 'info' }, { orgId: org.id, label: 'Search Console access', type: 'access' }] },
        },
      },
    },
    include: { cycles: { include: { requirements: true } } },
  });
  engagementId = engagement.id;
  itemIds = engagement.cycles[0].requirements.map((r) => r.id);

  for (const who of ['am', 'strategist', 'producer', 'sales']) tokens[who] = await signIn(`${who}@bmu.demo`);
  tokens.client = await signIn(owner.email!);
});

afterAll(async () => {
  await app.close();
});

describe('requirements and Gate 1', () => {
  it('people outside the pod cannot see the engagement', async () => {
    await http().get(`/engagements/${engagementId}`).set(as('sales')).expect(404);
  });

  it('planning cannot start before RCD', async () => {
    await http().put(`/engagements/${engagementId}/plan`).set(as('strategist')).send({ deliverables: [] }).expect(400);
  });

  it('the client sends an item; it waits for BMU to review', async () => {
    const res = await http().post(`/client/requirements/${itemIds[0]}/submit`).set(as('client')).send({ note: 'https://forms.example/answers' }).expect(200);
    const eng = res.body.engagements.find((e: { id: string }) => e.id === engagementId);
    expect(eng.requirements.find((r: { id: string }) => r.id === itemIds[0]).status).toBe('waiting');
  });

  it('RCD is refused while items are outstanding', async () => {
    await http().post(`/engagements/${engagementId}/rcd`).set(as('am')).expect(400);
  });

  it('a blocked item needs a reason', async () => {
    await http().patch(`/engagements/requirements/${itemIds[1]}`).set(as('am')).send({ status: 'blocked' }).expect(400);
    const res = await http()
      .patch(`/engagements/requirements/${itemIds[1]}`)
      .set(as('am'))
      .send({ status: 'blocked', blockedReason: 'Client lost the Google login', waitingFor: 'Client IT team' })
      .expect(200);
    expect(res.body.status).toBe('blocked');
  });

  it('only the CM (or above) confirms items and sets RCD', async () => {
    await http().patch(`/engagements/requirements/${itemIds[0]}`).set(as('strategist')).send({ status: 'received' }).expect(403);
    for (const id of itemIds) await http().patch(`/engagements/requirements/${id}`).set(as('am')).send({ status: 'received' }).expect(200);
    await http().post(`/engagements/${engagementId}/rcd`).set(as('strategist')).expect(403);
    const res = await http().post(`/engagements/${engagementId}/rcd`).set(as('am')).expect(200);
    expect(res.body.currentGate).toBe('G2');
    expect(res.body.cycle.planningDue).toBeTruthy();
    // requirements lock after RCD
    await http().patch(`/engagements/requirements/${itemIds[0]}`).set(as('am')).send({ status: 'pending' }).expect(400);
  });
});

describe('plan and Gate 2', () => {
  const plan = { objectives: 'Rank for 20 local keywords', pillars: ['Local SEO'], deliverables: [{ type: 'blog', title: '4 blog posts' }, { type: 'report', title: 'Monthly report' }] };

  it('the strategist drafts and submits; the client sees nothing yet', async () => {
    await http().put(`/engagements/${engagementId}/plan`).set(as('strategist')).send(plan).expect(200);
    await http().post(`/engagements/${engagementId}/plan/submit`).set(as('strategist')).expect(200);
    expect((await http().get('/client/plans').set(as('client')).expect(200)).body).toHaveLength(0);
  });

  it('the strategist cannot send it to the client; the CM can', async () => {
    await http().post(`/engagements/${engagementId}/plan/send`).set(as('strategist')).expect(403);
    await http().post(`/engagements/${engagementId}/plan/send`).set(as('am')).expect(200);
  });

  it('the client asks for changes, then approves the revision', async () => {
    let plans = (await http().get('/client/plans').set(as('client')).expect(200)).body;
    await http().post(`/client/plans/${plans[0].plan.id}/request-changes`).set(as('client')).send({ comment: 'Add Kannada keywords' }).expect(200);
    await http().put(`/engagements/${engagementId}/plan`).set(as('strategist')).send({ ...plan, pillars: ['Local SEO', 'Kannada keywords'] }).expect(200);
    await http().post(`/engagements/${engagementId}/plan/submit`).set(as('strategist')).expect(200);
    await http().post(`/engagements/${engagementId}/plan/send`).set(as('am')).expect(200);
    plans = (await http().get('/client/plans').set(as('client')).expect(200)).body;
    expect(plans[0].plan.clientComments[0].body).toBe('Add Kannada keywords');
    await http().post(`/client/plans/${plans[0].plan.id}/approve`).set(as('client')).expect(200);
    // v37: the Department Heads pick the team by hand; here the old automatic pick stands in for them.
    await fillOpenStepsAutomatically(app.get(PrismaService), engagementId);
    const detail = (await http().get(`/engagements/${engagementId}`).set(as('am')).expect(200)).body;
    expect(detail.currentGate).toBe('G4'); // tasks generated and assigned, so Gate 3 passes too
    expect(detail.plan.status).toBe('approved');
    expect(detail.deliverables).toHaveLength(2);
  });

  it('an approved plan is locked', async () => {
    await http().put(`/engagements/${engagementId}/plan`).set(as('strategist')).send(plan).expect(400);
  });
});
