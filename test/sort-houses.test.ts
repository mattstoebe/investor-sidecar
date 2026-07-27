import { describe, expect, it } from 'vitest';
import { sortHouses, sortableMetrics, DEFAULT_GLOBAL_PARAMETERS } from '../src/App';
import { METRICS } from '../src/metrics';
import type { House, GlobalParameters } from '../src/App';

const globalParams: GlobalParameters = { ...DEFAULT_GLOBAL_PARAMETERS, propertyTaxRate: 1 };

const house = (id: string, overrides: Partial<House> = {}): House => ({
  address: `${id} Example St`,
  price: '$400,000',
  beds: '3',
  baths: '2',
  sqft: '1800',
  propertyID: id,
  url: `https://www.redfin.com/home/${id}`,
  latitude: 32.7,
  longitude: -97.3,
  ...overrides
});

const withRent = (id: string, rent: number, priceOverride?: string) =>
  house(id, {
    price: priceOverride ?? '$400,000',
    localParams: {
      percentDown: null, interestRate: null, price: null, additionalCashInvestment: 0,
      sliderValue: rent, propertyTaxRate: null, vacancyRate: null, maintenanceRate: null,
      capExRate: null, managementRate: null, insuranceRate: null
    }
  });

describe('sortHouses', () => {
  it('"newest" reverses insertion order without needing any analysis', () => {
    const houses = [house('a'), house('b'), house('c')];
    const sorted = sortHouses(houses, 'newest', globalParams);
    expect(sorted.map((h) => h.propertyID)).toEqual(['c', 'b', 'a']);
  });

  it('sorts by cash flow, high to low', () => {
    const houses = [withRent('low', 2200), withRent('high', 3500), withRent('mid', 2800)];
    const sorted = sortHouses(houses, 'monthlyCashFlow', globalParams);
    expect(sorted.map((h) => h.propertyID)).toEqual(['high', 'mid', 'low']);
  });

  it('sorts by cap rate, high to low, independent of financing structure', () => {
    // Cap rate is price-relative, not financing-relative -- a cheaper house with the
    // same rent should rank higher.
    const houses = [withRent('expensive', 3000, '$600,000'), withRent('cheap', 3000, '$300,000')];
    const sorted = sortHouses(houses, 'capRate', globalParams);
    expect(sorted.map((h) => h.propertyID)).toEqual(['cheap', 'expensive']);
  });

  // A saved house must never disappear from the list just because it can't be scored.
  it('houses with no computable value for the chosen metric sink to the bottom, never disappear', () => {
    const houses = [withRent('good', 3000), house('no-price', { price: 'N/A' }), house('no-rent')];
    const sorted = sortHouses(houses, 'monthlyCashFlow', globalParams);

    expect(sorted).toHaveLength(3);
    expect(sorted[0].propertyID).toBe('good');
    expect(sorted.map((h) => h.propertyID)).toContain('no-price');
    expect(sorted.map((h) => h.propertyID)).toContain('no-rent');
  });

  it('DSCR ranks by debt coverage, not by which house has the higher cap rate', () => {
    // Same rent and price for both, so cap rate is identical -- only leverage differs.
    // More down payment -> smaller loan -> smaller P&I -> higher DSCR.
    const conservative = withRent('conservative', 2600);
    conservative.localParams!.percentDown = 40;
    const leveraged = withRent('leveraged', 2600);
    leveraged.localParams!.percentDown = 5;

    const byDscr = sortHouses([conservative, leveraged], 'dscr', globalParams).map((h) => h.propertyID);
    const byCapRate = sortHouses([conservative, leveraged], 'capRate', globalParams).map((h) => h.propertyID);

    expect(byDscr).toEqual(['conservative', 'leveraged']);
    // Cap rate is financing-independent, so identical price/rent is a tie -- the sort
    // is stable, so a tie falls back to newest-first (input reversed), unlike DSCR
    // above where the two houses are genuinely distinguished.
    expect(byCapRate).toEqual(['leveraged', 'conservative']);
  });

  it('does not mutate the input array', () => {
    const houses = [house('a'), house('b')];
    const original = [...houses];
    sortHouses(houses, 'monthlyCashFlow', globalParams);
    expect(houses).toEqual(original);
  });
});

/**
 * Sorting is keyed on a metric rather than a closed list of orders, which is what lets a
 * mixed-mode board sort at all -- a flip has no cap rate, and a hardcoded case would have had
 * nothing sensible to return for one.
 */
describe('metric-keyed sorting', () => {
  it('offers only metrics the modes on the board actually compute', () => {
    const offered = sortableMetrics([withRent('a', 2500)], globalParams);
    expect(offered).toContain('monthlyCashFlow');
    expect(offered).toContain('dscr');
    // Every key offered must be renderable, which is the property that breaks first when a
    // mode is added without its metrics being registered.
    for (const key of offered) expect(METRICS[key]).toBeDefined();
  });

  it('offers nothing to rank an empty board by', () => {
    expect(sortableMetrics([], globalParams)).toEqual([]);
  });

  /**
   * A house missing a required input has not earned a ranking. It previously sorted as though
   * $0 income were an answer, which put un-underwritten houses above real ones on cash flow.
   */
  it('sinks a house that is still missing a required input', () => {
    const houses = [house('norent'), withRent('rented', 3000)];
    const sorted = sortHouses(houses, 'monthlyCashFlow', globalParams);
    expect(sorted.map((h) => h.propertyID)).toEqual(['rented', 'norent']);
  });

  it('ranks by any metric the mode offers, not just the four that used to be hardcoded', () => {
    const houses = [withRent('low', 2000), withRent('high', 4000)];
    const sorted = sortHouses(houses, 'grm', globalParams);
    // GRM is price / annual rent, so the higher rent gives the lower multiplier -- and this
    // sorts high to low like every other metric.
    expect(sorted.map((h) => h.propertyID)).toEqual(['low', 'high']);
  });
});
