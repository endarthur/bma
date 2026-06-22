// ─── C12-P0: the Derivation contract (the derived-data DAG) ────────────────
// BMA has six kinds of derived data (drillhole composite, merged interval table,
// emitted / materialized dataset, export-preset output, calcol columns) — each
// today hand-rolls its own staleness + recompute (model re-analyze, aux
// markAuxStale, drillhole dhStale, export nothing). They form a DAG
// (collar+survey+intervals → composite → analysis; model → calcol → filter).
// C12 names the shared shape so propagation + Refresh can be owned once — the
// C10 move (DatasetSource) applied to the WRITE side: DatasetSource named how a
// dataset is READ; Derivation names how it CAME TO BE. Design:
// docs/derivation-lineage.md.
//
// P0 is the INERT seam: the contract (makeDerivation) + a READ-ONLY projection
// (derivAll) that expresses BMA's two live recompute mechanisms — each dataset's
// analysis and each drillhole composite — AS Derivations, computed from existing
// state. Nothing yet DRIVES staleness or refresh from this view (that is P1), so
// every existing flow is byte-identical; the projection just gives them one name.

// A source reference — a lightweight, serialization-friendly pointer to an
// upstream node (a file input, or another derivation's output).
function derivSourceRef(kind, id, name) { return { kind: kind, id: id, name: name }; }

// The Derivation contract. `sources` / `stale` / `output` are getters so the view
// stays live against the state it projects. mode: 'linked' (re-derive on demand)
// is the only mode today; 'materialized' (freeze + keep link) lands with A11 emit
// (P2). `derive()` recomputes the output from its sources (the recipe / kernel).
function makeDerivation(spec) {
  return {
    id: spec.id,
    kind: spec.kind,                       // 'analysis' | 'composite' (descriptive)
    derive: spec.derive || function () {},
    mode: spec.mode || 'linked',
    get sources() { return spec.sources ? spec.sources() : []; },
    get stale()   { return spec.stale ? !!spec.stale() : false; },
    get output()  { return spec.output ? spec.output() : null; },
  };
}

// The drillhole composite as a Derivation: collar + survey + intervals (+ a merge
// table) → the composite CSV. Returns null when this set has produced no
// composite yet. Staleness is not tracked for composites today (re-drop / re-run
// is manual) → false; P1 gives it a real key.
function derivForDrillhole(ds) {
  if (typeof dhStateFor !== 'function') return null;
  var D = dhStateFor(ds);
  if (!(D.derivedName && D.files.collar && D.files.survey && D.files.intervals)) return null;
  return makeDerivation({
    id: 'composite:' + ds.id,
    kind: 'composite',
    sources: function () {
      var s = [
        derivSourceRef('file', 'collar', D.files.collar.name),
        derivSourceRef('file', 'survey', D.files.survey.name),
        derivSourceRef('file', 'intervals', D.files.intervals.name),
      ];
      if (typeof dhHasSecondary === 'function' && dhHasSecondary(D)) {
        s.push(derivSourceRef('file', 'secondary', D.secondary.file.name));
      }
      return s;
    },
    derive: function () { return dhCompositeAndLoad(ds); },
    stale: function () { return !!D._stale; },          // C12-P1: set when the recipe / sources change after a composite
    output: function () { return ds.file || null; },    // the in-memory composite File
  });
}

// A dataset's analysis as a Derivation: its input file (or its composite, when
// drillhole-derived) → the completed analysis. derive() re-runs analysis; stale
// mirrors the existing per-surface flags (model `analysisStale`, others
// `ds.stale`). Returns null for a dataset with no file loaded.
function derivForDataset(ds) {
  if (!ds || !ds.file) return null;
  var isModel = ds.id === 'model';
  return makeDerivation({
    id: 'analysis:' + ds.id,
    kind: 'analysis',
    sources: function () {
      // A11 emit: a dataset emitted from a drillhole set derives from that set.
      if (ds.derivedFrom && ds.derivedFrom.set) {
        return [derivSourceRef('dataset', ds.derivedFrom.set, ds.derivedFrom.role + ' ← ' + ds.derivedFrom.set)];
      }
      if (typeof dhIsDerivedAux === 'function' && dhIsDerivedAux(ds)) {
        return [derivSourceRef('derivation', 'composite:' + ds.id, ds.file.name)];
      }
      return [derivSourceRef('file', ds.id, ds.file.name)];
    },
    derive: function () {
      if (isModel) { if (typeof executeAnalysis === 'function') return executeAnalysis(); return; }
      if (typeof runAuxAnalysis === 'function') return runAuxAnalysis(ds);
    },
    stale: function () {
      if (isModel) return (typeof analysisStale !== 'undefined') ? !!analysisStale : false;
      return !!ds.stale;
    },
  });
}

// The current derivation DAG, projected from live state (read-only). One
// 'composite' node per drillhole set that has produced a composite, one
// 'analysis' node per loaded dataset. P1 turns this into a driven registry with
// topological staleness propagation + a single Refresh surface.
function derivAll() {
  var out = [];
  if (typeof dhStates === 'object' && dhStates) {
    for (var id in dhStates) {
      if (!dhStates.hasOwnProperty(id)) continue;
      var dsD = (typeof dsById === 'function') ? dsById(id) : null;
      if (!dsD) continue;
      var c = derivForDrillhole(dsD);
      if (c) out.push(c);
    }
  }
  if (typeof datasets !== 'undefined' && datasets && datasets.length) {
    for (var i = 0; i < datasets.length; i++) {
      var a = derivForDataset(datasets[i]);
      if (a) out.push(a);
    }
  }
  return out;
}

// Look up a single projected derivation by id (e.g. 'analysis:model',
// 'composite:aux'). Convenience over derivAll() for the smoke + future consumers.
function derivById(did) {
  var all = derivAll();
  for (var i = 0; i < all.length; i++) if (all[i].id === did) return all[i];
  return null;
}

// ─── C12-P1: staleness propagation over the DAG ────────────────────────────
// P0 named the nodes; P1 lets a change at one node flag every node DOWNSTREAM of
// it stale, and refreshes a node by re-running its derive(). Staleness stays
// single-source: an analysis node's stale is its dataset's existing flag
// (ds.stale / analysisStale), a composite node's is D._stale. derivMarkStale
// routes through the existing markers — it adds topology (propagation) + a
// uniform entry point, not a second copy of the truth. Design:
// docs/derivation-lineage.md §"Staleness propagation".

// The nodes that list `id` among their sources (its immediate downstream).
function derivConsumers(id) {
  var all = derivAll(), out = [];
  for (var i = 0; i < all.length; i++) {
    var s = all[i].sources;
    for (var j = 0; j < s.length; j++) {
      if (s[j].kind === 'derivation' && s[j].id === id) { out.push(all[i]); break; }
    }
  }
  return out;
}

// Set ONE node's stale through its authoritative flag (no propagation). The
// existing per-surface UI reacts (model executeBtn, aux Analyze button, the dh
// composite button); P1-b adds the tree badge on top. markAuxStale/
// markAnalysisStale own the freshen side via the analyze-complete handlers, so
// derivSetNodeStale only drives the stale (true) direction for analysis nodes.
function derivSetNodeStale(id, stale) {
  var p = id.indexOf(':'); if (p < 0) return;
  var kind = id.slice(0, p), dsId = id.slice(p + 1);
  if (kind === 'composite') {
    var dsc = (typeof dsById === 'function') ? dsById(dsId) : null;
    if (!dsc || typeof dhStateFor !== 'function') return;
    dhStateFor(dsc)._stale = !!stale;
    if (typeof dhReflectStale === 'function') dhReflectStale(dsc);
  } else if (kind === 'analysis' && stale) {
    var ds = (typeof dsById === 'function') ? dsById(dsId) : null;
    if (!ds) return;
    if (dsId === 'model') { if (typeof markAnalysisStale === 'function') markAnalysisStale(); }
    else if (typeof runAuxAnalysis === 'function' && typeof markAuxStale === 'function') markAuxStale(ds);
  }
  if (typeof renderTree === 'function') renderTree();   // P1-b: the tree badge follows the flag
}

// Mark a derivation stale and propagate to everything downstream (topological
// walk, visited-guarded — the DAG is acyclic by construction; cycles are
// rejected at binding time, P2). The no-silent-stale rule (A9) generalized to
// derived data: a source change never silently leaves a stale composite/analysis.
function derivMarkStale(id, _seen) {
  _seen = _seen || {};
  if (_seen[id]) return;
  _seen[id] = true;
  derivSetNodeStale(id, true);
  var cons = derivConsumers(id);
  for (var i = 0; i < cons.length; i++) derivMarkStale(cons[i].id, _seen);
}

// Refresh = re-run a stale node's derive() (and, via the load → analyze chain,
// its downstream). The tree Refresh action (P1-b) calls this.
function derivRefresh(id) {
  var d = derivById(id);
  return d ? d.derive() : undefined;
}
