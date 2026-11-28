// Team app client/selling page skills: each answer() with sample data shaped like its load(), and the empty case.
import { describe, expect, it } from 'vitest';
import { SKILLS } from './team-clients.js';
import type { PageSkill } from './types.js';

const skill = (name: string) => SKILLS.find((s) => s.name === name) as PageSkill;
const say = (name: string, data: unknown, q = '') => skill(name).answer(data as never, q);

describe('Team client page skills', () => {
  it('Files', () => {
    const t = say('page_files', { total: 3, byDirection: { to_client: 1, from_client: 2 }, released: 1, recent: [{ name: 'logo-final.png', client: 'Metro Dental', folder: 'Final files', direction: 'to_client', uploadedBy: 'Asha Rao', at: '2 Nov' }] });
    expect(t).toContain('3 files (1 sent to client, 2 from client)');
    expect(t).toContain('- logo-final.png (Metro Dental): Final files, by Asha Rao, 2 Nov');
    expect(t).toMatch(/\[Files\]\(\/team\/files\)\.$/);
    expect(say('page_files', { total: 0, byDirection: {}, released: 0, recent: [] })).toContain('No client files');
  });

  it('Asset library', () => {
    const t = say('page_assets', { total: 12, rightsEnding: 2, collections: 3, topTags: ['diwali', 'reel'], recent: [{ title: 'Diwali banner', client: 'Metro Dental', kind: 'image', rights: 'Rights end soon', updated: '5 Nov' }] });
    expect(t).toContain('12 assets in 3 collections');
    expect(t).toContain('2 assets with usage rights ending');
    expect(t).toContain('- Diwali banner (Metro Dental): image, Rights end soon, updated 5 Nov');
    expect(t).toMatch(/\(\/team\/assets\)\.$/);
    expect(say('page_assets', { total: 0, rightsEnding: 0, collections: 0, topTags: [], recent: [] })).toContain('nothing you can see');
  });

  it('Brand kits', () => {
    const t = say('page_brand_kits', { total: 4, complete: 3, incomplete: [{ client: 'Metro Dental', complete: 40, files: 1, updated: '1 Oct' }] });
    expect(t).toContain('3 of 4 brand kits');
    expect(t).toContain('- Metro Dental: 40% complete, 1 brand file, updated 1 Oct');
    expect(say('page_brand_kits', { total: 2, complete: 2, incomplete: [] })).toContain('All 2 brand kits');
    expect(say('page_brand_kits', { total: 0, complete: 0, incomplete: [] })).toContain('No clients');
  });

  it('Messages', () => {
    const t = say('page_messages', { total: 2, awaiting: 1, overdue: 1, unread: 3, rows: [{ client: 'Metro Dental', last: 'When is the reel ready?', author: 'Ravi', at: '27 Nov', awaiting: true, overdue: true, unread: 3 }, { client: 'Sunrise Cafe', last: 'Thanks', author: 'Asha', at: '20 Nov', awaiting: false, overdue: false, unread: 0 }] });
    expect(t).toContain('2 client chats: 1 waiting for a reply (1 past the reply time), 3 unread messages.');
    expect(t).toContain('- Metro Dental (reply overdue), 3 unread: "When is the reel ready?" from Ravi, 27 Nov');
    expect(t).not.toContain('Sunrise Cafe');
    expect(t).toMatch(/\(\/team\/messages\)\.$/);
    expect(say('page_messages', { total: 0, awaiting: 0, overdue: 0, unread: 0, rows: [] })).toContain('no client chats');
  });

  it('Inbox', () => {
    const d = { open: 2, mine: 1, unassigned: 1, rows: [{ who: 'Priya', channel: 'WhatsApp', about: 'lead Priya Clinic', assignee: null, unread: 2, last: 'Price?', at: '28 Nov' }, { who: '[email]', channel: 'email', about: 'Metro Dental', assignee: 'Asha Rao', unread: 0, last: null, at: '26 Nov' }] };
    const t = say('page_inbox', d);
    expect(t).toContain('2 open conversations in the inbox: 1 assigned to you, 1 unassigned.');
    expect(t).toContain('- Priya (WhatsApp, lead Priya Clinic): unassigned, 2 unread, "Price?", 28 Nov');
    expect(say('page_inbox', d, 'show unassigned conversations')).not.toContain('Asha Rao');
    expect(say('page_inbox', { open: 0, mine: 0, unassigned: 0, rows: [] })).toContain('No open conversations');
  });

  it('Proposals', () => {
    const t = say('page_proposals', { total: 2, byStatus: { sent: 1, draft: 1 }, rows: [{ client: 'Priya (Priya Clinic)', status: 'sent', total: '₹59,000', validUntil: '10 Dec', sent: '26 Nov', views: 2, discount: 'approved' }] });
    expect(t).toContain('2 proposals: 1 sent, 1 draft.');
    expect(t).toContain('- Priya (Priya Clinic): sent, ₹59,000, sent 26 Nov, viewed 2 times, valid until 10 Dec, discount approved');
    expect(say('page_proposals', { total: 0, byStatus: {}, rows: [] })).toContain('No proposals');
  });

  it('Discount approvals', () => {
    const t = say('page_discount_approvals', { pending: [{ client: 'Priya Clinic', pct: 10, discount: '₹5,000', total: '₹45,000', by: 'Karan', requested: '27 Nov', canDecide: true }], decidedRecently: 4, minePending: 0 });
    expect(t).toContain('1 discount request waiting, 1 for your decision:');
    expect(t).toContain('- Priya Clinic: 10% extra (₹5,000 off ₹45,000), asked by Karan, 27 Nov');
    expect(t).toMatch(/\(\/team\/approvals\)\.$/);
    expect(say('page_discount_approvals', { pending: [], decidedRecently: 0, minePending: 1 })).toContain('No discount requests are waiting');
  });

  it('Renewals', () => {
    const t = say('page_renewals', { total: 1, overdue: 0, soon: 1, upcoming: 0, rows: [{ client: 'Metro Dental', service: 'Social Media', due: '15 Dec 2026', urgency: 'soon', monthly: '₹30,000', am: 'Asha Rao', proposal: null }] });
    expect(t).toContain('1 service up for renewal: 0 past the date, 1 soon, 0 later.');
    expect(t).toContain('- Metro Dental, Social Media: renews 15 Dec 2026, ₹30,000/month, Client Manager Asha Rao, no proposal yet');
    expect(say('page_renewals', { total: 0, overdue: 0, soon: 0, upcoming: 0, rows: [] })).toContain('No client services');
  });

  it('Quotations', () => {
    const t = say('page_quotations', { total: 2, byStatus: { 'waiting for the client': 1, accepted: 1 }, waitingValue: '₹1,18,000', rows: [{ number: 'Q-0012', title: 'Website revamp', client: 'Metro Dental', status: 'Waiting for the client', total: '₹1,18,000', date: '20 Nov', validUntil: '4 Dec' }] });
    expect(t).toContain('2 quotations: 1 waiting for the client, 1 accepted. Waiting for clients: ₹1,18,000.');
    expect(t).toContain('- Q-0012 Website revamp (Metro Dental): Waiting for the client, ₹1,18,000, 20 Nov, valid until 4 Dec');
    expect(t).toMatch(/\(\/team\/quotes\)\.$/);
    expect(say('page_quotations', { total: 0, byStatus: {}, waitingValue: '₹0', rows: [] })).toContain('No quotations');
  });

  it("Client Managers' invoices", () => {
    const row = { number: 'INV-0042', client: 'Metro Dental', status: 'sent', total: '₹35,400', due: '5 Dec', signed: false, held: true };
    const t = say('page_cm_invoices', { requireSignature: true, waiting: [row], recent: [{ ...row, number: 'INV-0040', signed: true, held: false }] });
    expect(t).toContain('1 invoice waiting for your signature before it goes to the client:');
    expect(t).toContain('- INV-0040 (Metro Dental): ₹35,400, sent, due 5 Dec, signed');
    expect(t).toMatch(/\(\/team\/invoices\)\.$/);
    expect(say('page_cm_invoices', { requireSignature: true, waiting: [], recent: [] })).toContain('No invoices for your clients');
  });

  it('Creators', () => {
    const base = { creators: 2, pendingPayout: '₹9,000', topCreators: [{ name: 'Neha', niche: ['food'], activeBriefs: 1, rating: 4.5 }] };
    const t = say('page_creators', { ...base, briefs: { review: 1, active: 1, done: 3, rows: [{ title: 'Cafe reel', creator: 'Neha', client: 'Sunrise Cafe', status: 'submitted', fee: '₹10,000', due: '2 Dec' }] } });
    expect(t).toContain('2 creators, ₹9,000 in payouts pending');
    expect(t).toContain('Briefs: 1 waiting for your review, 1 in progress, 3 finished.');
    expect(t).toContain('- Cafe reel, Neha for Sunrise Cafe: submitted, ₹10,000, due 2 Dec');
    // Department Heads: roster only.
    expect(say('page_creators', { ...base, briefs: null })).toContain('- Neha (food): 1 active brief, rated 4.5');
    expect(say('page_creators', { creators: 0, pendingPayout: '₹0', topCreators: [], briefs: null })).toContain('No creators');
  });

  it('Client data (DPDP)', () => {
    const t = say('page_client_data', { retentionDays: 365, rows: [{ name: 'Metro Dental', users: 3, activeUsers: 2, anonymisedUsers: 1, engagements: 2, unpaidInvoices: 1 }] });
    expect(t).toContain('data for 1 client (data is kept 365 days');
    expect(t).toContain('- Metro Dental: 3 portal users (2 active, 1 anonymised), 2 services, 1 unpaid invoice');
    expect(t).toMatch(/\(\/team\/client-data\)\.$/);
    expect(say('page_client_data', { retentionDays: 365, rows: [] })).toContain('No clients');
  });

  it('Privacy requests', () => {
    const consents = { total: 10, marketing: 4, withdrawn: 1 };
    const t = say('page_privacy', { open: 1, overdue: 1, rows: [{ kind: 'Delete my data', requester: 'Ravi Kumar', status: 'open', due: '1 Dec', overdue: true, assignee: null }], consents });
    expect(t).toContain('1 open privacy request, 1 overdue:');
    expect(t).toContain('- Delete my data from Ravi Kumar: open, due 1 Dec (overdue)');
    expect(t).toContain('Consents: 10 recorded, 4 for marketing, 1 withdrawn.');
    expect(say('page_privacy', { open: 0, overdue: 0, rows: [], consents })).toContain('No open privacy (DPDP) requests');
  });
});
