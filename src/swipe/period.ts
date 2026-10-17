// Time windows the swipe feed walks through. Boundaries are local time,
// start inclusive, end exclusive. Weeks start on Monday.

export type Granularity = 'day' | 'week' | 'month' | 'year' | 'all';

export interface Period {
  granularity: Granularity;
  start: number; // ms, inclusive (-Infinity for 'all')
  end: number; // ms, exclusive (Infinity for 'all')
}

function startOf(granularity: Exclude<Granularity, 'all'>, date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (granularity === 'week') {
    const offset = (d.getDay() + 6) % 7; // Monday = 0
    d.setDate(d.getDate() - offset);
  } else if (granularity === 'month') {
    d.setDate(1);
  } else if (granularity === 'year') {
    d.setMonth(0, 1);
  }
  return d;
}

function addUnits(granularity: Exclude<Granularity, 'all'>, date: Date, amount: number): Date {
  const d = new Date(date);
  if (granularity === 'day') d.setDate(d.getDate() + amount);
  else if (granularity === 'week') d.setDate(d.getDate() + amount * 7);
  else if (granularity === 'month') d.setMonth(d.getMonth() + amount);
  else d.setFullYear(d.getFullYear() + amount);
  return d;
}

export function periodContaining(granularity: Granularity, date: Date | number): Period {
  if (granularity === 'all') return { granularity, start: -Infinity, end: Infinity };
  const start = startOf(granularity, new Date(date));
  const end = addUnits(granularity, start, 1);
  return { granularity, start: start.getTime(), end: end.getTime() };
}

/** Move by whole periods. Negative goes back in time. */
export function shiftPeriod(period: Period, amount: number): Period {
  if (period.granularity === 'all') return period;
  return periodContaining(period.granularity, addUnits(period.granularity, new Date(period.start), amount));
}

export function periodKey(period: Period): string {
  if (period.granularity === 'all') return 'all';
  return `${period.granularity}:${period.start}`;
}

export function periodLabel(period: Period): string {
  if (period.granularity === 'all') return 'Entire library';
  const start = new Date(period.start);
  if (period.granularity === 'day') {
    return start.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }
  if (period.granularity === 'week') {
    const last = new Date(period.end - 1);
    const from = start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const to = last.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    return `${from} – ${to}`;
  }
  if (period.granularity === 'month') {
    return start.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  }
  return String(start.getFullYear());
}

/** How far through the period a timestamp is, walking newest to oldest (0..1). */
export function periodProgress(period: Period, timestamp: number, now = Date.now()): number {
  // The current period ends in the future, so measure from now rather than
  // the calendar end
  const top = Math.min(period.end, now);
  const bottom = Number.isFinite(period.start) ? period.start : 0;
  if (top <= bottom) return 0;
  return Math.min(1, Math.max(0, (top - timestamp) / (top - bottom)));
}

/** yyyy-mm-dd in local time, for <input type="date">. */
export function toDateInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fromDateInputValue(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
}
