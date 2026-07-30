/**
 * Builds the URL for a subject house's rent/sold comp search, on the same site it was
 * captured from. Pure and dependency-free -- imported only by background.js, which is
 * where the session's tab actually gets opened. See docs/comp-workflow.md §2.
 *
 * URL grammar verified live 2026-07-29 against zip 78745 (see comp-workflow.md's recon
 * table). Both sites use a min-filter for baths -- exact-bath matching would starve
 * results, and "same beds, >= baths" is how appraisers clip comps anyway.
 */

/** The zip in a full address. Takes the last match: a street number can itself be
 *  five digits, but the zip is always what a US address ends with. */
function extractZip(address) {
  const matches = String(address ?? '').match(/\b\d{5}(?:-\d{4})?\b/g);
  if (!matches || matches.length === 0) return null;
  return matches[matches.length - 1].slice(0, 5);
}

/** Whole-number beds/baths for the URL grammar, which has no fractional-beds notation
 *  and treats baths as a floored minimum. Zero and non-numeric both come back null --
 *  "drop the segment" is safer than a filter built from a number nobody entered. */
function floorPositiveInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return String(Math.floor(n));
}

function buildRedfinUrl(zip, beds, baths, kind) {
  const parts = [];
  if (kind === 'sold') parts.push('include=sold-6mo');
  if (beds) parts.push(`min-beds=${beds}`, `max-beds=${beds}`);
  if (baths) parts.push(`min-baths=${baths}`);

  const base = kind === 'rent'
    ? `https://www.redfin.com/zipcode/${zip}/rentals`
    : `https://www.redfin.com/zipcode/${zip}`;
  if (parts.length === 0) return base;
  return `${base}/filter/${parts.join(',')}`;
}

function buildZillowUrl(zip, beds, baths, kind) {
  const kindSegment = kind === 'rent' ? 'for_rent' : 'recently_sold';
  const segments = [`${zip}_rb`];
  if (beds) segments.push(`${beds}-${beds}_beds`);
  if (baths) segments.push(`${baths}-_baths`);
  return `https://www.zillow.com/homes/${kindSegment}/${segments.join('/')}/`;
}

/**
 * `{ source, address, beds, baths, kind }` -> a comp-search URL, or null when the
 * address carries no zip (there is nothing sane to build without one). Missing beds or
 * baths drop that filter segment rather than guessing a value.
 */
export function buildCompUrl({ source, address, beds, baths, kind }) {
  if (kind !== 'rent' && kind !== 'sold') return null;
  const zip = extractZip(address);
  if (!zip) return null;

  const b = floorPositiveInt(beds);
  const ba = floorPositiveInt(baths);

  if (source === 'zillow') return buildZillowUrl(zip, b, ba, kind);
  return buildRedfinUrl(zip, b, ba, kind);
}
