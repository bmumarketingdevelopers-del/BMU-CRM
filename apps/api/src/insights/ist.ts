// Calendar helpers in IST (UTC+5:30, no daylight saving). Months, weeks and days start at IST midnight.
const OFFSET = 330 * 60_000;
export const DAY = 86_400_000;

const shifted = (d: Date) => new Date(d.getTime() + OFFSET);
/** UTC instant of IST midnight on y-m-d (month is 0-based and may overflow). */
export const istDate = (y: number, m: number, d = 1) => new Date(Date.UTC(y, m, d) - OFFSET);

export function istParts(d: Date) {
  const s = shifted(d);
  return { y: s.getUTCFullYear(), m: s.getUTCMonth(), d: s.getUTCDate(), dow: s.getUTCDay() };
}

export const startOfDay = (d: Date) => {
  const p = istParts(d);
  return istDate(p.y, p.m, p.d);
};

export const startOfMonth = (d: Date, add = 0) => {
  const p = istParts(d);
  return istDate(p.y, p.m + add, 1);
};

/** Monday 00:00 IST of the week containing d. */
export const startOfWeek = (d: Date, addWeeks = 0) => {
  const p = istParts(d);
  const back = (p.dow + 6) % 7;
  return istDate(p.y, p.m, p.d - back + addWeeks * 7);
};

/** Indian financial year starting 1 April. */
export const startOfFy = (d: Date) => {
  const p = istParts(d);
  return istDate(p.m >= 3 ? p.y : p.y - 1, 3, 1);
};

/** Quarter of the financial year (Apr–Jun, Jul–Sep, Oct–Dec, Jan–Mar). */
export const startOfQuarter = (d: Date) => {
  const p = istParts(d);
  return istDate(p.y, Math.floor(p.m / 3) * 3, 1);
};

export const monthKey = (d: Date) => {
  const p = istParts(d);
  return `${p.y}-${String(p.m + 1).padStart(2, '0')}`;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthLabel = (d: Date, withYear = false) => {
  const p = istParts(d);
  return withYear ? `${MONTHS[p.m]} ${p.y}` : MONTHS[p.m];
};
export const dayLabel = (d: Date) => {
  const p = istParts(d);
  return `${p.d} ${MONTHS[p.m]}`;
};

/** ISO date (yyyy-mm-dd) in IST. */
export const isoDay = (d: Date) => {
  const p = istParts(d);
  return `${p.y}-${String(p.m + 1).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
};

/** Whole days from a to b (b later = positive), counted on IST calendar days. */
export const daysBetween = (a: Date, b: Date) => Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / DAY);
