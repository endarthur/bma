# C10 Design — Dataset ↔ Surface decoupling (the targeting framework)

Design note, 2026-06-21. Status: **design pass, not implemented**. Companion to
`docs/roadmap-tracker.csv` row C10. Sits between A10 (the dataset registry) and
C9 (panel instances); it formalizes the contract the A10 G-series and Workspace
v2 grew *ad hoc*, so future datasets (A11 container tables) and surfaces (A16
stereonet) plug in cheaply. Per the naming convention, implementation phases are
numbered inside this doc ("Phase 0…N").

## The smell (evidence)

Across A10 G-series + Workspace v2, **six analysis surfaces** — Statistics,
Categories, Swath, StatsCat, GT, Export — each independently grew the *same*
machinery:

- `<x>TargetDsId` — which dataset the surface targets (6 copies).
- `<x>TargetableDatasets()` — which datasets it can target (6 copies).
- `<x>TargetDs(root)` / `<x>Ctx(root)` — resolve the target + its schema/data/UI.
- `<x>StateForRoot(root)` — singleton-proxy vs clone instance state (the 5-beat
  clone arc, re-implemented per surface).
- `<x>RenderDatasetPicker` — the dataset dropdown.
- refresh hooks (aux-complete + clearAux + wsRemoveInstance) + persistence
  (`<x>.targetDsId` + per-ds selection by name).

The `TargetableDatasets()` six are the tell:

- **four are byte-identical** — `datasets.filter(d => d.complete)` (stats,
  statsCat, gt, export).
- **two add a capability predicate** — Categories needs `d.complete.categories`;
  Swath needs `d.complete.geometry.x.blockSize`.

So a surface doesn't want "all datasets" — it wants **datasets that expose the
facet it consumes.** That predicate, hand-coded six times, *is* the missing
abstraction. Each new surface (A16) re-pays the whole tax; each new dataset kind
(A11 container tables) must satisfy whatever shape each surface happens to read.

## The two-sided contract

### DatasetSource (the data side)

A stable interface every dataset satisfies, so surfaces read **one** shape
instead of reaching into `current*` globals / `ds.complete` / `aux*` ad hoc:

- identity — `id`, `label`
- schema — `header`, `colTypes`, `origColCount`, `rowVar`
- rows — `file`, `filter`, `calcolCode/Meta`, `preflight` (worker/stream inputs)
- analysis — `complete` (stats / categories / geometry), `hasComplete`
- **facets** — `analyzed`, `categorical`, `numeric`, `gridded`, `xyz`,
  `orientation`… each a cheap derived predicate (see below)
- roles — weight / density / tonnageFactor (via the catalog)

Today this is scattered: the model is `datasets[0]` viewing the `current*`
globals; aux is `datasets[1]` over `aux*`; d2+ are real. The contract just *names*
what they all already expose. A11 container tables and an A16 orientation
dataset implement the same interface and are instantly first-class.

### Facets (the key abstraction)

`dsHasFacet(ds, facet)` — one predicate table, replacing the per-surface
capability checks:

| facet | predicate (today's scattered logic, centralized) |
|-------|--------|
| `analyzed` | `!!ds.complete` |
| `categorical` | `ds.complete.categories` non-empty |
| `gridded` | `dsHasGrid(ds)` / `complete.geometry.x.blockSize` |
| `xyz` | `dsHasXYZ(ds)` |
| `numeric` | has ≥1 numeric column |
| `orientation` | has attitude columns (dip-dir/dip, strike/dip, trend/plunge) — A16 |

A surface declares the facet it needs; the framework filters. Adding a facet
(`orientation`) is one table row + the surface that wants it.

### Surface framework (the consumer side)

A small framework so a panel declares behavior, not boilerplate:

- `surfaceTargetableDatasets(facet)` — **one** implementation (replaces 6).
- `surfaceTarget(surfaceId, root)` + `surfaceCtx(surfaceId, root)` — **one**
  target-resolution + ctx path (replaces 6).
- a shared **dataset-picker** component (replaces 6 `RenderDatasetPicker`).
- the **clone-instance** machinery (StateForRoot: singleton-proxy vs clone) and
  its persistence (targetDsId + per-ds selection-by-name) factored **once** (the
  5-beat clone arc becomes framework, not per-surface copy-paste).
- shared **refresh** hooks (aux-complete / clearAux / wsRemoveInstance).

A surface registers: `{ id, facet, render(ctx), schemaFor(ds),
serializeSel(ds) / restoreSel(ds) }`. The framework owns targeting, the picker,
cloning, persistence, and refresh.

## Payoff

- **A16 stereonet** = implement `render` + `schemaFor` against the contract,
  declare facet `orientation`; targeting / picker / clone / persist come free.
- **A11 container datasets** = implement DatasetSource; every surface sees them
  automatically (collar / survey / interval / composite tables become targets
  with zero per-surface work).
- The recurring "add a Dataset picker to panel X" / "thread root through panel X"
  task — the bulk of the G-series and Workspace v2 — stops recurring.

## Phasing (extraction; each bit-identical, smoke-guarded)

This is a **consolidation of existing, working behavior**, not new features — so
it extracts incrementally, each step proven bit-identical by the existing
per-surface smokes. No big-bang.

- **Phase 0** — `dsHasFacet(ds, facet)` + `surfaceTargetableDatasets(facet)`;
  repoint all six `<x>TargetableDatasets()` (4 → `analyzed`, Categories →
  `categorical`, Swath → `gridded`). Smallest, safest, today-doable; proves the
  facet model. (The two capability predicates move into the facet table verbatim.)
- **Phase 1** *(done)* — shared dataset-picker component (`dsPickerHtml(cfg)` in
  core.js): the six `RenderDatasetPicker` now build their markup through it,
  passing only their facet + CSS classes + `data-*` marker. GT wraps the shared
  inner markup in its own section (it wires onchange via sidebar delegation, not
  a per-picker querySelector). Bit-identical (`esc()` is a no-op on dataset ids);
  proven by the six `*-perds` smokes + the clone smokes.
- **Phase 2** *(done)* — `surfaceTarget(facet, id, opts)` in core.js centralizes
  the id→ds target resolution (usability test + the two fallback policies the
  surfaces grew: stats/cat/swath bounce ANY unusable target to the first
  facet-targetable; export/gt `keepUnanalyzed` keep a non-model target and only
  bounce the model). Five `<x>TargetDs` become one-line delegations; each `Ctx`
  keeps its own thin schema resolver (the model-globals-vs-`ds.complete` field
  mapping is genuinely per-surface). StatsCat stays bespoke (its resolver is the
  simpler `dsById(id) || model` with no `.complete` check — routing it would
  change behavior). Bit-identical; targeting + clone smokes green.
- **Phase 3** *(done — scoped to genuine duplication)* — three shared helpers in
  core.js capture the clone plumbing that was copy-pasted: `surfaceIsInst(root,
  attr)` (the clone-root predicate), `surfaceInstState(root, attr, instances,
  make)` (get-or-create the per-instance state; null → singleton), and
  `surfaceCloseInstTabs(instances, dispose?)` (the fiddly `wsRails`/`findTab`-
  guarded close-tab + teardown loop). Five surfaces route `IsInst` +
  `StateForRoot`/`InstTarget` through the first two; all six `ResetInstances`
  through the third. **Deliberately NOT framework-ized:** the `_xSingleton`
  accessor proxies, `NewInstState()`, `BuildInstancePanel` clone bodies, and the
  serialize/restore shapes stay per-surface — they name surface-specific globals/
  templates, so they're six different things, not duplication (hook-callbacks
  over them would be more code, not less). Categories' `StateForRoot` also stays
  bespoke (lazy non-creating lookup over `panelState.categories`). Bit-identical;
  all clone + persist + perds smokes green.
- **Phase 4** *(done — documentation, not code)* — the `DatasetSource` contract
  written down as the interface the registry already guarantees (the "as built"
  section below). No code change: P0–P3 proved every dataset satisfies it; P4
  names it so A11 tables and an A16 dataset implement one shape instead of
  reverse-engineering six surfaces. Includes a "first-class checklist" a new
  dataset kind fills out.

Phases 0–1 are pure win with near-zero risk; 2–3 are the real consolidation; 4 is
the interface contract that makes A11/A16 cheap.

## The DatasetSource contract (Phase 4, as built)

Every entry in the `datasets` registry (`src/core.js`) satisfies this interface.
Three backings implement it today and are **interchangeable to a surface**:

- **model** — `datasets[0]`, a getter/setter *view* over the legacy `current*` /
  `lastCompleteData` / `preflightData` globals (so existing code stays
  byte-identical; the A10 bit-identical contract).
- **aux** — `datasets[1]`, a view over the `aux*` globals (the first comparison).
- **d2, d3, …** — real plain objects from `dsCreate()` (`dsAdd`/`dsRemove`).

A surface reads a dataset **only** through `dsById(id)` + the facade functions
below — never by reaching into `current*` / `aux*` directly. That indirection is
what lets a new dataset kind (an A11 table, an A16 orientation set) appear as a
first-class target with zero per-surface work.

### Fields & accessors

| Group | Member | Notes |
|-------|--------|-------|
| identity | `ds.id` | `'model'` \| `'aux'` \| `'d2'`… — catalog namespace, project key, pack folder, expression handle. |
| identity | `dsLabel(id)` | display label (`'Model'`, else `ds.prefix` / `auxPrefix`). Don't read `ds.prefix` directly. |
| schema | `ds.preflight` | sampling result: header, `autoTypes`, `xyz`, units. The pre-analysis schema store. |
| schema | `ds.complete` | the analysis result (stats / categories / geometry / header / colTypes / rowCount / totalRowCount / origColCount …). Shape: `docs/worker-protocol.md`. `null` until analyzed. |
| schema | `ds.calcolCode` / `ds.calcolMeta` | calculated-column block + metadata. |
| rows | `ds.file` / `ds.handle` | the `File` (and FS handle) the worker streams. |
| rows | `ds.filter` | global filter expression (`{expression}` or null). |
| rows | `ds.rowVar` | expression handle: model `currentRowVar` (`'r'`), aux `AUX_ROW_VAR`, d2+ = its `id`. |
| rows | `ds.source` | `'file'` today (model + d2+; aux implicit). Room for non-file sources (A11 derived tables). |
| analysis | `ds.stale` | results no longer match config → needs re-analyze. |
| facets | `dsHasFacet(ds, facet)` | `'analyzed'` / `'categorical'` / `'gridded'` implemented; others reserved (see below). |
| facets | `dsHasGrid(ds)` / `dsGrid(ds)` | the block-geometry facet (respects `dsGridMode`). `dsHasXYZ(ds)` = XYZ assigned. |
| roles | `catRole(ds.id, role)` | `'weight'` / `'density'` / `'tonnageFactor'` — the catalog's per-dataset role bindings. |
| config | `ds.gridMode` | `'grid'`/`'point'`/`'auto'` override (`dsGridMode(ds)` resolves the default). |
| config | `ds.declus` / `ds.topcut` / `ds.view` | per-dataset analysis-tool config. |

### Facets (the capability layer)

`dsHasFacet(ds, facet)` is the one predicate table surfaces filter on (P0). A
facet **presupposes an analysis** (`ds.complete`). Implemented today:

| facet | predicate |
|-------|-----------|
| `analyzed` | `!!ds.complete` |
| `categorical` | `ds.complete.categories` non-empty |
| `gridded` | `ds.complete.geometry.x.blockSize` present (raw — note `dsHasGrid` is the override-aware form) |

Reserved for consumers that need them — **add the row + nothing else**:
`numeric` (≥1 numeric column), `xyz`, `orientation` (A16: attitude columns).

### First-class checklist (what a new dataset kind implements)

An A11 container table or A16 orientation set becomes a target everywhere by
satisfying the above: give it an `id` + `dsLabel`; populate `preflight` then
`complete` from an analysis pass; expose `file`/`filter`/`calcolCode`/`rowVar`
for the worker; declare which facets it has (it just needs the data — the facet
predicates read `complete`). No surface code changes; the picker, targeting, and
clone framework (P1–P3) already consume the contract.

### Invariants

- The model's `datasets[0]`-over-globals view must keep satisfying this contract
  **byte-identically** — every accessor proxies to the live global, so external
  readers (`project.js` serialize/restore, `ctxmenu`, `settings.js`) are
  unchanged. This is the A10 bit-identical contract; P0–P3 held it.
- Per-surface, per-dataset *selection* state (today `ds.statsCat`, `ds.export`)
  is **surface-owned**, not part of DatasetSource — the dataset stays a pure
  source. (Open: move these into the surface layer keyed by ds id; see below.)

## Decisions (open)

- Where does per-surface per-dataset state live — on `ds` (today: `ds.statsCat`,
  `ds.export`) or in the surface layer keyed by ds id? Lean **surface layer**, so
  the dataset stays a pure source and surfaces own their selections.
- Is `facet` a single value or a set per surface? Single covers today; allow a
  predicate fn for the odd surface that needs a compound capability.
- Registry note: the model's `datasets[0]`-over-globals view must keep satisfying
  DatasetSource byte-identically (the A10 bit-identical contract holds).

## Relationship

- **A10** — the registry that holds datasets; C10 names the interface they expose.
- **C9** — panel instances; C10's framework owns the clone arc C9 opened.
- **A11 / A16** — the first consumers that make the decoupling pay for itself.
