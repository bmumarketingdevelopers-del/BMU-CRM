// Ask BMU page skills: see ./types.ts for the contract and ./access.ts for who sees each tab.
// Client portal tabs (apps/web/src/app/(client)/client/*). Every lookup goes through the same service the page's
// API route uses, so it is scoped to the asking user's own company (me.clientOrg) and only returns what the page
// shows a client: no internal journey steps, no internal messages, only released/client-visible files and assets.
import { ForbiddenException } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { clientRoleLabels, deliverChannelLabels, docKindLabels, formatINR, milestoneStatusLabels, quoteStatusLabels, type ClientTeamRole, type DeliverChannel, type DocKind, type Me, type MilestoneStatus, type QuoteStatus } from '@bmu/shared';
import { ClientAccountController } from '../../clients-actions/clients-actions.controller.js';
import { DocsService } from '../../comms/docs.service.js';
import { AssetsService } from '../../creative/assets.service.js';
import { CreativeService } from '../../creative/creative.service.js';
import { DeliverCalendarService } from '../../deliver/deliver-calendar.service.js';
import { ProjectFlowService } from '../../deliver/project-flow.service.js';
import { JourneyService } from '../../flows/journey.service.js';
import { IntegrationsService } from '../../integrations/integrations.service.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { OpsSelfService } from '../../ops-analytics/self.service.js';
import { QuotesService } from '../../quotes/quotes.service.js';
import { DeliveryService } from '../../requests/delivery.service.js';
import { MessagesService } from '../../requests/messages.service.js';
import { ClientWorkspaceService } from '../../workspace/client-workspace.service.js';
import { redact } from '../ai-safety.js';
import { client } from './access.js';
import { bullets, day, dayShort, link, plural, svc, type PageSkill } from './types.js';

type Def<T> = Omit<PageSkill, 'load' | 'answer' | 'surface'> & { load: (ref: ModuleRef, me: Me) => Promise<T>; answer: (d: T, q: string) => string };
const skill = <T>(s: Def<T>): PageSkill => ({ ...s, surface: 'client' }) as unknown as PageSkill;
const words = (s: string | null | undefined) => (s ?? '').replaceAll('_', ' ');
const short = (s: string | null | undefined, n = 160) => redact(s).replace(/\s+/g, ' ').trim().slice(0, n);
const num = (n: number) => new Intl.NumberFormat('en-IN').format(n);

// ------------------------------------------------------------------------------------------------ data shapes

export type JourneyData = {
  services: { service: string; status: string; milestone: string; summary: string; gates: { name: string; done: string | null; expected: string | null }[]; current: string | null; late: string[]; next: { step: string; expected: string | null }[] }[];
};
export type ProgressData = {
  projects: { service: string; finishDates: { department: string; finishBy: string | null; note: string }[]; parts: { title: string; status: string; sharedOn: string | null; waitingOnYou: boolean }[] }[];
};
export type CalendarData = {
  upcoming: { title: string; type: string; channel: string | null; when: string | null }[];
  published: { title: string; type: string; channel: string | null; when: string | null }[];
};
export type FilesData = {
  files: { name: string; deliverable: string; service: string; version: number; released: boolean; viewOnly: boolean }[];
  total: number;
  released: number;
  services: { service: string; filesReleased: boolean; signedOff: string | null; allApproved: boolean; canSignOff: boolean }[];
};
export type AssetsData = { total: number; items: { title: string; kind: string; collection: string | null; updated: string | null; viewOnly: boolean }[]; collections: { name: string; count: number }[] };
export type BrandKitData = { colours: string[]; fonts: string[]; tone: string | null; dos: string[]; donts: string[]; notes: string | null; files: { name: string; kind: string; added: string | null }[]; updated: string | null };
export type QuotesData = { quotes: { number: string; title: string; status: string; statusKey: string; total: string; date: string | null; validUntil: string | null; link: string }[] };
export type ReportData = {
  month: string;
  approved: number;
  draftsReviewed: number;
  avgApproval: string | null;
  requestsOpened: number;
  requestsResolved: number;
  onTimeReplies: string | null;
  approvedItems: { title: string; service: string; on: string | null }[];
  services: { service: string; status: string; approved: number; total: number }[];
  spend: { invoiced: string; paid: string } | null;
};
export type InsightsData = {
  period: string;
  approved: number | null;
  approvedBefore: number | null;
  firstReplyHours: number | null;
  draftToApprovalDays: number | null;
  onTimePct: number | null;
  revisions: { used: number; allowance: number; overAllowance: number };
  spendTotal: string | null;
  notes: string[];
  ads: { hasData: boolean; spend: string; clicks: number; conversions: number; sessions: number; topCampaigns: { campaign: string; clicks: number; conversions: number }[] };
};
export type MessagesData = { chats: { with: string; unread: number; last: { from: string; text: string; at: string | null } | null; link: string }[]; unread: number };
export type DocsData = { docs: { title: string; kind: string; service: string | null; updated: string | null; link: string }[] };
export type SettingsData = {
  company: string;
  readOnlyUntil: string | null;
  contact: { name: string | null; phone: string | null; email: string | null };
  brands: string[];
  services: { service: string; tier: string; billing: string; status: string }[];
  serviceQuotesOpen: number;
  pendingInvites: number;
  offboarding: boolean;
};
export type TeamData = { canManage: boolean; members: { name: string; role: string; status: string; isMe: boolean }[] };
export type ProfileData = { name: string; email: string | null; phone: string | null; company: string | null; role: string | null; unread: number; notifications: { title: string; body: string; at: string | null; read: boolean; link: string | null }[] };

const hours = (h: number | null) => (h === null ? null : h < 24 ? `${Math.round(h)} hours` : `${Math.round((h / 24) * 10) / 10} days`);
const channel = (c: string | null) => (c ? (deliverChannelLabels[c as DeliverChannel] ?? words(c)) : null);
const roleName = (r: string | null | undefined) => (r ? (clientRoleLabels[r as ClientTeamRole]?.name ?? words(r.replace(/^client_/, ''))) : null);

// ------------------------------------------------------------------------------------------------ skills

export const SKILLS: PageSkill[] = [
  skill<JourneyData>({
    name: 'page_client_journey',
    label: 'Project journey',
    href: '/client/journey',
    can: client.everyone,
    keywords: /\b(project journey|journey|timeline|next step|which step|what step|milestones? (done|passed|left|reached))\b/,
    examples: ['Show my project journey', 'What is the timeline of my project?'],
    description: 'Each service of the company with its five milestones (done dates, expected dates), the current step, late steps and the next steps. Client-safe steps only.',
    load: async (ref, me) => {
      const j = svc(ref, JourneyService);
      const options = await j.options(me);
      const open = options.filter((o) => !['delivered', 'closed'].includes(o.status));
      const pick = [...open, ...options.filter((o) => !open.includes(o))].slice(0, 4);
      const services = await Promise.all(
        pick.map(async (o) => {
          const v = await j.journey(me, o.id);
          const events = v.events.filter((e) => !e.internal);
          const current = events.find((e) => e.state === 'current');
          return {
            service: o.serviceName,
            status: words(o.status),
            milestone: `${o.currentGate.replace(/^G/, '')} of 5`,
            summary: short(v.summary, 240),
            gates: v.gates.map((g) => ({ name: g.name, done: day(g.passedAt), expected: g.passedAt ? null : day(g.plannedAt) })),
            current: current ? short(current.title, 120) : null,
            late: events.filter((e) => e.timing === 'late' && !e.at).map((e) => `${short(e.title, 100)} (${plural(Math.abs(e.varianceDays ?? 0), 'day')} overdue)`).slice(0, 5),
            next: events.filter((e) => e.state === 'upcoming').slice(0, 3).map((e) => ({ step: short(e.title, 100), expected: day(e.plannedAt) })),
          };
        }),
      );
      return { services };
    },
    answer: (d) => {
      if (!d.services.length) return `Your project journey appears here once your first service starts. See ${link('Project journey', '/client/journey')}.`;
      const parts = d.services.map((s) => {
        const lines = [
          `**${s.service}**: milestone ${s.milestone}${s.status === 'delivered' || s.status === 'closed' ? ` (${s.status})` : ''}.${s.summary ? ` ${s.summary}` : ''}`,
          ...s.gates.map((g) => `- ${g.name}: ${g.done ? `done ${g.done}` : g.expected ? `expected ${g.expected}` : 'not started yet'}`),
        ];
        if (s.current) lines.push(`Now: ${s.current}.`);
        if (s.late.length) lines.push(`Running late: ${s.late.join('; ')}.`);
        if (s.next.length) lines.push(`Coming up: ${s.next.map((n) => `${n.step}${n.expected ? ` (around ${n.expected})` : ''}`).join('; ')}.`);
        return lines.join('\n');
      });
      return `Here is where your project stands:\n\n${parts.join('\n\n')}\n\nSee every step in ${link('Project journey', '/client/journey')}.`;
    },
  }),

  skill<ProgressData>({
    name: 'page_client_progress',
    label: 'Progress',
    href: '/client/progress',
    can: client.everyone,
    keywords: /\b(progress|how far|finish dates?|finished by|when will (it|my|the|our)\b.*\b(be )?(done|finished|ready|complete)|finished parts?)\b/,
    examples: ['Show my progress', 'When will my project be finished?'],
    description: 'Finish dates the departments shared for each service, and finished parts shared to look at (with their status and whether the client still has to decide).',
    load: async (ref, me) => {
      const v = await svc(ref, ProjectFlowService).clientProgress(me);
      return {
        projects: v.projects.map((p) => ({
          service: p.service,
          finishDates: p.estimates.map((e) => ({ department: e.department, finishBy: day(e.finishBy), note: short(e.note, 160) })),
          parts: p.milestones.slice(0, 10).map((m) => ({ title: short(m.title, 120), status: milestoneStatusLabels[m.status as MilestoneStatus] ?? words(m.status), sharedOn: day(m.sharedAt), waitingOnYou: m.canDecide && m.status === 'shared' })),
        })),
      };
    },
    answer: (d) => {
      const projects = d.projects.filter((p) => p.finishDates.length || p.parts.length);
      if (!projects.length) return `No finish dates or finished parts have been shared with you yet. Your team adds them as the work moves along. See ${link('Progress', '/client/progress')}.`;
      const waiting = projects.reduce((n, p) => n + p.parts.filter((x) => x.waitingOnYou).length, 0);
      const parts = projects.map((p) => {
        const lines = [`**${p.service}**`];
        if (p.finishDates.length) lines.push(bullets(p.finishDates.map((f) => `${f.department}: finish by ${f.finishBy ?? 'date to be confirmed'}${f.note ? ` (${f.note})` : ''}`)));
        if (p.parts.length) lines.push(`Finished parts:\n${bullets(p.parts.map((x) => `${x.title}: ${x.waitingOnYou ? 'ready for you to look at' : x.status.toLowerCase()}${x.sharedOn ? `, shared ${x.sharedOn}` : ''}`))}`);
        return lines.join('\n');
      });
      return `${waiting ? `${plural(waiting, 'finished part is', 'finished parts are')} ready for you to look at.\n\n` : ''}${parts.join('\n\n')}\n\nSee ${link('Progress', '/client/progress')}.`;
    },
  }),

  skill<CalendarData>({
    name: 'page_client_calendar',
    label: 'Content calendar',
    href: '/client/calendar',
    can: client.everyone,
    keywords: /\b(calendar|go(es|ing)? live|went live|publish(ed|ing)?|scheduled|coming out|going out)\b/,
    examples: ['What is on my calendar this month?', 'What goes live next week?'],
    description: 'Approved social work scheduled to go out (next two months) and what was published in the last month, with channel and date.',
    load: async (ref, me) => {
      const v = await svc(ref, DeliverCalendarService).client(me);
      const now = Date.now();
      const row = (i: (typeof v.items)[number], at: string | null) => ({ title: short(i.title, 120), type: words(i.type), channel: channel(i.channel), when: day(at) });
      return {
        upcoming: v.items.filter((i) => !i.publishedAt && i.scheduledAt && new Date(i.scheduledAt).getTime() >= now).slice(0, 15).map((i) => row(i, i.scheduledAt)),
        published: v.items.filter((i) => i.publishedAt).sort((a, b) => b.publishedAt!.localeCompare(a.publishedAt!)).slice(0, 10).map((i) => row(i, i.publishedAt)),
      };
    },
    answer: (d) => {
      if (!d.upcoming.length && !d.published.length) return `Nothing is on your calendar right now. Approved work appears here once it has a date. See ${link('Content calendar', '/client/calendar')}.`;
      const line = (r: CalendarData['upcoming'][number]) => `${r.when ?? 'date to be set'}: ${r.title} (${[r.type, r.channel].filter(Boolean).join(', ')})`;
      const parts = [
        d.upcoming.length ? `Going out next (${d.upcoming.length}):\n${bullets(d.upcoming.map(line))}` : 'Nothing is scheduled to go out in the next two months yet.',
        d.published.length ? `Already live (last month):\n${bullets(d.published.map(line), 5)}` : '',
      ].filter(Boolean);
      return `${parts.join('\n\n')}\n\nOpen any of them from ${link('Content calendar', '/client/calendar')}.`;
    },
  }),

  skill<BrandKitData>({
    name: 'page_client_brand_kit',
    label: 'Brand kit',
    href: '/client/brand-kit',
    can: client.everyone,
    keywords: /\b(brand ?kit|logos?|fonts?|typefaces?|colou?rs|palette|tone of voice|brand guidelines|guidelines|dos and don'?ts)\b/,
    examples: ['What fonts are in my brand kit?', 'What are our brand colours?'],
    description: 'The company’s brand kit: colours, fonts, tone of voice, dos and don’ts, notes and brand files.',
    load: async (ref, me) => {
      const k = await svc(ref, CreativeService).clientBrandKit(me);
      return {
        colours: k.colours.slice(0, 12),
        fonts: k.fonts.slice(0, 8),
        tone: k.tone ? short(k.tone, 200) : null,
        dos: (k.dos ?? []).slice(0, 6).map((x) => short(x, 120)),
        donts: (k.donts ?? []).slice(0, 6).map((x) => short(x, 120)),
        notes: k.notes ? short(k.notes, 240) : null,
        files: k.files.slice(0, 10).map((f) => ({ name: short(f.name, 80), kind: words(f.kind), added: day(f.at) })),
        updated: day(k.updatedAt),
      };
    },
    answer: (d) => {
      const lines = [
        d.colours.length ? `**Colours:** ${d.colours.join(', ')}` : '',
        d.fonts.length ? `**Fonts:** ${d.fonts.join(', ')}` : '',
        d.tone ? `**Tone of voice:** ${d.tone}` : '',
        d.dos.length ? `**Do:** ${d.dos.join('; ')}` : '',
        d.donts.length ? `**Don't:** ${d.donts.join('; ')}` : '',
        d.notes ? `**Notes:** ${d.notes}` : '',
        d.files.length ? `**Brand files (${d.files.length}):**\n${bullets(d.files.map((f) => `${f.name}${f.kind ? ` (${f.kind})` : ''}`), 6)}` : '',
      ].filter(Boolean);
      if (!lines.length) return `Your brand kit is still empty. You can add your logo and brand files on ${link('Brand kit', '/client/brand-kit')}, and your client manager will fill in the rest.`;
      return `Your brand kit${d.updated ? ` (last updated ${d.updated})` : ''}:\n${lines.join('\n')}\n\nSee it all on ${link('Brand kit', '/client/brand-kit')}.`;
    },
  }),

  skill<AssetsData>({
    name: 'page_client_assets',
    label: 'Asset library',
    href: '/client/assets',
    can: client.everyone,
    keywords: /\b(asset library|assets?|library|ready to use)\b/,
    examples: ['What is in my asset library?', 'How many assets do I have?'],
    description: 'Approved work BMU has put in the client’s asset library (client-visible assets only): count, latest items and collections.',
    load: async (ref, me) => {
      const v = await svc(ref, AssetsService).clientList(me, {});
      return {
        total: v.total,
        items: v.items.slice(0, 10).map((a) => ({ title: short(a.title, 120), kind: words(a.kind), collection: a.collection?.name ?? null, updated: day(a.updatedAt), viewOnly: !!a.preview })),
        collections: v.collections.slice(0, 8).map((c) => ({ name: c.name, count: c.count })),
      };
    },
    answer: (d) => {
      if (!d.total) return `Your asset library is empty for now. Approved work is added here, ready to use. See ${link('Asset library', '/client/assets')}.`;
      const viewOnly = d.items.some((i) => i.viewOnly) ? '\nSome items are view only until the final payment of the project.' : '';
      return `You have ${plural(d.total, 'asset')} in your library.${d.collections.length ? ` Collections: ${d.collections.map((c) => `${c.name} (${c.count})`).join(', ')}.` : ''}\nLatest:\n${bullets(d.items.map((i) => `${i.title} (${i.kind}${i.collection ? `, ${i.collection}` : ''})${i.updated ? `, ${i.updated}` : ''}`))}${viewOnly}\n\nBrowse and download from ${link('Asset library', '/client/assets')}.`;
    },
  }),

  skill<FilesData>({
    name: 'page_client_files',
    label: 'Files',
    href: '/client/files',
    can: client.everyone,
    keywords: /\b(files?|downloads?|downloadable|final handover)\b/,
    examples: ['Which files can I download?', 'Show my files'],
    description: 'Files shared with the client (with whether each is released for download or view only) and, per service, whether the final files are released and signed off.',
    load: async (ref, me) => {
      const d = svc(ref, DeliveryService);
      const [files, delivery] = await Promise.all([d.clientFiles(me), d.clientDelivery(me)]);
      return {
        files: files.slice(0, 10).map((f) => ({ name: short(f.name, 100), deliverable: short(f.deliverable, 100), service: f.serviceName, version: f.version, released: f.released && !f.preview, viewOnly: !f.released || !!f.preview })),
        total: files.length,
        released: files.filter((f) => f.released && !f.preview).length,
        services: delivery.map((s) => ({ service: s.serviceName, filesReleased: s.filesReleased, signedOff: day(s.signedOffAt), allApproved: s.allApproved, canSignOff: s.can.signOff })),
      };
    },
    answer: (d) => {
      if (!d.total) return `No files have been shared with you yet. They appear here as soon as your team sends them. See ${link('Files', '/client/files')}.`;
      const service = d.services
        .map((s) => (s.signedOff ? `${s.service}: signed off ${s.signedOff}${s.filesReleased ? ', final files released' : ''}` : s.canSignOff ? `${s.service}: all work is approved, you can sign off to get the final files` : s.filesReleased ? `${s.service}: final files released` : null))
        .filter((x): x is string => !!x);
      return `${plural(d.total, 'file')} shared with you, ${d.released} ready to download.\n${bullets(d.files.map((f) => `${f.name} (${f.deliverable}, v${f.version}, ${f.service})${f.viewOnly ? ': view only for now' : ''}`))}${service.length ? `\n\n${bullets(service)}` : ''}\n\nDownload them from ${link('Files', '/client/files')}.`;
    },
  }),

  skill<QuotesData>({
    name: 'page_client_quotes',
    label: 'Quotations',
    href: '/client/quotes',
    can: client.canBill,
    keywords: /\b(quotations?|quotes?|estimates?)\b/,
    examples: ['Do I have any quotations to accept?', 'Show my quotes'],
    description: 'Quotations BMU sent the company (sent, accepted, declined) with total, date and valid-until date.',
    load: async (ref, me) => {
      if (!client.canBill(me)) throw new ForbiddenException('Your user role cannot see quotations');
      const rows = await svc(ref, QuotesService).mine(me);
      return {
        quotes: rows.slice(0, 15).map((q) => ({
          number: q.number,
          title: short(q.title, 120),
          status: quoteStatusLabels[q.status as QuoteStatus]?.client ?? words(q.status),
          statusKey: q.status,
          total: formatINR(q.totalPaise),
          date: day(q.date),
          validUntil: day(q.validUntil),
          link: `/client/quotes/${q.id}`,
        })),
      };
    },
    answer: (d) => {
      if (!d.quotes.length) return `You have no quotations from BMU yet. See ${link('Quotations', '/client/quotes')}.`;
      const open = d.quotes.filter((q) => q.statusKey === 'sent');
      return `${open.length ? `${plural(open.length, 'quotation is', 'quotations are')} waiting for your answer.` : 'No quotation is waiting for your answer.'}\n${bullets(d.quotes.map((q) => `${link(`${q.number}: ${q.title}`, q.link)}: ${q.total}, ${q.status.toLowerCase()}${q.statusKey === 'sent' && q.validUntil ? `, valid until ${q.validUntil}` : ''}`))}\n\nSee ${link('Quotations', '/client/quotes')}.`;
    },
  }),

  skill<InsightsData>({
    name: 'page_client_insights',
    label: 'Insights',
    href: '/client/insights',
    can: client.everyone,
    keywords: /\b(insights?|turnaround|how fast|how quickly|reply times?|response times?|on time|ad results|ads?|campaigns?|clicks|conversions|website visits|sessions)\b/,
    examples: ['Show my insights', 'How are my ad campaigns doing?'],
    description: 'The last 90 days: work approved (vs the period before), first reply time, draft-to-approval time, on-time share, change rounds used against the allowance, spend (only for users who may see billing), plus ads and website results for the last 30 days.',
    load: async (ref, me) => {
      const [v, ads] = await Promise.all([svc(ref, OpsSelfService).client(me, {}), svc(ref, IntegrationsService).clientResults(me)]);
      return {
        period: `${day(v.range.from)} to ${day(v.range.to)}`,
        approved: v.totals.approved.value,
        approvedBefore: v.totals.approved.prev,
        firstReplyHours: v.totals.firstReplyHours.value,
        draftToApprovalDays: v.totals.draftToApprovalDays.value,
        onTimePct: v.totals.onTimePct.value,
        revisions: v.revisions,
        spendTotal: v.canSeeMoney && v.spendTotalPaise !== null ? formatINR(v.spendTotalPaise) : null,
        notes: v.insights.slice(0, 4).map((i) => short(i.text, 200)),
        ads: {
          hasData: ads.hasData,
          spend: formatINR(ads.totals.spendPaise),
          clicks: ads.totals.clicks,
          conversions: ads.totals.conversions,
          sessions: ads.totals.sessions,
          topCampaigns: [...ads.campaigns].sort((a, b) => b.clicks - a.clicks).slice(0, 3).map((c) => ({ campaign: short(c.campaign, 80), clicks: c.clicks, conversions: c.conversions })),
        },
      };
    },
    answer: (d) => {
      const lines = [
        d.approved !== null ? `- Work approved: ${d.approved}${d.approvedBefore !== null ? ` (${d.approvedBefore} the period before)` : ''}` : '',
        d.firstReplyHours !== null ? `- First reply to you: about ${hours(d.firstReplyHours)}` : '',
        d.draftToApprovalDays !== null ? `- Draft to approval: about ${hours(d.draftToApprovalDays * 24)}` : '',
        d.onTimePct !== null ? `- Delivered on time: ${d.onTimePct}%` : '',
        d.revisions.allowance || d.revisions.used ? `- Change rounds used: ${d.revisions.used} of ${d.revisions.allowance} included${d.revisions.overAllowance ? ` (${d.revisions.overAllowance} over)` : ''}` : '',
        d.spendTotal ? `- Spend: ${d.spendTotal}` : '',
      ].filter(Boolean);
      const ads = d.ads.hasData
        ? `\n\nAds and website (last 30 days): ${num(d.ads.clicks)} clicks, ${num(d.ads.conversions)} conversions, ${num(d.ads.sessions)} website visits, ad spend ${d.ads.spend}.${d.ads.topCampaigns.length ? `\n${bullets(d.ads.topCampaigns.map((c) => `${c.campaign}: ${num(c.clicks)} clicks, ${num(c.conversions)} conversions`))}` : ''}`
        : '';
      if (!lines.length && !ads) return `There is not enough activity yet to show insights. They fill in as work is shared and approved. See ${link('Insights', '/client/insights')}.`;
      return `Your insights for ${d.period}:\n${lines.join('\n')}${d.notes.length ? `\n\n${d.notes.join(' ')}` : ''}${ads}\n\nSee the charts on ${link('Insights', '/client/insights')}.`;
    },
  }),

  skill<ReportData>({
    name: 'page_client_reports',
    label: 'Reports',
    href: '/client/reports',
    can: client.everyone,
    keywords: /\b(reports?|monthly report|results|month in review|this month so far|summary of (the|this) month)\b/,
    examples: ['Show my monthly report', "What are this month's results?"],
    description: 'This month’s report: work approved, drafts reviewed, average time to approve, requests raised and resolved, first replies on time, service progress, and invoiced/paid (only for users who may see billing).',
    load: async (ref, me) => {
      const r = await svc(ref, ClientWorkspaceService).report(me, undefined);
      return {
        month: r.periodLabel,
        approved: r.stats.deliverablesApproved,
        draftsReviewed: r.stats.draftsReviewed,
        avgApproval: hours(r.stats.avgApprovalHours),
        requestsOpened: r.requests.opened,
        requestsResolved: r.requests.resolved,
        onTimeReplies: r.stats.onTimeFirstReplyPct === null ? null : `${r.stats.onTimeFirstReplyPct}%`,
        approvedItems: r.approved.slice(0, 10).map((a) => ({ title: short(a.title, 120), service: a.serviceName, on: dayShort(a.approvedAt) })),
        services: r.services.map((s) => ({ service: s.serviceName, status: words(s.status), approved: s.approved, total: s.total })),
        spend: r.spend ? { invoiced: formatINR(r.spend.invoicedPaise), paid: formatINR(r.spend.paidPaise) } : null,
      };
    },
    answer: (d) => {
      const quiet = !d.approved && !d.draftsReviewed && !d.requestsOpened && !d.requestsResolved;
      const head = quiet
        ? `It has been a quiet month so far for ${d.month}: nothing approved or raised yet.`
        : `Your report for ${d.month}:\n- Work approved: ${d.approved}\n- Drafts reviewed: ${d.draftsReviewed}${d.avgApproval ? `\n- Average time to approve: ${d.avgApproval}` : ''}\n- Requests: ${d.requestsOpened} raised, ${d.requestsResolved} resolved${d.onTimeReplies ? `\n- First replies on time: ${d.onTimeReplies}` : ''}${d.spend ? `\n- Invoiced ${d.spend.invoiced}, paid ${d.spend.paid}` : ''}`;
      const approved = d.approvedItems.length ? `\n\nApproved this month:\n${bullets(d.approvedItems.map((a) => `${a.title} (${a.service})${a.on ? `, ${a.on}` : ''}`), 6)}` : '';
      const services = d.services.length ? `\n\nServices:\n${bullets(d.services.map((s) => `${s.service}: ${s.approved} of ${s.total} approved, ${s.status}`))}` : '';
      return `${head}${approved}${services}\n\nSee earlier months and print it from ${link('Reports', '/client/reports')}.`;
    },
  }),

  skill<MessagesData>({
    name: 'page_client_messages',
    label: 'Messages',
    href: '/client/messages',
    can: client.everyone,
    keywords: /\b(messages?|messaged|chats?|unread|replied|wrote to me|last message)\b/,
    examples: ['Do I have any unread messages?', 'Show my chats'],
    description: 'The client’s chats with BMU (client manager, BMU Owner, other team members): unread count and the last message of each. Internal team notes are never included.',
    load: async (ref, me) => {
      const v = await svc(ref, MessagesService).clientChats(me);
      const row = (name: string, s: { unread: number; lastMessage: { body: string; author: string; at: string; mine: boolean } | null }) => ({
        with: name,
        unread: s.unread,
        last: s.lastMessage ? { from: s.lastMessage.mine ? 'you' : s.lastMessage.author || name, text: short(s.lastMessage.body, 140), at: day(s.lastMessage.at) } : null,
        link: '/client/messages',
      });
      const chats = [row(v.am.name ? `${v.am.name} (your client manager)` : 'Your client manager', v.am), ...(v.owner ? [row('BMU Owner', v.owner)] : []), ...v.staff.slice(0, 8).map((s) => row(s.title ? `${s.name} (${s.title})` : s.name, s))];
      return { chats, unread: chats.reduce((n, c) => n + c.unread, 0) };
    },
    answer: (d) => {
      const used = d.chats.filter((c) => c.last);
      if (!used.length) return `No messages yet. You can write to your client manager any time from ${link('Messages', '/client/messages')}.`;
      return `${d.unread ? `You have ${plural(d.unread, 'unread message')}.` : 'You are all caught up, no unread messages.'}\n${bullets(used.map((c) => `**${c.with}**${c.unread ? ` (${c.unread} unread)` : ''}: ${c.last!.from} wrote "${c.last!.text}"${c.last!.at ? ` on ${c.last!.at}` : ''}`))}\n\nReply from ${link('Messages', '/client/messages')}.`;
    },
  }),

  skill<DocsData>({
    name: 'page_client_docs',
    label: 'Documents',
    href: '/client/docs',
    can: client.everyone,
    keywords: /\b(documents?|docs|contracts?|agreements?|briefs?)\b/,
    examples: ['Which documents are shared with me?', 'Show my docs'],
    description: 'Documents BMU shared with the company (briefs, proposal drafts, notes), newest first, with when each was last updated.',
    load: async (ref, me) => {
      const rows = await svc(ref, DocsService).clientList(me);
      return { docs: rows.slice(0, 15).map((r) => ({ title: short(r.title, 120), kind: docKindLabels[r.kind as DocKind] ?? words(r.kind), service: r.engagement?.name ?? null, updated: day(r.updatedAt), link: `/client/docs/${r.id}` })) };
    },
    answer: (d) => {
      if (!d.docs.length) return `No documents have been shared with you yet. See ${link('Documents', '/client/docs')}.`;
      return `${plural(d.docs.length, 'document is', 'documents are')} shared with you:\n${bullets(d.docs.map((x) => `${link(x.title, x.link)} (${x.kind}${x.service ? `, ${x.service}` : ''})${x.updated ? `, updated ${x.updated}` : ''}`))}\n\nSee ${link('Documents', '/client/docs')}.`;
    },
  }),

  skill<SettingsData>({
    name: 'page_client_settings',
    label: 'Account and services',
    href: '/client/settings',
    can: client.everyone,
    keywords: /\b(settings|account details|company details|our details|gstin|registered (name|address)|our brands|my services|our services|which services|what services|services (do|have) we|tier)\b/,
    examples: ['Show my account settings', 'Which services do we have with BMU?'],
    description: 'The company account: name, main contact, brands, services with tier and status, open service quotes, pending invites and whether the account is read only or leaving.',
    load: async (ref, me) => {
      const a = await svc(ref, ClientAccountController).account(me);
      return {
        company: a.name,
        readOnlyUntil: a.readOnly ? day(a.readOnlyUntil) ?? 'further notice' : null,
        contact: a.contact,
        brands: a.brands.map((b) => b.name).slice(0, 10),
        services: a.services.map((s) => ({ service: s.serviceName, tier: words(s.tier), billing: words(s.billingType), status: words(s.status) })),
        serviceQuotesOpen: a.quotes.filter((q) => q.status === 'requested' || q.status === 'sent').length,
        pendingInvites: a.pendingInvites.length,
        offboarding: !!a.offboarding,
      };
    },
    answer: (d) => {
      const lines = [
        `**${d.company}**`,
        d.contact.name || d.contact.phone || d.contact.email ? `Main contact: ${[d.contact.name, d.contact.phone, d.contact.email].filter(Boolean).join(', ')}` : '',
        d.brands.length ? `Brands: ${d.brands.join(', ')}` : '',
        d.services.length ? `Services:\n${bullets(d.services.map((s) => `${s.service}: ${s.tier}, ${s.billing}, ${s.status}`))}` : 'No services yet.',
        d.serviceQuotesOpen ? `${plural(d.serviceQuotesOpen, 'service change is', 'service changes are')} being quoted.` : '',
        d.pendingInvites ? `${plural(d.pendingInvites, 'invite is', 'invites are')} pending.` : '',
        d.readOnlyUntil ? `Your account is read only until ${d.readOnlyUntil}.` : '',
        d.offboarding ? 'Your account is being closed; the details are on the page.' : '',
      ].filter(Boolean);
      return `${lines.join('\n')}\n\nUpdate your details or ask for a new service on ${link('Account and services', '/client/settings')}.`;
    },
  }),

  skill<TeamData>({
    name: 'page_client_team',
    label: 'Team users',
    href: '/client/team',
    can: client.everyone,
    keywords: /\b(team users?|users?|my team|our team|colleagues?|team members?|invite (a |someone|my|people)|invited)\b/,
    examples: ['List my team users', 'How many users does my company have?'],
    description: 'People from the company who use BMU Hub, with their role (Owner, Approver, Finance, Viewer) and status, and whether this user may manage them.',
    load: async (ref, me) => {
      const v = await svc(ref, ClientWorkspaceService).team(me);
      return { canManage: v.canManage, members: v.members.map((m) => ({ name: m.name, role: roleName(m.role) ?? 'Viewer', status: m.status, isMe: m.isMe })) };
    },
    answer: (d) => {
      if (!d.members.length) return `No team users yet. See ${link('Team users', '/client/team')}.`;
      const active = d.members.filter((m) => m.status === 'active').length;
      return `${plural(d.members.length, 'person', 'people')} from your company use BMU Hub (${active} active):\n${bullets(d.members.map((m) => `${m.name}${m.isMe ? ' (you)' : ''}: ${m.role}${m.status !== 'active' ? `, ${m.status}` : ''}`), 15)}\n\n${d.canManage ? `As the Owner you can invite people and change roles on ${link('Team users', '/client/team')}.` : `Your account Owner can invite people and change roles. See ${link('Team users', '/client/team')}.`}`;
    },
  }),

  skill<ProfileData>({
    name: 'page_client_profile',
    label: 'Profile & notifications',
    href: '/client/profile',
    can: client.everyone,
    keywords: /\b(profile|notifications?|alerts?|my details|my name|my role)\b/,
    examples: ['Do I have new notifications?', 'Show my profile'],
    description: 'The user’s own profile (name, email, mobile, company, role) and their latest notifications with how many are unread.',
    load: async (ref, me) => {
      const n = await svc(ref, NotificationsService).list(me);
      return {
        name: me.name,
        email: me.email,
        phone: me.phone,
        company: me.clientOrg?.name ?? null,
        role: roleName(me.clientOrg?.role),
        unread: n.unread,
        notifications: n.items.slice(0, 8).map((x) => ({ title: short(x.title, 120), body: short(x.body, 160), at: day(x.at), read: x.read, link: x.link?.startsWith('/client') ? x.link : null })),
      };
    },
    answer: (d, q) => {
      const me = `You are ${d.name}${d.role ? `, ${d.role}` : ''}${d.company ? ` at ${d.company}` : ''}. Email ${d.email ?? 'not set'}, mobile ${d.phone ?? 'not set'}.`;
      const aboutNotes = /\b(notifications?|alerts?)\b/.test(q);
      const notes = d.notifications.length
        ? `${d.unread ? `You have ${plural(d.unread, 'unread notification')}.` : 'No unread notifications.'}\n${bullets(d.notifications.map((x) => `${x.read ? '' : '**New:** '}${x.link ? link(x.title, x.link) : x.title}${x.at ? ` (${x.at})` : ''}`), aboutNotes ? 8 : 4)}`
        : 'No notifications yet.';
      return `${aboutNotes ? `${notes}\n\n${me}` : `${me}\n\n${notes}`}\n\nChange your details and notification settings on ${link('Profile & notifications', '/client/profile')}.`;
    },
  }),
];
