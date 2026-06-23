// ─── Main App ──────────────────────────────────────────────────────────
const workerBlob = new Blob([WORKER_CODE], { type: 'application/javascript' });
const workerUrl = URL.createObjectURL(workerBlob);

let currentFile = null;
let currentProjectId = null;   // model-optional projects: dual-key identity when no model file (else null → file key)
let currentHeader = [];
let currentColTypes = [];
let currentXYZ = { x: -1, y: -1, z: -1 };
let detectedXYZ = { x: -1, y: -1, z: -1 };
let currentFilter = null; // { expression: string }
let currentRowVar = 'r';
let currentGridMode = null; // A10 4f-2: model grid override (null = default 'grid'; or 'grid'/'point'/'auto')
let worker = null;
let preflightData = null; // { header, sampleRows, autoTypes, delimiter, zipEntries, selectedZipEntry }

// ─── Aux dataset state (compare block model vs source samples/composites) ──
let auxFile = null;            // the loaded auxiliary File
let auxHandle = null;          // FSAA handle for re-open (if available)
let auxPreflightData = null;   // runPreflight() result for the aux file (header, xyz, types, sampleRows)
let auxCompleteData = null;    // snapshot of the last aux analysis (parallel to lastCompleteData)
let auxData = null;            // aux stats object for comparison rendering
let auxPrefix = 'aux';         // display-only label prefix for aux pseudo-columns (e.g. "aux:Fe")
let auxGridMode = null;        // A10 4f-2: aux grid override (null = default 'auto'; or 'grid'/'point'/'auto')
let auxFilter = null;          // { expression } — references aux columns via the fixed AUX_ROW_VAR handle
// A10 1g-c: the analysis/declus/topcut worker handles live PER-DATASET on the
// ds object (ds._worker / ds._declusWorker / ds._topcutWorker) so instance
// datasets analyze concurrently without clobbering each other's worker.
let pendingAuxRestore = null;  // aux config from a loaded project, applied once the aux file is (re)loaded
// A10 phase 4e-b: restore of the comparison-dataset instances (d2+) + the
// cross-dataset panel state. pendingDatasetsRestore is keyed by ds id and holds
// each instance's saved config until its file is re-supplied (then consumed in
// loadAuxFile); pendingPanelState holds project.panels until each dataset's
// analysis lets cmpSel/cdfCmpSel reattach by column name. Both are re-emitted
// by serialize while still pending, so an autosave mid-restore loses nothing.
let pendingDatasetsRestore = {};
let pendingPanelState = null;
const AUX_ROW_VAR = 'aux';     // fixed code handle for aux filter/calc expressions (NOT the display prefix)
let auxStale = false;              // aux config changed since last aux analysis
let auxCalcolCode = '';            // calculated-columns code block for the aux dataset (uses aux.)
let auxCalcolMeta = [];            // [{name, type}] detected from aux calcol simulation
let calcolMode = 'model';          // A10: which DATASET id the Calc editor targets ('model' | 'aux' | 'd2' …)
let projectTitle = null;           // optional project title (pack dialog) — display + archive naming
let statsCdfMode = 'cdf';          // CDF panel mode: 'cdf' | 'logprob' | 'qq'
// Support weights live in the catalog: catRole('model'|'aux', 'weight')
const AUX_DECLUS_WEIGHT = '__declus__'; // aux weight sentinel: use computed declustering weights
let auxDeclus = null;              // cell-declustering state: { params, weights (Float64Array|null),
                                   //   curve, optCellSize, declusteredMean, naiveMean, n, located,
                                   //   wtMin, wtMax, usedRange, fingerprint } — weights NOT persisted
let auxView = 'preview';           // aux main-area view: 'preview' | 'topcut'
let auxTopcut = null;              // top-cut analysis state: { varName, cap, values (sorted
                                   //   Float64Array)|null, prefixS, prefixSS, n, finite,
                                   //   fingerprint } — values NOT persisted (re-loaded on demand)
// A10 phase 4e-a: per-panel instance state, corralled from the scattered
// module-globals that 4c/4d left ephemeral. Single instance today (one
// Statistics/Swath/Categories panel each); 4e-b serializes this object, 4e-c
// keys it by panel instance for [+]/Duplicate cloning. Only the previously
// un-persisted selection/chip/reference state lives here — the already-persisted
// Statistics fields (selectedVars/visibleMetrics/percentiles/cdf*) join the
// instance in 4e-c. Selection maps are keyed by dataset id; absent/null entry =
// that dataset's default (paired-only). aux is just the first comparison dataset.
let panelState = {
  statistics: {
    cmpSel: {},          // { dsId: Set<colIdx>|null } shown in the stats table
    cdfCmpSel: {},       // { dsId: Set<colIdx> } with CDF curves
    dsHidden: new Set(), // comparison dataset ids hidden via the 4c dataset chips (progressive disclosure at 3+ datasets)
    refDs: null          // 4d Δ% reference dataset id (null = default: first shown comparison)
  },
  swath: {
    dsHidden: new Set()  // comparison dataset ids hidden via the 4c dataset chips
  },
  categories: {
    dsHidden: new Set(), // comparison dataset ids hidden via the 4c dataset chips (shared across instances for now — chips only show at 3+ datasets)
    focusedCol: null,    // column index focused in main area (per-instance, 4e-c-3)
    chartShowAll: false, // show all bars vs top 20 (per-instance, 4e-c-3 — was catChartShowAll)
    catTargetDsId: 'model' // ws-v2 phase 1: which dataset's columns this panel shows (model default → bit-identical)
  }
};
let pendingStatsAuxRestore = null;   // { selected: [names], cdf: [names] } applied when aux analysis completes (aux-only; d2+ ephemeral until phase 6)

// ─── A10 dataset registry (phase 0) ──────────────────────────────────────
// The registry that replaces the model+aux singleton split. Phase 0 changes
// NO behavior: the model (current*/lastCompleteData) and aux (aux*) globals
// stay canonical, and `datasets` is a getter/setter VIEW over them so
// registry-aware code can read/write datasets[i] uniformly. Later phases
// migrate consumers onto datasets[] and make it the backing store, then
// generalize past the two fixed entries. Design: docs/a10-n-datasets.md.
// (Getters reference later-declared globals — currentCalcolCode/Meta,
// lastCompleteData — which is safe: they resolve at access time, post-load.)
const datasets = [
  {
    id: 'model',
    get file()       { return currentFile; },        set file(v)       { currentFile = v; },
    get preflight()  { return preflightData; },       set preflight(v)  { preflightData = v; },
    get complete()   { return lastCompleteData; },    set complete(v)   { lastCompleteData = v; },
    get filter()     { return currentFilter; },       set filter(v)     { currentFilter = v; },
    get calcolCode() { return currentCalcolCode; },   set calcolCode(v) { currentCalcolCode = v; },
    get calcolMeta() { return currentCalcolMeta; },   set calcolMeta(v) { currentCalcolMeta = v; },
    get prefix()     { return null; },
    get gridMode()   { return currentGridMode; },     set gridMode(v)   { currentGridMode = v; },
    get rowVar()     { return currentRowVar; },
    get source()     { return 'file'; }
  },
  {
    id: 'aux',
    get file()       { return auxFile; },             set file(v)       { auxFile = v; },
    get handle()     { return auxHandle; },           set handle(v)     { auxHandle = v; },
    get preflight()  { return auxPreflightData; },     set preflight(v)  { auxPreflightData = v; },
    get complete()   { return auxCompleteData; },      set complete(v)   { auxCompleteData = v; },
    get stale()      { return auxStale; },             set stale(v)      { auxStale = v; },
    get filter()     { return auxFilter; },            set filter(v)     { auxFilter = v; },
    get calcolCode() { return auxCalcolCode; },        set calcolCode(v) { auxCalcolCode = v; },
    get calcolMeta() { return auxCalcolMeta; },        set calcolMeta(v) { auxCalcolMeta = v; },
    get prefix()     { return auxPrefix; },            set prefix(v)     { auxPrefix = v; },
    get declus()     { return auxDeclus; },            set declus(v)     { auxDeclus = v; },
    get topcut()     { return auxTopcut; },            set topcut(v)     { auxTopcut = v; },
    get view()       { return auxView; },              set view(v)       { auxView = v; },
    get gridMode()   { return auxGridMode; },          set gridMode(v)   { auxGridMode = v; },
    get rowVar()     { return AUX_ROW_VAR; }
  }
];
function dsById(id) {
  for (var i = 0; i < datasets.length; i++) if (datasets[i].id === id) return datasets[i];
  return null;
}

// A10 phase 1: real per-dataset entries beyond the two singleton views. The
// model (datasets[0]) and the first comparison ('aux', datasets[1]) keep
// their legacy globals as backing (so existing code stays bit-identical);
// additional comparison datasets are plain objects created here. id 'd2',
// 'd3', … is the catalog namespace, project key, pack folder, and the
// expression handle (rowVar) for that dataset. Design: docs/a10-n-datasets.md.
var dsNextNum = 2;
function dsCreate(opts) {
  opts = opts || {};
  return {
    id: opts.id || ('d' + (dsNextNum++)),
    file: opts.file || null,
    handle: opts.handle || null,
    preflight: null,
    complete: null,
    stale: false,
    filter: null,
    calcolCode: '',
    calcolMeta: [],
    prefix: opts.prefix || 'data',
    gridMode: opts.gridMode || null,   // A10 4f-2: grid override (null = default 'auto')
    declus: null,
    topcut: null,
    view: 'preview',
    source: opts.source || 'file',
    get rowVar() { return this.id; }   // d2+ expressions reference columns as <id>.<col>
  };
}
function dsAdd(ds) { datasets.push(ds); return ds; }
function dsRemove(id) {
  for (var i = 2; i < datasets.length; i++) {   // never the model/aux views (0,1)
    if (datasets[i].id === id) { datasets.splice(i, 1); return true; }
  }
  return false;
}

// A10 phase 1 — dataset config panels resolve their DOM through a per-dataset
// ROOT rather than the document, so N instance panels can coexist (slice 1g).
// Today the single aux dataset's panel is the static #panelAux element. This
// slice (1e) only centralizes the lookup PATH: ids are still unique, so a
// scoped querySelector resolves the same single live element — behavior is
// bit-identical (the seam is inert until 1f flips the ids to classes). All
// aux-panel code (auxtab/topcut/drillhole) reads through auxQ from here on.
// dsConfigRoot(ds) → the config-panel ROOT element for a dataset. The model
// and the legacy aux are static panels; d2+ instances (1g-c) are rails-built
// clones tagged `.ds-panel[data-ds="<id>"]`. auxQ(sel, root) scopes a lookup
// to a root (defaults to the aux panel) — pass an explicit root to address an
// instance's DOM. (1g-b parameterizes the render/handlers by (ds, root); for
// now everything resolves the single aux panel, behavior unchanged.)
function dsConfigRoot(ds) {
  if (!ds) return null;
  if (ds.id === 'aux') return document.getElementById('panelAux');
  if (ds.id === 'model') return document.getElementById('panelPreflight');
  return document.querySelector('.ds-panel[data-ds="' + ds.id + '"]');
}
function auxPanelRoot() { return document.getElementById('panelAux'); }
function auxQ(sel, root) { var r = root || auxPanelRoot(); return r ? r.querySelector(sel) : null; }

// A10 4e-c: the Categories analysis panel becomes cloneable the same way the
// dataset config panels did (1e/1f/1g) — DOM resolved through a per-instance
// ROOT instead of singleton ids. 4e-c-2 (this slice) is the inert seam: the
// render path resolves its elements via catEls(root), defaulting to the static
// #panelCategories, so behavior is bit-identical while the code stops depending
// on unique ids. Clones (4e-c-4) pass their own root; the singleton $cat* consts
// stay for the singleton-only consumers (project.js reset, renderCategoriesTab).
function catPanelRoot(inst) {
  if (inst && inst.root) return inst.root;     // future: an instance carries its panel root
  return document.getElementById('panelCategories');
}
function catQ(sel, root) { var r = root || catPanelRoot(); return r ? r.querySelector(sel) : null; }
// The bundle of a Categories panel's elements, resolved by data-cat within its
// root — one call per render fn, then $catX → els.X.
function catEls(root) {
  root = root || catPanelRoot();
  function q(k) { return root ? root.querySelector('[data-cat="' + k + '"]') : null; }
  return {
    body: q('body'), sidebar: q('sidebar'), badge: q('badge'), colSearch: q('colSearch'),
    datasetWrap: q('datasetWrap'),
    datasetsSection: q('datasetsSection'), datasetChips: q('datasetChips'), colList: q('colList'),
    main: q('main'), toolbar: q('toolbar'), mainContent: q('mainContent'), chart: q('chart'),
    valueTableWrap: q('valueTableWrap'), valueSearch: q('valueSearch'), sortGroup: q('sortGroup'),
    valueTable: q('valueTable'), colorPicker: q('colorPicker')
  };
}
// A10 4e-c-3: per-instance Categories state. The singleton panel uses
// panelState.categories; clones (4e-c-4, tagged data-cat-inst on their root)
// get their own {focusedCol, chartShowAll} from catInstances. dsHidden + the
// catalog (colors/sort/order) stay shared — the catalog legitimately, dsHidden
// for now (its chips only surface at 3+ datasets; per-instance chips are a
// follow-up). catStateForRoot resolves the state object for a render root.
var catInstances = {};
function catNewInstState() { return { focusedCol: null, chartShowAll: false, catTargetDsId: 'model' }; }
function catStateForRoot(root) {
  root = root || catPanelRoot();
  var id = root && root.getAttribute ? root.getAttribute('data-cat-inst') : null;
  if (id && catInstances[id]) return catInstances[id];
  return panelState.categories;     // singleton (also holds the shared dsHidden)
}

// A10 Statistics clone arc (st-1): the Statistics panel becomes cloneable the
// same way Categories did (4e-c) — DOM resolved through a per-instance ROOT
// instead of singleton ids. st-1 is the inert seam: render fns resolve elements
// via statEls(root), defaulting to the static #panelStatistics, so behavior is
// bit-identical (els.X === $statsX) while the code stops depending on unique ids.
// Clones (st-4) pass their own root; the $stats* consts stay for singleton-only
// consumers (project.js, workspace.js).
function statPanelRoot() { return document.getElementById('panelStatistics'); }
function statQ(sel, root) { var r = root || statPanelRoot(); return r ? r.querySelector(sel) : null; }
function statEls(root) {
  root = root || statPanelRoot();
  function q(k) { return root ? root.querySelector('[data-stat="' + k + '"]') : null; }
  return {
    body: q('body'), sidebar: q('sidebar'), main: q('main'), content: q('content'), badge: q('badge'),
    datasetWrap: q('datasetWrap'),
    presetBtns: q('presetBtns'), customPct: q('customPct'), weightSel: q('weightSel'), weightNote: q('weightNote'),
    metricToggles: q('metricToggles'), datasetsSection: q('datasetsSection'), datasetChips: q('datasetChips'),
    varSearch: q('varSearch'), varAll: q('varAll'), varNone: q('varNone'), varList: q('varList'),
    copyBtn: q('copyBtn'), cdfPanel: q('cdfPanel'), cdfToolbar: q('cdfToolbar'), cdfChart: q('cdfChart'),
    downloadSvg: q('downloadSvg'), downloadPng: q('downloadPng')
  };
}

// ─── A10 4b: datasets are peers — capabilities are FACETS, not a kind ──────
// "model" is no longer a privileged type; it is simply the dataset that (today)
// carries a block geometry. Grid-dependent features feature-detect via
// dsHasGrid instead of id==='model', so a grid-detected comparison dataset
// (after import unification, 4f) gets geometry/GT/Export too, and a grid-free
// session is legal. dsLabel centralizes the display label so call sites stop
// hardcoding the model-vs-prefix branch. Design: docs/a10-n-datasets.md.
function dsLabel(id) {
  if (id === 'model') return 'Model';
  var ds = dsById(id);
  return (ds && ds.prefix) || auxPrefix || 'aux';
}
// A10 4f: the per-dataset grid classification — 'grid' (force gridded), 'point'
// (force scattered), or 'auto' (use the worker's isRegularGrid auto-detect).
// Default: the model is an explicit block-model import → 'grid'; every other
// dataset auto-detects. An explicit override (ds.gridMode, set by the import UI
// in 4f-2) wins — inferred state stays visible + overridable (no-magic-only-ui).
function dsGridMode(ds) {
  if (ds && (ds.gridMode === 'grid' || ds.gridMode === 'point' || ds.gridMode === 'auto')) return ds.gridMode;
  return (ds && ds.id === 'model') ? 'grid' : 'auto';
}
// A dataset's block geometry when it qualifies as a grid, else null. Any dataset
// with XYZ produces a geometry object now (4f); whether it COUNTS as a grid is
// the grid-mode decision above, so scattered point data doesn't masquerade as a
// block model.
function dsGrid(ds) {
  var g = ds && ds.complete && ds.complete.geometry;
  if (!(g && g.x && g.y && g.z && g.x.blockSize && g.y.blockSize && g.z.blockSize)) return null;
  var mode = dsGridMode(ds);
  if (mode === 'point') return null;
  if (mode === 'grid') return g;
  return g.isRegularGrid ? g : null;   // 'auto' — trust the worker's detection
}
function dsHasGrid(ds) { return !!dsGrid(ds); }

// A10 4f-2: does this dataset have all three coordinate axes assigned? (XYZ is
// the precondition for any geometry; geometry itself is only known post-analysis.)
function dsHasXYZ(ds) {
  var q = ds && ds.preflight && ds.preflight.xyz;
  if (ds && ds.id === 'model' && preflightData) q = preflightData.xyz;   // model preflight is the canonical store
  return !!(q && q.x >= 0 && q.y >= 0 && q.z >= 0);
}

// C10 P0 — a dataset FACET is a capability an analysis surface consumes. This
// centralizes the per-surface targetability predicates the A10 G-series
// hand-coded six times (four were "has .complete"; Categories needed category
// data, Swath needed block geometry). Each case preserves the surface's exact
// prior predicate, so surfaceTargetableDatasets(facet) is bit-identical.
// Design: docs/c10-dataset-surface-decoupling.md.
function dsHasFacet(ds, facet) {
  if (!ds || !ds.complete) return false;          // every facet presupposes an analysis
  var c = ds.complete;
  switch (facet) {
    case 'categorical': return !!(c.categories && Object.keys(c.categories).length);
    case 'gridded':     return !!(c.geometry && c.geometry.x && c.geometry.x.blockSize);
    case 'analyzed':
    default:            return true;
  }
}
// The datasets a surface can target — those exposing the facet it consumes.
// Replaces the six <x>TargetableDatasets() copies.
function surfaceTargetableDatasets(facet) {
  var out = [];
  for (var i = 0; i < datasets.length; i++) if (dsHasFacet(datasets[i], facet)) out.push(datasets[i]);
  return out;
}
// C10 P2: resolve the dataset a surface targets, given its stored target `id`
// and the `facet` it consumes. Five surfaces (stats/cat/swath/export/gt) hand-
// rolled this same id→ds resolution with two fallback policies; centralizing
// both lets their TargetDs become one-line delegations (each Ctx keeps its own
// thin schema resolver). Bit-identical to the prior per-surface bodies:
//   - usable(ds) → the stored target itself (default: has an analysis;
//     Categories overrides to also require category data).
//   - opts.keepUnanalyzed (export/gt): only a 'model' target bounces to the
//     first facet-targetable dataset; a non-model target is KEPT (re-analyzed on
//     demand) or floors to the model.
//   - else (stats/cat/swath): any unusable target bounces to the first facet-
//     targetable dataset, flooring to model/datasets[0].
function surfaceTarget(facet, id, opts) {
  opts = opts || {};
  var ds = dsById(id);
  var usable = opts.usable || function(d) { return d && d.complete; };
  if (usable(ds)) return ds;
  var ts = surfaceTargetableDatasets(facet);
  if (opts.keepUnanalyzed) {
    if (id === 'model' && ts.length) return ts[0];
    return ds || dsById('model');
  }
  return ts.length ? ts[0] : (dsById('model') || datasets[0]);
}

// ─── C10 P3: shared panel-clone plumbing ───────────────────────────────────
// The six analysis surfaces (Statistics/Categories/Swath/GT/Export/StatsCat)
// each grew a cloneable instance arc. The genuinely-duplicated mechanics live
// here; the surface-specific parts (accessor-proxy field lists, NewInstState,
// BuildInstancePanel templates, serialize/restore shapes) stay per-surface —
// they name surface-specific globals/templates, so they're six different things,
// not duplication. Bit-identical to the prior inline copies.

// A clone's render root carries a data-<x>-inst marker; the singleton root does
// not. THE definition of "is this root a clone".
function surfaceIsInst(root, attr) {
  return !!(root && root.getAttribute && root.getAttribute(attr));
}
// Get-or-create the per-instance state object for a clone root (registry
// `instances`, seeded by `make`). Returns null for the singleton root, so the
// caller falls back to its module globals / accessor proxy.
function surfaceInstState(root, attr, instances, make) {
  if (!surfaceIsInst(root, attr)) return null;
  var id = root.getAttribute(attr);
  if (!instances[id]) instances[id] = make();
  return instances[id];
}
// Close each clone's rails tab (when the rails shell is up and the tab exists)
// and run the surface's optional per-instance teardown — the fiddly wsRails/
// findTab guard, centralized. The reset sites still clear their own registries
// (instances/instanceEls/seq are module vars only the caller can reassign).
function surfaceCloseInstTabs(instances, dispose) {
  Object.keys(instances).forEach(function(id) {
    if (typeof wsRails !== 'undefined' && wsRails && typeof findTab === 'function' && findTab(wsRails.state, id)) {
      try { wsRails.closeTab(id); } catch (e) {}
    }
    if (dispose) dispose(id);
  });
}

// C10 P1: the shared "Dataset" picker markup — a title + a <select> of the
// datasets exposing `facet`, the current one pre-selected. Returns '' below 2
// targetable datasets (the surface is then implicitly its sole dataset, as
// before). Replaces the six near-identical RenderDatasetPicker option-builders;
// the only per-surface variation is CSS classes + the data-* marker the surface
// re-finds for wiring (cfg: {facet, current, titleClass, selectClass, selAttr}).
// esc() is a no-op on dataset ids (model/aux/d2…) so output stays byte-identical.
function dsPickerHtml(cfg) {
  var ts = surfaceTargetableDatasets(cfg.facet);
  if (ts.length >= 2) {
    var cur = cfg.current;
    return '<div class="' + cfg.titleClass + '">Dataset</div>' +
      '<select class="' + cfg.selectClass + '" ' + cfg.selAttr + '>' +
      ts.map(function(d) { return '<option value="' + esc(d.id) + '"' + (d.id === cur ? ' selected' : '') + '>' + esc(dsLabel(d.id)) + '</option>'; }).join('') +
      '</select>';
  }
  // Below 2 targetable datasets the surface is implicitly its sole dataset. But
  // silently hiding the control means targeting is undiscoverable (you can't tell
  // it exists). So when ANOTHER dataset is loaded but not yet usable here, show the
  // control DISABLED with the action that unlocks it (no-magic-only-ui).
  var loaded = (typeof datasets !== 'undefined' ? datasets : []).filter(function(d) { return d && d.preflight; });
  if (loaded.length < 2) return '';   // genuinely a single-dataset project — nothing to target
  var anyUnanalyzed = loaded.some(function(d) { return !d.complete && !ts.some(function(t) { return t.id === d.id; }); });
  var hint = anyUnanalyzed ? 'Analyze another dataset to target it here' : 'No other dataset fits this surface yet';
  return '<div class="' + cfg.titleClass + '">Dataset</div>' +
    '<select class="' + cfg.selectClass + ' ds-picker-latent" ' + cfg.selAttr + ' disabled title="' + esc(hint) + '">' +
    '<option selected>' + esc(dsLabel(cfg.current)) + '</option></select>' +
    '<div class="ds-picker-hint">' + esc(hint) + '</div>';
}

// ── C10: the surface registry (reverse index of the dataset picker) ───────
// One descriptor per analysis surface: how to read the singleton's target, its
// clone instances, and a clone's target field. Lets the Data tree list, per
// dataset, the surfaces pointed at it — and lets any code enumerate surfaces
// without re-deriving each panel's bespoke target storage. Globals are read
// lazily (the surface modules load after core.js); guarded for load order.
function surfaceDescriptors() {
  return [
    { kind: 'statistics', label: 'Statistics', facet: 'analyzed',    singleton: function () { return statsTargetDsId; },    insts: function () { return statInstances; },     instTarget: function (s) { return s.statsTargetDsId; } },
    { kind: 'categories', label: 'Categories', facet: 'categorical', singleton: function () { return panelState.categories.catTargetDsId || 'model'; }, insts: function () { return catInstances; }, instTarget: function (s) { return s.catTargetDsId; } },
    { kind: 'statscat',   label: 'StatsCat',   facet: 'analyzed',    singleton: function () { return statsCatTargetDsId; },  insts: function () { return statsCatInstances; }, instTarget: function (s) { return s.targetDsId; } },
    { kind: 'gt',         label: 'Grade–Tonnage', facet: 'analyzed', singleton: function () { return gtTargetDsId; },        insts: function () { return gtInstances; },       instTarget: function (s) { return s.gtTargetDsId; } },
    { kind: 'swath',      label: 'Swath',      facet: 'gridded',     singleton: function () { return swathTargetDsId; },     insts: function () { return swathInstances; },    instTarget: function (s) { return s.swathTargetDsId; } },
    { kind: 'crosstab',   label: 'Cross-tab',  facet: 'categorical', singleton: function () { return crosstabTargetDsId; },  insts: function () { return crosstabInstances; }, instTarget: function (s) { return s.targetDsId; } },
    { kind: 'export',     label: 'Export',     facet: 'analyzed',    singleton: function () { return exportTargetDsId; },    insts: function () { return exportInstances; },   instTarget: function (s) { return s.targetDsId; } }
  ];
}
// Is a surface currently a live tab? (clones are only in their map while alive;
// a singleton is "in use" once opened as a tab — on the rails shell via findTab).
function surfaceIsOpen(id) {
  if (typeof wsRails !== 'undefined' && wsRails && typeof findTab === 'function') return !!findTab(wsRails.state, id);
  return true;   // legacy shell isn't multi-tabbed the same way — include
}
// Every live analysis surface (each singleton + each clone) with the dataset it
// targets and whether it's an open tab.
function surfaceList() {
  var out = [];
  surfaceDescriptors().forEach(function (d) {
    var t; try { t = d.singleton(); } catch (e) { t = 'model'; }
    out.push({ id: d.kind, kind: d.kind, label: d.label, target: t || 'model', clone: false, open: surfaceIsOpen(d.kind) });
    var insts; try { insts = d.insts() || {}; } catch (e) { insts = {}; }
    Object.keys(insts).forEach(function (iid) {
      var s = insts[iid]; if (!s) return;
      var it; try { it = d.instTarget(s); } catch (e) { it = 'model'; }
      out.push({ id: iid, kind: d.kind, label: d.label, target: it || 'model', clone: true, open: true });
    });
  });
  return out;
}
// The surfaces pointed at a dataset (live ones: open singletons + clones).
function surfacesTargeting(dsId) {
  return surfaceList().filter(function (s) { return s.target === dsId && (s.clone || s.open); });
}

// User-given surface titles (persisted as the `surfaceTitles` project key) — let
// the user name a view to organize the workspace. Absent → a sensible default.
var surfaceTitles = {};
function surfaceDefaultTitle(id) {
  var kind = String(id).split('#')[0];
  var d = surfaceDescriptors().filter(function (x) { return x.kind === kind; })[0];
  var label = d ? d.label : kind;
  var hash = String(id).indexOf('#');
  return hash >= 0 ? (label + ' ' + String(id).slice(hash + 1)) : label;
}
function surfaceTitle(id) { return (surfaceTitles[id] || '').trim() || surfaceDefaultTitle(id); }
function surfaceHasCustomTitle(id) { return !!(surfaceTitles[id] && surfaceTitles[id].trim()); }
function surfaceSetTitle(id, t) {
  t = (t || '').trim();
  if (t && t !== surfaceDefaultTitle(id)) surfaceTitles[id] = t; else delete surfaceTitles[id];
  if (typeof wsRefreshSurfaceTabLabel === 'function') wsRefreshSurfaceTabLabel(id);   // mirror onto the tab if wired
  if (typeof autoSaveProject === 'function') autoSaveProject();   // persists + refreshes the tree
}

// A10 4f-2: the grid-classification control for a dataset's import panel — the
// grid/point/auto override chips + the detected-grid badge. Inferred state stays
// visible AND overridable (no-magic-only-ui). Shared by the model preflight
// (renderPreflightSidebar) and the comparison-dataset panels (renderAuxConfig);
// the chosen mode persists as ds.gridMode. The detected geometry is only known
// after an analysis (the worker computes it from the full stream), so before
// that we show only the override + a hint.
function dsGridSectionHtml(ds) {
  var mode = dsGridMode(ds);   // effective grid/point/auto (override or default)
  function chip(val, label, title) {
    return '<button type="button" class="ds-grid-chip' + (mode === val ? ' active' : '') +
      '" data-gridmode="' + val + '" title="' + esc(title) + '">' + label + '</button>';
  }
  var defLabel = (ds && ds.id === 'model') ? 'detect (default: grid)' : 'detect from data';
  var chips = '<div class="ds-grid-chips" role="group">' +
    chip('auto', 'auto', defLabel) +
    chip('grid', 'grid', 'Always treat as a regular block model') +
    chip('point', 'point', 'Always treat as scattered points (never a grid)') +
    '</div>';
  var g = ds && ds.complete && ds.complete.geometry;
  var status;
  if (g && g.x && g.x.blockSize && g.y && g.y.blockSize && g.z && g.z.blockSize) {
    var fmt = (typeof formatNum === 'function') ? formatNum : function(n) { return String(n); };
    var sizes = fmt(g.x.blockSize) + '×' + fmt(g.y.blockSize) + '×' + fmt(g.z.blockSize);
    var isGrid = dsHasGrid(ds);
    var auto = !!g.isRegularGrid;
    var badge = isGrid
      ? '<span class="ds-grid-badge is-grid">▦ grid</span> <span class="ds-grid-sizes">' + sizes + '</span>'
      : '<span class="ds-grid-badge is-points">∴ points</span>';
    var note;
    if (mode === 'grid' && !auto) note = 'forced — auto-detect saw irregular spacing';
    else if (mode === 'point' && auto) note = 'forced — auto-detect saw a regular grid';
    else if (mode === 'auto') note = auto ? 'auto-detected a regular grid' : 'auto-detected scattered points';
    else note = (mode === 'grid') ? 'forced to grid' : 'forced to points';
    status = '<div class="ds-grid-status">' + badge +
      '<span class="ds-grid-note">' + note + '</span></div>';
  } else if (!dsHasXYZ(ds)) {
    status = '<div class="ds-grid-status ds-grid-muted">Assign X/Y/Z to enable grid detection</div>';
  } else {
    status = '<div class="ds-grid-status ds-grid-muted">Run analysis to detect grid geometry</div>';
  }
  return chips + status;
}

// A10 4f-2: a dataset's grid classification changed (override flipped). Refresh
// the grid-dependent surfaces. Today that's the catalog tree (geometry facet);
// the Summary geometry table (4f-3) and GT/Export gating (4g/4h) hook in here as
// they generalize past the model-only paths.
function dsGridModeChanged(ds) {
  if (typeof refreshCatalogTree === 'function') refreshCatalogTree();
  // 4g: the model GT tab's block-volume source is gated on the grid
  // classification — refresh its display + auto-managed override when it flips.
  if (ds && ds.id === 'model' && typeof gtRefreshVolumeSource === 'function') gtRefreshVolumeSource();
}

// A10 4f-2: repaint the model preflight's grid section in place (the detected
// badge is only known post-analysis, but the preflight sidebar isn't rebuilt
// then — so refresh just the wrap from displayResults). No-op if absent.
function refreshModelGridSection() {
  var wrap = document.getElementById('pfGridWrap');
  if (wrap) wrap.innerHTML = dsGridSectionHtml(dsById('model'));
}

var HAS_FSAA = typeof window.showOpenFilePicker === 'function';

// Fuzzy subsequence match — returns true if all chars in query appear in order within target.
// Both should be lowercase. Empty query matches everything.
function fuzzyMatch(query, target) {
  if (!query) return true;
  var qi = 0;
  for (var ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) qi++;
  }
  return qi === query.length;
}

// Wire keyboard shortcuts on a search input: Esc=clear, Alt+A=all, Alt+Shift+A=none
function wireSearchShortcuts(input, allBtn, noneBtn) {
  if (!input) return;
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (input.value) {
        input.value = '';
        input.dispatchEvent(new Event('input'));
      } else {
        input.blur();
      }
    } else if (e.altKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      if (e.shiftKey) { if (noneBtn) noneBtn.click(); }
      else { if (allBtn) allBtn.click(); }
    }
  });
}

// C6-5: uniform "dim when done / re-run when stale" treatment for the
// per-tab action buttons (Generate/Analyze), generalizing executeBtn's
// clean/orange pattern. stale=false → button subdued (.gen-done), its
// .gen-stale-note (if any) hidden; stale=true → orange call-to-action +
// the note. The main #executeBtn keeps its own .clean toggle.
function setGenStale(btnOrId, stale) {
  // Accepts an element (per-instance buttons with no unique id — A10) or an
  // id string (the singleton gt/swath Generate buttons).
  var btn = (btnOrId && btnOrId.nodeType) ? btnOrId : document.getElementById(btnOrId);
  if (!btn) return;
  btn.classList.toggle('gen-done', !stale);
  var host = btn.closest('.sb-footer') || btn.parentElement;
  var note = host ? host.querySelector('.gen-stale-note') : null;
  if (note) note.style.display = stale ? 'block' : 'none';
}

const $dropzone = document.getElementById('dropzone');
const $fileInput = document.getElementById('fileInput');
const $recentFiles = document.getElementById('recentFiles');
// C6-2: recents snapshot for the File → Open recent submenu (menu factories
// are sync; renderRecentFiles refreshes this from the async IDB list).
var wsRecentsCache = [];
const $panelPreflight = document.getElementById('panelPreflight');
const $preflightZip = document.getElementById('preflightZip');
const $preflightHead = document.getElementById('preflightHead');
const $preflightPreview = document.getElementById('preflightPreview');
const $results = document.getElementById('results');
const $fileInfo = document.getElementById('fileInfo');
const $geoContent = document.getElementById('geoContent');
const $geoBadge = document.getElementById('geoBadge');
const $geoSection = document.getElementById('geoSection');
const $xyzConfig = document.getElementById('xyzConfig');
const $statsContent = document.getElementById('statsContent');
const $statsBadge = document.getElementById('statsBadge');
const $statsBody = document.getElementById('statsBody');
const $statsSidebar = document.getElementById('statsSidebar');
const $statsMain = document.getElementById('statsMain');
const $statsCdfPanel = document.getElementById('statsCdfPanel');
const $catBadge = document.getElementById('catBadge');
const $catBody = document.getElementById('catBody');
const $catSidebar = document.getElementById('catSidebar');
const $catColList = document.getElementById('catColList');
const $catColSearch = document.getElementById('catColSearch');
const $catMain = document.getElementById('catMain');
const $catToolbar = document.getElementById('catToolbar');
const $catMainContent = document.getElementById('catMainContent');
const $catChart = document.getElementById('catChart');
const $catValueTableWrap = document.getElementById('catValueTableWrap');
const $catValueSearch = document.getElementById('catValueSearch');
const $catValueTable = document.getElementById('catValueTable');
const $catColorPicker = document.getElementById('catColorPicker');
const $appFooter = document.getElementById('appFooter');
const $filterSection = document.getElementById('filterSection');
const $filterExpr = document.getElementById('filterExpr');
const $filterApply = document.getElementById('filterApply');
const $filterClear = document.getElementById('filterClear');
const $filterError = document.getElementById('filterError');
const $errorMsg = document.getElementById('errorMsg');
const $resultsToolbar = document.getElementById('resultsToolbar');
const $resultsFilename = document.getElementById('resultsFilename');
const $resultsRowInfo = document.getElementById('resultsRowInfo');
const $resultsTimeInfo = document.getElementById('resultsTimeInfo');
const $resultsMemInfo = document.getElementById('resultsMemInfo');
const $backToPreflight = document.getElementById('backToPreflight');
const $projectSave = document.getElementById('projectSave');
const $projectLoad = document.getElementById('projectLoad');
const $projectClear = document.getElementById('projectClear');
const $projectFileInput = document.getElementById('projectFileInput');
const $toolbarOverflow = document.getElementById('toolbarOverflow');
const $cdfModal = document.getElementById('cdfModal');
const $cdfTitle = document.getElementById('cdfTitle');
const $cdfBody = document.getElementById('cdfBody');
const $cdfClose = document.getElementById('cdfClose');
const $settingsModal = document.getElementById('settingsModal');
const $settingsClose = document.getElementById('settingsClose');
const $settingsBtn = document.getElementById('settingsBtn');
const $resultsTabs = document.getElementById('resultsTabs');
const $statsCatContent = document.getElementById('statsCatContent');
const $statsCatBadge = document.getElementById('statsCatBadge');
const $statsCatGroupBy = document.getElementById('statsCatGroupBy');
const $statsCatVarList = document.getElementById('statsCatVarList');
const $statsCatGroupList = document.getElementById('statsCatGroupList');
const $statsCatVarSearch = document.getElementById('statsCatVarSearch');
const $statsCatGroupSearch = document.getElementById('statsCatGroupSearch');
const $statsCatGroupAll = document.getElementById('statsCatGroupAll');
const $statsCatGroupNone = document.getElementById('statsCatGroupNone');
const $statsCatGroupSort = document.getElementById('statsCatGroupSort');
const $statsCatVarAll = document.getElementById('statsCatVarAll');
const $statsCatVarNone = document.getElementById('statsCatVarNone');
const $statsCatVarFilter = document.getElementById('statsCatVarFilter');
let lastDisplayedStats = null;
let lastDisplayedHeader = null;
let currentCalcolCode = '';
let currentCalcolMeta = []; // [{name, type}]
let currentOrigColCount = 0;
let lastCompleteData = null; // snapshot for cancel
let currentGroupBy = null; // column index for StatsCat grouping
let currentStatsCatVar = null; // selected numeric column index
let currentStatsCatChecked = null; // Set<string> of checked group values (null = all)
let lastStatsCatData = null; // cached full data for re-render
let statsCatGroupSortMode = null; // null = inherit from Categories tab, or 'count-desc'|'count-asc'|'alpha'|'custom'
let statsCatSelectedVars = new Set(); // col indices selected for group stats analysis
let statsCatCdfScale = 'linear'; // 'linear' or 'log'
let statsCatCdfManual = false;
let statsCatCdfMin = null;
let statsCatCdfMax = null;
let statsCatCrossMode = 'count'; // 'count', 'row', 'col'
let statsCatShowSelectedOnly = false;

// Categories tab state — focusedCol + chartShowAll on panelState.categories (4e-a/c-3);
// event wiring is per-root (wireCatEvents), guarded by root._catWired (4e-c-4)

// ─── Property catalog (C1a → A10 4a properties) ─────────────────────────
// Single source of truth for display + grouping. A **property** is a named
// measured quantity instantiated by columns across datasets — the equivalence
// class that subsumes C1a's per-`ds:name` vars + hub pairs (A10 4a-iii,
// docs/a10-n-datasets.md "Converged model"). Display (color / unit /
// categorical valueColors+order+sortMode) lives ON the property; a pair is a
// 2-member property, an unmatched column a singleton, a group N members.
//
//   catalog.properties = { p1: { name, members:[{ds,col}], color?, unit?,
//                                 valueColors?, valueOrder?, sortMode?, split? } }
//
// `catVar`/`catVarPeek` are the legacy FACADE: they return the property record
// a column belongs to, so the ~25 consumers (display reads, valueColors/sort
// writes, pairing) are unchanged. `_catPropIdx` (ds:col → id) is derived, not
// serialized. Roles stay per-dataset. Design: docs/c1a-property-catalog.md.
let catalog = newCatalog();
let _catPropIdx = {};   // 'ds:col' → property id (derived from members)
let _catPropSeq = 0;    // monotonic id counter (p1, p2, …)

function newCatalog() {
  return {
    datasets: { model: { label: 'Model' }, aux: { label: 'aux' } },
    roles: { model: {}, aux: {} },   // { weight, density, tonnageFactor } → variable name
    properties: {}                   // id → { name, members, …display }
  };
}

function _catNorm(s) { return String(s).trim().toLowerCase(); }
function _catNewProp(name) {
  const id = 'p' + (++_catPropSeq);
  catalog.properties[id] = { name: name, members: [] };
  return id;
}
// Rebuild the (ds:col → id) index + id counter from members. Call after a
// whole-catalog load (the index is derived, never serialized).
function catReindexProps() {
  _catPropIdx = {}; _catPropSeq = 0;
  if (!catalog.properties) catalog.properties = {};
  for (const id of Object.keys(catalog.properties)) {
    const n = parseInt(String(id).replace(/^p/, ''), 10);
    if (isFinite(n) && n > _catPropSeq) _catPropSeq = n;
    const p = catalog.properties[id];
    if (!p.members) p.members = [];
    for (const m of p.members) _catPropIdx[m.ds + ':' + m.col] = id;
  }
}

// The property id a column belongs to. create=true makes a dumb singleton if
// none (NO name-grouping here — grouping is centralized in catSeedPairs so
// splits/explicit pairs are never silently re-merged); create=false → null.
function catPropIdFor(ds, col, create) {
  const key = ds + ':' + col;
  const id = _catPropIdx[key];
  if (id && catalog.properties[id]) return id;
  if (!create) return null;
  const nid = _catNewProp(col);
  catalog.properties[nid].members.push({ ds: ds, col: col });
  _catPropIdx[key] = nid;
  return nid;
}
function _catDetach(ds, col) {
  const key = ds + ':' + col;
  const id = _catPropIdx[key];
  delete _catPropIdx[key];
  const p = id && catalog.properties[id];
  if (!p) return;
  p.members = p.members.filter(function(m) { return !(m.ds === ds && m.col === col); });
  if (p.members.length === 0) delete catalog.properties[id];
}

// ── Legacy facade: a "variable record" is now its property record ──
function catVar(ds, name) { return catalog.properties[catPropIdFor(ds, name, true)]; }
function catVarPeek(ds, name) { const id = catPropIdFor(ds, name, false); return id ? catalog.properties[id] : null; }

// Series color: property color → palette fallback (members of a property share
// its color — that's the cross-dataset grouping replacing hub inheritance)
function catVarColor(ds, name, fallbackIdx) {
  const rec = catVarPeek(ds, name);
  if (rec && rec.color) return rec.color;
  return STATSCAT_PALETTE[(fallbackIdx || 0) % STATSCAT_PALETTE.length];
}
// Unit as a GRADE_UNITS index (0 = raw) — property-level, shared by members
function catUnit(ds, name) {
  const rec = catVarPeek(ds, name);
  return (rec && rec.unit) ? rec.unit : 0;
}
function catSetUnit(ds, name, idx) {
  if (idx > 0) catVar(ds, name).unit = idx;
  else { const rec = catVarPeek(ds, name); if (rec) delete rec.unit; }
}

// Roles: one variable name per role per dataset (null = unassigned)
function catRole(ds, role) {
  return (catalog.roles[ds] && catalog.roles[ds][role]) || null;
}
function catSetRole(ds, role, name) {
  if (!catalog.roles[ds]) catalog.roles[ds] = {};
  if (name) catalog.roles[ds][role] = name;
  else delete catalog.roles[ds][role];
}

// ── Pairing as property membership (legacy aux→model API over properties) ──
// catMemberIn: the column in `targetDsId` grouped with (ds,name) — the fully
// dataset-generic primitive (ws-v2 phase 1; inverts the model-as-primary
// assumption so any dataset can be the comparison anchor). catModelMember is
// the model-anchored alias (A10 4c); catPair is the aux-only legacy alias.
function catMemberIn(ds, name, targetDsId) {
  const rec = catVarPeek(ds, name);
  if (!rec) return null;
  const m = rec.members.find(function(x) { return x.ds === targetDsId; });
  return m ? m.col : null;
}
function catModelMember(ds, name) { return catMemberIn(ds, name, 'model'); }
function catPair(auxName) { return catModelMember('aux', auxName); }
// Members of a model column's property in a given dataset (default aux)
function catGroupMembers(modelName, dsId) {
  dsId = dsId || 'aux';
  const rec = catVarPeek('model', modelName);
  if (!rec) return [];
  return rec.members.filter(function(x) { return x.ds === dsId; }).map(function(x) { return x.col; });
}
function catPairsRev(modelName) { return catGroupMembers(modelName, 'aux'); }
// Set/clear a comparison column's grouping (A10 4c-iv: any non-model dataset,
// not just aux). modelName → join that model's property (MERGE); falsy → split
// into its own property (pinned so re-seeding won't re-merge). Model columns
// are the grouping anchors and cannot themselves be re-homed here.
function catSetMember(ds, col, modelName) {
  if (ds === 'model') return;
  _catDetach(ds, col);
  if (modelName) {
    const mid = catPropIdFor('model', modelName, true);
    catalog.properties[mid].members.push({ ds: ds, col: col });
    _catPropIdx[ds + ':' + col] = mid;
  } else {
    const id = _catNewProp(col);
    catalog.properties[id].split = true;
    catalog.properties[id].members.push({ ds: ds, col: col });
    _catPropIdx[ds + ':' + col] = id;
  }
}
// Legacy aux-scoped alias.
function catSetPair(auxName, modelName) { catSetMember('aux', auxName, modelName); }

// Idempotent name-grouping seed for one dataset (dsId, default 'aux') against
// the model — the ONE place properties group by name, so explicit pairs
// (multi-member) and splits (split flag) are never re-merged. Tentative
// singletons (incl. display-only ones from migration) merge into the same-named
// model-bearing property, carrying any display they hold. (A10 4c: dataset-
// generic so every comparison dataset groups with the model, not just aux.)
function catSeedPairs(names, modelNames, dsId) {
  dsId = dsId || 'aux';
  for (const n of modelNames) catPropIdFor('model', n, true);
  for (const an of names) {
    const id = catPropIdFor(dsId, an, true);
    const p = catalog.properties[id];
    if (p.split || p.members.length > 1) continue;     // explicit choice — leave
    const nn = _catNorm(an);
    let targetId = null;
    for (const pid of Object.keys(catalog.properties)) {
      if (pid === id) continue;
      const q = catalog.properties[pid];
      if (_catNorm(q.name) !== nn) continue;
      if (q.members.some(function(m) { return m.ds === dsId; })) continue;
      // prefer the model-bearing property (the canonical group) when several share the name
      if (!targetId) targetId = pid;
      if (q.members.some(function(m) { return m.ds === 'model'; })) { targetId = pid; break; }
    }
    if (!targetId) continue;
    const q = catalog.properties[targetId];
    if (p.color && !q.color) q.color = p.color;
    if (p.unit && !q.unit) q.unit = p.unit;
    if (p.valueColors && !q.valueColors) q.valueColors = p.valueColors;
    if (p.valueOrder && !q.valueOrder) q.valueOrder = p.valueOrder;
    if (p.sortMode && !q.sortMode) q.sortMode = p.sortMode;
    q.members.push({ ds: dsId, col: an });
    delete catalog.properties[id];
    _catPropIdx[dsId + ':' + an] = targetId;
  }
}

// Convert a post-C1a project's catalog.vars + pairs into properties (pairs
// first establish membership, then display attaches to the right property).
function catImportLegacyVarsPairs(vars, pairs) {
  for (const an of Object.keys(pairs || {})) catSetPair(an, pairs[an] || null);
  // model: keys first so a paired group takes the model's display as canonical
  const keys = Object.keys(vars || {}).sort(function(a, b) {
    return (a.indexOf('model:') === 0 ? 0 : 1) - (b.indexOf('model:') === 0 ? 0 : 1);
  });
  for (const key of keys) {
    const ci = key.indexOf(':'); if (ci < 0) continue;
    const ds = key.slice(0, ci), name = key.slice(ci + 1);
    const rec = vars[key]; if (!rec) continue;
    const p = catVar(ds, name);
    if (rec.color != null && p.color == null) p.color = rec.color;
    if (rec.unit != null && p.unit == null) p.unit = rec.unit;
    if (rec.valueColors && !p.valueColors) p.valueColors = Object.assign({}, rec.valueColors);
    if (rec.valueOrder && !p.valueOrder) p.valueOrder = rec.valueOrder.slice();
    if (rec.sortMode && !p.sortMode) p.sortMode = rec.sortMode;
  }
}

// ── A10 4a property-id seam (used by per-panel selection in 4c) ──
// The opaque id of a column's property (ensures membership).
function catPropId(ds, name) { return catPropIdFor(ds, name, true); }
function catPropColor(ds, name, fallbackIdx) { return catVarColor(ds, name, fallbackIdx); }
function catPropUnit(ds, name) { return catUnit(ds, name); }

// Categorical value color: property override → palette by value position
function getCategoryColor(colName, value, fallbackIdx, dsId) {
  // Colours live on the shared property; resolve it via the given dataset's
  // member (ws-v2 phase 1: a comparison-targeted Categories panel anchors on its
  // own column). Default 'model' → bit-identical to the model-anchored original.
  const rec = catVarPeek(dsId || 'model', colName);
  if (rec && rec.valueColors && rec.valueColors[value]) return rec.valueColors[value];
  return STATSCAT_PALETTE[(fallbackIdx || 0) % STATSCAT_PALETTE.length];
}

// Idempotent pairing seed from whatever headers are currently known —
// callable from any renderer that needs pairs (aux list builders run off
// preflight data, before any aux analyze)
function catEnsureSeeded() {
  if (!currentHeader) return;
  const modelNames = currentHeader.slice();
  for (const cm of (currentCalcolMeta || [])) modelNames.push(cm.name);
  // A10 4c: seed EVERY comparison dataset (not just aux) against the model, so
  // d2/d3 columns group into the model's properties (shared color/unit, Δ%).
  for (let i = 0; i < datasets.length; i++) {
    const ds = datasets[i];
    if (ds.id === 'model' || !ds.preflight) continue;
    const names = (ds.preflight.header || []).slice();
    for (const am of (ds.calcolMeta || [])) names.push(am.name);
    catSeedPairs(names, modelNames, ds.id);
  }
}

// All per-variable unit selects (stats sidebar, swath, GT) are views of the
// catalog's one-unit-per-variable (D2) — refresh them after any unit edit
function catRefreshUnitSelects() {
  document.querySelectorAll('.col-unit-select').forEach(function(sel) {
    if (sel.dataset.colName) sel.value = catPropUnit('model', sel.dataset.colName);
  });
  document.querySelectorAll('.swath-var-unit, .gt-var-unit').forEach(function(sel) {
    if (sel.dataset.auxCol != null) {
      if (sel.dataset.auxName) sel.value = catPropUnit('aux', sel.dataset.auxName);
    } else {
      const n = currentHeader && currentHeader[parseInt(sel.dataset.col)];
      if (n) sel.value = catPropUnit('model', n);
    }
  });
}

// Drop empty display + re-derivable trivial singletons so the serialized
// catalog stays sparse. A property is KEPT if it carries display, has >1
// member (explicit/seeded pairing), is a split, or shares its name with
// another property (so a split survives reload). Reindexes after pruning.
function catCompact() {
  if (!catalog.properties) { catalog.properties = {}; return; }
  const nameCount = {};
  for (const id of Object.keys(catalog.properties)) {
    const nn = _catNorm(catalog.properties[id].name);
    nameCount[nn] = (nameCount[nn] || 0) + 1;
  }
  for (const id of Object.keys(catalog.properties)) {
    const p = catalog.properties[id];
    if (p.valueColors && Object.keys(p.valueColors).length === 0) delete p.valueColors;
    if (p.valueOrder && p.valueOrder.length === 0) delete p.valueOrder;
    for (const f of ['color', 'unit', 'sortMode']) { if (p[f] == null) delete p[f]; }
    const hasDisplay = p.color || p.unit || p.sortMode ||
      (p.valueColors && Object.keys(p.valueColors).length) || (p.valueOrder && p.valueOrder.length);
    const multi = (p.members || []).length > 1;
    const shared = nameCount[_catNorm(p.name)] > 1;
    if (!hasDisplay && !multi && !p.split && !shared) delete catalog.properties[id];
  }
  catReindexProps();
}

// Statistics tab state
let statsSelectedVars = null;     // Set<colIdx> or null (= all)
let statsVisibleMetrics = null;   // Set<string> or null (= all)
let statsPercentiles = [25, 50, 75]; // current percentile list
let statsCdfSelected = new Set(); // Set<colIdx> toggled for CDF overlay
let statsCdfScale = 'linear';     // 'linear' | 'log'

// Export
let exportWorker = null;
let exportColumns = []; // [{name, outputName, type, selected, isCalcol}]
let exportDelimiter = ',';
let exportIncludeHeader = true;
let exportCommentHeader = false;
let exportCommentText = '';
let exportQuoteChar = '"';       // '"', "'", '' (none)
let exportLineEnding = '\n';     // '\n' or '\r\n'
let exportNullValue = '';        // string to write for NaN/null
let exportPrecision = null;      // null = auto (passthrough), or integer (decimal places)
let exportDecimalSep = '.';      // '.' or ','
let exportSourcePrecision = {};  // {colName: maxDp} detected from preflight
const $exportColList = document.getElementById('exportColList');
const $exportBadge = document.getElementById('exportBadge');
const $exportDownload = document.getElementById('exportDownload');
const $exportInfo = document.getElementById('exportInfo');
const $exportProgress = document.getElementById('exportProgress');
const $exportProgressLabel = document.getElementById('exportProgressLabel');
const $exportProgressFill = document.getElementById('exportProgressFill');
const $exportColSearch = document.getElementById('exportColSearch');
const $exportBody = document.getElementById('exportBody');
const $exportToolbar = document.getElementById('exportToolbar');
const $exportRowPreview = document.getElementById('exportRowPreview');
const $exportIncludeHeader = document.getElementById('exportIncludeHeader');
const $exportCommentHeader = document.getElementById('exportCommentHeader');
const $exportCommentSection = document.getElementById('exportCommentSection');
const $exportCommentText = document.getElementById('exportCommentText');
const $exportCommentGenerate = document.getElementById('exportCommentGenerate');
const $exportCustomDelim = document.getElementById('exportCustomDelim');
const $exportFormatSection = document.getElementById('exportFormatSection');
const $exportPreview = document.getElementById('exportPreview');
const $exportPreviewPre = document.getElementById('exportPreviewPre');
const $exportPreviewInfo = document.getElementById('exportPreviewInfo');
const $exportPrecisionSelect = document.getElementById('exportPrecisionSelect');
const $exportPrecisionInput = document.getElementById('exportPrecisionInput');
const $exportNullSelect = document.getElementById('exportNullSelect');
const $exportNullInput = document.getElementById('exportNullInput');
const $exportPrecisionWarn = document.getElementById('exportPrecisionWarn');

// DXYZ state
let currentDXYZ = { dx: -1, dy: -1, dz: -1 };

// Swath state
let swathWorker = null;
let lastSwathData = null;
let swathExprController = null;

function getSwathVarColor(colName, paletteIdx, dsId) {
  return catPropColor(dsId || 'model', colName, paletteIdx);
}

// GT state
let gtWorker = null;
let lastGtData = null;
let gtExprController = null;

// Section state
let sectionBlocks = null;
let sectionTransform = null;
let sectionDefaultBlockSize = null;
let sectionWorker = null;
let sectionExprController = null;

// Project save/load
let pendingProjectRestore = null;
let autoSaveTimer = null;

// C6-1c chart series palette — theme-aware (dual-tuned, colorblind-aware,
// eye-comfort): darker/saturated for equipment gray, lighter for basalt.
// Ordered blue→orange→green→… for max distinctness in the common 2–3 series
// case; red demoted off the lead so a plain series doesn't read as a fault.
// STATSCAT_PALETTE is the LIVE binding, repointed by refreshChartPalette() on
// every applyTheme(); charts redraw through reRenderChartsForTheme().
const CHART_PALETTE_LIGHT = ['#2C66B0','#C0571E','#3C7D44','#7A4C9E','#B23636','#1C7480','#A84784','#8A6A1B'];
const CHART_PALETTE_DARK  = ['#5B9BE0','#E2823E','#5FA85F','#B287D6','#E06A60','#46A9B3','#D67BB4','#C9A14B'];
let STATSCAT_PALETTE = CHART_PALETTE_DARK;
function refreshChartPalette() {
  // base on the resolved DOM attribute (set by the head snippet + applyTheme),
  // so custom themes (forced data-theme="dark") get the dark variant too
  var dark = typeof document !== 'undefined' &&
    document.documentElement.getAttribute('data-theme') === 'dark';
  STATSCAT_PALETTE = dark ? CHART_PALETTE_DARK : CHART_PALETTE_LIGHT;
}
refreshChartPalette();

// Resolve a CSS custom property to a concrete value — canvas 2D can't read
// var() the way inline SVG can. Falls back if unset / pre-DOM.
function cssVal(name, fallback) {
  try {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch (e) { return fallback; }
}

// C6-1c theme-change hook: repoint the palette and redraw every cached chart
// (series colors + chrome tokens both shift on a Light/Dark flip). Reuses the
// same guarded cached-data renders as the chart-width observers (C1b-0); each
// guard makes an early applyTheme (before any analysis) a no-op.
function reRenderChartsForTheme() {
  refreshChartPalette();
  try { if (typeof lastCompleteData !== 'undefined' && lastCompleteData && typeof renderStatsCdfPanel === 'function') renderStatsCdfPanel(); } catch (e) {}
  try { if (typeof lastCompleteData !== 'undefined' && lastCompleteData && typeof currentGroupBy !== 'undefined' && currentGroupBy !== null && typeof renderStatsCatContent === 'function') renderStatsCatContent(); } catch (e) {}
  try { if (typeof lastGtData !== 'undefined' && lastGtData && typeof renderGtOutput === 'function') renderGtOutput(); } catch (e) {}
  try { if (typeof lastSwathData !== 'undefined' && lastSwathData && typeof renderSwathOutput === 'function') renderSwathOutput(); } catch (e) {}
  try { if (typeof _catData !== 'undefined' && _catData && typeof panelState.categories.focusedCol !== 'undefined' && panelState.categories.focusedCol !== null && typeof renderCatMain === 'function') renderCatMain(); } catch (e) {}
  try { if (typeof auxView !== 'undefined' && auxView === 'topcut' && typeof renderAuxTopcut === 'function') renderAuxTopcut(); } catch (e) {}
  try { if (typeof refreshCatalogTree === 'function') refreshCatalogTree(); } catch (e) {}
}

const GRADE_UNITS = [
  { label: '(raw)',  symbol: '',     factor: 1 },
  { label: '%',      symbol: '%',    factor: 0.01 },
  { label: 'ppm',    symbol: 'ppm',  factor: 1e-6 },
  { label: 'ppb',    symbol: 'ppb',  factor: 1e-9 },
  { label: 'g/t',    symbol: 'g/t',  factor: 1e-6 },
  { label: 'oz/t',   symbol: 'oz/t', factor: 3.11035e-5 }
];
// (per-variable units live in the catalog — catUnit/catSetUnit)

// A8: a numeric variable that finished analysis with zero valid values —
// every row was null/sentinel or removed by the per-column filters. Views
// badge these instead of silently dropping their series.
const EMPTY_COL_TITLE = 'no valid values in the last analysis — column is empty or every value was filtered out';
function colIsEmpty(ds, idx) {
  const e = (typeof dsById === 'function') ? dsById(ds) : null;
  const d = e ? e.complete : (ds === 'aux' ? auxCompleteData : lastCompleteData);
  if (!d || !d.stats || idx == null) return false;
  const s = d.stats[idx];
  return !!s && s.count === 0;
}

// A9 F2: values in a numeric column that failed to parse as numbers in the
// last analysis (counted apart from sentinel nulls) — mixed-type signal
function colParseFails(ds, idx) {
  const e = (typeof dsById === 'function') ? dsById(ds) : null;
  const d = e ? e.complete : (ds === 'aux' ? auxCompleteData : lastCompleteData);
  if (!d || !d.stats || idx == null) return 0;
  const s = d.stats[idx];
  return s && s.parseFails ? s.parseFails : 0;
}
function mixedColTitle(n) {
  return n.toLocaleString() + ' value' + (n === 1 ? '' : 's') + ' failed to parse as numbers (treated as nulls) — mixed-type column? Toggle it to CAT in Import Model if it\'s a category';
}

// A9 F3: one-line warning for per-row filter/calcol errors carried on a
// worker complete message; '' when clean. Optional label prefixes the note
// (e.g. the aux dataset).
function workerErrNote(msg, label) {
  if (!msg) return '';
  const parts = [];
  if (msg.filterErrors) {
    const n = (msg.filterErrors.global || 0) + (msg.filterErrors.local || 0);
    parts.push(n.toLocaleString() + ' row' + (n === 1 ? '' : 's') + ' excluded by filter errors — first: ' + msg.filterErrors.message);
  }
  if (msg.calcolErrors) {
    parts.push('calc errors on ' + msg.calcolErrors.count.toLocaleString() + ' row' + (msg.calcolErrors.count === 1 ? '' : 's') + ' — first: ' + msg.calcolErrors.message);
  }
  if (msg.raggedRows > 0) {
    parts.push(msg.raggedRows.toLocaleString() + ' row' + (msg.raggedRows === 1 ? '' : 's') + ' with unexpected field count (check delimiter/quoting — misaligned values land in the wrong columns)');
  }
  if (parts.length === 0) return '';
  return '<div class="warn-note">' + (label ? esc(label) + ': ' : '') + esc(parts.join(' · ')) + '</div>';
}

// ─── Container-width charts (C1b-0) ────────────────────────────────────
// Chart renderers draw their SVG at a logical width equal to the host's
// pixel width (1 viewBox unit = 1px → crisp text, no letterboxing); the
// viewBox keeps them scalable as a fallback. chartHostWidth reads the
// host at render time; observeChartWidth triggers the cheap cached-data
// re-render when the settled width changes (tree toggle, window resize,
// and the C1b rails panels later).
function chartHostWidth(el, fallback, min, pad) {
  var w = el ? el.clientWidth : 0;
  if (!w || w < 60) return fallback;   // hidden/unmounted → legacy constant
  return Math.max(min || 560, Math.floor(w - (pad || 0)));
}

function observeChartWidth(el, render) {
  if (!el || typeof ResizeObserver === 'undefined') return function() {};
  var lastW = el.clientWidth, timer = null;
  var ro = new ResizeObserver(function() {
    var w = el.clientWidth;
    if (Math.abs(w - lastW) < 8) return;          // jitter
    clearTimeout(timer);
    timer = setTimeout(function() {
      var w2 = el.clientWidth;
      if (Math.abs(w2 - lastW) < 8) return;
      lastW = w2;
      if (w2 < 60) return;                        // hidden — re-render on re-show
      requestAnimationFrame(render);
    }, 150);
  });
  ro.observe(el);
  return function() { ro.disconnect(); clearTimeout(timer); };
}

// Static chart hosts — one observer each, re-rendering from cached data
// (guards keep them no-ops before any analysis)
(function() {
  observeChartWidth(document.getElementById('statsCdfChart'), function() {
    if (lastCompleteData) renderStatsCdfPanel();
  });
  observeChartWidth(document.getElementById('statsCatContent'), function() {
    if (lastCompleteData && currentGroupBy !== null) renderStatsCatContent();
  });
  observeChartWidth(document.getElementById('gtContent'), function() {
    if (lastGtData) renderGtOutput();
  });
  observeChartWidth(document.getElementById('swathContent'), function() {
    if (lastSwathData) renderSwathOutput();
  });
  observeChartWidth(document.getElementById('catChart'), function() {
    if (_catData && panelState.categories.focusedCol !== null) renderCatBarChart();
  });
})();

// Calcol editor DOM refs
const $calcolBadge = document.getElementById('calcolBadge');
const $calcolCodeArea = document.getElementById('calcolCodeArea');
const $calcolCodePre = document.getElementById('calcolCodePre');
const $calcolSimBtn = document.getElementById('calcolSimBtn');
const $calcolError = document.getElementById('calcolError');
const $calcolVarBrowser = document.getElementById('calcolVarBrowser');
const $calcolVarSearch = document.getElementById('calcolVarSearch');
const $calcolVarList = document.getElementById('calcolVarList');
const $calcolFnList = document.getElementById('calcolFnList');
const $calcolDetected = document.getElementById('calcolDetected');
const $calcolPreviewTable = document.getElementById('calcolPreviewTable');
const $calcolDataSrc = document.getElementById('calcolDataSrc');
const $calcolAc = document.getElementById('calcolAc');

// Tab switching — legacy-shell arm of showPanel (workspace.js). On the
// rails shell (C1b) panels are positioned, not class-toggled; delegate so
// any straggler caller stays correct.
function switchTab(tabId) {
  if (wsRails) { wsActivateInRails(tabId); return; }
  $resultsTabs.querySelectorAll('.results-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabId));
  document.querySelectorAll('.results-panel').forEach(p => p.classList.toggle('active', p.dataset.tab === tabId));
}
$resultsTabs.addEventListener('click', (e) => {
  const tab = e.target.closest('.results-tab');
  if (tab) {
    showPanel(tab.dataset.tab);
    if ($helpOverlay && $helpOverlay.classList.contains('active')) renderHelp(tab.dataset.tab);
    if (typeof autoSaveProject === 'function') autoSaveProject();
  }
});

// Help overlay
const $helpOverlay = document.getElementById('helpOverlay');
const $helpBody = document.getElementById('helpBody');
const $helpTitle = document.getElementById('helpTitle');
const $helpBtn = document.getElementById('helpBtn');

var _helpShortcuts =
  '<div class="help-section"><div class="help-section-title">Shortcuts</div>' +
  '<div class="help-row"><kbd>F1</kbd> <span>Toggle this help panel</span></div>' +
  '<div class="help-row"><kbd>Alt+V</kbd> <span>Focus variable search on current tab</span></div>' +
  '<div class="help-row"><kbd>Esc</kbd> <span>Clear search (blur if empty)</span></div>' +
  '<div class="help-row"><kbd>Alt+A</kbd> <span>Select all visible</span></div>' +
  '<div class="help-row"><kbd>Alt+Shift+A</kbd> <span>Deselect all visible</span></div></div>';

// Shown on the rails shell (C1b) — docking workspace primer, same for every tab
var _helpWorkspace =
  '<div class="help-section"><div class="help-section-title">Workspace</div>' +
  '<div class="help-row"><span><strong>Drag a tab</strong> to rearrange: drop in the gaps between panels to split, onto a panel body to tear off a <strong>floating window</strong>, or on a tab strip to re-dock.</span></div>' +
  '<div class="help-row"><span><strong>Right-click a tab</strong> for Float / Move / Close; right-click a float’s titlebar to dock or close it.</span></div>' +
  '<div class="help-row"><span><strong>View → Panels</strong> reopens closed panels; <strong>View → Reset layout</strong> restores the default. The layout is saved with the project.</span></div>' +
  '<div class="help-row"><kbd>Ctrl+S</kbd> <span>flush the autosave (File → Save). <kbd>Alt</kbd> opens the menubar.</span></div>' +
  '<div class="help-row"><span>The <strong>Data</strong> rail (catalog tree) collapses and restores with its ◀ / ▶ buttons.</span></div></div>';

var _helpTabs = {
  aux: {
    title: 'Aux',
    html:
      '<div class="help-section"><div class="help-section-title">Overview</div>' +
      '<div class="help-row"><span>Load a second dataset — e.g. the composites/samples behind this block model — to compare against it. Aux runs as its own analysis pass; its variables appear across Statistics, CDF, and Swath with a label prefix.</span></div>' +
      '<div class="help-row"><span>Drop a file, or — when the main data came from a multi-entry archive — pick another entry from it (<em>use an entry from…</em>). Dropping a zip on this tab offers a <strong>ZIP entry</strong> selector in the sidebar.</span></div>' +
      '<div class="help-row"><span><strong>Drillhole set</strong> — raw drillhole tables (collar + survey + intervals, or one zip) become composited samples: minimum-curvature desurvey, length-weighted down-hole composites with a <code>SUPPORT</code> column (auto-assigned as the aux weight). Roles and columns are auto-detected but always shown and editable — check the <strong>dip convention</strong> toggle if your surveys use negative-down dips. The <strong>consistency report</strong> lists everything that didn’t join cleanly (orphan BHIDs, FROM≥TO, overlaps…); nothing is dropped silently. After loading, <em>Report</em> and <em>Edit &amp; re-composite</em> live next to the file name.</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Configuration</div>' +
      '<div class="help-row"><span><strong>Display prefix</strong> — cosmetic label for aux variables (e.g. <code>aux:Fe</code>). Does not affect expressions.</span></div>' +
      '<div class="help-row"><span><strong>Coordinates</strong> — assign X/Y/Z. Aux and the block model must share the same coordinate space for swath overlays to align.</span></div>' +
      '<div class="help-row"><span><strong>Aux filter</strong> — pre-filter aux rows. Reference aux columns as <code>aux.</code>… regardless of the display prefix.</span></div>' +
      '<div class="help-row"><span><strong>Weight</strong> — e.g. declustering weights (a column or an aux calcol). Applied to every aux statistic: Statistics rows, CDF overlay, and the swath series. Rows with missing/≤0 weight are excluded.</span></div>' +
      '<div class="help-row"><span><strong>Analyze</strong> — run the full aux statistics pass. Required for the Statistics-tab comparison and CDF overlay; the Swath overlay runs its own pass and does not need it.</span></div>' +
      '<div class="help-row"><span><strong>Aux calcols</strong> — switch the Calc tab to <strong>Aux</strong> to define calculated columns on the aux rows (<code>aux.</code> syntax); they join the comparisons and the weight list.</span></div>' +
      '<div class="help-row"><span><strong>Declustering</strong> — GSLIB cell declustering (DECLUS): weights each sample by 1/(samples per cell), averaged over origin offsets, sweeping cell sizes to find the minimum (or maximum) declustered mean. The curve shows the sweep — the optimum is marked, and you can pin a size by setting Cell min = max. <em>Use as aux weight</em> feeds the weights into every aux statistic, so Q–Q, CDF and swath comparisons run against declustered samples. Weights are tied to the current filter/calcol config and ask for a re-run when it drifts.</span></div>' +
      '<div class="help-row"><span><strong>Top-cut view</strong> — switch the main area from Preview to Top-cut: load a variable’s sample distribution and analyse candidate caps across four linked plots (histogram, log-probability, mean & CV vs cap, metal removed). Drag the cap line on any plot; the before/after strip updates live. No automatic pick — the conventional reading is the break near the top of the log-probability curve, weighed against the metal a cap removes. The <em>Raw | Declustered</em> toggle weights every statistic by the declustering weights (run Declustering first): raw is the capping convention, declustered shows capped means and metal unbiased by the drilling pattern. <em>Copy calcol</em> hands you <code>aux.X_cap = cap(aux.X, …)</code> for the Calc tab, which flows into every comparison. Aux calcols are cappable too: clean sentinels first (<code>aux.AU_CLEAN = aux.AU &lt; 0 ? null : aux.AU;</code>), then analyse the cleaned variable — cleaned-out rows are excluded and counted, and a positive minimum re-enables log X.</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Scope</div>' +
      '<div class="help-row"><span>Comparison is statistical/spatial — aux is a separate set of rows, not extra columns. No geometry, export, or per-row joins.</span></div></div>'
  },
  preflight: {
    title: 'Import Model',
    html:
      '<div class="help-section"><div class="help-section-title">Overview</div>' +
      '<div class="help-row"><span>Configure your file before analysis. Set column types, assign coordinate columns, and preview the data.</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Sidebar</div>' +
      '<div class="help-row"><span><strong>Type override</strong> \u2014 force a column to numeric or categorical</span></div>' +
      '<div class="help-row"><span><strong>Skip</strong> \u2014 uncheck to exclude a column from analysis entirely</span></div>' +
      '<div class="help-row"><span><strong>XYZ</strong> \u2014 assign coordinate columns for geometry detection, swath, section, and GT block volume</span></div>' +
      '<div class="help-row"><span><strong>DXYZ</strong> \u2014 optional per-block dimension columns for sub-blocked models</span></div>' +
      '<div class="help-row"><span><strong>Column filter</strong> \u2014 per-column expressions to pre-filter rows (e.g. <code>> 0</code>)</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">ZIP files</div>' +
      '<div class="help-row"><span>Drop a .zip and select which CSV entry to analyze from the dropdown.</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Projects</div>' +
      '<div class="help-row"><span><strong>Save</strong> (toolbar) — download the workspace config as <code>.bma.json</code>. Drop it on the landing page later, then drop the matching data file to apply it.</span></div>' +
      '<div class="help-row"><span><strong>Pack</strong> (toolbar) — bundle the data file(s), the aux dataset, and the project into one portable <code>.bma.zip</code>. The dialog sets a project title, picks contents, and toggles deflate compression; archives use Zip64 automatically, so size is not a limit. Dropping a packed zip offers to load everything pre-configured.</span></div></div>' +
      // ws-v2 phase 2: the Summary now lives in this panel's Preview/Summary toggle.
      '<div class="help-section"><div class="help-section-title">Summary view</div>' +
      '<div class="help-row"><span>After analysis, switch the right pane to <strong>Summary</strong> for file metadata, grid geometry, data health, and a column overview.</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Grid Geometry</div>' +
      '<div class="help-row"><span>Auto-detected XYZ extents, block sizes, sub-block ratios. Requires XYZ assignment.</span></div>' +
      '<div class="help-row"><span><strong>OBJ Export</strong> — download bounding box as a 3D mesh file</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Column Overview</div>' +
      '<div class="help-row"><span>Table of all columns with type, count, nulls, zeros, completeness, and range.</span></div>' +
      '<div class="help-row"><span><strong>Unit</strong> column — assign grade units (%, ppm, g/t, etc.) that propagate to GT and Swath</span></div>' +
      '<div class="help-row"><span><strong>Sniff units</strong> — auto-detect units from column name patterns like <code>_ppm</code>, <code>(g/t)</code>, <code>_pct</code></span></div>' +
      '<div class="help-row"><span><strong>Copy table</strong> — copy the overview as tab-separated text</span></div></div>'
  },
  calcols: {
    title: 'Calculated Columns',
    html:
      '<div class="help-section"><div class="help-section-title">Overview</div>' +
      '<div class="help-row"><span>Define new variables using JavaScript expressions. Calcols are computed during analysis and available in all tabs including filters.</span></div>' +
      '<div class="help-row"><span><strong>Model | Aux toggle</strong> — with an aux dataset loaded, switch the editor to define calcols on the aux rows instead. Aux code references columns as <code>aux.</code>… and its results feed the aux Statistics/CDF/Swath comparisons (and the aux filter).</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Syntax</div>' +
      '<div class="help-row"><span>Write assignments to <code>r</code>: e.g. <code>r.ratio = r.Au / r.Ag</code></span></div>' +
      '<div class="help-row"><span>Access any column as <code>r.column_name</code>. Spaces in names use bracket notation.</span></div>' +
      '<div class="help-row"><span>All Math functions available: <code>abs</code>, <code>sqrt</code>, <code>log</code>, <code>pow</code>, <code>min</code>, <code>max</code>, <code>round</code>, <code>floor</code>, <code>ceil</code>, etc.</span></div>' +
      '<div class="help-row"><span>Helpers: <code>clamp(v, lo, hi)</code>, <code>ifnull(v, fallback)</code>, <code>between(v, lo, hi)</code>, <code>remap(v, inLo, inHi, outLo, outHi)</code></span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Tips</div>' +
      '<div class="help-row"><span><strong>Simulate</strong> \u2014 preview calcol values on sample rows before re-analyzing</span></div>' +
      '<div class="help-row"><span><strong>Ordering matters</strong> \u2014 later lines can reference earlier calcols</span></div>' +
      '<div class="help-row"><span><strong>Variable browser</strong> \u2014 click a column name to insert it at cursor</span></div></div>'
  },
  statistics: {
    title: 'Statistics',
    html:
      '<div class="help-section"><div class="help-section-title">Overview</div>' +
      '<div class="help-row"><span>Per-variable descriptive statistics table with selectable metrics and CDF overlays.</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Sidebar</div>' +
      '<div class="help-row"><span><strong>Variables</strong> \u2014 check/uncheck to show/hide columns in the table</span></div>' +
      '<div class="help-row"><span><strong>Metrics</strong> \u2014 toggle which statistics rows to display (mean, std, min, max, percentiles, etc.)</span></div>' +
      '<div class="help-row"><span><strong>Percentiles</strong> \u2014 customize which percentiles are shown (preset or custom comma-separated)</span></div>' +
      '<div class="help-row"><span><strong>Weight</strong> \u2014 weight all numeric statistics by a column or calcol (e.g. ore proportion). Re-run analysis to apply. Weighted runs use population-form std/skew/kurt; rows with missing/\u22640 weight are excluded (count shown below the select). Toggle the <strong>\u03a3W</strong> metric to see weight totals.</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">CDF</div>' +
      '<div class="help-row"><span>Click the <strong>CDF</strong> link on any variable row to open a cumulative distribution overlay.</span></div>' +
      '<div class="help-row"><span>Toggle multiple variables to compare CDFs. Linear or log scale.</span></div>' +
      '<div class="help-row"><span><strong>Prob mode</strong> — the same curves on a normal probability scale (classic probability paper, 0.2–99.8%). With log X, a lognormal distribution plots as a straight line; breaks in the curve mark population mixtures, and the high-grade break is the conventional capping pick.</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Aux comparison</div>' +
      '<div class="help-row"><span>After running <strong>Analyze</strong> on the Aux tab, aux variables appear at the bottom of the sidebar. A same-named aux variable shows as an indented row right under its model counterpart — mean against mean, CV against CV.</span></div>' +
      '<div class="help-row"><span><strong>Δ% row</strong> — under each matched pair: (model − aux) / aux per metric. The mean difference is the headline acceptance number in model validation; single-digit percentages are the conventional comfort zone. Count-like metrics and skew/kurtosis are skipped.</span></div>' +
      '<div class="help-row"><span>Click an aux row’s name to overlay its CDF as a dashed curve. A steeper model CDF over a flatter sample CDF is the classic kriging smoothing signature.</span></div>' +
      '<div class="help-row"><span><strong>Q–Q mode</strong> — switch the panel to a quantile–quantile plot: the first selected curve is the reference axis, every other curve plots against it at P1–P99 (large dots at deciles). Offset from the dashed identity line = bias; slope rotation = support/smoothing difference. Hover dots for values.</span></div></div>'
  },
  categories: {
    title: 'Categories',
    html:
      '<div class="help-section"><div class="help-section-title">Overview</div>' +
      '<div class="help-row"><span>Explore categorical columns with bar charts, value tables, color customization, and filter integration.</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Sidebar</div>' +
      '<div class="help-row"><span>Click a column to focus it in the main area. Search to filter the list.</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Main Area</div>' +
      '<div class="help-row"><span><strong>Bar chart</strong> \u2014 shows top 20 values by default; click Show All for the full set</span></div>' +
      '<div class="help-row"><span><strong>Sort</strong> \u2014 cycle through count-desc, count-asc, alphabetical, and custom drag order</span></div>' +
      '<div class="help-row"><span><strong>Colors</strong> \u2014 click a color swatch in the value table to customize. Colors are used consistently across all tabs.</span></div>' +
      '<div class="help-row"><span><strong>Filter checkboxes</strong> \u2014 uncheck values to add them to the global filter expression</span></div>' +
      '<div class="help-row"><span><strong>Custom order</strong> \u2014 drag rows in the value table to reorder; used in StatsCat, GT group-by, etc.</span></div>' +
      '<div class="help-row"><span><strong>Aux comparison</strong> \u2014 when the analyzed aux dataset shares a same-named categorical column, the chart overlays open diamonds at the aux shares (same axis as the bars) and the table gains aux n / aux % columns, with aux-only values listed at the bottom. Domain proportions model-vs-samples at a glance.</span></div></div>'
  },
  statscat: {
    title: 'StatsCat',
    html:
      '<div class="help-section"><div class="help-section-title">Overview</div>' +
      '<div class="help-row"><span>Group-by analysis: select a categorical column to split numeric variables into groups.</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Setup</div>' +
      '<div class="help-row"><span><strong>Group by</strong> \u2014 select which categorical column defines the groups</span></div>' +
      '<div class="help-row"><span><strong>Variables</strong> \u2014 check numeric columns to include in grouped stats (triggers re-analysis if new columns needed)</span></div>' +
      '<div class="help-row"><span><strong>Groups</strong> \u2014 check/uncheck group values to show/hide in the output</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Output</div>' +
      '<div class="help-row"><span><strong>Stats table</strong> \u2014 per-group mean, std, count, percentiles for each selected variable</span></div>' +
      '<div class="help-row"><span><strong>Cross-tabulation</strong> \u2014 count/row%/col% matrix of two categorical columns</span></div>' +
      '<div class="help-row"><span><strong>CDF overlay</strong> \u2014 grouped CDFs colored by category. Linear or log scale, manual range.</span></div>' +
      '<div class="help-row"><span>When a <strong>Weight</strong> is set on the Statistics tab, grouped statistics are weighted with it too (same analysis pass).</span></div></div>'
  },
  export: {
    title: 'Export',
    html:
      '<div class="help-section"><div class="help-section-title">Overview</div>' +
      '<div class="help-row"><span>Export filtered and transformed data as CSV. Includes calculated columns, column reorder, and format options.</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Columns</div>' +
      '<div class="help-row"><span><strong>Check/uncheck</strong> \u2014 select which columns to include</span></div>' +
      '<div class="help-row"><span><strong>Rename</strong> \u2014 click the rename field to change output column name</span></div>' +
      '<div class="help-row"><span><strong>Reorder</strong> \u2014 drag the grip handle to change column order</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Format Options</div>' +
      '<div class="help-row"><span><strong>Delimiter</strong> \u2014 comma, tab, semicolon, space, or custom</span></div>' +
      '<div class="help-row"><span><strong>Quote char</strong> \u2014 double, single, or none</span></div>' +
      '<div class="help-row"><span><strong>Precision</strong> \u2014 auto (preserve source), or fixed decimal places</span></div>' +
      '<div class="help-row"><span><strong>Null value</strong> \u2014 string to write for missing data (empty, NaN, -999, etc.)</span></div>' +
      '<div class="help-row"><span><strong>Decimal separator</strong> \u2014 period or comma (European)</span></div>' +
      '<div class="help-row"><span><strong>Comment header</strong> \u2014 optional metadata block prepended to the file</span></div></div>'
  },
  gt: {
    title: 'Grade-Tonnage',
    html:
      '<div class="help-section"><div class="help-section-title">Overview</div>' +
      '<div class="help-row"><span>Grade-tonnage analysis: sweep cutoff grades to produce tonnage, mean grade, and metal content curves.</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Configuration</div>' +
      '<div class="help-row"><span><strong>Grade variables</strong> \u2014 check one or more numeric columns. Each produces its own chart + table.</span></div>' +
      '<div class="help-row"><span><strong>Unit selects</strong> \u2014 per-variable units (%, ppm, g/t, etc.) control the grade factor for metal content. Inherits from global units; override locally.</span></div>' +
      '<div class="help-row"><span><strong>Sync units</strong> \u2014 pull unit assignments from Column Overview</span></div>' +
      '<div class="help-row"><span><strong>Density</strong> \u2014 a column, a constant (e.g. 2.8 t/m\u00b3), or none. Tonnage = volume \u00d7 density; with none, density is 1, so "tonnage" is really volume (m\u00b3).</span></div>' +
      '<div class="help-row"><span><strong>Weight</strong> \u2014 optional column for pre-computed block weights</span></div>' +
      '<div class="help-row"><span><strong>Block volume</strong> \u2014 auto from geometry or DXYZ; override with a custom value</span></div>' +
      '<div class="help-row"><span><strong>Tonnage unit</strong> \u2014 t, kt, Mt, or custom divisor</span></div>' +
      '<div class="help-row"><span><strong>Group by</strong> \u2014 segment by a categorical column for per-group curves</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Cutoffs</div>' +
      '<div class="help-row"><span><strong>Range</strong> mode \u2014 min/max/step generates evenly-spaced cutoffs</span></div>' +
      '<div class="help-row"><span><strong>Custom</strong> mode \u2014 comma-separated list of specific cutoff values</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Output</div>' +
      '<div class="help-row"><span>Chart with tonnage (amber, left Y), grade (blue, right Y), and metal (green, dashed). Hover for crosshair readout.</span></div>' +
      '<div class="help-row"><span><strong>Copy SVG / Download PNG</strong> — export each chart (PNG is a light-themed 2× render; both carry the variable name as a title)</span></div>' +
      '<div class="help-row"><span>Collapsible table below each chart. Copy button for clipboard export.</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Theoretical GT (samples)</div>' +
      '<div class="help-row"><span>With an aux dataset loaded, overlay the GT curve the <em>samples</em> predict at block support (dashed, scaled to the model’s total tonnage). The sample distribution uses the aux weights — declustering included — and is matched to each grade variable by name.</span></div>' +
      '<div class="help-row"><span><strong>f</strong> is the variance reduction factor Var(blocks)/Var(samples) — bring it from your estimation work or explore with the slider. It is deliberately never derived from the model under validation (circular). At f=1 the overlay is the sample GT itself.</span></div>' +
      '<div class="help-row"><span>The v0 engine is the <strong>affine correction</strong> (mean-preserving variance shrink) — honest but crude: it preserves the distribution’s shape exactly, which real support change does not. A discrete-Gaussian (Hermite) engine is planned. If the model’s curves sit far from the theoretical at any plausible f, the difference is worth explaining.</span></div></div>'
  },
  swath: {
    title: 'Swath Plots',
    html:
      '<div class="help-section"><div class="help-section-title">Overview</div>' +
      '<div class="help-row"><span>Spatial trend plots: bin blocks along an axis and show how variable values change across the model.</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Configuration</div>' +
      '<div class="help-row"><span><strong>Directions</strong> \u2014 check any combination of X (W\u2192E), Y (S\u2192N), Z (Bottom\u2192Top); all checked directions are computed in one pass and each gets its own output tab.</span></div>' +
      '<div class="help-row"><span><strong>Custom (rotated U/V/W)</strong> \u2014 enter dip direction (0\u00b0=N, clockwise), dip (\u00b0 below horizontal) and rake (\u00b0 from strike in the plane, 90\u00b0 = down-dip). U is the rake direction in the plane, V the in-plane perpendicular, W the pole. Check any of U/V/W to swath along the rotated axes \u2014 the old azimuth/plunge axis equals dipdir=azimuth, dip=plunge, rake=90\u00b0, U.</span></div>' +
      '<div class="help-row"><span><strong>Bin width</strong> \u2014 set per direction; defaults to the matching block size</span></div>' +
      '<div class="help-row"><span><strong>Statistic</strong> \u2014 Mean\u00b1Std, P25/P50/P75, or P10/P50/P90</span></div>' +
      '<div class="help-row"><span><strong>Weight (model)</strong> \u2014 weight the model series\u2019 bin statistics by a column or calcol. The aux series uses the weight set on the Aux tab.</span></div>' +
      '<div class="help-row"><span><strong>Variables</strong> \u2014 check one or more. Each gets its own Y-axis + ribbon on the overlay chart.</span></div>' +
      '<div class="help-row"><span><strong>Color swatch</strong> \u2014 click the colored square next to a variable name to customize its chart color</span></div>' +
      '<div class="help-row"><span><strong>Unit selects</strong> \u2014 per-variable units shown on axis labels, table headers, and tooltip. Inherits from global units.</span></div>' +
      '<div class="help-row"><span><strong>Sync units</strong> \u2014 pull unit assignments from Column Overview</span></div>' +
      '<div class="help-row"><span><strong>Aux overlay</strong> \u2014 with an aux dataset loaded (Aux tab), its variables appear at the bottom of the list and plot as dashed series. A same-named aux variable shares the model variable\u2019s color and Y scale, so model-vs-data bias reads directly off the chart. The aux pass applies the Aux tab filter (not the local filter below).</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Display</div>' +
      '<div class="help-row"><span><strong>Show bands</strong> \u2014 toggle the \u00b1 ribbons (std/percentile range). Disable to see center lines only.</span></div>' +
      '<div class="help-row"><span><strong>Show count bars</strong> \u2014 toggle the count histogram below the chart</span></div>' +
      '<div class="help-row"><span><strong>Show table</strong> \u2014 toggle the data table below the chart</span></div>' +
      '<div class="help-row"><span><strong>Y Scale</strong> \u2014 Linear or Log. Log clamps to positive values.</span></div>' +
      '<div class="help-row"><span><strong>Layout</strong> \u2014 Overlay (all variables on one chart) or Split (one chart per variable, stacked vertically)</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Output</div>' +
      '<div class="help-row"><span>Overlay chart with one ribbon+line per variable. Count bars below show bin population.</span></div>' +
      '<div class="help-row"><span>Hover for crosshair with per-variable center \u00b1 range values.</span></div>' +
      '<div class="help-row"><span><strong>Copy SVG</strong> \u2014 copy chart as SVG markup to clipboard</span></div>' +
      '<div class="help-row"><span><strong>Download PNG</strong> \u2014 download chart as a light-themed PNG at 2\u00d7 resolution</span></div>' +
      '<div class="help-row"><span>Collapsible data table with per-bin statistics. Copy to clipboard.</span></div></div>'
  },
  section: {
    title: 'Section View',
    html:
      '<div class="help-section"><div class="help-section-title">Overview</div>' +
      '<div class="help-row"><span>2D slice view of the block model. Select a plane, navigate through slices, and color by any variable.</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Configuration</div>' +
      '<div class="help-row"><span><strong>Plane</strong> \u2014 XY (plan), XZ (long section), or YZ (cross section)</span></div>' +
      '<div class="help-row"><span><strong>Slice</strong> \u2014 slider or input to select which slice along the normal axis</span></div>' +
      '<div class="help-row"><span><strong>Color by</strong> \u2014 numeric (continuous colormap) or categorical (category colors from Categories tab)</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Interaction</div>' +
      '<div class="help-row"><span>Pan by dragging, zoom with scroll wheel. Hover blocks for tooltip.</span></div></div>'
  }
};

function getActiveTabId() {
  var t = document.querySelector('.results-tab.active');
  return t ? t.dataset.tab : 'preflight';
}

// In-app confirmation dialog (replaces native confirm()). Resolves true/false.
// Enter = OK, Escape / ✕ / Cancel = false.
function bmaConfirm(opts) {
  return new Promise(function(resolve) {
    var $m = document.getElementById('confirmModal');
    document.getElementById('confirmTitle').textContent = opts.title || 'Confirm';
    document.getElementById('confirmBody').innerHTML = opts.html || '';
    var $ok = document.getElementById('confirmOk');
    var $cancel = document.getElementById('confirmCancel');
    var $close = document.getElementById('confirmClose');
    var $extra = document.getElementById('confirmExtra');
    $ok.textContent = opts.okLabel || 'OK';
    $cancel.textContent = opts.cancelLabel || 'Cancel';
    // Optional third choice (resolves opts.extraValue, default 'extra') — e.g.
    // a drop-to-add "Replace model" alongside "Add as comparison"/"Cancel".
    var extraValue = opts.extraValue || 'extra';
    if ($extra) {
      if (opts.extraLabel) { $extra.textContent = opts.extraLabel; $extra.style.display = ''; }
      else { $extra.style.display = 'none'; }
    }
    function done(v) {
      $m.classList.remove('active');
      $ok.removeEventListener('click', onOk);
      $cancel.removeEventListener('click', onCancel);
      $close.removeEventListener('click', onCancel);
      if ($extra) $extra.removeEventListener('click', onExtra);
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    }
    function onOk() { done(true); }
    function onCancel() { done(false); }
    function onExtra() { done(extraValue); }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); done(false); }
      else if (e.key === 'Enter') { e.stopPropagation(); done(true); }
    }
    $ok.addEventListener('click', onOk);
    $cancel.addEventListener('click', onCancel);
    $close.addEventListener('click', onCancel);
    if ($extra && opts.extraLabel) $extra.addEventListener('click', onExtra);
    document.addEventListener('keydown', onKey, true);
    $m.classList.add('active');
    $ok.focus();
  });
}

function renderHelp(tabId) {
  var info = _helpTabs[tabId];
  if (!info) { $helpBody.innerHTML = ''; $helpTitle.textContent = 'Help'; return; }
  $helpTitle.textContent = info.title;
  $helpBody.innerHTML = _helpShortcuts + (wsRails ? _helpWorkspace : '') + info.html;
}

function toggleHelp() {
  var opening = !$helpOverlay.classList.contains('active');
  $helpOverlay.classList.toggle('active');
  if (opening) renderHelp(getActiveTabId());
}

$helpBtn.addEventListener('click', toggleHelp);
document.getElementById('helpClose').addEventListener('click', function() {
  $helpOverlay.classList.remove('active');
});

// Global keyboard shortcuts
var _tabSearchMap = {
  statistics: 'statsVarSearch',
  categories: 'catColSearch',
  statscat: 'statsCatVarSearch',
  export: 'exportColSearch',
  calcols: 'calcolVarSearch',
  gt: 'gtVarSearch',
  swath: 'swathVarSearch'
};
document.addEventListener('keydown', function(e) {
  // F1 — toggle help
  if (e.key === 'F1') {
    e.preventDefault();
    toggleHelp();
    return;
  }
  // Ctrl/Cmd+S — flush the continuous autosave with a visible beat (C6-2)
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
    if ($results.classList.contains('active')) {
      e.preventDefault();
      if (typeof flushProjectSave === 'function') flushProjectSave();
    }
    return;
  }
  // Escape — close help if open
  if (e.key === 'Escape' && $helpOverlay.classList.contains('active')) {
    $helpOverlay.classList.remove('active');
    return;
  }
  // Alt+V — focus variable search on active tab
  if (e.altKey && e.key.toLowerCase() === 'v') {
    e.preventDefault();
    var activeTab = document.querySelector('.results-tab.active');
    if (!activeTab) return;
    var searchId = _tabSearchMap[activeTab.dataset.tab];
    if (searchId) {
      var el = document.getElementById(searchId);
      if (el) {
        // C6-4b: the search may live in a collapsed section — open it first
        var sec = el.closest('.sb-sec');
        if (sec && sec.classList.contains('collapsed')) {
          sec.classList.remove('collapsed');
          if (typeof SB_SECTIONS !== 'undefined' && sec.dataset.sb) {
            SB_SECTIONS[activeTab.dataset.tab + ':' + sec.dataset.sb] = false;
          }
        }
        el.focus(); el.select();
      }
    }
    return;
  }
});

