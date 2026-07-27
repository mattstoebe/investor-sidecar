import { MortgageCalculator, TaxExpense, HOAExpense, AnnualRateExpense, RateOfRentExpense } from './core-utils';
import { resolveParams } from './analysis';
import type { ResolvedParams, OperatingBreakdown } from './analysis';
import type { MetricDef } from './metrics';

/**
 * Buy, rehabilitate, rent, refinance, repeat.
 *
 * The composition case: flip's acquisition and rehab, then a refinance, then a rental's
 * operations against the new loan. It is the mode that most justifies the seam existing --
 * neither existing model can express it, and both halves of it are already written.
 *
 * The number people actually run a BRRRR for is how much of their money comes back out. That
 * is `cashLeftInDeal`, and when it reaches zero the return is undefined rather than infinite:
 * you own a cash-flowing asset having ended up with none of your capital in it. Reported as
 * null, in the same discipline as every other divide-by-nothing here.
 */

/**
 * Extends OperatingBreakdown because a stabilized BRRRR *is* a rental -- the same income and
 * the same running costs, just measured against the after-repair value and serviced by a
 * different loan. Sharing the shape is what lets the card render its expense waterfall
 * instead of falling back to a bare list of rate fields.
 */
export interface BrrrrAnalysis extends OperatingBreakdown {
  /** The acquisition half, resolved exactly as a rental's and a flip's are. */
  params: ResolvedParams;

  arv: number;
  rehabBudget: number;
  holdMonths: number;
  seasoningMonths: number;

  // Phase A: buying and fixing.
  /** Interest-only while the property is unrentable. Same reasoning as flip. */
  monthlyInterest: number;
  monthlyHoldingCost: number;
  acquisitionCosts: number;
  holdingCosts: number;
  /** Everything out of pocket before the refinance returns any of it. */
  phaseACashInvested: number;

  // The refinance.
  newLoan: number;
  /** What is still owed on the original loan when the new one pays it off. */
  originalLoanPayoff: number;
  refiCosts: number;
  cashOut: number;
  /** Phase A cash less what came back. At or below zero, all the capital is out. */
  cashLeftInDeal: number;
  /** ARV less what it cost to get there: the value the work created. */
  equityCaptured: number;

  // Phase B: operating it, against the new loan. The income and expense lines themselves
  // come from OperatingBreakdown; capRate there is measured against ARV, being what the
  // asset is now worth rather than what it cost.
  postRefiPayment: number;
  postRefiCashFlow: number;
  postRefiAnnualCashFlow: number;
  /** Null when no capital remains in the deal -- see the note on this file. */
  postRefiCoC: number | null;
  /** Null with no loan, as everywhere else. */
  refiDscr: number | null;
}

export type BrrrrResult =
  | { ok: true; analysis: BrrrrAnalysis }
  | { ok: false; reason: string };

export interface BrrrrInputs {
  arv: number;
  rehabBudget: number;
  holdMonths: number;
  seasoningMonths: number;
  refiLtv: number;
  refiRate: number;
  refiCostRate: number;
  monthlyRent: number;
}

export function analyzeBrrrr(
  rawPrice: string | number | null | undefined,
  hoaMonthly: number | null | undefined,
  overrides: Parameters<typeof resolveParams>[2],
  globals: Parameters<typeof resolveParams>[3],
  inputs: BrrrrInputs
): BrrrrResult {
  const resolved = resolveParams(rawPrice, hoaMonthly, overrides, globals);
  if (!resolved.ok) return resolved;
  const { params } = resolved;

  // Zero means "not entered yet" for both of these, which the mode turns into a prompt.
  if (!Number.isFinite(inputs.arv) || inputs.arv < 0) {
    return { ok: false, reason: 'After-repair value must be zero or greater.' };
  }
  if (!Number.isFinite(inputs.rehabBudget) || inputs.rehabBudget < 0) {
    return { ok: false, reason: 'Rehab budget must be zero or greater.' };
  }
  if (!Number.isFinite(inputs.holdMonths) || inputs.holdMonths <= 0) {
    return { ok: false, reason: 'Rehab period must be at least one month.' };
  }
  if (!Number.isFinite(inputs.refiLtv) || inputs.refiLtv < 0 || inputs.refiLtv > 100) {
    return { ok: false, reason: 'Refinance LTV must be between 0 and 100%.' };
  }
  if (!Number.isFinite(inputs.refiRate) || inputs.refiRate < 0) {
    return { ok: false, reason: 'Refinance rate must be zero or greater.' };
  }

  try {
    // --- Phase A: buy and fix -------------------------------------------------------------
    const original = new MortgageCalculator(params.price, params.downPayment, params.interestRate, 30);
    const originalLoan = original.getLoanAmount();
    const monthlyInterest = new AnnualRateExpense(originalLoan, params.interestRate).getMonthlyExpense();

    // No tenant yet, so no rent-scaled expenses -- the property is a building site.
    const holdTax = new TaxExpense(params.price, params.propertyTaxRate).getMonthlyExpense();
    const holdInsurance = new AnnualRateExpense(params.price, params.insuranceRate).getMonthlyExpense();
    const hoa = new HOAExpense(params.monthlyHOA).getMonthlyExpense();
    const monthlyHoldingCost = monthlyInterest + holdTax + holdInsurance + hoa;

    const acquisitionCosts = params.price * params.closingCostRate / 100;
    const holdingCosts = monthlyHoldingCost * inputs.holdMonths;
    const phaseACashInvested =
      params.downPayment + inputs.rehabBudget + acquisitionCosts + holdingCosts
      + params.additionalCashInvestment;

    // --- The refinance --------------------------------------------------------------------
    const newLoan = inputs.arv * inputs.refiLtv / 100;
    // Seasoning is the wait a lender imposes before lending against the improved value, so it
    // is time the original loan keeps amortizing -- and time the holding costs already covered.
    const originalLoanPayoff = original.getBalanceAtMonth(inputs.holdMonths + inputs.seasoningMonths);
    const refiCosts = newLoan * inputs.refiCostRate / 100;
    const cashOut = newLoan - originalLoanPayoff - refiCosts;
    const cashLeftInDeal = phaseACashInvested - cashOut;
    const equityCaptured = inputs.arv - (params.price + inputs.rehabBudget);

    // --- Phase B: operate it --------------------------------------------------------------
    // Everything now scales off ARV, not the purchase price: that is what the asset is worth,
    // what it is insured for, and -- after improvements of this size -- close to what it will
    // be assessed at. Reassessment is genuinely jurisdiction-specific and is tracked as its
    // own piece of work; this is the conservative reading, which is the right direction to be
    // wrong in for an underwriting tool.
    const grossMonthlyRent = inputs.monthlyRent;
    const vacancyLoss = new RateOfRentExpense(grossMonthlyRent, params.vacancyRate).getMonthlyExpense();
    const effectiveMonthlyIncome = grossMonthlyRent - vacancyLoss;

    const propertyTax = new TaxExpense(inputs.arv, params.propertyTaxRate).getMonthlyExpense();
    const insurance = new AnnualRateExpense(inputs.arv, params.insuranceRate).getMonthlyExpense();
    const maintenance = new RateOfRentExpense(grossMonthlyRent, params.maintenanceRate).getMonthlyExpense();
    const capEx = new RateOfRentExpense(grossMonthlyRent, params.capExRate).getMonthlyExpense();
    const management = new RateOfRentExpense(effectiveMonthlyIncome, params.managementRate).getMonthlyExpense();
    const totalOperatingExpenses = propertyTax + insurance + hoa + maintenance + capEx + management;

    const monthlyNOI = effectiveMonthlyIncome - totalOperatingExpenses;
    const annualNOI = monthlyNOI * 12;
    const capRate = inputs.arv > 0 ? (annualNOI / inputs.arv) * 100 : 0;

    // The new loan against the new value. Expressed as a purchase of the ARV with the
    // difference as "down", which is how MortgageCalculator takes a loan of this size.
    //
    // Skipped entirely when there is no loan: an unentered ARV is a legitimate state -- the
    // mode turns it into a prompt -- and constructing a mortgage on a $0 property throws.
    const postRefiPayment = newLoan > 0
      ? new MortgageCalculator(
        Math.max(inputs.arv, newLoan), Math.max(inputs.arv - newLoan, 0), inputs.refiRate, 30
      ).calculateMonthlyPayment()
      : 0;
    const postRefiCashFlow = monthlyNOI - postRefiPayment;
    const postRefiAnnualCashFlow = postRefiCashFlow * 12;

    // The point of the strategy: no capital left in means no denominator, not an infinite
    // return. Null, and the card says so in words.
    const postRefiCoC = cashLeftInDeal > 0
      ? (postRefiAnnualCashFlow / cashLeftInDeal) * 100
      : null;
    const annualPayment = postRefiPayment * 12;
    const refiDscr = annualPayment > 0 ? annualNOI / annualPayment : null;

    return {
      ok: true,
      analysis: {
        params,
        arv: inputs.arv,
        rehabBudget: inputs.rehabBudget,
        holdMonths: inputs.holdMonths,
        seasoningMonths: inputs.seasoningMonths,
        monthlyInterest,
        monthlyHoldingCost,
        acquisitionCosts,
        holdingCosts,
        phaseACashInvested,
        newLoan,
        originalLoanPayoff,
        refiCosts,
        cashOut,
        cashLeftInDeal,
        equityCaptured,
        grossMonthlyRent,
        vacancyLoss,
        effectiveMonthlyIncome,
        propertyTax,
        insurance,
        hoa,
        maintenance,
        capEx,
        management,
        totalOperatingExpenses,
        monthlyNOI,
        annualNOI,
        capRate,
        postRefiPayment,
        postRefiCashFlow,
        postRefiAnnualCashFlow,
        postRefiCoC,
        refiDscr
      }
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'Could not compute this BRRRR.'
    };
  }
}

const EM_DASH = '—';
const money = (value: number) => `${value < 0 ? '-' : ''}$${Math.abs(Math.round(value)).toLocaleString()}`;
const percent = (value: number | null, digits = 1) =>
  value === null || !Number.isFinite(value) ? EM_DASH : `${value.toFixed(digits)}%`;

export const BRRRR_METRICS: MetricDef<BrrrrAnalysis>[] = [
  {
    key: 'cashLeftInDeal',
    aggregate: 'sum',
    label: 'Left in',
    longLabel: 'Cash left in the deal',
    testId: 'cash-left-in-deal',
    value: (a) => a.cashLeftInDeal,
    // The strategy working looks like this number reaching zero, so say that rather than
    // showing a negative figure the reader has to interpret.
    format: (a) => (a.cashLeftInDeal <= 0 ? 'All out' : money(a.cashLeftInDeal)),
    tone: (a) => {
      if (a.cashLeftInDeal <= 0) return 'good';
      if (a.phaseACashInvested <= 0) return 'neutral';
      const recovered = 1 - a.cashLeftInDeal / a.phaseACashInvested;
      return recovered >= 0.75 ? 'good' : recovered >= 0.5 ? 'warn' : 'bad';
    }
  },
  {
    key: 'postRefiCashFlow',
    aggregate: 'sum',
    label: 'CF',
    longLabel: 'Cash flow after refinance',
    testId: 'post-refi-cash-flow',
    value: (a) => a.postRefiCashFlow,
    format: (a) => money(a.postRefiCashFlow),
    tone: (a) => (a.postRefiCashFlow > 0 ? 'good' : a.postRefiCashFlow < 0 ? 'bad' : 'neutral')
  },
  {
    key: 'postRefiCoC',
    aggregate: 'average',
    label: 'CoC',
    longLabel: 'Return on cash left in',
    testId: 'post-refi-coc',
    value: (a) => a.postRefiCoC,
    // Infinite is not a number. Having got every dollar back out is the thing worth saying.
    format: (a) => (a.postRefiCoC === null ? (a.cashLeftInDeal <= 0 ? '∞' : EM_DASH) : percent(a.postRefiCoC)),
    tone: (a) => {
      if (a.postRefiCoC === null) return a.cashLeftInDeal <= 0 ? 'good' : 'neutral';
      return a.postRefiCoC >= 12 ? 'good' : a.postRefiCoC >= 0 ? 'warn' : 'bad';
    }
  },
  {
    key: 'refiDscr',
    aggregate: 'average',
    label: 'DSCR',
    longLabel: 'Debt service coverage after refinance',
    testId: 'refi-dscr',
    value: (a) => a.refiDscr,
    format: (a) => (a.refiDscr === null ? EM_DASH : `${a.refiDscr.toFixed(2)}x`),
    // The threshold a DSCR lender will actually underwrite the new loan at.
    tone: (a) => (a.refiDscr === null ? 'neutral' : a.refiDscr >= 1.25 ? 'good' : a.refiDscr >= 1 ? 'warn' : 'bad')
  },
  {
    key: 'equityCaptured',
    aggregate: 'sum',
    label: 'Equity',
    longLabel: 'Equity captured',
    testId: 'equity-captured',
    value: (a) => a.equityCaptured,
    format: (a) => money(a.equityCaptured),
    tone: (a) => (a.equityCaptured > 0 ? 'good' : a.equityCaptured < 0 ? 'bad' : 'neutral')
  },
  {
    key: 'cashOut',
    aggregate: 'sum',
    label: 'Out',
    longLabel: 'Cash out at refinance',
    testId: 'cash-out',
    value: (a) => a.cashOut,
    format: (a) => money(a.cashOut),
    tone: (a) => (a.cashOut > 0 ? 'good' : 'bad')
  }
];
