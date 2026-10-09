"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { clientRoleLabels, clientsOffboardStatusLabels, clientsQuoteStatusLabels, formatINR, TIERS, type ClientsAccount, type Tier } from "@bmu/shared";
import { Empty, Panel } from "@/components/dash";
import { Badge, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";

const field = "w-full border border-border bg-surface-raised px-3 py-2 text-sm";
const primary = "bg-charcoal px-3 py-1.5 text-sm font-medium text-ivory disabled:opacity-40";
const secondary = "border border-border px-3 py-1.5 text-sm hover:border-ink disabled:opacity-40";
const thisMonth = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 7);
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

/** Client app → Settings → Account: contact, brands, services (ask for a new one or a plan change), quotes, owner confirmations, closing. */
export default function ClientSettingsPage() {
  const [a, setA] = useState<ClientsAccount>();
  const [error, setError] = useState<string>();
  const [flash, setFlash] = useState<string>();
  const [busy, setBusy] = useState<string>();

  useEffect(() => {
    api.clientAccount.get().then(setA, (e: Error) => setError(e.message));
  }, []);

  async function run(key: string, fn: () => Promise<ClientsAccount>, msg: string) {
    setBusy(key);
    setFlash(undefined);
    setError(undefined);
    try {
      setA(await fn());
      setFlash(msg);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(undefined);
    }
  }

  if (!a) return <LoadState loading={!error} error={error} />;
  const owner = a.isOwner && !a.readOnly;
  const off = a.offboarding;

  return (
    <div className="[&_.grid>*]:min-w-0">
      <PageTitle title="Account and services" subtitle="Your company details, brands, services and plan changes." />
      {flash && (
        <p role="status" className="mb-4 border border-border bg-canvas px-4 py-2 text-sm">
          {flash}
        </p>
      )}
      {error && (
        <p role="alert" className="mb-4 border border-red bg-red/10 px-4 py-2 text-sm">
          {error}
        </p>
      )}

      {a.readOnly && (
        <p className="mb-4 border border-border bg-canvas px-4 py-3 text-sm" data-testid="read-only-banner">
          Your account is closed. You can still view and download everything{a.readOnlyUntil ? ` until ${fmtDay(a.readOnlyUntil)}` : ""}, but you can&apos;t make changes.
        </p>
      )}
      {off && off.status === "awaiting_client" && (
        <section className="mb-6 border border-charcoal bg-surface-raised px-5 py-4 text-sm" data-testid="offboarding-confirm">
          <p className="font-semibold">Please confirm you have received everything</p>
          <p className="mt-1 text-ink-muted">We have handed over your final files and report, and closed the work. Confirm to close your account. You keep read-only access for 90 days.</p>
          {a.isOwner ? (
            <button type="button" className={`${primary} mt-3`} disabled={busy === "off"} onClick={() => run("off", () => api.clientAccount.confirmOffboarding(), "Thanks. Your account is closed and stays readable for 90 days.")}>
              Confirm receipt
            </button>
          ) : (
            <p className="mt-2 text-xs text-ink-muted">Your account Owner confirms this.</p>
          )}
        </section>
      )}
      {off && off.status !== "awaiting_client" && off.status !== "closed" && <p className="mb-4 text-sm text-ink-muted">{clientsOffboardStatusLabels[off.status]}</p>}

      <div className="grid gap-6 lg:grid-cols-2">
        <ContactPanel account={a} canEdit={owner} busy={busy === "contact"} onSave={(v) => run("contact", () => api.clientAccount.contact(v), "Contact details saved. Your Account Manager has been told.")} />

        <Panel title="Your Account Manager">
          {a.am ? (
            <div className="text-sm">
              <p className="font-medium">{a.am.name}</p>
              {a.am.email && <p className="text-ink-muted">{a.am.email}</p>}
              {a.am.phone && <p className="text-ink-muted">{a.am.phone}</p>}
              <Link href="/client/messages" className="mt-2 inline-block text-xs underline">
                Send a message
              </Link>
            </div>
          ) : (
            <Empty>Not assigned yet.</Empty>
          )}
        </Panel>

        <ServicesPanel account={a} canEdit={owner} busy={busy} run={run} />

        <BrandsPanel account={a} canEdit={owner} busy={busy === "brand"} onAdd={(v) => run("brand", () => api.clientAccount.addBrand(v), `${v.name} added`)} />

        {a.isOwner && a.pendingInvites.length > 0 && (
          <Panel title="Owners waiting for your confirmation" subtitle="Your Account Manager invited them as an Owner. Owners can change users, billing and plans." flush>
            <ul className="divide-y divide-border">
              {a.pendingInvites.map((p) => (
                <li key={p.approvalId} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm" data-testid="owner-invite">
                  <span className="min-w-0">
                    <span className="font-medium">{p.name}</span> <span className="text-xs text-ink-muted">· {p.email ?? p.phone} · {clientRoleLabels[p.role].name}</span>
                  </span>
                  <span className="flex gap-2">
                    <button type="button" className={primary} disabled={!!busy} onClick={() => run(p.approvalId, () => api.clientAccount.decideInvite(p.approvalId, "approve"), `${p.name} is now an Owner`)}>
                      Confirm
                    </button>
                    <button type="button" className={secondary} disabled={!!busy} onClick={() => run(p.approvalId, () => api.clientAccount.decideInvite(p.approvalId, "reject"), "Invite declined")}>
                      Decline
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        <Panel title="More settings">
          <ul className="space-y-2 text-sm">
            <li>
              <Link href="/client/team" className="underline">
                Team users
              </Link>{" "}
              <span className="text-ink-muted">— invite colleagues and set what they can do</span>
            </li>
            <li>
              <Link href="/client/billing" className="underline">
                Billing
              </Link>{" "}
              <span className="text-ink-muted">— billing name, GSTIN, address and invoices</span>
            </li>
          </ul>
        </Panel>
      </div>
    </div>
  );
}

function ContactPanel({ account, canEdit, busy, onSave }: { account: ClientsAccount; canEdit: boolean; busy: boolean; onSave: (v: { contactName: string; contactPhone: string; contactEmail: string }) => Promise<boolean> }) {
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState({ contactName: account.contact.name ?? "", contactPhone: account.contact.phone ?? "", contactEmail: account.contact.email ?? "" });
  return (
    <Panel
      title="Main contact"
      action={
        canEdit && !edit ? (
          <button type="button" className={secondary} onClick={() => setEdit(true)}>
            Edit
          </button>
        ) : undefined
      }
    >
      {edit ? (
        <div className="grid gap-2">
          <input className={field} aria-label="Contact name" value={v.contactName} onChange={(e) => setV({ ...v, contactName: e.target.value })} />
          <input className={field} aria-label="Contact phone" value={v.contactPhone} onChange={(e) => setV({ ...v, contactPhone: e.target.value })} />
          <input className={field} aria-label="Contact email" value={v.contactEmail} onChange={(e) => setV({ ...v, contactEmail: e.target.value })} />
          <div className="flex gap-2">
            <button type="button" className={primary} disabled={busy} onClick={async () => (await onSave(v)) && setEdit(false)}>
              Save
            </button>
            <button type="button" className={secondary} onClick={() => setEdit(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="text-sm">
          <p className="font-medium">{account.contact.name ?? "—"}</p>
          <p className="text-ink-muted">{account.contact.phone ?? "No phone"}</p>
          <p className="break-all text-ink-muted">{account.contact.email ?? "No email"}</p>
        </div>
      )}
    </Panel>
  );
}

function BrandsPanel({ account, canEdit, busy, onAdd }: { account: ClientsAccount; canEdit: boolean; busy: boolean; onAdd: (v: { name: string; address: string }) => Promise<boolean> }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  return (
    <Panel title="Brands and locations" flush>
      {account.brands.length ? (
        <ul className="divide-y divide-border">
          {account.brands.map((b) => (
            <li key={b.id} className="px-5 py-3 text-sm">
              <span className="font-medium">{b.name}</span>
              {b.address && <span className="block text-xs text-ink-muted">{b.address}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <Empty>No brands or locations yet.</Empty>
      )}
      {canEdit && (
        <div className="grid gap-2 border-t border-border px-5 py-3 sm:grid-cols-[1fr_1fr_auto]">
          <input className={field} placeholder="Brand or location name" aria-label="Brand name" value={name} onChange={(e) => setName(e.target.value)} />
          <input className={field} placeholder="Address" aria-label="Brand address" value={address} onChange={(e) => setAddress(e.target.value)} />
          <button
            type="button"
            className={primary}
            disabled={busy || name.trim().length < 2 || address.trim().length < 3}
            onClick={async () => {
              if (await onAdd({ name: name.trim(), address: address.trim() })) {
                setName("");
                setAddress("");
              }
            }}
          >
            + Add
          </button>
        </div>
      )}
    </Panel>
  );
}

function ServicesPanel({ account, canEdit, busy, run }: { account: ClientsAccount; canEdit: boolean; busy?: string; run: (key: string, fn: () => Promise<ClientsAccount>, msg: string) => Promise<boolean> }) {
  const [asking, setAsking] = useState(false);
  const [serviceId, setServiceId] = useState("");
  const [tier, setTier] = useState<Tier>("growth");
  const [startMonth, setStartMonth] = useState(thisMonth());
  const [changing, setChanging] = useState<string>();
  const [newTier, setNewTier] = useState<Tier>("growth");
  const [effective, setEffective] = useState<"next_cycle" | "now_prorata">("next_cycle");
  const svc = account.catalogue.find((s) => s.id === serviceId);
  const price = svc?.tiers.find((t) => t.tier === tier);
  const live = account.services.filter((s) => !["closed"].includes(s.status));

  return (
    <Panel
      title="Services"
      action={
        canEdit && !asking ? (
          <button type="button" className={secondary} onClick={() => setAsking(true)}>
            + Ask for a service
          </button>
        ) : undefined
      }
      flush
    >
      {asking && (
        <div className="grid gap-2 border-b border-border px-5 py-3 text-sm" data-testid="ask-service">
          <select className={field} aria-label="Service" value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
            <option value="">Pick a service</option>
            {account.catalogue.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <div className="grid gap-2 sm:grid-cols-2">
            <select className={field} aria-label="Plan" value={tier} onChange={(e) => setTier(e.target.value as Tier)}>
              {(svc?.tiers.map((t) => t.tier) ?? TIERS).map((t) => (
                <option key={t} value={t} className="capitalize">
                  {t}
                </option>
              ))}
            </select>
            <input className={field} type="month" aria-label="Start month" value={startMonth} min={thisMonth()} onChange={(e) => setStartMonth(e.target.value)} />
          </div>
          {price && (
            <p className="text-xs text-ink-muted">
              {price.isFromPrice ? "From " : ""}
              {formatINR(price.pricePaise)}
              {svc?.billingType === "monthly" ? " a month" : ""} + GST. Your Account Manager confirms and sends the quote.
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              className={primary}
              disabled={!serviceId || busy === "ask"}
              onClick={async () => {
                if (await run("ask", () => api.clientAccount.requestQuote({ kind: "add_service", serviceId, tier, startMonth }), "Request sent. Your Account Manager will send you a quote.")) setAsking(false);
              }}
            >
              Send request
            </button>
            <button type="button" className={secondary} onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {live.length ? (
        <ul className="divide-y divide-border">
          {live.map((s) => (
            <li key={s.id} className="px-5 py-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <span className="font-medium">{s.serviceName}</span> <span className="text-xs text-ink-muted capitalize">· {s.tier} plan · {s.status.replace(/_/g, " ")}</span>
                </span>
                {canEdit && s.billingType === "monthly" && changing !== s.id && (
                  <button
                    type="button"
                    className="text-xs underline"
                    onClick={() => {
                      setChanging(s.id);
                      setNewTier(TIERS.find((t) => t !== s.tier) ?? "growth");
                    }}
                  >
                    Change plan
                  </button>
                )}
              </div>
              {changing === s.id && (
                <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto]">
                  <select className={field} aria-label="New plan" value={newTier} onChange={(e) => setNewTier(e.target.value as Tier)}>
                    {TIERS.filter((t) => t !== s.tier).map((t) => (
                      <option key={t} value={t}>
                        {t[0].toUpperCase() + t.slice(1)}
                      </option>
                    ))}
                  </select>
                  <select className={field} aria-label="When" value={effective} onChange={(e) => setEffective(e.target.value as "next_cycle" | "now_prorata")}>
                    <option value="next_cycle">From next month</option>
                    <option value="now_prorata">Now (upgrade, pay the difference for this month)</option>
                  </select>
                  <button
                    type="button"
                    className={primary}
                    disabled={busy === "tier"}
                    onClick={async () => {
                      if (await run("tier", () => api.clientAccount.requestQuote({ kind: "change_tier", engagementId: s.id, tier: newTier, effective }), "Request sent. Your Account Manager will send you a quote.")) setChanging(undefined);
                    }}
                  >
                    Ask
                  </button>
                  <button type="button" className={secondary} onClick={() => setChanging(undefined)}>
                    Cancel
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <Empty>No services yet.</Empty>
      )}
      {account.quotes.length > 0 && (
        <div className="border-t border-border">
          <p className="px-5 pt-3 text-xs font-semibold tracking-wide text-ink-muted uppercase">Quotes</p>
          <ul className="divide-y divide-border">
            {account.quotes.map((q) => (
              <li key={q.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm" data-testid="client-quote">
                <span className="min-w-0">
                  <span className="font-medium">{q.kind === "add_service" ? `New: ${q.serviceName}` : `${q.serviceName}: ${q.fromTier} → ${q.tier}`}</span>
                  <span className="block text-xs text-ink-muted">
                    {q.status === "requested" ? "Waiting for your Account Manager to price it" : `${formatINR(q.amountPaise + q.gstPaise)} incl. GST`}
                    {q.monthlyDiffPaise !== null && q.status !== "requested" ? ` · ${q.monthlyDiffPaise >= 0 ? "+" : ""}${formatINR(q.monthlyDiffPaise)} a month` : ""}
                  </span>
                </span>
                {q.status === "sent" && canEdit ? (
                  <span className="flex gap-2">
                    <button type="button" className={primary} disabled={!!busy} onClick={() => run(q.id, () => api.clientAccount.approveQuote(q.id), q.amountPaise > 0 ? "Approved. Pay the invoice in Billing to start." : "Approved. The change is done.")}>
                      Approve
                    </button>
                    <button type="button" className={secondary} disabled={!!busy} onClick={() => run(q.id, () => api.clientAccount.declineQuote(q.id), "Quote declined")}>
                      Decline
                    </button>
                  </span>
                ) : q.status === "approved" && q.invoice ? (
                  <Link href="/client/billing" className={primary}>
                    Pay {q.invoice.number}
                  </Link>
                ) : (
                  <Badge tone={q.status === "applied" ? "green" : q.status === "declined" ? "red" : "neutral"}>{clientsQuoteStatusLabels[q.status].client}</Badge>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}
