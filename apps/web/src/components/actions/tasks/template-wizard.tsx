"use client";

/**
 * TemplateWizard: create a set of tasks from a department flow template. Pick the template, client and start date →
 * map each role to a person (load shown) → preview every task with its deadline → create (with Undo).
 * RecurringList: the recurring task rules the person can see, with the next dates and a Stop button.
 */
import { useEffect, useState } from "react";
import type { CoreRecurrence, CoreTaskFormOptions, CoreTemplatePreview, CoreUndo } from "@bmu/shared";
import { api } from "@/lib/api";
import { ActionDrawer, Field, inputCls } from "../action-drawer";

const todayIst = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const day = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" });

export function TemplateWizard({ open, onClose, onDone, engagementId: initialEng }: { open: boolean; onClose: () => void; onDone: (message: string, undo: CoreUndo | null) => void; engagementId?: string }) {
  const [opts, setOpts] = useState<CoreTaskFormOptions>();
  const [templateId, setTemplateId] = useState("");
  const [engagementId, setEngagementId] = useState(initialEng ?? "");
  const [startDate, setStartDate] = useState(todayIst());
  const [people, setPeople] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<CoreTemplatePreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    api.coreTasks.formOptions().then(setOpts, (e: Error) => setError(e.message));
  }, [open]);

  useEffect(() => {
    if (!templateId) return;
    let live = true;
    const t = setTimeout(() => {
      api.coreTasks
        .templatePreview({ templateId, engagementId: engagementId || null, startDate, people })
        .then((p) => {
          if (!live) return;
          setPreview(p);
          setError(undefined);
        })
        .catch((e: Error) => live && setError(e.message));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [templateId, engagementId, startDate, people]);

  async function submit() {
    if (!templateId) return setError("Pick a template");
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.coreTasks.fromTemplate({ templateId, engagementId: engagementId || null, startDate, people });
      onDone(r.message, r.undo);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ActionDrawer open={open} title="Tasks from a template" subtitle="Creates every step of a department flow, with owners and deadlines worked out from working days." onClose={onClose} onSubmit={submit} saving={busy} error={error} saveLabel={preview ? `Create ${preview.tasks.length} tasks` : "Create tasks"} wide testId="template-wizard">
      <Field label="Template" required>
        <select className={inputCls} value={templateId} onChange={(e) => setTemplateId(e.target.value)} aria-label="Template">
          <option value="">{opts ? "Pick a template…" : "Loading…"}</option>
          {opts?.templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.department ? ` · ${t.department}` : ""} ({t.steps} steps)
            </option>
          ))}
        </select>
      </Field>
      {opts && !opts.templates.length && <p className="text-xs text-ink-muted">No templates yet. Branch Managers add them in Command Centre → Templates.</p>}
      <Field label="Client engagement" hint="Leave empty for internal work.">
        <select className={inputCls} value={engagementId} onChange={(e) => setEngagementId(e.target.value)} aria-label="Client engagement">
          <option value="">Internal</option>
          {opts?.engagements.map((e) => (
            <option key={e.id} value={e.id}>
              {e.client} · {e.service}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Start date" required>
        <input className={inputCls} type="date" value={startDate} min={todayIst()} onChange={(e) => setStartDate(e.target.value)} aria-label="Start date" />
      </Field>
      {preview && (
        <>
          {preview.roles.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium">Who does each role</p>
              {preview.roles.map((r) => (
                <label key={r.role} className="flex items-center justify-between gap-2 text-sm">
                  <span>{r.label}</span>
                  <select
                    className="w-56 border border-border bg-surface-raised px-2 py-1 text-sm"
                    value={people[r.role] ?? r.userId ?? ""}
                    onChange={(e) => setPeople((p) => ({ ...p, [r.role]: e.target.value }))}
                    aria-label={`Person for ${r.label}`}
                  >
                    <option value="">Nobody yet</option>
                    {r.options.map((o) => (
                      <option key={o.id} value={o.id} disabled={!!o.blockedReason}>
                        {o.name} · {o.loadPct >= 999 ? "on leave" : `${o.loadPct}%`}
                        {o.onLeave ? " · on leave on a deadline" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          )}
          {preview.warnings.map((w) => (
            <p key={w} className="bg-amber/20 px-2 py-1 text-xs">
              {w}
            </p>
          ))}
          <table className="w-full text-xs" data-testid="template-preview">
            <thead>
              <tr className="text-left text-ink-muted">
                <th className="py-1 pr-2 font-normal">Task</th>
                <th className="py-1 pr-2 font-normal">Owner</th>
                <th className="py-1 font-normal">Due</th>
              </tr>
            </thead>
            <tbody>
              {preview.tasks.map((t) => (
                <tr key={t.step} className="border-t border-border align-top">
                  <td className="py-1 pr-2">{t.title}</td>
                  <td className="py-1 pr-2">{t.ownerName ?? <span className="text-ink-muted">Unassigned</span>}</td>
                  <td className="py-1 whitespace-nowrap">{day.format(new Date(t.deadline))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </ActionDrawer>
  );
}

export function RecurringList({ onChanged }: { onChanged?: () => void }) {
  const [rows, setRows] = useState<CoreRecurrence[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    api.coreTasks.recurring().then(setRows, (e: Error) => setError(e.message));
  }, []);
  async function stop(r: CoreRecurrence) {
    if (!window.confirm(`Stop "${r.title}"? Tasks already created stay.`)) return;
    try {
      setRows(await api.coreTasks.stopRecurring(r.id));
      onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (error) return <p className="text-sm text-red">{error}</p>;
  if (!rows) return <p className="text-sm text-ink-muted">Loading…</p>;
  if (!rows.length) return <p className="border border-border bg-surface-raised px-4 py-6 text-center text-sm text-ink-muted">No recurring tasks. Pick “Repeat” when you add a task.</p>;
  return (
    <ul className="grid gap-2" data-testid="recurring-list">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-wrap items-start justify-between gap-2 border border-border bg-surface-raised px-4 py-3 text-sm">
          <div className="min-w-0">
            <p className="font-medium">{r.title}</p>
            <p className="text-xs text-ink-muted">
              {r.ruleLabel}
              {r.owner ? ` · ${r.owner}` : ""}
              {r.endDate ? ` · until ${day.format(new Date(r.endDate))}` : ""}
              {!r.active && " · stopped"}
            </p>
            {r.active && r.nextDates.length > 0 && <p className="text-xs">Next: {r.nextDates.slice(0, 3).map((d) => day.format(new Date(d))).join(", ")}</p>}
          </div>
          {r.active && (
            <button type="button" className="border border-border px-2 py-1 text-xs" onClick={() => stop(r)}>
              Stop
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
