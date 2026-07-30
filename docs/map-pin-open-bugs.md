# Map pins — handover, end of build session

_Written 2026-07-29, immediately after building the "show houses on the map" feature
described in [map-linking.md](./map-linking.md) (Option 3: inject our own pins rather
than recolor the site's). Session ended on an unresolved discrepancy before it could be
run down. Read this before assuming the feature is broken or trying to rebuild it._

**Everything below is uncommitted.** No commit was made this session — `git status` /
`git diff` on `main` is the full and exact scope of what changed. Nothing to lose track
of, but don't assume any of this is "in main" until it's actually committed.

## What's built

A "Show on map" toggle in the side panel that puts a small purple pin
(`.sidecar-MapPin`, `data-sidecar-pin="1"`) on Redfin's or Zillow's own map for every
saved house with real coordinates — regardless of which site captured it. Off-viewport
houses simply get no pin (never a forced pan/zoom, deliberately, per map-linking.md's
anti-bot posture); a "N of M shown on this map" indicator in the panel makes that
legible instead of silent. Clicking a pin is meant to scroll to and highlight the
matching card in the panel. Homes.com is deliberately untouched — out of scope for v1.

Files touched:
- `public/scripts/sites/geo-projection.js` — new, pure affine web-mercator projection
  fit from two `(lat, lon, screen-x, screen-y)` points. Fully unit tested
  (`test/geo-projection.test.ts`), no DOM dependency.
- `public/scripts/sites/redfin.js` — `mapPinContainer()`, `buildMapProjection()`,
  `projectPoint()`. Redfin needs no calibration: every native pin carries its own
  lat/lon *and* its own `left`/`top`, so the projection self-fits from any two on-screen
  pins.
- `public/scripts/sites/zillow.js` — same three methods, but `buildMapProjection()`
  calibrates via two synthetic hover events on rendered result cards (reads which
  marker gains `.is-hovered` and where it lands), capped at exactly two probes per
  calibration per map-linking.md §5's bot-protection guidance. Also fixed
  `extractFromCard()`, which previously hardcoded `latitude: null, longitude: null`
  unconditionally — it now reads `__NEXT_DATA__...searchPageState.cat1.searchResults.
  listResults`, matched by zpid (this was map-linking.md's Phase 0 blocker).
- `public/scripts/content.js` — the reconciliation driver: reads a `showHousesOnMap`
  storage flag and the full `storedHouses` list directly (reactive via
  `chrome.storage.onChanged`, same pattern as `compSession`), projects every candidate
  house, keeps only those landing inside the map container's own visible rect, and
  diffs the injected-pin set against that (add/move/remove). A debounced
  `MutationObserver` on the map container re-triggers reconciliation on pan/zoom. A
  capture-phase click/keydown interceptor on `[data-sidecar-pin="1"]` sends
  `mapPinClicked` to the background worker.
- `public/scripts/background.js` — relays `mapPinClicked` → `highlightHouse` and
  `mapPinStatus` → same-named broadcast to the panel. Both fire-and-forget, no test
  coverage (background.js has no direct test file in this repo at all, consistent with
  its existing untested handlers like `addComp`/`startCompSession`).
- `src/App.tsx` — toggle button, `highlightedHouseKey` state (set by `highlightHouse`,
  clears itself after 3s), `mapStatus` state feeding the "N of M" indicator,
  `HouseCard` grows a `highlighted` prop that rings the card and calls
  `scrollIntoView()`. Also fixed `House.latitude`/`longitude`'s type from `number` to
  `number | null` — it always could be null at runtime (Zillow cards), the type just
  lied.

Test/build state as of session end: 663 vitest tests pass (≈30 new: projection math,
Zillow geo lookup, Redfin/Zillow calibration, content.js reconciliation + click
wiring), `tsc -b` clean, `npm run build` clean, `dist/` was rebuilt and is current.

## OPEN — user reports not seeing the pin; I confirmed it rendering correctly

**What I confirmed, live, via the Chrome browser tool** (not the user's own eyes): on
`https://www.redfin.com/city/30818/TX/Austin`, with the panel's "Show on map" toggled
on and one house captured (`1204 W 39th St, Austin, TX 78756`, key
`redfin:31429059`), a pin appeared:

- `document.querySelectorAll('[data-sidecar-pin="1"]').length` → `1`
- `getComputedStyle` on it: `backgroundColor: rgb(109, 40, 217)` (exactly `#6D28D9`,
  the CSS I wrote), `position: absolute`
- `getBoundingClientRect()` → `{ left: 1191.3, top: 492.6, width: 17.3, height: 17.3 }`
  — well inside the map pane's own bounds (roughly x:885–1357, y:88–650 on that page)
- A zoomed screenshot of that exact region **visibly shows the purple dot**, sitting
  right next to Redfin's own price bubbles ("369K", "1.25M").

Note the pin's own inline `style.left`/`style.top` (`12.78px`, `8.6px`) do **not**
match the rendered `getBoundingClientRect()` position — this is expected, not a bug:
Redfin's map pane applies a CSS `transform` to an ancestor of `.HomeMarkersContainer`
for panning, and our pin uses the exact same `left`/`top` coordinate space as Redfin's
own native pins (that's the whole point of fitting the projection off their own
`style.left`/`top` values), so it inherits the same transform consistently. Don't
"fix" this apparent mismatch — it's how the two coordinate systems relate.

**What the user reported:** looking at (they said) the same tab, at the same time,
they did not see it.

**Not yet resolved — three live hypotheses, in likely order:**
1. **Visual, not functional.** A 14–18px dot among ~330 dense native pins at normal
   zoom/viewing size may just be easy to miss without zooming in the way the screenshot
   tool did. Cheapest thing to check first.
2. **Window/tab mismatch.** Chrome side panels are not addressable as a "tab" by the
   browser-automation tooling used this session, so I could never directly inspect or
   click the actual panel UI — only infer its effects via DOM queries on the page tab.
   It's possible the user was looking at the panel attached to a *different* browser
   window than the one being automated, despite confirming otherwise once
   ("no im there i see you").
3. **A real rendering discrepancy**, not yet understood — e.g. something environment-
   specific to the user's actual Chrome (extensions, zoom level, display scaling) that
   doesn't reproduce in the automated session.

**Next step.** Re-verify live with the user watching the *literal* tab the automation
drives (confirm the URL bar matches on their screen, not just "I see the page"), ask
them to zoom their own browser on the map first before concluding it's absent, and if
still not visible, have them open the *panel's own* devtools (right-click inside the
panel → Inspect, not the page's devtools) and run
`document.querySelectorAll('[data-sidecar-pin="1"]').length` from there — or better,
`window.__investorSidecarLogView()` **from the content script's own console context**
(select the "Investor Sidecar" / content-script frame in the devtools console context
dropdown, not "top" — plain page-console execution can't see it, since content scripts
run in an isolated JS world; this was a red herring chased partway through this
session before realizing the tool's JS execution runs in the page's main world, not
the isolated one).

If a DOM query confirms the pin exists but it's still not visible on screen, the next
suspect is a stacking-context / z-index issue specific to how the real page composites
map tiles vs. how the automated session's screenshot captured it — not the injection
logic, which is unit-tested and was confirmed working end-to-end against live markup.

## Not yet done regardless of the above

- **Click-to-highlight was never verified live**, in either the automated session or
  by the user — only the pin-placement half was confirmed. The panel-side code
  (`highlightHouse` listener, `highlighted` prop, scroll-into-view) is new and has no
  live confirmation at all.
- **Zillow's map pin path has zero live verification.** Everything confirmed above was
  Redfin only. Zillow's hover-probe calibration (`.zillow-map-layer`, `.is-hovered`)
  is built entirely from docs/map-linking.md's prior recon and has not been re-checked
  against the live site in this session.
- **Homes.com** is untouched by design — `buildMapProjection` doesn't exist on that
  adapter, so the feature no-ops there. Confirmed via unit test only.
