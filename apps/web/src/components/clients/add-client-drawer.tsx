"use client";

/**
 * "+ New → Client" and Clients list "+ Add": add a client by hand (no lead), or migrate an existing client at its
 * current gates. Duplicate check (GSTIN, phone, email, business name) with Merge or Continue, optional brands,
 * services from the live price book, CM suggestion by load and industry with a handover note, invite users now or
 * later, and the payment (online in the app, offline confirmed by Finance, or none for a migrated client).
 */
import { useEffect, useMemo, useState } from "react";
import { clientsGateLabels, CLIENTS_GATES, formatINR, rupeesToPaise, SERVICE_GSTIN_RE, type ClientsCreate, type ClientsDuplicate, type ClientsFormOptions, type ClientTeamRole } from "@bmu/shared";
import { api } from "@/lib/api";
import { ActionDrawer, Field, inputCls, TextArea, useDraftAutosave } from "@/components/actions/action-drawer";
import type { NewDrawerProps } from "@/components/actions/new-registry";

type Line = { serviceId: string; tier: string; startMonth: string; currentGate: string; gateReason: string };
type Invite = { name: string; email: string; phone: string; role: ClientTeamRole };
type Brand = { name: string; address: string };
type Past = { number: string; date: string; amount: string; status: "paid" | "issued"; description: string };
type Values = {
  businessName: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  industry: string;
  billingName: string;
  gstin: string;
  billingAddress: string;
  branchId: string;
  billingEmail: string;
  brands: Brand[];
  engagements: Line[];
  amUserId: string;
  handoverNote: string;
  inviteNow: boolean;
  invites: Invite[];
  startMode: "onboarding" | "migration";
  migrationReason: string;
  payment: "online" | "offline" | "none";
  paymentReference: string;
  paymentAmount: string;
  pastInvoices: Past[];
};

const thisMonth = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 7);
const EMPTY: Values = {
  businessName: "",
  contactName: "",
  contactPhone: "",
  contactEmail: "",
  industry: "",
  billingName: "",
  gstin: "",
  billingAddress: "",
  branchId: "",
  billingEmail: "",
  brands: [],
  engagements: [],
  amUserId: "",
  handoverNote: "",
  inviteNow: true,
  invites: [],
  startMode: "onboarding",
  migrationReason: "",
  payment: "online",
  paymentReference: "",
  paymentAmount: "",
  pastInvoices: [],
};
const small = "text-xs text-ink-muted hover:text-ink underline";
const seg = (on: boolean) => `flex-1 border px-3 py-2 text-left text-sm ${on ? "border-charcoal bg-charcoal text-ivory" : "border-border bg-surface-raised hover:border-ink"}`;

export function AddClientDrawer({ open, onClose, prefill, onSaved }: NewDrawerProps) {
  const [opts, setOpts] = useState<ClientsFormOptions>();
  const [optsError, setOptsError] = useState<string>();
  const [v, setV] = useState<Values>(() => ({ ...EMPTY, startMode: prefill?.mode === "migration" ? "migration" : "onboarding", payment: prefill?.mode === "migration" ? "none" : "online" }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dups, setDups] = useState<ClientsDuplicate[]>([]);
  const [dupChoice, setDupChoice] = useState<{ mode: "merge" | "continue"; id?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const draft = useDraftAutosave({ entity: "client", key: "new", values: v, enabled: open, onRestore: setV });

  useEffect(() => {
    if (!open) return;
    api.clientsActions.formOptions().then(
      (o) => {
        setOpts(o);
        setV((cur) => ({ ...cur, branchId: cur.branchId || o.branches[0]?.id || "", amUserId: cur.amUserId || o.ams.find((a) => a.suggested)?.id || "" }));
      },
      (e: Error) => setOptsError(e.message),
    );
  }, [open]);

  // Re-rank CMs when the industry changes (load + industry match).
  useEffect(() => {
    if (!open || !v.industry) return;
    const t = setTimeout(() => {
      api.clientsActions.amSuggest(v.industry).then((ams) => setOpts((o) => (o ? { ...o, ams } : o)), () => undefined);
    }, 300);
    return () => clearTimeout(t);
  }, [open, v.industry]);

  const set = (patch: Partial<Values>) => setV((cur) => ({ ...cur, ...patch }));
  const migration = v.startMode === "migration";
  const services = useMemo(() => new Map((opts?.services ?? []).map((s) => [s.id, s])), [opts]);
  const firstPayment = v.engagements.reduce((sum, l) => {
    const s = services.get(l.serviceId);
    const price = s?.tiers.find((t) => t.tier === l.tier)?.pricePaise ?? 0;
    return sum + (s?.billingType === "monthly" ? price : Math.round(price / 2));
  }, 0);

  async function checkDuplicates() {
    if (!v.businessName.trim() && !v.contactPhone.trim() && !v.gstin.trim()) return;
    try {
      const d = await api.clientsActions.duplicates({ businessName: v.businessName || undefined, phone: v.contactPhone || undefined, email: v.contactEmail || undefined, gstin: v.gstin || undefined });
      setDups(d);
      if (!d.length) setDupChoice(null);
    } catch {
      /* the server checks again on save */
    }
  }

  function validate(): Record<string, string> {
    const e: Record<string, string> = {};
    if (!dupChoice || dupChoice.mode !== "merge") {
      if (v.businessName.trim().length < 2) e.businessName = "Enter the business name";
    }
    if (v.contactName.trim().length < 2) e.contactName = "Enter the contact's name";
    if (!/^(\+?91)?[6-9]\d{9}$/.test(v.contactPhone.replace(/[\s-]/g, "")) && !/^\+?\d{8,15}$/.test(v.contactPhone.replace(/[\s-]/g, ""))) e.contactPhone = "Enter a valid phone number";
    if (!/^\S+@\S+\.\S+$/.test(v.contactEmail.trim())) e.contactEmail = "Enter a valid email";
    if (v.industry.trim().length < 2) e.industry = "Pick the industry";
    if (v.billingName.trim().length < 2) e.billingName = "Enter the billing name";
    if (v.gstin.trim() && !SERVICE_GSTIN_RE.test(v.gstin.trim().toUpperCase())) e.gstin = "GSTIN should look like 29ABCDE1234F1Z5 (15 characters)";
    if (v.billingAddress.trim().length < 5) e.billingAddress = "Enter the billing address";
    if (!v.branchId) e.branchId = "Pick the branch";
    v.engagements.forEach((l, i) => {
      if (!l.serviceId) e[`eng${i}`] = "Pick a service";
      else if (migration && (!l.currentGate || l.gateReason.trim().length < 3)) e[`eng${i}`] = "Set the current gate and a reason";
    });
    if (migration && v.migrationReason.trim().length < 3) e.migrationReason = "Say why this client is being migrated";
    if (v.payment === "offline" && v.paymentReference.trim().length < 3) e.paymentReference = "Add the payment reference so Finance can check it";
    if (v.payment === "none" && !migration && v.engagements.length) e.payment = "A new client with services needs a payment";
    if (v.inviteNow) {
      v.invites.forEach((u, i) => {
        if (u.name.trim().length < 2 || (!u.email.trim() && !u.phone.trim())) e[`inv${i}`] = "Name and an email or phone";
      });
    }
    if (dups.length && !dupChoice) e.dup = "Possible duplicate: choose Merge or Continue";
    return e;
  }

  async function save(mode: "save" | "another" | "draft") {
    setError(undefined);
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) {
      setError(Object.values(e)[0]);
      return;
    }
    const body: ClientsCreate = {
      businessName: v.businessName.trim(),
      contactName: v.contactName.trim(),
      contactPhone: v.contactPhone.trim(),
      contactEmail: v.contactEmail.trim(),
      industry: v.industry.trim(),
      billingName: v.billingName.trim(),
      gstin: v.gstin.trim().toUpperCase(),
      billingAddress: v.billingAddress.trim(),
      branchId: v.branchId,
      billingEmail: v.billingEmail.trim(),
      brands: v.brands.filter((b) => b.name.trim()).map((b) => ({ name: b.name.trim(), address: b.address.trim() })),
      engagements: v.engagements.map((l) => ({ serviceId: l.serviceId, tier: l.tier as "starter", startMonth: l.startMonth || undefined, currentGate: migration ? (l.currentGate as "G1") : undefined, gateReason: migration ? l.gateReason : undefined })),
      amUserId: v.amUserId || null,
      handoverNote: v.handoverNote.trim() || undefined,
      inviteNow: v.inviteNow,
      invites: v.inviteNow ? (v.invites.length ? v.invites : [{ name: v.contactName, email: v.contactEmail, phone: v.contactPhone, role: "client_owner" as const }]).map((u) => ({ name: u.name.trim(), email: u.email.trim(), phone: u.phone.trim(), role: u.role, brandScope: [] })) : [],
      startMode: v.startMode,
      migrationReason: migration ? v.migrationReason.trim() : undefined,
      pastInvoices: migration ? v.pastInvoices.filter((p) => p.number.trim()).map((p) => ({ number: p.number.trim(), date: p.date, amountPaise: rupeesToPaise(Number(p.amount) || 0), status: p.status, description: p.description.trim() || undefined })) : [],
      payment: v.payment,
      paymentReference: v.paymentReference.trim() || undefined,
      paymentAmountPaise: v.paymentAmount ? rupeesToPaise(Number(v.paymentAmount)) : undefined,
      mergeIntoId: dupChoice?.mode === "merge" ? dupChoice.id : null,
      confirmDuplicate: dupChoice?.mode === "continue",
    };
    setSaving(true);
    try {
      const r = await api.clientsActions.create(body);
      draft.clear();
      onSaved(r.client.id, r.message);
      if (mode === "another") {
        setV({ ...EMPTY, branchId: v.branchId, amUserId: opts?.ams.find((a) => a.suggested)?.id ?? "" });
        setDups([]);
        setDupChoice(null);
      } else onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const amRows = opts?.ams ?? [];
  return (
    <ActionDrawer
      open={open}
      title={migration ? "Migrate an existing client" : "Add client"}
      subtitle={migration ? "For clients who already work with BMU. Sales steps are skipped; you set each service's current gate." : "A client without a proposal. Services start at Gate 1 with their onboarding checklist."}
      onClose={onClose}
      onSubmit={(m) => save(m)}
      saving={saving}
      error={error ?? optsError}
      allowAnother
      saveLabel={migration ? "Migrate client" : "Add client"}
      banner={draft.banner}
      wide
      testId="add-client-drawer"
      footerNote={v.engagements.length && !migration && v.payment !== "none" ? <>First payment: {formatINR(firstPayment)} + GST{v.payment === "offline" ? " · Finance confirms it before Gate 1" : " · paid in the client app"}</> : draft.savedAt ? "Draft saved" : null}
    >
      <div className="flex gap-2" role="radiogroup" aria-label="Start mode">
        <button type="button" role="radio" aria-checked={!migration} className={seg(!migration)} onClick={() => set({ startMode: "onboarding", payment: v.payment === "none" ? "online" : v.payment })}>
          <span className="block font-medium">New onboarding</span>
          <span className="block text-xs opacity-80">Starts at Gate 1</span>
        </button>
        <button type="button" role="radio" aria-checked={migration} className={seg(migration)} onClick={() => set({ startMode: "migration", payment: "none" })} disabled={opts ? !opts.canMigrate : false}>
          <span className="block font-medium">Existing client migration</span>
          <span className="block text-xs opacity-80">Set the current gate</span>
        </button>
      </div>

      <Section title="Business">
        <Field label="Business name" required error={errors.businessName} htmlFor="ac-name">
          <input id="ac-name" className={inputCls} value={v.businessName} onChange={(e) => set({ businessName: e.target.value, billingName: v.billingName && v.billingName !== v.businessName ? v.billingName : e.target.value })} onBlur={checkDuplicates} autoComplete="organization" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Industry" required error={errors.industry} htmlFor="ac-industry">
            <input id="ac-industry" className={inputCls} list="ac-industries" value={v.industry} onChange={(e) => set({ industry: e.target.value })} placeholder="Pick or type" />
            <datalist id="ac-industries">
              {(opts?.industries ?? []).map((i) => (
                <option key={i} value={i} />
              ))}
            </datalist>
          </Field>
          <Field label="Branch" required error={errors.branchId} htmlFor="ac-branch">
            <select id="ac-branch" className={inputCls} value={v.branchId} onChange={(e) => set({ branchId: e.target.value })}>
              <option value="">Pick…</option>
              {(opts?.branches ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Section>

      <Section title="Primary contact">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Name" required error={errors.contactName} htmlFor="ac-cname">
            <input id="ac-cname" className={inputCls} value={v.contactName} onChange={(e) => set({ contactName: e.target.value })} />
          </Field>
          <Field label="Phone" required error={errors.contactPhone} htmlFor="ac-phone">
            <input id="ac-phone" className={inputCls} inputMode="tel" value={v.contactPhone} onChange={(e) => set({ contactPhone: e.target.value })} onBlur={checkDuplicates} />
          </Field>
          <Field label="Email" required error={errors.contactEmail} htmlFor="ac-email">
            <input id="ac-email" className={inputCls} type="email" value={v.contactEmail} onChange={(e) => set({ contactEmail: e.target.value })} onBlur={checkDuplicates} />
          </Field>
        </div>
      </Section>

      <Section title="Billing">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Billing name" required error={errors.billingName} htmlFor="ac-bname">
            <input id="ac-bname" className={inputCls} value={v.billingName} onChange={(e) => set({ billingName: e.target.value })} />
          </Field>
          <Field label="GSTIN (optional)" error={errors.gstin} htmlFor="ac-gstin" hint="15 characters, e.g. 29ABCDE1234F1Z5">
            <input id="ac-gstin" className={`${inputCls} uppercase`} value={v.gstin} maxLength={15} onChange={(e) => set({ gstin: e.target.value.toUpperCase() })} onBlur={checkDuplicates} />
          </Field>
        </div>
        <Field label="Billing address" required error={errors.billingAddress} htmlFor="ac-addr">
          <TextArea id="ac-addr" className="min-h-16" value={v.billingAddress} onChange={(e) => set({ billingAddress: e.target.value })} />
        </Field>
      </Section>

      {dups.length > 0 && (
        <div className="border border-amber bg-amber/15 p-3 text-sm" role="alert" data-testid="duplicate-box">
          <p className="font-medium">Possible duplicate</p>
          <ul className="mt-1 space-y-2">
            {dups.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <a href={`/team/clients/${d.id}`} target="_blank" rel="noreferrer" className="font-medium underline">
                    {d.name}
                  </a>{" "}
                  <span className="text-xs text-ink-muted">
                    {d.why.join(", ")}
                    {d.am ? ` · CM ${d.am}` : ""}
                    {d.archived ? " · archived" : ""}
                  </span>
                </span>
                <button type="button" disabled={d.archived} className={`border px-2 py-1 text-xs ${dupChoice?.mode === "merge" && dupChoice.id === d.id ? "border-charcoal bg-charcoal text-ivory" : "border-border bg-surface-raised"}`} onClick={() => setDupChoice({ mode: "merge", id: d.id })}>
                  Merge into this client
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className={`mt-2 border px-2 py-1 text-xs ${dupChoice?.mode === "continue" ? "border-charcoal bg-charcoal text-ivory" : "border-border bg-surface-raised"}`} onClick={() => setDupChoice({ mode: "continue" })}>
            Continue: it&apos;s a different client
          </button>
          {dupChoice?.mode === "merge" && <p className="mt-2 text-xs">The services, brands and users below are added to the existing client; empty fields there are filled in.</p>}
        </div>
      )}

      <Section title="Services" hint={migration ? "Set the gate each service is at today, with a reason." : "Optional: add them now or later from Client 360."}>
        {v.engagements.map((l, i) => {
          const s = services.get(l.serviceId);
          return (
            <div key={i} className="grid gap-2 border border-border p-3" data-testid="service-line">
              <div className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end">
                <Field label="Service" htmlFor={`ac-s${i}`} error={errors[`eng${i}`]}>
                  <select id={`ac-s${i}`} className={inputCls} value={l.serviceId} onChange={(e) => updateLine(i, { serviceId: e.target.value, tier: services.get(e.target.value)?.tiers[0]?.tier ?? "starter" })}>
                    <option value="">Pick…</option>
                    {(opts?.services ?? []).map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Tier" htmlFor={`ac-t${i}`}>
                  <select id={`ac-t${i}`} className={inputCls} value={l.tier} onChange={(e) => updateLine(i, { tier: e.target.value })}>
                    {(s?.tiers ?? []).map((t) => (
                      <option key={t.tier} value={t.tier}>
                        {t.tier} · {t.isFromPrice ? "from " : ""}
                        {formatINR(t.pricePaise)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Start month" htmlFor={`ac-m${i}`}>
                  <input id={`ac-m${i}`} type="month" className={inputCls} value={l.startMonth} min={migration ? undefined : thisMonth()} onChange={(e) => updateLine(i, { startMonth: e.target.value })} />
                </Field>
                <button type="button" className={`${small} pb-2`} onClick={() => set({ engagements: v.engagements.filter((_, j) => j !== i) })}>
                  Remove
                </button>
              </div>
              {migration && (
                <div className="grid gap-2 sm:grid-cols-[1fr_2fr]">
                  <Field label="Current gate" htmlFor={`ac-g${i}`}>
                    <select id={`ac-g${i}`} className={inputCls} value={l.currentGate} onChange={(e) => updateLine(i, { currentGate: e.target.value })}>
                      <option value="">Pick…</option>
                      {CLIENTS_GATES.map((g) => (
                        <option key={g} value={g}>
                          {clientsGateLabels[g]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Why this gate" htmlFor={`ac-r${i}`}>
                    <input id={`ac-r${i}`} className={inputCls} value={l.gateReason} placeholder="e.g. Plan approved in September, production running" onChange={(e) => updateLine(i, { gateReason: e.target.value })} />
                  </Field>
                </div>
              )}
            </div>
          );
        })}
        <button type="button" className="border border-dashed border-border px-3 py-2 text-sm hover:border-ink" onClick={() => set({ engagements: [...v.engagements, { serviceId: "", tier: "starter", startMonth: thisMonth(), currentGate: migration ? "G3" : "", gateReason: "" }] })}>
          + Add a service
        </button>
        {migration ? (
          <Field label="Why is this client being migrated?" required error={errors.migrationReason} htmlFor="ac-mig">
            <input id="ac-mig" className={inputCls} value={v.migrationReason} placeholder="e.g. Existing client from the old spreadsheet" onChange={(e) => set({ migrationReason: e.target.value })} />
          </Field>
        ) : (
          v.engagements.length > 0 && (
            <Field label="Payment" required error={errors.payment || errors.paymentReference}>
              <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Payment">
                <button type="button" role="radio" aria-checked={v.payment === "online"} className={seg(v.payment === "online")} onClick={() => set({ payment: "online" })}>
                  <span className="block font-medium">Pay online in the app</span>
                  <span className="block text-xs opacity-80">The first invoice is sent to the client</span>
                </button>
                <button type="button" role="radio" aria-checked={v.payment === "offline"} className={seg(v.payment === "offline")} onClick={() => set({ payment: "offline" })}>
                  <span className="block font-medium">Paid offline</span>
                  <span className="block text-xs opacity-80">Bank, UPI or cheque: Finance confirms</span>
                </button>
              </div>
              {v.payment === "offline" && (
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <input className={inputCls} aria-label="Payment reference" placeholder="UTR / cheque number" value={v.paymentReference} onChange={(e) => set({ paymentReference: e.target.value })} />
                  <input className={inputCls} aria-label="Amount received (₹)" placeholder="Amount received (₹, optional)" inputMode="decimal" value={v.paymentAmount} onChange={(e) => set({ paymentAmount: e.target.value })} />
                </div>
              )}
            </Field>
          )
        )}
      </Section>

      <Section title="Client manager" hint="Suggested by current load and industry experience.">
        <div className="max-h-48 divide-y divide-border overflow-y-auto border border-border" role="radiogroup" aria-label="Client manager">
          {amRows.map((a) => (
            <label key={a.id} className={`flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm ${v.amUserId === a.id ? "bg-canvas" : ""}`}>
              <span className="flex min-w-0 items-center gap-2">
                <input type="radio" name="ac-am" checked={v.amUserId === a.id} onChange={() => set({ amUserId: a.id })} />
                <span className="truncate font-medium">{a.name}</span>
                {a.suggested && <span className="bg-green/15 px-1.5 text-xs">Best fit</span>}
              </span>
              <span className="shrink-0 text-right text-xs text-ink-muted">
                {a.clients} clients · {a.activeEngagements} active · {a.loadPct}% load
                {a.industryMatch ? ` · ${a.industryMatch} in this industry` : ""}
                {a.onLeaveToday ? " · on leave" : ""}
              </span>
            </label>
          ))}
          {!amRows.length && <p className="px-3 py-2 text-sm text-ink-muted">{opts ? "No client managers yet." : "Loading…"}</p>}
        </div>
        <Field label="Handover note for the CM" htmlFor="ac-handover" hint="What they need to know: expectations, contacts, anything promised.">
          <TextArea id="ac-handover" className="min-h-16" value={v.handoverNote} onChange={(e) => set({ handoverNote: e.target.value })} />
        </Field>
      </Section>

      <Section title="Client users">
        <div className="flex gap-2" role="radiogroup" aria-label="Invite client users">
          <button type="button" role="radio" aria-checked={v.inviteNow} className={seg(v.inviteNow)} onClick={() => set({ inviteNow: true, invites: v.invites.length ? v.invites : [{ name: v.contactName, email: v.contactEmail, phone: v.contactPhone, role: "client_owner" }] })}>
            Invite now
          </button>
          <button type="button" role="radio" aria-checked={!v.inviteNow} className={seg(!v.inviteNow)} onClick={() => set({ inviteNow: false })}>
            Later
          </button>
        </div>
        {v.inviteNow && (
          <>
            {!v.invites.length && <p className="text-sm">The primary contact{v.contactName ? ` (${v.contactName})` : ""} is invited as the Owner. Add more people if needed.</p>}
            {v.invites.map((u, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[1.2fr_1.4fr_1fr_1fr_auto] sm:items-center">
                <input className={inputCls} aria-label="Name" placeholder="Name" value={u.name} onChange={(e) => updateInvite(i, { name: e.target.value })} />
                <input className={inputCls} aria-label="Email" placeholder="Email" value={u.email} onChange={(e) => updateInvite(i, { email: e.target.value })} />
                <input className={inputCls} aria-label="Phone" placeholder="Phone" value={u.phone} onChange={(e) => updateInvite(i, { phone: e.target.value })} />
                <select className={inputCls} aria-label="Client role" value={u.role} onChange={(e) => updateInvite(i, { role: e.target.value as ClientTeamRole })}>
                  {(opts?.roles ?? []).map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <button type="button" className={small} onClick={() => set({ invites: v.invites.filter((_, j) => j !== i) })}>
                  Remove
                </button>
                {errors[`inv${i}`] && <p className="text-xs text-red sm:col-span-5">{errors[`inv${i}`]}</p>}
              </div>
            ))}
            <button type="button" className="border border-dashed border-border px-3 py-2 text-sm hover:border-ink" onClick={() => set({ invites: [...v.invites, { name: v.invites.length ? "" : v.contactName, email: v.invites.length ? "" : v.contactEmail, phone: v.invites.length ? "" : v.contactPhone, role: v.invites.length ? "client_approver" : "client_owner" }] })}>
              + Add a person
            </button>
            {errors.invites && <p className="text-xs text-red">{errors.invites}</p>}
            <p className="text-xs text-ink-muted">They get a welcome message from their client manager and can sign in with their email or mobile number.</p>
          </>
        )}
      </Section>

      <Section title="Brands and locations" hint="Optional.">
        {v.brands.map((b, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[1fr_2fr_auto] sm:items-center">
            <input className={inputCls} aria-label="Brand or location name" placeholder="Name" value={b.name} onChange={(e) => set({ brands: v.brands.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
            <input className={inputCls} aria-label="Address" placeholder="Address" value={b.address} onChange={(e) => set({ brands: v.brands.map((x, j) => (j === i ? { ...x, address: e.target.value } : x)) })} />
            <button type="button" className={small} onClick={() => set({ brands: v.brands.filter((_, j) => j !== i) })}>
              Remove
            </button>
          </div>
        ))}
        <button type="button" className="border border-dashed border-border px-3 py-2 text-sm hover:border-ink" onClick={() => set({ brands: [...v.brands, { name: "", address: "" }] })}>
          + Add a brand or location
        </button>
      </Section>

      {migration && (
        <Section title="Past invoices" hint="Optional: bring earlier invoices in as records (paid ones count as received).">
          {v.pastInvoices.map((p, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_1fr_auto] sm:items-center">
              <input className={inputCls} aria-label="Invoice number" placeholder="Number" value={p.number} onChange={(e) => updatePast(i, { number: e.target.value })} />
              <input className={inputCls} aria-label="Invoice date" type="date" value={p.date} onChange={(e) => updatePast(i, { date: e.target.value })} />
              <input className={inputCls} aria-label="Amount (₹)" placeholder="Amount ₹" inputMode="decimal" value={p.amount} onChange={(e) => updatePast(i, { amount: e.target.value })} />
              <select className={inputCls} aria-label="Status" value={p.status} onChange={(e) => updatePast(i, { status: e.target.value as "paid" })}>
                <option value="paid">Paid</option>
                <option value="issued">Still due</option>
              </select>
              <button type="button" className={small} onClick={() => set({ pastInvoices: v.pastInvoices.filter((_, j) => j !== i) })}>
                Remove
              </button>
            </div>
          ))}
          <button type="button" className="border border-dashed border-border px-3 py-2 text-sm hover:border-ink" onClick={() => set({ pastInvoices: [...v.pastInvoices, { number: "", date: new Date().toISOString().slice(0, 10), amount: "", status: "paid", description: "" }] })}>
            + Add a past invoice
          </button>
        </Section>
      )}
    </ActionDrawer>
  );

  function updateLine(i: number, patch: Partial<Line>) {
    set({ engagements: v.engagements.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  }
  function updateInvite(i: number, patch: Partial<Invite>) {
    set({ invites: v.invites.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  }
  function updatePast(i: number, patch: Partial<Past>) {
    set({ pastInvoices: v.pastInvoices.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  }
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 border-t border-border pt-4 first:border-t-0 first:pt-0">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint && <p className="text-xs text-ink-muted">{hint}</p>}
      </div>
      {children}
    </section>
  );
}
