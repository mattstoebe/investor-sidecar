import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain JS module shipped as-is to the service worker, no types.
import { buildCompUrl } from '../public/scripts/comp-links.js';

/**
 * URL grammar verified live 2026-07-29 against zip 78745 -- see docs/comp-workflow.md's
 * recon table. These are the exact four patterns recorded there for a 3bd/2ba house.
 */

const subject = {
  address: '8109 Ferndale Dr, Austin, TX 78745',
  beds: '3',
  baths: '2'
};

describe('buildCompUrl', () => {
  it('builds the Redfin rent URL', () => {
    expect(buildCompUrl({ ...subject, source: 'redfin', kind: 'rent' })).toBe(
      'https://www.redfin.com/zipcode/78745/rentals/filter/min-beds=3,max-beds=3,min-baths=2'
    );
  });

  it('builds the Redfin sold URL', () => {
    expect(buildCompUrl({ ...subject, source: 'redfin', kind: 'sold' })).toBe(
      'https://www.redfin.com/zipcode/78745/filter/include=sold-6mo,min-beds=3,max-beds=3,min-baths=2'
    );
  });

  it('builds the Zillow rent URL', () => {
    expect(buildCompUrl({ ...subject, source: 'zillow', kind: 'rent' })).toBe(
      'https://www.zillow.com/homes/for_rent/78745_rb/3-3_beds/2-_baths/'
    );
  });

  it('builds the Zillow sold URL', () => {
    expect(buildCompUrl({ ...subject, source: 'zillow', kind: 'sold' })).toBe(
      'https://www.zillow.com/homes/recently_sold/78745_rb/3-3_beds/2-_baths/'
    );
  });

  it('builds Homes.com ZIP-scoped rent and sale searches with a bath minimum', () => {
    expect(buildCompUrl({ ...subject, source: 'homes', kind: 'rent' })).toBe(
      'https://www.homes.com/austin-tx/78745/homes-for-rent/3-bedroom/?bath=2'
    );
    expect(buildCompUrl({ ...subject, source: 'homes', kind: 'sold' })).toBe(
      'https://www.homes.com/austin-tx/78745/sold/3-bedroom/?bath=2'
    );
  });

  it('drops missing Homes.com filters and does not fall back for unknown sources', () => {
    expect(buildCompUrl({ ...subject, source: 'homes', beds: null, kind: 'sold' })).toBe(
      'https://www.homes.com/austin-tx/78745/sold/?bath=2'
    );
    expect(buildCompUrl({ ...subject, source: 'homes', baths: null, kind: 'rent' })).toBe(
      'https://www.homes.com/austin-tx/78745/homes-for-rent/3-bedroom/'
    );
    expect(buildCompUrl({ ...subject, source: 'mls', kind: 'sold' })).toBeNull();
  });

  it('floors a fractional bath count rather than guessing a segment for it', () => {
    const url = buildCompUrl({ ...subject, baths: '2.5', source: 'redfin', kind: 'sold' });
    expect(url).toContain('min-baths=2');
    expect(url).not.toContain('2.5');
  });

  it('floors fractional beds the same way', () => {
    const url = buildCompUrl({ ...subject, beds: '3.5', source: 'zillow', kind: 'rent' });
    expect(url).toContain('3-3_beds');
  });

  it('drops the beds segment rather than guessing when beds is missing', () => {
    const redfin = buildCompUrl({ ...subject, beds: null, source: 'redfin', kind: 'rent' });
    expect(redfin).toBe('https://www.redfin.com/zipcode/78745/rentals/filter/min-baths=2');

    const zillow = buildCompUrl({ ...subject, beds: null, source: 'zillow', kind: 'sold' });
    expect(zillow).toBe('https://www.zillow.com/homes/recently_sold/78745_rb/2-_baths/');
  });

  it('drops the baths segment rather than guessing when baths is missing', () => {
    const redfin = buildCompUrl({ ...subject, baths: null, source: 'redfin', kind: 'sold' });
    expect(redfin).toBe('https://www.redfin.com/zipcode/78745/filter/include=sold-6mo,min-beds=3,max-beds=3');
  });

  it('returns null when the address carries no zip', () => {
    expect(buildCompUrl({ ...subject, address: 'Somewhere with no zip', source: 'redfin', kind: 'rent' }))
      .toBeNull();
    expect(buildCompUrl({ ...subject, address: null, source: 'zillow', kind: 'sold' })).toBeNull();
  });

  it('returns null for an unknown kind', () => {
    expect(buildCompUrl({ ...subject, source: 'redfin', kind: 'lease' })).toBeNull();
  });

  it('takes the trailing zip when a street number could itself look like one', () => {
    const url = buildCompUrl({
      address: '78745 Example Blvd, Austin, TX 78652',
      beds: '3', baths: '2', source: 'redfin', kind: 'rent'
    });
    expect(url).toContain('/zipcode/78652/');
  });
});
