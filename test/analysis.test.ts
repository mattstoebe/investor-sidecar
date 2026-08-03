import { describe, expect, it } from 'vitest';
import { parseMoney, resolveParams, analyzeHouse } from '../src/analysis';
import type { AnalysisGlobals } from '../src/analysis';

// A globals object with every rate at 0 reduces to the old P&I + tax + HOA model,
// which keeps the "normal listing" numbers below hand-checkable against a plain
// amortization calculator.
const bareGlobals: AnalysisGlobals = {
  percentDown: 20,
  interestRate: 7,
  propertyTaxRate: 1,
  maxDown: null
};

// A globals object with realistic operating assumptions, for exercising the full P&L.
const fullGlobals: AnalysisGlobals = {
  percentDown: 20,
  interestRate: 7,
  propertyTaxRate: 1,
  maxDown: null,
  vacancyRate: 5,
  maintenanceRate: 5,
  capExRate: 5,
  managementRate: 8,
  insuranceRate: 0.35,
  closingCostRate: 3,
  pmiRate: 0.5
};

describe('parseMoney', () => {
  it('parses a formatted listing price', () => {
    expect(parseMoney('$425,000')).toBe(425000);
  });

  it('parses a plain number', () => {
    expect(parseMoney(425000)).toBe(425000);
  });

  it('expands the abbreviations Redfin uses on map cards', () => {
    expect(parseMoney('$1.2M')).toBe(1_200_000);
    expect(parseMoney('$950K')).toBe(950_000);
  });

  // The old Sanitizer threw on these, which is what made cards disappear.
  it.each(['N/A', '', '   ', 'Contact agent', null, undefined])(
    'returns null rather than throwing for %s',
    (input) => {
      expect(parseMoney(input as string)).toBeNull();
    }
  );

  it('does not silently truncate a price it cannot fully parse', () => {
    // parseFloat('1.2M') used to yield 1.2 and mortgage a $1.20 house.
    expect(parseMoney('1.2 million dollars')).not.toBe(1.2);
  });
});

describe('resolveParams', () => {
  it('explains a missing price instead of failing silently', () => {
    const result = resolveParams('N/A', 0, {}, bareGlobals);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/readable price/i);
  });

  it('rejects a zero price with a usable message', () => {
    const result = resolveParams('$0', 0, {}, bareGlobals);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/greater than \$0/);
  });

  it('prefers a per-house override over the scraped price', () => {
    const result = resolveParams('$425,000', 0, { price: 500000 }, bareGlobals);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.params.price).toBe(500000);
  });

  it('falls back to global parameters when no override is set', () => {
    const result = resolveParams('$400,000', 0, {}, bareGlobals);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.params.downPaymentPercent).toBe(20);
      expect(result.params.interestRate).toBe(7);
      expect(result.params.downPayment).toBe(80000);
    }
  });

  it('caps the down payment at maxDown', () => {
    const result = resolveParams('$400,000', 0, {}, { ...bareGlobals, maxDown: 50000 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.params.downPayment).toBe(50000);
  });

  // MortgageCalculator throws outright if downPayment > price.
  it('never lets the down payment exceed the price', () => {
    const result = resolveParams('$300,000', 0, { percentDown: 100 }, { ...bareGlobals, maxDown: 999999999 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.params.downPayment).toBe(300000);
  });

  it('treats a missing HOA as zero rather than NaN', () => {
    const result = resolveParams('$400,000', null, {}, bareGlobals);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.params.monthlyHOA).toBe(0);
  });

  it('reports rate fields as inherited from globals when not overridden', () => {
    const result = resolveParams('$400,000', 0, {}, fullGlobals);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.params.vacancyRate).toBe(5);
      expect(result.params.isOverridden.vacancyRate).toBe(false);
    }
  });

  it('reports rate fields as overridden when a per-house value is set', () => {
    const result = resolveParams('$400,000', 0, { vacancyRate: 10 }, fullGlobals);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.params.vacancyRate).toBe(10);
      expect(result.params.isOverridden.vacancyRate).toBe(true);
      // Untouched fields stay attributed to globals.
      expect(result.params.isOverridden.maintenanceRate).toBe(false);
    }
  });

  it('rejects a negative rate with a field-specific message', () => {
    const result = resolveParams('$400,000', 0, { maintenanceRate: -1 }, fullGlobals);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Maintenance rate/);
  });

  it('keeps page-reported annual tax as a fixed amount when no rate override exists', () => {
    const result = resolveParams('$400,000', 0, {}, bareGlobals, 6000);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.params.annualPropertyTax).toBe(6000);
  });

  it('lets a per-house tax-rate override win over page-reported tax', () => {
    const result = resolveParams('$400,000', 0, { propertyTaxRate: 2 }, bareGlobals, 6000);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.params.annualPropertyTax).toBeNull();
  });
});

describe('analyzeHouse - bare model (all rates at 0)', () => {
  it('computes cashflow equal to the plain P&I + tax + HOA model', () => {
    const result = analyzeHouse('$400,000', 0, { monthlyRent: 3000 }, bareGlobals);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { analysis } = result;
    // $320k at 7% over 30y is ~$2,129/mo; tax at 1% is ~$333/mo.
    expect(analysis.monthlyPrincipalAndInterest).toBeCloseTo(2129.11, 0);
    expect(analysis.propertyTax).toBeCloseTo(333.33, 2);
    expect(analysis.totalMonthlyExpenses).toBeCloseTo(2462.44, 0);
    expect(analysis.monthlyCashFlow).toBeCloseTo(537.56, 0);
    expect(analysis.cashOnCashReturn).toBeCloseTo(8.06, 1);
  });

  it('includes HOA in expenses', () => {
    const withHoa = analyzeHouse('$400,000', 250, { monthlyRent: 3000 }, bareGlobals);
    const without = analyzeHouse('$400,000', 0, { monthlyRent: 3000 }, bareGlobals);
    expect(withHoa.ok && without.ok).toBe(true);
    if (!withHoa.ok || !without.ok) return;
    expect(withHoa.analysis.totalMonthlyExpenses - without.analysis.totalMonthlyExpenses).toBeCloseTo(250, 5);
  });

  it('uses enriched annual property tax before the global percentage fallback', () => {
    const result = analyzeHouse('$400,000', 0, { monthlyRent: 3000 }, bareGlobals, 6000);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.analysis.propertyTax).toBe(500);
  });

  it('uses the explicit house tax rate before enriched annual tax', () => {
    const result = analyzeHouse(
      '$400,000', 0, { monthlyRent: 3000, propertyTaxRate: 2 }, bareGlobals, 6000
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.analysis.propertyTax).toBeCloseTo(666.67, 2);
  });

  // Was Infinity, and rendered to the user as the string "Infinity%".
  it('reports cash-on-cash as null when nothing is invested', () => {
    const result = analyzeHouse('$400,000', 0, { percentDown: 0, monthlyRent: 3000 }, bareGlobals);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.analysis.cashOnCashReturn).toBeNull();
  });

  it('still computes expenses with no rent entered', () => {
    const result = analyzeHouse('$400,000', 0, {}, bareGlobals);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.analysis.totalMonthlyExpenses).toBeGreaterThan(0);
      expect(result.analysis.monthlyCashFlow).toBeLessThan(0);
    }
  });

  it('returns a reason, never a throw, for an unusable listing', () => {
    expect(() => analyzeHouse('N/A', null, {}, bareGlobals)).not.toThrow();
    const result = analyzeHouse('N/A', null, {}, bareGlobals);
    expect(result.ok).toBe(false);
  });

  it('reports break-even rent as the point where cashflow is zero', () => {
    const result = analyzeHouse('$400,000', 100, { monthlyRent: 0 }, bareGlobals);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const atBreakEven = analyzeHouse(
      '$400,000',
      100,
      { monthlyRent: result.analysis.breakEvenRent },
      bareGlobals
    );
    expect(atBreakEven.ok).toBe(true);
    if (atBreakEven.ok) expect(atBreakEven.analysis.monthlyCashFlow).toBeCloseTo(0, 0);
  });
});

describe('analyzeHouse - full operating model', () => {
  it('deducts vacancy before computing effective income', () => {
    const result = analyzeHouse('$400,000', 0, { monthlyRent: 2000 }, fullGlobals);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.analysis.vacancyLoss).toBeCloseTo(100, 2); // 5% of 2000
    expect(result.analysis.effectiveMonthlyIncome).toBeCloseTo(1900, 2);
  });

  it('charges management fee on effective (post-vacancy) income, not gross rent', () => {
    const result = analyzeHouse('$400,000', 0, { monthlyRent: 2000 }, fullGlobals);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 8% of (2000 - 100 vacancy) = 8% of 1900 = 152, not 8% of 2000 = 160.
    expect(result.analysis.management).toBeCloseTo(152, 2);
  });

  it('NOI excludes debt service entirely', () => {
    const result = analyzeHouse('$400,000', 0, { monthlyRent: 2500 }, fullGlobals);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { analysis } = result;
    expect(analysis.monthlyNOI).toBeCloseTo(
      analysis.effectiveMonthlyIncome - analysis.totalOperatingExpenses,
      6
    );
    // Cash flow is NOI after debt service -- the one line where financing enters.
    expect(analysis.monthlyNOI - analysis.totalMonthlyDebtService).toBeCloseTo(
      analysis.monthlyCashFlow,
      6
    );
  });

  it('cap rate is annual NOI over price, independent of financing', () => {
    const cash = analyzeHouse('$400,000', 0, { monthlyRent: 2500, percentDown: 100 }, fullGlobals);
    const financed = analyzeHouse('$400,000', 0, { monthlyRent: 2500, percentDown: 20 }, fullGlobals);
    expect(cash.ok && financed.ok).toBe(true);
    if (!cash.ok || !financed.ok) return;
    // Cap rate must be identical regardless of how the deal is financed.
    expect(cash.analysis.capRate).toBeCloseTo(financed.analysis.capRate, 6);
  });

  it('applies PMI under 20% down and omits it at or above 20%', () => {
    const under = analyzeHouse('$400,000', 0, { monthlyRent: 2500, percentDown: 10 }, fullGlobals);
    const atThreshold = analyzeHouse('$400,000', 0, { monthlyRent: 2500, percentDown: 20 }, fullGlobals);
    expect(under.ok && atThreshold.ok).toBe(true);
    if (!under.ok || !atThreshold.ok) return;
    expect(under.analysis.pmi).toBeGreaterThan(0);
    expect(atThreshold.analysis.pmi).toBe(0);
  });

  // The cliff used to test the *requested* percent, so a maxDown that clamped a 25% request
  // down to 10% of price skipped PMI on what is really a 10%-down loan.
  it('applies PMI when maxDown clamps a nominally-20%+ down payment below the threshold', () => {
    const result = analyzeHouse(
      '$400,000',
      0,
      { monthlyRent: 2500, percentDown: 25 },
      { ...fullGlobals, maxDown: 40000 } // 10% of price
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.analysis.params.downPaymentPercent).toBe(25);
    expect(result.analysis.params.effectiveDownPaymentPercent).toBeCloseTo(10, 6);
    expect(result.analysis.pmi).toBeGreaterThan(0);
  });

  it('leaves PMI off when maxDown does not bite', () => {
    const result = analyzeHouse(
      '$400,000',
      0,
      { monthlyRent: 2500, percentDown: 25 },
      { ...fullGlobals, maxDown: 200000 }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.analysis.params.effectiveDownPaymentPercent).toBeCloseTo(25, 6);
    expect(result.analysis.pmi).toBe(0);
  });

  it('DSCR excludes PMI from the debt service it divides by', () => {
    const result = analyzeHouse('$400,000', 0, { monthlyRent: 2500, percentDown: 10 }, fullGlobals);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expectedDscr = result.analysis.annualNOI / (result.analysis.monthlyPrincipalAndInterest * 12);
    expect(result.analysis.dscr).toBeCloseTo(expectedDscr, 6);
  });

  it('DSCR is null with no loan (all cash)', () => {
    const result = analyzeHouse('$400,000', 0, { monthlyRent: 2500, percentDown: 100 }, fullGlobals);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.analysis.dscr).toBeNull();
  });

  it('gross rent multiplier is price over annual gross rent', () => {
    const result = analyzeHouse('$400,000', 0, { monthlyRent: 2000 }, fullGlobals);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.analysis.grossRentMultiplier).toBeCloseTo(400000 / 24000, 4);
  });

  it('gross rent multiplier is null with no rent entered', () => {
    const result = analyzeHouse('$400,000', 0, {}, fullGlobals);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.analysis.grossRentMultiplier).toBeNull();
  });

  it('closing costs are included in total cash invested but not down payment', () => {
    const result = analyzeHouse('$400,000', 0, { monthlyRent: 2500 }, fullGlobals);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 20% down = 80,000; 3% closing costs on 400,000 = 12,000.
    expect(result.analysis.totalCashInvested).toBeCloseTo(80000 + 12000, 2);
  });

  it('total return with equity is at least the cash-on-cash return when there is a loan', () => {
    const result = analyzeHouse('$400,000', 0, { monthlyRent: 2500 }, fullGlobals);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.analysis.year1PrincipalPaydown).toBeGreaterThan(0);
    expect(result.analysis.totalReturnWithEquity).not.toBeNull();
    expect(result.analysis.totalReturnWithEquity!).toBeGreaterThan(result.analysis.cashOnCashReturn!);
  });

  it('break-even rent still zeroes out cash flow once vacancy/maintenance/capEx/management scale with rent', () => {
    const probe = analyzeHouse('$400,000', 100, { monthlyRent: 1000 }, fullGlobals);
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;

    const atBreakEven = analyzeHouse(
      '$400,000',
      100,
      { monthlyRent: probe.analysis.breakEvenRent },
      fullGlobals
    );
    expect(atBreakEven.ok).toBe(true);
    if (atBreakEven.ok) expect(atBreakEven.analysis.monthlyCashFlow).toBeCloseTo(0, 0);
  });

  it('operating expense ratio and break-even occupancy are null with no rent', () => {
    const result = analyzeHouse('$400,000', 0, {}, fullGlobals);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.analysis.operatingExpenseRatio).toBeNull();
      expect(result.analysis.breakEvenOccupancy).toBeNull();
    }
  });

  // breakEvenRent and breakEvenOccupancy are two inversions of the same cash-flow model, so at
  // the break-even rent the break-even occupancy must be exactly the occupancy already assumed
  // (100 - vacancy). This only holds if occupancy accounts for the rent-scaled expenses, which
  // is what the old fixed-expense formula got wrong.
  it('break-even occupancy is the dual of break-even rent', () => {
    const probe = analyzeHouse('$400,000', 100, { monthlyRent: 1000 }, fullGlobals);
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;

    const atBreakEven = analyzeHouse(
      '$400,000',
      100,
      { monthlyRent: probe.analysis.breakEvenRent },
      fullGlobals
    );
    expect(atBreakEven.ok).toBe(true);
    if (!atBreakEven.ok) return;
    // breakEvenRent is rounded to the dollar, so allow a little slack.
    expect(atBreakEven.analysis.breakEvenOccupancy!).toBeCloseTo(100 - fullGlobals.vacancyRate!, 1);
  });

  it('break-even occupancy reduces to fixed costs over rent when no expense scales with rent', () => {
    const noScaling: AnalysisGlobals = {
      ...fullGlobals,
      vacancyRate: 0,
      maintenanceRate: 0,
      capExRate: 0,
      managementRate: 0
    };
    const result = analyzeHouse('$400,000', 100, { monthlyRent: 3000 }, noScaling);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { analysis } = result;
    const fixedCosts = analysis.propertyTax + analysis.insurance + analysis.hoa
      + analysis.totalMonthlyDebtService;
    expect(analysis.breakEvenOccupancy!).toBeCloseTo((fixedCosts / 3000) * 100, 6);
  });

  it('break-even occupancy is null rather than Infinity at a 100% management rate', () => {
    const result = analyzeHouse(
      '$400,000',
      0,
      { monthlyRent: 2000, managementRate: 100 },
      fullGlobals
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.analysis.breakEvenOccupancy).toBeNull();
  });

  it('break-even occupancy can exceed 100% when no occupancy breaks even', () => {
    // Rent far below the fixed carrying cost of a $400k loan.
    const result = analyzeHouse('$400,000', 0, { monthlyRent: 500 }, fullGlobals);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.analysis.breakEvenOccupancy!).toBeGreaterThan(100);
  });

  it('a per-house rate override changes that field only, all else from globals', () => {
    const result = analyzeHouse(
      '$400,000',
      0,
      { monthlyRent: 2000, vacancyRate: 20 },
      fullGlobals
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.analysis.params.isOverridden.vacancyRate).toBe(true);
    expect(result.analysis.params.isOverridden.maintenanceRate).toBe(false);
    expect(result.analysis.vacancyLoss).toBeCloseTo(400, 2); // 20% of 2000, not the global 5%
  });
});
