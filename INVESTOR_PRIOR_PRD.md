# Investor Prior — SFR Market Intelligence System

A system that builds a structured, evidence-backed investment prior for US single-family rental (SFR) markets. For each metro area, it produces a regime classification, composite acquisition score, momentum signal, yield/supply summary, and an AI-generated plain-language brief.

**Purpose:** Portfolio demo for fractional consulting outreach. All data is public. No scraping. No proprietary sources.

---

## Repository Structure

```
investor-prior/
├── data/
│   ├── raw/                    # Downloaded source files — gitignored
│   ├── processed/              # Normalized, aligned DataFrames (.parquet)
│   └── outputs/                # Pre-computed model outputs per metro (.parquet)
├── src/
│   ├── pipeline/
│   │   ├── ingest.py           # Download + cache all source data
│   │   ├── normalize.py        # Alignment, crosswalks, feature engineering
│   │   └── refresh.py          # Orchestrator — called by GitHub Actions monthly
│   ├── models/
│   │   ├── regime.py           # PELT regime detection + confidence scoring
│   │   ├── score.py            # Composite acquisition score
│   │   ├── momentum.py         # Leading indicator signal
│   │   ├── yield_supply.py     # Yield + supply analysis
│   │   └── base_rates.py       # Historical comparable instance lookup
│   ├── agent/
│   │   ├── schemas.py          # PydanticAI input/output models
│   │   └── brief.py            # Agent invocation + prompt template
│   └── config.py               # Weights, metro list, parameters — YAML-backed
├── app/
│   ├── app.py                  # Streamlit entry point
│   ├── components/             # Chart functions, score display, regime view
│   └── styles.css              # Custom Streamlit CSS overrides
├── .github/workflows/
│   └── refresh.yml             # Monthly cron: runs src/pipeline/refresh.py
├── tests/
├── config.yaml                 # All tunable parameters live here
├── requirements.txt
└── README.md
```

---

## Tech Stack

| Component | Library / Service | Notes |
|---|---|---|
| Language | Python 3.11+ | |
| Data manipulation | pandas | Switch to polars if performance is an issue at scale |
| Changepoint detection | `ruptures` | PELT algorithm, RBF cost function |
| Trend filtering | `statsmodels` | HP filter or L1 trend for pre-smoothing |
| Scoring / normalization | `scikit-learn` | MinMaxScaler, NearestNeighbors for base rates |
| Dashboard | `streamlit` | Hosted on Streamlit Community Cloud |
| Charting | `plotly` | Interactive time-series with changepoint overlays |
| Agent framework | `pydantic-ai` | Structured output; wraps OpenAI API |
| LLM | OpenAI `gpt-4o-mini` | ~$0.01–$0.03 per brief |
| Data storage | Parquet files | No database needed in v1 |
| Hosting | Streamlit Community Cloud | Free tier, public URL, GitHub-connected |
| Scheduling | GitHub Actions | Monthly cron refresh |

### requirements.txt (minimum)
```
pandas>=2.0
ruptures>=1.1
statsmodels>=0.14
scikit-learn>=1.3
streamlit>=1.35
plotly>=5.18
pydantic-ai>=0.1
openai>=1.30
requests>=2.31
pyarrow>=14.0
python-dotenv>=1.0
pyyaml>=6.0
census>=0.8          # Census API wrapper
```

---

## Data Sources

All sources are free and public. No API keys required except Census (free registration).

### Primary Sources

| Source | Dataset | URL | Format | Granularity | Cadence |
|---|---|---|---|---|---|
| Zillow Research | ZORI (rent index) | zillow.com/research/data | CSV bulk download | Metro, zip | Monthly |
| Zillow Research | ZHVI (home value index) | zillow.com/research/data | CSV bulk download | Metro, zip, county | Monthly |
| Redfin Data Center | Median price, DOM, inventory, active listings, closed sales | redfin.com/news/data-center | CSV bulk download | Metro, county, zip | Weekly → aggregate to monthly |
| BLS LAUS API | Unemployment rate, employment level | api.bls.gov | REST JSON | Metro (CBSA), county | Monthly |
| BLS QCEW API | Employment by industry | api.bls.gov | REST JSON | Metro, county | Quarterly |
| Census ACS API | Population, median HH income, housing units | api.census.gov | REST JSON | Metro, county, zip | Annual |
| IRS SOI Migration | County-to-county migration flows | irs.gov/statistics/soi-tax-stats-migration-data | CSV download | County-to-county | Annual (~18mo lag) |
| Census Building Permits | New residential permits | census.gov/construction/bps | CSV / API | Metro, county | Monthly |
| HUD USPS Vacancy | Vacancy rates | huduser.gov/portal/datasets/usps.html | CSV download | Zip code | Quarterly |
| HUD USPS Crosswalk | Zip → CBSA geographic crosswalk | huduser.gov/portal/datasets/usps_crosswalk.html | CSV download | Zip → CBSA | Quarterly |

### Geographic Scope — v1

Top 50 US CBSAs by SFR transaction volume. Define using Redfin transaction data. Store metro list in `config.yaml` as `metros: [list of CBSA codes and names]`.

### Normalization Rules

- All time series aligned to **monthly frequency**. Weekly Redfin data: aggregate to month-end.
- Geographic crosswalk: zip → CBSA using HUD USPS crosswalk file. Join on 5-digit zip.
- **Missing data**: forward-fill up to 3 months. Exclude metro from run if >20% missing in any signal over trailing 24 months.
- **Normalization for scoring**: percentile rank within each signal, computed over full historical window, then across metros. Use `scikit-learn MinMaxScaler` fitted on full history.

---

## Feature Engineering

All derived features are computed in `src/pipeline/normalize.py` after ingestion.

| Feature | Formula | Source Columns |
|---|---|---|
| `rent_growth_6m` | % change in ZORI over 6 months | `zori_value` |
| `rent_growth_12m` | % change in ZORI over 12 months | `zori_value` |
| `rent_growth_24m` | % change in ZORI over 24 months | `zori_value` |
| `appreciation_6m` | % change in ZHVI over 6 months | `zhvi_value` |
| `appreciation_12m` | % change in ZHVI over 12 months | `zhvi_value` |
| `appreciation_24m` | % change in ZHVI over 24 months | `zhvi_value` |
| `price_to_rent_ratio` | `zhvi_value / (zori_value * 12)` | ZHVI, ZORI |
| `gross_yield` | `(zori_value * 12) / zhvi_value` | ZHVI, ZORI |
| `yield_compression_rate` | MoM change in `price_to_rent_ratio`, annualized | derived |
| `months_of_supply` | `active_listings / monthly_closed_sales` | Redfin |
| `absorption_rate` | `closed_sales / (closed_sales + active_listings)` | Redfin |
| `inventory_trend_3m` | % change in `months_of_supply` over 3 months | derived |
| `affordability_index` | `zhvi_value / (median_hh_income / 12)` | ZHVI, Census ACS |
| `employment_growth_3m` | % change in employment level over 3 months | BLS LAUS |
| `employment_growth_12m` | % change in employment level over 12 months | BLS LAUS |
| `permit_growth_6m` | % change in building permits over 6 months | Census BPS |
| `permit_growth_12m` | % change in building permits over 12 months | Census BPS |
| `population_growth_yoy` | Annual % change in population | Census ACS (annual, forward-filled monthly) |
| `net_migration` | In-migration minus out-migration | IRS SOI (annual, forward-filled monthly) |

---

## Model Specifications

### Model A — Regime Detection (`src/models/regime.py`)

**Algorithm:** PELT (Pruned Exact Linear Time) via `ruptures` library.

**Input signals (3 per metro, monthly time series):**
1. `rent_growth_6m` — smoothed with L1 trend filter before passing to PELT
2. `appreciation_6m` — smoothed with L1 trend filter
3. `inventory_trend_3m` — smoothed with L1 trend filter

**PELT parameters:**
```python
import ruptures as rpt

model = rpt.Pelt(model="rbf", min_size=3, jump=1)
breakpoints = model.fit_predict(signal_array, pen=penalty)
# penalty: use BIC-based selection; start with pen=10 and tune on held-out historical windows
```

**Regime classification rules (apply to each detected segment):**

| Condition | Label |
|---|---|
| `rent_growth_6m > trailing_mean` AND `appreciation_6m > trailing_mean` AND `inventory_trend_3m < 0` | `Accelerating` |
| `rent_growth_6m < 0` OR `appreciation_6m < trailing_mean * 0.5` | `Decelerating` |
| Signal agreement < 2/3 (see confidence scoring) | `Transitioning` |
| All others | `Stable` |

**Confidence scoring:**
```python
# Signal agreement: count how many of the 3 signals agree on direction
# Each signal votes: +1 if positive trend, -1 if negative trend
votes = [sign(rent_trend), sign(appreciation_trend), sign(-inventory_trend)]  # note: falling inventory is positive
agreement = abs(sum(votes)) / 3  # 1.0 = full agreement, 0.33 = split
confidence_score = agreement * 100  # 0–100
# If confidence_score < 50: override regime label to "Transitioning"
```

**Outputs per metro (saved to `data/outputs/{cbsa_code}_regime.parquet`):**
```
date, regime_label, confidence_score, changepoint_flag,
regime_duration_months, segment_rent_growth_mean,
segment_appreciation_mean, segment_inventory_change_mean
```

---

### Model B — Composite Acquisition Score (`src/models/score.py`)

**Architecture:** Weighted sum of normalized sub-scores. Rule-based in v1. Weights configurable in `config.yaml`.

**v1 weights:**
```yaml
score_weights:
  rent_growth_12m: 0.25
  appreciation_12m: 0.20
  inventory_tightness: 0.15   # inverse of months_of_supply normalized
  employment_growth_12m: 0.15
  gross_yield: 0.10
  population_growth_yoy: 0.10
  regime_bonus: 0.05           # applied after weighted sum
```

**Normalization:** Percentile rank each feature across all metros at the current date. Scale 0–1.

**Regime bonus/penalty:**
```python
regime_adjustments = {
    "Accelerating": +5,
    "Stable": 0,
    "Decelerating": -5,
    "Transitioning": -2,
}
final_score = min(100, max(0, weighted_sum_score + regime_adjustments[regime_label]))
```

**Outputs per metro:**
```
date, composite_score, percentile_rank_vs_all_metros,
percentile_rank_vs_own_history, sub_score_rent_growth,
sub_score_appreciation, sub_score_inventory, sub_score_employment,
sub_score_yield, sub_score_population, regime_adjustment_applied
```

---

### Model C — Historical Base Rates (`src/models/base_rates.py`)

**Purpose:** Find historical periods across all metros with a similar profile and return outcome distributions.

**Method:** Nearest-neighbor lookup in feature space.
```python
from sklearn.neighbors import NearestNeighbors

# Feature vector for lookup: [composite_score, regime_label_encoded, rent_growth_12m_pct]
# Fit on full historical dataset (all metros, all dates)
nn = NearestNeighbors(n_neighbors=30, metric='euclidean')
nn.fit(historical_feature_matrix)

# For current market state: find 30 nearest historical instances
# Outcome variables: forward_12m_rent_growth, forward_12m_appreciation
# Only include instances where outcome data exists (i.e., not in the last 12 months)
```

**Minimum instances:** If fewer than 20 comparable instances found, flag as `base_rate_unreliable = True`.

**Outputs per metro:**
```
date, base_rate_rent_growth_median, base_rate_rent_growth_p25,
base_rate_rent_growth_p75, base_rate_appreciation_median,
base_rate_appreciation_p25, base_rate_appreciation_p75,
comparable_instance_count, base_rate_unreliable
```

---

### Model D — Momentum / Leading Indicator Signal (`src/models/momentum.py`)

**Leading indicators (move 3–6 months before rent/appreciation):**
- `permit_growth_6m`
- `employment_growth_3m`
- `net_migration` (annual, forward-filled)

**Lagging indicators (for divergence detection):**
- `rent_growth_6m`
- `appreciation_6m`

**Momentum score:**
```python
# Normalize each leading indicator to [-1, +1] using historical percentile rank centered at 0.5
# Weighted composite (equal weights in v1)
momentum_score = mean([norm_permit_growth, norm_employment_growth, norm_net_migration])
# momentum_score > 0.2 → "Strengthening"
# momentum_score < -0.2 → "Weakening"
# else → "Neutral"
```

**Divergence flag:**
```python
# Flag if leading composite direction differs from current regime
# e.g., regime = "Accelerating" but momentum = "Weakening" → divergence = True
leading_direction = "positive" if momentum_score > 0.1 else "negative" if momentum_score < -0.1 else "neutral"
regime_direction = "positive" if regime in ["Accelerating"] else "negative" if regime in ["Decelerating"] else "neutral"
divergence_flag = (leading_direction != regime_direction) and (leading_direction != "neutral")
```

**Outputs per metro:**
```
date, momentum_label, momentum_score, divergence_flag,
top_leading_indicator, permit_growth_signal,
employment_growth_signal, migration_signal
```

---

### Model E — Yield & Supply Analysis (`src/models/yield_supply.py`)

Derived calculations. No trained model.

**Outputs per metro:**
```
date, price_to_rent_ratio, ptr_trailing_12m_change,
ptr_vs_historical_mean_pct, gross_yield_estimate,
gross_yield_p25, gross_yield_p75,         # from zip-level data within metro
yield_compression_direction,               # "compressing" | "expanding" | "stable"
months_of_supply, months_of_supply_trend_6m,
absorption_rate, permit_pipeline_flag      # True if permit_growth_6m > 15% AND months_of_supply rising
```

---

## Agent Layer — AI Prior Brief

### Schemas (`src/agent/schemas.py`)

```python
from pydantic import BaseModel
from pydantic_ai import Agent

class MarketModelOutputs(BaseModel):
    metro_name: str
    cbsa_code: str
    as_of_date: str
    # Regime
    regime_label: str               # Accelerating | Stable | Decelerating | Transitioning
    confidence_score: float         # 0–100
    regime_duration_months: int
    # Score
    composite_score: float          # 0–100
    score_percentile_vs_all: float
    top_positive_dimensions: list[str]
    top_concern: str | None
    # Momentum
    momentum_label: str             # Strengthening | Neutral | Weakening
    divergence_flag: bool
    top_leading_indicator: str
    # Yield
    gross_yield_estimate: float
    yield_compression_direction: str
    price_to_rent_ratio: float
    ptr_vs_historical_mean_pct: float
    # Supply
    months_of_supply: float
    permit_pipeline_flag: bool
    # Base rates
    base_rate_rent_growth_median: float
    base_rate_rent_growth_p25: float
    base_rate_rent_growth_p75: float
    base_rate_appreciation_median: float
    comparable_instance_count: int
    base_rate_unreliable: bool

class PriorBriefReport(BaseModel):
    regime_summary: str             # 2–3 sentences
    investment_attractiveness: str  # 2–3 sentences
    momentum_and_leading_signals: str  # 1–2 sentences
    yield_and_supply: str           # 1–2 sentences
    base_rate_context: str          # 1–2 sentences with numbers
```

### Agent (`src/agent/brief.py`)

```python
from pydantic_ai import Agent
from .schemas import MarketModelOutputs, PriorBriefReport

SYSTEM_PROMPT = """
You are a quantitative real estate investment analyst writing a structured prior brief.
You receive model outputs for a US metro area and write a concise, factual investment brief.
Rules:
- Use plain English. No jargon beyond standard real estate terms.
- Always cite the specific numbers from the inputs. Do not invent figures.
- Write each section in 1–3 sentences only.
- If base_rate_unreliable is True, say so explicitly in the base_rate_context section.
- Tone: direct and analytical. Not promotional.
"""

agent = Agent(
    model="openai:gpt-4o-mini",
    system_prompt=SYSTEM_PROMPT,
    result_type=PriorBriefReport,
)

async def generate_brief(market_outputs: MarketModelOutputs) -> PriorBriefReport:
    result = await agent.run(market_outputs.model_dump_json())
    return result.data
```

---

## Streamlit App

### Entry Point (`app/app.py`)

**Page structure:**
1. Sidebar: metro selector (dropdown, multiselect for comparison)
2. Main area tab 1: Single Metro View
3. Main area tab 2: Market Comparison Table

**Single Metro View — component order:**
1. Header: metro name, as-of date, regime badge (color-coded)
2. Row: Composite Score gauge + sub-score bar chart
3. Row: Regime Detection chart (time series + changepoints)
4. Row: Momentum signal + leading indicator breakdown
5. Row: Yield & Supply summary (P/R ratio chart + supply gauge)
6. Row: Base Rate Context (distribution chart of forward outcomes)
7. Button: "Generate Prior Brief" → calls agent → renders formatted text

**Regime badge colors:**
```python
regime_colors = {
    "Accelerating": "#2ECC71",    # green
    "Stable": "#3498DB",          # blue
    "Decelerating": "#E74C3C",    # red
    "Transitioning": "#F39C12",   # amber
}
```

**Performance requirement:** Page load < 5 seconds. All model outputs are pre-computed parquet files loaded on startup. No live model calls on page load. Only the AI brief call is on-demand.

---

## Configuration (`config.yaml`)

```yaml
metros:
  - cbsa_code: "35620"
    name: "New York-Newark-Jersey City, NY-NJ-PA"
  - cbsa_code: "31080"
    name: "Los Angeles-Long Beach-Anaheim, CA"
  # ... top 50 CBSAs by SFR transaction volume

score_weights:
  rent_growth_12m: 0.25
  appreciation_12m: 0.20
  inventory_tightness: 0.15
  employment_growth_12m: 0.15
  gross_yield: 0.10
  population_growth_yoy: 0.10
  regime_bonus: 0.05

regime_detection:
  pelt_penalty: 10              # tune on held-out data
  pelt_min_size: 3
  pelt_model: "rbf"
  smoothing_method: "l1"        # applied before PELT
  confidence_threshold: 50      # below this → Transitioning override

momentum:
  strengthening_threshold: 0.2
  weakening_threshold: -0.2

base_rates:
  n_neighbors: 30
  min_reliable_instances: 20

pipeline:
  missing_data_ffill_limit: 3   # months
  missing_data_exclusion_threshold: 0.20

llm:
  model: "gpt-4o-mini"
  max_tokens: 800
```

---

## Data Refresh Pipeline (`src/pipeline/refresh.py`)

Orchestrator called by GitHub Actions monthly. Run order:

```python
# 1. Ingest: download/update all source files
ingest.download_zillow()        # ZORI + ZHVI CSVs
ingest.download_redfin()        # Redfin market data CSVs
ingest.fetch_bls_laus()         # BLS LAUS API
ingest.fetch_bls_qcew()         # BLS QCEW API
ingest.fetch_census_acs()       # Census ACS API
ingest.download_irs_migration()  # IRS SOI (annual)
ingest.download_permits()        # Census Building Permits
ingest.download_hud_vacancy()    # HUD USPS vacancy

# 2. Normalize: align, crosswalk, compute features
normalize.run_pipeline()         # outputs to data/processed/

# 3. Models: run all models, write outputs
for cbsa_code in config.metros:
    regime.run(cbsa_code)
    yield_supply.run(cbsa_code)
    score.run(cbsa_code)
    momentum.run(cbsa_code)
    base_rates.run(cbsa_code)

# 4. Validate: check for missing outputs, flag anomalies
validate.check_all_metros()
```

### GitHub Actions (`/.github/workflows/refresh.yml`)

```yaml
name: Monthly Data Refresh
on:
  schedule:
    - cron: '0 6 1 * *'    # 1st of each month at 6am UTC
  workflow_dispatch:         # allow manual trigger

jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: '3.11' }
      - run: pip install -r requirements.txt
      - run: python src/pipeline/refresh.py
        env:
          CENSUS_API_KEY: ${{ secrets.CENSUS_API_KEY }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      - uses: stefanzweifel/git-auto-commit-action@v5
        with:
          commit_message: "chore: monthly data refresh"
          file_pattern: "data/processed/*.parquet data/outputs/*.parquet"
```

---

## Environment Variables

```bash
# .env (gitignored)
CENSUS_API_KEY=your_census_api_key      # free: api.census.gov/data/key_signup.html
OPENAI_API_KEY=your_openai_api_key      # for brief generation only
```

---

## Build Sequence

Build in this order. Each phase produces independently testable output before proceeding.

| Phase | Files | Validation |
|---|---|---|
| 1 — Data pipeline | `ingest.py`, `normalize.py` | `data/processed/` has clean parquet for all metros; no >20% missing |
| 2 — Model E (yield/supply) | `yield_supply.py` | Verify P/R ratio for a known metro (e.g., Austin) matches manual calc |
| 3 — Model A (regime) | `regime.py` | Changepoints on Phoenix 2020–2024 should detect 2021 acceleration and 2023 deceleration |
| 4 — Model C (base rates) | `base_rates.py` | Comparable instance count > 20 for major metros |
| 5 — Model B (score) | `score.py` | Scores should distribute across 20–80 range; no clustering at extremes |
| 6 — Model D (momentum) | `momentum.py` | BLS + Census data integrated; verify divergence flag fires correctly |
| 7 — Streamlit app | `app/` | Cold load < 5s; regime chart renders for all 50 metros |
| 8 — Agent layer | `agent/` | Brief generates in < 10s; output validates against PriorBriefReport schema |

---

## Open Questions (Decisions Needed Before Build)

| # | Question | Recommended Default |
|---|---|---|
| Q1 | Metro universe: 50 CBSAs or start smaller? | Start with 30; expand to 50 before launch |
| Q2 | Show score weights to users in the UI? | Yes in v1 — builds trust for demo context |
| Q3 | LLM provider: OpenAI vs Anthropic? | OpenAI gpt-4o-mini — cheaper, PydanticAI well-tested with it |
| Q4 | Include zip-level data in v1? | No — metro-level only; zip is v2 |
| Q5 | IRS migration data lag handling (~18 months)? | Use as structural annual signal; supplement with Census ACS 1-yr estimates for recency |
| Q6 | Public or private GitHub repo? | Public — demo credibility requires inspectable code; use .env for secrets |
| Q7 | Streamlit Community Cloud vs self-hosted? | Streamlit Community Cloud — free, zero infra overhead for v1 |