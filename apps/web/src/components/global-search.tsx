"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { coreParsePaletteIntent, SEARCH_MIN_SCORE, searchScore, type CorePaletteResult, type TeamSearchItem, type TeamSearchKind, type TeamSearchResult } from "@bmu/shared";
import { api } from "@/lib/api";
import { useActionsMaybe } from "./actions/actions-provider";
import type { NavSection } from "./side-nav";

const KIND_HINT: Record<string, string> = { page: "Page", client: "Client", lead: "Lead", proposal: "Proposal", invoice: "Invoice", task: "Task", person: "Person", sop: "SOP", project: "Project", request: "Request", creator: "Creator", file: "File" };
/** v61: "page" = a page from this person's menu, found in the browser (no server call). */
type FilterKind = TeamSearchKind | "page";
/** v13 filter chips. v61: Pages and Files. */
const FILTERS: { kind: FilterKind | null; label: string }[] = [
  { kind: null, label: "All" },
  { kind: "page", label: "Pages" },
  { kind: "client", label: "Clients" },
  { kind: "lead", label: "Leads" },
  { kind: "project", label: "Projects" },
  { kind: "task", label: "Tasks" },
  { kind: "request", label: "Requests" },
  { kind: "invoice", label: "Invoices" },
  { kind: "file", label: "Files" },
  { kind: "person", label: "People" },
];
/** v61: pages that are not in the menu but people look for. */
const EXTRA_PAGES: { label: string; href: string; section: string; words?: string }[] = [
  { label: "My profile", href: "/team/profile", section: "You", words: "leave attendance holidays notifications settings" },
  { label: "Sign-in security", href: "/security", section: "You", words: "password login sessions google two factor" },
];
const MAX_PAGES = 6;

/** v61: the menu's pages that match, best first (typos and partial words are fine, like the rest of search). */
function matchPages(term: string, sections: NavSection[]): TeamSearchItem[] {
  const seen = new Set<string>();
  const all = [...sections.flatMap((s) => s.items.filter((i) => i.href).map((i) => ({ label: i.label, href: i.href!, section: s.section, words: "" }))), ...EXTRA_PAGES.map((p) => ({ words: "", ...p }))].filter((p) => !seen.has(p.href) && seen.add(p.href));
  return all
    .map((p) => ({ p, score: Math.max(searchScore(term, p.label), searchScore(term, `${p.section} ${p.label}`) * 0.9, p.words ? searchScore(term, p.words) * 0.85 : 0) }))
    .filter((x) => x.score >= SEARCH_MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_PAGES)
    .map(({ p }) => ({ kind: "page" as TeamSearchKind, id: p.href, title: p.label, sub: p.section, href: p.href }));
}
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
/** look "top" (v54 redesign preview): a glass pill in the top bar that opens the search inside its own box; the search itself is unchanged. */
export function GlobalSearch({ surface, look = "sidebar", pages = [] }: { surface: "team" | "admin"; look?: "sidebar" | "top"; /** v61: this person's menu. */ pages?: NavSection[] }) {
  const router = useRouter();
  const actions = useActionsMaybe();
  const [palette, setPalette] = useState<PaletteAction[]>([]);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [result, setResult] = useState<TeamSearchResult>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const [kind, setKind] = useState<FilterKind | null>(null);
  const [recent, setRecent] = useState<TeamSearchItem[]>([]);
  const input = useRef<HTMLInputElement>(null);
  // v54 top look: the shining cursor is drawn by us (a real cursor can't glow), placed where the real one would be.
  const caretMeasure = useRef<HTMLSpanElement>(null);
  const [caretX, setCaretX] = useState<number | null>(null);
  const chipDrag = useRef({ x: 0, left: 0, down: false, moved: false });
  const chipRow = useRef<HTMLDivElement>(null);
  const [chipEdge, setChipEdge] = useState({ left: false, right: false });
  const readChipEdge = useCallback((row: HTMLDivElement) => {
    const left = row.scrollLeft > 2;
    const right = row.scrollLeft < row.scrollWidth - row.clientWidth - 2;
    setChipEdge((e) => (e.left === left && e.right === right ? e : { left, right }));
  }, []);
  const moveChips = useCallback((dir: 1 | -1) => {
    const row = chipRow.current;
    if (row) row.scrollBy({ left: dir * Math.max(80, row.clientWidth * 0.7), behavior: "smooth" });
  }, []);
  const topBox = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  const term = q.trim();
  const shown = term.length >= 2 ? result : undefined;
  const intent = term.length >= 2 ? coreParsePaletteIntent(term) : null;
  const hasIntent = !!intent;
  const acts = useMemo(() => (hasIntent ? palette : []), [hasIntent, palette]);
  // v61: pages from the menu, shown above the records (only on "All" and "Pages").
  const pageHits = useMemo(() => (term.length >= 2 && (kind === null || kind === "page") ? matchPages(term, pages) : []), [term, kind, pages]);
  const serverKind = kind === "page" ? null : kind;
  const found = useMemo<TeamSearchItem[]>(() => (kind === "page" ? [] : (shown?.groups.flatMap((g) => g.items) ?? [])), [shown, kind]);
  const showRecent = useMemo(() => (term.length < 2 ? recent : []), [term, recent]);
  const items = useMemo(() => [...acts.map((a, i) => ({ kind: "action", id: String(i), title: a.label, sub: a.hint, href: a.href ?? "", act: a }) as unknown as TeamSearchItem & { act?: PaletteAction }), ...showRecent, ...pageHits, ...found], [acts, showRecent, pageHits, found]);

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
    // v61: the Pages filter is answered in the browser.
    if (term.length < 2 || kind === "page") return;
    const id = ++seq.current;
    const t = setTimeout(() => {
      setLoading(true);
      api.teamFlows
        .search(term, surface, serverKind ?? undefined)
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
  }, [term, surface, kind, serverKind]);

  // Puts the shining cursor where the typing point is (after typing, arrow keys, clicks); hidden while text is selected.
  const placeCaret = useCallback(() => {
    const el = input.current;
    const measure = caretMeasure.current;
    if (!el || !measure) return;
    if (document.activeElement !== el || el.selectionStart !== el.selectionEnd) return setCaretX(null);
    const at = el.selectionStart ?? 0;
    measure.textContent = el.value.slice(0, at);
    // Sits in the gap: just before the first letter at the start, just after the letter before it otherwise.
    const x = 10 + measure.offsetWidth - el.scrollLeft + (at === 0 ? -5 : 1);
    setCaretX(Math.max(2, Math.min(el.clientWidth - 3, x)));
  }, []);
  useEffect(() => {
    if (!open || look !== "top") return;
    const onChange = () => requestAnimationFrame(placeCaret);
    document.addEventListener("selectionchange", onChange);
    const first = setTimeout(onChange, 30);
    return () => {
      document.removeEventListener("selectionchange", onChange);
      clearTimeout(first);
    };
  }, [open, look, placeCaret]);
  useEffect(() => {
    if (open && look === "top") requestAnimationFrame(placeCaret);
  }, [q, open, look, placeCaret]);

  // The mouse wheel swipes the chip row sideways (and not the page) while there are more chips to see.
  useEffect(() => {
    const row = chipRow.current;
    if (!open || look !== "top" || !row) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const max = row.scrollWidth - row.clientWidth;
      const next = Math.max(0, Math.min(max, row.scrollLeft + e.deltaY));
      if (next === row.scrollLeft) return;
      e.preventDefault();
      row.scrollLeft = next;
    };
    row.addEventListener("wheel", onWheel, { passive: false });
    readChipEdge(row);
    return () => row.removeEventListener("wheel", onWheel);
  }, [open, look, readChipEdge]);

  const close = useCallback(() => {
    setOpen(false);
    setQ("");
    setResult(undefined);
  }, []);

  // The top look has no cover to click: a click outside its box closes it.
  useEffect(() => {
    if (!open || look !== "top") return;
    const onDown = (e: MouseEvent) => {
      if (!topBox.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, look, close]);

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

  const top = look === "top";
  // v54 top look: the filter chips sit in one line you can swipe sideways (finger, trackpad, mouse wheel or drag).
  const chipSwipe = {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType !== "mouse") return;
      chipDrag.current = { x: e.clientX, left: e.currentTarget.scrollLeft, down: true, moved: false };
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      const d = chipDrag.current;
      if (!d.down) return;
      if (Math.abs(e.clientX - d.x) > 4) d.moved = true;
      if (d.moved) e.currentTarget.scrollLeft = d.left - (e.clientX - d.x);
    },
    onPointerUp: () => {
      chipDrag.current.down = false;
      setTimeout(() => (chipDrag.current.moved = false), 0);
    },
    onPointerLeave: () => {
      chipDrag.current.down = false;
    },
    // Swiping the chips keeps the typing line focused, so the next letters still go into the search.
    onMouseDown: (e: React.MouseEvent<HTMLDivElement>) => e.preventDefault(),
  };
  const activeRow = top ? "bg-ui-accent-soft" : "bg-canvas";
  let index = -1;
  // The typing line, then the filter chips and results: the same search in both looks.
  const searchLine = (
    <>
      {top ? (
        <div className="flex h-full items-center gap-2 px-3">
          <svg viewBox="0 0 20 20" className="h-[18px] w-[18px] shrink-0 text-ink-muted" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <circle cx="9" cy="9" r="5.5" />
            <path d="M13.2 13.2L17 17" />
          </svg>
          <div className="relative min-w-0 flex-1">
            {/* The shining cursor (BMU green glow) replaces the real one and follows the typing point; it restarts its blink on every move. */}
            <span ref={caretMeasure} aria-hidden className="pointer-events-none invisible absolute top-0 left-0 whitespace-pre text-[15px]" />
            {caretX !== null && <span key={`${caretX}-${q.length}`} className="top-search-caret" style={{ left: caretX }} aria-hidden />}
            <input
              ref={input}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search, or type an action: new task for Aroma, reassign Reel 03 to Arjun…"
              onFocus={placeCaret}
              onBlur={() => setCaretX(null)}
              className="top-search-input w-full bg-transparent py-2 pl-2.5 text-[15px] text-ink outline-none placeholder:text-ink-muted"
              aria-label="Search everything"
              role="combobox"
              aria-expanded={items.length > 0}
              aria-controls="global-search-results"
            />
          </div>
          <kbd className="hidden shrink-0 font-sans text-[10px] text-ink-muted sm:inline">Esc</kbd>
        </div>
      ) : (
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
      )}
    </>
  );
  // The filter chips (All, Clients, Leads…): one list for both looks.
  const chipButtons = FILTERS.map((f) => (
    <button
      key={f.label}
      type="button"
      onClick={(e) => {
        // A drag to swipe the row is not a click.
        if (top && chipDrag.current.moved) return e.preventDefault();
        setKind(f.kind);
        setResult(undefined);
        input.current?.focus();
      }}
      aria-pressed={kind === f.kind}
      className={top ? `shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] whitespace-nowrap select-none ${kind === f.kind ? "border-[var(--ui-primary-border)] text-ui-pill-active-ink [background:var(--ui-primary-fill)]" : "border-[var(--ui-glass-edge)] bg-[var(--ui-glass)] text-ink-muted hover:text-ink"}` : `border px-2 py-0.5 text-[11px] ${kind === f.kind ? "border-charcoal bg-charcoal text-white" : "border-border text-ink-muted hover:border-ink"}`}
    >
      {f.label}
    </button>
  ));
  const searchBody = (
    <>
      {top ? (
        // One line of filter chips: swipe it (finger, trackpad, wheel, drag) or click the ‹ › arrows.
        <div className="top-search-chip-bar flex items-center gap-1 border-b border-[var(--ui-glass-edge)] px-1.5 py-2">
          <ChipArrow dir={-1} hidden={!chipEdge.left} onMove={moveChips} />
          <div
            className="top-search-chips flex min-w-0 flex-1 flex-nowrap gap-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            data-testid="search-filters"
            ref={chipRow}
            onScroll={(e) => readChipEdge(e.currentTarget)}
            {...chipSwipe}
          >
            {chipButtons}
          </div>
          <ChipArrow dir={1} hidden={!chipEdge.right} onMove={moveChips} />
        </div>
      ) : (
        <div className="flex flex-wrap gap-1 border-b border-border px-3 py-2" data-testid="search-filters">
          {chipButtons}
        </div>
      )}
      <div id="global-search-results" role="listbox" className={top ? "max-h-[60vh] overflow-y-auto p-2" : "max-h-[60vh] overflow-y-auto"}>
        {q.trim().length < 2 && <p className="px-4 py-4 text-sm text-ink-muted">Find pages, clients, projects, tasks, files, people and more. Type at least 2 letters; typos are fine. Use ↑ ↓ to move and Enter to open. Esc closes.</p>}
        {showRecent.length > 0 && (
          <div className={top ? "" : "border-b border-border"} data-testid="search-recent">
            <p className="px-4 pt-3 pb-1 text-[11px] uppercase tracking-[0.12em] text-ink-muted">Recent</p>
            <ul>
              {showRecent.map((item, i) => {
                // Recent items show only before typing, when there are no actions or results above or below them.
                return (
                  <li key={`recent-${item.kind}-${item.id}`} role="option" aria-selected={i === active}>
                    <button type="button" onMouseEnter={() => setActive(i)} onClick={() => go(item)} className={`flex w-full items-baseline justify-between gap-3 px-4 py-2 text-left text-sm ${top ? "rounded-xl" : ""} ${i === active ? activeRow : ""}`}>
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
        {!error && term.length >= 2 && (kind === "page" || (!loading && shown)) && found.length === 0 && !acts.length && !pageHits.length && <p className="px-4 py-4 text-sm text-ink-muted">Nothing found for “{q.trim()}” that you can open.</p>}
        {loading && !shown && term.length >= 2 && kind !== "page" && !pageHits.length && <p className="px-4 py-4 text-sm text-ink-muted">Searching…</p>}
        {acts.length > 0 && (
          <div className={top ? "" : "border-b border-border"} data-testid="palette-actions">
            <p className="px-4 pt-3 pb-1 text-[11px] uppercase tracking-[0.12em] text-ink-muted">Actions</p>
            <ul>
              {items.slice(0, acts.length).map((item) => {
                index += 1;
                const i = index;
                return (
                  <li key={`action-${item.id}`} role="option" aria-selected={i === active}>
                    <button type="button" onMouseEnter={() => setActive(i)} onClick={() => go(item)} className={`flex w-full items-baseline justify-between gap-3 px-4 py-2 text-left text-sm ${top ? "rounded-xl" : ""} ${i === active ? activeRow : ""}`}>
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
        {pageHits.length > 0 && (
          <div className={top ? "" : "border-b border-border"} data-testid="search-pages">
            <p className="px-4 pt-3 pb-1 text-[11px] uppercase tracking-[0.12em] text-ink-muted">Pages</p>
            <ul>
              {pageHits.map((item, n) => {
                // v61: pages come right after the actions in the keyboard order (recents only show before typing).
                const i = acts.length + n;
                return (
                  <li key={`page-${item.id}`} role="option" aria-selected={i === active}>
                    <button type="button" onMouseEnter={() => setActive(i)} onClick={() => go(item)} className={`flex w-full items-baseline justify-between gap-3 px-4 py-2 text-left text-sm ${top ? "rounded-xl" : ""} ${i === active ? activeRow : ""}`}>
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{item.title}</span>
                        {item.sub && <span className="block truncate text-xs text-ink-muted">{item.sub}</span>}
                      </span>
                      <span className="shrink-0 text-[11px] text-ink-muted">Page</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {kind !== "page" && shown?.groups.map((g) => (
          <div key={g.kind} className={top ? "" : "border-b border-border last:border-b-0"}>
            <p className="px-4 pt-3 pb-1 text-[11px] uppercase tracking-[0.12em] text-ink-muted">{g.label}</p>
            <ul>
              {g.items.map((item) => {
                index += 1;
                // v61: after the actions and the Pages group.
                const i = index + pageHits.length;
                return (
                  <li key={`${item.kind}-${item.id}`} role="option" aria-selected={i === active}>
                    <button
                      type="button"
                      onMouseEnter={() => setActive(i)}
                      onClick={() => go(item)}
                      className={`flex w-full items-baseline justify-between gap-3 px-4 py-2 text-left text-sm ${top ? "rounded-xl" : ""} ${i === active ? activeRow : ""}`}
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
    </>
  );
  const panel = (
    <>
      {searchLine}
      {searchBody}
    </>
  );
  if (top)
    return (
      // v54 redesign preview: clicking the pill turns it into a glowing search bar in the same spot and size, and the
      // results open in their own glass card just below it. A click outside or Esc closes it.
      <div ref={topBox} className="top-search relative">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="top-search-button inline-flex h-9 items-center gap-2 rounded-full border border-[var(--ui-glass-edge)] px-3 text-left text-sm text-ink-muted shadow-[var(--ui-glass-panel-shadow)] backdrop-blur-xl [background:var(--ui-glass-sheen)] hover:text-ink sm:w-56"
          aria-label="Search (Ctrl+K)"
        >
          <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <circle cx="9" cy="9" r="5.5" />
            <path d="M13.2 13.2L17 17" />
          </svg>
          <span className="hidden flex-1 sm:inline">Search…</span>
          <kbd className="hidden font-sans text-[10px] md:inline">Ctrl K</kbd>
        </button>
        {open && (
          <>
            <div role="dialog" aria-label="Search" className="top-search-open absolute top-0 right-0 z-[61] flex w-[calc(100vw-2rem)] flex-col items-end gap-2.5 sm:w-56 text-ink max-sm:fixed max-sm:top-4 max-sm:right-4 max-sm:left-4 max-sm:w-auto">
              {/* The search bar: same size and spot as the pill (Hari: no stretching, no blur behind). */}
              <div className="top-search-panel top-search-bar h-9 w-full sm:w-56">{searchLine}</div>
              {/* The results: their own glass card just below the bar. */}
              <div className="top-search-results design-glass-menu w-full overflow-hidden p-0!" style={{ borderRadius: 24 }}>
                {searchBody}
              </div>
            </div>
          </>
        )}
      </div>
    );
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
            {panel}
          </div>
        </div>
      )}
    </>
  );
}

/** v54 search: the ‹ › buttons beside the filter chips; they fade out when there is nothing more on that side. */
function ChipArrow({ dir, hidden, onMove }: { dir: 1 | -1; hidden: boolean; onMove: (dir: 1 | -1) => void }) {
  return (
    <button
      type="button"
      aria-label={dir < 0 ? "Earlier filters" : "More filters"}
      tabIndex={hidden ? -1 : 0}
      aria-hidden={hidden || undefined}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onMove(dir)}
      className={`top-search-chip-arrow flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[var(--ui-glass-edge)] bg-[var(--ui-glass)] text-ink-muted transition-opacity hover:bg-ui-accent-soft hover:text-ink ${hidden ? "pointer-events-none opacity-0" : "opacity-100"}`}
    >
      <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d={dir < 0 ? "M10 4L6 8l4 4" : "M6 4l4 4-4 4"} />
      </svg>
    </button>
  );
}
