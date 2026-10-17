"use client";

// v30: attendance corrections. The employee asks (missed check-in / check-out, wrong time) with a reason;
// their manager or HR (Founder, Branch Manager) approves or declines. Approved times go into the records as "corrected".
import { useState } from "react";
import { ATTENDANCE_CORRECTION_DAYS, type AttendanceCorrectionRow } from "@bmu/shared";
import { DataTable, Panel, Tabs } from "@/components/dash";
import { Badge, Button, Input, LoadState } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const tz = "Asia/Kolkata";
const time = (iso: string | null) => (iso ? new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz }).format(new Date(iso)) : "—");
const dayText = (ymd: string) => new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${ymd}T00:00:00Z`));
const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() + 330 * 60_000 - n * 86_400_000).toISOString().slice(0, 10);
const TONE = { pending: "amber", approved: "green", rejected: "red", cancelled: "neutral" } as const;
const LABEL = { pending: "Waiting", approved: "Approved", rejected: "Declined", cancelled: "Cancelled" } as const;

/** For managers, HR, Branch Manager and the Founder: requests to decide. */
export function CorrectionsToDecide({ compact = false, onChanged }: { compact?: boolean; onChanged?: () => void }) {
  const list = useLoad(() => api.adminOrg.corrections());
  const [show, setShow] = useState<"pending" | "all">("pending");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  if (!list.data) return <LoadState loading={list.loading} error={list.error} />;
  const rows = show === "pending" ? list.data.filter((r) => r.status === "pending") : list.data;
  if (compact && !list.data.some((r) => r.canDecide)) return null;

  async function decide(r: AttendanceCorrectionRow, decision: "approve" | "reject") {
    const note = decision === "reject" ? window.prompt(`Reason for declining ${r.user.name}'s correction (they will see this)`) : undefined;
    if (decision === "reject" && note === null) return;
    setBusy(r.id);
    setError(undefined);
    try {
      await api.adminOrg.decideCorrection(r.id, { decision, note: note || undefined });
      list.reload();
      onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <Panel
      title="Attendance corrections"
      subtitle="Missed check-ins or check-outs your team asked to fix. Approving writes the times into the attendance records, marked as corrected."
      action={compact ? undefined : <Tabs value={show} onChange={setShow} options={[{ value: "pending", label: "Waiting" }, { value: "all", label: "All" }]} />}
      flush
    >
      {error && <p className="border-b border-border px-5 py-2 text-sm text-red">{error}</p>}
      <div data-testid="corrections-to-decide">
        <DataTable
          rows={compact ? list.data.filter((r) => r.canDecide) : rows}
          rowKey={(r) => r.id}
          empty={show === "pending" ? "No corrections waiting." : "No correction requests yet."}
          columns={[
            { key: "who", header: "Person", cell: (r) => <span className="font-medium">{r.user.name}</span> },
            { key: "day", header: "Day", cell: (r) => dayText(r.date) },
            {
              key: "times",
              header: "Recorded → asked",
              cell: (r) => (
                <span className="tabular-nums">
                  <span className="text-ink-muted">
                    {time(r.recorded.checkIn)}–{time(r.recorded.checkOut)}
                  </span>{" "}
                  → {time(r.requested.checkIn)}–{time(r.requested.checkOut)}
                </span>
              ),
            },
            { key: "reason", header: "Reason", cell: (r) => <span className="text-ink-muted">{r.reason}</span>, className: "max-w-xs" },
            {
              key: "status",
              header: "Status",
              cell: (r) => (
                <div>
                  <Badge tone={TONE[r.status]}>{LABEL[r.status]}</Badge>
                  {r.decidedBy && <div className="mt-1 text-xs text-ink-muted">by {r.decidedBy.name}</div>}
                  {r.decisionNote && <div className="mt-1 text-xs text-ink-muted">“{r.decisionNote}”</div>}
                </div>
              ),
            },
            {
              key: "act",
              header: "",
              align: "right",
              cell: (r) =>
                r.canDecide ? (
                  <div className="flex justify-end gap-1">
                    <Button disabled={busy === r.id} onClick={() => decide(r, "approve")}>
                      Approve
                    </Button>
                    <Button variant="ghost" disabled={busy === r.id} onClick={() => decide(r, "reject")}>
                      Decline
                    </Button>
                  </div>
                ) : null,
            },
          ]}
        />
      </div>
    </Panel>
  );
}

/** For the employee: ask to correct a day, and see their requests. */
export function MyCorrections() {
  const list = useLoad(() => api.adminOrg.myCorrections());
  const [fresh, setFresh] = useState<AttendanceCorrectionRow[]>();
  const [v, setV] = useState({ date: todayIst(), checkIn: "09:30", checkOut: "18:30", reason: "" });
  const [msg, setMsg] = useState<{ text: string; error: boolean }>();
  const [busy, setBusy] = useState(false);
  const rows = fresh ?? list.data;

  async function run(fn: () => Promise<AttendanceCorrectionRow[]>, ok: string) {
    setBusy(true);
    setMsg(undefined);
    try {
      setFresh(await fn());
      setMsg({ text: ok, error: false });
      return true;
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Attendance corrections" subtitle={`Missed a check-in or check-out, or the time is wrong? Ask here (up to ${ATTENDANCE_CORRECTION_DAYS} days back). Your manager or HR decides.`}>
      <div id="corrections" className="grid gap-3 sm:grid-cols-[10rem_7rem_7rem_1fr_auto] sm:items-end" data-testid="my-corrections">
        <label className="text-xs text-ink-muted">
          Day
          <Input type="date" value={v.date} min={daysAgo(ATTENDANCE_CORRECTION_DAYS)} max={todayIst()} onChange={(e) => setV({ ...v, date: e.target.value })} className="mt-1" aria-label="Day to correct" />
        </label>
        <label className="text-xs text-ink-muted">
          Check-in
          <Input type="time" value={v.checkIn} onChange={(e) => setV({ ...v, checkIn: e.target.value })} className="mt-1" aria-label="Correct check-in time" />
        </label>
        <label className="text-xs text-ink-muted">
          Check-out
          <Input type="time" value={v.checkOut} onChange={(e) => setV({ ...v, checkOut: e.target.value })} className="mt-1" aria-label="Correct check-out time" />
        </label>
        <label className="text-xs text-ink-muted">
          Reason
          <Input value={v.reason} maxLength={500} placeholder="e.g. Forgot to check out, left at 18:40" onChange={(e) => setV({ ...v, reason: e.target.value })} className="mt-1" aria-label="Reason for the correction" />
        </label>
        <Button
          disabled={busy || v.reason.trim().length < 5 || !v.date || v.checkOut <= v.checkIn}
          onClick={async () => {
            if (await run(() => api.adminOrg.requestCorrection(v), "Sent. You will be notified of the decision.")) setV({ ...v, reason: "" });
          }}
        >
          Ask
        </Button>
      </div>
      {msg && <p className={`mt-2 text-sm ${msg.error ? "text-red" : "text-ink-muted"}`}>{msg.text}</p>}
      {!rows ? (
        <LoadState loading={list.loading} error={list.error} />
      ) : rows.length ? (
        <ul className="mt-4 divide-y divide-border border-t border-border text-sm">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                <span className="font-medium">{dayText(r.date)}</span>
                <span className="text-ink-muted">
                  {" "}
                  · {time(r.requested.checkIn)}–{time(r.requested.checkOut)} · {r.reason}
                  {r.decisionNote ? ` · “${r.decisionNote}”` : ""}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <Badge tone={TONE[r.status]}>{LABEL[r.status]}</Badge>
                {r.status === "pending" && (
                  <button type="button" className="text-xs text-ink-muted hover:text-ink" disabled={busy} onClick={() => run(() => api.adminOrg.cancelCorrection(r.id), "Request cancelled.")}>
                    Cancel
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Panel>
  );
}
