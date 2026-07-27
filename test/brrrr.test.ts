import { describe, expect, it } from 'vitest';
import { analyzeBrrrr, BRRRR_METRICS } from '../src/brrrr';
import { MODES } from '../src/modes';
import { DEFAULT_GLOBAL_PARAMETERS } from '../src/App';
import type { GlobalParameters } from '../src/App';
import type { BrrrrAnalysis } from '../src/brrrr';

/**
 * The composition case: flip's acquisition and rehab, a refinance, then a rental's operations
 * against the new loan.
 *
 * The number people run a BRRRR for is how much of their money comes back out, so most of
 * what is pinned here is about the refinance rather than the arithmetic either half already
 * has tests for.
 */

const globals: GlobalParameters = {
  ...DEFAULT_GLOBAL_PARAMETERS,
  propertyTaxRate: 1.2,
  interestRate: 8,
  percentDown: 20,
  closingCostRate: 3,
  insuranceRate: 0.35,
  refiLtv: 75,
  refiRate: 7.5,
  refiCostRate: 2,
  seasoningMonths: 6
};

const inputs = (over: Partial<Parameters<typeof analyzeBrrrr>[4]> = {}) => ({
  arv: 520000,
  rehabBudget: 45000,
  holdMonths: 6,
  seasoningMonths: 6,
  refiLtv: 75,
  refiRate: 7.5,
  refiCostRate: 2,
  monthlyRent: 3200,
  ...over
});

const run = (over = {}, globalsOver: Partial<GlobalParameters> = {}) =>
  analyzeBrrrr('$400,000', 0, {}, { ...globals, ...globalsOver }, inputs(over));

const ok = (result: ReturnType<typeof analyzeBrrrr>): BrrrrAnalysis => {
  if (!result.ok) throw new Error(`expected an analysis, got: ${result.reason}`);
  return result.analysis;
};

describe('the refinance', () => {
  it('lends against the after-repair value, not what was paid', () => {
    expect(ok(run()).newLoan).toBeCloseTo(520000 * 0.75, 6);
  });

  it('pays off what is still owed on the original loan', () => {
    const a = ok(run());
    // 12 months of amortization on a $320k loan: a little below the original balance.
    expect(a.originalLoanPayoff).toBeLessThan(320000);
    expect(a.originalLoanPayoff).toBeGreaterThan(310000);
  });

  it('waits out the seasoning period before lending against the new value', () => {
    const none = ok(run({ seasoningMonths: 0 }));
    const long = ok(run({ seasoningMonths: 18 }));
    // More seasoning means more amortization, so less is owed at payoff.
    expect(long.originalLoanPayoff).toBeLessThan(none.originalLoanPayoff);
  });

  it('returns the new loan less the payoff and the cost of getting it', () => {
    const a = ok(run());
    expect(a.cashOut).toBeCloseTo(a.newLoan - a.originalLoanPayoff - a.refiCosts, 6);
    expect(a.refiCosts).toBeCloseTo(a.newLoan * 0.02, 6);
  });

  it('leaves behind whatever the cash out did not cover', () => {
    const a = ok(run());
    expect(a.cashLeftInDeal).toBeCloseTo(a.phaseACashInvested - a.cashOut, 6);
  });

  it('reports the value the work created', () => {
    expect(ok(run()).equityCaptured).toBeCloseTo(520000 - (400000 + 45000), 6);
  });

  it('captures no equity when the rehab costs what it adds', () => {
    expect(ok(run({ arv: 445000 })).equityCaptured).toBeCloseTo(0, 6);
  });
});

/**
 * The strategy working looks like every dollar coming back out. That is not an infinite
 * return -- it is an undefined one, and saying "infinite" would be the calculator inventing a
 * number where there is a division by nothing.
 */
describe('when all the capital comes back out', () => {
  const allOut = () => run({ arv: 900000 });

  it('leaves nothing in the deal', () => {
    expect(ok(allOut()).cashLeftInDeal).toBeLessThanOrEqual(0);
  });

  it('reports no return rather than an infinite one', () => {
    expect(ok(allOut()).postRefiCoC).toBeNull();
  });

  it('says so in words instead of showing a number', () => {
    const a = ok(allOut());
    expect(BRRRR_METRICS.find((m) => m.key === 'cashLeftInDeal')!.format(a)).toBe('All out');
    expect(BRRRR_METRICS.find((m) => m.key === 'postRefiCoC')!.format(a)).toBe('∞');
  });

  it('reads that as the best outcome, not a missing one', () => {
    const a = ok(allOut());
    expect(BRRRR_METRICS.find((m) => m.key === 'cashLeftInDeal')!.tone(a)).toBe('good');
    expect(BRRRR_METRICS.find((m) => m.key === 'postRefiCoC')!.tone(a)).toBe('good');
  });
});

describe('operating it afterwards', () => {
  it('services the new loan, not the one it replaced', () => {
    const a = ok(run());
    const cheaper = ok(run({ refiRate: 4 }));
    expect(cheaper.postRefiPayment).toBeLessThan(a.postRefiPayment);
    expect(cheaper.postRefiCashFlow).toBeGreaterThan(a.postRefiCashFlow);
  });

  it('yields against what the asset is now worth', () => {
    const a = ok(run());
    expect(a.capRate).toBeCloseTo((a.annualNOI / 520000) * 100, 6);
  });

  /**
   * Tax and insurance scale off ARV, not the purchase price: that is what it is worth and
   * insured for, and after improvements of this size close to what it is assessed at. The
   * conservative reading, which is the right direction to be wrong in when underwriting.
   */
  it('bases ongoing costs on the after-repair value', () => {
    const low = ok(run({ arv: 460000 }));
    const high = ok(run({ arv: 620000 }));
    expect(high.totalOperatingExpenses).toBeGreaterThan(low.totalOperatingExpenses);
  });

  it('covers the debt when the rent supports it, and says so', () => {
    const a = ok(run());
    expect(a.refiDscr).toBeCloseTo(a.annualNOI / (a.postRefiPayment * 12), 6);
  });

  it('has no coverage ratio with no loan to cover', () => {
    expect(ok(run({ refiLtv: 0 })).refiDscr).toBeNull();
  });
});

describe('brrrr validation', () => {
  it('rejects a negative after-repair value but computes an unentered one', () => {
    expect(analyzeBrrrr('$400,000', 0, {}, globals, inputs({ arv: -1 })).ok).toBe(false);
    expect(analyzeBrrrr('$400,000', 0, {}, globals, inputs({ arv: 0 })).ok).toBe(true);
  });

  it('keeps the refinance LTV a share of a whole', () => {
    expect(analyzeBrrrr('$400,000', 0, {}, globals, inputs({ refiLtv: 101 })).ok).toBe(false);
    expect(analyzeBrrrr('$400,000', 0, {}, globals, inputs({ refiLtv: -1 })).ok).toBe(false);
  });

  it('needs a rehab period of at least a month', () => {
    expect(analyzeBrrrr('$400,000', 0, {}, globals, inputs({ holdMonths: 0 })).ok).toBe(false);
  });

  it('reports an unreadable price rather than throwing', () => {
    const result = analyzeBrrrr('Contact agent', 0, {}, globals, inputs());
    expect(result.ok).toBe(false);
  });
});

describe('brrrr through the mode seam', () => {
  const input = (overrides = {}) => ({
    house: { price: '$400,000', hoa: 0, sqft: '1800' },
    overrides: { arv: 520000, rehabBudget: 45000, monthlyRent: 3200, ...overrides },
    globals
  });

  it('tags its analysis', () => {
    const result = MODES.brrrr.analyze(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.analysis.mode).toBe('brrrr');
  });

  /**
   * The shared summary reports what is *still* tied up, not what went in before the
   * refinance handed most of it back -- that is the figure a BRRRR is judged on, and the one
   * a mixed board should rank it by.
   */
  it('summarises cash in the deal as what is left after the refinance', () => {
    const result = MODES.brrrr.analyze(input());
    if (!result.ok) return;
    const detail = result.analysis.detail as BrrrrAnalysis;
    expect(result.analysis.summary.totalCashInvested).toBe(detail.cashLeftInDeal);
    expect(detail.cashLeftInDeal).toBeLessThan(detail.phaseACashInvested);
  });

  it('needs both an after-repair value and a rent', () => {
    expect(MODES.brrrr.requires).toEqual(['arv', 'monthlyRent']);
  });

  it('formats and tones every metric it offers', () => {
    const result = MODES.brrrr.analyze(input());
    if (!result.ok) return;
    for (const metric of MODES.brrrr.metrics) {
      expect(typeof metric.format(result.analysis.detail)).toBe('string');
      expect(['good', 'warn', 'bad', 'neutral']).toContain(metric.tone(result.analysis.detail));
    }
  });
});
