import { describe, expect, it } from 'vitest';
import { buildWorkbook, summaryRow } from '../src/export';
import { DEFAULT_GLOBAL_PARAMETERS } from '../src/App';
import { MODES } from '../src/modes';
import type { House, GlobalParameters } from '../src/App';

/**
 * The spreadsheet, per strategy.
 *
 * One flat sheet cannot describe a mixed board: a flip has no cap rate and a BRRRR has no
 * single "cash invested", so a shared column set would be mostly blanks and the numbers that
 * matter most in each mode would have nowhere to go. Each mode gets the columns its own
 * metrics define; the index carries what they genuinely share.
 *
 * Everything routes through analyzeStoredHouse, so a row can never disagree with the card
 * that produced it.
 */

const globalParams: GlobalParameters = { ...DEFAULT_GLOBAL_PARAMETERS, propertyTaxRate: 1.2 };

const house = (id: string, overrides: Partial<House> = {}): House => ({
  address: `${id} Test St, Dallas, TX 75210`,
  price: '$400,000',
  beds: '3', baths: '2', sqft: '1,800',
  propertyID: id,
  url: `https://www.redfin.com/home/${id}`,
  latitude: 32.7, longitude: -96.8,
  localParams: { sliderValue: 2800 },
  ...overrides
});

const flip = (id: string) => house(id, {
  localParams: { sliderValue: 0, mode: 'flip', arv: 520000, rehabBudget: 45000 }
});
const brrrr = (id: string) => house(id, {
  localParams: { sliderValue: 2800, mode: 'brrrr', arv: 520000, rehabBudget: 45000 }
});

describe('the index sheet', () => {
  it('lists every house whatever strategy it is under', () => {
    const { index } = buildWorkbook([house('a'), flip('b'), brrrr('c')], globalParams);
    expect(index).toHaveLength(3);
    expect(index.map((row) => row.Strategy)).toEqual(['Buy and hold', 'Fix and flip', 'BRRRR']);
  });

  it('carries only figures that mean the same thing under every strategy', () => {
    const { index } = buildWorkbook([house('a')], globalParams);
    expect(index[0]['Purchase Price']).toBe(400000);
    expect(typeof index[0]['Cash In Deal']).toBe('number');
  });

  /** Which is what makes a mixed board comparable at all: each row says what its number is. */
  it('names the headline metric rather than assuming a shared one', () => {
    const { index } = buildWorkbook([house('a'), flip('b')], globalParams);
    expect(index[0].Headline).toBe('Monthly cash flow');
    expect(index[1].Headline).toBe('Max allowable offer');
    expect(typeof index[0]['Headline Value']).toBe('number');
  });

  it('explains a house it could not analyse instead of dropping it', () => {
    const { index } = buildWorkbook([house('a', { price: 'Contact agent' })], globalParams);
    expect(index).toHaveLength(1);
    expect(index[0]['Purchase Price']).toBeNull();
    expect(index[0].Notes).toMatch(/readable price/i);
  });

  /** A house the card would have prompted for gets no headline figure either. */
  it('leaves the headline blank for a house still missing an input', () => {
    const { index } = buildWorkbook([house('a', { localParams: { sliderValue: 0 } })], globalParams);
    expect(index[0]['Headline Value']).toBeNull();
    expect(index[0].Notes).toMatch(/monthly rent/i);
  });
});

describe('per-mode sheets', () => {
  it('gives each strategy its own sheet, named for it', () => {
    const { sheets } = buildWorkbook([house('a'), flip('b'), brrrr('c')], globalParams);
    expect(sheets.map((sheet) => sheet.name)).toEqual(['Buy and hold', 'Fix and flip', 'BRRRR']);
  });

  /** A sheet of headers for a strategy nothing uses is just a thing to close. */
  it('skips a strategy nothing on the board uses', () => {
    const { sheets } = buildWorkbook([house('a')], globalParams);
    expect(sheets).toHaveLength(1);
    expect(sheets[0].name).toBe('Buy and hold');
  });

  it('columns each sheet from that mode\'s own metrics', () => {
    const { sheets } = buildWorkbook([house('a'), flip('b')], globalParams);
    const rental = sheets.find((s) => s.name === 'Buy and hold')!;
    const flipSheet = sheets.find((s) => s.name === 'Fix and flip')!;

    expect(Object.keys(rental.rows[0])).toContain('Monthly cash flow');
    expect(Object.keys(rental.rows[0])).toContain('Debt service coverage');
    // And nothing from the other strategy.
    expect(Object.keys(rental.rows[0])).not.toContain('Net profit');
    expect(Object.keys(flipSheet.rows[0])).toContain('Net profit');
    expect(Object.keys(flipSheet.rows[0])).not.toContain('Debt service coverage');
  });

  /** Constant within a sheet, so it belongs on the index and not in every row. */
  it('does not repeat the strategy inside its own sheet', () => {
    const { sheets } = buildWorkbook([house('a')], globalParams);
    expect(Object.keys(sheets[0].rows[0])).not.toContain('Strategy');
  });

  it('writes real numbers so Excel can total them', () => {
    const { sheets } = buildWorkbook([house('a')], globalParams);
    expect(typeof sheets[0].rows[0]['Monthly cash flow']).toBe('number');
    expect(typeof sheets[0].rows[0]['Purchase Price']).toBe('number');
  });

  it('groups several houses of the same strategy onto one sheet', () => {
    const { sheets } = buildWorkbook([house('a'), house('b'), flip('c')], globalParams);
    const rental = sheets.find((s) => s.name === 'Buy and hold')!;
    // Two houses plus the totals row.
    expect(rental.rows).toHaveLength(3);
  });
});

/**
 * Totals only within a strategy, because that is the only place columns are comparable -- and
 * each column combines the way its own metric declares. A summed cap rate is nonsense.
 */
describe('the totals row', () => {
  it('adds up money and averages rates', () => {
    const rows = [
      { Address: 'a', 'Monthly cash flow': 100, 'Cap rate': 6, 'Cash In Deal': 50000 },
      { Address: 'b', 'Monthly cash flow': 300, 'Cap rate': 8, 'Cash In Deal': 70000 }
    ];
    const total = summaryRow('rental', rows);
    expect(total['Monthly cash flow']).toBe(400);
    expect(total['Cap rate']).toBe(7);
    expect(total['Cash In Deal']).toBe(120000);
  });

  it('says how many houses it covers', () => {
    expect(summaryRow('rental', [{ Address: 'a' }, { Address: 'b' }]).Notes).toBe('2 houses');
    expect(summaryRow('rental', [{ Address: 'a' }]).Notes).toBe('1 house');
  });

  it('ignores rows with nothing to contribute rather than counting them as zero', () => {
    const rows = [
      { Address: 'a', 'Monthly cash flow': 200 },
      { Address: 'b', 'Monthly cash flow': null }
    ];
    expect(summaryRow('rental', rows)['Monthly cash flow']).toBe(200);
  });

  it('is blank for a column no row filled in', () => {
    expect(summaryRow('rental', [{ Address: 'a' }])['Monthly cash flow']).toBeNull();
  });

  it('appears last on each sheet', () => {
    const { sheets } = buildWorkbook([house('a')], globalParams);
    expect(sheets[0].rows.at(-1)!.Address).toBe('TOTAL / AVERAGE');
  });

  /** Declared per metric, since nothing in a row distinguishes a dollar from a percentage. */
  it('every metric says how it aggregates', () => {
    for (const mode of Object.values(MODES)) {
      for (const metric of mode.metrics) {
        expect(['sum', 'average'], `${metric.key}`).toContain(metric.aggregate);
      }
    }
  });
});
