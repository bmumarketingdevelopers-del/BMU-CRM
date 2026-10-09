import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { adminNavFor } from "@/lib/admin-nav";
import { requireMe } from "@/lib/session";

const ADMIN_ROLES = ["founder", "admin", "department_head", "finance", "hr_ops", "am_lead"];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const me = await requireMe(["staff"]);
  if (!me.roles.some((r) => ADMIN_ROLES.includes(r))) redirect("/team");
  return (
    <AppShell me={me} surface="Command Centre" nav={adminNavFor(me.roles)}>
      {children}
    </AppShell>
  );
}
