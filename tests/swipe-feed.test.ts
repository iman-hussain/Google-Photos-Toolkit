import { describe, it, expect, vi } from 'vitest';
import TimelineFeed from '../src/swipe/feed';
import type Api from '../src/api/api';
import type { LibraryTimelinePage, MediaItem } from '../src/types';
import { makeItem } from './fixtures';

const DAY = 86_400_000;

function photo(ts: number, overrides: Partial<MediaItem> = {}): MediaItem {
  return makeItem({ timestamp: ts, thumb: 'https://lh3.example/x', ...overrides });
}

/** Fake timeline: newest first, pages of items taken at or before `timestamp`. */
function fakeApi(items: MediaItem[], pageSize = 3): { api: Api; calls: Array<number | null> } {
  const sorted = [...items].sort((a, b) => b.timestamp - a.timestamp);
  const calls: Array<number | null> = [];
  const getItemsByTakenDate = vi.fn((timestamp: number | null): Promise<LibraryTimelinePage> => {
    calls.push(timestamp);
    const page = sorted.filter((i) => timestamp === null || i.timestamp <= timestamp).slice(0, pageSize);
    return Promise.resolve({
      items: page,
      nextPageId: undefined,
      lastItemTimestamp: page.length ? page[page.length - 1].timestamp : NaN,
    });
  });
  return { api: { getItemsByTakenDate } as unknown as Api, calls };
}

const noneReviewed = (): Promise<Set<string>> => Promise.resolve(new Set());

async function drain(feed: TimelineFeed): Promise<string[]> {
  const keys: string[] = [];
  for (let item = await feed.next(); item; item = await feed.next()) keys.push(item.mediaKey);
  return keys;
}

describe('TimelineFeed', () => {
  const period = { granularity: 'week' as const, start: 10 * DAY, end: 17 * DAY };

  it('returns only items inside the period, newest first', async () => {
    const inside = [11, 12, 13, 14, 15, 16].map((d) => photo(d * DAY));
    const outside = [photo(9 * DAY), photo(18 * DAY)];
    const { api, calls } = fakeApi([...inside, ...outside]);
    const feed = new TimelineFeed(api, period, { includeArchived: false, skipReviewed: true, filterReviewed: noneReviewed });

    expect(await drain(feed)).toEqual([...inside].reverse().map((i) => i.mediaKey));
    expect(calls[0]).toBe(17 * DAY - 1);
    // Stops once it has paged past the start of the period
    expect(feed.fetchedPages).toBeLessThanOrEqual(3);
  });

  it('drops reviewed and unowned items', async () => {
    const a = photo(16 * DAY);
    const b = photo(15 * DAY);
    const c = photo(14 * DAY, { isOwned: false });
    const { api } = fakeApi([a, b, c]);
    const feed = new TimelineFeed(api, period, {
      includeArchived: false,
      skipReviewed: true,
      filterReviewed: (keys) => Promise.resolve(new Set(keys.filter((k) => k === a.mediaKey))),
    });
    expect(await drain(feed)).toEqual([b.mediaKey]);
    expect(feed.skippedReviewed).toBe(1);
  });

  it('resumes from a saved cursor', async () => {
    const items = [16, 15, 14, 13].map((d) => photo(d * DAY));
    const { api, calls } = fakeApi(items);
    const feed = new TimelineFeed(api, period, { includeArchived: false, skipReviewed: false, filterReviewed: noneReviewed, startAt: 14 * DAY });
    expect(await drain(feed)).toEqual([items[2].mediaKey, items[3].mediaKey]);
    expect(calls[0]).toBe(14 * DAY);
  });

  it('puts undone items back at the front', async () => {
    const items = [16, 15].map((d) => photo(d * DAY));
    const { api } = fakeApi(items);
    const feed = new TimelineFeed(api, period, { includeArchived: false, skipReviewed: false, filterReviewed: noneReviewed });
    const first = await feed.next();
    expect(first).not.toBeNull();
    if (first) feed.unshift(first);
    expect((await feed.next())?.mediaKey).toBe(items[0].mediaKey);
  });

  it('only buffers a bounded window of a large period', async () => {
    const many = Array.from({ length: 2000 }, (_, i) => photo(16 * DAY - i * 1000));
    const { api } = fakeApi(many, 250);
    const feed = new TimelineFeed(api, period, { includeArchived: false, skipReviewed: false, filterReviewed: noneReviewed });
    await feed.next();
    expect(feed.buffered).toBeLessThanOrEqual(250);
  });
});
