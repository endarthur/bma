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

var WS_PANELS = [
  { id: 'preflight',  title: 'Preflight',  el: 'panelPreflight' },
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
  // Closed panel: re-add it to the main workspace. Panels are singletons —
  // renderPanel re-fetches the same element it re-homed at close.
  var p = wsPanelById(tabId);
  if (!p) return;
  wsRails.addTab({ id: p.id, title: p.title }, wsMainTarget());
  wsSyncBadgesFromLegacy();
  wsSyncLegacyTabbar(tabId); // addTab activates without emitting tab:activate
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
  var main = document.getElementById('resultsMain');
  var panels = main ? main.querySelector('.results-panels') : null;
  if (!panels) return;
  if (tab.id === 'data') main.insertBefore(el, panels); // flex order: tree before panels
  else panels.appendChild(el);
}

// Mirror the legacy tab bar's .active to the rails-focused panel — project
// serialization (activeTab), getActiveTabId(), Alt+V and the smokes all
// read `.results-tab.active`
function wsSyncLegacyTabbar(tabId) {
  $resultsTabs.querySelectorAll('.results-tab').forEach(function(t) {
    t.classList.toggle('active', t.dataset.tab === tabId);
  });
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
  if (host && typeof createRails === 'function') buildRailsShell(host);
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
      return p ? document.getElementById(p.el) : null;
    },
    onPanelDestroy: wsRehomePanel,
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
  wsRails = null;        // legacy arm live before destroy() re-homes panels
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
})();
