import type { AnalysisGlobals, AnalysisOverrides } from '../src/analysis';

/**
 * The inputs the golden characterization test pins down. Kept beside it as data rather than
 * inline so the same matrix can be replayed through whatever the analysis entry point becomes
 * -- the point of the golden test is that the numbers survive a refactor, which means the
 * scenarios have to outlive the call signature.
 *
 * Chosen to straddle every branch in resolveParams/analyzeHouse: no rent, no loan, no cash
 * invested, the PMI threshold on both sides, the maxDown clamp, rent-scaled expenses on and
 * off, and the two failure paths.
 */
export interface GoldenScenario {
  name: string;
  price: string | number | null;
  hoa: number | null;
  overrides: AnalysisOverrides;
  globals: Partial<AnalysisGlobals>;
}

export const SCENARIOS: GoldenScenario[] = [
  {
    name: 'baseline rental, 20% down, all rent-scaled rates zero',
    price: '$425,000',
    hoa: 0,
    overrides: { monthlyRent: 2800 },
    globals: { propertyTaxRate: 1.2 }
  },
  {
    name: 'every rent-scaled rate engaged, with HOA',
    price: '$425,000',
    hoa: 250,
    overrides: { monthlyRent: 2800 },
    globals: {
      propertyTaxRate: 1.2, vacancyRate: 6, maintenanceRate: 8,
      capExRate: 5, managementRate: 10, insuranceRate: 0.5
    }
  },
  {
    name: 'no rent entered -- returns computed against zero income',
    price: '$425,000',
    hoa: 0,
    overrides: {},
    globals: { propertyTaxRate: 1.2 }
  },
  {
    name: 'under 20% down, so PMI applies',
    price: '$425,000',
    hoa: 0,
    overrides: { monthlyRent: 2800, percentDown: 5 },
    globals: { propertyTaxRate: 1.2, pmiRate: 0.5 }
  },
  {
    name: 'exactly 20% down -- the PMI boundary, excluded',
    price: '$425,000',
    hoa: 0,
    overrides: { monthlyRent: 2800, percentDown: 20 },
    globals: { propertyTaxRate: 1.2, pmiRate: 0.5 }
  },
  {
    name: 'all cash, no loan, so no DSCR',
    price: '$425,000',
    hoa: 0,
    overrides: { monthlyRent: 2800, percentDown: 100 },
    globals: { propertyTaxRate: 1.2 }
  },
  {
    name: 'maxDown clamps a 50% request to a 10% loan, and PMI keys off the clamped figure',
    price: '$425,000',
    hoa: 0,
    overrides: { monthlyRent: 2800, percentDown: 50 },
    globals: { propertyTaxRate: 1.2, maxDown: 42500, pmiRate: 0.5 }
  },
  {
    name: 'zero down and zero closing costs -- nothing invested, so no cash-on-cash',
    price: '$425,000',
    hoa: 0,
    overrides: { monthlyRent: 2800, percentDown: 0 },
    globals: { propertyTaxRate: 1.2, closingCostRate: 0, pmiRate: 0 }
  },
  {
    name: 'rent below break-even -- negative cash flow',
    price: '$425,000',
    hoa: 400,
    overrides: { monthlyRent: 900 },
    globals: { propertyTaxRate: 2.5, insuranceRate: 1, vacancyRate: 10 }
  },
  {
    name: 'per-house overrides beat every global',
    price: '$425,000',
    hoa: 100,
    overrides: {
      monthlyRent: 3300, price: 380000, percentDown: 35, interestRate: 5.25,
      propertyTaxRate: 0.9, vacancyRate: 3, maintenanceRate: 4, capExRate: 3,
      managementRate: 6, insuranceRate: 0.28, additionalCashInvestment: 15000
    },
    globals: {
      propertyTaxRate: 2.4, vacancyRate: 12, maintenanceRate: 15, capExRate: 12,
      managementRate: 12, insuranceRate: 1.1
    }
  },
  {
    name: 'zero interest -- the amortization special case',
    price: '$300,000',
    hoa: 0,
    overrides: { monthlyRent: 2200, interestRate: 0 },
    globals: { propertyTaxRate: 1 }
  },
  {
    name: 'management at 100% of collected rent -- break-even occupancy degenerates',
    price: '$425,000',
    hoa: 0,
    overrides: { monthlyRent: 2800, managementRate: 100 },
    globals: { propertyTaxRate: 1.2 }
  },
  {
    name: 'rent-scaled expenses exceed rent, so no rent breaks even',
    price: '$425,000',
    hoa: 0,
    overrides: { monthlyRent: 2800, vacancyRate: 50, maintenanceRate: 40, capExRate: 40 },
    globals: { propertyTaxRate: 1.2 }
  },
  {
    name: 'abbreviated listing price parses to millions',
    price: '$1.2M',
    hoa: 0,
    overrides: { monthlyRent: 6500 },
    globals: { propertyTaxRate: 1.8 }
  },
  {
    name: 'unreadable price is a reason, not an exception',
    price: 'Contact agent',
    hoa: 0,
    overrides: { monthlyRent: 2800 },
    globals: {}
  },
  {
    name: 'a zero price is rejected',
    price: 0,
    hoa: 0,
    overrides: { monthlyRent: 2800 },
    globals: {}
  },
  {
    name: 'a negative rate is rejected by name',
    price: '$425,000',
    hoa: 0,
    overrides: { monthlyRent: 2800, vacancyRate: -5 },
    globals: {}
  }
];
