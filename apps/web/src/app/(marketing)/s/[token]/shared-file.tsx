"use client";

/** Public share link: shows the file name, size and expiry; asks for the password when one is set. */
import { useState } from "react";
import { ApiError } from "@bmu/shared";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { Button, Input, LoadState } from "@/components/ui";

const fmt = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
const size = (n: number | null) => (n === null ? "" : n > 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function SharedFile({ token }: { token: string }) {
  const share = useLoad(() => api.ops.files.publicShare(token));
  const [password, setPassword] = useState("");
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (!share.data) {
    if (share.loading) return <LoadState loading />;
    return (
      <div className="border border-border bg-surface-raised p-6 text-center" data-testid="share-gone">
        <h1 className="text-lg font-semibold">This link no longer works</h1>
        <p className="mt-2 text-sm text-ink-muted">{share.error ?? "It may have expired or been turned off."} Ask the person who sent it for a new link.</p>
      </div>
    );
  }
  const s = share.data;
  const download = url ?? s.downloadUrl;

  async function unlock(e: React.FormEvent) {
    e.preventDefault();
    if (!password) return setError("Enter the password");
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.ops.files.unlock(token, password);
      setUrl(r.downloadUrl);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? "Too many tries. Wait 15 minutes and try again." : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border border-border bg-surface-raised p-6" data-testid="shared-file">
      <p className="text-xs uppercase tracking-[0.12em] text-ink-muted">Shared by {s.from}</p>
      <h1 className="mt-2 break-words text-xl font-semibold">{s.name}</h1>
      <p className="mt-1 text-sm text-ink-muted">
        {size(s.sizeBytes)}
        {s.sizeBytes !== null ? " · " : ""}link works until {fmt(s.expiresAt)}
      </p>
      {download ? (
        <a href={download} className="mt-6 inline-block bg-charcoal px-5 py-2.5 text-sm font-semibold text-ivory" data-testid="share-download">
          Download
        </a>
      ) : (
        <form onSubmit={unlock} className="mt-6 grid gap-3">
          <label className="grid gap-1 text-sm">
            This file is password protected
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Password" autoComplete="off" />
          </label>
          {error && <p className="text-sm text-red" role="alert">{error}</p>}
          <div>
            <Button disabled={busy}>{busy ? "Checking…" : "Unlock"}</Button>
          </div>
        </form>
      )}
    </div>
  );
}
