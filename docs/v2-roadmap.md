# V2 Roadmap — Validation Suite, Parquet Platform, Dockable UI

2026-06-10. Successor to `v1-roadmap.md`'s Future section; incorporates and amends
the v2 platform spec (parquet/table/section/3D) and reconciles it with
`io-architecture.md`. Three tracks, largely independent — A ships value
immediately, B is the platform investment, C is the workspace.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Validation suite vs platform first | **Track A first** | Small, high-value, tester benefits now; it's the identity (model QA) |
| Parquet library | Vendor **hyparquet** (pure JS) | Per v2 spec; parquet-wasm rejected (6.4 MB). **Gate: local verification of `rowGroupSize`-as-array + benchmarks before phase B2** — the claims were made off-machine |
| Row-source split | **Stands as prerequisite** for the .dm fix + 5× streaming dedup (`io-architecture.md` §1) | The v2 spec's `RowAccess` is read/seek-side and builds *on top*; it doesn't fix decode cost |
| Section overhaul scope | **Slimmed**: inline plane predicate (~10 lines, per-row DXYZ) + vendor `@gcu/dee` color.js only | `@gcu/grid slicePlane` iterates a materialized regular grid — wrong shape for streamed rows |
| Storage layer | Vendor **@gcu/vfs** (core + opfs/idb/fsaa) as the **source-resolution layer** ("phonebook, not pipe") | Mount table resolves dropped Files/FSAA handles/zip-entries-as-folders to native Files; streaming hot path never goes *through* it. Scratch = custom backend with positional writes over OPFS sync access handles |
| Layout | Vendor **@gcu/rails** (~6 KB gz), dockable panels | Domain-real (geologists work in docked layouts); dissolves tab-bar crowding; panels-coexist work is mechanical (ResizeObserver re-render) |
| Data tree panel | **Yes, with catalog semantics** (Leapfrog-style project tree), designed jointly with rails as one workspace rework | Tree = what exists (datasets, variables by kind, colors/units/roles, filters); each view keeps its own membership. NOT GIS visibility semantics — many views, legitimately different selections. Unifies the scattered per-variable property systems and is the UI prerequisite for N-dataset comparison (QP check-model practice: samples vs up to 3 estimates). Tree node model designed alongside `bma:roles` so UI and file format agree |
| works-core as host | **No** — keep sovereign single file; thin surface wrapper later, additively | Identity + the host's package model is mid-rebuild |
| Declustering | **Plain-JS GSLIB DECLUS** in worker (~80 lines); `gslib.atra` as test oracle | No wasm in BMA; DECLUS is the simple corner of GSLIB; GSLIB citation > vendor parity |
| Change of support | **r/f as user input** (slider), never derived from the model (circular) and no variography UI | Affine v0 → Hermite DGM v1; oracles: lognormal closed forms (exact) + gstlearn Python (BSD-3) |
| 3D | Sidecar per v2 spec, **after** chunk-aligned writer | Streaming 3D leans on the layout; cleanly severable |

## Track A — Validation suite

Brings the aux comparison to the full figure set QPs expect in JORC/NI 43-101
model-validation sections (conventions verified against public QP-signed reports,
e.g. Canadian Malartic 2021, New Afton 2025; methods per GSLIB / Rivoirard /
Chilès & Delfiner). Pure worker/UI increments on existing infrastructure.

| # | Feature | Size | Depends | Notes |
|---|---------|------|---------|-------|
| A1 | **% difference columns** in Statistics comparison table | S | — | ✅ **DONE 2026-06-11** — Δ% row under each matched model/aux pair, (model − aux)/aux per metric; count-like and skew/kurt skipped. Smoke: `experiments/delta-row-smoke.js` |
| A2 | ~~Per-bin count bars on swath plots~~ | — | — | **Already existed** (pre-dates the roadmap: `showCounts` strip, primary filled + aux hollow, both layouts — the gap analysis was wrong). Optional polish only: numeric max-count label on the strip |
| A3 | **Cell declustering weights** (aux) | M | — | ✅ **DONE 2026-06-11 (a7b8f3e)** — worker `declus` mode (faithful declus.for, Fortran ncell semantics), `weightArray` by filter-surviving ordinal in analyze+swath (fingerprint-gated, mismatch-guarded), Aux-tab section with sweep curve + Use-as-weight. Oracle harness `experiments/declus-test.js` (19 asserts, elementwise parity vs @atra/gslib) + `declus-ui-smoke.js` |
| A4 | **Log-probability CDF mode** | S–M | — | ✅ **DONE 2026-06-11 (c153c42)** — CDF \| Prob \| Q-Q toggle; `normInv` (gauinv port, 5e-8 vs reference) drives the 0.2–99.8% ruling; log X via existing scale toggle. Smoke: `experiments/logprob-smoke.js` |
| A5 | **Top-cut analysis panel** (aux) | M | A4 | ✅ **DONE 2026-06-11 (8ff2679)** — Aux main-area Preview \| Top-cut toggle; worker `colvalues` mode; four linked plots w/ shared draggable cap (prefix sums → O(log n) per cap); Copy-calcol applies via `cap()`. Smoke: `experiments/topcut-smoke.js` |
| A6a | **Theoretical GT overlay — affine engine** | M | A3 | ✅ **DONE 2026-06-12 (65a7c6e)** — GT sidebar "Theoretical (samples)" section: f slider (user input, never model-derived), dashed overlay scaled to model total tonnage, aux-weighted distribution via `colvalues` (+weights), live re-evaluation. Smoke: `experiments/gt-theo-smoke.js` |
| A6b | **DGM (Hermite) engine** | L | A6a | Hermite anamorphosis fit on the (declustered) aux distribution, φₙ→φₙrⁿ, r from f by root-find; closed-form T/Q above cutoff; slots into the existing engine select. Caveats (multigaussianity, no info effect) in help. Oracles: lognormal closed forms (exact — block dist is lognormal σ→rσ under lognormal anamorphosis); gstlearn (BSD-3 Python) harness |

| A7 | **Drillhole aux ingestion** (collar + survey + intervals) | L | soft: C1a | The adoption unlock: raw drillhole tables → min-curvature desurvey → length-weighted down-hole compositing (SUPPORT emitted, optional domain boundaries) → a synthesized point dataset feeding the existing aux pipeline **unchanged** (declus/top-cut/Δ%/Q-Q/swath/theoretical GT all free). **The consistency report is the feature**: BHID join failures, overlapping intervals, missing surveys, EOH mismatches surfaced, never silently dropped (no-magic). UI: pre-tree = three slots + zip role detection on the Aux empty state; re-homes naturally under the C1a tree (a drillhole set *is* a tree). Math factored as `@gcu/drillhole` (dee already has min-curvature desurvey — extract/share; oracle-harness playbook like DECLUS). Unlocks later: contact analysis (was LOW *because* BHID was missing), 3D traces in B7 |

Out of scope, confirmed: variography, KNA. Contact analysis graduates from
out-of-scope to "post-A7" — it was excluded for missing BHID structure, which
A7 provides.

## Track B — Platform (amended v2 spec)

| # | Phase | Size | Depends | Notes |
|---|-------|------|---------|-------|
| B0 | **Verify hyparquet claims** | S | — | ✅ **DONE 2026-06-12** (`experiments/hyparquet-verify.mjs`; hyparquet + hyparquet-writer as devDeps). **Confirmed**: `rowGroupSize` array → exact group boundaries (the chunk-aligned gate); kvMetadata round-trips; per-group min/max stats; projection 5–8×; 100-row seek ~12 ms. **Corrected**: `parquetReadObjects` penalty is ~1.8× at both 1M and 5M rows, not the spec's claimed 7× (columnar path still prescribed). **Design note**: rowGroupSize's *last size repeats* — the .bma writer must pass the complete per-chunk array |
| B1 | **Row-source split** (+ near-term .dm patches anytime: batched page reads, `toPrecision(7)` stringify) | L | — | ✅ **DONE 2026-06-11** — `makeRowSource()`/`streamCsvLines()`/`forEachRow()` in worker.js own extraction/sniff/calcol-compile/buildRow/line-loop; all 7 passes converted, filter ordering + weight-ordinal contract preserved verbatim; batched .dm page reads landed (~2MB/pull). Verified bit-identical vs pre-split worker: `experiments/b1-differential.js` (29 cases, all modes, incl. synthetic .dm fixtures) + full harness suite; perf neutral. **Remaining (→ B2/B4 era)**: binary `DmRowSource` decode (changes outputs — decimal detection reads field strings; needs passes to stop re-parsing raw fields) and `toPrecision(7)` stringify (not bit-identical, own accuracy decision) |
| B2 | **Parquet adapter** | M | B0 | Vendor hyparquet (+snappy; zstd decision per spec §8.1); `PAR1` sniff; columnar `onChunk` → row adapter (never `parquetReadObjects`); preflight read-only schema mode; Model + Aux both |
| B3 | **VFS + .bma writer** | L | B0, B2 | Vendor @gcu/vfs (core/opfs/idb/fsaa); `ScratchBackend` w/ positional writes; zip-as-folder backend consolidates the three ad-hoc zip flows; `.bma` = valid parquet + KV metadata (`bma:*` keys per spec §1.5) + chunk-aligned row groups (§1.6); Export target; project paths via mounts |
| B4 | **Block index + RowAccess** | M | B1 | Per-block min/max/nulls during analysis; pushdown on filtered re-analysis; `CsvBlockIndexAccess` / `ParquetAccess` (footer stats) / `DmAccess` (arithmetic seek) |
| B5 | **Table tab** | M | B4 | Vendor @gcu/loom; PENDING provider over RowAccess + LRU; pushdown-scan vs collected-ordinals browse; detail pane |
| B6 | **Section overhaul** (slim) | M | B4 | Inline plane predicate w/ per-row DXYZ; vendor dee color.js (replaces hand-rolled colormaps, shared colorbar); slab resolution via chunk directory on .bma, block-index pushdown on CSV |
| B7 | **3D sidecar** | L | B3 | `bma-3d.js` (Three.js pinned to dee's tested rev + dee + voxmesh); streaming path on chunk-aligned .bma, budgeted binning path otherwise; Generate-button estimates; honest HUD labeling |

## Track C — Workspace

| # | Item | Size | Notes |
|---|------|------|-------|
| C1a | **Data tree, step 1: property catalog** | M | ✅ **DONE 2026-06-11** (1d39088 catalog+migration, 00b8e5d read-only tree, c936048 editing incl. the pairing editor; smoke `experiments/tree-smoke.js`). **Design + step log: [`docs/c1a-property-catalog.md`](c1a-property-catalog.md)**. Original scope: Left tree panel: datasets → variables grouped by kind (coordinates / grades / categories / calculated), per-variable color chip, unit, role badges (weight/density/class), dataset metadata. Becomes the single source of truth for the currently-scattered systems (`catColorOverrides`, swath `'aux:NAME'` color keys, GT units, weight selections) — existing per-tab pickers stay and *read* from it. Independently useful for `bma:roles` (B3). **Explicit model↔aux pairing**: the case-insensitive name match (used identically in Statistics/Swath/Categories) becomes the *default seed*, not the mechanism — pairings visible in the tree, manually overridable (pair `FE_PCT`↔`Fe` without a rename calcol), orphans evident at a glance, persisted in the project. Principle: infer defaults, never hide state — magic-only conventions are bad UI |
| C1b | **Rails dockable layout + tree as left rail** | M–L | **Design: [`docs/c1b-rails-docking.md`](c1b-rails-docking.md) (2026-06-11)** — @gcu/rails (at `../auditable/ext/rails`) verdict vendor-as-is; panels as singletons over two shells; chart container-width phase (C1b-0) lands first and independently. Original scope: | Vendor @gcu/rails; panels coexist (ResizeObserver re-render for SVG charts — the bulk of the work); per-panel sidebars slim to view-local config (percentiles/directions/cutoffs), membership fed from the tree; layout state in `serializeProject()`; `--au-*` → BMA token map. Best landed before B5/B7 so Table/3D arrive as dockable panels. Deletes the `.results-panel.active` CSS-scoping bug class. Export keeps its full column selector (export *is* a selection task) |
| C1c | **Mobile shell** (decided 2026-06-11: one app, two shells — NOT a separate mobile UI) | S–M | Below the existing ~700px breakpoint, the same container-agnostic panels render in a single-panel pager (scrollable tab strip or bottom bar); sidebars and the C1a tree become slide-over sheets; desktop keeps C1b docking. **Groundwork already in place**: viewport meta + manifest (installable PWA on Android), ≤700px sidebar-stacking on every tab, viewBox-scaled SVG charts (shrink legibly). **Pre-C1b quick wins, can land anytime (S)**: pointer-events migration — 7 files use mouse-only handlers (topcut cap drag, categories drag-reorder, declus curve hover/pin, swath/CDF/GT crosshairs); `pointerdown/move/up` + `touch-action: none` on drag surfaces serves mouse and touch with one API. Plus horizontal-scroll wrappers on wide tables (stats metrics) and ≥44px tap targets on chips/toggles. **Framing: review-first** — author on desktop, open a packed `.bma.zip` on the phone (file input works on Android; FSAA absent → recents already degrade via `HAS_FSAA`); phone-sized files only, no multi-GB promises. **Constraint on C1b**: panel lifecycle must not require the dock — the mobile pager reuses the same panels. **Context menus on touch**: the desktop right-click menu (`src/ctxmenu.js`) routes every action through shared functions (`openTreeEditor`, `treeToggleRole`, provider items) — C1c binds long-press to the same `showCtxMenu(items, x, y)`; a pointerdown timer (~500 ms, cancelled by move/up) is the whole job, no redesign |
| C2 | works surface wrapper | S (later) | Thin `package.json` + `works.js` around index.html, additive, after the .gcupkg registry settles. Verify VFS/mount-delegation perf on multi-GB before promising |
| C3 | (door marked, not walked through) Tree as live lineage graph | L (later) | BMA already has implicit dependency semantics (`auxStale`, stats stale marks, `analysisFingerprint()`); promoting the tree to Leapfrog-style propagate-downstream is a separate decision — engine candidate exists (`@gcu/flowsheet`: lazy, content-addressed, hash = params + upstream hashes). Likely where BMA and the works workbench eventually meet |

## Suggested order

*(A1–A5, A6a, B0, B1 done.)*

**B1 ✅ → C1a → C1b → A7 → A6b → B2 → B3 → B4 → B5 → B6 → B7.**

B1 went first (landed 2026-06-11): invisible to
testers, the worker harness suite was at peak coverage for its bit-identical
discipline, and A7's new readers will be born on row sources rather than
migrated to them. **Next: C1a.** Then the workspace generation (C1a property
catalog → C1b rails), with A7 and A6b landing in the new home; the platform
phases follow, with B5/B7 arriving as dockable panels because C1b came first.

## Housekeeping (standing)

- `worker-protocol.md` / `code-map.md` refresh (stale since aux/weights/directions)
- pt-BR manual regen after UI changes (`experiments/manual-shots.js` → `manual-pdf.js`)
- ~~`experiments/bma-swath-test.js` update for the directions-based swath protocol~~ done 2026-06-11 (39 assertions incl. multi-direction single-pass)
- Tag a release at next push
