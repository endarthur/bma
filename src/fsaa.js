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

// Reflect a mount change in the UI. The File menu is a live factory, so it picks
// up mountedFolder on next open; this just nudges any other listeners.
function fsaaAfterMountChange() {
  if (typeof autoSaveProject === 'function') { /* P1 will autosave into the folder */ }
}

// Silent restore on startup (no-op where unsupported / no saved handle).
if (typeof indexedDB !== 'undefined') { try { fsaaTryRestoreOnLoad(); } catch (e) {} }
