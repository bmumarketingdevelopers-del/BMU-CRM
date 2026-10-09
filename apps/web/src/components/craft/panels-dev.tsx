"use client";
import { useState } from "react";
import Link from "next/link";
import type { CraftDevPanels } from "@bmu/shared";
import { CsvButton, Insight } from "@/components/charts";
import { DataTable, Empty, Grid, Meter, Panel } from "@/components/dash";
import { Badge, Button, Input } from "@/components/ui";
import { api } from "@/lib/api";
import { ErrorLine, StageBoard, dueLabel, fmtDay, useAction } from "./craft-bits";

export function DevPanels({ p, readOnly, onChanged }: { p: CraftDevPanels; readOnly: boolean; onChanged: () => void }) {
  const over = p.hours.filter((h) => h.loggedHours > h.estimateHours);
  return (
    <>
      <Panel title="Web projects" subtitle="Milestones = pages approved by the client. Open a project for its full plan.">
        {p.projects.length ? (
          <div className="grid gap-4 md:grid-cols-2">
            {p.projects.map((pr) => (
              <div key={pr.engagementId} className="border border-border p-4">
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <Link href={pr.href} className="text-sm font-semibold hover:underline">
                    {pr.client}
                  </Link>
                  <span className="text-xs text-ink-muted">{pr.deadline ? `last page due ${fmtDay(pr.deadline)}` : ""}</span>
                </div>
                <p className="mb-2 text-xs text-ink-muted">
                  {pr.service} · {pr.done} of {pr.total} pages approved
                </p>
                <Meter value={pr.pct} tone={pr.pct >= 75 ? "good" : "default"} />
                <ul className="mt-3 flex flex-wrap gap-1.5">
                  {pr.deliverables.map((d) => (
                    <li key={d.id}>
                      <Link href={d.href} title={d.statusLabel} className={`block border px-2 py-0.5 text-[11px] hover:border-ink ${["approved", "scheduled", "published"].includes(d.status) ? "border-green bg-green/10" : d.status === "planned" ? "border-border text-ink-muted" : "border-border"}`}>
                        {d.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : (
          <Empty>No web projects assigned to you.</Empty>
        )}
      </Panel>

      <Panel title="Task board" subtitle="Your build tasks: backlog, in progress, with QC or the client, and done.">
        <StageBoard stages={p.board} empty="Empty" />
      </Panel>

      <Grid>
        <Panel title="Bugs & change requests" subtitle="Change and urgent requests from clients on your web projects." flush>
          <DataTable
            rows={p.changes}
            rowKey={(r) => r.id}
            rowHref={(r) => r.href}
            empty="No change requests right now."
            columns={[
              { key: "d", header: "Request", cell: (r) => <span className="line-clamp-2">{r.description}</span> },
              { key: "p", header: "Page", cell: (r) => <span className="text-ink-muted">{r.deliverable ?? r.client}</span> },
              { key: "s", header: "Status", cell: (r) => <Badge tone={r.overdue ? "red" : ["done", "declined"].includes(r.status) ? "green" : "amber"}>{r.overdue ? "Reply overdue" : r.status.replace(/_/g, " ")}</Badge> },
            ]}
          />
        </Panel>
        <Links links={p.links} readOnly={readOnly} onChanged={onChanged} />
      </Grid>

      <Panel title="Web QC checklist" subtitle="Latest QC result per page: responsive, speed, SEO basics, forms and links.">
        {p.qc.length ? (
          <div className="-mx-5 overflow-x-auto px-5">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.1em] text-ink-muted">
                  <th className="py-2 pr-3 font-medium">Page</th>
                  {(p.qc.find((q) => q.items.length)?.items ?? []).map((i) => (
                    <th key={i.label} className="px-2 py-2 text-center font-medium" title={i.label}>
                      {i.label.split(/[ ,(]/)[0]}
                    </th>
                  ))}
                  <th className="py-2 pl-3 text-right font-medium">Result</th>
                </tr>
              </thead>
              <tbody>
                {p.qc.map((q) => (
                  <tr key={q.deliverableId} className="border-b border-border last:border-0">
                    <td className="py-2 pr-3">
                      <Link href={q.href} className="hover:underline">
                        {q.title}
                      </Link>
                      <span className="block text-xs text-ink-muted">{q.client}</span>
                    </td>
                    {q.items.map((i) => (
                      <td key={i.label} className="px-2 py-2 text-center" title={`${i.label}${i.note ? `: ${i.note}` : ""}`}>
                        {i.ok === null ? <span className="text-ink-muted">·</span> : i.ok ? <span className="text-[#5f8a12]">✓</span> : <span className="font-semibold text-red">✗</span>}
                      </td>
                    ))}
                    <td className="py-2 pl-3 text-right">
                      {q.result ? <Badge tone={q.result === "pass" ? "green" : "red"}>{q.result === "pass" ? "Passed" : "Failed"}</Badge> : <span className="text-xs text-ink-muted">Not checked</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No pages have been through QC yet.</Empty>
        )}
      </Panel>

      <Panel
        title="Hours vs estimate"
        subtitle="Time logged on current and recently finished build tasks vs the flow template estimate (6 focused hours per working day)."
        action={<CsvButton rows={p.hours} filename="dev-hours" columns={[{ header: "Task", value: (r) => r.title }, { header: "Client", value: (r) => r.client }, { header: "Logged h", value: (r) => r.loggedHours }, { header: "Estimate h", value: (r) => r.estimateHours }]} />}
      >
        {p.hours.length ? (
          <ul className="space-y-3">
            {p.hours.map((h) => (
              <li key={h.taskId}>
                <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
                  <Link href={h.href} className="truncate hover:underline">
                    {h.title}
                  </Link>
                  <span className={`shrink-0 text-xs tabular-nums ${h.loggedHours > h.estimateHours ? "font-medium text-red" : "text-ink-muted"}`}>
                    {h.loggedHours}h / {h.estimateHours}h{h.done ? " · done" : ""}
                  </span>
                </div>
                <Meter value={(h.loggedHours / Math.max(1, h.estimateHours)) * 100} tone={h.loggedHours > h.estimateHours ? "bad" : "default"} />
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No build time logged in this period.</Empty>
        )}
        <Insight tone={over.length ? "warn" : "default"}>
          {p.totals.loggedHours}h logged against {p.totals.estimateHours}h estimated.{" "}
          {over.length ? `${over.length} task${over.length === 1 ? " is" : "s are"} over estimate — usually a sign of scope creep worth raising with the AM.` : "Everything is within its estimate."}
        </Insight>
      </Panel>
    </>
  );
}

/** Staging and live links per page, stored as link versions. Adding a staging link sends that build to QC. */
function Links({ links, readOnly, onChanged }: { links: CraftDevPanels["links"]; readOnly: boolean; onChanged: () => void }) {
  const [adding, setAdding] = useState<string>();
  const [url, setUrl] = useState("");
  const { busy, error, run } = useAction();
  return (
    <Panel title="Staging & live links" subtitle="Latest staging build per page, and the live link once the client approves.">
      {links.length ? (
        <ul className="divide-y divide-border">
          {links.map((l) => (
            <li key={l.deliverableId} className="py-2.5" data-links={l.deliverableId}>
              <div className="flex items-baseline justify-between gap-2">
                <Link href={l.href} className="truncate text-sm font-medium hover:underline">
                  {l.title}
                </Link>
                <span className="shrink-0 text-xs text-ink-muted">{l.client}</span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                {l.live ? (
                  <a href={l.live.url} target="_blank" rel="noreferrer" className="text-[#5f8a12] underline">
                    Live (build {l.live.number}) ↗
                  </a>
                ) : l.staging ? (
                  <a href={l.staging.url} target="_blank" rel="noreferrer" className="underline">
                    Staging build {l.staging.number} · {dueLabel(l.staging.at)} ↗
                  </a>
                ) : (
                  <span className="text-ink-muted">No staging link yet</span>
                )}
                {!readOnly && l.canAdd && adding !== l.deliverableId && (
                  <button className="text-ink-muted underline-offset-2 hover:text-ink hover:underline" onClick={() => (setAdding(l.deliverableId), setUrl(""))}>
                    + New staging link
                  </button>
                )}
              </div>
              {adding === l.deliverableId && (
                <form
                  className="mt-2 flex gap-2"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const r = await run(l.deliverableId, () => api.deliverables.addLinkVersion(l.deliverableId, url, "Staging build"));
                    if (r) {
                      setAdding(undefined);
                      onChanged();
                    }
                  }}
                >
                  <Input aria-label="Staging URL" type="url" required placeholder="https://staging.example.com/page" value={url} onChange={(e) => setUrl(e.target.value)} />
                  <Button type="submit" className="shrink-0 px-3 py-1.5 text-xs" disabled={!!busy}>
                    {busy ? "Saving…" : "Send to QC"}
                  </Button>
                </form>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <Empty>No pages in progress.</Empty>
      )}
      <ErrorLine error={error} />
    </Panel>
  );
}
