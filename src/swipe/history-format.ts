// Log entry shape plus (de)serialisation. Kept free of DOM/IndexedDB so it
// can be unit tested and shared by export, import and revert.

export type SwipeAction = 'trash' | 'archive' | 'mark-delete' | 'keep' | 'favourite' | 'later';
export type LogStatus = 'pending' | 'done' | 'failed' | 'cancelled' | 'reverted';

export interface LogEntry {
  id?: number;
  at: number; // when the action was taken (ms)
  session: string;
  action: SwipeAction;
  mediaKey: string;
  dedupKey: string;
  taken: number; // photo's taken timestamp (ms)
  albumMediaKey?: string;
  albumTitle?: string;
  wasFavorite?: boolean;
  wasArchived?: boolean;
  status: LogStatus;
  error?: string;
}

export const LOG_FORMAT = 'gptk-swipe-log';
export const LOG_VERSION = 1;

export interface LogHeader {
  format: typeof LOG_FORMAT;
  version: number;
  account: string;
  exportedAt: string;
}

export const ACTION_LABELS: Record<SwipeAction, string> = {
  trash: 'Moved to Bin',
  archive: 'Archived',
  'mark-delete': 'Added to delete album',
  keep: 'Kept',
  favourite: 'Favourited',
  later: 'Added to sort-later album',
};

const ACTIONS = new Set<string>(Object.keys(ACTION_LABELS));

export function headerLine(account: string): string {
  const header: LogHeader = { format: LOG_FORMAT, version: LOG_VERSION, account, exportedAt: new Date().toISOString() };
  return JSON.stringify(header);
}

export function entryLine(entry: LogEntry): string {
  return JSON.stringify(entry);
}

export type ParsedLine = { kind: 'header'; header: LogHeader } | { kind: 'entry'; entry: LogEntry } | { kind: 'skip' };

export function parseLine(line: string): ParsedLine {
  const trimmed = line.trim();
  if (!trimmed) return { kind: 'skip' };
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return { kind: 'skip' };
  }
  if (!data || typeof data !== 'object') return { kind: 'skip' };
  const obj = data as Record<string, unknown>;
  if (obj.format === LOG_FORMAT) return { kind: 'header', header: obj as unknown as LogHeader };
  if (typeof obj.action !== 'string' || !ACTIONS.has(obj.action)) return { kind: 'skip' };
  if (typeof obj.dedupKey !== 'string' || typeof obj.mediaKey !== 'string') return { kind: 'skip' };
  return { kind: 'entry', entry: obj as unknown as LogEntry };
}

const CSV_COLUMNS: (keyof LogEntry)[] = [
  'id', 'at', 'session', 'action', 'status', 'mediaKey', 'dedupKey', 'taken',
  'albumTitle', 'albumMediaKey', 'wasFavorite', 'wasArchived', 'error',
];

export function csvHeader(): string {
  return [...CSV_COLUMNS, 'url'].join(',');
}

export function csvLine(entry: LogEntry): string {
  const cells = CSV_COLUMNS.map((col) => {
    const value = entry[col];
    if (value === undefined || value === null) return '';
    const text = (col === 'at' || col === 'taken') && typeof value === 'number' ? new Date(value).toISOString() : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  });
  cells.push(`https://photos.google.com/photo/${entry.mediaKey}`);
  return cells.join(',');
}

/**
 * What a revert of a set of entries needs to do, grouped so each group can
 * be sent in batches. Entries already undone are marked 'reverted' so they
 * are skipped, and dedupePlan collapses repeats of the same item.
 */
export interface RevertPlan {
  restoreFromTrash: string[]; // dedupKeys
  unarchive: string[]; // dedupKeys
  unfavourite: string[]; // dedupKeys
  removeFromAlbum: Map<string, Set<string>>; // albumMediaKey -> dedupKeys
  unmarkReviewed: string[]; // mediaKeys
  entryIds: number[]; // local log ids to mark reverted
  total: number;
}

export function emptyPlan(): RevertPlan {
  return { restoreFromTrash: [], unarchive: [], unfavourite: [], removeFromAlbum: new Map(), unmarkReviewed: [], entryIds: [], total: 0 };
}

export function addToPlan(plan: RevertPlan, entry: LogEntry): void {
  if (entry.status !== 'done') return;
  plan.total++;
  if (entry.id !== undefined) plan.entryIds.push(entry.id);
  plan.unmarkReviewed.push(entry.mediaKey);
  switch (entry.action) {
    case 'trash':
      plan.restoreFromTrash.push(entry.dedupKey);
      break;
    case 'archive':
      if (!entry.wasArchived) plan.unarchive.push(entry.dedupKey);
      break;
    case 'favourite':
      if (!entry.wasFavorite) plan.unfavourite.push(entry.dedupKey);
      break;
    case 'later':
    case 'mark-delete': {
      if (!entry.albumMediaKey) break;
      let set = plan.removeFromAlbum.get(entry.albumMediaKey);
      if (!set) {
        set = new Set();
        plan.removeFromAlbum.set(entry.albumMediaKey, set);
      }
      set.add(entry.dedupKey);
      break;
    }
    case 'keep':
      break;
  }
}

export function dedupePlan(plan: RevertPlan): RevertPlan {
  return {
    ...plan,
    restoreFromTrash: [...new Set(plan.restoreFromTrash)],
    unarchive: [...new Set(plan.unarchive)],
    unfavourite: [...new Set(plan.unfavourite)],
    unmarkReviewed: [...new Set(plan.unmarkReviewed)],
  };
}
