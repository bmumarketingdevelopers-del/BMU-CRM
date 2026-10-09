"use client";
import Link from "next/link";
import type { CraftVideoPanels } from "@bmu/shared";
import { CsvButton, Insight } from "@/components/charts";
import { BarList, DataTable, Empty, Grid, Panel } from "@/components/dash";
import { Badge } from "@/components/ui";
import { ChecklistCard, CommentList, RoundsList, StageBoard, UploadVersion, dueLabel } from "./craft-bits";

const reqTone = (s: string) => (s === "received" ? "green" : s === "blocked" ? "red" : "amber");

export function VideoPanels({ p, readOnly }: { p: CraftVideoPanels; readOnly: boolean }) {
  const slow = [...p.hoursPerVideo].sort((a, b) => b.hours - a.hours)[0];
  return (
    <>
      <Panel title="Edit queue" subtitle="Every video you are editing, by stage. Move work forward by uploading the next cut; stages update automatically.">
        <StageBoard
          stages={p.stages}
          empty="Nothing at this stage"
          render={(j) => (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {j.roundsUsed > 0 && <Badge tone={j.roundsIncluded - j.roundsUsed <= 0 ? "red" : "neutral"}>Round {j.roundsUsed}/{j.roundsIncluded}</Badge>}
              {j.canUpload && !readOnly && <UploadVersion deliverableId={j.deliverableId} label="Upload cut" accept="video/*,image/*" />}
            </div>
          )}
        />
      </Panel>

      <Grid>
        <Panel title="Client notes to resolve" subtitle="Time-coded comments from Review Studio. Resolve each one as you fix it.">
          <CommentList comments={p.timeComments} readOnly={readOnly} empty="No open client notes on your videos." />
        </Panel>
        <Panel title="Footage & assets from clients" subtitle="What each job needs from the client before or during the edit.">
          {p.assets.length ? (
            <ul className="space-y-4">
              {p.assets.map((a) => (
                <li key={a.deliverableId}>
                  <Link href={a.href} className="text-sm font-medium hover:underline">
                    {a.client}
                  </Link>
                  <p className="text-xs text-ink-muted">{a.title}</p>
                  <ul className="mt-1.5 space-y-1">
                    {a.items.map((i) => (
                      <li key={i.label} className="flex items-center justify-between gap-2 text-sm">
                        <span className="truncate">{i.label}</span>
                        <Badge tone={reqTone(i.status)}>{i.status === "received" ? "Received" : i.note ?? i.status}</Badge>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No asset lists on your current jobs.</Empty>
          )}
        </Panel>
      </Grid>

      <Grid>
        <Panel title="Render & export checklist" subtitle="Tick each step before the final export. Saved per video.">
          {p.exportChecklists.length ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {p.exportChecklists.slice(0, 6).map((c) => (
                <ChecklistCard key={c.deliverableId} list={c} readOnly={readOnly} />
              ))}
            </div>
          ) : (
            <Empty>Checklists appear when a video reaches colour, sound and export.</Empty>
          )}
        </Panel>
        <div className="grid gap-6">
          <Panel title="Revision rounds left" subtitle="Included in the client's package vs used.">
            <RoundsList rounds={p.rounds} />
          </Panel>
          <Panel title="This week" subtitle="Shoots and edit deadlines in the next 7 days.">
            {p.upcoming.length ? (
              <ul className="divide-y divide-border">
                {p.upcoming.map((u) => (
                  <li key={u.id} className="flex items-center justify-between gap-3 py-2">
                    <Link href={u.href} className="min-w-0 truncate text-sm hover:underline">
                      {u.title}
                      <span className="block text-xs text-ink-muted">{u.client}</span>
                    </Link>
                    <span className="flex shrink-0 items-center gap-2 text-xs text-ink-muted">
                      {u.kind === "shoot" && <Badge tone="dark">Shoot</Badge>}
                      {dueLabel(u.at)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No shoots or deadlines this week.</Empty>
            )}
          </Panel>
        </div>
      </Grid>

      <Panel
        title="Hours per video & turnaround"
        subtitle="Videos approved in this period: your logged hours and days from first edit to client approval."
        action={<CsvButton rows={p.hoursPerVideo} filename="hours-per-video" columns={[{ header: "Video", value: (r) => r.title }, { header: "Client", value: (r) => r.client }, { header: "Hours", value: (r) => r.hours }, { header: "Turnaround (days)", value: (r) => r.turnaroundDays }]} />}
        flush
      >
        <div className="grid lg:grid-cols-[1.4fr_1fr]">
          <DataTable
            rows={p.hoursPerVideo}
            rowKey={(r) => r.deliverableId}
            rowHref={(r) => r.href}
            empty="No videos approved in this period."
            columns={[
              { key: "t", header: "Video", cell: (r) => r.title },
              { key: "c", header: "Client", cell: (r) => <span className="text-ink-muted">{r.client}</span> },
              { key: "h", header: "Hours", align: "right", cell: (r) => `${r.hours}h` },
              { key: "d", header: "Turnaround", align: "right", cell: (r) => (r.turnaroundDays === null ? "—" : `${r.turnaroundDays}d`) },
            ]}
          />
          <div className="border-t border-border p-5 lg:border-t-0 lg:border-l">
            <BarList items={p.hoursPerVideo.slice(0, 6).map((r) => ({ label: r.title, value: r.hours, href: r.href, highlight: r === slow }))} format={(n) => `${n}h`} />
            {slow && p.avgTurnaroundDays !== null && (
              <Insight>
                Average turnaround is {p.avgTurnaroundDays} days. {slow.title} took the longest at {slow.hours}h{slow.turnaroundDays !== null ? ` over ${slow.turnaroundDays} days` : ""}. Long edits usually mean late footage or unclear briefs — flag them early.
              </Insight>
            )}
          </div>
        </div>
      </Panel>
    </>
  );
}
