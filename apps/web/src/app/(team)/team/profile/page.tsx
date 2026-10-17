"use client";

import { useState } from "react";
import { LEAVE_TYPES, craftSpecialtyLabel, leaveTypeLabels, roleLabel, type LeaveType, type MyProfile } from "@bmu/shared";
import { NotificationPrefsPanel } from "@/components/service/notification-prefs";
import { SecurityPanels } from "@/components/security/security-panel";
import { MyCorrections } from "@/components/attendance/corrections";
import { DataTable, Empty, Grid, KeyValues, Meter, Panel, StatRow, StatTile } from "@/components/dash";
import { fmtIsoDay, fmtTime, istToday, monthLabel } from "@/components/workspace/format";
import { Badge, Button, Input, LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const statusTone = { pending: "amber", approved: "green", rejected: "red", cancelled: "neutral" } as const;

export default function ProfilePage() {
  const loaded = useLoad(() => api.workspace.profile());
  const [fresh, setFresh] = useState<MyProfile>();
  const p = fresh ?? loaded.data;
  if (!p)
    return (
      <div className="[&_.grid>*]:min-w-0">
        <PageTitle title="Profile, leave & attendance" subtitle="Your details, time off and working hours." />
        <LoadState loading={loaded.loading} error={loaded.error} />
      </div>
    );
  const casual = p.leave.balance.find((b) => b.type === "casual")!;
  const sick = p.leave.balance.find((b) => b.type === "sick")!;
  // v31: Founders don't request leave.
  const canApply = p.leave.canApply !== false;

  return (
    <div className="[&_.grid>*]:min-w-0">
      <PageTitle
        title={canApply ? "Profile, leave & attendance" : "Profile & attendance"}
        subtitle={canApply ? "Your details, time off and working hours. Leave and work-from-home requests are approved by your Department Head and HR; you are told the final decision." : "Your details and working hours."}
      />
      <StatRow cols={4}>
        {canApply ? (
          <>
            <StatTile label="Paid casual leave left" value={casual.left} hint={`${casual.allowed} built up in ${p.leave.year} (1 a month)${casual.pending ? ` · ${casual.pending} pending` : ""}`} tone={casual.left === 0 ? "warn" : "default"} />
            <StatTile label="Paid sick leave left" value={sick.left} hint={`${sick.allowed} built up in ${p.leave.year} (1 a month)${sick.pending ? ` · ${sick.pending} pending` : ""}`} tone={sick.left === 0 ? "warn" : "default"} />
          </>
        ) : null}
        <StatTile label="Hours this month" value={p.attendance.totalHours} hint={monthLabel(p.attendance.month)} />
        <StatTile label="Days present" value={`${p.attendance.daysPresent}/${p.attendance.workingDaysSoFar}`} hint="Working days so far" tone={p.attendance.daysPresent >= p.attendance.workingDaysSoFar ? "good" : "default"} />
      </StatRow>

      <div className="mt-6 grid gap-6">
        <Grid>
          <DetailsPanel p={p} onSaved={() => api.workspace.profile().then(setFresh)} />
          {canApply && <LeaveForm p={p} onDone={setFresh} />}
        </Grid>

        <Panel title="Attendance" subtitle={`${monthLabel(p.attendance.month)} · from your My Day check-ins`}>
          <AttendanceDots p={p} />
        </Panel>

        {/* v32: Founders don't ask for attendance corrections. */}
        {canApply && <MyCorrections />}

        {canApply && (
          <Panel title="My leave and work-from-home requests" flush>
            <LeaveTable p={p} onDone={setFresh} />
          </Panel>
        )}

        <NotificationPrefsPanel />

        <div>
          <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">Sign-in security</h2>
          <SecurityPanels />
        </div>

        <Grid>
          <Panel title="End-of-day reports" subtitle="Your last 14">
            {p.eod.length ? (
              <ul className="divide-y divide-border">
                {p.eod.map((e) => (
                  <li key={e.date} className="py-3 first:pt-0 last:pb-0">
                    <p className="text-sm font-medium">{fmtIsoDay(e.date, true)}</p>
                    <div className="mt-1 grid gap-x-4 text-xs text-ink-muted sm:grid-cols-2">
                      {e.completed.length > 0 && <p>Done: {e.completed.join(", ")}</p>}
                      {e.pending.length > 0 && <p>Pending: {e.pending.join(", ")}</p>}
                      {e.blocked.length > 0 && <p className="text-red">Blocked: {e.blocked.join(", ")}</p>}
                      {e.waiting.length > 0 && <p>Waiting: {e.waiting.join(", ")}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No reports yet. Submit one from My Day at the end of each working day.</Empty>
            )}
          </Panel>
          <Panel title={`Holidays ${p.leave.year}`} subtitle="Office closed; no leave needed">
            {p.holidays.length ? <KeyValues items={p.holidays.map((h) => ({ k: h.name, v: fmtIsoDay(h.date, true) }))} /> : <Empty>No holidays listed.</Empty>}
          </Panel>
        </Grid>
      </div>
    </div>
  );
}

function DetailsPanel({ p, onSaved }: { p: MyProfile; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const canRename = p.user.canRename !== false;
  const [name, setName] = useState(p.user.name);
  const [phone, setPhone] = useState(p.user.phone ?? "");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.workspace.updateMe({ name, phone });
      setEditing(false);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel title="My details" action={!editing && <Button variant="ghost" className="px-0 py-0 text-xs" onClick={() => setEditing(true)}>{canRename ? "Edit name & phone" : "Edit mobile number"}</Button>}>
      {editing ? (
        <form onSubmit={save} className="grid gap-3">
          <label className="text-sm">
            <span className="text-ink-muted">Name</span>
            <Input className="mt-1" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} readOnly={!canRename} title={canRename ? undefined : "Ask HR or a Branch Manager to change your name"} />
          </label>
          <label className="text-sm">
            <span className="text-ink-muted">Mobile number</span>
            <Input className="mt-1" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="10-digit mobile" inputMode="tel" />
          </label>
          {error && <p className="text-sm text-red">{error}</p>}
          <div className="flex gap-2">
            <Button disabled={busy}>Save</Button>
            <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <KeyValues
          items={[
            { k: "Name", v: p.user.name },
            { k: "Email", v: p.user.email ?? "—" },
            { k: "Mobile", v: p.user.phone ?? "—" },
            { k: "Department", v: p.user.department ?? "—" },
            ...(p.user.team ? [{ k: "Team", v: p.user.team }] : []),
            { k: "Manager", v: p.user.manager?.name ?? "—" },
            { k: "Role", v: p.user.roles.map(roleLabel).join(" + ") || "—" },
            ...(p.user.specialty ? [{ k: "Specialty", v: craftSpecialtyLabel(p.user.specialty) }] : []),
          ]}
        />
      )}
    </Panel>
  );
}

function LeaveForm({ p, onDone }: { p: MyProfile; onDone: (p: MyProfile) => void }) {
  const today = istToday();
  const [v, setV] = useState({ from: today, to: today, type: "casual" as LeaveType, reason: "" });
  const [error, setError] = useState<string>();
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    setOk(false);
    try {
      onDone(await api.workspace.applyLeave({ ...v, reason: v.reason || undefined }));
      setOk(true);
      setV({ from: today, to: today, type: "casual", reason: "" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel title="Apply for leave or work from home" subtitle="Your Department Head approves first, then HR. You will be told the final decision.">
      <div className="mb-5 grid gap-3">
        {p.leave.balance.map((b) => (
          <div key={b.type}>
            <div className="mb-1 flex justify-between text-xs">
              <span>{leaveTypeLabels[b.type]}</span>
              <span className="text-ink-muted tabular-nums">
                {b.used} used · {b.left} paid left
              </span>
            </div>
            <Meter value={b.allowed ? (b.used / b.allowed) * 100 : 0} tone={b.left === 0 ? "warn" : "default"} />
          </div>
        ))}
        <p className="text-xs text-ink-muted">
          You get 1 paid casual and 1 paid sick day each month; unused days carry over within the year. Days beyond that are unpaid.
          {p.leave.unpaidUsed > 0 ? ` ${p.leave.unpaidUsed} unpaid day(s) taken this year.` : ""}
          {p.leave.wfhDays ? ` ${p.leave.wfhDays} work-from-home day(s) this year.` : ""}
        </p>
      </div>
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="text-ink-muted">From</span>
          <Input type="date" className="mt-1" value={v.from} onChange={(e) => setV({ ...v, from: e.target.value, to: v.to < e.target.value ? e.target.value : v.to })} required />
        </label>
        <label className="text-sm">
          <span className="text-ink-muted">To</span>
          <Input type="date" className="mt-1" value={v.to} min={v.from} onChange={(e) => setV({ ...v, to: e.target.value })} required />
        </label>
        <label className="text-sm">
          <span className="text-ink-muted">Type</span>
          <Select className="mt-1 block w-full py-2" value={v.type} onChange={(e) => setV({ ...v, type: e.target.value as LeaveType })}>
            {LEAVE_TYPES.map((t) => (
              <option key={t} value={t}>
                {leaveTypeLabels[t]}
              </option>
            ))}
          </Select>
        </label>
        <label className="text-sm">
          <span className="text-ink-muted">Reason (optional)</span>
          <Input className="mt-1" value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} maxLength={500} placeholder="e.g. Family function" />
        </label>
        <div className="sm:col-span-2">
          {error && <p className="mb-2 text-sm text-red">{error}</p>}
          {ok && <p className="mb-2 text-sm text-[#5f8a12]">Request sent. You will be notified when it is decided.</p>}
          <Button disabled={busy}>Send request</Button>
          <p className="mt-2 text-xs text-ink-muted">
            Only working days count; weekly offs and holidays are skipped.{" "}
            {v.type === "wfh" ? "On work-from-home days, check in and out from My Day as usual." : "Check-in is closed on approved leave days."}
          </p>
        </div>
      </form>
    </Panel>
  );
}

function LeaveTable({ p, onDone }: { p: MyProfile; onDone: (p: MyProfile) => void }) {
  const [error, setError] = useState<string>();
  async function cancel(id: string) {
    setError(undefined);
    try {
      onDone(await api.workspace.cancelLeave(id));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="[&_.grid>*]:min-w-0">
      {error && <p className="px-5 pt-3 text-sm text-red">{error}</p>}
      <DataTable
        rows={p.leave.requests}
        rowKey={(r) => r.id}
        empty="No leave requests yet."
        columns={[
          { key: "d", header: "Dates", cell: (r) => <span className="font-medium whitespace-nowrap">{r.from === r.to ? fmtIsoDay(r.from, true) : `${fmtIsoDay(r.from)} – ${fmtIsoDay(r.to, true)}`}</span> },
          { key: "t", header: "Type", cell: (r) => leaveTypeLabels[r.type] },
          {
            key: "n",
            header: "Working days",
            align: "right",
            cell: (r) => (
              <div>
                <div>{r.days}</div>
                {(r.type === "casual" || r.type === "sick") && !!r.unpaidDays && (
                  <div className="text-xs text-ink-muted">
                    {r.paidDays} paid · {r.unpaidDays} unpaid
                  </div>
                )}
              </div>
            ),
          },
          { key: "r", header: "Reason", cell: (r) => <span className="text-ink-muted">{r.reason ?? "—"}</span> },
          {
            key: "s",
            header: "Status",
            cell: (r) => (
              <div>
                {/* v31: only the final result; who decided and the steps in between stay confidential. */}
                <Badge tone={statusTone[r.status]}>{{ pending: "Waiting for approval", approved: "Approved", rejected: "Not approved", cancelled: "Cancelled" }[r.status]}</Badge>
              </div>
            ),
          },
          {
            key: "a",
            header: "",
            align: "right",
            cell: (r) =>
              r.status === "pending" ? (
                <Button variant="ghost" className="px-0 py-0 text-xs" onClick={() => cancel(r.id)}>
                  Cancel
                </Button>
              ) : null,
          },
        ]}
      />
    </div>
  );
}

function AttendanceDots({ p }: { p: MyProfile }) {
  const month = p.attendance.month;
  const days = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const lead = (new Date(`${month}-01T00:00:00Z`).getUTCDay() + 6) % 7;
  const today = istToday();
  const holidays = new Set(p.holidays.map((h) => h.date));
  const leave = new Set(
    p.leave.requests
      .filter((r) => r.status === "approved")
      .flatMap((r) => {
        const out: string[] = [];
        for (let t = new Date(`${r.from}T00:00:00Z`).getTime(); t <= new Date(`${r.to}T00:00:00Z`).getTime(); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
        return out;
      }),
  );
  const cells: (string | null)[] = [...Array.from({ length: lead }, () => null), ...Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`)];
  return (
    <div className="grid gap-6 md:grid-cols-[auto_1fr]">
      <div>
        <div className="grid grid-cols-7 gap-1.5 text-center text-[10px] uppercase tracking-wider text-ink-muted">
          {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
            <span key={i}>{d}</span>
          ))}
          {cells.map((d, i) => {
            if (!d) return <span key={`b${i}`} />;
            const a = p.attendance.days.find((x) => x.date === d);
            const sunday = (lead + Number(d.slice(8)) - 1) % 7 === 6;
            const off = sunday || holidays.has(d);
            const cls = a?.checkIn ? "bg-green text-charcoal" : leave.has(d) ? "bg-grey/70" : off ? "bg-canvas text-ink-muted/50" : d < today ? "border border-red/50 text-ink-muted" : "border border-border text-ink-muted";
            return (
              <span key={d} title={a ? `${fmtIsoDay(d)}: ${a.hours}h` : fmtIsoDay(d)} className={`flex h-8 w-8 items-center justify-center text-[11px] tabular-nums ${cls} ${d === today ? "ring-1 ring-charcoal ring-offset-1" : ""}`}>
                {Number(d.slice(8))}
              </span>
            );
          })}
        </div>
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
          <li className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 bg-green" /> Present</li>
          <li className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 bg-grey/70" /> Leave</li>
          <li className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 border border-red/50" /> No check-in</li>
          <li className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 bg-canvas" /> Off</li>
        </ul>
      </div>
      <div>
        {p.attendance.days.length ? (
          <DataTable
            rows={[...p.attendance.days].reverse().slice(0, 10)}
            rowKey={(d) => d.date}
            columns={[
              { key: "d", header: "Day", cell: (d) => fmtIsoDay(d.date) },
              { key: "i", header: "In", cell: (d) => (d.checkIn ? fmtTime.format(new Date(d.checkIn)) : "—") },
              { key: "o", header: "Out", cell: (d) => (d.checkOut ? fmtTime.format(new Date(d.checkOut)) : "—") },
              { key: "h", header: "Hours", align: "right", cell: (d) => (d.hours ? `${d.hours}h` : "—") },
            ]}
          />
        ) : (
          <Empty>No check-ins this month yet. Check in from My Day.</Empty>
        )}
      </div>
    </div>
  );
}
