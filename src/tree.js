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
  if (!open) return;

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
    return '<div class="tree-row">' +
      '<span class="tree-chip" style="background:' + color + '"></span>' +
      '<span class="tree-name" title="' + esc(e.name) + '">' + esc(e.name) + '</span>' +
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
    return '<div class="tree-row">' +
      '<span class="tree-chip tree-chip--cat"></span>' +
      '<span class="tree-name" title="' + esc(e.name) + '">' + esc(e.name) + '</span>' + nVals +
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

// Toggle button (static template element)
(function() {
  var $btn = document.getElementById('treeToggle');
  if ($btn) $btn.addEventListener('click', toggleCatalogTree);
})();
