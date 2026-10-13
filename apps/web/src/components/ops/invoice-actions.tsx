"use client";

/** Invoice actions: move the due date (reason required; more than 7 days goes to a Branch Manager) and issue a draft. */
import { useState } from "react";
import { OPS_DUE_EXTENSION_FREE_DAYS, type CoreUndo } from "@bmu/shared";
import { api } from "@/lib/api";
import { ActionDialog, Field, inputCls, TextArea } from "@/components/actions/action-drawer";
import { errMsg, fmtDay, todayIst } from "./kit";

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

export function DueDateDialog({ invoice, onClose, onDone }: { invoice: { id: string; number: string; dueDate: string }; onClose: () => void; onDone: (message: string, undo?: CoreUndo | null) => void }) {
  const current = invoice.dueDate.slice(0, 10);
  const [dueDate, setDue] = useState(current);
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const shift = dueDate ? daysBetween(current, dueDate) : 0;
  const needsApproval = shift > OPS_DUE_EXTENSION_FREE_DAYS;

  async function go() {
    const e: Record<string, string> = {};
    if (!dueDate) e.due = "Pick the new due date";
    else if (dueDate === current) e.due = "Pick a different date";
    else if (dueDate < todayIst()) e.due = "The new due date is in the past";
    if (reason.trim().length < 3) e.reason = "Say why the due date moves";
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.ops.finance.dueDate(invoice.id, { dueDate, reason: reason.trim() });
      onDone(r.message, r.undo ?? null);
      onClose();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ActionDialog
      open
      title={`Change the due date of ${invoice.number}`}
      onClose={onClose}
      testId="due-date-dialog"
      footer={
        <>
          <button type="button" disabled={busy} onClick={go} className="bg-charcoal px-4 py-2 text-sm font-medium text-ivory disabled:opacity-40">
            {busy ? "Saving…" : needsApproval ? "Ask a Branch Manager" : "Change due date"}
          </button>
          <button type="button" onClick={onClose} className="ml-auto px-3 py-2 text-sm text-ink-muted hover:text-ink">
            Cancel
          </button>
        </>
      }
    >
      <p className="text-sm text-ink-muted">Now due {fmtDay(invoice.dueDate)}. Moves of more than {OPS_DUE_EXTENSION_FREE_DAYS} days need a Branch Manager&apos;s approval.</p>
      <Field label="New due date" required error={errors.due} hint={shift ? `${shift > 0 ? `${shift} days later` : `${-shift} days earlier`}${needsApproval ? " · needs Branch Manager approval" : ""}` : undefined}>
        <input className={inputCls} type="date" min={todayIst()} value={dueDate} onChange={(e) => setDue(e.target.value)} aria-label="New due date" />
      </Field>
      <Field label="Reason" required error={errors.reason}>
        <TextArea value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" maxLength={500} placeholder="e.g. Client's finance team pays on the 10th" />
      </Field>
      {error && <p className="text-sm text-red" role="alert">{error}</p>}
    </ActionDialog>
  );
}
