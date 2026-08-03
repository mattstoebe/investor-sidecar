import {
  MortgageCalculator,
  TaxExpense,
  HOAExpense,
  RateOfRentExpense,
  AnnualRateExpense
} from './core-utils';

/**
 * Turning a house + parameters into cashflow numbers, as a value rather than an exception.
 *
 * Two kinds of rate live here. "Global assumptions" (vacancy, maintenance, CapEx,
 * management, insurance, closing costs, PMI) describe how the user invests in general
 * and default the same way for every house. "Overrides" are per-house exceptions --
 * a specific listing where the user knows the real number differs. resolveParams
 * always prefers the override and falls back to the global, and reports which one
 * it used so the UI can show "inherited" vs "override".
 */

export interface ResolvedParams {
  price: number;
  monthlyRent: number;
  /** What the user asked for. Not necessarily what they end up putting down -- see maxDown. */
  downPaymentPercent: number;
  interestRate: number;
  propertyTaxRate: number;
  /** Page-reported annual tax, used only when no per-house tax-rate override exists. */
  annualPropertyTax: number | null;
  monthlyHOA: number;
  maxDown: number | null;
  downPayment: number;
  /**
   * downPayment as a % of price, i.e. the percentage actually being put down once maxDown
   * has clamped it. Anything keyed on how leveraged the buyer really is -- PMI -- must use
   * this rather than downPaymentPercent, which is only the request.
   */
  effectiveDownPaymentPercent: number;
  additionalCashInvestment: number;
  vacancyRate: number;
  maintenanceRate: number;
  capExRate: number;
  managementRate: number;
  insuranceRate: number;
  closingCostRate: number;
  pmiRate: number;
  /** True where this field came from a per-house override rather than the global default. */
  isOverridden: {
    price: boolean;
    percentDown: boolean;
    interestRate: boolean;
    propertyTaxRate: boolean;
    vacancyRate: boolean;
    maintenanceRate: boolean;
    capExRate: boolean;
    managementRate: boolean;
    insuranceRate: boolean;
  };
}

/**
 * Renting a property out, line by line: what comes in, what it costs to run, and the NOI
 * left over. Everything here is financing-independent by construction -- that is what makes
 * it the same shape whether the loan is the original purchase mortgage or a refinance.
 *
 * Shared so the card's expense waterfall can render a BRRRR's stabilized operations as well
 * as a rental's, rather than being a rental-only view that a second mode has to do without.
 */
export interface OperatingBreakdown {
  // Income
  grossMonthlyRent: number;
  vacancyLoss: number;
  effectiveMonthlyIncome: number;

  // Operating expenses -- everything except financing. This is what NOI is net of.
  propertyTax: number;
  insurance: number;
  hoa: number;
  maintenance: number;
  capEx: number;
  management: number;
  totalOperatingExpenses: number;

  monthlyNOI: number;
  annualNOI: number;
  /** Annual NOI / value, x100. The financing-independent yield a buyer actually compares across deals. */
  capRate: number;
}

/**
 * What the buy-and-hold model produces. Named for its strategy rather than for "a house"
 * because it is one mode's detail among several: a flip has no NOI, no DSCR and no cap rate,
 * and reaches the card through the same seam carrying an entirely different shape. See
 * ModeAnalysis in modes.ts.
 */
export interface RentalAnalysis extends OperatingBreakdown {
  params: ResolvedParams;

  // Financing
  loanAmount: number;
  monthlyPrincipalAndInterest: number;
  /** Month-1 interest/principal split, for showing how the payment breaks down today. */
  monthlyInterest: number;
  monthlyPrincipal: number;
  pmi: number;
  totalMonthlyDebtService: number;

  totalMonthlyExpenses: number;
  monthlyCashFlow: number;
  annualCashFlow: number;

  totalCashInvested: number;
  /** Null rather than Infinity/NaN when nothing is invested. */
  cashOnCashReturn: number | null;
  year1PrincipalPaydown: number;
  /** Cash-on-cash plus the equity built via principal paydown -- the return landlords usually mean by "ROI". */
  totalReturnWithEquity: number | null;

  /** NOI / annual P&I. Lenders want >= 1.25; PMI is excluded by convention. Null with no loan. */
  dscr: number | null;
  /** Price / annual gross rent. Null with no rent entered. */
  grossRentMultiplier: number | null;
  /** Operating expenses / effective gross income, x100. Null with no effective income. */
  operatingExpenseRatio: number | null;
  /**
   * Occupancy % at which cash flow is exactly $0, holding gross rent fixed. The dual of
   * breakEvenRent: at monthlyRent === breakEvenRent this equals 100 - vacancyRate. Can exceed
   * 100 (no occupancy breaks even). Null with no rent, or at a 100% management rate.
   */
  breakEvenOccupancy: number | null;
  /** Monthly rent at which cash flow is exactly $0, accounting for rent-scaled expenses. */
  breakEvenRent: number;
}

export type RentalResult =
  | { ok: true; analysis: RentalAnalysis }
  | { ok: false; reason: string };

export interface AnalysisOverrides {
  price?: number | null;
  percentDown?: number | null;
  interestRate?: number | null;
  propertyTaxRate?: number | null;
  additionalCashInvestment?: number | null;
  monthlyRent?: number | null;
  vacancyRate?: number | null;
  maintenanceRate?: number | null;
  capExRate?: number | null;
  managementRate?: number | null;
  insuranceRate?: number | null;
}

export interface AnalysisGlobals {
  percentDown: number;
  interestRate: number;
  propertyTaxRate?: number | null;
  maxDown: number | null;
  /** % of gross rent assumed vacant. Industry rule of thumb: 5-8%. */
  vacancyRate?: number | null;
  /** % of gross rent reserved for repairs/maintenance. Rule of thumb: 5-10%. */
  maintenanceRate?: number | null;
  /** % of gross rent reserved for capital expenditures (roof, HVAC, etc). Rule of thumb: 5%. */
  capExRate?: number | null;
  /** % of collected (post-vacancy) rent paid to a property manager. Typical: 8-10%. */
  managementRate?: number | null;
  /** Annual insurance cost as a % of price. Typical: 0.25-0.5%. */
  insuranceRate?: number | null;
  /** Closing costs as a % of price, added to cash invested for return calculations. Typical: 2-4%. */
  closingCostRate?: number | null;
  /** Annual PMI as a % of loan amount, applied automatically when down payment < 20%. */
  pmiRate?: number | null;
}

/**
 * Parses a scraped price into a number. Returns null instead of throwing, because
 * "the listing didn't give us a price" is an ordinary outcome, not an exception.
 */
export function parseMoney(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;

  const trimmed = input.trim();
  if (!trimmed) return null;

  // Redfin abbreviates on map cards: "$1.2M", "$950K".
  const abbreviated = trimmed.match(/^\$?\s*([\d.,]+)\s*([MK])\b/i);
  if (abbreviated) {
    const base = Number(abbreviated[1].replace(/,/g, ''));
    if (!Number.isFinite(base)) return null;
    return abbreviated[2].toUpperCase() === 'M' ? base * 1_000_000 : base * 1_000;
  }

  const cleaned = trimmed.replace(/[$,\s]/g, '');
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return null;

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveRate(
  override: number | null | undefined,
  globalValue: number | null | undefined
): { value: number; overridden: boolean } {
  if (override !== null && override !== undefined) {
    return { value: override, overridden: true };
  }
  return { value: globalValue ?? 0, overridden: false };
}

const RATE_LABELS: Record<string, string> = {
  vacancyRate: 'Vacancy rate',
  maintenanceRate: 'Maintenance rate',
  capExRate: 'CapEx rate',
  managementRate: 'Management rate',
  insuranceRate: 'Insurance rate',
  propertyTaxRate: 'Property tax rate'
};

/** Resolves overrides over globals into the concrete numbers the calculators need. */
export function resolveParams(
  rawPrice: string | number | null | undefined,
  hoaMonthly: number | null | undefined,
  overrides: AnalysisOverrides,
  globals: AnalysisGlobals,
  pageAnnualPropertyTax?: number | null
): { ok: true; params: ResolvedParams } | { ok: false; reason: string } {
  const price = overrides.price ?? parseMoney(rawPrice);

  if (price === null) {
    return { ok: false, reason: "This listing didn't include a readable price. Enter one under Purchase Info." };
  }
  if (price <= 0) {
    return { ok: false, reason: 'Purchase price must be greater than $0.' };
  }

  const downPaymentPercent = overrides.percentDown ?? globals.percentDown;
  const interestRate = overrides.interestRate ?? globals.interestRate;
  const maxDown = globals.maxDown;

  const propertyTaxRate = resolveRate(overrides.propertyTaxRate, globals.propertyTaxRate);
  const hasPageAnnualTax = pageAnnualPropertyTax !== null && pageAnnualPropertyTax !== undefined;
  const annualTaxNumber = Number(pageAnnualPropertyTax);
  const annualPropertyTax = !propertyTaxRate.overridden && hasPageAnnualTax
    && Number.isFinite(annualTaxNumber) && annualTaxNumber >= 0
    ? annualTaxNumber
    : null;
  const vacancyRate = resolveRate(overrides.vacancyRate, globals.vacancyRate);
  const maintenanceRate = resolveRate(overrides.maintenanceRate, globals.maintenanceRate);
  const capExRate = resolveRate(overrides.capExRate, globals.capExRate);
  const managementRate = resolveRate(overrides.managementRate, globals.managementRate);
  const insuranceRate = resolveRate(overrides.insuranceRate, globals.insuranceRate);

  for (const [name, rate] of Object.entries({
    propertyTaxRate, vacancyRate, maintenanceRate, capExRate, managementRate, insuranceRate
  })) {
    if (!Number.isFinite(rate.value) || rate.value < 0) {
      return { ok: false, reason: `${RATE_LABELS[name]} must be zero or greater.` };
    }
  }

  if (!Number.isFinite(downPaymentPercent) || downPaymentPercent < 0) {
    return { ok: false, reason: 'Percent down must be zero or greater.' };
  }
  if (!Number.isFinite(interestRate) || interestRate < 0) {
    return { ok: false, reason: 'Interest rate must be zero or greater.' };
  }

  // Clamped so a 100% down payment or a generous max-cash figure can never exceed the price,
  // which MortgageCalculator rejects outright.
  const targetDown = price * downPaymentPercent / 100;
  const downPayment = Math.min(targetDown, maxDown ?? price, price);
  // The clamp above is where requested and actual leverage diverge, so derive the real
  // percentage here rather than letting callers re-infer it. price > 0 is guaranteed above.
  const effectiveDownPaymentPercent = (downPayment / price) * 100;

  const monthlyHOA = Number.isFinite(Number(hoaMonthly)) ? Number(hoaMonthly) : 0;
  const closingCostRate = globals.closingCostRate ?? 0;
  const pmiRate = globals.pmiRate ?? 0;

  return {
    ok: true,
    params: {
      price,
      monthlyRent: overrides.monthlyRent ?? 0,
      downPaymentPercent,
      interestRate,
      propertyTaxRate: propertyTaxRate.value,
      annualPropertyTax,
      monthlyHOA: monthlyHOA < 0 ? 0 : monthlyHOA,
      maxDown,
      downPayment,
      effectiveDownPaymentPercent,
      additionalCashInvestment: overrides.additionalCashInvestment ?? 0,
      vacancyRate: vacancyRate.value,
      maintenanceRate: maintenanceRate.value,
      capExRate: capExRate.value,
      managementRate: managementRate.value,
      insuranceRate: insuranceRate.value,
      closingCostRate,
      pmiRate,
      isOverridden: {
        price: overrides.price !== null && overrides.price !== undefined,
        percentDown: overrides.percentDown !== null && overrides.percentDown !== undefined,
        interestRate: overrides.interestRate !== null && overrides.interestRate !== undefined,
        propertyTaxRate: propertyTaxRate.overridden,
        vacancyRate: vacancyRate.overridden,
        maintenanceRate: maintenanceRate.overridden,
        capExRate: capExRate.overridden,
        managementRate: managementRate.overridden,
        insuranceRate: insuranceRate.overridden
      }
    }
  };
}

/** Actual page-reported tax wins over a percentage fallback, unless the user overrode the rate. */
export function monthlyPropertyTax(params: ResolvedParams, rateBasis = params.price): number {
  return params.annualPropertyTax !== null
    ? params.annualPropertyTax / 12
    : new TaxExpense(rateBasis, params.propertyTaxRate).getMonthlyExpense();
}

export function analyzeHouse(
  rawPrice: string | number | null | undefined,
  hoaMonthly: number | null | undefined,
  overrides: AnalysisOverrides,
  globals: AnalysisGlobals,
  pageAnnualPropertyTax?: number | null
): RentalResult {
  const resolved = resolveParams(rawPrice, hoaMonthly, overrides, globals, pageAnnualPropertyTax);
  if (!resolved.ok) return resolved;

  const { params } = resolved;

  try {
    const mortgage = new MortgageCalculator(params.price, params.downPayment, params.interestRate, 30);
    const loanAmount = mortgage.getLoanAmount();

    // Income
    const grossMonthlyRent = params.monthlyRent;
    const vacancyLoss = new RateOfRentExpense(grossMonthlyRent, params.vacancyRate).getMonthlyExpense();
    const effectiveMonthlyIncome = grossMonthlyRent - vacancyLoss;

    // Operating expenses -- everything NOI is net of, i.e. everything except financing.
    const propertyTax = monthlyPropertyTax(params);
    const insurance = new AnnualRateExpense(params.price, params.insuranceRate).getMonthlyExpense();
    const hoa = new HOAExpense(params.monthlyHOA).getMonthlyExpense();
    const maintenance = new RateOfRentExpense(grossMonthlyRent, params.maintenanceRate).getMonthlyExpense();
    const capEx = new RateOfRentExpense(grossMonthlyRent, params.capExRate).getMonthlyExpense();
    // Management is charged on what's actually collected, not on vacant-unit rent.
    const management = new RateOfRentExpense(effectiveMonthlyIncome, params.managementRate).getMonthlyExpense();

    const totalOperatingExpenses = propertyTax + insurance + hoa + maintenance + capEx + management;

    const monthlyNOI = effectiveMonthlyIncome - totalOperatingExpenses;
    const annualNOI = monthlyNOI * 12;
    const capRate = (annualNOI / params.price) * 100;

    // Financing
    const monthlyPrincipalAndInterest = mortgage.calculateMonthlyPayment();
    const { principal: monthlyPrincipal, interest: monthlyInterest } =
      loanAmount > 0 ? mortgage.getPrincipalAndInterestForMonth(1) : { principal: 0, interest: 0 };

    // PMI is conventionally required under 20% down and drops off once equity crosses that line.
    // Keyed on the effective percentage, not the requested one: a 25% request that maxDown
    // clamps to 10% of price is a 10%-down loan, and the lender charges PMI accordingly.
    const pmi = params.effectiveDownPaymentPercent < 20
      ? new AnnualRateExpense(loanAmount, params.pmiRate).getMonthlyExpense()
      : 0;
    const totalMonthlyDebtService = monthlyPrincipalAndInterest + pmi;

    const totalMonthlyExpenses = totalOperatingExpenses + totalMonthlyDebtService;
    const monthlyCashFlow = effectiveMonthlyIncome - totalMonthlyExpenses;
    const annualCashFlow = monthlyCashFlow * 12;

    const closingCosts = params.price * params.closingCostRate / 100;
    const totalCashInvested = params.downPayment + closingCosts + params.additionalCashInvestment;
    const cashOnCashReturn = totalCashInvested > 0 ? (annualCashFlow / totalCashInvested) * 100 : null;

    const year1PrincipalPaydown = loanAmount > 0 ? mortgage.getCumulativePrincipalPaid(12) : 0;
    const totalReturnWithEquity = totalCashInvested > 0
      ? ((annualCashFlow + year1PrincipalPaydown) / totalCashInvested) * 100
      : null;

    // Lenders size loans off NOI vs. P&I alone; PMI is excluded from DSCR by convention.
    const annualPI = monthlyPrincipalAndInterest * 12;
    const dscr = annualPI > 0 ? annualNOI / annualPI : null;

    const annualGrossRent = grossMonthlyRent * 12;
    const grossRentMultiplier = annualGrossRent > 0 ? params.price / annualGrossRent : null;
    const operatingExpenseRatio = effectiveMonthlyIncome > 0
      ? (totalOperatingExpenses / effectiveMonthlyIncome) * 100
      : null;
    // Solve monthlyCashFlow(R) = 0 for R, given that vacancy/maintenance/capEx/management
    // all scale with rent while tax/insurance/HOA/debt service don't.
    const v = params.vacancyRate / 100;
    const m = params.managementRate / 100;
    const maint = params.maintenanceRate / 100;
    const capexRate = params.capExRate / 100;
    const fixedCosts = propertyTax + insurance + hoa + totalMonthlyDebtService;
    const rentCoefficient = (1 - v) * (1 - m) - maint - capexRate;
    const breakEvenRent = rentCoefficient > 0 ? Math.round(fixedCosts / rentCoefficient) : Math.round(fixedCosts);

    // The other inversion of the same model: hold gross rent R and solve cashFlow(q) = 0 for
    // occupancy q, where collected income is qR and management is charged on it while
    // maintenance/CapEx stay on gross rent (the asymmetry noted above).
    //   cashFlow(q) = qR(1 - m) - R(maint + capex) - fixedCosts
    //   q*          = [fixedCosts + R(maint + capex)] / [R(1 - m)]
    // Deliberately not clamped to 100: above 100 correctly means the deal can't break even
    // even fully occupied. The old version treated operating expenses as fixed, which made
    // this a lender-style "break-even ratio" rather than the occupancy it claims to be.
    const occupancyDenominator = grossMonthlyRent * (1 - m);
    const breakEvenOccupancy = annualGrossRent > 0 && occupancyDenominator > 0
      ? ((fixedCosts + grossMonthlyRent * (maint + capexRate)) / occupancyDenominator) * 100
      : null;

    return {
      ok: true,
      analysis: {
        params,
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
        loanAmount,
        monthlyPrincipalAndInterest,
        monthlyInterest,
        monthlyPrincipal,
        pmi,
        totalMonthlyDebtService,
        totalMonthlyExpenses,
        monthlyCashFlow,
        annualCashFlow,
        totalCashInvested,
        cashOnCashReturn,
        year1PrincipalPaydown,
        totalReturnWithEquity,
        dscr,
        grossRentMultiplier,
        operatingExpenseRatio,
        breakEvenOccupancy,
        breakEvenRent
      }
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'Could not compute cashflow for this house.'
    };
  }
}
