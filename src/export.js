// ─── Export Tab ────────────────────────────────────────────────────────

function initExportColumns() {
  exportColumns = [];
  for (let i = 0; i < currentHeader.length; i++) {
    const isCalcol = i >= currentOrigColCount;
    exportColumns.push({
      name: currentHeader[i],
      outputName: currentHeader[i],
      type: currentColTypes[i] || 'numeric',
      selected: true,
      isCalcol
    });
  }
  detectSourcePrecision();
  renderExportColumns();
  updateExportRowPreview();
  updateExportPreview();
}

function detectSourcePrecision() {
  exportSourcePrecision = {};
  if (!preflightData || !preflightData.sampleRows || !preflightData.header) return;
  const hdr = preflightData.header;
  for (let ci = 0; ci < hdr.length; ci++) {
    let maxDp = 0;
    for (let ri = 0; ri < preflightData.sampleRows.length; ri++) {
      const raw = (preflightData.sampleRows[ri][ci] || '').trim();
      const dot = raw.indexOf('.');
      if (dot >= 0) {
        const dp = raw.length - dot - 1;
        if (dp > maxDp) maxDp = dp;
      }
    }
    if (maxDp > 0) exportSourcePrecision[hdr[ci]] = maxDp;
  }
}

function renderExportColumns() {
  const search = $exportColSearch.value.toLowerCase();
  let html = '';
  for (let i = 0; i < exportColumns.length; i++) {
    const col = exportColumns[i];
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
  $exportColList.innerHTML = html;
  updateExportBadge();
  wireExportColumnEvents();
}

function updateExportBadge() {
  const sel = exportColumns.filter(c => c.selected).length;
  $exportBadge.textContent = sel + ' / ' + exportColumns.length;
}

function updateExportRowPreview() {
  if (!lastCompleteData) { $exportRowPreview.textContent = ''; return; }
  const rc = lastCompleteData.rowCount;
  const trc = lastCompleteData.totalRowCount;
  if (currentFilter) {
    $exportRowPreview.textContent = rc.toLocaleString() + ' / ' + trc.toLocaleString() + ' rows';
  } else {
    $exportRowPreview.textContent = trc.toLocaleString() + ' rows';
  }
}

let exportDragIdx = null;

function wireExportColumnEvents() {
  $exportColList.querySelectorAll('.export-col-item').forEach(el => {
    const idx = parseInt(el.dataset.idx);
    const cb = el.querySelector('input[type="checkbox"]');
    cb.addEventListener('change', () => {
      exportColumns[idx].selected = cb.checked;
      updateExportBadge();
      updateExportPreview();
      autoSaveProject();
    });
    const renameInput = el.querySelector('.ecol-rename');
    renameInput.addEventListener('input', () => {
      exportColumns[idx].outputName = renameInput.value || exportColumns[idx].name;
      updateExportPreview();
      autoSaveProject();
    });

    el.addEventListener('dragstart', (e) => {
      exportDragIdx = idx;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      $exportColList.querySelectorAll('.drag-over-top,.drag-over-bottom').forEach(x => {
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
      const item = exportColumns.splice(exportDragIdx, 1)[0];
      let targetIdx = dropAfter ? idx : idx;
      if (exportDragIdx < idx) targetIdx--;
      const insertAt = dropAfter ? targetIdx + 1 : targetIdx;
      exportColumns.splice(insertAt, 0, item);
      exportDragIdx = null;
      renderExportColumns();
      updateExportPreview();
      autoSaveProject();
    });
  });
}

// Column search
$exportColSearch.addEventListener('input', () => {
  const search = $exportColSearch.value.toLowerCase();
  $exportColList.querySelectorAll('.export-col-item').forEach(el => {
    const idx = parseInt(el.dataset.idx);
    const col = exportColumns[idx];
    const hidden = search && !fuzzyMatch(search, col.name.toLowerCase()) && !fuzzyMatch(search, col.outputName.toLowerCase());
    el.classList.toggle('export-col-hidden', hidden);
  });
});

// Selection buttons
document.getElementById('exportSelAll').addEventListener('click', () => {
  exportColumns.forEach(c => c.selected = true);
  renderExportColumns();
  updateExportPreview();
  autoSaveProject();
});
document.getElementById('exportSelNone').addEventListener('click', () => {
  exportColumns.forEach(c => c.selected = false);
  renderExportColumns();
  updateExportPreview();
  autoSaveProject();
});
document.getElementById('exportSelOrig').addEventListener('click', () => {
  exportColumns.forEach(c => c.selected = !c.isCalcol);
  renderExportColumns();
  updateExportPreview();
  autoSaveProject();
});
document.getElementById('exportSelCalc').addEventListener('click', () => {
  exportColumns.forEach(c => c.selected = c.isCalcol);
  renderExportColumns();
  updateExportPreview();
  autoSaveProject();
});

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

function updateExportWarnings() {
  const warnings = [];

  // Delimiter-decsep conflict
  if (exportDelimiter === exportDecimalSep) {
    warnings.push('Delimiter matches decimal separator \u2014 numeric values will be quoted');
  }

  // Precision warning
  if (exportPrecision !== null) {
    const affected = [];
    for (const col of exportColumns) {
      if (!col.selected || col.type !== 'numeric') continue;
      const srcDp = exportSourcePrecision[col.name];
      if (srcDp !== undefined && srcDp > exportPrecision) {
        affected.push(col.outputName || col.name);
      }
    }
    if (affected.length > 0) {
      const names = affected.length > 5 ? affected.slice(0, 5).join(', ') + ' +' + (affected.length - 5) + ' more' : affected.join(', ');
      warnings.push('Columns ' + names + ' have up to ' + Math.max(...affected.map(n => {
        const col = exportColumns.find(c => (c.outputName || c.name) === n);
        return col ? (exportSourcePrecision[col.name] || 0) : 0;
      })) + ' dp \u2014 output will use ' + exportPrecision + ' dp');
    }
  }

  if (warnings.length > 0) {
    $exportPrecisionWarn.style.display = '';
    $exportPrecisionWarn.textContent = warnings.join(' | ');
  } else {
    $exportPrecisionWarn.style.display = 'none';
    $exportPrecisionWarn.textContent = '';
  }
}

// ─── Live Preview ─────────────────────────────────────────────────────

function updateExportPreview() {
  if (!preflightData || !preflightData.sampleRows || !preflightData.header) {
    $exportPreviewPre.textContent = '';
    $exportPreviewInfo.textContent = '';
    return;
  }

  const selected = exportColumns.filter(c => c.selected);
  if (selected.length === 0) {
    $exportPreviewPre.textContent = '(No columns selected)';
    $exportPreviewInfo.textContent = '';
    return;
  }

  const hdr = preflightData.header;
  const rows = preflightData.sampleRows;
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

  $exportPreviewPre.textContent = lines.join(le);

  // Info text
  const totalRows = lastCompleteData ? (currentFilter ? lastCompleteData.rowCount : lastCompleteData.totalRowCount) : rows.length;
  if (totalRows > maxRows) {
    $exportPreviewInfo.textContent = 'Showing ' + maxRows + ' of ' + totalRows.toLocaleString() + ' rows';
  } else {
    $exportPreviewInfo.textContent = maxRows + ' rows';
  }
}

// ─── Export ───────────────────────────────────────────────────────────

function startExport() {
  const selected = exportColumns.filter(c => c.selected);
  if (selected.length === 0) {
    $exportInfo.textContent = 'No columns selected.';
    return;
  }

  const exportCols = selected.map(c => ({ name: c.name, outputName: c.outputName }));
  const baseName = currentFile.name.replace(/\.[^.]+$/, '');
  const ext = exportDelimiter === '\t' ? '.tsv' : '.csv';
  const suggestedName = baseName + '_export' + ext;

  const resolvedTypes = currentColTypes.slice(0, currentOrigColCount);

  const filterPayload = currentFilter ? { expression: currentFilter.expression } : null;
  const zipEntry = preflightData ? (preflightData.selectedZipEntry || null) : null;

  let commentLines = null;
  if (exportCommentHeader && exportCommentText.trim()) {
    commentLines = exportCommentText.split('\n');
  }

  const msg = {
    mode: 'export',
    file: currentFile,
    filter: filterPayload,
    zipEntry,
    calcolCode: currentCalcolCode || null,
    calcolMeta: currentCalcolMeta.length > 0 ? currentCalcolMeta : null,
    resolvedTypes,
    exportCols,
    delimiter: exportDelimiter,
    includeHeader: exportIncludeHeader,
    commentLines,
    quoteChar: exportQuoteChar,
    lineEnding: exportLineEnding,
    nullValue: exportNullValue,
    precision: exportPrecision,
    decimalSep: exportDecimalSep
  };

  $exportDownload.disabled = true;
  $exportProgress.classList.add('active');
  $exportProgressFill.style.width = '0%';
  $exportProgressLabel.textContent = 'Exporting...';
  $exportInfo.textContent = '';

  if (exportWorker) exportWorker.terminate();

  if (window.showSaveFilePicker) {
    window.showSaveFilePicker({
      suggestedName,
      types: [{ description: 'CSV', accept: { 'text/csv': ['.csv', '.tsv'] } }]
    }).then(async (handle) => {
      const writable = await handle.createWritable();
      exportWorker = new Worker(workerUrl);
      exportWorker.onmessage = async (e) => {
        const m = e.data;
        if (m.type === 'export-chunk') {
          await writable.write(m.csv);
        } else if (m.type === 'export-progress') {
          const pct = Math.min(99, m.percent);
          $exportProgressFill.style.width = pct.toFixed(1) + '%';
          $exportProgressLabel.textContent = 'Exporting... ' + pct.toFixed(0) + '% (' + m.rowCount.toLocaleString() + ' rows)';
        } else if (m.type === 'export-complete') {
          await writable.close();
          $exportProgressFill.style.width = '100%';
          $exportProgressLabel.textContent = 'Done \u2014 ' + m.rowCount.toLocaleString() + ' rows in ' + (m.elapsed / 1000).toFixed(1) + 's';
          $exportDownload.disabled = false;
          exportWorker.terminate();
          exportWorker = null;
        } else if (m.type === 'error') {
          await writable.abort();
          $exportInfo.textContent = 'Error: ' + m.message;
          $exportProgress.classList.remove('active');
          $exportDownload.disabled = false;
          exportWorker.terminate();
          exportWorker = null;
        }
      };
      exportWorker.postMessage(msg);
    }).catch((err) => {
      $exportProgress.classList.remove('active');
      $exportDownload.disabled = false;
    });
  } else {
    const chunks = [];
    exportWorker = new Worker(workerUrl);
    exportWorker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'export-chunk') {
        chunks.push(m.csv);
      } else if (m.type === 'export-progress') {
        const pct = Math.min(99, m.percent);
        $exportProgressFill.style.width = pct.toFixed(1) + '%';
        $exportProgressLabel.textContent = 'Exporting... ' + pct.toFixed(0) + '% (' + m.rowCount.toLocaleString() + ' rows)';
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
        $exportProgressFill.style.width = '100%';
        $exportProgressLabel.textContent = 'Done \u2014 ' + m.rowCount.toLocaleString() + ' rows in ' + (m.elapsed / 1000).toFixed(1) + 's';
        $exportDownload.disabled = false;
        exportWorker.terminate();
        exportWorker = null;
      } else if (m.type === 'error') {
        $exportInfo.textContent = 'Error: ' + m.message;
        $exportProgress.classList.remove('active');
        $exportDownload.disabled = false;
        exportWorker.terminate();
        exportWorker = null;
      }
    };
    exportWorker.postMessage(msg);
  }
}

$exportDownload.addEventListener('click', startExport);

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
