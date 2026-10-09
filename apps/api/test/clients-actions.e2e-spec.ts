// v11 clients: add a client by hand (no lead) with duplicate check, offline payment confirmed by Finance and the
// payment gate; migrated clients with their current gate; edit with field-level rights; client users (AM-invited
// Owner needs the Owner's confirmation); brands; AM reassignment seen by the client; add service / change tier
// quotes; pause with AM Lead approval; offboarding with Admin approval and read-only access; health; import; lead
// conversion; and the request actions (raise on behalf, reassign, custom quote limit, convert to tasks, internal
// approval). Forbidden roles get 403 with a plain-English message.
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
const tail = String(stamp).slice(-8);
const tag = (s: string) => `${s} ${stamp}`;
const created: string[] = [];
/** A GSTIN unique to this run: 29 + 5 letters + 4 digits + letter + 1Z + digit. */
const L = (n: number) => String.fromCharCode(65 + (n % 26));
const GSTIN = `29${[0, 1, 2, 3, 4].map((i) => L(Math.floor(stamp / 26 ** i))).join('')}${String(stamp).slice(-4)}${L(Math.floor(stamp / 7))}1Z5`;
const leads: string[] = [];

/** A distinct valid mobile per call (6-9 start, 10 digits). */
let seq = 0;
const phone = () => `9${String(stamp).slice(-6)}${String(seq++).padStart(3, '0')}`;
const month = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 7);
function dayAhead(n: number) {
  const d = new Date(Date.now() + 5.5 * 3600_000 + n * 86_400_000);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Status check that shows the response body when it fails. */
const code = (want: number) => (res: request.Response) => {
  if (res.status !== want) throw new Error(`expected ${want}, got ${res.status}: ${JSON.stringify(res.body)}`);
};

async function signIn(email: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier: email }).expect(code(200));
  return (await http().post('/auth/otp/verify').send({ identifier: email, code: otp.body.devCode }).expect(code(200))).body.token as string;
}

function base(name: string, extra: Record<string, unknown> = {}) {
  const p = phone();
  return {
    businessName: tag(name),
    contactName: `${name} Owner`,
    contactPhone: p,
    contactEmail: `owner.${name.toLowerCase().replace(/\W+/g, '')}.${stamp}@example.com`,
    industry: 'Restaurants & cafes',
    billingName: `${name} LLP`,
    billingAddress: '12 MG Road, Bengaluru 560001',
    branchId: ids.branch,
    ...extra,
  };
}

async function create(who: string, body: Record<string, unknown>, expect = 201) {
  const r = await http().post('/clients-actions').set(as(who)).send(body);
  if (r.status !== expect) throw new Error(`create as ${who}: ${r.status} ${JSON.stringify(r.body)}`);
  if (r.body?.client?.id && !r.body.merged) created.push(r.body.client.id);
  return r.body;
}

async function decide(who: string, approvalId: string, decision: 'approve' | 'reject' = 'approve', expect = 200) {
  const r = await http().post(`/actions/approvals/${approvalId}/decide`).set(as(who)).send({ decision, note: 'ok' });
  if (r.status !== expect) throw new Error(`decide as ${who}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  prisma = app.get(PrismaService);
  const people: Record<string, string> = {
    founder: 'founder@bmu.demo',
    admin: 'admin@bmu.demo',
    lead: 'am.lead@bmu.demo',
    am: 'am@bmu.demo',
    am2: 'pm@bmu.demo',
    sales: 'sales.manager@bmu.demo',
    finance: 'finance@bmu.demo',
    design: 'design@bmu.demo',
    head: 'design.head@bmu.demo',
  };
  for (const [k, email] of Object.entries(people)) {
    tokens[k] = await signIn(email);
    ids[k] = (await prisma.user.findFirstOrThrow({ where: { email } })).id;
  }
  ids.org = (await prisma.user.findUniqueOrThrow({ where: { id: ids.am } })).orgId;
  ids.branch = (await prisma.branch.findFirstOrThrow({ where: { orgId: ids.org, deletedAt: null }, orderBy: { name: 'asc' } })).id;
  const book = await prisma.priceBook.findFirstOrThrow({ where: { orgId: ids.org, status: 'active' }, orderBy: { effectiveFrom: 'desc' }, include: { services: { include: { tiers: true } } } });
  const monthly = book.services.filter((s) => s.billingType === 'monthly' && s.tiers.length >= 3);
  ids.monthly = monthly[0].id;
  ids.monthly2 = monthly[1].id;
  ids.oneTime = book.services.find((s) => s.billingType === 'one_time' && s.tiers.length >= 1)!.id;
});

afterAll(async () => {
  if (created.length) {
    const users = await prisma.clientUser.findMany({ where: { clientOrgId: { in: created } }, select: { userId: true } });
    await prisma.user.updateMany({ where: { id: { in: users.map((u) => u.userId) } }, data: { deletedAt: new Date(), status: 'suspended' } });
    await prisma.engagement.updateMany({ where: { clientOrgId: { in: created } }, data: { deletedAt: new Date() } });
    await prisma.clientOrg.updateMany({ where: { id: { in: created } }, data: { deletedAt: new Date() } });
    await prisma.approvalRequest.updateMany({ where: { status: 'pending', OR: [{ targetId: { in: created } }, ...created.map((id) => ({ targetId: { startsWith: `${id}:` } }))] }, data: { status: 'cancelled' } });
  }
  if (leads.length) await prisma.lead.updateMany({ where: { id: { in: leads } }, data: { deletedAt: new Date() } });
  await app.close();
});

describe('add_client: who may add, validation and duplicates', () => {
  it('refuses roles outside Founder, Admin, Sales Manager and AM Lead', async () => {
    for (const who of ['am', 'design', 'finance']) {
      const r = await http().post('/clients-actions').set(as(who)).send(base('Nope')).expect(code(403));
      expect(r.body.message).toMatch(/Founder|Admin|Sales Manager|AM Lead/);
    }
  });

  it('checks the GSTIN format and required fields in plain English', async () => {
    const r = await http().post('/clients-actions').set(as('lead')).send(base('Bad GST', { gstin: '12345' })).expect(code(400));
    expect(JSON.stringify(r.body)).toMatch(/GSTIN should look like/);
    const r2 = await http().post('/clients-actions').set(as('lead')).send({ businessName: 'x' }).expect(code(400));
    expect(JSON.stringify(r2.body)).toMatch(/business name|contact/i);
  });

  it('adds a client by hand with offline payment: Finance approval, payment gate, notifications, welcome', async () => {
    const body = base('Aroma Manual', {
      gstin: GSTIN,
      brands: [{ name: 'Aroma Indiranagar', address: '100 Feet Road, Bengaluru' }],
      engagements: [{ serviceId: ids.monthly, tier: 'growth', startMonth: month() }],
      amUserId: ids.am,
      handoverNote: 'Owner prefers WhatsApp; launch in two weeks',
      inviteNow: true,
      invites: [{ name: 'Aroma Owner', email: `aroma.owner.${stamp}@example.com`, role: 'client_owner' }],
      payment: 'offline',
      paymentReference: `UTR${stamp}`,
    });
    const r = await create('sales', body);
    ids.manual = r.client.id;
    ids.manualOwnerEmail = `aroma.owner.${stamp}@example.com`;
    expect(r.invoice?.id).toBeTruthy();
    expect(r.approval?.id).toBeTruthy();
    expect(r.invited).toBe(1);
    const c = await prisma.clientOrg.findUniqueOrThrow({ where: { id: ids.manual } });
    expect(c.source).toBe('manual');
    expect(c.paymentStatus).toBe('pending');
    expect(c.amUserId).toBe(ids.am);
    expect(c.gstin).toBe(GSTIN);
    const eng = await prisma.engagement.findFirstOrThrow({ where: { clientOrgId: ids.manual } });
    ids.manualEng = eng.id;
    expect(eng.paymentPending).toBe(true);
    expect(eng.currentGate).toBe('G1');
    expect(await prisma.clientBrand.count({ where: { clientOrgId: ids.manual } })).toBe(1);
    // Notified: AM, AM Lead, Finance.
    for (const who of ['am', 'lead']) expect(await prisma.notification.count({ where: { userId: ids[who], link: { contains: ids.manual } } })).toBeGreaterThan(0);
    expect(await prisma.notification.count({ where: { userId: ids.finance, title: { contains: 'confirm the offline payment' }, createdAt: { gt: new Date(Date.now() - 60_000) } } })).toBeGreaterThan(0);
    // Welcome in the client's thread, and the handover note is internal.
    const thread = await prisma.thread.findFirstOrThrow({ where: { clientOrgId: ids.manual } });
    const msgs = await prisma.message.findMany({ where: { threadId: thread.id } });
    expect(msgs.some((m) => !m.isInternal && /welcome/i.test(m.body))).toBe(true);
    expect(msgs.some((m) => m.isInternal && /WhatsApp/.test(m.body))).toBe(true);
    // Payment gate: G1 can't be passed until Finance confirms.
    const rcd = await http().post(`/engagements/${ids.manualEng}/rcd`).set(as('am')).send({});
    expect(rcd.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(rcd.body)).toMatch(/first payment/i);
    // AM can't confirm the payment; Finance can.
    await decide('am', r.approval.id, 'approve', 403);
    await decide('finance', r.approval.id);
    expect((await prisma.engagement.findUniqueOrThrow({ where: { id: ids.manualEng } })).paymentPending).toBe(false);
    expect((await prisma.clientOrg.findUniqueOrThrow({ where: { id: ids.manual } })).paymentStatus).toBe('confirmed');
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: r.invoice.id } })).status).toBe('paid');
  });

  it('finds duplicates by phone, GSTIN or name: 409 unless merged or confirmed', async () => {
    const c = await prisma.clientOrg.findUniqueOrThrow({ where: { id: ids.manual } });
    const contact = c.primaryContact as { phone: string };
    const dup = await http().post('/clients-actions/duplicates').set(as('lead')).send({ phone: contact.phone, gstin: GSTIN }).expect(code(200));
    expect(dup.body.some((d: { id: string }) => d.id === ids.manual)).toBe(true);
    const again = base('Aroma Again', { contactPhone: contact.phone });
    const r = await http().post('/clients-actions').set(as('lead')).send(again).expect(code(409));
    expect(JSON.stringify(r.body)).toMatch(/already|duplicate|looks like/i);
    // Merge: details go onto the existing client.
    const m = await create('lead', { ...again, mergeIntoId: ids.manual, brands: [{ name: 'Aroma Koramangala', address: '80 Feet Road, Bengaluru' }] });
    expect(m.merged).toBe(true);
    expect(m.client.id).toBe(ids.manual);
    expect(await prisma.clientBrand.count({ where: { clientOrgId: ids.manual } })).toBe(2);
    // Continue: a different client after all.
    const k = await create('lead', { ...again, confirmDuplicate: true });
    expect(k.client.id).not.toBe(ids.manual);
  });

  it('online payment: the client pays in the app and the payment gate opens', async () => {
    const email = `online.owner.${stamp}@example.com`;
    const r = await create('sales', base('Online Pay', { engagements: [{ serviceId: ids.oneTime, tier: 'starter' }], amUserId: ids.am, inviteNow: true, invites: [{ name: 'Online Owner', email, role: 'client_owner' }], payment: 'online' }));
    ids.online = r.client.id;
    expect(r.approval).toBeNull();
    const eng = await prisma.engagement.findFirstOrThrow({ where: { clientOrgId: ids.online } });
    ids.onlineEng = eng.id;
    expect(eng.paymentPending).toBe(true);
    tokens.onlineOwner = await signIn(email);
    await http().post(`/client/invoices/${r.invoice.id}/pay-test`).set(as('onlineOwner')).expect(code(200));
    expect((await prisma.engagement.findUniqueOrThrow({ where: { id: ids.onlineEng } })).paymentPending).toBe(false);
    expect((await prisma.clientOrg.findUniqueOrThrow({ where: { id: ids.online } })).paymentStatus).toBe('confirmed');
  });

  it('suggests AMs by load and industry', async () => {
    const r = await http().get('/clients-actions/am-suggest?industry=Restaurants%20%26%20cafes').set(as('lead')).expect(code(200));
    expect(r.body.length).toBeGreaterThan(0);
    expect(r.body.filter((a: { suggested: boolean }) => a.suggested).length).toBe(1);
    await http().get('/clients-actions/form-options').set(as('onlineOwner')).expect(code(403));
  });
});

describe('migrated client', () => {
  it('sets each service at its current gate with a reason, records migrated approvals and past invoices', async () => {
    const bad = await http()
      .post('/clients-actions')
      .set(as('lead'))
      .send(base('Old Firm', { startMode: 'migration', migrationReason: 'From the old system', engagements: [{ serviceId: ids.monthly, tier: 'starter' }], payment: 'none' }))
      .expect(code(400));
    expect(JSON.stringify(bad.body)).toMatch(/current gate/);
    const r = await create(
      'lead',
      base('Old Firm', {
        startMode: 'migration',
        migrationReason: 'Existing client from the old system',
        engagements: [{ serviceId: ids.monthly, tier: 'starter', currentGate: 'G3', gateReason: 'Production running since April' }],
        amUserId: ids.am,
        payment: 'none',
        pastInvoices: [{ number: `OLD-${tail}`, date: '2026-04-30', amountPaise: 5_000_000, status: 'paid' }],
      }),
    );
    ids.migrated = r.client.id;
    const c = await prisma.clientOrg.findUniqueOrThrow({ where: { id: ids.migrated } });
    expect(c.startMode).toBe('migration');
    const e = await prisma.engagement.findFirstOrThrow({ where: { clientOrgId: ids.migrated } });
    ids.migratedEng = e.id;
    expect(e.currentGate).toBe('G3');
    expect(e.migrated).toBe(true);
    expect(e.paymentPending).toBe(false);
    const ap = await prisma.approval.findMany({ where: { targetType: 'engagement', targetId: e.id, migrated: true } });
    expect(ap.map((a) => a.gate).sort()).toEqual(['G1', 'G2']);
    const inv = await prisma.invoice.findFirstOrThrow({ where: { clientOrgId: ids.migrated } });
    expect(inv.migrated).toBe(true);
    expect(inv.status).toBe('paid');
  });

  it('lets the AM move a migrated service gate (with reason), never a new one', async () => {
    await http().post(`/clients-actions/engagements/${ids.migratedEng}/gate`).set(as('design')).send({ gate: 'G4', reason: 'Drafts out' }).expect(code(403));
    await http().post(`/clients-actions/engagements/${ids.migratedEng}/gate`).set(as('am')).send({ gate: 'G4', reason: 'Drafts with the client' }).expect(code(200));
    expect((await prisma.engagement.findUniqueOrThrow({ where: { id: ids.migratedEng } })).currentGate).toBe('G4');
    const r = await http().post(`/clients-actions/engagements/${ids.manualEng}/gate`).set(as('am')).send({ gate: 'G3', reason: 'Skip ahead' }).expect(code(400));
    expect(r.body.message).toMatch(/Only migrated services/);
    const p = await http().post(`/clients-actions/${ids.migrated}/past-invoices`).set(as('finance')).send({ invoices: [{ number: `OLD2-${tail}`, date: '2026-05-31', amountPaise: 5_000_000 }] }).expect(code(201));
    expect(p.body.created).toBe(1);
  });
});

describe('edit_client: field-level rights', () => {
  it('AM changes contact only, Finance billing only, Admin everything; others are refused', async () => {
    const no = await http().patch(`/clients-actions/${ids.manual}`).set(as('am')).send({ contactName: 'Kavya Rao', billingName: 'Hijack LLP' }).expect(code(403));
    expect(no.body.message).toMatch(/can't change billing name/);
    const a = await http().patch(`/clients-actions/${ids.manual}`).set(as('am')).send({ contactName: 'Kavya Rao' }).expect(code(200));
    expect(a.body.contact.name).toBe('Kavya Rao');
    expect(a.body.undo?.token).toBeTruthy();
    await http().patch(`/clients-actions/${ids.manual}`).set(as('finance')).send({ contactName: 'Nope Nope' }).expect(code(403));
    const f = await http().patch(`/clients-actions/${ids.manual}`).set(as('finance')).send({ billingName: 'Aroma Foods LLP' }).expect(code(200));
    expect(f.body.billing.billingName).toBe('Aroma Foods LLP');
    expect(f.body.contact.name).toBe('Kavya Rao');
    const ad = await http().patch(`/clients-actions/${ids.manual}`).set(as('admin')).send({ businessName: tag('Aroma Foods') }).expect(code(200));
    expect(ad.body.name).toBe(tag('Aroma Foods'));
    await http().patch(`/clients-actions/${ids.manual}`).set(as('design')).send({ contactName: 'X Y' }).expect(code(403));
    await http().patch(`/clients-actions/${ids.manual}`).set(as('am2')).send({ contactName: 'X Y' }).expect(code(403));
  });

  it('the client Owner edits their own contact and the AM is notified', async () => {
    tokens.manualOwner = await signIn(ids.manualOwnerEmail);
    const before = await prisma.notification.count({ where: { userId: ids.am, kind: 'client_updated' } });
    const r = await http().patch('/client-actions/contact').set(as('manualOwner')).send({ contactName: 'Kavya R', contactPhone: '9876543210', contactEmail: `kavya.${stamp}@example.com` }).expect(code(200));
    expect(r.body.contact.name).toBe('Kavya R');
    expect(await prisma.notification.count({ where: { userId: ids.am, kind: 'client_updated' } })).toBe(before + 1);
  });
});

describe('client users and brands', () => {
  it('AM invites a viewer straight away; an AM-invited Owner waits for the Owner to confirm', async () => {
    const v = await http().post(`/clients-actions/${ids.manual}/users`).set(as('am')).send({ name: 'Aroma Viewer', email: `aroma.viewer.${stamp}@example.com`, role: 'client_viewer' }).expect(code(201));
    expect(v.body.users.some((u: { email: string }) => u.email === `aroma.viewer.${stamp}@example.com`)).toBe(true);
    const o = await http().post(`/clients-actions/${ids.manual}/users`).set(as('am')).send({ name: 'Second Owner', email: `aroma.owner2.${stamp}@example.com`, role: 'client_owner' }).expect(code(201));
    expect(o.body.message).toMatch(/confirm/i);
    expect(o.body.pendingInvites.length).toBe(1);
    const acct = await http().get('/client-actions/account').set(as('manualOwner')).expect(code(200));
    expect(acct.body.pendingInvites.length).toBe(1);
    const d = await http().post(`/client-actions/owner-invites/${acct.body.pendingInvites[0].approvalId}`).set(as('manualOwner')).send({ decision: 'approve' }).expect(code(200));
    expect(d.body.pendingInvites.length).toBe(0);
    const u = await prisma.user.findFirstOrThrow({ where: { email: `aroma.owner2.${stamp}@example.com` }, include: { clientUser: true } });
    expect(u.clientUser?.clientRole).toBe('client_owner');
    await http().post(`/clients-actions/${ids.manual}/users`).set(as('design')).send({ name: 'X', email: `x.${stamp}@example.com`, role: 'client_viewer' }).expect(code(403));
  });

  it('AM and the client Owner add brands/locations', async () => {
    const b = await http().post(`/clients-actions/${ids.manual}/brands`).set(as('am')).send({ name: 'Aroma HSR', address: 'HSR Layout, Bengaluru' }).expect(code(201));
    expect(b.body.brands.length).toBe(3);
    const c = await http().post('/client-actions/brands').set(as('manualOwner')).send({ name: 'Aroma Whitefield', address: 'ITPL Road, Bengaluru' }).expect(code(201));
    expect(c.body.brands.length).toBe(4);
    await http().post(`/clients-actions/${ids.manual}/brands`).set(as('am2')).send({ name: 'No', address: 'Nowhere road' }).expect(code(403));
  });
});

describe('reassign the Account Manager', () => {
  it('only AM Lead / Admin; handover note required; client gets an intro; old AM keeps 7 days of read access', async () => {
    await http().post('/actions/reassign/client_am/apply').set(as('am')).send({ ids: [ids.online], toUserId: ids.am2, reason: 'overload', handoverNote: 'x' }).expect(code(403));
    const noNote = await http().post('/actions/reassign/client_am/apply').set(as('lead')).send({ ids: [ids.online], toUserId: ids.am2, reason: 'overload' }).expect(code(400));
    expect(noNote.body.message).toMatch(/handover/i);
    const r = await http().post('/actions/reassign/client_am/apply').set(as('lead')).send({ ids: [ids.online], toUserId: ids.am2, reason: 'overload', handoverNote: 'Prefers calls after 4pm' }).expect(code(200));
    expect(r.body).toMatchObject({ applied: 1 });
    const c = await prisma.clientOrg.findUniqueOrThrow({ where: { id: ids.online } });
    expect(c.amUserId).toBe(ids.am2);
    expect((await prisma.engagement.findUniqueOrThrow({ where: { id: ids.onlineEng } })).amId).toBe(ids.am2);
    // The client sees the new AM's introduction in their thread.
    const t = await http().get('/client/thread').set(as('onlineOwner')).expect(code(200));
    expect(t.body.messages.some((m: { body: string; internal: boolean }) => /your new account manager/.test(m.body) && !m.internal)).toBe(true);
    expect(t.body.messages.some((m: { body: string }) => /Prefers calls/.test(m.body))).toBe(false);
    // Old AM: read for 7 days, no changes.
    const old = await http().get(`/clients-actions/${ids.online}`).set(as('am')).expect(code(200));
    expect(old.body.readOnlyAccess).toBe(true);
    expect(old.body.amHistory[0].to).toBeTruthy();
    await http().patch(`/clients-actions/${ids.online}`).set(as('am')).send({ contactName: 'Nope Nope' }).expect(code(403));
    const a = await prisma.assignment.findFirstOrThrow({ where: { targetType: 'client_am', targetId: ids.online }, orderBy: { at: 'desc' } });
    expect(a.readAccessUntil!.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
  });
});

describe('add_engagement and change_tier quotes', () => {
  it('AM quotes a new service; the Owner approves and pays; onboarding opens for it', async () => {
    await http().post(`/clients-actions/${ids.manual}/quotes`).set(as('design')).send({ kind: 'add_service', serviceId: ids.monthly2, tier: 'starter', startMonth: month() }).expect(code(403));
    const q = await http().post(`/clients-actions/${ids.manual}/quotes`).set(as('am')).send({ kind: 'add_service', serviceId: ids.monthly2, tier: 'starter', startMonth: month() }).expect(code(201));
    const quote = q.body.quotes[0];
    expect(quote.status).toBe('sent');
    const ap = await http().post(`/client-actions/quotes/${quote.id}/approve`).set(as('manualOwner')).expect(code(200));
    const approved = ap.body.quotes.find((x: { id: string }) => x.id === quote.id);
    expect(approved.status).toBe('approved');
    await http().post(`/client/invoices/${approved.invoice.id}/pay-test`).set(as('manualOwner')).expect(code(200));
    const after = await prisma.clientServiceQuote.findUniqueOrThrow({ where: { id: quote.id } });
    expect(after.status).toBe('applied');
    const e = await prisma.engagement.findUniqueOrThrow({ where: { id: after.resultEngagementId! } });
    expect(e.currentGate).toBe('G1');
    expect(e.serviceId).toBe(ids.monthly2);
  });

  it('client asks for a downgrade from next cycle: AM sends, Owner approves, AM Lead is told', async () => {
    const r = await http().post('/client-actions/quotes').set(as('manualOwner')).send({ kind: 'change_tier', engagementId: ids.manualEng, tier: 'starter', effective: 'next_cycle' }).expect(code(201));
    const q = r.body.quotes.find((x: { status: string; kind: string }) => x.kind === 'change_tier' && x.status === 'requested');
    expect(q).toBeTruthy();
    await http().post(`/clients-actions/quotes/${q.id}/send`).set(as('am')).expect(code(200));
    const before = await prisma.notification.count({ where: { userId: ids.lead } });
    await http().post(`/client-actions/quotes/${q.id}/approve`).set(as('manualOwner')).expect(code(200));
    expect((await prisma.engagement.findUniqueOrThrow({ where: { id: ids.manualEng } })).tier).toBe('starter');
    expect(await prisma.notification.count({ where: { userId: ids.lead } })).toBeGreaterThan(before);
    const bad = await http().post(`/clients-actions/${ids.manual}/quotes`).set(as('am')).send({ kind: 'change_tier', engagementId: ids.manualEng, tier: 'starter' }).expect(code(400));
    expect(bad.body.message).toMatch(/already on starter/);
  });
});

describe('pause_engagement', () => {
  it('AM asks, AM Lead approves; tasks wait and clocks stop; resume restores', async () => {
    const r = await http().post(`/clients-actions/engagements/${ids.manualEng}/pause`).set(as('am')).send({ reason: 'Owner travelling', until: dayAhead(10) }).expect(code(200));
    expect(r.body.approval.id).toBeTruthy();
    await decide('am', r.body.approval.id, 'approve', 403);
    await decide('lead', r.body.approval.id);
    const e = await prisma.engagement.findUniqueOrThrow({ where: { id: ids.manualEng } });
    expect(e.status).toBe('paused');
    expect(e.pausedUntil).toBeTruthy();
    await http().post(`/clients-actions/engagements/${ids.manualEng}/resume`).set(as('design')).expect(code(403));
    await http().post(`/clients-actions/engagements/${ids.manualEng}/resume`).set(as('am')).expect(code(200));
    const back = await prisma.engagement.findUniqueOrThrow({ where: { id: ids.manualEng } });
    expect(back.status).not.toBe('paused');
    expect(back.pausedUntil).toBeNull();
  });
});

describe('health override', () => {
  it('needs a reason; red tells the AM Leads', async () => {
    await http().post(`/clients-actions/${ids.manual}/health`).set(as('am')).send({ status: 'red' }).expect(code(400));
    const before = await prisma.notification.count({ where: { userId: ids.lead } });
    const r = await http().post(`/clients-actions/${ids.manual}/health`).set(as('am')).send({ status: 'red', reason: 'Owner unhappy with reels' }).expect(code(200));
    expect(r.body.health).toBe('red');
    expect(r.body.healthReason).toBe('Owner unhappy with reels');
    expect(await prisma.notification.count({ where: { userId: ids.lead } })).toBeGreaterThan(before);
    await http().post(`/clients-actions/${ids.manual}/health`).set(as('design')).send({ status: 'green', reason: 'Looks fine' }).expect(code(403));
  });
});

describe('requests: raise on behalf, reassign, custom quote, convert, internal approval', () => {
  it('AM raises a request for the client; the client deciders see it', async () => {
    await http().post('/clients-actions/requests').set(as('design')).send({ engagementId: ids.manualEng, type: 'change', description: 'Change the menu reel' }).expect(code(403));
    const r = await http().post('/clients-actions/requests').set(as('am')).send({ engagementId: ids.manualEng, type: 'change', description: tag('Change the menu reel'), neededBy: dayAhead(5), links: ['https://example.com/brief'] }).expect(code(201));
    ids.req = r.body.id;
    const row = await prisma.request.findUniqueOrThrow({ where: { id: ids.req } });
    expect(row.raisedOnBehalf).toBe(true);
    expect(row.assigneeId).toBe(ids.am);
    const mine = await http().get('/client/requests').set(as('manualOwner')).expect(code(200));
    expect(mine.body.some((x: { id: string }) => x.id === ids.req)).toBe(true);
  });

  it('reassigns the request (registered target "request") and the new handler sees it', async () => {
    await http().post('/actions/reassign/request/apply').set(as('am2')).send({ ids: [ids.req], toUserId: ids.am2, reason: 'overload' }).expect(code(403));
    // Someone over 120% of capacity needs Department Head approval first (core rule); pick the least loaded.
    const cands = await http().get(`/actions/reassign/request/candidates?ids=${ids.req}`).set(as('am')).expect(code(200));
    const pick = cands.body.candidates.find((c: { id: string; blockedReason: string | null; loadPct: number }) => c.id !== ids.am && !c.blockedReason && c.loadPct < 100);
    expect(pick).toBeTruthy();
    const rr = await http().post('/actions/reassign/request/apply').set(as('am')).send({ ids: [ids.req], toUserId: pick.id, reason: 'skill_fit' }).expect(code(200));
    expect(rr.body).toMatchObject({ applied: 1 });
    expect((await prisma.request.findUniqueOrThrow({ where: { id: ids.req } })).assigneeId).toBe(pick.id);
    const v = await http().get(`/requests/${ids.req}`).set(as('am')).expect(code(200));
    expect(v.body.assignee.id).toBe(pick.id);
    await http().post('/actions/reassign/request/apply').set(as('lead')).send({ ids: [ids.req], toUserId: ids.am, reason: 'client_request' }).expect(code(200));
  });

  it('converts an approved request to tasks', async () => {
    const blocked = await http().get(`/clients-actions/requests/${ids.req}/convert`).set(as('am')).expect(code(200));
    expect(blocked.body.blocked).toMatch(/Decide the request first/);
    await http().post(`/requests/${ids.req}/decide`).set(as('am')).send({ action: 'in_scope' }).expect(code(200));
    const p = await http().get(`/clients-actions/requests/${ids.req}/convert`).set(as('am')).expect(code(200));
    expect(p.body.blocked).toBeNull();
    const dept = p.body.departments[0].id;
    const owner = p.body.people.find((x: { departmentId: string | null }) => x.departmentId === dept) ?? p.body.people[0];
    await http().post(`/clients-actions/requests/${ids.req}/convert`).set(as('design')).send({ lines: [{ title: 'x y z', departmentId: dept, ownerId: owner.id, deadline: dayAhead(3) }] }).expect(code(403));
    const c = await http()
      .post(`/clients-actions/requests/${ids.req}/convert`)
      .set(as('am'))
      .send({ lines: [{ title: tag('Edit menu reel'), departmentId: owner.departmentId ?? dept, ownerId: owner.id, deadline: dayAhead(3) }] })
      .expect(code(200));
    expect(c.body.taskIds.length).toBe(1);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: c.body.taskIds[0] } })).flowStep).toBe(`request:${ids.req}`);
  });

  it('custom-priced add-on: above the limit goes to an Admin first, below is sent', async () => {
    const big = await http().post('/clients-actions/requests').set(as('am')).send({ engagementId: ids.manualEng, type: 'new_scope', description: tag('Full brand film') }).expect(code(201));
    const r = await http().post(`/clients-actions/requests/${big.body.id}/custom-quote`).set(as('am')).send({ amountPaise: 9_000_000, timeline: '3 weeks', item: 'Brand film' }).expect(code(200));
    expect(r.body.approval.id).toBeTruthy();
    expect((await prisma.request.findUniqueOrThrow({ where: { id: big.body.id } })).status).not.toBe('quoted');
    await decide('am', r.body.approval.id, 'approve', 403);
    await decide('admin', r.body.approval.id);
    expect((await prisma.request.findUniqueOrThrow({ where: { id: big.body.id } })).status).toBe('quoted');
    const small = await http().post('/clients-actions/requests').set(as('am')).send({ engagementId: ids.manualEng, type: 'new_scope', description: tag('Two extra posts') }).expect(code(201));
    const s = await http().post(`/clients-actions/requests/${small.body.id}/custom-quote`).set(as('am')).send({ amountPaise: 400_000, timeline: '2 days', item: 'Two posts' }).expect(code(200));
    expect(s.body.approval).toBeNull();
    expect((await prisma.request.findUniqueOrThrow({ where: { id: small.body.id } })).status).toBe('quoted');
    await http().post(`/clients-actions/requests/${small.body.id}/custom-quote`).set(as('am2')).send({ amountPaise: 400_000, timeline: '2 days', item: 'Two posts' }).expect(code(403));
  });

  it('asks a named colleague for an internal approval', async () => {
    const r = await http().post('/clients-actions/internal-approval').set(as('am')).send({ what: 'Give Aroma a 10% loyalty discount', approverId: ids.finance, byWhen: dayAhead(2), targetType: 'client', targetId: ids.manual }).expect(code(201));
    const a = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: r.body.approval.id } });
    expect(a.approverId).toBe(ids.finance);
    expect(a.targetType).toBe('client_org');
    await decide('am2', a.id, 'approve', 403);
    await decide('finance', a.id);
  });
});

describe('lists, bulk and import', () => {
  it('lists with filters, scopes AMs to their clients, refuses designers', async () => {
    const all = await http().get('/clients-actions/list?status=active').set(as('lead')).expect(code(200));
    expect(all.body.some((c: { id: string }) => c.id === ids.manual)).toBe(true);
    const mine = await http().get('/clients-actions/list').set(as('am2')).expect(code(200));
    expect(mine.body.some((c: { id: string }) => c.id === ids.online)).toBe(true);
    expect(mine.body.some((c: { id: string }) => c.id === ids.manual)).toBe(false);
    await http().get('/clients-actions/list').set(as('design')).expect(code(403));
  });

  it('bulk tags and archives with a reason (undo available); AMs cannot archive', async () => {
    const extra = await create('lead', base('Bulk One'));
    await http().post('/clients-actions/bulk').set(as('am')).send({ ids: [extra.client.id], action: 'archive', reason: 'Duplicate entry' }).expect(code(403));
    await http().post('/clients-actions/bulk').set(as('lead')).send({ ids: [extra.client.id], action: 'tag', tag: `vip-${tail}` }).expect(code(200));
    const tagged = await http().get(`/clients-actions/list?tag=vip-${tail}`).set(as('lead')).expect(code(200));
    expect(tagged.body.map((c: { id: string }) => c.id)).toEqual([extra.client.id]);
    const a = await http().post('/clients-actions/bulk').set(as('lead')).send({ ids: [extra.client.id], action: 'archive', reason: 'Duplicate entry' }).expect(code(200));
    expect(a.body.undo?.token).toBeTruthy();
    expect((await prisma.clientOrg.findUniqueOrThrow({ where: { id: extra.client.id } })).archivedAt).toBeTruthy();
    await http().post(`/actions/undo/${a.body.undo.token}`).set(as('lead')).expect(code(200));
    expect((await prisma.clientOrg.findUniqueOrThrow({ where: { id: extra.client.id } })).archivedAt).toBeNull();
  });

  it('imports clients from CSV', async () => {
    const csv = ['Business name,Contact name,Contact phone,Contact email,Industry,Billing name,Billing address,Branch,GSTIN,Account manager', `${tag('Imported Cafe')},Ravi K,${phone()},ravi.${stamp}@example.com,Restaurants & cafes,Imported Cafe LLP,"5 Brigade Road, Bengaluru",Bengaluru,,am@bmu.demo`, `${tag('Broken')},,,,,,,,BADGST,`].join('\n');
    await http().post('/imports/clients').set(as('am')).send({ csv }).expect(code(403));
    const p = await http().post('/imports/clients').set(as('lead')).send({ csv, fileName: `clients-${stamp}.csv` }).expect(code(200));
    expect(p.body.rowsTotal).toBe(2);
    expect(p.body.rowsOk).toBe(1);
    const c = await http().post(`/imports/jobs/${p.body.id}/commit`).set(as('lead')).send({ skipDuplicates: true }).expect(code(200));
    expect(c.body.status).toBe('committed');
    const row = await prisma.clientOrg.findFirstOrThrow({ where: { name: tag('Imported Cafe') } });
    created.push(row.id);
    expect(row.source).toBe('import');
    expect(row.amUserId).toBe(ids.am);
  });
});

describe('createClientFromLead (for the leads area)', () => {
  it('Sales Manager converts a lead with payment proof; Finance confirms', async () => {
    const lead = await prisma.lead.create({ data: { orgId: ids.org, source: 'website', contact: { name: 'Lead Person', email: `lead.${stamp}@example.com`, phone: phone(), company: tag('Lead Co') }, need: 'Social media', stage: 'proposal_sent' } });
    leads.push(lead.id);
    const body = { engagements: [{ serviceId: ids.monthly, tier: 'starter' }], paymentReference: `UTR-L-${tail}`, industry: 'Retail', billingAddress: '1 Residency Road, Bengaluru', branchId: ids.branch };
    await http().post(`/clients-actions/from-lead/${lead.id}`).set(as('am')).send(body).expect(code(403));
    const r = await http().post(`/clients-actions/from-lead/${lead.id}`).set(as('sales')).send(body).expect(code(201));
    created.push(r.body.client.id);
    expect(r.body.approval.id).toBeTruthy();
    const c = await prisma.clientOrg.findUniqueOrThrow({ where: { id: r.body.client.id } });
    expect(c.source).toBe('lead');
    expect(c.leadId).toBe(lead.id);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).stage).toBe('won');
  });
});

describe('offboarding', () => {
  it('AM Lead asks, Admin approves, checklist, client confirms, users read-only', async () => {
    await http().post(`/clients-actions/${ids.manual}/offboard`).set(as('am')).send({ reason: 'Budget cut', lastCycle: month() }).expect(code(403));
    const r = await http().post(`/clients-actions/${ids.manual}/offboard`).set(as('lead')).send({ reason: 'Budget cut', lastCycle: month() }).expect(code(200));
    expect(r.body.approval.id).toBeTruthy();
    await decide('lead', r.body.approval.id, 'approve', 403);
    await decide('admin', r.body.approval.id);
    let d = (await http().get(`/clients-actions/${ids.manual}`).set(as('am')).expect(code(200))).body;
    expect(d.offboarding.status).toBe('in_progress');
    // Dues first: unpaid invoices block "dues cleared".
    const unpaid = await prisma.invoice.findMany({ where: { clientOrgId: ids.manual, status: { notIn: ['paid', 'void', 'credit_noted'] } } });
    if (unpaid.length) {
      const blocked = await http().post(`/clients-actions/${ids.manual}/offboard/checklist`).set(as('am')).send({ key: 'dues_cleared', done: true }).expect(code(400));
      expect(blocked.body.message).toMatch(/Still unpaid/);
      await prisma.invoice.updateMany({ where: { id: { in: unpaid.map((u) => u.id) } }, data: { status: 'paid' } });
    }
    const early = await http().post(`/clients-actions/${ids.manual}/offboard/complete`).set(as('am')).expect(code(400));
    expect(early.body.message).toMatch(/Finish the checklist/);
    for (const key of ['dues_cleared', 'final_files', 'access_removed', 'permissions', 'final_report', 'pending_work', 'contract_closed']) {
      d = (await http().post(`/clients-actions/${ids.manual}/offboard/checklist`).set(as('am')).send({ key, done: true }).expect(code(200))).body;
    }
    d = (await http().post(`/clients-actions/${ids.manual}/offboard/complete`).set(as('am')).expect(code(200))).body;
    expect(d.offboarding.status).toBe('awaiting_client');
    const acct = await http().post('/client-actions/offboarding/confirm').set(as('manualOwner')).expect(code(200));
    expect(acct.body.offboarding.status).toBe('closed');
    expect(acct.body.readOnly).toBe(true);
    const c = await prisma.clientOrg.findUniqueOrThrow({ where: { id: ids.manual } });
    expect(c.readOnlyUntil!.getTime()).toBeGreaterThan(Date.now() + 89 * 86_400_000);
    // Read-only: can look, can't change.
    await http().get('/client/requests').set(as('manualOwner')).expect(code(200));
    const w = await http().post('/client/thread/messages').set(as('manualOwner')).send({ body: 'Hello?' }).expect(code(403));
    expect(w.body.message).toMatch(/read-only|closed/i);
  });
});
