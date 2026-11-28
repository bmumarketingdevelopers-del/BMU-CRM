"use client";

/**
 * v54 redesign sidebar menu (preview only; the classic one is side-nav.tsx). Same links, same order, same sections as
 * the classic menu: only the look changes. Hari's pick: the "glow bar" design, glass in light and dark.
 * - WORK / PLAN / YOU (/ ADMIN) open and close like an accordion, one at a time; the group holding the page you are on
 *   no longer opens by itself: a group opens only when clicked. Small capitals with a coloured round icon, no
 *   arrow; the open group is a BMU navy pill.
 * - Every page has a two-tone icon in its group colour (Work green, Plan sky blue, You peach).
 * - The current page: a full oval that glows green all round (a fine green edge and a soft green glow, like the dark
 *   "Mine" pill), the same width as the other items.
 * - Phone: the same links in one sideways row (as before, restyled).
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ComponentType, type CSSProperties } from "react";
import {
  ArrowsClockwise,
  BookOpenText,
  Books,
  Briefcase,
  Buildings,
  CalendarBlank,
  CalendarCheck,
  CalendarDots,
  ChartLineUp,
  ChartPieSlice,
  ChatCircleDots,
  ChatsCircle,
  CheckSquareOffset,
  Circle,
  ClipboardText,
  Clock,
  Database,
  EnvelopeSimple,
  Eye,
  FileText,
  Flag,
  FolderSimple,
  Gauge,
  House,
  IdentificationBadge,
  Images,
  Kanban,
  Lifebuoy,
  ListChecks,
  LockKey,
  Palette,
  PresentationChart,
  Receipt,
  Robot,
  RocketLaunch,
  Scroll,
  SealCheck,
  ShieldCheck,
  SidebarSimple,
  SignOut,
  Sparkle,
  SquaresFour,
  Stack,
  Target,
  Tray,
  UserCircle,
  UsersThree,
  VideoCamera,
  Wallet,
  type IconProps,
} from "@phosphor-icons/react";
import { LiveStatus } from "./live/live-status";
import { Logo } from "./logo";
import { InstallAppButton } from "./service/install-app-button";
import { SignOutButton } from "./sign-out-button";
import { InitialsAvatar } from "./tasks/task-design";
import { UnreadBadge } from "./service/unread-badge";
import type { NavSection } from "./side-nav";

type Icon = ComponentType<IconProps>;

/** One icon per page (by its link); anything new falls back to a dot. */
const ITEM_ICONS: Record<string, Icon> = {
  "/team": House,
  "/team/manager": UsersThree,
  "/team/reports": ClipboardText,
  "/team/dashboards": ChartPieSlice,
  "/team/leads": Target,
  "/team/proposals": FileText,
  "/team/approvals": SealCheck,
  "/team/renewals": ArrowsClockwise,
  "/team/clients": Buildings,
  "/team/client-data": Database,
  "/team/privacy": LockKey,
  "/team/tasks": CheckSquareOffset,
  "/team/qc": ListChecks,
  "/team/reviews": Eye,
  "/team/projects": Kanban,
  "/team/requests": Tray,
  "/team/messages": ChatCircleDots,
  "/team/inbox": EnvelopeSimple,
  "/team/meetings": VideoCamera,
  "/team/invoices": Receipt,
  "/team/quotes": Scroll,
  "/team/goals": Flag,
  "/team/docs": BookOpenText,
  "/team/creators": Sparkle,
  "/team/files": FolderSimple,
  "/team/assets": Images,
  "/team/brand-kits": Palette,
  "/team/discussions": ChatsCircle,
  "/team/calendar": CalendarBlank,
  "/team/content-calendar": CalendarCheck,
  "/team/capacity": Gauge,
  "/team/workload": Stack,
  "/team/specialists": IdentificationBadge,
  "/team/sops": Books,
  "/team/performance": ChartLineUp,
  "/team/timesheet": Clock,
  "/team/expenses": Wallet,
  "/team/agent-inbox": Robot,
  "/team/onboarding": RocketLaunch,
  "/team/profile": UserCircle,
  "/team/hr-issues": Lifebuoy,
  "/admin": SquaresFour,
  "/admin/dashboards": PresentationChart,
};

/** Each group's icon and colour (the colours live in globals.css: --ui-tint-*). */
const GROUPS: Record<string, { icon: Icon; tint: "work" | "plan" | "you" | "admin" }> = {
  Work: { icon: Briefcase, tint: "work" },
  Plan: { icon: CalendarDots, tint: "plan" },
  You: { icon: UserCircle, tint: "you" },
  Admin: { icon: ShieldCheck, tint: "admin" },
};
const groupOf = (section: string) => GROUPS[section] ?? { icon: Circle, tint: "admin" as const };
const tintStyle = (tint: string) => ({ "--tile-bg": `var(--ui-tint-${tint}-bg)`, "--tile-ink": `var(--ui-tint-${tint}-ink)` }) as CSSProperties;

/** The page you are on: the longest menu link that matches the address (so /admin/dashboards beats /admin). */
function activeHref(sections: NavSection[], path: string) {
  let best: string | undefined;
  for (const s of sections)
    for (const i of s.items) {
      if (!i.href) continue;
      const hit = path === i.href || (i.href !== "/team" && path.startsWith(`${i.href}/`));
      if (hit && (!best || i.href.length > best.length)) best = i.href;
    }
  return best;
}

/** A page icon in its group colour; a group icon sits in a soft round bubble of that colour. */
function Tile({ icon: I, bubble = false }: { icon: Icon; bubble?: boolean }) {
  return (
    <span className={`design-nav-tile flex shrink-0 items-center justify-center text-[var(--tile-ink)] ${bubble ? "h-8 w-8 rounded-full bg-[var(--tile-bg)]" : "h-7 w-7"}`} aria-hidden>
      <I size={bubble ? 17 : 18} weight="duotone" />
    </span>
  );
}

export function DesignSideNav({ sections, rail = false }: { sections: NavSection[]; rail?: boolean }) {
  const path = usePathname()!;
  const current = activeHref(sections, path);
  // One group open at a time, and only when the person clicks it (nothing opens by itself on load or on a new page).
  const [open, setOpen] = useState<string | undefined>();

  const link = (i: { label: string; href: string }, tint: string, phone = false) => {
    const on = i.href === current;
    return (
      <Link
        href={i.href}
        prefetch={false}
        aria-current={on ? "page" : undefined}
        style={tintStyle(tint)}
        className={`design-nav-link relative flex items-center gap-2.5 rounded-[14px] text-sm whitespace-nowrap transition-colors ${phone ? "shrink-0 px-2.5 py-1.5 pr-3" : "py-1.5 pr-2 pl-3"} ${on ? "design-nav-current font-semibold" : "text-ink-muted hover:bg-[var(--ui-glass)] hover:text-ink"}`}
      >
        <Tile icon={ITEM_ICONS[i.href] ?? Circle} />
        <span className="min-w-0 truncate">{i.label}</span>
        {i.label === "Messages" && <UnreadBadge />}
      </Link>
    );
  };

  const phoneRow = (
    <nav className="design-side-nav-phone flex gap-1.5 overflow-x-auto px-3 pb-3 [scrollbar-width:none] md:hidden" aria-label="Menu">
      {sections.flatMap((s) => s.items.filter((i) => i.href).map((i) => <span key={`${s.section}-${i.label}`}>{link({ label: i.label, href: i.href! }, groupOf(s.section).tint, true)}</span>))}
    </nav>
  );

  // The slim rail: the group bubbles, then the open group's pages as icons (names on hover).
  if (rail) {
    const openSection = sections.find((s) => s.section === open);
    const openTint = openSection ? groupOf(openSection.section).tint : "work";
    return (
      <>
        <nav className="design-side-nav design-side-rail design-sidebar-scroll hidden min-h-0 flex-1 overflow-y-auto px-2 pb-2 md:block" aria-label="Menu">
          <ul className="mt-4 flex flex-col items-center gap-2">
            {sections.map((s) => {
              const g = groupOf(s.section);
              const isOpen = open === s.section;
              return (
                <li key={s.section} style={tintStyle(g.tint)}>
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-label={s.section}
                    title={s.section}
                    onClick={() => setOpen(isOpen ? undefined : s.section)}
                    className={`design-nav-group flex h-12 w-12 items-center justify-center rounded-2xl transition-colors ${isOpen ? "design-nav-group-open" : "hover:bg-[var(--ui-glass)]"}`}
                  >
                    <Tile icon={g.icon} bubble />
                  </button>
                </li>
              );
            })}
          </ul>
          {openSection && (
            <ul aria-label={openSection.section} className="design-nav-items mt-3 flex flex-col items-center gap-1.5 border-t border-[var(--ui-glass-edge)] pt-3" style={tintStyle(openTint)}>
              {openSection.items
                .filter((i) => i.href)
                .map((i) => {
                  const on = i.href === current;
                  return (
                    <li key={i.label} className="relative">
                      <Link
                        href={i.href!}
                        prefetch={false}
                        aria-current={on ? "page" : undefined}
                        aria-label={i.label}
                        title={i.label}
                        className={`design-nav-link relative flex h-10 w-10 items-center justify-center rounded-full transition-colors ${on ? "design-nav-current" : "text-ink-muted hover:bg-[var(--ui-glass)] hover:text-ink"}`}
                      >
                        <Tile icon={ITEM_ICONS[i.href!] ?? Circle} />
                      </Link>
                      {i.label === "Messages" && (
                        <span className="pointer-events-none absolute -top-1 -right-1">
                          <UnreadBadge />
                        </span>
                      )}
                    </li>
                  );
                })}
            </ul>
          )}
        </nav>
        {phoneRow}
      </>
    );
  }

  return (
    <>
      {/* Desktop: groups that open and close. */}
      <nav className="design-side-nav design-sidebar-scroll hidden min-h-0 flex-1 overflow-y-auto px-3 pb-2 md:block" aria-label="Menu">
        {/* A little space under the logo before the groups. */}
        <ul className="mt-5 space-y-1">
          {sections.map((s) => {
            const g = groupOf(s.section);
            const isOpen = open === s.section;
            const listId = `design-nav-${s.section.toLowerCase()}`;
            return (
              <li key={s.section} style={tintStyle(g.tint)}>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={listId}
                  onClick={() => setOpen(isOpen ? undefined : s.section)}
                  className={`design-nav-group flex w-full items-center gap-2.5 rounded-2xl px-2 py-2 text-left text-[11px] font-semibold tracking-[0.14em] uppercase transition-colors ${isOpen ? "design-nav-group-open" : "text-ink-muted hover:bg-[var(--ui-glass)] hover:text-ink"}`}
                >
                  <Tile icon={g.icon} bubble />
                  <span>{s.section}</span>
                </button>
                {isOpen && (
                  <ul id={listId} className="design-nav-items mt-1 mb-2 ml-1 space-y-0.5">
                    {s.items.map((i) => (
                      <li key={i.label}>
                        {i.href ? (
                          link({ label: i.label, href: i.href }, g.tint)
                        ) : (
                          <span className="flex items-center gap-2.5 py-1.5 pr-2 pl-3 text-sm text-ink-muted/40" title="Coming in a later release">
                            <Tile icon={Circle} />
                            {i.label}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </nav>
      {/* Phone: every link in one sideways row, as before. */}
      {phoneRow}
    </>
  );
}

/** Under the logo: which app, as a small chip (Live sits next to the logo; the version is not shown here). */
export function SidebarBadges({ surface }: { surface: string }) {
  const chip = "inline-flex items-center gap-1.5 rounded-full border border-[var(--ui-glass-edge)] bg-[var(--ui-glass)] px-2 py-0.5 text-[11px] font-medium text-ink-muted";
  return (
    <div className="design-sidebar-badges mt-3 flex flex-wrap items-center gap-1.5">
      <span className={chip}>
        <SquaresFour size={13} weight="duotone" className="text-[#4f8a17] dark-ink-green" aria-hidden />
        {surface}
      </span>
    </div>
  );
}

const RAIL_KEY = "bmu.sidebar";

/** The navy icon button next to Live (no circle) that shrinks the sidebar to a slim icon rail, and opens it again. */
function RailButton({ rail, onClick }: { rail: boolean; onClick: () => void }) {
  const label = rail ? "Open the menu" : "Shrink the menu";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={rail}
      title={label}
      data-testid="sidebar-rail-toggle"
      className="design-rail-button hidden h-8 w-8 shrink-0 items-center justify-center rounded-full transition-transform hover:scale-105 md:inline-flex"
    >
      <SidebarSimple size={22} weight="duotone" className={rail ? "-scale-x-100" : ""} aria-hidden />
    </button>
  );
}

/**
 * The v54 sidebar (preview only): logo with Live and the shrink button at the top right, the chips, the menu, Install
 * app and the profile card. The shrink button turns it into a slim icon rail (desktop and tablet; remembered in this
 * browser). On a phone it is the top bar, as before.
 */
export function DesignAside({ sections, surface, homeHref, name, roleLine }: { sections: NavSection[]; surface: string; homeHref: string; name: string; roleLine: string }) {
  const [rail, setRail] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem(RAIL_KEY) === "rail") queueMicrotask(() => setRail(true));
    } catch {
      /* no saved choice */
    }
  }, []);
  const toggle = () =>
    setRail((r) => {
      try {
        if (r) localStorage.removeItem(RAIL_KEY);
        else localStorage.setItem(RAIL_KEY, "rail");
      } catch {
        /* the choice just isn't remembered */
      }
      return !r;
    });
  const pill = "rounded-full border border-[var(--ui-glass-edge)] bg-[var(--ui-glass)] text-ink-muted transition-colors hover:bg-ui-accent-soft hover:text-ink";
  return (
    <aside data-rail={rail || undefined} className={`design-sidebar print:hidden md:sticky md:top-0 md:h-screen md:shrink-0 md:py-3 md:pl-3 md:transition-[width] md:duration-300 ${rail ? "md:w-[92px]" : "md:w-64 lg:w-72"}`}>
      <div className="design-sidebar-panel design-sidebar-leaves design-glass-panel flex flex-col text-ink md:h-full md:rounded-[28px]">
        {/* Full header: logo, Live and the shrink button at the top right, then the chips. */}
        <div className={`px-5 pt-5 pb-4 ${rail ? "md:hidden" : ""}`}>
          <div className="flex items-start justify-between gap-2">
            <Logo href={homeHref} seeThrough />
            <div className="flex items-center gap-1.5 pt-0.5">
              <LiveStatus look="pill" />
              <RailButton rail={false} onClick={toggle} />
            </div>
          </div>
          <SidebarBadges surface={surface} />
        </div>
        {/* Rail header: the small logo, then the Live dot and the open button side by side. */}
        <div className={`hidden flex-col items-center gap-3 px-2 pt-5 pb-1 ${rail ? "md:flex" : ""}`}>
          <Logo href={homeHref} seeThrough size={20} />
          <div className="flex items-center gap-2">
            <LiveStatus look="dot" />
            <RailButton rail onClick={toggle} />
          </div>
        </div>
        <DesignSideNav sections={sections} rail={rail} />
        {!rail && <InstallAppButton look="glass" />}
        {/* Profile: the full card, or (rail) the initials with the two buttons as icons. */}
        <div className={`design-sidebar-profile mx-3 mb-3 flex items-center gap-3 rounded-2xl border border-[var(--ui-glass-edge)] p-3 md:block ${rail ? "md:hidden" : ""}`}>
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <InitialsAvatar name={name} size="md" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{name}</p>
              <p className="truncate text-xs text-ink-muted">{roleLine}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 md:mt-2.5">
            <a href="/security" className={`px-3 py-1 text-xs ${pill}`}>
              Sign-in security
            </a>
            <SignOutButton className={`px-3 py-1 text-xs ${pill}`} />
          </div>
        </div>
        <div className={`design-sidebar-profile mx-2 mb-3 hidden flex-col items-center gap-2 rounded-2xl border border-[var(--ui-glass-edge)] py-3 ${rail ? "md:flex" : ""}`} title={`${name} · ${roleLine}`}>
          <InitialsAvatar name={name} size="md" />
          <a href="/security" title="Sign-in security" aria-label="Sign-in security" className={`flex h-8 w-8 items-center justify-center ${pill}`}>
            <ShieldCheck size={16} weight="duotone" aria-hidden />
          </a>
          <SignOutButton title="Sign out" className={`flex h-8 w-8 items-center justify-center ${pill}`}>
            <SignOut size={16} weight="duotone" aria-hidden />
          </SignOutButton>
        </div>
      </div>
    </aside>
  );
}
