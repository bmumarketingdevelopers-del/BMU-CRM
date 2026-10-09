"use client";

/** "+ New → Creator": name, mobile, handle, niche, rates and city; duplicate check on mobile and handle. */
import { useState } from "react";
import { api } from "@/lib/api";
import { ActionDrawer, Field, inputCls, type SaveMode } from "@/components/actions/action-drawer";
import { DuplicateWarning } from "@/components/actions/duplicate-warning";
import type { NewDrawerProps } from "@/components/actions/new-registry";
import { errMsg, isConflict } from "./kit";

type Rate = { label: string; price: string };
const blank = { name: "", phone: "", email: "", handle: "", city: "", niche: "" };

export function CreatorDrawer({ open, onClose, onSaved }: NewDrawerProps) {
  const [v, setV] = useState(blank);
  const [rates, setRates] = useState<Rate[]>([{ label: "Per reel", price: "" }]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [k]: e.target.value }));
  const niche = v.niche.split(",").map((n) => n.trim()).filter(Boolean);
  const goodRates = rates.filter((r) => r.label.trim() && Number(r.price) > 0);

  async function save(mode: SaveMode) {
    setError(undefined);
    const e: Record<string, string> = {};
    if (v.name.trim().length < 2) e.name = "Enter the creator's name";
    if (!/^(\+91)?[6-9]\d{9}$/.test(v.phone.replace(/[\s-]/g, ""))) e.phone = "Enter a valid 10-digit Indian mobile number";
    if (v.handle.replace(/^@+/, "").trim().length < 2) e.handle = "Enter their social handle";
    if (!niche.length) e.niche = "Add at least one niche";
    if (!goodRates.length) e.rates = "Add at least one rate";
    if (v.city.trim().length < 2) e.city = "Enter the city";
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    try {
      const r = await api.ops.creators.create({ name: v.name.trim(), phone: v.phone.replace(/[\s-]/g, ""), email: v.email.trim(), handle: v.handle.trim(), city: v.city.trim(), niche, rates: goodRates.map((x) => ({ label: x.label.trim(), pricePaise: Math.round(Number(x.price) * 100) })), confirmDuplicate: confirm });
      onSaved(r.id, r.message);
      setV(blank);
      setConfirm(false);
      if (mode !== "another") onClose();
    } catch (err) {
      if (isConflict(err) && /handle/i.test(errMsg(err))) setConfirm(true);
      setError(errMsg(err));
    } finally {
      setSaving(false);
    }
  }

  const dupSearch = (key: "phone" | "handle") => (q: string) => api.ops.creators.duplicates({ [key]: q }).then((m) => m.map((d) => ({ id: d.id, label: d.name, sub: d.stage === "other_account" ? "uses this mobile for another login" : d.stage, href: d.href ?? undefined })));

  return (
    <ActionDrawer open={open} title="New creator" subtitle="They sign in to the creator portal with this mobile number." onClose={onClose} onSubmit={save} saving={saving} error={error} saveLabel={confirm ? "Add anyway" : "Save creator"} allowAnother testId="creator-drawer"
      more={
        <Field label="Email">
          <input className={inputCls} type="email" value={v.email} onChange={set("email")} aria-label="Email" />
        </Field>
      }
    >
      <Field label="Name" required error={errors.name}>
        <input className={inputCls} value={v.name} onChange={set("name")} aria-label="Name" />
      </Field>
      <Field label="Mobile number" required error={errors.phone}>
        <input className={inputCls} inputMode="tel" value={v.phone} onChange={set("phone")} aria-label="Mobile number" />
      </Field>
      <DuplicateWarning value={v.phone.replace(/\D/g, "")} minLength={10} noun="creator" search={dupSearch("phone")} />
      <Field label="Handle" required error={errors.handle} hint="Instagram or YouTube handle">
        <input className={inputCls} value={v.handle} onChange={set("handle")} aria-label="Handle" placeholder="@name" />
      </Field>
      <DuplicateWarning value={v.handle.replace(/^@+/, "")} minLength={3} noun="creator" search={dupSearch("handle")} />
      <Field label="Niche" required error={errors.niche} hint="Separate with commas, e.g. food, lifestyle">
        <input className={inputCls} value={v.niche} onChange={set("niche")} aria-label="Niche" />
      </Field>
      <Field label="City" required error={errors.city}>
        <input className={inputCls} value={v.city} onChange={set("city")} aria-label="City" />
      </Field>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-xs font-medium">
          Rates <span className="text-red">*</span>
        </legend>
        {rates.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_110px_auto] gap-2">
            <input className={inputCls} value={r.label} onChange={(e) => setRates((rs) => rs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} aria-label={`Rate ${i + 1} label`} />
            <input className={inputCls} inputMode="numeric" placeholder="₹" value={r.price} onChange={(e) => setRates((rs) => rs.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} aria-label={`Rate ${i + 1} price`} />
            <button type="button" className="px-2 text-ink-muted disabled:opacity-30" disabled={rates.length === 1} onClick={() => setRates((rs) => rs.filter((_, j) => j !== i))} aria-label={`Remove rate ${i + 1}`}>
              ✕
            </button>
          </div>
        ))}
        {errors.rates && <p className="text-xs text-red">{errors.rates}</p>}
        <button type="button" className="justify-self-start text-sm underline" onClick={() => setRates((rs) => [...rs, { label: "", price: "" }])}>
          + Add a rate
        </button>
      </fieldset>
    </ActionDrawer>
  );
}
