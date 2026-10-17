import { describe, it, expect, vi } from 'vitest';
import { countIn, dayKey, isSorted, nextUnsorted, oldestYear, type LibraryCounts } from '../src/swipe/status';
import { isoWeek, periodContaining, periodKey } from '../src/swipe/period';
import { scanLibrary } from '../src/swipe/scan';
import type Api from '../src/api/api';
import type { LibraryTimelinePage } from '../src/types';
import { makeItem } from './fixtures';

const local = (y: number, m: number, d: number, h = 12): number => new Date(y, m - 1, d, h).getTime();

const counts: LibraryCounts = {
  days: { '2024-03-02': 5, '2024-03-20': 3, '2024-01-15': 2, '2019-06-01': 1 },
  total: 11,
  scannedAt: 0,
  includeArchived: false,
};

describe('isSorted', () => {
  const march = periodContaining('month', local(2024, 3, 1));

  it('is true for a period marked itself', () => {
    expect(isSorted(march, { [periodKey(march)]: 1 })).toBe(true);
  });

  it('covers days and weeks inside a sorted month or year', () => {
    const done = { [periodKey(march)]: 1 };
    expect(isSorted(periodContaining('day', local(2024, 3, 15)), done)).toBe(true);
    expect(isSorted(periodContaining('week', local(2024, 3, 13)), done)).toBe(true);
    const year = { [periodKey(periodContaining('year', local(2024, 1, 1)))]: 1 };
    expect(isSorted(march, year)).toBe(true);
  });

  it('does not cover a week that spills into an unsorted month', () => {
    // Week of Mon 26 Feb 2024 runs into March
    const week = periodContaining('week', local(2024, 2, 28));
    expect(isSorted(week, { [periodKey(march)]: 1 })).toBe(false);
  });

  it('does not leak upwards from a sorted day', () => {
    const day = periodContaining('day', local(2024, 3, 15));
    expect(isSorted(march, { [periodKey(day)]: 1 })).toBe(false);
  });
});

describe('counts', () => {
  it('sums days in a period', () => {
    expect(countIn(periodContaining('month', local(2024, 3, 1)), counts)).toBe(8);
    expect(countIn(periodContaining('year', local(2024, 1, 1)), counts)).toBe(10);
    expect(countIn(periodContaining('day', local(2024, 3, 2)), counts)).toBe(5);
    expect(countIn(periodContaining('all', 0), counts)).toBe(11);
    expect(countIn(periodContaining('month', local(2024, 3, 1)), null)).toBeNull();
  });

  it('finds the oldest year', () => {
    expect(oldestYear(counts)).toBe(2019);
    expect(oldestYear(null)).toBeNull();
  });

  it('dayKey is local yyyy-mm-dd', () => {
    expect(dayKey(local(2024, 3, 2, 0))).toBe('2024-03-02');
  });
});

describe('nextUnsorted', () => {
  const april = periodContaining('month', local(2024, 4, 1));
  const now = local(2024, 4, 20);

  it('skips sorted months', () => {
    const march = periodContaining('month', local(2024, 3, 1));
    const next = nextUnsorted(april, -1, { [periodKey(march)]: 1 }, null, now);
    expect(next && periodKey(next)).toBe(periodKey(periodContaining('month', local(2024, 2, 1))));
  });

  it('with counts, skips empty months too', () => {
    const march = periodContaining('month', local(2024, 3, 1));
    const next = nextUnsorted(april, -1, { [periodKey(march)]: 1 }, counts, now);
    expect(next && periodKey(next)).toBe(periodKey(periodContaining('month', local(2024, 1, 1))));
  });

  it('stops at the oldest photo and never goes into the future', () => {
    const june2019 = periodContaining('month', local(2019, 6, 1));
    expect(nextUnsorted(june2019, -1, {}, counts, now)).toBeNull();
    expect(nextUnsorted(april, 1, {}, null, now)).toBeNull();
  });
});

describe('isoWeek', () => {
  it('matches ISO 8601', () => {
    expect(isoWeek(local(2024, 1, 1))).toBe(1);
    expect(isoWeek(local(2024, 12, 30))).toBe(1); // belongs to 2025-W01
    expect(isoWeek(local(2021, 1, 3))).toBe(53); // belongs to 2020-W53
    expect(isoWeek(local(2024, 3, 13))).toBe(11);
  });
});

describe('scanLibrary', () => {
  it('counts owned items per day across pages', async () => {
    const items = [
      makeItem({ timestamp: local(2024, 3, 2), thumb: 't' }),
      makeItem({ timestamp: local(2024, 3, 2, 8), thumb: 't' }),
      makeItem({ timestamp: local(2024, 3, 1), thumb: 't', isOwned: false }),
      makeItem({ timestamp: local(2023, 7, 9), thumb: 't' }),
    ];
    const pages: LibraryTimelinePage[] = [
      { items: items.slice(0, 2), nextPageId: 'p2', lastItemTimestamp: items[1].timestamp },
      { items: items.slice(2), nextPageId: undefined, lastItemTimestamp: NaN },
    ];
    const api = { getItemsByTakenDate: vi.fn(() => Promise.resolve(pages.shift())) } as unknown as Api;
    const result = await scanLibrary(api, false, () => undefined, () => false);
    expect(result?.days).toEqual({ '2024-03-02': 2, '2023-07-09': 1 });
    expect(result?.total).toBe(3);
  });

  it('can be cancelled', async () => {
    const api = { getItemsByTakenDate: vi.fn() } as unknown as Api;
    expect(await scanLibrary(api, false, () => undefined, () => true)).toBeNull();
  });
});
