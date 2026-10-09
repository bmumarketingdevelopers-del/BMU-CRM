"use client";

/** Client portal: send files to the team (lands in "From client" and ticks the matching checklist item), see uploads and released files. */
import { useState } from "react";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { Button, Card } from "@/components/ui";
import { inputCls } from "@/components/actions/action-drawer";
import { errMsg, fmtDay, fmtSize } from "./kit";

export function ClientUploads() {
  const data = useLoad(() => api.ops.files.clientList());
  const [files, setFiles] = useState<File[]>([]);
  const [item, setItem] = useState("");
  const [tags, setTags] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string>();
  const [ok, setOk] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(0);
  const d = data.data;

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setOk(undefined);
    if (!files.length) return setError("Choose at least one file");
    if (files.some((f) => f.size > 200 * 1024 * 1024)) return setError("Files can be up to 200 MB each");
    setBusy(true);
    setError(undefined);
    try {
      const it = d?.openItems.find((x) => x.id === item);
      let ticked = 0;
      for (const f of files) {
        const r = await api.ops.files.clientUpload(f, { requirementItemId: it?.id, engagementId: it?.engagementId, tags: tags.split(",").map((t) => t.trim()).filter(Boolean), note: note.trim() || undefined });
        ticked += r.ticked.length;
      }
      setOk(`${files.length === 1 ? "File" : `${files.length} files`} sent to your team${ticked ? ` and ${ticked} checklist item${ticked === 1 ? "" : "s"} marked received` : ""}.`);
      setFiles([]);
      setItem("");
      setTags("");
      setNote("");
      setKey((k) => k + 1);
      data.reload();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-10 grid gap-4 lg:grid-cols-2" data-testid="client-uploads">
      <Card>
        <h2 className="font-medium">Send us files</h2>
        <p className="mt-1 text-sm text-ink-muted">Logos, photos, brand guides, documents. Your team is told straight away.</p>
        <form onSubmit={send} className="mt-4 grid gap-3">
          <input key={key} type="file" multiple className={inputCls} onChange={(e) => setFiles([...(e.target.files ?? [])])} aria-label="Files to send" />
          {d && d.openItems.length > 0 && (
            <label className="grid gap-1 text-sm">
              For a checklist item (optional)
              <select className={inputCls} value={item} onChange={(e) => setItem(e.target.value)} aria-label="Checklist item">
                <option value="">Not for a checklist item</option>
                {d.openItems.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.label} · {x.service}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="grid gap-1 text-sm">
            Tags (optional)
            <input className={inputCls} value={tags} onChange={(e) => setTags(e.target.value)} aria-label="Tags" placeholder="e.g. logo, photos" />
          </label>
          <label className="grid gap-1 text-sm">
            Note for the team (optional)
            <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note for the team" maxLength={500} />
          </label>
          {error && <p className="text-sm text-red" role="alert">{error}</p>}
          {ok && (
            <p className="border border-green bg-green/10 px-3 py-2 text-sm" role="status">
              {ok}
            </p>
          )}
          <div>
            <Button disabled={busy}>{busy ? "Sending…" : "Send files"}</Button>
          </div>
        </form>
      </Card>
      <Card>
        <h2 className="font-medium">Shared with you</h2>
        {!d ? (
          <p className="mt-2 text-sm text-ink-muted">{data.error ?? "Loading…"}</p>
        ) : (
          <>
            <FileList rows={d.released} empty="Brand assets and final files your team shares appear here." />
            <h3 className="mt-5 text-sm font-medium">Your uploads</h3>
            <FileList rows={d.uploads} empty="Nothing sent yet." />
          </>
        )}
      </Card>
    </div>
  );
}

function FileList({ rows, empty }: { rows: { id: string; name: string; tags: string[]; sizeBytes: number | null; at: string; url: string }[]; empty: string }) {
  if (!rows.length) return <p className="mt-2 text-sm text-ink-muted">{empty}</p>;
  return (
    <ul className="mt-2 divide-y divide-border text-sm">
      {rows.slice(0, 20).map((f) => (
        <li key={f.id} className="flex items-center justify-between gap-2 py-2">
          <a href={f.url} target="_blank" rel="noreferrer" className="min-w-0 truncate underline">
            {f.name}
          </a>
          <span className="shrink-0 text-xs text-ink-muted">
            {fmtSize(f.sizeBytes)} · {fmtDay(f.at)}
          </span>
        </li>
      ))}
    </ul>
  );
}
