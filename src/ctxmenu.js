// ─── Context menus ────────────────────────────────────────────────────
// One generic right-click menu, fed by providers that inspect the event
// target and contribute items. No items → the native browser menu passes
// through (and Ctrl+right-click always does, as an escape hatch).
//
// The variable provider recognizes every surface that renders a variable
// (tree rows, Statistics sidebar/table, Swath and GT var lists, Categories
// columns) and offers the shared actions: Properties… (the tree editor
// popover), role toggles, pairing, CDF curves. Contextual providers add
// "Copy table" and chart exports where those affordances already exist.
//
// C4: rendering goes through the vendored @gcu/menu (`Menu.show`) — the
// provider contract is unchanged ({head}/{sep}/{label, action: fn},
// plus the menu-native extras: checked, danger, children). Keyboard
// nav, typeahead, submenus and dismissal come from the library.

var CTX_PROVIDERS = [];

function ctxToMenuItem(it) {
  if (it.sep) return '---';
  if (it.head) return { label: it.label, disabled: true };
  var mi = { label: it.label, action: it.action, disabled: !!it.disabled };
  if (it.checked !== undefined) mi.checked = it.checked;
  if (it.danger) mi.danger = true;
  if (it.children) mi.children = it.children.map(ctxToMenuItem);
  return mi;
}

function showCtxMenu(items, x, y) {
  Menu.show(items.map(ctxToMenuItem), { x: x, y: y }).then(function(action) {
    if (typeof action === 'function') action();
  });
}

// ── Variable resolution across surfaces ──
// → { ds, name, kind: 'num'|'cat', idx } | null
function ctxResolveVariable(e) {
  var t = e.target;

  var row = t.closest && t.closest('.tree-row--edit, .tree-row--coord');
  if (row && row.dataset.name) {
    return { ds: row.dataset.ds, name: row.dataset.name, kind: row.dataset.kind,
             idx: row.dataset.idx !== undefined ? parseInt(row.dataset.idx) : null,
             axis: row.dataset.axis || null };
  }
  if (!lastCompleteData) return null;

  function modelVar(ci) {
    var name = lastCompleteData.header[ci];
    if (name === undefined) return null;
    return { ds: 'model', name: name, kind: lastCompleteData.colTypes[ci] === 'numeric' ? 'num' : 'cat', idx: ci };
  }
  function auxVar(ai) {
    if (!auxPreflightData) return null;
    var header = auxPreflightData.header.concat(auxCalcolMeta.map(function(m) { return m.name; }));
    var types = (auxPreflightData.autoTypes || []).concat(auxCalcolMeta.map(function(m) { return m.type; }));
    if (header[ai] === undefined) return null;
    return { ds: 'aux', name: header[ai], kind: types[ai] === 'numeric' ? 'num' : 'cat', idx: ai };
  }
  // A10 4c-ii: any comparison dataset's stats column (aux, d2…), resolved from
  // its completed analysis (what the stats table renders from).
  function cmpVar(dsId, ai) {
    var ds = dsById(dsId);
    if (!ds || !ds.complete) return null;
    var name = ds.complete.header[ai];
    if (name === undefined) return null;
    var kind = (ds.complete.colTypes && ds.complete.colTypes[ai] === 'numeric') ? 'num' : 'cat';
    return { ds: dsId, name: name, kind: kind, idx: ai };
  }

  // Statistics sidebar + table (model and comparison entries carry data attrs)
  var sEl = t.closest && t.closest('#panelStatistics [data-cmp-col], #panelStatistics [data-col]');
  if (sEl) {
    if (sEl.dataset.cmpCol !== undefined) return cmpVar(sEl.dataset.cmpDs, parseInt(sEl.dataset.cmpCol));
    return modelVar(parseInt(sEl.dataset.col));
  }

  // Swath variable list
  var swItem = t.closest && t.closest('#swathVarList .swath-var-item');
  if (swItem) {
    var swCb = swItem.querySelector('input[type="checkbox"]');
    if (swCb && swCb.dataset.aux === '1') {
      return swCb.dataset.name ? { ds: 'aux', name: swCb.dataset.name, kind: 'num', idx: parseInt(swCb.value) } : null;
    }
    if (swCb) return modelVar(parseInt(swCb.value));
  }

  // GT grade variable list (NOT the group-value list, which reuses the class)
  var gtItem = t.closest && t.closest('#gtVarList .gt-var-item');
  if (gtItem) {
    var gtCb = gtItem.querySelector('input[type="checkbox"]');
    if (gtCb) return modelVar(parseInt(gtCb.value));
  }

  // Categories sidebar columns
  var catItem = t.closest && t.closest('.cat-col-item[data-col]');
  if (catItem) return modelVar(parseInt(catItem.dataset.col));

  return null;
}

// ── Providers ──

// A10: right-clicking a dataset header in the tree raises its import/config
// panel (the reopen affordance — model → Import Block Model, aux → Aux). As
// per-dataset instance panels land, this opens the dataset's own instance.
CTX_PROVIDERS.push(function datasetProvider(e) {
  var sum = e.target.closest && e.target.closest('summary');
  if (!sum || !sum.parentElement || !sum.parentElement.classList.contains('tree-ds')) return null;
  var key = sum.parentElement.dataset.key || '';
  if (key.indexOf('ds:') !== 0) return null;
  var ds = key.slice(3);
  var dsObj = (typeof dsById === 'function') ? dsById(ds) : null;
  var items = [
    { head: true, label: dsLabel(ds) },
    // A10 1g-c: instance ids open their own panel (showPanel(ds) → activate-or-rebuild)
    { label: 'Open import panel', action: function() { showPanel(ds === 'model' ? 'preflight' : ds); } }
  ];
  if (ds === 'aux' && typeof clearAux === 'function') {
    items.push({ sep: true });
    items.push({ label: 'Remove dataset', danger: true, action: function() { clearAux(); } });
  } else if (ds !== 'model' && dsObj && typeof wsRemoveInstance === 'function') {
    items.push({ sep: true });
    items.push({ label: 'Remove dataset', danger: true, action: function() { wsRemoveInstance(dsObj); } });
  }
  return items;
});

CTX_PROVIDERS.push(function variableProvider(e) {
  var v = ctxResolveVariable(e);
  if (!v || !v.name) return null;
  var x = e.clientX, y = e.clientY;
  var items = [{ head: true, label: dsLabel(v.ds) + ':' + v.name }];

  // Coordinate rows: axis info + where to change it (C6-0 — these rows
  // previously fell through to the native browser menu)
  if (v.kind === 'coord') {
    items[0].label += ' — ' + (v.axis || '?') + ' axis';
    items.push({ label: 'Change axis assignment…', action: function() {
      showPanel(v.ds === 'model' ? 'preflight' : v.ds);
    } });
    items.push({ label: 'Copy column name', action: function() {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v.name);
    } });
    return items;
  }

  items.push({ label: 'Properties…', action: function() { openTreeEditor(v.ds, v.name, v.kind, v.idx, x, y); } });

  if (v.kind === 'num') {
    // role toggles read as checkmarks (stable labels, state on the check)
    items.push({ label: 'Weight', checked: catRole(v.ds, 'weight') === v.name,
      action: function() { treeToggleRole(v, 'weight'); } });
    if (v.ds === 'model') {
      items.push({ label: 'Density (GT)', checked: catRole('model', 'density') === v.name,
        action: function() { treeToggleRole(v, 'density'); } });
      items.push({ label: 'Tonnage factor (GT)', checked: catRole('model', 'tonnageFactor') === v.name,
        action: function() { treeToggleRole(v, 'tonnageFactor'); } });
      // CDF curve toggle (Statistics panel state, usable from anywhere)
      if (lastCompleteData && typeof statsCdfSelected !== 'undefined' && v.idx !== null) {
        var on = statsCdfSelected.has(v.idx);
        items.push({ label: 'CDF curve', checked: on, action: function() {
          if (on) statsCdfSelected.delete(v.idx); else statsCdfSelected.add(v.idx);
          if (typeof renderStatsCdfPanel === 'function') renderStatsCdfPanel();
          if (typeof renderStatsTable === 'function') renderStatsTable();
          autoSaveProject();
        } });
      }
    }
  }

  if (v.ds === 'aux') {
    // pairing as an inline submenu: every legal model target, radio-style
    // checkmark on the current one (was: bounce to the Properties popover)
    var p = catPair(v.name);
    function setPair(target) {
      return function() {
        catSetPair(v.name, target);
        treePairChanged();
        autoSaveProject();
      };
    }
    var pairKids = [{ label: '— unpaired', checked: p === null, action: setPair(null) }];
    var targets = (typeof treePairTargets === 'function') ? treePairTargets(v.kind) : [];
    for (var ti = 0; ti < targets.length; ti++) {
      pairKids.push({ label: targets[ti], checked: targets[ti] === p, action: setPair(targets[ti]) });
    }
    pairKids.push({ sep: true });
    pairKids.push({ label: 'Edit in Properties…', action: function() { openTreeEditor(v.ds, v.name, v.kind, v.idx, x, y); } });
    items.push({ label: 'Paired with' + (p ? ': ' + p : ''), children: pairKids });
  }

  if (v.kind === 'cat' && v.ds === 'model' && v.idx !== null) {
    items.push({ label: 'Focus in Categories', action: function() {
      catFocusedCol = v.idx;
      showPanel('categories');
      if (typeof renderCatSidebar === 'function') { renderCatSidebar(); renderCatMain(); }
      autoSaveProject();
    } });
  }
  return items;
});

// Categories value rows: jump straight to the value color picker
CTX_PROVIDERS.push(function catValueProvider(e) {
  var tr = e.target.closest && e.target.closest('#catValueTable tr[data-val]');
  if (!tr || catFocusedCol === null || typeof _catData === 'undefined' || !_catData) return null;
  var colName = _catData.header[catFocusedCol];
  var val = tr.dataset.val;
  var swatch = tr.querySelector('.cat-swatch, [data-val]');
  return [
    { head: true, label: colName + ' = ' + val },
    { label: 'Set color…', action: function() { showCatColorPicker(colName, val, swatch || tr); } }
  ];
});

// Tables that already have a copy affordance
CTX_PROVIDERS.push(function copyTableProvider(e) {
  var scope = e.target.closest && e.target.closest('.section, .stats-table-area, .cat-main');
  if (!scope) return null;
  var btn = scope.querySelector('.copy-table-btn, .stats-copy-btn');
  if (!btn || btn.offsetParent === null) return null;
  return [{ label: 'Copy table', action: function() { btn.click(); } }];
});

// CDF/Prob/Q-Q chart exports (buttons already exist on the panel)
CTX_PROVIDERS.push(function cdfExportProvider(e) {
  if (!e.target.closest || !e.target.closest('#statsCdfPanel')) return null;
  var svgBtn = document.getElementById('statsDownloadSvg');
  var pngBtn = document.getElementById('statsDownloadPng');
  if (!svgBtn) return null;
  return [
    { label: 'Download chart SVG', action: function() { svgBtn.click(); } },
    { label: 'Download chart PNG', action: function() { if (pngBtn) pngBtn.click(); } }
  ];
});

// ── Wiring ──
// Dismissal (outside click, Escape, item activation) is the library's;
// right-click outside an open menu dismisses AND re-fires contextmenu, so
// rolling from one target to the next just works.
(function() {
  document.addEventListener('contextmenu', function(e) {
    if (e.ctrlKey) return; // escape hatch: native menu
    var items = [];
    for (var i = 0; i < CTX_PROVIDERS.length; i++) {
      var got;
      try { got = CTX_PROVIDERS[i](e); } catch (err) { got = null; }
      if (got && got.length) {
        if (items.length > 0) items.push({ sep: true });
        items = items.concat(got);
      }
    }
    if (items.length === 0) return;
    e.preventDefault();
    showCtxMenu(items, e.clientX, e.clientY);
  });
  window.addEventListener('blur', function() { Menu.dismiss(); });
})();