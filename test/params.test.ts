import { describe, expect, it } from 'vitest';
import { PARAMS, PARAM_KEYS, inheritedValue } from '../src/params';
import { MODES, MODE_IDS } from '../src/modes';
import { DEFAULT_GLOBAL_PARAMETERS } from '../src/App';
import { readLocalParams } from '../src/useHouseParams';
import type { House } from '../src/App';

/**
 * The registry that replaced four hand-maintained copies of the same field list: the stored
 * shape, the card's state, the message it sends the worker, and the overrides a stored house
 * is analysed with.
 */

describe('param registry', () => {
  it('registers every declared key exactly once', () => {
    expect(new Set(PARAM_KEYS).size).toBe(PARAM_KEYS.length);
    for (const key of PARAM_KEYS) {
      expect(PARAMS[key]).toBeDefined();
      expect(PARAMS[key].key).toBe(key);
    }
  });

  it('names a global that actually exists for anything claiming to inherit', () => {
    for (const key of PARAM_KEYS) {
      const from = PARAMS[key].inheritsFrom;
      if (!from) continue;
      expect(DEFAULT_GLOBAL_PARAMETERS[from],
        `${key} inherits from ${from}, which has no default`).toBeDefined();
    }
  });

  /**
   * The fields with no global are the ones where inventing a default would mean inventing a
   * number: what a house is worth repaired, and what the work costs. Both are per-house facts,
   * and a fabricated ARV is exactly the false precision this tool exists to avoid.
   */
  it('leaves after-repair value and rehab budget per-house, with no global to fall back on', () => {
    expect(PARAMS.arv.inheritsFrom).toBeUndefined();
    expect(PARAMS.rehabBudget.inheritsFrom).toBeUndefined();
    expect(inheritedValue('arv', DEFAULT_GLOBAL_PARAMETERS)).toBeNull();
    expect(inheritedValue('rehabBudget', DEFAULT_GLOBAL_PARAMETERS)).toBeNull();
  });

  it('reads a global default through for anything that does inherit', () => {
    expect(inheritedValue('percentDown', DEFAULT_GLOBAL_PARAMETERS)).toBe(20);
    expect(inheritedValue('interestRate', DEFAULT_GLOBAL_PARAMETERS)).toBe(7);
    expect(inheritedValue('sellingCostRate', DEFAULT_GLOBAL_PARAMETERS)).toBe(7);
  });

  it('gives every key a unit the card knows how to render', () => {
    for (const key of PARAM_KEYS) {
      expect(['percent', 'dollar', 'months']).toContain(PARAMS[key].unit);
    }
  });

  /** A percentage with no ceiling lets a typo become a silently absurd model. */
  it('bounds every percentage', () => {
    for (const key of PARAM_KEYS) {
      if (PARAMS[key].unit !== 'percent') continue;
      expect(PARAMS[key].max ?? 100, `${key} has no max`).toBeGreaterThan(0);
    }
  });

  it('covers every param any mode asks for', () => {
    for (const id of MODE_IDS) {
      for (const section of MODES[id].sections) {
        for (const key of section.params) expect(PARAMS[key]).toBeDefined();
      }
    }
  });
});

/**
 * Storage keeps calling monthly rent `sliderValue`, the name it had when a slider was the only
 * way to set it. Renaming it would be a data migration touching the worker and every fixture
 * for no behaviour, so it is translated at this one boundary instead.
 */
describe('reading stored params', () => {
  const house = (localParams: Record<string, unknown> = {}, extra: Partial<House> = {}): House => ({
    address: 'x', price: '$400,000', beds: '3', baths: '2', sqft: '1800',
    propertyID: '1', url: '', latitude: 0, longitude: 0,
    localParams: localParams as House['localParams'],
    ...extra
  });

  it('reads rent from its legacy storage key', () => {
    expect(readLocalParams(house({ sliderValue: 2600 })).monthlyRent).toBe(2600);
  });

  it('defaults rent and additional cash to zero, not to inheriting', () => {
    const params = readLocalParams(house({}));
    expect(params.monthlyRent).toBe(0);
    expect(params.additionalCashInvestment).toBe(0);
  });

  /**
   * Absent and null are different: absent means this card has never touched the field, null
   * means the user cleared it and chose to inherit. Writing null for an untouched field would
   * claim a decision that was never made.
   */
  it('leaves an untouched field absent rather than null', () => {
    const params = readLocalParams(house({ sliderValue: 2000 }));
    expect('arv' in params).toBe(false);
    expect(params.vacancyRate).toBeUndefined();
  });

  it('keeps an explicit null, which means inherit', () => {
    const params = readLocalParams(house({ vacancyRate: null }));
    expect('vacancyRate' in params).toBe(true);
    expect(params.vacancyRate).toBeNull();
  });

  it('reads a new mode-specific field with no special casing', () => {
    const params = readLocalParams(house({ arv: 520000, rehabBudget: 45000 }));
    expect(params.arv).toBe(520000);
    expect(params.rehabBudget).toBe(45000);
  });

  // What the retired mount-time effect did, kept because a house enriched before the worker
  // wrote localParams.propertyTaxRate itself still only carries the API field.
  it('falls back to the API tax rate when no override is stored', () => {
    expect(readLocalParams(house({}, { apiTaxRate: 1.85 })).propertyTaxRate).toBe(1.85);
  });

  it('prefers a stored override over the API tax rate', () => {
    expect(readLocalParams(house({ propertyTaxRate: 2.4 }, { apiTaxRate: 1.85 })).propertyTaxRate).toBe(2.4);
  });

  it('tolerates a house with no localParams at all', () => {
    const params = readLocalParams(house());
    expect(params.monthlyRent).toBe(0);
  });
});
