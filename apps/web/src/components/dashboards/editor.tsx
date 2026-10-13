"use client";

/**
 * v12 Dashboard Studio editor. Live preview of the dashboard with a toolbar on every widget: drag or arrows to move,
 * width, settings, duplicate, hide/remove. Add from the library. Save keeps a version; History restores any of them.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  DASHBOARD_BUILTINS,
  DASHBOARD_SIZES,
  isCraftSpecialty,
  type DashboardAudience,
  type DashboardBuiltinKey,
  type DashboardPlacement,
  type DashboardStudio,
  type DashboardVersionRow,
  type DashboardView,
  type DashboardWidget,
} from "@bmu/shared";
import { ActionDialog, ActionDrawer, Field, TextArea } from "@/components/actions/action-drawer";
import { RowMenu } from "@/components/actions/row-menu";
import { Empty, Tabs } from "@/components/dash";
import { Badge, Button, Input, LoadState } from "@/components/ui";
import { api } from "@/lib/api";
import { CraftDashboard } from "@/components/craft/craft-dashboard";
import { ManagerDashboard } from "@/components/craft/manager-dashboard";
import { MyDayPanel } from "@/components/my-day-panel";
import { WeeklyReviewBody } from "@/app/(admin)/admin/weekly-review";
import { ScorecardEmbed } from "@/app/(admin)/admin/analytics/scorecard-body";
import { AudiencePicker, PlacementSelect } from "./audience-picker";
import { DashGrid, type DashWrap } from "./grid";
import { WidgetLibrary } from "./library";
import { WidgetSettings } from "./widget-settings";
import { isMoneyWidget, newWidgetId, widgetKind, widgetLabel } from "./studio-kit";

type Draft = { name: string; description: string; placement: DashboardPlacement; audience: DashboardAudience; layout: DashboardWidget[] };
const draftOf = (v: DashboardView): Draft => ({
  name: v.name,
  description: v.description ?? "",
  placement: v.placement ?? "menu",
  audience: v.audience ?? { everyone: false, roles: [], specialties: [], userIds: [] },
  layout: v.layout,
});
const shortSize = { full: "Full", wide: "2/3", half: "1/2", third: "1/3" } as const;
const when = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

export function DashboardEditor({ id }: { id: string }) {
  const router = useRouter();
  const [view, setView] = useState<DashboardView>();
  const [studio, setStudio] = useState<DashboardStudio>();
  const [loadError, setLoadError] = useState<string>();
  const [draft, setDraft] = useState<Draft>();
  const [mode, setMode] = useState<"live" | "outline">("live");
  const [full, setFull] = useState(false);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [library, setLibrary] = useState(false);
  const [editing, setEditing] = useState<DashboardWidget | null>(null);
  const [history, setHistory] = useState(false);
  const [confirm, setConfirm] = useState<"reset" | "archive" | "discard" | null>(null);
  const [reason, setReason] = useState("");
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [showWho, setShowWho] = useState(false);

  useEffect(() => {
    Promise.all([api.dashboards.get(id), api.dashboards.studio()]).then(
      ([v, s]) => {
        setView(v);
        setDraft(draftOf(v));
        setStudio(s);
        setShowWho(!v.builtin && !v.audience?.everyone && !v.audience?.roles.length && !v.audience?.specialties.length && !v.audience?.userIds.length);
        if (v.builtin === "client_home") setMode("outline");
      },
      (e: Error) => setLoadError(e.message),
    );
  }, [id]);

  const dirty = useMemo(() => !!view && !!draft && JSON.stringify(draftOf(view)) !== JSON.stringify(draft), [view, draft]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (!view || !draft || !studio) return <LoadState loading={!loadError} error={loadError} />;
  const host = view.builtin;
  const def = host ? DASHBOARD_BUILTINS[host] : null;
  const specialistPreview = studio.people.find((p) => isCraftSpecialty(p.specialty));
  const outlineOnly = host === "client_home" || (host === "specialist" && !specialistPreview);
  const layout = draft.layout;
  const setLayout = (next: DashboardWidget[]) => setDraft({ ...draft, layout: next });
  const move = (from: number, to: number) => {
    if (to < 0 || to >= layout.length || from === to) return;
    const next = [...layout];
    const [w] = next.splice(from, 1);
    next.splice(to, 0, w);
    setLayout(next);
  };
  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast((t) => (t === m ? null : t)), 4000);
  };

  async function save() {
    if (!view || !draft) return;
    setSaving(true);
    setError(null);
    try {
      const v = await api.dashboards.update(
        view.id,
        view.builtin
          ? { layout: draft.layout, note: note || undefined }
          : { name: draft.name, description: draft.description || null, placement: draft.placement, audience: draft.audience, layout: draft.layout, note: note || undefined },
      );
      setView(v);
      setDraft(draftOf(v));
      setNote("");
      flash("Saved. People see the new layout the next time they open it.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function act(fn: () => Promise<DashboardView>, message: string) {
    setError(null);
    try {
      const v = await fn();
      setView(v);
      setDraft(draftOf(v));
      setConfirm(null);
      flash(message);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const label = (w: DashboardWidget) => widgetLabel(w, host);
  const wrap: DashWrap = (w, node, i) => (
    <div
      className={`border bg-surface ${dragFrom === i ? "border-charcoal opacity-60" : "border-border"}`}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (dragFrom !== null) move(dragFrom, i);
        setDragFrom(null);
      }}
      data-testid="edit-cell"
      data-label={label(w)}
    >
      <div className="flex flex-wrap items-center gap-1 border-b border-border bg-canvas/60 px-2 py-1.5 text-xs">
        <span
          draggable
          onDragStart={() => setDragFrom(i)}
          onDragEnd={() => setDragFrom(null)}
          className="cursor-grab px-1 text-ink-muted select-none"
          title="Drag to move"
          aria-hidden
        >
          ⠿
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{label(w)}</span>
        {isMoneyWidget(w) && <Badge tone="amber">Money roles only</Badge>}
        {(w.size === "full" || w.size === "wide") && <span className="hidden text-ink-muted sm:inline">{widgetKind(w)}</span>}
        <select
          aria-label={`Width of ${label(w)}`}
          value={w.size}
          onChange={(e) => setLayout(layout.map((x, j) => (j === i ? ({ ...x, size: e.target.value } as DashboardWidget) : x)))}
          className="border border-border bg-surface px-1 py-0.5"
        >
          {DASHBOARD_SIZES.map((s) => (
            <option key={s} value={s}>
              {shortSize[s]}
            </option>
          ))}
        </select>
        <IconButton label={`Move ${label(w)} up`} onClick={() => move(i, i - 1)} disabled={i === 0}>
          ↑
        </IconButton>
        <IconButton label={`Move ${label(w)} down`} onClick={() => move(i, i + 1)} disabled={i === layout.length - 1}>
          ↓
        </IconButton>
        {w.type !== "section" && (
          <>
            <IconButton label={`Change ${label(w)}`} onClick={() => setEditing(w)}>
              ⚙
            </IconButton>
            <IconButton label={`Duplicate ${label(w)}`} onClick={() => setLayout([...layout.slice(0, i + 1), { ...w, id: newWidgetId() }, ...layout.slice(i + 1)])}>
              ⧉
            </IconButton>
          </>
        )}
        <IconButton label={`${w.type === "section" && w.dashboard === host ? "Hide" : "Remove"} ${label(w)}`} onClick={() => setLayout(layout.filter((_, j) => j !== i))}>
          ✕
        </IconButton>
      </div>
      <div className={`pointer-events-none select-none ${full ? "" : "relative max-h-[420px] overflow-hidden"}`} aria-hidden>
        {node}
        {!full && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-surface to-transparent" />}
      </div>
    </div>
  );

  const outlineSections = def ? Object.fromEntries(def.sections.map((s) => [s.key, <OutlineBox key={s.key} title={s.label} hint={s.hint ?? def.name} />])) : {};
  let canvas: ReactNode;
  if (!layout.length) {
    canvas = (
      <Empty>
        Nothing on this dashboard yet.{" "}
        <button className="underline" onClick={() => setLibrary(true)}>
          Add a widget
        </button>
      </Empty>
    );
  } else if (mode === "outline" || outlineOnly) {
    canvas = <OutlineGrid items={layout} host={host} sections={outlineSections} wrap={wrap} />;
  } else if (host === "command_centre") canvas = <WeeklyReviewBody layout={layout} wrap={wrap} />;
  else if (host === "scorecard") canvas = <ScorecardEmbed layout={layout} wrap={wrap} />;
  else if (host === "my_day") canvas = <MyDayPanel layout={layout} wrap={wrap} hasLeads />;
  else if (host === "manager") canvas = <ManagerDashboard layout={layout} wrap={wrap} />;
  else if (host === "specialist") canvas = <CraftDashboard userId={specialistPreview?.id} layout={layout} wrap={wrap} />;
  else canvas = <DashGrid items={layout} wrap={wrap} />;

  const hiddenSections = def ? def.sections.filter((s) => !layout.some((w) => w.type === "section" && w.dashboard === host && w.section === s.key)) : [];
  const menu = [
    { key: "open", label: "Open the dashboard", href: def ? def.path : `/team/dashboards/${view.id}` },
    { key: "history", label: "History and restore", onSelect: () => setHistory(true) },
    { key: "copy", label: host ? "Copy into a new dashboard" : "Duplicate", hidden: host === "client_home", onSelect: () => api.dashboards.duplicate(view.id).then((d) => router.push(`/admin/dashboards/${d.id}`), (e: Error) => setError(e.message)) },
    { key: "reset", label: "Reset to original", hidden: !host, disabledReason: view.customised ? null : "It already has the original layout", onSelect: () => setConfirm("reset") },
    { key: "archive", label: view.archived ? "Restore" : "Archive", hidden: !!host, danger: !view.archived, onSelect: () => (view.archived ? act(() => api.dashboards.restore(view.id), "Restored") : (setReason(""), setConfirm("archive"))) },
  ];

  return (
    <div data-testid="dashboard-editor">
      <div className="mb-4">
        <Link href="/admin/dashboards" className="text-sm text-ink-muted hover:text-ink">
          ← Dashboard Studio
        </Link>
      </div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-3xl tracking-tight">{draft.name || "Untitled dashboard"}</h1>
          <p className="mt-1 text-sm text-ink-muted">{def ? `${def.where} · seen by ${def.who.charAt(0).toLowerCase()}${def.who.slice(1)}` : draft.description || "A dashboard built in the Studio"}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Badge tone="dark">{host ? "Built-in" : "Custom"}</Badge>
            {view.customised && <Badge tone="green">Customised</Badge>}
            {view.archived && <Badge tone="red">Archived</Badge>}
            {dirty && <Badge tone="amber">Unsaved changes</Badge>}
          </div>
        </div>
        <RowMenu label="More dashboard actions" items={menu} />
      </div>

      <div className="sticky top-0 z-30 -mx-5 mb-6 flex flex-wrap items-center gap-2 border-y border-border bg-surface/95 px-5 py-3 backdrop-blur md:-mx-10 md:px-10" data-testid="editor-bar">
        <Button onClick={() => setLibrary(true)} disabled={view.archived} data-testid="add-widget">
          + Add widget
        </Button>
        {!outlineOnly && <Tabs value={mode} onChange={setMode} options={[{ value: "live", label: "Live preview" }, { value: "outline", label: "Outline" }]} />}
        {mode === "live" && !outlineOnly && (
          <label className="flex items-center gap-1.5 text-xs text-ink-muted">
            <input type="checkbox" checked={full} onChange={(e) => setFull(e.target.checked)} /> Full height
          </label>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {dirty && <Input aria-label="Note for the history" placeholder="What changed? (optional)" value={note} onChange={(e) => setNote(e.target.value)} className="w-56 max-w-full text-sm" maxLength={160} />}
          {dirty && (
            <Button variant="ghost" onClick={() => setConfirm("discard")}>
              Discard
            </Button>
          )}
          <Button onClick={save} disabled={!dirty || saving || view.archived} data-testid="save-dashboard">
            {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
          </Button>
        </div>
      </div>

      {toast && (
        <p role="status" className="mb-4 border border-green bg-green/10 px-4 py-2 text-sm">
          {toast}
        </p>
      )}
      {error && (
        <p role="alert" className="mb-4 border border-red bg-red/10 px-4 py-2 text-sm">
          {error}
        </p>
      )}

      {!host && (
        <section className="mb-6 border border-border bg-surface-raised">
          <button type="button" className="flex w-full items-center justify-between px-5 py-3 text-left text-sm" aria-expanded={showWho} onClick={() => setShowWho((v) => !v)}>
            <span>
              <span className="font-medium">Name, who sees it and where</span>
              <span className="block text-xs text-ink-muted">{whoLine(draft, studio)}</span>
            </span>
            <span className="text-ink-muted">{showWho ? "−" : "+"}</span>
          </button>
          {showWho && (
            <div className="grid gap-6 border-t border-border px-5 py-4 lg:grid-cols-2">
              <div className="space-y-4">
                <Field label="Name" required htmlFor="ed-name">
                  <Input id="ed-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="w-full" maxLength={80} />
                </Field>
                <Field label="What it is for" htmlFor="ed-desc">
                  <TextArea id="ed-desc" rows={2} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} maxLength={300} />
                </Field>
                <PlacementSelect value={draft.placement} onChange={(placement) => setDraft({ ...draft, placement })} />
              </div>
              <Field label="Who sees it">
                <AudiencePicker value={draft.audience} onChange={(audience) => setDraft({ ...draft, audience })} studio={studio} />
              </Field>
            </div>
          )}
        </section>
      )}

      {host === "specialist" && specialistPreview && mode === "live" && (
        <p className="mb-4 text-xs text-ink-muted">Previewing with {specialistPreview.name}&apos;s work. Each specialist sees their own.</p>
      )}
      {!host && mode === "live" && <p className="mb-4 text-xs text-ink-muted">You see your own numbers here. Each person sees what their role allows: people outside the Command Centre see their own numbers.</p>}
      {hiddenSections.length > 0 && (
        <p className="mb-4 text-xs text-ink-muted" data-testid="hidden-sections">
          Hidden sections: {hiddenSections.map((s) => s.label).join(", ")}. Add them back from + Add widget → Sections.
        </p>
      )}

      {canvas}

      {library && (
        <WidgetLibrary
          open
          onClose={() => setLibrary(false)}
          host={host}
          surface={view.surface}
          layout={layout}
          onAdd={(w) => {
            setLayout([...layout, w]);
            setLibrary(false);
            flash(`${widgetLabel(w, host)} added at the bottom. Save to keep it.`);
          }}
        />
      )}
      {editing && <WidgetSettings widget={editing} host={host} onClose={() => setEditing(null)} onApply={(w) => setLayout(layout.map((x) => (x.id === w.id ? w : x)))} />}
      {history && (
        <HistoryDrawer
          id={view.id}
          onClose={() => setHistory(false)}
          onRestore={(versionId) =>
            act(() => api.dashboards.restoreVersion(view.id, versionId), "Earlier version restored and saved").then(() => setHistory(false))
          }
          dirty={dirty}
        />
      )}
      <ActionDialog
        open={confirm !== null}
        title={confirm === "reset" ? "Reset to the original layout?" : confirm === "archive" ? `Archive ${view.name}?` : "Discard your changes?"}
        onClose={() => setConfirm(null)}
        testId="editor-confirm"
        footer={
          <>
            <Button
              disabled={confirm === "archive" && reason.trim().length < 3}
              onClick={() => {
                if (confirm === "reset") act(() => api.dashboards.reset(view.id), "Back to the original layout. The old one is in History.");
                else if (confirm === "archive") act(() => api.dashboards.archive(view.id, reason), "Archived. People no longer see it.");
                else {
                  setDraft(draftOf(view));
                  setConfirm(null);
                }
              }}
            >
              {confirm === "reset" ? "Reset" : confirm === "archive" ? "Archive" : "Discard"}
            </Button>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
          </>
        }
      >
        {confirm === "reset" && <p>Every section comes back in its usual place and your added widgets are removed. You can bring this layout back from History.</p>}
        {confirm === "discard" && <p>The dashboard goes back to how it was last saved.</p>}
        {confirm === "archive" && (
          <Field label="Why" required htmlFor="ed-reason">
            <TextArea id="ed-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        )}
      </ActionDialog>
    </div>
  );
}

function whoLine(d: Draft, s: DashboardStudio) {
  const a = d.audience;
  const roles = a.roles.map((r) => s.roles.find((x) => x.id === r)?.label ?? r);
  const specs = a.specialties.map((r) => s.specialties.find((x) => x.id === r)?.label ?? r);
  const people = a.userIds.length ? [`${a.userIds.length} named ${a.userIds.length === 1 ? "person" : "people"}`] : [];
  const who = a.everyone ? "Everyone in the team" : [...roles, ...specs, ...people].join(", ") || "Nobody yet (only Founder and Branch Manager)";
  const where = d.placement === "menu" ? "under Dashboards in the menu" : d.placement === "team_home" ? "as their team app home" : "as their Command Centre home";
  return `${who} · ${where}`;
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled} className="px-1.5 py-0.5 text-ink-muted hover:bg-surface hover:text-ink disabled:opacity-30">
      {children}
    </button>
  );
}

function OutlineBox({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="border border-dashed border-border bg-canvas/40 px-4 py-5">
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="mt-1 text-xs text-ink-muted">{hint}</p>}
    </div>
  );
}

/** Outline: every widget as a labelled box, no data loaded. Quick for rearranging. */
function OutlineGrid({ items, host, sections, wrap }: { items: DashboardWidget[]; host: DashboardBuiltinKey | null; sections: Record<string, ReactNode>; wrap: DashWrap }) {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-6">
      {items.map((w, i) => {
        const node = w.type === "section" && w.dashboard === host ? sections[w.section] : <OutlineBox title={widgetLabel(w, host)} hint={widgetKind(w)} />;
        const span = { full: "lg:col-span-6", wide: "lg:col-span-4", half: "lg:col-span-3", third: "lg:col-span-2" }[w.size];
        return (
          <div key={w.id} className={`min-w-0 ${span}`} data-widget={w.type} data-widget-id={w.id}>
            {wrap(w, node, i)}
          </div>
        );
      })}
    </div>
  );
}

function HistoryDrawer({ id, onClose, onRestore, dirty }: { id: string; onClose: () => void; onRestore: (versionId: string) => void; dirty: boolean }) {
  const [rows, setRows] = useState<DashboardVersionRow[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    api.dashboards.versions(id).then(setRows, (e: Error) => setError(e.message));
  }, [id]);
  return (
    <ActionDrawer open title="History" subtitle="Every save is kept. Restoring a version saves it as the newest one, so nothing is lost." onClose={onClose} testId="dashboard-history">
      {dirty && <p className="border border-amber bg-amber/10 px-3 py-2 text-sm">You have unsaved changes. Restoring a version replaces them.</p>}
      {!rows ? (
        <LoadState loading={!error} error={error} />
      ) : rows.length ? (
        <ul className="divide-y divide-border border border-border">
          {rows.map((v) => (
            <li key={v.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <span className="min-w-0">
                <span className="block text-sm font-medium">{v.note || "Saved"}</span>
                <span className="block text-xs text-ink-muted">
                  {when.format(new Date(v.savedAt))}
                  {v.savedBy ? ` · ${v.savedBy}` : ""} · {v.widgets} widget{v.widgets === 1 ? "" : "s"}
                </span>
              </span>
              {v.current ? (
                <Badge tone="green">Current</Badge>
              ) : (
                <Button variant="secondary" className="shrink-0 px-3 py-1 text-xs" onClick={() => onRestore(v.id)}>
                  Restore
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-muted">No saves yet. The original layout is used until someone saves a change.</p>
      )}
    </ActionDrawer>
  );
}

