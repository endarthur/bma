# C1a Design — Property Catalog (data tree, step 1)

Design note, 2026-06-11. Status: **design pass, not implemented**. Companion
to `docs/v2-roadmap.md` row C1a; C1b (rails docking) builds on this.

## Goal

One source of truth for *properties of variables and datasets* — colors,
units, roles, model↔aux pairings, categorical value order/colors — surfaced
in a left tree panel. Today this state lives in five different shapes across
four tabs, with duplicated name-matching logic in four places (one of them
inconsistent). Principle (from the aux-pairing lesson): **infer defaults
freely, but inferred state must be visible, overridable, persisted.**

Explicit non-goals:

- **View membership stays view-local** (Leapfrog-catalog semantics, not GIS
  global visibility): `statsSelectedVars`, `statsCdfSelected`, swath checked
  vars, GT `gradeCols`, categories focused column are *not* catalog state.
- No docking/layout work (C1b), no lineage semantics (C3), no change to any
  analysis result.
- Existing per-tab pickers stay where they are — they become views onto the
  catalog (read-through, write-through), not casualties.

## Inventory — current state and its disposition

| Current state | Shape | Where | Catalog disposition |
|---|---|---|---|
| `catColorOverrides` | `{col: {value: hex}}` | core.js, written by categories.js picker, read via `getCategoryColor()` (also section.js, statscat CDF) | **Absorbed** → per-variable `valueColors` |
| `catSortModes` / `catCustomOrders` | `{col: mode}` / `{col: [values]}` | core.js / categories.js; statscat inherits | **Absorbed** → per-variable `sortMode` / `valueOrder` |
| `swathColorOverrides` | `{col: hex}` + `{'aux:NAME': hex}` | core.js / swath.js (`getSwathVarColor`, `getAuxSwathVarColor`) | **Absorbed** → per-variable `color` (series color) |
| `globalUnits` | `{col: unitIdx}` (GRADE_UNITS) | core.js, statistics formatting | **Absorbed** → per-variable `unit` |
| swath per-var units, GT `gradeUnits` | `{col: unitIdx}` per view | DOM + project `swath.units`/`gt.gradeUnits` | **Decision D2** (unify vs keep view overrides) |
| `currentWeightName` (stats), swath weight select | name | statsTab.weight / swath.weight | **Absorbed** → dataset role `weight` (Decision D3) |
| `auxWeightName` (+ `'__declus__'` sentinel) | name \| sentinel | aux.weight | **Absorbed** → aux dataset role `weight` |
| GT `weightCol` | name | gt.weightCol | **Role `tonnageFactor`** — semantically distinct from support weight (it multiplies tonnage, e.g. ore%) |
| GT `densityCol` / `densityConst` | name / number | gt.densityCol | **Role `density`** (const stays GT-local) |
| XYZ / DXYZ assignment | `{x,y,z}` / `{dx,dy,dz}` raw indices | preflight.xyz/dxyz | **Displayed** in tree (coordinates group + badges); storage stays in preflight (it predates analysis and feeds the worker by index) |
| Model↔aux name matching ×4 | inline `.toLowerCase()` maps | statistics.js (matchCi), swath.js (default-check, scaleKey, color inherit), gt.js (`gtTheoMatchedVars`), categories.js (`getCatAuxCounts`) — all four case-insensitive (an earlier inventory claim that categories was case-sensitive was wrong) | **Replaced** → `catalog.pairs`, seeded case-insensitively; all four sites read `catPair()`/`catPairsRev()` |
| `auxPrefix` | string | aux.prefix | **Becomes** the aux dataset's `label` (same persistence, surfaced in tree) |
| declus/topcut/section var picks | name | aux.topcut.varName etc. | **Not catalog** — view-local analysis parameters, like membership |

## Identity model

A catalog variable is keyed `dataset + ':' + name`:

- dataset ∈ `'model' | 'aux'` (A7 drillhole sources will add more — the key
  format is the extension point)
- name = raw column name or calcol name — names are already the persistence
  convention everywhere (indices don't survive re-analysis)
- A catalog entry whose name no longer exists in the dataset's extended
  header is **stale, not deleted** — shown grayed in the tree (a renamed
  calcol keeps its color/unit waiting to be re-paired or purged)

## Data model (core.js)

```javascript
let catalog = {
  datasets: {
    model: { label: 'Model' },
    aux:   { label: auxPrefix }          // auxPrefix becomes this field
  },
  vars: {
    // sparse: entries exist only when something is set
    'model:Fe': {
      color: '#e8a14d',                  // series color; null/absent = palette by position
      unit: 4,                           // GRADE_UNITS index; absent = raw
      // categorical variables only:
      valueColors: { HEM: '#aa5500' },   // ex catColorOverrides[col]
      valueOrder: ['HEM','GOE','CAN'],   // ex catCustomOrders[col]
      sortMode: 'custom'                 // ex catSortModes[col]
    }
  },
  roles: {
    // per dataset, one variable per role; null = unassigned
    model: { weight: 'W_DECLUS', density: 'SG', tonnageFactor: null },
    aux:   { weight: '__declus__' }      // sentinel preserved as-is
  },
  pairs: {
    // aux name -> model name | null (null = explicitly unpaired/orphan)
    Fe: 'Fe', AU_PPM: 'AU', LITO: 'LITO'
  }
}
```

Notes:

- `pairs` is keyed by bare aux name (single aux dataset today); if/when A7
  brings multiple sources, the key grows the dataset prefix.
- Seeded pairs are stored **materialized** (no "is it inferred?" runtime
  re-derivation) — the tree can mark `seeded: true` visually if we want, but
  the mechanism is always the stored entry. Re-seeding only fills *missing*
  keys, never overwrites an edit.
- Roles are per-dataset and single-valued — a badge, not a list.

## Accessor contract (what tabs call)

```javascript
catVarColor(ds, name, fallbackIdx)   // explicit -> paired primary's color (aux only) -> STATSCAT_PALETTE[fallbackIdx]
getCategoryColor(col, value, idx)    // KEEPS its name/signature — internals read catalog.vars[...].valueColors
catVarUnit(ds, name)                 // -> GRADE_UNITS index (0 = raw)
catRole(ds, role) / catSetRole(ds, role, name)
catPair(auxName)                     // -> model name | null
catPairsRev(modelName)               // -> [auxName, ...]
catEnsureSeeded()                    // idempotent; called on analyze-complete + aux-analyze-complete
catalogMarkChanged(kind)             // autoSaveProject() + per-tab stale marks (existing pattern; no event bus)
```

The aux color-inheritance rule (`getAuxSwathVarColor`: same-named aux shares
the primary's color, drawn dashed) generalizes to: **a paired aux variable
inherits its primary's series color unless explicitly overridden** — same
behavior, now uniform across any future consumer.

## Seeding rules

On every analyze/aux-analyze completion (`catEnsureSeeded()`):

1. No variable records are created eagerly — `vars` stays sparse (records
   appear on first edit). The tree renders from the extended headers, not
   from `vars` keys.
2. For each aux variable with no `pairs` key: case-insensitive, trimmed
   match against the model's extended header → matched name or `null`.
   Existing keys (including explicit `null` = "unpaired") are never touched.
3. `roles` are seeded **only by migration** (below) — we don't guess that a
   column named DENSITY is the density; the user assigns roles (no-magic).
   Door left open: a future "suggest roles" affordance in the tree, visibly
   marked as suggestion.

## Persistence & migration

New top-level project key `catalog` (sparse — only what's set). Old keys
stop being written; `applyProject()` migrates when `project.catalog` is
absent:

| Old key | → catalog |
|---|---|
| `categories.colorOverrides/sortModes/customOrders` | `vars['model:'+col].valueColors/sortMode/valueOrder` |
| `swath.colorOverrides` (`col` / `'aux:NAME'`) | `vars['model:'+col].color` / `vars['aux:'+NAME].color` |
| `globalUnits`, then `swath.units`, then `gt.gradeUnits` (later wins) | `vars['model:'+col].unit` (see D2) |
| `statsTab.weight` (and `swath.weight` if it disagrees — stats wins, see D3) | `roles.model.weight` |
| `gt.densityCol` | `roles.model.density` |
| `gt.weightCol` | `roles.model.tonnageFactor` |
| `aux.weight` | `roles.aux.weight` |
| `aux.prefix` | `datasets.aux.label` (also kept at `aux.prefix` until C1b settles, cheap) |
| *(none)* | `pairs` — seeded fresh by rule 2 on first analyze |

Categories/swath/statistics restore paths then read the catalog instead of
their old keys. `serializeProject()` keeps every *view* key it has today
(membership, filters, cutoffs...) — only the property state moves.

## Tree panel (UI scope for C1a)

Collapsible fixed-width left panel (CSS grid column, `--tree-w`), visible on
all results tabs, toggled by a header button; collapsed state persisted in
the project. C1b later re-homes the same component as a rails dock panel,
and on mobile (C1c) it renders as a slide-over sheet — both are reasons the
render entry (`renderCatalogTree(container)`) stays container-agnostic. Use
pointer events (not mouse events) for any tree drag/edit interactions from
day one; below the existing 700px breakpoint the tree defaults to collapsed.

```
▾ Model — model.csv (1.2M rows)
  ▾ Coordinates        X · Y · Z   [XYZ badges]
  ▾ Grades
      ● Fe      %    [W]          ← color chip, unit chip, role badge
      ● Al2O3   %
  ▾ Categories
      ◆ LITO    (5 values)        ← expands to value chips/order
  ▾ Calculated
      ● FE2     %
▾ Samples (aux) — samples.csv (560 rows)
  ▾ Grades
      ● Fe      ⇄ Fe              ← pairing indicator; click to edit
      ● AU_PPM  ⇄ (unpaired)      ← orphan, visibly distinct
```

Interactions (C1a, deliberately small): color chip → existing swath-style
picker; unit chip → GRADE_UNITS select; role badge → assign/clear via small
menu; pairing → select listing model numeric/categorical vars + "unpaired";
categorical node expands to value color/order editing (reusing the
Categories tab affordances or just deep-linking to that tab — see D5).

## Decisions

| # | Decision | Call |
|---|---|---|
| D1 | Variable identity by `dataset:name`; stale entries kept, shown grayed | **Made** (matches existing by-name persistence) |
| D2 | Units: one unit per variable in the catalog; swath/GT per-view unit selects become write-through views of it (migration: `globalUnits` < `swath.units` < `gt.gradeUnits`) | **DECIDED (Arthur, 2026-06-11): unify.** One unit per variable; per-view selects are synchronized views |
| D3 | Support weight: single `roles.model.weight` shared by Statistics and Swath (their selects sync); GT's tonnage multiplier is a separate `tonnageFactor` role; GT density a `density` role | **DECIDED (Arthur, 2026-06-11): unify** stats+swath weight; GT stays independent (`tonnageFactor`, `density` roles) |
| D4 | Pairing: materialized `pairs` map, case-insensitive seed, never re-overwritten, `null` = explicit orphan; all four match sites switch to `catPair()` | **Made** (this is the C1a raison d'être; also fixes Categories' case-sensitive mismatch) |
| D5 | Categorical value colors/order editing in the tree vs deep-link to Categories tab | **Open — implementation-time call** (tree can start with a "edit in Categories →" link; zero risk) |
| D6 | Roles not guessed from column names — user-assigned only (seeded from migration) | **Made** (no-magic) |
| D7 | View membership stays out of the catalog | **Made** (roadmap states it; revisit only at C3) |

## Phasing (each step lands green)

1. **Model + accessors + seeding + persistence + migration, no UI.** Tabs
   switch to read-through (`getCategoryColor` internals, swath color
   resolution, the four pairing sites, unit reads). Behavior identical by
   construction — full smoke suite must stay green untouched.
   ✅ **DONE 2026-06-11 (1d39088)** — full suite green; the example pack's
   legacy-format project json exercised `migrateLegacyCatalog` end-to-end.
   The redundant "Sync units" buttons (swath, GT) were removed with D2.
2. **Tree panel, read-only** — datasets, groups, chips, badges, pairing
   indicators, orphans, stale entries.
   ✅ **DONE 2026-06-11 (00b8e5d)** — `src/tree.js`, toggle in the tab bar,
   `tree.open` project key, proto-sheet overlay <700px, smoke
   `experiments/tree-smoke.js`. Paired aux chips inherit the primary's
   *effective* color (palette included), matching the swath rule.
3. **Editing affordances** (color/unit/role/pairing) + stale-mark
   integration + `autoSaveProject()` wiring (new-tab checklist applies).
   ✅ **DONE 2026-06-11 (c936048)** — row popover (`#treePopover`, fixed
   position, survives tree refreshes); pairing select is kind-filtered
   (num↔num, cat↔cat) with explicit "— unpaired"; many-to-one pairs are
   allowed (single-slot consumers — Categories comparison, GT-theo — take
   the first by header order); model categorical rows deep-link to the
   Categories tab (D5 resolved as deep-link).
4. **New smoke**: `experiments/tree-smoke.js` — load example pack, assert
   seeded pairs (Fe⇄Fe, LITO⇄LITO, CAN orphan-side visible), edit a pairing
   + a color, reload project, assert persistence; assert Statistics/Swath/
   Categories/GT-theo all honor an edited pairing.
   ✅ **DONE 2026-06-11** — 27 asserts incl. edit roundtrips (orphan
   re-pair, color inheritance, unit mirroring, weight role sync,
   persistence of all of it).

**C1a COMPLETE 2026-06-11.** Next per roadmap: C1b (rails docking).

Step 1 is the bulk and is testable without any visible change; the tree
(steps 2–3) is then pure presentation over a proven model.

## Known hazards (from the inventory)

- ~~categories.js `getCatAuxCounts` is case-sensitive~~ — wrong (subagent
  misread); all four matching sites were already case-insensitive. No
  behavior change from the pairing switch beyond honoring custom pairs.
- swath scaleKey (`buildSwathScaleGroups`) keyed shared Y-axes by lowercased
  name — now derives from `catPair()` (done in step 1), so a custom pairing
  colors AND scales together.
- Three `pending*Restore` globals already serialize aux-dependent state by
  name; catalog restore must slot into the same ordering (catalog before
  tabs render, pairs before stats/swath aux defaults compute).
- The new-tab checklist (CLAUDE.md / app-conventions) applies to the tree
  panel verbatim: autosave wiring, snapshot-before-rebuild, `.active`-scoped
  CSS.
