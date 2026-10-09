// v9 flows: business flow map, journey timelines (ordering + client safety), gate strip and founder pulse.
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { FlowJourney, FlowMap } from '@bmu/shared';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

let app: INestApplication;
let prisma: PrismaService;
const tokens: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY);
let clientId: string;
let lateId: string;
let reviewId: string;
let journeyId: string;
let proposalId: string;
const engagementIds: string[] = [];

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

  const stamp = Date.now();
  const org = await prisma.organisation.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  const am = await prisma.user.findFirstOrThrow({ where: { email: 'am@bmu.demo' } });
  const producer = await prisma.user.findFirstOrThrow({ where: { email: 'producer@bmu.demo' } });
  const role = (baseRole: string) => prisma.role.findFirstOrThrow({ where: { orgId: org.id, baseRole, isCustom: false } });
  const service = await prisma.service.findFirstOrThrow({ where: { key: 'complete_branding', priceBook: { orgId: org.id, status: 'active' } } });
  const book = await prisma.priceBook.findFirstOrThrow({ where: { orgId: org.id, status: 'active' } });

  const client = await prisma.clientOrg.create({ data: { orgId: org.id, name: `Flow Test ${stamp}`, amUserId: am.id } });
  clientId = client.id;
  const owner = await prisma.user.create({
    data: { orgId: org.id, type: 'client', name: 'Flow owner', email: `flow.owner.${stamp}@example.com`, status: 'active', roles: { create: { roleId: (await role('client_owner')).id } } },
  });
  await prisma.clientUser.create({ data: { userId: owner.id, orgId: org.id, clientOrgId: client.id, clientRole: 'client_owner', brandScope: [] } });
  tokens.owner = await signIn(owner.email!);
  const base = { orgId: org.id, clientOrgId: client.id, serviceId: service.id, tier: 'growth' as const, billingType: 'one_time' as const, amId: am.id };

  // G2, past its plan deadline.
  const late = await prisma.engagement.create({
    data: { ...base, status: 'planning', currentGate: 'G2', startDate: ago(15), cycles: { create: { orgId: org.id, period: 'project', rcdAt: ago(10), planningDue: ago(3), status: 'planning' } } },
  });
  lateId = late.id;
  await prisma.approval.create({ data: { orgId: org.id, targetType: 'engagement', targetId: late.id, gate: 'G1', userId: am.id, at: ago(10) } });

  // G4, a draft with the client.
  const review = await prisma.engagement.create({ data: { ...base, status: 'in_review', currentGate: 'G4', startDate: ago(30) } });
  reviewId = review.id;

  // A rich journey: requirements, G1, plan approved (G2), version uploaded + QC (internal), sent and approved.
  const j = await prisma.engagement.create({
    data: { ...base, status: 'in_review', currentGate: 'G4', startDate: ago(40), cycles: { create: { orgId: org.id, period: 'project', rcdAt: ago(35), planningDue: ago(30), status: 'production' } } },
    include: { cycles: true },
  });
  journeyId = j.id;
  const cycle = j.cycles[0];
  const req = await prisma.requirementItem.create({ data: { orgId: org.id, cycleId: cycle.id, label: 'Brand questionnaire', type: 'info', status: 'received', dateRequested: ago(40) } });
  await prisma.auditEvent.create({ data: { orgId: org.id, action: 'requirement.received', entity: 'RequirementItem', entityId: req.id, at: ago(37) } });
  await prisma.approval.create({ data: { orgId: org.id, targetType: 'engagement', targetId: j.id, gate: 'G1', userId: am.id, at: ago(35) } });
  const plan = await prisma.plan.create({ data: { orgId: org.id, cycleId: cycle.id, content: {}, status: 'approved', approvedById: owner.id, approvedAt: ago(31) } });
  await prisma.approval.create({ data: { orgId: org.id, targetType: 'plan', targetId: plan.id, gate: 'G2', userId: owner.id, at: ago(31) } });
  await prisma.auditEvent.create({ data: { orgId: org.id, action: 'gate.G3.passed', entity: 'Engagement', entityId: j.id, at: ago(31) } });
  const d1 = await prisma.deliverable.create({ data: { orgId: org.id, cycleId: cycle.id, type: 'post', title: 'Logo', status: 'approved', dueAt: ago(5) } });
  const d2 = await prisma.deliverable.create({ data: { orgId: org.id, cycleId: cycle.id, type: 'post', title: 'Guidelines', status: 'ready_for_client', dueAt: new Date(Date.now() + 3 * DAY) } });
  const file = await prisma.file.create({ data: { orgId: org.id, clientOrgId: client.id, path: 'missing/flow.png', kind: 'image', name: 'flow.png' } });
  const v1 = await prisma.version.create({ data: { orgId: org.id, deliverableId: d1.id, fileId: file.id, number: 1, uploadedById: producer.id, sentToClientAt: ago(20), createdAt: ago(21) } });
  const checklist = await prisma.checklistTemplate.findFirstOrThrow({ where: { orgId: org.id, kind: 'qc' } });
  const qc = await prisma.user.findFirstOrThrow({ where: { email: 'qc@bmu.demo' } });
  await prisma.qCResult.create({ data: { orgId: org.id, versionId: v1.id, checklistId: checklist.id, items: [], result: 'pass', reviewerId: qc.id, createdAt: ago(20.5) } });
  await prisma.approval.create({ data: { orgId: org.id, targetType: 'deliverable', targetId: d1.id, gate: 'G4', userId: owner.id, at: ago(18), versionId: v1.id } });
  await prisma.version.create({ data: { orgId: org.id, deliverableId: d2.id, fileId: file.id, number: 1, uploadedById: producer.id, sentToClientAt: ago(2), createdAt: ago(3) } });
  engagementIds.push(lateId, reviewId, journeyId);

  // A proposal sent 12 days ago.
  const lead = await prisma.lead.create({ data: { orgId: org.id, source: 'e2e', contact: { name: 'Flow lead', company: `Flow Lead ${stamp}` }, need: 'Branding', stage: 'proposal_sent', createdAt: ago(15) } });
  proposalId = (
    await prisma.proposal.create({
      data: { orgId: org.id, leadId: lead.id, priceBookId: book.id, lines: [], subtotalPaise: 100000, gstPaise: 18000, totalPaise: 118000, validUntil: new Date(Date.now() + 3 * DAY), status: 'sent', sentAt: ago(12) },
    })
  ).id;

  for (const who of ['founder', 'admin', 'am', 'producer']) tokens[who] = await signIn(`${who}@bmu.demo`);
  tokens.sunrise = await signIn('client@sunrise.demo');
});

afterAll(async () => {
  // Keep the demo flow map clean: retire the test records.
  await prisma.engagement.updateMany({ where: { id: { in: engagementIds } }, data: { deletedAt: new Date() } });
  await prisma.proposal.updateMany({ where: { id: proposalId }, data: { deletedAt: new Date() } });
  await prisma.clientOrg.update({ where: { id: clientId }, data: { deletedAt: new Date() } });
  await app.close();
});

describe('business flow map', () => {
  it('places test items in the right stages with consistent counts', async () => {
    const res = await http().get('/flows/map').set(as('founder')).expect(200);
    const map = res.body as FlowMap;
    expect(map.nodes.map((n) => n.key)).toEqual(['leads', 'proposals', 'won', 'g1', 'g2', 'g3', 'g4', 'g5', 'retainer', 'offboarding']);
    for (const n of map.nodes) {
      expect(n.count).toBe(n.items.length);
      expect(n.stuckCount).toBe(n.items.filter((i) => i.severity !== 'ok').length);
    }
    const node = (k: string) => map.nodes.find((n) => n.key === k)!;
    const late = node('g2').items.find((i) => i.id === lateId)!;
    expect(late.severity).toBe('red');
    expect(late.reason).toMatch(/Past deadline by 3 days/);
    expect(late.href).toBe(`/team/projects/${lateId}`);
    expect(node('g2').severity).toBe('red');
    expect(node('g4').items.map((i) => i.id)).toEqual(expect.arrayContaining([reviewId, journeyId]));
    const proposal = node('proposals').items.find((i) => i.id === proposalId)!;
    expect(Math.round(proposal.days)).toBe(12);
    expect(proposal.valuePaise).toBe(100000);
    expect(map.health.inFlow).toBe(map.nodes.filter((n) => n.key !== 'retainer').reduce((s, n) => s + n.count, 0));
    expect(map.health.stuck).toBe(map.nodes.reduce((s, n) => s + n.stuckCount, 0));
    expect(map.edges).toHaveLength(9);
  });

  it('counts the gate passes of the period on the connectors', async () => {
    const all = (await http().get('/flows/map').set(as('founder')).expect(200)).body as FlowMap;
    // A window that only covers the test engagement's G1 (35 days ago).
    const day = (d: number) => new Date(Date.now() - d * DAY + 330 * 60_000).toISOString().slice(0, 10);
    const narrow = (await http().get(`/flows/map?from=${day(36)}&to=${day(34)}`).set(as('founder')).expect(200)).body as FlowMap;
    expect(narrow.from).toBe(day(36));
    const g1 = narrow.edges.find((e) => e.from === 'g1')!;
    expect(g1.throughput).toBeGreaterThanOrEqual(1);
    expect(all.edges.find((e) => e.from === 'g1')!.throughput).toBeGreaterThanOrEqual(g1.throughput);
    await http().get('/flows/map?from=2026-13-01').set(as('founder')).expect(400);
  });

  it('is for leadership only', async () => {
    await http().get('/flows/map').set(as('admin')).expect(200);
    await http().get('/flows/map').set(as('producer')).expect(403);
    await http().get('/flows/map').set(as('am')).expect(403);
    await http().get('/flows/map').set(as('owner')).expect(403);
  });

  it('gives the projects board a gate strip over visible engagements', async () => {
    const res = await http().get('/flows/gate-strip').set(as('am')).expect(200);
    expect(res.body.map((g: { gate: string }) => g.gate)).toEqual(['G1', 'G2', 'G3', 'G4', 'G5']);
    expect(res.body.find((g: { gate: string }) => g.gate === 'G2').count).toBeGreaterThanOrEqual(1);
  });
});

describe('journey timeline', () => {
  it('orders events and marks gates done, current and upcoming for staff', async () => {
    const j = (await http().get(`/flows/engagements/${journeyId}/journey`).set(as('am')).expect(200)).body as FlowJourney;
    const dated = j.events.filter((e) => e.at).map((e) => Date.parse(e.at!));
    expect(dated).toEqual([...dated].sort((a, b) => a - b));
    const kinds = j.events.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['started', 'requirement', 'gate', 'version_uploaded', 'qc', 'version_sent', 'version_approved']));
    const gates = j.events.filter((e) => e.gate);
    expect(gates.map((g) => g.gate)).toEqual(['G1', 'G2', 'G3', 'G4', 'G5']);
    expect(gates.map((g) => g.state)).toEqual(['done', 'done', 'done', 'current', 'upcoming']);
    // Requirement received before G1, G1 before plan approval.
    expect(kinds.indexOf('requirement')).toBeLessThan(j.events.findIndex((e) => e.gate === 'G1'));
    // Plan approved a day after the plan deadline's 4 days: planned 30 days ago, approved 31 → early.
    expect(gates[1].timing).toBe('early');
    expect(j.gates[1].daysFromPrevious).toBe(4);
    expect(j.events.some((e) => e.internal)).toBe(true);
  });

  it('shows client users only client-safe events of their own engagements', async () => {
    const j = (await http().get(`/flows/engagements/${journeyId}/journey`).set(as('owner')).expect(200)).body as FlowJourney;
    expect(j.events.some((e) => e.internal)).toBe(false);
    expect(j.events.map((e) => e.kind)).not.toContain('qc');
    expect(j.events.map((e) => e.kind)).not.toContain('version_uploaded');
    const options = (await http().get('/flows/journeys').set(as('owner')).expect(200)).body as { id: string }[];
    expect(options.map((o) => o.id).sort()).toEqual([...engagementIds].sort());
    // Another client's user cannot see this engagement, and this client cannot pick a client id.
    await http().get(`/flows/engagements/${journeyId}/journey`).set(as('sunrise')).expect(404);
    const sunrise = (await http().get(`/flows/journeys?clientId=${clientId}`).set(as('sunrise')).expect(200)).body as { id: string }[];
    expect(sunrise.map((o) => o.id)).not.toContain(journeyId);
  });

  it('hides engagements a staff member cannot see', async () => {
    await http().get(`/flows/engagements/${journeyId}/journey`).set(as('founder')).expect(200);
    await http().get('/flows/engagements/does-not-exist/journey').set(as('founder')).expect(404);
  });
});

describe('founder pulse', () => {
  it('is for the founder and admins only', async () => {
    const res = await http().get('/flows/pulse').set(as('founder')).expect(200);
    expect(res.body.stages).toHaveLength(10);
    expect(res.body.stuckItems).toBeGreaterThanOrEqual(1);
    expect(typeof res.body.revenueMonthPaise).toBe('number');
    await http().get('/flows/pulse').set(as('admin')).expect(200);
    await http().get('/flows/pulse').set(as('producer')).expect(403);
    await http().get('/flows/pulse').set(as('owner')).expect(403);
  });
});
