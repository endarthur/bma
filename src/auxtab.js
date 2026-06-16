// ─── Aux dataset tab ──────────────────────────────────────────────────
// Loads a second dataset (e.g. composites/samples behind the block model)
// and configures it for comparison. Aux runs as its own analysis pass; its
// variables surface across Statistics / CDF / Swath with a display prefix.
// The display prefix (auxPrefix) is cosmetic only — aux filter/calc always
// reference columns through the fixed AUX_ROW_VAR handle ("aux.").
//
// A10 phase 1g-b: every render/analysis function is parameterized by an
// explicit (ds, root) — ds is the dataset registry entry (default: the aux
// view dsById('aux'); reading ds.* over the getter-view is bit-identical for
// the single aux), root is its config-panel element (default dsConfigRoot(ds)
// = #panelAux). DOM is resolved root-relative via auxQ(sel, root) and the
// data-aux/data-act identity attrs, so N instance panels (1g-c) can coexist.
// Worker handles stay global for 1g-b (single aux); they move onto ds in 1g-c.

function auxColOptions(selectedIdx, ds) {
  ds = ds || dsById('aux');
  var opts = '<option value="-1">— none —</option>';
  var h = ds.preflight.header;
  for (var i = 0; i < h.length; i++) {
    opts += '<option value="' + i + '"' + (i === selectedIdx ? ' selected' : '') + '>' + esc(h[i]) + '</option>';
  }
  return opts;
}

function renderAuxConfig(ds, root) {
  ds = ds || dsById('aux');
  root = root || dsConfigRoot(ds);
  if (!ds.preflight) return;
  var d = ds.preflight;
  var xyz = d.xyz || { x: -1, y: -1, z: -1 };

  // File info banner
  var meta = d.header.length + ' columns';
  if (d.isDm) meta += ' · DM ' + (d.dmFormat === 'ep' ? 'EP' : 'SP');
  else if (d.zipEntries) meta += ' · ZIP';
  var fileInfo = auxQ('[data-aux="fileInfo"]', root);
  if (fileInfo) fileInfo.innerHTML = 'Aux: <strong style="color:var(--fg-bright)">' + esc(ds.file.name) + '</strong>' +
    '<span class="zip-size">' + formatBytes(ds.file.size) + ' — ' + meta + '</span>';

  // Sidebar: zip entry + prefix + coordinates + aux filter
  var zipSection = '';
  if (d.zipEntries && d.zipEntries.length > 1) {
    var zOpts = d.zipEntries.map(function(z) {
      return '<option value="' + esc(z.name) + '"' + (z.name === d.selectedZipEntry ? ' selected' : '') + '>' + esc(z.name) + '</option>';
    }).join('');
    zipSection =
      '<div class="pf-sidebar-section" data-sb="zip">' +
        '<div class="pf-sidebar-section-title">ZIP entry</div>' +
        '<select class="aux-select" data-aux="zipEntry">' + zOpts + '</select>' +
      '</div>';
  }
  var sidebar = auxQ('[data-aux="sidebar"]', root);
  sidebar.innerHTML = zipSection +
    '<div class="pf-sidebar-section" data-sb="prefix">' +
      '<div class="pf-sidebar-section-title">Display prefix</div>' +
      '<input type="text" class="aux-input" data-aux="prefix" value="' + esc(ds.prefix) + '" placeholder="aux" spellcheck="false">' +
      '<div class="aux-hint">Label for aux variables in selection lists and plot labels (e.g. <code>' + esc(ds.prefix || 'aux') + ':Fe</code>). Cosmetic only.</div>' +
    '</div>' +
    '<div class="pf-sidebar-section" data-sb="coords">' +
      '<div class="pf-sidebar-section-title">Coordinates</div>' +
      '<div class="aux-xyz-row"><label>X</label><select class="aux-select" data-aux="x">' + auxColOptions(xyz.x, ds) + '</select></div>' +
      '<div class="aux-xyz-row"><label>Y</label><select class="aux-select" data-aux="y">' + auxColOptions(xyz.y, ds) + '</select></div>' +
      '<div class="aux-xyz-row"><label>Z</label><select class="aux-select" data-aux="z">' + auxColOptions(xyz.z, ds) + '</select></div>' +
      '<div class="aux-hint">Aux and the block model must share the same coordinate space for swath overlays to line up.</div>' +
    '</div>' +
    '<div class="pf-sidebar-section" data-sb="auxfilter">' +
      '<div class="pf-sidebar-section-title">Aux filter</div>' +
      '<textarea class="aux-input aux-filter" data-aux="filter" rows="2" spellcheck="false" placeholder="aux.Au > 0">' + esc(ds.filter ? ds.filter.expression : '') + '</textarea>' +
      '<div class="aux-hint">Reference aux columns as <code>aux.</code>… — independent of the display prefix.</div>' +
    '</div>' +
    '<div class="pf-sidebar-section" data-sb="weight">' +
      '<div class="pf-sidebar-section-title">Weight (optional)</div>' +
      '<select class="aux-select" data-aux="weight">' + auxWeightOptions(ds) + '</select>' +
      '<div class="aux-hint">A weight column, or the computed declustering weights from below — applied to all aux statistics (Statistics, CDF, Swath). Rows with missing or ≤0 weight are excluded.</div>' +
    '</div>' +
    renderAuxDeclusSection(ds) +
    '<div class="sb-footer">' +
      '<button class="swath-generate" data-act="auxAnalyze">Analyze</button>' +
      '<div class="aux-hint aux-analyze-status" data-aux="analyzeStatus">' +
        (ds.complete
          ? (ds.stale ? 'Config changed — re-run Analyze' : ds.complete.rowCount.toLocaleString() + ' rows analyzed' +
              (ds.complete.filterErrors || ds.complete.calcolErrors ? ' · ⚠ filter/calc row errors — see Statistics' : ''))
          : 'Run to compare aux statistics on the Statistics tab') +
      '</div>' +
    '</div>';

  // C6-4b — collapsible config sections; cosmetic/advanced ones collapsed
  wsEnhanceSidebar(ds.id, sidebar, { prefix: 'collapsed', auxfilter: 'collapsed', declus: 'collapsed' });
  // C6-5 — dim the Analyze button when the current result is fresh
  if (typeof setGenStale === 'function') setGenStale(auxQ('[data-act="auxAnalyze"]', root), !(ds.complete && !ds.stale));

  renderAuxPreview(ds, root);
  if (typeof renderAuxView === 'function') renderAuxView(ds, root);
  // drillhole-derived aux: provenance banner + report/re-composite links (A7).
  // Drillhole sets are aux-scoped until phase 5, so only the singleton aux's
  // panel carries the banner (renderDhProvenance resolves the singleton head).
  if (ds.id === 'aux' && typeof renderDhProvenance === 'function') renderDhProvenance();
}

function runAuxAnalysis(ds, root) {
  ds = ds || dsById('aux');
  root = root || dsConfigRoot(ds);
  if (!ds.file || !ds.preflight) return;
  if (ds._worker) { try { ds._worker.terminate(); } catch (e) {} ds._worker = null; }
  ds._worker = new Worker(workerUrl);

  var $btn = auxQ('[data-act="auxAnalyze"]', root);
  var $status = auxQ('[data-aux="analyzeStatus"]', root);
  if ($btn) $btn.disabled = true;
  if ($status) { $status.textContent = '0%'; $status.style.color = ''; }

  function fail(msg) {
    if ($btn) $btn.disabled = false;
    if ($status) { $status.textContent = 'Error: ' + msg; $status.style.color = 'var(--red)'; }
    if (ds._worker) { ds._worker.terminate(); ds._worker = null; }
  }

  var xyz = ds.preflight.xyz || { x: -1, y: -1, z: -1 };
  // Force every column's type from the preflight sample: the worker then
  // skips its detection warmup, whose rows are excluded from stats —
  // negligible on block models but a real bias on small sample files
  var auxTypeOverrides = {};
  for (var ti = 0; ti < ds.preflight.autoTypes.length; ti++) {
    auxTypeOverrides[ti] = ds.preflight.autoTypes[ti];
  }
  // Declustered weights: computed array, gated on a fresh fingerprint so the
  // row ordinals are guaranteed to align with this pass's filter
  var declusWeights = null;
  var auxWeight = catRole(ds.id, 'weight');
  if (auxWeight === AUX_DECLUS_WEIGHT) {
    if (!ds.declus || !ds.declus.weights) { fail('Run Declustering first — no weights computed.'); return; }
    if (ds.declus.fingerprint !== auxDeclusFingerprintNow(ds)) { fail('Aux config changed since declustering — re-run Declustering.'); return; }
    declusWeights = ds.declus.weights;
  }
  ds._worker.postMessage({
    file: ds.file,
    xyzOverride: xyz.x >= 0 && xyz.y >= 0 && xyz.z >= 0 ? xyz : null,
    filter: ds.filter ? { expression: ds.filter.expression } : null,
    typeOverrides: auxTypeOverrides,
    zipEntry: ds.preflight.selectedZipEntry || null,
    skipCols: [],
    colFilters: {},
    calcolCode: ds.calcolCode || null,
    calcolMeta: ds.calcolMeta.length > 0 ? ds.calcolMeta : null,
    groupBy: null,
    groupStatsCols: null,
    dxyzOverride: null,
    dmEndianness: ds.preflight.dmEndianness || null,
    dmFormat: ds.preflight.dmFormat || null,
    rowVarOverride: ds.rowVar,
    weightColName: declusWeights ? null : auxWeight,
    weightArray: declusWeights,
    weightArrayLabel: declusWeights ? 'declustered (cell ' + formatNum(ds.declus.optCellSize) + ')' : null
  });

  ds._worker.onerror = function(e) { fail(e.message || 'unknown error'); };
  ds._worker.onmessage = function(e) {
    var m = e.data;
    if (m.type === 'progress') {
      if ($status) $status.textContent = Math.min(99, m.percent).toFixed(0) + '%';
    } else if (m.type === 'complete') {
      if (m.weightArrayMismatch) {
        fail('Declustered weights misaligned (' + m.weightArrayMismatch.expected + ' vs ' + m.weightArrayMismatch.got + ' rows) — re-run Declustering.');
        return;
      }
      ds.complete = { header: m.header, colTypes: m.colTypes, stats: m.stats, categories: m.categories, rowCount: m.rowCount,
        // A10: carry the A9 data-health counters for the per-dataset summary
        filterErrors: m.filterErrors || null, calcolErrors: m.calcolErrors || null,
        raggedRows: m.raggedRows || 0, coordInvalidCells: m.coordInvalidCells || 0, weightExcluded: m.weightExcluded || 0 };
      ds.stale = false;
      if ($btn) $btn.disabled = false;
      if (typeof setGenStale === 'function') setGenStale(auxQ('[data-act="auxAnalyze"]', root), false);  // C6-5 dim-when-done
      if ($status) { $status.textContent = m.rowCount.toLocaleString() + ' rows analyzed'; $status.style.color = ''; }
      ds._worker.terminate();
      ds._worker = null;
      if (typeof applyStatsAuxRestore === 'function') applyStatsAuxRestore();
      if (typeof lastDisplayedStats !== 'undefined' && lastDisplayedStats) {
        renderStatsSidebar();
        renderStatsTable();
        renderStatsCdfPanel();
      }
      if (typeof renderCatMain === 'function' && catFocusedCol !== null) renderCatMain();
      if (ds.view === 'summary' && typeof renderAuxSummary === 'function') renderAuxSummary(ds, root);  // A10 per-dataset summary
      autoSaveProject();
    } else if (m.type === 'error') {
      fail(m.message);
    }
  };
}

// Weight candidates: aux numeric columns + numeric aux calcols, by name
function auxWeightOptions(ds) {
  ds = ds || dsById('aux');
  var opts = '<option value="">— none</option>';
  if (!ds.preflight) return opts;
  var auxWeight = catRole(ds.id, 'weight');
  opts += '<option value="' + AUX_DECLUS_WEIGHT + '"' + (auxWeight === AUX_DECLUS_WEIGHT ? ' selected' : '') + '>(declustered weights)</option>';
  for (var i = 0; i < ds.preflight.header.length; i++) {
    if ((ds.preflight.autoTypes || [])[i] !== 'numeric') continue;
    var n = ds.preflight.header[i];
    opts += '<option value="' + esc(n) + '"' + (n === auxWeight ? ' selected' : '') + '>' + esc(n) + '</option>';
  }
  for (var ci = 0; ci < ds.calcolMeta.length; ci++) {
    if (ds.calcolMeta[ci].type !== 'numeric') continue;
    var cn = ds.calcolMeta[ci].name;
    opts += '<option value="' + esc(cn) + '"' + (cn === auxWeight ? ' selected' : '') + '>' + esc(cn) + ' (calc)</option>';
  }
  return opts;
}

// Refresh just the weight select (e.g. after aux calcols change) without
// rebuilding the sidebar — preserves focus elsewhere
function renderAuxWeightOptions(ds, root) {
  ds = ds || dsById('aux');
  root = root || dsConfigRoot(ds);
  var sel = auxQ('[data-aux="weight"]', root);
  if (sel) sel.innerHTML = auxWeightOptions(ds);
}

function renderAuxPreview(ds, root) {
  ds = ds || dsById('aux');
  root = root || dsConfigRoot(ds);
  var d = ds.preflight;
  var head = '<tr>' + d.header.map(function(h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr>';
  var rows = d.sampleRows.slice(0, 20).map(function(r) {
    return '<tr>' + r.map(function(c) { return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>';
  }).join('');
  var preview = auxQ('[data-aux="preview"]', root);
  if (preview) preview.innerHTML = '<table class="aux-preview-table"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table>';
}

// A10 phase 3 — per-dataset summary: a bounding box (from the coordinate
// columns' analyzed extents) with Export OBJ, plus the row-health card
// (shared computeHealthItems). The point/drillhole analogue of the model's
// Grid Geometry summary — no grid params, since this data isn't gridded.
function renderAuxSummary(ds, root) {
  ds = ds || dsById('aux');
  root = root || dsConfigRoot(ds);
  var $s = auxQ('[data-aux="summaryView"]', root);
  if (!$s) return;
  if (!ds.complete) {
    $s.innerHTML = '<div class="aux-hint" style="padding:1rem">Run Analyze to see the dataset summary — bounding box and row health.</div>';
    return;
  }
  var d = ds.complete;
  var xyz = (ds.preflight && ds.preflight.xyz) || { x: -1, y: -1, z: -1 };
  var label = ds.prefix || 'aux';
  var sx = xyz.x >= 0 ? d.stats[xyz.x] : null;
  var sy = xyz.y >= 0 ? d.stats[xyz.y] : null;
  var sz = xyz.z >= 0 ? d.stats[xyz.z] : null;
  var haveBox = !!(sx && sy && sz && sx.min != null && sy.min != null && sz.min != null);

  var bboxHtml;
  if (haveBox) {
    function boxRow(ax, s) {
      return '<tr><td>' + ax + '</td><td>' + formatNum(s.min) + '</td><td>' + formatNum(s.max) +
        '</td><td>' + formatNum(s.max - s.min) + '</td></tr>';
    }
    bboxHtml = '<table class="aux-bbox-table"><thead><tr><th></th><th>Min</th><th>Max</th><th>Extent</th></tr></thead><tbody>' +
      boxRow('X', sx) + boxRow('Y', sy) + boxRow('Z', sz) + '</tbody></table>' +
      '<button class="copy-table-btn" data-act="auxExportObj" style="margin-top:0.5rem">Export OBJ</button>';
  } else {
    bboxHtml = '<div class="aux-hint">Assign X / Y / Z in the sidebar and re-run Analyze to compute the bounding box.</div>';
  }

  var items = (typeof computeHealthItems === 'function') ? computeHealthItems(d) : [];
  var healthHtml;
  if (items.length === 0) {
    healthHtml = '<div class="health-clean">✓ No data-quality issues — all ' + (d.rowCount || 0).toLocaleString() +
      ' rows and ' + (d.header ? d.header.length : 0) + ' columns parsed cleanly.</div>';
  } else {
    healthHtml = items.map(function(it) {
      return '<div class="health-item"><span class="health-count">' + (it.n != null ? it.n.toLocaleString() : '!') + '</span>' +
        '<div class="health-text"><div class="health-label">' + esc(it.label) + '</div>' +
        '<div class="health-detail">' + esc(it.detail) + '</div></div></div>';
    }).join('');
  }
  var hBadge = items.length
    ? '<span class="badge" style="background:var(--warn-soft);color:var(--warn)">' + items.length + ' check' + (items.length === 1 ? '' : 's') + '</span>'
    : '<span class="badge" style="background:var(--green-soft);color:var(--green)">clean</span>';

  $s.innerHTML =
    '<div class="section" style="margin:0.7rem"><div class="section-head">Bounding Box <span class="badge">' + esc(label) + '</span></div>' +
      '<div class="section-body">' + bboxHtml + '</div></div>' +
    '<div class="section" style="margin:0.7rem"><div class="section-head">Data Health ' + hBadge + '</div>' +
      '<div class="section-body">' + healthHtml + '</div></div>';

  var $obj = auxQ('[data-act="auxExportObj"]', root);
  if ($obj && haveBox && typeof downloadBboxObj === 'function') {
    $obj.addEventListener('click', function() {
      downloadBboxObj({ xMin: sx.min, xMax: sx.max, yMin: sy.min, yMax: sy.max, zMin: sz.min, zMax: sz.max },
        ds.file ? ds.file.name : label);
    });
  }
}

function onAuxConfigChange(e, ds, root) {
  ds = ds || dsById('aux');
  root = root || dsConfigRoot(ds);
  if (!ds.preflight) return;
  // Declustering params only gate the (separately fingerprinted) declus run —
  // they don't invalidate the aux analysis config
  if (e && e.target && e.target.dataset && e.target.dataset.aux && e.target.dataset.aux.indexOf('declus') === 0) {
    ds.declus = ds.declus || {};
    ds.declus.params = auxDeclusParamsFromUI(ds, root);
    if (typeof autoSaveProject === 'function') autoSaveProject();
    return;
  }
  var p = auxQ('[data-aux="prefix"]', root);
  if (p) ds.prefix = p.value.trim() || 'aux';
  var x = auxQ('[data-aux="x"]', root), y = auxQ('[data-aux="y"]', root), z = auxQ('[data-aux="z"]', root);
  if (x && y && z) ds.preflight.xyz = { x: parseInt(x.value), y: parseInt(y.value), z: parseInt(z.value) };
  var f = auxQ('[data-aux="filter"]', root);
  if (f) { var v = f.value.trim(); ds.filter = v ? { expression: v } : null; }
  var wSel = auxQ('[data-aux="weight"]', root);
  if (wSel) catSetRole(ds.id, 'weight', wSel.value || null);
  markAuxStale(ds, root);
  // Live-update the prefix hint without a full re-render (keeps focus/caret)
  var sidebar = auxQ('[data-aux="sidebar"]', root);
  var hint = sidebar && sidebar.querySelector('.pf-sidebar-section .aux-hint code');
  if (hint && p) hint.textContent = (ds.prefix || 'aux') + ':Fe';
  // A10 1g-c: an instance's tab title tracks its prefix
  if (typeof wsSetDatasetTabTitle === 'function') wsSetDatasetTabTitle(ds);
  // Keep the swath sidebar's aux rows in sync (prefix labels, xyz exclusions);
  // check/unit state is preserved by name across the rebuild
  if (typeof renderSwathAuxVars === 'function') renderSwathAuxVars();
  if (typeof autoSaveProject === 'function') autoSaveProject();
}

// Flag a completed aux analysis as no longer reflecting the current config
function markAuxStale(ds, root) {
  ds = ds || dsById('aux');
  root = root || dsConfigRoot(ds);
  if (!ds.complete || ds.stale) return;
  ds.stale = true;
  if (typeof setGenStale === 'function') setGenStale(auxQ('[data-act="auxAnalyze"]', root), true);  // C6-5: back to orange call-to-action
  var $st = auxQ('[data-aux="analyzeStatus"]', root);
  if ($st) { $st.textContent = '↻ config changed — re-run Analyze'; $st.style.color = 'var(--warn)'; }
}

// ─── Cell declustering (GSLIB DECLUS in the worker) ────────────────────
// Weights are computed against the CURRENT aux row space (file, zip entry,
// filter, calcols, XYZ); this fingerprint gates their reuse so ordinals
// can never silently misalign.
function auxDeclusFingerprintNow(ds) {
  ds = ds || dsById('aux');
  if (!ds.file || !ds.preflight) return null;
  var xyz = ds.preflight.xyz || {};
  return JSON.stringify({
    f: ds.file.name + '|' + ds.file.size,
    z: ds.preflight.selectedZipEntry || null,
    flt: ds.filter ? ds.filter.expression : '',
    cc: ds.calcolCode || '',
    xyz: [xyz.x, xyz.y, xyz.z]
  });
}

function auxDeclusFresh(ds) {
  ds = ds || dsById('aux');
  return !!(ds.declus && ds.declus.weights && ds.declus.fingerprint === auxDeclusFingerprintNow(ds));
}

function auxDeclusParamsFromUI(ds, root) {
  ds = ds || dsById('aux');
  root = root || dsConfigRoot(ds);
  function num(key) {
    var el = auxQ('[data-aux="' + key + '"]', root);
    if (!el || el.value === '') return null;
    var v = parseFloat(el.value);
    return isFinite(v) ? v : null;
  }
  var sel = auxQ('[data-aux="declusVar"]', root);
  var crit = auxQ('[data-aux="declusCrit"]', root);
  var prev = (ds.declus && ds.declus.params) || {};
  return {
    varName: sel ? sel.value : (prev.varName || null),
    cellMin: num('declusCellMin'),
    cellMax: num('declusCellMax'),
    ncell: num('declusNCell') || 24,
    noff: num('declusNoff') || 8,
    anisy: num('declusAnisY') || 1,
    anisz: num('declusAnisZ') || 1,
    criterion: crit ? crit.value : (prev.criterion || 'min'),
    pinned: prev.pinned || null  // set by clicking the curve, cleared by Run
  };
}

function renderAuxDeclusSection(ds) {
  ds = ds || dsById('aux');
  if (!ds.preflight) return '';
  var p = (ds.declus && ds.declus.params) || {};
  var varOpts = '', firstNum = null;
  for (var i = 0; i < ds.preflight.header.length; i++) {
    if ((ds.preflight.autoTypes || [])[i] !== 'numeric') continue;
    var n = ds.preflight.header[i];
    if (firstNum === null) firstNum = n;
    varOpts += '<option value="' + esc(n) + '"' + (n === p.varName ? ' selected' : '') + '>' + esc(n) + '</option>';
  }
  for (var ci = 0; ci < ds.calcolMeta.length; ci++) {
    if (ds.calcolMeta[ci].type !== 'numeric') continue;
    var cn = ds.calcolMeta[ci].name;
    varOpts += '<option value="' + esc(cn) + '"' + (cn === p.varName ? ' selected' : '') + '>' + esc(cn) + ' (calc)</option>';
  }
  function numVal(v) { return (v === null || v === undefined) ? '' : String(v); }
  return '<div class="pf-sidebar-section" data-sb="declus">' +
    '<div class="pf-sidebar-section-title">Declustering</div>' +
    '<div class="aux-xyz-row"><label>Var</label><select class="aux-select" data-aux="declusVar">' + varOpts + '</select></div>' +
    '<div class="aux-xyz-row"><label>Cell</label>' +
      '<input type="text" class="aux-input" data-aux="declusCellMin" value="' + numVal(p.cellMin) + '" placeholder="min (auto)" spellcheck="false">' +
      '<input type="text" class="aux-input" data-aux="declusCellMax" value="' + numVal(p.cellMax) + '" placeholder="max (auto)" spellcheck="false">' +
    '</div>' +
    '<div class="aux-xyz-row"><label>Sweep</label>' +
      '<input type="text" class="aux-input" data-aux="declusNCell" value="' + numVal(p.ncell) + '" placeholder="24 sizes" spellcheck="false" title="number of cell sizes">' +
      '<input type="text" class="aux-input" data-aux="declusNoff" value="' + numVal(p.noff) + '" placeholder="8 offsets" spellcheck="false" title="origin offsets">' +
    '</div>' +
    '<div class="aux-xyz-row"><label>Anis</label>' +
      '<input type="text" class="aux-input" data-aux="declusAnisY" value="' + numVal(p.anisy) + '" placeholder="Y 1" spellcheck="false" title="Y cell anisotropy (Ysize = size × YAnis)">' +
      '<input type="text" class="aux-input" data-aux="declusAnisZ" value="' + numVal(p.anisz) + '" placeholder="Z 1" spellcheck="false" title="Z cell anisotropy (Zsize = size × ZAnis)">' +
    '</div>' +
    '<div class="aux-xyz-row"><label>Find</label><select class="aux-select" data-aux="declusCrit">' +
      '<option value="min"' + (p.criterion !== 'max' ? ' selected' : '') + '>minimum declustered mean</option>' +
      '<option value="max"' + (p.criterion === 'max' ? ' selected' : '') + '>maximum declustered mean</option>' +
    '</select></div>' +
    '<div class="aux-hint">GSLIB cell declustering: sweeps cell sizes, weights ∝ 1/(samples per cell), averaged over origin offsets. Use min for data clustered in high grades, max for low.</div>' +
    '<button class="swath-generate" data-act="auxDeclusRun">Run declustering</button>' +
    '<div class="aux-hint aux-analyze-status" data-aux="declusStatus"></div>' +
    renderAuxDeclusResults(ds) +
  '</div>';
}

function renderAuxDeclusResults(ds) {
  ds = ds || dsById('aux');
  if (!ds.declus || !ds.declus.curve) return '';
  var d = ds.declus;
  var fresh = auxDeclusFresh(ds);
  var html = '<div class="aux-declus-results">';
  if (!fresh) {
    html += '<div class="aux-hint" style="color:var(--warn)">' +
      (d.weights ? 'Aux config changed since this run — re-run to refresh the weights.' : 'Restored params — run to compute the weights.') + '</div>';
  }
  if (d.naiveMean !== undefined) {
    var delta = d.naiveMean !== 0 ? ((d.declusteredMean - d.naiveMean) / Math.abs(d.naiveMean) * 100) : null;
    html += '<div class="aux-declus-stat">mean ' + formatNum(d.naiveMean) + ' → <strong>' + formatNum(d.declusteredMean) + '</strong>' +
      (delta !== null ? ' (' + (delta >= 0 ? '+' : '−') + Math.abs(delta).toFixed(1) + '%)' : '') + '</div>';
    if (d.optCellSize > 0) {
      html += '<div class="aux-declus-stat">cell <strong>' + formatNum(d.optCellSize) + '</strong>' +
        (d.pinned ? ' <span style="color:var(--fg-bright)">(pinned — Run to re-sweep)</span>' : ' (sweep optimum)') +
        ' · w ' + formatNum(d.wtMin) + '–' + formatNum(d.wtMax) +
        ' · n ' + d.located.toLocaleString() + (d.n > d.located ? ' <span title="rows without valid XYZ + variable get no weight and are excluded">(+' + (d.n - d.located) + ' unlocated)</span>' : '') + '</div>';
    } else {
      html += '<div class="aux-declus-stat" style="color:var(--warn)">No cell size beat the naive mean — weights stay 1. Data may not be clustered (or try the other criterion, or click the curve to pin a size).</div>';
    }
    html += auxDeclusCurveSvg(d);
  }
  if (catRole(ds.id, 'weight') === AUX_DECLUS_WEIGHT) html += '<div class="aux-hint">In use as the aux weight.</div>';
  else if (fresh) html += '<button class="aux-from-main-btn" data-act="auxDeclusUse" style="margin-top:0.3rem">Use as aux weight</button>';
  return html + '</div>';
}

// Declustered-mean vs cell-size curve — the honest surface for the cell-size
// choice: you see why the optimum won, hover to inspect any size, and click
// a point to pin that cell size (weights recompute at the pinned size).
var AUX_DECLUS_SVG = { W: 276, H: 150, padL: 8, padR: 8, padT: 10, padB: 18 };

function auxDeclusCurveSvg(d) {
  if (!d.curve || d.curve.length < 2) return '';
  var W = AUX_DECLUS_SVG.W, H = AUX_DECLUS_SVG.H;
  var padL = AUX_DECLUS_SVG.padL, padR = AUX_DECLUS_SVG.padR, padT = AUX_DECLUS_SVG.padT, padB = AUX_DECLUS_SVG.padB;
  var xmax = 0, ymin = Infinity, ymax = -Infinity;
  for (var i = 0; i < d.curve.length; i++) {
    var pt = d.curve[i];
    if (pt[0] > xmax) xmax = pt[0];
    if (pt[1] < ymin) ymin = pt[1];
    if (pt[1] > ymax) ymax = pt[1];
  }
  // The pinned mean may sit outside the sweep's y-range
  if (d.pinned && d.declusteredMean < ymin) ymin = d.declusteredMean;
  if (d.pinned && d.declusteredMean > ymax) ymax = d.declusteredMean;
  if (!(xmax > 0)) return '';
  if (ymax === ymin) { ymax += 1; ymin -= 1; }
  var yr = ymax - ymin;
  ymin -= yr * 0.08; ymax += yr * 0.08;
  function sx(x) { return padL + (x / xmax) * (W - padL - padR); }
  function sy(y) { return padT + (1 - (y - ymin) / (ymax - ymin)) * (H - padT - padB); }
  var poly = '', pts = [];
  for (var j = 0; j < d.curve.length; j++) {
    var px = sx(d.curve[j][0]), py = sy(d.curve[j][1]);
    poly += (j ? ' ' : '') + px.toFixed(1) + ',' + py.toFixed(1);
    pts.push([+px.toFixed(1), +py.toFixed(1), d.curve[j][0], d.curve[j][1]]);
  }
  var svg = '<svg class="aux-declus-curve" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" data-pts="' + esc(JSON.stringify(pts)) + '">' +
    '<line x1="' + padL + '" y1="' + sy(d.naiveMean).toFixed(1) + '" x2="' + (W - padR) + '" y2="' + sy(d.naiveMean).toFixed(1) + '" stroke="var(--fg-dim)" stroke-dasharray="3,3" stroke-width="0.75"/>' +
    '<polyline points="' + poly + '" fill="none" stroke="var(--action)" stroke-width="1.3"/>';
  // Sweep points — visible click targets
  for (var k = 0; k < pts.length; k++) {
    if (pts[k][2] <= 0) continue;
    svg += '<circle cx="' + pts[k][0] + '" cy="' + pts[k][1] + '" r="1.7" fill="var(--action)" opacity="0.55"/>';
  }
  if (d.pinned) {
    var pxp = sx(d.pinned), pyp = sy(d.declusteredMean);
    svg += '<line x1="' + pxp.toFixed(1) + '" y1="' + padT + '" x2="' + pxp.toFixed(1) + '" y2="' + (H - padB) + '" stroke="var(--fg-bright)" stroke-dasharray="2,2" stroke-width="0.75"/>' +
      '<rect x="' + (pxp - 3.2).toFixed(1) + '" y="' + (pyp - 3.2).toFixed(1) + '" width="6.4" height="6.4" transform="rotate(45 ' + pxp.toFixed(1) + ' ' + pyp.toFixed(1) + ')" fill="var(--fg-bright)"/>';
  } else if (d.optCellSize > 0) {
    svg += '<circle cx="' + sx(d.optCellSize).toFixed(1) + '" cy="' + sy(d.declusteredMean).toFixed(1) + '" r="3.2" fill="var(--action)"/>';
  }
  // Hover cursor (positioned by the delegated pointermove handler)
  svg += '<g class="aux-declus-cursor" style="display:none">' +
    '<line y1="' + padT + '" y2="' + (H - padB) + '" stroke="var(--fg-dim)" stroke-width="0.6"/>' +
    '<circle r="2.6" fill="none" stroke="var(--fg-bright)" stroke-width="1"/>' +
    '<text y="' + (padT + 8) + '" fill="var(--fg-bright)" font-size="9"></text>' +
  '</g>' +
  '<text x="' + padL + '" y="' + (H - 5) + '" fill="var(--fg-dim)" font-size="8">0</text>' +
  '<text x="' + (W - padR) + '" y="' + (H - 5) + '" text-anchor="end" fill="var(--fg-dim)" font-size="8">cell ' + formatNum(xmax) + '</text>' +
  '<text x="' + (padL + 3) + '" y="' + (padT + 7) + '" fill="var(--fg-dim)" font-size="8" opacity="0.8">' + formatNum(ymax) + '</text>' +
  '<text x="' + (padL + 3) + '" y="' + (H - padB - 3) + '" fill="var(--fg-dim)" font-size="8" opacity="0.8">' + formatNum(ymin) + '</text>' +
  '</svg>' +
  '<div class="aux-hint" style="margin-top:0.1rem">hover to inspect · click a point to pin that cell size</div>';
  return svg;
}

// Nearest sweep point to a mouse event, in viewBox coordinates
function auxDeclusNearestPt(svg, e) {
  if (!svg._pts) { try { svg._pts = JSON.parse(svg.dataset.pts); } catch (err) { return null; } }
  var rect = svg.getBoundingClientRect();
  var vx = (e.clientX - rect.left) * (AUX_DECLUS_SVG.W / rect.width);
  var bestPt = null, bestDx = Infinity;
  for (var i = 0; i < svg._pts.length; i++) {
    var dx = Math.abs(svg._pts[i][0] - vx);
    if (dx < bestDx) { bestDx = dx; bestPt = svg._pts[i]; }
  }
  return bestPt;
}

function auxDeclusUpdateCursor(svg, pt, ds) {
  ds = ds || dsById('aux');
  var g = svg.querySelector('.aux-declus-cursor');
  if (!g) return;
  if (!pt) { g.style.display = 'none'; return; }
  g.style.display = '';
  var line = g.querySelector('line'), circ = g.querySelector('circle'), txt = g.querySelector('text');
  line.setAttribute('x1', pt[0]); line.setAttribute('x2', pt[0]);
  circ.setAttribute('cx', pt[0]); circ.setAttribute('cy', pt[1]);
  var d = ds.declus;
  var lbl = pt[2] <= 0 ? 'naive ' + formatNum(pt[3])
    : 'cell ' + formatNum(pt[2]) + ' → ' + formatNum(pt[3]) +
      (d && d.naiveMean ? ' (' + (pt[3] >= d.naiveMean ? '+' : '−') + Math.abs((pt[3] - d.naiveMean) / Math.abs(d.naiveMean) * 100).toFixed(1) + '%)' : '');
  txt.textContent = lbl;
  // Flip the label side near the right edge
  var flip = pt[0] > AUX_DECLUS_SVG.W * 0.55;
  txt.setAttribute('x', flip ? pt[0] - 4 : pt[0] + 4);
  txt.setAttribute('text-anchor', flip ? 'end' : 'start');
}

function runAuxDeclus(ds, root) {
  ds = ds || dsById('aux');
  root = root || dsConfigRoot(ds);
  if (!ds.file || !ds.preflight) return;
  var $st = auxQ('[data-aux="declusStatus"]', root);
  var $runBtn = auxQ('[data-act="auxDeclusRun"]', root);
  function dfail(msg) {
    if ($st) { $st.textContent = 'Error: ' + msg; $st.style.color = 'var(--red)'; }
    if ($runBtn) $runBtn.disabled = false;
    if (ds._declusWorker) { try { ds._declusWorker.terminate(); } catch (e) {} ds._declusWorker = null; }
  }
  var xyz = ds.preflight.xyz || { x: -1, y: -1, z: -1 };
  if (xyz.x < 0 || xyz.y < 0) { dfail('Assign X and Y coordinates first (Z optional).'); return; }
  var params = auxDeclusParamsFromUI(ds, root);
  if (!params.varName) { dfail('No numeric variable to decluster on.'); return; }
  if (params.cellMin !== null && params.cellMax !== null && params.cellMax < params.cellMin) { dfail('Cell max must be ≥ cell min.'); return; }

  if (ds._declusWorker) { try { ds._declusWorker.terminate(); } catch (e) {} }
  ds._declusWorker = new Worker(workerUrl);
  if ($st) { $st.textContent = '0%'; $st.style.color = ''; }
  if ($runBtn) $runBtn.disabled = true;

  ds._declusWorker.postMessage({
    mode: 'declus',
    file: ds.file,
    zipEntry: ds.preflight.selectedZipEntry || null,
    globalFilter: ds.filter ? { expression: ds.filter.expression } : null,
    calcolCode: ds.calcolCode || null,
    calcolMeta: ds.calcolMeta.length > 0 ? ds.calcolMeta : null,
    resolvedTypes: ds.preflight.autoTypes,
    xyzCols: [xyz.x, xyz.y, xyz.z],
    varColName: params.varName,
    cellMin: params.cellMin, cellMax: params.cellMax,
    ncell: params.ncell, noff: params.noff,
    anisy: params.anisy, anisz: params.anisz,
    iminmax: params.criterion === 'max' ? 1 : 0,
    pinnedCell: params.pinned || null,
    rowVarOverride: ds.rowVar,
    dmEndianness: ds.preflight.dmEndianness || null,
    dmFormat: ds.preflight.dmFormat || null
  });
  ds._declusWorker.onerror = function(e) { dfail(e.message || 'unknown error'); };
  ds._declusWorker.onmessage = function(e) {
    var m = e.data;
    if (m.type === 'declus-progress') {
      if ($st) $st.textContent = Math.min(99, m.percent).toFixed(0) + '%';
    } else if (m.type === 'error') {
      dfail(m.message);
    } else if (m.type === 'declus-complete') {
      ds._declusWorker.terminate();
      ds._declusWorker = null;
      ds.declus = {
        params: params,
        weights: m.weights, n: m.n, located: m.located,
        curve: m.curve, optCellSize: m.optCellSize,
        declusteredMean: m.declusteredMean, naiveMean: m.naiveMean,
        pinned: m.pinned ? params.pinned : null,
        wtMin: m.wtMin, wtMax: m.wtMax, usedRange: m.usedRange,
        fingerprint: auxDeclusFingerprintNow(ds)
      };
      // Fresh weights change the analysis result if they're the active weight
      if (catRole(ds.id, 'weight') === AUX_DECLUS_WEIGHT) markAuxStale(ds, root);
      renderAuxConfig(ds, root);
      if (typeof autoSaveProject === 'function') autoSaveProject();
    }
  };
}

function applyAuxRestore(saved, ds) {
  ds = ds || dsById('aux');
  ds.prefix = saved.prefix || 'aux';
  ds.filter = saved.filter ? { expression: saved.filter } : null;
  // Legacy projects carried the aux weight here; the catalog is canonical
  // now (a project.catalog, when present, was applied before this runs)
  if (saved.weight !== undefined && catRole(ds.id, 'weight') === null) catSetRole(ds.id, 'weight', saved.weight || null);
  // Declus params restore; weights are never persisted — re-run to compute
  ds.declus = (saved.declus && saved.declus.params) ? { params: saved.declus.params, weights: null } : null;
  // Top-cut: variable + cap + scale restore; the distribution is re-loaded on demand
  ds.topcut = (saved.topcut && saved.topcut.varName) ? { varName: saved.topcut.varName, cap: saved.topcut.cap != null ? saved.topcut.cap : null, xlog: !!saved.topcut.xlog, useDeclus: !!saved.topcut.useDeclus, values: null } : null;
  ds.view = saved.view === 'topcut' ? 'topcut' : 'preview';
  if (saved.xyz && ds.preflight) ds.preflight.xyz = saved.xyz;
  ds.calcolCode = saved.calcolCode || '';
  ds.calcolMeta = saved.calcolMeta || [];
  if (calcolMode === 'aux' && $calcolCodeArea) {
    $calcolCodeArea.value = ds.calcolCode;
    syncCodeHighlight();
  }
}

// When the primary file is a multi-entry archive, offer its other entries
// as aux candidates (e.g. a zip holding both the model and its composites)
function renderAuxFromMain(ds, root) {
  ds = ds || dsById('aux');
  root = root || dsConfigRoot(ds);
  // C6-3: name the model in the "Add a dataset" intro (runs on model load + clearAux)
  var mn = auxQ('[data-aux="modelName"]', root);
  if (mn) mn.textContent = (currentFile && currentFile.name) ? currentFile.name : 'your block model';
  var $wrap = auxQ('[data-aux="fromMain"]', root);
  if (!$wrap) return;
  if (ds.file || !currentFile || !preflightData || !preflightData.zipEntries || preflightData.zipEntries.length < 2) {
    $wrap.innerHTML = '';
    return;
  }
  var opts = preflightData.zipEntries.map(function(z) {
    var isCurrent = z.name === preflightData.selectedZipEntry;
    return '<option value="' + esc(z.name) + '"' + (isCurrent ? ' disabled' : '') + '>' +
      esc(z.name) + (isCurrent ? ' (main data)' : '') + '</option>';
  }).join('');
  $wrap.innerHTML =
    '<div class="aux-from-main-row">or use an entry from <strong>' + esc(currentFile.name) + '</strong>:</div>' +
    '<div class="aux-from-main-row">' +
      '<select class="aux-select" data-aux="fromMainSel" style="flex:1">' + opts + '</select>' +
      '<button class="aux-from-main-btn" data-act="auxFromMain">Use entry</button>' +
    '</div>';
  var sel = auxQ('[data-aux="fromMainSel"]', root);
  var firstFree = preflightData.zipEntries.find(function(z) { return z.name !== preflightData.selectedZipEntry; });
  if (firstFree) sel.value = firstFree.name;
  auxQ('[data-act="auxFromMain"]', root).addEventListener('click', function() {
    loadAuxFile(currentFile, null, sel.value, ds, root);
  });
}

function loadAuxFile(file, handle, zipEntryName, ds, root) {
  ds = ds || dsById('aux');
  root = root || dsConfigRoot(ds);
  ds.file = file;
  ds.handle = handle || null;
  var e0 = auxQ('[data-aux="loadError"]', root);
  if (e0) e0.textContent = '';
  var fileInfo = auxQ('[data-aux="fileInfo"]', root);
  if (fileInfo) fileInfo.textContent = 'Loading ' + file.name + '…';
  var emptyEl = auxQ('[data-aux="empty"]', root);
  if (emptyEl) emptyEl.style.display = 'none';
  var configEl = auxQ('[data-aux="config"]', root);
  if (configEl) configEl.style.display = '';
  runPreflight(file).then(async function(data) {
    ds.preflight = data;
    if (zipEntryName && data.zipEntries && zipEntryName !== data.selectedZipEntry) {
      try { await loadZipEntryIntoPreflight(file, data, zipEntryName); } catch (e) { /* keep default entry */ }
    }
    if (pendingAuxRestore && pendingAuxRestore.fileName === file.name) {
      var savedAux = pendingAuxRestore;
      pendingAuxRestore = null;
      if (savedAux.zipEntry && data.zipEntries && savedAux.zipEntry !== data.selectedZipEntry) {
        try { await loadZipEntryIntoPreflight(file, data, savedAux.zipEntry); } catch (e) { /* entry gone — keep default */ }
      }
      applyAuxRestore(savedAux, ds);
    }
    // A10 1g-c: instance datasets seed their display prefix from the filename
    // (the singleton aux keeps its 'aux' default — bit-identical behavior).
    if (ds.id !== 'aux' && ds.id !== 'model' && (!ds.prefix || ds.prefix === 'data')) {
      ds.prefix = (file.name || 'data').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').slice(0, 24) || 'data';
    }
    renderAuxConfig(ds, root);
    if (typeof wsSetDatasetTabTitle === 'function') wsSetDatasetTabTitle(ds);
    if (typeof renderSwathAuxVars === 'function') renderSwathAuxVars();
    if (typeof refreshCalcolModeToggle === 'function') refreshCalcolModeToggle();
    if (typeof autoSaveProject === 'function') autoSaveProject();
  }).catch(function(err) {
    ds.file = null;
    ds.preflight = null;
    var cfg = auxQ('[data-aux="config"]', root);
    if (cfg) cfg.style.display = 'none';
    var emp = auxQ('[data-aux="empty"]', root);
    if (emp) emp.style.display = '';
    var fi = auxQ('[data-aux="fileInfo"]', root);
    if (fi) fi.textContent = '';
    var errEl = auxQ('[data-aux="loadError"]', root);
    if (errEl) errEl.textContent = 'Dataset load failed: ' + err.message;
  });
}

function clearAux(ds, root) {
  ds = ds || dsById('aux');
  root = root || dsConfigRoot(ds);
  ds.file = null;
  ds.handle = null;
  ds.preflight = null;
  ds.complete = null;
  auxData = null;
  ds.filter = null;
  ds.prefix = 'aux';
  ds.stale = false;
  delete statsCmpSel[ds.id];
  delete statsCdfCmpSel[ds.id];
  ds.calcolCode = '';
  ds.calcolMeta = [];
  catSetRole(ds.id, 'weight', null);
  ds.declus = null;
  if (ds._declusWorker) { try { ds._declusWorker.terminate(); } catch (e) {} ds._declusWorker = null; }
  ds.topcut = null;
  ds.view = 'preview';
  if (ds._topcutWorker) { try { ds._topcutWorker.terminate(); } catch (e) {} ds._topcutWorker = null; }
  if (typeof renderAuxView === 'function') renderAuxView(ds, root);
  if (ds._worker) { try { ds._worker.terminate(); } catch (e) {} ds._worker = null; }
  if (typeof swathAuxWorker !== 'undefined' && swathAuxWorker) { try { swathAuxWorker.terminate(); } catch (e) {} swathAuxWorker = null; }
  var configEl = auxQ('[data-aux="config"]', root);
  if (configEl) configEl.style.display = 'none';
  var emptyEl = auxQ('[data-aux="empty"]', root);
  if (emptyEl) emptyEl.style.display = '';
  var sidebar = auxQ('[data-aux="sidebar"]', root);
  if (sidebar) sidebar.innerHTML = '';
  var preview = auxQ('[data-aux="preview"]', root);
  if (preview) preview.innerHTML = '';
  renderAuxFromMain(ds, root);
  if (typeof renderSwathAuxVars === 'function') renderSwathAuxVars();
  if (typeof renderCatMain === 'function' && catFocusedCol !== null) renderCatMain();
  if (typeof refreshCalcolModeToggle === 'function') refreshCalcolModeToggle();
  if (typeof updateCalcolBadge === 'function') updateCalcolBadge();
  if (typeof lastDisplayedStats !== 'undefined' && lastDisplayedStats) {
    renderStatsSidebar();
    renderStatsTable();
    renderStatsCdfPanel();
  }
  if (typeof autoSaveProject === 'function') autoSaveProject();
}

// ─── Wiring — attaches the panel's listeners for one dataset instance ──
// Extracted so a cloned instance panel (1g-c) wires the same way as the
// static #panelAux. Listeners resolve targets root-relative and pass the
// owning (ds, root) into every handler. Called once at load for the aux view
// (from topcut.js, after wireDatasetTopcut is defined).
function wireDatasetPanel(root, ds) {
  ds = ds || dsById('aux');
  root = root || dsConfigRoot(ds);
  if (!root) return;
  var dropzone = auxQ('[data-aux="dropzone"]', root);
  var fileInput = auxQ('[data-aux="fileInput"]', root);
  var sidebar = auxQ('[data-aux="sidebar"]', root);

  if (dropzone) {
    dropzone.addEventListener('dragover', function(e) { e.preventDefault(); dropzone.classList.add('drag-over'); });
    dropzone.addEventListener('dragleave', function() { dropzone.classList.remove('drag-over'); });
    dropzone.addEventListener('drop', async function(e) {
      e.preventDefault();
      e.stopPropagation(); // keep the $results drop handler from loading this as the main dataset
      dropzone.classList.remove('drag-over');
      var handle = null;
      if (HAS_FSAA && e.dataTransfer.items && e.dataTransfer.items[0] && e.dataTransfer.items[0].getAsFileSystemHandle) {
        try { handle = await e.dataTransfer.items[0].getAsFileSystemHandle(); } catch (ex) {}
      }
      var file = handle ? await handle.getFile() : (e.dataTransfer.files[0] || null);
      if (file) loadAuxFile(file, handle, undefined, ds, root);
    });

    if (HAS_FSAA) {
      dropzone.addEventListener('click', async function(e) {
        if (e.target === fileInput) return;
        e.preventDefault();
        try {
          var handles = await window.showOpenFilePicker({
            types: [
              { description: 'CSV files', accept: { 'text/*': ['.csv', '.txt', '.dat'] } },
              { description: 'ZIP files', accept: { 'application/zip': ['.zip'] } },
              { description: 'Datamine files', accept: { 'application/octet-stream': ['.dm'] } }
            ],
            multiple: false
          });
          var handle = handles[0];
          var file = await handle.getFile();
          loadAuxFile(file, handle, undefined, ds, root);
        } catch (ex) { /* cancelled */ }
      });
      if (fileInput) fileInput.style.display = 'none';
    }

    if (fileInput) fileInput.addEventListener('change', function(e) { if (e.target.files.length) loadAuxFile(e.target.files[0], null, undefined, ds, root); });
  }

  if (sidebar) {
    sidebar.addEventListener('input', function(e) { onAuxConfigChange(e, ds, root); });
    sidebar.addEventListener('change', function(e) { onAuxConfigChange(e, ds, root); });
    sidebar.addEventListener('click', function(e) {
      if (!e.target) return;
      var act = e.target.dataset ? e.target.dataset.act : null;
      if (act === 'auxAnalyze') runAuxAnalysis(ds, root);
      else if (act === 'auxDeclusRun') {
        // Run = fresh sweep; an existing pin is released
        if (ds.declus && ds.declus.params) ds.declus.params.pinned = null;
        runAuxDeclus(ds, root);
      } else if (act === 'auxDeclusUse') {
        catSetRole(ds.id, 'weight', AUX_DECLUS_WEIGHT);
        markAuxStale(ds, root);
        renderAuxConfig(ds, root);
        if (typeof autoSaveProject === 'function') autoSaveProject();
      } else {
        // Click on the sweep curve: pin the nearest cell size and recompute
        var svg = e.target.closest ? e.target.closest('.aux-declus-curve') : null;
        if (svg && ds.declus) {
          var pt = auxDeclusNearestPt(svg, e);
          if (pt && pt[2] > 0) {
            ds.declus.params = ds.declus.params || {};
            ds.declus.params.pinned = pt[2];
            runAuxDeclus(ds, root);
          }
        }
      }
    });
    // Curve scrubbing: crosshair with cell size, declustered mean and Δ%
    sidebar.addEventListener('pointermove', function(e) {
      var svg = e.target && e.target.closest ? e.target.closest('.aux-declus-curve') : null;
      var anySvg = auxQ('.aux-declus-curve', root);
      if (!svg) { if (anySvg) auxDeclusUpdateCursor(anySvg, null, ds); return; }
      auxDeclusUpdateCursor(svg, auxDeclusNearestPt(svg, e), ds);
    });
    sidebar.addEventListener('pointerleave', function() {
      var svg = auxQ('.aux-declus-curve', root);
      if (svg) auxDeclusUpdateCursor(svg, null, ds);
    });
    // Zip entry switch — re-read header/types/xyz from the chosen entry
    sidebar.addEventListener('change', async function(e) {
      if (!e.target || !e.target.dataset || e.target.dataset.aux !== 'zipEntry' || !ds.file || !ds.preflight) return;
      try {
        await loadZipEntryIntoPreflight(ds.file, ds.preflight, e.target.value);
        renderAuxConfig(ds, root);
        if (typeof renderSwathAuxVars === 'function') renderSwathAuxVars();
        markAuxStale(ds, root);
        if (typeof autoSaveProject === 'function') autoSaveProject();
      } catch (err) {
        var preview = auxQ('[data-aux="preview"]', root);
        if (preview) preview.innerHTML = '<div style="padding:1rem;color:var(--red)">' + esc(err.message) + '</div>';
      }
    });
  }

  var clearBtn = auxQ('[data-aux="clear"]', root);
  if (clearBtn) clearBtn.addEventListener('click', function() {
    // The singleton aux RESETS to its empty state (clearAux); an instance
    // (d2+) is fully REMOVED — tab closed + dropped from the registry (1g-c).
    if (ds.id !== 'aux' && ds.id !== 'model' && typeof wsRemoveInstance === 'function') wsRemoveInstance(ds);
    else clearAux(ds, root);
  });

  // Top-cut + view-toggle listeners live in topcut.js (loaded later)
  if (typeof wireDatasetTopcut === 'function') wireDatasetTopcut(root, ds);
}
