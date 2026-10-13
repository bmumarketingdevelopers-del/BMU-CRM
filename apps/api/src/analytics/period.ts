// Period handling for the sales analytics: ISO dates in, IST instants out, plus the previous equal-length period.
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Me, SalesPeriod } from '@bmu/shared';
import { canSeeMoney } from '../insights/access.js';
import { DAY, isoDay, istDate, istParts } from '../insights/ist.js';

export type Range = { start: Date; end: Date };
export type ResolvedPeriod = { cur: Range; prev: Range; view: SalesPeriod };

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_DAYS = 3 * 366;

function parseDay(s: string, name: string): Date {
  const m = ISO.exec(s);
  if (!m) throw new BadRequestException(`${name} must be a date like 2026-04-01`);
  const d = istDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime()) || isoDay(d) !== s) throw new BadRequestException(`${name} is not a real date`);
  return d;
}

/** from/to are inclusive IST calendar dates. Default: the last 90 days ending today. */
export function resolvePeriod(from?: string, to?: string, now = new Date()): ResolvedPeriod {
  const today = istParts(now);
  const end = to ? new Date(parseDay(to, 'to').getTime() + DAY) : istDate(today.y, today.m, today.d + 1);
  const start = from ? parseDay(from, 'from') : new Date(end.getTime() - 90 * DAY);
  if (start >= end) throw new BadRequestException('The start date must be on or before the end date');
  const days = Math.round((end.getTime() - start.getTime()) / DAY);
  if (days > MAX_DAYS) throw new BadRequestException('Pick a period of three years or less');
  const prev = { start: new Date(start.getTime() - days * DAY), end: start };
  return {
    cur: { start, end },
    prev,
    view: { from: isoDay(start), to: isoDay(new Date(end.getTime() - 1)), prevFrom: isoDay(prev.start), prevTo: isoDay(new Date(prev.end.getTime() - 1)), days },
  };
}

export const inRange = (d: Date | null | undefined, r: Range) => !!d && d >= r.start && d < r.end;

/** Money analytics are for Founder, Branch Manager and Finance (same rule as the Revenue and Collections dashboards). */
export function assertSalesMoney(me: Me) {
  if (!canSeeMoney(me)) throw new ForbiddenException('Sales and money analytics are for Founder, Branch Manager and Finance');
}

/** The funnel is also open to whoever manages the whole sales pipeline; money columns stay hidden for them. */
export function canSeeFunnel(me: Me) {
  return canSeeMoney(me) || (me.type === 'staff' && me.permissions.leads_pipeline?.scope === 'all');
}
export function assertFunnel(me: Me) {
  if (!canSeeFunnel(me)) throw new ForbiddenException('The sales funnel is for Founder, Branch Manager, Finance and sales managers');
}

export const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : null);
export const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const round1 = (n: number) => Math.round(n * 10) / 10;
