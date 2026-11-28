// Every page skill: follows the contract, and each of its example questions, asked by someone who has the tab,
// is answered by that skill (not captured by another topic or another tab). Basic mode, fake data.
import type { Me } from '@bmu/shared';
import { describe, expect, it } from 'vitest';
import { AiCopilotService } from '../ai-copilot.js';
import type { CopilotTool } from '../ai-tools.js';
import { pageSkills, skillsFor } from './index.js';
import type { PageSkill } from './types.js';

const CORE = ['find_clients', 'client_360', 'clients_at_risk', 'find_leads', 'lead_details', 'find_invoices', 'find_tasks', 'find_requests', 'my_week', 'business_summary', 'sales_numbers', 'team_performance', 'my_goals', 'my_meetings', 'my_leave', 'my_timesheet', 'my_expenses', 'my_approvals', 'my_performance', 'my_account', 'my_invoices', 'my_requests', 'my_reviews', 'my_requirements', 'my_plans'];
const ALL_PERMS = Object.fromEntries(['leads_pipeline', 'qc_pass_fail', 'invoices_payments', 'plan_and_calendar'].map((k) => [k, { scope: 'all', rule: 'approve' }]));
const STAFF_ROLES = [['producer'], ['account_manager'], ['am_lead'], ['department_head'], ['finance'], ['hr_ops'], ['sales_manager'], ['sales_executive'], ['admin'], ['founder']];

/** Someone whose menu has this tab: try each role, with and without broad permissions. */
function personFor(s: PageSkill): Me | null {
  if (s.surface === 'client') {
    for (const permissions of [{}, ALL_PERMS]) {
      const me = { id: 'c1', orgId: 'o1', type: 'client', name: 'Ravi Kumar', roles: ['client_owner'], permissions, clientOrg: { id: 'co1', name: 'Metro Dental' } } as unknown as Me;
      if (s.can(me)) return me;
    }
    return null;
  }
  for (const permissions of [{}, ALL_PERMS])
    for (const leadsPeople of [false, true])
      for (const roles of STAFF_ROLES) {
        const me = { id: 'u1', orgId: 'o1', type: 'staff', name: 'Asha Rao', roles, permissions, leadsPeople } as unknown as Me;
        if (s.can(me)) return me;
      }
  return null;
}

function ask(me: Me) {
  const used: string[] = [];
  const names = [...CORE, ...skillsFor(me).map((s) => s.name)];
  const tools = names.map((name) => ({ name, status: '', description: '', schema: null, properties: {}, run: async () => (used.push(name), { data: { notAllowed: true, message: 'fake' }, citations: [] }) }) as unknown as CopilotTool);
  const prisma = { user: { findMany: async () => [{ id: 'u1', name: 'Asha Rao', status: 'active' }] } };
  const copilot = new AiCopilotService({} as never, prisma as never, {} as never) as unknown as {
    basicStaff: (me: Me, q: string, t: CopilotTool[], e: () => void) => Promise<unknown>;
    basicClient: (me: Me, q: string, t: CopilotTool[], e: () => void) => Promise<unknown>;
  };
  return async (q: string) => {
    used.length = 0;
    // Fake data is "not allowed" everywhere, so some answers can't be written; only the lookup used matters here.
    await (me.type === 'client' ? copilot.basicClient(me, q, tools, () => {}) : copilot.basicStaff(me, q, tools, () => {})).catch(() => undefined);
    return used.filter((n) => n !== 'find_clients');
  };
}

describe('Ask BMU page skills', () => {
  it('follow the contract', () => {
    const names = new Set<string>();
    for (const s of pageSkills()) {
      expect(s.name, s.label).toMatch(/^page_[a-z0-9_]+$/);
      expect(names.has(s.name), `duplicate ${s.name}`).toBe(false);
      names.add(s.name);
      expect(s.href, s.name).toMatch(s.surface === 'client' ? /^\/client/ : /^\/(team|admin)/);
      expect(s.examples.length, s.name).toBeGreaterThan(0);
      for (const ex of s.examples) expect(s.keywords.test(ex.toLowerCase()), `${s.name}: "${ex}" does not match its own keywords`).toBe(true);
      expect(personFor(s), `${s.name}: nobody has this tab`).not.toBeNull();
    }
  });

  it('each example question reaches its own tab', async () => {
    const misses: string[] = [];
    for (const s of pageSkills()) {
      const me = personFor(s);
      if (!me) continue;
      const run = ask(me);
      for (const ex of s.examples) {
        const used = await run(ex);
        if (used.at(-1) !== s.name) misses.push(`${s.name} (${me.roles.join(',') || me.type}): "${ex}" went to ${used.join(' → ') || 'no lookup (help or pointer)'}`);
      }
    }
    expect(misses).toEqual([]);
  });

  it('do not take over the core questions', async () => {
    const founder = { id: 'u1', orgId: 'o1', type: 'staff', name: 'Asha Rao', roles: ['founder'], permissions: ALL_PERMS, leadsPeople: true } as unknown as Me;
    const producer = { id: 'u1', orgId: 'o1', type: 'staff', name: 'Asha Rao', roles: ['producer'], permissions: {} } as unknown as Me;
    const owner = { id: 'c1', orgId: 'o1', type: 'client', name: 'Ravi Kumar', roles: ['client_owner'], permissions: ALL_PERMS } as unknown as Me;
    const cases: [Me, string, string][] = [
      [founder, 'Which clients are at risk this month and why?', 'clients_at_risk'],
      [founder, 'How much is overdue from Metro Dental?', 'find_invoices'],
      [founder, 'Unpaid invoices', 'find_invoices'],
      [founder, 'Show open leads', 'find_leads'],
      [founder, 'Which follow-ups are due?', 'find_leads'],
      [founder, 'Show open requests', 'find_requests'],
      [founder, 'Which replies are overdue?', 'find_requests'],
      [founder, 'How are we doing against target?', 'sales_numbers'],
      [founder, 'Show team performance', 'team_performance'],
      [founder, 'Summary of the week', 'business_summary'],
      [founder, 'What should I do today?', 'my_week'],
      [founder, 'List my goals', 'my_goals'],
      [founder, 'What meetings do I have coming up?', 'my_meetings'],
      [producer, 'Which of my tasks are overdue?', 'my_week'],
      [producer, 'Did I check in today?', 'my_week'],
      [producer, 'How many leaves do I have left?', 'my_leave'],
      [producer, 'How many hours have I logged this week?', 'my_timesheet'],
      [producer, 'What is the status of my expenses?', 'my_expenses'],
      [producer, 'Do I have approvals waiting?', 'my_approvals'],
      [producer, 'How am I performing this month?', 'my_performance'],
      [owner, 'What is waiting for my approval?', 'my_reviews'],
      [owner, 'Do I have any invoices due?', 'my_invoices'],
      [owner, 'What do you still need from me?', 'my_requirements'],
      [owner, 'Is my monthly plan ready?', 'my_plans'],
      [owner, 'What is the status of my requests?', 'my_requests'],
      [owner, 'Who is my client manager?', 'my_account'],
      [owner, 'Do I have a meeting coming up?', 'my_meetings'],
    ];
    const wrong: string[] = [];
    for (const [me, q, tool] of cases) {
      const used = await ask(me)(q);
      if (used[0] !== tool) wrong.push(`"${q}" (${me.roles[0]}) went to ${used.join(' → ') || 'nothing'}, expected ${tool}`);
    }
    expect(wrong).toEqual([]);
  });
});
