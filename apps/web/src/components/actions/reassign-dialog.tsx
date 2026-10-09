"use client";

/**
 * ReassignDialog: the reassignment engine's UI for any registered record type (task, deliverable, qc, and whatever
 * other areas register: lead, client_am, request, creator_brief, engagement…). Candidate list with load %, leave,
 * active tasks and skills → impact preview → deadline handling (keep / extend N working days / set new) → reason +
 * note → handover note when work has started. Over 120% or leave → sent for Department Head approval.
 *
 * Usually opened through the provider: `useActions().openReassign({ type: "task", ids: [id] })`.
 * BulkReassignDialog moves all of one person's open work to another person (or splits it), with preview.
 */
import { useEffect, useMemo, useState } from "react";
import { coreReassignReasonLabels, type CoreCandidates, type CoreOpenWork, type CoreReassignPreview, type CoreReassignResult, type CoreReassignReason } from "@bmu/shared";
import { api } from "@/lib/api";
import { ActionDrawer, Field, TextArea, inputCls } from "./action-drawer";
import { PersonPicker } from "./person-picker";

const lineTone = { info: "text-ink-muted", warning: "text-ink bg-amber/25 px-2 py-1", approval: "text-ink bg-canvas px-2 py-1 border border-border", blocked: "text-ink bg-red/15 px-2 py-1" } as const;
const day = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });

export function ReassignDialog({ type, ids, open, onClose, onDone, initialToUserId, title }: { type: string; ids: string[]; open: boolean; onClose: () => void; onDone: (r: CoreReassignResult) => void; initialToUserId?: string; title?: string }) {
  const [data, setData] = useState<CoreCandidates>();
  const [loadError, setLoadError] = useState<string>();
  const [toUserId, setToUserId] = useState<string | undefined>(initialToUserId);
  const [mode, setMode] = useState<"keep" | "extend" | "set">("keep");
  const [days, setDays] = useState("2");
  const [date, setDate] = useState("");
  const [reason, setReason] = useState<CoreReassignReason | "">("");
  const [note, setNote] = useState("");
  const [handover, setHandover] = useState("");
  const [override, setOverride] = useState(false);
  const [role, setRole] = useState<string>();
  const [preview, setPreview] = useState<CoreReassignPreview>();
  const [previewError, setPreviewError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const key = ids.join(",");

  useEffect(() => {
    if (!open) return;
    let live = true;
    api.actions.reassign
      .candidates(type, ids, role ? { role } : {})
      .then((d) => {
        if (!live) return;
        setData(d);
        setLoadError(undefined);
        if (!role && d.roles.length) setRole(d.roles[0].key);
      })
      .catch((e: Error) => live && setLoadError(e.message));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, type, key, role]);

  const deadline = useMemo(() => (mode === "keep" ? { mode } : mode === "extend" ? { mode, days: Math.max(1, Number(days) || 1) } : date ? { mode, date } : null), [mode, days, date]);

  useEffect(() => {
    if (!open || !toUserId || !deadline) return;
    let live = true;
    const t = setTimeout(() => {
      api.actions.reassign
        .preview(type, { ids, toUserId, deadline, role })
        .then((p) => {
          if (!live) return;
          setPreview(p);
          setPreviewError(undefined);
        })
        .catch((e: Error) => live && setPreviewError(e.message));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, toUserId, deadline, type, key, role]);

  const shownPreview = preview && preview.to.id === toUserId ? preview : undefined;
  const leaveBlocked = !!shownPreview?.blocked && /leave/.test(shownPreview.blocked);

  async function submit() {
    setError(undefined);
    if (!toUserId) return setError("Pick the new owner");
    if (!reason) return setError("Pick a reason");
    if (!deadline) return setError("Pick the new deadline");
    if (reason === "other" && note.trim().length < 3) return setError("Say a little more about the reason");
    if (shownPreview?.needsHandover && handover.trim().length < 3) return setError("Add a handover note: the work has already started");
    setSaving(true);
    try {
      const r = await api.actions.reassign.apply(type, { ids, toUserId, reason, note: note.trim() || undefined, handoverNote: handover.trim() || undefined, deadline, overrideLeave: override || undefined, role });
      onDone(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const items = data?.items ?? [];
  return (
    <ActionDrawer
      open={open}
      title={title ?? (items.length > 1 ? `Reassign ${items.length} ${data?.label.toLowerCase() ?? "item"}s` : `Reassign ${data?.label.toLowerCase() ?? ""}`.trim())}
      subtitle={items.length === 1 ? `${items[0].title}${items[0].ownerName ? ` · now with ${items[0].ownerName}` : " · unassigned"}` : items.length ? items.map((i) => i.title).slice(0, 3).join(", ") + (items.length > 3 ? "…" : "") : undefined}
      onClose={onClose}
      onSubmit={submit}
      saving={saving}
      error={error ?? loadError}
      saveLabel={shownPreview?.needsApproval ? "Send for approval" : "Reassign"}
      testId="reassign-dialog"
    >
      {!data && !loadError && <p className="text-sm text-ink-muted">Loading people…</p>}
      {data && (
        <>
          {data.roles.length > 0 && (
            <Field label="Which seat" required>
              <select className={inputCls} value={role} onChange={(e) => { setRole(e.target.value); setPreview(undefined); }} aria-label="Which seat">
                {data.roles.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.label}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="New owner" required hint="Load is this week's open work against their capacity, after this change.">
            <PersonPicker candidates={data.candidates} value={toUserId} onChange={(id) => { setToUserId(id); setOverride(false); }} />
          </Field>
          <Field label="Deadline" required>
            <div className="grid gap-2">
              <div className="flex flex-wrap gap-3 text-sm">
                {(["keep", "extend", "set"] as const).map((m) => (
                  <label key={m} className="flex items-center gap-1.5">
                    <input type="radio" name="deadline-mode" checked={mode === m} onChange={() => setMode(m)} />
                    {m === "keep" ? "Keep" : m === "extend" ? "Extend by" : "Set new date"}
                  </label>
                ))}
              </div>
              {mode === "extend" && (
                <span className="flex items-center gap-2 text-sm">
                  <input className={`${inputCls} w-20`} type="number" min={1} max={60} value={days} onChange={(e) => setDays(e.target.value)} aria-label="Working days to extend" />
                  working days
                </span>
              )}
              {mode === "set" && <input className={`${inputCls} w-48`} type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="New deadline" />}
            </div>
          </Field>
          <Field label="Reason" required>
            <select className={inputCls} value={reason} onChange={(e) => setReason(e.target.value as CoreReassignReason)} aria-label="Reason">
              <option value="">Pick a reason…</option>
              {data.reasons.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label={reason === "other" ? "Note (required for Other)" : "Note (optional)"}>
            <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} aria-label="Note" />
          </Field>
          {(shownPreview?.needsHandover || items.some((i) => i.inProgress)) && (
            <Field label="Handover note" required hint="What the new owner needs to know: where the files are, what is left, who to ask.">
              <TextArea value={handover} onChange={(e) => setHandover(e.target.value)} aria-label="Handover note" />
            </Field>
          )}
          {toUserId && (
            <div className="border border-border p-3" aria-live="polite" data-testid="reassign-impact">
              <p className="mb-1.5 text-xs font-medium uppercase tracking-[0.1em] text-ink-muted">Impact</p>
              {previewError && <p className="text-sm text-red">{previewError}</p>}
              {!shownPreview && !previewError && <p className="text-sm text-ink-muted">Checking…</p>}
              {shownPreview && (
                <div className="space-y-1.5 text-sm">
                  {shownPreview.blocked && <p className={lineTone.blocked}>{shownPreview.blocked}</p>}
                  {shownPreview.impact.map((l, i) => (
                    <p key={i} className={lineTone[l.level]}>
                      {l.text}
                    </p>
                  ))}
                  {shownPreview.items.some((i) => i.deadlineFrom !== i.deadlineTo) && (
                    <ul className="text-xs text-ink-muted">
                      {shownPreview.items.slice(0, 5).map((i) => (
                        <li key={i.id}>
                          {i.title}: {i.deadlineFrom ? day.format(new Date(i.deadlineFrom)) : "no deadline"} → {i.deadlineTo ? day.format(new Date(i.deadlineTo)) : "no deadline"}
                        </li>
                      ))}
                    </ul>
                  )}
                  {leaveBlocked && data.canOverrideLeave && (
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} /> Override leave (Department Head)
                    </label>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </ActionDrawer>
  );
}

/** Move all open work from one person to another, or split it across several, with a preview. */
export function BulkReassignDialog({ fromUserId, open, onClose, onDone }: { fromUserId: string; open: boolean; onClose: () => void; onDone: (r: CoreReassignResult) => void }) {
  const [work, setWork] = useState<CoreOpenWork>();
  const [loadError, setLoadError] = useState<string>();
  const [all, setAll] = useState<string>("");
  const [split, setSplit] = useState<Record<string, string>>({});
  const [reason, setReason] = useState<CoreReassignReason | "">("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!open) return;
    let live = true;
    api.actions.reassign
      .openWork(fromUserId)
      .then((w) => live && setWork(w))
      .catch((e: Error) => live && setLoadError(e.message));
    return () => {
      live = false;
    };
  }, [open, fromUserId]);
  const items = (work?.groups ?? []).flatMap((g) => g.items.map((i) => ({ ...i, type: g.type, label: g.label })));
  const target = (key: string) => split[key] || all;
  const people = work?.candidates.filter((c) => !c.blockedReason) ?? [];
  const counts = new Map<string, number>();
  for (const i of items) {
    const t = target(`${i.type}:${i.id}`);
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  async function submit() {
    setError(undefined);
    if (!reason) return setError("Pick a reason");
    const missing = items.filter((i) => !target(`${i.type}:${i.id}`));
    if (missing.length) return setError(`Pick who takes ${missing.length === items.length ? "the work" : `the remaining ${missing.length} item(s)`}`);
    const moves = new Map<string, { type: string; id: string }[]>();
    for (const i of items) {
      const t = target(`${i.type}:${i.id}`);
      moves.set(t, [...(moves.get(t) ?? []), { type: i.type, id: i.id }]);
    }
    setSaving(true);
    try {
      onDone(await api.actions.reassign.bulk({ fromUserId, reason, note: note.trim() || undefined, moves: [...moves].map(([toUserId, its]) => ({ toUserId, items: its })) }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <ActionDrawer open={open} title={work ? `Move ${work.user.name}'s open work` : "Move open work"} subtitle="Everything they own moves to one person, or pick a person per item to split it." onClose={onClose} onSubmit={items.length ? submit : undefined} saving={saving} error={error ?? loadError} saveLabel={`Move ${items.length} item${items.length === 1 ? "" : "s"}`} wide testId="bulk-reassign-dialog">
      {!work && !loadError && <p className="text-sm text-ink-muted">Loading…</p>}
      {work && items.length === 0 && <p className="text-sm text-ink-muted">{work.user.name} owns no open work.</p>}
      {work && items.length > 0 && (
        <>
          <Field label="Move everything to" hint="Change single rows below to split the work.">
            <select className={inputCls} value={all} onChange={(e) => setAll(e.target.value)} aria-label="Move everything to">
              <option value="">Pick a person…</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.loadPct}% load{p.onLeaveToday ? " · on leave today" : ""}
                </option>
              ))}
            </select>
          </Field>
          <div className="border border-border">
            {work.groups.map((g) => (
              <div key={g.type}>
                <p className="border-b border-border bg-canvas/50 px-3 py-1.5 text-xs font-medium uppercase tracking-[0.1em] text-ink-muted">
                  {g.label}s ({g.items.length})
                </p>
                {g.items.map((i) => (
                  <div key={i.id} className="grid gap-1 border-b border-border px-3 py-2 text-sm last:border-b-0 sm:grid-cols-[1fr_200px] sm:items-center">
                    <span className="min-w-0">
                      <span className="block truncate">{i.title}</span>
                      <span className="text-xs text-ink-muted">{[i.client, i.deadline ? `due ${day.format(new Date(i.deadline))}` : null].filter(Boolean).join(" · ")}</span>
                    </span>
                    <select className={`${inputCls} py-1 text-xs`} value={split[`${g.type}:${i.id}`] ?? ""} onChange={(e) => setSplit((s) => ({ ...s, [`${g.type}:${i.id}`]: e.target.value }))} aria-label={`Who takes ${i.title}`}>
                      <option value="">{all ? `Same as above` : "Pick…"}</option>
                      {people.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            ))}
          </div>
          {counts.size > 0 && (
            <div className="border border-border p-3 text-sm" data-testid="bulk-preview">
              <p className="mb-1 text-xs font-medium uppercase tracking-[0.1em] text-ink-muted">Preview</p>
              {[...counts].map(([id, n]) => {
                const p = work.candidates.find((c) => c.id === id);
                const after = p ? Math.round(((p.hoursOpen + n * 4) / Math.max(1, p.capacityHours)) * 100) : 0;
                return (
                  <p key={id} className={after > 100 ? "text-red" : ""}>
                    {p?.name}: {n} item{n === 1 ? "" : "s"} · load {p?.loadPct}% → about {after}%{after > 120 ? " (needs Department Head approval: split differently)" : ""}
                  </p>
                );
              })}
            </div>
          )}
          <Field label="Reason" required>
            <select className={inputCls} value={reason} onChange={(e) => setReason(e.target.value as CoreReassignReason)} aria-label="Reason">
              <option value="">Pick a reason…</option>
              {Object.entries(coreReassignReasonLabels).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Note / handover">
            <TextArea value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
          </Field>
        </>
      )}
    </ActionDrawer>
  );
}
