// v38: files sent in a discussion or on a task. Pictures show inline; everything else downloads. They are also in
// Files (labelled "Discussion" / "Task") for the people they were sent to.
import type { SentFile } from "@bmu/shared";

export const fileSize = (n: number | null | undefined) => (!n ? "" : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Files go straight to storage; the server's own limit is 200 MB. */
export const SENT_FILE_MAX = 200 * 1024 * 1024;

export function SentFileList({ files }: { files: SentFile[] }) {
  if (!files.length) return null;
  return (
    <ul className="mt-2 space-y-1" aria-label="Files">
      {files.map((f) => (
        <li key={f.id}>
          {f.mimeType?.startsWith("image/") ? (
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
