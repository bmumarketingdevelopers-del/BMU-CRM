"use client";

/**
 * Slim bar above every team/Command Centre page: the "Needs you" approvals count. ("+ New" lives at the top of the sidebar.)
 * v54: always shown, with the theme switch on the right: a moon for the dark theme, a sun to go back to light.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { applyTheme, readTheme, type Theme } from "@/lib/theme";
import type { ReactNode } from "react";
import { designFont } from "@/components/tasks/task-design";
import { useActions } from "./actions-provider";

function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>("light");
  // The layout's script already set the saved theme on <html>; show the matching icon once mounted.
  useEffect(() => {
    queueMicrotask(() => setTheme(readTheme()));
  }, []);
  const next: Theme = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={() => {
        // Read the page's theme at click time (not the icon's state), so a quick first click always flips it.
        const to: Theme = readTheme() === "dark" ? "light" : "dark";
        applyTheme(to);
        setTheme(to);
      }}
      className="theme-switch-button flex h-9 w-9 items-center justify-center rounded-full border border-ui-card-border bg-ui-pill text-ui-pill-ink shadow-[var(--ui-card-shadow)] transition-colors hover:bg-ui-accent-soft"
      aria-label={next === "dark" ? "Switch to the dark theme" : "Switch to the light theme"}
      title={next === "dark" ? "Dark theme" : "Light theme"}
      data-testid="theme-switch"
    >
      {theme === "dark" ? (
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
          <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z" />
        </svg>
      )}
    </button>
  );
}

/** tools: v54 redesign preview only: Search, + New and the bell, shown just before the moon icon. */
export function TopBar({ themeSwitch = false, tools }: { themeSwitch?: boolean; tools?: ReactNode }) {
  const { version } = useActions();
  const [pending, setPending] = useState(0);
  useEffect(() => {
    let live = true;
    api.actions.approvals
      .count()
      .then((r) => live && setPending(r.pending))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [version]);
  // Not in the redesign preview: always the light theme, even if this browser saved dark for someone else.
  useEffect(() => {
    if (!themeSwitch && readTheme() === "dark") delete document.documentElement.dataset.theme;
  }, [themeSwitch]);
  if (!themeSwitch && pending <= 0) return null;
  return (
    <div className={`top-bar -mt-3 mb-5 flex flex-wrap items-center justify-end gap-2 md:-mt-5 ${themeSwitch ? designFont : ""}`}>
      {pending > 0 && (
        <Link href="/team/approvals" className="flex items-center gap-1.5 border border-border px-2.5 py-1 text-xs hover:border-ink" data-testid="needs-you-link">
          Needs you <span className="bg-green px-1.5 font-semibold text-charcoal">{pending}</span>
        </Link>
      )}
      {tools}
      {themeSwitch && <ThemeSwitch />}
    </div>
  );
}
