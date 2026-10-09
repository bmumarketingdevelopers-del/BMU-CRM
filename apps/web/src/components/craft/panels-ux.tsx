"use client";
import Link from "next/link";
import type { CraftUxPanels } from "@bmu/shared";
import { Insight } from "@/components/charts";
import { Empty, Grid, Meter, Panel } from "@/components/dash";
import { BrandKitCard, ChecklistCard, CommentList, RoundsList, StageBoard } from "./craft-bits";

export function UxPanels({ p, readOnly }: { p: CraftUxPanels; readOnly: boolean }) {
  const handoffOpen = p.handoff.filter((h) => h.done < h.total);
  return (
    <>
      <Panel title="Design jobs by phase" subtitle="Research → wireframe → UI → prototype → handoff. The phase follows your current flow step.">
        <StageBoard stages={p.phases} empty="Nothing in this phase" />
      </Panel>

      <Grid>
        <Panel title="Pinned client comments" subtitle="Pins and notes clients left on your screens. Resolve each one as you fix it.">
          <CommentList comments={p.pins} readOnly={readOnly} empty="No open client pins on your designs." />
        </Panel>
        <div className="grid gap-6">
          <Panel title="Compare versions" subtitle="Side-by-side shortcut for designs with more than one version.">
            {p.compare.length ? (
              <ul className="divide-y divide-border">
                {p.compare.map((c) => (
                  <li key={c.deliverableId} className="flex items-center justify-between gap-3 py-2">
                    <span className="min-w-0 truncate text-sm">
                      {c.title}
                      <span className="block text-xs text-ink-muted">
                        {c.client} · {c.versions} versions
                      </span>
                    </span>
                    <Link href={c.href} className="shrink-0 border border-border px-2.5 py-1 text-xs hover:border-ink">
                      Compare v{c.versions - 1} ↔ v{c.versions}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>Compare appears once a design has two versions.</Empty>
            )}
          </Panel>
          <Panel title="Revision rounds & first-time approval">
            <div className="mb-4">
              <p className="mb-1 text-sm">First-time approval</p>
              <Meter value={p.firstTime.rate ?? 0} tone={(p.firstTime.rate ?? 0) >= 70 ? "good" : "warn"} />
              <p className="mt-1 text-xs text-ink-muted">{p.firstTime.total ? `${p.firstTime.good} of ${p.firstTime.total} designs approved with no changes this period` : "Nothing approved this period yet"}</p>
            </div>
            <RoundsList rounds={p.rounds} limit={5} />
          </Panel>
        </div>
      </Grid>

      <Panel title="Handoff checklist" subtitle="Finish these before developers pick a design up. Ticks save straight away.">
        {p.handoff.length ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {p.handoff.map((h) => (
              <ChecklistCard key={h.deliverableId} list={h} readOnly={readOnly} />
            ))}
          </div>
        ) : (
          <Empty>Handoff checklists appear when a design reaches prototype or is approved.</Empty>
        )}
        {handoffOpen.length > 0 && <Insight tone="warn">{handoffOpen.length} design{handoffOpen.length === 1 ? " is" : "s are"} not fully handed off. Developers start faster with tokens, states and exported assets ready.</Insight>}
      </Panel>

      <Panel title="Design system & brand assets" subtitle="Brand kit per client you are designing for: colours, fonts, notes and brand files.">
        {p.brand.length ? (
          <div className="grid gap-4 md:grid-cols-2">
            {p.brand.map((k) => (
              <BrandKitCard key={k.clientId} kit={k} readOnly={readOnly} />
            ))}
          </div>
        ) : (
          <Empty>No clients on your current jobs.</Empty>
        )}
      </Panel>
    </>
  );
}
