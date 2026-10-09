import type { PrismaClient } from '../../src/generated/prisma/client.js';

// v10 deliver demo data. Idempotent: every block checks before it writes.
// - Content calendar: up to 8 approved social posts from running retainers get a date and channel in the current
//   month; the ones already in the past are marked published with a live link.
// - Handover pack: links and notes on Sunrise's Logo & Brand Kit and on a few delivered projects.
// - Client feedback (NPS) on delivered projects, so Client Health shows the rating.
// - Approval rule example: one client set to "The owner must approve".
// Retainer months themselves are not seeded: the delivery job starts the current month for every running retainer
// (quota, carried-over items, plan, invoice) 20 seconds after the API starts, exactly as it does in production.

const SOCIAL = ['post', 'reel', 'story', 'carousel'];
const CHANNELS = ['instagram', 'facebook', 'linkedin', 'instagram', 'youtube', 'instagram', 'facebook', 'linkedin'];
const DAY = 86_400_000;
const IST = 5.5 * 3_600_000;

export async function seedDeliver(prisma: PrismaClient, orgId: string) {
  const founder = await prisma.user.findFirst({ where: { orgId, email: 'founder@bmu.demo' }, select: { id: true } });
  if (!founder) return;

  // Content calendar
  const already = await prisma.deliverable.count({ where: { orgId, scheduledAt: { not: null } } });
  if (already === 0) {
    const posts = await prisma.deliverable.findMany({
      where: { orgId, type: { in: SOCIAL }, status: 'approved', cycle: { engagement: { billingType: 'monthly', deletedAt: null, status: 'active_retainer' } } },
      orderBy: { id: 'asc' },
      take: 8,
      select: { id: true },
    });
    const nowIst = new Date(Date.now() + IST);
    const monthStart = Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), 1) - IST; // 00:00 IST on the 1st
    for (const [i, p] of posts.entries()) {
      const at = new Date(monthStart + (2 + i * 3) * DAY + (11 + (i % 3) * 3) * 3_600_000); // 11:00, 14:00, 17:00 IST
      const past = at.getTime() < Date.now();
      await prisma.deliverable.update({
        where: { id: p.id },
        data: {
          status: past ? 'published' : 'scheduled',
          scheduledAt: at,
          channel: CHANNELS[i % CHANNELS.length],
          ...(past ? { publishedAt: at, liveUrl: `https://www.instagram.com/p/bmu-demo-${i + 1}` } : {}),
        },
      });
    }
  }

  // Handover pack items
  const sunrise = await prisma.clientOrg.findFirst({ where: { orgId, name: 'Sunrise Realty Pvt Ltd' }, select: { id: true } });
  const sunriseKit = sunrise
    ? await prisma.engagement.findFirst({ where: { orgId, clientOrgId: sunrise.id, billingType: 'one_time', deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true } })
    : null;
  const delivered = await prisma.engagement.findMany({
    where: { orgId, status: 'delivered', finalSignedOffAt: { not: null }, deletedAt: null },
    orderBy: { finalSignedOffAt: 'asc' },
    take: 3,
    select: { id: true, clientOrgId: true },
  });
  const packs: { engagementId: string; kind: string; label: string; value: string }[] = [];
  if (sunriseKit) {
    packs.push(
      { engagementId: sunriseKit.id, kind: 'link', label: 'Brand files (Figma)', value: 'https://www.figma.com/file/sunrise-heights-brand' },
      { engagementId: sunriseKit.id, kind: 'note', label: 'Fonts', value: 'Headings: Fraunces. Body: Inter. Both free on Google Fonts.' },
    );
  }
  for (const e of delivered) {
    packs.push(
      { engagementId: e.id, kind: 'link', label: 'Source files (Drive)', value: 'https://drive.google.com/drive/folders/bmu-demo-handover' },
      { engagementId: e.id, kind: 'note', label: 'Colour codes', value: 'Primary #1F2A2E, accent #8BC34A, background #F7F4EE.' },
    );
  }
  for (const p of packs) {
    const exists = await prisma.deliverHandoverItem.findFirst({ where: { engagementId: p.engagementId, label: p.label, deletedAt: null }, select: { id: true } });
    if (!exists) await prisma.deliverHandoverItem.create({ data: { orgId, ...p, createdById: founder.id } });
  }

  // Client feedback (NPS) on delivered projects
  const scores: [number, string][] = [
    [10, 'Quick turnaround and the files were easy to find.'],
    [9, 'Great work. One extra revision round would have helped.'],
    [7, 'Good result, but the first draft came in late.'],
  ];
  for (const [i, e] of delivered.entries()) {
    const owner = await prisma.clientUser.findFirst({ where: { clientOrgId: e.clientOrgId, clientRole: 'client_owner' }, select: { userId: true } });
    if (!owner) continue;
    const [score, comment] = scores[i % scores.length];
    await prisma.deliverFeedback.upsert({
      where: { engagementId_userId: { engagementId: e.id, userId: owner.userId } },
      update: {},
      create: { orgId, engagementId: e.id, clientOrgId: e.clientOrgId, userId: owner.userId, score, comment },
    });
  }

  // Approval rule example (a client with a single decider, so nothing else is held up)
  const example = await prisma.clientOrg.findFirst({ where: { orgId, name: 'Vijayanagar Furnishings' }, select: { id: true, approvalMode: true } });
  if (example && example.approvalMode === 'any') await prisma.clientOrg.update({ where: { id: example.id }, data: { approvalMode: 'owner' } });
}
