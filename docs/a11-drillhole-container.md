# A11 Design — Drillhole Container & Compositing Surface

Design note, 2026-06-21. Status: **design pass, not implemented**. Companion to
`docs/roadmap-tracker.csv` row A11 (expands it from "multi-table drillholes" to
the full container model). Builds directly on `docs/a7-drillhole-ingestion.md`
(A7 shipped in v1.1.0: one trio → desurvey → one composite point dataset). Per
the roadmap naming convention, implementation phases are numbered inside this
doc only ("Phase 0…N").

## Why

A7 made drillholes a first-class source via the **happy-path special case**:
exactly one (collar, survey, intervals) trio in, exactly one composited point
dataset out, compositing options fixed on a card. Two user asks (Arthur,
2026-06-21 — "export the raw tables, keeping calcols on each") pointed past that
special case at the general structure real drillhole tools use, and it's worth
naming as the design of record:

- The raw collar/survey/interval tables are already **retained in memory**
  (`dhStateFor(ds).files` + `.parsed`, kept for Pack re-derivation), so getting
  them back out is small — *except* that **calcols have nowhere to live** but the
  single composite. That asymmetry is the tell: the model is too flat.

The fix is to promote a drillhole set from "a trio that becomes a dataset" into a
**container** of related tables with an explicit compositing step between them.
Once that exists, **both original asks fall out for free** (export any table;
calcols belong to whichever table you authored them on).

## The container model

A **DrillholeSet** is:

- **collar** (exactly 1) — BHID + XYZ + EOH. The spatial anchor.
- **survey** (exactly 1) — BHID + depth + azimuth/dip. Drives desurvey.
- **interval tables** (N ≥ 0) — each BHID + FROM/TO + columns. Each table has a
  **kind**:
  - **imported** — a raw downhole table (assays, lithology, geotech, density,
    recovery…). Multiple are normal.
  - **merged** — produced by joining ≥2 interval tables down-hole (see the merge
    kernel). E.g. assays + lithology → one table carrying grade *and* domain.
  - **composite** — produced by the compositing surface from one source interval
    table (raw or merged).

The interval tables form a small **DAG**: `imported → (merge) → (composite) →
output`. collar + survey are shared backbone for all of them (one desurvey,
reused).

**Any table in the container can emit a dataset** into the registry (A10) and be
analyzed — not just interval/composite tables:

- **interval / composite** → desurvey to a representative XYZ per row, carry its
  columns, feed everything (Statistics, Swath, GT, declustering, top-cut, Δ%…).
- **collar** → a hole-level dataset (one row per hole): collar XYZ + EOH + any
  hole attributes. Stats on collar = the campaign's collar elevations, hole
  depths, per-hole attributes — useful QA in its own right.
- **survey** → a per-station dataset of orientations (depth, azimuth, dip). Stats
  here are *orientation* stats, which is the natural feed for a **stereonet
  surface** (roadmap A16, `bearing.js`) — and the same is true of any oriented-
  core structural interval table (α/β → planes/lines).

So one container may produce **several** datasets — raw samples, 2 m composites,
domain composites, the collar table, the survey/orientation table — each
independently analyzable and comparable to the model. (Emit on demand, not
eagerly — see Decisions.)

### Emit model — derived, with a kept connection (Arthur, 2026-06-21)

An emitted dataset is **derived**, carrying a **source link** `{set, role}` (the
parent drillhole set + the table it came from). It is one of two modes — and
**both keep the link** (provenance + re-derive-on-demand never lost):

- **linked** (default) — store only the recipe; the dataset **re-derives from the
  source on open**. Loss-safe via the source's own persistence (the drillhole
  recipe). No snapshot stored; always fresh. This is the first emit slice to
  ship — it reuses the existing drillhole re-derive machinery (the composite
  already does exactly this, 1:1; emit generalizes it to N outputs per set).
- **materialized** (opt-in) — freeze the current derived data **while keeping the
  link**, so it persists independently and you can still see where it came from /
  re-derive on demand. *Where the snapshot lives* is the question
  [`docs/fsaa-project-folders.md`](fsaa-project-folders.md) (C11) answers: write
  the CSV into a mounted project folder (cheap, scales to big tables) rather than
  embedding it in the project JSON. **So materialize-at-scale wants the folder;
  linked-emit lands first.**

Restore ordering (linked): the emitted instance is recreated from `datasets[]`
marked derived-from `{set, role}` (not awaiting a re-droppable file); after the
parent set is ready (trio re-dropped / packed → re-derived), each linked emit is
re-emitted into its pending instance. The cross-dataset dependency is the work.

`collar` is the clean first target (it already carries XYZ → a point dataset with
no desurvey); `survey` and raw `interval` emits need the desurvey path.

## The merge kernel (the crux)

The one genuinely hard piece is the **down-hole interval join**: combine two
interval tables on (BHID, FROM/TO) where their breaks don't line up. Everything
else is rules + UI on top of this. Open semantics to decide:

- **Overlap resolution** — re-segment to the union of both tables' breaks
  (length-correct, the default), or to one table's breaks (the "primary"), or
  intersection only.
- **Carry vs aggregate** — a numeric column from the other table over a
  re-segmented piece: length-weighted mean (default) or value-at-from. A
  categorical: majority by covered length, or first.
- **Gaps & misses** — an interval with no counterpart on the other table:
  null-fill + count (no-magic), never silent drop. This is the consistency
  report again (A7's pattern), extended to joins.
- **3+ tables** — fold pairwise in a declared order, or simultaneous union of
  all breaks. (Lean pairwise-in-order; simpler, predictable.)

This is the kernel that wants an **oracle harness** (the DECLUS/A7 playbook):
hand-built tiny fixtures with known correct joins, diffed against the
implementation.

**Implemented (P4, `Drillhole.mergeIntervals(A, B, opts)`):** the decisions
above resolved to **union re-segment + carry**. Per hole the merged breaks are
the sorted union of both tables' FROM/TO, so every output segment lies within at
most one interval of each table — columns are **carried verbatim, no
aggregation** (union re-segment dissolves the carry-vs-aggregate question for the
default; length-weighting would only matter under a primary-breaks mode, deferred).
A segment with no counterpart on one side **null-fills + counts** it (`gap-a` /
`gap-b`); a segment covered by neither is skipped (not a real interval). Overlaps
within one table over a segment are flagged (`overlap-a/-b`, first wins); holes
present in only one table are filled + counted (`hole-only-a/-b`); column-name
clashes are renamed (suffix `tagB`) + counted (`column-collision`). Pairwise-in-
order for 3+ (fold A⊕B, then ⊕C…). The merged table is the columnar interval
shape, so it **composites cleanly through the existing pipeline** (proven in the
oracle). Pure function, no DOM; the "merge intervals" UI + the 2nd interval table
that feeds it land with the multi-table container (P5).

## The compositing surface

Today's fixed card → an interactive panel acting on **one source interval table**
(raw or merged) producing a **composite** table:

- **Rule** — fixed length (today), honor-boundaries (snap to a domain column's
  contacts), or run-length by a categorical (one composite per contiguous run).
  "Break on (domain)" today is the baby version of honor-boundaries.
- **Splits** — restart composites at the contacts of one or more **categorical
  splits** (lithology, domain, zone) so no composite straddles a boundary.
- **Weighting** — length (today), or **length × density** when a density column
  is named (mass-correct composite means — the geologically right default once a
  density column exists).
- **Column combine** — per output column: length(/mass)-weighted mean, sum,
  majority (categoricals), min/max. Sensible defaults by type; overridable.
- **Min coverage** — drop poorly-sampled composites (off by default; counted,
  never silent — A7 rule).

## Calcols & export (fall out for free)

- **Calcols per interval table.** Each table (imported / merged / composite)
  carries its own `calcolCode` + `calcolMeta`, exactly like a dataset does today.
  This is the clean home the flat model lacked — answers "keep calcols on each"
  directly, no composite↔interval mapping puzzle. A calcol authored on the
  intervals table is an interval-level derived column; one on a composite is a
  composite-level column; the surface decides nothing for you.
- **Export any table.** Each interval table (+ collar + survey) exports as CSV
  with its filter + calcols applied — the original ask, now a one-liner per table
  because each *is* a table with columns. Optionally bundle the set as a zip
  (collar + survey + each interval table) — a clean round-trip of a Pack's raw
  trio, plus any derived tables.

## What exists today vs new

Favorable foundations (A7, already shipped) — this is "promote internals to a
surface," not greenfield:

- ✅ retained parsed collar/survey/interval data (`dhStateFor`), role detection,
  column mapping, dip-convention detection.
- ✅ min-curvature desurvey + length-weighted compositing + "Break on (domain)"
  + min-coverage + the consistency report.
- ✅ the synthesized-point-dataset → existing-pipeline path (A10 registry).
- ✅ Pack carries the raw trio + recipe; composites re-derive on load.

New work (roughly increasing difficulty):

1. **Container data model** — DrillholeSet holding collar/survey + N interval
   tables with kinds + a DAG; per-table calcols/filter. (State refactor of
   `dhStateFor` — it already holds the three; generalize intervals to N.)
2. **Raw/any-table export** — small; ships value first (the original ask).
3. **Per-table calcols** — reuse the calcol editor against a chosen table.
4. **Compositing surface** — the card becomes a panel; density weighting,
   categorical splits, per-column combine rules.
5. **Merge kernel** — the down-hole join + its oracle harness (the hard part).
6. **Multiple output datasets** — a container emits N points into the registry +
   the catalog tree (the tree already renders a DH set as a sub-tree — a hook).

## Phasing (each lands green; value early)

- **Phase 0** — container data model behind the existing card, inert
  (drillhole-smoke bit-identical: one trio still → one composite, just stored as
  "collar/survey + 1 interval + 1 composite").
- **Phase 1** — export any retained table (collar/survey/intervals) as CSV + a
  "download tables (zip)" affordance. *Ships the original raw-export ask alone.*
- **Phase 2** — per-table calcols + filter; export carries them.
- **Phase 3** — compositing surface: density weighting + categorical splits +
  per-column combine rules (still single source table).
- **Phase 4** — merge kernel + oracle harness; "merge intervals" produces a
  merged table.
- **Phase 5** — multiple interval tables in one set + N output datasets into the
  registry/tree; Pack carries the full container.

Phases 1–2 are independently shippable and answer the question that started this.
Phases 4–5 are the real generalization and want the design settled first.

## Decisions (open)

- Merge overlap default (union re-segment vs primary-breaks) — lean **union
  re-segment, length-weighted carry**.
- Does a container emit datasets **eagerly** (every table) or **on demand** (mark
  a table "analyze")? Lean on-demand to avoid registry clutter.
- Density column: per-interval-table role, or a set-level pick? Lean per-table
  role (a density table merged in is the general case).
- Composite-of-composite allowed? Permit (it's just the DAG) but warn on
  re-compositing already-composited support.
- Pack: store raw imported tables + the DAG recipe; re-derive merges/composites
  on load (the A7 weights-philosophy, generalized).

## Out of scope (this row)

- 3D hole-trace rendering (B7).
- Contact/boundary analysis as an analysis tab (A12).
- Non-drillhole table joins (general dataset merge) — related but separate.
