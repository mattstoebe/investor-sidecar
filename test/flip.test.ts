import { describe, expect, it } from 'vitest';
import { analyzeFlip, FLIP_METRICS } from '../src/flip';
import { MODES } from '../src/modes';
import { DEFAULT_GLOBAL_PARAMETERS } from '../src/App';
import { MortgageCalculator } from '../src/core-utils';
import type { GlobalParameters } from '../src/App';
import type { FlipAnalysis } from '../src/flip';

/**
 * The flip model. Nothing here has a monthly cash flow, an NOI, a cap rate or a DSCR: the deal
 * is one profit at the end, and the clock is a cost.
 */

const globals: GlobalParameters = {
  ...DEFAULT_GLOBAL_PARAMETERS,
  propertyTaxRate: 1.2,
  interestRate: 8,
  percentDown: 20,
  closingCostRate: 3,
  insuranceRate: 0.35
};

const inputs = (over: Partial<Parameters<typeof analyzeFlip>[4]> = {}) => ({
  arv: 520000,
  rehabBudget: 45000,
  holdMonths: 6,
  sellingCostRate: 7,
  maoRulePercent: 70,
  ...over
});

const run = (over = {}, globalsOver: Partial<GlobalParameters> = {}) =>
  analyzeFlip('$400,000', 0, {}, { ...globals, ...globalsOver }, inputs(over));

const ok = (result: ReturnType<typeof analyzeFlip>): FlipAnalysis => {
  if (!result.ok) throw new Error(`expected an analysis, got: ${result.reason}`);
  return result.analysis;
};

describe('flip arithmetic', () => {
  it('computes profit as the sale less every cost of getting to it', () => {
    const a = ok(run());
    // $400k purchase, 20% down, 8% over 30y, 6 months held, 3% acquisition, 7% selling.
    expect(a.acquisitionCosts).toBeCloseTo(12000, 6);
    expect(a.sellingCosts).toBeCloseTo(36400, 6);
    expect(a.totalProjectCost).toBeCloseTo(
      400000 + 45000 + a.acquisitionCosts + a.holdingCosts + a.sellingCosts, 6
    );
    expect(a.netProfit).toBeCloseTo(520000 - a.totalProjectCost, 6);
  });

  it('carries the property for exactly the months held', () => {
    const six = ok(run({ holdMonths: 6 }));
    const twelve = ok(run({ holdMonths: 12 }));
    expect(twelve.holdingCosts).toBeCloseTo(six.holdingCosts * 2, 6);
    expect(six.holdingCosts).toBeCloseTo(six.monthlyHoldingCost * 6, 6);
  });

  /** Carrying costs are the thing a flip that runs long actually loses to. */
  it('turns a profitable deal unprofitable if it is held long enough', () => {
    expect(ok(run({ holdMonths: 3 })).netProfit).toBeGreaterThan(0);
    expect(ok(run({ holdMonths: 48 })).netProfit).toBeLessThan(0);
  });

  it('counts the loan out of pocket, but not the part the lender funds', () => {
    const a = ok(run());
    // Down payment + rehab + acquisition + holding. The other $320k is the lender's.
    expect(a.totalCashInvested).toBeCloseTo(80000 + 45000 + a.acquisitionCosts + a.holdingCosts, 6);
    expect(a.loanAmount).toBeCloseTo(320000, 6);
  });

  it('reports return on the cash actually invested', () => {
    const a = ok(run());
    expect(a.roi).toBeCloseTo((a.netProfit / a.totalCashInvested) * 100, 6);
  });

  /** A 3-month and a 12-month deal are not comparable until the clock is normalised. */
  it('annualizes so deals of different lengths can be compared', () => {
    const a = ok(run({ holdMonths: 6 }));
    expect(a.annualizedRoi).toBeCloseTo((a.roi as number) * 2, 6);
    const quarter = ok(run({ holdMonths: 3 }));
    expect(quarter.annualizedRoi).toBeCloseTo((quarter.roi as number) * 4, 6);
  });

  it('has no return to report when no cash is invested', () => {
    const a = ok(analyzeFlip('$400,000', 0, {}, { ...globals, closingCostRate: 0 },
      inputs({ rehabBudget: 0, holdMonths: 1 })));
    // 100% financed, no rehab, no closing costs -- holding costs are still cash, so this
    // only proves the null path exists where the divisor would be zero.
    expect(a.totalCashInvested).toBeGreaterThan(0);
    const nothing = ok(analyzeFlip('$400,000', 0, { percentDown: 0 },
      { ...globals, closingCostRate: 0, propertyTaxRate: 0, insuranceRate: 0, interestRate: 0 },
      inputs({ rehabBudget: 0, holdMonths: 1, sellingCostRate: 0 })));
    expect(nothing.totalCashInvested).toBe(0);
    expect(nothing.roi).toBeNull();
    expect(nothing.annualizedRoi).toBeNull();
  });
});

/**
 * The 70% rule as a parameter rather than a constant. Markets run it at 65-75, and a buried
 * 0.70 is exactly the sort of unexplained number that makes people distrust a calculator.
 */
describe('maximum allowable offer', () => {
  it('is ARV times the rule, less rehab', () => {
    expect(ok(run()).mao).toBeCloseTo(520000 * 0.7 - 45000, 6);
  });

  it('moves with the rule the user chose', () => {
    expect(ok(run({ maoRulePercent: 65 })).mao).toBeCloseTo(520000 * 0.65 - 45000, 6);
    expect(ok(run({ maoRulePercent: 75 })).mao).toBeCloseTo(520000 * 0.75 - 45000, 6);
  });

  it('reports headroom against the asking price, which is what makes it actionable', () => {
    const a = ok(run());
    expect(a.maoHeadroom).toBeCloseTo(a.mao - 400000, 6);
    // $319k max offer on a $400k listing: not close.
    expect(a.maoHeadroom).toBeLessThan(0);
  });

  it('is positive when the listing is already inside the rule', () => {
    const a = ok(analyzeFlip('$250,000', 0, {}, globals, inputs()));
    expect(a.maoHeadroom).toBeGreaterThan(0);
  });
});

describe('flip validation', () => {
  it('rejects an after-repair value that is not a number, or is negative', () => {
    for (const arv of [-1, NaN]) {
      const result = analyzeFlip('$400,000', 0, {}, globals, inputs({ arv }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/after-repair value/i);
    }
  });

  /**
   * Zero is "not entered yet", not a mistake. The mode's `requires` turns it into a prompt, so
   * the kernel must compute rather than fail -- otherwise the card shows a validation error
   * for a field the user has not reached yet, which reads as being told off for nothing.
   */
  it('computes for an unentered value, leaving the prompt to the mode', () => {
    expect(analyzeFlip('$400,000', 0, {}, globals, inputs({ arv: 0 })).ok).toBe(true);
    expect(MODES.flip.requires).toContain('arv');
  });

  it('rejects a negative rehab budget but allows a cosmetic flip with none', () => {
    expect(analyzeFlip('$400,000', 0, {}, globals, inputs({ rehabBudget: -1 })).ok).toBe(false);
    expect(analyzeFlip('$400,000', 0, {}, globals, inputs({ rehabBudget: 0 })).ok).toBe(true);
  });

  it('needs to be held for at least a month', () => {
    expect(analyzeFlip('$400,000', 0, {}, globals, inputs({ holdMonths: 0 })).ok).toBe(false);
  });

  it('reports an unreadable price the same way a rental does, rather than throwing', () => {
    const result = analyzeFlip('Contact agent', 0, {}, globals, inputs());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/readable price/i);
  });
});

describe('flip metrics', () => {
  it('formats and tones every metric without throwing', () => {
    const a = ok(run());
    for (const metric of FLIP_METRICS) {
      expect(typeof metric.format(a)).toBe('string');
      expect(['good', 'warn', 'bad', 'neutral']).toContain(metric.tone(a));
      const value = metric.value(a);
      expect(value === null || Number.isFinite(value)).toBe(true);
    }
  });

  it('shows a loss as a negative figure rather than an absolute one', () => {
    const a = ok(run({ holdMonths: 48 }));
    expect(a.netProfit).toBeLessThan(0);
    expect(FLIP_METRICS.find((m) => m.key === 'netProfit')!.format(a)).toMatch(/^-\$/);
  });

  it('greens the max offer only when the listing is inside the rule', () => {
    const mao = FLIP_METRICS.find((m) => m.key === 'mao')!;
    expect(mao.tone(ok(analyzeFlip('$250,000', 0, {}, globals, inputs())))).toBe('good');
    expect(mao.tone(ok(run()))).toBe('bad');
  });
});

/** The mode wrapper, which is what the card and the export actually call. */
describe('flip through the mode seam', () => {
  const input = (overrides = {}) => ({
    house: { price: '$400,000', hoa: 0, sqft: '1800' },
    overrides: { arv: 520000, rehabBudget: 45000, ...overrides },
    globals
  });

  it('tags its analysis and promotes the shared summary', () => {
    const result = MODES.flip.analyze(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.analysis.mode).toBe('flip');
    expect(result.analysis.summary.price).toBe(400000);
    expect(result.analysis.summary.totalCashInvested)
      .toBe((result.analysis.detail as FlipAnalysis).totalCashInvested);
  });

  it('falls back to the panel defaults for everything but the two per-house facts', () => {
    const result = MODES.flip.analyze(input());
    if (!result.ok) return;
    const detail = result.analysis.detail as FlipAnalysis;
    expect(detail.holdMonths).toBe(DEFAULT_GLOBAL_PARAMETERS.holdMonths);
    expect(detail.mao).toBeCloseTo(520000 * (globals.maoRulePercent / 100) - 45000, 6);
  });

  it('takes a per-house override over the panel default', () => {
    const result = MODES.flip.analyze(input({ holdMonths: 12 }));
    if (!result.ok) return;
    expect((result.analysis.detail as FlipAnalysis).holdMonths).toBe(12);
  });

  /** Missing input is a prompt, not an error -- a flip without an ARV is unfinished. */
  it('asks for the after-repair value rather than reporting a failure', () => {
    expect(MODES.flip.requires).toEqual(['arv']);
  });
});

describe('MortgageCalculator.getBalanceAtMonth', () => {
  const loan = () => new MortgageCalculator(400000, 80000, 7, 30);

  it('owes the whole loan before the first payment', () => {
    expect(loan().getBalanceAtMonth(0)).toBe(320000);
  });

  it('is the loan less what has been paid down', () => {
    const m = loan();
    expect(m.getBalanceAtMonth(12)).toBeCloseTo(320000 - m.getCumulativePrincipalPaid(12), 6);
  });

  it('falls over the life of the loan', () => {
    const m = loan();
    expect(m.getBalanceAtMonth(24)).toBeLessThan(m.getBalanceAtMonth(12));
  });

  /** Past the term the loan is simply paid off; a negative balance would read as the
   *  lender owing the borrower. */
  it('never goes below zero', () => {
    expect(loan().getBalanceAtMonth(500)).toBe(0);
  });

  it('rejects a negative month rather than guessing', () => {
    expect(() => loan().getBalanceAtMonth(-1)).toThrow();
  });
});
