# Refactor: break up App.tsx around HouseCard

Status: planned, not started. Written 27 July 2026.

## Why

`src/App.tsx` is 1,788 lines — 29% of all shipped code in one file — and `HouseCard`
alone runs lines 693–1340 (**648 lines**). This is not a style complaint. Both bugs found
during store-readiness review lived in that file, and the second was caused directly by
its size:

- **c36067d** — the metric strip truncated its headline figures at every width below
  440px (`MAO $316...`, `LEFT IN $63,7...`).
- **c192cbf** — switching strategy with a dropdown open blanked the whole panel.
  `openSection` outlives `mode`, section ids are per-mode, and the stale lookup was
  asserted away with a `!`. At 648 lines nobody can hold "open section" and "current
  mode" in their head at once, so nobody noticed they could disagree.

There is also a real circular dependency: `App.tsx` imports values from `modes.ts`,
`export.ts`, `params.ts` and `useHouseParams.ts`, and all four import `House` /
`GlobalParameters` types *back* from `App.tsx`. It is harmless today only because the
back-edges are type-only and erased at runtime — three of those files carry a comment
apologising for it.

**Goal:** no file over ~450 lines, `HouseCard` reduced to a shell that composes section
components, types in a leaf module, and the dead recharts chunk out of the package.
Behaviour identical.

This is intended to land **before** the first Chrome Web Store submission, so it must be
behaviour-preserving and fully re-verified — including a manual pass in Chrome, because it
changes the build that was last smoke-tested by hand.

## The constraint that shapes everything

15 test files import from `../src/App`. `DEFAULT_GLOBAL_PARAMETERS` alone is imported by
all 15; `House` and `GlobalParameters` by most; `HouseCard` by 6.

**Do not update the test imports.** Move each definition to its new module, then
re-export it from `App.tsx`:

```ts
export type { House, GlobalParameters } from './types';   // `export type` is required:
export { DEFAULT_GLOBAL_PARAMETERS } from './settings';   // tsconfig has isolatedModules
export { HouseCard } from './card/HouseCard';
```

This is the whole risk-management strategy. **Every file in `test/` stays byte-identical**,
so the existing 518 tests become an unmodified regression net: if they still pass, the
refactor preserved behaviour. Touching the tests and the source in one pass would destroy
that signal.

`src/main.tsx` imports `SidePanel` as the default export and `test/undo-panel.test.tsx:110`
does a dynamic `await import('../src/App')` for it — so `SidePanel` must stay in `App.tsx`
as the default export.

Other constraints: no path aliases and no barrel file (`tsconfig.app.json` has no
`paths`), so use relative imports. `noUnusedLocals` and `noUnusedParameters` are on, which
is useful — leftover dead code after an extraction becomes a compile error.

## Step 1 — `src/types.ts`, and kill the cycle

Move `House` (L32), `GlobalParameters` (L89), `StoredLocalParams` (L77), `RentEstimate`
(L24) and `SortOrder` (L1347) into a new leaf `src/types.ts` that imports nothing from
`App.tsx`. Note `RentEstimate` is currently *not* exported — it will need to be, since
`HouseCard` and `RentSection` both reference it once they are separate modules.

`StoredLocalParams` and `SortOrder` have no consumer outside `App.tsx` today, so they need
no compatibility re-export; only `House` and `GlobalParameters` do.

Repoint the four back-edges — `src/modes.ts:11`, `src/export.ts:5`,
`src/useHouseParams.ts:3`, `src/params.ts:1` — at `./types`, and delete the
"type-only, so this is erased" comments, which stop being true because the cycle is gone.

Do this step alone and run the suite. It is pure motion with no logic, so a failure here
is unambiguous.

## Step 2 — the shared leaves `HouseCard` needs

`HouseCard` cannot move above things it depends on without creating a *new* cycle, so
these move first, each to a module that imports only from `types.ts` and below:

- **`src/format.ts`** — `formatMoney` (L235), `formatPercent` (L238), `displayPrice`
  (L241), `EM_DASH` (L570). While here: `formatPercent` returns a bare `'—'` literal
  instead of `EM_DASH`; unify them.
- **`src/settings.ts`** — `DEFAULT_GLOBAL_PARAMETERS` (L142), `CURRENT_PARAMS_VERSION`
  (L136), `RENT_SCALED_RATE_KEYS` (L170), `migrateGlobalParams` (L197), `cardMetricsFor`
  (L220). `cardMetricsFor` in particular *must* move: both `HouseCard` and
  `ParametersSelector` call it, so leaving it in `App.tsx` recreates the cycle in the
  opposite direction.
  **Leave `houseKey` (L230) in `App.tsx`** — its only consumer is `SidePanel` (L1523);
  the JS twin in `public/scripts/house-storage.js` is what the tests exercise.
- **`src/fields.tsx`** — `useNumericTextBuffer` (L255), `ParamField` (L353),
  `GlobalNumberField` (L419), `ReadOnlyRowValue` (L491), `StatChip` (L456). Shared by both
  `HouseCard` and `ParametersSelector`, which is exactly why they belong in neither.

Re-export the test-visible names (`DEFAULT_GLOBAL_PARAMETERS`, `CURRENT_PARAMS_VERSION`,
`migrateGlobalParams`) from `App.tsx`.

## Step 3 — split the section bodies out of `HouseCard`

This is the point of the exercise. `renderDropdownContent` (932–1166, **235 lines**) is a
three-branch switch inside the component; the branches share nothing, so it is a natural
split point. Each has a small, measured set of closure dependencies:

| New component | From lines | Props it needs |
|---|---|---|
| `card/RentSection.tsx` | 934–1050 (117) | `predictedRent`, `rentBounds`, `sliderValue`, `setParam` |
| `card/ExpensesSection.tsx` | 1052–1129 (78) | `operating`, `financing`, `analysisReason`, `params`, `globalParams`, `setParam`, `commit` |
| `card/PurchaseSection.tsx` | 1131–1165 (35) | `house`, `params`, `globalParams`, `summary`, `setParam`, `commit` |
| `card/ParamListSection.tsx` | 916–930 (15) | `section`, `params`, `globalParams`, `setParam`, `commit` |

Note the expenses branch reads `operating` (the `OperatingBreakdown | null` derived at
783–786), **not** `rental` — and it contains a closure-free inner `Line` component
(1063–1068) that should become a small local component in the new module.

Follow the existing precedent in `src/RentChart.tsx`: default export, explicit inline
props type, a doc comment saying why the module exists.

**Move `renderSection` and `renderDropdownContent` together.** `renderSection` (911–930)
forward-references `renderDropdownContent` (932); splitting one without the other means
rewiring both. `renderSection` becomes a small dispatcher on `section.detail` /
`section.id`, and **keep the `undefined` guard added in c192cbf** (the IIFE at 1334–1338)
— do not reintroduce a `!`. That guard is what stops a stale open section from taking the
whole panel down.

Also move `ModePicker` (583–691) to `card/ModePicker.tsx`, taking `SHORT_PROMPT`
(577–581) with it — `ModePicker` is its only consumer. And lift the closure-free inner
`DropdownArrow` (730–739) into `fields.tsx`; it reads nothing but its `isOpen` prop.

Leave inside `HouseCard`: `pickMode` (833–858, closes over `commit` and `onModeChanged`)
and `getRentBounds` (867–888, feeds the slider bounds passed to `RentSection`).
`sectionSummary` (891–903) is pure over its inputs and can go either way — simplest to
leave it, since only the card's section rows use it.

## Step 4 — drop the unreachable rent chart

Nothing populates `house.rentEstimate` until the authenticated tax/rent service returns
(see the README section on it), so the chart cannot render — yet
`dist/assets/RentChart.js` (~409 kB of recharts) ships in every package.

In `card/RentSection.tsx`, remove the `lazy(() => import('./RentChart'))` call site
(currently `App.tsx:5`, sitting oddly inside the import block), the `<Suspense>`/
`<RentChart>` block (1043–1050), and the chart-only math at 936–974 — `rawValues`,
`clampedValues`, `chartTicks` exist solely to feed the chart. That is ~39 lines of the
rent branch's 117 gone on its own, leaving `RentSection` at roughly 70 lines.

**Keep `getRentBounds`** — it also drives the slider's min/max, so it is not chart-only.

Leave `src/RentChart.tsx` on disk, and update its doc comment, which currently claims
"App.tsx loads it with React.lazy". Update the README's tax-and-rent-service section too:
restoring the chart becomes re-adding the call site in `RentSection`, not `App.tsx`.

Expected: package drops from ~366 kB to roughly 240 kB.

## Target layout

Line estimates are a smell test, not a target to hit exactly.

| File | ~Lines | Holds |
|---|---|---|
| `src/types.ts` | 120 | `House`, `GlobalParameters`, `StoredLocalParams`, `RentEstimate`, `SortOrder` |
| `src/format.ts` | 30 | `formatMoney`, `formatPercent`, `displayPrice`, `EM_DASH` |
| `src/settings.ts` | 110 | defaults, `migrateGlobalParams`, `cardMetricsFor` |
| `src/fields.tsx` | 190 | `useNumericTextBuffer`, `ParamField`, `GlobalNumberField`, `ReadOnlyRowValue`, `StatChip`, `DropdownArrow` |
| `src/card/HouseCard.tsx` | 400 | the shell: derived analysis, verdict strip, section rows |
| `src/card/ModePicker.tsx` | 110 | picker + `SHORT_PROMPT` |
| `src/card/RentSection.tsx` | 70 | slider (chart removed in step 4) |
| `src/card/ExpensesSection.tsx` | 90 | waterfall + interleaved rate fields |
| `src/card/PurchaseSection.tsx` | 50 | purchase fields + cash-invested footer |
| `src/card/ParamListSection.tsx` | 30 | generic fallback body |
| `src/App.tsx` | 450 | `SidePanel` (default), `Title`, `ParametersSelector`, `UndoToast`, `houseKey`, sorting, re-exports |

No file over ~450 lines, down from one at 1,788.

## Verification

Run in order; each is a distinct signal.

1. **`npx tsc -b`** after *every* step. With `noUnusedLocals` on, a symbol left behind
   after a move is a compile error — use it as the completeness check.
2. **`npx vitest run` — expect 518 passing, with `git diff --stat test/` empty.** If any
   test file changed, the regression net is compromised; revert the test edit and fix the
   source instead.
3. **`npm run lint`** — 0 errors (6 pre-existing `react-refresh` warnings). These may
   *drop*: several exist only because `App.tsx` mixes components with non-component
   exports, which this refactor fixes.
4. **`npm run harness`**, then in a fixed-width iframe:
   - the width sweep from the README — expect **0 clipped elements at 320–440 px**;
   - the mid-edit crash repro — open the Rent dropdown, type a rent, switch to Fix and
     flip inside the 400 ms debounce. Panel must stay up, no uncaught errors, the rent
     must be in `storedHouses`, and switching back must restore it.
5. **`npm run package`** — expect 15 files and roughly 240 kB, with no `RentChart.js`.
6. **Manual pass in Chrome — required, because this ships before submission.** Load
   `dist/` unpacked, save a real listing from Redfin and one from Zillow, switch a card
   through all three strategies, delete one, undo, and export the workbook.

## Sequencing

Land steps 1–4 as **four separate commits**, running the suite between each. Step 3 is the
only one with real risk; keeping it isolated means a bisect lands on it directly.

Do not combine this with the test-hardening follow-up (spreading `mode-picker.test.tsx`'s
broadcast-`rerender` pattern to the other card tests). That is worth doing — it is what
made both of the above bugs visible to a test at all — but it changes the tests, which is
precisely the signal this refactor depends on holding still. Separate commit, after.
