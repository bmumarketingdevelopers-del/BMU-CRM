"use client";

import { useState } from "react";
import type { DeliverApprovalStatus } from "@bmu/shared";
import { Badge, Button } from "@/components/ui";
import { api } from "@/lib/api";

const when = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

/**
 * Who has approved and who is still needed under the client's approval rule.
 * `remind` shows a "Remind" button (AM, or a client owner/approver nudging co-approvers).
 */
export function ApprovalStatusBox({ status, remind, compact = false }: { status: DeliverApprovalStatus; remind?: { target: "deliverable" | "plan"; id: string }; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const [error, setError] = useState<string>();

  async function nudge() {
    if (!remind) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.deliver.remind(remind.target, remind.id);
      setMsg(`Reminder sent to ${r.reminded.join(", ")}.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`border border-border bg-canvas/40 ${compact ? "p-3" : "p-4"} text-sm`} data-testid="approval-status">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">
          Approval rule: <span className="font-normal">{status.modeLabel}</span>
        </p>
        {status.satisfied ? <Badge tone="green">Approved</Badge> : <Badge tone="amber">Waiting for approval</Badge>}
      </div>
      <ul className="mt-2 space-y-1">
        {status.approvers.map((a) => (
          <li key={a.userId} className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span>
              {a.name} <span className="text-ink-muted">· {a.role === "owner" ? "Owner" : "Approver"}{a.required ? " · must approve" : ""}</span>
            </span>
            {a.approvedAt ? <span className="text-[#5f8a12]">✓ Approved {when.format(new Date(a.approvedAt))}</span> : <span className="text-ink-muted">{status.satisfied ? "Not needed" : "Pending"}</span>}
          </li>
        ))}
        {status.approvers.length === 0 && <li className="text-xs text-ink-muted">No owners or approvers on this account yet.</li>}
      </ul>
      {!status.satisfied && <p className="mt-2 text-xs text-ink-muted">{status.summary}</p>}
      {remind && !status.satisfied && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button variant="secondary" className="px-2 py-1 text-xs" disabled={busy} onClick={nudge}>
            Remind pending approvers
          </Button>
          {msg && <span className="text-xs text-[#5f8a12]">{msg}</span>}
          {error && <span className="text-xs text-red">{error}</span>}
        </div>
      )}
    </div>
  );
}
