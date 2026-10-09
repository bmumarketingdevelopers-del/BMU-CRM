"use client";
// v18 money helpers: rupee inputs, dates and small shared bits.
import { formatINR } from "@bmu/shared";
import type { ReactNode } from "react";

export const inr = formatINR;
export const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
export const addDays = (iso: string, n: number) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
export const mondayOf = (iso: string) => addDays(iso, -((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7));
const dFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const dyFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
/** 5 Oct for a YYYY-MM-DD date. */
export const day = (iso: string | null | undefined) => (iso ? dFmt.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`)) : "—");
export const dayYear = (iso: string | null | undefined) => (iso ? dyFmt.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`)) : "—");
/** "1,250.50" → paise; empty or bad → 0. */
export const toPaise = (rupees: string) => {
  const n = Number(rupees.replace(/[,\s₹]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs font-medium text-ink-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-muted">{hint}</span>}
    </label>
  );
}

export function Note({ error, ok }: { error?: string | null; ok?: string | null }) {
  if (error) return <p className="text-sm text-[#b4432c]" role="alert">{error}</p>;
  if (ok) return <p className="text-sm text-[#5f8a12]">{ok}</p>;
  return null;
}
