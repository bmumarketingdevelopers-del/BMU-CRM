// v10 sell flows: duplicate enquiries, lead activity + follow-ups, multi-step discount approval,
// proposal negotiation (change requests, versions, expiry), e-sign with designation, payment plan,
// onboarding notifications and retainer renewals.
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { SellService } from '../src/sell/sell.service.js';

let app: INestApplication;
let prisma: PrismaService;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const stamp = Date.now();
const email = `sell.${stamp}@example.com`;
const phone = `97${String(stamp).slice(-8)}`;
const DAY = 86_400_000;
let leadId: string;
const cleanup = { clientOrgIds: [] as string[] };

async function signIn(identifier: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier, code: otp.body.devCode }).expect(200)).body.token as string;
}
const lines = [
  { serviceKey: 'smm', tier: 'growth' },
  { serviceKey: 'website', tier: 'starter' },
];
const notices = (userId: string, kind: string) => prisma.notification.findMany({ where: { userId, kind }, orderBy: { createdAt: 'desc' } });

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  prisma = app.get(PrismaService);
  for (const who of ['founder', 'admin', 'sales.manager', 'sales', 'am', 'client@sunrise']) {
    tokens[who] = await signIn(who.includes('@') ? `${who.split('@')[0]}@${who.split('@')[1]}.demo` : `${who}@bmu.demo`);
    ids[who] = (await http().get('/auth/me').set(as(who)).expect(200)).body.id;
  }
  await http().post('/leads/enquiry').send({ name: 'Meera Rao', email, phone, company: `Sell Co ${stamp}`, need: 'Instagram and a website', serviceIds: ['smm', 'website'], budgetRupees: 60000 }).expect(201);
  leadId = (await prisma.lead.findFirstOrThrow({ where: { contact: { path: ['email'], equals: email }, deletedAt: null }, orderBy: { createdAt: 'asc' } })).id;
  await http().patch(`/leads/${leadId}`).set(as('sales.manager')).send({ ownerId: ids.sales }).expect(200);
});

afterAll(async () => {
  await app.close();
});

describe('lead detail, activity and follow-ups', () => {
  it('the new owner was notified and the lead detail explains the score', async () => {
    expect((await notices(ids.sales, 'lead_assigned')).some((n) => n.link === `/team/leads/${leadId}`)).toBe(true);
    const d = (await http().get(`/sell/leads/${leadId}`).set(as('sales')).expect(200)).body;
    expect(d.lead.owner.id).toBe(ids.sales);
    expect(d.score.parts).toHaveLength(3);
    expect(d.score.parts.reduce((s: number, p: { points: number }) => s + p.points, 0)).toBe(d.score.score);
    expect(d.timeline.some((t: { kind: string }) => t.kind === 'enquiry')).toBe(true);
  });

  it('logging a call moves a new lead to Contacted and sets the follow-up', async () => {
    // Later today in IST (never past midnight IST, or the reminder test below would see tomorrow's date).
    const istMidnight = Math.ceil((Date.now() + 19_800_000) / 86_400_000) * 86_400_000 - 19_800_000;
    const next = new Date(Math.min(Date.now() + 2 * 3_600_000, istMidnight - 60_000)).toISOString();
    const d = (await http().post(`/sell/leads/${leadId}/activities`).set(as('sales')).send({ kind: 'call', outcome: 'interested', body: 'Spoke to Meera, wants pricing for SMM + site', nextFollowUpAt: next }).expect(201)).body;
    expect(d.lead.stage).toBe('contacted');
    expect(d.nextFollowUpAt).toBe(next);
    expect(d.timeline[0].title).toContain('Call');
    await http().post(`/sell/leads/${leadId}/activities`).set(as('sales')).send({ kind: 'call', body: 'x' }).expect(400);
    await http().post(`/sell/leads/${leadId}/activities`).set(as('am')).send({ kind: 'note', body: 'not my lead' }).expect(403);
  });

  it('the follow-up reminder is sent once, on the day', async () => {
    const sell = app.get(SellService);
    await sell.sendFollowUpReminders();
    await sell.sendFollowUpReminders();
    const n = (await notices(ids.sales, 'lead_follow_up')).filter((x) => x.link === `/team/leads/${leadId}`);
    expect(n).toHaveLength(1);
    const list = (await http().get('/sell/follow-ups').set(as('sales')).expect(200)).body;
    expect(list.some((f: { leadId: string }) => f.leadId === leadId)).toBe(true);
  });
});

describe('duplicate enquiries', () => {
  let dupId: string;
  it('a second enquiry with the same phone is linked to the first lead and stays with its owner', async () => {
    const res = await http().post('/leads/enquiry').send({ name: 'Meera R', email: `other.${stamp}@example.com`, phone: `+91${phone}`, need: 'Also need SEO', serviceIds: ['seo'] }).expect(201);
    dupId = res.body.id;
    const dup = (await http().get(`/sell/leads/${dupId}`).set(as('sales.manager')).expect(200)).body;
    expect(dup.duplicateOf.id).toBe(leadId);
    expect(dup.lead.owner?.id).toBe(ids.sales);
    const original = (await http().get(`/sell/leads/${leadId}`).set(as('sales')).expect(200)).body;
    expect(original.duplicates.map((x: { id: string }) => x.id)).toContain(dupId);
    expect(original.timeline.some((t: { body: string }) => t.body?.includes('Repeat enquiry'))).toBe(true);
  });

  it('merging moves the enquiry into the original lead', async () => {
    const res = (await http().post(`/sell/leads/${dupId}/merge`).set(as('sales')).expect(200)).body;
    expect(res.mergedInto).toBe(leadId);
    await http().get(`/sell/leads/${dupId}`).set(as('sales')).expect(404);
    const original = (await http().get(`/sell/leads/${leadId}`).set(as('sales')).expect(200)).body;
    expect(original.lead.serviceIds).toContain('seo');
  });

  it('keep separate clears the duplicate flag', async () => {
    const res = await http().post('/leads/enquiry').send({ name: 'Meera Again', email, phone: '9000000001', need: 'Logo too' }).expect(201);
    const d = (await http().post(`/sell/leads/${res.body.id}/keep-separate`).set(as('sales.manager')).expect(200)).body;
    expect(d.duplicateOf).toBeNull();
  });
});

describe('multi-step discount approval', () => {
  it('a sales executive asking 25% needs the sales manager, then the Founder', async () => {
    const p = (await http().post('/proposals').set(as('sales')).send({ leadId, lines, extraDiscountPct: 25 }).expect(201)).body;
    expect(p.approvalSteps.map((s: { level: string; status: string }) => `${s.level}:${s.status}`)).toEqual(['manager:pending', 'founder:waiting']);
    expect((await notices(ids['sales.manager'], 'discount_approval')).length).toBeGreaterThan(0);
    const inbox = (await http().get('/sell/approvals').set(as('sales.manager')).expect(200)).body;
    const item = inbox.pending.find((i: { proposalId: string }) => i.proposalId === p.id);
    expect(item.canDecide).toBe(true);
    // The Founder can't skip ahead: their step is still waiting.
    const founderInbox = (await http().get('/sell/approvals').set(as('founder')).expect(200)).body;
    expect(founderInbox.pending.some((i: { proposalId: string; level: string }) => i.proposalId === p.id && i.level === 'founder')).toBe(false);
    await http().post(`/sell/approvals/${item.stepId}/approve`).set(as('sales')).send({}).expect(403);
    await http().post(`/sell/approvals/${item.stepId}/approve`).set(as('sales.manager')).send({ note: 'Strategic account' }).expect(200);
    await http().post(`/proposals/${p.id}/send`).set(as('sales')).expect(400);
    const step2 = (await http().get('/sell/approvals').set(as('founder')).expect(200)).body.pending.find((i: { proposalId: string }) => i.proposalId === p.id);
    expect(step2.level).toBe('founder');
    await http().post(`/sell/approvals/${step2.stepId}/approve`).set(as('sales.manager')).send({}).expect(403);
    await http().post(`/sell/approvals/${step2.stepId}/approve`).set(as('founder')).send({}).expect(200);
    const done = (await http().get(`/proposals/${p.id}`).set(as('sales')).expect(200)).body;
    expect(done.discountStatus).toBe('approved');
    expect((await notices(ids.sales, 'discount_approved')).some((n) => n.link === `/team/proposals/${p.id}`)).toBe(true);
    ids.approvedProposal = p.id;
  });

  it('a rejection needs a reason, notifies sales and blocks sending', async () => {
    const p = (await http().post('/proposals').set(as('sales')).send({ leadId, lines, extraDiscountPct: 8 }).expect(201)).body;
    expect(p.approvalSteps.map((s: { level: string }) => s.level)).toEqual(['manager']);
    const stepId = p.approvalSteps[0].id;
    await http().post(`/sell/approvals/${stepId}/reject`).set(as('sales.manager')).send({}).expect(400);
    await http().post(`/sell/approvals/${stepId}/reject`).set(as('sales.manager')).send({ note: 'Too generous for a starter site' }).expect(200);
    const res = await http().post(`/proposals/${p.id}/send`).set(as('sales')).expect(400);
    expect(res.body.message).toContain('rejected');
    expect((await notices(ids.sales, 'discount_rejected')).some((n) => n.body?.includes('Too generous'))).toBe(true);
  });

  it('a sales manager within the admin limit needs an admin or the Founder, never themselves', async () => {
    const p = (await http().post('/proposals').set(as('sales.manager')).send({ leadId, lines, extraDiscountPct: 15 }).expect(201)).body;
    expect(p.approvalSteps.map((s: { level: string }) => s.level)).toEqual(['manager']);
    await http().post(`/sell/approvals/${p.approvalSteps[0].id}/approve`).set(as('sales.manager')).send({}).expect(403);
    await http().post(`/sell/approvals/${p.approvalSteps[0].id}/approve`).set(as('admin')).send({}).expect(200);
  });
});

describe('negotiation: change requests, versions, expiry', () => {
  let v1: { id: string; publicToken: string };
  let v2: { id: string; publicToken: string; firstPayment: { totalPaise: number; netPaise: number } };

  it('the payment plan is visible before acceptance', async () => {
    await http().post(`/proposals/${ids.approvedProposal}/send`).set(as('sales')).expect(200);
    v1 = (await http().get(`/proposals/${ids.approvedProposal}`).set(as('sales')).expect(200)).body;
    const pub = (await http().get(`/public/proposals/${v1.publicToken}`).expect(200)).body.proposal;
    expect(pub.paymentPlan.now.netPaise).toBe(pub.firstPayment.netPaise);
    const site = pub.lines.find((l: { key: string }) => l.key === 'website');
    const smm = pub.lines.find((l: { key: string }) => l.key === 'smm');
    expect(pub.firstPayment.netPaise).toBe(smm.netPaise + Math.round(site.netPaise / 2));
    expect(pub.paymentPlan.later.map((x: { label: string }) => x.label)).toEqual(['Project balance (50%)', 'Monthly retainer']);
    expect(pub.approvalSteps).toBeUndefined();
    expect(pub.owner).toBeUndefined();
  });

  it('views are counted (the team preview is not) and the first view notifies sales', async () => {
    await http().get(`/public/proposals/${v1.publicToken}`).expect(200);
    await http().get(`/public/proposals/${v1.publicToken}?preview=1`).expect(200);
    const p = (await http().get(`/proposals/${v1.id}`).set(as('sales')).expect(200)).body;
    expect(p.viewCount).toBe(2);
    expect((await notices(ids.sales, 'proposal_viewed')).some((n) => n.link === `/team/proposals/${v1.id}`)).toBe(true);
  });

  it('the client asks for changes and sales is notified', async () => {
    await http().post(`/public/proposals/${v1.publicToken}/request-changes`).send({ name: 'Meera', comment: 'x' }).expect(400);
    const res = (await http().post(`/public/proposals/${v1.publicToken}/request-changes`).send({ name: 'Meera', comment: 'Can we do the premium SMM tier and drop the website?' }).expect(200)).body;
    expect(res.proposal.changeRequests).toHaveLength(1);
    expect((await notices(ids.sales, 'proposal_changes_requested')).length).toBeGreaterThan(0);
  });

  it('a revision is v2; v1 stays live until v2 is sent, then shows superseded with a link to the latest', async () => {
    v2 = (await http().post(`/sell/proposals/${v1.id}/revise`).set(as('sales')).send({ lines: [{ serviceKey: 'smm', tier: 'premium' }], changeNote: 'Premium SMM, no website' }).expect(201)).body;
    expect((v2 as unknown as { version: number }).version).toBe(Math.max(...[(v1 as unknown as { version: number }).version]) + 1);
    expect((await http().get(`/public/proposals/${v1.publicToken}`).expect(200)).body.proposal.status).toBe('sent');
    await http().post(`/proposals/${v2.id}/send`).set(as('sales')).expect(200);
    const old = (await http().get(`/public/proposals/${v1.publicToken}`).expect(200)).body.proposal;
    expect(old.status).toBe('superseded');
    expect(old.latestToken).toBe(v2.publicToken);
    await http().post(`/public/proposals/${v1.publicToken}/accept`).send({ signerName: 'Meera Rao', signerEmail: email, agree: true }).expect(400);
    const team = (await http().get(`/proposals/${v2.id}`).set(as('sales')).expect(200)).body;
    expect(team.versions.map((v: { status: string }) => v.status)).toContain('superseded');
    expect(team.changeRequests[0].resolvedAt).toBeTruthy();
    const list = (await http().get('/proposals').set(as('sales')).expect(200)).body;
    expect(list.some((p: { id: string }) => p.id === v1.id)).toBe(false);
  });

  it('a proposal past its date expires and can be extended', async () => {
    await prisma.proposal.update({ where: { id: v2.id }, data: { validUntil: new Date(Date.now() - DAY) } });
    expect((await http().get(`/public/proposals/${v2.publicToken}?preview=1`).expect(200)).body.proposal.status).toBe('expired');
    await http().post(`/public/proposals/${v2.publicToken}/accept`).send({ signerName: 'Meera Rao', signerEmail: email, agree: true }).expect(400);
    await http().post(`/sell/proposals/${v2.id}/extend`).set(as('am')).send({ days: 7 }).expect(403);
    const ext = (await http().post(`/sell/proposals/${v2.id}/extend`).set(as('sales')).send({ days: 7 }).expect(200)).body;
    expect(ext.status).toBe('sent');
    expect(new Date(ext.validUntil).getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
  });

  it('accepting records name, designation, IP and time; the agreement page has them', async () => {
    const res = (await http().post(`/public/proposals/${v2.publicToken}/accept`).set('User-Agent', 'e2e').send({ signerName: 'Meera Rao', signerEmail: email, signerDesignation: 'Founder', agree: true }).expect(200)).body;
    expect(res.proposal.status).toBe('accepted');
    expect(res.proposal.signer.designation).toBe('Founder');
    expect(res.proposal.signer.ip).toBeUndefined();
    const a = (await http().get(`/public/proposals/${v2.publicToken}/agreement`).expect(200)).body;
    expect(a.signed).toBe(true);
    expect(a.proposal.signer.ip).toBeTruthy();
    expect(a.proposal.signer.name).toBe('Meera Rao');
    const team = (await http().get(`/proposals/${v2.id}`).set(as('sales')).expect(200)).body;
    expect(team.signer.at).toBeTruthy();
    // The first invoice follows the plan: retainer month in advance (no project lines here).
    expect(team.invoice.totalPaise).toBe(team.firstPayment.totalPaise);
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: team.invoice.id } });
    expect((inv.lines as { note: string }[])[0].note).toBe('First month, in advance');
    expect((await notices(ids.sales, 'proposal_accepted')).length).toBeGreaterThan(0);
  });

  it('paying creates the client, welcomes them, tells the CM and marks the lead won', async () => {
    await http().post(`/public/proposals/${v2.publicToken}/pay-test`).expect(200);
    const client = await prisma.clientOrg.findUniqueOrThrow({ where: { leadId } });
    cleanup.clientOrgIds.push(client.id);
    const owner = await prisma.user.findFirstOrThrow({ where: { email } });
    expect((await notices(owner.id, 'welcome')).length).toBe(1);
    expect((await prisma.notification.count({ where: { userId: client.amUserId!, kind: 'client_assigned', link: `/team/clients/${client.id}` } }))).toBe(1);
    expect(await prisma.auditEvent.count({ where: { entityId: leadId, action: 'lead.won' } })).toBe(1);
    tokens.client = await signIn(email);
    const me = (await http().get('/auth/me').set(as('client')).expect(200)).body;
    expect(me.type).toBe('client');
    const overview = (await http().get('/client/overview').set(as('client')).expect(200)).body;
    expect(overview.engagements).toHaveLength(1);
    await http().get(`/sell/leads/${leadId}`).set(as('client')).expect(403);
  });
});

describe('renewals', () => {
  let clientOrgId: string;
  let engagementId: string;
  beforeAll(async () => {
    const org = await prisma.organisation.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
    const smm = await prisma.service.findFirstOrThrow({ where: { key: 'smm', priceBook: { orgId: org.id, status: 'active' } } });
    const client = await prisma.clientOrg.findUniqueOrThrow({ where: { leadId } });
    clientOrgId = client.id;
    // Pretend the retainer started six months ago.
    const e = await prisma.engagement.findFirstOrThrow({ where: { clientOrgId, serviceId: smm.id } });
    engagementId = e.id;
    const start = new Date();
    start.setMonth(start.getMonth() - 6);
    start.setDate(start.getDate() + 5);
    await prisma.engagement.update({ where: { id: e.id }, data: { startDate: start, status: 'active_retainer' } });
  });

  it('a retainer reaching six months shows up; sales executives cannot see the list', async () => {
    await http().get('/sell/renewals').set(as('sales')).expect(403);
    const list = (await http().get('/sell/renewals').set(as('sales.manager')).expect(200)).body;
    const row = list.find((r: { engagementId: string }) => r.engagementId === engagementId);
    expect(row.reason).toContain('6-month review');
    expect(row.openProposal).toBeNull();
  });

  it('one click drafts a renewal proposal from the current services; accepting extends the retainer', async () => {
    const p = (await http().post('/sell/renewals').set(as('sales.manager')).send({ clientOrgId, engagementIds: [engagementId] }).expect(201)).body;
    expect(p.kind).toBe('renewal');
    expect(p.lines.map((l: { key: string; tier: string }) => `${l.key}:${l.tier}`)).toEqual(['smm:premium']);
    await http().post('/sell/renewals').set(as('sales.manager')).send({ clientOrgId, engagementIds: [engagementId] }).expect(400);
    const listed = (await http().get('/sell/renewals').set(as('sales.manager')).expect(200)).body.find((r: { engagementId: string }) => r.engagementId === engagementId);
    expect(listed.openProposal.id).toBe(p.id);
    // Upsell: a new version adds Google Business Profile.
    const v2 = (await http().post(`/sell/proposals/${p.id}/revise`).set(as('sales.manager')).send({ lines: [{ serviceKey: 'smm', tier: 'premium' }, { serviceKey: 'gbp', tier: 'growth' }], changeNote: 'Add GBP' }).expect(201)).body;
    await http().post(`/proposals/${v2.id}/send`).set(as('sales.manager')).expect(200);
    await http().post(`/public/proposals/${v2.publicToken}/accept`).send({ signerName: 'Meera Rao', signerEmail: email, signerDesignation: 'Founder', agree: true }).expect(200);
    await http().post(`/public/proposals/${v2.publicToken}/pay-test`).expect(200);
    const clients = await prisma.clientOrg.count({ where: { name: { startsWith: `Sell Co ${stamp}` } } });
    expect(clients).toBe(1);
    const e = await prisma.engagement.findUniqueOrThrow({ where: { id: engagementId } });
    expect(e.renewalCount).toBe(1);
    expect(e.endDate!.getTime()).toBeGreaterThan(Date.now() + 360 * DAY);
    const all = await prisma.engagement.findMany({ where: { clientOrgId }, include: { service: true } });
    expect(all.map((x) => x.service.key).sort()).toEqual(['gbp', 'smm']);
    const after = (await http().get('/sell/renewals').set(as('sales.manager')).expect(200)).body;
    expect(after.some((r: { engagementId: string }) => r.engagementId === engagementId)).toBe(false);
  });
});
