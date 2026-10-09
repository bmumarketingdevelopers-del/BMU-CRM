import { ForbiddenException } from '@nestjs/common';
import type { Me } from '@bmu/shared';

const has = (me: Me, roles: string[]) => me.type === 'staff' && me.roles.some((r) => roles.includes(r));
const capable = (me: Me, cap: keyof Me['permissions']) => (me.permissions[cap]?.scope ?? 'none') !== 'none';

export const ORG_EDITORS = ['founder', 'admin', 'hr_ops'];
export const LEAVE_DECIDERS = ['founder', 'admin', 'hr_ops'];
export const CLIENT_ADMINS = ['founder', 'admin', 'am_lead'];
export const AM_ROLES = ['account_manager', 'am_lead'];

/** Organisation screens: users_roles_hierarchy + Founder/Admin/HR. Department heads may look, not change. */
export function canEditOrg(me: Me) {
  return has(me, ORG_EDITORS) && capable(me, 'users_roles_hierarchy');
}
export function assertOrgReader(me: Me) {
  if (!(has(me, [...ORG_EDITORS, 'department_head']) && capable(me, 'users_roles_hierarchy'))) throw new ForbiddenException("You don't have access to the organisation settings");
}
export function assertOrgEditor(me: Me) {
  if (!canEditOrg(me)) throw new ForbiddenException('Only the Founder, Admin or HR can change the organisation');
}

/** Clients screens: Founder, Admin, AM Lead. */
export function assertClientAdmin(me: Me) {
  if (!has(me, CLIENT_ADMINS)) throw new ForbiddenException('Only the Founder, Admin or AM Lead can do this');
}

/** Catalogue screens: catalogue_pricing_engine. */
export function assertCatalogue(me: Me) {
  if (me.type !== 'staff' || !capable(me, 'catalogue_pricing_engine')) throw new ForbiddenException("You don't have access to the catalogue");
}

export const isLeaveDecider = (me: Me) => has(me, LEAVE_DECIDERS);
