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

  // Sidebar: prefix + coordinates + aux filter
  $auxSidebar.innerHTML =
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
    '</div>';

  renderAuxPreview();
}

function renderAuxPreview() {
  var d = auxPreflightData;
  var head = '<tr>' + d.header.map(function(h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr>';
  var rows = d.sampleRows.slice(0, 20).map(function(r) {
    return '<tr>' + r.map(function(c) { return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>';
  }).join('');
  $auxPreview.innerHTML = '<table class="aux-preview-table"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table>';
}

function onAuxConfigChange() {
  if (!auxPreflightData) return;
  var p = document.getElementById('auxPrefixInput');
  if (p) auxPrefix = p.value.trim() || 'aux';
  var x = document.getElementById('auxX'), y = document.getElementById('auxY'), z = document.getElementById('auxZ');
  if (x && y && z) auxPreflightData.xyz = { x: parseInt(x.value), y: parseInt(y.value), z: parseInt(z.value) };
  var f = document.getElementById('auxFilterInput');
  if (f) { var v = f.value.trim(); auxFilter = v ? { expression: v } : null; }
  // Live-update the prefix hint without a full re-render (keeps focus/caret)
  var hint = $auxSidebar.querySelector('.pf-sidebar-section .aux-hint code');
  if (hint && p) hint.textContent = (auxPrefix || 'aux') + ':Fe';
  // Keep the swath sidebar's aux rows in sync (prefix labels, xyz exclusions);
  // check/unit state is preserved by name across the rebuild
  if (typeof renderSwathAuxVars === 'function') renderSwathAuxVars();
  if (typeof autoSaveProject === 'function') autoSaveProject();
}

function applyAuxRestore(saved) {
  auxPrefix = saved.prefix || 'aux';
  auxFilter = saved.filter ? { expression: saved.filter } : null;
  if (saved.xyz && auxPreflightData) auxPreflightData.xyz = saved.xyz;
}

function loadAuxFile(file, handle) {
  auxFile = file;
  auxHandle = handle || null;
  $auxFileInfo.textContent = 'Loading ' + file.name + '…';
  $auxEmpty.style.display = 'none';
  $auxConfig.style.display = '';
  runPreflight(file).then(function(data) {
    auxPreflightData = data;
    if (pendingAuxRestore && pendingAuxRestore.fileName === file.name) {
      applyAuxRestore(pendingAuxRestore);
      pendingAuxRestore = null;
    }
    renderAuxConfig();
    if (typeof renderSwathAuxVars === 'function') renderSwathAuxVars();
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
  if (auxWorker) { try { auxWorker.terminate(); } catch (e) {} auxWorker = null; }
  if (typeof swathAuxWorker !== 'undefined' && swathAuxWorker) { try { swathAuxWorker.terminate(); } catch (e) {} swathAuxWorker = null; }
  $auxConfig.style.display = 'none';
  $auxEmpty.style.display = '';
  $auxSidebar.innerHTML = '';
  $auxPreview.innerHTML = '';
  if (typeof renderSwathAuxVars === 'function') renderSwathAuxVars();
  if (typeof autoSaveProject === 'function') autoSaveProject();
}

// ─── Wiring (runs at load; DOM is already parsed) ─────────────────────
if ($auxDropzone) {
  $auxDropzone.addEventListener('dragover', function(e) { e.preventDefault(); $auxDropzone.classList.add('drag-over'); });
  $auxDropzone.addEventListener('dragleave', function() { $auxDropzone.classList.remove('drag-over'); });
  $auxDropzone.addEventListener('drop', async function(e) {
    e.preventDefault();
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
  }
  var $auxClearBtn = document.getElementById('auxClear');
  if ($auxClearBtn) $auxClearBtn.addEventListener('click', clearAux);
}
