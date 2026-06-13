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
| 4 | **N datasets live**: stats/CDF/swath/GT iterate `datasets`; reference-★ semantics (Δ% under reference, theo/declus/top-cut follow ★); soft cap 4 |
| 5 | **Drillhole sets as instances** (multiple), per-dataset declustering/top-cut targeting |
| 6 | **Persistence + pack** (`datasets` key, `referenceId`, legacy `aux`/`drillholes` migration; C8-shaped); smoke `a10-smoke.js`; **manuals regen (both languages) → RELEASE** |

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

Design for the remaining phase-1 work:

- **1g-a (foundation, behavior-identical)** — make the shell access root-relative:
  `auxPanelRoot()` (and the cached `$aux*` shell consts → root-relative
  accessors) take a root; parameterize `renderAuxConfig`/`runAuxAnalysis`/preview/
  summary/declus/topcut by an explicit `(ds, root)`. Extract the load-time wiring
  (listeners on the sidebar/topcut/view-toggle + clear button) into
  `wireDatasetPanel(root, ds)` and call it for the static `#panelAux` (ds=aux).
  Single instance still = `#panelAux`; aux smokes stay green.
- **1g-b** — per-`ds` state + worker handles: read `ds.file/preflight/filter/
  prefix/calcolCode/declus/topcut/view/complete/stale` instead of the `aux*`
  globals (aux is `datasets[1]`, a getter-view, so reading `ds.*` ≡ today —
  bit-identical); move `auxWorker`/`auxDeclusWorker`/`auxTopcutWorker` onto the
  `ds` object (`ds._worker` etc.) so datasets analyze concurrently. `rowVarOverride
  = ds.rowVar` ('aux' for the legacy aux, the id for d2+); catalog namespace =
  `ds.id`.
- **1g-c (instances live)** — `renderPanel` dispatch: data → tree; `wsPanelById`
  → static singleton (incl. aux); else `dsById(tab.id)` → `wsBuildDatasetPanel(ds)`
  (clone a **config-shell template** — scoped, no unique ids, no dh card; set
  `root.dataset.ds=id`; `wireDatasetPanel(root, ds)`; initial `renderAuxConfig(ds,
  root)`). `onPanelDestroy` guards: re-home only `wsPanelById` singletons; a clone
  is just discarded (state survives in `ds`). "Add point dataset" = `dsCreate` +
  `loadAuxFile(...)` into the new ds + `addTab({id, title:'Import: '+prefix})`.
  Add `a10-smoke.js` proving two point datasets coexist + analyze independently.
  Instance tabs are NOT persisted until phase 6 (wsApplyLayout sanitize drops a
  `d*` tab whose dataset is absent on restore).

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

- **D1**: model is always the hub/Δ% subject; reference is the denominator.
  Model-vs-model = previous model loaded as point dataset. *(default: yes)*
- **D2**: soft cap 4 datasets. *(default: yes)*
- **D3**: declustering/top-cut default to the reference, retargetable
  per point dataset. *(default: yes)*
- **D4**: legacy projects: `aux` migrates to `d2` named by its old prefix,
  starred. *(default: yes)*
