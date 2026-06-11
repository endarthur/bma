// ─── Catalog tree (C1a step 2: read-only) ─────────────────────────────
// Left panel listing datasets → variable groups (Coordinates / Grades /
// Categories / Calculated) with the catalog's properties: series color
// chips, unit chips, role badges, model↔aux pairing indicators, orphans,
// and stale entries. Container-agnostic render (C1b re-homes it as a dock
// panel; C1c as a mobile sheet). Editing lands in step 3.

var catalogTreeOpen = null;   // null = default by viewport (open ≥ 701px)
var _treeRefreshQueued = false;

function catalogTreeIsOpen() {
  if (catalogTreeOpen === null) return window.matchMedia('(min-width: 701px)').matches;
  return !!catalogTreeOpen;
}

function toggleCatalogTree() {
  catalogTreeOpen = !catalogTreeIsOpen();
  if (wsRails) wsSyncTreeRail(); // rails shell: collapse/expand the tree rail
  renderCatalogTree();
  autoSaveProject();
}

// Cheap coalesced refresh — hooked into autoSaveProject(), which every
// config mutation already calls (the new-tab checklist convention)
function refreshCatalogTree() {
  if (_treeRefreshQueued) return;
  _treeRefreshQueued = true;
  requestAnimationFrame(function() {
    _treeRefreshQueued = false;
    renderCatalogTree();
  });
}

function renderCatalogTree(container) {
  var $tree = container || document.getElementById('catalogTree');
  var $results = document.getElementById('results');
  if (!$tree) return;
  var open = catalogTreeIsOpen();
  if ($results) $results.classList.toggle('tree-open', open);
  var $btn = document.getElementById('treeToggle');
  if ($btn) $btn.classList.toggle('active', open);
  if (wsRails) {
    // rails shell: the tree rail's collapsed state owns visibility — keep
    // it aligned and always render content (cheap; current when expanded)
    wsSyncTreeRail();
  } else if (!open) {
    return;
  }

  catEnsureSeeded();

  // Preserve <details> open/closed across re-renders
  var openState = {};
  $tree.querySelectorAll('details[data-key]').forEach(function(d) {
    openState[d.dataset.key] = d.open;
  });

  var html = treeDatasetHtml('model', openState);
  if (auxFile && auxPreflightData) html += treeDatasetHtml('aux', openState);
  $tree.innerHTML = html;
}

// Variable description for one dataset, derived from the live headers —
// the catalog stays sparse, so the tree renders from the data, not from
// catalog.vars keys
function treeDatasetVars(ds) {
  if (ds === 'model') {
    if (!lastCompleteData) return null;
    var d = lastCompleteData;
    var xyz = currentXYZ || { x: -1, y: -1, z: -1 };
    var dxyz = currentDXYZ || { dx: -1, dy: -1, dz: -1 };
    var coordIdx = {};
    coordIdx[xyz.x] = 'X'; coordIdx[xyz.y] = 'Y'; coordIdx[xyz.z] = 'Z';
    coordIdx[dxyz.dx] = 'dX'; coordIdx[dxyz.dy] = 'dY'; coordIdx[dxyz.dz] = 'dZ';
    delete coordIdx[-1];
    return {
      header: d.header, colTypes: d.colTypes, origColCount: d.origColCount,
      coordIdx: coordIdx, categories: d.categories,
      label: 'Model', fileName: currentFile ? currentFile.name : '',
      countNote: d.rowCount != null ? d.rowCount.toLocaleString() + ' rows' : ''
    };
  }
  // aux: preflight header + calcols (analysis optional)
  var ph = auxPreflightData;
  var header = ph.header.slice();
  var colTypes = (ph.autoTypes || []).slice();
  for (var ci = 0; ci < auxCalcolMeta.length; ci++) {
    header.push(auxCalcolMeta[ci].name);
    colTypes.push(auxCalcolMeta[ci].type);
  }
  var axyz = ph.xyz || { x: -1, y: -1, z: -1 };
  var auxCoordIdx = {};
  auxCoordIdx[axyz.x] = 'X'; auxCoordIdx[axyz.y] = 'Y'; auxCoordIdx[axyz.z] = 'Z';
  delete auxCoordIdx[-1];
  return {
    header: header, colTypes: colTypes, origColCount: ph.header.length,
    coordIdx: auxCoordIdx, categories: auxCompleteData ? auxCompleteData.categories : null,
    label: auxPrefix || 'aux', fileName: auxFile ? auxFile.name : '',
    countNote: auxCompleteData && auxCompleteData.rowCount != null
      ? auxCompleteData.rowCount.toLocaleString() + ' rows' : 'not analyzed'
  };
}

function treeRoleBadges(ds, name) {
  var b = '';
  if (catRole(ds, 'weight') === name) b += '<span class="tree-badge" title="support weight (Statistics/Swath)">W</span>';
  if (ds === 'model' && catRole('model', 'density') === name) b += '<span class="tree-badge" title="density (GT)">ρ</span>';
  if (ds === 'model' && catRole('model', 'tonnageFactor') === name) b += '<span class="tree-badge" title="tonnage factor (GT)">TF</span>';
  return b;
}

function treeUnitChip(ds, name) {
  var u = catUnit(ds, name);
  if (!u || !GRADE_UNITS[u] || !GRADE_UNITS[u].symbol) return '';
  return '<span class="tree-unit">' + esc(GRADE_UNITS[u].symbol) + '</span>';
}

function treePairChip(name) {
  var p = catPair(name);
  if (p) return '<span class="tree-pair" title="paired with model:' + esc(p) + '">⇄ ' + esc(p) + '</span>';
  return '<span class="tree-pair tree-pair--orphan" title="no model counterpart — compared nowhere">⇄ —</span>';
}

function treeDatasetHtml(ds, openState) {
  var v = treeDatasetVars(ds);
  var dsKey = 'ds:' + ds;
  var dsOpen = openState[dsKey] !== undefined ? openState[dsKey] : true;
  var head = '<summary><span class="tree-ds-label">' + esc(ds === 'model' ? 'Model' : (auxPrefix || 'aux')) + '</span>' +
    (v && v.fileName ? '<span class="tree-ds-file" title="' + esc(v.fileName) + '">' + esc(v.fileName) + '</span>' : '') +
    (v && v.countNote ? '<span class="tree-ds-count">' + esc(v.countNote) + '</span>' : '') +
    '</summary>';

  if (!v) {
    return '<details class="tree-ds" data-key="' + dsKey + '"' + (dsOpen ? ' open' : '') + '>' + head +
      '<div class="tree-hint">Run Analyze to populate.</div></details>';
  }

  // classify
  var coords = [], grades = [], cats = [], calcs = [];
  var known = {};
  var numIdx = 0; // palette position, mirrors the swath sidebar ordering
  for (var i = 0; i < v.header.length; i++) {
    var name = v.header[i];
    known[name] = true;
    var isCalc = i >= v.origColCount;
    var axis = !isCalc ? v.coordIdx[i] : undefined;
    if (axis) { coords.push({ name: name, axis: axis }); continue; }
    var isNum = v.colTypes[i] === 'numeric';
    var entry = { name: name, idx: i, isNum: isNum };
    if (isNum) { entry.palIdx = numIdx++; }
    if (isCalc) calcs.push(entry);
    else if (isNum) grades.push(entry);
    else cats.push(entry);
  }

  // stale catalog entries: records that reference variables this dataset
  // no longer has (renamed calcol etc.) — kept, shown grayed
  var stale = [];
  for (var key in catalog.vars) {
    if (key.indexOf(ds + ':') !== 0) continue;
    var vn = key.slice(ds.length + 1);
    if (!known[vn] && Object.keys(catalog.vars[key]).length > 0) stale.push(vn);
  }

  var auxModelOffset = 0;
  var modelPal = {};
  if (ds === 'aux' && lastCompleteData) {
    // aux palette fallback continues after the model's numeric vars, and a
    // paired aux variable shows its primary's EFFECTIVE color (palette
    // included) — both matching the swath sidebar's assignment
    var mv = treeDatasetVars('model');
    var mCoord = mv ? mv.coordIdx : {};
    for (var mi = 0; mi < lastCompleteData.header.length; mi++) {
      if (lastCompleteData.colTypes[mi] === 'numeric' && !mCoord[mi]) {
        modelPal[lastCompleteData.header[mi]] = auxModelOffset++;
      }
    }
  }

  function rowAttrs(e, kind) {
    return ' data-ds="' + ds + '" data-name="' + esc(e.name) + '" data-kind="' + kind + '"' +
      (e.idx !== undefined ? ' data-idx="' + e.idx + '"' : '');
  }
  function numRow(e) {
    var color = null;
    if (ds === 'aux') {
      var rec = catVarPeek('aux', e.name);
      if (rec && rec.color) color = rec.color;
      else {
        var pr = catPair(e.name);
        if (pr && modelPal[pr] !== undefined) color = catVarColor('model', pr, modelPal[pr]);
      }
    }
    if (!color) color = catVarColor(ds, e.name, (ds === 'aux' ? auxModelOffset : 0) + e.palIdx);
    return '<div class="tree-row tree-row--edit"' + rowAttrs(e, 'num') + ' title="click to edit">' +
      '<span class="tree-chip" style="background:' + color + '"></span>' +
      '<span class="tree-name">' + esc(e.name) + '</span>' +
      treeUnitChip(ds, e.name) + treeRoleBadges(ds, e.name) +
      (ds === 'aux' ? treePairChip(e.name) : '') +
      '</div>';
  }
  function catRow(e) {
    var nVals = '';
    if (v.categories && v.categories[e.idx] && v.categories[e.idx].counts) {
      nVals = '<span class="tree-count">' + Object.keys(v.categories[e.idx].counts).length +
        (v.categories[e.idx].overflow ? '+' : '') + '</span>';
    }
    return '<div class="tree-row tree-row--edit"' + rowAttrs(e, 'cat') + ' title="click to edit">' +
      '<span class="tree-chip tree-chip--cat"></span>' +
      '<span class="tree-name">' + esc(e.name) + '</span>' + nVals +
      treeRoleBadges(ds, e.name) +
      (ds === 'aux' ? treePairChip(e.name) : '') +
      '</div>';
  }
  function coordRow(c) {
    return '<div class="tree-row tree-row--coord">' +
      '<span class="tree-axis">' + c.axis + '</span>' +
      '<span class="tree-name" title="' + esc(c.name) + '">' + esc(c.name) + '</span>' +
      '</div>';
  }
  function calcRow(e) {
    return e.isNum ? numRow(e) : catRow(e);
  }
  function group(label, rows, key) {
    if (rows.length === 0) return '';
    var gKey = 'g:' + ds + ':' + key;
    var gOpen = openState[gKey] !== undefined ? openState[gKey] : true;
    return '<details class="tree-group" data-key="' + gKey + '"' + (gOpen ? ' open' : '') + '>' +
      '<summary>' + label + ' <span class="tree-count">' + rows.length + '</span></summary>' +
      rows.join('') + '</details>';
  }

  var body =
    group('Coordinates', coords.map(coordRow), 'coords') +
    group('Grades', grades.map(numRow), 'grades') +
    group('Categories', cats.map(catRow), 'cats') +
    group('Calculated', calcs.map(calcRow), 'calc') +
    (stale.length > 0
      ? group('Missing', stale.map(function(n) {
          return '<div class="tree-row tree-row--stale" title="catalog entry with no matching variable">' +
            '<span class="tree-chip tree-chip--stale"></span><span class="tree-name">' + esc(n) + '</span></div>';
        }), 'stale')
      : '');

  // dataset-level note: declustered-weights sentinel isn't a variable
  var dsNote = '';
  if (ds === 'aux' && catRole('aux', 'weight') === AUX_DECLUS_WEIGHT) {
    dsNote = '<div class="tree-ds-note" title="aux support weight: computed declustering weights"><span class="tree-badge">W</span> declustered weights</div>';
  }

  return '<details class="tree-ds" data-key="' + dsKey + '"' + (dsOpen ? ' open' : '') + '>' +
    head + dsNote + body + '</details>';
}

// ─── Row editor popover (C1a step 3) ──────────────────────────────────
// One fixed-position popover per row: series color, unit, roles, pairing.
// Lives outside the tree so re-renders (autoSaveProject → refresh) don't
// destroy it mid-edit; content re-renders in place after each action.

var _treePopTarget = null; // { ds, name, kind }

function treePopoverEl() { return document.getElementById('treePopover'); }

function hideTreePopover() {
  var $p = treePopoverEl();
  if ($p) $p.classList.remove('open');
  _treePopTarget = null;
}

// Model numeric variables (incl. calcols, excl. coordinates) — the legal
// pairing targets for an aux variable of the same kind
function treePairTargets(kind) {
  var v = treeDatasetVars('model');
  if (!v) return [];
  var out = [];
  for (var i = 0; i < v.header.length; i++) {
    if (v.coordIdx[i]) continue;
    var isNum = v.colTypes[i] === 'numeric';
    if ((kind === 'num') === isNum) out.push(v.header[i]);
  }
  return out;
}

// Open the variable editor for any surface (works with the tree closed —
// the context menu uses it from stats/swath/GT/categories rows too)
function openTreeEditor(ds, name, kind, idx, x, y) {
  _treePopTarget = { ds: ds, name: name, kind: kind, idx: idx != null ? idx : null };
  renderTreePopover();
  var $p = treePopoverEl();
  $p.style.top = Math.max(4, Math.min(y, window.innerHeight - 320)) + 'px';
  $p.style.left = Math.max(4, Math.min(x, window.innerWidth - 260)) + 'px';
  $p.classList.add('open');
}

function showTreePopover(row) {
  var r = row.getBoundingClientRect();
  openTreeEditor(row.dataset.ds, row.dataset.name, row.dataset.kind,
    row.dataset.idx !== undefined ? parseInt(row.dataset.idx) : null,
    r.left + 12, r.bottom + 4);
}

function renderTreePopover() {
  var t = _treePopTarget;
  var $p = treePopoverEl();
  if (!t || !$p) return;
  var ds = t.ds, name = t.name;
  var html = '<div class="tree-pop-head">' + esc(ds === 'model' ? 'Model' : (auxPrefix || 'aux')) + ':' + esc(name) + '</div>';

  if (t.kind === 'num') {
    // Series color — explicit override or "auto" (palette / pair-inherited)
    var rec = catVarPeek(ds, name);
    var cur = rec && rec.color ? rec.color : '';
    html += '<div class="tree-pop-label">Series color</div><div class="cat-color-grid">';
    for (var i = 0; i < STATSCAT_PALETTE.length; i++) {
      var c = STATSCAT_PALETTE[i];
      html += '<div class="cat-color-swatch' + (c.toLowerCase() === cur.toLowerCase() ? ' selected' : '') +
        '" style="background:' + c + '" data-treecolor="' + c + '"></div>';
    }
    html += '</div><div class="tree-pop-row">' +
      '<input type="text" class="cat-hex-input" id="treePopHex" placeholder="#hex" value="' + esc(cur) + '">' +
      '<button class="tree-pop-btn" id="treePopColorAuto" title="clear override — palette / paired color">auto</button></div>';

    // Unit (one per variable — D2)
    var u = catUnit(ds, name);
    html += '<div class="tree-pop-label">Unit</div><select class="tree-pop-select" id="treePopUnit">';
    for (var ui = 0; ui < GRADE_UNITS.length; ui++) {
      html += '<option value="' + ui + '"' + (ui === u ? ' selected' : '') + '>' + esc(GRADE_UNITS[ui].label) + '</option>';
    }
    html += '</select>';

    // Roles
    html += '<div class="tree-pop-label">Roles</div><div class="tree-pop-row">';
    html += '<button class="tree-pop-btn' + (catRole(ds, 'weight') === name ? ' active' : '') +
      '" data-treerole="weight" title="support weight (Statistics/Swath)">Weight</button>';
    if (ds === 'model') {
      html += '<button class="tree-pop-btn' + (catRole('model', 'density') === name ? ' active' : '') +
        '" data-treerole="density" title="density (GT tonnage)">Density</button>';
      html += '<button class="tree-pop-btn' + (catRole('model', 'tonnageFactor') === name ? ' active' : '') +
        '" data-treerole="tonnageFactor" title="tonnage factor (GT)">TF</button>';
    }
    html += '</div>';
  }

  if (t.kind === 'cat' && ds === 'model') {
    html += '<div class="tree-pop-label">Values</div>' +
      '<button class="tree-pop-btn" id="treePopCatTab">edit colors & order in Categories →</button>';
  }

  if (ds === 'aux') {
    var p = catPair(name);
    var targets = treePairTargets(t.kind);
    html += '<div class="tree-pop-label">Paired with (model)</div><select class="tree-pop-select" id="treePopPair">';
    html += '<option value=""' + (p === null ? ' selected' : '') + '>— unpaired</option>';
    for (var pi = 0; pi < targets.length; pi++) {
      html += '<option value="' + esc(targets[pi]) + '"' + (targets[pi] === p ? ' selected' : '') + '>' + esc(targets[pi]) + '</option>';
    }
    html += '</select>';
  }

  $p.innerHTML = html;
}

// After a pairing edit, nudge the consumers a user might be looking at —
// everything else resolves pairs lazily at its next render
function treePairChanged() {
  if (typeof renderSwathAuxVars === 'function') renderSwathAuxVars();
  if (lastCompleteData && auxCompleteData && typeof renderStatsTable === 'function') {
    if (typeof renderStatsSidebar === 'function') renderStatsSidebar();
    renderStatsTable();
  }
  if (typeof renderCatMain === 'function' && catFocusedCol !== null && typeof _catData !== 'undefined' && _catData) renderCatMain();
}

function treeSetColor(color) {
  var t = _treePopTarget;
  if (!t) return;
  // applySwathColor owns the write + swath swatch/chart refresh + autosave
  applySwathColor(t.ds === 'aux' ? 'aux:' + t.name : t.name, color);
  renderTreePopover();
}

// Toggle a role on/off for a variable, syncing the selects that view it —
// shared by the popover role buttons and the context menu
function treeToggleRole(t, role) {
  var active = catRole(t.ds, role) === t.name;
  catSetRole(t.ds, role, active ? null : t.name);
  var newVal = active ? '' : t.name;
  if (role === 'weight') {
    if (t.ds === 'model') {
      var $ssel = document.getElementById('statsWeightSel');
      var $swsel = document.getElementById('swathWeight');
      if ($ssel) $ssel.value = newVal;
      if ($swsel) $swsel.value = newVal;
      markAnalysisStale();
    } else {
      var $asel = document.getElementById('auxWeightSel');
      if ($asel) $asel.value = newVal;
      markAuxStale();
    }
  } else {
    // density / tonnageFactor mirror into the GT selects (GT stays the
    // owner of its analysis params — the role is the shared record)
    var gtSel = document.getElementById(role === 'density' ? 'gtDensityCol' : 'gtWeightCol');
    if (gtSel) {
      var found = '-1';
      for (var oi = 0; oi < gtSel.options.length; oi++) {
        if (gtSel.options[oi].textContent === newVal) { found = gtSel.options[oi].value; break; }
      }
      gtSel.value = newVal ? found : '-1';
    }
  }
  autoSaveProject();
}

(function() {
  var $btn = document.getElementById('treeToggle');
  if ($btn) $btn.addEventListener('click', toggleCatalogTree);

  var $tree = document.getElementById('catalogTree');
  if ($tree) {
    $tree.addEventListener('click', function(e) {
      var row = e.target.closest('.tree-row--edit');
      if (!row) return;
      showTreePopover(row);
    });
    // an edit may re-render rows under an open popover; scrolling drifts it
    $tree.addEventListener('scroll', hideTreePopover);
  }

  var $p = treePopoverEl();
  if ($p) {
    $p.addEventListener('click', function(e) {
      var t = _treePopTarget;
      if (!t) return;
      var sw = e.target.closest('[data-treecolor]');
      if (sw) { treeSetColor(sw.dataset.treecolor); return; }
      if (e.target.id === 'treePopColorAuto') {
        var rec = catVarPeek(t.ds, t.name);
        if (rec) delete rec.color;
        if (lastSwathData) renderSwathOutput();
        autoSaveProject();
        renderTreePopover();
        return;
      }
      if (e.target.id === 'treePopCatTab') {
        if (t.idx !== null) { catFocusedCol = t.idx; }
        hideTreePopover();
        showPanel('categories');
        if (typeof renderCatSidebar === 'function') { renderCatSidebar(); renderCatMain(); }
        return;
      }
      var roleBtn = e.target.closest('[data-treerole]');
      if (roleBtn) {
        treeToggleRole(t, roleBtn.dataset.treerole);
        renderTreePopover();
        return;
      }
    });
    $p.addEventListener('change', function(e) {
      var t = _treePopTarget;
      if (!t) return;
      if (e.target.id === 'treePopUnit') {
        catSetUnit(t.ds, t.name, parseInt(e.target.value));
        catRefreshUnitSelects();
        if (lastSwathData) renderSwathOutput();
        if (lastGtData) renderGtOutput();
        autoSaveProject();
        renderTreePopover();
      } else if (e.target.id === 'treePopPair') {
        catalog.pairs[t.name] = e.target.value || null;
        treePairChanged();
        autoSaveProject();
        renderTreePopover();
      } else if (e.target.id === 'treePopHex') {
        var v = e.target.value.trim();
        if (/^#[0-9a-fA-F]{3,8}$/.test(v)) treeSetColor(v);
      }
    });
  }

  // Dismiss: outside pointerdown or Escape
  document.addEventListener('pointerdown', function(e) {
    var $pop = treePopoverEl();
    if (!$pop || !$pop.classList.contains('open')) return;
    if ($pop.contains(e.target) || e.target.closest('.tree-row--edit')) return;
    hideTreePopover();
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') hideTreePopover();
  });
})();
