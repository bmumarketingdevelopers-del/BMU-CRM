"use client";

import { useState } from "react";
import type { ClientPlanView } from "@bmu/shared";
import { PlanComments, PlanContentView } from "@/components/plan-view";
import { Badge, Button, Card, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { deliverPeriodLabel } from "@bmu/shared";
import { ApprovalStatusBox } from "@/components/deliver/approval-status";

const day = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });

export default function ApprovalsPage() {
  const plans = useLoad(() => api.client.plans());
  const [fresh, setFresh] = useState<ClientPlanView[]>();
  const [error, setError] = useState<string>();
  const data = fresh ?? plans.data;
  if (!data) return <LoadState loading={plans.loading} error={plans.error} />;

  async function act(fn: () => Promise<ClientPlanView[]>) {
    setError(undefined);
    try {
      setFresh(await fn());
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <PageTitle title="Approvals" subtitle="Plans waiting for your go-ahead. Approving starts production; the plan is then locked." />
      {error && <p className="mb-4 border border-red bg-red/10 px-4 py-2 text-sm">{error}</p>}
      <div className="grid gap-4">
        {data.map((p) => (
          <PlanCard
            key={p.plan.id}
            p={p}
            onApprove={() => act(() => api.client.approvePlan(p.plan.id))}
            onChanges={(comment) => act(() => api.client.requestPlanChanges(p.plan.id, comment))}
          />
        ))}
        {data.length === 0 && (
          <Card>
            <p className="text-sm text-ink-muted">Nothing to approve right now. Your plan appears here once your strategist has prepared it.</p>
          </Card>
        )}
      </div>
    </>
  );
}

function PlanCard({ p, onApprove, onChanges }: { p: ClientPlanView; onApprove: () => Promise<void>; onChanges: (c: string) => Promise<void> }) {
  const [asking, setAsking] = useState(false);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => (setBusy(true), await fn(), setBusy(false));
  const status = p.plan.status;

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">
          {p.serviceName} plan{p.period && p.period !== "project" ? ` · ${deliverPeriodLabel(p.period)}` : ""}
        </h2>
        {status === "approved" ? (
          <Badge tone="green">Approved {p.plan.approvedAt && day.format(new Date(p.plan.approvedAt))}</Badge>
        ) : status === "changes_requested" ? (
          <Badge tone="neutral">Changes requested, BMU is updating it</Badge>
        ) : p.youApproved ? (
          <Badge tone="neutral">You approved, waiting for others</Badge>
        ) : (
          <Badge tone="amber">Waiting for you</Badge>
        )}
      </div>
      <PlanContentView content={p.plan.content} />
      <PlanComments plan={p.plan} />
      {p.plan.approvalStatus && status === "sent_to_client" && (p.plan.approvalStatus.mode !== "any" || p.youApproved) && (
        <div className="mt-4">
          <ApprovalStatusBox status={p.plan.approvalStatus} remind={p.youApproved ? { target: "plan", id: p.plan.id } : undefined} compact />
        </div>
      )}
      {status === "sent_to_client" && !asking && !p.youApproved && (
        <div className="mt-5 flex flex-wrap gap-2 border-t border-border pt-4">
          <Button disabled={busy} onClick={() => run(onApprove)}>
            Approve plan
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => setAsking(true)}>
            Request changes
          </Button>
        </div>
      )}
      {asking && (
        <form
          className="mt-5 grid gap-2 border-t border-border pt-4"
          onSubmit={(ev) => {
            ev.preventDefault();
            run(async () => {
              await onChanges(comment);
              setAsking(false);
            });
          }}
        >
          <textarea
            className="w-full border border-border bg-surface-raised px-3 py-2 text-sm"
            rows={3}
            value={comment}
            onChange={(ev) => setComment(ev.target.value)}
            placeholder="What should change?"
            required
          />
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              Send to BMU
            </Button>
            <Button type="button" variant="ghost" onClick={() => setAsking(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
