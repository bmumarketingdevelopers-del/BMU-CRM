import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { isWorkingDay, istDate, type Me } from '@bmu/shared';

export const DAY_MS = 86_400_000;

export const hasRole = (me: Me, ...roles: string[]) => me.roles.some((r) => roles.includes(r));

export function assertStaff(me: Me) {
  if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
}

export const canSeeBilling = (me: Me) => (me.permissions.invoices_payments?.scope ?? 'none') !== 'none';

/** "2026-10" → IST month bounds as moments, plus the yyyy-mm-dd of its first and last day. */
export function monthRange(month: string | undefined) {
  const m = month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : istDate(new Date()).slice(0, 7);
  if (month && m !== month) throw new BadRequestException('Use a month like 2026-10');
  const [y, mo] = m.split('-').map(Number);
  const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
  const start = new Date(`${m}-01T00:00:00+05:30`);
  const end = new Date(`${next}-01T00:00:00+05:30`);
  const lastDay = istDate(new Date(end.getTime() - 1));
  return { month: m, start, end, firstDay: `${m}-01`, lastDay };
}

/** A calendar day (yyyy-mm-dd) as stored in @db.Date columns. */
export const dbDate = (day: string) => new Date(`${day}T00:00:00Z`);
/** yyyy-mm-dd of a @db.Date value. */
export const dayOf = (d: Date) => d.toISOString().slice(0, 10);

/** Every yyyy-mm-dd from `from` to `to`, inclusive. */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = dbDate(from).getTime(); t <= dbDate(to).getTime(); t += DAY_MS) out.push(dayOf(new Date(t)));
  return out;
}

/** Whether a calendar day is a working day (Mon–Sat, not a holiday). */
export const isWorkDay = (day: string, holidays: readonly string[], days?: readonly number[]) =>
  days ? days.includes(dbDate(day).getUTCDay()) && !holidays.includes(day) : isWorkingDay(new Date(`${day}T12:00:00+05:30`), holidays);

/** Working days between two calendar days (inclusive), optionally clipped to a window. */
export function workingDaysIn(from: string, to: string, holidays: readonly string[], clip?: { from: string; to: string }, days?: readonly number[]) {
  const a = clip && clip.from > from ? clip.from : from;
  const b = clip && clip.to < to ? clip.to : to;
  if (b < a) return 0;
  return eachDay(a, b).filter((d) => isWorkDay(d, holidays, days)).length;
}

/** Monday–Sunday of the IST week containing `now`. */
export function currentWeek(now = new Date()) {
  const today = istDate(now);
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  const monday = dayOf(new Date(dbDate(today).getTime() - ((dow + 6) % 7) * DAY_MS));
  const sunday = dayOf(new Date(dbDate(monday).getTime() + 6 * DAY_MS));
  return { today, from: monday, to: sunday, start: new Date(`${monday}T00:00:00+05:30`), end: new Date(new Date(`${sunday}T00:00:00+05:30`).getTime() + DAY_MS) };
}

export const excerpt = (body: string, n = 180) => {
  const plain = body
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join(' ')
    .replace(/(^|\s)(\d+[.)]|[-*>])\s+/g, '$1')
    .replace(/[*`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > n ? `${plain.slice(0, n - 1)}…` : plain;
};

export const isUniqueError = (e: unknown) => typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
