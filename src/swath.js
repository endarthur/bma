// ─── Swath Tab ────────────────────────────────────────────────────────

let swathNumCols = [];
var _swathChartParams = null; // stored for crosshair

function resetSwathState() {
  _swathChartParams = null;
}

function getSwathUnit(colIdx) {
  var sel = document.querySelector('.swath-var-unit[data-col="' + colIdx + '"]');
  var idx = sel ? parseInt(sel.value) : 0;
  if (idx === 0 && currentHeader[colIdx] && globalUnits[currentHeader[colIdx]])
    idx = globalUnits[currentHeader[colIdx]];
  var u = GRADE_UNITS[idx] || GRADE_UNITS[0];
  return { unitIdx: idx, symbol: u.symbol };
}

function renderSwathConfig(data) {
  const $sidebar = document.getElementById('swathSidebar');
  const $content = document.getElementById('swathContent');
  if (!$sidebar) return;
  const { header, colTypes, geometry } = data;
  const hasXYZ = currentXYZ.x >= 0 && currentXYZ.y >= 0 && currentXYZ.z >= 0;
  if (!hasXYZ || !geometry || !geometry.x) {
    $sidebar.innerHTML = '';
    $content.innerHTML = '<div class="swath-hint">Assign X/Y/Z columns in Preflight and run analysis to enable Swath plots.</div>';
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
  const axes = [
    { key: 'x', label: 'X', bs: geometry.x.blockSize },
    { key: 'y', label: 'Y', bs: geometry.y.blockSize },
    { key: 'z', label: 'Z', bs: geometry.z.blockSize }
  ];
  const defaultBs = axes[0].bs;
  const varItems = swathNumCols.map(function(c) {
    var defUnit = globalUnits[c.name] || 0;
    var unitOpts = GRADE_UNITS.map(function(u, ui) {
      return '<option value="' + ui + '"' + (ui === defUnit ? ' selected' : '') + '>' + esc(u.label) + '</option>';
    }).join('');
    return '<label class="swath-var-item"><input type="checkbox" value="' + c.idx + '" checked><span>' + esc(c.name) + '</span>' +
      '<select class="swath-var-unit" data-col="' + c.idx + '">' + unitOpts + '</select></label>';
  }).join('');

  $sidebar.innerHTML =
    '<div class="swath-sidebar-section">' +
      '<div class="swath-sidebar-title">Axis</div>' +
      '<select class="swath-select" id="swathAxis">' + axes.map(a => '<option value="' + a.key + '">' + a.label + '</option>').join('') + '</select>' +
      '<div style="margin-top:0.4rem">' +
        '<div class="swath-sidebar-title">Bin Width</div>' +
        '<input type="number" class="swath-input" id="swathBinWidth" value="' + defaultBs + '" min="0.001" step="any">' +
        '<div class="swath-bin-label" id="swathBinLabel">' + defaultBs + 'm blocks</div>' +
      '</div>' +
    '</div>' +
    '<div class="swath-sidebar-section">' +
      '<div class="swath-sidebar-title">Statistic</div>' +
      '<select class="swath-select" id="swathStat">' +
        '<option value="mean_std">Mean \u00b1 Std</option>' +
        '<option value="p25_50_75">P25 / P50 / P75</option>' +
        '<option value="p10_50_90">P10 / P50 / P90</option>' +
      '</select>' +
    '</div>' +
    '<div class="swath-sidebar-section--grow">' +
      '<div class="swath-sidebar-title">Variables</div>' +
      '<input type="text" class="swath-search" id="swathVarSearch" placeholder="search\u2026" autocomplete="off" spellcheck="false">' +
      '<div class="swath-var-btns">' +
        '<button id="swathVarAll">All</button>' +
        '<button id="swathVarNone">None</button>' +
        '<button id="swathUnitSync" class="swath-unit-sync" title="Sync units from Column Overview">Sync units</button>' +
      '</div>' +
      '<div class="swath-var-list" id="swathVarList">' + varItems + '</div>' +
    '</div>' +
    '<div class="swath-sidebar-section">' +
      '<div class="swath-sidebar-title">Local Filter</div>' +
      '<input type="text" class="swath-search" id="swathLocalFilter" placeholder="e.g. r.zone == 1" autocomplete="off" spellcheck="false">' +
    '</div>' +
    '<div class="swath-sidebar-section">' +
      '<button class="swath-generate" id="swathGenerate">Generate</button>' +
      '<div class="swath-progress" id="swathProgress">' +
        '<div class="swath-progress-bar"><div class="swath-progress-fill" id="swathProgressFill"></div></div>' +
        '<div class="swath-progress-label" id="swathProgressLabel"></div>' +
      '</div>' +
    '</div>';

  $content.innerHTML = '<div class="swath-hint">Select variables and click Generate to create swath plots.</div>';

  // Update bin width + label when axis changes
  var $axis = document.getElementById('swathAxis');
  var $binWidth = document.getElementById('swathBinWidth');
  var $binLabel = document.getElementById('swathBinLabel');
  $axis.addEventListener('change', function() {
    var a = axes.find(function(ax) { return ax.key === $axis.value; });
    if (a) {
      $binWidth.value = a.bs;
      $binLabel.textContent = a.bs + 'm blocks';
    }
  });
  // Fix: show the typed value, not blockSize
  $binWidth.addEventListener('input', function() {
    var v = $binWidth.value;
    $binLabel.textContent = (v || '?') + 'm bins';
    $binLabel.style.color = '';
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

  // Sync units from global
  document.getElementById('swathUnitSync').addEventListener('click', function() {
    document.querySelectorAll('.swath-var-unit').forEach(function(sel) {
      var colIdx = parseInt(sel.dataset.col);
      var colName = currentHeader[colIdx];
      sel.value = (colName && globalUnits[colName]) ? globalUnits[colName] : 0;
    });
    if (lastSwathData) renderSwathCharts(lastSwathData, document.getElementById('swathStat').value);
    autoSaveProject();
  });

  // Generate button
  document.getElementById('swathGenerate').addEventListener('click', runSwath);

  // Stat change re-renders from cache
  document.getElementById('swathStat').addEventListener('change', function() {
    if (lastSwathData) renderSwathCharts(lastSwathData, document.getElementById('swathStat').value);
  });

  // Swath per-variable unit change — re-render from cache
  document.getElementById('swathVarList').addEventListener('change', function(e) {
    if (e.target.classList.contains('swath-var-unit') && lastSwathData) {
      renderSwathCharts(lastSwathData, document.getElementById('swathStat').value);
    }
  });

  // Local filter autocomplete
  if (swathExprController) swathExprController.destroy();
  swathExprController = createExprInput(document.getElementById('swathLocalFilter'), { mode: 'filter' });

  // Autosave on any sidebar change
  $sidebar.addEventListener('change', function() { autoSaveProject(); });
  $sidebar.addEventListener('input', function(e) {
    if (e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') autoSaveProject();
  });
}

function runSwath() {
  if (swathExprController) { var r = swathExprController.validate(); if (!r.valid) return; }
  var axisVal = document.getElementById('swathAxis').value;
  var binWidth = parseFloat(document.getElementById('swathBinWidth').value);
  var stat = document.getElementById('swathStat').value;
  var localFilter = document.getElementById('swathLocalFilter').value.trim();
  var $binLabel = document.getElementById('swathBinLabel');

  if (!binWidth || binWidth <= 0 || isNaN(binWidth)) {
    $binLabel.textContent = 'Invalid bin width';
    $binLabel.style.color = 'var(--red)';
    setTimeout(function() { $binLabel.style.color = ''; $binLabel.textContent = '?m bins'; }, 2000);
    return;
  }

  // Gather selected variable column indices
  var varCols = [];
  document.querySelectorAll('#swathVarList input[type="checkbox"]:checked').forEach(function(cb) {
    varCols.push(parseInt(cb.value));
  });
  if (varCols.length === 0) return;

  if (swathWorker) swathWorker.terminate();
  swathWorker = new Worker(workerUrl);

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

  var resolvedTypes = currentColTypes.slice(0, currentOrigColCount);
  var filterPayload = currentFilter ? { expression: currentFilter.expression } : null;
  var zipEntry = preflightData ? (preflightData.selectedZipEntry || null) : null;

  var axisIdx = axisVal === 'x' ? 0 : (axisVal === 'y' ? 1 : 2);
  var xyzCols = [currentXYZ.x, currentXYZ.y, currentXYZ.z];
  var dxyzCols = [currentDXYZ.dx, currentDXYZ.dy, currentDXYZ.dz];

  swathWorker.postMessage({
    mode: 'swath',
    file: currentFile,
    zipEntry: zipEntry,
    globalFilter: filterPayload,
    localFilter: localFilter || null,
    calcolCode: currentCalcolCode || null,
    calcolMeta: currentCalcolMeta.length > 0 ? currentCalcolMeta : null,
    resolvedTypes: resolvedTypes,
    xyzCols: xyzCols,
    dxyzCols: dxyzCols,
    axis: axisIdx,
    varCols: varCols,
    binWidth: binWidth
  });

  swathWorker.onerror = function(e) {
    $label.textContent = 'Worker error: ' + (e.message || 'unknown error');
    $label.style.color = 'var(--red)';
    setTimeout(function() { $progress.classList.remove('active'); $label.style.color = ''; }, 3000);
    if ($btn) $btn.disabled = false;
    swathWorker.terminate();
    swathWorker = null;
  };

  swathWorker.onmessage = function(e) {
    var m = e.data;
    if (m.type === 'swath-progress') {
      var pct = Math.min(99, m.percent);
      $fill.style.width = pct.toFixed(1) + '%';
      $label.textContent = pct.toFixed(0) + '%';
    } else if (m.type === 'swath-complete') {
      $fill.style.width = '100%';
      $label.textContent = 'Done';
      setTimeout(function() { $progress.classList.remove('active'); }, 800);
      if ($btn) $btn.disabled = false;
      lastSwathData = { vars: m.vars, axis: axisVal, axisIdx: axisIdx, binWidth: binWidth, varCols: varCols, elapsed: m.elapsed };
      renderSwathCharts(lastSwathData, stat);
      // Update tab badge
      var totalBins = Object.values(m.vars).reduce(function(s, arr) { return Math.max(s, arr.length); }, 0);
      var swathTab = document.querySelector('.results-tab[data-tab="swath"]');
      if (swathTab) swathTab.innerHTML = 'Swath <span class="tab-badge">' + totalBins + ' bins</span>';
      swathWorker.terminate();
      swathWorker = null;
      autoSaveProject();
    } else if (m.type === 'error') {
      $label.textContent = 'Error: ' + m.message;
      setTimeout(function() { $progress.classList.remove('active'); }, 2000);
      if ($btn) $btn.disabled = false;
      swathWorker.terminate();
      swathWorker = null;
    }
  };
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

function renderSwathCharts(swathData, stat) {
  var $content = document.getElementById('swathContent');
  if (!$content || !swathData || !swathData.vars) {
    if ($content) $content.innerHTML = '<div class="swath-hint">No data.</div>';
    return;
  }
  var varCols = swathData.varCols || [];
  var hasData = varCols.some(function(vi) { return swathData.vars[vi] && swathData.vars[vi].length > 0; });
  if (!hasData) {
    $content.innerHTML = '<div class="swath-hint">No data in selected bins.</div>';
    return;
  }

  // Build per-variable entries
  var varEntries = [];
  for (var vi = 0; vi < varCols.length; vi++) {
    var colIdx = varCols[vi];
    var bins = (swathData.vars[colIdx] || []).filter(function(b) { return b.count > 0; }).sort(function(a, b) { return a.center - b.center; });
    if (bins.length === 0) continue;
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
    var unit = getSwathUnit(colIdx);
    varEntries.push({
      colIdx: colIdx,
      name: currentHeader[colIdx] || 'Variable',
      color: STATSCAT_PALETTE[vi % STATSCAT_PALETTE.length],
      bins: bins,
      centerLine: centerLine,
      upperLine: upperLine,
      lowerLine: lowerLine,
      unit: unit
    });
  }

  if (varEntries.length === 0) {
    $content.innerHTML = '<div class="swath-hint">No data in selected bins.</div>';
    return;
  }

  var html = '<div class="swath-chart-card">' + renderSwathOverlaySvg(varEntries, swathData, stat) + '</div>';
  html += renderSwathTable(varEntries, swathData, stat);
  $content.innerHTML = html;

  wireSwathCrosshair();
  wireSwathTableEvents();
}

function renderSwathOverlaySvg(varEntries, swathData, stat) {
  var numVars = varEntries.length;
  var bw = swathData.binWidth;

  // Use first entry's bins for shared X axis + counts (all share same spatial bins)
  var refBins = varEntries[0].bins;

  // Dimensions — extra right axes for 3+ variables
  var extraAxes = Math.max(0, numVars - 2);
  var W = 720 + extraAxes * 55;
  var padRight = 55 + extraAxes * 55;
  var pad = { top: 30, right: padRight, bottom: 70, left: 65 };
  var plotW = W - pad.left - pad.right;
  var plotH = 240;
  // Legend height — 3 columns
  var legendCols = 3;
  var legendRows = Math.ceil(numVars / legendCols);
  var legendH = legendRows * 16 + 10;
  var countBarH = 20;
  var H = pad.top + plotH + 30 + countBarH + 10 + legendH + pad.bottom;

  // Shared X scale
  var xMin = refBins[0].center - bw / 2;
  var xMax = refBins[refBins.length - 1].center + bw / 2;
  var xRange = xMax - xMin || 1;
  var sx = function(v) { return pad.left + ((v - xMin) / xRange) * plotW; };

  // Per-variable Y scales
  var yMins = [], yMaxs = [];
  for (var vi = 0; vi < varEntries.length; vi++) {
    var entry = varEntries[vi];
    var allY = [];
    for (var j = 0; j < entry.centerLine.length; j++) { if (entry.centerLine[j].y != null) allY.push(entry.centerLine[j].y); }
    for (var j = 0; j < entry.upperLine.length; j++) { if (entry.upperLine[j].y != null) allY.push(entry.upperLine[j].y); }
    for (var j = 0; j < entry.lowerLine.length; j++) { if (entry.lowerLine[j].y != null) allY.push(entry.lowerLine[j].y); }
    var yMin = allY.length > 0 ? Math.min.apply(null, allY) : 0;
    var yMax = allY.length > 0 ? Math.max.apply(null, allY) : 1;
    var yPad = (yMax - yMin) * 0.1 || 1;
    yMin -= yPad; yMax += yPad;
    yMins.push(yMin);
    yMaxs.push(yMax);
  }

  function syFn(vi) {
    var ymn = yMins[vi], ymx = yMaxs[vi];
    var yr = ymx - ymn || 1;
    return function(v) { return pad.top + ((ymx - v) / yr) * plotH; };
  }

  // Store params for crosshair
  _swathChartParams = {
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
    svg += '<line x1="' + x.toFixed(1) + '" y1="' + pad.top + '" x2="' + x.toFixed(1) + '" y2="' + (pad.top + plotH) + '" stroke="#1e2228" stroke-width="1"/>';
    svg += '<text x="' + x.toFixed(1) + '" y="' + (pad.top + plotH + 14) + '" text-anchor="middle" fill="#6a737d" font-size="9">' + formatNum(v) + '</text>';
  }

  // Y grid from first variable only
  var sy0 = syFn(0);
  var nyTicks = 6;
  var yRange0 = yMaxs[0] - yMins[0] || 1;
  for (var i = 0; i <= nyTicks; i++) {
    var v = yMins[0] + (yRange0 * i / nyTicks);
    var y = sy0(v);
    svg += '<line x1="' + pad.left + '" y1="' + y.toFixed(1) + '" x2="' + (pad.left + plotW) + '" y2="' + y.toFixed(1) + '" stroke="#1e2228" stroke-width="1"/>';
  }

  // Per-variable ribbons and lines
  for (var vi = 0; vi < varEntries.length; vi++) {
    var entry = varEntries[vi];
    var sy = syFn(vi);
    var color = entry.color;

    // Ribbon
    var ribbonPath = '';
    for (var i = 0; i < entry.bins.length; i++) {
      ribbonPath += (i === 0 ? 'M' : 'L') + sx(entry.upperLine[i].x).toFixed(1) + ',' + sy(entry.upperLine[i].y != null ? entry.upperLine[i].y : 0).toFixed(1);
    }
    for (var i = entry.bins.length - 1; i >= 0; i--) {
      ribbonPath += 'L' + sx(entry.lowerLine[i].x).toFixed(1) + ',' + sy(entry.lowerLine[i].y != null ? entry.lowerLine[i].y : 0).toFixed(1);
    }
    ribbonPath += 'Z';
    svg += '<path d="' + ribbonPath + '" fill="' + color + '" opacity="0.15"/>';

    // Center line
    var centerPath = '';
    for (var i = 0; i < entry.bins.length; i++) {
      centerPath += (i === 0 ? 'M' : 'L') + sx(entry.centerLine[i].x).toFixed(1) + ',' + sy(entry.centerLine[i].y != null ? entry.centerLine[i].y : 0).toFixed(1);
    }
    svg += '<path d="' + centerPath + '" fill="none" stroke="' + color + '" stroke-width="1.5"/>';
  }

  // Per-variable Y axes
  for (var vi = 0; vi < varEntries.length; vi++) {
    var entry = varEntries[vi];
    var sy = syFn(vi);
    var color = entry.color;
    var yr = yMaxs[vi] - yMins[vi] || 1;

    if (vi === 0) {
      // Left Y-axis
      for (var i = 0; i <= nyTicks; i++) {
        var v = yMins[vi] + (yr * i / nyTicks);
        var y = sy(v);
        svg += '<text x="' + (pad.left - 6) + '" y="' + (y + 3) + '" text-anchor="end" fill="' + color + '" font-size="9">' + formatNum(v) + '</text>';
      }
      var axisLabel = esc(entry.name) + (entry.unit && entry.unit.symbol ? ' (' + esc(entry.unit.symbol) + ')' : '');
      svg += '<text x="12" y="' + (pad.top + plotH / 2) + '" text-anchor="middle" fill="' + color + '" font-size="10" transform="rotate(-90, 12, ' + (pad.top + plotH / 2) + ')">' + axisLabel + '</text>';
    } else {
      // Right Y-axis — offset by (vi - 1) * 55
      var axisX = pad.left + plotW + (vi - 1) * 55 + 10;
      for (var i = 0; i <= nyTicks; i++) {
        var v = yMins[vi] + (yr * i / nyTicks);
        var y = sy(v);
        svg += '<text x="' + (axisX + 6) + '" y="' + (y + 3) + '" text-anchor="start" fill="' + color + '" font-size="9">' + formatNum(v) + '</text>';
      }
      svg += '<line x1="' + axisX + '" y1="' + pad.top + '" x2="' + axisX + '" y2="' + (pad.top + plotH) + '" stroke="' + color + '" stroke-width="0.5" opacity="0.4"/>';
    }
  }

  // Count bars below plot
  var maxCount = 0;
  for (var i = 0; i < refBins.length; i++) { if (refBins[i].count > maxCount) maxCount = refBins[i].count; }
  var barTop = pad.top + plotH + 26;
  for (var i = 0; i < refBins.length; i++) {
    var bin = refBins[i];
    var bx = sx(bin.center - bw / 2);
    var bwPx = sx(bin.center + bw / 2) - bx;
    var bh = maxCount > 0 ? (bin.count / maxCount) * countBarH : 0;
    svg += '<rect x="' + bx.toFixed(1) + '" y="' + (barTop + countBarH - bh).toFixed(1) + '" width="' + Math.max(1, bwPx - 1).toFixed(1) + '" height="' + bh.toFixed(1) + '" fill="rgba(240,178,50,0.3)"/>';
  }

  // Direction labels
  var axisKey = swathData.axis;
  var dirLeft = '', dirRight = '';
  if (axisKey === 'x') { dirLeft = 'W'; dirRight = 'E'; }
  else if (axisKey === 'y') { dirLeft = 'S'; dirRight = 'N'; }
  else { dirLeft = 'Bottom'; dirRight = 'Top'; }
  svg += '<text x="' + (pad.left + 4) + '" y="' + (pad.top - 8) + '" fill="#6a737d" font-size="10">' + dirLeft + ' (' + formatNum(xMin) + ')</text>';
  svg += '<text x="' + (pad.left + plotW - 4) + '" y="' + (pad.top - 8) + '" text-anchor="end" fill="#6a737d" font-size="10">' + dirRight + ' (' + formatNum(xMax) + ')</text>';

  // X axis label
  var statLabels = { mean_std: 'Mean \u00b1 Std', p25_50_75: 'P25/P50/P75', p10_50_90: 'P10/P50/P90' };
  svg += '<text x="' + (pad.left + plotW / 2) + '" y="' + (barTop + countBarH + 14) + '" text-anchor="middle" fill="#6a737d" font-size="10">' + swathData.axis.toUpperCase() + ' Coordinate (' + (statLabels[stat] || stat) + ')</text>';

  // Legend — 3 columns
  var legendTop = barTop + countBarH + 24;
  var colW = plotW / legendCols;
  for (var vi = 0; vi < varEntries.length; vi++) {
    var col = vi % legendCols;
    var row = Math.floor(vi / legendCols);
    var lx = pad.left + col * colW;
    var ly = legendTop + row * 16;
    var legLabel = esc(varEntries[vi].name) + (varEntries[vi].unit && varEntries[vi].unit.symbol ? ' (' + esc(varEntries[vi].unit.symbol) + ')' : '');
    svg += '<rect x="' + lx + '" y="' + ly + '" width="12" height="3" fill="' + varEntries[vi].color + '" rx="1"/>';
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
    lines.push({ text: p.varEntries[0].bins[0] ? swathData_axisLabel() + ': ' + formatNum(nearBin.center) : formatNum(nearBin.center), color: 'var(--fg)' });
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
        lines.push({ text: txt, color: entry.color });
      }
    }

    var lineH = 13;
    var ttW = 180;
    var ttH = lines.length * lineH + 8;
    var tx = snapX + 12;
    var ty = p.pad.top + 10;
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

  area.addEventListener('mousemove', onMove);
  area.addEventListener('mouseleave', onLeave);
}

function swathData_axisLabel() {
  if (!lastSwathData) return 'Coord';
  return lastSwathData.axis.toUpperCase();
}

function renderSwathTable(varEntries, swathData, stat) {
  var refBins = varEntries[0].bins;
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
      } else {
        var emptyCols = stat === 'mean_std' ? 2 : 3;
        for (var ec = 0; ec < emptyCols; ec++) tbody += '<td></td>';
      }
    }
    tbody += '</tr>';
  }

  return '<div class="swath-table-section">' +
    '<div class="swath-table-header" data-swath-collapse="0">' +
      '<span class="swath-table-toggle">\u25BC</span> ' + tableTitle +
      '<button class="swath-copy-btn" data-swath-copy="0">Copy</button>' +
    '</div>' +
    '<div class="swath-table-body" id="swathTableBody0">' +
      '<div class="swath-table-wrap">' +
        '<table class="swath-table"><thead><tr>' + thHtml + '</tr></thead><tbody>' + tbody + '</tbody></table>' +
      '</div>' +
    '</div>' +
  '</div>';
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

  // Collapsible table header
  $content.querySelectorAll('[data-swath-collapse]').forEach(function(hdr) {
    hdr.addEventListener('click', function() {
      var idx = hdr.dataset.swathCollapse;
      var body = document.getElementById('swathTableBody' + idx);
      var toggle = hdr.querySelector('.swath-table-toggle');
      if (body.style.display === 'none') {
        body.style.display = '';
        toggle.textContent = '\u25BC';
      } else {
        body.style.display = 'none';
        toggle.textContent = '\u25B6';
      }
    });
  });
}
