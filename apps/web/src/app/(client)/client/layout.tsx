import { AppShell } from "@/components/app-shell";
import type { NavSection } from "@/components/side-nav";
import { requireMe, serverApi } from "@/lib/session";

// Client-facing labels follow the glossary: Milestone, Extra request, Project start date.
// v17: the menu follows the person's client role (only owners and finance see billing).
const navFor = (canBill: boolean): NavSection[] => [
  {
    section: "Your account",
    items: [
      { label: "Home", href: "/client" },
      { label: "Project journey", href: "/client/journey" },
      { label: "Onboarding", href: "/client/onboarding" },
      { label: "Approvals", href: "/client/approvals" },
      { label: "Review Studio", href: "/client/reviews" },
      { label: "Content calendar", href: "/client/calendar" },
      { label: "Requests", href: "/client/requests" },
      { label: "Files", href: "/client/files" },
      { label: "Asset library", href: "/client/assets" },
      { label: "Brand kit", href: "/client/brand-kit" },
      ...(canBill ? [{ label: "Billing", href: "/client/billing" }] : []),
      { label: "Reports", href: "/client/reports" },
      { label: "Insights", href: "/client/insights" },
      { label: "Messages", href: "/client/messages" },
      { label: "Meetings", href: "/client/meetings" },
      { label: "Documents", href: "/client/docs" },
    ],
  },
  {
    section: "Settings",
    items: [
      { label: "Account and services", href: "/client/settings" },
      { label: "Team users", href: "/client/team" },
      { label: "Profile & notifications", href: "/client/profile" },
    ],
  },
];

export async function generateMetadata() {
  const branding = await (await serverApi()).teamFlows.branding().catch(() => null);
  return { title: branding?.clientAppName ?? "BMU Hub" };
}

export default async function ClientLayout({ children }: { children: React.ReactNode }) {
  const me = await requireMe(["client"]);
  // Client app name and colours from Command Centre → Branding & Theme.
  const branding = await (await serverApi()).teamFlows.branding().catch(() => null);
  const brand = branding ? { name: branding.clientAppName, primary: branding.primary, accent: branding.accent, logoUrl: branding.logoUrl } : undefined;
  return (
    <AppShell me={me} surface="Client app" nav={navFor((me.permissions.invoices_payments?.scope ?? "none") !== "none")} brand={brand}>
      {children}
    </AppShell>
  );
}
