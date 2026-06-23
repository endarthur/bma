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
// panel (the reopen affordance — model → Import Model, aux → Aux). As
// per-dataset instance panels land, this opens the dataset's own instance.
// The dataset menu, reusable for any non-row part of a dataset node.
function datasetMenuFor(ds) {
  var dsObj = (typeof dsById === 'function') ? dsById(ds) : null;
  var items = [
    { head: true, label: dsLabel(ds) },
    // A10 1g-c: instance ids open their own panel (showPanel(ds) → activate-or-rebuild)
    { label: 'Open import panel', action: function() { showPanel(ds === 'model' ? 'preflight' : ds); } }
  ];
  // C10: analyze an unanalyzed dataset (unlocks stats/pairing/views) — discoverability
  var dsAnalyzed = (ds === 'model') ? (typeof lastCompleteData !== 'undefined' && !!lastCompleteData) : !!(dsObj && dsObj.complete);
  if (!dsAnalyzed && dsObj && dsObj.file && dsObj.preflight && typeof wsAnalyzeDataset === 'function') {
    items.push({ label: 'Analyze', action: function() { wsAnalyzeDataset(ds); } });
  }
  // A14: edit this dataset's filter (+ live size preview) without leaving the tree
  if (dsObj && dsObj.file && dsObj.preflight && typeof openDatasetFilterModal === 'function') {
    var flt = dsObj.filter && dsObj.filter.expression;
    items.push({ label: 'Filter…' + (flt ? ' ✓' : ''), action: function() { openDatasetFilterModal(dsObj); } });
  }
  // C11-P2: materialize ⇄ relink a derived (emitted) dataset — freeze a snapshot
  // (folder file / embedded) keeping the link, or revert to pure re-derive.
  if (dsObj && dsObj.derivedFrom && typeof dsMaterialize === 'function') {
    items.push({ sep: true });
    if (typeof dsIsMaterialized === 'function' && dsIsMaterialized(dsObj)) {
      items.push({ label: 'Relink (re-derive)', action: function() { dsRelink(dsObj); } });
    } else if (dsObj.file) {
      items.push({ label: 'Materialize (freeze)', action: function() { dsMaterialize(dsObj); } });
    }
  }
  if (ds === 'aux' && typeof clearAux === 'function') {
    items.push({ sep: true });
    items.push({ label: 'Remove dataset', danger: true, action: function() { clearAux(); } });
  } else if (ds !== 'model' && dsObj && typeof wsRemoveInstance === 'function') {
    items.push({ sep: true });
    items.push({ label: 'Remove dataset', danger: true, action: function() { wsRemoveInstance(dsObj); } });
  }
  return items;
}
// C10: right-click a VIEW row (Statistics/GT/… kept for a dataset) → its actions:
// focus, rename, duplicate, retarget, delete. Mirrors the row's ✎/⎘/✕ buttons for
// the right-click-native among us.
CTX_PROVIDERS.push(function viewProvider(e) {
  var row = e.target.closest && e.target.closest('.tree-surface');
  if (!row) return null;
  var id = row.getAttribute('data-surface');
  if (!id) return null;
  var kind = String(id).split('#')[0], isClone = id.indexOf('#') >= 0;
  var title = (typeof surfaceTitle === 'function') ? surfaceTitle(id) : id;
  var items = [{ head: true, label: title }];
  items.push({ label: 'Focus', action: function () { showPanel(id); } });
  items.push({ label: 'Rename…', action: function () { if (typeof treeStartRenameView === 'function') treeStartRenameView(id); } });
  if (typeof viewCanDuplicate === 'function' && viewCanDuplicate(id)) {
    items.push({ label: 'Duplicate', action: function () { if (typeof wsDuplicateView === 'function') wsDuplicateView(id); } });
  }
  // Retarget submenu — every dataset this view's kind can target, radio-checked
  var facet = (typeof viewKindFacet === 'function') ? viewKindFacet(kind) : 'analyzed';
  var targets = (typeof surfaceTargetableDatasets === 'function') ? surfaceTargetableDatasets(facet) : [];
  if (targets.length > 1 && typeof wsSetViewTarget === 'function') {
    var cur = (typeof viewTarget === 'function') ? viewTarget(id) : 'model';
    var kids = targets.map(function (d) {
      return { label: dsLabel(d.id), checked: d.id === cur, action: function () { wsSetViewTarget(kind, id, d.id); if (typeof autoSaveProject === 'function') autoSaveProject(); } };
    });
    items.push({ label: 'Target dataset', children: kids });
  }
  items.push({ sep: true });
  items.push({ label: isClone ? 'Delete' : 'Stop keeping', danger: true, action: function () {
    Promise.resolve(typeof bmaConfirm === 'function'
      ? bmaConfirm({ title: isClone ? 'Delete view' : 'Stop keeping view', okLabel: isClone ? 'Delete' : 'Stop keeping', cancelLabel: 'Cancel',
          html: isClone ? 'Delete this view? Its analysis config is discarded.' : 'Return this view to a default panel? Its custom name is cleared.' })
      : true).then(function (ok) { if (ok && typeof wsDeleteView === 'function') wsDeleteView(id); });
  } });
  return items;
});

CTX_PROVIDERS.push(function datasetProvider(e) {
  // Fire on ANY part of a dataset node that isn't a variable/coord/view row (the
  // summary, a group header, the body) — variableProvider/viewProvider handle the
  // rows. This is what makes group headers + dataset body give the dataset menu
  // instead of leaking the native browser menu.
  if (e.target.closest && e.target.closest('.tree-row--edit, .tree-row--coord, .tree-surface')) return null;
  var dsNode = e.target.closest && e.target.closest('.tree-ds');
  if (!dsNode) return null;
  var key = dsNode.dataset.key || '';
  if (key.indexOf('ds:') !== 0) return null;
  return datasetMenuFor(key.slice(3));
});

// Tree background (the +Add footer, empty space below the datasets): an
// Add-dataset menu, so right-clicking anywhere in the data panel is meaningful
// and never leaks the native menu.
CTX_PROVIDERS.push(function treeBackgroundProvider(e) {
  if (!e.target.closest || !e.target.closest('#catalogTree')) return null;
  if (e.target.closest('.tree-ds') || e.target.closest('.tree-row--edit, .tree-row--coord')) return null;
  var have = (typeof currentFile !== 'undefined' && currentFile) ||
             (typeof currentProjectId !== 'undefined' && currentProjectId);
  if (!have) return null;
  return [
    { head: true, label: 'Data' },
    { label: 'Add point dataset…', action: function() { if (typeof wsAddPointDataset === 'function') wsAddPointDataset(); } },
    { label: 'Add drillhole set…', action: function() { if (typeof wsAddDrillholeDataset === 'function') wsAddDrillholeDataset(); } }
  ];
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

  if (v.ds !== 'model') {
    // grouping as an inline submenu: every legal model target, radio-style
    // checkmark on the current one (A10 4c-iv: any comparison dataset, not
    // just aux — group/split a column into a model property)
    var p = catModelMember(v.ds, v.name);
    function setPair(target) {
      return function() {
        catSetMember(v.ds, v.name, target);
        treePairChanged();
        autoSaveProject();
      };
    }
    var pairKids = [{ label: '— ungrouped', checked: p === null, action: setPair(null) }];
    var targets = (typeof treePairTargets === 'function') ? treePairTargets(v.kind) : [];
    for (var ti = 0; ti < targets.length; ti++) {
      pairKids.push({ label: targets[ti], checked: targets[ti] === p, action: setPair(targets[ti]) });
    }
    pairKids.push({ sep: true });
    pairKids.push({ label: 'Edit in Properties…', action: function() { openTreeEditor(v.ds, v.name, v.kind, v.idx, x, y); } });
    items.push({ label: 'Grouped with' + (p ? ': ' + p : ''), children: pairKids });
  }

  if (v.kind === 'cat' && v.ds === 'model' && v.idx !== null) {
    items.push({ label: 'Focus in Categories', action: function() {
      panelState.categories.focusedCol = v.idx;
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
  if (!tr || panelState.categories.focusedCol === null || typeof _catData === 'undefined' || !_catData) return null;
  var colName = _catData.header[panelState.categories.focusedCol];
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
    if (items.length === 0) {
      // Never leak the native browser menu on the data panel, even if every
      // provider missed — the tree is app chrome, not document content.
      if (e.target.closest && e.target.closest('#catalogTree')) e.preventDefault();
      return;
    }
    e.preventDefault();
    showCtxMenu(items, e.clientX, e.clientY);
  });
  window.addEventListener('blur', function() { Menu.dismiss(); });
})();