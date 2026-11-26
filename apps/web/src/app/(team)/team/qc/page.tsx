"use client";

// v50: the QC queue board. Tabs for what is waiting, passed and failed (results of the last 30 days), and filters for
// client, type of work, maker, waiting time, reviewer and department. Filtering happens here; the API sends one list.
import Link from "next/link";
import { useMemo, useState } from "react";
import { deliverableStatusLabels, type DeliverableStatus, type QcBoardRow, type QcBoardState } from "@bmu/shared";
import { DataTable, Panel, StatRow, StatTile, Tabs, type Column } from "@/components/dash";
import { Badge, Button, LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

type Tab = QcBoardState | "all";
type Wait = "any" | "4h" | "24h";
type Filters = { client: string; type: string; madeBy: string; wait: Wait; reviewer: string; department: string };

const HOUR = 3_600_000;
const NO_FILTERS: Filters = { client: "", type: "", madeBy: "", wait: "any", reviewer: "", department: "" };
const when = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
const stateBadge: Record<QcBoardState, { label: string; tone: "amber" | "green" | "red" }> = {
  waiting: { label: "Waiting", tone: "amber" },
  passed: { label: "Passed", tone: "green" },
  failed: { label: "Failed", tone: "red" },
};

function age(ms: number) {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** Distinct id/label pairs, sorted by label, for a filter dropdown. */
function options(rows: QcBoardRow[], pick: (r: QcBoardRow) => [string | null, string | null]) {
  const m = new Map<string, string>();
  for (const r of rows) {
    const [id, label] = pick(r);
    if (id && label) m.set(id, label);
  }
  return [...m].sort((a, b) => a[1].localeCompare(b[1]));
}

export default function QcQueuePage() {
  const q = useLoad(() => api.qc.board());
  return (
    <>
      <PageTitle title="QC queue" subtitle="Nothing reaches a client without passing QC. Waiting work is oldest first. Results stay internal." />
      {!q.data ? <LoadState loading={q.loading} error={q.error} /> : <Board rows={q.data.rows} days={q.data.days} />}
    </>
  );
}

function Board({ rows, days }: { rows: QcBoardRow[]; days: number }) {
  const [tab, setTab] = useState<Tab>("waiting");
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const [now] = useState(() => Date.now());
  const set = (p: Partial<Filters>) => setF((old) => ({ ...old, ...p }));

  const choices = useMemo(
    () => ({
      client: options(rows, (r) => [r.clientId, r.client]),
      type: options(rows, (r) => [r.type, r.type.replaceAll("_", " ")]),
      madeBy: options(rows, (r) => [r.madeById, r.madeBy]),
      reviewer: options(rows, (r) => [r.reviewerId, r.reviewer]),
      department: options(rows, (r) => [r.departmentId, r.department]),
    }),
    [rows],
  );

  const waitedMs = (r: QcBoardRow) => now - new Date(r.uploadedAt).getTime();
  // Every filter except the tab, so the tab counts and tiles follow the filters.
  const filtered = rows.filter(
    (r) =>
      (!f.client || r.clientId === f.client) &&
      (!f.type || r.type === f.type) &&
      (!f.madeBy || r.madeById === f.madeBy) &&
      (!f.department || r.departmentId === f.department) &&
      (!f.reviewer || r.reviewerId === f.reviewer) &&
      (f.wait === "any" || (r.state === "waiting" && waitedMs(r) >= (f.wait === "4h" ? 4 : 24) * HOUR)),
  );
  const shown = tab === "all" ? filtered : filtered.filter((r) => r.state === tab);
  const count = (s: QcBoardState) => filtered.filter((r) => r.state === s).length;
  const late = filtered.filter((r) => r.state === "waiting" && waitedMs(r) >= 24 * HOUR).length;
  const firstChecks = filtered.filter((r) => r.state !== "waiting" && r.versionNumber === 1);
  const firstPassPct = firstChecks.length ? Math.round((firstChecks.filter((r) => r.state === "passed").length / firstChecks.length) * 100) : null;
  const active = Object.entries(f).filter(([k, v]) => (k === "wait" ? v !== "any" : !!v)).length;

  const columns: Column<QcBoardRow>[] = [
    {
      key: "deliverable",
      header: "Deliverable",
      cell: (r) => (
        <>
          <Link href={`/team/deliverables/${r.deliverableId}`} className="font-medium underline">
            {r.title}
          </Link>
          <div className="text-xs capitalize text-ink-muted">
            {r.type.replaceAll("_", " ")} · v{r.versionNumber}
          </div>
        </>
      ),
    },
    {
      key: "client",
      header: "Client",
      cell: (r) => (
        <>
          {r.client}
          <div className="text-xs text-ink-muted">{[r.serviceName, r.department].filter(Boolean).join(" · ")}</div>
        </>
      ),
    },
    { key: "madeBy", header: "Made by", cell: (r) => r.madeBy || "—" },
    ...(tab === "all" ? [{ key: "state", header: "Status", cell: (r: QcBoardRow) => <Badge tone={stateBadge[r.state].tone}>{stateBadge[r.state].label}</Badge> }] : []),
    ...(tab === "waiting" || tab === "all"
      ? [
          {
            key: "waiting",
            header: "Waiting for",
            cell: (r: QcBoardRow) => {
              if (r.state !== "waiting") return <span className="text-ink-muted">—</span>;
              const ms = waitedMs(r);
              return (
                <span title={`Uploaded ${when.format(new Date(r.uploadedAt))}`} className={ms >= 24 * HOUR ? "font-semibold text-red" : ""}>
                  {age(ms)}
                </span>
              );
            },
          },
        ]
      : []),
    ...(tab !== "waiting"
      ? [
          { key: "reviewer", header: "Reviewer", cell: (r: QcBoardRow) => r.reviewer ?? "—" },
          { key: "reviewed", header: "Checked on", cell: (r: QcBoardRow) => (r.reviewedAt ? <span className="whitespace-nowrap">{when.format(new Date(r.reviewedAt))}</span> : "—") },
        ]
      : []),
    ...(tab === "passed" || tab === "all"
      ? [{ key: "sent", header: "Sent to client", cell: (r: QcBoardRow) => (r.state !== "passed" ? <span className="text-ink-muted">—</span> : r.sentToClient ? <Badge tone="green">Yes</Badge> : <Badge tone="amber">Not yet</Badge>) }]
      : []),
    ...(tab === "failed" || tab === "all"
      ? [
          { key: "failedItems", header: "Failed checks", cell: (r: QcBoardRow) => (r.state === "failed" && r.failedItems.length ? <span className="line-clamp-2 text-xs">{r.failedItems.join(", ")}</span> : <span className="text-ink-muted">—</span>) },
          { key: "fix", header: "Fix", cell: (r: QcBoardRow) => (r.state === "failed" ? <FixStatus r={r} /> : <span className="text-ink-muted">—</span>) },
        ]
      : []),
  ];

  return (
    <div className="grid min-w-0 grid-cols-1 gap-6 [&>*]:min-w-0">
      <StatRow cols={4}>
        <StatTile label="Waiting for QC" value={count("waiting")} tone={count("waiting") ? "warn" : "good"} hint="Oldest is checked first" />
        <StatTile label="Late (over 24 h)" value={late} tone={late ? "bad" : "default"} hint="Uploaded more than a day ago" />
        <StatTile label={`Passed (last ${days} days)`} value={count("passed")} hint={`${count("failed")} failed`} />
        <StatTile label="First-time pass rate" value={firstPassPct === null ? "—" : `${firstPassPct}%`} hint={`Version 1 checks, last ${days} days`} tone={firstPassPct !== null && firstPassPct < 70 ? "warn" : "default"} />
      </StatRow>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: "waiting", label: `Waiting (${count("waiting")})` },
            { value: "passed", label: `Passed (${count("passed")})` },
            { value: "failed", label: `Failed (${count("failed")})` },
            { value: "all", label: "All" },
          ]}
        />
        <p className="text-xs text-ink-muted">Passed and failed show the last {days} days.</p>
      </div>

      <Panel
        flush
        title="Filters"
        action={
          active > 0 && (
            <Button variant="ghost" onClick={() => setF(NO_FILTERS)}>
              Clear filters ({active})
            </Button>
          )
        }
      >
        <div className="flex flex-wrap gap-3 px-5 py-4" data-testid="qc-filters">
          <Filter label="Client" value={f.client} onChange={(client) => set({ client })} all="All clients" items={choices.client} />
          <Filter label="Type of work" value={f.type} onChange={(type) => set({ type })} all="All types" items={choices.type} capitalise />
          <Filter label="Made by" value={f.madeBy} onChange={(madeBy) => set({ madeBy })} all="Everyone" items={choices.madeBy} />
          {(tab === "waiting" || tab === "all") && (
            <label className="grid gap-1 text-xs text-ink-muted">
              Waiting time
              <Select value={f.wait} onChange={(e) => set({ wait: e.target.value as Wait })} aria-label="Waiting time">
                <option value="any">Any</option>
                <option value="4h">Over 4 hours</option>
                <option value="24h">Over 24 hours (late)</option>
              </Select>
            </label>
          )}
          {tab !== "waiting" && <Filter label="Reviewer" value={f.reviewer} onChange={(reviewer) => set({ reviewer })} all="All reviewers" items={choices.reviewer} />}
          {choices.department.length > 0 && <Filter label="Department" value={f.department} onChange={(department) => set({ department })} all="All departments" items={choices.department} />}
        </div>
      </Panel>

      <Panel flush>
        <DataTable rows={shown} columns={columns} rowKey={(r) => r.key} empty={active ? "Nothing matches these filters." : tab === "waiting" ? "The queue is empty." : `Nothing ${tab === "all" ? "here" : tab} in the last ${days} days.`} />
      </Panel>
    </div>
  );
}

function Filter({ label, value, onChange, all, items, capitalise }: { label: string; value: string; onChange: (v: string) => void; all: string; items: [string, string][]; capitalise?: boolean }) {
  return (
    <label className="grid gap-1 text-xs text-ink-muted">
      {label}
      <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} className={`min-w-40 text-ink ${capitalise ? "capitalize" : ""}`}>
        <option value="">{all}</option>
        {items.map(([id, name]) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </Select>
    </label>
  );
}

/** For a failed check: is a fix on its way? */
function FixStatus({ r }: { r: QcBoardRow }) {
  if (r.latestVersion <= r.versionNumber) return <Badge tone="amber">Waiting for v{r.versionNumber + 1}</Badge>;
  const s = r.deliverableStatus as DeliverableStatus;
  const tone = s === "in_qc" ? "amber" : s === "qc_failed" ? "red" : "green";
  return (
    <Badge tone={tone}>
      v{r.latestVersion}: {deliverableStatusLabels[s] ?? s}
    </Badge>
  );
}
