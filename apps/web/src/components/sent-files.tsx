"use client";
// v38: files sent in a discussion or on a task. Pictures show inline; everything else downloads. They are also in
// Files (labelled "Discussion" / "Task") for the people they were sent to.
// v39: a Drive (or any) link can be sent instead, e.g. when a file is over the upload limit.
import { useRef, useState } from "react";
import type { SentFile } from "@bmu/shared";

export const fileSize = (n: number | null | undefined) => (!n ? "" : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Files go straight to storage; the server's own limit is 200 MB. */
export const SENT_FILE_MAX = 200 * 1024 * 1024;
const TOO_BIG = (name: string) => `${name} is larger than 200 MB. Upload it to Google Drive (or similar) and paste the link instead.`;

export function SentFileList({ files }: { files: SentFile[] }) {
  if (!files.length) return null;
  return (
    <ul className="mt-2 space-y-1" aria-label="Files">
      {files.map((f) => (
        <li key={f.id}>
          {f.kind === "link" ? (
            <a href={f.url} target="_blank" rel="noreferrer noopener" className="underline">
              🔗 {f.name}
            </a>
          ) : f.mimeType?.startsWith("image/") ? (
            <a href={f.url} target="_blank" rel="noreferrer" className="block w-fit">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={f.url} alt={f.name} className="max-h-48 max-w-full border border-border" />
            </a>
          ) : (
            <a href={`${f.url}?download=1`} className="underline">
              📎 {f.name}
            </a>
          )}
          <span className="ml-2 text-[11px] text-ink-muted">
            {[fileSize(f.sizeBytes), f.by, f.at ? new Date(f.at).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }) : null].filter(Boolean).join(" · ")}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * "📎 Attach files" plus "🔗 Add a link". Each picked file is uploaded with `upload`, each link added with `addLink`;
 * `onAdded` gets the result. Files over 200 MB are refused with a hint to paste a Drive link instead.
 */
export function SendFileControls({ upload, addLink, onAdded, limit = 10, label = "📎 Attach files" }: { upload: (f: File) => Promise<SentFile | void>; addLink: (url: string) => Promise<SentFile | void>; onAdded?: (f: SentFile) => void; limit?: number; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [linking, setLinking] = useState(false);
  const [url, setUrl] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  async function pick(list: FileList | null) {
    if (!list?.length) return;
    setBusy(true);
    setError(undefined);
    try {
      for (const f of Array.from(list).slice(0, limit)) {
        if (f.size > SENT_FILE_MAX) throw new Error(TOO_BIG(f.name));
        const r = await upload(f);
        if (r) onAdded?.(r);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (picker.current) picker.current.value = "";
    }
  }
  async function link() {
    if (!url.trim()) return setError("Paste the link");
    setBusy(true);
    setError(undefined);
    try {
      const r = await addLink(url.trim());
      if (r) onAdded?.(r);
      setUrl("");
      setLinking(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const off = busy || limit <= 0;
  return (
    <div className="grid gap-1 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <label className={`cursor-pointer underline ${off ? "pointer-events-none opacity-50" : ""}`}>
          {busy ? "Sending…" : label}
          <input ref={picker} type="file" multiple className="sr-only" disabled={off} onChange={(e) => pick(e.target.files)} aria-label="Attach files" />
        </label>
        <button type="button" className="underline disabled:opacity-50" disabled={off} onClick={() => setLinking((x) => !x)}>
          🔗 Add a link
        </button>
        <span className="text-xs text-ink-muted">Over 200 MB? Paste a Google Drive link.</span>
      </div>
      {linking && (
        <div className="flex flex-wrap gap-2">
          <input
            type="url"
            className="min-w-0 flex-1 border border-border bg-surface px-2 py-1 text-sm"
            placeholder="https://drive.google.com/…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                link();
              }
            }}
            aria-label="Link"
          />
          <button type="button" className="border border-border px-2 py-1 text-sm hover:border-ink disabled:opacity-50" disabled={busy} onClick={link}>
            Add
          </button>
        </div>
      )}
      {error && <p className="text-sm text-red">{error}</p>}
    </div>
  );
}

/** Files and links waiting to be sent (with remove buttons). */
export function PendingFiles({ files, onRemove }: { files: SentFile[]; onRemove: (id: string) => void }) {
  if (!files.length) return null;
  return (
    <ul className="flex flex-wrap gap-2 text-xs" aria-label="Files to send">
      {files.map((f) => (
        <li key={f.id} className="flex items-center gap-1 border border-border bg-canvas/50 px-2 py-1">
          {f.kind === "link" ? "🔗" : "📎"} {f.name}
          <button type="button" className="ml-1 text-ink-muted hover:text-red" aria-label={`Remove ${f.name}`} onClick={() => onRemove(f.id)}>
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}
