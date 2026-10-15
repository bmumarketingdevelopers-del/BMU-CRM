import { DEFAULT_QC_CHECKLISTS, addWorkingMinutes, financialYear, workCalendar, type WorkCalendar } from '@bmu/shared';
import type { Prisma, PrismaClient, Tier } from '../../src/generated/prisma/client.js';
import { sameDept } from './dept-names.js';

/**
 * v9 operations analytics demo data: six months of delivery history so Team Performance, Delivery Speed,
 * SLA & Response, My performance and Client Insights have real numbers.
 *
 * - Six extra staff (…@ops.demo) in Design, Video, Web, Ads, Strategy and QC. They also carry a heavy open
 *   workload for the next four weeks, so the least-loaded assignment in production.e2e still picks the
 *   regular demo users.
 * - Clients (stable names): a new SEO retainer for Sunrise Realty, Kaveri Silks (design retainer), Coastal Brew
 *   Co. (video retainer) and Nimbus Fitness Studio (website project, signed off at G5).
 * - Per monthly cycle: G1/G2 approvals, tasks with start/finish/deadline/time, versions with QC passes and
 *   fails, client revision rounds, G4 approvals; client requests across the week (some past the reply time),
 *   message threads, invoices and payments; saved reports for the founder.
 * Idempotent: every block checks before creating.
 */

const DAY = 86_400_000;
const IST = 330 * 60_000;

/** Deterministic pseudo-random numbers so a fresh seed always looks the same. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `back` months ago, on day `day`, at hh:mm IST. */
const monthAt = (back: number, day: number, hour = 11, minute = 0) => {
  const ist = new Date(Date.now() + IST);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - back, day, hour, minute) - IST);
};
const daysAgo = (days: number, hour = 11, minute = 0) => {
  const ist = new Date(Date.now() - days * DAY + IST);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), hour, minute) - IST);
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (d: Date) => MONTHS[new Date(d.getTime() + IST).getUTCMonth()];
const period = (d: Date) => new Date(d.getTime() + IST).toISOString().slice(0, 7);

const STAFF = [
  { email: 'divya.menon@ops.demo', name: 'Divya Menon', role: 'producer', dept: 'Creative / Design', load: 30 },
  { email: 'farhan.qureshi@ops.demo', name: 'Farhan Qureshi', role: 'producer', dept: 'Video / Production', load: 26 },
  { email: 'kavya.nair@ops.demo', name: 'Kavya Nair', role: 'producer', dept: 'Web / AI', load: 24 },
  { email: 'ishaan.kapoor@ops.demo', name: 'Ishaan Kapoor', role: 'producer', dept: 'Performance Ads', load: 22 },
  { email: 'tanvi.desai@ops.demo', name: 'Tanvi Desai', role: 'strategist', dept: 'Strategy', load: 24 },
  { email: 'sana.sheikh@ops.demo', name: 'Sana Sheikh', role: 'qc_reviewer', dept: 'QC', load: 22 },
] as const;
type StaffEmail = (typeof STAFF)[number]['email'];

type DelivPlan = { type: string; title: string; flow: string; dept: string };
const PLANS: Record<string, DelivPlan[]> = {
  seo: [
    { type: 'blog', title: 'Blog: locality guide', flow: 'writing', dept: 'SEO' },
    { type: 'blog', title: 'Blog: buyer checklist', flow: 'writing', dept: 'SEO' },
    { type: 'post', title: 'Search ad creatives', flow: 'design', dept: 'Performance Ads' },
  ],
  graphic_design: [
    { type: 'post', title: 'Festive offer post', flow: 'design', dept: 'Creative / Design' },
    { type: 'carousel', title: 'New collection carousel', flow: 'design', dept: 'Creative / Design' },
    { type: 'post', title: 'Store event poster', flow: 'design', dept: 'Creative / Design' },
    { type: 'story', title: 'Weekend sale stories', flow: 'design', dept: 'Creative / Design' },
  ],
  video_editing: [
    { type: 'reel', title: 'Barista reel', flow: 'video', dept: 'Video / Production' },
    { type: 'reel', title: 'New menu reel', flow: 'video', dept: 'Video / Production' },
    { type: 'post', title: 'Menu card design', flow: 'design', dept: 'Creative / Design' },
  ],
  website: [
    { type: 'web_page', title: 'Home page', flow: 'web', dept: 'Web / AI' },
    { type: 'web_page', title: 'Classes and timetable page', flow: 'web', dept: 'Web / AI' },
    { type: 'web_page', title: 'Trainers page', flow: 'web', dept: 'Web / AI' },
    { type: 'web_page', title: 'Membership and pricing page', flow: 'web', dept: 'Web / AI' },
  ],
};

const REQUESTS: { type: 'change' | 'new_scope' | 'urgent' | 'question' | 'billing'; text: string }[] = [
  { type: 'change', text: 'Please change the headline colour on the latest post' },
  { type: 'question', text: 'When will next week’s posts be ready?' },
  { type: 'change', text: 'Swap the photo on carousel slide 3' },
  { type: 'urgent', text: 'Wrong phone number on the live ad, please fix today' },
  { type: 'new_scope', text: 'Can you also make a short video for the launch?' },
  { type: 'billing', text: 'Please resend last month’s invoice with our GSTIN' },
  { type: 'question', text: 'Can we see the analytics for last month?' },
  { type: 'change', text: 'Use the new logo on all upcoming creatives' },
];

export async function seedOpsAnalytics(prisma: PrismaClient, orgId: string) {
  const user = (email: string) => prisma.user.findFirst({ where: { orgId, email } });
  const [am, amLead, producer, strategist, qc, founder, clientOwner, approver] = await Promise.all(
    ['am@bmu.demo', 'am.lead@bmu.demo', 'producer@bmu.demo', 'strategist@bmu.demo', 'qc@bmu.demo', 'founder@bmu.demo', 'client@sunrise.demo', 'approver@sunrise.demo'].map(user),
  );
  const sunrise = await prisma.clientOrg.findFirst({ where: { orgId, name: 'Sunrise Realty Pvt Ltd' } });
  if (!am || !producer || !strategist || !qc || !founder || !sunrise || !clientOwner) return; // core seed did not run

  const org = await prisma.organisation.findUniqueOrThrow({ where: { id: orgId }, select: { settings: true } });
  const st = (org.settings ?? {}) as { holidays?: string[]; v8?: { workingHours?: { start: string; end: string; days: number[] } } };
  const cal: WorkCalendar = workCalendar(st.holidays ?? [], st.v8?.workingHours);
  const dayMin = cal.endMin - cal.startMin;
  /** `n` working days (fractions allowed) after `from`. */
  const wd = (from: Date, n: number) => addWorkingMinutes(from, Math.max(1, Math.round(n * dayMin)), cal);
  const now = new Date();
  const past = (d: Date) => d < now;

  const depts = await prisma.department.findMany({ where: { orgId }, select: { id: true, name: true, branchId: true } });
  const dept = (name: string) => depts.find((d) => sameDept(d.name, name));
  const role = (baseRole: string) => prisma.role.findFirst({ where: { orgId, baseRole, isCustom: false } });

  // --- Staff ---------------------------------------------------------------
  const staff: Record<string, { id: string; name: string }> = {};
  for (const s of STAFF) {
    let u = await user(s.email);
    if (!u) {
      const d = dept(s.dept);
      const r = await role(s.role);
      u = await prisma.user.create({
        data: { orgId, type: 'staff', name: s.name, email: s.email, status: 'active', departmentId: d?.id, branchId: d?.branchId, createdAt: daysAgo(400), ...(r ? { roles: { create: { roleId: r.id } } } : {}) },
      });
    }
    staff[s.email] = { id: u.id, name: u.name };
  }
  const S = (email: StaffEmail) => staff[email].id;
  const producersFor = (deptName: string) =>
    deptName === 'Creative / Design'
      ? [producer.id, S('divya.menon@ops.demo')]
      : deptName === 'Video / Production'
        ? [S('farhan.qureshi@ops.demo'), producer.id]
        : deptName === 'Web / AI'
          ? [S('kavya.nair@ops.demo')]
          : deptName === 'Performance Ads'
            ? [S('ishaan.kapoor@ops.demo')]
            : [producer.id, S('divya.menon@ops.demo')];
  const strategists = [strategist.id, S('tanvi.desai@ops.demo')];
  const qcs = [qc.id, S('sana.sheikh@ops.demo')];
  // Open work in the current month only goes to the seeded staff (never to the regular demo users).
  const seededLoadOwner: Record<string, string> = {
    'Creative / Design': S('divya.menon@ops.demo'),
    'Video / Production': S('farhan.qureshi@ops.demo'),
    'Web / AI': S('kavya.nair@ops.demo'),
    'Performance Ads': S('ishaan.kapoor@ops.demo'),
    SEO: S('divya.menon@ops.demo'),
  };

  // --- Clients ---------------------------------------------------------------
  const ownerRole = await role('client_owner');
  async function ensureClient(name: string, industry: string, ownerName: string, ownerEmail: string, amUserId: string, days: number) {
    const client =
      (await prisma.clientOrg.findFirst({ where: { orgId, name } })) ??
      (await prisma.clientOrg.create({ data: { orgId, name, industry, amUserId, tenureStart: daysAgo(days), createdAt: daysAgo(days) } }));
    const owner =
      (await user(ownerEmail)) ??
      (await prisma.user.create({ data: { orgId, type: 'client', name: ownerName, email: ownerEmail, status: 'active', ...(ownerRole ? { roles: { create: { roleId: ownerRole.id } } } : {}) } }));
    if (!(await prisma.clientUser.findUnique({ where: { userId: owner.id } }))) {
      await prisma.clientUser.create({ data: { userId: owner.id, orgId, clientOrgId: client.id, clientRole: 'client_owner', brandScope: [] } });
    }
    return { client, owner };
  }
  const lead = amLead ?? am;
  const kaveri = await ensureClient('Kaveri Silks', 'Retail & fashion', 'Anitha Raghavan', 'owner@kaveri.demo', lead.id, 175);
  const coastal = await ensureClient('Coastal Brew Co.', 'Cafe & food', 'Joel Fernandes', 'owner@coastalbrew.demo', am.id, 125);
  const nimbus = await ensureClient('Nimbus Fitness Studio', 'Fitness', 'Ritu Sharma', 'owner@nimbusfit.demo', lead.id, 160);

  const service = (key: string) => prisma.service.findFirst({ where: { key, priceBook: { orgId, status: 'active' } }, include: { tiers: true } });
  type Job = { key: string; client: { id: string; name: string }; ownerId: string; approverId: string; amId: string; tier: Tier; billing: 'monthly' | 'one_time'; startDays: number; seed: number; speed: number };
  const jobs: Job[] = [
    { key: 'seo', client: sunrise, ownerId: clientOwner.id, approverId: approver?.id ?? clientOwner.id, amId: am.id, tier: 'growth', billing: 'monthly', startDays: 178, seed: 11, speed: 1 },
    { key: 'graphic_design', client: kaveri.client, ownerId: kaveri.owner.id, approverId: kaveri.owner.id, amId: lead.id, tier: 'growth', billing: 'monthly', startDays: 172, seed: 23, speed: 1.3 },
    { key: 'video_editing', client: coastal.client, ownerId: coastal.owner.id, approverId: coastal.owner.id, amId: am.id, tier: 'starter', billing: 'monthly', startDays: 122, seed: 37, speed: 0.9 },
    { key: 'website', client: nimbus.client, ownerId: nimbus.owner.id, approverId: nimbus.owner.id, amId: lead.id, tier: 'growth', billing: 'one_time', startDays: 158, seed: 41, speed: 1.1 },
  ];

  // Invoice numbers: next free BMU/<FY>/NNNN (same series as BillingService).
  const invoiceNumber = async (at: Date) => {
    const fy = financialYear(at);
    const rows = await prisma.invoice.findMany({ where: { orgId, number: { startsWith: `BMU/${fy}/` } }, select: { number: true } });
    const max = rows.map((r) => Number(r.number.split('/').at(-1))).filter(Number.isFinite).reduce((m, n) => Math.max(m, n), 0);
    return `BMU/${fy}/${String(max + 1).padStart(4, '0')}`;
  };
  const addInvoice = async (job: Job, engagementId: string, at: Date, kind: string, label: string, net: number, payDays: number | null) => {
    if (!past(at)) return;
    const gst = Math.round(net * 0.18);
    const total = net + gst;
    const paid = payDays !== null && past(new Date(at.getTime() + payDays * DAY));
    const number = await invoiceNumber(at);
    const inv = await prisma.invoice.create({
      data: {
        orgId,
        clientOrgId: job.client.id,
        engagementId,
        kind,
        number,
        lines: [{ label, amountPaise: net }, { label: 'GST 18%', amountPaise: gst }],
        subtotalPaise: net,
        gstPaise: gst,
        totalPaise: total,
        dueDate: new Date(at.getTime() + 7 * DAY),
        status: paid ? 'paid' : 'issued',
        createdAt: at,
      },
    });
    if (paid)
      await prisma.payment.create({
        data: { orgId, invoiceId: inv.id, amountPaise: total, method: payDays! % 2 ? 'upi' : 'razorpay', at: new Date(at.getTime() + payDays! * DAY + 3 * 3600_000), ref: `OPS-DEMO-${number.replace(/\//g, '-')}` },
      });
  };

  for (const job of jobs) {
    const svc = await service(job.key);
    if (!svc) continue;
    if (await prisma.engagement.findFirst({ where: { orgId, clientOrgId: job.client.id, serviceId: svc.id } })) continue; // already seeded
    const rand = rng(job.seed);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
    const between = (a: number, b: number) => a + rand() * (b - a);
    const price = svc.tiers.find((t) => t.tier === job.tier)?.pricePaise ?? 2_500_000;
    const signed = daysAgo(job.startDays, 12);
    const oneTime = job.billing === 'one_time';
    const engagement = await prisma.engagement.create({
      data: {
        orgId,
        clientOrgId: job.client.id,
        serviceId: svc.id,
        tier: job.tier,
        billingType: job.billing,
        status: oneTime ? 'delivered' : 'active_retainer',
        currentGate: oneTime ? 'G5' : 'G4',
        amId: job.amId,
        startDate: signed,
        createdAt: signed,
      },
    });
    const checklist = (flow: string) => DEFAULT_QC_CHECKLISTS.find((c) => c.key === flow)?.items ?? DEFAULT_QC_CHECKLISTS[0].items;

    // Cycles: monthly for retainers (oldest first), one project cycle for the website.
    const ym = (d: Date) => {
      const x = new Date(d.getTime() + IST);
      return x.getUTCFullYear() * 12 + x.getUTCMonth();
    };
    const firstBack = ym(now) - ym(signed);
    const months = oneTime ? [0] : Array.from({ length: firstBack + 1 }, (_, i) => firstBack - i);
    let lastApproval: Date | null = null;
    for (const [ci, back] of months.entries()) {
      const isCurrent = !oneTime && back === 0;
      // The current month started a little earlier so there is live work in production today.
      const rcd = oneTime || ci === 0 ? wd(signed, between(3, 6) * job.speed) : isCurrent ? daysAgo(Math.round(between(9, 12)), 11) : wd(monthAt(back, 1, 10), between(1, 3));
      if (!past(rcd)) continue;
      const cycle = await prisma.cycle.create({
        data: { orgId, engagementId: engagement.id, period: oneTime ? 'project' : period(isCurrent ? monthAt(0, 1) : rcd), rcdAt: rcd, status: isCurrent ? 'production' : 'delivered' },
      });
      if (ci === 0) await prisma.approval.create({ data: { orgId, targetType: 'engagement', targetId: engagement.id, gate: 'G1', userId: job.amId, at: rcd } });

      // G2: the plan. Usually the slowest wait, because the client reviews it.
      const planAt = isCurrent ? wd(rcd, between(2, 3)) : wd(rcd, between(2.5, 6.5) * job.speed);
      const deliverablePlans = PLANS[job.key];
      const planApproved = past(planAt);
      const plan = await prisma.plan.create({
        data: {
          orgId,
          cycleId: cycle.id,
          status: planApproved ? 'approved' : 'sent_to_client',
          approvedById: planApproved ? job.ownerId : null,
          approvedAt: planApproved ? planAt : null,
          content: {
            objectives: `${svc.name} for ${job.client.name}`,
            audience: 'Existing and new customers',
            pillars: ['Offers', 'Trust'],
            creativeDirection: 'Clean, on brand',
            deliverables: deliverablePlans.map((d) => ({ type: d.type, title: d.title })),
          },
        },
      });
      if (!planApproved) continue;
      await prisma.approval.create({ data: { orgId, targetType: 'plan', targetId: plan.id, gate: 'G2', userId: job.ownerId, at: planAt } });

      for (const [di, dp] of deliverablePlans.entries()) {
        const d = dept(dp.dept);
        const stagger = di * between(0.4, 1.2);
        const dueAt = wd(planAt, 12 + stagger * 1.5 + (oneTime ? 6 : 0));
        const title = oneTime ? dp.title : `${dp.title} (${monthName(isCurrent ? monthAt(0, 1) : rcd)})`;
        const deliverable = await prisma.deliverable.create({ data: { orgId, cycleId: cycle.id, type: dp.type, title, status: 'in_production', departmentId: d?.id, flowKey: dp.flow, dueAt } });

        // Tasks: brief → make → QC (client review is added when the client approves).
        const makeOwners = isCurrent ? [seededLoadOwner[dp.dept] ?? S('divya.menon@ops.demo')] : producersFor(dp.dept);
        const steps = [
          { key: 'brief', title: `Brief: ${title}`, owner: isCurrent ? S('tanvi.desai@ops.demo') : pick(strategists), days: between(0.4, 1.4) * job.speed, plan: 1, role: 'strategist', min: [60, 180], dept: 'Strategy' },
          { key: 'make', title: `Make: ${title}`, owner: pick(makeOwners), days: between(1.2, 4) * job.speed, plan: 2.5, role: 'producer', min: [240, 720], dept: dp.dept },
          { key: 'qc', title: `QC: ${title}`, owner: isCurrent ? S('sana.sheikh@ops.demo') : pick(qcs), days: between(0.2, 1), plan: 1, role: 'qc_reviewer', min: [30, 90], dept: 'QC' },
        ];
        let cursor = wd(planAt, between(0.2, 1) + stagger);
        let planned = planAt;
        const makeOwner = steps[1].owner;
        let finishedAll = true;
        for (const [si, s] of steps.entries()) {
          const start = cursor;
          const end = wd(start, s.days);
          // Deadlines: most steps have some slack, about one in five runs late.
          planned = wd(start, s.days * (rand() < 0.8 ? between(1.1, 1.9) : between(0.4, 0.9)));
          const done = past(end) && !(isCurrent && si >= 1);
          if (!done) finishedAll = false;
          await prisma.task.create({
            data: {
              orgId,
              deliverableId: deliverable.id,
              engagementId: engagement.id,
              title: s.title,
              flowStep: s.key,
              ownerId: s.owner,
              departmentId: dept(s.dept)?.id,
              deadline: planned,
              status: done ? 'done' : past(start) ? 'in_progress' : 'todo',
              kind: s.key === 'qc' ? 'qc' : 'work',
              role: s.role,
              sort: si,
              timeLoggedMin: done ? Math.round(between(s.min[0], s.min[1]) / 15) * 15 : past(start) ? 60 : 0,
              startedAt: past(start) ? start : null,
              completedAt: done ? end : null,
              createdAt: planAt,
            },
          });
          cursor = end;
          if (!done) break;
        }
        if (!finishedAll) continue;

        // Versions: QC can fail first; the client can ask for changes (revision rounds).
        const roll = rand();
        const rounds = roll < 0.35 ? 0 : roll < 0.7 ? 1 : roll < 0.9 ? 2 : 3;
        let at = cursor;
        let version = 0;
        let lastSent: Date | null = null;
        let approvedVersionId: string | null = null;
        for (let round = 0; round <= rounds; round++) {
          let passed = false;
          while (!passed) {
            version++;
            const file = await prisma.file.create({
              data: { orgId, clientOrgId: job.client.id, path: `demo/ops/${deliverable.id}-v${version}.png`, kind: 'image', name: `${dp.type}-v${version}.png`, mimeType: 'image/png', createdAt: at },
            });
            const v = await prisma.version.create({ data: { orgId, deliverableId: deliverable.id, fileId: file.id, number: version, uploadedById: makeOwner, createdAt: at } });
            const qcAt = wd(at, between(0.1, 0.6));
            const failChance = makeOwner === producer.id ? 0.3 : makeOwner === S('divya.menon@ops.demo') ? 0.15 : 0.35;
            passed = version > 3 || rand() > failChance;
            const list = checklist(dp.flow);
            const bad = passed ? [] : [Math.floor(rand() * list.length)];
            await prisma.qCResult.create({
              data: {
                orgId,
                versionId: v.id,
                checklistId: dp.flow,
                result: passed ? 'pass' : 'fail',
                reviewerId: pick(qcs),
                createdAt: qcAt,
                items: { list: list.map((label, i) => ({ label, ok: !bad.includes(i), ...(bad.includes(i) ? { note: 'Needs a fix' } : {}) })), note: null, checklist: dp.flow },
              },
            });
            at = wd(qcAt, passed ? 0.1 : between(0.5, 1.5));
            if (passed) {
              await prisma.version.update({ where: { id: v.id }, data: { sentToClientAt: at, sentById: job.amId } });
              lastSent = at;
              approvedVersionId = v.id;
            }
          }
          if (round < rounds) at = wd(at, between(1, 3) * job.speed); // client feedback, then the fix
        }
        const approvedAt = wd(lastSent!, between(0.5, 3) * job.speed);
        if (!past(approvedAt) || isCurrent) {
          await prisma.deliverable.update({ where: { id: deliverable.id }, data: { status: 'ready_for_client', revisionRoundsUsed: rounds } });
          continue;
        }
        await prisma.deliverable.update({ where: { id: deliverable.id }, data: { status: 'approved', revisionRoundsUsed: rounds, approvedVersionId } });
        await prisma.approval.create({ data: { orgId, targetType: 'deliverable', targetId: deliverable.id, gate: 'G4', userId: rand() < 0.5 ? job.ownerId : job.approverId, at: approvedAt, versionId: approvedVersionId } });
        await prisma.task.create({
          data: {
            orgId,
            deliverableId: deliverable.id,
            engagementId: engagement.id,
            title: `Client review: ${title}`,
            flowStep: 'client',
            ownerId: job.amId,
            departmentId: dept('Client Management')?.id,
            deadline: dueAt,
            status: 'done',
            kind: 'client_review',
            role: 'am',
            sort: 3,
            timeLoggedMin: 30,
            startedAt: lastSent,
            completedAt: approvedAt,
            createdAt: planAt,
          },
        });
        if (!lastApproval || approvedAt > lastApproval) lastApproval = approvedAt;
      }

      // Retainer invoice for the month.
      if (!oneTime) await addInvoice(job, engagement.id, monthAt(back, 1, 10), 'retainer', `${svc.name} — ${job.tier} (${monthName(monthAt(back, 1))})`, price, back === 0 ? null : Math.round(between(1, 12)));
    }

    if (oneTime) {
      await addInvoice(job, engagement.id, signed, 'first_payment', `${svc.name} — ${job.tier} (50% advance)`, price / 2, 0);
      if (lastApproval) {
        const g5 = wd(lastApproval, between(1.5, 4));
        if (past(g5)) {
          await addInvoice(job, engagement.id, wd(lastApproval, 0.5), 'project_balance', `${svc.name} — ${job.tier} (balance 50%)`, price / 2, 3);
          await prisma.approval.create({ data: { orgId, targetType: 'engagement', targetId: engagement.id, gate: 'G5', userId: job.ownerId, at: g5 } });
          await prisma.engagement.update({ where: { id: engagement.id }, data: { finalSignedOffAt: g5, endDate: g5 } });
        }
      }
    }

    // Client requests across the week; some answered late, a few still waiting.
    const slaMin: Record<string, number> = { change: 240, new_scope: 540, urgent: 120, question: 540, billing: 540 };
    const slowAm = job.amId !== am.id; // the CM lead is stretched thinner
    const requestCount = Math.round(job.startDays / 8);
    for (let i = 0; i < requestCount; i++) {
      const daysBack = Math.round(between(1, job.startDays - 3));
      const hour = rand() < 0.15 ? pick([7, 8, 19, 20, 21]) : Math.floor(between(9, 18));
      const createdAt = daysAgo(daysBack, hour, Math.floor(rand() * 60));
      const req = pick(REQUESTS);
      const slaDue = addWorkingMinutes(createdAt, slaMin[req.type], cal);
      const late = rand() < (slowAm ? 0.3 : 0.12) || (hour >= 16 && rand() < 0.35);
      const replyMin = late ? slaMin[req.type] + between(30, 600) : between(10, slaMin[req.type] * 0.8);
      const firstReplyAt = addWorkingMinutes(createdAt, Math.round(replyMin), cal);
      const open = daysBack <= 3 && i % 2 === 0;
      const replied = !open && past(firstReplyAt);
      await prisma.request.create({
        data: {
          orgId,
          engagementId: engagement.id,
          type: req.type,
          description: req.text,
          status: !replied ? 'received' : daysBack > 6 ? 'done' : 'in_progress',
          createdById: job.ownerId,
          slaDue,
          firstReplyAt: replied ? firstReplyAt : null,
          resolvedAt: replied && daysBack > 6 ? wd(firstReplyAt, between(0.5, 3)) : null,
          createdAt,
          updatedAt: createdAt,
        },
      });
    }

    // Messages: the client writes, the team replies (mostly the same working day).
    const thread =
      (await prisma.thread.findFirst({ where: { clientOrgId: job.client.id, engagementId: engagement.id } })) ??
      (await prisma.thread.create({ data: { orgId, clientOrgId: job.client.id, engagementId: engagement.id, type: 'client_am' } }));
    const msgCount = Math.round(job.startDays / 7);
    const times = Array.from({ length: msgCount }, () => daysAgo(Math.round(between(1, job.startDays - 2)), Math.floor(between(9, 20)), Math.floor(rand() * 60))).sort((a, b) => a.getTime() - b.getTime());
    for (const t of times) {
      await prisma.message.create({
        data: { orgId, threadId: thread.id, authorId: job.ownerId, body: pick(['Can you share the draft today?', 'Looks good, one small change please.', 'Approved from our side.', 'Any update on this week’s posts?', 'Please call me when free.']), createdAt: t },
      });
      const reply = addWorkingMinutes(t, Math.round(rand() < (slowAm ? 0.3 : 0.15) ? between(540, 1200) : between(15, 240)), cal);
      if (past(reply)) await prisma.message.create({ data: { orgId, threadId: thread.id, authorId: job.amId, body: pick(['Sure, sharing it shortly.', 'Done, please take a look.', 'Thanks! Noted.', 'Calling you in 10 minutes.']), createdAt: reply } });
    }
  }

  const jobServices = await prisma.service.findMany({ where: { orgId, key: { in: jobs.map((j) => j.key) }, priceBook: { status: 'active' } }, select: { id: true, key: true } });
  const jobEngagements = jobs.map((j) => ({ clientOrgId: j.client.id, serviceId: jobServices.find((x) => x.key === j.key)?.id ?? '-' }));

  // --- Heavy open workload for the seeded staff (next four weeks, a few overdue) --------------
  const current = await prisma.deliverable.findMany({
    where: { orgId, status: 'in_production', cycle: { engagement: { OR: jobEngagements } } },
    select: { id: true, title: true, cycle: { select: { engagementId: true } } },
    orderBy: { title: 'asc' },
  });
  for (const s of STAFF) {
    const id = staff[s.email].id;
    if (await prisma.task.findFirst({ where: { orgId, ownerId: id, flowStep: 'ops-demo-load' } })) continue;
    const rand = rng(s.email.length * 97 + s.load);
    const d = dept(s.dept);
    for (let i = 0; i < s.load; i++) {
      // Divya's next week is overloaded on purpose (the Team Performance heatmap shows it).
      const week = s.email.startsWith('divya') && i < 9 ? 1 : i < 2 ? -1 : Math.floor(rand() * 4);
      const deadline = week < 0 ? daysAgo(1 + i, 18, 30) : new Date(Date.now() + (week * 7 + 1 + Math.floor(rand() * 5)) * DAY);
      const target = current.length ? current[i % current.length] : null;
      await prisma.task.create({
        data: {
          orgId,
          deliverableId: target?.id,
          engagementId: target?.cycle.engagementId,
          title: `${['Draft', 'Revise', 'Prepare', 'Check', 'Finalise'][i % 5]}: ${target?.title ?? 'internal work'} (${i + 1})`,
          flowStep: 'ops-demo-load',
          ownerId: id,
          departmentId: d?.id,
          deadline,
          status: week < 0 || i % 4 === 0 ? 'in_progress' : 'todo',
          kind: s.role === 'qc_reviewer' ? 'qc' : 'work',
          role: s.role,
          sort: 10 + i,
          timeLoggedMin: week < 0 ? 120 : 0,
          startedAt: week < 0 || i % 4 === 0 ? daysAgo(3 + (i % 4)) : null,
          createdAt: daysAgo(4 + (i % 5)),
        },
      });
    }
  }

  // --- Routine weekly work (content batches, reports, reviews) so hours and utilisation look like a real team ---
  const routine: { id: string; deptName: string | null; titles: string[]; perWeek: number; hours: [number, number] }[] = [
    { id: producer.id, deptName: 'Creative / Design', titles: ['Content batch', 'Resize and export creatives', 'Brand asset clean-up'], perWeek: 4, hours: [6, 9] },
    { id: strategist.id, deptName: 'Strategy', titles: ['Content calendar', 'Competitor review', 'Monthly report'], perWeek: 4, hours: [5, 9] },
    { id: qc.id, deptName: 'QC', titles: ['QC sweep', 'Checklist review'], perWeek: 4, hours: [5, 8] },
    { id: am.id, deptName: 'Client Management', titles: ['Client check-in call', 'Weekly status report', 'Invoice follow-up'], perWeek: 4, hours: [4, 8] },
    ...(amLead ? [{ id: amLead.id, deptName: 'Client Management', titles: ['Client check-in call', 'Account review', 'CM team stand-up'], perWeek: 4, hours: [4, 7] as [number, number] }] : []),
    ...STAFF.map((s) => ({ id: staff[s.email].id, deptName: s.dept as string, titles: s.role === 'qc_reviewer' ? ['QC sweep', 'Checklist review'] : s.role === 'strategist' ? ['Content calendar', 'Campaign plan', 'Monthly report'] : ['Content batch', 'Edits from feedback', 'Asset library upkeep'], perWeek: 4, hours: [6, 9.5] as [number, number] })),
  ];
  if (!(await prisma.task.findFirst({ where: { orgId, flowStep: 'ops-demo-routine' } }))) {
    const rand = rng(2026);
    const rows: Prisma.TaskCreateManyInput[] = [];
    for (const p of routine) {
      const deptId = p.deptName ? dept(p.deptName)?.id : undefined;
      for (let w = 26; w >= 1; w--) {
        for (let k = 0; k < p.perWeek; k++) {
          const created = daysAgo(w * 7 + 1 - k, 10);
          const start = wd(created, 0.2 + rand() * 0.5);
          const hours = p.hours[0] + rand() * (p.hours[1] - p.hours[0]);
          const end = wd(start, hours / 9 + rand());
          if (!past(end)) continue;
          const deadline = wd(start, rand() < 0.82 ? hours / 9 + 1 + rand() * 1.5 : hours / 18);
          rows.push({ orgId, title: `${p.titles[(w + k) % p.titles.length]} (week ${27 - w})`, flowStep: 'ops-demo-routine', ownerId: p.id, departmentId: deptId, deadline, status: 'done', kind: 'work', timeLoggedMin: Math.round((hours * 60) / 15) * 15, startedAt: start, completedAt: end, createdAt: created });
        }
      }
    }
    await prisma.task.createMany({ data: rows });
  }

  // --- Saved reports for the founder ----------------------------------------
  const iso = (d: Date) => new Date(d.getTime() + IST).toISOString().slice(0, 10);
  const reports = [
    { name: 'Tasks completed by department', config: { metric: 'tasks_completed', dimension: 'department', preset: '90d', from: iso(daysAgo(89)), to: iso(now), chart: 'bars' }, pinned: false, shared: true },
    { name: 'Collections by month', config: { metric: 'revenue_collected', dimension: 'month', preset: '6m', from: iso(daysAgo(182)), to: iso(now), chart: 'columns' }, pinned: true, shared: false },
    { name: 'Missed reply times by request type', config: { metric: 'sla_breaches', dimension: 'request_type', preset: '90d', from: iso(daysAgo(89)), to: iso(now), chart: 'bars' }, pinned: false, shared: true },
  ];
  for (const r of reports) {
    if (await prisma.savedReport.findFirst({ where: { orgId, userId: founder.id, name: r.name } })) continue;
    await prisma.savedReport.create({ data: { orgId, userId: founder.id, ...r } });
  }
}
