// ─── Export Tab ────────────────────────────────────────────────────────

// A10 G5a: which DATASET the Export tab targets ('model' | 'aux' | 'd2' …). The
// Export tab generalizes beyond the model: any analyzed dataset gets its own
// column selection + output names, exported from ITS file/filter/calcols/rowVar.
// There is ONE Export panel (singleton DOM), so the render/wire functions resolve
// the target internally via exportCtx() — no root threading. Per-dataset state is
// the DATA-BOUND column list + detected source precision (ds.export); the FORMAT
// settings (delimiter/quote/precision/…) stay SHARED globals.
let exportTargetDsId = 'model';
function exportNewState() { return { columns: [], sourcePrecision: {} }; }
// Accessor proxy: for the model, get/set route to the live core.js globals so
// serialize/restore stay bit-identical and unpolluted by a comparison's columns.
const _exportSingleton = {
  get columns() { return exportColumns; }, set columns(v) { exportColumns = v; },
  get sourcePrecision() { return exportSourcePrecision; }, set sourcePrecision(v) { exportSourcePrecision = v; }
};
function exportStateFor(id) {
  if (!id || id === 'model') return _exportSingleton;
  var ds = dsById(id);
  if (!ds) return _exportSingleton;
  if (!ds.export) ds.export = exportNewState();
  return ds.export;
}
// A10 G5b: clone arc. Export clones into independent dockable panels — like
// StatsCat, the independence is the TARGET DATASET (per-instance) + its column
// selection (which lives on ds.export, so two clones on one dataset mirror). The
// FORMAT settings (delimiter/precision/…) are SHARED globals; clones hide the
// format section. Singleton resolves DOM via $export* refs + target via
// exportTargetDsId; a clone carries data-export-inst on its root.
var exportInstances = {};   // instId -> { targetDsId }
var exportInstanceEls = {}; // instId -> cloned DOM element
var exportInstSeq = 0;
function exportNextInstId() { return 'export#' + (++exportInstSeq); }
function exportNewInstState() { return { targetDsId: 'model' }; }
function exportIsInst(root) { return surfaceIsInst(root, 'data-export-inst'); }
function exportInstTarget(root) {
  // clone target lives in its instance state; singleton in the module global.
  var st = surfaceInstState(root, 'data-export-inst', exportInstances, exportNewInstState);
  return st ? st.targetDsId : exportTargetDsId;
}
// DOM bundle: singleton → $export* refs; clone → [data-export] within root.
function exportEls(root) {
  if (!exportIsInst(root)) {
    return { colList: $exportColList, colSearch: $exportColSearch, badge: $exportBadge, rowPreview: $exportRowPreview,
      previewPre: $exportPreviewPre, previewInfo: $exportPreviewInfo, precisionWarn: $exportPrecisionWarn,
      download: $exportDownload, progress: $exportProgress, progressLabel: $exportProgressLabel,
      progressFill: $exportProgressFill, info: $exportInfo,
      selAll: document.getElementById('exportSelAll'), selNone: document.getElementById('exportSelNone'),
      selOrig: document.getElementById('exportSelOrig'), selCalc: document.getElementById('exportSelCalc'),
      datasetWrap: document.getElementById('exportDatasetWrap') };
  }
  function q(n) { return root.querySelector('[data-export="' + n + '"]'); }
  return { colList: q('exportColList'), colSearch: q('exportColSearch'), badge: q('exportBadge'), rowPreview: q('exportRowPreview'),
    previewPre: q('exportPreviewPre'), previewInfo: q('exportPreviewInfo'), precisionWarn: q('exportPrecisionWarn'),
    download: q('exportDownload'), progress: q('exportProgress'), progressLabel: q('exportProgressLabel'),
    progressFill: q('exportProgressFill'), info: q('exportInfo'),
    selAll: q('exportSelAll'), selNone: q('exportSelNone'), selOrig: q('exportSelOrig'), selCalc: q('exportSelCalc'),
    datasetWrap: q('exportDatasetWrap') };
}
function exportTargetDs(root) {
  // keepUnanalyzed: a non-model target restored before re-analysis is kept (it
  // re-analyzes on demand); only the model target bounces to a comparison (C10 P2).
  return surfaceTarget('analyzed', exportInstTarget(root), { keepUnanalyzed: true });
}
function exportCtx(root) {
  var ds = exportTargetDs(root);
  var isModel = ds.id === 'model';
  var S = exportStateFor(ds.id);
  var c = ds.complete || {};
  return {
    ds: ds, isModel: isModel, S: S, els: exportEls(root), root: root || null,
    header: isModel ? currentHeader : (c.header || []),
    colTypes: isModel ? currentColTypes : (c.colTypes || []),
    origColCount: isModel ? currentOrigColCount : ((c.origColCount != null) ? c.origColCount : ((c.header ? c.header.length : 0) - ((ds.calcolMeta || []).length))),
    file: ds.file,
    filter: isModel ? currentFilter : (ds.filter || null),
    calcolCode: isModel ? currentCalcolCode : (ds.calcolCode || null),
    calcolMeta: isModel ? currentCalcolMeta : (ds.calcolMeta || []),
    preflight: isModel ? preflightData : ds.preflight,
    rowVar: isModel ? undefined : ds.rowVar,
    resolvedTypes: isModel
      ? (currentColTypes ? currentColTypes.slice(0, currentOrigColCount) : [])
      : ((ds.preflight && ds.preflight.autoTypes) || c.colTypes || []),
    rowCount: isModel ? (lastCompleteData ? lastCompleteData.rowCount : 0) : ((c.rowCount != null) ? c.rowCount : 0),
    totalRowCount: isModel ? (lastCompleteData ? lastCompleteData.totalRowCount : 0) : ((c.totalRowCount != null) ? c.totalRowCount : (c.rowCount || 0))
  };
}

// G5a: datasets the Export tab can target — any with a completed analysis.
function exportTargetableDatasets() { return surfaceTargetableDatasets('analyzed'); }  // C10 P0
// The "Dataset" picker at the top of the Export sidebar — shown only when 2+
// datasets are analyzed (with one, Export is implicitly the model, as before).
function exportRenderDatasetPicker(root) {
  var wrap = exportEls(root).datasetWrap;
  if (!wrap) return;
  wrap.innerHTML = dsPickerHtml({ facet: 'analyzed', current: exportTargetDs(root).id,
    titleClass: 'export-sidebar-title', selectClass: 'export-select', selAttr: 'data-export-ds="1"' });
  var sel = wrap.querySelector('[data-export-ds]');
  if (sel) sel.onchange = function() { setExportTarget(sel.value, root); };
}
// Switch the Export target dataset (per-panel): build its column list on first
// visit (else keep the dataset's existing selection), then re-render the panel.
function setExportTarget(id, root) {
  if (id === exportInstTarget(root)) return;
  if (exportIsInst(root)) {
    var iid = root.getAttribute('data-export-inst');
    if (!exportInstances[iid]) exportInstances[iid] = exportNewInstState();
    exportInstances[iid].targetDsId = id;
  } else {
    exportTargetDsId = id;
  }
  var els = exportEls(root);
  if (els.colSearch) els.colSearch.value = '';
  var tds = exportTargetDs(root);
  if (tds && tds._pendingExport) applyExportDsRestore(tds);   // restored selection awaiting this switch
  var C = exportCtx(root);
  if (!C.S.columns || C.S.columns.length === 0) {
    initExportColumns(root);   // first visit — seed from this dataset's header
  } else {
    detectSourcePrecision(root);
    renderExportColumns(root);
    updateExportRowPreview(root);
    updateExportPreview(root);
  }
  exportRenderDatasetPicker(root);
  updateExportWarnings(root);
  if (typeof autoSaveProject === 'function') autoSaveProject();
}
// Run fn(root) for every Export panel (singleton + clones) targeting dsId.
function exportForEachPanelTargeting(dsId, fn) {
  if (exportTargetDsId === dsId) fn(undefined);
  Object.keys(exportInstances).forEach(function(iid) {
    if (exportInstances[iid].targetDsId === dsId) {
      var root = document.querySelector('[data-export-inst="' + iid + '"]');
      if (root) fn(root);
    }
  });
}
// Keep every panel's picker current as datasets analyze/clear; bounce a panel to
// the model only if its target is GONE from the registry.
function exportRefreshDatasetPicker() {
  if (exportTargetDsId !== 'model' && !dsById(exportTargetDsId)) {
    exportTargetDsId = 'model';
    initExportColumns(undefined);
  }
  exportRenderDatasetPicker(undefined);
  Object.keys(exportInstances).forEach(function(iid) {
    var root = document.querySelector('[data-export-inst="' + iid + '"]');
    if (!root) return;
    if (exportInstances[iid].targetDsId !== 'model' && !dsById(exportInstances[iid].targetDsId)) {
      exportInstances[iid].targetDsId = 'model';
      initExportColumns(root);
    }
    exportRenderDatasetPicker(root);
  });
}

// A10 G5b: build a cloned Export panel — an independent target-dataset window with
// its own column selection. Clones #panelExport, strips ids (DOM resolves by
// [data-export] within root), hides the shared FORMAT section, wires its controls,
// and builds the column list for its target. Cached for rails' double renderPanel.
function exportBuildInstancePanel(instId) {
  var tmpl = document.getElementById('panelExport');
  if (!tmpl) return null;
  if (exportInstanceEls[instId] && document.contains(exportInstanceEls[instId])) return exportInstanceEls[instId];
  if (!exportInstances[instId]) exportInstances[instId] = exportNewInstState();
  var el = tmpl.cloneNode(true);
  el.removeAttribute('id');
  el.querySelectorAll('[id]').forEach(function(n) { n.removeAttribute('id'); });
  el.setAttribute('data-export-inst', instId);
  el.setAttribute('data-tab', instId);
  el.classList.add('active');
  // Format settings are SHARED (the singleton owns them) — hide on clones.
  var fmt = el.querySelector('[data-export="exportFormatSection"]'); if (fmt) fmt.style.display = 'none';
  var cmt = el.querySelector('[data-export="exportCommentSection"]'); if (cmt) cmt.style.display = 'none';
  wireExportControls(el);
  var tds = exportTargetDs(el);
  if (tds && tds._pendingExport) applyExportDsRestore(tds);
  var C = exportCtx(el);
  if (!C.S.columns || C.S.columns.length === 0) initExportColumns(el);
  else { detectSourcePrecision(el); renderExportColumns(el); updateExportRowPreview(el); updateExportPreview(el); }
  exportInstanceEls[instId] = el;
  return el;
}
function exportDisposeInstance(instId) {
  var st = exportInstances[instId];
  if (st && st._worker) { try { st._worker.terminate(); } catch (e) {} }
  delete exportInstances[instId];
  delete exportInstanceEls[instId];
}
// Re-render every clone (a dataset's analysis changed).
function exportRenderAllInstances() {
  Object.keys(exportInstances).forEach(function(id) {
    var root = document.querySelector('[data-export-inst="' + id + '"]');
    if (!root) return;
    var C = exportCtx(root);
    if (!C.S.columns || C.S.columns.length === 0) initExportColumns(root);
    else { renderExportColumns(root); updateExportRowPreview(root); updateExportPreview(root); }
  });
}
function exportSerializeInstances() {
  return Object.keys(exportInstances).map(function(id) { return { id: id, targetDsId: exportInstances[id].targetDsId }; });
}
function exportRestoreInstances(list) {
  if (!Array.isArray(list)) return;
  list.forEach(function(rec) {
    if (!rec || !rec.id) return;
    exportInstances[rec.id] = { targetDsId: rec.targetDsId || 'model' };
    var n = parseInt(String(rec.id).replace(/^export#/, ''), 10);
    if (isFinite(n) && n > exportInstSeq) exportInstSeq = n;
  });
}
function exportResetInstances() {
  surfaceCloseInstTabs(exportInstances, exportDisposeInstance);
  exportInstances = {}; exportInstanceEls = {};
}

// G5a-3: serialize a comparison dataset's Export column selection — name +
// outputName + selected (already by name, like the model's exportCols). null when
// nothing is built; a dataset awaiting reattach re-emits its pending saved list.
function exportSerializeFor(ds) {
  if (!ds) return null;
  var st = ds.export;
  if (!st || !st.columns || st.columns.length === 0) return ds._pendingExport || null;
  return st.columns.map(function(c) { return { name: c.name, outputName: c.outputName, selected: c.selected }; });
}
// Resolve a comparison dataset's pending (saved) Export columns: rebuild the full
// column list from its analyzed header, then apply the saved outputName/selected
// + order by name (new columns appended). Called from the aux complete handler
// and lazily when the Export tab switches to a not-yet-resolved dataset.
function applyExportDsRestore(ds) {
  if (!ds || !ds._pendingExport) return;
  var c = ds.complete;
  if (!c || !c.header) return;
  var origColCount = (c.origColCount != null) ? c.origColCount : (c.header.length - ((ds.calcolMeta || []).length));
  var cols = [];
  for (var i = 0; i < c.header.length; i++) {
    cols.push({ name: c.header[i], outputName: c.header[i], type: (c.colTypes && c.colTypes[i]) || 'numeric', selected: true, isCalcol: i >= origColCount });
  }
  var byName = {}; cols.forEach(function(col) { byName[col.name] = col; });
  var saved = ds._pendingExport;
  var ordered = [], used = {};
  saved.forEach(function(s) {
    var col = byName[s.name];
    if (!col) return;
    if (s.outputName != null) col.outputName = s.outputName;
    col.selected = !!s.selected;
    ordered.push(col); used[s.name] = true;
  });
  cols.forEach(function(col) { if (!used[col.name]) ordered.push(col); });
  if (!ds.export) ds.export = exportNewState();
  ds.export.columns = ordered;
  ds._pendingExport = null;
  // Repaint any panel (singleton or clone) currently targeting this dataset.
  exportForEachPanelTargeting(ds.id, function(root) { detectSourcePrecision(root); renderExportColumns(root); updateExportRowPreview(root); updateExportPreview(root); updateExportWarnings(root); });
}

function initExportColumns(root) {
  const C = exportCtx(root);
  const cols = [];
  const header = C.header || [], colTypes = C.colTypes || [], origColCount = C.origColCount;
  for (let i = 0; i < header.length; i++) {
    const isCalcol = i >= origColCount;
    cols.push({
      name: header[i],
      outputName: header[i],
      type: colTypes[i] || 'numeric',
      selected: true,
      isCalcol
    });
  }
  C.S.columns = cols;
  detectSourcePrecision(root);
  renderExportColumns(root);
  updateExportRowPreview(root);
  updateExportPreview(root);
}

function detectSourcePrecision(root) {
  const C = exportCtx(root);
  C.S.sourcePrecision = {};
  const pf = C.preflight;
  if (!pf || !pf.sampleRows || !pf.header) return;
  const hdr = pf.header;
  for (let ci = 0; ci < hdr.length; ci++) {
    let maxDp = 0;
    for (let ri = 0; ri < pf.sampleRows.length; ri++) {
      const raw = (pf.sampleRows[ri][ci] || '').trim();
      const dot = raw.indexOf('.');
      if (dot >= 0) {
        const dp = raw.length - dot - 1;
        if (dp > maxDp) maxDp = dp;
      }
    }
    if (maxDp > 0) C.S.sourcePrecision[hdr[ci]] = maxDp;
  }
}

function renderExportColumns(root) {
  exportRenderDatasetPicker(root);
  const els = exportEls(root);
  const cols = exportCtx(root).S.columns;
  const search = els.colSearch.value.toLowerCase();
  let html = '';
  for (let i = 0; i < cols.length; i++) {
    const col = cols[i];
    const checked = col.selected ? ' checked' : '';
    const typeClass = col.isCalcol ? 'calcol' : (col.type === 'numeric' ? 'num' : 'cat');
    const typeLabel = col.isCalcol ? 'calc' : (col.type === 'numeric' ? 'num' : 'cat');
    const hidden = search && !fuzzyMatch(search, col.name.toLowerCase()) && !fuzzyMatch(search, col.outputName.toLowerCase());
    html += '<div class="export-col-item' + (hidden ? ' export-col-hidden' : '') + '" data-idx="' + i + '" draggable="true">';
    html += '<span class="ecol-grip" title="Drag to reorder"></span>';
    html += '<input type="checkbox"' + checked + '>';
    html += '<span class="ecol-name" title="' + esc(col.name) + '">' + esc(col.name) + '</span>';
    html += '<input type="text" class="ecol-rename" value="' + esc(col.outputName) + '" placeholder="output name">';
    html += '<span class="ecol-type ' + typeClass + '">' + typeLabel + '</span>';
    html += '</div>';
  }
  els.colList.innerHTML = html;
  updateExportBadge(root);
  wireExportColumnEvents(root);
}

function updateExportBadge(root) {
  const els = exportEls(root);
  const cols = exportCtx(root).S.columns;
  const sel = cols.filter(c => c.selected).length;
  els.badge.textContent = sel + ' / ' + cols.length;
}

function updateExportRowPreview(root) {
  const C = exportCtx(root);
  const rowPreview = C.els.rowPreview;
  if (!C.ds.complete) { rowPreview.textContent = ''; return; }
  const rc = C.rowCount;
  const trc = C.totalRowCount;
  if (C.filter) {
    rowPreview.textContent = rc.toLocaleString() + ' / ' + trc.toLocaleString() + ' rows';
  } else {
    rowPreview.textContent = trc.toLocaleString() + ' rows';
  }
}

let exportDragIdx = null;

function wireExportColumnEvents(root) {
  const els = exportEls(root);
  const cols = exportCtx(root).S.columns;
  els.colList.querySelectorAll('.export-col-item').forEach(el => {
    const idx = parseInt(el.dataset.idx);
    const cb = el.querySelector('input[type="checkbox"]');
    cb.addEventListener('change', () => {
      cols[idx].selected = cb.checked;
      updateExportBadge(root);
      updateExportPreview(root);
      autoSaveProject();
    });
    const renameInput = el.querySelector('.ecol-rename');
    renameInput.addEventListener('input', () => {
      cols[idx].outputName = renameInput.value || cols[idx].name;
      updateExportPreview(root);
      autoSaveProject();
    });

    el.addEventListener('dragstart', (e) => {
      exportDragIdx = idx;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      els.colList.querySelectorAll('.drag-over-top,.drag-over-bottom').forEach(x => {
        x.classList.remove('drag-over-top', 'drag-over-bottom');
      });
      exportDragIdx = null;
    });
    el.addEventListener('dragover', (e) => {
      if (exportDragIdx === null || exportDragIdx === idx) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = el.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      el.classList.toggle('drag-over-top', e.clientY < midY);
      el.classList.toggle('drag-over-bottom', e.clientY >= midY);
    });
    el.addEventListener('dragleave', () => {
      el.classList.remove('drag-over-top', 'drag-over-bottom');
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      if (exportDragIdx === null || exportDragIdx === idx) return;
      const rect = el.getBoundingClientRect();
      const dropAfter = e.clientY >= rect.top + rect.height / 2;
      const item = cols.splice(exportDragIdx, 1)[0];
      let targetIdx = dropAfter ? idx : idx;
      if (exportDragIdx < idx) targetIdx--;
      const insertAt = dropAfter ? targetIdx + 1 : targetIdx;
      cols.splice(insertAt, 0, item);
      exportDragIdx = null;
      renderExportColumns(root);
      updateExportPreview(root);
      autoSaveProject();
    });
  });
}

// A10 G5b: per-panel column-search + selection-buttons + download wiring (extracted
// so clones wire their own; the singleton calls it once below). Format controls stay
// singleton-only (shared globals); clones hide the format section.
function wireExportControls(root) {
  const els = exportEls(root);
  els.colSearch.addEventListener('input', () => {
    const cols = exportCtx(root).S.columns;
    const search = els.colSearch.value.toLowerCase();
    els.colList.querySelectorAll('.export-col-item').forEach(el => {
      const idx = parseInt(el.dataset.idx);
      const col = cols[idx];
      const hidden = search && !fuzzyMatch(search, col.name.toLowerCase()) && !fuzzyMatch(search, col.outputName.toLowerCase());
      el.classList.toggle('export-col-hidden', hidden);
    });
  });
  wireSearchShortcuts(els.colSearch, els.selAll, els.selNone);
  els.selAll.addEventListener('click', () => { exportCtx(root).S.columns.forEach(c => c.selected = true); renderExportColumns(root); updateExportPreview(root); autoSaveProject(); });
  els.selNone.addEventListener('click', () => { exportCtx(root).S.columns.forEach(c => c.selected = false); renderExportColumns(root); updateExportPreview(root); autoSaveProject(); });
  els.selOrig.addEventListener('click', () => { exportCtx(root).S.columns.forEach(c => c.selected = !c.isCalcol); renderExportColumns(root); updateExportPreview(root); autoSaveProject(); });
  els.selCalc.addEventListener('click', () => { exportCtx(root).S.columns.forEach(c => c.selected = c.isCalcol); renderExportColumns(root); updateExportPreview(root); autoSaveProject(); });
  els.download.addEventListener('click', () => startExport(root));
}
wireExportControls();   // singleton

// ─── Format controls ──────────────────────────────────────────────────

// Delimiter presets
$exportFormatSection.addEventListener('click', (e) => {
  const delimBtn = e.target.closest('.export-delim');
  if (delimBtn) {
    $exportFormatSection.querySelectorAll('.export-delim').forEach(b => b.classList.remove('active'));
    delimBtn.classList.add('active');
    exportDelimiter = delimBtn.dataset.delim === 'tab' ? '\t' : delimBtn.dataset.delim;
    $exportCustomDelim.value = '';
    updateExportWarnings();
    updateExportPreview();
    autoSaveProject();
    return;
  }
  const quoteBtn = e.target.closest('.export-quote');
  if (quoteBtn) {
    $exportFormatSection.querySelectorAll('.export-quote').forEach(b => b.classList.remove('active'));
    quoteBtn.classList.add('active');
    exportQuoteChar = quoteBtn.dataset.quote;
    updateExportPreview();
    autoSaveProject();
    return;
  }
  const endingBtn = e.target.closest('.export-ending');
  if (endingBtn) {
    $exportFormatSection.querySelectorAll('.export-ending').forEach(b => b.classList.remove('active'));
    endingBtn.classList.add('active');
    exportLineEnding = endingBtn.dataset.ending === 'crlf' ? '\r\n' : '\n';
    autoSaveProject();
    return;
  }
  const decsepBtn = e.target.closest('.export-decsep');
  if (decsepBtn) {
    $exportFormatSection.querySelectorAll('.export-decsep').forEach(b => b.classList.remove('active'));
    decsepBtn.classList.add('active');
    exportDecimalSep = decsepBtn.dataset.sep;
    updateExportWarnings();
    updateExportPreview();
    autoSaveProject();
    return;
  }
});

// Custom delimiter input
$exportCustomDelim.addEventListener('input', () => {
  const v = $exportCustomDelim.value;
  if (v) {
    $exportFormatSection.querySelectorAll('.export-delim').forEach(b => b.classList.remove('active'));
    exportDelimiter = v;
    updateExportWarnings();
    updateExportPreview();
    autoSaveProject();
  }
});

// Header row toggle
$exportIncludeHeader.addEventListener('change', () => {
  exportIncludeHeader = $exportIncludeHeader.checked;
  updateExportPreview();
  autoSaveProject();
});

// Comment header toggle
$exportCommentHeader.addEventListener('change', () => {
  exportCommentHeader = $exportCommentHeader.checked;
  $exportCommentSection.style.display = exportCommentHeader ? '' : 'none';
  if (exportCommentHeader && !exportCommentText && preflightData && preflightData.commentLines && preflightData.commentLines.length > 0) {
    exportCommentText = preflightData.commentLines.join('\n');
    $exportCommentText.value = exportCommentText;
  }
  updateExportPreview();
  autoSaveProject();
});

// Comment text changes
$exportCommentText.addEventListener('input', () => {
  exportCommentText = $exportCommentText.value;
  updateExportPreview();
  autoSaveProject();
});

// Generate from geometry
$exportCommentGenerate.addEventListener('click', () => {
  if (!lastGeoData) {
    $exportCommentText.value = '(No geometry detected)';
    exportCommentText = $exportCommentText.value;
    return;
  }
  const gx = lastGeoData.x, gy = lastGeoData.y, gz = lastGeoData.z;
  if (!gx || !gy || !gz) {
    $exportCommentText.value = '(Incomplete geometry)';
    exportCommentText = $exportCommentText.value;
    return;
  }
  const total = gx.gridCount * gy.gridCount * gz.gridCount;
  const lines = [
    currentFile.name,
    '  exported from BMA',
    '  encoding: UTF-8',
    '  block size: ' + gx.blockSize + ' ' + gy.blockSize + ' ' + gz.blockSize,
    '  size in blocks: ' + gx.gridCount + ' ' + gy.gridCount + ' ' + gz.gridCount + ' = ' + total,
    '  minimum centroid: ' + gx.origin + ' ' + gy.origin + ' ' + gz.origin,
    '  maximum centroid: ' + gx.max + ' ' + gy.max + ' ' + gz.max
  ];
  exportCommentText = lines.join('\n');
  $exportCommentText.value = exportCommentText;
  updateExportPreview();
  autoSaveProject();
});

// Null select
$exportNullSelect.addEventListener('change', () => {
  if ($exportNullSelect.value === 'custom') {
    $exportNullInput.style.display = '';
    $exportNullInput.focus();
  } else {
    $exportNullInput.style.display = 'none';
    exportNullValue = $exportNullSelect.value;
    updateExportPreview();
    autoSaveProject();
  }
});
$exportNullInput.addEventListener('input', () => {
  exportNullValue = $exportNullInput.value;
  updateExportPreview();
  autoSaveProject();
});

// Precision select
$exportPrecisionSelect.addEventListener('change', () => {
  if ($exportPrecisionSelect.value === 'custom') {
    $exportPrecisionInput.style.display = '';
    $exportPrecisionInput.focus();
  } else if ($exportPrecisionSelect.value === 'auto') {
    $exportPrecisionInput.style.display = 'none';
    exportPrecision = null;
    updateExportWarnings();
    updateExportPreview();
    autoSaveProject();
  } else {
    $exportPrecisionInput.style.display = 'none';
    exportPrecision = parseInt($exportPrecisionSelect.value);
    updateExportWarnings();
    updateExportPreview();
    autoSaveProject();
  }
});
$exportPrecisionInput.addEventListener('input', () => {
  const v = parseInt($exportPrecisionInput.value);
  exportPrecision = (isNaN(v) || v < 0) ? null : Math.min(v, 20);
  updateExportWarnings();
  updateExportPreview();
  autoSaveProject();
});

// ─── Warnings ─────────────────────────────────────────────────────────

function updateExportWarnings(root) {
  const els = exportEls(root);
  if (!els.precisionWarn) return;   // clones hide the format section (precision is shared/singleton)
  const warnings = [];

  // Delimiter-decsep conflict
  if (exportDelimiter === exportDecimalSep) {
    warnings.push('Delimiter matches decimal separator \u2014 numeric values will be quoted');
  }

  // Precision warning
  if (exportPrecision !== null) {
    const C = exportCtx(root);
    const cols = C.S.columns, srcPrec = C.S.sourcePrecision;
    const affected = [];
    for (const col of cols) {
      if (!col.selected || col.type !== 'numeric') continue;
      const srcDp = srcPrec[col.name];
      if (srcDp !== undefined && srcDp > exportPrecision) {
        affected.push(col.outputName || col.name);
      }
    }
    if (affected.length > 0) {
      const names = affected.length > 5 ? affected.slice(0, 5).join(', ') + ' +' + (affected.length - 5) + ' more' : affected.join(', ');
      warnings.push('Columns ' + names + ' have up to ' + Math.max(...affected.map(n => {
        const col = cols.find(c => (c.outputName || c.name) === n);
        return col ? (srcPrec[col.name] || 0) : 0;
      })) + ' dp \u2014 output will use ' + exportPrecision + ' dp');
    }
  }

  if (warnings.length > 0) {
    els.precisionWarn.style.display = '';
    els.precisionWarn.textContent = warnings.join(' | ');
  } else {
    els.precisionWarn.style.display = 'none';
    els.precisionWarn.textContent = '';
  }
}

// ─── Live Preview ─────────────────────────────────────────────────────

function updateExportPreview(root) {
  const C = exportCtx(root);
  const els = C.els;
  const pf = C.preflight;
  if (!pf || !pf.sampleRows || !pf.header) {
    els.previewPre.textContent = '';
    els.previewInfo.textContent = '';
    return;
  }

  const selected = C.S.columns.filter(c => c.selected);
  if (selected.length === 0) {
    els.previewPre.textContent = '(No columns selected)';
    els.previewInfo.textContent = '';
    return;
  }

  const hdr = pf.header;
  const rows = pf.sampleRows;
  const maxRows = Math.min(rows.length, 100);
  const delim = exportDelimiter;
  const qc = exportQuoteChar;
  const le = exportLineEnding;

  // Build column index map: selected col name -> index in preflight header
  const colMap = [];
  for (const col of selected) {
    const idx = hdr.indexOf(col.name);
    colMap.push({ idx, col });
  }

  function previewEscape(v, isNum) {
    if (v === null || v === undefined || v === '' || v === 'NaN' || v === 'NA' || v === 'na' || v === 'nan' || v === 'null' || v === 'NULL') {
      return exportNullValue;
    }
    let s = String(v);
    // Apply precision to numbers
    if (isNum && exportPrecision !== null) {
      const n = Number(v);
      if (isFinite(n)) {
        s = n.toFixed(exportPrecision);
      }
    }
    // Apply decimal separator
    if (isNum && exportDecimalSep !== '.') {
      s = s.replace('.', exportDecimalSep);
    }
    // Quoting
    if (qc && (s.indexOf(delim) >= 0 || s.indexOf(qc) >= 0 || s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0)) {
      return qc + s.replace(new RegExp(qc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), qc + qc) + qc;
    }
    return s;
  }

  const lines = [];

  // Comment lines
  if (exportCommentHeader && exportCommentText.trim()) {
    const commentLines = exportCommentText.split('\n');
    for (const cl of commentLines) {
      lines.push('# ' + cl);
    }
  }

  // Header row
  if (exportIncludeHeader) {
    lines.push(selected.map(c => previewEscape(c.outputName, false)).join(delim));
  }

  // Data rows
  for (let ri = 0; ri < maxRows; ri++) {
    const row = rows[ri];
    const cells = [];
    for (const cm of colMap) {
      if (cm.idx < 0) {
        cells.push(exportNullValue); // calcol column — not in preflight
      } else {
        const raw = row[cm.idx] || '';
        const isNum = cm.col.type === 'numeric';
        cells.push(previewEscape(raw, isNum));
      }
    }
    lines.push(cells.join(delim));
  }

  els.previewPre.textContent = lines.join(le);

  // Info text
  const totalRows = C.ds.complete ? (C.filter ? C.rowCount : C.totalRowCount) : rows.length;
  if (totalRows > maxRows) {
    els.previewInfo.textContent = 'Showing ' + maxRows + ' of ' + totalRows.toLocaleString() + ' rows';
  } else {
    els.previewInfo.textContent = maxRows + ' rows';
  }
}

// ─── Export ───────────────────────────────────────────────────────────

function startExport(root) {
  const C = exportCtx(root);
  const els = C.els;
  const selected = C.S.columns.filter(c => c.selected);
  if (selected.length === 0) {
    els.info.textContent = 'No columns selected.';
    return;
  }
  if (!C.file) { els.info.textContent = 'Dataset not loaded.'; return; }

  const exportCols = selected.map(c => ({ name: c.name, outputName: c.outputName }));
  const baseName = C.file.name.replace(/\.[^.]+$/, '');
  const ext = exportDelimiter === '\t' ? '.tsv' : '.csv';
  const suggestedName = baseName + '_export' + ext;

  const resolvedTypes = C.resolvedTypes;

  const filterPayload = C.filter ? { expression: C.filter.expression } : null;
  const zipEntry = C.preflight ? (C.preflight.selectedZipEntry || null) : null;

  let commentLines = null;
  if (exportCommentHeader && exportCommentText.trim()) {
    commentLines = exportCommentText.split('\n');
  }

  const msg = {
    mode: 'export',
    file: C.file,
    filter: filterPayload,
    zipEntry,
    calcolCode: C.calcolCode || null,
    calcolMeta: (C.calcolMeta && C.calcolMeta.length > 0) ? C.calcolMeta : null,
    resolvedTypes,
    exportCols,
    rowVarOverride: C.rowVar,   // A10 G5a: a comparison dataset's row handle (undefined = model 'r')
    delimiter: exportDelimiter,
    includeHeader: exportIncludeHeader,
    commentLines,
    quoteChar: exportQuoteChar,
    lineEnding: exportLineEnding,
    nullValue: exportNullValue,
    precision: exportPrecision,
    decimalSep: exportDecimalSep,
    dmEndianness: C.preflight && C.preflight.dmEndianness || null,
    dmFormat: C.preflight && C.preflight.dmFormat || null
  };

  // Per-panel worker handle: the singleton uses the exportWorker global; a clone
  // keeps its own on its instance state so concurrent exports don't collide.
  var inst = exportIsInst(root) ? exportInstances[root.getAttribute('data-export-inst')] : null;
  var prior = inst ? inst._worker : exportWorker;
  if (prior) prior.terminate();

  // A10 4h: the model export runs through the shared, dataset-generic
  // exportRunWorker; this UI object drives the panel's elements (els-scoped).
  exportRunWorker(msg, suggestedName, {
    start: function() {
      els.download.disabled = true;
      els.progress.classList.add('active');
      els.progressFill.style.width = '0%';
      els.progressLabel.textContent = 'Exporting...';
      els.info.textContent = '';
    },
    progress: function(pct, rowCount) {
      els.progressFill.style.width = pct.toFixed(1) + '%';
      els.progressLabel.textContent = 'Exporting... ' + pct.toFixed(0) + '% (' + rowCount.toLocaleString() + ' rows)';
    },
    complete: function(rowCount, elapsed) {
      els.progressFill.style.width = '100%';
      els.progressLabel.textContent = 'Done \u2014 ' + rowCount.toLocaleString() + ' rows in ' + (elapsed / 1000).toFixed(1) + 's';
      els.download.disabled = false;
    },
    error: function(text) {
      els.info.textContent = text;
      els.progress.classList.remove('active');
      els.download.disabled = false;
    },
    cancelled: function() {
      els.progress.classList.remove('active');
      els.download.disabled = false;
    },
    setWorker: function(w) { if (inst) inst._worker = w; else exportWorker = w; }
  });
}

// A10 4h: run the streaming CSV export worker for a prepared message, driving an
// arbitrary UI through callbacks so the model Export tab (startExport) and the
// per-dataset row export (dsExportRows) share one code path. FSAA stream-to-disk
// when available, else accumulate chunks \u2192 blob download. ui = { start, progress,
// complete, error, cancelled, setWorker }. error strings are pre-formatted here
// so both surfaces report identically.
function exportRunWorker(msg, suggestedName, ui) {
  ui.start();
  if (window.showSaveFilePicker) {
    window.showSaveFilePicker({
      suggestedName,
      types: [{ description: 'CSV', accept: { 'text/csv': ['.csv', '.tsv'] } }]
    }).then(async (handle) => {
      const writable = await handle.createWritable();
      const worker = new Worker(workerUrl);
      ui.setWorker(worker);
      worker.onerror = async (e) => {
        await writable.abort();
        ui.error('Worker error: ' + (e.message || 'unknown error'));
        worker.terminate(); ui.setWorker(null);
      };
      worker.onmessage = async (e) => {
        const m = e.data;
        if (m.type === 'export-chunk') {
          await writable.write(m.csv);
        } else if (m.type === 'export-progress') {
          ui.progress(Math.min(99, m.percent), m.rowCount);
        } else if (m.type === 'export-complete') {
          await writable.close();
          ui.complete(m.rowCount, m.elapsed);
          worker.terminate(); ui.setWorker(null);
        } else if (m.type === 'error') {
          await writable.abort();
          ui.error('Error: ' + m.message);
          worker.terminate(); ui.setWorker(null);
        }
      };
      worker.postMessage(msg);
    }).catch(() => { ui.cancelled(); });
  } else {
    const chunks = [];
    const worker = new Worker(workerUrl);
    ui.setWorker(worker);
    worker.onerror = (e) => {
      ui.error('Worker error: ' + (e.message || 'unknown error'));
      worker.terminate(); ui.setWorker(null);
    };
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'export-chunk') {
        chunks.push(m.csv);
      } else if (m.type === 'export-progress') {
        ui.progress(Math.min(99, m.percent), m.rowCount);
      } else if (m.type === 'export-complete') {
        const blob = new Blob(chunks, { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = suggestedName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        ui.complete(m.rowCount, m.elapsed);
        worker.terminate(); ui.setWorker(null);
      } else if (m.type === 'error') {
        ui.error('Error: ' + m.message);
        worker.terminate(); ui.setWorker(null);
      }
    };
    worker.postMessage(msg);
  }
}

// A10 4h: export any dataset's rows as CSV \u2014 all columns + calcols, the
// dataset's global filter applied, sensible defaults (comma, header, source
// precision). Points and drillhole-derived datasets emit the same shape as the
// model; reuses the worker 'export' mode via exportRunWorker. Status renders on
// the dataset summary's export button/line.
function dsExportRows(ds, root) {
  ds = ds || dsById('aux');
  root = root || (typeof dsConfigRoot === 'function' ? dsConfigRoot(ds) : null);
  if (!ds || !ds.file || !ds.preflight) return;
  var hdr = ds.preflight.header || [];
  var exportCols = hdr.map(function(n) { return { name: n, outputName: n }; });
  (ds.calcolMeta || []).forEach(function(cm) { exportCols.push({ name: cm.name, outputName: cm.name }); });
  if (exportCols.length === 0) return;

  var msg = {
    mode: 'export',
    file: ds.file,
    filter: ds.filter ? { expression: ds.filter.expression } : null,
    zipEntry: ds.preflight.selectedZipEntry || null,
    calcolCode: ds.calcolCode || null,
    calcolMeta: (ds.calcolMeta && ds.calcolMeta.length > 0) ? ds.calcolMeta : null,
    resolvedTypes: (ds.preflight.autoTypes || []).slice(),
    exportCols: exportCols,
    rowVarOverride: ds.rowVar,
    delimiter: ',', includeHeader: true, commentLines: null,
    quoteChar: '"', lineEnding: '\n', nullValue: '', precision: null, decimalSep: '.',
    dmEndianness: ds.preflight.dmEndianness || null,
    dmFormat: ds.preflight.dmFormat || null
  };
  var baseName = (ds.file.name || ds.prefix || 'data').replace(/\.[^.]+$/, '');
  var suggestedName = baseName + '_export.csv';

  var $btn = auxQ('[data-act="auxExportRows"]', root);
  var $status = auxQ('[data-aux="exportStatus"]', root);
  if (ds._exportWorker) { try { ds._exportWorker.terminate(); } catch (e) {} ds._exportWorker = null; }
  exportRunWorker(msg, suggestedName, {
    start: function() { if ($btn) $btn.disabled = true; if ($status) { $status.textContent = 'Exporting\u2026'; $status.style.color = ''; } },
    progress: function(pct, rowCount) { if ($status) $status.textContent = pct.toFixed(0) + '% (' + rowCount.toLocaleString() + ' rows)'; },
    complete: function(rowCount) { if ($btn) $btn.disabled = false; if ($status) { $status.textContent = 'Exported ' + rowCount.toLocaleString() + ' rows'; $status.style.color = ''; } },
    error: function(text) { if ($btn) $btn.disabled = false; if ($status) { $status.textContent = text; $status.style.color = 'var(--red)'; } },
    cancelled: function() { if ($btn) $btn.disabled = false; if ($status) $status.textContent = ''; },
    setWorker: function(w) { ds._exportWorker = w; }
  });
}

// (singleton download wired in wireExportControls; G5b)

function resetExportSettings() {
  exportDelimiter = ',';
  exportIncludeHeader = true;
  exportCommentHeader = false;
  exportCommentText = '';
  exportQuoteChar = '"';
  exportLineEnding = '\n';
  exportNullValue = '';
  exportPrecision = null;
  exportDecimalSep = '.';
  $exportIncludeHeader.checked = true;
  $exportCommentHeader.checked = false;
  $exportCommentText.value = '';
  $exportCommentSection.style.display = 'none';
  $exportColSearch.value = '';
  $exportRowPreview.textContent = '';
  $exportCustomDelim.value = '';
  $exportFormatSection.querySelectorAll('.export-delim').forEach(b => {
    b.classList.toggle('active', b.dataset.delim === ',');
  });
  $exportFormatSection.querySelectorAll('.export-quote').forEach(b => {
    b.classList.toggle('active', b.dataset.quote === '"');
  });
  $exportFormatSection.querySelectorAll('.export-ending').forEach(b => {
    b.classList.toggle('active', b.dataset.ending === 'lf');
  });
  $exportFormatSection.querySelectorAll('.export-decsep').forEach(b => {
    b.classList.toggle('active', b.dataset.sep === '.');
  });
  $exportNullSelect.value = '';
  $exportNullInput.style.display = 'none';
  $exportNullInput.value = '';
  $exportPrecisionSelect.value = 'auto';
  $exportPrecisionInput.style.display = 'none';
  $exportPrecisionInput.value = '';
  $exportPrecisionWarn.style.display = 'none';
  $exportPrecisionWarn.textContent = '';
  updateExportPreview();
}

function restoreExportSettings(es) {
  if (!es) return;
  if (es.delimiter !== undefined) {
    exportDelimiter = es.delimiter;
    const delimVal = exportDelimiter === '\t' ? 'tab' : exportDelimiter;
    // Check if it matches a preset
    let matchedPreset = false;
    $exportFormatSection.querySelectorAll('.export-delim').forEach(b => {
      const isMatch = b.dataset.delim === delimVal;
      b.classList.toggle('active', isMatch);
      if (isMatch) matchedPreset = true;
    });
    if (!matchedPreset) {
      $exportCustomDelim.value = exportDelimiter;
    }
  }
  if (es.includeHeader !== undefined) {
    exportIncludeHeader = es.includeHeader;
    $exportIncludeHeader.checked = exportIncludeHeader;
  }
  if (es.commentHeader !== undefined) {
    exportCommentHeader = es.commentHeader;
    $exportCommentHeader.checked = exportCommentHeader;
    $exportCommentSection.style.display = exportCommentHeader ? '' : 'none';
  }
  if (es.commentText !== undefined) {
    exportCommentText = es.commentText;
    $exportCommentText.value = exportCommentText;
  }
  if (es.quoteChar !== undefined) {
    exportQuoteChar = es.quoteChar;
    $exportFormatSection.querySelectorAll('.export-quote').forEach(b => {
      b.classList.toggle('active', b.dataset.quote === exportQuoteChar);
    });
  }
  if (es.lineEnding !== undefined) {
    exportLineEnding = es.lineEnding;
    const endVal = exportLineEnding === '\r\n' ? 'crlf' : 'lf';
    $exportFormatSection.querySelectorAll('.export-ending').forEach(b => {
      b.classList.toggle('active', b.dataset.ending === endVal);
    });
  }
  if (es.nullValue !== undefined) {
    exportNullValue = es.nullValue;
    // Check if matches a preset
    const presetVals = ['', 'NA', 'NaN', 'NULL', '-999'];
    if (presetVals.indexOf(exportNullValue) >= 0) {
      $exportNullSelect.value = exportNullValue;
      $exportNullInput.style.display = 'none';
    } else {
      $exportNullSelect.value = 'custom';
      $exportNullInput.style.display = '';
      $exportNullInput.value = exportNullValue;
    }
  }
  if (es.precision !== undefined) {
    exportPrecision = es.precision;
    if (exportPrecision === null) {
      $exportPrecisionSelect.value = 'auto';
      $exportPrecisionInput.style.display = 'none';
    } else {
      // Check if matches a preset
      const opt = $exportPrecisionSelect.querySelector('option[value="' + exportPrecision + '"]');
      if (opt && exportPrecision !== 'custom') {
        $exportPrecisionSelect.value = String(exportPrecision);
        $exportPrecisionInput.style.display = 'none';
      } else {
        $exportPrecisionSelect.value = 'custom';
        $exportPrecisionInput.style.display = '';
        $exportPrecisionInput.value = exportPrecision;
      }
    }
  }
  if (es.decimalSep !== undefined) {
    exportDecimalSep = es.decimalSep;
    $exportFormatSection.querySelectorAll('.export-decsep').forEach(b => {
      b.classList.toggle('active', b.dataset.sep === exportDecimalSep);
    });
  }
  updateExportWarnings();
  updateExportPreview();
}
