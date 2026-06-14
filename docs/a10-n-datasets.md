# A10 — N-dataset comparison

2026-06-12. Arthur: "right now we just support one bm and one aux — should we
think more on how to work with this?" Yes: the real QP check-model practice
compares the **new model** against the **composites/samples**, the **previous
resource model**, and often a **check estimate** (nearest-neighbor or a
different estimator). Two datasets covers the first comparison; three or four
covers the sign-off meeting. This doc designs datasets-as-first-class.

Written **before implementation begins** so C6-3 (the "Add dataset" surface)
is designed against the real model rather than the aux singleton. The
refactor itself can land after C6.

---

## Converged model (2026-06-13, Arthur) — DESIGN OF RECORD

> This section supersedes **Data model**, **Reference semantics**, **Pairing**,
> **UI generalization**, and **Decisions** below (kept for history). Phase 1
> shipped on the older frame (registry + instances) and is bit-identical-safe;
> Phase 4+ is built on the model here. Tracked in `docs/roadmap-tracker.csv`.

Phase 1 landed N dataset *instances* (the model + aux + d2/d3 panels coexist,
analyze independently). Working through Phase 4, Arthur removed every remaining
privileged role. The result is simpler than the hub-and-spoke sketch below:

**1. Datasets are peers — no "model", no `kind`.** What made the block model
special was never an identity, only a *capability*: a regular grid geometry.
So grid geometry becomes **one optional facet** of a dataset, alongside coords
and per-dataset column-roles (weight / density / volume). A dataset is just
`rows + columns + optional {coords, grid, roles}`. This makes legal what was
artificial before: **two gridded datasets** (new vs previous model, both real
grids), and **zero gridded datasets** (composites vs samples vs check, no block
model at all). Panels **feature-detect** what they can offer rather than gating
on a type.

**2. No global dataset-roles — not even a reference ★.** The reference (Δ%'s
denominator) is **per-panel-instance state**: each Statistics copy picks which
of *its* shown datasets is the reference. Two Stats tabs can disagree; that's
the point. There is therefore **no global ★, no global "subject/model".**
Sensible defaults (first-loaded, or the lone gridded one) keep the common case
zero-config, but they are defaults, not roles.

**3. Grouping = properties, not pairs.** A **property** is a named measured
quantity (e.g. `Fe`) that dataset columns *instantiate* — an equivalence class
over `(dataset, column)`. This is what the C1a "property catalog" should have
meant. Cases collapse:
- a 1-member property = an unmatched / dataset-specific column,
- a 2-member property = today's "pair",
- an N-member property = the N-dataset group.

No hub, no transitive closure. Membership auto-seeds by normalized name
(case-insensitive, as today); editing is **merge / rename / split** in the
generalized pairing popover. Crucially, **display identity moves onto the
property** — color, unit, log-scale, categorical value→color map live on `Fe`
*once*, replacing the per-`ds:name` smearing of `catalog.vars`+`pairs`.

**4. Selection is a grid, identical on every comparison panel.** Per-panel:
`(datasets ✓) × (properties ✓)`. A property with no member in a selected
dataset just yields no series there (∅). Progressive disclosure: the dataset
row is hidden at ≤2 datasets (today's comfort), appears at 3+. An instance's
serializable state is `{ datasets:[…], reference, properties:[…], params,
title }` — exactly what C8 saves and C7 snapshots.

**5. Feature-detection per panel (no grid lock):**
- **GT** — theoretical curve runs off any distribution (affine now, Hermite
  later); empirical tonnage runs when a *volume source* exists: grid geometry
  **or** a volume/tonnage-factor column. So GT works on points/drillholes too.
- **Export** — any dataset (rows out; bbox/OBJ already generalized in phase 3).
- **Import unifies** — every dataset's import panel runs grid-detection and
  shows the geometry section *iff* a grid is found. "Import Block Model" stops
  being special; it's an import that detected a grid. (Merging today's rich
  model-preflight with aux-import is the biggest new surface — Phase 4f.)
- **Section** — ground-up redesign, out of scope here.

**The clean separation (the consistency payoff):**

| Lives on… | What |
|---|---|
| **Property** (global) | name, color, unit, scale, value-colors, membership |
| **Dataset** (global, per-ds) | facets (coords, grid), filter, calcols, column-roles (weight/density/volume) |
| **Panel instance** (per-view) | which datasets visible, **reference**, which properties, grid source, params, title |

You never re-decide *meaning* per panel — only *visibility*. That is what lets
several Stats/Swath copies coexist without contradicting each other.

**Decisions (Arthur, 2026-06-13):** D1 properties replace `vars`+`pairs` (display
on the property) — YES. D2 de-privilege fully (no kind, feature-detect) — YES,
designing for N grids, ship single-grid first to bound the release. D3 this is a
new track and grows the release (a bigger A10 before tag) — YES. D4 reference is
per-panel-instance, no global ★ — YES. D5 GT/Export feature-detect, not grid-
locked — YES.

---

## Where we already are

The C1a catalog anticipated this deliberately:

- `catalog.vars` keyed `'<ds>:<name>'`; `catalog.roles` per dataset; the tree
  renders datasets as top-level nodes. None of this assumes exactly two.
- The per-tab comparison UIs already *iterate*: stats aux rows, CDF curves,
  swath overlay series. They iterate over one hardcoded "the aux" — the loop
  shapes generalize.

What is genuinely singleton is the **state layer**: `auxFile`,
`auxPreflightData`, `auxCompleteData`, `auxStale`, `auxFilter`,
`auxCalcolCode/Meta`, `auxPrefix`, `auxWeightName`-era roles, `auxDeclus`,
`auxTopcut`, `auxView` — a parallel copy of the model's globals, referenced
across auxtab.js, statistics.js, swath.js, gt.js, topcut.js, drillhole.js,
tree.js, project.js (persistence + pack), ctxmenu.js.

## Data model

> ⚠ SUPERSEDED by the Converged model — no `kind`/`model`; grid geometry is an
> optional dataset facet; no `referenceId` (reference is per-panel). The
> registry shape (`datasets[]` of `{id, file, preflight, complete, filter,
> calcolCode, …}`) otherwise stands.

```js
// the registry (replaces the aux singleton)
datasets = [
  { id: 'model',  kind: 'model',  file, preflight, complete, stale,
    filter, calcolCode, calcolMeta, prefix: null,  source: 'file' },
  { id: 'd2',     kind: 'aux',    file, preflight, complete, stale,
    filter, calcolCode, calcolMeta, prefix: 'comp', source: 'file' | 'drillholes' },
  …
]
referenceId = 'd2'   // the measurement standard — see Reference semantics
```

- **`id`** is a stable opaque key (`'model'`, `'d2'`, `'d3'`, …) — it is the
  catalog namespace (`'d2:Fe'`), the project key, and the pack folder name.
  The display name is `prefix` (user-editable, seeded from the filename),
  keeping today's cosmetic-prefix behavior.
- **`kind`**: exactly one `model` (the block model: owns geometry, Export,
  GT tonnage); every other dataset is point data (`aux` semantics: no
  geometry, no Export — the A7/aux design rules carry over verbatim).
- **Drillhole sets** remain an *ingestion path* that produces a point
  dataset (`source: 'drillholes'`, recipe attached) — A7's architecture is
  untouched; there can now be several.
- **Caps**: UI designed for N, soft-capped at 4 visible datasets (model +
  3 comparisons) — beyond that the comparison tables stop being readable,
  and the QP practice doesn't ask for more.

### Reference semantics (the key product decision)

> ⚠ SUPERSEDED by the Converged model — there is **no global reference ★**;
> the reference is per-panel-instance state (each Stats copy picks its own).

Today "aux" plays two roles at once: *comparison series* and *measurement
standard* (Δ% denominators, theoretical-GT source distribution, declustering
target). With N datasets these separate:

- Every non-model dataset is a **comparison series** (rows in stats, curves
  in CDF, overlays in swath).
- Exactly one dataset is the **reference** (★ in the tree, default: the
  first point dataset loaded): Δ% is computed model-vs-reference;
  theoretical GT fits the reference's declustered distribution; top-cut and
  declustering operate on the reference by default (but can be pointed at
  any point dataset — they're per-dataset tools, the default just follows
  the star).
- Model-vs-model comparison (new vs previous estimate) is just another
  comparison series — the previous model loads as a *point dataset of block
  centroids* (kind aux), which is methodologically right: it's compared
  statistically/spatially, never re-exported.

### Pairing generalizes hub-and-spoke

> ⚠ SUPERSEDED by the Converged model — there is **no hub**. Pairing becomes
> **properties** (named equivalence classes over `(ds,column)`); a pair is just
> a 2-member property, an unmatched column a singleton.

`catalog.pairs` today maps aux-name → model-name. It becomes per-dataset:
`catalog.pairs[dsId][name] → model name | null`. The model stays the hub —
every dataset pairs against model variables (that's what "same variable,
other dataset" means here), seeded case-insensitively per dataset, edited in
the tree/popover exactly as today. Cross-aux pairing is explicitly out of
scope (no use case until someone shows one).

## UI decision — datasets as tree + per-dataset instance panels (Arthur, 2026-06-13)

Supersedes the "single Datasets tab" sketch below. The workspace becomes
**a tree of datasets + on-demand per-dataset panels** — no standing Aux tab,
no fixed "Import Points/Drillholes" tabs:

- **Adding a dataset is a menu action** — Data ▸ *Add point dataset…* /
  *Add drillhole set…* (each triggers the file load and registers a dataset).
  The drillhole add-path opens the A7 mapping/composite flow, producing a
  point dataset (`source: 'drillholes'`), exactly as today.
- **The catalog tree is the registry** — datasets are its top-level nodes
  (already true visually); the tree gains per-dataset row actions in its
  right-click menu (Open import/config, ★ make reference, Remove).
- **Each dataset's import + config + summary is its own panel** — a **C9
  instance** keyed by dataset id, titled "Import: ⟨prefix⟩", dockable, and
  independently closeable. **Several open side by side.** The block model's
  instance is the renamed **"Import Block Model"** (today's Preflight, with
  geometry); point/drillhole instances skip geometry and show a bbox + row
  summary instead.
- **Closed → re-raise from the tree right-click menu** (and View ▸ Panels) —
  reusing the C1b-3 reopen + C4 context-menu machinery verbatim.
- **Preflight is renamed "Import Block Model"** and is just the model's
  dataset panel — the rename falls out of the unification, not a separate
  cosmetic pass.

This folds a focused slice of **C9 (panel instances)** into A10: the dataset
panel is the first cloneable panel type (state object keyed by dataset id,
scoped DOM with no unique ids, serialized title). C9's other adopters (Swath,
GT, Table) follow later; this is where the instance contract is born.

### Per-dataset summary (skip block params; bbox + Export OBJ + rows)

Each dataset panel carries a summary appropriate to its kind:
- **model**: today's grid geometry (origin/block size/grid count/fill/loop
  order) — unchanged.
- **point / drillhole**: **no grid params** (they aren't gridded). Instead a
  **bounding-box readout** — a few modes (axis-aligned XYZ extent at least;
  rotated/oriented bbox later) — wired to the existing **Export OBJ** infra so
  the box exports like the model's, plus a **row/health report** (reuse the
  C6-5 Data Health card: rows, nulls, ragged, filter/calcol errors, ignored
  coords). Datasets stop borrowing the block-model geometry card they don't
  fit.

## Phasing (revised 2026-06-13 — merges the C9 dataset-panel instance)

| Phase | Scope |
|---|---|
| 0 | **Registry under the hood**: `datasets[]` + accessors; `aux*` globals become facades over `datasets[1]`; zero behavior change, full suite green + b1-differential bit-identical. The de-risking move (B1/C1a-step-1 playbook) |
| 1 | **Dataset panel as a C9 instance**: factor the aux sidebar/config into an instance keyed by dataset id (scoped DOM, no unique ids); Preflight → "Import Block Model" = the model's instance; register with the workspace so it docks/closes/reopens |
| 2 | **Menu add + tree registry**: Data ▸ Add point/drillhole; tree row actions (Open config / ★ reference / Remove); reopen via tree ctx menu + View ▸ Panels; second point dataset loadable |
| 3 | **Per-dataset summary**: bbox modes + Export OBJ + C6-5 health for point/drillhole; model keeps geometry |
| 4a | **Properties layer**: `catalog.properties` (named equivalence classes over `(ds,column)`); display (color/unit/scale/value-colors) moves onto the property; auto-seed by name; merge/rename/split popover. Subsumes `catalog.vars`+`pairs` (singleton = unmatched, pair = 2-member). The keystone — everything below depends on it |
| 4b | **De-privilege model**: drop `kind`; grid geometry becomes an optional dataset facet; replace `id==='model'` checks with feature-detection. Reference-hub + gridded/point split removed |
| 4c | **Per-panel selection**: dataset chips × property checkboxes on Stats/CDF/Swath/Categories; progressive disclosure at 3+ datasets |
| 4d | **Per-panel reference**: Δ% denominator is instance state (no global ★); each Stats copy picks its own reference |
| 4e | **Multi-instance spawn**: tab-strip `[+]` / Duplicate; scope-derived titles; instance state `{datasets, reference, properties, params, title}` serialized (C9 contract) |
| 4f | **Import unification**: grid-detect any dataset's import; geometry section conditional; "Import Block Model" stops being special |
| 4g | **GT feature-detect**: theoretical curve any dataset; empirical tonnage when a volume source exists (grid geometry OR volume/tonnage column) |
| 4h | **Export generalize**: any dataset (rows / bbox / OBJ) |
| 5 | **Drillhole sets as instances** (multiple), per-dataset declustering/top-cut targeting |
| 6 | **Persistence + pack** (`datasets` + `properties` keys, legacy `aux`/`drillholes`/`vars`/`pairs` migration; C8-shaped; un-drop `d*` tabs in layout sanitize); persistence smoke; **manuals regen (both languages) → RELEASE** |

> Phase 4 was a single "N datasets live, reference-★, iterate `datasets`" row;
> the 2026-06-13 converged model expanded it into 4a–4h (properties, peers,
> per-panel selection + reference, spawn, import-unify, GT/Export feature-detect).
> See the **Converged model** section at the top. Granularity here mirrors
> `docs/roadmap-tracker.csv`.

### Phase 4a slicing (properties layer — de-risk playbook)

Today display lives per `ds:name` (`catalog.vars`) with hub-style inheritance
baked into the accessors (`catVarColor`/`catUnit`: an aux var with no override
inherits its *paired model* var's color/unit). Target: display lives on the
**property** (the equivalence class), one place, no hub. Slices:

- **4a-i (inert seam)** — introduce property-oriented accessors
  (`catPropId(ds,name)` = the property a column belongs to; `catPropColor` /
  `catPropUnit`) that **delegate to the current `catVar*`/`catUnit`/`catPair`
  logic** → bit-identical. Mirrors the `auxQ`/`dsConfigRoot` seam moves. No
  storage change; establishes the API surface consumers will use.
  `catPropId`: model → `model:<name>`; aux → its paired model property
  (`model:<pair>`) or its own (`aux:<name>`); instances → own (`<id>:<name>`)
  until 4c generalizes grouping.
- **4a-ii (migrate consumers)** — repoint the ~8 display reads
  (statistics/swath/gt/categories/tree colors + units) off `catVarColor`/
  `catUnit` onto `catPropColor`/`catPropUnit`. Still delegating → bit-identical
  (verified by the full smoke suite). After this, no consumer reads per-`ds:name`
  display directly.
- **4a-iii (flip storage + editing)** — make `catalog.properties[propId] =
  {name, color, unit, scale, valueColors, valueOrder, members:[{ds,col}]}`
  canonical; migrate `vars`+`pairs` → `properties` (seed members by normalized
  name); repoint `catPropColor`/`catPropUnit` to read the property; generalize
  the tree pairing popover to **merge / rename / split** group membership; drop
  per-member display overrides. This is the only behavior-changing slice, and
  it's localized behind the 4a-i API. Project migration: legacy `catalog`
  (`vars`+`pairs`) → `properties` in `migrateLegacyCatalog()`.

### Phase-1 implementation log + the C9 instance contract (2026-06-13)

Phase 1 is being executed as fine slices (B1/C1a playbook — de-risk first):

- **1e ✅ (f3c4d30)** — root seam: `auxPanelRoot()`/`auxQ(sel)` in core.js; every
  aux-panel DOM lookup routes through the per-dataset root, not the document.
  Inert (ids unchanged), behavior bit-identical, all aux smokes pass unchanged.
- **1f ✅ (ade2133)** — flipped the *rendered* controls off unique ids onto
  collision-free identity attrs (`data-act` on buttons, `data-aux` on
  inputs/selects/spans; styling classes untouched). Handlers key on
  `e.target.dataset`; `setGenStale()` takes an element or id. Sweep curve/cursor
  use `.aux-declus-curve`/`.aux-declus-cursor`. Shell elements still keep their
  template ids (become per-root in 1g). Smokes + shot drivers updated.

**The rails instance contract (verified against vendor-rails.js, 2026-06-13).**
The dataset config panel is the first *cloneable* C9 panel. Rails supports this
with no new vendor code:

- `getPanel(inst, tab)` (rails internal) calls `callbacks.renderPanel(tab)`
  **once per tab id, lazily**, wraps the returned element in a `.rails-panel`
  wrapper, appends to `contentLayer`, and caches it in `inst.panels` (Map by
  tab id). renderPanel is never called again while the tab is live.
- `addTab({id, title, closeable:true}, target)` adds a tab (dup id throws);
  `updateTab(id, {title})` renames (for "Import: ⟨prefix⟩" tracking the prefix);
  `closeTab(id)` → `destroyPanel` → `onPanelDestroy(tab, wrap)` (wrap = the
  `.rails-panel`, `wrap.firstElementChild` = the panel body).
- **All dataset panel state lives in the `ds` object, not the DOM**, so close =
  destroy, reopen = renderPanel-rebuilds-from-`ds` — no `preserveOnClose` needed.

Phase-1g slices:

- **1g-a ✅ (a5acb1d)** — instance scaffolding: `dsConfigRoot(ds)` (model→
  `#panelPreflight`, aux→`#panelAux`, d2+→`.ds-panel[data-ds=<id>]` clones) +
  `auxQ(sel, root)` optional root; `data-aux` identity added to ALL aux-panel
  SHELL elements (additive, ids/classes kept → inert, single instance untouched);
  `#panelAux` gains `.ds-panel`+`data-ds="aux"`.
- **1g-b ✅ (84802e0)** — parameterized every aux render/analysis/declus/topcut
  function in auxtab.js + topcut.js by an explicit `(ds, root)` (default
  `ds=dsById('aux')`, `root=dsConfigRoot(ds)`). State reads moved off the `aux*`
  globals onto `ds.file/preflight/filter/prefix/calcolCode/calcolMeta/declus/
  topcut/view/complete/stale` (bit-identical via the datasets[1] getter-view);
  catalog by `ds.id` (`catRole`/`catSetRole`); worker `rowVarOverride` + the
  Copy-calcol handle by `ds.rowVar`; DOM root-relative via
  `auxQ('[data-aux=..]', root)` — the cached `$aux*` shell consts are GONE. The
  topcut svg builders take the topcut state object `t` (= `ds.topcut`) directly.
  Load-time wiring extracted into `wireDatasetPanel(root, ds)` (auxtab) +
  `wireDatasetTopcut(root, ds)` (topcut), invoked ONCE for the static `#panelAux`
  from topcut.js (the last dataset module, so both are defined). **DEVIATION from
  the sketch below: worker handles stay GLOBAL** (`auxWorker`/`auxDeclusWorker`/
  `auxTopcutWorker`) — single aux, no concurrency yet; they move onto `ds` in 1g-c
  when concurrent instances exist. Aux suite bit-identical green (topcut/declus-ui/
  delta-row/drillhole/gt-theo/logprob/tree/sidebar-scroll + a9/empty-col/rails/c6);
  worker.js untouched. (topcut-smoke's two direct `auxTopcutCappedStats(c)` calls
  updated to pass the state object — the only smoke change.)
- **1g-c ✅ (42379c3) — PHASE 1 COMPLETE** — instances live. `renderPanel`
  dispatch: data → tree; `wsPanelById` → static singleton (incl. aux); else
  `dsById(tab.id)` → `wsBuildDatasetPanel(ds)` (clones **#panelAux**, strips
  every id so the panel resolves DOM by data-aux/data-act via auxQ, drops the
  drillhole card, tags `data-ds=<id>`, adds `.active`, `wireDatasetPanel(el,
  ds)`, initial `renderAuxConfig`/`renderAuxFromMain(ds, el)`). `onPanelDestroy`
  (`wsRehomePanel`) re-homes only the singletons + tree; instance clones are
  discarded (state survives on the ds). Per-ds workers: `auxWorker`/
  `auxDeclusWorker`/`auxTopcutWorker` globals → `ds._worker`/`_declusWorker`/
  `_topcutWorker` (the 3 globals deleted from core.js). New workspace fns:
  `wsAddPointDataset` (Data ▸ Add point dataset → `dsCreate`+`dsAdd`+`addTab`+
  activate the empty import panel; the panel's own dropzone loads the file —
  the file gesture happens IN the panel, not a pre-picker), `wsRemoveInstance`
  (terminate workers + `closeTab` + `dsRemove` + refresh), `wsSetDatasetTabTitle`
  (`updateTab` title tracks the prefix); `wsActivateInRails` rebuilds a closed
  instance; `wsSyncLegacyTabbar` no-ops on instance ids (no legacy button) so
  `getActiveTabId` stays stable. auxtab.js: the panel ✕ REMOVES an instance
  (vs RESET for aux), `loadAuxFile` seeds an instance prefix from the filename +
  sets the title, `renderDhProvenance` stays aux-only (drillhole instances are
  phase 5). ctxmenu.js: tree dataset/variable menus open `showPanel(ds)` for
  instances + Remove via `wsRemoveInstance`, labels use the ds prefix. Instance
  tabs NOT persisted yet — `wsSanitizeLayout` already drops any tab id not in
  `WS_PANELS` on restore (phase 6 adds real persistence). **Consumers
  (Statistics/CDF/Swath/GT) still read the aux singleton — iterating `datasets[]`
  is phase 4.** worker.js untouched. Smoke `experiments/a10-smoke.js` (20
  asserts): aux + a d2 instance coexist + analyze INDEPENDENTLY (560/5760
  concurrently, separate worker handles), clone has no dup ids/no dh card,
  prefix→title, d2 in the tree, close→reopen survives (clone discarded, ds
  state kept), Remove drops cleanly. Full aux suite green.

Note on the older "scope to class selectors / migrate ~8 files" sketch: the
phase-1 DOM scoping used **data-act/data-aux + the auxQ root** (not bare classes);
the statistics/swath/gt/project/ctxmenu files read aux* as *state* (not DOM) and
are converted by the 1g-b `ds`-parameterization, with the singleton aux view
keeping them bit-identical.

The original "single Datasets tab" generalization (below) is kept for the
data-model/reference/pairing/persistence reasoning, which is unchanged — only
the surface (tab → tree + instance panels) is superseded by the above.

## UI generalization (joint with C6-3)

- **The Aux tab becomes the Datasets tab**: a list of loaded datasets
  (card per dataset: name, source, row count, stale state, ★ reference
  toggle, remove) + one **Add dataset** flow with two peer paths (point
  data file / drillhole set) — this is exactly the C6-3 empty-state
  redesign, so it gets designed once. Selecting a dataset card opens the
  config that today fills the aux sidebar (prefix, coords, filter, weight,
  declustering) — per dataset.
- **Tree**: datasets as siblings under the root (already true visually);
  ★ on the reference; per-dataset chips/badges unchanged.
- **Statistics**: each selected variable shows model row + one row per
  selected dataset; **Δ% row appears under the reference only** (the other
  datasets are series, not standards). Variable selection stays per-dataset
  (the sidebar groups by dataset, as it groups model/aux today).
- **CDF/Q-Q**: curves from any dataset (palette: dataset-consistent
  dashing — model solid, others dashed with per-dataset dash patterns).
- **Swath**: overlay series per dataset; scale-sharing rule generalizes
  (same paired model variable → same Y axis).
- **GT**: theoretical overlay reads the reference; tonnage stays
  model-only.
- **Worker protocol: unchanged.** Every pass is already per-file; N
  datasets = N worker runs, exactly like aux today. No new modes.

## Persistence + pack

- Project: `datasets` key (array of per-dataset configs by `id`, files
  matched by name+size like `drillholes` does), `referenceId`. The legacy
  `aux`/`drillholes` keys migrate: aux → `d2` + reference. Packs gain one
  folder per dataset (raw files + recipe for drillhole-derived, per D8).
- IDB cache: per-dataset fingerprints (today's aux fingerprint pattern,
  keyed by dataset id).
- **C8 alignment (2026-06-12)**: the registry serialization IS the heart of
  the C8 project object — write it into that shape from day one
  (`{datasets, referenceId, …}` under a named, id-keyed project) so the
  project system doesn't re-serialize. See the C8 roadmap row.

## Phasing

| Phase | Scope |
|---|---|
| 0 | **Registry under the hood**: `datasets[]` + accessors; `aux*` globals become facades over `datasets[1]` (`Object.defineProperty` getters or mechanical rename); zero behavior change, full suite green. The de-risking move — same playbook as B1/C1a step 1 |
| 1 | **Datasets tab** (C6-3 surface, live): list + add + remove + ★; second point dataset loadable; stats/CDF/swath/tree iterate `datasets` (still reference-driven Δ%/theo) |
| 2 | **Drillhole sets as instances** (multiple), per-dataset declustering/top-cut targeting, persistence + pack migration, caps + empty states |
| 3 | Smoke (`a10-smoke.js`: 3 datasets incl. one drillhole-derived, ★ switch, Δ% follows, restore round-trip), manuals |

## Decisions (proposed defaults — Arthur to veto)

> ⚠ SUPERSEDED — see the dated decisions in the Converged model section. D1
> (model is the hub) is REVERSED; D2 (cap 4) stands; D3 (declus/top-cut default
> to reference) becomes "default to a per-panel choice".

- **D1**: model is always the hub/Δ% subject; reference is the denominator.
  Model-vs-model = previous model loaded as point dataset. *(default: yes)*
- **D2**: soft cap 4 datasets. *(default: yes)*
- **D3**: declustering/top-cut default to the reference, retargetable
  per point dataset. *(default: yes)*
- **D4**: legacy projects: `aux` migrates to `d2` named by its old prefix,
  starred. *(default: yes)*
