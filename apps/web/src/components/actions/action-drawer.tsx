"use client";

/**
 * ActionDrawer: the one form shell for every create/edit action (spec form_pattern).
 * - Side drawer on desktop, full-screen sheet on phone.
 * - Required fields go in `children`; optional ones in `more` (collapsed under "More details").
 * - Footer: Save / Save and add another / Save as draft (each optional), inline server error.
 * - Forms with more than 5 fields pass `draft={{ entity, key, values, onRestore }}` to autosave every 10 seconds.
 *
 *   <ActionDrawer open={open} title="New task" onClose={close} onSubmit={(mode) => save(mode)} saving={busy} error={err}
 *     more={<MoreFields/>} allowAnother allowDraft draft={{ entity: "task", key: "new", values, onRestore: setValues }}>
 *     <Field label="Title" required error={errors.title}><Input … /></Field>
 *   </ActionDrawer>
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/api";

export type SaveMode = "save" | "another" | "draft";

export function Field({ label, required, error, hint, children, htmlFor }: { label: string; required?: boolean; error?: string | null; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="grid gap-1">
      <label htmlFor={htmlFor} className="text-xs font-medium text-ink">
        {label}
        {required && <span className="text-red"> *</span>}
      </label>
      {children}
      {error ? <p className="text-xs text-red" role="alert">{error}</p> : hint ? <p className="text-xs text-ink-muted">{hint}</p> : null}
    </div>
  );
}

const fieldCls = "w-full border border-border bg-surface-raised px-3 py-2 text-sm";
export const inputCls = fieldCls;
export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${fieldCls} min-h-20 ${props.className ?? ""}`} />;
}

/** Autosaves `values` as a server-side draft every 10 seconds while the drawer is open; offers to restore on open. */
export function useDraftAutosave<T extends Record<string, unknown>>(opts: { entity: string; key: string; values: T; enabled: boolean; onRestore: (v: T) => void }) {
  const { entity, key, values, enabled, onRestore } = opts;
  const [found, setFound] = useState<{ payload: T; updatedAt: string } | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const last = useRef<string>("");
  const latest = useRef(values);
  useEffect(() => {
    latest.current = values;
  });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    api.actions.drafts
      .get(entity, key)
      .then((d) => {
        if (live && d && Object.keys(d.payload).length) setFound({ payload: d.payload as T, updatedAt: d.updatedAt });
        last.current = JSON.stringify(latest.current);
      })
      .catch(() => {});
    const t = setInterval(() => {
      const now = JSON.stringify(latest.current);
      if (now === last.current) return;
      last.current = now;
      api.actions.drafts
        .save(entity, key, latest.current)
        .then((d) => setSavedAt(d.updatedAt))
        .catch(() => {});
    }, 10_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [enabled, entity, key]);
  const clear = useCallback(() => {
    setFound(null);
    setSavedAt(null);
    api.actions.drafts.remove(entity, key).catch(() => {});
  }, [entity, key]);
  const banner = found ? (
    <div className="flex flex-wrap items-center justify-between gap-2 border border-border bg-canvas/60 px-3 py-2 text-xs">
      <span>You have an unsaved draft from {new Date(found.updatedAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })}.</span>
      <span className="flex gap-3">
        <button type="button" className="font-medium underline" onClick={() => { onRestore(found.payload); setFound(null); }}>
          Restore
        </button>
        <button type="button" className="text-ink-muted hover:text-ink" onClick={clear}>
          Discard
        </button>
      </span>
    </div>
  ) : null;
  return { banner, savedAt, clear };
}

export function ActionDrawer({
  open,
  title,
  subtitle,
  onClose,
  onSubmit,
  saving = false,
  error,
  children,
  more,
  moreLabel = "More details",
  allowAnother = false,
  allowDraft = false,
  saveLabel = "Save",
  banner,
  footerNote,
  wide = false,
  testId,
}: {
  open: boolean;
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  onSubmit?: (mode: SaveMode) => void | Promise<void>;
  saving?: boolean;
  error?: string | null;
  children: ReactNode;
  more?: ReactNode;
  moreLabel?: string;
  allowAnother?: boolean;
  allowDraft?: boolean;
  saveLabel?: string;
  banner?: ReactNode;
  footerNote?: ReactNode;
  wide?: boolean;
  testId?: string;
}) {
  const [showMore, setShowMore] = useState(false);
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const t = setTimeout(() => panel.current?.querySelector<HTMLElement>("input:not([type=hidden]),select,textarea")?.focus(), 30);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(t);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex justify-end bg-charcoal/30" onMouseDown={onClose} data-testid={testId}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(e) => e.stopPropagation()}
        className={`flex h-full w-full flex-col border-l border-border bg-surface shadow-xl ${wide ? "md:w-[680px]" : "md:w-[520px]"}`}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="font-display text-xl">
              {title}
            </h2>
            {subtitle && <p className="mt-0.5 text-xs text-ink-muted">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} className="px-2 text-ink-muted hover:text-ink" aria-label="Close">
            ✕
          </button>
        </header>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            const mode = ((e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value as SaveMode | undefined;
            void onSubmit?.(mode ?? "save");
          }}
          noValidate
        >
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
            {banner}
            {children}
            {more && (
              <div className="border-t border-border pt-3">
                <button type="button" className="flex w-full items-center justify-between text-sm font-medium" aria-expanded={showMore} onClick={() => setShowMore((v) => !v)}>
                  {moreLabel}
                  <span className="text-ink-muted">{showMore ? "−" : "+"}</span>
                </button>
                {showMore && <div className="mt-3 space-y-4">{more}</div>}
              </div>
            )}
          </div>
          <footer className="border-t border-border px-5 py-3">
            {error && (
              <p role="alert" className="mb-2 border border-red bg-red/10 px-3 py-2 text-sm">
                {error}
              </p>
            )}
            {footerNote && <div className="mb-2 text-xs text-ink-muted">{footerNote}</div>}
            {onSubmit && (
              <div className="flex flex-wrap items-center gap-2">
                <button type="submit" value="save" disabled={saving} className="bg-charcoal px-4 py-2 text-sm font-medium text-ivory hover:opacity-90 disabled:opacity-40">
                  {saving ? "Saving…" : saveLabel}
                </button>
                {allowAnother && (
                  <button type="submit" value="another" disabled={saving} className="border border-border px-4 py-2 text-sm hover:border-ink disabled:opacity-40">
                    Save and add another
                  </button>
                )}
                {allowDraft && (
                  <button type="submit" value="draft" disabled={saving} className="px-3 py-2 text-sm text-ink-muted hover:text-ink disabled:opacity-40">
                    Save as draft
                  </button>
                )}
                <button type="button" onClick={onClose} className="ml-auto px-3 py-2 text-sm text-ink-muted hover:text-ink">
                  Cancel
                </button>
              </div>
            )}
          </footer>
        </form>
      </div>
    </div>
  );
}

/** Small centred dialog for quick actions (reason prompts, confirmations). Full width on phones. */
export function ActionDialog({ open, title, onClose, children, footer, testId }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; testId?: string }) {
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-charcoal/30 sm:items-center sm:px-4" onMouseDown={onClose} data-testid={testId}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(e) => e.stopPropagation()} className="max-h-[92vh] w-full overflow-y-auto border border-border bg-surface shadow-xl sm:max-w-md">
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 id={titleId} className="font-display text-lg">
            {title}
          </h2>
          <button type="button" onClick={onClose} className="px-2 text-ink-muted hover:text-ink" aria-label="Close">
            ✕
          </button>
        </header>
        <div className="space-y-3 px-5 py-4 text-sm">{children}</div>
        {footer && <footer className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}
