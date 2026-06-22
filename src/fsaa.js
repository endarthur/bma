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
      return fsaaStoreHandle(handle).catch(function () {}).then(function () { fsaaAfterMountChange(); fsaaMaybeOpenProject(); return true; });
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
  function activate(handle) {
    mountedFolder = handle;
    fsaaAfterMountChange();
    // C11-P3: reopening the folder reopens its project. Defer so the app is fully
    // initialized before driving handleFile; guarded so it never clobbers an
    // already-open project.
    setTimeout(function () { fsaaMaybeOpenProject(); }, 0);
    return true;
  }
  return fsaaLoadHandle().then(function (handle) {
    if (!handle) return false;
    if (typeof handle.queryPermission !== 'function') return activate(handle);
    return Promise.resolve(handle.queryPermission({ mode: 'readwrite' })).then(function (p) {
      return p === 'granted' ? activate(handle) : false;
    });
  }).catch(function () { return false; });
}
// Open the folder's project iff nothing is loaded yet (folder-as-home).
function fsaaMaybeOpenProject() {
  if (mountedFolder && (typeof currentFile === 'undefined' || !currentFile)) return fsaaOpenProjectFromFolder();
  return Promise.resolve(false);
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

// ── C11-P3: folder-as-project-home ────────────────────────────────────────
// Find a project JSON (*.bma.json) in the mounted folder.
async function fsaaListProjectJson() {
  if (!mountedFolder || typeof mountedFolder.keys !== 'function') return null;
  try {
    for await (var name of mountedFolder.keys()) {
      if (/\.bma\.json$/i.test(name)) return name;
    }
  } catch (e) { /* iteration unsupported */ }
  return null;
}
// Open the project stored in the folder: read its *.bma.json, resolve the model
// from the folder by name, and apply it through the normal dropped-project path
// (comparison datasets + drillhole trios then resolve from the folder too, C11-P1).
// So mounting the folder opens the whole project — no drop.
function fsaaOpenProjectFromFolder() {
  if (!mountedFolder) return Promise.resolve(false);
  return fsaaListProjectJson().then(function (name) {
    if (!name) return false;
    return fsaaResolveFile(name).then(function (jf) {
      if (!jf) return false;
      return jf.text().then(function (txt) {
        var pj; try { pj = JSON.parse(txt); } catch (e) { return false; }
        if (!pj || pj._bma !== 1 || !pj.file || !pj.file.name) return false;   // model-less folders: a later slice
        return fsaaResolveFile(pj.file.name).then(function (mf) {
          if (!mf) return false;   // the model isn't in the folder
          if (typeof pendingDroppedProject !== 'undefined') pendingDroppedProject = pj;
          if (typeof handleFile === 'function') return Promise.resolve(handleFile(mf)).then(function () { return true; });
          return false;
        });
      });
    });
  }).catch(function () { return false; });
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

// Landing affordances (the starting-screen mount — the File-menu one needs a
// loaded file). "Open project folder" picks any folder; when a folder was used
// before, a one-click "Reopen <name>" appears too (open-recent-folder). A refresh
// returns to the landing — reopening is a deliberate click, not automatic.
function fsaaInitLanding() {
  var open = document.getElementById('landingMountBtn');
  var reopen = document.getElementById('landingReopenBtn');
  if (!open) return;
  if (!fsaaSupported()) { open.style.display = 'none'; if (reopen) reopen.style.display = 'none'; return; }
  open.style.display = '';
  open.onclick = function () { fsaaMountFolder(); };   // a click is the gesture showDirectoryPicker needs
  if (!reopen) return;
  fsaaLoadHandle().then(function (h) {
    if (!h || !h.name) { reopen.style.display = 'none'; return; }
    reopen.textContent = '↻ Reopen ' + h.name;
    reopen.title = 'Reopen the last project folder — no folder picker';
    reopen.style.display = '';
    reopen.onclick = function () { fsaaReopenFolder().then(function (ok) { if (ok) fsaaMaybeOpenProject(); }); };
  }).catch(function () {});
}

// Startup: wire the landing affordances. NO auto-mount/auto-open — a refresh lands
// on the starting screen; the user clicks Open or Reopen.
if (typeof document !== 'undefined') { try { fsaaInitLanding(); } catch (e) {} }
