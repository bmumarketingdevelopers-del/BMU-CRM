// v11 clients: who may see / change a client. The CM sees their own clients (and a previous CM keeps read access for
// 7 days after a reassignment); leadership, finance, department heads and sales managers see every client.
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { CLIENTS_SEE_ALL_ROLES, type Me } from '@bmu/shared';
import { hasRole } from '../actions/people.js';
import type { PrismaService } from '../prisma/prisma.service.js';

export const isStaff = (me: Me) => me.type === 'staff';
export const isAdmin = (me: Me) => hasRole(me, 'founder', 'admin');
export const isClientLead = (me: Me) => hasRole(me, 'founder', 'admin', 'am_lead');
export const seesAllClients = (me: Me) => hasRole(me, ...CLIENTS_SEE_ALL_ROLES);
export const AM_BASE_ROLES = ['account_manager', 'am_lead'];

export function assertStaff(me: Me) {
  if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
}

/** Previous CM (reassigned within 7 days): read-only access to the client. */
export async function hasHandoverAccess(prisma: PrismaService, me: Me, clientOrgId: string) {
  const a = await prisma.assignment.findFirst({ where: { orgId: me.orgId, targetType: 'client_am', targetId: clientOrgId, fromUserId: me.id, readAccessUntil: { gt: new Date() } }, select: { id: true } });
  return !!a;
}

/** Loads a client the person can see. `write` = they must be its CM or leadership (not just read access). */
export async function loadClient(prisma: PrismaService, me: Me, id: string, opts: { write?: boolean; includeArchived?: boolean } = {}) {
  assertStaff(me);
  const c = await prisma.clientOrg.findFirst({ where: { id, orgId: me.orgId, deletedAt: null } });
  if (!c) throw new NotFoundException('Client not found');
  if (seesAllClients(me)) return { client: c, readOnly: false };
  if (hasRole(me, 'account_manager') && c.amUserId === me.id) return { client: c, readOnly: false };
  if (!opts.write && (await hasHandoverAccess(prisma, me, id))) return { client: c, readOnly: true };
  if (opts.write && hasRole(me, 'account_manager') && (await hasHandoverAccess(prisma, me, id))) throw new ForbiddenException('You handed this client over. You can still read it for 7 days, but only the new client manager can change it.');
  throw new ForbiddenException(hasRole(me, 'account_manager') ? 'This client belongs to another Client Manager' : "You don't have access to this client");
}

/** Is `me` the client's CM (or leadership) — the people who run the account day to day. */
export const runsClient = (me: Me, c: { amUserId: string | null }) => isClientLead(me) || (hasRole(me, 'account_manager') && c.amUserId === me.id);

export type ContactJson = { name?: string | null; phone?: string | null; email?: string | null };
export const contactOf = (c: { primaryContact: unknown }) => {
  const j = (c.primaryContact ?? {}) as ContactJson;
  return { name: j.name ?? null, phone: j.phone ?? null, email: j.email ?? null };
};

/** "2026-10" for a Date in IST. */
export const istMonth = (d = new Date()) => new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 7);
