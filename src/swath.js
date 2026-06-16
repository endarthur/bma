// ─── Swath Tab ────────────────────────────────────────────────────────

let swathNumCols = [];
let swathTableCollapsed = false; // table section collapse, survives re-renders (C6-0)
let swathStale = false;          // result no longer matches the sidebar (C6-5)

function swathMarkStale() {
  if (swathStale || !lastSwathData) return;
  swathStale = true;
  if (typeof setGenStale === 'function') setGenStale('swathGenerate', true);
}
var _swathChartParams = null; // stored for crosshair
// A10 4c-iii-b: one worker per overlaid comparison dataset (aux, d2…) — the
// fan-out replaced the single legacy swathAuxWorker.
var swathCmpWorkers = [];
var pendingSwathAuxRestore = null;  // { checked: [names], units: {name: unitIdx} } from project restore

function resetSwathState() {
  _swathChartParams = null;
}

// A10 4c-iii-b: every comparison dataset that can overlay a swath — has a file
// and a preflight (XYZ may still be unassigned; we list it with a note, the
// same as the legacy aux path). Registry order: aux first, then d2, d3…
function swathCmpDatasets() {
  var out = [];
  for (var i = 1; i < datasets.length; i++) {
    var d = datasets[i];
    if (d && d.file && d.preflight) out.push(d);
  }
  return out;
}

// A comparison dataset is swath-ready once its X/Y/Z are assigned.
function swathCmpReady(ds) {
  var xyz = ds && ds.preflight && ds.preflight.xyz;
  return !!(xyz && xyz.x >= 0 && xyz.y >= 0 && xyz.z >= 0);
}

// Numeric comparison columns of a dataset as {name, idx, isCalc}: raw numeric
// header cols (minus X/Y/Z) then numeric calcols. idx indexes the dataset's
// extended header (raw length + calcol ordinal) — the swath worker's varCols
// space. Generalizes the inline aux loop.
function swathCmpCols(ds) {
  var pf = ds.preflight;
  if (!pf) return [];
  var xyz = pf.xyz || { x: -1, y: -1, z: -1 };
  var cols = [];
  for (var i = 0; i < pf.header.length; i++) {
    if (pf.autoTypes[i] !== 'numeric') continue;
    if (i === xyz.x || i === xyz.y || i === xyz.z) continue;
    cols.push({ name: pf.header[i], idx: i });
  }
  var cm = ds.calcolMeta || [];
  for (var ci = 0; ci < cm.length; ci++) {
    if (cm[ci].type !== 'numeric') continue;
    cols.push({ name: cm[ci].name, idx: pf.header.length + ci, isCalc: true });
  }
  return cols;
}

// The worker's extended header for a comparison dataset (raw header + calcol
// names), matching the varCols index space.
function swathCmpHeader(ds) {
  return ds.preflight.header.concat((ds.calcolMeta || []).map(function(m) { return m.name; }));
}

// Resolve a comparison dataset's swath weight. Only aux has a declustering UI
// (the AUX_DECLUS_WEIGHT sentinel → computed weights, soft-failed when stale);
// d2+ use a plain catRole(id,'weight') column or none.
function resolveSwathCmpWeight(ds) {
  var w = catRole(ds.id, 'weight');
  if (ds.id === 'aux' && w === AUX_DECLUS_WEIGHT) {
    if (typeof auxDeclusFresh === 'function' && auxDeclusFresh(ds)) {
      return { weightColName: null, weightArray: ds.declus.weights };
    }
    return { blockedError: 'aux series skipped: declustered weights missing or stale — re-run Declustering on the Aux tab' };
  }
  return { weightColName: w, weightArray: null };
}

function terminateSwathCmpWorkers() {
  swathCmpWorkers.forEach(function(w) { try { w.terminate(); } catch (e) {} });
  swathCmpWorkers = [];
}
function cleanupSwathCmpWorker(w) {
  try { w.terminate(); } catch (e) {}
  var i = swathCmpWorkers.indexOf(w);
  if (i >= 0) swathCmpWorkers.splice(i, 1);
}

function showSwathColorPicker(colName, colIdx, anchorEl, presetColor) {
  var $picker = document.getElementById('swathColorPicker');
  if (!$picker) return;
  var currentColor = presetColor;
  if (!currentColor) {
    // Find palette index for this variable based on its position in the checked list
    var vi = 0;
    var items = document.querySelectorAll('#swathVarList .swath-var-item');
    items.forEach(function(item, idx) {
      if (parseInt(item.querySelector('input').value) === colIdx) vi = idx;
    });
    currentColor = getSwathVarColor(colName, vi);
  }

  var html = '<div class="cat-color-grid">';
  for (var i = 0; i < STATSCAT_PALETTE.length; i++) {
    var c = STATSCAT_PALETTE[i];
    var sel = c.toLowerCase() === currentColor.toLowerCase() ? ' selected' : '';
    html += '<div class="cat-color-swatch' + sel + '" style="background:' + c + '" data-color="' + c + '"></div>';
  }
  html += '</div>';
  html += '<input type="text" class="cat-hex-input" placeholder="#hex" value="' + esc(currentColor) + '">';

  $picker.innerHTML = html;
  $picker.dataset.colName = colName;
  $picker.dataset.colIdx = colIdx;

  // Position near the anchor
  var rect = anchorEl.getBoundingClientRect();
  var sidebar = document.getElementById('swathSidebar');
  var sidebarRect = sidebar.getBoundingClientRect();
  $picker.style.top = (rect.bottom - sidebarRect.top + 4) + 'px';
  $picker.style.left = Math.max(0, rect.left - sidebarRect.left - 60) + 'px';
  $picker.classList.add('open');
}

function hideSwathColorPicker() {
  var $picker = document.getElementById('swathColorPicker');
  if ($picker) $picker.classList.remove('open');
}

function applySwathColor(colName, color) {
  // colName is a primary variable name or a '<dsId>:NAME' comparison color key
  // (aux:NAME, d2:NAME…). Only a known dataset id prefix routes to that dataset.
  var ci = colName.indexOf(':');
  var ds = ci > 0 ? dsById(colName.slice(0, ci)) : null;
  if (ds) catVar(ds.id, colName.slice(ci + 1)).color = color;
  else catVar('model', colName).color = color;
  // Update the swatch in the sidebar (aux swatches carry data-color-key, primary carry data-col)
  document.querySelectorAll('#swathVarList .swath-color-swatch').forEach(function(sw) {
    if (sw.dataset.colorKey != null) {
      if (sw.dataset.colorKey === colName) sw.style.background = color;
      return;
    }
    var ci = parseInt(sw.dataset.col);
    if (currentHeader[ci] === colName) sw.style.background = color;
  });
  // Re-render chart from cache
  if (lastSwathData) renderSwathOutput();
  autoSaveProject();
}

function getSwathUnit(colIdx) {
  var idx = currentHeader[colIdx] ? catPropUnit('model', currentHeader[colIdx]) : 0;
  var u = GRADE_UNITS[idx] || GRADE_UNITS[0];
  return { unitIdx: idx, symbol: u.symbol };
}

// Aux series color: explicit override → paired primary variable's EFFECTIVE
// color, including its palette-by-position fallback (same hue + dashed reads
// as "same variable, other dataset") → palette fallback.
// A10 4c-iii: dsId defaults to 'aux' (the single legacy comparison) but any
// comparison dataset's series resolves color/unit the same way.
function getAuxSwathVarColor(baseName, fallbackIdx, dsId) {
  dsId = dsId || 'aux';
  var rec = catVarPeek(dsId, baseName);
  if (rec && rec.color) return rec.color;
  var p = catModelMember(dsId, baseName);
  if (p) {
    for (var i = 0; i < swathNumCols.length; i++) {
      if (swathNumCols[i].name === p) return getSwathVarColor(p, i);
    }
  }
  return STATSCAT_PALETTE[fallbackIdx % STATSCAT_PALETTE.length];
}

function getAuxSwathUnit(auxColIdx, baseName, dsId) {
  var idx = baseName ? catPropUnit(dsId || 'aux', baseName) : 0; // inherits the paired primary's unit
  var u = GRADE_UNITS[idx] || GRADE_UNITS[0];
  return { unitIdx: idx, symbol: u.symbol };
}

function getSwathDisplay() {
  return {
    showBands: document.getElementById('swathShowBands') ? document.getElementById('swathShowBands').checked : true,
    showCounts: document.getElementById('swathShowCounts') ? document.getElementById('swathShowCounts').checked : true,
    showTable: document.getElementById('swathShowTable') ? document.getElementById('swathShowTable').checked : true,
    yScale: (document.getElementById('swathYScale') || {}).value || 'linear',
    layout: (document.getElementById('swathLayout') || {}).value || 'overlay'
  };
}

function formatAzimuthLabel(deg) {
  deg = ((deg % 360) + 360) % 360;
  if (deg === 0 || deg === 360) return 'N';
  if (deg === 90) return 'E';
  if (deg === 180) return 'S';
  if (deg === 270) return 'W';
  if (deg > 0 && deg < 90) return 'N' + Math.round(deg) + '\u00b0E';
  if (deg > 90 && deg < 180) return 'S' + Math.round(180 - deg) + '\u00b0E';
  if (deg > 180 && deg < 270) return 'S' + Math.round(deg - 180) + '\u00b0W';
  return 'N' + Math.round(360 - deg) + '\u00b0W';
}

function getSwathDirectionLabels(swathData) {
  if (swathData.azimuth != null) {
    var pl = swathData.plunge || 0;
    // Near-vertical vectors: compass labels are meaningless
    if (pl > 80) return { left: 'Up', right: 'Down' };
    if (pl < -80) return { left: 'Down', right: 'Up' };
    var fwd = formatAzimuthLabel(swathData.azimuth);
    var back = formatAzimuthLabel((swathData.azimuth + 180) % 360);
    if (pl > 0.5) return { left: back + ' (up)', right: fwd + ' (down)' };
    if (pl < -0.5) return { left: back + ' (down)', right: fwd + ' (up)' };
    return { left: back, right: fwd };
  }
  var axisKey = swathData.axis;
  if (axisKey === 'x') return { left: 'W', right: 'E' };
  if (axisKey === 'y') return { left: 'S', right: 'N' };
  return { left: 'Bottom', right: 'Top' };
}

function getSwathXAxisLabel(swathData) {
  if (swathData.azimuth != null) {
    var label = swathData.key ? swathData.key.toUpperCase() + ' \u2014 ' : '';
    label += 'Az ' + Math.round(swathData.azimuth) + '\u00b0';
    if (swathData.plunge && Math.round(swathData.plunge) !== 0) label += '/Pl ' + Math.round(swathData.plunge) + '\u00b0';
    return label + ' Projected';
  }
  return swathData.axis.toUpperCase() + ' Coordinate';
}

// Single-direction view over the multi-direction result cache \u2014 the shape
// renderSwathCharts and friends consume (vars/cmp[]/binWidth/axis/az/pl)
function swathDirView(sd, key) {
  var d = sd.directions[0];
  for (var i = 0; i < sd.directions.length; i++) {
    if (sd.directions[i].key === key) { d = sd.directions[i]; break; }
  }
  return {
    key: d.key,
    axis: d.axis != null ? 'xyz'[d.axis] : null,
    azimuth: d.dir ? d.azimuth : null,
    plunge: d.dir ? d.plunge : null,
    binWidth: d.binWidth,
    vars: (sd.results && sd.results[d.key]) || {},
    varCols: sd.varCols,
    // A10 4c-iii: one comparison block per overlaid dataset (aux, d2…), each
    // with this direction's per-variable bins.
    cmp: (sd.cmp || []).map(function(c) {
      return {
        dsId: c.dsId,
        vars: c.results ? (c.results[d.key] || null) : null,
        varCols: c.varCols,
        header: c.header,
        error: c.error
      };
    })
  };
}

// Render the swath output area: a tab per computed direction (when more
// than one), with the active direction's chart + table below.
function renderSwathOutput(stat) {
  var $content = document.getElementById('swathContent');
  if (!$content) return;
  if (!lastSwathData || !lastSwathData.directions) {
    $content.innerHTML = '<div class="swath-hint">Configure settings and click Generate to create swath plots.</div>';
    return;
  }
  if (!stat) stat = (document.getElementById('swathStat') || {}).value || 'mean_std';
  var sd = lastSwathData;
  var keys = sd.directions.map(function(d) { return d.key; });
  if (!sd.activeKey || keys.indexOf(sd.activeKey) < 0) sd.activeKey = keys[0];

  var cmpList = sd.cmp || [];
  var html = workerErrNote(sd);
  cmpList.forEach(function(c) {
    html += workerErrNote({ filterErrors: c.filterErrors, calcolErrors: c.calcolErrors }, dsLabel(c.dsId));
  });
  var anyCmpWeightExcl = cmpList.some(function(c) { return c.weightExcluded > 0; });
  if (sd.weightExcluded > 0 || anyCmpWeightExcl) {
    var wParts = [];
    if (sd.weightExcluded > 0) wParts.push(sd.weightExcluded.toLocaleString() + ' model');
    cmpList.forEach(function(c) {
      if (c.weightExcluded > 0) wParts.push(c.weightExcluded.toLocaleString() + ' ' + dsLabel(c.dsId));
    });
    html += '<div class="warn-note">Rows excluded for invalid weight: ' + wParts.join(', ') + '.</div>';
  }
  if (sd.directions.length > 1) {
    html += '<div class="swath-dir-tabs">' + sd.directions.map(function(d) {
      var title = d.dir ? 'Az ' + Math.round(d.azimuth) + '\u00b0 / Pl ' + Math.round(d.plunge) + '\u00b0' : d.key.toUpperCase() + ' axis';
      return '<button class="swath-dir-tab' + (d.key === sd.activeKey ? ' active' : '') + '" data-dir-key="' + d.key + '" title="' + esc(title) + '">' + d.key.toUpperCase() + '</button>';
    }).join('') + '</div>';
  }
  html += '<div id="swathDirPanel"></div>';
  $content.innerHTML = html;

  $content.querySelectorAll('.swath-dir-tab').forEach(function(btn) {
    btn.addEventListener('click', function() {
      sd.activeKey = btn.dataset.dirKey;
      renderSwathOutput();
    });
  });

  renderSwathCharts(swathDirView(sd, sd.activeKey), stat, document.getElementById('swathDirPanel'));
}

function renderSwathConfig(data) {
  const $sidebar = document.getElementById('swathSidebar');
  const $content = document.getElementById('swathContent');
  if (!$sidebar) return;
  const { header, colTypes, geometry } = data;
  const hasXYZ = currentXYZ.x >= 0 && currentXYZ.y >= 0 && currentXYZ.z >= 0;
  if (!hasXYZ || !geometry || !geometry.x) {
    $sidebar.innerHTML = '';
    $content.innerHTML = '<div class="swath-hint">Assign X/Y/Z columns in Import Block Model and run analysis to enable Swath plots.</div>';
    return;
  }
  swathNumCols = header.map((h, i) => ({ name: h, idx: i, type: colTypes[i] }))
    .filter(c => c.type === 'numeric' && c.idx !== currentXYZ.x && c.idx !== currentXYZ.y && c.idx !== currentXYZ.z
      && c.idx !== currentDXYZ.dx && c.idx !== currentDXYZ.dy && c.idx !== currentDXYZ.dz);
  if (swathNumCols.length === 0) {
    $sidebar.innerHTML = '';
    $content.innerHTML = '<div class="swath-hint">No numeric variable columns available for swath analysis.</div>';
    return;
  }
  const bsx = geometry.x.blockSize, bsy = geometry.y.blockSize, bsz = geometry.z.blockSize;
  const inPlaneBs = Math.min(bsx, bsy);
  function dirRow(key, label, bs, checked, title) {
    return '<div class="swath-dir-row">' +
      '<label' + (title ? ' title="' + esc(title) + '"' : '') + '><input type="checkbox" class="swath-dir-on" data-dir="' + key + '"' + (checked ? ' checked' : '') + '> ' + label + '</label>' +
      '<input type="number" class="swath-input swath-dir-bin" id="swathBin_' + key + '" value="' + bs + '" min="0.001" step="any" title="Bin width (m)">' +
    '</div>';
  }
  const varItems = swathNumCols.map(function(c, vi) {
    var defUnit = catPropUnit('model', c.name);
    var unitOpts = GRADE_UNITS.map(function(u, ui) {
      return '<option value="' + ui + '"' + (ui === defUnit ? ' selected' : '') + '>' + esc(u.label) + '</option>';
    }).join('');
    var varColor = getSwathVarColor(c.name, vi);
    var emptyTag = colIsEmpty('model', c.idx) ? '<span class="empty-tag" title="' + EMPTY_COL_TITLE + '">∅</span>' : '';
    return '<label class="swath-var-item"><input type="checkbox" value="' + c.idx + '" checked>' +
      '<div class="swath-color-swatch" data-col="' + c.idx + '" style="background:' + varColor + '"></div>' +
      '<span>' + esc(c.name) + '</span>' + emptyTag +
      '<select class="swath-var-unit" data-col="' + c.idx + '">' + unitOpts + '</select></label>';
  }).join('');

  $sidebar.innerHTML =
    '<div class="swath-sidebar-section" data-sb="dir">' +
      '<div class="swath-sidebar-title">Directions</div>' +
      '<select class="swath-select" id="swathDirMode">' +
        '<option value="ortho">Orthogonal X/Y/Z</option>' +
        '<option value="custom">Custom (rotated U/V/W)</option>' +
      '</select>' +
      '<div class="swath-dir-hint">check directions to swath \u00b7 bin width (m) per direction</div>' +
      '<div id="swathOrthoDirs">' +
        dirRow('x', 'X', bsx, true) +
        dirRow('y', 'Y', bsy, false) +
        dirRow('z', 'Z', bsz, false) +
      '</div>' +
      '<div id="swathCustomDirs" style="display:none">' +
        '<div class="swath-angle-row">' +
          '<label title="Dip direction (\u00b0 from N, clockwise)">Dipdir<input type="number" class="swath-input" id="swathDipDir" value="0" min="0" max="360" step="1"></label>' +
          '<label title="Dip (\u00b0 below horizontal)">Dip<input type="number" class="swath-input" id="swathDip" value="0" min="0" max="90" step="1"></label>' +
          '<label title="Rake of U in the plane (\u00b0 from strike, 90 = down-dip)">Rake<input type="number" class="swath-input" id="swathRake" value="90" min="-180" max="180" step="1"></label>' +
        '</div>' +
        dirRow('u', 'U', inPlaneBs, true, 'In-plane, along the rake direction') +
        dirRow('v', 'V', inPlaneBs, false, 'In-plane, perpendicular to U') +
        dirRow('w', 'W', bsz, false, 'Pole to the plane (normal)') +
        '<div class="swath-dir-hint">U: rake direction in the dipdir/dip plane \u00b7 V: in-plane \u22a5 U \u00b7 W: pole</div>' +
      '</div>' +
    '</div>' +
    '<div class="swath-sidebar-section" data-sb="stat">' +
      '<div class="swath-sidebar-title">Statistic</div>' +
      '<select class="swath-select" id="swathStat">' +
        '<option value="mean_std">Mean \u00b1 Std</option>' +
        '<option value="p25_50_75">P25 / P50 / P75</option>' +
        '<option value="p10_50_90">P10 / P50 / P90</option>' +
      '</select>' +
      '<div style="margin-top:0.3rem">' +
        '<div class="swath-sidebar-title">Weight (model)</div>' +
        '<select class="swath-select" id="swathWeight"><option value="">\u2014 none</option>' +
          swathNumCols.map(function(c) { return '<option value="' + esc(c.name) + '"' + (c.name === catRole('model', 'weight') ? ' selected' : '') + '>' + esc(c.name) + '</option>'; }).join('') +
        '</select>' +
      '</div>' +
    '</div>' +
    '<div class="swath-sidebar-section" data-sb="display">' +
      '<div class="swath-sidebar-title">Display</div>' +
      '<label class="swath-display-opt"><input type="checkbox" id="swathShowBands" checked> Show bands</label>' +
      '<label class="swath-display-opt"><input type="checkbox" id="swathShowCounts" checked> Show count bars</label>' +
      '<label class="swath-display-opt"><input type="checkbox" id="swathShowTable" checked> Show table</label>' +
      '<div style="margin-top:0.3rem">' +
        '<div class="swath-sidebar-title">Y Scale</div>' +
        '<select class="swath-select" id="swathYScale"><option value="linear">Linear</option><option value="log">Log</option></select>' +
      '</div>' +
      '<div style="margin-top:0.3rem">' +
        '<div class="swath-sidebar-title">Layout</div>' +
        '<select class="swath-select" id="swathLayout"><option value="overlay">Overlay</option><option value="split">Split</option></select>' +
      '</div>' +
    '</div>' +
    '<div class="swath-sidebar-section" data-sb="filter">' +
      '<div class="swath-sidebar-title">Local Filter</div>' +
      '<input type="text" class="swath-search" id="swathLocalFilter" placeholder="e.g. r.zone == 1" autocomplete="off" spellcheck="false">' +
    '</div>' +
    '<div class="swath-sidebar-section--grow" data-sb="vars">' +
      '<div class="swath-sidebar-title">Variables</div>' +
      '<input type="text" class="swath-search" id="swathVarSearch" placeholder="search\u2026" autocomplete="off" spellcheck="false">' +
      '<div class="swath-var-btns">' +
        '<button id="swathVarAll">All</button>' +
        '<button id="swathVarNone">None</button>' +
      '</div>' +
      '<div class="swath-var-list" id="swathVarList">' + varItems + '<div id="swathAuxVars"></div></div>' +
    '</div>' +
    '<div class="sb-footer">' +
      '<button class="swath-generate" id="swathGenerate">Generate</button>' +
      '<div class="gen-stale-note">↻ config changed — re-run</div>' +
      '<div class="swath-progress" id="swathProgress">' +
        '<div class="swath-progress-bar"><div class="swath-progress-fill" id="swathProgressFill"></div></div>' +
        '<div class="swath-progress-label" id="swathProgressLabel"></div>' +
      '</div>' +
    '</div>' +
    '<div class="swath-color-picker" id="swathColorPicker"></div>';

  // C6-4b \u2014 promote sections to collapsible; advanced ones collapsed by default
  wsEnhanceSidebar('swath', $sidebar, { stat: 'collapsed', display: 'collapsed', filter: 'collapsed' });

  $content.innerHTML = '<div class="swath-hint">Select variables and click Generate to create swath plots.</div>';

  // Direction mode toggle — show the matching direction rows
  var $dirMode = document.getElementById('swathDirMode');
  $dirMode.addEventListener('change', function() {
    document.getElementById('swathOrthoDirs').style.display = $dirMode.value === 'ortho' ? '' : 'none';
    document.getElementById('swathCustomDirs').style.display = $dirMode.value === 'custom' ? '' : 'none';
  });

  // Variable search filter (fuzzy)
  var $swathVarSearch = document.getElementById('swathVarSearch');
  $swathVarSearch.addEventListener('input', function() {
    var q = this.value.toLowerCase();
    document.querySelectorAll('#swathVarList .swath-var-item').forEach(function(item) {
      var name = item.querySelector('span').textContent.toLowerCase();
      item.style.display = fuzzyMatch(q, name) ? '' : 'none';
    });
  });
  wireSearchShortcuts($swathVarSearch, document.getElementById('swathVarAll'), document.getElementById('swathVarNone'));

  // All/None buttons — only affect visible (non-filtered) items
  document.getElementById('swathVarAll').addEventListener('click', function() {
    document.querySelectorAll('#swathVarList .swath-var-item').forEach(function(item) {
      if (item.style.display !== 'none') item.querySelector('input[type="checkbox"]').checked = true;
    });
  });
  document.getElementById('swathVarNone').addEventListener('click', function() {
    document.querySelectorAll('#swathVarList .swath-var-item').forEach(function(item) {
      if (item.style.display !== 'none') item.querySelector('input[type="checkbox"]').checked = false;
    });
  });

  // Generate button
  document.getElementById('swathGenerate').addEventListener('click', runSwath);

  // Shared support weight (D3): writing here also re-points the Statistics
  // tab's weight select — one role, two views
  document.getElementById('swathWeight').addEventListener('change', function() {
    catSetRole('model', 'weight', this.value || null);
    var $ssel = document.getElementById('statsWeightSel');
    if ($ssel) $ssel.value = this.value || '';
    markAnalysisStale();
    autoSaveProject();
  });

  // Stat change re-renders from cache
  document.getElementById('swathStat').addEventListener('change', function() {
    if (lastSwathData) renderSwathOutput();
  });

  // Display option changes re-render from cache
  ['swathShowBands','swathShowCounts','swathShowTable','swathYScale','swathLayout'].forEach(function(id) {
    document.getElementById(id).addEventListener('change', function() {
      if (lastSwathData) renderSwathOutput();
      autoSaveProject();
    });
  });

  // Swath per-variable unit change — write-through to the catalog (one unit
  // per variable, D2), mirror every other unit select, re-render from cache
  document.getElementById('swathVarList').addEventListener('change', function(e) {
    if (e.target.classList.contains('swath-var-unit')) {
      var uv = parseInt(e.target.value);
      if (e.target.dataset.auxCol != null) {
        if (e.target.dataset.auxName) catSetUnit(e.target.dataset.auxDs || 'aux', e.target.dataset.auxName, uv);
      } else {
        var un = currentHeader[parseInt(e.target.dataset.col)];
        if (un) catSetUnit('model', un, uv);
      }
      catRefreshUnitSelects();
      if (lastSwathData) renderSwathOutput();
      autoSaveProject();
    }
  });

  // Local filter autocomplete
  if (swathExprController) swathExprController.destroy();
  swathExprController = createExprInput(document.getElementById('swathLocalFilter'), { mode: 'filter' });

  // Color swatch click handler
  document.getElementById('swathVarList').addEventListener('click', function(e) {
    var swatch = e.target.closest('.swath-color-swatch');
    if (swatch) {
      e.preventDefault();
      e.stopPropagation();
      if (swatch.dataset.colorKey) {
        // Comparison swatch — override key is '<dsId>:NAME' (stable across display-prefix changes)
        var swDsId = swatch.dataset.auxDs || 'aux';
        var curColor = getAuxSwathVarColor(swatch.dataset.auxName, swathNumCols.length + parseInt(swatch.dataset.auxIdx || 0), swDsId);
        showSwathColorPicker(swatch.dataset.colorKey, null, swatch, curColor);
        return;
      }
      var colIdx = parseInt(swatch.dataset.col);
      showSwathColorPicker(currentHeader[colIdx], colIdx, swatch);
    }
  });

  // Color picker delegation
  var $swathPicker = document.getElementById('swathColorPicker');
  $swathPicker.addEventListener('click', function(e) {
    var swatch = e.target.closest('.cat-color-swatch');
    if (swatch) {
      var cn = $swathPicker.dataset.colName;
      applySwathColor(cn, swatch.dataset.color);
      hideSwathColorPicker();
    }
  });
  $swathPicker.addEventListener('change', function(e) {
    if (e.target.classList.contains('cat-hex-input')) {
      var hex = e.target.value.trim();
      if (/^#?[0-9a-fA-F]{3,8}$/.test(hex)) {
        if (hex[0] !== '#') hex = '#' + hex;
        var cn = $swathPicker.dataset.colName;
        applySwathColor(cn, hex);
        hideSwathColorPicker();
      }
    }
  });

  // Close color picker on click outside
  document.addEventListener('click', function(e) {
    if ($swathPicker.classList.contains('open') && !$swathPicker.contains(e.target) && !e.target.classList.contains('swath-color-swatch')) {
      hideSwathColorPicker();
    }
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && $swathPicker.classList.contains('open')) {
      hideSwathColorPicker();
    }
  });

  // Autosave on any sidebar change; mark stale on changes needing a re-run.
  // Statistic, display options, Y-scale, layout and per-variable units all
  // re-render client-side from cache (excluded below).
  var SWATH_LIVE_IDS = ['swathStat', 'swathShowBands', 'swathShowCounts', 'swathShowTable',
    'swathYScale', 'swathLayout', 'swathVarSearch'];
  function swathIsLiveTarget(t) {
    return !t || SWATH_LIVE_IDS.indexOf(t.id) >= 0 || t.classList.contains('swath-var-unit') ||
      (t.closest && t.closest('.swath-color-picker'));  // color edits re-render, no re-run
  }
  $sidebar.addEventListener('change', function(e) {
    autoSaveProject();
    if (!swathIsLiveTarget(e.target)) swathMarkStale();
  });
  $sidebar.addEventListener('input', function(e) {
    if (e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') autoSaveProject();
    if ((e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') && !swathIsLiveTarget(e.target)) swathMarkStale();
  });

  renderSwathAuxVars();
}

// Build/refresh the aux variable rows inside the swath sidebar. Safe to call
// anytime (no-op when the sidebar isn't built). Checkbox/unit state is keyed
// by variable name and preserved across rebuilds; a pending project restore
// takes precedence and is only consumed once rows actually render.
function renderSwathAuxVars() {
  var wrap = document.getElementById('swathAuxVars');
  if (!wrap) return;

  // Capture current DOM checked state before wiping, keyed '<dsId>:name' so
  // names that collide across datasets don't cross-contaminate. prevSeen tracks
  // which datasets already had rows — a dataset appearing for the first time
  // (e.g. a freshly-loaded d2) gets its paired default rather than inheriting
  // "unchecked" just because other datasets' checkboxes existed.
  var prevChecked = {};
  var prevSeen = {};
  wrap.querySelectorAll('input[data-aux="1"]').forEach(function(cb) {
    var dsId = cb.dataset.ds || 'aux';
    prevSeen[dsId] = true;
    if (cb.checked && cb.dataset.name) prevChecked[dsId + ':' + cb.dataset.name] = true;
  });

  var cmpDatasets = swathCmpDatasets();
  if (cmpDatasets.length === 0) { wrap.innerHTML = ''; return; }
  catEnsureSeeded();

  // A pending project restore applies to aux only (persistence covers the
  // model + aux today; d2+ swath selection is ephemeral until A10 phase 6).
  var restore = pendingSwathAuxRestore;
  pendingSwathAuxRestore = null;

  var ai = 0;  // running palette ordinal across all comparison series
  var html = '';
  cmpDatasets.forEach(function(ds) {
    var label = dsLabel(ds.id);
    var fname = ds.file ? ds.file.name : '';
    html += '<div class="swath-aux-divider">' + esc(label) + (fname ? ': ' + esc(fname) : '') + '</div>';
    if (!swathCmpReady(ds)) {
      html += '<div class="swath-aux-note">Assign ' + esc(label) + ' X/Y/Z to overlay its variables.</div>';
      return;
    }
    var cols = swathCmpCols(ds);
    if (cols.length === 0) {
      html += '<div class="swath-aux-note">No numeric ' + esc(label) + ' variables.</div>';
      return;
    }
    for (var k = 0; k < cols.length; k++, ai++) {
      var c = cols[k];
      // Default: checked when the variable shares a property with a model
      // variable (the comparison case) — seeded by name, editable in C1a+.
      // A project restore (aux only) overrides the default; otherwise prior
      // DOM state is preserved across rebuilds.
      var key = ds.id + ':' + c.name;
      var checked;
      if (ds.id === 'aux' && restore && restore.checked) checked = restore.checked.indexOf(c.name) >= 0;
      else if (prevSeen[ds.id]) checked = !!prevChecked[key];   // preserve user toggles
      else checked = !!catModelMember(ds.id, c.name);            // paired-by-default on first appearance
      var unitIdx = catPropUnit(ds.id, c.name);
      var unitOpts = GRADE_UNITS.map(function(u, ui) {
        return '<option value="' + ui + '"' + (ui === unitIdx ? ' selected' : '') + '>' + esc(u.label) + '</option>';
      }).join('');
      var color = getAuxSwathVarColor(c.name, swathNumCols.length + ai, ds.id);
      var emptyTag = colIsEmpty(ds.id, c.idx) ? '<span class="empty-tag" title="' + EMPTY_COL_TITLE + '">∅</span>' : '';
      html += '<label class="swath-var-item swath-var-item--aux">' +
        '<input type="checkbox" value="' + c.idx + '" data-aux="1" data-ds="' + esc(ds.id) + '" data-name="' + esc(c.name) + '"' + (checked ? ' checked' : '') + '>' +
        '<div class="swath-color-swatch" data-color-key="' + esc(ds.id) + ':' + esc(c.name) + '" data-aux-ds="' + esc(ds.id) + '" data-aux-name="' + esc(c.name) + '" data-aux-idx="' + ai + '" style="background:' + color + '"></div>' +
        '<span>' + esc(label) + ':' + esc(c.name) + '</span>' + emptyTag +
        '<select class="swath-var-unit" data-aux-col="' + c.idx + '" data-aux-ds="' + esc(ds.id) + '" data-aux-name="' + esc(c.name) + '">' + unitOpts + '</select></label>';
    }
  });
  wrap.innerHTML = html;
}

// Orthonormal frame from dip direction / dip / rake (E=x, N=y, Up=z):
// U = lineation in the plane at the given rake (measured from strike,
// dip to the right of strike, 90° = down-dip), W = pole to the plane,
// V = W × U (in-plane, perpendicular to U).
function computeSwathUVW(dipDirDeg, dipDeg, rakeDeg) {
  var a = dipDirDeg * Math.PI / 180, d = dipDeg * Math.PI / 180, r = rakeDeg * Math.PI / 180;
  var s = [-Math.cos(a), Math.sin(a), 0];                                  // strike
  var dd = [Math.sin(a) * Math.cos(d), Math.cos(a) * Math.cos(d), -Math.sin(d)]; // down-dip
  var w = [Math.sin(a) * Math.sin(d), Math.cos(a) * Math.sin(d), Math.cos(d)];   // pole (up)
  var u = [
    s[0] * Math.cos(r) + dd[0] * Math.sin(r),
    s[1] * Math.cos(r) + dd[1] * Math.sin(r),
    s[2] * Math.cos(r) + dd[2] * Math.sin(r)
  ];
  var v = [
    w[1] * u[2] - w[2] * u[1],
    w[2] * u[0] - w[0] * u[2],
    w[0] * u[1] - w[1] * u[0]
  ];
  return { u: u, v: v, w: w };
}

// Read the checked directions (+ per-direction bin widths) from the sidebar.
// Vector directions carry display azimuth/plunge derived from the vector.
function getSwathDirections() {
  var mode = (document.getElementById('swathDirMode') || {}).value || 'ortho';
  var dirs = [];
  function pushDir(key, axis, vec) {
    var cb = document.querySelector('#swathSidebar .swath-dir-on[data-dir="' + key + '"]');
    if (!cb || !cb.checked) return;
    var bw = parseFloat((document.getElementById('swathBin_' + key) || {}).value);
    var d = { key: key, axis: axis, dir: vec, binWidth: bw };
    if (vec) {
      d.azimuth = (Math.atan2(vec[0], vec[1]) * 180 / Math.PI + 360) % 360;
      d.plunge = -Math.asin(Math.max(-1, Math.min(1, vec[2]))) * 180 / Math.PI;
    }
    dirs.push(d);
  }
  var angles = null;
  if (mode === 'ortho') {
    pushDir('x', 0, null);
    pushDir('y', 1, null);
    pushDir('z', 2, null);
  } else {
    var dipDir = parseFloat((document.getElementById('swathDipDir') || {}).value) || 0;
    var dip = parseFloat((document.getElementById('swathDip') || {}).value) || 0;
    var rake = parseFloat((document.getElementById('swathRake') || {}).value);
    if (isNaN(rake)) rake = 90;
    angles = { dipDir: dipDir, dip: dip, rake: rake };
    var f = computeSwathUVW(dipDir, dip, rake);
    pushDir('u', null, f.u);
    pushDir('v', null, f.v);
    pushDir('w', null, f.w);
  }
  return { mode: mode, dirs: dirs, angles: angles };
}

function swathConfigError(msg) {
  var $progress = document.getElementById('swathProgress');
  var $label = document.getElementById('swathProgressLabel');
  if (!$progress || !$label) return;
  $progress.classList.add('active');
  $label.textContent = msg;
  $label.style.color = 'var(--red)';
  setTimeout(function() { $progress.classList.remove('active'); $label.style.color = ''; $label.textContent = ''; }, 2500);
}

function runSwath() {
  if (swathExprController) { var r = swathExprController.validate(); if (!r.valid) return; }
  var stat = document.getElementById('swathStat').value;
  var localFilter = document.getElementById('swathLocalFilter').value.trim();

  var dcfg = getSwathDirections();
  if (dcfg.dirs.length === 0) {
    swathConfigError('Check at least one direction');
    return;
  }
  for (var di = 0; di < dcfg.dirs.length; di++) {
    var dbw = dcfg.dirs[di].binWidth;
    if (!dbw || dbw <= 0 || isNaN(dbw)) {
      swathConfigError('Invalid bin width for ' + dcfg.dirs[di].key.toUpperCase());
      return;
    }
  }

  // Gather selected model variable column indices (the model and each
  // comparison dataset live in separate index spaces — comparison indices
  // point into that dataset's own header).
  var varCols = [];
  document.querySelectorAll('#swathVarList input[type="checkbox"]:not([data-aux]):checked').forEach(function(cb) {
    varCols.push(parseInt(cb.value));
  });
  // A10 4c-iii-b: build a run per comparison dataset that has selected vars —
  // one swath worker each, resolving its own weight (the declustering-stale
  // case soft-fails into a per-dataset error rather than launching a worker).
  var cmpRuns = [];
  swathCmpDatasets().forEach(function(ds) {
    if (!swathCmpReady(ds)) return;
    var sel = [];
    document.querySelectorAll('#swathVarList input[type="checkbox"][data-aux][data-ds="' + ds.id + '"]:checked').forEach(function(cb) {
      sel.push(parseInt(cb.value));
    });
    if (sel.length === 0) return;
    cmpRuns.push({ ds: ds, varCols: sel, weight: resolveSwathCmpWeight(ds) });
  });
  if (varCols.length === 0 && cmpRuns.length === 0) return;

  // Worker payload: direction geometry only (no display fields)
  var workerDirs = dcfg.dirs.map(function(d) {
    return { key: d.key, axis: d.axis, dir: d.dir, binWidth: d.binWidth };
  });

  if (swathWorker) { swathWorker.terminate(); swathWorker = null; }
  terminateSwathCmpWorkers();
  // The progress bar follows the model worker when present, else the first
  // comparison worker (so a comparison-only run still animates).
  var barDriverId = varCols.length > 0 ? 'model' : (cmpRuns[0] ? cmpRuns[0].ds.id : null);

  var $progress = document.getElementById('swathProgress');
  var $fill = document.getElementById('swathProgressFill');
  var $label = document.getElementById('swathProgressLabel');
  var $content = document.getElementById('swathContent');
  $progress.classList.add('active');
  $fill.style.width = '0%';
  $label.textContent = '0%';
  $content.innerHTML = '';

  var $btn = document.getElementById('swathGenerate');
  if ($btn) $btn.disabled = true;

  var pending = 0;
  var out = { results: {}, elapsed: 0, cmp: {} };  // cmp keyed by dsId

  function finalize() {
    if (pending > 0) return;
    $fill.style.width = '100%';
    $label.textContent = 'Done';
    setTimeout(function() { $progress.classList.remove('active'); }, 800);
    if ($btn) $btn.disabled = false;
    // Keep the active output tab when the new run still has that direction
    var prevKey = lastSwathData && lastSwathData.activeKey;
    // A10 4c-iii-b: comparison datasets ride as a list (one entry per overlaid
    // dataset), assembled in registry order (aux, d2, d3…) from the per-dataset
    // result slots the fan-out workers wrote.
    var cmp = [];
    for (var ci = 1; ci < datasets.length; ci++) {
      var slot = out.cmp[datasets[ci].id];
      if (slot) cmp.push(slot);
    }
    lastSwathData = {
      directions: dcfg.dirs, mode: dcfg.mode, angles: dcfg.angles,
      results: out.results, varCols: varCols, elapsed: out.elapsed,
      cmp: cmp,
      filterErrors: out.filterErrors || null, calcolErrors: out.calcolErrors || null,
      weightExcluded: out.weightExcluded || 0,
      activeKey: dcfg.dirs.some(function(d) { return d.key === prevKey; }) ? prevKey : dcfg.dirs[0].key
    };
    swathStale = false;
    if (typeof setGenStale === 'function') setGenStale('swathGenerate', false);
    renderSwathOutput(stat);
    // Update tab badge: max bin count across directions and variables
    var totalBins = 0;
    function scanBins(res) {
      if (!res) return;
      Object.values(res).forEach(function(varsObj) {
        Object.values(varsObj || {}).forEach(function(arr) { totalBins = Math.max(totalBins, arr.length); });
      });
    }
    scanBins(out.results);
    cmp.forEach(function(c) { scanBins(c.results); });
    wsTabBadge('swath', 'Swath', totalBins + ' bins');
    autoSaveProject();
  }

  // Primary failure aborts everything; a comparison failure is soft (the model
  // and the other comparison series still render)
  function abortAll(msg) {
    $label.textContent = msg;
    $label.style.color = 'var(--red)';
    setTimeout(function() { $progress.classList.remove('active'); $label.style.color = ''; }, 3000);
    if ($btn) $btn.disabled = false;
    if (swathWorker) { swathWorker.terminate(); swathWorker = null; }
    terminateSwathCmpWorkers();
  }

  if (varCols.length > 0) {
    pending++;
    swathWorker = new Worker(workerUrl);
    swathWorker.postMessage({
      mode: 'swath',
      file: currentFile,
      zipEntry: preflightData ? (preflightData.selectedZipEntry || null) : null,
      globalFilter: currentFilter ? { expression: currentFilter.expression } : null,
      localFilter: localFilter || null,
      calcolCode: currentCalcolCode || null,
      calcolMeta: currentCalcolMeta.length > 0 ? currentCalcolMeta : null,
      resolvedTypes: currentColTypes.slice(0, currentOrigColCount),
      xyzCols: [currentXYZ.x, currentXYZ.y, currentXYZ.z],
      dxyzCols: [currentDXYZ.dx, currentDXYZ.dy, currentDXYZ.dz],
      directions: workerDirs,
      varCols: varCols,
      weightColName: catRole('model', 'weight'),
      dmEndianness: preflightData && preflightData.dmEndianness || null,
      dmFormat: preflightData && preflightData.dmFormat || null
    });
    swathWorker.onerror = function(e) {
      abortAll('Worker error: ' + (e.message || 'unknown error'));
    };
    swathWorker.onmessage = function(e) {
      var m = e.data;
      if (m.type === 'swath-progress') {
        var pct = Math.min(99, m.percent);
        $fill.style.width = pct.toFixed(1) + '%';
        $label.textContent = pct.toFixed(0) + '%';
      } else if (m.type === 'swath-complete') {
        out.results = m.results;
        out.elapsed = m.elapsed;
        out.filterErrors = m.filterErrors || null;
        out.calcolErrors = m.calcolErrors || null;
        out.weightExcluded = m.weightExcluded || 0;
        swathWorker.terminate();
        swathWorker = null;
        pending--;
        finalize();
      } else if (m.type === 'error') {
        abortAll('Error: ' + m.message);
      }
    };
  }

  // Fan out one worker per comparison dataset. Each writes a result slot keyed
  // by dsId; a soft per-dataset error (declustered weights stale, worker crash)
  // surfaces in the warning banner instead of silently rendering unweighted or
  // dropping the series.
  cmpRuns.forEach(function(run) {
    var ds = run.ds, pf = ds.preflight;
    var slot = {
      dsId: ds.id, results: null, varCols: run.varCols, header: swathCmpHeader(ds),
      error: null, filterErrors: null, calcolErrors: null, weightExcluded: 0
    };
    out.cmp[ds.id] = slot;
    if (run.weight.blockedError) { slot.error = run.weight.blockedError; return; }  // no worker

    pending++;
    var w = new Worker(workerUrl);
    swathCmpWorkers.push(w);
    w.postMessage({
      mode: 'swath',
      file: ds.file,
      zipEntry: pf.selectedZipEntry || null,
      globalFilter: ds.filter ? { expression: ds.filter.expression } : null,
      localFilter: null,
      calcolCode: ds.calcolCode || null,
      calcolMeta: (ds.calcolMeta && ds.calcolMeta.length > 0) ? ds.calcolMeta : null,
      resolvedTypes: pf.autoTypes,
      xyzCols: [pf.xyz.x, pf.xyz.y, pf.xyz.z],
      dxyzCols: [-1, -1, -1],
      directions: workerDirs,
      varCols: run.varCols,
      rowVarOverride: ds.rowVar,
      weightColName: run.weight.weightColName,
      weightArray: run.weight.weightArray,
      dmEndianness: pf.dmEndianness || null,
      dmFormat: pf.dmFormat || null
    });
    w.onerror = function(e) {
      slot.error = e.message || 'unknown error';
      cleanupSwathCmpWorker(w);
      pending--;
      finalize();
    };
    w.onmessage = function(e) {
      var m = e.data;
      if (m.type === 'swath-progress') {
        if (barDriverId === ds.id) {
          var pct = Math.min(99, m.percent);
          $fill.style.width = pct.toFixed(1) + '%';
          $label.textContent = pct.toFixed(0) + '%';
        }
      } else if (m.type === 'swath-complete') {
        slot.results = m.results;
        slot.filterErrors = m.filterErrors || null;
        slot.calcolErrors = m.calcolErrors || null;
        slot.weightExcluded = m.weightExcluded || 0;
        cleanupSwathCmpWorker(w);
        pending--;
        finalize();
      } else if (m.type === 'error') {
        slot.error = m.message;
        cleanupSwathCmpWorker(w);
        pending--;
        finalize();
      }
    };
  });

  // No worker actually launched (e.g. the only selected dataset is aux with
  // stale declustered weights → soft-blocked). finalize() is guarded by
  // pending>0, so this is a no-op when workers are in flight; when none ran it
  // surfaces the per-dataset error banner instead of leaving the bar spinning.
  if (pending === 0) finalize();
}

function queryTDigestPercentile(centroids, p) {
  if (!centroids || centroids.length === 0) return null;
  var total = 0;
  for (var i = 0; i < centroids.length; i++) total += centroids[i][1];
  if (total === 0) return null;
  var target = p * total;
  var cum = 0;
  for (var i = 0; i < centroids.length; i++) {
    cum += centroids[i][1];
    if (cum >= target) return centroids[i][0];
  }
  return centroids[centroids.length - 1][0];
}

function buildSwathStatLines(bins, stat) {
  var centerLine = [], upperLine = [], lowerLine = [];
  for (var bi = 0; bi < bins.length; bi++) {
    var bin = bins[bi];
    var x = bin.center;
    if (stat === 'mean_std') {
      centerLine.push({ x: x, y: bin.mean });
      upperLine.push({ x: x, y: bin.mean + bin.std });
      lowerLine.push({ x: x, y: bin.mean - bin.std });
    } else if (stat === 'p25_50_75') {
      centerLine.push({ x: x, y: queryTDigestPercentile(bin.centroids, 0.50) });
      upperLine.push({ x: x, y: queryTDigestPercentile(bin.centroids, 0.75) });
      lowerLine.push({ x: x, y: queryTDigestPercentile(bin.centroids, 0.25) });
    } else {
      centerLine.push({ x: x, y: queryTDigestPercentile(bin.centroids, 0.50) });
      upperLine.push({ x: x, y: queryTDigestPercentile(bin.centroids, 0.90) });
      lowerLine.push({ x: x, y: queryTDigestPercentile(bin.centroids, 0.10) });
    }
  }
  return { centerLine: centerLine, upperLine: upperLine, lowerLine: lowerLine };
}

// Group entries that share a Y scale: an aux series with the same variable
// name as a primary series joins the primary's group. Sharing the scale is
// what makes model-vs-samples bias visible — separate autoscaled axes would
// stretch both series to fill the plot and hide exactly the offset the
// validation plot exists to show.
function buildSwathScaleGroups(varEntries) {
  var groups = [];
  var byKey = {};
  for (var i = 0; i < varEntries.length; i++) {
    var en = varEntries[i];
    var gi = byKey[en.scaleKey];
    if (gi === undefined) {
      gi = groups.length;
      byKey[en.scaleKey] = gi;
      groups.push({ key: en.scaleKey, entries: [], color: en.color, name: en.name, unit: en.unit });
    }
    en.groupIdx = gi;
    groups[gi].entries.push(en);
  }
  return groups;
}

function renderSwathCharts(swathData, stat, $target) {
  var $content = $target || document.getElementById('swathContent');
  if (!$content || !swathData || !swathData.vars) {
    if ($content) $content.innerHTML = '<div class="swath-hint">No data.</div>';
    return;
  }
  var varCols = swathData.varCols || [];
  var cmp = swathData.cmp || [];
  var hasData = varCols.some(function(vi) { return swathData.vars[vi] && swathData.vars[vi].length > 0; }) ||
    cmp.some(function(c) { return c.vars && (c.varCols || []).some(function(vi) { return c.vars[vi] && c.vars[vi].length > 0; }); });
  if (!hasData) {
    $content.innerHTML = '<div class="swath-hint">No data in selected bins.</div>';
    return;
  }

  // Build per-variable entries — primary first, then aux. Selected variables
  // with zero surviving bins (empty column, everything filtered) are listed
  // in a note instead of silently vanishing from the chart (A8)
  var noData = [];
  var varEntries = [];
  for (var vi = 0; vi < varCols.length; vi++) {
    var colIdx = varCols[vi];
    var bins = (swathData.vars[colIdx] || []).filter(function(b) { return b.count > 0; }).sort(function(a, b) { return a.center - b.center; });
    var name = currentHeader[colIdx] || 'Variable';
    if (bins.length === 0) { noData.push(name); continue; }
    var lines = buildSwathStatLines(bins, stat);
    varEntries.push({
      colIdx: colIdx,
      isAux: false,
      name: name,
      color: getSwathVarColor(name, vi),
      bins: bins,
      centerLine: lines.centerLine,
      upperLine: lines.upperLine,
      lowerLine: lines.lowerLine,
      unit: getSwathUnit(colIdx),
      scaleKey: name
    });
  }
  // Comparison series — one block per overlaid dataset (aux, d2…). A member
  // sharing a property with a shown model variable rides that variable's Y axis
  // and hue (dashed reads as "same variable, other dataset"); otherwise it gets
  // its own scale keyed by '<dsId>:<name>'.
  var primaryKeys = {};
  varEntries.forEach(function(en) { primaryKeys[en.scaleKey] = true; });
  cmp.forEach(function(c) {
    if (!c.vars) return;
    var prefixLabel = dsLabel(c.dsId);
    var cVarCols = c.varCols || [];
    for (var ai = 0; ai < cVarCols.length; ai++) {
      var aIdx = cVarCols[ai];
      var aBins = (c.vars[aIdx] || []).filter(function(b) { return b.count > 0; }).sort(function(a, b) { return a.center - b.center; });
      var baseName = (c.header && c.header[aIdx]) || 'Variable';
      if (aBins.length === 0) { noData.push(prefixLabel + ':' + baseName); continue; }
      var aLines = buildSwathStatLines(aBins, stat);
      var aPair = catModelMember(c.dsId, baseName);
      var aKey = aPair && primaryKeys[aPair] ? aPair : c.dsId + ':' + baseName;
      varEntries.push({
        colIdx: aIdx,
        isAux: true,
        dsId: c.dsId,
        baseName: baseName,
        name: prefixLabel + ':' + baseName,
        color: getAuxSwathVarColor(baseName, varEntries.length, c.dsId),
        bins: aBins,
        centerLine: aLines.centerLine,
        upperLine: aLines.upperLine,
        lowerLine: aLines.lowerLine,
        unit: getAuxSwathUnit(aIdx, baseName, c.dsId),
        scaleKey: aKey
      });
    }
  });

  if (varEntries.length === 0) {
    $content.innerHTML = '<div class="swath-hint">No data in selected bins.</div>';
    return;
  }

  var display = getSwathDisplay();
  var chartSvg = display.layout === 'split'
    ? renderSwathSplitSvg(varEntries, swathData, stat, display)
    : renderSwathOverlaySvg(varEntries, swathData, stat, display);
  var html = '';
  cmp.forEach(function(c) {
    if (c.error) html += '<div class="warn-note">' + esc(dsLabel(c.dsId)) + ' swath failed: ' + esc(c.error) + ' — showing primary only.</div>';
  });
  if (noData.length > 0) {
    html += '<div class="warn-note">No data for ' + noData.map(esc).join(', ') +
      ' — column empty or every value filtered out.</div>';
  }
  html += '<div class="swath-chart-card">' +
    '<div class="swath-chart-toolbar">' +
      '<button class="swath-chart-btn" id="swathCopySvg">Copy SVG</button>' +
      '<button class="swath-chart-btn" id="swathDownloadPng">Download PNG</button>' +
    '</div>' +
    chartSvg + '</div>';
  if (display.showTable) html += renderSwathTable(varEntries, swathData, stat);
  $content.innerHTML = html;

  wireSwathCrosshair();
  wireSwathChartActions();
  if (display.showTable) wireSwathTableEvents();
}

function renderSwathOverlaySvg(varEntries, swathData, stat, display) {
  var numVars = varEntries.length;
  var bw = swathData.binWidth;

  // Y-scale groups: same-named model/aux series share an axis
  var groups = buildSwathScaleGroups(varEntries);
  var numGroups = groups.length;

  // Reference bins for counts/crosshair: first primary entry, else first entry
  var refEntry = varEntries[0];
  for (var ri = 0; ri < varEntries.length; ri++) {
    if (!varEntries[ri].isAux) { refEntry = varEntries[ri]; break; }
  }
  var refBins = refEntry.bins;

  // Dimensions — extra right axes for 3+ scale groups
  var extraAxes = Math.max(0, numGroups - 2);
  var W = chartHostWidth(document.getElementById('swathContent'), 720 + extraAxes * 55, 560 + extraAxes * 55, 34);
  var padRight = 55 + extraAxes * 55;
  var pad = { top: 30, right: padRight, bottom: 70, left: 65 };
  var plotW = W - pad.left - pad.right;
  var plotH = 240;
  // Legend height — 3 columns
  var legendCols = 3;
  var legendRows = Math.ceil(numVars / legendCols);
  var legendH = legendRows * 16 + 10;
  var countBarH = display.showCounts ? 20 : 0;
  var countGap = display.showCounts ? 30 : 10;
  var H = pad.top + plotH + countGap + countBarH + 10 + legendH + pad.bottom;

  // Shared X scale over the union of all entries' extents
  var xMin = Infinity, xMax = -Infinity;
  for (var xi = 0; xi < varEntries.length; xi++) {
    var xb = varEntries[xi].bins;
    if (xb[0].center - bw / 2 < xMin) xMin = xb[0].center - bw / 2;
    if (xb[xb.length - 1].center + bw / 2 > xMax) xMax = xb[xb.length - 1].center + bw / 2;
  }
  var xRange = xMax - xMin || 1;
  var sx = function(v) { return pad.left + ((v - xMin) / xRange) * plotW; };

  // Per-group Y scales (union of member entries' extents)
  var yMins = [], yMaxs = [];
  for (var gi = 0; gi < numGroups; gi++) {
    var allY = [];
    for (var gei = 0; gei < groups[gi].entries.length; gei++) {
      var entry = groups[gi].entries[gei];
      for (var j = 0; j < entry.centerLine.length; j++) { if (entry.centerLine[j].y != null) allY.push(entry.centerLine[j].y); }
      for (var j = 0; j < entry.upperLine.length; j++) { if (entry.upperLine[j].y != null) allY.push(entry.upperLine[j].y); }
      for (var j = 0; j < entry.lowerLine.length; j++) { if (entry.lowerLine[j].y != null) allY.push(entry.lowerLine[j].y); }
    }
    var yMin = allY.length > 0 ? Math.min.apply(null, allY) : 0;
    var yMax = allY.length > 0 ? Math.max.apply(null, allY) : 1;
    var yPad = (yMax - yMin) * 0.1 || 1;
    yMin -= yPad; yMax += yPad;
    yMins.push(yMin);
    yMaxs.push(yMax);
  }

  var useLog = display.yScale === 'log';
  // For log scale, compute log-space min/max
  var logYMins = [], logYMaxs = [];
  if (useLog) {
    for (var gi = 0; gi < numGroups; gi++) {
      var logMin = yMins[gi] > 0 ? Math.log10(yMins[gi]) : -1;
      var logMax = yMaxs[gi] > 0 ? Math.log10(yMaxs[gi]) : 1;
      if (logMax <= logMin) logMax = logMin + 1;
      logYMins.push(logMin);
      logYMaxs.push(logMax);
    }
  }

  function syFn(gi) {
    if (useLog) {
      var lmn = logYMins[gi], lmx = logYMaxs[gi];
      var lr = lmx - lmn || 1;
      return function(v) {
        var lv = v > 0 ? Math.log10(v) : lmn;
        return pad.top + ((lmx - lv) / lr) * plotH;
      };
    }
    var ymn = yMins[gi], ymx = yMaxs[gi];
    var yr = ymx - ymn || 1;
    return function(v) { return pad.top + ((ymx - v) / yr) * plotH; };
  }

  // Store params for crosshair
  _swathChartParams = {
    layout: 'overlay',
    shortLabel: swathData.azimuth != null ? (swathData.key || 'u').toUpperCase() : (swathData.axis || 'coord').toUpperCase(),
    dirKey: swathData.key || swathData.axis || 'plot',
    varEntries: varEntries,
    xMin: xMin, xMax: xMax,
    yMins: yMins, yMaxs: yMaxs,
    pad: pad, plotW: plotW, plotH: plotH, W: W, H: H, bw: bw,
    stat: stat, refBins: refBins
  };

  var svg = '';
  // Background
  svg += '<rect width="' + W + '" height="' + H + '" fill="var(--bg)" rx="4"/>';

  // X grid lines
  var nxTicks = Math.min(10, refBins.length);
  for (var i = 0; i <= nxTicks; i++) {
    var v = xMin + (xRange * i / nxTicks);
    var x = sx(v);
    svg += '<line x1="' + x.toFixed(1) + '" y1="' + pad.top + '" x2="' + x.toFixed(1) + '" y2="' + (pad.top + plotH) + '" stroke="var(--chart-grid)" stroke-width="1"/>';
    svg += '<text x="' + x.toFixed(1) + '" y="' + (pad.top + plotH + 14) + '" text-anchor="middle" fill="var(--chart-ink)" font-size="9">' + formatNum(v) + '</text>';
  }

  // Y grid from first variable only
  var sy0 = syFn(0);
  var nyTicks = 6;
  var yGridVals = [];
  if (useLog) {
    var lFloor = Math.floor(logYMins[0]), lCeil = Math.ceil(logYMaxs[0]);
    for (var p = lFloor; p <= lCeil; p++) { yGridVals.push(Math.pow(10, p)); }
    if (yGridVals.length < 3) {
      for (var i = 0; i <= nyTicks; i++) {
        var lv = logYMins[0] + ((logYMaxs[0] - logYMins[0]) * i / nyTicks);
        yGridVals.push(Math.pow(10, lv));
      }
    }
  } else {
    var yRange0 = yMaxs[0] - yMins[0] || 1;
    for (var i = 0; i <= nyTicks; i++) yGridVals.push(yMins[0] + (yRange0 * i / nyTicks));
  }
  for (var i = 0; i < yGridVals.length; i++) {
    var y = sy0(yGridVals[i]);
    svg += '<line x1="' + pad.left + '" y1="' + y.toFixed(1) + '" x2="' + (pad.left + plotW) + '" y2="' + y.toFixed(1) + '" stroke="var(--chart-grid)" stroke-width="1"/>';
  }

  // Per-variable ribbons and lines (aux series dashed, lighter ribbon)
  for (var vi = 0; vi < varEntries.length; vi++) {
    var entry = varEntries[vi];
    var sy = syFn(entry.groupIdx);
    var color = entry.color;

    // Ribbon (bands)
    if (display.showBands) {
      var ribbonPath = '';
      for (var i = 0; i < entry.bins.length; i++) {
        ribbonPath += (i === 0 ? 'M' : 'L') + sx(entry.upperLine[i].x).toFixed(1) + ',' + sy(entry.upperLine[i].y != null ? entry.upperLine[i].y : 0).toFixed(1);
      }
      for (var i = entry.bins.length - 1; i >= 0; i--) {
        ribbonPath += 'L' + sx(entry.lowerLine[i].x).toFixed(1) + ',' + sy(entry.lowerLine[i].y != null ? entry.lowerLine[i].y : 0).toFixed(1);
      }
      ribbonPath += 'Z';
      svg += '<path d="' + ribbonPath + '" fill="' + color + '" opacity="' + (entry.isAux ? '0.08' : '0.15') + '"/>';
    }

    // Center line
    var centerPath = '';
    for (var i = 0; i < entry.bins.length; i++) {
      centerPath += (i === 0 ? 'M' : 'L') + sx(entry.centerLine[i].x).toFixed(1) + ',' + sy(entry.centerLine[i].y != null ? entry.centerLine[i].y : 0).toFixed(1);
    }
    svg += '<path d="' + centerPath + '" fill="none" stroke="' + color + '" stroke-width="1.5"' + (entry.isAux ? ' stroke-dasharray="6,4"' : '') + '/>';
  }

  // Per-group Y axes (a shared model/aux group draws one axis)
  for (var gi = 0; gi < numGroups; gi++) {
    var group = groups[gi];
    var sy = syFn(gi);
    var color = group.color;
    var yr = yMaxs[gi] - yMins[gi] || 1;

    // Generate tick values for this group's axis
    var tickVals = [];
    if (useLog) {
      var lFloorV = Math.floor(logYMins[gi]), lCeilV = Math.ceil(logYMaxs[gi]);
      for (var p = lFloorV; p <= lCeilV; p++) tickVals.push(Math.pow(10, p));
      if (tickVals.length < 3) {
        tickVals = [];
        for (var ti = 0; ti <= nyTicks; ti++) {
          var lv = logYMins[gi] + ((logYMaxs[gi] - logYMins[gi]) * ti / nyTicks);
          tickVals.push(Math.pow(10, lv));
        }
      }
    } else {
      for (var ti = 0; ti <= nyTicks; ti++) tickVals.push(yMins[gi] + (yr * ti / nyTicks));
    }

    if (gi === 0) {
      // Left Y-axis
      for (var ti = 0; ti < tickVals.length; ti++) {
        var v = tickVals[ti];
        var y = sy(v);
        svg += '<text x="' + (pad.left - 6) + '" y="' + (y + 3) + '" text-anchor="end" fill="' + color + '" font-size="9">' + formatNum(v) + '</text>';
      }
      var axisLabel = esc(group.name) + (group.unit && group.unit.symbol ? ' (' + esc(group.unit.symbol) + ')' : '');
      svg += '<text x="12" y="' + (pad.top + plotH / 2) + '" text-anchor="middle" fill="' + color + '" font-size="10" transform="rotate(-90, 12, ' + (pad.top + plotH / 2) + ')">' + axisLabel + '</text>';
    } else {
      // Right Y-axis — offset by (gi - 1) * 55
      var axisX = pad.left + plotW + (gi - 1) * 55 + 10;
      for (var ti = 0; ti < tickVals.length; ti++) {
        var v = tickVals[ti];
        var y = sy(v);
        svg += '<text x="' + (axisX + 6) + '" y="' + (y + 3) + '" text-anchor="start" fill="' + color + '" font-size="9">' + formatNum(v) + '</text>';
      }
      svg += '<line x1="' + axisX + '" y1="' + pad.top + '" x2="' + axisX + '" y2="' + (pad.top + plotH) + '" stroke="' + color + '" stroke-width="0.5" opacity="0.4"/>';
    }
  }

  // Count bars below plot — primary filled; aux overlaid hollow, each
  // normalized to its own max (block and sample counts differ by orders
  // of magnitude)
  var barTop = pad.top + plotH + countGap - 4;
  if (display.showCounts) {
    var maxCount = 0;
    for (var i = 0; i < refBins.length; i++) { if (refBins[i].count > maxCount) maxCount = refBins[i].count; }
    for (var i = 0; i < refBins.length; i++) {
      var bin = refBins[i];
      var bx = sx(bin.center - bw / 2);
      var bwPx = sx(bin.center + bw / 2) - bx;
      var bh = maxCount > 0 ? (bin.count / maxCount) * countBarH : 0;
      svg += '<rect x="' + bx.toFixed(1) + '" y="' + (barTop + countBarH - bh).toFixed(1) + '" width="' + Math.max(1, bwPx - 1).toFixed(1) + '" height="' + bh.toFixed(1) + '" fill="rgba(240,178,50,0.3)"/>';
    }
    var auxCountRef = null;
    for (var i = 0; i < varEntries.length; i++) {
      if (varEntries[i].isAux) { auxCountRef = varEntries[i]; break; }
    }
    if (auxCountRef && auxCountRef !== refEntry) {
      var auxMax = 0;
      for (var i = 0; i < auxCountRef.bins.length; i++) { if (auxCountRef.bins[i].count > auxMax) auxMax = auxCountRef.bins[i].count; }
      for (var i = 0; i < auxCountRef.bins.length; i++) {
        var abin = auxCountRef.bins[i];
        var abx = sx(abin.center - bw / 2);
        var abwPx = sx(abin.center + bw / 2) - abx;
        var abh = auxMax > 0 ? (abin.count / auxMax) * countBarH : 0;
        svg += '<rect x="' + abx.toFixed(1) + '" y="' + (barTop + countBarH - abh).toFixed(1) + '" width="' + Math.max(1, abwPx - 1).toFixed(1) + '" height="' + Math.max(0.5, abh).toFixed(1) + '" fill="none" stroke="' + auxCountRef.color + '" stroke-width="0.75" opacity="0.6"/>';
      }
    }
  }

  // Direction labels
  var dirLabels = getSwathDirectionLabels(swathData);
  svg += '<text x="' + (pad.left + 4) + '" y="' + (pad.top - 8) + '" fill="var(--chart-ink)" font-size="10">' + dirLabels.left + ' (' + formatNum(xMin) + ')</text>';
  svg += '<text x="' + (pad.left + plotW - 4) + '" y="' + (pad.top - 8) + '" text-anchor="end" fill="var(--chart-ink)" font-size="10">' + dirLabels.right + ' (' + formatNum(xMax) + ')</text>';

  // X axis label
  var statLabels = { mean_std: 'Mean \u00b1 Std', p25_50_75: 'P25/P50/P75', p10_50_90: 'P10/P50/P90' };
  svg += '<text x="' + (pad.left + plotW / 2) + '" y="' + (barTop + countBarH + 14) + '" text-anchor="middle" fill="var(--chart-ink)" font-size="10">' + getSwathXAxisLabel(swathData) + ' (' + (statLabels[stat] || stat) + ')</text>';

  // Legend — 3 columns; aux entries get a dashed line marker
  var legendTop = barTop + countBarH + 24;
  var colW = plotW / legendCols;
  for (var vi = 0; vi < varEntries.length; vi++) {
    var col = vi % legendCols;
    var row = Math.floor(vi / legendCols);
    var lx = pad.left + col * colW;
    var ly = legendTop + row * 16;
    var legLabel = esc(varEntries[vi].name) + (varEntries[vi].unit && varEntries[vi].unit.symbol ? ' (' + esc(varEntries[vi].unit.symbol) + ')' : '');
    if (varEntries[vi].isAux) {
      svg += '<line x1="' + lx + '" y1="' + (ly + 1.5) + '" x2="' + (lx + 12) + '" y2="' + (ly + 1.5) + '" stroke="' + varEntries[vi].color + '" stroke-width="2.5" stroke-dasharray="3,2"/>';
    } else {
      svg += '<rect x="' + lx + '" y="' + ly + '" width="12" height="3" fill="' + varEntries[vi].color + '" rx="1"/>';
    }
    svg += '<text x="' + (lx + 16) + '" y="' + (ly + 4) + '" fill="' + varEntries[vi].color + '" font-size="9">' + legLabel + '</text>';
  }

  // Crosshair overlay elements
  svg += '<rect class="swath-crosshair-area" x="' + pad.left + '" y="' + pad.top + '" width="' + plotW + '" height="' + plotH + '" fill="transparent" cursor="crosshair"/>';
  svg += '<line class="swath-crosshair-line" x1="0" y1="' + pad.top + '" x2="0" y2="' + (pad.top + plotH) + '" opacity="0" stroke="var(--fg-dim)" stroke-width="1" stroke-dasharray="3,3" pointer-events="none"/>';
  svg += '<g class="swath-crosshair-tooltip" opacity="0" pointer-events="none">';
  svg += '<rect class="swath-tt-bg" rx="3"/>';
  svg += '<text class="swath-tt-text" font-size="9"/>';
  svg += '</g>';

  return '<svg class="swath-overlay-svg" viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" style="font-family:var(--mono);width:100%;height:100%"' +
    ' data-pad-left="' + pad.left + '" data-pad-right="' + pad.right + '" data-w="' + W + '"' +
    ' data-xmin="' + xMin + '" data-xmax="' + xMax + '" data-plot-w="' + plotW + '" data-plot-h="' + plotH + '">' +
    svg + '</svg>';
}

function renderSwathSplitSvg(varEntries, swathData, stat, display) {
  var bw = swathData.binWidth;

  // One sub-chart per scale group: a same-named aux series shares its
  // primary's panel and Y scale
  var groups = buildSwathScaleGroups(varEntries);
  var numGroups = groups.length;

  // Reference bins for counts/crosshair: first primary entry, else first entry
  var refEntry = varEntries[0];
  for (var ri = 0; ri < varEntries.length; ri++) {
    if (!varEntries[ri].isAux) { refEntry = varEntries[ri]; break; }
  }
  var refBins = refEntry.bins;

  // Dimensions
  var W = chartHostWidth(document.getElementById('swathContent'), 720, 560, 34);
  var pad = { top: 20, right: 20, bottom: 40, left: 65 };
  var plotW = W - pad.left - pad.right;
  var subH = 150; // height per sub-chart
  var subGap = 24; // gap between sub-charts
  var countBarH = display.showCounts ? 20 : 0;
  var countGap = display.showCounts ? 10 : 0;
  var totalH = pad.top + numGroups * subH + (numGroups - 1) * subGap + countGap + countBarH + pad.bottom;

  // Shared X scale over the union of all entries' extents
  var xMin = Infinity, xMax = -Infinity;
  for (var xi = 0; xi < varEntries.length; xi++) {
    var xb = varEntries[xi].bins;
    if (xb[0].center - bw / 2 < xMin) xMin = xb[0].center - bw / 2;
    if (xb[xb.length - 1].center + bw / 2 > xMax) xMax = xb[xb.length - 1].center + bw / 2;
  }
  var xRange = xMax - xMin || 1;
  var sx = function(v) { return pad.left + ((v - xMin) / xRange) * plotW; };

  var useLog = display.yScale === 'log';

  // Per-group Y ranges (union of member entries' extents)
  var yMins = [], yMaxs = [], logYMinsSplit = [], logYMaxsSplit = [];
  for (var gi = 0; gi < numGroups; gi++) {
    var allY = [];
    for (var gei = 0; gei < groups[gi].entries.length; gei++) {
      var entry = groups[gi].entries[gei];
      for (var j = 0; j < entry.centerLine.length; j++) { if (entry.centerLine[j].y != null) allY.push(entry.centerLine[j].y); }
      for (var j = 0; j < entry.upperLine.length; j++) { if (entry.upperLine[j].y != null) allY.push(entry.upperLine[j].y); }
      for (var j = 0; j < entry.lowerLine.length; j++) { if (entry.lowerLine[j].y != null) allY.push(entry.lowerLine[j].y); }
    }
    var yMin = allY.length > 0 ? Math.min.apply(null, allY) : 0;
    var yMax = allY.length > 0 ? Math.max.apply(null, allY) : 1;
    var yPad = (yMax - yMin) * 0.1 || 1;
    yMin -= yPad; yMax += yPad;
    yMins.push(yMin); yMaxs.push(yMax);
    if (useLog) {
      var lMin = yMin > 0 ? Math.log10(yMin) : -1;
      var lMax = yMax > 0 ? Math.log10(yMax) : 1;
      if (lMax <= lMin) lMax = lMin + 1;
      logYMinsSplit.push(lMin); logYMaxsSplit.push(lMax);
    }
  }

  function subTop(gi) { return pad.top + gi * (subH + subGap); }

  function syFn(gi) {
    var st = subTop(gi);
    if (useLog) {
      var lmn = logYMinsSplit[gi], lmx = logYMaxsSplit[gi];
      var lr = lmx - lmn || 1;
      return function(v) {
        var lv = v > 0 ? Math.log10(v) : lmn;
        return st + ((lmx - lv) / lr) * subH;
      };
    }
    var ymn = yMins[gi], ymx = yMaxs[gi], yr = ymx - ymn || 1;
    return function(v) { return st + ((ymx - v) / yr) * subH; };
  }

  // Store params for crosshair
  _swathChartParams = {
    layout: 'split',
    shortLabel: swathData.azimuth != null ? (swathData.key || 'u').toUpperCase() : (swathData.axis || 'coord').toUpperCase(),
    dirKey: swathData.key || swathData.axis || 'plot',
    varEntries: varEntries,
    xMin: xMin, xMax: xMax,
    yMins: yMins, yMaxs: yMaxs,
    pad: pad, plotW: plotW, subH: subH, subGap: subGap,
    W: W, H: totalH, bw: bw,
    stat: stat, refBins: refBins, numVars: numGroups,
    subTop: subTop
  };

  var svg = '';
  svg += '<rect width="' + W + '" height="' + totalH + '" fill="var(--bg)" rx="4"/>';

  // Direction labels on top of first sub-chart
  var dirLabels = getSwathDirectionLabels(swathData);
  svg += '<text x="' + (pad.left + 4) + '" y="' + (pad.top - 6) + '" fill="var(--chart-ink)" font-size="10">' + dirLabels.left + ' (' + formatNum(xMin) + ')</text>';
  svg += '<text x="' + (pad.left + plotW - 4) + '" y="' + (pad.top - 6) + '" text-anchor="end" fill="var(--chart-ink)" font-size="10">' + dirLabels.right + ' (' + formatNum(xMax) + ')</text>';

  // Render each sub-chart (one per scale group; member series overlay in it)
  for (var gi = 0; gi < numGroups; gi++) {
    var group = groups[gi];
    var sy = syFn(gi);
    var st = subTop(gi);
    var color = group.color;

    // Background for sub-chart
    svg += '<rect x="' + pad.left + '" y="' + st + '" width="' + plotW + '" height="' + subH + '" fill="var(--bg)" stroke="var(--border)" stroke-width="0.5"/>';

    // X grid lines (light)
    var nxTicks = Math.min(10, refBins.length);
    for (var i = 0; i <= nxTicks; i++) {
      var v = xMin + (xRange * i / nxTicks);
      var x = sx(v);
      svg += '<line x1="' + x.toFixed(1) + '" y1="' + st + '" x2="' + x.toFixed(1) + '" y2="' + (st + subH) + '" stroke="var(--chart-grid)" stroke-width="1"/>';
    }

    // Y grid lines
    var nyTicks = 4;
    var yr = yMaxs[gi] - yMins[gi] || 1;
    if (useLog) {
      var lFloor = Math.floor(logYMinsSplit[gi]), lCeil = Math.ceil(logYMaxsSplit[gi]);
      for (var p = lFloor; p <= lCeil; p++) {
        var gv = Math.pow(10, p);
        var gy = sy(gv);
        svg += '<line x1="' + pad.left + '" y1="' + gy.toFixed(1) + '" x2="' + (pad.left + plotW) + '" y2="' + gy.toFixed(1) + '" stroke="var(--chart-grid)" stroke-width="1"/>';
      }
    } else {
      for (var i = 0; i <= nyTicks; i++) {
        var v = yMins[gi] + (yr * i / nyTicks);
        var gy = sy(v);
        svg += '<line x1="' + pad.left + '" y1="' + gy.toFixed(1) + '" x2="' + (pad.left + plotW) + '" y2="' + gy.toFixed(1) + '" stroke="var(--chart-grid)" stroke-width="1"/>';
      }
    }

    // Member series: ribbon + center line (aux dashed, lighter ribbon)
    for (var mi = 0; mi < group.entries.length; mi++) {
      var entry = group.entries[mi];
      var ecolor = entry.color;

      if (display.showBands) {
        var ribbonPath = '';
        for (var i = 0; i < entry.bins.length; i++) {
          ribbonPath += (i === 0 ? 'M' : 'L') + sx(entry.upperLine[i].x).toFixed(1) + ',' + sy(entry.upperLine[i].y != null ? entry.upperLine[i].y : 0).toFixed(1);
        }
        for (var i = entry.bins.length - 1; i >= 0; i--) {
          ribbonPath += 'L' + sx(entry.lowerLine[i].x).toFixed(1) + ',' + sy(entry.lowerLine[i].y != null ? entry.lowerLine[i].y : 0).toFixed(1);
        }
        ribbonPath += 'Z';
        svg += '<path d="' + ribbonPath + '" fill="' + ecolor + '" opacity="' + (entry.isAux ? '0.08' : '0.15') + '"/>';
      }

      var centerPath = '';
      for (var i = 0; i < entry.bins.length; i++) {
        centerPath += (i === 0 ? 'M' : 'L') + sx(entry.centerLine[i].x).toFixed(1) + ',' + sy(entry.centerLine[i].y != null ? entry.centerLine[i].y : 0).toFixed(1);
      }
      svg += '<path d="' + centerPath + '" fill="none" stroke="' + ecolor + '" stroke-width="1.5"' + (entry.isAux ? ' stroke-dasharray="6,4"' : '') + '/>';
    }

    // Left Y-axis ticks (group scale, group color)
    var tickVals = [];
    if (useLog) {
      var lFloorV = Math.floor(logYMinsSplit[gi]), lCeilV = Math.ceil(logYMaxsSplit[gi]);
      for (var p = lFloorV; p <= lCeilV; p++) tickVals.push(Math.pow(10, p));
      if (tickVals.length < 3) {
        tickVals = [];
        for (var ti = 0; ti <= nyTicks; ti++) {
          var lv = logYMinsSplit[gi] + ((logYMaxsSplit[gi] - logYMinsSplit[gi]) * ti / nyTicks);
          tickVals.push(Math.pow(10, lv));
        }
      }
    } else {
      for (var ti = 0; ti <= nyTicks; ti++) tickVals.push(yMins[gi] + (yr * ti / nyTicks));
    }
    for (var ti = 0; ti < tickVals.length; ti++) {
      var y = sy(tickVals[ti]);
      svg += '<text x="' + (pad.left - 6) + '" y="' + (y + 3) + '" text-anchor="end" fill="' + color + '" font-size="9">' + formatNum(tickVals[ti]) + '</text>';
    }

    // Member name labels, stacked top-left
    var labelY = st + 12;
    for (var mi = 0; mi < group.entries.length; mi++) {
      var entry = group.entries[mi];
      var uSym = entry.unit && entry.unit.symbol ? ' (' + esc(entry.unit.symbol) + ')' : '';
      svg += '<text x="' + (pad.left + 4) + '" y="' + labelY + '" fill="' + entry.color + '" font-size="10" font-weight="600">' + esc(entry.name) + uSym + (entry.isAux ? ' (dashed)' : '') + '</text>';
      labelY += 12;
    }
  }

  // Count bars at the bottom (only once, below last sub-chart) — primary
  // filled; aux overlaid hollow, each normalized to its own max
  if (display.showCounts) {
    var cbTop = subTop(numGroups - 1) + subH + countGap;
    var maxCount = 0;
    for (var i = 0; i < refBins.length; i++) { if (refBins[i].count > maxCount) maxCount = refBins[i].count; }
    for (var i = 0; i < refBins.length; i++) {
      var bin = refBins[i];
      var bx = sx(bin.center - bw / 2);
      var bwPx = sx(bin.center + bw / 2) - bx;
      var bh = maxCount > 0 ? (bin.count / maxCount) * countBarH : 0;
      svg += '<rect x="' + bx.toFixed(1) + '" y="' + (cbTop + countBarH - bh).toFixed(1) + '" width="' + Math.max(1, bwPx - 1).toFixed(1) + '" height="' + bh.toFixed(1) + '" fill="rgba(240,178,50,0.3)"/>';
    }
    var auxCountRef = null;
    for (var i = 0; i < varEntries.length; i++) {
      if (varEntries[i].isAux) { auxCountRef = varEntries[i]; break; }
    }
    if (auxCountRef && auxCountRef !== refEntry) {
      var auxMax = 0;
      for (var i = 0; i < auxCountRef.bins.length; i++) { if (auxCountRef.bins[i].count > auxMax) auxMax = auxCountRef.bins[i].count; }
      for (var i = 0; i < auxCountRef.bins.length; i++) {
        var abin = auxCountRef.bins[i];
        var abx = sx(abin.center - bw / 2);
        var abwPx = sx(abin.center + bw / 2) - abx;
        var abh = auxMax > 0 ? (abin.count / auxMax) * countBarH : 0;
        svg += '<rect x="' + abx.toFixed(1) + '" y="' + (cbTop + countBarH - abh).toFixed(1) + '" width="' + Math.max(1, abwPx - 1).toFixed(1) + '" height="' + Math.max(0.5, abh).toFixed(1) + '" fill="none" stroke="' + auxCountRef.color + '" stroke-width="0.75" opacity="0.6"/>';
      }
    }
  }

  // X axis labels at the very bottom
  var xLabelY = totalH - pad.bottom + 14;
  var nxLabels = Math.min(10, refBins.length);
  for (var i = 0; i <= nxLabels; i++) {
    var v = xMin + (xRange * i / nxLabels);
    var x = sx(v);
    svg += '<text x="' + x.toFixed(1) + '" y="' + xLabelY + '" text-anchor="middle" fill="var(--chart-ink)" font-size="9">' + formatNum(v) + '</text>';
  }
  var statLabels = { mean_std: 'Mean \u00b1 Std', p25_50_75: 'P25/P50/P75', p10_50_90: 'P10/P50/P90' };
  svg += '<text x="' + (pad.left + plotW / 2) + '" y="' + (xLabelY + 14) + '" text-anchor="middle" fill="var(--chart-ink)" font-size="10">' + getSwathXAxisLabel(swathData) + ' (' + (statLabels[stat] || stat) + ')</text>';

  // Crosshair overlay — spans all sub-charts
  var crosshairTop = pad.top;
  var crosshairBottom = subTop(numGroups - 1) + subH;
  svg += '<rect class="swath-crosshair-area" x="' + pad.left + '" y="' + crosshairTop + '" width="' + plotW + '" height="' + (crosshairBottom - crosshairTop) + '" fill="transparent" cursor="crosshair"/>';
  svg += '<line class="swath-crosshair-line" x1="0" y1="' + crosshairTop + '" x2="0" y2="' + crosshairBottom + '" opacity="0" stroke="var(--fg-dim)" stroke-width="1" stroke-dasharray="3,3" pointer-events="none"/>';
  svg += '<g class="swath-crosshair-tooltip" opacity="0" pointer-events="none">';
  svg += '<rect class="swath-tt-bg" rx="3"/>';
  svg += '<text class="swath-tt-text" font-size="9"/>';
  svg += '</g>';

  return '<svg class="swath-overlay-svg" viewBox="0 0 ' + W + ' ' + totalH + '" xmlns="http://www.w3.org/2000/svg" style="font-family:var(--mono);width:100%;height:100%"' +
    ' data-pad-left="' + pad.left + '" data-pad-right="' + pad.right + '" data-w="' + W + '"' +
    ' data-xmin="' + xMin + '" data-xmax="' + xMax + '" data-plot-w="' + plotW + '">' +
    svg + '</svg>';
}

function wireSwathCrosshair() {
  var svgEl = document.querySelector('.swath-overlay-svg');
  if (!svgEl || !_swathChartParams) return;
  var area = svgEl.querySelector('.swath-crosshair-area');
  var line = svgEl.querySelector('.swath-crosshair-line');
  var ttGroup = svgEl.querySelector('.swath-crosshair-tooltip');
  var ttBg = svgEl.querySelector('.swath-tt-bg');
  var ttText = svgEl.querySelector('.swath-tt-text');
  if (!area || !line || !ttGroup) return;

  var p = _swathChartParams;

  function onMove(e) {
    var pt = svgEl.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    var svgPt = pt.matrixTransform(svgEl.getScreenCTM().inverse());
    var svgX = svgPt.x;
    var coord = p.xMin + ((svgX - p.pad.left) / p.plotW) * (p.xMax - p.xMin);
    if (coord < p.xMin) coord = p.xMin;
    if (coord > p.xMax) coord = p.xMax;

    // Find nearest bin
    var nearestIdx = 0;
    var nearestDist = Infinity;
    for (var i = 0; i < p.refBins.length; i++) {
      var d = Math.abs(p.refBins[i].center - coord);
      if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
    }
    var nearBin = p.refBins[nearestIdx];
    var snapX = p.pad.left + ((nearBin.center - p.xMin) / (p.xMax - p.xMin || 1)) * p.plotW;

    line.setAttribute('x1', snapX.toFixed(1));
    line.setAttribute('x2', snapX.toFixed(1));
    line.setAttribute('opacity', '1');

    // Build tooltip lines
    var lines = [];
    lines.push({ text: p.shortLabel + ': ' + formatNum(nearBin.center), color: 'var(--fg)' });
    lines.push({ text: 'Count: ' + nearBin.count, color: 'var(--fg-dim)' });
    for (var vi = 0; vi < p.varEntries.length; vi++) {
      var entry = p.varEntries[vi];
      // Find the matching bin index for this variable
      var vBin = null;
      for (var bi = 0; bi < entry.bins.length; bi++) {
        if (Math.abs(entry.bins[bi].center - nearBin.center) < p.bw * 0.01) { vBin = bi; break; }
      }
      if (vBin !== null) {
        var center = entry.centerLine[vBin].y;
        var upper = entry.upperLine[vBin].y;
        var lower = entry.lowerLine[vBin].y;
        var uSym = entry.unit && entry.unit.symbol ? ' ' + entry.unit.symbol : '';
        var txt = esc(entry.name) + ': ' + formatNum(center) + uSym + ' [' + formatNum(lower) + ' - ' + formatNum(upper) + ']';
        if (entry.isAux) txt += ' n=' + entry.bins[vBin].count;
        lines.push({ text: txt, color: entry.color });
      }
    }

    var hasAuxEntries = p.varEntries.some(function(en) { return en.isAux; });
    var lineH = 13;
    var ttW = hasAuxEntries ? 215 : 180;
    var ttH = lines.length * lineH + 8;
    var tx = snapX + 12;
    var ty = p.layout === 'split' ? Math.max(p.pad.top, svgPt.y - ttH / 2) : p.pad.top + 10;
    if (ty + ttH > p.H - 10) ty = p.H - ttH - 10;
    if (tx + ttW > p.W - 10) tx = snapX - ttW - 12;

    ttBg.setAttribute('x', tx);
    ttBg.setAttribute('y', ty);
    ttBg.setAttribute('width', ttW);
    ttBg.setAttribute('height', ttH);
    ttBg.setAttribute('fill', 'var(--bg1)');
    ttBg.setAttribute('stroke', 'var(--border)');

    var textHtml = '';
    for (var i = 0; i < lines.length; i++) {
      textHtml += '<tspan x="' + (tx + 6) + '" dy="' + (i === 0 ? (ty + lineH) : lineH) + '" fill="' + lines[i].color + '">' + lines[i].text + '</tspan>';
    }
    ttText.innerHTML = textHtml;
    ttGroup.setAttribute('opacity', '1');
  }

  function onLeave() {
    line.setAttribute('opacity', '0');
    ttGroup.setAttribute('opacity', '0');
  }

  area.addEventListener('pointermove', onMove);
  area.addEventListener('pointerleave', onLeave);
}

function renderSwathTable(varEntries, swathData, stat) {
  var refEntry = varEntries[0];
  for (var ri = 0; ri < varEntries.length; ri++) {
    if (!varEntries[ri].isAux) { refEntry = varEntries[ri]; break; }
  }
  var refBins = refEntry.bins;
  var statLabels = { mean_std: 'Mean \u00b1 Std', p25_50_75: 'P25/P50/P75', p10_50_90: 'P10/P50/P90' };
  var tableTitle = 'Swath Data (' + (statLabels[stat] || stat) + ')';

  // Build header
  var thHtml = '<th>Coord</th><th>Count</th>';
  for (var vi = 0; vi < varEntries.length; vi++) {
    var entry = varEntries[vi];
    var uSuffix = entry.unit && entry.unit.symbol ? ' (' + esc(entry.unit.symbol) + ')' : '';
    if (stat === 'mean_std') {
      thHtml += '<th style="border-bottom-color:' + entry.color + '">' + esc(entry.name) + uSuffix + ' Mean</th>';
      thHtml += '<th style="border-bottom-color:' + entry.color + '">' + esc(entry.name) + uSuffix + ' Std</th>';
    } else if (stat === 'p25_50_75') {
      thHtml += '<th style="border-bottom-color:' + entry.color + '">' + esc(entry.name) + uSuffix + ' P25</th>';
      thHtml += '<th style="border-bottom-color:' + entry.color + '">' + esc(entry.name) + uSuffix + ' P50</th>';
      thHtml += '<th style="border-bottom-color:' + entry.color + '">' + esc(entry.name) + uSuffix + ' P75</th>';
    } else {
      thHtml += '<th style="border-bottom-color:' + entry.color + '">' + esc(entry.name) + uSuffix + ' P10</th>';
      thHtml += '<th style="border-bottom-color:' + entry.color + '">' + esc(entry.name) + uSuffix + ' P50</th>';
      thHtml += '<th style="border-bottom-color:' + entry.color + '">' + esc(entry.name) + uSuffix + ' P90</th>';
    }
    if (entry.isAux) thHtml += '<th style="border-bottom-color:' + entry.color + '">' + esc(entry.name) + ' n</th>';
  }

  // Build rows
  var tbody = '';
  for (var bi = 0; bi < refBins.length; bi++) {
    var rBin = refBins[bi];
    tbody += '<tr><td>' + formatNum(rBin.center) + '</td><td>' + rBin.count + '</td>';
    for (var vi = 0; vi < varEntries.length; vi++) {
      var entry = varEntries[vi];
      // Find matching bin
      var vIdx = null;
      for (var j = 0; j < entry.bins.length; j++) {
        if (Math.abs(entry.bins[j].center - rBin.center) < swathData.binWidth * 0.01) { vIdx = j; break; }
      }
      if (vIdx !== null) {
        if (stat === 'mean_std') {
          tbody += '<td>' + formatNum(entry.centerLine[vIdx].y) + '</td>';
          tbody += '<td>' + formatNum(entry.bins[vIdx].std) + '</td>';
        } else {
          tbody += '<td>' + formatNum(entry.lowerLine[vIdx].y) + '</td>';
          tbody += '<td>' + formatNum(entry.centerLine[vIdx].y) + '</td>';
          tbody += '<td>' + formatNum(entry.upperLine[vIdx].y) + '</td>';
        }
        if (entry.isAux) tbody += '<td>' + entry.bins[vIdx].count + '</td>';
      } else {
        var emptyCols = (stat === 'mean_std' ? 2 : 3) + (entry.isAux ? 1 : 0);
        for (var ec = 0; ec < emptyCols; ec++) tbody += '<td></td>';
      }
    }
    tbody += '</tr>';
  }

  // Collapse state lives in swathTableCollapsed, not the DOM \u2014 the
  // chart-width observers rebuild this area and DOM-only state reopened
  // the table (C6-0)
  return '<div class="swath-table-section">' +
    '<div class="swath-table-header" data-swath-collapse="0">' +
      '<span class="swath-table-toggle">' + (swathTableCollapsed ? '\u25B6' : '\u25BC') + '</span> ' + tableTitle +
      '<button class="swath-copy-btn" data-swath-copy="0">Copy</button>' +
    '</div>' +
    '<div class="swath-table-body" id="swathTableBody0"' + (swathTableCollapsed ? ' style="display:none"' : '') + '>' +
      '<div class="swath-table-wrap">' +
        '<table class="swath-table"><thead><tr>' + thHtml + '</tr></thead><tbody>' + tbody + '</tbody></table>' +
      '</div>' +
    '</div>' +
  '</div>';
}

function wireSwathChartActions() {
  var copySvg = document.getElementById('swathCopySvg');
  var dlPng = document.getElementById('swathDownloadPng');
  var svgEl = document.querySelector('.swath-overlay-svg');
  if (!svgEl) return;

  if (copySvg) {
    copySvg.addEventListener('click', function() {
      navigator.clipboard.writeText(svgEl.outerHTML).then(function() {
        copySvg.textContent = 'Copied!';
        setTimeout(function() { copySvg.textContent = 'Copy SVG'; }, 1500);
      });
    });
  }

  if (dlPng) {
    dlPng.addEventListener('click', function() {
      // Clone and clean for export
      var clone = svgEl.cloneNode(true);
      // Remove interactive crosshair elements
      var area = clone.querySelector('.swath-crosshair-area');
      var crossLine = clone.querySelector('.swath-crosshair-line');
      var ttGroup = clone.querySelector('.swath-crosshair-tooltip');
      if (area) area.remove();
      if (crossLine) crossLine.remove();
      if (ttGroup) ttGroup.remove();
      var svgData = new XMLSerializer().serializeToString(clone);
      // Retheme for light background
      svgData = svgData.replace(/fill="var\(--bg\)"/g, 'fill="white"');
      svgData = svgData.replace(/fill="var\(--bg1\)"/g, 'fill="#f5f5f5"');
      svgData = svgData.replace(/fill="var(--chart-ink)"/g, 'fill="#555"');
      svgData = svgData.replace(/stroke="var(--chart-grid)"/g, 'stroke="#ddd"');
      svgData = svgData.replace(/fill="var\(--fg-dim\)"/g, 'fill="#666"');
      svgData = svgData.replace(/fill="var\(--fg\)"/g, 'fill="#333"');
      svgData = svgData.replace(/stroke="var\(--fg-dim\)"/g, 'stroke="#999"');
      svgData = svgData.replace(/stroke="var\(--border\)"/g, 'stroke="#ddd"');
      svgData = svgData.replace(/style="font-family:var\(--mono\)[^"]*"/g, 'style="font-family:monospace"');
      var canvas = document.createElement('canvas');
      var scale = 2;
      var vb = svgEl.getAttribute('viewBox').split(' ').map(Number);
      canvas.width = vb[2] * scale;
      canvas.height = vb[3] * scale;
      var ctx = canvas.getContext('2d');
      var img = new Image();
      img.onload = function() {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(function(blob) {
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = 'swath_' + ((_swathChartParams && _swathChartParams.dirKey) || 'plot') + '.png';
          a.click();
          URL.revokeObjectURL(url);
        }, 'image/png');
      };
      img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
    });
  }
}

function wireSwathTableEvents() {
  var $content = document.getElementById('swathContent');
  if (!$content) return;

  // Copy button
  $content.querySelectorAll('[data-swath-copy]').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var idx = btn.dataset.swathCopy;
      var table = document.querySelector('#swathTableBody' + idx + ' .swath-table');
      if (!table) return;
      var tsv = [];
      table.querySelectorAll('tr').forEach(function(row) {
        var cells = [];
        row.querySelectorAll('th, td').forEach(function(c) { cells.push(c.textContent); });
        tsv.push(cells.join('\t'));
      });
      navigator.clipboard.writeText(tsv.join('\n')).then(function() {
        btn.textContent = 'Copied!';
        setTimeout(function() { btn.textContent = 'Copy'; }, 1500);
      });
    });
  });

  // Collapsible table header \u2014 state in swathTableCollapsed (C6-0)
  $content.querySelectorAll('[data-swath-collapse]').forEach(function(hdr) {
    hdr.addEventListener('click', function() {
      var idx = hdr.dataset.swathCollapse;
      var body = document.getElementById('swathTableBody' + idx);
      var toggle = hdr.querySelector('.swath-table-toggle');
      if (body.style.display === 'none') {
        body.style.display = '';
        toggle.textContent = '\u25BC';
        swathTableCollapsed = false;
      } else {
        body.style.display = 'none';
        toggle.textContent = '\u25B6';
        swathTableCollapsed = true;
      }
    });
  });
}
