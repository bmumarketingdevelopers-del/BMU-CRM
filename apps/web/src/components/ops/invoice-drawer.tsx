"use client";

/**
 * "+ New → Invoice": a manual invoice by Finance / Admin. Client, lines and due date are required. Service lines
 * carry GST; ad spend and creator fees go on their own pass-through lines, billed at cost without GST.
 * v27: the Founder types a short description per line; "Write invoice wording" turns it into the line as printed on
 * the invoice (a clear service name and one or two sentences, AI-written when AI is on), which they can edit.
 * Without it, the wording is written when the invoice is saved.
 */
import { useRef, useState } from "react";
import { formatINR, OPS_INVOICE_LINE_KINDS, opsInvoiceLineKindLabels, opsInvoiceTotals, type OpsInvoiceLineKind } from "@bmu/shared";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { ActionDrawer, Field, inputCls, TextArea, type SaveMode } from "@/components/actions/action-drawer";
import type { NewDrawerProps } from "@/components/actions/new-registry";
import { dayAhead, errMsg, todayIst } from "./kit";
import { SignInvoiceDialog } from "@/components/service/sign-invoice-dialog";

type Line = { label: string; kind: OpsInvoiceLineKind; amount: string; title: string; details: string };
const newLine = (kind: OpsInvoiceLineKind = "service"): Line => ({ label: "", kind, amount: "", title: "", details: "" });
const toPaise = (s: string) => Math.round(Number(s.replace(/[,₹\s]/g, "")) * 100);

export function InvoiceDrawer({ open, onClose, prefill, onSaved }: NewDrawerProps) {
  const opts = useLoad(() => api.ops.finance.options());
  // v28: when invoices must be signed, issuing one opens the signing pop-up (closing it leaves the invoice unsent).
  const signing = useLoad(() => api.service.invoiceBranding().catch(() => null), { live: false });
  const [toSign, setToSign] = useState<{ id: string; number: string; totalPaise: number; client: string | null; another: boolean } | null>(null);
  const signedRef = useRef(false);
  const [clientOrgId, setClient] = useState(prefill?.clientId ?? "");
  const [engagementId, setEngagement] = useState("");
  const [dueDate, setDue] = useState(dayAhead(15));
  const [lines, setLines] = useState<Line[]>([newLine()]);
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [writing, setWriting] = useState(false);
  const [wordingNote, setWordingNote] = useState<string>();
  const o = opts.data;
  const client = o?.clients.find((c) => c.id === clientOrgId);
  const valid = lines.filter((l) => l.label.trim() && toPaise(l.amount) > 0);
  const totals = opsInvoiceTotals(valid.map((l) => ({ kind: l.kind, amountPaise: toPaise(l.amount) })), o?.gstRatePct ?? 18);

  /** v27: the wording printed on the invoice for every line with a short description. */
  async function writeWording() {
    const todo = lines.map((l, i) => ({ l, i })).filter((x) => x.l.label.trim().length >= 2);
    if (!todo.length) return setErrors({ ...errors, lines: "Type a short description on a line first" });
    setWriting(true);
    setWordingNote(undefined);
    try {
      const r = await api.ops.finance.describe({ clientOrgId: clientOrgId || undefined, engagementId: engagementId || undefined, lines: todo.map((x) => ({ label: x.l.label.trim(), kind: x.l.kind })) });
      setLines((ls) => ls.map((l, i) => {
        const n = todo.findIndex((x) => x.i === i);
        return n < 0 ? l : { ...l, title: r.lines[n].title, details: r.lines[n].details };
      }));
      setWordingNote(r.basic ? "Plain wording (AI is off: turn on AI Copilot → Management in Command Centre for AI wording). Edit it below." : "AI-written wording. Check and edit it before saving.");
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setWriting(false);
    }
  }

  async function save(mode: SaveMode) {
    setError(undefined);
    const e: Record<string, string> = {};
    if (!clientOrgId) e.client = "Pick the client";
    if (!dueDate) e.due = "Pick the due date";
    else if (dueDate < todayIst()) e.due = "The due date is in the past";
    if (!valid.length) e.lines = "Add at least one line with a description and an amount";
    if (lines.some((l) => (l.label.trim() || l.amount) && !(l.label.trim().length >= 2 && toPaise(l.amount) > 0))) e.lines = "Every line needs a description and an amount above zero";
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    try {
      const r = await api.ops.finance.createInvoice({ clientOrgId, engagementId: engagementId || undefined, dueDate, notes: notes.trim() || undefined, issue: mode !== "draft", lines: valid.map((l) => ({ label: l.label.trim(), kind: l.kind, amountPaise: toPaise(l.amount), title: l.title.trim() || undefined, details: l.title.trim() ? l.details.trim() || undefined : undefined })) });
      setLines([newLine()]);
      setNotes("");
      setWordingNote(undefined);
      if (mode !== "draft" && signing.data?.requireSignature) {
        // Held until signed: ask for the signing password now.
        signedRef.current = false;
        setToSign({ id: r.id, number: r.number, totalPaise: r.totalPaise, client: client?.name ?? null, another: mode === "another" });
        return;
      }
      onSaved(r.id, r.message);
      if (mode !== "another") onClose();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ActionDrawer
      open={open}
      title="New invoice"
      subtitle="Issued invoices are emailed to the client's owner and finance contacts."
      onClose={onClose}
      onSubmit={save}
      saving={saving}
      error={error ?? opts.error}
      saveLabel="Issue invoice"
      allowAnother
      allowDraft
      wide
      testId="invoice-drawer"
      footerNote={
        valid.length ? (
          <span className="tabular-nums">
            Service {formatINR(totals.servicePaise)} + GST {o?.gstRatePct ?? 18}% {formatINR(totals.gstPaise)}
            {totals.passThroughPaise ? ` + pass-through ${formatINR(totals.passThroughPaise)}` : ""} = <strong className="text-ink">{formatINR(totals.totalPaise)}</strong>
          </span>
        ) : undefined
      }
      more={
        <Field label="Note on the invoice">
          <TextArea value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Note on the invoice" maxLength={1000} />
        </Field>
      }
    >
      <Field label="Client" required error={errors.client}>
        <select className={inputCls} value={clientOrgId} onChange={(e) => (setClient(e.target.value), setEngagement(""))} aria-label="Client">
          <option value="">{opts.loading ? "Loading…" : "Pick a client…"}</option>
          {o?.clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.gstin ? "" : " (no GSTIN)"}
            </option>
          ))}
        </select>
      </Field>
      {client && client.engagements.length > 0 && (
        <Field label="Service (optional)">
          <select className={inputCls} value={engagementId} onChange={(e) => setEngagement(e.target.value)} aria-label="Service">
            <option value="">Not for one service</option>
            {client.engagements.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Due date" required error={errors.due}>
        <input className={inputCls} type="date" min={todayIst()} value={dueDate} onChange={(e) => setDue(e.target.value)} aria-label="Due date" />
      </Field>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-xs font-medium">
          Lines <span className="text-red">*</span>
        </legend>
        {lines.map((l, i) => (
          <div key={i} className="grid gap-2 border border-border p-2 sm:grid-cols-[1fr_170px_110px_auto]" data-testid="invoice-line">
            <input className={inputCls} placeholder="Short description, e.g. website redesign" value={l.label} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} aria-label={`Line ${i + 1} description`} />
            <select className={inputCls} value={l.kind} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, kind: e.target.value as OpsInvoiceLineKind } : x)))} aria-label={`Line ${i + 1} type`}>
              {OPS_INVOICE_LINE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {opsInvoiceLineKindLabels[k]}
                </option>
              ))}
            </select>
            <input className={inputCls} inputMode="decimal" placeholder="₹" value={l.amount} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} aria-label={`Line ${i + 1} amount`} />
            <button type="button" className="px-2 text-sm text-ink-muted hover:text-ink disabled:opacity-30" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label={`Remove line ${i + 1}`}>
              ✕
            </button>
            {(l.title || l.details) && (
              <div className="grid gap-1 sm:col-span-4" data-testid="invoice-line-wording">
                <span className="text-[11px] font-medium text-ink-muted">As printed on the invoice</span>
                <input className={inputCls} value={l.title} maxLength={120} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} aria-label={`Line ${i + 1} printed title`} />
                <textarea className={`${inputCls} h-16`} value={l.details} maxLength={600} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, details: e.target.value } : x)))} aria-label={`Line ${i + 1} printed details`} />
              </div>
            )}
          </div>
        ))}
        {errors.lines && <p className="text-xs text-red">{errors.lines}</p>}
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="border border-border px-3 py-1.5 text-sm font-medium hover:border-ink disabled:opacity-50" disabled={writing} onClick={writeWording} data-testid="write-wording">
            {writing ? "Writing…" : lines.some((l) => l.title) ? "Rewrite invoice wording" : "Write invoice wording"}
          </button>
          <span className="text-xs text-ink-muted">{wordingNote ?? "Turns each short description into the line printed on the invoice. Skipped? It is written when you save."}</span>
        </div>
        <div className="flex flex-wrap gap-3 text-sm">
          <button type="button" className="underline" onClick={() => setLines((ls) => [...ls, newLine()])}>
            + Service line
          </button>
          <button type="button" className="underline" onClick={() => setLines((ls) => [...ls, newLine("ad_spend")])}>
            + Ad spend (pass-through)
          </button>
          <button type="button" className="underline" onClick={() => setLines((ls) => [...ls, newLine("creator_fee")])}>
            + Creator fee (pass-through)
          </button>
        </div>
        <p className="text-xs text-ink-muted">Pass-through lines are billed at cost with no GST and stay separate from service lines.</p>
      </fieldset>
      {toSign && (
        <SignInvoiceDialog
          invoice={toSign}
          onSigned={(m) => {
            signedRef.current = true;
            onSaved(toSign.id, m);
          }}
          onClose={() => {
            const t = toSign;
            setToSign(null);
            if (!signedRef.current) onSaved(t.id, `Invoice ${t.number} saved but not sent: it is waiting for the seal and signature. Sign it from the invoice page or GST & Invoice Settings.`);
            if (!t.another) onClose();
          }}
        />
      )}
    </ActionDrawer>
  );
}
