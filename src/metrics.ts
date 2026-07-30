import type { RentalAnalysis } from './analysis';
import { FLIP_METRICS } from './flip';
import { BRRRR_METRICS } from './brrrr';

export type StatTone = 'good' | 'warn' | 'bad' | 'neutral';

export const TONE_CLASSES: Record<StatTone, string> = {
  good: 'text-emerald-700 dark:text-emerald-400',
  warn: 'text-amber-600 dark:text-amber-400',
  bad: 'text-red-700 dark:text-red-400',
  neutral: 'text-gray-800 dark:text-gray-100'
};

export type MetricKey =
  | 'monthlyCashFlow'
  | 'capRate'
  | 'cashOnCash'
  | 'dscr'
  | 'grm'
  | 'opexRatio'
  | 'breakEvenRent'
  | 'breakEvenOccupancy'
  | 'totalReturnWithEquity'
  | 'netProfit'
  | 'flipRoi'
  | 'annualizedRoi'
  | 'mao'
  | 'totalProjectCost'
  | 'holdingCosts'
  | 'cashLeftInDeal'
  | 'postRefiCashFlow'
  | 'postRefiCoC'
  | 'refiDscr'
  | 'equityCaptured'
  | 'cashOut';

export interface MetricDef<A> {
  key: MetricKey;
  label: string;
  longLabel: string;
  testId: string;
  aggregate: 'sum' | 'average';
  value: (a: A) => number | null;
  format: (a: A) => string;
  tone: (a: A) => StatTone;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ErasedMetricDef = MetricDef<any>;

const EM_DASH = '—';

const money = (value: number) => `$${Math.round(value).toLocaleString()}`;

const percent = (value: number | null, digits = 1) =>
  value === null || !Number.isFinite(value) ? EM_DASH : `${value.toFixed(digits)}%`;

/** Higher is better, with two cutoffs. */
const banded = (value: number | null, good: number, warn: number): StatTone => {
  if (value === null || !Number.isFinite(value)) return 'neutral';
  if (value >= good) return 'good';
  if (value >= warn) return 'warn';
  return 'bad';
};

/** Lower is better, with two cutoffs -- expense ratios, break-even points. */
const bandedInverse = (value: number | null, good: number, warn: number): StatTone => {
  if (value === null || !Number.isFinite(value)) return 'neutral';
  if (value <= good) return 'good';
  if (value <= warn) return 'warn';
  return 'bad';
};

/** The buy-and-hold catalogue. Other modes declare their own beside their kernels. */
export const RENTAL_METRICS: MetricDef<RentalAnalysis>[] = [
  {
    key: 'monthlyCashFlow',
    aggregate: 'sum',
    label: 'CF',
    longLabel: 'Monthly cash flow',
    testId: 'monthly-cash-flow',
    value: (a) => a.monthlyCashFlow,
    format: (a) => money(a.monthlyCashFlow),
    tone: (a) => (a.monthlyCashFlow > 0 ? 'good' : a.monthlyCashFlow < 0 ? 'bad' : 'neutral')
  },
  {
    key: 'capRate',
    aggregate: 'average',
    label: 'Cap',
    longLabel: 'Cap rate',
    testId: 'cap-rate',
    value: (a) => a.capRate,
    format: (a) => percent(a.capRate),
    tone: (a) => banded(a.capRate, 7, 4)
  },
  {
    key: 'cashOnCash',
    aggregate: 'average',
    label: 'CoC',
    longLabel: 'Cash-on-cash return',
    testId: 'cash-on-cash',
    value: (a) => a.cashOnCashReturn,
    format: (a) => percent(a.cashOnCashReturn),
    tone: (a) => banded(a.cashOnCashReturn, 8, 0)
  },
  {
    key: 'dscr',
    aggregate: 'average',
    label: 'DSCR',
    longLabel: 'Debt service coverage',
    testId: 'dscr',
    value: (a) => a.dscr,
    format: (a) => (a.dscr === null ? EM_DASH : `${a.dscr.toFixed(2)}x`),
    tone: (a) => banded(a.dscr, 1.25, 1)
  },
  {
    key: 'grm',
    aggregate: 'average',
    label: 'GRM',
    longLabel: 'Gross rent multiplier',
    testId: 'grm',
    value: (a) => a.grossRentMultiplier,
    format: (a) => (a.grossRentMultiplier === null ? EM_DASH : a.grossRentMultiplier.toFixed(1)),
    tone: (a) => bandedInverse(a.grossRentMultiplier, 12, 16)
  },
  {
    key: 'opexRatio',
    aggregate: 'average',
    label: 'OpEx',
    longLabel: 'Operating expense ratio',
    testId: 'opex-ratio',
    value: (a) => a.operatingExpenseRatio,
    format: (a) => percent(a.operatingExpenseRatio),
    tone: (a) => bandedInverse(a.operatingExpenseRatio, 40, 55)
  },
  {
    key: 'breakEvenRent',
    aggregate: 'average',
    label: 'BE Rent',
    longLabel: 'Break-even rent',
    testId: 'break-even-rent',
    value: (a) => a.breakEvenRent,
    format: (a) => money(a.breakEvenRent),
    tone: (a) => {
      if (a.grossMonthlyRent <= 0) return 'neutral';
      const margin = (a.grossMonthlyRent - a.breakEvenRent) / a.grossMonthlyRent;
      return margin >= 0.15 ? 'good' : margin >= 0 ? 'warn' : 'bad';
    }
  },
  {
    key: 'breakEvenOccupancy',
    aggregate: 'average',
    label: 'BE Occ',
    longLabel: 'Break-even occupancy',
    testId: 'break-even-occupancy',
    value: (a) => a.breakEvenOccupancy,
    format: (a) => percent(a.breakEvenOccupancy),
    tone: (a) => bandedInverse(a.breakEvenOccupancy, 85, 95)
  },
  {
    key: 'totalReturnWithEquity',
    aggregate: 'average',
    label: 'Total',
    longLabel: 'Total return (with equity)',
    testId: 'total-return',
    value: (a) => a.totalReturnWithEquity,
    format: (a) => percent(a.totalReturnWithEquity),
    tone: (a) => banded(a.totalReturnWithEquity, 10, 0)
  }
];

export const METRICS: Record<MetricKey, ErasedMetricDef> = Object.fromEntries(
  [...RENTAL_METRICS, ...FLIP_METRICS, ...BRRRR_METRICS].map((def) => [def.key, def])
) as Record<MetricKey, ErasedMetricDef>;

export const METRIC_KEYS: MetricKey[] = Object.keys(METRICS) as MetricKey[];

export const CARD_METRIC_COUNT = 3;

export const DEFAULT_CARD_METRICS: MetricKey[] = ['monthlyCashFlow', 'capRate', 'dscr'];

export function resolveCardMetrics(
  stored: MetricKey[] | undefined | null,
  offered: MetricKey[],
  defaults: MetricKey[]
): MetricKey[] {
  const allowed = new Set(offered);
  const seen = new Set<MetricKey>();
  const valid = (stored ?? []).filter((key) => {
    if (!allowed.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  for (const fallback of [...defaults, ...offered]) {
    if (valid.length >= CARD_METRIC_COUNT) break;
    if (!seen.has(fallback) && allowed.has(fallback)) {
      valid.push(fallback);
      seen.add(fallback);
    }
  }
  return valid.slice(0, CARD_METRIC_COUNT);
}
