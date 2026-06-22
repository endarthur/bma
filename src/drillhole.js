// ─── Drillhole set ingestion (A7 Phase 1 · A10 Phase 5 multi-instance) ───
// UI + parsing glue over the @gcu/drillhole lib (vendor-drillhole.js):
// three file slots on a dataset's import (empty-state) card, an always-
// visible mapping panel (column selects, the PROMINENT dip-convention toggle
// (D1), desurvey method select, composite length / domain / min-coverage),
// the consistency report, and Composite & load — which emits a CSV string,
// wraps it in a File, and hands it to loadAuxFile() FOR THE OWNING DATASET so
// the (now dataset-generic) aux pipeline stays untouched. SUPPORT auto-assigns
// as that dataset's weight.
//
// A10 Phase 5: state is PER-DATASET (dhStateFor(ds), keyed by ds.id; the legacy
// singleton aux is just the 'aux' entry) and the card DOM resolves through the
// owning dataset's config-panel root (data-dh attrs, scoped via dhQ) — so each
// dataset instance (aux/d2/d3…) can host its own independent drillhole set.
// Design: docs/a7-drillhole-ingestion.md + docs/a10-n-datasets.md.

var DH_ROLES = ['collar', 'survey', 'intervals'];
var DH_SYN = {
  bhid: ['bhid', 'holeid', 'hole_id', 'dhid', 'hole', 'dhno', 'name', 'id', 'furo'],
  x: ['x', 'east', 'easting', 'xcollar', 'x_collar', 'xc'],
  y: ['y', 'north', 'northing', 'ycollar', 'y_collar', 'yc'],
  z: ['z', 'elev', 'elevation', 'rl', 'zcollar', 'z_collar', 'zc', 'cota'],
  eoh: ['eoh', 'depth', 'maxdepth', 'td', 'total_depth', 'totaldepth', 'max_depth', 'length'],
  at: ['at', 'depth', 'dist', 'distance', 'md'],
  az: ['az', 'azim', 'azimuth', 'brg', 'bearing', 'azi', 'azimute'],
  dip: ['dip', 'incl', 'inclination', 'plunge'],
  from: ['from', 'depfrom', 'from_m', 'depth_from', 'de'],
  to: ['to', 'depto', 'to_m', 'depth_to', 'ate'],
};

// ── per-dataset state ────────────────────────────────────────────────────
// One bundle per ds.id. Fields mirror the old module globals 1:1.
var dhStates = {};
function dhStateFor(ds) {
  var id = (ds && ds.id) || 'aux';
  if (!dhStates[id]) dhStates[id] = {
    files: { collar: null, survey: null, intervals: null },   // File per role
    parsed: { collar: null, survey: null, intervals: null },  // {header, rows}
    map: { collar: {}, survey: {}, intervals: {} },           // field → col idx
    dipConvention: null,            // 'pos-down' | 'neg-down' (null = undetected)
    opts: { method: 'minimumCurvature', length: '', domainCol: '', densityCol: '', minCov: '', combine: null }, // serializable
    lastReport: null,               // last Drillhole.process report (for the modal)
    derivedName: null,              // file name of the loaded composite CSV
    provFiles: null,                // [names] for the provenance banner
    pendingRestore: null,           // project recipe awaiting its files
    intervalTables: [],             // A11 P0: the container's interval-tables list (see dhIvtList)
    secondary: null                 // A11 P5: a 2nd interval table {file,parsed,map} merged into the source
  };
  return dhStates[id];
}

// ── A11 Phase 0: the DrillholeSet container model (behind the existing card) ──
// A7 stored a single (collar, survey, intervals) trio that becomes one composite
// dataset. A11 names the general structure real drillhole tools use — a backbone
// (collar + survey, one each) plus N INTERVAL TABLES, each with a kind (imported
// / merged / composite) and its OWN calcols + filter (the home the flat model
// lacked: calcols had "nowhere to live but the single composite", a11 doc §Why).
//
// P0 is INERT: exactly one `imported` interval table — the imported intervals —
// so behavior is byte-identical (drillhole-smoke). The handle's data
// (file/parsed/map) is a LIVE VIEW of the existing role-keyed .intervals slot
// (no duplication); the new per-table fields (filter/calcolCode/calcolMeta)
// persist ON the handle, ready for Phase 2. Phases 1/2/4/5 (export-any-table /
// per-table calcols / merge / N tables) build on this list. Design: docs/
// a11-drillhole-container.md.
function dhIvtList(D) {
  if (D.files.intervals && !D.intervalTables.length) {
    D.intervalTables.push({
      id: 'intervals', kind: 'imported',
      filter: null, calcolCode: '', calcolMeta: [],
      get file()   { return D.files.intervals; },
      get parsed() { return D.parsed.intervals; },
      get map()    { return D.map.intervals; }
    });
  } else if (!D.files.intervals && D.intervalTables.length) {
    D.intervalTables.length = 0;
  }
  return D.intervalTables;
}
// The sole interval table today (null when no intervals staged) — the named seam
// every "the intervals table" reference migrates to as the list grows (Phase 5).
function dhPrimaryIvt(D) { var l = dhIvtList(D); return l.length ? l[0] : null; }
// The design-of-record container shape: collar + survey backbone (one each) and
// the interval-tables list. A view over the per-dataset state; consumed by the
// raw-table export (P1) and per-table calcols (P2).
function dhContainer(D) {
  return {
    collar: D.files.collar ? { id: 'collar', kind: 'collar', file: D.files.collar, parsed: D.parsed.collar, map: D.map.collar } : null,
    survey: D.files.survey ? { id: 'survey', kind: 'survey', file: D.files.survey, parsed: D.parsed.survey, map: D.map.survey } : null,
    intervalTables: dhIvtList(D)
  };
}

// ── A11 Phase 1: raw-table export ─────────────────────────────────────────
// Each retained table (collar / survey / interval tables) downloads as CSV, and
// the whole set bundles as a zip — the original "export the raw tables" ask, now
// a one-liner per table because each IS a table with columns (the P0 container).
// P1 has no per-table filter/calcols yet (P2): a table serializes its parsed rows
// verbatim, so dhTableCsv is exactly where P2's filter+calcols will slot in.
function dhTableCsv(parsed) {
  var lines = [parsed.header.map(dhCsvCell).join(',')];
  for (var i = 0; i < parsed.rows.length; i++) lines.push(parsed.rows[i].map(dhCsvCell).join(','));
  return lines.join('\n') + '\n';
}

// A11 P2: coerce a raw cell to a number for EVALUATION (calcols/filter compute on
// numbers); raw columns still export as their original strings (no silent
// reformatting — the BMA standing rule), only calcol-produced columns are new.
function dhCoerceCell(s) {
  if (s == null || s === '') return s;
  var n = +s;
  return (!isNaN(n) && isFinite(n)) ? n : s;
}
// Apply a table's per-table calcols + filter (A11 P2) on the main thread — tables
// are small. Calcols (r.NEW = expr, rowVar 'r', same DSL + MATH_PREAMBLE as the
// worker) APPEND columns; the filter (return (expr)) drops rows. Original columns
// pass through VERBATIM (their raw strings); only new calcol columns are computed.
// Syntax/runtime errors and the kept/total counts are RETURNED so the UI surfaces
// them — never a silent loss.
function dhTableEval(parsed, calcolCode, filterExpr) {
  var header = parsed.header, origLen = header.length;
  var res = { header: header.slice(), rows: [], calcCols: [], calcErrors: 0, filterErrors: 0,
    kept: 0, total: parsed.rows.length, calcSyntaxError: null, filterSyntaxError: null };
  var calFn = null, filFn = null;
  if (calcolCode && calcolCode.trim()) {
    try { calFn = new Function('r', MATH_PREAMBLE_MAIN + calcolCode); }
    catch (e) { res.calcSyntaxError = e.message; }
  }
  if (filterExpr && filterExpr.trim()) {
    try { filFn = new Function('r', MATH_PREAMBLE_MAIN + 'return (' + filterExpr + ');'); }
    catch (e) { res.filterSyntaxError = e.message; }
  }
  var calcKeys = [], calcSeen = {}, staged = [];
  for (var i = 0; i < parsed.rows.length; i++) {
    var arr = parsed.rows[i], r = {};
    for (var c = 0; c < origLen; c++) r[header[c]] = dhCoerceCell(arr[c]);
    if (calFn) {
      r.META = { cat: [], num: [] };   // calcol code may push type hints; ignored on export
      try { calFn(r); } catch (e) { res.calcErrors++; }
      for (var k in r) {
        if (!r.hasOwnProperty(k) || k === 'META') continue;
        if (header.indexOf(k) < 0 && !calcSeen[k]) { calcSeen[k] = true; calcKeys.push(k); }
      }
    }
    if (filFn) {
      var keep;
      try { keep = !!filFn(r); } catch (e) { res.filterErrors++; keep = false; }
      if (!keep) continue;
    }
    res.kept++;
    staged.push({ arr: arr, r: r });
  }
  res.calcCols = calcKeys;
  res.header = header.concat(calcKeys);
  res.rows = staged.map(function(s) {
    var out = [];
    for (var c = 0; c < origLen; c++) out.push(c < s.arr.length ? s.arr[c] : '');   // raw cells verbatim
    for (var j = 0; j < calcKeys.length; j++) { var v = s.r[calcKeys[j]]; out.push(v == null ? '' : v); }
    return out;
  });
  return res;
}
function dhDownload(blob, name) {
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
// The set's retained tables as [{role, name, parsed}] — collar, survey, then each
// interval table (one today). Skips slots not yet loaded.
function dhRetainedTables(ds) {
  var D = dhStateFor(ds), out = [];
  if (D.files.collar && D.parsed.collar) out.push({ role: 'collar', name: D.files.collar.name, parsed: D.parsed.collar });
  if (D.files.survey && D.parsed.survey) out.push({ role: 'survey', name: D.files.survey.name, parsed: D.parsed.survey });
  dhIvtList(D).forEach(function(t) {
    if (t.file && t.parsed) out.push({ role: t.id, name: t.file.name, parsed: t.parsed, calcolCode: t.calcolCode, filter: t.filter });
  });
  return out;
}
// CSV for a retained table — applies its per-table calcols + filter when set
// (A11 P2: interval tables today), else the raw table verbatim (collar/survey).
function dhTableExportCsv(t) {
  if ((t.calcolCode && t.calcolCode.trim()) || (t.filter && t.filter.trim())) {
    var ev = dhTableEval(t.parsed, t.calcolCode, t.filter);
    return dhTableCsv({ header: ev.header, rows: ev.rows });
  }
  return dhTableCsv(t.parsed);
}
function dhExportTable(ds, role) {
  var all = dhRetainedTables(ds), t = null;
  for (var i = 0; i < all.length; i++) if (all[i].role === role) { t = all[i]; break; }
  if (!t) return;
  dhDownload(new Blob([dhTableExportCsv(t)], { type: 'text/csv' }), t.name);
}
async function dhExportTablesZip(ds) {
  var tables = dhRetainedTables(ds);
  if (!tables.length) return;
  var entries = [], used = {};
  for (var i = 0; i < tables.length; i++) {
    var name = tables[i].name;
    while (used[name]) name = tables[i].role + '-' + name;   // keep zip entries unique
    used[name] = true;
    var blob = new Blob([dhTableExportCsv(tables[i])], { type: 'text/csv' });
    var crc = crc32Update(-1, new Uint8Array(await blob.arrayBuffer()));
    entries.push({ name: name, crc: (crc ^ -1) >>> 0, method: 0, data: blob, uncompSize: blob.size });
  }
  var D = dhStateFor(ds);
  var stem = (D.files.intervals && D.files.intervals.name.replace(/\.(csv|txt|dat)$/i, '')) || 'drillholes';
  dhDownload(assembleZip(entries), stem + '-tables.zip');
}
// The ⬇ CSV link injected into each mapping-table title (P1).
function dhTableDlBtn(role) {
  return ' <button type="button" class="dh-table-dl" data-dh="exportTable" data-dh-role="' + role +
    '" title="Download this table as CSV">↓ CSV</button>';
}
// The dataset config-panel element that hosts this set's card.
function dhCardRoot(ds) { return (typeof dsConfigRoot === 'function') ? dsConfigRoot(ds || dsById('aux')) : null; }
function dhQ(sel, root) { return root ? root.querySelector(sel) : null; }

function dhNorm(name) { return String(name).toLowerCase().replace(/[^a-z0-9]/g, ''); }

function dhFindCol(header, syns) {
  var normed = header.map(dhNorm);
  for (var s = 0; s < syns.length; s++) {
    var idx = normed.indexOf(dhNorm(syns[s]));
    if (idx >= 0) return idx;
  }
  return -1;
}

// Role by header signature; filename only breaks ties (intervals before
// survey before collar — FROM/TO is the most specific signature)
function dhDetectRole(header, fileName) {
  var hasBhid = dhFindCol(header, DH_SYN.bhid) >= 0;
  var hasFromTo = dhFindCol(header, DH_SYN.from) >= 0 && dhFindCol(header, DH_SYN.to) >= 0;
  var hasAzDip = dhFindCol(header, DH_SYN.az) >= 0 && dhFindCol(header, DH_SYN.dip) >= 0;
  var hasXYZ = dhFindCol(header, DH_SYN.x) >= 0 && dhFindCol(header, DH_SYN.y) >= 0 && dhFindCol(header, DH_SYN.z) >= 0;
  if (hasBhid && hasFromTo) return 'intervals';
  if (hasBhid && hasAzDip) return 'survey';
  if (hasBhid && hasXYZ) return 'collar';
  var fn = dhNorm(fileName || '');
  if (/assay|sample|interval|lith/.test(fn)) return 'intervals';
  if (/survey|desv/.test(fn)) return 'survey';
  if (/collar|colar/.test(fn)) return 'collar';
  return null;
}

function dhAutoMap(role, header) {
  if (role === 'collar') {
    return {
      bhid: dhFindCol(header, DH_SYN.bhid), x: dhFindCol(header, DH_SYN.x),
      y: dhFindCol(header, DH_SYN.y), z: dhFindCol(header, DH_SYN.z),
      eoh: dhFindCol(header, DH_SYN.eoh),
    };
  }
  if (role === 'survey') {
    return {
      bhid: dhFindCol(header, DH_SYN.bhid), at: dhFindCol(header, DH_SYN.at),
      az: dhFindCol(header, DH_SYN.az), dip: dhFindCol(header, DH_SYN.dip),
    };
  }
  return {
    bhid: dhFindCol(header, DH_SYN.bhid), from: dhFindCol(header, DH_SYN.from),
    to: dhFindCol(header, DH_SYN.to),
  };
}

// ── parsing (main thread, D7 — drillhole tables are small) ─────────────

function dhSplitLine(line, delim) {
  if (line.indexOf('"') < 0) return line.split(delim);
  var out = [], cur = '', inQ = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

async function dhParseFile(file) {
  var text = await file.text();
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  var lines = text.split(/\r\n|\n|\r/);
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length < 2) throw new Error(file.name + ': no data rows');
  var delim = detectDelimiterMain(lines.slice(0, 50));
  var header = dhSplitLine(lines[0], delim).map(function(h) { return h.trim(); });
  var rows = [];
  for (var i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    rows.push(dhSplitLine(lines[i], delim));
  }
  return { header: header, rows: rows };
}

// ── slot assignment ─────────────────────────────────────────────────────

async function dhAssignFiles(ds, files) {
  var D = dhStateFor(ds);
  var sizeSum = 0;
  for (var fi = 0; fi < files.length; fi++) sizeSum += files[fi].size;
  if (sizeSum > 150 * 1024 * 1024) {
    var go = await bmaConfirm({
      title: 'Large drillhole set',
      html: 'These files total <b>' + formatBytes(sizeSum) + '</b> and parse on the main thread — the page may pause for a while. Continue?',
      okLabel: 'Continue',
    });
    if (!go) return;
  }
  dhSetStatus(ds, 'Reading…');
  try {
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (/\.zip$/i.test(f.name)) {
        var entries = await listZipEntries(f);
        for (var e = 0; e < entries.length; e++) {
          if (!/\.(csv|txt|dat)$/i.test(entries[e].name)) continue;
          var ef = await zipEntryToFile(f, entries[e]);
          await dhAssignOne(ds, ef);
        }
      } else {
        await dhAssignOne(ds, f);
      }
    }
    dhSetStatus(ds, '');
  } catch (err) {
    dhSetStatus(ds, 'Read failed: ' + err.message, true);
  }
  renderDhCard(ds);
  // C12-P1: re-dropping a source file after a composite exists invalidates it
  // (and propagates to the analysis). A pending restore that auto-recomposites
  // below clears it again; a plain user re-drop leaves the cue up until re-run.
  dhMarkCompositeStaleIfLoaded(ds);
  dhTryApplyPendingRestore(ds); // saved recipe applies when its files land
  dhAutoSave();
}

async function dhAssignOne(ds, file) {
  var D = dhStateFor(ds);
  var parsed = await dhParseFile(file);
  var role = dhDetectRole(parsed.header, file.name);
  if (!role) {
    // fall back to the first empty slot, in role order
    for (var r = 0; r < DH_ROLES.length; r++) {
      if (!D.files[DH_ROLES[r]]) { role = DH_ROLES[r]; break; }
    }
    if (!role) role = 'intervals';
  }
  // A11 P5: a second interval-role table (the primary intervals slot is taken) is
  // staged as the MERGE secondary, not an overwrite (assays + lithology → both).
  if (role === 'intervals' && D.files.intervals) {
    D.secondary = { file: file, parsed: parsed, map: dhAutoMap('intervals', parsed.header), calcolCode: '', filter: null };
    return;
  }
  D.files[role] = file;
  D.parsed[role] = parsed;
  D.map[role] = dhAutoMap(role, parsed.header);
  if (role === 'survey') D.dipConvention = dhDetectConventionFromParsed(ds);
}

function dhDetectConventionFromParsed(ds) {
  var D = dhStateFor(ds);
  var p = D.parsed.survey;
  if (!p) return null;
  var m = D.map.survey;
  if (m.dip == null || m.dip < 0) return null;
  var surveys = [];
  for (var i = 0; i < p.rows.length; i++) {
    surveys.push({ dip: parseFloat(p.rows[i][m.dip]) });
  }
  return Drillhole.detectDipConvention(surveys);
}

function dhClearAll(ds) {
  var D = dhStateFor(ds);
  D.files = { collar: null, survey: null, intervals: null };
  D.parsed = { collar: null, survey: null, intervals: null };
  D.map = { collar: {}, survey: {}, intervals: {} };
  D.intervalTables.length = 0;   // A11 P0: drop the container's interval tables
  D.secondary = null;            // A11 P5: drop the merge table
  D.dipConvention = null;
  D.lastReport = null;
  D._lengthHist = null;          // A17: drop the length histograms
  var $r = dhQ('[data-dh="reportInline"]', dhCardRoot(ds));
  if ($r) $r.innerHTML = '';
  renderDhCard(ds); // re-writes the pending-restore hint when one is staged
}

// ── rendering ───────────────────────────────────────────────────────────

function dhSetStatus(ds, msg, isErr) {
  var $s = dhQ('[data-dh="status"]', dhCardRoot(ds));
  if ($s) { $s.textContent = msg || ''; $s.classList.toggle('err', !!isErr); }
}

function renderDhCard(ds) {
  var D = dhStateFor(ds);
  var root = dhCardRoot(ds);
  var $slots = dhQ('[data-dh="slots"]', root);
  if (!$slots) return;
  var html = '';
  for (var r = 0; r < DH_ROLES.length; r++) {
    var role = DH_ROLES[r];
    var f = D.files[role];
    html += '<div class="dh-slot' + (f ? ' filled' : '') + '" data-dhrole="' + role + '">' +
      '<div class="dh-slot-role">' + role + '</div>' +
      (f
        ? '<div class="dh-slot-file" title="' + esc(f.name) + '">' + esc(f.name) + '</div>' +
          '<div class="dh-slot-meta">' + D.parsed[role].rows.length.toLocaleString() + ' rows · ' +
          D.parsed[role].header.length + ' cols</div>'
        : '<div class="dh-slot-empty">drop a file or click to browse</div>') +
      '</div>';
  }
  $slots.innerHTML = html;
  var $clear = dhQ('[data-dh="clearBtn"]', root);
  if ($clear) $clear.style.display = (D.files.collar || D.files.survey || D.files.intervals) ? '' : 'none';
  // "Back to results" — shown only while a composite is loaded (the editing card
  // was revealed non-destructively by "Edit & re-composite"); returns to config.
  var $back = dhQ('[data-dh="backToResults"]', root);
  if ($back) $back.style.display = (typeof dhIsDerivedAux === 'function' && dhIsDerivedAux(ds)) ? '' : 'none';

  // pending project recipe: tell the user which files it expects
  var $rep = dhQ('[data-dh="reportInline"]', root);
  if (D.pendingRestore && !(D.files.collar && D.files.survey && D.files.intervals)) {
    var pf = D.pendingRestore.files;
    if ($rep) $rep.innerHTML = '<div class="dh-status">This project used a drillhole set — drop ' +
      '<b>' + esc(pf.collar.name) + '</b> + <b>' + esc(pf.survey.name) + '</b> + <b>' + esc(pf.intervals.name) +
      '</b> (or the packed zip) to re-composite with the saved mapping.</div>';
  }
  renderDhMapping(ds);
}

function dhColSelect(ds, role, field, sel, optionalLabel) {
  return dhColSelectParsed(dhStateFor(ds).parsed[role], role, field, sel, optionalLabel);
}
// A11 P5: select over an explicit parsed header (so the secondary table, whose
// parsed/map live off the role slots, can render its own mapping).
function dhColSelectParsed(parsed, mapKey, field, sel, optionalLabel) {
  var opts = optionalLabel ? '<option value="-1">— ' + optionalLabel + '</option>' : '<option value="-1">— pick —</option>';
  for (var i = 0; i < parsed.header.length; i++) {
    opts += '<option value="' + i + '"' + (i === sel ? ' selected' : '') + '>' + esc(parsed.header[i]) + '</option>';
  }
  return '<select data-dhmap="' + mapKey + ':' + field + '">' + opts + '</select>';
}
// The merge (2nd interval table) panel — its BHID/FROM/TO mapping + a note on
// what it adds. Visible + removable (no-magic-only-ui).
function dhSecondaryPanelHtml(ds) {
  var D = dhStateFor(ds), sx = D.secondary;
  if (!sx || !sx.parsed) return '';
  // the columns the merge adds — reflect any pre-merge calcols
  var srcParsed = sx.parsed;
  if ((sx.calcolCode && sx.calcolCode.trim()) || (sx.filter && sx.filter.trim())) {
    var ev = dhTableEval(sx.parsed, sx.calcolCode, sx.filter);
    srcParsed = { header: ev.header, rows: ev.rows };
  }
  var cols = dhDataCols(srcParsed, sx.map).map(function(c) { return c.name; });
  return '<div class="dh-merge-panel">' +
    '<div class="dh-merge-head">⋈ Merge a 2nd interval table' +
      '<button type="button" class="dh-merge-remove" data-dh="removeSecondary" title="Remove the merge table">✕</button></div>' +
    '<div class="dh-map-table"><div class="dh-map-title">' + esc(sx.file.name) + '</div>' +
      '<div class="dh-map-row"><label>BHID</label>' + dhColSelectParsed(sx.parsed, 'secondary', 'bhid', sx.map.bhid) + '</div>' +
      '<div class="dh-map-row"><label>From</label>' + dhColSelectParsed(sx.parsed, 'secondary', 'from', sx.map.from) + '</div>' +
      '<div class="dh-map-row"><label>To</label>' + dhColSelectParsed(sx.parsed, 'secondary', 'to', sx.map.to) + '</div></div>' +
    '<details class="dh-ivt-edit"' + ((sx.calcolCode || sx.filter) ? ' open' : '') + '>' +
      '<summary class="dh-ivt-edit-title">Calcols &amp; filter<span class="dh-ivt-edit-hint"> — applied to this table before merging</span></summary>' +
      '<textarea data-dh="secCalc" class="dh-ivt-calc" rows="2" spellcheck="false" placeholder="r.DOMAIN = r.LITO == \'IF\' ? 1 : 0">' + esc(sx.calcolCode || '') + '</textarea>' +
      '<div class="dh-map-row"><label>Filter</label><input type="text" data-dh="secFilter" class="dh-ivt-filter" spellcheck="false" value="' + esc(sx.filter || '') + '" placeholder="r.REC > 80"></div>' +
    '</details>' +
    '<div class="dh-merge-note">union re-segment + carry — adds <b>' + cols.length + '</b> column' + (cols.length !== 1 ? 's' : '') +
      ' to the composite' + (cols.length ? ' (' + cols.map(esc).join(', ') + ')' : '') + '; gaps are null-filled and counted</div>' +
    '</div>';
}

// interval data columns of a parsed table other than the mapped BHID/FROM/TO,
// with a sampled type. A11 P5: generic over (parsed, map) so primary + secondary
// interval tables share it.
function dhDataCols(parsed, map) {
  if (!parsed) return [];
  var used = [map.bhid, map.from, map.to];
  var out = [];
  for (var c = 0; c < parsed.header.length; c++) {
    if (used.indexOf(c) >= 0) continue;
    var num = 0, nonEmpty = 0;
    var step = Math.max(1, Math.floor(parsed.rows.length / 200));
    for (var i = 0; i < parsed.rows.length; i += step) {
      var cell = parsed.rows[i][c];
      var v = (cell == null ? '' : String(cell)).trim();   // robust to calcol numeric cells (merge path)
      if (v === '') continue;
      nonEmpty++;
      if (isFinite(parseFloat(v)) && /^[-+0-9.eE]+$/.test(v)) num++;
    }
    out.push({ idx: c, name: parsed.header[c], type: (nonEmpty > 0 && num / nonEmpty >= 0.7) ? 'num' : 'cat' });
  }
  return out;
}
function dhIntervalDataCols(ds) {
  var D = dhStateFor(ds);
  return dhDataCols(D.parsed.intervals, D.map.intervals);
}
// The columnar interval shape { bhid, from, to, cols:[{name,type,values}] } that
// the compositing + merge engines consume, built from a parsed table + its map.
function dhColumnar(parsed, map) {
  var dataCols = dhDataCols(parsed, map);
  var iv = { bhid: [], from: [], to: [], cols: [] };
  for (var c = 0; c < dataCols.length; c++) iv.cols.push({ name: dataCols[c].name, type: dataCols[c].type, values: [] });
  for (var k = 0; k < parsed.rows.length; k++) {
    var rk = parsed.rows[k];
    iv.bhid.push((rk[map.bhid] == null ? '' : String(rk[map.bhid])).trim());
    iv.from.push(parseFloat(rk[map.from]));
    iv.to.push(parseFloat(rk[map.to]));
    for (var c2 = 0; c2 < dataCols.length; c2++) {
      var cell = rk[dataCols[c2].idx];
      var raw = (cell == null ? '' : String(cell)).trim();   // robust to calcol numeric cells (merge path)
      iv.cols[c2].values.push(dataCols[c2].type === 'num' ? (raw === '' ? NaN : parseFloat(raw)) : (raw === '' ? null : raw));
    }
  }
  return iv;
}
// True when a complete second interval table is staged (BHID/FROM/TO mapped).
function dhHasSecondary(D) {
  var sx = D.secondary;
  return !!(sx && sx.parsed && sx.map && sx.map.bhid >= 0 && sx.map.from >= 0 && sx.map.to >= 0);
}

function dhMappingComplete(ds) {
  var D = dhStateFor(ds);
  var m = D.map, p = D.parsed;
  var ivt = dhPrimaryIvt(D);   // A11 P0: the intervals table via the container
  return p.collar && p.survey && ivt && ivt.parsed &&
    m.collar.bhid >= 0 && m.collar.x >= 0 && m.collar.y >= 0 && m.collar.z >= 0 &&
    m.survey.bhid >= 0 && m.survey.at >= 0 && m.survey.az >= 0 && m.survey.dip >= 0 &&
    ivt.map.bhid >= 0 && ivt.map.from >= 0 && ivt.map.to >= 0 &&
    (!D.secondary || dhHasSecondary(D));   // A11 P5: a staged merge table must be mapped too
}

function renderDhMapping(ds) {
  var D = dhStateFor(ds);
  var root = dhCardRoot(ds);
  var $m = dhQ('[data-dh="mapping"]', root);
  if (!$m) return;
  if (!D.parsed.collar || !D.parsed.survey || !D.parsed.intervals) {
    $m.innerHTML = (D.files.collar || D.files.survey || D.files.intervals)
      ? '<div class="dh-status">Waiting for the remaining table(s)…</div>' : '';
    return;
  }

  var html = '<div class="dh-map-tables">';
  html += '<div class="dh-map-table"><div class="dh-map-title">Collar — ' + esc(D.files.collar.name) + dhTableDlBtn('collar') + '</div>' +
    '<div class="dh-map-row"><label>BHID</label>' + dhColSelect(ds, 'collar', 'bhid', D.map.collar.bhid) + '</div>' +
    '<div class="dh-map-row"><label>X</label>' + dhColSelect(ds, 'collar', 'x', D.map.collar.x) + '</div>' +
    '<div class="dh-map-row"><label>Y</label>' + dhColSelect(ds, 'collar', 'y', D.map.collar.y) + '</div>' +
    '<div class="dh-map-row"><label>Z</label>' + dhColSelect(ds, 'collar', 'z', D.map.collar.z) + '</div>' +
    '<div class="dh-map-row"><label>EOH</label>' + dhColSelect(ds, 'collar', 'eoh', D.map.collar.eoh, 'none (advisory)') + '</div></div>';
  html += '<div class="dh-map-table"><div class="dh-map-title">Survey — ' + esc(D.files.survey.name) + dhTableDlBtn('survey') + '</div>' +
    '<div class="dh-map-row"><label>BHID</label>' + dhColSelect(ds, 'survey', 'bhid', D.map.survey.bhid) + '</div>' +
    '<div class="dh-map-row"><label>Depth</label>' + dhColSelect(ds, 'survey', 'at', D.map.survey.at) + '</div>' +
    '<div class="dh-map-row"><label>Azimuth</label>' + dhColSelect(ds, 'survey', 'az', D.map.survey.az) + '</div>' +
    '<div class="dh-map-row"><label>Dip</label>' + dhColSelect(ds, 'survey', 'dip', D.map.survey.dip) + '</div></div>';
  html += '<div class="dh-map-table"><div class="dh-map-title">Intervals — ' + esc(D.files.intervals.name) + dhTableDlBtn('intervals') + '</div>' +
    '<div class="dh-map-row"><label>BHID</label>' + dhColSelect(ds, 'intervals', 'bhid', D.map.intervals.bhid) + '</div>' +
    '<div class="dh-map-row"><label>From</label>' + dhColSelect(ds, 'intervals', 'from', D.map.intervals.from) + '</div>' +
    '<div class="dh-map-row"><label>To</label>' + dhColSelect(ds, 'intervals', 'to', D.map.intervals.to) + '</div>' +
    '<div class="dh-map-row" style="color:var(--fg-dim);font-size:0.65rem">every other column rides along (composited)</div></div>';
  html += '</div>';

  html += dhSecondaryPanelHtml(ds);   // A11 P5: the merge (2nd interval table) panel

  // A11 P2: per-interval-table calcols + filter (applied on export)
  html += dhIvtEditorHtml(ds);

  // A11 P1: download the raw tables (as imported) — single CSVs via the titles
  // above, or the whole set as a zip here.
  html += '<div class="dh-export-row">' +
    '<button type="button" class="dh-zip-dl" data-dh="exportZip" title="Download collar + survey + intervals as a zip">↓ Download tables (zip)</button>' +
    '<span class="dh-export-hint">the raw tables, exactly as imported</span></div>';

  // dip convention — the deliberately loud row (D1)
  var conv = D.dipConvention || 'pos-down';
  html += '<div class="dh-conv-row">' +
    '<span class="dh-conv-label">Dip convention</span>' +
    '<span class="dh-conv-detected">detected from the survey: <b>' +
    (conv === 'neg-down' ? 'negative = down' : 'positive = down') + '</b> — override if your file differs</span>' +
    '<span class="dh-conv-btns">' +
    '<button data-dhconv="pos-down" class="' + (conv === 'pos-down' ? 'active' : '') + '">Positive down</button>' +
    '<button data-dhconv="neg-down" class="' + (conv === 'neg-down' ? 'active' : '') + '">Negative down</button>' +
    '</span></div>';

  // options row
  var dataCols = dhIntervalDataCols(ds);
  var splitSel = dhSplitCols(D);   // A11 P3: effective split columns (migrates legacy domainCol)
  var splitChecks = '';
  var densOpts = '<option value="">— none (length only)</option>';   // A11 P3
  for (var dc = 0; dc < dataCols.length; dc++) {
    if (dataCols[dc].type === 'cat') {
      var on = splitSel.indexOf(dataCols[dc].name) >= 0;
      splitChecks += '<label class="dh-split-chk"><input type="checkbox" data-dh="split" data-dh-col="' + esc(dataCols[dc].name) + '"' + (on ? ' checked' : '') + '>' + esc(dataCols[dc].name) + '</label>';
    } else if (dataCols[dc].type === 'num') densOpts += '<option value="' + esc(dataCols[dc].name) + '">' + esc(dataCols[dc].name) + '</option>';
  }
  if (!splitChecks) splitChecks = '<span class="dh-split-none">— no categorical columns</span>';
  var autoLen = dhAutoLength(ds);
  function mOpt(v, label) {
    return '<option value="' + v + '"' + (D.opts.method === v ? ' selected' : '') + '>' + label + '</option>';
  }
  html += '<div class="dh-opts">' +
    '<div class="dh-opt"><label>Desurvey method</label><select data-dh="method">' +
      mOpt('minimumCurvature', 'Minimum curvature') +
      mOpt('balancedTangential', 'Balanced tangential') +
      mOpt('tangential', 'Tangential') + '</select></div>' +
    '<div class="dh-opt"><label>Composite length</label><input type="number" data-dh="length" class="dh-narrow" min="0" step="any" value="' + esc(D.opts.length) + '" placeholder="' + (autoLen != null ? autoLen : 'auto') + '"></div>' +
    '<div class="dh-opt dh-opt-wide"><label>Break on (splits)</label><div class="dh-split-cols">' + splitChecks + '</div></div>' +
    '<div class="dh-opt"><label>Density (mass-weight)</label><select data-dh="density">' + densOpts + '</select></div>' +
    '<div class="dh-opt"><label>Min coverage %</label><input type="number" data-dh="minCov" class="dh-narrow" min="0" max="100" step="any" value="' + esc(D.opts.minCov) + '" placeholder="off"></div>' +
    '</div>';

  html += dhCombineEditorHtml(ds);   // A11 P3: per-column combine rules

  html += '<div class="dh-actions">' +
    '<button class="dh-go" data-dh="go"' + (dhMappingComplete(ds) ? '' : ' disabled') + '>Composite &amp; load ▶</button>' +
    '<span class="dh-status" data-dh="status"></span>' +
    // C12-P1: revealed by setGenStale when the recipe/sources change after a composite (no-silent-stale)
    '<span class="gen-stale-note" style="display:none">↻ recipe changed — re-composite</span></div>';

  // A11 emit-as-dataset: emit a table as its own derived dataset (no compositing)
  if (D.parsed.collar) {
    html += '<div class="dh-emit-row"><span class="dh-emit-label">Emit as dataset:</span>' +
      '<button class="dh-emit-btn" data-dh="emitCollar" title="Load the collar table as a point dataset, derived from this set">⬡ Collar (points)</button>' +
      '</div>';
  }

  $m.innerHTML = html;
  // density select applied after render (option list is data-driven; splits are
  // checkboxes rendered checked inline)
  var $dens = dhQ('[data-dh="density"]', root);
  if ($dens && D.opts.densityCol) $dens.value = D.opts.densityCol;
  dhRenderIvtStatus(ds);   // A11 P2: calc-column / kept-row / error summary
  dhReflectStale(ds);      // C12-P1: restore the stale "re-composite" cue across a re-render
}

// ── C12-P1: composite staleness ──────────────────────────────────────────
// A composite Derivation goes stale when its recipe or sources change after one
// was produced (re-drop a file, edit a compositing option / mapping / split /
// density / combine / convention). dhReflectStale paints the cue on the
// "Composite & load" button via the shared C6-5 gen-stale pattern;
// dhMarkCompositeStaleIfLoaded routes through derivMarkStale so the staleness
// PROPAGATES to the dataset's analysis (its downstream node). No-silent-stale.
function dhReflectStale(ds) {
  var root = dhCardRoot(ds);
  if (!root) return;
  var stale = !!dhStateFor(ds)._stale;
  // Show the "re-composite" cue + emphasize the button WITHOUT dimming it when
  // fresh (so the loaded-state look is unchanged from today — no gen-done flip).
  var note = root.querySelector('.dh-actions .gen-stale-note');
  if (note) note.style.display = stale ? 'block' : 'none';
  var go = root.querySelector('[data-dh="go"]');
  if (go) go.classList.toggle('dh-go--stale', stale);
}
function dhMarkCompositeStaleIfLoaded(ds) {
  // Only meaningful once a composite has been produced for this set; the first
  // drop / mapping edits before any composite are not "stale", just incomplete.
  if (dhStateFor(ds).derivedName && typeof derivMarkStale === 'function') {
    derivMarkStale('composite:' + ds.id);
  }
}

// A11 P3: per-column combine rules — how each interval data column aggregates
// over a composite (numeric: mean/sum/min/max; categorical: majority/first).
// Stored as D.opts.combine {colName: rule}; only non-default entries are kept.
var DH_COMBINE_NUM = [['mean', 'Mean'], ['sum', 'Sum'], ['min', 'Min'], ['max', 'Max']];
var DH_COMBINE_CAT = [['majority', 'Majority'], ['first', 'First']];
function dhCombineDefault(type) { return type === 'num' ? 'mean' : 'majority'; }
// A11 P3: the effective split columns, migrating a legacy single domainCol the
// first time it's read (so old recipes/sessions become multi-split transparently).
function dhSplitCols(D) {
  if (!D.opts.splitCols && D.opts.domainCol) { D.opts.splitCols = [D.opts.domainCol]; D.opts.domainCol = ''; }
  return D.opts.splitCols || [];
}
function dhCombineEditorHtml(ds) {
  var D = dhStateFor(ds);
  var cols = dhIntervalDataCols(ds);
  if (!cols.length) return '';
  var combine = D.opts.combine || {};
  var anySet = Object.keys(combine).length > 0;
  var rows = '';
  for (var i = 0; i < cols.length; i++) {
    var col = cols[i];
    var cur = combine[col.name] || dhCombineDefault(col.type);
    var opts = col.type === 'num' ? DH_COMBINE_NUM : DH_COMBINE_CAT;
    var sel = '<select data-dh="combine" data-dh-col="' + esc(col.name) + '" data-dh-type="' + col.type + '">';
    for (var o = 0; o < opts.length; o++) sel += '<option value="' + opts[o][0] + '"' + (cur === opts[o][0] ? ' selected' : '') + '>' + opts[o][1] + '</option>';
    sel += '</select>';
    rows += '<div class="dh-map-row"><label title="' + esc(col.name) + '">' + esc(col.name) + '</label>' + sel + '</div>';
  }
  return '<details class="dh-ivt-edit dh-combine-edit"' + (anySet ? ' open' : '') + '>' +
    '<summary class="dh-ivt-edit-title">Combine rules<span class="dh-ivt-edit-hint"> — how each column aggregates over a composite</span></summary>' +
    rows + '</details>';
}

// A11 P2: the interval table's calcols + filter editor (applied on export).
function dhIvtEditorHtml(ds) {
  var ivt = dhPrimaryIvt(dhStateFor(ds));
  if (!ivt) return '';
  var code = ivt.calcolCode || '', filt = ivt.filter || '';
  return '<details class="dh-ivt-edit"' + ((code || filt) ? ' open' : '') + '>' +
    '<summary class="dh-ivt-edit-title">Interval calcols &amp; filter<span class="dh-ivt-edit-hint"> — added columns + row filter, applied on export</span></summary>' +
    '<textarea data-dh="ivtCalc" class="dh-ivt-calc" rows="2" spellcheck="false" placeholder="r.Fe_pct = r.Fe / 100">' + esc(code) + '</textarea>' +
    '<div class="dh-map-row"><label>Filter</label><input type="text" data-dh="ivtFilter" class="dh-ivt-filter" spellcheck="false" value="' + esc(filt) + '" placeholder="r.Fe > 0"></div>' +
    '<div class="dh-ivt-status" data-dh="ivtStatus"></div>' +
    '</details>';
}
// Live status under the editor: detected calc columns, kept/total rows, and any
// syntax/runtime/excluded counts — surfaced, never silently dropped (A9 rule).
function dhRenderIvtStatus(ds) {
  var D = dhStateFor(ds), ivt = dhPrimaryIvt(D);
  var $s = dhQ('[data-dh="ivtStatus"]', dhCardRoot(ds));
  if (!$s) return;
  var hasCalc = ivt && ivt.calcolCode && ivt.calcolCode.trim();
  var hasFilt = ivt && ivt.filter && ivt.filter.trim();
  if (!ivt || !ivt.parsed || (!hasCalc && !hasFilt)) { $s.innerHTML = ''; return; }
  var ev = dhTableEval(ivt.parsed, ivt.calcolCode, ivt.filter);
  var bits = [];
  if (ev.calcSyntaxError) bits.push('<span class="dh-ivt-err">calcol syntax: ' + esc(ev.calcSyntaxError) + '</span>');
  else if (ev.calcCols.length) bits.push('<b>' + ev.calcCols.length + '</b> calc col' + (ev.calcCols.length > 1 ? 's' : '') + ' (' + ev.calcCols.map(esc).join(', ') + ')');
  if (ev.filterSyntaxError) bits.push('<span class="dh-ivt-err">filter syntax: ' + esc(ev.filterSyntaxError) + '</span>');
  else if (hasFilt) bits.push('<b>' + ev.kept.toLocaleString() + '</b>/' + ev.total.toLocaleString() + ' rows kept');
  if (ev.calcErrors) bits.push('<span class="dh-ivt-err">' + ev.calcErrors + ' calc-error row' + (ev.calcErrors > 1 ? 's' : '') + '</span>');
  if (ev.filterErrors) bits.push('<span class="dh-ivt-err">' + ev.filterErrors + ' filter-error row' + (ev.filterErrors > 1 ? 's' : '') + ' excluded</span>');
  $s.innerHTML = bits.join(' · ');
}

function dhAutoLength(ds) {
  var D = dhStateFor(ds);
  var p = D.parsed.intervals, m = D.map.intervals;
  if (!p || m.from == null || m.from < 0 || m.to == null || m.to < 0) return null;
  var from = [], to = [];
  for (var i = 0; i < p.rows.length; i++) {
    from.push(parseFloat(p.rows[i][m.from]));
    to.push(parseFloat(p.rows[i][m.to]));
  }
  return Drillhole.defaultLength({ bhid: [], from: from, to: to, cols: [] });
}

// ── composite & load ────────────────────────────────────────────────────

function dhBuildTables(ds) {
  var D = dhStateFor(ds);
  var pc = D.parsed.collar, mc = D.map.collar;
  var collars = [];
  for (var i = 0; i < pc.rows.length; i++) {
    var r = pc.rows[i];
    collars.push({
      bhid: (r[mc.bhid] || '').trim(),
      x: parseFloat(r[mc.x]), y: parseFloat(r[mc.y]), z: parseFloat(r[mc.z]),
      eoh: mc.eoh >= 0 ? parseFloat(r[mc.eoh]) : NaN,
    });
  }
  var ps = D.parsed.survey, ms = D.map.survey;
  var surveys = [];
  for (var s = 0; s < ps.rows.length; s++) {
    var rs = ps.rows[s];
    surveys.push({
      bhid: (rs[ms.bhid] || '').trim(),
      depth: parseFloat(rs[ms.at]), az: parseFloat(rs[ms.az]), dip: parseFloat(rs[ms.dip]),
    });
  }
  var iv = dhColumnar(D.parsed.intervals, D.map.intervals);
  // A11 P5: a second interval table merges into the source (the P4 kernel) so the
  // composite carries columns from both; its merge report rides alongside.
  D._mergeReport = null;
  if (dhHasSecondary(D)) {
    var sx = D.secondary, secParsed = sx.parsed;
    // pre-merge per-table calcols/filter on the secondary (calcols append cols,
    // bhid/from/to indices unchanged, so the map still resolves)
    if ((sx.calcolCode && sx.calcolCode.trim()) || (sx.filter && sx.filter.trim())) {
      var ev = dhTableEval(sx.parsed, sx.calcolCode, sx.filter);
      secParsed = { header: ev.header, rows: ev.rows };
    }
    var merged = Drillhole.mergeIntervals(iv, dhColumnar(secParsed, sx.map));
    iv = { bhid: merged.bhid, from: merged.from, to: merged.to, cols: merged.cols };
    D._mergeReport = merged.report;
  }
  return { collars: collars, surveys: surveys, intervals: iv };
}

function dhCsvCell(v) {
  if (v == null) return '';
  if (typeof v === 'number') return isFinite(v) ? String(v) : '';
  var s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// ── A17: composite length-distribution histograms (compositing QA) ─────────
// The raw interval lengths (TO−FROM of the imported intervals table) vs the
// composite SUPPORT (covered length, result column 6) — the geologist sees at a
// glance how compositing regularized the support, and the short / low-coverage
// tail the min-coverage filter targets. Viz-only; both quantities already exist.
function dhComputeLengthHist(D, rows) {
  var raw = [], pr = D.parsed.intervals, mi = D.map.intervals;
  if (pr && mi) {
    for (var i = 0; i < pr.rows.length; i++) {
      var L = parseFloat(pr.rows[i][mi.to]) - parseFloat(pr.rows[i][mi.from]);
      if (isFinite(L) && L > 0) raw.push(L);
    }
  }
  var comp = [];
  for (var j = 0; j < rows.length; j++) { var sup = rows[j][6]; if (isFinite(sup) && sup > 0) comp.push(sup); }
  return (raw.length && comp.length) ? { raw: raw, comp: comp } : null;
}
function dhLengthHistHtml(h) {
  if (!h || !h.raw || !h.raw.length || !h.comp || !h.comp.length) return '';
  var all = h.raw.concat(h.comp), max = 0;
  for (var i = 0; i < all.length; i++) if (all[i] > max) max = all[i];
  if (!(max > 0)) return '';
  var NB = 14, bw = max / NB;
  function bin(arr) { var b = []; for (var i = 0; i < NB; i++) b.push(0); for (var k = 0; k < arr.length; k++) b[Math.min(NB - 1, Math.floor(arr[k] / bw))]++; return b; }
  function mean(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : 0; }
  var rb = bin(h.raw), cb = bin(h.comp), pm = 1;
  for (var i2 = 0; i2 < NB; i2++) { if (rb[i2] > pm) pm = rb[i2]; if (cb[i2] > pm) pm = cb[i2]; }
  function bars(b, cls) {
    var s = '';
    for (var i = 0; i < NB; i++) s += '<div class="dh-hist-bar ' + cls + '" style="height:' + Math.round(b[i] / pm * 100) + '%" title="' + (i * bw).toFixed(1) + '–' + ((i + 1) * bw).toFixed(1) + ': ' + b[i] + '"></div>';
    return s;
  }
  function lab(name, a) { return '<div class="dh-hist-label">' + name + ' <span>n=' + a.length.toLocaleString() + ' · mean ' + mean(a).toFixed(2) + '</span></div>'; }
  return '<div class="dh-hist">' +
    '<div class="dh-hist-title">Support length — before vs after compositing</div>' +
    '<div class="dh-hist-row">' + lab('before', h.raw) + '<div class="dh-hist-bars">' + bars(rb, 'before') + '</div></div>' +
    '<div class="dh-hist-row">' + lab('after', h.comp) + '<div class="dh-hist-bars">' + bars(cb, 'after') + '</div></div>' +
    '<div class="dh-hist-axis"><span>0</span><span>length →</span><span>' + max.toFixed(1) + '</span></div>' +
    '</div>';
}

function dhCompositeAndLoad(ds) {
  var D = dhStateFor(ds);
  var root = dhCardRoot(ds);
  if (!dhMappingComplete(ds)) return;
  dhSetStatus(ds, 'Compositing…');
  var lenInput = parseFloat(D.opts.length);
  var covInput = parseFloat(D.opts.minCov);
  var opts = {
    method: D.opts.method || 'minimumCurvature',
    dipConvention: D.dipConvention || 'pos-down',
    compositeLength: isFinite(lenInput) && lenInput > 0 ? lenInput : null,
    splitCols: dhSplitCols(D).length ? dhSplitCols(D) : null,   // A11 P3: multi-column splits
    densityCol: D.opts.densityCol || null,   // A11 P3: mass weighting
    combine: D.opts.combine || null,         // A11 P3: per-column combine rules
    minCoverage: isFinite(covInput) && covInput > 0 ? covInput / 100 : null,
  };
  var result;
  try {
    result = Drillhole.process(dhBuildTables(ds), opts);
  } catch (err) {
    dhSetStatus(ds, 'Compositing failed: ' + err.message, true);
    return;
  }
  D.lastReport = result.report;
  // A11 P5: fold the merge consistency checks (gaps/collisions/overlaps) into the
  // composite report so they surface alongside the compositing ones.
  if (D._mergeReport && D._mergeReport.checks.length) {
    D.lastReport.checks = D.lastReport.checks.concat(D._mergeReport.checks);
    D.lastReport.merged = true;
  }
  D._lengthHist = dhComputeLengthHist(D, result.rows);   // A17: support before/after compositing
  renderDhReport(ds, dhQ('[data-dh="reportInline"]', root));
  if (result.rows.length === 0) {
    dhSetStatus(ds, 'No composites produced — check the report above.', true);
    return;
  }

  var lines = [result.header.join(',')];
  for (var i = 0; i < result.rows.length; i++) {
    lines.push(result.rows[i].map(dhCsvCell).join(','));
  }
  var stem = (D.files.intervals.name.replace(/\.(csv|txt|dat)$/i, '') || 'drillholes');
  D.derivedName = stem + '-composites.csv';
  D.provFiles = [D.files.collar.name, D.files.survey.name, D.files.intervals.name];
  var file = new File([lines.join('\n') + '\n'], D.derivedName, { type: 'text/csv' });

  // C12-P1: a fresh composite clears the recipe-stale cue (its derive() just ran)
  D._stale = false;
  dhReflectStale(ds);
  // SUPPORT is the support weight by construction — assign the role before
  // the load so the dataset sidebar renders with it selected (visible, not magic)
  catSetRole(ds.id, 'weight', 'SUPPORT');
  ds.prefix = 'dh';
  dhSetStatus(ds, result.report.nComposites.toLocaleString() + ' composites from ' +
    result.report.nHoles + ' holes — loading…');
  loadAuxFile(file, null, undefined, ds, root);
}

// ── consistency report ──────────────────────────────────────────────────

function renderDhReport(ds, container) {
  if (!container) return;
  var rep = dhStateFor(ds).lastReport;
  if (!rep) { container.innerHTML = ''; return; }
  var html = '<div class="dh-report-summary"><b>' + rep.nComposites.toLocaleString() + '</b> composites from <b>' +
    rep.nHoles + '</b> holes · length <b>' + rep.compositeLength + '</b> · dip <b>' +
    (rep.dipConvention === 'neg-down' ? 'negative-down' : 'positive-down') + '</b></div>';
  if (!rep.checks.length) {
    html += '<div class="dh-report-clean">✓ No consistency issues — all rows joined and composited.</div>';
  } else {
    for (var i = 0; i < rep.checks.length; i++) {
      var c = rep.checks[i];
      html += '<details class="dh-check"><summary><span class="dh-check-count">' + c.count + '</span> — ' +
        esc(c.label) + '</summary><div class="dh-check-bhids">' +
        (c.bhids.length ? 'BHIDs: ' + c.bhids.map(esc).join(', ') : '(no per-hole detail)') +
        '</div></details>';
    }
  }
  html += dhLengthHistHtml(dhStateFor(ds)._lengthHist);   // A17: before/after support histograms
  container.innerHTML = html;
}

function dhOpenReportModal(ds) {
  renderDhReport(ds, document.getElementById('dhReportBody'));
  document.getElementById('dhReportModal').classList.add('active');
}

// Provenance banner in the dataset config header — called from renderAuxConfig
function renderDhProvenance(ds) {
  ds = ds || dsById('aux');
  var D = dhStateFor(ds);
  var root = dhCardRoot(ds);
  var $head = dhQ('[data-aux="head"]', root);
  if (!$head) return;
  var old = $head.querySelector('.dh-provenance');
  if (old) old.remove();
  if (!ds.file || !D.derivedName || ds.file.name !== D.derivedName || !D.lastReport) return;
  var div = document.createElement('div');
  div.className = 'dh-provenance';
  div.innerHTML = '<span>' + D.lastReport.nComposites.toLocaleString() + ' composites from ' +
    D.lastReport.nHoles + ' holes · ' + D.provFiles.map(esc).join(' + ') + '</span>' +
    '<button data-dh="provReport">Report</button>' +
    '<button data-dh="provEdit">Edit &amp; re-composite</button>';
  $head.appendChild(div);
  div.querySelector('[data-dh="provReport"]').addEventListener('click', function() { dhOpenReportModal(ds); });
  // Non-destructive: reveal the drillhole card (slots/mapping/options) in place
  // WITHOUT unloading the composite — edit a setting and "Composite & load ▶"
  // re-derives over it, or "← Back to results" returns. (No more unload dance.)
  div.querySelector('[data-dh="provEdit"]').addEventListener('click', function() {
    dhShowEditCard(ds);
  });
}

// Toggle a dataset panel between the composite RESULTS (config view) and the
// drillhole EDITING card (load-area view), keeping all state intact.
function dhShowEditCard(ds) {
  var root = dhCardRoot(ds);
  var emptyEl = dhQ('[data-aux="empty"]', root);
  var cfgEl = dhQ('[data-aux="config"]', root);
  if (emptyEl) emptyEl.style.display = '';
  if (cfgEl) cfgEl.style.display = 'none';
  renderDhCard(ds);   // refresh slots/mapping/options + show the Back button
}
function dhShowResults(ds) {
  var root = dhCardRoot(ds);
  var emptyEl = dhQ('[data-aux="empty"]', root);
  var cfgEl = dhQ('[data-aux="config"]', root);
  if (cfgEl && ds.file) cfgEl.style.display = '';
  if (emptyEl && ds.file) emptyEl.style.display = 'none';
}

// ── A11 emit-as-dataset (slice 1: collar) ─────────────────────────────────
// A drillhole SET is a container: any of its tables can emit its own registry
// dataset, derived (source-linked) from the set. Collar is the clean first
// target — it already has XYZ, no desurvey/compositing — so "emit collar" =
// "load the set's collar as a point dataset without compositing it". The emitted
// dataset carries derivedFrom {set, role} so it re-derives from the set on reload
// (persistence: a follow-up slice) and shows in the C12 lineage DAG.
function dhEmitCollarCsv(D) {
  var p = D.parsed.collar, m = D.map.collar || {};
  var used = {}, cols = [];
  function add(name, idx) { if (idx != null && idx >= 0 && !used[idx]) { used[idx] = 1; cols.push({ name: name, idx: idx }); } }
  add('BHID', m.bhid); add('X', m.x); add('Y', m.y); add('Z', m.z); add('EOH', m.eoh);
  for (var i = 0; i < p.header.length; i++) if (!used[i]) cols.push({ name: p.header[i], idx: i });   // any extra collar columns, verbatim
  var lines = [cols.map(function (c) { return c.name; }).join(',')];
  for (var r = 0; r < p.rows.length; r++) lines.push(cols.map(function (c) { return dhCsvCell(p.rows[r][c.idx]); }).join(','));
  return lines.join('\n') + '\n';
}
function dhEmitFileName(srcDs, role) {
  var D = dhStateFor(srcDs);
  var base = (D.files.collar && D.files.collar.name) || (srcDs.prefix || 'drillholes');
  return base.replace(/\.(csv|txt|dat)$/i, '') + '-' + role + '.csv';
}
// Emit a derived dataset for the given role ('collar' for now) from a loaded set.
function dhEmitDataset(srcDs, role) {
  var D = dhStateFor(srcDs);
  if (role !== 'collar') return;
  if (!D.parsed.collar) { dhSetStatus(srcDs, 'No collar table to emit.', true); return; }
  if (!wsRails || typeof dsCreate !== 'function' || typeof wsMainTarget !== 'function') {
    if (typeof bmaConfirm === 'function') bmaConfirm({ title: 'Emit dataset', html: 'Emitting a dataset needs the desktop (rails) workspace.', okLabel: 'OK' });
    return;
  }
  var csv = dhEmitCollarCsv(D);
  var file = new File([csv], dhEmitFileName(srcDs, role), { type: 'text/csv' });
  var newDs = dsCreate({ prefix: (srcDs.prefix || 'dh') + ':' + role });
  newDs.derivedFrom = { set: srcDs.id, role: role };   // C12 link + re-derive seed (persist: follow-up)
  dsAdd(newDs);
  wsRails.addTab({ id: newDs.id, title: 'Import: ' + newDs.prefix, closeable: true }, wsMainTarget());
  wsRails.activateTab(newDs.id);
  var root = (typeof dsConfigRoot === 'function') ? dsConfigRoot(newDs) : null;
  loadAuxFile(file, null, undefined, newDs, root);
  if (typeof renderTree === 'function') renderTree();
}

// ── persistence (Phase 2, D8) ───────────────────────────────────────────
// The recipe (file identities + mapping + options) rides the project; the
// derived CSV is never persisted — restore re-derives, like declus weights.

function dhAutoSave() {
  if (typeof autoSaveProject === 'function') autoSaveProject();
}

// Mapping stored by column NAME (robust to reordered exports), index kept
// as the tiebreaker for duplicate headers
function dhMapToNames(ds, role) {
  var D = dhStateFor(ds);
  var p = D.parsed[role];
  var out = {};
  for (var f in D.map[role]) {
    var idx = D.map[role][f];
    out[f] = (idx != null && idx >= 0) ? { name: p.header[idx], idx: idx } : null;
  }
  return out;
}

function dhMapFromNames(ds, role, saved) {
  return dhMapIdxFromParsed(dhStateFor(ds).parsed[role], saved);
}
// A11 P5: parsed-based variants (the secondary table's parsed/map live off the
// role slots, so the ds/role helpers above don't reach it).
function dhMapNamesFromParsed(parsed, map) {
  var out = {};
  for (var f in map) { var idx = map[f]; out[f] = (idx != null && idx >= 0) ? { name: parsed.header[idx], idx: idx } : null; }
  return out;
}
function dhMapIdxFromParsed(parsed, saved) {
  var out = {};
  for (var f in saved) {
    var s = saved[f];
    if (!s) { out[f] = -1; continue; }
    var idx = parsed.header.indexOf(s.name);
    if (idx < 0 && s.idx != null && s.idx < parsed.header.length) idx = s.idx;
    out[f] = idx;
  }
  return out;
}

// The drillhole recipe for one dataset — null when no complete trio is staged
function dhSerialize(ds) {
  var D = dhStateFor(ds);
  var ivt = dhPrimaryIvt(D);   // A11 P0: the intervals table via the container
  if (!D.parsed.collar || !D.parsed.survey || !ivt || !ivt.parsed) return null;
  var files = {
    collar: { name: D.files.collar.name, size: D.files.collar.size },
    survey: { name: D.files.survey.name, size: D.files.survey.size },
    intervals: { name: ivt.file.name, size: ivt.file.size },
  };
  var map = { collar: dhMapToNames(ds, 'collar'), survey: dhMapToNames(ds, 'survey'), intervals: dhMapToNames(ds, 'intervals') };
  var secondaryCalcols = null;
  if (dhHasSecondary(D)) {   // A11 P5: the merge table rides as a 4th "role" (files+map) for pack extraction
    files.secondary = { name: D.secondary.file.name, size: D.secondary.file.size };
    map.secondary = dhMapNamesFromParsed(D.secondary.parsed, D.secondary.map);
    if (D.secondary.calcolCode || D.secondary.filter) secondaryCalcols = { calcolCode: D.secondary.calcolCode || '', filter: D.secondary.filter || '' };
  }
  return {
    files: files,
    map: map,
    dipConvention: D.dipConvention,
    opts: { method: D.opts.method, length: D.opts.length, splitCols: dhSplitCols(D).length ? dhSplitCols(D) : null, densityCol: D.opts.densityCol, combine: D.opts.combine || null, minCov: D.opts.minCov },
    // A11 P2: the interval table's per-table calcols + filter (omitted when empty)
    intervalCalcols: (ivt.calcolCode || ivt.filter) ? { calcolCode: ivt.calcolCode || '', filter: ivt.filter || '' } : null,
    secondaryCalcols: secondaryCalcols,   // A11 P5: the merge table's pre-merge calcols/filter
    loaded: !!(ds.file && D.derivedName && ds.file.name === D.derivedName),
  };
}

// Serialize EVERY dataset's drillhole recipe as { dsId: recipe } (datasets with
// no staged trio are omitted; null when none). Legacy single-set projects wrote
// a flat recipe object — applyProject/displayResults normalize that into { aux }.
function dhSerializeAll() {
  var out = null;
  for (var id in dhStates) {
    if (!dhStates.hasOwnProperty(id)) continue;
    var ds = dsById(id);
    if (!ds) continue;
    var rec = dhSerialize(ds);
    if (rec) { out = out || {}; out[id] = rec; }
  }
  return out;
}

// New file / Clear project: every dataset's drillhole set starts fresh.
function dhResetAll() {
  dhReset(dsById('aux'));   // the aux card is static + visible — re-render empty
  dhStates = {};            // drop every other dataset's staged set
}

// applyProject hands the saved recipe here; it applies when the files land
function dhRestoreFromProject(ds, saved) {
  dhStateFor(ds).pendingRestore = (saved && saved.files) ? saved : null;
  renderDhCard(ds);
}

// Files just landed in slots — if a pending recipe matches by name, apply
// its mapping/options; when the whole trio matches a loaded:true recipe,
// re-composite automatically (the user's saved intent — and the report
// still renders, so nothing happens invisibly)
function dhTryApplyPendingRestore(ds) {
  var D = dhStateFor(ds);
  var pr = D.pendingRestore;
  if (!pr) return;
  var allMatch = true;
  for (var r = 0; r < DH_ROLES.length; r++) {
    var role = DH_ROLES[r];
    if (!D.files[role] || D.files[role].name !== pr.files[role].name) { allMatch = false; continue; }
    D.map[role] = dhMapFromNames(ds, role, pr.map[role]);
  }
  if (pr.files && pr.files.secondary) {   // A11 P5: restore the merge table when its file lands
    if (D.secondary && D.secondary.file.name === pr.files.secondary.name) {
      D.secondary.map = dhMapIdxFromParsed(D.secondary.parsed, (pr.map && pr.map.secondary) || {});
      if (pr.secondaryCalcols) { D.secondary.calcolCode = pr.secondaryCalcols.calcolCode || ''; D.secondary.filter = pr.secondaryCalcols.filter || null; }
    } else allMatch = false;
  }
  if (pr.dipConvention) D.dipConvention = pr.dipConvention;
  if (pr.opts) {
    D.opts.method = pr.opts.method || 'minimumCurvature';
    D.opts.length = pr.opts.length || '';
    // A11 P3: splits — accept the new array or migrate a legacy single domainCol
    D.opts.splitCols = pr.opts.splitCols || (pr.opts.domainCol ? [pr.opts.domainCol] : null);
    D.opts.domainCol = '';
    D.opts.densityCol = pr.opts.densityCol || '';   // A11 P3
    D.opts.combine = pr.opts.combine || null;       // A11 P3
    D.opts.minCov = pr.opts.minCov || '';
  }
  if (pr.intervalCalcols) {   // A11 P2: per-table calcols/filter (once the intervals table exists)
    var ivt = dhPrimaryIvt(D);
    if (ivt) { ivt.calcolCode = pr.intervalCalcols.calcolCode || ''; ivt.filter = pr.intervalCalcols.filter || ''; }
  }
  if (allMatch) {
    var wasLoaded = pr.loaded;
    D.pendingRestore = null;
    renderDhCard(ds);
    if (wasLoaded && dhMappingComplete(ds)) dhCompositeAndLoad(ds);
  }
}

// Packed-project path: the raw trio extracted from the archive
async function dhLoadTrio(ds, trio) {
  var D = dhStateFor(ds);
  for (var r = 0; r < DH_ROLES.length; r++) {
    var f = trio[DH_ROLES[r]];
    if (f) {
      D.files[DH_ROLES[r]] = f;
      D.parsed[DH_ROLES[r]] = await dhParseFile(f);
      D.map[DH_ROLES[r]] = dhAutoMap(DH_ROLES[r], D.parsed[DH_ROLES[r]].header);
    }
  }
  if (trio.secondary) {   // A11 P5: the packed merge table re-derives like the trio
    D.secondary = { file: trio.secondary, parsed: await dhParseFile(trio.secondary), map: {}, calcolCode: '', filter: null };
    D.secondary.map = dhAutoMap('intervals', D.secondary.parsed.header);
  }
  D.dipConvention = dhDetectConventionFromParsed(ds);
  renderDhCard(ds);
  dhTryApplyPendingRestore(ds);
}

// Pack integration (D8): when a dataset is drillhole-derived, the archive
// carries the RAW trio — the recipe in the project json re-derives on load
function dhIsDerivedAux(ds) {
  var D = dhStateFor(ds);
  return !!(ds.file && D.derivedName && ds.file.name === D.derivedName &&
    D.files.collar && D.files.survey && D.files.intervals);
}
function dhPackFiles(ds) {
  var D = dhStateFor(ds);
  var fs = [D.files.collar, D.files.survey, D.files.intervals];
  if (dhHasSecondary(D)) fs.push(D.secondary.file);   // A11 P5: bundle the merge table
  return fs;
}

// New file / Clear project: drillhole state starts fresh
function dhReset(ds) {
  var D = dhStateFor(ds);
  D.pendingRestore = null;
  D.derivedName = null;
  D.provFiles = null;
  D.opts = { method: 'minimumCurvature', length: '', domainCol: '', minCov: '' };
  dhClearAll(ds);
}

// ── wiring — per dataset panel (called from wireDatasetPanel) ────────────
// Attaches the drillhole card's listeners scoped to one dataset's panel root,
// resolving the owning ds via closure. No-op when the panel has no card (the
// rails clone keeps the card only when it can host a set). The shared report
// modal's close button is wired once, globally, below.
function wireDhCard(root, ds) {
  var $card = dhQ('[data-dh="card"]', root);
  var $input = dhQ('[data-dh="fileInput"]', root);
  if (!$card || !$input) return;
  if ($card._dhWired) { renderDhCard(ds); return; }
  $card._dhWired = true;

  $card.addEventListener('click', function(e) {
    if (e.target.closest('.dh-slot')) { $input.click(); return; }
  });
  $card.addEventListener('dragover', function(e) {
    e.preventDefault(); e.stopPropagation();
    var slot = e.target.closest('.dh-slot');
    if (slot) slot.classList.add('drag-over');
  });
  $card.addEventListener('dragleave', function(e) {
    var slot = e.target.closest('.dh-slot');
    if (slot) slot.classList.remove('drag-over');
  });
  $card.addEventListener('drop', function(e) {
    e.preventDefault(); e.stopPropagation();
    $card.querySelectorAll('.dh-slot').forEach(function(s) { s.classList.remove('drag-over'); });
    var files = Array.from(e.dataTransfer.files || []);
    if (files.length) dhAssignFiles(ds, files);
  });
  $input.addEventListener('change', function() {
    var files = Array.from($input.files || []);
    $input.value = '';
    if (files.length) dhAssignFiles(ds, files);
  });

  // delegated: mapping selects, option inputs, convention toggle, composite, clear
  $card.addEventListener('change', function(e) {
    var D = dhStateFor(ds);
    var map = e.target.dataset && e.target.dataset.dhmap;
    if (map) {
      var parts = map.split(':');
      if (parts[0] === 'secondary') {            // A11 P5: the merge table's own map
        if (D.secondary) D.secondary.map[parts[1]] = parseInt(e.target.value);
      } else {
        D.map[parts[0]][parts[1]] = parseInt(e.target.value);
        if (parts[0] === 'survey' && parts[1] === 'dip') D.dipConvention = dhDetectConventionFromParsed(ds);
      }
      renderDhMapping(ds);
      dhMarkCompositeStaleIfLoaded(ds);   // C12-P1: a mapping change invalidates the composite
      dhAutoSave();
      return;
    }
    var k = e.target.dataset && e.target.dataset.dh;
    if (k === 'method') { D.opts.method = e.target.value; dhAutoSave(); }
    else if (k === 'length') { D.opts.length = e.target.value; dhAutoSave(); }
    else if (k === 'split') {   // A11 P3: toggle a split column
      var scol = e.target.dataset.dhCol;
      var arr = D.opts.splitCols || (D.opts.splitCols = []);
      var si = arr.indexOf(scol);
      if (e.target.checked) { if (si < 0) arr.push(scol); }
      else if (si >= 0) arr.splice(si, 1);
      dhAutoSave();
    }
    else if (k === 'density') { D.opts.densityCol = e.target.value; dhAutoSave(); }   // A11 P3
    else if (k === 'combine') {   // A11 P3: per-column combine rule
      var col = e.target.dataset.dhCol, rule = e.target.value;
      var def = dhCombineDefault(e.target.dataset.dhType);
      if (!D.opts.combine) D.opts.combine = {};
      if (rule === def) delete D.opts.combine[col]; else D.opts.combine[col] = rule;
      if (!Object.keys(D.opts.combine).length) D.opts.combine = null;
      dhAutoSave();
    }
    else if (k === 'minCov') { D.opts.minCov = e.target.value; dhAutoSave(); }
    else if (k === 'ivtCalc' || k === 'ivtFilter') {   // A11 P2: per-table calcols/filter
      var ivt = dhPrimaryIvt(D);
      if (ivt) {
        if (k === 'ivtCalc') ivt.calcolCode = e.target.value;
        else ivt.filter = e.target.value;
        dhRenderIvtStatus(ds);
        dhAutoSave();
      }
    }
    else if (k === 'secCalc' || k === 'secFilter') {   // A11 P5: pre-merge calcols on the 2nd table
      if (D.secondary) {
        if (k === 'secCalc') D.secondary.calcolCode = e.target.value;
        else D.secondary.filter = e.target.value;
        renderDhMapping(ds);   // refresh the merge note (added columns may change)
        dhAutoSave();
      }
    }
    // C12-P1: any compositing-recipe edit invalidates the composite + propagates
    // to its analysis. ivtCalc/ivtFilter are export-only (A11 P2) → not a recipe
    // change, so they are excluded.
    if (k && k !== 'ivtCalc' && k !== 'ivtFilter') dhMarkCompositeStaleIfLoaded(ds);
  });
  $card.addEventListener('click', function(e) {
    var btn = e.target.closest ? e.target.closest('[data-dh]') : null;
    var dk = btn && btn.dataset.dh;
    if (dk === 'exportTable') { dhExportTable(ds, btn.dataset.dhRole); return; }   // A11 P1
    if (dk === 'exportZip') { dhExportTablesZip(ds); return; }                     // A11 P1
    if (e.target.dataset && e.target.dataset.dh === 'go') { dhCompositeAndLoad(ds); return; }
    if (e.target.dataset && e.target.dataset.dh === 'backToResults') { dhShowResults(ds); return; }   // C12: return to composite results without re-deriving
    if (e.target.dataset && e.target.dataset.dh === 'emitCollar') { dhEmitDataset(ds, 'collar'); return; }   // A11 emit-as-dataset
    if (e.target.dataset && e.target.dataset.dh === 'clearBtn') { dhClearAll(ds); return; }
    if (e.target.dataset && e.target.dataset.dh === 'removeSecondary') { dhStateFor(ds).secondary = null; renderDhMapping(ds); dhAutoSave(); return; }   // A11 P5
    var conv = e.target.dataset && e.target.dataset.dhconv;
    if (conv) {
      dhStateFor(ds).dipConvention = conv;
      renderDhMapping(ds);
      dhAutoSave();
      return;
    }
  });

  renderDhCard(ds);
}

// Shared report modal close (one global modal for every dataset's set)
(function() {
  var $close = document.getElementById('dhReportClose');
  if ($close) $close.addEventListener('click', function() {
    document.getElementById('dhReportModal').classList.remove('active');
  });
})();
