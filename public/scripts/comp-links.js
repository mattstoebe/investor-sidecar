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

/** Homes.com paths need both city/state and ZIP. The city slug is still required even
 * though the search is ZIP-scoped (e.g. /chicago-il/60637/sold/). */
function homesCitySlug(address) {
  const match = String(address ?? '').match(/,\s*([^,]+),\s*([A-Z]{2})\s+\d{5}(?:-\d{4})?\s*$/i);
  if (!match) return null;
  const city = match[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const state = match[2].toLowerCase();
  return city ? `${city}-${state}` : null;
}

function buildHomesUrl(address, beds, baths, kind) {
  const city = homesCitySlug(address);
  const zip = extractZip(address);
  if (!city || !zip) return null;
  const base = kind === 'rent'
    ? `https://www.homes.com/${city}/${zip}/homes-for-rent`
    : `https://www.homes.com/${city}/${zip}/sold`;
  const path = beds ? `${base}/${beds}-bedroom/` : `${base}/`;
  return baths ? `${path}?bath=${baths}` : path;
}

/**
 * `{ source, address, beds, baths, kind }` -> a comp-search URL, or null when the
 * cannot be mapped to that site's search scope. All three require a ZIP; Homes.com also
 * needs city/state in its path. Missing beds or baths drop that filter segment rather than
 * guessing a value.
 */
export function buildCompUrl({ source, address, beds, baths, kind }) {
  if (kind !== 'rent' && kind !== 'sold') return null;
  const b = floorPositiveInt(beds);
  const ba = floorPositiveInt(baths);

  if (source === 'homes') return buildHomesUrl(address, b, ba, kind);

  const zip = extractZip(address);
  if (!zip) return null;
  if (source === 'zillow') return buildZillowUrl(zip, b, ba, kind);
  if (source === 'redfin') return buildRedfinUrl(zip, b, ba, kind);
  return null;
}
