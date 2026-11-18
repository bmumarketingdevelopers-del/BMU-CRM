"use client";

// v45: the parts of a quotation around the document: the client, "prepared for" lines and the valid-until date; plus a
// template picker that loads a template's content into the editor. v52: no ticking services: the client's services fill
// the items by themselves (the page does it when the client loads) and the manager adds or removes items.
import { useEffect, useState } from "react";
import { QUOTE_DEFAULT_VALID_DAYS, quoteTemplateContent, type ClientsDetail, type ClientsListRow, type QuoteContent, type QuoteTemplateRow } from "@bmu/shared";
import { Input, Select } from "@/components/ui";
import { api } from "@/lib/api";

export type QuoteMeta = { clientOrgId: string; engagementIds: string[]; templateId: string; preparedFor: string[]; validUntil: string };

export const inDays = (n: number) => new Date(Date.now() + 330 * 60_000 + n * 86_400_000).toISOString().slice(0, 10);

export function QuoteMetaForm({
  meta,
  onChange,
  onTemplate,
  onServices,
  fixedClient,
  quoteDate,
  onQuoteDate,
  onClientLoaded,
}: {
  meta: QuoteMeta;
  onChange: (m: QuoteMeta) => void;
  onTemplate?: (c: QuoteContent, id: string) => void;
  onServices: (update: (c: QuoteContent) => QuoteContent) => void;
  fixedClient?: boolean;
  quoteDate: string;
  onQuoteDate: (date: string) => void;
  /** v52: the client's record once loaded (its name for the overview, its services to start the items). */
  onClientLoaded?: (d: ClientsDetail) => void;
}) {
  const [clients, setClients] = useState<ClientsListRow[]>();
  const [templates, setTemplates] = useState<QuoteTemplateRow[]>();
  useEffect(() => {
    api.clientsActions.list({}).then(setClients, () => setClients([]));
    if (onTemplate) api.quotes.templates().then(setTemplates, () => setTemplates([]));
  }, [onTemplate]);
  useEffect(() => {
    if (!meta.clientOrgId) return;
    api.clientsActions
      .get(meta.clientOrgId)
      .then((d) => {
        // "Bill to" starts from the client's billing details in the database; a draft that already has its own keeps it.
        const gstin = d.billing.gstin ?? "";
        const fromRecord = { name: d.billing.billingName || d.name, gstin, placeOfSupply: d.billing.placeOfSupply || (/^\d{2}/.test(gstin) ? gstin.slice(0, 2) : ""), address: d.billing.billingAddress ?? "" };
        onServices((c) => (c.billTo ? c : { ...c, billTo: fromRecord }));
        onClientLoaded?.(d);
      })
      .catch(() => undefined);
  }, [meta.clientOrgId]);
  const set = (patch: Partial<QuoteMeta>) => onChange({ ...meta, ...patch });
  const prepared = [...meta.preparedFor, "", "", ""].slice(0, 3);
  return (
    <div className="grid gap-3 sm:grid-cols-2" data-testid="quote-meta">
      <label className="grid gap-1 text-xs font-medium">
        Client
        <Select
          value={meta.clientOrgId}
          onChange={(e) => {
            set({ clientOrgId: e.target.value, engagementIds: [] });
            // A new client: Bill to is filled again from that client's record.
            onServices((c) => ({ ...c, billTo: undefined }));
          }}
          disabled={fixedClient}
          aria-label="Client"
        >
          <option value="">{clients ? "Pick the client…" : "Loading…"}</option>
          {(clients ?? []).filter((c) => !c.archivedAt).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </label>
      {onTemplate && (
        <label className="grid gap-1 text-xs font-medium">
          Start from a template
          <Select
            value={meta.templateId}
            onChange={(e) => {
              const tpl = templates?.find((x) => x.id === e.target.value);
              set({ templateId: e.target.value });
              if (!tpl) return;
              onTemplate(quoteTemplateContent(tpl), tpl.id);
            }}
            aria-label="Template"
          >
            <option value="">{templates ? "Blank, or pick a template…" : "Loading…"}</option>
            {(templates ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </label>
      )}
      <div className="grid items-start gap-3 sm:col-span-2 sm:grid-cols-2">
        <label className="grid gap-1 text-xs font-medium">
          Quotation date
          <Input type="date" value={quoteDate} onChange={(e) => onQuoteDate(e.target.value)} aria-label="Quotation date" />
        </label>
        <label className="grid gap-1 text-xs font-medium">
          Valid until
          <Input type="date" min={inDays(0)} value={meta.validUntil} onChange={(e) => set({ validUntil: e.target.value })} aria-label="Valid until" />
          <span className="font-normal text-ink-muted">Leave empty for {QUOTE_DEFAULT_VALID_DAYS} days after the date.</span>
        </label>
      </div>
      <div className="grid gap-1 sm:col-span-2">
        <span className="text-xs font-medium">Extra lines under the client&apos;s name (optional)</span>
        <div className="grid gap-2 sm:grid-cols-3">
          {prepared.map((v, i) => (
            <Input key={i} value={v} placeholder={["e.g. Real Estate Developer", "e.g. Bengaluru, Karnataka", ""][i]} onChange={(e) => set({ preparedFor: prepared.map((x, j) => (j === i ? e.target.value : x)).filter(Boolean) })} aria-label={`Prepared for line ${i + 1}`} />
          ))}
        </div>
      </div>
    </div>
  );
}
