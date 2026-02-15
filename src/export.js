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
  renderExportColumns();
}

function renderExportColumns() {
  let html = '';
  for (let i = 0; i < exportColumns.length; i++) {
    const col = exportColumns[i];
    const checked = col.selected ? ' checked' : '';
    const typeClass = col.isCalcol ? 'calcol' : (col.type === 'numeric' ? 'num' : 'cat');
    const typeLabel = col.isCalcol ? 'calc' : (col.type === 'numeric' ? 'num' : 'cat');
    html += '<div class="export-col-item" data-idx="' + i + '" draggable="true">';
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

let exportDragIdx = null;

function wireExportColumnEvents() {
  $exportColList.querySelectorAll('.export-col-item').forEach(el => {
    const idx = parseInt(el.dataset.idx);
    const cb = el.querySelector('input[type="checkbox"]');
    cb.addEventListener('change', () => {
      exportColumns[idx].selected = cb.checked;
      updateExportBadge();
    });
    const renameInput = el.querySelector('.ecol-rename');
    renameInput.addEventListener('input', () => {
      exportColumns[idx].outputName = renameInput.value || exportColumns[idx].name;
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
    });
  });
}

// Selection buttons
document.getElementById('exportSelAll').addEventListener('click', () => {
  exportColumns.forEach(c => c.selected = true);
  renderExportColumns();
});
document.getElementById('exportSelNone').addEventListener('click', () => {
  exportColumns.forEach(c => c.selected = false);
  renderExportColumns();
});
document.getElementById('exportSelOrig').addEventListener('click', () => {
  exportColumns.forEach(c => c.selected = !c.isCalcol);
  renderExportColumns();
});
document.getElementById('exportSelCalc').addEventListener('click', () => {
  exportColumns.forEach(c => c.selected = c.isCalcol);
  renderExportColumns();
});

function startExport() {
  const selected = exportColumns.filter(c => c.selected);
  if (selected.length === 0) {
    $exportInfo.textContent = 'No columns selected.';
    return;
  }

  const exportCols = selected.map(c => ({ name: c.name, outputName: c.outputName }));
  const baseName = currentFile.name.replace(/\.[^.]+$/, '');
  const suggestedName = baseName + '_export.csv';

  // Resolve types: only original column types (no calcol types needed for resolvedTypes)
  const resolvedTypes = currentColTypes.slice(0, currentOrigColCount);

  const filterPayload = currentFilter ? { expression: currentFilter.expression } : null;
  const zipEntry = preflightData ? (preflightData.selectedZipEntry || null) : null;

  const msg = {
    mode: 'export',
    file: currentFile,
    filter: filterPayload,
    zipEntry,
    calcolCode: currentCalcolCode || null,
    calcolMeta: currentCalcolMeta.length > 0 ? currentCalcolMeta : null,
    resolvedTypes,
    exportCols
  };

  $exportDownload.disabled = true;
  $exportProgress.classList.add('active');
  $exportProgressFill.style.width = '0%';
  $exportProgressLabel.textContent = 'Exporting...';
  $exportInfo.textContent = '';

  if (exportWorker) exportWorker.terminate();

  if (window.showSaveFilePicker) {
    // FSAA path
    window.showSaveFilePicker({
      suggestedName,
      types: [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }]
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
          $exportProgressLabel.textContent = 'Done — ' + m.rowCount.toLocaleString() + ' rows in ' + (m.elapsed / 1000).toFixed(1) + 's';
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
      // User cancelled picker
      $exportProgress.classList.remove('active');
      $exportDownload.disabled = false;
    });
  } else {
    // Blob fallback
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
        $exportProgressLabel.textContent = 'Done — ' + m.rowCount.toLocaleString() + ' rows in ' + (m.elapsed / 1000).toFixed(1) + 's';
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

