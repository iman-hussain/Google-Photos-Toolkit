// @vitest-environment jsdom
// Drives the real swipe UI (keys, undo, albums, bulk revert) against a fake
// Google Photos API, with IndexedDB provided by fake-indexeddb.
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { MediaItem } from '../src/types';

const now = Date.now();

const library: MediaItem[] = Array.from({ length: 8 }, (_, i) => ({
  mediaKey: `mk${i}`,
  dedupKey: `dk${i}`,
  timestamp: now - (i + 1) * 60_000,
  creationTimestamp: now,
  thumb: `https://photos.example/t${i}`,
  isFavorite: false,
  isArchived: false,
}));

const albums = new Map<string, { title: string; items: string[] }>();
const calls: Array<[string, ...unknown[]]> = [];

vi.mock('../src/api/api', () => ({
  default: class FakeApi {
    getItemsByTakenDate(timestamp: number | null): Promise<unknown> {
      const items = library.filter((i) => timestamp === null || i.timestamp <= timestamp);
      return Promise.resolve({ items, nextPageId: undefined, lastItemTimestamp: NaN });
    }
    moveItemsToTrash(keys: string[]): Promise<unknown> { calls.push(['trash', keys]); return Promise.resolve([]); }
    restoreFromTrash(keys: string[]): Promise<unknown> { calls.push(['restore', keys]); return Promise.resolve([]); }
    setFavorite(keys: string[], on: boolean): Promise<unknown> { calls.push(['favourite', keys, on]); return Promise.resolve([]); }
    setArchive(keys: string[], on: boolean): Promise<unknown> { calls.push(['archive', keys, on]); return Promise.resolve([]); }
    getAlbums(): Promise<unknown> {
      return Promise.resolve({ items: [...albums].map(([mediaKey, a]) => ({ mediaKey, title: a.title, isShared: false })) });
    }
    createAlbum(title: string): Promise<string> {
      const key = `album-${albums.size + 1}`;
      albums.set(key, { title, items: [] });
      calls.push(['createAlbum', title]);
      return Promise.resolve(key);
    }
    addItemsToAlbum(mediaKeys: string[], albumKey: string): Promise<unknown> {
      calls.push(['addToAlbum', mediaKeys, albumKey]);
      albums.get(albumKey)?.items.push(...mediaKeys);
      return Promise.resolve([]);
    }
    getAlbumPage(albumKey: string): Promise<unknown> {
      // Album items carry an album-scoped mediaKey but the library dedupKey
      const items = (albums.get(albumKey)?.items ?? []).map((mk) => ({ mediaKey: `album-item-${mk}`, dedupKey: mk.replace('mk', 'dk') }));
      return Promise.resolve({ items, nextPageId: undefined });
    }
    removeItemsFromAlbum(keys: string[]): Promise<unknown> { calls.push(['removeFromAlbum', keys]); return Promise.resolve([]); }
  },
}));

const settle = (ms = 400): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const press = (key: string): void => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
};
const shown = (): string => (document.getElementById('gs-img') as HTMLImageElement).src;
const callsOf = (name: string): unknown[][] => calls.filter((c) => c[0] === name).map((c) => c.slice(1));

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.unsafeWindow = Object.assign(window, { WIZ_global_data: { oPEP7c: 'test-account', SNlM0e: 'at', FdrFJe: 'sid', cfb2h: 'bl', eptZe: '/' } });
  g.GM_registerMenuCommand = (): void => undefined;
  window.HTMLMediaElement.prototype.play = (): Promise<void> => Promise.resolve();
  window.HTMLMediaElement.prototype.pause = (): void => undefined;
  window.HTMLMediaElement.prototype.load = (): void => undefined;
  window.confirm = (): boolean => true;
  const { default: initSwipe, openSwipe } = await import('../src/swipe/swipe-ui');
  initSwipe();
  openSwipe();
  await settle();
});

describe('swipe UI', () => {
  it('opens on the newest photo of the current month', () => {
    expect(document.getElementById('gptk-swipe')?.hidden).toBe(false);
    expect(shown()).toContain('/t0=w');
  });

  it('bins on left and moves to the next photo', async () => {
    press('ArrowLeft');
    await settle();
    expect(callsOf('trash')).toEqual([[['dk0']]]);
    expect(shown()).toContain('/t1=');
  });

  it('undo restores from Bin and shows the photo again', async () => {
    press('z');
    await settle();
    expect(callsOf('restore')).toEqual([[['dk0']]]);
    expect(shown()).toContain('/t0=');
  });

  it('keeps on right without touching Google Photos', async () => {
    const before = calls.length;
    press('ArrowRight');
    await settle();
    expect(calls.length).toBe(before);
    expect(shown()).toContain('/t1=');
  });

  it('sort later creates the album once and adds to it', async () => {
    press('ArrowDown');
    await settle();
    press('s');
    await settle();
    expect(callsOf('createAlbum')).toEqual([['Sort later']]);
    expect(callsOf('addToAlbum')).toEqual([[['mk1'], 'album-1'], [['mk2'], 'album-1']]);
  });

  it('favourites on up', async () => {
    press('ArrowUp');
    await settle();
    expect(callsOf('favourite')).toEqual([[['dk3'], true]]);
  });

  it('respects the "don\'t bin" delete setting', async () => {
    const radio = document.querySelector<HTMLInputElement>('input[name="gs-delete-mode"][value="album"]');
    if (!radio) throw new Error('missing radio');
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    press('a');
    await settle();
    expect(document.getElementById('gs-delete-label')?.textContent).toBe('To delete');
    expect(callsOf('trash')).toHaveLength(1);
    expect(callsOf('createAlbum')).toContainEqual(['To delete']);
  });

  it('bulk reverts everything from the local log', async () => {
    calls.length = 0;
    (document.getElementById('gs-revert-run') as HTMLButtonElement).click();
    await settle(800);
    expect(callsOf('favourite')).toEqual([[['dk3'], false]]);
    // The first bin was already undone, so nothing is left to restore
    expect(callsOf('restore')).toEqual([]);
    const removed = callsOf('removeFromAlbum').flatMap((c) => c[0] as string[]).sort();
    expect(removed).toEqual(['album-item-mk1', 'album-item-mk2', 'album-item-mk4']);
    expect(document.getElementById('gs-revert-status')?.textContent).toMatch(/Reverted \d+ actions/);
  });

  it('closes on Escape', () => {
    press('Escape');
    expect(document.getElementById('gptk-swipe')?.hidden).toBe(true);
  });
});

