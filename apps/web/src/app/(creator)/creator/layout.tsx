import { AppShell } from "@/components/app-shell";
import type { NavSection } from "@/components/side-nav";
import { requireMe } from "@/lib/session";

const nav: NavSection[] = [
  {
    section: "Your work",
    items: [
      { label: "Briefs", href: "/creator" },
      { label: "Revisions", href: "/creator/revisions" },
      { label: "Payouts", href: "/creator/payouts" },
    ],
  },
  { section: "You", items: [{ label: "Profile", href: "/creator/profile" }] },
];

export default async function CreatorLayout({ children }: { children: React.ReactNode }) {
  const me = await requireMe(["creator"]);
  return (
    <AppShell me={me} surface="Creator portal" nav={nav}>
      {children}
    </AppShell>
  );
}
