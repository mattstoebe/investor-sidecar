import { describe, expect, it } from 'vitest';
import { MODES, MODE_IDS, DEFAULT_MODE, resolveMode, hasMultipleModes, analyzeStoredHouse, missingRequirement } from '../src/modes';
import { analyzeHouse } from '../src/analysis';
import { METRICS } from '../src/metrics';
import { PARAMS } from '../src/params';
import { DEFAULT_GLOBAL_PARAMETERS, migrateGlobalParams } from '../src/App';
import type { GlobalParameters } from '../src/App';

const globals: GlobalParameters = { ...DEFAULT_GLOBAL_PARAMETERS, propertyTaxRate: 1 };

describe('mode registry', () => {
  it('registers every declared id', () => {
    for (const id of MODE_IDS) {
      expect(MODES[id]).toBeDefined();
      expect(MODES[id].id).toBe(id);
    }
  });

  it('has a default that is actually registered', () => {
    expect(MODES[DEFAULT_MODE]).toBeDefined();
  });

  it('only offers metrics that exist in the registry', () => {
    for (const id of MODE_IDS) {
      for (const metric of MODES[id].metrics) {
        expect(METRICS[metric.key], `${id} offers unknown metric ${metric.key}`).toBeDefined();
      }
    }
  });

  it('offers no duplicate metrics or params', () => {
    for (const id of MODE_IDS) {
      const mode = MODES[id];
      expect(new Set(mode.metrics.map((metric) => metric.key)).size).toBe(mode.metrics.length);
      // A param appearing in two sections would render two fields writing the same key.
      const params = mode.sections.flatMap((section) => section.params);
      expect(new Set(params).size).toBe(params.length);
    }
  });

  // The rental mode must delegate, not reimplement -- analyzeHouse is the tested model.
  it('rental mode produces exactly what analyzeHouse produces', () => {
    const viaMode = MODES.rental.analyze({
      house: { price: '$400,000', hoa: 100 }, overrides: { monthlyRent: 2500 }, globals
    });
    const direct = analyzeHouse('$400,000', 100, { monthlyRent: 2500 }, globals);
    expect(direct.ok).toBe(true);
    expect(viaMode.ok).toBe(true);
    if (!viaMode.ok || !direct.ok) return;
    // The wrapper adds an envelope; the arithmetic underneath must be untouched.
    expect(viaMode.analysis.detail).toEqual(direct.analysis);
  });

  it('propagates a failure reason rather than throwing', () => {
    const result = MODES.rental.analyze({ house: { price: 'N/A', hoa: null }, overrides: {}, globals });
    expect(result.ok).toBe(false);
  });

  // The panel hides its mode picker while this is false; the guard must be honest.
  it('reports whether a picker is worth rendering', () => {
    expect(hasMultipleModes).toBe(MODE_IDS.length > 1);
  });
});

describe('resolveMode', () => {
  it('prefers a per-house override over the panel default', () => {
    expect(resolveMode('rental', 'rental')).toEqual({ value: 'rental', overridden: true });
  });

  it('falls back to the panel value when there is no override', () => {
    expect(resolveMode(null, 'rental')).toEqual({ value: 'rental', overridden: false });
    expect(resolveMode(undefined, 'rental').overridden).toBe(false);
  });

  it('falls back to the default when neither is set', () => {
    expect(resolveMode(null, null)).toEqual({ value: DEFAULT_MODE, overridden: false });
  });

  // A stored id from a mode that was renamed or removed must not break a card.
  it('ignores an unknown id in either position', () => {
    expect(resolveMode('wholesale' as never, null).value).toBe(DEFAULT_MODE);
    expect(resolveMode(null, 'subject-to' as never).value).toBe(DEFAULT_MODE);
    expect(resolveMode('nope' as never, 'rental').value).toBe('rental');
    // An unknown override is not an override.
    expect(resolveMode('nope' as never, 'rental').overridden).toBe(false);
  });
});

describe('mode in stored parameters', () => {
  it('defaults for a panel that predates modes', () => {
    expect(migrateGlobalParams({ percentDown: 25 }).mode).toBe(DEFAULT_MODE);
  });

  it('repairs an unknown stored mode', () => {
    expect(migrateGlobalParams({ mode: 'wholesale' as never }).mode).toBe(DEFAULT_MODE);
  });

  it('keeps a valid stored mode', () => {
    expect(migrateGlobalParams({ mode: 'rental' }).mode).toBe('rental');
  });
});

/**
 * analyzeStoredHouse is the one entry point for evaluating a *saved* house. Sorting and the
 * spreadsheet export used to build the overrides object by hand and call analyzeHouse
 * directly, which bypassed the mode seam -- the day a second mode ships they would have
 * evaluated every house as a rental regardless of its stored mode.
 */
describe('analyzeStoredHouse', () => {
  const stored = (localParams: Record<string, unknown> = {}) => ({
    price: '$400,000',
    hoa: 100,
    localParams: {
      mode: null, percentDown: null, interestRate: null, price: null,
      sliderValue: 2500, additionalCashInvestment: 0, propertyTaxRate: null,
      vacancyRate: null, maintenanceRate: null, capExRate: null,
      managementRate: null, insuranceRate: null,
      ...localParams
    }
  }) as Parameters<typeof analyzeStoredHouse>[0];

  const globals = { ...DEFAULT_GLOBAL_PARAMETERS, propertyTaxRate: 1 };

  it('reads every per-house override rather than only some of them', () => {
    const base = analyzeStoredHouse(stored(), globals);
    expect(base.ok).toBe(true);
    if (!base.ok) return;

    // Each override must move the result, which is what proves the field is wired through.
    for (const [key, value] of [
      ['percentDown', 50], ['interestRate', 3], ['price', 300000],
      ['propertyTaxRate', 5], ['vacancyRate', 40], ['maintenanceRate', 20],
      ['capExRate', 20], ['managementRate', 20], ['insuranceRate', 3],
      ['additionalCashInvestment', 50000], ['sliderValue', 4000]
    ] as const) {
      const overridden = analyzeStoredHouse(stored({ [key]: value }), globals);
      expect(overridden.ok, `${key} should analyse`).toBe(true);
      if (!overridden.ok) continue;
      expect(
        JSON.stringify(overridden.analysis) !== JSON.stringify(base.analysis),
        `override ${key}=${value} changed nothing`
      ).toBe(true);
    }
  });

  it('agrees with the mode it resolves to', () => {
    const viaHelper = analyzeStoredHouse(stored(), globals);
    const viaMode = MODES.rental.analyze({
      house: { price: '$400,000', hoa: 100 },
      overrides: { monthlyRent: 2500, additionalCashInvestment: 0 },
      globals
    });
    expect(viaHelper).toEqual(viaMode);
  });

  it('honours a per-house mode override over the panel default', () => {
    // Only 'rental' exists, so this asserts the plumbing rather than differing arithmetic.
    const result = analyzeStoredHouse(stored({ mode: 'rental' }), { ...globals, mode: 'rental' });
    expect(result.ok).toBe(true);
  });

  it('falls back to the default mode when the stored one is unknown', () => {
    const result = analyzeStoredHouse(stored({ mode: 'wholesale' }), globals);
    expect(result.ok).toBe(true);
  });

  it('returns a reason rather than throwing for an unusable house', () => {
    const result = analyzeStoredHouse({ price: 'N/A', hoa: 0, sqft: null, localParams: undefined }, globals);
    expect(result.ok).toBe(false);
  });
});

/**
 * The envelope every mode returns, and the two things that let a mixed board work: a summary
 * whose fields mean the same thing under any strategy, and a discriminant that stops one
 * mode's numbers being read as another's.
 */
describe('ModeAnalysis envelope', () => {
  it('tags the analysis with the mode that produced it', () => {
    const result = MODES.rental.analyze({
      house: { price: '$400,000', hoa: 0 }, overrides: { monthlyRent: 2500 }, globals
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.analysis.mode).toBe('rental');
  });

  it('promotes only figures that mean the same thing under every strategy', () => {
    const result = MODES.rental.analyze({
      house: { price: '$400,000', hoa: 0 }, overrides: { monthlyRent: 2500 }, globals
    });
    if (!result.ok) return;
    // Price and cash invested exist for a flip too; cash flow and DSCR do not, and must stay
    // behind the discriminant rather than being promoted for convenience.
    expect(Object.keys(result.analysis.summary).sort()).toEqual(['price', 'totalCashInvested']);
    expect(result.analysis.summary.price).toBe(400000);
    if (result.analysis.mode !== 'rental') return;
    expect(result.analysis.summary.totalCashInvested).toBe(result.analysis.detail.totalCashInvested);
  });

  it('every mode declares defaults it actually offers', () => {
    for (const id of MODE_IDS) {
      const offered = new Set(MODES[id].metrics.map((metric) => metric.key));
      for (const key of MODES[id].defaultMetrics) {
        expect(offered.has(key), `${id} defaults to ${key} but does not offer it`).toBe(true);
      }
    }
  });

  /** One stored string must identify one metric, or a per-mode selection cannot round-trip. */
  it('no two modes claim the same metric key', () => {
    const owner = new Map<string, string>();
    for (const id of MODE_IDS) {
      for (const metric of MODES[id].metrics) {
        const existing = owner.get(metric.key);
        expect(existing === undefined || existing === id,
          `${metric.key} is offered by both ${existing} and ${id}`).toBe(true);
        owner.set(metric.key, id);
      }
    }
  });

  it('exposes a comparable number for every metric it offers, or an explicit null', () => {
    const result = MODES.rental.analyze({
      house: { price: '$400,000', hoa: 0 }, overrides: { monthlyRent: 2500 }, globals
    });
    if (!result.ok) return;
    for (const metric of MODES.rental.metrics) {
      const value = metric.value(result.analysis.detail);
      expect(value === null || Number.isFinite(value), `${metric.key} returned ${value}`).toBe(true);
    }
  });
});

describe('missingRequirement', () => {
  it('names the input a rental still needs', () => {
    expect(missingRequirement('rental', {})).toBe('monthlyRent');
    expect(missingRequirement('rental', { monthlyRent: 0 })).toBe('monthlyRent');
    expect(missingRequirement('rental', { monthlyRent: null })).toBe('monthlyRent');
  });

  it('is satisfied once the input is present', () => {
    expect(missingRequirement('rental', { monthlyRent: 2500 })).toBeNull();
  });
});

/**
 * A mode's sections are its whole editing surface, so anything it needs must be reachable
 * from one -- a required input with no field to type it into is a dead card.
 */
describe('mode sections', () => {
  it('only names params the registry defines', () => {
    for (const id of MODE_IDS) {
      for (const section of MODES[id].sections) {
        for (const key of section.params) {
          expect(PARAMS[key], `${id}/${section.id} names unknown param ${key}`).toBeDefined();
        }
      }
    }
  });

  it('gives every required input somewhere to be entered', () => {
    for (const id of MODE_IDS) {
      const reachable = new Set(MODES[id].sections.flatMap((section) => section.params));
      for (const key of MODES[id].requires) {
        expect(reachable.has(key as never), `${id} requires ${key} but has no field for it`).toBe(true);
      }
    }
  });

  it('gives each section a distinct id, since the card keys its open state on one', () => {
    for (const id of MODE_IDS) {
      const ids = MODES[id].sections.map((section) => section.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
