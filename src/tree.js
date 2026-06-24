// ─── Catalog tree (C1a step 2: read-only) ─────────────────────────────
// Left panel listing datasets → variable groups (Coordinates / Grades /
// Categories / Calculated) with the catalog's properties: series color
// chips, unit chips, role badges, model↔aux pairing indicators, orphans,
// and stale entries. Container-agnostic render (C1b re-homes it as a dock
// panel; C1c as a mobile sheet). Editing lands in step 3.

var catalogTreeOpen = null;   // null = default by viewport (open ≥ 701px)
var _treeRefreshQueued = false;
var treeSearchQuery = '';     // tree filter (by variable name); filtered in place, not re-rendered

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

  // Search box (filters variable rows by name, in place) — only once there's a
  // project to search.
  var hasProject = (typeof currentFile !== 'undefined' && currentFile) ||
                   (typeof currentProjectId !== 'undefined' && currentProjectId);
  var html = hasProject
    ? '<div class="tree-search"><input type="text" id="treeSearch" class="tree-search-input" placeholder="Filter variables…" spellcheck="false" value="' + esc(treeSearchQuery) + '"></div>'
    : '';
  // Model node always; then every comparison dataset that has been loaded
  // (preflight present). Derived datasets (an emitted collar / composite /
  // intervals carries derivedFrom.set) nest UNDER their source set instead of
  // listing flat — the catalog reads as a layer/filesystem tree. A derived
  // dataset whose parent isn't loaded falls back to the top level (never hidden).
  var childrenMap = {}, hasParent = {};
  for (var di = 0; di < datasets.length; di++) {
    var dd = datasets[di];
    if (dd.id === 'model' || !dd.preflight) continue;
    var pid = dd.derivedFrom && dd.derivedFrom.set;
    var par = pid && pid !== dd.id && typeof dsById === 'function' ? dsById(pid) : null;
    if (par && par.preflight) {
      (childrenMap[pid] = childrenMap[pid] || []).push(dd.id);
      hasParent[dd.id] = true;
    }
  }
  html += treeBuildDsNode('model', openState, childrenMap);
  for (var di = 0; di < datasets.length; di++) {
    if (datasets[di].id === 'model' || !datasets[di].preflight) continue;
    if (hasParent[datasets[di].id]) continue;   // rendered nested under its set
    html += treeBuildDsNode(datasets[di].id, openState, childrenMap);
  }
  // A10 #18: add comparison datasets straight from the Data rail (mirrors the
  // [+] launcher / Data menu) — the most discoverable spot once a model exists.
  if ((typeof currentFile !== 'undefined' && currentFile) ||
      (typeof currentProjectId !== 'undefined' && currentProjectId)) {
    html += '<button type="button" class="tree-add-ds" data-tree-add>+ Add dataset</button>';
  }
  // C6-5 discoverability footer: the variable context menu (C4) and tab
  // splitting are both undiscoverable affordances — name them once results exist.
  if (typeof lastCompleteData !== 'undefined' && lastCompleteData) {
    var hint = 'Right-click a variable for actions';
    if (typeof wsRails !== 'undefined' && wsRails) hint += ' · drag a tab edge to split the view';
    html += '<div class="tree-foot-hint">' + hint + '</div>';
  }
  $tree.innerHTML = html;
  applyTreeFilter();   // re-apply the active filter to the freshly built rows
  if (typeof wsApplyAllViewTabTitles === 'function') wsApplyAllViewTabTitles();   // C10: tab titles ← view titles
}

// Filter the tree's variable rows by treeSearchQuery, IN PLACE (no innerHTML
// rebuild — keeps the search input focused while typing). Hides non-matching
// rows + any group/dataset left with no visible rows; opens details so matches show.
function applyTreeFilter() {
  var $tree = document.getElementById('catalogTree');
  if (!$tree) return;
  var q = (treeSearchQuery || '').trim().toLowerCase();
  var rows = $tree.querySelectorAll('.tree-row--edit, .tree-row--coord');
  rows.forEach(function(row) {
    var name = (row.getAttribute('data-name') || '').toLowerCase();
    row.style.display = (!q || (typeof fuzzyMatch === 'function' ? fuzzyMatch(q, name) : name.indexOf(q) >= 0)) ? '' : 'none';
  });
  var containers = $tree.querySelectorAll('details.tree-group, details.tree-ds');
  if (q) {
    $tree.querySelectorAll('details').forEach(function(d) { d.open = true; });
    containers.forEach(function(d) {
      var anyVisible = Array.prototype.some.call(
        d.querySelectorAll('.tree-row--edit, .tree-row--coord'),
        function(r) { return r.style.display !== 'none'; });
      d.style.display = anyVisible ? '' : 'none';
    });
  } else {
    containers.forEach(function(d) { d.style.display = ''; });
  }
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
  // point dataset (aux, d2, …): preflight header + calcols (analysis optional).
  // Read from the registry entry so this generalizes past the single aux; the
  // 'aux' entry's getters return the legacy aux* globals (bit-identical).
  var e = (typeof dsById === 'function') ? dsById(ds) : null;
  var ph = e ? e.preflight : auxPreflightData;
  if (!ph) return null;
  var cmeta = e ? e.calcolMeta : auxCalcolMeta;
  var comp = e ? e.complete : auxCompleteData;
  var pfx = e ? e.prefix : auxPrefix;
  var fil = e ? e.file : auxFile;
  var header = ph.header.slice();
  var colTypes = (ph.autoTypes || []).slice();
  for (var ci = 0; ci < cmeta.length; ci++) {
    header.push(cmeta[ci].name);
    colTypes.push(cmeta[ci].type);
  }
  var axyz = ph.xyz || { x: -1, y: -1, z: -1 };
  var auxCoordIdx = {};
  auxCoordIdx[axyz.x] = 'X'; auxCoordIdx[axyz.y] = 'Y'; auxCoordIdx[axyz.z] = 'Z';
  delete auxCoordIdx[-1];
  return {
    header: header, colTypes: colTypes, origColCount: ph.header.length,
    coordIdx: auxCoordIdx, categories: comp ? comp.categories : null,
    label: pfx || 'aux', fileName: fil ? fil.name : '',
    countNote: comp && comp.rowCount != null
      ? comp.rowCount.toLocaleString() + ' rows' : 'not analyzed'
  };
}

function treeRoleBadges(ds, name) {
  var b = '';
  if (catRole(ds, 'weight') === name) b += '<span class="tree-badge" title="support weight (Statistics/Swath)">W</span>';
  if (ds === 'model' && catRole('model', 'density') === name) b += '<span class="tree-badge" title="density (GT)">ρ</span>';
  if (ds === 'model' && catRole('model', 'tonnageFactor') === name) b += '<span class="tree-badge" title="tonnage factor (GT)">TF</span>';
  return b;
}

function treeEmptyBadge(ds, idx) {
  if (!colIsEmpty(ds, idx)) return '';
  return '<span class="tree-badge tree-badge--empty" title="' + EMPTY_COL_TITLE + '">∅</span>';
}

function treeMixedBadge(ds, idx) {
  var n = colParseFails(ds, idx);
  if (n === 0) return '';
  return '<span class="tree-badge" title="' + esc(mixedColTitle(n)) + '">✱</span>';
}

function treeUnitChip(ds, name) {
  var u = catPropUnit(ds, name);
  if (!u || !GRADE_UNITS[u] || !GRADE_UNITS[u].symbol) return '';
  return '<span class="tree-unit">' + esc(GRADE_UNITS[u].symbol) + '</span>';
}

function treePairChip(ds, name) {
  var p = catModelMember(ds, name);
  if (p) return '<span class="tree-pair" title="grouped with model:' + esc(p) + '">⇄ ' + esc(p) + '</span>';
  return '<span class="tree-pair tree-pair--orphan" title="no model counterpart — compared nowhere">⇄ —</span>';
}

// C12-P1b: the unified staleness + Refresh surface. A dataset node shows a
// "stale" badge + ↻ when its analysis (or the composite it derives from) is
// stale — one place that follows the whole DAG. Refresh re-runs the right
// node's derive() (composite first when its recipe changed, so the re-composite
// cascades into the analysis; else just re-analyze). Only when the dataset has
// been analyzed (a derivation node exists) — a never-run dataset is incomplete,
// not stale. Mirrors the per-panel buttons (executeBtn / Analyze) into the tree.
function treeDsRefreshHtml(ds) {
  if (typeof derivById !== 'function') return '';
  var a = derivById('analysis:' + ds), c = derivById('composite:' + ds);
  var aStale = !!(a && a.stale), cStale = !!(c && c.stale);
  if (!aStale && !cStale) return '';
  var target = cStale ? ('composite:' + ds) : ('analysis:' + ds);
  var title = cStale ? 'Recipe or source changed — re-composite & refresh' : 'Source changed — re-run analysis';
  return '<span class="tree-ds-stale" title="' + esc(title) + '">stale</span>' +
    '<button class="tree-ds-refresh" data-refresh="' + esc(target) + '" title="Refresh — ' + esc(title) + '">↻</button>';
}

// C11-P2: a derived (emitted) dataset shows its mode — ◇ linked (re-derives) or
// ◆ materialized (frozen snapshot, link kept). Visible state, no-magic-only-ui.
function treeDsDerivedHtml(ds) {
  var dsObj = (typeof dsById === 'function') ? dsById(ds) : null;
  if (!dsObj || !dsObj.derivedFrom) return '';
  var mat = (typeof dsIsMaterialized === 'function') && dsIsMaterialized(dsObj);
  var html = '<span class="tree-ds-derived' + (mat ? ' tree-ds-derived--mat' : '') + '" title="' +
    (mat ? 'materialized — frozen snapshot, source link kept' : 'linked — re-derives & re-analyzes from ' + esc(dsObj.derivedFrom.set) + ' on open') + '">' +
    (mat ? '◆ materialized' : '◇ linked') + '</span>';
  // dependents badge: a derived dataset that feeds views is load-bearing — show it
  // (and, while linked, that those views rely on it re-deriving — right-click to
  // Materialize/freeze it self-contained).
  var dep = (typeof dsDependentViewCount === 'function') ? dsDependentViewCount(ds) : 0;
  if (dep > 0) {
    // warn when dependents exist but the dataset couldn't be recreated (no file +
    // not materialized → its source set isn't loaded) — don't silently strand views
    var broken = !mat && !dsObj.file;
    var t = dep + ' view' + (dep === 1 ? '' : 's') + ' depend on this dataset';
    t += broken ? ' — but it could not be recreated (its source isn’t loaded). Re-drop the source or open the project folder.'
                : (mat ? '' : ' — right-click ▸ Materialize to freeze it self-contained');
    html += '<span class="tree-ds-dependents' + (broken ? ' tree-ds-dependents--warn' : '') + '" title="' + esc(t) + '">' +
      (broken ? '⚠ ' : '') + dep + ' ▦</span>';
  }
  // timing nudge: this derived dataset was slow to recreate — offer a one-click freeze
  if (!mat && dsObj._slowDerive && typeof dsMaterialize === 'function') {
    html += '<button class="tree-ds-mat-nudge" data-materialize="' + esc(ds) + '" title="This was slow to recreate — materialize (freeze a snapshot) so reloads skip re-deriving it">⚡ materialize?</button>';
  }
  return html;
}

// C10: the VIEWS (Statistics, GT, …) targeting a dataset — the reverse index of the
// per-view "Dataset" picker. Every live view (the default panel + any clones) is
// listed; each row focuses its panel on click, and can be renamed (✎) / duplicated
// (⎘) / removed (✕). Returns row HTML strings.
function treeViewRows(ds) {
  if (typeof viewsForDataset !== 'function') return [];
  return viewsForDataset(ds).map(function (s) {
    var title = surfaceTitle(s.id);
    var custom = (typeof surfaceHasCustomTitle === 'function') && surfaceHasCustomTitle(s.id);
    return '<div class="tree-row tree-surface" data-surface="' + esc(s.id) + '" tabindex="0" title="Click to focus this view">' +
      '<span class="tree-surface-dot tree-surface-dot--' + esc(s.kind) + '"></span>' +
      '<span class="tree-name tree-surface-name">' + esc(title) + '</span>' +
      (custom ? '<span class="tree-surface-kind">' + esc(s.label) + '</span>' : '') +
      '<button class="tree-surface-edit" data-surface-edit="' + esc(s.id) + '" title="Rename this view">✎</button>' +
      (typeof viewCanDuplicate === 'function' && viewCanDuplicate(s.id) ? '<button class="tree-surface-edit tree-view-dup" data-view-dup="' + esc(s.id) + '" title="Duplicate this view">⎘</button>' : '') +
      '<button class="tree-surface-edit tree-view-del" data-view-del="' + esc(s.id) + '" title="' + (s.clone ? 'Delete this view' : 'Close this view') + '">✕</button>' +
      '</div>';
  });
}

// The Views group under a dataset — every view (default panels + clones) targeting
// it + a "+" to add one. Shown for EVERY dataset (not just the model); an unanalyzed
// dataset shows the analyze-first hint and no creator (you make a view over results).
function treeViewsGroupHtml(ds, openState, analyzed) {
  var rows = analyzed ? treeViewRows(ds) : [];
  var gKey = 'g:' + ds + ':views';
  var gOpen = openState[gKey] !== undefined ? openState[gKey] : true;   // open by default (hint teaches when empty)
  var inner = rows.length ? rows.join('')
    : (analyzed
        ? '<div class="tree-views-empty">No views here yet — <b>+ New view</b> to add one.</div>'
        : '<div class="tree-views-empty"><b>Analyze</b> this dataset to create views over it.</div>');
  var add = analyzed ? '<button class="tree-views-add" data-view-add="' + esc(ds) + '" title="Create a view for this dataset">+ New view</button>' : '';
  return '<details class="tree-group tree-views-group" data-key="' + gKey + '"' + (gOpen ? ' open' : '') + '>' +
    '<summary>Views <span class="tree-count">' + rows.length + '</span>' + add + '</summary>' +
    inner + '</details>';
}

// Inline-rename a view's row (the ✎ button + the context menu both call this).
function treeStartRenameView(sid) {
  var srow = document.querySelector('#catalogTree .tree-surface[data-surface="' + sid + '"]');
  var nameEl = srow && srow.querySelector('.tree-surface-name');
  if (!nameEl || srow.querySelector('.tree-surface-input')) return;
  var inp = document.createElement('input');
  inp.className = 'tree-surface-input'; inp.spellcheck = false;
  inp.value = (typeof surfaceTitle === 'function') ? surfaceTitle(sid) : nameEl.textContent;
  nameEl.replaceWith(inp); inp.focus(); inp.select();
  var committed = false;
  var commit = function (save) {
    if (committed) return; committed = true;
    if (save && typeof surfaceSetTitle === 'function') surfaceSetTitle(sid, inp.value);   // re-renders the tree
    else if (typeof renderCatalogTree === 'function') renderCatalogTree();
  };
  inp.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
    else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
  });
  inp.addEventListener('blur', function () { commit(true); });
  inp.addEventListener('click', function (ev) { ev.stopPropagation(); });
}

function treeDatasetHtml(ds, openState, childrenHtml) {
  childrenHtml = childrenHtml || '';
  var v = treeDatasetVars(ds);
  var dsKey = 'ds:' + ds;
  var dsOpen = openState[dsKey] !== undefined ? openState[dsKey] : true;
  var head = '<summary><span class="tree-ds-label">' + esc(dsLabel(ds)) + '</span>' +
    (v && v.fileName ? '<span class="tree-ds-file" title="' + esc(v.fileName) + '">' + esc(v.fileName) + '</span>' : '') +
    // "not analyzed" becomes an actionable Analyze button (discoverability — Arthur)
    (v && v.countNote === 'not analyzed'
      ? '<button class="tree-ds-analyze" data-analyze="' + esc(ds) + '" title="Analyze this dataset to unlock stats, pairing & views">Analyze ▸</button>'
      : (v && v.countNote ? '<span class="tree-ds-count">' + esc(v.countNote) + '</span>' : '')) +
    (v ? treeDsRefreshHtml(ds) : '') +
    treeDsDerivedHtml(ds) +
    '</summary>';

  if (!v) {
    return '<details class="tree-ds" data-key="' + dsKey + '"' + (dsOpen ? ' open' : '') + '>' + head +
      '<div class="tree-hint">Run Analyze to populate.</div>' + childrenHtml + '</details>';
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

  // stale catalog entries: members of a display-carrying property that this
  // dataset no longer has (renamed calcol etc.) — kept, shown grayed (4a:
  // display is property-level, so flag members of properties that hold display)
  var stale = [];
  for (var pid in catalog.properties) {
    var pp = catalog.properties[pid];
    var hasDisp = pp.color || pp.unit || pp.sortMode ||
      (pp.valueColors && Object.keys(pp.valueColors).length) || (pp.valueOrder && pp.valueOrder.length);
    if (!hasDisp || !pp.members) continue;
    for (var mi = 0; mi < pp.members.length; mi++) {
      if (pp.members[mi].ds === ds && !known[pp.members[mi].col]) stale.push(pp.members[mi].col);
    }
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
        if (pr && modelPal[pr] !== undefined) color = catPropColor('model', pr, modelPal[pr]);
      }
    }
    if (!color) color = catPropColor(ds, e.name, (ds === 'aux' ? auxModelOffset : 0) + e.palIdx);
    return '<div class="tree-row tree-row--edit"' + rowAttrs(e, 'num') + ' title="click to edit">' +
      '<span class="tree-chip" style="background:' + color + '"></span>' +
      '<span class="tree-name">' + esc(e.name) + '</span>' +
      treeUnitChip(ds, e.name) + treeRoleBadges(ds, e.name) + treeEmptyBadge(ds, e.idx) + treeMixedBadge(ds, e.idx) +
      (ds !== 'model' ? treePairChip(ds, e.name) : '') +
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
      (ds !== 'model' ? treePairChip(ds, e.name) : '') +
      '</div>';
  }
  function coordRow(c) {
    // data attrs so the context menu resolves coordinate rows too (C6-0)
    return '<div class="tree-row tree-row--coord" data-ds="' + ds + '" data-name="' + esc(c.name) + '" data-kind="coord" data-axis="' + c.axis + '">' +
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
  // C10: Views — analyses kept for this dataset. Shown for EVERY dataset (universal
  // capability); unanalyzed ones show the analyze-first hint.
  var dsAnalyzed = (ds === 'model') ? (typeof lastCompleteData !== 'undefined' && !!lastCompleteData)
    : !!(typeof dsById === 'function' && dsById(ds) && dsById(ds).complete);
  body += treeViewsGroupHtml(ds, openState, dsAnalyzed);

  // dataset-level note: declustered-weights sentinel isn't a variable
  var dsNote = '';
  if (ds === 'aux' && catRole('aux', 'weight') === AUX_DECLUS_WEIGHT) {
    dsNote = '<div class="tree-ds-note" title="aux support weight: computed declustering weights"><span class="tree-badge">W</span> declustered weights</div>';
  }

  return '<details class="tree-ds" data-key="' + dsKey + '"' + (dsOpen ? ' open' : '') + '>' +
    head + dsNote + body + childrenHtml + '</details>';
}

// Build a dataset node + recursively nest its derived children (datasets whose
// derivedFrom.set points back to it) under it — the catalog reads as a filesystem
// / GIS layer panel: a container set and the datasets it emits. `seen` guards the
// (data-model-impossible but cheap to rule out) cycle.
function treeBuildDsNode(ds, openState, childrenMap, seen) {
  seen = seen || {};
  if (seen[ds]) return '';
  seen[ds] = true;
  var kids = childrenMap[ds] || [];
  var childHtml = '';
  if (kids.length) {
    childHtml = '<div class="tree-ds-children">' +
      kids.map(function(k) { return treeBuildDsNode(k, openState, childrenMap, seen); }).join('') +
      '</div>';
  }
  return treeDatasetHtml(ds, openState, childHtml);
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
  var html = '<div class="tree-pop-head">' + esc(dsLabel(ds)) + ':' + esc(name) + '</div>';

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
    var u = catPropUnit(ds, name);
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

  if (ds !== 'model') {
    var p = catModelMember(ds, name);
    var targets = treePairTargets(t.kind);
    html += '<div class="tree-pop-label">Grouped with (model)</div><select class="tree-pop-select" id="treePopPair">';
    html += '<option value=""' + (p === null ? ' selected' : '') + '>— ungrouped</option>';
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
  // A10 4c-iv: refresh stats when ANY comparison dataset exists, not just aux
  var hasCmp = typeof statsCmpDatasets === 'function' && statsCmpDatasets().length > 0;
  if (lastCompleteData && hasCmp && typeof renderStatsTable === 'function') {
    if (typeof renderStatsSidebar === 'function') renderStatsSidebar();
    renderStatsTable();
  }
  if (typeof renderCatMain === 'function' && panelState.categories.focusedCol !== null && typeof _catData !== 'undefined' && _catData) renderCatMain();
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
      var $asel = (typeof auxQ === 'function') ? auxQ('[data-aux="weight"]') : null;
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
    // Tree search — filter in place (no re-render → input keeps focus)
    $tree.addEventListener('input', function(e) {
      if (e.target && e.target.id === 'treeSearch') {
        treeSearchQuery = e.target.value;
        applyTreeFilter();
      }
    });
    $tree.addEventListener('click', function(e) {
      // C12-P1b: Refresh a stale derivation. preventDefault so the click on the
      // button inside <summary> doesn't toggle the dataset's open/closed state.
      var refresh = e.target.closest('[data-refresh]');
      if (refresh) {
        e.preventDefault(); e.stopPropagation();
        if (typeof derivRefresh === 'function') derivRefresh(refresh.getAttribute('data-refresh'));
        return;
      }
      // C10: Analyze an unanalyzed dataset straight from its tree header
      var analyzeBtn = e.target.closest('[data-analyze]');
      if (analyzeBtn) {
        e.preventDefault(); e.stopPropagation();
        if (typeof wsAnalyzeDataset === 'function') wsAnalyzeDataset(analyzeBtn.getAttribute('data-analyze'));
        return;
      }
      // timing nudge: materialize (freeze) a slow-to-recreate derived dataset
      var matBtn = e.target.closest('[data-materialize]');
      if (matBtn) {
        e.preventDefault(); e.stopPropagation();
        var mds = (typeof dsById === 'function') ? dsById(matBtn.getAttribute('data-materialize')) : null;
        if (mds && typeof dsMaterialize === 'function') { mds._slowDerive = false; Promise.resolve(dsMaterialize(mds)).then(function () { if (typeof renderCatalogTree === 'function') renderCatalogTree(); }); }
        return;
      }
      var add = e.target.closest('[data-tree-add]');
      if (add) {
        // A10 #18: a small menu of add paths, anchored under the button.
        var r = add.getBoundingClientRect();
        if (typeof Menu !== 'undefined' && typeof wsMenuAction === 'function') {
          Menu.show([
            { label: 'Add point dataset…', action: 'addPoint' },
            { label: 'Add drillhole set…', action: 'addDrillhole' },
          ], { x: r.left, y: r.bottom }).then(function(a) { if (a) wsMenuAction(a); });
        } else if (typeof wsAddPointDataset === 'function') {
          wsAddPointDataset();   // legacy/<700px fallback (no Menu mounted)
        }
        return;
      }
      // C10: + New view — pick a kind, create it targeting this dataset
      var vadd = e.target.closest('[data-view-add]');
      if (vadd) {
        e.preventDefault(); e.stopPropagation();
        var dsForView = vadd.getAttribute('data-view-add');
        var r = vadd.getBoundingClientRect();
        if (typeof Menu !== 'undefined' && typeof VIEW_CREATE_KINDS !== 'undefined' && typeof wsCreateView === 'function') {
          Menu.show(VIEW_CREATE_KINDS.map(function (k) { return { label: k.label, action: { newView: k.kind, ds: dsForView } }; }), { x: r.left, y: r.bottom })
            .then(function (a) { if (a && a.newView) wsCreateView(a.newView, a.ds); });
        }
        return;
      }
      // C10: duplicate / delete a view
      var vdup = e.target.closest('[data-view-dup]');
      if (vdup) { e.preventDefault(); e.stopPropagation(); if (typeof wsDuplicateView === 'function') wsDuplicateView(vdup.getAttribute('data-view-dup')); return; }
      var vdel = e.target.closest('[data-view-del]');
      if (vdel) {
        e.preventDefault(); e.stopPropagation();
        var vid = vdel.getAttribute('data-view-del');
        var clone = vid.indexOf('#') >= 0;
        Promise.resolve(typeof bmaConfirm === 'function'
          ? bmaConfirm({ title: clone ? 'Delete view' : 'Close view', okLabel: clone ? 'Delete' : 'Close', cancelLabel: 'Cancel',
              html: clone ? 'Delete this view? Its analysis config is discarded.' : 'Close this view? Re-add it any time with <b>+ New view</b>.' })
          : true).then(function (ok) { if (ok && typeof wsDeleteView === 'function') wsDeleteView(vid); });
        return;
      }
      // C10: rename a view (✎) — inline edit (also reachable from the context menu)
      var ed = e.target.closest('[data-surface-edit]');
      if (ed) { e.preventDefault(); e.stopPropagation(); treeStartRenameView(ed.getAttribute('data-surface-edit')); return; }
      // C10: focus the surface a row names
      var surfRow = e.target.closest('.tree-surface');
      if (surfRow) { if (typeof showPanel === 'function') showPanel(surfRow.getAttribute('data-surface')); return; }
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
        if (t.idx !== null) { panelState.categories.focusedCol = t.idx; }
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
        catSetMember(t.ds, t.name, e.target.value || null);
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
