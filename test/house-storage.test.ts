import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain JS module shipped as-is to the service worker, no types.
import { houseKey, mergeEnrichmentIntoLatest, applyLocalParams, stampRevision } from '../public/scripts/house-storage.js';

/**
 * These cover the write path that protects panel edits from asynchronous API
 * enrichment. enrichAndPersistHouse reads storage, fires tax/rent requests that can
 * take seconds, then writes. If it wrote back the snapshot it started with, anything
 * the user typed in the side panel meanwhile would be silently reverted.
 */

const house = (over: Record<string, unknown> = {}) => ({
  source: 'redfin',
  propertyID: '30926649',
  address: '123 Main St, Dallas, TX 75201',
  price: '$425,000',
  ...over
});

const enrichment = (over: Record<string, unknown> = {}) => ({
  apiTaxRate: 1.81,
  taxError: null,
  rentEstimate: { min: 1800, iqrlow: 2050, mid: 2250, iqrhigh: 2450, max: 2700 },
  rentError: null,
  ...over
});

describe('houseKey', () => {
  it('namespaces by source so a zpid cannot collide with a Redfin id', () => {
    expect(houseKey({ source: 'redfin', propertyID: '48703301' })).toBe('redfin:48703301');
    expect(houseKey({ source: 'zillow', propertyID: '48703301' })).toBe('zillow:48703301');
    expect(houseKey({ source: 'redfin', propertyID: '48703301' }))
      .not.toBe(houseKey({ source: 'zillow', propertyID: '48703301' }));
  });

  // Records saved before multi-site support have no source and were all Redfin.
  it('defaults a missing source to redfin so existing storage keeps working', () => {
    expect(houseKey({ propertyID: '30926649' })).toBe('redfin:30926649');
  });
});

describe('mergeEnrichmentIntoLatest', () => {
  it('applies the API fields to the matching house', () => {
    const houses = [house()];
    const result = mergeEnrichmentIntoLatest(houses, 'redfin:30926649', enrichment())!;

    expect(result.updatedHouse.apiTaxRate).toBe(1.81);
    expect(result.updatedHouse.rentEstimate.mid).toBe(2250);
    expect(result.updatedHouse.rentError).toBeNull();
  });

  /**
   * The point of the whole function: enrichment must not carry a stale copy of the
   * house back over what the user has since typed.
   */
  it('preserves local parameters the user changed while the request was in flight', () => {
    // Storage as it looks *now* -- the user has entered rent and a rate override.
    const current = [house({
      localParams: {
        percentDown: 25, interestRate: 6.5, price: 400000,
        sliderValue: 2800, additionalCashInvestment: 5000,
        propertyTaxRate: null, vacancyRate: 8, maintenanceRate: null,
        capExRate: null, managementRate: null, insuranceRate: null
      }
    })];

    const result = mergeEnrichmentIntoLatest(current, 'redfin:30926649', enrichment())!;
    const lp = result.updatedHouse.localParams;

    expect(lp.sliderValue).toBe(2800);
    expect(lp.percentDown).toBe(25);
    expect(lp.interestRate).toBe(6.5);
    expect(lp.price).toBe(400000);
    expect(lp.additionalCashInvestment).toBe(5000);
    expect(lp.vacancyRate).toBe(8);
  });

  it('seeds the tax rate from the API only when the user has not set one', () => {
    const houses = [house({
      localParams: { propertyTaxRate: null, sliderValue: 0, percentDown: null, interestRate: null, price: null, additionalCashInvestment: 0, vacancyRate: null, maintenanceRate: null, capExRate: null, managementRate: null, insuranceRate: null }
    })];
    const result = mergeEnrichmentIntoLatest(houses, 'redfin:30926649', enrichment())!;
    expect(result.updatedHouse.localParams.propertyTaxRate).toBe(1.81);
  });

  it('never overwrites a tax rate the user entered themselves', () => {
    const houses = [house({
      localParams: { propertyTaxRate: 2.4, sliderValue: 0, percentDown: null, interestRate: null, price: null, additionalCashInvestment: 0, vacancyRate: null, maintenanceRate: null, capExRate: null, managementRate: null, insuranceRate: null }
    })];
    const result = mergeEnrichmentIntoLatest(houses, 'redfin:30926649', enrichment())!;
    expect(result.updatedHouse.localParams.propertyTaxRate).toBe(2.4);
  });

  it('does not seed a tax rate when the lookup failed', () => {
    const houses = [house()];
    const result = mergeEnrichmentIntoLatest(
      houses, 'redfin:30926649',
      enrichment({ apiTaxRate: null, taxError: 'Missing zip code' })
    )!;
    expect(result.updatedHouse.localParams.propertyTaxRate).toBeUndefined();
    expect(result.updatedHouse.taxError).toBe('Missing zip code');
  });

  // The user can delete a house while its enrichment request is still running.
  it('returns null when the house is gone, rather than resurrecting it', () => {
    expect(mergeEnrichmentIntoLatest([], 'redfin:30926649', enrichment())).toBeNull();
    expect(mergeEnrichmentIntoLatest([house({ propertyID: '999' })], 'redfin:30926649', enrichment())).toBeNull();
  });

  it('matches on the namespaced key, so a same-numbered Zillow house is untouched', () => {
    const houses = [
      house({ source: 'zillow', propertyID: '30926649', address: 'Zillow house' }),
      house({ source: 'redfin', propertyID: '30926649', address: 'Redfin house' })
    ];
    const result = mergeEnrichmentIntoLatest(houses, 'zillow:30926649', enrichment())!;

    expect(result.updatedHouse.address).toBe('Zillow house');
    // The Redfin record with the same number must be left exactly as it was.
    expect(result.updatedHouses[1].apiTaxRate).toBeUndefined();
  });

  it('does not mutate the array or house it was given', () => {
    const original = house({ localParams: { sliderValue: 2800, propertyTaxRate: null } });
    const houses = [original];
    const snapshot = JSON.stringify(houses);

    mergeEnrichmentIntoLatest(houses, 'redfin:30926649', enrichment());

    expect(JSON.stringify(houses)).toBe(snapshot);
  });

  it('leaves other houses in the list alone', () => {
    const houses = [
      house({ propertyID: '111', address: 'First' }),
      house({ propertyID: '30926649' }),
      house({ propertyID: '222', address: 'Third' })
    ];
    const result = mergeEnrichmentIntoLatest(houses, 'redfin:30926649', enrichment())!;

    expect(result.updatedHouses).toHaveLength(3);
    expect(result.updatedHouses[0].address).toBe('First');
    expect(result.updatedHouses[2].address).toBe('Third');
    expect(result.updatedHouses[1].apiTaxRate).toBe(1.81);
  });
});

/**
 * The worker-side merge behind updateLocalParams. The panel now sends only the fields a card
 * owns and this applies them, so anything else already stored -- a per-house mode override,
 * a tax rate seeded by enrichment -- has to survive a save that predates it.
 */
describe('applyLocalParams', () => {
  it('applies the sent fields to the matching house', () => {
    const houses = [house({ localParams: { sliderValue: 2000 } })];
    const result = applyLocalParams(houses, 'redfin:30926649', { sliderValue: 3100 });

    expect(result).not.toBeNull();
    expect(result.updatedHouse.localParams.sliderValue).toBe(3100);
  });

  it('preserves stored fields the caller did not send', () => {
    const houses = [house({ localParams: { mode: 'rental', propertyTaxRate: 1.8, sliderValue: 2000 } })];
    const result = applyLocalParams(houses, 'redfin:30926649', { sliderValue: 3100 });

    expect(result.updatedHouse.localParams.mode).toBe('rental');
    expect(result.updatedHouse.localParams.propertyTaxRate).toBe(1.8);
  });

  it('lets an explicit null clear a value, distinct from omitting the key', () => {
    const houses = [house({ localParams: { vacancyRate: 8, mode: 'rental' } })];
    const result = applyLocalParams(houses, 'redfin:30926649', { vacancyRate: null });

    expect(result.updatedHouse.localParams.vacancyRate).toBeNull();
    expect(result.updatedHouse.localParams.mode).toBe('rental');
  });

  it('handles a house that has no localParams yet', () => {
    const result = applyLocalParams([house()], 'redfin:30926649', { sliderValue: 1500 });
    expect(result.updatedHouse.localParams.sliderValue).toBe(1500);
  });

  // Re-adding it from an in-flight edit would resurrect a record the user deleted.
  it('returns null when the house was removed mid-edit', () => {
    expect(applyLocalParams([house()], 'redfin:99999', { sliderValue: 1 })).toBeNull();
    expect(applyLocalParams([], 'redfin:30926649', { sliderValue: 1 })).toBeNull();
  });

  it('leaves other houses untouched and does not mutate the input', () => {
    const other = house({ propertyID: '111', localParams: { sliderValue: 777 } });
    const houses = [house({ localParams: { sliderValue: 2000 } }), other];
    const snapshot = JSON.stringify(houses);

    const result = applyLocalParams(houses, 'redfin:30926649', { sliderValue: 3100 });

    expect(result.updatedHouses[1].localParams.sliderValue).toBe(777);
    expect(JSON.stringify(houses)).toBe(snapshot);
    expect(result.updatedHouses).not.toBe(houses);
  });

  it('namespaces by source, so a zpid cannot match a Redfin id', () => {
    const houses = [house({ source: 'zillow', propertyID: '30926649', localParams: { sliderValue: 1 } })];
    expect(applyLocalParams(houses, 'redfin:30926649', { sliderValue: 9 })).toBeNull();
    expect(applyLocalParams(houses, 'zillow:30926649', { sliderValue: 9 })).not.toBeNull();
  });

  it('tolerates a missing update object rather than throwing', () => {
    const result = applyLocalParams([house({ localParams: { sliderValue: 5 } })], 'redfin:30926649', null);
    expect(result.updatedHouse.localParams.sliderValue).toBe(5);
  });

  /**
   * The panel holds edits in component state, so it cannot simply re-read every broadcast --
   * it has to know which writes were its own. These two fields are how.
   */
  it('bumps the revision and records who wrote it', () => {
    const houses = [house({ rev: 4, localParams: { sliderValue: 2000 } })];
    const result = applyLocalParams(houses, 'redfin:30926649', { sliderValue: 3100 }, 'card-7');

    expect(result.updatedHouse.rev).toBe(5);
    expect(result.updatedHouse.lastWriter).toBe('card-7');
  });

  it('starts a record that predates revisions at 1', () => {
    const result = applyLocalParams([house()], 'redfin:30926649', { sliderValue: 1 }, 'card-0');
    expect(result.updatedHouse.rev).toBe(1);
  });

  it('records an unattributed write rather than leaving the field undefined', () => {
    const result = applyLocalParams([house({ rev: 2 })], 'redfin:30926649', { sliderValue: 1 });
    expect(result.updatedHouse.rev).toBe(3);
    expect(result.updatedHouse.lastWriter).toBeNull();
  });
});

describe('stampRevision', () => {
  it('increments from whatever the house carried', () => {
    expect(stampRevision({ rev: 9 }, 'w').rev).toBe(10);
  });

  it('treats a missing revision as zero', () => {
    expect(stampRevision({}, 'w').rev).toBe(1);
  });

  it('does not mutate its input', () => {
    const original = { rev: 1, address: 'x' };
    const stamped = stampRevision(original, 'w');
    expect(original.rev).toBe(1);
    expect(stamped).not.toBe(original);
    expect(stamped.address).toBe('x');
  });
});

/**
 * Enrichment is a foreign write by definition -- it originates in the worker, not in any
 * card -- so it must be attributed to something no card will recognise as itself, or the
 * card that happens to be mounted would skip it as its own echo.
 */
describe('enrichment revisions', () => {
  it('stamps a merge as a foreign write so a mounted card adopts it', () => {
    const result = mergeEnrichmentIntoLatest([house({ rev: 3 })], 'redfin:30926649', enrichment());
    expect(result.updatedHouse.rev).toBe(4);
    expect(result.updatedHouse.lastWriter).toBe('enrichment');
  });
});
