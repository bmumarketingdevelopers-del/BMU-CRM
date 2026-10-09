// Small date and number helpers for the craft dashboards (IST weeks, periods, rounding).
import { istDate } from '@bmu/shared';

export const DAY = 86_400_000;
const IST = 330 * 60_000;

export type Range = { from: Date; to: Date };
export type Periods = { cur: Range; prev: Range };

/** Period from ?from=YYYY-MM-DD&to=YYYY-MM-DD (IST days, inclusive), default the last 30 days, plus the previous period of equal length. */
export function periodsFrom(from?: string, to?: string): Periods {
  const okDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
  const today = istDate(new Date());
  const toDay = okDate(to) ? to! : today;
  const end = new Date(new Date(`${toDay}T00:00:00+05:30`).getTime() + DAY);
  let start = okDate(from) ? new Date(`${from}T00:00:00+05:30`) : new Date(end.getTime() - 30 * DAY);
  if (start >= end) start = new Date(end.getTime() - DAY);
  const len = end.getTime() - start.getTime();
  return { cur: { from: start, to: end }, prev: { from: new Date(start.getTime() - len), to: start } };
}

export const inRange = (d: Date | null | undefined, r: Range) => !!d && d >= r.from && d < r.to;

/** Monday 00:00 IST of the week containing d. */
export function weekStart(d: Date): Date {
  const ist = new Date(d.getTime() + IST);
  const dow = (ist.getUTCDay() + 6) % 7; // Mon = 0
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() - dow) - IST);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const shortDay = (d: Date) => {
  const ist = new Date(d.getTime() + IST);
  return `${ist.getUTCDate()} ${MONTHS[ist.getUTCMonth()]}`;
};

/** IST day of week, Mon = 0 … Sun = 6. */
export const istDow = (d: Date) => (new Date(d.getTime() + IST).getUTCDay() + 6) % 7;

export const round1 = (n: number) => Math.round(n * 10) / 10;
export const pct = (good: number, total: number) => (total ? Math.round((good / total) * 100) : null);
export const avg = (xs: number[]) => (xs.length ? round1(xs.reduce((s, x) => s + x, 0) / xs.length) : null);
export const days = (a: Date, b: Date) => (b.getTime() - a.getTime()) / DAY;
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "0:42" for seconds. */
export const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
