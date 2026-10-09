"use client";
// v14: one renderer for a form, used by the public page (/f/<slug>), the website embed and the builder preview.
import { useState, type FormEvent } from "react";
import type { FormPublic } from "@bmu/shared";
import { api } from "@/lib/api";

type Answer = string | boolean | string[];
const inputCls = "w-full border border-border bg-surface-raised px-3 py-2 text-sm focus:border-ink focus:outline-none";

export function FormView({ form, preview = false }: { form: FormPublic; preview?: boolean }) {
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [trap, setTrap] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const set = (id: string, v: Answer) => setAnswers((a) => ({ ...a, [id]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (preview) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.forms.submit(form.slug, { answers, website: trap || undefined, pageUrl: typeof document !== "undefined" ? document.referrer || window.location.href : undefined });
      setDone(r.message);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (done)
    return (
      <div className="border border-green bg-green/10 px-5 py-6 text-sm" role="status" data-testid="form-done">
        {done}
      </div>
    );

  return (
    <form onSubmit={submit} className="space-y-4" data-testid="public-form" noValidate={preview}>
      {form.fields.map((q) => {
        const v = answers[q.id];
        const label = (
          <span className="mb-1 block text-sm font-medium">
            {q.label}
            {q.required && <span className="text-red"> *</span>}
          </span>
        );
        switch (q.type) {
          case "message":
          case "long_text":
            return (
              <label key={q.id} className="block">
                {label}
                <textarea name={q.id} rows={4} required={q.required} placeholder={q.placeholder ?? ""} value={(v as string) ?? ""} onChange={(e) => set(q.id, e.target.value)} className={inputCls} />
              </label>
            );
          case "select":
            return (
              <label key={q.id} className="block">
                {label}
                <select name={q.id} required={q.required} value={(v as string) ?? ""} onChange={(e) => set(q.id, e.target.value)} className={inputCls}>
                  <option value="">Choose…</option>
                  {(q.options ?? []).map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              </label>
            );
          case "checkbox":
            return (
              <label key={q.id} className="flex items-start gap-2 text-sm">
                <input type="checkbox" name={q.id} className="mt-0.5 accent-[#8BB72C]" checked={v === true} onChange={(e) => set(q.id, e.target.checked)} />
                <span>
                  {q.label}
                  {q.required && <span className="text-red"> *</span>}
                </span>
              </label>
            );
          case "services": {
            const list = (v as string[]) ?? [];
            return (
              <fieldset key={q.id}>
                <legend className="mb-1 block text-sm font-medium">
                  {q.label}
                  {q.required && <span className="text-red"> *</span>}
                </legend>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {form.services.map((s) => (
                    <label key={s.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" className="accent-[#8BB72C]" checked={list.includes(s.id)} onChange={(e) => set(q.id, e.target.checked ? [...list, s.id] : list.filter((x) => x !== s.id))} />
                      {s.name}
                    </label>
                  ))}
                </div>
              </fieldset>
            );
          }
          default: {
            const type = q.type === "email" ? "email" : q.type === "phone" ? "tel" : q.type === "number" || q.type === "budget" ? "number" : q.type === "date" ? "date" : "text";
            return (
              <label key={q.id} className="block">
                {label}
                <input name={q.id} type={type} required={q.required} placeholder={q.placeholder ?? ""} value={(v as string) ?? ""} onChange={(e) => set(q.id, e.target.value)} className={inputCls} autoComplete={q.type === "name" ? "name" : q.type === "email" ? "email" : q.type === "phone" ? "tel" : q.type === "company" ? "organization" : undefined} />
              </label>
            );
          }
        }
      })}
      {/* Trap for bots: hidden from people and screen readers. */}
      <div aria-hidden className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label>
          Website
          <input name="website" tabIndex={-1} autoComplete="off" value={trap} onChange={(e) => setTrap(e.target.value)} />
        </label>
      </div>
      {error && (
        <p className="border border-red bg-red/10 px-3 py-2 text-sm" role="alert">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy || preview} className="bg-charcoal px-5 py-2.5 text-sm font-medium text-ivory hover:opacity-90 disabled:opacity-60">
        {busy ? "Sending…" : form.submitLabel}
      </button>
      {preview && <p className="text-xs text-ink-muted">Preview: sending is switched off here.</p>}
    </form>
  );
}
