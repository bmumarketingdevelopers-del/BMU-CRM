import { APP_VERSION, homePathFor, personRoleTitle } from "@bmu/shared";
import type { Me } from "@bmu/shared";
import { Copilot } from "./ai/copilot";
import { Logo } from "./logo";
import { NotificationBell } from "./notification-bell";
import { SignOutButton } from "./sign-out-button";
import { SignedInMark } from "./signed-in-mark";
import { SideNav, type NavSection } from "./side-nav";
import { DesignAside } from "./design-sidebar";
import { GlobalSearch } from "./global-search";
import { ActionsProvider } from "./actions/actions-provider";
import { NewButton } from "./actions/new-button";
import { TopBar } from "./actions/top-bar";
import { LiveProvider } from "@/lib/live";
import { outfit } from "@/lib/design-font";
import { LiveStatus } from "./live/live-status";
import { BrowserAlertsPrompt } from "./service/browser-alerts-prompt";
import { InstallAppButton } from "./service/install-app-button";

/** Client-app branding from Command Centre → Branding & Theme. */
export type ShellBrand = { name: string; primary: string; accent: string; logoUrl: string };

/** Frame for signed-in surfaces: a quiet sidebar with hairline borders and a white work area. */
export function AppShell({ me, surface, nav, children, brand, themeSwitch = false }: { me: Me; surface: string; nav: NavSection[]; children: React.ReactNode; brand?: ShellBrand; /** v54: the moon icon (redesign preview only). */ themeSwitch?: boolean }) {
  const brandStyle = brand
    ? ({ "--color-green": brand.accent, "--bmu-green": brand.accent, "--color-charcoal": brand.primary, "--bmu-charcoal": brand.primary } as React.CSSProperties)
    : undefined;
  // v54 redesign preview: Search, + New and the bell move from the sidebar to the top bar, next to the moon icon
  // (moved, not copied: each has a keyboard shortcut that must exist once).
  const toolsOnTop = themeSwitch && me.type === "staff";
  const roleLine = me.clientOrg ? me.clientOrg.name : me.roleTitle || personRoleTitle(me.roles, { specialty: me.specialty });
  // v54 redesign preview: a floating glass sidebar (same links; groups that open and close, coloured icons, the
  // current page glowing green), with a button that shrinks it to a slim icon rail (design-sidebar.tsx).
  const designAside = <DesignAside sections={nav} surface={surface} homeHref={homePathFor(me)} name={me.name} roleLine={roleLine} />;
  const shell = (
    <div className={`flex min-h-screen flex-col md:flex-row ${toolsOnTop ? "design-shell" : ""}`} style={brandStyle}>
      {toolsOnTop ? designAside : (
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
              <Logo href={homePathFor(me)} />
            )}
            <p className="mt-0.5 text-[11px] text-ink-muted">
              {brand ? brand.name : surface} · {APP_VERSION}
              <LiveStatus />
            </p>
          </div>
          {!toolsOnTop && <NotificationBell />}
        </div>
        {/* The single "+ New" button (create a task, lead, client…): top of the sidebar, same spot on every page. */}
        {me.type === "staff" && !toolsOnTop && <NewButton />}
        {me.type === "staff" && !toolsOnTop && <GlobalSearch surface={surface === "Command Centre" ? "admin" : "team"} />}
        <SideNav sections={nav} />
        <InstallAppButton />
        {/* On a phone too (the website, the Android app and the installed app): Sign out is the only way to sign out. */}
        <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-2 text-sm md:block md:py-4">
          <div className="min-w-0">
            <p className="truncate font-medium">{me.name}</p>
            {/* Their own role name (a custom role such as "SEO Executive"), else their job role (e.g. Graphic designer), else the built-in role. */}
            <p className="truncate text-xs text-ink-muted">
              {me.clientOrg ? me.clientOrg.name : me.roleTitle || personRoleTitle(me.roles, { specialty: me.specialty })}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <a href="/security" className="py-2 text-xs md:mt-2 md:py-0 text-ink-muted underline hover:text-ink">
              Sign-in security
            </a>
            <SignOutButton />
          </div>
        </div>
      </aside>
      )}
      <main className={`min-w-0 flex-1 bg-surface px-5 py-8 md:py-10 ${toolsOnTop ? "md:pr-10 md:pl-7" : "md:px-10"}`}>
        <div className="mx-auto max-w-6xl">
          {me.type === "staff" && (
            <TopBar
              themeSwitch={themeSwitch}
              tools={
                toolsOnTop ? (
                  <>
                    <GlobalSearch surface={surface === "Command Centre" ? "admin" : "team"} look="top" />
                    <NewButton look="top" />
                    <NotificationBell look="top" />
                  </>
                ) : null
              }
            />
          )}
          <BrowserAlertsPrompt />
          {children}
        </div>
      </main>
      {me.type !== "creator" && <Copilot audience={me.type === "client" ? "client" : "staff"} look={toolsOnTop ? "robot" : "classic"} />}
    </div>
  );
  // v11 core: team members get the shared action system (+ New, drawers, reassign, undo toasts).
  // v13: every signed-in surface gets live updates and presence.
  // On Vercel, with the API in the website's own function, the stream is off: each open tab would hold a function for
  // its full 300 s (timeouts, provisioned memory) and changes only reach tabs on the same instance anyway. Screens check
  // for changes on a timer instead. With API_URL set (the API on its own server) the stream works and stays on.
  const stream = !process.env.VERCEL || !!process.env.API_URL;
  const app = (
    <LiveProvider meId={me.id} stream={stream}>
      <SignedInMark />
      {me.type === "staff" ? (
        <ActionsProvider me={me} surface={surface === "Command Centre" ? "admin" : "team"}>
          {shell}
        </ActionsProvider>
      ) : (
        shell
      )}
    </LiveProvider>
  );
  // v54 redesign preview: one wrapper (no box of its own) around the whole signed-in app, pop-ups included, that gives
  // every page the Outfit font and the new look (globals.css: .design-scope). Everyone else gets the app unchanged.
  return toolsOnTop ? (
    <div className={`design-scope contents ${outfit.variable} ${outfit.className}`} style={{ "--font-albert-sans": "var(--font-outfit)" } as React.CSSProperties}>
      {app}
    </div>
  ) : (
    app
  );
}
