"use client";

// v27: the Founder's signature and the company seal printed on every invoice (above "Authorised Signatory").
// Founders upload or change them at any time; others see what is in use.
// v28: the signing password, the rule "invoices reach the client only after they are signed", and the invoices
// waiting for the seal and signature.
import Link from "next/link";
import { useRef, useState } from "react";
import { formatINR, INVOICE_IMAGE_MAX_BYTES, INVOICE_IMAGE_TYPES, type InvoiceBrandingKind, type InvoiceBrandingView } from "@bmu/shared";
import { SignInvoiceDialog } from "./sign-invoice-dialog";
import { Panel } from "@/components/dash";
import { Button, Input, LoadState } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const LABEL: Record<InvoiceBrandingKind, string> = { signature: "Founder's signature", seal: "Company seal" };
const HINT: Record<InvoiceBrandingKind, string> = {
  signature: "Sign on white paper, photograph or scan it, and crop close to the signature. A PNG with a transparent background looks best.",
  seal: "A round or square stamp of the company seal. PNG with a transparent background looks best.",
};

export function InvoiceBrandingPanel() {
  const state = useLoad(() => api.service.invoiceBranding(), { live: false });
  if (!state.data) return <LoadState loading={state.loading} error={state.error} />;
  return <Editor initial={state.data} />;
}

function Editor({ initial }: { initial: InvoiceBrandingView }) {
  const [b, setB] = useState(initial);
  const [name, setName] = useState(initial.signatoryName);
  const [designation, setDesignation] = useState(initial.designation);
  const [msg, setMsg] = useState<{ text: string; error: boolean }>();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<InvoiceBrandingView>, ok: string) => {
    setBusy(key);
    setMsg(undefined);
    try {
      setB(await fn());
      setMsg({ text: ok, error: false });
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Panel
      className="min-w-0"
      title="Signature and company seal"
      subtitle={b.canEdit ? "Printed on every invoice and receipt above “Authorised Signatory”. Change them whenever you need to." : "Only a Founder can change these"}
    >
      <div className="grid gap-6 md:grid-cols-2" data-testid="invoice-branding">
        {(["signature", "seal"] as const).map((kind) => (
          <ImageSlot key={kind} kind={kind} current={b[kind]} canEdit={b.canEdit} busy={busy === kind} onUpload={(f) => run(kind, () => api.service.uploadInvoiceBranding(kind, f), `${LABEL[kind]} saved. New and existing invoices now show it.`)} onRemove={() => window.confirm(`Remove the ${LABEL[kind].toLowerCase()} from invoices?`) && run(kind, () => api.service.removeInvoiceBranding(kind), `${LABEL[kind]} removed.`)} />
        ))}
      </div>
      <div className="mt-6 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <label className="block text-sm">
          <span className="text-xs font-medium">Name under the signature</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} disabled={!b.canEdit} placeholder="e.g. Mukesh" aria-label="Signatory name" />
        </label>
        <label className="block text-sm">
          <span className="text-xs font-medium">Designation</span>
          <Input value={designation} onChange={(e) => setDesignation(e.target.value)} maxLength={80} disabled={!b.canEdit} placeholder="Founder" aria-label="Designation" />
        </label>
        {b.canEdit && (
          <Button disabled={busy === "names"} onClick={() => run("names", () => api.service.saveInvoiceBranding({ signatoryName: name.trim(), designation: designation.trim() }), "Saved.")}>
            Save
          </Button>
        )}
      </div>
      {msg && <p className={`mt-3 text-sm ${msg.error ? "text-red" : "text-ink-muted"}`}>{msg.text}</p>}
      <Signing b={b} onChange={setB} />
    </Panel>
  );
}

const day = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });

/** v28: signing password, the rule, and the invoices waiting for the seal and signature. */
function Signing({ b, onChange }: { b: InvoiceBrandingView; onChange: (v: InvoiceBrandingView) => void }) {
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [changing, setChanging] = useState(!b.passwordSet);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error: boolean }>();
  const [signing, setSigning] = useState<InvoiceBrandingView["waiting"][number] | null>(null);
  const run = async (fn: () => Promise<InvoiceBrandingView>, ok: string) => {
    setBusy(true);
    setMsg(undefined);
    try {
      onChange(await fn());
      setMsg({ text: ok, error: false });
      return true;
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
      return false;
    } finally {
      setBusy(false);
    }
  };
  const ready = b.passwordSet && !!b.signature && !!b.seal;
  return (
    <div className="mt-8 border-t border-border pt-6" data-testid="invoice-signing">
      <p className="text-sm font-medium">Signing password</p>
      <p className="mt-1 text-xs text-ink-muted">
        The seal and signature go on an invoice only when someone enters this password. Share it only with the people you trust to sign invoices. It is stored encrypted and can be changed any time.
      </p>
      {b.canEdit ? (
        changing ? (
          <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <label className="block text-sm">
              <span className="text-xs font-medium">{b.passwordSet ? "New signing password" : "Signing password"}</span>
              <Input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} aria-label="New signing password" placeholder="At least 8 characters" />
            </label>
            <label className="block text-sm">
              <span className="text-xs font-medium">Type it again</span>
              <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-label="Confirm signing password" />
            </label>
            <div className="flex gap-2">
              <Button
                disabled={busy || pw.length < 8 || pw !== confirm}
                data-testid="save-signing-password"
                onClick={async () => {
                  if (await run(() => api.service.setSigningPassword(pw, confirm), b.passwordSet ? "Signing password changed." : "Signing password set.")) {
                    setPw("");
                    setConfirm("");
                    setChanging(false);
                  }
                }}
              >
                Save password
              </Button>
              {b.passwordSet && (
                <Button variant="ghost" onClick={() => setChanging(false)}>
                  Cancel
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="mt-3 flex items-center gap-3 text-sm">
            <span>A signing password is set.</span>
            <Button variant="secondary" onClick={() => setChanging(true)}>
              Change password
            </Button>
          </div>
        )
      ) : (
        <p className="mt-2 text-sm">{b.passwordSet ? "A signing password is set. Ask a Founder for it to sign invoices." : "No signing password yet. A Founder sets it here."}</p>
      )}

      <label className={`mt-6 flex items-start gap-3 text-sm ${b.canEdit ? "" : "opacity-70"}`}>
        <input
          type="checkbox"
          className="mt-1"
          checked={b.requireSignature}
          disabled={!b.canEdit || busy || (!b.requireSignature && !ready)}
          onChange={(e) => run(() => api.service.setSigningRule(e.target.checked), e.target.checked ? "From now on, invoices go to clients only after they are signed." : "Invoices go to clients straight away again (without seal and signature).")}
          aria-label="Require signature before invoices go to clients"
          data-testid="require-signature"
        />
        <span>
          <span className="font-medium">Invoices go to clients only after they are signed</span>
          <span className="block text-xs text-ink-muted">
            {b.requireSignature && b.requiredSince
              ? `On since ${day.format(new Date(b.requiredSince))}. Every invoice made since then (by hand or automatically) waits here until the seal and signature are added with the password; then it is sent.`
              : ready
                ? "When on, new invoices (by hand or automatic) are held until someone signs them with the password. Invoices made before stay as they are."
                : "Set the signing password and upload the signature and seal first."}
          </span>
        </span>
      </label>

      {b.requireSignature && (
        <div className="mt-6">
          <p className="text-sm font-medium">Waiting for signature ({b.waiting.length})</p>
          {!b.waiting.length ? (
            <p className="mt-1 text-xs text-ink-muted">Nothing waiting. New invoices appear here until they are signed.</p>
          ) : (
            <ul className="mt-2 divide-y divide-border border border-border" data-testid="waiting-for-signature">
              {b.waiting.map((w) => (
                <li key={w.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0">
                    <Link href={`/admin/finance/invoices/${w.id}`} className="font-medium underline">
                      {w.number}
                    </Link>{" "}
                    <span className="text-ink-muted">
                      · {w.client} · {formatINR(w.totalPaise)} · {day.format(new Date(w.createdAt))}
                    </span>
                  </span>
                  <Button variant="secondary" disabled={!b.passwordSet} onClick={() => setSigning(w)}>
                    Sign
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {msg && <p className={`mt-3 text-sm ${msg.error ? "text-red" : "text-ink-muted"}`}>{msg.text}</p>}
      {signing && (
        <SignInvoiceDialog
          invoice={{ id: signing.id, number: signing.number, totalPaise: signing.totalPaise, client: signing.client }}
          onClose={() => setSigning(null)}
          onSigned={async (m) => {
            setMsg({ text: m, error: false });
            onChange(await api.service.invoiceBranding());
          }}
        />
      )}
    </div>
  );
}

function ImageSlot({ kind, current, canEdit, busy, onUpload, onRemove }: { kind: InvoiceBrandingKind; current: InvoiceBrandingView["signature"]; canEdit: boolean; busy: boolean; onUpload: (f: File) => void; onRemove: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string>();
  return (
    <div className="min-w-0">
      <p className="text-sm font-medium">{LABEL[kind]}</p>
      <div className="mt-2 flex h-36 items-center justify-center border border-dashed border-border bg-[#ffffff]">
        {/* eslint-disable-next-line @next/next/no-img-element -- signed-in image from the API, not optimisable */}
        {current ? <img src={current.url} alt={LABEL[kind]} className="max-h-32 max-w-[90%] object-contain" data-testid={`branding-${kind}`} /> : <span className="text-xs text-[#6b7280]">Not uploaded yet</span>}
      </div>
      <p className="mt-1 text-xs text-ink-muted">{HINT[kind]}</p>
      {canEdit && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            ref={input}
            type="file"
            accept={INVOICE_IMAGE_TYPES.join(",")}
            className="hidden"
            aria-label={`Upload ${LABEL[kind]}`}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              setErr(undefined);
              if (!f) return;
              if (!INVOICE_IMAGE_TYPES.includes(f.type)) return setErr("Use a PNG, JPG or WebP image");
              if (f.size > INVOICE_IMAGE_MAX_BYTES) return setErr("The image must be 2 MB or smaller");
              onUpload(f);
            }}
          />
          <Button variant="secondary" disabled={busy} onClick={() => input.current?.click()} data-testid={`upload-${kind}`}>
            {busy ? "Uploading…" : current ? "Change" : "Upload"}
          </Button>
          {current && (
            <Button variant="ghost" disabled={busy} onClick={onRemove}>
              Remove
            </Button>
          )}
          {err && <span className="text-xs text-red">{err}</span>}
        </div>
      )}
    </div>
  );
}
