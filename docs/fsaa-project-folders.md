# C11 Design — FSAA-mounted project folders

Design note, 2026-06-21. Status: **design pass, not implemented**. Companion to
`docs/roadmap-tracker.csv` row C11. Raised by Arthur off the A11 emit-as-dataset
persistence question — once datasets can be *derived* from one another (drillhole
composites, merged tables, emitted collar/survey datasets), "where does the
materialized copy live, and how do source files resolve on reload" stops being a
detail and becomes the persistence model. A mounted project folder answers it.

## The problem today

BMA has three persistence surfaces, none of which is "a project that just opens":

- **localStorage project** — autosaved JSON keyed by `name:size`; restores config
  but the *files* must be **re-dropped** (the browser can't re-open a path). Size
  limited; lost if the file is renamed.
- **packed `.bma` zip** — bundles the project JSON + the raw source files; a clean
  shareable artifact, but every open is a manual drop + extract, and big block
  models bloat the zip.
- **derived datasets re-derive** — a drillhole composite / merged table / (future)
  emitted dataset re-runs from its recipe once its source files are back. Correct,
  but it inherits the re-drop problem: nothing resolves until the user finds the
  files again.

The recurring tax is **re-dropping files** and the absence of a durable "this *is*
the project" object. (`docs/io-architecture.md` + C8 circle the same gap.)

## The idea

Use the **File System Access API** (`showDirectoryPicker()`) to **mount a project
folder**. The folder *is* the project:

- source files (the model CSV, drillhole trios, comparison datasets) live in (or
  are referenced from) the folder and **resolve by name on open — no re-drop**;
- the project JSON autosaves back into the folder;
- **materialized** derived outputs (composites, merged tables, emitted datasets)
  are **written as real CSVs into the folder**, while keeping their recipe link —
  this is the "materialize while keeping the connection" Arthur asked for (A11);
- the directory handle is stashed in IndexedDB so reopening re-grants access with
  one permission click (Chromium persists the grant), not a full re-pick.

So the lifecycle becomes: **pick a folder once → work → close → reopen the folder
→ everything resolves.** The pack stays as the *share/export* artifact; the folder
is the *working* project.

## How it pays off the derived-dataset model (A11 emit)

A11's emitted/derived datasets carry a **source link** `{set, role}` and are one of:

- **linked** (default) — store only the recipe; re-derive from the source on open.
  Loss-safe via the source's own persistence. No snapshot.
- **materialized** (opt-in) — freeze the derived data **while keeping the link**.
  *Where* the snapshot lives is the open question a folder closes: write the CSV
  into the mounted folder (cheap, real file, survives independently, diff-able)
  rather than bloating the project JSON / localStorage. Re-derive-on-demand stays
  available because the link is kept.

Without a folder, materialize has to embed the CSV in the project JSON — fine for a
small collar table, a non-starter for raw intervals or a big model. The folder is
what makes materialize scale. **So linked-emit can ship pre-folder; materialize at
scale wants the folder.**

## Sketch of phasing (when picked up)

- **P0** — mount a folder (`showDirectoryPicker`), persist the handle in IDB,
  re-request permission on reopen; feature-detect + degrade to today's drop/pack
  where FSAA is absent (Firefox/Safari).
- **P1** — resolve a project's source files from the mounted folder by name
  (replaces re-drop); autosave the project JSON into the folder.
- **P2** — materialize: write derived outputs (composite / merged / emitted CSVs)
  into the folder, recipe link retained; "materialize ⇄ relink" toggle per dataset.
- **P3** — folder-as-project-home: open-folder = open-project; list/switch
  projects in a folder; reconcile external edits (file changed on disk).

## Parquet — the keystone (the folder pays off *because of* it)

A folder of CSVs is just re-drop convenience. A folder of **parquet** is the whole
platform — and the two ideas were designed for each other (Arthur, 2026-06-21):

- **Parquet subsumes most of the planned sidecar-index work.**
  `docs/io-architecture.md` §2 sketches a `.bmaidx` sidecar that re-implements
  *"parquet-style chunk metadata"* — per-row-group zone maps (min/max), predicate
  pushdown, seekable chunk offsets for parallel scans. If the data simply **is**
  parquet, you get all of that for free: row-group statistics ⇒ skip groups a
  filter provably can't match; columnar ⇒ read only the columns a pass needs;
  row-group boundaries ⇒ fan out N workers (B4 parallel scans). The custom sidecar
  largely evaporates.
- **Parquet supersedes the §3 fixed-width tool too** — same goal ("make my file
  seekable/ideal"), but columnar + compressed + self-describing + standard.
- **The row-source split (§1, DONE) already left the seam.** `makeRowSource()`
  separated *format decoding* from *statistics*; a `ParquetRowSource` (hyparquet,
  B2) drops in exactly where `DmRowSource` / `FixedWidthRowSource` were planned —
  no pass rewrites. The surviving contract ("row objects with named properties",
  because filters/calcols are user JS `r.Fe > 30`) is unaffected: stay columnar
  for projection + row-group skipping, reconstruct row objects only for the
  surviving rows where user JS actually runs.
- **The folder is where parquet lives, both ways.** Import: drop a CSV → convert
  to parquet in the folder once → every later open reads parquet directly (fast
  columnar, no re-parse, pushdown). Materialize: composites / merged / emitted
  datasets write as **parquet** into the folder (A11), keeping their recipe link.

So the convergence is: **parquet (format) + FSAA folder (home) + the row-source
seam (already built) + row-group parallelism (B4) = the persistence *and*
performance thesis in one.** Sequence C11 with **B2** (hyparquet everywhere); the
sidecar-index / fixed-width rows in `io-architecture.md` get reframed as "parquet
gives this for free" rather than separately built.

## Decisions / open

- **Reference vs copy** source files: reference in place (the folder already holds
  the user's CSVs) vs copy into a project subfolder on first save. Lean *reference*
  for the model + raw inputs, *write* for derived/materialized outputs.
- **Big files** — this is also the natural home for the B-track parquet platform
  (`docs/v2-roadmap.md`): a folder of parquet + a project JSON. Sequence with B2.
- **Permission UX** — Chromium re-grants persisted handles with a click; design the
  re-grant prompt so reopening feels like "open recent," not a fresh pick.
- **Safety** — never write outside the picked folder; never overwrite a source the
  user didn't author (the standing no-silent-loss rule extends to disk writes —
  confirm before overwriting an existing file).

## Relationship

- **C8** (project system) — FSAA folders are the on-disk backing C8's project
  objects can use; design them together.
- **A11** (drillhole container / emit) — the materialize-while-linked story this
  doc backs; linked-emit can land first, materialize-at-scale wants the folder.
- **A18** (export presets + bound output) — a bound `showSaveFilePicker` handle
  lets one-click *re-export* overwrite a CSV in place (BMA as a pipeline component
  feeding Vulcan/Leapfrog/…); same persisted-handle machinery as the folder mount.
- **B2** (parquet platform) — big-file projects live in a folder of parquet.
- **`docs/io-architecture.md`** — the planned row-source / sidecar-index work that
  a mounted folder gives a real home.
