import { financialYear } from '@bmu/shared';
import type { BillingType, EngagementStatus, LeadStage, PrismaClient, Tier } from '../../src/generated/prisma/client.js';

// v9 sales & money analytics demo data: 12 months of leads (with stage-change audit events), proposals, eight
// clients won from those leads (some churned, one expanded, one losing money), monthly retainer invoices and
// payments (some late, one overdue), logged hours by different roles and creator payouts.
// Idempotent: leads are keyed by "@analytics.demo" emails and clients by name; each block checks before creating.

const DAY = 86_400_000;
const HOUR = 3_600_000;
const ago = (days: number, hour = 11) => {
  const d = new Date(Date.now() - days * DAY);
  const ist = new Date(d.getTime() + 330 * 60_000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), hour, 0) - 330 * 60_000);
};
/** Day `day` of the month `back` months ago, 11:00 IST. */
const monthDay = (back: number, day: number) => {
  const ist = new Date(Date.now() + 330 * 60_000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - back, day, 5, 30));
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (d: Date) => MONTHS[new Date(d.getTime() + 330 * 60_000).getUTCMonth()];

/** Small deterministic random generator so the demo data is the same on every machine. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Line = { key: string; tier: Tier };
type ClientSpec = {
  name: string;
  industry: string;
  source: string;
  contact: string;
  /** Months ago the work started. */
  startBack: number;
  lines: (Line & { status: EngagementStatus; endBack?: number; startBack?: number })[];
  /** Days after the invoice date that payment arrives; null = still unpaid. */
  payDays: (back: number) => number | null;
  /** Hours per month by person (email prefix). */
  hours: [string, number][];
  discountPct?: number;
};

const CLIENTS: ClientSpec[] = [
  {
    name: 'Saffron Spice Kitchens',
    industry: 'Restaurants',
    source: 'referral',
    contact: 'Ritu Malhotra',
    startBack: 11,
    lines: [
      { key: 'smm', tier: 'growth', status: 'active_retainer' },
      { key: 'graphic_design', tier: 'starter', status: 'closed', endBack: 1 },
    ],
    payDays: (b) => 3 + (b % 4),
    hours: [['producer', 14], ['strategist', 5], ['am', 4]],
  },
  {
    name: 'Nimbus Fitness Studios',
    industry: 'Fitness',
    source: 'google_ads',
    contact: 'Karan Bedi',
    startBack: 10,
    lines: [{ key: 'digital_marketing', tier: 'growth', status: 'closed', endBack: 4 }],
    payDays: (b) => 6 + (b % 3),
    hours: [['producer', 12], ['strategist', 8], ['am', 5]],
  },
  {
    name: 'Coastal Craft Breweries',
    industry: 'Food & beverage',
    source: 'referral',
    contact: 'Joel Fernandes',
    startBack: 9,
    lines: [
      { key: 'smm', tier: 'premium', status: 'active_retainer' },
      { key: 'seo', tier: 'starter', status: 'active_retainer', startBack: 3 },
    ],
    payDays: (b) => 4 + (b % 5),
    hours: [['producer', 20], ['strategist', 8], ['am', 6], ['qc', 3]],
    discountPct: 5,
  },
  {
    name: 'Banyan Learning Academy',
    industry: 'Education',
    source: 'website',
    contact: 'Shalini Rao',
    startBack: 8,
    lines: [{ key: 'seo', tier: 'growth', status: 'active_retainer' }],
    // Pays late; last month's invoice is still unpaid.
    payDays: (b) => (b <= 1 ? null : 19 + (b % 4) * 3),
    hours: [['strategist', 12], ['producer', 6], ['am', 4]],
  },
  {
    name: 'Orchid Skin Clinic',
    industry: 'Healthcare',
    source: 'instagram',
    contact: 'Dr. Meenal Joshi',
    startBack: 7,
    lines: [{ key: 'graphic_design', tier: 'growth', status: 'active_retainer' }],
    payDays: (b) => (b === 0 ? null : 11 + (b % 3) * 3),
    // Endless revisions and founder time: costs more than it pays.
    hours: [['producer', 16], ['design.head', 4], ['founder', 2], ['am', 3], ['qc', 2]],
  },
  {
    name: 'Velvet Threads Boutique',
    industry: 'Fashion retail',
    source: 'instagram',
    contact: 'Ananya Kapoor',
    startBack: 6,
    lines: [{ key: 'personal_branding', tier: 'starter', status: 'closed', endBack: 1 }],
    payDays: (b) => 7 + (b % 2) * 5,
    hours: [['producer', 10], ['strategist', 4]],
  },
  {
    name: 'Peak Realty Ventures',
    industry: 'Real estate',
    source: 'events',
    contact: 'Sandeep Hegde',
    startBack: 2,
    lines: [{ key: 'website', tier: 'premium', status: 'in_production' }],
    payDays: () => 0,
    hours: [['producer', 14], ['design.head', 4], ['am', 2], ['qc', 1]],
  },
  {
    name: 'Mango Leaf Cafe',
    industry: 'Restaurants',
    source: 'linkedin',
    contact: 'Farah Siddiqui',
    startBack: 2,
    lines: [{ key: 'ugc_content', tier: 'growth', status: 'active_retainer' }],
    payDays: (b) => (b === 0 ? null : 2),
    hours: [['producer', 9], ['strategist', 3], ['am', 3]],
  },
];

const SOURCES: [string, number][] = [
  ['website', 12],
  ['instagram', 10],
  ['google_ads', 9],
  ['referral', 6],
  ['linkedin', 8],
  ['events', 7],
];
const FIRST = ['Aarav', 'Vivaan', 'Diya', 'Ishaan', 'Kavya', 'Rohit', 'Sneha', 'Aditya', 'Pooja', 'Manish', 'Neeraj', 'Tanvi', 'Harsh', 'Lavanya', 'Gautam', 'Zoya', 'Pranav', 'Bhavna', 'Siddharth', 'Nikita'];
const BIZ = ['Bakery', 'Dental', 'Interiors', 'Motors', 'Yoga Studio', 'Jewellers', 'Opticals', 'Pet Clinic', 'Coworking', 'Salon', 'Ayurveda', 'Tutorials', 'Florist', 'Builders', 'Sweets', 'Travels', 'Furniture', 'Organics', 'Boutique', 'Cafe'];
const PLACES = ['Indiranagar', 'Koramangala', 'Jayanagar', 'HSR', 'Whitefield', 'Malleshwaram', 'Hebbal', 'Banashankari', 'JP Nagar', 'Yelahanka'];
const SERVICE_POOL: Line[] = [
  { key: 'smm', tier: 'starter' },
  { key: 'smm', tier: 'growth' },
  { key: 'digital_marketing', tier: 'starter' },
  { key: 'seo', tier: 'starter' },
  { key: 'website', tier: 'starter' },
  { key: 'website', tier: 'growth' },
  { key: 'logo_brand_kit', tier: 'growth' },
  { key: 'graphic_design', tier: 'starter' },
  { key: 'ugc_content', tier: 'starter' },
  { key: 'gbp', tier: 'growth' },
];
const LOST_REASONS: Record<string, string[]> = {
  new: ['No response to calls or messages'],
  contacted: ['Budget too low', 'Only wanted a one-off post', 'No response to calls or messages'],
  discovery: ['Timing: revisit next quarter', 'Chose an in-house team', 'Budget too low'],
  proposal_sent: ['Went with another agency', 'Price too high', 'No response after proposal'],
};
const TASK_TITLES: Record<string, string[]> = {
  producer: ['Monthly creatives batch', 'Reels edit and captions', 'Carousel designs', 'Story set for offers'],
  strategist: ['Content calendar', 'Campaign plan and audience research', 'Monthly performance review'],
  am: ['Client call and monthly report', 'Approvals follow-up'],
  qc: ['QC pass on monthly deliverables'],
  'design.head': ['Creative direction review', 'Revision round with client feedback'],
  founder: ['Escalation call with client', 'Pitch rework after client complaint'],
};

type Reach = 'new' | 'contacted' | 'discovery' | 'proposal_sent';

export async function seedAnalytics(prisma: PrismaClient, orgId: string) {
  const people = new Map<string, string>();
  for (const key of ['founder', 'sales', 'sales.manager', 'am', 'producer', 'strategist', 'design.head', 'qc']) {
    const u = await prisma.user.findFirst({ where: { orgId, email: `${key}@bmu.demo` }, select: { id: true } });
    if (u) people.set(key, u.id);
  }
  const sales = people.get('sales') ?? people.get('founder');
  const am = people.get('am');
  if (!sales || !am || !people.get('producer')) return; // core seed did not run

  const book = await prisma.priceBook.findFirst({ where: { orgId, status: 'active' }, include: { services: { include: { tiers: true } } } });
  if (!book) return;
  const svc = (key: string) => book.services.find((s) => s.key === key)!;
  const price = (l: Line) => svc(l.key).tiers.find((t) => t.tier === l.tier)!.pricePaise;

  const audit = (entityId: string, action: string, at: Date, before: unknown, after: unknown, entity = 'Lead') =>
    prisma.auditEvent.create({ data: { orgId, actorId: sales, action, entity, entityId, at, before: before as object, after: after as object } });

  async function nextNumber(at: Date) {
    const fy = financialYear(at);
    let seq = (await prisma.invoice.count({ where: { orgId, number: { startsWith: `BMU/${fy}/` } } })) + 1;
    while (await prisma.invoice.findFirst({ where: { orgId, number: `BMU/${fy}/${String(seq).padStart(4, '0')}` } })) seq++;
    return `BMU/${fy}/${String(seq).padStart(4, '0')}`;
  }

  function priceLines(lines: Line[], discountPct = 0) {
    const out = lines.map((l) => {
      const s = svc(l.key);
      const gross = price(l);
      const extra = Math.round((gross * discountPct) / 100);
      const net = gross - extra;
      return { kind: 'service', key: l.key, name: s.name, tier: l.tier, billingType: s.billingType, unitPaise: gross, qty: 1, grossPaise: gross, bundleDiscountPaise: 0, extraDiscountPaise: extra, netPaise: net, dueNowPaise: s.billingType === 'monthly' ? net : Math.round(net / 2) };
    });
    const subtotal = out.reduce((s, l) => s + l.grossPaise, 0);
    const discount = out.reduce((s, l) => s + l.extraDiscountPaise, 0);
    const taxable = subtotal - discount;
    const gst = Math.round(taxable * 0.18);
    const dueNow = out.reduce((s, l) => s + l.dueNowPaise, 0);
    return { lines: out, subtotal, discount, taxable, gst, total: taxable + gst, dueNow };
  }

  async function createProposal(leadId: string, lines: Line[], sentAt: Date, status: 'sent' | 'accepted' | 'rejected', acceptedAt: Date | null, discountPct = 0) {
    const p = priceLines(lines, discountPct);
    const proposal = await prisma.proposal.create({
      data: {
        orgId,
        leadId,
        priceBookId: book!.id,
        lines: p.lines,
        subtotalPaise: p.subtotal,
        extraDiscountPct: discountPct,
        discountPaise: p.discount,
        gstPaise: p.gst,
        totalPaise: p.total,
        validUntil: new Date(sentAt.getTime() + 14 * DAY),
        status,
        createdById: sales,
        sentAt,
        viewedAt: new Date(sentAt.getTime() + 5 * HOUR),
        acceptedAt,
        createdAt: new Date(sentAt.getTime() - 2 * HOUR),
      },
    });
    await audit(proposal.id, 'proposal.sent', sentAt, undefined, { totalPaise: p.total }, 'Proposal');
    if (acceptedAt) await audit(proposal.id, 'proposal.accepted', acceptedAt, undefined, { totalPaise: p.total }, 'Proposal');
    return { proposal, pricing: p };
  }

  /** A lead with its stage history: contacted, discovery, proposal, then won / lost / still open. */
  async function createLead(spec: {
    email: string;
    name: string;
    company: string;
    source: string;
    created: Date;
    lines: Line[];
    budgetPaise: number;
    contactHours: number | null;
    reach: Reach;
    outcome: 'open' | 'lost' | 'won' | 'accepted';
    lostReason?: string;
    discountPct?: number;
    gapDays: number;
  }) {
    if (await prisma.lead.findFirst({ where: { orgId, contact: { path: ['email'], equals: spec.email } } })) return null;
    const stage: LeadStage = spec.outcome === 'lost' ? 'lost' : spec.outcome === 'won' ? 'won' : spec.reach;
    const lead = await prisma.lead.create({
      data: {
        orgId,
        source: spec.source,
        contact: { name: spec.name, email: spec.email, phone: '+919800000000', company: spec.company },
        need: spec.lines.map((l) => svc(l.key).name).join(' + '),
        budgetPaise: spec.budgetPaise,
        score: Math.min(100, 20 + spec.lines.length * 15 + (spec.budgetPaise >= 5_000_000 ? 30 : 10)),
        stage,
        ownerId: spec.source === 'referral' || spec.source === 'events' ? (people.get('sales.manager') ?? sales) : sales,
        lostReason: spec.outcome === 'lost' ? spec.lostReason : null,
        serviceIds: [...new Set(spec.lines.map((l) => l.key))],
        createdAt: spec.created,
      },
    });
    let t = spec.created.getTime();
    let last = 'new';
    const move = async (to: string, at: number) => {
      await audit(lead.id, `lead.${to}`, new Date(at), { stage: last }, { stage: to });
      last = to;
    };
    const reachIdx = ['new', 'contacted', 'discovery', 'proposal_sent'].indexOf(spec.reach);
    if (reachIdx >= 1 && spec.contactHours !== null) {
      t += spec.contactHours * HOUR;
      await move('contacted', t);
    }
    if (reachIdx >= 2) {
      t += spec.gapDays * DAY;
      await move('discovery', t);
    }
    let result: Awaited<ReturnType<typeof createProposal>> | null = null;
    if (reachIdx >= 3) {
      t += (spec.gapDays + 2) * DAY;
      const sentAt = new Date(t);
      const status = spec.outcome === 'won' || spec.outcome === 'accepted' ? 'accepted' : spec.outcome === 'lost' ? 'rejected' : 'sent';
      const acceptedAt = status === 'accepted' ? new Date(t + (spec.gapDays + 1) * DAY) : null;
      result = await createProposal(lead.id, spec.lines, sentAt, status, acceptedAt, spec.discountPct ?? 0);
      last = 'proposal_sent';
      if (acceptedAt) t = acceptedAt.getTime();
    }
    if (spec.outcome === 'lost') {
      t = Math.min(t + Math.max(2, spec.gapDays) * DAY, Date.now() - HOUR);
      await move('lost', t);
    }
    await prisma.lead.update({ where: { id: lead.id }, data: { updatedAt: new Date(Math.min(t, Date.now())) } });
    return { lead, proposal: result };
  }

  // A monthly target the demo agency is close to, so the pace and forecast have something to say.
  const org = await prisma.organisation.findUnique({ where: { id: orgId }, select: { settings: true } });
  const settings = (org?.settings ?? {}) as Record<string, unknown>;
  const v8 = (settings.v8 ?? {}) as Record<string, unknown>;
  if (!v8.forecast) {
    v8.forecast = { stageProbabilityPct: { new: 5, contacted: 10, discovery: 25, proposal_sent: 50 }, monthlyTargetPaise: 2_80_000_00 };
    await prisma.organisation.update({ where: { id: orgId }, data: { settings: { ...settings, v8 } as object } });
  }

  // --- Clients won from leads ----------------------------------------------
  for (const [ci, c] of CLIENTS.entries()) {
    if (await prisma.clientOrg.findFirst({ where: { orgId, name: c.name } })) continue;
    const start = monthDay(c.startBack, 6);
    const firstLines = c.lines.filter((l) => (l.startBack ?? c.startBack) === c.startBack);
    const won = await createLead({
      email: `${c.name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/\.$/, '')}@analytics.demo`,
      name: c.contact,
      company: c.name,
      source: c.source,
      created: new Date(start.getTime() - (13 + (ci % 3)) * DAY),
      lines: firstLines,
      budgetPaise: firstLines.reduce((s, l) => s + price(l), 0),
      contactHours: 1 + (ci % 4),
      reach: 'proposal_sent',
      outcome: 'won',
      discountPct: c.discountPct,
      gapDays: 2,
    });
    if (!won?.proposal) continue;
    const client = await prisma.clientOrg.create({ data: { orgId, leadId: won.lead.id, name: c.name, industry: c.industry, amUserId: am, tenureStart: start, createdAt: start } });

    const engagements: { id: string; line: (typeof c.lines)[number]; billingType: BillingType; net: number; startAt: Date; endAt: Date | null }[] = [];
    for (const l of c.lines) {
      const s = svc(l.key);
      const startAt = l.startBack !== undefined ? monthDay(l.startBack, 4) : start;
      const endAt = l.endBack !== undefined ? monthDay(l.endBack, 20) : null;
      const e = await prisma.engagement.create({
        data: {
          orgId,
          clientOrgId: client.id,
          serviceId: s.id,
          tier: l.tier,
          billingType: s.billingType,
          status: l.status,
          currentGate: l.status === 'in_production' ? 'G3' : l.status === 'closed' ? 'G5' : 'G4',
          amId: am,
          startDate: startAt,
          endDate: endAt,
          createdAt: startAt,
        },
      });
      const line = won.proposal.pricing.lines.find((x) => x.key === l.key);
      engagements.push({ id: e.id, line: l, billingType: s.billingType, net: line ? line.netPaise : price(l), startAt, endAt });
    }

    // First payment against the accepted proposal: makes the lead "Paid" and starts the client.
    const pricing = won.proposal.pricing;
    const fpAt = new Date(start.getTime() - 2 * DAY);
    const fpGst = Math.round(pricing.dueNow * 0.18);
    const fp = await prisma.invoice.create({
      data: {
        orgId,
        clientOrgId: client.id,
        proposalId: won.proposal.proposal.id,
        kind: 'first_payment',
        number: await nextNumber(fpAt),
        lines: pricing.lines.map((l) => ({ name: l.name, tier: l.tier, billingType: l.billingType, amountPaise: l.dueNowPaise })),
        subtotalPaise: pricing.dueNow,
        gstPaise: fpGst,
        totalPaise: pricing.dueNow + fpGst,
        dueDate: new Date(fpAt.getTime() + 3 * DAY),
        status: 'paid',
        createdAt: fpAt,
      },
    });
    const paidAt = new Date(fpAt.getTime() + 4 * HOUR);
    await prisma.payment.create({ data: { orgId, invoiceId: fp.id, amountPaise: fp.totalPaise, method: 'razorpay', at: paidAt, ref: `pay_analytics${String(ci).padStart(3, '0')}` } });
    await audit(won.lead.id, 'lead.won', paidAt, { stage: 'proposal_sent' }, { stage: 'won' });

    // Monthly retainer invoices after the first month (the first month was in the first payment).
    for (let back = c.startBack; back >= 0; back--) {
      const at = monthDay(back, 2);
      if (at > new Date()) continue;
      for (const e of engagements.filter((x) => x.billingType === 'monthly')) {
        if (back === c.startBack && e.line.startBack === undefined) continue;
        if (at < new Date(e.startAt.getTime() - 5 * DAY)) continue;
        if (e.endAt && at >= e.endAt) continue;
        const gst = Math.round(e.net * 0.18);
        const total = e.net + gst;
        const days = c.payDays(back);
        const when = days === null ? null : new Date(at.getTime() + days * DAY + 3 * HOUR);
        const paid = !!when && when < new Date();
        const inv = await prisma.invoice.create({
          data: {
            orgId,
            clientOrgId: client.id,
            engagementId: e.id,
            kind: 'retainer',
            number: await nextNumber(at),
            lines: [{ label: `${svc(e.line.key).name} — ${e.line.tier} (${monthName(at)})`, amountPaise: e.net }, { label: 'GST 18%', amountPaise: gst }],
            subtotalPaise: e.net,
            gstPaise: gst,
            totalPaise: total,
            dueDate: new Date(at.getTime() + 7 * DAY),
            status: paid ? 'paid' : 'issued',
            createdAt: at,
          },
        });
        if (paid) await prisma.payment.create({ data: { orgId, invoiceId: inv.id, amountPaise: total, method: back % 3 === 0 ? 'upi' : 'bank', at: when!, ref: `AN-${inv.number.slice(-4)}` } });
      }
    }

    // Logged hours: one finished task per person per month, owned by different roles.
    for (let back = Math.min(c.startBack, 7); back >= 0; back--) {
      const monthStart = monthDay(back, 3);
      if (monthStart > new Date()) continue;
      for (const [ei, e] of engagements.entries()) {
        if (monthStart.getTime() < e.startAt.getTime() - 5 * DAY || (e.endAt && monthStart >= e.endAt)) continue;
        const share = ei === 0 ? 1 : 0.25; // add-on retainers take a small slice of the hours
        for (const [k, [who, hours]] of c.hours.entries()) {
          const owner = people.get(who);
          if (!owner) continue;
          const titles = TASK_TITLES[who] ?? ['Client work'];
          const done = monthDay(back, 8 + k * 4);
          if (done > new Date()) continue;
          await prisma.task.create({
            data: {
              orgId,
              engagementId: e.id,
              title: `${titles[(back + k) % titles.length]} (${monthName(monthStart)})`,
              ownerId: owner,
              role: who === 'design.head' ? 'department_head' : who,
              status: 'done',
              kind: who === 'qc' ? 'qc' : 'work',
              timeLoggedMin: Math.round(hours * share * 60 * (0.85 + ((back * 7 + k * 3) % 5) * 0.075)),
              deadline: new Date(done.getTime() + DAY),
              startedAt: new Date(done.getTime() - 5 * DAY),
              completedAt: done,
              createdAt: new Date(done.getTime() - 7 * DAY),
              updatedAt: done,
            },
          });
        }
      }
    }

    // UGC work for Mango Leaf uses creators: their payouts count as delivery cost.
    if (c.name === 'Mango Leaf Cafe') {
      const creator = await prisma.creator.findFirst({ where: { orgId } });
      const founder = people.get('founder');
      if (creator && founder) {
        for (const back of [1, 0]) {
          const at = new Date(Math.min(Date.now() - DAY, monthDay(back, 12).getTime()));
          const brief = await prisma.creatorBrief.create({
            data: { orgId, creatorId: creator.id, clientOrgId: client.id, engagementId: engagements[0].id, title: `Cafe UGC reels (${monthName(at)})`, brief: 'Three short reels of the new menu.', deliverables: ['3 reels'], feePaise: 900_000, status: back ? 'paid' : 'approved', createdById: founder, createdAt: at },
          });
          await prisma.creatorPayout.create({ data: { orgId, creatorId: creator.id, briefId: brief.id, amountPaise: 900_000, tdsPaise: 9_000, netPaise: 891_000, status: back ? 'paid' : 'pending', paidAt: back ? at : null, createdAt: at } });
        }
      }
    }
  }

  // --- Other leads: lost, open and one accepted but not yet paid -----------
  const rand = rng(9091);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const contactHoursFor = (source: string, fast: boolean) => {
    const base: Record<string, [number, number]> = { referral: [1, 8], website: [2, 30], instagram: [4, 70], google_ads: [1, 12], linkedin: [6, 48], events: [12, 96] };
    const [lo, hi] = base[source] ?? [2, 24];
    return fast ? lo + rand() * 3 : lo + rand() * (hi - lo);
  };
  const many = (count: number, reach: Reach, outcome: 'open' | 'lost' | 'accepted', days: [number, number]) => Array.from({ length: count }, () => ({ reach, outcome, days }));
  const plan = [
    ...many(5, 'new', 'lost', [60, 350]),
    ...many(9, 'contacted', 'lost', [40, 350]),
    ...many(9, 'discovery', 'lost', [30, 340]),
    ...many(8, 'proposal_sent', 'lost', [30, 330]),
    ...many(1, 'proposal_sent', 'accepted', [20, 20]),
    ...many(3, 'new', 'open', [1, 12]),
    ...many(4, 'contacted', 'open', [5, 40]),
    ...many(3, 'discovery', 'open', [12, 50]),
    ...many(4, 'proposal_sent', 'open', [14, 45]),
    ...many(2, 'contacted', 'open', [120, 200]),
  ];
  const sourceBag = SOURCES.flatMap(([s, k]) => Array<string>(k).fill(s));
  for (const [i, p] of plan.entries()) {
    const n = i + 1;
    const source = sourceBag[(n * 7) % sourceBag.length];
    const twoServices = rand() < 0.35;
    const lines = (twoServices ? [pick(SERVICE_POOL), pick(SERVICE_POOL)] : [pick(SERVICE_POOL)]).filter((l, j, a) => a.findIndex((x) => x.key === l.key) === j);
    const daysBack = Math.round(p.days[0] + rand() * (p.days[1] - p.days[0]));
    const budget = Math.max(1_000_000, Math.round((lines.reduce((s, l) => s + price(l), 0) * (0.6 + rand() * 0.8)) / 500_000) * 500_000);
    // Keep each lead's history inside its own age so nothing lands in the future.
    const gap = Math.max(1, Math.min(6, Math.floor(daysBack / 8)));
    const lostReason = p.outcome === 'lost' ? pick(LOST_REASONS[p.reach]) : undefined;
    const contactHours = p.reach === 'new' ? null : contactHoursFor(source, p.outcome === 'accepted');
    await createLead({
      email: `lead${String(n).padStart(2, '0')}@analytics.demo`,
      name: `${FIRST[n % FIRST.length]} ${['Sharma', 'Reddy', 'Nair', 'Patel', 'Iyer', 'Gowda', 'Khan', 'Das'][n % 8]}`,
      company: `${PLACES[(n * 3 + Math.floor(n / BIZ.length)) % PLACES.length]} ${BIZ[n % BIZ.length]}`,
      source,
      created: ago(daysBack, 9 + (n % 8)),
      lines,
      budgetPaise: budget,
      contactHours,
      reach: p.reach,
      outcome: p.outcome,
      lostReason,
      gapDays: gap,
    });
  }
}
