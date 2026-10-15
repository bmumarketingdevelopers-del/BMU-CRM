// Shared helpers for the operations analytics: period parsing, buckets, small statistics and access rules.
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { workingMinutesBetween, type Me, type OpsCompare, type OpsInsight, type OpsRange, type WorkCalendar } from '@bmu/shared';
import { canReadCommand, seesAllDepartments } from '../insights/access.js';
import { DAY, dayLabel, isoDay, istParts, monthLabel, startOfDay, startOfMonth, startOfWeek } from '../insights/ist.js';

export { DAY };

/** 48 productive hours a week over six working days. */
export const PRODUCTIVE_HOURS_PER_WEEK = 48;
export const OPEN_TASK_STATUSES = ['todo', 'in_progress', 'blocked', 'waiting', 'in_qc'] as const;
export const DONE_DELIVERABLE = ['approved', 'scheduled', 'published'];

export type Range = { from: Date; to: Date; prevFrom: Date; prevTo: Date; days: number; bucket: 'week' | 'month' };

function parseDay(s: string, label: string) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) throw new BadRequestException(`The ${label} date must look like 2026-07-01`);
  const d = s.length === 10 ? new Date(`${s}T00:00:00+05:30`) : new Date(s);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`The ${label} date is not a real date`);
  return d;
}

/** from/to (ISO dates, IST days, both inclusive) → half-open range plus the previous period of the same length. Defaults to the last 90 days. */
export function parseRange(fromQ?: string, toQ?: string): Range {
  const now = new Date();
  const to = new Date(startOfDay(toQ ? parseDay(toQ, 'end') : now).getTime() + DAY);
  const from = fromQ ? startOfDay(parseDay(fromQ, 'start')) : new Date(to.getTime() - 90 * DAY);
  if (from >= to) throw new BadRequestException('The start date must be before the end date');
  const len = to.getTime() - from.getTime();
  if (len > 3 * 366 * DAY) throw new BadRequestException('Pick a period of three years or less');
  const days = Math.round(len / DAY);
  return { from, to, prevFrom: new Date(from.getTime() - len), prevTo: from, days, bucket: days <= 120 ? 'week' : 'month' };
}

export const outRange = (r: Range): OpsRange => ({
  from: isoDay(r.from),
  to: isoDay(new Date(r.to.getTime() - 1)),
  prevFrom: isoDay(r.prevFrom),
  prevTo: isoDay(new Date(r.prevTo.getTime() - 1)),
  days: r.days,
  bucket: r.bucket,
});

export type Bucket = { start: Date; end: Date; label: string };

/** Week (Monday) or month buckets covering the range. */
export function buckets(r: Pick<Range, 'from' | 'to'>, kind: 'week' | 'month'): Bucket[] {
  const out: Bucket[] = [];
  const crossYear = istParts(r.from).y !== istParts(new Date(r.to.getTime() - 1)).y;
  let s = kind === 'week' ? startOfWeek(r.from) : startOfMonth(r.from);
  while (s < r.to && out.length < 400) {
    const e = kind === 'week' ? startOfWeek(s, 1) : startOfMonth(s, 1);
    out.push({ start: s, end: e, label: kind === 'week' ? dayLabel(s) : monthLabel(s, crossYear) });
    s = e;
  }
  return out;
}
export const bucketOf = (bs: Bucket[], d: Date | null | undefined) => (d ? bs.findIndex((b) => d >= b.start && d < b.end) : -1);

export const round1 = (n: number) => Math.round(n * 10) / 10;
export const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
export const avg = (xs: number[]) => (xs.length ? round1(sum(xs) / xs.length) : null);
export function median(xs: number[]) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return round1(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}
export const pct = (part: number, whole: number) => (whole ? round1((part / whole) * 100) : null);
export const inRange = (d: Date | null | undefined, a: Date, b: Date): d is Date => !!d && d >= a && d < b;
export const cmp = (value: number | null, prev: number | null): OpsCompare => ({ value, prev });

/** Working days between two moments (fractions count: half a working day is 0.5). */
export const workDays = (a: Date, b: Date, cal: WorkCalendar) => round1(workingMinutesBetween(a, b, cal) / (cal.endMin - cal.startMin));

/** Number of working days (by the org calendar) from a up to b. */
export function workingDayCount(a: Date, b: Date, cal: WorkCalendar) {
  let n = 0;
  for (let d = startOfDay(a); d < b; d = new Date(d.getTime() + DAY)) {
    const p = istParts(d);
    const iso = isoDay(d);
    if (cal.days.includes(p.dow) && !cal.holidays.includes(iso)) n++;
  }
  return n;
}

export const insight = (text: string, tone: OpsInsight['tone'] = 'default'): OpsInsight => ({ text, tone });
export const fmtPct = (n: number | null) => (n === null ? '—' : `${Math.round(n)}%`);
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export function fmtMinutes(min: number | null) {
  if (min === null) return '—';
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}
/** "up from 70%" / "down from 3.1" / "" (no comparison). */
export function trendWords(now: number | null, prev: number | null, unit = '') {
  if (now === null || prev === null) return '';
  if (Math.abs(now - prev) < 0.05) return `, the same as the previous period`;
  return `, ${now > prev ? 'up' : 'down'} from ${unit === '%' ? Math.round(prev) : round1(prev)}${unit}`;
}

// ---------------------------------------------------------------------------
// Access

const TEAM_ROLES = ['founder', 'admin', 'department_head', 'am_lead'];

export function assertTeamReader(me: Me) {
  if (!(me.type === 'staff' && me.roles.some((r) => TEAM_ROLES.includes(r)))) throw new ForbiddenException('Team performance is for the Founder, Branch Manager, department heads and the CM lead');
}
export function assertOpsReader(me: Me) {
  if (!canReadCommand(me)) throw new ForbiddenException('Operations analytics are for the Command Centre team');
}
export function assertStaff(me: Me) {
  if (me.type !== 'staff') throw new ForbiddenException('For BMU team members only');
}
/** A department head is limited to their own department; everyone else sees all. */
export const limitedToOwnDepartment = (me: Me) => me.roles.includes('department_head') && !seesAllDepartments(me);
