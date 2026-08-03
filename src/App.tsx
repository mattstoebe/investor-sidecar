import { useState, useEffect, useMemo, useRef, useCallback, lazy, Suspense } from 'react'
import { parseMoney } from './analysis';
import type { OperatingBreakdown } from './analysis';
// Lazy so recharts stays out of the panel's initial bundle; see RentChart.tsx.
const RentChart = lazy(() => import('./RentChart'));
import { buildWorkbook } from './export';
import type { ExportSheet, FormulaCell, WorkbookCell } from './export';
import {
  METRICS,
  TONE_CLASSES,
  CARD_METRIC_COUNT,
  DEFAULT_CARD_METRICS,
  resolveCardMetrics
} from './metrics';
import type { MetricKey, StatTone } from './metrics';
import {
  MODES, DEFAULT_MODE, resolveMode, hasMultipleModes, MODE_IDS,
  analyzeStoredHouse, storedOverrides, missingRequirement
} from './modes';
import type { ModeId, SectionDef, ModeOverrides } from './modes';
import { useHouseParams } from './useHouseParams';
import { PARAMS, inheritedValue } from './params';
import type { ParamKey } from './params';
import CompDots from './CompDots';

interface RentEstimate {
  min: number;
  iqrlow: number;
  mid: number;
  iqrhigh: number;
  max: number;
}

export interface TaxHistoryEntry {
  year: number;
  annualAmount: number | null;
  assessedValue: number | null;
  landValue?: number | null;
  improvementValue?: number | null;
}

export interface ListingTaxDetails {
  annualAmount?: number | null;
  year?: number | null;
  assessedValue?: number | null;
  landValue?: number | null;
  improvementValue?: number | null;
  estimatedMonthlyAmount?: number | null;
  sourceKind?: 'public-history' | 'listing-reported' | 'payment-estimate';
  sourceLabel?: string;
  history?: TaxHistoryEntry[];
}

export interface ListingDetails {
  schemaVersion?: number;
  enrichedAt?: number;
  source?: 'redfin' | 'zillow' | 'homes';
  listingStatus?: 'active' | 'pending' | 'sold' | 'rental' | 'off-market' | null;
  propertyType?: string | null;
  yearBuilt?: number | null;
  lotSizeSqft?: number | null;
  parkingSpaces?: number | null;
  stories?: number | null;
  daysOnMarket?: number | null;
  listedDate?: string | null;
  mlsId?: string | null;
  brokerage?: string | null;
  description?: string | null;
  tax?: ListingTaxDetails;
  extraFacts?: Array<{ label: string; value: string }>;
}

/**
 * A comparable listing the user clipped from a rent/sold search on the site the subject
 * house was captured from. A snapshot, like the house itself -- never re-scraped.
 * Written by the worker via `addComp`/`removeComp`; see docs/comp-workflow.md.
 */
export interface Comp {
  source: 'redfin' | 'zillow' | 'homes';
  propertyID: string;
  kind: 'rent' | 'sold';
  address: string;
  /** Parsed monthly rent (rent comp) or price (sold comp). */
  amount: number;
  /**
   * What the site called the number. Non-disclosure states (TX) never show a sold price;
   * `last-list` is the honest fallback and must render distinctly from a real sold price.
   */
  amountLabel: 'rent' | 'list' | 'sold' | 'last-list';
  /** Sale comps may be active listings; missing means a legacy sold comp. */
  listingStatus?: 'active' | 'sold';
  beds: string;
  baths: string;
  sqft: string;
  url: string;
  /** From the card sash, sold comps only. */
  soldDate?: string | null;
  capturedAt: number;
}

type CompSearchSource = 'redfin' | 'zillow' | 'homes';
type MapVisibilityState = { defaultVisible: boolean; exceptions: string[] };

const COMP_SEARCH_SOURCES: Array<{ id: CompSearchSource; label: string; className: string }> = [
  { id: 'redfin', label: 'Redfin', className: 'text-red-600 dark:text-red-400' },
  { id: 'zillow', label: 'Zillow', className: 'text-blue-600 dark:text-blue-400' },
  { id: 'homes', label: 'Homes', className: 'text-emerald-600 dark:text-emerald-400' }
];

export interface House {
  /** Which site this was captured from. Absent on records saved before multi-site
   *  support, which were all Redfin -- houseKey() defaults accordingly. */
  source?: 'redfin' | 'zillow' | 'homes';
  address: string;
  price: string;
  beds: string;
  baths: string;
  sqft: string;
  propertyID: string;
  url: string;
  /** Absent (null) on any house captured from a Zillow results card -- see zillow.js. */
  latitude: number | null;
  longitude: number | null;
  /**
   * Written by the tax/rent service, which was removed before the store release and is
   * coming back with real auth (see the header of public/scripts/background.js). Nothing
   * populates these today, so they are absent on every house captured by this build --
   * but the panel still renders them when present, which is what keeps restoring the
   * service a server-side change rather than a panel rewrite. Old stored records may
   * still carry them.
   */
  rentEstimate?: RentEstimate | null;
  rentError?: string | null;
  apiTaxRate?: number | null;
  taxError?: string | null;
  hoa?: number;
  /** Canonical facts captured from the listing's full detail page. */
  details?: ListingDetails;
  /**
   * Bumped by the worker on every write to this house, and stamped with the id of whoever
   * caused it. Together they let a card tell a write it made itself -- which it must ignore,
   * having newer keystrokes in hand -- from one it didn't, which it must adopt. Absent on
   * records written before revisions existed; missing counts as 0. See stampRevision in
   * public/scripts/house-storage.js and src/useHouseParams.ts.
   */
  rev?: number;
  lastWriter?: string | null;
  localParams?: StoredLocalParams;
  /**
   * Rent/sold comps the user clipped for this house. Written without bumping `rev` --
   * see docs/comp-workflow.md rule A1 -- so a comp landing never discards keystrokes
   * mid-debounce in this or any other mounted card.
   */
  comps?: Comp[];
}

/**
 * Per-house overrides as they sit in storage: any param the registry defines, plus the mode.
 *
 * Keyed off ParamKey rather than spelled out, so a mode's new field needs no edit here.
 * Partial throughout because absent and null differ -- absent means untouched, null means the
 * user cleared it and chose to inherit.
 */
export type StoredLocalParams = {
  /** Per-house calculator mode; null inherits the panel-level one. */
  mode?: ModeId | null;
  /** Monthly rent, under the key it has had since a slider was the only way to set it. */
  sliderValue?: number;
} & Partial<Record<Exclude<ParamKey, 'monthlyRent'>, number | null>>;

/**
 * Investing assumptions that apply to every house unless a specific listing overrides
 * them in its own Purchase/Expenses dropdown. Keeping these here (rather than baked
 * into each house) is what lets a new capture compute a credible answer immediately.
 */
export interface GlobalParameters {
  percentDown: number;
  maxDown: number | null;
  interestRate: number;
  /**
   * Which metrics a card's one-line strip shows, per mode. UI-only; the math layer ignores it.
   *
   * Per mode because the selection cannot be shared: a card showing a flip has no DSCR and no
   * cap rate to display, so one global list of rental keys is meaningless the moment a second
   * mode exists. Migrated from the old flat array by v3.
   */
  cardMetrics: Partial<Record<ModeId, MetricKey[]>>;
  /** Panel-level calculator mode, overridable per house via localParams.mode. */
  mode: ModeId;
  isDarkMode: boolean;
  propertyTaxRate?: number | null;
  vacancyRate: number;
  maintenanceRate: number;
  capExRate: number;
  managementRate: number;
  insuranceRate: number;
  /** % of price, added to cash invested (not an ongoing expense). */
  closingCostRate: number;
  /** Annual % of loan amount, applied automatically only when down payment < 20%. */
  pmiRate: number;

  // Flip and BRRRR defaults. Held here for the same reason every other assumption is: they
  // describe how the user invests in general, so a house captured under one of those modes
  // computes something credible before any per-house figure is entered. The two that cannot
  // be defaulted -- after-repair value and rehab budget -- are deliberately absent.
  /** Purchase to sale, in months, including time on market. */
  holdMonths: number;
  /** Agent, title and concessions as a % of the sale price. */
  sellingCostRate: number;
  /** The % of ARV the 70% rule allows before rehab. Markets run 65-75. */
  maoRulePercent: number;
  /** How much of the after-repair value a refinance covers. */
  refiLtv: number;
  refiRate: number;
  /** Refinance costs as a % of the new loan. */
  refiCostRate: number;
  /** Months a lender makes you wait after the rehab before lending against the new value. */
  seasoningMonths: number;
  /** Schema version of stored assumptions, so a defaults change can be applied once. */
  paramsVersion?: number;
}

/**
 * Bump when a defaults change must reach users who already have stored settings, and add
 * the corresponding step to migrateGlobalParams.
 */
export const CURRENT_PARAMS_VERSION = 3;

export const DEFAULT_GLOBAL_PARAMETERS: GlobalParameters = {
  percentDown: 20,
  maxDown: null,
  interestRate: 7,
  cardMetrics: { rental: DEFAULT_CARD_METRICS },
  mode: DEFAULT_MODE,
  isDarkMode: false,
  propertyTaxRate: null,
  vacancyRate: 0,
  maintenanceRate: 0,
  capExRate: 0,
  managementRate: 0,
  insuranceRate: 0.35,
  closingCostRate: 3,
  pmiRate: 0.5,
  holdMonths: 6,
  sellingCostRate: 7,
  maoRulePercent: 70,
  refiLtv: 75,
  refiRate: 7.5,
  refiCostRate: 2,
  seasoningMonths: 6,
  paramsVersion: CURRENT_PARAMS_VERSION
};

const RENT_SCALED_RATE_KEYS = ['vacancyRate', 'maintenanceRate', 'capExRate', 'managementRate'] as const;

export function migrateGlobalParams(stored: Partial<GlobalParameters>): GlobalParameters {
  const merged = { ...DEFAULT_GLOBAL_PARAMETERS, ...stored };
  if ((stored.paramsVersion ?? 0) < 2) {
    for (const key of RENT_SCALED_RATE_KEYS) merged[key] = 0;
    if (merged.interestRate > 0 && merged.interestRate < 1) {
      merged.interestRate *= 100;
    }
  }
  if (Array.isArray(merged.cardMetrics)) {
    merged.cardMetrics = { rental: merged.cardMetrics as MetricKey[] };
  } else if (!merged.cardMetrics || typeof merged.cardMetrics !== 'object') {
    merged.cardMetrics = {};
  }
  merged.mode = resolveMode(null, merged.mode).value;
  merged.paramsVersion = CURRENT_PARAMS_VERSION;
  return merged;
}

export function cardMetricsFor(params: GlobalParameters, mode: ModeId): MetricKey[] {
  const definition = MODES[mode];
  return resolveCardMetrics(
    params.cardMetrics?.[mode],
    definition.metrics.map((metric) => metric.key),
    definition.defaultMetrics
  );
}

const SITE_NAMES: Record<'redfin' | 'zillow' | 'homes', string> = {
  redfin: 'Redfin',
  zillow: 'Zillow',
  homes: 'Homes.com'
};

export const houseKey = (house: Pick<House, 'propertyID'> & { source?: string }) =>
  `${house.source || 'redfin'}:${house.propertyID}`;

const compKey = (comp: Comp) => `${comp.source}:${comp.propertyID}:${comp.kind}`;

const formatMoney = (value: number) =>
  value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const formatPercent = (value: number | null, digits = 1) =>
  value === null || !Number.isFinite(value) ? '—' : `${value.toFixed(digits)}%`;

const displayPrice = (raw: string | number | null | undefined) => {
  const parsed = parseMoney(raw);
  if (parsed !== null) return `$${parsed.toLocaleString()}`;
  const text = raw === null || raw === undefined ? '' : String(raw).trim();
  return text || '—';
};

function useNumericTextBuffer(
  value: number | null,
  onChange: (value: number | null) => void,
  { min, max, format, onCommit }: {
    min?: number;
    max?: number;
    format?: (value: number) => string;
    onCommit?: () => void;
  } = {}
) {
  const display = (v: number | null) => (v === null || v === undefined ? '' : (format ? format(v) : String(v)));
  const [text, setText] = useState(display(value));
  const lastEmitted = useRef(value);

  useEffect(() => {
    if (value !== lastEmitted.current) {
      setText(display(value));
      lastEmitted.current = value;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const handleInput = (raw: string) => {
    setText(raw);

    const cleaned = raw.trim().replace(/[$,\s]/g, '');
    if (cleaned === '' || cleaned === '-') {
      lastEmitted.current = null;
      onChange(null);
      return;
    }

    const parsed = Number(cleaned);
    if (!Number.isFinite(parsed)) return;

    let clamped = parsed;
    if (min !== undefined) clamped = Math.max(clamped, min);
    if (max !== undefined) clamped = Math.min(clamped, max);
    lastEmitted.current = clamped;
    onChange(clamped);
  };

  const handleBlur = () => {
    const committed = lastEmitted.current;
    const cleaned = text.trim().replace(/[$,\s]/g, '');
    const typed = cleaned === '' || cleaned === '-' ? null : Number(cleaned);
    const agrees = committed === null
      ? typed === null
      : Number.isFinite(typed) && typed === committed;

    if (agrees) {
      if (format && committed !== null) setText(format(committed));
    } else {
      setText(display(committed));
    }
    onCommit?.();
  };

  return { text, handleInput, handleBlur };
}

function ParamField({
  paramKey, value, globals, onChange, onCommit, testId, placeholder
}: {
  paramKey: ParamKey;
  value: number | null;
  globals: GlobalParameters;
  onChange: (value: number | null) => void;
  onCommit?: () => void;
  testId?: string;
  placeholder?: string;
}) {
  const def = PARAMS[paramKey];
  const inherited = inheritedValue(paramKey, globals);
  const isMoney = def.unit === 'dollar';
  const { text, handleInput, handleBlur } = useNumericTextBuffer(value, onChange, {
    min: 0,
    max: def.max,
    format: isMoney ? (v) => `$${v.toLocaleString()}` : undefined,
    onCommit
  });
  const isOverridden = value !== null && value !== undefined;
  const suffix = def.unit === 'percent' ? '%' : def.unit === 'months' ? 'mo' : null;

  return (
    <div className="flex items-center gap-2">
      {inherited !== null && (
        <span
          title={isOverridden ? 'Overridden for this house' : 'Inherited from global defaults'}
          className={`h-1.5 w-1.5 rounded-full shrink-0 ${isOverridden ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
        />
      )}
      <label className="text-sm text-gray-600 dark:text-gray-300 flex-1 min-w-0 whitespace-nowrap" title={def.hint}>
        {def.label}
      </label>
      <input
        type="text"
        inputMode="decimal"
        data-testid={testId ?? (def.unit === 'percent' ? `rate-field-${def.label}` : `param-${paramKey}`)}
        className={`border rounded p-1 text-sm text-right shrink-0 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 ${
          isMoney ? 'w-24' : 'w-14'
        } ${isOverridden ? 'border-blue-400 dark:border-blue-500' : 'border-gray-300 dark:border-gray-600'}`}
        placeholder={placeholder ?? (inherited !== null ? String(inherited) : (def.placeholder ?? ''))}
        value={text}
        onChange={(e) => handleInput(e.target.value)}
        onBlur={handleBlur}
      />
      {suffix && <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0 w-4">{suffix}</span>}
    </div>
  );
}

function GlobalNumberField({
  id, label, value, onChange, max, suffix = '%', placeholder
}: {
  id: string;
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  max?: number;
  suffix?: string | null;
  placeholder?: string;
}) {
  const { text, handleInput, handleBlur } = useNumericTextBuffer(value, onChange, { min: 0, max });
  return (
    <div className="flex flex-col">
      <label htmlFor={id} className="mb-1 text-xs leading-tight text-gray-600 dark:text-gray-400 min-h-[2rem] flex items-end">{label}</label>
      <div className="relative">
        <input
          id={id}
          type="text"
          inputMode="decimal"
          className="w-full rounded border border-gray-300 dark:border-gray-600 p-2 pr-8 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          placeholder={placeholder}
          value={text}
          onChange={(e) => handleInput(e.target.value)}
          onBlur={handleBlur}
        />
        {suffix && <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-gray-400 dark:text-gray-500">{suffix}</span>}
      </div>
    </div>
  );
}

function StatChip({ label, value, tone = 'neutral', testId }: {
  label: string;
  value: string;
  tone?: StatTone;
  testId?: string;
}) {
  return (
    <div className="flex flex-col min-w-0">
      <span className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500 truncate">{label}</span>
      <span data-testid={testId} className={`text-sm font-semibold tabular-nums truncate ${TONE_CLASSES[tone]}`}>
        {value}
      </span>
    </div>
  );
}

function ReadOnlyRowValue({ value }: { value: string }) {
  return (
    <span className="flex-1 min-w-0 text-sm text-right tabular-nums text-gray-700 dark:text-gray-300 truncate">
      {value}
    </span>
  );
}

/**
 * What to ask for when a mode is missing an input it needs. A rental without rent is not an
 * error and never was -- the card has always said this rather than showing a row of dashes --
 * and the same is true of a flip without an after-repair value.
 */
/**
 * What the worker tells the panel about the undo log: how deep it is and what the top entry
 * was. Deliberately not the inverses themselves -- the worker is the only thing that applies
 * them, for the same reason it is the only thing that writes storedHouses.
 */
export interface UndoSummary {
  depth: number;
  label: string | null;
}

/**
 * Offers to reverse what just happened.
 *
 * A toast rather than only a keybinding because this is a side panel: Cmd+Z is bound too, but
 * nothing about a 320px pane suggests it would work, and deleting a house you spent ten
 * minutes underwriting is the one unrecoverable thing here. It dismisses itself, since an
 * offer that outlives the moment reads as a warning about something still wrong.
 */
export function UndoToast({ message, onUndo, onDismiss }: {
  message: string;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 8000);
    return () => clearTimeout(timer);
  }, [message, onDismiss]);

  return (
    <div
      data-testid="undo-toast"
      role="status"
      className="fixed bottom-3 left-3 right-3 z-50 flex items-center gap-3 rounded-lg bg-gray-900 px-3 py-2 shadow-lg dark:bg-gray-700"
    >
      <span className="min-w-0 flex-1 truncate text-sm text-gray-100">{message}</span>
      <button
        type="button"
        data-testid="undo-button"
        className="shrink-0 rounded px-2 py-1 text-sm font-medium text-blue-300 hover:text-blue-200"
        onClick={onUndo}
      >
        Undo
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        className="shrink-0 text-gray-400 hover:text-gray-200"
        onClick={onDismiss}
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

/** Toggle ids kept from when these rows were hardcoded, so the card suite still addresses them. */
const TOGGLE_TEST_IDS: Record<string, string> = {
  purchase: 'toggle-purchase',
  rent: 'toggle-income',
  expenses: 'toggle-expenses'
};

const EM_DASH = '\u2014';

const PROMPT_FOR_MISSING: Record<string, string> = {
  monthlyRent: 'Enter expected rent below to see returns',
  arv: 'Enter an after-repair value below to see the numbers'
};

/** The same thing at tile width, where there is room for two words. */
const SHORT_PROMPT: Record<string, string> = {
  monthlyRent: 'needs rent',
  arv: 'needs ARV'
};

/**
 * Which strategy this card is evaluated under, and what each of the others would say about it.
 *
 * Collapsed to a chip by default. The tiles carry a headline number, which is the real payoff
 * of modes -- "mediocre rental, good flip" without committing to either -- but on a freshly
 * captured board the flip tile has no ARV and no honest way to guess one, so most of them
 * start as a prompt. That is the designed path, not a degenerate state: the CTA is what sends
 * someone to the field that fills the tile in. Fabricating an ARV to avoid a blank would put a
 * confident profit on screen that nobody entered.
 *
 * Collapsed by default for height: this panel is ~320px and the card has fought for every
 * line of it. Previews are computed only while open, so a closed chip costs one analysis.
 */
function ModePicker({ house, globalParams, overrides, onPick }: {
  house: House;
  globalParams: GlobalParameters;
  overrides: ModeOverrides;
  onPick: (mode: ModeId | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const resolved = resolveMode(house.localParams?.mode ?? null, globalParams.mode);

  const previews = useMemo(() => {
    if (!open) return null;
    return MODE_IDS.map((id) => {
      const missing = missingRequirement(id, overrides);
      if (missing) return { id, headline: SHORT_PROMPT[missing] ?? 'needs input', ready: false };

      const result = MODES[id].analyze({
        house: { price: house.price, hoa: house.hoa, sqft: house.sqft },
        overrides,
        globals: globalParams
      });
      if (!result.ok) return { id, headline: '—', ready: false };

      const metric = MODES[id].metrics.find((m) => m.key === MODES[id].defaultMetrics[0]);
      return {
        id,
        headline: metric ? metric.format(result.analysis.detail) : '—',
        tone: metric ? metric.tone(result.analysis.detail) : undefined,
        ready: true
      };
    });
  }, [open, house.price, house.hoa, house.sqft, overrides, globalParams]);

  if (!hasMultipleModes) return null;

  return (
    <div>
      <button
        type="button"
        data-testid="mode-chip"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-full border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
        onClick={() => setOpen(!open)}
      >
        <span
          title={resolved.overridden ? 'Chosen for this house' : 'Inherited from global defaults'}
          className={`h-1.5 w-1.5 rounded-full ${resolved.overridden ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
        />
        {MODES[resolved.value].label}
        <span className="text-gray-400">{open ? '▴' : '▾'}</span>
      </button>

      {open && previews && (
        <div className="mt-2">
          <div className="grid grid-cols-3 gap-1.5">
            {previews.map((preview) => {
              const selected = preview.id === resolved.value;
              return (
                <button
                  key={preview.id}
                  type="button"
                  data-testid={`mode-tile-${preview.id}`}
                  aria-pressed={selected}
                  className={`rounded border p-1.5 text-left transition-colors ${
                    selected
                      ? 'border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-950'
                      : 'border-gray-300 bg-white hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:hover:bg-gray-700'
                  }`}
                  onClick={() => { onPick(preview.id); setOpen(false); }}
                >
                  <span className="block truncate text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500">
                    {MODES[preview.id].label}
                  </span>
                  <span className={`block truncate text-sm font-semibold tabular-nums ${
                    preview.ready && preview.tone ? TONE_CLASSES[preview.tone] : 'text-gray-400 dark:text-gray-500'
                  }`}>
                    {preview.headline}
                  </span>
                </button>
              );
            })}
          </div>
          {resolved.overridden && (
            <button
              type="button"
              data-testid="mode-reset"
              className="mt-1.5 text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400"
              onClick={() => { onPick(null); setOpen(false); }}
            >
              Reset to inherited
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The list beneath a comp dot track: a summary line ("3 comps · median $2,150", with a
 * one-click "Use median" -- probably what half of users actually want) and one row per
 * comp with a link to the listing and a way to remove it. Shared between rent and sold
 * comps, which differ only in the amount's suffix. See docs/comp-workflow.md §4.
 */
function CompSummary({ comps, onPick, onRemove }: {
  comps: Comp[];
  onPick: (amount: number) => void;
  onRemove: (comp: Comp) => void;
}) {
  if (comps.length === 0) return null;

  const amounts = [...comps.map((c) => c.amount)].sort((a, b) => a - b);
  const mid = Math.floor(amounts.length / 2);
  const median = amounts.length % 2 === 1 ? amounts[mid] : (amounts[mid - 1] + amounts[mid]) / 2;
  // High to low: the number someone's about to click a dot for is usually the one
  // they're eyeballing against the top of the list, not buried under the cheapest unit.
  const sorted = [...comps].sort((a, b) => b.amount - a.amount);

  return (
    <div className="mt-1 space-y-1.5" data-testid="comp-list">
      <p className="text-xs text-gray-400 dark:text-gray-500">
        {comps.length} comp{comps.length === 1 ? '' : 's'} · median ${Math.round(median).toLocaleString()}
        <button
          type="button"
          className="ml-2 text-blue-600 dark:text-blue-400 hover:underline"
          onClick={() => onPick(Math.round(median))}
        >
          Use median
        </button>
      </p>
      {sorted.map((comp) => (
        <div key={compKey(comp)} className="flex items-center justify-between gap-2 text-xs">
          <a
            href={comp.url}
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 dark:text-blue-400 truncate min-w-0 hover:underline"
          >
            {comp.address}
          </a>
          <span className="text-gray-500 dark:text-gray-400 shrink-0 tabular-nums">
            ${comp.amount.toLocaleString()}{comp.kind === 'rent' ? '/mo' : ''}
            {comp.amountLabel === 'list' ? ' (active list)' : ''}
            {comp.amountLabel === 'last-list' ? ' (last list)' : ''}
            {comp.amountLabel === 'sold' ? ' (sold)' : ''}
          </span>
          <button
            type="button"
            aria-label={`Remove comp ${comp.address}`}
            className="text-red-500 hover:text-red-600 shrink-0"
            onClick={() => onRemove(comp)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

/** Source picker for a comp hunt. Sessions are attached to the subject house, not the
 * search provider, so any supported site can contribute comps to the same card. */
function CompSearchLinks({ kind, subjectSource, onStart }: {
  kind: 'rent' | 'sold';
  subjectSource: CompSearchSource;
  onStart: (source: CompSearchSource) => void;
}) {
  const label = kind === 'rent' ? 'rent' : 'sale';
  return (
    <div className="flex items-center gap-2 text-xs" aria-label={`Find ${label} comps on a site`}>
      {COMP_SEARCH_SOURCES.map((source) => (
        <button
          key={source.id}
          type="button"
          title={`Find ${label} comps on ${source.label}`}
          aria-label={`Find ${label} comps on ${source.label}`}
          data-testid={`find-${label}-comps-${source.id}`}
          className={`${source.className} hover:underline ${source.id === subjectSource ? 'font-semibold underline underline-offset-2' : ''}`}
          onClick={() => onStart(source.id)}
        >
          {source.label}
        </button>
      ))}
    </div>
  );
}

export function HouseCard({ house, globalParams, onRemoved, onModeChanged, onShowOnMap, onMapHighlight, mapVisible, highlighted }: {
  house: House,
  globalParams: GlobalParameters,
  onRemoved?: (address: string) => void,
  onModeChanged?: (label: string) => void,
  onShowOnMap?: (house: House) => void,
  onMapHighlight?: (key: string | null) => void,
  mapVisible?: boolean,
  highlighted?: boolean
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlighted) cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlighted]);

  const [openSection, setOpenSection] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [predictedRent, setPredictedRent] = useState<RentEstimate | null>(house.rentEstimate ?? null);

  const { params, setParam, commit } = useHouseParams(house);
  const at = (key: ParamKey) => params[key] ?? null;
  const sliderValue = at('monthlyRent') ?? 0;
  const localPrice = at('price');

  const dollarFormat = (v: number) => `$${v.toLocaleString()}`;
  const rentBuffer = useNumericTextBuffer(
    sliderValue === 0 ? null : sliderValue,
    (value) => setParam('monthlyRent', value ?? 0),
    { min: 0, format: dollarFormat, onCommit: commit }
  );

  const DropdownArrow = ({ isOpen }: { isOpen: boolean }) => (
    <svg 
      className={`w-6 h-6 transform transition-transform duration-200 ${isOpen ? 'rotate-180' : ''} text-black dark:text-gray-200`}
      fill="none" 
      stroke="currentColor" 
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );

  useEffect(() => {
    setPredictedRent(house.rentEstimate ?? null);
    if (house.rentEstimate && sliderValue === 0) {
      setParam('monthlyRent', house.rentEstimate.mid);
    }
  }, [house.rentEstimate, sliderValue, setParam]);

  const mode = resolveMode(house.localParams?.mode ?? null, globalParams.mode).value;

  const overrides: ModeOverrides = params;

  const result = useMemo(
    () => MODES[mode].analyze({
      house: {
        price: house.price,
        hoa: house.hoa,
        sqft: house.sqft,
        annualPropertyTax: house.details?.tax?.annualAmount ?? null
      },
      overrides,
      globals: globalParams
    }),
    [house.price, house.hoa, house.sqft, house.details?.tax?.annualAmount, overrides, globalParams, mode]
  );

  const analysis = result.ok ? result.analysis.detail : null;
  const rental = result.ok && result.analysis.mode === 'rental' ? result.analysis.detail : null;
  const operating: OperatingBreakdown | null = result.ok
    && (result.analysis.mode === 'rental' || result.analysis.mode === 'brrrr')
    ? result.analysis.detail
    : null;
  const financing = !result.ok ? null
    : result.analysis.mode === 'rental' ? {
      costs: [
        { label: 'Mortgage P&I', value: result.analysis.detail.monthlyPrincipalAndInterest },
        ...(result.analysis.detail.pmi > 0
          ? [{ label: 'PMI (down payment < 20%)', value: result.analysis.detail.pmi }] : [])
      ],
      headline: { label: 'Monthly Cash Flow', value: result.analysis.detail.monthlyCashFlow },
      returns: [
        { label: 'DSCR', text: result.analysis.detail.dscr !== null ? `${result.analysis.detail.dscr.toFixed(2)}x` : EM_DASH },
        { label: 'Cash-on-Cash', text: formatPercent(result.analysis.detail.cashOnCashReturn) },
        { label: 'Total return incl. equity paydown', text: formatPercent(result.analysis.detail.totalReturnWithEquity) }
      ]
    }
      : result.analysis.mode === 'brrrr' ? {
        costs: [{ label: 'Refinanced loan payment', value: result.analysis.detail.postRefiPayment }],
        headline: { label: 'Cash flow after refinance', value: result.analysis.detail.postRefiCashFlow },
        returns: [
          { label: 'DSCR', text: result.analysis.detail.refiDscr !== null ? `${result.analysis.detail.refiDscr.toFixed(2)}x` : EM_DASH },
          {
            label: 'Return on cash left in',
            text: result.analysis.detail.postRefiCoC === null
              ? (result.analysis.detail.cashLeftInDeal <= 0 ? 'All capital returned' : EM_DASH)
              : formatPercent(result.analysis.detail.postRefiCoC)
          },
          {
            label: 'Cash left in the deal',
            text: result.analysis.detail.cashLeftInDeal <= 0
              ? '$0' : `$${formatMoney(result.analysis.detail.cashLeftInDeal)}`
          }
        ]
      }
        : null;
  const summary = result.ok
    ? {
      ...result.analysis.summary,
      label: result.analysis.mode === 'brrrr' ? 'Cash left in the deal' : 'Total cash invested'
    }
    : null;
  const analysisReason = result.ok ? null : result.reason;
  const missing = missingRequirement(mode, overrides);

  const pickMode = async (next: ModeId | null) => {
    await commit();
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'updateLocalParams',
        propertyID: house.propertyID,
        source: house.source,
        writer: 'mode-picker',
        localParams: { mode: next }
      });
      if (response && response.ok === false) {
        console.error('Could not change strategy:', response.reason);
      } else {
        onModeChanged?.(MODES[resolveMode(next, globalParams.mode).value].label);
      }
    } catch (error) {
      console.error('Error changing strategy:', error);
    }
  };
  const cardMetrics = useMemo(() => cardMetricsFor(globalParams, mode), [globalParams, mode]);
  const metricDefs = useMemo(() => {
    const byKey = new Map(MODES[mode].metrics.map((metric) => [metric.key, metric]));
    return cardMetrics.map((key) => byKey.get(key)!).filter(Boolean);
  }, [cardMetrics, mode]);
  const primaryMetric = metricDefs[0];
  const primaryTone: StatTone = analysis !== null && missing === null && primaryMetric
    ? primaryMetric.tone(analysis)
    : 'neutral';
  const primaryToneDotClasses: Record<StatTone, string> = {
    good: 'bg-emerald-500',
    warn: 'bg-amber-400',
    bad: 'bg-red-500',
    neutral: 'bg-gray-300 dark:bg-gray-600'
  };
  const primaryMetricStatus = primaryTone === 'neutral'
    ? 'Primary metric is not ready'
    : `${primaryMetric?.longLabel ?? 'Primary metric'} is ${primaryTone}`;

  const rentComps = useMemo(() => (house.comps ?? []).filter((c) => c.kind === 'rent'), [house.comps]);
  const soldComps = useMemo(() => (house.comps ?? []).filter((c) => c.kind === 'sold'), [house.comps]);
  const soldBounds = useMemo(() => {
    if (soldComps.length === 0) return { min: 0, max: 1 };
    const amounts = soldComps.map((c) => c.amount);
    return { min: Math.round(Math.min(...amounts) * 0.9), max: Math.round(Math.max(...amounts) * 1.1) };
  }, [soldComps]);

  const findCompsForHouse = async (kind: 'rent' | 'sold', searchSource: CompSearchSource = house.source ?? 'redfin') => {
    const response = await chrome.runtime.sendMessage({
      action: 'startCompSession', targetKey: houseKey(house), kind, searchSource
    });
    if (response && response.ok === false) {
      console.error('Could not start comp session:', response.reason);
    }
  };

  const removeComp = (comp: Comp) => {
    chrome.runtime.sendMessage({ action: 'removeComp', targetKey: houseKey(house), compKey: compKey(comp) });
  };

  const getRentBounds = () => {
    const price = analysis?.params.price ?? localPrice ?? parseMoney(house.price);
    if (!price || price <= 0) return { min: 0, max: 10000 };

    const observedUpper = Math.max(
      Number(predictedRent?.max) || 0,
      Number(predictedRent?.iqrhigh) || 0,
      Number(sliderValue) || 0,
      rental?.breakEvenRent ?? 0,
      // Widens exactly like an entered rent already does below -- a comp's number must
      // always be representable on the track the user clicks it from.
      ...rentComps.map((c) => c.amount)
    );

    const baseMin = Math.round(price * 0.001);
    const baseMax = Math.round(price * 0.01);
    const adaptiveMax = Math.round(observedUpper * 1.15); // keep headroom above useful values

    // Both ends widen to include an entered rent, so the slider and chart can always
    // represent whatever the user actually typed rather than clipping it.
    return {
      min: sliderValue > 0 ? Math.min(baseMin, sliderValue) : baseMin,
      max: Math.max(baseMax, adaptiveMax)
    };
  };

  /** The collapsed row's right-hand figure. */
  const sectionSummary = (id: string): string => {
    if (id === 'purchase') {
      return localPrice ? `$${localPrice.toLocaleString()}` : displayPrice(house.price);
    }
    // Everything the property costs a month, including debt service -- the same figure for a
    // rental and a stabilized BRRRR, assembled from parts each one names differently.
    if (id === 'expenses' || id === 'operating') {
      if (!operating || !financing) return EM_DASH;
      const debt = financing.costs.reduce((total, line) => total + line.value, 0);
      return `$${formatMoney(operating.totalOperatingExpenses + debt)}`;
    }
    return EM_DASH;
  };

  /**
   * A section's expanded body. Sections with a bespoke detail keep their hand-written layout,
   * because interleaving a computed line with the rate that drives it is the whole point of
   * the expense waterfall and a generic field list cannot express it. Everything else renders
   * from the registry, which is what makes a new mode's inputs free.
   */
  const renderSection = (section: SectionDef) => {
    if (section.detail === 'rentChart') return renderDropdownContent('rent');
    if (section.detail === 'expenseWaterfall') return renderDropdownContent('expenses');
    if (section.id === 'purchase') return renderDropdownContent('purchase');

    return (
      <div className="mt-4 pl-4 border-l-2 border-gray-200 dark:border-gray-600 space-y-3">
        {section.params.map((key) => (
          <ParamField
            key={key}
            paramKey={key}
            value={at(key)}
            globals={globalParams}
            onChange={(v) => setParam(key, v)}
            onCommit={commit}
          />
        ))}
        {/* Every mode with an ARV field (flip's resale, BRRRR's refinance) gets sold
            comps here -- there's no bespoke detail for either section, so this rides
            the generic branch rather than adding a third renderDropdownContent type. */}
        {section.params.includes('arv') && (
          <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
                Sale comps
              </span>
              <CompSearchLinks kind="sold" subjectSource={house.source ?? 'redfin'} onStart={(source) => findCompsForHouse('sold', source)} />
            </div>
            {soldComps.length > 0 && (
              <CompDots
                comps={soldComps}
                bounds={soldBounds}
                onPick={(amount) => { setParam('arv', amount); commit(); }}
                onRemove={removeComp}
              />
            )}
            <CompSummary
              comps={soldComps}
              onPick={(amount) => { setParam('arv', amount); commit(); }}
              onRemove={removeComp}
            />
          </div>
        )}
      </div>
    );
  };

  const renderDropdownContent = (type: 'rent' | 'expenses' | 'purchase') => {
    
    if (type === 'rent') {
      // Validate and normalize rent values to ensure they make logical sense
      const rawValues = {
        min: Number(predictedRent?.min) || 0,
        max: Number(predictedRent?.max) || 10000,
        mid: Number(predictedRent?.mid) || 0,
        iqrlow: Number(predictedRent?.iqrlow) || 0,
        iqrhigh: Number(predictedRent?.iqrhigh) || 0
      };


      // Monthly rent needed to break even (cash flow = 0)
      const profitabilityRent = rental?.breakEvenRent ?? null;

      // Bounds fixed to 0.05% - 0.25% of home price
      const chartBounds = getRentBounds();
      const clampToBounds = (value: number) => Math.min(chartBounds.max, Math.max(chartBounds.min, value));
      const clampedValues = {
        min: clampToBounds(rawValues.min),
        max: clampToBounds(rawValues.max),
        mid: clampToBounds(rawValues.mid),
        iqrlow: clampToBounds(rawValues.iqrlow),
        iqrhigh: clampToBounds(rawValues.iqrhigh),
        profitability: profitabilityRent !== null ? clampToBounds(profitabilityRent) : null
      };
      const chartTicks = Array.from(new Set([
        chartBounds.min,
        clampedValues.min,
        clampedValues.iqrlow,
        clampedValues.mid,
        clampedValues.iqrhigh,
        clampedValues.max,
        chartBounds.max
      ])).sort((a, b) => a - b);
      const boundedSliderValue = Math.min(
        chartBounds.max,
        Math.max(chartBounds.min, Number(sliderValue || predictedRent?.mid || chartBounds.min))
      );
      const sliderPercent = chartBounds.max === chartBounds.min
        ? 0
        : ((boundedSliderValue - chartBounds.min) / (chartBounds.max - chartBounds.min)) * 100;

      return (
        <div className="mt-4 pl-4 border-l-2 border-gray-200 dark:border-gray-600 relative pt-6 pb-2">
          {/* TODO(rent-model): rentError was surfaced here; see the note on the card body. */}
          {/* Container for both slider and chart with relative width */}
          <div className="w-full max-w-[600px]"> {/* Wider container that can grow */}
            {/* Slider container */}
            <div className="relative mb-8"> {/* Use margin-bottom instead of fixed heights */}
              <output 
                className="absolute -top-6 transform -translate-x-1/2 bg-blue-500 text-white px-2 py-1 rounded text-sm"
                style={{ 
                  left: `${sliderPercent}%`
                }}
              >
                ${boundedSliderValue.toLocaleString()}
              </output>
              <input 
                type="range" 
                min={chartBounds.min}
                max={chartBounds.max}
                step="10"
                value={boundedSliderValue}
                className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer
                  [&::-webkit-slider-thumb]:appearance-none
                  [&::-webkit-slider-thumb]:w-5 
                  [&::-webkit-slider-thumb]:h-5
                  [&::-webkit-slider-thumb]:rounded-full
                  [&::-webkit-slider-thumb]:bg-blue-500
                  [&::-webkit-slider-thumb]:cursor-pointer
                  [&::-webkit-slider-thumb]:border-2
                  [&::-webkit-slider-thumb]:border-white
                  [&::-webkit-slider-thumb]:shadow-md
                  [&::-webkit-slider-thumb]:hover:bg-blue-600
                  [&::-webkit-slider-thumb]:transition-colors
                  
                  [&::-moz-range-thumb]:appearance-none
                  [&::-moz-range-thumb]:w-5
                  [&::-moz-range-thumb]:h-5
                  [&::-moz-range-thumb]:rounded-full
                  [&::-moz-range-thumb]:bg-blue-500
                  [&::-moz-range-thumb]:cursor-pointer
                  [&::-moz-range-thumb]:border-2
                  [&::-moz-range-thumb]:border-white
                  [&::-moz-range-thumb]:shadow-md
                  [&::-moz-range-thumb]:hover:bg-blue-600
                  [&::-moz-range-thumb]:transition-colors"
                onChange={(e) => {
                  const value = parseInt(e.currentTarget.value);
                  const clamped = Math.min(chartBounds.max, Math.max(chartBounds.min, value || chartBounds.min));
                  setParam('monthlyRent', clamped);
                }}
              />
            </div>

            {/* Rent comps: dots on the same [chartBounds.min, chartBounds.max] scale as the
                slider above -- see CompDots.tsx for why they're a separate track rather than
                overlaid on the <input> itself. */}
            <div className="mb-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
                  Rent comps
                </span>
                <CompSearchLinks kind="rent" subjectSource={house.source ?? 'redfin'} onStart={(source) => findCompsForHouse('rent', source)} />
              </div>
              <CompDots
                comps={rentComps}
                bounds={chartBounds}
                onPick={(amount) => { setParam('monthlyRent', amount); commit(); }}
                onRemove={removeComp}
              />
              <CompSummary
                comps={rentComps}
                onPick={(amount) => { setParam('monthlyRent', amount); commit(); }}
                onRemove={removeComp}
              />
            </div>

            {/*
              Lazy-loaded: recharts is ~550 kB and this chart is only drawn when there is a
              real predicted distribution to draw -- which, with the rent service removed for
              the store release, is currently never. Importing it eagerly put that parse cost
              on every panel open; lazily, the chunk is built but never fetched. The fallback
              reserves the chart's height so expanding the dropdown doesn't jump.

              Kept wired rather than deleted: when the authenticated service lands it only has
              to write house.rentEstimate and this lights up unchanged.
            */}
            {predictedRent && (
              <Suspense fallback={<div className="w-full h-[120px]" aria-hidden="true" />}>
                <RentChart
                  chartBounds={chartBounds}
                  clampedValues={clampedValues}
                  chartTicks={chartTicks}
                  sliderValue={Number(sliderValue) || 0}
                />
              </Suspense>
            )}
          </div>
        </div>
      );
    }

    if (type === 'expenses') {
      if (!operating || !financing) {
        return (
          <div className="mt-4 pl-4 border-l-2 border-gray-200 dark:border-gray-600">
            <p className="text-sm text-amber-700 dark:text-amber-300">{analysisReason}</p>
          </div>
        );
      }

      const Line = ({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) => (
        <div className="flex items-center justify-between gap-3">
          <span className={`text-sm ${muted ? 'text-gray-500 dark:text-gray-400' : 'text-gray-600 dark:text-gray-300'}`}>{label}</span>
          <span className={`text-sm tabular-nums shrink-0 ${muted ? 'text-gray-500 dark:text-gray-400' : 'text-gray-700 dark:text-gray-200'}`}>{value}</span>
        </div>
      );

      return (
        <div className="mt-4 pl-4 border-l-2 border-gray-200 dark:border-gray-600 space-y-5">
          <div className="space-y-1.5">
            <Line label="Gross Rent" value={`$${formatMoney(operating.grossMonthlyRent)}`} />
            <Line label="Vacancy Loss" value={`-$${formatMoney(operating.vacancyLoss)}`} muted />
            <ParamField paramKey="vacancyRate" value={at('vacancyRate')} globals={globalParams}
              onChange={(v) => setParam('vacancyRate', v)} onCommit={commit} />
            <div className="flex items-center justify-between gap-3 pt-1 border-t border-gray-200 dark:border-gray-700">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-200">Effective income</span>
              <span className="text-sm font-medium tabular-nums text-gray-700 dark:text-gray-200 shrink-0">${formatMoney(operating.effectiveMonthlyIncome)}</span>
            </div>
          </div>

          <div className="space-y-2">
            <span className="text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">Operating expenses</span>
            <Line label="Property Tax" value={`$${formatMoney(operating.propertyTax)}`} />
            <ParamField paramKey="propertyTaxRate" value={at('propertyTaxRate')} globals={globalParams}
              onChange={(v) => setParam('propertyTaxRate', v)} onCommit={commit} />
            <Line label="Insurance" value={`$${formatMoney(operating.insurance)}`} />
            <ParamField paramKey="insuranceRate" value={at('insuranceRate')} globals={globalParams}
              onChange={(v) => setParam('insuranceRate', v)} onCommit={commit} />
            {operating.hoa > 0 && <Line label="HOA" value={`$${formatMoney(operating.hoa)}`} />}
            <Line label="Maintenance" value={`$${formatMoney(operating.maintenance)}`} />
            <ParamField paramKey="maintenanceRate" value={at('maintenanceRate')} globals={globalParams}
              onChange={(v) => setParam('maintenanceRate', v)} onCommit={commit} />
            <Line label="CapEx reserve" value={`$${formatMoney(operating.capEx)}`} />
            <ParamField paramKey="capExRate" value={at('capExRate')} globals={globalParams}
              onChange={(v) => setParam('capExRate', v)} onCommit={commit} />
            <Line label="Management" value={`$${formatMoney(operating.management)}`} />
            <ParamField paramKey="managementRate" value={at('managementRate')} globals={globalParams}
              onChange={(v) => setParam('managementRate', v)} onCommit={commit} />
          </div>

          <div className="flex items-center justify-between gap-3 pt-2 border-t border-gray-200 dark:border-gray-700">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-200">Net operating income</span>
            <span className="text-sm font-semibold tabular-nums text-gray-800 dark:text-gray-100">
              ${formatMoney(operating.monthlyNOI)}<span className="text-gray-400 dark:text-gray-500 font-normal"> ({formatPercent(operating.capRate)} cap)</span>
            </span>
          </div>

          {/* Below NOI is where the strategies part company: a rental services its purchase
              mortgage, a BRRRR services the loan that replaced it. */}
          <div className="space-y-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">Financing</span>
            {financing.costs.map((line) => (
              <Line key={line.label} label={line.label} value={`$${formatMoney(line.value)}`} />
            ))}
          </div>

          <div className="space-y-1 pt-2 border-t border-gray-200 dark:border-gray-700">
            <div className="flex justify-between items-center">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-200">{financing.headline.label}</span>
              <span className="text-sm font-semibold tabular-nums text-gray-800 dark:text-gray-100">${formatMoney(financing.headline.value)}</span>
            </div>
            {financing.returns.map((line) => (
              <Line key={line.label} label={line.label} value={line.text} muted />
            ))}
          </div>
        </div>
      );
    }

    // Purchase dropdown: house facts (price, cash in) plus the deal-structure rates,
    // each showing the global default as a placeholder until this house overrides it.
    return (
      <div className="mt-4 pl-4 border-l-2 border-gray-200 dark:border-gray-600 space-y-3">
        <ParamField
          paramKey="price"
          value={at('price')}
          globals={globalParams}
          onChange={(v) => setParam('price', v)}
          onCommit={commit}
          testId="purchase-price-field"
          placeholder={displayPrice(house.price)}
        />
        <ParamField paramKey="percentDown" value={at('percentDown')} globals={globalParams}
              onChange={(v) => setParam('percentDown', v)} onCommit={commit} />
        <ParamField paramKey="interestRate" value={at('interestRate')} globals={globalParams}
              onChange={(v) => setParam('interestRate', v)} onCommit={commit} />
        <ParamField
          paramKey="additionalCashInvestment"
          value={at('additionalCashInvestment') === 0 ? null : at('additionalCashInvestment')}
          globals={globalParams}
          onChange={(v) => setParam('additionalCashInvestment', v ?? 0)}
          onCommit={commit}
          testId="additional-cash-field"
        />
        {/* Read off the shared summary, not the mode's own numbers: a BRRRR's answer is what
            is still tied up after the refinance, which is a different field entirely. */}
        {summary && (
          <p className="text-xs text-gray-400 dark:text-gray-500 pt-1">
            {summary.label}: ${formatMoney(summary.totalCashInvested)}
          </p>
        )}
      </div>
    );
  };

  // A house you added is always visible. If the numbers can't be computed we say why,
  // rather than rendering nothing and leaving you to guess.
  return (
    <div
      ref={cardRef}
      data-testid="house-card"
      data-property-id={house.propertyID}
      onMouseEnter={() => onMapHighlight?.(houseKey(house))}
      onMouseLeave={() => onMapHighlight?.(null)}
      onFocusCapture={() => onMapHighlight?.(houseKey(house))}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onMapHighlight?.(null);
      }}
      className={`bg-gray-50 dark:bg-gray-800 p-4 rounded-lg mb-4 text-gray-700 dark:text-gray-300 shadow-sm border transition-colors ${
        highlighted ? 'border-purple-500 ring-2 ring-purple-400' : 'border-gray-200 dark:border-gray-700'
      }`}
    >
      <div className="flex w-full items-center gap-1">
        <button
          type="button"
          data-testid="toggle-house-card"
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => {
            setExpanded((isExpanded) => !isExpanded);
            setOpenSection(null);
          }}
        >
          <span
            data-testid="house-status-dot"
            aria-label={primaryMetricStatus}
            title={primaryMetricStatus}
            className={`h-2.5 w-2.5 shrink-0 rounded-full ${primaryToneDotClasses[primaryTone]}`}
          />
          <span className="min-w-0 flex-1 break-words text-base font-medium leading-snug text-gray-900 dark:text-white">
            {house.address || 'Address unavailable'}
          </span>
        </button>
        <button
          type="button"
          aria-label={mapVisible
            ? `Hide ${house.address || 'house'} from map`
            : `Show ${house.address || 'house'} on map`}
          aria-pressed={mapVisible}
          title={mapVisible
            ? 'Hide from map'
            : house.latitude === null || house.longitude === null
              ? 'Location unavailable for this saved house'
              : 'Show on map'}
          disabled={!mapVisible && (house.latitude === null || house.longitude === null)}
          className={`rounded p-1.5 transition-colors disabled:cursor-not-allowed disabled:text-gray-300 ${
            mapVisible
              ? 'bg-pink-100 text-pink-600 ring-1 ring-pink-300 dark:bg-pink-950 dark:text-pink-300 dark:ring-pink-700'
              : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:text-gray-500 dark:hover:bg-gray-700 dark:hover:text-gray-300'
          }`}
          onClick={() => onShowOnMap?.(house)}
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 6.75 3 3v13.5l6 3.75 6-3.75 6 3.75V6.75L15 3 9 6.75Zm0 0v13.5M15 3v13.5" />
          </svg>
        </button>
        <button
          type="button"
          aria-label={`Enrich ${house.address || 'house'} from ${SITE_NAMES[house.source ?? 'redfin']}`}
          title={house.details?.enrichedAt
            ? `Refresh enrichment from ${SITE_NAMES[house.source ?? 'redfin']} (last updated ${new Date(house.details.enrichedAt).toLocaleString()})`
            : `Open ${SITE_NAMES[house.source ?? 'redfin']} and enrich this house`}
          className={`rounded p-1.5 transition-colors ${
            house.details?.enrichedAt
              ? 'text-emerald-600 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950'
              : 'text-violet-500 hover:bg-violet-50 hover:text-violet-600 dark:hover:bg-violet-950'
          }`}
          onClick={() => window.open(house.url, '_blank')}
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m12 3 1.15 3.35L16.5 7.5l-3.35 1.15L12 12l-1.15-3.35L7.5 7.5l3.35-1.15L12 3Zm6 9 .8 2.2L21 15l-2.2.8L18 18l-.8-2.2L15 15l2.2-.8L18 12ZM6.5 13l1.05 2.95L10.5 17l-2.95 1.05L6.5 21l-1.05-2.95L2.5 17l2.95-1.05L6.5 13Z" />
          </svg>
        </button>
        <button
          type="button"
          aria-label={`Open listing on ${SITE_NAMES[house.source ?? 'redfin']}`}
          title={`Open on ${SITE_NAMES[house.source ?? 'redfin']}`}
          className="rounded p-1.5 text-blue-500 hover:bg-blue-50 hover:text-blue-600 dark:hover:bg-blue-950"
          onClick={() => window.open(house.url, '_blank')}
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </button>
        <button
          type="button"
          aria-label="Remove house"
          title="Remove house"
          className="rounded p-1.5 text-red-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
          onClick={() => {
            chrome.runtime.sendMessage({
              action: "removeHouse",
              propertyID: house.propertyID,
              source: house.source,
              address: house.address
            });
            onRemoved?.(house.address);
          }}
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18 18 6M6 6l12 12" />
          </svg>
        </button>
        <button
          type="button"
          aria-label={expanded ? 'Collapse house details' : 'Expand house details'}
          aria-expanded={expanded}
          className="rounded p-1 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
          onClick={() => {
            setExpanded((isExpanded) => !isExpanded);
            setOpenSection(null);
          }}
        >
          <DropdownArrow isOpen={expanded} />
        </button>
      </div>

      {expanded && (<>
      <div className="pt-3">
        <div className="space-y-3">
          <div className="flex items-baseline gap-2 text-sm">
            <span className="font-medium text-gray-700 dark:text-gray-300 tabular-nums">{displayPrice(house.price)}</span>
            <span className="text-gray-500 dark:text-gray-400">
              {house.beds ?? '—'} bd · {house.baths ?? '—'} ba
            </span>
          </div>
          {house.details?.tax?.annualAmount != null && (
            <div className="text-xs text-gray-500 dark:text-gray-400">
              Property tax: ${house.details.tax.annualAmount.toLocaleString()}/yr
              {house.details.tax.year ? ` (${house.details.tax.year})` : ''}
              {house.details.tax.sourceLabel ? ` · ${house.details.tax.sourceLabel}` : ''}
            </div>
          )}

          <ModePicker
            house={house}
            globalParams={globalParams}
            overrides={overrides}
            onPick={pickMode}
          />

          {/*
            One line, three metrics, chosen once in the panel. Without rent there are no
            returns to show, so the hint takes the strip's place rather than sitting under a
            row of dashes -- that stacking was most of the card's wasted height.
          */}
          {/*
            Order matters. A failure comes first because it is the one thing entering more
            numbers cannot fix -- an unreadable price stays unreadable however much rent you
            type. Only then does a missing input become a prompt rather than an error: a flip
            with no after-repair value is unfinished, not broken.
          */}
          {analysis === null ? (
            <div
              data-testid="analysis-error"
              className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200 text-left"
            >
              {analysisReason}
            </div>
          ) : missing !== null ? (
            <p data-testid="needs-rent-hint" className="text-xs text-gray-400 dark:text-gray-500">
              {PROMPT_FOR_MISSING[missing] ?? 'Enter the remaining details below to see returns'}
            </p>
          ) : (
            /* Equal thirds rather than justify-between: the strip is always exactly
               CARD_METRIC_COUNT chips, and fixed columns keep them aligned down the board
               instead of shifting with each card's value widths. */
            <div data-testid="verdict-strip" className="grid grid-cols-3 gap-2">
              {metricDefs.map((metric) => (
                <StatChip
                  key={metric.key}
                  label={metric.label}
                  testId={metric.testId}
                  value={metric.format(analysis)}
                  tone={metric.tone(analysis)}
                />
              ))}
            </div>
          )}
          {/*
            TODO(rent-model): house.taxError and house.rentError were surfaced here, but no
            tax or rent service is running, so every capture showed a failure message for a
            feature that doesn't exist yet. The background worker still records both fields;
            re-render them here once the model service is real.
          */}

          {/*
            Full-width rows, not a 3-column grid. The side panel is ~320px of content;
            three columns of label + input + chevron gave each about 100px, which
            collided the headings into each other and squeezed the inputs down to a
            single visible character.
          */}
          {/*
            One row per section the mode declares, rather than three hardcoded ones. A flip
            has no rent row and does have a rehab row; neither is knowable here, so neither is
            written here.
          */}
          <div className="space-y-1.5">
            {MODES[mode].sections.map((section) => (
              <div key={section.id} className="flex items-center gap-2">
                <span className="text-xs text-gray-500 dark:text-gray-400 font-medium w-20 shrink-0">{section.label}</span>
                {/* Rent is the one summary that is also an input -- it is the number people
                    change most, and burying it one click down was the old card's worst tax. */}
                {section.id === 'rent' ? (
                  <input
                    type="text"
                    inputMode="decimal"
                    data-testid="rent-field"
                    className="flex-1 min-w-0 border border-gray-300 dark:border-gray-600 rounded p-1 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 text-sm tabular-nums"
                    placeholder={predictedRent ? `$${predictedRent.mid.toLocaleString()}` : 'Enter rent'}
                    value={rentBuffer.text}
                    onChange={(e) => rentBuffer.handleInput(e.target.value)}
                    onBlur={rentBuffer.handleBlur}
                  />
                ) : (
                  <ReadOnlyRowValue value={sectionSummary(section.id)} />
                )}
                <button
                  type="button"
                  data-testid={TOGGLE_TEST_IDS[section.id] ?? `toggle-${section.id}`}
                  aria-label={`${section.label} details`}
                  className="text-gray-600 dark:text-gray-300 rounded transition-colors shrink-0"
                  onClick={() => setOpenSection(openSection === section.id ? null : section.id)}
                >
                  <DropdownArrow isOpen={openSection === section.id} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* No summary footer: it repeated Cash Flow and Cash-on-Cash, which the verdict
          strip above already shows on every card. */}
      {/*
        A section left open across a mode switch may no longer exist in the new mode
        (Flip has no 'rent' section) -- `find` then returns undefined, and rendering
        that unconditionally used to crash the whole panel with no error boundary to
        catch it. Falling back to null here, rather than to some other section, is
        deliberate: a mode switch closing whatever was open is the same "start clean"
        behaviour ModePicker already gives the rest of the card.
      */}
      {openSection && (() => {
        const section = MODES[mode].sections.find((s) => s.id === openSection);
        return section ? renderSection(section) : null;
      })()}
      </>)}
    </div>
  )
}

/**
 * Sorting is keyed on a metric rather than its own closed list of orders, which is what lets
 * a mixed-mode board sort at all: a flip has no cap rate to rank by, and a hardcoded 'caprate'
 * case would have had nothing sensible to return for one.
 */
export type SortOrder = 'newest' | MetricKey;

export const NEWEST_FIRST_LABEL = 'Newest first';

/** The metric a sort order ranks by, or null for houses that don't compute a real value for it (they sink to the bottom). */
function sortMetric(house: House, order: SortOrder, globalParams: GlobalParameters): number | null {
  if (order === 'newest') return null;

  // Through the mode seam, so a house saved under a different mode is ranked by that mode's
  // arithmetic rather than always as a rental.
  const result = analyzeStoredHouse(house, globalParams);
  if (!result.ok) return null;

  const mode = resolveMode(house.localParams?.mode ?? null, globalParams.mode).value;
  // A house whose mode doesn't offer this metric has no opinion about it, and one that is
  // missing a required input hasn't earned a ranking yet. Both sink rather than sorting as 0.
  if (missingRequirement(mode, storedOverrides(house))) return null;
  const metric = MODES[mode].metrics.find((candidate) => candidate.key === order);
  if (!metric) return null;

  return metric.value(result.analysis.detail);
}

/**
 * Every metric offered by at least one mode present on the board, in registry order.
 *
 * Scoped to the modes actually in use rather than to all of them: offering to sort a board of
 * rentals by flip ROI would rank every house null, which reads as the sort being broken.
 */
export function sortableMetrics(houses: House[], globalParams: GlobalParameters): MetricKey[] {
  const modes = new Set(
    houses.map((house) => resolveMode(house.localParams?.mode ?? null, globalParams.mode).value)
  );
  const offered = new Set<MetricKey>();
  for (const mode of modes) {
    for (const metric of MODES[mode].metrics) offered.add(metric.key);
  }
  return (Object.keys(METRICS) as MetricKey[]).filter((key) => offered.has(key));
}

export function sortHouses(houses: House[], order: SortOrder, globalParams: GlobalParameters): House[] {
  const newestFirst = [...houses].reverse();
  if (order === 'newest') return newestFirst;

  // Houses without a computable value for this metric sink to the bottom rather
  // than being hidden -- a saved house should never disappear from the list.
  return newestFirst
    .map((house) => ({ house, value: sortMetric(house, order, globalParams) }))
    .sort((a, b) => {
      if (a.value === null && b.value === null) return 0;
      if (a.value === null) return 1;
      if (b.value === null) return -1;
      return b.value - a.value;
    })
    .map((entry) => entry.house);
}

function SidePanel() {
  const [houses, setHouses] = useState<House[]>([]);
  const [globalParams, setGlobalParams] = useState<GlobalParameters>(DEFAULT_GLOBAL_PARAMETERS);
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest');
  const [undoState, setUndoState] = useState<UndoSummary>({ depth: 0, label: null });
  /** What the toast is currently offering to undo. Null hides it. */
  const [toast, setToast] = useState<string | null>(null);
  const [mapVisibility, setMapVisibility] = useState<MapVisibilityState>({
    defaultVisible: false,
    exceptions: []
  });
  /** Set by a click on one of our pins on the site's own map; cleared a few seconds later
   *  so the ring is a flash, not a permanent marker. */
  const [highlightedHouseKey, setHighlightedHouseKey] = useState<string | null>(null);
  /** How many saved-with-coordinates houses are currently pinned on the visible map, from
   *  the content script's own reconciliation -- null until one ever reports in. */
  const [mapStatus, setMapStatus] = useState<{ shown: number; total: number; missing: number } | null>(null);

  useEffect(() => {
    if (!highlightedHouseKey) return;
    const timer = setTimeout(() => setHighlightedHouseKey(null), 3000);
    return () => clearTimeout(timer);
  }, [highlightedHouseKey]);

  const requestUndo = useCallback(async () => {
    setToast(null);
    try {
      const response = await chrome.runtime.sendMessage({ action: 'undo' });
      if (response && response.ok === false) console.error('Could not undo:', response.reason);
    } catch (error) {
      console.error('Error undoing:', error);
    }
  }, []);

  /**
   * The keyboard half. The toast is what people will actually use in a side panel, but a
   * binding costs nothing and is what anyone reaches for first after a mis-click.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'z' || !(event.metaKey || event.ctrlKey) || event.shiftKey) return;
      // Never steal undo from a field being typed in; the text buffer owns that.
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      event.preventDefault();
      void requestUndo();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [requestUndo]);

  useEffect(() => {
    const loadData = async () => {
      try {
        const result = await chrome.storage.local.get([
          'storedHouses', 'globalParams', 'mapVisibility', 'showHousesOnMap'
        ]);
        if (result.storedHouses) {
          setHouses(result.storedHouses);
        }
        if (result.globalParams) {
          // Merges over the defaults so a panel saved before the newer assumption fields
          // existed still gets real values instead of silent zeros, then applies any
          // pending defaults migration. The persist effect below writes the result back,
          // so the migration runs once. Old keys (primaryMetric) linger in storage
          // harmlessly -- nothing reads them.
          setGlobalParams(migrateGlobalParams(result.globalParams));
        }
        const storedMapVisibility = result.mapVisibility as Partial<MapVisibilityState> | undefined;
        setMapVisibility({
          defaultVisible: typeof storedMapVisibility?.defaultVisible === 'boolean'
            ? storedMapVisibility.defaultVisible
            : Boolean(result.showHousesOnMap),
          exceptions: Array.isArray(storedMapVisibility?.exceptions)
            ? storedMapVisibility.exceptions.filter((key): key is string => typeof key === 'string')
            : []
        });
      } catch (error) {
        console.error("Error loading data:", error);
      }
    };

    loadData();

    const messageListener = (message: unknown) => {
      if (
        typeof message === 'object' && message !== null &&
        (message as { action?: string }).action === 'updateSidePanel' &&
        Array.isArray((message as { houses?: unknown }).houses)
      ) {
        setHouses((message as { houses: House[] }).houses);
        // The worker owns the log; the panel is told only how deep it is and what the top
        // entry was, which is enough to label a button and not enough to write one.
        const undo = (message as { undo?: UndoSummary }).undo;
        if (undo) setUndoState(undo);
        return;
      }

      if (
        typeof message === 'object' && message !== null &&
        (message as { action?: string }).action === 'highlightHouse'
      ) {
        const key = (message as { key?: unknown }).key;
        if (typeof key === 'string') setHighlightedHouseKey(key);
        return;
      }

      if (
        typeof message === 'object' && message !== null &&
        (message as { action?: string }).action === 'mapPinStatus'
      ) {
        const shown = (message as { shown?: unknown }).shown;
        const total = (message as { total?: unknown }).total;
        const missing = (message as { missing?: unknown }).missing;
        if (typeof shown === 'number' && typeof total === 'number') {
          setMapStatus({ shown, total, missing: typeof missing === 'number' ? missing : 0 });
        }
        return;
      }

      if (
        typeof message === 'object' && message !== null &&
        (message as { action?: string }).action === 'mapVisibilityUpdated'
      ) {
        const state = (message as { state?: Partial<MapVisibilityState> }).state;
        if (typeof state?.defaultVisible === 'boolean' && Array.isArray(state.exceptions)) {
          setMapVisibility({
            defaultVisible: state.defaultVisible,
            exceptions: state.exceptions.filter((key): key is string => typeof key === 'string')
          });
        }
      }
    };

    chrome.runtime.onMessage.addListener(messageListener);
    return () => chrome.runtime.onMessage.removeListener(messageListener);
  }, []);

  useEffect(() => {
    if (globalParams.isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [globalParams.isDarkMode]);

  useEffect(() => {
    chrome.storage.local.set({ globalParams });
  }, [globalParams]);

  const highlightMapHouse = useCallback((key: string | null) => {
    chrome.runtime.sendMessage({ action: 'highlightMapHouse', key }).catch(() => {});
  }, []);

  const mapExceptions = useMemo(() => new Set(mapVisibility.exceptions), [mapVisibility.exceptions]);
  const houseIsVisible = useCallback((house: House) => {
    const excepted = mapExceptions.has(houseKey(house));
    return excepted ? !mapVisibility.defaultVisible : mapVisibility.defaultVisible;
  }, [mapExceptions, mapVisibility.defaultVisible]);
  const visibleHouseCount = houses.filter(houseIsVisible).length;

  const toggleHouseOnMap = useCallback(async (house: House) => {
    if ((house.latitude === null || house.longitude === null) && !houseIsVisible(house)) return;
    const key = houseKey(house);
    const response = await chrome.runtime.sendMessage({ action: 'toggleMapHouse', key });
    if (response?.ok && response.state) setMapVisibility(response.state);
    if (houseIsVisible(house) === false) {
      chrome.runtime.sendMessage({ action: 'focusMapHouse', key }).catch(() => {});
    }
  }, [houseIsVisible]);

  const toggleAllMapHouses = useCallback(async () => {
    const response = await chrome.runtime.sendMessage({
      action: 'setMapDefault',
      visible: !mapVisibility.defaultVisible
    });
    if (response?.ok && response.state) setMapVisibility(response.state);
  }, [mapVisibility.defaultVisible]);

  return (
    <div className={`min-h-screen p-4 ${globalParams.isDarkMode ? 'dark bg-gray-900' : 'bg-gray-100'}`}>
      <Title />
      <ParametersSelector 
        parameters={globalParams} 
        setParameters={setGlobalParams}
      />
      {houses.length > 0 && (
        <div className="flex items-center gap-2 mb-3">
          <button
            type="button"
            onClick={toggleAllMapHouses}
            aria-pressed={mapVisibility.defaultVisible}
            className={`text-sm rounded px-2 py-1 border transition-colors ${
              mapVisibility.defaultVisible
                ? 'bg-purple-600 border-purple-600 text-white'
                : 'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200'
            }`}
          >
            {mapVisibility.defaultVisible ? 'Hide all from map' : 'Show all on map'}
          </button>
          {/* Never a claim that every saved house is pinned -- off-viewport houses are
              never forced into view (docs/map-linking.md, anti-bot posture), so this is
              the honest alternative to a silent gap. */}
          {visibleHouseCount > 0 && mapStatus && (
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {mapStatus.shown} of {mapStatus.total} located shown
              {mapStatus.missing > 0 ? ` · ${mapStatus.missing} missing location` : ''}
              {mapVisibility.exceptions.length > 0
                ? ` · ${mapVisibility.exceptions.length} individual override${mapVisibility.exceptions.length === 1 ? '' : 's'}`
                : ''}
            </span>
          )}
        </div>
      )}
      {houses.length > 1 && (
        // min-w-0 on the select's container lets it shrink instead of overflowing the
        // panel; the label is short enough to stay on one line at panel width.
        <div className="flex items-center gap-2 mb-3">
          <span className="text-sm text-gray-500 dark:text-gray-400 shrink-0">{houses.length} houses</span>
          <label htmlFor="sortOrderSelect" className="text-sm text-gray-500 dark:text-gray-400 shrink-0 ml-auto">Sort</label>
          <select
            id="sortOrderSelect"
            className="min-w-0 flex-1 max-w-[190px] rounded border border-gray-300 dark:border-gray-600 p-1 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value as SortOrder)}
          >
            <option value="newest">{NEWEST_FIRST_LABEL}</option>
            {/* The union of what the modes on this board actually offer, so the list never
                proposes ranking by a metric none of these houses computes. */}
            {sortableMetrics(houses, globalParams).map((key) => (
              <option key={key} value={key}>{METRICS[key].longLabel} (high to low)</option>
            ))}
          </select>
        </div>
      )}
      <div id="houseCardContainer" className="space-y-4">
        {houses.length > 0 ? (
          sortHouses(houses, sortOrder, globalParams).map(house => (
            <HouseCard
              key={houseKey(house)}
              house={house}
              globalParams={globalParams}
              onRemoved={(address) => setToast(`Removed ${address}`)}
              onModeChanged={(label) => setToast(`Switched to ${label}`)}
              onShowOnMap={toggleHouseOnMap}
              onMapHighlight={highlightMapHouse}
              mapVisible={houseIsVisible(house)}
              highlighted={highlightedHouseKey === houseKey(house)}
            />
          ))
        ) : (
          <p className="text-gray-600 dark:text-gray-400">No houses selected. Add a house to see details here.</p>
        )}
      </div>
      {/* Suppressed once the log is empty: the worker drops entries it can no longer apply, so
          offering an Undo that would do nothing is worse than offering none. */}
      {toast && undoState.depth > 0 && (
        <UndoToast message={toast} onUndo={requestUndo} onDismiss={() => setToast(null)} />
      )}
    </div>
  );
}

function Title() {
  const [exportState, setExportState] = useState<'idle' | 'exporting' | 'error'>('idle');

  const exportToExcel = () => {
    setExportState('exporting');
    chrome.storage.local.get(['storedHouses', 'globalParams'], async (result) => {
      try {
        const houses: House[] = result.storedHouses || [];
        // Same migration as the panel's load path, so an export can't compute against
        // assumptions the cards aren't using.
        const globalParams: GlobalParameters = migrateGlobalParams(result.globalParams || {});

        if (houses.length === 0) {
          setExportState('idle');
          return;
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);

        // Same analysis the cards render from, so the spreadsheet can never show numbers
        // that disagree with what's on screen -- now per strategy, because a flip and a
        // rental do not share a column set.
        const workbook = buildWorkbook(houses, globalParams);

        // Loaded on demand: xlsx is ~280 kB and is only needed the moment someone actually
        // exports, whereas the panel is opened and closed constantly.
        const { utils: XLSXUtils, writeFile } = await import('xlsx');

        const wb = XLSXUtils.book_new();
        const isFormula = (cell: WorkbookCell): cell is FormulaCell =>
          typeof cell === 'object' && cell !== null && 'formula' in cell;
        const excelCell = (cell: WorkbookCell) => {
          if (!isFormula(cell)) return cell;
          return {
            f: cell.formula.replace(/^=/, ''),
            t: cell.resultType === 'string' ? 's' : 'n',
            v: cell.resultType === 'string' ? '' : 0,
            z: cell.numberFormat
          };
        };
        const addSheet = (sheet: ExportSheet) => {
          const rows = [sheet.headers, ...sheet.rows.map((row) => row.map(excelCell))];
          const ws = XLSXUtils.aoa_to_sheet(rows as unknown[][]);
          ws['!cols'] = sheet.widths.map((wch) => ({ wch }));
          ws['!autofilter'] = {
            ref: `A1:${XLSXUtils.encode_col(sheet.headers.length - 1)}${sheet.rows.length + 1}`
          };

          const urlColumn = sheet.headers.findIndex((header) => header.endsWith('URL'));
          if (urlColumn >= 0) {
            for (let index = 0; index < sheet.rows.length; index += 1) {
              const url = sheet.rows[index][urlColumn];
              if (typeof url !== 'string' || !url) continue;
              const ref = XLSXUtils.encode_cell({ r: index + 1, c: urlColumn });
              if (ws[ref]) ws[ref].l = { Target: url };
            }
          }

          XLSXUtils.book_append_sheet(wb, ws, sheet.name);
        };

        addSheet(workbook.houses);
        addSheet(workbook.comps);
        writeFile(wb, `investor-sidecar-${timestamp}.xlsx`, { cellStyles: true });
        setExportState('idle');
      } catch (error) {
        console.error('Export to Excel failed:', error);
        setExportState('error');
      }
    });
  };

  return (
    /* text-center is explicit because the centring used to be inherited from App.css's
       leftover Vite-template `#root { text-align: center }`, which also cost the panel 2rem
       of padding on each side -- 20% of its width at 320px. */
    <div className="mb-6 text-center">
      <h1 className="text-2xl font-bold mb-2 text-gray-900 dark:text-white">Investor Sidecar</h1>
      <button
        onClick={exportToExcel}
        disabled={exportState === 'exporting'}
        className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700 disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {exportState === 'exporting' ? 'Exporting…' : 'Export to Excel'}
      </button>
      {exportState === 'error' && (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">
          Export failed. Check the browser console for details and try again.
        </p>
      )}
    </div>
  );
}

/** Exported for tests: the global-assumption fields and the card-metric pickers. */
export function ParametersSelector({
  parameters, 
  setParameters 
}: { 
  parameters: GlobalParameters, 
  setParameters: (params: GlobalParameters) => void 
}) {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <div className="mb-6 bg-gray-50 dark:bg-gray-800 rounded-lg p-4 shadow-sm border border-gray-200 dark:border-gray-700">
      <div className="flex justify-between items-center cursor-pointer" onClick={() => setIsExpanded(!isExpanded)}>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Global Parameters</h2>
        <div className="flex items-center space-x-2">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setParameters({
                ...parameters,
                isDarkMode: !parameters.isDarkMode
              });
            }}
            className="p-2 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700"
          >
            {parameters.isDarkMode ? (
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-gray-800 dark:text-yellow-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-gray-800" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
              </svg>
            )}
          </button>
          <svg 
            className={`w-6 h-6 transform transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''} text-black dark:text-gray-200`}
            fill="none" 
            stroke="currentColor" 
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </div>

      <div className={`space-y-5 mt-4 transition-all duration-200 ${isExpanded ? 'block' : 'hidden'}`}>
        <p className="text-xs text-gray-500 dark:text-gray-400 -mt-1">
          These are your defaults. Every house inherits them until its own Purchase or Expenses dropdown overrides a specific field.
        </p>

        <div>
          <span className="text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500 block mb-2">Financing</span>
          <div className="grid grid-cols-2 gap-3">
            <GlobalNumberField id="percentDownInput" label="Down payment" value={parameters.percentDown} max={100}
              onChange={(v) => setParameters({ ...parameters, percentDown: v ?? 0 })} />
            <GlobalNumberField id="interestRateInput" label="Interest rate" value={parameters.interestRate} max={20}
              onChange={(v) => setParameters({ ...parameters, interestRate: v ?? 0 })} />
            <GlobalNumberField id="downPaymentInput" label="Max cash down" value={parameters.maxDown} suffix="$"
              onChange={(v) => setParameters({ ...parameters, maxDown: v })} />
            <GlobalNumberField id="pmiRateInput" label="PMI (under 20% down)" value={parameters.pmiRate} max={5}
              onChange={(v) => setParameters({ ...parameters, pmiRate: v ?? 0 })} />
          </div>
        </div>

        <div>
          <span className="text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500 block mb-2">Operating assumptions</span>
          <div className="grid grid-cols-2 gap-3">
            <GlobalNumberField id="propertyTaxRateInput" label="Property tax" value={parameters.propertyTaxRate ?? null} max={10}
              placeholder="e.g. 1.2"
              onChange={(v) => setParameters({ ...parameters, propertyTaxRate: v })} />
            <GlobalNumberField id="insuranceRateInput" label="Insurance" value={parameters.insuranceRate} max={5}
              onChange={(v) => setParameters({ ...parameters, insuranceRate: v ?? 0 })} />
            <GlobalNumberField id="vacancyRateInput" label="Vacancy" value={parameters.vacancyRate} max={100}
              onChange={(v) => setParameters({ ...parameters, vacancyRate: v ?? 0 })} />
            <GlobalNumberField id="maintenanceRateInput" label="Maintenance" value={parameters.maintenanceRate} max={100}
              onChange={(v) => setParameters({ ...parameters, maintenanceRate: v ?? 0 })} />
            <GlobalNumberField id="capExRateInput" label="CapEx reserve" value={parameters.capExRate} max={100}
              onChange={(v) => setParameters({ ...parameters, capExRate: v ?? 0 })} />
            <GlobalNumberField id="managementRateInput" label="Management" value={parameters.managementRate} max={100}
              onChange={(v) => setParameters({ ...parameters, managementRate: v ?? 0 })} />
            <GlobalNumberField id="closingCostRateInput" label="Closing costs" value={parameters.closingCostRate} max={20}
              onChange={(v) => setParameters({ ...parameters, closingCostRate: v ?? 0 })} />
          </div>
        </div>

        {/* Tiles rather than a select: there is width for them here, and the one-line
            description is what tells someone which strategy they are picking. */}
        {hasMultipleModes && (
          <div>
            <span className="text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500 block mb-2">Strategy</span>
            <div className="grid grid-cols-2 gap-2">
              {MODE_IDS.map((id) => {
                const selected = parameters.mode === id;
                return (
                  <button
                    key={id}
                    type="button"
                    data-testid={`global-mode-${id}`}
                    aria-pressed={selected}
                    className={`rounded-lg border p-2 text-left transition-colors ${
                      selected
                        ? 'border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-950'
                        : 'border-gray-300 bg-white hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:hover:bg-gray-700'
                    }`}
                    onClick={() => setParameters({ ...parameters, mode: id })}
                  >
                    <span className={`block text-sm font-medium ${
                      selected ? 'text-blue-900 dark:text-blue-100' : 'text-gray-800 dark:text-gray-200'
                    }`}>
                      {MODES[id].label}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-tight text-gray-500 dark:text-gray-400">
                      {MODES[id].description}
                    </span>
                  </button>
                );
              })}
            </div>
            {/* Said plainly because this control exists at two levels and only one of them is
                undoable: the per-card one goes through the worker, this one does not. */}
            <p className="mt-1.5 text-xs text-gray-400 dark:text-gray-500">
              Applies to every house that hasn't chosen its own.
            </p>
          </div>
        )}

        <div>
          <span className="text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500 block mb-2">Metrics on each card</span>
          <div className="flex flex-col gap-2">
            {Array.from({ length: CARD_METRIC_COUNT }, (_, slot) => {
              // Scoped to the active mode, and stored under it: a flip has no DSCR to offer,
              // and a selection made for one strategy must not follow the user into another.
              const activeMode = resolveMode(null, parameters.mode).value;
              const selected = cardMetricsFor(parameters, activeMode);
              return (
                <select
                  key={slot}
                  id={`cardMetric${slot}Input`}
                  aria-label={`Card metric ${slot + 1}`}
                  className="rounded border border-gray-300 dark:border-gray-600 p-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm"
                  value={selected[slot]}
                  onChange={(e) => {
                    const next = [...selected];
                    const chosen = e.target.value as MetricKey;
                    // Picking a metric already in another slot would render it twice, so swap
                    // the two rather than silently dropping one.
                    const existing = next.indexOf(chosen);
                    if (existing !== -1) next[existing] = next[slot];
                    next[slot] = chosen;
                    setParameters({
                      ...parameters,
                      cardMetrics: { ...parameters.cardMetrics, [activeMode]: next }
                    });
                  }}
                >
                  {MODES[activeMode].metrics.map((metric) => (
                    <option key={metric.key} value={metric.key}>{metric.longLabel}</option>
                  ))}
                </select>
              );
            })}
          </div>
        </div>

      </div>
    </div>
  );
}

export default SidePanel
