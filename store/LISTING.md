# Chrome Web Store submission pack

Everything the dashboard asks for, drafted. Copy the fields straight across.
Assets in this folder are **not** shipped in the extension package — `icon-source.png` is
the 800×800 master the runtime icons in `public/images/` were resized from.

## Before you start

- One-time $5 developer registration at
  <https://chrome.google.com/webstore/devconsole> (needed once per Google account).
- Privacy policy URL — **done**, paste this into the listing and the data-disclosure form:

  ```
  https://mattstoebe.github.io/investor-sidecar/PRIVACY
  ```

  Served by GitHub Pages from `PRIVACY.md` on `main` (see `_config.yml`). It has to be a
  reachable URL: the store rejects a policy that is only a file in a repository. Editing
  `PRIVACY.md` and pushing republishes it within a minute or two.

## Build the upload

```
npm run package
```

Produces `investor-sidecar-1.0.0.zip` from `dist/`. Upload that zip — do **not** upload a
`.crx`, and do not upload `dist.pem`. The store signs the package itself and assigns the
extension ID, which is why the store install gets a different ID from any sideloaded build.

## Store listing fields

**Name**

```
Investor Sidecar
```

**Summary** (132 char limit, must match `manifest.json` description)

```
Analyze rental cash flow, cap rate and cash-on-cash for Redfin and Zillow listings you save, in a side panel.
```

**Category**: Productivity  ·  **Language**: English (United States)

**Detailed description**

```
Investor Sidecar turns a Redfin or Zillow listing into an investment analysis without
leaving the page.

Browse listings the way you normally do. When one looks worth a closer look, click Analyze.
The property lands in a side panel next to the page, already modelled against your own
assumptions — down payment, interest rate, property tax, insurance, and the rest.

THREE STRATEGIES, ONE BOARD
• Buy and hold — monthly cash flow, cap rate, cash-on-cash and DSCR
• Fix and flip — rehab budget, ARV, holding costs, selling costs and maximum allowable offer
• BRRRR — the refinance and what you leave in the deal after it
Every saved property is analyzed under whichever strategy you pick, and you can set a
strategy per property when one deal is different from the rest.

ALSO
• Your assumptions applied across every listing at once, with per-property overrides
• Side-by-side comparison of everything saved, sorted by the metric you care about
• Pick which metrics show on each property card
• Undo, for when you delete the wrong house
• Export to Excel — one sheet per strategy, plus an index across all of them
• Dark mode

PRIVACY
Everything stays on your computer. Investor Sidecar has no accounts, no analytics and no
servers — saved properties and settings live in your browser's local storage and are never
transmitted anywhere. The extension runs only on Redfin and Zillow listing pages.

Investor Sidecar is an analysis tool, not financial advice. Estimates depend on the
assumptions you enter and on data published by the listing site. Verify the numbers before
making an offer.
```

## Privacy practices tab

**Single purpose**

```
Investor Sidecar calculates real-estate investment metrics — buy-and-hold cash flow,
fix-and-flip returns and BRRRR outcomes — for listings the user chooses to save on Redfin
and Zillow, and displays them in a side panel.
```

**Permission justifications**

| Permission | Justification |
| --- | --- |
| `storage` | Saves the user's analyzed properties, their calculator assumptions and a short local undo history so the side panel keeps its contents between sessions. |
| `sidePanel` | The calculator is displayed in Chrome's side panel next to the listing being viewed. |
| Host access to `*.redfin.com` / `*.zillow.com` | The content script adds an "Analyze" button to listings on these two sites and reads the listing's price, address, beds, baths and square footage from the page in order to model it. The extension runs on no other sites. |

**Remote code**: No — all code ships in the package, and the extension contacts no remote
server. Worth stating plainly in the justification box: the only hosts it touches are the two
it injects a button into. (The bundle's only `fetch` is Vite's modulepreload helper loading
the extension's own packaged assets over `chrome-extension://`.)

**Data usage disclosures** — tick nothing except as noted, then affirm all three
certifications:

- Personally identifiable information: **no**
- Health, financial and payment information: **no** (the extension computes with listing
  prices, but collects no user financial information)
- Authentication information, personal communications, location, web history, user activity,
  website content: **no**
- ✅ I do not sell or transfer user data to third parties outside of the approved use cases
- ✅ I do not use or transfer user data for purposes unrelated to my item's single purpose
- ✅ I do not use or transfer user data to determine creditworthiness or for lending purposes

## Graphic assets to produce

Screenshots must be exactly **1280×800** or **640×400** (at least one required, up to five).

1. Side panel open beside a Zillow search-results page, with two or three saved properties
   showing cash flow and cap rate. **This is the one that sells it — make it first.**
2. The strategy picker, with a board showing properties under different strategies. This is
   the headline feature now; it should not be buried at position four.
3. A single property card expanded, showing the per-property override fields.
4. The global assumptions panel.
5. A Redfin detail page with the Analyze button visible in the action bar.

Optional but recommended: a 440×280 small promo tile, used if the extension gets featured.

Before screenshotting, load `dist/` unpacked, save a few real listings, and check the
numbers are sensible — reviewers do look at these.

## After submitting

Review usually takes a few business days; host permissions on two major sites sometimes draw
a longer look. Note that **increasing** permissions in a later version triggers another
review and requires users to re-approve, which disables the extension for them until they do
— so any permission changes are best made before this first submission, not after.
