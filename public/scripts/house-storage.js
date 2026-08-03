/**
 * Small, side-effect-free storage helpers used by the service worker. Keeping the
 * merge logic here lets us test the actual code that protects panel edits from
 * asynchronous API enrichment.
 */
export function houseKey(house) {
  return `${house?.source || 'redfin'}:${house?.propertyID}`;
}

/**
 * Stamps a house with a new revision and the id of whoever caused it.
 *
 * Both fields exist for the panel, which holds in-progress edits in component state and
 * therefore cannot simply re-read every broadcast: a card that adopted its own echo would
 * overwrite whatever was typed between sending the save and the echo arriving. `rev` orders
 * writes so a card can tell new from stale, and `lastWriter` identifies whose write it was so
 * a card can skip its own and still adopt everyone else's -- an undo, an enrichment merge, a
 * future second surface. See useHouseParams in src/useHouseParams.ts.
 *
 * A record predating this carries no rev; missing is treated as 0 everywhere.
 */
export function stampRevision(house, writer) {
  return { ...house, rev: (house?.rev ?? 0) + 1, lastWriter: writer ?? null };
}

/**
 * Applies user-entered local parameters to the newest copy of a house in storage.
 *
 * Merged into whatever is already there rather than replacing it, so a field the caller
 * doesn't know about -- API-seeded propertyTaxRate, a future per-house setting -- is not
 * dropped by a save that happens to predate it.
 *
 * Returns null when the house is gone, which happens when it is removed while a save is
 * in flight; re-adding it from a stale snapshot would resurrect a deleted record.
 */
export function applyLocalParams(houses, key, localParams, writer) {
  const index = houses.findIndex((house) => houseKey(house) === key);
  if (index === -1) return null;

  const current = houses[index];
  const updatedHouse = {
    ...stampRevision(current, writer),
    localParams: { ...(current.localParams || {}), ...(localParams || {}) },
  };
  const updatedHouses = [...houses];
  updatedHouses[index] = updatedHouse;
  return { updatedHouses, updatedHouse };
}

/**
 * Applies API-only fields to the newest copy of a house in storage. The network
 * request may have started with an older copy, so never spread that stale record
 * back over current user-entered local parameters.
 *
 * Unused since the enrichment client was removed for the store release (see the header of
 * background.js). Kept, with its tests, because the race it solves is the non-obvious part
 * of putting enrichment back: the request outlives the record it started from, and a naive
 * write-back silently reverts whatever the user typed while it was in flight.
 */
export function mergeEnrichmentIntoLatest(houses, key, enrichment) {
  const index = houses.findIndex((house) => houseKey(house) === key);
  if (index === -1) return null;

  const current = houses[index];
  const localParams = { ...(current.localParams || {}) };
  if (
    enrichment.apiTaxRate !== null &&
    enrichment.apiTaxRate !== undefined &&
    (localParams.propertyTaxRate === null || localParams.propertyTaxRate === undefined)
  ) {
    localParams.propertyTaxRate = enrichment.apiTaxRate;
  }

  // Stamped as a foreign write so a mounted card adopts it. This is the path the old
  // one-off "sync localPropertyTaxRate when enrichment lands" effect in the card existed
  // to serve; useHouseParams now covers it generically.
  const updatedHouse = {
    ...stampRevision(current, 'enrichment'),
    apiTaxRate: enrichment.apiTaxRate,
    taxError: enrichment.taxError,
    rentEstimate: enrichment.rentEstimate,
    rentError: enrichment.rentError,
    localParams,
  };
  const updatedHouses = [...houses];
  updatedHouses[index] = updatedHouse;
  return { updatedHouses, updatedHouse };
}

const PAGE_FACT_FIELDS = [
  'address', 'price', 'beds', 'baths', 'sqft', 'url',
  'latitude', 'longitude', 'hoa'
];

function present(value) {
  return value !== null && value !== undefined && value !== '';
}

function mergePresent(current, incoming) {
  const merged = { ...(current || {}) };
  for (const [field, value] of Object.entries(incoming || {})) {
    if (present(value)) merged[field] = value;
  }
  return merged;
}

/**
 * Merges facts read from a detail page into the newest stored record.
 *
 * Page facts never touch localParams or comps. They also do not bump `rev`: the panel's
 * house array still re-renders from the storage broadcast, while an in-progress parameter
 * edit remains in the mounted card instead of being treated as stale foreign input.
 */
export function mergePageDetailsIntoLatest(houses, key, incoming, now = Date.now()) {
  const index = houses.findIndex((house) => houseKey(house) === key);
  if (index === -1) return null;

  const current = houses[index];
  const updatedHouse = { ...current };
  for (const field of PAGE_FACT_FIELDS) {
    if (present(incoming?.[field])) updatedHouse[field] = incoming[field];
  }

  const details = mergePresent(current.details, incoming?.details);
  if (incoming?.details?.tax) {
    details.tax = mergePresent(current.details?.tax, incoming.details.tax);
    if (Array.isArray(incoming.details.tax.history) && incoming.details.tax.history.length > 0) {
      details.tax.history = incoming.details.tax.history.slice(0, 10);
    }
  }
  if (Array.isArray(incoming?.details?.extraFacts) && incoming.details.extraFacts.length > 0) {
    details.extraFacts = incoming.details.extraFacts.slice(0, 100);
  }

  updatedHouse.details = {
    ...details,
    schemaVersion: 1,
    enrichedAt: now,
    source: incoming?.source || current.source || 'redfin'
  };

  const updatedHouses = [...houses];
  updatedHouses[index] = updatedHouse;
  return { updatedHouses, updatedHouse };
}

/** Identifies a comp within one house's list, for dedupe and removal. */
export function compKey(comp) {
  return `${comp?.source}:${comp?.propertyID}:${comp?.kind}`;
}

/**
 * Appends a comp to the newest copy of a house in storage, deduped on
 * (source, propertyID, kind) so re-clicking the same listing is a no-op rather than a
 * second entry.
 *
 * Deliberately does not call stampRevision. A comp reaches a mounted card through the
 * `updateSidePanel` broadcast re-render -- the panel replaces its whole `houses` array,
 * and `HouseCard` is keyed by `houseKey`, so it re-renders without remounting -- not
 * through revision adoption. Stamping would make `useHouseParams` treat the write as
 * foreign and discard whatever the user is mid-typing in another card's debounce window,
 * which is this feature's core workflow, not an edge case. See docs/comp-workflow.md,
 * rule A1.
 *
 * Returns null when the house is gone. Returns `{ duplicate: true }` (with the houses
 * array unchanged) rather than null on a repeat click, so the caller can still ack
 * "Already added" instead of a generic failure.
 */
export function addCompToHouse(houses, key, comp) {
  const index = houses.findIndex((house) => houseKey(house) === key);
  if (index === -1) return null;

  const current = houses[index];
  const existing = current.comps || [];
  if (existing.some((c) => compKey(c) === compKey(comp))) {
    return { updatedHouses: houses, updatedHouse: current, duplicate: true };
  }

  const updatedHouse = { ...current, comps: [...existing, comp] };
  const updatedHouses = [...houses];
  updatedHouses[index] = updatedHouse;
  return { updatedHouses, updatedHouse, duplicate: false };
}

/**
 * Removes one comp from the newest copy of a house. Also does not call stampRevision --
 * same reasoning as addCompToHouse above.
 *
 * Returns null when the house is gone or the comp is already gone (nothing to remove),
 * which the caller can tell apart from a genuine removal.
 */
export function removeCompFromHouse(houses, key, targetCompKey) {
  const index = houses.findIndex((house) => houseKey(house) === key);
  if (index === -1) return null;

  const current = houses[index];
  const existing = current.comps || [];
  if (!existing.some((c) => compKey(c) === targetCompKey)) return null;

  const updatedHouse = { ...current, comps: existing.filter((c) => compKey(c) !== targetCompKey) };
  const updatedHouses = [...houses];
  updatedHouses[index] = updatedHouse;
  return { updatedHouses, updatedHouse };
}

/**
 * Undo.
 *
 * The log lives here rather than in the panel because the worker is the sole serialized writer
 * of storedHouses: every mutation already funnels through one queue, which is the only place
 * that can capture a before-state that is guaranteed to be the one actually overwritten.
 *
 * Entries are inverses, not snapshots of the whole array. Storing the whole array would make
 * undo a time machine that also reverts unrelated houses -- including an enrichment or a
 * capture that landed in between, which the user never asked to undo.
 */

/** Deep enough for a session's worth of mistakes without turning storage into a journal. */
export const UNDO_LIMIT = 20;

/**
 * Consecutive edits to the same house collapse into one entry.
 *
 * The card already coalesces keystrokes into one write per edit session, but a slow typist
 * still produces several. Undo should step back over "the change I just made", not over each
 * flush of it, so a later edit folds into the pending entry and the *older* before-state is
 * the one kept.
 */
const EDIT_COALESCE_MS = 2000;

/**
 * Records the inverse of a mutation about to happen.
 *
 * `prior` is the house as it exists right now -- null for a capture, which has no before-state
 * worth restoring. Returns the new log; never mutates the one passed in.
 */
export function pushUndoEntry(log, entry, now = Date.now()) {
  const entries = Array.isArray(log) ? log : [];
  const top = entries[entries.length - 1];

  if (
    entry.op === 'edit' && top && top.op === 'edit' &&
    top.key === entry.key && now - top.at <= EDIT_COALESCE_MS
  ) {
    // Keeps top.localParams: the oldest before-state is the one that undoes the whole session.
    const merged = { ...top, at: now, label: entry.label };
    return [...entries.slice(0, -1), merged];
  }

  return [...entries, { ...entry, at: now }].slice(-UNDO_LIMIT);
}

/**
 * Applies an inverse to the current houses, or returns null when it no longer makes sense.
 *
 * Validated rather than trusted, because the log is a separate storage key and its write is
 * not atomic with the houses write: a crash between the two, or a house deleted after the
 * entry was recorded, leaves an entry describing a world that no longer exists. A stale entry
 * is dropped, never applied.
 */
export function applyUndoEntry(houses, entry) {
  if (!entry || !Array.isArray(houses)) return null;
  const index = houses.findIndex((house) => houseKey(house) === entry.key);

  if (entry.op === 'edit') {
    // Gone since. Re-adding it from an undo would resurrect a record the user deleted.
    if (index === -1) return null;
    const restored = {
      ...stampRevision(houses[index], 'undo'),
      // Only the fields the user owns. Restoring the whole record would clobber an enrichment
      // that landed after the edit -- the mirror of what mergeEnrichmentIntoLatest avoids.
      localParams: entry.localParams ? { ...entry.localParams } : undefined
    };
    const updated = [...houses];
    updated[index] = restored;
    return { updatedHouses: updated, restored };
  }

  if (entry.op === 'comp') {
    // Gone since -- nothing to restore the comp list onto.
    if (index === -1) return null;
    // Deliberately no stampRevision, unlike every other branch here: a comp-only write
    // must never trigger a mounted card's foreign-write adoption (rule A1 in
    // docs/comp-workflow.md), or restoring a removed comp would eat pending keystrokes
    // in whatever field the user happens to be mid-edit on.
    const restored = { ...houses[index], comps: entry.comps ? [...entry.comps] : [] };
    const updated = [...houses];
    updated[index] = restored;
    return { updatedHouses: updated, restored };
  }

  if (entry.op === 'delete') {
    // Already back, by capture or a previous undo. Restoring again would duplicate it.
    if (index !== -1) return null;
    if (!entry.house) return null;
    const restored = stampRevision(entry.house, 'undo');
    const updated = [...houses];
    // Back where it was, so undoing a deletion does not silently reorder the board.
    updated.splice(Math.min(entry.index ?? updated.length, updated.length), 0, restored);
    return { updatedHouses: updated, restored };
  }

  return null;
}

/**
 * Pops entries until one applies, so a run of stale entries cannot wedge undo behind a
 * mistake that is no longer undoable.
 */
export function undoLast(houses, log) {
  const entries = Array.isArray(log) ? [...log] : [];
  while (entries.length > 0) {
    const entry = entries.pop();
    const applied = applyUndoEntry(houses, entry);
    if (applied) return { ...applied, log: entries, entry };
  }
  return { updatedHouses: null, log: entries, entry: null };
}
