import { MortgageCalculator, TaxExpense, HOAExpense, AnnualRateExpense } from './core-utils';
import { resolveParams } from './analysis';
import type { ResolvedParams } from './analysis';
import type { MetricDef } from './metrics';

/**
 * Fix and flip: buy, renovate, resell.
 *
 * The first mode that is not a rental, and the one that proves the seam. Nothing here has a
 * monthly cash flow, an NOI, a cap rate or a DSCR -- the deal is a single profit at the end,
 * and the clock is the cost. What it shares with buy-and-hold is only the acquisition: the
 * same price parsing, the same down-payment clamp, the same closing costs, so it resolves
 * those through resolveParams rather than growing a second copy of that logic.
 *
 * Financing is a conventional loan at the panel's own rate. Hard money is what most flips
 * actually use, and it belongs here eventually as a rate and points -- but it is two more
 * parameters to explain on the first non-rental mode anyone sees, and the arithmetic below
 * does not change when it arrives, only where the rate comes from.
 */

export interface FlipAnalysis {
  /** The acquisition half, resolved exactly as a rental's is. */
  params: ResolvedParams;

  arv: number;
  rehabBudget: number;
  holdMonths: number;

  loanAmount: number;
  /**
   * Interest only, not a full amortized payment.
   *
   * Two reasons. Principal is not an expense -- it is a transfer that reduces what is owed at
   * closing -- and profit here is already computed from the whole purchase price, so charging
   * principal as a carrying cost would subtract the same money twice. And flips are financed
   * interest-only in practice, which is what this is modelling even at a conventional rate.
   */
  monthlyInterest: number;
  /** Everything the property costs per month while it is owned and not yet sold. */
  monthlyHoldingCost: number;

  acquisitionCosts: number;
  holdingCosts: number;
  sellingCosts: number;
  /** Price plus every cost of getting to a sale. What the deal has to beat. */
  totalProjectCost: number;

  netProfit: number;
  totalCashInvested: number;
  /** Null rather than Infinity when nothing is invested. */
  roi: number | null;
  /** ROI scaled to a year, so a 3-month and a 12-month deal can be compared. */
  annualizedRoi: number | null;

  /**
   * Maximum allowable offer under the 70% rule: ARV x rule - rehab. The rule is a parameter,
   * not a constant, because markets run it at 65-75 and a buried 0.70 is exactly the kind of
   * unexplained number that makes people distrust a calculator.
   */
  mao: number;
  /** mao - price. Positive means the listing is already inside the rule. */
  maoHeadroom: number;
}

export type FlipResult =
  | { ok: true; analysis: FlipAnalysis }
  | { ok: false; reason: string };

export interface FlipInputs {
  arv: number;
  rehabBudget: number;
  holdMonths: number;
  sellingCostRate: number;
  maoRulePercent: number;
}

export function analyzeFlip(
  rawPrice: string | number | null | undefined,
  hoaMonthly: number | null | undefined,
  overrides: Parameters<typeof resolveParams>[2],
  globals: Parameters<typeof resolveParams>[3],
  inputs: FlipInputs
): FlipResult {
  const resolved = resolveParams(rawPrice, hoaMonthly, overrides, globals);
  if (!resolved.ok) return resolved;
  const { params } = resolved;

  // Zero is "not entered yet", which the mode's `requires` turns into a prompt -- so it must
  // compute rather than fail here, or the card would show a validation error for a field the
  // user has not reached. A negative value is a real mistake and is still rejected.
  if (!Number.isFinite(inputs.arv) || inputs.arv < 0) {
    return { ok: false, reason: 'After-repair value must be zero or greater.' };
  }
  if (!Number.isFinite(inputs.rehabBudget) || inputs.rehabBudget < 0) {
    return { ok: false, reason: 'Rehab budget must be zero or greater.' };
  }
  if (!Number.isFinite(inputs.holdMonths) || inputs.holdMonths <= 0) {
    return { ok: false, reason: 'Hold period must be at least one month.' };
  }
  if (!Number.isFinite(inputs.sellingCostRate) || inputs.sellingCostRate < 0) {
    return { ok: false, reason: 'Selling costs must be zero or greater.' };
  }

  try {
    const mortgage = new MortgageCalculator(params.price, params.downPayment, params.interestRate, 30);
    const loanAmount = mortgage.getLoanAmount();
    // Interest on the full balance: nothing is amortized away over a hold this short, and
    // principal is not a cost. See the note on monthlyInterest.
    const monthlyInterest = new AnnualRateExpense(loanAmount, params.interestRate).getMonthlyExpense();

    // Carrying costs. Rent-scaled expenses have no meaning here -- nobody is living in it --
    // so vacancy, maintenance, CapEx and management are all absent by construction rather
    // than set to zero.
    const propertyTax = new TaxExpense(params.price, params.propertyTaxRate).getMonthlyExpense();
    const insurance = new AnnualRateExpense(params.price, params.insuranceRate).getMonthlyExpense();
    const hoa = new HOAExpense(params.monthlyHOA).getMonthlyExpense();
    const monthlyHoldingCost = monthlyInterest + propertyTax + insurance + hoa;

    const acquisitionCosts = params.price * params.closingCostRate / 100;
    const holdingCosts = monthlyHoldingCost * inputs.holdMonths;
    const sellingCosts = inputs.arv * inputs.sellingCostRate / 100;

    const totalProjectCost =
      params.price + inputs.rehabBudget + acquisitionCosts + holdingCosts + sellingCosts;
    const netProfit = inputs.arv - totalProjectCost;

    // The loan funds the purchase, so it is not cash out of pocket; everything else is. Rehab
    // is treated as cash because a conventional loan does not fund it -- the day hard money
    // arrives, so does the option of financing it.
    const totalCashInvested =
      params.downPayment + inputs.rehabBudget + acquisitionCosts + holdingCosts
      + params.additionalCashInvestment;

    const roi = totalCashInvested > 0 ? (netProfit / totalCashInvested) * 100 : null;
    const annualizedRoi = roi === null ? null : roi * (12 / inputs.holdMonths);

    const mao = inputs.arv * inputs.maoRulePercent / 100 - inputs.rehabBudget;

    return {
      ok: true,
      analysis: {
        params,
        arv: inputs.arv,
        rehabBudget: inputs.rehabBudget,
        holdMonths: inputs.holdMonths,
        loanAmount,
        monthlyInterest,
        monthlyHoldingCost,
        acquisitionCosts,
        holdingCosts,
        sellingCosts,
        totalProjectCost,
        netProfit,
        totalCashInvested,
        roi,
        annualizedRoi,
        mao,
        maoHeadroom: mao - params.price
      }
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'Could not compute this flip.'
    };
  }
}

const EM_DASH = '—';
const money = (value: number) => `${value < 0 ? '-' : ''}$${Math.abs(Math.round(value)).toLocaleString()}`;
const percent = (value: number | null, digits = 1) =>
  value === null || !Number.isFinite(value) ? EM_DASH : `${value.toFixed(digits)}%`;

export const FLIP_METRICS: MetricDef<FlipAnalysis>[] = [
  {
    key: 'netProfit',
    aggregate: 'sum',
    label: 'Profit',
    longLabel: 'Net profit',
    testId: 'net-profit',
    value: (a) => a.netProfit,
    format: (a) => money(a.netProfit),
    tone: (a) => (a.netProfit > 0 ? 'good' : a.netProfit < 0 ? 'bad' : 'neutral')
  },
  {
    key: 'flipRoi',
    aggregate: 'average',
    label: 'ROI',
    longLabel: 'Return on cash invested',
    testId: 'flip-roi',
    value: (a) => a.roi,
    format: (a) => percent(a.roi),
    // Flippers underwrite to roughly 20% on cost; under 10 is not worth the risk of the work.
    tone: (a) => (a.roi === null ? 'neutral' : a.roi >= 20 ? 'good' : a.roi >= 10 ? 'warn' : 'bad')
  },
  {
    key: 'annualizedRoi',
    aggregate: 'average',
    label: 'Ann.',
    longLabel: 'Annualized return',
    testId: 'annualized-roi',
    value: (a) => a.annualizedRoi,
    format: (a) => percent(a.annualizedRoi),
    tone: (a) =>
      a.annualizedRoi === null ? 'neutral'
        : a.annualizedRoi >= 40 ? 'good' : a.annualizedRoi >= 20 ? 'warn' : 'bad'
  },
  {
    key: 'mao',
    aggregate: 'sum',
    label: 'MAO',
    longLabel: 'Max allowable offer',
    testId: 'mao',
    value: (a) => a.mao,
    format: (a) => money(a.mao),
    // Read against the asking price, which is the only thing that makes it actionable: green
    // means the listing is already inside the rule, red means it is not close.
    tone: (a) => {
      if (a.params.price <= 0) return 'neutral';
      const headroom = a.maoHeadroom / a.params.price;
      return headroom >= 0 ? 'good' : headroom >= -0.1 ? 'warn' : 'bad';
    }
  },
  {
    key: 'totalProjectCost',
    aggregate: 'sum',
    label: 'Cost',
    longLabel: 'Total project cost',
    testId: 'total-project-cost',
    value: (a) => a.totalProjectCost,
    format: (a) => money(a.totalProjectCost),
    tone: (a) => (a.arv > 0 && a.totalProjectCost < a.arv ? 'good' : 'bad')
  },
  {
    key: 'holdingCosts',
    aggregate: 'sum',
    label: 'Hold',
    longLabel: 'Holding costs',
    testId: 'holding-costs',
    value: (a) => a.holdingCosts,
    format: (a) => money(a.holdingCosts),
    // Only meaningful against what the deal makes: carrying costs eating the profit is the
    // failure mode of a flip that runs long.
    tone: (a) => {
      const gross = a.netProfit + a.holdingCosts;
      if (gross <= 0) return 'bad';
      const share = a.holdingCosts / gross;
      return share <= 0.25 ? 'good' : share <= 0.5 ? 'warn' : 'bad';
    }
  }
];
