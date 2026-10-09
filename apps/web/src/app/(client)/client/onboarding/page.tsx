"use client";

import { useState } from "react";
import type { ClientOnboarding, RequirementItemView } from "@bmu/shared";
import { Badge, Button, Card, Input, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

// Client-facing wording (glossary: Blocked → Waiting on input, RCD → Project start date).
const label = { pending: "Needed from you", waiting: "Sent, BMU is checking", received: "Received", blocked: "Waiting on input" };
const tone = { pending: "amber", waiting: "neutral", received: "green", blocked: "red" } as const;
const day = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });

export default function OnboardingPage() {
  const o = useLoad(() => api.client.onboarding());
  const [fresh, setFresh] = useState<ClientOnboarding>();
  const [error, setError] = useState<string>();
  const data = fresh ?? o.data;
  if (!data) return <LoadState loading={o.loading} error={o.error} />;

  return (
    <>
      <PageTitle title="Getting started" subtitle="Send us these items. Your project start date is set as soon as we have everything." />
      {error && <p className="mb-4 border border-red bg-red/10 px-4 py-2 text-sm">{error}</p>}
      <div className="grid gap-4">
        {data.engagements.map((e) => (
          <Card key={e.id}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold">{e.serviceName}</h2>
              {e.rcdAt ? <Badge tone="green">Started {day.format(new Date(e.rcdAt))}</Badge> : <Badge tone="amber">Collecting items</Badge>}
            </div>
            <ul className="divide-y divide-border">
              {e.requirements.map((r) => (
                <Item
                  key={r.id}
                  r={r}
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
          </Card>
        ))}
        {data.engagements.length === 0 && (
          <Card>
            <p className="text-sm text-ink-muted">Nothing to send right now.</p>
          </Card>
        )}
      </div>
    </>
  );
}

function Item({ r, onSend }: { r: RequirementItemView; onSend: (note: string, file?: File) => Promise<void> }) {
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const canSend = r.status === "pending" || r.status === "blocked";
  const kind = r.type === "access" ? "access" : r.type === "asset" ? "asset" : "info";
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
              placeholder={kind === "access" ? "How to give us access (e.g. invite sent to access@bmu.in, or login details)" : file ? "Add a note (optional)" : "Paste a link (Drive, Dropbox) or write a note"}
              required={!file}
              aria-label={`Note for ${r.label}`}
            />
            <Button type="submit" disabled={busy || (!note && !file)}>
              {busy ? "Sending…" : "Send"}
            </Button>
          </div>
          <label className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
            or upload a file:
            <input type="file" className="text-xs" aria-label={`File for ${r.label}`} onChange={(ev) => setFile(ev.target.files?.[0])} />
          </label>
        </form>
      )}
    </li>
  );
}
