"use client";

import Link from "next/link";
import { use, useRef, useState } from "react";
import type { OpsThreadView, SentFile } from "@bmu/shared";
import { Badge, Button, LoadState, PageTitle } from "@/components/ui";
import { useActions } from "@/components/actions/actions-provider";
import { RowMenu } from "@/components/actions/row-menu";
import { TextArea } from "@/components/actions/action-drawer";
import { errMsg } from "@/components/ops/kit";
import { MessageToRequestDrawer } from "@/components/ops/message-to-request";
import { SENT_FILE_MAX, SentFileList } from "@/components/sent-files";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const at = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

export default function DiscussionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const loaded = useLoad(() => api.ops.threads.get(id));
  const [fresh, setFresh] = useState<OpsThreadView>();
  const [body, setBody] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // v38: files to send with the reply (they go to Files for the people in this discussion).
  const [files, setFiles] = useState<SentFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const [toRequest, setToRequest] = useState<{ id: string; body: string }>();
  const { me, canNew, openNew, notify } = useActions();
  const canRequest = me.roles.some((r) => ["founder", "admin", "am_lead", "account_manager"].includes(r));
  const t = fresh ?? loaded.data;

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim() && !files.length) return setError("Write a message or attach a file");
    setBusy(true);
    setError(undefined);
    try {
      setFresh(await api.ops.threads.post(id, body.trim(), files.map((f) => f.id)));
      setBody("");
      setFiles([]);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  async function attach(list: FileList | null) {
    if (!list?.length) return;
    setUploading(true);
    setError(undefined);
    try {
      for (const f of Array.from(list).slice(0, 5 - files.length)) {
        if (f.size > SENT_FILE_MAX) throw new Error(`${f.name} is larger than 200 MB`);
        const a = await api.ops.threads.attach(id, f);
        setFiles((x) => [...x, a]);
      }
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setUploading(false);
      if (picker.current) picker.current.value = "";
    }
  }

  if (!t) return <LoadState loading={loaded.loading} error={loaded.error} />;
  return (
    <>
      <Link href="/team/discussions" className="text-sm underline">
        ← Discussions
      </Link>
      <PageTitle
        title={t.title}
        subtitle={`${t.client.name}${t.engagement ? ` · ${t.engagement}` : ""}${t.kind === "internal" ? ` · with ${t.participants.join(", ")}` : " · the client's team can read this"}`}
        action={<Badge tone={t.kind === "internal" ? "neutral" : "green"}>{t.kind === "internal" ? "Internal" : "Project"}</Badge>}
      />
      <ol className="space-y-3" aria-label="Messages">
        {t.messages.map((m) => (
          <li key={m.id} className={`max-w-2xl border p-3 text-sm ${m.mine ? "ml-auto border-charcoal/30 bg-canvas" : "border-border bg-surface-raised"}`} data-message={m.id}>
            <div className="mb-1 flex items-center justify-between gap-2 text-xs text-ink-muted">
              <span>
                <span className="font-medium text-ink">{m.author}</span> · {at(m.at)}
              </span>
              <RowMenu
                label="Message actions"
                items={[
                  { key: "task", label: "Create task", hidden: !canNew("task"), onSelect: () => openNew("task", { title: m.body.split("\n")[0].slice(0, 120), description: m.body, source: `message:${m.id}`, clientId: t.client.id }) },
                  { key: "request", label: "Create request", hidden: !canRequest || t.kind === "internal", onSelect: () => setToRequest({ id: m.id, body: m.body }) },
                ]}
              />
            </div>
            {m.body && <p className="whitespace-pre-wrap">{m.body}</p>}
            <SentFileList files={m.attachments ?? []} />
          </li>
        ))}
      </ol>
      {t.canPost ? (
        <form onSubmit={send} className="mt-6 grid max-w-2xl gap-2">
          <TextArea value={body} onChange={(e) => setBody(e.target.value)} aria-label="Message" rows={3} maxLength={4000} placeholder="Write a reply…" />
          {files.length > 0 && (
            <ul className="flex flex-wrap gap-2 text-xs" aria-label="Files to send">
              {files.map((f) => (
                <li key={f.id} className="flex items-center gap-1 border border-border bg-canvas/50 px-2 py-1">
                  📎 {f.name}
                  <button type="button" className="ml-1 text-ink-muted hover:text-red" aria-label={`Remove ${f.name}`} onClick={() => setFiles((x) => x.filter((y) => y.id !== f.id))}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          {error && <p className="text-sm text-red">{error}</p>}
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={busy || uploading}>{busy ? "Sending…" : "Send"}</Button>
            <label className={`cursor-pointer text-sm underline ${files.length >= 5 ? "pointer-events-none opacity-50" : ""}`}>
              {uploading ? "Uploading…" : "📎 Attach files"}
              <input ref={picker} type="file" multiple className="sr-only" onChange={(e) => attach(e.target.files)} disabled={uploading || files.length >= 5} aria-label="Attach files" />
            </label>
            <span className="text-xs text-ink-muted">{t.kind === "internal" ? "Only the people in this discussion see the files (also in their Files)." : "Everyone on this client's team sees the files (also in their Files)."}</span>
          </div>
        </form>
      ) : (
        <p className="mt-6 text-sm text-ink-muted">You can read this discussion but not post in it.</p>
      )}
      {toRequest && <MessageToRequestDrawer message={toRequest} clientId={t.client.id} onClose={() => setToRequest(undefined)} onDone={(m) => (notify(m), loaded.reload(), setFresh(undefined))} />}
    </>
  );
}
