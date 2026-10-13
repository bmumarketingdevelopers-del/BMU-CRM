import { canOpenCraftManager, isCraftManager, isCraftSpecialty } from "@bmu/shared";
import { AppShell } from "@/components/app-shell";
import type { NavSection } from "@/components/side-nav";
import { requireMe, serverApi } from "@/lib/session";

export default async function TeamLayout({ children }: { children: React.ReactNode }) {
  const me = await requireMe(["staff"]);
  const hasLeads = (me.permissions.leads_pipeline?.scope ?? "none") !== "none";
  const isClientTeam = me.roles.some((r) => ["founder", "admin", "am_lead", "account_manager", "finance"].includes(r));
  const canQc = (me.permissions.qc_pass_fail?.scope ?? "none") !== "none";
  const isAdmin = me.roles.some((r) => ["founder", "admin", "department_head", "finance", "hr_ops", "am_lead"].includes(r));
  // v12: Dashboards shows when the Studio has shared one with this person (Founder and Branch Manager always see it).
  const isStudio = me.roles.some((r) => r === "founder" || r === "admin");
  const dashboards = isStudio ? [] : await (await serverApi()).dashboards.mine().catch(() => []);
  const nav: NavSection[] = [
    {
      section: "Work",
      items: [
        { label: isCraftSpecialty(me.specialty) || isCraftManager(me) ? "My workspace" : "My Day", href: "/team" },
        ...(canOpenCraftManager(me) && !isCraftManager(me) ? [{ label: "Manager workspace", href: "/team/manager" }] : []),
        ...(isStudio || dashboards.length ? [{ label: "Dashboards", href: "/team/dashboards" }] : []),
        ...(hasLeads ? [{ label: "Leads", href: "/team/leads" }, { label: "Proposals", href: "/team/proposals" }] : []),
        ...(me.roles.some((r) => ["sales_manager", "admin", "founder"].includes(r)) ? [{ label: "Discount approvals", href: "/team/approvals" }] : []),
        ...(me.permissions.leads_pipeline?.scope === "all" ? [{ label: "Renewals", href: "/team/renewals" }] : []),
        ...(isClientTeam ? [{ label: "Client 360", href: "/team/clients" }] : []),
        { label: "Tasks", href: "/team/tasks" },
        ...(canQc ? [{ label: "QC queue", href: "/team/qc" }] : []),
        { label: "Review Studio", href: "/team/reviews" },
        { label: "Projects", href: "/team/projects" },
        ...(isClientTeam ? [{ label: "Requests inbox", href: "/team/requests" }] : []),
        ...(isClientTeam && !me.roles.every((r) => r === "finance") ? [{ label: "Messages", href: "/team/messages" }] : []),
        ...(me.roles.some((r) => ["founder", "admin", "am_lead", "account_manager", "sales_manager", "sales_executive"].includes(r)) ? [{ label: "Inbox", href: "/team/inbox" }] : []),
        { label: "Meetings", href: "/team/meetings" },
        { label: "Goals", href: "/team/goals" },
        { label: "Documents", href: "/team/docs" },
        ...(me.roles.some((r) => ["founder", "admin", "am_lead", "account_manager", "department_head"].includes(r)) ? [{ label: "Creators", href: "/team/creators" }] : []),
        { label: "Files", href: "/team/files" },
        { label: "Asset library", href: "/team/assets" },
        { label: "Brand kits", href: "/team/brand-kits" },
        { label: "Discussions", href: "/team/discussions" },
      ],
    },
    { section: "Plan", items: [{ label: "Calendar", href: "/team/calendar" }, { label: "Content calendar", href: "/team/content-calendar" }, { label: "Capacity", href: "/team/capacity" }, { label: "Workload", href: "/team/workload" }, ...(me.roles.some((r) => ["founder", "admin", "am_lead", "department_head"].includes(r)) ? [{ label: "Specialists", href: "/team/specialists" }] : []), { label: "SOP library", href: "/team/sops" }] },
    {
      section: "You",
      items: [
        { label: "My performance", href: "/team/performance" },
        { label: "My timesheet", href: "/team/timesheet" },
        { label: "My expenses", href: "/team/expenses" },
        { label: "Approvals", href: "/team/approvals" },
        { label: "Agent Inbox", href: "/team/agent-inbox" },
        { label: "My onboarding", href: "/team/onboarding" },
        { label: "Profile, leave & attendance", href: "/team/profile" },
      ],
    },
    ...(isAdmin ? [{ section: "Admin", items: [{ label: "Command Centre", href: "/admin" }, ...(isStudio ? [{ label: "Dashboard Studio", href: "/admin/dashboards" }] : [])] }] : []),
  ];
  return (
    <AppShell me={me} surface="Team app" nav={nav}>
      {children}
    </AppShell>
  );
}
