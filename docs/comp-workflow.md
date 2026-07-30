# Comp capture workflow — design

_From user-interview feedback, 2026-07-29. Researched against the live sites the same day;
recon results below are verified unless marked otherwise._

## The feature in one paragraph

From a house's card in the side panel, the user clicks **Find rent comps** (or **Find sold
comps**). The user chooses Redfin, Zillow, or Homes.com; a new tab opens on that chosen site, already flipped to
that site's for-rent (or recently-sold) search, clipped to the subject's zip code and
same-beds/same-baths. On that page, our injected card buttons change meaning: instead of
"Analyze", each reads **"Add as comp for 8109 Ferndale Dr"**. Every click appends that
listing to the subject house's comp list. Back in the panel, the comps render as dots along
the rent slider (rent comps) or under the ARV field (sold comps); clicking a dot adopts that
comp's number. The user builds their own comparables set; we make the loop three clicks per
comp.

This is feature **B2 from feature-research.md ("show the comps") built manually** — and it is
better than kNN retrieval in one important way: the user picked the comps, so they trust the
number the comps imply.

## Verified recon (2026-07-29, zip 78745)

### Search URL grammar

| Site | Kind | URL pattern | Status |
|---|---|---|---|
| Redfin | rent | `redfin.com/zipcode/{zip}/rentals/filter/min-beds={b},max-beds={b},min-baths={ba}` | ✅ works |
| Redfin | sold | `redfin.com/zipcode/{zip}/filter/include=sold-6mo,min-beds={b},max-beds={b},min-baths={ba}` | ✅ works, sold-only |
| Zillow | rent | `zillow.com/homes/for_rent/{zip}_rb/{b}-{b}_beds/{ba}-_baths/` | ✅ works |
| Zillow | sold | `zillow.com/homes/recently_sold/{zip}_rb/{b}-{b}_beds/{ba}-_baths/` | ✅ works |

Notes:
- Redfin's `include=sold-6mo` page **is** sold-only despite the "Homes for Sale" page title —
  all 41 cards carried "Last list price" labels and SOLD sashes. A
  `/recently-sold/filter/...` path 404s; don't use it.
- Redfin normalises filter order in the address bar; order in our constructed URL is free.
- Baths are min-filters on both sites (`min-baths=2` / `2-_baths`) — deliberate: exact-bath
  matching would starve results, and "same beds, ≥ baths" is how appraisers clip anyway.
- Not yet verified: property-type narrowing to cut apartment complexes out of rental results
  — likely `property-type=house` (Redfin) and a `/house_type/` path segment (Zillow). Worth
  adding once confirmed; harmless to ship without.

### Card markup on rent/sold result pages

The single most important recon result: **both sites reuse the exact card markup our
adapters already parse.**

- **Redfin rentals**: 41 `div.bp-Homecard__Content` cards, same `.bp-Homecard__Address`,
  `.bp-Homecard__Price--value`, `.bp-Homecard__Stats` ("3 beds2 baths1,140 sq ft").
  Price text is `"$2,100/mo"` for houses, `"$1,200+/mo"` for apartment complexes.
  Apartment complexes link to `/apartment/{id}` paths — their trailing segment is still
  all-digits, so `redfinPropertyId` accepts them (see "Apartment ambiguity" below).
- **Redfin sold**: same cards. **The big price is the *last list price*, not the sold
  price** — `.bp-Homecard__Price--label` reads "Last list price" (TX is a non-disclosure
  state; in disclosure states this label should read "Sold price" — capture the label, not
  just the number). Sold date is in the card sash text: `SOLD MAY 28, 2026`.
- **Zillow sold**: same `article[id^="zpid_"]` cards, `/homedetails/` links,
  `property-card-address-link` / `property-card-price` testids. In TX every sold price
  renders `"$--"` (non-disclosure again).
- **Zillow rentals**: same `article` markup, **but** the first screen of results was 100%
  apartment complexes whose article ids are `zpid_{lat}--{long}` (not a real zpid) and whose
  links go to `/apartments/...`, not `/homedetails/`. Our existing `isInjectableCard`
  (requires a `/homedetails/` link) and the numeric-propertyID gate already reject these,
  which is the correct behaviour for SFH comps. Real house rentals do use `/homedetails/`
  links with true zpids.

## Design

### 1. Data model

Comps are sub-data on the subject house, exactly as the interviewee described:

```ts
interface Comp {
  source: 'redfin' | 'zillow';
  propertyID: string;
  kind: 'rent' | 'sold';
  address: string;
  /** Parsed monthly rent (rent comp) or price (sold comp). */
  amount: number;
  /** What the site called the number: 'rent' | 'sold' | 'last-list'. Non-disclosure
   *  states never show a sold price; last list price is the honest fallback and must
   *  be labelled as such in the panel. */
  amountLabel: 'rent' | 'sold' | 'last-list';
  beds: string; baths: string; sqft: string;
  url: string;
  soldDate?: string | null;   // from the card sash, sold comps only
  capturedAt: number;
}

interface House {
  // ...existing...
  comps?: Comp[];             // both kinds in one list, discriminated by `kind`
}
```

One list, not `{rent: [], sold: []}` — every consumer filters by `kind` anyway and one
list keeps merge/undo logic single-pathed.

Rules, following the existing storage doctrine:
- **The worker stays the sole writer.** New message `addComp { targetKey, comp }` goes
  through `mutateStoredHouses`. Dedupe on `(comp.source, comp.propertyID, comp.kind)`
  within the target house — re-clicking a comp flashes "Already added" via the existing
  `{ok, reason}` ack path.
- `removeComp` message from the panel, also via the queue, recorded as an undoable
  `op: 'comp'` entry restoring the prior `comps` array — a small extension to
  `house-storage.js`, since the existing `edit` op restores only `localParams`. Comp *adds*
  are deliberately not undoable: a mistaken add is one visible ✕ away, and a re-click of the
  same card just flashes "Already added".
- **Comp writes must not bump `rev`.** `stampRevision` exists so cards can arbitrate
  ownership of `localParams`, and `useHouseParams` reacts to a foreign revision by adopting
  storage state and *discarding pending un-flushed edits* (see its adoption effect). A comp
  add stamped as a revision would therefore eat keystrokes typed in the ≤400ms debounce
  window — and "editing the panel while clicking comps in another tab" is this feature's
  core workflow, not an edge case. Comps aren't in `localParams`; the card receives them
  through the `updateSidePanel` broadcast re-render, so skipping the stamp loses nothing
  and makes "a comp add can never clobber a user edit" true by construction.
- A comp is a **snapshot**, like a captured house: we do not re-scrape or refresh it.

### 2. The comp session

The new tab needs to know it is in comp mode, for which subject, and which kind. That state
lives in `chrome.storage.local` under a new key, written only by the worker:

```ts
interface CompSession {
  tabIds: number[];         // every tab the worker considers part of this session
  targetKey: string;        // houseKey of the subject
  kind: 'rent' | 'sold';
  subject: {                // enough to label buttons and render the banner
    address: string; price: string; beds: string; baths: string; sqft: string;
    latitude: number | null; longitude: number | null;
  };
  startedAt: number;
}
```

Flow:
1. Panel sends `startCompSession { targetKey, kind }`.
2. Worker looks up the house, builds the URL (below), `chrome.tabs.create({ url })`, writes
   `compSession` with `tabIds: [newTab.id]`, acks the panel.
3. Content script, at init and on `chrome.storage.onChanged`, asks the worker
   `getCompSession` — the worker compares `sender.tab.id` against `session.tabIds` (the
   content script never needs to know its own tab id by other means) and returns the session
   or null.
4. **A session follows a tab it opens, not just the one it started in.** Corrected
   2026-07-29 after live testing: Redfin opens a listing's detail page in a genuinely new
   tab (Zillow instead overlays the same tab), so a single `tabId` meant comp mode never
   survived the one click users make most — opening a listing to see it. `chrome.tabs.onCreated`
   appends a new tab to `tabIds` whenever its `openerTabId` is already a member — this needs no
   cooperation from the page, since Chrome records `openerTabId` for both a `target="_blank"`
   link and a `window.open()` call. Deliberately unbounded: the natural ceiling on how many
   tabs one comp hunt opens is the tab picker, not a cap worth enforcing.
5. Session ends when: the user clicks **Done** on the banner, every tab in `tabIds` has
   closed (`chrome.tabs.onRemoved` drops just the closed tab from the set; the session itself
   is removed once the set is empty), or a fresh `startCompSession` replaces it. One active
   session at a time is deliberate — it matches how a person actually works and avoids a
   registry of sessions to garbage-collect. `startedAt` lets the worker discard a stale
   session (> a few hours) on the next lookup.

Tab-scoping matters: ordinary browsing in other tabs must keep the plain Analyze button.

**URL construction** happens in the worker (a small `comp-links.js`): zip from the trailing
`\b(\d{5})(?:-\d{4})?\b` of `house.address` (both adapters store full addresses with zip;
Zillow's extractor already prefers the title address *because* it carries state+zip), beds
and baths from the house record, and the session's `kind` picks the pattern from the table
above. The source picker defaults to `house.source`, while allowing a different supported site
when it has better coverage or disclosure data. The adapters remain reusable because capture
"same website, flipped mode". No zip in the address → ack `{ok:false}` and the panel says
why. Missing beds/baths → drop that filter segment rather than guessing. **Floor fractional
baths** (2.5 → `min-baths=2` / `2-_baths`): only integer grammar was verified, baths is a
min-filter so flooring merely widens results, and an unrecognised segment risks a redirect
to an unfiltered page.

### 3. Content script in comp mode

`content.js` gains a `compSession` variable, refreshed at init and on
`chrome.storage.onChanged` (each change re-asks the worker, since only the worker can
tab-scope the answer). When set:

- **Card buttons change identity**: label/tooltip "Add as comp for {subject street}",
  distinct color (the existing `data-state` styling machinery carries this), and the click
  handler routes to `addComp` instead of `addHouse`. The interceptor/injection machinery is
  untouched — only `handleCapture`'s message differs.
- **Session state is authoritative at click time, not injection time.** Buttons are
  injected once and carry their handler from that moment, but the session can start after
  injection (init race) and, more importantly, *end* after it (Done, replacement by a new
  session). The click handler consults the live `compSession` variable; labels/colors may
  lag by a beat, which is harmless. On any session change, the content script removes our
  injected buttons and re-runs `processPage` so the visible identity catches up — the
  existing stale-card sweep is precedent for exactly this move.
- **Detail pages too**: the single detail-page button becomes "Add as comp". Sold listings
  open detail pages with the same adapters' markup; on Redfin the detail page is where the
  true sold price lives even when the card only had last-list. (v1 can keep detail-page
  extraction as-is and take whatever price the header shows — it *is* the sold price on
  sold listings.)
- **Subject banner**: a fixed strip (`data-sidecar`, same style block) pinned to the top of
  the page: "Adding **rent comps** for 8109 Ferndale Dr — $475,000 · 3bd/2ba · 1,474 sqft ·
  [Done]". This is the always-available stand-in for the map pin: the user never loses
  track of what they're comping against. **Done is the only way to dismiss it**, and it
  ends the session (`endCompSession`). A separate close-X that hid the banner but left the
  session live would leave the tab in comp mode with no visible indication — every
  "Analyze"-looking click would silently add comps.
- **Rent parsing**: `parseBedBathSqft` already handles the stats string. Prices need one new
  pure helper in `parsers.js`: `parseCompAmount(text)` → `{ amount, monthly: boolean,
  approximate: boolean }` handling `"$2,100/mo"`, `"$1,200+/mo"`, `"$2,158+Fees may apply"`,
  `"$369,500"`, and `"$--"` (→ null). Rent-kind sessions require `monthly`; a `"+"` price
  (apartment complex "from" pricing) is rejected in v1 — a from-price is not a comp.
  **Consequence in non-disclosure states**: on Zillow every sold card parses to null there,
  so a TX user gets a working sold-comp page on which no card can be added. The click must
  fail with a reason naming the recourse — "No sold price shown. Try Redfin, or open the
  listing." — not a generic error. Redfin stays usable because its last-list price parses,
  honestly labelled via `amountLabel: 'last-list'`.
- **Sold extras**: sold date from the card text (`/SOLD ([A-Z]{3} \d+, \d{4})/i`), and the
  price label ("Last list price") captured into `amountLabel`.
- Everything stays inside the existing adapter contract: one new optional method per adapter
  (`compFacts(cardEl)` returning `{ amountText, priceLabel, soldDateText }`) rather than a
  parallel extraction path — `extractFromCard` already yields address/beds/baths/sqft/id/url.

**Apartment ambiguity (Redfin):** Redfin apartment-complex cards have all-digits trailing
path segments, so unlike Zillow they pass the numeric-id gate. **Corrected 2026-07-29**:
the original design additionally rejected any card whose URL contained `/apartment/`
outright, on top of the `+` price rejection above. Live use found that too broad — it
also rejected legitimate single-unit apartment listings, not just multi-unit "starting at"
ones. The URL says the building has apartments, not that this specific listing's price is
aggregated; only the price shape (a "+" immediately after the digits) actually means that.
The `/apartment/` check is gone; `parsed.approximate` is now the only filter.

### 4. Panel: comps on the card

- **Entry points**: "Find rent comps" lives in the rent section (next to the slider);
  "Find sold comps" in the ARV row of flip/BRRRR sections. Both also make sense from the
  card's overflow area; start with the in-section placement — it puts the button where its
  result will land, which is how the user learns what it does.
- **Rent slider dots**: the slider already computes `sliderPercent` from `chartBounds`; each
  rent comp renders as an absolutely-positioned dot on the same track at
  `(comp.amount - min) / (max - min)`. `getRentBounds` widens to include comp amounts,
  exactly as it already widens for an entered rent. Click → `setParam('monthlyRent',
  comp.amount)` + `commit()` — the identical path a keystroke takes, so revisions, undo and
  the debounced write all behave. Hover/tap → tooltip: street, bd/ba, sqft, `$/mo`, and
  `$/sqft` (the number an appraiser would actually cross-check). The RentChart, when it
  returns, gets the same dots for free since it shares `chartBounds`.
- **Comp list**: beneath the slider, one row per comp — street (link, `target="_blank"`),
  amount, sqft, ✕ to remove. Also a one-line summary: "3 comps · median $2,150". A
  **"use median"** affordance is one extra line of code and is probably what half of users
  actually want.
- **Sold comps** render the same list + dot treatment under the ARV input (flip/BRRRR).
  There is no ARV slider today; v1 is a compact dot-strip (a 1-D scatter, same geometry as
  the slider dots) above the input. `last-list` amounts render with a superscript "list"
  marker — an ARV built on list prices in a non-disclosure state should look different from
  one built on sold prices.
- Comps count toward nothing automatically. The user clicks a dot or "use median"; we never
  silently move their rent. That is the existing enrichment doctrine ("never clobber user
  edits") applied to comps.

### 5. The map pin (interviewee's "optional")

**Corrected 2026-07-29 after direct measurement — see [map-linking.md](./map-linking.md).**
This section previously deferred the map pin on the grounds that both sites' result maps are
canvas/WebGL. That is wrong. Both render their pins as ordinary DOM with stable, semantic
class names: Redfin's `.Pushpin` elements **carry `latitude`/`longitude` attributes
directly**, and Zillow's `[data-test="property-marker"]` elements can be matched to
coordinates exactly (measured at 0.00 px error). Highlighting a pin costs one attribute plus
the stylesheet we already inject, and survives pan and zoom on both sites.

So the pin is feasible and cheap. It is still **not part of this feature's v1** — comp
capture is whole without it, and map-linking.md sequences the work behind a prerequisite
(Zillow card captures store no coordinates at all today). Two things from that plan land
naturally here once it ships:

- The **subject's own pin** highlighted on the comp results page, which is a better answer
  than the banner alone to "what am I comping against".
- **Distance-to-subject per comp**, which is worth doing immediately and independently: it
  needs no map, and after map-linking.md's P0 both sites' card captures carry geo (today
  only Redfin's do).

## Build order

1. **Plumbing** — `Comp` type, `addComp`/`removeComp`/`startCompSession`/`endCompSession`/
   `getCompSession` in the worker, `comp-links.js` URL builder, session lifecycle.
   Testable headless: URL builder and comp merge/dedupe/undo are pure.
2. **Content script comp mode** — button relabel, banner, `parseCompAmount`, adapter
   `compFacts`. Tests extend the existing vm-sandbox parser tests with the price strings
   recorded above.
3. **Panel** — rent slider dots + comp list + use-median; sold dot-strip under ARV.
4. **Later** — property-type URL narrowing once verified, sold price from detail pages in
   non-disclosure states, distance-to-subject, refreshing stale comps.

Each phase ships alone: after (1)+(2) comps accumulate invisibly in storage (verifiable in
devtools); after (3) the loop is whole.

## Open questions

> **Bugs and gaps as of 2026-07-29 live testing live in
> [comp-workflow-open-bugs.md](./comp-workflow-open-bugs.md)**, not here — one known-unfixed bug
> (Zillow's click-through navigation), two items needing a repro, the manual QA nobody has run,
> and the fixes that shipped without a hand-check. This section stays what it was: design
> questions the feature deliberately left open.

- **Sold window**: 6 months is the appraisal norm (`sold-6mo` baked into the Redfin URL);
  Zillow's default window is what `recently_sold` gives (appears to be ~all recent —
  fine for v1, revisit if users complain about stale comps).
- **Cross-site comps**: a Zillow-captured house could hunt comps on Redfin (better sold
  data in some markets). The model supports it (`comp.source` is per-comp); v1 keeps the
  source choice visible for UX clarity.
- **Comps in the export**: an obvious follow-on — one comps block per house sheet in
  `export.ts`. Not in v1 scope but the data shape above makes it a pure addition.
- **Bath filter**: exact beds + min baths is asserted above as the right clip; confirm with
  the interviewee that "same baths" wasn't load-bearing.
- ~~Known v1 limitation — ctrl+click escapes the session~~ **Shipped 2026-07-29**: users
  tripped on it immediately, since Redfin opens a listing's detail page in a new tab by
  default (not ctrl+click, just an ordinary click) — so this was the normal flow on Redfin,
  not an edge case. `chrome.tabs.onCreated` + `openerTabId` now follows the session onto any
  tab opened from one already in it; see §2. What's left unaddressed: a tab opened with no
  `openerTabId` at all (typed URL, bookmark, a link from *outside* redfin.com/zillow.com)
  still starts outside the session, which is correct — the session is about listings reached
  from within the comp hunt, not every tab on the site.

---

# Appendix — implementation notes

Written for whoever implements this, including a model working without the context that
produced the plan. The design above says *what*; this says *where*, *in what order*, and
*what not to touch*. Line numbers are from 2026-07-29 and may drift — search for the named
symbol rather than trusting the number.

## A. Rules that override anything else in this doc

These encode bugs that are invisible in review and expensive live. Follow them literally.

1. **No write that only touches `comps` may call `stampRevision`.** Not `addComp`, not
   `removeComp`, and **not the undo path** — `applyUndoEntry` stamps on every existing
   branch, so a comp branch copied from its neighbours will stamp too. That is the trap.
   Rationale in §1: a foreign `rev` makes `useHouseParams` discard pending un-flushed
   keystrokes (`src/useHouseParams.ts`, the adoption effect ~line 164). The panel still
   updates without a stamp, because `SidePanel` replaces its whole `houses` array from the
   `updateSidePanel` broadcast (`src/App.tsx` ~line 1445) and `HouseCard` re-renders from
   the new prop. Verified: cards are keyed by `houseKey` (~line 1504), so no remount, and
   the adoption effect early-returns on an unchanged `rev`, so param state is untouched.
2. **Every `storedHouses` write goes through `mutateStoredHouses`** in
   `public/scripts/background.js` (~line 69). Never call `chrome.storage.local.set` on
   `storedHouses` from anywhere else, and never write it from the panel. The panel sends
   messages; the worker writes.
3. **The button says "Added" only after the worker acks.** Reuse the existing
   `{ ok, reason }` contract — `handleCapture` / `StorageManager.saveHouse` in
   `public/scripts/content.js` (~lines 256–284). Do not assume success.
4. **No new manifest permissions.** `tabs.create`, `tabs.onRemoved` and `tabs.sendMessage`
   all work with what `public/manifest.json` already declares (`storage`, `sidePanel`, plus
   the two host permissions). If you think you need a permission, you have taken a wrong
   turn.
5. **`houseKey` is duplicated on purpose** (`house-storage.js` and `App.tsx`). Do not
   "fix" it by sharing one — the worker is not a module the panel can import.

## B. Do not touch

Changing these is out of scope and will break things whose failure mode is silent. Each is
load-bearing and documented in-place by comments that explain why.

| File / region | Why it is off-limits |
|---|---|
| `content.js` — MutationObserver, debounce, resize disconnect (`init`, ~423–512) | Tuned against live site churn; feeds back into itself if perturbed |
| `content.js` — document-level interceptors (`installButtonInterceptors`, ~189–225) | Capture-phase ordering is why clicks don't navigate Zillow's cards |
| `content.js` — `injectInto`, `ensureCalculatorOnDetailPage` dedupe (~298–368) | Responsive breakpoints duplicate buttons without it |
| `background.js` — `mutateStoredHouses` queue semantics (~69–108) | The only place a read and its write are atomic |
| `house-storage.js` — `applyLocalParams`, `mergeEnrichmentIntoLatest` | Protect user edits from async writes; tested |
| `useHouseParams.ts` — debounce / adoption / echo logic | Three interacting bugs' worth of fixes |
| Existing selectors in `sites/redfin.js`, `sites/zillow.js` | Verified live; changing one silently breaks capture |

You will **add** to `content.js`, `background.js`, `house-storage.js` and the adapters. You
should not need to **modify** existing logic in any of them beyond the specific insertion
points in §C.

## C. Phases, with exact anchors and acceptance criteria

Run `npm test` after every phase; it must stay green. `npm run build` must also pass
(`tsc -b` is part of it). Phases ship independently — do not start the next until the
current one's checklist passes.

### Phase 1 — storage and session plumbing (no UI)

Files: `public/scripts/house-storage.js`, `public/scripts/background.js`, new
`public/scripts/comp-links.js`, `src/App.tsx` (types only), `public/manifest.json`
(content-script list only, to load the new file).

Add:
- `Comp` interface and `comps?: Comp[]` on `House` in `src/App.tsx` (the `House` interface
  is ~line 32). Types only in this phase.
- `comp-links.js`: pure `buildCompUrl({ source, address, beds, baths, kind })` → url string
  or null. Implements the URL table in the recon section, the zip regex, integer-flooring of
  baths, and dropping absent segments. **Pure and dependency-free so it is unit-testable** —
  this is the single highest-value test in the feature.
- `house-storage.js`: `addCompToHouse(houses, key, comp)` and
  `removeCompFromHouse(houses, key, compId)`, both pure, both returning
  `{ updatedHouses, updatedHouse }` or null when the house is gone — mirror
  `applyLocalParams`'s shape and null-handling exactly, **minus the `stampRevision` call**
  (rule A1). Add an `op: 'comp'` branch to `applyUndoEntry` (~line 145) restoring
  `entry.comps`; again no stamp. `pushUndoEntry`'s coalescing is `edit`-only and needs no
  change.
- `background.js`: message handlers `addComp`, `removeComp`, `startCompSession`,
  `endCompSession`, `getCompSession`. Follow the `updateLocalParams` handler (~line 185) as
  the template for async ack + `return true`. Session lives in `chrome.storage.local` under
  `compSession`; `getCompSession` compares `sender.tab?.id` against `session.tabIds` and
  returns null when absent. `chrome.tabs.onCreated` grows `tabIds` when a tracked tab opens
  a new one (`openerTabId`); `chrome.tabs.onRemoved` drops just the closed tab, clearing the
  whole session only once `tabIds` is empty.

Done when:
- [ ] `npm test` green, `npm run build` clean.
- [ ] New unit tests: `buildCompUrl` produces each of the four verified URLs for a
      3bd/2ba house in 78745, floors a 2.5-bath subject, and returns null for an address
      with no zip.
- [ ] New unit tests: adding the same comp twice yields one comp; removing then undoing
      restores it; both leave `rev` **unchanged** (assert this explicitly — it is rule A1).
- [ ] Manual: from the panel's devtools console, sending `startCompSession` opens a
      correctly-filtered tab and writes `compSession`; closing that tab clears it.

### Phase 2 — content script comp mode

Files: `public/scripts/content.js`, `public/scripts/sites/parsers.js`,
`public/scripts/sites/redfin.js`, `public/scripts/sites/zillow.js`.

- `parsers.js`: add pure `parseCompAmount(text)` → `{ amount, monthly, approximate }` or
  null. Fixtures are recorded verbatim in the recon section — use those exact strings.
- Adapters: add `compFacts(cardEl)` returning `{ amountText, priceLabel, soldDateText }`.
  Redfin's price label is `.bp-Homecard__Price--label`; the sold sash is matched from card
  text with `/SOLD ([A-Z]{3} \d+, \d{4})/i`.
- `content.js`: module-scope `compSession`, refreshed at init and on
  `chrome.storage.onChanged`; on change, remove our injected buttons and re-run
  `processPage()` (rule: identity must not go stale — see §3). Branch inside the click
  handler, **not** inside the injection machinery: `handleCapture` gains a sibling
  `handleCompCapture` and `ensureCalculatorOnCard` (~line 310) chooses which to pass. The
  banner is a `data-sidecar="1"` fixed element appended once, styled in the existing
  `ensureCalculatorStyles` block.

Done when:
- [ ] `npm test` green (extend the existing vm-sandbox parser tests in
      `test/site-parsers.test.ts`).
- [ ] Manual on Redfin: comp session open → card buttons read "Add as comp for …", clicking
      three adds three comps under the subject in `chrome.storage.local`, a fourth click on
      the same card flashes "Already added".
- [ ] Manual: clicking **Done** flips the buttons back to "Analyze" in the same tab without
      a reload, and a second tab on the same site was never in comp mode.
- [ ] Manual on Zillow sold in TX: the click fails with the "No sold price shown" reason,
      not a generic error.
- [ ] Regression: with **no** session, Analyze on both sites behaves exactly as before.

### Phase 3 — panel

Files: new `src/CompDots.tsx`, `src/App.tsx` (narrow edits only), `src/modes.ts` (unchanged
— the rent section already exists at `{ id: 'rent', … detail: 'rentChart' }`).

**Build `CompDots` as a standalone component first.** `HouseCard` is ~700 dense lines with
hook-ordering constraints (see the comment above `rentBuffer` explaining why hooks are
hoisted out of `renderDropdownContent`). Keeping the new UI in its own file is what keeps
this phase reviewable. Contract:

```tsx
export interface CompDotsProps {
  comps: Comp[];                          // already filtered to one kind by the caller
  bounds: { min: number; max: number };   // same object the slider uses
  /** Adopt a comp's number. Caller wires this to setParam + commit. */
  onPick: (amount: number) => void;
  /** Optional: remove a comp. Caller sends the worker message. */
  onRemove?: (comp: Comp) => void;
}
```

`CompDots` renders only the dot track (absolutely positioned dots at
`(amount - min) / (max - min) * 100`%) plus tooltips. It holds no chrome.* calls, no
storage awareness, and no analysis logic — pure props in, callbacks out, so it is testable
with `@testing-library/react` the way `test/house-card.test.tsx` tests cards.

Edits inside `App.tsx`, kept to three:
1. `getRentBounds` (~line 861): widen `observedUpper` to include comp amounts — one added
   term in the existing `Math.max`, mirroring how it already accommodates a typed rent.
2. In the rent dropdown body (~line 970, next to the existing slider `<input type="range">`),
   mount `<CompDots …>` and the comp list beneath it. Wire `onPick` to
   `setParam('monthlyRent', amount)` followed by `commit()` — the same path a keystroke
   takes, which is what preserves debounce, undo and revision behaviour.
3. The "Find rent comps" button in that same section; "Find sold comps" beside the ARV
   field for flip/BRRRR. Both send `startCompSession`.

Pre-made decisions, so no design judgement is needed: put both buttons **inline in their
section, right-aligned, as a text button in the existing link/secondary style** (match
neighbouring controls; do not invent a new visual). The sold dot-strip reuses `CompDots`
with `bounds` derived from the comp amounts themselves (min/max ±10%), since there is no
ARV slider to borrow bounds from.

Done when:
- [ ] `npm test` green including a new `CompDots` test (renders one dot per comp; clicking
      a dot fires `onPick` with that comp's amount).
- [ ] Manual: comps captured in phase 2 appear as dots; clicking one sets rent and the card's
      metrics recompute; the value persists across a panel close/reopen.
- [ ] Manual: typing in the rent field **while** a comp is added from the other tab does not
      lose keystrokes (this is rule A1's acceptance test — do it deliberately).
- [ ] Manual: dark mode and a 320px-wide panel both render the dots and list without
      overflow.

## D. If you get stuck

- **A selector doesn't match**: do not guess a replacement. The verified selectors and the
  exact page URLs they were measured on are in the recon section and `zillow-recon.md`.
  Re-measure with the extension's own diagnostics (`window.__investorSidecarLogView()` in
  the page console) before changing anything.
- **Zillow returns a bot challenge**: stop probing. `zillow-recon.md`'s operational note
  exists for this. Work against Redfin, which has not challenged.
- **A test you didn't touch starts failing**: you have modified something in §B. Revert and
  re-approach rather than adapting the test.
- **The design seems wrong**: it may be — say so rather than silently diverging. §1's `rev`
  rule and §3's session-staleness rule are the two places where the obvious implementation
  is the wrong one, and both are already accounted for here.
