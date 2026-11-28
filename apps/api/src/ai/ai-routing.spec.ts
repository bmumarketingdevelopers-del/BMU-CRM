// Ask BMU basic mode end to end with fake tools: each dashboard question reaches the right lookup, and answers or
// help never mention what the person's dashboard doesn't have.
import type { Me } from '@bmu/shared';
import { describe, expect, it } from 'vitest';
import { AiCopilotService } from './ai-copilot.js';
import { skillsFor } from './pages/index.js';
import type { CopilotTool } from './ai-tools.js';

const week = {
  name: 'Asha Rao',
  tasks: { open: 1, overdue: [], dueToday: [], dueThisWeek: [], blocked: [], doneRecently: 2 },
  qc: { sentBackToMe: [], waitingForMyCheck: [], versionsWaitingForQc: 0 },
  deliveryAtRisk: [],
  sendToClientWaiting: 0,
  onLeave: null,
  attendance: { workday: 'working', holiday: null, checkIn: '9:42 am', checkOut: null, late: false, wfh: false, workingHours: '09:30–18:30 (15 min grace)', missedCheckOut: null, nextCheckIn: null, leaveDecision: null },
  eod: { submitted: false, exempt: false, completed: 0, pending: 0, blocked: 0, waiting: 0 },
  teamReports: null,
};
const data: Record<string, unknown> = {
  find_clients: [],
  my_week: week,
  my_goals: [{ title: 'Ship 20 reels', level: 'person', owner: 'Asha Rao', department: null, mine: true, current: '12', target: '20', progressPct: 60, status: 'on_track', ends: '31 Dec 2026' }],
  my_meetings: { upcoming: [{ title: 'Kick-off', when: '2 Dec 11:00 am', with: 'Metro Dental', host: 'Asha Rao', place: null, status: 'booked' }], beingArranged: [], recent: [] },
  my_leave: { balance: [{ type: 'casual', allowed: 11, used: 3, pending: 0, left: 8 }], unpaidUsed: 0, wfhDays: 0, canApply: true, requests: [], attendanceThisMonth: { daysPresent: 18, workingDaysSoFar: 20, totalHours: 150 }, upcomingHolidays: [] },
  my_timesheet: { week: '23 Nov – 29 Nov', status: 'draft', hours: 31.5, byDay: [], comment: null, canSubmit: true },
  my_expenses: { waiting: '₹0', approvedUnpaid: '₹0', claims: [] },
  my_approvals: { pending: 2 },
  my_performance: { stats: { completed: { value: 9, prev: 7 }, onTimePct: { value: 88, prev: 80 }, hours: { value: 140, prev: 0 }, qcFirstPassPct: { value: 75, prev: 0 }, avgCycleDays: { value: 2, prev: 2 }, streakDays: 4 }, teamAverage: { completed: 8, onTimePct: 80 }, upcoming: [] },
};
const notAllowed = { notAllowed: true, message: "Not allowed for this person's role: no" };

function setup(me: Me) {
  const called: string[] = [];
  const tools = [...skillsFor(me).map((sk) => sk.name), ...Object.keys({ ...data, find_invoices: 1, find_leads: 1, find_requests: 1, sales_numbers: 1, team_performance: 1, clients_at_risk: 1, business_summary: 1, find_tasks: 1, client_360: 1 })].map(
    (name) => ({ name, status: '', description: '', schema: null, properties: {}, run: async () => (called.push(name), { data: data[name] ?? notAllowed, citations: [] }) }) as unknown as CopilotTool,
  );
  const prisma = { user: { findMany: async () => [{ id: 'u1', name: 'Asha Rao', status: 'active' }, { id: 'u2', name: 'BMU', status: 'active' }, { id: 'u3', name: 'Meera Iyer', status: 'active' }] } };
  const svc = new AiCopilotService({} as never, prisma as never, {} as never);
  const ask = async (q: string) => {
    called.length = 0;
    const out = await svc.basicStaff(me, q, tools, () => {});
    return { text: out.text, used: called.filter((c) => c !== 'find_clients') };
  };
  return ask;
}

const producer = { id: 'u1', orgId: 'o1', type: 'staff', name: 'Asha Rao', roles: ['producer'], permissions: {} } as unknown as Me;

describe('Ask BMU basic mode routing', () => {
  it('answers each dashboard question from the right place', async () => {
    const ask = setup(producer);
    const cases: [string, string][] = [
      ['list my goals', 'my_goals'],
      ['Which goals are behind?', 'my_goals'],
      ['What meetings do I have coming up?', 'my_meetings'],
      ['How many leaves do I have left?', 'my_leave'],
      ['Is my leave approved?', 'my_leave'],
      ['Did I check in today?', 'my_week'],
      ['How many hours have I logged this week?', 'my_timesheet'],
      ['Is my timesheet submitted?', 'my_timesheet'],
      ['What is the status of my expenses?', 'my_expenses'],
      ['Do I have approvals waiting?', 'my_approvals'],
      ['How am I performing this month?', 'my_performance'],
      ['Have I filed my EOD?', 'my_week'],
      ['What is overdue?', 'my_week'],
    ];
    for (const [q, tool] of cases) expect((await ask(q)).used, q).toEqual([tool]);
    // Money questions still say plainly that invoices are not theirs to see.
    const money = await ask('How much is overdue from Metro Dental?');
    expect(money.used).toEqual(['find_invoices', 'my_week']);
    expect(money.text).toMatch(/can't see invoices/);
    expect((await ask('list my goals')).text).toContain('Ship 20 reels');
  });

  it('pages in the menu are pointed to; pages not in it are refused without suggesting them', async () => {
    const ask = setup(producer);
    // A tab in their menu is answered from that tab (page skill), with their own data.
    expect((await ask('where are the SOPs?')).used).toEqual(['page_sops']);
    const q = await ask('show me the quotations');
    expect(q.text).toContain('Quotations is not on your dashboard');
    expect(q.text).not.toMatch(/\*\*(Money|Sales|Team|Target)/);
  });

  it('help never uses a system account as a colleague, and lists only this role', async () => {
    const ask = setup({ ...producer, roles: ['founder'] } as Me);
    const help = (await ask('what can you do?')).text;
    expect(help).toContain('What is Meera working on?');
    expect(help).not.toContain('What is BMU working on?');
    const unknown = (await setup(producer)('asdf qwerty')).text;
    expect(unknown).toContain('Goals');
    expect(unknown).not.toContain('**Money');
  });
});
