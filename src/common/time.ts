/**
 * India time. Servers run in UTC; every "today", weekday and clock time a person sees is IST (UTC+05:30,
 * no daylight saving). Dates travel as 'YYYY-MM-DD' strings, never as JavaScript Dates, so they can't
 * shift by a day.
 */
const IST_OFFSET_MS = 330 * 60_000;

/** Today's date in India. */
export function istToday(now: Date = new Date()): string {
  return istDateOf(now);
}

/** The Indian calendar date of a moment. */
export function istDateOf(moment: Date): string {
  return new Date(moment.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 1 = Monday … 7 = Sunday (ISO, the same numbering as schedule_templates.weekday). */
export function isoWeekday(date: string): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

/** The moment a clock time happens on an Indian date: istAt('2026-09-25', '09:30') → 04:00 UTC. */
export function istAt(date: string, time: string): Date {
  const [h = '0', m = '0'] = time.split(':');
  return new Date(Date.parse(`${date}T00:00:00Z`) + (Number(h) * 60 + Number(m)) * 60_000 - IST_OFFSET_MS);
}

/** Minutes since midnight, India time. */
export function istMinuteOfDay(moment: Date): number {
  const d = new Date(moment.getTime() + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** "9 AM", "9:30 AM", "12 PM": the way the app writes times. */
export function istClock(moment: Date): string {
  const mins = istMinuteOfDay(moment);
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h24 < 12 ? 'AM' : 'PM'}`;
}

/** "9 – 10 AM", "11 AM – 12 PM". */
export function istRange(from: Date, to: Date): string {
  const a = istClock(from);
  const b = istClock(to);
  const [aTime, aHalf] = a.split(' ');
  const [, bHalf] = b.split(' ');
  return aHalf === bHalf ? `${aTime} – ${b}` : `${a} – ${b}`;
}

/** "Today", "Tomorrow", or "Mon, 28 Sep". */
export function istDayLabel(date: string, now: Date = new Date()): string {
  const today = istToday(now);
  if (date === today) return 'Today';
  if (date === addDays(today, 1)) return 'Tomorrow';
  const d = new Date(`${date}T00:00:00Z`);
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** '09:00:00' → '09:00'. */
export const hhmm = (time: string): string => time.slice(0, 5);

/** '09:30' → 570. */
export const minutesOf = (time: string): number => {
  const [h = '0', m = '0'] = time.split(':');
  return Number(h) * 60 + Number(m);
};

/** 570 → '09:30'. */
export const timeOf = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
