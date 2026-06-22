// ─── A19: categorical cross-tabulation (the Cross-tab tab) ─────────────────
// Cross-tabulate two categorical columns of ONE dataset (same rows) — the joint
// distribution shown as a cross TABLE with row/col/total margins (this slice),
// with a confusion-matrix heatmap + Cohen's κ, a Sankey, grouped bars, and
// tonnage-weighting to follow. Runs its own worker pass (mode 'crosstab') over
// the target dataset, mirroring the GT/Swath "own worker" panels. The first
// shippable slice of the day-1 friend feedback on v1.3. Design: roadmap A19.

var crosstabTargetDsId = 'model';
var crosstabColA = null;          // column index into the target's header (or a calcol idx)
var crosstabColB = null;
var crosstabWeightCol = null;     // numeric column index to weight cells by (tonnage/volume), or null
var crosstabView = 'table';       // table | heatmap | sankey | bars
var crosstabBarMode = 'stacked';  // stacked | grouped (bars view)
var crosstabCellMode = 'count';   // count | rowpct | colpct | totalpct
var crosstabWorker = null;
var lastCrosstabData = null;      // the last 'crosstab-complete' message

function crosstabSidebarEl() { return document.getElementById('crosstabSidebar'); }
function crosstabContentEl() { return document.getElementById('crosstabContent'); }

// Datasets the Cross-tab tab can target — those exposing categorical data (C10).
function crosstabTargetableDatasets() { return surfaceTargetableDatasets('categorical'); }
function crosstabTargetDs() {
  return surfaceTarget('categorical', crosstabTargetDsId, { keepUnanalyzed: true });
}

// Resolve the target dataset's worker inputs (mirrors gtCtx) — file, filter,
// calcols, resolved types, row handle, and its categorical column list.
function crosstabCtx() {
  var ds = crosstabTargetDs();
  if (!ds) return null;
  var isModel = ds.id === 'model';
  var c = ds.complete || {};
  return {
    ds: ds, isModel: isModel, complete: ds.complete,
    header: c.header || [], colTypes: c.colTypes || [], categories: c.categories || null,
    file: ds.file, filter: ds.filter, calcolCode: ds.calcolCode, calcolMeta: ds.calcolMeta || [],
    preflight: isModel ? preflightData : ds.preflight, rowVar: ds.rowVar,
    resolvedTypes: isModel
      ? (currentColTypes ? currentColTypes.slice(0, currentOrigColCount) : (c.colTypes || []))
      : ((ds.preflight && ds.preflight.autoTypes) || c.colTypes || [])
  };
}

// The target's categorical columns ({idx, name}), in column order. Sourced from
// the completed analysis's `categories` map (keyed by column index, calcols too).
function crosstabCatCols(ctx) {
  var out = [];
  if (!ctx || !ctx.categories) return out;
  var hdr = ctx.header;
  Object.keys(ctx.categories).forEach(function (k) {
    var idx = parseInt(k), name = hdr[idx];
    if (name) out.push({ idx: idx, name: name });
  });
  out.sort(function (a, b) { return a.idx - b.idx; });
  return out;
}

// The target's numeric columns ({idx, name}) — candidate weights (tonnage /
// volume / density), incl. numeric calcols.
function crosstabNumCols(ctx) {
  var out = [];
  if (!ctx) return out;
  var hdr = ctx.header, ct = ctx.colTypes || [];
  for (var i = 0; i < hdr.length; i++) if (ct[i] === 'numeric' && hdr[i]) out.push({ idx: i, name: hdr[i] });
  return out;
}

// The active matrix: the weighted sums when a weight is set, else raw counts.
function crosstabMatrix(data) { return data.weightName ? data.weights : data.counts; }
// Format a raw value (count = integer; weighted sum = float).
function crosstabFmtNum(v) {
  if (!v) return '0';
  return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function crosstabSetStatus(msg, isErr) {
  var el = document.querySelector('#crosstabSidebar [data-xt="status"]');
  if (el) { el.textContent = msg || ''; el.style.color = isErr ? 'var(--red)' : ''; }
}

function renderCrosstab() {
  var sb = crosstabSidebarEl();
  if (!sb) return;
  var ctx = crosstabCtx();
  var cols = crosstabCatCols(ctx);
  if (!ctx || !ctx.file || cols.length < 2) {
    sb.innerHTML = '<div class="crosstab-sidebar-note">Analyze a dataset with at least two categorical columns to cross-tabulate.</div>';
    var content = crosstabContentEl();
    if (content && !lastCrosstabData) content.innerHTML = '<div class="crosstab-hint">Pick two categorical columns and click Generate to cross-tabulate them.</div>';
    return;
  }
  // default the two columns to the first two distinct categoricals
  if (crosstabColA == null || !cols.some(function (c) { return c.idx === crosstabColA; })) crosstabColA = cols[0].idx;
  if (crosstabColB == null || !cols.some(function (c) { return c.idx === crosstabColB; })) crosstabColB = (cols[1] || cols[0]).idx;

  function colOptions(sel) {
    return cols.map(function (c) {
      return '<option value="' + c.idx + '"' + (c.idx === sel ? ' selected' : '') + '>' + esc(c.name) + '</option>';
    }).join('');
  }
  var numCols = crosstabNumCols(ctx);
  if (crosstabWeightCol != null && !numCols.some(function (c) { return c.idx === crosstabWeightCol; })) crosstabWeightCol = null;
  var weightOptions = '<option value="">— none (count)</option>' + numCols.map(function (c) {
    return '<option value="' + c.idx + '"' + (c.idx === crosstabWeightCol ? ' selected' : '') + '>' + esc(c.name) + '</option>';
  }).join('');
  var picker = (typeof dsPickerHtml === 'function') ? dsPickerHtml({
    facet: 'categorical', current: ctx.ds.id,
    titleClass: 'crosstab-sidebar-title', selectClass: 'stats-select', selAttr: 'data-xt="datasetSel"'
  }) : '';

  sb.innerHTML =
    (picker ? '<div class="crosstab-section" data-xt="datasetWrap">' + picker + '</div>' : '') +
    '<div class="crosstab-section"><div class="crosstab-sidebar-title">Rows (A)</div>' +
      '<select class="stats-select" data-xt="colA">' + colOptions(crosstabColA) + '</select></div>' +
    '<div class="crosstab-section"><div class="crosstab-sidebar-title">Columns (B)</div>' +
      '<select class="stats-select" data-xt="colB">' + colOptions(crosstabColB) + '</select></div>' +
    '<div class="crosstab-section"><div class="crosstab-sidebar-title">Weight (tonnage)</div>' +
      '<select class="stats-select" data-xt="weight">' + weightOptions + '</select></div>' +
    '<div class="crosstab-section"><div class="crosstab-sidebar-title">View</div>' +
      '<select class="stats-select" data-xt="view">' +
        ['table:Cross-table', 'heatmap:Confusion matrix', 'sankey:Sankey', 'bars:Bars'].map(function (o) {
          var p = o.split(':'); return '<option value="' + p[0] + '"' + (p[0] === crosstabView ? ' selected' : '') + '>' + p[1] + '</option>';
        }).join('') +
      '</select></div>' +
    '<div class="crosstab-section"><div class="crosstab-sidebar-title">Show</div>' +
      '<select class="stats-select" data-xt="cellMode">' +
        ['count:Counts', 'rowpct:Row %', 'colpct:Column %', 'totalpct:Total %'].map(function (o) {
          var p = o.split(':'); return '<option value="' + p[0] + '"' + (p[0] === crosstabCellMode ? ' selected' : '') + '>' + p[1] + '</option>';
        }).join('') +
      '</select></div>' +
    '<div class="crosstab-section">' +
      '<button class="gt-generate" data-xt="generate">Generate ▶</button>' +
      '<div class="crosstab-progress" data-xt="progress"><div class="crosstab-progress-bar"><div class="crosstab-progress-fill" data-xt="progressFill"></div></div></div>' +
      '<div class="crosstab-status" data-xt="status"></div>' +
    '</div>';

  wireCrosstab();
}

function wireCrosstab() {
  var sb = crosstabSidebarEl();
  if (!sb) return;
  var dsSel = sb.querySelector('[data-xt="datasetSel"]');
  if (dsSel) dsSel.onchange = function () {
    crosstabTargetDsId = dsSel.value; crosstabColA = null; crosstabColB = null; lastCrosstabData = null;
    renderCrosstab();
    var content = crosstabContentEl();
    if (content) content.innerHTML = '<div class="crosstab-hint">Pick two categorical columns and click Generate to cross-tabulate them.</div>';
  };
  var a = sb.querySelector('[data-xt="colA"]'); if (a) a.onchange = function () { crosstabColA = parseInt(a.value); autoSaveProject && autoSaveProject(); };
  var b = sb.querySelector('[data-xt="colB"]'); if (b) b.onchange = function () { crosstabColB = parseInt(b.value); autoSaveProject && autoSaveProject(); };
  var wt = sb.querySelector('[data-xt="weight"]'); if (wt) wt.onchange = function () { crosstabWeightCol = wt.value === '' ? null : parseInt(wt.value); autoSaveProject && autoSaveProject(); };
  var vw = sb.querySelector('[data-xt="view"]'); if (vw) vw.onchange = function () {
    crosstabView = vw.value;
    if (lastCrosstabData) renderCrosstabResult(lastCrosstabData);   // re-render from cache (no re-run)
    autoSaveProject && autoSaveProject();
  };
  var cm = sb.querySelector('[data-xt="cellMode"]'); if (cm) cm.onchange = function () {
    crosstabCellMode = cm.value;
    if (lastCrosstabData) renderCrosstabResult(lastCrosstabData);   // re-render from cache (no re-run)
    autoSaveProject && autoSaveProject();
  };
  var gen = sb.querySelector('[data-xt="generate"]'); if (gen) gen.onclick = runCrosstab;
}

function runCrosstab() {
  var ctx = crosstabCtx();
  if (!ctx || !ctx.file) { crosstabSetStatus('Analyze a dataset first', true); return; }
  if (crosstabColA == null || crosstabColB == null) { crosstabSetStatus('Pick two columns', true); return; }
  if (crosstabWorker) { try { crosstabWorker.terminate(); } catch (e) {} crosstabWorker = null; }

  var sb = crosstabSidebarEl();
  var prog = sb && sb.querySelector('[data-xt="progress"]');
  var fill = sb && sb.querySelector('[data-xt="progressFill"]');
  var gen = sb && sb.querySelector('[data-xt="generate"]');
  if (prog) prog.classList.add('active');
  if (fill) fill.style.width = '0%';
  if (gen) gen.disabled = true;
  crosstabSetStatus('');

  crosstabWorker = new Worker(workerUrl);
  crosstabWorker.postMessage({
    mode: 'crosstab',
    file: ctx.file,
    zipEntry: ctx.preflight ? (ctx.preflight.selectedZipEntry || null) : null,
    globalFilter: ctx.filter ? { expression: ctx.filter.expression } : null,
    localFilter: null,
    calcolCode: ctx.calcolCode || null,
    calcolMeta: (ctx.calcolMeta && ctx.calcolMeta.length > 0) ? ctx.calcolMeta : null,
    resolvedTypes: ctx.resolvedTypes,
    rowVarOverride: ctx.rowVar,
    colA: crosstabColA, colB: crosstabColB,
    weightCol: crosstabWeightCol,   // A19-5: tonnage/volume weighting (null = count)
    dmEndianness: (ctx.preflight && ctx.preflight.dmEndianness) || null,
    dmFormat: (ctx.preflight && ctx.preflight.dmFormat) || null
  });
  crosstabWorker.onmessage = function (e) {
    var m = e.data;
    if (m.type === 'crosstab-progress') {
      if (fill) fill.style.width = m.percent.toFixed(0) + '%';
    } else if (m.type === 'crosstab-complete') {
      try { crosstabWorker.terminate(); } catch (e2) {}
      crosstabWorker = null;
      if (prog) prog.classList.remove('active');
      if (gen) gen.disabled = false;
      lastCrosstabData = m;
      renderCrosstabResult(m);
      if (typeof wsTabBadge === 'function') wsTabBadge('crosstab', 'Cross-tab', m.kept ? m.kept.toLocaleString() : null);
      autoSaveProject && autoSaveProject();
    } else if (m.type === 'error') {
      try { crosstabWorker.terminate(); } catch (e2) {}
      crosstabWorker = null;
      if (prog) prog.classList.remove('active');
      if (gen) gen.disabled = false;
      crosstabSetStatus(m.message || 'Error', true);
    }
  };
  crosstabWorker.onerror = function (e) {
    if (prog) prog.classList.remove('active');
    if (gen) gen.disabled = false;
    crosstabSetStatus('Worker error: ' + (e.message || 'unknown'), true);
  };
}

// Row / column / grand margins for the active (count or weighted) matrix.
function crosstabMargins(data) {
  var aL = data.aLabels, bL = data.bLabels, M = crosstabMatrix(data);
  var rowTot = aL.map(function (_, i) { return M[i].reduce(function (s, v) { return s + v; }, 0); });
  var colTot = bL.map(function (_, j) { return aL.reduce(function (s, _2, i) { return s + M[i][j]; }, 0); });
  var grand = rowTot.reduce(function (s, v) { return s + v; }, 0);
  return { rowTot: rowTot, colTot: colTot, grand: grand };
}

// Observed agreement + Cohen's κ over the UNION of the two columns' category
// labels (a cell on the diagonal = matching labels = agreement). Meaningful when
// the two columns are the same classification (CLASS_2024 × CLASS_2025); for
// unrelated categoricals κ ≈ 0 (no systematic agreement), which is itself the
// signal. po = Σ n_kk / N; pe = Σ (n_k+/N)(n_+k/N); κ = (po−pe)/(1−pe).
function crosstabAgreement(data) {
  var aL = data.aLabels, bL = data.bLabels, M = crosstabMatrix(data);
  var m = crosstabMargins(data), N = m.grand;
  if (!N) return null;
  var aIdx = {}, bIdx = {}, set = {};
  aL.forEach(function (l, i) { aIdx[l] = i; set[l] = 1; });
  bL.forEach(function (l, j) { bIdx[l] = j; set[l] = 1; });
  var po = 0, pe = 0;
  Object.keys(set).forEach(function (k) {
    var i = aIdx[k], j = bIdx[k];
    if (i != null && j != null) po += M[i][j];
    var rk = (i != null) ? m.rowTot[i] : 0, ck = (j != null) ? m.colTot[j] : 0;
    pe += (rk / N) * (ck / N);
  });
  var poFrac = po / N;
  return { agreement: poFrac, nAgree: po, N: N, kappa: (1 - pe) > 1e-12 ? (poFrac - pe) / (1 - pe) : null };
}
// Landis & Koch (1977) strength-of-agreement bands.
function crosstabKappaLabel(k) {
  if (k == null) return '';
  if (k < 0) return 'poor'; if (k < 0.2) return 'slight'; if (k < 0.4) return 'fair';
  if (k < 0.6) return 'moderate'; if (k < 0.8) return 'substantial'; return 'almost perfect';
}

function renderCrosstabResult(data) {
  var content = crosstabContentEl();
  if (!content) return;
  if (!data || !data.aLabels.length || !data.bLabels.length) {
    content.innerHTML = '<div class="crosstab-hint">No rows to cross-tabulate (everything filtered out?).</div>';
    return;
  }
  if (crosstabView === 'heatmap') return renderCrosstabHeatmap(data);
  if (crosstabView === 'sankey') return renderCrosstabSankey(data);
  if (crosstabView === 'bars') return renderCrosstabBars(data);
  return renderCrosstabTable(data);
}

// A distinct hue per category index — theme-independent, readable on both shells.
function crosstabHue(i) { return (i * 53) % 360; }

// Cell display per the Show selector — shared by table + heatmap.
function crosstabFmtCell(v, rowTot, colTot, grand) {
  if (crosstabCellMode === 'count') return v ? crosstabFmtNum(v) : '·';
  var den = crosstabCellMode === 'rowpct' ? rowTot : crosstabCellMode === 'colpct' ? colTot : grand;
  if (!den) return '·';
  var pct = (v / den) * 100;
  return v ? (pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)) + '%' : '·';
}
function crosstabLbl(s) { return s === '∅' ? '<span class="crosstab-null" title="missing value">∅</span>' : esc(s); }

// no-silent-loss notes (missing / overflow / weight-excluded) — shared.
function crosstabNotesHtml(data) {
  var notes = [];
  if (data.aMissing) notes.push(esc(data.aName) + ': ' + data.aMissing.toLocaleString() + ' missing (∅)');
  if (data.bMissing) notes.push(esc(data.bName) + ': ' + data.bMissing.toLocaleString() + ' missing (∅)');
  if (data.weightExcluded) notes.push(data.weightExcluded.toLocaleString() + ' rows excluded (invalid weight)');
  if (data.aOverflow || data.bOverflow) notes.push('truncated to 200 categories per axis');
  return notes.length ? '<div class="crosstab-notes">⚠ ' + notes.join(' · ') + '</div>' : '';
}
function crosstabCaptionHtml(data, grand) {
  var rows = (data.kept != null ? data.kept : grand);
  return '<div class="crosstab-caption"><b>' + esc(data.aName) + '</b> (rows) × <b>' + esc(data.bName) + '</b> (columns)' +
    ' · ' + rows.toLocaleString() + ' rows' +
    (data.weightName ? ' · Σ ' + esc(data.weightName) + ' = ' + crosstabFmtNum(grand) : '') + '</div>';
}

// Render the cross-table (counts + row/col/total margins; cell mode = the
// sidebar's Show selector). ∅ = a missing value on that axis (surfaced, A9).
function renderCrosstabTable(data) {
  var content = crosstabContentEl();
  var aL = data.aLabels, bL = data.bLabels, M = crosstabMatrix(data);
  var m = crosstabMargins(data), rowTot = m.rowTot, colTot = m.colTot, grand = m.grand;

  var maxCount = 1;
  for (var i = 0; i < aL.length; i++) for (var j = 0; j < bL.length; j++) if (M[i][j] > maxCount) maxCount = M[i][j];

  var html = crosstabCaptionHtml(data, grand) + crosstabNotesHtml(data);
  html += '<div class="crosstab-table-wrap"><table class="crosstab-table"><thead><tr>' +
    '<th class="crosstab-corner">' + esc(data.aName) + ' \\ ' + esc(data.bName) + '</th>';
  for (var j2 = 0; j2 < bL.length; j2++) html += '<th>' + crosstabLbl(bL[j2]) + '</th>';
  html += '<th class="crosstab-total">Total</th></tr></thead><tbody>';
  for (var i2 = 0; i2 < aL.length; i2++) {
    html += '<tr><th class="crosstab-rowhead">' + crosstabLbl(aL[i2]) + '</th>';
    for (var j3 = 0; j3 < bL.length; j3++) {
      var v = M[i2][j3];
      var alpha = v ? (0.08 + 0.5 * (v / maxCount)).toFixed(3) : 0;
      var diag = (aL[i2] === bL[j3]) ? ' crosstab-diag' : '';
      html += '<td class="crosstab-cell' + diag + '" style="background:rgba(127,127,127,' + alpha + ')">' + crosstabFmtCell(v, rowTot[i2], colTot[j3], grand) + '</td>';
    }
    html += '<td class="crosstab-total">' + crosstabFmtNum(rowTot[i2]) + '</td></tr>';
  }
  html += '<tr class="crosstab-totrow"><th class="crosstab-rowhead">Total</th>';
  for (var j4 = 0; j4 < bL.length; j4++) html += '<td class="crosstab-total">' + crosstabFmtNum(colTot[j4]) + '</td>';
  html += '<td class="crosstab-total crosstab-grand">' + crosstabFmtNum(grand) + '</td></tr>';
  html += '</tbody></table></div>';

  content.innerHTML = html;
}

// Confusion-matrix heatmap: the same matrix with magnitude-shaded square cells,
// the matching-label diagonal outlined, and an agreement / Cohen's κ readout.
// κ is most meaningful when the two columns are the same classification (e.g.
// CLASS_2024 × CLASS_2025) — the caveat is shown. ∅ rows/cols participate (both
// missing = agreement), surfaced by the notes.
function renderCrosstabHeatmap(data) {
  var content = crosstabContentEl();
  var aL = data.aLabels, bL = data.bLabels, M = crosstabMatrix(data);
  var m = crosstabMargins(data), rowTot = m.rowTot, colTot = m.colTot, grand = m.grand;
  var maxCount = 1;
  for (var i = 0; i < aL.length; i++) for (var j = 0; j < bL.length; j++) if (M[i][j] > maxCount) maxCount = M[i][j];

  var ag = crosstabAgreement(data);
  var html = crosstabCaptionHtml(data, grand);
  if (ag) {
    var kTxt = ag.kappa == null ? '—' : ag.kappa.toFixed(3);
    var kLbl = crosstabKappaLabel(ag.kappa);
    html += '<div class="crosstab-stats">' +
      '<span class="crosstab-stat"><b>' + (ag.agreement * 100).toFixed(1) + '%</b> agreement' +
        ' <span class="crosstab-stat-sub">(' + crosstabFmtNum(ag.nAgree) + ' on the diagonal)</span></span>' +
      '<span class="crosstab-stat">Cohen’s κ <b>' + kTxt + '</b>' + (kLbl ? ' <span class="crosstab-stat-sub">(' + kLbl + ')</span>' : '') + '</span>' +
      '</div>' +
      '<div class="crosstab-stat-note">Agreement &amp; κ treat matching labels as agreement — most meaningful when both columns are the same classification.</div>';
  }
  html += crosstabNotesHtml(data);

  html += '<div class="crosstab-table-wrap"><table class="crosstab-table crosstab-heatmap"><thead><tr>' +
    '<th class="crosstab-corner">' + esc(data.aName) + ' \\ ' + esc(data.bName) + '</th>';
  for (var j2 = 0; j2 < bL.length; j2++) html += '<th>' + crosstabLbl(bL[j2]) + '</th>';
  html += '</tr></thead><tbody>';
  for (var i2 = 0; i2 < aL.length; i2++) {
    html += '<tr><th class="crosstab-rowhead">' + crosstabLbl(aL[i2]) + '</th>';
    for (var j3 = 0; j3 < bL.length; j3++) {
      var v = M[i2][j3];
      var diag = (aL[i2] === bL[j3]);
      var frac = v ? (v / maxCount) : 0;
      // diagonal (agreement) shaded green, off-diagonal neutral gray
      var bg = diag
        ? 'rgba(76,175,80,' + (v ? (0.12 + 0.6 * frac).toFixed(3) : 0) + ')'
        : 'rgba(127,127,127,' + (v ? (0.08 + 0.5 * frac).toFixed(3) : 0) + ')';
      html += '<td class="crosstab-hcell' + (diag ? ' crosstab-diag' : '') + '" style="background:' + bg + '">' +
        crosstabFmtCell(v, rowTot[i2], colTot[j3], grand) + '</td>';
    }
    html += '</tr>';
  }
  html += '</tbody></table></div>';

  content.innerHTML = html;
}

// Sankey: the matrix as FLOWS — left nodes = A categories, right nodes = B
// categories, each ribbon = a cell (width ∝ count), coloured by its source (A).
// The transition / reconciliation view (CLASS_2024 → CLASS_2025, resource →
// reserve). Hand-rolled SVG (no deps), node heights ∝ row/column totals.
function renderCrosstabSankey(data) {
  var content = crosstabContentEl();
  var aL = data.aLabels, bL = data.bLabels, M = crosstabMatrix(data);
  var m = crosstabMargins(data), rowTot = m.rowTot, colTot = m.colTot, grand = m.grand;
  if (!grand) { content.innerHTML = crosstabCaptionHtml(data, grand) + '<div class="crosstab-hint">No flows to draw.</div>'; return; }

  var nA = aL.length, nB = bL.length;
  var W = 720, gap = 6, nodeW = 14, labelPad = 6, topM = 24;
  var leftLabel = 150, rightLabel = 150;
  var lx = leftLabel, rx = W - rightLabel - nodeW;          // node column x
  var plotH = Math.max(280, Math.max(nA, nB) * 30);
  var maxGaps = gap * (Math.max(nA, nB) - 1);
  var scale = (plotH - maxGaps) / grand;                     // shared px/count both sides
  var H = plotH + topM + 14;

  var aY = [], y = topM; for (var i = 0; i < nA; i++) { aY.push(y); y += rowTot[i] * scale + gap; }
  var bY = [], y2 = topM; for (var j = 0; j < nB; j++) { bY.push(y2); y2 += colTot[j] * scale + gap; }

  var svg = '<svg class="crosstab-sankey" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMin meet">';
  svg += '<text class="crosstab-sankey-head" x="' + (lx + nodeW / 2) + '" y="12" text-anchor="middle">' + esc(data.aName) + '</text>';
  svg += '<text class="crosstab-sankey-head" x="' + (rx + nodeW / 2) + '" y="12" text-anchor="middle">' + esc(data.bName) + '</text>';

  // ribbons (source-coloured), stacked per node in the matrix order
  var lOff = aY.slice(), rOff = bY.slice();
  for (var i2 = 0; i2 < nA; i2++) {
    for (var j2 = 0; j2 < nB; j2++) {
      var v = M[i2][j2]; if (!v) continue;
      var h = v * scale, ly = lOff[i2], ry = rOff[j2];
      lOff[i2] += h; rOff[j2] += h;
      var x0 = lx + nodeW, x1 = rx, cx = x0 + (x1 - x0) / 2;
      var path = 'M' + x0 + ',' + ly + ' C' + cx + ',' + ly + ' ' + cx + ',' + ry + ' ' + x1 + ',' + ry +
        ' L' + x1 + ',' + (ry + h) + ' C' + cx + ',' + (ry + h) + ' ' + cx + ',' + (ly + h) + ' ' + x0 + ',' + (ly + h) + ' Z';
      svg += '<path class="crosstab-flow" d="' + path + '" fill="hsl(' + crosstabHue(i2) + ',55%,55%)" fill-opacity="0.34">' +
        '<title>' + esc(aL[i2]) + ' → ' + esc(bL[j2]) + ': ' + crosstabFmtNum(v) + '</title></path>';
    }
  }
  // nodes + labels
  for (var i3 = 0; i3 < nA; i3++) {
    var nh = Math.max(rowTot[i3] * scale, 1);
    svg += '<rect class="crosstab-node" x="' + lx + '" y="' + aY[i3] + '" width="' + nodeW + '" height="' + nh + '" fill="hsl(' + crosstabHue(i3) + ',55%,50%)"><title>' + esc(aL[i3]) + ': ' + crosstabFmtNum(rowTot[i3]) + '</title></rect>';
    svg += '<text class="crosstab-sankey-lbl" x="' + (lx - labelPad) + '" y="' + (aY[i3] + nh / 2) + '" text-anchor="end" dominant-baseline="middle">' + esc(aL[i3]) + '</text>';
  }
  for (var j3 = 0; j3 < nB; j3++) {
    var nh2 = Math.max(colTot[j3] * scale, 1);
    svg += '<rect class="crosstab-node" x="' + rx + '" y="' + bY[j3] + '" width="' + nodeW + '" height="' + nh2 + '" fill="hsl(' + crosstabHue(j3) + ',30%,50%)"><title>' + esc(bL[j3]) + ': ' + crosstabFmtNum(colTot[j3]) + '</title></rect>';
    svg += '<text class="crosstab-sankey-lbl" x="' + (rx + nodeW + labelPad) + '" y="' + (bY[j3] + nh2 / 2) + '" text-anchor="start" dominant-baseline="middle">' + esc(bL[j3]) + '</text>';
  }
  svg += '</svg>';

  content.innerHTML = crosstabCaptionHtml(data, grand) + crosstabNotesHtml(data) + '<div class="crosstab-sankey-wrap">' + svg + '</div>';
}

// Bars: one cluster per A category, segments coloured by B category. Stacked or
// grouped (toggle); the Show selector drives absolute counts vs per-row %
// (a pct mode → 100%-stacked / share-grouped, normalized within each A bar).
function renderCrosstabBars(data) {
  var content = crosstabContentEl();
  var aL = data.aLabels, bL = data.bLabels, M = crosstabMatrix(data);
  var m = crosstabMargins(data), rowTot = m.rowTot, grand = m.grand;
  if (!grand) { content.innerHTML = crosstabCaptionHtml(data, grand) + '<div class="crosstab-hint">No data to plot.</div>'; return; }
  var nA = aL.length, nB = bL.length;
  var pct = (crosstabCellMode !== 'count');
  var grouped = (crosstabBarMode === 'grouped');
  function val(i, j) { return pct ? (rowTot[i] ? M[i][j] / rowTot[i] * 100 : 0) : M[i][j]; }

  var W = 720, mL = 48, mT = 14, mB = 48, legendW = 150;
  var plotH = 300, H = plotH + mT + mB;
  var plotW = W - mL - legendW, plotR = W - legendW;

  var maxVal = 1;
  if (pct) maxVal = 100;
  else if (grouped) { for (var i = 0; i < nA; i++) for (var j = 0; j < nB; j++) if (M[i][j] > maxVal) maxVal = M[i][j]; }
  else { maxVal = Math.max.apply(null, rowTot.concat([1])); }

  function ty(v) { return mT + plotH - (v / maxVal) * plotH; }
  function tickLabel(v) { return pct ? Math.round(v) + '%' : (v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k' : '' + Math.round(v)); }

  var svg = '<svg class="crosstab-bars" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMin meet">';
  // y gridlines + ticks
  [0, 0.5, 1].forEach(function (f) {
    var v = maxVal * f, yy = ty(v);
    svg += '<line class="crosstab-grid" x1="' + mL + '" y1="' + yy + '" x2="' + plotR + '" y2="' + yy + '"/>';
    svg += '<text class="crosstab-axis-lbl" x="' + (mL - 6) + '" y="' + (yy + 3) + '" text-anchor="end">' + tickLabel(v) + '</text>';
  });

  var clusterW = plotW / nA, barPad = clusterW * 0.16;
  for (var i2 = 0; i2 < nA; i2++) {
    var cx0 = mL + i2 * clusterW + barPad, cw = clusterW - 2 * barPad;
    if (grouped) {
      var sw = cw / nB;
      for (var j = 0; j < nB; j++) {
        var v2 = val(i2, j), h2 = (v2 / maxVal) * plotH;
        svg += '<rect class="crosstab-bar" x="' + (cx0 + j * sw) + '" y="' + (mT + plotH - h2) + '" width="' + (sw * 0.86) + '" height="' + h2 + '" fill="hsl(' + crosstabHue(j) + ',55%,52%)"><title>' + esc(aL[i2]) + ' · ' + esc(bL[j]) + ': ' + crosstabFmtNum(M[i2][j]) + '</title></rect>';
      }
    } else {
      var yacc = mT + plotH;
      for (var j2 = 0; j2 < nB; j2++) {
        var v3 = val(i2, j2), h3 = (v3 / maxVal) * plotH;
        svg += '<rect class="crosstab-bar" x="' + cx0 + '" y="' + (yacc - h3) + '" width="' + cw + '" height="' + h3 + '" fill="hsl(' + crosstabHue(j2) + ',55%,52%)"><title>' + esc(aL[i2]) + ' · ' + esc(bL[j2]) + ': ' + crosstabFmtNum(M[i2][j2]) + '</title></rect>';
        yacc -= h3;
      }
    }
    svg += '<text class="crosstab-axis-lbl" x="' + (cx0 + cw / 2) + '" y="' + (mT + plotH + 14) + '" text-anchor="middle">' + esc(aL[i2]) + '</text>';
  }
  svg += '<line class="crosstab-axis" x1="' + mL + '" y1="' + (mT + plotH) + '" x2="' + plotR + '" y2="' + (mT + plotH) + '"/>';
  // legend (B categories)
  for (var lj = 0; lj < nB; lj++) {
    var ly = mT + 4 + lj * 18;
    svg += '<rect x="' + (plotR + 12) + '" y="' + ly + '" width="11" height="11" fill="hsl(' + crosstabHue(lj) + ',55%,52%)"/>';
    svg += '<text class="crosstab-axis-lbl" x="' + (plotR + 28) + '" y="' + (ly + 10) + '" text-anchor="start">' + esc(bL[lj]) + '</text>';
  }
  svg += '</svg>';

  var toggle = '<div class="crosstab-bar-toggle">' +
    '<button data-bar="stacked"' + (grouped ? '' : ' class="active"') + '>Stacked</button>' +
    '<button data-bar="grouped"' + (grouped ? ' class="active"' : '') + '>Grouped</button></div>';
  content.innerHTML = crosstabCaptionHtml(data, grand) + crosstabNotesHtml(data) + toggle + '<div class="crosstab-bars-wrap">' + svg + '</div>';

  content.querySelectorAll('.crosstab-bar-toggle button').forEach(function (btn) {
    btn.onclick = function () {
      crosstabBarMode = btn.getAttribute('data-bar');
      if (lastCrosstabData) renderCrosstabResult(lastCrosstabData);
      autoSaveProject && autoSaveProject();
    };
  });
}
