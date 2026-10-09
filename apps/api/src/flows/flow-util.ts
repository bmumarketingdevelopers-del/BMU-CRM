import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Me } from '@bmu/shared';

export const DAY_MS = 86_400_000;
export const MAP_ROLES = ['founder', 'admin', 'am_lead', 'department_head'];
export const PULSE_ROLES = ['founder', 'admin'];

export function assertRoles(me: Me, roles: string[], what: string) {
  if (me.type !== 'staff' || !me.roles.some((r) => roles.includes(r))) throw new ForbiddenException(`Your role doesn't include the ${what}`);
}

/** Calendar date in IST, "YYYY-MM-DD". */
export const istDate = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);

/** Whole calendar days between two instants, counted on IST dates (b − a). */
export const istDayDiff = (a: Date, b: Date) => Math.round((Date.parse(istDate(b)) - Date.parse(istDate(a))) / DAY_MS);

/** Elapsed days, one decimal. */
export const daysSince = (d: Date, now = new Date()) => Math.max(0, Math.round(((now.getTime() - d.getTime()) / DAY_MS) * 10) / 10);

export const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null);
export const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : null);

export type Window = { from: Date; to: Date; fromIso: string; toIso: string };

const isoRe = /^\d{4}-\d{2}-\d{2}$/;
/** Period from query params (IST dates, inclusive), default last 90 days, plus the equal-length window before it. */
export function windows(from?: string, to?: string): { cur: Window; prev: Window } {
  if ((from && !isoRe.test(from)) || (to && !isoRe.test(to))) throw new BadRequestException('Use YYYY-MM-DD dates');
  const toIso = to ?? istDate(new Date());
  const fromIso = from ?? istDate(new Date(Date.parse(toIso) - 89 * DAY_MS));
  const start = new Date(`${fromIso}T00:00:00+05:30`);
  const end = new Date(`${toIso}T23:59:59.999+05:30`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new BadRequestException('Use valid YYYY-MM-DD dates');
  if (start > end) throw new BadRequestException('The start date must be before the end date');
  const len = end.getTime() - start.getTime() + 1;
  const pStart = new Date(start.getTime() - len);
  const pEnd = new Date(start.getTime() - 1);
  return { cur: { from: start, to: end, fromIso, toIso }, prev: { from: pStart, to: pEnd, fromIso: istDate(pStart), toIso: istDate(pEnd) } };
}

export const inWindow = (d: Date | null | undefined, w: Window) => !!d && d >= w.from && d <= w.to;

export const minDate = (ds: (Date | null | undefined)[]) => {
  const v = ds.filter((d): d is Date => !!d);
  return v.length ? new Date(Math.min(...v.map((d) => d.getTime()))) : null;
};
export const maxDate = (ds: (Date | null | undefined)[]) => {
  const v = ds.filter((d): d is Date => !!d);
  return v.length ? new Date(Math.max(...v.map((d) => d.getTime()))) : null;
};

export const contactName = (c: unknown) => {
  const x = (c ?? {}) as { name?: string; company?: string };
  return x.company || x.name || 'Unnamed lead';
};

/** "12 Sep" in IST. */
export const fmtDay = (d: Date | string) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
