// IndexedDB storage for swipe mode. Everything that scales with library size
// (reviewed marks, the action log) lives here rather than in memory or
// localStorage, so a 250k item library costs nothing until it is queried.

import type { LogEntry, SwipeAction } from './history-format';

export interface ReviewedRecord {
  mediaKey: string;
  dedupKey: string;
  decision: SwipeAction;
  at: number;
  taken: number;
}

const DB_VERSION = 2;
const REVIEWED = 'reviewed';
const LOG = 'log';

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = (): void => resolve();
    tx.onerror = (): void => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = (): void => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export default class SwipeDb {
  private dbPromise: Promise<IDBDatabase>;

  constructor(account: string) {
    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(`gptk-swipe-${account}`, DB_VERSION);
      request.onupgradeneeded = (): void => {
        const db = request.result;
        const upgrade = request.transaction;
        const reviewed = upgrade && db.objectStoreNames.contains(REVIEWED)
          ? upgrade.objectStore(REVIEWED)
          : db.createObjectStore(REVIEWED, { keyPath: 'mediaKey' });
        // Lets a period's reviewed marks be cleared without touching the network
        if (!reviewed.indexNames.contains('taken')) reviewed.createIndex('taken', 'taken');
        if (!db.objectStoreNames.contains(LOG)) {
          const log = db.createObjectStore(LOG, { keyPath: 'id', autoIncrement: true });
          log.createIndex('at', 'at');
        }
      };
      request.onsuccess = (): void => resolve(request.result);
      request.onerror = (): void => reject(request.error ?? new Error('Could not open IndexedDB'));
    });
  }

  private async store(name: string, mode: IDBTransactionMode): Promise<{ tx: IDBTransaction; store: IDBObjectStore }> {
    const db = await this.dbPromise;
    const tx = db.transaction(name, mode);
    return { tx, store: tx.objectStore(name) };
  }

  // ─── reviewed ────────────────────────────────────────────────────────

  async markReviewed(record: ReviewedRecord): Promise<void> {
    const { tx, store } = await this.store(REVIEWED, 'readwrite');
    store.put(record);
    await done(tx);
  }

  async unmarkReviewed(mediaKeys: string[]): Promise<void> {
    if (mediaKeys.length === 0) return;
    const { tx, store } = await this.store(REVIEWED, 'readwrite');
    for (const key of mediaKeys) store.delete(key);
    await done(tx);
  }

  /** Returns the subset of keys already reviewed, in one read transaction. */
  async filterReviewed(mediaKeys: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    if (mediaKeys.length === 0) return found;
    const { tx, store } = await this.store(REVIEWED, 'readonly');
    for (const key of mediaKeys) {
      const request = store.getKey(key);
      request.onsuccess = (): void => {
        if (request.result !== undefined) found.add(key);
      };
    }
    await done(tx);
    return found;
  }

  /** Forget reviewed marks for items taken in [start, end). */
  async unmarkReviewedTaken(start: number, end: number): Promise<number> {
    const { tx, store } = await this.store(REVIEWED, 'readwrite');
    let range: IDBKeyRange | null = null;
    if (Number.isFinite(start) && Number.isFinite(end)) range = IDBKeyRange.bound(start, end, false, true);
    else if (Number.isFinite(start)) range = IDBKeyRange.lowerBound(start);
    else if (Number.isFinite(end)) range = IDBKeyRange.upperBound(end, true);
    let count = 0;
    const request = store.index('taken').openKeyCursor(range);
    request.onsuccess = (): void => {
      const cursor = request.result;
      if (!cursor) return;
      store.delete(cursor.primaryKey);
      count++;
      cursor.continue();
    };
    await done(tx);
    return count;
  }

  async countReviewed(): Promise<number> {
    const { store } = await this.store(REVIEWED, 'readonly');
    return promisify(store.count());
  }

  async clearReviewed(): Promise<void> {
    const { tx, store } = await this.store(REVIEWED, 'readwrite');
    store.clear();
    await done(tx);
  }

  // ─── log ─────────────────────────────────────────────────────────────

  async addLog(entry: LogEntry): Promise<number> {
    const { store } = await this.store(LOG, 'readwrite');
    return (await promisify(store.add(entry))) as number;
  }

  async updateLog(id: number, patch: Partial<LogEntry>): Promise<void> {
    const { tx, store } = await this.store(LOG, 'readwrite');
    const request = store.get(id);
    request.onsuccess = (): void => {
      const current = request.result as LogEntry | undefined;
      if (current) store.put({ ...current, ...patch, id });
    };
    await done(tx);
  }

  async setLogStatus(ids: number[], status: LogEntry['status']): Promise<void> {
    if (ids.length === 0) return;
    const { tx, store } = await this.store(LOG, 'readwrite');
    for (const id of ids) {
      const request = store.get(id);
      request.onsuccess = (): void => {
        const current = request.result as LogEntry | undefined;
        if (current) store.put({ ...current, status });
      };
    }
    await done(tx);
  }

  async countLog(): Promise<number> {
    const { store } = await this.store(LOG, 'readonly');
    return promisify(store.count());
  }

  async clearLog(): Promise<void> {
    const { tx, store } = await this.store(LOG, 'readwrite');
    store.clear();
    await done(tx);
  }

  /**
   * Walk the log oldest first in bounded batches. Each batch is read in its
   * own transaction so the callback can be async (and slow) without the
   * transaction auto-committing underneath it.
   */
  async iterateLog(onBatch: (entries: LogEntry[]) => Promise<void> | void, sinceMs = -Infinity, batchSize = 1000): Promise<void> {
    let lastId = 0;
    for (;;) {
      const { store } = await this.store(LOG, 'readonly');
      const range = IDBKeyRange.lowerBound(lastId, true);
      const batch = (await promisify(store.getAll(range, batchSize))) as LogEntry[];
      if (batch.length === 0) return;
      lastId = batch[batch.length - 1].id ?? lastId;
      const filtered = Number.isFinite(sinceMs) ? batch.filter((e) => e.at >= sinceMs) : batch;
      if (filtered.length > 0) await onBatch(filtered);
      if (batch.length < batchSize) return;
    }
  }
}
