"use client";

import Link from "next/link";
import { use, useState } from "react";
import type { DeliverHandoverView } from "@bmu/shared";
import { FeedbackForm, HandoverContents } from "@/components/deliver/handover";
import { Panel } from "@/components/dash";
import { Badge, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const when = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });

/** Final delivery: every approved final file, link and login handed over, one-click zip, and a feedback step. */
export default function ClientHandoverPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const loaded = useLoad(() => api.deliver.handover(id));
  const [fresh, setFresh] = useState<DeliverHandoverView>();
  const v = fresh ?? loaded.data;
  if (!v) return <LoadState loading={loaded.loading} error={loaded.error} />;

  return (
    <>
      <PageTitle
        title={`Final delivery: ${v.serviceName}`}
        subtitle={v.released ? "Everything we made for you, ready to download, plus the logins and links we handed over." : "Your final files unlock once you sign off and the final invoice is paid."}
        action={
          <Link href="/client/files" className="text-sm underline">
            All files
          </Link>
        }
      />
      <div className="mb-6 flex flex-wrap items-center gap-2 text-sm">
        {v.released ? <Badge tone="green">Delivered</Badge> : <Badge tone="amber">Not released yet</Badge>}
        {v.signedOffAt && <span className="text-ink-muted">Signed off {when.format(new Date(v.signedOffAt))}</span>}
      </div>
      <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        <Panel title="Handover pack">
          <HandoverContents v={v} onChange={setFresh} />
        </Panel>
        <Panel title="How did we do?" subtitle="Your answer goes straight to your client manager and BMU leadership.">
          {v.can.giveFeedback ? (
            <FeedbackForm v={v} onChange={setFresh} />
          ) : (
            <p className="text-sm text-ink-muted">You can rate the work after the final sign-off.</p>
          )}
        </Panel>
      </div>
    </>
  );
}
