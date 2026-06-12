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
