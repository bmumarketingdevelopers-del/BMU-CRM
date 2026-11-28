// Ask BMU basic mode: what is on each person's dashboard and menu, and who may open it. The same rules as the team
// and client menus (apps/web/src/app/(team)/team/layout.tsx, (client)/client/layout.tsx), so the help list only
// suggests what the person actually has, and a question about a page they don't have is answered plainly.
import { isCraftManager, type Me } from '@bmu/shared';

const any = (me: Me, roles: string[]) => me.roles.some((r) => roles.includes(r));
export const staffAccess = (me: Me) => ({
  hasLeads: (me.permissions.leads_pipeline?.scope ?? 'none') !== 'none',
  allLeads: me.permissions.leads_pipeline?.scope === 'all',
  clientTeam: any(me, ['founder', 'admin', 'am_lead', 'account_manager', 'finance']),
  clientChat: any(me, ['founder', 'admin', 'am_lead', 'account_manager']),
  canQc: (me.permissions.qc_pass_fail?.scope ?? 'none') !== 'none',
  money: any(me, ['founder', 'admin', 'finance']),
  cmInvoices: any(me, ['am_lead', 'account_manager']),
  teamReader: any(me, ['founder', 'admin', 'department_head', 'am_lead']),
  manager: isCraftManager(me),
  founder: me.roles.includes('founder'),
  leadsPeople: !!me.leadsPeople,
});
export const clientCanBill = (me: Me) => (me.permissions.invoices_payments?.scope ?? 'none') !== 'none';

type Access = ReturnType<typeof staffAccess>;
export type Names = { client?: string; colleague?: string };

/** A topic answered with data (examples go in the help list). `key` is handled in AiCopilotService.basicStaff. */
export type DataTopic = { key: string; title: string; can: (a: Access) => boolean; examples: (n: Names, a: Access) => string[] };
/** A page answered with what it holds and a link (no data lookup in basic mode). */
export type PageTopic = { label: string; href: string; about: string; keywords: RegExp; can: (a: Access) => boolean };

export const STAFF_DATA_TOPICS: DataTopic[] = [
  { key: 'day', title: 'Your day', can: () => true, examples: () => ['What should I do today?', 'Which of my tasks are overdue?', 'What is due this week?', 'Anything blocked?'] },
  { key: 'attendance', title: 'Attendance', can: () => true, examples: () => ['Did I check in today?', 'Was I late?', 'Is today a holiday?'] },
  { key: 'leave', title: 'Leave', can: (a) => !a.founder, examples: () => ['How many leaves do I have left?', 'Is my leave approved?', 'When is the next holiday?'] },
  { key: 'eod', title: 'End-of-day report', can: (a) => !a.founder || a.leadsPeople, examples: (_, a) => [...(a.founder ? [] : ['Have I filed my EOD?']), ...(a.leadsPeople ? ['How many of my team filed theirs?'] : [])] },
  { key: 'qc', title: 'QC', can: () => true, examples: (_, a) => ['What did QC send back?', ...(a.canQc ? ['What is waiting for my QC check?'] : []), 'What is ready to send to the client?'] },
  { key: 'delivery', title: 'Delivery', can: () => true, examples: () => ['Which deliverables are at risk?'] },
  { key: 'goals', title: 'Goals', can: () => true, examples: () => ['List my goals', 'Which goals are behind?'] },
  { key: 'meetings', title: 'Meetings', can: () => true, examples: () => ['What meetings do I have coming up?'] },
  { key: 'timesheet', title: 'Timesheet', can: () => true, examples: () => ['How many hours have I logged this week?', 'Is my timesheet submitted?'] },
  { key: 'expenses', title: 'Expenses', can: () => true, examples: () => ['What is the status of my expenses?'] },
  { key: 'approvals', title: 'Approvals', can: () => true, examples: () => ['Do I have approvals waiting?'] },
  { key: 'performance', title: 'My performance', can: () => true, examples: () => ['How am I performing this month?'] },
  {
    key: 'clients',
    title: 'Clients',
    can: (a) => a.clientTeam || a.manager,
    examples: (n) => ['List my clients', 'Which clients need attention?', ...(n.client ? [`Tell me about ${n.client}`] : [])],
  },
  { key: 'money', title: 'Money', can: (a) => a.money, examples: (n) => [n.client ? `How much is overdue from ${n.client}?` : 'How much is overdue?', 'Unpaid invoices'] },
  { key: 'leads', title: 'Sales', can: (a) => a.hasLeads, examples: () => ['Show open leads', 'Which follow-ups are due?', 'Any proposals pending?'] },
  { key: 'requests', title: 'Requests', can: (a) => a.clientTeam, examples: () => ['Show open requests', 'Which replies are overdue?'] },
  { key: 'sales', title: 'Target', can: (a) => a.money, examples: () => ['How are we doing against target?'] },
  { key: 'team', title: 'Team', can: (a) => a.teamReader, examples: (n) => [...(n.colleague ? [`What is ${n.colleague} working on?`] : []), 'Team performance and workload'] },
  { key: 'summary', title: 'Summary', can: () => true, examples: () => ['Summary of the week'] },
];

const all = () => true;
export const STAFF_PAGES: PageTopic[] = [
  { label: 'Documents', href: '/team/docs', about: 'Shared documents and notes', keywords: /\b(documents?|docs)\b/, can: all },
  { label: 'Files', href: '/team/files', about: 'Client and team files by folder (from client, working, final, brand)', keywords: /\b(files|shared files|uploaded files|final files)\b/, can: all },
  { label: 'Asset library', href: '/team/assets', about: 'Approved creative assets with versions and usage rights', keywords: /\b(assets?|asset library)\b/, can: all },
  { label: 'Brand kits', href: '/team/brand-kits', about: "Each client's colours, fonts, logos, tone of voice, do's and don'ts", keywords: /\b(brand ?kits?|brand guidelines?|logos?|fonts?|colou?rs|tone of voice)\b/, can: all },
  { label: 'Discussions', href: '/team/discussions', about: 'Project and internal discussions', keywords: /\b(discussions?|threads?|chats?)\b/, can: all },
  { label: 'Content calendar', href: '/team/content-calendar', about: 'Posts planned, scheduled and published for each client', keywords: /\b(content calendar|posting|scheduled posts?|publish(ing|ed)?)\b/, can: all },
  { label: 'Calendar', href: '/team/calendar', about: 'Your deadlines, meetings, leave and holidays on one calendar', keywords: /\b(calendar|schedule|agenda)\b/, can: all },
  { label: 'Capacity', href: '/team/capacity', about: 'Who has room for more work in the coming weeks', keywords: /\b(capacity|who has (room|time)|availability)\b/, can: all },
  { label: 'Workload', href: '/team/workload', about: 'Hours planned against hours available, per person and week', keywords: /\b(workload|work ?load)\b/, can: all },
  { label: 'SOP library', href: '/team/sops', about: 'How we do things: standard operating procedures to read and acknowledge', keywords: /\b(sops?|standard operating|procedures?|process(es)?|policy|policies)\b/, can: all },
  { label: 'Projects', href: '/team/projects', about: 'Projects and retainers with their milestones (G1–G5) and progress', keywords: /\b(projects?|retainers?|gates?)\b/, can: all },
  { label: 'Review Studio', href: '/team/reviews', about: 'Drafts and versions with comments, QC and client approval', keywords: /\b(review studio|drafts?|versions?|proofs?)\b/, can: all },
  { label: 'My onboarding', href: '/team/onboarding', about: 'Your joining checklist', keywords: /\b(my onboarding|induction|joining)\b/, can: all },
  { label: 'HR issues', href: '/team/hr-issues', about: 'Raise a concern with HR confidentially and follow it', keywords: /\b(hr|grievance|raise an issue|harass\w*)\b/, can: all },
  { label: 'Agent Inbox', href: '/team/agent-inbox', about: 'Suggestions from the AI agents waiting for your decision', keywords: /\b(agent inbox|agents?|agent proposals?)\b/, can: all },
  { label: 'Tasks', href: '/team/tasks', about: 'All your tasks, by status and deadline', keywords: /\b(task list|all (my )?tasks)\b/, can: all },
  { label: 'Daily reports', href: '/team/reports', about: "End-of-day reports from the people who report to you", keywords: /\b(daily reports?|team reports?)\b/, can: (a) => a.leadsPeople },
  { label: 'Client 360', href: '/team/clients', about: 'Everything about each client in one page', keywords: /\b(client 360)\b/, can: (a) => a.clientTeam },
  { label: 'Messages', href: '/team/messages', about: 'Chats with clients', keywords: /\b(messages?|client chats?)\b/, can: (a) => a.clientChat },
  { label: 'Inbox', href: '/team/inbox', about: 'Email and WhatsApp conversations with leads and clients', keywords: /\b(inbox|emails?|whatsapp)\b/, can: (a) => a.clientChat || a.hasLeads },
  { label: 'Invoices', href: '/team/invoices', about: 'Invoices for your clients: create, sign and send', keywords: /\b(invoices?)\b/, can: (a) => a.cmInvoices },
  { label: 'Quotations', href: '/team/quotes', about: 'Quotations sent to clients and their status', keywords: /\b(quotations?|quotes?)\b/, can: (a) => a.clientTeam },
  { label: 'Renewals', href: '/team/renewals', about: 'Retainers coming up for renewal', keywords: /\b(renewals?|renew(ing)?)\b/, can: (a) => a.allLeads },
  { label: 'Creators', href: '/team/creators', about: 'Influencers and creators, their briefs and ratings', keywords: /\b(creators?|influencers?)\b/, can: (a) => a.clientTeam || a.manager },
  { label: 'Specialists', href: '/team/specialists', about: 'Specialists by job role and their current load', keywords: /\b(specialists?)\b/, can: (a) => a.teamReader },
  { label: 'Discount approvals', href: '/team/approvals', about: 'Discounts on proposals waiting for a decision', keywords: /\b(discounts?)\b/, can: (a) => a.money || a.hasLeads },
];

export const CLIENT_DATA_TOPICS: { key: string; title: string; can: (canBill: boolean) => boolean; examples: string[] }[] = [
  { key: 'overview', title: 'Your services', can: () => true, examples: ['How is my project going?', 'Which milestone are we at?'] },
  { key: 'approvals', title: 'Approvals', can: () => true, examples: ['What is waiting for my approval?'] },
  { key: 'plans', title: 'Plans', can: () => true, examples: ['Is my monthly plan ready?'] },
  { key: 'requirements', title: 'Onboarding', can: () => true, examples: ['What do you still need from me?'] },
  { key: 'requests', title: 'Requests', can: () => true, examples: ['What is the status of my requests?'] },
  { key: 'money', title: 'Billing', can: (b) => b, examples: ['Do I have any invoices due?', 'What have I paid?'] },
  { key: 'meetings', title: 'Meetings', can: () => true, examples: ['Do I have a meeting coming up?'] },
  { key: 'contact', title: 'Your Client Manager', can: () => true, examples: ['Who is my client manager and how do I reach them?'] },
];

export const CLIENT_PAGES: (Omit<PageTopic, 'can'> & { can: (canBill: boolean) => boolean })[] = [
  { label: 'Project journey', href: '/client/journey', about: 'Every step of your project from start to handover', keywords: /\b(journey|timeline|steps?)\b/, can: all },
  { label: 'Progress', href: '/client/progress', about: 'How far each service has come', keywords: /\b(progress|how far)\b/, can: all },
  { label: 'Content calendar', href: '/client/calendar', about: 'Posts planned and published for you', keywords: /\b(content calendar|posting|scheduled posts?|published)\b/, can: all },
  { label: 'Files', href: '/client/files', about: 'Files you sent us and files released to you', keywords: /\b(files?|download)\b/, can: all },
  { label: 'Asset library', href: '/client/assets', about: 'Your approved creatives, ready to use', keywords: /\b(asset library|assets)\b/, can: all },
  { label: 'Brand kit', href: '/client/brand-kit', about: 'Your colours, fonts, logos and tone of voice', keywords: /\b(brand ?kit|logos?|fonts?|colou?rs|guidelines)\b/, can: all },
  { label: 'Quotations', href: '/client/quotes', about: 'Quotations from BMU to accept', keywords: /\b(quotations?|quotes?|estimate)\b/, can: (b) => b },
  { label: 'Reports', href: '/client/reports', about: 'Monthly reports on your results', keywords: /\b(reports?|results|analytics)\b/, can: all },
  { label: 'Insights', href: '/client/insights', about: 'Turnaround, revisions and spend over time', keywords: /\b(insights?|turnaround|revisions used)\b/, can: all },
  { label: 'Messages', href: '/client/messages', about: 'Chat with your BMU team', keywords: /\b(messages?|chat)\b/, can: all },
  { label: 'Documents', href: '/client/docs', about: 'Shared documents', keywords: /\b(documents?|docs|contract|agreement)\b/, can: all },
  { label: 'Account and services', href: '/client/settings', about: 'Your company details and services', keywords: /\b(settings|company details|gstin)\b/, can: all },
  { label: 'Team users', href: '/client/team', about: 'People from your company who use BMU Hub', keywords: /\b(team users?|add (a )?user|my team|colleagues?)\b/, can: all },
  { label: 'Profile & notifications', href: '/client/profile', about: 'Your profile and notification settings', keywords: /\b(profile|notifications?|password)\b/, can: all },
];

/** The four starter questions in the Ask BMU panel: only about what this person's dashboard has. */
export function starterQuestions(me: Me): string[] {
  if (me.type === 'client') return clientCanBill(me) ? ['What is waiting for my approval?', 'Do I have any invoices due?', 'What do you still need from me?', 'What is the status of my requests?'] : ['What is waiting for my approval?', 'What do you still need from me?', 'What is the status of my requests?', 'Who is my client manager?'];
  const a = staffAccess(me);
  const role = a.money ? 'How much is overdue?' : a.hasLeads ? 'Which follow-ups are due?' : a.clientTeam || a.manager ? 'Which clients need attention?' : 'Did I check in today?';
  return ['What should I do today?', role, 'List my goals', 'Summary of the week'];
}

/** Help list: only what this person has. */
/** `tabs`: labels of the page skills this person has (ai/pages), asked about with their own data. */
export function staffHelpFor(me: Me, names: Names, tabs: string[] = []) {
  const a = staffAccess(me);
  const lines = STAFF_DATA_TOPICS.filter((t) => t.can(a))
    .map((t) => ({ t, ex: t.examples(names, a) }))
    .filter((x) => x.ex.length)
    .map((x) => `- **${x.t.title}:** ${x.ex.join(' · ')}`);
  const pages = [...new Set([...tabs, ...STAFF_PAGES.filter((p) => p.can(a)).map((p) => p.label)])];
  return `In basic mode I can answer questions about what is on your dashboard:\n${lines.join('\n')}\n\nYou can also ask about these tabs: ${pages.join(', ')}.`;
}

export function clientHelpFor(me: Me, tabs: string[] = []) {
  const b = clientCanBill(me);
  const lines = CLIENT_DATA_TOPICS.filter((t) => t.can(b)).map((t) => `- **${t.title}:** ${t.examples.join(' · ')}`);
  const pages = [...new Set([...tabs, ...CLIENT_PAGES.filter((p) => p.can(b)).map((p) => p.label)])];
  return `I can help with your account. Try asking:\n${lines.join('\n')}\n\nYou can also ask about these tabs: ${pages.join(', ')}.`;
}

/** A page this person has that the question is about, or one they don't have (to say so plainly). */
export function staffPageFor(me: Me, q: string) {
  const a = staffAccess(me);
  const hit = STAFF_PAGES.filter((p) => p.keywords.test(q));
  return { mine: hit.find((p) => p.can(a)), notMine: hit.find((p) => !p.can(a)) };
}
export function clientPageFor(me: Me, q: string) {
  const b = clientCanBill(me);
  const hit = CLIENT_PAGES.filter((p) => p.keywords.test(q));
  return { mine: hit.find((p) => p.can(b)), notMine: hit.find((p) => !p.can(b)) };
}
export const pageAnswer = (p: { label: string; href: string; about: string }) => `That is on [${p.label}](${p.href}): ${p.about.charAt(0).toLowerCase()}${p.about.slice(1)}.`;
