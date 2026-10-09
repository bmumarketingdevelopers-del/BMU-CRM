"use client";

import { use, useState } from "react";
import Link from "next/link";
import { deliverableStatusLabels, type DeliverableDetail } from "@bmu/shared";
import { ReviewViewer } from "@/components/review-viewer";
import { TaskList } from "@/components/task-list";
import { DeliverableAiTools } from "@/components/ai/deliverable-ai";
import { Badge, Button, Card, Input, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { DELIVER_SOCIAL_TYPES, type DeliverChannel } from "@bmu/shared";
import { ApprovalStatusBox } from "@/components/deliver/approval-status";
import { ItemEditor } from "@/components/deliver/content-calendar";
import { AddTaskButton } from "@/components/actions/tasks/add-task-button";
import { ApproveForPublishing, CaptionEditor, ProofRounds } from "@/components/creative/proof-rounds";

const day = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });
const tone = (s: string) => (s === "approved" ? "green" : s === "qc_failed" || s === "changes_requested" ? "red" : s === "qc_passed" || s === "in_qc" ? "amber" : "dark");

export default function DeliverablePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const loaded = useLoad(() => api.deliverables.get(id));
  const [fresh, setFresh] = useState<DeliverableDetail>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // A live reload (someone else commented, approved, uploaded) is newer than our last own result.
  const [seen, setSeen] = useState(loaded.data);
  if (seen !== loaded.data) {
    setSeen(loaded.data);
    setFresh(undefined);
  }
  const d = fresh ?? loaded.data;

  async function act(fn: () => Promise<DeliverableDetail>) {
    setBusy(true);
    setError(undefined);
    try {
      setFresh(await fn());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!d) return <LoadState loading={loaded.loading} error={loaded.error} />;
  const latest = d.versions.at(-1);
  const extraRound = d.revisionRounds.used > d.revisionRounds.included;

  return (
    <>
      <PageTitle
        presence={{ entity: "Deliverable", id: id }}
        title={d.title}
        subtitle={`${d.client.name} · ${d.serviceName} · ${d.type}`}
        action={
          <Link href={`/team/projects/${d.engagementId}`} className="text-sm underline">
            Back to project
          </Link>
        }
      />
      <div className="mb-5 flex flex-wrap items-center gap-3 text-sm">
        <Badge tone={tone(d.status)}>{deliverableStatusLabels[d.status]}</Badge>
        {d.dueAt && <span>First draft due {day.format(new Date(d.dueAt))}</span>}
        <span className={extraRound ? "font-semibold text-red" : "text-ink-muted"}>
          Revision rounds {d.revisionRounds.used} of {d.revisionRounds.included} used{extraRound ? " (extra round: quote it as an add-on)" : ""}
        </span>
      </div>
      {error && <p className="mb-4 border border-red bg-red/10 px-4 py-2 text-sm">{error}</p>}

      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <Card>
          <h2 className="mb-3 font-semibold">Review Studio</h2>
          {d.versions.length ? (
            <ReviewViewer
              versions={d.versions}
              comments={d.comments}
              canComment={d.can.comment}
              allowInternal={d.can.internal}
              onComment={async (versionId, draft) => {
                setFresh(await api.deliverables.comment(d.id, { versionId, ...draft }));
              }}
              onResolve={async (commentId, resolved) => {
                await (resolved ? api.craft.resolveComment(commentId) : api.craft.reopenComment(commentId));
                setFresh(await api.deliverables.get(d.id));
              }}
            />
          ) : (
            <p className="text-sm text-ink-muted">No versions yet. The maker uploads the first draft here.</p>
          )}
        </Card>

        <div className="space-y-4">
          {d.can.qc && latest && <QcPanel key={latest.id} items={d.qcChecklist} busy={busy} onSubmit={(input) => act(() => api.deliverables.submitQc(latest.id, input))} />}

          {d.can.send && latest && (
            <Card className="border-green">
              <p className="font-semibold">QC passed</p>
              <p className="mt-1 text-sm text-ink-muted">Version {latest.number} is ready. Sending it lets the client review and approve it.</p>
              <Button className="mt-3" disabled={busy} onClick={() => act(() => api.deliverables.send(latest.id))}>
                Send v{latest.number} to client
              </Button>
            </Card>
          )}

          {d.can.approveForPublishing && latest && (
            <ApproveForPublishing
              number={latest.number}
              busy={busy}
              onApprove={() =>
                act(async () => {
                  await api.creative.approveInternally(d.id);
                  return api.deliverables.get(d.id);
                })
              }
            />
          )}

          {d.approvalStatus && ["ready_for_client", "approved", "scheduled", "published"].includes(d.status) && (
            <ApprovalStatusBox status={d.approvalStatus} remind={d.status === "ready_for_client" ? { target: "deliverable", id: d.id } : undefined} />
          )}

          {["approved", "scheduled", "published"].includes(d.status) && (DELIVER_SOCIAL_TYPES as readonly string[]).includes(d.type) && d.schedule && (
            <div>
              <p className="mb-1 text-sm font-semibold">
                Content calendar ·{" "}
                <Link href="/team/content-calendar" className="font-normal underline">
                  open calendar
                </Link>
              </p>
              <ItemEditor
                key={`${d.status}-${d.schedule.scheduledAt}-${d.caption ?? ""}`}
                item={{
                  deliverableId: d.id,
                  title: d.title,
                  type: d.type,
                  status: d.status,
                  client: d.client,
                  engagementId: d.engagementId,
                  serviceName: d.serviceName,
                  scheduledAt: d.schedule.scheduledAt,
                  channel: d.schedule.channel as DeliverChannel | null,
                  publishedAt: d.schedule.publishedAt,
                  liveUrl: d.schedule.liveUrl,
                  preview: null,
                  caption: d.caption ?? null,
                }}
                onSaved={() => api.deliverables.get(d.id).then(setFresh)}
                onError={setError}
              />
            </div>
          )}

          {(DELIVER_SOCIAL_TYPES as readonly string[]).includes(d.type) && !(["approved", "scheduled", "published"].includes(d.status) && d.schedule) && (
            <CaptionEditor
              key={d.caption ?? ""}
              caption={d.caption ?? null}
              disabled={d.status === "published"}
              onSave={async (caption) => {
                await api.creative.setCaption(d.id, caption);
                setFresh(await api.deliverables.get(d.id));
              }}
            />
          )}

          {d.rounds && <ProofRounds rounds={d.rounds} certificate={d.certificate} certificateHref={`/team/deliverables/${d.id}/certificate`} />}

          {d.can.upload && <UploadPanel busy={busy} next={(latest?.number ?? 0) + 1} onFile={(f, note) => act(() => api.deliverables.uploadVersion(d.id, f, note))} onLink={(url, note) => act(() => api.deliverables.addLinkVersion(d.id, url, note))} />}

          {latest && latest.qc.length > 0 && (
            <Card>
              <h3 className="mb-2 text-sm font-semibold">QC history 🔒</h3>
              <ul className="space-y-3 text-sm">
                {d.versions.flatMap((v) =>
                  v.qc.map((q) => (
                    <li key={q.id}>
                      <div className="flex justify-between">
                        <span>
                          v{v.number} · {q.reviewer}
                        </span>
                        <Badge tone={q.result === "pass" ? "green" : "red"}>{q.result === "pass" ? "Pass" : "Fail"}</Badge>
                      </div>
                      {q.items.filter((i) => !i.ok).map((i) => (
                        <p key={i.label} className="text-xs text-red">
                          ✗ {i.label}
                          {i.note ? `: ${i.note}` : ""}
                        </p>
                      ))}
                      {q.note && <p className="text-xs text-ink-muted">{q.note}</p>}
                    </li>
                  )),
                )}
              </ul>
            </Card>
          )}

          <Card>
            <h3 className="mb-2 flex items-center justify-between text-sm font-semibold">
              Tasks
              <AddTaskButton prefill={{ engagementId: d.engagementId, deliverableId: d.id }} onSaved={() => api.deliverables.get(d.id).then(setFresh)} label="+ Add" className="text-xs font-normal text-ink-muted hover:text-ink" />
            </h3>
            <TaskList tasks={d.tasks} compact onChanged={() => api.deliverables.get(d.id).then(setFresh)} />
          </Card>
        </div>
      </div>
      <div className="mt-6">
        <DeliverableAiTools d={d} onChanged={setFresh} />
      </div>
    </>
  );
}

function QcPanel({ items, busy, onSubmit }: { items: string[]; busy: boolean; onSubmit: (input: { items: { label: string; ok: boolean; note?: string }[]; note?: string }) => void }) {
  const [checks, setChecks] = useState(items.map((label) => ({ label, ok: false, note: "" })));
  const [note, setNote] = useState("");
  const allOk = checks.every((c) => c.ok);
  return (
    <Card className="border-amber">
      <p className="font-semibold">QC checklist 🔒</p>
      <p className="mb-3 text-xs text-ink-muted">Internal only. Tick what passes; anything unticked fails QC and goes back to the maker.</p>
      <ul className="space-y-2 text-sm">
        {checks.map((c, i) => (
          <li key={c.label}>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={c.ok} onChange={(e) => setChecks(checks.map((x, j) => (j === i ? { ...x, ok: e.target.checked } : x)))} />
              <span>{c.label}</span>
            </label>
            {!c.ok && (
              <Input className="mt-1 py-1 text-xs" placeholder="What's wrong? (optional)" value={c.note} onChange={(e) => setChecks(checks.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))} />
            )}
          </li>
        ))}
      </ul>
      <textarea className="mt-3 w-full border border-border bg-surface-raised px-3 py-2 text-sm" rows={2} placeholder="Overall note for the maker" value={note} onChange={(e) => setNote(e.target.value)} />
      <Button
        className="mt-2 w-full"
        variant={allOk ? "primary" : "secondary"}
        disabled={busy}
        onClick={() => onSubmit({ items: checks.map((c) => ({ label: c.label, ok: c.ok, note: c.note || undefined })), note: note || undefined })}
      >
        {allOk ? "Pass QC" : "Fail QC and return to maker"}
      </Button>
    </Card>
  );
}

function UploadPanel({ busy, next, onFile, onLink }: { busy: boolean; next: number; onFile: (f: File, note?: string) => void; onLink: (url: string, note?: string) => void }) {
  const [mode, setMode] = useState<"file" | "link">("file");
  const [file, setFile] = useState<File>();
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  return (
    <Card>
      <p className="font-semibold">Upload version {next}</p>
      <div className="mt-2 flex gap-3 text-sm">
        <label className="flex items-center gap-1">
          <input type="radio" checked={mode === "file"} onChange={() => setMode("file")} /> File
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" checked={mode === "link"} onChange={() => setMode("link")} /> Link (live URL, Drive, Figma)
        </label>
      </div>
      <form
        className="mt-3 grid gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (mode === "file" && file) onFile(file, note || undefined);
          if (mode === "link" && url) onLink(url, note || undefined);
        }}
      >
        {mode === "file" ? (
          <input type="file" accept="image/*,video/*,application/pdf" className="text-sm" onChange={(e) => setFile(e.target.files?.[0])} required />
        ) : (
          <Input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" required />
        )}
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed? (optional)" />
        <Button type="submit" disabled={busy}>
          {busy ? "Uploading…" : "Upload and send to QC"}
        </Button>
      </form>
    </Card>
  );
}
