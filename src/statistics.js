// ─── Statistics Tab ───────────────────────────────────────────────────

const STATS_PRESETS = {
  quartiles: [25, 50, 75],
  deciles: [10, 20, 30, 40, 50, 60, 70, 80, 90],
  ventiles: [5, 10, 25, 50, 75, 90, 95]
};

const STATS_ALL_METRICS = [
  { key: 'count', label: 'Count' },
  { key: 'nulls', label: 'Nulls' },
  { key: 'zeros', label: 'Zeros' },
  { key: 'min', label: 'Min' },
  // percentile metrics injected dynamically
  { key: 'max', label: 'Max' },
  { key: 'mean', label: 'Mean' },
  { key: 'std', label: 'Std' },
  { key: 'cv', label: 'CV%' },
  { key: 'skew', label: 'Skew' },
  { key: 'kurt', label: 'Kurt' }
];

const STATS_DEFAULT_VISIBLE = new Set(['count', 'min', 'max', 'mean', 'std', 'cv']);

// Module-level state so delegation handlers can access current data
let _statsNumCols = [];
let _statsHeader = [];
let _statsOrigColCount = 0;
let _statsEventsWired = false;
let _statsCdfParams = null; // coordinate system for CDF tooltip

function tdQuantileFromCentroids(centroids, totalCount, q) {
  if (!centroids || centroids.length === 0) return null;
  if (centroids.length === 1) return centroids[0][0];
  if (q <= 0) return centroids[0][0];
  if (q >= 1) return centroids[centroids.length - 1][0];
  var target = q * totalCount;
  var cumCount = 0;
  for (var i = 0; i < centroids.length; i++) {
    var mean = centroids[i][0], count = centroids[i][1];
    var lo = cumCount;
    var mid = lo + count / 2;
    if (target < mid) {
      if (i === 0) return mean;
      var prevMean = centroids[i - 1][0], prevCount = centroids[i - 1][1];
      var prevMid = lo - prevCount / 2;
      var t = (target - prevMid) / (mid - prevMid);
      return prevMean + t * (mean - prevMean);
    }
    cumCount += count;
  }
  return centroids[centroids.length - 1][0];
}

function getStatsMetricColumns() {
  var cols = [];
  for (var m of STATS_ALL_METRICS) {
    if (m.key === 'max') {
      for (var p of statsPercentiles) {
        cols.push({ key: 'p' + p, label: 'P' + p, pct: p });
      }
    }
    cols.push(m);
  }
  return cols;
}

function getStatValue(s, metric) {
  if (metric.pct !== undefined) {
    return tdQuantileFromCentroids(s.centroids, s.count, metric.pct / 100);
  }
  switch (metric.key) {
    case 'count': return s.count;
    case 'nulls': return s.nulls;
    case 'zeros': return s.zeros;
    case 'min': return s.min;
    case 'max': return s.max;
    case 'mean': return s.mean;
    case 'std': return s.std;
    case 'cv': return (s.mean && s.std && s.mean !== 0) ? Math.abs(s.std / s.mean * 100) : null;
    case 'skew': return s.skewness;
    case 'kurt': return s.kurtosis;
    default: return null;
  }
}

function formatStatValue(val, metric) {
  if (val === null || val === undefined) return '\u2014';
  if (metric.key === 'count' || metric.key === 'nulls' || metric.key === 'zeros') {
    return val > 0 ? val.toLocaleString() : '\u2014';
  }
  if (metric.key === 'cv') return val.toFixed(1);
  if (metric.key === 'skew' || metric.key === 'kurt') return val.toFixed(2);
  return formatNum(val);
}

function isMetricVisible(key) {
  if (statsVisibleMetrics === null) {
    if (key.startsWith('p') && key.length > 1 && !isNaN(key.slice(1))) return true;
    return STATS_DEFAULT_VISIBLE.has(key);
  }
  return statsVisibleMetrics.has(key);
}

function renderStatsTab(stats, header, origColCount, isFiltered, rowCount) {
  lastDisplayedStats = stats;
  lastDisplayedHeader = header;
  _statsNumCols = Object.keys(stats).map(Number).sort(function(a, b) { return a - b; });
  _statsHeader = header;
  _statsOrigColCount = origColCount;

  $statsBadge.textContent = _statsNumCols.length + ' columns' + (isFiltered ? ' \u00B7 ' + rowCount.toLocaleString() + ' rows' : '');

  if (_statsNumCols.length === 0) {
    $statsContent.innerHTML = '<div style="color:var(--fg-dim);">No numeric columns detected.</div>';
    $statsSidebar.style.display = 'none';
    return;
  }
  $statsSidebar.style.display = '';

  renderStatsSidebar();
  renderStatsTable();
  renderStatsCdfPanel();

  if (!_statsEventsWired) {
    wireStatsEventsOnce();
    _statsEventsWired = true;
  }
}

function renderStatsSidebar() {
  var numCols = _statsNumCols;
  var header = _statsHeader;
  var origColCount = _statsOrigColCount;

  // Metric toggles
  var metrics = getStatsMetricColumns();
  var togglesHtml = '';
  for (var m of metrics) {
    var checked = isMetricVisible(m.key) ? ' checked' : '';
    togglesHtml += '<label class="stats-metric-toggle"><input type="checkbox" data-metric="' + m.key + '"' + checked + '> ' + esc(m.label) + '</label>';
  }
  document.getElementById('statsMetricToggles').innerHTML = togglesHtml;

  // Preset buttons state
  var presetBtns = document.querySelectorAll('#statsPresetBtns .stats-preset');
  var currentPreset = null;
  for (var key in STATS_PRESETS) {
    var pre = STATS_PRESETS[key];
    if (pre.length === statsPercentiles.length && pre.every(function(v, i) { return v === statsPercentiles[i]; })) {
      currentPreset = key;
    }
  }
  presetBtns.forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.preset === currentPreset || (currentPreset === null && btn.dataset.preset === 'custom'));
  });
  var customInput = document.getElementById('statsCustomPct');
  if (currentPreset === null || currentPreset === 'custom') {
    customInput.style.display = '';
    customInput.value = statsPercentiles.join(',');
  } else {
    customInput.style.display = 'none';
  }

  // Variable list
  var search = document.getElementById('statsVarSearch').value.toLowerCase();
  var html = '';
  for (var ci of numCols) {
    var name = header[ci];
    if (search && !fuzzyMatch(search, name.toLowerCase())) continue;
    var isCalcol = ci >= origColCount;
    var selected = statsSelectedVars === null || statsSelectedVars.has(ci);
    var checkedAttr = selected ? ' checked' : '';
    var uncheckedCls = !selected ? ' unchecked' : '';
    html += '<div class="stats-var-item' + uncheckedCls + '" data-col="' + ci + '">';
    html += '<input type="checkbox"' + checkedAttr + ' data-col="' + ci + '">';
    html += '<span class="var-name">' + esc(name) + '</span>';
    if (isCalcol) html += '<span class="calcol-tag">CALC</span>';
    html += '</div>';
  }
  document.getElementById('statsVarList').innerHTML = html;
}

function renderStatsTable() {
  var stats = lastDisplayedStats;
  var header = lastDisplayedHeader;
  if (!stats || !header) return;

  var numCols = Object.keys(stats).map(Number).sort(function(a, b) { return a - b; });
  var origColCount = currentOrigColCount || header.length;
  var metrics = getStatsMetricColumns().filter(function(m) { return isMetricVisible(m.key); });

  var visCols = numCols.filter(function(ci) {
    return statsSelectedVars === null || statsSelectedVars.has(ci);
  });

  if (visCols.length === 0) {
    $statsContent.innerHTML = '<div style="color:var(--fg-dim);padding:1rem;">No variables selected.</div>';
    return;
  }

  var html = '<table class="stats"><thead><tr><th>Column</th>';
  for (var m of metrics) html += '<th>' + esc(m.label) + '</th>';
  html += '</tr></thead><tbody>';

  for (var ci of visCols) {
    var s = stats[ci];
    var isCalcol = ci >= origColCount;
    var cdfActive = statsCdfSelected.has(ci);
    var nameClass = cdfActive ? 'cdf-link cdf-active' : 'cdf-link';
    var nameHtml = '<a class="' + nameClass + '" data-col="' + ci + '" href="#">' + esc(header[ci]) + '</a>';
    if (isCalcol) nameHtml += '<span class="calcol-tag">CALC</span>';

    html += '<tr' + (isCalcol ? ' class="calcol-row"' : '') + '><td>' + nameHtml + '</td>';
    for (var m of metrics) {
      var val = getStatValue(s, m);
      html += '<td>' + formatStatValue(val, m) + '</td>';
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  $statsContent.innerHTML = html;
}

function renderStatsCdfPanel() {
  var chart = document.getElementById('statsCdfChart');
  if (!chart) return;

  if (statsCdfSelected.size === 0) {
    chart.innerHTML = '<div class="stats-cdf-hint">Click column names to add CDF curves</div>';
    return;
  }

  var stats = lastDisplayedStats;
  var header = lastDisplayedHeader;
  if (!stats || !header) return;

  var entries = [];
  statsCdfSelected.forEach(function(ci) {
    if (stats[ci] && stats[ci].centroids && stats[ci].centroids.length > 0) {
      entries.push([header[ci], stats[ci]]);
    }
  });

  if (entries.length === 0) {
    chart.innerHTML = '<div class="stats-cdf-hint">No centroid data for selected columns</div>';
    return;
  }

  chart.innerHTML = renderStatsCdfSvg(entries);
  wireStatsCdfTooltip();

  // Update scale buttons
  document.querySelectorAll('#statsCdfToolbar .stats-scale').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.scale === statsCdfScale);
  });
}

function renderStatsCdfSvg(entries) {
  var isLog = statsCdfScale === 'log';
  var W = 700, plotBaseH = 380;
  var pad = { top: 20, right: 30, bottom: 50, left: 60 };
  var plotW = W - pad.left - pad.right;
  var plotH = plotBaseH - pad.top - pad.bottom;

  var legCols = 3;
  var legRowH = 16;
  var legPadTop = 12;
  var legRows = Math.ceil(entries.length / legCols);
  var legendH = legPadTop + legRows * legRowH + 6;
  var H = plotBaseH + legendH;

  var globalMin = Infinity, globalMax = -Infinity;
  for (var ei = 0; ei < entries.length; ei++) {
    var s = entries[ei][1];
    if (s.min < globalMin) globalMin = s.min;
    if (s.max > globalMax) globalMax = s.max;
  }

  var logMin, logMax;
  if (isLog) {
    logMin = Math.log10(Math.max(globalMin, 1e-10));
    logMax = Math.log10(Math.max(globalMax, 1e-9));
    if (logMax <= logMin) logMax = logMin + 1;
  }
  var xRange = isLog ? (logMax - logMin) : (globalMax - globalMin || 1);

  function sx(v) {
    if (isLog) {
      var lv = Math.log10(Math.max(v, 1e-10));
      return pad.left + ((lv - logMin) / xRange) * plotW;
    }
    return pad.left + ((v - globalMin) / xRange) * plotW;
  }
  function sy(v) { return pad.top + (1 - v) * plotH; }

  var yTicks = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0];
  var gridSvg = '';
  for (var yi = 0; yi < yTicks.length; yi++) {
    var yt = yTicks[yi];
    var y = sy(yt);
    gridSvg += '<line x1="' + pad.left + '" y1="' + y + '" x2="' + (W - pad.right) + '" y2="' + y + '" stroke="#1e2228" stroke-width="1"/>';
    gridSvg += '<text x="' + (pad.left - 8) + '" y="' + (y + 3.5) + '" text-anchor="end" fill="#6a737d" font-size="10">' + (yt * 100).toFixed(0) + '%</text>';
  }
  var nxTicks = 6;
  for (var xi = 0; xi <= nxTicks; xi++) {
    var v;
    if (isLog) {
      v = Math.pow(10, logMin + (xRange * xi / nxTicks));
    } else {
      v = globalMin + ((globalMax - globalMin || 1) * xi / nxTicks);
    }
    var x = sx(v);
    gridSvg += '<line x1="' + x + '" y1="' + pad.top + '" x2="' + x + '" y2="' + (plotBaseH - pad.bottom) + '" stroke="#1e2228" stroke-width="1"/>';
    var label = Math.abs(v) >= 1e5 || (Math.abs(v) < 0.01 && v !== 0) ? v.toExponential(1) : v.toFixed(Math.abs(v) < 10 ? 2 : 0);
    gridSvg += '<text x="' + x + '" y="' + (plotBaseH - pad.bottom + 16) + '" text-anchor="middle" fill="#6a737d" font-size="10">' + label + '</text>';
  }

  var curvesSvg = '';
  var meansSvg = '';
  for (var gi = 0; gi < entries.length; gi++) {
    var eName = entries[gi][0], eStats = entries[gi][1];
    var color = STATSCAT_PALETTE[gi % STATSCAT_PALETTE.length];
    var points = [];
    var cumCount = 0;
    for (var ci = 0; ci < eStats.centroids.length; ci++) {
      var cMean = eStats.centroids[ci][0], cCount = eStats.centroids[ci][1];
      if (isLog && cMean <= 0) { cumCount += cCount; continue; }
      cumCount += cCount;
      var px = sx(cMean);
      if (px < pad.left || px > W - pad.right) continue;
      points.push({ x: px, y: sy(cumCount / eStats.count) });
    }
    if (points.length > 0) {
      var pathParts = points.map(function(p, i) { return (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1); });
      curvesSvg += '<path d="' + pathParts.join(' ') + '" fill="none" stroke="' + color + '" stroke-width="1.5" opacity="0.85"/>';
    }
    if (eStats.mean !== null && (!isLog || eStats.mean > 0)) {
      var mx = sx(eStats.mean);
      if (mx >= pad.left && mx <= W - pad.right) {
        meansSvg += '<line x1="' + mx + '" y1="' + pad.top + '" x2="' + mx + '" y2="' + (plotBaseH - pad.bottom) + '" stroke="' + color + '" stroke-width="1" stroke-dasharray="4,3" opacity="0.5"/>';
      }
    }
  }

  var legTop = plotBaseH + legPadTop;
  var colW = (W - pad.left - pad.right) / legCols;
  var legendSvg = '';
  for (var li = 0; li < entries.length; li++) {
    var lName = entries[li][0];
    var lColor = STATSCAT_PALETTE[li % STATSCAT_PALETTE.length];
    var col = li % legCols;
    var row = Math.floor(li / legCols);
    var lx = pad.left + col * colW;
    var ly = legTop + row * legRowH;
    legendSvg += '<line x1="' + lx + '" y1="' + (ly + 5) + '" x2="' + (lx + 18) + '" y2="' + (ly + 5) + '" stroke="' + lColor + '" stroke-width="2.5"/>';
    legendSvg += '<text x="' + (lx + 24) + '" y="' + (ly + 9) + '" fill="#6a737d" font-size="9.5">' + esc(lName) + '</text>';
  }

  // Store params for tooltip interaction
  _statsCdfParams = {
    entries: entries, isLog: isLog,
    globalMin: globalMin, globalMax: globalMax,
    logMin: isLog ? logMin : 0, logMax: isLog ? logMax : 0,
    xRange: xRange, pad: pad, plotW: plotW, plotH: plotH,
    W: W, plotBaseH: plotBaseH
  };

  // Overlay elements for tooltip interaction
  var overlaySvg = '<line id="statsCdfCrosshair" x1="0" y1="' + pad.top + '" x2="0" y2="' + (plotBaseH - pad.bottom) + '" stroke="var(--amber)" stroke-width="1" stroke-dasharray="3,2" visibility="hidden"/>';
  for (var di = 0; di < entries.length; di++) {
    var dColor = STATSCAT_PALETTE[di % STATSCAT_PALETTE.length];
    overlaySvg += '<circle class="cdf-dot" data-idx="' + di + '" cx="0" cy="0" r="3.5" fill="' + dColor + '" stroke="var(--bg)" stroke-width="1" visibility="hidden"/>';
  }
  overlaySvg += '<rect x="' + pad.left + '" y="' + pad.top + '" width="' + plotW + '" height="' + plotH + '" fill="transparent" id="statsCdfOverlay" style="cursor:crosshair"/>';

  var scaleLabel = isLog ? ' (log)' : '';
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" style="font-family:var(--mono)" id="statsCdfSvg">' +
    '<rect width="' + W + '" height="' + H + '" fill="var(--bg)" rx="4"/>' +
    gridSvg + meansSvg + curvesSvg + overlaySvg +
    '<text x="' + (W / 2) + '" y="' + (plotBaseH - 4) + '" text-anchor="middle" fill="#6a737d" font-size="10">CDF' + scaleLabel + '</text>' +
    '<text x="12" y="' + (plotBaseH / 2) + '" text-anchor="middle" fill="#6a737d" font-size="10" transform="rotate(-90, 12, ' + (plotBaseH / 2) + ')">Cumulative %</text>' +
    legendSvg +
    '</svg>';
}

// CDF tooltip: interpolate cumulative % at a given value
function getCdfAtValue(centroids, totalCount, value, isLog) {
  if (!centroids || centroids.length === 0) return null;
  var pts = [];
  var cum = 0;
  for (var i = 0; i < centroids.length; i++) {
    var m = centroids[i][0], c = centroids[i][1];
    if (isLog && m <= 0) { cum += c; continue; }
    cum += c;
    pts.push([m, cum / totalCount]);
  }
  if (pts.length === 0) return null;
  if (value <= pts[0][0]) return 0;
  if (value >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (var i = 1; i < pts.length; i++) {
    if (value <= pts[i][0]) {
      var t = (value - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]);
      return pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1]);
    }
  }
  return pts[pts.length - 1][1];
}

function wireStatsCdfTooltip() {
  var svg = document.getElementById('statsCdfSvg');
  var overlay = document.getElementById('statsCdfOverlay');
  if (!svg || !overlay || !_statsCdfParams) return;

  var p = _statsCdfParams;
  var crosshair = document.getElementById('statsCdfCrosshair');
  var dots = svg.querySelectorAll('.cdf-dot');
  var chart = document.getElementById('statsCdfChart');

  // Create or reuse tooltip div
  var tip = chart.querySelector('.stats-cdf-tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'stats-cdf-tooltip';
    chart.appendChild(tip);
  }
  tip.style.display = 'none';

  function svgXFromMouse(e) {
    var pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse()).x;
  }

  function valueFromSvgX(svgX) {
    var frac = (svgX - p.pad.left) / p.plotW;
    if (p.isLog) return Math.pow(10, p.logMin + frac * p.xRange);
    return p.globalMin + frac * (p.globalMax - p.globalMin || 1);
  }

  function syFromCdf(cdf) {
    return p.pad.top + (1 - cdf) * p.plotH;
  }

  overlay.addEventListener('mousemove', function(e) {
    var svgX = svgXFromMouse(e);
    var value = valueFromSvgX(svgX);

    // Position crosshair
    crosshair.setAttribute('x1', svgX);
    crosshair.setAttribute('x2', svgX);
    crosshair.setAttribute('visibility', 'visible');

    // Build tooltip content and position dots
    var label = Math.abs(value) >= 1e5 || (Math.abs(value) < 0.01 && value !== 0)
      ? value.toExponential(2) : formatNum(value);
    var lines = '<div style="color:var(--fg-dim);margin-bottom:3px">' + esc(String(label)) + '</div>';

    for (var i = 0; i < p.entries.length; i++) {
      var eName = p.entries[i][0], eStats = p.entries[i][1];
      var color = STATSCAT_PALETTE[i % STATSCAT_PALETTE.length];
      var cdf = getCdfAtValue(eStats.centroids, eStats.count, value, p.isLog);
      if (cdf !== null) {
        var dotY = syFromCdf(cdf);
        dots[i].setAttribute('cx', svgX);
        dots[i].setAttribute('cy', dotY);
        dots[i].setAttribute('visibility', 'visible');
        lines += '<div><span style="color:' + color + '">\u25CF</span> ' + esc(eName) + ': ' + (cdf * 100).toFixed(1) + '%</div>';
      } else {
        dots[i].setAttribute('visibility', 'hidden');
      }
    }
    tip.innerHTML = lines;
    tip.style.display = '';

    // Position tooltip relative to chart container
    var chartRect = chart.getBoundingClientRect();
    var svgRect = svg.getBoundingClientRect();
    var mouseXInChart = e.clientX - chartRect.left;
    var mouseYInChart = e.clientY - chartRect.top;
    var tipW = tip.offsetWidth;
    // Flip to left side if near right edge
    var xOff = mouseXInChart + 16 + tipW > chartRect.width ? -tipW - 12 : 16;
    tip.style.left = (mouseXInChart + xOff) + 'px';
    tip.style.top = (mouseYInChart - 20) + 'px';
  });

  overlay.addEventListener('mouseleave', function() {
    crosshair.setAttribute('visibility', 'hidden');
    for (var i = 0; i < dots.length; i++) dots[i].setAttribute('visibility', 'hidden');
    tip.style.display = 'none';
  });
}

// Wire all events ONCE using delegation — survives innerHTML rebuilds
function wireStatsEventsOnce() {
  // --- Preset buttons (static template elements) ---
  document.getElementById('statsPresetBtns').addEventListener('click', function(e) {
    var btn = e.target.closest('.stats-preset');
    if (!btn) return;
    var preset = btn.dataset.preset;
    if (preset === 'custom') {
      var customInput = document.getElementById('statsCustomPct');
      customInput.style.display = '';
      document.querySelectorAll('#statsPresetBtns .stats-preset').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      customInput.focus();
    } else if (STATS_PRESETS[preset]) {
      statsPercentiles = STATS_PRESETS[preset].slice();
      renderStatsSidebar();
      renderStatsTable();
      autoSaveProject();
    }
  });

  // --- Custom percentile input (static template element) ---
  document.getElementById('statsCustomPct').addEventListener('change', function() {
    var input = document.getElementById('statsCustomPct');
    var parts = input.value.split(',').map(function(s) { return parseInt(s.trim()); }).filter(function(n) { return !isNaN(n) && n >= 1 && n <= 99; });
    if (parts.length > 0) {
      parts.sort(function(a, b) { return a - b; });
      statsPercentiles = parts.filter(function(v, i, arr) { return i === 0 || v !== arr[i - 1]; });
      renderStatsSidebar();
      renderStatsTable();
      autoSaveProject();
    }
  });

  // --- Metric toggles (delegation on container — innerHTML changes) ---
  document.getElementById('statsMetricToggles').addEventListener('change', function(e) {
    var cb = e.target.closest('input[data-metric]');
    if (!cb) return;
    if (statsVisibleMetrics === null) {
      statsVisibleMetrics = new Set();
      var allMetrics = getStatsMetricColumns();
      for (var m of allMetrics) {
        if (isMetricVisible(m.key)) statsVisibleMetrics.add(m.key);
      }
    }
    if (cb.checked) statsVisibleMetrics.add(cb.dataset.metric);
    else statsVisibleMetrics.delete(cb.dataset.metric);
    renderStatsTable();
    autoSaveProject();
  });

  // --- Variable checkboxes (delegation on container — innerHTML changes) ---
  document.getElementById('statsVarList').addEventListener('change', function(e) {
    var cb = e.target.closest('input[data-col]');
    if (!cb) return;
    var colIdx = parseInt(cb.dataset.col);
    if (statsSelectedVars === null) {
      statsSelectedVars = new Set(_statsNumCols);
    }
    if (cb.checked) statsSelectedVars.add(colIdx);
    else statsSelectedVars.delete(colIdx);
    var item = cb.closest('.stats-var-item');
    if (item) item.classList.toggle('unchecked', !cb.checked);
    renderStatsTable();
    autoSaveProject();
  });

  // --- All/None buttons (static template elements) ---
  document.getElementById('statsVarAll').addEventListener('click', function() {
    if (statsSelectedVars === null) statsSelectedVars = new Set(_statsNumCols);
    document.getElementById('statsVarList').querySelectorAll('.stats-var-item').forEach(function(el) {
      statsSelectedVars.add(parseInt(el.dataset.col));
    });
    renderStatsSidebar();
    renderStatsTable();
    autoSaveProject();
  });
  document.getElementById('statsVarNone').addEventListener('click', function() {
    if (statsSelectedVars === null) statsSelectedVars = new Set(_statsNumCols);
    document.getElementById('statsVarList').querySelectorAll('.stats-var-item').forEach(function(el) {
      statsSelectedVars.delete(parseInt(el.dataset.col));
    });
    renderStatsSidebar();
    renderStatsTable();
    autoSaveProject();
  });

  // --- Variable search (static template element) ---
  document.getElementById('statsVarSearch').addEventListener('input', function() {
    renderStatsSidebar();
  });

  // --- CDF links in table (delegation on container — innerHTML changes) ---
  $statsContent.addEventListener('click', function(e) {
    var link = e.target.closest('.cdf-link');
    if (!link) return;
    e.preventDefault();
    var col = parseInt(link.dataset.col);
    if (statsCdfSelected.has(col)) statsCdfSelected.delete(col);
    else statsCdfSelected.add(col);
    renderStatsTable();
    renderStatsCdfPanel();
    autoSaveProject();
  });

  // --- CDF scale buttons (static template elements) ---
  document.getElementById('statsCdfToolbar').addEventListener('click', function(e) {
    var btn = e.target.closest('.stats-scale');
    if (!btn) return;
    statsCdfScale = btn.dataset.scale;
    renderStatsCdfPanel();
    autoSaveProject();
  });

  // --- Copy table (static template element) ---
  document.getElementById('statsCopyBtn').addEventListener('click', copyStatsTable);

  // --- Download SVG/PNG (static template elements) ---
  document.getElementById('statsDownloadSvg').addEventListener('click', downloadStatsSvg);
  document.getElementById('statsDownloadPng').addEventListener('click', downloadStatsPng);

  // --- Mobile collapsible sidebar ---
  if (window.matchMedia('(max-width: 700px)').matches) {
    $statsSidebar.addEventListener('click', function(e) {
      var title = e.target.closest('.stats-sidebar-section--grow > .stats-sidebar-title');
      if (!title) return;
      var section = title.closest('.stats-sidebar-section--grow');
      var wasCollapsed = section.classList.contains('collapsed');
      $statsSidebar.querySelectorAll('.stats-sidebar-section--grow').forEach(function(s) { s.classList.add('collapsed'); });
      if (wasCollapsed) section.classList.remove('collapsed');
    });
  }
}

function copyStatsTable() {
  var table = $statsContent.querySelector('table.stats');
  if (!table) return;
  var rows = table.querySelectorAll('tr');
  var lines = [];
  rows.forEach(function(row) {
    var cells = row.querySelectorAll('th, td');
    var vals = [];
    cells.forEach(function(c) { vals.push(c.textContent); });
    lines.push(vals.join('\t'));
  });
  navigator.clipboard.writeText(lines.join('\n')).then(function() {
    var btn = document.getElementById('statsCopyBtn');
    btn.textContent = 'Copied!';
    setTimeout(function() { btn.textContent = 'Copy table'; }, 1500);
  });
}

function cleanSvgForExport(svgEl) {
  var clone = svgEl.cloneNode(true);
  // Remove interactive tooltip elements
  var overlay = clone.querySelector('#statsCdfOverlay');
  var crosshair = clone.querySelector('#statsCdfCrosshair');
  if (overlay) overlay.remove();
  if (crosshair) crosshair.remove();
  clone.querySelectorAll('.cdf-dot').forEach(function(d) { d.remove(); });
  var svgData = new XMLSerializer().serializeToString(clone);
  svgData = svgData.replace(/fill="var\(--bg\)"/g, 'fill="white"');
  svgData = svgData.replace(/fill="#6a737d"/g, 'fill="#333"');
  svgData = svgData.replace(/stroke="#1e2228"/g, 'stroke="#ddd"');
  svgData = svgData.replace(/style="font-family:var\(--mono\)"/g, 'style="font-family:monospace"');
  return svgData;
}

function downloadStatsSvg() {
  var svgEl = document.getElementById('statsCdfSvg');
  if (!svgEl) return;
  var svgData = cleanSvgForExport(svgEl);
  var blob = new Blob([svgData], { type: 'image/svg+xml' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'statistics_cdf.svg';
  a.click();
  URL.revokeObjectURL(a.href);
}

function downloadStatsPng() {
  var svgEl = document.getElementById('statsCdfSvg');
  if (!svgEl) return;
  var svgData = cleanSvgForExport(svgEl);
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
      a.download = 'statistics_cdf.png';
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  };
  img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
}
