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
    intervalTables: []              // A11 P0: the container's interval-tables list (see dhIvtList)
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
  D.dipConvention = null;
  D.lastReport = null;
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
  var p = dhStateFor(ds).parsed[role];
  var opts = optionalLabel ? '<option value="-1">— ' + optionalLabel + '</option>' : '<option value="-1">— pick —</option>';
  for (var i = 0; i < p.header.length; i++) {
    opts += '<option value="' + i + '"' + (i === sel ? ' selected' : '') + '>' + esc(p.header[i]) + '</option>';
  }
  return '<select data-dhmap="' + role + ':' + field + '">' + opts + '</select>';
}

function dhIntervalDataCols(ds) {
  // interval columns other than the mapped BHID/FROM/TO, with a sampled type
  var D = dhStateFor(ds);
  var p = D.parsed.intervals;
  if (!p) return [];
  var m = D.map.intervals;
  var used = [m.bhid, m.from, m.to];
  var out = [];
  for (var c = 0; c < p.header.length; c++) {
    if (used.indexOf(c) >= 0) continue;
    var num = 0, nonEmpty = 0;
    var step = Math.max(1, Math.floor(p.rows.length / 200));
    for (var i = 0; i < p.rows.length; i += step) {
      var v = (p.rows[i][c] || '').trim();
      if (v === '') continue;
      nonEmpty++;
      if (isFinite(parseFloat(v)) && /^[-+0-9.eE]+$/.test(v)) num++;
    }
    out.push({ idx: c, name: p.header[c], type: (nonEmpty > 0 && num / nonEmpty >= 0.7) ? 'num' : 'cat' });
  }
  return out;
}

function dhMappingComplete(ds) {
  var D = dhStateFor(ds);
  var m = D.map, p = D.parsed;
  var ivt = dhPrimaryIvt(D);   // A11 P0: the intervals table via the container
  return p.collar && p.survey && ivt && ivt.parsed &&
    m.collar.bhid >= 0 && m.collar.x >= 0 && m.collar.y >= 0 && m.collar.z >= 0 &&
    m.survey.bhid >= 0 && m.survey.at >= 0 && m.survey.az >= 0 && m.survey.dip >= 0 &&
    ivt.map.bhid >= 0 && ivt.map.from >= 0 && ivt.map.to >= 0;
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
  var catOpts = '<option value="">— none</option>';
  var densOpts = '<option value="">— none (length only)</option>';   // A11 P3
  for (var dc = 0; dc < dataCols.length; dc++) {
    if (dataCols[dc].type === 'cat') catOpts += '<option value="' + esc(dataCols[dc].name) + '">' + esc(dataCols[dc].name) + '</option>';
    else if (dataCols[dc].type === 'num') densOpts += '<option value="' + esc(dataCols[dc].name) + '">' + esc(dataCols[dc].name) + '</option>';
  }
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
    '<div class="dh-opt"><label>Break on (domain)</label><select data-dh="domain">' + catOpts + '</select></div>' +
    '<div class="dh-opt"><label>Density (mass-weight)</label><select data-dh="density">' + densOpts + '</select></div>' +
    '<div class="dh-opt"><label>Min coverage %</label><input type="number" data-dh="minCov" class="dh-narrow" min="0" max="100" step="any" value="' + esc(D.opts.minCov) + '" placeholder="off"></div>' +
    '</div>';

  html += dhCombineEditorHtml(ds);   // A11 P3: per-column combine rules

  html += '<div class="dh-actions">' +
    '<button class="dh-go" data-dh="go"' + (dhMappingComplete(ds) ? '' : ' disabled') + '>Composite &amp; load ▶</button>' +
    '<span class="dh-status" data-dh="status"></span></div>';

  $m.innerHTML = html;
  // domain + density selects applied after render (option lists are data-driven)
  var $dom = dhQ('[data-dh="domain"]', root);
  if ($dom && D.opts.domainCol) $dom.value = D.opts.domainCol;
  var $dens = dhQ('[data-dh="density"]', root);
  if ($dens && D.opts.densityCol) $dens.value = D.opts.densityCol;
  dhRenderIvtStatus(ds);   // A11 P2: calc-column / kept-row / error summary
}

// A11 P3: per-column combine rules — how each interval data column aggregates
// over a composite (numeric: mean/sum/min/max; categorical: majority/first).
// Stored as D.opts.combine {colName: rule}; only non-default entries are kept.
var DH_COMBINE_NUM = [['mean', 'Mean'], ['sum', 'Sum'], ['min', 'Min'], ['max', 'Max']];
var DH_COMBINE_CAT = [['majority', 'Majority'], ['first', 'First']];
function dhCombineDefault(type) { return type === 'num' ? 'mean' : 'majority'; }
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
  var pi = D.parsed.intervals, mi = D.map.intervals;
  var dataCols = dhIntervalDataCols(ds);
  var iv = { bhid: [], from: [], to: [], cols: [] };
  for (var c = 0; c < dataCols.length; c++) {
    iv.cols.push({ name: dataCols[c].name, type: dataCols[c].type, values: [] });
  }
  for (var k = 0; k < pi.rows.length; k++) {
    var rk = pi.rows[k];
    iv.bhid.push((rk[mi.bhid] || '').trim());
    iv.from.push(parseFloat(rk[mi.from]));
    iv.to.push(parseFloat(rk[mi.to]));
    for (var c2 = 0; c2 < dataCols.length; c2++) {
      var raw = (rk[dataCols[c2].idx] || '').trim();
      if (dataCols[c2].type === 'num') {
        iv.cols[c2].values.push(raw === '' ? NaN : parseFloat(raw));
      } else {
        iv.cols[c2].values.push(raw === '' ? null : raw);
      }
    }
  }
  return { collars: collars, surveys: surveys, intervals: iv };
}

function dhCsvCell(v) {
  if (v == null) return '';
  if (typeof v === 'number') return isFinite(v) ? String(v) : '';
  var s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
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
    domainCol: D.opts.domainCol || null,
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
  div.querySelector('[data-dh="provEdit"]').addEventListener('click', async function() {
    var go = await bmaConfirm({
      title: 'Re-composite drillholes',
      html: 'Unload the current composites and return to the drillhole mapping panel? The three source files and your mapping stay in place.',
      okLabel: 'Edit set',
    });
    if (go) clearAux(ds, root); // dh slots/mapping survive — the card is right there
  });
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
  var p = dhStateFor(ds).parsed[role];
  var out = {};
  for (var f in saved) {
    var s = saved[f];
    if (!s) { out[f] = -1; continue; }
    var idx = p.header.indexOf(s.name);
    if (idx < 0 && s.idx != null && s.idx < p.header.length) idx = s.idx;
    out[f] = idx;
  }
  return out;
}

// The drillhole recipe for one dataset — null when no complete trio is staged
function dhSerialize(ds) {
  var D = dhStateFor(ds);
  var ivt = dhPrimaryIvt(D);   // A11 P0: the intervals table via the container
  if (!D.parsed.collar || !D.parsed.survey || !ivt || !ivt.parsed) return null;
  return {
    files: {
      collar: { name: D.files.collar.name, size: D.files.collar.size },
      survey: { name: D.files.survey.name, size: D.files.survey.size },
      intervals: { name: ivt.file.name, size: ivt.file.size },
    },
    map: { collar: dhMapToNames(ds, 'collar'), survey: dhMapToNames(ds, 'survey'), intervals: dhMapToNames(ds, 'intervals') },
    dipConvention: D.dipConvention,
    opts: { method: D.opts.method, length: D.opts.length, domainCol: D.opts.domainCol, densityCol: D.opts.densityCol, combine: D.opts.combine || null, minCov: D.opts.minCov },
    // A11 P2: the interval table's per-table calcols + filter (omitted when empty)
    intervalCalcols: (ivt.calcolCode || ivt.filter) ? { calcolCode: ivt.calcolCode || '', filter: ivt.filter || '' } : null,
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
  if (pr.dipConvention) D.dipConvention = pr.dipConvention;
  if (pr.opts) {
    D.opts.method = pr.opts.method || 'minimumCurvature';
    D.opts.length = pr.opts.length || '';
    D.opts.domainCol = pr.opts.domainCol || '';
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
  return [D.files.collar, D.files.survey, D.files.intervals];
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
      D.map[parts[0]][parts[1]] = parseInt(e.target.value);
      if (parts[0] === 'survey' && parts[1] === 'dip') D.dipConvention = dhDetectConventionFromParsed(ds);
      renderDhMapping(ds);
      dhAutoSave();
      return;
    }
    var k = e.target.dataset && e.target.dataset.dh;
    if (k === 'method') { D.opts.method = e.target.value; dhAutoSave(); }
    else if (k === 'length') { D.opts.length = e.target.value; dhAutoSave(); }
    else if (k === 'domain') { D.opts.domainCol = e.target.value; dhAutoSave(); }
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
  });
  $card.addEventListener('click', function(e) {
    var btn = e.target.closest ? e.target.closest('[data-dh]') : null;
    var dk = btn && btn.dataset.dh;
    if (dk === 'exportTable') { dhExportTable(ds, btn.dataset.dhRole); return; }   // A11 P1
    if (dk === 'exportZip') { dhExportTablesZip(ds); return; }                     // A11 P1
    if (e.target.dataset && e.target.dataset.dh === 'go') { dhCompositeAndLoad(ds); return; }
    if (e.target.dataset && e.target.dataset.dh === 'clearBtn') { dhClearAll(ds); return; }
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
