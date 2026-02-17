// ─── Result Cache (IndexedDB) ──────────────────────────────────────────

function openCacheDB() {
  return new Promise(function(resolve, reject) {
    var req = indexedDB.open('bma-cache', 2);
    req.onupgradeneeded = function(e) {
      var db = req.result;
      if (!db.objectStoreNames.contains('results'))
        db.createObjectStore('results');
      if (!db.objectStoreNames.contains('recents'))
        db.createObjectStore('recents');
    };
    req.onsuccess = function() { resolve(req.result); };
    req.onerror = function() { reject(req.error); };
  });
}

// ─── Recent Files (IndexedDB) ───────────────────────────────────────────

var RECENTS_MAX = 20;

function recentKey(f) { return 'bma:' + f.name + ':' + f.size; }

function recentList() {
  return openCacheDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction('recents', 'readonly');
      var store = tx.objectStore('recents');
      var req = store.getAll();
      var keyReq = store.getAllKeys();
      tx.oncomplete = function() {
        var items = req.result || [];
        var keys = keyReq.result || [];
        var result = items.map(function(item, i) { item._key = keys[i]; return item; });
        result.sort(function(a, b) { return (b.lastOpened || 0) - (a.lastOpened || 0); });
        resolve(result);
      };
      tx.onerror = function() { reject(tx.error); };
    });
  });
}

function recentPut(key, entry) {
  return openCacheDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction('recents', 'readwrite');
      var store = tx.objectStore('recents');
      store.put(entry, key);
      tx.oncomplete = function() { resolve(); };
      tx.onerror = function() { reject(tx.error); };
    });
  }).then(function() {
    // Prune to max entries
    return recentList().then(function(items) {
      if (items.length <= RECENTS_MAX) return;
      return openCacheDB().then(function(db) {
        var tx = db.transaction('recents', 'readwrite');
        var store = tx.objectStore('recents');
        for (var i = RECENTS_MAX; i < items.length; i++) {
          store.delete(items[i]._key);
        }
        return new Promise(function(resolve) { tx.oncomplete = resolve; });
      });
    });
  });
}

function recentDelete(key) {
  return openCacheDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction('recents', 'readwrite');
      tx.objectStore('recents').delete(key);
      tx.oncomplete = function() { resolve(); };
      tx.onerror = function() { reject(tx.error); };
    });
  });
}

function timeAgo(ts) {
  var diff = Date.now() - ts;
  var sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  var min = Math.floor(sec / 60);
  if (min < 60) return min + (min === 1 ? ' min ago' : ' mins ago');
  var hrs = Math.floor(min / 60);
  if (hrs < 24) return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
  var days = Math.floor(hrs / 24);
  if (days < 14) return days + (days === 1 ? ' day ago' : ' days ago');
  var weeks = Math.floor(days / 7);
  if (weeks < 8) return weeks + (weeks === 1 ? ' week ago' : ' weeks ago');
  var months = Math.floor(days / 30);
  return months + (months === 1 ? ' month ago' : ' months ago');
}

function renderRecentFiles() {
  recentList().then(function(items) {
    if (items.length === 0) {
      $recentFiles.innerHTML = '';
      return;
    }
    var html = '<div class="recent-files-title">Recent Files</div>';
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var hasProj = false;
      try { hasProj = localStorage.getItem(it._key) !== null; } catch(e) {}
      html += '<div class="recent-item" data-key="' + esc(it._key) + '">';
      html += '<span class="recent-item-name">' + esc(it.name) + '</span>';
      html += '<span class="recent-item-size">' + formatBytes(it.size) + '</span>';
      if (hasProj) html += '<span class="recent-item-project">project</span>';
      html += '<span class="recent-item-time">' + timeAgo(it.lastOpened) + '</span>';
      html += '<button class="recent-item-remove" data-key="' + esc(it._key) + '" title="Remove">\u2715</button>';
      html += '</div>';
    }
    $recentFiles.innerHTML = html;

    // Wire click handlers
    $recentFiles.querySelectorAll('.recent-item').forEach(function(el) {
      el.addEventListener('click', function(e) {
        if (e.target.closest('.recent-item-remove')) return;
        var key = el.dataset.key;
        reopenRecent(key);
      });
    });
    $recentFiles.querySelectorAll('.recent-item-remove').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var key = btn.dataset.key;
        recentDelete(key).then(renderRecentFiles);
      });
    });
  }).catch(function() {
    $recentFiles.innerHTML = '';
  });
}

function reopenRecent(key) {
  openCacheDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction('recents', 'readonly');
      var req = tx.objectStore('recents').get(key);
      req.onsuccess = function() { resolve(req.result || null); };
      req.onerror = function() { reject(req.error); };
    });
  }).then(function(entry) {
    if (!entry) return;
    if (entry.handle && typeof entry.handle.queryPermission === 'function') {
      // FSAA path — check permission first, only prompt if needed
      entry.handle.queryPermission({ mode: 'read' }).then(function(perm) {
        if (perm === 'granted') {
          return entry.handle.getFile().then(function(file) {
            handleFile(file, entry.handle);
          });
        }
        // Permission not yet granted — request it for just this handle
        return entry.handle.requestPermission({ mode: 'read' }).then(function(perm2) {
          if (perm2 === 'granted') {
            return entry.handle.getFile().then(function(file) {
              handleFile(file, entry.handle);
            });
          }
          promptReselect(entry.name);
        });
      }).catch(function() {
        promptReselect(entry.name);
      });
    } else {
      // No handle — prompt user to re-select
      promptReselect(entry.name);
    }
  });
}

function promptReselect(name) {
  if (HAS_FSAA) {
    // Use file picker
    window.showOpenFilePicker({
      types: [
        { description: 'CSV files', accept: { 'text/*': ['.csv', '.txt', '.dat'] } },
        { description: 'ZIP files', accept: { 'application/zip': ['.zip'] } }
      ],
      multiple: false
    }).then(function(handles) {
      var handle = handles[0];
      return handle.getFile().then(function(file) {
        handleFile(file, handle);
      });
    }).catch(function() { /* user cancelled */ });
  } else {
    // Trigger classic file input
    $fileInput.click();
  }
}

function saveToRecents(file, handle) {
  var key = recentKey(file);
  var entry = {
    name: file.name,
    size: file.size,
    handle: handle || null,
    lastOpened: Date.now()
  };
  recentPut(key, entry).catch(function() { /* silent */ });
}

function cacheGet(key) {
  return openCacheDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction('results', 'readonly');
      var req = tx.objectStore('results').get(key);
      req.onsuccess = function() { resolve(req.result || null); };
      req.onerror = function() { reject(req.error); };
    });
  });
}

function cachePut(key, value) {
  return openCacheDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction('results', 'readwrite');
      tx.objectStore('results').put(value, key);
      tx.oncomplete = function() { resolve(); };
      tx.onerror = function() { reject(tx.error); };
    });
  });
}

function cacheDelete(key) {
  return openCacheDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction('results', 'readwrite');
      tx.objectStore('results').delete(key);
      tx.oncomplete = function() { resolve(); };
      tx.onerror = function() { reject(tx.error); };
    });
  });
}

function analysisFingerprint() {
  return JSON.stringify({
    filter: currentFilter,
    typeOverrides: currentTypeOverrides || null,
    skipCols: currentSkipCols || null,
    colFilters: currentColFilters || null,
    zipEntry: currentZipEntry || null,
    calcolCode: currentCalcolCode || '',
    calcolMeta: currentCalcolMeta || [],
    groupBy: currentGroupBy,
    groupStatsCols: currentGroupBy !== null && statsCatSelectedVars.size > 0 ? Array.from(statsCatSelectedVars).sort() : null
  });
}

// ─── Project Save/Load ─────────────────────────────────────────────────

function estimateResultBytes(data) {
  var bytes = 0;
  // Stats: per-column fixed fields + centroids
  if (data.stats) {
    var keys = Object.keys(data.stats);
    for (var i = 0; i < keys.length; i++) {
      var s = data.stats[keys[i]];
      bytes += 10 * 8; // ~10 numeric fields (count, min, max, mean, std, skew, kurt, nulls, zeros + quantiles obj)
      if (s.centroids) bytes += s.centroids.length * 16; // 2 floats × 8 bytes
    }
  }
  // Categories: string keys + counts
  if (data.categories) {
    var catKeys = Object.keys(data.categories);
    for (var i = 0; i < catKeys.length; i++) {
      var cc = data.categories[catKeys[i]].counts;
      if (cc) {
        var valKeys = Object.keys(cc);
        for (var j = 0; j < valKeys.length; j++) {
          bytes += valKeys[j].length * 2 + 8; // string (UTF-16) + count number
        }
      }
    }
  }
  // Geometry
  if (data.geometry) {
    var g = data.geometry;
    if (g.bounds) bytes += 6 * 8;
    if (g.spacing) bytes += 3 * 8;
    if (g.transitions) {
      if (g.transitions.x) bytes += g.transitions.x.length * 8;
      if (g.transitions.y) bytes += g.transitions.y.length * 8;
      if (g.transitions.z) bytes += g.transitions.z.length * 8;
    }
    if (g.subBlockSizes) bytes += g.subBlockSizes.length * 24;
  }
  // Header + colTypes strings
  if (data.header) {
    for (var i = 0; i < data.header.length; i++) bytes += data.header[i].length * 2;
  }
  // Group stats (same structure as stats, per group)
  if (data.groupStats) {
    var gKeys = Object.keys(data.groupStats);
    for (var i = 0; i < gKeys.length; i++) {
      var gs = data.groupStats[gKeys[i]];
      var gsKeys = Object.keys(gs);
      for (var j = 0; j < gsKeys.length; j++) {
        var s = gs[gsKeys[j]];
        bytes += 10 * 8;
        if (s.centroids) bytes += s.centroids.length * 16;
      }
    }
  }
  return bytes;
}

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / (1024 * 1024)).toFixed(1) + ' MB';
}

function projectKey(f) { return 'bma:' + f.name + ':' + f.size; }

function serializeProject() {
  return {
    _bma: 1,
    _ts: Date.now(),
    file: { name: currentFile.name, size: currentFile.size },
    preflight: {
      typeOverrides: preflightData?.typeOverrides || {},
      skipCols: preflightData ? Array.from(preflightData.skipCols) : [],
      colFilters: preflightData?.colFilters || {},
      xyz: preflightData?.xyz || { x: -1, y: -1, z: -1 },
      dxyz: preflightData?.dxyz || { dx: -1, dy: -1, dz: -1 },
      selectedZipEntry: preflightData?.selectedZipEntry || null
    },
    calcolCode: currentCalcolCode,
    calcolMeta: currentCalcolMeta,
    filter: currentFilter,
    filterText: $filterExpr.value,
    statsCat: {
      groupBy: currentGroupBy,
      selectedVars: Array.from(statsCatSelectedVars),
      sortMode: statsCatGroupSortMode,
      cdfScale: statsCatCdfScale,
      crossMode: statsCatCrossMode
    },
    statsTab: {
      selectedVars: statsSelectedVars ? Array.from(statsSelectedVars) : null,
      visibleMetrics: statsVisibleMetrics ? Array.from(statsVisibleMetrics) : null,
      percentiles: statsPercentiles,
      cdfSelected: Array.from(statsCdfSelected),
      cdfScale: statsCdfScale
    },
    categories: {
      focusedCol: catFocusedCol !== null && currentHeader[catFocusedCol] ? currentHeader[catFocusedCol] : null,
      sortModes: catSortModes,
      customOrders: catCustomOrders,
      colorOverrides: catColorOverrides
    },
    exportCols: exportColumns.map(c => ({
      name: c.name, outputName: c.outputName, selected: c.selected
    }))
  };
}

function autoSaveProject() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    if (!currentFile || !preflightData) return;
    try {
      localStorage.setItem(projectKey(currentFile), JSON.stringify(serializeProject()));
    } catch (e) { /* quota — silent fail */ }
  }, 2000);
}

async function applyProject(project) {
  if (!project || !project._bma) return;

  // Restore preflight config
  if (preflightData) {
    const pf = project.preflight || {};

    // If saved project used a different zip entry, re-read its preview first
    if (pf.selectedZipEntry && preflightData.zipEntries &&
        pf.selectedZipEntry !== preflightData.selectedZipEntry) {
      const entry = preflightData.zipEntries.find(z => z.name === pf.selectedZipEntry);
      if (entry) {
        try {
          const lines = await readPreviewFromZipEntry(currentFile, entry, 100);
          const delimiter = detectDelimiterMain(lines.slice(0, 20));
          preflightData.header = lines[0].split(delimiter).map(h => h.trim().replace(/^["']|["']$/g, ''));
          preflightData.sampleRows = lines.slice(1).filter(l => l.trim())
            .map(l => l.split(delimiter).map(f => f.trim().replace(/^["']|["']$/g, '')));
          preflightData.delimiter = delimiter;
          preflightData.autoTypes = autoDetectTypes(preflightData.header, preflightData.sampleRows);
          preflightData.selectedZipEntry = pf.selectedZipEntry;
          // Update zip dropdown to reflect restored selection
          const zipSelect = document.getElementById('zipSelect');
          if (zipSelect) zipSelect.value = pf.selectedZipEntry;
        } catch (e) { /* failed to read entry — continue with current */ }
      }
    }

    preflightData.typeOverrides = pf.typeOverrides || {};
    preflightData.skipCols = new Set(pf.skipCols || []);
    preflightData.colFilters = pf.colFilters || {};
    if (pf.xyz) preflightData.xyz = pf.xyz;
    if (pf.dxyz) preflightData.dxyz = pf.dxyz;
    renderPreflightSidebar(preflightData);
    renderPreflightTable(preflightData);
  }

  // Restore calcols — support both new (calcolCode) and old (calcols array) formats
  if (project.calcolCode !== undefined) {
    currentCalcolCode = project.calcolCode || '';
    currentCalcolMeta = project.calcolMeta || [];
  } else if (project.calcols && project.calcols.length > 0) {
    // Backward compat: convert old [{name, expr, type}] to code block
    const rv = currentRowVar || 'r';
    currentCalcolCode = project.calcols.map(c => rv + '.' + c.name + ' = ' + c.expr + ';').join('\n');
    currentCalcolMeta = project.calcols.map(c => ({ name: c.name, type: c.type || 'numeric' }));
  } else {
    currentCalcolCode = '';
    currentCalcolMeta = [];
  }
  setCalcolCode(currentCalcolCode);
  simulateCalcol();

  // Restore categories tab state
  catSortModes = project.categories?.sortModes || {};
  catCustomOrders = project.categories?.customOrders || {};
  catColorOverrides = project.categories?.colorOverrides || {};

  // Restore filter
  currentFilter = project.filter || null;
  $filterExpr.value = project.filterText || '';

  // Stash post-analysis config for when analysis runs
  pendingProjectRestore = project;
}

function applyExportRestore(savedCols) {
  const reordered = [];
  const used = new Set();
  for (const sc of savedCols) {
    const idx = exportColumns.findIndex(c => c.name === sc.name);
    if (idx >= 0) {
      exportColumns[idx].outputName = sc.outputName || exportColumns[idx].name;
      exportColumns[idx].selected = sc.selected !== false;
      reordered.push(exportColumns[idx]);
      used.add(idx);
    }
  }
  for (let i = 0; i < exportColumns.length; i++) {
    if (!used.has(i)) reordered.push(exportColumns[i]);
  }
  exportColumns = reordered;
  renderExportColumns();
}

function saveProjectFile() {
  if (!currentFile || !preflightData) return;
  const json = JSON.stringify(serializeProject(), null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = currentFile.name.replace(/\.[^.]+$/, '') + '.bma.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

function clearProject() {
  if (!currentFile) return;
  try { localStorage.removeItem(projectKey(currentFile)); } catch (e) {}
  cacheDelete(projectKey(currentFile)).catch(function() {});

  currentCalcolCode = '';
  currentCalcolMeta = [];
  currentFilter = null;
  $filterExpr.value = '';
  currentGroupBy = null;
  currentStatsCatVar = null;
  currentStatsCatChecked = null;
  statsCatGroupSortMode = 'count';
  statsCatSelectedVars = new Set();
  statsCatCdfScale = 'linear';
  statsCatCdfManual = false;
  statsCatCdfMin = null;
  statsCatCdfMax = null;
  statsCatCrossMode = 'count';
  statsCatShowSelectedOnly = false;
  catFocusedCol = null;
  catSortModes = {};
  catCustomOrders = {};
  catColorOverrides = {};
  catChartShowAll = false;
  statsSelectedVars = null;
  statsVisibleMetrics = null;
  statsPercentiles = [25, 50, 75];
  statsCdfSelected = new Set();
  statsCdfScale = 'linear';
  exportColumns = [];
  pendingProjectRestore = null;

  runPreflight(currentFile).then(data => {
    renderPreflight(data);
    setCalcolCode('');
    simulateCalcol();
    markAnalysisStale();
    switchTab('preflight');
  });
}

// Toolbar overflow menu
$toolbarOverflow.addEventListener('click', (e) => {
  e.stopPropagation();
  $toolbarMenu.classList.toggle('open');
});
document.addEventListener('click', () => $toolbarMenu.classList.remove('open'));

// Toolbar menu items
$toolbarMenu.addEventListener('click', (e) => {
  const item = e.target.closest('.toolbar-menu-item');
  if (!item) return;
  $toolbarMenu.classList.remove('open');
  const action = item.dataset.action;
  if (action === 'save') saveProjectFile();
  else if (action === 'load') $projectFileInput.click();
  else if (action === 'clear') clearProject();
  else if (action === 'settings') openSettings();
});

// Toolbar buttons
$projectSave.addEventListener('click', saveProjectFile);
$projectLoad.addEventListener('click', () => $projectFileInput.click());
$projectClear.addEventListener('click', clearProject);

// Load project file
$projectFileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const project = JSON.parse(reader.result);
      applyProject(project);
    } catch (err) {
      $errorMsg.textContent = 'Invalid project file: ' + err.message;
      $errorMsg.classList.add('active');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

function handleFile(file, handle) {
  if (!file) return;
  currentFile = file;
  saveToRecents(file, handle);
  currentFilter = null;
  currentGroupBy = null;
  currentStatsCatVar = null;
  currentStatsCatChecked = null;
  lastStatsCatData = null;
  statsCatGroupSortMode = 'count';
  statsCatSelectedVars = new Set();
  statsCatShowSelectedOnly = false;
  statsCatCdfScale = 'linear';
  statsCatCdfManual = false;
  statsCatCdfMin = null;
  statsCatCdfMax = null;
  statsCatCrossMode = 'count';
  catFocusedCol = null;
  catSortModes = {};
  catCustomOrders = {};
  catColorOverrides = {};
  catChartShowAll = false;
  statsSelectedVars = null;
  statsVisibleMetrics = null;
  statsPercentiles = [25, 50, 75];
  statsCdfSelected = new Set();
  statsCdfScale = 'linear';
  exportColumns = [];
  pendingProjectRestore = null;
  currentTypeOverrides = null;
  currentZipEntry = null;
  currentSkipCols = null;
  currentColFilters = null;
  lastCompleteData = null;
  if (exportWorker) { exportWorker.terminate(); exportWorker = null; }
  if (swathWorker) { swathWorker.terminate(); swathWorker = null; }
  if (sectionWorker) { sectionWorker.terminate(); sectionWorker = null; }
  lastSwathData = null;
  sectionBlocks = null;
  sectionTransform = null;
  sectionDefaultBlockSize = null;
  currentDXYZ = { dx: -1, dy: -1, dz: -1 };
  hasResults = false;
  $filterExpr.value = '';
  $filterSection.classList.remove('active');
  $appFooter.classList.remove('active');
  $filterError.classList.remove('active');
  $errorMsg.classList.remove('active');

  // Collapse dropzone
  $dropzone.classList.add('collapsed');
  $dropzone.querySelector('.label').innerHTML = 'Load different file:';
  let loadedSpan = $dropzone.querySelector('.loaded-name');
  if (!loadedSpan) {
    loadedSpan = document.createElement('span');
    loadedSpan.className = 'loaded-name';
    $dropzone.insertBefore(loadedSpan, $dropzone.querySelector('input'));
  }
  loadedSpan.textContent = file.name;

  // Show results container with preflight tab
  $results.classList.add('active');
  document.querySelector('.app').classList.add('has-results');
  $resultsFilename.textContent = file.name;
  $resultsRowInfo.textContent = '';
  $resultsTimeInfo.textContent = '';
  $resultsMemInfo.textContent = '';
  switchTab('preflight');

  // Show action bar with execute button and filter
  $appFooter.classList.add('active');
  $filterSection.classList.add('active');
  markAnalysisStale();

  // Set placeholder content for tabs before first analysis
  const placeholder = '<div style="color:var(--fg-dim);font-size:0.78rem;padding:2rem;text-align:center;opacity:0.5;">Click Analyze to run analysis.</div>';
  $geoContent.innerHTML = placeholder;
  $geoBadge.textContent = '';
  $fileInfo.innerHTML = '';
  $statsContent.innerHTML = placeholder;
  $statsBadge.textContent = '';
  document.getElementById('statsVarList').innerHTML = '';
  document.getElementById('statsVarSearch').value = '';
  document.getElementById('statsMetricToggles').innerHTML = '';
  document.getElementById('statsCdfChart').innerHTML = '<div class="stats-cdf-hint">Click column names to add CDF curves</div>';
  $statsCatContent.innerHTML = placeholder;
  $statsCatBadge.textContent = '';
  $statsCatVarList.innerHTML = '';
  $statsCatGroupList.innerHTML = '';
  $statsCatVarSearch.value = '';
  $statsCatGroupSearch.value = '';
  $catColList.innerHTML = '';
  $catToolbar.innerHTML = '';
  $catChart.innerHTML = '';
  $catValueTable.innerHTML = '';
  $catBadge.textContent = '';
  $exportColList.innerHTML = '';
  $exportBadge.textContent = '0';
  $exportInfo.textContent = '';
  $exportProgress.classList.remove('active');
  setCalcolCode('');
  simulateCalcol();

  // Run preflight
  runPreflight(file).then(async data => {
    renderPreflight(data);
    // Auto-restore saved project config
    const saved = localStorage.getItem(projectKey(file));
    if (saved) {
      try {
        const project = JSON.parse(saved);
        await applyProject(project);
        executeAnalysis();
      } catch (e) { /* corrupt — ignore */ }
    }
  }).catch(err => {
    $errorMsg.textContent = err.message;
    $errorMsg.classList.add('active');
  });
}

let analysisStale = true;

function markAnalysisStale() {
  analysisStale = true;
  const btn = document.getElementById('executeBtn');
  if (btn) btn.classList.remove('clean');
}

function executeAnalysis() {
  if (!preflightData || !currentFile) return;
  const typeOv = Object.keys(preflightData.typeOverrides).length > 0 ? preflightData.typeOverrides : null;
  const zipEntry = preflightData.selectedZipEntry || null;
  const xyz = preflightData.xyz;
  const xyzOv = (xyz.x >= 0 && xyz.y >= 0 && xyz.z >= 0) ? xyz : null;
  const skip = preflightData.skipCols.size > 0 ? Array.from(preflightData.skipCols) : null;
  const colFilters = Object.keys(preflightData.colFilters).length > 0 ? preflightData.colFilters : null;
  const dxyz = preflightData.dxyz || { dx: -1, dy: -1, dz: -1 };
  const dxyzOv = (dxyz.dx >= 0 || dxyz.dy >= 0 || dxyz.dz >= 0) ? dxyz : null;
  currentDXYZ = { ...dxyz };
  startAnalysis(xyzOv, currentFilter, typeOv, zipEntry, skip, colFilters, dxyzOv);
}

let hasResults = false; // Track whether analysis has been run

// Back button in toolbar — go back to dropzone
$backToPreflight.addEventListener('click', () => {
  $results.classList.remove('active');
  document.querySelector('.app').classList.remove('has-results');
  $appFooter.classList.remove('active');
  $filterSection.classList.remove('active');
  $dropzone.classList.remove('collapsed');
  const loadedSpan = $dropzone.querySelector('.loaded-name');
  if (loadedSpan) loadedSpan.remove();
  $dropzone.querySelector('.label').innerHTML = 'Drop a CSV file here, or <strong>click to browse</strong>';
  renderRecentFiles();
  currentFile = null;
  preflightData = null;
  hasResults = false;
  currentCalcolCode = '';
  currentCalcolMeta = [];
  currentGroupBy = null;
  currentStatsCatVar = null;
  currentStatsCatChecked = null;
  lastStatsCatData = null;
  statsCatGroupSortMode = 'count';
  statsCatSelectedVars = new Set();
  statsCatShowSelectedOnly = false;
  catFocusedCol = null;
  catSortModes = {};
  catCustomOrders = {};
  catColorOverrides = {};
  catChartShowAll = false;
  statsSelectedVars = null;
  statsVisibleMetrics = null;
  statsPercentiles = [25, 50, 75];
  statsCdfSelected = new Set();
  statsCdfScale = 'linear';
  exportColumns = [];
  pendingProjectRestore = null;
  if (exportWorker) { exportWorker.terminate(); exportWorker = null; }
  if (swathWorker) { swathWorker.terminate(); swathWorker = null; }
  if (sectionWorker) { sectionWorker.terminate(); sectionWorker = null; }
  lastSwathData = null;
  sectionBlocks = null;
  sectionTransform = null;
  sectionDefaultBlockSize = null;
  currentDXYZ = { dx: -1, dy: -1, dz: -1 };
});

// Allow dropping new files onto results area
$results.addEventListener('dragover', (e) => { e.preventDefault(); });
$results.addEventListener('drop', async (e) => {
  e.preventDefault();
  var handle = null;
  if (HAS_FSAA && e.dataTransfer.items && e.dataTransfer.items[0] && e.dataTransfer.items[0].getAsFileSystemHandle) {
    try { handle = await e.dataTransfer.items[0].getAsFileSystemHandle(); } catch (ex) {}
  }
  var file = handle ? await handle.getFile() : (e.dataTransfer.files[0] || null);
  if (file) handleFile(file, handle);
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  // Enter triggers Analyze (when not in text fields)
  if (e.key === 'Enter' && !e.shiftKey && document.activeElement.tagName !== 'TEXTAREA' && document.activeElement.tagName !== 'INPUT') {
    if (preflightData && currentFile) {
      e.preventDefault();
      executeAnalysis();
    }
  }
});

// Wire unified execute button
document.getElementById('executeBtn').addEventListener('click', executeAnalysis);

let currentTypeOverrides = null;
let currentZipEntry = null;
let currentSkipCols = null;
let currentColFilters = null;

function startAnalysis(xyzOverride, filter, typeOverrides, zipEntry, skipCols, colFilters, dxyzOverride) {
  if (!currentFile) return;

  // Store for re-analysis (filters, xyz changes)
  if (typeOverrides !== undefined) currentTypeOverrides = typeOverrides;
  if (zipEntry !== undefined) currentZipEntry = zipEntry;
  if (skipCols !== undefined) currentSkipCols = skipCols;
  if (colFilters !== undefined) currentColFilters = colFilters;

  var cacheKey = projectKey(currentFile);
  var fingerprint = analysisFingerprint();

  // Check IndexedDB cache before spawning worker
  cacheGet(cacheKey).then(function(cached) {
    if (cached && cached.fingerprint === fingerprint && cached.lastModified === currentFile.lastModified) {
      // Cache hit — restore results without re-analysis
      var msg = cached.data;
      currentHeader = msg.header;
      currentColTypes = msg.colTypes;
      currentRowVar = msg.rowVarName || 'r';
      if (msg.origColCount) currentOrigColCount = msg.origColCount;
      if (!xyzOverride) {
        currentXYZ = { ...msg.xyzGuess };
        detectedXYZ = { ...msg.xyzGuess };
      } else {
        currentXYZ = { ...xyzOverride };
        detectedXYZ = { ...xyzOverride };
      }
      lastCompleteData = msg;
      msg._cached = true;
      displayResults(msg);
      return;
    }
    runWorkerAnalysis(xyzOverride, filter, dxyzOverride, cacheKey, fingerprint);
  }).catch(function() {
    runWorkerAnalysis(xyzOverride, filter, dxyzOverride, cacheKey, fingerprint);
  });
}

function runWorkerAnalysis(xyzOverride, filter, dxyzOverride, cacheKey, fingerprint) {
  if (worker) worker.terminate();
  worker = new Worker(workerUrl);

  // Always use overlay on the results panels
  const panelsEl = $results.querySelector('.results-panels');
  // Remove any stale overlay
  const old = panelsEl.querySelector('.reanalysis-overlay');
  if (old) old.remove();
  const $overlay = document.createElement('div');
  $overlay.className = 'reanalysis-overlay';
  $overlay.innerHTML = `
    <div class="re-label">Analyzing…</div>
    <div class="re-progress"><div class="re-bar"></div></div>
    <button class="re-cancel">Cancel</button>
  `;
  panelsEl.appendChild($overlay);
  const $reBar = $overlay.querySelector('.re-bar');
  const $reLabel = $overlay.querySelector('.re-label');
  $overlay.querySelector('.re-cancel').addEventListener('click', () => {
    if (worker) worker.terminate();
    $overlay.remove();
    if (lastCompleteData) displayResults(lastCompleteData);
  });

  worker.onerror = (e) => {
    $overlay.remove();
    $errorMsg.textContent = 'Worker error: ' + (e.message || 'unknown error');
    $errorMsg.classList.add('active');
  };

  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'header') {
      currentHeader = msg.header;
      currentColTypes = msg.colTypes;
      currentRowVar = msg.rowVarName || 'r';
      if (msg.origColCount) currentOrigColCount = msg.origColCount;
      if (!xyzOverride) {
        currentXYZ = { ...msg.xyzGuess };
        detectedXYZ = { ...msg.xyzGuess };
      } else {
        currentXYZ = { ...xyzOverride };
        detectedXYZ = { ...xyzOverride };
      }
    } else if (msg.type === 'progress') {
      const pct = Math.min(99, msg.percent);
      $reBar.style.width = pct.toFixed(1) + '%';
      $reLabel.textContent = 'Analyzing… ' + pct.toFixed(0) + '%';
    } else if (msg.type === 'complete') {
      if (msg.origColCount) currentOrigColCount = msg.origColCount;
      $overlay.remove();
      lastCompleteData = msg;
      displayResults(msg);
      // Store in IndexedDB cache (async, fire-and-forget)
      cachePut(cacheKey, {
        fingerprint: fingerprint,
        lastModified: currentFile.lastModified,
        data: msg
      }).catch(function() { /* ignore cache write errors */ });
    } else if (msg.type === 'error') {
      $overlay.remove();
      if (msg.message.startsWith('Filter expression')) {
        $filterError.textContent = msg.message;
        $filterError.classList.add('active');
      } else {
        $errorMsg.textContent = msg.message;
        $errorMsg.classList.add('active');
      }
    }
  };

  const filterPayload = filter ? { expression: filter.expression } : null;
  worker.postMessage({
    file: currentFile,
    xyzOverride: xyzOverride || null,
    dxyzOverride: dxyzOverride || null,
    filter: filterPayload,
    typeOverrides: currentTypeOverrides || null,
    zipEntry: currentZipEntry || null,
    skipCols: currentSkipCols || null,
    colFilters: currentColFilters || null,
    calcolCode: currentCalcolCode || null,
    calcolMeta: currentCalcolMeta.length > 0 ? currentCalcolMeta : null,
    groupBy: currentGroupBy,
    groupStatsCols: currentGroupBy !== null && statsCatSelectedVars.size > 0 ? Array.from(statsCatSelectedVars) : null
  });
}

function displayResults(data) {
  const isFirstAnalysis = !hasResults;
  hasResults = true;
  const { stats, geometry, coordOrder, maxDecimals, categories, rowCount, totalRowCount, commentCount, elapsed, header, colTypes, xyzGuess, rowVarName, zipName } = data;
  currentRowVar = rowVarName || 'r';
  $results.classList.add('active');
  document.querySelector('.app').classList.add('has-results');

  // Toolbar info
  const dispName = zipName ? `${currentFile.name} / ${zipName}` : currentFile.name;
  $resultsFilename.textContent = dispName;

  const isFiltered = currentFilter !== null;
  const rowsDisplay = isFiltered
    ? `${rowCount.toLocaleString()} / ${totalRowCount.toLocaleString()}`
    : totalRowCount.toLocaleString();
  $resultsRowInfo.textContent = rowsDisplay + ' rows · ' + header.length + ' cols';
  $resultsTimeInfo.textContent = data._cached ? 'cached' : (elapsed / 1000).toFixed(1) + 's';
  $resultsMemInfo.textContent = '~' + formatBytes(estimateResultBytes(data));

  // Apply default percentile preset from settings (only on first analysis, not project restore)
  if (isFirstAnalysis && !pendingProjectRestore && typeof bmaSettings !== 'undefined' && bmaSettings) {
    var preset = bmaSettings.defaultPercentilePreset;
    if (preset === 'custom' && bmaSettings.customPercentiles) {
      statsPercentiles = bmaSettings.customPercentiles.slice();
    } else if (STATS_PRESETS[preset]) {
      statsPercentiles = STATS_PRESETS[preset].slice();
    }
  }

  // Jump to summary only if still on preflight tab
  var activeTab = $resultsTabs.querySelector('.results-tab.active');
  if (isFirstAnalysis || (activeTab && activeTab.dataset.tab === 'preflight')) switchTab('summary');

  // Mark analysis as clean
  analysisStale = false;
  const execBtn = document.getElementById('executeBtn');
  if (execBtn) execBtn.classList.add('clean');

  // Show filter section (action bar already visible from handleFile)
  $filterSection.classList.add('active');
  const infoItems = [
    fi('File', currentFile.name),
  ];
  if (zipName) infoItems.push(fi('Inner', zipName));
  infoItems.push(
    fi('Size', formatSize(currentFile.size)),
    fi('Rows', rowsDisplay),
    fi('Columns', header.length),
    fi('Delimiter', delimName(data.delimiter || ',')),
    fi('Time', (elapsed / 1000).toFixed(2) + 's'),
  );
  if (commentCount > 0) infoItems.splice(zipName ? 4 : 3, 0, fi('Comments', commentCount.toLocaleString()));
  $fileInfo.innerHTML = infoItems.join('');

  // XYZ Config
  renderXYZConfig(header, colTypes, xyzGuess);

  // Geometry
  if (geometry && geometry.x && geometry.y && geometry.z) {
    $geoSection.style.display = '';
    lastGeoData = geometry;
    const gx = geometry.x, gy = geometry.y, gz = geometry.z;
    const anySubBlocked = gx.isSubBlocked || gy.isSubBlocked || gz.isSubBlocked;
    const totalGrid = gx.gridCount * gy.gridCount * gz.gridCount;
    const fillPct = totalGrid > 0 ? (totalRowCount / totalGrid * 100) : 0;
    $geoBadge.textContent = anySubBlocked ? 'SUB-BLOCKED' : fillPct.toFixed(1) + '% filled';
    if (anySubBlocked) $geoBadge.style.background = 'var(--blue)';
    else $geoBadge.style.background = '';

    // Build sub-block row if needed
    const subRow = anySubBlocked
      ? geoRowT('Min Block',
          gx.isSubBlocked ? gx.minBlockSize : '—',
          gy.isSubBlocked ? gy.minBlockSize : '—',
          gz.isSubBlocked ? gz.minBlockSize : '—')
      : '';

    // Sub-block detail text
    let subDetail = '';
    if (anySubBlocked) {
      const parts = [];
      for (const [label, g] of [['X', gx], ['Y', gy], ['Z', gz]]) {
        if (g.isSubBlocked) {
          const ratios = g.subBlockSizes.map(s => `1/${s.ratio}`).join(', ');
          parts.push(`${label}: ${g.blockSize} → ${ratios}`);
        }
      }
      subDetail = `<div style="margin-top:0.5rem; font-size:0.75rem; color:var(--blue)">
        Sub-blocks: ${parts.join(' &nbsp;|&nbsp; ')}
      </div>`;
    }

    $geoContent.innerHTML = `
      <div class="geo-grid geo-grid-t">
        <div class="gh"></div><div class="gh">X</div><div class="gh">Y</div><div class="gh">Z</div>
        ${geoRowT('Origin', gx.origin, gy.origin, gz.origin)}
        ${geoRowT('Block Size', gx.blockSize, gy.blockSize, gz.blockSize)}
        ${subRow}
        ${geoRowT('Unique', gx.uniqueCount, gy.uniqueCount, gz.uniqueCount)}
        ${geoRowT('Grid Count', gx.gridCount, gy.gridCount, gz.gridCount)}
        ${geoRowT('Extent', gx.extent, gy.extent, gz.extent)}
      </div>
      <div style="margin-top:0.8rem; font-size:0.75rem; color:var(--fg-dim)">
        Parent grid cells: <strong style="color:var(--fg)">${totalGrid.toLocaleString()}</strong> &nbsp;|&nbsp;
        Total blocks: <strong style="color:var(--fg)">${totalRowCount.toLocaleString()}</strong>
        ${!anySubBlocked ? `&nbsp;|&nbsp; Fill ratio: <strong style="color:var(--amber)">${fillPct.toFixed(1)}%</strong>` : ''}
      </div>
      ${subDetail}
      ${coordOrder ? `<div style="margin-top:0.5rem; font-size:0.75rem; color:var(--fg-dim)">
        Loop order: <strong style="color:var(--fg)">${coordOrder.slowest}</strong> <span style="color:var(--fg-dim)">→</span> <strong style="color:var(--fg)">${coordOrder.middle}</strong> <span style="color:var(--fg-dim)">→</span> <strong style="color:var(--fg)">${coordOrder.fastest}</strong>
        <span style="opacity:0.6">&nbsp;(${coordOrder.slowest} slowest, ${coordOrder.fastest} fastest)</span>
      </div>` : ''}
      ${maxDecimals ? `<div style="margin-top:0.5rem; font-size:0.75rem; color:var(--fg-dim)">
        Rounding: X=${maxDecimals.x}dp, Y=${maxDecimals.y}dp, Z=${maxDecimals.z}dp <span style="opacity:0.5">(detected from data)</span>
      </div>` : ''}
      ${anySubBlocked && currentDXYZ.dx < 0 && currentDXYZ.dy < 0 && currentDXYZ.dz < 0 ? `<div style="margin-top:0.5rem; padding:0.4rem 0.6rem; border-radius:4px; background:rgba(255,180,0,0.12); border:1px solid rgba(255,180,0,0.3); font-size:0.75rem; color:#e5a800;">
        ⚠ This model appears sub-blocked. Assign DX/DY/DZ columns in Preflight for accurate block sizes.
      </div>` : ''}`;
  } else {
    lastGeoData = null;
    $geoSection.style.display = (xyzGuess.x < 0 || xyzGuess.y < 0 || xyzGuess.z < 0) ? '' : 'none';
    $geoBadge.textContent = '';
    $geoContent.innerHTML = '<div style="color:var(--fg-dim);font-size:0.78rem;">Could not detect XYZ columns — select them manually above.</div>';
  }

  // OBJ export button visibility
  document.getElementById('exportObjBtn').style.display = lastGeoData ? '' : 'none';

  // Column Overview
  const $colOverview = document.getElementById('colOverviewSection');
  const $colOverviewContent = document.getElementById('colOverviewContent');
  const $colOverviewBadge = document.getElementById('colOverviewBadge');
  if (header.length > 0) {
    $colOverview.style.display = '';
    let numCount = 0, catCount = 0;
    let ovHtml = '<div class="col-overview-wrap"><table class="col-overview"><thead><tr><th>Column</th><th>Type</th><th>Count</th><th>Nulls</th><th>Zeros</th><th>Completeness</th><th>Range / Unique</th></tr></thead><tbody>';
    for (let ci = 0; ci < header.length; ci++) {
      const cName = header[ci];
      const cType = colTypes[ci];
      const isNum = cType === 'numeric';
      if (isNum) numCount++; else catCount++;
      const s = isNum ? stats[ci] : null;
      const cat = !isNum ? categories[ci] : null;
      let count = 0, nulls = 0, zeros = null, rangeStr = '';
      if (s) {
        count = s.count; nulls = s.nulls; zeros = s.zeros;
        rangeStr = formatNum(s.min) + ' \u2192 ' + formatNum(s.max);
      } else if (cat) {
        const total = Object.values(cat.counts).reduce((a, b) => a + b, 0);
        const uniqueCount = Object.keys(cat.counts).length + (cat.overflow ? '+' : '');
        count = total; nulls = rowCount - total;
        rangeStr = uniqueCount + ' unique';
      } else {
        count = rowCount; nulls = 0;
        rangeStr = '\u2014';
      }
      const completePct = rowCount > 0 ? (count / rowCount * 100) : 0;
      const barW = Math.round(completePct * 48 / 100);
      const nullWarn = nulls > 0 && rowCount > 0 && (nulls / rowCount) > 0.1;
      const typeClass = isNum ? 'col-type-num' : 'col-type-cat';
      const typeLabel = isNum ? 'NUM' : 'CAT';
      ovHtml += '<tr>'
        + '<td class="col-name" title="' + esc(cName) + '">' + esc(cName) + '</td>'
        + '<td><span class="col-type ' + typeClass + '">' + typeLabel + '</span></td>'
        + '<td>' + count.toLocaleString() + '</td>'
        + '<td' + (nullWarn ? ' class="null-warn"' : '') + '>' + (nulls > 0 ? nulls.toLocaleString() : '\u2014') + '</td>'
        + '<td>' + (zeros !== null ? (zeros > 0 ? zeros.toLocaleString() : '\u2014') : '\u2014') + '</td>'
        + '<td><span class="completeness-track"><span class="completeness-bar" style="width:' + barW + 'px"></span></span> ' + completePct.toFixed(1) + '%</td>'
        + '<td>' + rangeStr + '</td>'
        + '</tr>';
    }
    ovHtml += '</tbody></table></div>';
    $colOverviewContent.innerHTML = ovHtml;
    $colOverviewBadge.textContent = numCount + ' num \u00B7 ' + catCount + ' cat';
  } else {
    $colOverview.style.display = 'none';
  }

  // Stats
  const origColCount = data.origColCount || header.length;
  const numCols = Object.keys(stats).map(Number).sort((a, b) => a - b);
  renderStatsTab(stats, header, origColCount, isFiltered, rowCount);

  // Categories
  const catCols = Object.keys(categories).map(Number).sort((a, b) => a - b);
  renderCategoriesTab(categories, header, origColCount, rowCount);

  // StatsCat
  renderStatsCat(data);

  // Export
  initExportColumns();

  // Swath & Section
  renderSwathConfig(data);
  renderSectionConfig(data);

  // Restore pending project state (phase 2 — post-analysis)
  if (pendingProjectRestore) {
    const p = pendingProjectRestore;
    pendingProjectRestore = null;

    const sc = p.statsCat || {};
    if (sc.groupBy != null) currentGroupBy = sc.groupBy;
    if (sc.selectedVars) statsCatSelectedVars = new Set(sc.selectedVars);
    if (sc.sortMode) statsCatGroupSortMode = sc.sortMode;
    if (sc.cdfScale) statsCatCdfScale = sc.cdfScale;
    if (sc.crossMode) statsCatCrossMode = sc.crossMode;

    const st = p.statsTab || {};
    if (st.selectedVars) statsSelectedVars = new Set(st.selectedVars);
    if (st.visibleMetrics) statsVisibleMetrics = new Set(st.visibleMetrics);
    if (st.percentiles) statsPercentiles = st.percentiles;
    if (st.cdfSelected) statsCdfSelected = new Set(st.cdfSelected);
    if (st.cdfScale) statsCdfScale = st.cdfScale;

    // Re-render stats tab with restored state
    if (lastDisplayedStats && lastDisplayedHeader) {
      renderStatsTab(lastDisplayedStats, lastDisplayedHeader, currentOrigColCount || lastDisplayedHeader.length, currentFilter !== null, data.rowCount);
    }

    if (p.exportCols) applyExportRestore(p.exportCols);

    // Restore categories focused column by name
    const catP = p.categories || {};
    if (catP.focusedCol) {
      const idx = header.indexOf(catP.focusedCol);
      if (idx >= 0 && categories[idx]) {
        catFocusedCol = idx;
        renderCatSidebar();
        renderCatMain();
      }
    }
  }

  // Auto-save project
  autoSaveProject();

  // Update tab badges
  const statsTab = $resultsTabs.querySelector('[data-tab="statistics"]');
  const catTab = $resultsTabs.querySelector('[data-tab="categories"]');
  const calcolTab = $resultsTabs.querySelector('[data-tab="calcols"]');
  const statsCatTab = $resultsTabs.querySelector('[data-tab="statscat"]');
  const exportTab = $resultsTabs.querySelector('[data-tab="export"]');
  statsTab.innerHTML = `Statistics <span class="tab-badge">${numCols.length}</span>`;
  catTab.innerHTML = `Categories <span class="tab-badge">${catCols.length}</span>`;
  calcolTab.innerHTML = `Calc <span class="tab-badge">${currentCalcolMeta.length}</span>`;
  exportTab.innerHTML = `Export <span class="tab-badge">${currentHeader.length}</span>`;
  if (currentGroupBy !== null && (data.groupStats || data.groupCategories)) {
    const gbName = header[currentGroupBy] || '?';
    const firstGS = data.groupStats && Object.keys(data.groupStats)[0] ? data.groupStats[Object.keys(data.groupStats)[0]] : null;
    const firstGC = data.groupCategories && Object.keys(data.groupCategories)[0] ? data.groupCategories[Object.keys(data.groupCategories)[0]] : null;
    const groupCount = firstGS ? Object.keys(firstGS).length : (firstGC ? Object.keys(firstGC).length : 0);
    statsCatTab.innerHTML = `StatsCat <span class="tab-badge">${groupCount}</span>`;
    $statsCatBadge.textContent = gbName + ' \u00B7 ' + groupCount + ' groups';
  } else {
    statsCatTab.innerHTML = 'StatsCat';
    $statsCatBadge.textContent = '';
  }

  // Swath/Section tab labels (no badge until generated)
  const swathTab = $resultsTabs.querySelector('[data-tab="swath"]');
  const sectionTab = $resultsTabs.querySelector('[data-tab="section"]');
  if (swathTab) swathTab.textContent = 'Swath';
  if (sectionTab) sectionTab.textContent = 'Section';

  // Render calcol editor
  renderVariableBrowser();
  enableSimulatedDataSource();
}

function renderStatsCat(data) {
  const { header, colTypes, groupStats, groupCategories } = data;
  const origColCount = data.origColCount || header.length;
  lastStatsCatData = data;

  // Populate dropdown with categorical columns
  const catColIdxs = [];
  for (let i = 0; i < header.length; i++) {
    if (colTypes[i] === 'categorical') catColIdxs.push(i);
  }
  let opts = '<option value="">— select grouping column —</option>';
  for (const i of catColIdxs) {
    const sel = currentGroupBy === i ? ' selected' : '';
    const isCalcol = i >= origColCount;
    opts += '<option value="' + i + '"' + sel + '>' + esc(header[i]) + (isCalcol ? ' (calc)' : '') + '</option>';
  }
  $statsCatGroupBy.innerHTML = opts;

  // If no groupBy selected or no groupStats, show empty states
  if (currentGroupBy === null || !groupStats) {
    $statsCatVarList.innerHTML = '';
    $statsCatGroupList.innerHTML = '';
    $statsCatContent.innerHTML = '<div class="statscat-empty">Select a categorical column to see statistics broken down by group.</div>';
    return;
  }

  // Build combined variable list: numeric + categorical (excluding groupBy)
  const numCols = Object.keys(data.stats).map(Number).sort((a, b) => a - b);
  const catVarCols = [];
  for (let i = 0; i < header.length; i++) {
    if (colTypes[i] === 'categorical' && i !== currentGroupBy) catVarCols.push(i);
  }
  const allVarCols = [...numCols, ...catVarCols].sort((a, b) => a - b);

  if (allVarCols.length === 0) {
    $statsCatVarList.innerHTML = '';
    $statsCatGroupList.innerHTML = '';
    $statsCatContent.innerHTML = '<div class="statscat-empty">No variables available for analysis.</div>';
    return;
  }

  // Initialize selected vars if empty (first time or after file change)
  if (statsCatSelectedVars.size === 0) {
    for (const i of allVarCols) statsCatSelectedVars.add(i);
  }

  // Auto-select first variable that has data for display
  if (currentStatsCatVar === null || (!groupStats[currentStatsCatVar] && !(groupCategories && groupCategories[currentStatsCatVar]))) {
    const analyzed = allVarCols.filter(i => groupStats[i] || (groupCategories && groupCategories[i]));
    currentStatsCatVar = analyzed.length > 0 ? analyzed[0] : allVarCols[0];
  }

  // Populate variable list
  renderStatsCatVarList(allVarCols, header, origColCount, colTypes);

  // Determine group values from selected variable (use whichever data source exists)
  const gs = groupStats[currentStatsCatVar];
  const gc = groupCategories && groupCategories[currentStatsCatVar];
  let allGroupKeys;
  if (gs) {
    allGroupKeys = Object.keys(gs);
  } else if (gc) {
    allGroupKeys = Object.keys(gc);
  } else {
    allGroupKeys = [];
  }

  // Build allGroups with counts for group list
  const allGroups = allGroupKeys.map(gv => {
    if (gs && gs[gv]) return [gv, gs[gv]];
    if (gc && gc[gv]) {
      const total = Object.values(gc[gv]).reduce((s, c) => s + c, 0);
      return [gv, { count: total }];
    }
    return [gv, { count: 0 }];
  });

  // Initialize checked set to all if null
  if (currentStatsCatChecked === null) {
    currentStatsCatChecked = new Set(allGroupKeys);
  }

  // Populate group list
  renderStatsCatGroupList(allGroups);

  // Wire sidebar events
  wireStatsCatSidebarEvents(allVarCols, header, origColCount, colTypes);

  // Render right content
  renderStatsCatContent();
}

function renderStatsCatVarList(allVarCols, header, origColCount, colTypes) {
  const search = $statsCatVarSearch.value.toLowerCase();
  let html = '';
  for (const colIdx of allVarCols) {
    if (statsCatShowSelectedOnly && !statsCatSelectedVars.has(colIdx)) continue;
    const name = header[colIdx];
    if (search && name.toLowerCase().indexOf(search) === -1) continue;
    const isCalcol = colIdx >= origColCount;
    const isCat = colTypes[colIdx] === 'categorical';
    const active = colIdx === currentStatsCatVar ? ' active' : '';
    const checked = statsCatSelectedVars.has(colIdx) ? ' checked' : '';
    const unchecked = !statsCatSelectedVars.has(colIdx) ? ' unchecked' : '';
    html += '<div class="statscat-var-item' + active + unchecked + '" data-col="' + colIdx + '">';
    html += '<input type="checkbox"' + checked + ' data-col="' + colIdx + '">';
    html += '<span class="var-name">' + esc(name) + '</span>';
    if (isCalcol) html += '<span class="calcol-tag">CALC</span>';
    html += '<span class="var-type-tag ' + (isCat ? 'cat' : 'num') + '">' + (isCat ? 'CAT' : 'NUM') + '</span>';
    html += '</div>';
  }
  $statsCatVarList.innerHTML = html;
  // Update filter toggle state
  $statsCatVarFilter.textContent = statsCatShowSelectedOnly ? 'Selected' : 'All';
  $statsCatVarFilter.classList.toggle('active', statsCatShowSelectedOnly);
}

function sortStatsCatGroups(groups) {
  if (statsCatGroupSortMode === 'name') {
    return groups.slice().sort((a, b) => (a[0] || '').localeCompare(b[0] || ''));
  }
  return groups.slice().sort((a, b) => b[1].count - a[1].count);
}

function renderStatsCatGroupList(allGroups) {
  const sorted = sortStatsCatGroups(allGroups);
  const search = $statsCatGroupSearch.value.toLowerCase();
  let html = '';
  for (const [gv, s] of sorted) {
    const label = gv || '(empty)';
    if (search && label.toLowerCase().indexOf(search) === -1) continue;
    const checked = currentStatsCatChecked && currentStatsCatChecked.has(gv) ? ' checked' : '';
    html += '<div class="statscat-group-item">';
    html += '<label><input type="checkbox"' + checked + ' data-gv="' + esc(gv) + '"> <span class="gname">' + esc(label) + '</span></label>';
    html += '<span class="gcount">' + s.count.toLocaleString() + '</span>';
    html += '</div>';
  }
  $statsCatGroupList.innerHTML = html;
}

function getStatsCatGroupEntries() {
  const data = lastStatsCatData;
  if (!data) return [];
  const gs = data.groupStats[currentStatsCatVar];
  const gc = data.groupCategories && data.groupCategories[currentStatsCatVar];
  if (gs) return Object.entries(gs);
  if (gc) return Object.entries(gc).map(([gv, counts]) => [gv, { count: Object.values(counts).reduce((s, c) => s + c, 0) }]);
  return [];
}

function wireStatsCatSidebarEvents(allVarCols, header, origColCount, colTypes) {
  // Variable row click — select for display (ignore if click was on checkbox)
  $statsCatVarList.querySelectorAll('.statscat-var-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT') return;
      const colIdx = parseInt(el.dataset.col);
      if (colIdx === currentStatsCatVar) return;
      currentStatsCatVar = colIdx;

      renderStatsCatVarList(allVarCols, header, origColCount, colTypes);
      renderStatsCatGroupList(getStatsCatGroupEntries());
      wireStatsCatSidebarEvents(allVarCols, header, origColCount, colTypes);
      renderStatsCatContent();
    });
  });

  // Variable checkboxes — toggle inclusion for analysis
  $statsCatVarList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      const colIdx = parseInt(cb.dataset.col);
      if (cb.checked) {
        statsCatSelectedVars.add(colIdx);
      } else {
        statsCatSelectedVars.delete(colIdx);
      }
      renderStatsCatVarList(allVarCols, header, origColCount, colTypes);
      wireStatsCatSidebarEvents(allVarCols, header, origColCount, colTypes);
      markAnalysisStale();
    });
  });

  // Variable All/None — affect only search-filtered results
  $statsCatVarAll.onclick = () => {
    $statsCatVarList.querySelectorAll('.statscat-var-item').forEach(el => {
      statsCatSelectedVars.add(parseInt(el.dataset.col));
    });
    renderStatsCatVarList(allVarCols, header, origColCount, colTypes);
    wireStatsCatSidebarEvents(allVarCols, header, origColCount, colTypes);
    markAnalysisStale();
  };
  $statsCatVarNone.onclick = () => {
    $statsCatVarList.querySelectorAll('.statscat-var-item').forEach(el => {
      statsCatSelectedVars.delete(parseInt(el.dataset.col));
    });
    renderStatsCatVarList(allVarCols, header, origColCount, colTypes);
    wireStatsCatSidebarEvents(allVarCols, header, origColCount, colTypes);
    markAnalysisStale();
  };

  // Variable filter toggle (All / Selected)
  $statsCatVarFilter.onclick = () => {
    statsCatShowSelectedOnly = !statsCatShowSelectedOnly;
    renderStatsCatVarList(allVarCols, header, origColCount, colTypes);
    wireStatsCatSidebarEvents(allVarCols, header, origColCount, colTypes);
  };

  // Group checkboxes
  $statsCatGroupList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const gv = cb.dataset.gv;
      if (cb.checked) { currentStatsCatChecked.add(gv); } else { currentStatsCatChecked.delete(gv); }
      renderStatsCatContent();
    });
  });

  // All/None buttons
  $statsCatGroupAll.onclick = () => {
    const entries = getStatsCatGroupEntries();
    currentStatsCatChecked = new Set(entries.map(e => e[0]));
    renderStatsCatGroupList(entries);
    wireStatsCatSidebarEvents(allVarCols, header, origColCount, colTypes);
    renderStatsCatContent();
  };
  $statsCatGroupNone.onclick = () => {
    currentStatsCatChecked = new Set();
    renderStatsCatGroupList(getStatsCatGroupEntries());
    wireStatsCatSidebarEvents(allVarCols, header, origColCount, colTypes);
    renderStatsCatContent();
  };

  // Sort toggle
  $statsCatGroupSort.onclick = () => {
    statsCatGroupSortMode = statsCatGroupSortMode === 'count' ? 'name' : 'count';
    $statsCatGroupSort.textContent = 'Sort: ' + statsCatGroupSortMode;
    renderStatsCatGroupList(getStatsCatGroupEntries());
    wireStatsCatSidebarEvents(allVarCols, header, origColCount, colTypes);
    renderStatsCatContent();
  };

  // Variable search
  $statsCatVarSearch.oninput = () => {
    renderStatsCatVarList(allVarCols, header, origColCount, colTypes);
    wireStatsCatSidebarEvents(allVarCols, header, origColCount, colTypes);
  };

  // Group search
  $statsCatGroupSearch.oninput = () => {
    renderStatsCatGroupList(getStatsCatGroupEntries());
    wireStatsCatSidebarEvents(allVarCols, header, origColCount, colTypes);
  };

}

function renderStatsCatContent() {
  const data = lastStatsCatData;
  if (!data) {
    $statsCatContent.innerHTML = '<div class="statscat-empty">No grouped statistics available.</div>';
    return;
  }
  if (currentStatsCatVar === null) {
    $statsCatContent.innerHTML = '<div class="statscat-empty">Select a variable from the sidebar.</div>';
    return;
  }
  if (!currentStatsCatChecked || currentStatsCatChecked.size === 0) {
    $statsCatContent.innerHTML = '<div class="statscat-empty">No groups selected. Check groups in the sidebar to view statistics.</div>';
    return;
  }

  const header = data.header;
  const colTypes = data.colTypes;
  const origColCount = data.origColCount || header.length;
  const varName = header[currentStatsCatVar];
  const isCalcol = currentStatsCatVar >= origColCount;
  const isCatVar = colTypes[currentStatsCatVar] === 'categorical';

  if (isCatVar) {
    renderStatsCatCrossTab(data, varName, isCalcol);
  } else {
    renderStatsCatNumeric(data, varName, isCalcol);
  }
}

function renderStatsCatNumeric(data, varName, isCalcol) {
  const gs = data.groupStats[currentStatsCatVar];
  if (!gs) {
    $statsCatContent.innerHTML = '<div class="statscat-empty">This variable was not included in the analysis. Check its checkbox and click Analyze.</div>';
    return;
  }

  // Filter entries to checked groups, apply current sort
  const entries = sortStatsCatGroups(
    Object.entries(gs).filter(([gv]) => currentStatsCatChecked.has(gv))
  );

  // Header with copy button
  let html = '<div style="display:flex;align-items:center;gap:0.8rem;margin-bottom:0.5rem;">';
  html += '<span style="font-size:0.82rem;font-weight:600;color:var(--fg-bright);">' + esc(varName) + (isCalcol ? ' <span class="calcol-tag">CALC</span>' : '') + '</span>';
  html += '<button class="statscat-copy-btn" id="statsCatCopyBtn">Copy table</button>';
  html += '</div>';

  html += '<div class="statscat-table-wrap"><table class="stats"><thead><tr><th>Group</th><th>Count</th><th>Nulls</th><th>Min</th><th>P10</th><th>P25</th><th>P50</th><th>P75</th><th>P90</th><th>Max</th><th>Mean</th><th>Std</th><th>CV%</th><th>Skew</th><th>Kurt</th></tr></thead><tbody>';

  for (const [gv, s] of entries) {
    const cv = (s.mean && s.std && s.mean !== 0) ? Math.abs(s.std / s.mean * 100) : null;
    const q = s.quantiles;
    html += '<tr>';
    html += '<td>' + esc(gv || '(empty)') + '</td>';
    html += '<td>' + s.count.toLocaleString() + '</td>';
    html += '<td>' + (s.nulls > 0 ? s.nulls.toLocaleString() : '\u2014') + '</td>';
    html += '<td>' + formatNum(s.min) + '</td>';
    html += '<td>' + (q ? formatNum(q.p10) : '\u2014') + '</td>';
    html += '<td>' + (q ? formatNum(q.p25) : '\u2014') + '</td>';
    html += '<td>' + (q ? formatNum(q.p50) : '\u2014') + '</td>';
    html += '<td>' + (q ? formatNum(q.p75) : '\u2014') + '</td>';
    html += '<td>' + (q ? formatNum(q.p90) : '\u2014') + '</td>';
    html += '<td>' + formatNum(s.max) + '</td>';
    html += '<td>' + formatNum(s.mean) + '</td>';
    html += '<td>' + formatNum(s.std) + '</td>';
    html += '<td>' + (cv !== null ? cv.toFixed(1) : '\u2014') + '</td>';
    html += '<td>' + (s.skewness !== null ? s.skewness.toFixed(2) : '\u2014') + '</td>';
    html += '<td>' + (s.kurtosis !== null ? s.kurtosis.toFixed(2) : '\u2014') + '</td>';
    html += '</tr>';
  }
  html += '</tbody></table></div>';

  // CDF toolbar
  html += '<div class="statscat-cdf-toolbar">';
  html += '<div class="tb-group"><button class="sc-scale' + (statsCatCdfScale === 'linear' ? ' active' : '') + '" data-scale="linear">Linear</button>';
  html += '<button class="sc-scale' + (statsCatCdfScale === 'log' ? ' active' : '') + '" data-scale="log">Log</button></div>';
  html += '<div class="tb-group"><label><input type="checkbox" id="scManualCb"' + (statsCatCdfManual ? ' checked' : '') + '> Manual</label>';
  if (statsCatCdfManual) {
    html += '<input type="number" id="scManualMin" placeholder="min" step="any"' + (statsCatCdfMin !== null ? ' value="' + statsCatCdfMin + '"' : '') + '>';
    html += '<input type="number" id="scManualMax" placeholder="max" step="any"' + (statsCatCdfMax !== null ? ' value="' + statsCatCdfMax + '"' : '') + '>';
  }
  html += '</div>';
  html += '<div class="tb-group" style="margin-left:auto"><button id="scCopySvg">Copy SVG</button><button id="scDownloadPng">Download PNG</button></div>';
  html += '</div>';

  // CDF plot
  html += renderOverlaidCDF(entries, varName);

  $statsCatContent.innerHTML = html;
  wireStatsCatCopyBtn();
  wireStatsCatCdfToolbar();
}

function renderStatsCatCrossTab(data, varName, isCalcol) {
  const gc = data.groupCategories && data.groupCategories[currentStatsCatVar];
  if (!gc) {
    $statsCatContent.innerHTML = '<div class="statscat-empty">This variable was not included in the analysis. Check its checkbox and click Analyze.</div>';
    return;
  }

  // Get checked groups
  const groupKeys = sortStatsCatGroups(
    Object.entries(gc).filter(([gv]) => currentStatsCatChecked.has(gv)).map(([gv, counts]) => [gv, { count: Object.values(counts).reduce((s, c) => s + c, 0) }])
  ).map(([gv]) => gv);

  // Collect all unique values across checked groups
  const allVals = new Set();
  for (const gv of groupKeys) {
    if (gc[gv]) for (const v of Object.keys(gc[gv])) allVals.add(v);
  }
  const valList = Array.from(allVals).sort();

  // Header
  let html = '<div style="display:flex;align-items:center;gap:0.8rem;margin-bottom:0.5rem;">';
  html += '<span style="font-size:0.82rem;font-weight:600;color:var(--fg-bright);">' + esc(varName) + (isCalcol ? ' <span class="calcol-tag">CALC</span>' : '') + '</span>';
  html += '<button class="statscat-copy-btn" id="statsCatCopyBtn">Copy table</button>';
  html += '</div>';

  // Mode toggle
  html += '<div class="statscat-crosstab-mode">';
  html += '<button class="ct-mode' + (statsCatCrossMode === 'count' ? ' active' : '') + '" data-mode="count">Count</button>';
  html += '<button class="ct-mode' + (statsCatCrossMode === 'row' ? ' active' : '') + '" data-mode="row">Row %</button>';
  html += '<button class="ct-mode' + (statsCatCrossMode === 'col' ? ' active' : '') + '" data-mode="col">Col %</button>';
  html += '</div>';

  // Compute totals
  const rowTotals = {};
  const colTotals = {};
  let grandTotal = 0;
  for (const gv of groupKeys) {
    rowTotals[gv] = 0;
    for (const v of valList) {
      const c = (gc[gv] && gc[gv][v]) || 0;
      rowTotals[gv] += c;
      colTotals[v] = (colTotals[v] || 0) + c;
      grandTotal += c;
    }
  }

  // Find max value for heatmap
  let maxPct = 0;
  if (statsCatCrossMode !== 'count') {
    for (const gv of groupKeys) {
      for (const v of valList) {
        const c = (gc[gv] && gc[gv][v]) || 0;
        const pct = statsCatCrossMode === 'row' ? (rowTotals[gv] > 0 ? c / rowTotals[gv] : 0) : (colTotals[v] > 0 ? c / colTotals[v] : 0);
        if (pct > maxPct) maxPct = pct;
      }
    }
  }

  // Table
  html += '<div class="statscat-table-wrap"><table class="stats"><thead><tr><th>Group</th>';
  for (const v of valList) html += '<th>' + esc(v) + '</th>';
  html += '<th>Total</th></tr></thead><tbody>';

  for (const gv of groupKeys) {
    html += '<tr><td>' + esc(gv || '(empty)') + '</td>';
    for (const v of valList) {
      const c = (gc[gv] && gc[gv][v]) || 0;
      let display, bg = '';
      if (statsCatCrossMode === 'count') {
        display = c > 0 ? c.toLocaleString() : '\u2014';
      } else if (statsCatCrossMode === 'row') {
        const pct = rowTotals[gv] > 0 ? c / rowTotals[gv] * 100 : 0;
        display = c > 0 ? pct.toFixed(1) + '%' : '\u2014';
        if (c > 0) bg = 'background:rgba(232,163,23,' + (pct / 100 * 0.35).toFixed(2) + ')';
      } else {
        const pct = colTotals[v] > 0 ? c / colTotals[v] * 100 : 0;
        display = c > 0 ? pct.toFixed(1) + '%' : '\u2014';
        if (c > 0) bg = 'background:rgba(232,163,23,' + (pct / 100 * 0.35).toFixed(2) + ')';
      }
      html += '<td' + (bg ? ' style="' + bg + '"' : '') + '>' + display + '</td>';
    }
    html += '<td>' + rowTotals[gv].toLocaleString() + '</td></tr>';
  }

  // Column totals row
  html += '<tr style="border-top:2px solid var(--border);font-weight:600"><td>Total</td>';
  for (const v of valList) html += '<td>' + (colTotals[v] || 0).toLocaleString() + '</td>';
  html += '<td>' + grandTotal.toLocaleString() + '</td></tr>';

  html += '</tbody></table></div>';

  $statsCatContent.innerHTML = html;
  wireStatsCatCopyBtn();
  wireStatsCatCrossMode();
}

function wireStatsCatCrossMode() {
  $statsCatContent.querySelectorAll('.ct-mode').forEach(btn => {
    btn.addEventListener('click', () => {
      statsCatCrossMode = btn.dataset.mode;
      renderStatsCatContent();
    });
  });
}

function renderOverlaidCDF(entries, varName) {
  const plotEntries = entries.filter(([, s]) => s.centroids && s.centroids.length > 0);
  if (plotEntries.length === 0) return '';

  const isLog = statsCatCdfScale === 'log';
  const W = 700, plotBaseH = 380;
  const pad = { top: 20, right: 30, bottom: 50, left: 60 };
  const plotW = W - pad.left - pad.right;
  const plotH = plotBaseH - pad.top - pad.bottom;

  // Legend layout: 3 columns, wrapping rows
  const legCols = 3;
  const legRowH = 16;
  const legPadTop = 12;
  const legRows = Math.ceil(plotEntries.length / legCols);
  const legendH = legPadTop + legRows * legRowH + 6;
  const H = plotBaseH + legendH;

  // Determine x-axis range
  let globalMin = Infinity, globalMax = -Infinity;
  for (const [, s] of plotEntries) {
    if (s.min < globalMin) globalMin = s.min;
    if (s.max > globalMax) globalMax = s.max;
  }
  if (statsCatCdfManual) {
    if (statsCatCdfMin !== null) globalMin = statsCatCdfMin;
    if (statsCatCdfMax !== null) globalMax = statsCatCdfMax;
  }

  // For log scale, clamp min to positive
  let logMin, logMax;
  if (isLog) {
    logMin = Math.log10(Math.max(globalMin, 1e-10));
    logMax = Math.log10(Math.max(globalMax, 1e-9));
    if (logMax <= logMin) logMax = logMin + 1;
  }
  const xRange = isLog ? (logMax - logMin) : (globalMax - globalMin || 1);

  function sx(v) {
    if (isLog) {
      const lv = Math.log10(Math.max(v, 1e-10));
      return pad.left + ((lv - logMin) / xRange) * plotW;
    }
    return pad.left + ((v - globalMin) / xRange) * plotW;
  }
  function sy(v) { return pad.top + (1 - v) * plotH; }

  // Grid
  const yTicks = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0];
  let gridSvg = '';
  for (const yt of yTicks) {
    const y = sy(yt);
    gridSvg += '<line x1="' + pad.left + '" y1="' + y + '" x2="' + (W - pad.right) + '" y2="' + y + '" stroke="#1e2228" stroke-width="1"/>';
    gridSvg += '<text x="' + (pad.left - 8) + '" y="' + (y + 3.5) + '" text-anchor="end" fill="#6a737d" font-size="10">' + (yt * 100).toFixed(0) + '%</text>';
  }
  const nxTicks = 6;
  for (let i = 0; i <= nxTicks; i++) {
    let v;
    if (isLog) {
      v = Math.pow(10, logMin + (xRange * i / nxTicks));
    } else {
      v = globalMin + ((globalMax - globalMin || 1) * i / nxTicks);
    }
    const x = sx(v);
    gridSvg += '<line x1="' + x + '" y1="' + pad.top + '" x2="' + x + '" y2="' + (plotBaseH - pad.bottom) + '" stroke="#1e2228" stroke-width="1"/>';
    const label = Math.abs(v) >= 1e5 || (Math.abs(v) < 0.01 && v !== 0) ? v.toExponential(1) : v.toFixed(Math.abs(v) < 10 ? 2 : 0);
    gridSvg += '<text x="' + x + '" y="' + (plotBaseH - pad.bottom + 16) + '" text-anchor="middle" fill="#6a737d" font-size="10">' + label + '</text>';
  }

  let curvesSvg = '';
  let meansSvg = '';
  const gbColName = currentGroupBy !== null ? currentHeader[currentGroupBy] : '';
  for (let gi = 0; gi < plotEntries.length; gi++) {
    const [gv, s] = plotEntries[gi];
    const color = getCategoryColor(gbColName, gv, gi);
    const points = [];
    let cumCount = 0;
    for (const [mean, count] of s.centroids) {
      if (isLog && mean <= 0) { cumCount += count; continue; }
      cumCount += count;
      const px = sx(mean);
      if (px < pad.left || px > W - pad.right) continue;
      points.push({ x: px, y: sy(cumCount / s.count) });
    }
    if (points.length > 0) {
      const pathParts = points.map((p, i) => (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1));
      curvesSvg += '<path d="' + pathParts.join(' ') + '" fill="none" stroke="' + color + '" stroke-width="1.5" opacity="0.85"/>';
    }
    if (s.mean !== null && (!isLog || s.mean > 0)) {
      const mx = sx(s.mean);
      if (mx >= pad.left && mx <= W - pad.right) {
        meansSvg += '<line x1="' + mx + '" y1="' + pad.top + '" x2="' + mx + '" y2="' + (plotBaseH - pad.bottom) + '" stroke="' + color + '" stroke-width="1" stroke-dasharray="4,3" opacity="0.5"/>';
      }
    }
  }

  // Legend inside SVG
  const legTop = plotBaseH + legPadTop;
  const colW = (W - pad.left - pad.right) / legCols;
  let legendSvg = '';
  for (let gi = 0; gi < plotEntries.length; gi++) {
    const [gv] = plotEntries[gi];
    const color = getCategoryColor(gbColName, gv, gi);
    const col = gi % legCols;
    const row = Math.floor(gi / legCols);
    const lx = pad.left + col * colW;
    const ly = legTop + row * legRowH;
    legendSvg += '<line x1="' + lx + '" y1="' + (ly + 5) + '" x2="' + (lx + 18) + '" y2="' + (ly + 5) + '" stroke="' + color + '" stroke-width="2.5"/>';
    legendSvg += '<text x="' + (lx + 24) + '" y="' + (ly + 9) + '" fill="#6a737d" font-size="9.5">' + esc(gv || '(empty)') + '</text>';
  }

  const scaleLabel = isLog ? ' (log)' : '';
  const svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" style="font-family:var(--mono)" id="statsCatCdfSvg">' +
    '<rect width="' + W + '" height="' + H + '" fill="var(--bg)" rx="4"/>' +
    gridSvg + meansSvg + curvesSvg +
    '<text x="' + (W / 2) + '" y="' + (plotBaseH - 4) + '" text-anchor="middle" fill="#6a737d" font-size="10">CDF' + scaleLabel + ' \u2014 ' + esc(varName) + '</text>' +
    '<text x="12" y="' + (plotBaseH / 2) + '" text-anchor="middle" fill="#6a737d" font-size="10" transform="rotate(-90, 12, ' + (plotBaseH / 2) + ')">Cumulative %</text>' +
    legendSvg +
    '</svg>';

  return '<div class="statscat-cdf-plot">' + svg + '</div>';
}

function wireStatsCatCdfToolbar() {
  // Scale buttons
  $statsCatContent.querySelectorAll('.sc-scale').forEach(btn => {
    btn.addEventListener('click', () => {
      statsCatCdfScale = btn.dataset.scale;
      renderStatsCatContent();
    });
  });
  // Manual checkbox
  const manualCb = document.getElementById('scManualCb');
  if (manualCb) {
    manualCb.addEventListener('change', () => {
      statsCatCdfManual = manualCb.checked;
      if (!statsCatCdfManual) { statsCatCdfMin = null; statsCatCdfMax = null; }
      renderStatsCatContent();
    });
  }
  // Manual min/max inputs
  const minInput = document.getElementById('scManualMin');
  const maxInput = document.getElementById('scManualMax');
  if (minInput) {
    minInput.addEventListener('change', () => {
      statsCatCdfMin = minInput.value !== '' ? parseFloat(minInput.value) : null;
      renderStatsCatContent();
    });
  }
  if (maxInput) {
    maxInput.addEventListener('change', () => {
      statsCatCdfMax = maxInput.value !== '' ? parseFloat(maxInput.value) : null;
      renderStatsCatContent();
    });
  }
  // Copy SVG
  const copySvg = document.getElementById('scCopySvg');
  if (copySvg) {
    copySvg.addEventListener('click', () => {
      const svgEl = document.getElementById('statsCatCdfSvg');
      if (!svgEl) return;
      navigator.clipboard.writeText(svgEl.outerHTML).then(() => {
        copySvg.textContent = 'Copied!';
        setTimeout(() => { copySvg.textContent = 'Copy SVG'; }, 1500);
      });
    });
  }
  // Download PNG — light theme for documents
  const dlPng = document.getElementById('scDownloadPng');
  if (dlPng) {
    dlPng.addEventListener('click', () => {
      const svgEl = document.getElementById('statsCatCdfSvg');
      if (!svgEl) return;
      let svgData = new XMLSerializer().serializeToString(svgEl);
      // Retheme for light background: white bg, dark text/lines
      svgData = svgData.replace(/fill="var\(--bg\)"/g, 'fill="white"');
      svgData = svgData.replace(/fill="#6a737d"/g, 'fill="#333"');
      svgData = svgData.replace(/stroke="#1e2228"/g, 'stroke="#ddd"');
      svgData = svgData.replace(/style="font-family:var\(--mono\)"/g, 'style="font-family:monospace"');
      const canvas = document.createElement('canvas');
      const scale = 2;
      const vb = svgEl.getAttribute('viewBox').split(' ').map(Number);
      canvas.width = vb[2] * scale;
      canvas.height = vb[3] * scale;
      const ctx = canvas.getContext('2d');
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(blob => {
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'cdf_plot.png';
          a.click();
          URL.revokeObjectURL(url);
        }, 'image/png');
      };
      img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
    });
  }
}

function wireStatsCatCopyBtn() {
  const btn = document.getElementById('statsCatCopyBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const table = $statsCatContent.querySelector('table.stats');
    if (!table) return;
    const rows = table.querySelectorAll('tr');
    const lines = [];
    rows.forEach(row => {
      const cells = row.querySelectorAll('th, td');
      const vals = [];
      cells.forEach(c => vals.push(c.textContent));
      lines.push(vals.join('\t'));
    });
    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy table'; }, 1500);
    });
  });
}

// Pre-populate variable list from known column metadata (no analysis needed)
function prePopulateStatsCatVars() {
  const header = currentHeader;
  const colTypes = currentColTypes;
  const origColCount = currentOrigColCount || header.length;
  if (header.length === 0) return;

  // Build combined variable list: numeric + categorical (excluding groupBy)
  const allVarCols = [];
  for (let i = 0; i < header.length; i++) {
    if (i === currentGroupBy) continue;
    if (colTypes[i] === 'numeric' || colTypes[i] === 'categorical') allVarCols.push(i);
  }
  allVarCols.sort((a, b) => a - b);

  // Initialize selected vars if empty
  if (statsCatSelectedVars.size === 0) {
    for (const i of allVarCols) statsCatSelectedVars.add(i);
  }

  // Auto-select first variable for display
  if (currentStatsCatVar === null) {
    currentStatsCatVar = allVarCols.length > 0 ? allVarCols[0] : null;
  }

  // Render variable list
  renderStatsCatVarList(allVarCols, header, origColCount, colTypes);

  // Clear group list (no data yet)
  $statsCatGroupList.innerHTML = '';

  // Show prompt in content
  $statsCatContent.innerHTML = '<div class="statscat-empty">Configure variables and click Analyze to compute grouped statistics.</div>';

  // Wire sidebar events (variable clicks, checkboxes, search, analyze button)
  wireStatsCatSidebarEvents(allVarCols, header, origColCount, colTypes);
}

// StatsCat dropdown handler
$statsCatGroupBy.addEventListener('change', () => {
  const val = $statsCatGroupBy.value;
  currentGroupBy = val ? parseInt(val) : null;
  currentStatsCatVar = null;
  currentStatsCatChecked = null;
  statsCatShowSelectedOnly = false;
  $statsCatVarSearch.value = '';
  $statsCatGroupSearch.value = '';
  if (currentGroupBy !== null) {
    prePopulateStatsCatVars();
  } else {
    $statsCatVarList.innerHTML = '';
    $statsCatGroupList.innerHTML = '';
    $statsCatContent.innerHTML = '<div class="statscat-empty">Select a categorical column to see statistics broken down by group.</div>';
  }
  markAnalysisStale();
});

// Mobile collapsible StatsCat sections (one-time delegation)
if (window.matchMedia('(max-width: 700px)').matches) {
  document.querySelector('.statscat-sidebar').addEventListener('click', (e) => {
    const title = e.target.closest('.statscat-sidebar-section--grow > .statscat-sidebar-title');
    if (!title) return;
    const section = title.closest('.statscat-sidebar-section--grow');
    const wasCollapsed = section.classList.contains('collapsed');
    document.querySelectorAll('.statscat-sidebar-section--grow').forEach(s => s.classList.add('collapsed'));
    if (wasCollapsed) section.classList.remove('collapsed');
  });
}

