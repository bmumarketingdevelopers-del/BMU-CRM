"use client";

/** One-tap approval from an email or WhatsApp link: see the work, then approve or ask for changes without signing in. */
import { useState } from "react";
import type { ProofLinkView } from "@bmu/shared";
import { Button, LoadState } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { previewVideoProps } from "@/components/view-only";

export function ProofReview({ token }: { token: string }) {
  const loaded = useLoad(() => api.proofing.link(token), { live: false });
  const [fresh, setFresh] = useState<ProofLinkView>();
  const [asking, setAsking] = useState(false);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const p = fresh ?? loaded.data;

  if (!p) {
    if (loaded.loading) return <LoadState loading />;
    return (
      <div className="border border-border bg-surface-raised p-6 text-center" data-testid="proof-gone">
        <h1 className="text-lg font-semibold">This link no longer works</h1>
        <p className="mt-2 text-sm text-ink-muted">{loaded.error ?? "It may have expired."} Sign in to your BMU portal to review the work, or ask your Client Manager for a new link.</p>
      </div>
    );
  }

  async function decide(decision: "approve" | "changes") {
    setBusy(true);
    setError(undefined);
    try {
      setFresh(await api.proofing.decide(token, { decision, comment: comment.trim() || undefined }));
      setAsking(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const v = p.version;
  return (
    <div data-testid="proof-review">
      <p className="text-xs uppercase tracking-[0.12em] text-ink-muted">
        {p.client} · {p.service}
      </p>
      <h1 className="mt-1 text-2xl font-semibold">{p.title}</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Hi {p.forName.split(" ")[0]}, version {v.number} is ready for you.{v.note ? ` What changed: ${v.note}` : ""}
      </p>

      <div className="mt-5 border border-border bg-canvas">
        {v.kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={v.url} alt={v.name ?? p.title} className="mx-auto block max-h-[70vh] max-w-full" />
        ) : v.kind === "video" ? (
          <div className="relative mx-auto w-fit">
            <video src={v.url} controls playsInline className="mx-auto block max-h-[70vh] max-w-full bg-black" {...(p.preview ? previewVideoProps : {})} />
          </div>
        ) : v.kind === "pdf" ? (
          <iframe src={v.url} title={v.name ?? "PDF"} className="h-[70vh] w-full bg-white" />
        ) : (
          <div className="p-6 text-sm">
            <a href={v.url} target="_blank" rel="noreferrer" className="break-all font-semibold underline">
              {v.name ?? "Open the work"}
            </a>
          </div>
        )}
      </div>
      {p.openComments > 0 && <p className="mt-2 text-xs text-ink-muted">{p.openComments} comment{p.openComments > 1 ? "s are" : " is"} open on this version. Sign in to the portal to see them on the work.</p>}

      {p.message && <p className={`mt-5 border px-4 py-3 text-sm ${p.status === "approved" ? "border-green bg-green/10" : "border-border bg-surface-raised"}`} data-testid="proof-message">{p.message}</p>}
      {error && <p className="mt-4 border border-red bg-red/10 px-4 py-2 text-sm">{error}</p>}

      {p.status === "waiting" && !asking && (
        <div className="mt-5 flex flex-wrap gap-3">
          <Button disabled={busy} onClick={() => decide("approve")}>
            Approve version {v.number}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => setAsking(true)}>
            Request changes
          </Button>
        </div>
      )}
      {p.status === "waiting" && asking && (
        <div className="mt-5 border border-amber bg-surface-raised p-4">
          <p className="text-sm font-semibold">What should change?</p>
          <textarea className="mt-2 w-full border border-border bg-surface-raised px-3 py-2 text-sm" rows={4} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="e.g. Make the logo bigger and use the green from our brand kit" />
          <div className="mt-2 flex gap-2">
            <Button disabled={busy || !comment.trim()} onClick={() => decide("changes")}>
              Send to BMU
            </Button>
            <Button variant="ghost" onClick={() => setAsking(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      <p className="mt-8 text-xs text-ink-muted">Your decision is recorded with the time and your link, the same as approving in the portal.</p>
    </div>
  );
}
