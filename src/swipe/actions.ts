// Applies swipe decisions to Google Photos and records them. API calls run in
// a small background queue so swiping never waits on the network; every
// action is logged first, so a crash or closed tab still leaves a trail.

import type Api from '../api/api';
import log from '../ui/logic/log';
import splitArrayIntoChunks from '../utils/splitArrayIntoChunks';
import type SwipeDb from './db';
import type { SwipeItem } from './feed';
import { addToPlan, dedupePlan, emptyPlan, type LogEntry, type RevertPlan, type SwipeAction } from './history-format';
import type { SwipeSettings } from './settings';

const BATCH_SIZE = 250;
const MAX_CONCURRENT = 2;

interface Job {
  run: () => Promise<void>;
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  promise: Promise<void>;
  start: () => void;
}

export interface ActionRecord {
  item: SwipeItem;
  entry: LogEntry;
  job: Job | null;
}

export default class SwipeActions {
  private queue: Job[] = [];
  private running = 0;
  private albumLookups = new Map<string, Promise<string>>();
  readonly session = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  failures = 0;
  onChange: () => void = () => undefined;

  constructor(
    private api: Api,
    private db: SwipeDb,
    private settings: () => SwipeSettings,
    private saveSettings: (patch: Partial<SwipeSettings>) => void
  ) {}

  get pending(): number {
    return this.queue.length + this.running;
  }

  /** The action a left swipe maps to under the current delete setting. */
  deleteAction(): SwipeAction {
    const mode = this.settings().deleteMode;
    if (mode === 'album') return 'mark-delete';
    if (mode === 'archive') return 'archive';
    return 'trash';
  }

  async perform(item: SwipeItem, action: SwipeAction): Promise<ActionRecord> {
    const settings = this.settings();
    const entry: LogEntry = {
      at: Date.now(),
      session: this.session,
      action,
      mediaKey: item.mediaKey,
      dedupKey: item.dedupKey,
      taken: item.timestamp,
      wasFavorite: item.isFavorite,
      wasArchived: item.isArchived,
      status: 'pending',
    };
    if (action === 'later') entry.albumTitle = settings.laterAlbum;
    if (action === 'mark-delete') entry.albumTitle = settings.deleteAlbum;

    const needsApi =
      action === 'trash' || action === 'later' || action === 'mark-delete' ||
      (action === 'archive' && !item.isArchived) ||
      (action === 'favourite' && !item.isFavorite);

    if (!needsApi) entry.status = 'done';
    const id = await this.db.addLog(entry);
    entry.id = id;
    await this.db.markReviewed({ mediaKey: item.mediaKey, dedupKey: item.dedupKey, decision: action, at: entry.at });
    if (!needsApi) return { item, entry, job: null };

    const job = this.enqueue(async () => {
      try {
        await this.apply(entry);
        entry.status = 'done';
        await this.db.updateLog(id, { status: 'done', albumMediaKey: entry.albumMediaKey });
      } catch (error) {
        this.failures++;
        entry.status = 'failed';
        entry.error = error instanceof Error ? error.message : String(error);
        log(`Swipe: ${action} failed for ${item.mediaKey}: ${entry.error}`, 'error');
        await this.db.updateLog(id, { status: 'failed', error: entry.error });
        // Let it come round again next time rather than silently skipping it
        await this.db.unmarkReviewed([item.mediaKey]);
        throw error;
      }
    });
    return { item, entry, job };
  }

  /** Reverse one action. Waits for it to land first if it is in flight. */
  async undo(record: ActionRecord): Promise<void> {
    const { entry, job } = record;
    if (job?.state === 'queued') {
      job.state = 'cancelled';
      this.queue = this.queue.filter((j) => j !== job);
      entry.status = 'cancelled';
      if (entry.id !== undefined) await this.db.updateLog(entry.id, { status: 'cancelled' });
      await this.db.unmarkReviewed([entry.mediaKey]);
      this.onChange();
      return;
    }
    if (job) await job.promise.catch(() => undefined);
    if (entry.status === 'done') {
      const plan = emptyPlan();
      addToPlan(plan, entry);
      await this.revert(plan);
    } else {
      await this.db.unmarkReviewed([entry.mediaKey]);
    }
    entry.status = 'reverted';
  }

  private async apply(entry: LogEntry): Promise<void> {
    switch (entry.action) {
      case 'trash':
        await this.api.moveItemsToTrash([entry.dedupKey]);
        break;
      case 'archive':
        await this.api.setArchive([entry.dedupKey], true);
        break;
      case 'favourite':
        await this.api.setFavorite([entry.dedupKey], true);
        break;
      case 'later':
      case 'mark-delete': {
        const title = entry.albumTitle;
        if (!title) throw new Error('No album name set');
        entry.albumMediaKey = await this.resolveAlbum(title);
        try {
          await this.api.addItemsToAlbum([entry.mediaKey], entry.albumMediaKey);
        } catch (error) {
          // The cached album may have been deleted; look it up again once
          this.forgetAlbum(title);
          entry.albumMediaKey = await this.resolveAlbum(title);
          await this.api.addItemsToAlbum([entry.mediaKey], entry.albumMediaKey).catch(() => {
            throw error;
          });
        }
        break;
      }
      case 'keep':
        break;
    }
  }

  private enqueue(run: () => Promise<void>): Job {
    let start!: () => void;
    const job: Job = {
      run,
      state: 'queued',
      start: () => start(),
      promise: new Promise<void>((resolve, reject) => {
        start = (): void => {
          job.state = 'running';
          this.running++;
          run()
            .then(() => {
              job.state = 'done';
              resolve();
            })
            .catch((error: unknown) => {
              job.state = 'failed';
              reject(error instanceof Error ? error : new Error(String(error)));
            })
            .finally(() => {
              this.running--;
              this.drain();
              this.onChange();
            });
        };
      }),
    };
    // Unhandled rejections are already logged by perform()
    job.promise.catch(() => undefined);
    this.queue.push(job);
    this.drain();
    this.onChange();
    return job;
  }

  private drain(): void {
    while (this.running < MAX_CONCURRENT) {
      const job = this.queue.shift();
      if (!job) return;
      job.start();
    }
  }

  /** Wait for everything queued so far to finish. */
  async flush(): Promise<void> {
    while (this.pending > 0) await new Promise((resolve) => setTimeout(resolve, 200));
  }

  // ─── albums ──────────────────────────────────────────────────────────

  private forgetAlbum(title: string): void {
    this.albumLookups.delete(title);
    const albumKeys = { ...this.settings().albumKeys };
    delete albumKeys[title];
    this.saveSettings({ albumKeys });
  }

  /** Find an owned, unshared album by exact title, creating it if needed. */
  resolveAlbum(title: string): Promise<string> {
    let lookup = this.albumLookups.get(title);
    if (!lookup) {
      lookup = this.findOrCreateAlbum(title);
      lookup.catch(() => this.albumLookups.delete(title));
      this.albumLookups.set(title, lookup);
    }
    return lookup;
  }

  private async findOrCreateAlbum(title: string): Promise<string> {
    const cached = this.settings().albumKeys[title];
    if (cached) return cached;

    let pageId: string | null = null;
    let found: string | undefined;
    do {
      const page = await this.api.getAlbums(pageId);
      found = page?.items?.find((album) => album.title === title && !album.isShared)?.mediaKey;
      pageId = page?.nextPageId ?? null;
    } while (!found && pageId);

    if (!found) {
      log(`Swipe: creating album "${title}"`);
      found = await this.api.createAlbum(title);
    }
    if (!found) throw new Error(`Could not find or create album "${title}"`);
    this.saveSettings({ albumKeys: { ...this.settings().albumKeys, [title]: found } });
    return found;
  }

  // ─── revert ──────────────────────────────────────────────────────────

  /**
   * Undo everything in a plan, in batches. Album removals need the
   * album-scoped item key, so the album is paged through until every
   * wanted item has been found.
   */
  async revert(input: RevertPlan, onProgress: (message: string) => void = () => undefined): Promise<void> {
    const plan = dedupePlan(input);

    const batched = async (keys: string[], label: string, call: (chunk: string[]) => Promise<unknown>): Promise<void> => {
      let doneCount = 0;
      for (const chunk of splitArrayIntoChunks(keys, BATCH_SIZE)) {
        await call(chunk);
        doneCount += chunk.length;
        onProgress(`${label}: ${doneCount} / ${keys.length}`);
      }
    };

    await batched(plan.restoreFromTrash, 'Restoring from Bin', (c) => this.api.restoreFromTrash(c));
    await batched(plan.unarchive, 'Unarchiving', (c) => this.api.setArchive(c, false));
    await batched(plan.unfavourite, 'Removing favourites', (c) => this.api.setFavorite(c, false));

    for (const [albumMediaKey, wanted] of plan.removeFromAlbum) {
      const albumItemKeys: string[] = [];
      let pageId: string | null = null;
      let remaining = wanted.size;
      do {
        const page = await this.api.getAlbumPage(albumMediaKey, pageId);
        for (const item of page?.items ?? []) {
          if (wanted.has(item.dedupKey)) {
            albumItemKeys.push(item.mediaKey);
            remaining--;
          }
        }
        pageId = page?.nextPageId ?? null;
        onProgress(`Scanning album for ${wanted.size} items, found ${albumItemKeys.length}`);
      } while (pageId && remaining > 0);
      await batched(albumItemKeys, 'Removing from album', (c) => this.api.removeItemsFromAlbum(c));
    }

    for (const chunk of splitArrayIntoChunks(plan.unmarkReviewed, BATCH_SIZE * 4)) await this.db.unmarkReviewed(chunk);
    for (const chunk of splitArrayIntoChunks(plan.entryIds, BATCH_SIZE * 4)) await this.db.setLogStatus(chunk, 'reverted');
    onProgress(`Reverted ${plan.total} actions`);
  }
}
