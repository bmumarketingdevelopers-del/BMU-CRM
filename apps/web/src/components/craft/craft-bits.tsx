"use client";
// v10 craft: small building blocks shared by the six specialist dashboards.
import { useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import type { CraftBrandKitView, CraftChecklistView, CraftComment, CraftJob, CraftKpi, CraftNextItem, CraftRounds } from "@bmu/shared";
import { Empty, Meter } from "@/components/dash";
import { deltaVs } from "@/components/charts";
import { Badge, Button, Input } from "@/components/ui";
import { api } from "@/lib/api";

const dayFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
const timeFmt = new Intl.DateTimeFormat("en-IN", { timeStyle: "short", timeZone: "Asia/Kolkata" });
const istDay = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);

export const fmtDay = (iso: string) => dayFmt.format(new Date(iso));
export const fmtTime = (iso: string) => timeFmt.format(new Date(iso));

/** "Today", "Tomorrow", "2 days late", "8 Oct". */
export function dueLabel(iso: string | null, overdue = false) {
  if (!iso) return "No date";
  const d = new Date(iso);
  const today = istDay(new Date());
  const key = istDay(d);
  if (overdue || (key < today && d < new Date())) {
    const late = Math.max(1, Math.round((Date.now() - d.getTime()) / 86_400_000));
    return `${late} day${late === 1 ? "" : "s"} late`;
  }
  if (key === today) return "Today";
  if (key === istDay(new Date(Date.now() + 86_400_000))) return "Tomorrow";
  return fmtDay(iso);
}

export function fmtKpi(k: Pick<CraftKpi, "value" | "format">) {
  if (k.format === "pct") return `${Math.round(k.value)}%`;
  if (k.format === "hours") return `${k.value}h`;
  if (k.format === "days") return `${k.value}d`;
  return k.value.toLocaleString("en-IN");
}

export const kpiDelta = (k: CraftKpi) => (k.previous === null ? undefined : deltaVs(k.value, k.previous, { lowerIsBetter: k.lowerIsBetter }));

/** Runs an action, showing a busy state and the server's error in plain words. */
export function useAction() {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  async function run<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(key);
    setError(undefined);
    try {
      return await fn();
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      setBusy(undefined);
    }
  }
  return { busy, error, run, setError };
}

export function ErrorLine({ error }: { error?: string }) {
  return error ? <p className="mt-2 border border-red bg-red/10 px-3 py-2 text-sm">{error}</p> : null;
}

const nextTone: Record<CraftNextItem["kind"], "red" | "amber" | "dark" | "green"> = { overdue: "red", due_today: "amber", assigned: "green", feedback: "dark", blocked: "red" };
const nextLabel: Record<CraftNextItem["kind"], string> = { overdue: "Overdue", due_today: "Due today", assigned: "New", feedback: "Feedback", blocked: "Blocked" };

/** Prioritised "what to do next" list: overdue → due today → client feedback → blocked. */
export function NextList({ items }: { items: CraftNextItem[] }) {
  if (!items.length) return <Empty>Nothing urgent. Pick the next job from your queue below.</Empty>;
  return (
    <ol className="divide-y divide-border">
      {items.map((n, i) => (
        <li key={n.id}>
          <Link href={n.href} className="flex items-start gap-3 py-3 hover:bg-canvas/40">
            <span className="mt-0.5 w-5 shrink-0 text-right text-xs tabular-nums text-ink-muted">{i + 1}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{n.title}</span>
              <span className="block truncate text-xs text-ink-muted">{[n.client, n.detail].filter(Boolean).join(" · ")}</span>
            </span>
            <Badge tone={nextTone[n.kind]}>{nextLabel[n.kind]}</Badge>
          </Link>
        </li>
      ))}
    </ol>
  );
}

export function PriorityBadge({ p }: { p: CraftJob["priority"] }) {
  return p === "high" ? <Badge tone="red">High</Badge> : p === "normal" ? <Badge tone="amber">Normal</Badge> : <Badge>Low</Badge>;
}

/** One job (deliverable) row: title links to the deliverable, with client, due date, rounds and status. */
export function JobRow({ job, extra, showPriority = false }: { job: CraftJob; extra?: ReactNode; showPriority?: boolean }) {
  const roundsLeft = job.roundsIncluded - job.roundsUsed;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
      <div className="min-w-0 flex-1">
        <Link href={job.href} className="block truncate text-sm font-medium hover:underline">
          {job.title}
        </Link>
        <p className="truncate text-xs text-ink-muted">
          {job.client.name} · <span className={job.overdue ? "font-medium text-red" : ""}>{dueLabel(job.due, job.overdue)}</span> · {job.statusLabel}
          {job.versions ? ` · v${job.versions}` : ""}
        </p>
      </div>
      {job.roundsUsed > 0 && <Badge tone={roundsLeft <= 0 ? "red" : roundsLeft === 1 ? "amber" : "neutral"}>{roundsLeft <= 0 ? "No rounds left" : `${roundsLeft} round${roundsLeft === 1 ? "" : "s"} left`}</Badge>}
      {showPriority && <PriorityBadge p={job.priority} />}
      {extra}
    </div>
  );
}

/** Columns of jobs by stage, scrolling sideways on a phone. */
export function StageBoard({ stages, empty = "Nothing here", render }: { stages: { key: string; label: string; items: CraftJob[] }[]; empty?: string; render?: (j: CraftJob) => ReactNode }) {
  return (
    <div className="-mx-5 overflow-x-auto px-5">
      <div className="grid min-w-max auto-cols-[minmax(220px,1fr)] grid-flow-col gap-3">
        {stages.map((s) => (
          <div key={s.key} className="border border-border bg-surface p-3" data-stage={s.key}>
            <p className="mb-2 flex items-center justify-between text-[11px] font-medium uppercase tracking-[0.1em] text-ink-muted">
              {s.label} <span className="tabular-nums text-ink">{s.items.length}</span>
            </p>
            {s.items.length === 0 ? (
              <p className="py-3 text-xs text-ink-muted">{empty}</p>
            ) : (
              <ul className="space-y-2">
                {s.items.map((j) => (
                  <li key={`${j.deliverableId}-${j.taskId}`} className="border border-border bg-surface-raised p-2.5">
                    <Link href={j.href} className="block text-sm font-medium leading-snug hover:underline">
                      {j.title}
                    </Link>
                    <p className="mt-1 text-xs text-ink-muted">
                      {j.client.name} · <span className={j.overdue ? "font-medium text-red" : ""}>{dueLabel(j.due, j.overdue)}</span>
                    </p>
                    {render?.(j)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Client comments (time-coded or pinned) with a Resolve action. Resolved ones fade out with an Undo. */
export function CommentList({ comments, readOnly, empty = "No open client comments. Nice work." }: { comments: CraftComment[]; readOnly: boolean; empty?: string }) {
  const [state, setState] = useState<Record<string, boolean>>({});
  const { busy, error, run } = useAction();
  if (!comments.length) return <Empty>{empty}</Empty>;
  return (
    <div>
      <ul className="divide-y divide-border">
        {comments.map((c) => {
          const resolved = state[c.id] ?? !!c.resolvedAt;
          return (
            <li key={c.id} className={`flex items-start gap-3 py-3 ${resolved ? "opacity-50" : ""}`} data-comment={c.id}>
              <span className="mt-0.5 shrink-0 border border-border px-1.5 py-0.5 text-[11px] tabular-nums text-ink-muted">{c.anchorLabel ?? "General"}</span>
              <div className="min-w-0 flex-1">
                <p className={`text-sm ${resolved ? "line-through" : ""}`}>{c.body}</p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  <Link href={c.href} className="underline-offset-2 hover:underline">
                    {c.deliverableTitle} v{c.versionNumber}
                  </Link>{" "}
                  · {c.client} · {c.author}, {fmtDay(c.at)}
                </p>
              </div>
              {!readOnly &&
                (resolved ? (
                  <Button variant="ghost" className="shrink-0 px-2 py-1 text-xs" disabled={!!busy} onClick={() => run(c.id, () => api.craft.reopenComment(c.id)).then((r) => r && setState((s) => ({ ...s, [c.id]: false })))}>
                    Undo
                  </Button>
                ) : (
                  <Button variant="secondary" className="shrink-0 px-2.5 py-1 text-xs" disabled={busy === c.id} onClick={() => run(c.id, () => api.craft.resolveComment(c.id)).then((r) => r && setState((s) => ({ ...s, [c.id]: true })))}>
                    {busy === c.id ? "Saving…" : "Resolve"}
                  </Button>
                ))}
            </li>
          );
        })}
      </ul>
      <ErrorLine error={error} />
    </div>
  );
}

/** Revision rounds left per deliverable (included in the package vs used). */
export function RoundsList({ rounds, limit = 8 }: { rounds: CraftRounds[]; limit?: number }) {
  if (!rounds.length) return <Empty>No revision rounds used yet.</Empty>;
  return (
    <ul className="space-y-3">
      {rounds.slice(0, limit).map((r) => (
        <li key={r.deliverableId}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
            <Link href={r.href} className="truncate hover:underline">
              {r.title}
            </Link>
            <span className={`shrink-0 text-xs ${r.left <= 0 ? "font-medium text-red" : "text-ink-muted"}`}>{r.left <= 0 ? (r.left < 0 ? `${-r.left} over — quote an add-on` : "none left") : `${r.left} of ${r.included} left`}</span>
          </div>
          <Meter value={(r.used / Math.max(1, r.included)) * 100} tone={r.left <= 0 ? "bad" : r.left === 1 ? "warn" : "default"} label={`${r.used} of ${r.included} rounds used`} />
        </li>
      ))}
      {rounds.length > limit && <li className="text-xs text-ink-muted">+{rounds.length - limit} more with rounds to spare</li>}
    </ul>
  );
}

/** A working checklist saved per deliverable (export, web QC, handoff). Ticks save straight away. */
export function ChecklistCard({ list, readOnly }: { list: CraftChecklistView; readOnly: boolean }) {
  const [items, setItems] = useState(list.items);
  const { busy, error, run } = useAction();
  const done = items.filter((i) => i.done).length;
  async function toggle(i: number) {
    const next = items.map((x, k) => (k === i ? { ...x, done: !x.done } : x));
    setItems(next);
    const saved = await run("save", () => api.craft.saveChecklist(list.deliverableId, list.kind, { items: next }));
    if (!saved) setItems(items);
  }
  return (
    <div className="border border-border p-3" data-checklist={list.deliverableId}>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <Link href={list.href} className="truncate text-sm font-medium hover:underline">
          {list.title}
        </Link>
        <span className={`shrink-0 text-xs tabular-nums ${done === items.length ? "text-[#5f8a12]" : "text-ink-muted"}`}>
          {done}/{items.length}
          {busy ? " · saving" : ""}
        </span>
      </div>
      <p className="mb-2 text-xs text-ink-muted">{list.client}</p>
      <ul className="space-y-1.5">
        {items.map((i, k) => (
          <li key={i.label}>
            <label className={`flex items-start gap-2 text-sm ${readOnly ? "" : "cursor-pointer"}`}>
              <input type="checkbox" className="mt-0.5 accent-[#121F2F]" checked={i.done} disabled={readOnly} onChange={() => toggle(k)} />
              <span className={i.done ? "text-ink-muted line-through" : ""}>{i.label}</span>
            </label>
          </li>
        ))}
      </ul>
      <ErrorLine error={error} />
    </div>
  );
}

/** Uploads a new version of a deliverable from a file (sends it to QC). */
export function UploadVersion({ deliverableId, label = "Upload new version", onDone, accept }: { deliverableId: string; label?: string; onDone?: (msg: string) => void; accept?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const { busy, error, run } = useAction();
  const [msg, setMsg] = useState<string>();
  return (
    <span className="inline-flex flex-col items-start">
      <input
        ref={ref}
        type="file"
        className="hidden"
        accept={accept}
        data-upload={deliverableId}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          const d = await run("up", () => api.deliverables.uploadVersion(deliverableId, f));
          if (d) {
            const m = `v${d.versions.at(-1)?.number} uploaded — waiting for QC`;
            setMsg(m);
            onDone?.(m);
          }
          e.target.value = "";
        }}
      />
      {msg ? (
        <span className="text-xs text-[#5f8a12]">✓ {msg}</span>
      ) : (
        <Button variant="secondary" className="px-2.5 py-1 text-xs" disabled={!!busy} onClick={() => ref.current?.click()}>
          {busy ? "Uploading…" : label}
        </Button>
      )}
      <ErrorLine error={error} />
    </span>
  );
}

/** Client brand kit: colours, fonts, notes and brand files, editable by the team working on the client. */
export function BrandKitCard({ kit: initial, readOnly }: { kit: CraftBrandKitView; readOnly: boolean }) {
  const [kit, setKit] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    colours: kit.colours.join(", "),
    fonts: kit.fonts.join(", "),
    notes: kit.notes ?? "",
    tone: kit.tone ?? "",
    dos: (kit.dos ?? []).join("\n"),
    donts: (kit.donts ?? []).join("\n"),
    competitors: (kit.competitors ?? []).join(", "),
  });
  const fileRef = useRef<HTMLInputElement>(null);
  const { busy, error, run } = useAction();
  const split = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);
  const lines = (v: string) => v.split("\n").map((x) => x.trim()).filter(Boolean);
  return (
    <div className="border border-border p-4" data-brand={kit.clientId}>
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <p className="text-sm font-semibold">{kit.client}</p>
        {!readOnly && !editing && (
          <button className="text-xs text-ink-muted underline-offset-2 hover:text-ink hover:underline" onClick={() => setEditing(true)}>
            Edit kit
          </button>
        )}
      </div>
      {editing ? (
        <form
          className="space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const saved = await run("save", () => api.craft.saveBrandKit(kit.clientId, {
                colours: split(form.colours),
                fonts: split(form.fonts),
                notes: form.notes || undefined,
                tone: form.tone,
                dos: lines(form.dos),
                donts: lines(form.donts),
                competitors: split(form.competitors),
              }),
            );
            if (saved) {
              setKit(saved);
              setEditing(false);
            }
          }}
        >
          <label className="block text-xs text-ink-muted">
            Colours (comma separated)
            <Input className="mt-1" value={form.colours} onChange={(e) => setForm({ ...form, colours: e.target.value })} placeholder="#121F2F, #8BB72C" />
          </label>
          <label className="block text-xs text-ink-muted">
            Fonts
            <Input className="mt-1" value={form.fonts} onChange={(e) => setForm({ ...form, fonts: e.target.value })} placeholder="Poppins, Inter" />
          </label>
          <label className="block text-xs text-ink-muted">
            Notes
            <textarea className="mt-1 w-full border border-border bg-surface-raised px-3 py-2 text-sm" rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </label>
          <label className="block text-xs text-ink-muted">
            Tone of voice
            <textarea className="mt-1 w-full border border-border bg-surface-raised px-3 py-2 text-sm" rows={2} value={form.tone} onChange={(e) => setForm({ ...form, tone: e.target.value })} placeholder="Warm, playful, never salesy. Hinglish is fine." />
          </label>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block text-xs text-ink-muted">
              Do (one per line)
              <textarea className="mt-1 w-full border border-border bg-surface-raised px-3 py-2 text-sm" rows={3} value={form.dos} onChange={(e) => setForm({ ...form, dos: e.target.value })} />
            </label>
            <label className="block text-xs text-ink-muted">
              Don&apos;t (one per line)
              <textarea className="mt-1 w-full border border-border bg-surface-raised px-3 py-2 text-sm" rows={3} value={form.donts} onChange={(e) => setForm({ ...form, donts: e.target.value })} />
            </label>
          </div>
          <label className="block text-xs text-ink-muted">
            Competitors (comma separated)
            <Input className="mt-1" value={form.competitors} onChange={(e) => setForm({ ...form, competitors: e.target.value })} />
          </label>
          <div className="flex gap-2">
            <Button type="submit" className="px-3 py-1.5 text-xs" disabled={!!busy}>
              {busy ? "Saving…" : "Save kit"}
            </Button>
            <Button type="button" variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {kit.colours.length ? (
              kit.colours.map((c) => (
                <span key={c} className="flex items-center gap-1.5 text-xs tabular-nums text-ink-muted" title={c}>
                  <span className="inline-block h-6 w-6 border border-border" style={{ background: c }} />
                  {c}
                </span>
              ))
            ) : (
              <span className="text-xs text-ink-muted">No colours saved yet.</span>
            )}
          </div>
          <p className="mt-3 text-xs text-ink-muted">
            Fonts: <span className="text-ink">{kit.fonts.join(" · ") || "—"}</span>
          </p>
          {kit.notes && <p className="mt-2 text-xs leading-relaxed text-ink">{kit.notes}</p>}
          {kit.tone && (
            <p className="mt-2 text-xs text-ink-muted">
              Tone: <span className="text-ink">{kit.tone}</span>
            </p>
          )}
          {(!!kit.dos?.length || !!kit.donts?.length) && (
            <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
              {!!kit.dos?.length && (
                <ul className="space-y-0.5">
                  {kit.dos.map((d) => (
                    <li key={d} className="text-ink">
                      <span className="text-green">✓</span> {d}
                    </li>
                  ))}
                </ul>
              )}
              {!!kit.donts?.length && (
                <ul className="space-y-0.5">
                  {kit.donts.map((d) => (
                    <li key={d} className="text-ink">
                      <span className="text-red">✗</span> {d}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {!!kit.competitors?.length && (
            <p className="mt-2 text-xs text-ink-muted">
              Competitors: <span className="text-ink">{kit.competitors.join(" · ")}</span>
            </p>
          )}
        </>
      )}
      <div className="mt-3 border-t border-border pt-3">
        <p className="mb-2 text-[11px] uppercase tracking-[0.1em] text-ink-muted">Brand files</p>
        <ul className="flex flex-wrap gap-2">
          {kit.files.map((f) => (
            <li key={f.id}>
              <a href={f.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 border border-border px-2 py-1 text-xs hover:border-ink">
                {f.kind === "image" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={f.url} alt="" className="h-6 w-6 object-cover" />
                ) : (
                  <span className="inline-block h-6 w-6 bg-canvas text-center leading-6 text-[10px] text-ink-muted">{f.kind === "link" ? "↗" : "FILE"}</span>
                )}
                <span className="max-w-[160px] truncate">{f.name}</span>
              </a>
            </li>
          ))}
          {!kit.files.length && <li className="text-xs text-ink-muted">No brand files yet.</li>}
        </ul>
        {!readOnly && (
          <>
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              data-brand-upload={kit.clientId}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                const saved = await run("file", () => api.craft.uploadBrandFile(kit.clientId, f, f.name));
                if (saved) setKit(saved);
                e.target.value = "";
              }}
            />
            <button className="mt-2 text-xs text-ink-muted underline-offset-2 hover:text-ink hover:underline" disabled={!!busy} onClick={() => fileRef.current?.click()}>
              {busy === "file" ? "Uploading…" : "+ Add brand file"}
            </button>
          </>
        )}
      </div>
      <ErrorLine error={error} />
    </div>
  );
}
