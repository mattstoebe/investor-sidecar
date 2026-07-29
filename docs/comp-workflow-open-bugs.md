# Comp workflow — outstanding bugs and handover

_Written 2026-07-29 at the end of the comp-capture build (see [comp-workflow.md](./comp-workflow.md)
for the design). Everything here is **what is not done**: bugs found during live testing and left
unfixed, fixes that shipped but were never confirmed by hand, and deferrals that are deliberate but
easy to mistake for bugs._

The feature itself is built and working — comps capture from both sites and drive the rent slider
and ARV field. Every item below is a known gap, not a surprise waiting to be discovered.

_Updated 2026-07-29, later the same day: a third site adapter (Homes.com) landed on top of this
work — see [homes-com-feasibility.md](./homes-com-feasibility.md) for its recon record. Its
interaction with comps is **§8**, added rather than folded in so this document's own numbering
stays stable. `npm test` is green at 627 tests and `npm run build` is clean; `dist/` needs a
rebuild if you last built before those two commits._

## How to read the status labels

| Label | Means |
|---|---|
| **OPEN** | Reproduced, root cause known or partly known, no fix written |
| **NEEDS INFO** | Reported by the user, not reproduced here; needs a repro or a clarification before it can be fixed |
| **UNVERIFIED FIX** | Fix is written, tested, and in `dist/`, but nobody has confirmed it by hand on the live site |
| **BY DESIGN** | Behaves this way on purpose; documented so it isn't "fixed" by accident |

---

## 1. OPEN — Zillow: clicking our button also navigates the page away

**Symptom.** On Zillow results pages, clicking the injected button *both* performs the capture
(the comp/house really is added) *and* opens the listing detail page. Reported as "annoying" for
both sold and rent comps.

**Not comp-specific.** This affects the ordinary Analyze button too. It was simply never
discovered before, because nothing used to send anyone to Zillow's sold/rent search pages — comp
mode created the traffic that exposed it.

**Root cause, measured.** `installButtonInterceptors` in `public/scripts/content.js` (~line 189)
registers its capture-phase listeners on `document`. Zillow's own card navigation fires from a
listener above that in the capture path — on `window` — so it runs *first* and calls
`history.pushState()` imperatively. Our `preventDefault()` / `stopImmediatePropagation()` then
execute against an event whose side effect has already happened. Instrumented live: a diagnostic
`window`-capture listener fired, then `pushState` was called, and only after that did our handler
report success.

```
diag: ["button found: true", "window click CAPTURE", "pushState: /homedetails/5300-Suburban-Dr…"]
```

**What was not isolated.** Whether the triggering event is `click`, `pointerdown` or `mousedown`.
The diagnostic used `element.click()`, which synthesises only a `click` event and does not
reproduce the real pointer sequence, so a real user click may be navigating even earlier than the
measurement shows. Assume the whole event set is in play.

**Why it wasn't fixed.** Every other fix in this round was contained. This one needs the
interceptors moved to `window` *and* registered before Zillow's own — a load-order race, which in
practice means declaring the content script at `document_start` in `public/manifest.json` and
splitting interceptor installation out of the lazy `createCalculatorElement` path that currently
triggers it. That touches the injection machinery the design doc explicitly fences off
(comp-workflow.md §B), and it earns its own testing pass rather than riding along at the end of
this one.

**Suggested approach.**
1. Add a `window`-level capture listener alongside the existing `document` one, for the same event
   list, guarded by the same `closest(BUTTON_SELECTOR)` check. Cheap, and may be sufficient on its
   own if Zillow's listener is registered later than ours.
2. If it isn't sufficient, the manifest needs `"run_at": "document_start"` so our listeners are in
   place before Zillow's bundle executes. Verify this does not break the `MutationObserver` setup,
   which currently assumes `document.body` exists at init.
3. `test/content-driver.test.ts` already proves the `document`-level interception in both phases
   ("stops the event before any ancestor handler sees it"). Extend that suite with a `window`-level
   listener registered *before* the driver loads — that is the case the current tests do not cover
   and the one that actually fails live.

---

## 2. NEEDS INFO — "This is because of non-disclosure states"

While diagnosing bug 1, the user said the Zillow click-through was "because of non-disclosure
states I think". No connection was established: non-disclosure affects whether a *sold price* is
published (TX renders `"$--"`), which is a parsing concern with no bearing on event dispatch or
`pushState`. It may have been about a different symptom entirely.

**Do not act on this without asking.** Either it is unrelated (most likely, and bug 1's measured
cause stands), or the user has observed something real that was never pinned down. Ask before
building on it.

---

## 3. NEEDS INFO — Zillow map popup cards

**Symptom, as reported.** "It works on the side panel cards in zillow but the cards that pop up on
the map still get the calculator" — i.e. the rental-suppression fix (item 8 in §5 below) worked for
the results list but not for the info-window card that appears when a map pin is selected.

**Where it was left.** Live inspection confirmed the popup exists and carries our button, and that
its price element is the same `[data-testid="property-card-price"]` inside an
`article[id^="zpid_"]` that the list cards use — so it goes through the same
`findCardElements` → `ensureCalculatorOnCard` path, not a separate one. Immediately after, a
genuine bug was found in `parseCompAmount`'s `monthly` detection (Zillow glues `"Fees may apply"`
onto `"/mo"` with no separator, defeating a `\b` anchor), which was the reason rental detection
failed on *any* Zillow card. That fix plausibly resolves this report as well.

**Why it's NEEDS INFO rather than UNVERIFIED FIX.** The map popup was never re-tested after that
fix, and live probing was stopped at the user's request over bot-detection risk. Zillow's map
markers also failed to render at all under automation in two attempts (Austin and Chicago), so
this specific surface may not be reachable without manual testing.

**Next step.** Manual check only. Open a Zillow rentals search, select a map pin, confirm no
Analyze button appears on the popup outside comp mode. If it still appears, capture the popup's
outer HTML from devtools before changing any selector — the earlier attempt to read it hit
`[BLOCKED: Cookie/query string data]` from the automation tooling and then the page self-navigated.

---

## 4. UNTESTED — manual QA the plan called for and nobody has run

These are in comp-workflow.md's phase checklists. None are known to be broken; none have been
confirmed. Listed because "the tests pass" does not cover any of them.

- **The rule A1 acceptance test.** Type in a card's rent field *while* a comp is added from the
  other tab, and confirm no keystrokes are lost. This is the one behaviour the whole
  no-`stampRevision` design exists to protect (comp-workflow.md §A1), and it cannot be observed
  from unit tests — `test/house-storage.test.ts` proves `rev` stays unchanged, which is the
  mechanism, not the user-visible outcome.
- **Undo of a comp removal.** `op: 'comp'` is implemented and unit-tested, but the panel has no
  undo affordance wired specifically for it, and the flow (remove a comp → ⌘Z / toast) has never
  been exercised live. Worth checking the toast even appears, since `UndoToast` renders only when
  `undoState.depth > 0` and a comp removal does push an entry.
- **Dark mode and a 320px-wide panel** for `CompDots` and the comp list. The dots are absolutely
  positioned inside a `relative` track; narrow widths and long addresses are the risk. The list
  rows use `truncate min-w-0`, which should hold, but has not been looked at.
- **Redfin's rental detail template end to end.** `isRentalDetailPage` and the new extraction
  branch are unit-tested against markup transcribed from the live page, and the page was confirmed
  to have had *no* button before the fix. That the button now appears *and captures correctly in
  comp mode* was not re-confirmed on the live page.

---

## 5. UNVERIFIED FIX — landed after the user's last confirmed reload

The user confirmed "comps are fixed" and Redfin's tab-following works. These landed later in the
session and have not been through a reload-and-retest cycle:

1. **Abbreviated prices parsed as dollars.** `"$1.10M"` read as `amount: 1` — off by six orders of
   magnitude. `parseCompAmount` had no K/M branch, unlike `parseMoney` in `src/analysis.ts`, which
   has handled the same shape since Redfin's map cards forced it. Fixed and verified by reverting
   (`expected 1 to be 1100000`). **This is the highest-impact of the three** — a $1 comp silently
   poisons a median and an ARV.
2. **Comp session kind vs. page kind.** Flipping Zillow's own For Sale / Sold / For Rent toggle
   mid-session let a monthly rent be stored as a sold comp. Both `buildComp` and
   `isCompEligibleCard` now cross-check `parsed.monthly` against `session.kind`; the button is
   withheld rather than left to refuse on click. Note the deliberate asymmetry: the rent-session
   direction is only enforced when a card's own price text is available, because a Zillow *detail*
   page's price comes from ld+json as a clean number with no `/mo` at all.
3. **Blanket `/apartment/` rejection removed.** Was rejecting legitimate single-unit apartment
   listings; only the `+` "starting at" price marker distinguishes an aggregated multi-unit
   listing. `parsed.approximate` is now the sole filter.

---

## 6. BY DESIGN — not bugs, don't "fix" them

- **A comp session does not follow a tab with no `openerTabId`.** A typed URL, a bookmark, or a
  link from outside redfin/zillow starts outside the session. The session follows tabs *opened
  from* a session tab (`chrome.tabs.onCreated`), which is what made Redfin's
  click-into-a-listing flow work. Extending it further would mean claiming arbitrary tabs.
- **Zillow sold comps are unusable in non-disclosure states.** Every sold price renders `"$--"` in
  TX, which correctly parses to null. The click fails with a reason naming the recourse ("No sold
  price shown. Try Redfin, or open the listing."). Redfin stays usable there because its last-list
  price parses and is labelled `amountLabel: 'last-list'`.
- **Comps are snapshots.** Never re-scraped or refreshed. A stale comp stays stale.
- **Comp *adds* are not undoable**; removals are. A mistaken add is one ✕ away and a re-click just
  flashes "Already added".
- **Comps do not reach the Excel export.** Logged in comp-workflow.md's open questions as an
  obvious follow-on; the data shape makes it a pure addition to `src/export.ts`.
- **No map pin for the subject house.** Feasible and cheap (see [map-linking.md](./map-linking.md)),
  deliberately out of v1 scope. The session banner is the stand-in.
- **Property-type URL narrowing is not implemented.** Would cut apartment complexes out of rental
  results at the source (`property-type=house` on Redfin, a path segment on Zillow) but was never
  verified live, so it is not in the URL builder.

---

## 7. Fragility worth knowing about

Not bugs, but the places where a Zillow or Redfin deploy will break something quietly.

- **`ZillowAdapter.isRentalDetailPage()` reads rendered text**, not structure: it tests
  `[data-testid="price"]`'s text for `/mo`. It cannot use `extractFromDetailPage`'s own `price`,
  because that prefers the ld+json `offers.price`, which Zillow publishes as a clean number for
  rentals too — verified live. If that testid changes, rental detail pages silently become
  "for sale" again and the calculator returns.
- **`RedfinAdapter.isRentalDetailPage()` keys off `.stat-block.price-section`**, checked live to be
  absent from rentals *search* pages. A class rename turns the rental detail page back into a page
  with no button at all, which is how it was found in the first place.
- **`parseCompAmount`'s `monthly` check deliberately has no trailing `\b`.** Restoring one
  re-breaks Zillow, whose card text is `"$1,843/moFees may apply"`. There is a regression test
  naming this exact string.
- **`parseCompAmount` and `parseMoney` are two implementations of overlapping logic**
  (`public/scripts/sites/parsers.js` and `src/analysis.ts`). Intentional — the content script has
  no import graph to share from, same reason `houseKey` is duplicated — but the K/M bug existed in
  one and not the other for exactly this reason. Fix both or neither.

Homes.com's equivalents are in **§8e** — including the one that generalises: `propertyIdIsUsable`
is now the single property-id gate, and a fourth hand-rolled `/^\d+$/` in the capture or comp path
breaks a non-numeric-id site and nothing else.

---

## 8. Homes.com, added after this document was written

A third adapter (`public/scripts/sites/homes.js`) landed on top of the comp work. The adapter
itself is verified — 25 unit tests, and its extraction was run against live pages across 4
markets, 4 property types, 160 result cards and 12 detail pages
([homes-com-feasibility.md](./homes-com-feasibility.md)). What follows is only where it meets
comps, plus what a Homes.com deploy will break.

Two things it *did* fix, both of which had been silently broken for any site with non-numeric ids:
the digits-only property-id regex existed in **three** copies (`StorageManager.saveHouse`,
`buildComp`, `isCompEligibleCard`), so a site could pass ordinary Analyze and be refused by comps
with no symptom but a missing button. All three now call one `propertyIdIsUsable()` in
`content.js`, which still defaults to digits-only. And `HomesAdapter.compFacts` supplies the sold
date from a dedicated selector rather than the whole card's text.

### 8a. OPEN — a Homes.com rental detail page gets an Analyze button it should not

**Symptom.** `HomesAdapter` implements no `isRentalDetailPage()`, so a rental listing is treated
as for-sale and the calculator appears. A monthly rent then enters the buy-and-hold model as a
purchase price — the exact mistake §7's two entries exist to prevent.

**Why the universal fallback does not save it.** `ensureCalculatorOnDetailPage` also tests
`looksLikeRentalPrice(site.extractFromDetailPage()?.price)`. Homes.com's extractor prefers the
`ld+json` `offers.price`, which is a bare number with no `/mo` — so the fallback sees `"2100"` and
says "for sale". This is precisely the reason `ZillowAdapter.isRentalDetailPage()` reads rendered
text instead of the extracted price (§7, first entry); Homes.com needs the same treatment and
does not yet have it.

**What is missing.** The rental signal itself. Rentals live under the same
`/property/<slug>/<pk>/` path as for-sale listings, so `isDetailPage()` cannot distinguish them
and the check has to be structural or text-based.

**Why it wasn't found.** Recon was stopped early: the automation tooling began returning
`[BLOCKED: Cookie/query string data]` on ordinary DOM reads — the same blocker §3 ran into — and
repeating it was not worth the bot-detection risk. Nothing about the page was inspected.

**Next step.** From `/austin-tx/homes-for-rent/`, open one card's detail page and look for
(a) a `/mo` suffix on a rendered price element — note `#price` itself is the *clean* subject price,
so check its siblings and any period label, and (b) a status or listing-type element analogous to
Redfin's `.stat-block.price-section`. Prefer structure over text if both exist, and add the
fragility note to §7 either way. A `compFacts`-style unit test with transcribed markup is enough;
the adapter's suite already has the fixture helpers.

### 8b. OPEN — comps from a Homes.com house open a *Redfin* search

**Symptom, two separate causes.**

1. **`buildCompUrl` guesses.** Its last line (`public/scripts/comp-links.js`, ~line 62) is
   `return buildRedfinUrl(...)` for anything that isn't `'zillow'` — so a Homes.com subject opens
   a Redfin comp search, and any comp clipped there is stored against the Homes.com house. The
   honest behaviour for an unknown source is `null`, which the callers already handle as "no comp
   search available". That one-line change is worth making independently of anything below.
2. **There is no `buildHomesUrl`.** It needs a design decision first, because Homes.com's search
   grammar cannot express what the other two do.

**Measured grammar.** No zip-scoped paths exist at all: `/78745/`, `/78745/sold/`,
`/78745/apartments-for-rent/` and every variant tried returned **404**. Searches are city-slug
scoped — `/austin-tx/sold/`, `/austin-tx/homes-for-rent/`. Beds work as an exact filter
(`/austin-tx/sold/3-bedroom/` returned 40 cards, all exactly 3 beds). **Baths have no path
form**: `/austin-tx/sold/3-bedroom-2-bathroom/` redirected to `/austin-tx/sold/2-to-3-bedroom/`,
silently dropping baths *and* widening beds into a range.

**The decision.** Homes.com comps would therefore be **city-scoped and beds-only**, where Redfin
and Zillow are zip-scoped with a bath minimum ("same beds, ≥ baths", comp-workflow.md §2). A
city-wide Austin sold search returned a property in 78744 while the subject was in 78745, so this
is a real quality difference, not a technicality. Either accept it with the weakening documented
on the session banner, or have Homes.com opt out of comps until a zip-capable query is found.
`buildCompUrl`'s signature needs no change either way — the city and state are already in the
`address` string it receives, so a `citySlug(address)` helper is all the derivation it takes.

### 8c. UNTESTED — Homes.com has never run as a built extension

- **The full pipeline.** The adapter was verified two ways — evaluated in a live page against the
  real DOM, and in jsdom against fixtures transcribed from live measurements — but capture →
  service worker → `chrome.storage.local` → panel render has never been exercised for a
  Homes.com house. Loading unpacked needs the native file-picker dialog, which the automation
  cannot drive.
- **Comp mode on Homes.com, at all.** Blocked by 8b: with no URL builder there is no session to
  start. `compFacts` is unit-tested against transcribed sold-card markup and nothing more.
- **Listing states not looked at.** For-sale, condo, new-build and multi-family detail pages were
  checked. Rentals, land, off-market and "coming soon" were not — and coming-soon is exactly the
  state that turned out to have no action bar at all on Redfin.

### 8d. BY DESIGN — Homes.com specifics that are not bugs

- **Sold cards show a last list price, and say so.** Like Redfin and unlike Zillow, Homes.com
  stays usable for sold comps in non-disclosure states: the card reads `"$341,990 Last List
  Price"` with the label in its own `.last-list-price-label` span, which `compFacts` reports as
  `priceLabel` and maps onto `amountLabel: 'last-list'`. Compare §6's Zillow `"$--"` entry.
- **Cards carry no geo or HOA**, so a card-captured Homes.com house has no coordinates — the same
  on all three sites, and the panel already surfaces it as a missing rent estimate.
- **Condo sqft is often genuinely absent** (7 of 40 cards on a Chicago condo search rendered
  `"1 Bed 1 Bath"` with no sqft). Nothing to fix; it degrades to a missing field.
- **The adapter owns its own property-id rule** rather than adding one to `parsers.js`, so adding
  the site touched no file the other two adapters share. Deliberate, given both branches were in
  flight at once.

### 8e. Fragility worth knowing about

Belongs with §7; kept here so all Homes.com material sits together.

- **There is no `data-testid` contract.** Class names are the only handhold — the same footing
  Redfin is on, better than Zillow's hashed names. The `data-v-*` attributes are Vue
  scoped-style markers that change per build: never key off them.
- **A detail page embeds up to nine similar and sold cards using the identical results-card
  markup.** So `.price-container` on a detail page is a *different property* (measured: $399,900
  against a subject's $615,000, and `"$180,000 Sold Feb 27, 2026"` on another), and
  `.detailed-info-container` likewise (measured: `"2 Beds 2 Baths 1,000 Sq Ft"` for a 420 sqft
  studio). The subject's price is `#price` and its facts are in `.ldp-property-info-container`,
  which does not contain that selector at all. Three tests pin exactly these; do not "simplify"
  the detail extractor to reuse the card selectors.
- **`cardPriceText` strips label children before reading the price.** Without it the sold card's
  `"$341,990 Last List Price"` reaches `parseMoney`, which requires entirely-numeric text and so
  returns null — every sold capture became a house with no price. The selector is
  `span[class*="label"]`, so a renamed label still gets caught, but a label class without
  "label" in it would silently poison the price again.
- **`propertyIdIsUsable` is now the only id gate.** A fourth hand-rolled `/^\d+$/` anywhere in
  the capture or comp path silently re-breaks Homes.com and nothing else — which is how 8's
  original three-copy version presented.
- **`ld+json` is the richest source of the three sites but wrong in three specific ways**, each
  with a test: it drops half-baths (`2` where the listing renders `2.5`), `offers` is sometimes
  absent entirely (a Cleveland multi-family), and `name` is sometimes street-only with no city or
  ZIP. Baths come from the DOM and the address prefers whichever candidate carries state + ZIP.
- **`"Shoal Creek"` contains a case-insensitive `"hoa"`**, and it is a real Austin street. The
  anchored `parseHoa` resists it and there is a test naming it; a loosened HOA pattern would
  report a fee on every listing on that road.
