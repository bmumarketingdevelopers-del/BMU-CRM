"use client";
import { useState } from "react";
import Link from "next/link";
import { CRAFT_SOCIAL_STAGES, type CraftSocialPanels } from "@bmu/shared";
import { CsvButton, Insight } from "@/components/charts";
import { DataTable, Empty, Grid, Meter, Panel, StackBar, Tabs } from "@/components/dash";
import { Badge, Button } from "@/components/ui";
import { api } from "@/lib/api";
import { ErrorLine, dueLabel, fmtDay, useAction } from "./craft-bits";

const stageTone = { idea: "muted", design: "grey", copy: "amber", client: "dark", approved: "green", scheduled: "green", published: "dark" } as const;
const weekday = new Intl.DateTimeFormat("en-IN", { weekday: "short", timeZone: "Asia/Kolkata" });
const statusTone = (s: string) => (["approved", "scheduled", "published"].includes(s) ? "green" : s === "ready_for_client" ? "amber" : "neutral");

export function SocialPanels({ p, readOnly, onChanged }: { p: CraftSocialPanels; readOnly: boolean; onChanged: () => void }) {
  const [client, setClient] = useState(p.pipeline[0]?.clientId ?? "");
  const current = p.pipeline.find((c) => c.clientId === client);
  return (
    <>
      <Panel title="Content pipeline" subtitle="Each client's content from idea to published. Click a piece to open it in Review Studio.">
        {p.pipeline.length ? (
          <>
            <div className="mb-4 space-y-4">
              {p.pipeline.map((c) => (
                <div key={c.clientId}>
                  <button onClick={() => setClient(c.clientId)} className={`mb-1.5 text-sm ${c.clientId === client ? "font-semibold" : "text-ink-muted hover:text-ink"}`}>
                    {c.client} {c.clientId === client ? "▾" : "▸"}
                  </button>
                  <StackBar parts={CRAFT_SOCIAL_STAGES.map((s) => ({ label: s.label, value: c.counts[s.key], tone: stageTone[s.key] }))} />
                </div>
              ))}
            </div>
            {current && (
              <div className="-mx-5 overflow-x-auto border-t border-border px-5 pt-4">
                <div className="grid min-w-max auto-cols-[minmax(170px,1fr)] grid-flow-col gap-2">
                  {CRAFT_SOCIAL_STAGES.map((s) => {
                    const items = current.items.filter((i) => i.socialStage === s.key);
                    return (
                      <div key={s.key} className="border border-border bg-surface p-2.5" data-social-stage={s.key}>
                        <p className="mb-2 flex justify-between text-[11px] uppercase tracking-[0.1em] text-ink-muted">
                          {s.label} <span className="text-ink">{items.length}</span>
                        </p>
                        <ul className="space-y-1.5">
                          {items.slice(0, 8).map((i) => (
                            <li key={i.deliverableId}>
                              <Link href={i.href} className="block border border-border bg-surface-raised px-2 py-1.5 text-xs hover:border-ink">
                                <span className="block truncate font-medium">{i.title}</span>
                                <span className={i.overdue ? "text-red" : "text-ink-muted"}>
                                  {i.type} · {dueLabel(i.due, i.overdue)}
                                </span>
                              </Link>
                            </li>
                          ))}
                          {items.length > 8 && <li className="text-[11px] text-ink-muted">+{items.length - 8} more</li>}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        ) : (
          <Empty>No social clients assigned to you yet.</Empty>
        )}
      </Panel>

      <Panel title="This week's posting schedule" subtitle="Across all your clients. Uses the scheduled date when one is set, otherwise the due date.">
        <div className="-mx-5 overflow-x-auto px-5">
          <div className="grid min-w-[720px] grid-cols-7 gap-px border border-border bg-border">
            {p.schedule.map((day, i) => (
              <div key={day.date} className={`min-h-36 bg-surface-raised p-2 ${i === 0 ? "bg-canvas/40" : ""}`} data-day={day.date}>
                <p className="mb-2 text-xs">
                  <span className="font-semibold">{i === 0 ? "Today" : weekday.format(new Date(`${day.date}T12:00:00+05:30`))}</span> <span className="text-ink-muted">{fmtDay(`${day.date}T12:00:00+05:30`)}</span>
                </p>
                <ul className="space-y-1.5">
                  {day.items.map((it) => (
                    <li key={it.id}>
                      <Link href={it.href} className="block border-l-2 border-charcoal bg-surface px-1.5 py-1 text-[11px] leading-snug hover:bg-canvas" title={`${it.title} · ${it.statusLabel}${it.dateSource === "due" ? " · by due date" : ""}`}>
                        <span className="block truncate font-medium">{it.title}</span>
                        <span className="block truncate text-ink-muted">{it.client}</span>
                        <Badge tone={statusTone(it.status)}>{it.statusLabel}</Badge>
                      </Link>
                    </li>
                  ))}
                  {!day.items.length && <li className="text-[11px] text-ink-muted">Nothing planned</li>}
                </ul>
              </div>
            ))}
          </div>
        </div>
        {(() => {
          const atRisk = p.schedule.flatMap((d) => d.items).filter((i) => !["approved", "scheduled", "published"].includes(i.status));
          return atRisk.length ? <Insight tone="warn">{atRisk.length} piece{atRisk.length === 1 ? " is" : "s are"} due to go out this week but not approved yet. Chase those first.</Insight> : null;
        })()}
      </Panel>

      <Grid>
        <Approvals approvals={p.approvals} readOnly={readOnly} onChanged={onChanged} />
        <Panel
          title="Client requests"
          subtitle="Open asks from your social clients."
          action={<CsvButton rows={p.requests} filename="social-requests" columns={[{ header: "Client", value: (r) => r.client }, { header: "Type", value: (r) => r.type }, { header: "Request", value: (r) => r.description }, { header: "Status", value: (r) => r.status }, { header: "Raised", value: (r) => r.createdAt.slice(0, 10) }]} />}
          flush
        >
          <DataTable
            rows={p.requests}
            rowKey={(r) => r.id}
            rowHref={(r) => r.href}
            empty="No client requests right now."
            columns={[
              { key: "d", header: "Request", cell: (r) => <span className="line-clamp-2">{r.description}</span> },
              { key: "c", header: "Client", cell: (r) => <span className="text-ink-muted">{r.client}</span> },
              { key: "s", header: "Status", cell: (r) => <Badge tone={r.overdue ? "red" : ["done", "declined"].includes(r.status) ? "green" : "neutral"}>{r.overdue ? "Reply overdue" : r.status.replace(/_/g, " ")}</Badge> },
            ]}
          />
        </Panel>
      </Grid>

      <Grid>
        <Panel title="Monthly package used" subtitle="Content planned this month vs what each client's package includes.">
          {p.quotas.length ? (
            <div className="space-y-5">
              {p.quotas.map((q) => (
                <div key={`${q.clientId}-${q.packageName}`}>
                  <p className="text-sm font-medium">{q.client}</p>
                  <p className="mb-2 text-xs text-ink-muted">
                    {q.packageName}
                    {q.source === "standard" ? " · standard quota (no quota written in the price book)" : ""}
                  </p>
                  <div className="grid gap-2">
                    {q.buckets.map((b) => (
                      <div key={b.key} className="grid grid-cols-[70px_1fr_56px] items-center gap-2 text-xs">
                        <span className="text-ink-muted">{b.label}</span>
                        <Meter value={(b.used / Math.max(1, b.quota)) * 100} tone={b.used > b.quota ? "bad" : b.used === b.quota ? "good" : "default"} suffix="%" />
                        <span className="text-right tabular-nums">
                          {b.used}/{b.quota}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty>No monthly social packages on your clients.</Empty>
          )}
        </Panel>
        <Panel title="Best-performing content" subtitle="Reach and engagement per post.">
          <p className="text-sm text-ink-muted">
            Performance numbers appear here once a social account integration sends real reach and engagement data. We don&apos;t show estimated or made-up metrics.
          </p>
        </Panel>
      </Grid>
    </>
  );
}

function Approvals({ approvals, readOnly, onChanged }: { approvals: CraftSocialPanels["approvals"]; readOnly: boolean; onChanged: () => void }) {
  const [sent, setSent] = useState<Record<string, string>>({});
  const [view, setView] = useState<"all" | "slow">("all");
  const { busy, error, run } = useAction();
  const rows = view === "slow" ? approvals.filter((a) => a.daysWaiting >= 2) : approvals;
  return (
    <Panel title="Approvals waiting on clients" subtitle="Sent for review, not yet approved. Nudge sends a polite reminder on the client's message thread." action={<Tabs value={view} onChange={setView} options={[{ value: "all", label: "All" }, { value: "slow", label: "2+ days" }]} />}>
      {rows.length ? (
        <ul className="divide-y divide-border">
          {rows.map((a) => (
            <li key={a.deliverableId} className="flex flex-wrap items-center gap-3 py-2.5" data-approval={a.deliverableId}>
              <div className="min-w-0 flex-1">
                <Link href={a.href} className="block truncate text-sm font-medium hover:underline">
                  {a.title}
                </Link>
                <p className="text-xs text-ink-muted">
                  {a.client} · sent {fmtDay(a.sentAt)}
                  {a.lastNudgeAt && !sent[a.deliverableId] ? ` · nudged ${fmtDay(a.lastNudgeAt)}` : ""}
                </p>
              </div>
              <Badge tone={a.daysWaiting >= 3 ? "red" : a.daysWaiting >= 2 ? "amber" : "neutral"}>
                {a.daysWaiting} day{a.daysWaiting === 1 ? "" : "s"}
              </Badge>
              {!readOnly &&
                (sent[a.deliverableId] ? (
                  <span className="text-xs text-[#5f8a12]">✓ Nudged</span>
                ) : (
                  <Button
                    variant="secondary"
                    className="px-2.5 py-1 text-xs"
                    disabled={!a.canNudge || busy === a.deliverableId}
                    title={a.canNudge ? "Post a polite reminder on the client thread" : "Already nudged in the last 24 hours"}
                    onClick={async () => {
                      const r = await run(a.deliverableId, () => api.craft.nudge(a.deliverableId));
                      if (r) {
                        setSent((s) => ({ ...s, [a.deliverableId]: r.at }));
                        onChanged();
                      }
                    }}
                  >
                    {busy === a.deliverableId ? "Sending…" : a.canNudge ? "Nudge client" : "Nudged today"}
                  </Button>
                ))}
            </li>
          ))}
        </ul>
      ) : (
        <Empty>{view === "slow" ? "Nothing has waited 2+ days." : "Nothing is waiting on clients."}</Empty>
      )}
      <ErrorLine error={error} />
    </Panel>
  );
}
