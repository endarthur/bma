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
    if (rec && rec.backing && rec.backing.kind === 'idb') jobs.push(idbDirDelete(id).catch(function () {}));
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

// ── 'idb' backing = a VIRTUAL FOLDER in the packstore ─────────────────────
// Each project file is a separate blob keyed '<id>/<name>'. idbDirHandle wraps the
// store in the FileSystemDirectoryHandle interface (getFileHandle/createWritable/
// keys), so the C11 folder machinery (fsaaOpenProjectFromFolder / fsaaWriteProjectJson
// / fsaaResolveProjectFiles) drives an idb project exactly like a real folder — and
// autosave's project-JSON write persists edits IN PLACE (no snapshot loss).
function idbFileGet(key) {
  return openCacheDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var r = db.transaction('packstore', 'readonly').objectStore('packstore').get(key);
      r.onsuccess = function () { resolve(r.result == null ? null : r.result); };
      r.onerror = function () { reject(r.error); };
    });
  });
}
function idbFilePut(key, blob) {
  return openCacheDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('packstore', 'readwrite');
      tx.objectStore('packstore').put(blob, key);
      tx.oncomplete = function () { resolve(true); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}
function idbFileDelete(key) {
  return openCacheDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('packstore', 'readwrite');
      tx.objectStore('packstore').delete(key);
      tx.oncomplete = function () { resolve(true); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}
function idbKeysWithPrefix(prefix) {
  return openCacheDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      var r = db.transaction('packstore', 'readonly').objectStore('packstore').getAllKeys();
      r.onsuccess = function () { resolve((r.result || []).filter(function (k) { return typeof k === 'string' && k.indexOf(prefix) === 0; })); };
      r.onerror = function () { reject(r.error); };
    });
  });
}
function idbDirDelete(id) {
  return idbKeysWithPrefix(id + '/').then(function (keys) { return Promise.all(keys.map(idbFileDelete)); });
}
// A FileSystemDirectoryHandle-shaped view over the '<id>/*' blobs.
function idbDirHandle(id) {
  var prefix = id + '/';
  function fileHandle(name, blob) {
    var key = prefix + name;
    return {
      kind: 'file', name: name,
      getFile: function () {
        return (blob != null ? Promise.resolve(blob) : idbFileGet(key)).then(function (b) {
          if (b == null) b = new Blob([]);
          return new File([b], name);
        });
      },
      createWritable: function () {
        var parts = [];
        return Promise.resolve({
          write: function (d) { parts.push(d); return Promise.resolve(); },
          close: function () { return idbFilePut(key, new Blob(parts)); }
        });
      }
    };
  }
  return {
    name: 'bma-proj-' + id, kind: 'directory', _bmaIdbDir: true, _id: id,
    getFileHandle: function (name, opts) {
      var key = prefix + name;
      if (opts && opts.create) return Promise.resolve(fileHandle(name, null));
      return idbFileGet(key).then(function (b) {
        if (b == null) throw new Error('NotFound');
        return fileHandle(name, b);
      });
    },
    removeEntry: function (name) { return idbFileDelete(prefix + name); },
    keys: function () {
      var list = null, i = 0;
      return { [Symbol.asyncIterator]: function () {
        return { next: function () {
          return (list ? Promise.resolve(list) : idbKeysWithPrefix(prefix).then(function (ks) { list = ks; return ks; }))
            .then(function (ks) { return i < ks.length ? { value: ks[i++].slice(prefix.length), done: false } : { value: undefined, done: true }; });
        } };
      } };
    }
  };
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
    // Re-importing the same pack is ALWAYS a NEW, independent project (fresh id +
    // its own storage) — it never overwrites a prior import or its edits. Just
    // disambiguate the title so the two are legible in the list.
    return projList().then(function (existing) { return { peek: peek, existing: existing || [] }; });
  }).then(function (ctx) {
    var peek = ctx.peek;
    var id = projNewId();
    var meta = projMetaFromProject(peek.project);
    meta.title = projUniqueTitle(meta.title, ctx.existing);
    var now = Date.now();
    var write;
    var backing;
    if (dest && dest.kind === 'folder' && dest.handle) {
      write = projUnpackInto(dest.handle, file, peek.entries);
      backing = { kind: 'folder', folderHandle: dest.handle, modelFileName: meta.modelName };
    } else if (dest && dest.kind === 'opfs') {
      write = opfsProjectDir(id, true).then(function (dir) { return projUnpackInto(dir, file, peek.entries); });
      backing = { kind: 'opfs', opfsDir: opfsDirName(id), modelFileName: meta.modelName };
    } else { // idb — unpack into a virtual folder (per-file blobs, editable in place)
      write = projUnpackInto(idbDirHandle(id), file, peek.entries);
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
  // switching projects while one is open (File ▸ Open recent): return to a clean
  // landing first, so the folder-open path (guarded on !currentFile) runs.
  if (typeof currentFile !== 'undefined' && currentFile && typeof closeProjectToLanding === 'function') closeProjectToLanding();
  currentProjectRecId = rec.id;   // edits/autosaves update THIS record, not a new one
  projOpening = true;             // tells handleFile (run inside the open) not to clear the id
  var b = rec.backing;
  var done = Promise.resolve(false);
  if (b.kind === 'folder' && b.folderHandle && typeof fsaaActivateHandle === 'function') {
    done = fsaaActivateHandle(b.folderHandle);   // FSAA folder: re-grant permission first
  } else if (b.kind === 'opfs' && opfsSupported()) {
    done = opfsProjectDir(rec.id, false).then(function (dir) { return projMountDir(rec, dir); });
  } else if (b.kind === 'idb') {
    done = Promise.resolve(projMountDir(rec, idbDirHandle(rec.id)));   // virtual folder, no permission
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
    projOpening = false;
    currentProjectRecId = rec.id;   // re-assert (handleFile may have run mid-open)
    rec.lastOpened = Date.now();
    projPut(rec).catch(function () {});
    return r;
  }, function (e) { projOpening = false; throw e; });
}

// Mount a non-FSAA directory handle (opfs / idb virtual folder) as the project
// home + run the C11 folder-open path. No permission prompt, no folder-recents,
// no FSAA handle store — just the same source-resolution + autosave-writes-back.
function projMountDir(rec, dir) {
  if (typeof mountedFolder !== 'undefined') mountedFolder = dir;
  if (typeof mountedFolderVirtual !== 'undefined') mountedFolderVirtual = true;
  projOpenLabel = rec.title || null;                         // pill prefers the title
  if (typeof fsaaRenderIndicator === 'function') fsaaRenderIndicator();
  return (typeof fsaaMaybeOpenProject === 'function') ? fsaaMaybeOpenProject() : false;
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

// A title not already used by another project: "Name", then "Name (copy)",
// "Name (copy 2)", … So a re-imported pack reads as a distinct copy, not a clone.
function projUniqueTitle(base, existing) {
  base = base || 'Untitled project';
  var taken = {};
  (existing || []).forEach(function (r) { if (r && r.title) taken[r.title] = true; });
  if (!taken[base]) return base;
  var t = base + ' (copy)';
  var n = 2;
  while (taken[t]) { t = base + ' (copy ' + n + ')'; n++; }
  return t;
}

// Display label for a backing kind (used by the manager + the header pill).
function projBackingLabel(kind) {
  return kind === 'folder' ? 'folder' : kind === 'opfs' ? 'browser storage' : kind === 'idb' ? 'embedded' : kind === 'local' ? 'local' : 'file';
}

// ── keep the registry fresh as the user works ─────────────────────────────
// The record id for the open project. Set when opening from the registry; else a
// dropped/created project is keyed by its stable currentProjectKey() so re-opening
// updates the same record (no duplicates). Reset on close/clear.
var currentProjectRecId = null;
var projOpening = false;   // true while projOpen drives handleFile, so it keeps the rec id

// Live metadata for the open project (title, model, counts, drillholes).
function projCurrentMeta() {
  var title = (typeof projectTitle !== 'undefined' && projectTitle) ? projectTitle
    : (typeof currentFile !== 'undefined' && currentFile ? String(currentFile.name).replace(/\.[^.]+$/, '') : 'Untitled project');
  var dsc = 0, dh = false;
  if (typeof datasets !== 'undefined' && datasets) datasets.forEach(function (d) { if (d && d.id !== 'model' && d.preflight) dsc++; });
  if (typeof dhStates === 'object' && dhStates) Object.keys(dhStates).forEach(function (k) { if (dhStates[k] && dhStates[k].files && dhStates[k].files.collar) dh = true; });
  return {
    title: title,
    modelName: (typeof currentFile !== 'undefined' && currentFile) ? currentFile.name : null,
    modelSize: (typeof currentFile !== 'undefined' && currentFile) ? currentFile.size : null,
    rowCount: (typeof lastCompleteData !== 'undefined' && lastCompleteData) ? lastCompleteData.rowCount : null,
    datasetCount: dsc, hasDrillholes: dh
  };
}
// The backing to record for the open project. Preserve a non-local backing the
// project already came from (folder/opfs/idb — edits persist there); a plain
// dropped project is 'local' (its autosave blob in localStorage).
function projCurrentBacking(existing) {
  if (existing && existing.backing && existing.backing.kind !== 'local' && existing.backing.kind !== 'file') return existing.backing;
  if (typeof mountedFolder !== 'undefined' && mountedFolder && !(typeof mountedFolderVirtual !== 'undefined' && mountedFolderVirtual)) {
    return { kind: 'folder', folderHandle: mountedFolder };   // a real FSAA folder
  }
  return { kind: 'local', projKey: (typeof currentProjectKey === 'function' ? currentProjectKey() : null) };
}
// Upsert the open project's registry record. Called from autosave/flush, so the
// manager always reflects what you've been working on. No-op until there's a real
// project (a key + — for model-backed — a preflight).
function projTouchCurrent() {
  var key = (typeof currentProjectKey === 'function') ? currentProjectKey() : null;
  if (!key) return Promise.resolve(null);
  if (typeof currentFile !== 'undefined' && currentFile && typeof preflightData !== 'undefined' && !preflightData) return Promise.resolve(null);
  var id = currentProjectRecId || key;
  return projGet(id).then(function (existing) {
    var now = Date.now();
    var meta = projCurrentMeta();
    var rec = existing || { id: id, tags: [], notes: '', created: now, lastOpened: now };
    rec.id = id;
    rec.title = meta.title; rec.modelName = meta.modelName; rec.modelSize = meta.modelSize;
    rec.rowCount = meta.rowCount; rec.datasetCount = meta.datasetCount; rec.hasDrillholes = meta.hasDrillholes;
    rec.lastSaved = now;
    if (!rec.lastOpened) rec.lastOpened = now;
    rec.backing = projCurrentBacking(existing);
    currentProjectRecId = id;
    return projPut(rec).then(function (r) { if (typeof projRefreshMenuCache === 'function') projRefreshMenuCache(); return r; });
  }).catch(function () { return null; });
}

// Open a 'local'-backed project from its localStorage blob. Model-less restores
// fully; a model-backed local project needs its model file re-picked.
function reopenLocalProject(projKey) {
  var raw = null; try { raw = localStorage.getItem(projKey); } catch (e) {}
  if (!raw) return Promise.resolve(false);
  var pj; try { pj = JSON.parse(raw); } catch (e) { return Promise.resolve(false); }
  if (pj.file && pj.file.name) {
    if (typeof pendingDroppedProject !== 'undefined') pendingDroppedProject = pj;
    if (typeof promptReselect === 'function') promptReselect(pj.file.name);
    return Promise.resolve(true);
  }
  return Promise.resolve(typeof applyProject === 'function' ? applyProject(pj) : false).then(function () { return true; });
}

// The pill prefers a friendly project title over a raw opfs dir name.
var projOpenLabel = null;
// Set while opening a pack from the registry — tells tryPackedProject to skip its
// interactive "Packed project found" confirm (a raw drag-drop still asks).
var projAutoLoadPack = false;
// True while the mounted folder is a VIRTUAL dir (opfs / idb), not a user FSAA
// folder — so folder-recents / handle-store logic stays off for it.
var mountedFolderVirtual = false;
