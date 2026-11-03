// v43: the Client Manager adds several services for an onboarded client at once. Each starts at Gate 1 with its
// checklist straight away: no quote, no approval, nothing sent to the client.
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
const month = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 7);
let created: string[] = [];

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
  tokens.client = await signIn('client@sunrise.demo');
  ids.clientUser = (await prisma.user.findFirstOrThrow({ where: { email: 'client@sunrise.demo' } })).id;
  ids.sunrise = (await prisma.clientUser.findFirstOrThrow({ where: { userId: ids.clientUser } })).clientOrgId;
  const cm = (await prisma.clientOrg.findUniqueOrThrow({ where: { id: ids.sunrise }, include: { am: true } })).am!;
  tokens.cm = await signIn(cm.email!);
  tokens.producer = await signIn('producer@bmu.demo');
});

afterAll(async () => {
  if (created.length) {
    const cycles = await prisma.cycle.findMany({ where: { engagementId: { in: created } }, select: { id: true } });
    await prisma.requirementItem.deleteMany({ where: { cycleId: { in: cycles.map((c) => c.id) } } }).catch(() => undefined);
    await prisma.cycle.deleteMany({ where: { engagementId: { in: created } } }).catch(() => undefined);
    await prisma.engagement.deleteMany({ where: { id: { in: created } } }).catch(() => undefined);
  }
  await app.close();
});

describe('add several services at once (v43)', () => {
  it('starts each at Gate 1, sends nothing to the client and makes no quote or invoice', async () => {
    const running = (await prisma.engagement.findMany({ where: { clientOrgId: ids.sunrise, deletedAt: null, status: { notIn: ['closed', 'delivered'] } }, include: { service: true } })).map((e) => e.service.key);
    const book = await prisma.priceBook.findFirstOrThrow({ where: { status: 'active' }, orderBy: { effectiveFrom: 'desc' }, include: { services: { include: { tiers: true } } } });
    const free = book.services.filter((s) => !running.includes(s.key) && s.tiers.length).slice(0, 2);
    expect(free.length).toBe(2);
    const items = free.map((s) => ({ serviceId: s.id, tier: s.tiers[0].tier, startMonth: month }));
    const before = {
      notes: await prisma.notification.count({ where: { userId: ids.clientUser } }),
      quotes: await prisma.clientServiceQuote.count({ where: { clientOrgId: ids.sunrise } }),
      invoices: await prisma.invoice.count({ where: { clientOrgId: ids.sunrise } }),
    };

    // Only the client's CM (or leadership / Sales Manager) can; the same service twice is refused.
    await http().post(`/clients-actions/${ids.sunrise}/services`).set(as('producer')).send({ items }).expect(403);
    await http().post(`/clients-actions/${ids.sunrise}/services`).set(as('cm')).send({ items: [items[0], items[0]] }).expect(400);

    const r = await http().post(`/clients-actions/${ids.sunrise}/services`).set(as('cm')).send({ items, note: 'Added after the kick-off call' }).expect(201);
    expect(r.body.message).toMatch(/Nothing was sent to the client/);
    const engs = await prisma.engagement.findMany({ where: { clientOrgId: ids.sunrise, serviceId: { in: free.map((s) => s.id) }, deletedAt: null }, include: { cycles: { include: { requirements: true } } } });
    created = engs.map((e) => e.id);
    expect(engs).toHaveLength(2);
    for (const e of engs) expect(e.currentGate).toBe('G1');

    // Nothing reached the client; no quote and no invoice were made.
    expect(await prisma.notification.count({ where: { userId: ids.clientUser } })).toBe(before.notes);
    expect(await prisma.clientServiceQuote.count({ where: { clientOrgId: ids.sunrise } })).toBe(before.quotes);
    expect(await prisma.invoice.count({ where: { clientOrgId: ids.sunrise } })).toBe(before.invoices);

    // Adding a service that is already running is refused.
    await http().post(`/clients-actions/${ids.sunrise}/services`).set(as('cm')).send({ items: [items[0]] }).expect(400);
  });
});
