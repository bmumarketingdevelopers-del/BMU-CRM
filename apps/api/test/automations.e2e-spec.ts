// Automations: rule CRUD and permissions, the sweep engine (invoice_overdue, lead_created) with dedupe,
// conditions, dry runs that change nothing, and webhook address safety.
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { isPrivateIp, webhookUrlProblem } from '../src/automations/url-guard.js';

let app: INestApplication;
let prisma: PrismaService;
const tokens: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const stamp = Date.now();
const DAY = 86_400_000;
let orgId: string;
let clientId: string;
let clientName: string;
let amId: string;
const ruleIds: string[] = [];

async function signIn(email: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier: email }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier: email, code: otp.body.devCode }).expect(200)).body.token as string;
}

const invoice = (n: string, totalPaise: number, dueDaysAgo: number) =>
  prisma.invoice.create({
    data: { orgId, clientOrgId: clientId, number: `AUTO/${stamp}/${n}`, lines: [], subtotalPaise: Math.round(totalPaise / 1.18), gstPaise: totalPaise - Math.round(totalPaise / 1.18), totalPaise, dueDate: new Date(Date.now() - dueDaysAgo * DAY), status: 'issued' },
  });

async function createRule(body: Record<string, unknown>) {
  const r = await http().post('/automations').set(as('founder')).send(body).expect(201);
  ruleIds.push(r.body.id);
  return r.body as { id: string; sentence: string; enabled: boolean };
}

const runsFor = (ruleId: string) => prisma.automationRun.findMany({ where: { ruleId } });

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  prisma = app.get(PrismaService);

  const org = await prisma.organisation.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  orgId = org.id;
  amId = (await prisma.user.findFirstOrThrow({ where: { email: 'am@bmu.demo' } })).id;
  clientName = `Automation Test ${stamp}`;
  const client = await prisma.clientOrg.create({ data: { orgId, name: clientName, amUserId: amId } });
  clientId = client.id;
  const ownerRole = await prisma.role.findFirstOrThrow({ where: { orgId, baseRole: 'client_owner', isCustom: false } });
  const owner = await prisma.user.create({ data: { orgId, type: 'client', name: 'Auto Owner', email: `auto.owner.${stamp}@example.com`, status: 'active', roles: { create: { roleId: ownerRole.id } } } });
  await prisma.clientUser.create({ data: { userId: owner.id, orgId, clientOrgId: clientId, clientRole: 'client_owner', brandScope: [] } });

  tokens.founder = await signIn('founder@bmu.demo');
  tokens.amLead = await signIn('am.lead@bmu.demo');
  tokens.producer = await signIn('producer@bmu.demo');
  tokens.finance = await signIn('finance@bmu.demo');
});

afterAll(async () => {
  if (prisma) {
    await prisma.automationRule.updateMany({ where: { id: { in: ruleIds } }, data: { deletedAt: new Date(), enabled: false } });
    await prisma.task.deleteMany({ where: { title: { contains: `E2E${stamp}` } } });
    // Leave nothing overdue behind for the dev engine to act on.
    await prisma.invoice.updateMany({ where: { number: { startsWith: `AUTO/${stamp}/` } }, data: { status: 'void' } });
  }
  await app?.close();
});

const overdueRule = (days: number, extra: Record<string, unknown> = {}) => ({
  name: `E2E overdue ${days}d ${stamp}`,
  trigger: 'invoice_overdue',
  triggerArgs: { days },
  conditions: [{ field: 'client', op: 'equals', value: clientName }],
  actions: [
    { type: 'notify', to: 'am', message: 'E2E{{invoice}} is {{days}} days late ({{balance}})' },
    { type: 'send_client_reminder', message: 'A gentle reminder that invoice {{invoice}} for {{balance}} was due on {{due}}.' },
  ],
  ...extra,
});

describe('permissions', () => {
  it('keeps producers out entirely', async () => {
    await http().get('/automations/overview').set(as('producer')).expect(403);
    await http().get('/automations/runs').set(as('producer')).expect(403);
    await http().post('/automations').set(as('producer')).send(overdueRule(3)).expect(403);
    await http().post('/automations/run-now').set(as('producer')).send({}).expect(403);
  });

  it('lets the CM Lead and Finance read but not change rules', async () => {
    const rule = await createRule(overdueRule(3, { enabled: false }));
    const ov = await http().get('/automations/overview').set(as('amLead')).expect(200);
    expect(ov.body.canManage).toBe(false);
    expect(ov.body.templates.length).toBeGreaterThanOrEqual(10);
    await http().get(`/automations/${rule.id}`).set(as('finance')).expect(200);
    await http().get('/automations/runs').set(as('amLead')).expect(200);
    await http().post('/automations').set(as('amLead')).send(overdueRule(3)).expect(403);
    await http().patch(`/automations/${rule.id}`).set(as('amLead')).send({ enabled: true }).expect(403);
    await http().delete(`/automations/${rule.id}`).set(as('finance')).expect(403);
    await http().post('/automations/run-now').set(as('amLead')).send({}).expect(403);
    const audit = await prisma.auditEvent.findFirst({ where: { entity: 'AutomationRule', entityId: rule.id, action: 'automation.created' } });
    expect(audit).not.toBeNull();
  });

  it('validates rules in plain words', async () => {
    const bad = await http().post('/automations').set(as('founder')).send({ ...overdueRule(3), actions: [] }).expect(400);
    expect(bad.body.message).toMatch(/at least one action/i);
    await http().post('/automations').set(as('founder')).send({ ...overdueRule(3), conditions: [{ field: 'nope', op: 'equals', value: 'x' }] }).expect(400);
    await http().post('/automations').set(as('founder')).send({ ...overdueRule(3), enabled: false, trigger: 'lead_created', actions: [{ type: 'change_lead_stage', stage: 'contacted' }], conditions: [] }).expect(201).then((r) => ruleIds.push(r.body.id));
    await http().post('/automations').set(as('founder')).send({ ...overdueRule(3), actions: [{ type: 'assign_lead_owner' }] }).expect(400);
  });
});

describe('webhooks', () => {
  it('blocks localhost and private addresses', async () => {
    for (const url of ['http://localhost:4000/x', 'http://127.0.0.1/hook', 'http://10.0.0.5/hook', 'http://192.168.1.10/', 'http://169.254.169.254/latest', 'http://[::1]/', 'ftp://example.com/x', 'http://app.internal/x']) {
      const r = await http().post('/automations').set(as('founder')).send({ ...overdueRule(3), actions: [{ type: 'webhook', url }] });
      expect(r.status, url).toBe(400);
    }
    expect(isPrivateIp('172.20.1.1')).toBe(true);
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIp('fd12::1')).toBe(true);
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(webhookUrlProblem('https://hooks.example.com/abc')).toBeNull();
  });
});

describe('engine: invoice overdue', () => {
  it('dry run shows matches and changes nothing; run-now acts once per invoice and step', async () => {
    const big = await invoice('BIG', 5_900_000, 12); // ₹59,000, 12 days late
    const small = await invoice('SMALL', 590_000, 12); // ₹5,900, 12 days late
    const r3 = await createRule({ ...overdueRule(3), conditions: [...overdueRule(3).conditions, { field: 'amount', op: 'greater_than', value: '10000' }] });
    const r10 = await createRule(overdueRule(10));
    // Pretend both rules were switched on weeks ago so the 3-day step (crossed 9 days ago) is in range.
    await prisma.automationRule.updateMany({ where: { id: { in: [r3.id, r10.id] } }, data: { watermark: new Date(Date.now() - 30 * DAY) } });
    expect(r3.sentence).toMatch(/^When an invoice is 3 days overdue, if client name is .* and invoice total is more than ₹10,000 →/);

    const counts = async () => ({
      runs: await prisma.automationRun.count({ where: { ruleId: { in: [r3.id, r10.id] } } }),
      notes: await prisma.notification.count({ where: { userId: amId, body: { contains: `E2EAUTO/${stamp}` } } }),
      msgs: await prisma.message.count({ where: { thread: { clientOrgId: clientId } } }),
    });
    const before = await counts();
    const test = await http().post(`/automations/${r3.id}/test`).set(as('amLead')).expect(200);
    const hitBig = test.body.matches.find((m: { entityId: string }) => m.entityId === big.id);
    const hitSmall = test.body.matches.find((m: { entityId: string }) => m.entityId === small.id);
    expect(hitBig.passes).toBe(true);
    expect(hitBig.wouldDo.join(' ')).toMatch(/Would alert Neha Iyer/);
    expect(hitSmall.passes).toBe(false);
    expect(hitSmall.failedCondition).toMatch(/Invoice total is more than/);
    expect(await counts()).toEqual(before);

    const first = await http().post('/automations/run-now').set(as('founder')).send({ ruleId: r3.id }).expect(200);
    expect(first.body.fired).toBe(1);
    await http().post('/automations/run-now').set(as('founder')).send({ ruleId: r10.id }).expect(200);
    const runs3 = await runsFor(r3.id);
    expect(runs3).toHaveLength(1);
    expect(runs3[0]).toMatchObject({ entityId: big.id, status: 'success', dedupeKey: 'overdue3d' });
    const runs10 = await runsFor(r10.id);
    expect(runs10.map((r) => r.entityId).sort()).toEqual([big.id, small.id].sort());
    expect(runs10.every((r) => r.dedupeKey === 'overdue10d')).toBe(true);

    const after = await counts();
    expect(after.notes - before.notes).toBe(3);
    expect(after.msgs - before.msgs).toBe(3);
    const msg = await prisma.message.findFirst({ where: { thread: { clientOrgId: clientId }, body: { contains: big.number } } });
    expect(msg?.isInternal).toBe(false);
    expect(msg?.authorId).toBe(amId);

    // Running again never double-fires.
    // (Per rule, so the seeded demo rules don't act on other specs' records.)
    for (const id of [r3.id, r10.id]) await http().post('/automations/run-now').set(as('founder')).send({ ruleId: id }).expect(200);
    expect(await prisma.automationRun.count({ where: { ruleId: { in: [r3.id, r10.id] } } })).toBe(3);
    expect(await counts()).toEqual(after);

    const rule = await http().get(`/automations/${r10.id}`).set(as('founder')).expect(200);
    expect(rule.body.runCount).toBe(2);
    expect(rule.body.runs[0].steps[0].text).toMatch(/Alerted Neha Iyer/);
    const log = await http().get(`/automations/runs?ruleId=${r10.id}&status=success`).set(as('finance')).expect(200);
    expect(log.body).toHaveLength(2);
    expect(log.body[0].link).toMatch(/^\/admin\/finance\/invoices\//);
  });

  it('does not run disabled or deleted rules', async () => {
    await invoice('OFF', 1_180_000, 5);
    const rule = await createRule(overdueRule(4, { enabled: false }));
    await http().post('/automations/run-now').set(as('founder')).send({ ruleId: rule.id }).expect(200);
    expect(await runsFor(rule.id)).toHaveLength(0);
    await http().patch(`/automations/${rule.id}`).set(as('founder')).send({ enabled: true }).expect(200);
    await http().delete(`/automations/${rule.id}`).set(as('founder')).expect(200);
    await http().post('/automations/run-now').set(as('founder')).send({ ruleId: rule.id }).expect(404);
    await http().get(`/automations/${rule.id}`).set(as('founder')).expect(404);
  });
});

describe('engine: lead created', () => {
  it('assigns an owner in turn and creates a task, only for matching new leads, once', async () => {
    const source = `e2e-${stamp}`;
    const rule = await createRule({
      name: `E2E welcome ${stamp}`,
      trigger: 'lead_created',
      conditions: [{ field: 'source', op: 'equals', value: source }],
      actions: [
        { type: 'assign_lead_owner' },
        { type: 'create_task', title: 'E2E{{stamp}} call {{lead}} about {{service}}'.replace('{{stamp}}', String(stamp)), assignTo: 'owner', dueInDays: 1 },
      ],
    });
    const lead = (name: string, src: string) => prisma.lead.create({ data: { orgId, source: src, contact: { name, company: `${name} Co` }, need: 'Social media', serviceIds: ['smm'] } });
    const a = await lead('Asha', source);
    const b = await lead('Bilal', source);
    const other = await lead('Chitra', 'walk-in');

    const dry = await http().post('/automations/test').set(as('founder')).send({ name: 'draft', trigger: 'lead_created', conditions: [{ field: 'source', op: 'equals', value: source }], actions: [{ type: 'assign_lead_owner' }] }).expect(200);
    expect(dry.body.matches.filter((m: { passes: boolean }) => m.passes)).toHaveLength(2);
    expect(dry.body.matches.every((m: { beforeStart: boolean }) => m.beforeStart)).toBe(true);
    expect(await prisma.lead.count({ where: { id: { in: [a.id, b.id] }, ownerId: { not: null } } })).toBe(0);

    const res = await http().post('/automations/run-now').set(as('founder')).send({ ruleId: rule.id }).expect(200);
    expect(res.body.fired).toBe(2);
    const [la, lb, lo] = await Promise.all([a, b, other].map((l) => prisma.lead.findUniqueOrThrow({ where: { id: l.id } })));
    expect(la.ownerId).toBeTruthy();
    expect(lb.ownerId).toBeTruthy();
    expect(lo.ownerId).toBeNull();
    const sales = await prisma.user.count({ where: { orgId, type: 'staff', status: 'active', deletedAt: null, roles: { some: { role: { baseRole: { in: ['sales_executive', 'sales_manager'] } } } } } });
    if (sales > 1) expect(la.ownerId).not.toBe(lb.ownerId);
    const tasks = await prisma.task.findMany({ where: { title: { contains: `E2E${stamp} call` } } });
    expect(tasks).toHaveLength(2);
    expect(tasks.find((t) => t.title.includes('Asha'))?.ownerId).toBe(la.ownerId);
    expect(tasks[0].deadline!.getTime()).toBeGreaterThan(Date.now());

    await http().post('/automations/run-now').set(as('founder')).send({ ruleId: rule.id }).expect(200);
    expect(await runsFor(rule.id)).toHaveLength(2);
    expect(await prisma.task.count({ where: { title: { contains: `E2E${stamp} call` } } })).toBe(2);
  });
});

describe('templates', () => {
  it('creates an enabled, editable rule in one click', async () => {
    const r = await http().post('/automations/from-template').set(as('founder')).send({ templateKey: 'nudge_idle_leads_5d' }).expect(201);
    ruleIds.push(r.body.id);
    expect(r.body).toMatchObject({ enabled: true, templateKey: 'nudge_idle_leads_5d', trigger: 'lead_idle' });
    const edited = await http()
      .put(`/automations/${r.body.id}`)
      .set(as('founder'))
      .send({ name: 'Nudge after 7 days', trigger: 'lead_idle', triggerArgs: { days: 7 }, conditions: [], actions: r.body.actions, enabled: true })
      .expect(200);
    expect(edited.body.sentence).toMatch(/^When a lead has not moved for 7 days → alert the record's owner/);
    await http().patch(`/automations/${r.body.id}`).set(as('founder')).send({ enabled: false }).expect(200);
  });
});
