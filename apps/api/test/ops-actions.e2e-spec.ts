// v11 ops: leads & sales, finance, creators, files, communication and admin configuration actions end to end,
// with the role checks for each (including the forbidden ones).
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { OpsLeadsService } from '../src/ops-actions/ops-leads.service.js';

let app: INestApplication;
let prisma: PrismaService;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const stamp = Date.now();
const tail = String(stamp).slice(-8);
/** A unique valid Indian mobile per test case. */
const phone = (n: number) => `9${n}${tail}`.slice(0, 10);
const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

function dayAhead(n: number) {
  return new Date(Date.now() + 5.5 * 3600_000 + n * 86_400_000).toISOString().slice(0, 10);
}

async function signIn(identifier: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier, code: otp.body.devCode }).expect(200)).body.token as string;
}

async function decide(who: string, approvalId: string, decision: 'approve' | 'reject' = 'approve') {
  const r = await http().post(`/actions/approvals/${approvalId}/decide`).set(as(who)).send({ decision, note: 'ok' });
  if (r.status !== 200) throw new Error(`decide as ${who}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

async function proof(who = 'finance') {
  const r = await http().post('/ops/uploads/proof').set(as(who)).attach('file', png, { filename: `slip-${stamp}.png`, contentType: 'image/png' }).expect(201);
  return r.body.id as string;
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
    salesManager: 'sales.manager@bmu.demo',
    sales: 'sales@bmu.demo',
    am: 'am@bmu.demo',
    finance: 'finance@bmu.demo',
    producer: 'producer@bmu.demo',
    head: 'design.head@bmu.demo',
    hr: 'hr@bmu.demo',
    creator: 'creator@bmu.demo',
    client: 'client@sunrise.demo',
  };
  for (const [k, email] of Object.entries(people)) {
    tokens[k] = await signIn(email);
    ids[k] = (await prisma.user.findFirstOrThrow({ where: { email } })).id;
  }
  ids.org = (await prisma.user.findUniqueOrThrow({ where: { id: ids.founder } })).orgId;
  ids.sunrise = (await prisma.clientOrg.findFirstOrThrow({ where: { name: 'Sunrise Realty Pvt Ltd' } })).id;
});

afterAll(async () => {
  // Creator logins made here are soft-deleted; leads are soft-deleted; the temporary G5 engagement is removed.
  const creators = await prisma.creator.findMany({ where: { handle: { contains: tail } }, select: { userId: true } });
  await prisma.user.updateMany({ where: { id: { in: creators.map((c) => c.userId) } }, data: { deletedAt: new Date(), phone: null, email: null } });
  const leads = await prisma.lead.findMany({ where: { orgId: ids.org, need: { contains: `${stamp}` } }, select: { id: true } });
  await prisma.lead.updateMany({ where: { id: { in: leads.map((l) => l.id) }, stage: { not: 'won' } }, data: { deletedAt: new Date() } });
  if (ids.g5Eng) {
    await prisma.file.updateMany({ where: { engagementId: ids.g5Eng }, data: { engagementId: null } });
    await prisma.engagement.update({ where: { id: ids.g5Eng }, data: { deletedAt: new Date() } });
  }
  if (ids.reqItem) await prisma.requirementItem.delete({ where: { id: ids.reqItem } }).catch(() => undefined);
  await app.close();
});

// ---------------------------------------------------------------------------
describe('leads: add lead', () => {
  it('only the sales team, founder, admin and CMs (referrals only) can add leads', async () => {
    const base = { name: 'Asha Rao', phone: phone(1), company: `Rao Textiles ${stamp}`, source: 'phone', serviceIds: ['smm'], need: `Instagram ${stamp}` };
    await http().post('/ops/leads').set(as('producer')).send(base).expect(403);
    await http().post('/ops/leads').set(as('client')).send(base).expect(403);
    const r = await http().post('/ops/leads').set(as('am')).send(base).expect(403);
    expect(r.body.message).toMatch(/referrals only/i);
    const ok = await http().post('/ops/leads').set(as('am')).send({ ...base, source: 'referral', referredBy: 'Sunrise Realty' }).expect(201);
    expect(ok.body.lead.source).toBe('referral');
    expect(ok.body.lead.owner).toBeTruthy();
    expect(ok.body.firstReplyDueAt).toBeTruthy();
    const owner = ok.body.lead.owner.id;
    const n = await prisma.notification.findFirst({ where: { userId: owner, kind: 'lead_assigned', link: `/team/leads/${ok.body.lead.id}` } });
    expect(n).toBeTruthy();
    ids.refLead = ok.body.lead.id;
  });

  it('required fields: name, phone, business name, source and service interest', async () => {
    const r = await http().post('/ops/leads').set(as('sales')).send({ name: 'X', phone: '123', company: '', source: 'nowhere', serviceIds: [] }).expect(400);
    expect(r.body.message).toBeTruthy();
  });

  it('a sales executive owns what they add; only a manager can give a lead to someone else', async () => {
    const mine = await http().post('/ops/leads').set(as('sales')).send({ name: 'Ravi', phone: phone(2), company: `Kumar Sweets ${stamp}`, source: 'walk_in', serviceIds: ['smm', 'gbp'], need: `Diwali ${stamp}` }).expect(201);
    expect(mine.body.lead.owner.id).toBe(ids.sales);
    ids.salesLead = mine.body.lead.id;
    await http().post('/ops/leads').set(as('sales')).send({ name: 'Ravi', phone: phone(3), company: `Other ${stamp}`, source: 'walk_in', serviceIds: ['smm'], ownerId: ids.salesManager }).expect(403);
    const given = await http().post('/ops/leads').set(as('salesManager')).send({ name: 'Neha', phone: phone(4), company: `Neha Salon ${stamp}`, source: 'instagram', serviceIds: ['smm'], ownerId: ids.sales, need: `Salon ${stamp}` }).expect(201);
    expect(given.body.lead.owner.id).toBe(ids.sales);
    expect(await prisma.notification.count({ where: { userId: ids.sales, link: `/team/leads/${given.body.lead.id}` } })).toBe(1);
    ids.managerLead = given.body.lead.id;
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: given.body.lead.id } });
    expect(lead.firstReplyDueAt!.getTime()).toBeGreaterThan(Date.now());
    expect(lead.createdById).toBe(ids.salesManager);
  });

  it('warns about duplicates on phone/email and adds anyway when confirmed', async () => {
    const body = { name: 'Ravi K', phone: phone(2), company: `Ravi New Co ${stamp}`, source: 'phone', serviceIds: ['seo'], need: `Dup ${stamp}` };
    const dup = await http().post('/ops/leads').set(as('sales')).send(body).expect(409);
    expect(dup.body.duplicates[0].id).toBe(ids.salesLead);
    expect(dup.body.duplicates[0].matchedOn).toContain('phone');
    const q = await http().get(`/ops/leads/duplicates?phone=${phone(2)}`).set(as('sales')).expect(200);
    expect(q.body.length).toBeGreaterThan(0);
    const ok = await http().post('/ops/leads').set(as('sales')).send({ ...body, confirmDuplicate: true }).expect(201);
    expect(ok.body.lead.duplicateOfId).toBe(ids.salesLead);
    ids.dupLead = ok.body.lead.id;
  });

  it('round-robin hands a manager-added lead without an owner to the sales team', async () => {
    const opts = await http().get('/ops/leads/options').set(as('salesManager')).expect(200);
    expect(opts.body.canPickOwner).toBe(true);
    expect((await http().get('/ops/leads/options').set(as('am')).expect(200)).body.referralOnly).toBe(true);
    const own = await http().post('/ops/leads').set(as('salesManager')).send({ name: 'Mgr', phone: `8${tail}11`.slice(0, 10), company: `Mgr Own ${stamp}`, source: 'website', serviceIds: ['seo'], ownerId: ids.salesManager, need: `Own ${stamp}` }).expect(201);
    ids.mgrLead = own.body.lead.id;
    const r = await http().post('/ops/leads').set(as('salesManager')).send({ name: 'Auto', phone: phone(5), company: `Auto Co ${stamp}`, source: 'event', serviceIds: ['website'], ownerId: 'auto', need: `Auto ${stamp}` }).expect(201);
    expect(r.body.lead.owner).toBeTruthy();
    expect(r.body.message).toMatch(/First reply due/);
  });
});

describe('leads: first reply, activity, lost, merge, bulk, notes, reassign, import, archive', () => {
  it('the first-reply SLA alerts the owner once when nobody replied in time', async () => {
    await prisma.lead.update({ where: { id: ids.managerLead }, data: { firstReplyDueAt: new Date(Date.now() - 60_000) } });
    const svc = app.get(OpsLeadsService);
    await svc.firstReplyAlerts(new Date(), ids.org);
    const alert = await prisma.notification.findFirst({ where: { userId: ids.sales, kind: 'lead_follow_up', link: `/team/leads/${ids.managerLead}` } });
    expect(alert?.critical).toBe(true);
    await svc.firstReplyAlerts(new Date(), ids.org);
    expect(await prisma.notification.count({ where: { userId: ids.sales, kind: 'lead_follow_up', link: `/team/leads/${ids.managerLead}` } })).toBe(1);
  });

  it('logging a call needs the outcome and the next follow-up, and stops the first-reply timer', async () => {
    const at = `/sell/leads/${ids.managerLead}/activities`;
    await http().post(at).set(as('sales')).send({ kind: 'call', body: 'Spoke briefly' }).expect(400);
    await http().post(at).set(as('sales')).send({ kind: 'call', outcome: 'interested', body: 'Spoke briefly' }).expect(400);
    const next = new Date(Date.now() + 26 * 3_600_000).toISOString();
    const d = await http().post(at).set(as('sales')).send({ kind: 'call', outcome: 'interested', body: 'Wants a quote', nextFollowUpAt: next }).expect(201);
    expect(d.body.lead.stage).toBe('contacted');
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: ids.managerLead } })).firstReplyAt).toBeTruthy();
    await http().post(at).set(as('sales')).send({ kind: 'note', body: 'A plain note needs nothing else' }).expect(201);
    // A sent email/WhatsApp has no outcome yet, but still needs the next follow-up.
    await http().post(at).set(as('sales')).send({ kind: 'email', body: 'Sent the deck' }).expect(400);
    await http().post(at).set(as('sales')).send({ kind: 'email', body: 'Sent the deck', nextFollowUpAt: next }).expect(201);
  });

  it('notes and meetings can be logged against a lead (+ New → Note / Meeting)', async () => {
    await http().post(`/ops/leads/${ids.managerLead}/notes`).set(as('producer')).send({ kind: 'note', body: 'hello' }).expect((r) => expect([403, 404]).toContain(r.status));
    await http().post(`/ops/leads/${ids.managerLead}/notes`).set(as('sales')).send({ kind: 'meeting', body: 'Discovery' }).expect(400);
    const when = new Date(Date.now() + 48 * 3_600_000).toISOString();
    const r = await http().post(`/ops/leads/${ids.managerLead}/notes`).set(as('sales')).send({ kind: 'meeting', body: 'Discovery at their office', at: when }).expect(201);
    expect(r.body.message).toMatch(/Meeting saved/);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: ids.managerLead } })).stage).toBe('discovery');
  });

  it('mark lost needs a reason and only the owner or a manager can do it', async () => {
    await http().post(`/ops/leads/${ids.salesLead}/lost`).set(as('sales')).send({ reason: '' }).expect(400);
    await http().post(`/ops/leads/${ids.salesLead}/lost`).set(as('am')).send({ reason: 'Budget too low' }).expect(403);
    const r = await http().post(`/ops/leads/${ids.salesLead}/lost`).set(as('sales')).send({ reason: 'Budget too low' }).expect(200);
    expect(r.body.stage).toBe('lost');
    expect(r.body.lostReason).toBe('Budget too low');
  });

  it('merge: sales managers and admins only', async () => {
    await http().post(`/ops/leads/${ids.dupLead}/merge`).set(as('sales')).send({ intoId: ids.managerLead }).expect(403);
    await http().post(`/ops/leads/${ids.dupLead}/merge`).set(as('salesManager')).send({ intoId: ids.dupLead }).expect(400);
    const r = await http().post(`/ops/leads/${ids.dupLead}/merge`).set(as('salesManager')).send({ intoId: ids.managerLead }).expect(200);
    expect(r.body.message).toMatch(/Merged/);
    const gone = await prisma.lead.findUnique({ where: { id: ids.dupLead } });
    expect(!gone || gone.deletedAt).toBeTruthy();
  });

  it('bulk tag and stage changes with undo; you can only bulk-change your own leads', async () => {
    await http().post('/ops/leads/bulk').set(as('sales')).send({ ids: [ids.mgrLead], action: 'tag', tag: 'diwali' }).expect((r) => expect([403, 404]).toContain(r.status));
    const t = await http().post('/ops/leads/bulk').set(as('salesManager')).send({ ids: [ids.managerLead, ids.refLead], action: 'tag', tag: `ops-${stamp}` }).expect(200);
    expect(t.body.message).toMatch(/Tagged 2/);
    const s = await http().post('/ops/leads/bulk').set(as('salesManager')).send({ ids: [ids.refLead], action: 'stage', stage: 'contacted' }).expect(200);
    expect(s.body.undo.token).toBeTruthy();
    await http().post(`/actions/undo/${s.body.undo.token}`).set(as('salesManager')).expect((r) => expect([200, 201]).toContain(r.status));
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: ids.refLead } })).stage).toBe('new');
  });

  it('reassign (lead_owner) runs through the engine: managers only, reason required', async () => {
    await http().get(`/actions/reassign/lead_owner/candidates?ids=${ids.mgrLead}`).set(as('sales')).expect((r) => expect([403, 404]).toContain(r.status));
    const c = await http().get(`/actions/reassign/lead_owner/candidates?ids=${ids.mgrLead}`).set(as('salesManager')).expect(200);
    const names = JSON.stringify(c.body);
    expect(names).toContain(ids.sales);
    await http().post('/actions/reassign/lead_owner/apply').set(as('salesManager')).send({ ids: [ids.mgrLead], toUserId: ids.sales }).expect(400);
    const ra = await http().post('/actions/reassign/lead_owner/apply').set(as('salesManager')).send({ ids: [ids.mgrLead], toUserId: ids.sales, reason: 'overload', handoverNote: 'Website lead' });
    expect([200, 201]).toContain(ra.status);
    // The engine asks for approval when the new owner is over capacity (depends on how many leads they hold).
    if (ra.body.approval) await decide('founder', ra.body.approval.id);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: ids.mgrLead } })).ownerId).toBe(ids.sales);
  });

  it('CSV import of leads (register "leads"): validates, flags duplicates, commits', async () => {
    const csv = [
      'Contact name,Phone,Business name,Source,Services,What they need',
      `Imported One,${phone(6)},Import Co ${stamp},referral,Social Media Management,Import ${stamp}`,
      `Bad Row,123,X,nowhere,Unknown Service,Import ${stamp}`,
    ].join('\n');
    await http().post('/imports/leads').set(as('producer')).send({ csv }).expect(403);
    const p = await http().post('/imports/leads').set(as('salesManager')).send({ csv, fileName: `leads-${stamp}.csv` }).expect(200);
    expect(p.body.rowsTotal).toBe(2);
    expect(p.body.rowsOk).toBe(1);
    const done = await http().post(`/imports/jobs/${p.body.id}/commit`).set(as('salesManager')).send({ skipDuplicates: true }).expect(200);
    expect(done.body.status).toBe('committed');
    const lead = await prisma.lead.findFirst({ where: { need: `Import ${stamp}`, deletedAt: null } });
    expect(lead?.firstReplyDueAt).toBeTruthy();
  });

  it('archive hides a lead from the board (generic archive, reason required)', async () => {
    await http().post(`/actions/archive/lead/${ids.salesLead}`).set(as('sales')).send({}).expect(400);
    await http().post(`/actions/archive/lead/${ids.salesLead}`).set(as('sales')).send({ reason: 'Old enquiry' }).expect((r) => expect([200, 201]).toContain(r.status));
    const list = (await http().get('/leads').set(as('salesManager')).expect(200)).body as { id: string }[];
    expect(list.some((l) => l.id === ids.salesLead)).toBe(false);
  });
});

describe('leads: manual convert to client with payment proof', () => {
  it('sales manager records an offline payment with proof; Finance approves; the client is created', async () => {
    const lead = await http().post('/ops/leads').set(as('salesManager')).send({ name: 'Convert Owner', email: `convert.${stamp}@example.com`, phone: phone(7), company: `Convert Co ${stamp}`, source: 'referral', serviceIds: ['smm'], ownerId: ids.salesManager, need: `Convert ${stamp}` }).expect(201);
    const leadId = lead.body.lead.id;
    const prop = await http().post('/proposals').set(as('salesManager')).send({ leadId, lines: [{ serviceKey: 'smm', tier: 'growth' }] }).expect(201);
    await http().post(`/proposals/${prop.body.id}/send`).set(as('salesManager')).expect(200);
    const opts = await http().get(`/ops/leads/${leadId}/convert-options`).set(as('salesManager')).expect(200);
    expect(opts.body[0].id).toBe(prop.body.id);
    const amount = opts.body[0].firstPaymentPaise as number;
    const body = { proposalId: prop.body.id, amountPaise: amount, method: 'bank', ref: `NEFT${tail}`, paidOn: dayAhead(0) };
    await http().post(`/ops/leads/${leadId}/convert`).set(as('sales')).send({ ...body, proofFileId: 'x' }).expect((r) => expect([403, 404]).toContain(r.status));
    await http().post(`/ops/leads/${leadId}/convert`).set(as('salesManager')).send(body).expect(400);
    const slip = await proof('salesManager');
    await http().post(`/ops/leads/${leadId}/convert`).set(as('salesManager')).send({ ...body, amountPaise: 100, proofFileId: slip }).expect(400);
    const r = await http().post(`/ops/leads/${leadId}/convert`).set(as('salesManager')).send({ ...body, proofFileId: slip }).expect(200);
    expect(r.body.applied).toBe(false);
    expect(r.body.approvalId).toBeTruthy();
    await http().post(`/actions/approvals/${r.body.approvalId}/decide`).set(as('salesManager')).send({ decision: 'approve' }).expect(403);
    await decide('finance', r.body.approvalId);
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(after.stage).toBe('won');
    const client = await prisma.clientOrg.findFirstOrThrow({ where: { leadId } });
    const pay = await prisma.payment.findFirst({ where: { invoice: { clientOrgId: client.id } } });
    expect(pay?.proofFileId).toBeTruthy();
    expect(await prisma.notification.count({ where: { userId: ids.salesManager, kind: 'deal_won', link: `/team/clients/${client.id}` } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('finance', () => {
  it('manual invoice: Finance/Admin only, pass-through lines without GST and on their own lines', async () => {
    await http().post('/ops/finance/invoices').set(as('producer')).send({}).expect(403);
    await http().post('/ops/finance/invoices').set(as('am')).send({}).expect(403);
    const due = dayAhead(15);
    await http()
      .post('/ops/finance/invoices')
      .set(as('finance'))
      .send({ clientOrgId: ids.sunrise, dueDate: due, lines: [{ label: 'Social media + ad spend', kind: 'service', amountPaise: 100_000 }] })
      .expect(400);
    const r = await http()
      .post('/ops/finance/invoices')
      .set(as('finance'))
      .send({ clientOrgId: ids.sunrise, dueDate: due, notes: `ops ${stamp}`, lines: [{ label: 'October retainer', kind: 'service', amountPaise: 1_000_000 }, { label: 'Meta ads October', kind: 'ad_spend', amountPaise: 500_000 }] })
      .expect(201);
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(inv.gstPaise).toBe(180_000);
    expect(inv.totalPaise).toBe(1_680_000);
    expect(inv.status).toBe('issued');
    expect(JSON.stringify(inv.lines)).toMatch(/at cost, no GST/);
    ids.invoice = inv.id;
    const draft = await http().post('/ops/finance/invoices').set(as('admin')).send({ clientOrgId: ids.sunrise, dueDate: due, issue: false, lines: [{ label: 'Draft line', kind: 'service', amountPaise: 10_000 }] }).expect(201);
    expect(draft.body.status).toBe('draft');
    expect((await http().get('/ops/finance/drafts').set(as('finance')).expect(200)).body.some((d: { id: string }) => d.id === draft.body.id)).toBe(true);
    await http().post(`/ops/finance/invoices/${draft.body.id}/issue`).set(as('finance')).expect(200);
  });

  it('offline payment needs amount, date, reference and proof', async () => {
    const base = { amountPaise: 200_000, method: 'bank', ref: `UTR${tail}`, at: dayAhead(0) };
    await http().post(`/ops/finance/invoices/${ids.invoice}/offline-payment`).set(as('am')).send({ ...base, proofFileId: 'x' }).expect(403);
    await http().post(`/ops/finance/invoices/${ids.invoice}/offline-payment`).set(as('finance')).send(base).expect(400);
    const slip = await proof();
    const r = await http().post(`/ops/finance/invoices/${ids.invoice}/offline-payment`).set(as('finance')).send({ ...base, proofFileId: slip }).expect(201);
    expect(r.body.status).toBe('partially_paid');
    const p = await prisma.payment.findFirstOrThrow({ where: { invoiceId: ids.invoice } });
    expect(p.proofFileId).toBeTruthy();
    expect(p.recordedById).toBe(ids.finance);
  });

  it('due date: reason required; up to 7 days applies; more needs a Branch Manager', async () => {
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: ids.invoice } });
    const plus = (d: number) => new Date(inv.dueDate.getTime() + d * 86_400_000 + 5.5 * 3_600_000).toISOString().slice(0, 10);
    await http().post(`/ops/finance/invoices/${ids.invoice}/due-date`).set(as('finance')).send({ dueDate: plus(3) }).expect(400);
    await http().post(`/ops/finance/invoices/${ids.invoice}/due-date`).set(as('producer')).send({ dueDate: plus(3), reason: 'Asked' }).expect(403);
    const short = await http().post(`/ops/finance/invoices/${ids.invoice}/due-date`).set(as('finance')).send({ dueDate: plus(3), reason: 'Client asked for a few days' }).expect(200);
    expect(short.body.applied).toBe(true);
    const long = await http().post(`/ops/finance/invoices/${ids.invoice}/due-date`).set(as('finance')).send({ dueDate: plus(15), reason: 'Festival cash crunch' }).expect(200);
    expect(long.body.applied).toBe(false);
    await http().post(`/actions/approvals/${long.body.approvalId}/decide`).set(as('finance')).send({ decision: 'approve' }).expect(403);
    await decide('admin', long.body.approvalId);
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: ids.invoice } });
    expect(after.dueDateChanges).toBe(2);
  });

  it('creator payout: the UGC coordinator proposes, Finance approves', async () => {
    const creator = await prisma.creator.findFirstOrThrow({ where: { userId: ids.creator } });
    const brief = await prisma.creatorBrief.create({ data: { orgId: ids.org, creatorId: creator.id, title: `Payout brief ${stamp}`, brief: 'Two reels', deliverables: ['2 reels'], feePaise: 400_000, status: 'submitted', createdById: ids.am } });
    ids.payoutBrief = brief.id;
    await http().post('/ops/finance/payouts').set(as('producer')).send({ creatorId: creator.id, briefId: brief.id, amountPaise: 400_000 }).expect(403);
    const r = await http().post('/ops/finance/payouts').set(as('am')).send({ creatorId: creator.id, briefId: brief.id, amountPaise: 400_000, note: 'Delivered on time' }).expect(201);
    expect(r.body.applied).toBe(false);
    await http().post(`/actions/approvals/${r.body.approvalId}/decide`).set(as('am')).send({ decision: 'approve' }).expect(403);
    await decide('finance', r.body.approvalId);
    const payout = await prisma.creatorPayout.findUniqueOrThrow({ where: { briefId: brief.id } });
    expect(payout.tdsPaise).toBe(40_000);
    expect(payout.netPaise).toBe(360_000);
  });
});

// ---------------------------------------------------------------------------
describe('creators', () => {
  it('add creator: coordinator only, required fields, duplicate check on phone and handle', async () => {
    const body = { name: 'Aisha Khan', phone: phone(8), handle: `@Aisha.eats${tail}`, niche: ['food'], rates: [{ label: 'Per reel', pricePaise: 400_000 }], city: 'Bengaluru' };
    await http().post('/ops/creators').set(as('producer')).send(body).expect(403);
    await http().post('/ops/creators').set(as('am')).send({ ...body, city: '' }).expect(400);
    const r = await http().post('/ops/creators').set(as('am')).send(body).expect(201);
    ids.newCreator = r.body.id;
    const c = await prisma.creator.findUniqueOrThrow({ where: { id: r.body.id }, include: { user: true } });
    expect(c.handle).toBe(`aisha.eats${tail}`);
    expect(c.user.type).toBe('creator');
    const samePhone = await http().post('/ops/creators').set(as('am')).send({ ...body, handle: `other${tail}`, confirmDuplicate: true }).expect(409);
    expect(samePhone.body.duplicates[0].matchedOn).toContain('phone');
    const sameHandle = await http().post('/ops/creators').set(as('head')).send({ ...body, phone: phone(9) }).expect(409);
    expect(sameHandle.body.duplicates[0].id).toBe(r.body.id);
    const forced = await http().post('/ops/creators').set(as('head')).send({ ...body, phone: phone(9), confirmDuplicate: true }).expect(201);
    ids.secondCreator = forced.body.id;
  });

  it('lists, shows and edits creators', async () => {
    const list = (await http().get('/ops/creators').set(as('am')).expect(200)).body as { id: string }[];
    expect(list.some((c) => c.id === ids.newCreator)).toBe(true);
    await http().get('/ops/creators').set(as('producer')).expect(403);
    await http().patch(`/ops/creators/${ids.newCreator}`).set(as('am')).send({ city: 'Mysuru' }).expect(200);
    const d = (await http().get(`/ops/creators/${ids.newCreator}`).set(as('am')).expect(200)).body;
    expect(d.city).toBe('Mysuru');
  });

  it('reassign a brief (creator_brief) to another creator through the engine', async () => {
    const brief = await prisma.creatorBrief.create({ data: { orgId: ids.org, creatorId: ids.newCreator, title: `Move brief ${stamp}`, brief: 'One reel', deliverables: ['1 reel'], feePaise: 300_000, status: 'offered', createdById: ids.am } });
    const target = await prisma.creator.findUniqueOrThrow({ where: { id: ids.secondCreator } });
    const c = await http().get(`/actions/reassign/creator_brief/candidates?ids=${brief.id}`).set(as('am')).expect(200);
    expect(JSON.stringify(c.body)).toContain(target.userId);
    await http().get(`/actions/reassign/creator_brief/candidates?ids=${brief.id}`).set(as('producer')).expect(403);
    await http().post('/actions/reassign/creator_brief/apply').set(as('am')).send({ ids: [brief.id], toUserId: target.userId, reason: 'skill_fit' }).expect((r) => expect([200, 201]).toContain(r.status));
    const after = await prisma.creatorBrief.findUniqueOrThrow({ where: { id: brief.id } });
    expect(after.creatorId).toBe(ids.secondCreator);
    expect(after.status).toBe('offered');
    expect(await prisma.notification.count({ where: { userId: target.userId, link: `/creator/briefs/${brief.id}` } })).toBeGreaterThan(0);
    ids.movedBrief = brief.id;
  });

  it('rate a creator after delivery: score and note required, once per brief', async () => {
    await http().post(`/ops/creators/briefs/${ids.movedBrief}/rating`).set(as('am')).send({ score: 4, note: 'Good' }).expect(400);
    await http().post(`/ops/creators/briefs/${ids.payoutBrief}/rating`).set(as('am')).send({ score: 4, note: 'Good' }).expect(400);
    await prisma.creatorBrief.update({ where: { id: ids.payoutBrief }, data: { status: 'approved' } });
    await http().post(`/ops/creators/briefs/${ids.payoutBrief}/rating`).set(as('producer')).send({ score: 4, note: 'Good work' }).expect(403);
    await http().post(`/ops/creators/briefs/${ids.payoutBrief}/rating`).set(as('am')).send({ score: 9, note: 'Good work' }).expect(400);
    const r = await http().post(`/ops/creators/briefs/${ids.payoutBrief}/rating`).set(as('am')).send({ score: 4, note: 'Good work, on time' }).expect(201);
    expect(r.body.ratingCount).toBeGreaterThan(0);
    await http().post(`/ops/creators/briefs/${ids.payoutBrief}/rating`).set(as('am')).send({ score: 5, note: 'Again' }).expect(400);
  });

  it('CSV import of creators, archive refused while briefs are open, history', async () => {
    const csv = ['Name,Mobile,Handle,City,Niche,Rate per reel (₹)', `Imported Creator,${phone(0)},imp${tail},Pune,fitness,3500`, `Dup Creator,${phone(8)},dup${tail},Pune,fitness,3500`].join('\n');
    const p = await http().post('/imports/creators').set(as('am')).send({ csv }).expect(200);
    expect(p.body.rowsOk).toBe(1);
    await http().post(`/imports/jobs/${p.body.id}/commit`).set(as('am')).send({ skipDuplicates: true }).expect(200);
    expect(await prisma.creator.count({ where: { handle: `imp${tail}` } })).toBe(1);
    await http().post(`/actions/archive/creator/${ids.secondCreator}`).set(as('am')).send({ reason: 'Stopped working with us' }).expect(400);
    const h = await http().get(`/team-flows/activity?entity=Creator&id=${ids.newCreator}`).set(as('am')).expect(200);
    expect(h.body.items.some((i: { action: string }) => i.action === 'creator.created')).toBe(true);
    await http().get(`/team-flows/activity?entity=Creator&id=${ids.newCreator}`).set(as('producer')).expect(403);
  });
});

// ---------------------------------------------------------------------------
describe('files', () => {
  it('team upload: staff on assigned clients; listed with folder and permissions', async () => {
    const other = await prisma.clientOrg.findFirstOrThrow({ where: { orgId: ids.org, amUserId: { not: ids.am }, deletedAt: null } });
    await http().post('/ops/files').set(as('am')).field('clientOrgId', other.id).attach('file', png, { filename: 'x.png', contentType: 'image/png' }).expect(403);
    await http().post('/ops/files').set(as('am')).field('clientOrgId', ids.sunrise).expect(400);
    const r = await http().post('/ops/files').set(as('am')).field('clientOrgId', ids.sunrise).field('folder', 'working').field('tags', 'logo, draft').attach('file', png, { filename: `brochure-${stamp}.png`, contentType: 'image/png' }).expect(201);
    ids.file = r.body.id;
    const list = (await http().get(`/ops/files?clientOrgId=${ids.sunrise}`).set(as('am')).expect(200)).body;
    const row = list.rows.find((f: { id: string }) => f.id === ids.file);
    expect(row.folder).toBe('working');
    expect(row.tags).toEqual(['logo', 'draft']);
    expect(row.can.edit).toBe(true);
    // Team uploads stay internal until released.
    await http().get(`/files/${ids.file}`).set(as('client')).expect(404);
  });

  it('client uploads land in From client and tick the matching checklist item', async () => {
    const eng = await prisma.engagement.findFirstOrThrow({ where: { clientOrgId: ids.sunrise, deletedAt: null }, include: { cycles: true } });
    const item = await prisma.requirementItem.create({ data: { orgId: ids.org, cycleId: eng.cycles[0].id, label: `Brand logo ${stamp}`, type: 'asset' } });
    ids.reqItem = item.id;
    await http().post('/ops/client/files').set(as('am')).attach('file', png, { filename: 'a.png', contentType: 'image/png' }).expect(403);
    const r = await http().post('/ops/client/files').set(as('client')).field('requirementItemId', item.id).attach('file', png, { filename: `logo-${stamp}.png`, contentType: 'image/png' }).expect(201);
    expect(r.body.ticked).toContain(item.label);
    expect((await prisma.requirementItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe('received');
    const f = await prisma.file.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(f.folder).toBe('from_client');
    await http().get(`/files/${f.id}`).set(as('client')).expect(200);
    const mine = (await http().get('/ops/client/files').set(as('client')).expect(200)).body;
    expect(mine.uploads.some((u: { id: string }) => u.id === f.id)).toBe(true);
    expect(await prisma.notification.count({ where: { userId: ids.am, kind: 'requirement_sent', title: { contains: `logo-${stamp}` } } })).toBe(1);
  });

  it('move / rename / tag: uploader, CM or department head only', async () => {
    await http().patch(`/ops/files/${ids.file}`).set(as('producer')).send({ name: 'nope' }).expect((r) => expect([403, 404]).toContain(r.status));
    await http().patch(`/ops/files/${ids.file}`).set(as('am')).send({ name: `Brochure final ${stamp}.png`, tags: ['brochure'] }).expect(200);
    await http().patch(`/ops/files/${ids.file}`).set(as('head')).send({ folder: 'brand' }).expect(200);
    const f = await prisma.file.findUniqueOrThrow({ where: { id: ids.file } });
    expect(f.name).toBe(`Brochure final ${stamp}.png`);
    expect(f.folder).toBe('brand');
  });

  it('release final files only after Gate 5', async () => {
    const svc = await prisma.service.findFirstOrThrow({ where: { orgId: ids.org, key: 'website' } });
    const eng = await prisma.engagement.create({ data: { orgId: ids.org, clientOrgId: ids.sunrise, serviceId: svc.id, tier: 'growth', billingType: 'one_time', status: 'in_review', currentGate: 'G4', amId: ids.am } });
    ids.g5Eng = eng.id;
    await http().patch(`/ops/files/${ids.file}`).set(as('am')).send({ engagementId: eng.id }).expect(200);
    const blocked = await http().post(`/ops/files/${ids.file}/release`).set(as('am')).expect(400);
    expect(blocked.body.message).toMatch(/Final files/);
    await http().patch(`/ops/files/${ids.file}`).set(as('am')).send({ folder: 'final' }).expect(200);
    const g4 = await http().post(`/ops/files/${ids.file}/release`).set(as('am')).expect(400);
    expect(g4.body.message).toMatch(/Gate 5/);
    await http().post(`/ops/files/${ids.file}/release`).set(as('head')).expect(403);
    await prisma.engagement.update({ where: { id: eng.id }, data: { currentGate: 'G5', status: 'delivered', finalSignedOffAt: new Date() } });
    await http().post(`/ops/files/${ids.file}/release`).set(as('am')).expect(200);
    await http().get(`/files/${ids.file}?download=1`).set(as('client')).expect(200);
  });

  it('share link: CM or Branch Manager, expiry required, optional password checked on the public page', async () => {
    await http().post(`/ops/files/${ids.file}/shares`).set(as('head')).send({ expiresInDays: 7 }).expect(403);
    await http().post(`/ops/files/${ids.file}/shares`).set(as('am')).send({}).expect(400);
    const s = await http().post(`/ops/files/${ids.file}/shares`).set(as('am')).send({ expiresInDays: 7, password: 'sun123' }).expect(201);
    expect(s.body.url).toContain(`/s/${s.body.token}`);
    const pub = await http().get(`/ops/public/share/${s.body.token}`).expect(200);
    expect(pub.body.needsPassword).toBe(true);
    expect(pub.body.downloadUrl).toBeNull();
    await http().get(`/ops/public/share/${s.body.token}/file`).expect(401);
    await http().post(`/ops/public/share/${s.body.token}/unlock`).send({ password: 'wrong' }).expect(401);
    const ok = await http().post(`/ops/public/share/${s.body.token}/unlock`).send({ password: 'sun123' }).expect(200);
    await http().get(ok.body.downloadUrl.replace(/^\/api/, '')).expect(200);
    const open = await http().post(`/ops/files/${ids.file}/shares`).set(as('admin')).send({ expiresInDays: 1 }).expect(201);
    expect((await http().get(`/ops/public/share/${open.body.token}`).expect(200)).body.downloadUrl).toBeTruthy();
    await prisma.opsShareLink.update({ where: { id: open.body.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await http().get(`/ops/public/share/${open.body.token}`).expect(410);
    await http().delete(`/ops/shares/${s.body.id}`).set(as('am')).expect(200);
    await http().get(`/ops/public/share/${s.body.token}`).expect(410);
  });

  it('archive a file (generic archive) hides it from the list', async () => {
    const r = await http().post('/ops/files').set(as('am')).field('clientOrgId', ids.sunrise).attach('file', png, { filename: `old-${stamp}.png`, contentType: 'image/png' }).expect(201);
    const fh = await http().get(`/team-flows/activity?entity=File&id=${ids.file}`).set(as('am')).expect(200);
    expect(fh.body.items.map((i: { action: string }) => i.action)).toEqual(expect.arrayContaining(['file.uploaded', 'file.released']));
    await http().post(`/actions/archive/file/${r.body.id}`).set(as('am')).send({ reason: 'Wrong upload' }).expect((x) => expect([200, 201]).toContain(x.status));
    const list = (await http().get(`/ops/files?clientOrgId=${ids.sunrise}`).set(as('am')).expect(200)).body;
    expect(list.rows.some((f: { id: string }) => f.id === r.body.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('communication', () => {
  it('start a project thread or an internal discussion (team only)', async () => {
    await http().post('/ops/threads').set(as('client')).send({}).expect(403);
    await http().post('/ops/threads').set(as('am')).send({ kind: 'internal', clientOrgId: ids.sunrise, title: 'Pricing chat', message: 'Thoughts?' }).expect(400);
    const p = await http().post('/ops/threads').set(as('am')).send({ kind: 'project', clientOrgId: ids.sunrise, title: `Launch plan ${stamp}`, message: 'Kick-off notes here', participantIds: [ids.producer] }).expect(201);
    const i = await http().post('/ops/threads').set(as('am')).send({ kind: 'internal', clientOrgId: ids.sunrise, title: `Renewal ${stamp}`, message: 'Private', participantIds: [ids.head] }).expect(201);
    expect(await prisma.notification.count({ where: { userId: ids.producer, link: `/team/discussions/${p.body.id}` } })).toBe(1);
    await http().get(`/ops/threads/${i.body.id}`).set(as('producer')).expect(404);
    const v = await http().post(`/ops/threads/${i.body.id}/messages`).set(as('head')).send({ body: 'Agree' }).expect(201);
    expect(v.body.messages).toHaveLength(2);
    const list = (await http().get('/ops/threads').set(as('am')).expect(200)).body as { id: string }[];
    expect(list.map((t) => t.id)).toEqual(expect.arrayContaining([p.body.id, i.body.id]));
  });

  it('convert a client message into a request (linked to the message)', async () => {
    const thread = (await prisma.thread.findFirst({ where: { clientOrgId: ids.sunrise, type: 'client_am' } })) ?? (await prisma.thread.create({ data: { orgId: ids.org, clientOrgId: ids.sunrise, type: 'client_am' } }));
    const msg = await prisma.message.create({ data: { orgId: ids.org, threadId: thread.id, authorId: ids.client, body: `Please change the banner colour ${stamp}` } });
    const eng = await prisma.engagement.findFirstOrThrow({ where: { clientOrgId: ids.sunrise, deletedAt: null, amId: ids.am } });
    await http().post('/ops/messages/to-request').set(as('producer')).send({ messageId: msg.id, engagementId: eng.id, type: 'change', description: 'Banner colour change' }).expect((r) => expect([403, 404]).toContain(r.status));
    const r = await http().post('/ops/messages/to-request').set(as('am')).send({ messageId: msg.id, engagementId: eng.id, type: 'change', description: 'Banner colour change' }).expect(201);
    const req = await prisma.request.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(req.sourceMessageId).toBe(msg.id);
    expect(req.createdById).toBe(ids.client);
    expect(req.slaDue).toBeTruthy();
    await http().post('/ops/messages/to-request').set(as('am')).send({ messageId: msg.id, engagementId: eng.id, type: 'change', description: 'Again' }).expect(400);
  });

  it('announcements: founder/admin only, audience and channels, in-app + email via the outbox', async () => {
    await http().post('/ops/announcements').set(as('am')).send({}).expect(403);
    await http().post('/ops/announcements').set(as('admin')).send({ title: 'Hello', body: 'Message body', audience: 'department', channels: ['in_app'] }).expect(400);
    await http().post('/ops/announcements').set(as('admin')).send({ title: 'Hello', body: 'Message body', audience: 'all_team', channels: [] }).expect(400);
    const opts = (await http().get('/ops/announcements/options').set(as('admin')).expect(200)).body;
    expect(opts.counts.all_team).toBeGreaterThan(0);
    const before = await prisma.emailOutbox.count();
    const r = await http().post('/ops/announcements').set(as('founder')).send({ title: `Office closed ${stamp}`, body: 'Closed on Friday for Diwali.', audience: 'department', segment: (await prisma.user.findUniqueOrThrow({ where: { id: ids.head } })).departmentId, channels: ['in_app', 'email'] }).expect(201);
    expect(r.body.recipientCount).toBeGreaterThan(0);
    expect(await prisma.notification.count({ where: { title: `Office closed ${stamp}` } })).toBe(r.body.recipientCount);
    expect(await prisma.emailOutbox.count()).toBeGreaterThan(before);
    expect((await http().get('/ops/announcements').set(as('admin')).expect(200)).body[0].title).toBe(`Office closed ${stamp}`);
  });
});

// ---------------------------------------------------------------------------
describe('admin configuration', () => {
  it('integrations: Founder/Admin connect and disconnect (reason required)', async () => {
    await http().get('/ops/admin/integrations').set(as('am')).expect(403);
    const list = (await http().get('/ops/admin/integrations').set(as('admin')).expect(200)).body as { key: string; connected: boolean }[];
    expect(list.map((i) => i.key)).toContain('meta_ads');
    await prisma.opsIntegration.deleteMany({ where: { orgId: ids.org, key: 'meta_ads', clientOrgId: null } });
    await http().post('/ops/admin/integrations/meta_ads/connect').set(as('finance')).expect(403);
    await http().post('/ops/admin/integrations/meta_ads/connect').set(as('admin')).expect(200);
    await http().post('/ops/admin/integrations/meta_ads/disconnect').set(as('admin')).send({}).expect(400);
    await http().post('/ops/admin/integrations/meta_ads/disconnect').set(as('admin')).send({ reason: 'Changing ad account' }).expect(200);
  });

  it("per-client ad/social accounts: the client's CM connects with client consent", async () => {
    await http().post(`/ops/admin/clients/${ids.sunrise}/accounts`).set(as('producer')).send({}).expect(403);
    await http().post(`/ops/admin/clients/${ids.sunrise}/accounts`).set(as('am')).send({ platform: 'instagram', accountName: `@sunrise${tail}`, consentBy: 'Anil Kumar' }).expect(400);
    const r = await http().post(`/ops/admin/clients/${ids.sunrise}/accounts`).set(as('am')).send({ platform: 'instagram', accountName: `@sunrise${tail}`, consentBy: 'Anil Kumar', consentConfirmed: true }).expect(201);
    const rows = (await http().get(`/ops/admin/clients/${ids.sunrise}/accounts`).set(as('am')).expect(200)).body;
    expect(rows.some((x: { id: string; consentBy: string }) => x.id === r.body.id && x.consentBy === 'Anil Kumar')).toBe(true);
    await http().post(`/ops/admin/accounts/${r.body.id}/disconnect`).set(as('am')).send({ reason: 'Client revoked' }).expect(200);
  });

  it('WhatsApp notification templates need Meta approval before they can be turned on', async () => {
    const all = (await http().get('/settings').set(as('admin')).expect(200)).body;
    const tpl = all.notificationTemplates as Record<string, { inApp: boolean; email: boolean; whatsapp: boolean; text: string; whatsappStatus?: string }>;
    const key = Object.keys(tpl)[0];
    const bad = { ...tpl, [key]: { ...tpl[key], whatsapp: true, whatsappStatus: 'pending' } };
    const r = await http().put('/admin-platform/settings/notificationTemplates').set(as('admin')).send(bad).expect(400);
    expect(r.body.message).toMatch(/Meta/);
    await http().put('/admin-platform/settings/notificationTemplates').set(as('admin')).send({ ...tpl, [key]: { ...tpl[key], whatsapp: false, whatsappStatus: 'pending' } }).expect(200);
    await http().put('/admin-platform/settings/notificationTemplates').set(as('admin')).send(tpl).expect(200);
  });

  it('holidays changed by HR recalculate SLA timers and working-day deadlines', async () => {
    const all = (await http().get('/settings').set(as('hr')).expect(200)).body;
    await http().put('/settings/holidays').set(as('hr')).send(all.holidays).expect(200);
    expect(await prisma.auditEvent.count({ where: { action: 'settings.deadlines_recalculated', actorId: ids.hr } })).toBeGreaterThan(0);
    await http().put('/settings/holidays').set(as('am')).send(all.holidays).expect(403);
  });

  it('department heads draft SOPs and templates; a Branch Manager publishes them', async () => {
    const dept = (await prisma.user.findUniqueOrThrow({ where: { id: ids.head } })).departmentId!;
    const s = await http().post('/admin-platform/sops').set(as('head')).send({ title: `Head SOP ${stamp}`, body: 'Step one, step two, step three.', departmentId: dept, status: 'published' }).expect(201);
    expect(s.body.status).toBe('draft');
    expect(s.body.notice).toMatch(/Branch Manager/);
    const req = await prisma.approvalRequest.findFirstOrThrow({ where: { action: 'sop.publish', targetId: s.body.id, status: 'pending' } });
    await decide('admin', req.id);
    expect((await prisma.sOP.findUniqueOrThrow({ where: { id: s.body.id } })).status).toBe('published');
    const qc = (await http().get('/templates/qc').set(as('head')).expect(200)).body as { key: string; name: string; version: number; items: string[] }[];
    if (qc.length) {
      const t = qc[0];
      await http().put(`/templates/qc/${t.key}`).set(as('head')).send({ name: t.name, items: [...t.items, `Check ${stamp}`] }).expect(200);
      const pending = await prisma.approvalRequest.findFirstOrThrow({ where: { action: 'template.qc_publish', status: 'pending' }, orderBy: { createdAt: 'desc' } });
      expect((await http().get('/templates/qc').set(as('head')).expect(200)).body.find((x: { key: string }) => x.key === t.key).version).toBe(t.version);
      await decide('admin', pending.id);
      expect((await http().get('/templates/qc').set(as('head')).expect(200)).body.find((x: { key: string }) => x.key === t.key).version).toBe(t.version + 1);
    }
  });
});
