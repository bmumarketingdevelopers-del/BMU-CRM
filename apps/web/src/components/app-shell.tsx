import { APP_VERSION, roleLabel } from "@bmu/shared";
import type { Me } from "@bmu/shared";
import { Copilot } from "./ai/copilot";
import { Logo } from "./logo";
import { NotificationBell } from "./notification-bell";
import { SignOutButton } from "./sign-out-button";
import { SideNav, type NavSection } from "./side-nav";
import { GlobalSearch } from "./global-search";
import { ActionsProvider } from "./actions/actions-provider";
import { TopBar } from "./actions/top-bar";
import { LiveProvider } from "@/lib/live";
import { LiveStatus } from "./live/live-status";

/** Client-app branding from Command Centre → Branding & Theme. */
export type ShellBrand = { name: string; primary: string; accent: string; logoUrl: string };

/** Frame for signed-in surfaces: a quiet sidebar with hairline borders and a white work area. */
export function AppShell({ me, surface, nav, children, brand }: { me: Me; surface: string; nav: NavSection[]; children: React.ReactNode; brand?: ShellBrand }) {
  const brandStyle = brand
    ? ({ "--color-green": brand.accent, "--bmu-green": brand.accent, "--color-charcoal": brand.primary, "--bmu-charcoal": brand.primary } as React.CSSProperties)
    : undefined;
  const shell = (
    <div className="flex min-h-screen flex-col md:flex-row" style={brandStyle}>
      <aside className="print:hidden border-b border-border bg-ivory md:sticky md:top-0 md:h-screen md:w-60 md:shrink-0 md:overflow-y-auto md:border-r md:border-b-0">
        <div className="flex items-center justify-between gap-2 px-5 py-4 md:py-5">
          <div>
            {brand ? (
              brand.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={brand.logoUrl} alt={brand.name} className="h-7 max-w-[150px] object-contain" />
              ) : (
                <p className="font-display text-lg" data-testid="brand-name">
                  {brand.name}
                  <span className="text-green">.</span>
                </p>
              )
            ) : (
              <Logo />
            )}
            <p className="mt-0.5 text-[11px] text-ink-muted">
              {brand ? brand.name : surface} · {APP_VERSION}
              <LiveStatus />
            </p>
          </div>
          <NotificationBell />
        </div>
        {me.type === "staff" && <GlobalSearch surface={surface === "Command Centre" ? "admin" : "team"} />}
        <SideNav sections={nav} />
        <div className="hidden border-t border-border px-5 py-4 text-sm md:block">
          <p className="font-medium">{me.name}</p>
          <p className="text-xs text-ink-muted">{me.clientOrg ? me.clientOrg.name : me.roles.map(roleLabel).join(" + ")}</p>
          <div className="flex items-center gap-3">
            <a href="/security" className="mt-2 text-xs text-ink-muted underline hover:text-ink">
              Sign-in security
            </a>
            <SignOutButton />
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 bg-surface px-5 py-8 md:px-10 md:py-10">
        <div className="mx-auto max-w-6xl">
          {me.type === "staff" && <TopBar />}
          {children}
        </div>
      </main>
      {me.type !== "creator" && <Copilot audience={me.type === "client" ? "client" : "staff"} />}
    </div>
  );
  // v11 core: team members get the shared action system (+ New, drawers, reassign, undo toasts).
  // v13: every signed-in surface gets live updates and presence.
  // On Vercel, with the API in the website's own function, the stream is off: each open tab would hold a function for
  // its full 300 s (timeouts, provisioned memory) and changes only reach tabs on the same instance anyway. Screens check
  // for changes on a timer instead. With API_URL set (the API on its own server) the stream works and stays on.
  const stream = !process.env.VERCEL || !!process.env.API_URL;
  return (
    <LiveProvider meId={me.id} stream={stream}>
      {me.type === "staff" ? (
        <ActionsProvider me={me} surface={surface === "Command Centre" ? "admin" : "team"}>
          {shell}
        </ActionsProvider>
      ) : (
        shell
      )}
    </LiveProvider>
  );
}
