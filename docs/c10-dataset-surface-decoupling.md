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
- **Phase 2** — `surfaceTarget` / `surfaceCtx` unification (the per-surface
  TargetDs/Ctx keep their thin schema resolver, route through the shared core).
- **Phase 3** — factor the clone-instance StateForRoot + persistence into the
  framework (the heaviest; the clone arcs converge).
- **Phase 4** — formalize DatasetSource as the documented interface the registry
  guarantees; A11/A16 build against it.

Phases 0–1 are pure win with near-zero risk; 2–3 are the real consolidation; 4 is
the interface contract that makes A11/A16 cheap.

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
