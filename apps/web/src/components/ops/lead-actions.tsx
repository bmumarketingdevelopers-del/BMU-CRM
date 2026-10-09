"use client";

/**
 * Lead actions shared by the pipeline (board / list ⋯ menu) and the lead page: reassign (core engine, target
 * "lead_owner"), mark lost with a reason, merge into another lead, convert to client by hand (payment proof), note /
 * meeting and archive. Each opens its own dialog; the API checks role and scope again.
 */
import { useState, type ReactNode } from "react";
import { formatINR, OPS_CONVERT_METHODS, opsIsSalesManager, type LeadRow, type Me } from "@bmu/shared";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { ActionDialog, ActionDrawer, Field, inputCls, TextArea } from "@/components/actions/action-drawer";
import { useActions } from "@/components/actions/actions-provider";
import type { RowMenuItem } from "@/components/actions/row-menu";
import { errMsg, ProofInput, ReasonDialog, todayIst } from "./kit";
import { convertLeadToClient } from "./lead-convert";

export const LOST_REASONS = ["Budget too low", "Went with another agency", "No response after follow-ups", "Not a fit for our services", "Timing: not now"] as const;
const leadName = (l: Pick<LeadRow, "contact">) => l.contact.company || l.contact.name;
const methodLabel: Record<(typeof OPS_CONVERT_METHODS)[number], string> = { bank: "Bank transfer", upi: "UPI", cash: "Cash", cheque: "Cheque" };
const closed = (l: LeadRow) => l.stage === "won" || l.stage === "lost";

export function leadPerms(me: Me, lead: LeadRow) {
  const manager = opsIsSalesManager(me);
  const owner = lead.owner?.id === me.id;
  return {
    reassign: manager && lead.stage !== "won",
    lost: (manager || owner) && !closed(lead),
    merge: manager && lead.stage !== "won",
    convert: manager && !closed(lead),
    note: manager || owner,
    archive: manager && lead.stage !== "won",
  };
}

type Open = { kind: "lost" | "merge" | "convert" | "archive"; lead: LeadRow } | null;

export function useLeadActions(onChanged: () => void, allLeads?: LeadRow[]) {
  const { me, openReassign, openNew, notify, changed } = useActions();
  const [open, setOpen] = useState<Open>(null);
  const done = (message: string, undo?: Parameters<typeof notify>[1]) => {
    notify(message, undo);
    changed();
    onChanged();
  };

  function items(lead: LeadRow, opts: { withOpen?: boolean } = {}): RowMenuItem[] {
    const can = leadPerms(me, lead);
    return [
      { key: "open", label: "Open lead", href: `/team/leads/${lead.id}`, hidden: !opts.withOpen },
      { key: "reassign", label: "Reassign owner", hidden: !can.reassign, onSelect: () => openReassign({ type: "lead_owner", ids: [lead.id], title: `Reassign ${leadName(lead)}`, onDone: () => onChanged() }) },
      { key: "note", label: "Add note or meeting", hidden: !can.note, onSelect: () => openNew("note", { leadId: lead.id }, () => onChanged()) },
      { key: "proposal", label: "New proposal", hidden: closed(lead) || !(can.note || can.convert), href: `/team/proposals/new?lead=${lead.id}` },
      { key: "convert", label: "Make client (payment received)", hidden: !can.convert, onSelect: () => setOpen({ kind: "convert", lead }) },
      { key: "merge", label: "Merge into another lead", hidden: !can.merge, onSelect: () => setOpen({ kind: "merge", lead }) },
      { key: "lost", label: "Mark lost", hidden: !can.lost, onSelect: () => setOpen({ kind: "lost", lead }) },
      { key: "history", label: "History", href: `/team/leads/${lead.id}#history` },
      { key: "archive", label: "Archive", danger: true, hidden: !can.archive, onSelect: () => setOpen({ kind: "archive", lead }) },
    ];
  }

  const dialogs: ReactNode = (
    <>
      <ReasonDialog
        open={open?.kind === "lost"}
        title={open ? `Why was ${leadName(open.lead)} lost?` : "Mark lost"}
        label="Lost reason"
        options={LOST_REASONS}
        confirm="Mark lost"
        danger
        onClose={() => setOpen(null)}
        onConfirm={async (reason) => {
          await api.ops.leads.lost(open!.lead.id, reason);
          done(`${leadName(open!.lead)} marked lost`);
        }}
      />
      <ReasonDialog
        open={open?.kind === "archive"}
        title={open ? `Archive ${leadName(open.lead)}?` : "Archive"}
        confirm="Archive lead"
        danger
        onClose={() => setOpen(null)}
        onConfirm={async (reason) => {
          const r = await api.actions.archive("lead", open!.lead.id, reason);
          done(`${leadName(open!.lead)} archived`, r.undo);
        }}
      >
        <p className="text-sm text-ink-muted">Archived leads leave the pipeline. Undo from the toast, or restore from Admin.</p>
      </ReasonDialog>
      {open?.kind === "merge" && <MergeDialog lead={open.lead} all={allLeads} onClose={() => setOpen(null)} onDone={(m) => done(m)} />}
      {open?.kind === "convert" && <ConvertDrawer lead={open.lead} onClose={() => setOpen(null)} onDone={(m) => done(m)} />}
    </>
  );

  return { items, dialogs };
}

function MergeDialog({ lead, all, onClose, onDone }: { lead: LeadRow; all?: LeadRow[]; onClose: () => void; onDone: (message: string) => void }) {
  const list = useLoad(() => (all ? Promise.resolve(all) : api.leads.list()));
  const [q, setQ] = useState(lead.contact.company ?? "");
  const [intoId, setInto] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const qq = q.trim().toLowerCase();
  const options = (list.data ?? []).filter((l) => l.id !== lead.id && !closed(l) && (!qq || [l.contact.name, l.contact.company, l.contact.phone, l.contact.email].some((x) => x?.toLowerCase().includes(qq)))).slice(0, 30);
  async function go() {
    if (!intoId) return setError("Pick the lead to keep");
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.ops.leads.merge(lead.id, intoId);
      onDone(r.message);
      onClose();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ActionDialog
      open
      title={`Merge ${leadName(lead)} into…`}
      onClose={onClose}
      testId="merge-dialog"
      footer={
        <>
          <button type="button" disabled={busy || !intoId} onClick={go} className="bg-charcoal px-4 py-2 text-sm font-medium text-ivory disabled:opacity-40">
            {busy ? "Merging…" : "Merge"}
          </button>
          <button type="button" onClick={onClose} className="ml-auto px-3 py-2 text-sm text-ink-muted hover:text-ink">
            Cancel
          </button>
        </>
      }
    >
      <p className="text-sm text-ink-muted">Activities, notes and proposals move to the lead you keep. This lead is archived as a duplicate.</p>
      <Field label="Find the lead to keep" required error={error}>
        <input className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find the lead to keep" />
      </Field>
      <div className="max-h-64 overflow-y-auto border border-border" role="listbox" aria-label="Leads">
        {list.loading && <p className="p-3 text-sm text-ink-muted">Loading…</p>}
        {!list.loading && options.length === 0 && <p className="p-3 text-sm text-ink-muted">No open lead matches.</p>}
        {options.map((l) => (
          <label key={l.id} className={`flex cursor-pointer items-start gap-2 border-b border-border px-3 py-2 text-sm last:border-b-0 ${intoId === l.id ? "bg-canvas" : ""}`}>
            <input type="radio" name="merge-into" className="mt-1 accent-[#8BB72C]" checked={intoId === l.id} onChange={() => setInto(l.id)} />
            <span>
              <span className="font-medium">{leadName(l)}</span>
              <span className="block text-xs text-ink-muted">
                {l.contact.name} · {l.contact.phone ?? l.contact.email ?? ""} · {l.owner?.name ?? "Unassigned"}
              </span>
            </span>
          </label>
        ))}
      </div>
    </ActionDialog>
  );
}

function ConvertDrawer({ lead, onClose, onDone }: { lead: LeadRow; onClose: () => void; onDone: (message: string) => void }) {
  const props = useLoad(() => api.ops.leads.convertOptions(lead.id));
  const [proposalId, setProposal] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<(typeof OPS_CONVERT_METHODS)[number] | "">("");
  const [ref, setRef] = useState("");
  const [paidOn, setPaidOn] = useState(todayIst());
  const [proof, setProof] = useState<{ id: string; name: string } | null>(null);
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const picked = props.data?.find((p) => p.id === proposalId);
  if (props.data?.length === 1 && !proposalId) {
    setProposal(props.data[0].id);
    setAmount(String(props.data[0].firstPaymentPaise / 100));
  }

  async function save() {
    setError(undefined);
    const e: Record<string, string> = {};
    // No proposal sent: the client is set up from the lead's details instead (services added afterwards).
    const noProposal = props.data?.length === 0;
    if (!proposalId && !noProposal) e.proposal = "Pick the proposal the client agreed to";
    if (!(Number(amount) > 0)) e.amount = "Enter the amount received";
    if (!method) e.method = "Pick how they paid";
    if (ref.trim().length < 3) e.ref = "Enter the bank, UPI or cheque reference";
    if (!paidOn) e.paidOn = "Pick the payment date";
    else if (paidOn > todayIst()) e.paidOn = "The payment date can't be in the future";
    if (!proof && !noProposal) e.proof = "Upload the payment proof";
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    try {
      if (noProposal) {
        const c = await api.clientsActions.fromLead(lead.id, { paymentReference: `${method} ${ref.trim()} (${paidOn})${proof ? ` · proof: ${proof.name}` : ""}`, paymentAmountPaise: Math.round(Number(amount) * 100) });
        onDone(c.approval ? `${c.client.name} added. Finance will confirm the payment.` : `${c.client.name} is now a client.`);
        onClose();
        return;
      }
      const r = await convertLeadToClient(lead.id, { proposalId, amountPaise: Math.round(Number(amount) * 100), method: method as (typeof OPS_CONVERT_METHODS)[number], ref: ref.trim(), paidOn, proofFileId: proof!.id, note: note.trim() || undefined });
      onDone(r.message);
      onClose();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ActionDrawer open title={`Make ${leadName(lead)} a client`} subtitle="For payments received outside the online checkout. Finance checks the proof before the client is set up." onClose={onClose} onSubmit={save} saving={saving} error={error ?? props.error} saveLabel="Send to Finance" testId="convert-drawer">
      <Field label="Proposal" required error={errors.proposal}>
        <select
          className={inputCls}
          value={proposalId}
          onChange={(e) => {
            setProposal(e.target.value);
            const p = props.data?.find((x) => x.id === e.target.value);
            if (p) setAmount(String(p.firstPaymentPaise / 100));
          }}
          aria-label="Proposal"
        >
          <option value="">{props.loading ? "Loading…" : props.data?.length ? "Pick a proposal…" : "No sent proposal yet"}</option>
          {props.data?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>
      {props.data && props.data.length === 0 && <p className="text-sm text-ink-muted">No proposal was sent to this lead. The client will be set up from the lead&apos;s details and you can add their services on the client page. Finance still confirms the payment.</p>}
      <Field label="Amount received (₹)" required error={errors.amount} hint={picked ? `First payment due: ${formatINR(picked.firstPaymentPaise)}` : undefined}>
        <input className={inputCls} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount received" />
      </Field>
      <Field label="Paid by" required error={errors.method}>
        <select className={inputCls} value={method} onChange={(e) => setMethod(e.target.value as typeof method)} aria-label="Paid by">
          <option value="">How did they pay?</option>
          {OPS_CONVERT_METHODS.map((m) => (
            <option key={m} value={m}>
              {methodLabel[m]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Reference" required error={errors.ref}>
        <input className={inputCls} value={ref} onChange={(e) => setRef(e.target.value)} aria-label="Reference" placeholder="UTR, UPI ref or cheque number" />
      </Field>
      <Field label="Paid on" required error={errors.paidOn}>
        <input className={inputCls} type="date" max={todayIst()} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} aria-label="Paid on" />
      </Field>
      <ProofInput value={proof} onChange={setProof} />
      {errors.proof && !proof && <p className="-mt-2 text-xs text-red">{errors.proof}</p>}
      <Field label="Note for Finance">
        <TextArea value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note for Finance" maxLength={500} />
      </Field>
    </ActionDrawer>
  );
}
