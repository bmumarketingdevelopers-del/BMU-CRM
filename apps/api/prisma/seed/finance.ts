import type { PrismaClient } from '../../src/generated/prisma/client.js';

// v18 finance 2.0 and capacity demo data. Idempotent: every block checks before it writes.
// - Cash-flow settings (opening balance, salaries, fixed costs).
// - Expense claims (waiting and approved) and vendor bills (unpaid and paid), one billable to a client.
// - Three planned invoice instalments for one project.
// - A bank credit nobody matched yet (same amount as an open invoice, so the Finance collector can suggest it).
// - Project bookings for this week and next, a skill request, and approved leave next week for one maker.

const IST = 330 * 60_000;
const todayIso = () => new Date(Date.now() + IST).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const mondayOf = (iso: string) => addDays(iso, -((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7));
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

export async function seedFinance(prisma: PrismaClient, orgId: string) {
  const founder = await prisma.user.findFirst({ where: { orgId, email: 'founder@bmu.demo' }, select: { id: true } });
  const finance = await prisma.user.findFirst({ where: { orgId, email: 'finance@bmu.demo' }, select: { id: true } });
  if (!founder) return;
  const today = todayIso();
  const thisWeek = mondayOf(today);

  // 1. Cash-flow settings.
  const org = await prisma.organisation.findUniqueOrThrow({ where: { id: orgId }, select: { settings: true } });
  const st = (org.settings ?? {}) as Record<string, unknown>;
  const v8 = (st.v8 ?? {}) as Record<string, unknown>;
  if (!v8.cashflow) {
    await prisma.organisation.update({ where: { id: orgId }, data: { settings: { ...st, v8: { ...v8, cashflow: { openingBalancePaise: 12_00_000_00, monthlyPayrollPaise: 6_50_000_00, monthlyOverheadsPaise: 1_40_000_00, asOf: today } } } } });
  }

  const eng =
    (await prisma.engagement.findFirst({ where: { orgId, deletedAt: null, status: { in: ['in_production', 'in_review', 'planning'] } }, orderBy: { createdAt: 'asc' }, select: { id: true, clientOrgId: true } })) ??
    (await prisma.engagement.findFirst({ where: { orgId, deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true, clientOrgId: true } }));

  // 2. Expenses and vendor bills.
  if ((await prisma.expense.count({ where: { orgId } })) === 0) {
    const am = await prisma.user.findFirst({ where: { orgId, email: 'am@bmu.demo' }, select: { id: true } });
    const producer = await prisma.user.findFirst({ where: { orgId, type: 'staff', deletedAt: null, roles: { some: { role: { baseRole: 'producer' } } } }, select: { id: true } });
    const by = finance?.id ?? founder.id;
    await prisma.expense.createMany({
      data: [
        { orgId, kind: 'expense', category: 'travel', description: 'Cab to client shoot and back', date: d(addDays(today, -3)), amountPaise: 1_240_00, createdById: am?.id ?? founder.id, clientOrgId: eng?.clientOrgId ?? null, engagementId: eng?.id ?? null, status: 'submitted' },
        { orgId, kind: 'expense', category: 'production', description: 'Props and backdrop for product shoot', date: d(addDays(today, -6)), amountPaise: 4_800_00, gstPaise: 864_00, createdById: producer?.id ?? founder.id, clientOrgId: eng?.clientOrgId ?? null, engagementId: eng?.id ?? null, billable: true, status: 'approved', decidedById: by, decidedAt: new Date() },
        { orgId, kind: 'expense', category: 'food', description: 'Team lunch after launch', date: d(addDays(today, -10)), amountPaise: 3_600_00, createdById: founder.id, status: 'approved', decidedById: founder.id, decidedAt: new Date() },
        { orgId, kind: 'vendor_bill', category: 'software', vendorName: 'Adobe Systems', billNumber: 'ADB-88213', description: 'Creative Cloud team licences (monthly)', date: d(addDays(today, -4)), dueDate: d(addDays(today, 10)), amountPaise: 18_500_00, gstPaise: 3_330_00, createdById: by, status: 'approved', decidedById: by, decidedAt: new Date() },
        { orgId, kind: 'vendor_bill', category: 'freelancer', vendorName: 'Ravi Studio (freelance editor)', billNumber: 'RS-0412', description: 'Reel edits, 6 reels', date: d(addDays(today, -15)), dueDate: d(addDays(today, -1)), amountPaise: 24_000_00, tdsPaise: 2_400_00, clientOrgId: eng?.clientOrgId ?? null, engagementId: eng?.id ?? null, createdById: by, status: 'approved', decidedById: by, decidedAt: new Date() },
        { orgId, kind: 'vendor_bill', category: 'office', vendorName: 'WeWork Koramangala', billNumber: 'WW-1009', description: 'Office desks', date: d(addDays(today, -20)), dueDate: d(addDays(today, -12)), amountPaise: 45_000_00, gstPaise: 8_100_00, createdById: by, status: 'paid', paidAt: new Date(Date.now() - 12 * 86_400_000), paidRef: 'NEFT 2210', decidedById: by, decidedAt: new Date() },
      ],
    });
  }

  // 3. Planned instalments.
  if (eng && (await prisma.invoiceSchedule.count({ where: { orgId } })) === 0) {
    await prisma.invoiceSchedule.createMany({
      data: [
        { orgId, clientOrgId: eng.clientOrgId, engagementId: eng.id, label: 'Phase 2: campaign launch (40%)', amountPaise: 80_000_00, dueOn: d(addDays(today, 14)), kind: 'milestone', createdById: finance?.id ?? founder.id },
        { orgId, clientOrgId: eng.clientOrgId, engagementId: eng.id, label: 'Phase 3: report and handover (20%)', amountPaise: 40_000_00, dueOn: d(addDays(today, 45)), kind: 'milestone', createdById: finance?.id ?? founder.id },
      ],
    });
  }

  // 4. A bank credit nobody matched yet.
  if ((await prisma.unmatchedPayment.count({ where: { orgId } })) === 0) {
    const open = await prisma.invoice.findFirst({ where: { orgId, status: { in: ['issued', 'overdue'] }, payments: { none: {} }, clientOrgId: { not: null } }, orderBy: { createdAt: 'asc' }, select: { totalPaise: true, clientOrg: { select: { name: true } } } });
    await prisma.unmatchedPayment.create({
      data: { orgId, provider: 'bank', ref: 'UPI 4012 8831 7720', amountPaise: open?.totalPaise ?? 25_000_00, payerName: open?.clientOrg?.name ? `${open.clientOrg.name.split(' ')[0]} accounts` : 'Unknown payer', note: 'Bank statement credit', receivedAt: new Date(Date.now() - 86_400_000) },
    });
  }

  // 5. Bookings, a skill request and leave next week.
  if (eng && (await prisma.resourceBooking.count({ where: { orgId } })) === 0) {
    const makers = await prisma.user.findMany({ where: { orgId, type: 'staff', status: 'active', deletedAt: null, specialty: { not: null } }, orderBy: { name: 'asc' }, select: { id: true, specialty: true }, take: 4 });
    const rows = makers.slice(0, 3).flatMap((m, i) => [
      { orgId, engagementId: eng.id, userId: m.id, weekStart: d(thisWeek), hours: [16, 24, 12][i], status: 'booked', createdById: founder.id },
      { orgId, engagementId: eng.id, userId: m.id, weekStart: d(addDays(thisWeek, 7)), hours: [12, 20, 8][i], status: 'booked', createdById: founder.id },
    ]);
    if (rows.length) await prisma.resourceBooking.createMany({ data: rows });
    await prisma.resourceBooking.create({ data: { orgId, engagementId: eng.id, specialty: 'graphic_designer', weekStart: d(addDays(thisWeek, 7)), hours: 12, note: 'Extra launch posts and carousels', status: 'requested', createdById: founder.id } });
    const onLeave = makers[3] ?? makers[0];
    if (onLeave && !(await prisma.leaveRequest.findFirst({ where: { userId: onLeave.id, status: 'approved', from: { lte: d(addDays(thisWeek, 13)) }, to: { gte: d(addDays(thisWeek, 7)) } } }))) {
      await prisma.leaveRequest.create({ data: { orgId, userId: onLeave.id, from: d(addDays(thisWeek, 7)), to: d(addDays(thisWeek, 11)), type: 'casual', reason: 'Family wedding', status: 'approved', stage: 'done', decidedById: founder.id, decidedAt: new Date() } });
    }
  }
}
