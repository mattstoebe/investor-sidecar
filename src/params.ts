import type { GlobalParameters } from './App';

/**
 * The catalogue of assumption fields, and the single place their label, unit and bounds are
 * defined -- the same move metrics.ts already made for outputs, applied to inputs.
 *
 * It exists because the same eleven-field list was written out in four places: the stored
 * shape, the card's component state, the message the card sends the worker, and the overrides
 * a stored house is analysed with. Adding one flip parameter meant touching all four and
 * hand-writing another input row. A mode now names the keys it wants and the card renders
 * them, so a new mode adds entries here and a section list, and nothing else.
 *
 * `inheritsFrom` is what makes a field an *override*: empty means "use the panel default",
 * shown as a placeholder rather than a hidden zero. Fields without it (an after-repair value,
 * a rehab budget) are per-house by nature -- there is no sensible global for them, and
 * inventing one is how a calculator starts fabricating numbers.
 */

export type ParamKey =
  // Acquisition, shared by every mode.
  | 'price'
  | 'percentDown'
  | 'interestRate'
  | 'closingCostRate'
  | 'pmiRate'
  | 'additionalCashInvestment'
  // Ongoing ownership -- rental and BRRRR.
  | 'monthlyRent'
  | 'propertyTaxRate'
  | 'insuranceRate'
  | 'vacancyRate'
  | 'maintenanceRate'
  | 'capExRate'
  | 'managementRate'
  // Rehab and resale -- flip and BRRRR.
  | 'arv'
  | 'rehabBudget'
  | 'holdMonths'
  | 'sellingCostRate'
  | 'maoRulePercent'
  // Refinance -- BRRRR only.
  | 'refiLtv'
  | 'refiRate'
  | 'refiCostRate'
  | 'seasoningMonths';

export interface ParamDef {
  key: ParamKey;
  label: string;
  unit: 'percent' | 'dollar' | 'months';
  /** Upper bound for the input. Percentages that are not shares of a whole exceed 100. */
  max?: number;
  /**
   * The panel-level assumption this falls back to. Absent means the field is per-house only,
   * and an empty value means the mode has nothing to compute rather than "use the default".
   */
  inheritsFrom?: keyof GlobalParameters;
  /** Shown when there is no global to fall back to. */
  placeholder?: string;
  /** One line of why, where the name alone doesn't carry it. */
  hint?: string;
}

const DEFS: ParamDef[] = [
  { key: 'price', label: 'Purchase price', unit: 'dollar' },
  { key: 'percentDown', label: 'Down payment', unit: 'percent', inheritsFrom: 'percentDown' },
  { key: 'interestRate', label: 'Interest', unit: 'percent', max: 20, inheritsFrom: 'interestRate' },
  { key: 'closingCostRate', label: 'Closing costs', unit: 'percent', max: 20, inheritsFrom: 'closingCostRate' },
  { key: 'pmiRate', label: 'PMI', unit: 'percent', max: 5, inheritsFrom: 'pmiRate' },
  {
    key: 'additionalCashInvestment', label: 'Additional cash', unit: 'dollar', placeholder: '0',
    hint: 'Counted in cash invested, not as an expense.'
  },

  { key: 'monthlyRent', label: 'Monthly rent', unit: 'dollar' },
  { key: 'propertyTaxRate', label: 'Property tax', unit: 'percent', max: 10, inheritsFrom: 'propertyTaxRate' },
  { key: 'insuranceRate', label: 'Insurance', unit: 'percent', max: 5, inheritsFrom: 'insuranceRate' },
  { key: 'vacancyRate', label: 'Vacancy', unit: 'percent', inheritsFrom: 'vacancyRate' },
  { key: 'maintenanceRate', label: 'Maintenance', unit: 'percent', inheritsFrom: 'maintenanceRate' },
  { key: 'capExRate', label: 'CapEx', unit: 'percent', inheritsFrom: 'capExRate' },
  { key: 'managementRate', label: 'Management', unit: 'percent', inheritsFrom: 'managementRate' },

  {
    key: 'arv', label: 'After-repair value', unit: 'dollar', placeholder: 'e.g. 520,000',
    hint: 'What it sells for once the work is done.'
  },
  {
    key: 'rehabBudget', label: 'Rehab budget', unit: 'dollar', placeholder: 'e.g. 45,000',
    hint: 'Total cost of the work, materials and labour.'
  },
  {
    key: 'holdMonths', label: 'Hold period', unit: 'months', max: 60,
    inheritsFrom: 'holdMonths', hint: 'Purchase to sale, including time on market.'
  },
  {
    key: 'sellingCostRate', label: 'Selling costs', unit: 'percent', max: 20,
    inheritsFrom: 'sellingCostRate', hint: 'Agent, title and concessions, as a % of the sale price.'
  },
  {
    key: 'maoRulePercent', label: 'Max offer rule', unit: 'percent', max: 100,
    inheritsFrom: 'maoRulePercent',
    hint: 'The % of ARV the 70% rule allows, before rehab. Markets run 65-75.'
  },

  {
    key: 'refiLtv', label: 'Refinance LTV', unit: 'percent', max: 100, inheritsFrom: 'refiLtv',
    hint: 'How much of the after-repair value the new loan covers. Typically 70-75.'
  },
  { key: 'refiRate', label: 'Refinance rate', unit: 'percent', max: 20, inheritsFrom: 'refiRate' },
  {
    key: 'refiCostRate', label: 'Refinance costs', unit: 'percent', max: 10,
    inheritsFrom: 'refiCostRate', hint: 'As a % of the new loan.'
  },
  {
    key: 'seasoningMonths', label: 'Seasoning', unit: 'months', max: 24,
    inheritsFrom: 'seasoningMonths',
    hint: 'Months a lender makes you wait after the rehab before refinancing at the new value.'
  }
];

export const PARAMS: Record<ParamKey, ParamDef> = Object.fromEntries(
  DEFS.map((def) => [def.key, def])
) as Record<ParamKey, ParamDef>;

export const PARAM_KEYS: ParamKey[] = DEFS.map((def) => def.key);

/** The panel default a field falls back to, or null when it is per-house only. */
export function inheritedValue(key: ParamKey, globals: GlobalParameters): number | null {
  const from = PARAMS[key].inheritsFrom;
  if (!from) return null;
  const value = globals[from];
  return typeof value === 'number' ? value : null;
}
