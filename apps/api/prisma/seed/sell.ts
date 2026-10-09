import { priceProposal, sellApprovalChain, sellLeadScore, rupeesToPaise, type Tier } from '@bmu/shared';
import type { Prisma, PrismaClient } from '../../src/generated/prisma/client.js';

// v10 sell demo data: lead activity and follow-ups (some due today), a duplicate enquiry, a negotiated proposal
// (v1 superseded by v2 after a change request), an open change request, discounts waiting at each approval step,
// an expired proposal and clients with retainers coming up for renewal.
// Idempotent: everything is keyed by company names starting with "Sell demo · " (source "sell-demo").

const DAY = 86_400_000;
const SOURCE = 'sell-demo';
const P = 'Sell demo · ';

export async function seedSell(prisma: PrismaClient, orgId: string) {
  const user = async (email: string) => (await prisma.user.findFirst({ where: { orgId, email }, select: { id: true, name: true } }))!;
  const sales = await user('sales@bmu.demo');
  const manager = await user('sales.manager@bmu.demo');
  const founder = await user('founder@bmu.demo');
  const am = await user('am@bmu.demo');
  if (!sales || !manager || !founder) return;

  const book = await prisma.priceBook.findFirst({
    where: { orgId, status: 'active' },
    orderBy: { effectiveFrom: 'desc' },
    include: { services: { include: { tiers: true } }, addOns: true, bundles: true },
  });
  if (!book) return;
  const pricing = {
    services: book.services.map((s) => ({ key: s.key, name: s.name, billingType: s.billingType, tiers: s.tiers.map((t) => ({ tier: t.tier, pricePaise: t.pricePaise })) })),
    addOns: book.addOns.map((a) => ({ id: a.id, name: a.name, pricePaise: a.pricePaise, isCustomQuote: a.isCustomQuote })),
    bundles: book.bundles.map((b) => ({ key: b.key, name: b.name, serviceKeys: b.serviceKeys, discountPct: b.discountPct })),
  };
  const limits = ((await prisma.organisation.findUniqueOrThrow({ where: { id: orgId } })).settings as { discountLimits?: Record<string, number> }).discountLimits ?? { sales_manager: 10, admin: 20 };
  const ago = (days: number) => new Date(Date.now() - days * DAY);

  // ---------------------------------------------------------------- Activity on the original demo leads
  const activity = async (leadId: string, rows: { kind: string; outcome?: string; body: string; daysAgo: number; userId?: string }[]) => {
    if (await prisma.leadActivity.findFirst({ where: { leadId, kind: { not: 'system' } } })) return;
    for (const r of rows) await prisma.leadActivity.create({ data: { orgId, leadId, kind: r.kind, outcome: r.outcome ?? null, body: r.body, at: ago(r.daysAgo), userId: r.userId ?? sales.id } });
    await prisma.lead.update({ where: { id: leadId }, data: { lastActivityAt: ago(Math.min(...rows.map((r) => r.daysAgo))) } });
  };
  const named = async (company: string) => prisma.lead.findFirst({ where: { orgId, deletedAt: null, contact: { path: ['company'], equals: company } }, orderBy: { createdAt: 'asc' } });
  const greenfield = await named('Greenfield Schools');
  if (greenfield) {
    await activity(greenfield.id, [
      { kind: 'call', outcome: 'connected', body: 'Spoke to the principal. Admissions open in November; wants leads from Google Ads.', daysAgo: 6 },
      { kind: 'email', body: 'Sent case study of a school campaign we ran last year.', daysAgo: 4 },
    ]);
    if (!greenfield.nextFollowUpAt) await prisma.lead.update({ where: { id: greenfield.id }, data: { nextFollowUpAt: new Date(Date.now() + 2 * 3_600_000), followUpNotifiedAt: null } });
  }
  const urban = await named('Urban Nest Interiors');
  if (urban) {
    await activity(urban.id, [
      { kind: 'meeting', outcome: 'meeting_booked', body: 'Discovery meeting at their Indiranagar studio. Website + GBP first, SMM later.', daysAgo: 9 },
      { kind: 'call', outcome: 'callback', body: 'Owner travelling; asked to call back next week.', daysAgo: 3 },
    ]);
    if (!urban.nextFollowUpAt) await prisma.lead.update({ where: { id: urban.id }, data: { nextFollowUpAt: ago(1), followUpNotifiedAt: null } });
  }
  const kavya = await named('Kavya Bakery');
  if (kavya) await activity(kavya.id, [{ kind: 'note', body: 'Found them via Instagram. Bakery with 3 outlets; logo looks dated.', daysAgo: 1, userId: manager.id }]);

  // ---------------------------------------------------------------- Helpers for new demo leads + proposals
  const lead = async (company: string, opts: { contact: string; phone: string; need: string; services: string[]; budget: number; stage: Prisma.LeadCreateInput['stage']; ownerId: string | null; daysAgo: number; duplicateOfId?: string }) => {
    const existing = await prisma.lead.findFirst({ where: { orgId, source: SOURCE, contact: { path: ['company'], equals: P + company }, ...(opts.duplicateOfId ? { duplicateOfId: opts.duplicateOfId } : { duplicateOfId: null }) } });
    if (existing) return { lead: existing, created: false };
    const budgetPaise = rupeesToPaise(opts.budget);
    const l = await prisma.lead.create({
      data: {
        orgId,
        source: SOURCE,
        contact: { name: opts.contact, email: `${company.toLowerCase().replace(/\W+/g, '')}@sell.demo`, phone: opts.phone, company: P + company },
        need: opts.need,
        budgetPaise,
        serviceIds: opts.services,
        score: sellLeadScore(budgetPaise, opts.services.length, true).score,
        stage: opts.stage,
        ownerId: opts.ownerId,
        createdAt: ago(opts.daysAgo),
        lastActivityAt: ago(opts.daysAgo),
        duplicateOfId: opts.duplicateOfId ?? null,
      },
    });
    await prisma.leadActivity.create({ data: { orgId, leadId: l.id, kind: 'enquiry', body: opts.need, at: ago(opts.daysAgo) } });
    return { lead: l, created: true };
  };
  const proposal = async (leadId: string, o: { lines: { serviceKey: string; tier: Tier }[]; pct?: number; version?: number; rootId?: string | null; status: 'draft' | 'sent' | 'expired' | 'superseded'; sentAgo?: number; validDays?: number; createdById: string; creatorRoles: string[]; changeNote?: string; viewCount?: number }) => {
    const pr = priceProposal({ ...pricing, serviceLines: o.lines, addOnLines: [], extraDiscountPct: o.pct ?? 0 });
    const chain = sellApprovalChain({ pct: o.pct ?? 0, creatorRoles: o.creatorRoles, limits });
    const sentAt = o.sentAgo !== undefined ? ago(o.sentAgo) : null;
    return prisma.proposal.create({
      data: {
        orgId,
        leadId,
        priceBookId: book.id,
        lines: pr.lines as unknown as Prisma.InputJsonValue,
        subtotalPaise: pr.subtotalPaise,
        bundleDiscountPaise: pr.bundleDiscountPaise,
        extraDiscountPct: o.pct ?? 0,
        discountPaise: pr.discountPaise,
        gstPaise: pr.gstPaise,
        totalPaise: pr.totalPaise,
        validUntil: new Date((sentAt ?? new Date()).getTime() + (o.validDays ?? 14) * DAY),
        status: o.status,
        version: o.version ?? 1,
        rootId: o.rootId ?? null,
        changeNote: o.changeNote ?? null,
        sentAt,
        viewedAt: o.viewCount ? new Date((sentAt ?? new Date()).getTime() + 3_600_000) : null,
        lastViewedAt: o.viewCount ? ago(Math.max(0, (o.sentAgo ?? 0) - 1)) : null,
        viewCount: o.viewCount ?? 0,
        discountNeedsApproval: chain.length > 0,
        discountStatus: chain.length ? 'pending' : 'none',
        createdById: o.createdById,
        createdAt: sentAt ? new Date(sentAt.getTime() - 3_600_000) : new Date(),
      },
    });
  };

  // ---------------------------------------------------------------- Duplicate enquiry
  const lotus = await lead('Lotus Yoga Studio', { contact: 'Shreya Kulkarni', phone: '+919845012301', need: 'Instagram reels for our yoga classes', services: ['smm'], budget: 30000, stage: 'contacted', ownerId: sales.id, daysAgo: 12 });
  if (lotus.created) {
    await prisma.leadActivity.create({ data: { orgId, leadId: lotus.lead.id, kind: 'call', outcome: 'interested', body: 'Wants 12 reels a month. Sending proposal after Diwali.', at: ago(10), userId: sales.id } });
  }
  await lead('Lotus Yoga Studio', { contact: 'Shreya K', phone: '+919845012301', need: 'Also need a website for online class bookings', services: ['website'], budget: 0, stage: 'new', ownerId: sales.id, daysAgo: 1, duplicateOfId: lotus.lead.id });

  // ---------------------------------------------------------------- Negotiated proposal: v1 superseded by v2
  const saffron = await lead('Saffron Kitchens', { contact: 'Imran Shaikh', phone: '+919845012302', need: 'Social media and a menu shoot for 4 restaurants', services: ['smm', 'business_video_shoot'], budget: 80000, stage: 'proposal_sent', ownerId: sales.id, daysAgo: 20 });
  if (saffron.created) {
    const v1 = await proposal(saffron.lead.id, { lines: [{ serviceKey: 'smm', tier: 'premium' }, { serviceKey: 'business_video_shoot', tier: 'growth' }], status: 'superseded', sentAgo: 10, createdById: sales.id, creatorRoles: ['sales_executive'], viewCount: 4 });
    const v2 = await proposal(saffron.lead.id, { lines: [{ serviceKey: 'smm', tier: 'growth' }, { serviceKey: 'business_video_shoot', tier: 'growth' }], version: 2, rootId: v1.id, status: 'sent', sentAgo: 4, createdById: sales.id, creatorRoles: ['sales_executive'], changeNote: 'Growth SMM instead of Premium, as requested', viewCount: 2 });
    await prisma.proposal.update({ where: { id: v1.id }, data: { supersededById: v2.id, supersededAt: ago(4) } });
    await prisma.proposalChangeRequest.create({ data: { orgId, proposalId: v1.id, comment: 'Premium is over our budget. Can we start on Growth and review in 3 months?', byName: 'Imran Shaikh', createdAt: ago(7), resolvedAt: ago(4), revisionId: v2.id } });
    for (const [body, d] of [
      ['Imran Shaikh asked for changes on proposal v1: “Premium is over our budget.”', 7],
      [`${sales.name} sent proposal v2 to the client (earlier versions are now superseded)`, 4],
    ] as const)
      await prisma.leadActivity.create({ data: { orgId, leadId: saffron.lead.id, kind: 'system', body, at: ago(d) } });
    await prisma.lead.update({ where: { id: saffron.lead.id }, data: { nextFollowUpAt: new Date(Date.now() + DAY), lastActivityAt: ago(4) } });
  }

  // ---------------------------------------------------------------- Open change request
  const bloom = await lead('Bloom Florist', { contact: 'Ritu Menon', phone: '+919845012303', need: 'Google Business Profile and local SEO', services: ['gbp', 'seo'], budget: 35000, stage: 'proposal_sent', ownerId: sales.id, daysAgo: 8 });
  if (bloom.created) {
    const p = await proposal(bloom.lead.id, { lines: [{ serviceKey: 'gbp', tier: 'growth' }, { serviceKey: 'seo', tier: 'growth' }], status: 'sent', sentAgo: 3, createdById: sales.id, creatorRoles: ['sales_executive'], viewCount: 3 });
    await prisma.proposalChangeRequest.create({ data: { orgId, proposalId: p.id, comment: 'Can you add 2 extra blog posts a month and drop GBP to Starter?', byName: 'Ritu Menon', byEmail: 'bloomflorist@sell.demo', createdAt: ago(1) } });
    await prisma.leadActivity.create({ data: { orgId, leadId: bloom.lead.id, kind: 'system', outcome: 'changes_requested', body: 'Ritu Menon asked for changes on proposal v1: “Can you add 2 extra blog posts a month and drop GBP to Starter?”', at: ago(1) } });
    await prisma.notification.create({ data: { orgId, userId: sales.id, kind: 'proposal_changes_requested', title: `${P}Bloom Florist asked for changes to the proposal`, body: 'Can you add 2 extra blog posts a month and drop GBP to Starter?', link: `/team/proposals/${p.id}`, critical: true, createdAt: ago(1) } });
  }

  // ---------------------------------------------------------------- Discounts waiting at each approval step
  const northstar = await lead('Northstar Realty', { contact: 'Karan Shetty', phone: '+919845012304', need: 'Full launch campaign for a new project', services: ['website', 'seo', 'gbp', 'smm'], budget: 150000, stage: 'discovery', ownerId: sales.id, daysAgo: 15 });
  if (northstar.created) {
    const p = await proposal(northstar.lead.id, { lines: ['website', 'seo', 'gbp', 'smm'].map((k) => ({ serviceKey: k, tier: 'growth' as Tier })), pct: 25, status: 'draft', createdById: sales.id, creatorRoles: ['sales_executive'] });
    await prisma.discountApprovalStep.create({ data: { orgId, proposalId: p.id, step: 1, level: 'manager', status: 'approved', deciderId: manager.id, note: 'Big launch, worth it', decidedAt: ago(0.2) } });
    await prisma.discountApprovalStep.create({ data: { orgId, proposalId: p.id, step: 2, level: 'founder', status: 'pending' } });
    await prisma.notification.create({ data: { orgId, userId: founder.id, kind: 'discount_approval', title: `Approve a 25% discount for ${P}Northstar Realty`, body: 'Proposal v1 needs founder approval before it can be sent.', link: '/team/approvals', critical: true } });
  }
  const pebble = await lead('Pebble Cafe', { contact: 'Anita D’Souza', phone: '+919845012305', need: 'Instagram for a new cafe', services: ['smm'], budget: 25000, stage: 'discovery', ownerId: sales.id, daysAgo: 6 });
  if (pebble.created) {
    const p = await proposal(pebble.lead.id, { lines: [{ serviceKey: 'smm', tier: 'starter' }], pct: 8, status: 'draft', createdById: sales.id, creatorRoles: ['sales_executive'] });
    await prisma.discountApprovalStep.create({ data: { orgId, proposalId: p.id, step: 1, level: 'manager', status: 'pending' } });
    await prisma.notification.create({ data: { orgId, userId: manager.id, kind: 'discount_approval', title: `Approve a 8% discount for ${P}Pebble Cafe`, body: 'Proposal v1 needs sales manager approval before it can be sent.', link: '/team/approvals', critical: true } });
  }

  // ---------------------------------------------------------------- Expired proposal
  const metro = await lead('Metro Dental', { contact: 'Dr. Vivek Rao', phone: '+919845012306', need: 'Patient enquiries from Google', services: ['digital_marketing'], budget: 40000, stage: 'proposal_sent', ownerId: manager.id, daysAgo: 30 });
  if (metro.created) {
    await proposal(metro.lead.id, { lines: [{ serviceKey: 'digital_marketing', tier: 'growth' }], status: 'expired', sentAgo: 20, validDays: 14, createdById: manager.id, creatorRoles: ['sales_manager'], viewCount: 1 });
    await prisma.leadActivity.create({ data: { orgId, leadId: metro.lead.id, kind: 'system', body: 'Proposal v1 expired without a decision', at: ago(6) } });
  }

  // ---------------------------------------------------------------- Retainers coming up for renewal
  const service = (key: string) => book.services.find((s) => s.key === key)!;
  const ownerRole = await prisma.role.findFirst({ where: { orgId, baseRole: 'client_owner', isCustom: false } });
  const client = async (name: string, ownerEmail: string, ownerName: string, engagements: { key: string; tier: Tier; startAgoDays: number; endInDays?: number }[]) => {
    const full = P + name;
    if (await prisma.clientOrg.findFirst({ where: { orgId, name: full } })) return;
    const c = await prisma.clientOrg.create({ data: { orgId, name: full, amUserId: am?.id, tenureStart: ago(Math.max(...engagements.map((e) => e.startAgoDays))) } });
    const u =
      (await prisma.user.findFirst({ where: { orgId, email: ownerEmail } })) ??
      (await prisma.user.create({ data: { orgId, type: 'client', name: ownerName, email: ownerEmail, status: 'active', ...(ownerRole ? { roles: { create: { roleId: ownerRole.id } } } : {}) } }));
    if (!(await prisma.clientUser.findUnique({ where: { userId: u.id } }))) await prisma.clientUser.create({ data: { userId: u.id, orgId, clientOrgId: c.id, clientRole: 'client_owner', brandScope: [] } });
    for (const e of engagements) {
      const s = service(e.key);
      if (!s) continue;
      await prisma.engagement.create({
        data: {
          orgId,
          clientOrgId: c.id,
          serviceId: s.id,
          tier: e.tier,
          billingType: s.billingType,
          status: s.billingType === 'monthly' ? 'active_retainer' : 'in_production',
          currentGate: 'G4',
          amId: am?.id,
          startDate: ago(e.startAgoDays),
          endDate: e.endInDays !== undefined ? new Date(Date.now() + e.endInDays * DAY) : null,
        },
      });
    }
  };
  const monthsAgo = (m: number, plusDays: number) => {
    const d = new Date();
    d.setMonth(d.getMonth() - m);
    return Math.round((Date.now() - d.getTime()) / DAY) - plusDays;
  };
  await client('Coastal Foods', 'owner@coastalfoods.sell.demo', 'Neha Pillai', [
    { key: 'smm', tier: 'growth', startAgoDays: monthsAgo(6, 10) },
    { key: 'seo', tier: 'starter', startAgoDays: 150, endInDays: 20 },
  ]);
  await client('Harbor Fitness', 'owner@harborfitness.sell.demo', 'Arjun Nair', [{ key: 'digital_marketing', tier: 'growth', startAgoDays: monthsAgo(12, 5) }]);
  await client('Velvet Salon', 'owner@velvetsalon.sell.demo', 'Pooja Reddy', [{ key: 'smm', tier: 'starter', startAgoDays: 340, endInDays: -4 }]);
}
