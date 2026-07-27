# Calculator modes

_Written 2026-07-27, updated on completion. Companion to
[architecture.md](./architecture.md); the strategy rationale is in
[feature-research.md](./feature-research.md) §A6._

**Status: shipped.** Buy-and-hold, fix-and-flip and BRRRR are all registered, with undo,
per-mode card metrics and a per-strategy spreadsheet. Four things below changed during
implementation and are marked **[revised]**; the reasoning that led to each is kept, because
the wrong version is the more instructive half.

The same house evaluated under different strategies: buy-and-hold, fix-and-flip, BRRRR.
A mode is chosen globally and overridable per card.

`src/modes.ts` already carries the seam — a `CalculatorMode` registry, `resolveMode` with
override-wins semantics, `globalParams.mode`, `localParams.mode`, and a picker hidden behind
`hasMultipleModes`. Selecting a mode is done. What is not done is everything that makes a
non-rental mode *representable*.

## 1. Scope and locked decisions

| Decision | Resolution |
| --- | --- |
| "Direct buy and rent" | The existing `rental` mode; all-cash is 100% down, not a mode |
| Mode selector | Tiles — always visible in Global Parameters; chip-that-expands-to-tiles on cards |
| Mode on capture | Inherit the global default; `localParams.mode` written only by explicit user action |
| Param storage | One flat namespace — switching modes never destroys another mode's inputs |
| Export | Index sheet + one sheet per mode; no `Mode` column inside per-mode sheets; skip empty sheets |
| Undo scope | House delete, param edits, per-card mode switch. Global params excluded (get "Reset to defaults") |
| Flip financing v1 | Conventional loan reusing existing `percentDown`/`interestRate`; hard money is a later param |
| Missing flip/BRRRR inputs | No heuristic ARV defaults — tiles show a "needs ARV" CTA; entry flow is the feature |
| Excluded modes | Wholesale (not on retail listings), multifamily (needs a unit-mix model), STR/house-hack (Phase 3) |

### Why these three modes

Every serious calculator ships Rental / Flip / BRRRR (BiggerPockets, DealCheck). Wholesale
appears often but is a four-field form, and wholesale deals are not on retail Redfin/Zillow —
the only place this extension runs. STR is the most-requested addition but it is not a new
model, it is a different income function over the identical expense engine, which is why it
is cheap to add later and not worth blocking on now.

## 2. Architecture target

### 2.1 Result shape

`analyze()` returns rental-shaped `HouseAnalysis`, and `metrics.ts`, `export.ts` and
`sortMetric` all read its fields directly. A flip has no NOI, no DSCR, no cap rate.

```ts
export interface DealSummary {
  price: number;
  totalCashInvested: number;
}

export type ModeAnalysis =
  | { mode: 'rental'; summary: DealSummary; detail: RentalAnalysis }   // today's HouseAnalysis
  | { mode: 'flip';   summary: DealSummary; detail: FlipAnalysis }
  | { mode: 'brrrr';  summary: DealSummary; detail: BrrrrAnalysis };

export type AnalysisResult =
  | { ok: true; analysis: ModeAnalysis }
  | { ok: false; reason: string };
```

`analyze()` widens to one input object — flip and BRRRR need square footage for
rehab-per-sqft, which the current signature cannot supply:

```ts
analyze(input: {
  house: { price: string | number | null; hoa: number | null; sqft: string | null };
  overrides: Partial<Record<ParamKey, number | null>>;
  globals: GlobalParameters;
}): AnalysisResult
```

### 2.2 Mode-scoped metrics

```ts
interface MetricDef<A> {
  key: MetricKey;                     // stays one global union, so storage stays a flat string list
  label: string; longLabel: string; testId: string;
  value:  (a: A) => number | null;    // NEW — powers sorting and export generically
  format: (a: A) => string;
  tone:   (a: A) => StatTone;
}
```

A mode carries `metrics: MetricDef<ItsDetail>[]` and `defaultMetrics: MetricKey[]`. Types
hold inside each mode and erase only at the single render call site that already knows its
resolved mode. Splitting `value` out of `format` is what lets sorting and export work on any
metric of any mode without a per-metric switch.

### 2.3 Param registry — `src/params.ts`

The move `metrics.ts` already made, applied to inputs. Today the same eleven-field list is
repeated in four places: `House.localParams`, the card's `useState` block, the
`saveLocalParams` payload, and `analyzeStoredHouse`.

```ts
interface ParamDef {
  key: ParamKey;
  label: string;
  unit: 'percent' | 'dollar' | 'months';
  max?: number;
  inheritsFrom?: keyof GlobalParameters;  // absent ⇒ per-house only (ARV, rehab budget)
}
```

`localParams` becomes `{ mode?: ModeId | null } & Partial<Record<ParamKey, number | null>>`.
The card renders inputs by iterating its mode's sections. `applyLocalParams`
(`house-storage.js`) already merges shallowly, so new keys survive with no worker change.

New keys — **flip**: `arv`, `rehabBudget`, `holdMonths`, `sellingCostRate`, `maoRulePercent`.
**brrrr**: those plus `refiLtv`, `refiRate`, `refiCostRate`, `seasoningMonths`.

`sliderValue` keeps its storage key as the `monthlyRent` param's alias; renaming is a stored-data
migration touching the worker and tests, and it buys nothing this feature needs.

**One flat namespace, deliberately.** A house switched flip → rental keeps its ARV and rehab
budget, so switching back restores them. This makes mode switching non-destructive by
construction, which is the cheapest and most important form of undo.

**Shared operating view.** `OperatingBreakdown` in `analysis.ts` is the income-and-expenses
shape a rental and a stabilized BRRRR have in common — financing-independent by construction,
which is exactly why it survives the loan being replaced. Both modes' details extend it, so
the card's expense waterfall renders either; only the lines *below* NOI differ, and those are
supplied per mode. A flip has none of it, having no tenant.

### 2.4 Card sections declared by the mode

```ts
interface SectionDef {
  id: string; label: string;
  params: ParamKey[];
  summary?: (a: ModeAnalysis) => string;                   // the collapsed-row value
  detail?: 'generic' | 'rentChart' | 'expenseWaterfall';   // only these two stay bespoke
}
```

| Mode | Sections |
| --- | --- |
| Rental | Purchase · Rent · Expenses |
| Flip | Purchase · Rehab · Resale |
| BRRRR | Purchase · Rehab · Rent · Operating · Refinance |

Three `isXDropdownOpen` booleans collapse to one `openSection: string | null`.

### 2.5 Modes declare what they need

`requires: ParamKey[]` per mode. Unresolvable ⇒ the card shows a needs-input prompt — the
existing `needs-rent-hint` pattern — rather than the amber error box. Missing input is not an
error.

**[revised]** Flip requires only `arv`, not `rehabBudget`: a cosmetic flip can genuinely have
a zero rehab budget, and requiring it would make a legitimate deal look unfinished. Relatedly,
the kernels *compute* for a zero ARV rather than rejecting it, because zero means "not entered
yet" and erroring showed a validation message for a field the user had not reached. The card's
precedence is failure, then prompt, then figures — a failure first because an unreadable price
is the one thing entering more numbers cannot fix.

## 3. Plumbing: write cadence, echo suppression, `rev`

**This is the highest-risk work in the plan and it goes first.** Everything else is
type-shuffling under test coverage; this is the only part touching a live race between three
writers (card, worker, undo).

The problem, verified in the code: every card save round-trips per keystroke
(`handleInput` commits per keystroke; the save effect's deps include every param value), and
`mutateStoredHouses` calls `notifySidePanel` on *every* mutation. Cards currently ignore
incoming props — all local param state lives in `useState` initializers under a stable
`key={houseKey(house)}` — which is simultaneously (a) why that echo storm is harmless today
and (b) why an undo or enrichment write can never reach a mounted card.

They have already hit (b) once and patched it for a single field: an effect exists solely to
sync `localPropertyTaxRate` when background enrichment writes it.

Three coordinated changes:

1. **Save on blur/debounce, not per keystroke.** Commit a field-edit session at the
   `handleBlur` boundary, with a debounce safety net. *Stated behavior change:* closing the
   panel mid-edit loses the in-flight field. Side benefit: kills the per-keystroke
   `sortHouses`/`analyzeStoredHouse` recompute when sorting by a metric.
2. **`rev` counter per house**, bumped by the worker on every mutation, missing treated as 0.
3. **`useHouseParams` reducer** replacing the per-field `useState` block: accepts an incoming
   house from props when its `rev` is newer than the last rev this card wrote or saw. Own
   echoes are skipped; foreign writes land. This is the `lastEmitted` pattern from
   `useNumericTextBuffer`, applied at house level. Retires the one-off tax-sync effect.

## 4. Undo

The log lives in the **service worker at the `mutateStoredHouses` chokepoint** — the sole
serialized writer of `storedHouses`, which both `removeHouse` and `updateLocalParams` already
pass through. Not in React.

```js
mutateStoredHouses(fn, { label, undoable = true })
// pushes an inverse entry: the touched house's prior record + its array index
```

- **Granularity.** One entry per field-edit session (guaranteed by the blur cadence — no
  worker-side coalescing needed), one per mode switch, one per delete.
- **Inverse semantics.** Undo of an *edit* restores only `localParams`; never the whole
  record, because enrichment may have landed since. Undo of a *delete* restores the full
  record at its original index. This is the mirror of the discipline
  `mergeEnrichmentIntoLatest` already enforces in the other direction.
- **[revised] The delete-undo loose end does not exist.** The audit assumed `removeHouse`'s
  `houseRemoved` message maintained button state worth reversing. It has no listener at all,
  and the injected button flashes "Added" for 1.8s and returns to idle regardless. Nothing to
  invert; the message is dead code.
- **Persistence.** Capped at 20 entries in `chrome.storage.local`, so it survives panel close.
  The log write is not atomic with the houses write, so **validate each entry against current
  state before applying** — a stale entry is dropped, not trusted.
- **Surfacing.** A toast with an Undo button after delete and mode switch; `Cmd+Z` bound as
  well. The toast is what people will actually use in a side panel. No redo in v1.
- **Out of scope.** `globalParams` is written directly by the panel, outside the chokepoint.
  It gets "Reset to defaults" instead, and the global mode tiles get an "affects all houses"
  hint to soften the undoability asymmetry between the two levels of the same control.

Deleting a house is currently unrecoverable and fires with no confirmation. That is the worst
data loss this app can inflict, and it is independent of modes — if undo ships in any form,
it ships that first.

## 5. UI

**Global tiles.** Replace the hidden `<select>` in `ParametersSelector` with an always-visible
tile row (label + one-line description from `CalculatorMode`). Below it, mode-scoped global
assumptions render in **collapsible per-mode groups** driven off the param registry, only the
default mode's group expanded. Without this the panel roughly doubles in length with fields
the user's default mode never reads.

**Card chip → tiles.** Collapsed, one chip on the existing header line — `[Buy & Hold ▾]` —
with the grey/blue dot convention `PercentOverrideField` already uses for
inherited/overridden. Tapping expands three tiles, computed **lazily on expand**, each showing
its mode's headline number when computable or its `requires` CTA ("needs ARV") when not.

This respects a constraint the codebase has repeatedly fought for: `StatChip` exists because
stacked chips cost the card 80–100px of height. An always-on tile row per card walks that
back. It also avoids a worse problem — on a freshly captured board, ARV and rehab budget are
per-house by nature and have no sensible default, so two of three tiles would read "needs ARV"
permanently. **The CTA is the designed-for state**: needs-ARV → tap → focused entry → tile
fills in. Fabricating an ARV (1.2 × price or similar) to avoid the blank is exactly the false
precision `feature-research.md` argues against.

**Sorting.** `SortOrder` becomes `MetricKey | 'newest'`, ranked via `MetricDef.value`. Houses
whose mode lacks that metric return `null` and sink to the bottom — the existing behavior in
`sortHouses`, which falls out for free. Options list the union of metrics offered by modes
present on the board.

**Card metric strip.** `cardMetrics` becomes `Partial<Record<ModeId, MetricKey[]>>`;
`resolveCardMetrics(stored, mode)` validates against that mode's offerings and falls back to
its `defaultMetrics`. A global list of rental keys is meaningless for a card in flip mode.

## 6. Math

### Flip

Conventional financing in v1, reusing the configured `percentDown`/`interestRate`.
`MortgageCalculator` is unchanged.

**[revised]** Holding cost is **interest-only**, not full P&I. Principal is not an expense --
it is a transfer that reduces what is owed at closing -- and profit here is computed from the
whole purchase price, so charging principal as a carrying cost subtracts the same money twice.
It is also how flips are financed in practice.

```
acquisitionCosts = price × closingCostRate
holdingCosts     = (interest + tax + insurance + HOA) × holdMonths
sellingCosts     = arv × sellingCostRate                   // default 7
netProfit        = arv − price − rehabBudget − acquisitionCosts − holdingCosts − sellingCosts
cashInvested     = downPayment + rehabBudget + acquisitionCosts + holdingCosts
roi              = netProfit / cashInvested
annualizedRoi    = roi × 12 / holdMonths
mao              = arv × maoRulePercent/100 − rehabBudget   // maoRulePercent default 70
```

Metrics: `netProfit`, `flipRoi`, `annualizedRoi`, `mao` (toned against list price),
`totalProjectCost`, `holdingCosts`. Card defaults: `mao`, `netProfit`, `flipRoi`.

`maoRulePercent` is a parameter, not a hardcoded 0.70. Investors run 65–75% by market, and a
buried constant invites exactly the "your math is wrong and I can't see why" complaint the
BiggerPockets forums are full of.

### BRRRR

Phase A is flip's acquisition and rehab; Phase B is rental operations against the new loan.

```
newLoan        = arv × refiLtv/100                          // default 75
payoff         = originalLoan.getBalanceAtMonth(holdMonths + seasoningMonths)
cashOut        = newLoan − payoff − arv × refiCostRate/100
cashLeftInDeal = phaseACashInvested − cashOut               // ≤ 0 ⇒ all capital returned
equityCaptured = arv − (price + rehabBudget)
postRefi*      = rental engine re-run at loan = newLoan, rate = refiRate
postRefiCoC    = annualCashFlow / cashLeftInDeal            // null when ≤ 0
```

Requires one addition to `MortgageCalculator`:
`getBalanceAtMonth(m) = loanAmount − getCumulativePrincipalPaid(m)`. Added and tested in
Phase 1 so Phase 2 inherits it green.

Metrics: `cashLeftInDeal`, `postRefiCashFlow`, `postRefiCoC`, `refiDscr`, `equityCaptured`.
Card defaults: `cashLeftInDeal`, `postRefiCashFlow`, `postRefiCoC`.

The infinite-return case (`cashLeftInDeal ≤ 0`) returns `null` and displays "∞ / all capital
returned", following the existing null-over-`Infinity`/`NaN` convention in `analysis.ts`.

## 7. Storage and migration

`paramsVersion` → **3**, in `migrateGlobalParams`:

- `cardMetrics: MetricKey[]` → `{ rental: <existing array> }`
- New mode-scoped global defaults land via the existing spread-under-defaults path, free
- Houses: missing `rev` treated as 0; an unknown `localParams.mode` already falls back
  through `resolveMode` and keeps doing so

## 8. Export

- **Index sheet**, first: Address, Mode, Purchase Price, Total Cash Invested (from
  `DealSummary`), headline metric and its name, URL, Notes.
- **Per-mode sheets**: columns from that mode's params and metrics via `MetricDef.value`.
  `buildSummaryRow`'s sum/average column lists are defined per mode, where they stay
  meaningful. Empty sheets are skipped.

## 9. Phasing

Every phase lands green and shippable on its own.

| Phase | Contents | Exit criterion |
| --- | --- | --- |
| **0a — plumbing** | Blur/debounce save cadence · `rev` + echo suppression · `useHouseParams` | Typing is smooth with N cards; an external write to a mounted card's `localParams` renders without remount |
| **0b — result shape** | **Golden characterization test first** · `{summary, detail}` union · mode-scoped `MetricDef` with `value` · `analyze()` input object · sorting on `MetricKey` · `cardMetrics` v3 migration | Golden test passes **unedited**; all suites green |
| **0c — param registry** | `src/params.ts` · flat `localParams` · sections from registry · per-mode global groups | Card UI equivalent for rental; the four duplicated field lists are gone |
| **0.5 — undo** | Worker log · delete/edit/mode-switch inverses · toast + `Cmd+Z` · content-script button restore · validate-before-apply | Delete → undo restores the house at its original index and fixes the listing button |
| **1 — Flip** | `flip.ts` + metrics + sections + `requires` CTA · global tiles · card chip→tiles · `getBalanceAtMonth` | A flip house with ARV/rehab entered shows correct chips, sorts, and exports |
| **2 — BRRRR** | `brrrr.ts` · refi event · infinite-return convention · index + per-mode export sheets | A mixed 3-mode board sorts, exports, and round-trips undo |
| **3 — later** | STR · house hack · persistent side-by-side compare · hard-money financing · redo | — |

### What Phase 3 inherits

The seam holds: a new mode is a kernel, a metric list, a section list and a registry entry.
The two things a fourth mode would still touch are the `ModeId` union and `MetricKey`, both
deliberately explicit so an unregistered id is a compile error rather than a silent fallback.

Known limitations, none blocking:

- The expense waterfall is rental-only. BRRRR's operating section renders generic fields
  instead, so it lists rates without the computed line each one drives.
- A collapsed section shows `—` for its summary on flip's rehab and resale rows, which have
  no single figure that summarises them. The metric strip carries the headline numbers.
- Property tax after a BRRRR refinance is modelled on ARV. Reassessment is genuinely
  jurisdiction-specific (feature-research B8); this is the conservative reading.

Undo lands before Flip so the first mode switch any user ever makes is already reversible.

### On "existing tests still pass" as a proof

It isn't one, for 0b. Reshaping the result forces mechanical edits to `metrics`, `export` and
`analysis` suites, and tests that were themselves edited passing proves the edits compile, not
that behavior survived. So 0b opens by capturing a golden characterization test — a matrix of
houses × assumptions with exact current numbers, in the spirit of the existing "rental mode
produces exactly what analyzeHouse produces" assertion. That file is the invariant, and it
should not need a single edit through 0b and 0c.

## 10. Risks

| Risk | Mitigation |
| --- | --- |
| 0a regresses typing or loses edits | Golden + existing `house-persistence`/`numeric-input` suites; the blur-loses-in-flight-edit tradeoff is a documented decision |
| Refactor silently changes numbers | The golden test is the invariant and is never edited in 0b/0c |
| A stale undo entry corrupts a record | Validate against current state before applying; drop, don't trust |
| Panel bloat from mode-scoped globals | Per-mode collapsible groups, only the default mode expanded |
| Flip tiles read as broken ("needs ARV" everywhere) | The CTA is the designed entry point; no fabricated defaults |

Open call, non-blocking, decide in Phase 1: whether card tiles stay collapsed by default
(the recommendation, protecting card height) or a setting flips them always-on.
