"use client";

import { useState } from "react";
import { briefStatusLabels, formatINR, type BriefDetail, type BriefStatus } from "@bmu/shared";
import { Empty, KeyValues, Panel } from "@/components/dash";
import { Badge, Button, Input } from "@/components/ui";
import { fmtDate, fmtDateTime } from "./format";

const tone: Record<BriefStatus, "neutral" | "green" | "amber" | "red" | "dark"> = {
  offered: "amber",
  accepted: "dark",
  declined: "neutral",
  submitted: "amber",
  revision: "red",
  approved: "green",
  paid: "green",
  cancelled: "neutral",
};

export function BriefStatusBadge({ status, creatorView = false }: { status: BriefStatus; creatorView?: boolean }) {
  const label = creatorView && status === "offered" ? "New offer" : creatorView && status === "submitted" ? "With BMU for review" : briefStatusLabels[status];
  return <Badge tone={tone[status]}>{label}</Badge>;
}

/** Brief text, deliverables and key facts. */
export function BriefSummary({ b }: { b: BriefDetail }) {
  return (
    <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
      <Panel title="The brief">
        <p className="text-[15px] leading-relaxed whitespace-pre-line">{b.brief}</p>
        <h3 className="mt-6 mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-ink-muted">Deliverables</h3>
        <ul className="space-y-1.5 text-sm">
          {b.deliverables.map((d, i) => (
            <li key={i} className="flex gap-2">
              <span className="mt-2 inline-block h-1.5 w-1.5 shrink-0 bg-charcoal" />
              {d}
            </li>
          ))}
        </ul>
      </Panel>
      <Panel title="Details">
        <KeyValues
          items={[
            { k: "Fee", v: formatINR(b.feePaise) },
            { k: "Due", v: b.dueAt ? fmtDate.format(new Date(b.dueAt)) : "No date" },
            { k: "Client", v: b.client?.name ?? "—" },
            ...(b.engagement ? [{ k: "Service", v: b.engagement.serviceName }] : []),
            { k: "Briefed by", v: b.createdBy ?? "—" },
            { k: "Sent", v: fmtDate.format(new Date(b.createdAt)) },
          ]}
        />
        {b.payout && (
          <div className="mt-4 border-t border-border pt-4">
            <p className="text-[11px] uppercase tracking-[0.12em] text-ink-muted">Payout</p>
            <KeyValues
              items={[
                { k: "Fee", v: formatINR(b.payout.amountPaise) },
                { k: "TDS (10%)", v: `− ${formatINR(b.payout.tdsPaise)}` },
                { k: "Net payout", v: <span className="text-[#5f8a12]">{formatINR(b.payout.netPaise)}</span> },
                { k: "Status", v: b.payout.status === "paid" ? `Paid${b.payout.paidAt ? ` ${fmtDate.format(new Date(b.payout.paidAt))}` : ""}` : b.payout.status === "on_hold" ? "On hold" : "Pending" },
              ]}
            />
          </div>
        )}
      </Panel>
    </div>
  );
}

/** Versions sent for the brief, newest first, with feedback. */
export function SubmissionHistory({ b }: { b: BriefDetail }) {
  const list = [...b.submissionList].reverse();
  return (
    <Panel title="Submissions & feedback" subtitle={`${b.submissionList.length} version${b.submissionList.length === 1 ? "" : "s"}`}>
      {list.length === 0 ? (
        <Empty>No work sent yet.</Empty>
      ) : (
        <ol className="space-y-6">
          {list.map((s) => (
            <li key={s.id} className="border-l-2 border-border pl-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium">Version {s.number}</p>
                {s.approved === true && <Badge tone="green">Approved</Badge>}
                {s.approved === false && <Badge tone="red">Changes requested</Badge>}
                {s.approved === null && <Badge tone="amber">Waiting for review</Badge>}
                <span className="text-xs text-ink-muted">{fmtDateTime.format(new Date(s.createdAt))}</span>
              </div>
              <p className="mt-1 text-sm">
                {s.fileUrl ? (
                  <a href={s.fileUrl} target="_blank" rel="noreferrer" className="underline">
                    {s.fileName ?? "Open file"}
                  </a>
                ) : s.url ? (
                  <a href={s.url} target="_blank" rel="noreferrer" className="break-all underline">
                    {s.url}
                  </a>
                ) : null}
              </p>
              {s.note && <p className="mt-1 text-sm text-ink-muted">“{s.note}”</p>}
              {s.feedback && (
                <div className="mt-3 border border-border bg-canvas/50 px-3 py-2 text-sm">
                  <p className="text-[11px] uppercase tracking-[0.12em] text-ink-muted">Feedback from BMU{s.reviewedAt ? ` · ${fmtDateTime.format(new Date(s.reviewedAt))}` : ""}</p>
                  <p className="mt-1 whitespace-pre-line">{s.feedback}</p>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

/** Upload a file or paste a link for the next version. */
export function SubmitWork({ onFile, onLink, title = "Send your work" }: { onFile: (file: File, note?: string) => Promise<void>; onLink: (url: string, note?: string) => Promise<void>; title?: string }) {
  const [mode, setMode] = useState<"file" | "link">("file");
  const [file, setFile] = useState<File>();
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      if (mode === "file") {
        if (!file) throw new Error("Choose a file to upload");
        await onFile(file, note || undefined);
      } else await onLink(url, note || undefined);
      setFile(undefined);
      setUrl("");
      setNote("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel title={title} subtitle="Upload the file, or paste a Drive / Dropbox / YouTube link">
      <form onSubmit={submit} className="grid gap-3">
        <div className="inline-flex w-fit border border-border text-sm">
          {(["file", "link"] as const).map((m) => (
            <button key={m} type="button" onClick={() => setMode(m)} className={`px-3 py-1.5 ${mode === m ? "bg-charcoal text-ivory" : "text-ink-muted hover:text-ink"}`}>
              {m === "file" ? "Upload a file" : "Paste a link"}
            </button>
          ))}
        </div>
        {mode === "file" ? (
          <input type="file" onChange={(e) => setFile(e.target.files?.[0])} className="text-sm file:mr-3 file:border file:border-border file:bg-surface-raised file:px-3 file:py-1.5 file:text-sm" aria-label="File" />
        ) : (
          <Input type="url" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} required aria-label="Link" />
        )}
        <Input placeholder="Note for the team (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} aria-label="Note" />
        {error && <p className="text-sm text-red">{error}</p>}
        <Button disabled={busy} className="w-fit">
          {busy ? "Sending…" : "Send for review"}
        </Button>
      </form>
    </Panel>
  );
}
