import type { RentalAnalysis } from './analysis';
import { FLIP_METRICS } from './flip';
import { BRRRR_METRICS } from './brrrr';

/**
 * The catalogue of metrics a card can display, and the single place their formatting and
 * good/warn/bad thresholds are defined.
 *
 * This exists because the card used to hardcode four metrics inline, which made "let the
 * user choose which to see" impossible without duplicating the formatting logic. It is
 * also the seam calculator modes hang off: a mode declares which metrics it offers, and the
 * card renders whatever the resolved mode allows without knowing what any individual metric
 * means.
 *
 * A metric is typed against the analysis shape of the mode that owns it, so a flip metric
 * cannot accidentally read a rental's DSCR. Keys stay globally unique across modes -- a
 * BRRRR's post-refinance return is `postRefiCoC`, not a second `cashOnCash` -- which is what
 * lets one stored string identify one metric unambiguously.
 */

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
  // Flip. Named for what they measure rather than reusing a rental key, so one stored string
  // identifies one metric: a flip's return is flipRoi, not a second cashOnCash.
  | 'netProfit'
  | 'flipRoi'
  | 'annualizedRoi'
  | 'mao'
  | 'totalProjectCost'
  | 'holdingCosts'
  // BRRRR.
  | 'cashLeftInDeal'
  | 'postRefiCashFlow'
  | 'postRefiCoC'
  | 'refiDscr'
  | 'equityCaptured'
  | 'cashOut';

export interface MetricDef<A> {
  key: MetricKey;
  /** Fits roughly a third of the panel's width. Uppercased by the chip. */
  label: string;
  /** Spelled out, for the panel's picker. */
  longLabel: string;
  /** Kept stable from when these were hardcoded chips, so tests keep resolving. */
  testId: string;
  /**
   * How a column of these combines across a portfolio. You add up cash flow and profit; you
   * average a cap rate or a DSCR, because a sum of ratios means nothing. Declared rather than
   * inferred, since the export cannot tell a dollar from a percentage by looking at it.
   */
  aggregate: 'sum' | 'average';
  /**
   * The comparable number behind the display string, or null where the metric does not apply.
   * Split out from format() so sorting and the spreadsheet can rank and total any metric of
   * any mode without a per-metric switch -- they used to reach into rental fields directly,
   * which is exactly what a second mode breaks.
   */
  value: (a: A) => number | null;
  format: (a: A) => string;
  tone: (a: A) => StatTone;
}

/**
 * A metric whose analysis type has been erased.
 *
 * Unavoidable, and deliberately confined to here: a card resolves its mode at runtime, so
 * `MODES[mode].metrics` cannot be narrowed statically. Each mode's own module declares its
 * metrics against its real analysis type and keeps full checking; only the shared registry
 * and the render call site see this.
 */
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
    // No loan means no coverage ratio, not a zero one.
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
    // Price / annual rent: lower is cheaper per dollar of rent.
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
    // The 50% rule is the common yardstick; well under it is good.
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
    // Meaningful only against the rent actually entered: margin above break-even.
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
    // Needing near-perfect occupancy to break even is the risk this surfaces.
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

/**
 * Every metric any mode offers, by key. Only for looking a metric up by its stored string --
 * a label for the picker, a column header. Rendering a *value* goes through the resolved
 * mode's own list, because that is what guarantees the analysis handed to it has the shape
 * the metric expects.
 */
export const METRICS: Record<MetricKey, ErasedMetricDef> = Object.fromEntries(
  [...RENTAL_METRICS, ...FLIP_METRICS, ...BRRRR_METRICS].map((def) => [def.key, def])
) as Record<MetricKey, ErasedMetricDef>;

/** Stable display order for pickers. */
export const METRIC_KEYS: MetricKey[] = Object.keys(METRICS) as MetricKey[];

/** How many metrics a card shows. Three fits one line at panel width. */
export const CARD_METRIC_COUNT = 3;

export const DEFAULT_CARD_METRICS: MetricKey[] = ['monthlyCashFlow', 'capRate', 'dscr'];

/**
 * Guards against a stored selection that no longer makes sense -- a key removed from the
 * catalogue, a duplicate, the wrong length, or one belonging to a different strategy -- so a
 * bad value in chrome.storage can't render a broken strip.
 *
 * Scoped to a mode because the selection is per-mode: a card showing a flip has no use for
 * DSCR, and the rental keys stored against it must not leak through.
 */
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
  // Falls back through the mode's own defaults, then anything else it offers, so a strip is
  // always full even for a mode with fewer than CARD_METRIC_COUNT preferred metrics.
  for (const fallback of [...defaults, ...offered]) {
    if (valid.length >= CARD_METRIC_COUNT) break;
    if (!seen.has(fallback) && allowed.has(fallback)) {
      valid.push(fallback);
      seen.add(fallback);
    }
  }
  return valid.slice(0, CARD_METRIC_COUNT);
}
