"use client";

import { useState } from "react";
import type { FeatureFlagRow, SystemEventFailure, SystemProcess, SystemSubscriberStat } from "@bmu/shared";
import { DataTable, Grid, KeyValues, Panel, StatRow, StatTile } from "@/components/dash";
import { Badge, Button, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { FormNote, fmtDateTime } from "../_insights/kit";

const n = (v: number) => v.toLocaleString("en-IN");

/** v13 System health: database, event bus, live connections, search index, background jobs and feature flags. */
export default function SystemHealthPage() {
  const state = useLoad(() => api.system.health(), { live: false });
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const h = state.data;

  async function run(key: string, fn: () => Promise<string>) {
    setBusy(key);
    setNote(null);
    try {
      setNote({ ok: true, text: await fn() });
      state.reload();
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const toggle = (f: FeatureFlagRow) =>
    run(`flag-${f.key}`, async () => {
      await api.system.setFlag(f.key, { enabled: !f.enabled, roles: f.roles });
      return `${f.label} is now ${f.enabled ? "off" : "on"} for everyone it applies to.`;
    });

  return (
    <>
      <PageTitle
        title="System health"
        subtitle="Is everything running? Live updates, search, background jobs and feature switches in one place."
        action={
          <Button variant="secondary" onClick={() => state.reload()} disabled={state.loading}>
            Check again
          </Button>
        }
      />
      <LoadState loading={state.loading && !h} error={state.error} />
      {note && <FormNote ok={note.ok ? note.text : null} error={note.ok ? null : note.text} />}
      {h && (
        <div className="space-y-6">
          <StatRow cols={4}>
            <StatTile label="Database" value={h.database.ok ? "OK" : "Down"} hint={`${h.database.ms} ms to answer`} tone={h.database.ok ? "default" : "bad"} />
            <StatTile label="Changes in the last hour" value={n(h.events.lastHour)} hint={`${n(h.events.lastDay)} in the last day`} />
            <StatTile label="People online now" value={n(h.realtime.people)} hint={`${n(h.realtime.connections)} open screens`} />
            <StatTile label="Search index" value={n(h.search.documents)} hint={h.search.building ? "Rebuilding…" : h.search.builtAt ? `Built ${fmtDateTime(h.search.builtAt)}` : "Builds on first search"} />
          </StatRow>

          <Grid cols={2}>
            <Panel title="Event bus" subtitle="Every change is published once; these parts of the app listen.">
              <DataTable<SystemSubscriberStat>
                rows={h.events.subscribers}
                rowKey={(r) => r.name}
                columns={[
                  { key: "name", header: "Listener", cell: (r) => r.name },
                  { key: "ok", header: "Delivered", align: "right", cell: (r) => n(r.delivered) },
                  { key: "bad", header: "Failed", align: "right", cell: (r) => (r.failed ? <Badge tone="red">{n(r.failed)}</Badge> : "0") },
                ]}
              />
              <div className="mt-4">
                <KeyValues
                  items={[
                    { k: "Busiest records (last hour)", v: h.events.byEntity.length ? h.events.byEntity.slice(0, 5).map((e) => `${e.entity} ${e.count}`).join(" · ") : "Quiet" },
                    {
                      k: "Shared between processes",
                      v:
                        h.events.transport === "postgres"
                          ? h.events.bridge?.connected
                            ? `Yes, through the database (${n(h.events.bridge.sent)} sent, ${n(h.events.bridge.received)} received)`
                            : `Reconnecting${h.events.bridge?.lastError ? `: ${h.events.bridge.lastError}` : ""}`
                          : "No (single process)",
                    },
                    { k: "Running since", v: fmtDateTime(h.startedAt) },
                    { k: "Version", v: h.version },
                  ]}
                />
              </div>
            </Panel>

            <Panel
              title="Smart search"
              subtitle="Ctrl/Cmd+K index. It updates itself; rebuild only if results look out of date."
              action={
                <Button variant="secondary" disabled={busy === "search"} onClick={() => run("search", async () => `Search index rebuilt: ${n((await api.system.rebuildSearch()).documents)} records.`)}>
                  {busy === "search" ? "Rebuilding…" : "Rebuild index"}
                </Button>
              }
            >
              <KeyValues items={h.search.byKind.map((k) => ({ k: k.kind.charAt(0).toUpperCase() + k.kind.slice(1) + "s", v: n(k.count) }))} />
            </Panel>
          </Grid>

          {h.processes && (
            <Panel title="Processes" subtitle="Each running part of the backend: the API answers screens and the phone app; the worker runs background jobs.">
              <DataTable<SystemProcess>
                rows={h.processes}
                rowKey={(r) => r.id}
                columns={[
                  { key: "role", header: "Process", cell: (r) => `${r.role === "api" ? "API" : r.role === "worker" ? "Worker" : "API + jobs"}${r.current ? " (this one)" : ""}` },
                  { key: "host", header: "Where", cell: (r) => `${r.host} · pid ${r.pid}` },
                  { key: "jobs", header: "Jobs", align: "right", cell: (r) => n(r.jobs.length) },
                  { key: "since", header: "Running since", cell: (r) => fmtDateTime(r.startedAt) },
                  { key: "state", header: "Status", cell: (r) => <Badge tone={r.alive ? "green" : "neutral"}>{r.alive ? "Running" : `Last seen ${fmtDateTime(r.lastSeenAt)}`}</Badge> },
                ]}
              />
            </Panel>
          )}

          <Panel title="Failed deliveries" subtitle="A listener that fails is retried after 1, 2, 4 and 8 minutes, then waits here for you.">
            <DataTable<SystemEventFailure>
              rows={h.events.failures}
              rowKey={(r) => r.id}
              empty="Nothing has failed."
              columns={[
                { key: "when", header: "When", cell: (r) => fmtDateTime(r.createdAt) },
                { key: "what", header: "Event", cell: (r) => r.eventKind },
                { key: "who", header: "Listener", cell: (r) => r.subscriber },
                { key: "err", header: "Error", cell: (r) => <span className="text-xs">{r.error}</span> },
                { key: "state", header: "Status", cell: (r) => <Badge tone={r.status === "dead" ? "red" : "amber"}>{r.status === "dead" ? `Stopped after ${r.attempts} tries` : `Retrying (${r.attempts})`}</Badge> },
                {
                  key: "act",
                  header: "",
                  align: "right",
                  cell: (r) => (
                    <span className="flex justify-end gap-2">
                      <Button variant="secondary" disabled={busy === r.id} onClick={() => run(r.id, async () => (await api.system.retryFailure(r.id)).message)}>
                        Retry
                      </Button>
                      <Button variant="ghost" disabled={busy === r.id} onClick={() => run(r.id, async () => (await api.system.dismissFailure(r.id), "Dismissed"))}>
                        Dismiss
                      </Button>
                    </span>
                  ),
                },
              ]}
            />
          </Panel>

          <Grid cols={2}>
            <Panel title="Feature switches" subtitle="Turn new features on or off for everyone at once. Changes reach open screens within seconds.">
              <ul className="divide-y divide-border" data-testid="feature-flags">
                {h.flags.map((f) => (
                  <li key={f.key} className="flex items-start justify-between gap-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{f.label}</p>
                      <p className="text-xs text-ink-muted">{f.hint}</p>
                      {!f.isDefault && f.updatedBy && <p className="mt-1 text-[11px] text-ink-muted">Changed by {f.updatedBy} · {fmtDateTime(f.updatedAt)}</p>}
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={f.enabled}
                      aria-label={f.label}
                      disabled={busy === `flag-${f.key}`}
                      onClick={() => toggle(f)}
                      className={`shrink-0 border px-3 py-1 text-xs font-medium ${f.enabled ? "border-charcoal bg-charcoal text-white" : "border-border text-ink-muted"}`}
                    >
                      {f.enabled ? "On" : "Off"}
                    </button>
                  </li>
                ))}
              </ul>
            </Panel>
            <Panel title="Background jobs" subtitle="Scheduled work the worker runs by itself, with its last run.">
              <ul className="divide-y divide-border">
                {h.jobs.map((j) => (
                  <li key={j.name} className="flex items-start justify-between gap-4 py-3">
                    <div>
                      <p className="text-sm font-medium">{j.name}</p>
                      <p className="text-xs text-ink-muted">{j.hint}</p>
                    </div>
                    <Badge tone={j.on ? "green" : "neutral"}>{j.on ? "Running" : "Off"}</Badge>
                  </li>
                ))}
              </ul>
            </Panel>
          </Grid>
        </div>
      )}
    </>
  );
}
