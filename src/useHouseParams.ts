import { useCallback, useEffect, useRef, useState } from 'react';
// Type-only, so this is erased at runtime and creates no import cycle with App.tsx.
import type { House } from './App';
import { PARAM_KEYS } from './params';
import type { ParamKey } from './params';

/**
 * Owns a card's per-house overrides: the edits in progress, when they reach storage, and
 * when an incoming write from somewhere else is allowed to replace them.
 *
 * Three problems, one hook:
 *
 * 1. **Cadence.** Every field used to send its own message on every keystroke, and the
 *    worker broadcasts the whole house list on every mutation -- so typing "3100" into one
 *    rent field wrote storage four times and re-rendered every card on the board four times.
 *    Edits are now coalesced: a debounce catches drags and abandoned edits, and `commit()`
 *    flushes immediately when a field loses focus, which is the boundary the user perceives
 *    as "done". The window is short enough that the existing persistence tests still observe
 *    a save without blurring, and it is what keeps one edit worth one undo entry.
 *
 * 2. **Adoption.** Card state used to live in useState initializers under a stable key, so it
 *    was written once at mount and never again. That made the card structurally unable to see
 *    a change it did not make -- an undo, an enrichment merge -- and is why a one-off effect
 *    existed solely to re-sync the tax rate. Incoming houses are now adopted generically.
 *
 * 3. **Echoes.** Adoption alone is not enough, because the card's own save comes back to it as
 *    a broadcast. Adopting that echo would overwrite anything typed between sending the save
 *    and the echo arriving, which is exactly the keystroke-eating bug the text buffer already
 *    guards against one field at a time. Each card stamps its writes with a `writer` id, the
 *    worker records it, and the card skips any revision it caused itself.
 *
 * The `rev`/`lastWriter` fields both come from stampRevision in house-storage.js.
 */

/**
 * The fields a card owns, keyed by the param registry rather than spelled out.
 *
 * Deliberately not the whole of localParams: `mode` belongs to the mode picker, and sending a
 * key the card does not own would blank it on the worker. A key absent here was never read or
 * written by this card and is left alone; an explicit null means "inherit the panel default",
 * which is distinct from absent and must survive the round trip.
 */
export type LocalParams = Partial<Record<ParamKey, number | null>>;

/**
 * Where a param is stored, when that differs from what the code calls it.
 *
 * `monthlyRent` is the rent everywhere in the model, but it reaches storage as `sliderValue`
 * -- the name it had when the only way to set it was a slider. Renaming the stored key would
 * be a data migration touching the worker and every fixture, for no behaviour; translating at
 * this one boundary costs a line and keeps both sides honest.
 */
const STORAGE_KEYS: Partial<Record<ParamKey, string>> = { monthlyRent: 'sliderValue' };

const storageKey = (key: ParamKey) => STORAGE_KEYS[key] ?? key;

/** Params that mean zero rather than "inherit" when nothing is stored. */
const DEFAULT_ZERO: ParamKey[] = ['monthlyRent', 'additionalCashInvestment'];

/**
 * Long enough to coalesce typing and a slider drag into one write, short enough that an edit
 * abandoned without blurring still lands well inside the second. Also keeps a save observable
 * within testing-library's default 1s waitFor.
 */
export const SAVE_DEBOUNCE_MS = 400;

let nextClientId = 0;

/** Reads storage into the card's editable shape. */
export function readLocalParams(house: House): LocalParams {
  const local = (house.localParams ?? {}) as Record<string, number | null | undefined>;
  const params: LocalParams = {};

  for (const key of PARAM_KEYS) {
    const stored = local[storageKey(key)];
    if (stored !== undefined) {
      params[key] = stored;
    } else if (DEFAULT_ZERO.includes(key)) {
      params[key] = 0;
    }
    // Everything else stays absent rather than null: the card has never touched it, so it has
    // nothing to say about it, and writing a null would claim it had chosen to inherit.
  }

  // Falls back to the API-supplied rate, which is what the retired mount-time effect did.
  // Enrichment also writes localParams.propertyTaxRate itself when it is unset, so this is
  // only load-bearing for a house enriched before that behaviour existed.
  if (params.propertyTaxRate === undefined || params.propertyTaxRate === null) {
    params.propertyTaxRate = local.propertyTaxRate ?? house.apiTaxRate ?? null;
  }

  return params;
}

/** The card's view translated back to the keys storage uses. */
function toStorageShape(params: LocalParams): Record<string, number | null> {
  const payload: Record<string, number | null> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    payload[storageKey(key as ParamKey)] = value;
  }
  return payload;
}

export function useHouseParams(house: House) {
  const clientId = useRef<string>();
  if (clientId.current === undefined) clientId.current = `card-${nextClientId++}`;

  const [params, setParams] = useState<LocalParams>(() => readLocalParams(house));

  // Mirrors `params` for the flush closure, which must send the newest values rather than
  // whatever was current when the timer was scheduled.
  const paramsRef = useRef(params);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  // Initialised from the mounting props so the first render is never treated as a foreign
  // write. Missing rev counts as 0, which is what a record predating revisions has.
  const adoptedRev = useRef(house.rev ?? 0);

  const { propertyID, source } = house;

  const flush = useCallback(async () => {
    if (!dirty.current) return;
    dirty.current = false;
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'updateLocalParams',
        propertyID,
        source,
        writer: clientId.current,
        localParams: toStorageShape(paramsRef.current)
      });
      if (response && response.ok === false) {
        console.error('Could not save local parameters:', response.reason);
      }
    } catch (error) {
      console.error('Error saving local parameters:', error);
    }
  }, [propertyID, source]);

  /** Records an edit. Schedules the write; does not perform it. */
  const setParam = useCallback((key: ParamKey, value: number | null) => {
    setParams((prev) => {
      const next = { ...prev, [key]: value };
      paramsRef.current = next;
      return next;
    });
    dirty.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush(); }, SAVE_DEBOUNCE_MS);
  }, [flush]);

  /**
   * Ends an edit session early -- wired to blur, so leaving a field saves it now.
   *
   * Returns the write so a caller that is about to cause a *foreign* write can await it. The
   * mode picker has to: its write is not this card's, so adoption drops any pending edit, and
   * a number typed within the debounce window would be discarded by the switch. Blur handlers
   * ignore the promise, which is fine.
   */
  const commit = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
    return flush();
  }, [flush]);

  // Adopt writes this card did not make. Anything it did make is skipped, but its revision is
  // still recorded so a later foreign write is correctly seen as newer.
  useEffect(() => {
    const incomingRev = house.rev ?? 0;
    if (incomingRev <= adoptedRev.current) return;
    adoptedRev.current = incomingRev;
    if (house.lastWriter === clientId.current) return;

    const next = readLocalParams(house);
    paramsRef.current = next;
    setParams(next);
    // A foreign write wins outright: keeping a pending local edit would re-send values the
    // user has just seen replaced, which is how an undo comes straight back.
    dirty.current = false;
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
  }, [house]);

  // A pending edit at unmount is still the user's; try to land it. Best-effort by nature --
  // when the whole panel is closing there may be no runtime left to receive it.
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    void flush();
  }, [flush]);

  return { params, setParam, commit };
}
