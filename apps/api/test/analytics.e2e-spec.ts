// v9 sales & money analytics: who may read it, funnel consistency, forecast committed revenue, profitability
// math and the settings editors behind the forecast and cost rates.
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
const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
let orgId: string;
let clientId: string;
let leadId: string;
const engagementIds: string[] = [];
let retainerSumPaise = 0;
let forecastBefore: { mrrPaise: number; months: { future: boolean; committedPaise: number | null }[] };

async function signIn(email: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier: email }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier: email, code: otp.body.devCode }).expect(200)).body.token as string;
}

const PAGES = ['scorecard', 'funnel', 'forecast', 'retention', 'profitability'];

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  prisma = app.get(PrismaService);
  orgId = (await prisma.organisation.findFirstOrThrow({ orderBy: { createdAt: 'asc' } })).id;
  for (const who of ['founder', 'finance', 'admin', 'producer', 'am', 'sales.manager']) tokens[who] = await signIn(`${who}@bmu.demo`);
  tokens.client = await signIn('client@sunrise.demo');

  // Forecast before our retainers exist, to compare against.
  forecastBefore = (await http().get('/analytics/forecast').set(as('founder')).expect(200)).body;

  const am = await prisma.user.findFirstOrThrow({ where: { email: 'am@bmu.demo' } });
  const client = await prisma.clientOrg.create({ data: { orgId, name: `Analytics Test ${stamp}`, amUserId: am.id, tenureStart: new Date(Date.now() - 40 * 86_400_000) } });
  clientId = client.id;
  for (const [key, tier] of [['smm', 'growth'], ['seo', 'starter']] as const) {
    const s = await prisma.service.findFirstOrThrow({ where: { key, priceBook: { orgId, status: 'active' } }, include: { tiers: true } });
    retainerSumPaise += s.tiers.find((t) => t.tier === tier)!.pricePaise;
    const e = await prisma.engagement.create({
      data: { orgId, clientOrgId: client.id, serviceId: s.id, tier, billingType: 'monthly', status: 'active_retainer', currentGate: 'G4', startDate: new Date(Date.now() - 40 * 86_400_000) },
    });
    engagementIds.push(e.id);
  }
});

afterAll(async () => {
  const invoiceIds = (await prisma.invoice.findMany({ where: { clientOrgId: clientId }, select: { id: true } })).map((i) => i.id);
  await prisma.payment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
  await prisma.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
  await prisma.task.deleteMany({ where: { engagementId: { in: engagementIds } } });
  await prisma.engagement.deleteMany({ where: { id: { in: engagementIds } } });
  await prisma.clientOrg.delete({ where: { id: clientId } });
  if (leadId) {
    await prisma.auditEvent.deleteMany({ where: { entityId: leadId } });
    await prisma.lead.delete({ where: { id: leadId } });
  }
  await app.close();
});

describe('who may read sales analytics', () => {
  it('producers and clients get 403 on every page', async () => {
    for (const p of PAGES) {
      await http().get(`/analytics/${p}`).set(as('producer')).expect(403);
      await http().get(`/analytics/${p}`).set(as('client')).expect(403);
    }
  });

  it('account managers cannot see money; Founder, Admin and Finance can', async () => {
    await http().get('/analytics/scorecard').set(as('am')).expect(403);
    await http().get('/analytics/profitability').set(as('am')).expect(403);
    for (const p of PAGES) await http().get(`/analytics/${p}`).set(as('finance')).expect(200);
    await http().get('/analytics/retention').set(as('admin')).expect(200);
  });

  it('a sales manager sees the funnel without money', async () => {
    const r = await http().get('/analytics/funnel').set(as('sales.manager')).expect(200);
    expect(r.body.canSeeMoney).toBe(false);
    expect(r.body.bySource.every((s: { revenuePaise: number | null }) => s.revenuePaise === null)).toBe(true);
    expect(r.body.leads.every((l: { valuePaise: number | null }) => l.valuePaise === null)).toBe(true);
    await http().get('/analytics/forecast').set(as('sales.manager')).expect(403);
  });

  it('rejects bad periods', async () => {
    await http().get('/analytics/funnel?from=2026-13-01').set(as('founder')).expect(400);
    await http().get(`/analytics/retention?from=${today}&to=2020-01-01`).set(as('founder')).expect(400);
  });
});

describe('sales funnel', () => {
  it('each stage holds no more leads than the one before, and stage moves are counted', async () => {
    const enquiry = await http()
      .post('/leads/enquiry')
      .send({ name: 'Funnel Test', email: `funnel.${stamp}@example.com`, phone: '9876543210', company: `Funnel Co ${stamp}`, need: 'Social media for our cafe', serviceIds: ['smm'] })
      .expect(201);
    leadId = enquiry.body.id;
    await http().patch(`/leads/${leadId}`).set(as('founder')).send({ stage: 'contacted' }).expect(200);
    await http().patch(`/leads/${leadId}`).set(as('founder')).send({ stage: 'discovery' }).expect(200);

    for (const q of ['', '?from=2025-10-01']) {
      const r = await http().get(`/analytics/funnel${q}`).set(as('founder')).expect(200);
      const counts = r.body.stages.map((s: { count: number }) => s.count);
      expect(counts).toHaveLength(6);
      for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
      expect(counts[0]).toBe(r.body.leadsCount);
      const mine = r.body.leads.find((l: { id: string }) => l.id === leadId);
      expect(mine.reached).toBe('discovery');
    }
  });
});

describe('revenue forecast', () => {
  it('committed revenue grows by exactly the active retainers we added', async () => {
    const after = (await http().get('/analytics/forecast').set(as('finance')).expect(200)).body;
    expect(after.mrrPaise - forecastBefore.mrrPaise).toBe(retainerSumPaise);
    const firstFuture = (f: typeof forecastBefore) => f.months.find((m) => m.future)!.committedPaise!;
    expect(firstFuture(after) - firstFuture(forecastBefore)).toBe(retainerSumPaise);
    expect(after.months).toHaveLength(12);
    expect(after.splitAt).toBe(6);
    const mine = after.retainers.filter((r: { clientId: string }) => r.clientId === clientId);
    expect(mine).toHaveLength(2);
  });
});

describe('profitability', () => {
  it('cost = hours × role rate × overhead; margin = revenue − cost', async () => {
    const [producer, strategist] = await Promise.all(['producer@bmu.demo', 'strategist@bmu.demo'].map((email) => prisma.user.findFirstOrThrow({ where: { email } })));
    await prisma.invoice.create({
      data: {
        orgId,
        clientOrgId: clientId,
        engagementId: engagementIds[0],
        kind: 'retainer',
        number: `TEST/AN/${stamp}`,
        lines: [{ label: 'Retainer', amountPaise: 1_000_000 }],
        subtotalPaise: 1_000_000,
        gstPaise: 180_000,
        totalPaise: 1_180_000,
        dueDate: new Date(Date.now() + 7 * 86_400_000),
        status: 'issued',
      },
    });
    for (const [owner, min] of [[producer.id, 90], [strategist.id, 30]] as const) {
      await prisma.task.create({ data: { orgId, engagementId: engagementIds[0], title: `Analytics test task ${stamp}`, ownerId: owner, status: 'done', timeLoggedMin: min, completedAt: new Date() } });
    }
    const settings = (await http().get('/settings').set(as('founder')).expect(200)).body.costRates as { hourlyPaise: Record<string, number>; overheadPct: number };
    const k = 1 + settings.overheadPct / 100;
    const expectedCost = Math.round(1.5 * settings.hourlyPaise.producer * k + 0.5 * settings.hourlyPaise.strategist * k);

    const r = await http().get(`/analytics/profitability?from=${today}&to=${today}`).set(as('founder')).expect(200);
    const row = r.body.clients.find((c: { id: string }) => c.id === clientId);
    expect(row.revenuePaise).toBe(1_000_000);
    expect(row.hours).toBe(2);
    expect(Math.abs(row.costPaise - expectedCost)).toBeLessThanOrEqual(1);
    expect(row.marginPaise).toBe(1_000_000 - row.costPaise);
    expect(row.hourlyRatePaise).toBe(500_000);
    expect(row.marginPct).toBeCloseTo(((1_000_000 - row.costPaise) / 1_000_000) * 100, 0);
    expect(r.body.totals.revenuePaise).toBeGreaterThanOrEqual(1_000_000);
  });
});

describe('settings editors', () => {
  it('validates forecast and cost rates, and only Founder, Admin and Finance may change them', async () => {
    const before = (await http().get('/settings').set(as('founder')).expect(200)).body;
    await http().put('/settings/forecast').set(as('finance')).send({ stageProbabilityPct: { new: 150 }, monthlyTargetPaise: 100 }).expect(400);
    await http().put('/settings/forecast').set(as('finance')).send({ stageProbabilityPct: { new: 5 }, monthlyTargetPaise: -1 }).expect(400);
    await http().put('/settings/costRates').set(as('finance')).send({ hourlyPaise: { default: 60_000 }, overheadPct: 500 }).expect(400);
    await http().put('/settings/costRates').set(as('producer')).send(before.costRates).expect(403);
    await http().put('/settings/forecast').set(as('am')).send(before.forecast).expect(403);

    // Finance changes the target; the forecast uses it straight away. Then put it back.
    const target = before.forecast.monthlyTargetPaise + 100_000;
    await http().put('/settings/forecast').set(as('finance')).send({ ...before.forecast, monthlyTargetPaise: target }).expect(200);
    const f = await http().get('/analytics/forecast').set(as('finance')).expect(200);
    expect(f.body.targetPaise).toBe(target);
    expect(f.body.canEdit).toBe(true);
    await http().put('/settings/forecast').set(as('founder')).send(before.forecast).expect(200);
    await http().put('/settings/costRates').set(as('finance')).send(before.costRates).expect(200);
  });
});
