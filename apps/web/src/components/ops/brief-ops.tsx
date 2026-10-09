"use client";

/** Brief page extras: move the brief to another creator, rate the creator after delivery, propose the payout. */
import { useState } from "react";
import { formatINR, type BriefDetail } from "@bmu/shared";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { Panel } from "@/components/dash";
import { Button } from "@/components/ui";
import { useActions } from "@/components/actions/actions-provider";
import { inputCls, TextArea } from "@/components/actions/action-drawer";
import { errMsg } from "./kit";

export function BriefOpsPanels({ b, onChanged }: { b: BriefDetail; onChanged: () => void }) {
  const { openReassign, notify } = useActions();
  const delivered = b.status === "approved" || b.status === "paid";
  const creator = useLoad(() => (delivered ? api.ops.creators.get(b.creator.id).catch(() => null) : Promise.resolve(null)));
  const rated = creator.data?.briefs.find((x) => x.id === b.id)?.rated ?? false;
  const movable = ["offered", "accepted", "revision"].includes(b.status);
  return (
    <>
      {movable && (
        <Panel title="Move to another creator" subtitle="The new creator gets the brief as an offer; the current one is told">
          <Button variant="secondary" onClick={() => openReassign({ type: "creator_brief", ids: [b.id], title: `Move "${b.title}"`, onDone: () => onChanged() })}>
            Move to another creator
          </Button>
        </Panel>
      )}
      {delivered && !rated && !creator.loading && <RateCreator b={b} onDone={(m) => (notify(m), creator.reload())} />}
      {delivered && rated && (
        <Panel title="Creator rated">
          <p className="text-sm text-ink-muted">You rated {b.creator.name} for this brief. Their average shows on the roster.</p>
        </Panel>
      )}
      {b.status === "approved" && !b.payout && <ProposePayout b={b} onDone={(m) => (notify(m), onChanged())} />}
    </>
  );
}

function RateCreator({ b, onDone }: { b: BriefDetail; onDone: (message: string) => void }) {
  const [score, setScore] = useState(0);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!score) return setError("Pick 1 to 5 stars");
    if (note.trim().length < 3) return setError("Write a short note about the delivery");
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.ops.creators.rate(b.id, { score, note: note.trim() });
      onDone(r.message);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel title={`Rate ${b.creator.name}`} subtitle="How was the delivery? Helps pick creators for the next brief">
      <div className="flex gap-1" role="radiogroup" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" role="radio" aria-checked={score === n} aria-label={`${n} star${n === 1 ? "" : "s"}`} onClick={() => setScore(n)} className={`size-9 border text-lg ${n <= score ? "border-charcoal bg-charcoal text-ivory" : "border-border"}`}>
            ★
          </button>
        ))}
      </div>
      <TextArea className={`${inputCls} mt-3`} value={note} onChange={(e) => setNote(e.target.value)} aria-label="Rating note" placeholder="On time? Followed the brief? Quality?" maxLength={1000} />
      {error && <p className="mt-2 text-sm text-red">{error}</p>}
      <Button className="mt-3" disabled={busy} onClick={save}>
        {busy ? "Saving…" : "Save rating"}
      </Button>
    </Panel>
  );
}

function ProposePayout({ b, onDone }: { b: BriefDetail; onDone: (message: string) => void }) {
  const [amount, setAmount] = useState(String(b.feePaise / 100));
  const [note, setNote] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function save() {
    const paise = Math.round(Number(amount) * 100);
    if (!(paise > 0)) return setError("Enter the payout amount");
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.ops.finance.proposePayout({ creatorId: b.creator.id, briefId: b.id, amountPaise: paise, note: note.trim() || undefined });
      onDone(r.message);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel title="Propose the payout" subtitle={`Finance approves it; 10% TDS is held back. Agreed fee ${formatINR(b.feePaise)}`}>
      <label className="block text-sm">
        Amount before TDS (₹)
        <input className={`${inputCls} mt-1`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Payout amount" />
      </label>
      <label className="mt-3 block text-sm">
        Note for Finance
        <TextArea className={`${inputCls} mt-1`} value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note for Finance" maxLength={500} placeholder="Needed if the amount differs from the agreed fee" />
      </label>
      {error && <p className="mt-2 text-sm text-red">{error}</p>}
      <Button className="mt-3" disabled={busy} onClick={save}>
        {busy ? "Sending…" : "Send to Finance"}
      </Button>
    </Panel>
  );
}
