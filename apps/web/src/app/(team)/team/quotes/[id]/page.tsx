"use client";

// v45: one quotation: the document, and (for the client's CM, leadership and Finance) edit while a draft, send /
// send again, cancel, and raise the balance invoice once the client has accepted.
import Link from "next/link";
import { use, useState } from "react";
import { formatINR, quoteStatusLabels, type QuoteContent, type QuoteView } from "@bmu/shared";
import { QuotationDocument } from "@/components/quotes/quotation-document";
import { cleanContent, QuoteEditor, SaveBar } from "@/components/quotes/quote-editor";
import { QuoteMetaForm, type QuoteMeta } from "@/components/quotes/quote-meta";
import { Badge, Button, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

export default function QuotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const loaded = useLoad(() => api.quotes.get(id), { live: ["Quotation"] });
  const [fresh, setFresh] = useState<QuoteView>();
  const [editing, setEditing] = useState<{ meta: QuoteMeta; content: QuoteContent }>();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const q = fresh ?? loaded.data;
  if (!q) return <LoadState loading={loaded.loading} error={loaded.error} />;
  const run = async (fn: () => Promise<QuoteView & { message?: string }>, ok?: string) => {
    setBusy(true);
    setMsg(undefined);
    try {
      const r = await fn();
      setFresh(r);
      setMsg({ ok: true, text: r.message ?? ok ?? "Saved." });
      return true;
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
      return false;
    } finally {
      setBusy(false);
    }
  };
  const startEdit = () =>
    setEditing({ meta: { clientOrgId: q.client.id, engagementIds: q.engagementIds, templateId: q.templateId ?? "", preparedFor: q.client.preparedFor, validUntil: q.validUntil }, content: q.content });
  const status = quoteStatusLabels[q.status].team;
  return (
    <>
      <Link href="/team/quotes" className="text-sm underline">
        ← Quotations
      </Link>
      <PageTitle
        title={`${q.number} · ${q.content.title}`}
        subtitle={`${q.client.name} · ${formatINR(q.totalPaise)} incl. GST${q.createdBy ? ` · by ${q.createdBy}` : ""}`}
        action={<Badge tone={q.status === "accepted" ? "green" : q.status === "sent" ? "amber" : q.status === "declined" ? "red" : "neutral"}>{status}</Badge>}
      />
      {q.status === "accepted" && (
        <p className="mb-3 border border-green bg-green/10 px-3 py-2 text-sm" data-testid="quote-accepted">
          Accepted by <strong>{q.acceptedName}</strong>
          {q.advanceInvoice ? ` · advance invoice ${q.advanceInvoice.number} (${formatINR(q.advanceInvoice.totalPaise)})` : ""}
          {q.balanceInvoice ? ` · balance invoice ${q.balanceInvoice.number} (${formatINR(q.balanceInvoice.totalPaise)})` : ""}
        </p>
      )}
      {q.status === "declined" && (
        <p className="mb-3 border border-red bg-red/10 px-3 py-2 text-sm">
          Declined by the client{q.declineReason ? `: ${q.declineReason}` : ""}
        </p>
      )}
      {msg && <p className={`mb-3 text-sm ${msg.ok ? "text-green" : "text-red"}`}>{msg.text}</p>}
      {editing ? (
        <div className="grid max-w-4xl gap-6">
          <QuoteMetaForm meta={editing.meta} onChange={(meta) => setEditing({ ...editing, meta })} onServices={(update) => setEditing((e) => e && { ...e, content: update(e.content) })} fixedClient />
          <QuoteEditor value={editing.content} onChange={(content) => setEditing({ ...editing, content })} gstRatePct={q.gstRatePct} />
          <SaveBar busy={busy}>
            <Button
              disabled={busy}
              onClick={async () => {
                if (await run(() => api.quotes.update(q.id, { ...cleanContent(editing.content), ...editing.meta, templateId: editing.meta.templateId || null }), "Saved.")) setEditing(undefined);
              }}
              data-testid="quote-update"
            >
              Save changes
            </Button>
            <Button variant="secondary" onClick={() => setEditing(undefined)}>
              Cancel
            </Button>
          </SaveBar>
        </div>
      ) : (
        <QuotationDocument
          q={q}
          actions={
            <>
              {q.can.edit && (
                <Button variant="secondary" onClick={startEdit} data-testid="quote-edit">
                  Edit
                </Button>
              )}
              {q.can.send && (
                <Button disabled={busy} onClick={() => run(() => api.quotes.send(q.id))} data-testid="quote-send">
                  {q.status === "sent" ? "Send again" : "Send to the client"}
                </Button>
              )}
              {q.can.raiseBalance && (
                <Button disabled={busy} onClick={() => window.confirm(`Raise and send the balance invoice (${100 - q.content.advancePct}%) now?`) && run(() => api.quotes.raiseBalance(q.id))} data-testid="quote-balance">
                  Raise balance invoice
                </Button>
              )}
              {q.can.cancel && (
                <Button variant="secondary" disabled={busy} onClick={() => window.confirm("Cancel this quotation?") && run(() => api.quotes.cancel(q.id), "Cancelled.")}>
                  Cancel quotation
                </Button>
              )}
            </>
          }
        />
      )}
    </>
  );
}
