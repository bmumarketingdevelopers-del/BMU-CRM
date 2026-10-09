"use client";

/**
 * ApprovalsList: generic ApprovalRequest inbox (reassignments over 120% or onto leave, producer deadline requests,
 * "Can't take this" hand-backs, new tasks for someone on leave, and anything other areas register).
 *
 *   <ApprovalsList box="mine" />       // "Needs you" on /team/approvals
 *   <ApprovalsList box="requested" />  // what I asked for (withdraw)
 *   <ApprovalsList box="all" />        // Command Centre queue (admins), with a status filter
 *
 * Approve/Reject with a note; requests that need an extra input (approveNeeds "assignee") ask for the new owner.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { coreApprovalStatusLabels, type CoreApprovalView, type CoreCandidate } from "@bmu/shared";
import { Badge } from "@/components/ui";
import { api } from "@/lib/api";
import { useActionsMaybe } from "./actions-provider";
import { ActionDialog, Field, TextArea } from "./action-drawer";
import { PersonPicker } from "./person-picker";

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
const tone = (s: string) => (s === "approved" ? "green" : s === "rejected" ? "red" : s === "pending" ? "amber" : "neutral");

export function ApprovalsList({ box, title, subtitle, emptyText, status: initialStatus }: { box: "mine" | "requested" | "all"; title?: string; subtitle?: string; emptyText?: string; status?: string }) {
  const actions = useActionsMaybe();
  const [status, setStatus] = useState(initialStatus ?? (box === "mine" ? "pending" : ""));
  const [rows, setRows] = useState<CoreApprovalView[]>();
  const [error, setError] = useState<string>();
  const [deciding, setDeciding] = useState<{ a: CoreApprovalView; decision: "approve" | "reject" }>();
  const [n, setN] = useState(0);
  const version = actions?.version ?? 0;

  useEffect(() => {
    let live = true;
    api.actions.approvals
      .list(box, status || undefined)
      .then((r) => {
        if (!live) return;
        setRows(r);
        setError(undefined);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [box, status, version, n]);

  async function cancel(a: CoreApprovalView) {
    if (!window.confirm("Withdraw this request?")) return;
    try {
      await api.actions.approvals.cancel(a.id);
      actions?.notify("Request withdrawn");
      actions?.changed();
      setN((x) => x + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section data-testid={`approvals-${box}`}>
      {(title || box !== "mine") && (
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            {title && <h2 className="font-display text-xl">{title}</h2>}
            {subtitle && <p className="text-sm text-ink-muted">{subtitle}</p>}
          </div>
          {box !== "mine" && (
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="border border-border bg-surface-raised px-2 py-1 text-sm" aria-label="Status">
              <option value="">All statuses</option>
              {Object.entries(coreApprovalStatusLabels).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="border border-red bg-red/10 px-3 py-2 text-sm">
          {error}
        </p>
      )}
      {!rows && !error && <p className="py-4 text-sm text-ink-muted">Loading…</p>}
      {rows && rows.length === 0 && <p className="border border-border bg-surface-raised px-4 py-6 text-center text-sm text-ink-muted">{emptyText ?? "Nothing waiting."}</p>}
      {rows && rows.length > 0 && (
        <ul className="grid gap-2">
          {rows.map((a) => (
            <li key={a.id} className="border border-border bg-surface-raised px-4 py-3 text-sm" data-approval={a.id}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-[0.1em] text-ink-muted">{a.actionLabel}</p>
                  <p className="font-medium">{a.targetHref ? <Link href={a.targetHref} className="hover:underline">{a.summary}</Link> : a.summary}</p>
                  <p className="text-xs text-ink-muted">
                    Asked by {a.requestedBy.name} · {when(a.createdAt)}
                    {a.status === "pending" && ` · expires ${when(a.expiresAt)}`}
                    {a.approver && box !== "mine" && ` · with ${a.approver.name}`}
                  </p>
                </div>
                <Badge tone={tone(a.status)}>{coreApprovalStatusLabels[a.status]}</Badge>
              </div>
              {a.reason && <p className="mt-1.5">“{a.reason}”</p>}
              {a.diff.length > 0 && (
                <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 text-xs">
                  {a.diff.map((d) => (
                    <div key={d.field} className="contents">
                      <dt className="text-ink-muted">{d.field}</dt>
                      <dd>
                        {d.before ?? "—"} → <span className="font-medium">{d.after ?? "—"}</span>
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              {a.decisionNote && <p className="mt-1.5 text-xs">Note from {a.decidedBy?.name ?? "approver"}: {a.decisionNote}</p>}
              {(a.canDecide || a.canCancel) && a.status === "pending" && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {a.canDecide && (
                    <>
                      <button type="button" className="bg-charcoal px-3 py-1 text-xs font-medium text-ivory" onClick={() => setDeciding({ a, decision: "approve" })}>
                        Approve
                      </button>
                      <button type="button" className="border border-border px-3 py-1 text-xs" onClick={() => setDeciding({ a, decision: "reject" })}>
                        Reject
                      </button>
                    </>
                  )}
                  {a.canCancel && (
                    <button type="button" className="px-2 py-1 text-xs text-ink-muted underline" onClick={() => cancel(a)}>
                      Withdraw
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {deciding && (
        <DecideDialog
          approval={deciding.a}
          decision={deciding.decision}
          onClose={() => setDeciding(undefined)}
          onDone={(r) => {
            setDeciding(undefined);
            actions?.notify(r.status === "approved" ? "Approved and done" : "Rejected; they have been told");
            actions?.changed();
            setN((x) => x + 1);
          }}
        />
      )}
    </section>
  );
}

function DecideDialog({ approval, decision, onClose, onDone }: { approval: CoreApprovalView; decision: "approve" | "reject"; onClose: () => void; onDone: (a: CoreApprovalView) => void }) {
  const [note, setNote] = useState("");
  const [toUserId, setToUserId] = useState<string>();
  const [people, setPeople] = useState<CoreCandidate[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const needsPerson = decision === "approve" && approval.approveNeeds === "assignee";

  useEffect(() => {
    if (!needsPerson) return;
    let live = true;
    api.actions.reassign
      .candidates(approval.targetType, [approval.targetId])
      .then((c) => live && setPeople(c.candidates))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [needsPerson, approval.targetType, approval.targetId]);

  async function submit() {
    setError(undefined);
    if (decision === "reject" && note.trim().length < 3) return setError("Say why you are rejecting it");
    if (needsPerson && !toUserId) return setError("Pick who takes it over");
    setBusy(true);
    try {
      onDone(await api.actions.approvals.decide(approval.id, { decision, note: note.trim() || undefined, input: needsPerson ? { toUserId } : undefined }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ActionDialog
      open
      title={decision === "approve" ? "Approve request" : "Reject request"}
      onClose={onClose}
      testId="decide-dialog"
      footer={
        <>
          <button type="button" className="bg-charcoal px-4 py-2 text-sm font-medium text-ivory disabled:opacity-40" disabled={busy} onClick={submit}>
            {busy ? "Saving…" : decision === "approve" ? "Approve" : "Reject"}
          </button>
          <button type="button" className="border border-border px-3 py-2 text-sm" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <p>{approval.summary}</p>
      {needsPerson && (
        <Field label="Who takes it over" required>
          {people ? <PersonPicker candidates={people} value={toUserId} onChange={setToUserId} /> : <p className="text-xs text-ink-muted">Loading people…</p>}
        </Field>
      )}
      <Field label={decision === "reject" ? "Why" : "Note (optional)"} required={decision === "reject"}>
        <TextArea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} aria-label="Decision note" />
      </Field>
      {error && (
        <p role="alert" className="text-sm text-red">
          {error}
        </p>
      )}
    </ActionDialog>
  );
}
