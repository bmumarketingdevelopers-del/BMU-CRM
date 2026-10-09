// BMU working time (workflow.non_negotiable_rules): 9:30 AM–6:30 PM, Monday–Saturday,
// Sundays and government holidays off. All dates are handled in Asia/Kolkata (UTC+5:30, no DST).

const IST_OFFSET_MS = 330 * 60 * 1000;

/** yyyy-mm-dd of a moment in IST. */
export const istDate = (d: Date): string => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

export function isWorkingDay(d: Date, holidays: readonly string[] = []): boolean {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  return ist.getUTCDay() !== 0 && !holidays.includes(istDate(d));
}

/**
 * Deadline n working days after `from`, at 6:30 PM IST (end of the working day).
 * Used for "planning gets up to 4 working days after requirements are complete".
 */
export function addWorkingDays(from: Date, n: number, holidays: readonly string[] | WorkCalendar = []): Date {
  // A full calendar (Command Centre working days) or just holiday dates (Monday–Saturday).
  const workday = Array.isArray(holidays) ? (d: Date) => isWorkingDay(d, holidays as readonly string[]) : (d: Date) => isWorkDay(d, holidays as WorkCalendar);
  let cursor = new Date(from.getTime());
  let added = 0;
  while (added < n) {
    cursor = new Date(cursor.getTime() + 86_400_000);
    if (workday(cursor)) added++;
  }
  const day = istDate(cursor);
  return new Date(`${day}T18:30:00+05:30`);
}

// ---------------------------------------------------------------------------
// Working hours (SLA timers pause outside working hours, on days off and on holidays).
// Defaults to 9:30–18:30 Mon–Sat; Command Centre → Holidays & Working Hours can change it.

export const WORK_START_MIN = 9 * 60 + 30;
export const WORK_END_MIN = 18 * 60 + 30;
const DAY_MS = 86_400_000;

/** Working calendar: holidays plus hours (minutes past IST midnight) and working weekdays (0 = Sunday). */
export type WorkCalendar = { holidays: readonly string[]; startMin: number; endMin: number; days: readonly number[] };
type CalendarInput = readonly string[] | WorkCalendar;

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
};

/** Builds a calendar from the workingHours settings (HH:MM strings) and holiday dates. */
export function workCalendar(holidays: readonly string[] = [], hours?: { start: string; end: string; days: readonly number[] }): WorkCalendar {
  const startMin = hours ? toMin(hours.start) : WORK_START_MIN;
  const endMin = hours ? toMin(hours.end) : WORK_END_MIN;
  return {
    holidays,
    startMin,
    endMin: endMin > startMin ? endMin : WORK_END_MIN,
    days: hours?.days?.length ? hours.days : [1, 2, 3, 4, 5, 6],
  };
}

const cal = (c: CalendarInput): WorkCalendar => (Array.isArray(c) ? workCalendar(c as readonly string[]) : (c as WorkCalendar));

const isWorkDay = (d: Date, c: WorkCalendar) => {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  return c.days.includes(ist.getUTCDay()) && !c.holidays.includes(istDate(d));
};

/** Minutes since IST midnight for a moment. */
const istMinutes = (d: Date) => {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes() + ist.getUTCSeconds() / 60;
};
/** The moment at `minutes` past IST midnight on the IST day of `d`. */
const atIst = (d: Date, minutes: number) => new Date(new Date(`${istDate(d)}T00:00:00+05:30`).getTime() + minutes * 60_000);

function nextWorkStart(d: Date, c: WorkCalendar): Date {
  let cursor = atIst(d, c.startMin);
  if (cursor.getTime() <= d.getTime() && istMinutes(d) >= c.endMin) cursor = atIst(new Date(cursor.getTime() + DAY_MS), c.startMin);
  while (!isWorkDay(cursor, c)) cursor = atIst(new Date(cursor.getTime() + DAY_MS), c.startMin);
  return cursor;
}

/** Moves a moment forward to working time (unchanged if already inside working hours). */
export function clampToWorkingTime(d: Date, calendar: CalendarInput = []): Date {
  const c = cal(calendar);
  const m = istMinutes(d);
  if (isWorkDay(d, c) && m >= c.startMin && m < c.endMin) return d;
  if (isWorkDay(d, c) && m < c.startMin) return atIst(d, c.startMin);
  return nextWorkStart(d, c);
}

/** Adds working minutes, skipping evenings, days off and holidays. */
export function addWorkingMinutes(from: Date, minutes: number, calendar: CalendarInput = []): Date {
  const c = cal(calendar);
  let cursor = clampToWorkingTime(from, c);
  let left = minutes;
  for (;;) {
    const available = c.endMin - istMinutes(cursor);
    if (left <= available) return new Date(cursor.getTime() + left * 60_000);
    left -= available;
    cursor = nextWorkStart(atIst(cursor, c.endMin), c);
  }
}

/** Working minutes elapsed between two moments (0 if b is before a). */
export function workingMinutesBetween(a: Date, b: Date, calendar: CalendarInput = []): number {
  const c = cal(calendar);
  if (b <= a) return 0;
  let total = 0;
  let cursor = clampToWorkingTime(a, c);
  while (cursor < b) {
    const dayEnd = atIst(cursor, c.endMin);
    const end = b < dayEnd ? b : dayEnd;
    total += Math.max(0, (end.getTime() - cursor.getTime()) / 60_000);
    cursor = nextWorkStart(dayEnd, c);
  }
  return Math.round(total);
}

/** End of the working day a message arrives in ("same working day" SLA). */
export function endOfWorkingDay(d: Date, calendar: CalendarInput = []): Date {
  const c = cal(calendar);
  return atIst(clampToWorkingTime(d, c), c.endMin);
}
