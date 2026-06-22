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
var crosstabView = 'table';       // table | heatmap (Sankey, bars later)
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
    '<div class="crosstab-section"><div class="crosstab-sidebar-title">View</div>' +
      '<select class="stats-select" data-xt="view">' +
        ['table:Cross-table', 'heatmap:Confusion matrix'].map(function (o) {
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
    weightCol: null,   // A19-5: tonnage weighting
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

// Row / column / grand margins for a counts matrix.
function crosstabMargins(data) {
  var aL = data.aLabels, bL = data.bLabels, M = data.counts;
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
  var aL = data.aLabels, bL = data.bLabels, M = data.counts;
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
  return renderCrosstabTable(data);
}

// Cell display per the Show selector — shared by table + heatmap.
function crosstabFmtCell(v, rowTot, colTot, grand) {
  if (crosstabCellMode === 'count') return v ? v.toLocaleString() : '·';
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
  return '<div class="crosstab-caption"><b>' + esc(data.aName) + '</b> (rows) × <b>' + esc(data.bName) + '</b> (columns)' +
    ' · ' + grand.toLocaleString() + ' rows' + (data.weightName ? ' · weighted by ' + esc(data.weightName) : '') + '</div>';
}

// Render the cross-table (counts + row/col/total margins; cell mode = the
// sidebar's Show selector). ∅ = a missing value on that axis (surfaced, A9).
function renderCrosstabTable(data) {
  var content = crosstabContentEl();
  var aL = data.aLabels, bL = data.bLabels, M = data.counts;
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
    html += '<td class="crosstab-total">' + rowTot[i2].toLocaleString() + '</td></tr>';
  }
  html += '<tr class="crosstab-totrow"><th class="crosstab-rowhead">Total</th>';
  for (var j4 = 0; j4 < bL.length; j4++) html += '<td class="crosstab-total">' + colTot[j4].toLocaleString() + '</td>';
  html += '<td class="crosstab-total crosstab-grand">' + grand.toLocaleString() + '</td></tr>';
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
  var aL = data.aLabels, bL = data.bLabels, M = data.counts;
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
        ' <span class="crosstab-stat-sub">(' + ag.nAgree.toLocaleString() + ' on the diagonal)</span></span>' +
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
