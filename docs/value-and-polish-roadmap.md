# What's worth building next: polish and paid-tier value

_Compiled 2026-07-30. Revised 2026-08-01 for the free-first decision (§6). Market and user
research, cross-referenced against what this codebase actually does today. Supersedes the
prioritisation in [feature-research.md](./feature-research.md) — that document's competitive
scan still stands, but its **Phase 1 recommendation is now wrong**, for reasons in §2._

**How to read confidence here.** Every claim is tagged: **[code]** = verified by reading this
repo today; **[research]** = from a cited external source; **[judgement]** = my inference, argue
with it. Effort estimates are rough and assume familiarity with the codebase.

> **Revision note (2026-08-01).** §6 is no longer an open question. The shape is decided: **ship
> the calculator free to buy distribution, sell screening on top of it.** That decision changes
> the ranking in §3 and §4 rather than the analysis behind them, so the affected items are marked
> **[free-first]** and the reasoning is kept in place. The substantive changes: comps must be
> gated *before* the free release or they can never be sold (§6.2), §3.1 and §3.4 are promoted to
> launch-blocking (§3.0), and the §4.1 kernel refactor is explicitly **deferred until after 1.0**
> (§7).
>
> **The effort estimates in §4 were too optimistic, and §4.1's was wrong.** A new §4.0 does the
> reckoning. The short version: badging a search page needs a rent for every card, unattended,
> and nothing in this build produces one. That is a data problem, not a wiring problem, and it
> was hiding behind the phrase "mostly wiring existing, tested pieces."

---

## 1. The single most important finding: this market has two price tiers

**[research]** Current pricing for the tools this competes with or against:

| Tool | Price | What it sells |
|---|---|---|
| DealCheck Plus | $10/mo | Deal calculator |
| DealCheck Pro | $20/mo | Calculator + **comps** |
| Mashvisor | ~$18/mo | LTR/STR analytics |
| AirDNA Starter | ~$15–19/mo | STR revenue estimates, one market |
| AirDNA Pro | $80–300/mo | Full market access |
| PropStream | $99/mo | List building, property data |
| Privy | $149/mo | Deal finding, market analysis |

The gap is the whole strategy. **Calculators cap out around $10–20/month. Tools that help you
*find* deals charge $99–149.** DealCheck is the category-leading calculator with a decade of
brand behind it and it still can't clear $20.

**[judgement] So the strategic question is not "what calculator feature comes next" — it is
"does this stay a calculator, or become a screening tool?"** Everything in §4 is ranked against
that question, because it's worth roughly 7x.

### 1.1 Correction: the top tier sells *list building*, not screening **[free-first]**

**[judgement]** The table above collapses two different products, and the earlier draft of this
document priced against the wrong one. Be precise:

- **List building** ($99–149 — PropStream, Privy): the tool decides *which properties exist and
  are worth looking at*. Off-market, absentee, pre-foreclosure, distressed, MLS-wide. The user
  supplies criteria; the tool supplies inventory.
- **Screening** (what §4.1 builds): the tool scores properties *the user is already looking at*.
  The user still supplies the inventory by browsing.

Screening is worth substantially more than a calculator — it removes the same 20-min-per-deal
bottleneck the research names — but it does not remove the finding step, so it does not price
like PropStream. **[judgement] Realistic target: $25–49/mo.** That is still 2–4x the calculator
ceiling and is the right thing to aim at; anchoring on $99 sets up a disappointment and invites
building an inventory product this codebase has no data source for.

Two corroborating data points on where the paywall goes:

- **[research]** DealCheck's free/paid line is drawn **exactly at comps**: the free plan caps
  you at 5 comps per property, and paying lifts the cap. The market leader has already
  validated that comps are the thing people will pay for. This repo has comps — user-curated,
  which is arguably a better product, because the user picked them and therefore trusts the
  number they imply **[judgement]**.
- **[research]** On where investor time actually goes: "once a deal clears initial screening,
  underwriting is the next bottleneck," and buy-box screening tools "reduce screening time from
  20 minutes to under 5 minutes per deal."

---

## 2. What changed since feature-research.md (2026-07-25)

That doc's Phase 1 was: *get the rent/tax model service running again, because every
intelligence feature is blocked at step zero.* **That is no longer true** — three things landed
since:

- **[code] Comps ship, and need no service.** `Comp` capture works across Redfin, Zillow and
  Homes.com; the panel renders dots, a median, and a one-click adopt (`src/CompDots.tsx`,
  `CompSummary` at `src/App.tsx:631`, `addComp`/`removeComp` at `public/scripts/background.js:221`).
  This is feature-research's B2 built by hand. The rent slider now has a real local data source
  that doesn't depend on `localhost:5001` ever coming back.
- **[code] Geocoding is substantially solved.** Zillow card geo now reads from
  `__NEXT_DATA__…listResults`; Redfin detail geo was fixed to `obj?.mainEntity?.geo`. That was
  the stated Phase 0 blocker.
- **[code] A third site (Homes.com) and map pins landed.**

**[judgement]** So the constraint is no longer data availability. Three consecutive build cycles
went into *capture breadth* and none into *what happens to the numbers afterwards*. Verified:
grepping `src/` for `irr|projection|appreciation|holdPeriod|sensitivity|depreciation|afterTax`
returns nothing, and the param registry has no appreciation, rent growth, tax rate, or
buy-and-hold hold period (`holdMonths` is flip-only) **[code]**.

**Correction (2026-08-01).** "The constraint is no longer data availability" is true for the
*single-property* workflow and false for the *bulk* one, and this document leaned on it in both
places. Comps solved rent for one house at a time because a human curates them — five clicks per
property. That does not scale to forty cards on a search page, which is precisely what §4.1
needs. **The rent-data constraint was narrowed, not removed.** See §4.0.

**Since 2026-08-01 [free-first]:** the other remaining constraint is not technical at all. It is
that the free/paid line has to be drawn before the first store submission, because every item
below is either on the free side or the paid side and the cost of moving one across afterwards is
much higher than the cost of deciding now. See §6.

---

## 3. Polish — derived from what users actually complain about

### 3.0 Free-first re-ranks this whole section **[free-first]**

**[judgement]** The earlier draft treated §3.1 (scraper health) as something to land "somewhere
in here regardless." Under a free-first release that is wrong, and the reason is worth stating
because it inverts the priority:

**The free tier's only job is distribution.** It is not a revenue line, it is the thing that
produces installs and reviews, and installs and reviews are the entire top of the paid funnel.
That makes review score a *strategic* asset rather than a hygiene metric — and **[research]** the
category's dominant review complaint is silent breakage. A paid beta with twelve hand-held users
can absorb an unverified capture path. A free launch whose whole purpose is to be reviewed
cannot.

So for a free 1.0: **§3.1, §3.2, §3.3 and §3.4 are all launch-blocking.** §3.5 is not.

### 3.1 Scraper fragility is the #1 complaint in this category — and it's silent here — **launch-blocking [free-first]**

**[research]** The dominant review complaint across these extensions is that they "stop working
when websites make page changes," plus reports of extensions that appear broken, ignore search
criteria, or return wrong-ZIP results.

**[code]** This codebase is *entirely* scraping, across three sites, and `comp-workflow-open-bugs.md`
§7 already catalogues six selectors whose failure mode is explicitly described as **silent** —
e.g. if Zillow renames `[data-testid="price"]`, rental detail pages quietly become "for sale"
again and the calculator returns on a listing it should refuse.

**[judgement] This is the highest-value polish item in the repo, and it's a feature, not a
chore.** A user whose extension silently does nothing churns and leaves a 1-star review; a user
told "Redfin changed their layout, capture is degraded, update coming" does not. Concretely:

- A per-adapter self-check that runs its own critical selectors against the current page and
  reports a health status (each adapter already has a `diagnostics()` method **[code]**).
- Surface degradation in the panel rather than the console.
- A test-only fixture-drift job that fails CI when transcribed markup no longer matches live.

**Effort:** medium. **Why it pays:** it converts the category's #1 churn cause into a trust
signal — and under §3.0, it protects the asset the paid tier is built on.

### 3.2 Documentation is now actively misleading — **launch-blocking**

**[code]** The other model fixed most documented open bugs without updating the docs. Verified
fixed but still written up as OPEN: Zillow click-through navigation (interceptors moved to
`window` + manifest `run_at: document_start`), Homes.com rental detail pages
(`isRentalDetailPage` now at `homes.js:274`), `buildCompUrl` guessing Redfin (now returns
`null`), and all three map-pin defects across all three adapters.

`docs/map-pin-open-bugs.md` is explicitly superseded but still present, and
`map-pin-implementation-spec.md`'s own status section says Zillow and Homes.com are "not
started" when the code contradicts it. **Effort: ~30 min. Cost of not doing it: the next agent
re-does finished work.**

### 3.3 Homes.com is shipped in the manifest but missing from the store pack — **launch-blocking**

**[code]** `manifest.json:7` declares `https://*.homes.com/*`, but `PRIVACY.md:36` — *the live
published policy at the URL the store checks* — says listings are saved "while browsing Redfin
and Zillow" and that "the extension runs on no other websites." That is now false. `store/LISTING.md`'s
permission-justification table and summary copy, and `README.md`, all still say two sites.

**[research/code]** `LISTING.md:137` notes that *increasing* permissions after submission
triggers re-review and forces users to re-approve, disabling the extension until they do. So
this is materially cheaper to fix before a 1.0 submission. **Effort: ~1 hour. Blocking a ship.**

**[free-first]** Do this in the same pass as the §6.3 privacy reword — they touch the same three
files and both have to be right before the policy URL is submitted.

### 3.4 Verification debt — **launch-blocking [free-first]**

**[code]** Nothing in the comp or map-pin features has been confirmed end-to-end by a human
through the loaded extension. The spec's §13.2 lists four such items; also unverified are rule
A1's acceptance test (typing rent while a comp lands from another tab), comp-removal undo, and
dark mode at 320px. Browser automation genuinely cannot reach these — the side panel isn't
addressable as a tab and page-world JS can't touch `chrome.storage`. **Needs a human, ~1 hour.**

**[judgement]** 703 passing tests **[code, measured 2026-08-01 — the earlier draft said 701]**
say the kernels are right. They say nothing about whether a human can click Analyze on a live
Redfin page and get a number, which is the only thing a reviewer will check.

### 3.5 Smaller, real — **not launch-blocking**

- **[code]** `dist/assets/RentChart.js` is 409 kB (111 kB gzipped) — about a third of the
  package — shipped in every build and never fetched, because nothing populates `rentEstimate`.
  Dropping the `lazy()` call site is ~10 lines out, ~10 back later.
- **[code]** Comps don't reach the Excel export. Pure addition to `src/export.ts`; users who
  curate comps will expect them in the output. **[free-first]** This one lands on the free side —
  see §6.2 — so treat it as review-bait, not revenue.
- **[code]** Distance-to-subject per comp is now unblocked by the geo fixes and is the number an
  appraiser cross-checks first. **[free-first]** Paid side.
- **[research]** Users of competing extensions ask specifically for **PDF output** and for
  **school / crime indicators**. Both are real demand signals; PDF is §4.4.

---

## 4. Value adds, ranked by willingness-to-pay × fit

**[free-first]** Each item is now tagged **Free** or **Pro** per §6.2. "Free" does not mean
low-value — it means its job is installs and reviews rather than revenue.

### 4.0 Effort reckoning — read this before believing any estimate below

The estimates in the original draft were sized as *implementation* effort against a codebase
where all the inputs already exist. That assumption holds for most of the list and breaks
completely for the most important item.

| Item | Original | Honest | Why it moved |
|---|---|---|---|
| §4.6 IRR / projection | small-medium | **small-medium** ✓ | Pure arithmetic over params that exist. Estimate stands. |
| §4.2 comps finishing | small-medium | **small-medium** ✓ | Arithmetic over `Comp` fields already stored. Estimate stands. |
| §4.5 mode variants | small per mode | **small per mode** ✓ | Registry is built for it. Section 8 needs a bundled HUD table (see below) — half a day. |
| §4.3 rehab estimator | medium | **medium** ✓ | No data dependency. The work is UI surface and a template store, both conventional. |
| §4.4 PDF one-pager | medium | **medium–large** | New renderer, no library in tree, and print layout at side-panel widths is fiddly. Not hard, just slower than it sounds. |
| §3.1 adapter health | medium | **medium** ✓ | `diagnostics()` exists on every adapter. Mostly plumbing and a CI job. |
| **§4.1 buy box** | **large** | **large, and gated on an unsolved data problem** | See §4.0.1. |

### 4.0.1 The prerequisite §4.1 hides: where does rent come from?

**[code] Badging a search card requires a rent for that card, and nothing in this build produces
one.** `MODES.rental.requires = ['monthlyRent']` (`src/modes.ts:86`) and `missingRequirement`
refuses on null, undefined or zero (`modes.ts:218`). So there is no such thing as a cash-flow
badge without a rent figure. Today rent reaches the model exactly two ways, and both are manual
and per-property:

1. The user types it (`monthlyRent` param).
2. The user adopts it from a curated comp (`CompSummary` → `onPick`, `App.tsx:631`).

Forty cards on a search page cannot be fed by either. **This is the whole reason §4.1 is not
"mostly wiring".** The wiring — extracting the kernel into a module `background.js` imports — is
genuinely mechanical and genuinely medium. What sits underneath it is a rent-estimation problem,
and the original draft's §2 mistook comps solving the one-house case for comps solving this one.

**The four ways to get a bulk rent, priced honestly [judgement]:**

- **(a) Train a rent model and serve it.** This is `localhost:5001` again, with real auth. Large:
  training data acquisition, a model, hosting, per-market accuracy work, and an ongoing accuracy
  liability — a badge that is confidently wrong is worse than no badge. **And it collides with
  §6.3:** getting a rent back means transmitting beds/baths/sqft/lat/long, which is property data
  leaving the machine, which contradicts the privacy claim this document just recommended
  building the brand on. Not a blocker, but it means picking one or the other deliberately.
- **(b) Vendor API** (RentCast and similar). Removes the modelling work, keeps the server, keeps
  the same §6.3 collision, and adds unit economics that don't obviously close: a user badging 40
  cards across 20 searches a month is ~800 lookups/month against a $29 subscription. Caching by
  property helps; it does not make the shape comfortable.
- **(c) Rent-per-sqft calibrated from the user's own comps — recommended.** **[code]** `Comp`
  already stores `sqft`, `beds`, `baths` and `address` (`App.tsx:52-55`), and a ZIP extractor
  already exists (`comp-links.js:11`). Every rent comp the user has ever clipped is therefore an
  observation of $/sqft in a known ZIP. Aggregate them and every card with a sqft gets a rent.
  **No server, no model, no privacy change, no per-call cost, and it strengthens rather than
  weakens the existing free feature.** It is also *more* persuasive than a black box: the user
  sourced the inputs, so they trust the output — the same argument §1 makes for curated comps
  over automated ones. **Effort: small — a day or two, mostly aggregation and a provenance label.**
- **(d) HUD Fair Market Rents as a bundled static table.** **[research]** Free public dataset,
  ZIP-level, published annually. Ships inside the package as JSON — no server, no network, no
  policy change. It is a conservative floor rather than a market rent, so it is the wrong number
  to headline, but it is the right number to fall back to. **[judgement]** §4.5 already identified
  this dataset and filed it under "Section 8 mode"; it is more valuable as *the cold-start rent
  basis for screening*, and the same import serves both. **Effort: small.**

**Recommendation: (c) with (d) as fallback, and never a silent guess.** Three badge states, each
labelled with its provenance:

| State | Badge | Source line |
|---|---|---|
| User has ≥3 rent comps in this ZIP | `+$340/mo` | "est. from your 6 comps in 78745" |
| No comps, HUD table has the ZIP | `+$120/mo` (muted) | "HUD FMR — conservative" |
| Neither, or no sqft on the card | `— set a rent` | not a blank, not a zero |

**[judgement]** That provenance line is not a disclaimer, it is the feature. It follows the
pattern the codebase already established with `amountLabel: 'last-list'` **[code]** — telling the
user exactly what a number is made of, including when it is weak. It is also what makes the
cold-start honest: a new user with zero comps sees "HUD FMR — conservative" and a prompt to clip
a few comps, which is a *better* onboarding funnel into the free feature than a blank screen.

**So §4.1's real cost is three pieces, not one:** kernel extraction (medium, mechanical, low
risk) + rent basis (small if (c)/(d), large if (a)/(b)) + badge injection and batching across 40
cards without janking someone else's search page (medium, and the perf work is real —
`content.js` already runs its observer in `requestIdleCallback` and detaches during resize
**[code]**, so there is a pattern to follow but also a demonstrated need for one).

**[judgement] Taking route (c)/(d) is what keeps §4.1 a large-but-tractable feature instead of a
company.** If the only acceptable answer is a trained model, §4.1 is not the next thing after
1.0 — it is a separate project with a server, a cost line and a rewritten privacy policy, and the
sequence in §7 should be re-planned around that rather than pretending it fits.

### 4.1 Bulk underwrite + buy-box screening on the search page — **the category jump** — **Pro**

**The pitch:** every card on a Redfin/Zillow/Homes.com search page gets a badge computed at
*your* assumptions — `+$340/mo`, `7.2% CoC` — colour-coded pass/fail against a buy box you
define once. You stop opening listings to find out they don't work.

**Why it's the top item:**
- **[research]** This is the jump out of the $10–20 tier. Screening, not calculating, is what
  commands money, and the research quantifies it: 20 min → under 5 min per deal. Price it at
  **$25–49/mo**, not $99 — see §1.1 for why this is not a PropStream competitor.
- **[research]** "Buy box" is already the investors' own vocabulary — a written set of criteria
  defining which deals they will and won't consider. Shipping it as a named feature meets them
  where they are.
- **[code] Much of it exists** — but not all, and the original draft's "most of it exists" was
  overstated. What exists: card injection on every card across three sites
  (`ensureCalculatorOnCard`, `content.js:776`), the analysis kernels (703 tests), and a buy-box
  criteria shape that maps cleanly onto `GlobalParameters` + the metric registry. What does not
  exist is the rent input every badge needs — **§4.0.1, and it is the long pole, not the wiring.**
- **[judgement]** No competitor found does this. Every rival is a per-listing overlay. This is
  the structural advantage feature-research.md already identified — it just mis-ranked it as a
  workflow nicety (C1) instead of the monetisation core.

**The one architectural prerequisite [code]:** badge math must not become a *third* calculation
path — the panel and Excel export deliberately share one so they can never disagree. Good news:
`analysis.ts`, `core-utils.ts`, `flip.ts` and `brrrr.ts` are pure TypeScript with no DOM or React
dependency, and `modes.ts`'s only `App` import is type-only (`src/modes.ts:10`) and therefore
erasable. So the kernel can be built as a shared module the module-worker `background.js` imports
(it already uses `import` **[code]**), and the content script asks the worker to score a batch.
**Do this as an explicit step-one refactor**; skipping it is how you get a badge that disagrees
with the card.

**[free-first] But do it *after* 1.0.** It is a pure move with no user-visible effect, so it does
not need to be in the free build to keep the paid build honest, and it is the longest pole here.
Shipping 1.0 first buys review signal while it's underway.

**The scraping line this feature must not cross [judgement].** §3.1 covers selector drift; it
does not cover rate limiting, and this is where that starts to matter. **Score what is already on
screen; never fetch a page the user did not visit.** Badging loaded DOM carries no incremental
bot risk — the browser already made those requests. Background-fetching listings to fill a buy
box is a categorically different product with a different blocking and legal profile, and it is
the point at which this becomes the list-building tool §1.1 says it isn't. Write that constraint
into the feature spec, not just into someone's head.

**Effort:** large — the biggest item here by a wide margin, and the only one whose estimate
depends on a decision not yet made (§4.0.1's route (c)/(d) vs (a)/(b)). Under (c)/(d) it is
roughly kernel-extraction + rent-basis + badge-injection, each individually tractable. Under
(a)/(b) it stops being a feature and becomes a project with a server and a cost line.

It remains the only item on this list that changes what category the product is in — which is
why it is worth doing even at the honest price, and why it is worth doing at the *cheap* price
first to find out whether the badge is something people actually use before funding a model for
it. **[judgement] Ship (c)/(d), watch whether anyone screens with it, and let that decide whether
(a) is ever justified.**

### 4.2 Finish comps into the feature DealCheck charges for — **Free (capped) + Pro (uncapped)**

**[research]** Comps are the market leader's literal paywall line. **[code]** This repo already
has capture, dots, median and adopt — **which means a free 1.0 ships them free unless the cap in
§6.2 lands first.** This is the single highest-consequence sequencing item in the document.

What's missing to make the *paid* half sellable rather than merely present:

- **Adjusted comps.** Right now it's a raw median. Appraisers adjust for sqft, beds/baths and
  recency. "ARV $412k from 5 comps, adjusted for size" is a materially different claim from
  "median of 5 numbers", and it's pure arithmetic over data already stored.
- **$/sqft normalisation** and **distance-to-subject** (now unblocked).
- **Comps in the export/report** (§3.5) — free side, it's review-bait.
- **[code]** Sold-comp honesty is already a differentiator worth marketing: in non-disclosure
  states the panel labels last-list prices as such (`amountLabel: 'last-list'`) instead of
  passing them off as sold prices. Free side — it's a trust claim, and trust claims want reach.

**Effort:** small-to-medium. **Highest value-per-line on this list [judgement]** — it finishes
something built rather than starting something new, and it lands on a proven paywall.

### 4.3 A real rehab estimator (3-tier) — **Pro**

**[research]** "Underestimating repair needs remains the top reason for failed property flips,"
and generic calculators "use national averages that don't account for a specific zip code's
labor shortage or material costs." The practitioner pattern is a **3-tier system: napkin →
$-per-sqft → line-item**, matched to deal stage.

**[code]** Today `rehabBudget` is a single number the user types. A tiered estimator with a
line-item template the user tunes *to their own market and crew* and reuses across deals is
exactly the gap the research describes — and it's pure computation with no data dependency, no
scraping, and no bot risk. It fits the existing params/modes registry.

**[judgement]** Flippers have the highest per-decision dollar stakes in this market, which makes
this the strongest *non-screening* feature on the list. Add the commonly-forgotten line items the
research names — permits and fees — as defaults, since forgetting them is a documented failure
mode.

**Effort:** medium.

### 4.4 Lender / partner one-pager (PDF) — **Pro**

**[research]** Direct user demand — reviews of competing extensions specifically ask to "print
out comparison data as PDF." **[judgement]** It's also transaction-unlocking: a DSCR lender or a
money partner wants a document, and the alternative is rebuilding it in Excel by hand. DSCR is
already computed **[code]**.

**Effort:** medium (new renderer; `export.ts` gives the data shape but not the layout). Natural
paid-tier item.

### 4.5 Strategy variants: STR, mid-term, by-the-room, Section 8 — **Free**

**[research]** STR analysis is its own paid category — AirDNA $15–99/mo, Mashvisor ~$18/mo. We
can't source STR revenue data without a vendor, **but a mode where the user supplies ADR and
occupancy (or pastes an AirDNA figure) is cheap and in-scope** via the existing `MODES` registry
**[code]**, and it captures users who currently leave to do that math elsewhere.

**Section 8 is the sleeper [judgement]:** HUD Fair Market Rents are a **free public dataset**,
it's a genuine income model rather than a guess, and effectively nobody offers it in-listing.

**[free-first] Do the HUD import early, because it is load-bearing twice.** §4.0.1 wants the same
ZIP-level table as the cold-start rent basis for screening. One import, bundled as static JSON in
the package, serves both a shipped free mode and the prerequisite for the paid flagship — which
makes it the best effort-to-leverage ratio in this document. Pull it forward ahead of the STR
mode.

**[free-first] Free, deliberately.** New modes are the cheapest install-driver available — each
one is a distinct search term and a distinct audience arriving at the free tier. Gating them
would trade distribution for a few dollars of ARPU. **[judgement]**

**Effort:** small per mode — the registry is designed for exactly this
(`docs/calculator-modes.md` documents what adding one takes).

### 4.6 Multi-year projection + IRR — table stakes, not a differentiator — **Free**

**Correcting my own earlier recommendation.** This closes the largest *competitive* gap and a
serious investor will dismiss a tool with no exit modelling — but **[judgement]** nobody pays for
it, because every free spreadsheet and every competitor has it. Ship it because its absence is
disqualifying, not because it sells. **[research]** The one angle with real edge: the loudest
recurring BiggerPockets complaint is that their "profit if sold" math is wrong and unverifiable —
a tested, transparent, *showable* version is a credibility play.

**[free-first]** Which is exactly the argument for putting it in the free tier: a feature nobody
pays for but everybody checks for is a wedge component, not a paywall component. Putting it
behind the paywall makes the free tier look incomplete without earning a dollar.

**Effort:** small-to-medium, pure computation. Cheap enough to just do.

---

## 5. Out of scope, or not worth it yet

- **List building / off-market inventory.** §1.1 — it is the $99 tier, and this codebase has no
  data source for it that isn't a paid vendor feed or a scraping posture the §4.1 constraint
  explicitly rules out. **[judgement]**
- **Photo-based condition scoring (feature-research B3).** Highest ceiling, but it needs a VLM,
  which means a server, per-call cost, and rewriting the privacy promise. Revisit only after §6
  is built out — note that once §6's license server exists, the *marginal* cost of this drops a
  lot, so it may be worth re-scoring then rather than never **[judgement]**.
- **A fourth site adapter.** Three cycles already went into capture breadth. Marginal return is
  now well below the screening gap **[judgement]**.
- **More raw metrics.** Already ahead of the field on ratio breadth; feature-research was right
  about this and it hasn't changed.
- **Reviving `localhost:5001` as-is.** §2 — comps removed its urgency, and an unauthenticated
  local HTTP service was never shippable.

---

## 6. The money decision — made, and smaller than it looked

_Previously titled "the constraint nobody has decided yet." It is decided._

### 6.1 The shape

**Ship the calculator free to buy distribution; sell screening on top of it.** This follows
directly from §1: the calculator half of this product competes in a tier that caps at $20 against
a decade-old brand, and the screening half competes in a tier with no incumbent doing it at all.
Giving away the part you can't win on to acquire users for the part you can is the correct trade
**[judgement]**.

**[research]** Chrome Web Store native payments were discontinued; paid extensions now run on
Stripe directly, or wrappers like ExtensionPay, Paddle or Lemon Squeezy. That part is routine.

### 6.2 The free/paid line — decide before submission, not after

**[research]** Reviews of competing extensions show users resent a move to paid subscriptions.
That resentment is asymmetric: adding a *new* paid feature is fine, taking away an *existing*
free one is not. So anything shipped free in 1.0 is free permanently.

| | Free (the wedge) | Pro (~$29/mo) |
|---|---|---|
| Calculators | All three strategies, per-house overrides, sorting, undo, dark mode | — |
| Comps | Capture on all three sites, dots, median, adopt, sold-comp honesty labels — **capped at 5 per property** | Uncapped, **adjusted** (sqft/beds/recency), $/sqft, distance-to-subject (§4.2) |
| Screening | — | Buy box + bulk card badging (§4.1) |
| Output | Excel export, comps in export (§3.5) | PDF lender one-pager (§4.4) |
| Modes | STR, mid-term, by-the-room, Section 8 (§4.5) | — |
| Projection | Multi-year + IRR (§4.6) | — |
| Rehab | Single `rehabBudget` field (today's behaviour) | 3-tier estimator with reusable line-item templates (§4.3) |
| Map | Pins, highlight, focus | — |

**The 5-comp cap is the one thing that must land before the store submission [code/judgement].**
Comps ship *today* — `CompDots.tsx`, `CompSummary` at `App.tsx:631`, `addComp`/`removeComp` at
`background.js:221` — so a free 1.0 with no cap gives away the exact feature §4.2 plans to sell,
and §6.2's asymmetry means it can never come back. Two things make the cap the right instrument
rather than a hard gate:

- **[research]** 5-per-property is DealCheck's own free line. Matching a market leader's cap
  reads as conventional rather than stingy, and it is a number users have already met.
- **[code]** A cap is enforced entirely locally — no server, no identity, nothing to build. Yes,
  a determined user can bypass client-side enforcement. **[judgement]** At this price point that
  is not worth defending against; the cap's job is to make the paid tier legible, not to be
  tamper-proof.

### 6.3 What is actually irreversible: the copy, not the architecture

The earlier draft framed this as an architectural blocker. On re-examination it is mostly a
copywriting one, and the architectural half may be free:

**[judgement — unverified, test before relying on it]** MV3 service-worker `fetch` to a host
*not* in `host_permissions` is permitted under ordinary CORS rules. If the license endpoint
returns an `Access-Control-Allow-Origin` header covering the extension origin, billing can be
added later **without touching `host_permissions`** — which means no re-review, and none of
`LISTING.md:137`'s re-approve-or-be-disabled problem. **Verify this against a scratch endpoint
before committing to the sequence**, because if it holds, §6 stops being a pre-1.0 engineering
blocker entirely. If it does not hold, add the license host to `host_permissions` in the 1.0
submission and never call it — an unused declared permission is far cheaper than a later
permission increase.

**What genuinely cannot be undone is the promise. [code]** `PRIVACY.md:13` currently reads: "There
are no accounts, no analytics, no third-party services, and the extension contacts no server of
any kind." That is an absolute, and the paid tier breaks it. Reword it *now*, before the policy
URL is submitted, from an absolute to a scoped claim:

> Your property data never leaves your machine. A future paid tier will verify a license token
> and nothing else — no property data, no browsing history, no analytics.

**[judgement]** This keeps the entire differentiator — "local-only, your data never leaves your
machine" is genuinely strong in a category full of data-harvesting tools — while not painting
into a corner. It costs about ten minutes today and is impossible to do gracefully after launch,
because a promise walked back reads as a bait-and-switch even when the substance is unchanged.
`PRIVACY.md`'s existing "Changes" section provides some cover but the Short version is what
people read.

**One collision to be aware of before writing that sentence [judgement]:** the wording above
promises a license token *and nothing else*, which is compatible with §4.0.1's routes (c) and (d)
— both are entirely local — and **incompatible with routes (a) and (b)**, which transmit
beds/baths/sqft/lat/long to get a rent back. Do not write the strong claim and then quietly break
it two releases later; that is the exact bait-and-switch this section exists to avoid. Either
commit to the local routes and make the strong claim an actual product constraint, or soften the
wording now to "no property data leaves your machine without an explicit action you take." The
first is worth more and is what the (c)/(d) recommendation is partly chosen to preserve.

Two more things that cost nothing now and are unbuyable later:

- **Name Pro in the 1.0 store listing.** One line — "a Pro tier with buy-box screening across
  search results is coming" — sets the anchor before you have free users who assume there won't
  be one. **[judgement]**
- **Design the license check to transmit an opaque token and no property data**, and say so in
  the policy in those words. The claim is only worth something if it's precisely true.

---

## 7. Suggested sequence

**Now — ship the free 1.0 (days).** Everything here is launch-blocking per §3.0:
§3.2 docs reconciliation → §3.3 Homes.com across `PRIVACY.md`/`LISTING.md`/`README.md`, in the
same pass as §6.3's privacy reword → §6.2's 5-comp cap → §3.1 adapter health surfaced in the
panel → §3.4 one human verification pass → the §6.3 Pro line in the listing copy. Submit.

_Do **not** do the §4.1 kernel extraction in this window._ It is user-invisible, so it buys no
review signal, and it is the longest pole in the document — starting it now delays the thing
whose entire purpose is to start accumulating installs.

**Next — free-tier depth while reviews accumulate, chosen so it also de-risks the paid core.**
§4.6 (IRR) and §4.5 **with Section 8 first** — the HUD import is the cold-start rent basis §4.0.1
needs, so this one item is simultaneously a shipped free mode and the flagship's prerequisite.
STR after. Ship §3.5's comps-in-export alongside — small, and review-bait.

**Then — the rent basis, which is the real §4.1 gate.** Build §4.0.1 route (c): aggregate the
user's own rent comps into a per-ZIP $/sqft, with (d)/HUD as fallback and the three-state
provenance label. **Do this before the kernel refactor**, because it is the piece that can fail:
if per-ZIP $/sqft from a handful of user comps turns out too noisy to badge with, that is much
better discovered in a day of work on stored data than after the refactor is done. It is also
independently useful — a rent suggestion on a single-property card is a free-tier improvement
even if screening never ships.

**Then — the paid core.** §4.1's kernel-extraction refactor, then §4.1 proper. Bring up billing
in parallel (§6.3) so the two land together; there is no point having the feature without a way
to charge for it. §4.2's adjusted/uncapped comps ships in the same release, because Pro launching
with two features reads far better than one.

**Do not** start §4.1 by scoping a rent model (§4.0.1 route (a)). If the cheap basis proves
insufficient *after* real usage, that is the moment to price a model against observed demand —
not before, and not on the strength of this document.

**After — deepen by segment.** §4.3 rehab estimator for flippers, §4.4 PDF one-pager. Re-score
§5's photo-based condition scoring once the license server exists and its marginal cost has
dropped.

**Throughout:** §3.1 scraper health is not a one-off. Every site layout change is a churn event
in the free tier and therefore a funnel event for the paid one.

---

## Sources

Pricing and market structure
- [DealCheck pricing breakdown](https://dealrun.ai/blog/dealcheck-pricing-breakdown)
- [PropStream vs Privy comparison](https://goliathdata.com/propstream-vs-privy-an-investor-s-guide-for-2026)
- [DealCheck comps & ARV help centre](https://help.dealcheck.io/en/articles/3071993-viewing-sales-comps-arv-estimates)
- [DealCheck house-flipping calculator](https://dealcheck.io/features/house-flipping-calculator/)
- [AirDNA vs Mashvisor 2026](https://learn.10xbnb.com/airdna-vs-mashvisor/)
- [AirDNA pricing](https://www.mashvisor.com/blog/airdna-pricing/)

Investor workflow and demand
- [What's slowing down your underwriting](https://www.blooma.ai/blog/cre-underwriting-bottlenecks)
- [Buy box: investor criteria](https://www.realestateskills.com/blog/buy-box-real-estate-investing)
- [What is a buy box](https://retipster.com/terms/buy-box/)
- [AI buy-box fit check](https://blog.creagents.com/ai-task-buy-box-fit-check-single-family-residential-acquisitions/)
- [AI tools for real estate investors](https://reinvestorguide.com/ai-tools-for-real-estate-investors/)

Rehab estimation
- [Estimating rehab costs 2026](https://www.realestateskills.com/blog/estimating-rehab-costs)
- [Rehab calculator](https://www.realestateskills.com/blog/rehab-calculator)
- [Estimating renovation costs (DealMachine)](https://www.dealmachine.com/blog/estimating-renovation-costs)

Extension reviews and monetization
- [Real Estate Analysis Extension reviews](https://chromewebstore.google.com/detail/real-estate-analysis-exte/lfphkkfnhgbjkljhaamchkfchlndjcgb/reviews)
- [Monetize a Chrome extension in 2026](https://fungies.io/monetize-chrome-extension-2026/)
- [ExtensionPay](https://extensionpay.com/)
- [Collecting payments for a Chrome extension in 2026](https://www.extensionfast.com/blog/how-to-collect-payments-for-your-chrome-extension-in-2026)
