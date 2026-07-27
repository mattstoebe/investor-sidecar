import { analyzeHouse } from './analysis';
import type { RentalAnalysis } from './analysis';
import { RENTAL_METRICS } from './metrics';
import { analyzeFlip, FLIP_METRICS } from './flip';
import type { FlipAnalysis } from './flip';
import { analyzeBrrrr, BRRRR_METRICS } from './brrrr';
import type { BrrrrAnalysis } from './brrrr';
import type { ErasedMetricDef, MetricKey } from './metrics';
import type { ParamKey } from './params';
// Type-only, so this is erased at runtime and creates no import cycle with App.tsx.
import type { House, GlobalParameters } from './App';

/**
 * Calculator modes: the same house evaluated under different strategies (buy-and-hold,
 * BRRRR, flip, ...). Only 'rental' exists today; this file is the seam the rest arrive
 * through, so adding one touches a mode definition and not seven field lists.
 *
 * A mode owns four things:
 *  - `params`: which assumption fields it exposes (a flip has no vacancy rate; it has a
 *    holding period and a resale cost).
 *  - `requires`: which of those must be present before there is anything to compute. Missing
 *    input is a prompt, not an error -- a flip without an ARV is not broken, it is unfinished.
 *  - `metrics`: what it can offer the card strip, typed against its own analysis shape.
 *  - `analyze`: how a house's numbers are computed.
 *
 * Resolution follows the same rule as every other parameter -- a per-house override wins
 * over the panel-level default -- via resolveMode below.
 */

export type ModeId = 'rental' | 'flip' | 'brrrr';

/**
 * One collapsible group of a card. A mode's sections are its whole editing surface: the rows
 * the card shows, and which assumption fields sit behind each. Rental has three, flip has
 * four with no rent among them.
 */
export interface SectionDef {
  id: string;
  label: string;
  /** Override fields shown here, rendered generically from the param registry. */
  params: ParamKey[];
  /**
   * A bespoke body, where a list of fields isn't the point -- the rent distribution chart,
   * the expense waterfall that interleaves computed lines with the rate that drives them.
   */
  detail?: 'rentChart' | 'expenseWaterfall';
}

/**
 * The facts a mode reads off the listing itself. `sqft` is here for the rehab-per-square-foot
 * figures flip and BRRRR work in; the rental model ignores it.
 */
export interface ModeHouseFacts {
  price: string | number | null | undefined;
  hoa?: number | null;
  sqft?: string | null;
}

export interface ModeInput {
  house: ModeHouseFacts;
  overrides: ModeOverrides;
  globals: GlobalParameters;
}

/**
 * Per-house overrides, keyed by the param registry.
 *
 * Literally the registry rather than a parallel list: the card builds this straight from what
 * it holds, so a mode's new field reaches the model with no edit here. It was a hand-written
 * interface for exactly one commit, and in that time flip's `arv` was added to it and not to
 * the card's copy -- which rendered every flip as permanently missing its ARV.
 */
export type ModeOverrides = Partial<Record<ParamKey, number | null>>;

/**
 * The part of a result that every mode produces, whatever its strategy. Deliberately tiny:
 * these are the only two figures that mean the same thing under all of them, and they are
 * what a mixed-mode board can show side by side.
 */
export interface DealSummary {
  price: number;
  totalCashInvested: number;
}

/**
 * A completed analysis, discriminated by the mode that produced it.
 *
 * The old shape was the rental model's own struct, which the metric registry, the export and
 * the sort all read fields off directly. A flip has no NOI, no DSCR and no cap rate, so that
 * shape cannot be widened -- it has to become a union, with each mode's numbers behind its
 * own discriminant and only the genuinely universal figures promoted to the summary.
 */
export type ModeAnalysis =
  | { mode: 'rental'; summary: DealSummary; detail: RentalAnalysis }
  | { mode: 'flip'; summary: DealSummary; detail: FlipAnalysis }
  | { mode: 'brrrr'; summary: DealSummary; detail: BrrrrAnalysis };

export type AnalysisResult =
  | { ok: true; analysis: ModeAnalysis }
  | { ok: false; reason: string };

export interface CalculatorMode {
  id: ModeId;
  label: string;
  /** One line, for the mode picker. */
  description: string;
  /** Its editing surface, in card order. */
  sections: SectionDef[];
  /**
   * Inputs without which there is nothing to compute. The card prompts for the first one
   * missing instead of showing an error, the way it already does for a rental with no rent.
   */
  requires: (keyof ModeOverrides)[];
  /** Metrics this mode can offer the card strip, in preference order. */
  metrics: ErasedMetricDef[];
  /** What its cards show when the user has not chosen. */
  defaultMetrics: MetricKey[];
  analyze(input: ModeInput): AnalysisResult;
}

const RENTAL: CalculatorMode = {
  id: 'rental',
  label: 'Buy and hold',
  description: 'Long-term rental: monthly cash flow and return on the cash invested.',
  sections: [
    {
      id: 'purchase',
      label: 'Purchase',
      params: ['price', 'percentDown', 'interestRate', 'additionalCashInvestment']
    },
    { id: 'rent', label: 'Rent', params: ['monthlyRent'], detail: 'rentChart' },
    {
      id: 'expenses',
      label: 'Expenses',
      params: [
        'vacancyRate', 'propertyTaxRate', 'insuranceRate',
        'maintenanceRate', 'capExRate', 'managementRate'
      ],
      detail: 'expenseWaterfall'
    }
  ],
  // Without rent there is no income to model, which the card already says in as many words.
  requires: ['monthlyRent'],
  metrics: RENTAL_METRICS,
  defaultMetrics: ['monthlyCashFlow', 'capRate', 'dscr'],
  // Delegates rather than reimplements: analyzeHouse is the tested rental model. This wraps
  // its result in the common envelope; the arithmetic is untouched.
  analyze: ({ house, overrides, globals }) => {
    const result = analyzeHouse(house.price, house.hoa, overrides, globals);
    if (!result.ok) return result;
    return {
      ok: true,
      analysis: {
        mode: 'rental',
        summary: {
          price: result.analysis.params.price,
          totalCashInvested: result.analysis.totalCashInvested
        },
        detail: result.analysis
      }
    };
  }
};

const FLIP: CalculatorMode = {
  id: 'flip',
  label: 'Fix and flip',
  description: 'Buy, renovate, resell: profit at the end and what the clock costs.',
  sections: [
    {
      id: 'purchase',
      label: 'Purchase',
      params: ['price', 'percentDown', 'interestRate', 'additionalCashInvestment']
    },
    { id: 'rehab', label: 'Rehab', params: ['rehabBudget', 'holdMonths'] },
    { id: 'resale', label: 'Resale', params: ['arv', 'sellingCostRate', 'maoRulePercent'] }
  ],
  // Only the after-repair value. A cosmetic flip can genuinely have a $0 rehab budget, and
  // requiring it would make a legitimate deal look unfinished.
  requires: ['arv'],
  metrics: FLIP_METRICS,
  defaultMetrics: ['mao', 'netProfit', 'flipRoi'],
  analyze: ({ house, overrides, globals }) => {
    const result = analyzeFlip(house.price, house.hoa, overrides, globals, {
      arv: overrides.arv ?? 0,
      rehabBudget: overrides.rehabBudget ?? 0,
      holdMonths: overrides.holdMonths ?? globals.holdMonths,
      sellingCostRate: overrides.sellingCostRate ?? globals.sellingCostRate,
      maoRulePercent: overrides.maoRulePercent ?? globals.maoRulePercent
    });
    if (!result.ok) return result;
    return {
      ok: true,
      analysis: {
        mode: 'flip',
        summary: {
          price: result.analysis.params.price,
          totalCashInvested: result.analysis.totalCashInvested
        },
        detail: result.analysis
      }
    };
  }
};

const BRRRR: CalculatorMode = {
  id: 'brrrr',
  label: 'BRRRR',
  description: 'Buy, rehab, rent, refinance: how much of your money comes back out.',
  sections: [
    {
      id: 'purchase',
      label: 'Purchase',
      params: ['price', 'percentDown', 'interestRate', 'additionalCashInvestment']
    },
    { id: 'rehab', label: 'Rehab', params: ['rehabBudget', 'holdMonths'] },
    { id: 'rent', label: 'Rent', params: ['monthlyRent'], detail: 'rentChart' },
    {
      id: 'operating',
      label: 'Operating',
      params: [
        'vacancyRate', 'propertyTaxRate', 'insuranceRate',
        'maintenanceRate', 'capExRate', 'managementRate'
      ],
      // The same waterfall a rental gets: once stabilized, a BRRRR's operations are a
      // rental's, and it earns the breakdown rather than a bare list of rate fields.
      detail: 'expenseWaterfall'
    },
    {
      id: 'refinance',
      label: 'Refinance',
      params: ['arv', 'refiLtv', 'refiRate', 'refiCostRate', 'seasoningMonths']
    }
  ],
  // Both halves: without an after-repair value there is nothing to refinance against, and
  // without rent there is nothing to hold afterwards.
  requires: ['arv', 'monthlyRent'],
  metrics: BRRRR_METRICS,
  defaultMetrics: ['cashLeftInDeal', 'postRefiCashFlow', 'postRefiCoC'],
  analyze: ({ house, overrides, globals }) => {
    const result = analyzeBrrrr(house.price, house.hoa, overrides, globals, {
      arv: overrides.arv ?? 0,
      rehabBudget: overrides.rehabBudget ?? 0,
      holdMonths: overrides.holdMonths ?? globals.holdMonths,
      seasoningMonths: overrides.seasoningMonths ?? globals.seasoningMonths,
      refiLtv: overrides.refiLtv ?? globals.refiLtv,
      refiRate: overrides.refiRate ?? globals.refiRate,
      refiCostRate: overrides.refiCostRate ?? globals.refiCostRate,
      monthlyRent: overrides.monthlyRent ?? 0
    });
    if (!result.ok) return result;
    return {
      ok: true,
      analysis: {
        mode: 'brrrr',
        summary: {
          price: result.analysis.params.price,
          // What is actually still tied up, which is the figure a BRRRR is judged on -- not
          // what went in before the refinance handed most of it back.
          totalCashInvested: result.analysis.cashLeftInDeal
        },
        detail: result.analysis
      }
    };
  }
};

export const MODES: Record<ModeId, CalculatorMode> = { rental: RENTAL, flip: FLIP, brrrr: BRRRR };

export const MODE_IDS = Object.keys(MODES) as ModeId[];

export const DEFAULT_MODE: ModeId = 'rental';

/**
 * The enum counterpart to resolveRate in analysis.ts: an override wins when it names a mode
 * that exists, otherwise the panel-level default, otherwise 'rental'. Unknown ids fall back
 * rather than throwing, so a stored value from a future or removed mode can't break a card.
 */
export function resolveMode(
  override: ModeId | null | undefined,
  globalValue: ModeId | null | undefined
): { value: ModeId; overridden: boolean } {
  if (override && MODES[override]) return { value: override, overridden: true };
  if (globalValue && MODES[globalValue]) return { value: globalValue, overridden: false };
  return { value: DEFAULT_MODE, overridden: false };
}

/** True while only one mode is registered, so the panel can hide a dead single-option picker. */
export const hasMultipleModes = MODE_IDS.length > 1;

/**
 * The first required input a mode is missing, or null when it has everything it needs.
 * Drives the card's "enter expected rent" style prompt for every mode rather than only
 * rental, so a flip with no ARV reads as unfinished instead of broken.
 */
export function missingRequirement(mode: ModeId, overrides: ModeOverrides): keyof ModeOverrides | null {
  for (const key of MODES[mode].requires) {
    const value = overrides[key];
    if (value === null || value === undefined || value === 0) return key;
  }
  return null;
}

/**
 * Analyses a house exactly as it is stored: its own overrides over the panel's globals,
 * under its resolved mode.
 *
 * This is the single entry point for anything that evaluates a *saved* house -- sorting and
 * the spreadsheet export. Both used to build the overrides object by hand and call
 * analyzeHouse directly, which meant three copies of the same eleven-field list and, more
 * importantly, that they bypassed the mode seam: the day a second mode ships, sorting and
 * export would have silently evaluated every house as a rental regardless of its mode.
 *
 * The card deliberately does not use this -- it analyses in-progress edits held in component
 * state, which by definition are not what's in storage yet.
 */
export function analyzeStoredHouse(
  house: Pick<House, 'price' | 'hoa' | 'localParams'> & { sqft?: string | null },
  globals: GlobalParameters
): AnalysisResult {
  const mode = resolveMode(house.localParams?.mode ?? null, globals.mode).value;
  return MODES[mode].analyze({
    house: { price: house.price, hoa: house.hoa, sqft: house.sqft },
    overrides: storedOverrides(house),
    globals
  });
}

/**
 * A stored house's overrides in the shape a mode reads them.
 *
 * Shared with sorting, which needs the same view to ask whether a house is still missing a
 * required input -- and which previously had no way to ask that at all, so it ranked a
 * rental with no rent as though $0 income were an answer.
 */
export function storedOverrides(house: Pick<House, 'localParams'>): ModeOverrides {
  const local = house.localParams;
  return {
    price: local?.price ?? null,
    percentDown: local?.percentDown ?? null,
    interestRate: local?.interestRate ?? null,
    propertyTaxRate: local?.propertyTaxRate ?? null,
    additionalCashInvestment: local?.additionalCashInvestment ?? null,
    monthlyRent: local?.sliderValue ?? null,
    vacancyRate: local?.vacancyRate ?? null,
    maintenanceRate: local?.maintenanceRate ?? null,
    capExRate: local?.capExRate ?? null,
    managementRate: local?.managementRate ?? null,
    insuranceRate: local?.insuranceRate ?? null,
    arv: local?.arv ?? null,
    rehabBudget: local?.rehabBudget ?? null,
    holdMonths: local?.holdMonths ?? null,
    sellingCostRate: local?.sellingCostRate ?? null,
    maoRulePercent: local?.maoRulePercent ?? null
  };
}
