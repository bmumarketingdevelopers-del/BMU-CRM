"use client";

import { useState } from "react";
import { deliverNpsBand, type DeliverHandoverView } from "@bmu/shared";
import { Badge, Button, Input, Select } from "@/components/ui";
import { api } from "@/lib/api";

const when = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });
const size = (b: number | null) => (b === null ? "" : b > 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const kindLabel = { credential: "Login", note: "Note", link: "Link" } as const;

/** Final files, links and logins handed over, with the zip download. Shared by the team project page and the client page. */
export function HandoverContents({ v, onChange }: { v: DeliverHandoverView; onChange: (v: DeliverHandoverView) => void }) {
  const [error, setError] = useState<string>();
  const [reveal, setReveal] = useState<Record<string, boolean>>({});

  async function remove(id: string) {
    setError(undefined);
    try {
      onChange(await api.deliver.removeHandoverItem(id));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="space-y-6 text-sm" data-testid="handover">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-medium">Final files ({v.files.length})</p>
          <p className="text-xs text-ink-muted">The approved version of every deliverable.</p>
        </div>
        {v.zipUrl ? (
          <a href={v.zipUrl} className="bg-charcoal px-4 py-2 text-sm font-medium text-ivory hover:opacity-90" data-testid="zip-download">
            Download all (.zip)
          </a>
        ) : (
          v.files.length > 0 && <span className="text-xs text-ink-muted">🔒 Download unlocks after sign-off and the final payment</span>
        )}
      </div>
      <ul className="divide-y divide-border border-y border-border">
        {v.files.map((f) => (
          <li key={f.fileId} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
            <div className="min-w-0">
              <p className="truncate font-medium">{f.deliverable}</p>
              <p className="text-xs text-ink-muted">
                v{f.version} · {f.name} {f.sizeBytes ? `· ${size(f.sizeBytes)}` : ""}
              </p>
            </div>
            <div className="flex gap-3 text-xs">
              <a href={f.url} target="_blank" rel="noreferrer" className="text-ink-muted underline hover:text-ink">
                View
              </a>
              {f.downloadUrl && (
                <a href={f.downloadUrl} className="font-medium underline">
                  Download
                </a>
              )}
            </div>
          </li>
        ))}
        {v.files.length === 0 && <li className="py-4 text-center text-xs text-ink-muted">No approved files yet.</li>}
      </ul>

      {v.links.length > 0 && (
        <div>
          <p className="mb-2 font-medium">Links</p>
          <ul className="space-y-1">
            {v.links.map((l, i) => (
              <li key={`${l.url}-${i}`} className="break-all">
                {l.label}:{" "}
                <a href={l.url} target="_blank" rel="noreferrer" className="underline">
                  {l.url}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <p className="mb-2 font-medium">Logins and notes handed over</p>
        {v.items.length === 0 ? (
          <p className="text-xs text-ink-muted">{v.released || v.can.addItems ? "Nothing added yet." : "Shown here once the final files are released."}</p>
        ) : (
          <ul className="divide-y divide-border border-y border-border">
            {v.items.map((i) => (
              <li key={i.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p>
                    <Badge tone="neutral">{kindLabel[i.kind]}</Badge> <span className="ml-1 font-medium">{i.label}</span>
                  </p>
                  <p className="mt-1 whitespace-pre-wrap break-all font-mono text-xs">
                    {i.kind === "credential" && !reveal[i.id] ? "••••••••" : i.value}{" "}
                    {i.kind === "credential" && (
                      <button className="font-sans underline" onClick={() => setReveal((r) => ({ ...r, [i.id]: !r[i.id] }))}>
                        {reveal[i.id] ? "hide" : "show"}
                      </button>
                    )}
                  </p>
                  <p className="text-[11px] text-ink-muted">
                    Added by {i.addedBy} · {when.format(new Date(i.at))}
                  </p>
                </div>
                {v.can.addItems && (
                  <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => remove(i.id)}>
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {v.can.addItems && <AddHandoverItem engagementId={v.engagementId} onAdded={onChange} />}
      {error && <p className="text-xs text-red">{error}</p>}
    </div>
  );
}

function AddHandoverItem({ engagementId, onAdded }: { engagementId: string; onAdded: (v: DeliverHandoverView) => void }) {
  const [kind, setKind] = useState<"link" | "credential" | "note">("credential");
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <form
      className="grid gap-2 border border-border p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(undefined);
        try {
          onAdded(await api.deliver.addHandoverItem(engagementId, { kind, label, value }));
          setLabel("");
          setValue("");
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="text-xs font-medium">Add to the handover pack</p>
      <div className="flex flex-wrap gap-2">
        <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Kind">
          <option value="credential">Login / access</option>
          <option value="link">Link</option>
          <option value="note">Note</option>
        </Select>
        <Input className="min-w-40 flex-1" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={kind === "credential" ? "e.g. Website admin" : kind === "link" ? "e.g. Figma source" : "e.g. Fonts licence"} required minLength={2} />
      </div>
      <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder={kind === "credential" ? "username / password or how to get access" : kind === "link" ? "https://" : "Details"} required />
      <div className="flex items-center gap-2">
        <Button type="submit" variant="secondary" className="py-1.5" disabled={busy}>
          Add
        </Button>
        {error && <span className="text-xs text-red">{error}</span>}
      </div>
    </form>
  );
}

/** Feedback step: 0-10 "How likely are you to recommend BMU?" plus a comment. */
export function FeedbackForm({ v, onChange }: { v: DeliverHandoverView; onChange: (v: DeliverHandoverView) => void }) {
  const [score, setScore] = useState<number | null>(v.feedback.mine?.score ?? null);
  const [comment, setComment] = useState(v.feedback.mine?.comment ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  if (!v.can.giveFeedback) return null;
  return (
    <form
      data-testid="feedback-form"
      className="grid gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (score === null) return setError("Pick a score from 0 to 10");
        setBusy(true);
        setError(undefined);
        try {
          onChange(await api.deliver.feedback(v.engagementId, score, comment || undefined));
          setSaved(true);
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="text-sm">How likely are you to recommend BMU to a friend or another business?</p>
      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Score from 0 to 10">
        {Array.from({ length: 11 }, (_, n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={score === n}
            aria-label={`${n}`}
            onClick={() => setScore(n)}
            className={`h-9 w-9 border text-sm tabular-nums ${score === n ? "border-charcoal bg-charcoal text-ivory" : "border-border bg-surface-raised hover:border-ink"}`}
          >
            {n}
          </button>
        ))}
      </div>
      <div className="flex justify-between text-[11px] text-ink-muted sm:max-w-[430px]">
        <span>Not likely</span>
        <span>Very likely</span>
      </div>
      <textarea className="w-full border border-border bg-surface-raised px-3 py-2 text-sm" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What went well, and what should we do better? (optional)" />
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={busy}>
          {v.feedback.mine ? "Update feedback" : "Send feedback"}
        </Button>
        {saved && <span className="text-xs text-[#5f8a12]">Thank you, your feedback was sent.</span>}
        {error && <span className="text-xs text-red">{error}</span>}
      </div>
    </form>
  );
}

/** Team-side summary of client feedback for this engagement. */
export function FeedbackSummary({ v }: { v: DeliverHandoverView }) {
  if (!v.feedback.all.length) return <p className="text-xs text-ink-muted">No client feedback yet. The client is asked after the final sign-off.</p>;
  return (
    <ul className="space-y-2 text-sm">
      {v.feedback.all.map((f, i) => (
        <li key={i}>
          <Badge tone={deliverNpsBand(f.score) === "promoter" ? "green" : deliverNpsBand(f.score) === "detractor" ? "red" : "amber"}>{f.score}/10</Badge> <span className="font-medium">{f.name}</span>{" "}
          <span className="text-xs text-ink-muted">{when.format(new Date(f.at))}</span>
          {f.comment && <p className="mt-0.5 text-xs">{f.comment}</p>}
        </li>
      ))}
    </ul>
  );
}
