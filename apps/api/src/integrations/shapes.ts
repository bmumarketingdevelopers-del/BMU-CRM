// v19: the outside-world shape of BMU records, shared by the public API v1 and webhook payloads. Only these fields
// ever leave BMU through those channels (no internal notes, costs, tokens or custom fields).
import type { PublicClient, PublicInvoice, PublicLead, PublicPost, PublicProject, PublicTask } from '@bmu/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { loadLedger } from '../insights/ledger.js';

type Contact = { name?: string; email?: string; phone?: string; company?: string };

export const leadSelect = { id: true, contact: true, stage: true, source: true, ownerId: true, createdAt: true, updatedAt: true } as const;
export async function leadShapes(prisma: PrismaService, rows: { id: string; contact: unknown; stage: string; source: string; ownerId: string | null; createdAt: Date; updatedAt: Date }[]): Promise<PublicLead[]> {
  const owners = new Map((await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.ownerId).filter((x): x is string => !!x) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  return rows.map((l) => {
    const c = (l.contact ?? {}) as Contact;
    return { id: l.id, name: c.name ?? '', company: c.company ?? null, email: c.email || null, phone: c.phone || null, stage: l.stage, source: l.source || null, owner: l.ownerId ? (owners.get(l.ownerId) ?? null) : null, createdAt: l.createdAt.toISOString(), updatedAt: l.updatedAt.toISOString() };
  });
}

export const clientSelect = { id: true, name: true, industry: true, gstin: true, amUserId: true, health: true, createdAt: true } as const;
export async function clientShapes(prisma: PrismaService, rows: { id: string; name: string; industry: string | null; gstin: string | null; amUserId: string | null; health: string; createdAt: Date }[]): Promise<PublicClient[]> {
  const ams = new Map((await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.amUserId).filter((x): x is string => !!x) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  return rows.map((c) => ({ id: c.id, name: c.name, industry: c.industry, gstin: c.gstin, accountManager: c.amUserId ? (ams.get(c.amUserId) ?? null) : null, health: c.health, createdAt: c.createdAt.toISOString() }));
}

export const projectSelect = { id: true, clientOrgId: true, status: true, createdAt: true, clientOrg: { select: { name: true } }, service: { select: { name: true } } } as const;
export const projectShape = (e: { id: string; clientOrgId: string; status: string; createdAt: Date; clientOrg: { name: string }; service: { name: string } }): PublicProject => ({ id: e.id, clientId: e.clientOrgId, client: e.clientOrg.name, service: e.service.name, status: e.status, createdAt: e.createdAt.toISOString() });

export const taskSelect = { id: true, title: true, status: true, priority: true, deadline: true, ownerId: true, engagementId: true, createdAt: true, deliverable: { select: { cycle: { select: { engagementId: true } } } } } as const;
export async function taskShapes(prisma: PrismaService, rows: { id: string; title: string; status: string; priority: string; deadline: Date | null; ownerId: string | null; engagementId: string | null; createdAt: Date; deliverable: { cycle: { engagementId: string } } | null }[]): Promise<PublicTask[]> {
  const engIds = [...new Set(rows.map((t) => t.engagementId ?? t.deliverable?.cycle.engagementId).filter((x): x is string => !!x))];
  const [owners, engs] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: rows.map((r) => r.ownerId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
    prisma.engagement.findMany({ where: { id: { in: engIds } }, select: { id: true, clientOrgId: true } }),
  ]);
  const o = new Map(owners.map((u) => [u.id, u.name]));
  const e = new Map(engs.map((x) => [x.id, x.clientOrgId]));
  return rows.map((t) => {
    const eng = t.engagementId ?? t.deliverable?.cycle.engagementId ?? null;
    return { id: t.id, title: t.title, status: t.status, priority: t.priority, deadline: t.deadline?.toISOString() ?? null, owner: t.ownerId ? (o.get(t.ownerId) ?? null) : null, projectId: eng, clientId: eng ? (e.get(eng) ?? null) : null, createdAt: t.createdAt.toISOString() };
  });
}

export async function invoiceShapes(prisma: PrismaService, orgId: string, ids: string[]): Promise<PublicInvoice[]> {
  if (!ids.length) return [];
  const ledger = await loadLedger(prisma, orgId, { id: { in: ids } });
  const byId = new Map(ledger.map((i) => [i.id, i]));
  return ids
    .map((id) => byId.get(id))
    .filter((i): i is NonNullable<typeof i> => !!i)
    .map((i) => ({ id: i.id, number: i.number, clientId: i.clientOrgId, client: i.clientOrg?.name ?? null, status: i.displayStatus, subtotalPaise: i.subtotalPaise, gstPaise: i.gstPaise, totalPaise: i.totalPaise, paidPaise: i.paidPaise, dueDate: i.dueDate.toISOString(), createdAt: i.createdAt.toISOString() }));
}

export const postSelect = { id: true, title: true, status: true, channel: true, scheduledAt: true, publishedAt: true, liveUrl: true, cycle: { select: { engagement: { select: { clientOrgId: true, clientOrg: { select: { name: true } } } } } } } as const;
export const postShape = (d: { id: string; title: string; status: string; channel: string | null; scheduledAt: Date | null; publishedAt: Date | null; liveUrl: string | null; cycle: { engagement: { clientOrgId: string; clientOrg: { name: string } } } }): PublicPost => ({
  id: d.id,
  title: d.title,
  clientId: d.cycle.engagement.clientOrgId,
  client: d.cycle.engagement.clientOrg.name,
  channel: d.channel,
  status: d.status,
  scheduledAt: d.scheduledAt?.toISOString() ?? null,
  publishedAt: d.publishedAt?.toISOString() ?? null,
  liveUrl: d.liveUrl,
});

/** Webhook `data`: the record in its public shape, or null for record types that are not shared outside. */
export async function snapshot(prisma: PrismaService, orgId: string, entity: string, id: string): Promise<Record<string, unknown> | null> {
  switch (entity) {
    case 'Lead': {
      const l = await prisma.lead.findFirst({ where: { id, orgId }, select: leadSelect });
      return l ? (await leadShapes(prisma, [l]))[0] : null;
    }
    case 'ClientOrg': {
      const c = await prisma.clientOrg.findFirst({ where: { id, orgId }, select: clientSelect });
      return c ? (await clientShapes(prisma, [c]))[0] : null;
    }
    case 'Engagement': {
      const e = await prisma.engagement.findFirst({ where: { id, orgId }, select: projectSelect });
      return e ? projectShape(e) : null;
    }
    case 'Task': {
      const t = await prisma.task.findFirst({ where: { id, orgId }, select: taskSelect });
      return t ? (await taskShapes(prisma, [t]))[0] : null;
    }
    case 'Invoice':
      return (await invoiceShapes(prisma, orgId, [id]))[0] ?? null;
    case 'Deliverable': {
      const d = await prisma.deliverable.findFirst({ where: { id, orgId }, select: postSelect });
      return d ? postShape(d) : null;
    }
    case 'Meeting': {
      const m = await prisma.meeting.findFirst({ where: { id, orgId }, select: { id: true, title: true, startAt: true, endAt: true, status: true, clientOrgId: true, leadId: true, bookedVia: true } });
      return m ? { ...m, startAt: m.startAt.toISOString(), endAt: m.endAt.toISOString() } : null;
    }
    case 'Proposal': {
      const p = await prisma.proposal.findFirst({ where: { id, orgId }, select: { id: true, leadId: true, status: true, createdAt: true } });
      return p ? { ...p, createdAt: p.createdAt.toISOString() } : null;
    }
    default:
      return null;
  }
}
