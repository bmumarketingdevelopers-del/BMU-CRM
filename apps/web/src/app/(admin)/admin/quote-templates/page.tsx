"use client";

// v45: quotation templates per service. Client Managers start a quotation from one and edit it for the client.
// Founders, Branch Managers and the CM Lead manage them.
import { useState } from "react";
import { quoteTemplateContent, type QuoteContent, type QuoteTemplateRow } from "@bmu/shared";
import { cleanContent, emptyContent, QuoteEditor, SaveBar } from "@/components/quotes/quote-editor";
import { Button, Input, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

type Draft = { id?: string; name: string; serviceKey: string; content: QuoteContent };

export default function QuoteTemplatesPage() {
  const list = useLoad(() => api.quotes.templates(), { live: false });
  const [draft, setDraft] = useState<Draft>();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const open = (t?: QuoteTemplateRow) => {
    setMsg(undefined);
    if (!t) return setDraft({ name: "", serviceKey: "", content: emptyContent() });
    setDraft({ id: t.id, name: t.name, serviceKey: t.serviceKey ?? "", content: quoteTemplateContent(t) });
  };
  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setMsg(undefined);
    try {
      await api.quotes.saveTemplate({ ...cleanContent(draft.content), name: draft.name, serviceKey: draft.serviceKey || null }, draft.id);
      setDraft(undefined);
      setMsg({ ok: true, text: "Template saved." });
      list.reload();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageTitle
        title="Quotation templates"
        subtitle="One per service: the cost lines, and the scope and timeline if you want them. Client Managers pick one when they make a quotation and edit it for the client. The terms are fixed and added to every quotation."
        action={!draft ? <Button onClick={() => open()}>New template</Button> : undefined}
      />
      {msg && <p className={`mb-3 text-sm ${msg.ok ? "text-green" : "text-red"}`}>{msg.text}</p>}
      {draft ? (
        <div className="grid max-w-4xl gap-6">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-xs font-medium">
              Template name
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Influencer Campaign" aria-label="Template name" />
            </label>
            <label className="grid gap-1 text-xs font-medium">
              Service (optional)
              <Input value={draft.serviceKey} onChange={(e) => setDraft({ ...draft, serviceKey: e.target.value })} placeholder="e.g. website" aria-label="Service" />
            </label>
          </div>
          <QuoteEditor value={draft.content} onChange={(content) => setDraft({ ...draft, content })} />
          <SaveBar busy={busy}>
            <Button onClick={save} disabled={busy}>
              Save template
            </Button>
            <Button variant="secondary" onClick={() => setDraft(undefined)}>
              Cancel
            </Button>
            {draft.id && (
              <Button
                variant="secondary"
                onClick={async () => {
                  if (!window.confirm("Delete this template? Quotations already made from it stay as they are.")) return;
                  await api.quotes.deleteTemplate(draft.id!).catch((e: Error) => setMsg({ ok: false, text: e.message }));
                  setDraft(undefined);
                  list.reload();
                }}
              >
                Delete
              </Button>
            )}
          </SaveBar>
        </div>
      ) : !list.data ? (
        <LoadState loading={list.loading} error={list.error} />
      ) : (
        <ul className="divide-y divide-border border border-border bg-surface-raised">
          {list.data.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
              <span>
                <span className="font-medium">{t.name}</span>
                <span className="block text-xs text-ink-muted">
                  {t.title} · {t.lines.length} cost line{t.lines.length === 1 ? "" : "s"}{t.serviceKey ? ` · ${t.serviceKey}` : ""}
                </span>
              </span>
              <Button variant="secondary" onClick={() => open(t)}>
                Edit
              </Button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
