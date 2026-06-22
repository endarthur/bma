// ─── C11-P0: FSAA-mounted project folder (mount + persist handle) ──────────
// File System Access API. A mounted folder becomes the project home: source files
// resolve by name on open (P1) and materialized derived outputs write into it (P2).
// P0 is the foundation: mount a folder, persist the directory handle in IDB,
// re-grant permission on reopen (Chromium persists the grant → one click), and
// feature-detect / degrade where FSAA is absent (Firefox/Safari keep today's
// drop/pack flow untouched). Design: docs/fsaa-project-folders.md.

var mountedFolder = null;   // the FileSystemDirectoryHandle when mounted, else null

function fsaaSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

// IDB 'handles' store (bma-cache v3, created in openCacheDB). Directory handles
// are structured-cloneable, so they persist across sessions.
function fsaaStoreHandle(handle) {
  return openCacheDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').put(handle, 'projectFolder');
      tx.oncomplete = function () { resolve(true); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}
function fsaaLoadHandle() {
  return openCacheDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('handles', 'readonly');
      var req = tx.objectStore('handles').get('projectFolder');
      tx.oncomplete = function () { resolve(req.result || null); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}
function fsaaClearHandle() {
  return openCacheDB().then(function (db) {
    return new Promise(function (resolve) {
      var tx = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').delete('projectFolder');
      tx.oncomplete = function () { resolve(true); };
    });
  });
}

// Ensure read/write permission on a handle, re-requesting inside a user gesture
// when needed. A handle without the permission API (older browsers / test mocks)
// is treated as granted.
function fsaaEnsurePermission(handle, write) {
  if (!handle || typeof handle.queryPermission !== 'function') return Promise.resolve(true);
  var opts = { mode: write ? 'readwrite' : 'read' };
  return Promise.resolve(handle.queryPermission(opts)).then(function (p) {
    if (p === 'granted') return true;
    if (typeof handle.requestPermission !== 'function') return false;
    return Promise.resolve(handle.requestPermission(opts)).then(function (p2) { return p2 === 'granted'; });
  });
}

// Mount a folder (must run in a user gesture). Sets mountedFolder + persists it.
function fsaaMountFolder() {
  if (!fsaaSupported()) return Promise.resolve(false);
  return Promise.resolve(window.showDirectoryPicker({ mode: 'readwrite' })).then(function (handle) {
    return fsaaEnsurePermission(handle, true).then(function (ok) {
      if (!ok) return false;
      mountedFolder = handle;
      // store failures (quota / non-cloneable mock) are non-fatal — the folder is
      // mounted for this session regardless.
      return fsaaStoreHandle(handle).catch(function () {}).then(function () { fsaaAfterMountChange(); return true; });
    });
  }).catch(function () { return false; });   // AbortError = user cancelled the picker
}

// Reopen a previously mounted folder (re-grant in a gesture). For the explicit
// "reopen folder" affordance.
function fsaaReopenFolder() {
  return fsaaLoadHandle().then(function (handle) {
    if (!handle) return false;
    return fsaaEnsurePermission(handle, true).then(function (ok) {
      if (!ok) return false;
      mountedFolder = handle;
      fsaaAfterMountChange();
      return true;
    });
  });
}

// On load, silently re-mount if the persisted grant is still 'granted' (query
// needs no gesture). 'prompt' is left for an explicit reopen click. So reopening
// feels like "open recent", not a fresh pick.
function fsaaTryRestoreOnLoad() {
  return fsaaLoadHandle().then(function (handle) {
    if (!handle) return false;
    if (typeof handle.queryPermission !== 'function') { mountedFolder = handle; fsaaAfterMountChange(); return true; }
    return Promise.resolve(handle.queryPermission({ mode: 'readwrite' })).then(function (p) {
      if (p === 'granted') { mountedFolder = handle; fsaaAfterMountChange(); return true; }
      return false;
    });
  }).catch(function () { return false; });
}

function fsaaUnmount() {
  mountedFolder = null;
  return fsaaClearHandle().catch(function () {}).then(function () { fsaaAfterMountChange(); });
}

// The mounted folder's display name (or null).
function fsaaFolderName() { return mountedFolder ? (mountedFolder.name || 'folder') : null; }

// ── C11-P1: read/write files in the mounted folder ────────────────────────
// Resolve a source file from the folder by NAME (replaces re-drop). Returns the
// File, or null if no folder is mounted / the file isn't there.
function fsaaResolveFile(name) {
  if (!name || !mountedFolder || typeof mountedFolder.getFileHandle !== 'function') return Promise.resolve(null);
  return Promise.resolve(mountedFolder.getFileHandle(name)).then(function (fh) {
    return fh.getFile();
  }).catch(function () { return null; });
}
// Write a blob into the folder (create or overwrite). The no-silent-loss rule
// extends to disk: callers only write derived/project files, never a user source.
function fsaaWriteFile(name, blob) {
  if (!name || !mountedFolder || typeof mountedFolder.getFileHandle !== 'function') return Promise.resolve(false);
  return Promise.resolve(mountedFolder.getFileHandle(name, { create: true })).then(function (fh) {
    return fh.createWritable().then(function (w) {
      return Promise.resolve(w.write(blob)).then(function () { return w.close(); });
    });
  }).then(function () { return true; }).catch(function () { return false; });
}
// C11-P1: resolve a restored project's still-pending source files from the folder
// by NAME — the loose/localStorage path that otherwise needs a manual re-drop.
// Comparison datasets (d2+) awaiting their file + drillhole trios awaiting re-drop.
// Idempotent: anything already supplied / not in the folder is left untouched.
function fsaaResolveProjectFiles() {
  if (!mountedFolder || typeof datasets === 'undefined') return Promise.resolve(0);
  var jobs = [], n = { c: 0 };
  // comparison datasets (d2+) awaiting their own file
  datasets.forEach(function (ds) {
    if (!ds || ds.id === 'model' || ds.id === 'aux' || ds.file || ds.derivedFrom) return;   // emits re-derive; model/aux handled elsewhere
    var cfg = ds._pendingRestore, fname = cfg && cfg.fileName;
    if (!fname) return;
    jobs.push(fsaaResolveFile(fname).then(function (f) {
      if (f && !ds.file && typeof loadAuxFile === 'function') {
        n.c++;
        loadAuxFile(f, null, undefined, ds, (typeof dsConfigRoot === 'function') ? dsConfigRoot(ds) : null);
      }
    }));
  });
  // drillhole trios awaiting re-drop (any set whose files aren't loaded yet)
  if (typeof dhStates === 'object' && dhStates && typeof dhLoadTrio === 'function') {
    Object.keys(dhStates).forEach(function (id) {
      var D = dhStates[id], pr = D && D.pendingRestore;
      if (!pr || !pr.files || (D.files && D.files.collar)) return;
      var dds = (typeof dsById === 'function') ? dsById(id) : null;
      if (!dds) return;
      var roles = ['collar', 'survey', 'intervals'];
      if (pr.files.secondary) roles.push('secondary');
      jobs.push(Promise.all(roles.map(function (r) { return pr.files[r] ? fsaaResolveFile(pr.files[r].name) : Promise.resolve(null); })).then(function (fl) {
        var trio = { collar: fl[0], survey: fl[1], intervals: fl[2] };
        if (pr.files.secondary) trio.secondary = fl[3];
        if (trio.collar && trio.survey && trio.intervals) { n.c++; return dhLoadTrio(dds, trio); }
      }));
    });
  }
  return Promise.all(jobs).then(function () { return n.c; });
}

// The project JSON's filename in the folder (stable per project title / model).
function fsaaProjectJsonName() {
  var stem = (typeof projectTitle !== 'undefined' && projectTitle) ? projectTitle
    : (typeof currentFile !== 'undefined' && currentFile ? currentFile.name.replace(/\.[^.]+$/, '') : 'project');
  return String(stem).replace(/[\\/:*?"<>|]+/g, '_') + '.bma.json';
}
function fsaaWriteProjectJson(jsonStr) {
  if (!mountedFolder) return Promise.resolve(false);
  return fsaaWriteFile(fsaaProjectJsonName(), new Blob([jsonStr], { type: 'application/json' }));
}

// Header pill + landing note showing the folder backing (Arthur's ask).
function fsaaRenderIndicator() {
  var name = fsaaFolderName();
  var hdr = document.getElementById('fsaaIndicator');
  if (hdr) { hdr.textContent = name ? ('📁 ' + name) : ''; hdr.style.display = name ? '' : 'none'; }
  var land = document.getElementById('landingFsaa');
  if (land) {
    var e = (typeof esc === 'function') ? esc : function (s) { return s; };
    land.innerHTML = name ? ('📁 Folder-backed: <b>' + e(name) + '</b> — source files resolve from here, no re-drop') : '';
    land.style.display = name ? '' : 'none';
  }
}

// Reflect a mount change: render the indicator + persist the project into the new
// folder. The File menu is a live factory, so it picks up mountedFolder on open.
function fsaaAfterMountChange() {
  fsaaRenderIndicator();
  if (mountedFolder && typeof autoSaveProject === 'function') autoSaveProject();
}

// Silent restore on startup (no-op where unsupported / no saved handle).
if (typeof indexedDB !== 'undefined') { try { fsaaTryRestoreOnLoad(); } catch (e) {} }
