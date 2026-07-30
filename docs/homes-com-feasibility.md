# Homes.com support — feasibility report and plan (2026-07-29)

**Verdict: feasible, and the easiest of the three sites to support.** Homes.com is
server-rendered, exposes semantic class names and an unusually complete `ld+json` blob, and
needs no new panel, calculation or storage work. All existing Redfin and Zillow behaviour is
preserved — the one cross-cutting change is additive and defaults to today's behaviour.

Estimated effort: **1–2 days**, most of it tests and store resubmission rather than adapter
code. One prototype adapter has already been validated live (§5).

Unlike [zillow-recon.md](./zillow-recon.md), which was one page on one day, the findings here
come from **4 markets, 4 property types, 160 result cards and 12 detail pages**, plus live
injection and click tests on both surfaces. Everything below was measured, not inferred.

---

## 1. What Homes.com looks like

| | Redfin | Zillow | **Homes.com** |
| --- | --- | --- | --- |
| Framework | — | Next.js (React) | **Vue, server-rendered** |
| Class names | stable (`bp-*`) | hashed, unusable | **stable and semantic** |
| Attribute convention | `data-rf-test-id` | `data-testid` | **semantic `data-*` (`data-pk`)** |
| Property id | trailing digits | `<digits>_zpid` | **alphanumeric key** |
| Structured data | rich `ld+json` | price only | **price, beds, sqft, address, geo** |
| Embedded JSON blob | — | `__NEXT_DATA__` | none needed |

Two cautions on selectors:

- The `data-v-*` attributes are Vue **scoped-style markers** and change per build. Never key
  off them. The readable class names (`search-placard`, `price-container`) are the stable
  surface, and they are what the prototype uses.
- There is no `data-testid`-style contract, so class names are the only handhold. That is the
  same footing Redfin is on today, and better than Zillow's.

## 2. Verified findings

### Identity — the one real blocker

Property ids are **alphanumeric**, e.g. `vff9j5680b68l`, `1dqw0v173n35j`. Detail URLs are
`/property/<slug>/<pk>/`.

`content.js` hard-rejects anything that is not all digits:

```js
// public/scripts/content.js, StorageManager.saveHouse
if (!/^\d+$/.test(String(houseData?.propertyID ?? ''))) {
  return { ok: false, reason: "Couldn't identify this listing..." };
}
```

**Every Homes.com capture would be rejected by this guard.** It is the only true blocker, and
§4 step 3 fixes it without weakening it for the existing two sites.

Identity is otherwise sound: across all 40 cards on a results page, each card's `data-pk`
matched the key parsed from its own detail URL — **0 mismatches**. So a card capture and a
detail capture of one property dedupe to the same `houseKey`. And because ids are
alphanumeric, cross-site collision risk is *lower* than the digits-vs-digits case that made
`source` part of the key in the first place.

The id rule `^\/property\/[^/]+\/([a-z0-9]+)\/?$` was checked against real paths: results
(`/austin-tx/`), rentals, `/agents/`, `/news/` all yield `null`; detail paths yield the key.

### Results-page cards

| what | selector | measured |
| --- | --- | --- |
| card | `article.search-placard[data-pk]` | 40 per page, 4/4 markets |
| id | `data-pk` attribute | `vff9j5680b68l` |
| price | `.price-container` | `"$615,000"` |
| address | `address` (also `data-listing-title`) | `"2200 Amur Dr Unit B35, Austin, TX 78745"` — **full, with state and ZIP** |
| beds/baths/sqft | `.detailed-info-container` | separate `<li>`: `"4 Beds"`, `"2.5 Baths"`, `"2,282 Sq Ft"` |
| injection anchor | `.placard-user-actions-container` | holds `.favorite-button` + kebab |

**The existing `parseBedBathSqft` works unmodified** — 40/40 cards on the Austin page parsed
beds, baths, sqft, price, address and id with zero failures.

Two card-level gaps, both real data rather than parser bugs:

- **Studios render `"Studio"`, not `"0 Beds"`** → the parser returns `beds: null`. Needs a
  `Studio → 0` rule (§4 step 2). Measured on Chicago condos.
- **Condo sqft is often genuinely absent** (`"1 Bed 1 Bath"` with no sqft) — 7 of 40 Chicago
  condo cards. Nothing to fix; it degrades to a missing rent estimate, which the panel
  already surfaces.

`data-detail-url` is present on Austin cards and **absent on Chicago cards** — do not depend
on it. `data-pk` is primary and the `a[href*="/property/"]` fallback was present on 40/40
with 0 mismatches.

### Detail pages — three traps worth knowing

A detail page **embeds up to 9 similar/sold cards using the identical results-card markup**.
Every read must be scoped, or it reports a neighbour's numbers. Measured consequences:

1. **`.price-container` on a detail page is a different property.** On the Amur Dr listing it
   returned `$399,900` against the subject's `$615,000`; on a Chicago condo it returned
   `"$180,000 Sold Feb 27, 2026"` — a sold comparable. Use `#price`, which measured clean
   (`"$134,500"`) with the price-drop badge excluded. Note the *parent*
   (`.property-info-price-and-icons`) reads `"$134,500 $6K PRICE DROP"`, which `parseMoney`
   correctly refuses — so it must be `#price` itself.
2. **`.detailed-info-container` on a detail page is also a comparable.** On the 420 sqft
   studio it returned `"2 Beds 2 Baths 1,000 Sq Ft"`. The subject's own facts live in
   `.ldp-property-info-container` — which does **not** contain `.detailed-info-container` at
   all. This one would have shipped confidently wrong numbers.
3. **`"Shoal Creek"` contains a case-insensitive `"hoa"`.** A loose HOA scan matches Austin's
   Shoal Creek listings. The shipped anchored `parseHoa` correctly returns `null` on that
   text and `125` on a real `"$125 Monthly HOA Fees"`. Keep it anchored, and scope it to
   `#amenities-container` (verified to be the subject's own section, not a card's).

The subject's facts are label/value sibling pairs inside `.ldp-property-info-container`:

```
.property-info-feature > .property-info-feature-detail ("2.5") + .feature-baths ("Baths")
```

Reading the pair's combined text gives `"4 Beds"`, `"2.5 Baths"`, `"2,282 Sq Ft"`.

### `ld+json` — richest of the three sites, but not sufficient alone

One `@graph` blob with a `RealEstateListing` node carrying `offers.price`, and a `mainEntity`
with `numberOfBedrooms`, `numberOfBathroomsTotal`, `floorSize.value`, `yearBuilt`, `address`
and **`geo.latitude/longitude`**. Geo comes free — no `__NEXT_DATA__` walk like Zillow needed.
`offers.url` / `@id` carry the pk, so it can be scoped to the current listing the same way the
Zillow adapter scopes its price.

Two measured reasons it cannot be the sole source:

- **It drops half-baths.** `numberOfBathroomsTotal: 2` where the listing renders `2.5 Baths`
  (Amur Dr). Baths must come from the DOM. Beds and sqft agreed everywhere, including
  `numberOfBedrooms: 0` correctly for the studio.
- **`offers` is sometimes absent entirely.** The Cleveland multi-family had no `offers` at
  all; `#price` gave `$139,900`. The DOM price fallback is required, not decorative.
- **`name` is sometimes street-only** — `"11101 Nelson Ave"` with no city/state/ZIP, where
  `document.title` had the full `"11101 Nelson Ave, Cleveland, OH 44105"`. So address needs
  the same state+ZIP preference test the Zillow adapter already applies to its title, applied
  to *both* candidates rather than trusting `ld.name` first.

### Injection and clicks — tested live on both surfaces

Using content.js's real CSS classes and injection logic:

- **Detail page:** button landed in `.property-info-user-actions` beside the heart — 83×30,
  same baseline, no overflow, `elementFromPoint` at its centre returned our own SVG (nothing
  covering it). A real click registered on the button, did **not** navigate, and did not
  trigger favourite. See the screenshot in the session; it reads as a native control.
- **Results cards:** injected into 40/40 cards, all visible, all on the same row as the heart,
  none overflowing the card. A real click did not navigate to the listing, did not favourite,
  opened no modal, and all 40 buttons survived Vue re-renders.
- **No stretched overlay link.** The card's anchors are `static` and the actions container is
  not inside an `<a>` — so Zillow's click-hijack problem does not appear here. The existing
  document-level capture interceptors still protect us at no cost, and content.js's
  `dataset.busy` guard already makes repeated click events idempotent.
- **Narrow widths:** at `innerWidth` 256 — below the side panel's 320px floor —
  `.property-info-user-actions` was still visible (226×32) and cards still rendered with
  visible action rows. **No mobile action-bar swap**, so unlike Zillow there is no second
  target to chase.

### What was not checked

- Rental (`/apartments-for-rent/`) and land listings — the id rule returns `null` for rental
  *search* paths, but a rental detail page under `/property/` was not opened.
- Off-market / "coming soon" states, which on Redfin turned out to lack an action bar entirely.
- Whether class names survive a deploy. One day is not evidence of stability; this is the same
  standing risk Redfin carries.
- Map hover cards, and whether they abbreviate prices (`parseMoney` already handles `$1.2M`).

## 3. Risks

| Risk | Assessment |
| --- | --- |
| **Terms of use** | I could not read them: homes.com returns 403 to every non-browser client, including `robots.txt`, so `WebFetch`/`curl` cannot reach the ToU page. CoStar (the owner) publicly reserves the right to enforce against unauthorised scraping. The extension reads the DOM of a page the user already loaded in their own browser and sends nothing anywhere — the same posture as Redfin and Zillow today — but **this is a legal call for you to make, not a technical one.** Worth reading `https://www.homes.com/about/homesterms-of-use/` in a browser before shipping. |
| **Akamai bot management** | Confirmed active on the origin. It does not affect the extension (real browser, real session, no extra requests — the adapter only reads the DOM the user already loaded). It does mean automated re-probing for future selector fixes has to happen in a real browser, as it did here. |
| **Selector stability** | Class names are readable and semantic, but there is no `data-testid` contract. Mitigated by `data-pk` for identity, `ld+json` for most fields, and ordered `firstUsable` fallbacks. |
| **Store re-review** | A third host permission means a new review pass and updated permission justifications. This is the main schedule risk, not the code. |
| **The comparable-card traps** | The three §2 traps are the real engineering risk. Two of them produce *confidently wrong numbers* rather than visible failures, which is why the plan pins them in tests. |

## 4. Plan

### Step 1 — new adapter `public/scripts/sites/homes.js`

Implements the documented contract (`architecture.md` §Adapter contract). A validated
prototype exists; the substantive decisions it encodes:

- `isDetailPage()` — URL-based, off the pk rule. Must not be DOM-based: the detail page
  contains 9 card elements that a DOM check would confuse for a results page.
- `extractFromDetailPage()` — price from `ld+json` `offers.price` then `#price`; beds/sqft from
  `.ldp-property-info-container` feature pairs then `ld+json`; **baths from the DOM only**
  (half-baths); address by preferring whichever of `ld.name` / `document.title` carries state
  and ZIP; geo from `mainEntity.geo`; HOA from `#amenities-container` via `parseHoa`.
- `extractFromCard()` — scope `separatedText` to `.detailed-info-container`, **not the card**.
  Cards inline `<script type="text/template">` carousel templates, and a TreeWalker over the
  whole `article` returns that raw markup as text. The Zillow adapter's whole-card
  `separatedText(card)` would parse HTML here.
- `detailInjectionTarget()` — `.property-info-user-actions`, `insertAfter` the favourite
  button, with `.property-info-price-and-icons` → `.property-info-address` → `h1` parent as
  `firstUsable` fallbacks.
- `cardInjectionTarget()` — `.placard-user-actions-container`, `insertAfter` `.favorite-button`.
- Reuses Zillow's button classes (`sidecar-Button--icon` / `--action`), which is what produced
  the native-looking result in the live test.

### Step 2 — `public/scripts/sites/parsers.js` (additive)

- `homesPropertyId(pathname)` — `^\/property\/[^/]+\/([a-z0-9]+)\/?$`, alongside the existing
  two id rules.
- Teach `parseBedBathSqft` that **`"Studio"` means 0 beds**. Additive: it currently returns
  `null` for that text, so no existing behaviour changes.

### Step 3 — `public/scripts/content.js` (the blocker fix)

Register the adapter (`const ADAPTERS = [RedfinAdapter, ZillowAdapter, HomesAdapter]`), and
replace the hard-coded id guard with an adapter-declared one that **defaults to today's rule**:

```js
const idIsValid = site.isValidPropertyId
  ? site.isValidPropertyId(houseData?.propertyID)
  : /^\d+$/.test(String(houseData?.propertyID ?? ''));
```

Redfin and Zillow declare nothing and keep the exact digits-only guard they have now; the
Homes adapter declares `^[a-z0-9]{6,}$`, which still rejects `null`, `'N/A'` and the empty
string that the guard was added for. This is the only change to shared code, and the length
floor also stops the id rule's permissiveness (`/property/foo-bar/abc/` → `abc`) reaching
storage.

### Step 4 — `public/manifest.json`

Add `https://*.homes.com/*` to `host_permissions` and to the content-script `matches`, and add
`scripts/sites/homes.js` to the `js` list **before `content.js`** (load order matters — the
adapters publish globals).

### Step 5 — panel (`src/App.tsx`)

- `:35` widen `source?: 'redfin' | 'zillow'` to include `'homes'`.
- `:1181` the listing link's `aria-label` is a two-way ternary on `'zillow'`; make it a lookup
  so it says "Open listing on Homes.com".
- `:230–233` the `houseKey` comment explains the digits collision; note the third source is
  alphanumeric.

No changes to `analysis.ts`, `metrics.ts`, `modes.ts`, `export.ts`, storage shape or the
service worker. `parseMoney` already handles both `"$615,000"` and the bare `"615000"` that
`ld+json` yields. The export gets Homes.com houses for free, since sheets are per *strategy*,
not per site.

### Step 6 — tests

Following the existing convention (`test/site-adapters.test.ts` evaluates the real adapter
files in jsdom against DOM shapes transcribed from live measurements):

- Card extraction from the measured markup, including the `"Studio"` card and a condo card
  with no sqft.
- **Detail-page scoping regressions, transcribed from the live traps** — a fixture with the
  subject plus a similar card, asserting the extractor returns the subject's `$615,000` and
  not `$399,900`, and the studio's `420 Sq Ft` and not the comparable's `1,000 Sq Ft`. These
  are the two bugs that would otherwise ship silently.
- `2.5 Baths` beats `ld+json`'s `2`; `#price` fallback when `offers` is absent; street-only
  `ld.name` loses to a title carrying ZIP.
- `parseHoa` returns `null` on `"North Shoal Creek"` and `125` on `"$125 Monthly HOA Fees"`.
- `homesPropertyId` against the real path shapes in §2.
- The id-guard change: assert Redfin/Zillow still reject non-numeric ids.

Baseline before any of this: **515 tests, 22 files, all green.**

### Step 7 — docs and store

- `README.md`, `docs/architecture.md` (component diagram, adapter contract, per-site
  differences) — currently name two sites throughout.
- `store/LISTING.md` — description, the `*.homes.com` permission justification (`:98` follows a
  clear per-host pattern), and screenshots. Bump `version` in **both** `package.json` and
  `public/manifest.json`.
- Keep this document as the recon record, the way `zillow-recon.md` serves Zillow.

### Step 8 — manual verification

`npm run build`, load unpacked, then confirm on a real results page and a real detail page
with the side panel open: one button per card, exactly one on a detail page, none on the
similar-homes cards, and a capture whose price/beds/baths/sqft/HOA match what is on screen.
Check a studio and a condo with no sqft specifically.

## 5. Status

The adapter was written and its logic validated against live pages during this research: card
extraction 40/40 on Austin, detail extraction across 12 listings in Austin, Chicago, Phoenix
and Cleveland covering single-family, condo, new-build and multi-family, plus injection and
real clicks on both surfaces. Three design bugs were found and corrected **by that testing**
rather than by review — the `.price-container`, `.detailed-info-container` and `ld.name`
traps — which is the main argument for keeping the step 6 scoping tests.

**The rest of this section supersedes what it used to say.** Sections 1–4 are the recon record and
still stand as written; §4's plan has since been carried out. Three commits landed on
`calculator-modes`:

| Commit | What |
|---|---|
| `a359016` | The adapter, manifest registration, the adapter-declarable id guard, 20 tests |
| `1cf2de6` | Comp-workflow alignment: one shared id guard, the sold-price label fix, `compFacts()`, both `source` unions |
| `97eaef1` | §8 of [comp-workflow-open-bugs.md](./comp-workflow-open-bugs.md) — the remaining Homes.com gaps |

Done: steps 1, 3, 4, 5 and 6 of §4's plan. Step 2 was folded into the adapter instead — it owns its
own id rule and "Studio" handling rather than editing `parsers.js`, because both branches were in
flight at once. **Step 7 is not done**: the store listing, its permission justification, and the
`README.md` / `docs/architecture.md` mentions of "Redfin and Zillow" all still describe two sites.
Note `docs/architecture.md` is gitignored, so it is invisible in a fresh clone — and its
adapter-contract section is now stale in two ways, missing both this site and the comp additions.

Everything outstanding on the *behaviour* side lives in
[comp-workflow-open-bugs.md](./comp-workflow-open-bugs.md) §8, not here: the rental-page gap (8a),
the comp URL builder and the design decision it needs (8b), what has never been run (8c), and the
fragility notes (8e). That document is the live handover; this one is the measurement archive.

### Working on this site again

Three practical things, learned the hard way and not evident from the code.

**You cannot reach homes.com from a terminal.** Every non-browser client gets a 403 from Akamai,
including `robots.txt` — `curl`, `WebFetch` and Node-based fetches are all dead ends. Live recon
has to happen in a real browser session. Pages *are* server-rendered, so once you are in a browser,
a same-origin `fetch` + `DOMParser` from the page context reads other listings without navigating;
that is how 12 detail pages were checked in a handful of calls.

**To verify the shipped adapter against a live page**, strip comments from `parsers.js` +
`homes.js` (~10 KB combined; comments are most of the file), evaluate that in the page, then call
`HomesAdapter.extractFromDetailPage()`. That is how the studio listing was confirmed to return its
own 420 sqft rather than a comp's 1,000. Browser automation also intermittently refuses scripts
with `[BLOCKED: Cookie/query string data]` — it is *script-shaped*, not page-shaped: large payloads
and anything containing URL query strings trigger it, while small focused reads on the same page
succeed. Keep probes small.

**Do not trust a green adapter suite you just wrote.** Fixtures written by the same author as the
extractor will pass while the extractor reads the wrong element — the exact failure this site
invites, since a detail page carries nine comps in identical markup. Every DOM string in
`test/homes-adapter.test.ts` is transcribed from a measured page for that reason. Both suites were
then checked by reintroducing each bug one at a time and confirming a test failed; **one mutation
initially survived** — restoring `buildComp`'s own id regex passed everything, because the
injection gate and the click-time gate are independent paths — which is why each now has its own
test. Repeat that exercise after changing anything here; it is what separates a test that
constrains behaviour from one that merely describes it.

### Where this repo pushes

`origin` is `housebros/extension`; `personal` is `mattstoebe/investor-sidecar`. **This work belongs
on `personal`** — all three commits above went to `personal/calculator-modes` at the owner's
direction, and `origin` was deliberately left untouched. Confirm before pushing anywhere.
