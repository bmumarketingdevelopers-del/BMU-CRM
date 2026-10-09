"use client";

import { use, useState } from "react";
import Link from "next/link";
import { clientDeliverableLabels, type ClientDeliverableDetail } from "@bmu/shared";
import { ReviewViewer } from "@/components/review-viewer";
import { Badge, Button, Card, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { ApprovalStatusBox } from "@/components/deliver/approval-status";
import { ProofRounds } from "@/components/creative/proof-rounds";

export default function ClientReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const loaded = useLoad(() => api.client.review(id));
  const [fresh, setFresh] = useState<ClientDeliverableDetail>();
  const [error, setError] = useState<string>();
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [seen, setSeen] = useState(loaded.data);
  if (seen !== loaded.data) {
    setSeen(loaded.data);
    setFresh(undefined);
  }
  const d = fresh ?? loaded.data;
  if (!d) return <LoadState loading={loaded.loading} error={loaded.error} />;
  const latest = d.versions.at(-1);
  const left = Math.max(0, d.revisionRounds.included - d.revisionRounds.used);

  async function act(fn: () => Promise<ClientDeliverableDetail>) {
    setBusy(true);
    setError(undefined);
    try {
      setFresh(await fn());
      setAsking(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageTitle
        title={d.title}
        subtitle={d.serviceName}
        action={
          <Link href="/client/reviews" className="text-sm underline">
            All work
          </Link>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <Badge tone={d.status === "approved" ? "green" : d.status === "ready_for_client" ? "amber" : "dark"}>{clientDeliverableLabels[d.status]}</Badge>
        <span className="text-ink-muted">
          {left > 0 ? `${left} revision round${left > 1 ? "s" : ""} left in your package` : "Included revision rounds used; further changes are quoted as an extra request"}
        </span>
      </div>
      {error && <p className="mb-4 border border-red bg-red/10 px-4 py-2 text-sm">{error}</p>}

      {d.can.approve && latest && !asking && (
        <Card className="mb-4 flex flex-wrap items-center justify-between gap-3 border-amber">
          <p className="text-sm">
            Version {latest.number} is ready. Add comments on the work below, then approve it or ask for changes.
          </p>
          <div className="flex gap-2">
            <Button disabled={busy} onClick={() => act(() => api.client.approveVersion(d.id, latest.id))}>
              Approve version {latest.number}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setAsking(true)}>
              Request changes
            </Button>
          </div>
        </Card>
      )}
      {asking && (
        <Card className="mb-4 border-amber">
          <p className="text-sm font-semibold">What should change?</p>
          <p className="text-xs text-ink-muted">Your pinned comments are sent too. Add anything else here (optional if you left comments).</p>
          <textarea className="mt-2 w-full border border-border bg-surface-raised px-3 py-2 text-sm" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="mt-2 flex gap-2">
            <Button disabled={busy} onClick={() => act(() => api.client.requestVersionChanges(d.id, note || undefined))}>
              Send to BMU
            </Button>
            <Button variant="ghost" onClick={() => setAsking(false)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}

      {d.approvalStatus && d.status === "ready_for_client" && (d.approvalStatus.mode !== "any" || d.approvalStatus.approvers.some((a) => a.approvedAt)) && (
        <div className="mb-4">
          <ApprovalStatusBox status={d.approvalStatus} remind={!d.can.approve && d.approvalStatus.approvers.some((a) => a.approvedAt) ? { target: "deliverable", id: d.id } : undefined} compact />
        </div>
      )}
      {d.approvalStatus?.satisfied && d.status !== "ready_for_client" && <p className="mb-4 text-sm text-ink-muted">{d.approvalStatus.summary}</p>}

      <Card>
        <ReviewViewer
          versions={d.versions}
          comments={d.comments}
          canComment={d.can.comment}
          onComment={async (versionId, draft) => {
            setFresh(await api.client.reviewComment(d.id, { versionId, body: draft.body, anchor: draft.anchor }));
          }}
        />
      </Card>
      {d.rounds && d.rounds.length > 0 && (
        <div className="mt-4">
          <ProofRounds rounds={d.rounds} certificate={d.certificate} certificateHref={`/client/reviews/${d.id}/certificate`} client />
        </div>
      )}
    </>
  );
}
