// ─── C14 Project Store ──────────────────────────────────────────────────
// Projects — not files — are BMA's unit of work. A project RECORD lives in the
// 'projects' IDB store keyed by a stable id; its bytes live in a chosen BACKING:
//   folder — a user-picked FSAA directory (real files on disk, user-visible)
//   opfs   — an origin-private directory (no permission prompt, reopens unattended)
//   idb    — the pack bytes embedded in IndexedDB (offline, size-capped)
//   local  — the existing localStorage project blob (migrated model-less legacy)
//   file   — a re-pickable model/pack file (migrated legacy recents, maybe w/ handle)
// folder + opfs share the FileSystemDirectoryHandle interface, so the C11 folder
// machinery (fsaaOpenProjectFromFolder) opens both — opfs is a no-permission folder.
// The record carries display + filter metadata (title, tags, notes, timestamps,
// model, dataset count, drillholes) so the manager never has to crack a pack to list.

function projNewId() {
  if (typeof self !== 'undefined' && self.crypto && typeof self.crypto.randomUUID === 'function') return self.crypto.randomUUID();
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ── IDB CRUD on the 'projects' store ──────────────────────────────────────
function projList() {
  return openCacheDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('projects', 'readonly');
      var req = tx.objectStore('projects').getAll();
      tx.oncomplete = function () {
        var items = req.result || [];
        items.sort(function (a, b) { return (b.lastOpened || b.lastSaved || 0) - (a.lastOpened || a.lastSaved || 0); });
        resolve(items);
      };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}
function projGet(id) {
  return openCacheDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var req = db.transaction('projects', 'readonly').objectStore('projects').get(id);
      req.onsuccess = function () { resolve(req.result || null); };
      req.onerror = function () { reject(req.error); };
    });
  });
}
function projPut(rec) {
  if (!rec || !rec.id) return Promise.reject(new Error('project record needs an id'));
  return openCacheDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('projects', 'readwrite');
      tx.objectStore('projects').put(rec, rec.id);
      tx.oncomplete = function () { resolve(rec); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}
// Delete a project record + its backing bytes (idb pack / opfs dir). The 'folder'
// backing is a user folder — we never delete the user's files, only forget it.
function projDelete(id) {
  return projGet(id).then(function (rec) {
    var jobs = [];
    if (rec && rec.backing && rec.backing.kind === 'idb') jobs.push(projPackStoreDelete(id).catch(function () {}));
    if (rec && rec.backing && rec.backing.kind === 'opfs') jobs.push(opfsRemoveProject(id).catch(function () {}));
    return Promise.all(jobs);
  }).then(function () {
    return openCacheDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('projects', 'readwrite');
        tx.objectStore('projects').delete(id);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  });
}

// ── packstore: embedded pack bytes for the 'idb' backing ──────────────────
function projPackStorePut(id, blob) {
  return openCacheDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('packstore', 'readwrite');
      tx.objectStore('packstore').put(blob, id);
      tx.oncomplete = function () { resolve(true); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}
function projPackStoreGet(id) {
  return openCacheDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var req = db.transaction('packstore', 'readonly').objectStore('packstore').get(id);
      req.onsuccess = function () { resolve(req.result || null); };
      req.onerror = function () { reject(req.error); };
    });
  });
}
function projPackStoreDelete(id) {
  return openCacheDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('packstore', 'readwrite');
      tx.objectStore('packstore').delete(id);
      tx.oncomplete = function () { resolve(true); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}

// ── OPFS (origin-private filesystem) — a no-permission, persistent folder ──
function opfsSupported() { return !!(typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.getDirectory === 'function'); }
function opfsRoot() { return navigator.storage.getDirectory(); }
function opfsDirName(id) { return 'bma-proj-' + id; }
function opfsProjectDir(id, create) {
  return opfsRoot().then(function (root) { return root.getDirectoryHandle(opfsDirName(id), { create: !!create }); });
}
function opfsRemoveProject(id) {
  return opfsRoot().then(function (root) { return root.removeEntry(opfsDirName(id), { recursive: true }); });
}

// ── peek a pack's metadata WITHOUT loading it (import-without-open) ────────
function projPeekPack(file) {
  if (typeof listZipEntries !== 'function') return Promise.resolve(null);
  return listZipEntries(file).then(function (entries) {
    var pj = entries.filter(function (e) { return /\.bma\.json$/i.test(e.name); })[0];
    if (!pj) return null;
    return readZipEntryText(file, pj).then(function (txt) {
      var p; try { p = JSON.parse(txt); } catch (e) { return null; }
      if (!p || p._bma !== 1) return null;
      return { project: p, entries: entries };
    });
  }).catch(function () { return null; });
}
// Build the display/filter metadata a record carries, from a project object.
function projMetaFromProject(p) {
  var dhCount = 0;
  if (p.drillholes) dhCount = p.drillholes.files ? 1 : Object.keys(p.drillholes).length;
  return {
    title: p.title || (p.file && p.file.name ? String(p.file.name).replace(/\.[^.]+$/, '') : 'Untitled project'),
    modelName: (p.file && p.file.name) || null,
    modelSize: (p.file && p.file.size) || null,
    datasetCount: (Array.isArray(p.datasets) ? p.datasets.length : 0) + (p.aux ? 1 : 0),
    hasDrillholes: dhCount > 0,
    savedTs: p._ts || null
  };
}

// Write every (flat) zip entry as a file into a directory handle (folder/opfs).
function projUnpackInto(dirHandle, file, entries) {
  return entries.reduce(function (chain, e) {
    return chain.then(function () {
      return zipEntryToFile(file, e).then(function (f) {
        var nm = String(e.name).split('/').pop();   // BMA packs are flat; guard anyway
        return dirHandle.getFileHandle(nm, { create: true }).then(function (fh) {
          return fh.createWritable().then(function (w) {
            return Promise.resolve(w.write(f)).then(function () { return w.close(); });
          });
        });
      });
    });
  }, Promise.resolve());
}

// ── import a pack as a project, WITHOUT opening it ────────────────────────
// dest: {kind:'folder', handle} | {kind:'opfs'} | {kind:'idb'}
function projImportPack(file, dest) {
  return projPeekPack(file).then(function (peek) {
    if (!peek) return Promise.reject(new Error('Not a BMA project pack'));
    var id = projNewId();
    var meta = projMetaFromProject(peek.project);
    var now = Date.now();
    var write;
    var backing;
    if (dest && dest.kind === 'folder' && dest.handle) {
      write = projUnpackInto(dest.handle, file, peek.entries);
      backing = { kind: 'folder', folderHandle: dest.handle, modelFileName: meta.modelName };
    } else if (dest && dest.kind === 'opfs') {
      write = opfsProjectDir(id, true).then(function (dir) { return projUnpackInto(dir, file, peek.entries); });
      backing = { kind: 'opfs', opfsDir: opfsDirName(id), modelFileName: meta.modelName };
    } else { // idb — embed the pack bytes
      write = projPackStorePut(id, file);
      backing = { kind: 'idb', modelFileName: meta.modelName };
    }
    return write.then(function () {
      var rec = {
        id: id, title: meta.title, tags: [], notes: '',
        created: now, lastSaved: meta.savedTs || now, lastOpened: 0,
        modelName: meta.modelName, modelSize: meta.modelSize,
        datasetCount: meta.datasetCount, hasDrillholes: meta.hasDrillholes,
        imported: true, backing: backing
      };
      return projPut(rec);
    });
  });
}

// ── open a project from its record (dispatch on backing) ──────────────────
function projOpen(rec) {
  if (!rec || !rec.backing) return Promise.resolve(false);
  var b = rec.backing;
  var done = Promise.resolve(false);
  if (b.kind === 'folder' && b.folderHandle && typeof fsaaActivateHandle === 'function') {
    done = fsaaActivateHandle(b.folderHandle);
  } else if (b.kind === 'opfs' && opfsSupported()) {
    // OPFS dir = a no-permission folder: set it as the mount + run the C11 open path
    done = opfsProjectDir(rec.id, false).then(function (dir) {
      if (typeof mountedFolder !== 'undefined') mountedFolder = dir;
      if (typeof projOpenLabel !== 'undefined') projOpenLabel = rec.title || null;   // pill prefers the title
      if (typeof fsaaRenderIndicator === 'function') fsaaRenderIndicator();
      return (typeof fsaaMaybeOpenProject === 'function') ? fsaaMaybeOpenProject() : false;
    });
  } else if (b.kind === 'idb') {
    done = projPackStoreGet(rec.id).then(function (blob) {
      if (!blob) return false;
      var f = new File([blob], (rec.title || 'project').replace(/[\\/:*?"<>|]+/g, '_') + '.bma.zip', { type: 'application/zip' });
      projAutoLoadPack = true;   // registry open = deliberate; skip the packed-project confirm
      return Promise.resolve(handleFile(f)).then(function () { projAutoLoadPack = false; return true; })
        .catch(function (e) { projAutoLoadPack = false; throw e; });
    });
  } else if (b.kind === 'local' && typeof reopenLocalProject === 'function') {
    done = reopenLocalProject(rec.backing.projKey || rec.id);
  } else if (b.kind === 'file') {
    if (b.fileHandle && typeof b.fileHandle.getFile === 'function') {
      done = fsaaEnsureFileHandle(b.fileHandle).then(function (file) {
        if (!file) return false;
        return Promise.resolve(handleFile(file, b.fileHandle, b.packed)).then(function () { return true; });
      });
    } else if (typeof promptReselect === 'function') {
      promptReselect(b.modelFileName || rec.modelName || rec.title); done = Promise.resolve(true);
    }
  }
  return Promise.resolve(done).then(function (r) {
    rec.lastOpened = Date.now();
    projPut(rec).catch(function () {});
    return r;
  });
}

// Re-grant + read a stored file handle (legacy 'file' backing).
function fsaaEnsureFileHandle(fh) {
  function read() { return fh.getFile().catch(function () { return null; }); }
  if (typeof fh.queryPermission !== 'function') return read();
  return Promise.resolve(fh.queryPermission({ mode: 'read' })).then(function (p) {
    if (p === 'granted') return read();
    return Promise.resolve(fh.requestPermission({ mode: 'read' })).then(function (p2) { return p2 === 'granted' ? read() : null; });
  }).catch(function () { return null; });
}

// ── backup a project record as a downloadable pack (.bma.zip) ─────────────
// For the OPEN project, defer to the existing runPack(). For a non-open idb /
// folder / opfs record we hand back its already-packed bytes (idb) or re-zip the
// folder's files; the simplest faithful path is to open→pack, so the manager wires
// "backup" to: if it's the current project use runPack, else open it first.
function projBackupIdbPack(id) {
  return projPackStoreGet(id).then(function (blob) { return blob || null; });
}

// ── migration: seed the registry from the legacy 'recents' store, once ────
// Idempotent: only seeds when the registry is empty (a real project list means
// migration already ran or the user created projects). Recents are left intact.
function projMigrateFromRecents() {
  return projList().then(function (existing) {
    if (existing && existing.length) return 0;
    if (typeof recentList !== 'function') return 0;
    return recentList().then(function (recents) {
      if (!recents || !recents.length) return 0;
      return recents.reduce(function (chain, r) {
        return chain.then(function () {
          var when = r.lastOpened || Date.now();
          var rec = {
            id: projNewId(),
            title: String(r.name || 'Untitled').replace(/\.[^.]+$/, ''),
            tags: [], notes: '', created: when, lastSaved: when, lastOpened: when,
            modelName: r.isFolder ? null : (r.name || null), modelSize: r.size || null,
            datasetCount: 0, hasDrillholes: false, migrated: true
          };
          if (r.isFolder && r.folderHandle) rec.backing = { kind: 'folder', folderHandle: r.folderHandle };
          else if (r.handle) rec.backing = { kind: 'file', fileHandle: r.handle, modelFileName: r.name, packed: !!r.packed };
          else rec.backing = { kind: 'file', modelFileName: r.name, packed: !!r.packed };
          return projPut(rec);
        });
      }, Promise.resolve()).then(function () { return recents.length; });
    });
  }).catch(function () { return 0; });
}

// Display label for a backing kind (used by the manager + the header pill).
function projBackingLabel(kind) {
  return kind === 'folder' ? 'folder' : kind === 'opfs' ? 'browser storage' : kind === 'idb' ? 'embedded' : kind === 'local' ? 'local' : 'file';
}

// The pill prefers a friendly project title over a raw opfs dir name.
var projOpenLabel = null;
// Set while opening a pack from the registry — tells tryPackedProject to skip its
// interactive "Packed project found" confirm (a raw drag-drop still asks).
var projAutoLoadPack = false;
