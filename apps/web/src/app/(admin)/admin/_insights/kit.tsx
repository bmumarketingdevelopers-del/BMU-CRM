"use client";
// Small helpers shared by the Command Centre analytics and Finance pages.
import type { ReactNode } from "react";
import { formatINR, invoiceStatusLabels, type InvoiceDisplayStatus } from "@bmu/shared";
import { Badge, LoadState } from "@/components/ui";
import type { Loaded } from "@/lib/use-load";

export const inr = formatINR;

/** Short rupee labels for charts: ₹4.5L, ₹85k, ₹1.2Cr. */
export function inrShort(paise: number) {
  const r = paise / 100;
  const sign = r < 0 ? "-" : "";
  const a = Math.abs(r);
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(a >= 1e8 ? 0 : 1)}Cr`;
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(a >= 1e6 ? 0 : 1)}L`;
  if (a >= 1e3) return `${sign}₹${Math.round(a / 1e3)}k`;
  return `${sign}₹${Math.round(a)}`;
}

const dFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const dtFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
export const fmtDate = (iso: string | null | undefined) => (iso ? dFmt.format(new Date(iso)) : "—");
export const fmtDateTime = (iso: string | null | undefined) => (iso ? dtFmt.format(new Date(iso)) : "—");
export const pctText = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${Math.round(n)}%`);

/** Today in IST as yyyy-mm-dd. */
export const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

/** Loading and error states, then the page body once data is in. */
export function WithData<T>({ state, children }: { state: Loaded<T>; children: (data: T) => ReactNode }) {
  if (state.data === undefined) return <LoadState loading={state.loading} error={state.error} />;
  return (
    <>
      {state.error && <LoadState loading={false} error={state.error} />}
      {children(state.data)}
    </>
  );
}

const statusTone: Record<InvoiceDisplayStatus, "neutral" | "green" | "amber" | "red" | "dark"> = {
  draft: "neutral",
  issued: "dark",
  partially_paid: "amber",
  paid: "green",
  overdue: "red",
  void: "neutral",
  credit_noted: "neutral",
};

export function InvoiceStatus({ status }: { status: InvoiceDisplayStatus }) {
  return <Badge tone={statusTone[status]}>{invoiceStatusLabels[status]}</Badge>;
}

/** Inline form message: server errors in red, success in green. */
export function FormNote({ error, ok }: { error?: string | null; ok?: string | null }) {
  if (error) return <p className="text-sm text-[#b4432c]">{error}</p>;
  if (ok) return <p className="text-sm text-[#5f8a12]">{ok}</p>;
  return null;
}

/** Label above a form control. */
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-ink-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-muted">{hint}</span>}
    </label>
  );
}

/** Rupees typed by a person → paise, or null if not a positive amount. */
export function rupeesInput(v: string): number | null {
  const n = Number(v.replace(/[,₹\s]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

/** Small legend for charts with two series. */
export function Legend({ items }: { items: { label: string; className: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-4 text-xs text-ink-muted">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span className={`inline-block h-2 w-2 ${i.className}`} />
          {i.label}
        </li>
      ))}
    </ul>
  );
}
