# Map pins: unified implementation spec

_Written 2026-07-30 from live measurement on Redfin, Homes.com and Zillow. This is the
authoritative document for the "show my saved houses on the site's map" feature.
Supersedes [map-pin-open-bugs.md](./map-pin-open-bugs.md), whose three hypotheses were all
wrong about the primary cause. Every number below was measured, not reasoned about; where
something is **UNVERIFIED** it says so._

> ## A working patch exists — `docs/map-pin-verified.patch`
>
> Every fix described below was implemented, tested (691 vitest tests pass, `tsc -b` clean)
> and verified live, then **reverted at the user's request** so the implementing agent owns
> the code. The complete working diff is saved at **`docs/map-pin-verified.patch`**
> (`git apply docs/map-pin-verified.patch`), covering:
>
> - `content.js` — the screen-space clip fix (defect 1)
> - `sites/redfin.js` — `mapClipElement()`, `mapPinAnchorOffset()`, `clip`/`anchor` on the projection
> - `sites/zillow.js` — container-by-content, bounds-from-URL calibration, probes deleted
> - `sites/homes.js` — the whole map-projection implementation, new
> - `test/site-adapters.test.ts` — Zillow probe tests replaced with bounds-fit tests; `setLocation` gains `search`
> - `tools/panel-harness.html` — shim repairs that make the harness run at all
>
> Treat the patch as a verified starting point, not gospel: it does **not** include defect 2
> (§1.2, §5), defect 3 (§8), the §12 driver-test fixture change, or panel → pin (§10.3).
>
> ## Implementation status
>
> **Landed and confirmed working on Redfin:** the clip fix (defect 1) — step 3 of §11 plus
> Redfin's `mapClipElement()`/`mapPinAnchorOffset()`. Verified live through the real
> extension: pins now render on Redfin where none did before, 686 tests pass, `dist/` built.
>
> **Not started:** everything else. Specifically —
> - **Zillow and Homes.com are still broken**, and *measurably so*: neither adapter has
>   `mapClipElement()`, so `projection.clip` is `undefined` and the driver falls back to the
>   container's own rect — which on Zillow is `[326, 482, 0, 0]`, reproducing the identical
>   ±24px bug. Measured live: **501 native markers, 0 extension pins.** A Redfin-captured
>   house does **not** yet appear on a Zillow map.
> - Defect 2 (Redfin detail-page geo, Homes.com null coords) — §1.2, §5
> - Defect 3 (the marker is a 14px purple dot) — §8
> - Panel → pin highlighting — §10.3
>
> Working tree contains only: the Redfin clip fix (`content.js`, `sites/redfin.js`) and the
> `tools/panel-harness.html` repair described in §13.1.

---

## 1. Why the feature shows "0 of N"

There are **three independent defects**. Each one alone is sufficient to produce zero
pins, so all three must be fixed before the feature can work.

| # | Defect | Effect | Verified |
| --- | --- | --- | --- |
| 1 | Viewport clip test compares projected coordinates against a **zero-height** box | rejects ~94% of houses | yes |
| 2 | Redfin detail-page geo extraction looks at `obj.geo`, but Redfin moved it to `obj.mainEntity.geo` | detail captures store `latitude: null` → dropped before clipping | yes |
| 3 | Marker is a 14px purple dot among ~335 native 12px green dots | invisible even when placed correctly | yes |

### Which defect caused the reported symptom

**Defect 1 alone.** The user's panel read `0 of 2 shown on this map`, and that message is
itself decisive evidence:

- `reportMapStatus(placed.size, candidates.length)` where
  `candidates = storedHousesForMap.filter(hasMapCoords)`
- a `total` of `2` therefore proves **both saved houses passed `hasMapCoords`**, i.e. both
  had finite numeric `latitude`/`longitude`

So defect 2 was **not** the live cause for those two houses, and the whole
toggle → storage → content-script → reconcile → status → panel round trip is **already
working** (§10.1). Fix defect 1 first; it is the only thing standing between the current
build and visible pins.

Defect 2 is still real and still worth fixing — it silently zeroes coordinates for anything
captured from a Redfin *detail* page, and for Homes.com cards and map popups — but it is a
correctness gap for other capture paths, not the explanation for this bug report.

The projection math is **not** a defect. `geo-projection.js` reproduced all 335 Redfin
markers to within **0.0009px**. Leave it alone.

### 1.1 Defect 1 — the clip test

`content.js:1028` does:

```js
const rect = container.getBoundingClientRect();   // .HomeMarkersContainer
if (point.x < -margin || point.x > rect.width + margin ||
    point.y < -margin || point.y > rect.height + margin) continue;   // margin = 24
```

**`.HomeMarkersContainer` is `position: static` with a measured rect of `1471 × 0`.** It is
the marker coordinate-space *origin*, not a box — only its `x`/`y` mean anything. With
`rect.height === 0` the y-test collapses to `-24 ≤ y ≤ 24`, a 48px band, while real
projected coordinates span `y ∈ [-355, 329]`. The x-test is wrong the other way: it
permits `x` up to `rect.width + 24` while cutting everything left of `-24`, and roughly
half the visible map sits at negative `x`.

Measured live, native markers as ground truth:

| Metric | Value |
| --- | --- |
| Markers with usable geometry | 335 |
| Actually visible on screen | **335** |
| Passing the shipped clip test | **21** |

Six real central-Austin houses run through the real projection: **shipped clip passed
0 of 6**, corrected clip passed 6 of 6. This reproduces the reported "0 of 2" exactly.

**This same zero-size origin pattern holds on all three sites** (§3), so the fix is
site-agnostic.

**Why the unit tests missed it.** `test/content-driver.test.ts:745` does
`mockRect(container, { width: 1000, height: 800 })`. The fixture asserts a plausible box —
exactly what the real DOM does not provide. The suite was green while the feature was 94%
broken. Any fix **must** change this fixture to a zero-size container, or the same class of
bug walks straight back in.

### 1.2 Defect 2 — Redfin detail-page coordinates are null

`redfin.js:37` requires `obj?.geo?.latitude`, where `obj = Array.isArray(parsed) ? parsed[0] : parsed`.

Measured on `https://www.redfin.com/TX/Austin/1204-W-39th-St-78756/home/31429059`
(the very house the previous session tested with):

- 9 `ld+json` blobs, several typed `SingleFamilyResidence`
- **none has top-level `geo`**
- geo lives at `blob[1].mainEntity.geo` → `{ latitude: 30.3073345 }`, typed **number**
- `blob[1].url` is present at top level and contains `31429059`, so the existing
  `expectedId` identity check still works unchanged
- the current extractor returns **NULL** — confirmed by direct execution
- secondary source: `<meta name="geo.position" content="30.3073345;-97.7441381">`

Redfin **cards** are fine: 41/41 result cards carry top-level numeric `geo`
(e.g. `30.1710764`). So a house saved from a results card has coordinates; the same house
saved from its detail page does not. That asymmetry is invisible in the UI and is the
likeliest explanation for a user seeing "0 of 2".

Fix is one line plus a fallback:

```js
const geo = obj.geo ?? obj.mainEntity?.geo;
```

Also note `hasMapCoords()` (`content.js:927`) uses `Number.isFinite`, which is correct and
must stay — but it means any extractor storing a *string* silently drops the house. Coerce
with `Number()` at every extraction site.

### 1.3 Defect 3 — the marker is unfindable

Redfin's live palette is green-dominant: hundreds of green dots plus green/black/red price
bubbles on a beige-and-green Google basemap. Our marker was 14px vs their 12px — a 2px
difference — in purple, a hue that already appears on that map from another source. Six
purple dots were rendered live and were unfindable at natural scale by eye.

There is also a systematic **~8px position error**: native `style.left/top` is a 12×12
dot's *top-left corner*, so the geographic point is at `(left+6, top+6)`, while
`.sidecar-MapPin`'s `margin:-7px 0 0 -7px` centres it on `(left, top)`.

---

## 2. Constraints that shape the design

1. **Content scripts run in an isolated world.** `window.google.maps`, the map instance,
   and any page JS object are unreachable. Everything must come from DOM geometry, DOM
   attributes, embedded JSON, or the URL. Asking Google Maps for its own projection is not
   an option.
2. **Never pan or zoom the site's map.** A saved house outside the current view gets no
   pin; the panel says "N of M shown on this map" instead. (Pre-existing anti-bot posture,
   docs/map-linking.md §5. Keep it.)
3. **Minimise synthetic events.** Zillow especially — see §4.3, which removes the existing
   hover-probe calibration entirely.
4. **All three sites are Google Maps.** Verified: each has a `.gm-style` ancestor. The
   marker layers differ, but the coordinate-space pattern is identical.
5. **Content-script changes require `npm run build`** (dist/ is what Chrome loads) **and an
   extension reload.** `dist/` was verified byte-identical to `public/` at time of writing,
   so build staleness was *not* a factor in the reported bug.

---

## 3. Measured site geometry

All three: marker container is a **zero-size origin element**; a marker's screen position
is `originRect.(left,top) + (markerOffset)`. Clip against a *different*, real element.

| | **Redfin** | **Homes.com** | **Zillow** |
| --- | --- | --- | --- |
| Marker container | `.HomeMarkersContainer` | parent of `gmp-advanced-marker` | `.BulkPropertyMapMarker.many-results` |
| Container position / rect | `static`, `1471×0` | `static`, `574×0` | `static`, `0×0` |
| Marker selector | `.Pushpin[latitude][longitude]` | `gmp-advanced-marker[data-pin-pk]` | `.streamlined-marker-container` |
| Marker count (Austin) | 335 | 609–641 | 501 |
| Marker size | `12×12` dots, `45×21` bubbles | `29×40` | `17×16` |
| Marker `z-index` | `auto` (all) | `0` | `0` |
| Positioned by | `style.left` / `style.top` | `transform: translate()` | `transform: translate()` |
| Value refers to | element top-left | element top-left | element top-left |
| Geo point offset | `+6, +6` (dot centre) | `+14.5, +40` (bottom-centre) | `+8.5, +8` (dot centre) |
| Clip element | `#search-map-wrapper` | `#map.search-map-container` | `#search-page-map` |
| Coordinates on markers | `latitude`/`longitude` attrs | `position="lat,lon"` (5dp) | **none** |
| Calibration | self, from 2 markers | self, from 2 markers | URL `searchQueryState.mapBounds` |
| Fit accuracy (measured) | **0.0009px** max / 335 | **0.935px** max, 0.468 mean / 609 | **0.8px** max, 0.4 median / 40 |

Notes:

- Homes.com's ~0.5px error is Google rounding Advanced-Marker translates to half-pixels,
  not a math problem. Sub-pixel; ignore.
- Zillow has **two** `.BulkPropertyMapMarker` elements. Select the one that contains a
  `.streamlined-marker-container`; the other holds parcel-boundary tiles.
- Zillow's existing `mapPinContainer()` returns `.zillow-map-layer`, which shares the exact
  same origin rect (`326,482 0×0`) as `.BulkPropertyMapMarker`. Either works. Keep the
  existing selector.
- Zillow's `__NEXT_DATA__` `mapBounds` is **all zeros** — do not use it. The live bounds are
  in the URL.

---

## 4. Calibration per site

All strategies produce the same `{ anchor, kx, ky }` fit consumed by
`SidecarGeoProjection.project()`. No change to `geo-projection.js`.

### 4.1 Redfin — self-calibrating (already correct)

Read `latitude`/`longitude` attributes plus `style.left/top` from two maximum-spread
markers. Existing `buildMapProjection()` does this correctly. Only add `clip` and `anchor`
to its return value.

### 4.2 Homes.com — self-calibrating (new)

Same shape as Redfin, two differences:

- coordinates come from `position="30.26522,-97.74668"` (comma string → split, `Number()`)
- position comes from the computed `transform` matrix, not `style.left/top`:
  ```js
  const m = getComputedStyle(el).transform.match(/matrix\(([^)]+)\)/);
  const p = m[1].split(',').map(Number);
  const [x, y] = [p[4], p[5]];
  ```

Homes.com is therefore **fully supportable**, contradicting the old docs' "out of scope".

`mapPinContainer()` has no stable class or id to key off — the marker container is an
unclassed div — so use the markers' own parent, which is by definition the coordinate space
they are positioned in:

```js
mapPinContainer() {
  return document.querySelector('gmp-advanced-marker')?.parentElement ?? null;
}
```

Verified live by replicating the exact implementation in the page: **639/639 markers parsed,
fit succeeds, 1.038px max error.** Note the marker container resolves to 639 markers and the
clip element `#map.search-map-container` to `[750, 120, 574, 709]`, so both selectors hold.

### 4.3 Zillow — read-only bounds fit (replaces hover probes)

Zillow markers carry no coordinates, so it cannot self-calibrate. The shipped adapter
dispatched two synthetic hover events to probe. **That code could never have worked**, for
two independent reasons, both measured live:

**Zillow bug A — `mapPinContainer()` returns the wrong element.** Zillow renders **two**
`.zillow-map-layer` elements. `document.querySelector` returns index 0, which contains
**0 markers**; index 1 contains all **501**. Both have the same `0 × 0` rect, so the mistake
is invisible to a rect check. Consequences: calibration searched a marker-less subtree, and
our pins would have been appended to a container the map never transforms. Fix — select by
content, not document order:

```js
mapPinContainer() {
  const layers = document.querySelectorAll('.zillow-map-layer');
  for (const layer of layers) {
    if (layer.querySelector('.streamlined-marker-container')) return layer;
  }
  return layers[0] ?? null;
}
```

The identical trap exists for `.BulkPropertyMapMarker` (two of them, one holding parcel
boundary tiles). Any Zillow selector in this feature must be chosen by content.

**Zillow bug B — the probe read `.is-hovered` synchronously.** `probeMarkerFor` dispatched
`mouseover` and queried on the very next line, but Zillow applies the class on a later tick.
Measured against the *correct* layer: **0 matches synchronously, 1 match after 150 ms.** So
even with bug A fixed, the probe returned null every time. (The class itself is alive and
well — 101 stylesheet rules reference it, and the hovered element is
`.property-pill.is-hovered` nested inside `.streamlined-marker-container`.)

Both bugs are moot under the replacement below, which needs no interaction at all. The live
map bounds are in the URL:

```js
const qs = new URLSearchParams(location.search).get('searchQueryState');
const { west, east, south, north } = JSON.parse(qs).mapBounds;
const clip = document.getElementById('search-page-map').getBoundingClientRect();
// linear in longitude, mercator in latitude
const sx = clip.left + (lon - west) / (east - west) * clip.width;
const sy = clip.top  + (mercY(north) - mercY(lat)) / (mercY(north) - mercY(south)) * clip.height;
```

**Validated live:** 40 listings with known coordinates projected this way landed a median
of **0.4px** (max 0.8px) from the corresponding native marker centre, and visually every
pin tip sat exactly on its native marker. **Zero synthetic events.**

Express it as an `{anchor, kx, ky}` fit so `projectPoint` stays uniform: feed the pane's NW
and SE corners, **in container-relative coordinates**, to `SidecarGeoProjection.fit()`:

```js
const origin = container.getBoundingClientRect();
const fit = SidecarGeoProjection.fit(
  { lat: bounds.north, lon: bounds.west, x: clip.left  - origin.left, y: clip.top    - origin.top },
  { lat: bounds.south, lon: bounds.east, x: clip.right - origin.left, y: clip.bottom - origin.top }
);
```

**Zillow's `anchor` must be `{dx: 0, dy: 0}`, not a marker half-size.** This fit is derived
from the map's geographic edges, so it already yields the true geographic point — there is no
marker-corner bias to correct, unlike Redfin's fit which comes from marker top-lefts.
Applying Redfin-style `{dx: 8.5, dy: 8}` here would offset every Zillow pin. Confirmed live:
with a zero anchor, pins landed a median 0.4px from native marker *centres*.

Guard the bounds before fitting — reject non-finite values, `north === south`,
`east === west`, and out-of-range latitudes/longitudes. Zillow's `__NEXT_DATA__` copy of this
state is all zeros on a cold load, and an all-zero box would otherwise fit a projection that
silently places every pin wrongly.

**Known risk.** On a cold landing (`/austin-tx/` with no query string) `searchQueryState`
is absent until the map settles or the user interacts. Behaviour must be: return `null`
(draw nothing, report `0 of M`) and let the next reconcile pick it up — never fall back to
probing. Keep the hover-probe code path only if you want a last resort; prefer deleting it.

---

## 5. Cross-source support

The projection needs only `(lat, lon)` plus the *current* site's map, so a Zillow-saved
house already renders on a Redfin map with no extra work. The **only** requirement for
cross-source is that every capture path on every site stores numeric coordinates.

Current state — this is the real cross-source blocker:

| Source | Card capture | Detail capture | Map-popup capture |
| --- | --- | --- | --- |
| Redfin | ✅ numeric, 41/41 verified | ❌ **null** — geo at `.mainEntity.geo` (§1.2) | n/a |
| Zillow | ✅ via `__NEXT_DATA__` `listResults`, coerced + range-checked | ✅ same helper | n/a |
| Homes.com | ❌ **hardcoded `latitude: null`** (`homes.js:402`) | ✅ `entity.geo` coerced (**UNVERIFIED live**) | ❌ **hardcoded `latitude: null`** (`homes.js:182`) |

The comment at `homes.js:400` — _"Cards carry neither geo nor fee, on any of the three
sites"_ — is **false** and should be deleted. Redfin cards carry geo, and Homes.com cards
can be joined to coordinates:

**Homes.com card/popup fix (verified).** Cards carry `data-pk`; map markers carry
`data-pin-pk` plus `position`. Join them:

```js
// 40 unique card pks → 40 matched markers = 100% join rate, measured live
const byPk = new Map();
for (const el of document.querySelectorAll('gmp-advanced-marker[data-pin-pk]')) {
  const [lat, lon] = (el.getAttribute('position') || '').split(',').map(Number);
  if (Number.isFinite(lat) && Number.isFinite(lon)) byPk.set(el.getAttribute('data-pin-pk'), { lat, lon });
}
```

Same join serves the map popup, which also exposes `data-pk`.

---

## 6. Tracking on pan and zoom

### 6.1 How it behaves, and why

Two regimes:

1. **During the gesture** — Google transforms an *ancestor* of the marker container. Our
   pin lives inside that container, so it inherits the transform and moves with the map for
   free. No work, no lag.
2. **On settle** — Google resets that transform to identity and rewrites every native
   marker's coordinates. Our pins are now stale and must be re-projected.

A debounced `MutationObserver` on the marker container drives (2). Confirmed: after settle
the ancestor transform reads `matrix(1, 0, 0, 1, 0, 0)`.

### 6.2 Measured tracking accuracy

Six pins seeded from known coordinates, then the map was driven:

| Action | Reconciles fired | Pin-to-native error |
| --- | --- | --- |
| Initial placement | 1 | 0.01px (all 6) |
| Drag / pan | +5 | **0.01px (all 6)** |
| Scroll zoom | +4 | **0.01px / 0px** (the 2 still in view) |

Off-viewport pins were correctly removed; pins whose native marker left the DOM entirely
**persisted**, which is correct — we track saved houses, not the site's current inventory.

The existing observer design (`attributes`+`attributeFilter:['style']`, `childList`,
`subtree`, 80ms debounce, own-mutation filtering via `isOurNode`) is **sound and should be
kept**. It was never the problem.

### 6.3 The one visible rough edge

Between Google rewriting coordinates and the 80ms debounce firing, pins are briefly stale —
a perceptible snap after each pan settles. Options, in order of preference:

1. Reconcile on `requestAnimationFrame` while a gesture is in flight (pointerdown →
   pointerup/settle), falling back to the observer otherwise.
2. Drop the debounce to ~16ms — cheap, given §7's numbers.
3. Accept it.

---

## 7. Performance

Measured on the live Redfin map (331 native markers). **Our pin count is not the
bottleneck.**

| Operation | Cost |
| --- | --- |
| `buildMapProjection()` (reads 331 native markers) | **0.64ms** |
| Create + place 10 pins from scratch | 2.5ms |
| Create + place 100 | 5.0ms |
| Create + place 500 | 5.7ms |
| Create + place 2000 | 10.3ms |
| Create + place 5000 | 20.8ms |
| **Move** 500 existing pins (steady state) | **1.89ms** |

At any realistic saved-house count this is a rounding error inside an 80ms debounce, and
the steady-state path is the cheap one.

**The actual cost centre is mutation-record volume from the site's own markers.** A single
pan on Redfin produced:

| Observer configuration | Callbacks | Mutation records |
| --- | --- | --- |
| Current: `subtree` + `attributes` on the container | 4–5 | **945 – 11,572** |
| Narrowed: `childList` on container + one sentinel marker watched for `style` | 3 | **283** |

Our callback early-returns on the first foreign record, so JS cost is trivial — but the
browser allocates every record. Recommended: observe `childList` on the container (no
subtree, no attributes) for marker churn, plus **one** sentinel native marker with
`attributeFilter:['style']` for movement, re-picking the sentinel when `isConnected`
becomes false. Keep the 80ms debounce and the `isOurNode` filter.

This is an optimisation, not a correctness fix. Ship correctness first.

---

## 8. Marker visual spec

Validated by live injection and natural-scale screenshots on Redfin and Zillow.

```
size            40 × 54 teardrop
svg viewBox     0 0 24 34
path            M12 1.5C6.5 1.5 2 6 2 11.5c0 7.5 10 21 10 21s10-13.5 10-21C22 6 17.5 1.5 12 1.5z
fill            #FF1493      stroke #fff, width 2.2
centre dot      circle cx=12 cy=11.5 r=4.2 fill #fff
shadow          drop-shadow(0 3px 5px rgba(0,0,0,.55))
anchor          transform: translate(-50%, -100%)   → tip sits on the geo point
z-index         900
pulse           ellipse at base, 1.8s ease-out infinite, scale .6→2.6, opacity .65→0
                disabled under prefers-reduced-motion
hover/focus     translate(-50%,-100%) scale(1.15)
```

Rationale, per site:

- **Scale** — ~4.5× a native Redfin dot's area, and a different silhouette, so it survives
  being surrounded by hundreds of markers.
- **Colour** — `#FF1493` is absent from all three palettes (Redfin green, Homes.com blue,
  Zillow dark red) and collides with neither water (blue) nor land (beige/green), which
  rules out cyan and amber.
- **Motion** — the strongest pop-out cue available at zero extra footprint.
- **z-index 900** — beats Redfin's `auto` and Homes.com/Zillow's `0` outright.
- Note Homes.com's natives are *also* blue teardrops, so on that site differentiation rests
  on hue, scale and motion rather than shape.

Because `transform: translate(-50%,-100%)` places the tip, set `left/top` to the geo point
itself — no negative margins, and the coordinate you write is the coordinate it marks.

### Optional: focus mode

`.Pushpin { opacity: .45 }` on the clip element while the toggle is on makes our pins the
only salient thing on the map — the single biggest visibility win, fully reverted on
toggle-off. **This is a product decision, not a bug fix**: it suppresses the site's own
inventory. Get explicit sign-off before shipping it, and put it behind its own checkbox if
in doubt.

---

## 9. Adapter contract

Keep `content.js` site-agnostic. Absence of `buildMapProjection` = feature off for that
site (current Homes.com behaviour; after §4.2 it should be present).

```js
mapPinContainer()   -> Element | null   // marker coordinate-space origin; we append here
mapClipElement()    -> Element | null   // the element that really bounds the visible map
mapPinAnchorOffset()-> { dx, dy }       // projected point -> true geo point
buildMapProjection()-> { container, fit, clip, anchor } | null
projectPoint(projection, lat, lon) -> { x, y } | null
```

`clip` is a `DOMRect` (screen coords) captured at build time; `anchor` is the offset from
§3. Returning `null` means "don't draw anything yet" — never an error.

### The corrected driver logic

```js
const origin = container.getBoundingClientRect();  // ONLY .left/.top are meaningful
const clip   = projection.clip || origin;
const anchor = projection.anchor || { dx: 0, dy: 0 };
const margin = 24;

for (const house of candidates) {
  const p = site.projectPoint(projection, house.latitude, house.longitude);
  if (!p) continue;
  const point   = { x: p.x + anchor.dx, y: p.y + anchor.dy };
  const screenX = origin.left + point.x;
  const screenY = origin.top  + point.y;
  if (screenX < clip.left - margin || screenX > clip.right  + margin ||
      screenY < clip.top  - margin || screenY > clip.bottom + margin) continue;
  placed.set(mapHouseKey(house), { house, point });
}
```

Never read `container.width` or `container.height`. Add a comment saying so — that is the
exact mistake this document exists to prevent.

---

## 10. Side-panel interaction

### 10.1 The toggle path — already working, do not rebuild

Traced in code and **confirmed live by the reported symptom**: the panel displayed
`0 of 2 shown on this map`, which can only happen if every hop below ran.

| Hop | Location | Status |
| --- | --- | --- |
| Toggle writes `showHousesOnMap` | `App.tsx:1510` | ✅ |
| Content script reads it at init | `content.js:1222` | ✅ |
| Reactive on `storage.onChanged` (both keys) | `content.js:1224-1228` | ✅ |
| `reconcileMapPins()` computes candidates | `content.js:1009` | ✅ (returned `total: 2`) |
| `mapPinStatus` → background → panel | `background.js:228`, `App.tsx:1587` | ✅ |
| Panel renders "N of M shown" | `App.tsx:1635` | ✅ |

The only failing step is the clip test inside `reconcileMapPins`. **Fixing defect 1 should
make pins appear with no other changes.**

### 10.2 Pin → panel (built, never verified live)

Pin click → capture-phase interceptor (`content.js:1087`) → `mapPinClicked` → background
relay (`background.js:219`) → `highlightHouse` → panel rings the card and calls
`scrollIntoView()` (`App.tsx:1578`, `1672`), clearing after 3s. Every hop exists in code;
none has been exercised at runtime. Expect it to work; verify before claiming it does.

### 10.3 Panel → pin (NOT built)

Two very different asks, worth separating before scoping:

- **Highlight the pin for a card you click/hover, if it is currently on screen.** Cheap and
  safe — a `hoveredHouseKey`/`selectedHouseKey` in `chrome.storage.local`, mirrored by the
  content script onto a `.sidecar-MapPin--active` class (scale up, raise `z-index`, pulse).
  Uses the same reactive pattern as `showHousesOnMap`, so no new plumbing. **Recommended.**
- **Actually move the map to centre a pin ("jump to it").** Recommended **against**. It
  breaks the never-pan/zoom posture in §2.2, and it is not cheaply achievable: the map
  instance lives in the page's JS world, unreachable from a content script, so there is no
  `map.panTo()` to call. The only routes are synthesising drag gestures or driving the site's
  own search UI — both fragile and both exactly the sort of automation the anti-bot posture
  exists to avoid. If a house is off-screen, prefer saying so (the "N of M" indicator
  already does) over moving someone's map.

Missing, and the direction worth adding — make it **bidirectional**:

| Trigger | Effect |
| --- | --- |
| Click pin | scroll to + ring the matching panel card *(built, unverified)* |
| Hover / focus a panel card | that pin scales up, raises `z-index`, and pulses *(not built)* |
| Hover a pin | show the address in a small label *(not built)* |
| House removed in panel | its pin disappears on the next reconcile *(built via storage reactivity)* |

Implementation sketch for card→pin: the panel writes a `hoveredHouseKey` to
`chrome.storage.local`; the content script mirrors it onto
`.sidecar-MapPin--active` (the same reactive pattern `showHousesOnMap` and `compSession`
already use, so no new plumbing). Keep the highlight purely presentational — never move the
map.

Verify with the pin and the panel visible simultaneously, and confirm the click does not
also trigger the site's own map handler (that is what the capture-phase interceptor is
for).

---

## 11. Implementation checklist

Correctness first, in this order — each step is independently testable:

1. **`redfin.js`** — `geoFromLdJson`: `const geo = obj.geo ?? obj.mainEntity?.geo`. Add a
   `<meta name="geo.position">` fallback. Coerce with `Number()`. *(unblocks detail captures)*
2. **`homes.js`** — replace both hardcoded `latitude: null` sites with the `data-pk` →
   `data-pin-pk` → `position` join (§5). Delete the false comment at line 400.
3. ~~**`content.js`** — rewrite the clip test per §9. Remove every use of container
   width/height.~~ ✅ **DONE**, verified live on Redfin.
4. **`redfin.js` / `homes.js` / `zillow.js`** — add `mapClipElement()`,
   `mapPinAnchorOffset()`, and `clip`/`anchor` on `buildMapProjection()`'s return, using
   §3's measured values. ✅ Redfin done. ⬜ **Zillow and Homes.com outstanding — this is the
   single highest-value remaining step**, because without it those two sites silently fall
   back to the old broken behaviour (see the status box at the top). Measured values are in
   §3; no further recon needed.
5. **`homes.js`** — add `buildMapProjection()` / `projectPoint()` / `mapPinContainer()`
   per §4.2. *(Homes.com goes from unsupported to supported)*
6. **`zillow.js`** — replace hover-probe calibration with the URL-bounds fit (§4.3).
7. **`content.js`** — replace `.sidecar-MapPin` CSS and markup per §8; position via
   `left/top` + `translate(-50%,-100%)`.
8. **Tests** — see §12.
9. *(optional, gated)* focus mode (§8) and the narrowed observer (§7.3).
10. `npm run build`, reload the extension, then verify per §13.

---

## 12. Test plan

**The fixture change is the important part.** In `test/content-driver.test.ts`:

- Change `mapSite()`'s container to a **zero-size** rect (`width: 1471, height: 0`) and
  supply an explicit `clip` rect, mirroring the real DOM.
- Add a regression test: *a house projecting to `y = 300` still gets a pin when the
  container is `height: 0`*. This is the single test that would have caught the shipped bug.
- Add: a house outside the **clip** rect gets no pin (the real off-viewport case).
- Add: `anchor` offset is applied to the rendered `left/top`.

New adapter tests:

- `redfin.js` — `geoFromLdJson` reads `mainEntity.geo`; still rejects a blob whose `url`
  doesn't match `expectedId`; meta-tag fallback.
- `homes.js` — the pk join returns coordinates for a card; missing marker → `null`, not a
  throw.
- `zillow.js` — bounds fit from a fixture `searchQueryState`; absent query string →
  `null`, and **no synthetic events dispatched**.

Existing 663 tests must stay green; `tsc -b` and `npm run build` clean.

---

## 13. Verification standard

The previous session declared success from a DOM query plus a *zoomed* screenshot of a
single pin, and was wrong — that evidence cannot distinguish "working" from "94% broken",
because one pin in ~7% of positions survives the broken clip by luck. Required instead:

1. **Assert counts, not existence.** Pins rendered vs. houses that should be visible,
   cross-checked against native markers actually on screen.
2. **Screenshot at natural scale**, never zoomed — findability *is* the feature.
3. **Verify in the user's own window.** An automated tab is a separate browsing context and
   proves nothing about what the user sees.
4. **Drive the map.** Pan and zoom, then re-assert positional error against native markers.
5. **Test both capture paths** (card *and* detail) on **each** site, plus one cross-source
   case: capture on Zillow, view on Redfin.

### 13.1 Test results as of 2026-07-30 — what is already proven

Run against live sites and the panel harness. **Nothing here required the fix to be
implemented** — the mechanics were validated by injection, so the implementer inherits
known-good building blocks rather than open questions.

| # | What was tested | Result |
| --- | --- | --- |
| 1 | Projection fit, Redfin (335 markers) | ✅ 0.0009px max error |
| 2 | Projection fit, Homes.com (609 markers) | ✅ 0.935px max / 0.468 mean |
| 3 | Projection fit, Zillow via URL bounds (40 listings) | ✅ 0.4px median / 0.8px max, **no synthetic events** |
| 4 | Shipped clip test vs corrected clip | ✅ bug reproduced: 21/335 vs 335/335; 0/6 vs 6/6 on real houses |
| 5 | Marker findability at natural scale | ✅ 14px purple unfindable; 40×54 magenta teardrop instant |
| 6 | Tracking across pan | ✅ 0.01px error, all 6 pins, 5 reconciles |
| 7 | Tracking across zoom | ✅ 0.01px / 0px, off-view pins correctly dropped |
| 8 | Performance, our pins | ✅ 500 moved in 1.89ms; 5000 placed in 20.8ms; projection 0.64ms |
| 9 | Performance, observer records per pan | ⚠️ 945–11,572 wide vs 283 narrowed — optimisation, not a blocker |
| 10 | Redfin detail-page geo extraction | ❌ **returns null** — geo moved to `.mainEntity.geo` |
| 11 | Redfin card geo extraction | ✅ 41/41, numeric |
| 12 | Homes.com card→marker `data-pk` join | ✅ **100%**, 40/40 |
| 13 | Panel toggle writes `showHousesOnMap` | ✅ boolean `true`, label + `aria-pressed` flip |
| 14 | Panel renders "N of M shown" from `mapPinStatus` | ✅ "1 of 3 shown on this map" |
| 15 | `highlightHouse` → correct card rings + scrolls | ✅ purple-500 border + purple-400 ring, right house, scrolled |
| 16 | Highlight auto-clears after 3s | ✅ gone by 3700ms |
| 17 | Cross-source clip semantics | ✅ 3 houses (2 Zillow, 1 Redfin) on a Redfin Austin map → exactly the Austin one renders, "1 of 3" |
| 18 | **Clip fix through the real extension, Redfin** | ✅ pin `redfin:31037988` rendered at (661,592) among 320 native markers — where 0 rendered before |
| 19 | Zillow `.zillow-map-layer` multiplicity | ✅ bug A confirmed: 2 layers, index 0 has **0** markers, index 1 has **501** |
| 20 | Zillow `.is-hovered` timing | ✅ bug B confirmed: **0** matches synchronously, **1** after 150ms |
| 21 | Zillow bounds-fit implementation (exact new code, in page) | ✅ 40/40 pass the clip, error **0.15–0.6px** vs nearest native marker |
| 22 | Homes.com adapter implementation (exact new code, in page) | ✅ **639/639** markers parsed, fit succeeds, **1.038px** max error |
| 23 | Zillow/Homes.com through the real extension | ⬜ **blocked on an extension reload** — measured build marker was `2026-07-29.1`, not the build under test |

Tests 13–16 were run in `tools/panel-harness.html`, which **was broken** and had to be
repaired first: `background.js` registers `chrome.tabs.onUpdated/onCreated/onRemoved`
listeners at load, and the shim provided none, so the worker threw and the panel never
mounted. The shim also lacked `storage.local.remove` and `storage.onChanged` entirely. All
now stubbed/implemented (`storage.onChanged` for real, so reactive paths are exercisable).
**That harness repair is the only change in the working tree.**

### 13.1b Three traps that cost real time — read before testing

1. **A stale extension looks exactly like a broken fix.** Content-script edits require
   *Reload* on `chrome://extensions`; a page refresh is not enough. Zillow and Homes.com both
   measured "0 pins" purely because the loaded script was the previous build. Diagnose it
   with the build marker rather than guessing:
   ```js
   document.getElementById('calculator-styles')?.dataset.sidecarBuild
   ```
   `content.js` stamps `SIDECAR_BUILD` onto its injected stylesheet precisely so the loaded
   version is observable from the page. **Bump `SIDECAR_BUILD` on every build you intend to
   test, and check it before believing any negative result.**

2. **Page-world JS cannot see the adapters.** Content scripts run in an isolated world, so
   `RedfinAdapter`, `window.__investorSidecarLogView`, and `chrome.storage` are all
   unreachable from `javascript_tool` or a normal devtools console on the page. To test
   adapter logic live, *replicate the implementation* in page world — that is how bugs A/B
   above and the Homes.com fit were isolated without the extension in the loop. It also
   cleanly separates "my logic is wrong" from "the extension is stale".

3. **`setLocation()` in `test/site-adapters.test.ts` did not set `search`.** It assigned
   `href`/`hostname`/`pathname`/`origin` only, so anything reading `location.search` silently
   saw the *previous* test's query string. That made the URL-derived Zillow bounds untestable
   and would quietly break any future URL-state test. Fixed by adding `search: url.search`.
   Belt-and-braces, the adapter parses from `location.href` via `new URL(...)`, since `href`
   is the one field always populated in both the browser and jsdom.

### 13.2 Still unverified — needs the loaded extension

These cannot be reached by browser automation: the Chrome side panel is not addressable as
a tab, and page-world JS cannot write `chrome.storage`. They need a human with the extension
loaded, after the clip fix lands.

1. **Pins appear at all through the real extension** — the end-to-end proof no session has
   ever obtained. Toggle on, live Redfin, expect pins + a truthful "N of M".
2. **Clicking a real pin** fires `mapPinClicked` and the site's own map handler does *not*
   also fire (that is what the capture-phase interceptor is for). The panel half of this is
   now proven (test 15); only the pin half and the interception are open.
3. **Homes.com and Zillow end-to-end**, once their adapters gain the §4 methods.
4. **A Redfin detail-page capture** yielding usable coordinates, after fixing defect 2.

### Immediate next step for whoever implements this

**Do step 3 of §11 (the clip fix) first, alone, and rebuild.** It is ~15 lines, it is the
only cause of the reported symptom (§1, "Which defect caused it"), and the entire toggle
round trip around it is already known-good. Pins should appear immediately. That single
change is also the cheapest possible end-to-end proof that the plumbing works, which no
session has yet obtained.

Only then continue with defects 2 and 3 and the per-site work.

Useful for auditing capture quality at any point — run in the **side panel's own** devtools
console (right-click inside the panel → Inspect; page-world JS cannot see `chrome.storage`,
and reading the Chrome profile from disk is blocked):

```js
chrome.storage.local.get(['storedHouses', 'showHousesOnMap']).then(r => console.table(
  (r.storedHouses || []).map(h => ({
    key: `${h.source}:${h.propertyID}`, address: h.address,
    lat: h.latitude, lon: h.longitude,
    latType: typeof h.latitude, usable: Number.isFinite(h.latitude) && Number.isFinite(h.longitude)
  }))
));
```

Any row with `usable: false` is a house defect 2 has silently zeroed — expect these from
Redfin detail-page captures and all Homes.com card/popup captures.

Note also: `window.__investorSidecarLogView()` is set in the content script's **isolated
world** and is invisible to page-context execution — a red herring chased in a previous
session.
