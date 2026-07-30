# Feature research: where Investor Sidecar goes next

_Compiled 2026-07-25. Competitive scan + investor-demand research, cross-referenced against what
the code actually computes today._

## What we already have vs. the market

`src/analysis.ts` covers NOI, cap rate, cash-on-cash, DSCR, GRM, operating expense ratio,
break-even occupancy and break-even rent. That is already a wider metric set than most
competitors ship.

What we have **zero** of: a time dimension (no projection, no IRR, no exit modelling), no tax
treatment, no rehab model, no comps.

| Tool | Does | Limits |
|---|---|---|
| DealView | Overlays gross yield, cap, CoC, DSCR on Zillow + Redfin | Point estimates, no projection |
| Ostrich | SFH cash flow on Zillow, adjustable assumptions | Zillow-only |
| REI Lense | Cap/CoC/median rent overlay, free | "First-pass filter"; admits it's shallow |
| Realyst | Adjustable model + GPT-4 commentary | SFH only, Zillow only |
| BetterDeal.ai | AI deal score | "Doesn't replace a full report"; Zillow only |
| Homesage DealFinder | Photo-based condition → ARV → rehab → flip ROI | 15 credits/report, account required |

Every one of these except DealView is Zillow-only, and every one is a triage tool that hands off
to a spreadsheet. Nobody in that list underwrites a whole search page in bulk, and nobody owns
their own model.

Two things follow:

- **Bulk card capture is our structural advantage.** We already inject on 41/41 Redfin cards.
  None of the competitors do this and for us it is mostly built.
- **Computer-vision condition scoring is the one genuinely differentiated thing in the market**
  (Homesage), and it is squarely in our wheelhouse.

## The most important finding about our existing rent model

`/predict_rent` takes `square_feet, bedrooms, bathrooms, price, state, lat, long` and returns
quantiles (p25/p50/p75 plus min/max).

**1. `price` as a rent feature makes the model deal-blind.** A rent model conditioned on list
price partly learns the local price-to-rent ratio. But the deal *is* the deviation from that
ratio — a house whose rent supports more than its price implies. Feeding price in shrinks exactly
the signal we're hunting. Worth training a price-free head and comparing; the gap between the two
predictions is itself a feature ("rent is $340 above what this price implies for this area").

**2. We throw away the distribution.** The quantiles are computed and then used only to draw a
slider range — a probabilistic asset used as UI decoration.

## A. Calculator depth — table stakes we're missing

**A1. Multi-year projection + IRR and exit.** Rent growth, appreciation, selling costs, hold
period, cumulative principal paydown (`getCumulativePrincipalPaid` already exists). The single
biggest gap. Note that the loudest recurring complaint in the BiggerPockets forums is that their
"profit if sold" math is wrong and unverifiable — ours would be tested and transparent.

**A2. After-tax cash flow.** Depreciation on the improvement basis over 27.5 years, interest
deduction, passive-loss rules, marginal rate. Often the difference between "barely breaks even"
and "actually works." Pure arithmetic, no data dependency.

**A3. Sensitivity / stress testing.** Tornado chart or rent × rate heatmap with break-even lines
drawn on it. "Stress-test assumptions before making an offer" came up more than any specific
metric in research on what users of these extensions want. We are two functions away.

**A4. Component-life CapEx instead of flat % of rent.** Roof/HVAC/water-heater age → required
reserve. The underwriting-mistakes literature is unanimous that flat-percentage CapEx is *the*
standard error, and that reserves get forgotten constantly.

**A5. Insurance as a modelled dollar amount, not % of price.** 2026 insurance inflation is
flagged everywhere as the top NOI miss. It is also strongly geographic — a model input, not a
constant.

**A6. Strategy variants on the same house.** LTR / mid-term / STR / house-hack / by-the-room /
Section 8. Each is a different income function over identical inputs. **HUD Fair Market Rents are
a free public dataset** — Section 8 is the cheapest to ship and effectively nobody offers it
in-listing.

**A7. Financing scenarios.** DSCR loan vs conventional vs FHA house-hack, points, ARM. We already
compute DSCR; the useful step is inverting it — "this fails at 1.25; you'd need $X more down or
$Y more rent." 2026 DSCR programs cluster at 1.0–1.25 minimum with 20–25% down.

## B. The intelligence layer

**B1. Probabilistic cash flow.** Propagate the rent quantiles: **"68% chance of positive cash
flow at your assumptions."** A distribution over monthly cash flow instead of one number. No
competitor has anything like it, and it directly answers the standing complaint that AVMs give
false precision — documented Zestimate median error is ~7% off-market, and rental Zestimates are
openly acknowledged to miss by hundreds of dollars. An honest interval is a feature.

**B2. Retrieval comps, not just a number.** kNN over lat/long + beds/baths/sqft, and *show the
comps*. The core investor objection to Zestimate is that it's opaque and ignores income.
Retrieval-plus-explanation is the antidote, and it gives us a debugging surface for our own model.

**B3. Photo-based condition scoring → rehab prior.** The listing photos are already in the DOM,
free. A VLM or CLIP-based condition score feeding a rehab budget is what Homesage charges credits
for. Highest ceiling on the list and the most specific to our strengths.

**B4. LLM extraction from the listing description.** The free text holds roof age,
tenant-occupied status, "as-is", "cash only", seller motivation, actual HOA terms. Also the robust
fix for a class of bug that keeps biting us — the HOA regex fought Zillow's DOM and lost, whereas
an extraction model over description text doesn't care about hashed class names.

**B5. Expected purchase price, not list price.** Both sites expose price history, cuts, and
days-on-market. Predict P(sells below list) and expected discount, then underwrite at *that*
price with list as the pessimistic case. Nobody found doing this; it changes the answer on
marginal deals.

**B6. Deal scoring calibrated against our own board.** "Top 9% of the 140 houses you've saved" is
more trustworthy than an absolute 1–10 score, and needs no external label.

**B7. Address geocoding + market features.** Already flagged as needed — Zillow geo is withheld by
design, so Zillow captures currently get no rent estimate at all. Once coordinates exist: flood
zone, school, permit activity, rent-growth trend. Flood is increasingly a deal-killer via
insurance.

**B8. Reassessment-aware property tax.** We look up a rate by zip, but in TX/FL and similar the
tax *the buyer* will pay ≠ what the seller pays, because the sale triggers reassessment. Cheap,
pure logic, and a real error investors make constantly.

**B9. A calibration harness for our own model.** Are 50% of realized rents actually inside our
IQR? Today that's unanswerable. RentCast's free dev tier (50 calls/month, 140M properties) is a
reasonable eval oracle; Rentometer and HelloData also expose APIs for a second reference.

## C. Workflow

**C1. Bulk underwrite the search page.** Capture and rank every card on a Redfin/Zillow results
page at once. Card injection already works — this is what makes the tool categorically different
from a per-listing overlay.

**C2. Per-market assumption profiles.** Dallas and Chicago don't share vacancy, tax, or insurance.
Global-vs-local config exists; market-level is the missing middle tier.

**C3. Underwrite vs. actuals tracking.** If a user records what a property really did, we get
labels. That's the flywheel, and it's the thing an API vendor cannot sell us.

**C4. Lender-ready one-pager.** Excel export exists; a PDF stating DSCR, reserves and assumptions
is what actually gets sent to a lender.

**C5. Alerts.** New listing in a saved search that pencils at the user's assumptions.

## Recommended order

**Phase 1 — unblock, then deepen the math.** Get the model service running again and add address
geocoding (B7). Rent estimates have never returned data end-to-end and Zillow captures can't get
one at all, so *every* B item is blocked at step zero. Then A1 (projection + IRR) and A3
(sensitivity) — both pure computation over what already exists, both closing our largest gaps
against the field.

**Phase 2 — the differentiator.** B1 probabilistic cash flow, plus fixing the price feature.
Smallest work with the highest payoff-per-line on the list: the quantiles already exist and are
unused, and "68% chance of positive cash flow" is something no competitor can say.

**Phase 3 — pick one big bet.** B3 (photo condition → rehab) has the highest ceiling and the best
fit. B5 (expected purchase price) is the most under-served. B4 (description extraction) is the one
that also pays down scraper fragility, which may be worth more than it looks.

**Explicitly deprioritised:** more raw metrics. We're already ahead of the field on breadth of
ratios. The gap is depth over time, honest uncertainty, and the rehab/condition dimension — not
more numbers in the grid.

## Sources

Competitive scan
- [DealView](https://chromewebstore.google.com/detail/dealview/hphmhbhbhhfgcgodblmbhmnfniijfafm)
- [Ostrich](https://chrome-stats.com/d/aicgkflmidjkbcenllnnlbnfnmicpmgo)
- [BetterDeal.ai](https://chromewebstore.google.com/detail/betterdealai-superchargin/oakahnnikonhaoablelhelloiibpejga)
- [5 Best Browser Extensions for RE Investors (Homesage)](https://homesage.ai/resources/blog/5-best-browser-extensions-for-real-estate-investors-in-2026/)

Investor demand and complaints
- [BiggerPockets rental calculator](https://www.biggerpockets.com/rental-property-calculator)
- [Forum: profit-if-sold calculation error](https://www.biggerpockets.com/forums/25/topics/1183347-rental-property-calculator-profit-if-sold-calculation)
- [Forum: numbers don't match my spreadsheet](https://www.biggerpockets.com/forums/88/topics/300706-biggerpockets-rental-calculator-analysis)
- [Why Zestimate is wrong for investment properties](https://sageregroup.com/zillow-estimate-investment-properties/)
- [Zestimate accuracy 2026](https://irinanorrell.com/how-accurate-is-zillows-zestimate/)
- [Rental Zestimate misconceptions](https://www.amgrents.com/kissimmee-property-management-blog/misconceptions-about-rental-zestimate-that-could-cost-you)

Underwriting practice
- [Value-add underwriting mistakes 2026](https://arcsacapital.com/how-underwriting-works-in-value-add-real-estate/)
- [Hidden cost of leverage for investors](https://www.housingwire.com/articles/hidden-cost-leverage-investors/)
- [DSCR loan requirements 2026](https://www.lendfriendmtg.com/learning-center/dscr-loan-requirements-in-2026-what-you-need-to-qualify)
- [House hacking underwriting 2026](https://mortgage-info.com/blog/qualify-for-mortgage-with-rental-income-2026-fannie-rules)
- [Section 8 investment strategy](https://graystoneig.com/articles/section-8-housing-investment-strategy-2025-by-our-coo-jay)
- [Rental returns & income tax calculator (Stessa)](https://www.stessa.com/rental-returns-and-income-tax-calculator/)

Data sources and ML
- [RentCast data & API overview 2026](https://blog.iq.dwellsy.com/rentcast-data-overview-2026-rental-estimates-and-api-capabilities-explained/)
- [Rent data API vendors (HelloData)](https://www.hellodata.ai/help-articles/which-companies-offer-rent-data-apis)
- [Rentometer pricing & accuracy](https://blog.iq.dwellsy.com/rentometer-what-is-it-pricing-and-accuracy/)
- [Multimodal ML for real estate appraisal (survey)](https://arxiv.org/html/2503.22119v1)
- [AI tools for estimating ARV](https://homesage.ai/ai-tools-for-estimating-property-arv-investor-insights/)
- [Visual AI for property condition (Ximilar)](https://www.ximilar.com/industry/real-estate/)
