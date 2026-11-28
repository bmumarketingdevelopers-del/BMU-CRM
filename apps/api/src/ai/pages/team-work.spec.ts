// Team work page skills: the basic-mode answer for sample data shaped like each load(), and the empty case.
import { describe, expect, it } from 'vitest';
import type { AgentInboxData, CalendarData, CapacityData, ContentCalendarData, DailyReportsData, DashboardsData, DiscussionsData, DocsData, HrIssuesData, ManagerData, OnboardingData, ProjectsData, ReviewsData, SopsData, SpecialistsData, WorkloadData } from './team-work.js';
import { SKILLS } from './team-work.js';

const skill = (name: string) => {
  const s = SKILLS.find((x) => x.name === name);
  if (!s) throw new Error(`no skill ${name}`);
  return (data: unknown, q = '') => s.answer(data as never, q.toLowerCase());
};

describe('team work page skills', () => {
  it('every answer ends with its tab link', () => {
    for (const s of SKILLS) expect(s.href).toMatch(/^\/team\//);
  });

  it('Projects', () => {
    const a = skill('page_projects');
    const d: ProjectsData = {
      live: 3,
      delivered: 1,
      waitingOnInputs: 1,
      plansDue: 1,
      lateDeliverables: 2,
      atRiskDeliverables: 1,
      byGate: [
        { gate: 'G1 Requirements Complete', count: 2 },
        { gate: 'G2 Plan Approved', count: 1 },
      ],
      projects: [
        { client: 'Metro Dental', service: 'Social media', gate: 'Requirements Complete', am: 'Asha Rao', inputsOutstanding: 2, planningDue: '2 Dec 2026', late: 2, link: '/team/projects/e1' },
        { client: 'Bright Homes', service: 'SEO', gate: 'Plan Approved', am: null, inputsOutstanding: 0, planningDue: null, late: 0, link: '/team/projects/e2' },
      ],
    };
    const all = a(d, 'How many live projects do we have?');
    expect(all).toContain('3 live projects, 1 delivered');
    expect(all).toContain('G1 Requirements Complete 2');
    expect(all).toContain('[Metro Dental · Social media](/team/projects/e1)');
    expect(all).toMatch(/\[Projects\]\(\/team\/projects\)\.$/);
    const waiting = a(d, 'Which projects are waiting on client inputs?');
    expect(waiting).toContain('1 live project is waiting on client inputs');
    expect(waiting).not.toContain('Bright Homes');
    expect(a({ ...d, live: 0, delivered: 0, waitingOnInputs: 0, projects: [] })).toContain('no projects');
  });

  it('Review Studio', () => {
    const a = skill('page_review_studio');
    const d: ReviewsData = {
      total: 2,
      byStage: [
        { stage: 'QC passed', count: 1 },
        { stage: 'In production', count: 1 },
      ],
      items: [
        { title: 'Diwali reel', client: 'Metro Dental', type: 'reel', stage: 'QC passed', link: '/team/deliverables/d1' },
        { title: 'Blog post', client: '', type: 'blog', stage: 'In production', link: '/team/deliverables/d2' },
      ],
    };
    const t = a(d);
    expect(t).toContain('2 deliverables in Review Studio: 1 qc passed, 1 in production');
    expect(t).toContain('[Diwali reel](/team/deliverables/d1) · Metro Dental · reel (QC passed)');
    expect(t).toContain('no client');
    expect(a({ total: 0, byStage: [], items: [] })).toContain('No deliverables in Review Studio yet');
  });

  it('Content calendar', () => {
    const a = skill('page_content_calendar');
    const d: ContentCalendarData = {
      from: '28 Nov 2026',
      to: '11 Dec 2026',
      upcoming: [{ title: 'Offer post', client: 'Metro Dental', channel: 'Instagram', when: '30 Nov', stage: 'Scheduled' }],
      upcomingCount: 1,
      dueToPublish: [{ title: 'Old reel', client: 'Bright Homes', when: '27 Nov' }],
      unscheduled: 2,
    };
    const t = a(d, "What's on the content calendar this week?");
    expect(t.indexOf('1 post on the calendar')).toBeLessThan(t.indexOf('past its time'));
    expect(t).toContain('30 Nov: Offer post · Metro Dental · Instagram (Scheduled)');
    expect(t).toContain('2 approved posts still have no date.');
    const due = a(d, 'Which posts are due to publish?');
    expect(due.startsWith('1 scheduled post is past its time')).toBe(true);
    const empty = a({ ...d, upcoming: [], upcomingCount: 0, dueToPublish: [], unscheduled: 0 });
    expect(empty).toContain('Nothing is scheduled from 28 Nov 2026 to 11 Dec 2026.');
    expect(empty).toContain('[Content calendar](/team/content-calendar)');
  });

  it('Calendar', () => {
    const a = skill('page_calendar');
    const d: CalendarData = {
      from: '28 Nov 2026',
      to: '12 Dec 2026',
      counts: [
        { kind: 'meetings', count: 1 },
        { kind: 'task deadlines', count: 1 },
      ],
      items: [
        { date: '29 Nov 11:00 am', kind: 'meetings', title: 'Kick-off call', sub: 'Metro Dental', overdue: false },
        { date: '30 Nov', kind: 'task deadlines', title: 'Write captions', sub: null, overdue: true },
      ],
    };
    const t = a(d);
    expect(t).toContain('1 meetings, 1 task deadlines');
    expect(t).toContain('- 29 Nov 11:00 am: Kick-off call · Metro Dental');
    expect(t).toContain('Write captions (overdue)');
    expect(a({ ...d, counts: [], items: [] })).toContain('Nothing on your calendar from 28 Nov 2026 to 12 Dec 2026');
  });

  it('Capacity', () => {
    const a = skill('page_capacity');
    const d: CapacityData = {
      scope: 'Design',
      week: '23 Nov to 29 Nov',
      me: { open: 4, dueThisWeek: 2, overdue: 1, loadPct: 60 },
      people: [
        { name: 'Ravi Kumar', department: 'Design', open: 2, overdue: 0, loadPct: 30, onLeave: false },
        { name: 'Neha Shah', department: 'Design', open: 12, overdue: 3, loadPct: 120, onLeave: false },
        { name: 'Amit Jain', department: null, open: 0, overdue: 0, loadPct: 0, onLeave: true },
      ],
      unassigned: 1,
      unassignedTop: [{ title: 'Logo refresh', client: 'Metro Dental', deadline: '2 Dec' }],
    };
    const t = a(d, 'show team capacity this week');
    expect(t).toContain('You: 60% loaded, 4 open tasks, 2 due this week, 1 overdue.');
    expect(t.indexOf('Neha Shah')).toBeLessThan(t.indexOf('Ravi Kumar'));
    expect(t).toContain('On leave: Amit Jain.');
    expect(t).toContain('1 task with no owner, e.g. Logo refresh.');
    const room = a(d, 'who has room this week?');
    expect(room).toContain('Has room (under 80%):\n- Ravi Kumar (Design): 30%');
    expect(room).not.toContain('Neha Shah');
    expect(a({ ...d, me: null, people: [], unassigned: 0, unassignedTop: [] })).toBe('Capacity for Design, week of 23 Nov to 29 Nov.\nOpen [Capacity](/team/capacity).');
  });

  it('Workload', () => {
    const a = skill('page_workload');
    const d: WorkloadData = {
      week: '23 Nov 2026',
      people: [
        { name: 'Neha Shah', specialty: 'designer', loadPct: 110, hours: 44, available: 40, leaveDays: 0 },
        { name: 'Ravi Kumar', specialty: null, loadPct: null, hours: 0, available: 0, leaveDays: 5 },
      ],
      over: 1,
      requests: 2,
    };
    const t = a(d);
    expect(t).toContain('Week of 23 Nov 2026: 44 hours booked or on tasks across 2 people, 1 over 100%.');
    expect(t).toContain('Neha Shah (designer): 44 of 40 h · 110%');
    expect(t).toContain('Ravi Kumar: 0 of 0 h (not available) · 5 leave days');
    expect(t).toContain('2 booking requests waiting.');
    expect(a({ week: null, people: [], over: 0, requests: 0 })).toContain("No one's workload is visible");
  });

  it('Specialists', () => {
    const a = skill('page_specialists');
    const d: SpecialistsData = { count: 1, specialists: [{ name: 'Neha Shah', specialty: 'Graphic designer', department: 'Design', open: 5, overdue: 2, dueThisWeek: 3, doneLast30: 14 }] };
    expect(a(d)).toContain('1 specialist, 1 with overdue work:\n- Neha Shah (Graphic designer): 5 open, 3 due this week, 2 overdue, 14 done in 30 days');
    expect(a({ count: 0, specialists: [] })).toContain('No specialists');
  });

  it('Daily reports', () => {
    const a = skill('page_daily_reports');
    const d: DailyReportsData = { date: '28 Nov 2026', filed: ['Ravi Kumar'], notFiled: ['Neha Shah', 'Amit Jain'], blocked: [{ name: 'Ravi Kumar', items: ['Waiting for logo files'] }] };
    const t = a(d);
    expect(t).toContain('2 of 3 have not filed their report for 28 Nov 2026: Neha Shah, Amit Jain.');
    expect(t).toContain('Filed: Ravi Kumar.');
    expect(t).toContain('- Ravi Kumar: Waiting for logo files');
    expect(a({ ...d, filed: ['Ravi Kumar', 'Neha Shah'], notFiled: [], blocked: [] })).toContain('Everyone (2) has filed');
    expect(a({ date: '28 Nov 2026', filed: [], notFiled: [], blocked: [] })).toContain('Nobody reports to you yet');
  });

  it('Agent Inbox', () => {
    const a = skill('page_agent_inbox');
    const d: AgentInboxData = { pending: 2, toDecide: 1, proposals: [{ agent: 'Collections agent', action: 'Send reminder', title: 'Remind Metro Dental', why: 'Invoice 12 days late', canDecide: true, expires: '30 Nov' }] };
    const t = a(d);
    expect(t).toContain('2 agent proposals waiting, 1 for you to decide:');
    expect(t).toContain('- Collections agent: Send reminder: Remind Metro Dental (Invoice 12 days late) · expires 30 Nov');
    expect(a({ pending: 0, toDecide: 0, proposals: [] })).toContain('Nothing is waiting in your Agent Inbox');
  });

  it('Dashboards', () => {
    const a = skill('page_dashboards');
    const d: DashboardsData = { dashboards: [{ name: 'Sales weekly', description: 'Leads and wins', link: '/team/dashboards/x1' }] };
    expect(a(d)).toContain('1 dashboard shared with you:\n- [Sales weekly](/team/dashboards/x1): Leads and wins');
    expect(a({ dashboards: [] })).toContain('No dashboards have been shared with you yet');
  });

  it('Manager workspace', () => {
    const a = skill('page_manager_workspace');
    const d: ManagerData = {
      scope: 'Your clients',
      kpis: [{ label: 'On time', value: '82%' }],
      insights: ['3 tasks are waiting for an owner'],
      openTasks: 10,
      unassigned: 3,
      overdue: 2,
      today: [{ title: 'Client replied', detail: 'Needs a reply', client: 'Metro Dental' }],
      overloaded: [{ name: 'Neha Shah', loadPct: 130 }],
      onLeave: ['Amit Jain'],
    };
    const t = a(d);
    expect(t).toContain('Manager workspace (Your clients): 10 open tasks, 3 unassigned, 2 overdue.');
    expect(t).toContain('On time: 82%');
    expect(t).toContain('- Client replied · Metro Dental: Needs a reply');
    expect(t).toContain('Over capacity: Neha Shah (130%).');
    expect(t).toContain('On leave today: Amit Jain.');
    expect(a({ ...d, kpis: [], insights: [], openTasks: 0, unassigned: 0, overdue: 0, today: [], overloaded: [], onLeave: [] })).toBe('Manager workspace (Your clients): 0 open tasks, 0 unassigned, 0 overdue.\nOpen [Manager workspace](/team/manager).');
  });

  it('My onboarding', () => {
    const a = skill('page_onboarding');
    const d: OnboardingData = { onboarding: { status: 'open', startDate: '20 Nov 2026', buddy: 'Ravi Kumar', done: 3, total: 5, progressPct: 60, remaining: ['Read the brand SOP', 'Set up Slack'] } };
    expect(a(d)).toContain('Your onboarding is 60% done (3 of 5 steps), buddy Ravi Kumar, started 20 Nov 2026. Still to do:\n- Read the brand SOP\n- Set up Slack');
    expect(a({ onboarding: { ...d.onboarding!, status: 'done', done: 5, remaining: [] } })).toContain('Your onboarding is complete (5 of 5 steps)');
    expect(a({ onboarding: null })).toContain('You have no onboarding checklist');
  });

  it('HR issues', () => {
    const a = skill('page_hr_issues');
    const d: HrIssuesData = {
      mine: [{ subject: 'Laptop is slow', category: 'Office, equipment or tools', status: 'HR is looking into it', raised: '20 Nov', reply: 'A new one is ordered' }],
      answers: false,
      inbox: [],
    };
    const t = a(d);
    expect(t).toContain('- 20 Nov: Laptop is slow · HR is looking into it. Reply: A new one is ordered');
    expect(t).not.toContain('raised with you');
    const hr = a({ ...d, answers: true, inbox: [{ subject: 'Team conflict', from: 'Neha Shah', category: 'Workplace or team', status: 'Open', raised: '27 Nov' }] });
    expect(hr).toContain('1 open issue raised with you:\n- 27 Nov: Team conflict · Workplace or team · from Neha Shah (Open)');
    expect(a({ mine: [], answers: false, inbox: [] })).toContain("You haven't raised any HR issues.");
  });

  it('Discussions', () => {
    const a = skill('page_discussions');
    const d: DiscussionsData = {
      total: 2,
      unreadThreads: 1,
      unreadMessages: 3,
      threads: [
        { title: 'Diwali campaign', client: 'Metro Dental', unread: 3, last: { author: 'Neha Shah', at: '27 Nov', body: 'Draft is ready' }, link: '/team/discussions/t1' },
        { title: 'SEO audit', client: 'Bright Homes', unread: 0, last: null, link: '/team/discussions/t2' },
      ],
    };
    const unread = a(d, 'any unread discussions?');
    expect(unread).toContain('3 unread messages in 1 discussion (of 2).');
    expect(unread).toContain('[Diwali campaign](/team/discussions/t1) · Metro Dental · 3 unread: Neha Shah (27 Nov): "Draft is ready"');
    expect(unread).not.toContain('SEO audit');
    expect(a(d, "what's new in my discussions?")).toContain('SEO audit');
    expect(a({ total: 0, unreadThreads: 0, unreadMessages: 0, threads: [] })).toContain('You are not in any discussions yet');
  });

  it('SOP library', () => {
    const a = skill('page_sops');
    const d: SopsData = {
      count: 2,
      sops: [
        { title: 'Client onboarding', department: 'Accounts', version: 2, link: '/team/sops/s1' },
        { title: 'Reel editing checklist', department: 'Video', version: 1, link: '/team/sops/s2' },
      ],
    };
    const hit = a(d, 'Is there an SOP for client onboarding?');
    expect(hit).toContain('1 SOP matching your question:\n- [Client onboarding](/team/sops/s1) · Accounts (v2)');
    expect(hit).not.toContain('Reel editing');
    const all = a(d, 'What SOPs do we have?');
    expect(all).toContain('2 published SOPs: Accounts 1, Video 1.');
    expect(all).toContain('Reel editing checklist');
    expect(a(d, 'sop for payroll')).toContain('No SOP title matches that.');
    expect(a({ count: 0, sops: [] })).toContain('No SOPs are published yet');
  });

  it('Documents', () => {
    const a = skill('page_docs');
    const d: DocsData = {
      count: 2,
      docs: [
        { title: 'Content strategy', kind: 'strategy', client: 'Metro Dental', updatedBy: 'Asha Rao', updated: '27 Nov', clientVisible: true, link: '/team/docs/x1' },
        { title: 'Pitch notes', kind: 'note', client: null, updatedBy: null, updated: '20 Nov', clientVisible: false, link: '/team/docs/x2' },
      ],
    };
    const recent = a(d, 'Which documents were updated recently?');
    expect(recent).toContain('2 documents, most recently updated first:');
    expect(recent).toContain('[Content strategy](/team/docs/x1) · strategy · Metro Dental · updated 27 Nov by Asha Rao · client can see it');
    const one = a(d, 'Show the docs for Metro Dental');
    expect(one).toContain('1 document for Metro Dental:');
    expect(one).not.toContain('Pitch notes');
    expect(a({ count: 0, docs: [] })).toContain('No documents you can open yet');
  });
});
