"use client";

/**
 * ActionsProvider: mounted once in the app shell for team members. Gives every page:
 *   const { openNew, openReassign, openBulkReassign, notify, version, changed } = useActions();
 * - openNew("task", { engagementId }) opens the registered drawer for that "+ New" entry (see new-registry.tsx).
 * - openReassign({ type: "task", ids: [id] }) opens the ReassignDialog for any registered target type.
 * - notify("Saved", undo) shows the toast; with an undo token it shows "Undo" for 10 seconds.
 * - `version` bumps after every action (reload your list when it changes); call changed() after your own saves.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CoreReassignResult, CoreUndo, Me } from "@bmu/shared";
import { api } from "@/lib/api";
import { newEntriesFor, type NewPrefill } from "./new-registry";
import { BulkReassignDialog, ReassignDialog } from "./reassign-dialog";

export type ReassignRequest = { type: string; ids: string[]; toUserId?: string; title?: string; onDone?: (r: CoreReassignResult) => void };
type Toast = { id: number; message: string; undo?: CoreUndo | null; tone: "ok" | "error" };

type ActionsCtx = {
  me: Me;
  surface: "team" | "admin";
  openNew: (kind: string, prefill?: NewPrefill, onSaved?: (id?: string) => void) => void;
  canNew: (kind: string) => boolean;
  openReassign: (r: ReassignRequest) => void;
  openBulkReassign: (fromUserId: string, onDone?: () => void) => void;
  notify: (message: string, undo?: CoreUndo | null, tone?: "ok" | "error") => void;
  version: number;
  changed: () => void;
};

const Ctx = createContext<ActionsCtx | null>(null);

/** Throws outside the provider (client, creator surfaces have no actions). Use useActionsMaybe() where optional. */
export function useActions(): ActionsCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useActions() needs <ActionsProvider> (team app or Command Centre)");
  return c;
}
export const useActionsMaybe = () => useContext(Ctx);

export function ActionsProvider({ me, surface, children }: { me: Me; surface: "team" | "admin"; children: ReactNode }) {
  const [version, setVersion] = useState(0);
  const [drawer, setDrawer] = useState<{ kind: string; prefill?: NewPrefill; onSaved?: (id?: string) => void; n: number } | null>(null);
  const [reassign, setReassign] = useState<(ReassignRequest & { n: number }) | null>(null);
  const [bulk, setBulk] = useState<{ fromUserId: string; onDone?: () => void } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const entries = useMemo(() => newEntriesFor(me, surface), [me, surface]);

  const changed = useCallback(() => setVersion((v) => v + 1), []);
  const notify = useCallback((message: string, undo?: CoreUndo | null, tone: "ok" | "error" = "ok") => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-2), { id, message, undo, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), undo ? 10_000 : 5_000);
  }, []);
  const canNew = useCallback((kind: string) => entries.some((e) => e.id === kind), [entries]);
  const openNew = useCallback((kind: string, prefill?: NewPrefill, onSaved?: (id?: string) => void) => setDrawer({ kind, prefill, onSaved, n: ++seq.current }), []);
  const openReassign = useCallback((r: ReassignRequest) => setReassign({ ...r, n: ++seq.current }), []);
  const openBulkReassign = useCallback((fromUserId: string, onDone?: () => void) => setBulk({ fromUserId, onDone }), []);

  async function undo(t: Toast) {
    if (!t.undo) return;
    setToasts((all) => all.filter((x) => x.id !== t.id));
    try {
      const r = await api.actions.undo(t.undo.token);
      notify(r.message);
      changed();
    } catch (e) {
      notify((e as Error).message, null, "error");
    }
  }

  const entry = drawer ? entries.find((e) => e.id === drawer.kind) : undefined;
  const value = useMemo<ActionsCtx>(() => ({ me, surface, openNew, canNew, openReassign, openBulkReassign, notify, version, changed }), [me, surface, openNew, canNew, openReassign, openBulkReassign, notify, version, changed]);

  // "N" anywhere (not while typing) opens the + New menu; pages with a context register their own N first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (e.key.toLowerCase() === "n" && !document.querySelector("[role=dialog]")) {
        e.preventDefault();
        document.querySelector<HTMLButtonElement>("[data-new-button]")?.click();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <Ctx.Provider value={value}>
      {children}
      {drawer && entry && (
        <entry.Drawer
          key={drawer.n}
          open
          prefill={drawer.prefill}
          onClose={() => setDrawer(null)}
          onSaved={(id, message, undoToken) => {
            changed();
            if (message) notify(message, undoToken);
            drawer.onSaved?.(id);
          }}
        />
      )}
      {reassign && (
        <ReassignDialog
          key={reassign.n}
          open
          type={reassign.type}
          ids={reassign.ids}
          initialToUserId={reassign.toUserId}
          title={reassign.title}
          onClose={() => setReassign(null)}
          onDone={(r) => {
            setReassign(null);
            notify(r.message, r.undo);
            changed();
            reassign.onDone?.(r);
          }}
        />
      )}
      {bulk && (
        <BulkReassignDialog
          open
          fromUserId={bulk.fromUserId}
          onClose={() => setBulk(null)}
          onDone={(r) => {
            setBulk(null);
            notify(r.message, r.undo);
            changed();
            bulk.onDone?.();
          }}
        />
      )}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[80] flex flex-col items-center gap-2 px-4" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} role="status" className={`pointer-events-auto flex w-full max-w-md items-center justify-between gap-3 border px-4 py-2.5 text-sm shadow-lg ${t.tone === "error" ? "border-red bg-surface" : "border-charcoal bg-charcoal text-ivory"}`} data-testid="action-toast">
            <span className="min-w-0">{t.message}</span>
            <span className="flex shrink-0 items-center gap-3">
              {t.undo && (
                <button type="button" onClick={() => undo(t)} className="font-semibold text-green underline-offset-2 hover:underline">
                  Undo
                </button>
              )}
              <button type="button" onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))} aria-label="Dismiss" className="opacity-70 hover:opacity-100">
                ✕
              </button>
            </span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function isTyping(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

/**
 * Keyboard shortcuts where a record or list is focused (spec keyboard_shortcuts):
 * N new in context, A assign, R reassign, D change deadline, E edit, "/" search. Pass only what applies.
 *
 *   useActionShortcuts({ n: () => openNew("task", ctx), r: () => openReassign(...), slash: () => searchRef.current?.focus() });
 */
export function useActionShortcuts(h: { n?: () => void; a?: () => void; r?: () => void; d?: () => void; e?: () => void; slash?: () => void }) {
  const ref = useRef(h);
  useEffect(() => {
    ref.current = h;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target) || document.querySelector("[role=dialog]")) return;
      const k = e.key === "/" ? "slash" : e.key.toLowerCase();
      const fn = (ref.current as Record<string, (() => void) | undefined>)[k];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    // Capture so a page's N wins over the global "+ New" menu.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
