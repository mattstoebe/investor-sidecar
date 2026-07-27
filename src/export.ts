import { parseMoney } from './analysis';
import { analyzeStoredHouse, resolveMode, storedOverrides, missingRequirement, MODES, MODE_IDS } from './modes';
import { PARAMS } from './params';
import type { ModeId } from './modes';
import type { House, GlobalParameters } from './App';

const round2 = (value: number) => Math.round(value * 100) / 100;
const nullableRound = (value: number | null) => (value === null ? null : round2(value));

/** Parses a scraped sqft string ("1,800", "N/A", undefined) into a number or null, never throwing. */
function parseSqft(input: string | null | undefined): number | null {
  if (!input) return null;
  const parsed = Number(input.replace(/,/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * A workbook of one sheet per strategy, plus an index.
 *
 * One flat sheet cannot describe a mixed board: a flip has no cap rate and a BRRRR has no
 * single "cash invested", so a shared column set would be mostly blanks and the two most
 * important numbers in each mode would have nowhere to go. Instead each mode gets the columns
 * its own metrics define, and the index carries what they genuinely share.
 */

/** The columns every mode can fill, which is what makes the index worth having. */
export interface IndexRow {
  Address: string;
  Strategy: string;
  'Purchase Price': number | null;
  'Cash In Deal': number | null;
  Headline: string;
  'Headline Value': number | null;
  'Property URL': string;
  Notes: string;
}

export interface ModeSheet {
  /** The sheet name, which is the mode's label. */
  name: string;
  /** Its houses, with a totals row last. */
  rows: SheetRow[];
}

export type SheetRow = Record<string, string | number | null>;

/**
 * The totals line for one strategy's sheet.
 *
 * Only within a strategy, because that is the only place the columns are comparable -- and
 * each column combines the way its metric says it does. A summed cap rate would be nonsense,
 * and nothing in the row itself distinguishes a dollar from a percentage, which is why
 * MetricDef declares it rather than this function guessing.
 */
export function summaryRow(mode: ModeId, rows: SheetRow[]): SheetRow {
  const summary: SheetRow = { Address: 'TOTAL / AVERAGE' };
  const aggregates = new Map<string, 'sum' | 'average'>(
    MODES[mode].metrics.map((metric) => [metric.longLabel, metric.aggregate])
  );
  // Cash in the deal is money in every mode, so it always adds up.
  aggregates.set('Cash In Deal', 'sum');
  aggregates.set('Purchase Price', 'sum');
  aggregates.set('Square Feet', 'sum');

  for (const [column, how] of aggregates) {
    const values = rows
      .map((row) => row[column])
      .filter((value): value is number => typeof value === 'number');
    if (values.length === 0) {
      summary[column] = null;
      continue;
    }
    const total = values.reduce((a, b) => a + b, 0);
    summary[column] = round2(how === 'sum' ? total : total / values.length);
  }

  summary.Notes = `${rows.length} house${rows.length === 1 ? '' : 's'}`;
  return summary;
}

export interface Workbook {
  index: IndexRow[];
  sheets: ModeSheet[];
}

/**
 * Groups houses by the strategy they are stored under and builds a sheet for each.
 *
 * Columns come from the mode's own metric definitions via value(), which is what that split
 * from format() was for: the spreadsheet gets real numbers Excel can sum, and adding a metric
 * to a mode adds a column here without touching this function.
 */
export function buildWorkbook(houses: House[], globalParams: GlobalParameters): Workbook {
  const index: IndexRow[] = [];
  const byMode = new Map<ModeId, Record<string, string | number | null>[]>();

  for (const house of houses) {
    const mode = resolveMode(house.localParams?.mode ?? null, globalParams.mode).value;
    const definition = MODES[mode];
    const result = analyzeStoredHouse(house, globalParams);

    const notes: string[] = [];
    if (parseMoney(house.price) === null && house.localParams?.price == null) {
      notes.push('Price could not be read from the listing.');
    }
    const missing = missingRequirement(mode, storedOverrides(house));
    if (missing) notes.push(`No ${PARAMS[missing].label.toLowerCase()} entered.`);

    const headline = definition.metrics.find((m) => m.key === definition.defaultMetrics[0]);

    if (!result.ok) {
      index.push({
        Address: house.address || '(no address)',
        Strategy: definition.label,
        'Purchase Price': null,
        'Cash In Deal': null,
        Headline: headline?.longLabel ?? '',
        'Headline Value': null,
        'Property URL': house.url || '',
        Notes: [result.reason, ...notes].join(' ')
      });
      continue;
    }

    const { summary, detail } = result.analysis;
    index.push({
      Address: house.address || '(no address)',
      Strategy: definition.label,
      'Purchase Price': round2(summary.price),
      'Cash In Deal': round2(summary.totalCashInvested),
      Headline: headline?.longLabel ?? '',
      // Blank rather than a number the card would not have shown either: a mode missing a
      // required input has not produced a figure worth ranking against the others.
      'Headline Value': missing || !headline ? null : nullableRound(headline.value(detail)),
      'Property URL': house.url || '',
      Notes: notes.join(' ')
    });

    const row: Record<string, string | number | null> = {
      Address: house.address || '(no address)',
      'Purchase Price': round2(summary.price),
      'Square Feet': parseSqft(house.sqft),
      Beds: house.beds ?? '',
      Baths: house.baths ?? ''
    };
    // No Strategy column inside a per-mode sheet: it is constant there, and the index has it.
    for (const metric of definition.metrics) {
      row[metric.longLabel] = missing ? null : nullableRound(metric.value(detail));
    }
    row['Cash In Deal'] = round2(summary.totalCashInvested);
    row['Property URL'] = house.url || '';
    row.Notes = notes.join(' ');

    const rows = byMode.get(mode) ?? [];
    rows.push(row);
    byMode.set(mode, rows);
  }

  // Registry order rather than encounter order, so the same board always exports the same way.
  const sheets: ModeSheet[] = [];
  for (const id of MODE_IDS) {
    const rows = byMode.get(id);
    // Skipped rather than emitted empty: a sheet of headers for a strategy nothing uses is
    // just a thing to close.
    if (!rows || rows.length === 0) continue;
    sheets.push({ name: MODES[id].label, rows: [...rows, summaryRow(id, rows)] });
  }

  return { index, sheets };
}
