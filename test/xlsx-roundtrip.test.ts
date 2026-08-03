import { describe, expect, it } from 'vitest';
import { utils as XLSXUtils, write as xlsxWrite, read as xlsxRead } from 'xlsx';
import { buildWorkbook } from '../src/export';
import type { ExportSheet, FormulaCell, WorkbookCell } from '../src/export';
import { DEFAULT_GLOBAL_PARAMETERS } from '../src/App';
import type { Comp, House } from '../src/App';

const isFormula = (cell: WorkbookCell): cell is FormulaCell =>
  typeof cell === 'object' && cell !== null && 'formula' in cell;

const append = (wb: ReturnType<typeof XLSXUtils.book_new>, sheet: ExportSheet) => {
  const rows = [sheet.headers, ...sheet.rows.map((row) => row.map((cell) => isFormula(cell) ? {
    f: cell.formula.replace(/^=/, ''),
    t: cell.resultType === 'string' ? 's' : 'n',
    v: cell.resultType === 'string' ? '' : 0,
    z: cell.numberFormat
  } : cell))];
  XLSXUtils.book_append_sheet(wb, XLSXUtils.aoa_to_sheet(rows as unknown[][]), sheet.name);
};

describe('xlsx round trip through SheetJS', () => {
  it('writes both sheets with numeric inputs and live Excel formulas', () => {
    const comparable: Comp = {
      source: 'zillow', propertyID: 'comp-1', kind: 'rent', address: '2 Comp St',
      amount: 2400, amountLabel: 'rent', beds: '3', baths: '2', sqft: '1,400',
      url: 'https://www.zillow.com/homedetails/comp-1', capturedAt: Date.UTC(2026, 7, 3)
    };
    const house: House = {
      source: 'redfin', address: '1 Test St', price: '$285,000', beds: '3', baths: '2',
      sqft: '1,420', propertyID: 'a', url: 'https://www.redfin.com/home/a',
      latitude: 32.7, longitude: -96.8, localParams: { sliderValue: 2250 },
      comps: [comparable]
    };
    const model = buildWorkbook([house], { ...DEFAULT_GLOBAL_PARAMETERS, propertyTaxRate: 1 });
    const wb = XLSXUtils.book_new();
    append(wb, model.houses);
    append(wb, model.comps);

    const buf = xlsxWrite(wb, { type: 'buffer', bookType: 'xlsx' });
    const reread = xlsxRead(buf, { type: 'buffer', cellFormula: true });

    expect(reread.SheetNames).toEqual(['Houses', 'House Comps']);
    const houses = reread.Sheets.Houses;
    const priceColumn = model.houses.headers.indexOf('Purchase Price');
    const paymentColumn = model.houses.headers.indexOf('Monthly P&I');
    const priceCell = houses[XLSXUtils.encode_cell({ r: 1, c: priceColumn })];
    const paymentCell = houses[XLSXUtils.encode_cell({ r: 1, c: paymentColumn })];
    expect(priceCell.t).toBe('n');
    expect(priceCell.v).toBe(285000);
    expect(paymentCell.f).toContain('PMT(');

    const comps = reread.Sheets['House Comps'];
    const subjectColumn = model.comps.headers.indexOf('Subject Address');
    expect(comps[XLSXUtils.encode_cell({ r: 1, c: subjectColumn })].f).toContain('INDEX(');
  });
});
