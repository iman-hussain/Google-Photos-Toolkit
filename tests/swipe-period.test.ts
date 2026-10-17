import { describe, it, expect } from 'vitest';
import { periodContaining, shiftPeriod, periodKey, periodProgress, toDateInputValue, fromDateInputValue } from '../src/swipe/period';

const local = (y: number, m: number, d: number, h = 0): number => new Date(y, m - 1, d, h).getTime();

describe('periodContaining', () => {
  it('day covers midnight to midnight', () => {
    const p = periodContaining('day', local(2024, 3, 15, 13));
    expect(p.start).toBe(local(2024, 3, 15));
    expect(p.end).toBe(local(2024, 3, 16));
  });

  it('weeks start on Monday', () => {
    // 17 March 2024 is a Sunday
    const p = periodContaining('week', local(2024, 3, 17, 20));
    expect(p.start).toBe(local(2024, 3, 11));
    expect(p.end).toBe(local(2024, 3, 18));
  });

  it('month handles February in a leap year', () => {
    const p = periodContaining('month', local(2024, 2, 29));
    expect(p.start).toBe(local(2024, 2, 1));
    expect(p.end).toBe(local(2024, 3, 1));
  });

  it('year covers Jan 1 to Jan 1', () => {
    const p = periodContaining('year', local(2019, 7, 4));
    expect(p.start).toBe(local(2019, 1, 1));
    expect(p.end).toBe(local(2020, 1, 1));
  });

  it('all is unbounded', () => {
    const p = periodContaining('all', Date.now());
    expect(p.start).toBe(-Infinity);
    expect(p.end).toBe(Infinity);
  });
});

describe('shiftPeriod', () => {
  it('steps months across a year boundary', () => {
    const jan = periodContaining('month', local(2024, 1, 10));
    const dec = shiftPeriod(jan, -1);
    expect(dec.start).toBe(local(2023, 12, 1));
    expect(dec.end).toBe(local(2024, 1, 1));
  });

  it('does not drift when stepping from a 31st', () => {
    const p = periodContaining('month', local(2024, 1, 31));
    expect(shiftPeriod(p, 1).start).toBe(local(2024, 2, 1));
  });

  it('is a no-op for all', () => {
    const p = periodContaining('all', 0);
    expect(shiftPeriod(p, -1)).toBe(p);
  });
});

describe('helpers', () => {
  it('periodKey is stable per period', () => {
    expect(periodKey(periodContaining('week', local(2024, 3, 12)))).toBe(periodKey(periodContaining('week', local(2024, 3, 14))));
    expect(periodKey(periodContaining('all', 0))).toBe('all');
  });

  it('periodProgress walks from newest to oldest', () => {
    const p = periodContaining('day', local(2024, 3, 15));
    const later = p.end + 1000;
    expect(periodProgress(p, p.end, later)).toBe(0);
    expect(periodProgress(p, (p.start + p.end) / 2, later)).toBe(0.5);
    expect(periodProgress(p, p.start, later)).toBe(1);
  });

  it('periodProgress starts at 0 when the period ends in the future', () => {
    const p = periodContaining('month', local(2024, 3, 10));
    const now = local(2024, 3, 15);
    expect(periodProgress(p, now, now)).toBe(0);
    expect(periodProgress(p, p.start, now)).toBe(1);
  });

  it('round-trips date input values', () => {
    const ms = local(2021, 9, 5);
    expect(toDateInputValue(ms)).toBe('2021-09-05');
    expect(fromDateInputValue('2021-09-05')).toBe(ms);
    expect(fromDateInputValue('nope')).toBeNull();
  });
});
