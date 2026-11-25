"use client";

import { useState } from "react";
import type { ClientOnboarding, RequirementItemView } from "@bmu/shared";
import { Panel } from "@/components/dash";
import { Badge, Button, Input } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

// Client-facing wording (glossary: Blocked → Waiting on input).
const label = { pending: "Needed from you", waiting: "Sent, BMU is checking", received: "Received", blocked: "Waiting on input" };
const tone = { pending: "amber", waiting: "neutral", received: "green", blocked: "red" } as const;

/**
 * What BMU needs from the client before work starts. "access": account access (e.g. website admin login), answered in
 * text, on the Onboarding page. "items": everything else (logo, brand guidelines, details…), on the Brand kit page.
 * Shows nothing when the client has no such items.
 */
export function ClientChecklist({ kind }: { kind: "access" | "items" }) {
  const o = useLoad(() => api.client.onboarding());
  const [fresh, setFresh] = useState<ClientOnboarding>();
  const [error, setError] = useState<string>();
  const groups = ((fresh ?? o.data)?.engagements ?? [])
    .map((e) => ({ ...e, requirements: e.requirements.filter((r) => (r.type === "access") === (kind === "access")) }))
    .filter((e) => e.requirements.length);
  if (o.error && !o.data) return <p className="mt-6 text-sm text-red">{o.error}</p>;
  if (!groups.length) return null;

  return (
    <Panel
      className="mt-6"
      title={kind === "access" ? "Account access" : "Items we need from you"}
      subtitle={kind === "access" ? "Tell us how to get into the accounts we will work on." : "Your project start date is set as soon as we have everything."}
      flush
    >
      <div data-testid={`checklist-${kind}`}>
        {error && (
          <p role="alert" className="border-b border-red bg-red/10 px-5 py-2 text-sm">
            {error}
          </p>
        )}
        {groups.map((e) => (
          <section key={e.id} className="border-b border-border px-5 py-4 last:border-b-0">
            <h3 className="text-sm font-semibold">{e.serviceName}</h3>
            <ul className="divide-y divide-border">
              {e.requirements.map((r) => (
                <Item
                  key={r.id}
                  r={r}
                  withFile={kind === "items"}
                  onSend={async (note, file) => {
                    setError(undefined);
                    try {
                      setFresh(file ? await api.deliver.uploadRequirement(r.id, file, note || undefined) : await api.client.submitRequirement(r.id, note));
                    } catch (err) {
                      setError((err as Error).message);
                    }
                  }}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Panel>
  );
}

function Item({ r, withFile, onSend }: { r: RequirementItemView; withFile: boolean; onSend: (note: string, file?: File) => Promise<void> }) {
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const canSend = r.status === "pending" || r.status === "blocked";
  return (
    <li className="py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>{r.label}</span>
        <Badge tone={tone[r.status]}>{label[r.status]}</Badge>
      </div>
      {r.status === "blocked" && r.blockedReason && <p className="mt-1 text-xs text-ink-muted">{r.blockedReason}</p>}
      {canSend && (
        <form
          className="mt-2 grid gap-2"
          onSubmit={async (ev) => {
            ev.preventDefault();
            setBusy(true);
            await onSend(note, file);
            setBusy(false);
          }}
        >
          <div className="flex flex-wrap gap-2">
            <Input
              className="min-w-[220px] flex-1"
              value={note}
              onChange={(ev) => setNote(ev.target.value)}
              placeholder={!withFile ? "How to give us access (e.g. invite sent to access@bmu.in, or login details)" : file ? "Add a note (optional)" : "Paste a link (Drive, Dropbox) or write a note"}
              required={!file}
              aria-label={`Note for ${r.label}`}
            />
            <Button type="submit" disabled={busy || (!note && !file)}>
              {busy ? "Sending…" : "Send"}
            </Button>
          </div>
          {withFile && (
            <label className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
              or upload a file:
              <input type="file" className="text-xs" aria-label={`File for ${r.label}`} onChange={(ev) => setFile(ev.target.files?.[0])} />
            </label>
          )}
        </form>
      )}
    </li>
  );
}
