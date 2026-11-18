"use client";

// v45: a new quotation: pick the client and a template, edit, then save it as a draft (send it from the next page).
// v52: choosing the client fills Bill to and starts the items from the client's services (until the items are edited
// by hand); the overview is written from them; autosave about 4 seconds after a change (and when the tab is hidden),
// the first one turning this page into the saved draft's page so a reload continues the same draft.
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { quoteDefaultValidUntil, type ClientsDetail, type PriceList, type QuoteContent } from "@bmu/shared";
import { cleanContent, emptyContent, linesFromClient, QuoteEditor, quoteProblem, SaveBar, useDocAutosave } from "@/components/quotes/quote-editor";
import { inDays, QuoteMetaForm, type QuoteMeta } from "@/components/quotes/quote-meta";
import { Button, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";

function NewQuote() {
  // useSearchParams() can be null outside a request (e.g. while building): read the client once, safely.
  const preset = useSearchParams()?.get("clientId") ?? "";
  const router = useRouter();
  // Valid until starts empty: the server makes it 30 days after the quotation date.
  const [meta, setMeta] = useState<QuoteMeta>({ clientOrgId: preset, engagementIds: [], templateId: "", preparedFor: [], validUntil: "" });
  const [content, setContent] = useState<QuoteContent>({ ...emptyContent(), quoteDate: inDays(0) });
  const [clientName, setClientName] = useState("");
  const itemsEdited = useRef(false);
  // The price list prices the sub services on the client's projects (the client is filled in once both are loaded).
  const [priceList, setPriceList] = useState<PriceList>();
  const [loadedClient, setLoadedClient] = useState<ClientsDetail>();
  useEffect(() => {
    api.catalogue.priceList().then(setPriceList, () => setPriceList({ groups: [], bundles: [] }));
  }, []);
  useEffect(() => {
    if (!loadedClient || !priceList) return;
    const d = loadedClient;
    // The quotation is for all of the client's running services (printed under the project); no ticking.
    setMeta((m) => ({ ...m, engagementIds: d.services.filter((x) => !["closed", "delivered"].includes(x.status)).map((x) => x.id) }));
    if (itemsEdited.current) return;
    const lines = linesFromClient(d, priceList);
    if (lines.length) setContent((cur) => ({ ...cur, lines, title: cur.title.trim() ? cur.title : [...new Set(lines.map((l) => l.service || l.title))].join(", ").slice(0, 160) }));
  }, [loadedClient, priceList]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const body = () => ({ ...cleanContent(content), ...meta, templateId: meta.templateId || null });
  const auto = useDocAutosave({
    value: { meta, content },
    problem: quoteProblem(meta, content),
    save: async () => {
      const q = await api.quotes.create(body());
      router.replace(`/team/quotes/${q.id}?edit=1`);
    },
  });
  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      const q = await api.quotes.create(body());
      auto.markSaved();
      router.push(`/team/quotes/${q.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  const validUntil = meta.validUntil || quoteDefaultValidUntil(content.quoteDate || inDays(0));
  return (
    <>
      <PageTitle title="New quotation" subtitle="Pick the client: their services, Bill to and the overview are filled in for you. Check them, then save." />
      <div className="grid max-w-4xl gap-6">
        <QuoteEditor
          key={meta.templateId}
          value={content}
          onChange={setContent}
          clientOrgId={meta.clientOrgId}
          clientName={clientName}
          validUntil={validUntil}
          onItemsEdited={() => (itemsEdited.current = true)}
          details={
            <QuoteMetaForm
              meta={meta}
              onChange={setMeta}
              // A template brings the document; this quotation's items (the client's services), date, Bill to, signature, notes and terms stay.
              onTemplate={(c) => setContent((cur) => ({ ...c, lines: cur.lines.some((l) => l.title.trim()) ? cur.lines : c.lines, quoteDate: cur.quoteDate, billTo: cur.billTo, signWith: cur.signWith, seal: cur.seal, notes: cur.notes, terms: cur.terms, gstRatePct: cur.gstRatePct }))}
              onServices={setContent}
              fixedClient={!!preset}
              quoteDate={content.quoteDate ?? ""}
              onQuoteDate={(quoteDate) => setContent((cur) => ({ ...cur, quoteDate }))}
              onClientLoaded={(d) => {
                setClientName(d.name);
                setLoadedClient(d);
              }}
            />
          }
        />
        <SaveBar busy={busy} error={error}>
          <Button onClick={save} disabled={busy} data-testid="quote-save">
            Save quotation as draft
          </Button>
          <span className="text-xs text-ink-muted" data-testid="quote-autosave">
            {auto.status}
          </span>
        </SaveBar>
      </div>
    </>
  );
}

export default function NewQuotePage() {
  return (
    <Suspense>
      <NewQuote />
    </Suspense>
  );
}
