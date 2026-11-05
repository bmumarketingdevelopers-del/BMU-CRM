"use client";

// v45: the parts of a quotation around the document: the client, the services it is for (v46: several), "prepared for" lines and
// the valid-until date; plus a template picker that loads a template's content into the editor.
import { useEffect, useRef, useState } from "react";
import { applyQuoteServices, quoteServicesTitle, quoteTemplateContent, type ClientsListRow, type QuoteContent, type QuoteServicePick, type QuoteTemplateRow } from "@bmu/shared";
import { Input, Select } from "@/components/ui";
import { api } from "@/lib/api";

export type QuoteMeta = { clientOrgId: string; engagementIds: string[]; templateId: string; preparedFor: string[]; validUntil: string };

export const inDays = (n: number) => new Date(Date.now() + 330 * 60_000 + n * 86_400_000).toISOString().slice(0, 10);

export function QuoteMetaForm({ meta, onChange, onTemplate, onServices, fixedClient }: { meta: QuoteMeta; onChange: (m: QuoteMeta) => void; onTemplate?: (c: QuoteContent, id: string) => void; onServices: (update: (c: QuoteContent) => QuoteContent) => void; fixedClient?: boolean }) {
  const [clients, setClients] = useState<ClientsListRow[]>();
  const [templates, setTemplates] = useState<QuoteTemplateRow[]>();
  const [services, setServices] = useState<(QuoteServicePick & { id: string; label: string })[]>([]);
  const templateTitle = useRef("");
  useEffect(() => {
    api.clientsActions.list({}).then(setClients, () => setClients([]));
    if (onTemplate) api.quotes.templates().then(setTemplates, () => setTemplates([]));
  }, [onTemplate]);
  useEffect(() => {
    if (!meta.clientOrgId) return;
    api.clientsActions
      .get(meta.clientOrgId)
      .then((d) => setServices(d.services.filter((s) => s.status !== "closed").map((s) => ({ id: s.id, name: s.serviceName, label: s.grouped ? s.serviceName : `${s.serviceName} (${s.tier})`, subServices: s.subServices }))))
      .catch(() => setServices([]));
  }, [meta.clientOrgId]);
  const set = (patch: Partial<QuoteMeta>) => onChange({ ...meta, ...patch });
  const picks = (ids: string[]) => services.filter((s) => ids.includes(s.id));
  // v47: ticking a service fills the project name and the cost lines from it.
  const pickServices = (ids: string[], patch: Partial<QuoteMeta> = {}) => {
    set({ ...patch, engagementIds: ids });
    onServices((c) => applyQuoteServices(c, picks(ids), [quoteServicesTitle(picks(meta.engagementIds)), templateTitle.current]));
  };
  const prepared = [...meta.preparedFor, "", "", ""].slice(0, 3);
  return (
    <div className="grid gap-3 sm:grid-cols-2" data-testid="quote-meta">
      <label className="grid gap-1 text-xs font-medium">
        Client
        <Select value={meta.clientOrgId} onChange={(e) => pickServices([], { clientOrgId: e.target.value })} disabled={fixedClient} aria-label="Client">
          <option value="">{clients ? "Pick the client…" : "Loading…"}</option>
          {(clients ?? []).filter((c) => !c.archivedAt).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </label>
      <fieldset className="grid gap-1 sm:col-span-2" data-testid="quote-services">
        <legend className="mb-1 text-xs font-medium">Services this quotation is for (tick any number)</legend>
        {services.length ? (
          <div className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
            {services.map((s) => (
              <label key={s.id} className="flex items-center gap-2">
                <input type="checkbox" checked={meta.engagementIds.includes(s.id)} onChange={(e) => pickServices(e.target.checked ? [...meta.engagementIds, s.id] : meta.engagementIds.filter((x) => x !== s.id))} aria-label={s.label} />
                {s.label}
              </label>
            ))}
          </div>
        ) : (
          <p className="text-sm text-ink-muted">{meta.clientOrgId ? "This client has no services yet." : "Pick the client first."}</p>
        )}
      </fieldset>
      {onTemplate && (
        <label className="grid gap-1 text-xs font-medium">
          Start from a template
          <Select
            value={meta.templateId}
            onChange={(e) => {
              const tpl = templates?.find((x) => x.id === e.target.value);
              set({ templateId: e.target.value });
              if (!tpl) return;
              const c = quoteTemplateContent(tpl);
              const chosen = picks(meta.engagementIds);
              templateTitle.current = c.title;
              onTemplate(applyQuoteServices({ ...c, title: chosen.length ? "" : c.title }, chosen), tpl.id);
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
      <label className="grid gap-1 text-xs font-medium">
        Valid until
        <Input type="date" min={inDays(0)} value={meta.validUntil} onChange={(e) => set({ validUntil: e.target.value })} aria-label="Valid until" />
      </label>
      <div className="grid gap-1 sm:col-span-2">
        <span className="text-xs font-medium">Prepared for: lines under the client&apos;s name</span>
        <div className="grid gap-2 sm:grid-cols-3">
          {prepared.map((v, i) => (
            <Input key={i} value={v} placeholder={["e.g. Real Estate Developer", "e.g. Bengaluru, Karnataka", ""][i]} onChange={(e) => set({ preparedFor: prepared.map((x, j) => (j === i ? e.target.value : x)).filter(Boolean) })} aria-label={`Prepared for line ${i + 1}`} />
          ))}
        </div>
      </div>
    </div>
  );
}
