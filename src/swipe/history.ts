// Export, import and bulk revert of the swipe log. Both directions stream:
// export builds the file from bounded IndexedDB batches, import reads the
// file line by line, so neither holds the whole log as one string.

import type SwipeDb from './db';
import {
  addToPlan,
  csvHeader,
  csvLine,
  emptyPlan,
  entryLine,
  headerLine,
  parseLine,
  type LogEntry,
  type LogHeader,
  type RevertPlan,
  type SwipeAction,
} from './history-format';

function download(fileName: string, parts: BlobPart[], type: string): void {
  const url = URL.createObjectURL(new Blob(parts, { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

export async function exportLog(db: SwipeDb, account: string, format: 'ndjson' | 'csv'): Promise<number> {
  // Blob parts are joined lazily by the browser, so one part per batch keeps
  // peak memory to roughly the size of the finished file.
  const parts: BlobPart[] = [format === 'csv' ? csvHeader() + '\n' : headerLine(account) + '\n'];
  let count = 0;
  await db.iterateLog((batch) => {
    const lines = batch.map((entry) => (format === 'csv' ? csvLine(entry) : entryLine(entry)));
    parts.push(lines.join('\n') + '\n');
    count += batch.length;
  });
  const ext = format === 'csv' ? 'csv' : 'ndjson';
  download(`gptk-swipe-log-${stamp()}.${ext}`, parts, format === 'csv' ? 'text/csv' : 'application/x-ndjson');
  return count;
}

export interface RevertFilter {
  actions: Set<SwipeAction>;
  sinceMs: number;
  session?: string;
}

function matches(entry: LogEntry, filter: RevertFilter): boolean {
  if (!filter.actions.has(entry.action)) return false;
  if (entry.at < filter.sinceMs) return false;
  if (filter.session && entry.session !== filter.session) return false;
  return true;
}

export interface LogSummary {
  counts: Partial<Record<SwipeAction, number>>;
  sessions: Map<string, { first: number; last: number; count: number }>;
  header?: LogHeader;
}

function summarise(summary: LogSummary, entry: LogEntry): void {
  if (entry.status !== 'done') return;
  summary.counts[entry.action] = (summary.counts[entry.action] ?? 0) + 1;
  const s = summary.sessions.get(entry.session);
  if (s) {
    s.count++;
    s.last = Math.max(s.last, entry.at);
    s.first = Math.min(s.first, entry.at);
  } else {
    summary.sessions.set(entry.session, { first: entry.at, last: entry.at, count: 1 });
  }
}

export async function summariseLocal(db: SwipeDb): Promise<LogSummary> {
  const summary: LogSummary = { counts: {}, sessions: new Map() };
  await db.iterateLog((batch) => batch.forEach((e) => summarise(summary, e)));
  return summary;
}

export async function planLocal(db: SwipeDb, filter: RevertFilter): Promise<RevertPlan> {
  const plan = emptyPlan();
  await db.iterateLog((batch) => {
    for (const entry of batch) if (matches(entry, filter)) addToPlan(plan, entry);
  });
  return plan;
}

/** Read an exported .ndjson file one line at a time. */
async function readLines(file: File, onLine: (line: string) => void): Promise<void> {
  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
  let carry = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = carry + value;
    const lines = chunk.split('\n');
    carry = lines.pop() ?? '';
    for (const line of lines) onLine(line);
  }
  if (carry) onLine(carry);
}

export async function summariseFile(file: File): Promise<LogSummary> {
  const summary: LogSummary = { counts: {}, sessions: new Map() };
  await readLines(file, (line) => {
    const parsed = parseLine(line);
    if (parsed.kind === 'header') summary.header = parsed.header;
    else if (parsed.kind === 'entry') summarise(summary, parsed.entry);
  });
  return summary;
}

export async function planFile(file: File, filter: RevertFilter): Promise<RevertPlan> {
  const plan = emptyPlan();
  await readLines(file, (line) => {
    const parsed = parseLine(line);
    if (parsed.kind !== 'entry' || !matches(parsed.entry, filter)) return;
    // Ids from a file belong to whichever browser exported it
    addToPlan(plan, { ...parsed.entry, id: undefined });
  });
  return plan;
}
