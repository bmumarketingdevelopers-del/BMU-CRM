import { ForbiddenException } from '@nestjs/common';
import type { Me } from '@bmu/shared';

/** Roles that read the Command Centre dashboards (same readers as organisation settings). */
const COMMAND_ROLES = ['founder', 'admin', 'department_head', 'finance', 'am_lead'];
const FINANCE_WRITERS = ['founder', 'admin', 'finance'];

const scope = (me: Me, cap: 'invoices_payments' | 'revenue_margins') => me.permissions[cap]?.scope ?? 'none';
const isStaff = (me: Me) => me.type === 'staff';

export const canReadCommand = (me: Me) => isStaff(me) && me.roles.some((r) => COMMAND_ROLES.includes(r));
/** Money dashboards: revenue_margins or invoices_payments (Founder, Admin, Finance). */
export const canSeeMoney = (me: Me) => isStaff(me) && (scope(me, 'revenue_margins') !== 'none' || scope(me, 'invoices_payments') !== 'none');
export const canReadFinance = (me: Me) => isStaff(me) && scope(me, 'invoices_payments') !== 'none';
export const canWriteFinance = (me: Me) => canReadFinance(me) && me.roles.some((r) => FINANCE_WRITERS.includes(r));
/** Everyone except a department head sees every department. */
export const seesAllDepartments = (me: Me) => me.roles.some((r) => ['founder', 'admin', 'finance', 'am_lead'].includes(r));

export function assertCommand(me: Me) {
  if (!canReadCommand(me)) throw new ForbiddenException('Command Centre only');
}
export function assertMoney(me: Me) {
  if (!canSeeMoney(me)) throw new ForbiddenException('Revenue and collections are for Founder, Admin and Finance');
}
export function assertFinanceRead(me: Me) {
  if (!canReadFinance(me)) throw new ForbiddenException('Finance is for Founder, Admin and Finance');
}
export function assertFinanceWrite(me: Me) {
  if (!canWriteFinance(me)) throw new ForbiddenException('Only Founder, Admin and Finance can change invoices and payouts');
}
