// The full sale: enquiry → proposal → discount approval → send → accept + e-sign → pay → client account.
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';

let app: INestApplication;
const tokens: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const stamp = Date.now();
const clientEmail = `owner.${stamp}@example.com`;
let leadId: string;

async function signIn(email: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier: email }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier: email, code: otp.body.devCode }).expect(200)).body.token as string;
}

const bundleLines = ['website', 'seo', 'gbp', 'smm'].map((serviceKey) => ({ serviceKey, tier: 'growth' }));

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  for (const who of ['founder', 'sales.manager', 'sales']) tokens[who] = await signIn(`${who}@bmu.demo`);
  await http()
    .post('/leads/enquiry')
    .send({ name: 'Test Owner', email: clientEmail, phone: `98${String(stamp).slice(-8)}`, company: `Test Co ${stamp}`, need: 'Full digital presence', serviceIds: [] })
    .expect(201);
  const leads = (await http().get('/leads').set(as('founder')).expect(200)).body;
  leadId = leads.find((l: { contact: { email: string } }) => l.contact.email === clientEmail).id;
});

afterAll(async () => {
  await app.close();
});

describe('proposals', () => {
  it('a sales executive discount goes to a sales manager for approval (v10)', async () => {
    const salesId = (await http().get('/auth/me').set(as('sales')).expect(200)).body.id;
    await http().patch(`/leads/${leadId}`).set(as('founder')).send({ ownerId: salesId }).expect(200);
    const p = (await http().post('/proposals').set(as('sales')).send({ leadId, lines: bundleLines, extraDiscountPct: 5 }).expect(201)).body;
    expect(p.discountNeedsApproval).toBe(true);
    expect(p.approvalSteps.map((s: { level: string }) => s.level)).toEqual(['manager']);
    await http().post(`/proposals/${p.id}/send`).set(as('sales')).expect(400);
  });

  it('a discount within the limit needs no approval and the bundle saving applies', async () => {
    const res = await http().post('/proposals').set(as('sales.manager')).send({ leadId, lines: bundleLines, extraDiscountPct: 5 }).expect(201);
    expect(res.body.discountNeedsApproval).toBe(false);
    expect(res.body.bundleDiscountPaise).toBeGreaterThan(0);
    expect(res.body.gstPaise).toBe(Math.round((res.body.subtotalPaise - res.body.discountPaise) * 0.18));
  });

  it('a discount beyond the limit must be approved by the Founder before sending', async () => {
    const p = (await http().post('/proposals').set(as('sales.manager')).send({ leadId, lines: bundleLines, extraDiscountPct: 15 }).expect(201)).body;
    expect(p.discountNeedsApproval).toBe(true);
    await http().post(`/proposals/${p.id}/send`).set(as('sales.manager')).expect(400);
    await http().post(`/proposals/${p.id}/approve-discount`).set(as('sales.manager')).expect(403);
    await http().post(`/proposals/${p.id}/approve-discount`).set(as('founder')).expect(200);
    await http().post(`/proposals/${p.id}/send`).set(as('sales.manager')).expect(200);
  });
});

describe('client accepts, signs and pays', () => {
  let token: string;
  let proposalTotal: number;

  beforeAll(async () => {
    const p = (await http().post('/proposals').set(as('sales.manager')).send({ leadId, lines: bundleLines }).expect(201)).body;
    await http().post(`/proposals/${p.id}/send`).set(as('sales.manager')).expect(200);
    token = p.publicToken;
    proposalTotal = p.totalPaise;
  });

  it('drafts are not visible on the public link', async () => {
    const draft = (await http().post('/proposals').set(as('sales.manager')).send({ leadId, lines: bundleLines }).expect(201)).body;
    await http().get(`/public/proposals/${draft.publicToken}`).expect(404);
  });

  it('cannot pay before accepting', async () => {
    await http().post(`/public/proposals/${token}/checkout`).expect(400);
  });

  it('accepting needs a typed signature and agreement', async () => {
    await http().post(`/public/proposals/${token}/accept`).send({ signerName: 'Test Owner', signerEmail: clientEmail }).expect(400);
    const res = await http()
      .post(`/public/proposals/${token}/accept`)
      .send({ signerName: 'Test Owner', signerEmail: clientEmail, agree: true })
      .expect(200);
    expect(res.body.proposal.status).toBe('accepted');
    expect(res.body.proposal.invoice.number).toMatch(/^BMU\/\d{4}-\d{2}\/\d{4}$/);
  });

  it('payment creates the client account, engagements and assigns an AM', async () => {
    expect((await http().post(`/public/proposals/${token}/checkout`).expect(200)).body.mode).toBe('test');
    const paid = (await http().post(`/public/proposals/${token}/pay-test`).expect(200)).body;
    expect(paid.proposal.paid).toBe(true);
    // paying twice is harmless
    await http().post(`/public/proposals/${token}/pay-test`).expect(200);

    const lead = (await http().get('/leads').set(as('founder')).expect(200)).body.find((l: { id: string }) => l.id === leadId);
    expect(lead.stage).toBe('won');

    tokens.client = await signIn(clientEmail);
    const overview = (await http().get('/client/overview').set(as('client')).expect(200)).body;
    expect(overview.engagements).toHaveLength(4);
    expect(overview.engagements.every((e: { currentGate: string }) => e.currentGate === 'G1')).toBe(true);
    expect(overview.accountManager?.name).toBeTruthy();
    const invoices = (await http().get('/client/invoices').set(as('client')).expect(200)).body;
    expect(invoices[0].status).toBe('paid');
    await http().get('/clients').set(as('client')).expect(403);
    await http().get('/leads').set(as('client')).expect(403);
  });

  it('a price change creates a new price book and leaves existing proposals untouched', async () => {
    const before = (await http().get('/catalogue/admin').set(as('founder')).expect(200)).body;
    const seo = before.services.find((s: { id: string }) => s.id === 'seo').tiers.find((t: { tier: string }) => t.tier === 'growth');
    const after = (
      await http()
        .patch('/catalogue/tiers')
        .set(as('founder'))
        .send({ serviceKey: 'seo', tier: 'growth', priceRupees: seo.pricePaise / 100 + 1000 })
        .expect(200)
    ).body;
    expect(after.priceBook.version).not.toBe(before.priceBook.version);
    const view = (await http().get(`/public/proposals/${token}`).expect(200)).body;
    expect(view.proposal.totalPaise).toBe(proposalTotal);
    // put the price back (as another new version)
    await http().patch('/catalogue/tiers').set(as('founder')).send({ serviceKey: 'seo', tier: 'growth', priceRupees: seo.pricePaise / 100 }).expect(200);
  });
});
