import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import SwipeDb from '../src/swipe/db';

describe('SwipeDb', () => {
  it('clears reviewed marks by taken time without touching other periods', async () => {
    const db = new SwipeDb('range-test');
    for (const [key, taken] of [['a', 100], ['b', 200], ['c', 299], ['d', 300]] as const) {
      await db.markReviewed({ mediaKey: key, dedupKey: key, decision: 'keep', at: 0, taken });
    }
    expect(await db.unmarkReviewedTaken(200, 300)).toBe(2);
    expect([...(await db.filterReviewed(['a', 'b', 'c', 'd']))].sort()).toEqual(['a', 'd']);
    expect(await db.unmarkReviewedTaken(-Infinity, Infinity)).toBe(2);
    expect(await db.countReviewed()).toBe(0);
  });

  it('pages through the log in order and filters by time', async () => {
    const db = new SwipeDb('log-test');
    for (let i = 0; i < 25; i++) {
      await db.addLog({ at: i, session: 's', action: 'keep', mediaKey: `m${i}`, dedupKey: `d${i}`, taken: 0, status: 'done' });
    }
    const seen: number[] = [];
    await db.iterateLog((batch) => { seen.push(...batch.map((e) => e.at)); }, 10, 7);
    expect(seen).toEqual(Array.from({ length: 15 }, (_, i) => i + 10));
  });
});
