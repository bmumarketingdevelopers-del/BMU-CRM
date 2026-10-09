import type { PrismaClient } from '../../src/generated/prisma/client.js';

// v16 creative studio demo data. Idempotent: every block checks before it writes.
// - Approved work gets its approved version on record (older demo rows only had the status), so the calendar's
//   "only approved work" rule holds for seeded posts too.
// - Up to 16 approved deliverables appear in the asset library (as approval does in the app), plus one collection.
// - Instagram / Facebook / LinkedIn channels for up to 4 retainer clients; one of them lets BMU approve posts.
// - Results on published posts that have none yet.

const SOCIAL = ['post', 'reel', 'story', 'carousel', 'ad'];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20);

export async function seedCreative(prisma: PrismaClient, orgId: string) {
  const founder = await prisma.user.findFirst({ where: { orgId, email: 'founder@bmu.demo' }, select: { id: true } });
  if (!founder) return;

  // 1. Approved version on record for approved / scheduled / published work that has versions.
  const missing = await prisma.deliverable.findMany({
    where: { orgId, status: { in: ['approved', 'scheduled', 'published'] }, approvedVersionId: null, versions: { some: {} } },
    select: { id: true, versions: { orderBy: { number: 'desc' }, take: 1, select: { id: true } } },
  });
  for (const d of missing) await prisma.deliverable.update({ where: { id: d.id }, data: { approvedVersionId: d.versions[0].id } });

  // 2. Asset library from approved work.
  if ((await prisma.asset.count({ where: { orgId } })) === 0) {
    const approved = await prisma.deliverable.findMany({
      where: { orgId, approvedVersionId: { not: null } },
      orderBy: { id: 'asc' },
      take: 16,
      include: { cycle: { select: { engagement: { select: { clientOrgId: true } } } }, versions: { include: { file: true } } },
    });
    for (const d of approved) {
      const v = d.versions.find((x) => x.id === d.approvedVersionId);
      if (!v) continue;
      const a = await prisma.asset.create({
        data: { orgId, clientOrgId: d.cycle.engagement.clientOrgId, title: d.title, kind: v.file.kind, tags: [d.type.toLowerCase()], source: 'deliverable', deliverableId: d.id, clientVisible: true, createdById: v.uploadedById },
      });
      const av = await prisma.assetVersion.create({ data: { orgId, assetId: a.id, number: 1, fileId: v.fileId, note: `Approved v${v.number}`, uploadedById: v.uploadedById } });
      await prisma.asset.update({ where: { id: a.id }, data: { currentVersionId: av.id } });
    }
    const first = await prisma.asset.findFirst({ where: { orgId, clientOrgId: { not: null } }, orderBy: { createdAt: 'asc' } });
    if (first?.clientOrgId) {
      const c = await prisma.assetCollection.create({ data: { orgId, clientOrgId: first.clientOrgId, name: 'Festive season 2026', description: 'Diwali and year-end campaign creatives', createdById: founder.id } });
      const some = await prisma.asset.findMany({ where: { orgId, clientOrgId: first.clientOrgId }, take: 4, select: { id: true } });
      await prisma.asset.updateMany({ where: { id: { in: some.map((x) => x.id) } }, data: { collectionId: c.id, tags: { push: 'festive' } } });
      // A licensed photo whose rights end soon, so the warning shows.
      if (some[0]) await prisma.asset.update({ where: { id: some[0].id }, data: { rightsNote: 'Stock photo licence: organic social only, no paid ads', rightsExpireAt: new Date(Date.now() + 10 * 86_400_000) } });
    }
  }

  // 3. Channels and the publishing rule.
  if ((await prisma.contentChannel.count({ where: { orgId } })) === 0) {
    const clients = await prisma.clientOrg.findMany({
      where: { orgId, deletedAt: null, engagements: { some: { billingType: 'monthly', status: 'active_retainer', deletedAt: null } } },
      orderBy: { name: 'asc' },
      take: 4,
      select: { id: true, name: true },
    });
    for (const c of clients) {
      const h = slug(c.name);
      await prisma.contentChannel.createMany({
        data: [
          { orgId, clientOrgId: c.id, platform: 'instagram', handle: `@${h}`, url: `https://www.instagram.com/${h}`, createdById: founder.id },
          { orgId, clientOrgId: c.id, platform: 'facebook', handle: c.name, url: null, createdById: founder.id },
          { orgId, clientOrgId: c.id, platform: 'linkedin', handle: c.name, url: null, createdById: founder.id },
        ],
        skipDuplicates: true,
      });
    }
    if (clients[1]) await prisma.clientOrg.update({ where: { id: clients[1].id }, data: { publishNeedsApproval: false } });
  }

  // 4. Results on published posts.
  const published = await prisma.deliverable.findMany({ where: { orgId, status: 'published', type: { in: SOCIAL } }, select: { id: true }, orderBy: { id: 'asc' }, take: 40 });
  const withMetrics = new Set((await prisma.postMetric.findMany({ where: { orgId }, select: { deliverableId: true } })).map((m) => m.deliverableId));
  for (const [i, p] of published.entries()) {
    if (withMetrics.has(p.id)) continue;
    const reach = 1800 + ((i * 2371) % 9000);
    await prisma.postMetric.create({
      data: { orgId, deliverableId: p.id, reach, impressions: Math.round(reach * 1.6), engagement: Math.round(reach * (0.03 + (i % 5) * 0.01)), clicks: Math.round(reach * 0.012), spendPaise: i % 3 === 0 ? 150_000 : 0, recordedById: founder.id },
    });
  }
}
