"use client";

import { useEffect, useState } from "react";
import type { AiDigestView } from "@bmu/shared";
import { Button } from "@/components/ui";
import { api } from "@/lib/api";
import { aiFeatureOn, useAiStatus } from "@/lib/ai";
import { AiNotice, AiPanel } from "./ai-panel";
import { AiText } from "./ai-text";

const when = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

/** Weekly digest (written every Monday 9 am, or on demand) plus anomaly notes, on the Weekly Review. */
export function AiWeeklyDigest() {
  const status = useAiStatus();
  const [digest, setDigest] = useState<AiDigestView | null>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const on = !!status && aiFeatureOn(status, "weekly_digest");

  useEffect(() => {
    if (!on) return;
    let live = true;
    api.ai
      .digest()
      .then((d) => live && setDigest(d))
      .catch(() => live && setDigest(null));
    return () => {
      live = false;
    };
  }, [on]);

  if (!on) return null;

  async function make() {
    setBusy(true);
    setError(undefined);
    try {
      setDigest(await api.ai.makeDigest());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id="ai-digest" className="grid gap-4 [&>*]:min-w-0 lg:grid-cols-[3fr_2fr]">
      <section className="border border-border bg-surface-raised p-5" aria-label="Weekly digest">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 font-semibold">
              <span aria-hidden className="inline-block size-2 bg-green" />
              Weekly digest
            </h3>
            <p className="mt-0.5 text-xs text-ink-muted">{digest ? `Written ${when.format(new Date(digest.createdAt))}. A new one arrives every Monday at 9 am.` : "Written every Monday at 9 am from this week's numbers."}</p>
          </div>
          <Button type="button" variant={digest ? "secondary" : "primary"} onClick={make} disabled={busy}>
            {busy ? "Writing…" : digest ? "Refresh now" : "Write this week's digest"}
          </Button>
        </div>
        {error && (
          <p className="mt-3 border border-red bg-red/10 px-3 py-2 text-sm" role="alert">
            {error}
          </p>
        )}
        {digest === undefined && <p className="mt-4 text-sm text-ink-muted">Loading…</p>}
        {digest === null && !busy && <p className="mt-4 text-sm text-ink-muted">No digest yet. Write one now to see the week in a few lines.</p>}
        {digest && (
          <div className="mt-4 border-t border-border pt-4">
            <div className="mb-3">
              <AiNotice result={digest} canManage={status?.canManage} />
            </div>
            <AiText text={digest.text} />
          </div>
        )}
      </section>
      <AiPanel feature="anomaly_notes" options={{ page: "weekly" }} title="What stands out" description="Unusual moves in this week's numbers. Worked out from the figures on this page only." buttonLabel="Explain the numbers" />
    </div>
  );
}
