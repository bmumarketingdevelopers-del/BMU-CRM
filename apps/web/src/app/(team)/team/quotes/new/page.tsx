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
  const [meta, setMeta] = useState<QuoteMeta>({ clientOrgId: preset, engagementIds: [], templateId: "", preparedFor: [], validUntil: inDays(15) });
  const [content, setContent] = useState<QuoteContent>(emptyContent());
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
        <QuoteMetaForm meta={meta} onChange={setMeta} onTemplate={(c) => setContent(c)} onServices={setContent} fixedClient={!!preset} />
        <QuoteEditor key={meta.templateId} value={content} onChange={setContent} />
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
