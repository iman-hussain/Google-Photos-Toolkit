// Which periods have been sorted, and how many photos each holds. Kept free
// of DOM/IndexedDB so the picker logic can be unit tested.

import { periodContaining, periodKey, shiftPeriod, type Granularity, type Period } from './period';

/** periodKey -> when it was marked sorted. */
export type DoneMap = Record<string, number>;

/** Per-day item counts from a one-off timeline scan, keyed by local yyyy-mm-dd. */
export interface LibraryCounts {
  days: Record<string, number>;
  total: number;
  scannedAt: number;
  includeArchived: boolean;
}

const ORDER: Granularity[] = ['day', 'week', 'month', 'year'];

export function dayKey(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Marked sorted itself, or sits wholly inside a bigger period that is. */
export function isSorted(period: Period, done: DoneMap): boolean {
  if (done[periodKey(period)] || done.all) return true;
  if (period.granularity === 'all') return false;
  const from = ORDER.indexOf(period.granularity);
  for (const granularity of ORDER.slice(from + 1)) {
    const container = periodContaining(granularity, period.start);
    if (container.end >= period.end && done[periodKey(container)]) return true;
  }
  return false;
}

/** Items in a period according to the last scan, or null if never scanned. */
export function countIn(period: Period, counts: LibraryCounts | null): number | null {
  if (!counts) return null;
  if (period.granularity === 'all') return counts.total;
  let total = 0;
  for (let day = periodContaining('day', period.start); day.start < period.end; day = shiftPeriod(day, 1)) {
    total += counts.days[dayKey(day.start)] ?? 0;
  }
  return total;
}

/** Oldest year with photos according to the scan. */
export function oldestYear(counts: LibraryCounts | null): number | null {
  if (!counts) return null;
  let oldest: string | null = null;
  for (const key of Object.keys(counts.days)) if (oldest === null || key < oldest) oldest = key;
  return oldest ? Number(oldest.slice(0, 4)) : null;
}

/**
 * Step from a period to the next one that isn't sorted (and, if the library
 * has been scanned, has photos in it). Never goes into the future or before
 * the oldest scanned photo.
 */
export function nextUnsorted(
  from: Period,
  direction: -1 | 1,
  done: DoneMap,
  counts: LibraryCounts | null,
  now = Date.now(),
  limit = 5000
): Period | null {
  if (from.granularity === 'all') return null;
  const floorYear = oldestYear(counts);
  const floor = floorYear === null ? -Infinity : new Date(floorYear, 0, 1).getTime();
  let period = from;
  for (let i = 0; i < limit; i++) {
    period = shiftPeriod(period, direction);
    if (period.start > now || period.end <= floor) return null;
    if (isSorted(period, done)) continue;
    if (counts && countIn(period, counts) === 0) continue;
    return period;
  }
  return null;
}
