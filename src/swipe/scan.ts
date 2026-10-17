// One-off walk of the whole timeline that only keeps a count per day, so the
// period picker can show how many photos each day/week/month/year holds.
// Memory stays at one page plus a few thousand small numbers, whatever the
// library size.

import type Api from '../api/api';
import { dayKey, type LibraryCounts } from './status';

const PAGE_SIZE = 500;

export interface ScanProgress {
  items: number;
  pages: number;
  oldest: number | null;
}

export async function scanLibrary(
  api: Api,
  includeArchived: boolean,
  onProgress: (progress: ScanProgress) => void,
  isCancelled: () => boolean
): Promise<LibraryCounts | null> {
  const days: Record<string, number> = {};
  let total = 0;
  let pages = 0;
  let oldest: number | null = null;
  let pageId: string | null = null;
  let timestamp: number | null = null;

  for (;;) {
    if (isCancelled()) return null;
    const page = await api.getItemsByTakenDate(timestamp, includeArchived ? 'both' : 'library', pageId, PAGE_SIZE);
    pages++;
    for (const item of page?.items ?? []) {
      // Same items the swipe feed would show
      if (item.isOwned === false || !item.thumb) continue;
      const key = dayKey(item.timestamp);
      days[key] = (days[key] ?? 0) + 1;
      total++;
      if (oldest === null || item.timestamp < oldest) oldest = item.timestamp;
    }
    onProgress({ items: total, pages, oldest });

    pageId = page?.nextPageId ?? null;
    const last = page?.lastItemTimestamp;
    const hasLast = typeof last === 'number' && Number.isFinite(last);
    if (!pageId && !(hasLast && page?.items?.length)) break;
    timestamp = hasLast ? last - 1 : null;
  }

  return { days, total, scannedAt: Date.now(), includeArchived };
}
