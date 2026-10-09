// v14 workflows and no-code customisation: the overdue-invoice flow on a simulated clock (day 1, 7, 14), a run that
// survives an API restart mid-wait, approvals, versions, moving v9 automations, custom fields (filter, dashboard
// widget, workflow check), forms (lead + new-lead flow, bot trap, rate limit) and pipeline required fields.
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { compileWorkflow, WORKFLOW_TEMPLATES, workflowInputSchema, type WorkflowInput } from '@bmu/shared';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { WorkflowEngine } from '../src/workflows/engine.js';

let app: INestApplication;
let prisma: PrismaService;
let engine: WorkflowEngine;
const tokens: Record<string, string> = {};
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const stamp = Date.now();
const DAY = 86_400_000;
const MIN = 60_000;
let orgId: string;
let clientId: string;
let clientName: string;
let amId: string;
const workflowIds: string[] = [];
const fieldIds: string[] = [];
const formIds: string[] = [];
const leadIds: string[] = [];
const ruleIds: string[] = [];

async function signIn(email: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier: email }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier: email, code: otp.body.devCode }).expect(200)).body.token as string;
}

async function boot() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  prisma = app.get(PrismaService);
  engine = app.get(WorkflowEngine);
}

async function createWorkflow(body: WorkflowInput, who = 'founder') {
  const r = await http().post('/workflows').set(as(who)).send(body);
  if (r.status !== 201) throw new Error(`create workflow ${r.status}: ${JSON.stringify(r.body)}`);
  workflowIds.push(r.body.id);
  return r.body as { id: string; version: number; steps: unknown[] };
}

const template = (key: string) => structuredClone(WORKFLOW_TEMPLATES.find((t) => t.key === key)!.workflow);
const runOf = (workflowId: string) => prisma.workflowRun.findFirstOrThrow({ where: { workflowId }, include: { steps: { orderBy: { at: 'asc' } } } });
const tick = async (at: Date, workflowId: string) => {
  const r = await engine.tick(at, { workflowId });
  expect(r).not.toBeNull();
  return r!;
};

async function lead(company: string, extra: Record<string, unknown> = {}) {
  const l = await prisma.lead.create({ data: { orgId, source: 'referral', contact: { name: `Test ${company}`, company, phone: '9876500000', email: `${company.toLowerCase().replace(/\W/g, '')}@example.com` }, need: 'Social media', serviceIds: [], ...extra } });
  leadIds.push(l.id);
  return l;
}

beforeAll(async () => {
  await boot();
  const org = await prisma.organisation.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  orgId = org.id;
  amId = (await prisma.user.findFirstOrThrow({ where: { email: 'am@bmu.demo' } })).id;
  clientName = `Workflow Test ${stamp}`;
  clientId = (await prisma.clientOrg.create({ data: { orgId, name: clientName, amUserId: amId } })).id;
  const ownerRole = await prisma.role.findFirstOrThrow({ where: { orgId, baseRole: 'client_owner', isCustom: false } });
  const owner = await prisma.user.create({ data: { orgId, type: 'client', name: 'Flow Owner', email: `flow.owner.${stamp}@example.com`, status: 'active', roles: { create: { roleId: ownerRole.id } } } });
  await prisma.clientUser.create({ data: { userId: owner.id, orgId, clientOrgId: clientId, clientRole: 'client_owner', brandScope: [] } });
  tokens.founder = await signIn('founder@bmu.demo');
  tokens.amLead = await signIn('am.lead@bmu.demo');
  tokens.producer = await signIn('producer@bmu.demo');
  tokens.salesManager = await signIn('sales.manager@bmu.demo');
});

afterAll(async () => {
  if (prisma) {
    const runs = await prisma.workflowRun.findMany({ where: { workflowId: { in: workflowIds } }, select: { id: true } });
    await prisma.approvalRequest.deleteMany({ where: { targetType: 'workflow_run', targetId: { in: runs.map((r) => r.id) } } });
    await prisma.workflowDef.deleteMany({ where: { id: { in: workflowIds } } });
    await prisma.automationRule.updateMany({ where: { id: { in: ruleIds } }, data: { deletedAt: new Date(), enabled: false } });
    await prisma.customFieldDef.deleteMany({ where: { id: { in: fieldIds } } });
    await prisma.pipelineConfig.deleteMany({ where: { orgId } });
    const subs = await prisma.formSubmission.findMany({ where: { formId: { in: formIds } }, select: { leadId: true } });
    leadIds.push(...subs.map((s) => s.leadId).filter((x): x is string => !!x));
    await prisma.formDef.deleteMany({ where: { id: { in: formIds } } });
    await prisma.whatsAppMessage.deleteMany({ where: { entityId: { in: leadIds } } });
    await prisma.task.deleteMany({ where: { title: { contains: String(stamp) } } });
    await prisma.leadActivity.deleteMany({ where: { leadId: { in: leadIds } } });
    await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
    await prisma.invoice.updateMany({ where: { number: { startsWith: `WF/${stamp}/` } }, data: { status: 'void' } });
  }
  await app?.close();
});

describe('compiled program', () => {
  it('flattens branches into jumps that land after the else path', () => {
    const steps = workflowInputSchema.parse(template('wf_proposal_chase')).steps;
    const p = compileWorkflow(steps);
    const first = p.findIndex((i) => i.op === 'if');
    const head = p[first] as { op: 'if'; else: number };
    expect(p[0]).toMatchObject({ op: 'wait', amount: 3, unit: 'days' });
    expect(p[head.else]).toMatchObject({ op: 'stop' });
    const jump = p[head.else - 1] as { op: 'jump'; to: number };
    expect(jump.op).toBe('jump');
    expect(jump.to).toBe(p.length);
  });

  it('every template is valid', () => {
    expect(WORKFLOW_TEMPLATES).toHaveLength(7);
    for (const t of WORKFLOW_TEMPLATES) expect(workflowInputSchema.safeParse(t.workflow).success).toBe(true);
  });
});

describe('permissions and validation', () => {
  it('lets leads read but only the Founder and Admins change workflows', async () => {
    await http().get('/workflows/overview').set(as('producer')).expect(403);
    const ov = await http().get('/workflows/overview').set(as('amLead')).expect(200);
    expect(ov.body.canManage).toBe(false);
    expect(ov.body.templates).toHaveLength(7);
    await http().post('/workflows').set(as('amLead')).send(template('wf_creative_scheduled')).expect(403);
  });

  it('refuses steps that do not fit the trigger, with a plain reason', async () => {
    const bad = await http()
      .post('/workflows')
      .set(as('founder'))
      .send({ name: `Bad ${stamp}`, trigger: 'invoice_overdue', triggerArgs: { days: 1 }, steps: [{ id: 'a1', kind: 'action', action: { type: 'score_lead' } }] })
      .expect(400);
    expect(bad.body.message).toMatch(/only works with lead and proposal triggers/);
    const noApprover = await http()
      .post('/workflows')
      .set(as('founder'))
      .send({ name: `Bad ${stamp}`, trigger: 'lead_created', steps: [{ id: 'p1', kind: 'approval', title: 'Go?', approved: [], rejected: [] }] })
      .expect(400);
    expect(noApprover.body.message).toMatch(/Say who approves/);
  });
});

describe('overdue invoice flow on a simulated clock', () => {
  let wfId: string;
  let invoiceId: string;
  const t0 = new Date();

  it('day 1: reminds the client and Finance, then waits 6 days', async () => {
    const inv = await prisma.invoice.create({
      data: { orgId, clientOrgId: clientId, number: `WF/${stamp}/1`, lines: [], subtotalPaise: 100000, gstPaise: 18000, totalPaise: 118000, dueDate: new Date(t0.getTime() - DAY - 60 * MIN), status: 'issued' },
    });
    invoiceId = inv.id;
    const wf = template('wf_overdue_invoice');
    wf.name = `Overdue ${stamp}`;
    wf.start = { match: 'all', conditions: [{ field: 'client', op: 'equals', value: clientName }] };
    wfId = (await createWorkflow(wf)).id;
    const r = await tick(t0, wfId);
    expect(r.started).toBe(1);
    const run = await runOf(wfId);
    expect(run.status).toBe('waiting');
    expect(run.steps.map((s) => s.kind)).toEqual(['action', 'action', 'wait']);
    expect(run.steps[0].text).toMatch(/Sent .* a message/);
    expect(run.wakeAt!.getTime()).toBeGreaterThan(t0.getTime() + 6 * DAY - MIN);
    const msg = await prisma.message.findFirst({ where: { thread: { clientOrgId: clientId }, body: { contains: `WF/${stamp}/1` } } });
    expect(msg?.isInternal).toBe(false);
    // Nothing moves before the wait is over.
    await tick(new Date(t0.getTime() + 3 * DAY), wfId);
    expect((await runOf(wfId)).steps).toHaveLength(3);
  });

  it('day 7: still unpaid, so a firmer reminder and the AM is told', async () => {
    await tick(new Date(t0.getTime() + 6 * DAY + MIN), wfId);
    const run = await runOf(wfId);
    expect(run.status).toBe('waiting');
    expect(run.steps[3]).toMatchObject({ kind: 'if' });
    expect(run.steps[3].text).toMatch(/^Yes: Amount still owed now is more than/);
    expect(run.steps.slice(4).map((s) => s.kind)).toEqual(['action', 'action', 'wait']);
    expect(await prisma.notification.count({ where: { userId: amId, body: { contains: `WF/${stamp}/1` } } })).toBeGreaterThanOrEqual(1);
  });

  it('survives an API restart in the middle of the wait (day 14 runs on a fresh app)', async () => {
    await app.close();
    await boot();
    tokens.founder = await signIn('founder@bmu.demo');
    await tick(new Date(t0.getTime() + 13 * DAY + 2 * MIN), wfId);
    const run = await runOf(wfId);
    expect(run.status).toBe('waiting');
    const texts = run.steps.map((s) => s.text).join('\n');
    expect(texts).toMatch(/Created task "Call Workflow Test .* about invoice WF\/.*\/1 \(14 days late\)"/);
    expect(await prisma.task.count({ where: { title: { contains: `WF/${stamp}/1` } } })).toBe(1);
  });

  it('stops as soon as the invoice is paid', async () => {
    await prisma.payment.create({ data: { orgId, invoiceId, amountPaise: 118000, method: 'upi', at: new Date() } });
    await tick(new Date(t0.getTime() + 29 * DAY + 3 * MIN), wfId);
    const run = await runOf(wfId);
    expect(run.status).toBe('done');
    expect(run.steps.at(-1)).toMatchObject({ kind: 'stop', text: 'Stopped: Paid' });
    const detail = await http().get(`/workflows/runs/${run.id}`).set(as('amLead')).expect(200);
    expect(detail.body.outline.length).toBeGreaterThan(10);
    expect(detail.body.outline.filter((o: { state: string }) => o.state === 'done').length).toBeGreaterThan(5);
  });
});

describe('approvals and versions', () => {
  let wfId: string;
  let leadId: string;

  it('waits for an approval, then takes the approved path', async () => {
    const company = `Approval Co ${stamp}`;
    wfId = (
      await createWorkflow({
        name: `Approve ${stamp}`,
        trigger: 'lead_created',
        start: { match: 'all', conditions: [{ field: 'company', op: 'equals', value: company }] },
        steps: [
          { id: 'p1', kind: 'approval', title: 'Fast-track {{company}}?', approverRole: 'founder', expiresInDays: 3, approved: [{ id: 'a1', kind: 'action', action: { type: 'change_lead_stage', stage: 'contacted' } }], rejected: [{ id: 's1', kind: 'stop', reason: 'Not now' }] },
        ],
      })
    ).id;
    leadId = (await lead(company)).id;
    await tick(new Date(), wfId);
    let run = await runOf(wfId);
    expect(run.status).toBe('waiting_approval');
    const inbox = await http().get('/actions/approvals').set(as('founder')).expect(200);
    const mine = inbox.body.find((a: { targetId: string }) => a.targetId === run.id);
    expect(mine).toMatchObject({ summary: `Fast-track ${company}?`, requestedBy: { name: 'Workflow' }, canDecide: true });
    await http().post(`/actions/approvals/${mine.id}/decide`).set(as('founder')).send({ decision: 'approve' }).expect(200);
    await tick(new Date(), wfId);
    run = await runOf(wfId);
    expect(run.status).toBe('done');
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: leadId } })).stage).toBe('contacted');
    expect(run.steps.map((s) => s.text).join('\n')).toMatch(/Approved by/);
  });

  it('saves a new version on edit; finished and running runs keep theirs', async () => {
    const before = await http().get(`/workflows/${wfId}`).set(as('founder')).expect(200);
    const body = { name: before.body.name, trigger: 'lead_created', start: before.body.start, steps: [{ id: 'n1', kind: 'action', action: { type: 'notify', to: 'owner', message: 'Hello {{lead}}' } }] };
    const after = await http().put(`/workflows/${wfId}`).set(as('founder')).send(body).expect(200);
    expect(after.body.version).toBe(2);
    expect(after.body.versions.map((v: { number: number }) => v.number)).toEqual([2, 1]);
    const run = await runOf(wfId);
    const v1 = await prisma.workflowVersion.findFirstOrThrow({ where: { workflowId: wfId, number: 1 } });
    expect(run.versionId).toBe(v1.id);
  });
});

describe('moving v9 automations into workflows', () => {
  it('creates a workflow, switches the rule off and never repeats records it handled', async () => {
    const r = await http()
      .post('/automations')
      .set(as('founder'))
      .send({ name: `Move me ${stamp}`, trigger: 'lead_created', conditions: [{ field: 'company', op: 'equals', value: `Moved Co ${stamp}` }], actions: [{ type: 'notify', to: 'role', role: 'sales_manager', message: 'New {{lead}}' }] })
      .expect(201);
    ruleIds.push(r.body.id);
    const handled = await lead(`Moved Co ${stamp}`);
    await prisma.automationRun.create({ data: { orgId, ruleId: r.body.id, entity: 'Lead', entityId: handled.id, dedupeKey: 'created', status: 'success', detail: { summary: '1 action done', record: `Lead ${handled.id}` } } });
    const moved = await http().post('/workflows/move-automations').set(as('founder')).send({ ruleId: r.body.id }).expect(200);
    expect(moved.body.moved).toHaveLength(1);
    const wfId = moved.body.moved[0].workflowId as string;
    workflowIds.push(wfId);
    expect(moved.body.moved[0].importedRuns).toBe(1);
    const rule = await prisma.automationRule.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(rule).toMatchObject({ enabled: false, movedToWorkflowId: wfId });
    const res = await tick(new Date(), wfId);
    expect(res.started).toBe(0);
    const wf = await http().get(`/workflows/${wfId}`).set(as('founder')).expect(200);
    expect(wf.body.movedFromRule).toBe(true);
    expect(wf.body.steps[0]).toMatchObject({ kind: 'action', action: { type: 'notify' } });
  });
});

describe('custom fields', () => {
  let bandKey: string;
  let bigLead: string;

  it('the Founder adds a field; others cannot', async () => {
    await http().post('/custom-fields').set(as('amLead')).send({ entity: 'lead', label: 'Budget band', type: 'select', options: ['Small', 'Large'] }).expect(403);
    const f = await http().post('/custom-fields').set(as('founder')).send({ entity: 'lead', label: `Budget band ${stamp}`, type: 'select', options: ['Small', 'Large'] }).expect(201);
    fieldIds.push(f.body.id);
    bandKey = f.body.key;
    expect(bandKey).toBe(`budget_band_${stamp}`);
    await http().post('/custom-fields').set(as('founder')).send({ entity: 'lead', label: 'Bad', type: 'select', options: ['Only one'] }).expect(400);
  });

  it('values are checked and filterable on the lead list', async () => {
    bigLead = (await lead(`Big Co ${stamp}`)).id;
    const small = (await lead(`Small Co ${stamp}`)).id;
    await http().put(`/custom-fields/values/lead/${bigLead}`).set(as('salesManager')).send({ values: { [bandKey]: 'Medium' } }).expect(400);
    const saved = await http().put(`/custom-fields/values/lead/${bigLead}`).set(as('salesManager')).send({ values: { [bandKey]: 'large' } }).expect(200);
    expect(saved.body.values[bandKey]).toBe('Large');
    await http().put(`/custom-fields/values/lead/${small}`).set(as('salesManager')).send({ values: { [bandKey]: 'Small' } }).expect(200);
    const list = await http().get(`/leads?cf.${bandKey}=Large`).set(as('salesManager')).expect(200);
    expect(list.body.map((l: { id: string }) => l.id)).toEqual([bigLead]);
    expect(list.body[0].customFields[bandKey]).toBe('Large');
  });

  it('feeds a dashboard widget', async () => {
    const b = await http().get(`/dashboards/data/field/lead/${bandKey}`).set(as('salesManager')).expect(200);
    expect(b.body.rows.find((r: { value: string }) => r.value === 'Large')).toMatchObject({ count: 1, href: `/team/leads?cf.${bandKey}=Large` });
    expect(b.body.rows.find((r: { value: string }) => r.value === 'Small').count).toBe(1);
    const widget = { id: 'w1', type: 'custom_field', size: 'half', entity: 'lead', field: bandKey };
    const d = await http().post('/dashboards').set(as('founder')).send({ name: `Fields ${stamp}`, audience: { roles: ['founder'] } }).expect(201);
    try {
      const saved = await http().patch(`/dashboards/${d.body.id}`).set(as('founder')).send({ layout: [widget] }).expect(200);
      expect(saved.body.layout[0]).toMatchObject({ type: 'custom_field', field: bandKey });
    } finally {
      await prisma.dashboardVersion.deleteMany({ where: { dashboardId: d.body.id } });
      await prisma.dashboard.delete({ where: { id: d.body.id } });
    }
  });

  it('works in a workflow check', async () => {
    const wf = await createWorkflow({
      name: `Band check ${stamp}`,
      trigger: 'lead_created',
      start: { match: 'all', conditions: [{ field: 'company', op: 'contains', value: `Co ${stamp}` }] },
      steps: [{ id: 'i1', kind: 'if', match: 'all', conditions: [{ field: `custom.lead.${bandKey}`, op: 'equals', value: 'Large' }], then: [{ id: 'a1', kind: 'action', action: { type: 'create_task', title: `Big deal ${stamp}: {{company}}`, assignTo: 'role', role: 'sales_manager', dueInDays: 1 } }], else: [] }],
    });
    // These leads came in before the workflow existed; move the start line back for the test.
    await prisma.workflowDef.update({ where: { id: wf.id }, data: { watermark: new Date(Date.now() - 60 * MIN) } });
    await tick(new Date(), wf.id);
    const tasks = await prisma.task.findMany({ where: { title: { startsWith: `Big deal ${stamp}` } } });
    expect(tasks.map((t) => t.title)).toEqual([`Big deal ${stamp}: Big Co ${stamp}`]);
    const runs = await prisma.workflowRun.findMany({ where: { workflowId: wf.id }, include: { steps: true } });
    const smallRun = runs.find((r) => r.record.includes('Small Co'));
    expect(smallRun?.steps[0].text).toMatch(/^No: Lead: Budget band .* is "Large" \(it is Small\)/);
  });
});

describe('forms', () => {
  let slug: string;
  let formId: string;
  let bandKey: string;

  it('a sales manager builds a form with a custom answer saved to a lead field', async () => {
    const f = await http().post('/custom-fields').set(as('founder')).send({ entity: 'lead', label: `Team size ${stamp}`, type: 'select', options: ['1-10', '11-50', '50+'] }).expect(201);
    fieldIds.push(f.body.id);
    bandKey = f.body.key;
    const form = await http()
      .post('/forms')
      .set(as('salesManager'))
      .send({
        name: `Website form ${stamp}`,
        title: 'Grow with BMU',
        fields: [
          { id: 'name', type: 'name', label: 'Your name', required: true },
          { id: 'company', type: 'company', label: 'Business', required: true },
          { id: 'email', type: 'email', label: 'Email', required: true },
          { id: 'phone', type: 'phone', label: 'WhatsApp number' },
          { id: 'budget', type: 'budget', label: 'Monthly budget' },
          { id: 'team', type: 'select', label: 'Team size', options: ['1-10', '11-50', '50+'], customFieldKey: bandKey },
          { id: 'msg', type: 'message', label: 'What do you need?' },
        ],
      })
      .expect(201);
    formIds.push(form.body.id);
    formId = form.body.id;
    slug = form.body.slug;
    expect(form.body.publicPath).toBe(`/f/${slug}`);
    const pub = await http().get(`/public/forms/${slug}`).expect(200);
    expect(pub.body.fields[5]).not.toHaveProperty('customFieldKey');
  });

  it('a submission creates a lead and starts the new-lead flow', async () => {
    const company = `Form Co ${stamp}`;
    const wf = template('wf_new_lead');
    wf.name = `New lead ${stamp}`;
    wf.start = { match: 'all', conditions: [{ field: 'company', op: 'equals', value: company }] };
    const flow = await createWorkflow(wf);
    const formFlow = await createWorkflow({ name: `Form flow ${stamp}`, trigger: 'form_submitted', triggerArgs: { formId }, steps: [{ id: 'n1', kind: 'action', action: { type: 'notify', to: 'role', role: 'sales_manager', message: 'Form {{form}} from {{company}}' } }] });

    await http().post(`/public/forms/${slug}/submit`).send({ answers: { name: 'Riya', company, email: 'bad' } }).expect(400);
    const ok = await http()
      .post(`/public/forms/${slug}/submit`)
      .send({ answers: { name: 'Riya', company, email: `riya.${stamp}@example.com`, phone: `+91 9${String(stamp).slice(-9)}`, budget: '60000', team: '11-50', msg: 'Need reels' }, pageUrl: 'https://example.com/contact' })
      .expect(200);
    expect(ok.body.ok).toBe(true);
    const l = await prisma.lead.findFirstOrThrow({ where: { orgId, source: 'form', contact: { path: ['company'], equals: company } } });
    leadIds.push(l.id);
    expect(l.budgetPaise).toBe(6_000_000);
    expect((l.customFields as Record<string, string>)[bandKey]).toBe('11-50');

    await tick(new Date(), flow.id);
    const run = await runOf(flow.id);
    expect(run.status).toBe('waiting');
    const texts = run.steps.map((s) => s.text);
    expect(texts[0]).toMatch(/^Scored the lead \d+\/100/);
    expect(texts[1]).toMatch(/Assigned the lead to/);
    expect(texts[2]).toMatch(/Queued a WhatsApp to Riya/);
    expect(texts[3]).toMatch(/Created task "Call Riya/);
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: l.id } });
    expect(after.ownerId).not.toBeNull();
    expect(await prisma.whatsAppMessage.count({ where: { entityId: l.id, status: 'queued' } })).toBe(1);
    const queue = await http().get('/workflows/whatsapp-queue').set(as('founder')).expect(200);
    expect(queue.body.find((m: { link: string | null }) => m.link === `/team/leads/${l.id}`)?.toName).toBe('Riya');
    await http().get('/workflows/whatsapp-queue').set(as('amLead')).expect(403);

    await tick(new Date(), formFlow.id);
    const fr = await runOf(formFlow.id);
    expect(fr.status).toBe('done');
    expect(fr.steps[0].text).toContain(`Form Website form ${stamp} from ${company}`);
  });

  it('quietly drops bot submissions and limits repeats from one address', async () => {
    const before = await prisma.formSubmission.count({ where: { formId } });
    await http().post(`/public/forms/${slug}/submit`).send({ answers: { name: 'Bot', company: 'Spam', email: 'bot@example.com' }, website: 'http://spam' }).expect(200);
    expect(await prisma.formSubmission.count({ where: { formId } })).toBe(before);
    let last = 200;
    for (let i = 0; i < 6 && last === 200; i++) {
      last = (await http().post(`/public/forms/${slug}/submit`).send({ answers: { name: `Repeat ${i}`, company: `Repeat ${stamp} ${i}`, email: `repeat.${i}.${stamp}@example.com` } })).status;
    }
    expect(last).toBe(429);
  });

  it('only form managers can see submissions', async () => {
    await http().get(`/forms/${formId}/submissions`).set(as('producer')).expect(403);
    const subs = await http().get(`/forms/${formId}/submissions`).set(as('salesManager')).expect(200);
    expect(subs.body[0].answers.length).toBeGreaterThan(0);
  });
});

describe('pipelines', () => {
  it('renames stages and requires fields before a lead moves on', async () => {
    const p = await http().get('/pipelines').set(as('salesManager')).expect(200);
    expect(p.body.canEdit).toBe(false);
    const leadPipe = p.body.pipelines.find((x: { kind: string }) => x.kind === 'lead');
    const stages = leadPipe.stages.map((s: { key: string }) => (s.key === 'contacted' ? { ...s, label: 'First call done', requiredFields: ['budget', 'follow_up'] } : s));
    await http().put('/pipelines/lead').set(as('salesManager')).send({ stages }).expect(403);
    await http()
      .put('/pipelines/lead')
      .set(as('founder'))
      .send({ stages: stages.map((s: { key: string }) => (s.key === 'won' ? { ...s, hidden: true } : s)) })
      .expect(400);
    const saved = await http().put('/pipelines/lead').set(as('founder')).send({ stages }).expect(200);
    expect(saved.body.stages.find((s: { key: string }) => s.key === 'contacted').label).toBe('First call done');
    const l = await lead(`Pipeline Co ${stamp}`);
    const refused = await http().patch(`/leads/${l.id}`).set(as('founder')).send({ stage: 'contacted' }).expect(400);
    expect(refused.body.message).toBe('Before moving to First call done, fill in: Budget, Next follow-up date');
    await prisma.lead.update({ where: { id: l.id }, data: { budgetPaise: 5_000_000, nextFollowUpAt: new Date(Date.now() + DAY) } });
    await http().patch(`/leads/${l.id}`).set(as('founder')).send({ stage: 'contacted' }).expect(200);
    await http().delete('/pipelines/lead').set(as('founder')).expect(200);
  });
});
