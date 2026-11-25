// v53: a Department Head sees only the clients and projects their department works on or they are assigned to. Other
// roles keep what they had; work given to the department opens the client straight away, and cancelled work closes it.
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
const NAME = { ours: `Head Scope Ours ${stamp}`, other: `Head Scope Other ${stamp}` };

async function signIn(email: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier: email }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier: email, code: otp.body.devCode }).expect(200)).body.token as string;
}
const body = async (who: string, path: string) => JSON.stringify((await http().get(path).set(as(who)).expect(200)).body);

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  prisma = app.get(PrismaService);
  const org = await prisma.organisation.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  ids.org = org.id;
  const people = { founder: 'founder@bmu.demo', amLead: 'am.lead@bmu.demo', am: 'am@bmu.demo', finance: 'finance@bmu.demo', head: 'design.head@bmu.demo', designer: 'design@bmu.demo' };
  for (const [k, email] of Object.entries(people)) {
    tokens[k] = await signIn(email);
    ids[k] = (await prisma.user.findFirstOrThrow({ where: { email } })).id;
  }
  ids.dept = (await prisma.department.findFirstOrThrow({ where: { headUserId: ids.head, deletedAt: null } })).id;
  const svc = await prisma.service.findFirstOrThrow({ where: { orgId: org.id, key: 'website' } });
  for (const k of ['ours', 'other'] as const) {
    const c = await prisma.clientOrg.create({ data: { orgId: org.id, name: NAME[k], amUserId: ids.am, engagements: { create: { orgId: org.id, serviceId: svc.id, tier: 'growth', billingType: 'one_time', status: 'in_production', currentGate: 'G4', amId: ids.am } } }, include: { engagements: true } });
    ids[`${k}Client`] = c.id;
    ids[`${k}Eng`] = c.engagements[0].id;
  }
  await prisma.task.create({ data: { orgId: org.id, engagementId: ids.oursEng, departmentId: ids.dept, title: `Scope task ${stamp}` } });
  const cycle = await prisma.cycle.create({ data: { orgId: org.id, engagementId: ids.otherEng, period: 'project', status: 'production', requirements: { create: { orgId: org.id, label: 'Website admin access', type: 'access' } } } });
  ids.otherDeliv = (await prisma.deliverable.create({ data: { orgId: org.id, cycleId: cycle.id, type: 'web_page', title: `Scope page ${stamp}` } })).id;
});

afterAll(async () => {
  const engs = [ids.oursEng, ids.otherEng];
  await prisma.projectEstimate.deleteMany({ where: { engagementId: { in: engs } } });
  await prisma.task.deleteMany({ where: { engagementId: { in: engs } } });
  await prisma.deliverable.deleteMany({ where: { cycle: { engagementId: { in: engs } } } });
  await prisma.requirementItem.deleteMany({ where: { cycle: { engagementId: { in: engs } } } });
  await prisma.cycle.deleteMany({ where: { engagementId: { in: engs } } });
  await prisma.engagement.deleteMany({ where: { id: { in: engs } } });
  await prisma.clientOrg.deleteMany({ where: { id: { in: [ids.oursClient, ids.otherClient] } } });
  await app.close();
});

const LISTS = ['/engagements', '/clients', '/clients-actions/list', '/creative/brand-kits', '/ops/threads/options', '/tasks/form-options', '/flows/journeys', '/insights/client-health', '/flows/map'];

describe('a Department Head', () => {
  it('finds the client their department works on, and not the other one, in every list and in search', async () => {
    for (const path of LISTS) {
      const b = await body('head', path);
      expect(b.includes(NAME.other), `${path} must not show the other client`).toBe(false);
    }
    for (const path of ['/engagements', '/clients', '/clients-actions/list', '/creative/brand-kits', '/tasks/form-options']) expect(await body('head', path), path).toContain(NAME.ours);
    expect(await body('head', `/team-flows/search?q=${encodeURIComponent('Head Scope')}`)).not.toContain(NAME.other);
    expect(await body('head', `/team-flows/search?q=${encodeURIComponent('Head Scope')}`)).toContain(NAME.ours);
  });

  it('opens their client and project, but not the other one by its address', async () => {
    await http().get(`/engagements/${ids.oursEng}`).set(as('head')).expect(200);
    await http().get(`/clients-actions/${ids.oursClient}`).set(as('head')).expect(200);
    await http().get(`/engagements/${ids.otherEng}`).set(as('head')).expect(404);
    await http().get(`/clients/${ids.otherClient}`).set(as('head')).expect(404);
    await http().get(`/clients-actions/${ids.otherClient}`).set(as('head')).expect(403);
    await http().get(`/craft/brand/${ids.otherClient}`).set(as('head')).expect(403);
    await http().get(`/deliverables/${ids.otherDeliv}`).set(as('head')).expect(404);
    await http().get(`/flows/engagements/${ids.otherEng}/journey`).set(as('head')).expect(404);
    await http().get(`/project-flow/projects/${ids.otherEng}`).set(as('head')).expect(404);
    await http().get(`/team-flows/activity?entity=ClientOrg&id=${ids.otherClient}`).set(as('head')).expect(403);
  });

  it('cannot open a client up by adding a task to it', async () => {
    const r = await http().post('/tasks').set(as('head')).send({ title: `Scope way in ${stamp}`, engagementId: ids.otherEng, departmentId: ids.dept, ownerId: ids.designer, deadline: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10) }).expect(403);
    expect(r.body.message).toMatch(/projects your department works on/);
    await http().get(`/engagements/${ids.otherEng}`).set(as('head')).expect(404);
  });

  it('sees a project as soon as they are asked about it or it has work for their department; not once that is cancelled', async () => {
    const est = await prisma.projectEstimate.create({ data: { orgId: ids.org, engagementId: ids.otherEng, departmentId: ids.dept, headId: ids.head } });
    await http().get(`/engagements/${ids.otherEng}`).set(as('head')).expect(200);
    await prisma.projectEstimate.delete({ where: { id: est.id } });
    await http().get(`/engagements/${ids.otherEng}`).set(as('head')).expect(404);
    // A task owned by someone in the department counts too, whichever department the task is in.
    const t = await prisma.task.create({ data: { orgId: ids.org, engagementId: ids.otherEng, ownerId: ids.designer, title: `Scope owned ${stamp}` } });
    await http().get(`/clients-actions/${ids.otherClient}`).set(as('head')).expect(200);
    await prisma.task.update({ where: { id: t.id }, data: { status: 'cancelled' } });
    await http().get(`/clients-actions/${ids.otherClient}`).set(as('head')).expect(403);
    // A deliverable of the department.
    await prisma.deliverable.update({ where: { id: ids.otherDeliv }, data: { departmentId: ids.dept } });
    await http().get(`/deliverables/${ids.otherDeliv}`).set(as('head')).expect(200);
    await prisma.deliverable.update({ where: { id: ids.otherDeliv }, data: { departmentId: null } });
  });
});

describe('everyone else keeps what they had', () => {
  it('Founder, CM Lead, Finance and the Client Manager still see both clients', async () => {
    for (const who of ['founder', 'amLead', 'finance', 'am']) {
      const b = await body(who, '/clients');
      expect(b, who).toContain(NAME.ours);
      expect(b, who).toContain(NAME.other);
    }
    for (const who of ['founder', 'amLead', 'am']) await http().get(`/engagements/${ids.otherEng}`).set(as(who)).expect(200);
  });
});
