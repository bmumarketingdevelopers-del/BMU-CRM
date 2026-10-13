// End-to-end permission checks against a seeded database (run `pnpm dev` once first, or
// `prisma migrate deploy && prisma db seed`). Covers the rules in permissions.matrix.
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';

let app: INestApplication;
const tokens: Record<string, string> = {};

async function signIn(email: string) {
  const otp = await request(app.getHttpServer()).post('/auth/otp/request').send({ identifier: email }).expect(200);
  const res = await request(app.getHttpServer())
    .post('/auth/otp/verify')
    .send({ identifier: email, code: otp.body.devCode })
    .expect(200);
  return res.body.token as string;
}

const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  for (const who of ['founder', 'admin', 'sales.manager', 'sales', 'producer', 'am']) {
    tokens[who] = await signIn(`${who}@bmu.demo`);
  }
  tokens.client = await signIn('client@sunrise.demo');
});

afterAll(async () => {
  await app.close();
});

describe('sign-in', () => {
  it('rejects requests without a session', async () => {
    await request(app.getHttpServer()).get('/auth/me').expect(401);
  });
  it('rejects a wrong code', async () => {
    await request(app.getHttpServer()).post('/auth/otp/request').send({ identifier: 'hr@bmu.demo' }).expect(200);
    await request(app.getHttpServer()).post('/auth/otp/verify').send({ identifier: 'hr@bmu.demo', code: '000000' }).expect(400);
  });
  it('does not reveal codes to unknown accounts', async () => {
    await request(app.getHttpServer()).post('/auth/otp/request').send({ identifier: 'stranger@example.com' }).expect(404);
  });
});

describe('leads_pipeline', () => {
  it('founder and sales manager see all leads', async () => {
    const all = await request(app.getHttpServer()).get('/leads').set(as('founder')).expect(200);
    const mgr = await request(app.getHttpServer()).get('/leads').set(as('sales.manager')).expect(200);
    expect(mgr.body.length).toBe(all.body.length);
  });
  it('sales executive sees only their own leads', async () => {
    const res = await request(app.getHttpServer()).get('/leads').set(as('sales')).expect(200);
    const me = await request(app.getHttpServer()).get('/auth/me').set(as('sales')).expect(200);
    expect(res.body.every((l: { owner: { id: string } | null }) => l.owner?.id === me.body.id)).toBe(true);
  });
  it('producer, account manager and clients have no access', async () => {
    for (const who of ['producer', 'am', 'client']) await request(app.getHttpServer()).get('/leads').set(as(who)).expect(403);
  });
  it('sales executive cannot assign leads', async () => {
    const [lead] = (await request(app.getHttpServer()).get('/leads').set(as('sales')).expect(200)).body;
    await request(app.getHttpServer()).patch(`/leads/${lead.id}`).set(as('sales')).send({ ownerId: null }).expect(403);
  });
  it('marking a lead lost needs a reason', async () => {
    const [lead] = (await request(app.getHttpServer()).get('/leads').set(as('founder')).expect(200)).body;
    await request(app.getHttpServer()).patch(`/leads/${lead.id}`).set(as('founder')).send({ stage: 'lost' }).expect(400);
  });
});

describe('catalogue_pricing_engine', () => {
  it('admin can view but only propose, not apply, price changes', async () => {
    await request(app.getHttpServer()).get('/catalogue/admin').set(as('admin')).expect(200);
    await request(app.getHttpServer())
      .patch('/catalogue/tiers')
      .set(as('admin'))
      .send({ serviceKey: 'seo', tier: 'starter', priceRupees: 1 })
      .expect(403);
  });
  it('others cannot see the pricing engine', async () => {
    await request(app.getHttpServer()).get('/catalogue/admin').set(as('sales')).expect(403);
  });
  it('the public catalogue needs no sign-in', async () => {
    await request(app.getHttpServer()).get('/catalogue/services').expect(200);
  });
});

describe('users_roles_hierarchy', () => {
  it('only the Founder changes role permissions', async () => {
    const roles = (await request(app.getHttpServer()).get('/org/roles').set(as('founder')).expect(200)).body;
    const producer = roles.find((r: { baseRole: string }) => r.baseRole === 'producer');
    await request(app.getHttpServer())
      .patch(`/org/roles/${producer.id}/permissions`)
      .set(as('admin'))
      .send({ capability: 'audit_log', scope: 'all' })
      .expect(403);
  });
  it('clients see only their own organisation users', async () => {
    const res = await request(app.getHttpServer()).get('/org/users').set(as('client')).expect(200);
    expect(res.body.every((u: { type: string }) => u.type === 'client')).toBe(true);
  });
  it('producers have no people access', async () => {
    await request(app.getHttpServer()).get('/org/users').set(as('producer')).expect(403);
  });
  it('admin cannot grant the Founder role', async () => {
    const roles = (await request(app.getHttpServer()).get('/org/roles').set(as('founder')).expect(200)).body;
    const founderRole = roles.find((r: { baseRole: string }) => r.baseRole === 'founder');
    await request(app.getHttpServer())
      .post('/org/users')
      .set(as('admin'))
      .send({ name: 'Not Allowed', email: 'nope@bmu.demo.test', roleId: founderRole.id })
      .expect(403);
  });
});

describe('audit_log', () => {
  it('is hidden from everyone but Founder and Branch Manager', async () => {
    await request(app.getHttpServer()).get('/audit').set(as('founder')).expect(200);
    await request(app.getHttpServer()).get('/audit').set(as('sales')).expect(403);
  });
});
