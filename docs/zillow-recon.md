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
