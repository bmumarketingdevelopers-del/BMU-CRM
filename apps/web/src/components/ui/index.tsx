// Small shared UI pieces: square corners, one green primary action, charcoal for status.
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { Presence } from "../live/presence";

export function Button({ variant = "primary", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" }) {
  const styles = {
    primary: "bg-charcoal text-ivory font-medium hover:opacity-90",
    secondary: "border border-border text-ink hover:border-ink",
    ghost: "text-ink-muted hover:text-ink",
  }[variant];
  return <button className={`px-4 py-2 text-sm transition disabled:opacity-40 ${styles} ${className}`} {...props} />;
}

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`w-full border border-border bg-surface-raised px-3 py-2 text-sm ${className}`} {...props} />;
}

export function Select({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`border border-border bg-surface-raised px-2 py-1.5 text-sm ${className}`} {...props} />;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`border border-border bg-surface-raised p-6 ${className}`}>{children}</div>;
}

/** `presence` (v13) shows teammates looking at the same record, e.g. presence={{ entity: "Lead", id }}. */
export function PageTitle({ title, subtitle, action, presence }: { title: string; subtitle?: string; action?: ReactNode; presence?: { entity: string; id: string } }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4 border-b border-border pb-6">
      <div>
        <h1 className="font-display text-2xl sm:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-muted">{subtitle}</p>}
        {presence && <Presence entity={presence.entity} id={presence.id} className="mt-2" />}
      </div>
      {action}
    </div>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "green" | "amber" | "red" | "dark" }) {
  const styles = {
    neutral: "bg-canvas text-ink-muted",
    green: "bg-green/15 text-ink",
    amber: "bg-amber/35 text-ink",
    red: "bg-red/20 text-ink",
    dark: "border border-border text-ink",
  }[tone];
  return <span className={`inline-block shrink-0 whitespace-nowrap px-2 py-0.5 text-xs ${styles}`}>{children}</span>;
}

export function LoadState({ loading, error }: { loading: boolean; error?: string }) {
  if (error) return <p className="border border-red bg-red/10 px-4 py-3 text-sm">{error}</p>;
  if (loading) return <p className="text-sm text-ink-muted">Loading…</p>;
  return null;
}
