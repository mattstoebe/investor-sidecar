import { useCallback, useEffect, useRef, useState } from 'react';
import type { House } from './App';
import { PARAM_KEYS } from './params';
import type { ParamKey } from './params';

/** Per-card overrides. `null` inherits the panel default; absent keys are untouched. */
export type LocalParams = Partial<Record<ParamKey, number | null>>;

/** Legacy storage key. */
const STORAGE_KEYS: Partial<Record<ParamKey, string>> = { monthlyRent: 'sliderValue' };

const storageKey = (key: ParamKey) => STORAGE_KEYS[key] ?? key;

/** Params that mean zero rather than "inherit" when nothing is stored. */
const DEFAULT_ZERO: ParamKey[] = ['monthlyRent', 'additionalCashInvestment'];

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
  }

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

  const paramsRef = useRef(params);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
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

  const commit = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
    return flush();
  }, [flush]);

  // Adopt newer writes from elsewhere, but never overwrite this card's own pending input.
  useEffect(() => {
    const incomingRev = house.rev ?? 0;
    if (incomingRev <= adoptedRev.current) return;
    adoptedRev.current = incomingRev;
    if (house.lastWriter === clientId.current) return;

    const next = readLocalParams(house);
    paramsRef.current = next;
    setParams(next);
    dirty.current = false;
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
  }, [house]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    void flush();
  }, [flush]);

  return { params, setParam, commit };
}
