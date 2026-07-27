# Investor Sidecar

A Chrome extension that turns a Redfin or Zillow listing into an investment analysis without
leaving the page. Click **Analyze** on a listing and it lands in a side panel, modelled
against your own assumptions under whichever strategy you pick:

| Strategy | What it answers |
| --- | --- |
| Buy and hold | Monthly cash flow, cap rate, cash-on-cash, DSCR |
| Fix and flip | Rehab budget, ARV, holding and selling costs, maximum allowable offer |
| BRRRR | The refinance, and what you leave in the deal after it |

Strategy is set panel-wide and overridable per property. Also: per-property assumption
overrides, sorting by any metric, undo, and an Excel export with one sheet per strategy plus
a cross-strategy index. See [docs/calculator-modes.md](docs/calculator-modes.md) for how a
mode is defined and what it takes to add one.

Everything is stored locally in `chrome.storage.local`. There are no accounts, no analytics
and no servers. See [PRIVACY.md](PRIVACY.md).

## Development

Requires [Node.js](https://nodejs.org/en/download/current).

```
npm install     # dependencies
npm run dev     # vite dev server for panel-only UI work
npm run build   # production build into dist/
npm run test    # unit tests (vitest)
npm run lint    # eslint
npm run harness # the panel at real side-panel widths, in a real browser
```

### Checking the panel visually

`npm run test` runs in jsdom, which has no layout engine: every assertion can pass while the
panel is visibly broken, because `getByText('$316,500')` matches even when the user is seeing
`$316,5...`. That is not hypothetical -- it is how the metric strip shipped truncating its
headline figures at every width below 440px.

`npm run harness` serves `tools/panel-harness.html`, which renders the real panel against the
real `background.js` (so the panel/worker message protocol is exercised, not mocked) with
seeded houses, one per strategy. Load it in a fixed-width iframe to get a faithful viewport,
then look for elements whose content overflows its box:

```js
[...d.querySelectorAll('*')].filter(e =>
  !e.children.length && e.textContent.trim() &&
  e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 0)
```

Chrome's side panel is user-resizable, and `body` has a 320px floor, so 320-440px is the
range that matters.

To run the real extension: `npm run build`, then load `dist/` in Chrome via
`chrome://extensions` → Developer mode → **Load unpacked**. Rebuild and hit reload on the
extension card after changes; content-script edits also need the Redfin/Zillow tab
refreshed. `public/scripts/content.js` carries a `SIDECAR_BUILD` marker so you can confirm
in the page's DOM which build is actually loaded.

## Layout

| Path | What lives there |
| --- | --- |
| `src/` | The side panel — React, TypeScript. `App.tsx` is the panel, `analysis.ts`/`metrics.ts`/`modes.ts` the calculations, `export.ts` the spreadsheet. |
| `public/scripts/` | Service worker (`background.js`) and content scripts. Plain JS, copied verbatim into the build. |
| `public/scripts/sites/` | Per-site adapters. All Redfin- and Zillow-specific selectors live here; `content.js` is site-agnostic. |
| `public/manifest.json` | Extension manifest (MV3). |
| `store/` | Chrome Web Store submission pack — not shipped in the package. |

## The tax and rent service

Removed before the store release. It fetched an unauthenticated service over plain http on a
user-configured `localhost` URL — not something to ship to strangers, and the setting was
broken by construction for anyone not running the service themselves. It is coming back with
real auth.

The panel-side half was deliberately kept and still compiles: `House.rentEstimate` /
`apiTaxRate` and the rent-distribution chart in `src/RentChart.tsx` render whenever a house
carries those fields. So restoring the feature is a service-worker and server change, not a
panel rewrite — write the fields into storage via `mergeEnrichmentIntoLatest`
(`public/scripts/house-storage.js`, unused today but still tested, because the write-back
race it solves is the non-obvious part). `git log -- public/scripts/background.js` has the
removed client; treat its transport as a sketch.

One consequence while it is out: `dist/assets/RentChart.js` (~409 kB, recharts) is still
built and shipped but never fetched, since nothing populates `rentEstimate`. Dropping the
`lazy()` call site in `src/App.tsx` would cut it from the package at the cost of re-adding
about ten lines later.

## Releasing

```
npm run package   # builds and zips dist/ to investor-sidecar-<version>.zip
```

Upload that zip to the Chrome Web Store; see [store/LISTING.md](store/LISTING.md) for the
listing copy, permission justifications and asset checklist. Bump `version` in **both**
`package.json` and `public/manifest.json` — they are not linked.

The store signs the package and assigns the extension ID. Any `dist.pem` / `dist.crx` in
your working copy is for self-hosted sideloading only, is gitignored, and is unrelated to
the store build.
