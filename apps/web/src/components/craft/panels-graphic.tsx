"use client";
import { useState } from "react";
import type { CraftGraphicPanels } from "@bmu/shared";
import { CsvButton, Insight } from "@/components/charts";
import { ColumnChart, Empty, Grid, Meter, Panel, Tabs } from "@/components/dash";
import { Select } from "@/components/ui";
import { BrandKitCard, CommentList, JobRow, RoundsList, UploadVersion, fmtDay } from "./craft-bits";

export function GraphicPanels({ p, readOnly, onChanged }: { p: CraftGraphicPanels; readOnly: boolean; onChanged: () => void }) {
  const [filter, setFilter] = useState<"all" | "high">("all");
  const [target, setTarget] = useState(p.uploadable[0]?.id ?? "");
  const queue = filter === "high" ? p.queue.filter((j) => j.priority === "high") : p.queue;
  return (
    <>
      <Grid>
        <Panel
          title="Design queue"
          subtitle="Highest priority first: overdue, due within a day, or sent back with changes."
          action={
            <div className="flex items-center gap-2">
              <Tabs value={filter} onChange={setFilter} options={[{ value: "all", label: `All ${p.queue.length}` }, { value: "high", label: `High ${p.queue.filter((j) => j.priority === "high").length}` }]} />
              <CsvButton rows={p.queue} filename="design-queue" label="CSV" columns={[{ header: "Design", value: (r) => r.title }, { header: "Client", value: (r) => r.client.name }, { header: "Priority", value: (r) => r.priority }, { header: "Due", value: (r) => r.due?.slice(0, 10) }, { header: "Status", value: (r) => r.statusLabel }]} />
            </div>
          }
        >
          {queue.length ? (
            <div className="max-h-[560px] divide-y divide-border overflow-y-auto">
              {queue.map((j) => (
                <JobRow key={j.deliverableId} job={j} showPriority extra={j.canUpload && !readOnly ? <UploadVersion deliverableId={j.deliverableId} label="Upload" accept="image/*,application/pdf" onDone={onChanged} /> : undefined} />
              ))}
            </div>
          ) : (
            <Empty>Your queue is clear.</Empty>
          )}
        </Panel>
        <div className="grid gap-6">
          {!readOnly && (
            <Panel title="Quick upload" subtitle="Pick a design and upload the new version. It goes straight to QC.">
              {p.uploadable.length ? (
                <div className="flex flex-wrap items-center gap-3" data-quick-upload>
                  <Select aria-label="Design to upload" value={target} onChange={(e) => setTarget(e.target.value)} className="min-w-0 flex-1">
                    {p.uploadable.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.title} · {u.client}
                      </option>
                    ))}
                  </Select>
                  {target && <UploadVersion key={target} deliverableId={target} label="Choose file" accept="image/*,application/pdf" onDone={onChanged} />}
                </div>
              ) : (
                <Empty>Nothing to upload: your designs are with QC or the client.</Empty>
              )}
            </Panel>
          )}
          <Panel title="Daily output" subtitle="Versions you uploaded per day over the last two weeks.">
            <ColumnChart data={p.output.days.map((d) => ({ label: fmtDay(`${d.date}T12:00:00+05:30`).split(" ")[0], value: d.count }))} height={110} />
            <Insight tone={p.output.streak >= 3 ? "good" : "default"}>
              {p.output.today} today · best day {p.output.best} · {p.output.streak}-day streak (working days with output; Sundays don&apos;t count).
            </Insight>
          </Panel>
          <Panel title="QC first pass">
            <Meter value={p.firstPass.rate ?? 0} tone={(p.firstPass.rate ?? 0) >= 80 ? "good" : "warn"} />
            <p className="mt-1 text-xs text-ink-muted">
              {p.firstPass.total ? `${p.firstPass.good} of ${p.firstPass.total} versions passed QC on the first check` : "No QC checks this period"}
              {p.firstPass.previous !== null ? ` · ${p.firstPass.previous}% the period before` : ""}
            </p>
          </Panel>
        </div>
      </Grid>

      <Grid>
        <Panel title="Pinned feedback to resolve" subtitle="Client pins on your designs. Resolve them as you fix each spot.">
          <CommentList comments={p.pins} readOnly={readOnly} empty="No open client pins." />
        </Panel>
        <Panel title="Revision rounds left" subtitle="Included in each client's package vs used.">
          <RoundsList rounds={p.rounds} />
        </Panel>
      </Grid>

      <Panel title="Brand kits" subtitle="Logo, colours and fonts for the clients in your queue. Keep them up to date for the whole team.">
        {p.brand.length ? (
          <div className="grid gap-4 md:grid-cols-2">
            {p.brand.map((k) => (
              <BrandKitCard key={k.clientId} kit={k} readOnly={readOnly} />
            ))}
          </div>
        ) : (
          <Empty>No clients in your queue.</Empty>
        )}
      </Panel>
    </>
  );
}
