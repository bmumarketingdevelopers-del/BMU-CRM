"use client";

import { useState } from "react";
import Link from "next/link";
import type { TeamPeopleProcess } from "@bmu/shared";
import { Empty, Panel, Tabs } from "@/components/dash";
import { Badge, LoadState } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const day = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });
const dayTime = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
const fmtDay = (s: string | null) => (s ? day.format(new Date(s)) : "—");

type Tab = "open" | "done";

/** Every onboarding the signed-in person is part of: added by them, reporting to them, in their department, or as buddy. */
export function OnboardingHistory() {
  const loaded = useLoad(() => api.teamFlows.people.involved());
  const [tab, setTab] = useState<Tab>("open");
  if (!loaded.data) return <LoadState loading={loaded.loading} error={loaded.error} />;
  // Their own checklist is shown in full above this list.
  const all = loaded.data.filter((p) => !p.involvement?.includes("Your onboarding"));
  const open = all.filter((p) => p.status === "open");
  const done = all.filter((p) => p.status === "done");
  const list = tab === "open" ? open : done;

  return (
    <div className="space-y-4" data-testid="onboarding-history">
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        options={[
          { value: "open", label: `In progress (${open.length})` },
          { value: "done", label: `Completed (${done.length})` },
        ]}
      />
      <Panel>
        {list.length === 0 ? (
          <Empty>{tab === "open" ? "No onboarding in progress that involves you." : "No completed onboarding yet."}</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {list.map((p) => (
              <HistoryRow key={p.id} p={p} />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function HistoryRow({ p }: { p: TeamPeopleProcess }) {
  const [openLog, setOpenLog] = useState(false);
  const log = p.items.filter((i) => i.done && i.doneAt).sort((a, b) => (b.doneAt ?? "").localeCompare(a.doneAt ?? ""));
  return (
    <li className="py-4" data-onboarding={p.id}>
      <div className="grid gap-2 lg:grid-cols-[1fr_auto]">
        <div>
          <p className="font-semibold">
            <Link href={`/team/onboarding/${p.id}`} className="underline-offset-2 hover:underline">
              {p.user.name}
            </Link>{" "}
            <span className="font-normal text-ink-muted">
              · {[p.user.role, p.user.department].filter(Boolean).join(" · ") || "Team member"}
            </span>
          </p>
          <p className="text-sm text-ink-muted">
            Joining {fmtDay(p.startDate)} · added by {p.startedBy ?? "HR"} on {fmtDay(p.createdAt)}
            {p.buddy ? ` · buddy ${p.buddy.name}` : ""}
          </p>
          <div className="mt-2 flex flex-wrap gap-1">
            {(p.involvement ?? []).map((x) => (
              <Badge key={x} tone="neutral">
                {x}
              </Badge>
            ))}
          </div>
        </div>
        <div className="flex flex-col items-start gap-1 text-sm lg:items-end">
          <Badge tone={p.status === "done" ? "green" : "amber"}>{p.status === "done" ? "completed" : "in progress"}</Badge>
          <span className="text-ink-muted">
            {p.doneCount} of {p.items.length} done ({p.progressPct}%)
          </span>
          {p.completedAt && <span className="text-xs text-ink-muted">Completed {fmtDay(p.completedAt)}</span>}
        </div>
      </div>
      <div className="mt-2 h-1.5 w-full bg-border" aria-hidden>
        <div className={`h-1.5 ${p.status === "done" ? "bg-green" : "bg-amber"}`} style={{ width: `${p.progressPct}%` }} />
      </div>
      <button type="button" onClick={() => setOpenLog(!openLog)} className="mt-2 text-xs underline">
        {openLog ? "Hide history" : `Show history (${log.length})`}
      </button>
      {openLog && (
        <ol className="mt-2 space-y-1 border-l border-border pl-3 text-sm">
          {p.completedAt && (
            <li>
              <span className="text-ink-muted">{dayTime.format(new Date(p.completedAt))}</span> · Onboarding completed
            </li>
          )}
          {log.map((i) => (
            <li key={i.key}>
              <span className="text-ink-muted">{dayTime.format(new Date(i.doneAt!))}</span> · {i.label}
              {i.doneBy ? <span className="text-ink-muted"> · {i.auto ? "automatic" : `by ${i.doneBy}`}</span> : i.auto ? <span className="text-ink-muted"> · automatic</span> : null}
            </li>
          ))}
          <li>
            <span className="text-ink-muted">{dayTime.format(new Date(p.createdAt))}</span> · Onboarding started by {p.startedBy ?? "HR"}
          </li>
          {p.items.some((i) => !i.done) && (
            <li className="text-ink-muted">Still to do: {p.items.filter((i) => !i.done).map((i) => i.label).join(" · ")}</li>
          )}
        </ol>
      )}
    </li>
  );
}
