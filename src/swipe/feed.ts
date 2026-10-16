// Streams a period of the timeline newest to oldest, one page at a time.
// Only a small window of items is held: the buffer is topped up when it runs
// low, items are reduced to the fields swipe mode needs, and already reviewed
// items are dropped before they reach memory.

import type Api from '../api/api';
import type { MediaItem } from '../types';
import type { Period } from './period';

export interface SwipeItem {
  mediaKey: string;
  dedupKey: string;
  thumb: string;
  timestamp: number;
  width?: number;
  height?: number;
  duration?: number;
  isFavorite: boolean;
  isArchived: boolean;
  isLivePhoto: boolean;
  location?: string;
}

export interface FeedOptions {
  includeArchived: boolean;
  skipReviewed: boolean;
  filterReviewed: (mediaKeys: string[]) => Promise<Set<string>>;
  /** Resume point: only items taken at or before this are fetched. */
  startAt?: number;
}

const PAGE_SIZE = 250;
const LOW_WATER = 40;

function compact(item: MediaItem): SwipeItem | null {
  if (!item.mediaKey || !item.dedupKey || !item.thumb) return null;
  // Partner/shared items can't be binned or favourited from here
  if (item.isOwned === false) return null;
  return {
    mediaKey: item.mediaKey,
    dedupKey: item.dedupKey,
    thumb: item.thumb,
    timestamp: item.timestamp,
    width: item.resWidth,
    height: item.resHeight,
    duration: item.duration,
    isFavorite: Boolean(item.isFavorite),
    isArchived: Boolean(item.isArchived),
    isLivePhoto: Boolean(item.isLivePhoto),
    location: item.geoLocation?.name,
  };
}

export default class TimelineFeed {
  private buffer: SwipeItem[] = [];
  private nextTimestamp: number | null;
  private nextPageId: string | null = null;
  private exhausted = false;
  private loading: Promise<void> | null = null;
  private lastPageKeys = new Set<string>();
  newestSeen = -Infinity;
  fetchedPages = 0;
  skippedReviewed = 0;

  constructor(
    private api: Api,
    readonly period: Period,
    private options: FeedOptions
  ) {
    const end = Number.isFinite(period.end) ? period.end - 1 : null;
    const start = options.startAt;
    this.nextTimestamp = start !== undefined && (end === null || start < end) ? start : end;
  }

  get isExhausted(): boolean {
    return this.exhausted && this.buffer.length === 0;
  }

  get buffered(): number {
    return this.buffer.length;
  }

  /** Next item to show, or null once the period is finished. */
  async next(): Promise<SwipeItem | null> {
    while (this.buffer.length === 0 && !this.exhausted) await this.fill();
    const item = this.buffer.shift() ?? null;
    if (this.buffer.length < LOW_WATER && !this.exhausted) void this.fill();
    return item;
  }

  /** Items queued after the current one, for image preloading. */
  peek(count: number): SwipeItem[] {
    return this.buffer.slice(0, count);
  }

  /** Put an item back at the front, used by undo. */
  unshift(item: SwipeItem): void {
    this.buffer.unshift(item);
  }

  private fill(): Promise<void> {
    this.loading ??= this.fetchPage().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async fetchPage(): Promise<void> {
    const source = this.options.includeArchived ? 'both' : 'library';
    const page = await this.api.getItemsByTakenDate(this.nextTimestamp, source, this.nextPageId, PAGE_SIZE);
    this.fetchedPages++;
    this.nextPageId = page?.nextPageId ?? null;
    const last = page?.lastItemTimestamp;
    this.nextTimestamp = typeof last === 'number' && Number.isFinite(last) ? last - 1 : null;

    // Same stop condition GPTK core uses for date-bounded timeline scans
    const more = Boolean(this.nextPageId && !this.nextTimestamp) || Boolean(this.nextTimestamp && this.nextTimestamp > this.period.start);
    this.exhausted = !more;

    const pageKeys = new Set<string>();
    let candidates: SwipeItem[] = [];
    for (const raw of page?.items ?? []) {
      if (raw.timestamp < this.period.start || raw.timestamp >= this.period.end) continue;
      const item = compact(raw);
      if (!item || this.lastPageKeys.has(item.mediaKey) || pageKeys.has(item.mediaKey)) continue;
      pageKeys.add(item.mediaKey);
      if (item.timestamp > this.newestSeen) this.newestSeen = item.timestamp;
      candidates.push(item);
    }
    this.lastPageKeys = pageKeys;

    if (this.options.skipReviewed && candidates.length > 0) {
      const reviewed = await this.options.filterReviewed(candidates.map((c) => c.mediaKey));
      this.skippedReviewed += reviewed.size;
      candidates = candidates.filter((c) => !reviewed.has(c.mediaKey));
    }
    this.buffer.push(...candidates);
  }
}
