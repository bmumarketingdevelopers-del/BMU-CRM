"use client";

import Link from "next/link";
import { use, useState } from "react";
import type { BriefDetail } from "@bmu/shared";
import { Panel } from "@/components/dash";
import { BriefStatusBadge, BriefSummary, SubmissionHistory, SubmitWork } from "@/components/workspace/brief-bits";
import { Button, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { BriefOpsPanels } from "@/components/ops/brief-ops";

export default function TeamBriefPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const loaded = useLoad(() => api.creatorAdmin.brief(id));
  const [fresh, setFresh] = useState<BriefDetail>();
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const b = fresh ?? loaded.data;

  async function act(fn: () => Promise<BriefDetail>) {
    setBusy(true);
    setError(undefined);
    try {
      setFresh(await fn());
      setFeedback("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="[&_.grid>*]:min-w-0">
      <Link href="/team/creators" className="text-sm text-ink-muted hover:text-ink">
        ← Creators
      </Link>
      {!b ? (
        <div className="mt-6">
          <LoadState loading={loaded.loading} error={loaded.error} />
        </div>
      ) : (
        <div className="[&_.grid>*]:min-w-0">
          <PageTitle title={b.title} subtitle={`For ${b.creator.name}${b.client ? ` · ${b.client.name}` : ""}`} action={<BriefStatusBadge status={b.status} />} />
          {error && <p className="mb-4 border border-red bg-red/10 px-4 py-2 text-sm">{error}</p>}

          {b.status === "submitted" && (
            <Panel title={`Review version ${b.submissionList.at(-1)?.number ?? ""}`} subtitle="Approve to book the payout, or send feedback for a revision" className="mb-6">
              <textarea className="w-full border border-border bg-surface-raised px-3 py-2 text-sm" rows={3} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="What should the creator change? (needed only to ask for a revision)" aria-label="Feedback" />
              <div className="mt-3 flex flex-wrap gap-2">
                <Button disabled={busy} onClick={() => act(() => api.creatorAdmin.approve(id))}>
                  Approve and book payout
                </Button>
                <Button variant="secondary" disabled={busy || feedback.trim().length < 3} onClick={() => act(() => api.creatorAdmin.feedback(id, feedback))}>
                  Ask for a revision
                </Button>
              </div>
            </Panel>
          )}

          <BriefSummary b={b} />
          <div className="mt-6 grid gap-6 lg:grid-cols-[2fr_1fr]">
            <SubmissionHistory b={b} />
            <div className="grid content-start gap-6">
              <BriefOpsPanels b={b} onChanged={() => (setFresh(undefined), loaded.reload())} />
              {["accepted", "revision"].includes(b.status) && (
                <SubmitWork
                  title="Add a version for the creator"
                  onFile={async (file, note) => setFresh(await api.creatorAdmin.uploadSubmission(id, file, note))}
                  onLink={async (url, note) => setFresh(await api.creatorAdmin.linkSubmission(id, url, note))}
                />
              )}
              {["offered", "accepted", "submitted", "revision"].includes(b.status) && (
                <Panel title="Cancel brief" subtitle="The creator is told it is no longer needed">
                  <Button variant="secondary" disabled={busy} onClick={() => confirm("Cancel this brief?") && act(() => api.creatorAdmin.cancel(id))}>
                    Cancel brief
                  </Button>
                </Panel>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
