"use client";

// v45: a new quotation: pick the client and a template, edit, then save it as a draft (send it from the next page).
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import type { QuoteContent } from "@bmu/shared";
import { cleanContent, emptyContent, QuoteEditor, SaveBar } from "@/components/quotes/quote-editor";
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      const q = await api.quotes.create({ ...cleanContent(content), ...meta, templateId: meta.templateId || null });
      router.push(`/team/quotes/${q.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <>
      <PageTitle title="New quotation" subtitle="Pick the client and a template, edit it for this client, then save. You'll see the document and can send it next." />
      <div className="grid max-w-4xl gap-6">
        <QuoteEditor
          key={meta.templateId}
          value={content}
          onChange={setContent}
          clientOrgId={meta.clientOrgId}
          details={
            <QuoteMetaForm
              meta={meta}
              onChange={setMeta}
              // A template brings the document; this quotation's date, Bill to, signature, notes and terms stay.
              onTemplate={(c) => setContent((cur) => ({ ...c, quoteDate: cur.quoteDate, billTo: cur.billTo, signWith: cur.signWith, seal: cur.seal, notes: cur.notes, terms: cur.terms }))}
              onServices={setContent}
              fixedClient={!!preset}
              quoteDate={content.quoteDate ?? ""}
              onQuoteDate={(quoteDate) => setContent((cur) => ({ ...cur, quoteDate }))}
            />
          }
        />
        <SaveBar busy={busy} error={error}>
          <Button onClick={save} disabled={busy} data-testid="quote-save">
            Save and preview
          </Button>
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
