import { analyzeHouse } from './analysis';
import type { RentalAnalysis } from './analysis';
import { RENTAL_METRICS } from './metrics';
import { analyzeFlip, FLIP_METRICS } from './flip';
import type { FlipAnalysis } from './flip';
import { analyzeBrrrr, BRRRR_METRICS } from './brrrr';
import type { BrrrrAnalysis } from './brrrr';
import type { ErasedMetricDef, MetricKey } from './metrics';
import type { ParamKey } from './params';
import type { House, GlobalParameters } from './App';

export type ModeId = 'rental' | 'flip' | 'brrrr';

export interface SectionDef {
  id: string;
  label: string;
  params: ParamKey[];
  detail?: 'rentChart' | 'expenseWaterfall';
}

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
  description: string;
  sections: SectionDef[];
  requires: (keyof ModeOverrides)[];
  metrics: ErasedMetricDef[];
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
  requires: ['monthlyRent'],
  metrics: RENTAL_METRICS,
  defaultMetrics: ['monthlyCashFlow', 'capRate', 'dscr'],
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
      detail: 'expenseWaterfall'
    },
    {
      id: 'refinance',
      label: 'Refinance',
      params: ['arv', 'refiLtv', 'refiRate', 'refiCostRate', 'seasoningMonths']
    }
  ],
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

export function resolveMode(
  override: ModeId | null | undefined,
  globalValue: ModeId | null | undefined
): { value: ModeId; overridden: boolean } {
  if (override && MODES[override]) return { value: override, overridden: true };
  if (globalValue && MODES[globalValue]) return { value: globalValue, overridden: false };
  return { value: DEFAULT_MODE, overridden: false };
}

export const hasMultipleModes = MODE_IDS.length > 1;

export function missingRequirement(mode: ModeId, overrides: ModeOverrides): keyof ModeOverrides | null {
  for (const key of MODES[mode].requires) {
    const value = overrides[key];
    if (value === null || value === undefined || value === 0) return key;
  }
  return null;
}

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
