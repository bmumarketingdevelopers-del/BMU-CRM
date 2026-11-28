// Who sees which tab: the same rules as the menus.
// - Team app: apps/web/src/app/(team)/team/layout.tsx
// - Command Centre: ADMIN_PAGE_ROLES in @bmu/shared (used by apps/web/src/lib/admin-nav.ts)
// - Client portal: apps/web/src/app/(client)/client/layout.tsx
import { adminPageAllowed, canOpenCraftManager, isCraftManager, type Me } from '@bmu/shared';

const any = (me: Me, roles: string[]) => me.type === 'staff' && me.roles.some((r) => roles.includes(r));
const staff = (me: Me) => me.type === 'staff';

export const team = {
  everyone: staff,
  hasLeads: (me: Me) => staff(me) && (me.permissions.leads_pipeline?.scope ?? 'none') !== 'none',
  allLeads: (me: Me) => staff(me) && me.permissions.leads_pipeline?.scope === 'all',
  clientTeam: (me: Me) => any(me, ['founder', 'admin', 'am_lead', 'account_manager', 'finance']),
  clientChat: (me: Me) => any(me, ['founder', 'admin', 'am_lead', 'account_manager']),
  inbox: (me: Me) => any(me, ['founder', 'admin', 'am_lead', 'account_manager', 'sales_manager', 'sales_executive']),
  canQc: (me: Me) => staff(me) && (me.permissions.qc_pass_fail?.scope ?? 'none') !== 'none',
  discountApprovals: (me: Me) => any(me, ['sales_manager', 'admin', 'founder']),
  clientManager: (me: Me) => any(me, ['account_manager']),
  cmInvoices: (me: Me) => any(me, ['am_lead', 'account_manager']),
  quotations: (me: Me) => any(me, ['founder', 'admin', 'am_lead', 'account_manager', 'finance']),
  creators: (me: Me) => any(me, ['founder', 'admin', 'am_lead', 'account_manager', 'department_head']),
  specialists: (me: Me) => any(me, ['founder', 'admin', 'am_lead', 'department_head']),
  dailyReports: (me: Me) => staff(me) && !!me.leadsPeople,
  managerWorkspace: (me: Me) => staff(me) && (isCraftManager(me) || canOpenCraftManager(me)),
};

/** A Command Centre page by its menu label, e.g. admin('Collections'). */
export const admin = (label: string) => (me: Me) => staff(me) && adminPageAllowed(me.roles, label);

export const client = {
  everyone: (me: Me) => me.type === 'client',
  canBill: (me: Me) => me.type === 'client' && (me.permissions.invoices_payments?.scope ?? 'none') !== 'none',
};
