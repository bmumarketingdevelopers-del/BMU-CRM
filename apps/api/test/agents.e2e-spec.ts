// v15 AI agents: the Sales assistant on a new lead (basic and AI mode), the Agent Inbox (approve with edits, reject,
// who may decide), undo from the run log, an agent acting for someone without lead access, the per-agent budget,
// Request triage, the Producer's morning check, Ask the Analyst with sources, and the agent safety checks (evals).
// The real API is never called: the AI client is a scripted fake.
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { AgentEvalResult, AgentProposalView, AgentRunDetail, AgentsOverview } from '@bmu/shared';
import { AppModule } from '../src/app.module.js';
import { AI_CLIENT, type AiClient, type AiRunParams } from '../src/ai/ai-client.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AgentsService } from '../src/agents/agents.service.js';

delete process.env.ANTHROPIC_API_KEY;

type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
const reply = (content: Block[]) => ({
  id: `msg_${Math.random()}`,
  type: 'message',
  role: 'assistant',
  model: 'fake',
  content,
  stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});

class FakeClient implements AiClient {
  on = false;
  queue: ReturnType<typeof reply>[] = [];
  calls: AiRunParams[] = [];
  available() {
    return this.on;
  }
  async run(p: AiRunParams) {
    this.calls.push(JSON.parse(JSON.stringify({ ...p, onText: undefined })));
    return (this.queue.shift() ?? reply([{ type: 'text', text: 'Done.' }])) as never;
  }
  reset(on: boolean) {
    this.on = on;
    this.queue = [];
    this.calls = [];
  }
}

const fake = new FakeClient();
let app: INestApplication;
let prisma: PrismaService;
let agents: AgentsService;
let orgId: string;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
const users: Record<string, string> = {};
const leadIds: string[] = [];
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const stamp = Date.now();

async function signIn(email: string) {
  const otp = await http().post('/auth/otp/request').send({ identifier: email }).expect(200);
  return (await http().post('/auth/otp/verify').send({ identifier: email, code: otp.body.devCode }).expect(200)).body.token as string;
}

async function newLead(company: string, extra: Record<string, unknown> = {}) {
  const l = await prisma.lead.create({ data: { orgId, source: 'website', contact: { name: 'Asha Verma', company, email: `${company.toLowerCase().replace(/\W/g, '')}@example.com` }, need: 'Social media management for our new bakery, around 12 posts a month', budgetPaise: 4_000_000, serviceIds: [], ...extra } });
  leadIds.push(l.id);
  return l;
}

const patch = (key: string, body: Record<string, unknown>) => http().patch(`/agents/${key}`).set(as('founder')).send(body);
const tick = async () => (await http().post('/agents/tick').set(as('founder')).expect(200)).body as { runs: number };
const runFor = async (subjectId: string) => {
  const rows = (await http().get(`/agents/runs?subjectId=${subjectId}`).set(as('founder')).expect(200)).body as { id: string }[];
  expect(rows.length).toBeGreaterThan(0);
  return (await http().get(`/agents/runs/${rows[0].id}`).set(as('founder')).expect(200)).body as AgentRunDetail;
};

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(AI_CLIENT).useValue(fake).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  prisma = app.get(PrismaService);
  agents = app.get(AgentsService);
  orgId = (await prisma.organisation.findFirstOrThrow({ orderBy: { createdAt: 'asc' } })).id;
  // Start from the defaults (test database only): agents are recreated off, acting for the Founder.
  await prisma.agentProposal.deleteMany({ where: { orgId } });
  await prisma.agent.deleteMany({ where: { orgId } });
  for (const [who, email] of Object.entries({ founder: 'founder@bmu.demo', salesManager: 'sales.manager@bmu.demo', sales: 'sales@bmu.demo', producer: 'producer@bmu.demo', am: 'am@bmu.demo', amLead: 'am.lead@bmu.demo' })) {
    tokens[who] = await signIn(email);
    users[who] = (await prisma.user.findFirstOrThrow({ where: { email } })).id;
  }
  // A client with a retainer, for Request triage.
  const smm = await prisma.service.findFirstOrThrow({ where: { key: 'smm', priceBook: { orgId, status: 'active' } } });
  const client = await prisma.clientOrg.create({ data: { orgId, name: `Agent Test ${stamp}`, amUserId: users.am, industry: 'Bakery' } });
  ids.client = client.id;
  const ownerRole = await prisma.role.findFirstOrThrow({ where: { orgId, baseRole: 'client_owner', isCustom: false } });
  const owner = await prisma.user.create({ data: { orgId, type: 'client', name: 'Bakery Owner', email: `agent.owner.${stamp}@example.com`, status: 'active', roles: { create: { roleId: ownerRole.id } } } });
  ids.owner = owner.id;
  await prisma.clientUser.create({ data: { userId: owner.id, orgId, clientOrgId: client.id, clientRole: 'client_owner', brandScope: [] } });
  tokens.client = await signIn(owner.email!);
  ids.engagement = (await prisma.engagement.create({ data: { orgId, clientOrgId: client.id, serviceId: smm.id, tier: 'growth', billingType: 'monthly', status: 'in_production', currentGate: 'G3', amId: users.am, cycles: { create: { orgId, period: '2026-10', status: 'production' } } } })).id;
});

afterAll(async () => {
  await prisma.agent.updateMany({ where: { orgId }, data: { enabled: false } });
  await prisma.agentProposal.deleteMany({ where: { orgId, OR: [{ targetId: { in: leadIds } }, { targetType: 'Request' }, { targetType: 'Task' }] } });
  await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
  await prisma.user.updateMany({ where: { id: ids.owner }, data: { deletedAt: new Date() } });
  await app.close();
});

beforeEach(() => fake.reset(false));

describe('Agents page', () => {
  it('lists the agents, off and acting for the Founder; Founder/Admin only', async () => {
    const o = (await http().get('/agents').set(as('founder')).expect(200)).body as AgentsOverview;
    expect(o.agents.map((a) => a.key)).toEqual(['sales_assistant', 'request_triage', 'producer', 'analyst', 'creative_reviewer', 'finance_collector']);
    expect(o.agents.every((a) => !a.enabled)).toBe(true);
    expect(o.agents[0].actsFor?.id).toBe(users.founder);
    expect(o.later).toHaveLength(1);
    expect(o.aiMode).toBe('basic');
    // Client-facing and money actions are never "auto".
    const reply = o.agents[0].actions.find((a) => a.action === 'send_lead_reply')!;
    expect(reply.policy).toBe('confirm');
    await http().get('/agents').set(as('sales')).expect(403);
    await patch('sales_assistant', { enabled: true }).set(as('salesManager')).expect(403);
  });

  it('switching on needs an acting person and starts from now', async () => {
    const old = await newLead(`Old Lead ${stamp}`);
    await patch('sales_assistant', { actsForUserId: null }).expect(200);
    await patch('sales_assistant', { enabled: true }).expect(400);
    await patch('sales_assistant', { enabled: true, actsForUserId: users.salesManager }).expect(200);
    await tick();
    expect(await prisma.agentRun.count({ where: { subjectId: old.id } })).toBe(0);
  });
});

describe('Sales assistant (basic mode)', () => {
  it('scores a new lead, adds a brief and a follow-up, and asks before replying or assigning', async () => {
    const lead = await newLead(`Crumb Bakery ${stamp}`);
    const r = await tick();
    expect(r.runs).toBeGreaterThanOrEqual(1);
    const run = await runFor(lead.id);
    expect(run.status).toBe('done');
    expect(run.mode).toBe('basic');
    expect(run.actingFor).toBe('Rahul Menon');
    const kinds = run.steps.map((s) => `${s.kind}:${s.tool}`);
    expect(kinds).toEqual(expect.arrayContaining(['action:set_lead_score', 'action:add_lead_note', 'action:set_lead_follow_up', 'proposal:send_lead_reply', 'proposal:assign_lead']));
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.score).toBeGreaterThan(0);
    expect(after.nextFollowUpAt).not.toBeNull();
    expect(after.ownerId).toBeNull();
    // Nothing went to the prospect.
    expect(await prisma.leadActivity.count({ where: { leadId: lead.id, kind: { in: ['email', 'whatsapp'] } } })).toBe(0);
    expect(await prisma.emailOutbox.count({ where: { entityId: lead.id } })).toBe(0);
    // A second pass does not run it again.
    await tick();
    expect(await prisma.agentRun.count({ where: { subjectId: lead.id } })).toBe(1);
    ids.lead = lead.id;
    ids.run = run.id;
  });

  it('Agent Inbox: the acting person sees the suggestions; others cannot decide', async () => {
    const mine = (await http().get('/agents/inbox').set(as('salesManager')).expect(200)).body as AgentProposalView[];
    const replyP = mine.find((p) => p.action === 'send_lead_reply' && p.payload.leadId === ids.lead)!;
    expect(replyP.canDecide).toBe(true);
    expect(replyP.fields.map((f) => f.key)).toEqual(['channel', 'subject', 'text']);
    ids.replyProposal = replyP.id;
    ids.assignProposal = mine.find((p) => p.action === 'assign_lead' && p.payload.leadId === ids.lead)!.id;
    const others = (await http().get('/agents/inbox').set(as('producer')).expect(200)).body as AgentProposalView[];
    expect(others.some((p) => p.id === replyP.id)).toBe(false);
    await http().post(`/agents/inbox/${replyP.id}/decide`).set(as('producer')).send({ decision: 'approve' }).expect(403);
  });

  it('approving with an edit sends the edited reply and logs it; rejecting records why', async () => {
    const text = `Hi Asha, thanks for writing to us. Could we speak tomorrow at 11? (edited ${stamp})`;
    const p = (await http().post(`/agents/inbox/${ids.replyProposal}/decide`).set(as('salesManager')).send({ decision: 'approve', edits: { text, leadId: 'someone-else' } }).expect(200)).body as AgentProposalView;
    expect(p.status).toBe('approved');
    expect(p.payload.leadId).toBe(ids.lead); // only editable fields can change
    const act = await prisma.leadActivity.findFirstOrThrow({ where: { leadId: ids.lead, kind: 'email' } });
    expect(act.body).toBe(text);
    expect(await prisma.emailOutbox.count({ where: { entityId: ids.lead } })).toBe(1);
    await http().post(`/agents/inbox/${ids.replyProposal}/decide`).set(as('salesManager')).send({ decision: 'approve' }).expect(400);

    const rej = (await http().post(`/agents/inbox/${ids.assignProposal}/decide`).set(as('founder')).send({ decision: 'reject', note: 'I will take this one' }).expect(200)).body as AgentProposalView;
    expect(rej.status).toBe('rejected');
    const run = (await http().get(`/agents/runs/${ids.run}`).set(as('founder')).expect(200)).body as AgentRunDetail;
    expect(run.steps.some((s) => s.title.startsWith('Rahul Menon approved') && s.kind === 'action')).toBe(true);
    expect(run.steps.some((s) => s.title.includes('rejected'))).toBe(true);
  });

  it('undo from the run log: one step, then the rest of the run', async () => {
    let run = (await http().get(`/agents/runs/${ids.run}`).set(as('founder')).expect(200)).body as AgentRunDetail;
    const score = run.steps.find((s) => s.tool === 'set_lead_score')!;
    expect(score.canUndo).toBe(true);
    // Someone unrelated cannot undo it.
    await http().post(`/agents/runs/${ids.run}/steps/${score.id}/undo`).set(as('producer')).expect(403);
    run = (await http().post(`/agents/runs/${ids.run}/steps/${score.id}/undo`).set(as('salesManager')).expect(200)).body;
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: ids.lead } })).score).toBe(0);
    expect(run.steps.find((s) => s.id === score.id)!.undoneBy).toBe('Rahul Menon');
    await http().post(`/agents/runs/${ids.run}/steps/${score.id}/undo`).set(as('founder')).expect(400);
    run = (await http().post(`/agents/runs/${ids.run}/undo`).set(as('founder')).expect(200)).body;
    expect(run.status).toBe('undone');
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: ids.lead } });
    expect(lead.nextFollowUpAt).toBeNull();
    expect(await prisma.leadActivity.count({ where: { leadId: ids.lead, kind: 'note' } })).toBe(0);
    // The reply that was already sent stays (it can't be unsent) and is not offered for undo.
    expect(await prisma.leadActivity.count({ where: { leadId: ids.lead, kind: 'email' } })).toBe(1);
    expect(run.canUndo).toBe(false);
  });

  it('feedback thumbs show on the agent card', async () => {
    await http().post(`/agents/runs/${ids.run}/feedback`).set(as('founder')).send({ value: 1, note: 'Useful brief' }).expect(200);
    const o = (await http().get('/agents').set(as('founder')).expect(200)).body as AgentsOverview;
    expect(o.agents[0].thumbsUp).toBeGreaterThanOrEqual(1);
  });

  it("can't do anything its acting person can't (acting for someone without lead access)", async () => {
    await patch('sales_assistant', { actsForUserId: users.producer }).expect(200);
    const lead = await newLead(`No Access Lead ${stamp}`);
    await tick();
    const run = await runFor(lead.id);
    expect(run.steps.filter((s) => s.kind === 'action' || s.kind === 'proposal')).toHaveLength(0);
    expect(run.steps.filter((s) => s.kind === 'blocked').length).toBeGreaterThanOrEqual(3);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).score).toBe(0);
    expect(await prisma.agentProposal.count({ where: { targetId: lead.id } })).toBe(0);
    await patch('sales_assistant', { actsForUserId: users.salesManager }).expect(200);
  });
});

describe('Sales assistant (AI mode, scripted model)', () => {
  it('a misbehaving model is refused for never-actions and foreign actions; good steps still run or wait', async () => {
    const lead = await newLead(`AI Bakery ${stamp}`);
    fake.reset(true);
    fake.queue = [
      reply([
        { type: 'tool_use', id: 't1', name: 'issue_refund', input: { invoiceId: 'x' } },
        { type: 'tool_use', id: 't2', name: 'reassign_task', input: { taskId: 'x', toUserId: users.producer, reason: 'overload', note: 'move it' } },
        { type: 'tool_use', id: 't3', name: 'set_lead_score', input: { leadId: lead.id, score: 81, reason: 'Clear need and budget' } },
        { type: 'tool_use', id: 't4', name: 'send_lead_reply', input: { leadId: lead.id, channel: 'email', text: 'Hi Asha, thank you for reaching out. Can we talk tomorrow?' } },
      ]),
      reply([{ type: 'text', text: 'Scored the lead and drafted a reply; the refund was refused.' }]),
    ];
    const runs = (await http().post('/agents/sales_assistant/run').set(as('founder')).send({ subjectId: lead.id }).expect(200)).body as AgentRunDetail[];
    const run = runs[0];
    expect(run.mode).toBe('ai');
    const byTool = Object.fromEntries(run.steps.map((s) => [s.tool, s]));
    expect(byTool.issue_refund.kind).toBe('blocked');
    expect(byTool.issue_refund.policy).toBe('never');
    expect(byTool.reassign_task.kind).toBe('blocked');
    expect(byTool.set_lead_score.kind).toBe('action');
    expect(byTool.send_lead_reply.kind).toBe('proposal');
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).score).toBe(81);
    // The model was told which results were refused or waiting, and the enquiry was fenced.
    const second = JSON.stringify(fake.calls[1].messages.at(-1));
    expect(second).toContain('Refused');
    expect(second).toContain('Sent to the Agent Inbox');
    expect(JSON.stringify(fake.calls[0].messages[0])).toContain('<client_text source=\\"lead enquiry\\">');
    expect(fake.calls[0].tools!.map((t) => (t as { name: string }).name)).not.toContain('issue_refund');
    const log = await prisma.aiLog.findFirstOrThrow({ where: { feature: 'agent_run', targetId: lead.id } });
    expect(log.mode).toBe('ai');
    expect(run.costPaise).toBe(log.costPaise);
  });

  it('when the agent budget is used up it keeps working in basic mode', async () => {
    const a = await prisma.agent.findFirstOrThrow({ where: { orgId, key: 'sales_assistant' } });
    await patch('sales_assistant', { monthlyBudgetPaise: 100 }).expect(200);
    const spent = await prisma.agentRun.create({ data: { orgId, agentId: a.id, agentKey: 'sales_assistant', trigger: 'manual', status: 'done', mode: 'ai', costPaise: 150 } });
    fake.reset(true);
    const lead = await newLead(`Budget Bakery ${stamp}`);
    const run = ((await http().post('/agents/sales_assistant/run').set(as('founder')).send({ subjectId: lead.id }).expect(200)).body as AgentRunDetail[])[0];
    expect(run.mode).toBe('basic');
    expect(run.notice).toMatch(/budget is used up/);
    expect(fake.calls).toHaveLength(0);
    expect(run.steps.some((s) => s.tool === 'set_lead_score' && s.kind === 'action')).toBe(true);
    await prisma.agentRun.delete({ where: { id: spent.id } });
    await patch('sales_assistant', { monthlyBudgetPaise: 100000, enabled: false }).expect(200);
  });
});

describe('Request triage', () => {
  it('notes the triage, suggests type, assignee and an acknowledgement; the AM approves the reply', async () => {
    await patch('request_triage', { enabled: true, actsForUserId: users.amLead }).expect(200);
    ids.request = (await http().post('/client/requests').set(as('client')).send({ engagementId: ids.engagement, type: 'change', description: `URGENT ${stamp}: we also need an additional new landing page for the festive offer today!` }).expect(201)).body.id;
    await tick();
    const run = await runFor(ids.request);
    const kinds = run.steps.map((s) => `${s.kind}:${s.tool}`);
    expect(kinds).toEqual(expect.arrayContaining(['action:add_request_note', 'proposal:reply_to_request', 'proposal:set_request_type']));
    const note = await prisma.comment.findFirstOrThrow({ where: { targetType: 'request', targetId: ids.request, isInternal: true } });
    expect(note.body).toMatch(/^Request triage: Type: new scope/);
    // The client sees nothing yet.
    const view = (await http().get(`/client/requests/${ids.request}`).set(as('client')).expect(200)).body as { comments: { internal: boolean }[]; type: string };
    expect(view.comments.filter((c) => !c.internal)).toHaveLength(0);
    expect(view.type).toBe('change');
    // The client's AM is a decider and approves the acknowledgement.
    const inbox = (await http().get('/agents/inbox').set(as('am')).expect(200)).body as AgentProposalView[];
    const ack = inbox.find((p) => p.action === 'reply_to_request' && p.payload.requestId === ids.request)!;
    expect(ack.canDecide).toBe(true);
    await http().post(`/agents/inbox/${ack.id}/decide`).set(as('am')).send({ decision: 'approve' }).expect(200);
    const after = (await http().get(`/client/requests/${ids.request}`).set(as('client')).expect(200)).body as { comments: { internal: boolean; body: string }[] };
    expect(after.comments.filter((c) => !c.internal)).toHaveLength(1);
    await patch('request_triage', { enabled: false }).expect(200);
  });
});

describe('Producer', () => {
  it('reminds owners about overdue tasks once a day', async () => {
    await patch('producer', { actsForUserId: users.founder }).expect(200);
    const t = await prisma.task.create({ data: { orgId, title: `Overdue agent task ${stamp}`, ownerId: users.producer, deadline: new Date(Date.now() - 2 * 86_400_000), isInternal: true } });
    const first = ((await http().post('/agents/producer/run').set(as('founder')).send({}).expect(200)).body as AgentRunDetail[])[0];
    expect(first.status).toBe('done');
    const n = await prisma.notification.findFirst({ where: { userId: users.producer, kind: 'agent', title: { contains: 'overdue' } }, orderBy: { createdAt: 'desc' } });
    expect(n?.title).toMatch(/^Producer: You have \d+ overdue task/);
    const second = ((await http().post('/agents/producer/run').set(as('founder')).send({}).expect(200)).body as AgentRunDetail[])[0];
    expect(second.steps.some((s) => s.tool === 'notify_person' && s.title.includes('Meera'))).toBe(false);
    await prisma.task.delete({ where: { id: t.id } });
  });
});

describe('Analyst', () => {
  it('needs to be switched on, then answers with sources and only what the asker can see', async () => {
    await http().post('/agents/analyst/ask').set(as('founder')).send({ question: 'What is our SOP?' }).expect(400);
    await patch('analyst', { enabled: true }).expect(200);
    await http().post('/agents/knowledge/refresh').set(as('founder')).expect(200);
    const sop = await prisma.sOP.findFirstOrThrow({ where: { orgId, status: 'published' } });
    const word = sop.title.split(/\s+/).find((w) => w.length > 4)!;
    const a = (await http().post('/agents/analyst/ask').set(as('founder')).send({ question: `What does the ${word} SOP say?` }).expect(200)).body as { text: string; citations: { href: string }[]; mode: string };
    expect(a.mode).toBe('basic');
    expect(a.citations.some((c) => c.href === `/team/sops/${sop.id}`)).toBe(true);
    expect(a.text).toContain(`/team/sops/${sop.id}`);
    // A salesperson asking about invoices gets "not allowed", never numbers.
    const s = (await http().post('/agents/analyst/ask').set(as('sales')).send({ question: 'How much is overdue from invoices?' }).expect(200)).body as { text: string };
    expect(s.text).toMatch(/cannot see invoices/);
  });

  it('AI mode: an answer that used knowledge always lists its sources', async () => {
    fake.reset(true);
    const sop = await prisma.sOP.findFirstOrThrow({ where: { orgId, status: 'published' } });
    fake.queue = [reply([{ type: 'tool_use', id: 'k1', name: 'knowledge_search', input: { query: sop.title } }]), reply([{ type: 'text', text: 'Here is the short version of the process.' }])];
    const a = (await http().post('/agents/analyst/ask').set(as('founder')).send({ question: 'Summarise that SOP' }).expect(200)).body as { text: string; citations: { href: string }[]; mode: string };
    expect(a.mode).toBe('ai');
    expect(a.text).toContain('Sources:');
    expect(a.citations.some((c) => c.href === `/team/sops/${sop.id}`)).toBe(true);
    await patch('analyst', { enabled: false }).expect(200);
  });
});

describe('Safety checks (evals)', () => {
  it('all agent safety checks pass and leave nothing behind', async () => {
    const leadsBefore = await prisma.lead.count({ where: { orgId } });
    const r = (await http().post('/agents/evals').set(as('founder')).expect(200)).body as AgentEvalResult;
    for (const c of r.cases) expect({ key: c.key, passed: c.passed, detail: c.detail }).toEqual({ key: c.key, passed: true, detail: c.detail });
    expect(r.passed).toBe(true);
    expect(r.total).toBe(9);
    expect(await prisma.lead.count({ where: { orgId } })).toBe(leadsBefore);
    expect(await prisma.agentRun.count({ where: { isEval: true } })).toBe(0);
    await http().post('/agents/evals').set(as('sales')).expect(403);
  });

  it('the scheduler is off in tests and a pass is skipped while another runs', async () => {
    const [a, b] = await Promise.all([agents.tick(new Date(), { orgId }), agents.tick(new Date(), { orgId })]);
    expect([a, b].filter((x) => x === null)).toHaveLength(1);
  });
});
