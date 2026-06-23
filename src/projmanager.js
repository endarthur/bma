// ─── C14 Project Manager (landing) ──────────────────────────────────────
// Renders the project registry as the starting-screen manager: search, sort,
// tag filter, per-project tags/notes, and actions (open, backup-as-pack, delete).
// Responsive — a sortable table when wide, stacked cards when narrow (CSS). Reads
// projstore.js; replaces the old recent-files + model-less project lists.

var pmState = { search: '', sort: 'opened', tags: {} /* active tag filter set */ };
// Sync snapshot of the registry for the File ▸ Open recent menu (a synchronous
// factory). Kept fresh by renderProjects() + projTouchCurrent().
var wsProjectsCache = [];
function projRefreshMenuCache() {
  if (typeof projList !== 'function') return;
  projList().then(function (l) { wsProjectsCache = l || []; }).catch(function () {});
}
var PM_SORTS = [
  { key: 'opened', label: 'Last opened' },
  { key: 'saved', label: 'Last saved' },
  { key: 'created', label: 'Created' },
  { key: 'title', label: 'Title' },
  { key: 'model', label: 'Model' }
];

function pmEl() { return document.getElementById('projectManager'); }

function pmSortRecs(recs) {
  var s = pmState.sort;
  var c = recs.slice();
  c.sort(function (a, b) {
    if (s === 'title') return String(a.title || '').localeCompare(String(b.title || ''));
    if (s === 'model') return String(a.modelName || '').localeCompare(String(b.modelName || ''));
    var fa = s === 'created' ? a.created : s === 'saved' ? a.lastSaved : a.lastOpened;
    var fb = s === 'created' ? b.created : s === 'saved' ? b.lastSaved : b.lastOpened;
    return (fb || 0) - (fa || 0);
  });
  return c;
}

function pmAllTags(recs) {
  var set = {};
  recs.forEach(function (r) { (r.tags || []).forEach(function (t) { set[t] = (set[t] || 0) + 1; }); });
  return Object.keys(set).sort();
}

function pmMatch(r) {
  var q = (pmState.search || '').trim().toLowerCase();
  if (q) {
    var hay = [r.title, r.modelName, (r.tags || []).join(' '), r.notes].join(' ').toLowerCase();
    if (hay.indexOf(q) < 0) return false;
  }
  var active = Object.keys(pmState.tags).filter(function (t) { return pmState.tags[t]; });
  if (active.length) {
    var rt = r.tags || [];
    if (!active.every(function (t) { return rt.indexOf(t) >= 0; })) return false;
  }
  return true;
}

function pmBackingBadge(b) {
  var kind = (b && b.kind) || 'local';
  var label = (typeof projBackingLabel === 'function') ? projBackingLabel(kind) : kind;
  var icon = kind === 'folder' ? '📁' : kind === 'opfs' ? '🗄' : kind === 'idb' ? '💾' : kind === 'file' ? '📄' : '•';
  return '<span class="pm-backing pm-backing--' + kind + '" title="Stored in: ' + esc(label) + '">' + icon + ' ' + esc(label) + '</span>';
}

function pmRowHtml(r) {
  var tags = (r.tags || []).map(function (t) { return '<span class="pm-tag">' + esc(t) + '</span>'; }).join('');
  var dsBits = [];
  if (r.modelName) dsBits.push(esc(r.modelName)); else dsBits.push('<i>model-less</i>');
  var meta = [];
  if (r.datasetCount) meta.push(r.datasetCount + ' dataset' + (r.datasetCount === 1 ? '' : 's'));
  if (r.hasDrillholes) meta.push('drillholes');
  if (r.rowCount) meta.push(Number(r.rowCount).toLocaleString() + ' rows');
  return '<div class="pm-row" data-id="' + esc(r.id) + '" tabindex="0">' +
    '<div class="pm-cell pm-cell-title">' +
      '<div class="pm-title-line"><span class="pm-title">' + esc(r.title || 'Untitled project') + '</span>' +
        (r.imported ? '<span class="pm-flag" title="Imported pack">imported</span>' : '') + '</div>' +
      (tags ? '<div class="pm-tags">' + tags + '</div>' : '') +
    '</div>' +
    '<div class="pm-cell pm-cell-model">' + dsBits.join('') + (meta.length ? '<div class="pm-submeta">' + esc(meta.join(' · ')) + '</div>' : '') + '</div>' +
    '<div class="pm-cell pm-cell-backing">' + pmBackingBadge(r.backing) + '</div>' +
    '<div class="pm-cell pm-cell-saved" title="' + esc(new Date(r.lastSaved || r.lastOpened || 0).toLocaleString()) + '">' + timeAgo(r.lastSaved || r.lastOpened) + '</div>' +
    '<div class="pm-cell pm-cell-created" title="' + esc(new Date(r.created || 0).toLocaleString()) + '">' + timeAgo(r.created) + '</div>' +
    '<div class="pm-cell pm-cell-actions">' +
      '<button class="pm-act pm-open" data-id="' + esc(r.id) + '" title="Open">Open</button>' +
      '<button class="pm-act pm-edit" data-id="' + esc(r.id) + '" title="Tags & notes">✎</button>' +
      '<button class="pm-act pm-backup" data-id="' + esc(r.id) + '" title="Back up as a .bma.zip pack">⤓</button>' +
      '<button class="pm-act pm-del" data-id="' + esc(r.id) + '" title="Remove from list">✕</button>' +
    '</div>' +
    '<div class="pm-editor" data-editor="' + esc(r.id) + '" hidden></div>' +
  '</div>';
}

function renderProjects() {
  var host = pmEl();
  if (!host) return;
  var seed = (typeof projMigrateFromRecents === 'function') ? projMigrateFromRecents() : Promise.resolve(0);
  seed.then(function () { return (typeof projList === 'function') ? projList() : []; }).then(function (all) {
    all = all || [];
    wsProjectsCache = all;   // keep the File-menu recents in sync
    if (!all.length) { host.innerHTML = ''; return; }
    var allTags = pmAllTags(all);
    var shown = pmSortRecs(all.filter(pmMatch));

    var sortOpts = PM_SORTS.map(function (s) { return '<option value="' + s.key + '"' + (pmState.sort === s.key ? ' selected' : '') + '>' + s.label + '</option>'; }).join('');
    var tagChips = allTags.map(function (t) {
      return '<button class="pm-tagfilter' + (pmState.tags[t] ? ' on' : '') + '" data-tagf="' + esc(t) + '">' + esc(t) + '</button>';
    }).join('');

    var html = '<div class="pm-bar">' +
      '<div class="pm-title-h">Projects <span class="pm-count">' + shown.length + (shown.length !== all.length ? ' / ' + all.length : '') + '</span></div>' +
      '<input type="text" class="pm-search" id="pmSearch" placeholder="Search title, model, tags…" value="' + esc(pmState.search) + '" spellcheck="false">' +
      '<label class="pm-sort">Sort <select id="pmSort">' + sortOpts + '</select></label>' +
      '</div>' +
      (tagChips ? '<div class="pm-tagbar">' + tagChips + '</div>' : '') +
      '<div class="pm-head">' +
        '<div class="pm-cell pm-cell-title">Project</div><div class="pm-cell pm-cell-model">Model</div>' +
        '<div class="pm-cell pm-cell-backing">Storage</div><div class="pm-cell pm-cell-saved">Saved</div>' +
        '<div class="pm-cell pm-cell-created">Created</div><div class="pm-cell pm-cell-actions"></div>' +
      '</div>' +
      '<div class="pm-rows">' + (shown.length ? shown.map(pmRowHtml).join('') : '<div class="pm-empty">No projects match.</div>') + '</div>';
    host.innerHTML = html;
    pmWire(host, all);
  }).catch(function () { host.innerHTML = ''; });
}

function pmWire(host, all) {
  var byId = {}; all.forEach(function (r) { byId[r.id] = r; });
  var search = host.querySelector('#pmSearch');
  if (search) search.addEventListener('input', function () { pmState.search = search.value; pmRerenderRows(host, all); });
  var sort = host.querySelector('#pmSort');
  if (sort) sort.addEventListener('change', function () { pmState.sort = sort.value; renderProjects(); });
  host.querySelectorAll('[data-tagf]').forEach(function (b) {
    b.addEventListener('click', function () { var t = b.getAttribute('data-tagf'); pmState.tags[t] = !pmState.tags[t]; renderProjects(); });
  });
  // open: row click or Open button
  host.querySelectorAll('.pm-row').forEach(function (row) {
    row.addEventListener('click', function (e) {
      if (e.target.closest('.pm-act') || e.target.closest('.pm-editor')) return;
      pmOpen(byId[row.getAttribute('data-id')]);
    });
    row.addEventListener('keydown', function (e) {
      // only "Enter on the focused row" opens — NOT Enter inside the editor/inputs
      // (else adding a tag with Enter bubbles up and opens the project)
      if (e.key !== 'Enter' || e.target !== row) return;
      if (e.target.closest('.pm-act') || e.target.closest('.pm-editor')) return;
      pmOpen(byId[row.getAttribute('data-id')]);
    });
  });
  host.querySelectorAll('.pm-open').forEach(function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); pmOpen(byId[b.getAttribute('data-id')]); }); });
  host.querySelectorAll('.pm-edit').forEach(function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); pmToggleEditor(host, byId[b.getAttribute('data-id')]); }); });
  host.querySelectorAll('.pm-backup').forEach(function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); pmBackup(byId[b.getAttribute('data-id')]); }); });
  host.querySelectorAll('.pm-del').forEach(function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); pmDelete(byId[b.getAttribute('data-id')]); }); });
}

// Re-render just the rows (keeps the search box focused while typing).
function pmRerenderRows(host, all) {
  var shown = pmSortRecs(all.filter(pmMatch));
  var rows = host.querySelector('.pm-rows');
  if (rows) rows.innerHTML = shown.length ? shown.map(pmRowHtml).join('') : '<div class="pm-empty">No projects match.</div>';
  var count = host.querySelector('.pm-count');
  if (count) count.textContent = shown.length + (shown.length !== all.length ? ' / ' + all.length : '');
  pmWire(host, all);
}

function pmOpen(rec) {
  if (!rec || typeof projOpen !== 'function') return;
  projOpen(rec).then(function (ok) {
    if (ok === false) {
      if (typeof bmaConfirm === 'function') bmaConfirm({ title: 'Could not open', okLabel: 'OK', html: 'This project’s files could not be resolved from its storage. It may have been moved or removed.' });
    }
  });
}

// Inline tags + notes editor under a row.
// Inline tags + notes editor — STAGED: edits go to a draft; Done saves, Cancel
// discards (Esc = cancel). Tags add on Enter OR comma (paste "a, b, c" works too);
// the chip × removes. Nothing persists until Done, so it's an unambiguous
// confirm/cancel — and the editor doesn't collapse mid-edit.
function pmToggleEditor(host, rec) {
  if (!rec) return;
  var ed = host.querySelector('[data-editor="' + cssEsc(rec.id) + '"]');
  if (!ed) return;
  if (!ed.hasAttribute('hidden')) { pmCloseEditor(ed); return; }   // toggle closed = cancel

  var draft = { tags: (rec.tags || []).slice(), notes: rec.notes || '' };
  function tagsInner() {
    return draft.tags.map(function (t) { return '<span class="pm-tag pm-tag--edit">' + esc(t) + '<button class="pm-tag-x" data-rmtag="' + esc(t) + '">×</button></span>'; }).join('') +
      '<input class="pm-ed-taginput" placeholder="add tag — Enter or comma" spellcheck="false">';
  }
  function addTags(raw) {
    String(raw).split(/[,\n]/).map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (t) {
      if (draft.tags.indexOf(t) < 0) draft.tags.push(t);
    });
  }
  function notesEl() { return ed.querySelector('.pm-ed-notes'); }
  function done() {
    var inp = ed.querySelector('.pm-ed-taginput');
    if (inp && inp.value.trim()) addTags(inp.value);   // capture a half-typed tag
    rec.tags = draft.tags;
    rec.notes = notesEl() ? notesEl().value : draft.notes;
    projPut(rec).then(renderProjects);                 // persist + repaint the row
  }
  function cancel() { pmCloseEditor(ed); }              // draft discarded
  function renderTags() {
    var wrap = ed.querySelector('.pm-ed-tags');
    wrap.innerHTML = tagsInner();
    wireTags();
    wrap.querySelector('.pm-ed-taginput').focus();
  }
  function wireTags() {
    var input = ed.querySelector('.pm-ed-taginput');
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        if (input.value.trim()) { addTags(input.value); input.value = ''; renderTags(); }
      } else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      else if (e.key === 'Backspace' && !input.value && draft.tags.length) { draft.tags.pop(); renderTags(); }
    });
    ed.querySelectorAll('[data-rmtag]').forEach(function (b) {
      b.addEventListener('click', function () { var t = b.getAttribute('data-rmtag'); draft.tags = draft.tags.filter(function (x) { return x !== t; }); renderTags(); });
    });
  }

  ed.innerHTML =
    '<div class="pm-ed-row"><label class="pm-ed-label">Tags</label><div class="pm-ed-tags"></div></div>' +
    '<div class="pm-ed-row"><label class="pm-ed-label">Notes</label><textarea class="pm-ed-notes" rows="2" placeholder="notes for this project…" spellcheck="false">' + esc(draft.notes) + '</textarea></div>' +
    '<div class="pm-ed-foot"><span class="pm-ed-hint">Enter or comma adds a tag</span>' +
      '<span class="pm-ed-btns"><button class="pm-ed-cancel" type="button">Cancel</button><button class="pm-ed-done" type="button">Done</button></span></div>';
  ed.removeAttribute('hidden');
  renderTags();
  notesEl().addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); cancel(); } });
  ed.querySelector('.pm-ed-done').addEventListener('click', done);
  ed.querySelector('.pm-ed-cancel').addEventListener('click', cancel);
}
function pmCloseEditor(ed) { ed.setAttribute('hidden', ''); ed.innerHTML = ''; }

function pmDelete(rec) {
  if (!rec) return;
  var stored = (rec.backing && (rec.backing.kind === 'opfs' || rec.backing.kind === 'idb'));
  var msg = stored
    ? 'Remove <strong>' + esc(rec.title || 'this project') + '</strong> and delete its stored copy in ' + esc(projBackingLabel(rec.backing.kind)) + '? This cannot be undone.'
    : 'Remove <strong>' + esc(rec.title || 'this project') + '</strong> from the list? Its source files are left untouched.';
  Promise.resolve(typeof bmaConfirm === 'function' ? bmaConfirm({ title: 'Remove project', okLabel: 'Remove', cancelLabel: 'Cancel', html: msg }) : true).then(function (ok) {
    if (!ok) return;
    projDelete(rec.id).then(renderProjects);
  });
}

// ── backup a project as a downloadable .bma.zip ───────────────────────────
// For a directory backing (folder/opfs/idb) we re-zip the stored files — no open
// needed. For local/file we open it then defer to the existing runPack().
function pmBackup(rec) {
  if (!rec) return;
  var b = rec.backing || {};
  var dirP = null;
  if (b.kind === 'folder' && b.folderHandle) dirP = Promise.resolve(b.folderHandle);
  else if (b.kind === 'opfs' && typeof opfsProjectDir === 'function') dirP = opfsProjectDir(rec.id, false);
  else if (b.kind === 'idb' && typeof idbDirHandle === 'function') dirP = Promise.resolve(idbDirHandle(rec.id));
  if (!dirP) {   // local / file — open then pack
    if (typeof bmaConfirm === 'function') bmaConfirm({ title: 'Back up', okLabel: 'Open & pack', cancelLabel: 'Cancel', html: 'Open <strong>' + esc(rec.title || 'this project') + '</strong> and use File ▸ Pack to back it up.' }).then(function (ok) { if (ok) pmOpen(rec); });
    return;
  }
  pmZipDir(dirP, rec.title || 'project').catch(function () {
    if (typeof bmaConfirm === 'function') bmaConfirm({ title: 'Backup failed', okLabel: 'OK', html: 'Could not read the project’s stored files.' });
  });
}

function pmZipDir(dirP, title) {
  return dirP.then(function (dir) {
    var files = [];
    return (async function () {
      for await (var name of dir.keys()) {
        var fh = await dir.getFileHandle(name);
        var f = await fh.getFile();
        files.push({ name: name, blob: f });
      }
    })().then(function () {
      if (!files.length) throw new Error('empty');
      return buildStoredZip(files);
    }).then(function (zipBlob) {
      var fname = String(title).replace(/[\\/:*?"<>|]+/g, '_') + '.bma.zip';
      var url = URL.createObjectURL(zipBlob);
      var a = document.createElement('a');
      a.href = url; a.download = fname; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    });
  });
}

// ── import a pack: pick a file, then choose a storage backend ─────────────
function pmImportFlow() {
  pmPickPackFile().then(function (file) {
    if (!file) return;
    return pmChooseDest(file).then(function (dest) {
      if (!dest) return;
      return projImportPack(file, dest).then(function () { renderProjects(); })
        .catch(function () { if (typeof bmaConfirm === 'function') bmaConfirm({ title: 'Import failed', okLabel: 'OK', html: 'That file isn’t a BMA project pack (.bma.zip).' }); });
    });
  });
}

function pmPickPackFile() {
  if (typeof window.showOpenFilePicker === 'function') {
    return window.showOpenFilePicker({ types: [{ description: 'BMA pack', accept: { 'application/zip': ['.zip'] } }], multiple: false })
      .then(function (hs) { return hs[0].getFile(); }).catch(function () { return null; });
  }
  return new Promise(function (resolve) {
    var inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.zip,.bma.zip';
    inp.onchange = function () { resolve(inp.files && inp.files[0] ? inp.files[0] : null); };
    inp.click();
  });
}

// A small modal asking where to store the imported project.
function pmChooseDest(file) {
  return new Promise(function (resolve) {
    var opts = [];
    if (typeof fsaaSupported === 'function' && fsaaSupported()) opts.push({ kind: 'folder', icon: '📁', label: 'Unpack to a folder', hint: 'pick an empty folder on disk' });
    if (typeof opfsSupported === 'function' && opfsSupported()) opts.push({ kind: 'opfs', icon: '🗄', label: 'Browser storage', hint: 'private, persistent, no prompts' });
    opts.push({ kind: 'idb', icon: '💾', label: 'Embedded (this browser)', hint: 'stored in IndexedDB' });
    var ov = document.createElement('div');
    ov.className = 'pm-modal-overlay';
    ov.innerHTML = '<div class="pm-modal"><div class="pm-modal-h">Import “' + esc(String(file.name).replace(/\.bma\.zip$|\.zip$/i, '')) + '”</div>' +
      '<div class="pm-modal-sub">Where should this project be stored?</div>' +
      '<div class="pm-modal-opts">' + opts.map(function (o) {
        return '<button class="pm-dest" data-kind="' + o.kind + '"><span class="pm-dest-i">' + o.icon + '</span><span class="pm-dest-l">' + esc(o.label) + '</span><span class="pm-dest-h">' + esc(o.hint) + '</span></button>';
      }).join('') + '</div>' +
      '<div class="pm-modal-foot"><button class="pm-modal-cancel">Cancel</button></div></div>';
    document.body.appendChild(ov);
    function done(val) { ov.remove(); resolve(val); }
    ov.querySelector('.pm-modal-cancel').addEventListener('click', function () { done(null); });
    ov.addEventListener('click', function (e) { if (e.target === ov) done(null); });
    ov.querySelectorAll('.pm-dest').forEach(function (b) {
      b.addEventListener('click', function () {
        var kind = b.getAttribute('data-kind');
        if (kind === 'folder') {
          window.showDirectoryPicker({ mode: 'readwrite' }).then(function (h) {
            return (typeof fsaaEnsurePermission === 'function' ? fsaaEnsurePermission(h, true) : Promise.resolve(true)).then(function (ok) { done(ok ? { kind: 'folder', handle: h } : null); });
          }).catch(function () { done(null); });
        } else { done({ kind: kind }); }
      });
    });
  });
}

// Wire the landing Import button once.
if (typeof document !== 'undefined') {
  try {
    var ib = document.getElementById('landingImportBtn');
    if (ib) ib.addEventListener('click', function () { pmImportFlow(); });
  } catch (e) {}
}

// CSS.escape fallback for attribute selectors over project ids (uuids are safe,
// but legacy file-key ids contain ':' and '.').
function cssEsc(s) { return (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }
