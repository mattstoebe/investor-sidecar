import { describe, expect, it } from 'vitest';
import { utils as XLSXUtils, write as xlsxWrite, read as xlsxRead } from 'xlsx';
import { buildWorkbook } from '../src/export';
import { DEFAULT_GLOBAL_PARAMETERS } from '../src/App';
import type { House, GlobalParameters } from '../src/App';

const globalParams: GlobalParameters = { ...DEFAULT_GLOBAL_PARAMETERS, propertyTaxRate: 1 };

const h = (id: string, price: string, rent: number, sqft: string): House => ({
  address: `${id} Test St, Dallas, TX 75210`, price, beds: '3', baths: '2', sqft,
  propertyID: id, url: `https://www.redfin.com/home/${id}`, latitude: 32.7, longitude: -96.8,
  localParams: { sliderValue: rent }
});

describe('xlsx round trip through the real writer', () => {
  it('writes a parseable workbook whose numeric cells are numbers, not strings', () => {
    const houses = [h('a', '$285,000', 2250, '1,420'), h('b', '$675,000', 3750, 'N/A')];
    const { sheets } = buildWorkbook(houses, globalParams);
    const rows = sheets[0].rows;

    const wb = XLSXUtils.book_new();
    const ws = XLSXUtils.json_to_sheet(rows);
    XLSXUtils.book_append_sheet(wb, ws, 'Houses');

    const buf = xlsxWrite(wb, { type: 'buffer', bookType: 'xlsx' });
    expect(buf.length).toBeGreaterThan(1000);

    const reread = xlsxRead(buf, { type: 'buffer' });
    expect(reread.SheetNames).toContain('Houses');
    const back = XLSXUtils.sheet_to_json<Record<string, unknown>>(reread.Sheets['Houses']);

    expect(back).toHaveLength(3);
    expect(typeof back[0]['Purchase Price']).toBe('number');
    expect(back[0]['Purchase Price']).toBe(285000);
    expect(typeof back[0]['Monthly cash flow']).toBe('number');
    // Missing sqft became a blank cell, so the key is absent rather than the string "Error".
    expect(back[1]['Square Feet']).toBeUndefined();
    expect(String(back[2]['Address'])).toMatch(/TOTAL/);
    // Nothing anywhere in the sheet is the literal "Error" the old export produced.
    expect(JSON.stringify(back)).not.toContain('Error');
  });
});
