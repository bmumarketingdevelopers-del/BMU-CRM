"use client";

/**
 * "+ New → Lead" (also the pipeline column "+ Add" and the leads list "+ Add"). Required: name, phone, business
 * name, source and service interest. Live duplicate check on phone / email; owner by round-robin or a manager's pick;
 * client managers add referrals only. The first-reply timer starts and the owner is told.
 */
import { useState } from "react";
import { OPS_LEAD_SOURCES, opsLeadSourceLabels, services as catalogue, type OpsLeadCreate } from "@bmu/shared";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { ActionDrawer, Field, inputCls, TextArea, type SaveMode } from "@/components/actions/action-drawer";
import { DuplicateWarning } from "@/components/actions/duplicate-warning";
import type { NewDrawerProps } from "@/components/actions/new-registry";
import { Chips, errMsg, isConflict } from "./kit";

const blank = { name: "", phone: "", email: "", company: "", source: "", serviceIds: [] as string[], need: "", budget: "", ownerId: "", referredBy: "" };

export function LeadDrawer({ open, onClose, prefill, onSaved }: NewDrawerProps) {
  const opts = useLoad(() => api.ops.leads.options());
  const [v, setV] = useState({ ...blank, source: prefill?.source ?? "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [dupConfirm, setDupConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const o = opts.data;
  const referralOnly = !!o?.referralOnly;
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [k]: e.target.value }));

  function check() {
    const e: Record<string, string> = {};
    if (v.name.trim().length < 2) e.name = "Enter the contact's name";
    if (!/^(\+91)?[6-9]\d{9}$/.test(v.phone.replace(/[\s-]/g, ""))) e.phone = "Enter a valid 10-digit Indian mobile number";
    if (v.company.trim().length < 2) e.company = "Enter the business name";
    if (!referralOnly && !v.source) e.source = "Pick where the lead came from";
    if (!v.serviceIds.length) e.serviceIds = "Pick at least one service";
    if (v.email && !/^\S+@\S+\.\S+$/.test(v.email)) e.email = "Enter a valid email";
    if (v.budget && !/^\d+$/.test(v.budget)) e.budget = "Whole rupees only";
    setErrors(e);
    return !Object.keys(e).length;
  }

  async function save(mode: SaveMode) {
    setError(undefined);
    if (!check()) return;
    setSaving(true);
    const body: OpsLeadCreate = {
      name: v.name.trim(),
      phone: v.phone.replace(/[\s-]/g, ""),
      email: v.email.trim(),
      company: v.company.trim(),
      source: (referralOnly ? "referral" : v.source) as OpsLeadCreate["source"],
      serviceIds: v.serviceIds,
      need: v.need.trim() || undefined,
      budgetRupees: v.budget ? Number(v.budget) : undefined,
      ownerId: v.ownerId || undefined,
      referredBy: v.referredBy.trim() || undefined,
      confirmDuplicate: dupConfirm,
    };
    try {
      const r = await api.ops.leads.create(body);
      // Column "+ Add" on a later stage: move the new lead there.
      if (prefill?.stage && prefill.stage !== "new") await api.leads.update(r.lead.id, { stage: prefill.stage as never }).catch(() => undefined);
      onSaved(r.lead.id, r.message);
      setV({ ...blank });
      setDupConfirm(false);
      if (mode !== "another") onClose();
    } catch (e) {
      if (isConflict(e)) setDupConfirm(true);
      setError(errMsg(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ActionDrawer
      open={open}
      title={referralOnly ? "Add a referral" : "New lead"}
      subtitle={o ? `First reply due within ${o.firstReplyMinutes / 60} working hours. The owner is told straight away.` : undefined}
      onClose={onClose}
      onSubmit={save}
      saving={saving}
      error={error ?? opts.error}
      allowAnother
      saveLabel={dupConfirm ? "Add anyway" : "Save lead"}
      testId="lead-drawer"
      footerNote={dupConfirm ? "This looks like a lead we already have. Open it from the warning above, or choose Add anyway." : undefined}
      more={
        <>
          <Field label="Email" error={errors.email}>
            <input className={inputCls} type="email" value={v.email} onChange={set("email")} aria-label="Email" />
          </Field>
          <DuplicateWarning value={v.email} minLength={6} noun="lead" search={(q) => api.ops.leads.duplicates({ email: q }).then((m) => m.map((d) => ({ id: d.id, label: d.name, sub: `${d.stage}${d.owner ? ` · ${d.owner}` : ""}`, href: d.href ?? undefined })))} />
          <Field label="What they need">
            <TextArea value={v.need} onChange={set("need")} aria-label="What they need" maxLength={2000} />
          </Field>
          <Field label="Monthly budget (₹)" error={errors.budget}>
            <input className={inputCls} inputMode="numeric" value={v.budget} onChange={set("budget")} aria-label="Monthly budget" />
          </Field>
          {(referralOnly || v.source === "referral") && (
            <Field label="Referred by">
              <input className={inputCls} value={v.referredBy} onChange={set("referredBy")} aria-label="Referred by" />
            </Field>
          )}
        </>
      }
    >
      {referralOnly && <p className="border border-border bg-canvas px-3 py-2 text-xs">Client managers add referrals. The sales team picks it up by round-robin.</p>}
      <Field label="Contact name" required error={errors.name}>
        <input className={inputCls} value={v.name} onChange={set("name")} aria-label="Contact name" />
      </Field>
      <Field label="Mobile number" required error={errors.phone}>
        <input className={inputCls} inputMode="tel" value={v.phone} onChange={set("phone")} aria-label="Mobile number" placeholder="98765 43210" />
      </Field>
      <DuplicateWarning value={v.phone.replace(/\D/g, "")} minLength={10} noun="lead" search={(q) => api.ops.leads.duplicates({ phone: q }).then((m) => m.map((d) => ({ id: d.id, label: d.name, sub: `${d.stage}${d.owner ? ` · ${d.owner}` : ""}`, href: d.href ?? undefined })))} />
      <Field label="Business name" required error={errors.company}>
        <input className={inputCls} value={v.company} onChange={set("company")} aria-label="Business name" />
      </Field>
      {!referralOnly && (
        <Field label="Source" required error={errors.source}>
          <select className={inputCls} value={v.source} onChange={set("source")} aria-label="Source">
            <option value="">Where did they come from?</option>
            {OPS_LEAD_SOURCES.map((s) => (
              <option key={s} value={s}>
                {opsLeadSourceLabels[s]}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Interested in" required error={errors.serviceIds}>
        <Chips label="Services" options={catalogue.map((s) => ({ id: s.id, label: s.name }))} value={v.serviceIds} onChange={(serviceIds) => setV((x) => ({ ...x, serviceIds }))} />
      </Field>
      {o && !referralOnly && (
        <Field label="Owner" hint={(o.canPickOwner ? v.ownerId === "" : v.ownerId === "auto") ? `Round-robin: next up is ${o.nextOwner ?? "nobody (no sales team yet)"}.` : undefined}>
          <select className={inputCls} value={v.ownerId} onChange={set("ownerId")} aria-label="Owner">
            {o.canPickOwner ? <option value="">Auto (round-robin)</option> : <option value="">Me</option>}
            {!o.canPickOwner && <option value="auto">Auto (round-robin)</option>}
            {o.canPickOwner &&
              o.team.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                  {u.manager ? " (manager)" : ""}
                </option>
              ))}
          </select>
        </Field>
      )}
    </ActionDrawer>
  );
}
