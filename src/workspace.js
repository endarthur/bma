// ─── Workspace shells (C1b) ─────────────────────────────────────────────
// Two shells over the same singleton panels (docs/c1b-rails-docking.md):
//
// - Rails shell (≥ 701px): vendored @gcu/rails mounted on .results-main.
//   Default layout = collapsible tree rail ("Data" = the C1a catalog tree)
//   + one main stack with every tab, so nothing looks foreign; splitting/
//   re-stacking is discoverable, not imposed. Panels are reparented into
//   rails wrappers once at mount and carry .active permanently — the
//   wrapper (positioned by rails) controls visibility, the class keeps
//   each panel's own display rules (flex vs block) applying.
// - Legacy tab shell (< 700px): today's tab bar + .results-panel.active,
//   untouched (C1c turns it into a pager).
//
// showPanel(id) is the shell-agnostic entry point; switchTab (core.js)
// delegates here when the rails shell is up, so stragglers stay correct.
// The legacy tab bar stays visible and synced on the rails shell during
// C1b-1/2 (smoke-suite shim + familiar chrome); it retires in C1b-3.
//
// C1b-2: floats are on (D4 — tab-append-body drops stay off so floats
// don't snap into stacks); tabs are closeable. Closing destroys the rails
// tab but the singleton panel just re-homes to .results-panels — clicking
// the tab's legacy-bar button re-adds it (wsActivateInRails). The layout
// persists as the `layout` project key ({v:1, rails: serialize()}) and
// survives breakpoint crossings via wsLastLayout.

var wsRails = null;      // rails instance when the rails shell is up, else null
var wsLastLayout = null; // serialized rails layout — survives shell exits, rides projects
var wsMenuBar = null;    // C6-2 desktop menubar (rails shell only); null on legacy

// ws-v2 phase 6: `defaultOpen` panels populate a fresh workspace's main stack
// (the "trimmed default layout" — Import Model + the two core summaries). The
// rest stay REGISTERED (renderPanel resolves them, the Panels menu lists them,
// the tree opens them) and appear on demand — only the initial/Reset layout is
// leaner. Existing projects keep their saved layout. (Arthur 2026-06-20: Minimal.)
var WS_PANELS = [
  { id: 'preflight',  title: 'Import Model',  el: 'panelPreflight', defaultOpen: true },
  { id: 'aux',        title: 'Aux',        el: 'panelAux' },
  // ws-v2 phase 2: Summary folded into the Import Model panel (no standalone tab).
  { id: 'calcols',    title: 'Calc',       el: 'panelCalcols' },
  { id: 'statistics', title: 'Statistics', el: 'panelStatistics', defaultOpen: true },
  { id: 'categories', title: 'Categories', el: 'panelCategories', defaultOpen: true },
  { id: 'statscat',   title: 'StatsCat',   el: 'panelStatsCat' },
  { id: 'gt',         title: 'GT',         el: 'panelGt' },
  { id: 'swath',      title: 'Swath',      el: 'panelSwath' },
  { id: 'crosstab',   title: 'Cross-tab',  el: 'panelCrosstab' },
  { id: 'export',     title: 'Export',     el: 'panelExport' },
];
// (section stays out — hidden, unfinished; it lives on in .results-panels)

var WS_TREE_RAIL = 'rTree', WS_TREE_STACK = 'sTree';
var WS_MAIN_RAIL = 'rMain', WS_MAIN_STACK = 'sMain';

// Shell-agnostic panel activation — the one entry point for programmatic
// tab switches (project restore, ctx-menu focus, deep links)
function showPanel(tabId) {
  // ws-v2 phase 2: Summary folded into the Import Model panel — 'summary' now
  // means "open the model panel, switch its right pane to the Summary view".
  // Keeps old call sites + restored projects (activeTab:'summary') working.
  if (tabId === 'summary') {
    switchTab('preflight');
    if (typeof setModelView === 'function') setModelView('summary');
    return;
  }
  switchTab(tabId); // core.js — delegates to wsActivateInRails on the rails shell
}

function wsActivateInRails(tabId) {
  if (!wsRails) return;
  if (findTab(wsRails.state, tabId)) { wsRails.activateTab(tabId); return; }
  // aux is a de-privileged comparison-dataset tab (A10): closeable + named after
  // its file, like d2+ — not a permanent singleton. Re-add it that way.
  if (tabId === 'aux') {
    var auxDs = (typeof dsById === 'function') ? dsById('aux') : null;
    wsRails.addTab({ id: 'aux', title: auxDs ? wsDatasetTabName(auxDs) : 'Aux', closeable: true }, wsMainTarget());
    wsSyncBadgesFromLegacy();
    wsSyncLegacyTabbar(tabId);
    return;
  }
  // Closed singleton panel: re-add it to the main workspace. Singletons are
  // re-homed at close, so renderPanel re-fetches the same element.
  var p = wsPanelById(tabId);
  if (p) {
    wsRails.addTab({ id: p.id, title: p.title }, wsMainTarget());
    wsSyncBadgesFromLegacy();
    wsSyncLegacyTabbar(tabId); // addTab activates without emitting tab:activate
    return;
  }
  // Closed dataset INSTANCE (d2+): renderPanel rebuilds its panel from the ds
  // (A10 1g-c — state lives in the ds object, the clone is throwaway).
  var ds = (typeof dsById === 'function') ? dsById(tabId) : null;
  if (ds && ds.id !== 'model') {
    wsRails.addTab({ id: ds.id, title: 'Import: ' + (ds.prefix || 'data'), closeable: true }, wsMainTarget());
  }
}

// Where re-added (or re-opened) tabs land: the first stack of the first
// non-tree rail; a fresh rail if the user closed everything
function wsMainTarget() {
  var rails = wsRails.state.rails;
  for (var i = 0; i < rails.length; i++) {
    if (rails[i].id === WS_TREE_RAIL) continue;
    if (rails[i].stacks.length) return { to: 'stack', stackId: rails[i].stacks[0].id };
  }
  return { to: 'new-rail', at: rails.length };
}

// First visible (active, non-tree) tab — legacy-bar fallback when the
// focused tab gets closed
function wsFirstVisibleTab() {
  var rails = wsRails.state.rails;
  for (var i = 0; i < rails.length; i++) {
    if (rails[i].id === WS_TREE_RAIL || rails[i].collapsed) continue;
    for (var j = 0; j < rails[i].stacks.length; j++) {
      var a = rails[i].stacks[j].active;
      if (a && a !== 'data') return a;
    }
  }
  return 'preflight';
}

function wsPanelById(id) {
  for (var i = 0; i < WS_PANELS.length; i++) {
    if (WS_PANELS[i].id === id) return WS_PANELS[i];
  }
  return null;
}

// Default layout = familiar (C1b D3): tree rail + single main stack
function wsDefaultLayout(activeId) {
  // ws-v2 phase 6: only `defaultOpen` panels populate the fresh main stack. The
  // current active tab is honored if it's one of them, else we land on Import
  // Model. (A non-default active panel — e.g. opened-then-Reset — is closed by the
  // reset, as expected; showPanel re-adds any registered panel on demand.) aux is
  // never in the default layout (it opens like d2+ via Add comparison dataset).
  var open = WS_PANELS.filter(function(p) { return p.defaultOpen; });
  var isOpen = open.some(function(p) { return p.id === activeId; });
  if (!isOpen) activeId = 'preflight';
  return {
    rails: [
      { id: WS_TREE_RAIL, flex: 0, width: 250, collapsible: true,
        collapsed: !catalogTreeIsOpen(),
        stacks: [{ id: WS_TREE_STACK, flex: 1, active: 'data',
          tabs: [{ id: 'data', title: 'Data', closeable: false, draggable: false }] }] },
      { id: WS_MAIN_RAIL, flex: 1,
        stacks: [{ id: WS_MAIN_STACK, flex: 1, active: activeId,
          tabs: open.map(function(p) { return { id: p.id, title: p.title }; }) }] }
    ],
    floats: []
  };
}

// Re-home a singleton panel back into the legacy shell's containers when
// rails evicts it (only destroy() does in C1b-1 — tabs aren't closeable)
function wsRehomePanel(tab, wrapper) {
  var el = wrapper && wrapper.firstElementChild;
  if (!el) return;
  // A10 4e-c-4: a closed Categories clone is discarded with its state (the
  // singleton + its panelState.categories survive).
  if (typeof catInstances !== 'undefined' && catInstances[tab.id]) {
    delete catInstances[tab.id];
    if (typeof catInstanceEls !== 'undefined') delete catInstanceEls[tab.id];
    return;
  }
  // A10 Swath s-4b: a closed Swath clone is discarded with its state + workers.
  if (typeof swathInstances !== 'undefined' && swathInstances[tab.id]) {
    swDisposeInstance(tab.id);
    return;
  }
  // A10 Statistics st-4: a closed Statistics clone is discarded with its state.
  if (typeof statInstances !== 'undefined' && statInstances[tab.id]) {
    statDisposeInstance(tab.id);
    return;
  }
  // A10 G3b: a closed GT clone is discarded with its state + worker.
  if (typeof gtInstances !== 'undefined' && gtInstances[tab.id]) {
    gtDisposeInstance(tab.id);
    return;
  }
  // A10 G4b: a closed StatsCat clone is discarded with its state.
  if (typeof statsCatInstances !== 'undefined' && statsCatInstances[tab.id]) {
    statsCatDisposeInstance(tab.id);
    return;
  }
  // A10 G5b: a closed Export clone is discarded with its state + worker.
  if (typeof exportInstances !== 'undefined' && exportInstances[tab.id]) {
    exportDisposeInstance(tab.id);
    return;
  }
  // A19-clone: a closed Cross-tab clone is discarded with its state + worker.
  if (typeof crosstabInstances !== 'undefined' && crosstabInstances[tab.id]) {
    crosstabDisposeInstance(tab.id);
    return;
  }
  // A10 1g-c: instance dataset panels (d2+) are throwaway clones — their state
  // lives in the ds object and renderPanel rebuilds on reopen, so discard them
  // (re-home only the static singletons + the tree).
  if (tab.id !== 'data' && !wsPanelById(tab.id)) return;
  var main = document.getElementById('resultsMain');
  var panels = main ? main.querySelector('.results-panels') : null;
  if (!panels) return;
  if (tab.id === 'data') main.insertBefore(el, panels); // flex order: tree before panels
  else panels.appendChild(el);
}

// ─── A10 1g-c: dataset instance panels (d2+) ───────────────────────────────
// The first comparison dataset is the singleton #panelAux; further datasets
// (a 3rd/4th comparison — new vs composites vs previous model vs check) are
// C9 instances: per-id panels cloned from #panelAux, dockable + closeable.
// All per-dataset state lives in the ds registry object, so a closed instance
// rebuilds from scratch on reopen (no preserveOnClose). renderPanel routes
// instance ids here.

// Build an instance's config panel. #panelAux is the template: clone it, strip
// every id (no duplicates — the panel resolves DOM by data-aux/data-act via
// auxQ), drop the drillhole card (drillhole sets are their own add path), tag
// the root data-ds=<id>, and wire it for this ds.
function wsBuildDatasetPanel(ds) {
  var tmpl = document.getElementById('panelAux');
  if (!tmpl || !ds) return null;
  var el = tmpl.cloneNode(true);
  el.removeAttribute('id');
  el.dataset.ds = ds.id;
  el.dataset.tab = ds.id;
  el.classList.add('active');   // wrapper controls visibility; class keeps display rules
  el.querySelectorAll('[id]').forEach(function(n) { n.removeAttribute('id'); });
  // A10 phase 5: the drillhole card stays on every dataset panel (was aux-only)
  // — each instance can host its own drillhole set. wireDhCard (via
  // wireDatasetPanel below) renders this instance's empty card + wires it.
  var emptyEl = el.querySelector('[data-aux="empty"]');
  var configEl = el.querySelector('[data-aux="config"]');
  if (ds.preflight) {
    if (emptyEl) emptyEl.style.display = 'none';
    if (configEl) configEl.style.display = '';
  } else {
    // Fresh instance: clear any state the clone copied from a loaded aux,
    // show the empty import surface.
    ['[data-aux="sidebar"]', '[data-aux="preview"]', '[data-aux="summaryView"]',
     '[data-aux="topcutView"]', '[data-aux="fileInfo"]'].forEach(function(sel) {
      var n = el.querySelector(sel); if (n) n.innerHTML = '';
    });
    if (emptyEl) emptyEl.style.display = '';
    if (configEl) configEl.style.display = 'none';
  }
  if (typeof wireDatasetPanel === 'function') wireDatasetPanel(el, ds);
  if (ds.preflight && typeof renderAuxConfig === 'function') renderAuxConfig(ds, el);
  else if (typeof renderAuxFromMain === 'function') renderAuxFromMain(ds, el);
  return el;
}

// Add a comparison dataset (point or drillhole) as a fresh d2+ instance and open
// its empty import surface; the panel's own dropzone/picker loads the file. The
// legacy singleton 'aux' is retired from this flow (it's no longer an always-
// present tab — see wsDefaultLayout); every new comparison is a peer instance.
// On the legacy/mobile shell (no instance tabs) we fall back to the aux panel.
// kind: 'point' | 'drillhole'.
function wsAddComparisonDataset(kind) {
  if (!wsRails) {
    showPanel('aux');
    if (kind === 'drillhole') {
      var dhl = document.querySelector('#panelAux [data-dh="card"]');
      if (dhl && dhl.scrollIntoView) dhl.scrollIntoView({ block: 'nearest' });
    } else {
      var afi = document.getElementById('auxFileInput');
      if (afi) afi.click();
    }
    return;
  }
  if (typeof dsCreate !== 'function') return;
  var ds = dsCreate({ prefix: 'data' });
  dsAdd(ds);
  wsRails.addTab({ id: ds.id, title: 'Import: ' + ds.prefix, closeable: true }, wsMainTarget());
  wsRails.activateTab(ds.id);   // renderPanel → wsBuildDatasetPanel (empty import surface)
  if (kind === 'drillhole') {
    var dh = document.querySelector('.ds-panel[data-ds="' + ds.id + '"] [data-dh="card"]');
    if (dh && dh.scrollIntoView) dh.scrollIntoView({ block: 'nearest' });
  }
}
function wsAddPointDataset() { wsAddComparisonDataset('point'); }
function wsAddDrillholeDataset() { wsAddComparisonDataset('drillhole'); }

// A10 #19: drop-to-add. Given an already-resolved File (+ optional FS handle),
// spawn a fresh comparison dataset, open its panel, and load the file straight
// in — the additive answer to "a file was dropped while a model is loaded".
// renderPanel runs synchronously inside activateTab, so dsConfigRoot is ready.
function wsLoadComparisonFile(file, handle) {
  if (!file) return;
  if (!wsRails || typeof dsCreate !== 'function') { loadAuxFile(file, handle); return; }  // legacy/<700px → aux slot
  var ds = dsCreate({ prefix: 'data' });
  dsAdd(ds);
  wsRails.addTab({ id: ds.id, title: 'Import: ' + ds.prefix, closeable: true }, wsMainTarget());
  wsRails.activateTab(ds.id);   // builds the panel synchronously
  var root = (typeof dsConfigRoot === 'function') ? dsConfigRoot(ds) : null;
  loadAuxFile(file, handle, undefined, ds, root);
}

// A10 4e-b: recreate a comparison-dataset instance from its saved config on
// project load. The registry entry + rails tab come back immediately with the
// saved id/prefix; the panel is the empty import surface awaiting its named
// file (loadAuxFile applies ds._pendingRestore when it lands, like aux). State
// stays on the ds, so this is just wsAddPointDataset with a fixed id + pending
// config. dsNextNum is advanced past restored ids so a later Add won't collide.
// skipTab: register the registry entry only (no rails tab) — used for the early
// pass in applyProject so the instance exists BEFORE the layout deserialize, which
// lets wsSanitizeLayout keep its tab at the SAVED dock position. The later
// displayResults call (no skipTab) then ensures a tab only if the layout didn't
// already place one (a stale/invalid layout → the default-position safety net).
function wsRestoreInstance(cfg, skipTab) {
  if (typeof dsCreate !== 'function' || !cfg || !cfg.id) return null;
  var ds = (typeof dsById === 'function') ? dsById(cfg.id) : null;
  if (!ds) {
    ds = dsCreate({ id: cfg.id, prefix: cfg.prefix || 'data', gridMode: cfg.gridMode || null });
    // A11 emit: an emitted dataset has no own file to re-supply — it re-derives
    // from its parent set (dhReEmitAll once the set is ready), so flag it rather
    // than seeding the file-await _pendingRestore.
    if (cfg.derivedFrom && cfg.derivedFrom.set) { ds.derivedFrom = cfg.derivedFrom; ds._pendingEmit = true; }
    else ds._pendingRestore = cfg;
    dsAdd(ds);
    var n = parseInt(String(cfg.id).replace(/^d/, ''), 10);
    if (typeof dsNextNum !== 'undefined' && isFinite(n) && n >= dsNextNum) dsNextNum = n + 1;
  }
  if (!skipTab && wsRails && !findTab(wsRails.state, ds.id)) {
    wsRails.addTab({ id: ds.id, title: 'Import: ' + (ds.prefix || 'data'), closeable: true }, wsMainTarget());
  }
  return ds;
}

// A10 4e-c-4: spawn a cloned Categories analysis panel. seedFocusedCol lets
// Duplicate carry the source panel's column; default = the singleton's column.
function wsSpawnCategoriesInstance(seedFocusedCol, seedChartShowAll, seedTargetDsId) {
  if (!wsRails || typeof catNextInstId !== 'function') { showPanel('categories'); return; }
  var instId = catNextInstId();
  catInstances[instId] = catNewInstState();
  catInstances[instId].catTargetDsId = seedTargetDsId || 'model';   // ws-v2 phase 1: carry the source panel's target
  catInstances[instId].focusedCol = (seedFocusedCol != null) ? seedFocusedCol : panelState.categories.focusedCol;
  catInstances[instId].chartShowAll = !!seedChartShowAll;
  wsRails.addTab({ id: instId, title: 'Categories', closeable: true }, wsMainTarget());
  wsRails.activateTab(instId);                 // renderPanel → catBuildInstancePanel
  if (typeof catSyncInstanceTitle === 'function') {
    var root = document.querySelector('[data-cat-inst="' + instId + '"]');
    if (root) catSyncInstanceTitle(root);
  }
}

// A10 Swath s-4b: spawn a cloned Swath analysis panel. Starts with a fresh
// (default) config; the user picks directions/vars and Generates its own run.
// A19-clone: spawn a cloned Cross-tab panel. Each clone runs its OWN worker on
// its OWN target/columns/weight (independent cross-tabs). Duplicate carries the
// source panel's config via crosstabApplyConfig.
function wsSpawnCrosstabInstance(seedConfig) {
  if (!wsRails || typeof crosstabNextInstId !== 'function') { showPanel('crosstab'); return; }
  var instId = crosstabNextInstId();
  if (typeof crosstabInstances !== 'undefined' && typeof crosstabNewInstState === 'function') crosstabInstances[instId] = crosstabNewInstState();
  wsRails.addTab({ id: instId, title: 'Cross-tab', closeable: true }, wsMainTarget());
  wsRails.activateTab(instId);                 // renderPanel → crosstabBuildInstancePanel
  if (seedConfig && typeof crosstabApplyConfig === 'function') {   // Duplicate: carry the source config
    var root = document.querySelector('[data-xt-inst="' + instId + '"]');
    if (root) crosstabApplyConfig(root, seedConfig);
  }
}

function wsSpawnSwathInstance(seedConfig) {
  if (!wsRails || typeof swNextInstId !== 'function') { showPanel('swath'); return; }
  var instId = swNextInstId();
  if (typeof swathInstances !== 'undefined' && typeof swNewInstState === 'function') swathInstances[instId] = swNewInstState();
  wsRails.addTab({ id: instId, title: 'Swath', closeable: true }, wsMainTarget());
  wsRails.activateTab(instId);                 // renderPanel → swBuildInstancePanel
  if (seedConfig && typeof swApplyConfig === 'function') {   // Duplicate: carry the source config
    var root = document.querySelector('[data-sw-inst="' + instId + '"]');
    if (root) swApplyConfig(root, seedConfig);
  }
}

// A10 Statistics st-4: spawn a cloned Statistics analysis panel. Renders the
// shared analysis through fresh per-instance view state.
function wsSpawnStatisticsInstance(seedView) {
  if (!wsRails || typeof statNextInstId !== 'function') { showPanel('statistics'); return; }
  var instId = statNextInstId();
  if (typeof statInstances !== 'undefined' && typeof statNewInstState === 'function') {
    statInstances[instId] = statNewInstState();
    if (seedView) statInstances[instId]._pendingView = seedView;   // Duplicate: carry the source view
  }
  wsRails.addTab({ id: instId, title: 'Statistics', closeable: true }, wsMainTarget());
  wsRails.activateTab(instId);                 // renderPanel → statBuildInstancePanel
  if (seedView && typeof statApplyAllInstances === 'function') {   // resolve + repaint the seeded view now
    statApplyAllInstances();
    if (typeof statRenderAllInstances === 'function') statRenderAllInstances();
  }
}

// A10 G3b: spawn a cloned GT analysis panel. Each clone runs its OWN worker on
// its OWN target dataset (independent grade-tonnage curves). Duplicate carries the
// source panel's config (target/grades/cutoffs/units) via gtApplyConfig (G3b-4).
function wsSpawnGtInstance(seedConfig) {
  if (!wsRails || typeof gtNextInstId !== 'function') { showPanel('gt'); return; }
  var instId = gtNextInstId();
  if (typeof gtInstances !== 'undefined' && typeof gtNewInstState === 'function') gtInstances[instId] = gtNewInstState();
  wsRails.addTab({ id: instId, title: 'GT', closeable: true }, wsMainTarget());
  wsRails.activateTab(instId);                 // renderPanel → gtBuildInstancePanel
  if (seedConfig && typeof gtApplyConfig === 'function') {
    var root = document.querySelector('[data-gt-inst="' + instId + '"]');
    if (root) gtApplyConfig(root, seedConfig);
  }
}

// A10 G4b: spawn a cloned StatsCat panel — an independent VIEW onto a dataset's
// group stats (own target dataset). Duplicate carries the source panel's target.
function wsSpawnStatsCatInstance(seedTargetDsId) {
  if (!wsRails || typeof statsCatNextInstId !== 'function') { showPanel('statscat'); return; }
  var instId = statsCatNextInstId();
  if (typeof statsCatInstances !== 'undefined') statsCatInstances[instId] = { targetDsId: seedTargetDsId || 'model' };
  wsRails.addTab({ id: instId, title: 'StatsCat', closeable: true }, wsMainTarget());
  wsRails.activateTab(instId);                 // renderPanel → statsCatBuildInstancePanel
}

// A10 G5b: spawn a cloned Export panel (own target dataset + column selection).
function wsSpawnExportInstance(seedTargetDsId) {
  if (!wsRails || typeof exportNextInstId !== 'function') { showPanel('export'); return; }
  var instId = exportNextInstId();
  if (typeof exportInstances !== 'undefined') exportInstances[instId] = { targetDsId: seedTargetDsId || 'model' };
  wsRails.addTab({ id: instId, title: 'Export', closeable: true }, wsMainTarget());
  wsRails.activateTab(instId);                 // renderPanel → exportBuildInstancePanel
}

// Track the dataset in its tab title (loadAuxFile on load, onAuxConfigChange on
// edit, clearAux on reset). The first comparison dataset's tab used to be hard-
// labelled "Aux"; now it follows its loaded file like d2+ ("Import: <name>"), and
// falls back to "Aux" only when empty — de-privileging the legacy name.
function wsFileStem(name) { return (name || 'data').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').slice(0, 24); }
function wsDatasetTabName(ds) {
  if (ds.id === 'model') {
    return (typeof currentFile !== 'undefined' && currentFile) ? 'Import: ' + wsFileStem(currentFile.name) : 'Import Model';
  }
  if (ds.id === 'aux') {
    return ds.file ? 'Import: ' + wsFileStem(ds.file.name) : 'Aux';
  }
  return 'Import: ' + (ds.prefix || 'data');
}
// The model's import tab id is 'preflight'; aux/d2+ use their ds id. Keep the
// rails tab + the legacy (<701px) tab button in sync.
function wsSetDatasetTabTitle(ds) {
  if (!ds) return;
  var title = wsDatasetTabName(ds);
  var tabId = ds.id === 'model' ? 'preflight' : ds.id;
  if (wsRails && findTab(wsRails.state, tabId)) wsRails.updateTab(tabId, { title: title });
  var legacy = (ds.id === 'model') ? 'preflight' : (ds.id === 'aux' ? 'aux' : null);
  if (legacy && typeof $resultsTabs !== 'undefined' && $resultsTabs) {
    var btn = $resultsTabs.querySelector('.results-tab[data-tab="' + legacy + '"]');
    if (btn) btn.textContent = title;
  }
}

// Fully remove an instance: terminate its workers, close its tab (→
// onPanelDestroy discards the clone), drop it from the registry, refresh the
// dataset-listing views. (The singleton aux uses clearAux instead — reset, not remove.)
function wsRemoveInstance(ds) {
  if (!ds || ds.id === 'aux' || ds.id === 'model') return;
  ['_worker', '_declusWorker', '_topcutWorker', '_exportWorker'].forEach(function(k) {
    if (ds[k]) { try { ds[k].terminate(); } catch (e) {} ds[k] = null; }
  });
  if (typeof dhStates !== 'undefined' && dhStates) delete dhStates[ds.id];  // phase 5: drop its drillhole set
  if (wsRails && findTab(wsRails.state, ds.id)) wsRails.closeTab(ds.id);
  if (typeof dsRemove === 'function') dsRemove(ds.id);
  if (typeof refreshCatalogTree === 'function') refreshCatalogTree();
  if (typeof refreshCalcolModeToggle === 'function') refreshCalcolModeToggle();  // G1: drop it from the picker, bounce the editor if targeted
  if (typeof refreshGtTheoSource === 'function') refreshGtTheoSource();           // G2: drop it from the GT theo source picker
  if (typeof gtRefreshDatasetPicker === 'function') gtRefreshDatasetPicker();     // G3: drop it from the GT dataset picker (bounce to model if targeted)
  if (typeof statsCatRefreshDatasetPicker === 'function') statsCatRefreshDatasetPicker();  // G4a: drop it from the StatsCat dataset picker (bounce to model if targeted)
  if (typeof exportRefreshDatasetPicker === 'function') exportRefreshDatasetPicker();  // G5a: drop it from the Export dataset picker (bounce to model if targeted)
  if (typeof lastDisplayedStats !== 'undefined' && lastDisplayedStats) {
    renderStatsSidebar(); renderStatsTable(); renderStatsCdfPanel();
  }
  if (typeof autoSaveProject === 'function') autoSaveProject();
}

// Mirror the legacy tab bar's .active to the rails-focused panel — project
// serialization (activeTab), getActiveTabId(), Alt+V and the smokes all
// read `.results-tab.active`
function wsSyncLegacyTabbar(tabId) {
  var tabs = $resultsTabs.querySelectorAll('.results-tab');
  // Instance tabs (d2+) have no legacy button — leave the last real active in
  // place so getActiveTabId() doesn't fall back while an instance is focused.
  var hasBtn = false;
  tabs.forEach(function(t) { if (t.dataset.tab === tabId) hasBtn = true; });
  if (!hasBtn) return;
  tabs.forEach(function(t) { t.classList.toggle('active', t.dataset.tab === tabId); });
}

// #results.tree-open + toggle-button state follow catalogTreeOpen on both
// shells (tree-smoke and the C1a proto-sheet CSS key off them)
function wsSyncResultsTreeClass() {
  var open = catalogTreeIsOpen();
  var $r = document.getElementById('results');
  if ($r) $r.classList.toggle('tree-open', open);
  var $btn = document.getElementById('treeToggle');
  if ($btn) $btn.classList.toggle('active', open);
}

// Align the tree rail's collapsed state with catalogTreeOpen (project
// restore, toggle button) — uses the public API so events stay coherent
function wsSyncTreeRail() {
  if (!wsRails) return;
  var rail = null;
  for (var i = 0; i < wsRails.state.rails.length; i++) {
    if (wsRails.state.rails[i].id === WS_TREE_RAIL) { rail = wsRails.state.rails[i]; break; }
  }
  if (!rail) return;
  if (!!rail.collapsed === catalogTreeIsOpen()) wsRails.toggleRailCollapsed(WS_TREE_RAIL);
}

// One badge setter for both shells: rewrites the legacy .results-tab button
// and mirrors onto the rails tab. badge = null/'' clears.
function wsTabBadge(tabId, label, badge) {
  var has = badge !== null && badge !== undefined && badge !== '';
  var btn = $resultsTabs.querySelector('.results-tab[data-tab="' + tabId + '"]');
  if (btn) {
    btn.innerHTML = has
      ? esc(label) + ' <span class="tab-badge">' + esc(String(badge)) + '</span>'
      : esc(label);
  }
  if (wsRails) wsRails.updateTab(tabId, { badge: has ? String(badge) : null });
}

// On (re-)entering the rails shell mid-session, pull whatever badges the
// legacy buttons carry onto the rails tabs
function wsSyncBadgesFromLegacy() {
  if (!wsRails) return;
  wsRails.batch(function() {
    WS_PANELS.forEach(function(p) {
      var b = $resultsTabs.querySelector('.results-tab[data-tab="' + p.id + '"] .tab-badge');
      if (b) wsRails.updateTab(p.id, { badge: b.textContent });
    });
  });
}

function wsEnterRails() {
  if (wsRails) return;
  var host = document.getElementById('resultsMain');
  if (host && typeof createRails === 'function') {
    buildRailsShell(host);
    // Only once rails is actually up: hides the legacy tab bar (C1b-3) —
    // keyed on the class, not the viewport, so a rails failure leaves
    // the legacy shell usable
    document.getElementById('results').classList.add('rails-shell');
  }
}

// "Panels" menu — every registered panel, checked when open in the layout;
// selecting routes through showPanel (activate-or-add). Used by the
// toolbar ⋮ dropdown and the strip context menu.
function wsPanelsMenuItems() {
  var out = [];
  WS_PANELS.forEach(function(p) {
    // 'aux' is added via "Add comparison dataset" when empty; only list it for
    // reopening once it holds data (and use its file-following label).
    if (p.id === 'aux') {
      var aux = (typeof dsById === 'function') ? dsById('aux') : null;
      if (!aux || !aux.file) return;
      out.push({ label: wsDatasetTabName(aux), checked: !!(wsRails && findTab(wsRails.state, 'aux')), action: { panel: 'aux' } });
      return;
    }
    out.push({ label: p.title, checked: !!(wsRails && findTab(wsRails.state, p.id)), action: { panel: p.id } });
  });
  return out;
}

// "+" launcher (A10 4e-c) — the new-tab button at the end of each strip spawns
// new workspace content. Ordering (most-reached first): add a comparison
// dataset, then reopen any CLOSED panel, then clone an analysis panel. Routes
// through wsMenuAction.
function wsNewTabMenuItems() {
  var items = [];
  // Adding a dataset is the primary discoverable action — lead with it.
  items.push({ label: 'Add point dataset…', action: 'addPoint' });
  items.push({ label: 'Add drillhole set…', action: 'addDrillhole' });
  var reopen = [];
  WS_PANELS.forEach(function(p) {
    if (wsRails && findTab(wsRails.state, p.id)) return;   // already open — skip
    if (p.id === 'aux') {   // reopenable only once it holds data (else use Add dataset)
      var aux = (typeof dsById === 'function') ? dsById('aux') : null;
      if (!aux || !aux.file) return;
      reopen.push({ label: wsDatasetTabName(aux), action: { panel: 'aux' } });
      return;
    }
    reopen.push({ label: p.title, action: { panel: p.id } });
  });
  if (reopen.length) { items.push('---'); items.push.apply(items, reopen); }
  items.push('---');
  items.push({ label: 'New Categories panel', action: 'newCategories' });   // A10 4e-c-4: cloneable analysis panel
  items.push({ label: 'New Swath panel', action: 'newSwath' });             // A10 Swath s-4b
  items.push({ label: 'New Statistics panel', action: 'newStatistics' });   // A10 Statistics st-4
  items.push({ label: 'New GT panel', action: 'newGt' });                   // A10 G3b
  items.push({ label: 'New StatsCat panel', action: 'newStatsCat' });       // A10 G4b
  items.push({ label: 'New Export panel', action: 'newExport' });           // A10 G5b
  items.push({ label: 'New Cross-tab panel', action: 'newCrosstab' });      // A19-clone
  return items;
}

// ── C6-2 desktop menubar (File / View / Data / Help) ──────────────────────
// Each section's items is a LIVE factory (Menu.show re-evaluates it on every
// open via evaluateItems), so checkmarks (panels/theme/scale/tree) always
// reflect current state — no manual refresh needed. Only mounted on the rails
// shell (≥701px); the <700px legacy shell keeps the toolbar ⋮ kebab as its menu.
function wsThemeMenuItems() {
  var cur = (typeof bmaSettings !== 'undefined' && bmaSettings) ? bmaSettings.theme : 'system';
  return [
    { label: 'Light',  checked: cur === 'light',  action: { theme: 'light' } },
    { label: 'Dark',   checked: cur === 'dark',   action: { theme: 'dark' } },
    { label: 'System', checked: cur === 'system', action: { theme: 'system' } },
  ];
}
var WS_UI_SCALES = [90, 100, 110, 125, 150];
function wsScaleMenuItems() {
  var cur = (typeof bmaSettings !== 'undefined' && bmaSettings && bmaSettings.uiScale) || 100;
  return WS_UI_SCALES.map(function(s) {
    return { label: s + '%', checked: s === cur, action: { scale: s } };
  });
}
function wsRecentMenuItems() {
  if (!wsRecentsCache || !wsRecentsCache.length) return [{ label: '(no recent files)', disabled: true }];
  return wsRecentsCache.slice(0, 12).map(function(it) {
    return { label: it.name, action: { recent: it._key } };
  });
}
function wsFileMenuItems() {
  // C11: a mounted project folder (when FSAA is supported). Live factory → the
  // label tracks the mounted state.
  var folderItems = [];
  if (typeof fsaaSupported === 'function' && fsaaSupported()) {
    folderItems = (typeof mountedFolder !== 'undefined' && mountedFolder)
      ? [{ label: '📁 ' + fsaaFolderName() + ' — unmount', action: 'fsaaUnmount' }]
      : [{ label: 'Mount project folder…', action: 'fsaaMount' }];
    folderItems.push('---');
  }
  return folderItems.concat([
    { label: 'New project', action: 'newProject' },
    { label: 'Open…', action: 'open' },
    { label: 'Open recent', children: wsRecentMenuItems },
    '---',
    { label: 'Rename project…', action: 'renameProject' },
    { label: 'Save', shortcut: 'Ctrl+S', action: 'saveFlush' },
    { label: 'Export project', action: 'export' },
    { label: 'Import project…', action: 'import' },
    '---',
    { label: 'Pack…', action: 'pack' },
    { label: 'Clear project', action: 'clear' },
    '---',
    { label: 'Close file', action: 'closeFile' },
    { label: 'Settings…', action: 'settings' },
  ]);
}
function wsViewMenuItems() {
  return [
    { label: 'Panels', children: wsPanelsMenuItems },
    { label: 'Data tree', checked: !!catalogTreeOpen, action: 'toggleTree' },
    { label: 'Reset layout', action: 'resetLayout' },
    '---',
    { label: 'Theme', children: wsThemeMenuItems },
    { label: 'UI scale', children: wsScaleMenuItems },
  ];
}
function wsDataMenuItems() {
  return [
    { label: 'Analyze', action: 'analyze' },
    { label: 'Filter…', action: 'filter' },
    { label: 'Calculated columns…', action: 'calcols' },
    '---',
    { label: 'Add point dataset…', action: 'addPoint' },
    { label: 'Add drillhole set…', action: 'addDrillhole' },
  ];
}
function wsHelpMenuItems() {
  return [
    { label: 'Keyboard shortcuts', shortcut: 'F1', action: 'help' },
    { label: 'Download example dataset', action: 'example' },
    '---',
    { label: 'About BMA', action: 'about' },
  ];
}
var WS_MENU_SECTIONS = [
  { label: 'File', items: wsFileMenuItems },
  { label: 'View', items: wsViewMenuItems },
  { label: 'Data', items: wsDataMenuItems },
  { label: 'Help', items: wsHelpMenuItems },
];

function wsFocusFilter() {
  if (typeof $filterSection !== 'undefined' && $filterSection) $filterSection.classList.add('active');
  if (typeof $appFooter !== 'undefined' && $appFooter) $appFooter.classList.add('active');
  var el = document.getElementById('filterExpr');
  if (el) { el.focus(); }
}
function wsShowAbout() {
  var badge = document.getElementById('buildBadge');
  var build = badge ? badge.textContent.trim() : '';
  bmaConfirm({
    title: 'About BMA',
    html: '<div class="confirm-detail"><strong>BMA — Block Model Atelier</strong></div>' +
      '<div class="confirm-detail">Client-side CSV block model analyzer for mining &amp; geostatistics. Everything runs in your browser — nothing is uploaded.</div>' +
      '<div class="confirm-hint">Build ' + esc(build) + ' · Geoscientific Chaos Union · MIT</div>',
    okLabel: 'Close', cancelLabel: 'Close'
  });
}
function wsMenuAction(a) {
  if (!a) return;
  if (a.panel) { showPanel(a.panel); return; }
  if (a.theme) { applyTheme(a.theme); return; }
  if (a.scale != null) { if (typeof applyUiScale === 'function') applyUiScale(a.scale); return; }
  if (a.recent) { if (typeof reopenRecent === 'function') reopenRecent(a.recent); return; }
  switch (a) {
    case 'newProject': if (typeof newEmptyProject === 'function') newEmptyProject(); break;
    case 'open': { var fi = document.getElementById('fileInput'); if (fi) fi.click(); break; }
    case 'renameProject': if (typeof renameProjectPrompt === 'function') renameProjectPrompt(); break;
    case 'saveFlush': if (typeof flushProjectSave === 'function') flushProjectSave(); break;
    case 'export': saveProjectFile(); break;
    case 'import': $projectFileInput.click(); break;
    case 'pack': openPackModal(); break;
    case 'fsaaMount': if (typeof fsaaMountFolder === 'function') fsaaMountFolder(); break;       // C11
    case 'fsaaUnmount': if (typeof fsaaUnmount === 'function') fsaaUnmount(); break;             // C11
    case 'clear': clearProject(); break;
    case 'closeFile': $backToPreflight.click(); break;
    case 'settings': openSettings(); break;
    case 'toggleTree': toggleCatalogTree(); break;
    case 'resetLayout': wsResetLayout(); break;
    case 'analyze': executeAnalysis(); break;
    case 'filter': wsFocusFilter(); break;
    case 'calcols': showPanel('calcols'); break;
    case 'newCategories': if (typeof wsSpawnCategoriesInstance === 'function') wsSpawnCategoriesInstance(); break;
    case 'newSwath': if (typeof wsSpawnSwathInstance === 'function') wsSpawnSwathInstance(); break;
    case 'newStatistics': if (typeof wsSpawnStatisticsInstance === 'function') wsSpawnStatisticsInstance(); break;
    case 'newGt': if (typeof wsSpawnGtInstance === 'function') wsSpawnGtInstance(); break;
    case 'newStatsCat': if (typeof wsSpawnStatsCatInstance === 'function') wsSpawnStatsCatInstance(); break;
    case 'newExport': if (typeof wsSpawnExportInstance === 'function') wsSpawnExportInstance(); break;
    case 'newCrosstab': if (typeof wsSpawnCrosstabInstance === 'function') wsSpawnCrosstabInstance(); break;
    case 'addPoint': wsAddPointDataset(); break;
    case 'addDrillhole': wsAddDrillholeDataset(); break;
    case 'help': toggleHelp(); break;
    case 'example': { var ex = document.getElementById('exampleDownload'); if (ex) ex.click(); break; }
    case 'about': wsShowAbout(); break;
  }
}

function buildRailsShell(host) {
  var activeId = getActiveTabId();

  // Panels under rails are permanently .active (wrapper controls visibility)
  WS_PANELS.forEach(function(p) {
    var el = document.getElementById(p.el);
    if (el) el.classList.add('active');
  });

  wsRails = createRails(host, {
    initialState: wsDefaultLayout(activeId),
    renderPanel: function(tab) {
      if (tab.id === 'data') return document.getElementById('catalogTree');
      var p = wsPanelById(tab.id);
      if (p) return document.getElementById(p.el);
      // A10 4e-c-4: a cloned Categories analysis panel (categories#N)
      if (typeof catBuildInstancePanel === 'function' && tab.id.indexOf('categories#') === 0) {
        return catBuildInstancePanel(tab.id);
      }
      // A10 Swath s-4b: a cloned Swath analysis panel (swath#N)
      if (typeof swBuildInstancePanel === 'function' && tab.id.indexOf('swath#') === 0) {
        return swBuildInstancePanel(tab.id);
      }
      // A10 Statistics st-4: a cloned Statistics analysis panel (statistics#N)
      if (typeof statBuildInstancePanel === 'function' && tab.id.indexOf('statistics#') === 0) {
        return statBuildInstancePanel(tab.id);
      }
      // A10 G3b: a cloned GT analysis panel (gt#N)
      if (typeof gtBuildInstancePanel === 'function' && tab.id.indexOf('gt#') === 0) {
        return gtBuildInstancePanel(tab.id);
      }
      // A10 G4b: a cloned StatsCat analysis panel (statscat#N)
      if (typeof statsCatBuildInstancePanel === 'function' && tab.id.indexOf('statscat#') === 0) {
        return statsCatBuildInstancePanel(tab.id);
      }
      // A10 G5b: a cloned Export panel (export#N)
      if (typeof exportBuildInstancePanel === 'function' && tab.id.indexOf('export#') === 0) {
        return exportBuildInstancePanel(tab.id);
      }
      // A19-clone: a cloned Cross-tab panel (crosstab#N)
      if (typeof crosstabBuildInstancePanel === 'function' && tab.id.indexOf('crosstab#') === 0) {
        return crosstabBuildInstancePanel(tab.id);
      }
      // A10 1g-c: a dataset instance tab (d2+) → build its panel from the ds
      var ds = (typeof dsById === 'function') ? dsById(tab.id) : null;
      if (ds && ds.id !== 'model') return wsBuildDatasetPanel(ds);
      return null;
    },
    onPanelDestroy: wsRehomePanel,
    // C6-5 discoverability: a hint when every tab/rail has been closed
    renderEmpty: function() {
      var el = document.createElement('div');
      el.innerHTML = 'Workspace is empty. Reopen panels from the <strong>View ▸ Panels</strong> menu, or drag a tab here.';
      return el;
    },
    // The tree rail hosts only the Data tab — no drops into it
    canDropOn: function(zone) {
      if (zone.stackId === WS_TREE_STACK) return false;
      if (zone.type === 'new-stack' && zone.railId === WS_TREE_RAIL) return false;
      return true;
    },
    // D4: floats on, but full-body drop targets stay off — they make any
    // float move snap into a stack
    dropZones: { 'tab-append-body': false },
    // A10 4e-c: the "+" at the end of each strip opens a launcher (reopen a
    // closed panel / add a dataset) via the strip:newtab handler below
    newTabButton: true
  });

  wsRails.on('tab:activate', function(ev) {
    if (!ev || !ev.tab || ev.tab.id === 'data') return;
    wsSyncLegacyTabbar(ev.tab.id);
    if ($helpOverlay && $helpOverlay.classList.contains('active')) renderHelp(ev.tab.id);
    if (typeof autoSaveProject === 'function') autoSaveProject();
  });
  wsRails.on('tab:close', function(ev) {
    if (!ev || !ev.tab || ev.tab.id === 'data') return;
    // Focused tab closed → point the legacy bar at what's still visible
    var btn = $resultsTabs.querySelector('.results-tab.active');
    if (btn && btn.dataset.tab === ev.tab.id) wsSyncLegacyTabbar(wsFirstVisibleTab());
  });
  wsRails.on('rail:collapse', function(ev) {
    if (ev && ev.rail && ev.rail.id === WS_TREE_RAIL) wsOnTreeRailToggled(true);
  });
  wsRails.on('rail:expand', function(ev) {
    if (ev && ev.rail && ev.rail.id === WS_TREE_RAIL) wsOnTreeRailToggled(false);
  });

  // ── Menu surfaces (C1b-3, D7 — @gcu/menu) ──
  // Clipped tabs behind the strip's ⋯ button
  wsRails.on('strip:overflow', function(ev) {
    Menu.show(ev.overflowTabs.map(function(t) {
      return { label: t.title, action: { panel: t.id } };
    }), { x: ev.x, y: ev.y }).then(function(a) {
      if (!a || !wsRails) return;
      wsRails.activateTab(a.panel);
      var tabEl = document.querySelector(
        '.rails-strip[data-stack-id="' + ev.stack.id + '"] .rails-tab[data-tab-id="' + a.panel + '"]');
      if (tabEl && tabEl.scrollIntoView) tabEl.scrollIntoView({ block: 'nearest', inline: 'center' });
    });
  });

  // "+" new-tab button (A10 4e-c) → launcher menu anchored at the button
  wsRails.on('strip:newtab', function(ev) {
    if (!wsRails) return;
    var stackId = ev && ev.stack && ev.stack.id;
    var strip = stackId && document.querySelector('.rails-strip[data-stack-id="' + stackId + '"]');
    var wrap = strip && strip.closest('.rails-strip-wrap');
    var btn = wrap && wrap.querySelector('.rails-newtab-btn');
    var r = btn ? btn.getBoundingClientRect() : { left: 80, bottom: 80 };
    Menu.show(wsNewTabMenuItems(), { x: r.left, y: r.bottom }).then(function(a) {
      if (a) wsMenuAction(a);
    });
  });

  // Tab context menu: float/dock, move out, close
  wsRails.on('tab:contextmenu', function(ev) {
    if (!ev || !ev.tab || ev.tab.id === 'data') return;
    var hit = findTab(wsRails.state, ev.tab.id);
    var inFloat = hit && hit.container === 'float';
    var isCat = ev.tab.id === 'categories' || ev.tab.id.indexOf('categories#') === 0;
    var isSwath = ev.tab.id === 'swath' || ev.tab.id.indexOf('swath#') === 0;
    var isStats = ev.tab.id === 'statistics' || ev.tab.id.indexOf('statistics#') === 0;
    var isGt = ev.tab.id === 'gt' || ev.tab.id.indexOf('gt#') === 0;
    var isStatsCat = ev.tab.id === 'statscat' || ev.tab.id.indexOf('statscat#') === 0;
    var isExport = ev.tab.id === 'export' || ev.tab.id.indexOf('export#') === 0;
    var isCrosstab = ev.tab.id === 'crosstab' || ev.tab.id.indexOf('crosstab#') === 0;
    var items = [
      inFloat ? { label: 'Dock', action: 'dock' } : { label: 'Float', action: 'float' },
      { label: 'Move to new rail', action: 'rail' },
    ];
    if (isCat || isSwath || isStats || isGt || isStatsCat || isExport || isCrosstab) items.push({ label: 'Duplicate', action: 'duplicate' });   // A10 clone arcs + A19
    items.push('---', { label: 'Close', action: 'close' });
    if (ev.stack.tabs.length > 1) items.push({ label: 'Close others in stack', action: 'close-others' });
    Menu.show(items, { x: ev.x, y: ev.y }).then(function(a) {
      if (!a || !wsRails) return;
      if (a === 'duplicate') {
        if (isSwath) {
          var swRoot = ev.tab.id === 'swath' ? document.getElementById('panelSwath') : document.querySelector('[data-sw-inst="' + ev.tab.id + '"]');
          var swCfg = (swRoot && typeof swSerializeConfig === 'function') ? swSerializeConfig(swRoot) : null;
          wsSpawnSwathInstance(swCfg);   // carry the source panel's directions/vars/stat/display
        } else if (isStats) {
          var stRoot = ev.tab.id === 'statistics' ? document.getElementById('panelStatistics') : document.querySelector('[data-stat-inst="' + ev.tab.id + '"]');
          var stView = (stRoot && typeof statSerializeView === 'function' && typeof statStateForRoot === 'function') ? statSerializeView(statStateForRoot(stRoot)) : null;
          wsSpawnStatisticsInstance(stView);   // carry the source panel's var/metric/CDF/comparison view
        } else if (isGt) {
          var gtRoot = ev.tab.id === 'gt' ? document.getElementById('panelGt') : document.querySelector('[data-gt-inst="' + ev.tab.id + '"]');
          var gtCfg = (gtRoot && typeof gtSerializeConfig === 'function') ? gtSerializeConfig(gtRoot) : null;
          wsSpawnGtInstance(gtCfg);   // carry the source panel's target/grades/cutoffs/units (G3b-4)
        } else if (isStatsCat) {
          var scRoot = ev.tab.id === 'statscat' ? null : document.querySelector('[data-statcat-inst="' + ev.tab.id + '"]');
          var scTarget = (typeof statsCatInstTarget === 'function') ? statsCatInstTarget(scRoot) : 'model';
          wsSpawnStatsCatInstance(scTarget);   // carry the source panel's target dataset (G4b)
        } else if (isExport) {
          var exRoot = ev.tab.id === 'export' ? null : document.querySelector('[data-export-inst="' + ev.tab.id + '"]');
          var exTarget = (typeof exportInstTarget === 'function') ? exportInstTarget(exRoot) : 'model';
          wsSpawnExportInstance(exTarget);   // carry the source panel's target dataset (G5b)
        } else if (isCrosstab) {
          var xtRoot = ev.tab.id === 'crosstab' ? document.getElementById('panelCrosstab') : document.querySelector('[data-xt-inst="' + ev.tab.id + '"]');
          var xtCfg = (xtRoot && typeof crosstabSerializeConfig === 'function') ? crosstabSerializeConfig(xtRoot) : null;
          wsSpawnCrosstabInstance(xtCfg);   // carry the source panel's target/columns/weight/view (A19-clone)
        } else {
          var src = ev.tab.id === 'categories' ? panelState.categories : (typeof catInstances !== 'undefined' ? catInstances[ev.tab.id] : null);
          wsSpawnCategoriesInstance(src ? src.focusedCol : null, src ? src.chartShowAll : false, src ? src.catTargetDsId : 'model');
        }
      } else if (a === 'float') {
        var hostRect = document.getElementById('resultsMain').getBoundingClientRect();
        wsRails.floatTab(ev.tab.id, {
          x: Math.max(20, ev.x - hostRect.left - 80),
          y: Math.max(20, ev.y - hostRect.top + 10),
          w: 560, h: 420
        });
      } else if (a === 'dock') {
        wsRails.moveTab(ev.tab.id, wsMainTarget());
      } else if (a === 'rail') {
        wsRails.moveTab(ev.tab.id, { to: 'new-rail', at: wsRails.state.rails.length });
      } else if (a === 'close') {
        wsRails.closeTab(ev.tab.id);
      } else if (a === 'close-others') {
        var keep = ev.tab.id;
        wsRails.batch(function() {
          ev.stack.tabs.slice().forEach(function(t) {
            if (t.id !== keep && t.id !== 'data') wsRails.closeTab(t.id);
          });
        });
      }
    });
  });

  // Strip background context menu → the Panels reopen list
  wsRails.on('strip:contextmenu', function(ev) {
    Menu.show(wsPanelsMenuItems(), { x: ev.x, y: ev.y }).then(function(a) {
      if (a && a.panel) showPanel(a.panel);
    });
  });

  // Float titlebar context menu
  wsRails.on('float:titlebar:contextmenu', function(ev) {
    Menu.show([
      { label: 'Dock', action: 'dock' },
      '---',
      { label: 'Close', action: 'close', danger: true },
    ], { x: ev.x, y: ev.y }).then(function(a) {
      if (!a || !wsRails) return;
      if (a === 'dock') {
        var tabs = (ev.float.stack && ev.float.stack.tabs || []).slice();
        wsRails.batch(function() {
          tabs.forEach(function(t) { wsRails.moveTab(t.id, wsMainTarget()); });
        });
      } else if (a === 'close') {
        wsRails.closeFloat(ev.float.id);
      }
    });
  });
  // Every structural change (drag/split/float/close/resize-drag) → remember
  // + persist through the project autosave (debounced there)
  wsRails.on('layout:change', function() {
    if (!wsRails) return;
    wsLastLayout = wsRails.serialize();
    if (typeof autoSaveProject === 'function') autoSaveProject();
  });

  // Re-entry across the breakpoint (or a project restored on mobile):
  // bring back the remembered arrangement
  if (wsLastLayout) wsApplyLayout(wsLastLayout);

  // C6-2 menubar — top-left command surface; live-factory sections
  var mbEl = document.getElementById('appMenubar');
  if (mbEl && typeof MenuBar !== 'undefined') {
    if (wsMenuBar) { wsMenuBar.destroy(); wsMenuBar = null; }
    wsMenuBar = new MenuBar(mbEl, WS_MENU_SECTIONS);
    wsMenuBar.on('action', wsMenuAction);
  }

  wsSyncBadgesFromLegacy();
  wsSyncResultsTreeClass();
  renderCatalogTree();
}

function wsOnTreeRailToggled(collapsed) {
  catalogTreeOpen = !collapsed;
  wsSyncResultsTreeClass();
  if (typeof autoSaveProject === 'function') autoSaveProject();
}

function wsExitRails() {
  if (!wsRails) return;
  var activeId = getActiveTabId();
  var inst = wsRails;
  wsLastLayout = inst.serialize(); // arrangement survives the legacy interlude
  if (wsMenuBar) { wsMenuBar.destroy(); wsMenuBar = null; }   // C6-2 menubar is rails-only
  wsRails = null;        // legacy arm live before destroy() re-homes panels
  document.getElementById('results').classList.remove('rails-shell');
  inst.destroy();        // onPanelDestroy → wsRehomePanel for every mounted panel
  WS_PANELS.forEach(function(p) {
    var el = document.getElementById(p.el);
    if (el) el.classList.remove('active');
  });
  switchTab(activeId);   // restore single-active-panel display
  renderCatalogTree();   // legacy tree-open handling
}

// ─── Layout persistence (C1b-2) ─────────────────────────────────────────

// Hydrate a serialized layout. Sanitized first — tabs we no longer
// register, empty stacks/rails/floats and duplicate ids are dropped, so a
// stale project can't wedge the workspace. Anything structurally invalid →
// false, current layout untouched (deserialize validates before swapping).
function wsApplyLayout(json) {
  if (!wsRails || !json) return false;
  try {
    wsRails.deserialize(JSON.stringify(wsSanitizeLayout(JSON.parse(json))));
  } catch (e) {
    return false;
  }
  wsLastLayout = wsRails.serialize();
  wsSyncBadgesFromLegacy();
  wsSyncTreeRail();
  wsSyncResultsTreeClass();
  wsRails.activateTab(getActiveTabId()); // keep the focused tab focused if it survived
  return true;
}

function wsSanitizeLayout(st) {
  if (!st || !Array.isArray(st.rails)) throw new Error('bad layout');
  var known = { data: true };
  WS_PANELS.forEach(function(p) { known[p.id] = true; });
  // A10 4e-c-5: cloned Categories instance tabs (categories#N) survive sanitize
  // once their state has been recreated (catRestoreInstances runs before the
  // layout deserialize). An unknown instance id (no state) is still dropped.
  if (typeof catInstances !== 'undefined') Object.keys(catInstances).forEach(function(id) { known[id] = true; });
  // A10 Swath s-4b: live swath clones survive breakpoint crossings (project
  // persistence is s-5; until then they exist only for the session).
  if (typeof swathInstances !== 'undefined') Object.keys(swathInstances).forEach(function(id) { known[id] = true; });
  if (typeof statInstances !== 'undefined') Object.keys(statInstances).forEach(function(id) { known[id] = true; });
  if (typeof gtInstances !== 'undefined') Object.keys(gtInstances).forEach(function(id) { known[id] = true; });
  if (typeof statsCatInstances !== 'undefined') Object.keys(statsCatInstances).forEach(function(id) { known[id] = true; });
  if (typeof exportInstances !== 'undefined') Object.keys(exportInstances).forEach(function(id) { known[id] = true; });
  if (typeof crosstabInstances !== 'undefined') Object.keys(crosstabInstances).forEach(function(id) { known[id] = true; });   // A19-clone
  // Phase 6: comparison-dataset instance tabs (d2+) survive sanitize once their
  // registry entry exists (registered before the layout deserialize), so their
  // saved dock position is preserved across a reload.
  if (typeof datasets !== 'undefined') datasets.forEach(function(d) { if (d && d.id) known[d.id] = true; });
  var seen = {};
  function cleanStack(s) {
    s.tabs = (s.tabs || []).filter(function(t) {
      if (!t || !known[t.id] || seen[t.id]) return false;
      seen[t.id] = true;
      return true;
    });
    if (s.tabs.length && !s.tabs.some(function(t) { return t.id === s.active; })) {
      s.active = s.tabs[0].id;
    }
    return s.tabs.length > 0;
  }
  st.rails = st.rails.filter(function(r) {
    r.stacks = (r.stacks || []).filter(cleanStack);
    return r.stacks.length > 0;
  });
  st.floats = (st.floats || []).filter(function(f) { return f.stack && cleanStack(f.stack); });
  if (!seen.data || !st.rails.length) throw new Error('layout missing core structure');
  return st;
}

// Toolbar action + the missing/invalid-layout fallback
function wsResetLayout(skipSave) {
  wsLastLayout = null;
  if (!wsRails) return;
  wsRails.deserialize(JSON.stringify(wsDefaultLayout(getActiveTabId())));
  wsLastLayout = wsRails.serialize();
  wsSyncBadgesFromLegacy();
  wsSyncTreeRail();
  wsSyncResultsTreeClass();
  if (!skipSave && typeof autoSaveProject === 'function') autoSaveProject();
}

// The `layout` project key (serializeProject / applyProject)
function wsSerializeLayout() {
  var json = wsRails ? wsRails.serialize() : wsLastLayout;
  return json ? { v: 1, rails: json } : null;
}

function wsRestoreProjectLayout(layout) {
  if (layout && layout.v === 1 && typeof layout.rails === 'string') {
    wsLastLayout = layout.rails;            // applied at next rails entry if on mobile
    if (!wsRails || wsApplyLayout(layout.rails)) return;
  }
  wsResetLayout(true); // missing or invalid → default (autosave follows restore anyway)
}

// ── C6-4a: whole-sidebar collapse ─────────────────────────────────────────
// Every analysis surface's control sidebar can collapse to hand the full
// width to the results. A permanent slim chevron rail (a body child, so it
// survives the sidebar's own innerHTML re-renders) holds the affordance:
// ◀ collapses; when collapsed the rail becomes a labeled ▶ strip to re-open.
// Charts redraw through the C1b-0 width observers when the main area grows.
// State is per-panel, persisted in the project (like the layout).
var SIDEBAR_COLLAPSED = new Set();   // panel ids currently collapsed
var WS_SB = {};                      // panelId → { body }

function wsInitSidebar(panelId, body, label) {
  if (!body || body.classList.contains('sb-host')) return;
  var sidebar = body.firstElementChild;   // the sidebar is every X-body's first child
  if (!sidebar) return;
  sidebar.classList.add('sb-panel');
  body.classList.add('sb-host');
  WS_SB[panelId] = { body: body };

  var rail = document.createElement('button');
  rail.type = 'button';
  rail.className = 'sb-rail';
  rail.innerHTML = '<span class="sb-rail-icon"></span><span class="sb-rail-label">' + esc(label) + '</span>';
  rail.addEventListener('click', function() { wsToggleSidebar(panelId); });
  body.insertBefore(rail, sidebar);

  if (SIDEBAR_COLLAPSED.has(panelId)) body.classList.add('sb-collapsed');
  wsUpdateRail(panelId);
}

function wsUpdateRail(panelId) {
  var rec = WS_SB[panelId]; if (!rec) return;
  var collapsed = rec.body.classList.contains('sb-collapsed');
  var rail = rec.body.querySelector(':scope > .sb-rail');
  if (rail) {
    rail.title = collapsed ? 'Show controls' : 'Hide controls';
    rail.setAttribute('aria-expanded', String(!collapsed));
  }
}

function wsToggleSidebar(panelId) {
  var rec = WS_SB[panelId]; if (!rec) return;
  var collapsed = !rec.body.classList.contains('sb-collapsed');
  rec.body.classList.toggle('sb-collapsed', collapsed);
  if (collapsed) SIDEBAR_COLLAPSED.add(panelId); else SIDEBAR_COLLAPSED.delete(panelId);
  wsUpdateRail(panelId);
  if (typeof autoSaveProject === 'function') autoSaveProject();
}

// Restore from the project (array of collapsed panel ids)
function wsApplySidebarCollapsed(list) {
  SIDEBAR_COLLAPSED = new Set(Array.isArray(list) ? list : []);
  Object.keys(WS_SB).forEach(function(pid) {
    WS_SB[pid].body.classList.toggle('sb-collapsed', SIDEBAR_COLLAPSED.has(pid));
    wsUpdateRail(pid);
  });
}

// ─── C6-4b: collapsible sidebar sections ────────────────────────────────
// Each control-sidebar section is marked data-sb="<key>" in its renderer;
// wsEnhanceSidebar promotes the section's first child (the title) to a
// clickable header and applies the persisted/default open state. Built on
// the tree.js open-state pattern, shared across every sidebar renderer.
// State is per panel:key, persisted in the project (sidebars.sections).
var SB_SECTIONS = {};   // "panelId:key" -> true when COLLAPSED

// defaults: { key: 'collapsed' } — keys absent default to open. Called after
// each (re)render; safe to re-run (per-render markup gets fresh listeners,
// static markup is guarded by data-sb-bound).
function wsEnhanceSidebar(panelId, sidebar, defaults) {
  if (!sidebar) return;
  defaults = defaults || {};
  var secs = sidebar.querySelectorAll(':scope > [data-sb]');
  for (var i = 0; i < secs.length; i++) {
    (function(sec) {
      var key = sec.getAttribute('data-sb');
      var head = sec.firstElementChild;
      if (!head) return;
      sec.classList.add('sb-sec');
      if (sec.className.indexOf('--grow') >= 0) sec.classList.add('sb-sec--grow');
      head.classList.add('sb-sec-head');
      var full = panelId + ':' + key;
      // stamp panel + default so wsApplySidebarSections can re-resolve static
      // (persistent-DOM) sections on project restore
      sec.dataset.sbPanel = panelId;
      sec.dataset.sbDefault = (defaults[key] === 'collapsed') ? 'collapsed' : 'open';
      var collapsed = (full in SB_SECTIONS) ? SB_SECTIONS[full] : (defaults[key] === 'collapsed');
      sec.classList.toggle('collapsed', collapsed);
      if (!head.dataset.sbBound) {
        head.dataset.sbBound = '1';
        head.addEventListener('click', function() {
          var now = !sec.classList.contains('collapsed');
          sec.classList.toggle('collapsed', now);
          SB_SECTIONS[panelId + ':' + key] = now;
          if (typeof autoSaveProject === 'function') autoSaveProject();
        });
      }
    })(secs[i]);
  }
}

// Force a section open (e.g. Alt+V focusing a collapsed var search) and
// remember it. panelId:key must match the section's data-sb.
function wsOpenSidebarSection(panelId, key) {
  SB_SECTIONS[panelId + ':' + key] = false;
  var sec = document.querySelector('[data-sb="' + key + '"]');
  if (sec) sec.classList.remove('collapsed');
}

// Restore from the project (object of "panelId:key" -> collapsed bool).
// JS sidebars (gt/swath) re-read SB_SECTIONS when they next render; static
// (persistent-DOM) sidebars are already enhanced, so re-resolve them now,
// falling back to each section's stamped default for keys not in the project.
function wsApplySidebarSections(obj) {
  SB_SECTIONS = (obj && typeof obj === 'object') ? Object.assign({}, obj) : {};
  document.querySelectorAll('.sb-sec[data-sb-panel]').forEach(function(sec) {
    var full = sec.dataset.sbPanel + ':' + sec.getAttribute('data-sb');
    var collapsed = (full in SB_SECTIONS) ? SB_SECTIONS[full] : (sec.dataset.sbDefault === 'collapsed');
    sec.classList.toggle('collapsed', collapsed);
  });
}

function wsInitSidebars() {
  wsInitSidebar('statistics', document.getElementById('statsBody'), 'Variables');
  wsInitSidebar('categories', document.getElementById('catBody'), 'Columns');
  wsInitSidebar('statscat', document.querySelector('#panelStatsCat .statscat-body'), 'Group by');
  wsInitSidebar('gt', document.querySelector('#panelGt .gt-body'), 'Grade-tonnage');
  wsInitSidebar('swath', document.querySelector('#panelSwath .swath-body'), 'Directions');
  wsInitSidebar('export', document.getElementById('exportBody'), 'Columns');

  // C6-4b — static sidebars: make the secondary config sections collapsible.
  // Only non-grow sections (the grow var/value lists keep their primary role
  // and the mobile accordion); these render live so there's no action footer.
  wsEnhanceSidebar('statistics', document.getElementById('statsSidebar'), { weight: 'collapsed' });
  wsEnhanceSidebar('statscat', document.querySelector('#panelStatsCat .statscat-sidebar'), {});
}

// Shell choice by viewport, re-evaluated on breakpoint crossing (C1b D5:
// the legacy shell survives < 700px until C1c)
var wsMql = window.matchMedia('(min-width: 701px)');
function wsSyncShell() {
  if (wsMql.matches) wsEnterRails();
  else wsExitRails();
}
(function() {
  if (wsMql.addEventListener) wsMql.addEventListener('change', wsSyncShell);
  else if (wsMql.addListener) wsMql.addListener(wsSyncShell); // older Safari
  wsSyncShell();
  wsInitSidebars();   // C6-4a — static bodies exist regardless of shell
})();
