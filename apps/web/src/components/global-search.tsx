"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { coreParsePaletteIntent, type CorePaletteResult, type TeamSearchItem, type TeamSearchKind, type TeamSearchResult } from "@bmu/shared";
import { api } from "@/lib/api";
import { useActionsMaybe } from "./actions/actions-provider";

const KIND_HINT: Record<string, string> = { client: "Client", lead: "Lead", proposal: "Proposal", invoice: "Invoice", task: "Task", person: "Person", sop: "SOP", project: "Project", request: "Request", creator: "Creator" };
/** v13 filter chips. */
const FILTERS: { kind: TeamSearchKind | null; label: string }[] = [
  { kind: null, label: "All" },
  { kind: "client", label: "Clients" },
  { kind: "lead", label: "Leads" },
  { kind: "project", label: "Projects" },
  { kind: "task", label: "Tasks" },
  { kind: "request", label: "Requests" },
  { kind: "invoice", label: "Invoices" },
  { kind: "person", label: "People" },
];
const RECENT_KEY = "bmu.search.recent";
const readRecent = (): TeamSearchItem[] => {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as TeamSearchItem[];
    return Array.isArray(v) ? v.slice(0, 6) : [];
  } catch {
    return [];
  }
};
const saveRecent = (item: TeamSearchItem) => {
  try {
    const next = [{ kind: item.kind, id: item.id, title: item.title, sub: item.sub, href: item.href }, ...readRecent().filter((r) => !(r.kind === item.kind && r.id === item.id))].slice(0, 6);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // private window: recents are a convenience only
  }
};

type PaletteAction = CorePaletteResult["actions"][number];

/**
 * Ctrl/Cmd+K search across clients, leads, proposals, invoices, tasks, people and SOPs. Results respect permissions on the server.
 * v11: typed phrases also run actions ("new task for Aroma", "reassign Reel 03 to Arjun", "add user to Design").
 * v13: smart search finds typos and partial names, adds projects, requests and creators, filter chips and recent items.
 */
export function GlobalSearch({ surface }: { surface: "team" | "admin" }) {
  const router = useRouter();
  const actions = useActionsMaybe();
  const [palette, setPalette] = useState<PaletteAction[]>([]);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [result, setResult] = useState<TeamSearchResult>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const [kind, setKind] = useState<TeamSearchKind | null>(null);
  const [recent, setRecent] = useState<TeamSearchItem[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  const term = q.trim();
  const shown = term.length >= 2 ? result : undefined;
  const intent = term.length >= 2 ? coreParsePaletteIntent(term) : null;
  const hasIntent = !!intent;
  const acts = useMemo(() => (hasIntent ? palette : []), [hasIntent, palette]);
  const found = useMemo<TeamSearchItem[]>(() => shown?.groups.flatMap((g) => g.items) ?? [], [shown]);
  const showRecent = useMemo(() => (term.length < 2 ? recent : []), [term, recent]);
  const items = useMemo(() => [...acts.map((a, i) => ({ kind: "action", id: String(i), title: a.label, sub: a.hint, href: a.href ?? "", act: a }) as unknown as TeamSearchItem & { act?: PaletteAction }), ...showRecent, ...found], [acts, showRecent, found]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    setTimeout(() => {
      input.current?.focus();
      setRecent(readRecent());
    }, 0);
  }, [open]);

  useEffect(() => {
    if (term.length < 2 || !coreParsePaletteIntent(term)) return;
    let live = true;
    const t = setTimeout(() => {
      api.actions
        .palette(term)
        .then((r) => live && setPalette(r.actions))
        .catch(() => live && setPalette([]));
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [term]);

  useEffect(() => {
    if (term.length < 2) return;
    const id = ++seq.current;
    const t = setTimeout(() => {
      setLoading(true);
      api.teamFlows
        .search(term, surface, kind ?? undefined)
        .then((r) => {
          if (id !== seq.current) return;
          setResult(r);
          setError(undefined);
          setActive(0);
        })
        .catch((e: Error) => id === seq.current && setError(e.message))
        .finally(() => id === seq.current && setLoading(false));
    }, 180);
    return () => clearTimeout(t);
  }, [term, surface, kind]);

  const close = useCallback(() => {
    setOpen(false);
    setQ("");
    setResult(undefined);
  }, []);

  const go = useCallback(
    (item: (TeamSearchItem & { act?: PaletteAction }) | undefined) => {
      if (!item) return;
      close();
      if (!item.act && item.href) saveRecent(item);
      const a = item.act;
      if (a && a.action === "new" && actions?.canNew(a.entity)) return actions.openNew(a.entity, a.prefill);
      if (a && a.action === "reassign" && actions && a.targetIds?.length) return actions.openReassign({ type: a.entity, ids: a.targetIds, toUserId: a.prefill.toUserId });
      if (a && !a.href) return actions?.notify("That action isn't available to you yet", null, "error");
      router.push(item.href);
    },
    [close, router, actions],
  );

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(items.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(items[active]);
    }
  }

  let index = -1;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mx-5 mb-3 flex w-[calc(100%-2.5rem)] items-center justify-between border border-border bg-surface-raised px-3 py-1.5 text-left text-xs text-ink-muted hover:border-ink md:mb-4"
        aria-label="Search (Ctrl+K)"
      >
        <span>Search…</span>
        <kbd className="hidden font-sans text-[10px] md:inline">Ctrl K</kbd>
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-charcoal/30 px-4 pt-[10vh]" onMouseDown={close} role="dialog" aria-modal="true" aria-label="Search">
          <div className="w-full max-w-xl border border-border bg-surface shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
            <input
              ref={input}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search, or type an action: new task for Aroma, reassign Reel 03 to Arjun…"
              className="w-full border-b border-border bg-surface px-4 py-3 text-sm outline-none"
              aria-label="Search everything"
              role="combobox"
              aria-expanded={items.length > 0}
              aria-controls="global-search-results"
            />
            <div className="flex flex-wrap gap-1 border-b border-border px-3 py-2" data-testid="search-filters">
              {FILTERS.map((f) => (
                <button
                  key={f.label}
                  type="button"
                  onClick={() => {
                    setKind(f.kind);
                    setResult(undefined);
                    input.current?.focus();
                  }}
                  aria-pressed={kind === f.kind}
                  className={`border px-2 py-0.5 text-[11px] ${kind === f.kind ? "border-charcoal bg-charcoal text-white" : "border-border text-ink-muted hover:border-ink"}`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div id="global-search-results" role="listbox" className="max-h-[60vh] overflow-y-auto">
              {q.trim().length < 2 && <p className="px-4 py-4 text-sm text-ink-muted">Type at least 2 letters. Typos are fine. Use ↑ ↓ to move and Enter to open. Esc closes.</p>}
              {showRecent.length > 0 && (
                <div className="border-b border-border" data-testid="search-recent">
                  <p className="px-4 pt-3 pb-1 text-[11px] uppercase tracking-[0.12em] text-ink-muted">Recent</p>
                  <ul>
                    {showRecent.map((item, i) => {
                      // Recent items show only before typing, when there are no actions or results above or below them.
                      return (
                        <li key={`recent-${item.kind}-${item.id}`} role="option" aria-selected={i === active}>
                          <button type="button" onMouseEnter={() => setActive(i)} onClick={() => go(item)} className={`flex w-full items-baseline justify-between gap-3 px-4 py-2 text-left text-sm ${i === active ? "bg-canvas" : ""}`}>
                            <span className="min-w-0">
                              <span className="block truncate font-medium">{item.title}</span>
                              {item.sub && <span className="block truncate text-xs text-ink-muted">{item.sub}</span>}
                            </span>
                            <span className="shrink-0 text-[11px] text-ink-muted">{KIND_HINT[item.kind]}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
              {error && term.length >= 2 && <p className="px-4 py-4 text-sm text-red">{error}</p>}
              {!error && term.length >= 2 && !loading && shown && found.length === 0 && !acts.length && <p className="px-4 py-4 text-sm text-ink-muted">Nothing found for “{q.trim()}” that you can open.</p>}
              {loading && !shown && term.length >= 2 && <p className="px-4 py-4 text-sm text-ink-muted">Searching…</p>}
              {acts.length > 0 && (
                <div className="border-b border-border" data-testid="palette-actions">
                  <p className="px-4 pt-3 pb-1 text-[11px] uppercase tracking-[0.12em] text-ink-muted">Actions</p>
                  <ul>
                    {items.slice(0, acts.length).map((item) => {
                      index += 1;
                      const i = index;
                      return (
                        <li key={`action-${item.id}`} role="option" aria-selected={i === active}>
                          <button type="button" onMouseEnter={() => setActive(i)} onClick={() => go(item)} className={`flex w-full items-baseline justify-between gap-3 px-4 py-2 text-left text-sm ${i === active ? "bg-canvas" : ""}`}>
                            <span className="min-w-0">
                              <span className="block truncate font-medium">{item.title}</span>
                              {item.sub && <span className="block truncate text-xs text-ink-muted">{item.sub}</span>}
                            </span>
                            <span className="shrink-0 text-[11px] text-ink-muted">Action</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
              {shown?.groups.map((g) => (
                <div key={g.kind} className="border-b border-border last:border-b-0">
                  <p className="px-4 pt-3 pb-1 text-[11px] uppercase tracking-[0.12em] text-ink-muted">{g.label}</p>
                  <ul>
                    {g.items.map((item) => {
                      index += 1;
                      const i = index;
                      return (
                        <li key={`${item.kind}-${item.id}`} role="option" aria-selected={i === active}>
                          <button
                            type="button"
                            onMouseEnter={() => setActive(i)}
                            onClick={() => go(item)}
                            className={`flex w-full items-baseline justify-between gap-3 px-4 py-2 text-left text-sm ${i === active ? "bg-canvas" : ""}`}
                          >
                            <span className="min-w-0">
                              <span className="block truncate font-medium">{item.title}</span>
                              {item.sub && <span className="block truncate text-xs text-ink-muted">{item.sub}</span>}
                            </span>
                            <span className="shrink-0 text-right text-[11px] text-ink-muted">
                              {KIND_HINT[item.kind]}
                              {item.fuzzy && <span className="block text-[10px]" data-testid="close-match">Close match</span>}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
