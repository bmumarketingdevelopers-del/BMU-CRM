"use client";

import { useEffect, useState } from "react";
import { ERROR_CAUSES, errorCauseLabels, type ErrorCause, type ErrorLogInput, type ErrorLogList, type ErrorLogView } from "@bmu/shared";
import { BarList, Column, DataTable, Grid, Panel, StatRow, StatTile } from "@/components/dash";
import { Badge, Button, Input, LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { Field, Message, Textarea, type Msg } from "../_platform/kit";

const causeLabel = (c: string | null) => (c && c in errorCauseLabels ? errorCauseLabels[c as ErrorCause] : "Not decided yet");
const day = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const empty: ErrorLogInput = { what: "", why: "", foundBy: "", impact: "", fix: "", prevention: "", cause: null };

export default function ErrorLogPage() {
  const [q, setQ] = useState("");
  const [cause, setCause] = useState("");
  const [data, setData] = useState<ErrorLogList>();
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<{ id?: string; input: ErrorLogInput }>();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api.adminPlatform
        .errors({ q, cause })
        .then((d) => live && (setData(d), setError(undefined)))
        .catch((e: Error) => live && setError(e.message));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, cause, tick]);

  const open = (r: ErrorLogView) => setEditing({ id: r.id, input: { what: r.what, why: r.why ?? "", foundBy: r.foundBy ?? "", impact: r.impact ?? "", fix: r.fix ?? "", prevention: r.prevention ?? "", cause: (r.cause as ErrorCause) ?? null } });

  const columns: Column<ErrorLogView>[] = [
    {
      key: "what",
      header: "What went wrong",
      cell: (r) => (
        <button className="text-left font-medium hover:underline" onClick={() => open(r)}>
          {r.what}
        </button>
      ),
    },
    { key: "cause", header: "Root cause", cell: (r) => <span className="whitespace-nowrap text-ink-muted">{causeLabel(r.cause)}</span> },
    { key: "found", header: "Found by", cell: (r) => <span className="whitespace-nowrap">{r.foundBy ?? "—"}</span> },
    { key: "prevention", header: "Prevention", cell: (r) => (r.prevention?.trim() ? <Badge tone="green">In place</Badge> : <Badge tone="amber">Needed</Badge>) },
    { key: "date", header: "Logged", align: "right", cell: (r) => <span className="whitespace-nowrap">{day.format(new Date(r.createdAt))}</span> },
  ];

  return (
    <>
      <PageTitle
        title="Error Log"
        subtitle="Mistakes we caught, why they happened and what we changed so they don't happen again. Anyone on the team can log one; leadership reviews and edits."
        action={!editing ? <Button onClick={() => setEditing({ input: { ...empty } })}>Log an error</Button> : undefined}
      />
      {!data ? (
        <LoadState loading={!error} error={error} />
      ) : (
        <div className="space-y-6">
          <StatRow cols={3}>
            <StatTile label="Errors logged" value={data.total} />
            <StatTile label="Waiting for a prevention step" value={data.open} tone={data.open ? "warn" : "good"} hint={data.open ? "add what changes so it can't repeat" : "every error has a fix in place"} />
            <StatTile label="Most common cause" value={<span className="text-xl">{data.stats[0] ? causeLabel(data.stats[0].cause === "none" ? null : data.stats[0].cause) : "—"}</span>} hint={data.stats[0] ? `${data.stats[0].count} of ${data.total}` : undefined} />
          </StatRow>

          {editing && (
            <ErrorForm
              key={editing.id ?? "new"}
              id={editing.id}
              initial={editing.input}
              readOnly={!!editing.id && !data.canEdit}
              onClose={() => setEditing(undefined)}
              onSaved={() => {
                setEditing(undefined);
                setTick((x) => x + 1);
              }}
            />
          )}

          <Grid cols={3}>
            <div className="min-w-0 lg:col-span-2">
              <Panel
                flush
                title="All entries"
                action={
                  <div className="flex flex-wrap gap-2">
                    <Input className="w-48! py-1.5" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search errors" />
                    <Select value={cause} onChange={(e) => setCause(e.target.value)} aria-label="Root cause">
                      <option value="">All causes</option>
                      {ERROR_CAUSES.map((c) => (
                        <option key={c} value={c}>
                          {errorCauseLabels[c]}
                        </option>
                      ))}
                      <option value="none">Not decided yet</option>
                    </Select>
                  </div>
                }
              >
                <DataTable rows={data.rows} columns={columns} rowKey={(r) => r.id} empty={q || cause ? "No entries match these filters." : "No errors logged yet. That's either great news or nobody is logging them."} />
              </Panel>
            </div>
            <Panel title="By root cause" subtitle="Where to fix the system, not the person">
              <BarList items={data.stats.map((s, i) => ({ label: causeLabel(s.cause === "none" ? null : s.cause), value: s.count, highlight: i === 0 }))} />
            </Panel>
          </Grid>
        </div>
      )}
    </>
  );
}

function ErrorForm({ id, initial, readOnly, onClose, onSaved }: { id?: string; initial: ErrorLogInput; readOnly: boolean; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>();
  const set = (k: keyof ErrorLogInput, v: string) => setF({ ...f, [k]: v });

  async function save() {
    setBusy(true);
    setMsg(undefined);
    try {
      const input = { ...f, cause: f.cause || null };
      if (id) await api.adminPlatform.updateError(id, input);
      else await api.adminPlatform.createError(input);
      onSaved();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
      setBusy(false);
    }
  }

  const steps: { k: keyof ErrorLogInput; label: string; hint: string }[] = [
    { k: "why", label: "2. Why did it happen?", hint: "Keep asking “why” until you reach the real reason (up to five times)." },
    { k: "impact", label: "3. What was the impact?", hint: "Who was affected, time lost, money, client mood." },
    { k: "fix", label: "4. How was it fixed?", hint: "What we did to put it right this time." },
    { k: "prevention", label: "5. What stops it happening again?", hint: "A change to a checklist, SOP, tool or habit." },
  ];

  return (
    <Panel title={id ? (readOnly ? "Error details" : "Edit error") : "Log an error"} subtitle={readOnly ? "Only the Founder, an Admin or a department head can edit entries." : "Five quick questions. Be specific and blame the process, not people."}>
      <fieldset disabled={readOnly || busy} className="space-y-4">
        <div className="grid gap-4 md:grid-cols-[1fr_220px_220px]">
          <Field label="1. What went wrong?">
            <Input value={f.what} onChange={(e) => set("what", e.target.value)} placeholder="e.g. Wrong price on a client post" />
          </Field>
          <Field label="Found by" hint={id ? undefined : "Leave empty to use your name"}>
            <Input value={f.foundBy ?? ""} onChange={(e) => set("foundBy", e.target.value)} placeholder="Name or “Client”" />
          </Field>
          <Field label="Root cause">
            <Select className="w-full py-2" value={f.cause ?? ""} onChange={(e) => set("cause", e.target.value)}>
              <option value="">Not decided yet</option>
              {ERROR_CAUSES.map((c) => (
                <option key={c} value={c}>
                  {errorCauseLabels[c]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {steps.map((s) => (
            <Field key={s.k} label={s.label} hint={s.hint}>
              <Textarea rows={3} value={(f[s.k] as string) ?? ""} onChange={(e) => set(s.k, e.target.value)} />
            </Field>
          ))}
        </div>
      </fieldset>
      <div className="mt-5 space-y-3">
        <Message msg={msg} />
        <div className="flex gap-3">
          {!readOnly && (
            <Button disabled={busy} onClick={save}>
              {busy ? "Saving…" : id ? "Save changes" : "Log error"}
            </Button>
          )}
          <Button variant={readOnly ? "secondary" : "ghost"} disabled={busy} onClick={onClose}>
            {readOnly ? "Close" : "Cancel"}
          </Button>
        </div>
      </div>
    </Panel>
  );
}
