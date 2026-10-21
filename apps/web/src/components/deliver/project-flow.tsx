"use client";

// v40 project flow on the project page:
// - Client Manager: ask Department Heads for their finish date, then share the dates with the client.
// - Department Head: give the finish date (after talking to the team); share each big finished part with the client
//   as a demo link or files. The client approves it or asks for changes (a task for the head).
import Link from "next/link";
import { useState } from "react";
import { estimateStatusLabels, milestoneStatusLabels, type EstimateInboxRow, type MilestoneFile, type ProjectEstimateRow, type ProjectFlowView, type SentFile } from "@bmu/shared";
import { Panel } from "@/components/dash";
import { PendingFiles, SendFileControls } from "@/components/sent-files";
import { Badge, Button, Input, LoadState, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const day = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
const fmt = (iso: string) => day.format(new Date(iso.length === 10 ? `${iso}T00:00:00+05:30` : iso));
const estTone = { waiting: "amber", estimated: "neutral", shared: "green" } as const;
const msTone = { shared: "amber", approved: "green", changes_requested: "red" } as const;
const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

export function MilestoneFiles({ files }: { files: MilestoneFile[] }) {
  return (
    <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {files.map((f) => (
        <li key={f.id}>
          <a href={f.url} target="_blank" rel="noreferrer noopener" className="underline">
            {f.kind === "link" ? "🔗" : "📎"} {f.name}
          </a>
        </li>
      ))}
    </ul>
  );
}

/** Department Head: give the finish date for one request. */
function GiveDate({ row, onDone }: { row: ProjectEstimateRow; onDone: (v: ProjectFlowView) => void }) {
  const [date, setDate] = useState(row.finishBy ?? "");
  const [note, setNote] = useState(row.headNote ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const save = async () => {
    if (!date) return setError("Pick the finish date");
    setBusy(true);
    setError(undefined);
    try {
      onDone(await api.projectFlow.submitEstimate(row.id, { finishBy: date, note: note.trim() || undefined }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-2 grid gap-2 border border-border bg-canvas/30 p-3 text-sm sm:grid-cols-[12rem_1fr_auto]" data-testid="estimate-form">
      <Input type="date" min={today()} value={date} onChange={(e) => setDate(e.target.value)} aria-label="Finish date" />
      <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder="Note for the Client Manager (what the date covers, what you need)" aria-label="Note" />
      <Button disabled={busy} onClick={save} data-testid="estimate-save">
        {busy ? "Saving…" : row.finishBy ? "Change date" : "Give date"}
      </Button>
      {error && <p className="text-sm text-red sm:col-span-3">{error}</p>}
    </div>
  );
}

function Estimates({ v, onChange }: { v: ProjectFlowView; onChange: (v: ProjectFlowView) => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const run = async (fn: () => Promise<ProjectFlowView>, ok: string) => {
    setBusy(true);
    setMsg(undefined);
    try {
      onChange(await fn());
      setMsg({ ok: true, text: ok });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const unshared = v.estimates.filter((e) => e.status === "estimated");
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-muted">Finish dates</h3>
      {v.estimates.length ? (
        <ul className="mt-1 divide-y divide-border" data-testid="estimates">
          {v.estimates.map((e) => (
            <li key={e.id} className="py-2 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <span className="font-medium">{e.department.name}</span>
                  <span className="text-xs text-ink-muted">{e.head ? ` · Head: ${e.head.name}` : ""}{e.requestedBy ? ` · asked by ${e.requestedBy} ${fmt(e.requestedAt)}` : ""}</span>
                  {e.finishBy && <p className="text-sm">Finish by <strong>{fmt(e.finishBy)}</strong></p>}
                  {e.headNote && <p className="text-xs text-ink-muted">{e.headNote}</p>}
                  {e.requestNote && !e.finishBy && <p className="border-l-2 border-border pl-2 text-xs">{e.requestNote}</p>}
                </div>
                <span className="flex items-center gap-2">
                  <Badge tone={estTone[e.status]}>{estimateStatusLabels[e.status]}</Badge>
                  {e.can.estimate && (
                    <Button variant="secondary" onClick={() => setOpen(open === e.id ? undefined : e.id)} data-testid="estimate-open">
                      {open === e.id ? "Close" : e.finishBy ? "Change date" : "Give date"}
                    </Button>
                  )}
                  {e.can.share && e.status === "estimated" && (
                    <Button variant="secondary" disabled={busy} onClick={() => run(() => api.projectFlow.shareEstimates(v.engagementId, [e.id]), "Shared with the client.")} data-testid="estimate-share">
                      Share with client
                    </Button>
                  )}
                </span>
              </div>
              {open === e.id && <GiveDate row={e} onDone={(x) => (onChange(x), setOpen(undefined))} />}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-sm text-ink-muted">No dates asked for yet.</p>
      )}
      {v.can.request && unshared.length > 1 && (
        <div className="mt-2">
          <Button disabled={busy} onClick={() => run(() => api.projectFlow.shareEstimates(v.engagementId, unshared.map((e) => e.id)), "Dates shared with the client.")}>
            Share all {unshared.length} dates with the client
          </Button>
        </div>
      )}
      {v.can.request && (
        <div className="mt-3 space-y-2 border border-border bg-canvas/30 p-3 text-sm" data-testid="estimate-request">
          <p className="text-xs font-medium">Ask Department Heads when they will finish</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {v.departments.map((d) => (
              <label key={d.id} className="flex items-center gap-1.5">
                <input type="checkbox" checked={picked.includes(d.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, d.id] : picked.filter((x) => x !== d.id))} aria-label={`Ask ${d.name}`} />
                {d.name}
                {d.head ? <span className="text-xs text-ink-muted">({d.head.name})</span> : null}
              </label>
            ))}
          </div>
          <textarea className="h-20 w-full border border-border bg-surface-raised p-2" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder="What the client needs: scope, pages or deliverables, any deadline they mentioned." aria-label="What the client needs" />
          <Button
            disabled={busy || !picked.length}
            onClick={() =>
              run(async () => {
                const r = await api.projectFlow.requestEstimates(v.engagementId, { departmentIds: picked, note: note.trim() || undefined });
                setPicked([]);
                setNote("");
                return r;
              }, "Asked. The Department Heads were told.")
            }
            data-testid="estimate-request-send"
          >
            Ask {picked.length || ""} Department Head{picked.length === 1 ? "" : "s"}
          </Button>
        </div>
      )}
      {msg && <p className={`mt-2 text-xs ${msg.ok ? "text-green" : "text-red"}`}>{msg.text}</p>}
    </div>
  );
}

/** Department Head: share a big finished part (login page, product design, first video draft) with the client. */
function ShareMilestone({ v, onDone }: { v: ProjectFlowView; onDone: (v: ProjectFlowView) => void }) {
  const [dept, setDept] = useState(v.can.shareFor[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [files, setFiles] = useState<SentFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const share = async () => {
    if (!title.trim()) return setError("Name the part that is done, e.g. Login page");
    if (!files.length) return setError("Add a demo link or a file for the client");
    setBusy(true);
    setError(undefined);
    try {
      onDone(await api.projectFlow.shareMilestone(v.engagementId, { departmentId: dept, title: title.trim(), note: note.trim() || undefined, fileIds: files.map((f) => f.id) }));
      setTitle("");
      setNote("");
      setFiles([]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-3 space-y-2 border border-border bg-canvas/30 p-3 text-sm" data-testid="milestone-share">
      <p className="text-xs font-medium">A big part is done? Share it with the client</p>
      <div className="grid gap-2 sm:grid-cols-[12rem_1fr]">
        {v.can.shareFor.length > 1 ? (
          <Select value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department">
            {v.can.shareFor.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        ) : (
          <span className="self-center text-xs text-ink-muted">{v.can.shareFor[0]?.name}</span>
        )}
        <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} placeholder="What is done, e.g. Login page, Product design, First draft of the video" aria-label="What is done" />
      </div>
      <textarea className="h-16 w-full border border-border bg-surface-raised p-2" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder="What the client should look at or try" aria-label="Note for the client" />
      <PendingFiles files={files} onRemove={(id) => setFiles((x) => x.filter((f) => f.id !== id))} />
      <SendFileControls label="📎 Add demo files" limit={20 - files.length} upload={(f) => api.projectFlow.stageFile(v.engagementId, f)} addLink={(url) => api.projectFlow.stageLink(v.engagementId, { url })} onAdded={(f) => setFiles((x) => [...x, f])} />
      {error && <p className="text-sm text-red">{error}</p>}
      <Button disabled={busy} onClick={share} data-testid="milestone-share-send">
        {busy ? "Sharing…" : "Share with the client"}
      </Button>
    </div>
  );
}

function Milestones({ v, onChange }: { v: ProjectFlowView; onChange: (v: ProjectFlowView) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-5">
      <h3 className="flex items-center justify-between text-xs font-semibold uppercase tracking-[0.12em] text-ink-muted">
        <span>Finished parts shared with the client</span>
        {v.can.shareFor.length > 0 && (
          <Button variant="secondary" onClick={() => setOpen(!open)} data-testid="milestone-open">
            {open ? "Close" : "Share a finished part"}
          </Button>
        )}
      </h3>
      {open && <ShareMilestone v={v} onDone={(x) => (onChange(x), setOpen(false))} />}
      {v.milestones.length ? (
        <ul className="mt-1 divide-y divide-border" data-testid="milestones">
          {v.milestones.map((m) => (
            <li key={m.id} className="py-2 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <span className="font-medium">{m.title}</span>
                  <span className="text-xs text-ink-muted">
                    {m.department ? ` · ${m.department.name}` : ""} · shared {fmt(m.sharedAt)}
                    {m.sharedBy ? ` by ${m.sharedBy}` : ""}
                  </span>
                  {m.note && <p className="text-xs text-ink-muted">{m.note}</p>}
                  <MilestoneFiles files={m.files} />
                  {m.clientComment && <p className="mt-1 border-l-2 border-border pl-2 text-xs">Client: {m.clientComment}</p>}
                  {m.changeTaskId && (
                    <Link href={`/team/tasks/${m.changeTaskId}`} className="text-xs underline">
                      Open the changes task
                    </Link>
                  )}
                </div>
                <Badge tone={msTone[m.status]}>{milestoneStatusLabels[m.status]}</Badge>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        !open && <p className="mt-1 text-sm text-ink-muted">Nothing shared yet. Department Heads share each big part (login page, product design, first video draft) when it is done.</p>
      )}
    </div>
  );
}

/** Project page: finish dates and finished parts. */
export function ProjectFlowPanel({ engagementId }: { engagementId: string }) {
  const view = useLoad(() => api.projectFlow.get(engagementId), { live: ["Engagement"] });
  const [fresh, setFresh] = useState<ProjectFlowView>();
  const v = fresh ?? view.data;
  if (!v) return view.error ? null : <LoadState loading={view.loading} error={view.error} />;
  return (
    <Panel className="mt-6" title="Dates & progress" subtitle="Ask Department Heads when they will finish and tell the client. Heads share each big part when it is done; the client approves it or asks for changes.">
      <Estimates v={v} onChange={setFresh} />
      <Milestones v={v} onChange={setFresh} />
    </Panel>
  );
}

/** Work hand-off page: date requests a Department Head still has to answer. */
export function EstimateInbox() {
  const rows = useLoad(() => api.projectFlow.inbox(), { live: ["Engagement"] });
  if (!rows.data || !rows.data.length) return null;
  return (
    <Panel title="Finish dates to give" subtitle="Client Managers need the date your department will finish. Talk to your team, then give it on the project page.">
      <ul className="divide-y divide-border" data-testid="estimate-inbox">
        {rows.data.map((r: EstimateInboxRow) => (
          <li key={r.id} className="flex flex-wrap items-start justify-between gap-2 py-3 text-sm">
            <div className="min-w-0">
              <Link href={`/team/projects/${r.project.id}`} className="font-medium hover:underline">
                {r.project.client} · {r.project.service}
              </Link>
              <p className="text-xs text-ink-muted">
                {r.department.name}
                {r.requestedBy ? ` · asked by ${r.requestedBy}` : ""} {fmt(r.requestedAt)}
              </p>
              {r.requestNote && <p className="mt-1 border-l-2 border-border pl-2 text-xs">{r.requestNote}</p>}
            </div>
            <Link href={`/team/projects/${r.project.id}`} className="text-sm underline">
              Give date
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
