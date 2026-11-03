"use client";

// v45: the parts of a quotation around the document: the client, the service it is for, "prepared for" lines and
// the valid-until date; plus a template picker that loads a template's content into the editor.
import { useEffect, useState } from "react";
import { quoteTemplateContent, type ClientsListRow, type QuoteContent, type QuoteTemplateRow } from "@bmu/shared";
import { Input, Select } from "@/components/ui";
import { api } from "@/lib/api";

export type QuoteMeta = { clientOrgId: string; engagementId: string; templateId: string; preparedFor: string[]; validUntil: string };

export const inDays = (n: number) => new Date(Date.now() + 330 * 60_000 + n * 86_400_000).toISOString().slice(0, 10);

export function QuoteMetaForm({ meta, onChange, onTemplate, fixedClient }: { meta: QuoteMeta; onChange: (m: QuoteMeta) => void; onTemplate?: (c: QuoteContent, id: string) => void; fixedClient?: boolean }) {
  const [clients, setClients] = useState<ClientsListRow[]>();
  const [templates, setTemplates] = useState<QuoteTemplateRow[]>();
  const [services, setServices] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    api.clientsActions.list({}).then(setClients, () => setClients([]));
    if (onTemplate) api.quotes.templates().then(setTemplates, () => setTemplates([]));
  }, [onTemplate]);
  useEffect(() => {
    if (!meta.clientOrgId) return;
    api.clientsActions
      .get(meta.clientOrgId)
      .then((d) => setServices(d.services.map((s) => ({ id: s.id, name: `${s.serviceName} (${s.tier})` }))))
      .catch(() => setServices([]));
  }, [meta.clientOrgId]);
  const set = (patch: Partial<QuoteMeta>) => onChange({ ...meta, ...patch });
  const prepared = [...meta.preparedFor, "", "", ""].slice(0, 3);
  return (
    <div className="grid gap-3 sm:grid-cols-2" data-testid="quote-meta">
      <label className="grid gap-1 text-xs font-medium">
        Client
        <Select value={meta.clientOrgId} onChange={(e) => set({ clientOrgId: e.target.value, engagementId: "" })} disabled={fixedClient} aria-label="Client">
          <option value="">{clients ? "Pick the client…" : "Loading…"}</option>
          {(clients ?? []).filter((c) => !c.archivedAt).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </label>
      <label className="grid gap-1 text-xs font-medium">
        Service it is for (optional)
        <Select value={meta.engagementId} onChange={(e) => set({ engagementId: e.target.value })} aria-label="Service">
          <option value="">None</option>
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
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
              if (tpl) onTemplate(quoteTemplateContent(tpl), tpl.id);
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
