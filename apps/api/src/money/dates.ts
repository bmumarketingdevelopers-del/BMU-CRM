// Plain-date helpers for v18 (dates as 'YYYY-MM-DD' in IST; @db.Date columns hold them as UTC midnight).
const OFFSET = 330 * 60_000;
export const DAY = 86_400_000;

/** Today's date in IST as YYYY-MM-DD. */
export const todayIst = (now = new Date()) => new Date(now.getTime() + OFFSET).toISOString().slice(0, 10);
/** A @db.Date value for YYYY-MM-DD. */
export const dbDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
/** YYYY-MM-DD of a @db.Date value. */
export const isoOf = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (iso: string, n: number) => isoOf(new Date(dbDate(iso).getTime() + n * DAY));
/** Monday of the week containing the date. */
export const mondayOf = (iso: string) => {
  const dow = dbDate(iso).getUTCDay();
  return addDays(iso, -((dow + 6) % 7));
};
export const isMonday = (iso: string) => dbDate(iso).getUTCDay() === 1;
/** Monday-to-Friday dates of a week, or Monday-to-Saturday when Saturday is a working day. */
export const workDays = (weekStart: string, days = 5) => Array.from({ length: days }, (_, i) => addDays(weekStart, i));
