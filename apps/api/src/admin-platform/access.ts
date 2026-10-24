import { ForbiddenException } from '@nestjs/common';
import type { AdminPlatformAccess, Me } from '@bmu/shared';

const OPS_ROLES = ['founder', 'admin', 'department_head'];

export const isStaff = (me: Me) => me.type === 'staff';
export const isFounderOrAdmin = (me: Me) => isStaff(me) && me.roles.some((r) => r === 'founder' || r === 'admin');

/** Operations edits (SOPs, checklists, gate and SLA rules): Founder, Branch Manager or department heads with edit rights. */
export function canEditOperations(me: Me) {
  const rule = me.permissions.sop_checklists_flow_templates?.rule ?? 'none';
  return isStaff(me) && me.roles.some((r) => OPS_ROLES.includes(r)) && (rule === 'full' || rule.startsWith('edit'));
}

export const accessFor = (me: Me): AdminPlatformAccess => ({ operations: canEditOperations(me), platform: isFounderOrAdmin(me) });

export function assertStaff(me: Me) {
  if (!isStaff(me)) throw new ForbiddenException('Team accounts only');
}
export function assertOperations(me: Me) {
  if (!canEditOperations(me)) throw new ForbiddenException('Only Founder, Branch Manager or department heads can change this');
}
/**
 * v43 client data (Data Export / Deletion) and privacy (DPDP): the Founder for every client, and Client Managers for the
 * clients they manage. Branch Managers no longer have it.
 */
export const isFounder = (me: Me) => isStaff(me) && me.roles.includes('founder');
export const canClientData = (me: Me) => isStaff(me) && me.roles.some((r) => r === 'founder' || r === 'account_manager');
export function assertClientData(me: Me) {
  if (!canClientData(me)) throw new ForbiddenException("Only the Founder or the client's Client Manager can do this");
}
/** The clients `me` may act on: every client for the Founder, otherwise the ones they are Client Manager of. */
export const clientDataWhere = (me: Me) => (isFounder(me) ? {} : { amUserId: me.id });

export function assertPlatform(me: Me) {
  if (!isFounderOrAdmin(me)) throw new ForbiddenException('Only the Founder or a Branch Manager can do this');
}
