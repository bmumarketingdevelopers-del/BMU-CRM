"use client";

import { useState } from "react";
import Link from "next/link";
import { formatINR, sellApprovalLevelLabels, type SellApprovalInbox, type SellApprovalItem } from "@bmu/shared";
import { Empty, Panel } from "@/components/dash";
import { Badge, Button, Input, LoadState } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const dt = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
const tone = { approved: "green", rejected: "red", pending: "amber", waiting: "neutral", cancelled: "neutral" } as const;

export function ApprovalsInbox() {
  const loaded = useLoad(() => api.sell.approvals());
  const [data, setData] = useState<SellApprovalInbox>();
  const v = data ?? loaded.data;
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [rejecting, setRejecting] = useState<string>();

  async function decide(item: SellApprovalItem, approve: boolean) {
    const note = notes[item.stepId]?.trim();
    if (!approve && (!note || note.length < 3)) {
      setRejecting(item.stepId);
      setError("Write a short reason so sales knows what to change.");
      return;
    }
    setBusy(item.stepId);
    setError(undefined);
    setNotice(undefined);
    try {
      setData(approve ? await api.sell.approve(item.stepId, note || undefined) : await api.sell.reject(item.stepId, note!));
      setNotice(approve ? `Approved the ${item.extraDiscountPct}% discount for ${item.client}.` : `Rejected the discount for ${item.client}. Sales has been notified.`);
      setRejecting(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  if (!v) return <LoadState loading={loaded.loading} error={loaded.error} />;
  const limits = Object.entries(v.limits);

  return (
    <div className="space-y-6">
      {error && <p className="border border-red bg-red/10 px-4 py-2 text-sm" role="alert">{error}</p>}
      {notice && <p className="border border-green bg-green/10 px-4 py-2 text-sm" role="status">{notice}</p>}
      <p className="text-sm text-ink-muted">
        Current limits without approval: {limits.length ? limits.map(([role, pct]) => `${role.replace("_", " ")} ${pct}%`).join(" · ") : "none set"}. Change them under Command Centre → Discount Limits.
      </p>

      <Panel title={`Waiting for a decision (${v.pending.length})`}>
        {v.pending.length === 0 ? (
          <Empty>Nothing to approve right now.</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {v.pending.map((i) => (
              <li key={i.stepId} className="grid gap-3 py-4 lg:grid-cols-[1fr_auto]" data-approval={i.proposalId}>
                <div>
                  <p className="font-semibold">
                    <Link href={`/team/proposals/${i.proposalId}`} className="underline-offset-2 hover:underline">
                      {i.client}
                    </Link>{" "}
                    <span className="font-normal text-ink-muted">· proposal v{i.version}</span>
                  </p>
                  <p className="text-sm">
                    <strong>{i.extraDiscountPct}% special discount</strong> · total {formatINR(i.totalPaise)} after {formatINR(i.discountPaise)} off · asked by {i.createdBy ?? "sales"} {dt.format(new Date(i.requestedAt))}
                  </p>
                  <ol className="mt-2 flex flex-wrap gap-2 text-xs">
                    {i.steps.map((s) => (
                      <li key={s.id} className="flex items-center gap-1">
                        Step {s.step}: {sellApprovalLevelLabels[s.level]} <Badge tone={tone[s.status]}>{s.status === "waiting" ? "next" : s.status}</Badge>
                        {s.decider && <span className="text-ink-muted">({s.decider}{s.note ? `: “${s.note}”` : ""})</span>}
                      </li>
                    ))}
                  </ol>
                </div>
                <div className="grid content-start gap-2 lg:w-72">
                  {i.canDecide ? (
                    <>
                      <Input aria-label={`Note for ${i.client}`} placeholder={rejecting === i.stepId ? "Reason for rejecting (required)" : "Note (optional)"} value={notes[i.stepId] ?? ""} onChange={(e) => setNotes({ ...notes, [i.stepId]: e.target.value })} />
                      <div className="flex gap-2">
                        <Button disabled={busy === i.stepId} onClick={() => decide(i, true)}>
                          Approve
                        </Button>
                        <Button variant="secondary" disabled={busy === i.stepId} onClick={() => decide(i, false)}>
                          Reject
                        </Button>
                      </div>
                    </>
                  ) : (
                    <p className="text-sm text-ink-muted">You made this proposal, so someone else must approve it.</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Your recent decisions">
        {v.decided.length === 0 ? (
          <Empty>No decisions yet.</Empty>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {v.decided.map((i) => (
              <li key={i.stepId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <Link href={`/team/proposals/${i.proposalId}`} className="underline">
                    {i.client}
                  </Link>{" "}
                  · {i.extraDiscountPct}% · {sellApprovalLevelLabels[i.level]} step
                  {i.note && <span className="text-ink-muted"> · “{i.note}”</span>}
                </span>
                <span className="flex items-center gap-2 text-xs text-ink-muted">
                  {i.decidedAt && dt.format(new Date(i.decidedAt))} <Badge tone={tone[i.status]}>{i.status}</Badge>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
