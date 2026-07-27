import { describe, expect, it } from 'vitest';
import { METRICS, METRIC_KEYS, CARD_METRIC_COUNT, DEFAULT_CARD_METRICS, resolveCardMetrics } from '../src/metrics';
import { MODES, MODE_IDS } from '../src/modes';
import { migrateGlobalParams, DEFAULT_GLOBAL_PARAMETERS, CURRENT_PARAMS_VERSION } from '../src/App';
import { analyzeHouse } from '../src/analysis';
import type { GlobalParameters } from '../src/App';
import type { RentalAnalysis } from '../src/analysis';

/**
 * resolveCardMetrics is scoped to a mode now -- it takes what that mode offers and what it
 * falls back to -- because a selection is per-strategy. Every case below was written against
 * rental's catalogue, so binding it once here keeps them about the resolution rules.
 */
const OFFERED = MODES.rental.metrics.map((metric) => metric.key);
const resolveRental = (stored: unknown) =>
  resolveCardMetrics(stored as never, OFFERED, MODES.rental.defaultMetrics);

const analysisWith = (overrides: Partial<GlobalParameters> = {}, monthlyRent = 3000): RentalAnalysis => {
  const result = analyzeHouse('$400,000', 0, { monthlyRent }, { ...DEFAULT_GLOBAL_PARAMETERS, propertyTaxRate: 1, ...overrides });
  if (!result.ok) throw new Error(`fixture failed to analyse: ${result.reason}`);
  return result.analysis;
};

describe('metric registry', () => {
  it('every key in the union has a definition, and every definition is reachable', () => {
    for (const key of METRIC_KEYS) {
      expect(METRICS[key]).toBeDefined();
      expect(METRICS[key].key).toBe(key);
    }
    expect(Object.keys(METRICS).sort()).toEqual([...METRIC_KEYS].sort());
  });

  it('gives every metric a distinct testId, so a strip can be read unambiguously', () => {
    const ids = METRIC_KEYS.map((key) => METRICS[key].testId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * Per mode, against that mode's own analysis. A flat sweep of every key over a rental would
   * hand a flip metric a shape it was never typed against -- which is the exact confusion the
   * mode-scoped registry exists to prevent, so the test must not perform it either.
   */
  it('formats and tones every metric without throwing on a real analysis', () => {
    for (const id of MODE_IDS) {
      const result = MODES[id].analyze({
        house: { price: '$400,000', hoa: 0, sqft: '1800' },
        // Enough of everything for any mode to compute: unused keys are ignored.
        overrides: { monthlyRent: 3000, arv: 520000, rehabBudget: 45000 },
        globals: { ...DEFAULT_GLOBAL_PARAMETERS, propertyTaxRate: 1 }
      });
      expect(result.ok, `${id} failed to analyse`).toBe(true);
      if (!result.ok) continue;

      for (const metric of MODES[id].metrics) {
        expect(typeof metric.format(result.analysis.detail)).toBe('string');
        expect(['good', 'warn', 'bad', 'neutral']).toContain(metric.tone(result.analysis.detail));
      }
    }
  });

  it('reaches every registered metric through some mode', () => {
    const offered = new Set(MODE_IDS.flatMap((id) => MODES[id].metrics.map((m) => m.key)));
    for (const key of METRIC_KEYS) {
      expect(offered.has(key), `${key} is registered but no mode offers it`).toBe(true);
    }
  });

  // These thresholds came from the hardcoded chips they replaced; pinning them here is what
  // stops the move into a registry from quietly changing what the colors mean.
  it('keeps the cash-flow tone keyed on sign', () => {
    expect(METRICS.monthlyCashFlow.tone(analysisWith({}, 10000))).toBe('good');
    expect(METRICS.monthlyCashFlow.tone(analysisWith({}, 500))).toBe('bad');
  });

  it('keeps the DSCR bands at 1.25 and 1.0', () => {
    const def = METRICS.dscr;
    expect(def.tone({ dscr: 1.3 } as RentalAnalysis)).toBe('good');
    expect(def.tone({ dscr: 1.1 } as RentalAnalysis)).toBe('warn');
    expect(def.tone({ dscr: 0.9 } as RentalAnalysis)).toBe('bad');
    // No loan: no ratio, not a bad one.
    expect(def.tone({ dscr: null } as RentalAnalysis)).toBe('neutral');
    expect(def.format({ dscr: null } as RentalAnalysis)).toBe('—');
  });

  it('keeps the cap-rate bands at 7 and 4', () => {
    const def = METRICS.capRate;
    expect(def.tone({ capRate: 7 } as RentalAnalysis)).toBe('good');
    expect(def.tone({ capRate: 5 } as RentalAnalysis)).toBe('warn');
    expect(def.tone({ capRate: 3 } as RentalAnalysis)).toBe('bad');
  });

  it('keeps the cash-on-cash bands at 8 and 0, and dashes a null', () => {
    const def = METRICS.cashOnCash;
    expect(def.tone({ cashOnCashReturn: 9 } as RentalAnalysis)).toBe('good');
    expect(def.tone({ cashOnCashReturn: 2 } as RentalAnalysis)).toBe('warn');
    expect(def.tone({ cashOnCashReturn: -3 } as RentalAnalysis)).toBe('bad');
    expect(def.tone({ cashOnCashReturn: null } as RentalAnalysis)).toBe('neutral');
    expect(def.format({ cashOnCashReturn: null } as RentalAnalysis)).toBe('—');
  });

  it('tones expense-like metrics so that lower is better', () => {
    expect(METRICS.opexRatio.tone({ operatingExpenseRatio: 30 } as RentalAnalysis)).toBe('good');
    expect(METRICS.opexRatio.tone({ operatingExpenseRatio: 80 } as RentalAnalysis)).toBe('bad');
    expect(METRICS.breakEvenOccupancy.tone({ breakEvenOccupancy: 70 } as RentalAnalysis)).toBe('good');
    expect(METRICS.breakEvenOccupancy.tone({ breakEvenOccupancy: 99 } as RentalAnalysis)).toBe('bad');
  });
});

describe('resolveCardMetrics', () => {
  it('passes a valid selection through unchanged', () => {
    expect(resolveRental(['dscr', 'grm', 'capRate'])).toEqual(['dscr', 'grm', 'capRate']);
  });

  it('always returns exactly the card metric count', () => {
    for (const input of [[], ['dscr'], ['dscr', 'grm'], ['dscr', 'grm', 'capRate', 'cashOnCash']] as const) {
      expect(resolveRental([...input])).toHaveLength(CARD_METRIC_COUNT);
    }
  });

  it('drops keys that no longer exist and duplicates, then backfills from the defaults', () => {
    const resolved = resolveRental(['nope', 'capRate', 'capRate']);
    expect(resolved).toHaveLength(CARD_METRIC_COUNT);
    expect(new Set(resolved).size).toBe(CARD_METRIC_COUNT);
    expect(resolved).toContain('capRate');
  });

  it('handles a missing selection', () => {
    expect(resolveRental(undefined)).toEqual(DEFAULT_CARD_METRICS);
    expect(resolveRental(null)).toEqual(DEFAULT_CARD_METRICS);
  });
});

describe('migrateGlobalParams', () => {
  it('zeroes the four rent-scaled rates for a panel saved before v2', () => {
    const migrated = migrateGlobalParams({
      vacancyRate: 5, maintenanceRate: 5, capExRate: 5, managementRate: 8
    });
    expect(migrated.vacancyRate).toBe(0);
    expect(migrated.maintenanceRate).toBe(0);
    expect(migrated.capExRate).toBe(0);
    expect(migrated.managementRate).toBe(0);
    expect(migrated.paramsVersion).toBe(CURRENT_PARAMS_VERSION);
  });

  // Deliberately unconditional: the user chose this over matching the old defaults, knowing
  // a customized value is discarded once.
  it('zeroes them even when they were customized', () => {
    const migrated = migrateGlobalParams({ vacancyRate: 12, managementRate: 3 });
    expect(migrated.vacancyRate).toBe(0);
    expect(migrated.managementRate).toBe(0);
  });

  it('leaves values alone once the migration has run', () => {
    const migrated = migrateGlobalParams({
      vacancyRate: 7, maintenanceRate: 6, capExRate: 4, managementRate: 9,
      paramsVersion: CURRENT_PARAMS_VERSION
    });
    expect(migrated.vacancyRate).toBe(7);
    expect(migrated.maintenanceRate).toBe(6);
    expect(migrated.capExRate).toBe(4);
    expect(migrated.managementRate).toBe(9);
  });

  it('never touches rates that are not rent-scaled', () => {
    const migrated = migrateGlobalParams({
      insuranceRate: 0.6, closingCostRate: 4, pmiRate: 0.8, percentDown: 25, interestRate: 6.5
    });
    expect(migrated.insuranceRate).toBe(0.6);
    expect(migrated.closingCostRate).toBe(4);
    expect(migrated.pmiRate).toBe(0.8);
    expect(migrated.percentDown).toBe(25);
    expect(migrated.interestRate).toBe(6.5);
  });

  it('still fills in fields a saved panel never had', () => {
    const migrated = migrateGlobalParams({ percentDown: 25 });
    expect(migrated.cardMetrics.rental).toEqual(DEFAULT_CARD_METRICS);
    expect(migrated.insuranceRate).toBe(DEFAULT_GLOBAL_PARAMETERS.insuranceRate);
  });

  it('repairs an unusable stored metric selection', () => {
    const migrated = migrateGlobalParams({ cardMetrics: ['bogus'] as never });
    const resolved = resolveRental(migrated.cardMetrics.rental);
    expect(resolved).toHaveLength(CARD_METRIC_COUNT);
    expect(resolved.every((key) => METRICS[key])).toBe(true);
  });

  // A legacy key that nothing reads. Carrying it through is harmless; crashing on it isn't.
  it('ignores the retired primaryMetric key', () => {
    const migrated = migrateGlobalParams({ primaryMetric: 'CoC' } as never);
    expect(migrated.cardMetrics.rental).toEqual(DEFAULT_CARD_METRICS);
  });
});

describe('default assumptions', () => {
  it('has no expense that scales with rent, so typing rent moves no expense line', () => {
    const globals = { ...DEFAULT_GLOBAL_PARAMETERS, propertyTaxRate: 1 };
    const low = analyzeHouse('$400,000', 100, { monthlyRent: 1500 }, globals);
    const high = analyzeHouse('$400,000', 100, { monthlyRent: 4500 }, globals);
    expect(low.ok && high.ok).toBe(true);
    if (!low.ok || !high.ok) return;

    expect(high.analysis.totalOperatingExpenses).toBeCloseTo(low.analysis.totalOperatingExpenses, 6);
    expect(high.analysis.vacancyLoss).toBe(0);
    expect(high.analysis.maintenance).toBe(0);
    expect(high.analysis.capEx).toBe(0);
    expect(high.analysis.management).toBe(0);
    // Income still moves -- it's only the expenses that are now rent-independent.
    expect(high.analysis.effectiveMonthlyIncome).toBeGreaterThan(low.analysis.effectiveMonthlyIncome);
  });

  it('break-even rent is exactly the fixed carrying cost when nothing scales with rent', () => {
    const result = analyzeHouse('$400,000', 100, { monthlyRent: 3000 }, { ...DEFAULT_GLOBAL_PARAMETERS, propertyTaxRate: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { analysis } = result;
    const fixedCosts = analysis.propertyTax + analysis.insurance + analysis.hoa + analysis.totalMonthlyDebtService;
    expect(analysis.breakEvenRent).toBe(Math.round(fixedCosts));
  });
});

/**
 * The unit of globalParams.interestRate changed. Older builds stored a fraction (the input
 * divided by 100 and the display multiplied by 100) and the mortgage class divided by 12
 * directly; the current one divides by 100 first. Reading a stored 0.07 as 0.07% collapses
 * P&I to roughly loanAmount/360, which makes every return figure hugely optimistic while
 * looking entirely plausible. This is the one migration whose absence corrupts the math.
 */
describe('legacy interest-rate rescale', () => {
  it('rescales a stored fraction to a whole percent', () => {
    expect(migrateGlobalParams({ interestRate: 0.07 }).interestRate).toBeCloseTo(7, 10);
    expect(migrateGlobalParams({ interestRate: 0.0625 }).interestRate).toBeCloseTo(6.25, 10);
  });

  it('leaves a whole percent alone', () => {
    expect(migrateGlobalParams({ interestRate: 7 }).interestRate).toBe(7);
    expect(migrateGlobalParams({ interestRate: 1 }).interestRate).toBe(1);
  });

  it('does not touch zero', () => {
    expect(migrateGlobalParams({ interestRate: 0 }).interestRate).toBe(0);
  });

  it('never rescales twice', () => {
    const once = migrateGlobalParams({ interestRate: 0.07 });
    expect(migrateGlobalParams(once).interestRate).toBeCloseTo(7, 10);
  });

  // A user who deliberately enters 0.5% after migrating must not be second-guessed.
  it('leaves a deliberate sub-1% rate alone once migrated', () => {
    expect(migrateGlobalParams({ interestRate: 0.5, paramsVersion: CURRENT_PARAMS_VERSION }).interestRate).toBe(0.5);
  });

  // The symptom the migration exists to prevent, stated as arithmetic.
  it('a fractional rate read as a percent would collapse the mortgage payment', () => {
    const unmigrated = analyzeHouse('$400,000', 0, { monthlyRent: 3000 },
      { ...DEFAULT_GLOBAL_PARAMETERS, propertyTaxRate: 1, interestRate: 0.07 });
    const migrated = analyzeHouse('$400,000', 0, { monthlyRent: 3000 },
      { ...DEFAULT_GLOBAL_PARAMETERS, propertyTaxRate: 1, ...migrateGlobalParams({ interestRate: 0.07 }) });
    expect(unmigrated.ok && migrated.ok).toBe(true);
    if (!unmigrated.ok || !migrated.ok) return;
    // 0.07% on a $320k loan is ~$890/mo; 7% is ~$2,129.
    expect(migrated.analysis.monthlyPrincipalAndInterest)
      .toBeGreaterThan(unmigrated.analysis.monthlyPrincipalAndInterest * 2);
    expect(migrated.analysis.monthlyPrincipalAndInterest).toBeCloseTo(2129, 0);
  });
});


/**
 * v3 moved the card metric selection under the mode it belongs to. It was one flat array,
 * which could only ever have been a rental selection, so it becomes that mode's entry.
 */
describe('v3: per-mode card metrics', () => {
  it('files a legacy flat selection under rental', () => {
    const migrated = migrateGlobalParams({
      cardMetrics: ['grm', 'opexRatio', 'dscr'] as never,
      paramsVersion: 2
    });
    expect(migrated.cardMetrics).toEqual({ rental: ['grm', 'opexRatio', 'dscr'] });
  });

  it('keys off the stored shape, so a lost paramsVersion still migrates', () => {
    const migrated = migrateGlobalParams({ cardMetrics: ['dscr'] as never });
    expect(Array.isArray(migrated.cardMetrics)).toBe(false);
    expect(migrated.cardMetrics.rental).toEqual(['dscr']);
  });

  it('leaves an already-migrated selection alone', () => {
    const migrated = migrateGlobalParams({
      cardMetrics: { rental: ['capRate', 'grm', 'dscr'] },
      paramsVersion: 3
    });
    expect(migrated.cardMetrics).toEqual({ rental: ['capRate', 'grm', 'dscr'] });
  });

  it('replaces a selection that is neither an array nor an object', () => {
    expect(migrateGlobalParams({ cardMetrics: 'nonsense' as never }).cardMetrics).toEqual({});
  });

  /** A metric one mode offers must not leak into another's strip. */
  it('drops keys the mode does not offer rather than rendering them', () => {
    const resolved = resolveCardMetrics(
      ['dscr', 'capRate'] as never,
      ['grm', 'opexRatio', 'breakEvenRent'],
      ['grm', 'opexRatio', 'breakEvenRent']
    );
    expect(resolved).toEqual(['grm', 'opexRatio', 'breakEvenRent']);
  });

  /** Backfilling only from defaults would under-fill a mode with fewer than three of them. */
  it('backfills past the defaults from anything else the mode offers', () => {
    const resolved = resolveCardMetrics([] as never, ['capRate', 'grm', 'dscr'], ['capRate']);
    expect(resolved).toHaveLength(CARD_METRIC_COUNT);
    expect(resolved[0]).toBe('capRate');
  });
});
