import { parseMoney } from './analysis';
import { resolveMode } from './modes';
import type { House, GlobalParameters, Comp } from './App';

export interface FormulaCell {
  formula: string;
  resultType?: 'number' | 'string';
  numberFormat?: string;
}

export type WorkbookCell = string | number | null | FormulaCell;

export interface ExportSheet {
  name: 'Houses' | 'House Comps';
  headers: string[];
  rows: WorkbookCell[][];
  widths: number[];
}

export interface Workbook {
  houses: ExportSheet;
  comps: ExportSheet;
}

const formula = (
  value: string,
  numberFormat?: string,
  resultType: 'number' | 'string' = 'number'
): FormulaCell => ({ formula: value, numberFormat, resultType });

const numberFromText = (value: string | number | null | undefined): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = String(value ?? '').replace(/,/g, '').trim();
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
};

const columnName = (index: number): string => {
  let value = index + 1;
  let out = '';
  while (value > 0) {
    value -= 1;
    out = String.fromCharCode(65 + (value % 26)) + out;
    value = Math.floor(value / 26);
  }
  return out;
};

const H = [
  'House Key', 'Address', 'Source', 'Property URL', 'Strategy', 'Enriched At',
  'Listing Status', 'Property Type', 'Year Built', 'Beds', 'Baths', 'Square Feet',
  'Lot Size Sq Ft', 'HOA Monthly', 'Tax Year', 'Reported Annual Tax',
  'Tax Assessed Value', 'Estimated Monthly Tax', 'Tax Source', 'Tax History',
  'MLS ID', 'Brokerage', 'Latitude', 'Longitude', 'Description', 'Other Listing Facts',
  'Purchase Price', 'Monthly Rent', 'Down Payment %', 'Max Down', 'Interest Rate %',
  'Tax Rate Override %', 'Global Tax Rate %', 'Vacancy %', 'Maintenance %', 'CapEx %',
  'Management %', 'Insurance %', 'Closing Costs %', 'PMI %', 'Additional Cash',
  'ARV', 'Rehab Budget', 'Hold Months', 'Selling Costs %', 'MAO Rule %',
  'Refi LTV %', 'Refi Rate %', 'Refi Costs %', 'Seasoning Months',
  'Effective Annual Tax', 'Down Payment', 'Loan Amount', 'Monthly P&I', 'Monthly PMI',
  'Effective Monthly Rent', 'Monthly Operating Expenses', 'Monthly NOI',
  'Monthly Cash Flow', 'Annual NOI', 'Cap Rate %', 'DSCR', 'Cash Invested',
  'Cash-on-Cash %', 'Sale Comp Count', 'Average Sale Comp', 'Rent Comp Count',
  'Average Rent Comp', 'Flip MAO', 'Flip Monthly Hold Cost', 'Flip Net Profit',
  'Flip Cash Invested', 'Flip ROI %', 'BRRRR New Loan', 'Original Loan Payoff',
  'Refi Costs', 'BRRRR Phase A Cash', 'Cash Left In Deal', 'Post-Refi Payment',
  'Post-Refi Monthly NOI', 'Post-Refi Cash Flow', 'Post-Refi CoC %',
  'Primary Metric', 'Primary Metric Value'
] as const;

const C = [
  'Subject House Key', 'Subject Address', 'Subject Strategy', 'Comp Type',
  'Comp Listing Status', 'Comp Source', 'Comp Property ID', 'Comp Address',
  'Comp Amount', 'Amount Label', 'Beds', 'Baths', 'Square Feet', 'Sold Date',
  'Captured At', 'Comp URL', 'Subject Price', 'Subject Rent', 'Comp $/Sq Ft',
  'Subject $/Sq Ft', 'Amount Delta', 'Amount Delta %', 'Sq Ft Delta',
  'Beds Delta', 'Baths Delta'
] as const;

const hIndex = new Map<string, number>(H.map((header, index) => [header, index]));
const cIndex = new Map<string, number>(C.map((header, index) => [header, index]));
const hRef = (header: typeof H[number], row: number) => `${columnName(hIndex.get(header)!)}${row}`;
const cRef = (header: typeof C[number], row: number) => `${columnName(cIndex.get(header)!)}${row}`;
const hRange = (header: typeof H[number]) => `'Houses'!$${columnName(hIndex.get(header)!)}$2:$${columnName(hIndex.get(header)!)}$1001`;
const cRange = (header: typeof C[number]) => `'House Comps'!$${columnName(cIndex.get(header)!)}$2:$${columnName(cIndex.get(header)!)}$5001`;

const houseKey = (house: House) => `${house.source ?? 'redfin'}:${house.propertyID}`;
const localOrGlobal = (
  house: House,
  globals: GlobalParameters,
  localKey: keyof NonNullable<House['localParams']>,
  globalKey: keyof GlobalParameters
) => {
  const local = house.localParams?.[localKey];
  return typeof local === 'number' ? local : Number(globals[globalKey] ?? 0);
};

function houseFormulaRow(row: number): FormulaCell[] {
  const r = (header: typeof H[number]) => hRef(header, row);
  const key = r('House Key');
  const price = r('Purchase Price');
  const rent = r('Monthly Rent');
  const downRate = r('Down Payment %');
  const maxDown = r('Max Down');
  const interest = r('Interest Rate %');
  const taxOverride = r('Tax Rate Override %');
  const globalTax = r('Global Tax Rate %');
  const pageTax = r('Reported Annual Tax');
  const vacancy = r('Vacancy %');
  const maintenance = r('Maintenance %');
  const capex = r('CapEx %');
  const management = r('Management %');
  const insurance = r('Insurance %');
  const closing = r('Closing Costs %');
  const pmiRate = r('PMI %');
  const hoa = r('HOA Monthly');
  const additional = r('Additional Cash');
  const arv = r('ARV');
  const rehab = r('Rehab Budget');
  const hold = r('Hold Months');
  const saleCosts = r('Selling Costs %');
  const maoRate = r('MAO Rule %');
  const refiLtv = r('Refi LTV %');
  const refiRate = r('Refi Rate %');
  const refiCostRate = r('Refi Costs %');
  const seasoning = r('Seasoning Months');
  const annualTax = r('Effective Annual Tax');
  const down = r('Down Payment');
  const loan = r('Loan Amount');
  const payment = r('Monthly P&I');
  const monthlyPmi = r('Monthly PMI');
  const effectiveRent = r('Effective Monthly Rent');
  const operating = r('Monthly Operating Expenses');
  const noi = r('Monthly NOI');
  const cashFlow = r('Monthly Cash Flow');
  const annualNoi = r('Annual NOI');
  const cashInvested = r('Cash Invested');
  const flipHold = r('Flip Monthly Hold Cost');
  const flipProfit = r('Flip Net Profit');
  const flipCash = r('Flip Cash Invested');
  const newLoan = r('BRRRR New Loan');
  const payoff = r('Original Loan Payoff');
  const refiCosts = r('Refi Costs');
  const phaseA = r('BRRRR Phase A Cash');
  const cashLeft = r('Cash Left In Deal');
  const postPayment = r('Post-Refi Payment');
  const postNoi = r('Post-Refi Monthly NOI');
  const postCashFlow = r('Post-Refi Cash Flow');
  const strategy = r('Strategy');

  return [
    formula(`=IF(${taxOverride}<>"",${price}*${taxOverride}/100,IF(${pageTax}<>"",${pageTax},${price}*${globalTax}/100))`, '$#,##0'),
    formula(`=MIN(${price}*${downRate}/100,IF(${maxDown}="",${price},${maxDown}),${price})`, '$#,##0'),
    formula(`=MAX(${price}-${down},0)`, '$#,##0'),
    formula(`=IF(${loan}=0,0,IF(${interest}=0,${loan}/360,-PMT(${interest}/1200,360,${loan})))`, '$#,##0.00'),
    formula(`=IFERROR(IF(${down}/${price}<20%,${loan}*${pmiRate}/1200,0),0)`, '$#,##0.00'),
    formula(`=${rent}*(1-${vacancy}/100)`, '$#,##0.00'),
    formula(`=${annualTax}/12+${price}*${insurance}/1200+${hoa}+${rent}*${maintenance}/100+${rent}*${capex}/100+${effectiveRent}*${management}/100`, '$#,##0.00'),
    formula(`=${effectiveRent}-${operating}`, '$#,##0.00'),
    formula(`=${noi}-${payment}-${monthlyPmi}`, '$#,##0.00'),
    formula(`=${noi}*12`, '$#,##0'),
    formula(`=IFERROR(${annualNoi}/${price},"")`, '0.00%'),
    formula(`=IF(${payment}>0,${annualNoi}/(${payment}*12),"")`, '0.00x'),
    formula(`=${down}+${price}*${closing}/100+${additional}`, '$#,##0'),
    formula(`=IF(${cashInvested}>0,${cashFlow}*12/${cashInvested},"")`, '0.00%'),
    formula(`=COUNTIFS(${cRange('Subject House Key')},${key},${cRange('Comp Type')},"Sale")`, '0'),
    formula(`=IFERROR(AVERAGEIFS(${cRange('Comp Amount')},${cRange('Subject House Key')},${key},${cRange('Comp Type')},"Sale"),"")`, '$#,##0'),
    formula(`=COUNTIFS(${cRange('Subject House Key')},${key},${cRange('Comp Type')},"Rent")`, '0'),
    formula(`=IFERROR(AVERAGEIFS(${cRange('Comp Amount')},${cRange('Subject House Key')},${key},${cRange('Comp Type')},"Rent"),"")`, '$#,##0'),
    formula(`=IF(${arv}="","",${arv}*${maoRate}/100-${rehab})`, '$#,##0'),
    formula(`=${loan}*${interest}/1200+${annualTax}/12+${price}*${insurance}/1200+${hoa}`, '$#,##0.00'),
    formula(`=IF(${arv}="","",${arv}-(${price}+${rehab}+${price}*${closing}/100+${flipHold}*${hold}+${arv}*${saleCosts}/100))`, '$#,##0'),
    formula(`=${down}+${rehab}+${price}*${closing}/100+${flipHold}*${hold}+${additional}`, '$#,##0'),
    formula(`=IFERROR(${flipProfit}/${flipCash},"")`, '0.00%'),
    formula(`=IF(${arv}="","",${arv}*${refiLtv}/100)`, '$#,##0'),
    formula(`=IF(${loan}=0,0,IF(${interest}=0,MAX(${loan}-${loan}/360*(${hold}+${seasoning}),0),-FV(${interest}/1200,${hold}+${seasoning},${payment},-${loan})))`, '$#,##0'),
    formula(`=${newLoan}*${refiCostRate}/100`, '$#,##0'),
    formula(`=${down}+${rehab}+${price}*${closing}/100+${flipHold}*${hold}+${additional}`, '$#,##0'),
    formula(`=${phaseA}-(${newLoan}-${payoff}-${refiCosts})`, '$#,##0'),
    formula(`=IF(${newLoan}=0,0,IF(${refiRate}=0,${newLoan}/360,-PMT(${refiRate}/1200,360,${newLoan})))`, '$#,##0.00'),
    formula(`=${effectiveRent}-(${annualTax}/12+IF(${arv}="",${price},${arv})*${insurance}/1200+${hoa}+${rent}*${maintenance}/100+${rent}*${capex}/100+${effectiveRent}*${management}/100)`, '$#,##0.00'),
    formula(`=${postNoi}-${postPayment}`, '$#,##0.00'),
    formula(`=IF(${cashLeft}>0,${postCashFlow}*12/${cashLeft},"")`, '0.00%'),
    formula(`=IF(${strategy}="Buy and hold","Monthly cash flow",IF(${strategy}="Fix and flip","Flip net profit","Cash left in deal"))`, undefined, 'string'),
    formula(`=IF(${strategy}="Buy and hold",${cashFlow},IF(${strategy}="Fix and flip",${flipProfit},${cashLeft}))`, '$#,##0')
  ];
}

function houseRow(house: House, globals: GlobalParameters, row: number): WorkbookCell[] {
  const details = house.details;
  const tax = details?.tax;
  const mode = resolveMode(house.localParams?.mode ?? null, globals.mode).value;
  const strategy = mode === 'rental' ? 'Buy and hold' : mode === 'flip' ? 'Fix and flip' : 'BRRRR';
  const local = house.localParams;
  const facts = (details?.extraFacts ?? []).map((fact) => `${fact.label}: ${fact.value}`).join(' | ');
  const history = (tax?.history ?? []).map((entry) =>
    `${entry.year}: tax ${entry.annualAmount ?? '—'}, assessment ${entry.assessedValue ?? '—'}`
  ).join(' | ');
  const base: WorkbookCell[] = [
    houseKey(house), house.address || '', house.source ?? 'redfin', house.url || '', strategy,
    details?.enrichedAt ? new Date(details.enrichedAt).toISOString() : '',
    details?.listingStatus ?? '', details?.propertyType ?? '', details?.yearBuilt ?? null,
    numberFromText(house.beds), numberFromText(house.baths), numberFromText(house.sqft),
    details?.lotSizeSqft ?? null, house.hoa ?? 0, tax?.year ?? null,
    tax?.annualAmount ?? null, tax?.assessedValue ?? null, tax?.estimatedMonthlyAmount ?? null,
    tax?.sourceLabel ?? '', history, details?.mlsId ?? '', details?.brokerage ?? '',
    house.latitude, house.longitude, details?.description ?? '', facts,
    local?.price ?? parseMoney(house.price), local?.sliderValue ?? 0,
    localOrGlobal(house, globals, 'percentDown', 'percentDown'), globals.maxDown,
    localOrGlobal(house, globals, 'interestRate', 'interestRate'), local?.propertyTaxRate ?? null,
    globals.propertyTaxRate ?? 0, localOrGlobal(house, globals, 'vacancyRate', 'vacancyRate'),
    localOrGlobal(house, globals, 'maintenanceRate', 'maintenanceRate'),
    localOrGlobal(house, globals, 'capExRate', 'capExRate'),
    localOrGlobal(house, globals, 'managementRate', 'managementRate'),
    localOrGlobal(house, globals, 'insuranceRate', 'insuranceRate'),
    localOrGlobal(house, globals, 'closingCostRate', 'closingCostRate'),
    localOrGlobal(house, globals, 'pmiRate', 'pmiRate'), local?.additionalCashInvestment ?? 0,
    local?.arv ?? null, local?.rehabBudget ?? 0,
    localOrGlobal(house, globals, 'holdMonths', 'holdMonths'),
    localOrGlobal(house, globals, 'sellingCostRate', 'sellingCostRate'),
    localOrGlobal(house, globals, 'maoRulePercent', 'maoRulePercent'),
    localOrGlobal(house, globals, 'refiLtv', 'refiLtv'),
    localOrGlobal(house, globals, 'refiRate', 'refiRate'),
    localOrGlobal(house, globals, 'refiCostRate', 'refiCostRate'),
    localOrGlobal(house, globals, 'seasoningMonths', 'seasoningMonths')
  ];
  return [...base, ...houseFormulaRow(row)];
}

function compRow(house: House, comp: Comp, row: number): WorkbookCell[] {
  const subjectKey = houseKey(house);
  const keyRef = cRef('Subject House Key', row);
  const typeRef = cRef('Comp Type', row);
  const amountRef = cRef('Comp Amount', row);
  const sqftRef = cRef('Square Feet', row);
  const subjectPriceRef = cRef('Subject Price', row);
  const subjectRentRef = cRef('Subject Rent', row);
  const subjectLookup = (
    header: typeof H[number],
    format?: string,
    resultType: 'number' | 'string' = 'number'
  ) => formula(
    `=IFERROR(INDEX(${hRange(header)},MATCH(${keyRef},${hRange('House Key')},0)),"")`,
    format,
    resultType
  );
  const subjectSqft = `IFERROR(INDEX(${hRange('Square Feet')},MATCH(${keyRef},${hRange('House Key')},0)),"")`;
  const subjectBeds = `IFERROR(INDEX(${hRange('Beds')},MATCH(${keyRef},${hRange('House Key')},0)),"")`;
  const subjectBaths = `IFERROR(INDEX(${hRange('Baths')},MATCH(${keyRef},${hRange('House Key')},0)),"")`;

  return [
    subjectKey,
    subjectLookup('Address', undefined, 'string'),
    subjectLookup('Strategy', undefined, 'string'),
    comp.kind === 'rent' ? 'Rent' : 'Sale',
    comp.listingStatus ?? (comp.kind === 'sold' ? 'Sold' : 'Rental'),
    comp.source, comp.propertyID, comp.address, comp.amount, comp.amountLabel,
    numberFromText(comp.beds), numberFromText(comp.baths), numberFromText(comp.sqft),
    comp.soldDate ?? '', new Date(comp.capturedAt).toISOString(), comp.url,
    subjectLookup('Purchase Price', '$#,##0'),
    subjectLookup('Monthly Rent', '$#,##0'),
    formula(`=IFERROR(${amountRef}/${sqftRef},"")`, '$0.00'),
    formula(`=IFERROR(${subjectPriceRef}/${subjectSqft},"")`, '$0.00'),
    formula(`=IF(${typeRef}="Rent",${amountRef}-${subjectRentRef},${amountRef}-${subjectPriceRef})`, '$#,##0'),
    formula(`=IFERROR(IF(${typeRef}="Rent",${amountRef}/${subjectRentRef}-1,${amountRef}/${subjectPriceRef}-1),"")`, '0.0%'),
    formula(`=IFERROR(${sqftRef}-${subjectSqft},"")`, '#,##0'),
    formula(`=IFERROR(${cRef('Beds', row)}-${subjectBeds},"")`, '0.0'),
    formula(`=IFERROR(${cRef('Baths', row)}-${subjectBaths},"")`, '0.0')
  ];
}

const widthsFor = (headers: readonly string[]) => headers.map((header) => {
  if (/URL|Description|Other Listing Facts|Tax History/i.test(header)) return 34;
  if (/Address|Property Type|Primary Metric|Tax Source/i.test(header)) return 24;
  return Math.max(12, Math.min(20, header.length + 2));
});

export function buildWorkbook(houses: House[], globals: GlobalParameters): Workbook {
  const houseRows = houses.map((house, index) => houseRow(house, globals, index + 2));
  const compRows: WorkbookCell[][] = [];
  for (const house of houses) {
    for (const comp of house.comps ?? []) {
      compRows.push(compRow(house, comp, compRows.length + 2));
    }
  }

  return {
    houses: { name: 'Houses', headers: [...H], rows: houseRows, widths: widthsFor(H) },
    comps: { name: 'House Comps', headers: [...C], rows: compRows, widths: widthsFor(C) }
  };
}
