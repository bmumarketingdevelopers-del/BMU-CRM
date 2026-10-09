"use client";

import Link from "next/link";
import { use, useState } from "react";
import type { BriefDetail } from "@bmu/shared";
import { Panel } from "@/components/dash";
import { BriefStatusBadge, BriefSummary, SubmissionHistory, SubmitWork } from "@/components/workspace/brief-bits";
import { Button, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const nextStep: Record<string, string> = {
  offered: "Read the brief, then accept it to start.",
  accepted: "When your work is ready, send it below.",
  submitted: "BMU is reviewing your latest version. You'll be notified.",
  revision: "BMU asked for changes. Read the feedback and send a new version.",
  approved: "Approved. Your payout is booked.",
  paid: "Approved and paid. Thank you!",
  declined: "You declined this brief.",
  cancelled: "BMU cancelled this brief.",
};

export default function CreatorBriefPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const loaded = useLoad(() => api.creator.brief(id));
  const [fresh, setFresh] = useState<BriefDetail>();
  const [error, setError] = useState<string>();
  const b = fresh ?? loaded.data;

  async function respond(accept: boolean) {
    setError(undefined);
    try {
      setFresh(await (accept ? api.creator.accept(id) : api.creator.decline(id)));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="[&_.grid>*]:min-w-0">
      <Link href="/creator" className="text-sm text-ink-muted hover:text-ink">
        ← Briefs
      </Link>
      {!b ? (
        <div className="mt-6">
          <LoadState loading={loaded.loading} error={loaded.error} />
        </div>
      ) : (
        <div className="[&_.grid>*]:min-w-0">
          <PageTitle title={b.title} subtitle={nextStep[b.status]} action={<BriefStatusBadge status={b.status} creatorView />} />
          {error && <p className="mb-4 border border-red bg-red/10 px-4 py-2 text-sm">{error}</p>}
          {b.status === "offered" && (
            <Panel className="mb-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm">Can you take this on by the due date?</p>
                <div className="flex gap-2">
                  <Button onClick={() => respond(true)}>Accept brief</Button>
                  <Button variant="secondary" onClick={() => respond(false)}>
                    Decline
                  </Button>
                </div>
              </div>
            </Panel>
          )}
          <BriefSummary b={b} />
          <div className="mt-6 grid gap-6 lg:grid-cols-[2fr_1fr]">
            <SubmissionHistory b={b} />
            {["accepted", "revision"].includes(b.status) && (
              <div className="self-start">
                <SubmitWork
                  title={b.status === "revision" ? "Send a new version" : "Send your work"}
                  onFile={async (file, note) => setFresh(await api.creator.uploadSubmission(id, file, note))}
                  onLink={async (url, note) => setFresh(await api.creator.linkSubmission(id, url, note))}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
