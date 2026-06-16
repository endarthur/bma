// ─── Filter Expression System ────────────────────────────────────────
function rebuildFilterExpression() {
  // Gather checked values grouped by column (body cells only — the C6-4c
  // header select-all has no data-col and must not pollute the filter)
  const groups = {};
  $catValueTable.querySelectorAll('.cat-cb-cell input[type="checkbox"]:checked').forEach(cb => {
    const col = cb.dataset.col;
    if (!groups[col]) groups[col] = [];
    groups[col].push(cb.dataset.val);
  });

  // Helper: proper JS accessor for column name
  const colRef = (name) => {
    const v = currentRowVar;
    return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) ? `${v}.${name}` : `${v}["${name}"]`;
  };

  // Build expression: OR within column, AND across columns
  const parts = [];
  for (const [colIdx, vals] of Object.entries(groups)) {
    const col = colRef(currentHeader[parseInt(colIdx)]);
    const conditions = vals.map(v => `${col} == "${v}"`);
    parts.push(conditions.length === 1 ? conditions[0] : `(${conditions.join(' || ')})`);
  }

  // Get any existing manual/numeric parts the user typed
  const currentExpr = $filterExpr.value.trim();
  const autoExpr = parts.join(' && ');

  // If user hasn't manually edited, just replace entirely
  if (!currentExpr || currentExpr === lastAutoExpr) {
    $filterExpr.value = autoExpr;
  } else {
    // User has custom content — try to replace the auto-generated portion
    if (lastAutoExpr && currentExpr.includes(lastAutoExpr)) {
      $filterExpr.value = autoExpr
        ? currentExpr.replace(lastAutoExpr, autoExpr)
        : currentExpr.replace(lastAutoExpr, '').replace(/^\s*&&\s*|\s*&&\s*$/, '').trim();
    } else if (autoExpr) {
      // Can't find old auto part — append
      $filterExpr.value = currentExpr ? `${currentExpr} && ${autoExpr}` : autoExpr;
    }
  }
  lastAutoExpr = autoExpr;
}
let lastAutoExpr = '';

// Apply filter
$filterApply.addEventListener('click', () => {
  const expr = $filterExpr.value.trim();
  $filterError.classList.remove('active');
  $filterError.style.color = '';
  if (!expr) {
    currentFilter = null;
    startAnalysis(currentXYZ, null, undefined, undefined, undefined, undefined);
    return;
  }
  if (filterExprController) {
    const result = filterExprController.validate();
    if (!result.valid) return;
  }
  currentFilter = { expression: expr };
  startAnalysis(currentXYZ, currentFilter, undefined, undefined, undefined, undefined);
});

// Filter expression autocomplete + Enter-to-apply
const filterExprController = createExprInput($filterExpr, {
  errorElement: $filterError,
  mode: 'filter',
  validateOnBlur: true,
  onEnter: function() { $filterApply.click(); }
});

// Clear filter
$filterClear.addEventListener('click', () => {
  $filterExpr.value = '';
  lastAutoExpr = '';
  currentFilter = null;
  $filterError.classList.remove('active');
  // Uncheck all checkboxes
  $catValueTable.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
    cb.checked = false;
    cb.closest('tr').classList.remove('active');
  });
  startAnalysis(currentXYZ, null, undefined, undefined, undefined, undefined);
});

// Click-to-copy on geometry cells (event delegation)
$geoContent.addEventListener('click', (e) => {
  const cell = e.target.closest('.gc[data-value]');
  if (!cell) return;
  const val = cell.dataset.value;
  navigator.clipboard.writeText(val).then(() => {
    cell.classList.add('copied');
    setTimeout(() => cell.classList.remove('copied'), 800);
  });
});

// Copy full geometry table
let lastGeoData = null;
document.getElementById('copyGeoBtn').addEventListener('click', (e) => {
  if (!lastGeoData) return;
  const btn = e.currentTarget;
  const g = lastGeoData;
  const fmt = (v) => (v != null && v !== undefined) ? String(v) : '';
  const anySubBlocked = g.x.isSubBlocked || g.y.isSubBlocked || g.z.isSubBlocked;
  const rows = [
    ['', 'X', 'Y', 'Z'],
    ['Origin', fmt(g.x.origin), fmt(g.y.origin), fmt(g.z.origin)],
    ['Block Size', fmt(g.x.blockSize), fmt(g.y.blockSize), fmt(g.z.blockSize)],
  ];
  if (anySubBlocked) {
    rows.push(['Min Block', fmt(g.x.minBlockSize), fmt(g.y.minBlockSize), fmt(g.z.minBlockSize)]);
  }
  rows.push(
    ['Unique', fmt(g.x.uniqueCount), fmt(g.y.uniqueCount), fmt(g.z.uniqueCount)],
    ['Grid Count', fmt(g.x.gridCount), fmt(g.y.gridCount), fmt(g.z.gridCount)],
    ['Extent', fmt(g.x.extent), fmt(g.y.extent), fmt(g.z.extent)],
  );
  const tsv = rows.map(r => r.join('\t')).join('\n');
  navigator.clipboard.writeText(tsv).then(() => {
    btn.classList.add('copied');
    btn.textContent = 'Copied!';
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.textContent = 'Copy table';
    }, 1200);
  });
});

// Copy column overview table
document.getElementById('copyColOverviewBtn').addEventListener('click', (e) => {
  const table = document.querySelector('.col-overview');
  if (!table) return;
  const btn = e.currentTarget;
  const rows = [];
  table.querySelectorAll('tr').forEach(tr => {
    const cells = [];
    tr.querySelectorAll('th, td').forEach(td => cells.push(td.textContent.trim()));
    rows.push(cells.join('\t'));
  });
  const tsv = rows.join('\n');
  navigator.clipboard.writeText(tsv).then(() => {
    btn.classList.add('copied');
    btn.textContent = 'Copied!';
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.textContent = 'Copy table';
    }, 1200);
  });
});

// Sniff units from column names
function sniffUnits() {
  if (!currentHeader || currentHeader.length === 0) return;
  var patterns = [
    { re: /[_\s]ppm\b|\(ppm\)$/i, idx: 2 },
    { re: /[_\s]ppb\b|\(ppb\)$/i, idx: 3 },
    { re: /[_\s](?:pct|perc|prcnt)\b|\(%\)$/i, idx: 1 },
    { re: /[_\s]gt\b|\(g\/t\)$/i, idx: 4 },
    { re: /[_\s](?:opt|ozt)\b|\(oz\/t\)$/i, idx: 5 }
  ];
  var changed = false;
  for (var i = 0; i < currentHeader.length; i++) {
    if (currentColTypes[i] !== 'numeric') continue;
    var name = currentHeader[i];
    for (var pi = 0; pi < patterns.length; pi++) {
      if (patterns[pi].re.test(name)) {
        catSetUnit('model', name, patterns[pi].idx);
        changed = true;
        break;
      }
    }
  }
  if (changed) {
    catRefreshUnitSelects();
    autoSaveProject();
  }
}

function refreshColumnUnitSelects() {
  catRefreshUnitSelects();
}

document.getElementById('sniffUnitsBtn').addEventListener('click', sniffUnits);

// Column unit select change
document.getElementById('colOverviewContent').addEventListener('change', function(e) {
  if (e.target.classList.contains('col-unit-select')) {
    var colName = e.target.dataset.colName;
    catSetUnit('model', colName, parseInt(e.target.value));
    catRefreshUnitSelects();
    autoSaveProject();
  }
});

// Export bounding box as OBJ
// Write an axis-aligned bounding box as a Wavefront .obj (8 verts, 6 quads).
// b = { xMin, xMax, yMin, yMax, zMin, zMax }; shared by the model geometry
// export and the per-dataset (point/drillhole) bbox export (A10).
function downloadBboxObj(b, fname) {
  fname = fname || 'dataset';
  const obj = `# BMA Bounding Box \u2014 ${fname}
v ${b.xMin} ${b.yMin} ${b.zMin}
v ${b.xMax} ${b.yMin} ${b.zMin}
v ${b.xMax} ${b.yMax} ${b.zMin}
v ${b.xMin} ${b.yMax} ${b.zMin}
v ${b.xMin} ${b.yMin} ${b.zMax}
v ${b.xMax} ${b.yMin} ${b.zMax}
v ${b.xMax} ${b.yMax} ${b.zMax}
v ${b.xMin} ${b.yMax} ${b.zMax}
f 1 2 3 4
f 5 8 7 6
f 1 5 6 2
f 2 6 7 3
f 3 7 8 4
f 4 8 5 1
`;
  const blob = new Blob([obj], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fname.replace(/\.[^.]+$/, '') + '_bbox.obj';
  a.click();
  URL.revokeObjectURL(a.href);
}

document.getElementById('exportObjBtn').addEventListener('click', () => {
  if (!lastGeoData) return;
  const g = lastGeoData;
  const gx = g.x, gy = g.y, gz = g.z;
  downloadBboxObj({
    xMin: gx.origin - gx.blockSize / 2,
    xMax: gx.origin + gx.gridCount * gx.blockSize - gx.blockSize / 2,
    yMin: gy.origin - gy.blockSize / 2,
    yMax: gy.origin + gy.gridCount * gy.blockSize - gy.blockSize / 2,
    zMin: gz.origin - gz.blockSize / 2,
    zMax: gz.origin + gz.gridCount * gz.blockSize - gz.blockSize / 2
  }, currentFile ? currentFile.name : 'model');
});

// ─── A14: per-dataset filter modal (from the data-item context menu) ──────
// Dataset-generic: edit any dataset's .filter, preview the surviving size two
// ways — an INSTANT estimate from the preflight sample, and an EXACT one-pass
// count on demand — then Apply (sets .filter + re-analyzes through the
// dataset's normal path). Honest labeling: the estimate is always marked ~.
var _dsFilterTarget = null;       // the ds being edited
var _dsFilterController = null;   // createExprInput controller (rebuilt per open)
var _dsFilterCountWorker = null;  // exact-count worker in flight

// Build typed sample row objects (with calcols) for one dataset — the estimate
// substrate. Mirrors getSampleRows() but is ds-generic and uses the full sample.
function dsFilterSampleRows(ds) {
  var pf = ds && ds.preflight;
  if (!pf || !pf.sampleRows) return [];
  var hdr = pf.header, types = pf.autoTypes || [], typeOv = pf.typeOverrides || {};
  var calFn = null;
  if (ds.calcolCode) {
    try { calFn = new Function(ds.rowVar, MATH_PREAMBLE_MAIN + ds.calcolCode); } catch (e) { calFn = null; }
  }
  return pf.sampleRows.map(function(fields) {
    var obj = {};
    for (var i = 0; i < hdr.length; i++) {
      var raw = (fields[i] || '').trim().replace(/^["']|["']$/g, '');
      var t = typeOv[i] || types[i];
      obj[hdr[i]] = t === 'numeric' ? (raw === '' ? null : (isNaN(Number(raw)) ? raw : Number(raw))) : raw;
    }
    if (calFn) { obj.META = { cat: [], num: [] }; try { calFn(obj); } catch (e) {} delete obj.META; }
    return obj;
  });
}

// Head-sniff estimate: fraction of the preflight sample (the FILE HEAD) passing
// the expression. Fallback only — the head is biased on sorted files.
function dsFilterEstimate(ds, expr) {
  var rows = dsFilterSampleRows(ds);
  if (rows.length === 0) return null;
  var fn;
  try { fn = new Function(ds.rowVar, MATH_PREAMBLE_MAIN + 'return (' + expr + ');'); }
  catch (e) { return { error: e.message }; }
  var kept = 0, errs = 0;
  for (var i = 0; i < rows.length; i++) {
    try { if (fn(rows[i])) kept++; } catch (e) { errs++; }
  }
  return { sampleN: rows.length, kept: kept, errs: errs, ratio: kept / rows.length };
}

// Distribution-modeled estimate (Arthur's idea): Monte-Carlo over the per-column
// t-digest centroids + category counts from the last analysis. Sort-order
// unbiased (unlike the head sniff) and accurate for single-column predicates.
// CAVEAT: it samples each column independently from its MARGINAL, so the joint
// correlation between columns is lost — multi-column filters on correlated
// columns can be off. Honest label + the exact count cover that.
var DS_FILTER_SYNTH_N = 4000;
function dsFilterSynthEstimate(ds, expr) {
  var c = ds.complete;
  if (!c || !c.stats || !c.header || !c.colTypes) return null;
  var hdr = c.header, colTypes = c.colTypes, stats = c.stats, cats = c.categories || {};
  var origCount = c.origColCount || hdr.length;
  // Per-column samplers: cumulative-weight arrays built once (binary-searched
  // per draw) so 4000 rows over many columns stays instant.
  var samplers = [];
  for (var ci = 0; ci < origCount; ci++) {
    var name = hdr[ci], s = stats[ci];
    if (colTypes[ci] === 'numeric' && s && s.centroids && s.centroids.length) {
      var cum = [], t = 0;
      for (var k = 0; k < s.centroids.length; k++) { t += s.centroids[k][1]; cum.push(t); }
      samplers.push({ name: name, kind: 'num', vals: s.centroids, cum: cum, total: t, fb: s.mean });
    } else if (colTypes[ci] === 'numeric' && s) {
      samplers.push({ name: name, kind: 'const', val: s.mean });
    } else if (colTypes[ci] === 'categorical' && cats[ci] && cats[ci].counts) {
      var es = Object.entries(cats[ci].counts), cum2 = [], t2 = 0;
      for (var k2 = 0; k2 < es.length; k2++) { t2 += es[k2][1]; cum2.push(t2); }
      samplers.push({ name: name, kind: 'cat', vals: es, cum: cum2, total: t2, fb: es.length ? es[0][0] : '' });
    } else {
      samplers.push({ name: name, kind: 'null' });
    }
  }
  var calFn = null;
  if (ds.calcolCode) { try { calFn = new Function(ds.rowVar, MATH_PREAMBLE_MAIN + ds.calcolCode); } catch (e) {} }
  var fn;
  try { fn = new Function(ds.rowVar, MATH_PREAMBLE_MAIN + 'return (' + expr + ');'); }
  catch (e) { return { error: e.message }; }
  function bsearch(cum, r) { var lo = 0, hi = cum.length - 1; while (lo < hi) { var m = (lo + hi) >> 1; if (cum[m] < r) lo = m + 1; else hi = m; } return lo; }
  var N = DS_FILTER_SYNTH_N, kept = 0, errs = 0;
  for (var i = 0; i < N; i++) {
    var obj = {};
    for (var si = 0; si < samplers.length; si++) {
      var sm = samplers[si];
      if (sm.kind === 'num' || sm.kind === 'cat') {
        var idx = bsearch(sm.cum, Math.random() * sm.total);
        obj[sm.name] = sm.vals[idx] ? sm.vals[idx][0] : sm.fb;
      } else if (sm.kind === 'const') { obj[sm.name] = sm.val; }
      else { obj[sm.name] = null; }
    }
    if (calFn) { obj.META = { cat: [], num: [] }; try { calFn(obj); } catch (e) {} delete obj.META; }
    try { if (fn(obj)) kept++; } catch (e) { errs++; }
  }
  return { n: N, kept: kept, ratio: kept / N, errs: errs, pop: c.rowCount || null };
}

function dsFilterRenderEstimate() {
  var ds = _dsFilterTarget, $c = document.getElementById('dsFilterCount');
  if (!ds || !$c) return;
  var expr = (document.getElementById('dsFilterExpr').value || '').trim();
  if (!expr) {
    var pop0 = ds.complete && ds.complete.rowCount ? ds.complete.rowCount : null;
    $c.innerHTML = '<span class="ds-filter-est">No filter — all ' + (pop0 != null ? pop0.toLocaleString() + ' ' : '') + 'rows kept.</span>';
    return;
  }
  // Prefer the distribution-modeled estimate when the dataset has been analyzed
  // (sort-order unbiased); fall back to the head sniff otherwise.
  var m = dsFilterSynthEstimate(ds, expr);
  if (m && !m.error) {
    var pct = Math.round(m.ratio * 100);
    var html = '<span class="ds-filter-est">≈ <strong>' + pct + '%</strong>';
    if (m.pop != null) html += ' &middot; ≈ ' + Math.round(m.ratio * m.pop).toLocaleString() + ' of ' + m.pop.toLocaleString() + ' rows';
    html += ' <span class="ds-filter-est-tag">modeled</span> — from the column distributions; assumes columns vary independently, so multi-column filters may differ. Exact count for the real number.</span>';
    if (m.errs > 0) html += ' <span class="ds-filter-est--err">(' + m.errs + ' modeled rows errored)</span>';
    $c.innerHTML = html;
    return;
  }
  if (m && m.error) { $c.innerHTML = '<span class="ds-filter-est ds-filter-est--err">Expression error: ' + esc(m.error) + '</span>'; return; }
  // Fallback: not analyzed yet → head sniff (explicitly non-representative)
  var e = dsFilterEstimate(ds, expr);
  if (!e) { $c.innerHTML = '<span class="ds-filter-est">Analyze the dataset for a size estimate, or use Exact count.</span>'; return; }
  if (e.error) { $c.innerHTML = '<span class="ds-filter-est ds-filter-est--err">Expression error: ' + esc(e.error) + '</span>'; return; }
  var hp = Math.round(e.ratio * 100);
  var hh = '<span class="ds-filter-est">First ' + e.sampleN + ' rows: <strong>' + e.kept + '</strong> pass (' + hp + '%) ' +
    '<span class="ds-filter-est-tag">head sample</span> — not analyzed yet; head is unrepresentative of a sorted file. Exact count for the real number.</span>';
  if (e.errs > 0) hh += ' <span class="ds-filter-est--err">(' + e.errs + ' sample row' + (e.errs === 1 ? '' : 's') + ' errored)</span>';
  $c.innerHTML = hh;
}

function dsFilterExactCount() {
  var ds = _dsFilterTarget;
  if (!ds || !ds.file || !ds.preflight) return;
  var expr = (document.getElementById('dsFilterExpr').value || '').trim();
  var $c = document.getElementById('dsFilterCount');
  var $btn = document.getElementById('dsFilterExact');
  if (_dsFilterCountWorker) { try { _dsFilterCountWorker.terminate(); } catch (e) {} _dsFilterCountWorker = null; }
  if ($btn) $btn.disabled = true;
  $c.innerHTML = '<span class="ds-filter-est">Counting… <span id="dsFilterCountPct">0%</span></span>';
  var typeOv = {};
  for (var ti = 0; ti < ds.preflight.autoTypes.length; ti++) typeOv[ti] = ds.preflight.autoTypes[ti];
  var w = new Worker(workerUrl);
  _dsFilterCountWorker = w;
  w.postMessage({
    mode: 'count',
    file: ds.file,
    zipEntry: ds.preflight.selectedZipEntry || null,
    globalFilter: expr ? { expression: expr } : null,
    calcolCode: ds.calcolCode || null,
    calcolMeta: (ds.calcolMeta && ds.calcolMeta.length > 0) ? ds.calcolMeta : null,
    resolvedTypes: ds.preflight.autoTypes,
    rowVarOverride: ds.rowVar,
    dmEndianness: ds.preflight.dmEndianness || null,
    dmFormat: ds.preflight.dmFormat || null
  });
  w.onerror = function(ev) {
    if (_dsFilterCountWorker !== w) return;
    $c.innerHTML = '<span class="ds-filter-est ds-filter-est--err">Count failed: ' + esc(ev.message || 'worker error') + '</span>';
    try { w.terminate(); } catch (e) {} _dsFilterCountWorker = null; if ($btn) $btn.disabled = false;
  };
  w.onmessage = function(ev) {
    var m = ev.data;
    if (m.type === 'count-progress') {
      var pe = document.getElementById('dsFilterCountPct');
      if (pe) pe.textContent = Math.min(99, m.percent).toFixed(0) + '%';
    } else if (m.type === 'count-complete') {
      var pct = m.total > 0 ? Math.round(m.kept / m.total * 100) : 0;
      var html = '<span class="ds-filter-est"><strong>' + m.kept.toLocaleString() + '</strong> of ' + m.total.toLocaleString() +
        ' rows pass (' + pct + '%) <span class="ds-filter-est-tag ds-filter-est-tag--exact">exact</span></span>';
      // No silent loss: surface filter/calcol errors the count encountered
      if (m.filterErrors && m.filterErrors.count > 0) html += ' <span class="ds-filter-est--err">' + m.filterErrors.count.toLocaleString() + ' rows errored in the filter (excluded)</span>';
      if (m.calcolErrors && m.calcolErrors.count > 0) html += ' <span class="ds-filter-est--err">' + m.calcolErrors.count.toLocaleString() + ' calcol errors</span>';
      $c.innerHTML = html;
      try { w.terminate(); } catch (e) {} _dsFilterCountWorker = null; if ($btn) $btn.disabled = false;
    } else if (m.type === 'error') {
      $c.innerHTML = '<span class="ds-filter-est ds-filter-est--err">' + esc(m.message) + '</span>';
      try { w.terminate(); } catch (e) {} _dsFilterCountWorker = null; if ($btn) $btn.disabled = false;
    }
  };
}

function dsFilterClose() {
  var $m = document.getElementById('dsFilterModal');
  if ($m) $m.classList.remove('active');
  if (_dsFilterController) { try { _dsFilterController.destroy(); } catch (e) {} _dsFilterController = null; }
  if (_dsFilterCountWorker) { try { _dsFilterCountWorker.terminate(); } catch (e) {} _dsFilterCountWorker = null; }
  _dsFilterTarget = null;
}

function dsFilterApply() {
  var ds = _dsFilterTarget;
  if (!ds) return;
  var expr = (document.getElementById('dsFilterExpr').value || '').trim();
  if (expr && _dsFilterController) {
    var r = _dsFilterController.validate();
    if (!r.valid) return;
  }
  var f = expr ? { expression: expr } : null;
  ds.filter = f;
  // Keep an open config-panel filter input in sync (comparison datasets)
  if (ds.id !== 'model') {
    var ta = auxQ('[data-aux="filter"]', dsConfigRoot(ds));
    if (ta) ta.value = expr;
  } else {
    var $fe = document.getElementById('filterExpr');
    if ($fe) $fe.value = expr;
    currentFilter = f;
  }
  dsFilterClose();
  // Re-analyze through the dataset's normal path
  if (ds.id === 'model') {
    startAnalysis(currentXYZ, f, undefined, undefined, undefined, undefined);
  } else if (typeof runAuxAnalysis === 'function') {
    runAuxAnalysis(ds, dsConfigRoot(ds));
  }
  if (typeof autoSaveProject === 'function') autoSaveProject();
}

// Open the filter modal for a dataset (called from the ctx menu).
function openDatasetFilterModal(ds) {
  if (!ds) return;
  _dsFilterTarget = ds;
  var $m = document.getElementById('dsFilterModal');
  document.getElementById('dsFilterTitle').textContent = 'Filter — ' + dsLabel(ds.id);
  document.getElementById('dsFilterRowVar').textContent = '(' + ds.rowVar + '.column …)';
  var $expr = document.getElementById('dsFilterExpr');
  $expr.value = ds.filter ? ds.filter.expression : '';
  $expr.placeholder = ds.rowVar + '.Fe > 30';
  if (_dsFilterController) { try { _dsFilterController.destroy(); } catch (e) {} }
  // Filter autocomplete scoped to this dataset's columns (createExprInput reads
  // the active dataset via its mode; default 'filter' targets the model — for
  // comparison datasets the estimate/exact count still validate by evaluation)
  _dsFilterController = createExprInput($expr, { mode: 'filter' });
  $m.classList.add('active');
  dsFilterRenderEstimate();
  $expr.focus();
}

(function wireDsFilterModal() {
  var $expr = document.getElementById('dsFilterExpr');
  if ($expr) $expr.addEventListener('input', dsFilterRenderEstimate);
  var byId = function(id, fn) { var el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
  byId('dsFilterExact', dsFilterExactCount);
  byId('dsFilterApply', dsFilterApply);
  byId('dsFilterCancel', dsFilterClose);
  byId('dsFilterClose', dsFilterClose);
  byId('dsFilterClear', function() {
    var e = document.getElementById('dsFilterExpr'); if (e) e.value = '';
    dsFilterRenderEstimate();
  });
})();

