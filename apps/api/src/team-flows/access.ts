import type { Me } from '@bmu/shared';

export const isStaff = (me: Me) => me.type === 'staff';
export const hasRole = (me: Me, ...roles: string[]) => isStaff(me) && me.roles.some((r) => roles.includes(r));
export const capable = (me: Me, cap: keyof Me['permissions']) => (me.permissions[cap]?.scope ?? 'none') !== 'none';

/** HR, Admin and the Founder run onboarding/offboarding (and need the people capability). */
export const canManagePeople = (me: Me) => hasRole(me, 'founder', 'admin', 'hr_ops') && capable(me, 'users_roles_hierarchy');
/** Department heads can follow progress. */
export const canReadPeople = (me: Me) => canManagePeople(me) || (hasRole(me, 'department_head') && capable(me, 'users_roles_hierarchy'));
/** Org-wide approvers for timesheets and long leave. */
export const isHrApprover = (me: Me) => hasRole(me, 'founder', 'admin', 'hr_ops');

/** yyyy-mm-dd → @db.Date value. */
export const dbDay = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
/** @db.Date value → yyyy-mm-dd. */
export const dayStr = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (ymd: string, n: number) => dayStr(new Date(dbDay(ymd).getTime() + n * 86_400_000));
/** Monday of the week containing ymd. */
export function mondayOf(ymd: string) {
  const dow = dbDay(ymd).getUTCDay();
  return addDays(ymd, -((dow + 6) % 7));
}
