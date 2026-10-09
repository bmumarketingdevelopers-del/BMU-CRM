"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState, useSyncExternalStore } from "react";
import { FORM_FIELD_TYPES, formEmbedSnippet, formFieldTypeLabels, type CustomFieldDefView, type FormDetail, type FormField, type FormFieldType, type FormInput, type FormPublic, type FormSubmissionRow, type ServiceSummary } from "@bmu/shared";
import { DataTable, Panel } from "@/components/dash";
import { FormView } from "@/components/form-view";
import { Button, Input, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { Toggle, WithData, fmtWhen } from "../../automations/_parts/kit";

type Draft = Omit<FormInput, "fields" | "intro"> & { intro: string; fields: FormField[] };

const toDraft = (f: FormDetail): Draft => ({ name: f.name, title: f.title, intro: f.intro ?? "", slug: f.slug, fields: f.fields.map((q) => ({ ...q })), submitLabel: f.submitLabel, successMessage: f.successMessage, serviceIds: [...f.serviceIds], enabled: f.enabled });
const noop = () => () => {};
const STANDARD = FORM_FIELD_TYPES.filter((t) => formFieldTypeLabels[t].standard);
const CUSTOM_TYPES: Record<string, string[]> = { text: ["text"], long_text: ["long_text"], select: ["select"], checkbox: ["checkbox"], number: ["number", "money"], date: ["date"] };

export default function FormBuilderPage() {
  const { id } = useParams<{ id: string }>()!;
  const state = useLoad(() => Promise.all([api.forms.get(id), api.customFields.list("lead").catch(() => [] as CustomFieldDefView[]), api.services().catch(() => [] as ServiceSummary[])]), { live: false });
  return <WithData state={state}>{([form, fields, services]) => <Builder key={form.id} form={form} customFields={fields} services={services} reload={state.reload} />}</WithData>;
}

function Builder({ form, customFields, services, reload }: { form: FormDetail; customFields: CustomFieldDefView[]; services: ServiceSummary[]; reload: () => void }) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(() => toDraft(form));
  const [saved, setSaved] = useState(() => JSON.stringify(toDraft(form)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const origin = useSyncExternalStore(noop, () => window.location.origin, () => "");
  const subs = useLoad(() => api.forms.submissions(form.id), { live: ["FormSubmission", "Lead"] });
  const dirty = JSON.stringify(draft) !== saved;
  const set = (p: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...p }));
    setFlash(null);
  };
  const setQ = (i: number, p: Partial<FormField>) => set({ fields: draft.fields.map((q, k) => (k === i ? { ...q, ...p } : q)) });
  const moveQ = (i: number, dir: -1 | 1) => {
    const next = [...draft.fields];
    const [q] = next.splice(i, 1);
    next.splice(i + dir, 0, q);
    set({ fields: next });
  };
  const addQ = (type: FormFieldType) => {
    const base = type.replace(/[^a-z]/g, "");
    let n = 1;
    while (draft.fields.some((q) => q.id === (n === 1 ? base : `${base}_${n}`))) n++;
    set({ fields: [...draft.fields, { id: n === 1 ? base : `${base}_${n}`, type, label: formFieldTypeLabels[type].label, required: false, options: type === "select" ? ["Option 1", "Option 2"] : undefined }] });
  };

  const preview: FormPublic = useMemo(
    () => ({ slug: form.slug, title: draft.title, intro: draft.intro || null, fields: draft.fields, submitLabel: draft.submitLabel ?? "Send", services: (draft.serviceIds?.length ? services.filter((s) => draft.serviceIds!.includes(s.id)) : services).map((s) => ({ id: s.id, name: s.name })) }),
    [draft, services, form.slug],
  );

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const f = await api.forms.update(form.id, { ...draft, intro: draft.intro || null });
      const fresh = toDraft(f);
      setDraft(fresh);
      setSaved(JSON.stringify(fresh));
      setFlash("Saved. The live form has changed.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!window.confirm(`Delete "${form.name}"? The link and website embed stop working. Leads it created stay.`)) return;
    try {
      await api.forms.remove(form.id);
      router.push("/admin/forms");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const copy = async (what: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied(null);
    }
  };

  const link = `${origin}/f/${form.slug}`;
  const snippet = formEmbedSnippet(origin || "https://your-bmu-hub", form.slug);

  return (
    <>
      <PageTitle
        title={form.name}
        subtitle={`${form.submitCount} lead${form.submitCount === 1 ? "" : "s"} so far · ${form.enabled ? "live" : "switched off"}`}
        action={
          <Link href="/admin/forms" className="text-sm text-ink-muted hover:text-ink">
            ← All forms
          </Link>
        }
      />
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
        <div className="min-w-0 space-y-6">
          <Panel title="Settings">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="mb-1 block text-xs text-ink-muted">Name (only your team sees this)</span>
                <Input value={draft.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-xs text-ink-muted">Web address</span>
                <span className="flex items-center gap-1">
                  <span className="text-xs text-ink-muted">/f/</span>
                  <Input value={draft.slug ?? ""} maxLength={60} onChange={(e) => set({ slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })} />
                </span>
              </label>
              <label className="block text-sm sm:col-span-2">
                <span className="mb-1 block text-xs text-ink-muted">Heading</span>
                <Input value={draft.title} maxLength={120} onChange={(e) => set({ title: e.target.value })} />
              </label>
              <label className="block text-sm sm:col-span-2">
                <span className="mb-1 block text-xs text-ink-muted">Intro (optional)</span>
                <textarea value={draft.intro} maxLength={600} rows={2} onChange={(e) => set({ intro: e.target.value })} className="w-full border border-border bg-surface-raised px-3 py-2 text-sm" />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-xs text-ink-muted">Button text</span>
                <Input value={draft.submitLabel ?? ""} maxLength={40} onChange={(e) => set({ submitLabel: e.target.value })} />
              </label>
              <div className="flex items-center justify-between gap-3 text-sm">
                <span>
                  {draft.enabled ? "Live" : "Switched off"}
                  <span className="block text-xs text-ink-muted">{draft.enabled ? "Anyone with the link can send it" : "The link shows “not available”"}</span>
                </span>
                <Toggle on={!!draft.enabled} label="Switch form on or off" onChange={(v) => set({ enabled: v })} />
              </div>
              <label className="block text-sm sm:col-span-2">
                <span className="mb-1 block text-xs text-ink-muted">Thank-you message</span>
                <textarea value={draft.successMessage ?? ""} maxLength={400} rows={2} onChange={(e) => set({ successMessage: e.target.value })} className="w-full border border-border bg-surface-raised px-3 py-2 text-sm" />
              </label>
            </div>
          </Panel>

          <Panel title="Questions" subtitle="Standard questions fill the lead's details. Your own questions can fill a lead custom field.">
            <ol className="space-y-3" data-testid="form-questions">
              {draft.fields.map((q, i) => {
                const std = formFieldTypeLabels[q.type].standard;
                const matching = customFields.filter((c) => (CUSTOM_TYPES[q.type] ?? []).includes(c.type));
                return (
                  <li key={q.id} className="border border-border">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-canvas/40 px-3 py-2 text-sm">
                      <span className="font-medium">
                        <span className="mr-2 tabular-nums text-ink-muted">{i + 1}.</span>
                        {formFieldTypeLabels[q.type].label}
                      </span>
                      <span className="flex gap-1 text-xs">
                        <button type="button" disabled={i === 0} onClick={() => moveQ(i, -1)} aria-label="Move up" className="border border-border px-2 py-0.5 text-ink-muted hover:text-ink disabled:opacity-30">
                          ↑
                        </button>
                        <button type="button" disabled={i === draft.fields.length - 1} onClick={() => moveQ(i, 1)} aria-label="Move down" className="border border-border px-2 py-0.5 text-ink-muted hover:text-ink disabled:opacity-30">
                          ↓
                        </button>
                        <button type="button" onClick={() => set({ fields: draft.fields.filter((_, k) => k !== i) })} className="border border-border px-2 py-0.5 text-ink-muted hover:text-ink">
                          Remove
                        </button>
                      </span>
                    </div>
                    <div className="grid gap-3 p-3 sm:grid-cols-2">
                      <label className="block text-sm sm:col-span-2">
                        <span className="mb-1 block text-xs text-ink-muted">Question</span>
                        <Input value={q.label} maxLength={120} onChange={(e) => setQ(i, { label: e.target.value })} />
                      </label>
                      {q.type !== "checkbox" && q.type !== "select" && q.type !== "services" && (
                        <label className="block text-sm">
                          <span className="mb-1 block text-xs text-ink-muted">Hint inside the box (optional)</span>
                          <Input value={q.placeholder ?? ""} maxLength={120} onChange={(e) => setQ(i, { placeholder: e.target.value || null })} />
                        </label>
                      )}
                      {q.type === "select" && (
                        <label className="block text-sm sm:col-span-2">
                          <span className="mb-1 block text-xs text-ink-muted">Choices, one per line</span>
                          <textarea
                            rows={3}
                            value={(q.options ?? []).join("\n")}
                            onChange={(e) => setQ(i, { options: e.target.value.split("\n").map((o) => o.trimStart()).slice(0, 30) })}
                            onBlur={() => setQ(i, { options: (q.options ?? []).map((o) => o.trim()).filter(Boolean) })}
                            className="w-full border border-border bg-surface-raised px-3 py-2 text-sm"
                          />
                        </label>
                      )}
                      {!std && (
                        <label className="block text-sm">
                          <span className="mb-1 block text-xs text-ink-muted">Save the answer to</span>
                          <Select value={q.customFieldKey ?? ""} onChange={(e) => setQ(i, { customFieldKey: e.target.value || null })} className="w-full">
                            <option value="">The lead&apos;s notes</option>
                            {matching.map((c) => (
                              <option key={c.key} value={c.key}>
                                Lead field: {c.label}
                              </option>
                            ))}
                          </Select>
                        </label>
                      )}
                      <label className="flex items-center gap-2 self-end text-sm">
                        <input type="checkbox" checked={q.required} onChange={(e) => setQ(i, { required: e.target.checked })} /> Required
                      </label>
                      <p className="text-xs text-ink-muted sm:col-span-2">{formFieldTypeLabels[q.type].hint}</p>
                    </div>
                  </li>
                );
              })}
            </ol>
            <div className="mt-3">
              <Select aria-label="Add a question" value="" onChange={(e) => e.target.value && addQ(e.target.value as FormFieldType)}>
                <option value="">+ Add a question…</option>
                <optgroup label="Lead details">
                  {STANDARD.filter((t) => !draft.fields.some((q) => q.type === t)).map((t) => (
                    <option key={t} value={t}>
                      {formFieldTypeLabels[t].label}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Your own question">
                  {FORM_FIELD_TYPES.filter((t) => !formFieldTypeLabels[t].standard).map((t) => (
                    <option key={t} value={t}>
                      {formFieldTypeLabels[t].label}
                    </option>
                  ))}
                </optgroup>
              </Select>
            </div>
            {draft.fields.some((q) => q.type === "services") && services.length > 0 && (
              <div className="mt-5 border-t border-border pt-4">
                <p className="text-xs text-ink-muted">Services to offer in “{draft.fields.find((q) => q.type === "services")?.label}” (none ticked = all)</p>
                <div className="mt-2 grid gap-1 sm:grid-cols-2">
                  {services.map((s) => (
                    <label key={s.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={draft.serviceIds?.includes(s.id) ?? false} onChange={(e) => set({ serviceIds: e.target.checked ? [...(draft.serviceIds ?? []), s.id] : (draft.serviceIds ?? []).filter((x) => x !== s.id) })} />
                      {s.name}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </Panel>
          {error && <p className="border border-red bg-red/10 px-3 py-2 text-sm">{error}</p>}
          {flash && !dirty && <p className="border border-green bg-green/10 px-3 py-2 text-sm">{flash}</p>}
          <div className="flex flex-wrap gap-2">
            <Button onClick={save} disabled={busy || !dirty}>
              {busy ? "Saving…" : dirty ? "Save form" : "Saved"}
            </Button>
            <Button variant="ghost" className="ml-auto text-[#b4432c] hover:text-[#b4432c]" onClick={remove}>
              Delete form
            </Button>
          </div>
        </div>

        <aside className="min-w-0 space-y-6 self-start lg:sticky lg:top-6">
          <Panel title="Share it">
            <p className="text-xs text-ink-muted">Send the link on WhatsApp or Instagram, or paste the code into your website where the form should appear.</p>
            <div className="mt-3 flex gap-2">
              <Input readOnly value={link} onFocus={(e) => e.target.select()} className="font-mono text-xs" />
              <Button variant="secondary" className="shrink-0 px-3" onClick={() => copy("link", link)}>
                {copied === "link" ? "Copied" : "Copy"}
              </Button>
            </div>
            <textarea readOnly value={snippet} rows={4} onFocus={(e) => e.target.select()} className="mt-3 w-full border border-border bg-canvas/40 px-3 py-2 font-mono text-[11px]" data-testid="embed-code" />
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <Button variant="secondary" className="px-3 py-1.5" onClick={() => copy("code", snippet)}>
                {copied === "code" ? "Copied" : "Copy website code"}
              </Button>
              <a href={`/f/${form.slug}`} target="_blank" rel="noreferrer" className="text-sm underline">
                Open the form
              </a>
            </div>
            {dirty && <p className="mt-2 text-xs text-amber">Save to update the live form.</p>}
          </Panel>
          <Panel title="Preview">
            <h3 className="text-lg font-semibold tracking-tight">{preview.title}</h3>
            {preview.intro && <p className="mt-1 whitespace-pre-line text-sm text-ink-muted">{preview.intro}</p>}
            <div className="mt-4">
              <FormView form={preview} preview />
            </div>
          </Panel>
        </aside>
      </div>

      <Panel title="Leads from this form" subtitle="Newest first. Each one is a lead on the board." flush className="mt-10 min-w-0">
        <WithData state={subs}>
          {(rows) => (
            <DataTable<FormSubmissionRow>
              rows={rows}
              rowKey={(r) => r.id}
              empty="Nobody has sent this form yet."
              columns={[
                { key: "at", header: "When", cell: (r) => <span className="whitespace-nowrap text-ink-muted">{fmtWhen(r.at)}</span> },
                { key: "lead", header: "Lead", cell: (r) => (r.lead ? <Link href={`/team/leads/${r.lead.id}`} className="hover:underline">{r.lead.name}</Link> : <span className="text-ink-muted">—</span>) },
                { key: "answers", header: "Answers", className: "min-w-80", cell: (r) => <span className="text-xs text-ink-muted">{r.answers.map((a) => `${a.label}: ${a.value}`).join(" · ")}</span> },
              ]}
            />
          )}
        </WithData>
      </Panel>
      <p className="mt-4 text-xs text-ink-muted">
        Leads from forms start any workflow set to “A new lead comes in” or “A website form is filled in”. <Link href="/admin/workflows" className="underline">Workflows</Link>
        {" · "}
        <button type="button" className="underline" onClick={reload}>
          Refresh
        </button>
      </p>
    </>
  );
}
