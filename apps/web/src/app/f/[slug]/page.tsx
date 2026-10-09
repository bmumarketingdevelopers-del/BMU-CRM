"use client";
// v14 public form: a shared link (/f/<slug>) or, with ?embed=1, a bare form for a website iframe that tells the
// parent page its height so the frame fits.
import { use, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { FormPublic } from "@bmu/shared";
import { FormView } from "@/components/form-view";
import { api } from "@/lib/api";

export default function PublicFormPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const [form, setForm] = useState<FormPublic | null>(null);
  const [error, setError] = useState<string | null>(null);
  const embed = useSyncExternalStore(
    () => () => {},
    () => new URLSearchParams(window.location.search).get("embed") === "1",
    () => false,
  );
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.forms
      .publicForm(slug)
      .then(setForm)
      .catch((e: Error) => setError(e.message));
  }, [slug]);

  useEffect(() => {
    if (!embed || !box.current || window.parent === window) return;
    const send = () => window.parent.postMessage({ bmuForm: slug, height: Math.ceil(box.current!.getBoundingClientRect().height) + 8 }, "*");
    const ro = new ResizeObserver(send);
    ro.observe(box.current);
    send();
    return () => ro.disconnect();
  }, [embed, slug, form]);

  const body = error ? (
    <p className="text-sm text-ink-muted">{error}</p>
  ) : !form ? (
    <p className="text-sm text-ink-muted">Loading…</p>
  ) : (
    <>
      <h1 className="text-xl font-semibold tracking-tight">{form.title}</h1>
      {form.intro && <p className="mt-2 whitespace-pre-line text-sm text-ink-muted">{form.intro}</p>}
      <div className="mt-6">
        <FormView form={form} />
      </div>
    </>
  );

  if (embed)
    return (
      <div ref={box} className="bg-surface-raised p-4 text-ink">
        {body}
      </div>
    );
  return (
    <main className="flex min-h-screen items-start justify-center bg-canvas px-4 py-10 text-ink sm:py-16">
      <div ref={box} className="w-full max-w-xl border border-border bg-surface-raised p-6 sm:p-8">
        {body}
        <p className="mt-8 border-t border-border pt-4 text-xs text-ink-muted">BMU Marketing · Build My Universee</p>
      </div>
    </main>
  );
}
