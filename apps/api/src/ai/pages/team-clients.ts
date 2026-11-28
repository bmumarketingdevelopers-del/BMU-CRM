// Ask BMU page skills: see ./types.ts for the contract and ./access.ts for who sees each tab.
// Team app tabs about clients and selling: files, assets, brand kits, chats, inbox, proposals, discounts, renewals,
// quotations, Client Managers' invoices, creators and DPDP. Each load() makes the same call the page makes.
import { ForbiddenException } from '@nestjs/common';
import { assetRightsLabels, dataRequestKindLabels, formatINR, opsFileDirectionLabels, opsFileFolderLabels, quoteStatusLabels, type Me, type QuoteStatus } from '@bmu/shared';
import { PlatformController } from '../../admin-platform/platform.controller.js';
import { InboxService } from '../../comms/inbox.service.js';
import { AssetsService } from '../../creative/assets.service.js';
import { CreativeService } from '../../creative/creative.service.js';
import { OpsCreatorsService } from '../../ops-actions/ops-creators.service.js';
import { OpsFilesService } from '../../ops-actions/ops-files.service.js';
import { DiscountApprovalsService } from '../../proposals/discounts.service.js';
import { ProposalsService } from '../../proposals/proposals.service.js';
import { QuotesService } from '../../quotes/quotes.service.js';
import { MessagesService } from '../../requests/messages.service.js';
import { DpdpService } from '../../security/dpdp.service.js';
import { SellService } from '../../sell/sell.service.js';
import { CmSigningService } from '../../service/cm-signing.service.js';
import { CreatorsService } from '../../workspace/creators.service.js';
import { redact } from '../ai-safety.js';
import { team } from './access.js';
import { bullets, day, dayShort, link, plural, svc, type PageSkill } from './types.js';

const short = (text: string | null | undefined, max = 120) => {
  const t = redact(text).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const countBy = <T>(rows: T[], key: (r: T) => string) => rows.reduce<Record<string, number>>((m, r) => ((m[key(r)] = (m[key(r)] ?? 0) + 1), m), {});
const counts = (m: Record<string, number>) =>
  Object.entries(m)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`)
    .join(', ');

// ------------------------------------------------------------------------------------------------ data shapes

export type FilesData = { total: number; byDirection: Record<string, number>; released: number; recent: { name: string; client: string | null; folder: string; direction: string | null; uploadedBy: string | null; at: string | null }[] };
export type AssetsData = { total: number; rightsEnding: number; collections: number; topTags: string[]; recent: { title: string; client: string | null; kind: string; rights: string; updated: string | null }[] };
export type BrandKitsData = { total: number; complete: number; incomplete: { client: string; complete: number; files: number; updated: string | null }[] };
export type MessagesData = { total: number; awaiting: number; overdue: number; unread: number; rows: { client: string; last: string | null; author: string | null; at: string | null; awaiting: boolean; overdue: boolean; unread: number }[] };
export type InboxData = { open: number; mine: number; unassigned: number; rows: { who: string; channel: string; about: string | null; assignee: string | null; unread: number; last: string | null; at: string | null }[] };
export type ProposalsData = { total: number; byStatus: Record<string, number>; rows: { client: string; status: string; total: string; validUntil: string | null; sent: string | null; views: number; discount: string | null }[] };
export type DiscountsData = {
  pending: { client: string; pct: number; discount: string; total: string; by: string | null; requested: string | null; canDecide: boolean }[];
  decidedRecently: number;
  minePending: number;
};
export type RenewalsData = { total: number; overdue: number; soon: number; upcoming: number; rows: { client: string; service: string; due: string | null; urgency: string; monthly: string | null; am: string | null; proposal: string | null }[] };
export type QuotesData = { total: number; byStatus: Record<string, number>; waitingValue: string; rows: { number: string; title: string; client: string; status: string; total: string; date: string | null; validUntil: string | null }[] };
export type CmInvoicesData = { requireSignature: boolean; waiting: CmInvoiceLine[]; recent: CmInvoiceLine[] };
type CmInvoiceLine = { number: string; client: string; status: string; total: string; due: string | null; signed: boolean; held: boolean };
export type CreatorsData = {
  creators: number;
  pendingPayout: string;
  topCreators: { name: string; niche: string[]; activeBriefs: number; rating: number | null }[];
  briefs: { review: number; active: number; done: number; rows: { title: string; creator: string; client: string | null; status: string; fee: string; due: string | null }[] } | null;
};
export type ClientDataData = { retentionDays: number; rows: { name: string; users: number; activeUsers: number; anonymisedUsers: number; engagements: number; unpaidInvoices: number }[] };
export type PrivacyData = {
  open: number;
  overdue: number;
  rows: { kind: string; requester: string; status: string; due: string | null; overdue: boolean; assignee: string | null }[];
  consents: { total: number; marketing: number; withdrawn: number };
};

// ------------------------------------------------------------------------------------------------ answers

const statusWord: Record<string, string> = { open: 'open', in_progress: 'in progress', done: 'done', rejected: 'rejected' };

export const answers = {
  files(d: FilesData) {
    const end = link('Files', '/team/files');
    if (!d.total) return `No client files you can see yet. Open ${end}.`;
    const dir = counts(Object.fromEntries(Object.entries(d.byDirection).map(([k, n]) => [(opsFileDirectionLabels as Record<string, string>)[k]?.toLowerCase() ?? k, n])));
    const lines = d.recent.map((f) => `${f.name}${f.client ? ` (${f.client})` : ''}: ${f.folder}${f.uploadedBy ? `, by ${f.uploadedBy}` : ''}${f.at ? `, ${f.at}` : ''}`);
    return `You can see ${plural(d.total, 'file')}${dir ? ` (${dir})` : ''}; ${d.released} released to clients.\nLatest:\n${bullets(lines)}\n\nOpen ${end}.`;
  },
  assets(d: AssetsData) {
    const end = link('Asset library', '/team/assets');
    if (!d.total) return `The asset library has nothing you can see yet. Open ${end}.`;
    const lines = d.recent.map((a) => `${a.title}${a.client ? ` (${a.client})` : ''}: ${a.kind}, ${a.rights}${a.updated ? `, updated ${a.updated}` : ''}`);
    const rights = d.rightsEnding ? `${plural(d.rightsEnding, 'asset')} with usage rights ending soon or ended. ` : '';
    return `The asset library has ${plural(d.total, 'asset')} in ${plural(d.collections, 'collection')}. ${rights}${d.topTags.length ? `Top tags: ${d.topTags.join(', ')}.` : ''}\nRecently updated:\n${bullets(lines)}\n\nOpen ${end}.`;
  },
  brandKits(d: BrandKitsData) {
    const end = link('Brand kits', '/team/brand-kits');
    if (!d.total) return `No clients to show brand kits for. Open ${end}.`;
    if (!d.incomplete.length) return `All ${plural(d.total, 'brand kit')} are at least 80% complete. Open ${end}.`;
    const lines = d.incomplete.map((k) => `${k.client}: ${k.complete}% complete, ${plural(k.files, 'brand file')}${k.updated ? `, updated ${k.updated}` : ''}`);
    return `${d.complete} of ${plural(d.total, 'brand kit')} are at least 80% complete. Least complete:\n${bullets(lines)}\n\nOpen ${end}.`;
  },
  messages(d: MessagesData) {
    const end = link('Messages', '/team/messages');
    if (!d.total) return `You have no client chats yet. Open ${end}.`;
    const head = `${plural(d.total, 'client chat')}: ${d.awaiting} waiting for a reply${d.overdue ? ` (${d.overdue} past the reply time)` : ''}, ${plural(d.unread, 'unread message')}.`;
    const rows = d.rows.filter((r) => r.awaiting || r.unread);
    if (!rows.length) return `${head} Nothing is waiting on you. Open ${end}.`;
    const lines = rows.map((r) => `${r.client}${r.overdue ? ' (reply overdue)' : r.awaiting ? ' (waiting for reply)' : ''}${r.unread ? `, ${r.unread} unread` : ''}${r.last ? `: "${r.last}"${r.author ? ` from ${r.author}` : ''}` : ''}${r.at ? `, ${r.at}` : ''}`);
    return `${head}\n${bullets(lines)}\n\nOpen ${end}.`;
  },
  inbox(d: InboxData, q = '') {
    const end = link('Inbox', '/team/inbox');
    if (!d.open) return `No open conversations in the inbox. Open ${end}.`;
    const rows = /\bunassigned\b/.test(q) ? d.rows.filter((r) => !r.assignee) : d.rows;
    const lines = rows.map((r) => `${r.who} (${r.channel}${r.about ? `, ${r.about}` : ''}): ${r.assignee ? `with ${r.assignee}` : 'unassigned'}${r.unread ? `, ${r.unread} unread` : ''}${r.last ? `, "${r.last}"` : ''}${r.at ? `, ${r.at}` : ''}`);
    return `${plural(d.open, 'open conversation')} in the inbox: ${d.mine} assigned to you, ${d.unassigned} unassigned.${lines.length ? `\n${bullets(lines)}` : ''}\n\nOpen ${end}.`;
  },
  proposals(d: ProposalsData) {
    const end = link('Proposals', '/team/proposals');
    if (!d.total) return `No proposals yet. Open ${end}.`;
    const lines = d.rows.map((p) => `${p.client}: ${p.status}, ${p.total}${p.sent ? `, sent ${p.sent}` : ''}${p.views ? `, viewed ${plural(p.views, 'time')}` : ''}${p.validUntil ? `, valid until ${p.validUntil}` : ''}${p.discount ? `, discount ${p.discount}` : ''}`);
    return `${plural(d.total, 'proposal')}: ${counts(d.byStatus)}.\nLatest:\n${bullets(lines)}\n\nOpen ${end}.`;
  },
  discounts(d: DiscountsData) {
    const end = link('Approvals', '/team/approvals');
    const mine = d.minePending ? ` ${plural(d.minePending, 'discount')} on your own proposals ${d.minePending === 1 ? 'is' : 'are'} still waiting for approval.` : '';
    if (!d.pending.length) return `No discount requests are waiting for a decision.${d.decidedRecently ? ` ${d.decidedRecently} decided already.` : ''}${mine} Open ${end}.`;
    const yours = d.pending.filter((p) => p.canDecide).length;
    const lines = d.pending.map((p) => `${p.client}: ${p.pct}% extra (${p.discount} off ${p.total})${p.by ? `, asked by ${p.by}` : ''}${p.requested ? `, ${p.requested}` : ''}${p.canDecide ? '' : ' (waiting for an earlier step)'}`);
    return `${plural(d.pending.length, 'discount request')} waiting, ${yours} for your decision:\n${bullets(lines)}${mine}\n\nOpen ${end}.`;
  },
  renewals(d: RenewalsData) {
    const end = link('Renewals', '/team/renewals');
    if (!d.total) return `No client services are coming up for renewal. Open ${end}.`;
    const lines = d.rows.map((r) => `${r.client}, ${r.service}: ${r.urgency === 'overdue' ? 'renewal date passed' : 'renews'} ${r.due ?? ''}${r.monthly ? `, ${r.monthly}/month` : ''}${r.am ? `, Client Manager ${r.am}` : ''}${r.proposal ? `, proposal ${r.proposal}` : ', no proposal yet'}`);
    return `${plural(d.total, 'service')} up for renewal: ${d.overdue} past the date, ${d.soon} soon, ${d.upcoming} later.\n${bullets(lines)}\n\nOpen ${end}.`;
  },
  quotes(d: QuotesData) {
    const end = link('Quotations', '/team/quotes');
    if (!d.total) return `No quotations yet. Open ${end}.`;
    const lines = d.rows.map((x) => `${x.number} ${x.title} (${x.client}): ${x.status}, ${x.total}${x.date ? `, ${x.date}` : ''}${x.validUntil ? `, valid until ${x.validUntil}` : ''}`);
    return `${plural(d.total, 'quotation')}: ${counts(d.byStatus)}. Waiting for clients: ${d.waitingValue}.\nLatest:\n${bullets(lines)}\n\nOpen ${end}.`;
  },
  cmInvoices(d: CmInvoicesData) {
    const end = link('Invoices', '/team/invoices');
    const row = (i: CmInvoiceLine) => `${i.number} (${i.client}): ${i.total}, ${i.status}${i.due ? `, due ${i.due}` : ''}${i.signed ? ', signed' : ''}`;
    if (!d.waiting.length && !d.recent.length) return `No invoices for your clients yet. Open ${end}.`;
    const waiting = d.waiting.length ? `${plural(d.waiting.length, 'invoice')} waiting for your signature before ${d.waiting.length === 1 ? 'it goes' : 'they go'} to the client:\n${bullets(d.waiting.map(row))}` : d.requireSignature ? 'No invoice is waiting for your signature.' : '';
    const recent = d.recent.length ? `Recent invoices for your clients:\n${bullets(d.recent.map(row))}` : '';
    return `${[waiting, recent].filter(Boolean).join('\n\n')}\n\nOpen ${end}.`;
  },
  creators(d: CreatorsData) {
    const end = link('Creators', '/team/creators');
    if (!d.creators && !d.briefs?.rows.length) return `No creators yet. Open ${end}.`;
    const head = `${plural(d.creators, 'creator')}, ${d.pendingPayout} in payouts pending (net of TDS).`;
    if (!d.briefs) {
      const lines = d.topCreators.map((c) => `${c.name}${c.niche.length ? ` (${c.niche.join(', ')})` : ''}: ${plural(c.activeBriefs, 'active brief')}${c.rating ? `, rated ${c.rating}` : ''}`);
      return `${head}\n${bullets(lines)}\n\nOpen ${end}.`;
    }
    const b = d.briefs;
    const lines = b.rows.map((r) => `${r.title}, ${r.creator}${r.client ? ` for ${r.client}` : ''}: ${r.status}, ${r.fee}${r.due ? `, due ${r.due}` : ''}`);
    return `${head} Briefs: ${b.review} waiting for your review, ${b.active} in progress, ${b.done} finished.${lines.length ? `\n${bullets(lines)}` : ''}\n\nOpen ${end}.`;
  },
  clientData(d: ClientDataData) {
    const end = link('Client data', '/team/client-data');
    if (!d.rows.length) return `No clients you can export or delete data for. Open ${end}.`;
    const lines = d.rows.map((c) => `${c.name}: ${plural(c.users, 'portal user')} (${c.activeUsers} active${c.anonymisedUsers ? `, ${c.anonymisedUsers} anonymised` : ''}), ${plural(c.engagements, 'service')}${c.unpaidInvoices ? `, ${plural(c.unpaidInvoices, 'unpaid invoice')} (settle before deleting)` : ''}`);
    return `You can export or anonymise data for ${plural(d.rows.length, 'client')} (data is kept ${d.retentionDays} days after a client leaves):\n${bullets(lines)}\n\nOpen ${end}.`;
  },
  privacy(d: PrivacyData) {
    const end = link('Privacy requests', '/team/privacy');
    const consents = `Consents: ${d.consents.total} recorded, ${d.consents.marketing} for marketing, ${d.consents.withdrawn} withdrawn.`;
    if (!d.open) return `No open privacy (DPDP) requests. ${consents} Open ${end}.`;
    const lines = d.rows.map((r) => `${r.kind} from ${r.requester}: ${r.status}${r.due ? `, due ${r.due}` : ''}${r.overdue ? ' (overdue)' : ''}${r.assignee ? `, with ${r.assignee}` : ''}`);
    return `${plural(d.open, 'open privacy request')}${d.overdue ? `, ${d.overdue} overdue` : ''}:\n${bullets(lines)}\n${consents}\n\nOpen ${end}.`;
  },
};

// ------------------------------------------------------------------------------------------------ lookups

/** A tab that answers some people with less (e.g. Department Heads see the creator roster, not briefs). */
async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof ForbiddenException) return null;
    throw e;
  }
}

export const SKILLS: PageSkill[] = [
  {
    name: 'page_discount_approvals',
    label: 'Discount approvals',
    href: '/team/approvals',
    surface: 'team',
    can: team.discountApprovals,
    keywords: /\b(discounts?|discount (requests?|approvals?))\b/,
    examples: ['Which discount requests are waiting for me?', 'Any special discounts to approve?'],
    description: 'Special discount requests on proposals waiting for this person (client, % and amount, who asked, whether it is their step), how many were decided, and their own proposals whose discount is still pending.',
    load: async (ref, me: Me): Promise<DiscountsData> => {
      const s = svc(ref, DiscountApprovalsService);
      const [inbox, mine] = await Promise.all([s.inbox(me), s.mine(me)]);
      return {
        pending: inbox.pending.slice(0, 10).map((p) => ({ client: p.client, pct: p.extraDiscountPct, discount: formatINR(p.discountPaise), total: formatINR(p.totalPaise), by: p.createdBy, requested: dayShort(p.requestedAt), canDecide: p.canDecide })),
        decidedRecently: inbox.decided.length,
        minePending: mine.pending.length,
      };
    },
    answer: (d: DiscountsData) => answers.discounts(d),
  },
  {
    name: 'page_renewals',
    label: 'Renewals',
    href: '/team/renewals',
    surface: 'team',
    can: team.allLeads,
    keywords: /\b(renewals?|up for renewal|renew(ing|s)?)\b/,
    examples: ['Which clients are up for renewal?', 'What renewals are coming up?'],
    description: 'Client services coming up for renewal: client, service, renewal date, urgency, monthly value, Client Manager, and whether a renewal proposal exists.',
    load: async (ref, me: Me): Promise<RenewalsData> => {
      const rows = await svc(ref, SellService).renewals(me);
      const by = countBy(rows, (r) => r.urgency);
      return {
        total: rows.length,
        overdue: by.overdue ?? 0,
        soon: by.soon ?? 0,
        upcoming: by.upcoming ?? 0,
        rows: rows.slice(0, 10).map((r) => ({ client: r.client, service: r.service, due: day(r.dueDate), urgency: r.urgency, monthly: r.monthlyPaise != null ? formatINR(r.monthlyPaise) : null, am: r.am, proposal: r.openProposal ? `v${r.openProposal.version} ${r.openProposal.status}` : null })),
      };
    },
    answer: (d: RenewalsData) => answers.renewals(d),
  },
  {
    name: 'page_proposals',
    label: 'Proposals',
    href: '/team/proposals',
    surface: 'team',
    can: team.hasLeads,
    keywords: /\bproposals?\b/,
    examples: ['Which proposals have been viewed?', 'How many proposals are waiting for acceptance?'],
    description: "Proposals on this person's leads: counts by status and the latest 10 (client, status, total, sent date, views, valid until, discount status).",
    load: async (ref, me: Me): Promise<ProposalsData> => {
      const rows = await svc(ref, ProposalsService).list(me);
      return {
        total: rows.length,
        byStatus: countBy(rows, (p) => p.status),
        rows: rows.slice(0, 10).map((p) => ({
          client: p.client.company ? `${p.client.name} (${p.client.company})` : p.client.name,
          status: p.status,
          total: formatINR(p.totalPaise),
          validUntil: dayShort(p.validUntil),
          sent: dayShort(p.sentAt),
          views: p.viewCount ?? (p.viewedAt ? 1 : 0),
          discount: p.discountStatus && p.discountStatus !== 'none' ? p.discountStatus : null,
        })),
      };
    },
    answer: (d: ProposalsData) => answers.proposals(d),
  },
  {
    name: 'page_cm_invoices',
    label: 'Invoices',
    href: '/team/invoices',
    surface: 'team',
    can: team.cmInvoices,
    keywords: /\b(invoices? (i|we) (created|raised|made|issued)|invoices? did i (create|raise|make|issue)|unsigned invoices?|invoices? (to|waiting for (my )?|awaiting (my )?|needing (my )?)sign(ature|ing)?|sign (an |the |my )?invoices?)\b/,
    examples: ['Show the invoices I raised', 'Any invoices waiting for my signature?'],
    description: "Invoices of this Client Manager's own clients (the CM Lead: every client): those waiting for their signature and the recent ones (number, client, amount, status, due date, signed).",
    load: async (ref, me: Me): Promise<CmInvoicesData> => {
      const d = await svc(ref, CmSigningService).invoices(me);
      const line = (i: (typeof d.recent)[number]): CmInvoiceLine => ({ number: i.number, client: i.client, status: i.status, total: formatINR(i.totalPaise), due: dayShort(i.dueDate), signed: i.signed, held: i.held });
      return { requireSignature: d.requireSignature, waiting: d.waiting.slice(0, 10).map(line), recent: d.recent.slice(0, 10).map(line) };
    },
    answer: (d: CmInvoicesData) => answers.cmInvoices(d),
  },
  {
    name: 'page_quotations',
    label: 'Quotations',
    href: '/team/quotes',
    surface: 'team',
    can: team.quotations,
    keywords: /\b(quotations?|quotes?)\b/,
    examples: ['Which quotations are waiting for the client?', 'How many quotes were accepted?'],
    description: 'Quotations for the clients this person handles: counts by status, value waiting for clients, and the latest 10 (number, title, client, status, total, date, valid until).',
    load: async (ref, me: Me): Promise<QuotesData> => {
      const rows = await svc(ref, QuotesService).list(me, {});
      const label = (s: QuoteStatus) => quoteStatusLabels[s]?.team ?? s;
      return {
        total: rows.length,
        byStatus: countBy(rows, (r) => label(r.status).toLowerCase()),
        waitingValue: formatINR(rows.filter((r) => r.status === 'sent').reduce((s, r) => s + r.totalPaise, 0)),
        rows: rows.slice(0, 10).map((r) => ({ number: r.number, title: short(r.title, 80), client: r.client.name, status: label(r.status), total: formatINR(r.totalPaise), date: dayShort(r.date), validUntil: dayShort(r.validUntil) })),
      };
    },
    answer: (d: QuotesData) => answers.quotes(d),
  },
  {
    name: 'page_inbox',
    label: 'Inbox',
    href: '/team/inbox',
    surface: 'team',
    can: team.inbox,
    keywords: /(?<!requests? )\binbox\b|\b(whatsapp|email) (messages?|chats?|conversations?)\b|\bconversations?\b/,
    examples: ['How many WhatsApp conversations are open?', 'Show unassigned conversations in the inbox'],
    description: 'Open WhatsApp and email conversations this person can see: counts (open, assigned to them, unassigned) and the latest 10 (who, channel, client or lead, assignee, unread, last message).',
    load: async (ref, me: Me): Promise<InboxData> => {
      const d = await svc(ref, InboxService).list(me, { status: 'open' });
      return {
        open: d.counts.open,
        mine: d.counts.mine,
        unassigned: d.counts.unassigned,
        rows: d.items.slice(0, 10).map((r) => ({
          who: r.name ? short(r.name, 60) : redact(r.display),
          channel: r.channel === 'whatsapp' ? 'WhatsApp' : 'email',
          about: r.client?.name ?? (r.lead ? `lead ${r.lead.name}` : null),
          assignee: r.assignee?.name ?? null,
          unread: r.unread,
          last: r.last ? short(r.last.body, 100) : null,
          at: dayShort(r.lastMessageAt),
        })),
      };
    },
    answer: (d: InboxData, q: string) => answers.inbox(d, q),
  },
  {
    name: 'page_messages',
    label: 'Messages',
    href: '/team/messages',
    surface: 'team',
    can: team.clientChat,
    keywords: /\b(client (chats?|messages?)|chats? with (my |the )?clients?|messages? from (my |the )?clients?|unread (client )?messages?|awaiting (a |my )?reply|waiting for (a |my )?reply)\b/,
    examples: ['Any unread client messages?', 'Which client chats are waiting for a reply?'],
    description: "This person's client chats: how many, how many wait for a reply (and are past the reply time), unread messages, and the chats that need them (client, last message, author, time).",
    load: async (ref, me: Me): Promise<MessagesData> => {
      const rows = await svc(ref, MessagesService).list(me);
      const ordered = [...rows].sort((a, b) => Number(!!b.awaitingReply?.overdue) - Number(!!a.awaitingReply?.overdue) || Number(!!b.awaitingReply) - Number(!!a.awaitingReply) || (b.unread ?? 0) - (a.unread ?? 0));
      return {
        total: rows.length,
        awaiting: rows.filter((r) => r.awaitingReply).length,
        overdue: rows.filter((r) => r.awaitingReply?.overdue).length,
        unread: rows.reduce((s, r) => s + (r.unread ?? 0), 0),
        rows: ordered.slice(0, 10).map((r) => ({
          client: r.client.name,
          last: r.lastMessage ? short(r.lastMessage.body, 100) : null,
          author: r.lastMessage?.author ?? null,
          at: dayShort(r.lastMessage?.at),
          awaiting: !!r.awaitingReply,
          overdue: !!r.awaitingReply?.overdue,
          unread: r.unread ?? 0,
        })),
      };
    },
    answer: (d: MessagesData) => answers.messages(d),
  },
  {
    name: 'page_files',
    label: 'Files',
    href: '/team/files',
    surface: 'team',
    can: team.everyone,
    keywords: /\b(client files?|files? from (the )?clients?|(latest|recent|new) files|files? (were |was )?(uploaded|shared)|uploaded files?|final files?|working files?|files tab)\b/,
    examples: ['Which client files were uploaded recently?', 'Show the latest files'],
    description: 'Client files this person may see (same visibility as the Files page): total, how many sent to / received from clients / internal, how many released, and the latest 10 (name, client, folder, uploaded by, date).',
    load: async (ref, me: Me): Promise<FilesData> => {
      const d = await svc(ref, OpsFilesService).list(me, {});
      return {
        total: d.rows.length,
        byDirection: countBy(d.rows, (f) => f.direction ?? 'internal'),
        released: d.rows.filter((f) => f.released).length,
        recent: d.rows.slice(0, 10).map((f) => ({ name: short(f.name, 80), client: f.client?.name ?? null, folder: opsFileFolderLabels[f.folder] ?? f.folder, direction: f.direction ?? null, uploadedBy: f.uploadedBy, at: dayShort(f.sharedAt ?? f.createdAt) })),
      };
    },
    answer: (d: FilesData) => answers.files(d),
  },
  {
    name: 'page_assets',
    label: 'Asset library',
    href: '/team/assets',
    surface: 'team',
    can: team.everyone,
    keywords: /\b(asset library|assets?|usage rights|stock (images|photos|videos))\b/,
    examples: ["What's in the asset library?", 'Which assets have usage rights ending?'],
    description: 'The asset library this person may see: number of assets and collections, top tags, how many have usage rights ending, and the 10 most recently updated (title, client, kind, rights).',
    load: async (ref, me: Me): Promise<AssetsData> => {
      const d = await svc(ref, AssetsService).list(me, {});
      return {
        total: d.total,
        rightsEnding: d.rightsEnding,
        collections: d.collections.length,
        topTags: d.tags.slice(0, 8).map((t) => t.tag),
        recent: d.items.slice(0, 10).map((a) => ({ title: short(a.title, 80), client: a.client?.name ?? null, kind: a.kind, rights: assetRightsLabels[a.rights.state] ?? a.rights.state, updated: dayShort(a.updatedAt) })),
      };
    },
    answer: (d: AssetsData) => answers.assets(d),
  },
  {
    name: 'page_brand_kits',
    label: 'Brand kits',
    href: '/team/brand-kits',
    surface: 'team',
    can: team.everyone,
    keywords: /\b(brand ?kits?|brand guidelines?|brand colou?rs|brand fonts?|tone of voice)\b/,
    examples: ['Which brand kits are incomplete?', 'Show the brand kits'],
    description: "Brand kits of the clients this person may see: how many, how many are at least 80% complete, and the least complete ones (client, % complete, brand files, last update).",
    load: async (ref, me: Me): Promise<BrandKitsData> => {
      const kits = await svc(ref, CreativeService).brandKits(me);
      return {
        total: kits.length,
        complete: kits.filter((k) => k.complete >= 80).length,
        incomplete: kits
          .filter((k) => k.complete < 80)
          .sort((a, b) => a.complete - b.complete)
          .slice(0, 10)
          .map((k) => ({ client: k.client, complete: k.complete, files: k.files, updated: dayShort(k.updatedAt) })),
      };
    },
    answer: (d: BrandKitsData) => answers.brandKits(d),
  },
  {
    name: 'page_creators',
    label: 'Creators',
    href: '/team/creators',
    surface: 'team',
    can: team.creators,
    keywords: /\b(creators?|ugc|influencers?)\b/,
    examples: ['Which creator briefs are waiting for review?', 'How many UGC creators do we have?'],
    description: 'UGC creators and influencers: how many, payouts pending, and (for Client Managers and leadership) briefs waiting for review, in progress and finished, with the latest 10 briefs.',
    load: async (ref, me: Me): Promise<CreatorsData> => {
      // Same as the page: the roster for everyone with the tab; briefs only for Client Managers and leadership.
      const [roster, briefs] = await Promise.all([svc(ref, OpsCreatorsService).list(me, false), orNull(svc(ref, CreatorsService).briefs(me))]);
      const group = (s: string) => (s === 'submitted' ? 'review' : ['offered', 'accepted', 'revision'].includes(s) ? 'active' : 'done');
      const by = briefs ? countBy(briefs, (b) => group(b.status)) : {};
      return {
        creators: roster.length,
        pendingPayout: formatINR(roster.reduce((s, c) => s + c.pendingPayoutPaise, 0)),
        topCreators: [...roster].sort((a, b) => b.activeBriefs - a.activeBriefs).slice(0, 10).map((c) => ({ name: c.name, niche: c.niche.slice(0, 3), activeBriefs: c.activeBriefs, rating: c.rating })),
        briefs: briefs
          ? {
              review: by.review ?? 0,
              active: by.active ?? 0,
              done: by.done ?? 0,
              rows: [...briefs]
                .sort((a, b) => Number(group(b.status) === 'review') - Number(group(a.status) === 'review'))
                .slice(0, 10)
                .map((b) => ({ title: short(b.title, 80), creator: b.creator.name, client: b.client?.name ?? null, status: b.status, fee: formatINR(b.feePaise), due: dayShort(b.dueAt) })),
            }
          : null,
      };
    },
    answer: (d: CreatorsData) => answers.creators(d),
  },
  {
    name: 'page_client_data',
    label: 'Client data (DPDP)',
    href: '/team/client-data',
    surface: 'team',
    can: team.clientManager,
    keywords: /\b(client data|data (export|deletion)|export(ing)? (a |the )?clients?'?s? data|anonymi[sz](e|ed|ing|ation))\b/,
    examples: ['How do I export client data?', 'Which client data can be anonymised?'],
    description: "The clients whose data this Client Manager can export or anonymise (their own clients): portal users (active, anonymised), services, unpaid invoices, and the retention period.",
    load: async (ref, me: Me): Promise<ClientDataData> => {
      const d = await svc(ref, PlatformController).dataClients(me);
      return { retentionDays: d.retentionDays, rows: d.clients.slice(0, 15).map((c) => ({ name: c.name, users: c.users, activeUsers: c.activeUsers, anonymisedUsers: c.anonymisedUsers, engagements: c.engagements, unpaidInvoices: c.unpaidInvoices })) };
    },
    answer: (d: ClientDataData) => answers.clientData(d),
  },
  {
    name: 'page_privacy',
    label: 'Privacy requests',
    href: '/team/privacy',
    surface: 'team',
    can: team.clientManager,
    keywords: /\b(privacy|dpdp|consents?|data protection|data requests?|erasure)\b/,
    examples: ['Any open privacy requests?', 'How many consents were withdrawn?'],
    description: "Data-protection (DPDP) requests from people at this person's clients: open and overdue counts, the open ones (kind, requester, status, due date, assignee), and consent totals.",
    load: async (ref, me: Me): Promise<PrivacyData> => {
      const d = await svc(ref, DpdpService).overview(me);
      const open = d.requests.filter((r) => r.status === 'open' || r.status === 'in_progress');
      return {
        open: open.length,
        overdue: open.filter((r) => r.overdue).length,
        rows: open.slice(0, 10).map((r) => ({ kind: dataRequestKindLabels[r.kind] ?? r.kind, requester: short(r.requesterName, 60), status: statusWord[r.status] ?? r.status, due: dayShort(r.dueAt), overdue: r.overdue, assignee: r.assignee?.name ?? null })),
        consents: { total: d.consents.total, marketing: d.consents.marketing, withdrawn: d.consents.withdrawn },
      };
    },
    answer: (d: PrivacyData) => answers.privacy(d),
  },
];
