"use client";

import Link from "next/link";
import { useState } from "react";
import type { SopRow } from "@bmu/shared";
import { Empty, Panel, StatRow, StatTile } from "@/components/dash";
import { Input, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

export default function SopLibraryPage() {
  const loaded = useLoad(() => api.workspace.sops());
  const [q, setQ] = useState("");
  const [dept, setDept] = useState<string>("all");
  const all = loaded.data ?? [];
  const departments = [...new Map(all.map((s) => [s.department.id, s.department.name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const term = q.trim().toLowerCase();
  const rows = all.filter((s) => (dept === "all" || s.department.id === dept) && (!term || `${s.title} ${s.excerpt} ${s.department.name}`.toLowerCase().includes(term)));
  const groups = new Map<string, SopRow[]>();
  for (const s of rows) groups.set(s.department.name, [...(groups.get(s.department.name) ?? []), s]);

  return (
    <div className="[&_.grid>*]:min-w-0">
      <PageTitle title="SOP library" subtitle="How we do things at BMU, written down. Read-only here; department heads keep them up to date." />
      {!loaded.data ? (
        <LoadState loading={loaded.loading} error={loaded.error} />
      ) : (
        <div className="grid gap-6">
          <StatRow cols={3}>
            <StatTile label="SOPs" value={all.length} />
            <StatTile label="Departments covered" value={departments.length} />
            <StatTile label="Showing" value={rows.length} hint={term || dept !== "all" ? "Filtered" : "Everything"} />
          </StatRow>
          <div className="flex flex-wrap items-center gap-3">
            <Input className="max-w-sm" placeholder="Search SOPs, e.g. onboarding, QC, leave" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search SOPs" />
            <div className="flex flex-wrap gap-1 text-sm">
              {[["all", "All"] as const, ...departments].map(([id, name]) => (
                <button key={id} onClick={() => setDept(id)} className={`border px-3 py-1.5 ${dept === id ? "border-charcoal bg-charcoal text-ivory" : "border-border text-ink-muted hover:text-ink"}`}>
                  {name}
                </button>
              ))}
            </div>
          </div>
          {rows.length === 0 ? (
            <Panel>
              <Empty>{all.length ? "No SOPs match your search." : "No SOPs have been written yet. Department heads add them in the Command Centre."}</Empty>
            </Panel>
          ) : (
            [...groups.entries()].map(([name, list]) => (
              <Panel key={name} title={name} subtitle={`${list.length} SOP${list.length > 1 ? "s" : ""}`} flush>
                <ul className="divide-y divide-border">
                  {list.map((s) => (
                    <li key={s.id}>
                      <Link href={`/team/sops/${s.id}`} className="block px-5 py-4 transition-colors hover:bg-canvas/40">
                        <div className="flex items-baseline justify-between gap-3">
                          <p className="font-medium">{s.title}</p>
                          <span className="shrink-0 text-xs text-ink-muted">v{s.version}</span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-sm text-ink-muted">{s.excerpt}</p>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Panel>
            ))
          )}
        </div>
      )}
    </div>
  );
}
