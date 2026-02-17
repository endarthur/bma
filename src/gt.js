// ─── Grade-Tonnage (GT) Tab ──────────────────────────────────────────

const GT_TONNAGE_UNITS = [
  { label: 't',  symbol: 't',  divisor: 1 },
  { label: 'kt', symbol: 'kt', divisor: 1e3 },
  { label: 'Mt', symbol: 'Mt', divisor: 1e6 },
  { label: 'Custom\u2026', symbol: null, divisor: null }
];
const GT_GRADE_UNITS = [
  { label: '(raw)',  symbol: '',     factor: 1 },
  { label: '%',      symbol: '%',    factor: 0.01 },
  { label: 'ppm',    symbol: 'ppm',  factor: 1e-6 },
  { label: 'ppb',    symbol: 'ppb',  factor: 1e-9 },
  { label: 'g/t',    symbol: 'g/t',  factor: 1e-6 },
  { label: 'oz/t',   symbol: 'oz/t', factor: 3.11035e-5 },
  { label: 'Custom\u2026', symbol: null, factor: null }
];

let gtNumCols = [];
let gtCatCols = [];

function renderGtConfig(data) {
  var $sidebar = document.getElementById('gtSidebar');
  var $content = document.getElementById('gtContent');
  if (!$sidebar) return;
  var header = data.header, colTypes = data.colTypes, geometry = data.geometry;

  // Reset cached results
  lastGtData = null;

  // Gather numeric columns (excluding XYZ/DXYZ)
  var excludeSet = new Set();
  if (currentXYZ.x >= 0) excludeSet.add(currentXYZ.x);
  if (currentXYZ.y >= 0) excludeSet.add(currentXYZ.y);
  if (currentXYZ.z >= 0) excludeSet.add(currentXYZ.z);
  if (currentDXYZ.dx >= 0) excludeSet.add(currentDXYZ.dx);
  if (currentDXYZ.dy >= 0) excludeSet.add(currentDXYZ.dy);
  if (currentDXYZ.dz >= 0) excludeSet.add(currentDXYZ.dz);

  gtNumCols = header.map(function(h, i) { return { name: h, idx: i, type: colTypes[i] }; })
    .filter(function(c) { return c.type === 'numeric' && !excludeSet.has(c.idx); });

  gtCatCols = header.map(function(h, i) { return { name: h, idx: i, type: colTypes[i] }; })
    .filter(function(c) { return c.type === 'categorical'; });

  if (gtNumCols.length === 0) {
    $sidebar.innerHTML = '';
    $content.innerHTML = '<div class="gt-hint">No numeric variable columns available for grade-tonnage analysis.</div>';
    return;
  }

  // Auto-detect block volume
  var volDisplay = 'Count-based (1 per row)';
  var volValue = '';
  var hasDXYZ = currentDXYZ.dx >= 0 && currentDXYZ.dy >= 0 && currentDXYZ.dz >= 0;
  if (hasDXYZ) {
    volDisplay = 'Per-row DXYZ columns';
  } else if (geometry && geometry.x && geometry.y && geometry.z &&
             geometry.x.blockSize && geometry.y.blockSize && geometry.z.blockSize) {
    var bv = geometry.x.blockSize * geometry.y.blockSize * geometry.z.blockSize;
    volDisplay = 'Geometry: ' + geometry.x.blockSize + ' \u00d7 ' + geometry.y.blockSize + ' \u00d7 ' + geometry.z.blockSize + ' = ' + formatNum(bv) + ' m\u00b3';
    volValue = bv;
  }

  // Grade variable checkbox list with per-variable unit selects
  var gradeUnitOpts = GT_GRADE_UNITS.slice(0, -1).map(function(u, i) {
    return '<option value="' + i + '">' + esc(u.label) + '</option>';
  }).join('');
  var varItems = gtNumCols.map(function(c, i) {
    return '<label class="gt-var-item"><input type="checkbox" value="' + c.idx + '"' + (i === 0 ? ' checked' : '') + '><span>' + esc(c.name) + '</span>' +
      '<select class="gt-var-unit" data-col="' + c.idx + '">' + gradeUnitOpts + '</select></label>';
  }).join('');

  var densityOpts = '<option value="-1">\u2014 none</option>' + gtNumCols.map(function(c) {
    return '<option value="' + c.idx + '">' + esc(c.name) + '</option>';
  }).join('');
  var weightOpts = densityOpts;

  var tonnageUnitOpts = GT_TONNAGE_UNITS.map(function(u, i) {
    return '<option value="' + i + '">' + esc(u.label) + '</option>';
  }).join('');

  // Group-by dropdown
  var groupByOpts = '<option value="-1">\u2014 none</option>' + gtCatCols.map(function(c) {
    return '<option value="' + c.idx + '">' + esc(c.name) + '</option>';
  }).join('');

  // Default cutoff range from first grade column stats
  var defMin = 0, defMax = 1, defStep = 0.05;
  var firstGrade = gtNumCols[0];
  if (lastCompleteData && lastCompleteData.stats && lastCompleteData.stats[firstGrade.idx]) {
    var gs = lastCompleteData.stats[firstGrade.idx];
    defMin = gs.min != null ? Math.floor(gs.min * 100) / 100 : 0;
    defMax = gs.max != null ? Math.ceil(gs.max * 100) / 100 : 1;
    defStep = +((defMax - defMin) / 20).toPrecision(2) || 0.05;
  }

  $sidebar.innerHTML =
    '<div class="gt-sidebar-section--grow">' +
      '<div class="gt-sidebar-title">Grade Variables</div>' +
      '<input type="text" class="gt-input gt-var-search" id="gtVarSearch" placeholder="search\u2026" spellcheck="false">' +
      '<div class="gt-var-btns"><button id="gtVarAll">All</button><button id="gtVarNone">None</button></div>' +
      '<div class="gt-var-list" id="gtVarList">' + varItems + '</div>' +
    '</div>' +
    '<div class="gt-sidebar-section">' +
      '<div class="gt-sidebar-title">Density (optional)</div>' +
      '<select class="gt-select" id="gtDensityCol">' + densityOpts + '</select>' +
    '</div>' +
    '<div class="gt-sidebar-section">' +
      '<div class="gt-sidebar-title">Weight (optional)</div>' +
      '<select class="gt-select" id="gtWeightCol">' + weightOpts + '</select>' +
    '</div>' +
    '<div class="gt-sidebar-section">' +
      '<div class="gt-sidebar-title">Group by (optional)</div>' +
      '<select class="gt-select" id="gtGroupBy">' + groupByOpts + '</select>' +
      '<div class="gt-group-values" id="gtGroupValues" style="display:none">' +
        '<div class="gt-var-btns"><button id="gtGrpAll">All</button><button id="gtGrpNone">None</button></div>' +
        '<div class="gt-var-list" id="gtGrpList"></div>' +
      '</div>' +
    '</div>' +
    '<div class="gt-sidebar-section">' +
      '<div class="gt-sidebar-title">Block Volume</div>' +
      '<div class="gt-vol-display" id="gtVolDisplay">' + volDisplay + '</div>' +
      '<div style="display:flex;gap:0.3rem;align-items:center;margin-top:0.2rem">' +
        '<span style="font-size:0.55rem;color:var(--fg-dim);white-space:nowrap">Override (m\u00b3)</span>' +
        '<input type="number" class="gt-input" id="gtVolOverride" value="' + volValue + '" min="0" step="any" placeholder="auto">' +
      '</div>' +
    '</div>' +
    '<div class="gt-sidebar-section">' +
      '<div class="gt-sidebar-title">Tonnage Unit</div>' +
      '<select class="gt-select" id="gtTonnageUnit">' + tonnageUnitOpts + '</select>' +
      '<div id="gtCustomTonnageWrap" style="display:none;margin-top:0.3rem">' +
        '<div style="display:flex;gap:0.3rem">' +
          '<input type="text" class="gt-input" id="gtCustomTonnageSym" placeholder="symbol" style="width:50px">' +
          '<input type="number" class="gt-input" id="gtCustomTonnageDiv" placeholder="divisor" step="any">' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="gt-sidebar-section">' +
      '<div class="gt-sidebar-title">Cutoffs</div>' +
      '<div style="margin-bottom:0.3rem">' +
        '<label class="gt-radio-label"><input type="radio" name="gtCutoffMode" value="range" checked> Range</label>' +
        '<label class="gt-radio-label"><input type="radio" name="gtCutoffMode" value="custom"> Custom</label>' +
      '</div>' +
      '<div id="gtCutoffRange">' +
        '<div style="display:flex;gap:0.3rem">' +
          '<label style="flex:1;display:flex;flex-direction:column;gap:0.1rem"><span style="font-size:0.55rem;color:var(--fg-dim)">Min</span><input type="number" class="gt-input" id="gtCutoffMin" value="' + defMin + '" step="any"></label>' +
          '<label style="flex:1;display:flex;flex-direction:column;gap:0.1rem"><span style="font-size:0.55rem;color:var(--fg-dim)">Max</span><input type="number" class="gt-input" id="gtCutoffMax" value="' + defMax + '" step="any"></label>' +
          '<label style="flex:1;display:flex;flex-direction:column;gap:0.1rem"><span style="font-size:0.55rem;color:var(--fg-dim)">Step</span><input type="number" class="gt-input" id="gtCutoffStep" value="' + defStep + '" step="any" min="0"></label>' +
        '</div>' +
      '</div>' +
      '<div id="gtCutoffCustom" style="display:none">' +
        '<input type="text" class="gt-input" id="gtCutoffCustomText" placeholder="0.2, 0.5, 1.0, 2.0, 5.0" spellcheck="false">' +
      '</div>' +
    '</div>' +
    '<div class="gt-sidebar-section">' +
      '<div class="gt-sidebar-title">Local Filter</div>' +
      '<input type="text" class="gt-input" id="gtLocalFilter" placeholder="e.g. r.zone == 1" autocomplete="off" spellcheck="false">' +
    '</div>' +
    '<div class="gt-sidebar-section">' +
      '<button class="gt-generate" id="gtGenerate">Generate</button>' +
      '<div class="gt-progress" id="gtProgress">' +
        '<div class="gt-progress-bar"><div class="gt-progress-fill" id="gtProgressFill"></div></div>' +
        '<div class="gt-progress-label" id="gtProgressLabel"></div>' +
      '</div>' +
    '</div>';

  $content.innerHTML = '<div class="gt-hint">Select grade variables and click Generate.</div>';

  // Wire events — autosave on any sidebar change
  $sidebar.addEventListener('change', function() { autoSaveProject(); });
  $sidebar.addEventListener('input', function(e) {
    if (e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && e.target.type !== 'radio') autoSaveProject();
  });

  var $tonnageUnit = document.getElementById('gtTonnageUnit');

  // Variable search filter
  document.getElementById('gtVarSearch').addEventListener('input', function() {
    var q = this.value.toLowerCase();
    document.querySelectorAll('#gtVarList .gt-var-item').forEach(function(item) {
      var name = item.querySelector('span').textContent.toLowerCase();
      item.style.display = !q || name.indexOf(q) >= 0 ? '' : 'none';
    });
  });

  // All/None buttons for grade variables (only affect visible items)
  document.getElementById('gtVarAll').addEventListener('click', function() {
    document.querySelectorAll('#gtVarList .gt-var-item').forEach(function(item) {
      if (item.style.display !== 'none') item.querySelector('input[type="checkbox"]').checked = true;
    });
  });
  document.getElementById('gtVarNone').addEventListener('click', function() {
    document.querySelectorAll('#gtVarList .gt-var-item').forEach(function(item) {
      if (item.style.display !== 'none') item.querySelector('input[type="checkbox"]').checked = false;
    });
  });

  // Cutoff mode radio
  document.querySelectorAll('input[name="gtCutoffMode"]').forEach(function(r) {
    r.addEventListener('change', function() {
      document.getElementById('gtCutoffRange').style.display = r.value === 'range' ? '' : 'none';
      document.getElementById('gtCutoffCustom').style.display = r.value === 'custom' ? '' : 'none';
    });
  });

  // Unit custom toggles
  $tonnageUnit.addEventListener('change', function() {
    var idx = parseInt($tonnageUnit.value);
    document.getElementById('gtCustomTonnageWrap').style.display = GT_TONNAGE_UNITS[idx].divisor === null ? '' : 'none';
    if (lastGtData) renderGtOutput();
  });
  // Per-variable grade unit change — re-render if results exist
  document.getElementById('gtVarList').addEventListener('change', function(e) {
    if (e.target.classList.contains('gt-var-unit') && lastGtData) renderGtOutput();
  });

  // Group-by dropdown change — populate group value checkboxes
  document.getElementById('gtGroupBy').addEventListener('change', function() {
    updateGroupByValues();
  });

  // Group value All/None buttons
  document.getElementById('gtGrpAll').addEventListener('click', function() {
    document.querySelectorAll('#gtGrpList input[type="checkbox"]').forEach(function(cb) { cb.checked = true; });
    if (lastGtData) renderGtOutput();
  });
  document.getElementById('gtGrpNone').addEventListener('click', function() {
    document.querySelectorAll('#gtGrpList input[type="checkbox"]').forEach(function(cb) { cb.checked = false; });
    if (lastGtData) renderGtOutput();
  });

  // Group value checkbox change — re-render
  document.getElementById('gtGrpList').addEventListener('change', function() {
    if (lastGtData) renderGtOutput();
  });

  // Generate button
  document.getElementById('gtGenerate').addEventListener('click', runGt);

  // Local filter autocomplete
  if (gtExprController) gtExprController.destroy();
  gtExprController = createExprInput(document.getElementById('gtLocalFilter'), { mode: 'filter' });
}

function updateGroupByValues() {
  var $wrap = document.getElementById('gtGroupValues');
  var $list = document.getElementById('gtGrpList');
  var colIdx = parseInt(document.getElementById('gtGroupBy').value);
  if (colIdx < 0 || !lastCompleteData || !lastCompleteData.categories) {
    $wrap.style.display = 'none';
    $list.innerHTML = '';
    return;
  }
  var catEntry = lastCompleteData.categories[colIdx];
  if (!catEntry || !catEntry.counts) { $wrap.style.display = 'none'; return; }
  var cats = catEntry.counts;
  var colName = currentHeader[colIdx] || '';
  var values = Object.keys(cats);
  // Use custom order if available
  if (catCustomOrders[colName]) {
    var orderedSet = new Set(catCustomOrders[colName]);
    var ordered = catCustomOrders[colName].filter(function(v) { return cats[v] != null; });
    var rest = values.filter(function(v) { return !orderedSet.has(v); }).sort();
    values = ordered.concat(rest);
  } else {
    values.sort();
  }
  var html = '<label class="gt-var-item"><input type="checkbox" value="__total__" checked><span>Total (all)</span></label>';
  for (var i = 0; i < values.length; i++) {
    html += '<label class="gt-var-item"><input type="checkbox" value="' + esc(values[i]) + '" checked><span>' + esc(values[i]) + '</span></label>';
  }
  $list.innerHTML = html;
  $wrap.style.display = '';
}

function getGtTonnageUnit() {
  var tIdx = parseInt(document.getElementById('gtTonnageUnit').value);
  var tu = GT_TONNAGE_UNITS[tIdx] || GT_TONNAGE_UNITS[0];
  var tonnageDivisor = tu.divisor;
  var tonnageSymbol = tu.symbol;
  if (tonnageDivisor === null) {
    tonnageSymbol = document.getElementById('gtCustomTonnageSym').value || 'units';
    tonnageDivisor = parseFloat(document.getElementById('gtCustomTonnageDiv').value) || 1;
  }
  return { tonnageDivisor: tonnageDivisor, tonnageSymbol: tonnageSymbol, metalSymbol: tonnageSymbol };
}

function getGtGradeUnit(colIdx) {
  var sel = document.querySelector('.gt-var-unit[data-col="' + colIdx + '"]');
  var idx = sel ? parseInt(sel.value) : 0;
  var gu = GT_GRADE_UNITS[idx] || GT_GRADE_UNITS[0];
  return { gradeFactor: gu.factor, gradeSymbol: gu.symbol };
}

function getGtCutoffs() {
  var mode = document.querySelector('input[name="gtCutoffMode"]:checked').value;
  var cutoffs = [];
  if (mode === 'range') {
    var mn = parseFloat(document.getElementById('gtCutoffMin').value);
    var mx = parseFloat(document.getElementById('gtCutoffMax').value);
    var step = parseFloat(document.getElementById('gtCutoffStep').value);
    if (!isFinite(mn) || !isFinite(mx) || !isFinite(step) || step <= 0) return [];
    for (var v = mn; v <= mx + step * 0.001; v += step) {
      cutoffs.push(+v.toPrecision(10));
    }
  } else {
    var txt = document.getElementById('gtCutoffCustomText').value;
    txt.split(/[,;\s]+/).forEach(function(s) {
      var v = parseFloat(s.trim());
      if (isFinite(v)) cutoffs.push(v);
    });
    cutoffs.sort(function(a, b) { return a - b; });
  }
  return cutoffs;
}

function getGtCheckedGradeCols() {
  var checked = [];
  document.querySelectorAll('#gtVarList input[type="checkbox"]:checked').forEach(function(cb) {
    checked.push(parseInt(cb.value));
  });
  return checked;
}

function runGt() {
  if (gtExprController) { var r = gtExprController.validate(); if (!r.valid) return; }
  var gradeCols = getGtCheckedGradeCols();
  if (gradeCols.length === 0) return;

  var densityCol = parseInt(document.getElementById('gtDensityCol').value);
  var weightCol = parseInt(document.getElementById('gtWeightCol').value);
  var groupByCol = parseInt(document.getElementById('gtGroupBy').value);
  var localFilter = document.getElementById('gtLocalFilter').value.trim();
  var volOverride = parseFloat(document.getElementById('gtVolOverride').value);

  // Compute per-variable grade ranges from stats
  var gradeRanges = [];
  for (var i = 0; i < gradeCols.length; i++) {
    var gc = gradeCols[i];
    var gradeMin = 0, gradeMax = 1;
    if (lastCompleteData && lastCompleteData.stats && lastCompleteData.stats[gc]) {
      var gs = lastCompleteData.stats[gc];
      gradeMin = gs.min != null ? gs.min : 0;
      gradeMax = gs.max != null ? gs.max : 1;
    }
    var range = gradeMax - gradeMin;
    if (range <= 0) range = 1;
    gradeMin -= range * 0.001;
    gradeMax += range * 0.001;
    gradeRanges.push({ min: gradeMin, max: gradeMax });
  }

  // Determine block volume
  var blockVolume = 0;
  var dxyzCols = null;
  var hasDXYZ = currentDXYZ.dx >= 0 && currentDXYZ.dy >= 0 && currentDXYZ.dz >= 0;
  if (isFinite(volOverride) && volOverride > 0) {
    blockVolume = volOverride;
  } else if (hasDXYZ) {
    dxyzCols = [currentDXYZ.dx, currentDXYZ.dy, currentDXYZ.dz];
  } else if (lastCompleteData && lastCompleteData.geometry) {
    var geo = lastCompleteData.geometry;
    if (geo.x && geo.y && geo.z && geo.x.blockSize && geo.y.blockSize && geo.z.blockSize) {
      blockVolume = geo.x.blockSize * geo.y.blockSize * geo.z.blockSize;
    }
  }

  if (gtWorker) gtWorker.terminate();
  gtWorker = new Worker(workerUrl);

  var $progress = document.getElementById('gtProgress');
  var $fill = document.getElementById('gtProgressFill');
  var $label = document.getElementById('gtProgressLabel');
  var $content = document.getElementById('gtContent');
  $progress.classList.add('active');
  $fill.style.width = '0%';
  $label.textContent = '0%';
  $content.innerHTML = '';

  var $btn = document.getElementById('gtGenerate');
  if ($btn) $btn.disabled = true;

  var resolvedTypes = currentColTypes.slice(0, currentOrigColCount);
  var filterPayload = currentFilter ? { expression: currentFilter.expression } : null;
  var zipEntry = preflightData ? (preflightData.selectedZipEntry || null) : null;

  gtWorker.postMessage({
    mode: 'gt',
    file: currentFile,
    zipEntry: zipEntry,
    globalFilter: filterPayload,
    localFilter: localFilter || null,
    calcolCode: currentCalcolCode || null,
    calcolMeta: currentCalcolMeta.length > 0 ? currentCalcolMeta : null,
    resolvedTypes: resolvedTypes,
    gradeCols: gradeCols,
    gradeRanges: gradeRanges,
    densityCol: densityCol >= 0 ? densityCol : null,
    weightCol: weightCol >= 0 ? weightCol : null,
    dxyzCols: dxyzCols,
    blockVolume: blockVolume,
    groupByCol: groupByCol >= 0 ? groupByCol : null
  });

  gtWorker.onmessage = function(e) {
    var m = e.data;
    if (m.type === 'gt-progress') {
      var pct = Math.min(99, m.percent);
      $fill.style.width = pct.toFixed(1) + '%';
      $label.textContent = pct.toFixed(0) + '%';
    } else if (m.type === 'gt-complete') {
      $fill.style.width = '100%';
      $label.textContent = 'Done';
      setTimeout(function() { $progress.classList.remove('active'); }, 800);
      if ($btn) $btn.disabled = false;
      lastGtData = m;
      renderGtOutput();
      // Update tab badge with first variable total tonnage
      var gtTab = document.querySelector('.results-tab[data-tab="gt"]');
      if (gtTab && m.gradeResults && m.gradeResults.length > 0) {
        gtTab.innerHTML = 'GT <span class="tab-badge">' + formatNum(m.gradeResults[0].totalTonnage) + '</span>';
      }
      gtWorker.terminate();
      gtWorker = null;
    } else if (m.type === 'error') {
      $label.textContent = 'Error: ' + m.message;
      setTimeout(function() { $progress.classList.remove('active'); }, 2000);
      if ($btn) $btn.disabled = false;
      gtWorker.terminate();
      gtWorker = null;
    }
  };
}

function renderGtOutput() {
  if (!lastGtData || !lastGtData.gradeResults) return;
  var $content = document.getElementById('gtContent');
  if (!$content) return;
  var cutoffs = getGtCutoffs();
  var tonnageUnit = getGtTonnageUnit();
  if (cutoffs.length === 0) {
    $content.innerHTML = '<div class="gt-hint">No valid cutoffs defined.</div>';
    return;
  }

  // Determine which groups are selected (if grouped)
  var selectedGroups = new Set();
  var showTotal = false;
  var isGrouped = lastGtData.grouped;
  if (isGrouped) {
    document.querySelectorAll('#gtGrpList input:checked').forEach(function(cb) {
      if (cb.value === '__total__') showTotal = true;
      else selectedGroups.add(cb.value);
    });
  }

  var gradeResults = lastGtData.gradeResults;
  var html = '<div class="gt-toolbar"><span class="gt-elapsed">' + (lastGtData.elapsed / 1000).toFixed(1) + 's</span></div>';

  for (var gi = 0; gi < gradeResults.length; gi++) {
    var gr = gradeResults[gi];
    var gradeUnit = getGtGradeUnit(gr.colIdx);
    var units = {
      tonnageDivisor: tonnageUnit.tonnageDivisor,
      tonnageSymbol: tonnageUnit.tonnageSymbol,
      metalSymbol: tonnageUnit.metalSymbol,
      gradeFactor: gradeUnit.gradeFactor,
      gradeSymbol: gradeUnit.gradeSymbol
    };
    if (gradeResults.length > 1) {
      html += '<div class="gt-chart-title">' + esc(gr.colName) + (units.gradeSymbol ? ' (' + esc(units.gradeSymbol) + ')' : '') + '</div>';
    }
    html += '<div class="gt-chart-wrap">' + renderGtChart(gr, cutoffs, units, isGrouped, gi, selectedGroups, showTotal) + '</div>';
    // Collapsible table with per-table copy button
    var tableTitle = gradeResults.length > 1 ? esc(gr.colName) + (units.gradeSymbol ? ' (' + esc(units.gradeSymbol) + ')' : '') : 'Table';
    html += '<div class="gt-table-section">' +
      '<div class="gt-table-header" data-gt-collapse="' + gi + '">' +
        '<span class="gt-table-toggle">\u25BC</span> ' + tableTitle +
        '<button class="gt-copy-btn" data-gt-copy="' + gi + '">Copy</button>' +
      '</div>' +
      '<div class="gt-table-body" id="gtTableBody' + gi + '">' +
        '<div class="gt-table-wrap">' + renderGtTable(gr, cutoffs, units, isGrouped, gi, selectedGroups, showTotal) + '</div>' +
      '</div>' +
    '</div>';
  }

  $content.innerHTML = html;

  // Wire per-table copy buttons
  $content.querySelectorAll('[data-gt-copy]').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var idx = btn.dataset.gtCopy;
      var table = document.querySelector('#gtTableBody' + idx + ' .gt-table');
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

  // Wire collapsible table headers
  $content.querySelectorAll('[data-gt-collapse]').forEach(function(hdr) {
    hdr.addEventListener('click', function() {
      var idx = hdr.dataset.gtCollapse;
      var body = document.getElementById('gtTableBody' + idx);
      var toggle = hdr.querySelector('.gt-table-toggle');
      if (body.style.display === 'none') {
        body.style.display = '';
        toggle.textContent = '\u25BC';
      } else {
        body.style.display = 'none';
        toggle.textContent = '\u25B6';
      }
    });
  });

  // Wire crosshairs for each chart
  for (var ci = 0; ci < gradeResults.length; ci++) {
    var chGradeUnit = getGtGradeUnit(gradeResults[ci].colIdx);
    var chUnits = {
      tonnageDivisor: tonnageUnit.tonnageDivisor,
      tonnageSymbol: tonnageUnit.tonnageSymbol,
      metalSymbol: tonnageUnit.metalSymbol,
      gradeFactor: chGradeUnit.gradeFactor,
      gradeSymbol: chGradeUnit.gradeSymbol
    };
    wireGtCrosshair(gradeResults[ci], cutoffs, chUnits, ci);
  }
}

function interpolateGt(results, cutoff, binWidth, gradeMin) {
  var zero = { tonnage: 0, grade: 0, metal: 0 };
  if (!results || results.length === 0) return zero;
  if (!binWidth || !isFinite(binWidth)) return results[0] || zero;
  var idx = (cutoff - gradeMin) / binWidth;
  if (!isFinite(idx)) return results[0] || zero;
  var lo = Math.floor(idx);
  if (lo < 0) lo = 0;
  if (lo >= results.length) lo = results.length - 1;
  var hi = lo + 1;
  if (hi >= results.length) hi = results.length - 1;
  if (lo === hi) return results[lo] || zero;
  var a = results[lo], b = results[hi];
  if (!a || !b) return a || b || zero;
  var frac = idx - lo;
  return {
    tonnage: a.tonnage + (b.tonnage - a.tonnage) * frac,
    grade: a.grade + (b.grade - a.grade) * frac,
    metal: a.metal + (b.metal - a.metal) * frac
  };
}

function renderGtChart(grData, cutoffs, units, isGrouped, chartIdx, selectedGroups, showTotal) {
  var results = grData.results;
  if (!results || results.length === 0) return '<div class="gt-hint">No GT data available.</div>';
  var binWidth = grData.binWidth;
  var gradeMin = grData.gradeMin;
  var totalTonnage = grData.totalTonnage;
  var td = units.tonnageDivisor || 1;
  var gf = units.gradeFactor || 1;
  var clipId = 'gt-clip-' + chartIdx;

  // Determine if we render grouped overlay
  var groupResults = isGrouped && grData.groupResults ? grData.groupResults : null;
  var allGroupNames = groupResults ? Object.keys(groupResults).sort() : [];
  // Filter to selected groups
  var groupNames = allGroupNames;
  if (groupResults && selectedGroups && selectedGroups.size > 0) {
    groupNames = allGroupNames.filter(function(n) { return selectedGroups.has(n); });
  } else if (groupResults && selectedGroups && selectedGroups.size === 0 && !showTotal) {
    groupNames = [];
  }

  // Sample curve at cutoffs (overall)
  var points = cutoffs.map(function(c) {
    var p = interpolateGt(results, c, binWidth, gradeMin);
    return { cutoff: c, tonnage: p.tonnage / td, grade: p.grade, metal: p.metal * gf / td };
  });

  var W = 720, H = 380;
  var pad = { top: 30, right: 75, bottom: 50, left: 75 };
  var plotW = W - pad.left - pad.right;
  var plotH = H - pad.top - pad.bottom;

  // Tonnage range (left Y)
  var tMin = 0, tMax = Math.max.apply(null, points.map(function(p) { return p.tonnage; })) || 1;
  tMax += tMax * 0.05;

  // Grade range (right Y) — only from points with tonnage > 0
  var validGrades = points.filter(function(p) { return p.tonnage > 0; }).map(function(p) { return p.grade; });
  if (validGrades.length === 0) validGrades = [0, 1];
  var gMin = Math.min.apply(null, validGrades);
  var gMax = Math.max.apply(null, validGrades);
  if (gMin === gMax) { gMin -= 0.5; gMax += 0.5; }
  var gPadding = (gMax - gMin) * 0.05;
  gMin -= gPadding; gMax += gPadding;
  if (gMin < 0) gMin = 0;

  // X range
  var xMin = cutoffs[0], xMax = cutoffs[cutoffs.length - 1];
  var xRange = xMax - xMin || 1;

  var sx = function(v) { return pad.left + ((v - xMin) / xRange) * plotW; };
  var syT = function(v) { return pad.top + ((tMax - v) / (tMax - tMin)) * plotH; };
  var syG = function(v) { return pad.top + ((gMax - v) / (gMax - gMin)) * plotH; };

  // Grid
  var svg = '';
  var nxTicks = Math.min(10, cutoffs.length);
  for (var i = 0; i <= nxTicks; i++) {
    var v = xMin + (xRange * i / nxTicks);
    var x = sx(v);
    svg += '<line x1="' + x.toFixed(1) + '" y1="' + pad.top + '" x2="' + x.toFixed(1) + '" y2="' + (H - pad.bottom) + '" stroke="#1e2228" stroke-width="1"/>';
    svg += '<text x="' + x.toFixed(1) + '" y="' + (H - pad.bottom + 14) + '" text-anchor="middle" fill="#6a737d" font-size="9">' + formatNum(v) + '</text>';
  }
  var nyTicks = 6;
  for (var j = 0; j <= nyTicks; j++) {
    var tv = tMin + ((tMax - tMin) * j / nyTicks);
    var y = syT(tv);
    svg += '<line x1="' + pad.left + '" y1="' + y.toFixed(1) + '" x2="' + (W - pad.right) + '" y2="' + y.toFixed(1) + '" stroke="#1e2228" stroke-width="1"/>';
    svg += '<text x="' + (pad.left - 6) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end" fill="var(--amber)" font-size="9">' + formatNum(tv) + '</text>';
    var gv = gMin + ((gMax - gMin) * j / nyTicks);
    svg += '<text x="' + (W - pad.right + 6) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="start" fill="var(--blue)" font-size="9">' + formatNum(gv) + '</text>';
  }

  // Clip path
  svg += '<defs><clipPath id="' + clipId + '"><rect x="' + pad.left + '" y="' + pad.top + '" width="' + plotW + '" height="' + plotH + '"/></clipPath></defs>';
  svg += '<g clip-path="url(#' + clipId + ')">';

  if (groupNames.length > 0 || (isGrouped && showTotal)) {
    // "Total" line from overall results
    if (showTotal) {
      var tTotalP = '';
      var gTotalP = '';
      for (var ti = 0; ti < points.length; ti++) {
        tTotalP += (ti === 0 ? 'M' : 'L') + sx(points[ti].cutoff).toFixed(1) + ',' + syT(points[ti].tonnage).toFixed(1);
        if (points[ti].tonnage > 0) {
          gTotalP += (gTotalP ? 'L' : 'M') + sx(points[ti].cutoff).toFixed(1) + ',' + syG(points[ti].grade).toFixed(1);
        }
      }
      svg += '<path d="' + tTotalP + '" fill="none" stroke="var(--amber)" stroke-width="2.5" opacity="0.7"/>';
      if (gTotalP) svg += '<path d="' + gTotalP + '" fill="none" stroke="var(--blue)" stroke-width="2" stroke-dasharray="4,3" opacity="0.7"/>';
    }
    // Grouped overlay: draw tonnage + grade per group with colors
    for (var gi = 0; gi < groupNames.length; gi++) {
      var gn = groupNames[gi];
      var grd = groupResults[gn];
      var colorIdx = allGroupNames.indexOf(gn);
      var color = getCategoryColor(lastGtData.groupByColName || '', gn, colorIdx >= 0 ? colorIdx : gi);
      var grpPts = cutoffs.map(function(c) {
        var p = interpolateGt(grd.results, c, binWidth, gradeMin);
        return { cutoff: c, tonnage: p.tonnage / td, grade: p.grade };
      });
      // Tonnage line (solid)
      var tP = '';
      for (var k = 0; k < grpPts.length; k++) {
        tP += (k === 0 ? 'M' : 'L') + sx(grpPts[k].cutoff).toFixed(1) + ',' + syT(grpPts[k].tonnage).toFixed(1);
      }
      svg += '<path d="' + tP + '" fill="none" stroke="' + color + '" stroke-width="1.5"/>';
      // Grade line (dashed) — clip where tonnage is 0
      var gP = '';
      for (var l = 0; l < grpPts.length; l++) {
        if (grpPts[l].tonnage > 0) {
          gP += (gP ? 'L' : 'M') + sx(grpPts[l].cutoff).toFixed(1) + ',' + syG(grpPts[l].grade).toFixed(1);
        }
      }
      if (gP) svg += '<path d="' + gP + '" fill="none" stroke="' + color + '" stroke-width="1" stroke-dasharray="4,3"/>';
    }
  } else {
    // Ungrouped: standard tonnage + grade + metal lines
    var tPath = '';
    for (var k = 0; k < points.length; k++) {
      tPath += (k === 0 ? 'M' : 'L') + sx(points[k].cutoff).toFixed(1) + ',' + syT(points[k].tonnage).toFixed(1);
    }
    svg += '<path d="' + tPath + '" fill="none" stroke="var(--amber)" stroke-width="2"/>';

    var gPath = '';
    for (var l = 0; l < points.length; l++) {
      if (points[l].tonnage > 0) {
        gPath += (gPath ? 'L' : 'M') + sx(points[l].cutoff).toFixed(1) + ',' + syG(points[l].grade).toFixed(1);
      }
    }
    if (gPath) svg += '<path d="' + gPath + '" fill="none" stroke="var(--blue)" stroke-width="2"/>';

    var mMax = Math.max.apply(null, points.map(function(p) { return p.metal; })) || 1;
    var syM = function(v) { return pad.top + ((mMax - v) / mMax) * plotH; };
    var mPath = '';
    for (var n = 0; n < points.length; n++) {
      mPath += (n === 0 ? 'M' : 'L') + sx(points[n].cutoff).toFixed(1) + ',' + syM(points[n].metal).toFixed(1);
    }
    svg += '<path d="' + mPath + '" fill="none" stroke="var(--green)" stroke-width="1.5" stroke-dasharray="4,3"/>';
  }

  svg += '</g>'; // close clip group

  // Axis labels
  svg += '<text x="' + (W / 2) + '" y="' + (H - 6) + '" text-anchor="middle" fill="#6a737d" font-size="10">Cutoff' + (units.gradeSymbol ? ' (' + esc(units.gradeSymbol) + ')' : '') + '</text>';
  svg += '<text x="12" y="' + (H / 2) + '" text-anchor="middle" fill="var(--amber)" font-size="10" transform="rotate(-90, 12, ' + (H / 2) + ')">Tonnage (' + esc(units.tonnageSymbol) + ')</text>';
  svg += '<text x="' + (W - 8) + '" y="' + (H / 2) + '" text-anchor="middle" fill="var(--blue)" font-size="10" transform="rotate(90, ' + (W - 8) + ', ' + (H / 2) + ')">Grade' + (units.gradeSymbol ? ' (' + esc(units.gradeSymbol) + ')' : '') + '</text>';

  // Legend
  if (groupNames.length > 0 || (isGrouped && showTotal)) {
    var legY = pad.top + 6;
    if (showTotal) {
      svg += '<rect x="' + (pad.left + 10) + '" y="' + legY + '" width="10" height="3" fill="var(--amber)" rx="1" opacity="0.7"/>';
      svg += '<text x="' + (pad.left + 24) + '" y="' + (legY + 4) + '" fill="var(--amber)" font-size="7">Total</text>';
      legY += 11;
    }
    for (var gi = 0; gi < Math.min(groupNames.length, 15); gi++) {
      var gn = groupNames[gi];
      var colorIdx = allGroupNames.indexOf(gn);
      var color = getCategoryColor(lastGtData.groupByColName || '', gn, colorIdx >= 0 ? colorIdx : gi);
      svg += '<rect x="' + (pad.left + 10) + '" y="' + legY + '" width="10" height="3" fill="' + color + '" rx="1"/>';
      svg += '<text x="' + (pad.left + 24) + '" y="' + (legY + 4) + '" fill="' + color + '" font-size="7">' + esc(gn) + '</text>';
      legY += 11;
    }
    if (groupNames.length > 15) {
      svg += '<text x="' + (pad.left + 24) + '" y="' + (legY + 4) + '" fill="var(--fg-dim)" font-size="7">+' + (groupNames.length - 15) + ' more</text>';
    }
  } else {
    svg += '<rect x="' + (pad.left + 10) + '" y="' + (pad.top + 6) + '" width="10" height="3" fill="var(--amber)" rx="1"/>';
    svg += '<text x="' + (pad.left + 24) + '" y="' + (pad.top + 10) + '" fill="var(--amber)" font-size="8">Tonnage</text>';
    svg += '<rect x="' + (pad.left + 10) + '" y="' + (pad.top + 18) + '" width="10" height="3" fill="var(--blue)" rx="1"/>';
    svg += '<text x="' + (pad.left + 24) + '" y="' + (pad.top + 22) + '" fill="var(--blue)" font-size="8">Grade</text>';
    svg += '<line x1="' + (pad.left + 10) + '" y1="' + (pad.top + 31.5) + '" x2="' + (pad.left + 20) + '" y2="' + (pad.top + 31.5) + '" stroke="var(--green)" stroke-width="1.5" stroke-dasharray="3,2"/>';
    svg += '<text x="' + (pad.left + 24) + '" y="' + (pad.top + 34) + '" fill="var(--green)" font-size="8">Metal</text>';
  }

  // Crosshair overlay area
  svg += '<rect class="gt-crosshair-area" x="' + pad.left + '" y="' + pad.top + '" width="' + plotW + '" height="' + plotH + '" fill="transparent"/>';
  svg += '<line class="gt-crosshair-line" x1="0" y1="' + pad.top + '" x2="0" y2="' + (H - pad.bottom) + '" stroke="var(--fg-dim)" stroke-width="1" opacity="0" stroke-dasharray="3,3"/>';
  svg += '<g class="gt-crosshair-tooltip" opacity="0"><rect class="gt-tt-bg" rx="3" ry="3"/><text class="gt-tt-text" font-size="9"></text></g>';

  return '<svg class="gt-svg" data-chart-idx="' + chartIdx + '" viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" style="font-family:var(--mono);width:100%;height:auto" ' +
    'data-pad-left="' + pad.left + '" data-pad-right="' + pad.right + '" data-pad-top="' + pad.top + '" data-pad-bottom="' + pad.bottom + '" ' +
    'data-w="' + W + '" data-h="' + H + '" data-xmin="' + xMin + '" data-xmax="' + xMax + '">' +
    '<rect width="' + W + '" height="' + H + '" fill="var(--bg)" rx="4"/>' +
    svg +
    '</svg>';
}

function wireGtCrosshair(grData, cutoffs, units, chartIdx) {
  var svgEl = document.querySelector('.gt-svg[data-chart-idx="' + chartIdx + '"]');
  if (!svgEl) return;
  var area = svgEl.querySelector('.gt-crosshair-area');
  var line = svgEl.querySelector('.gt-crosshair-line');
  var ttGroup = svgEl.querySelector('.gt-crosshair-tooltip');
  var ttBg = svgEl.querySelector('.gt-tt-bg');
  var ttText = svgEl.querySelector('.gt-tt-text');
  if (!area || !line || !ttGroup) return;

  var padLeft = parseFloat(svgEl.dataset.padLeft);
  var W = parseFloat(svgEl.dataset.w);
  var xMin = parseFloat(svgEl.dataset.xmin);
  var xMax = parseFloat(svgEl.dataset.xmax);
  var padRight = parseFloat(svgEl.dataset.padRight);
  var plotW = W - padLeft - padRight;

  function onMove(e) {
    var pt = svgEl.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    var svgX = pt.matrixTransform(svgEl.getScreenCTM().inverse()).x;
    var cutoff = xMin + ((svgX - padLeft) / plotW) * (xMax - xMin);
    if (cutoff < xMin) cutoff = xMin;
    if (cutoff > xMax) cutoff = xMax;

    var p = interpolateGt(grData.results, cutoff, grData.binWidth, grData.gradeMin);
    var td = units.tonnageDivisor;
    var gf = units.gradeFactor;
    var tonnage = p.tonnage / td;
    var grade = p.grade;
    var metal = p.metal * gf / td;
    var pctTotal = grData.totalTonnage > 0 ? (p.tonnage / grData.totalTonnage * 100) : 0;

    line.setAttribute('x1', svgX.toFixed(1));
    line.setAttribute('x2', svgX.toFixed(1));
    line.setAttribute('opacity', '1');

    var lines = [
      'Cutoff: ' + formatNum(cutoff),
      'Tonnage: ' + formatNum(tonnage) + ' ' + units.tonnageSymbol,
      'Grade: ' + formatNum(grade) + (units.gradeSymbol ? ' ' + units.gradeSymbol : ''),
      'Metal: ' + formatNum(metal) + ' ' + units.metalSymbol,
      '% Total: ' + pctTotal.toFixed(1) + '%'
    ];

    var lineH = 13;
    var ttW = 140;
    var ttH = lines.length * lineH + 8;
    var tx = svgX + 10;
    var ty = 40;
    if (tx + ttW > W - 10) tx = svgX - ttW - 10;

    ttBg.setAttribute('x', tx);
    ttBg.setAttribute('y', ty);
    ttBg.setAttribute('width', ttW);
    ttBg.setAttribute('height', ttH);
    ttBg.setAttribute('fill', 'var(--bg1)');
    ttBg.setAttribute('stroke', 'var(--border)');

    var textHtml = '';
    for (var i = 0; i < lines.length; i++) {
      textHtml += '<tspan x="' + (tx + 6) + '" dy="' + (i === 0 ? (ty + lineH) : lineH) + '" fill="var(--fg)">' + esc(lines[i]) + '</tspan>';
    }
    ttText.innerHTML = textHtml;
    ttGroup.setAttribute('opacity', '1');
  }

  function onLeave() {
    line.setAttribute('opacity', '0');
    ttGroup.setAttribute('opacity', '0');
  }

  area.addEventListener('mousemove', onMove);
  area.addEventListener('mouseleave', onLeave);
}

function renderGtTable(grData, cutoffs, units, isGrouped, tableIdx, selectedGroups, showTotal) {
  var results = grData.results;
  var binWidth = grData.binWidth;
  var gradeMin = grData.gradeMin;
  var totalTonnage = grData.totalTonnage;
  var td = units.tonnageDivisor;
  var gf = units.gradeFactor;
  var groupResults = isGrouped && grData.groupResults ? grData.groupResults : null;
  var allGroupNames = groupResults ? Object.keys(groupResults).sort() : [];
  var groupNames = allGroupNames;
  if (groupResults && selectedGroups && selectedGroups.size > 0) {
    groupNames = allGroupNames.filter(function(n) { return selectedGroups.has(n); });
  } else if (groupResults && selectedGroups && selectedGroups.size === 0 && !showTotal) {
    groupNames = [];
  }

  var hasGroupCol = groupNames.length > 0 || (isGrouped && showTotal);
  var gradeLabel = 'Grade' + (units.gradeSymbol ? ' (' + esc(units.gradeSymbol) + ')' : '');
  var html = '<table class="gt-table" id="gtResultTable' + tableIdx + '">';
  html += '<thead><tr>';
  if (hasGroupCol) html += '<th>Group</th>';
  html += '<th>Cutoff' + (units.gradeSymbol ? ' (' + esc(units.gradeSymbol) + ')' : '') + '</th>';
  html += '<th>Tonnage (' + esc(units.tonnageSymbol) + ')</th>';
  html += '<th>' + gradeLabel + '</th>';
  html += '<th>Metal (' + esc(units.metalSymbol) + ')</th>';
  html += '<th>% Total</th>';
  html += '</tr></thead><tbody>';

  if (hasGroupCol) {
    // "Total" block first if requested
    if (showTotal) {
      for (var ti = 0; ti < cutoffs.length; ti++) {
        var c = cutoffs[ti];
        var p = interpolateGt(results, c, binWidth, gradeMin);
        var tonnage = p.tonnage / td;
        var grade = p.grade;
        var metal = p.metal * gf / td;
        var pctTotal = totalTonnage > 0 ? (p.tonnage / totalTonnage * 100) : 0;
        html += '<tr>';
        if (ti === 0) html += '<td rowspan="' + cutoffs.length + '" style="color:var(--amber);font-weight:600">Total</td>';
        html += '<td>' + formatNum(c) + '</td>';
        html += '<td>' + formatNum(tonnage) + '</td>';
        html += '<td>' + formatNum(grade) + '</td>';
        html += '<td>' + formatNum(metal) + '</td>';
        html += '<td>' + pctTotal.toFixed(1) + '%</td>';
        html += '</tr>';
      }
    }
    // Grouped table: rows grouped by group value then cutoff
    for (var gi = 0; gi < groupNames.length; gi++) {
      var gn = groupNames[gi];
      var grd = groupResults[gn];
      for (var ci = 0; ci < cutoffs.length; ci++) {
        var c = cutoffs[ci];
        var p = interpolateGt(grd.results, c, binWidth, gradeMin);
        var tonnage = p.tonnage / td;
        var grade = p.grade;
        var metal = p.metal * gf / td;
        var pctTotal = grd.totalTonnage > 0 ? (p.tonnage / grd.totalTonnage * 100) : 0;
        html += '<tr>';
        if (ci === 0) html += '<td rowspan="' + cutoffs.length + '">' + esc(gn) + '</td>';
        html += '<td>' + formatNum(c) + '</td>';
        html += '<td>' + formatNum(tonnage) + '</td>';
        html += '<td>' + formatNum(grade) + '</td>';
        html += '<td>' + formatNum(metal) + '</td>';
        html += '<td>' + pctTotal.toFixed(1) + '%</td>';
        html += '</tr>';
      }
    }
  } else {
    // Ungrouped table
    for (var i = 0; i < cutoffs.length; i++) {
      var c = cutoffs[i];
      var p = interpolateGt(results, c, binWidth, gradeMin);
      var tonnage = p.tonnage / td;
      var grade = p.grade;
      var metal = p.metal * gf / td;
      var pctTotal = totalTonnage > 0 ? (p.tonnage / totalTonnage * 100) : 0;
      html += '<tr>';
      html += '<td>' + formatNum(c) + '</td>';
      html += '<td>' + formatNum(tonnage) + '</td>';
      html += '<td>' + formatNum(grade) + '</td>';
      html += '<td>' + formatNum(metal) + '</td>';
      html += '<td>' + pctTotal.toFixed(1) + '%</td>';
      html += '</tr>';
    }
  }
  html += '</tbody></table>';
  return html;
}

function resetGtState() {
  lastGtData = null;
  if (gtWorker) { gtWorker.terminate(); gtWorker = null; }
  if (gtExprController) { gtExprController.destroy(); gtExprController = null; }
}
