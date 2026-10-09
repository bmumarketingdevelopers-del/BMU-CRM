"use client";

/** v11 ops: small shared bits for the ops action screens (proof upload, reason prompt, chips, CSV export). */
import { useState, type ReactNode } from "react";
import { ApiError } from "@bmu/shared";
import { api } from "@/lib/api";
import { ActionDialog, Field, inputCls, TextArea } from "@/components/actions/action-drawer";

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong. Try again.");
export const isConflict = (e: unknown) => e instanceof ApiError && e.status === 409;
export const todayIst = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
export const dayAhead = (n: number) => new Date(Date.now() + 5.5 * 3_600_000 + n * 86_400_000).toISOString().slice(0, 10);
export const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
export const fmtSize = (n: number | null) => (n === null ? "" : n > 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Upload a payment slip / cheque photo; returns the stored file id through onChange. */
export function ProofInput({ value, onChange, label = "Payment proof" }: { value: { id: string; name: string } | null; onChange: (v: { id: string; name: string } | null) => void; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <Field label={label} required error={error} hint="Photo or PDF of the bank slip, UPI screenshot, cheque or receipt.">
      {value ? (
        <div className="flex items-center justify-between gap-2 border border-border bg-surface-raised px-3 py-2 text-sm">
          <span className="truncate">{value.name}</span>
          <button type="button" className="text-xs text-ink-muted underline" onClick={() => onChange(null)}>
            Change
          </button>
        </div>
      ) : (
        <input
          type="file"
          accept="image/*,application/pdf"
          aria-label={label}
          disabled={busy}
          className={inputCls}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setBusy(true);
            setError(undefined);
            try {
              const r = await api.ops.files.proof(f);
              onChange({ id: r.id, name: r.name });
            } catch (err) {
              setError(errMsg(err));
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
      {busy && <span className="text-xs text-ink-muted">Uploading…</span>}
    </Field>
  );
}

/** "Why?" prompt used for lost reasons, archive, disconnect and other reason-required actions. */
export function ReasonDialog({
  open,
  title,
  label = "Reason",
  options,
  confirm,
  danger,
  onClose,
  onConfirm,
  children,
}: {
  open: boolean;
  title: string;
  label?: string;
  options?: readonly string[];
  confirm: string;
  danger?: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
  children?: ReactNode;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function go() {
    if (reason.trim().length < 3) return setError("Give a short reason (at least 3 characters)");
    setBusy(true);
    setError(undefined);
    try {
      await onConfirm(reason.trim());
      setReason("");
      onClose();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ActionDialog
      open={open}
      title={title}
      onClose={onClose}
      testId="reason-dialog"
      footer={
        <>
          <button type="button" disabled={busy} onClick={go} className={`px-4 py-2 text-sm font-medium text-ivory disabled:opacity-40 ${danger ? "bg-red" : "bg-charcoal"}`}>
            {busy ? "Saving…" : confirm}
          </button>
          <button type="button" onClick={onClose} className="ml-auto px-3 py-2 text-sm text-ink-muted hover:text-ink">
            Cancel
          </button>
        </>
      }
    >
      {children}
      {options && (
        <select className={inputCls} value="" aria-label="Common reasons" onChange={(e) => e.target.value && setReason(e.target.value)}>
          <option value="">Pick a common reason…</option>
          {options.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      )}
      <Field label={label} required error={error}>
        <TextArea value={reason} onChange={(e) => setReason(e.target.value)} aria-label={label} maxLength={500} />
      </Field>
    </ActionDialog>
  );
}

/** Square toggle chips (multi-select), e.g. services or niches. */
export function Chips({ options, value, onChange, label }: { options: { id: string; label: string }[]; value: string[]; onChange: (v: string[]) => void; label: string }) {
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label={label}>
      {options.map((o) => {
        const on = value.includes(o.id);
        return (
          <button key={o.id} type="button" aria-pressed={on} onClick={() => onChange(on ? value.filter((x) => x !== o.id) : [...value, o.id])} className={`border px-2.5 py-1 text-xs ${on ? "border-charcoal bg-charcoal text-ivory" : "border-border hover:border-ink"}`}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Empty state with the add action (spec: every empty list offers the way to add the first record). */
export function EmptyAdd({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="border border-dashed border-border px-6 py-10 text-center" data-testid="empty-state">
      <p className="font-medium">{title}</p>
      {body && <p className="mt-1 text-sm text-ink-muted">{body}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function AddButton({ onClick, children = "+ Add", testId }: { onClick: () => void; children?: ReactNode; testId?: string }) {
  return (
    <button type="button" onClick={onClick} className="bg-charcoal px-3 py-1.5 text-sm font-medium text-ivory hover:opacity-90" data-testid={testId}>
      {children}
    </button>
  );
}

export function GhostButton({ onClick, children, disabled, testId }: { onClick: () => void; children: ReactNode; disabled?: boolean; testId?: string }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="border border-border bg-surface-raised px-3 py-1.5 text-sm hover:border-ink disabled:opacity-40" data-testid={testId}>
      {children}
    </button>
  );
}
