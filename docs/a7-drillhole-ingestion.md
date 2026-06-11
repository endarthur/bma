# A7 Design — Drillhole Aux Ingestion

Design note, 2026-06-11. Status: **design pass, not implemented**. Companion
to `docs/v2-roadmap.md` row A7. Per the roadmap naming convention,
implementation phases are numbered inside this doc only ("Phase 0…3").

## Goal

Raw drillhole tables — **collar + survey + intervals** — become a first-class
aux source: min-curvature desurvey → length-weighted down-hole compositing →
a synthesized point dataset that feeds the existing aux pipeline
**unchanged**. Everything aux already does (Δ% rows, CDF/Q–Q, swath overlay,
declustering, top-cut, theoretical GT) works on day one, because by the time
the pipeline sees the data it *is* an ordinary point file.

**The consistency report is the feature.** Resource geologists don't trust a
black box that swallows three tables and emits points; they trust the tool
that says "14 intervals reference BHIDs with no collar, 3 holes have
overlapping intervals, 2 surveys extend past EOH" — and shows them. Nothing
is silently dropped (no-magic rule).

What this unlocks later: contact analysis (was scoped LOW *because* BHID was
missing), 3D hole traces in B7.

## Inputs & data model

Three delimited tables (drag three files, or one zip containing them):

| Table | Required columns | Optional |
|---|---|---|
| **Collar** | BHID, X, Y, Z | EOH (total depth) |
| **Survey** | BHID, DEPTH, AZIMUTH, DIP | — |
| **Intervals** | BHID, FROM, TO | every other column = data (grades, lithology, …) |

- **Role detection** is by header signature, with filename as a tiebreaker
  (`collar*`, `survey*`, `assay*/sample*/interval*`): BHID+XYZ → collar;
  BHID+depth+azimuth+dip → survey; BHID+from+to → intervals.
- **Column mapping** is auto-detected from a synonym list and always shown as
  editable selects (infer defaults, never hide state):
  - BHID: `bhid, holeid, hole_id, dhid, hole, dhno, name`
  - collar X/Y/Z: `x/east/easting/xcollar`, `y/north/northing/ycollar`,
    `z/elev/elevation/rl/zcollar`; EOH: `eoh, depth, maxdepth, td, total_depth`
  - survey: `at, depth, dist`; `az, azim, azimuth, brg, bearing`;
    `dip, incl, inclination`
  - intervals: `from, depfrom, from_m`; `to, depto, to_m`
- A hole with **no survey rows** desurveys as a straight hole using a
  synthetic station (az 0, dip straight down — or the collar dip columns if
  present later; v1: straight down, counted in the report).
- A survey list that doesn't start at depth 0 gets a **synthetic station at
  0** copying the first station's attitude (standard practice).

## Math (`@gcu/drillhole`)

Factored as a new ext library in auditable — `ext/drillhole`, sibling of
rails/menu/dee — and vendored into BMA like rails/menu. Dee's
`desurvey()`/`interpolatePath()` (`ext/dee/src/layers.js:303`) is the seed;
dee later adopts the lib and drops its inline copy.

- **Desurvey: three methods, user-selectable** (Arthur, 2026-06-11 —
  straight-segment methods are genuinely useful for sparse/legacy surveys
  and for matching historic desurveys):
  - **minimum curvature** (default) — standard dogleg ratio factor
    (dee's implementation is already correct: RF = (2/θ)·tan(θ/2),
    straight fallback below 1e-6);
  - **balanced tangential** — the same segment step without RF (averages
    the end tangents; matches several packages' legacy output);
  - **tangential** — straight segments along the lower station's attitude
    (matches dee's simple-tangential seed).
  `positionAt` interpolates **consistently with the hole's method** (arc /
  straight segment / chord) — interpolated depths must land on the same
  path the stations were placed on; the harness pins all three.
- **Conventions (D1)**: azimuth degrees clockwise from north; dip in the
  *mining convention*, **positive down** (a -60 file means 60° below
  horizontal in the signed-math convention dee uses). Auto-detect: if the
  median survey dip is negative → assume negative-down and flip; the
  detected convention is shown in the mapping UI as a toggle, never hidden.
- **Interpolation along the arc (D2)**: dee interpolates positions by chord
  (linear between stations). The lib should interpolate *attitude* (slerp of
  the two unit tangents) and integrate min-curvature within the segment, so
  composite endpoints land on the arc, not the chord. Cheap (closed form),
  and it's what the commercial packages do; the oracle harness quantifies
  the chord error so the decision is visible.
- **Compositing**: fixed-length down-hole composites of length L from each
  hole's first interval depth (D3 default: the **mode of (TO−FROM)** over
  the interval table, rounded to a tidy value, shown editable):
  - numeric columns: length-weighted mean over the overlapping covered
    length; missing values reduce coverage rather than poisoning the mean;
  - **SUPPORT** column emitted = covered length within the composite (this
    is the aux weight — declustering and weighted stats consume it as-is);
  - **coverage** is never a silent filter (D5): composites are emitted with
    whatever SUPPORT they have; a *visible* "min coverage %" option
    pre-filters, default off, and filtered counts go in the report;
  - categorical columns (D6): majority value by covered length; ties →
    first encountered; composites whose majority share < 100% are counted
    in the report (no purity column in v1 — keep the table lean);
  - **domain boundaries (D4)**: optional "break on" categorical column —
    composites restart at value changes (so no composite straddles a
    lithology contact). Default off; when on, the final short composite of
    each run is emitted with its true SUPPORT (no smearing);
  - last composite of each hole: emitted with its true SUPPORT (same rule).
- **Output columns**: `BHID, X, Y, Z, FROM, TO, SUPPORT,` + all interval
  data columns (numeric composited, categorical majority). X/Y/Z = the
  composite **midpoint** on the desurveyed path.

### Validation (the consistency report)

Computed during parse/join, surfaced as a panel, never fatal unless nothing
survives:

| Check | Action |
|---|---|
| Interval/survey BHID with no collar | rows excluded + counted, listed |
| Collar with no intervals | hole skipped + counted |
| Collar with no surveys | straight-hole desurvey + counted |
| FROM ≥ TO, negative depths | row excluded + counted |
| Overlapping intervals in a hole | composited as-is (overlap weight double-counts) + flagged per hole |
| Survey depth > EOH, interval TO > EOH (when EOH present) | kept + counted (EOH is advisory) |
| Duplicate survey depths | last wins + counted |
| Non-numeric coords/depths | row excluded + counted |

Report UI: a summary line per check with counts; expandable lists of the
offending BHIDs (first N + "copy all"). The report persists until the next
composite run.

### Oracle harness (the DECLUS playbook)

`experiments/drillhole-test.js` against fixtures with known answers:
- **Analytic paths**: straight inclined hole (closed form), constant-build
  circular arc (the minimum-curvature path of two stations on a circle IS
  the circle — exact positions known), helix from dense stations.
- **Compositing fixtures**: hand-computed length-weighted means incl. gaps,
  overlaps, domain breaks, missing values.
- Cross-check candidate: a small Python reference (pygslib/pygeostat have
  desurvey+compositing) run once to generate golden files — committed as
  fixtures, not a runtime dependency.

## Pipeline integration

- The compositor emits a CSV string → `new File([csv], '<set-name>-composites.csv')`
  → **`loadAuxFile(file)` unchanged**. Preflight sniffs it like any drop;
  XYZ auto-detects; SUPPORT is offered as the aux weight (auto-assigned via
  `catSetRole('aux','weight','SUPPORT')` — visible in the tree as W).
- Parsing the three inputs happens on the **main thread** (D7): drillhole
  exports are orders of magnitude smaller than block models (10⁴–10⁶ rows);
  a simple delimiter-sniffing parser (reuse preflight's sniff helpers) with
  a size guard (warn > ~100 MB combined) keeps the worker protocol
  untouched. If a giant interval table ever shows up, compositing moves
  behind a worker mode — the lib is pure functions either way.
- `auxPrefix` defaults to `dh` for drillhole-derived sets (cosmetic only).

## UI

On the **Aux empty state**, beside the existing dropzone: a "Drillhole set"
card with three labeled slots (Collar / Survey / Intervals). Dropping a zip
on it (or dropping three files at once) role-detects the entries; each slot
shows the matched file + a role override select. Below the slots:

1. **Mapping panel** — per-table column selects (auto-detected, editable),
   the dip-convention toggle (prominent, D1), the **desurvey method select**
   (minimum curvature default | balanced tangential | tangential),
   composite length, optional domain column, optional min-coverage filter.
2. **[Composite & load]** — runs validate → desurvey → composite, shows the
   **consistency report**, and loads the derived File as the aux dataset.
3. After load, the aux header line shows the provenance ("562 composites
   from 48 holes · collar.csv + survey.csv + assays.csv") with a
   **[Report]** link re-opening the last consistency report and an
   **[Edit & re-composite]** link back to the mapping panel.

The derived dataset then behaves exactly like a dropped file: preflight
sidebar, filters, calcols, declus, top-cut — nothing new to learn.

## Persistence & pack

- Project key `aux.drillholes = { files: [{role, name, size}], mappings,
  dipConvention, compositeLen, domainCol, minCoverage }`. The **derived CSV
  is never persisted** — like declus weights, it's recomputed (re-drop the
  three files on restore; the mapping re-applies; composite re-runs).
- **Pack (D8)** carries the three **raw** files + the recipe in the project
  json; on packed-load, BMA re-derives. (Raw-in/derived-out keeps the pack
  auditable — the recipe IS the documentation of what was done.)
- The C1a tree shows the aux dataset as today; a dataset note row lists the
  three source files (full "drillhole set as a tree" rendering can come
  with contact analysis later).

## Phasing (each lands green)

- **Phase 0 — `@gcu/drillhole`** (reverse-vendored per D9): `desurvey.js`
  (min-curvature + tangential + arc interpolation), `composite.js`,
  `validate.js`, SPEC + oracle fixtures. BMA-side harness
  `experiments/drillhole-test.js` passes against the analytic fixtures.
  ✅ **DONE 2026-06-11** — `src/vendor-drillhole.js` (pure functions,
  `Drillhole.*` namespace, upstream-style section banners; in
  `APP_MODULES`, no callers yet). Harness: 50 asserts — straight holes
  closed-form; 21-station horizontal circle exact to 1e-14 incl.
  *mid-segment* `positionAt` (proves D2 arc-correctness — chord would err
  ~0.125 m at R=100/Δ=10); vertical-plane quarter circle; both dip
  conventions detect + normalize to the same path; normalization edges
  (sort/dup/bad/synth station 0); all hand-computed composite fixtures
  (gaps, overlaps, missing assays, domain breaks, majority, minCoverage,
  default-length mode); validation counts for all eight checks; output
  shape. Implementation notes: composite XYZ = covered-length **centroid**
  (not window midpoint — honest for partial coverage); run extent =
  min(FROM)…max(TO) with a scan (an early long interval can outrun the
  last-sorted one); windows index-stepped (no float drift).
- **Phase 1 — ingestion UI**: vendor the lib; Drillhole-set card + role
  detection + mapping panel + report + Composite-&-load → `loadAuxFile`.
  Playwright smoke `experiments/drillhole-smoke.js` (synthetic trio →
  composites → aux analyze → Δ% row appears).
  ✅ **DONE 2026-06-11** — `src/drillhole.js` (APP_MODULES after
  auxtab.js): card on the Aux empty state with three role slots (header
  signature first, filename tiebreaker; zip entries auto-extracted via
  `zipEntryToFile`); mapping panel with per-table selects, the prominent
  amber-glow dip-convention row (auto-detected, two-button override), the
  three-method desurvey select, length (placeholder = lib default),
  domain + min-coverage; consistency report inline + reopenable modal;
  Composite & load builds tables on the main thread (150 MB confirm
  guard), emits CSV → `new File` → `loadAuxFile` unchanged. SUPPORT role
  assigned *before* the load so the weight select renders with it;
  `auxPrefix` defaults to `dh`. Provenance banner in the aux header
  (Report / Edit & re-composite — the latter `clearAux()`s while the card
  state survives). Option inputs survive mapping re-renders. Aux F1 help
  updated. Smoke: 24 asserts incl. neg-down detection on a
  negative-dip trio, dip-flip geometry (first centroid at z−1), report
  contents (orphan BHID, FROM>TO), Δ% rows on dh:Fe, tree W badge on
  SUPPORT, and the edit-set round trip. Lib fix surfaced by the UI:
  `defaultLength` iterated `bhid.length` — now `from.length` (bhid-free
  contract pinned in the harness). Full suite green (10/10).
- **Phase 2 — persistence + pack**: project key, pack the raw trio,
  restore re-derivation. Smoke extends to reload/pack round-trip.
- **Phase 3 — example + docs**: the example generator emits a drillhole
  trio for the same synthetic deposit (the current samples file becomes
  *derivable* — keep both so old tutorials hold); TUTORIAL.txt section;
  manual sections + screenshots (both languages); help text on the Aux tab.

## Decisions

| # | Decision | Call |
|---|---|---|
| D1 | Dip convention | **Made (Arthur, 2026-06-11)**: mining positive-down declared; auto-detect sign from the median survey dip; **the convention toggle must be very visible** in the mapping panel — not tucked in an advanced section |
| D2 | Chord vs arc interpolation of composite endpoints | **Made**: arc-correct in the lib (slerp attitude + closed-form integral); harness reports the chord delta |
| D3 | Default composite length | **Made**: mode of (TO−FROM), tidied; always editable (the default is a seed, never a constraint) |
| D4 | Domain-boundary breaking | **Made**: optional categorical select, default off. **Future (Arthur)**: add the ability to *materialize* the composited dataset (export the derived table as a real file) — noted under Out of scope |
| D5 | Low-coverage composites | **Proposed**: always emitted with true SUPPORT; min-coverage filter visible + default off; counts in report |
| D6 | Categorical compositing | **Proposed**: majority by covered length; sub-100% majority counted in report; no purity column in v1 |
| D7 | Where the compositor runs | **Proposed**: main thread with size guard; lib is pure so a worker mode is a relocation, not a rewrite |
| D8 | Pack contents | **Proposed**: raw trio + recipe; derived CSV never packed (recompute like declus weights) |
| D9 | Library home | **Made (Arthur, 2026-06-11): reverse vendoring.** Developed *here* as `src/vendor-drillhole.js`, written in the upstream ext-source style (section banners, `Drillhole.*` namespace) as if vendored from `auditable/ext/drillhole`; transferred upstream once it settles (the auditable repo has an active claude code session — avoid concurrent edits there). Dee adopts the lib after the upstream transfer |

## Out of scope (this row)

Contact analysis (unlocked, separate row), 3D traces (B7), survey
corrections (declination, gyro vs magnetic), composite back-flagging into
the interval table, multi-element unit harmonization beyond the catalog's
existing per-variable units, **materializing the composited dataset as an
exportable file** (Arthur, D4 note — wanted eventually; today the derived
table lives only in memory + recipe).
