"use client";

import { useState } from "react";
import { DELIVER_APPROVAL_MODES, deliverApprovalModeLabels, type DeliverApprovalMode, type DeliverApprovalSettings } from "@bmu/shared";
import { Panel } from "@/components/dash";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

/** "Approvals need: any one approver | the owner | every approver". Client owners edit theirs; CMs edit from Client 360. */
export function ApprovalRuleCard({ clientOrgId }: { clientOrgId?: string }) {
  const loaded = useLoad(() => (clientOrgId ? api.deliver.clientApprovalSettings(clientOrgId) : api.deliver.approvalSettings()));
  const [fresh, setFresh] = useState<DeliverApprovalSettings>();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const s = fresh ?? loaded.data;

  async function save(mode: DeliverApprovalMode) {
    setError(undefined);
    setSaved(false);
    try {
      setFresh(clientOrgId ? await api.deliver.setClientApprovalMode(clientOrgId, mode) : await api.deliver.saveApprovalSettings(mode));
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Panel title="Who approves plans and work" subtitle="Applies to plan approvals and Review Studio.">
      {!s ? (
        <p className="text-sm text-ink-muted">{loaded.error ?? "Loading…"}</p>
      ) : (
        <div className="grid gap-3 text-sm" data-testid="approval-rule">
          {DELIVER_APPROVAL_MODES.map((m) => (
            <label key={m} className={`flex gap-2 border p-3 ${s.mode === m ? "border-charcoal" : "border-border"} ${s.canEdit ? "cursor-pointer" : ""}`}>
              <input type="radio" name={`approval-mode-${clientOrgId ?? "me"}`} className="mt-1" checked={s.mode === m} disabled={!s.canEdit} onChange={() => save(m)} />
              <span>
                <span className="font-medium">{deliverApprovalModeLabels[m].label}</span>
                <span className="block text-xs text-ink-muted">{deliverApprovalModeLabels[m].help}</span>
              </span>
            </label>
          ))}
          <p className="text-xs text-ink-muted">
            Approvers on this account: {s.approvers.length ? s.approvers.map((a) => `${a.name} (${a.role})`).join(", ") : "none yet"}.
            {!s.canEdit && " Only the account owner can change this."}
          </p>
          {saved && <p className="text-xs text-[#5f8a12]">Saved.</p>}
          {error && <p className="text-xs text-red">{error}</p>}
        </div>
      )}
    </Panel>
  );
}
