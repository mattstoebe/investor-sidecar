import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain JS module shipped as-is to the service worker, no types.
import { pushUndoEntry, applyUndoEntry, undoLast, UNDO_LIMIT } from '../public/scripts/house-storage.js';

/**
 * Undo entries are inverses, not snapshots of the whole array.
 *
 * A snapshot would make undo a time machine that also reverts unrelated houses -- a capture or
 * an enrichment that landed in between, which the user never asked to undo. And because the
 * log is a separate storage key whose write is not atomic with the houses write, an entry can
 * outlive the world it describes. Every one of them is validated before it is applied.
 */

const house = (over: Record<string, unknown> = {}) => ({
  source: 'redfin',
  propertyID: '100',
  address: '123 Main St',
  price: '$400,000',
  ...over
});

const editEntry = (over: Record<string, unknown> = {}) => ({
  op: 'edit', key: 'redfin:100', index: 0, label: 'Changed assumptions',
  localParams: { sliderValue: 2000 }, house: null, at: 1_000, ...over
});

const deleteEntry = (over: Record<string, unknown> = {}) => ({
  op: 'delete', key: 'redfin:100', index: 0, label: 'Removed 123 Main St',
  localParams: null, house: house({ localParams: { sliderValue: 2000 } }), at: 1_000, ...over
});

describe('pushUndoEntry', () => {
  it('records an entry without mutating the log it was given', () => {
    const log: unknown[] = [];
    const next = pushUndoEntry(log, editEntry());
    expect(log).toHaveLength(0);
    expect(next).toHaveLength(1);
  });

  it('caps the log rather than growing a journal', () => {
    let log: unknown[] = [];
    for (let i = 0; i < UNDO_LIMIT + 5; i++) {
      log = pushUndoEntry(log, deleteEntry({ key: `redfin:${i}` }), i * 10_000);
    }
    expect(log).toHaveLength(UNDO_LIMIT);
    // The oldest fall off the front, so the most recent mistakes stay undoable.
    expect((log[log.length - 1] as { key: string }).key).toBe(`redfin:${UNDO_LIMIT + 4}`);
  });

  /**
   * The card coalesces keystrokes into one write per edit session, but a slow typist still
   * produces several. Undo should step back over "the change I just made", not each flush.
   */
  it('folds a rapid second edit of the same house into one entry', () => {
    let log = pushUndoEntry([], editEntry({ localParams: { sliderValue: 2000 } }), 1_000);
    log = pushUndoEntry(log, editEntry({ localParams: { sliderValue: 2500 } }), 1_400);
    expect(log).toHaveLength(1);
    // The *older* before-state survives: undoing must return to before the whole session.
    expect(log[0].localParams).toEqual({ sliderValue: 2000 });
  });

  it('keeps a later edit separate once the window has passed', () => {
    let log = pushUndoEntry([], editEntry(), 1_000);
    log = pushUndoEntry(log, editEntry(), 60_000);
    expect(log).toHaveLength(2);
  });

  it('never folds edits to different houses together', () => {
    let log = pushUndoEntry([], editEntry({ key: 'redfin:100' }), 1_000);
    log = pushUndoEntry(log, editEntry({ key: 'redfin:200' }), 1_100);
    expect(log).toHaveLength(2);
  });

  it('never folds a delete into an edit', () => {
    let log = pushUndoEntry([], editEntry(), 1_000);
    log = pushUndoEntry(log, deleteEntry(), 1_100);
    expect(log).toHaveLength(2);
  });
});

describe('applyUndoEntry: edits', () => {
  it('puts back the parameters as they were', () => {
    const houses = [house({ localParams: { sliderValue: 3500 }, rev: 4 })];
    const result = applyUndoEntry(houses, editEntry({ localParams: { sliderValue: 2000 } }));
    expect(result.updatedHouses[0].localParams).toEqual({ sliderValue: 2000 });
  });

  /**
   * Only the fields the user owns. Restoring the whole record would clobber an enrichment that
   * landed after the edit -- the mirror of the race mergeEnrichmentIntoLatest exists to avoid.
   */
  it('leaves API-owned fields alone', () => {
    const houses = [house({ localParams: { sliderValue: 3500 }, apiTaxRate: 1.9, rentEstimate: { mid: 2400 } })];
    const result = applyUndoEntry(houses, editEntry());
    expect(result.updatedHouses[0].apiTaxRate).toBe(1.9);
    expect(result.updatedHouses[0].rentEstimate).toEqual({ mid: 2400 });
  });

  /** Stamped as a foreign write, or the card that made the edit would skip it as its own echo. */
  it('stamps the restore so a mounted card adopts it', () => {
    const houses = [house({ localParams: { sliderValue: 3500 }, rev: 4, lastWriter: 'card-1' })];
    const result = applyUndoEntry(houses, editEntry());
    expect(result.updatedHouses[0].rev).toBe(5);
    expect(result.updatedHouses[0].lastWriter).toBe('undo');
  });

  // Re-adding it would resurrect a record the user deleted on purpose.
  it('declines when the house is gone', () => {
    expect(applyUndoEntry([], editEntry())).toBeNull();
    expect(applyUndoEntry([house({ propertyID: '999' })], editEntry())).toBeNull();
  });

  it('does not mutate the array it was given', () => {
    const houses = [house({ localParams: { sliderValue: 3500 } })];
    const snapshot = JSON.stringify(houses);
    applyUndoEntry(houses, editEntry());
    expect(JSON.stringify(houses)).toBe(snapshot);
  });
});

describe('applyUndoEntry: deletes', () => {
  it('brings the whole record back', () => {
    const result = applyUndoEntry([], deleteEntry());
    expect(result.updatedHouses).toHaveLength(1);
    expect(result.updatedHouses[0].address).toBe('123 Main St');
    expect(result.updatedHouses[0].localParams).toEqual({ sliderValue: 2000 });
  });

  /** Undoing a deletion must not silently reorder the board. */
  it('restores it to the position it was removed from', () => {
    const others = [house({ propertyID: '1' }), house({ propertyID: '2' })];
    const result = applyUndoEntry(others, deleteEntry({ index: 1 }));
    expect(result.updatedHouses.map((h: { propertyID: string }) => h.propertyID)).toEqual(['1', '100', '2']);
  });

  it('appends rather than throwing when the board has since shrunk past that index', () => {
    const result = applyUndoEntry([], deleteEntry({ index: 7 }));
    expect(result.updatedHouses).toHaveLength(1);
  });

  // Re-captured, or a previous undo already restored it. Applying again would duplicate it.
  it('declines when the house is already back', () => {
    expect(applyUndoEntry([house()], deleteEntry())).toBeNull();
  });

  it('declines an entry carrying no record to restore', () => {
    expect(applyUndoEntry([], deleteEntry({ house: null }))).toBeNull();
  });
});

describe('undoLast', () => {
  it('applies the most recent entry and shortens the log', () => {
    const log = [editEntry(), deleteEntry({ key: 'redfin:200', house: house({ propertyID: '200' }) })];
    const result = undoLast([house({ localParams: { sliderValue: 9 } })], log);
    expect(result.entry.key).toBe('redfin:200');
    expect(result.log).toHaveLength(1);
    expect(result.updatedHouses).toHaveLength(2);
  });

  /**
   * A stale entry must not wedge undo behind a mistake that is no longer undoable, so the pop
   * continues past anything that does not apply.
   */
  it('skips stale entries to reach one that still applies', () => {
    const log = [
      deleteEntry({ key: 'redfin:100', house: house() }),
      editEntry({ key: 'redfin:404' })      // house long gone: cannot apply
    ];
    const result = undoLast([], log);
    expect(result.entry.op).toBe('delete');
    expect(result.updatedHouses).toHaveLength(1);
    expect(result.log).toHaveLength(0);
  });

  it('reports nothing to do on an empty log', () => {
    const result = undoLast([house()], []);
    expect(result.entry).toBeNull();
    expect(result.updatedHouses).toBeNull();
  });

  it('drops every entry when none of them still apply, rather than looping', () => {
    const log = [editEntry({ key: 'redfin:404' }), editEntry({ key: 'redfin:405' })];
    const result = undoLast([], log);
    expect(result.entry).toBeNull();
    expect(result.log).toHaveLength(0);
  });

  it('does not mutate the log it was given', () => {
    const log = [editEntry()];
    undoLast([house()], log);
    expect(log).toHaveLength(1);
  });
});
