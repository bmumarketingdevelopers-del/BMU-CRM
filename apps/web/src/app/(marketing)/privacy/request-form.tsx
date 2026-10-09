"use client";

import { useState } from "react";
import { CONSENT_PURPOSES, DATA_REQUEST_KINDS, consentPurposeLabels, dataRequestCreateSchema, dataRequestKindLabels, type ConsentPurpose } from "@bmu/shared";
import { api } from "@/lib/api";

const field = "w-full border border-border bg-surface-raised px-3 py-2";
const day = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });

export function PrivacyRequestForm() {
  const [mode, setMode] = useState<"request" | "withdraw">("request");
  const [done, setDone] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(undefined);
    setBusy(true);
    try {
      if (mode === "withdraw") {
        const email = String(f.get("email") ?? "").trim();
        const purpose = String(f.get("purpose")) as ConsentPurpose;
        if (!email.includes("@")) throw new Error("Enter the email you gave us");
        await api.publicPrivacy.withdraw(email, purpose);
        setDone(`Done. We will no longer use ${email} for: ${consentPurposeLabels[purpose].toLowerCase()}.`);
      } else {
        const parsed = dataRequestCreateSchema.safeParse({
          kind: f.get("kind"),
          requesterName: f.get("name"),
          requesterEmail: f.get("email"),
          details: String(f.get("details") ?? "") || undefined,
        });
        if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Check the form");
        const r = await api.publicPrivacy.request(parsed.data);
        setDone(`Thanks. Your request is logged and we will answer by ${day.format(new Date(r.dueAt))}. We may email you to confirm it is you.`);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (done) return <p className="border border-green bg-green/10 p-4 text-sm">{done}</p>;
  return (
    <form onSubmit={submit} className="grid gap-3">
      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="radio" checked={mode === "request"} onChange={() => setMode("request")} /> Copy, correct or delete my data
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={mode === "withdraw"} onChange={() => setMode("withdraw")} /> Withdraw a consent
        </label>
      </div>
      {mode === "request" ? (
        <>
          <select name="kind" aria-label="What would you like?" className={field} defaultValue="export">
            {DATA_REQUEST_KINDS.map((k) => (
              <option key={k} value={k}>
                {dataRequestKindLabels[k]}
              </option>
            ))}
          </select>
          <input name="name" placeholder="Your name" aria-label="Your name" className={field} required />
          <input name="email" type="email" placeholder="Email you used with us" aria-label="Email" className={field} required />
          <textarea name="details" rows={3} placeholder="Anything that helps us find your data or what to correct (optional)" aria-label="Details" className={field} />
        </>
      ) : (
        <>
          <input name="email" type="email" placeholder="Email you used with us" aria-label="Email" className={field} required />
          <select name="purpose" aria-label="Which consent?" className={field} defaultValue="marketing">
            {CONSENT_PURPOSES.filter((p) => p !== "service").map((p) => (
              <option key={p} value={p}>
                {consentPurposeLabels[p]}
              </option>
            ))}
          </select>
        </>
      )}
      {error && <p className="text-sm text-red">{error}</p>}
      <button type="submit" disabled={busy} className="bg-green px-6 py-3 font-semibold text-charcoal disabled:opacity-60">
        {busy ? "Sending..." : mode === "request" ? "Send request" : "Withdraw consent"}
      </button>
    </form>
  );
}
