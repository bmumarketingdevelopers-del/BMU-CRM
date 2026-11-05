// v47: the service groups and sub-services: the list, adding them to a client, a second add extending the same project,
// the monthly fee, admin changes, and the quotation lines made from what was ticked.
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { applyQuoteServices, quoteServicesTitle, type ClientsFormOptions, type QuoteLine, type ServiceGroupView } from '@bmu/shared';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

let app: INestApplication;
let prisma: PrismaService;
const tokens: Record<string, string> = {};
let sunrise = '';
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const month = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 7);
const made: string[] = [];

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
  const user = await prisma.user.findFirstOrThrow({ where: { email: 'client@sunrise.demo' } });
  sunrise = (await prisma.clientUser.findFirstOrThrow({ where: { userId: user.id } })).clientOrgId;
  const cm = (await prisma.clientOrg.findUniqueOrThrow({ where: { id: sunrise }, include: { am: true } })).am!;
  tokens.cm = await signIn(cm.email!);
  tokens.founder = await signIn('founder@bmu.demo');
});

afterAll(async () => {
  await prisma.requirementItem.deleteMany({ where: { cycle: { engagementId: { in: made } } } });
  await prisma.cycle.deleteMany({ where: { engagementId: { in: made } } });
  await prisma.engagement.deleteMany({ where: { id: { in: made } } });
  await prisma.subService.deleteMany({ where: { name: 'Test sub-service' } });
  await app.close();
});

describe('service groups (v47)', () => {
  let groups: ServiceGroupView[];

  it('lists BMU\'s 6 services and 29 sub-services, each with what it covers', async () => {
    groups = ((await http().get('/clients-actions/form-options').set(as('cm')).expect(200)).body as ClientsFormOptions).groups;
    expect(groups.map((g) => g.name)).toEqual(['Marketing & Visibility', 'Social & Personal Brand', 'UGC & Creator Marketing', 'Brand & Design', 'Web & AI', 'Content & Production']);
    expect(groups.flatMap((g) => g.subServices)).toHaveLength(29);
    expect(groups.flatMap((g) => g.subServices).every((s) => s.covers.length > 40)).toBe(true);
  });

  it('keeps them out of the live price book', async () => {
    const live = (await http().get('/catalogue/services').expect(200)).body as { id: string }[];
    expect(live.some((s) => s.id.startsWith('group_'))).toBe(false);
    const versions = (await http().get('/catalogue/versions').set(as('founder')).expect(200)).body as { version: string }[];
    expect(versions.some((v) => v.version === 'service-groups')).toBe(false);
  });

  it('adds a service with sub-services, then a second add extends the same project', async () => {
    const g = groups[3];
    const [a, b, c] = g.subServices;
    const other = groups[0].subServices[0];
    const item = { groupId: g.id, billingType: 'monthly', monthlyFeePaise: 5_000_000, startMonth: month };
    await http().post(`/clients-actions/${sunrise}/services`).set(as('cm')).send({ items: [{ ...item, subServiceIds: [] }] }).expect(400);
    await http().post(`/clients-actions/${sunrise}/services`).set(as('cm')).send({ items: [{ ...item, subServiceIds: [other.id] }] }).expect(400);
    const res = await http().post(`/clients-actions/${sunrise}/services`).set(as('cm')).send({ items: [{ ...item, subServiceIds: [a.id, b.id] }] });
    expect(res.status).toBe(201);
    let mine = (res.body.services as { id: string; serviceName: string; grouped: boolean; billingType: string; monthlyFeePaise: number; subServices: { name: string; covers: string }[] }[]).find((s) => s.serviceName === g.name)!;
    made.push(mine.id);
    expect(mine.grouped).toBe(true);
    expect(mine.monthlyFeePaise).toBe(5_000_000);
    expect(mine.subServices.map((s) => s.name)).toEqual([a.name, b.name]);

    const again = await http().post(`/clients-actions/${sunrise}/services`).set(as('cm')).send({ items: [{ groupId: g.id, subServiceIds: [c.id], startMonth: month }] }).expect(201);
    const same = (again.body.services as (typeof mine)[]).filter((s) => s.serviceName === g.name);
    expect(same).toHaveLength(1);
    mine = same[0];
    expect(mine.subServices.map((s) => s.name)).toEqual([a.name, b.name, c.name]);
    expect(mine.monthlyFeePaise).toBe(5_000_000);

    await http().post(`/clients-actions/engagements/${mine.id}/sub-services`).set(as('cm')).send({ subServiceIds: [c.id], monthlyFeePaise: 6_000_000 }).expect(201);
    const row = await prisma.engagement.findUniqueOrThrow({ where: { id: mine.id } });
    expect(row.subServiceIds).toEqual([c.id]);
    expect(row.monthlyFeePaise).toBe(6_000_000);
    expect(row.billingType).toBe('monthly');

    // The monthly billing run charges the agreed fee, since a service group has no price-list tier.
    await prisma.engagement.update({ where: { id: mine.id }, data: { status: 'active_retainer' } });
    const run = (await http().get('/service/finance/billing-run').set(as('founder')).expect(200)).body as { lines: { engagementId: string; amountPaise: number; grouped?: boolean }[] };
    expect(run.lines.find((l) => l.engagementId === mine.id)).toMatchObject({ amountPaise: 6_000_000, grouped: true });
  });

  it('a one-time project keeps its own billing type and no monthly fee', async () => {
    const g = groups[5];
    const res = await http().post(`/clients-actions/${sunrise}/services`).set(as('cm')).send({ items: [{ groupId: g.id, subServiceIds: [g.subServices[0].id], billingType: 'one_time', monthlyFeePaise: 100, startMonth: month }] }).expect(201);
    const mine = (res.body.services as { id: string; serviceName: string; billingType: string; monthlyFeePaise: number | null }[]).find((s) => s.serviceName === g.name)!;
    made.push(mine.id);
    expect(mine.billingType).toBe('one_time');
    expect(mine.monthlyFeePaise).toBeNull();
  });

  it('only admins change the list; hidden ones leave the form', async () => {
    const g = groups[2];
    await http().post(`/catalogue/groups/${g.id}/sub-services`).set(as('cm')).send({ name: 'Test sub-service', covers: 'x' }).expect(403);
    const added = (await http().post(`/catalogue/groups/${g.id}/sub-services`).set(as('founder')).send({ name: 'Test sub-service', covers: 'Covers this' }).expect(201)).body as ServiceGroupView[];
    const sub = added.find((x) => x.id === g.id)!.subServices.find((s) => s.name === 'Test sub-service')!;
    await http().post(`/catalogue/groups/${g.id}/sub-services`).set(as('founder')).send({ name: 'test SUB-service' }).expect(400);
    await http().patch(`/catalogue/sub-services/${sub.id}`).set(as('founder')).send({ name: sub.name, covers: 'Covers that', archived: true }).expect(200);
    const form = ((await http().get('/clients-actions/form-options').set(as('cm')).expect(200)).body as ClientsFormOptions).groups;
    expect(form.find((x) => x.id === g.id)!.subServices.some((s) => s.id === sub.id)).toBe(false);
  });

  it('a quotation starts from what was ticked and keeps the edits', () => {
    const blank: QuoteLine = { title: '', details: '', kind: 'unit', qty: 1, unitPricePaise: 0, pct: 0 };
    const seo = { id: 's1', name: 'SEO', covers: 'Gets you found' };
    const ads = { id: 's2', name: 'Google Ads', covers: 'Campaigns' };
    const marketing = { name: 'Marketing & Visibility', subServices: [seo, ads] };
    const web = { name: 'Web & AI', subServices: [{ id: 's3', name: 'AI Chatbots', covers: 'Bots' }] };

    const one = applyQuoteServices({ title: '', lines: [blank] }, [marketing]);
    expect(one.title).toBe('Marketing & Visibility');
    expect(one.lines.map((l) => [l.title, l.details])).toEqual([['SEO', 'Gets you found'], ['Google Ads', 'Campaigns']]);

    const priced = { ...one, lines: one.lines.map((l, i) => (i === 0 ? { ...l, details: 'Edited', unitPricePaise: 1000 } : l)) };
    const two = applyQuoteServices(priced, [marketing, web], [quoteServicesTitle([marketing])]);
    expect(two.title).toBe('Marketing & Visibility, Web & AI');
    expect(two.lines[0]).toMatchObject({ details: 'Edited', unitPricePaise: 1000 });
    expect(two.lines).toHaveLength(3);

    const back = applyQuoteServices({ ...two, title: 'My own name' }, [web], ['Marketing & Visibility, Web & AI']);
    expect(back.title).toBe('My own name');
    expect(back.lines.map((l) => l.title)).toEqual(['AI Chatbots']);
    expect(applyQuoteServices(back, [], []).lines).toEqual([blank]);
  });
});
