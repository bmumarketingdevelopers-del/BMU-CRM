import { isWorkingDay } from '@bmu/shared';
import type { PrismaClient } from '../../src/generated/prisma/client.js';

const DAY = 86_400_000;
const istYmd = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
const dbDate = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
const at = (ymd: string, hhmm: string) => new Date(`${ymd}T${hhmm}:00+05:30`);

/** Demo data for Organisation / Clients admin screens. Idempotent: creates only what's missing. */
export async function seedAdminOrg(prisma: PrismaClient, orgId: string) {
  const org = await prisma.organisation.findUniqueOrThrow({ where: { id: orgId } });
  const holidays = ((org.settings as Record<string, unknown>).holidays as string[] | undefined) ?? [];
  const user = async (email: string) => prisma.user.findFirst({ where: { orgId, email } });
  const hq = await prisma.branch.findFirst({ where: { orgId, name: 'Bengaluru HQ' } });
  if (!hq) return;
  const dept = (name: string, branchId = hq.id) => prisma.department.findUnique({ where: { branchId_name: { branchId, name } } });

  // Second branch with two departments and two people.
  const mumbai =
    (await prisma.branch.findFirst({ where: { orgId, name: 'Mumbai Studio' } })) ??
    (await prisma.branch.create({ data: { orgId, name: 'Mumbai Studio', city: 'Mumbai' } }));
  for (const name of ['Video Production', 'Social Media']) {
    if (!(await dept(name, mumbai.id))) await prisma.department.create({ data: { orgId, branchId: mumbai.id, name } });
  }
  const video = (await dept('Video Production', mumbai.id))!;
  // Interns, so the Bengaluru demo producers keep getting the auto-assigned production tasks.
  const internRole = await prisma.role.findFirst({ where: { orgId, baseRole: 'intern', isCustom: false } });
  const designHead = await user('design.head@bmu.demo');
  for (const [name, email] of [
    ['Farah Sheikh', 'farah.mumbai@bmu.demo'],
    ['Kabir Malhotra', 'kabir.mumbai@bmu.demo'],
  ]) {
    const existing = await user(email);
    if (existing) {
      if (internRole) await prisma.userRole.deleteMany({ where: { userId: existing.id, roleId: { not: internRole.id } } });
      if (internRole) await prisma.userRole.upsert({ where: { userId_roleId_scopeRef: { userId: existing.id, roleId: internRole.id, scopeRef: '' } }, update: {}, create: { userId: existing.id, roleId: internRole.id } });
      continue;
    }
    await prisma.user.create({
      data: {
        orgId,
        type: 'staff',
        name,
        email,
        status: 'active',
        branchId: mumbai.id,
        departmentId: video.id,
        managerId: designHead?.id,
        roles: internRole ? { create: { roleId: internRole.id } } : undefined,
      },
    });
  }
  const farah = await user('farah.mumbai@bmu.demo');
  if (farah && !video.headUserId) await prisma.department.update({ where: { id: video.id }, data: { headUserId: farah.id } });

  // Department heads and two more pods with leads.
  const amLead = await user('am.lead@bmu.demo');
  const producer = await user('producer@bmu.demo');
  const am = await user('am@bmu.demo');
  const amDept = await dept('Account Management');
  const design = await dept('Creative / Design');
  if (amDept && amLead && !amDept.headUserId) await prisma.department.update({ where: { id: amDept.id }, data: { headUserId: amLead.id } });
  if (design && designHead && !design.headUserId) await prisma.department.update({ where: { id: design.id }, data: { headUserId: designHead.id } });
  const pods: [typeof amDept, string, typeof amLead, (typeof amLead)[]][] = [
    [amDept, 'Pod B', amLead, [amLead]],
    [design, 'Brand Pod', designHead, [designHead, producer]],
  ];
  for (const [d, name, lead, members] of pods) {
    if (!d || !lead || (await prisma.team.findFirst({ where: { departmentId: d.id, name } }))) continue;
    const team = await prisma.team.create({ data: { orgId, departmentId: d.id, name, leadUserId: lead.id } });
    await prisma.user.updateMany({ where: { id: { in: members.filter(Boolean).map((m) => m!.id) }, teamId: null }, data: { teamId: team.id } });
  }

  // Leave requests: two waiting, two approved.
  const today = istYmd(new Date());
  const shift = (ymd: string, days: number) => istYmd(new Date(dbDate(ymd).getTime() + days * DAY + 6 * 3600_000));
  const step = (from: string, n: number, dir: 1 | -1) => {
    let d = from;
    let k = 0;
    while (k < n) {
      d = shift(d, dir);
      if (isWorkingDay(at(d, '12:00'), holidays)) k++;
    }
    return d;
  };
  const strategist = await user('strategist@bmu.demo');
  const qc = await user('qc@bmu.demo');
  const admin = await user('admin@bmu.demo');
  const leaves = [
    { who: producer, from: step(today, 3, 1), to: step(today, 4, 1), type: 'casual', reason: 'Family function in Mysuru', status: 'pending' as const },
    { who: qc, from: step(today, 6, 1), to: step(today, 6, 1), type: 'sick', reason: 'Doctor appointment', status: 'pending' as const },
    { who: strategist, from: step(today, 3, -1), to: step(today, 3, -1), type: 'casual', reason: 'Personal work', status: 'approved' as const },
    { who: am, from: step(today, 7, -1), to: step(today, 6, -1), type: 'sick', reason: 'Fever', status: 'approved' as const },
  ];
  if (!(await prisma.leaveRequest.findFirst({ where: { orgId, reason: 'Family function in Mysuru' } }))) {
    for (const l of leaves) {
      if (!l.who) continue;
      await prisma.leaveRequest.create({
        data: {
          orgId,
          userId: l.who.id,
          from: dbDate(l.from),
          to: dbDate(l.to),
          type: l.type,
          reason: l.reason,
          status: l.status,
          ...(l.status === 'approved' ? { decidedById: admin?.id, decidedAt: new Date() } : {}),
        },
      });
    }
  }

  // Attendance for the last 10 working days (and today, if it is one) for active demo staff.
  const staff = await prisma.user.findMany({ where: { orgId, type: 'staff', status: 'active', deletedAt: null, email: { endsWith: '.demo' } }, orderBy: { email: 'asc' } });
  const approved = await prisma.leaveRequest.findMany({ where: { orgId, status: 'approved' } });
  const days: string[] = [];
  if (isWorkingDay(at(today, '12:00'), holidays)) days.push(today);
  let cursor = today;
  for (let i = 0; i < 10; i++) {
    cursor = step(cursor, 1, -1);
    days.push(cursor);
  }
  const ymdOf = (d: Date) => d.toISOString().slice(0, 10);
  const nowMs = Date.now();
  for (const [ui, u] of staff.entries()) {
    for (const [di, ymd] of days.entries()) {
      if (approved.some((l) => l.userId === u.id && ymdOf(l.from) <= ymd && ymdOf(l.to) >= ymd)) continue;
      const seed = (ui * 7 + di * 3) % 23;
      if (seed === 5 && ymd !== today) continue; // an occasional absence
      const late = seed % 6 === 0;
      const checkIn = at(ymd, late ? `10:${String(5 + (seed % 40)).padStart(2, '0')}` : `09:${String(10 + (seed % 19)).padStart(2, '0')}`);
      if (checkIn.getTime() > nowMs) continue;
      const out = at(ymd, `18:${String(35 + (seed % 20)).padStart(2, '0')}`);
      if (await prisma.attendance.findUnique({ where: { userId_date: { userId: u.id, date: dbDate(ymd) } } })) continue;
      await prisma.attendance.create({ data: { orgId, userId: u.id, date: dbDate(ymd), checkIn, checkOut: out.getTime() < nowMs ? out : null } });
    }
  }

  // A client wrapping up: one engagement in offboarding with an overdue invoice still open.
  const smm = await prisma.service.findFirst({ where: { key: 'smm', priceBook: { orgId, status: 'active' } } });
  if (smm && am && !(await prisma.clientOrg.findFirst({ where: { orgId, name: 'Lotus Cafe & Bakery' } }))) {
    const client = await prisma.clientOrg.create({
      data: { orgId, name: 'Lotus Cafe & Bakery', industry: 'Food & beverage', amUserId: am.id, health: 'amber', tenureStart: new Date('2026-03-01') },
    });
    const e = await prisma.engagement.create({
      data: { orgId, clientOrgId: client.id, serviceId: smm.id, tier: 'starter', billingType: 'monthly', status: 'offboarding', currentGate: 'G5', amId: am.id, startDate: new Date('2026-03-01') },
    });
    await prisma.invoice.create({
      data: {
        orgId,
        clientOrgId: client.id,
        engagementId: e.id,
        number: 'BMU/DEMO/OFF-001',
        kind: 'retainer',
        lines: [
          { label: 'Social media management – September', amountPaise: 1_500_000 },
          { label: 'GST 18%', amountPaise: 270_000 },
        ],
        subtotalPaise: 1_500_000,
        gstPaise: 270_000,
        totalPaise: 1_770_000,
        dueDate: new Date(Date.now() - 5 * DAY),
        createdAt: new Date(Date.now() - 12 * DAY),
        status: 'overdue',
      },
    });
    await prisma.auditEvent.create({
      data: {
        orgId,
        actorId: admin?.id,
        action: 'engagement.lifecycle.offboard',
        entity: 'Engagement',
        entityId: e.id,
        before: { status: 'active_retainer' },
        after: { status: 'offboarding', reason: 'Client moving marketing in-house from November' },
      },
    });
    await prisma.auditEvent.create({
      data: { orgId, actorId: am.id, action: 'engagement.offboarding_check', entity: 'Engagement', entityId: e.id, after: { key: 'feedback', done: true } },
    });
  }
}
