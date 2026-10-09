import { addWorkingDays } from '@bmu/shared';
import type { EngagementStatus, LeadStage, PrismaClient, ProposalStatus, Tier } from '../../src/generated/prisma/client.js';

// v9 flows demo data: a year of deals moving through the whole business flow, plus live work sitting at every
// stage of the flow map (some deliberately stuck) and a rich journey on a Sunrise Realty project.
// Idempotent: every deal is keyed by its company name (lead source "flow-demo"); existing deals are skipped.

const DAY = 86_400_000;
const SOURCE = 'flow-demo';

type Deal = {
  company: string;
  contact: string;
  need: string;
  service: string;
  tier: Tier;
  leadAgo: number;
  /** Lead stage while no proposal went out. */
  leadStage?: LeadStage;
  lostReason?: string;
  sentAgo?: number;
  rejectedAgo?: number;
  acceptedAgo?: number;
  paidAgo?: number;
  rcdAgo?: number;
  /** Requirements received so far while G1 is open (of 4). */
  received?: number;
  planSentAgo?: number;
  planChangesAgo?: number;
  planApprovedAgo?: number;
  /** Client approves the plan this many days before the plan deadline (overrides planApprovedAgo's date). */
  approvedDaysEarly?: number;
  /** Per deliverable: days ago V1 was sent, optional changes + V2, approval; due date in days from today. */
  work?: { title: string; type: string; v1Ago?: number; changesAgo?: number; v2Ago?: number; approvedAgo?: number; dueIn: number }[];
  g4Ago?: number;
  signOffAgo?: number;
  g5Ago?: number;
  offboardAgo?: number;
  /** Existing client to attach to instead of creating one. */
  clientName?: string;
  overdueTask?: boolean;
  lateRequest?: boolean;
};

const FIRST = ['Aarav', 'Diya', 'Rohan', 'Meera', 'Kiran', 'Ananya', 'Vikram', 'Sneha', 'Arjun', 'Pooja', 'Rahul', 'Nisha', 'Sanjay', 'Leela'];
const LAST = ['Sharma', 'Rao', 'Iyer', 'Nair', 'Reddy', 'Menon', 'Gupta', 'Kulkarni', 'Shetty', 'Pillai'];

/** Small deterministic random so the history is the same on every machine. */
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

const HISTORY_COMPANIES = [
  'Indiranagar Yoga Loft', 'Malleshwaram Sweets', 'Koramangala Climbing Co.', 'Jayanagar Opticals', 'Hebbal Lake Villas', 'Basil & Thyme Kitchen',
  'Silkboard Auto Care', 'Namma Organics', 'Cubbon Law Chambers', 'Whitefield Pet Clinic', 'Sarjapur Montessori', 'Frazer Town Bakers',
  'Electronic City Labs', 'Banashankari Jewellers', 'Yelahanka Farms', 'MG Road Tailors', 'HSR Physio Hub', 'Ulsoor Boat Club Cafe',
  'Bellandur Smile Dental', 'Rajajinagar Motors', 'Domlur Design Studio', 'Marathahalli Tutors', 'BTM Fitness Garage', 'Kanakapura Resorts',
  'Hennur Craft Brewery', 'Vijayanagar Furnishings', 'RT Nagar Clinics', 'Bannerghatta Adventures',
];
const SERVICES: { key: string; need: string }[] = [
  { key: 'complete_branding', need: 'New brand identity before launch' },
  { key: 'smm', need: 'Instagram and Facebook every month' },
  { key: 'logo_brand_kit', need: 'Logo refresh and brand kit' },
  { key: 'seo', need: 'Rank on Google for local searches' },
  { key: 'digital_marketing', need: 'Leads from Meta and Google ads' },
];
const ONE_TIME = ['complete_branding', 'logo_brand_kit'];

function historyDeals(): Deal[] {
  const r = rng(9);
  const out: Deal[] = [];
  HISTORY_COMPANIES.forEach((company, i) => {
    const leadAgo = 360 - i * 10 - Math.floor(r() * 5);
    const svc = SERVICES[i % SERVICES.length];
    const tier: Tier = (['starter', 'growth', 'growth', 'premium'] as const)[Math.floor(r() * 4)];
    const contact = `${FIRST[i % FIRST.length]} ${LAST[(i * 3) % LAST.length]}`;
    const base: Deal = { company, contact, need: svc.need, service: svc.key, tier, leadAgo };
    const roll = r();
    if (roll < 0.3) {
      out.push({ ...base, leadStage: 'lost', lostReason: ['Budget too low', 'Went with a freelancer', 'No response after discovery', 'Timing: next quarter'][i % 4] });
      return;
    }
    const sentAgo = leadAgo - 3 - Math.floor(r() * 6);
    if (roll < 0.55) {
      out.push({ ...base, sentAgo, rejectedAgo: sentAgo - 4 - Math.floor(r() * 6), lostReason: 'Chose another agency' });
      return;
    }
    const acceptedAgo = sentAgo - 2 - Math.floor(r() * 8);
    const paidAgo = acceptedAgo - 1 - Math.floor(r() * 2);
    const rcdAgo = paidAgo - 3 - Math.floor(r() * 7);
    const planApprovedAgo = rcdAgo - 3 - Math.floor(r() * 5);
    const v1 = planApprovedAgo - 5 - Math.floor(r() * 7);
    const v1b = v1 - 1 - Math.floor(r() * 3);
    const approvedA = v1 - 3 - Math.floor(r() * 6);
    const approvedB = v1b - 2 - Math.floor(r() * 4);
    const g4Ago = Math.min(approvedA, approvedB);
    const oneTime = ONE_TIME.includes(svc.key);
    const deal: Deal = {
      ...base,
      sentAgo,
      acceptedAgo,
      paidAgo,
      rcdAgo,
      planSentAgo: planApprovedAgo + 1,
      planApprovedAgo,
      work: [
        { title: oneTime ? 'Logo suite' : 'Month 1 content calendar posts', type: 'post', v1Ago: v1, approvedAgo: approvedA, dueIn: -(v1 - 4) },
        { title: oneTime ? 'Brand guidelines PDF' : 'Month 1 reels', type: oneTime ? 'other' : 'reel', v1Ago: v1b, approvedAgo: approvedB, dueIn: -(v1b - 4) },
      ],
      g4Ago,
    };
    if (oneTime) {
      deal.signOffAgo = g4Ago - 2 - Math.floor(r() * 4);
      deal.g5Ago = deal.signOffAgo - 1;
    }
    out.push(deal);
  });
  // One retainer client is wrapping up.
  const leaving = out.find((d) => d.paidAgo !== undefined && !ONE_TIME.includes(d.service));
  if (leaving) leaving.offboardAgo = 20;
  return out;
}

const LIVE_DEALS: Deal[] = [
  // Leads still being worked
  { company: 'Bloom Florists', contact: 'Asha Kumar', need: 'Wedding season Instagram push', service: 'smm', tier: 'starter', leadAgo: 1, leadStage: 'new' },
  { company: 'Little Sprouts Preschool', contact: 'Farida Khan', need: 'Admissions campaign', service: 'digital_marketing', tier: 'starter', leadAgo: 2, leadStage: 'new' },
  { company: 'Hoppers Bistro', contact: 'Joseph Mathew', need: 'Brand refresh for second outlet', service: 'logo_brand_kit', tier: 'growth', leadAgo: 5, leadStage: 'contacted' },
  { company: 'Vertex Realty', contact: 'Harsha Gowda', need: 'Project launch for 2 towers', service: 'digital_marketing', tier: 'premium', leadAgo: 8, leadStage: 'discovery' },
  { company: 'TechNest Coworking', contact: 'Neha Bansal', need: 'Fill 40 desks in Q4', service: 'seo', tier: 'growth', leadAgo: 26, leadStage: 'contacted' },
  { company: 'Zenith Dental', contact: 'Dr. Prakash', need: 'Google reviews and listing', service: 'seo', tier: 'starter', leadAgo: 28, leadStage: 'lost', lostReason: 'Budget too low' },
  { company: 'Rao & Sons Hardware', contact: 'Venkat Rao', need: 'Catalogue shoot and ads', service: 'digital_marketing', tier: 'growth', leadAgo: 50, sentAgo: 45, rejectedAgo: 40, lostReason: 'Chose another agency' },
  // Proposals waiting for a decision (one out for 12 days)
  { company: 'Saffron Stays', contact: 'Ritu Malhotra', need: 'Homestay bookings via Instagram', service: 'smm', tier: 'growth', leadAgo: 18, sentAgo: 12 },
  { company: 'Urban Pedal Cycles', contact: 'Karthik S', need: 'Launch of e-bike range', service: 'complete_branding', tier: 'growth', leadAgo: 9, sentAgo: 3 },
  { company: 'Mysore Silk House', contact: 'Lakshmi Devi', need: 'Festive season campaign', service: 'digital_marketing', tier: 'growth', leadAgo: 6, sentAgo: 1 },
  // Accepted, advance not paid yet
  { company: 'Greenway Solar', contact: 'Imran Sheikh', need: 'Rooftop solar lead generation', service: 'digital_marketing', tier: 'growth', leadAgo: 14, sentAgo: 8, acceptedAgo: 1 },
  // G1 requirements
  { company: 'Nimbus Fitness Studio', contact: 'Tanya Bose', need: 'Monthly social media', service: 'smm', tier: 'growth', leadAgo: 30, sentAgo: 24, acceptedAgo: 15, paidAgo: 14, received: 2 },
  { company: 'Coastal Kitchen Co.', contact: 'Sameer D’Souza', need: 'Restaurant brand identity', service: 'logo_brand_kit', tier: 'starter', leadAgo: 12, sentAgo: 8, acceptedAgo: 4, paidAgo: 3, received: 1 },
  // G2 plan (one past its plan deadline)
  { company: 'Peak Physio Clinic', contact: 'Dr. Anil Joshi', need: 'Local SEO for 3 clinics', service: 'seo', tier: 'growth', leadAgo: 34, sentAgo: 30, acceptedAgo: 22, paidAgo: 21, rcdAgo: 11, lateRequest: true },
  { company: 'Aurora Jewellers', contact: 'Priya Jain', need: 'Bridal collection branding', service: 'complete_branding', tier: 'premium', leadAgo: 28, sentAgo: 24, acceptedAgo: 17, paidAgo: 16, rcdAgo: 4, planSentAgo: 1 },
  // G3 production
  {
    company: 'Brewline Coffee Roasters', contact: 'Nikhil Rao', need: 'Social media for new cafe', service: 'smm', tier: 'premium', leadAgo: 45, sentAgo: 40, acceptedAgo: 33, paidAgo: 32, rcdAgo: 22, planSentAgo: 13, planApprovedAgo: 11, overdueTask: true,
    work: [{ title: 'October content calendar posts', type: 'post', dueIn: 4 }, { title: 'Cafe launch reel', type: 'reel', dueIn: 6 }],
  },
  // G4 client review (with the client for 8 days)
  {
    company: 'Kavya Interiors', contact: 'Kavya Hegde', need: 'Logo and stationery', service: 'logo_brand_kit', tier: 'growth', leadAgo: 62, sentAgo: 57, acceptedAgo: 50, paidAgo: 49, rcdAgo: 42, planSentAgo: 37, planApprovedAgo: 35,
    work: [{ title: 'Logo concepts', type: 'post', v1Ago: 20, changesAgo: 17, v2Ago: 8, dueIn: -3 }, { title: 'Business cards', type: 'other', v1Ago: 15, approvedAgo: 12, dueIn: -5 }],
  },
  // G5 final delivery
  {
    company: 'Orbit EdTech', contact: 'Rahul Menon', need: 'Brand identity for app launch', service: 'complete_branding', tier: 'growth', leadAgo: 80, sentAgo: 75, acceptedAgo: 70, paidAgo: 69, rcdAgo: 62, planSentAgo: 57, planApprovedAgo: 55,
    work: [{ title: 'Logo suite', type: 'post', v1Ago: 30, approvedAgo: 22, dueIn: -20 }, { title: 'App store creatives', type: 'post', v1Ago: 14, changesAgo: 11, v2Ago: 7, approvedAgo: 4, dueIn: -6 }],
    g4Ago: 4,
  },
  // Sunrise Realty: the rich journey (complete branding, now in client review)
  {
    company: 'Sunrise Realty Pvt Ltd', clientName: 'Sunrise Realty Pvt Ltd', contact: 'Asha Reddy', need: 'Complete brand identity for Sunrise Heights launch', service: 'complete_branding', tier: 'growth',
    leadAgo: 52, sentAgo: 47, acceptedAgo: 44, paidAgo: 43, rcdAgo: 38, planSentAgo: 36.5, planChangesAgo: 36, planApprovedAgo: 33, approvedDaysEarly: 1,
    work: [
      { title: 'Logo suite', type: 'post', v1Ago: 26, changesAgo: 24, v2Ago: 21, approvedAgo: 20, dueIn: -18 },
      { title: 'Brand guidelines', type: 'other', v1Ago: 16, approvedAgo: 14, dueIn: -12 },
      { title: 'Stationery set', type: 'other', v1Ago: 2, dueIn: 3 },
    ],
  },
];

const REQUIREMENTS = [
  { label: 'Business details questionnaire', type: 'info' },
  { label: 'Logo files and brand references', type: 'asset' },
  { label: 'Social and ads account access', type: 'access' },
  { label: 'Kick-off call notes signed off', type: 'info' },
];

export async function seedFlows(prisma: PrismaClient, orgId: string) {
  const now = Date.now();
  const ago = (d: number) => new Date(now - d * DAY + 2 * 3_600_000);
  const book = await prisma.priceBook.findFirst({ where: { orgId, status: 'active' }, include: { services: { include: { tiers: true } } } });
  if (!book) return;
  const org = await prisma.organisation.findUniqueOrThrow({ where: { id: orgId } });
  const holidays = ((org.settings as { holidays?: string[] } | null)?.holidays ?? []) as string[];
  const users = await prisma.user.findMany({ where: { orgId, email: { endsWith: '.demo' } }, select: { id: true, email: true } });
  const idOf = (email: string) => users.find((u) => u.email === email)?.id ?? null;
  const am = idOf('am@bmu.demo');
  const sales = idOf('sales@bmu.demo') ?? idOf('sales.manager@bmu.demo');
  const producer = idOf('producer@bmu.demo');
  const qc = idOf('qc@bmu.demo');
  const founder = idOf('founder@bmu.demo');
  const strategist = idOf('strategist@bmu.demo');
  const ownerRole = await prisma.role.findFirst({ where: { orgId, baseRole: 'client_owner', isCustom: false } });
  const qcChecklist = await prisma.checklistTemplate.findFirst({ where: { orgId, kind: 'qc' } });
  const existing = await prisma.lead.findMany({ where: { orgId, source: SOURCE }, select: { contact: true } });
  const have = new Set(existing.map((l) => (l.contact as { company?: string }).company));
  let seq = await prisma.invoice.count({ where: { orgId, number: { startsWith: 'BMU/FLW/' } } });
  const nextNumber = () => `BMU/FLW/${String(++seq).padStart(4, '0')}`;
  const audit = (action: string, entity: string, entityId: string, at: Date, actorId: string | null, after?: object) =>
    prisma.auditEvent.create({ data: { orgId, actorId, action, entity, entityId, at, after: after ?? undefined } });

  let created = 0;
  for (const d of [...historyDeals(), ...LIVE_DEALS]) {
    if (have.has(d.company)) continue;
    const service = book.services.find((s) => s.key === d.service);
    const tier = service?.tiers.find((t) => t.tier === d.tier);
    if (!service || !tier) continue;
    created++;
    const won = d.paidAgo !== undefined;
    const stage: LeadStage = d.leadStage ?? (d.acceptedAgo !== undefined ? 'won' : d.rejectedAgo !== undefined ? 'lost' : d.sentAgo !== undefined ? 'proposal_sent' : 'new');
    const email = `${d.contact.split(' ')[0].toLowerCase().replace(/[^a-z]/g, '') || 'owner'}@${d.company.toLowerCase().replace(/[^a-z]+/g, '')}.example`;
    const lead = await prisma.lead.create({
      data: {
        orgId,
        source: SOURCE,
        contact: { name: d.contact, email, company: d.company },
        need: d.need,
        budgetPaise: tier.pricePaise,
        score: 40 + (d.company.length % 50),
        stage,
        lostReason: stage === 'lost' ? (d.lostReason ?? 'Not a fit') : null,
        ownerId: sales,
        serviceIds: [service.id],
        createdAt: ago(d.leadAgo),
      },
    });
    // Stage history for the flow map (days in stage).
    if (stage === 'contacted' || stage === 'discovery') await audit(`lead.${stage}`, 'Lead', lead.id, ago(d.leadAgo), sales, { stage });
    if (stage === 'lost' && d.rejectedAgo === undefined) await audit('lead.lost', 'Lead', lead.id, ago(Math.max(0, d.leadAgo - 6)), sales, { stage });
    if (d.sentAgo === undefined) continue;

    // Proposal (prices are a snapshot): 50% advance for projects, one month for retainers.
    const net = tier.pricePaise;
    const oneTime = service.billingType === 'one_time';
    const dueNow = oneTime ? Math.round(net / 2) : net;
    const gst = Math.round(net * 0.18);
    const status: ProposalStatus = d.acceptedAgo !== undefined ? 'accepted' : d.rejectedAgo !== undefined ? 'rejected' : 'sent';
    const proposal = await prisma.proposal.create({
      data: {
        orgId,
        leadId: lead.id,
        priceBookId: book.id,
        lines: [{ kind: 'service', key: service.key, name: service.name, tier: d.tier, billingType: service.billingType, unitPaise: net, qty: 1, grossPaise: net, bundleDiscountPaise: 0, extraDiscountPaise: 0, netPaise: net, dueNowPaise: dueNow }],
        subtotalPaise: net,
        gstPaise: gst,
        totalPaise: net + gst,
        validUntil: new Date(ago(d.sentAgo).getTime() + 15 * DAY),
        status,
        createdById: sales,
        sentAt: ago(d.sentAgo),
        viewedAt: d.sentAgo > 2 ? ago(d.sentAgo - 1) : null,
        acceptedAt: d.acceptedAgo !== undefined ? ago(d.acceptedAgo) : null,
        createdAt: ago(d.sentAgo + 1),
      },
    });
    await audit('proposal.sent', 'Proposal', proposal.id, ago(d.sentAgo), sales);
    if (d.rejectedAgo !== undefined) await audit('lead.lost', 'Lead', lead.id, ago(d.rejectedAgo), sales, { stage: 'lost' });
    if (d.acceptedAgo === undefined) continue;
    await audit('proposal.accepted', 'Proposal', proposal.id, ago(d.acceptedAgo), null, { signer: d.contact });
    await prisma.agreement.create({ data: { orgId, proposalId: proposal.id, signedAt: ago(d.acceptedAgo), signer: { name: d.contact, email } } });
    const advGst = Math.round(dueNow * 0.18);
    const advance = await prisma.invoice.create({
      data: {
        orgId,
        number: nextNumber(),
        lines: [{ label: `${service.name} (${d.tier}): ${oneTime ? '50% advance' : 'first month'}`, amountPaise: dueNow }, { label: 'GST 18%', amountPaise: advGst }],
        subtotalPaise: dueNow,
        gstPaise: advGst,
        totalPaise: dueNow + advGst,
        dueDate: new Date(ago(d.acceptedAgo).getTime() + 3 * DAY),
        status: won ? 'paid' : 'issued',
        proposalId: proposal.id,
        kind: 'first_payment',
        createdAt: ago(d.acceptedAgo),
      },
    });
    if (!won) continue;
    await prisma.payment.create({ data: { orgId, invoiceId: advance.id, amountPaise: dueNow + advGst, method: 'razorpay', at: ago(d.paidAgo!), ref: `pay_flow_${advance.id.slice(-8)}` } });
    await audit('invoice.paid', 'Invoice', advance.id, ago(d.paidAgo!), null, { amountPaise: dueNow + advGst, method: 'razorpay' });

    // Client account (with an owner who signs in by OTP) and engagement.
    let client = d.clientName ? await prisma.clientOrg.findFirst({ where: { orgId, name: d.clientName } }) : null;
    if (client && !client.leadId) client = await prisma.clientOrg.update({ where: { id: client.id }, data: { leadId: lead.id } });
    if (!client) {
      client = await prisma.clientOrg.create({ data: { orgId, leadId: lead.id, name: d.company, amUserId: am, tenureStart: ago(d.paidAgo!), createdAt: ago(d.paidAgo!) } });
      const owner = (await prisma.user.findFirst({ where: { orgId, email } })) ?? (await prisma.user.create({ data: { orgId, type: 'client', name: d.contact, email, status: 'active', createdAt: ago(d.paidAgo!) } }));
      await prisma.clientUser.upsert({ where: { userId: owner.id }, update: {}, create: { userId: owner.id, orgId, clientOrgId: client.id, clientRole: 'client_owner', brandScope: [] } });
      if (ownerRole) await prisma.userRole.upsert({ where: { userId_roleId_scopeRef: { userId: owner.id, roleId: ownerRole.id, scopeRef: '' } }, update: {}, create: { userId: owner.id, roleId: ownerRole.id } });
    }
    await prisma.invoice.update({ where: { id: advance.id }, data: { clientOrgId: client.id } });
    if (!(await prisma.thread.findFirst({ where: { clientOrgId: client.id, type: 'client_am' } }))) await prisma.thread.create({ data: { orgId, clientOrgId: client.id, type: 'client_am' } });
    const clientOwner = await prisma.clientUser.findFirst({ where: { clientOrgId: client.id, clientRole: 'client_owner' } });
    const decider = clientOwner?.userId ?? founder!;

    const rcd = d.rcdAgo !== undefined ? ago(d.rcdAgo) : null;
    const planningDue = rcd ? addWorkingDays(rcd, 4, holidays) : null;
    const work = d.work ?? [];
    const allApproved = work.length > 0 && work.every((w) => w.approvedAgo !== undefined);
    const anyWithClient = work.some((w) => w.approvedAgo === undefined && w.v1Ago !== undefined && (w.changesAgo === undefined || w.v2Ago !== undefined));
    let engStatus: EngagementStatus;
    let gate: string;
    if (d.offboardAgo !== undefined) [engStatus, gate] = ['offboarding', 'G5'];
    else if (d.g5Ago !== undefined) [engStatus, gate] = ['delivered', 'G5'];
    else if (d.g4Ago !== undefined || allApproved) [engStatus, gate] = [oneTime ? 'awaiting_final_payment' : 'active_retainer', 'G5'];
    else if (d.planApprovedAgo !== undefined) [engStatus, gate] = [anyWithClient ? 'in_review' : 'in_production', 'G4'];
    else if (rcd) [engStatus, gate] = [d.planSentAgo !== undefined ? 'awaiting_plan_approval' : 'planning', 'G2'];
    else [engStatus, gate] = ['onboarding', 'G1'];

    const engagement = await prisma.engagement.create({
      data: {
        orgId,
        clientOrgId: client.id,
        serviceId: service.id,
        tier: d.tier,
        billingType: service.billingType,
        status: engStatus,
        currentGate: gate,
        amId: am,
        startDate: ago(d.paidAgo!),
        finalSignedOffAt: d.signOffAgo !== undefined ? ago(d.signOffAgo) : null,
        createdAt: ago(d.paidAgo!),
      },
    });
    await audit('client.onboarded', 'ClientOrg', client.id, ago(d.paidAgo!), null, { invoiceId: advance.id });
    const firstDraftDue = work.length ? new Date(now + Math.max(...work.map((w) => w.dueIn)) * DAY) : null;
    const cycle = await prisma.cycle.create({
      data: {
        orgId,
        engagementId: engagement.id,
        period: oneTime ? 'project' : ago(d.paidAgo!).toISOString().slice(0, 7),
        rcdAt: rcd,
        planningDue,
        firstDraftDue: d.planApprovedAgo !== undefined ? firstDraftDue : null,
        status: d.planApprovedAgo !== undefined ? 'production' : rcd ? 'planning' : 'onboarding',
      },
    });
    const receivedCount = rcd ? REQUIREMENTS.length : (d.received ?? 0);
    for (const [i, r] of REQUIREMENTS.entries()) {
      const waiting = i === receivedCount && !rcd;
      const item = await prisma.requirementItem.create({
        data: { orgId, cycleId: cycle.id, label: r.label, type: r.type, ownerId: am, status: i < receivedCount ? 'received' : waiting ? 'waiting' : 'pending', waitingFor: waiting ? 'Client' : null, dateRequested: ago(d.paidAgo!) },
      });
      if (i < receivedCount) {
        const start = d.paidAgo!;
        const end = d.rcdAgo ?? Math.max(0, start - 3);
        await audit('requirement.received', 'RequirementItem', item.id, ago(start - ((start - end) * (i + 1)) / (REQUIREMENTS.length + 0.5)), am, { status: 'received' });
      }
    }
    if (!rcd) continue;
    await prisma.approval.create({ data: { orgId, targetType: 'engagement', targetId: engagement.id, gate: 'G1', userId: am ?? founder!, at: rcd } });
    await audit('gate.G1.passed', 'Engagement', engagement.id, rcd, am, { rcdAt: rcd.toISOString(), planningDue: planningDue?.toISOString() });

    // Plan (G2)
    const planContent = {
      objectives: `${d.need} for ${d.company}.`,
      audience: 'Customers in Bengaluru',
      pillars: ['Trust', 'Local pride', 'Quality'],
      creativeDirection: 'Clean, warm and confident.',
      deliverables: work.map((w) => ({ type: w.type, title: w.title })),
    };
    const planApprovedAt = d.planApprovedAgo === undefined ? null : d.approvedDaysEarly !== undefined && planningDue ? new Date(planningDue.getTime() - d.approvedDaysEarly * DAY - 3 * 3_600_000) : ago(d.planApprovedAgo);
    const planStatus = d.planApprovedAgo !== undefined ? 'approved' : d.planSentAgo !== undefined ? 'sent_to_client' : 'draft';
    const plan = await prisma.plan.create({
      data: { orgId, cycleId: cycle.id, content: planContent, status: planStatus, approvedById: d.planApprovedAgo !== undefined ? decider : null, approvedAt: planApprovedAt },
    });
    if (d.planSentAgo !== undefined) {
      await audit('plan.submitted', 'Engagement', engagement.id, new Date(ago(d.planSentAgo).getTime() - 3 * 3_600_000), strategist);
      await audit('plan.sent_to_client', 'Engagement', engagement.id, ago(d.planSentAgo), am);
    }
    if (d.planChangesAgo !== undefined) {
      await audit('plan.changes_requested', 'Plan', plan.id, ago(d.planChangesAgo), decider, { comment: 'Please add a festive campaign in the first month.' });
      await audit('plan.sent_to_client', 'Engagement', engagement.id, ago(d.planChangesAgo - 0.5), am);
    }
    if (planStatus === 'draft') {
      // Planning task, past its deadline when the plan is late.
      await prisma.task.create({ data: { orgId, title: `Plan ${service.name} for ${client.name}`, flowStep: 'planning', kind: 'planning', engagementId: engagement.id, ownerId: strategist ?? am, deadline: planningDue, status: 'in_progress', startedAt: rcd, createdAt: rcd } });
    }
    if (d.lateRequest) {
      await prisma.request.create({
        data: { orgId, engagementId: engagement.id, type: 'question', description: 'When will we see the SEO plan? Our new clinic opens next month.', status: 'received', slaDue: ago(2), createdById: decider, createdAt: ago(2.3) },
      });
    }
    if (d.planApprovedAgo === undefined) continue;
    const approvedAt = planApprovedAt!;
    await prisma.approval.create({ data: { orgId, targetType: 'plan', targetId: plan.id, gate: 'G2', userId: decider, at: approvedAt } });
    await audit('gate.G2.passed', 'Plan', plan.id, approvedAt, decider, { status: 'approved', deliverables: work.length });

    // Deliverables, tasks, versions, QC and client decisions (G3, G4)
    const tasksAt = new Date(approvedAt.getTime() + 3_600_000);
    let taskCount = 0;
    for (const w of work) {
      const status = w.approvedAgo !== undefined ? 'approved' : w.changesAgo !== undefined && w.v2Ago === undefined ? 'changes_requested' : w.v1Ago !== undefined ? 'ready_for_client' : 'in_production';
      const deliverable = await prisma.deliverable.create({
        data: { orgId, cycleId: cycle.id, type: w.type, title: w.title, status, dueAt: new Date(now + w.dueIn * DAY), revisionRoundsUsed: w.changesAgo !== undefined ? 1 : 0 },
      });
      const steps = [
        { title: `${w.title}: create`, kind: 'work', role: 'producer', done: w.v1Ago !== undefined },
        { title: `${w.title}: QC review`, kind: 'qc', role: 'qc_reviewer', done: w.v1Ago !== undefined },
        { title: `${w.title}: client review`, kind: 'client_review', role: 'account_manager', done: w.approvedAgo !== undefined },
      ];
      for (const [i, s] of steps.entries()) {
        const overdue = !!d.overdueTask && i === 0;
        await prisma.task.create({
          data: {
            orgId,
            deliverableId: deliverable.id,
            engagementId: engagement.id,
            title: s.title,
            flowStep: s.kind,
            kind: s.kind,
            role: s.role,
            sort: i,
            ownerId: s.kind === 'qc' ? qc : s.kind === 'client_review' ? am : producer,
            status: s.done ? 'done' : overdue || (i === 2 && w.v1Ago !== undefined) ? 'in_progress' : 'todo',
            deadline: overdue ? ago(2) : new Date(now + (w.dueIn - 2 + i) * DAY),
            startedAt: overdue ? ago(5) : null,
            completedAt: s.done ? ago(i === 2 ? w.approvedAgo! : w.v1Ago!) : null,
            timeLoggedMin: s.done || overdue ? 90 + i * 30 : 0,
            createdAt: tasksAt,
          },
        });
        taskCount++;
      }
      const rounds = [
        { n: 1, sent: w.v1Ago },
        { n: 2, sent: w.v2Ago },
      ].filter((x) => x.sent !== undefined);
      let lastVersionId: string | null = null;
      for (const r of rounds) {
        const sentAt = ago(r.sent!);
        const file = await prisma.file.create({
          data: { orgId, clientOrgId: client.id, path: `https://picsum.photos/seed/${encodeURIComponent(`${d.company}-${w.title}-${r.n}`.replace(/\s+/g, '-'))}/1200/800`, kind: 'link', name: `${w.title} v${r.n}`, released: d.g5Ago !== undefined, createdAt: sentAt },
        });
        const version = await prisma.version.create({
          data: { orgId, deliverableId: deliverable.id, fileId: file.id, number: r.n, uploadedById: producer ?? am!, sentToClientAt: sentAt, sentById: am, createdAt: new Date(sentAt.getTime() - 20 * 3_600_000) },
        });
        if (qcChecklist && qc)
          await prisma.qCResult.create({ data: { orgId, versionId: version.id, checklistId: qcChecklist.id, items: [], result: 'pass', reviewerId: qc, createdAt: new Date(sentAt.getTime() - 4 * 3_600_000) } });
        await audit('version.sent_to_client', 'Version', version.id, sentAt, am, { number: r.n });
        lastVersionId = version.id;
      }
      if (w.changesAgo !== undefined) await audit('deliverable.changes_requested', 'Deliverable', deliverable.id, ago(w.changesAgo), decider, { round: 1, included: 2 });
      if (w.approvedAgo !== undefined && lastVersionId) {
        await prisma.deliverable.update({ where: { id: deliverable.id }, data: { approvedVersionId: lastVersionId } });
        await prisma.approval.create({ data: { orgId, targetType: 'deliverable', targetId: deliverable.id, gate: 'G4', userId: decider, at: ago(w.approvedAgo), versionId: lastVersionId } });
        await audit('deliverable.approved', 'Deliverable', deliverable.id, ago(w.approvedAgo), decider);
      }
    }
    await audit('gate.G3.passed', 'Engagement', engagement.id, tasksAt, null, { created: taskCount, unassigned: 0, overdueInvoices: 0, g3Passed: true });

    // Monthly retainer invoices from the second month (paid within a few days, the latest still open).
    if (!oneTime) {
      for (let m = d.paidAgo! - 30; m > 0; m -= 30) {
        if (d.offboardAgo !== undefined && m < d.offboardAgo) break;
        const paid = m > 8 || d.offboardAgo !== undefined;
        const g = Math.round(net * 0.18);
        const inv = await prisma.invoice.create({
          data: { orgId, clientOrgId: client.id, engagementId: engagement.id, number: nextNumber(), kind: 'retainer', lines: [{ label: `${service.name} (${d.tier}): monthly retainer`, amountPaise: net }, { label: 'GST 18%', amountPaise: g }], subtotalPaise: net, gstPaise: g, totalPaise: net + g, dueDate: ago(m - 7), status: paid ? 'paid' : 'issued', createdAt: ago(m) },
        });
        if (paid) await prisma.payment.create({ data: { orgId, invoiceId: inv.id, amountPaise: net + g, method: 'bank_transfer', at: ago(Math.max(0.5, m - 4)) } });
      }
    }
    if (d.g4Ago === undefined && !allApproved) continue;
    const g4At = ago(d.g4Ago ?? Math.min(...work.map((w) => w.approvedAgo!)));
    await audit('gate.G4.passed', 'Engagement', engagement.id, g4At, null, { deliverables: work.length });

    // Project balance and final delivery (G5)
    if (oneTime) {
      const balance = net - dueNow;
      const bGst = Math.round(balance * 0.18);
      const paid = d.g5Ago !== undefined;
      const inv = await prisma.invoice.create({
        data: {
          orgId,
          clientOrgId: client.id,
          engagementId: engagement.id,
          number: nextNumber(),
          kind: 'project_balance',
          lines: [{ label: `${service.name} (${d.tier}): balance before handover`, amountPaise: balance }, { label: 'GST 18%', amountPaise: bGst }],
          subtotalPaise: balance,
          gstPaise: bGst,
          totalPaise: balance + bGst,
          dueDate: new Date(g4At.getTime() + 7 * DAY),
          status: paid ? 'paid' : 'issued',
          createdAt: g4At,
        },
      });
      await audit('invoice.issued', 'Invoice', inv.id, g4At, null, { kind: 'project_balance', totalPaise: inv.totalPaise });
      if (paid) {
        await prisma.payment.create({ data: { orgId, invoiceId: inv.id, amountPaise: balance + bGst, method: 'razorpay', at: ago(d.g5Ago! + 0.2), ref: `pay_flow_${inv.id.slice(-8)}` } });
        await audit('invoice.paid', 'Invoice', inv.id, ago(d.g5Ago! + 0.2), null, { amountPaise: balance + bGst });
      }
    }
    if (d.signOffAgo !== undefined) {
      await prisma.approval.create({ data: { orgId, targetType: 'engagement', targetId: engagement.id, gate: 'G5', userId: decider, at: ago(d.signOffAgo) } });
      await audit('engagement.final_sign_off', 'Engagement', engagement.id, ago(d.signOffAgo), decider, { at: ago(d.signOffAgo).toISOString() });
    }
    if (d.g5Ago !== undefined) await audit('gate.G5.passed', 'Engagement', engagement.id, ago(d.g5Ago), null, { filesReleased: work.length });
    if (d.offboardAgo !== undefined) await audit('engagement.lifecycle.offboard', 'Engagement', engagement.id, ago(d.offboardAgo), founder, { status: 'offboarding', reason: 'Moving marketing in-house' });
  }
  if (created) console.log(`Flows: added ${created} demo deals across the business flow.`);
}
