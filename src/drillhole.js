// ─── Drillhole set ingestion (A7 Phase 1) ───────────────────────────────
// UI + parsing glue over the @gcu/drillhole lib (vendor-drillhole.js):
// three file slots on the Aux empty state (role-detected by header
// signature, filename as tiebreaker), an always-visible mapping panel
// (column selects, the PROMINENT dip-convention toggle (D1), desurvey
// method select, composite length / domain / min-coverage), the
// consistency report, and Composite & load — which emits a CSV string,
// wraps it in a File, and hands it to loadAuxFile() so the aux pipeline
// stays untouched. SUPPORT auto-assigns as the aux weight.
// Design: docs/a7-drillhole-ingestion.md. Persistence/pack = Phase 2.

var dhFiles = { collar: null, survey: null, intervals: null };   // File per role
var dhParsed = { collar: null, survey: null, intervals: null };  // {header, rows}
var dhMap = { collar: {}, survey: {}, intervals: {} };           // field → col idx
var dhDipConvention = null;   // 'pos-down' | 'neg-down' (null = not detected yet)
var dhOpts = { method: 'minimumCurvature', length: '', domainCol: '', minCov: '' }; // serializable (Phase 2)
var dhLastReport = null;      // last Drillhole.process report (for the modal)
var dhDerivedName = null;     // file name of the loaded composite CSV
var dhProvFiles = null;       // [names] for the provenance banner
var dhPendingRestore = null;  // project.drillholes awaiting its files (Phase 2)

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

async function dhAssignFiles(files) {
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
  dhSetStatus('Reading…');
  try {
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (/\.zip$/i.test(f.name)) {
        var entries = await listZipEntries(f);
        for (var e = 0; e < entries.length; e++) {
          if (!/\.(csv|txt|dat)$/i.test(entries[e].name)) continue;
          var ef = await zipEntryToFile(f, entries[e]);
          await dhAssignOne(ef);
        }
      } else {
        await dhAssignOne(f);
      }
    }
    dhSetStatus('');
  } catch (err) {
    dhSetStatus('Read failed: ' + err.message, true);
  }
  renderDhCard();
  dhTryApplyPendingRestore(); // saved recipe applies when its files land
  dhAutoSave();
}

async function dhAssignOne(file) {
  var parsed = await dhParseFile(file);
  var role = dhDetectRole(parsed.header, file.name);
  if (!role) {
    // fall back to the first empty slot, in role order
    for (var r = 0; r < DH_ROLES.length; r++) {
      if (!dhFiles[DH_ROLES[r]]) { role = DH_ROLES[r]; break; }
    }
    if (!role) role = 'intervals';
  }
  dhFiles[role] = file;
  dhParsed[role] = parsed;
  dhMap[role] = dhAutoMap(role, parsed.header);
  if (role === 'survey') dhDipConvention = dhDetectConventionFromParsed();
}

function dhDetectConventionFromParsed() {
  var p = dhParsed.survey;
  if (!p) return null;
  var m = dhMap.survey;
  if (m.dip == null || m.dip < 0) return null;
  var surveys = [];
  for (var i = 0; i < p.rows.length; i++) {
    surveys.push({ dip: parseFloat(p.rows[i][m.dip]) });
  }
  return Drillhole.detectDipConvention(surveys);
}

function dhClearAll() {
  dhFiles = { collar: null, survey: null, intervals: null };
  dhParsed = { collar: null, survey: null, intervals: null };
  dhMap = { collar: {}, survey: {}, intervals: {} };
  dhDipConvention = null;
  dhLastReport = null;
  var $r = document.getElementById('dhReportInline');
  if ($r) $r.innerHTML = '';
  renderDhCard(); // re-writes the pending-restore hint when one is staged
}

// ── rendering ───────────────────────────────────────────────────────────

function dhSetStatus(msg, isErr) {
  var $s = document.getElementById('dhStatus');
  if ($s) { $s.textContent = msg || ''; $s.classList.toggle('err', !!isErr); }
}

function renderDhCard() {
  var $slots = document.getElementById('dhSlots');
  if (!$slots) return;
  var html = '';
  for (var r = 0; r < DH_ROLES.length; r++) {
    var role = DH_ROLES[r];
    var f = dhFiles[role];
    html += '<div class="dh-slot' + (f ? ' filled' : '') + '" data-dhrole="' + role + '">' +
      '<div class="dh-slot-role">' + role + '</div>' +
      (f
        ? '<div class="dh-slot-file" title="' + esc(f.name) + '">' + esc(f.name) + '</div>' +
          '<div class="dh-slot-meta">' + dhParsed[role].rows.length.toLocaleString() + ' rows · ' +
          dhParsed[role].header.length + ' cols</div>'
        : '<div class="dh-slot-empty">drop a file or click to browse</div>') +
      '</div>';
  }
  $slots.innerHTML = html;
  var $clear = document.getElementById('dhClearBtn');
  if ($clear) $clear.style.display = (dhFiles.collar || dhFiles.survey || dhFiles.intervals) ? '' : 'none';

  // pending project recipe: tell the user which files it expects
  var $rep = document.getElementById('dhReportInline');
  if (dhPendingRestore && !(dhFiles.collar && dhFiles.survey && dhFiles.intervals)) {
    var pf = dhPendingRestore.files;
    if ($rep) $rep.innerHTML = '<div class="dh-status">This project used a drillhole set — drop ' +
      '<b>' + esc(pf.collar.name) + '</b> + <b>' + esc(pf.survey.name) + '</b> + <b>' + esc(pf.intervals.name) +
      '</b> (or the packed zip) to re-composite with the saved mapping.</div>';
  }
  renderDhMapping();
}

function dhColSelect(role, field, sel, optionalLabel) {
  var p = dhParsed[role];
  var opts = optionalLabel ? '<option value="-1">— ' + optionalLabel + '</option>' : '<option value="-1">— pick —</option>';
  for (var i = 0; i < p.header.length; i++) {
    opts += '<option value="' + i + '"' + (i === sel ? ' selected' : '') + '>' + esc(p.header[i]) + '</option>';
  }
  return '<select data-dhmap="' + role + ':' + field + '">' + opts + '</select>';
}

function dhIntervalDataCols() {
  // interval columns other than the mapped BHID/FROM/TO, with a sampled type
  var p = dhParsed.intervals;
  if (!p) return [];
  var m = dhMap.intervals;
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

function dhMappingComplete() {
  var m = dhMap;
  return dhParsed.collar && dhParsed.survey && dhParsed.intervals &&
    m.collar.bhid >= 0 && m.collar.x >= 0 && m.collar.y >= 0 && m.collar.z >= 0 &&
    m.survey.bhid >= 0 && m.survey.at >= 0 && m.survey.az >= 0 && m.survey.dip >= 0 &&
    m.intervals.bhid >= 0 && m.intervals.from >= 0 && m.intervals.to >= 0;
}

function renderDhMapping() {
  var $m = document.getElementById('dhMapping');
  if (!$m) return;
  if (!dhParsed.collar || !dhParsed.survey || !dhParsed.intervals) {
    $m.innerHTML = (dhFiles.collar || dhFiles.survey || dhFiles.intervals)
      ? '<div class="dh-status">Waiting for the remaining table(s)…</div>' : '';
    return;
  }


  var html = '<div class="dh-map-tables">';
  html += '<div class="dh-map-table"><div class="dh-map-title">Collar — ' + esc(dhFiles.collar.name) + '</div>' +
    '<div class="dh-map-row"><label>BHID</label>' + dhColSelect('collar', 'bhid', dhMap.collar.bhid) + '</div>' +
    '<div class="dh-map-row"><label>X</label>' + dhColSelect('collar', 'x', dhMap.collar.x) + '</div>' +
    '<div class="dh-map-row"><label>Y</label>' + dhColSelect('collar', 'y', dhMap.collar.y) + '</div>' +
    '<div class="dh-map-row"><label>Z</label>' + dhColSelect('collar', 'z', dhMap.collar.z) + '</div>' +
    '<div class="dh-map-row"><label>EOH</label>' + dhColSelect('collar', 'eoh', dhMap.collar.eoh, 'none (advisory)') + '</div></div>';
  html += '<div class="dh-map-table"><div class="dh-map-title">Survey — ' + esc(dhFiles.survey.name) + '</div>' +
    '<div class="dh-map-row"><label>BHID</label>' + dhColSelect('survey', 'bhid', dhMap.survey.bhid) + '</div>' +
    '<div class="dh-map-row"><label>Depth</label>' + dhColSelect('survey', 'at', dhMap.survey.at) + '</div>' +
    '<div class="dh-map-row"><label>Azimuth</label>' + dhColSelect('survey', 'az', dhMap.survey.az) + '</div>' +
    '<div class="dh-map-row"><label>Dip</label>' + dhColSelect('survey', 'dip', dhMap.survey.dip) + '</div></div>';
  html += '<div class="dh-map-table"><div class="dh-map-title">Intervals — ' + esc(dhFiles.intervals.name) + '</div>' +
    '<div class="dh-map-row"><label>BHID</label>' + dhColSelect('intervals', 'bhid', dhMap.intervals.bhid) + '</div>' +
    '<div class="dh-map-row"><label>From</label>' + dhColSelect('intervals', 'from', dhMap.intervals.from) + '</div>' +
    '<div class="dh-map-row"><label>To</label>' + dhColSelect('intervals', 'to', dhMap.intervals.to) + '</div>' +
    '<div class="dh-map-row" style="color:var(--fg-dim);font-size:0.65rem">every other column rides along (composited)</div></div>';
  html += '</div>';

  // dip convention — the deliberately loud row (D1)
  var conv = dhDipConvention || 'pos-down';
  html += '<div class="dh-conv-row">' +
    '<span class="dh-conv-label">Dip convention</span>' +
    '<span class="dh-conv-detected">detected from the survey: <b>' +
    (conv === 'neg-down' ? 'negative = down' : 'positive = down') + '</b> — override if your file differs</span>' +
    '<span class="dh-conv-btns">' +
    '<button data-dhconv="pos-down" class="' + (conv === 'pos-down' ? 'active' : '') + '">Positive down</button>' +
    '<button data-dhconv="neg-down" class="' + (conv === 'neg-down' ? 'active' : '') + '">Negative down</button>' +
    '</span></div>';

  // options row
  var dataCols = dhIntervalDataCols();
  var catOpts = '<option value="">— none</option>';
  for (var dc = 0; dc < dataCols.length; dc++) {
    if (dataCols[dc].type === 'cat') catOpts += '<option value="' + esc(dataCols[dc].name) + '">' + esc(dataCols[dc].name) + '</option>';
  }
  var autoLen = dhAutoLength();
  function mOpt(v, label) {
    return '<option value="' + v + '"' + (dhOpts.method === v ? ' selected' : '') + '>' + label + '</option>';
  }
  html += '<div class="dh-opts">' +
    '<div class="dh-opt"><label>Desurvey method</label><select id="dhMethod">' +
      mOpt('minimumCurvature', 'Minimum curvature') +
      mOpt('balancedTangential', 'Balanced tangential') +
      mOpt('tangential', 'Tangential') + '</select></div>' +
    '<div class="dh-opt"><label>Composite length</label><input type="number" id="dhLength" class="dh-narrow" min="0" step="any" value="' + esc(dhOpts.length) + '" placeholder="' + (autoLen != null ? autoLen : 'auto') + '"></div>' +
    '<div class="dh-opt"><label>Break on (domain)</label><select id="dhDomain">' + catOpts + '</select></div>' +
    '<div class="dh-opt"><label>Min coverage %</label><input type="number" id="dhMinCov" class="dh-narrow" min="0" max="100" step="any" value="' + esc(dhOpts.minCov) + '" placeholder="off"></div>' +
    '</div>';

  html += '<div class="dh-actions">' +
    '<button class="dh-go" id="dhGoBtn"' + (dhMappingComplete() ? '' : ' disabled') + '>Composite &amp; load ▶</button>' +
    '<span class="dh-status" id="dhStatus"></span></div>';

  $m.innerHTML = html;
  // domain select value applied after render (option list is data-driven)
  var $dom = document.getElementById('dhDomain');
  if ($dom && dhOpts.domainCol) $dom.value = dhOpts.domainCol;
}

function dhAutoLength() {
  var p = dhParsed.intervals, m = dhMap.intervals;
  if (!p || m.from == null || m.from < 0 || m.to == null || m.to < 0) return null;
  var from = [], to = [];
  for (var i = 0; i < p.rows.length; i++) {
    from.push(parseFloat(p.rows[i][m.from]));
    to.push(parseFloat(p.rows[i][m.to]));
  }
  return Drillhole.defaultLength({ bhid: [], from: from, to: to, cols: [] });
}

// ── composite & load ────────────────────────────────────────────────────

function dhBuildTables() {
  var pc = dhParsed.collar, mc = dhMap.collar;
  var collars = [];
  for (var i = 0; i < pc.rows.length; i++) {
    var r = pc.rows[i];
    collars.push({
      bhid: (r[mc.bhid] || '').trim(),
      x: parseFloat(r[mc.x]), y: parseFloat(r[mc.y]), z: parseFloat(r[mc.z]),
      eoh: mc.eoh >= 0 ? parseFloat(r[mc.eoh]) : NaN,
    });
  }
  var ps = dhParsed.survey, ms = dhMap.survey;
  var surveys = [];
  for (var s = 0; s < ps.rows.length; s++) {
    var rs = ps.rows[s];
    surveys.push({
      bhid: (rs[ms.bhid] || '').trim(),
      depth: parseFloat(rs[ms.at]), az: parseFloat(rs[ms.az]), dip: parseFloat(rs[ms.dip]),
    });
  }
  var pi = dhParsed.intervals, mi = dhMap.intervals;
  var dataCols = dhIntervalDataCols();
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

function dhCompositeAndLoad() {
  if (!dhMappingComplete()) return;
  dhSetStatus('Compositing…');
  var lenInput = parseFloat(dhOpts.length);
  var covInput = parseFloat(dhOpts.minCov);
  var opts = {
    method: dhOpts.method || 'minimumCurvature',
    dipConvention: dhDipConvention || 'pos-down',
    compositeLength: isFinite(lenInput) && lenInput > 0 ? lenInput : null,
    domainCol: dhOpts.domainCol || null,
    minCoverage: isFinite(covInput) && covInput > 0 ? covInput / 100 : null,
  };
  var result;
  try {
    result = Drillhole.process(dhBuildTables(), opts);
  } catch (err) {
    dhSetStatus('Compositing failed: ' + err.message, true);
    return;
  }
  dhLastReport = result.report;
  renderDhReport(document.getElementById('dhReportInline'));
  if (result.rows.length === 0) {
    dhSetStatus('No composites produced — check the report above.', true);
    return;
  }

  var lines = [result.header.join(',')];
  for (var i = 0; i < result.rows.length; i++) {
    lines.push(result.rows[i].map(dhCsvCell).join(','));
  }
  var stem = (dhFiles.intervals.name.replace(/\.(csv|txt|dat)$/i, '') || 'drillholes');
  dhDerivedName = stem + '-composites.csv';
  dhProvFiles = [dhFiles.collar.name, dhFiles.survey.name, dhFiles.intervals.name];
  var file = new File([lines.join('\n') + '\n'], dhDerivedName, { type: 'text/csv' });

  // SUPPORT is the support weight by construction — assign the role before
  // the load so the aux sidebar renders with it selected (visible, not magic)
  catSetRole('aux', 'weight', 'SUPPORT');
  auxPrefix = 'dh';
  dhSetStatus(result.report.nComposites.toLocaleString() + ' composites from ' +
    result.report.nHoles + ' holes — loading…');
  loadAuxFile(file, null);
}

// ── consistency report ──────────────────────────────────────────────────

function renderDhReport(container) {
  if (!container) return;
  var rep = dhLastReport;
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

function dhOpenReportModal() {
  renderDhReport(document.getElementById('dhReportBody'));
  document.getElementById('dhReportModal').classList.add('active');
}

// Provenance banner in the aux config header — called from renderAuxConfig
function renderDhProvenance() {
  var $head = document.getElementById('auxHead');
  if (!$head) return;
  var old = document.getElementById('dhProvenance');
  if (old) old.remove();
  if (!auxFile || !dhDerivedName || auxFile.name !== dhDerivedName || !dhLastReport) return;
  var div = document.createElement('div');
  div.className = 'dh-provenance';
  div.id = 'dhProvenance';
  div.innerHTML = '<span>' + dhLastReport.nComposites.toLocaleString() + ' composites from ' +
    dhLastReport.nHoles + ' holes · ' + dhProvFiles.map(esc).join(' + ') + '</span>' +
    '<button id="dhProvReport">Report</button>' +
    '<button id="dhProvEdit">Edit &amp; re-composite</button>';
  $head.appendChild(div);
  document.getElementById('dhProvReport').addEventListener('click', dhOpenReportModal);
  document.getElementById('dhProvEdit').addEventListener('click', async function() {
    var go = await bmaConfirm({
      title: 'Re-composite drillholes',
      html: 'Unload the current composites and return to the drillhole mapping panel? The three source files and your mapping stay in place.',
      okLabel: 'Edit set',
    });
    if (go) clearAux(); // dh slots/mapping survive — the card is right there
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
function dhMapToNames(role) {
  var p = dhParsed[role];
  var out = {};
  for (var f in dhMap[role]) {
    var idx = dhMap[role][f];
    out[f] = (idx != null && idx >= 0) ? { name: p.header[idx], idx: idx } : null;
  }
  return out;
}

function dhMapFromNames(role, saved) {
  var p = dhParsed[role];
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

// The `drillholes` project key — null when no complete trio is staged
function dhSerialize() {
  if (!dhParsed.collar || !dhParsed.survey || !dhParsed.intervals) return null;
  return {
    files: {
      collar: { name: dhFiles.collar.name, size: dhFiles.collar.size },
      survey: { name: dhFiles.survey.name, size: dhFiles.survey.size },
      intervals: { name: dhFiles.intervals.name, size: dhFiles.intervals.size },
    },
    map: { collar: dhMapToNames('collar'), survey: dhMapToNames('survey'), intervals: dhMapToNames('intervals') },
    dipConvention: dhDipConvention,
    opts: { method: dhOpts.method, length: dhOpts.length, domainCol: dhOpts.domainCol, minCov: dhOpts.minCov },
    loaded: !!(auxFile && dhDerivedName && auxFile.name === dhDerivedName),
  };
}

// applyProject hands the saved recipe here; it applies when the files land
function dhRestoreFromProject(saved) {
  dhPendingRestore = (saved && saved.files) ? saved : null;
  renderDhCard();
}

// Files just landed in slots — if a pending recipe matches by name, apply
// its mapping/options; when the whole trio matches a loaded:true recipe,
// re-composite automatically (the user's saved intent — and the report
// still renders, so nothing happens invisibly)
function dhTryApplyPendingRestore() {
  var pr = dhPendingRestore;
  if (!pr) return;
  var allMatch = true;
  for (var r = 0; r < DH_ROLES.length; r++) {
    var role = DH_ROLES[r];
    if (!dhFiles[role] || dhFiles[role].name !== pr.files[role].name) { allMatch = false; continue; }
    dhMap[role] = dhMapFromNames(role, pr.map[role]);
  }
  if (pr.dipConvention) dhDipConvention = pr.dipConvention;
  if (pr.opts) {
    dhOpts.method = pr.opts.method || 'minimumCurvature';
    dhOpts.length = pr.opts.length || '';
    dhOpts.domainCol = pr.opts.domainCol || '';
    dhOpts.minCov = pr.opts.minCov || '';
  }
  if (allMatch) {
    var wasLoaded = pr.loaded;
    dhPendingRestore = null;
    renderDhCard();
    if (wasLoaded && dhMappingComplete()) dhCompositeAndLoad();
  }
}

// Packed-project path: the raw trio extracted from the archive
async function dhLoadTrio(trio) {
  for (var r = 0; r < DH_ROLES.length; r++) {
    var f = trio[DH_ROLES[r]];
    if (f) {
      dhFiles[DH_ROLES[r]] = f;
      dhParsed[DH_ROLES[r]] = await dhParseFile(f);
      dhMap[DH_ROLES[r]] = dhAutoMap(DH_ROLES[r], dhParsed[DH_ROLES[r]].header);
    }
  }
  dhDipConvention = dhDetectConventionFromParsed();
  renderDhCard();
  dhTryApplyPendingRestore();
}

// Pack integration (D8): when the aux is drillhole-derived, the archive
// carries the RAW trio — the recipe in the project json re-derives on load
function dhIsDerivedAux() {
  return !!(auxFile && dhDerivedName && auxFile.name === dhDerivedName &&
    dhFiles.collar && dhFiles.survey && dhFiles.intervals);
}
function dhPackFiles() {
  return [dhFiles.collar, dhFiles.survey, dhFiles.intervals];
}

// New file / Clear project: drillhole state starts fresh
function dhReset() {
  dhPendingRestore = null;
  dhDerivedName = null;
  dhProvFiles = null;
  dhOpts = { method: 'minimumCurvature', length: '', domainCol: '', minCov: '' };
  dhClearAll();
}

// ── wiring (DOM is parsed; runs at load) ────────────────────────────────
(function() {
  var $card = document.getElementById('dhCard');
  var $input = document.getElementById('dhFileInput');
  if (!$card || !$input) return;

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
    if (files.length) dhAssignFiles(files);
  });
  $input.addEventListener('change', function() {
    var files = Array.from($input.files || []);
    $input.value = '';
    if (files.length) dhAssignFiles(files);
  });

  // delegated: mapping selects, option inputs, convention toggle, composite, clear
  $card.addEventListener('change', function(e) {
    var map = e.target.dataset && e.target.dataset.dhmap;
    if (map) {
      var parts = map.split(':');
      dhMap[parts[0]][parts[1]] = parseInt(e.target.value);
      if (parts[0] === 'survey' && parts[1] === 'dip') dhDipConvention = dhDetectConventionFromParsed();
      renderDhMapping();
      dhAutoSave();
      return;
    }
    if (e.target.id === 'dhMethod') { dhOpts.method = e.target.value; dhAutoSave(); }
    else if (e.target.id === 'dhLength') { dhOpts.length = e.target.value; dhAutoSave(); }
    else if (e.target.id === 'dhDomain') { dhOpts.domainCol = e.target.value; dhAutoSave(); }
    else if (e.target.id === 'dhMinCov') { dhOpts.minCov = e.target.value; dhAutoSave(); }
  });
  $card.addEventListener('click', function(e) {
    if (e.target.id === 'dhGoBtn') { dhCompositeAndLoad(); return; }
    var conv = e.target.dataset && e.target.dataset.dhconv;
    if (conv) {
      dhDipConvention = conv;
      renderDhMapping();
      dhAutoSave();
      return;
    }
  });
  document.getElementById('dhClearBtn').addEventListener('click', dhClearAll);
  document.getElementById('dhReportClose').addEventListener('click', function() {
    document.getElementById('dhReportModal').classList.remove('active');
  });

  renderDhCard();
})();
