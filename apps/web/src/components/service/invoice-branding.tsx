"use client";

// v27: the Founder's signature and the company seal printed on every invoice (above "Authorised Signatory").
// Founders upload or change them at any time; others see what is in use.
import { useRef, useState } from "react";
import { INVOICE_IMAGE_MAX_BYTES, INVOICE_IMAGE_TYPES, type InvoiceBrandingKind, type InvoiceBrandingView } from "@bmu/shared";
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
    </Panel>
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
