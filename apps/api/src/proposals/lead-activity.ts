import type { PrismaService } from '../prisma/prisma.service.js';

type Tx = Pick<PrismaService, 'leadActivity' | 'lead'>;

/** Adds an entry to a lead's activity timeline (system entries: views, change requests, payments...). */
export async function logLeadActivity(
  prisma: Tx,
  a: { orgId: string; leadId: string; kind: string; body: string; userId?: string | null; outcome?: string | null; at?: Date; nextFollowUpAt?: Date | null },
) {
  const at = a.at ?? new Date();
  await prisma.leadActivity.create({
    data: { orgId: a.orgId, leadId: a.leadId, kind: a.kind, body: a.body, userId: a.userId ?? null, outcome: a.outcome ?? null, at, nextFollowUpAt: a.nextFollowUpAt ?? null },
  });
  await prisma.lead.update({ where: { id: a.leadId }, data: { lastActivityAt: at } });
}
