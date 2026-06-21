# C12 Design — Derivation lineage (the derived-data DAG)

Design note, 2026-06-21. Status: **design pass, not implemented**. Companion to
`docs/roadmap-tracker.csv` row C12. The unifying interface under A11 (drillhole
composite / merge / emit / materialize), A18 (export presets / re-export), and
calcols — raised by Arthur after noticing each of those grew its own staleness +
refresh logic. Same "missing interface" smell C10 just paid off for targeting.

## The smell (evidence)

BMA now has **six kinds of derived data**, each carrying a source link and each
hand-rolling its own staleness + recompute:

| derived output | sources | recompute | staleness today |
|---|---|---|---|
| drillhole composite | collar+survey+intervals (recipe) | `dhCompositeAndLoad` | `D.lastReport` / re-drop |
| merged interval table | assays + lithology | `mergeIntervals` in `dhBuildTables` | implicit (re-composite) |
| emitted dataset (A11) | parent set + role | re-emit | *unbuilt* |
| materialized dataset (A11) | its source | freeze + relink | *unbuilt* |
| export-preset output (A18) | target ds + config | re-export | *unbuilt* |
| calcol columns | their input columns | recompile | re-run on analyze |

They form a **DAG** — `assays+litho → merged → composite → emitted → re-export`,
`model → calcol → filter`. But there is no shared notion of "this is stale
because a source changed" or "refresh it." The model has re-analyze, aux has
`markAuxStale`, drillhole has its own, export has *nothing*. Six copies of the
machinery C10 just taught us to extract.

## The contract

A **Derivation** names what each of those already is:

```
Derivation = {
  id,                    // the output (a dataset id, or an output handle)
  sources: [ref…],       // upstream nodes it derives from
  derive(),              // recompute from sources (the recipe / kernel)
  stale,                 // true when any source changed since the last derive
  mode,                  // 'linked' (re-derive on demand/open) | 'materialized'
  output?,               // where a materialized snapshot lives:
                         //   in-project JSON (small) | FSAA file (C11) | bound export file (A18)
}
```

`mode` is the A11 decision, generalized: **linked** keeps only the recipe and
re-derives; **materialized** freezes the snapshot *while keeping the link* (so
re-derive-on-demand and provenance survive). Where a materialized snapshot lives
is what C11 (FSAA folders) answers. An A18 export preset is just a Derivation
whose `output` is a bound external file — *materialize pointed outward.*

## Staleness propagation

- A change at any node (re-analyze, edit a filter/calcol, re-drop a different
  source, switch a target) marks **all downstream derivations stale**
  (topological walk over the DAG).
- **Refresh** = `derive()` on a stale node — a Refresh button, or auto on
  access/open for cheap ones. Never silent: a **stale badge + refresh
  affordance** (generalize the existing `dhStale` / `markAuxStale` pattern into
  one consistent surface — the no-silent-loss rule applied to derived data).

## What it unifies

Every row in the table above becomes a Derivation: it declares `sources` +
`derive()` and stops hand-rolling staleness; the framework owns propagation,
refresh, and the stale UI. New derived kinds (a future "join two block models",
a "resample to a grid") plug in by implementing the same contract — exactly how
C10's DatasetSource let A11 tables become targets for free. **This is the
DatasetSource pattern for the *write* side: DatasetSource named what a dataset
exposes; Derivation names how a dataset came to be.**

It is also the concrete backbone for **C7** (the provenance / report thesis): a
report panel renders the lineage DAG and each node's recipe.

## Pushdown via an expression IR (`air`) — the bridge to B2

Several `derive()`s are filters/calcols — user JS (`r.Fe > 30`). Today we compile
straight to `new Function`, which is opaque: `io-architecture.md` §2 has to
*regex-match* expression shapes to extract pushdown predicates. Routing the DSL
through an **expression IR** (Arthur: `../auditable/ext/air`) instead makes
filters/calcols *analyzable*:

- **static predicate extraction** — walk the IR for conjunctive clauses
  (`r.X > c`, `===` on categoricals…) and map them to parquet row-group zone
  maps / sidecar zone maps — principled, not shape-matched.
- **still compile to JS** for the row-object compatibility path (the contract
  survives).
- **enable the parquet vectorized fast path** (#2 of the design review): no
  calcols + a pushdown-able filter ⇒ run column-vectorized, skip row groups,
  reconstruct row objects only for survivors.

So the IR is the piece that makes derivations both **composable** (lineage) *and*
**fast** (B2): a Derivation whose recipe is an `air` expression can be pushed down
and vectorized; one with arbitrary JS falls back to the row path. It also gives
calcols/filters a real home (autocomplete, validation, units) instead of string
munging. Sequence the IR with B2.

## Phasing

- **P0** — name the `Derivation` contract; retrofit the drillhole composite (it
  already *is* one) + aux onto it, inert + bit-identical (the C10 P0 move).
- **P1** — staleness propagation over the DAG + one consistent stale-badge /
  Refresh surface (subsumes `dhStale` / `markAuxStale` / re-analyze).
- **P2** — emit / materialize / re-export build *as* Derivations (not bespoke).
- **P3** — the `air` expression IR + pushdown, with B2.

## Decisions / open

- **Auto-refresh vs. manual** — lean manual + a visible stale badge (today's
  feel), auto only for cheap derivations; never silently serve stale.
- **Cycles** — the DAG must stay acyclic (no composite-of-its-own-output); reject
  a binding that would close a loop.
- **Identity / staleness keys** — size + lastModified + hash for files; analysis
  fingerprint for in-memory sources; FSAA handles for folder outputs (shared with
  C11 / the sidecar identity tuple).

## Relationship

- **C7** — the provenance / report panel renders this DAG; this is its data model.
- **C10** — DatasetSource (read side) ⇄ Derivation (write side); same
  missing-interface extraction.
- **A11 / A18** — emit, materialize, re-export are the first Derivation consumers.
- **C11** — where materialized outputs live (the folder).
- **B2** — the `air` IR + pushdown is what makes Derivation recipes fast.
