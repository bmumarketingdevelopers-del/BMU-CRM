import { DEFAULT_QC_CHECKLISTS, financialYear } from '@bmu/shared';
import type { BillingType, EngagementStatus, InvoiceStatus, PrismaClient, Tier } from '../../src/generated/prisma/client.js';

const DAY = 86_400_000;
/** `days` ago at hh:00 IST. */
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

/**
 * Demo data for the Command Centre analytics and Finance desk: two more clients, six months of invoices and
 * payments (one overdue, one part-paid, one cancelled, a credit note), QC history, team workload, requests past
 * their reply time and creator payouts when a creator exists. Idempotent: each block checks before creating.
 */
export async function seedInsights(prisma: PrismaClient, orgId: string) {
  const user = async (email: string) => prisma.user.findFirst({ where: { orgId, email } });
  const [am, producer, strategist, qc, finance, designHead] = await Promise.all(
    ['am@bmu.demo', 'producer@bmu.demo', 'strategist@bmu.demo', 'qc@bmu.demo', 'finance@bmu.demo', 'design.head@bmu.demo'].map(user),
  );
  const sunrise = await prisma.clientOrg.findFirst({ where: { orgId, name: 'Sunrise Realty Pvt Ltd' } });
  if (!am || !producer || !qc || !sunrise) return; // core seed did not run

  const service = (key: string) => prisma.service.findFirst({ where: { key, priceBook: { orgId, status: 'active' } }, include: { tiers: true } });
  const [dm, website, smm, logo] = await Promise.all([service('digital_marketing'), service('website'), service('smm'), service('logo_brand_kit')]);
  if (!dm || !website || !smm || !logo) return;
  const price = (s: NonNullable<typeof dm>, tier: Tier) => s.tiers.find((t) => t.tier === tier)!.pricePaise;
  const depts = await prisma.department.findMany({ where: { orgId } });
  const dept = (name: string) => depts.find((d) => d.name === name)?.id;
  const ownerRole = await prisma.role.findFirst({ where: { orgId, baseRole: 'client_owner', isCustom: false } });

  // --- Clients -------------------------------------------------------------
  async function ensureClient(name: string, industry: string, gstin: string | null, ownerName: string, ownerEmail: string, tenureDays: number) {
    const client =
      (await prisma.clientOrg.findFirst({ where: { orgId, name } })) ??
      (await prisma.clientOrg.create({ data: { orgId, name, industry, gstin, amUserId: am!.id, tenureStart: ago(tenureDays), createdAt: ago(tenureDays) } }));
    const owner =
      (await prisma.user.findFirst({ where: { orgId, email: ownerEmail } })) ??
      (await prisma.user.create({ data: { orgId, type: 'client', name: ownerName, email: ownerEmail, status: 'active' } }));
    if (!(await prisma.clientUser.findUnique({ where: { userId: owner.id } }))) {
      await prisma.clientUser.create({ data: { userId: owner.id, orgId, clientOrgId: client.id, clientRole: 'client_owner', brandScope: [] } });
      if (ownerRole) await prisma.userRole.create({ data: { userId: owner.id, roleId: ownerRole.id } });
    }
    return { client, owner };
  }
  const greenleaf = await ensureClient('Greenleaf Organics', 'Food & grocery', '29AAGCG1234F1Z5', 'Lakshmi Prasad', 'owner@greenleaf.demo', 190);
  const metro = await ensureClient('Metro Dental Care', 'Healthcare', null, 'Dr. Farhan Ali', 'owner@metrodental.demo', 130);

  async function ensureEngagement(clientOrgId: string, s: NonNullable<typeof dm>, tier: Tier, billingType: BillingType, status: EngagementStatus, gate: string, startDays: number) {
    return (
      (await prisma.engagement.findFirst({ where: { clientOrgId, serviceId: s.id } })) ??
      (await prisma.engagement.create({
        data: { orgId, clientOrgId, serviceId: s.id, tier, billingType, status, currentGate: gate, amId: am!.id, startDate: ago(startDays), createdAt: ago(startDays) },
      }))
    );
  }
  const glRetainer = await ensureEngagement(greenleaf.client.id, dm, 'starter', 'monthly', 'active_retainer', 'G4', 185);
  const metroSite = await ensureEngagement(metro.client.id, website, 'growth', 'one_time', 'awaiting_final_payment', 'G5', 125);
  const sunriseSmm = await prisma.engagement.findFirst({ where: { clientOrgId: sunrise.id, serviceId: smm.id } });
  const sunriseLogo = await prisma.engagement.findFirst({ where: { clientOrgId: sunrise.id, serviceId: logo.id } });

  // --- Invoices and payments ----------------------------------------------
  if (!(await prisma.invoice.findFirst({ where: { orgId, clientOrgId: greenleaf.client.id } }))) {
    type Seed = { at: Date; clientOrgId: string; engagementId?: string; kind: string; label: string; net: number; dueDays: number; pay?: { method: string; days: number; part?: number }[]; status?: InvoiceStatus };
    const list: Seed[] = [];
    // Greenleaf: monthly retainer for six months. Last month paid late, this month not due yet.
    for (let back = 5; back >= 0; back--) {
      const at = monthDay(back, 1);
      const pay = back === 0 ? undefined : back === 1 ? [{ method: 'bank', days: 19 }] : [{ method: back % 2 ? 'razorpay' : 'upi', days: 3 + back }];
      list.push({ at, clientOrgId: greenleaf.client.id, engagementId: glRetainer.id, kind: 'retainer', label: `Digital Marketing — Starter (${monthName(at)})`, net: price(dm, 'starter'), dueDays: 7, pay });
    }
    // Metro Dental: website advance (paid), a part-paid add-on and the balance, now overdue.
    const siteNet = price(website, 'growth');
    list.push({ at: ago(124), clientOrgId: metro.client.id, engagementId: metroSite.id, kind: 'first_payment', label: 'Website Design & Development — Growth (50% advance)', net: siteNet / 2, dueDays: 0, pay: [{ method: 'razorpay', days: 0 }] });
    list.push({ at: ago(85), clientOrgId: metro.client.id, engagementId: metroSite.id, kind: 'addon', label: 'Extra landing page', net: 1_200_000, dueDays: 7, pay: [{ method: 'upi', days: 6, part: 0.5 }] });
    list.push({ at: ago(48), clientOrgId: metro.client.id, engagementId: metroSite.id, kind: 'project_balance', label: 'Website Design & Development — Growth (balance 50%)', net: siteNet / 2, dueDays: 7 });
    // Sunrise: logo advance (paid), social retainer for last month (paid) and this month (open).
    if (sunriseLogo) list.push({ at: ago(6), clientOrgId: sunrise.id, engagementId: sunriseLogo.id, kind: 'first_payment', label: 'Logo & Brand Kit — Growth (50% advance)', net: price(logo, 'growth') / 2, dueDays: 0, pay: [{ method: 'razorpay', days: 0 }] });
    if (sunriseSmm) {
      const last = monthDay(1, 3);
      list.push({ at: last, clientOrgId: sunrise.id, engagementId: sunriseSmm.id, kind: 'retainer', label: `Social Media Management — Growth (${monthName(last)})`, net: price(smm, 'growth'), dueDays: 7, pay: [{ method: 'cheque', days: 9 }] });
      list.push({ at: ago(1), clientOrgId: sunrise.id, engagementId: sunriseSmm.id, kind: 'retainer', label: `Social Media Management — Growth (${monthName(ago(1))})`, net: price(smm, 'growth'), dueDays: 7 });
    }
    // A cancelled duplicate, for the invoice list.
    list.push({ at: ago(70), clientOrgId: greenleaf.client.id, engagementId: glRetainer.id, kind: 'addon', label: 'Festival creatives pack (raised twice by mistake)', net: 800_000, dueDays: 7, status: 'void' });

    list.sort((a, b) => a.at.getTime() - b.at.getTime());
    let refNo = 1;
    for (const s of list) {
      // Same numbering as BillingService: BMU/<FY>/NNNN, next after the invoices already in that year.
      const fy = financialYear(s.at);
      const seq = (await prisma.invoice.count({ where: { orgId, number: { startsWith: `BMU/${fy}/` } } })) + 1;
      const gst = Math.round(s.net * 0.18);
      const total = s.net + gst;
      const payments = (s.pay ?? []).map((p) => ({ amount: p.part ? Math.round(total * p.part) : total, method: p.method, at: new Date(s.at.getTime() + p.days * DAY + 3 * 3600_000) }));
      const paid = payments.reduce((x, p) => x + p.amount, 0);
      const status: InvoiceStatus = s.status ?? (paid >= total ? 'paid' : paid > 0 ? 'partially_paid' : 'issued');
      const inv = await prisma.invoice.create({
        data: {
          orgId,
          clientOrgId: s.clientOrgId,
          engagementId: s.engagementId,
          kind: s.kind,
          number: `BMU/${fy}/${String(seq).padStart(4, '0')}`,
          lines: [{ label: s.label, amountPaise: s.net }, { label: 'GST 18%', amountPaise: gst }],
          subtotalPaise: s.net,
          gstPaise: gst,
          totalPaise: total,
          dueDate: new Date(s.at.getTime() + s.dueDays * DAY),
          status,
          createdAt: s.at,
        },
      });
      for (const p of payments) {
        const ref = p.method === 'razorpay' ? `pay_demo${String(refNo).padStart(6, '0')}` : `DEMO-${p.method.toUpperCase()}-${String(refNo).padStart(4, '0')}`;
        refNo++;
        await prisma.payment.create({ data: { orgId, invoiceId: inv.id, amountPaise: p.amount, method: p.method, at: p.at, ref } });
      }
    }

    // Credit note: two reels not delivered in one Greenleaf month.
    const credited = await prisma.invoice.findFirst({ where: { orgId, clientOrgId: greenleaf.client.id, kind: 'retainer', status: 'paid' }, orderBy: { createdAt: 'asc' }, skip: 2 });
    if (credited && finance) {
      const at = new Date(credited.createdAt.getTime() + 20 * DAY);
      const fy = financialYear(at);
      const seq = (await prisma.creditNote.count({ where: { orgId, number: { startsWith: `CN/${fy}/` } } })) + 1;
      await prisma.creditNote.create({
        data: { orgId, invoiceId: credited.id, number: `CN/${fy}/${String(seq).padStart(4, '0')}`, amountPaise: 300_000, gstPaise: 54_000, totalPaise: 354_000, reason: 'Two reels not delivered that month', createdById: finance.id, createdAt: at },
      });
    }
  }

  // --- QC history for the Quality page -------------------------------------
  if ((await prisma.qCResult.count({ where: { orgId } })) === 0) {
    const plan: { title: string; type: string; flow: string; dept: string; outcomes: ('pass' | 'fail')[]; rounds: number }[] = [
      { title: 'Festive offer carousel', type: 'post', flow: 'design', dept: 'Creative / Design', outcomes: ['pass'], rounds: 1 },
      { title: 'Organic farm reel', type: 'reel', flow: 'video', dept: 'Video / Production', outcomes: ['fail', 'pass'], rounds: 2 },
      { title: 'Recipe blog: millet salad', type: 'blog', flow: 'writing', dept: 'SEO', outcomes: ['pass'], rounds: 0 },
      { title: 'Store launch poster', type: 'post', flow: 'design', dept: 'Creative / Design', outcomes: ['fail', 'fail', 'pass'], rounds: 3 },
    ];
    for (const back of [3, 2, 1]) {
      const at = monthDay(back, 4);
      const period = new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 7);
      const cycle =
        (await prisma.cycle.findFirst({ where: { engagementId: glRetainer.id, period } })) ??
        (await prisma.cycle.create({ data: { orgId, engagementId: glRetainer.id, period, rcdAt: at, status: 'delivered' } }));
      for (const [k, p] of plan.entries()) {
        if (back === 1 && k === 0) continue;
        const d = await prisma.deliverable.create({
          data: { orgId, cycleId: cycle.id, type: p.type, title: `${p.title} (${monthName(at)})`, status: 'approved', revisionRoundsUsed: back === 1 && k === 3 ? p.rounds : Math.min(p.rounds, 2), departmentId: dept(p.dept), flowKey: p.flow },
        });
        const items = DEFAULT_QC_CHECKLISTS.find((c) => c.key === p.flow)!.items;
        for (const [n, outcome] of p.outcomes.entries()) {
          const when = new Date(at.getTime() + (3 + k * 2 + n * 2) * DAY);
          const file = await prisma.file.create({ data: { orgId, clientOrgId: greenleaf.client.id, path: `demo/${d.id}-v${n + 1}.png`, kind: 'image', name: `${p.type}-v${n + 1}.png`, mimeType: 'image/png', createdAt: when } });
          const v = await prisma.version.create({ data: { orgId, deliverableId: d.id, fileId: file.id, number: n + 1, uploadedById: producer.id, createdAt: when, sentToClientAt: outcome === 'pass' ? when : null } });
          const failIdx = outcome === 'fail' ? [(k + n + back) % items.length, ...(n === 1 ? [1] : [])] : [];
          await prisma.qCResult.create({
            data: {
              orgId,
              versionId: v.id,
              checklistId: p.flow,
              result: outcome,
              reviewerId: qc.id,
              createdAt: new Date(when.getTime() + 4 * 3600_000),
              items: { list: items.map((label, i) => ({ label, ok: !failIdx.includes(i), ...(failIdx.includes(i) ? { note: 'Needs a fix' } : {}) })), note: null, checklist: p.flow },
            },
          });
          if (outcome === 'pass') await prisma.deliverable.update({ where: { id: d.id }, data: { approvedVersionId: v.id } });
        }
      }
    }
    // This week's checks on Metro Dental pages.
    const cycle =
      (await prisma.cycle.findFirst({ where: { engagementId: metroSite.id } })) ??
      (await prisma.cycle.create({ data: { orgId, engagementId: metroSite.id, period: 'project', rcdAt: ago(120), status: 'review' } }));
    const webItems = DEFAULT_QC_CHECKLISTS.find((c) => c.key === 'web')!.items;
    for (const [k, title] of ['Home page', 'Book an appointment page'].entries()) {
      const d = await prisma.deliverable.create({ data: { orgId, cycleId: cycle.id, type: 'web_page', title, status: k === 0 ? 'approved' : 'qc_failed', revisionRoundsUsed: k === 1 ? 3 : 1, departmentId: dept('Web / AI'), flowKey: 'web' } });
      const file = await prisma.file.create({ data: { orgId, clientOrgId: metro.client.id, path: `demo/${d.id}.png`, kind: 'image', name: `${title}.png`, mimeType: 'image/png' } });
      const v = await prisma.version.create({ data: { orgId, deliverableId: d.id, fileId: file.id, number: 1, uploadedById: producer.id, createdAt: ago(1 + k) } });
      await prisma.qCResult.create({
        data: { orgId, versionId: v.id, checklistId: 'web', result: k === 0 ? 'pass' : 'fail', reviewerId: qc.id, createdAt: ago(1 + k, 15), items: { list: webItems.map((label, i) => ({ label, ok: !(k === 1 && (i === 1 || i === 2)) })), note: null, checklist: 'web' } },
      });
    }
  }

  // --- Open work on Greenleaf's current month, for the Capacity board -------
  const nowPeriod = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 7);
  if (!(await prisma.task.findFirst({ where: { orgId, engagementId: glRetainer.id } }))) {
    const cycle =
      (await prisma.cycle.findFirst({ where: { engagementId: glRetainer.id, period: nowPeriod } })) ??
      (await prisma.cycle.create({ data: { orgId, engagementId: glRetainer.id, period: nowPeriod, rcdAt: ago(2), status: 'production' } }));
    const deliverable = await prisma.deliverable.create({ data: { orgId, cycleId: cycle.id, type: 'post', title: `Monthly creatives (${monthName(new Date())})`, status: 'in_production', departmentId: dept('Creative / Design'), flowKey: 'design' } });
    const tasks: { title: string; owner: string; dept: string; due: number; status?: 'in_progress' | 'blocked' | 'done'; min: number; reason?: string }[] = [
      { title: 'Design: Diwali hamper post', owner: producer.id, dept: 'Creative / Design', due: -2, status: 'in_progress', min: 360 },
      { title: 'Design: Organic week carousel', owner: producer.id, dept: 'Creative / Design', due: 1, min: 120 },
      { title: 'Design: Store timings story', owner: producer.id, dept: 'Creative / Design', due: 3, min: 0 },
      { title: 'Design: Recipe card set', owner: producer.id, dept: 'Creative / Design', due: 4, min: 0 },
      { title: 'Design: Farmer spotlight', owner: producer.id, dept: 'Creative / Design', due: -1, status: 'blocked', min: 90, reason: 'Waiting for farm photos from the client' },
      { title: 'Content calendar for next month', owner: strategist?.id ?? am.id, dept: 'Strategy', due: 2, status: 'in_progress', min: 480 },
      { title: 'Competitor review', owner: strategist?.id ?? am.id, dept: 'Strategy', due: -3, min: 150 },
      { title: 'Monthly report to client', owner: am.id, dept: 'Account Management', due: 0, status: 'in_progress', min: 240 },
      { title: 'Ad creative review', owner: designHead?.id ?? producer.id, dept: 'Creative / Design', due: 0, status: 'done', min: 300 },
    ];
    for (const [i, t] of tasks.entries()) {
      await prisma.task.create({
        data: {
          orgId,
          deliverableId: deliverable.id,
          engagementId: glRetainer.id,
          title: t.title,
          ownerId: t.owner,
          departmentId: dept(t.dept),
          deadline: new Date(Date.now() + t.due * DAY),
          status: t.status ?? 'todo',
          blockedReason: t.reason,
          timeLoggedMin: t.min,
          sort: i,
          startedAt: t.min ? ago(2) : null,
          completedAt: t.status === 'done' ? new Date() : null,
        },
      });
    }
  }

  // Who checked in today (only where nobody else recorded attendance).
  const ist = new Date(Date.now() + 330 * 60_000);
  const today = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
  for (const u of [am, producer, qc, finance].filter((x): x is NonNullable<typeof x> => !!x)) {
    if (await prisma.attendance.findUnique({ where: { userId_date: { userId: u.id, date: today } } })) continue;
    await prisma.attendance.create({ data: { orgId, userId: u.id, date: today, checkIn: new Date(today.getTime() + 4 * 3600_000 + 5 * 60_000) } });
  }

  // Requests: one answered late, two still waiting past their reply time.
  if (!(await prisma.request.findFirst({ where: { orgId, engagementId: glRetainer.id } }))) {
    await prisma.request.create({
      data: { orgId, engagementId: glRetainer.id, type: 'change', description: 'Change the price on the Diwali hamper post', status: 'received', createdById: greenleaf.owner.id, slaDue: ago(1, 13), createdAt: ago(1, 10) },
    });
    await prisma.request.create({
      data: { orgId, engagementId: glRetainer.id, type: 'question', description: 'Can we boost the farm reel this weekend?', status: 'done', createdById: greenleaf.owner.id, slaDue: ago(3, 15), firstReplyAt: ago(3, 17), resolvedAt: ago(2), createdAt: ago(3, 11) },
    });
    await prisma.request.create({
      data: { orgId, engagementId: metroSite.id, type: 'change', description: 'Doctor photos on the team page are outdated', status: 'received', createdById: metro.owner.id, slaDue: ago(6, 16), createdAt: ago(6, 11) },
    });
  }

  // A recent client message for Greenleaf, so it reads as healthy.
  const thread =
    (await prisma.thread.findFirst({ where: { clientOrgId: greenleaf.client.id } })) ??
    (await prisma.thread.create({ data: { orgId, clientOrgId: greenleaf.client.id, engagementId: glRetainer.id, type: 'client_am' } }));
  if (!(await prisma.message.findFirst({ where: { threadId: thread.id } }))) {
    await prisma.message.create({ data: { orgId, threadId: thread.id, authorId: am.id, body: 'This month’s calendar is ready for your review.', createdAt: ago(3) } });
    await prisma.message.create({ data: { orgId, threadId: thread.id, authorId: greenleaf.owner.id, body: 'Looks great, approved. Please push the hamper post first.', createdAt: ago(2) } });
  }

  // Creator payouts, only if another area has created a creator.
  const creator = await prisma.creator.findFirst({ where: { orgId } });
  if (creator && !(await prisma.creatorPayout.findFirst({ where: { orgId, creatorId: creator.id, briefId: null } }))) {
    await prisma.creatorPayout.create({ data: { orgId, creatorId: creator.id, amountPaise: 1_500_000, tdsPaise: 150_000, netPaise: 1_350_000, status: 'paid', paidAt: ago(20), ref: 'DEMO-NEFT-2201', createdAt: ago(25) } });
    await prisma.creatorPayout.create({ data: { orgId, creatorId: creator.id, amountPaise: 800_000, tdsPaise: 80_000, netPaise: 720_000, createdAt: ago(2) } });
  }
}
