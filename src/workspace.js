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

var WS_PANELS = [
  { id: 'preflight',  title: 'Import Block Model',  el: 'panelPreflight' },
  { id: 'aux',        title: 'Aux',        el: 'panelAux' },
  { id: 'summary',    title: 'Summary',    el: 'panelSummary' },
  { id: 'calcols',    title: 'Calc',       el: 'panelCalcols' },
  { id: 'statistics', title: 'Statistics', el: 'panelStatistics' },
  { id: 'categories', title: 'Categories', el: 'panelCategories' },
  { id: 'statscat',   title: 'StatsCat',   el: 'panelStatsCat' },
  { id: 'gt',         title: 'GT',         el: 'panelGt' },
  { id: 'swath',      title: 'Swath',      el: 'panelSwath' },
  { id: 'export',     title: 'Export',     el: 'panelExport' },
];
// (section stays out — hidden, unfinished; it lives on in .results-panels)

var WS_TREE_RAIL = 'rTree', WS_TREE_STACK = 'sTree';
var WS_MAIN_RAIL = 'rMain', WS_MAIN_STACK = 'sMain';

// Shell-agnostic panel activation — the one entry point for programmatic
// tab switches (project restore, ctx-menu focus, deep links)
function showPanel(tabId) {
  switchTab(tabId); // core.js — delegates to wsActivateInRails on the rails shell
}

function wsActivateInRails(tabId) {
  if (!wsRails) return;
  if (findTab(wsRails.state, tabId)) { wsRails.activateTab(tabId); return; }
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
  if (ds && ds.kind !== 'model') {
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
  if (!wsPanelById(activeId)) activeId = 'preflight';
  return {
    rails: [
      { id: WS_TREE_RAIL, flex: 0, width: 250, collapsible: true,
        collapsed: !catalogTreeIsOpen(),
        stacks: [{ id: WS_TREE_STACK, flex: 1, active: 'data',
          tabs: [{ id: 'data', title: 'Data', closeable: false, draggable: false }] }] },
      { id: WS_MAIN_RAIL, flex: 1,
        stacks: [{ id: WS_MAIN_STACK, flex: 1, active: activeId,
          tabs: WS_PANELS.map(function(p) {
            return { id: p.id, title: p.title };
          }) }] }
    ],
    floats: []
  };
}

// Re-home a singleton panel back into the legacy shell's containers when
// rails evicts it (only destroy() does in C1b-1 — tabs aren't closeable)
function wsRehomePanel(tab, wrapper) {
  var el = wrapper && wrapper.firstElementChild;
  if (!el) return;
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
  var dh = el.querySelector('.dh-card');
  if (dh) dh.remove();
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

// Data ▸ Add point dataset… — spawn a new instance and activate its (empty)
// import panel; the panel's own dropzone/picker loads the file into the ds.
function wsAddPointDataset() {
  if (!wsRails) {
    // Legacy/mobile shell has no instance tabs — fall back to the singleton aux
    showPanel('aux');
    var afi = document.getElementById('auxFileInput');
    if (afi) afi.click();
    return;
  }
  if (typeof dsCreate !== 'function') return;
  var ds = dsCreate({ prefix: 'data' });
  dsAdd(ds);
  wsRails.addTab({ id: ds.id, title: 'Import: ' + ds.prefix, closeable: true }, wsMainTarget());
  wsRails.activateTab(ds.id);   // renderPanel → wsBuildDatasetPanel (empty import surface)
}

// Track the prefix in the tab title (loadAuxFile on load, onAuxConfigChange on edit)
function wsSetDatasetTabTitle(ds) {
  if (!wsRails || !ds || ds.id === 'aux' || ds.id === 'model') return;
  if (findTab(wsRails.state, ds.id)) wsRails.updateTab(ds.id, { title: 'Import: ' + (ds.prefix || 'data') });
}

// Fully remove an instance: terminate its workers, close its tab (→
// onPanelDestroy discards the clone), drop it from the registry, refresh the
// dataset-listing views. (The singleton aux uses clearAux instead — reset, not remove.)
function wsRemoveInstance(ds) {
  if (!ds || ds.id === 'aux' || ds.id === 'model') return;
  ['_worker', '_declusWorker', '_topcutWorker'].forEach(function(k) {
    if (ds[k]) { try { ds[k].terminate(); } catch (e) {} ds[k] = null; }
  });
  if (wsRails && findTab(wsRails.state, ds.id)) wsRails.closeTab(ds.id);
  if (typeof dsRemove === 'function') dsRemove(ds.id);
  if (typeof refreshCatalogTree === 'function') refreshCatalogTree();
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
  return WS_PANELS.map(function(p) {
    return {
      label: p.title,
      checked: !!(wsRails && findTab(wsRails.state, p.id)),
      action: { panel: p.id }
    };
  });
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
  return [
    { label: 'Open…', action: 'open' },
    { label: 'Open recent', children: wsRecentMenuItems },
    '---',
    { label: 'Save', shortcut: 'Ctrl+S', action: 'saveFlush' },
    { label: 'Export project', action: 'export' },
    { label: 'Import project…', action: 'import' },
    '---',
    { label: 'Pack…', action: 'pack' },
    { label: 'Clear project', action: 'clear' },
    '---',
    { label: 'Close file', action: 'closeFile' },
    { label: 'Settings…', action: 'settings' },
  ];
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
    case 'open': { var fi = document.getElementById('fileInput'); if (fi) fi.click(); break; }
    case 'saveFlush': if (typeof flushProjectSave === 'function') flushProjectSave(); break;
    case 'export': saveProjectFile(); break;
    case 'import': $projectFileInput.click(); break;
    case 'pack': openPackModal(); break;
    case 'clear': clearProject(); break;
    case 'closeFile': $backToPreflight.click(); break;
    case 'settings': openSettings(); break;
    case 'toggleTree': toggleCatalogTree(); break;
    case 'resetLayout': wsResetLayout(); break;
    case 'analyze': executeAnalysis(); break;
    case 'filter': wsFocusFilter(); break;
    case 'calcols': showPanel('calcols'); break;
    case 'addPoint': wsAddPointDataset(); break;
    case 'addDrillhole': { showPanel('aux'); var dh = document.getElementById('dhCard'); if (dh && dh.scrollIntoView) dh.scrollIntoView({ block: 'nearest' }); break; }
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
      // A10 1g-c: a dataset instance tab (d2+) → build its panel from the ds
      var ds = (typeof dsById === 'function') ? dsById(tab.id) : null;
      if (ds && ds.kind !== 'model') return wsBuildDatasetPanel(ds);
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
    dropZones: { 'tab-append-body': false }
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

  // Tab context menu: float/dock, move out, close
  wsRails.on('tab:contextmenu', function(ev) {
    if (!ev || !ev.tab || ev.tab.id === 'data') return;
    var hit = findTab(wsRails.state, ev.tab.id);
    var inFloat = hit && hit.container === 'float';
    var items = [
      inFloat ? { label: 'Dock', action: 'dock' } : { label: 'Float', action: 'float' },
      { label: 'Move to new rail', action: 'rail' },
      '---',
      { label: 'Close', action: 'close' },
    ];
    if (ev.stack.tabs.length > 1) items.push({ label: 'Close others in stack', action: 'close-others' });
    Menu.show(items, { x: ev.x, y: ev.y }).then(function(a) {
      if (!a || !wsRails) return;
      if (a === 'float') {
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
