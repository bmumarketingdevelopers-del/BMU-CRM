// Small helpers shared by the Organisation / Clients / Catalogue admin pages.
import type { ReactNode } from "react";
import { GATES } from "@bmu/shared";
import { Badge } from "@/components/ui";

const tz = "Asia/Kolkata";
export const fmtDate = (iso: string | null | undefined) =>
  iso ? new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: tz }).format(new Date(iso.length === 10 ? `${iso}T12:00:00+05:30` : iso)) : "—";
export const fmtShort = (iso: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: tz }).format(new Date(iso.length === 10 ? `${iso}T12:00:00+05:30` : iso));
export const fmtTime = (iso: string | null | undefined) =>
  iso ? new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(iso)) : "—";
export const weekday = (ymd: string) => new Intl.DateTimeFormat("en-IN", { weekday: "short", timeZone: tz }).format(new Date(`${ymd}T12:00:00+05:30`));

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const ENGAGEMENT_STATUS: Record<string, string> = {
  pending_payment: "Waiting for payment",
  onboarding: "Onboarding",
  blocked: "Blocked",
  planning: "Planning",
  awaiting_plan_approval: "Plan with client",
  in_production: "In production",
  in_review: "Client review",
  awaiting_final_payment: "Final payment due",
  delivered: "Delivered",
  active_retainer: "Active retainer",
  paused: "Paused",
  offboarding: "Offboarding",
  closed: "Closed",
};
export const statusLabel = (s: string) => ENGAGEMENT_STATUS[s] ?? s.replace(/_/g, " ");
export function StatusBadge({ status }: { status: string }) {
  const tone = status === "blocked" || status === "awaiting_final_payment" ? "amber" : status === "closed" ? "neutral" : status === "paused" || status === "offboarding" ? "dark" : status === "delivered" || status === "active_retainer" ? "green" : "neutral";
  return <Badge tone={tone}>{statusLabel(status)}</Badge>;
}
export const gateLabel = (g: string) => {
  const gate = (GATES as readonly { id: string; name: string }[]).find((x) => x.id === g);
  return gate ? `${g} · ${gate.name}` : g;
};
export const BILLING: Record<string, string> = { monthly: "Monthly", one_time: "One-time", per_unit: "Per unit" };
export const ROLE_LABEL: Record<string, string> = {
  founder: "Founder",
  admin: "Branch Manager",
  department_head: "Department head",
  sales_manager: "Sales manager",
  sales_executive: "Sales executive",
  am_lead: "CM lead",
  account_manager: "Client manager",
  strategist: "Strategist",
  qc_reviewer: "QC reviewer",
  finance: "Finance",
  hr_ops: "HR / Ops",
  producer: "Producer",
  intern: "Intern",
};

export function ErrorNote({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="mb-4 border border-red bg-red/10 px-4 py-2 text-sm">
      {children}
    </p>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs text-ink-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-muted">{hint}</span>}
    </label>
  );
}

/** Runs an async action, returning the error message (or undefined). */
export async function attempt(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}
