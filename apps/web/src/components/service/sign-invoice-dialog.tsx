"use client";

// v28: the pop-up that adds the company seal and the Founder's signature to an invoice. It asks for the signing
// password; a held invoice is delivered to the client once it is signed. Closing it leaves the invoice unsigned and
// unsent. Wrong passwords are logged and, from the third, the Founders are alerted.
import { useState } from "react";
import { formatINR } from "@bmu/shared";
import { ActionDialog, Field, inputCls } from "@/components/actions/action-drawer";
import { api } from "@/lib/api";

export function SignInvoiceDialog({ invoice, onClose, onSigned }: { invoice: { id: string; number: string; totalPaise?: number; client?: string | null }; onClose: () => void; onSigned: (message: string) => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function sign() {
    if (!password) return setError("Enter the signing password");
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.service.signInvoice(invoice.id, password);
      onSigned(r.message);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ActionDialog
      open
      title={`Sign invoice ${invoice.number}`}
      onClose={onClose}
      testId="sign-invoice-dialog"
      footer={
        <>
          <button type="button" disabled={busy || !password} onClick={sign} className="bg-charcoal px-4 py-2 text-sm font-medium text-ivory disabled:opacity-40" data-testid="sign-invoice-confirm">
            {busy ? "Signing…" : "Add seal and signature"}
          </button>
          <button type="button" onClick={onClose} className="ml-auto px-3 py-2 text-sm text-ink-muted hover:text-ink">
            Not now
          </button>
        </>
      }
    >
      <p className="text-sm text-ink-muted">
        {invoice.client ? `${invoice.client}${invoice.totalPaise ? `, ${formatINR(invoice.totalPaise)}` : ""}. ` : ""}
        Enter the signing password to add the company seal and the Founder&apos;s signature. The invoice goes to the client only after it is signed.
      </p>
      <Field label="Signing password" required error={error}>
        <input
          className={inputCls}
          type="password"
          autoComplete="off"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sign()}
          aria-label="Signing password"
        />
      </Field>
      <p className="text-xs text-ink-muted">For security, every wrong password is recorded and the Founders are alerted after three.</p>
    </ActionDialog>
  );
}
