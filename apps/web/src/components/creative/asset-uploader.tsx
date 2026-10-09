"use client";

import { useRef, useState } from "react";
import { ASSET_MAX_BYTES, type AssetDetail, type UploadStart } from "@bmu/shared";
import { api } from "@/lib/api";

export const bytes = (n: number | null | undefined) =>
  n == null ? "" : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

type Job = { key: string; file: File; received: number; state: "uploading" | "paused" | "done" | "failed"; error?: string; sessionId?: string };

const storeKey = (f: File, target: string) => `bmu-upload:${target}:${f.name}:${f.size}:${f.lastModified}`;
const remember = (k: string, id?: string) => {
  try {
    if (id) localStorage.setItem(k, id);
    else localStorage.removeItem(k);
  } catch {
    // storage blocked: the upload still works, it just can't resume after a page reload
  }
};
const recall = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};

/**
 * Big-file uploader: sends 4 MB pieces one after another, so a dropped connection or a closed tab only loses the
 * piece in flight. Picking the same file again (even after a reload) carries on from where the server stopped.
 */
export function AssetUploader({
  target,
  multiple = true,
  label = "Choose files",
  onDone,
}: {
  /** Where the file goes: a new asset (client, collection, tags) or the next version of an existing one. */
  target: Omit<UploadStart, "name" | "size" | "mimeType">;
  multiple?: boolean;
  label?: string;
  onDone: (asset: AssetDetail) => void;
}) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const paused = useRef(new Set<string>());
  const input = useRef<HTMLInputElement>(null);
  const targetKey = target.assetId ?? "new";

  const patch = (key: string, p: Partial<Job>) => setJobs((all) => all.map((j) => (j.key === key ? { ...j, ...p } : j)));

  async function run(job: Job) {
    const { file, key } = job;
    paused.current.delete(key);
    patch(key, { state: "uploading", error: undefined });
    try {
      const sk = storeKey(file, targetKey);
      let session = null;
      const existing = job.sessionId ?? recall(sk);
      if (existing) session = await api.assets.uploadStatus(existing).catch(() => null);
      if (!session || session.done) session = await api.assets.startUpload({ ...target, name: file.name, size: file.size, mimeType: file.type || "application/octet-stream" });
      remember(sk, session.id);
      patch(key, { sessionId: session.id, received: session.received });
      let at = session.received;
      while (at < file.size) {
        if (paused.current.has(key)) {
          patch(key, { state: "paused", received: at });
          return;
        }
        const next = await api.assets.uploadChunk(session.id, at, file.slice(at, Math.min(file.size, at + session.chunkSize)));
        at = next.received;
        patch(key, { received: at });
      }
      const asset = await api.assets.completeUpload(session.id);
      remember(sk);
      patch(key, { state: "done", received: file.size });
      onDone(asset);
    } catch (e) {
      patch(key, { state: "failed", error: (e as Error).message });
    }
  }

  function add(files: FileList | null) {
    if (!files?.length) return;
    const fresh: Job[] = [];
    for (const file of Array.from(files)) {
      const key = `${file.name}:${file.size}:${file.lastModified}`;
      if (file.size > ASSET_MAX_BYTES) {
        fresh.push({ key, file, received: 0, state: "failed", error: "Files can be up to 5 GB" });
        continue;
      }
      fresh.push({ key, file, received: 0, state: "uploading" });
    }
    setJobs((all) => [...all.filter((j) => !fresh.some((f) => f.key === j.key)), ...fresh]);
    // One file at a time keeps each piece quick on a slow connection.
    (async () => {
      for (const j of fresh) if (j.state === "uploading") await run(j);
    })();
    if (input.current) input.current.value = "";
  }

  return (
    <div>
      <label className="inline-flex cursor-pointer items-center gap-2 border border-charcoal bg-charcoal px-4 py-2 text-sm font-semibold text-ivory">
        {label}
        <input ref={input} type="file" multiple={multiple} className="sr-only" data-testid="asset-file" onChange={(e) => add(e.target.files)} />
      </label>
      <span className="ml-3 text-xs text-ink-muted">Up to 5 GB each. If the connection drops, pick the same file again to carry on.</span>
      {jobs.length > 0 && (
        <ul className="mt-3 space-y-2 text-sm">
          {jobs.map((j) => {
            const pct = j.file.size ? Math.floor((j.received / j.file.size) * 100) : 0;
            return (
              <li key={j.key} className="border border-border bg-surface-raised px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="truncate font-semibold">{j.file.name}</span>
                  <span className="text-xs text-ink-muted">
                    {bytes(j.received)} of {bytes(j.file.size)} · {j.state === "done" ? "Done" : j.state === "paused" ? "Paused" : j.state === "failed" ? "Stopped" : `${pct}%`}
                  </span>
                </div>
                <div className="mt-1 h-1.5 bg-canvas">
                  <div className={`h-full ${j.state === "failed" ? "bg-red" : j.state === "done" ? "bg-green" : "bg-charcoal"}`} style={{ width: `${pct}%` }} />
                </div>
                {j.error && <p className="mt-1 text-xs text-red">{j.error}</p>}
                <div className="mt-1 flex gap-3 text-xs">
                  {j.state === "uploading" && (
                    <button className="underline" onClick={() => paused.current.add(j.key)}>
                      Pause
                    </button>
                  )}
                  {(j.state === "paused" || (j.state === "failed" && j.file.size <= ASSET_MAX_BYTES)) && (
                    <button className="underline" onClick={() => run(j)}>
                      {j.state === "paused" ? "Resume" : "Try again"}
                    </button>
                  )}
                  {j.state !== "done" && j.state !== "uploading" && (
                    <button
                      className="underline"
                      onClick={async () => {
                        if (j.sessionId) await api.assets.cancelUpload(j.sessionId).catch(() => undefined);
                        remember(storeKey(j.file, targetKey));
                        setJobs((all) => all.filter((x) => x.key !== j.key));
                      }}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function AssetThumb({ kind, url, title, className = "" }: { kind: string; url: string; title: string; className?: string }) {
  if (kind === "image") {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt={title} loading="lazy" className={`h-full w-full object-cover ${className}`} />;
  }
  if (kind === "video") return <video src={`${url}#t=0.1`} preload="metadata" muted playsInline className={`h-full w-full bg-black object-cover ${className}`} />;
  return (
    <div className={`flex h-full w-full items-center justify-center bg-canvas text-2xl ${className}`} aria-label={kind}>
      {kind === "pdf" ? "📄" : kind === "link" ? "🔗" : "📁"}
    </div>
  );
}
