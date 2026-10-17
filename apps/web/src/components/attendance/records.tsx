"use client";

// v30: the attendance records sheet: by department, each employee with their designation, day by day.
// The Founder and HR see everyone and can download it (Excel and CSV); Department Heads see their own team.
import { useState } from "react";
import { attendanceStatusLabels, buildXlsx, type AttendanceRecordDay, type AttendanceRecordPerson, type AttendanceRecords, type AttendanceRecordTotals, type XlsxCell } from "@bmu/shared";
import { Panel, StatRow, StatTile } from "@/components/dash";
import { Badge, Button, Input, LoadState, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const tz = "Asia/Kolkata";
const time = (iso: string | null) => (iso ? new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz }).format(new Date(iso)) : "");
const dateText = (ymd: string) => new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${ymd}T00:00:00Z`));
const weekdayText = (ymd: string) => new Intl.DateTimeFormat("en-IN", { weekday: "short", timeZone: "UTC" }).format(new Date(`${ymd}T00:00:00Z`));
const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const hoursText = (h: number) => (h ? `${Math.floor(h)}h ${String(Math.round((h % 1) * 60)).padStart(2, "0")}m` : "");

function statusText(d: AttendanceRecordDay) {
  if (d.status === "holiday") return d.label ? `Holiday: ${d.label}` : "Holiday";
  if (d.status === "leave") return d.leaveType ? `On leave (${d.leaveType})` : "On leave";
  const base = attendanceStatusLabels[d.status];
  const where = d.wfh && base ? `${base} (work from home)` : base;
  return d.corrected && where ? `${where} (corrected)` : where;
}
const tone = (d: AttendanceRecordDay) =>
  d.status === "absent" ? "red" : d.status === "late" || d.status === "missed_out" || d.status === "late_missed_out" ? "amber" : d.status === "present" || d.status === "worked_off_day" ? "green" : "neutral";

/** One row per person per day (the download layout). */
const DAY_HEADER = ["Department", "Branch", "Employee", "Email", "Designation", "Date", "Day", "Check-in", "Check-out", "Hours worked", "Status", "Late by (min)", "Corrected"];
function dayRows(r: AttendanceRecords): XlsxCell[][] {
  const out: XlsxCell[][] = [];
  for (const dept of r.departments)
    for (const p of dept.people)
      for (const d of p.days) {
        if (d.status === "future") continue;
        out.push([dept.name, dept.branch ?? "", p.user.name, p.user.email, p.designation, d.date, weekdayText(d.date), time(d.checkIn), time(d.checkOut), d.hours || "", statusText(d), d.lateMinutes || "", d.corrected ? "Yes" : ""]);
      }
  return out;
}
const SUMMARY_HEADER = ["Department", "Employee", "Designation", "Working days", "Present", "Late", "Missed check-out", "On leave", "Absent", "Hours worked"];
const summaryRow = (dept: string, p: AttendanceRecordPerson): XlsxCell[] => [dept, p.user.name, p.designation, ...totalsCells(p.totals)];
const totalsCells = (t: AttendanceRecordTotals): XlsxCell[] => [t.workingDays, t.present, t.late, t.missedOut, t.leave, t.absent, t.hours];

function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadRecordsXlsx(r: AttendanceRecords) {
  const head = (title: string): XlsxCell[][] => [[title], [`${dateText(r.from)} to ${dateText(r.to)} · working hours ${r.workingHours.start}–${r.workingHours.end}, late after ${r.workingHours.start} + ${r.workingHours.graceMinutes} min`], []];
  const summary: XlsxCell[][] = [...head("Attendance summary by department"), SUMMARY_HEADER];
  const bold = [0, 3];
  for (const dept of r.departments) {
    for (const p of dept.people) summary.push(summaryRow(dept.name, p));
    summary.push([`${dept.name} total`, `${dept.people.length} people`, "", ...totalsCells(dept.totals)]);
    bold.push(summary.length - 1);
  }
  const sheets = [
    { name: "Summary", rows: summary, bold, widths: [22, 24, 34, 13, 9, 7, 16, 9, 8, 13], freezeRows: 4 },
    // One sheet per department, every employee's days.
    ...r.departments.map((dept) => ({
      name: dept.name,
      rows: [
        [`${dept.name}${dept.branch ? ` · ${dept.branch}` : ""}`],
        [`${dateText(r.from)} to ${dateText(r.to)}`],
        [],
        DAY_HEADER.slice(2),
        ...dayRows({ ...r, departments: [dept] }).map((row) => row.slice(2)),
      ],
      bold: [0, 3],
      widths: [24, 28, 34, 12, 6, 9, 10, 12, 24, 12, 10],
      freezeRows: 4,
    })),
  ];
  download(`attendance-${r.from}-to-${r.to}.xlsx`, buildXlsx(sheets) as BlobPart, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}

export function downloadRecordsCsv(r: AttendanceRecords) {
  const esc = (v: XlsxCell) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [DAY_HEADER, ...dayRows(r)].map((row) => row.map(esc).join(",")).join("\n");
  download(`attendance-${r.from}-to-${r.to}.csv`, "﻿" + csv, "text/csv;charset=utf-8");
}

export function AttendanceRecordsView() {
  const today = todayIst();
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [dept, setDept] = useState("");
  const first = useLoad(() => api.adminOrg.attendanceRecords({ from: `${todayIst().slice(0, 7)}-01`, to: todayIst() }), { live: false });
  const [fresh, setData] = useState<AttendanceRecords>();
  const [busy, setBusy] = useState(false);
  const [failed, setError] = useState<string>();
  const [open, setOpen] = useState<string>();
  const data = fresh ?? first.data;
  const error = failed ?? first.error;

  async function load(q = { from, to, departmentId: dept }) {
    setBusy(true);
    setError(undefined);
    try {
      setData(await api.adminOrg.attendanceRecords({ from: q.from, to: q.to, departmentId: q.departmentId || undefined }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const t = data?.departments.reduce(
    (s, d) => ({ people: s.people + d.people.length, present: s.present + d.totals.present, late: s.late + d.totals.late, absent: s.absent + d.totals.absent, missed: s.missed + d.totals.missedOut, leave: s.leave + d.totals.leave }),
    { people: 0, present: 0, late: 0, absent: 0, missed: 0, leave: 0 },
  );

  return (
    <div className="space-y-6" data-testid="attendance-records">
      <Panel
        title="Attendance records"
        subtitle={
          data
            ? `${dateText(data.from)} to ${dateText(data.to)} · by department, with each employee's designation. Late = after ${data.workingHours.start} + ${data.workingHours.graceMinutes} min.`
            : "By department, with each employee's designation."
        }
      >
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-ink-muted">
            From
            <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="mt-1 !w-40" aria-label="Records from" />
          </label>
          <label className="text-xs text-ink-muted">
            To
            <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="mt-1 !w-40" aria-label="Records to" />
          </label>
          <label className="text-xs text-ink-muted">
            Department
            <Select value={dept} onChange={(e) => setDept(e.target.value)} className="mt-1 !w-52" aria-label="Department">
              <option value="">{data && data.departmentOptions.length <= 1 ? "My department" : "All departments"}</option>
              {data?.departmentOptions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </label>
          <Button disabled={busy || !from || !to} onClick={() => load()}>
            {busy ? "Loading…" : "Show"}
          </Button>
          {data?.canDownload && (
            <span className="ml-auto flex gap-2">
              <Button variant="secondary" disabled={!data.departments.length} onClick={() => downloadRecordsXlsx(data)} data-testid="download-xlsx">
                Download Excel
              </Button>
              <Button variant="secondary" disabled={!data.departments.length} onClick={() => downloadRecordsCsv(data)} data-testid="download-csv">
                Download CSV
              </Button>
            </span>
          )}
        </div>
        {error && <p className="mt-3 text-sm text-red">{error}</p>}
      </Panel>

      {!data ? (
        <LoadState loading={busy || first.loading} />
      ) : (
        <>
          {t && (
            <StatRow cols={5}>
              <StatTile label="People" value={t.people} hint={`${data.departments.length} department${data.departments.length === 1 ? "" : "s"}`} />
              <StatTile label="Days present" value={t.present} />
              <StatTile label="Late check-ins" value={t.late} tone={t.late ? "warn" : "default"} />
              <StatTile label="Missed check-outs" value={t.missed} tone={t.missed ? "warn" : "default"} />
              <StatTile label="Days absent" value={t.absent} tone={t.absent ? "bad" : "default"} hint={`${t.leave} on leave`} />
            </StatRow>
          )}
          {data.departments.map((d) => (
            <Panel key={d.id ?? "none"} title={`${d.name}${d.branch ? ` · ${d.branch}` : ""}`} subtitle={`${d.people.length} people · ${d.totals.present} present · ${d.totals.late} late · ${d.totals.absent} absent · ${d.totals.leave} on leave`} flush>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.12em] text-ink-muted">
                      <th className="px-4 py-2">Employee</th>
                      <th className="px-4 py-2">Designation</th>
                      <th className="px-3 py-2 text-right">Working days</th>
                      <th className="px-3 py-2 text-right">Present</th>
                      <th className="px-3 py-2 text-right">Late</th>
                      <th className="px-3 py-2 text-right">Missed out</th>
                      <th className="px-3 py-2 text-right">Leave</th>
                      <th className="px-3 py-2 text-right">Absent</th>
                      <th className="px-3 py-2 text-right">Hours</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {d.people.map((p) => {
                      const key = `${d.id}|${p.user.id}`;
                      return (
                        <PersonRows key={key} p={p} open={open === key} onToggle={() => setOpen(open === key ? undefined : key)} />
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Panel>
          ))}
          {!data.departments.length && <p className="text-sm text-ink-muted">No team members in this selection.</p>}
        </>
      )}
    </div>
  );
}

function PersonRows({ p, open, onToggle }: { p: AttendanceRecordPerson; open: boolean; onToggle: () => void }) {
  const t = p.totals;
  return (
    <>
      <tr className="border-b border-border">
        <td className="px-4 py-2 font-medium">{p.user.name}</td>
        <td className="px-4 py-2 text-ink-muted">{p.designation}</td>
        <td className="px-3 py-2 text-right tabular-nums">{t.workingDays}</td>
        <td className="px-3 py-2 text-right tabular-nums">{t.present}</td>
        <td className={`px-3 py-2 text-right tabular-nums ${t.late ? "text-[#9a6b00]" : ""}`}>{t.late}</td>
        <td className={`px-3 py-2 text-right tabular-nums ${t.missedOut ? "text-[#9a6b00]" : ""}`}>{t.missedOut}</td>
        <td className="px-3 py-2 text-right tabular-nums">{t.leave}</td>
        <td className={`px-3 py-2 text-right tabular-nums ${t.absent ? "text-[#b4432c]" : ""}`}>{t.absent}</td>
        <td className="px-3 py-2 text-right tabular-nums">{hoursText(t.hours) || "—"}</td>
        <td className="px-3 py-2 text-right">
          <button type="button" className="text-xs text-ink-muted underline-offset-2 hover:underline" onClick={onToggle} aria-expanded={open}>
            {open ? "Hide days" : "Days"}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="border-b border-border bg-canvas/40">
          <td colSpan={10} className="px-4 py-3">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-ink-muted">
                  <th className="py-1 pr-3">Date</th>
                  <th className="py-1 pr-3">Check-in</th>
                  <th className="py-1 pr-3">Check-out</th>
                  <th className="py-1 pr-3">Hours</th>
                  <th className="py-1">Status</th>
                </tr>
              </thead>
              <tbody>
                {p.days
                  .filter((d) => d.status !== "future")
                  .map((d) => (
                    <tr key={d.date}>
                      <td className="py-1 pr-3 whitespace-nowrap">
                        {weekdayText(d.date)}, {dateText(d.date)}
                      </td>
                      <td className="py-1 pr-3 tabular-nums">{time(d.checkIn) || "—"}</td>
                      <td className="py-1 pr-3 tabular-nums">{time(d.checkOut) || "—"}</td>
                      <td className="py-1 pr-3 tabular-nums">{hoursText(d.hours) || "—"}</td>
                      <td className="py-1">
                        {statusText(d) && <Badge tone={tone(d)}>{statusText(d)}</Badge>}
                        {d.lateMinutes > 0 && <span className="ml-2 text-ink-muted">{d.lateMinutes} min after start</span>}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}
