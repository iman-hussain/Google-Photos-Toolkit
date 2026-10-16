import { describe, it, expect } from 'vitest';
import { addToPlan, csvLine, dedupePlan, emptyPlan, entryLine, headerLine, parseLine, type LogEntry } from '../src/swipe/history-format';

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    id: 1,
    at: 1700000000000,
    session: 's1',
    action: 'trash',
    mediaKey: 'm1',
    dedupKey: 'd1',
    taken: 1600000000000,
    status: 'done',
    ...overrides,
  };
}

describe('parseLine', () => {
  it('reads back what entryLine writes', () => {
    const e = entry({ action: 'later', albumMediaKey: 'a1', albumTitle: 'Sort later' });
    expect(parseLine(entryLine(e))).toEqual({ kind: 'entry', entry: e });
  });

  it('recognises the header', () => {
    const parsed = parseLine(headerLine('acc'));
    expect(parsed.kind).toBe('header');
    if (parsed.kind === 'header') expect(parsed.header.account).toBe('acc');
  });

  it('skips blank, broken and foreign lines', () => {
    expect(parseLine('').kind).toBe('skip');
    expect(parseLine('{not json').kind).toBe('skip');
    expect(parseLine(JSON.stringify({ action: 'explode', mediaKey: 'm', dedupKey: 'd' })).kind).toBe('skip');
    expect(parseLine(JSON.stringify({ action: 'trash' })).kind).toBe('skip');
  });
});

describe('revert plan', () => {
  it('routes each action to the right undo', () => {
    const plan = emptyPlan();
    addToPlan(plan, entry({ id: 1, action: 'trash', dedupKey: 'd1', mediaKey: 'm1' }));
    addToPlan(plan, entry({ id: 2, action: 'archive', dedupKey: 'd2', mediaKey: 'm2', wasArchived: false }));
    addToPlan(plan, entry({ id: 3, action: 'favourite', dedupKey: 'd3', mediaKey: 'm3', wasFavorite: false }));
    addToPlan(plan, entry({ id: 4, action: 'later', dedupKey: 'd4', mediaKey: 'm4', albumMediaKey: 'A' }));
    addToPlan(plan, entry({ id: 5, action: 'mark-delete', dedupKey: 'd5', mediaKey: 'm5', albumMediaKey: 'B' }));
    addToPlan(plan, entry({ id: 6, action: 'keep', dedupKey: 'd6', mediaKey: 'm6' }));

    expect(plan.restoreFromTrash).toEqual(['d1']);
    expect(plan.unarchive).toEqual(['d2']);
    expect(plan.unfavourite).toEqual(['d3']);
    expect([...(plan.removeFromAlbum.get('A') ?? [])]).toEqual(['d4']);
    expect([...(plan.removeFromAlbum.get('B') ?? [])]).toEqual(['d5']);
    expect(plan.unmarkReviewed).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    expect(plan.entryIds).toEqual([1, 2, 3, 4, 5, 6]);
    expect(plan.total).toBe(6);
  });

  it('leaves alone state that was already there before the swipe', () => {
    const plan = emptyPlan();
    addToPlan(plan, entry({ action: 'favourite', wasFavorite: true }));
    addToPlan(plan, entry({ action: 'archive', wasArchived: true }));
    expect(plan.unfavourite).toEqual([]);
    expect(plan.unarchive).toEqual([]);
  });

  it('ignores entries that never landed or were already undone', () => {
    const plan = emptyPlan();
    for (const status of ['pending', 'failed', 'cancelled', 'reverted'] as const) addToPlan(plan, entry({ status }));
    expect(plan.total).toBe(0);
    expect(plan.restoreFromTrash).toEqual([]);
  });

  it('dedupes repeated items', () => {
    const plan = emptyPlan();
    addToPlan(plan, entry({ id: 1 }));
    addToPlan(plan, entry({ id: 2 }));
    const deduped = dedupePlan(plan);
    expect(deduped.restoreFromTrash).toEqual(['d1']);
    expect(deduped.unmarkReviewed).toEqual(['m1']);
    expect(deduped.entryIds).toEqual([1, 2]);
  });
});

describe('csvLine', () => {
  it('quotes awkward values and adds a link', () => {
    const line = csvLine(entry({ albumTitle: 'Sort, "later"' }));
    expect(line).toContain('"Sort, ""later"""');
    expect(line).toContain('2023-11-14T22:13:20.000Z');
    expect(line.endsWith('https://photos.google.com/photo/m1')).toBe(true);
  });
});
