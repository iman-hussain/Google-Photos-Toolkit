import getFromStorage from '../utils/getFromStorage';
import saveToStorage from '../utils/saveToStorage';
import type { Granularity } from './period';
import type { DoneMap } from './status';

export type DeleteMode = 'bin' | 'album' | 'archive';

export interface SwipeSettings {
  deleteMode: DeleteMode;
  laterAlbum: string;
  deleteAlbum: string;
  includeArchived: boolean;
  skipReviewed: boolean;
  granularity: Granularity;
  /** Start of the last period opened, so the next visit picks up there. */
  anchor: number | null;
  /** Per period, the taken-timestamp to resume from. */
  cursors: Record<string, number>;
  /** Album title -> mediaKey, so albums are only looked up once. */
  albumKeys: Record<string, string>;
  /** Periods marked as sorted (by hand, or by finishing them). */
  done: DoneMap;
}

const STORAGE_KEY = 'swipe';

export const defaultSettings: SwipeSettings = {
  deleteMode: 'bin',
  laterAlbum: 'Sort later',
  deleteAlbum: 'To delete',
  includeArchived: false,
  skipReviewed: true,
  granularity: 'month',
  anchor: null,
  cursors: {},
  albumKeys: {},
  done: {},
};

let current: SwipeSettings | null = null;

export function getSettings(): SwipeSettings {
  current ??= { ...defaultSettings, ...(getFromStorage<Partial<SwipeSettings>>(STORAGE_KEY) ?? {}) };
  return current;
}

export function saveSettings(patch: Partial<SwipeSettings>): void {
  current = { ...getSettings(), ...patch };
  saveToStorage(STORAGE_KEY, current);
}
