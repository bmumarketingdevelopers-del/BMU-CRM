"use client";

import { useState } from "react";
import Link from "next/link";
import { formatINR, sellApprovalLevelLabels, type SellMyDiscount } from "@bmu/shared";
import { Empty, Panel, Tabs } from "@/components/dash";
import { Badge, LoadState } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const dt = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
const stepTone = { approved: "green", rejected: "red", pending: "amber", waiting: "neutral", cancelled: "neutral" } as const;
const statusTone = { approved: "green", rejected: "red", pending: "amber" } as const;

type Tab = "pending" | "approved" | "history";

/** Sales Executive's Approvals page: only the discounts they asked for on their own proposals. */
export function MyDiscounts() {
  const loaded = useLoad(() => api.sell.myDiscounts());
  const [tab, setTab] = useState<Tab>("pending");
  const v = loaded.data;
  if (!v) return <LoadState loading={loaded.loading} error={loaded.error} />;

  const list = v[tab];
  const empty = {
    pending: "No discounts waiting for approval.",
    approved: "No approved discounts yet.",
    history: "No approved or rejected discounts yet.",
  }[tab];

  return (
    <div className="space-y-4" data-testid="my-discounts">
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        options={[
          { value: "pending", label: `Pending (${v.pending.length})` },
          { value: "approved", label: `Approved (${v.approved.length})` },
          { value: "history", label: `History (${v.history.length})` },
        ]}
      />
      <Panel>
        {list.length === 0 ? (
          <Empty>{empty}</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {list.map((d) => (
              <DiscountRow key={d.proposalId} d={d} tab={tab} />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function DiscountRow({ d, tab }: { d: SellMyDiscount; tab: Tab }) {
  const rejectNote = d.steps.find((s) => s.status === "rejected")?.note;
  return (
    <li className="grid gap-2 py-4 lg:grid-cols-[1fr_auto]" data-discount={d.proposalId}>
      <div>
        <p className="font-semibold">
          <Link href={`/team/proposals/${d.proposalId}`} className="underline-offset-2 hover:underline">
            {d.client}
          </Link>{" "}
          <span className="font-normal text-ink-muted">· proposal v{d.version}</span>
        </p>
        <p className="text-sm">
          <strong>{d.extraDiscountPct}% special discount</strong> ({formatINR(d.extraDiscountPaise)} off) · total {formatINR(d.totalPaise)} · asked {dt.format(new Date(d.requestedAt))}
        </p>
        <ol className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {d.steps.map((s) => (
            <li key={s.id} className="flex items-center gap-1">
              Step {s.step}: {sellApprovalLevelLabels[s.level]} <Badge tone={stepTone[s.status]}>{s.status === "waiting" ? "next" : s.status}</Badge>
              {s.decider && (
                <span className="text-ink-muted">
                  ({s.decider}
                  {s.decidedAt ? `, ${dt.format(new Date(s.decidedAt))}` : ""}
                  {s.note ? `: “${s.note}”` : ""})
                </span>
              )}
            </li>
          ))}
        </ol>
        {d.discountStatus === "rejected" && rejectNote && <p className="mt-2 text-sm text-red">Reason: “{rejectNote}”. Make a new version with a smaller discount.</p>}
      </div>
      <div className="flex flex-col items-start gap-1 text-sm lg:items-end">
        {tab === "history" && <Badge tone={statusTone[d.discountStatus]}>{d.discountStatus}</Badge>}
        {d.discountStatus === "pending" && <span className="text-ink-muted">Waiting for {d.waitingFor === "founder" ? "the Founder" : "a sales manager"}</span>}
        {d.discountStatus === "approved" && (
          <span className="text-ink-muted">{d.sentAt ? `Sent to client ${dt.format(new Date(d.sentAt))}` : d.proposalStatus === "draft" ? "Ready to send" : `Proposal ${d.proposalStatus}`}</span>
        )}
        {d.decidedAt && <span className="text-xs text-ink-muted">Decided {dt.format(new Date(d.decidedAt))}</span>}
      </div>
    </li>
  );
}
