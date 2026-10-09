import { formatINR } from '@bmu/shared';
import type { PrismaClient } from '../../src/generated/prisma/client.js';

// v10 service demo data: GST invoice details (company + two clients, one in another state for IGST),
// satisfaction ratings on finished requests, overdue reminders with a promise to pay, a past billing run
// and a few example emails in the Outbox. Idempotent: every block checks before it writes.

const DAY = 86_400_000;

const COMMENTS_UP = ['Quick and exactly what we wanted', 'Thanks, looks great', 'Fast turnaround', null, null, 'Perfect, thank you!'];
const COMMENTS_DOWN = ['Took longer than promised', 'Had to explain twice', 'Colours still not right'];

export async function seedService(prisma: PrismaClient, orgId: string) {
  await seedServiceThreadReads(prisma, orgId);
  // 1. Company GST details for the tax invoice (only fills fields nobody has set yet).
  const org = await prisma.organisation.findUniqueOrThrow({ where: { id: orgId }, select: { settings: true } });
  const settings = (org.settings ?? {}) as Record<string, unknown>;
  const v8 = (settings.v8 as Record<string, unknown> | undefined) ?? {};
  const gst = (v8.gst as Record<string, unknown> | undefined) ?? {};
  if (!gst.gstin && !gst.upiId) {
    v8.gst = {
      gstin: '29AAJCB4321M1ZQ',
      legalName: 'BMU Marketing (Build My Universee)',
      state: 'Karnataka',
      stateCode: '29',
      ratePct: 18,
      sacCode: '998361',
      invoicePrefix: 'BMU',
      address: '2nd Floor, 100 Feet Road, Indiranagar, Bengaluru, Karnataka 560038',
      upiId: 'bmumarketing@okhdfcbank',
      bankName: 'HDFC Bank',
      bankAccount: '50200012345678',
      bankIfsc: 'HDFC0000123',
      bankBranch: 'Indiranagar, Bengaluru',
      ...gst,
    };
    await prisma.organisation.update({ where: { id: orgId }, data: { settings: { ...settings, v8 } as object } });
  }

  // 2. Client billing details: Sunrise (Karnataka, CGST+SGST) and Coastal Craft (Goa, IGST).
  const details: { name: string; legalName: string; gstin: string; placeOfSupply: string; billingAddress: string }[] = [
    { name: 'Sunrise Realty Pvt Ltd', legalName: 'Sunrise Realty Private Limited', gstin: '29AAKCS1234M1Z5', placeOfSupply: '29', billingAddress: '14 Lavelle Road, Bengaluru, Karnataka 560001' },
    { name: 'Coastal Craft Breweries', legalName: 'Coastal Craft Breweries LLP', gstin: '30AAQFC5678K1Z2', placeOfSupply: '30', billingAddress: 'Plot 22, Verna Industrial Estate, Salcete, Goa 403722' },
  ];
  for (const d of details) {
    const c = await prisma.clientOrg.findFirst({ where: { orgId, name: d.name, deletedAt: null } });
    if (c && !c.gstin && !c.legalName) await prisma.clientOrg.update({ where: { id: c.id }, data: { legalName: d.legalName, gstin: d.gstin, placeOfSupply: d.placeOfSupply, billingAddress: c.billingAddress ?? d.billingAddress } });
  }

  // 3. Ratings on finished requests (last 120 days), mostly happy, a few not.
  if ((await prisma.request.count({ where: { orgId, rating: { not: null } } })) === 0) {
    const done = await prisma.request.findMany({
      where: { orgId, status: 'done', resolvedAt: { gte: new Date(Date.now() - 120 * DAY) } },
      orderBy: { resolvedAt: 'asc' },
      select: { id: true, resolvedAt: true, createdById: true },
    });
    let i = 0;
    for (const r of done) {
      i++;
      if (i % 4 === 0) continue; // not everyone rates
      const up = i % 7 !== 3 && i % 11 !== 5;
      const comment = up ? COMMENTS_UP[i % COMMENTS_UP.length] : COMMENTS_DOWN[i % COMMENTS_DOWN.length];
      await prisma.request.update({
        where: { id: r.id },
        data: { rating: up ? 1 : -1, ratingComment: comment, ratedAt: new Date(r.resolvedAt!.getTime() + 3 * 3600_000), ratedById: r.createdById },
      });
    }
  }

  // 4. Overdue reminders already sent for overdue invoices, and one promise to pay.
  const now = new Date();
  const overdue = await prisma.invoice.findMany({
    where: { orgId, clientOrgId: { not: null }, status: { in: ['issued', 'partially_paid', 'overdue'] }, dueDate: { lt: new Date(now.getTime() - 2 * DAY) } },
    include: { payments: true, clientOrg: { select: { name: true } } },
    orderBy: { dueDate: 'asc' },
  });
  let promised = (await prisma.paymentPromise.count({ where: { orgId } })) > 0;
  for (const inv of overdue) {
    if (await prisma.invoiceReminder.count({ where: { invoiceId: inv.id } })) continue;
    const late = Math.floor((now.getTime() - inv.dueDate.getTime()) / DAY);
    const steps = [1, 7, 14].filter((s) => late >= s + 1);
    // Only the latest step is recorded with its real date; earlier ones are history.
    for (const [idx, s] of steps.entries()) {
      await prisma.invoiceReminder.create({
        data: { orgId, invoiceId: inv.id, step: idx + 1, daysOverdue: s, channels: ['in_app', 'email', 'message'], createdAt: new Date(inv.dueDate.getTime() + (s + 1) * DAY) },
      });
    }
    if (!promised && steps.length) {
      const finance = await prisma.user.findFirst({ where: { orgId, email: 'finance@bmu.demo' }, select: { id: true } });
      if (finance) {
        await prisma.paymentPromise.create({
          data: { orgId, invoiceId: inv.id, promisedFor: new Date(`${new Date(now.getTime() + 4 * DAY).toISOString().slice(0, 10)}T00:00:00Z`), note: `Called ${inv.clientOrg?.name ?? 'the client'}: paying by bank transfer this week`, createdById: finance.id },
        });
        promised = true;
      }
    }
  }

  // 5. A past billing run for last month (from last month's retainer invoices), so the log is not empty.
  if ((await prisma.billingRun.count({ where: { orgId } })) === 0) {
    const ist = new Date(now.getTime() + 330 * 60_000);
    const lastStart = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - 1, 1) - 330 * 60_000);
    const thisStart = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - 330 * 60_000);
    const period = new Date(lastStart.getTime() + 330 * 60_000).toISOString().slice(0, 7);
    const monthly = await prisma.engagement.findMany({ where: { orgId, billingType: 'monthly' }, select: { id: true } });
    const invs = await prisma.invoice.findMany({
      where: { orgId, engagementId: { in: monthly.map((m) => m.id) }, createdAt: { gte: lastStart, lt: thisStart }, status: { not: 'void' } },
      include: { clientOrg: { select: { name: true } } },
      take: 20,
    });
    const founder = await prisma.user.findFirst({ where: { orgId, email: 'finance@bmu.demo' }, select: { id: true } });
    if (invs.length && founder) {
      await prisma.billingRun.create({
        data: {
          orgId,
          period,
          createdById: founder.id,
          issuedCount: invs.length,
          skippedCount: 0,
          totalPaise: invs.reduce((s, i) => s + i.totalPaise, 0),
          invoiceIds: invs.map((i) => i.id),
          detail: { issued: invs.map((i) => ({ id: i.id, number: i.number, client: i.clientOrg?.name ?? '' })), skipped: [] },
          createdAt: new Date(lastStart.getTime() + 10 * 3600_000),
        },
      });
    }
  }

  // 6. A few example emails so the Outbox explains itself before anything is sent.
  if ((await prisma.emailOutbox.count({ where: { orgId, kind: { not: 'otp' } } })) === 0) {
    const owner = await prisma.user.findFirst({ where: { orgId, email: 'client@sunrise.demo' }, select: { id: true, name: true, email: true } });
    const inv = await prisma.invoice.findFirst({ where: { orgId, clientOrg: { name: 'Sunrise Realty Pvt Ltd' } }, orderBy: { createdAt: 'desc' } });
    if (owner?.email && inv) {
      const mk = (subject: string, body: string, kind: string, ago: number) => ({
        orgId,
        toEmail: owner.email!,
        toName: owner.name,
        toUserId: owner.id,
        subject,
        text: `${subject}\n\n${body}`,
        html: `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#121F2F;padding:24px"><h1 style="font-size:20px">${subject}</h1><p style="font-size:14px">${body}</p><p style="font-size:12px;color:#6b7280">Example email from the demo data.</p></body></html>`,
        kind,
        status: 'simulated',
        entity: 'Invoice',
        entityId: inv.id,
        createdAt: new Date(now.getTime() - ago * DAY),
      });
      await prisma.emailOutbox.createMany({
        data: [
          mk(`Tax invoice ${inv.number}: ${formatINR(inv.totalPaise)}`, `Hi ${owner.name.split(' ')[0]}, your tax invoice ${inv.number} is ready. Pay online from Billing, or by bank transfer / UPI.`, 'invoice_issued', 6),
          mk('Instagram carousel v2 is ready for your review', 'Approve it or leave comments on the exact spot that should change.', 'draft_ready', 3),
          mk(`Friendly reminder: invoice ${inv.number} is due`, 'A quick reminder that your invoice is due. If you have already paid, thank you.', 'invoice_reminder', 1),
        ],
      });
    }
  }
}

/** Existing demo conversations count as read up to now, so unread badges only show new messages. */
export async function seedServiceThreadReads(prisma: PrismaClient, orgId: string) {
  const threads = await prisma.thread.findMany({ where: { orgId }, include: { clientOrg: { select: { amUserId: true, users: { select: { userId: true } } } } } });
  for (const t of threads) {
    if (await prisma.threadRead.count({ where: { threadId: t.id } })) continue;
    const people = [t.clientOrg.amUserId, ...t.clientOrg.users.map((u) => u.userId)].filter((x): x is string => !!x);
    await prisma.threadRead.createMany({ data: people.map((userId) => ({ threadId: t.id, userId, orgId })), skipDuplicates: true });
  }
}
