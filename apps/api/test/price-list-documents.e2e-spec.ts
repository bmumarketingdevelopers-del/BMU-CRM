// v52 price list, client services and the shared quotation / invoice form:
// - bundle prices (members' prices minus the saving, in paise; no price when a member lacks one)
// - client services (at least one; each chosen group needs a sub service; unknown ids refused; plans for sub services
//   and bundles; a Client Manager cannot change another manager's client)
// - quotation / invoice save (totals recalculated on the server; CGST + SGST vs IGST by state; rate 0 = no tax; a
//   bundle item saved as service "Bundle", billed monthly); invoice locked once issued; payments lower what is owed.
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { bundlePlanPricePaise, clientServicesProblems, quoteTotals, type PriceList } from '@bmu/shared';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

let app: INestApplication;
let prisma: PrismaService;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const madeQuotes: string[] = [];
const madeInvoices: string[] = [];
const madeBundles: string[] = [];
let restorePrices: { id: string; billing: string; starterPaise: number | null; growthPaise: number | null; premiumPaise: number | null }[] = [];
let restoreClient: { placeOfSupply: string | null } | null = null;

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
  const owner = await prisma.user.findFirstOrThrow({ where: { email: 'client@sunrise.demo' } });
  ids.sunrise = (await prisma.clientUser.findFirstOrThrow({ where: { userId: owner.id } })).clientOrgId;
  const sunrise = await prisma.clientOrg.findUniqueOrThrow({ where: { id: ids.sunrise }, include: { am: true } });
  restoreClient = { placeOfSupply: sunrise.placeOfSupply };
  tokens.cm = await signIn(sunrise.am!.email!);
  tokens.founder = await signIn('founder@bmu.demo');
  // Another Client Manager (not Sunrise's).
  const other = await prisma.user.findFirst({ where: { orgId: sunrise.orgId, type: 'staff', status: 'active', deletedAt: null, id: { not: sunrise.amUserId! }, roles: { some: { role: { baseRole: 'account_manager' } } }, NOT: { roles: { some: { role: { baseRole: { in: ['founder', 'admin', 'am_lead'] } } } } } } });
  if (other?.email) tokens.otherCm = await signIn(other.email);
  // Two sub-services with known prices (put back afterwards).
  const list = (await http().get('/catalogue/price-list').set(as('founder')).expect(200)).body as PriceList;
  const [g1, g2] = list.groups.filter((g) => g.subServices.length >= 1);
  ids.groupA = g1.id;
  ids.groupB = g2.id;
  ids.subA = g1.subServices[0].id;
  ids.subB = g2.subServices[0].id;
  ids.groupAName = g1.name;
  restorePrices = await prisma.subService.findMany({ where: { id: { in: [ids.subA, ids.subB] } }, select: { id: true, billing: true, starterPaise: true, growthPaise: true, premiumPaise: true } });
  await http().patch(`/catalogue/sub-services/${ids.subA}`).set(as('founder')).send({ name: g1.subServices[0].name, covers: g1.subServices[0].covers, billing: 'monthly', starterPaise: 1_500_000, growthPaise: 3_000_000, premiumPaise: 6_000_000 }).expect(200);
  await http().patch(`/catalogue/sub-services/${ids.subB}`).set(as('founder')).send({ name: g2.subServices[0].name, covers: g2.subServices[0].covers, billing: 'one_time', starterPaise: 4_000_000, growthPaise: 7_500_000, premiumPaise: null }).expect(200);
});

afterAll(async () => {
  await prisma.clientService.deleteMany({ where: { clientOrgId: ids.sunrise } }).catch(() => undefined);
  await prisma.quotation.deleteMany({ where: { id: { in: madeQuotes } } }).catch(() => undefined);
  await prisma.payment.deleteMany({ where: { invoiceId: { in: madeInvoices } } }).catch(() => undefined);
  await prisma.invoice.deleteMany({ where: { id: { in: madeInvoices } } }).catch(() => undefined);
  await prisma.serviceBundle.deleteMany({ where: { id: { in: madeBundles } } }).catch(() => undefined);
  for (const p of restorePrices) await prisma.subService.update({ where: { id: p.id }, data: { billing: p.billing, starterPaise: p.starterPaise, growthPaise: p.growthPaise, premiumPaise: p.premiumPaise } });
  if (restoreClient) await prisma.clientOrg.update({ where: { id: ids.sunrise }, data: { placeOfSupply: restoreClient.placeOfSupply } });
  await app.close();
});

describe('bundle prices', () => {
  it('is the sum minus the saving, in paise, rounded once', () => {
    expect(bundlePlanPricePaise([1_500_000, 4_000_000], 10)).toBe(4_950_000);
    expect(bundlePlanPricePaise([33_333, 33_333, 33_334], 10)).toBe(90_000);
    expect(bundlePlanPricePaise([1_999, 1], 0)).toBe(2_000);
  });
  it('has no price when any member lacks one for that plan', () => {
    expect(bundlePlanPricePaise([1_500_000, null], 10)).toBeNull();
  });

  it('is saved with unique names and members from the price list; its prices are worked out', async () => {
    const name = `Test Launch ${Date.now()}`;
    const res = await http().post('/catalogue/service-bundles').set(as('founder')).send({ name, subServiceIds: [ids.subA, ids.subB], savingPct: 10 }).expect(201);
    const b = (res.body as { id: string; name: string; prices: Record<string, number | null> }[]).find((x) => x.name === name)!;
    madeBundles.push(b.id);
    ids.bundle = b.id;
    expect(b.prices).toEqual({ starter: 4_950_000, growth: 9_450_000, premium: null });
    await http().post('/catalogue/service-bundles').set(as('founder')).send({ name: name.toUpperCase(), subServiceIds: [ids.subA, ids.subB] }).expect(400);
    await http().post('/catalogue/service-bundles').set(as('founder')).send({ name: `${name} x`, subServiceIds: [ids.subA, 'not-a-sub-service'] }).expect(400);
    await http().post('/catalogue/service-bundles').set(as('founder')).send({ name: `${name} y`, subServiceIds: [ids.subA, ids.subA] }).expect(400);
  });
});

describe('client services', () => {
  it('the shared check: at least one item, a sub service per chosen group, known ids only', async () => {
    const list = (await http().get('/catalogue/price-list').set(as('cm')).expect(200)).body as PriceList;
    expect(clientServicesProblems({ groupIds: [], subServiceIds: [], bundleIds: [] }, list)).toContain('Choose at least one sub service or bundle.');
    expect(clientServicesProblems({ groupIds: [ids.groupA], subServiceIds: [], bundleIds: [ids.bundle] }, list)).toContain(`Choose at least one sub service for ${ids.groupAName}.`);
    expect(clientServicesProblems({ groupIds: [], subServiceIds: [], bundleIds: ['nope'] }, list)[0]).toMatch(/no longer in the price list/);
  });

  it('the server refuses the same mistakes', async () => {
    const put = (body: object, who = 'cm') => http().put(`/clients-actions/${ids.sunrise}/client-services`).set(as(who)).send(body);
    expect((await put({ groupIds: [], subServiceIds: [], bundleIds: [] })).status).toBe(400);
    expect((await put({ groupIds: [ids.groupA], subServiceIds: [], bundleIds: [ids.bundle] })).body.message).toMatch(/Choose at least one sub service for/);
    expect((await put({ groupIds: [], subServiceIds: [], bundleIds: ['nope'] })).status).toBe(400);
  });

  it('saves plans for sub services and bundles, and ends what is no longer chosen', async () => {
    await http().put(`/clients-actions/${ids.sunrise}/client-services`).set(as('cm')).send({ groupIds: [ids.groupA], subServiceIds: [ids.subA], bundleIds: [ids.bundle], plans: { [ids.subA]: 'growth', [ids.bundle]: 'starter' } }).expect(200);
    const d = (await http().get(`/clients-actions/${ids.sunrise}`).set(as('cm')).expect(200)).body;
    const live = d.clientServices.filter((r: { status: string }) => r.status !== 'ended');
    expect(live.map((r: { itemId: string; plan: string; pricePaise: number }) => [r.itemId, r.plan, r.pricePaise]).sort()).toEqual([[ids.bundle, 'starter', 4_950_000], [ids.subA, 'growth', 3_000_000]].sort());
    expect(live.find((r: { kind: string }) => r.kind === 'bundle')).toMatchObject({ service: 'Bundle', billing: 'monthly' });
    // Dropping the bundle ends its row (kept as history).
    await http().put(`/clients-actions/${ids.sunrise}/client-services`).set(as('cm')).send({ groupIds: [ids.groupA], subServiceIds: [ids.subA], bundleIds: [], plans: { [ids.subA]: 'growth' } }).expect(200);
    expect(await prisma.clientService.count({ where: { clientOrgId: ids.sunrise, bundleId: ids.bundle, status: 'ended' } })).toBe(1);
    // A client keeps at least one service.
    const only = await prisma.clientService.findFirstOrThrow({ where: { clientOrgId: ids.sunrise, status: 'active' } });
    await http().delete(`/clients-actions/${ids.sunrise}/client-services/${only.id}`).set(as('cm')).expect(400);
  });

  it("a Client Manager cannot change another manager's client", async () => {
    if (!tokens.otherCm) return;
    await http().put(`/clients-actions/${ids.sunrise}/client-services`).set(as('otherCm')).send({ groupIds: [ids.groupA], subServiceIds: [ids.subA], bundleIds: [] }).expect(403);
  });
});

describe('quotation and invoice save', () => {
  const lines = () => [
    { title: 'SEO (Growth plan)', details: 'Search work', kind: 'unit', qty: 1, unitPricePaise: 3_000_000, pct: 0, service: 'Marketing', billing: 'monthly' },
    { title: 'Test Launch (Starter plan)', details: 'A + B', kind: 'unit', qty: 3, unitPricePaise: 333_333, pct: 0, service: 'Bundle', billing: 'monthly' },
  ];
  const quote = (extra: object = {}) => ({ clientOrgId: ids.sunrise, engagementIds: [], templateId: null, preparedFor: [], validUntil: '', title: 'Test quotation', overview: '', projectLines: [], stats: [], lines: lines(), scope: [], timeline: [], terms: [], advancePct: 50, footerLine: '', ...extra });

  it('recalculates totals on the server (tax per item) and keeps a bundle item as Bundle, monthly', async () => {
    const res = await http().post('/quotes').set(as('cm')).send({ ...quote({ gstRatePct: 18 }), subtotalPaise: 1, gstPaise: 1, totalPaise: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    madeQuotes.push(res.body.id);
    const t = quoteTotals(lines() as never, 18);
    expect(res.body).toMatchObject({ subtotalPaise: t.subtotalPaise, gstPaise: t.gstPaise, totalPaise: t.totalPaise, gstRatePct: 18 });
    expect(t.gstPaise).toBe(Math.round((3_000_000 * 18) / 100) + Math.round((999_999 * 18) / 100));
    expect(res.body.content.lines[1]).toMatchObject({ service: 'Bundle', billing: 'monthly', gstRatePct: 18 });
    // Valid until left empty: 30 days after today, and the terms carry it.
    expect(res.body.content.terms.at(-1).text).toMatch(/^This quotation is valid until /);
  });

  it('CGST + SGST inside the seller state, IGST elsewhere', async () => {
    const inState = await http().post('/quotes').set(as('cm')).send(quote({ gstRatePct: 18, billTo: { name: 'Sunrise', gstin: '', placeOfSupply: '29', address: 'Bengaluru' } })).expect(201);
    madeQuotes.push(inState.body.id);
    expect(inState.body.tax.interState).toBe(false);
    expect(inState.body.tax.cgstPaise + inState.body.tax.sgstPaise).toBe(inState.body.gstPaise);
    const other = await http().post('/quotes').set(as('cm')).send(quote({ gstRatePct: 18, billTo: { name: 'Sunrise', gstin: '', placeOfSupply: '27', address: 'Mumbai' } })).expect(201);
    madeQuotes.push(other.body.id);
    expect(other.body.tax).toMatchObject({ interState: true, igstPaise: other.body.gstPaise, cgstPaise: 0 });
  });

  it('rate 0 means no tax', async () => {
    const res = await http().post('/quotes').set(as('cm')).send(quote({ gstRatePct: 0 })).expect(201);
    madeQuotes.push(res.body.id);
    expect(res.body).toMatchObject({ gstPaise: 0, gstRatePct: 0, totalPaise: res.body.subtotalPaise });
  });

  it('invoice: pass-through items (ad spend, creator fees) are billed at cost with no GST', async () => {
    const body = {
      clientOrgId: ids.sunrise,
      invoiceDate: today(),
      dueDate: '',
      overview: '',
      gstRatePct: 18,
      signWith: 'mine',
      seal: true,
      notes: '',
      terms: [],
      lines: [
        { title: 'SEO (Growth plan)', details: '', kind: 'unit', qty: 1, unitPricePaise: 100_000, pct: 0, service: 'Marketing', billing: 'monthly', costKind: 'service' },
        { title: 'Meta ad budget', details: 'Paid to Meta on your behalf', kind: 'unit', qty: 1, unitPricePaise: 50_000, pct: 0, service: '', billing: '', costKind: 'ad_spend' },
      ],
    };
    const saved = await http().post('/ops/finance/invoice-docs').set(as('founder')).send(body);
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    madeInvoices.push(saved.body.id);
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: saved.body.id } });
    // GST only on the service: 18% of ₹1,000 = ₹180; the ₹500 ad budget is at cost.
    expect(inv).toMatchObject({ subtotalPaise: 150_000, gstPaise: 18_000, totalPaise: 168_000 });
    expect((inv.lines as { kind: string; passThrough: boolean; gstRatePct: number }[])[1]).toMatchObject({ kind: 'ad_spend', passThrough: true, gstRatePct: 0 });
    const doc = (await http().get(`/ops/finance/invoice-docs/${saved.body.id}`).set(as('founder')).expect(200)).body;
    expect(doc.lines.map((l: { costKind: string }) => l.costKind)).toEqual(['service', 'ad_spend']);
    expect(doc.mixedRates).toBe(false);
  });

  it('invoice: totals on the server, no future date, locked once issued; payments lower what is owed', async () => {
    const body = { clientOrgId: ids.sunrise, invoiceDate: today(), dueDate: '', overview: '', lines: lines(), gstRatePct: 18, signWith: 'mine', seal: true, notes: '', terms: [] };
    const future = new Date(Date.now() + 330 * 60_000 + 3 * 86_400_000).toISOString().slice(0, 10);
    await http().post('/ops/finance/invoice-docs').set(as('founder')).send({ ...body, invoiceDate: future }).expect(400);
    const saved = await http().post('/ops/finance/invoice-docs').set(as('founder')).send(body);
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    madeInvoices.push(saved.body.id);
    const t = quoteTotals(lines() as never, 18);
    expect(saved.body.totalPaise).toBe(t.totalPaise);
    const doc = (await http().get(`/ops/finance/invoice-docs/${saved.body.id}`).set(as('founder')).expect(200)).body;
    expect(doc).toMatchObject({ status: 'draft', gstRatePct: 18, canEdit: true, subtotalPaise: t.subtotalPaise });
    expect(doc.lines[1]).toMatchObject({ service: 'Bundle', billing: 'monthly' });
    // GST off: saved at rate 0, reopens with the switch off.
    await http().patch(`/ops/finance/invoice-docs/${saved.body.id}`).set(as('founder')).send({ ...body, gstRatePct: 0 }).expect(200);
    expect((await http().get(`/ops/finance/invoice-docs/${saved.body.id}`).set(as('founder')).expect(200)).body).toMatchObject({ gstRatePct: 0, gstPaise: 0 });
    await http().patch(`/ops/finance/invoice-docs/${saved.body.id}`).set(as('founder')).send(body).expect(200);
    // Issue → locked.
    await http().post(`/ops/finance/invoices/${saved.body.id}/issue`).set(as('founder')).expect(200);
    const locked = await http().patch(`/ops/finance/invoice-docs/${saved.body.id}`).set(as('founder')).send(body);
    expect(locked.status).toBe(400);
    expect(locked.body.message).toMatch(/locked/);
    // A payment lowers what the client owes.
    const before = (await http().get(`/clients-actions/${ids.sunrise}`).set(as('founder')).expect(200)).body.money.owedPaise;
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: saved.body.id } });
    await prisma.payment.create({ data: { orgId: inv.orgId, invoiceId: inv.id, amountPaise: 100_000, method: 'offline' } });
    const after = (await http().get(`/clients-actions/${ids.sunrise}`).set(as('founder')).expect(200)).body.money.owedPaise;
    expect(before - after).toBe(100_000);
  });
});
