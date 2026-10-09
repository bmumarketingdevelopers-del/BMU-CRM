"use client";

import { useState } from "react";
import { enquirySchema } from "@bmu/shared";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

type State = { kind: "idle" } | { kind: "sending" } | { kind: "sent" } | { kind: "error"; message: string };

export function EnquiryForm() {
  const [state, setState] = useState<State>({ kind: "idle" });
  const services = useLoad(() => api.services());
  const [picked, setPicked] = useState<string[]>([]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const budget = form.get("budget");
    const parsed = enquirySchema.safeParse({
      name: form.get("name"),
      email: form.get("email"),
      phone: String(form.get("phone") ?? "").replace(/[\s-]/g, ""),
      company: form.get("company") || undefined,
      need: form.get("need"),
      budgetRupees: budget ? Number(budget) : undefined,
      serviceIds: picked,
      consentMarketing: form.get("consentMarketing") === "on",
      consentWhatsapp: form.get("consentWhatsapp") === "on",
      website: String(form.get("website") ?? "") || undefined,
    });
    if (!parsed.success) {
      setState({ kind: "error", message: parsed.error.issues[0]?.message ?? "Check the form" });
      return;
    }
    setState({ kind: "sending" });
    try {
      await api.createEnquiry(parsed.data);
      setState({ kind: "sent" });
    } catch (err) {
      const message = (err as Error).message;
      setState({ kind: "error", message: message && !/fetch/i.test(message) ? message : "We couldn't send your enquiry. Please check your internet connection and try again." });
    }
  }

  if (state.kind === "sent") {
    return (
      <div className="border border-green bg-green/10 p-6">
        <p className="font-semibold">Thanks! Your enquiry is with our team.</p>
        <p className="mt-1 text-sm">We&apos;ll call you within one working day to book your discovery call.</p>
      </div>
    );
  }

  const field = "w-full border border-border bg-surface-raised px-3 py-2";
  return (
    <form onSubmit={onSubmit} className="relative grid gap-4">
      <input name="name" placeholder="Your name" aria-label="Your name" className={field} required />
      <input name="email" type="email" placeholder="Email" aria-label="Email" className={field} required />
      <input name="phone" type="tel" placeholder="Mobile (10 digits)" aria-label="Mobile number" className={field} required />
      <input name="company" placeholder="Business name (optional)" aria-label="Business name" className={field} />
      <input name="budget" type="number" min={0} placeholder="Monthly budget in ₹ (optional)" aria-label="Monthly budget" className={field} />
      {services.data && services.data.length > 0 && (
        <fieldset className="border border-border bg-surface-raised p-3">
          <legend className="px-1 text-sm text-ink-muted">What are you interested in? (optional)</legend>
          <div className="grid gap-1 sm:grid-cols-2">
            {services.data.map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-[#8BB72C]"
                  checked={picked.includes(s.id)}
                  onChange={() => setPicked((p) => (p.includes(s.id) ? p.filter((x) => x !== s.id) : [...p, s.id]))}
                />
                {s.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <textarea name="need" rows={4} placeholder="What do you need help with?" aria-label="What do you need help with?" className={field} required />
      {/* v20 bot trap: hidden from people, filled in by bots. */}
      <input name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" className="absolute left-[-9999px] h-0 w-0 opacity-0" />
      <div className="grid gap-1 text-sm">
        <label className="flex items-start gap-2">
          <input type="checkbox" name="consentWhatsapp" className="mt-0.5 size-4 accent-[#8BB72C]" />
          Send me updates about my enquiry on WhatsApp (optional)
        </label>
        <label className="flex items-start gap-2">
          <input type="checkbox" name="consentMarketing" className="mt-0.5 size-4 accent-[#8BB72C]" />
          Send me occasional marketing tips and offers (optional)
        </label>
        <p className="text-xs text-ink-muted">
          We use your details to reply to this enquiry. See our{" "}
          <a href="/privacy" className="underline">
            privacy notice
          </a>{" "}
          for what we keep, why and for how long, and how to ask for a copy or deletion.
        </p>
      </div>
      {state.kind === "error" && <p className="text-red">{state.message}</p>}
      <button type="submit" disabled={state.kind === "sending"} className="bg-green px-6 py-3 font-semibold text-charcoal disabled:opacity-60">
        {state.kind === "sending" ? "Sending..." : "Book my call"}
      </button>
    </form>
  );
}
