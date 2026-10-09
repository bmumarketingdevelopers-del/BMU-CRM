"use client";
// Small helpers for the Automations pages.
import type { ReactNode } from "react";
import type { AutomationRunStatus } from "@bmu/shared";
import { Badge, LoadState } from "@/components/ui";
import type { Loaded } from "@/lib/use-load";

const dFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
const dtFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
export const fmtDay = (iso: string | null | undefined) => (iso ? dFmt.format(new Date(iso)) : "—");
export const fmtWhen = (iso: string | null | undefined) => (iso ? dtFmt.format(new Date(iso)) : "Never");

/** "3 min ago", "2 days ago". */
export function ago(iso: string | null | undefined) {
  if (!iso) return "Never";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1) return "Just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return d < 31 ? `${d} day${d === 1 ? "" : "s"} ago` : fmtDay(iso);
}

export function WithData<T>({ state, children }: { state: Loaded<T>; children: (data: T) => ReactNode }) {
  if (state.data === undefined) return <LoadState loading={state.loading} error={state.error} />;
  return (
    <>
      {state.error && <LoadState loading={false} error={state.error} />}
      {children(state.data)}
    </>
  );
}

const statusTone: Record<AutomationRunStatus, "green" | "red" | "neutral"> = { success: "green", failed: "red", skipped: "neutral" };
const statusLabel: Record<AutomationRunStatus, string> = { success: "Done", failed: "Failed", skipped: "Skipped" };
export const runStatusLabel = statusLabel;
export function RunStatus({ status }: { status: AutomationRunStatus }) {
  return <Badge tone={statusTone[status]}>{statusLabel[status]}</Badge>;
}

/** Square on/off switch. */
export function Toggle({ on, onChange, disabled, label }: { on: boolean; onChange?: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled || !onChange}
      onClick={() => onChange?.(!on)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center border transition-colors disabled:cursor-default ${on ? "border-charcoal bg-charcoal" : "border-border bg-canvas"} ${disabled ? "opacity-50" : ""}`}
    >
      <span className={`absolute top-0.5 h-3.5 w-3.5 transition-all ${on ? "left-[18px] bg-green" : "left-0.5 bg-ink-muted/60"}`} />
    </button>
  );
}

/** Steps of a run in plain words. */
export function Steps({ steps, compact }: { steps: { ok: boolean; skipped?: boolean; text: string }[]; compact?: boolean }) {
  if (!steps.length) return <span className="text-xs text-ink-muted">No details</span>;
  return (
    <ul className={`space-y-0.5 ${compact ? "text-xs" : "text-sm"}`}>
      {steps.map((s, i) => (
        <li key={i} className={`flex gap-1.5 ${s.ok ? (s.skipped ? "text-ink-muted" : "text-ink") : "text-[#b4432c]"}`}>
          <span aria-hidden className="shrink-0">{s.ok ? (s.skipped ? "–" : "✓") : "✕"}</span>
          <span>{s.text}</span>
        </li>
      ))}
    </ul>
  );
}
