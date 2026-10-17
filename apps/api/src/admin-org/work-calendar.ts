// v30: the company calendar for attendance: working days and hours (set by the Founder), holidays and the late grace.
import { ATTENDANCE_GRACE_DEFAULT } from '@bmu/shared';
import type { SettingsService } from '../settings/settings.service.js';

const DAY = 86_400_000;

export type WorkCalendar = { holidays: { date: string; name: string }[]; days: number[]; start: string; end: string; graceMinutes: number };
export type DayKind = { kind: 'working' | 'weekend' | 'holiday'; label: string | null };

export async function loadWorkCalendar(settings: SettingsService, orgId: string): Promise<WorkCalendar> {
  const [h, wh] = await Promise.all([settings.get(orgId, 'holidays'), settings.get(orgId, 'workingHours')]);
  return { holidays: h.list, days: wh.days, start: wh.start, end: wh.end, graceMinutes: wh.graceMinutes ?? ATTENDANCE_GRACE_DEFAULT };
}

/** A @db.Date column value for yyyy-mm-dd. */
export const dbDate = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
export const ymdOf = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (ymd: string, n: number) => ymdOf(new Date(dbDate(ymd).getTime() + n * DAY));

/** Minutes after midnight, India time. */
export const istMinutes = (d: Date) => {
  const ist = new Date(d.getTime() + 330 * 60_000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
};
export const hhmmToMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

/** "working" | "weekend" | "holiday" for an India calendar date. Working days come from Holidays & Working Hours. */
export function dayKind(ymd: string, cal: WorkCalendar): DayKind {
  const holiday = cal.holidays.find((h) => h.date === ymd);
  if (holiday) return { kind: 'holiday', label: holiday.name };
  if (!cal.days.includes(dbDate(ymd).getUTCDay())) return { kind: 'weekend', label: null };
  return { kind: 'working', label: null };
}

/** The next working day after `ymd` (within a year). */
export function nextWorkingDay(ymd: string, cal: WorkCalendar): string | null {
  for (let i = 1; i <= 366; i++) {
    const d = addDays(ymd, i);
    if (dayKind(d, cal).kind === 'working') return d;
  }
  return null;
}

/** The working day before `ymd` (within a month). */
export function previousWorkingDay(ymd: string, cal: WorkCalendar): string | null {
  for (let i = 1; i <= 31; i++) {
    const d = addDays(ymd, -i);
    if (dayKind(d, cal).kind === 'working') return d;
  }
  return null;
}

/** Late = checked in after start + grace. Returns minutes after the start time, or 0 when on time. */
export function lateMinutes(checkIn: Date | null | undefined, cal: WorkCalendar): number {
  if (!checkIn) return 0;
  const start = hhmmToMin(cal.start);
  const m = istMinutes(checkIn);
  return m > start + cal.graceMinutes ? m - start : 0;
}

/** "Wed 21 Oct" for messages. */
export const dayLabel = (ymd: string) => new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(dbDate(ymd));

/** v30: whether today's check-in / check-out buttons are open for this person (working day, once a day). */
export function checkWindow(att: { checkIn: Date | null; checkOut: Date | null } | null | undefined, ymd: string, cal: WorkCalendar) {
  const k = dayKind(ymd, cal);
  return {
    canCheckIn: k.kind === 'working' && !att?.checkIn,
    canCheckOut: !!att?.checkIn && !att.checkOut,
    offDay: k.kind === 'holiday' ? `Holiday: ${k.label}` : k.kind === 'weekend' ? 'Weekly off' : null,
  };
}
