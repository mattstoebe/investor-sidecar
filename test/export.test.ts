import { describe, expect, it } from 'vitest';
import { buildWorkbook } from '../src/export';
import type { FormulaCell } from '../src/export';
import { DEFAULT_GLOBAL_PARAMETERS } from '../src/App';
import type { Comp, GlobalParameters, House } from '../src/App';

const globals: GlobalParameters = { ...DEFAULT_GLOBAL_PARAMETERS, propertyTaxRate: 1.2 };

const comp = (kind: Comp['kind'], id: string, amount: number): Comp => ({
  source: 'redfin', propertyID: id, kind,
  listingStatus: kind === 'rent' ? undefined : 'sold',
  address: `${id} Comp St`, amount,
  amountLabel: kind === 'rent' ? 'rent' : 'sold',
  beds: '3', baths: '2', sqft: '1,600',
  url: `https://www.redfin.com/home/${id}`,
  capturedAt: Date.UTC(2026, 6, 1)
});

const house = (id: string, overrides: Partial<House> = {}): House => ({
  source: 'redfin',
  address: `${id} Test St, Dallas, TX 75210`,
  price: '$400,000', beds: '3', baths: '2', sqft: '1,800',
  propertyID: id, url: `https://www.redfin.com/home/${id}`,
  latitude: 32.7, longitude: -96.8,
  localParams: { sliderValue: 2800 },
  ...overrides
});

const at = (headers: string[], row: unknown[], header: string) => row[headers.indexOf(header)];
const asFormula = (value: unknown): FormulaCell => {
  expect(value).toMatchObject({ formula: expect.stringMatching(/^=/) });
  return value as FormulaCell;
};

describe('two-sheet Excel model', () => {
  it('exports exactly one row per house and one row per comparable', () => {
    const workbook = buildWorkbook([
      house('a', { comps: [comp('sold', 's1', 425000), comp('rent', 'r1', 2900)] }),
      house('b')
    ], globals);

    expect([workbook.houses.name, workbook.comps.name]).toEqual(['Houses', 'House Comps']);
    expect(workbook.houses.rows).toHaveLength(2);
    expect(workbook.comps.rows).toHaveLength(2);
    expect(workbook.houses.rows.every((row) => row.length === workbook.houses.headers.length)).toBe(true);
    expect(workbook.comps.rows.every((row) => row.length === workbook.comps.headers.length)).toBe(true);
  });

  it('includes enriched listing and public tax facts without confusing estimates for annual tax', () => {
    const workbook = buildWorkbook([house('a', {
      details: {
        enrichedAt: Date.UTC(2026, 7, 3), propertyType: 'Single Family', yearBuilt: 1925,
        tax: {
          year: 2025, annualAmount: 6200, assessedValue: 355000,
          estimatedMonthlyAmount: 900, sourceLabel: 'Redfin tax history',
          history: [{ year: 2025, annualAmount: 6200, assessedValue: 355000 }]
        },
        extraFacts: [{ label: 'Heating', value: 'Forced air' }]
      }
    })], globals);
    const row = workbook.houses.rows[0];

    expect(at(workbook.houses.headers, row, 'Property Type')).toBe('Single Family');
    expect(at(workbook.houses.headers, row, 'Reported Annual Tax')).toBe(6200);
    expect(at(workbook.houses.headers, row, 'Estimated Monthly Tax')).toBe(900);
    expect(String(at(workbook.houses.headers, row, 'Other Listing Facts'))).toContain('Heating: Forced air');
  });

  it('seeds analysis and comp summaries with formulas instead of frozen results', () => {
    const workbook = buildWorkbook([house('a', {
      details: { tax: { annualAmount: 6000, year: 2025 } },
      comps: [comp('sold', 's1', 425000), comp('rent', 'r1', 2900)]
    })], globals);
    const row = workbook.houses.rows[0];

    expect(asFormula(at(workbook.houses.headers, row, 'Effective Annual Tax')).formula)
      .toMatch(/^=IF\(.+<>"",.+\/100,IF\(.+<>"",.+,.+\/100\)\)$/);
    expect(asFormula(at(workbook.houses.headers, row, 'Monthly P&I')).formula).toContain('PMT(');
    expect(asFormula(at(workbook.houses.headers, row, 'Average Sale Comp')).formula).toContain('AVERAGEIFS');
    expect(asFormula(at(workbook.houses.headers, row, 'Cap Rate %')).numberFormat).toBe('0.00%');
  });

  it('labels rent and sale comps and links each row back to its subject through formulas', () => {
    const workbook = buildWorkbook([house('a', {
      comps: [comp('sold', 's1', 425000), comp('rent', 'r1', 2900)]
    })], globals);
    const [sale, rent] = workbook.comps.rows;

    expect(at(workbook.comps.headers, sale, 'Comp Type')).toBe('Sale');
    expect(at(workbook.comps.headers, rent, 'Comp Type')).toBe('Rent');
    expect(asFormula(at(workbook.comps.headers, sale, 'Subject Address')).resultType).toBe('string');
    expect(asFormula(at(workbook.comps.headers, sale, 'Subject Price')).formula).toContain("'Houses'!");
    expect(asFormula(at(workbook.comps.headers, rent, 'Amount Delta %')).numberFormat).toBe('0.0%');
  });

  it('lets an explicit per-house tax rate override page tax in the formula precedence', () => {
    const workbook = buildWorkbook([house('a', {
      localParams: { sliderValue: 2800, propertyTaxRate: 2 },
      details: { tax: { annualAmount: 6000 } }
    })], globals);
    const formulaCell = asFormula(at(
      workbook.houses.headers,
      workbook.houses.rows[0],
      'Effective Annual Tax'
    ));

    expect(formulaCell.formula).toContain('/100');
    expect(at(workbook.houses.headers, workbook.houses.rows[0], 'Tax Rate Override %')).toBe(2);
  });
});
