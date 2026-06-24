// ─── Result Cache (IndexedDB) ──────────────────────────────────────────

function openCacheDB() {
  return new Promise(function(resolve, reject) {
    var req = indexedDB.open('bma-cache', 4);
    req.onupgradeneeded = function(e) {
      var db = req.result;
      if (!db.objectStoreNames.contains('results'))
        db.createObjectStore('results');
      if (!db.objectStoreNames.contains('recents'))
        db.createObjectStore('recents');
      if (!db.objectStoreNames.contains('handles'))   // C11: FSAA directory handles
        db.createObjectStore('handles');
      if (!db.objectStoreNames.contains('projects'))  // C14: project registry records
        db.createObjectStore('projects');
      if (!db.objectStoreNames.contains('packstore'))  // C14: embedded pack bytes (idb backing)
        db.createObjectStore('packstore');
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
    wsRecentsCache = items || [];   // C6-2: feed the File → Open recent submenu
    if (items.length === 0) {
      $recentFiles.innerHTML = '';
      return;
    }
    var html = '<div class="recent-files-title">Recent</div>';
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      // C11: a mounted project FOLDER (an on-disk project) \u2014 distinct icon + badge
      if (it.isFolder) {
        html += '<div class="recent-item recent-item--folder" data-key="' + esc(it._key) + '" title="On-disk project folder">';
        html += '<span class="recent-item-name">\ud83d\udcc1 ' + esc(it.name) + '</span>';
        html += '<span class="recent-item-size"></span>';
        html += '<span class="recent-item-project recent-item-folder-badge">folder</span>';
        html += '<span class="recent-item-time">' + timeAgo(it.lastOpened) + '</span>';
        html += '<button class="recent-item-remove" data-key="' + esc(it._key) + '" title="Remove">\u2715</button>';
        html += '</div>';
        continue;
      }
      var hasProj = !!it.packed;
      try { hasProj = hasProj || localStorage.getItem(it._key) !== null; } catch(e) {}
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

// Model-optional projects: list the model-less projects saved in localStorage
// (bma:proj:<id>) on the landing screen. These have no model file to drop, so
// this is their reopen path (openProjectById); each then awaits its dataset files.
function renderProjectList() {
  var $pl = document.getElementById('projectList');
  if (!$pl) return;
  var projs = [];
  try {
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (!k || k.indexOf('bma:proj:') !== 0) continue;
      try {
        var p = JSON.parse(localStorage.getItem(k));
        if (p && p._bma) projs.push({
          id: p.id || k.slice(9),
          title: p.title,
          ts: p._ts || 0,
          count: (p.datasets ? p.datasets.length : 0) + (p.aux && p.aux.fileName ? 1 : 0)
        });
      } catch (e) { /* corrupt entry — skip */ }
    }
  } catch (e) { $pl.innerHTML = ''; return; }
  if (!projs.length) { $pl.innerHTML = ''; return; }
  projs.sort(function(a, b) { return b.ts - a.ts; });
  var html = '<div class="recent-files-title">Projects</div>';
  for (var j = 0; j < projs.length; j++) {
    var pr = projs[j];
    html += '<div class="recent-item project-item" data-proj="' + esc(pr.id) + '">';
    html += '<span class="recent-item-name">' + esc(pr.title || 'Untitled project') + '</span>';
    html += '<span class="recent-item-size">' + pr.count + ' dataset' + (pr.count === 1 ? '' : 's') + '</span>';
    html += '<span class="recent-item-project">project</span>';
    html += '<span class="recent-item-time">' + timeAgo(pr.ts) + '</span>';
    html += '<button class="recent-item-remove" data-proj="' + esc(pr.id) + '" title="Remove">✕</button>';
    html += '</div>';
  }
  $pl.innerHTML = html;
  $pl.querySelectorAll('.project-item').forEach(function(el) {
    el.addEventListener('click', function(e) {
      if (e.target.closest('.recent-item-remove')) return;
      openProjectById(el.getAttribute('data-proj'));
    });
  });
  $pl.querySelectorAll('.recent-item-remove').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      try { localStorage.removeItem('bma:proj:' + btn.getAttribute('data-proj')); } catch (ex) { /* ignore */ }
      renderProjectList();
    });
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
    // C11: a folder recent → re-mount it + open its project (open-recent-folder)
    if (entry.isFolder && entry.folderHandle && typeof fsaaActivateHandle === 'function') {
      return fsaaActivateHandle(entry.folderHandle);
    }
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
      types: (typeof dataPickerTypes === 'function') ? dataPickerTypes() : undefined,
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

function saveToRecents(file, handle, isPacked) {
  var key = recentKey(file);
  var entry = {
    name: file.name,
    size: file.size,
    handle: handle || null,
    packed: !!isPacked, // packed project archive — carries its own config
    lastOpened: Date.now()
  };
  recentPut(key, entry).catch(function() { /* silent */ });
}

// C11: record a mounted project folder in recents (on-disk project) so it lists
// alongside recent files with a folder badge + one-click reopen.
function saveFolderToRecents(handle) {
  if (!handle || !handle.name) return Promise.resolve();
  return recentPut('folder:' + handle.name, {
    name: handle.name, isFolder: true, folderHandle: handle, lastOpened: Date.now()
  }).then(function() { if (typeof renderRecentFiles === 'function') renderRecentFiles(); }).catch(function() {});
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

// A9-1: force every column's type from the preflight sample (+ user
// overrides) — the worker then skips its detection warmup entirely, so no
// row is excluded from stats (zero row loss; the aux pass has worked this
// way from the start). Falls back to user overrides alone when preflight
// sampling is unavailable (worker detection + replay still covers that).
function fullTypeOverrides() {
  if (!preflightData || !preflightData.autoTypes) return currentTypeOverrides || null;
  var full = {};
  for (var i = 0; i < preflightData.autoTypes.length; i++) full[i] = preflightData.autoTypes[i];
  if (currentTypeOverrides) for (var k in currentTypeOverrides) full[k] = currentTypeOverrides[k];
  return full;
}

function analysisFingerprint() {
  return JSON.stringify({
    filter: currentFilter,
    typesFrom: 'preflight', // A9-1 marker — invalidates pre-zero-row-loss caches once
    typeOverrides: currentTypeOverrides || null,
    skipCols: currentSkipCols || null,
    colFilters: currentColFilters || null,
    zipEntry: currentZipEntry || null,
    calcolCode: currentCalcolCode || '',
    calcolMeta: currentCalcolMeta || [],
    groupBy: currentGroupBy,
    groupStatsCols: currentGroupBy !== null && statsCatSelectedVars.size > 0 ? Array.from(statsCatSelectedVars).sort() : null,
    weight: catRole('model', 'weight')
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
// R5: project-based UUID identity. BMA is project-oriented, not file-oriented — every
// fresh project (model-backed or not) gets its own id, so two projects on the same
// model file are distinct (no registry collision) and re-dropping a file starts a NEW
// project rather than implicitly resuming one (resume via the project manager). LEGACY
// projects predating this carry id:null and stay file-keyed, so they remain openable.
function currentProjectKey() {
  if (currentProjectId) return 'bma:proj:' + currentProjectId;
  if (currentFile) return projectKey(currentFile);
  return null;
}

// A10 phase 4e-b: serialize the comparison-dataset instances (d2, d3…) — same
// config shape as the legacy `aux` block plus the stable id, which re-keys the
// panel selection state on restore. aux itself keeps its own block. Only
// file-backed instances are persisted (matched by name+size on reload, like
// aux/drillholes); the analysis result is re-derived, never stored.
function serializeComparisonDatasets() {
  var out = [], seen = {};
  for (var i = 2; i < datasets.length; i++) {
    var ds = datasets[i];
    if (!ds.file) continue;
    seen[ds.id] = true;
    out.push({
      id: ds.id,
      fileName: ds.file.name,
      fileSize: ds.file.size,
      prefix: ds.prefix,
      gridMode: ds.gridMode || null,   // A10 4f-2: grid override (null = default 'auto')
      xyz: ds.preflight ? ds.preflight.xyz : null,
      zipEntry: ds.preflight ? (ds.preflight.selectedZipEntry || null) : null,
      filter: ds.filter ? ds.filter.expression : '',
      calcolCode: ds.calcolCode,
      calcolMeta: ds.calcolMeta,
      // Declus params only — weights are recomputed, never stored
      declus: (ds.declus && ds.declus.params) ? { params: ds.declus.params } : null,
      topcut: (ds.topcut && ds.topcut.varName) ? { varName: ds.topcut.varName, cap: ds.topcut.cap, xlog: !!ds.topcut.xlog, useDeclus: !!ds.topcut.useDeclus } : null,
      statsCat: statsCatSerializeFor(ds),   // A10 G4a-3: per-dataset StatsCat selection (by name)
      export: exportSerializeFor(ds),       // A10 G5a-3: per-dataset Export column selection (by name)
      derivedFrom: ds.derivedFrom || undefined,   // A11 emit: re-derive from the parent set on reload (no own file)
      materialized: ds.materialized || undefined, // C11-P2: a frozen snapshot (folder file or embedded csv) — load it instead of re-deriving, link kept
      view: ds.view
    });
  }
  // Loss-safety: an instance whose file hasn't been re-supplied yet (restored
  // but awaiting its re-drop) has no live config to emit — re-emit its pending
  // saved config verbatim so an autosave mid-restore never drops it.
  if (typeof pendingDatasetsRestore !== 'undefined' && pendingDatasetsRestore) {
    Object.keys(pendingDatasetsRestore).forEach(function(id) {
      if (!seen[id]) out.push(pendingDatasetsRestore[id]);
    });
  }
  return out;
}

// A10 phase 4e-b: serialize the cross-dataset panel state (4c chips, 4d Δ%
// reference, table/CDF selection) uniformly across every comparison dataset
// (aux + d2+). Column selection is stored by NAME (survives reordering and
// matches the legacy auxSelected convention); datasets and the reference are
// stored by id. A null cmpSel entry = "that dataset's default (paired only)",
// so it is omitted; an explicit empty selection serializes as [].
function serializePanelState() {
  function selByName(map, pending) {
    var o = {};
    Object.keys(map).forEach(function(dsId) {
      var sel = map[dsId];
      if (sel == null) return;                       // default — restore re-derives
      var ds = dsById(dsId);
      var hdr = ds && ds.complete && ds.complete.header;
      if (!hdr) return;                              // not analyzed — nothing to map
      o[dsId] = Array.from(sel).map(function(idx) { return hdr[idx]; }).filter(Boolean);
    });
    // Loss-safety: a dataset awaiting reattach (file/analysis not back yet) still
    // has its selection as names in pendingPanelState — re-emit until consumed.
    if (pending) Object.keys(pending).forEach(function(dsId) { if (!(dsId in o)) o[dsId] = pending[dsId]; });
    return o;
  }
  var pps = (typeof pendingPanelState !== 'undefined' && pendingPanelState && pendingPanelState.statistics) ? pendingPanelState.statistics : null;
  return {
    statistics: {
      cmpSel: selByName(panelState.statistics.cmpSel, pps && pps.cmpSel),
      cdfCmpSel: selByName(panelState.statistics.cdfCmpSel, pps && pps.cdfCmpSel),
      dsHidden: Array.from(panelState.statistics.dsHidden),
      refDs: panelState.statistics.refDs,           // 4d per-panel reference (no global star), by id
      instances: (typeof statSerializeInstances === 'function') ? statSerializeInstances() : []   // st-5: cloned Statistics panels
    },
    swath: {
      dsHidden: Array.from(panelState.swath.dsHidden),
      instances: (typeof swSerializeInstances === 'function') ? swSerializeInstances() : []
    },
    categories: {
      dsHidden: Array.from(panelState.categories.dsHidden),
      instances: (typeof serializeCatInstances === 'function') ? serializeCatInstances() : []
    },
    gt: {
      instances: (typeof gtSerializeInstances === 'function') ? gtSerializeInstances() : []   // A10 G3b: cloned GT panels
    },
    statscat: {
      instances: (typeof statsCatSerializeInstances === 'function') ? statsCatSerializeInstances() : []   // A10 G4b: cloned StatsCat panels
    },
    exportp: {
      instances: (typeof exportSerializeInstances === 'function') ? exportSerializeInstances() : []   // A10 G5b: cloned Export panels
    },
    crosstab: {
      instances: (typeof crosstabSerializeInstances === 'function') ? crosstabSerializeInstances() : []   // A19-clone: cloned Cross-tab panels
    }
  };
}

function serializeProject() {
  return {
    _bma: 1,
    _ts: Date.now(),
    id: currentProjectId,   // R5: every project's own UUID identity (model-backed too); null only for legacy file-keyed projects
    title: projectTitle,
    surfaceTitles: (typeof surfaceTitles !== 'undefined' && Object.keys(surfaceTitles).length) ? surfaceTitles : undefined,   // C10: user-named views
    activeTab: document.querySelector('.results-tab.active')?.dataset.tab || null,
    modelView: (typeof modelView !== 'undefined') ? modelView : 'preview',   // ws-v2 phase 2: Import Model panel's right-pane view
    file: currentFile ? { name: currentFile.name, size: currentFile.size } : null,
    preflight: {
      typeOverrides: preflightData?.typeOverrides || {},
      skipCols: preflightData ? Array.from(preflightData.skipCols) : [],
      colFilters: preflightData?.colFilters || {},
      xyz: preflightData?.xyz || { x: -1, y: -1, z: -1 },
      dxyz: preflightData?.dxyz || { dx: -1, dy: -1, dz: -1 },
      gridMode: currentGridMode,   // A10 4f-2: grid override (null = default 'grid')
      selectedZipEntry: preflightData?.selectedZipEntry || null
    },
    aux: auxFile ? {
      fileName: auxFile.name,
      fileSize: auxFile.size,
      prefix: auxPrefix,
      gridMode: auxGridMode,   // A10 4f-2: grid override (null = default 'auto')
      xyz: auxPreflightData ? auxPreflightData.xyz : null,
      zipEntry: auxPreflightData ? (auxPreflightData.selectedZipEntry || null) : null,
      filter: auxFilter ? auxFilter.expression : '',
      calcolCode: auxCalcolCode,
      calcolMeta: auxCalcolMeta,
      // Declus params only — weights are recomputed, never stored
      declus: (auxDeclus && auxDeclus.params) ? { params: auxDeclus.params } : null,
      // Top-cut: variable + cap + scale + weight mode; the distribution is re-loaded on demand
      topcut: (auxTopcut && auxTopcut.varName) ? { varName: auxTopcut.varName, cap: auxTopcut.cap, xlog: !!auxTopcut.xlog, useDeclus: !!auxTopcut.useDeclus } : null,
      statsCat: statsCatSerializeFor(dsById('aux')),   // A10 G4a-3: per-dataset StatsCat selection (by name)
      export: exportSerializeFor(dsById('aux')),       // A10 G5a-3: per-dataset Export column selection (by name)
      view: auxView
    } : null,
    calcolCode: currentCalcolCode,
    calcolMeta: currentCalcolMeta,
    // Property catalog — colors, units, roles, pairings (one key replaces
    // the pre-C1a globalUnits / categories.* / swath color+unit / weight keys)
    catalog: (function() {
      catCompact();
      catalog.datasets.aux.label = auxPrefix || 'aux';
      return JSON.parse(JSON.stringify(catalog));
    })(),
    filter: currentFilter,
    filterText: $filterExpr.value,
    statsCat: {
      targetDsId: statsCatTargetDsId,
      groupBy: currentGroupBy,
      selectedVars: Array.from(statsCatSelectedVars),
      sortMode: statsCatGroupSortMode,
      cdfScale: statsCatCdfScale,
      cdfManual: statsCatCdfManual,
      cdfMin: statsCatCdfMin,
      cdfMax: statsCatCdfMax,
      crossMode: statsCatCrossMode,
      displayVar: currentStatsCatVar,
      checkedGroups: currentStatsCatChecked ? Array.from(currentStatsCatChecked) : null,
      showSelectedOnly: statsCatShowSelectedOnly
    },
    statsTab: {
      targetDsId: (typeof statsTargetDsId !== 'undefined') ? statsTargetDsId : 'model',   // ws-v2 phase 1: per-panel primary dataset
      selectedVars: statsSelectedVars ? Array.from(statsSelectedVars) : null,
      visibleMetrics: statsVisibleMetrics ? Array.from(statsVisibleMetrics) : null,
      percentiles: statsPercentiles,
      cdfSelected: Array.from(statsCdfSelected),
      cdfScale: statsCdfScale,
      cdfMode: statsCdfMode,
      cdfPaneH: (typeof statsCdfPaneH !== 'undefined') ? statsCdfPaneH : null,   // draggable split height
      // Persistence covers model + aux today (A10 4c-ii); d2+ stats selection
      // is ephemeral until phase 6 takes over the datasets key.
      auxSelected: (auxCompleteData && panelState.statistics.cmpSel.aux != null)
        ? Array.from(panelState.statistics.cmpSel.aux).map(function(i) { return auxCompleteData.header[i]; }).filter(Boolean) : null,
      cdfAuxSelected: (auxCompleteData && panelState.statistics.cdfCmpSel.aux && panelState.statistics.cdfCmpSel.aux.size > 0)
        ? Array.from(panelState.statistics.cdfCmpSel.aux).map(function(i) { return auxCompleteData.header[i]; }).filter(Boolean) : null
    },
    categories: (function() {
      // ws-v2 phase 1: persist the per-panel target + focusedCol BY NAME against
      // the target's header (model = currentHeader → unchanged for the model case).
      var tid = (panelState.categories.catTargetDsId) || 'model';
      var hdr = (tid === 'model') ? currentHeader : (((dsById(tid) || {}).complete || {}).header || null);
      var fc = panelState.categories.focusedCol;
      return {
        targetDsId: tid,
        focusedCol: (fc !== null && hdr && hdr[fc]) ? hdr[fc] : null
      };
    })(),
    // A19: cross-tab selections — target + the two columns BY NAME + cell display
    crosstab: (function() {
      var tid = (typeof crosstabTargetDsId !== 'undefined') ? (crosstabTargetDsId || 'model') : 'model';
      var hdr = (tid === 'model') ? currentHeader : (((dsById(tid) || {}).complete || {}).header || null);
      return {
        targetDsId: tid,
        colA: (crosstabColA != null && hdr && hdr[crosstabColA]) ? hdr[crosstabColA] : null,
        colB: (crosstabColB != null && hdr && hdr[crosstabColB]) ? hdr[crosstabColB] : null,
        weightCol: (typeof crosstabWeightCol !== 'undefined' && crosstabWeightCol != null && hdr && hdr[crosstabWeightCol]) ? hdr[crosstabWeightCol] : null,
        view: (typeof crosstabView !== 'undefined') ? crosstabView : 'table',
        barMode: (typeof crosstabBarMode !== 'undefined') ? crosstabBarMode : 'stacked',
        cellMode: (typeof crosstabCellMode !== 'undefined') ? crosstabCellMode : 'count'
      };
    })(),
    tree: { open: catalogTreeOpen },
    // C6-4a collapsed control sidebars (per-panel) + C6-4b collapsed sections
    sidebars: {
      collapsed: (typeof SIDEBAR_COLLAPSED !== 'undefined') ? Array.from(SIDEBAR_COLLAPSED) : [],
      sections: (typeof SB_SECTIONS !== 'undefined') ? Object.assign({}, SB_SECTIONS) : {}
    },
    // Rails workspace arrangement (C1b-2) — {v:1, rails: <serialized state>}
    layout: wsSerializeLayout(),
    // Drillhole-set recipe (A7 Phase 2, D8) — file identities + mapping +
    // options; the derived composite CSV is never persisted (re-derived)
    drillholes: dhSerializeAll(),
    exportTargetDsId: exportTargetDsId,   // A10 G5a-3: which dataset the Export tab targets
    exportCols: exportColumns.map(c => ({
      name: c.name, outputName: c.outputName, selected: c.selected
    })),
    exportSettings: {
      delimiter: exportDelimiter,
      includeHeader: exportIncludeHeader,
      commentHeader: exportCommentHeader,
      commentText: exportCommentText,
      quoteChar: exportQuoteChar,
      lineEnding: exportLineEnding,
      nullValue: exportNullValue,
      precision: exportPrecision,
      decimalSep: exportDecimalSep
    },
    swath: (function() {
      var $dirMode = document.getElementById('swathDirMode');
      var $stat = document.getElementById('swathStat');
      var $filter = document.getElementById('swathLocalFilter');
      if (!$dirMode) return null;
      // ws-v2 phase 1: primary var names resolve against the TARGET header.
      var swPrimHeader = (typeof swathCtx === 'function' && swathCtx().header) || currentHeader || [];
      var checkedVars = [];
      document.querySelectorAll('#swathVarList input[type="checkbox"]:checked').forEach(function(cb) {
        var colIdx = parseInt(cb.value);
        var name = swPrimHeader[colIdx];
        if (name) checkedVars.push(name);
      });
      var swathAuxChecked = null;
      if (auxFile) {
        // Persistence covers the model + aux today; d2+ swath selection is
        // ephemeral until A10 phase 6, so scope this to aux's own rows
        // (avoids restoring a d2 name onto aux when column names collide).
        swathAuxChecked = [];
        document.querySelectorAll('#swathVarList input[data-aux="1"][data-ds="aux"]:checked').forEach(function(cb) {
          if (cb.dataset.name) swathAuxChecked.push(cb.dataset.name);
        });
      }
      var swathDirs = {};
      document.querySelectorAll('#swathSidebar .swath-dir-on').forEach(function(cb) {
        var k = cb.dataset.dir;
        var bin = parseFloat((document.getElementById('swathBin_' + k) || {}).value);
        swathDirs[k] = { on: cb.checked, bin: isFinite(bin) ? bin : null };
      });
      return {
        targetDsId: (typeof swathTargetDsId !== 'undefined') ? swathTargetDsId : 'model',   // ws-v2 phase 1
        dirMode: $dirMode.value,
        directions: swathDirs,
        dipDir: parseFloat((document.getElementById('swathDipDir') || {}).value) || 0,
        dip: parseFloat((document.getElementById('swathDip') || {}).value) || 0,
        rake: (function() { var v = parseFloat((document.getElementById('swathRake') || {}).value); return isFinite(v) ? v : 90; })(),
        stat: $stat ? $stat.value : 'mean_std',
        checkedVars: checkedVars,
        localFilter: $filter ? $filter.value : '',
        auxCheckedVars: swathAuxChecked,
        display: {
          showBands: document.getElementById('swathShowBands') ? document.getElementById('swathShowBands').checked : true,
          showCounts: document.getElementById('swathShowCounts') ? document.getElementById('swathShowCounts').checked : true,
          showTable: document.getElementById('swathShowTable') ? document.getElementById('swathShowTable').checked : true,
          yScale: (document.getElementById('swathYScale') || {}).value || 'linear',
          layout: (document.getElementById('swathLayout') || {}).value || 'overlay'
        }
      };
    })(),
    gt: (function() {
      var varList = document.getElementById('gtVarList');
      if (!varList) return null;
      var checked = varList.querySelectorAll('input[type="checkbox"]:checked');
      var gradeCols = [];
      for (var ci = 0; ci < checked.length; ci++) gradeCols.push(checked[ci].parentElement.querySelector('span').textContent);
      var mode = 'range';
      var modeRadio = document.querySelector('input[name="gtCutoffMode"]:checked');
      if (modeRadio) mode = modeRadio.value;
      var gb = document.getElementById('gtGroupBy');
      return {
        gradeCols: gradeCols,
        groupByCol: gb && gb.value !== '-1' && gb.options[gb.selectedIndex] ? gb.options[gb.selectedIndex].textContent : null,
        densityCol: (function() { var d = document.getElementById('gtDensityCol'); return d && d.value !== '-1' && d.value !== 'const' && d.options[d.selectedIndex] ? d.options[d.selectedIndex].textContent : null; })(),
        densityConst: (function() { var d = document.getElementById('gtDensityCol'); var c = document.getElementById('gtDensityConst'); return d && d.value === 'const' && c ? (parseFloat(c.value) || null) : null; })(),
        weightCol: (function() { var w = document.getElementById('gtWeightCol'); return w && w.value !== '-1' && w.options[w.selectedIndex] ? w.options[w.selectedIndex].textContent : null; })(),
        localFilter: (document.getElementById('gtLocalFilter') || {}).value || '',
        cutoffMode: mode,
        cutoffMin: parseFloat((document.getElementById('gtCutoffMin') || {}).value) || 0,
        cutoffMax: parseFloat((document.getElementById('gtCutoffMax') || {}).value) || 1,
        cutoffStep: parseFloat((document.getElementById('gtCutoffStep') || {}).value) || 0.05,
        cutoffCustom: (document.getElementById('gtCutoffCustomText') || {}).value || '',
        volumeOverride: parseFloat((document.getElementById('gtVolOverride') || {}).value) || null,
        tonnageUnit: parseInt((document.getElementById('gtTonnageUnit') || {}).value) || 0,
        customTonnageSym: (document.getElementById('gtCustomTonnageSym') || {}).value || '',
        customTonnageDiv: parseFloat((document.getElementById('gtCustomTonnageDiv') || {}).value) || null,
        metalUnit: parseInt((document.getElementById('gtMetalUnit') || {}).value) || 0,
        customMetalSym: (document.getElementById('gtCustomMetalSym') || {}).value || '',
        customMetalDiv: parseFloat((document.getElementById('gtCustomMetalDiv') || {}).value) || null,
        tonnageDp: (document.getElementById('gtTonnageDp') || {}).value || '',
        gradeDp: (document.getElementById('gtGradeDp') || {}).value || '',
        metalDp: (document.getElementById('gtMetalDp') || {}).value || '',
        theoEnabled: !!(document.getElementById('gtTheoEnabled') || {}).checked,
        theoEngine: (document.getElementById('gtTheoEngine') || {}).value || 'affine',
        theoF: parseFloat((document.getElementById('gtTheoFNum') || {}).value) || 0.6,
        theoDsId: (typeof gtTheoDsId !== 'undefined') ? gtTheoDsId : null,   // G2: theoretical-curve source dataset
        targetDsId: (typeof gtTargetDsId !== 'undefined') ? gtTargetDsId : 'model',   // G3: the dataset GT analyzes
        selectedGroups: (function() {
          var list = document.getElementById('gtGrpList');
          if (!list) return null;
          var checked = [];
          var hasTotal = false;
          list.querySelectorAll('input:checked').forEach(function(cb) {
            if (cb.value === '__total__') hasTotal = true;
            else checked.push(cb.value);
          });
          return { values: checked, showTotal: hasTotal };
        })()
      };
    })(),
    // A10 phase 4e-b: comparison datasets beyond aux (d2, d3…) and the
    // cross-dataset panel selection/chip/reference state. aux keeps its own
    // `aux` block + the legacy statsTab.auxSelected; these cover the instance
    // datasets and unify the per-panel state (4c chips, 4d Δ% reference, d2+
    // table/CDF selection) the panels left ephemeral until now.
    datasets: serializeComparisonDatasets(),
    panels: serializePanelState()
  };
}

function autoSaveProject() {
  // Every config mutation funnels through here (new-tab checklist), which
  // makes it the one hook the catalog tree needs to stay current
  refreshCatalogTree();
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    // Model-backed needs a preflight before there's anything to save; model-less
    // projects save from creation. Key resolves via the dual-key currentProjectKey().
    var key = currentProjectKey();
    if (!key || (currentFile && !preflightData)) return;
    var ser = JSON.stringify(serializeProject());
    try {
      localStorage.setItem(key, ser);
    } catch (e) { /* quota — silent fail */ }
    // C11-P1: a mounted project folder also gets the JSON written into it. R2:
    // a write FAILURE (permission revoked, disk) must not be swallowed — surface it,
    // else the user keeps editing thinking it's saved when it isn't (silent loss).
    if (typeof mountedFolder !== 'undefined' && mountedFolder && typeof fsaaWriteProjectJson === 'function') {
      Promise.resolve(fsaaWriteProjectJson(ser)).then(function (folderOk) {
        if (folderOk === false) showSaveBeat(false, 'Autosave failed — project folder not writable');
      });
    }
    if (typeof projTouchCurrent === 'function') projTouchCurrent();   // C14: keep the registry fresh
  }, 2000);
}

// Shared "Saved ✓" / "Save failed" toast (red + longer when failed).
function showSaveBeat(saved, msg) {
  var beat = document.getElementById('saveBeat');
  if (!beat) return;
  beat.textContent = msg;
  beat.style.color = saved ? 'var(--green)' : 'var(--red)';
  beat.classList.add('on');
  clearTimeout(flushProjectSave._t);
  flushProjectSave._t = setTimeout(function () { beat.classList.remove('on'); }, saved ? 1400 : 4500);
}

// C6-2: File → Save (Ctrl+S) — flush the continuous autosave immediately and
// flash a peace-of-mind "Saved ✓" beat. Same write the debounced timer does.
function flushProjectSave() {
  var key = currentProjectKey();
  if (!key || (currentFile && !preflightData)) return;
  clearTimeout(autoSaveTimer);
  var localOk = false;
  var ser = JSON.stringify(serializeProject());
  try {
    localStorage.setItem(key, ser);
    localOk = true;
  } catch (e) { /* quota — surfaced below */ }
  if (typeof projTouchCurrent === 'function') projTouchCurrent();   // C14: keep the registry fresh
  // R2: gate the "Saved ✓" beat on the FOLDER write too — don't report success
  // when the backing write actually failed (silent edit loss on reopen).
  var folderP = (typeof mountedFolder !== 'undefined' && mountedFolder && typeof fsaaWriteProjectJson === 'function')
    ? Promise.resolve(fsaaWriteProjectJson(ser)) : Promise.resolve(true);
  folderP.then(function (folderOk) {
    var saved = localOk && folderOk !== false;
    showSaveBeat(saved, saved ? 'Saved ✓' : (folderOk === false ? 'Save failed — project folder not writable' : 'Save failed'));
  });
}

async function applyProject(project) {
  if (!project || !project._bma) return;

  currentProjectId = project.id || null;   // model-optional: restore the dual-key id (null for model-backed)
  projectTitle = project.title || null;
  if (typeof surfaceTitles !== 'undefined') surfaceTitles = project.surfaceTitles || {};   // C10: user-named views
  updateProjectTitleDisplay();

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
    if (pf.gridMode !== undefined) currentGridMode = pf.gridMode;   // A10 4f-2
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

  // Restore the property catalog — new projects carry it whole; pre-C1a
  // projects are migrated from their scattered keys
  catalog = newCatalog();
  if (project.catalog) {
    if (project.catalog.datasets) catalog.datasets = project.catalog.datasets;
    if (project.catalog.roles) catalog.roles = project.catalog.roles;
    if (project.catalog.properties) {
      // A10 4a: native properties format
      catalog.properties = project.catalog.properties;
      catReindexProps();
    } else if (project.catalog.vars || project.catalog.pairs) {
      // C1a-era catalog (vars + pairs) → properties
      catImportLegacyVarsPairs(project.catalog.vars, project.catalog.pairs);
    }
    if (!catalog.datasets.aux) catalog.datasets.aux = { label: 'aux' };
    if (!catalog.roles.model) catalog.roles.model = {};
    if (!catalog.roles.aux) catalog.roles.aux = {};
  } else {
    migrateLegacyCatalog(project);
  }

  // Restore tree panel state (null = viewport default); on the rails shell
  // the coalesced re-render also re-aligns the tree rail's collapsed state
  catalogTreeOpen = (project.tree && project.tree.open !== undefined) ? project.tree.open : null;
  refreshCatalogTree();

  // C6-4a: restore collapsed control sidebars
  if (typeof wsApplySidebarCollapsed === 'function') {
    wsApplySidebarCollapsed(project.sidebars && project.sidebars.collapsed);
  }
  // C6-4b: restore collapsed sidebar sections (applied at next render)
  if (typeof wsApplySidebarSections === 'function') {
    wsApplySidebarSections(project.sidebars && project.sidebars.sections);
  }

  // A10 4e-c-5: recreate cloned Categories instances (state by NAME) BEFORE the
  // layout deserialize rebuilds their tabs (renderPanel → catBuildInstancePanel
  // reads the state seeded here). wsSanitizeLayout keeps an instance tab only once
  // its state exists, so this must precede wsRestoreProjectLayout. The focused
  // column resolves to an index when the analysis lands (catRenderInstance).
  if (typeof catRestoreInstances === 'function') {
    catRestoreInstances(project.panels && project.panels.categories && project.panels.categories.instances);
  }
  // A10 Swath s-5: same dance for cloned Swath instances — recreate them (config
  // pending) before the layout deserialize rebuilds their tabs; the config is
  // re-applied once the analysis lands (swApplyAllInstances in displayResults).
  if (typeof swRestoreInstances === 'function') {
    swRestoreInstances(project.panels && project.panels.swath && project.panels.swath.instances);
  }
  // A10 Statistics st-5: same — recreate cloned Statistics instances (view pending)
  // before the layout deserialize; resolved post-analysis by statApplyAllInstances.
  if (typeof statRestoreInstances === 'function') {
    statRestoreInstances(project.panels && project.panels.statistics && project.panels.statistics.instances);
  }
  // A10 G3b: same — recreate cloned GT instances (config pending) before the
  // layout deserialize; resolved post-analysis by gtApplyAllInstances.
  if (typeof gtRestoreInstances === 'function') {
    gtRestoreInstances(project.panels && project.panels.gt && project.panels.gt.instances);
  }
  // A10 G4b: same — recreate cloned StatsCat instances (target) before the layout
  // deserialize; each repaints once its dataset's group stats are available.
  if (typeof statsCatRestoreInstances === 'function') {
    statsCatRestoreInstances(project.panels && project.panels.statscat && project.panels.statscat.instances);
  }
  // A10 G5b: same — recreate cloned Export instances (target) before the layout
  // deserialize; each repaints once its dataset's columns are available.
  if (typeof exportRestoreInstances === 'function') {
    exportRestoreInstances(project.panels && project.panels.exportp && project.panels.exportp.instances);
  }
  // A19-clone: same — recreate cloned Cross-tab instances (config pending) before
  // the layout deserialize; resolved post-analysis by crosstabApplyAllInstances.
  if (typeof crosstabRestoreInstances === 'function') {
    crosstabRestoreInstances(project.panels && project.panels.crosstab && project.panels.crosstab.instances);
  }
  // Phase 6: register comparison-dataset instances (d2+) in the registry NOW —
  // before the layout deserialize — so wsSanitizeLayout keeps their tabs at the
  // SAVED dock position instead of dropping them (displayResults would re-add at
  // the default spot). Registry only (skipTab); the file + full config restore
  // still happens in displayResults via the same wsRestoreInstance(cfg).
  if (typeof wsRestoreInstance === 'function') {
    (project.datasets || []).forEach(function(cfg) { wsRestoreInstance(cfg, true); });
  }

  // Restore the rails workspace arrangement (missing/invalid → default)
  wsRestoreProjectLayout(project.layout);

  // Restore filter
  currentFilter = project.filter || null;
  $filterExpr.value = project.filterText || '';

  // Restore StatsCat groupBy + selectedVars NOW (before executeAnalysis)
  // so the worker includes grouped stats in its analysis (the analysis
  // weight rides in the catalog, restored above)
  const sc = project.statsCat || {};
  if (sc.groupBy != null) currentGroupBy = sc.groupBy;
  if (sc.selectedVars) statsCatSelectedVars = new Set(sc.selectedVars);
  // G4a-3: which dataset the StatsCat tab targets (self-heals if it never reloads)
  statsCatTargetDsId = sc.targetDsId || 'model';
  // G5a-3: which dataset the Export tab targets (model columns still build at
  // displayResults; a non-model target applies lazily when its analysis lands)
  exportTargetDsId = project.exportTargetDsId || 'model';

  // Stash aux config; applied when the aux file is (re)loaded on the Aux tab
  pendingAuxRestore = project.aux || null;

  // Drillhole-set recipe — applies when its three files land on the card
  // (a re-derived composite CSV then matches pendingAuxRestore by name)
  // A10 phase 5: `drillholes` is a per-dataset map { dsId: recipe }; a legacy
  // single-set project wrote a flat recipe (has .files) → normalize to { aux }.
  // The aux set restores here; d2+ sets restore in the displayResults datasets
  // loop, once their instances exist (same normalize there).
  var dhMap = project.drillholes || null;
  if (dhMap && dhMap.files) dhMap = { aux: dhMap };
  dhRestoreFromProject(dsById('aux'), dhMap ? (dhMap.aux || null) : null);

  // Stash remaining post-analysis config for when displayResults runs
  pendingProjectRestore = project;
}

// Build the catalog from a pre-C1a project's scattered keys. Precedence
// for units: globalUnits < swath.units < gt.gradeUnits (later wins);
// support weight: statsTab.weight wins over swath.weight.
function migrateLegacyCatalog(project) {
  const cats = project.categories || {};
  for (const col of Object.keys(cats.sortModes || {})) catVar('model', col).sortMode = cats.sortModes[col];
  for (const col of Object.keys(cats.customOrders || {})) catVar('model', col).valueOrder = cats.customOrders[col].slice();
  for (const col of Object.keys(cats.colorOverrides || {})) catVar('model', col).valueColors = Object.assign({}, cats.colorOverrides[col]);

  const units = Object.assign({}, project.globalUnits || {},
    (project.swath && project.swath.units) || {},
    (project.gt && project.gt.gradeUnits) || {});
  for (const col of Object.keys(units)) catSetUnit('model', col, units[col]);
  const auxUnits = (project.swath && project.swath.auxUnits) || {};
  for (const an of Object.keys(auxUnits)) catSetUnit('aux', an, auxUnits[an]);

  const swColors = (project.swath && project.swath.colorOverrides) || {};
  for (const k of Object.keys(swColors)) {
    if (k.indexOf('aux:') === 0) catVar('aux', k.slice(4)).color = swColors[k];
    else catVar('model', k).color = swColors[k];
  }

  const w = (project.statsTab && project.statsTab.weight) || (project.swath && project.swath.weight) || null;
  if (w) catSetRole('model', 'weight', w);
  if (project.gt && project.gt.densityCol) catSetRole('model', 'density', project.gt.densityCol);
  if (project.gt && project.gt.weightCol) catSetRole('model', 'tonnageFactor', project.gt.weightCol);
  if (project.aux && project.aux.weight) catSetRole('aux', 'weight', project.aux.weight);
  if (project.aux && project.aux.prefix) catalog.datasets.aux.label = project.aux.prefix;
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

// ── Pack project (dialog + pipeline) ──────────────────────────────────
// Bundles the data file(s) + project json into one portable zip. Data blobs
// are referenced, never copied; the read pass (CRC + optional deflate via
// CompressionStream) runs in a worker so the UI never stalls. The writer
// emits Zip64 records automatically, so archive size is not a ceiling.

function updateProjectTitleDisplay() {
  if (!currentFile) return;
  $resultsFilename.textContent = (projectTitle ? projectTitle + ' — ' : '') + currentFile.name;
}

// Easy project rename (File ▸ Rename project… or click the header title). The
// title shows in the header and names the packed archive; it was previously only
// settable inside the Pack dialog.
function renameProjectPrompt() {
  if (!currentFile) return;
  bmaConfirm({
    title: 'Rename project',
    html: '<p style="margin:0 0 0.6rem;color:var(--fg-dim);font-size:0.78rem">Shown in the header and used to name the packed archive (§14). Leave empty to use just the file name.</p>' +
      '<input id="renameProjectInput" type="text" maxlength="80" placeholder="Project title" value="' + esc(projectTitle || '') +
      '" style="width:100%;box-sizing:border-box;padding:0.4rem 0.55rem;font:inherit;background:var(--bg1);color:var(--fg);border:1px solid var(--border);border-radius:4px">',
    okLabel: 'Rename'
  }).then(function(ok) {
    var el = document.getElementById('renameProjectInput');
    if (!ok || !el) return;
    projectTitle = el.value.trim() || null;
    updateProjectTitleDisplay();
    if (typeof projRenameCurrent === 'function') projRenameCurrent(projectTitle);   // R10: explicit rename updates the registry title
    if (typeof autoSaveProject === 'function') autoSaveProject();
  });
  setTimeout(function() { var el = document.getElementById('renameProjectInput'); if (el) { el.focus(); el.select(); } }, 40);
}
// Click the header title to rename (only meaningful once a project is loaded).
if ($resultsFilename) {
  $resultsFilename.style.cursor = 'pointer';
  $resultsFilename.title = 'Click to rename project';
  $resultsFilename.addEventListener('click', function() { if (currentFile) renameProjectPrompt(); });
}

function openPackModal() {
  if (!currentFile && !currentProjectId) return;   // nothing to pack
  if (currentFile && !preflightData) return;       // model-backed needs preflight first
  var $m = document.getElementById('packModal');
  document.getElementById('packTitle').value = projectTitle || '';
  document.getElementById('packModelName').textContent = currentFile
    ? currentFile.name + ' (' + formatBytes(currentFile.size) + ')'
    : '(no model — comparison datasets only)';
  // A10 4e-b-iii: the include-comparison row now covers EVERY comparison
  // dataset (aux + the d2+ instances), so a packed project round-trips them all.
  var $auxRow = document.getElementById('packAuxRow');
  var auxPackSize = 0;
  var cmpLabels = [];
  var cmpNames = {};
  if (currentFile) cmpNames[currentFile.name] = true;
  if (auxFile && (!currentFile || auxFile.name !== currentFile.name)) {
    if (dhIsDerivedAux(dsById('aux'))) {
      // D8: the raw trio rides the pack; the recipe re-derives the composites
      var trio = dhPackFiles(dsById('aux'));
      auxPackSize += trio[0].size + trio[1].size + trio[2].size;
      trio.forEach(function(f) { cmpNames[f.name] = true; });
      cmpLabels.push('drillhole set: ' + trio.map(function(f) { return f.name; }).join(' + ') +
        ' (' + formatBytes(trio[0].size + trio[1].size + trio[2].size) + ' — composites re-derive on load)');
    } else {
      auxPackSize += auxFile.size;
      cmpNames[auxFile.name] = true;
      cmpLabels.push(auxFile.name + ' (' + formatBytes(auxFile.size) + ')');
    }
  }
  for (var pdi = 2; pdi < datasets.length; pdi++) {
    var pds = datasets[pdi];
    if (pds.derivedFrom) continue;   // A11 emit: re-derives from its parent set — not a packed file
    if (!pds.file || cmpNames[pds.file.name]) continue;
    cmpNames[pds.file.name] = true;
    auxPackSize += pds.file.size;
    cmpLabels.push((pds.prefix ? pds.prefix + ': ' : '') + pds.file.name + ' (' + formatBytes(pds.file.size) + ')');
  }
  if (cmpLabels.length) {
    $auxRow.style.display = '';
    document.getElementById('packAuxName').innerHTML = cmpLabels.map(esc).join('<br>');
    document.getElementById('packIncAux').checked = true;
  } else {
    $auxRow.style.display = 'none';
  }
  var $compress = document.getElementById('packCompress');
  var $note = document.getElementById('packNote');
  var totalData = (currentFile ? currentFile.size : 0) + auxPackSize;
  if (typeof CompressionStream === 'undefined') {
    $compress.checked = false;
    $compress.disabled = true;
    $note.textContent = 'Compression unavailable in this browser — packing as stored zip.';
  } else {
    $compress.disabled = false;
    // Default on for moderate sizes; off for huge data where the compressed
    // copy must be materialized (stored entries stay zero-copy)
    $compress.checked = totalData <= 512 * 1024 * 1024;
    $note.textContent = $compress.checked
      ? 'CSV typically shrinks 4–6×. Compressed packs decompress once on load.'
      : 'Off by default for large data: stored entries pack and re-open with no memory cost. Tick to compress anyway.';
  }
  document.getElementById('packGo').disabled = false;
  document.getElementById('packGo').textContent = 'Pack';
  $m.classList.add('active');
}

function closePackModal() {
  document.getElementById('packModal').classList.remove('active');
}

async function runPack() {
  var $go = document.getElementById('packGo');
  var $note = document.getElementById('packNote');
  $go.disabled = true;
  $go.textContent = 'Packing…';
  try {
    projectTitle = document.getElementById('packTitle').value.trim() || null;
    updateProjectTitleDisplay();
    // A10 4e-b-iii: one checkbox governs all comparison data (aux + d2+).
    var includeCmp = !!(document.getElementById('packAuxRow').style.display !== 'none' &&
      document.getElementById('packIncAux').checked);
    var includeAux = !!(includeCmp && auxFile && (!currentFile || auxFile.name !== currentFile.name));
    var compress = !!document.getElementById('packCompress').checked;

    // Unicode-aware slug: \w is ASCII-only and would strip accented letters
    // ("Jatobá" → "Jatob"); keep letters/digits from any script
    var slug = projectTitle ? projectTitle.replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '') : '';
    // Archive/json stem: the model file's name when model-backed, else the title (or 'project')
    var stem = currentFile ? currentFile.name.replace(/\.[^.]+$/, '') : (slug || 'project');
    var json = JSON.stringify(serializeProject(), null, 2);

    // Never re-deflate archives; everything else follows the toggle
    function wantsDeflate(name) { return compress && !/\.zip$/i.test(name); }
    var files = [];
    var packed = {};   // dedup: one archive entry per name
    if (currentFile) {
      files.push({ name: currentFile.name, blob: currentFile, deflate: wantsDeflate(currentFile.name) });
      packed[currentFile.name] = true;
    }
    if (includeAux && dhIsDerivedAux(dsById('aux'))) {
      // D8: pack the raw trio, never the derived composite CSV
      dhPackFiles(dsById('aux')).forEach(function(f) {
        if (packed[f.name]) return;
        packed[f.name] = true;
        files.push({ name: f.name, blob: f, deflate: wantsDeflate(f.name) });
      });
    } else if (includeAux && !packed[auxFile.name]) {
      packed[auxFile.name] = true;
      files.push({ name: auxFile.name, blob: auxFile, deflate: wantsDeflate(auxFile.name) });
    }
    // A10 4e-b-iii: the comparison-dataset instances (d2+) ride along too, so a
    // packed project restores them without a manual re-drop (matched by name on
    // load). Dedup against model/aux/trio — one copy suffices, the reader keys
    // each instance to its own fileName.
    if (includeCmp) {
      for (var fdi = 2; fdi < datasets.length; fdi++) {
        var fds = datasets[fdi];
        if (!fds.file) continue;
        if (fds.derivedFrom) continue;   // A11 emit: re-derives from its parent set (whose trio is packed) — no own file
        if (dhIsDerivedAux(fds)) {
          // A10 p5-3b: a drillhole-derived comparison dataset packs its RAW trio
          // (not the frozen composite), so it re-derives on load like aux (D8).
          dhPackFiles(fds).forEach(function(f) {
            if (!f || packed[f.name]) return;
            packed[f.name] = true;
            files.push({ name: f.name, blob: f, deflate: wantsDeflate(f.name) });
          });
        } else if (!packed[fds.file.name]) {
          packed[fds.file.name] = true;
          files.push({ name: fds.file.name, blob: fds.file, deflate: wantsDeflate(fds.file.name) });
        }
      }
    }
    files.push({ name: stem + '.bma.json', blob: new Blob([json]), deflate: compress });

    var prepared = await new Promise(function(resolve, reject) {
      var w = new Worker(workerUrl);
      w.postMessage({ mode: 'prepare-pack', files: files.map(function(f) { return { blob: f.blob, deflate: f.deflate }; }) });
      w.onerror = function(e) { w.terminate(); reject(new Error(e.message || 'worker error')); };
      w.onmessage = function(e) {
        var m = e.data;
        if (m.type === 'pack-progress') {
          $go.textContent = 'Packing ' + m.percent + '%';
        } else if (m.type === 'pack-prepared') {
          w.terminate();
          resolve(m.results);
        } else if (m.type === 'error') {
          w.terminate();
          reject(new Error(m.message));
        }
      };
    });

    var entries = files.map(function(f, i) {
      var comp = prepared[i].comp;
      return {
        name: f.name,
        crc: prepared[i].crc,
        method: comp ? 8 : 0,
        data: comp || f.blob,
        uncompSize: f.blob.size
      };
    });
    var zipBlob = assembleZip(entries);
    var a = document.createElement('a');
    a.href = URL.createObjectURL(zipBlob);
    a.download = (slug || stem) + '.bma.zip';
    a.click();
    URL.revokeObjectURL(a.href);
    autoSaveProject();
    closePackModal();
  } catch (e) {
    $note.textContent = 'Pack failed: ' + e.message;
  } finally {
    $go.disabled = false;
    $go.textContent = 'Pack';
  }
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
  statsCatGroupSortMode = null;
  statsCatSelectedVars = new Set();
  statsCatCdfScale = 'linear';
  statsCatCdfManual = false;
  statsCatCdfMin = null;
  statsCatCdfMax = null;
  statsCatCrossMode = 'count';
  statsCatShowSelectedOnly = false;
  statsCatTargetDsId = 'model';   // A10 G4a-3: StatsCat target back to the model
  exportTargetDsId = 'model';     // A10 G5a-3: Export target back to the model
  panelState.categories.focusedCol = null;
  catalog = newCatalog();
  panelState.categories.chartShowAll = false;
  statsSelectedVars = null;
  statsVisibleMetrics = null;
  statsPercentiles = [25, 50, 75];
  statsCdfSelected = new Set();
  panelState.statistics.cmpSel = {};
  panelState.statistics.cdfCmpSel = {};
  panelState.statistics.dsHidden = new Set();
  panelState.statistics.refDs = null;
  panelState.swath.dsHidden = new Set();
  panelState.categories.dsHidden = new Set();
  if (typeof catResetInstances === 'function') catResetInstances();  // 4e-c-5: drop cloned Categories panels
  if (typeof swResetInstances === 'function') swResetInstances();    // Swath s-5: drop cloned Swath panels
  if (typeof crosstabResetInstances === 'function') crosstabResetInstances();   // A19-clone: drop cloned Cross-tab panels
  if (typeof statResetInstances === 'function') statResetInstances();  // Statistics st-5: drop cloned Statistics panels
  if (typeof gtResetInstances === 'function') gtResetInstances();      // G3b-4: drop cloned GT panels
  if (typeof statsCatResetInstances === 'function') statsCatResetInstances();  // G4b: drop cloned StatsCat panels
  if (typeof exportResetInstances === 'function') exportResetInstances();      // G5b: drop cloned Export panels
  pendingDatasetsRestore = {};
  pendingPanelState = null;
  statsCdfScale = 'linear';
  statsCdfMode = 'cdf';
  pendingStatsAuxRestore = null;
  projectTitle = null;
  exportColumns = [];
  pendingProjectRestore = null;
  resetExportSettings();
  wsResetLayout(true); // skipSave — clearProject just removed the stored key
  dhResetAll();

  runPreflight(currentFile).then(data => {
    renderPreflight(data);
    setCalcolCode('');
    simulateCalcol();
    markAnalysisStale();
    showPanel('preflight');
  });
}

// Toolbar overflow menu (@gcu/menu dropdown, C1b-3) — factory items so the
// rails-only section and the Panels checkmarks are live on every open
Menu.dropdown($toolbarOverflow, function() {
  const items = [
    { label: 'Open…', action: 'open' },
    { label: 'Save', action: 'saveFlush' },
    '---',
    { label: 'Export project', action: 'save' },
    { label: 'Pack project', action: 'pack' },
    { label: 'Import project', action: 'load' },
    { label: 'Clear project', action: 'clear' },
  ];
  if (wsRails) {
    items.push('---');
    items.push({ label: 'Panels', children: wsPanelsMenuItems });
    items.push({ label: 'Reset layout', action: 'resetLayout' });
  }
  items.push('---');
  items.push({ label: 'Settings', action: 'settings' });
  items.push({ label: 'Help', shortcut: 'F1', action: 'help' });
  return items;
}, { onAction: (action) => {
  if (action && action.panel) showPanel(action.panel);
  else if (action === 'open') { var fi = document.getElementById('fileInput'); if (fi) fi.click(); }
  else if (action === 'saveFlush') flushProjectSave();
  else if (action === 'save') saveProjectFile();
  else if (action === 'pack') openPackModal();
  else if (action === 'load') $projectFileInput.click();
  else if (action === 'clear') clearProject();
  else if (action === 'resetLayout') wsResetLayout();
  else if (action === 'settings') openSettings();
  else if (action === 'help') toggleHelp();
}});

// Toolbar buttons
$projectSave.addEventListener('click', saveProjectFile);
document.getElementById('projectPack').addEventListener('click', openPackModal);
document.getElementById('packClose').addEventListener('click', closePackModal);
document.getElementById('packCancel').addEventListener('click', closePackModal);
document.getElementById('packGo').addEventListener('click', runPack);
document.getElementById('packCompress').addEventListener('change', function() {
  var $note = document.getElementById('packNote');
  if (this.disabled) return;
  $note.textContent = this.checked
    ? 'CSV typically shrinks 4–6×. Compressed packs decompress once on load.'
    : 'Stored entries pack and re-open with no memory cost; the archive is the size of its files.';
});
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

// Project file dropped before its data file (or pulled from a packed zip)
let pendingDroppedProject = null;
let pendingDroppedAuxFile = null;
let pendingDroppedDhTrio = null; // raw drillhole trio (aux) from a packed project (A7)
let pendingDroppedDhTrios = null; // { dsId: trio } raw drillhole trios for d2+ derived datasets from a packed project (A10 p5-3b) — consumed in displayResults once the instances exist
let pendingDroppedDatasetFiles = null; // { id: File } d2+ instance files from a packed project (A10 4e-b-iii) — consumed in displayResults once the instances are recreated

// A "packed project" is a zip containing a .bma.json plus the data files it
// references. Returns {project, modelFile, auxFile} or null (not packed /
// user declined). Stored entries extract as zero-copy File views.
async function tryPackedProject(file) {
  let entries;
  try { entries = await listZipEntries(file); } catch (e) { return null; }
  const pjEntry = entries.find(e => /\.bma\.json$/i.test(e.name));
  if (!pjEntry) return null;
  let project;
  try { project = JSON.parse(await readZipEntryText(file, pjEntry)); } catch (e) { return null; }
  if (!project || project._bma !== 1) return null;
  // Model-optional: a model-less packed project has project.file === null and no
  // model entry — its datasets ride in the archive and restore on their own.
  const modelEntry = (project.file && project.file.name) ? entries.find(e => e.name === project.file.name) : null;
  if (project.file && project.file.name && !modelEntry) return null;   // model-backed but the model file is missing
  // A10 phase 5: `drillholes` is a per-dataset map { dsId: recipe }; normalize a
  // legacy flat recipe to { aux }. The aux trio rides here (p5-3a); d2+ sets in
  // the archive ride as their own trios via the datasets loop below (p5-3b).
  let dhMapPacked = project.drillholes || null;
  if (dhMapPacked && dhMapPacked.files) dhMapPacked = { aux: dhMapPacked };
  const dhAuxRecipe = dhMapPacked ? (dhMapPacked.aux || null) : null;
  // Opening from the project manager (registry) is already a deliberate choice —
  // skip the "Packed project found" confirm; a raw drag-drop still asks.
  const ok = (typeof projAutoLoadPack !== 'undefined' && projAutoLoadPack) ? true : await bmaConfirm({
    title: 'Packed project found',
    html: 'This archive contains a BMA project' +
      (project.title ? ': <strong>' + esc(project.title) + '</strong>' : '') +
      '<div class="confirm-detail"><code>' + esc(pjEntry.name) + '</code></div>' +
      (project.file && project.file.name ? 'Load <strong>' + esc(project.file.name) + '</strong>' : 'Load this model-less project') +
      (dhAuxRecipe && dhAuxRecipe.files
        ? ' and the packed <strong>drillhole set</strong> (composites re-derive on load)'
        : (project.aux && project.aux.fileName ? ' and <strong>' + esc(project.aux.fileName) + '</strong>' : '')) +
      (Array.isArray(project.datasets) && project.datasets.length
        ? ' (+ ' + project.datasets.length + ' comparison dataset' + (project.datasets.length > 1 ? 's' : '') + ')'
        : '') +
      ' with that setup?' +
      '<div class="confirm-hint">“Open as zip” ignores the project and opens the archive normally.</div>',
    okLabel: 'Load project',
    cancelLabel: 'Open as zip'
  });
  if (!ok) return null;
  const modelFile = modelEntry ? await zipEntryToFile(file, modelEntry) : null;
  let auxF = null;
  if (project.aux && project.aux.fileName) {
    const auxEntry = entries.find(e => e.name === project.aux.fileName);
    if (auxEntry) { try { auxF = await zipEntryToFile(file, auxEntry); } catch (e) {} }
  }
  // Drillhole packs carry the RAW trio (A7 D8) — the derived composite CSV
  // is never in the archive; it re-derives on load
  let dhTrio = null;
  if (dhAuxRecipe && dhAuxRecipe.files) {
    dhTrio = {};
    let found = 0;
    for (const role of ['collar', 'survey', 'intervals', 'secondary']) {   // A11 P5: secondary merge table
      const want = dhAuxRecipe.files[role];
      const fe = want && entries.find(e => e.name === want.name);
      if (fe) { try { dhTrio[role] = await zipEntryToFile(file, fe); found++; } catch (e) {} }
    }
    if (!found) dhTrio = null;
  }
  // A10 4e-b-iii: the comparison-dataset instances (d2+) ride in the archive —
  // extract each by its saved fileName so it auto-loads into its restored
  // instance (the panel state reattaches as each analyzes).
  let datasetFiles = null;
  if (Array.isArray(project.datasets) && project.datasets.length) {
    datasetFiles = {};
    for (const cfg of project.datasets) {
      if (!cfg || !cfg.id || !cfg.fileName) continue;
      const fe = entries.find(e => e.name === cfg.fileName);
      if (fe) { try { datasetFiles[cfg.id] = await zipEntryToFile(file, fe); } catch (e) {} }
    }
  }
  // A10 p5-3b: a drillhole-derived comparison dataset (d2+) packs its RAW trio,
  // not the composite — extract each set's trio so it re-derives into its
  // instance (the composite is absent from the archive, so datasetFiles misses
  // it by design). Keyed by ds.id; the 'aux' set rides dhTrio above.
  let dhTriosByDs = null;
  if (dhMapPacked) {
    for (const dsId in dhMapPacked) {
      if (dsId === 'aux' || !dhMapPacked.hasOwnProperty(dsId)) continue;
      const rec = dhMapPacked[dsId];
      if (!rec || !rec.files) continue;
      const trio = {}; let n = 0;
      for (const role of ['collar', 'survey', 'intervals', 'secondary']) {   // A11 P5: secondary merge table
        const want = rec.files[role];
        const fe = want && entries.find(e => e.name === want.name);
        if (fe) { try { trio[role] = await zipEntryToFile(file, fe); n++; } catch (e) {} }
      }
      if (n) { dhTriosByDs = dhTriosByDs || {}; dhTriosByDs[dsId] = trio; }
    }
  }
  return { project: project, modelFile: modelFile, auxFile: auxF, dhTrio: dhTrio, datasetFiles: datasetFiles, dhTriosByDs: dhTriosByDs };
}

// Reset all per-project analysis/UI state to empty. Shared by handleFile (new
// model) and newEmptyProject (model-less). Pure state resets — no file refs — so
// the model-load path is byte-identical to the inlined block it replaced.
function resetProjectState() {
  if (typeof surfaceTitles !== 'undefined') surfaceTitles = {};   // R8: don't leak view names across projects (applyProject re-sets if there's a saved one)
  currentFilter = null;
  currentGroupBy = null;
  currentStatsCatVar = null;
  currentStatsCatChecked = null;
  lastStatsCatData = null;
  statsCatGroupSortMode = null;
  statsCatSelectedVars = new Set();
  statsCatShowSelectedOnly = false;
  statsCatCdfScale = 'linear';
  statsCatCdfManual = false;
  statsCatCdfMin = null;
  statsCatCdfMax = null;
  statsCatCrossMode = 'count';
  panelState.categories.focusedCol = null;
  catalog = newCatalog();
  panelState.categories.chartShowAll = false;
  statsSelectedVars = null;
  statsVisibleMetrics = null;
  statsPercentiles = [25, 50, 75];
  statsCdfSelected = new Set();
  panelState.statistics.cmpSel = {};
  panelState.statistics.cdfCmpSel = {};
  panelState.statistics.dsHidden = new Set();
  panelState.statistics.refDs = null;
  panelState.swath.dsHidden = new Set();
  panelState.categories.dsHidden = new Set();
  if (typeof catResetInstances === 'function') catResetInstances();  // 4e-c-5: drop cloned Categories panels
  if (typeof swResetInstances === 'function') swResetInstances();    // Swath s-5: drop cloned Swath panels
  if (typeof crosstabResetInstances === 'function') crosstabResetInstances();   // A19-clone: drop cloned Cross-tab panels
  if (typeof statResetInstances === 'function') statResetInstances();  // Statistics st-5: drop cloned Statistics panels
  if (typeof gtResetInstances === 'function') gtResetInstances();      // G3b-4: drop cloned GT panels
  if (typeof statsCatResetInstances === 'function') statsCatResetInstances();  // G4b: drop cloned StatsCat panels
  if (typeof exportResetInstances === 'function') exportResetInstances();      // G5b: drop cloned Export panels
  pendingDatasetsRestore = {};
  pendingPanelState = null;
  statsCdfScale = 'linear';
  statsCdfMode = 'cdf';
  pendingStatsAuxRestore = null;
  projectTitle = null;
  exportColumns = [];
  pendingProjectRestore = null;
  resetExportSettings();
  wsResetLayout(true); // fresh file starts from the default workspace layout
  dhResetAll();             // fresh file starts with empty drillhole slots
  currentTypeOverrides = null;
  currentZipEntry = null;
  currentSkipCols = null;
  currentColFilters = null;
  lastCompleteData = null;
  if (worker) { worker.terminate(); worker = null; }
  if (exportWorker) { exportWorker.terminate(); exportWorker = null; }
  if (swathWorker) { swathWorker.terminate(); swathWorker = null; }
  if (sectionWorker) { sectionWorker.terminate(); sectionWorker = null; }
  var staleOverlay = document.querySelector('.reanalysis-overlay');
  if (staleOverlay) staleOverlay.remove();
  lastSwathData = null;
  sectionBlocks = null;
  sectionTransform = null;
  sectionDefaultBlockSize = null;
  currentDXYZ = { dx: -1, dy: -1, dz: -1 };
  currentGridMode = null;   // A10 4f-2: back to the model default ('grid')
  hasResults = false;
  $filterExpr.value = '';
  $filterSection.classList.remove('active');
  $appFooter.classList.remove('active');
  $filterError.classList.remove('active');
  $errorMsg.classList.remove('active');
}

// Placeholder content for the analysis tabs before any analysis has run. Shared
// by handleFile and newEmptyProject (verbatim move — model path unchanged).
function clearTabPlaceholders() {
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
}

// Start a fresh, model-less project (A10 model-optional): no model file, a
// generated project id (dual-key persistence), an empty workspace the user fills
// with point/drillhole datasets. The model slot stays available but empty.
// Reveal the rails workspace for a model-less project (mirrors handleFile's UI
// transition, sans a model file). Shared by newEmptyProject + openProjectById.
function enterModellessWorkspaceUI() {
  $dropzone.classList.add('collapsed');
  $dropzone.querySelector('.label').innerHTML = 'Drop a model file, or add datasets below:';
  var loadedSpan = $dropzone.querySelector('.loaded-name');
  if (loadedSpan) loadedSpan.textContent = '';
  $results.classList.add('active');
  document.querySelector('.app').classList.add('has-results');
  $resultsFilename.textContent = projectTitle || 'Untitled project';
  $resultsRowInfo.textContent = '';
  $resultsTimeInfo.textContent = '';
  $resultsMemInfo.textContent = '';
  clearTabPlaceholders();
  setModellessTabMessages();           // Statistics/Categories explain they need a model
  renderPreflightEmpty();              // model-import tab shows a "no model yet" prompt
}

// The Statistics and Categories tabs are model-column-primary (comparisons show
// as Δ% overlays on the model's columns), so with no model they have nothing to
// show. Replace the generic "Click Analyze" placeholder with a message that
// points to the surfaces that DO work model-less. Overwritten by the real render
// once a model is analyzed (displayResults).
function setModellessTabMessages() {
  var msg = function(lead) {
    return '<div class="tab-empty-note">' +
      '<div class="tab-empty-note-title">No block model</div>' +
      '<div>' + lead + ' against the block model. Load a model on the <b>Import</b> tab, ' +
      'or read a dataset on its own panel, or use <b>StatsCat</b>, <b>GT</b> and <b>Export</b> — each targets any dataset.</div>' +
      '</div>';
  };
  if (typeof $statsContent !== 'undefined' && $statsContent) $statsContent.innerHTML = msg('Statistics compares each dataset');
  if (typeof $catChart !== 'undefined' && $catChart) $catChart.innerHTML = msg('Categories compares proportions');
}

function newEmptyProject() {
  resetProjectState();
  currentFile = null;
  preflightData = null;
  currentColTypes = null;
  currentHeader = null;
  currentXYZ = null;
  currentProjectId = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : ('p' + Date.now() + '-' + Math.random().toString(36).slice(2));
  enterModellessWorkspaceUI();
  showPanel('preflight');
  refreshCatalogTree();
  if (typeof autoSaveProject === 'function') autoSaveProject();
}

// Reopen a saved model-less project from localStorage (bma:proj:<id>). The
// workspace comes up empty and applyProject restores its config + comparison-
// dataset instances; each dataset awaits re-supply of its file (the same pending-
// restore path model-backed comparisons use on reload), or comes via a packed zip.
async function openProjectById(id) {
  var raw = null;
  try { raw = localStorage.getItem('bma:proj:' + id); } catch (e) { /* unavailable */ }
  if (!raw) return;
  var project = null;
  try { project = JSON.parse(raw); } catch (e) { return; }
  if (!project || !project._bma) return;
  resetProjectState();
  currentFile = null;
  preflightData = null;
  currentColTypes = null;
  currentHeader = null;
  currentXYZ = null;
  currentProjectId = id;
  enterModellessWorkspaceUI();
  showPanel('preflight');
  try { await applyProject(project); } catch (e) { /* corrupt — ignore */ }
  refreshCatalogTree();
}

// Open a model-less PACKED project (.bma.zip with project.file === null). Like
// openProjectById, but the dataset files ride in the archive — load each into its
// restored instance (the model-backed equivalent runs in displayResults, which
// never fires with no model).
async function openPackedModelless(packed) {
  var project = packed.project;
  resetProjectState();
  currentFile = null;
  preflightData = null;
  currentColTypes = null;
  currentHeader = null;
  currentXYZ = null;
  currentProjectId = project.id || ((typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID() : ('p' + Date.now() + '-' + Math.random().toString(36).slice(2)));
  enterModellessWorkspaceUI();
  showPanel('preflight');
  try { await applyProject(project); } catch (e) { /* corrupt — ignore */ }
  // Consume the bundled files (same loaders displayResults uses for model-backed)
  if (packed.datasetFiles) {
    Object.keys(packed.datasetFiles).forEach(function(id) {
      var dds = dsById(id);
      if (dds && packed.datasetFiles[id]) loadAuxFile(packed.datasetFiles[id], null, null, dds, dsConfigRoot(dds));
    });
  }
  if (packed.dhTriosByDs) {
    Object.keys(packed.dhTriosByDs).forEach(function(id) {
      var dds = dsById(id);
      if (dds && typeof dhLoadTrio === 'function') dhLoadTrio(dds, packed.dhTriosByDs[id]);
    });
  }
  if (packed.auxFile) loadAuxFile(packed.auxFile, null);
  else if (packed.dhTrio && typeof dhLoadTrio === 'function') dhLoadTrio(dsById('aux'), packed.dhTrio);
  // these pending vars were set by the zip branch; model-less consumes them here
  pendingDroppedAuxFile = null;
  pendingDroppedDhTrio = null;
  pendingDroppedDhTrios = null;
  pendingDroppedDatasetFiles = null;
  pendingDroppedProject = null;
  refreshCatalogTree();
}

// Load a model into a model-less project IN PLACE — unlike handleFile (which
// resets everything for a fresh model), this preserves the comparison datasets,
// catalog, layout and title already in the project. The project becomes model-
// backed: re-key from its 'bma:proj:<id>' identity to the model file key (dual-
// key). Only valid when there is no model yet (currentFile null).
async function setProjectModel(file, handle) {
  if (!file || currentFile) return;
  var oldId = currentProjectId;
  currentFile = file;
  currentProjectId = null;                                  // now model-backed (file key)
  if (oldId) { try { localStorage.removeItem('bma:proj:' + oldId); } catch (e) { /* ignore */ } }
  if (typeof saveToRecents === 'function') saveToRecents(file, handle);
  if (worker) { worker.terminate(); worker = null; }        // a fresh model gets a fresh analysis
  lastCompleteData = null;
  currentDXYZ = { dx: -1, dy: -1, dz: -1 };
  currentGridMode = null;
  $resultsFilename.textContent = file.name;
  $filterSection.classList.add('active');
  $appFooter.classList.add('active');
  if (typeof wsSetDatasetTabTitle === 'function' && typeof dsById === 'function') wsSetDatasetTabTitle(dsById('model'));
  try {
    var data = await runPreflight(file);
    renderPreflight(data);                                  // sets preflightData, shows column config + model filter
    if (typeof catEnsureSeeded === 'function') catEnsureSeeded();   // seeds model props, pairs to existing comparison columns by name
    if (typeof refreshModelGridSection === 'function') refreshModelGridSection();
    clearTabPlaceholders();   // a model exists now → Statistics/Categories show "Click Analyze", not the model-less note
    markAnalysisStale();
    showPanel('preflight');
    refreshCatalogTree();
    if (typeof autoSaveProject === 'function') autoSaveProject();
  } catch (err) {
    $errorMsg.textContent = err.message;
    $errorMsg.classList.add('active');
  }
}

// Open a file picker for a model and load it into the current model-less project
// (the empty Import-Model tab's "Load model file" action).
async function pickModelFile() {
  if (typeof HAS_FSAA !== 'undefined' && HAS_FSAA && window.showOpenFilePicker) {
    try {
      var handles = await window.showOpenFilePicker({
        types: (typeof dataPickerTypes === 'function') ? dataPickerTypes() : undefined,
        multiple: false
      });
      var h = handles[0];
      var f = await h.getFile();
      setProjectModel(f, h);
    } catch (ex) { /* user cancelled */ }
    return;
  }
  // Fallback: a transient file input
  var inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.csv,.txt,.dat,.zip,.dm,.CSV,.TXT,.DAT,.ZIP,.DM';
  inp.style.display = 'none';
  inp.addEventListener('change', function() { if (inp.files && inp.files[0]) setProjectModel(inp.files[0], null); inp.remove(); });
  document.body.appendChild(inp);
  inp.click();
}

async function handleFile(file, handle, skipRecents) {
  if (!file) return;

  // BLOCKER fix (review R1): a FRESH load (not driven by projOpen, which passes
  // skipRecents) must drop any previous project's folder/virtual MOUNT first — else
  // autosave writes THIS project's JSON into the OLD project's folder, clobbering
  // it. projOpen's folder/opfs/idb path sets mountedFolder then calls handleFile
  // with skipRecents=true, so it's preserved there.
  if (!skipRecents) {
    if (typeof mountedFolder !== 'undefined') mountedFolder = null;
    if (typeof fsaaCurrentJsonName !== 'undefined') fsaaCurrentJsonName = null;
    if (typeof projOpenLabel !== 'undefined') projOpenLabel = null;
    if (typeof mountedFolderVirtual !== 'undefined') mountedFolderVirtual = false;
    if (typeof fsaaRenderIndicator === 'function') fsaaRenderIndicator();
  }

  // Bare project file: stash it and ask for its data file
  if (/\.bma\.json$/i.test(file.name)) {
    try {
      const pj = JSON.parse(await file.text());
      if (pj && pj._bma === 1 && pj.file && pj.file.name) {
        pendingDroppedProject = pj;
        $dropzone.querySelector('.label').innerHTML =
          'Project loaded — now drop <strong>' + esc(pj.file.name) + '</strong> to apply it';
        return;
      }
    } catch (e) { /* fall through to error */ }
    $errorMsg.textContent = 'Not a valid BMA project file.';
    $errorMsg.classList.add('active');
    return;
  }

  // Packed project archive: extract data + config from the zip
  if (/\.zip$/i.test(file.name) || file.type === 'application/zip') {
    let packed = null;
    try { packed = await tryPackedProject(file); } catch (e) { packed = null; }
    if (packed) {
      pendingDroppedProject = packed.project;
      pendingDroppedAuxFile = packed.auxFile;
      pendingDroppedDhTrio = packed.dhTrio;
      pendingDroppedDhTrios = packed.dhTriosByDs || null; // p5-3b: d2+ drillhole trios, re-derived in displayResults once instances exist
      pendingDroppedDatasetFiles = packed.datasetFiles || null; // 4e-b-iii: consumed in displayResults once instances exist
      // Recents records the archive the user actually opened (re-openable
      // via its handle) — not the extracted inner CSV, which used to land
      // in the list under a name nobody dropped and could never re-open
      saveToRecents(file, handle, true);
      // C14: the ZIP is the re-openable artifact — keep its handle so reopen
      // re-extracts the pack (handleFile auto-detects .zip), no re-pick. The inner
      // handleFile below is skipRecents=true, so it won't clobber this (see 1816).
      if (typeof currentFileHandle !== 'undefined') currentFileHandle = handle || null;
      if (packed.modelFile) {
        handleFile(packed.modelFile, null, true);
      } else {
        // Model-less packed project: no model file to re-enter through handleFile —
        // bring up the empty workspace and load the bundled datasets directly.
        await openPackedModelless(packed);
      }
      return;
    }
  }

  currentFile = file;
  // R5: a FRESH drop starts a NEW project with its own UUID identity (project-based,
  // not file-keyed). A projOpen-driven open instead keeps the restored project's id —
  // applyProject (or the file-key restore for legacy records) sets it below.
  if (typeof projOpening === 'undefined' || !projOpening) {
    currentProjectId = (typeof projNewId === 'function') ? projNewId()
      : ('p' + Date.now() + '-' + Math.random().toString(36).slice(2));
  } else {
    currentProjectId = null;
  }
  // C14: keep the model's FSAA handle so reopen needs no re-pick. Guarded on
  // !skipRecents so an INNER call (packed-zip → inner model, folder-open → model)
  // doesn't null out the outer artifact's handle captured above.
  if (!skipRecents && typeof currentFileHandle !== 'undefined') currentFileHandle = handle || null;
  // C14: a FRESH load starts its own registry record; an open driven by projOpen
  // (projOpening) keeps the record id it set.
  if (typeof projOpening === 'undefined' || !projOpening) { if (typeof currentProjectRecId !== 'undefined') currentProjectRecId = null; }
  if (!skipRecents) saveToRecents(file, handle);
  resetProjectState();

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
  showPanel('preflight');
  if (typeof wsSetDatasetTabTitle === 'function' && typeof dsById === 'function') wsSetDatasetTabTitle(dsById('model'));  // tab follows the model filename

  // Show action bar with execute button and filter
  $appFooter.classList.add('active');
  $filterSection.classList.add('active');
  markAnalysisStale();

  // Set placeholder content for tabs before first analysis
  clearTabPlaceholders();

  // Run preflight
  runPreflight(file).then(async data => {
    renderPreflight(data);
    if (typeof renderAuxFromMain === 'function') renderAuxFromMain();
    // Project precedence: an explicitly dropped/packed project for this file
    // wins over the autosaved one
    let project = null;
    if (pendingDroppedProject && pendingDroppedProject.file && pendingDroppedProject.file.name === file.name) {
      project = pendingDroppedProject;
    } else if (typeof projOpening !== 'undefined' && projOpening) {
      // R5: only a deliberate manager-open resumes a LEGACY file-keyed project's
      // config; a fresh drop is a NEW project (its own UUID), never an implicit
      // file-key resume. (Post-R5 records seed pendingDroppedProject from their own
      // key in projOpen, so they take the branch above.)
      const saved = localStorage.getItem(projectKey(file));
      if (saved) { try { project = JSON.parse(saved); } catch (e) { /* corrupt — ignore */ } }
    }
    const auxToLoad = pendingDroppedAuxFile;
    const dhTrioToLoad = pendingDroppedDhTrio;
    pendingDroppedProject = null;
    pendingDroppedAuxFile = null;
    pendingDroppedDhTrio = null;
    if (project) {
      try {
        await applyProject(project);
        if (auxToLoad) loadAuxFile(auxToLoad, null);
        else if (dhTrioToLoad) await dhLoadTrio(dsById('aux'), dhTrioToLoad); // re-derives + loads via the saved recipe
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
  if (typeof renderTree === 'function') renderTree();   // C12-P1b: the tree stale badge follows
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

// Back button in toolbar — go back to dropzone. Extracted so switching projects
// (File ▸ Open recent, or the manager) can return to a clean landing first.
function closeProjectToLanding() {
  // R7: flush the pending autosave before tearing down, so the outgoing project's
  // last edits aren't dropped when switching projects (projOpen calls us first).
  if (currentFile && preflightData && typeof flushProjectSave === 'function') flushProjectSave();
  $results.classList.remove('active');
  document.querySelector('.app').classList.remove('has-results');
  $appFooter.classList.remove('active');
  $filterSection.classList.remove('active');
  $dropzone.classList.remove('collapsed');
  const loadedSpan = $dropzone.querySelector('.loaded-name');
  if (loadedSpan) loadedSpan.remove();
  $dropzone.querySelector('.label').innerHTML = 'Drop a CSV file here, or <strong>click to browse</strong>';
  renderRecentFiles();
  if (typeof renderProjectList === 'function') renderProjectList();
  if (typeof renderProjects === 'function') renderProjects();   // C14 manager
  currentFile = null;
  if (typeof currentFileHandle !== 'undefined') currentFileHandle = null;
  currentProjectId = null;   // closing returns to the landing; a model-less project is reopened from its list
  if (typeof currentProjectRecId !== 'undefined') currentProjectRecId = null;   // C14: next project gets its own record
  preflightData = null;
  hasResults = false;
  currentCalcolCode = '';
  currentCalcolMeta = [];
  currentGroupBy = null;
  currentStatsCatVar = null;
  currentStatsCatChecked = null;
  lastStatsCatData = null;
  statsCatGroupSortMode = null;
  statsCatSelectedVars = new Set();
  statsCatShowSelectedOnly = false;
  panelState.categories.focusedCol = null;
  catalog = newCatalog();
  panelState.categories.chartShowAll = false;
  statsSelectedVars = null;
  statsVisibleMetrics = null;
  statsPercentiles = [25, 50, 75];
  statsCdfSelected = new Set();
  panelState.statistics.cmpSel = {};
  panelState.statistics.cdfCmpSel = {};
  panelState.statistics.dsHidden = new Set();
  panelState.statistics.refDs = null;
  panelState.swath.dsHidden = new Set();
  panelState.categories.dsHidden = new Set();
  if (typeof catResetInstances === 'function') catResetInstances();  // 4e-c-5: drop cloned Categories panels
  if (typeof swResetInstances === 'function') swResetInstances();    // Swath s-5: drop cloned Swath panels
  if (typeof crosstabResetInstances === 'function') crosstabResetInstances();   // A19-clone: drop cloned Cross-tab panels
  if (typeof statResetInstances === 'function') statResetInstances();  // Statistics st-5: drop cloned Statistics panels
  if (typeof gtResetInstances === 'function') gtResetInstances();      // G3b-4: drop cloned GT panels
  if (typeof statsCatResetInstances === 'function') statsCatResetInstances();  // G4b: drop cloned StatsCat panels
  if (typeof exportResetInstances === 'function') exportResetInstances();      // G5b: drop cloned Export panels
  pendingDatasetsRestore = {};
  pendingPanelState = null;
  statsCdfScale = 'linear';
  statsCdfMode = 'cdf';
  pendingStatsAuxRestore = null;
  projectTitle = null;
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
  currentGridMode = null;   // A10 4f-2: back to the model default ('grid')
  if (typeof surfaceTitles !== 'undefined') surfaceTitles = {};   // C10: clear user-named views
  // C14: drop the session mount (the registry record keeps the handle for reopen;
  // we don't clear the persisted FSAA handle here, just this session's mount).
  if (typeof mountedFolder !== 'undefined') mountedFolder = null;
  if (typeof projOpenLabel !== 'undefined') projOpenLabel = null;
  if (typeof fsaaCurrentJsonName !== 'undefined') fsaaCurrentJsonName = null;
  if (typeof mountedFolderVirtual !== 'undefined') mountedFolderVirtual = false;
  if (typeof fsaaRenderIndicator === 'function') fsaaRenderIndicator();
}
$backToPreflight.addEventListener('click', closeProjectToLanding);

// Allow dropping new files onto results area
$results.addEventListener('dragover', (e) => { e.preventDefault(); });
$results.addEventListener('drop', async (e) => {
  e.preventDefault();
  var handle = null;
  if (HAS_FSAA && e.dataTransfer.items && e.dataTransfer.items[0] && e.dataTransfer.items[0].getAsFileSystemHandle) {
    try { handle = await e.dataTransfer.items[0].getAsFileSystemHandle(); } catch (ex) {}
  }
  var file = handle ? await handle.getFile() : (e.dataTransfer.files[0] || null);
  if (!file) return;
  // Drops anywhere on the Aux panel load the aux dataset, not the main model
  if (e.target && e.target.closest && e.target.closest('#panelAux')) { loadAuxFile(file, handle); return; }
  // A10 #19: a model is already loaded — never silently replace it. Offer the
  // additive path (a new comparison dataset) as the default, replace as the
  // explicit alternative. JSON projects always load (they're not a dataset).
  var isProject = /\.json$/i.test(file.name);
  var isArchive = /\.zip$/i.test(file.name);
  if (currentFile && !isProject) {
    var choice = await bmaConfirm({
      title: 'Add “' + esc(file.name) + '”',
      html: '<p>A model is already loaded. Add this file as a <strong>comparison dataset</strong>, or <strong>replace</strong> the current model?</p>',
      okLabel: 'Add as comparison',
      extraLabel: 'Replace model',
      cancelLabel: 'Cancel'
    });
    if (choice === true) wsLoadComparisonFile(file, handle);
    else if (choice === 'extra') handleFile(file, handle);
    return;
  }
  // Model-less project: a dropped data file is ambiguous (a comparison dataset or
  // the project's model). Default to the safe additive path; "Set as model" starts
  // a model-backed project (and, per the Standing Rule, warns that the current
  // datasets won't carry over — preserving them across a model-add is future work).
  if (currentProjectId && !currentFile && !isProject && !isArchive) {
    var ch = await bmaConfirm({
      title: 'Add “' + esc(file.name) + '”',
      html: '<p>This project has no model. Add this file as a <strong>comparison dataset</strong>, or <strong>set it as the model</strong> (the datasets you already added stay)?</p>',
      okLabel: 'Add as comparison',
      extraLabel: 'Set as model',
      cancelLabel: 'Cancel'
    });
    if (ch === true) wsLoadComparisonFile(file, handle);
    else if (ch === 'extra') setProjectModel(file, handle);   // loads the model in place, preserving the datasets
    return;
  }
  handleFile(file, handle);
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

  // Always use overlay on the results panels. On the rails shell the legacy
  // .results-panels container is display:none (panels live in .results-main), so
  // the overlay must mount on .results-main there or it would be invisible.
  const panelsEl = (typeof wsRails !== 'undefined' && wsRails)
    ? document.getElementById('resultsMain')
    : $results.querySelector('.results-panels');
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
    $reLabel.textContent = 'Worker error: ' + (e.message || 'unknown error');
    $reLabel.style.color = 'var(--red)';
    $reBar.parentElement.style.display = 'none';
    var btn = $overlay.querySelector('.re-cancel');
    btn.textContent = 'Dismiss';
    var newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', () => {
      $overlay.remove();
      if (lastCompleteData) displayResults(lastCompleteData);
    });
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
      if (msg.message.startsWith('Filter expression')) {
        $overlay.remove();
        $filterError.textContent = msg.message;
        $filterError.classList.add('active');
        if (lastCompleteData) displayResults(lastCompleteData);
      } else {
        $reLabel.textContent = msg.message;
        $reLabel.style.color = 'var(--red)';
        $reBar.parentElement.style.display = 'none';
        var btn = $overlay.querySelector('.re-cancel');
        btn.textContent = 'Dismiss';
        var newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        newBtn.addEventListener('click', () => {
          $overlay.remove();
          if (lastCompleteData) displayResults(lastCompleteData);
        });
      }
    }
  };

  const filterPayload = filter ? { expression: filter.expression } : null;
  worker.postMessage({
    file: currentFile,
    xyzOverride: xyzOverride || null,
    dxyzOverride: dxyzOverride || null,
    filter: filterPayload,
    typeOverrides: fullTypeOverrides(),
    zipEntry: currentZipEntry || null,
    skipCols: currentSkipCols || null,
    colFilters: currentColFilters || null,
    calcolCode: currentCalcolCode || null,
    calcolMeta: currentCalcolMeta.length > 0 ? currentCalcolMeta : null,
    groupBy: currentGroupBy,
    groupStatsCols: currentGroupBy !== null && statsCatSelectedVars.size > 0 ? Array.from(statsCatSelectedVars) : null,
    dmEndianness: preflightData && preflightData.dmEndianness || null,
    dmFormat: preflightData && preflightData.dmFormat || null,
    weightColName: catRole('model', 'weight')
  });
}

// C6-5: Data Health card — aggregates the scattered A8/A9 data-quality
// counters (the badges/warn-notes each tab surfaces locally) into one
// glanceable Summary card with per-tab "View →" links. The A7 drillhole
// consistency-report pattern, promoted app-wide. Clean → a green all-good
// line; issues → a warn row each. Reads the analyze 'complete' message fields.
// Returns the data-quality issue list for a dataset's analyze 'complete'
// message — shared by the model Summary health card and the per-dataset
// (aux) summary. Empty array = clean.
function computeHealthItems(data) {
  var header = data.header || [];
  var stats = data.stats || [];
  var items = [];

  // stats is keyed by column index (not a dense array) — iterate by header
  var emptyCols = [];
  for (var i = 0; i < header.length; i++) {
    if (stats[i] && stats[i].count === 0) emptyCols.push(header[i]);
  }
  if (emptyCols.length) items.push({
    n: emptyCols.length,
    label: emptyCols.length + ' empty column' + (emptyCols.length === 1 ? '' : 's'),
    detail: emptyCols.join(', ') + ' — no valid values in this analysis',
    tab: 'statistics'
  });

  var mixedCols = [], mixedTotal = 0;
  for (var j = 0; j < header.length; j++) {
    if (stats[j] && stats[j].parseFails > 0) { mixedCols.push(header[j]); mixedTotal += stats[j].parseFails; }
  }
  if (mixedCols.length) items.push({
    n: mixedTotal,
    label: mixedTotal.toLocaleString() + ' non-numeric value' + (mixedTotal === 1 ? '' : 's') + ' in ' + mixedCols.length + ' column' + (mixedCols.length === 1 ? '' : 's'),
    detail: mixedCols.join(', ') + ' — treated as nulls; toggle to CAT in Import Model if a category',
    tab: 'statistics'
  });

  if (data.raggedRows > 0) items.push({
    n: data.raggedRows,
    label: data.raggedRows.toLocaleString() + ' ragged row' + (data.raggedRows === 1 ? '' : 's'),
    detail: 'unexpected field count — check delimiter/quoting; misaligned values land in the wrong columns',
    tab: 'preflight'
  });

  if (data.filterErrors) {
    var fe = (data.filterErrors.global || 0) + (data.filterErrors.local || 0);
    if (fe > 0) items.push({
      n: fe,
      label: fe.toLocaleString() + ' row' + (fe === 1 ? '' : 's') + ' excluded by filter errors',
      detail: 'first: ' + data.filterErrors.message,
      tab: 'statistics'
    });
  }

  if (data.calcolErrors && data.calcolErrors.count > 0) items.push({
    n: data.calcolErrors.count,
    label: data.calcolErrors.count.toLocaleString() + ' calculated-column error' + (data.calcolErrors.count === 1 ? '' : 's'),
    detail: 'first: ' + data.calcolErrors.message,
    tab: 'calc'
  });

  if (data.weightExcluded > 0) items.push({
    n: data.weightExcluded,
    label: data.weightExcluded.toLocaleString() + ' row' + (data.weightExcluded === 1 ? '' : 's') + ' excluded for invalid weight',
    detail: 'missing or ≤0 weight — excluded from weighted statistics',
    tab: 'statistics'
  });

  if (data.coordInvalidCells > 0) items.push({
    n: data.coordInvalidCells,
    label: data.coordInvalidCells.toLocaleString() + ' coordinate value' + (data.coordInvalidCells === 1 ? '' : 's') + ' ignored',
    detail: 'null sentinel or unparseable — excluded from grid inference (see Grid Geometry above)',
    tab: null
  });

  if (data.groupStatsOverflow) items.push({
    n: null,
    label: 'Group cap reached (500)',
    detail: 'some categories were omitted from grouped statistics',
    tab: 'statscat'
  });

  return items;
}

function renderHealthCard(data) {
  var $sec = document.getElementById('healthSection');
  var $content = document.getElementById('healthContent');
  var $badge = document.getElementById('healthBadge');
  if (!$sec || !$content) return;
  var header = data.header || [];
  var items = computeHealthItems(data);

  var rowCount = (data.totalRowCount != null ? data.totalRowCount : data.rowCount) || 0;
  if (items.length === 0) {
    $badge.textContent = 'clean';
    $badge.style.background = 'var(--green-soft)';
    $badge.style.color = 'var(--green)';
    $content.innerHTML = '<div class="health-clean">✓ No data-quality issues — all ' +
      rowCount.toLocaleString() + ' rows and ' + header.length + ' columns parsed cleanly.</div>';
  } else {
    $badge.textContent = items.length + ' check' + (items.length === 1 ? '' : 's');
    $badge.style.background = 'var(--warn-soft)';
    $badge.style.color = 'var(--warn)';
    $content.innerHTML = items.map(function(it) {
      var link = it.tab ? '<a class="health-link" data-goto="' + esc(it.tab) + '" href="#">View →</a>' : '';
      var cnt = '<span class="health-count">' + (it.n != null ? it.n.toLocaleString() : '!') + '</span>';
      return '<div class="health-item">' + cnt +
        '<div class="health-text"><div class="health-label">' + esc(it.label) + '</div>' +
        '<div class="health-detail">' + esc(it.detail) + '</div></div>' + link + '</div>';
    }).join('');
  }
  $sec.style.display = '';

  if (!$content.dataset.gotoBound) {
    $content.dataset.gotoBound = '1';
    $content.addEventListener('click', function(e) {
      var a = e.target.closest('[data-goto]');
      if (!a) return;
      e.preventDefault();
      showPanel(a.getAttribute('data-goto'));
    });
  }
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
  if (isFirstAnalysis || (activeTab && activeTab.dataset.tab === 'preflight')) showPanel('summary');

  // Mark analysis as clean
  analysisStale = false;
  const execBtn = document.getElementById('executeBtn');
  if (execBtn) execBtn.classList.add('clean');

  // A10 4f-2: the detected-grid badge in the preflight panel is only known now
  if (typeof refreshModelGridSection === 'function') refreshModelGridSection();

  // ws-v2 phase 2: the Summary now lives in this panel — reveal its Preview/Summary
  // toggle once there's an analysis (showPanel('summary') below switches the view).
  if (typeof renderModelView === 'function') renderModelView();

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

  // C6-5 data-health card (after the file/geometry fields are read off data)
  renderHealthCard(data);

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

    // A10 4f-3: the geometry table is shared with gridded comparison datasets
    $geoContent.innerHTML = geoContentHtml(geometry, totalRowCount, {
      coordOrder, maxDecimals, dxyz: currentDXYZ, coordInvalidCells: data.coordInvalidCells
    });
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
    let ovHtml = '<div class="col-overview-wrap"><table class="col-overview"><thead><tr><th>Column</th><th>Type</th><th>Unit</th><th>Count</th><th>Nulls</th><th>Zeros</th><th>Completeness</th><th>Range / Unique</th></tr></thead><tbody>';
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
      let unitCell = '\u2014';
      if (isNum) {
        let curUnit = catPropUnit('model', cName);
        let unitOpts = GRADE_UNITS.map(function(u, ui) {
          return '<option value="' + ui + '"' + (ui === curUnit ? ' selected' : '') + '>' + esc(u.label) + '</option>';
        }).join('');
        unitCell = '<select class="col-unit-select" data-col-name="' + esc(cName) + '">' + unitOpts + '</select>';
      }
      ovHtml += '<tr>'
        + '<td class="col-name" title="' + esc(cName) + '">' + esc(cName) + '</td>'
        + '<td><span class="col-type ' + typeClass + '">' + typeLabel + '</span></td>'
        + '<td>' + unitCell + '</td>'
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
  if (typeof statApplyAllInstances === 'function') statApplyAllInstances();    // st-5: resolve restored clone views
  if (typeof statRenderAllInstances === 'function') statRenderAllInstances();  // st-4: keep clones in sync

  // Categories
  const catCols = Object.keys(categories).map(Number).sort((a, b) => a - b);
  renderCategoriesTab(categories, header, origColCount, rowCount);

  // Restore pending project state (phase 2 — post-analysis)
  const restoredProject = pendingProjectRestore;
  if (restoredProject) {
    pendingProjectRestore = null;

    // StatsCat display state — restore before renderStatsCat() so UI renders correctly
    const sc = restoredProject.statsCat || {};
    // groupBy and selectedVars already restored in applyProject() (phase 1)
    if (sc.sortMode !== undefined) statsCatGroupSortMode = sc.sortMode;
    if (sc.cdfScale) statsCatCdfScale = sc.cdfScale;
    if (sc.cdfManual !== undefined) statsCatCdfManual = sc.cdfManual;
    if (sc.cdfMin !== undefined) statsCatCdfMin = sc.cdfMin;
    if (sc.cdfMax !== undefined) statsCatCdfMax = sc.cdfMax;
    if (sc.crossMode) statsCatCrossMode = sc.crossMode;
    if (sc.displayVar != null) currentStatsCatVar = sc.displayVar;
    if (sc.checkedGroups) currentStatsCatChecked = new Set(sc.checkedGroups);
    if (sc.showSelectedOnly !== undefined) statsCatShowSelectedOnly = sc.showSelectedOnly;

    // Stats tab
    const st = restoredProject.statsTab || {};
    statsTargetDsId = st.targetDsId || 'model';   // ws-v2 phase 1 (statsTargetDs falls back if it's gone)
    if (st.selectedVars) statsSelectedVars = new Set(st.selectedVars);
    if (st.visibleMetrics) statsVisibleMetrics = new Set(st.visibleMetrics);
    if (st.percentiles) statsPercentiles = st.percentiles;
    if (st.cdfSelected) statsCdfSelected = new Set(st.cdfSelected);
    if (st.cdfScale) statsCdfScale = st.cdfScale;
    if (st.cdfMode) statsCdfMode = st.cdfMode;
    if (typeof statsCdfPaneH !== 'undefined' && st.cdfPaneH) statsCdfPaneH = st.cdfPaneH;
    if (st.auxSelected || st.cdfAuxSelected) {
      pendingStatsAuxRestore = { selected: st.auxSelected || null, cdf: st.cdfAuxSelected || null };
      applyStatsAuxRestore(); // no-op until aux analysis exists; consumed then
    }

    // A10 4e-b: comparison-dataset instances (d2+) + cross-dataset panel state.
    // Recreate each instance now (empty import panel awaiting its named file,
    // pending config consumed when the file lands). The id-keyed panel state
    // (4c hidden chips, 4d Δ% reference) applies immediately — it needs no
    // headers; the selection-by-name reattaches per dataset as it analyzes
    // (pendingPanelState, drained by applyStatsCmpRestore).
    pendingDatasetsRestore = {};
    // A10 phase 5: per-dataset drillhole recipes (normalize the legacy flat shape)
    var dhRestoreMap = restoredProject.drillholes || null;
    if (dhRestoreMap && dhRestoreMap.files) dhRestoreMap = { aux: dhRestoreMap };
    (restoredProject.datasets || []).forEach(function(cfg) {
      if (!cfg || !cfg.id) return;
      pendingDatasetsRestore[cfg.id] = cfg;
      if (typeof wsRestoreInstance === 'function') wsRestoreInstance(cfg);
      // This instance's drillhole set (if any): seed its pending recipe so the
      // card shows the "drop the trio" hint when its panel builds (re-derives).
      if (dhRestoreMap && dhRestoreMap[cfg.id] && typeof dhRestoreFromProject === 'function') {
        dhRestoreFromProject(dsById(cfg.id), dhRestoreMap[cfg.id]);
      }
    });
    // 4e-b-iii: a packed project carries the d2+ files in the archive — load
    // each into its freshly-recreated instance now (loadAuxFile applies the
    // pending config + preflight, like the packed aux path; user analyzes per
    // dataset, which reattaches its selection). The loose/autosave path leaves
    // this null and the user re-drops each file into its waiting panel.
    if (pendingDroppedDatasetFiles) {
      var ddf = pendingDroppedDatasetFiles;
      pendingDroppedDatasetFiles = null;
      Object.keys(ddf).forEach(function(id) {
        var dds = (typeof dsById === 'function') ? dsById(id) : null;
        if (dds && ddf[id] && typeof loadAuxFile === 'function') loadAuxFile(ddf[id], null, null, dds, dsConfigRoot(dds));
      });
    }
    // A10 p5-3b: a packed project carries each drillhole-derived d2+'s RAW trio
    // (not the composite) — re-derive it into its instance now (dhLoadTrio →
    // re-composite → loadAuxFile matches the pending config by the composite
    // name, exactly like the packed aux path).
    if (pendingDroppedDhTrios) {
      var pdt = pendingDroppedDhTrios;
      pendingDroppedDhTrios = null;
      Object.keys(pdt).forEach(function(id) {
        var dds = (typeof dsById === 'function') ? dsById(id) : null;
        if (dds && pdt[id] && typeof dhLoadTrio === 'function') dhLoadTrio(dds, pdt[id]);
      });
    }
    // A11 emit persistence: re-derive any emitted datasets whose parent set is now
    // ready (backstop for parents that re-derived before their emit instances were
    // recreated — e.g. the packed aux path; idempotent with dhLoadTrio's own call).
    if (typeof dhReEmitAll === 'function') dhReEmitAll();
    // C11-P2: load each materialized emit's frozen snapshot (folder file / embedded
    // csv); falls back to re-derive from the kept link when the snapshot is gone.
    if (typeof dsRestoreMaterialized === 'function') dsRestoreMaterialized();
    // C11-P1: with a folder mounted, resolve a restored project's still-pending
    // comparison-dataset + drillhole-trio files from the folder by name — no re-drop.
    if (typeof fsaaResolveProjectFiles === 'function') fsaaResolveProjectFiles();
    // Derived-lifecycle: surface a single banner if any view-bearing derived dataset
    // can't be recreated (source not loaded). Event-driven now (R13) — the predicate
    // suppresses datasets whose source IS present (derive pending, not broken), and
    // each dataset-complete re-runs this, so a slow restore no longer false-alarms.
    if (typeof dsCheckDerivedHealth === 'function') dsCheckDerivedHealth();
    pendingPanelState = restoredProject.panels || null;
    if (pendingPanelState && pendingPanelState.statistics) {
      var pst = pendingPanelState.statistics;
      if (Array.isArray(pst.dsHidden)) panelState.statistics.dsHidden = new Set(pst.dsHidden);
      if (pst.refDs !== undefined) panelState.statistics.refDs = pst.refDs || null;
    }
    if (pendingPanelState && pendingPanelState.swath && Array.isArray(pendingPanelState.swath.dsHidden)) {
      panelState.swath.dsHidden = new Set(pendingPanelState.swath.dsHidden);
    }
    if (pendingPanelState && pendingPanelState.categories && Array.isArray(pendingPanelState.categories.dsHidden)) {
      panelState.categories.dsHidden = new Set(pendingPanelState.categories.dsHidden);
    }

    // Re-render stats tab with restored state
    if (lastDisplayedStats && lastDisplayedHeader) {
      renderStatsTab(lastDisplayedStats, lastDisplayedHeader, currentOrigColCount || lastDisplayedHeader.length, currentFilter !== null, data.rowCount);
    }

    // Restore categories target + focused column by name (ws-v2 phase 1). The
    // target always restores; focusedCol resolves against the target header when
    // it's available (model now; a comparison target auto-focuses its first
    // column on render until that dataset is analyzed).
    const catP = restoredProject.categories || {};
    panelState.categories.catTargetDsId = catP.targetDsId || 'model';
    if (catP.focusedCol) {
      const ctid = panelState.categories.catTargetDsId;
      const chdr = (ctid === 'model') ? header : (((dsById(ctid) || {}).complete || {}).header || null);
      const ccats = (ctid === 'model') ? categories : (((dsById(ctid) || {}).complete || {}).categories || null);
      const idx = chdr ? chdr.indexOf(catP.focusedCol) : -1;
      if (idx >= 0 && ccats && ccats[idx]) {
        panelState.categories.focusedCol = idx;
        renderCatSidebar();
        renderCatMain();
      }
    }

    // A19: restore cross-tab target + the two columns BY NAME (resolved against
    // the target header; the later renderCrosstab() picks up these indices).
    if (typeof crosstabTargetDsId !== 'undefined') {
      const xtP = restoredProject.crosstab || {};
      crosstabTargetDsId = xtP.targetDsId || 'model';
      crosstabView = xtP.view || 'table';
      crosstabBarMode = xtP.barMode || 'stacked';
      crosstabCellMode = xtP.cellMode || 'count';
      const xtid = crosstabTargetDsId;
      const xhdr = (xtid === 'model') ? header : (((dsById(xtid) || {}).complete || {}).header || null);
      const ia = (xtP.colA && xhdr) ? xhdr.indexOf(xtP.colA) : -1;
      const ib = (xtP.colB && xhdr) ? xhdr.indexOf(xtP.colB) : -1;
      const iw = (xtP.weightCol && xhdr) ? xhdr.indexOf(xtP.weightCol) : -1;
      crosstabColA = ia >= 0 ? ia : null;
      crosstabColB = ib >= 0 ? ib : null;
      crosstabWeightCol = iw >= 0 ? iw : null;
    }
  }

  // StatsCat — render after display state is restored (or with defaults)
  renderStatsCat(data);
  if (typeof statsCatRenderAllInstances === 'function') statsCatRenderAllInstances();   // G4b: repaint cloned StatsCat panels

  // Export — always (re)build the MODEL's column list here (displayResults =
  // model analysis complete); a restored non-model target is applied lazily when
  // the Export tab switches to it (and it appears in the picker once it re-analyzes).
  var _savedExportTarget = exportTargetDsId;
  exportTargetDsId = 'model';
  initExportColumns();
  if (restoredProject) {
    if (restoredProject.exportCols) applyExportRestore(restoredProject.exportCols);
    if (restoredProject.exportSettings) restoreExportSettings(restoredProject.exportSettings);
  }
  exportTargetDsId = (_savedExportTarget && dsById(_savedExportTarget)) ? _savedExportTarget : 'model';
  if (typeof exportRenderDatasetPicker === 'function') exportRenderDatasetPicker();
  if (typeof exportRenderAllInstances === 'function') exportRenderAllInstances();   // G5b: repaint cloned Export panels

  // GT, Swath & Section
  // Snapshot current GT/Swath config before renders rebuild sidebars
  var gtSnapshot = null;
  var swathSnapshot = null;
  if (!restoredProject) {
    var snapSer = (document.getElementById('gtVarList') || document.getElementById('swathDirMode')) ? serializeProject() : null;
    if (snapSer) {
      gtSnapshot = snapSer.gt;
      swathSnapshot = snapSer.swath;
    }
  }
  renderGtConfig(data);
  renderSwathConfig(data);
  if (typeof renderCrosstab === 'function') renderCrosstab();   // A19 cross-tab sidebar (columns from the model analysis)
  if (typeof crosstabApplyAllInstances === 'function') crosstabApplyAllInstances();   // A19-clone: re-apply restored Cross-tab clone configs
  if (typeof swApplyAllInstances === 'function') swApplyAllInstances();      // s-5: re-apply restored clone configs
  if (typeof gtApplyAllInstances === 'function') gtApplyAllInstances();      // G3b-4: re-apply restored GT clone configs
  if (typeof swRefreshAllInstances === 'function') swRefreshAllInstances();  // follow-up: refresh live clone sidebars on re-analysis

  // Restore GT sidebar from project or snapshot
  var gtp = (restoredProject && restoredProject.gt) ? restoredProject.gt : gtSnapshot;
  if (gtp) {
    // Multi-grade checkbox restore (backward compat: old gradeCol string)
    var $gVarList = document.getElementById('gtVarList');
    if ($gVarList) {
      var names = gtp.gradeCols || (gtp.gradeCol ? [gtp.gradeCol] : []);
      var nameSet = {};
      for (var ni = 0; ni < names.length; ni++) nameSet[names[ni]] = true;
      var cbs = $gVarList.querySelectorAll('input[type="checkbox"]');
      for (var ci = 0; ci < cbs.length; ci++) {
        var lbl = cbs[ci].parentElement.querySelector('span').textContent;
        cbs[ci].checked = !!nameSet[lbl];
      }
    }
    // Group-by restore
    var $gGroupBy = document.getElementById('gtGroupBy');
    if ($gGroupBy && gtp.groupByCol) {
      for (var gbi = 0; gbi < $gGroupBy.options.length; gbi++) {
        if ($gGroupBy.options[gbi].textContent === gtp.groupByCol) { $gGroupBy.value = $gGroupBy.options[gbi].value; break; }
      }
    }
    var $gDensity = document.getElementById('gtDensityCol');
    var $gWeight = document.getElementById('gtWeightCol');
    if ($gDensity && gtp.densityCol) {
      for (var di = 0; di < $gDensity.options.length; di++) {
        if ($gDensity.options[di].textContent === gtp.densityCol) { $gDensity.value = $gDensity.options[di].value; break; }
      }
    }
    if ($gDensity && gtp.densityConst != null) {
      $gDensity.value = 'const';
      var $gDenConst = document.getElementById('gtDensityConst');
      var $gDenWrap = document.getElementById('gtDensityConstWrap');
      if ($gDenConst) $gDenConst.value = gtp.densityConst;
      if ($gDenWrap) $gDenWrap.style.display = 'flex';
    }
    if ($gWeight && gtp.weightCol) {
      for (var wi = 0; wi < $gWeight.options.length; wi++) {
        if ($gWeight.options[wi].textContent === gtp.weightCol) { $gWeight.value = $gWeight.options[wi].value; break; }
      }
    }
    var $gLocalFilter = document.getElementById('gtLocalFilter');
    if ($gLocalFilter && gtp.localFilter) $gLocalFilter.value = gtp.localFilter;
    var $gCutoffMin = document.getElementById('gtCutoffMin');
    var $gCutoffMax = document.getElementById('gtCutoffMax');
    var $gCutoffStep = document.getElementById('gtCutoffStep');
    if ($gCutoffMin && gtp.cutoffMin != null) $gCutoffMin.value = gtp.cutoffMin;
    if ($gCutoffMax && gtp.cutoffMax != null) $gCutoffMax.value = gtp.cutoffMax;
    if ($gCutoffStep && gtp.cutoffStep != null) $gCutoffStep.value = gtp.cutoffStep;
    if (gtp.cutoffMode === 'custom') {
      var $gRadio = document.querySelector('input[name="gtCutoffMode"][value="custom"]');
      if ($gRadio) { $gRadio.checked = true; $gRadio.dispatchEvent(new Event('change')); }
      var $gCustomText = document.getElementById('gtCutoffCustomText');
      if ($gCustomText && gtp.cutoffCustom) $gCustomText.value = gtp.cutoffCustom;
    }
    var $gVolOverride = document.getElementById('gtVolOverride');
    if ($gVolOverride && gtp.volumeOverride) $gVolOverride.value = gtp.volumeOverride;
    var $gTonnageUnit = document.getElementById('gtTonnageUnit');
    if ($gTonnageUnit && gtp.tonnageUnit != null) {
      $gTonnageUnit.value = gtp.tonnageUnit;
      $gTonnageUnit.dispatchEvent(new Event('change'));
    }
    var $gCTSym = document.getElementById('gtCustomTonnageSym');
    var $gCTDiv = document.getElementById('gtCustomTonnageDiv');
    if ($gCTSym && gtp.customTonnageSym) $gCTSym.value = gtp.customTonnageSym;
    if ($gCTDiv && gtp.customTonnageDiv) $gCTDiv.value = gtp.customTonnageDiv;
    var $gMetalUnit = document.getElementById('gtMetalUnit');
    if ($gMetalUnit && gtp.metalUnit != null) {
      $gMetalUnit.value = gtp.metalUnit;
      $gMetalUnit.dispatchEvent(new Event('change'));
    }
    var $gCMSym = document.getElementById('gtCustomMetalSym');
    var $gCMDiv = document.getElementById('gtCustomMetalDiv');
    if ($gCMSym && gtp.customMetalSym) $gCMSym.value = gtp.customMetalSym;
    if ($gCMDiv && gtp.customMetalDiv) $gCMDiv.value = gtp.customMetalDiv;
    var $gTDp = document.getElementById('gtTonnageDp');
    var $gGDp = document.getElementById('gtGradeDp');
    var $gMDp = document.getElementById('gtMetalDp');
    if ($gTDp && gtp.tonnageDp) $gTDp.value = gtp.tonnageDp;
    if ($gGDp && gtp.gradeDp) $gGDp.value = gtp.gradeDp;
    if ($gMDp && gtp.metalDp) $gMDp.value = gtp.metalDp;
    var $gTheoCb = document.getElementById('gtTheoEnabled');
    var $gTheoEng = document.getElementById('gtTheoEngine');
    var $gTheoF = document.getElementById('gtTheoF');
    var $gTheoFNum = document.getElementById('gtTheoFNum');
    if ($gTheoCb && gtp.theoEnabled != null) $gTheoCb.checked = !!gtp.theoEnabled;
    if ($gTheoEng && gtp.theoEngine) $gTheoEng.value = gtp.theoEngine;
    if (gtp.theoDsId !== undefined) gtTheoDsId = gtp.theoDsId;   // G2: restore the source dataset
    if (gtp.targetDsId !== undefined && typeof gtTargetDsId !== 'undefined') gtTargetDsId = gtp.targetDsId;   // G3: restore the GT target dataset
    if (gtp.theoF != null && isFinite(gtp.theoF)) {
      if ($gTheoF) $gTheoF.value = gtp.theoF;
      if ($gTheoFNum) $gTheoFNum.value = gtp.theoF;
    }

    // (per-variable grade units come from the catalog — renderGtConfig
    // reads it; legacy gt.gradeUnits migrate in migrateLegacyCatalog)

    // Restore group-by values and trigger checkbox population
    if (gtp.groupByCol && $gGroupBy && $gGroupBy.value !== '-1') {
      updateGroupByValues();
      // Restore selected groups
      if (gtp.selectedGroups) {
        var sg = gtp.selectedGroups;
        var valSet = new Set(sg.values || []);
        document.querySelectorAll('#gtGrpList input[type="checkbox"]').forEach(function(cb) {
          if (cb.value === '__total__') cb.checked = !!sg.showTotal;
          else cb.checked = valSet.has(cb.value);
        });
      }
    }
  }

  // Restore Swath sidebar from project or snapshot
  var swp = (restoredProject && restoredProject.swath) ? restoredProject.swath : swathSnapshot;
  if (swp) {
    // ws-v2 phase 1: restore the per-panel target (the picker/sidebar rebuild for
    // it when it's analyzed; swathTargetDs falls back if it's gone).
    if (typeof swathTargetDsId !== 'undefined') swathTargetDsId = swp.targetDsId || 'model';
    if (typeof swathTargetDsId !== 'undefined' && swathTargetDsId !== 'model'
        && document.getElementById('swathDirMode') && typeof renderSwathConfig === 'function') {
      renderSwathConfig(undefined);   // rebuild the singleton sidebar for the target (if analyzed; else falls back)
    }
    var $sStat = document.getElementById('swathStat');
    var $sFilter = document.getElementById('swathLocalFilter');
    var $sDirMode = document.getElementById('swathDirMode');
    // Back-compat: map old single-axis projects (axis/binWidth/azimuth/plunge)
    // onto the directions model — the old azimuth/plunge line is exactly
    // dipdir=azimuth, dip=plunge, rake=90, swathed along U only
    var swpDirMode = swp.dirMode, swpDirs = swp.directions;
    var swpDipDir = swp.dipDir, swpDip = swp.dip, swpRake = swp.rake;
    if (!swpDirs && swp.axis) {
      if (swp.axis === 'custom') {
        swpDirMode = 'custom';
        swpDipDir = swp.azimuth || 0;
        swpDip = swp.plunge || 0;
        swpRake = 90;
        swpDirs = { u: { on: true, bin: swp.binWidth || null }, v: { on: false }, w: { on: false } };
      } else {
        swpDirMode = 'ortho';
        swpDirs = { x: { on: false }, y: { on: false }, z: { on: false } };
        swpDirs[swp.axis] = { on: true, bin: swp.binWidth || null };
      }
    }
    if ($sDirMode && swpDirMode) {
      $sDirMode.value = swpDirMode;
      $sDirMode.dispatchEvent(new Event('change'));
    }
    if (swpDirs) {
      document.querySelectorAll('#swathSidebar .swath-dir-on').forEach(function(cb) {
        var conf = swpDirs[cb.dataset.dir];
        if (!conf) return;
        cb.checked = conf.on !== false;
        if (conf.bin) {
          var bi = document.getElementById('swathBin_' + cb.dataset.dir);
          if (bi) bi.value = conf.bin;
        }
      });
    }
    if (swpDipDir != null && document.getElementById('swathDipDir')) document.getElementById('swathDipDir').value = swpDipDir;
    if (swpDip != null && document.getElementById('swathDip')) document.getElementById('swathDip').value = swpDip;
    if (swpRake != null && document.getElementById('swathRake')) document.getElementById('swathRake').value = swpRake;
    if ($sStat && swp.stat) $sStat.value = swp.stat;
    if ($sFilter && swp.localFilter) $sFilter.value = swp.localFilter;
    // Restore checked variables by name
    if (swp.checkedVars && swp.checkedVars.length > 0) {
      var nameSet = {};
      for (var si = 0; si < swp.checkedVars.length; si++) nameSet[swp.checkedVars[si]] = true;
      document.querySelectorAll('#swathVarList .swath-var-item').forEach(function(item) {
        var name = item.querySelector('span').textContent;
        item.querySelector('input[type="checkbox"]').checked = !!nameSet[name];
      });
    }
    // (per-variable units, weight, and series colors come from the catalog —
    // the sidebar renderers read it directly)
    // Restore aux swath selection — stashed and applied when the aux rows
    // render (the aux file may not be reloaded yet in a fresh session)
    if (swp.auxCheckedVars) {
      pendingSwathAuxRestore = { checked: swp.auxCheckedVars };
    }
    renderSwathAuxVars();
    // Restore swath display options
    if (swp.display) {
      if (document.getElementById('swathShowBands')) document.getElementById('swathShowBands').checked = swp.display.showBands !== false;
      if (document.getElementById('swathShowCounts')) document.getElementById('swathShowCounts').checked = swp.display.showCounts !== false;
      if (document.getElementById('swathShowTable')) document.getElementById('swathShowTable').checked = swp.display.showTable !== false;
      if (document.getElementById('swathYScale') && swp.display.yScale) document.getElementById('swathYScale').value = swp.display.yScale;
      if (document.getElementById('swathLayout') && swp.display.layout) document.getElementById('swathLayout').value = swp.display.layout;
    }
  }

  // Restore active tab
  if (restoredProject && restoredProject.activeTab) {
    showPanel(restoredProject.activeTab);
  }
  // ws-v2 phase 2: restore the Import Model panel's Preview/Summary view. Old
  // projects used activeTab:'summary' (handled by showPanel above); new ones
  // carry modelView alongside activeTab:'preflight'.
  if (restoredProject && restoredProject.modelView === 'summary' && typeof setModelView === 'function') {
    setModelView('summary');
  }

  // Auto-save project
  autoSaveProject();

  // Update tab badges (wsTabBadge mirrors onto the rails tabs, C1b)
  wsTabBadge('statistics', 'Statistics', numCols.length);
  wsTabBadge('categories', 'Categories', catCols.length);
  wsTabBadge('calcols', 'Calc', currentCalcolMeta.length);
  wsTabBadge('export', 'Export', currentHeader.length);
  if (currentGroupBy !== null && (data.groupStats || data.groupCategories)) {
    const gbName = header[currentGroupBy] || '?';
    const firstGS = data.groupStats && Object.keys(data.groupStats)[0] ? data.groupStats[Object.keys(data.groupStats)[0]] : null;
    const firstGC = data.groupCategories && Object.keys(data.groupCategories)[0] ? data.groupCategories[Object.keys(data.groupCategories)[0]] : null;
    const groupCount = firstGS ? Object.keys(firstGS).length : (firstGC ? Object.keys(firstGC).length : 0);
    wsTabBadge('statscat', 'StatsCat', groupCount);
    $statsCatBadge.textContent = gbName + ' \u00B7 ' + groupCount + ' groups';
  } else {
    wsTabBadge('statscat', 'StatsCat', null);
    $statsCatBadge.textContent = '';
  }

  // Swath tab label (no badge until generated)
  wsTabBadge('swath', 'Swath', null);

  // Render calcol editor
  renderVariableBrowser();
  enableSimulatedDataSource();
}

// A10 G4a: which DATASET the StatsCat tab analyzes ('model' | 'aux' | 'd2' …).
// StatsCat generalizes beyond the model: any dataset can be broken down by a
// group-by category. The model resolves its UI state through the existing
// current*/statsCat* globals (so serializeProject, analysisFingerprint and the
// model startAnalysis keep reading them, and they are never polluted by a
// comparison's selection); a comparison dataset gets its own plain state object
// on ds.statsCat. There is ONE StatsCat panel (singleton DOM), so the render/
// wire functions resolve the current target internally via statsCatCtx() — no
// root threading needed (that is the G4b clone arc, later).
let statsCatTargetDsId = 'model';

// A10 G4b: clone arc. StatsCat clones into independent dockable panels. Group
// stats are dataset-bound (computed in the dataset's analyze pass with one
// group-by), so a clone is an independent VIEW onto a dataset's group stats — its
// independence is the TARGET DATASET (per-instance). The per-dataset selection
// (group-by/vars/display) still lives on the dataset (statsCatStateFor), so two
// clones on the SAME dataset mirror; the useful case is comparing DIFFERENT
// datasets side by side. The singleton resolves DOM via the $statsCat* refs +
// target via statsCatTargetDsId; a clone carries data-statcat-inst on its root,
// resolves DOM by [data-statcat=…] within root, and holds its own targetDsId.
var statsCatInstances = {};   // instId -> { targetDsId }
var statsCatInstanceEls = {}; // instId -> cloned DOM element
var statsCatInstSeq = 0;
function statsCatNextInstId() { return 'statscat#' + (++statsCatInstSeq); }
function statsCatNewInstState() { return { targetDsId: 'model' }; }
function statcatIsInst(root) { return surfaceIsInst(root, 'data-statcat-inst'); }
function statsCatInstTarget(root) {
  // clone target lives in its instance state; singleton in the module global.
  var st = surfaceInstState(root, 'data-statcat-inst', statsCatInstances, statsCatNewInstState);
  return st ? st.targetDsId : statsCatTargetDsId;
}
// DOM bundle for a panel: singleton → the $statsCat* refs; clone → [data-statcat].
function statcatEls(root) {
  if (!statcatIsInst(root)) {
    return { content: $statsCatContent, badge: $statsCatBadge, groupBy: $statsCatGroupBy, varList: $statsCatVarList,
      groupList: $statsCatGroupList, varSearch: $statsCatVarSearch, groupSearch: $statsCatGroupSearch,
      groupAll: $statsCatGroupAll, groupNone: $statsCatGroupNone, groupSort: $statsCatGroupSort,
      varAll: $statsCatVarAll, varNone: $statsCatVarNone, varFilter: $statsCatVarFilter,
      datasetWrap: document.getElementById('statsCatDatasetWrap') };
  }
  function q(n) { return root.querySelector('[data-statcat="' + n + '"]'); }
  return { content: q('statsCatContent'), badge: q('statsCatBadge'), groupBy: q('statsCatGroupBy'), varList: q('statsCatVarList'),
    groupList: q('statsCatGroupList'), varSearch: q('statsCatVarSearch'), groupSearch: q('statsCatGroupSearch'),
    groupAll: q('statsCatGroupAll'), groupNone: q('statsCatGroupNone'), groupSort: q('statsCatGroupSort'),
    varAll: q('statsCatVarAll'), varNone: q('statsCatVarNone'), varFilter: q('statsCatVarFilter'),
    datasetWrap: q('statsCatDatasetWrap') };
}

function statsCatNewState() {
  return { groupBy: null, selectedVars: new Set(), displayVar: null, checkedGroups: null, sortMode: null, showSelectedOnly: false };
}
// Accessor proxy: for the model, get/set route to the live core.js globals so
// every external reader (fingerprint/serialize/startAnalysis) stays bit-identical.
const _statsCatSingleton = {
  get groupBy() { return currentGroupBy; }, set groupBy(v) { currentGroupBy = v; },
  get selectedVars() { return statsCatSelectedVars; }, set selectedVars(v) { statsCatSelectedVars = v; },
  get displayVar() { return currentStatsCatVar; }, set displayVar(v) { currentStatsCatVar = v; },
  get checkedGroups() { return currentStatsCatChecked; }, set checkedGroups(v) { currentStatsCatChecked = v; },
  get sortMode() { return statsCatGroupSortMode; }, set sortMode(v) { statsCatGroupSortMode = v; },
  get showSelectedOnly() { return statsCatShowSelectedOnly; }, set showSelectedOnly(v) { statsCatShowSelectedOnly = v; }
};
function statsCatStateFor(dsId) {
  if (!dsId || dsId === 'model') return _statsCatSingleton;
  var ds = dsById(dsId);
  if (!ds) return _statsCatSingleton;
  if (!ds.statsCat) ds.statsCat = statsCatNewState();
  return ds.statsCat;
}
// Resolve the current StatsCat target + its analysis data + UI state. For the
// model: data is the cached lastStatsCatData; schema is the live current*
// globals (identical contents to the cached data → bit-identical render). For a
// comparison: data is ds.complete (group stats computed on demand by its own
// analyze pass, G4a-2); origColCount derives from header minus its calcols.
function statsCatCtx(root) {
  var ds = dsById(statsCatInstTarget(root)) || dsById('model');
  var isModel = ds.id === 'model';
  var S = statsCatStateFor(ds.id);
  var data, header, colTypes, origColCount;
  if (isModel) {
    data = lastStatsCatData;
    header = currentHeader || []; colTypes = currentColTypes || [];
    origColCount = currentOrigColCount || header.length;
  } else {
    data = ds.complete || null;
    header = (data && data.header) || []; colTypes = (data && data.colTypes) || [];
    origColCount = (data && data.origColCount) || (header.length - ((ds.calcolMeta || []).length));
  }
  return { ds: ds, isModel: isModel, S: S, data: data, header: header, colTypes: colTypes, origColCount: origColCount, els: statcatEls(root), root: root || null };
}

// G4a: the group stats StatsCat needs are produced by an analyze pass. When the
// config changes, the model marks the global analysis stale (its Analyze button);
// a comparison dataset marks ITS OWN analysis stale so its panel's Analyze button
// recomputes the group stats on demand (runAuxAnalysis now passes groupBy).
function statsCatMarkTargetStale(C) {
  C = C || statsCatCtx();
  if (C.isModel) { markAnalysisStale(); return; }
  if (C.ds && typeof markAuxStale === 'function') markAuxStale(C.ds, (typeof dsConfigRoot === 'function') ? dsConfigRoot(C.ds) : null);
}

// G4a: datasets the StatsCat tab can target — any with a completed analysis.
function statsCatTargetableDatasets() { return surfaceTargetableDatasets('analyzed'); }  // C10 P0
// The "Dataset" picker at the top of the StatsCat sidebar — shown only when 2+
// datasets are analyzed (with one, StatsCat is implicitly the model, as before).
function statsCatRenderDatasetPicker(root) {
  var els = statcatEls(root);
  var wrap = els.datasetWrap;
  if (!wrap) return;
  wrap.innerHTML = dsPickerHtml({ facet: 'analyzed', current: (dsById(statsCatInstTarget(root)) || dsById('model')).id,
    titleClass: 'statscat-sidebar-title', selectClass: 'statscat-select', selAttr: 'data-statcat-ds="1"' });
  var sel = wrap.querySelector('[data-statcat-ds]');
  if (sel) sel.onchange = function() { setStatsCatTarget(sel.value, root); };
}
// Switch the StatsCat target dataset (per-panel) and re-render that panel.
function setStatsCatTarget(id, root) {
  if (id === statsCatInstTarget(root)) return;
  if (statcatIsInst(root)) {
    var iid = root.getAttribute('data-statcat-inst');
    if (!statsCatInstances[iid]) statsCatInstances[iid] = statsCatNewInstState();
    statsCatInstances[iid].targetDsId = id;
  } else {
    statsCatTargetDsId = id;
  }
  var els = statcatEls(root);
  if (els.varSearch) els.varSearch.value = '';
  if (els.groupSearch) els.groupSearch.value = '';
  renderStatsCat(undefined, root);
  if (typeof autoSaveProject === 'function') autoSaveProject();
}
// G4a-3: serialize a comparison dataset's StatsCat selection BY NAME (loss-safe,
// survives column reordering / file re-supply). null when nothing is selected.
// A dataset awaiting reattach (no live analysis yet) re-emits its pending saved
// selection verbatim so an autosave mid-restore never drops it.
function statsCatSerializeFor(ds) {
  if (!ds) return null;
  var sc = ds.statsCat;
  var hdr = ds.complete && ds.complete.header;
  if (!sc || sc.groupBy == null || !hdr) return ds._pendingStatsCat || null;
  return {
    groupBy: (hdr[sc.groupBy] != null) ? hdr[sc.groupBy] : null,
    selectedVars: sc.selectedVars ? Array.from(sc.selectedVars).map(function(i) { return hdr[i]; }).filter(Boolean) : [],
    displayVar: (sc.displayVar != null && hdr[sc.displayVar] != null) ? hdr[sc.displayVar] : null,
    checkedGroups: sc.checkedGroups ? Array.from(sc.checkedGroups) : null,
    sortMode: (sc.sortMode != null) ? sc.sortMode : null,
    showSelectedOnly: !!sc.showSelectedOnly
  };
}
// Resolve a comparison dataset's pending (by-name) StatsCat selection into its
// live ds.statsCat (indices) once a header is known. Called before runAuxAnalysis
// (preflight header → group stats compute in the restore pass) and again from the
// complete handler (covers a calcol group-by, known only post-analysis).
function applyStatsCatRestore(ds, hdr) {
  if (!ds || !ds._pendingStatsCat) return;
  hdr = hdr || (ds.complete && ds.complete.header) || (ds.preflight && ds.preflight.header);
  if (!hdr) return;
  var pend = ds._pendingStatsCat;
  var nameToIdx = {};
  for (var i = 0; i < hdr.length; i++) nameToIdx[hdr[i]] = i;
  if (pend.groupBy != null && nameToIdx[pend.groupBy] == null) return;  // group-by col not present yet (e.g. calcol pre-analysis) — wait
  var sc = statsCatNewState();
  sc.groupBy = (pend.groupBy != null) ? nameToIdx[pend.groupBy] : null;
  sc.selectedVars = new Set((pend.selectedVars || []).map(function(n) { return nameToIdx[n]; }).filter(function(x) { return x != null; }));
  sc.displayVar = (pend.displayVar != null && nameToIdx[pend.displayVar] != null) ? nameToIdx[pend.displayVar] : null;
  sc.checkedGroups = pend.checkedGroups ? new Set(pend.checkedGroups) : null;
  sc.sortMode = (pend.sortMode != null) ? pend.sortMode : null;
  sc.showSelectedOnly = !!pend.showSelectedOnly;
  ds.statsCat = sc;
  ds._pendingStatsCat = null;
  // Repaint any panel (singleton or clone) currently targeting this dataset.
  statsCatForEachPanelTargeting(ds.id, function(root) { renderStatsCat(undefined, root); });
}

// Run fn(root) for every StatsCat panel (singleton + clones) targeting dsId.
function statsCatForEachPanelTargeting(dsId, fn) {
  if (statsCatTargetDsId === dsId) fn(undefined);
  Object.keys(statsCatInstances).forEach(function(iid) {
    if (statsCatInstances[iid].targetDsId === dsId) {
      var root = document.querySelector('[data-statcat-inst="' + iid + '"]');
      if (root) fn(root);
    }
  });
}

// Keep every panel's picker current as datasets analyze/clear; bounce a panel to
// the model only if its target is GONE from the registry (not merely unanalyzed).
function statsCatRefreshDatasetPicker() {
  if (statsCatTargetDsId !== 'model' && !dsById(statsCatTargetDsId)) {
    statsCatTargetDsId = 'model';
    renderStatsCat(undefined, undefined);
  } else {
    statsCatRenderDatasetPicker(undefined);
  }
  Object.keys(statsCatInstances).forEach(function(iid) {
    var root = document.querySelector('[data-statcat-inst="' + iid + '"]');
    if (!root) return;
    if (statsCatInstances[iid].targetDsId !== 'model' && !dsById(statsCatInstances[iid].targetDsId)) {
      statsCatInstances[iid].targetDsId = 'model';
      renderStatsCat(undefined, root);
    } else {
      statsCatRenderDatasetPicker(root);
    }
  });
}

// A10 G4b: build a cloned StatsCat panel. Clones #panelStatsCat, strips ids
// (DOM resolves by [data-statcat] within root), tags data-statcat-inst, wires the
// clone's group-by dropdown, and renders for the clone's target. Cached so rails'
// double renderPanel returns the same node.
function statsCatBuildInstancePanel(instId) {
  var tmpl = document.getElementById('panelStatsCat');
  if (!tmpl) return null;
  if (statsCatInstanceEls[instId] && document.contains(statsCatInstanceEls[instId])) return statsCatInstanceEls[instId];
  if (!statsCatInstances[instId]) statsCatInstances[instId] = statsCatNewInstState();
  var el = tmpl.cloneNode(true);
  el.removeAttribute('id');
  el.querySelectorAll('[id]').forEach(function(n) { n.removeAttribute('id'); });
  el.setAttribute('data-statcat-inst', instId);
  el.setAttribute('data-tab', instId);
  el.classList.add('active');
  var gb = el.querySelector('[data-statcat="statsCatGroupBy"]');
  if (gb) gb.addEventListener('change', function() { statsCatGroupByChanged(el); });
  renderStatsCat(lastStatsCatData, el);
  statsCatInstanceEls[instId] = el;
  return el;
}
function statsCatDisposeInstance(instId) { delete statsCatInstances[instId]; delete statsCatInstanceEls[instId]; }
// Re-render every clone (the shared per-dataset analysis changed).
function statsCatRenderAllInstances() {
  Object.keys(statsCatInstances).forEach(function(id) {
    var root = document.querySelector('[data-statcat-inst="' + id + '"]');
    if (root) renderStatsCat(undefined, root);
  });
}
function statsCatSerializeInstances() {
  return Object.keys(statsCatInstances).map(function(id) { return { id: id, targetDsId: statsCatInstances[id].targetDsId }; });
}
function statsCatRestoreInstances(list) {
  if (!Array.isArray(list)) return;
  list.forEach(function(rec) {
    if (!rec || !rec.id) return;
    statsCatInstances[rec.id] = { targetDsId: rec.targetDsId || 'model' };
    var n = parseInt(String(rec.id).replace(/^statscat#/, ''), 10);
    if (isFinite(n) && n > statsCatInstSeq) statsCatInstSeq = n;
  });
}
function statsCatResetInstances() {
  surfaceCloseInstTabs(statsCatInstances, statsCatDisposeInstance);
  statsCatInstances = {}; statsCatInstanceEls = {};
}

function renderStatsCat(data, root) {
  // The data arg is always the MODEL's analysis (displayResults/applyProject).
  // Cache it as the model's regardless of the current target, so switching back
  // shows fresh model results; then render whichever dataset is targeted.
  if (data) lastStatsCatData = data;
  const C = statsCatCtx(root);
  const els = C.els;
  statsCatRenderDatasetPicker(root);
  data = C.data;
  if (!data) {
    els.varList.innerHTML = '';
    els.groupList.innerHTML = '';
    els.content.innerHTML = '<div class="statscat-empty">Analyze ' + esc(dsLabel(C.ds.id)) + ' to see grouped statistics.</div>';
    return;
  }
  const S = C.S;
  const header = C.header, colTypes = C.colTypes;
  const groupStats = data.groupStats, groupCategories = data.groupCategories;
  const origColCount = C.origColCount;

  // Populate dropdown with categorical columns
  const catColIdxs = [];
  for (let i = 0; i < header.length; i++) {
    if (colTypes[i] === 'categorical') catColIdxs.push(i);
  }
  let opts = '<option value="">— select grouping column —</option>';
  for (const i of catColIdxs) {
    const sel = S.groupBy === i ? ' selected' : '';
    const isCalcol = i >= origColCount;
    opts += '<option value="' + i + '"' + sel + '>' + esc(header[i]) + (isCalcol ? ' (calc)' : '') + '</option>';
  }
  els.groupBy.innerHTML = opts;

  // If no groupBy selected or no groupStats, show empty states
  if (S.groupBy === null || !groupStats) {
    els.varList.innerHTML = '';
    els.groupList.innerHTML = '';
    els.content.innerHTML = '<div class="statscat-empty">Select a categorical column to see statistics broken down by group.</div>';
    return;
  }

  // Build combined variable list: numeric + categorical (excluding groupBy)
  const numCols = Object.keys(data.stats).map(Number).sort((a, b) => a - b);
  const catVarCols = [];
  for (let i = 0; i < header.length; i++) {
    if (colTypes[i] === 'categorical' && i !== S.groupBy) catVarCols.push(i);
  }
  const allVarCols = [...numCols, ...catVarCols].sort((a, b) => a - b);

  if (allVarCols.length === 0) {
    els.varList.innerHTML = '';
    els.groupList.innerHTML = '';
    els.content.innerHTML = '<div class="statscat-empty">No variables available for analysis.</div>';
    return;
  }

  // Initialize selected vars if empty (first time or after file change)
  if (S.selectedVars.size === 0) {
    for (const i of allVarCols) S.selectedVars.add(i);
  }

  // Auto-select first variable that has data for display
  if (S.displayVar === null || (!groupStats[S.displayVar] && !(groupCategories && groupCategories[S.displayVar]))) {
    const analyzed = allVarCols.filter(i => groupStats[i] || (groupCategories && groupCategories[i]));
    S.displayVar = analyzed.length > 0 ? analyzed[0] : allVarCols[0];
  }

  // Populate variable list
  renderStatsCatVarList(allVarCols, header, origColCount, colTypes, root);

  // Determine group values from selected variable (use whichever data source exists)
  const gs = groupStats[S.displayVar];
  const gc = groupCategories && groupCategories[S.displayVar];
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
  if (S.checkedGroups === null) {
    S.checkedGroups = new Set(allGroupKeys);
  }

  // Populate group list
  renderStatsCatGroupList(allGroups, root);

  // Wire sidebar events
  wireStatsCatSidebarEvents(allVarCols, header, origColCount, colTypes, root);

  // Render right content
  renderStatsCatContent(root);
}

function renderStatsCatVarList(allVarCols, header, origColCount, colTypes, root) {
  const C = statsCatCtx(root);
  const S = C.S, els = C.els;
  const search = els.varSearch.value.toLowerCase();
  let html = '';
  for (const colIdx of allVarCols) {
    if (S.showSelectedOnly && !S.selectedVars.has(colIdx)) continue;
    const name = header[colIdx];
    if (search && !fuzzyMatch(search, name.toLowerCase())) continue;
    const isCalcol = colIdx >= origColCount;
    const isCat = colTypes[colIdx] === 'categorical';
    const active = colIdx === S.displayVar ? ' active' : '';
    const checked = S.selectedVars.has(colIdx) ? ' checked' : '';
    const unchecked = !S.selectedVars.has(colIdx) ? ' unchecked' : '';
    html += '<div class="statscat-var-item' + active + unchecked + '" data-col="' + colIdx + '">';
    html += '<input type="checkbox"' + checked + ' data-col="' + colIdx + '">';
    html += '<span class="var-name">' + esc(name) + '</span>';
    if (isCalcol) html += '<span class="calcol-tag">CALC</span>';
    html += '<span class="var-type-tag ' + (isCat ? 'cat' : 'num') + '">' + (isCat ? 'CAT' : 'NUM') + '</span>';
    html += '</div>';
  }
  els.varList.innerHTML = html;
  // Update filter toggle state
  els.varFilter.textContent = S.showSelectedOnly ? 'Selected' : 'All';
  els.varFilter.classList.toggle('active', S.showSelectedOnly);
}

function getEffectiveStatsCatSort(root) {
  const C = statsCatCtx(root);
  if (C.S.sortMode !== null) return C.S.sortMode;
  // Inherit from Categories tab (the target dataset's group-by column)
  const gbColName = C.S.groupBy !== null && C.header[C.S.groupBy] ? C.header[C.S.groupBy] : null;
  const inh = gbColName ? (catVarPeek(C.ds.id, gbColName) || {}).sortMode : null;
  if (inh) return inh;
  return 'count-desc';
}

function sortStatsCatGroups(groups, root) {
  const mode = getEffectiveStatsCatSort(root);
  if (mode === 'alpha') {
    return groups.slice().sort((a, b) => (a[0] || '').localeCompare(b[0] || ''));
  }
  if (mode === 'count-asc') {
    return groups.slice().sort((a, b) => a[1].count - b[1].count);
  }
  if (mode === 'custom') {
    const C = statsCatCtx(root);
    const gbColName = C.S.groupBy !== null && C.header[C.S.groupBy] ? C.header[C.S.groupBy] : null;
    const order = gbColName ? ((catVarPeek(C.ds.id, gbColName) || {}).valueOrder || null) : null;
    if (order) {
      const pos = {};
      for (let i = 0; i < order.length; i++) pos[order[i]] = i;
      return groups.slice().sort((a, b) => {
        const pa = pos[a[0]] !== undefined ? pos[a[0]] : Infinity;
        const pb = pos[b[0]] !== undefined ? pos[b[0]] : Infinity;
        if (pa !== pb) return pa - pb;
        return b[1].count - a[1].count; // fallback: count-desc for unordered
      });
    }
  }
  // count-desc (default)
  return groups.slice().sort((a, b) => b[1].count - a[1].count);
}

function renderStatsCatGroupList(allGroups, root) {
  const C = statsCatCtx(root);
  const S = C.S, els = C.els;
  const sorted = sortStatsCatGroups(allGroups, root);
  const search = els.groupSearch.value.toLowerCase();
  let html = '';
  for (const [gv, s] of sorted) {
    const label = gv || '(empty)';
    if (search && !fuzzyMatch(search, label.toLowerCase())) continue;
    const checked = S.checkedGroups && S.checkedGroups.has(gv) ? ' checked' : '';
    html += '<div class="statscat-group-item">';
    html += '<label><input type="checkbox"' + checked + ' data-gv="' + esc(gv) + '"> <span class="gname">' + esc(label) + '</span></label>';
    html += '<span class="gcount">' + s.count.toLocaleString() + '</span>';
    html += '</div>';
  }
  els.groupList.innerHTML = html;
}

function getStatsCatGroupEntries(root) {
  const C = statsCatCtx(root);
  const data = C.data;
  if (!data || !data.groupStats) return [];
  const gs = data.groupStats[C.S.displayVar];
  const gc = data.groupCategories && data.groupCategories[C.S.displayVar];
  if (gs) return Object.entries(gs);
  if (gc) return Object.entries(gc).map(([gv, counts]) => [gv, { count: Object.values(counts).reduce((s, c) => s + c, 0) }]);
  return [];
}

function wireStatsCatSidebarEvents(allVarCols, header, origColCount, colTypes, root) {
  const C = statsCatCtx(root);
  const S = C.S, els = C.els;
  const rewire = () => wireStatsCatSidebarEvents(allVarCols, header, origColCount, colTypes, root);
  const reVarList = () => renderStatsCatVarList(allVarCols, header, origColCount, colTypes, root);
  const reGroupList = (g) => renderStatsCatGroupList(g || getStatsCatGroupEntries(root), root);
  const reContent = () => renderStatsCatContent(root);
  const groupEntries = () => getStatsCatGroupEntries(root);
  // G4a: re-analysis signal routes to the target — the model marks the global
  // analysis stale; a comparison dataset marks ITS OWN analysis stale (its
  // Analyze button recomputes the group stats on demand).
  const markTargetStale = () => statsCatMarkTargetStale(C);
  // Variable row click — select for display (ignore if click was on checkbox)
  els.varList.querySelectorAll('.statscat-var-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT') return;
      const colIdx = parseInt(el.dataset.col);
      if (colIdx === S.displayVar) return;
      S.displayVar = colIdx;

      reVarList();
      reGroupList();
      rewire();
      reContent();
      autoSaveProject();
    });
  });

  // Variable checkboxes — toggle inclusion for analysis
  els.varList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      const colIdx = parseInt(cb.dataset.col);
      if (cb.checked) {
        S.selectedVars.add(colIdx);
        // Only mark stale if this column lacks data from last analysis
        if (C.data && C.data.groupStats && !(C.data.groupStats[colIdx] || (C.data.groupCategories && C.data.groupCategories[colIdx]))) {
          markTargetStale();
        }
      } else {
        S.selectedVars.delete(colIdx);
        // Unchecking never needs re-analysis — data already computed
      }
      reVarList();
      rewire();
      autoSaveProject();
    });
  });

  // Variable All/None — affect only search-filtered results
  els.varAll.onclick = () => {
    let needsStale = false;
    els.varList.querySelectorAll('.statscat-var-item').forEach(el => {
      const ci = parseInt(el.dataset.col);
      S.selectedVars.add(ci);
      if (C.data && C.data.groupStats && !(C.data.groupStats[ci] || (C.data.groupCategories && C.data.groupCategories[ci]))) {
        needsStale = true;
      }
    });
    reVarList();
    rewire();
    if (needsStale) markTargetStale();
    autoSaveProject();
  };
  els.varNone.onclick = () => {
    els.varList.querySelectorAll('.statscat-var-item').forEach(el => {
      S.selectedVars.delete(parseInt(el.dataset.col));
    });
    reVarList();
    rewire();
    // Unchecking never needs re-analysis
    autoSaveProject();
  };

  // Variable filter toggle (All / Selected)
  els.varFilter.onclick = () => {
    S.showSelectedOnly = !S.showSelectedOnly;
    reVarList();
    rewire();
    autoSaveProject();
  };

  // Group checkboxes
  els.groupList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const gv = cb.dataset.gv;
      if (cb.checked) { S.checkedGroups.add(gv); } else { S.checkedGroups.delete(gv); }
      reContent();
      autoSaveProject();
    });
  });

  // All/None buttons
  els.groupAll.onclick = () => {
    const entries = groupEntries();
    S.checkedGroups = new Set(entries.map(e => e[0]));
    reGroupList(entries);
    rewire();
    reContent();
    autoSaveProject();
  };
  els.groupNone.onclick = () => {
    S.checkedGroups = new Set();
    reGroupList();
    rewire();
    reContent();
    autoSaveProject();
  };

  // Sort toggle — cycle: count-desc → count-asc → alpha → custom (if exists) → count-desc
  var sortLabels = { 'count-desc': 'Count\u2193', 'count-asc': 'Count\u2191', 'alpha': 'A-Z', 'custom': 'Custom' };
  els.groupSort.textContent = sortLabels[getEffectiveStatsCatSort(root)] || 'Count\u2193';
  els.groupSort.onclick = () => {
    var eff = getEffectiveStatsCatSort(root);
    var gbColName = S.groupBy !== null && C.header[S.groupBy] ? C.header[S.groupBy] : null;
    var gbOrder = gbColName ? (catVarPeek(C.ds.id, gbColName) || {}).valueOrder : null;
    var hasCustom = !!(gbOrder && gbOrder.length > 0);
    var cycle = ['count-desc', 'count-asc', 'alpha'];
    if (hasCustom) cycle.push('custom');
    var idx = cycle.indexOf(eff);
    S.sortMode = cycle[(idx + 1) % cycle.length];
    els.groupSort.textContent = sortLabels[getEffectiveStatsCatSort(root)];
    reGroupList();
    rewire();
    reContent();
    autoSaveProject();
  };

  // Variable search
  els.varSearch.oninput = () => { reVarList(); rewire(); };
  wireSearchShortcuts(els.varSearch, els.varAll, els.varNone);

  // Group search
  els.groupSearch.oninput = () => { reGroupList(); rewire(); };
  wireSearchShortcuts(els.groupSearch, els.groupAll, els.groupNone);

}

function renderStatsCatContent(root) {
  const C = statsCatCtx(root);
  const S = C.S, els = C.els;
  const data = C.data;
  if (!data) {
    els.content.innerHTML = '<div class="statscat-empty">No grouped statistics available.</div>';
    return;
  }
  if (S.displayVar === null) {
    els.content.innerHTML = '<div class="statscat-empty">Select a variable from the sidebar.</div>';
    return;
  }
  if (!S.checkedGroups || S.checkedGroups.size === 0) {
    els.content.innerHTML = '<div class="statscat-empty">No groups selected. Check groups in the sidebar to view statistics.</div>';
    return;
  }

  const header = C.header;
  const colTypes = C.colTypes;
  const origColCount = C.origColCount;
  const varName = header[S.displayVar];
  const isCalcol = S.displayVar >= origColCount;
  const isCatVar = colTypes[S.displayVar] === 'categorical';

  if (isCatVar) {
    renderStatsCatCrossTab(data, varName, isCalcol, root);
  } else {
    renderStatsCatNumeric(data, varName, isCalcol, root);
  }
}

// A9 F7: the analyze pass caps grouped accumulators at 500 distinct group
// values — say so instead of quietly truncating the breakdown
function statsCatOverflowNote(data) {
  return data && data.groupStatsOverflow
    ? '<div class="warn-note">Group cap reached (500) — rows beyond the first 500 group values are not in this breakdown. Filter the data or group by a lower-cardinality column.</div>'
    : '';
}

function renderStatsCatNumeric(data, varName, isCalcol, root) {
  const C = statsCatCtx(root);
  const S = C.S, els = C.els;
  const gs = data.groupStats[S.displayVar];
  if (!gs) {
    els.content.innerHTML = '<div class="statscat-empty">This variable was not included in the analysis. Check its checkbox and click Analyze.</div>';
    return;
  }

  // Filter entries to checked groups, apply current sort
  const entries = sortStatsCatGroups(
    Object.entries(gs).filter(([gv]) => S.checkedGroups.has(gv)), root
  );

  // Header with copy button
  let html = statsCatOverflowNote(data);
  html += '<div style="display:flex;align-items:center;gap:0.8rem;margin-bottom:0.5rem;">';
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
    html += '<td>' + (cv !== null ? (cv > 9999 ? '>9999' : cv.toFixed(1)) : '\u2014') + '</td>';
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
  html += renderOverlaidCDF(entries, varName, root);

  els.content.innerHTML = html;
  wireStatsCatCopyBtn(root);
  wireStatsCatCdfToolbar(root);
}

function renderStatsCatCrossTab(data, varName, isCalcol, root) {
  const C = statsCatCtx(root);
  const S = C.S, els = C.els;
  const gc = data.groupCategories && data.groupCategories[S.displayVar];
  if (!gc) {
    els.content.innerHTML = '<div class="statscat-empty">This variable was not included in the analysis. Check its checkbox and click Analyze.</div>';
    return;
  }

  // Get checked groups
  const groupKeys = sortStatsCatGroups(
    Object.entries(gc).filter(([gv]) => S.checkedGroups.has(gv)).map(([gv, counts]) => [gv, { count: Object.values(counts).reduce((s, c) => s + c, 0) }]), root
  ).map(([gv]) => gv);

  // Collect all unique values across checked groups
  const allVals = new Set();
  for (const gv of groupKeys) {
    if (gc[gv]) for (const v of Object.keys(gc[gv])) allVals.add(v);
  }
  const valList = Array.from(allVals).sort();

  // Header
  let html = statsCatOverflowNote(data);
  html += '<div style="display:flex;align-items:center;gap:0.8rem;margin-bottom:0.5rem;">';
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

  els.content.innerHTML = html;
  wireStatsCatCopyBtn(root);
  wireStatsCatCrossMode(root);
}

function wireStatsCatCrossMode(root) {
  var content = statcatEls(root).content;
  content.querySelectorAll('.ct-mode').forEach(btn => {
    btn.addEventListener('click', () => {
      statsCatCrossMode = btn.dataset.mode;
      renderStatsCatContent(root);
      autoSaveProject();
    });
  });
}

function renderOverlaidCDF(entries, varName, root) {
  const plotEntries = entries.filter(([, s]) => s.centroids && s.centroids.length > 0);
  if (plotEntries.length === 0) return '';

  const isLog = statsCatCdfScale === 'log';
  const W = chartHostWidth(statcatEls(root).content || document.getElementById('statsCatContent'), 700, 560, 40), plotBaseH = 380;
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
    gridSvg += '<line x1="' + pad.left + '" y1="' + y + '" x2="' + (W - pad.right) + '" y2="' + y + '" stroke="var(--chart-grid)" stroke-width="1"/>';
    gridSvg += '<text x="' + (pad.left - 8) + '" y="' + (y + 3.5) + '" text-anchor="end" fill="var(--chart-ink)" font-size="10">' + (yt * 100).toFixed(0) + '%</text>';
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
    gridSvg += '<line x1="' + x + '" y1="' + pad.top + '" x2="' + x + '" y2="' + (plotBaseH - pad.bottom) + '" stroke="var(--chart-grid)" stroke-width="1"/>';
    const label = Math.abs(v) >= 1e5 || (Math.abs(v) < 0.01 && v !== 0) ? v.toExponential(1) : v.toFixed(Math.abs(v) < 10 ? 2 : 0);
    gridSvg += '<text x="' + x + '" y="' + (plotBaseH - pad.bottom + 16) + '" text-anchor="middle" fill="var(--chart-ink)" font-size="10">' + label + '</text>';
  }

  let curvesSvg = '';
  let meansSvg = '';
  const _scC = statsCatCtx(root);
  const gbColName = _scC.S.groupBy !== null ? _scC.header[_scC.S.groupBy] : '';
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
    legendSvg += '<text x="' + (lx + 24) + '" y="' + (ly + 9) + '" fill="var(--chart-ink)" font-size="9.5">' + esc(gv || '(empty)') + '</text>';
  }

  const scaleLabel = isLog ? ' (log)' : '';
  const svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" style="font-family:var(--mono)" id="statsCatCdfSvg">' +
    '<rect width="' + W + '" height="' + H + '" fill="var(--bg)" rx="4"/>' +
    gridSvg + meansSvg + curvesSvg +
    '<text x="' + (W / 2) + '" y="' + (plotBaseH - 4) + '" text-anchor="middle" fill="var(--chart-ink)" font-size="10">CDF' + scaleLabel + ' \u2014 ' + esc(varName) + '</text>' +
    '<text x="12" y="' + (plotBaseH / 2) + '" text-anchor="middle" fill="var(--chart-ink)" font-size="10" transform="rotate(-90, 12, ' + (plotBaseH / 2) + ')">Cumulative %</text>' +
    legendSvg +
    '</svg>';

  return '<div class="statscat-cdf-plot">' + svg + '</div>';
}

function wireStatsCatCdfToolbar(root) {
  const content = statcatEls(root).content;
  const q = (sel) => content.querySelector(sel);
  // Scale buttons
  content.querySelectorAll('.sc-scale').forEach(btn => {
    btn.addEventListener('click', () => {
      statsCatCdfScale = btn.dataset.scale;
      renderStatsCatContent(root);
      autoSaveProject();
    });
  });
  // Manual checkbox
  const manualCb = q('#scManualCb');
  if (manualCb) {
    manualCb.addEventListener('change', () => {
      statsCatCdfManual = manualCb.checked;
      if (!statsCatCdfManual) { statsCatCdfMin = null; statsCatCdfMax = null; }
      renderStatsCatContent(root);
      autoSaveProject();
    });
  }
  // Manual min/max inputs
  const minInput = q('#scManualMin');
  const maxInput = q('#scManualMax');
  if (minInput) {
    minInput.addEventListener('change', () => {
      statsCatCdfMin = minInput.value !== '' ? parseFloat(minInput.value) : null;
      renderStatsCatContent(root);
      autoSaveProject();
    });
  }
  if (maxInput) {
    maxInput.addEventListener('change', () => {
      statsCatCdfMax = maxInput.value !== '' ? parseFloat(maxInput.value) : null;
      renderStatsCatContent(root);
      autoSaveProject();
    });
  }
  // Copy SVG
  const copySvg = q('#scCopySvg');
  if (copySvg) {
    copySvg.addEventListener('click', () => {
      const svgEl = q('#statsCatCdfSvg');
      if (!svgEl) return;
      navigator.clipboard.writeText(svgEl.outerHTML).then(() => {
        copySvg.textContent = 'Copied!';
        setTimeout(() => { copySvg.textContent = 'Copy SVG'; }, 1500);
      });
    });
  }
  // Download PNG — light theme for documents
  const dlPng = q('#scDownloadPng');
  if (dlPng) {
    dlPng.addEventListener('click', () => {
      const svgEl = q('#statsCatCdfSvg');
      if (!svgEl) return;
      let svgData = new XMLSerializer().serializeToString(svgEl);
      // Retheme for light background: white bg, dark text/lines
      svgData = svgData.replace(/fill="var\(--bg\)"/g, 'fill="white"');
      svgData = svgData.replace(/fill="var(--chart-ink)"/g, 'fill="#555"');
      svgData = svgData.replace(/stroke="var(--chart-grid)"/g, 'stroke="#ddd"');
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

function wireStatsCatCopyBtn(root) {
  const content = statcatEls(root).content;
  const btn = content.querySelector('#statsCatCopyBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const table = content.querySelector('table.stats');
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
function prePopulateStatsCatVars(root) {
  const C = statsCatCtx(root);
  const S = C.S, els = C.els;
  const header = C.header;
  const colTypes = C.colTypes;
  const origColCount = C.origColCount;
  if (header.length === 0) return;

  // Build combined variable list: numeric + categorical (excluding groupBy)
  const allVarCols = [];
  for (let i = 0; i < header.length; i++) {
    if (i === S.groupBy) continue;
    if (colTypes[i] === 'numeric' || colTypes[i] === 'categorical') allVarCols.push(i);
  }
  allVarCols.sort((a, b) => a - b);

  // Initialize selected vars if empty
  if (S.selectedVars.size === 0) {
    for (const i of allVarCols) S.selectedVars.add(i);
  }

  // Auto-select first variable for display
  if (S.displayVar === null) {
    S.displayVar = allVarCols.length > 0 ? allVarCols[0] : null;
  }

  // Render variable list
  renderStatsCatVarList(allVarCols, header, origColCount, colTypes, root);

  // Clear group list (no data yet)
  els.groupList.innerHTML = '';

  // Show prompt in content
  els.content.innerHTML = '<div class="statscat-empty">Configure variables and click Analyze to compute grouped statistics.</div>';

  // Wire sidebar events (variable clicks, checkboxes, search, analyze button)
  wireStatsCatSidebarEvents(allVarCols, header, origColCount, colTypes, root);
}

// StatsCat group-by dropdown — singleton (#statsCatGroupBy) directly; clones via
// delegation in statsCatBuildInstancePanel. statsCatGroupByChanged does the work.
function statsCatGroupByChanged(root) {
  const C = statsCatCtx(root);
  const S = C.S, els = C.els;
  const val = els.groupBy.value;
  S.groupBy = val ? parseInt(val) : null;
  S.displayVar = null;
  S.checkedGroups = null;
  S.sortMode = null; // re-inherit from Categories
  S.showSelectedOnly = false;
  els.varSearch.value = '';
  els.groupSearch.value = '';
  if (S.groupBy !== null) {
    prePopulateStatsCatVars(root);
  } else {
    els.varList.innerHTML = '';
    els.groupList.innerHTML = '';
    els.content.innerHTML = '<div class="statscat-empty">Select a categorical column to see statistics broken down by group.</div>';
  }
  statsCatMarkTargetStale(C);
  autoSaveProject();
}
$statsCatGroupBy.addEventListener('change', () => statsCatGroupByChanged());

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

