// ─── Aux dataset tab ──────────────────────────────────────────────────
// Loads a second dataset (e.g. composites/samples behind the block model)
// and configures it for comparison. Aux runs as its own analysis pass; its
// variables surface across Statistics / CDF / Swath with a display prefix.
// The display prefix (auxPrefix) is cosmetic only — aux filter/calc always
// reference columns through the fixed AUX_ROW_VAR handle ("aux.").

var $auxEmpty = document.getElementById('auxEmpty');
var $auxConfig = document.getElementById('auxConfig');
var $auxDropzone = document.getElementById('auxDropzone');
var $auxFileInput = document.getElementById('auxFileInput');
var $auxFileInfo = document.getElementById('auxFileInfo');
var $auxSidebar = document.getElementById('auxSidebar');
var $auxPreview = document.getElementById('auxPreview');

function auxColOptions(selectedIdx) {
  var opts = '<option value="-1">— none —</option>';
  var h = auxPreflightData.header;
  for (var i = 0; i < h.length; i++) {
    opts += '<option value="' + i + '"' + (i === selectedIdx ? ' selected' : '') + '>' + esc(h[i]) + '</option>';
  }
  return opts;
}

function renderAuxConfig() {
  if (!auxPreflightData) return;
  var d = auxPreflightData;
  var xyz = d.xyz || { x: -1, y: -1, z: -1 };

  // File info banner
  var meta = d.header.length + ' columns';
  if (d.isDm) meta += ' · DM ' + (d.dmFormat === 'ep' ? 'EP' : 'SP');
  else if (d.zipEntries) meta += ' · ZIP';
  $auxFileInfo.innerHTML = 'Aux: <strong style="color:var(--fg-bright)">' + esc(auxFile.name) + '</strong>' +
    '<span class="zip-size">' + formatBytes(auxFile.size) + ' — ' + meta + '</span>';

  // Sidebar: zip entry + prefix + coordinates + aux filter
  var zipSection = '';
  if (d.zipEntries && d.zipEntries.length > 1) {
    var zOpts = d.zipEntries.map(function(z) {
      return '<option value="' + esc(z.name) + '"' + (z.name === d.selectedZipEntry ? ' selected' : '') + '>' + esc(z.name) + '</option>';
    }).join('');
    zipSection =
      '<div class="pf-sidebar-section">' +
        '<div class="pf-sidebar-section-title">ZIP entry</div>' +
        '<select class="aux-select" id="auxZipEntry">' + zOpts + '</select>' +
      '</div>';
  }
  $auxSidebar.innerHTML = zipSection +
    '<div class="pf-sidebar-section">' +
      '<div class="pf-sidebar-section-title">Display prefix</div>' +
      '<input type="text" class="aux-input" id="auxPrefixInput" value="' + esc(auxPrefix) + '" placeholder="aux" spellcheck="false">' +
      '<div class="aux-hint">Label for aux variables in selection lists and plot labels (e.g. <code>' + esc(auxPrefix || 'aux') + ':Fe</code>). Cosmetic only.</div>' +
    '</div>' +
    '<div class="pf-sidebar-section">' +
      '<div class="pf-sidebar-section-title">Coordinates</div>' +
      '<div class="aux-xyz-row"><label>X</label><select class="aux-select" id="auxX">' + auxColOptions(xyz.x) + '</select></div>' +
      '<div class="aux-xyz-row"><label>Y</label><select class="aux-select" id="auxY">' + auxColOptions(xyz.y) + '</select></div>' +
      '<div class="aux-xyz-row"><label>Z</label><select class="aux-select" id="auxZ">' + auxColOptions(xyz.z) + '</select></div>' +
      '<div class="aux-hint">Aux and the block model must share the same coordinate space for swath overlays to line up.</div>' +
    '</div>' +
    '<div class="pf-sidebar-section">' +
      '<div class="pf-sidebar-section-title">Aux filter</div>' +
      '<textarea class="aux-input aux-filter" id="auxFilterInput" rows="2" spellcheck="false" placeholder="aux.Au > 0">' + esc(auxFilter ? auxFilter.expression : '') + '</textarea>' +
      '<div class="aux-hint">Reference aux columns as <code>aux.</code>… — independent of the display prefix.</div>' +
    '</div>' +
    '<div class="pf-sidebar-section">' +
      '<div class="pf-sidebar-section-title">Weight (optional)</div>' +
      '<select class="aux-select" id="auxWeightSel">' + auxWeightOptions() + '</select>' +
      '<div class="aux-hint">A weight column, or the computed declustering weights from below — applied to all aux statistics (Statistics, CDF, Swath). Rows with missing or ≤0 weight are excluded.</div>' +
    '</div>' +
    renderAuxDeclusSection() +
    '<div class="pf-sidebar-section">' +
      '<div class="pf-sidebar-section-title">Analysis</div>' +
      '<button class="swath-generate" id="auxAnalyzeBtn">Analyze</button>' +
      '<div class="aux-hint aux-analyze-status" id="auxAnalyzeStatus">' +
        (auxCompleteData
          ? (auxStale ? 'Config changed — re-run Analyze' : auxCompleteData.rowCount.toLocaleString() + ' rows analyzed')
          : 'Run to compare aux statistics on the Statistics tab') +
      '</div>' +
    '</div>';

  renderAuxPreview();
}

function runAuxAnalysis() {
  if (!auxFile || !auxPreflightData) return;
  if (auxWorker) { try { auxWorker.terminate(); } catch (e) {} auxWorker = null; }
  auxWorker = new Worker(workerUrl);

  var $btn = document.getElementById('auxAnalyzeBtn');
  var $status = document.getElementById('auxAnalyzeStatus');
  if ($btn) $btn.disabled = true;
  if ($status) { $status.textContent = '0%'; $status.style.color = ''; }

  function fail(msg) {
    if ($btn) $btn.disabled = false;
    if ($status) { $status.textContent = 'Error: ' + msg; $status.style.color = 'var(--red)'; }
    if (auxWorker) { auxWorker.terminate(); auxWorker = null; }
  }

  var xyz = auxPreflightData.xyz || { x: -1, y: -1, z: -1 };
  // Force every column's type from the preflight sample: the worker then
  // skips its detection warmup, whose rows are excluded from stats —
  // negligible on block models but a real bias on small sample files
  var auxTypeOverrides = {};
  for (var ti = 0; ti < auxPreflightData.autoTypes.length; ti++) {
    auxTypeOverrides[ti] = auxPreflightData.autoTypes[ti];
  }
  // Declustered weights: computed array, gated on a fresh fingerprint so the
  // row ordinals are guaranteed to align with this pass's filter
  var declusWeights = null;
  if (auxWeightName === AUX_DECLUS_WEIGHT) {
    if (!auxDeclus || !auxDeclus.weights) { fail('Run Declustering first — no weights computed.'); return; }
    if (auxDeclus.fingerprint !== auxDeclusFingerprintNow()) { fail('Aux config changed since declustering — re-run Declustering.'); return; }
    declusWeights = auxDeclus.weights;
  }
  auxWorker.postMessage({
    file: auxFile,
    xyzOverride: xyz.x >= 0 && xyz.y >= 0 && xyz.z >= 0 ? xyz : null,
    filter: auxFilter ? { expression: auxFilter.expression } : null,
    typeOverrides: auxTypeOverrides,
    zipEntry: auxPreflightData.selectedZipEntry || null,
    skipCols: [],
    colFilters: {},
    calcolCode: auxCalcolCode || null,
    calcolMeta: auxCalcolMeta.length > 0 ? auxCalcolMeta : null,
    groupBy: null,
    groupStatsCols: null,
    dxyzOverride: null,
    dmEndianness: auxPreflightData.dmEndianness || null,
    dmFormat: auxPreflightData.dmFormat || null,
    rowVarOverride: AUX_ROW_VAR,
    weightColName: declusWeights ? null : auxWeightName,
    weightArray: declusWeights,
    weightArrayLabel: declusWeights ? 'declustered (cell ' + formatNum(auxDeclus.optCellSize) + ')' : null
  });

  auxWorker.onerror = function(e) { fail(e.message || 'unknown error'); };
  auxWorker.onmessage = function(e) {
    var m = e.data;
    if (m.type === 'progress') {
      if ($status) $status.textContent = Math.min(99, m.percent).toFixed(0) + '%';
    } else if (m.type === 'complete') {
      if (m.weightArrayMismatch) {
        fail('Declustered weights misaligned (' + m.weightArrayMismatch.expected + ' vs ' + m.weightArrayMismatch.got + ' rows) — re-run Declustering.');
        return;
      }
      auxCompleteData = { header: m.header, colTypes: m.colTypes, stats: m.stats, categories: m.categories, rowCount: m.rowCount };
      auxStale = false;
      if ($btn) $btn.disabled = false;
      if ($status) { $status.textContent = m.rowCount.toLocaleString() + ' rows analyzed'; $status.style.color = ''; }
      auxWorker.terminate();
      auxWorker = null;
      if (typeof applyStatsAuxRestore === 'function') applyStatsAuxRestore();
      if (typeof lastDisplayedStats !== 'undefined' && lastDisplayedStats) {
        renderStatsSidebar();
        renderStatsTable();
        renderStatsCdfPanel();
      }
      if (typeof renderCatMain === 'function' && catFocusedCol !== null) renderCatMain();
      autoSaveProject();
    } else if (m.type === 'error') {
      fail(m.message);
    }
  };
}

// Weight candidates: aux numeric columns + numeric aux calcols, by name
function auxWeightOptions() {
  var opts = '<option value="">— none</option>';
  if (!auxPreflightData) return opts;
  opts += '<option value="' + AUX_DECLUS_WEIGHT + '"' + (auxWeightName === AUX_DECLUS_WEIGHT ? ' selected' : '') + '>(declustered weights)</option>';
  for (var i = 0; i < auxPreflightData.header.length; i++) {
    if ((auxPreflightData.autoTypes || [])[i] !== 'numeric') continue;
    var n = auxPreflightData.header[i];
    opts += '<option value="' + esc(n) + '"' + (n === auxWeightName ? ' selected' : '') + '>' + esc(n) + '</option>';
  }
  for (var ci = 0; ci < auxCalcolMeta.length; ci++) {
    if (auxCalcolMeta[ci].type !== 'numeric') continue;
    var cn = auxCalcolMeta[ci].name;
    opts += '<option value="' + esc(cn) + '"' + (cn === auxWeightName ? ' selected' : '') + '>' + esc(cn) + ' (calc)</option>';
  }
  return opts;
}

// Refresh just the weight select (e.g. after aux calcols change) without
// rebuilding the sidebar — preserves focus elsewhere
function renderAuxWeightOptions() {
  var sel = document.getElementById('auxWeightSel');
  if (sel) sel.innerHTML = auxWeightOptions();
}

function renderAuxPreview() {
  var d = auxPreflightData;
  var head = '<tr>' + d.header.map(function(h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr>';
  var rows = d.sampleRows.slice(0, 20).map(function(r) {
    return '<tr>' + r.map(function(c) { return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>';
  }).join('');
  $auxPreview.innerHTML = '<table class="aux-preview-table"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table>';
}

function onAuxConfigChange(e) {
  if (!auxPreflightData) return;
  // Declustering params only gate the (separately fingerprinted) declus run —
  // they don't invalidate the aux analysis config
  if (e && e.target && e.target.id && e.target.id.indexOf('auxDeclus') === 0) {
    auxDeclus = auxDeclus || {};
    auxDeclus.params = auxDeclusParamsFromUI();
    if (typeof autoSaveProject === 'function') autoSaveProject();
    return;
  }
  var p = document.getElementById('auxPrefixInput');
  if (p) auxPrefix = p.value.trim() || 'aux';
  var x = document.getElementById('auxX'), y = document.getElementById('auxY'), z = document.getElementById('auxZ');
  if (x && y && z) auxPreflightData.xyz = { x: parseInt(x.value), y: parseInt(y.value), z: parseInt(z.value) };
  var f = document.getElementById('auxFilterInput');
  if (f) { var v = f.value.trim(); auxFilter = v ? { expression: v } : null; }
  var wSel = document.getElementById('auxWeightSel');
  if (wSel) auxWeightName = wSel.value || null;
  markAuxStale();
  // Live-update the prefix hint without a full re-render (keeps focus/caret)
  var hint = $auxSidebar.querySelector('.pf-sidebar-section .aux-hint code');
  if (hint && p) hint.textContent = (auxPrefix || 'aux') + ':Fe';
  // Keep the swath sidebar's aux rows in sync (prefix labels, xyz exclusions);
  // check/unit state is preserved by name across the rebuild
  if (typeof renderSwathAuxVars === 'function') renderSwathAuxVars();
  if (typeof autoSaveProject === 'function') autoSaveProject();
}

// Flag a completed aux analysis as no longer reflecting the current config
function markAuxStale() {
  if (!auxCompleteData || auxStale) return;
  auxStale = true;
  var $st = document.getElementById('auxAnalyzeStatus');
  if ($st) { $st.textContent = 'Config changed — re-run Analyze'; $st.style.color = 'var(--amber)'; }
}

// ─── Cell declustering (GSLIB DECLUS in the worker) ────────────────────
// Weights are computed against the CURRENT aux row space (file, zip entry,
// filter, calcols, XYZ); this fingerprint gates their reuse so ordinals
// can never silently misalign.
function auxDeclusFingerprintNow() {
  if (!auxFile || !auxPreflightData) return null;
  var xyz = auxPreflightData.xyz || {};
  return JSON.stringify({
    f: auxFile.name + '|' + auxFile.size,
    z: auxPreflightData.selectedZipEntry || null,
    flt: auxFilter ? auxFilter.expression : '',
    cc: auxCalcolCode || '',
    xyz: [xyz.x, xyz.y, xyz.z]
  });
}

function auxDeclusFresh() {
  return !!(auxDeclus && auxDeclus.weights && auxDeclus.fingerprint === auxDeclusFingerprintNow());
}

function auxDeclusParamsFromUI() {
  function num(id) {
    var el = document.getElementById(id);
    if (!el || el.value === '') return null;
    var v = parseFloat(el.value);
    return isFinite(v) ? v : null;
  }
  var sel = document.getElementById('auxDeclusVar');
  var crit = document.getElementById('auxDeclusCrit');
  var prev = (auxDeclus && auxDeclus.params) || {};
  return {
    varName: sel ? sel.value : (prev.varName || null),
    cellMin: num('auxDeclusCellMin'),
    cellMax: num('auxDeclusCellMax'),
    ncell: num('auxDeclusNCell') || 24,
    noff: num('auxDeclusNoff') || 8,
    anisy: num('auxDeclusAnisY') || 1,
    anisz: num('auxDeclusAnisZ') || 1,
    criterion: crit ? crit.value : (prev.criterion || 'min'),
    pinned: prev.pinned || null  // set by clicking the curve, cleared by Run
  };
}

function renderAuxDeclusSection() {
  if (!auxPreflightData) return '';
  var p = (auxDeclus && auxDeclus.params) || {};
  var varOpts = '', firstNum = null;
  for (var i = 0; i < auxPreflightData.header.length; i++) {
    if ((auxPreflightData.autoTypes || [])[i] !== 'numeric') continue;
    var n = auxPreflightData.header[i];
    if (firstNum === null) firstNum = n;
    varOpts += '<option value="' + esc(n) + '"' + (n === p.varName ? ' selected' : '') + '>' + esc(n) + '</option>';
  }
  for (var ci = 0; ci < auxCalcolMeta.length; ci++) {
    if (auxCalcolMeta[ci].type !== 'numeric') continue;
    var cn = auxCalcolMeta[ci].name;
    varOpts += '<option value="' + esc(cn) + '"' + (cn === p.varName ? ' selected' : '') + '>' + esc(cn) + ' (calc)</option>';
  }
  function numVal(v) { return (v === null || v === undefined) ? '' : String(v); }
  return '<div class="pf-sidebar-section">' +
    '<div class="pf-sidebar-section-title">Declustering</div>' +
    '<div class="aux-xyz-row"><label>Var</label><select class="aux-select" id="auxDeclusVar">' + varOpts + '</select></div>' +
    '<div class="aux-xyz-row"><label>Cell</label>' +
      '<input type="text" class="aux-input" id="auxDeclusCellMin" value="' + numVal(p.cellMin) + '" placeholder="min (auto)" spellcheck="false">' +
      '<input type="text" class="aux-input" id="auxDeclusCellMax" value="' + numVal(p.cellMax) + '" placeholder="max (auto)" spellcheck="false">' +
    '</div>' +
    '<div class="aux-xyz-row"><label>Sweep</label>' +
      '<input type="text" class="aux-input" id="auxDeclusNCell" value="' + numVal(p.ncell) + '" placeholder="24 sizes" spellcheck="false" title="number of cell sizes">' +
      '<input type="text" class="aux-input" id="auxDeclusNoff" value="' + numVal(p.noff) + '" placeholder="8 offsets" spellcheck="false" title="origin offsets">' +
    '</div>' +
    '<div class="aux-xyz-row"><label>Anis</label>' +
      '<input type="text" class="aux-input" id="auxDeclusAnisY" value="' + numVal(p.anisy) + '" placeholder="Y 1" spellcheck="false" title="Y cell anisotropy (Ysize = size × YAnis)">' +
      '<input type="text" class="aux-input" id="auxDeclusAnisZ" value="' + numVal(p.anisz) + '" placeholder="Z 1" spellcheck="false" title="Z cell anisotropy (Zsize = size × ZAnis)">' +
    '</div>' +
    '<div class="aux-xyz-row"><label>Find</label><select class="aux-select" id="auxDeclusCrit">' +
      '<option value="min"' + (p.criterion !== 'max' ? ' selected' : '') + '>minimum declustered mean</option>' +
      '<option value="max"' + (p.criterion === 'max' ? ' selected' : '') + '>maximum declustered mean</option>' +
    '</select></div>' +
    '<div class="aux-hint">GSLIB cell declustering: sweeps cell sizes, weights ∝ 1/(samples per cell), averaged over origin offsets. Use min for data clustered in high grades, max for low.</div>' +
    '<button class="swath-generate" id="auxDeclusRunBtn">Run declustering</button>' +
    '<div class="aux-hint aux-analyze-status" id="auxDeclusStatus"></div>' +
    renderAuxDeclusResults() +
  '</div>';
}

function renderAuxDeclusResults() {
  if (!auxDeclus || !auxDeclus.curve) return '';
  var d = auxDeclus;
  var fresh = auxDeclusFresh();
  var html = '<div class="aux-declus-results">';
  if (!fresh) {
    html += '<div class="aux-hint" style="color:var(--amber)">' +
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
      html += '<div class="aux-declus-stat" style="color:var(--amber)">No cell size beat the naive mean — weights stay 1. Data may not be clustered (or try the other criterion, or click the curve to pin a size).</div>';
    }
    html += auxDeclusCurveSvg(d);
  }
  if (auxWeightName === AUX_DECLUS_WEIGHT) html += '<div class="aux-hint">In use as the aux weight.</div>';
  else if (fresh) html += '<button class="aux-from-main-btn" id="auxDeclusUseBtn" style="margin-top:0.3rem">Use as aux weight</button>';
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
  var svg = '<svg class="aux-declus-curve" id="auxDeclusCurveSvg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" data-pts="' + esc(JSON.stringify(pts)) + '">' +
    '<line x1="' + padL + '" y1="' + sy(d.naiveMean).toFixed(1) + '" x2="' + (W - padR) + '" y2="' + sy(d.naiveMean).toFixed(1) + '" stroke="var(--fg-dim)" stroke-dasharray="3,3" stroke-width="0.75"/>' +
    '<polyline points="' + poly + '" fill="none" stroke="var(--amber)" stroke-width="1.3"/>';
  // Sweep points — visible click targets
  for (var k = 0; k < pts.length; k++) {
    if (pts[k][2] <= 0) continue;
    svg += '<circle cx="' + pts[k][0] + '" cy="' + pts[k][1] + '" r="1.7" fill="var(--amber)" opacity="0.55"/>';
  }
  if (d.pinned) {
    var pxp = sx(d.pinned), pyp = sy(d.declusteredMean);
    svg += '<line x1="' + pxp.toFixed(1) + '" y1="' + padT + '" x2="' + pxp.toFixed(1) + '" y2="' + (H - padB) + '" stroke="var(--fg-bright)" stroke-dasharray="2,2" stroke-width="0.75"/>' +
      '<rect x="' + (pxp - 3.2).toFixed(1) + '" y="' + (pyp - 3.2).toFixed(1) + '" width="6.4" height="6.4" transform="rotate(45 ' + pxp.toFixed(1) + ' ' + pyp.toFixed(1) + ')" fill="var(--fg-bright)"/>';
  } else if (d.optCellSize > 0) {
    svg += '<circle cx="' + sx(d.optCellSize).toFixed(1) + '" cy="' + sy(d.declusteredMean).toFixed(1) + '" r="3.2" fill="var(--amber)"/>';
  }
  // Hover cursor (positioned by the delegated mousemove handler)
  svg += '<g id="auxDeclusCursor" style="display:none">' +
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

function auxDeclusUpdateCursor(svg, pt) {
  var g = svg.querySelector('#auxDeclusCursor');
  if (!g) return;
  if (!pt) { g.style.display = 'none'; return; }
  g.style.display = '';
  var line = g.querySelector('line'), circ = g.querySelector('circle'), txt = g.querySelector('text');
  line.setAttribute('x1', pt[0]); line.setAttribute('x2', pt[0]);
  circ.setAttribute('cx', pt[0]); circ.setAttribute('cy', pt[1]);
  var d = auxDeclus;
  var lbl = pt[2] <= 0 ? 'naive ' + formatNum(pt[3])
    : 'cell ' + formatNum(pt[2]) + ' → ' + formatNum(pt[3]) +
      (d && d.naiveMean ? ' (' + (pt[3] >= d.naiveMean ? '+' : '−') + Math.abs((pt[3] - d.naiveMean) / Math.abs(d.naiveMean) * 100).toFixed(1) + '%)' : '');
  txt.textContent = lbl;
  // Flip the label side near the right edge
  var flip = pt[0] > AUX_DECLUS_SVG.W * 0.55;
  txt.setAttribute('x', flip ? pt[0] - 4 : pt[0] + 4);
  txt.setAttribute('text-anchor', flip ? 'end' : 'start');
}

function runAuxDeclus() {
  if (!auxFile || !auxPreflightData) return;
  var $st = document.getElementById('auxDeclusStatus');
  var $runBtn = document.getElementById('auxDeclusRunBtn');
  function dfail(msg) {
    if ($st) { $st.textContent = 'Error: ' + msg; $st.style.color = 'var(--red)'; }
    if ($runBtn) $runBtn.disabled = false;
    if (auxDeclusWorker) { try { auxDeclusWorker.terminate(); } catch (e) {} auxDeclusWorker = null; }
  }
  var xyz = auxPreflightData.xyz || { x: -1, y: -1, z: -1 };
  if (xyz.x < 0 || xyz.y < 0) { dfail('Assign X and Y coordinates first (Z optional).'); return; }
  var params = auxDeclusParamsFromUI();
  if (!params.varName) { dfail('No numeric variable to decluster on.'); return; }
  if (params.cellMin !== null && params.cellMax !== null && params.cellMax < params.cellMin) { dfail('Cell max must be ≥ cell min.'); return; }

  if (auxDeclusWorker) { try { auxDeclusWorker.terminate(); } catch (e) {} }
  auxDeclusWorker = new Worker(workerUrl);
  if ($st) { $st.textContent = '0%'; $st.style.color = ''; }
  if ($runBtn) $runBtn.disabled = true;

  auxDeclusWorker.postMessage({
    mode: 'declus',
    file: auxFile,
    zipEntry: auxPreflightData.selectedZipEntry || null,
    globalFilter: auxFilter ? { expression: auxFilter.expression } : null,
    calcolCode: auxCalcolCode || null,
    calcolMeta: auxCalcolMeta.length > 0 ? auxCalcolMeta : null,
    resolvedTypes: auxPreflightData.autoTypes,
    xyzCols: [xyz.x, xyz.y, xyz.z],
    varColName: params.varName,
    cellMin: params.cellMin, cellMax: params.cellMax,
    ncell: params.ncell, noff: params.noff,
    anisy: params.anisy, anisz: params.anisz,
    iminmax: params.criterion === 'max' ? 1 : 0,
    pinnedCell: params.pinned || null,
    rowVarOverride: AUX_ROW_VAR,
    dmEndianness: auxPreflightData.dmEndianness || null,
    dmFormat: auxPreflightData.dmFormat || null
  });
  auxDeclusWorker.onerror = function(e) { dfail(e.message || 'unknown error'); };
  auxDeclusWorker.onmessage = function(e) {
    var m = e.data;
    if (m.type === 'declus-progress') {
      if ($st) $st.textContent = Math.min(99, m.percent).toFixed(0) + '%';
    } else if (m.type === 'error') {
      dfail(m.message);
    } else if (m.type === 'declus-complete') {
      auxDeclusWorker.terminate();
      auxDeclusWorker = null;
      auxDeclus = {
        params: params,
        weights: m.weights, n: m.n, located: m.located,
        curve: m.curve, optCellSize: m.optCellSize,
        declusteredMean: m.declusteredMean, naiveMean: m.naiveMean,
        pinned: m.pinned ? params.pinned : null,
        wtMin: m.wtMin, wtMax: m.wtMax, usedRange: m.usedRange,
        fingerprint: auxDeclusFingerprintNow()
      };
      // Fresh weights change the analysis result if they're the active weight
      if (auxWeightName === AUX_DECLUS_WEIGHT) markAuxStale();
      renderAuxConfig();
      if (typeof autoSaveProject === 'function') autoSaveProject();
    }
  };
}

function applyAuxRestore(saved) {
  auxPrefix = saved.prefix || 'aux';
  auxFilter = saved.filter ? { expression: saved.filter } : null;
  auxWeightName = saved.weight || null;
  // Declus params restore; weights are never persisted — re-run to compute
  auxDeclus = (saved.declus && saved.declus.params) ? { params: saved.declus.params, weights: null } : null;
  if (saved.xyz && auxPreflightData) auxPreflightData.xyz = saved.xyz;
  auxCalcolCode = saved.calcolCode || '';
  auxCalcolMeta = saved.calcolMeta || [];
  if (calcolMode === 'aux' && $calcolCodeArea) {
    $calcolCodeArea.value = auxCalcolCode;
    syncCodeHighlight();
  }
}

// When the primary file is a multi-entry archive, offer its other entries
// as aux candidates (e.g. a zip holding both the model and its composites)
function renderAuxFromMain() {
  var $wrap = document.getElementById('auxFromMain');
  if (!$wrap) return;
  if (auxFile || !currentFile || !preflightData || !preflightData.zipEntries || preflightData.zipEntries.length < 2) {
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
      '<select class="aux-select" id="auxFromMainSel" style="flex:1">' + opts + '</select>' +
      '<button class="aux-from-main-btn" id="auxFromMainBtn">Use entry</button>' +
    '</div>';
  var sel = document.getElementById('auxFromMainSel');
  var firstFree = preflightData.zipEntries.find(function(z) { return z.name !== preflightData.selectedZipEntry; });
  if (firstFree) sel.value = firstFree.name;
  document.getElementById('auxFromMainBtn').addEventListener('click', function() {
    loadAuxFile(currentFile, null, sel.value);
  });
}

function loadAuxFile(file, handle, zipEntryName) {
  auxFile = file;
  auxHandle = handle || null;
  $auxFileInfo.textContent = 'Loading ' + file.name + '…';
  $auxEmpty.style.display = 'none';
  $auxConfig.style.display = '';
  runPreflight(file).then(async function(data) {
    auxPreflightData = data;
    if (zipEntryName && data.zipEntries && zipEntryName !== data.selectedZipEntry) {
      try { await loadZipEntryIntoPreflight(file, data, zipEntryName); } catch (e) { /* keep default entry */ }
    }
    if (pendingAuxRestore && pendingAuxRestore.fileName === file.name) {
      var savedAux = pendingAuxRestore;
      pendingAuxRestore = null;
      if (savedAux.zipEntry && data.zipEntries && savedAux.zipEntry !== data.selectedZipEntry) {
        try { await loadZipEntryIntoPreflight(file, data, savedAux.zipEntry); } catch (e) { /* entry gone — keep default */ }
      }
      applyAuxRestore(savedAux);
    }
    renderAuxConfig();
    if (typeof renderSwathAuxVars === 'function') renderSwathAuxVars();
    if (typeof refreshCalcolModeToggle === 'function') refreshCalcolModeToggle();
    if (typeof autoSaveProject === 'function') autoSaveProject();
  }).catch(function(err) {
    auxFile = null;
    auxPreflightData = null;
    $auxConfig.style.display = 'none';
    $auxEmpty.style.display = '';
    $auxFileInfo.textContent = '';
    var hint = $auxEmpty.querySelector('.aux-empty-hint');
    if (hint) hint.innerHTML = '<span style="color:var(--red)">Aux load failed: ' + esc(err.message) + '</span>';
  });
}

function clearAux() {
  auxFile = null;
  auxHandle = null;
  auxPreflightData = null;
  auxCompleteData = null;
  auxData = null;
  auxFilter = null;
  auxPrefix = 'aux';
  auxStale = false;
  statsAuxSelected = null;
  statsCdfAuxSelected = new Set();
  auxCalcolCode = '';
  auxCalcolMeta = [];
  auxWeightName = null;
  auxDeclus = null;
  if (auxDeclusWorker) { try { auxDeclusWorker.terminate(); } catch (e) {} auxDeclusWorker = null; }
  if (auxWorker) { try { auxWorker.terminate(); } catch (e) {} auxWorker = null; }
  if (typeof swathAuxWorker !== 'undefined' && swathAuxWorker) { try { swathAuxWorker.terminate(); } catch (e) {} swathAuxWorker = null; }
  $auxConfig.style.display = 'none';
  $auxEmpty.style.display = '';
  $auxSidebar.innerHTML = '';
  $auxPreview.innerHTML = '';
  renderAuxFromMain();
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

// ─── Wiring (runs at load; DOM is already parsed) ─────────────────────
if ($auxDropzone) {
  $auxDropzone.addEventListener('dragover', function(e) { e.preventDefault(); $auxDropzone.classList.add('drag-over'); });
  $auxDropzone.addEventListener('dragleave', function() { $auxDropzone.classList.remove('drag-over'); });
  $auxDropzone.addEventListener('drop', async function(e) {
    e.preventDefault();
    e.stopPropagation(); // keep the $results drop handler from loading this as the main dataset
    $auxDropzone.classList.remove('drag-over');
    var handle = null;
    if (HAS_FSAA && e.dataTransfer.items && e.dataTransfer.items[0] && e.dataTransfer.items[0].getAsFileSystemHandle) {
      try { handle = await e.dataTransfer.items[0].getAsFileSystemHandle(); } catch (ex) {}
    }
    var file = handle ? await handle.getFile() : (e.dataTransfer.files[0] || null);
    if (file) loadAuxFile(file, handle);
  });

  if (HAS_FSAA) {
    $auxDropzone.addEventListener('click', async function(e) {
      if (e.target === $auxFileInput) return;
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
        loadAuxFile(file, handle);
      } catch (ex) { /* cancelled */ }
    });
    if ($auxFileInput) $auxFileInput.style.display = 'none';
  }

  if ($auxFileInput) $auxFileInput.addEventListener('change', function(e) { if (e.target.files.length) loadAuxFile(e.target.files[0], null); });
  if ($auxSidebar) {
    $auxSidebar.addEventListener('input', onAuxConfigChange);
    $auxSidebar.addEventListener('change', onAuxConfigChange);
    $auxSidebar.addEventListener('click', function(e) {
      if (!e.target) return;
      if (e.target.id === 'auxAnalyzeBtn') runAuxAnalysis();
      else if (e.target.id === 'auxDeclusRunBtn') {
        // Run = fresh sweep; an existing pin is released
        if (auxDeclus && auxDeclus.params) auxDeclus.params.pinned = null;
        runAuxDeclus();
      } else if (e.target.id === 'auxDeclusUseBtn') {
        auxWeightName = AUX_DECLUS_WEIGHT;
        markAuxStale();
        renderAuxConfig();
        if (typeof autoSaveProject === 'function') autoSaveProject();
      } else {
        // Click on the sweep curve: pin the nearest cell size and recompute
        var svg = e.target.closest ? e.target.closest('#auxDeclusCurveSvg') : null;
        if (svg && auxDeclus) {
          var pt = auxDeclusNearestPt(svg, e);
          if (pt && pt[2] > 0) {
            auxDeclus.params = auxDeclus.params || {};
            auxDeclus.params.pinned = pt[2];
            runAuxDeclus();
          }
        }
      }
    });
    // Curve scrubbing: crosshair with cell size, declustered mean and Δ%
    $auxSidebar.addEventListener('mousemove', function(e) {
      var svg = e.target && e.target.closest ? e.target.closest('#auxDeclusCurveSvg') : null;
      var anySvg = document.getElementById('auxDeclusCurveSvg');
      if (!svg) { if (anySvg) auxDeclusUpdateCursor(anySvg, null); return; }
      auxDeclusUpdateCursor(svg, auxDeclusNearestPt(svg, e));
    });
    $auxSidebar.addEventListener('mouseleave', function() {
      var svg = document.getElementById('auxDeclusCurveSvg');
      if (svg) auxDeclusUpdateCursor(svg, null);
    });
    // Zip entry switch — re-read header/types/xyz from the chosen entry
    $auxSidebar.addEventListener('change', async function(e) {
      if (!e.target || e.target.id !== 'auxZipEntry' || !auxFile || !auxPreflightData) return;
      try {
        await loadZipEntryIntoPreflight(auxFile, auxPreflightData, e.target.value);
        renderAuxConfig();
        if (typeof renderSwathAuxVars === 'function') renderSwathAuxVars();
        markAuxStale();
        if (typeof autoSaveProject === 'function') autoSaveProject();
      } catch (err) {
        $auxPreview.innerHTML = '<div style="padding:1rem;color:var(--red)">' + esc(err.message) + '</div>';
      }
    });
  }
  var $auxClearBtn = document.getElementById('auxClear');
  if ($auxClearBtn) $auxClearBtn.addEventListener('click', clearAux);
}
