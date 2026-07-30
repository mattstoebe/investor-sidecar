# Zillow recon — 2026-07-25

Findings from a single live detail page (`/homedetails/<slug>/<zpid>_zpid/`) and one
results page. Recorded because Zillow's bot protection triggered a "press and hold"
challenge during this pass, so re-probing is expensive — check here before opening
Zillow again.

## Verified

**Property id.** `pathname.match(/\/(\d+)_zpid/)` works. Redfin's rule
(`/\/(\d+)\/?$/`, the trailing all-digits segment) does **not** match, because the
final segment is `<digits>_zpid`. Confirms each site needs its own id rule.

**Card containers (results page).** `article[id^="zpid_"]` — 9 present, matching the
9 `article` elements. `[data-test="property-card"]` matched **0**; that selector is
wrong for Zillow's current markup.

**Attribute convention.** `data-testid`, not `data-test`. 579 elements / 172 unique
names on the detail page; only 1 element had `data-test`.

**`__NEXT_DATA__`.** Present, ~188KB, but only `latitude`, `longitude` and `zpid`
among the fields we need. No `price`, `bedrooms`, `bathrooms`, `livingArea`,
`resoFacts`, `hoaFee`, or `address`. Useful for geo, not a general data source —
so the "parse the JSON blob instead of scraping" hope only half holds.

**`ld+json`.** 7 blobs. The one with `@type` containing `RealEstateListing` has a
real numeric `offers.price`, but — checked field by field — its `address.*` subfields,
`geo.latitude/longitude` and `floorSize.value` were all absent on this listing, and
`numberOfRooms` wasn't present at all. So the ld+json is a reliable source for
**price only**; everything else needs another source. (Redfin's ld+json is richer,
which is why the Redfin extractor leans on it.)

**DOM values that did work.**
| what | selector | observed |
|---|---|---|
| beds/baths/sqft | `[data-testid="bed-bath-sqft-facts"]` | `"3beds2baths1,400sqft"` |
| price | `[data-testid="price"]` | `"$774,950"` |

The facts string is unpunctuated and needs parsing like
`/(\d+)beds?/`, `/([\d.]+)baths?/`, `/([\d,]+)sqft/`.

**Injection target (detail page).** `[data-testid="desktop-action-bar"]` exists and
holds 5 buttons (Save / Share / etc.) — the equivalent of Redfin's
`.bp-HomeControls .bp-pill-container-variant`. Also present:
`desktop-actions-container`, `share`, `save-label`.

**Other useful testids seen:** `facts-and-features-module` and `fact-category`
(likely where HOA lives — not yet confirmed), `list-price-with-insights`,
`property-card-price`, `property-card-address-link`, `property-card-save`
(these last three are results-page card internals).

## Second pass — 2026-07-29 (results page, `/austin-tx/`)

Three page loads, local DOM reads and synthetic events only. No challenge served.

**`__NEXT_DATA__` on a *results* page is far richer than on a detail page.**
`props.pageProps.searchPageState.cat1.searchResults.listResults` held 41 records with
`zpid`, `latLong`, `unformattedPrice`, `beds`, `baths`, `area` and
`addressStreet/City/State/Zipcode`. This is a real geo source for card captures, which
currently store `latitude: null`. Sibling `mapResults` was present but **empty**.
`queryState.mapBounds` is also present but is the *requested* region, not the rendered
viewport — measured 24 px off (see [map-linking.md](./map-linking.md) §1.2).

**Map markers are DOM, and their class names are not hashed.**
`[data-test="property-marker"]` — 265 on this page — inside
`.zillow-map-layer > .BulkPropertyMapMarker`. Note `data-test`, not `data-testid`: the
opposite of the convention recorded above, and the map appears to be the exception.
Inner classes are semantic: `property-dot`, `dot-color-forsale`, `property-pill`,
`pill-color-forsale`, `is-hovered`. Markers carry **no zpid and no coordinates** — only
`class` and a `style` holding `transform` and `z-index`.

**Zillow's own card→pin hover sync can be replayed.** Dispatching `mouseover` on an
`article[id^="zpid_"]` makes Zillow add `is-hovered` to that listing's marker. This is
what makes marker identity recoverable at all; see map-linking.md §1.2.

**Marker nodes are reused across pan and zoom** — an attribute set on one survives both.

## Not yet checked

- HOA extraction (`facts-and-features-module` contents).
- Geo on the detail page: `__NEXT_DATA__` contains lat/long keys, but the exact
  path to them wasn't traced. Needed for the rent API.
- Whether any of this holds across property types (condo, new construction,
  off-market) or only this single for-sale house.
- Results-page card extraction in detail (deferred deliberately).
- Whether Zillow's `data-testid` values are stable across deploys. Their CSS class
  names are hashed and clearly are not; `data-testid` should be better, but one
  page on one day is not evidence of stability.

## Operational note

Zillow served a "press and hold" human check during this session. Keep future
probing to few page loads with long waits, local DOM reads only, and never call
Zillow's own JSON endpoints from the page.

## Addendum — 2026-07-29 (comp-workflow recon, zip 78745)

Two page loads, no bot challenge. Full findings in [comp-workflow.md](./comp-workflow.md);
the Zillow-specific facts:

- **Sold search URL**: `/homes/recently_sold/78745_rb/3-3_beds/2-_baths/` works as-is
  (title "Recently Sold Homes in 78745"). Beds segment `{n}-{n}_beds` is exact-match,
  `{n}-_baths` is min. Same `article[id^="zpid_"]` cards, same
  `property-card-address-link` / `property-card-price` testids, `/homedetails/` links.
- **Sold prices render `"$--"` in Texas** (non-disclosure state). Expect real prices in
  disclosure states; don't assume either.
- **Rental search URL**: `/homes/for_rent/78745_rb/3-3_beds/2-_baths/` works. Same card
  markup, but apartment complexes dominate and are **fake-zpid cards**: article ids like
  `zpid_30.200697--97.76973` (lat--long, not a zpid) linking to `/apartments/...`. The
  existing homedetails-link + numeric-id gates reject them correctly. Rental prices come
  as `"$1,843/moFees may apply"` and `"$2,158+Fees may apply"` (complex "from" pricing).
