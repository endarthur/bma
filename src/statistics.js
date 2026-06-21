// ─── Statistics Tab ───────────────────────────────────────────────────

const STATS_PRESETS = {
  quartiles: [25, 50, 75],
  deciles: [10, 20, 30, 40, 50, 60, 70, 80, 90],
  ventiles: [5, 10, 25, 50, 75, 90, 95]
};

const STATS_ALL_METRICS = [
  { key: 'count', label: 'Count' },
  { key: 'sumw', label: 'ΣW' },
  { key: 'nulls', label: 'Nulls' },
  { key: 'parsefails', label: 'NoParse' },
  { key: 'zeros', label: 'Zeros' },
  { key: 'min', label: 'Min' },
  // percentile metrics injected dynamically
  { key: 'max', label: 'Max' },
  { key: 'mean', label: 'Mean' },
  { key: 'std', label: 'Std' },
  { key: 'cv', label: 'CV%' },
  { key: 'skew', label: 'Skew' },
  { key: 'kurt', label: 'Kurt' }
];

const STATS_DEFAULT_VISIBLE = new Set(['count', 'min', 'max', 'mean', 'std', 'cv']);

// Module-level state so delegation handlers can access current data
let _statsNumCols = [];
let _statsHeader = [];
let _statsOrigColCount = 0;
let _statsEventsWired = false;
let _statsCdfParams = null; // coordinate system for CDF tooltip
// A10 4d: the Δ% reference (denominator) is per-panel state — NOT a global ★.
// null = default (first shown comparison dataset = the samples/validation
// reference, preserving the model-vs-samples acceptance number). Lives on
// panelState.statistics.refDs (4e-a); serialized in 4e-b.

// ─── A10 Statistics st-2: per-instance panel state ─────────────────────────
// A Statistics clone owns its full view: which vars/metrics/percentiles, which
// CDF curves + scale/mode, and the comparison selection/hidden-chips/Δ%-ref.
// The SINGLETON keeps the existing module globals (statsSelectedVars… read by
// project.js serialize/restore + ctxmenu) and panelState.statistics, exposed via
// _statSingleton's accessor proxy so external reads stay bit-identical. A CLONE
// (st-4) gets a plain statNewInstState() object. Every render/event fn resolves
// its state with statStateForRoot(root); _statsNumCols/_statsHeader (the shared
// analysis) stay module-level. Inert until clones exist (st-4).
var statInstances = {};
// ws-v2 phase 1: which dataset this panel treats as PRIMARY (its columns are the
// table rows; every OTHER analyzed dataset becomes a Δ% comparison). Default
// 'model' → bit-identical to the pre-targeting behavior. The singleton's target
// lives in this module global; a clone keeps its own in statInstances[id].
var statsTargetDsId = 'model';
var _statSingleton = {
  get statsTargetDsId() { return statsTargetDsId; }, set statsTargetDsId(v) { statsTargetDsId = v; },
  get statsSelectedVars() { return statsSelectedVars; }, set statsSelectedVars(v) { statsSelectedVars = v; },
  get statsVisibleMetrics() { return statsVisibleMetrics; }, set statsVisibleMetrics(v) { statsVisibleMetrics = v; },
  get statsPercentiles() { return statsPercentiles; }, set statsPercentiles(v) { statsPercentiles = v; },
  get statsCdfSelected() { return statsCdfSelected; }, set statsCdfSelected(v) { statsCdfSelected = v; },
  get statsCdfScale() { return statsCdfScale; }, set statsCdfScale(v) { statsCdfScale = v; },
  get statsCdfMode() { return statsCdfMode; }, set statsCdfMode(v) { statsCdfMode = v; },
  get _statsCdfParams() { return _statsCdfParams; }, set _statsCdfParams(v) { _statsCdfParams = v; },
  get cmpSel() { return panelState.statistics.cmpSel; }, set cmpSel(v) { panelState.statistics.cmpSel = v; },
  get cdfCmpSel() { return panelState.statistics.cdfCmpSel; }, set cdfCmpSel(v) { panelState.statistics.cdfCmpSel = v; },
  get dsHidden() { return panelState.statistics.dsHidden; }, set dsHidden(v) { panelState.statistics.dsHidden = v; },
  get refDs() { return panelState.statistics.refDs; }, set refDs(v) { panelState.statistics.refDs = v; }
};
function statNewInstState() {
  return {
    statsTargetDsId: 'model',
    statsSelectedVars: null, statsVisibleMetrics: null, statsPercentiles: [25, 50, 75],
    statsCdfSelected: new Set(), statsCdfScale: 'linear', statsCdfMode: 'cdf', _statsCdfParams: null,
    cmpSel: {}, cdfCmpSel: {}, dsHidden: new Set(), refDs: null
  };
}
function statIsInst(root) { return !!(root && root.getAttribute && root.getAttribute('data-stat-inst')); }
function statStateForRoot(root) {
  if (statIsInst(root)) {
    var id = root.getAttribute('data-stat-inst');
    if (!statInstances[id]) statInstances[id] = statNewInstState();
    return statInstances[id];
  }
  return _statSingleton;
}

// ─── ws-v2 phase 1: per-panel target dataset ───────────────────────────────
// The Statistics table is no longer hardwired to the model. statsTargetDs(root)
// is the panel's PRIMARY dataset (its columns are the table rows); statsCtx(root)
// resolves that dataset's analysis. With target 'model' (the default) the ctx
// returns the model snapshot globals verbatim, so rendering is bit-identical to
// the pre-targeting code. Every render/event fn reads ctx instead of the
// _statsNumCols/_statsHeader module globals (which stay the MODEL snapshot for
// external readers: ctxmenu/cdf/settings). Mirrors gtCtx / statsCatCtx.
function statsTargetableDatasets() { return surfaceTargetableDatasets('analyzed'); }  // C10 P0
function statsTargetDs(root) {
  var id = statStateForRoot(root).statsTargetDsId;
  var ds = dsById(id);
  if (ds && ds.complete) return ds;
  // Model-optional: the default model target has no analysis but a comparison
  // does → target the first analyzed dataset so the panel stays usable.
  var ts = statsTargetableDatasets();
  return ts.length ? ts[0] : (dsById('model') || datasets[0]);
}
function statsCtx(root) {
  var ds = statsTargetDs(root);
  var isModel = ds.id === 'model';
  if (isModel) {
    return {
      ds: ds, id: 'model', isModel: true, complete: lastCompleteData,
      stats: lastDisplayedStats, header: lastDisplayedHeader,
      numCols: lastDisplayedStats ? Object.keys(lastDisplayedStats).map(Number).sort(function(a, b) { return a - b; }) : [],
      origColCount: currentOrigColCount || (lastDisplayedHeader ? lastDisplayedHeader.length : 0),
      rowCount: (lastCompleteData && lastCompleteData.rowCount) || 0,
      isFiltered: currentFilter !== null
    };
  }
  var c = ds.complete || {};
  return {
    ds: ds, id: ds.id, isModel: false, complete: ds.complete,
    stats: c.stats || null, header: c.header || null,
    numCols: c.stats ? Object.keys(c.stats).map(Number).sort(function(a, b) { return a - b; }) : [],
    origColCount: c.origColCount || (c.header ? c.header.length : 0),
    rowCount: c.rowCount || 0, isFiltered: !!ds.filter
  };
}

// The "Dataset" picker host at the top of the sidebar — shown only when 2+
// datasets are analyzed (with one, Statistics is implicitly that dataset, as
// before). Mirrors statsCatRenderDatasetPicker (onchange re-wired each render).
function renderStatsDatasetPicker(root) {
  var wrap = statEls(root).datasetWrap;
  if (!wrap) return;
  wrap.innerHTML = dsPickerHtml({ facet: 'analyzed', current: statsTargetDs(root).id,
    titleClass: 'stats-sidebar-title', selectClass: 'stats-select', selAttr: 'data-stat="datasetSel"' });
  var sel = wrap.querySelector('[data-stat="datasetSel"]');
  if (sel) sel.onchange = function() { setStatsTarget(sel.value, root); };
}
// Switch the panel's primary dataset and re-render it. Column-index selections
// (selectedVars / cdfSelected) are indices into the OLD target → reset to the
// default; comparison selections (cmpSel, keyed by ds id) survive.
function setStatsTarget(id, root) {
  var S = statStateForRoot(root);
  if (id === S.statsTargetDsId) return;
  S.statsTargetDsId = id;
  S.statsSelectedVars = null;
  S.statsCdfSelected = new Set();
  var els = statEls(root);
  if (els.varSearch) els.varSearch.value = '';
  renderStatsTab(lastDisplayedStats, lastDisplayedHeader,
    currentOrigColCount || (lastDisplayedHeader ? lastDisplayedHeader.length : 0),
    currentFilter !== null, (lastCompleteData && lastCompleteData.rowCount) || 0, root);
  if (typeof autoSaveProject === 'function') autoSaveProject();
}
// Keep the picker current as datasets analyze/clear; fall back to the model (or
// first analyzed) if the target's analysis went away. Called from the analysis-
// complete handlers (model + comparison) and clearAux.
function statsRefreshDatasetPicker(root) {
  var S = statStateForRoot(root);
  if (S.statsTargetDsId !== 'model' && !(dsById(S.statsTargetDsId) && dsById(S.statsTargetDsId).complete)) {
    S.statsTargetDsId = 'model';
  }
  renderStatsDatasetPicker(root);
}

// ─── A10 Statistics st-4: cloneable Statistics instances ───────────────────
// A clone is a copy of #panelStatistics with ids stripped (DOM resolved by
// data-stat within the root, tagged data-stat-inst). Its view state lives in
// statInstances[id] (st-2); it renders the SHARED analysis (lastDisplayedStats/
// Header) through its own state, so a clone is an independent view of the same
// numbers (different vars/metrics/CDF/comparison selection). rails calls
// statBuildInstancePanel(id) via renderPanel; wsSpawnStatisticsInstance + the
// tab "Duplicate" create them.
var statInstSeq = 1;
var statInstanceEls = {};   // instId -> the built clone element (one per instance)
function statNextInstId() { statInstSeq += 1; return 'statistics#' + statInstSeq; }

function statBuildInstancePanel(instId) {
  var tmpl = document.getElementById('panelStatistics');
  if (!tmpl) return null;
  // rails may call renderPanel more than once per tab id — return the SAME clone
  // (cache it) so a second build never leaves a duplicate in the DOM or re-wires.
  if (statInstanceEls[instId] && document.contains(statInstanceEls[instId])) return statInstanceEls[instId];
  if (!statInstances[instId]) statInstances[instId] = statNewInstState();
  var el = tmpl.cloneNode(true);
  el.removeAttribute('id');
  el.querySelectorAll('[id]').forEach(function(n) { n.removeAttribute('id'); });
  el.setAttribute('data-stat-inst', instId);
  el.setAttribute('data-tab', instId);
  el.classList.add('active');
  var ce = statEls(el);
  if (ce.varSearch) ce.varSearch.value = '';   // the clone copied the singleton's search text
  wireStatsEvents(el);                          // delegation on the clone's containers (survives re-render)
  if (lastDisplayedStats && lastDisplayedHeader) {
    renderStatsTab(lastDisplayedStats, lastDisplayedHeader, currentOrigColCount || lastDisplayedHeader.length,
      currentFilter !== null, (lastCompleteData && lastCompleteData.rowCount) || 0, el);
  }
  statInstanceEls[instId] = el;
  return el;
}

// Re-render every live clone after a (re)analysis — they share lastDisplayedStats
// but keep their own per-instance view state.
function statRenderAllInstances() {
  if (!lastDisplayedStats || !lastDisplayedHeader) return;
  Object.keys(statInstances).forEach(function(id) {
    var root = statInstanceEls[id];
    if (root && document.contains(root)) {
      renderStatsTab(lastDisplayedStats, lastDisplayedHeader, currentOrigColCount || lastDisplayedHeader.length,
        currentFilter !== null, (lastCompleteData && lastCompleteData.rowCount) || 0, root);
    }
  });
}

// Drop a clone's state (close / clear project).
function statDisposeInstance(instId) {
  delete statInstances[instId];
  delete statInstanceEls[instId];
}

// ─── A10 Statistics st-5: persist clone VIEWS (not the analysis) ───────────
// selectedVars/cdfSelected by model-column NAME; cmpSel/cdfCmpSel by comparison-
// column NAME (per ds); metrics/percentiles/scale/mode/dsHidden/refDs by value.
// Mirrors the singleton's project.stats + panels.statistics + the swath s-5 /
// cat 4e-c-5 pending-re-emit loss-safety. The RESULTS are shared (lastDisplayedStats).
function statNamesFromColSet(set, hdr) {
  if (!set || !hdr) return [];
  return Array.from(set).map(function(i) { return hdr[i]; }).filter(function(n) { return n != null; });
}
function statColSetFromNames(names, hdr) {
  var s = new Set();
  if (!names || !hdr) return s;
  var byName = {};
  for (var i = 0; i < hdr.length; i++) byName[hdr[i]] = i;
  names.forEach(function(n) { if (byName[n] !== undefined) s.add(byName[n]); });
  return s;
}
function statCmpByName(map) {
  var o = {};
  Object.keys(map).forEach(function(dsId) {
    var sel = map[dsId];
    if (sel == null) return;
    var ds = dsById(dsId), dh = ds && ds.complete && ds.complete.header;
    if (!dh) return;
    o[dsId] = statNamesFromColSet(sel, dh);
  });
  return o;
}

// Serialize one instance's live view (by NAME/value) — used by both the project
// serialize and Duplicate (carry the source panel's view to the new clone).
function statSerializeView(S) {
  // selectedVars/cdfSelected are column indices into the TARGET dataset → resolve
  // their names against the target's header (model = lastDisplayedHeader). This
  // keeps a comparison-targeted clone's selection from being serialized against
  // the wrong header. Model-targeted clones are unchanged (hdr = lastDisplayedHeader).
  var tid = S.statsTargetDsId || 'model';
  var hdr = (tid !== 'model') ? (((dsById(tid) || {}).complete || {}).header || lastDisplayedHeader) : lastDisplayedHeader;
  return {
    targetDsId: tid,   // ws-v2 phase 1
    selectedVars: S.statsSelectedVars ? statNamesFromColSet(S.statsSelectedVars, hdr) : null,
    visibleMetrics: S.statsVisibleMetrics ? Array.from(S.statsVisibleMetrics) : null,
    percentiles: S.statsPercentiles,
    cdfSelected: statNamesFromColSet(S.statsCdfSelected, hdr),
    cdfScale: S.statsCdfScale, cdfMode: S.statsCdfMode,
    cmpSel: statCmpByName(S.cmpSel), cdfCmpSel: statCmpByName(S.cdfCmpSel),
    dsHidden: Array.from(S.dsHidden), refDs: S.refDs
  };
}

function statSerializeInstances() {
  var out = [];
  Object.keys(statInstances).forEach(function(id) {
    var S = statInstances[id], pv = S._pendingView, view;
    if (pv && 'percentiles' in pv) {
      view = pv;   // analysis not landed yet — the pending view is the source of truth
    } else {
      view = statSerializeView(S);
      // loss-safety: re-emit comparison selections still pending (their ds isn't back)
      if (pv) ['cmpSel', 'cdfCmpSel'].forEach(function(k) {
        if (!pv[k]) return;
        Object.keys(pv[k]).forEach(function(dsId) { if (!(dsId in view[k])) view[k][dsId] = pv[k][dsId]; });
      });
    }
    out.push({ id: id, view: view });
  });
  return out;
}

// Drop all clone state (+ tabs) — new file / clear project.
function statResetInstances() {
  Object.keys(statInstances).forEach(function(id) {
    if (typeof wsRails !== 'undefined' && wsRails && typeof findTab === 'function' && findTab(wsRails.state, id)) {
      try { wsRails.closeTab(id); } catch (e) {}
    }
    statDisposeInstance(id);
  });
  statInstances = {}; statInstanceEls = {}; statInstSeq = 1;
}

// Recreate clone instances from a serialized list BEFORE the layout deserialize
// rebuilds their tabs (statBuildInstancePanel reads the seeded state). The view
// stays pending until statApplyAllInstances resolves names→indices post-analysis.
function statRestoreInstances(list) {
  statResetInstances();
  if (!Array.isArray(list)) return;
  var maxSeq = 1;
  list.forEach(function(rec) {
    if (!rec || !rec.id) return;
    var st = statNewInstState();
    if (rec.view) {
      st._pendingView = rec.view;
      st.statsTargetDsId = rec.view.targetDsId || 'model';   // ws-v2 phase 1: build on-target before the view resolves
    }
    statInstances[rec.id] = st;
    var m = /^statistics#(\d+)$/.exec(rec.id);
    if (m) maxSeq = Math.max(maxSeq, parseInt(m[1], 10));
  });
  statInstSeq = maxSeq;
}

// Resolve each restored clone's pending view against current headers. Model
// parts resolve once the model analysis lands; comparison parts resolve per-ds
// as each completes (called again from the comparison analysis-complete handler).
// Resolve-only — the caller pairs it with statRenderAllInstances to repaint.
function statApplyAllInstances() {
  if (!lastDisplayedStats || !lastDisplayedHeader) return;
  Object.keys(statInstances).forEach(function(id) {
    var S = statInstances[id], pv = S._pendingView;
    if (!pv) return;
    if ('percentiles' in pv) {                 // primary parts — resolve once the target's header exists
      // Header-independent fields apply immediately (idempotent if we retry).
      S.statsTargetDsId = pv.targetDsId || 'model';
      S.statsVisibleMetrics = pv.visibleMetrics ? new Set(pv.visibleMetrics) : null;
      S.statsPercentiles = pv.percentiles || [25, 50, 75];
      S.statsCdfScale = pv.cdfScale || 'linear';
      S.statsCdfMode = pv.cdfMode || 'cdf';
      S.dsHidden = new Set(pv.dsHidden || []);
      S.refDs = pv.refDs || null;
      // selectedVars/cdfSelected are indices into the TARGET → need its header.
      // For a comparison target not yet analyzed, keep the view pending; the
      // aux-complete handler re-runs this once that dataset lands.
      var tgtHdr = (S.statsTargetDsId !== 'model')
        ? (((dsById(S.statsTargetDsId) || {}).complete || {}).header)
        : lastDisplayedHeader;
      if (tgtHdr) {
        S.statsSelectedVars = pv.selectedVars ? statColSetFromNames(pv.selectedVars, tgtHdr) : null;
        S.statsCdfSelected = statColSetFromNames(pv.cdfSelected, tgtHdr);
        var rem = {};                          // keep only the comparison remainders pending
        if (pv.cmpSel && Object.keys(pv.cmpSel).length) rem.cmpSel = pv.cmpSel;
        if (pv.cdfCmpSel && Object.keys(pv.cdfCmpSel).length) rem.cdfCmpSel = pv.cdfCmpSel;
        S._pendingView = (rem.cmpSel || rem.cdfCmpSel) ? rem : null;
        pv = S._pendingView;
      } else {
        pv = null;                             // target unanalyzed — retry next pass (keep _pendingView intact)
      }
    }
    if (pv) ['cmpSel', 'cdfCmpSel'].forEach(function(k) {   // comparison parts, per-ds
      if (!pv[k]) return;
      var live = (k === 'cmpSel') ? S.cmpSel : S.cdfCmpSel;
      Object.keys(pv[k]).forEach(function(dsId) {
        var ds = dsById(dsId), dh = ds && ds.complete && ds.complete.header;
        if (!dh) return;
        live[dsId] = statColSetFromNames(pv[k][dsId], dh);
        delete pv[k][dsId];
      });
      if (Object.keys(pv[k]).length === 0) delete pv[k];
    });
    if (pv && !pv.cmpSel && !pv.cdfCmpSel) S._pendingView = null;
  });
}

function tdQuantileFromCentroids(centroids, totalCount, q) {
  if (!centroids || centroids.length === 0) return null;
  if (centroids.length === 1) return centroids[0][0];
  if (q <= 0) return centroids[0][0];
  if (q >= 1) return centroids[centroids.length - 1][0];
  var target = q * totalCount;
  var cumCount = 0;
  for (var i = 0; i < centroids.length; i++) {
    var mean = centroids[i][0], count = centroids[i][1];
    var lo = cumCount;
    var mid = lo + count / 2;
    if (target < mid) {
      if (i === 0) return mean;
      var prevMean = centroids[i - 1][0], prevCount = centroids[i - 1][1];
      var prevMid = lo - prevCount / 2;
      var t = (target - prevMid) / (mid - prevMid);
      return prevMean + t * (mean - prevMean);
    }
    cumCount += count;
  }
  return centroids[centroids.length - 1][0];
}

// A10 4c-ii / ws-v2 phase 1: comparison datasets the stats table iterates —
// every analyzed dataset EXCEPT the panel's primary (target), in registry order.
// With target 'model' this is datasets[1..] (bit-identical to before); with a
// comparison target the model itself becomes one of the comparison rows.
function statsCmpDatasets(root) {
  var tid = statsTargetDs(root).id;
  var out = [];
  for (var i = 0; i < datasets.length; i++) {
    var d = datasets[i];
    if (d.id === tid) continue;
    if (d && d.complete && d.complete.stats) out.push(d);
  }
  return out;
}

// The comparison datasets actually shown — the chips (4c, ≥2 comparison
// datasets) let the user hide any of them; the sidebar/table/CDF iterate this.
function statsShownCmpDatasets(root) {
  var hidden = statStateForRoot(root).dsHidden;
  return statsCmpDatasets(root).filter(function(ds) { return !hidden.has(ds.id); });
}

// A10 4d: the resolved Δ% reference dataset id for this panel. Defaults to the
// first SHOWN comparison dataset (samples) so the headline stays the
// model-vs-samples acceptance number; falls back to 'model' when no comparison
// is shown, and self-heals if the chosen reference was hidden/removed.
function statsReferenceDs(root) {
  var refDs = statStateForRoot(root).refDs;
  var shownCmp = statsShownCmpDatasets(root);
  // The panel's primary (target) is always a valid reference; default to the
  // first shown comparison (samples) so the model+aux case still reads
  // (model − samples)/samples. Self-heals if the chosen reference was hidden.
  var primaryId = statsTargetDs(root).id;
  var shown = [primaryId].concat(shownCmp.map(function(d) { return d.id; }));
  if (refDs && shown.indexOf(refDs) >= 0) return refDs;
  return shownCmp.length ? shownCmp[0].id : primaryId;
}

// The reference dataset's stats object for the property a primary column (ci)
// belongs to — ctx.stats[ci] when the primary IS the reference, else the
// reference dataset's grouped column. null when the reference has no counterpart.
function statsRefStatsFor(ci, refId, ctx) {
  if (refId === ctx.id) return (ctx.stats && ctx.stats[ci]) || null;
  var rds = dsById(refId);
  if (!rds || !rds.complete || !rds.complete.stats) return null;
  var cols = getStatsCmpCols(rds, ctx);
  for (var i = 0; i < cols.length; i++) {
    if (cols[i].matchCi === ci) return rds.complete.stats[cols[i].idx] || null;
  }
  return null;
}
// The reference column's display label for a property (for Δ% tooltips).
function statsRefLabelFor(ci, refId, ctx) {
  if (refId === ctx.id) return ctx.header[ci];
  var rds = dsById(refId);
  if (!rds || !rds.complete) return dsLabel(refId);
  var cols = getStatsCmpCols(rds, ctx);
  for (var i = 0; i < cols.length; i++) {
    if (cols[i].matchCi === ci) return dsLabel(refId) + ':' + cols[i].name;
  }
  return dsLabel(refId);
}

// Numeric columns of a comparison dataset, each grouped to the PRIMARY (ctx)
// column it shares a property with (catMemberIn → matchCi into the primary
// stats) when one exists. Selection defaults to "paired only" until the user
// materializes a choice. ws-v2 phase 1 inverts this off the hardwired model:
// the anchor is whatever dataset the panel targets.
function getStatsCmpCols(ds, ctx) {
  if (!ds || !ds.complete || !ds.complete.stats) return [];
  ctx = ctx || statsCtx();   // default: the model singleton is the primary anchor
  catEnsureSeeded();
  var primaryByName = {};
  var pHdr = ctx.header || [];
  for (var i = 0; i < ctx.numCols.length; i++) {
    var ci = ctx.numCols[i];
    primaryByName[pHdr[ci]] = ci;
  }
  var st = ds.complete.stats, hdr = ds.complete.header;
  var out = [];
  Object.keys(st).map(Number).sort(function(a, b) { return a - b; }).forEach(function(ai) {
    var name = hdr[ai];
    var p = catMemberIn(ds.id, name, ctx.id);   // the primary column in this column's property
    var m = p !== null ? primaryByName[p] : undefined;
    out.push({ idx: ai, name: name, matchCi: m !== undefined ? m : null });
  });
  return out;
}

function isStatsCmpSelected(ds, col, root) {
  var sel = statStateForRoot(root).cmpSel[ds.id];
  if (sel == null) return col.matchCi !== null;   // default: paired only
  return sel.has(col.idx);
}

function materializeStatsCmpSel(ds, root) {
  var S = statStateForRoot(root);
  if (S.cmpSel[ds.id]) return;
  var s = new Set();
  getStatsCmpCols(ds, statsCtx(root)).forEach(function(c) { if (c.matchCi !== null) s.add(c.idx); });
  S.cmpSel[ds.id] = s;
}

// Convert a project restore (variable names) to aux column indices — callable
// only once the aux analysis has produced a header. (Persistence covers the
// model + aux today; d2+ stats selection is ephemeral until A10 phase 6.)
function applyStatsAuxRestore() {
  if (!pendingStatsAuxRestore || !auxCompleteData) return;
  var byName = {};
  for (var i = 0; i < auxCompleteData.header.length; i++) byName[auxCompleteData.header[i]] = i;
  if (pendingStatsAuxRestore.selected) {
    var s = new Set();
    pendingStatsAuxRestore.selected.forEach(function(n) { if (byName[n] !== undefined) s.add(byName[n]); });
    panelState.statistics.cmpSel.aux = s;
  }
  if (pendingStatsAuxRestore.cdf) {
    var c = new Set();
    pendingStatsAuxRestore.cdf.forEach(function(n) { if (byName[n] !== undefined) c.add(byName[n]); });
    panelState.statistics.cdfCmpSel.aux = c;
  }
  pendingStatsAuxRestore = null;
}

// A10 4e-b: reattach a comparison dataset's table/CDF selection (stored by
// column NAME in project.panels) once its analysis header exists. aux keeps the
// legacy pendingStatsAuxRestore path above; this covers the instances (d2+).
// Runs from the shared aux/instance analysis-complete handler for the dataset
// that just finished; consumes only that dataset's entries, leaving the rest
// pending until they analyze (and re-emittable by serialize meanwhile).
function applyStatsCmpRestore(ds) {
  if (!ds || ds.id === 'aux' || !ds.complete) return;
  if (!pendingPanelState || !pendingPanelState.statistics) return;
  var hdr = ds.complete.header;
  var byName = {};
  for (var i = 0; i < hdr.length; i++) byName[hdr[i]] = i;
  var ps = pendingPanelState.statistics;
  function reattach(pendMap, liveMap) {
    if (!pendMap || !pendMap[ds.id]) return;
    var s = new Set();
    pendMap[ds.id].forEach(function(n) { if (byName[n] !== undefined) s.add(byName[n]); });
    liveMap[ds.id] = s;               // [] = explicit empty selection (not default)
    delete pendMap[ds.id];            // consumed
  }
  reattach(ps.cmpSel, panelState.statistics.cmpSel);
  reattach(ps.cdfCmpSel, panelState.statistics.cdfCmpSel);
}

function getStatsMetricColumns(root) {
  var pcts = statStateForRoot(root).statsPercentiles;
  var cols = [];
  for (var m of STATS_ALL_METRICS) {
    if (m.key === 'max') {
      for (var p of pcts) {
        cols.push({ key: 'p' + p, label: 'P' + p, pct: p });
      }
    }
    cols.push(m);
  }
  return cols;
}

function getStatValue(s, metric) {
  if (metric.pct !== undefined) {
    return tdQuantileFromCentroids(s.centroids, s.count, metric.pct / 100);
  }
  switch (metric.key) {
    case 'count': return s.count;
    case 'sumw': return s.sumW != null ? s.sumW : null;
    case 'nulls': return s.nulls;
    case 'parsefails': return s.parseFails || 0;
    case 'zeros': return s.zeros;
    case 'min': return s.min;
    case 'max': return s.max;
    case 'mean': return s.mean;
    case 'std': return s.std;
    case 'cv': return (s.mean && s.std && s.mean !== 0) ? Math.abs(s.std / s.mean * 100) : null;
    case 'skew': return s.skewness;
    case 'kurt': return s.kurtosis;
    default: return null;
  }
}

function formatStatValue(val, metric) {
  if (val === null || val === undefined) return '\u2014';
  if (metric.key === 'count' || metric.key === 'nulls' || metric.key === 'zeros' || metric.key === 'parsefails') {
    return val > 0 ? val.toLocaleString() : '\u2014';
  }
  if (metric.key === 'cv') return val.toFixed(1);
  if (metric.key === 'skew' || metric.key === 'kurt') return val.toFixed(2);
  return formatNum(val);
}

// Metrics where a relative % difference is meaningless (dataset-size counts)
// or unstable (moments with near-zero reference values)
var STATS_DELTA_SKIP = new Set(['count', 'sumw', 'nulls', 'parsefails', 'zeros', 'skew', 'kurt']);

function formatDeltaPct(p, a, metric) {
  if (STATS_DELTA_SKIP.has(metric.key)) return '—';
  if (p == null || a == null || !isFinite(p) || !isFinite(a) || a === 0) return '—';
  var d = (p - a) / Math.abs(a) * 100;
  if (!isFinite(d)) return '—';
  return (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(1) + '%';
}

// A8: ∅ tag for variables whose analysis produced zero valid values
function statsEmptyTag(ds, idx) {
  if (!colIsEmpty(ds, idx)) return '';
  return '<span class="empty-tag" title="' + EMPTY_COL_TITLE + '">∅</span>';
}

// A9 F2: ✱ tag for numeric variables with unparseable values (mixed-type)
function statsMixedTag(ds, idx) {
  var n = colParseFails(ds, idx);
  if (n === 0) return '';
  return '<span class="empty-tag mixed-tag" title="' + esc(mixedColTitle(n)) + '">✱</span>';
}

function isMetricVisible(key, root) {
  var vm = statStateForRoot(root).statsVisibleMetrics;
  if (vm === null) {
    if (key.startsWith('p') && key.length > 1 && !isNaN(key.slice(1))) return true;
    return STATS_DEFAULT_VISIBLE.has(key);
  }
  return vm.has(key);
}

function renderStatsTab(stats, header, origColCount, isFiltered, rowCount, root) {
  // The passed stats/header are always the MODEL snapshot (callers feed
  // lastDisplayedStats/Header). Keep mirroring them into the module globals \u2014
  // they're the model snapshot read by ctxmenu/cdf/settings, NOT the per-panel
  // primary. The actual rendering resolves through statsCtx(root) so a panel
  // targeting a comparison dataset shows that dataset's columns.
  lastDisplayedStats = stats;
  lastDisplayedHeader = header;
  _statsNumCols = stats ? Object.keys(stats).map(Number).sort(function(a, b) { return a - b; }) : [];
  _statsHeader = header;
  _statsOrigColCount = origColCount;
  var els = statEls(root);
  var ctx = statsCtx(root);

  els.badge.textContent = ctx.numCols.length + ' columns' + (ctx.isFiltered ? ' \u00B7 ' + ctx.rowCount.toLocaleString() + ' rows' : '');

  if (ctx.numCols.length === 0) {
    els.content.innerHTML = '<div style="color:var(--fg-dim);">No numeric columns detected.</div>';
    renderStatsDatasetPicker(root);   // still let the user switch primary
    els.sidebar.style.display = (statsTargetableDatasets().length >= 2) ? '' : 'none';
    return;
  }
  els.sidebar.style.display = '';

  renderStatsSidebar(root);
  renderStatsTable(root);
  renderStatsCdfPanel(root);

  if (!root && !_statsEventsWired) {
    wireStatsEvents();
    _statsEventsWired = true;
  }
}

function renderStatsSidebar(root) {
  var els = statEls(root);
  var S = statStateForRoot(root);
  var ctx = statsCtx(root);
  var numCols = ctx.numCols;
  var header = ctx.header || [];
  var origColCount = ctx.origColCount;

  // Dataset picker (≥2 analyzed datasets) — pick which one is the primary.
  renderStatsDatasetPicker(root);

  // Metric toggles
  var metrics = getStatsMetricColumns(root);
  var togglesHtml = '';
  for (var m of metrics) {
    var checked = isMetricVisible(m.key, root) ? ' checked' : '';
    togglesHtml += '<label class="stats-metric-toggle"><input type="checkbox" data-metric="' + m.key + '"' + checked + '> ' + esc(m.label) + '</label>';
  }
  els.metricToggles.innerHTML = togglesHtml;

  // Preset buttons state
  var presetBtns = els.presetBtns.querySelectorAll('.stats-preset');
  var currentPreset = null;
  for (var key in STATS_PRESETS) {
    var pre = STATS_PRESETS[key];
    if (pre.length === S.statsPercentiles.length && pre.every(function(v, i) { return v === S.statsPercentiles[i]; })) {
      currentPreset = key;
    }
  }
  presetBtns.forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.preset === currentPreset || (currentPreset === null && btn.dataset.preset === 'custom'));
  });
  var customInput = els.customPct;
  if (currentPreset === null || currentPreset === 'custom') {
    customInput.style.display = '';
    customInput.value = S.statsPercentiles.join(',');
  } else {
    customInput.style.display = 'none';
  }

  // Weight select — numeric variables (incl. calcols); one support weight
  // per dataset, shared with the Swath tab (catalog role, D3)
  var $wSel = els.weightSel;
  if ($wSel) {
    var curWeight = catRole(ctx.id, 'weight');
    var wOpts = '<option value="">— none</option>';
    for (var wci of numCols) {
      var wName = header[wci];
      wOpts += '<option value="' + esc(wName) + '"' + (wName === curWeight ? ' selected' : '') + '>' + esc(wName) + '</option>';
    }
    $wSel.innerHTML = wOpts;
    if (curWeight && $wSel.value !== curWeight) $wSel.value = '';
    var $wNote = els.weightNote;
    if ($wNote) {
      var noteParts = [];
      var cmp = ctx.complete;
      if (curWeight && cmp && cmp.weightApplied !== curWeight) noteParts.push('re-run analysis to apply');
      if (cmp && cmp.weightExcluded > 0) noteParts.push(cmp.weightExcluded.toLocaleString() + ' rows excluded (invalid weight)');
      $wNote.textContent = noteParts.join(' · ');
    }
  }

  // Variable list
  var search = els.varSearch.value.toLowerCase();
  var html = '';
  for (var ci of numCols) {
    var name = header[ci];
    if (search && !fuzzyMatch(search, name.toLowerCase())) continue;
    var isCalcol = ci >= origColCount;
    var selected = S.statsSelectedVars === null || S.statsSelectedVars.has(ci);
    var checkedAttr = selected ? ' checked' : '';
    var uncheckedCls = !selected ? ' unchecked' : '';
    html += '<div class="stats-var-item' + uncheckedCls + '" data-col="' + ci + '">';
    html += '<input type="checkbox"' + checkedAttr + ' data-col="' + ci + '">';
    html += '<span class="var-name">' + esc(name) + '</span>';
    if (isCalcol) html += '<span class="calcol-tag">CALC</span>';
    html += statsEmptyTag(ctx.id, ci) + statsMixedTag(ctx.id, ci);
    html += '</div>';
  }

  // Dataset chips (progressive disclosure) — only once a second comparison
  // dataset joins (3+ total), so the common primary+one-comparison case stays
  // uncluttered. The primary (target) is the non-hideable anchor chip.
  var dsSection = els.datasetsSection;
  if (dsSection) {
    var allCmp = statsCmpDatasets(root);
    if (allCmp.length >= 2) {
      // A10 4d: per-panel Δ% reference picker (the primary + each shown
      // comparison). Only here (≥2 comparisons) where the choice is ambiguous;
      // with a lone comparison the reference is unambiguously it (badged in the table).
      var refNow = statsReferenceDs(root);
      var primaryId = ctx.id;
      var refSel = '<div class="stats-ref-row"><span class="stats-ref-label" title="Δ% denominator — every other dataset is compared to this one">Δ% reference</span>' +
        '<select class="stats-select stats-ref-sel" data-stat="refSel">' +
        '<option value="' + esc(primaryId) + '"' + (refNow === primaryId ? ' selected' : '') + '>' + esc(dsLabel(primaryId)) + '</option>';
      statsShownCmpDatasets(root).forEach(function(ds) {
        refSel += '<option value="' + esc(ds.id) + '"' + (refNow === ds.id ? ' selected' : '') + '>' + esc(dsLabel(ds.id)) + '</option>';
      });
      refSel += '</select></div>';
      var chips = '<span class="stats-ds-chip stats-ds-chip--model" title="the primary dataset — toggle comparison chips to hide them">' + esc(dsLabel(primaryId)) + '</span>';
      allCmp.forEach(function(ds) {
        var off = S.dsHidden.has(ds.id);
        chips += '<button class="stats-ds-chip' + (off ? ' off' : '') + '" data-ds-chip="' + esc(ds.id) + '" aria-pressed="' + (off ? 'false' : 'true') + '" title="' + esc(off ? 'show ' : 'hide ') + esc(dsLabel(ds.id)) + '">' + esc(dsLabel(ds.id)) + '</button>';
      });
      els.datasetChips.innerHTML = refSel + '<div class="stats-ds-chip-row">' + chips + '</div>';
      dsSection.style.display = '';
    } else {
      dsSection.style.display = 'none';
    }
  }

  // Comparison-dataset variables (each shown dataset other than the primary)
  statsShownCmpDatasets(root).forEach(function(ds) {
    var cols = getStatsCmpCols(ds, ctx);
    if (cols.length === 0) return;
    var label = dsLabel(ds.id);
    html += '<div class="stats-aux-divider">' + esc(label) + ': ' + esc(ds.file ? ds.file.name : '') + '</div>';
    for (var k = 0; k < cols.length; k++) {
      var ac = cols[k];
      var dispName = label + ':' + ac.name;
      if (search && !fuzzyMatch(search, dispName.toLowerCase())) continue;
      var cmpSel = isStatsCmpSelected(ds, ac, root);
      html += '<div class="stats-var-item stats-var-item--aux' + (cmpSel ? '' : ' unchecked') + '" data-cmp-ds="' + esc(ds.id) + '" data-cmp-col="' + ac.idx + '">';
      html += '<input type="checkbox"' + (cmpSel ? ' checked' : '') + ' data-cmp-ds="' + esc(ds.id) + '" data-cmp-col="' + ac.idx + '">';
      html += '<span class="var-name">' + esc(dispName) + '</span>';
      html += statsEmptyTag(ds.id, ac.idx) + statsMixedTag(ds.id, ac.idx);
      html += '</div>';
    }
  });
  els.varList.innerHTML = html;
}

function renderStatsTable(root) {
  var els = statEls(root);
  var S = statStateForRoot(root);
  var ctx = statsCtx(root);
  var stats = ctx.stats;
  var header = ctx.header;
  if (!stats || !header) return;

  var numCols = ctx.numCols;
  var origColCount = ctx.origColCount;
  var metrics = getStatsMetricColumns(root).filter(function(m) { return isMetricVisible(m.key, root); });

  var visCols = numCols.filter(function(ci) {
    return S.statsSelectedVars === null || S.statsSelectedVars.has(ci);
  });

  // Selected comparison columns (across the other datasets), grouped to their
  // same-named PRIMARY column where the property pairs them. cmpByMatch keeps
  // registry order within a group, cmpUnmatched holds property-less columns.
  var cmpByMatch = {};
  var cmpUnmatched = [];
  var cmpDatasets = statsShownCmpDatasets(root);
  cmpDatasets.forEach(function(ds) {
    getStatsCmpCols(ds, ctx).forEach(function(col) {
      if (!isStatsCmpSelected(ds, col, root)) return;
      var member = { ds: ds, col: col };
      if (col.matchCi !== null) (cmpByMatch[col.matchCi] = cmpByMatch[col.matchCi] || []).push(member);
      else cmpUnmatched.push(member);
    });
  });
  var cmpCount = cmpUnmatched.length;
  Object.keys(cmpByMatch).forEach(function(k) { cmpCount += cmpByMatch[k].length; });

  // A10 4d: Δ% is computed against the panel's chosen reference dataset (the
  // denominator), not implicitly against each comparison. Default reference =
  // the first shown comparison (samples), so the common model+aux case still
  // reads (model − samples)/samples — just shown under the model (the subject)
  // with the reference row badged.
  var refId = statsReferenceDs(root);
  function statsRefBadge(isRef) {
    return isRef ? ' <span class="stats-ref-badge" title="Δ% reference — every other dataset\'s Δ% is relative to this one">ref</span>' : '';
  }
  // Δ% row for a subject (primary col ci identifies the property) vs the reference.
  // Empty when the subject IS the reference or the reference has no counterpart.
  function deltaRowFor(ci, subjectStats, subjectLabel) {
    if (ci === null || ci === undefined) return '';
    var refStats = statsRefStatsFor(ci, refId, ctx);
    if (!refStats || refStats === subjectStats) return '';
    var refLabel = statsRefLabelFor(ci, refId, ctx);
    var tip = '(' + subjectLabel + ' − ' + refLabel + ') / ' + refLabel;
    var rowHtml = '<tr class="stats-delta-row"><td title="' + esc(tip) + '">Δ%</td>';
    for (var m of metrics) rowHtml += '<td>' + formatDeltaPct(getStatValue(subjectStats, m), getStatValue(refStats, m), m) + '</td>';
    return rowHtml + '</tr>';
  }

  function cmpRowHtml(member) {
    var ds = member.ds, ac = member.col, label = dsLabel(ds.id);
    var as = ds.complete.stats[ac.idx];
    var cdfSet = S.cdfCmpSel[ds.id];
    var aCdfActive = !!(cdfSet && cdfSet.has(ac.idx));
    var aNameClass = aCdfActive ? 'cdf-link cdf-active' : 'cdf-link';
    var rowHtml = '<tr class="stats-aux-row"><td><a class="' + aNameClass + '" data-cmp-ds="' + esc(ds.id) + '" data-cmp-col="' + ac.idx + '" href="#">' + esc(label + ':' + ac.name) + '</a>' + statsRefBadge(ds.id === refId) + statsEmptyTag(ds.id, ac.idx) + statsMixedTag(ds.id, ac.idx) + '</td>';
    for (var m of metrics) rowHtml += '<td>' + formatStatValue(getStatValue(as, m), m) + '</td>';
    return rowHtml + '</tr>' + deltaRowFor(ac.matchCi, as, label + ':' + ac.name);
  }

  if (visCols.length === 0 && cmpCount === 0) {
    els.content.innerHTML = '<div style="color:var(--fg-dim);padding:1rem;">No variables selected.</div>';
    return;
  }

  // A9 F3: per-row filter/calcol errors from the primary and comparison analyses
  var html = workerErrNote(ctx.complete, ctx.isModel ? undefined : dsLabel(ctx.id));
  cmpDatasets.forEach(function(ds) { html += workerErrNote(ds.complete, dsLabel(ds.id)); });
  html += '<table class="stats"><thead><tr><th>Column</th>';
  for (var m of metrics) html += '<th>' + esc(m.label) + '</th>';
  html += '</tr></thead><tbody>';

  for (var ci of visCols) {
    var s = stats[ci];
    var isCalcol = ci >= origColCount;
    var cdfActive = S.statsCdfSelected.has(ci);
    var nameClass = cdfActive ? 'cdf-link cdf-active' : 'cdf-link';
    var nameHtml = '<a class="' + nameClass + '" data-col="' + ci + '" href="#">' + esc(header[ci]) + '</a>';
    if (isCalcol) nameHtml += '<span class="calcol-tag">CALC</span>';
    nameHtml += statsRefBadge(refId === ctx.id) + statsEmptyTag(ctx.id, ci) + statsMixedTag(ctx.id, ci);

    html += '<tr' + (isCalcol ? ' class="calcol-row"' : '') + '><td>' + nameHtml + '</td>';
    for (var m of metrics) {
      var val = getStatValue(s, m);
      html += '<td>' + formatStatValue(val, m) + '</td>';
    }
    html += '</tr>';
    // Δ% of the primary vs the reference (when the primary isn't itself the reference)
    html += deltaRowFor(ci, s, header[ci]);
    // Same-named comparison rows directly beneath their primary
    if (cmpByMatch[ci]) {
      for (var am = 0; am < cmpByMatch[ci].length; am++) html += cmpRowHtml(cmpByMatch[ci][am]);
    }
  }
  // Matched comparison rows whose primary is deselected still render, at the end
  var visSet = new Set(visCols);
  Object.keys(cmpByMatch).forEach(function(ciKey) {
    if (!visSet.has(parseInt(ciKey))) {
      cmpByMatch[ciKey].forEach(function(member) { html += cmpRowHtml(member); });
    }
  });
  // Comparison variables with no model counterpart
  for (var au = 0; au < cmpUnmatched.length; au++) html += cmpRowHtml(cmpUnmatched[au]);

  html += '</tbody></table>';
  els.content.innerHTML = html;
}

function renderStatsCdfPanel(root) {
  var els = statEls(root);
  var S = statStateForRoot(root);
  var chart = els.cdfChart;
  if (!chart) return;

  var anyCmpCdf = statsShownCmpDatasets(root).some(function(ds) {
    var s = S.cdfCmpSel[ds.id]; return s && s.size > 0;
  });
  if (S.statsCdfSelected.size === 0 && !anyCmpCdf) {
    chart.innerHTML = '<div class="stats-cdf-hint">Click column names to add CDF curves</div>';
    return;
  }

  var ctx = statsCtx(root);
  var stats = ctx.stats;
  var header = ctx.header;
  if (!stats || !header) return;

  // Selected variables with no centroid data (empty column, everything
  // filtered) are listed in a note instead of silently vanishing (A8)
  var entries = [];
  var skipped = [];
  S.statsCdfSelected.forEach(function(ci) {
    if (stats[ci] && stats[ci].centroids && stats[ci].centroids.length > 0) {
      entries.push([header[ci], stats[ci]]);
    } else {
      skipped.push(header[ci]);
    }
  });
  statsShownCmpDatasets(root).forEach(function(ds) {
    var cdfSet = S.cdfCmpSel[ds.id];
    if (!cdfSet || cdfSet.size === 0) return;
    var label = dsLabel(ds.id), cs = ds.complete.stats, ch = ds.complete.header;
    cdfSet.forEach(function(ai) {
      var as = cs[ai];
      if (as && as.centroids && as.centroids.length > 0) {
        entries.push([label + ':' + ch[ai], as, true]); // [2]=comparison → dashed
      } else {
        skipped.push(label + ':' + ch[ai]);
      }
    });
  });

  var note = skipped.length > 0
    ? '<div class="warn-note">No data for ' + skipped.map(esc).join(', ') +
      ' — column empty or every value filtered out.</div>'
    : '';

  if (entries.length === 0) {
    chart.innerHTML = note || '<div class="stats-cdf-hint">No centroid data for selected columns</div>';
    return;
  }

  if (S.statsCdfMode === 'qq') {
    if (entries.length < 2) {
      chart.innerHTML = note + '<div class="stats-cdf-hint">Q–Q needs two curves — click another variable name (the first selected is the reference axis)</div>';
    } else {
      chart.innerHTML = note + renderStatsQqSvg(entries, root);
    }
  } else {
    chart.innerHTML = note + renderStatsCdfSvg(entries, root);
    wireStatsCdfTooltip(root);
  }

  // Update toolbar buttons
  els.cdfToolbar.querySelectorAll('.stats-scale').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.scale === S.statsCdfScale);
  });
  els.cdfToolbar.querySelectorAll('.stats-cdfmode').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.cdfmode === S.statsCdfMode);
  });
}

// Quantile–quantile plot: the first selected curve is the reference (X);
// every other curve plots its quantiles against the reference's at matched
// percentiles. Bias reads as offset from the 45° identity line; support
// smoothing as slope rotation. The classic model-vs-samples companion to
// the CDF overlay.
function renderStatsQqSvg(entries, root) {
  var isLog = statStateForRoot(root).statsCdfScale === 'log';
  var W = chartHostWidth(statEls(root).cdfChart, 700), plotBaseH = 420;
  var pad = { top: 20, right: 30, bottom: 64, left: 70 };
  var plotW = W - pad.left - pad.right;
  var plotH = plotBaseH - pad.top - pad.bottom;

  var legCols = 3;
  var legRowH = 16;
  var legRows = Math.ceil((entries.length - 1) / legCols);
  var legendH = 12 + legRows * legRowH + 6;
  var H = plotBaseH + legendH;

  // Quantile pairs at P1..P99
  var ref = entries[0];
  var qs = [];
  for (var p = 1; p <= 99; p++) qs.push(p / 100);
  var refQ = qs.map(function(q) { return tdQuantileFromCentroids(ref[1].centroids, ref[1].count, q); });

  var series = [];
  for (var si = 1; si < entries.length; si++) {
    var e = entries[si];
    series.push({
      name: e[0],
      isAux: !!e[2],
      color: STATSCAT_PALETTE[si % STATSCAT_PALETTE.length],
      q: qs.map(function(q) { return tdQuantileFromCentroids(e[1].centroids, e[1].count, q); })
    });
  }

  // Shared square range over everything plotted (identity line must be 45°)
  var lo = Infinity, hi = -Infinity;
  function take(v) { if (v == null) return; if (isLog && v <= 0) return; if (v < lo) lo = v; if (v > hi) hi = v; }
  refQ.forEach(take);
  series.forEach(function(s) { s.q.forEach(take); });
  if (!isFinite(lo) || !isFinite(hi)) return '<div class="stats-cdf-hint">No plottable quantiles' + (isLog ? ' (log scale needs positive values)' : '') + '</div>';
  if (hi <= lo) hi = lo + 1;
  var pad5 = isLog ? 0 : (hi - lo) * 0.05;
  lo -= pad5; hi += pad5;
  var lLo = isLog ? Math.log10(Math.max(lo, 1e-10)) : 0;
  var lHi = isLog ? Math.log10(Math.max(hi, 1e-9)) : 0;
  if (isLog && lHi <= lLo) lHi = lLo + 1;

  function sx(v) {
    if (isLog) return pad.left + ((Math.log10(Math.max(v, 1e-10)) - lLo) / (lHi - lLo)) * plotW;
    return pad.left + ((v - lo) / (hi - lo)) * plotW;
  }
  function sy(v) {
    if (isLog) return pad.top + plotH - ((Math.log10(Math.max(v, 1e-10)) - lLo) / (lHi - lLo)) * plotH;
    return pad.top + plotH - ((v - lo) / (hi - lo)) * plotH;
  }

  // Grid + ticks (same values both axes — the plot is square by construction)
  var gridSvg = '';
  var nTicks = 6;
  for (var ti = 0; ti <= nTicks; ti++) {
    var v = isLog ? Math.pow(10, lLo + ((lHi - lLo) * ti / nTicks)) : (lo + ((hi - lo) * ti / nTicks));
    var label = Math.abs(v) >= 1e5 || (Math.abs(v) < 0.01 && v !== 0) ? v.toExponential(1) : v.toFixed(Math.abs(v) < 10 ? 2 : 0);
    var x = sx(v), y = sy(v);
    gridSvg += '<line x1="' + x.toFixed(1) + '" y1="' + pad.top + '" x2="' + x.toFixed(1) + '" y2="' + (pad.top + plotH) + '" stroke="var(--chart-grid)" stroke-width="1"/>';
    gridSvg += '<text x="' + x.toFixed(1) + '" y="' + (pad.top + plotH + 16) + '" text-anchor="middle" fill="var(--chart-ink)" font-size="10">' + label + '</text>';
    gridSvg += '<line x1="' + pad.left + '" y1="' + y.toFixed(1) + '" x2="' + (pad.left + plotW) + '" y2="' + y.toFixed(1) + '" stroke="var(--chart-grid)" stroke-width="1"/>';
    gridSvg += '<text x="' + (pad.left - 8) + '" y="' + (y + 3.5).toFixed(1) + '" text-anchor="end" fill="var(--chart-ink)" font-size="10">' + label + '</text>';
  }

  // 45° identity line
  var idSvg = '<line x1="' + sx(isLog ? Math.pow(10, lLo) : lo) + '" y1="' + sy(isLog ? Math.pow(10, lLo) : lo) +
    '" x2="' + sx(isLog ? Math.pow(10, lHi) : hi) + '" y2="' + sy(isLog ? Math.pow(10, lHi) : hi) +
    '" stroke="var(--chart-ink)" stroke-width="1" stroke-dasharray="5,4" opacity="0.7"/>';

  // Points — emphasized deciles, native <title> tooltips
  var ptsSvg = '';
  series.forEach(function(s) {
    for (var i = 0; i < qs.length; i++) {
      var xv = refQ[i], yv = s.q[i];
      if (xv == null || yv == null) continue;
      if (isLog && (xv <= 0 || yv <= 0)) continue;
      var isDecile = ((i + 1) % 10) === 0 || i === 49;
      var r = isDecile ? 3.4 : 2;
      var fill = s.isAux ? 'none' : s.color;
      var stroke = s.isAux ? ' stroke="' + s.color + '" stroke-width="1.2"' : '';
      ptsSvg += '<circle cx="' + sx(xv).toFixed(1) + '" cy="' + sy(yv).toFixed(1) + '" r="' + r + '" fill="' + fill + '"' + stroke + ' opacity="0.85">' +
        '<title>P' + (i + 1) + ' — ' + esc(entries[0][0]) + ': ' + formatNum(xv) + ' · ' + esc(s.name) + ': ' + formatNum(yv) + '</title></circle>';
    }
  });

  // Legend (series only; reference is the X axis)
  var legTop = plotBaseH + 12;
  var colW = plotW / legCols;
  var legendSvg = '';
  series.forEach(function(s, li) {
    var col = li % legCols;
    var row = Math.floor(li / legCols);
    var lx = pad.left + col * colW;
    var ly = legTop + row * legRowH;
    legendSvg += s.isAux
      ? '<circle cx="' + (lx + 6) + '" cy="' + (ly + 5) + '" r="3.4" fill="none" stroke="' + s.color + '" stroke-width="1.4"/>'
      : '<circle cx="' + (lx + 6) + '" cy="' + (ly + 5) + '" r="3.4" fill="' + s.color + '"/>';
    legendSvg += '<text x="' + (lx + 16) + '" y="' + (ly + 9) + '" fill="var(--chart-ink)" font-size="9.5">' + esc(s.name) + '</text>';
  });

  var scaleLabel = isLog ? ' (log–log)' : '';
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" style="font-family:var(--mono)" id="statsCdfSvg">' +
    '<rect width="' + W + '" height="' + H + '" fill="var(--bg)" rx="4"/>' +
    gridSvg + idSvg + ptsSvg +
    '<text x="' + (W / 2) + '" y="' + (plotBaseH - 18) + '" text-anchor="middle" fill="var(--chart-ink)" font-size="10">' + esc(entries[0][0]) + ' quantiles' + scaleLabel + '</text>' +
    '<text x="14" y="' + (pad.top + plotH / 2) + '" text-anchor="middle" fill="var(--chart-ink)" font-size="10" transform="rotate(-90, 14, ' + (pad.top + plotH / 2) + ')">compared quantiles</text>' +
    '<text x="' + (W / 2) + '" y="' + (plotBaseH - 4) + '" text-anchor="middle" fill="var(--chart-ink)" font-size="9" opacity="0.7">P1–P99 · large dots at deciles · dashed = identity (no bias)</text>' +
    legendSvg +
    '</svg>';
}

// Inverse standard normal CDF — GSLIB gauinv (Kennedy & Gentle 1980, p.95),
// f64 throughout. Drives the probability-scale axis of the log-prob plot.
function normInv(p) {
  var lim = 1e-10;
  if (p < lim) return -1e10;
  if (p > 1 - lim) return 1e10;
  if (p === 0.5) return 0;
  var pp = p > 0.5 ? 1 - p : p;
  var y = Math.sqrt(Math.log(1 / (pp * pp)));
  var xp = y + ((((y * -0.0000453642210148 + -0.0204231210245) * y + -0.342242088547) * y + -1.0) * y + -0.322232431088) /
               ((((y * 0.0038560700634 + 0.103537752850) * y + 0.531103462366) * y + 0.588581570495) * y + 0.0993484626060);
  return p === pp ? -xp : xp;
}

// The classic probability-paper ruling (0.2%–99.8%, deciles emphasized in
// validation figures); the axis spans normInv of the extremes
var STATS_LOGPROB_TICKS = [0.002, 0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99, 0.998];

function renderStatsCdfSvg(entries, root) {
  var S = statStateForRoot(root);
  var isLog = S.statsCdfScale === 'log';
  var probScale = S.statsCdfMode === 'logprob';
  var W = chartHostWidth(statEls(root).cdfChart, 700), plotBaseH = 380;
  var pad = { top: 20, right: 30, bottom: 50, left: 60 };
  var plotW = W - pad.left - pad.right;
  var plotH = plotBaseH - pad.top - pad.bottom;
  var zLo = normInv(STATS_LOGPROB_TICKS[0]);
  var zHi = normInv(STATS_LOGPROB_TICKS[STATS_LOGPROB_TICKS.length - 1]);

  var legCols = 3;
  var legRowH = 16;
  var legPadTop = 12;
  var legRows = Math.ceil(entries.length / legCols);
  var legendH = legPadTop + legRows * legRowH + 6;
  var H = plotBaseH + legendH;

  var globalMin = Infinity, globalMax = -Infinity;
  for (var ei = 0; ei < entries.length; ei++) {
    var s = entries[ei][1];
    if (s.min < globalMin) globalMin = s.min;
    if (s.max > globalMax) globalMax = s.max;
  }

  var logMin, logMax;
  if (isLog) {
    logMin = Math.log10(Math.max(globalMin, 1e-10));
    logMax = Math.log10(Math.max(globalMax, 1e-9));
    if (logMax <= logMin) logMax = logMin + 1;
  }
  var xRange = isLog ? (logMax - logMin) : (globalMax - globalMin || 1);

  function sx(v) {
    if (isLog) {
      var lv = Math.log10(Math.max(v, 1e-10));
      return pad.left + ((lv - logMin) / xRange) * plotW;
    }
    return pad.left + ((v - globalMin) / xRange) * plotW;
  }
  function sy(v) {
    if (probScale) {
      var z = normInv(Math.min(Math.max(v, STATS_LOGPROB_TICKS[0]), STATS_LOGPROB_TICKS[STATS_LOGPROB_TICKS.length - 1]));
      return pad.top + (1 - (z - zLo) / (zHi - zLo)) * plotH;
    }
    return pad.top + (1 - v) * plotH;
  }

  var yTicks = probScale ? STATS_LOGPROB_TICKS : [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0];
  var gridSvg = '';
  for (var yi = 0; yi < yTicks.length; yi++) {
    var yt = yTicks[yi];
    var y = sy(yt);
    var ytLabel = probScale
      ? (yt * 100 < 1 || yt * 100 > 99 ? (yt * 100).toFixed(1) : (yt * 100).toFixed(0))
      : (yt * 100).toFixed(0);
    gridSvg += '<line x1="' + pad.left + '" y1="' + y + '" x2="' + (W - pad.right) + '" y2="' + y + '" stroke="var(--chart-grid)" stroke-width="1"/>';
    gridSvg += '<text x="' + (pad.left - 8) + '" y="' + (y + 3.5) + '" text-anchor="end" fill="var(--chart-ink)" font-size="10">' + ytLabel + '%</text>';
  }
  var nxTicks = 6;
  for (var xi = 0; xi <= nxTicks; xi++) {
    var v;
    if (isLog) {
      v = Math.pow(10, logMin + (xRange * xi / nxTicks));
    } else {
      v = globalMin + ((globalMax - globalMin || 1) * xi / nxTicks);
    }
    var x = sx(v);
    gridSvg += '<line x1="' + x + '" y1="' + pad.top + '" x2="' + x + '" y2="' + (plotBaseH - pad.bottom) + '" stroke="var(--chart-grid)" stroke-width="1"/>';
    var label = Math.abs(v) >= 1e5 || (Math.abs(v) < 0.01 && v !== 0) ? v.toExponential(1) : v.toFixed(Math.abs(v) < 10 ? 2 : 0);
    gridSvg += '<text x="' + x + '" y="' + (plotBaseH - pad.bottom + 16) + '" text-anchor="middle" fill="var(--chart-ink)" font-size="10">' + label + '</text>';
  }

  var curvesSvg = '';
  var meansSvg = '';
  for (var gi = 0; gi < entries.length; gi++) {
    var eName = entries[gi][0], eStats = entries[gi][1];
    var color = STATSCAT_PALETTE[gi % STATSCAT_PALETTE.length];
    var points = [];
    var cumCount = 0;
    for (var ci = 0; ci < eStats.centroids.length; ci++) {
      var cMean = eStats.centroids[ci][0], cCount = eStats.centroids[ci][1];
      if (isLog && cMean <= 0) { cumCount += cCount; continue; }
      cumCount += cCount;
      var cumP = cumCount / eStats.count;
      // Probability paper has no 0%/100% — points beyond the ruling are off-scale
      if (probScale && (cumP < STATS_LOGPROB_TICKS[0] || cumP > STATS_LOGPROB_TICKS[STATS_LOGPROB_TICKS.length - 1])) continue;
      var px = sx(cMean);
      if (px < pad.left || px > W - pad.right) continue;
      points.push({ x: px, y: sy(cumP) });
    }
    if (points.length > 0) {
      var pathParts = points.map(function(p, i) { return (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1); });
      var dash = entries[gi][2] ? ' stroke-dasharray="6,4"' : '';
      curvesSvg += '<path d="' + pathParts.join(' ') + '" fill="none" stroke="' + color + '" stroke-width="1.5" opacity="0.85"' + dash + '/>';
    }
    if (eStats.mean !== null && (!isLog || eStats.mean > 0)) {
      var mx = sx(eStats.mean);
      if (mx >= pad.left && mx <= W - pad.right) {
        meansSvg += '<line x1="' + mx + '" y1="' + pad.top + '" x2="' + mx + '" y2="' + (plotBaseH - pad.bottom) + '" stroke="' + color + '" stroke-width="1" stroke-dasharray="4,3" opacity="0.5"/>';
      }
    }
  }

  var legTop = plotBaseH + legPadTop;
  var colW = (W - pad.left - pad.right) / legCols;
  var legendSvg = '';
  for (var li = 0; li < entries.length; li++) {
    var lName = entries[li][0];
    var lColor = STATSCAT_PALETTE[li % STATSCAT_PALETTE.length];
    var col = li % legCols;
    var row = Math.floor(li / legCols);
    var lx = pad.left + col * colW;
    var ly = legTop + row * legRowH;
    legendSvg += '<line x1="' + lx + '" y1="' + (ly + 5) + '" x2="' + (lx + 18) + '" y2="' + (ly + 5) + '" stroke="' + lColor + '" stroke-width="2.5"' + (entries[li][2] ? ' stroke-dasharray="4,3"' : '') + '/>';
    legendSvg += '<text x="' + (lx + 24) + '" y="' + (ly + 9) + '" fill="var(--chart-ink)" font-size="9.5">' + esc(lName) + '</text>';
  }

  // Store params for tooltip interaction
  S._statsCdfParams = {
    entries: entries, isLog: isLog,
    probScale: probScale, zLo: zLo, zHi: zHi,
    globalMin: globalMin, globalMax: globalMax,
    logMin: isLog ? logMin : 0, logMax: isLog ? logMax : 0,
    xRange: xRange, pad: pad, plotW: plotW, plotH: plotH,
    W: W, plotBaseH: plotBaseH
  };

  // Overlay elements for tooltip interaction
  var overlaySvg = '<line id="statsCdfCrosshair" x1="0" y1="' + pad.top + '" x2="0" y2="' + (plotBaseH - pad.bottom) + '" stroke="var(--action)" stroke-width="1" stroke-dasharray="3,2" visibility="hidden"/>';
  for (var di = 0; di < entries.length; di++) {
    var dColor = STATSCAT_PALETTE[di % STATSCAT_PALETTE.length];
    overlaySvg += '<circle class="cdf-dot" data-idx="' + di + '" cx="0" cy="0" r="3.5" fill="' + dColor + '" stroke="var(--bg)" stroke-width="1" visibility="hidden"/>';
  }
  overlaySvg += '<rect x="' + pad.left + '" y="' + pad.top + '" width="' + plotW + '" height="' + plotH + '" fill="transparent" id="statsCdfOverlay" style="cursor:crosshair"/>';

  var scaleLabel = isLog ? ' (log)' : '';
  var titleLabel = probScale ? (isLog ? 'Log-probability' : 'Probability' + scaleLabel) : 'CDF' + scaleLabel;
  var yAxisLabel = probScale ? 'Cumulative % (normal probability scale)' : 'Cumulative %';
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" style="font-family:var(--mono)" id="statsCdfSvg">' +
    '<rect width="' + W + '" height="' + H + '" fill="var(--bg)" rx="4"/>' +
    gridSvg + meansSvg + curvesSvg + overlaySvg +
    '<text x="' + (W / 2) + '" y="' + (plotBaseH - 4) + '" text-anchor="middle" fill="var(--chart-ink)" font-size="10">' + titleLabel + '</text>' +
    '<text x="12" y="' + (plotBaseH / 2) + '" text-anchor="middle" fill="var(--chart-ink)" font-size="10" transform="rotate(-90, 12, ' + (plotBaseH / 2) + ')">' + yAxisLabel + '</text>' +
    legendSvg +
    '</svg>';
}

// CDF tooltip: interpolate cumulative % at a given value
function getCdfAtValue(centroids, totalCount, value, isLog) {
  if (!centroids || centroids.length === 0) return null;
  var pts = [];
  var cum = 0;
  for (var i = 0; i < centroids.length; i++) {
    var m = centroids[i][0], c = centroids[i][1];
    if (isLog && m <= 0) { cum += c; continue; }
    cum += c;
    pts.push([m, cum / totalCount]);
  }
  if (pts.length === 0) return null;
  if (value <= pts[0][0]) return 0;
  if (value >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (var i = 1; i < pts.length; i++) {
    if (value <= pts[i][0]) {
      var t = (value - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]);
      return pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1]);
    }
  }
  return pts[pts.length - 1][1];
}

function wireStatsCdfTooltip(root) {
  var chart = statEls(root).cdfChart;
  var svg = chart ? chart.querySelector('#statsCdfSvg') : null;
  var overlay = chart ? chart.querySelector('#statsCdfOverlay') : null;
  var params = statStateForRoot(root)._statsCdfParams;
  if (!svg || !overlay || !params) return;

  var p = params;
  var crosshair = chart.querySelector('#statsCdfCrosshair');
  var dots = svg.querySelectorAll('.cdf-dot');

  // Create or reuse tooltip div
  var tip = chart.querySelector('.stats-cdf-tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'stats-cdf-tooltip';
    chart.appendChild(tip);
  }
  tip.style.display = 'none';

  function svgXFromMouse(e) {
    var pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse()).x;
  }

  function valueFromSvgX(svgX) {
    var frac = (svgX - p.pad.left) / p.plotW;
    if (p.isLog) return Math.pow(10, p.logMin + frac * p.xRange);
    return p.globalMin + frac * (p.globalMax - p.globalMin || 1);
  }

  function syFromCdf(cdf) {
    if (p.probScale) {
      var lo = STATS_LOGPROB_TICKS[0], hi = STATS_LOGPROB_TICKS[STATS_LOGPROB_TICKS.length - 1];
      var z = normInv(Math.min(Math.max(cdf, lo), hi));
      return p.pad.top + (1 - (z - p.zLo) / (p.zHi - p.zLo)) * p.plotH;
    }
    return p.pad.top + (1 - cdf) * p.plotH;
  }

  overlay.addEventListener('pointermove', function(e) {
    var svgX = svgXFromMouse(e);
    var value = valueFromSvgX(svgX);

    // Position crosshair
    crosshair.setAttribute('x1', svgX);
    crosshair.setAttribute('x2', svgX);
    crosshair.setAttribute('visibility', 'visible');

    // Build tooltip content and position dots
    var label = Math.abs(value) >= 1e5 || (Math.abs(value) < 0.01 && value !== 0)
      ? value.toExponential(2) : formatNum(value);
    var lines = '<div style="color:var(--fg-dim);margin-bottom:3px">' + esc(String(label)) + '</div>';

    for (var i = 0; i < p.entries.length; i++) {
      var eName = p.entries[i][0], eStats = p.entries[i][1];
      var color = STATSCAT_PALETTE[i % STATSCAT_PALETTE.length];
      var cdf = getCdfAtValue(eStats.centroids, eStats.count, value, p.isLog);
      if (cdf !== null) {
        var dotY = syFromCdf(cdf);
        dots[i].setAttribute('cx', svgX);
        dots[i].setAttribute('cy', dotY);
        dots[i].setAttribute('visibility', 'visible');
        var pctTxt = (p.probScale && (cdf * 100 < 1 || cdf * 100 > 99)) ? (cdf * 100).toFixed(2) : (cdf * 100).toFixed(1);
        lines += '<div><span style="color:' + color + '">\u25CF</span> ' + esc(eName) + ': ' + pctTxt + '%</div>';
      } else {
        dots[i].setAttribute('visibility', 'hidden');
      }
    }
    tip.innerHTML = lines;
    tip.style.display = '';

    // Position tooltip relative to chart container
    var chartRect = chart.getBoundingClientRect();
    var svgRect = svg.getBoundingClientRect();
    var mouseXInChart = e.clientX - chartRect.left;
    var mouseYInChart = e.clientY - chartRect.top;
    var tipW = tip.offsetWidth;
    // Flip to left side if near right edge
    var xOff = mouseXInChart + 16 + tipW > chartRect.width ? -tipW - 12 : 16;
    tip.style.left = (mouseXInChart + xOff) + 'px';
    tip.style.top = (mouseYInChart - 20) + 'px';
  });

  overlay.addEventListener('pointerleave', function() {
    crosshair.setAttribute('visibility', 'hidden');
    for (var i = 0; i < dots.length; i++) dots[i].setAttribute('visibility', 'hidden');
    tip.style.display = 'none';
  });
}

// Wire all events using delegation — survives innerHTML rebuilds. st-3: scoped
// to a per-instance root (els = statEls(root), state via statStateForRoot(root)),
// so a clone (st-4) wires its own controls + writes its own state. The singleton
// calls it once (renderStatsTab's _statsEventsWired gate); each clone calls it
// once at build. Cross-tab/global side effects (model weight role, swathWeight
// mirror, markAnalysisStale) stay global — they're shared model state.
function wireStatsEvents(root) {
  var els = statEls(root);
  var S = statStateForRoot(root);

  // --- Preset buttons ---
  els.presetBtns.addEventListener('click', function(e) {
    var btn = e.target.closest('.stats-preset');
    if (!btn) return;
    var preset = btn.dataset.preset;
    if (preset === 'custom') {
      els.customPct.style.display = '';
      els.presetBtns.querySelectorAll('.stats-preset').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      els.customPct.focus();
    } else if (STATS_PRESETS[preset]) {
      S.statsPercentiles = STATS_PRESETS[preset].slice();
      renderStatsSidebar(root);
      renderStatsTable(root);
      autoSaveProject();
    }
  });

  // --- Custom percentile input ---
  els.customPct.addEventListener('change', function() {
    var parts = els.customPct.value.split(',').map(function(s) { return parseInt(s.trim()); }).filter(function(n) { return !isNaN(n) && n >= 1 && n <= 99; });
    if (parts.length > 0) {
      parts.sort(function(a, b) { return a - b; });
      S.statsPercentiles = parts.filter(function(v, i, arr) { return i === 0 || v !== arr[i - 1]; });
      renderStatsSidebar(root);
      renderStatsTable(root);
      autoSaveProject();
    }
  });

  // --- Weight select ---
  // Shared support weight (D3): writing here also re-points the Swath
  // tab's weight select — one role, two views (global; model state)
  els.weightSel.addEventListener('change', function() {
    var ctx = statsCtx(root);
    catSetRole(ctx.id, 'weight', this.value || null);
    if (ctx.isModel) {
      // One support weight per dataset; the model's mirrors the Swath select.
      var $sw = document.getElementById('swathWeight');
      if ($sw) $sw.value = this.value || '';
      markAnalysisStale();
    } else if (typeof markAuxStale === 'function') {
      markAuxStale(ctx.ds, (typeof dsConfigRoot === 'function') ? dsConfigRoot(ctx.ds) : null);
    }
    renderStatsSidebar(root);
    autoSaveProject();
  });

  // --- Metric toggles (delegation on container — innerHTML changes) ---
  els.metricToggles.addEventListener('change', function(e) {
    var cb = e.target.closest('input[data-metric]');
    if (!cb) return;
    if (S.statsVisibleMetrics === null) {
      S.statsVisibleMetrics = new Set();
      var allMetrics = getStatsMetricColumns(root);
      for (var m of allMetrics) {
        if (isMetricVisible(m.key, root)) S.statsVisibleMetrics.add(m.key);
      }
    }
    if (cb.checked) S.statsVisibleMetrics.add(cb.dataset.metric);
    else S.statsVisibleMetrics.delete(cb.dataset.metric);
    renderStatsTable(root);
    autoSaveProject();
  });

  // --- Dataset chips (4c progressive disclosure) ---
  var $dsChips = els.datasetChips;
  if ($dsChips) $dsChips.addEventListener('click', function(e) {
    var b = e.target.closest('[data-ds-chip]');
    if (!b) return;
    var id = b.dataset.dsChip;
    if (S.dsHidden.has(id)) S.dsHidden.delete(id);
    else S.dsHidden.add(id);
    renderStatsSidebar(root);
    renderStatsTable(root);
    renderStatsCdfPanel(root);
    autoSaveProject();
  });
  // --- Δ% reference picker (4d; same container; detect by data-stat, no id) ---
  if ($dsChips) $dsChips.addEventListener('change', function(e) {
    if (!e.target.getAttribute || e.target.getAttribute('data-stat') !== 'refSel') return;
    S.refDs = e.target.value || null;
    renderStatsTable(root);
    autoSaveProject();
  });

  // --- Variable checkboxes (delegation on container — innerHTML changes) ---
  els.varList.addEventListener('change', function(e) {
    var acb = e.target.closest('input[data-cmp-col]');
    if (acb) {
      var cds = dsById(acb.dataset.cmpDs);
      if (cds) {
        materializeStatsCmpSel(cds, root);
        var aIdx = parseInt(acb.dataset.cmpCol);
        if (acb.checked) S.cmpSel[cds.id].add(aIdx);
        else S.cmpSel[cds.id].delete(aIdx);
        var aItem = acb.closest('.stats-var-item');
        if (aItem) aItem.classList.toggle('unchecked', !acb.checked);
        renderStatsTable(root);
        autoSaveProject();
      }
      return;
    }
    var cb = e.target.closest('input[data-col]');
    if (!cb) return;
    var colIdx = parseInt(cb.dataset.col);
    if (S.statsSelectedVars === null) {
      S.statsSelectedVars = new Set(statsCtx(root).numCols);
    }
    if (cb.checked) S.statsSelectedVars.add(colIdx);
    else S.statsSelectedVars.delete(colIdx);
    var item = cb.closest('.stats-var-item');
    if (item) item.classList.toggle('unchecked', !cb.checked);
    renderStatsTable(root);
    autoSaveProject();
  });

  // --- All/None buttons ---
  els.varAll.addEventListener('click', function() {
    if (S.statsSelectedVars === null) S.statsSelectedVars = new Set(statsCtx(root).numCols);
    els.varList.querySelectorAll('.stats-var-item[data-col]').forEach(function(el) {
      S.statsSelectedVars.add(parseInt(el.dataset.col));
    });
    statsCmpDatasets(root).forEach(function(ds) { materializeStatsCmpSel(ds, root); });
    els.varList.querySelectorAll('.stats-var-item[data-cmp-col]').forEach(function(el) {
      S.cmpSel[el.dataset.cmpDs].add(parseInt(el.dataset.cmpCol));
    });
    renderStatsSidebar(root);
    renderStatsTable(root);
    autoSaveProject();
  });
  els.varNone.addEventListener('click', function() {
    if (S.statsSelectedVars === null) S.statsSelectedVars = new Set(statsCtx(root).numCols);
    els.varList.querySelectorAll('.stats-var-item[data-col]').forEach(function(el) {
      S.statsSelectedVars.delete(parseInt(el.dataset.col));
    });
    statsCmpDatasets(root).forEach(function(ds) { materializeStatsCmpSel(ds, root); });
    els.varList.querySelectorAll('.stats-var-item[data-cmp-col]').forEach(function(el) {
      S.cmpSel[el.dataset.cmpDs].delete(parseInt(el.dataset.cmpCol));
    });
    renderStatsSidebar(root);
    renderStatsTable(root);
    autoSaveProject();
  });

  // --- Variable search ---
  els.varSearch.addEventListener('input', function() {
    renderStatsSidebar(root);
  });
  wireSearchShortcuts(els.varSearch, els.varAll, els.varNone);

  // --- CDF links in table (delegation on container — innerHTML changes) ---
  els.content.addEventListener('click', function(e) {
    var link = e.target.closest('.cdf-link');
    if (!link) return;
    e.preventDefault();
    if (link.dataset.cmpCol !== undefined) {
      var dsId = link.dataset.cmpDs, aCol = parseInt(link.dataset.cmpCol);
      var set = S.cdfCmpSel[dsId] || (S.cdfCmpSel[dsId] = new Set());
      if (set.has(aCol)) set.delete(aCol);
      else set.add(aCol);
    } else {
      var col = parseInt(link.dataset.col);
      if (S.statsCdfSelected.has(col)) S.statsCdfSelected.delete(col);
      else S.statsCdfSelected.add(col);
    }
    renderStatsTable(root);
    renderStatsCdfPanel(root);
    autoSaveProject();
  });

  // --- CDF scale + mode buttons ---
  els.cdfToolbar.addEventListener('click', function(e) {
    var modeBtn = e.target.closest('.stats-cdfmode');
    if (modeBtn) {
      S.statsCdfMode = modeBtn.dataset.cdfmode;
      renderStatsCdfPanel(root);
      autoSaveProject();
      return;
    }
    var btn = e.target.closest('.stats-scale');
    if (!btn) return;
    S.statsCdfScale = btn.dataset.scale;
    renderStatsCdfPanel(root);
    autoSaveProject();
  });

  // --- Copy table / Download SVG/PNG ---
  els.copyBtn.addEventListener('click', function() { copyStatsTable(root); });
  els.downloadSvg.addEventListener('click', function() { downloadStatsSvg(root); });
  els.downloadPng.addEventListener('click', function() { downloadStatsPng(root); });

  // --- Mobile collapsible sidebar ---
  if (window.matchMedia('(max-width: 700px)').matches) {
    els.sidebar.addEventListener('click', function(e) {
      var title = e.target.closest('.stats-sidebar-section--grow > .stats-sidebar-title');
      if (!title) return;
      var section = title.closest('.stats-sidebar-section--grow');
      var wasCollapsed = section.classList.contains('collapsed');
      els.sidebar.querySelectorAll('.stats-sidebar-section--grow').forEach(function(s) { s.classList.add('collapsed'); });
      if (wasCollapsed) section.classList.remove('collapsed');
    });
  }
}

function copyStatsTable(root) {
  var els = statEls(root);
  var table = els.content.querySelector('table.stats');
  if (!table) return;
  var rows = table.querySelectorAll('tr');
  var lines = [];
  rows.forEach(function(row) {
    var cells = row.querySelectorAll('th, td');
    var vals = [];
    cells.forEach(function(c) { vals.push(c.textContent); });
    lines.push(vals.join('\t'));
  });
  navigator.clipboard.writeText(lines.join('\n')).then(function() {
    var btn = els.copyBtn;
    btn.textContent = 'Copied!';
    setTimeout(function() { btn.textContent = 'Copy table'; }, 1500);
  });
}

function cleanSvgForExport(svgEl) {
  var clone = svgEl.cloneNode(true);
  // Remove interactive tooltip elements
  var overlay = clone.querySelector('#statsCdfOverlay');
  var crosshair = clone.querySelector('#statsCdfCrosshair');
  if (overlay) overlay.remove();
  if (crosshair) crosshair.remove();
  clone.querySelectorAll('.cdf-dot').forEach(function(d) { d.remove(); });
  var svgData = new XMLSerializer().serializeToString(clone);
  svgData = svgData.replace(/fill="var\(--bg\)"/g, 'fill="white"');
  svgData = svgData.replace(/fill="var(--chart-ink)"/g, 'fill="#555"');
  svgData = svgData.replace(/stroke="var(--chart-grid)"/g, 'stroke="#ddd"');
  svgData = svgData.replace(/style="font-family:var\(--mono\)"/g, 'style="font-family:monospace"');
  return svgData;
}

function downloadStatsSvg(root) {
  var chart = statEls(root).cdfChart;
  var svgEl = chart ? chart.querySelector('#statsCdfSvg') : null;
  if (!svgEl) return;
  var svgData = cleanSvgForExport(svgEl);
  var blob = new Blob([svgData], { type: 'image/svg+xml' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'statistics_cdf.svg';
  a.click();
  URL.revokeObjectURL(a.href);
}

function downloadStatsPng(root) {
  var chart = statEls(root).cdfChart;
  var svgEl = chart ? chart.querySelector('#statsCdfSvg') : null;
  if (!svgEl) return;
  var svgData = cleanSvgForExport(svgEl);
  var canvas = document.createElement('canvas');
  var scale = 2;
  var vb = svgEl.getAttribute('viewBox').split(' ').map(Number);
  canvas.width = vb[2] * scale;
  canvas.height = vb[3] * scale;
  var ctx = canvas.getContext('2d');
  var img = new Image();
  img.onload = function() {
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(function(blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'statistics_cdf.png';
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  };
  img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
}
