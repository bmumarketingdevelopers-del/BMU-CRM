"use client";

import Link from "next/link";
import { useState } from "react";
import { OFFBOARDING_CHECKS, formatINR, type EngagementLifecycle, type OffboardingCheckKey, type OffboardingRow } from "@bmu/shared";
import { DataTable, Empty, Panel, StatRow, StatTile, Tabs } from "@/components/dash";
import { Badge, Button, Input, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { ErrorNote, StatusBadge, fmtDate, gateLabel } from "../_admin-org/kit";

type Action = EngagementLifecycle["action"];
type Show = "wrapping" | "active" | "closed";
const ACTION_LABEL: Record<Action, string> = { pause: "Pause", offboard: "Start offboarding", close: "Close", reactivate: "Reactivate" };
const PAST: Record<string, string> = { pause: "Paused", offboard: "Offboarding started", close: "Closed", reactivate: "Reactivated" };

export default function OffboardingPage() {
  const load = useLoad(() => api.adminOrg.offboarding());
  const [rows, setRows] = useState<OffboardingRow[]>();
  const [show, setShow] = useState<Show>("wrapping");
  const [error, setError] = useState<string>();
  const [asking, setAsking] = useState<{ id: string; action: Action } | null>(null);
  const data = rows ?? load.data;

  const replace = (row: OffboardingRow) => setRows((data ?? []).map((r) => (r.id === row.id ? row : r)));

  async function act(id: string, action: Action, reason?: string) {
    setError(undefined);
    try {
      replace(await api.adminOrg.lifecycle(id, { action, reason: reason || undefined }));
      setAsking(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function tick(id: string, key: OffboardingCheckKey, done: boolean) {
    setError(undefined);
    try {
      replace(await api.adminOrg.tickOffboarding(id, key, done));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const wrapping = data?.filter((r) => r.status === "paused" || r.status === "offboarding") ?? [];
  const closed = data?.filter((r) => r.status === "closed") ?? [];
  const active = data?.filter((r) => !["paused", "offboarding", "closed"].includes(r.status)) ?? [];

  const actions = (r: OffboardingRow) => (
    <div className="flex flex-wrap justify-end gap-1">
      {(["pause", "offboard", "close", "reactivate"] as Action[])
        .filter((a) => (a === "close" ? r.status !== "closed" : r.can[a]))
        .map((a) => (
          <Button
            key={a}
            variant={a === "reactivate" || (a === "close" && r.status === "offboarding") ? "primary" : "secondary"}
            disabled={a === "close" && !r.can.close}
            title={a === "close" && r.closeBlockedReason ? r.closeBlockedReason : undefined}
            onClick={() => setAsking({ id: r.id, action: a })}
          >
            {ACTION_LABEL[a]}
          </Button>
        ))}
    </div>
  );

  const reasonForm = (r: OffboardingRow) =>
    asking?.id === r.id ? (
      <form
        className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          act(r.id, asking.action, String(new FormData(e.currentTarget).get("reason") ?? ""));
        }}
      >
        <Input
          name="reason"
          autoFocus
          required={asking.action === "close"}
          minLength={asking.action === "close" ? 3 : undefined}
          placeholder={asking.action === "close" ? "Why is it closing? (required)" : "Reason (optional, shared with the AM)"}
          className="min-w-56 flex-1"
        />
        <Button type="submit">{ACTION_LABEL[asking.action]}</Button>
        <Button type="button" variant="ghost" onClick={() => setAsking(null)}>
          Cancel
        </Button>
      </form>
    ) : null;

  return (
    <>
      <PageTitle title="Offboarding" subtitle="Pause, wrap up or close an engagement, and make sure access, files, invoices and feedback are all handled first." />
      <ErrorNote>{error}</ErrorNote>
      <LoadState loading={!data && load.loading} error={load.error} />
      {data && (
        <div className="space-y-6">
          <StatRow>
            <StatTile label="Offboarding" value={data.filter((r) => r.status === "offboarding").length} />
            <StatTile label="Paused" value={data.filter((r) => r.status === "paused").length} />
            <StatTile label="Unpaid before closing" value={wrapping.filter((r) => r.unpaidInvoices.length).length} tone={wrapping.some((r) => r.unpaidInvoices.length) ? "warn" : "default"} hint="engagements" />
            <StatTile label="Closed" value={closed.length} />
          </StatRow>

          <Tabs
            value={show}
            onChange={setShow}
            options={[
              { value: "wrapping", label: `Paused & offboarding (${wrapping.length})` },
              { value: "active", label: `Active (${active.length})` },
              { value: "closed", label: `Closed (${closed.length})` },
            ]}
          />

          {show === "wrapping" &&
            (wrapping.length === 0 ? (
              <Panel>
                <Empty>Nothing is paused or being offboarded.</Empty>
              </Panel>
            ) : (
              <div className="grid grid-cols-1 gap-6 [&>*]:min-w-0 xl:grid-cols-2">
                {wrapping.map((r) => (
                  <Panel
                    key={r.id}
                    title={r.client.name}
                    subtitle={`${r.serviceName} · ${r.am?.name ?? "No AM"} · ${gateLabel(r.currentGate)}`}
                    action={<StatusBadge status={r.status} />}
                  >
                    {r.lastChange && (
                      <p className="mb-4 text-sm text-ink-muted">
                        {PAST[r.lastChange.action] ?? r.lastChange.action} {fmtDate(r.lastChange.at)}
                        {r.lastChange.by && ` by ${r.lastChange.by}`}
                        {r.lastChange.reason && <span className="text-ink">: “{r.lastChange.reason}”</span>}
                      </p>
                    )}
                    <div className="grid gap-px border border-border bg-border sm:grid-cols-2">
                      <Check label="Final files released" state={r.filesReleased === null ? "na" : r.filesReleased ? "ok" : "no"} note={r.filesReleased === null ? "No approved final files" : undefined} />
                      <Check
                        label="Invoices paid"
                        state={r.unpaidInvoices.length ? "no" : "ok"}
                        note={r.unpaidInvoices.length ? r.unpaidInvoices.map((i) => `${i.number} · ${formatINR(i.totalPaise)} (${i.status.replace(/_/g, " ")})`).join(", ") : undefined}
                      />
                    </div>
                    <p className="mt-5 mb-2 text-[11px] uppercase tracking-[0.1em] text-ink-muted">Checklist</p>
                    <ul className="divide-y divide-border border-y border-border text-sm">
                      {OFFBOARDING_CHECKS.map((c) => {
                        const v = r.checklist[c.key];
                        return (
                          <li key={c.key} className="flex items-start gap-3 py-2.5">
                            <input
                              id={`${r.id}-${c.key}`}
                              type="checkbox"
                              checked={v.done}
                              onChange={(e) => tick(r.id, c.key, e.target.checked)}
                              className="mt-0.5 h-4 w-4 accent-[#121F2F]"
                            />
                            <label htmlFor={`${r.id}-${c.key}`} className="flex-1">
                              {c.label}
                              {v.done && v.by && <span className="block text-xs text-ink-muted">Ticked by {v.by}, {fmtDate(v.at)}</span>}
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                    {r.closeBlockedReason && <p className="mt-4 border-l-2 border-amber pl-3 text-sm">Can’t close yet: {r.closeBlockedReason}</p>}
                    <div className="mt-4 flex items-center justify-between gap-3">
                      <Link href={`/team/projects/${r.id}`} className="text-sm underline">
                        Open project
                      </Link>
                      {actions(r)}
                    </div>
                    {reasonForm(r)}
                  </Panel>
                ))}
              </div>
            ))}

          {show !== "wrapping" && (
            <Panel flush>
              <DataTable
                rows={show === "active" ? active : closed}
                rowKey={(r) => r.id}
                rowHref={(r) => `/team/projects/${r.id}`}
                empty={show === "active" ? "No active engagements." : "Nothing closed yet."}
                columns={[
                  {
                    key: "client",
                    header: "Client",
                    cell: (r) => (
                      <span>
                        {r.client.name}
                        <span className="block text-xs font-normal text-ink-muted">{r.serviceName}</span>
                      </span>
                    ),
                  },
                  { key: "status", header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
                  { key: "am", header: "AM", cell: (r) => r.am?.name ?? "—" },
                  {
                    key: "money",
                    header: "Invoices",
                    cell: (r) => (r.unpaidInvoices.length ? <Badge tone="amber">{r.unpaidInvoices.length} unpaid</Badge> : <span className="text-xs text-ink-muted">All paid</span>),
                  },
                  {
                    key: "act",
                    header: "",
                    align: "right",
                    cell: (r) => (
                      <div>
                        {actions(r)}
                        {reasonForm(r)}
                      </div>
                    ),
                  },
                ]}
              />
            </Panel>
          )}
        </div>
      )}
    </>
  );
}

function Check({ label, state, note }: { label: string; state: "ok" | "no" | "na"; note?: string }) {
  return (
    <div className="bg-surface-raised p-4">
      <p className="flex items-center gap-2 text-sm">
        <span className={`inline-block h-2 w-2 ${state === "ok" ? "bg-green" : state === "no" ? "bg-amber" : "bg-grey"}`} aria-hidden />
        {label}
        <span className="ml-auto text-xs text-ink-muted">{state === "ok" ? "Yes" : state === "no" ? "Not yet" : "—"}</span>
      </p>
      {note && <p className="mt-1 text-xs text-ink-muted">{note}</p>}
    </div>
  );
}
