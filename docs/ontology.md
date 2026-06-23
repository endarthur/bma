# BMA Ontology — the things, and where they live

Record of decision, 2026-06-22. This is the **canonical conceptual model**: what
kinds of objects BMA has, how they relate, and the vocabulary we use for them. It
exists because the model was drifting (we'd grown the pieces *ad hoc* across A10 /
C9 / C10 / A11 / C14) and a couple of load-bearing decisions risked being lost in
chat context. When code and this doc disagree, treat this as intent and reconcile.

Companions (mechanism, not concept): [`c10-dataset-surface-decoupling.md`](c10-dataset-surface-decoupling.md)
(the targeting framework), [`a10-n-datasets.md`](a10-n-datasets.md) (the dataset
registry + clone arcs), [`a11-drillhole-container.md`](a11-drillhole-container.md)
(sets), [`c1a-property-catalog.md`](c1a-property-catalog.md) (properties).

## The identity question (why this matters)

BMA is a **table-and-stats tool** — analyses over tables, much closer to a
spreadsheet or a stats notebook than a 3D geological modeller. It is **NOT** a
scene-of-objects modeller. This is a deliberate identity choice, and it has a
practical consequence we keep coming back to: **don't ape Leapfrog/Seequent.**

Their paradigm is a Project Tree that is a *scene of objects* (drillholes, meshes,
**surfaces**, geological models, block models), where "surface" means a triangulated
3D mesh. If BMA copies both that object-tree shape and that vocabulary, it reads as a
clone — and confuses a resource geologist, for whom "surface" already means a mesh.

So our framing is: the Data rail is a **data catalog** (tables + their columns), and
analyses are **lightweight things you spin up over them** — like notebook cells
referencing dataframes. Tables + analyses, not a scene of objects.

## The four kinds of things

### 1. Datasets — the tables
A dataset is a table of rows with a schema. The registry (A10) holds them as peers:
`model`, `aux`, `d2`, `d3`… — no privileged "model" kind; `model`/`aux` are
getter-views over the legacy globals, `d2+` are real instances. Some are **derived**
(an emitted drillhole table) carrying a `derivedFrom {set, role}` link, and nest
under their source in the tree (filesystem / GIS-layer idiom).

**Intrinsic facets** belong *to* a dataset and live *with* it — they are not separate
objects targeting it:
- **schema / variables** (coordinates, grades, categories, calculated columns)
- **geometry** (grid/point classification, block sizes, bounding box)
- **Summary** (the stats overview + grid-geometry table)

> Decision: **Summary and geometry are intrinsic, never listed as "views."** Every
> analyzed dataset *has* a summary; it isn't an artifact you create and point at it.
> (This was the "summary wouldn't go there?" call, 2026-06-22.)

A dataset must be **analyzed** before its stats/pairing/views are available; the
unanalyzed state is now actionable (an "Analyze" affordance in the tree header + the
dataset context menu) rather than a dead "not analyzed" label.

### 2. Views — the analyses you keep
A **View** is an analysis **deliberately created/kept over a dataset**: a
Grade–Tonnage, a Swath, a Cross-tab, a Statistics, a Categories, a StatsCat, an
Export. Internally these are still the C10 "surfaces" (the targeting framework keeps
that name); **"View" is the user-facing term.**

> Decision: **the noun is "View," not "surface."** "Surface" = a 3D mesh to a
> geologist and aping it reads as Leapfrog. (2026-06-22.)

A view has: a **target dataset** (via the C10 facet picker), a **config** (selected
grades, cutoffs, columns…), a **result**, and an optional **user title**. Default
analysis panels (the always-there Statistics/Categories tabs) are *scratch*, not
views, until you keep one.

> Decision: **only DELIBERATE views are listed** under a dataset — a clone, a renamed
> one, or a singleton retargeted off the model (`surfaceIsDeliberate`). A pristine
> default panel doesn't clutter the list. (2026-06-22.)

Lifecycle (all reachable three ways — row buttons, right-click context menu, the tab
menu):
- **Create** — `+ New view` under a dataset → pick a kind → `wsCreateView(kind, ds)`.
- **Duplicate** — `wsDuplicateView` (shared with the tab "Duplicate").
- **Rename** — inline; the title persists (`surfaceTitles` project key) and **mirrors
  onto the tab** (`wsRefreshSurfaceTabLabel`).
- **Retarget** — context-menu "Target dataset ▸" (the reverse of the per-view picker).
- **Delete** — a clone is destroyed; a kept singleton "stops being kept" (un-named,
  back to ambient/model).

Where views live: as **tabs** in the workspace, and listed under their target dataset
in the Data rail's **"Views"** group (the reverse index of the per-view picker). The
group shows on **every** dataset (universal capability), with an analyze-first hint
when the dataset has no results yet.

Cloneable / per-dataset surfaces today: Statistics, Categories, Swath, GT, StatsCat,
Export, Cross-tab. Adding a new one (e.g. A16 stereonet) = implement the C10 contract
+ a `surfaceDescriptors()` row.

### 3. Properties — the cross-dataset quantities
The property catalog (C1a → A10 4a): a **property** is a named measured quantity
(Fe, LITO…) instantiated by columns across datasets, carrying shared display (color,
unit, value colors/order). A pair is a 2-member property; an unmatched column a
singleton. This is the **cross-cutting** axis — orthogonal to datasets and views.

### Derived datasets — the lifecycle (a cross-cutting concern)
A **derived dataset** carries `derivedFrom {source, role, opts}` — a drillhole emit
or composite today, a C13 join/merge tomorrow. They share ONE lifecycle policy, hung
off `derivedFrom` (not anything drillhole-specific), so every present and future
derivation behaves the same:

- **Auto-recreate + auto-analyze on load.** A derived dataset re-derives from its
  source and **auto-analyzes** when it (re)loads (`loadAuxFile` → `runAuxAnalysis`
  for any `derivedFrom`). So its data AND any **views** targeting it resolve on
  reload, instead of the view silently bouncing to the model (the prior bug:
  re-derived composites stayed unanalyzed, and `surfaceTarget` falls back to the
  first usable dataset). Plain dropped datasets keep configure-then-Analyze.
- **Materialize is the escape hatch.** A derived dataset can be **materialized**
  (C11-P2) — frozen to a self-contained snapshot, link kept — for archival, sharing,
  or when re-deriving is slow/undesirable. Right-click ▸ Materialize / Relink. The
  default stays live (fresh, reflects source edits).
- **Dependents are visible.** A derived dataset that feeds views shows an `N ▦`
  badge in the tree (it's load-bearing — see before you delete/relink it).
- **Never strand a view silently.** If a derived dataset has dependents but couldn't
  be recreated (no file + not materialized → its source isn't loaded), the badge
  turns to a `⚠` warning telling you to re-drop the source / open the project folder.

> Decision (2026-06-22/23): **derived-dataset lifecycle is general** — auto-recreate
> + auto-analyze live by default, materialize as the explicit freeze, dependents
> surfaced, broken targets warned, never silently bounced. Applies to ALL
> `derivedFrom` datasets (composites, emits, merges, future joins), not just
> drillhole composites.

### 4. Sets — the containers that emit datasets
A **drillhole set** (A11) is a container: a collar+survey backbone + N interval
tables (imported / merged / composite — a DAG), each with its own calcols/filter. A
set **emits** datasets into the registry (collar / intervals / composite, linked or
materialized). The set is a container, not a targetable dataset itself; its emitted
tables are datasets and get views like any other.

## The project layer (C14)

Above all of this sits the **project** — the real unit of work, not a file. The
project registry (a `projects` IndexedDB store) holds records `{title, tags, notes,
created, lastSaved, model+dataset metadata, backing}`. A project's bytes live in a
chosen **backing**, all behind one `FileSystemDirectoryHandle` interface:
- **folder** — a user-picked FSAA directory (real files on disk)
- **opfs** — an origin-private directory (no permission prompt, reopens unattended)
- **idb** — a virtual folder (per-file blobs in IndexedDB)

> Decision: **IDB backing edits in place** (per-file blobs, not a frozen pack), so
> all three backings persist edits identically via the folder machinery. **Re-importing
> a pack is always a NEW project** (fresh id + own storage) — never an overwrite.
> (2026-06-22.)

The landing is a **project manager** (search / sort / tags / notes / import-without-
load / backup), not a recent-files list. The File-menu "Open recent" lists projects.

## How the pieces compose (one picture)

```
Project  (registry record + storage backing)
  ├─ Datasets  (tables; peers in the registry)
  │    ├─ intrinsic: variables · geometry · Summary        ← live WITH the dataset
  │    ├─ derived datasets nest under their source
  │    └─ Views  (analyses kept for this dataset)           ← the reverse index
  ├─ Sets  (drillhole containers → emit datasets)
  ├─ Properties  (cross-dataset named quantities + display) ← orthogonal axis
  └─ Views  (Statistics/GT/Swath/… as tabs; each targets a dataset)
```

## Decisions log (this session, 2026-06-22)

- **"View," not "surface"** — user-facing term; avoids the geology/Leapfrog landmine.
- **Summary/geometry are intrinsic** to a dataset — never listed as views.
- **Only deliberate views are listed** (clone / renamed / retargeted); defaults stay
  scratch. Plus create/duplicate/delete/rename + a context menu.
- **Views are universal** — every dataset, not just the model.
- **Tab titles mirror view titles.**
- **The landing is a project manager**; projects (not files) are the unit; pluggable
  storage backings (folder / opfs / idb-edit-in-place); re-import = a new project.
- **Don't build a Leapfrog-style scene-of-objects tree** — keep tables + analyses.
- **Derived datasets auto-recreate + auto-analyze live by default**; materialize is
  the explicit freeze; dependents are surfaced; broken targets warn (never silent).
  General to all `derivedFrom` (composites/emits/merges/joins).

## Open / deferred

- **Timing-threshold materialize nudge** — auto-recreate is fine when fast, but a
  heavy derivation that re-derives slowly should prompt "this took a while —
  materialize to skip re-deriving next time?" (Arthur's idea, 2026-06-23). Not yet
  built; the manual Materialize affordance covers it for now.

- **Backup of a local/file-backed project** opens-then-packs (dir backings —
  folder/opfs/idb — re-zip directly without opening). Inherent: you can't pack
  bytes that were never stored (a dropped model file isn't kept). Left as-is.
- **A16 orientation / stereonet** — not polish but the next *feature*; the first new
  view kind to validate the C10 contract against this ontology.

Cleared 2026-06-23: metric-pill active state (solid fill), timing-threshold
materialize nudge, consolidated derived-health banner, File-menu↔manager convergence
("All projects…"). Stats layout pass done earlier the same day. (Zebra striping
considered + dropped — fights the Δ% rows + sticky column.)
