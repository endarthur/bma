// ─── Statistics Tab ───────────────────────────────────────────────────

const STATS_PRESETS = {
  quartiles: [25, 50, 75],
  deciles: [10, 20, 30, 40, 50, 60, 70, 80, 90],
  ventiles: [5, 10, 25, 50, 75, 90, 95]
};

const STATS_ALL_METRICS = [
  { key: 'count', label: 'Count' },
  { key: 'sumw', label: 'ΣW' },
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

// Aux numeric columns available for comparison, each with its paired
// primary column (catalog pairing, seeded by name) when one exists.
// Selection defaults to "paired only" until the user materializes a choice.
function getStatsAuxCols() {
  if (!auxCompleteData || !auxCompleteData.stats) return [];
  catEnsureSeeded();
  var primaryByName = {};
  for (var i = 0; i < _statsNumCols.length; i++) {
    var ci = _statsNumCols[i];
    primaryByName[_statsHeader[ci]] = ci;
  }
  var out = [];
  Object.keys(auxCompleteData.stats).map(Number).sort(function(a, b) { return a - b; }).forEach(function(ai) {
    var name = auxCompleteData.header[ai];
    var p = catPair(name);
    var m = p !== null ? primaryByName[p] : undefined;
    out.push({ idx: ai, name: name, matchCi: m !== undefined ? m : null });
  });
  return out;
}

function isStatsAuxSelected(auxCol) {
  if (statsAuxSelected === null) return auxCol.matchCi !== null;
  return statsAuxSelected.has(auxCol.idx);
}

function materializeStatsAuxSelected() {
  if (statsAuxSelected !== null) return;
  statsAuxSelected = new Set();
  getStatsAuxCols().forEach(function(c) { if (c.matchCi !== null) statsAuxSelected.add(c.idx); });
}

// Convert a project restore (variable names) to aux column indices — callable
// only once the aux analysis has produced a header
function applyStatsAuxRestore() {
  if (!pendingStatsAuxRestore || !auxCompleteData) return;
  var byName = {};
  for (var i = 0; i < auxCompleteData.header.length; i++) byName[auxCompleteData.header[i]] = i;
  if (pendingStatsAuxRestore.selected) {
    statsAuxSelected = new Set();
    pendingStatsAuxRestore.selected.forEach(function(n) { if (byName[n] !== undefined) statsAuxSelected.add(byName[n]); });
  }
  if (pendingStatsAuxRestore.cdf) {
    statsCdfAuxSelected = new Set();
    pendingStatsAuxRestore.cdf.forEach(function(n) { if (byName[n] !== undefined) statsCdfAuxSelected.add(byName[n]); });
  }
  pendingStatsAuxRestore = null;
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
    case 'sumw': return s.sumW != null ? s.sumW : null;
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

// Metrics where a relative % difference is meaningless (dataset-size counts)
// or unstable (moments with near-zero reference values)
var STATS_DELTA_SKIP = new Set(['count', 'sumw', 'nulls', 'zeros', 'skew', 'kurt']);

function formatDeltaPct(p, a, metric) {
  if (STATS_DELTA_SKIP.has(metric.key)) return '—';
  if (p == null || a == null || !isFinite(p) || !isFinite(a) || a === 0) return '—';
  var d = (p - a) / Math.abs(a) * 100;
  if (!isFinite(d)) return '—';
  return (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(1) + '%';
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

  // Weight select — numeric variables (incl. calcols); one support weight
  // per dataset, shared with the Swath tab (catalog role, D3)
  var $wSel = document.getElementById('statsWeightSel');
  if ($wSel) {
    var curWeight = catRole('model', 'weight');
    var wOpts = '<option value="">— none</option>';
    for (var wci of numCols) {
      var wName = header[wci];
      wOpts += '<option value="' + esc(wName) + '"' + (wName === curWeight ? ' selected' : '') + '>' + esc(wName) + '</option>';
    }
    $wSel.innerHTML = wOpts;
    if (curWeight && $wSel.value !== curWeight) $wSel.value = '';
    var $wNote = document.getElementById('statsWeightNote');
    if ($wNote) {
      var noteParts = [];
      if (curWeight && lastCompleteData && lastCompleteData.weightApplied !== curWeight) noteParts.push('re-run analysis to apply');
      if (lastCompleteData && lastCompleteData.weightExcluded > 0) noteParts.push(lastCompleteData.weightExcluded.toLocaleString() + ' rows excluded (invalid weight)');
      $wNote.textContent = noteParts.join(' · ');
    }
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

  // Aux variables (when the aux dataset has been analyzed)
  var auxCols = getStatsAuxCols();
  if (auxCols.length > 0) {
    var auxLabel = auxPrefix || 'aux';
    html += '<div class="stats-aux-divider">' + esc(auxLabel) + ': ' + esc(auxFile ? auxFile.name : '') + '</div>';
    for (var k = 0; k < auxCols.length; k++) {
      var ac = auxCols[k];
      var dispName = auxLabel + ':' + ac.name;
      if (search && !fuzzyMatch(search, dispName.toLowerCase())) continue;
      var auxSel = isStatsAuxSelected(ac);
      html += '<div class="stats-var-item stats-var-item--aux' + (auxSel ? '' : ' unchecked') + '" data-aux-col="' + ac.idx + '">';
      html += '<input type="checkbox"' + (auxSel ? ' checked' : '') + ' data-aux-col="' + ac.idx + '">';
      html += '<span class="var-name">' + esc(dispName) + '</span>';
      html += '</div>';
    }
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

  // Selected aux columns, paired to their same-named primary where possible
  var auxSelectedCols = getStatsAuxCols().filter(isStatsAuxSelected);
  var auxByMatch = {};
  var auxUnmatched = [];
  auxSelectedCols.forEach(function(ac) {
    if (ac.matchCi !== null) (auxByMatch[ac.matchCi] = auxByMatch[ac.matchCi] || []).push(ac);
    else auxUnmatched.push(ac);
  });
  var auxLabel = auxPrefix || 'aux';

  function auxRowHtml(ac) {
    var as = auxCompleteData.stats[ac.idx];
    var aCdfActive = statsCdfAuxSelected.has(ac.idx);
    var aNameClass = aCdfActive ? 'cdf-link cdf-active' : 'cdf-link';
    var rowHtml = '<tr class="stats-aux-row"><td><a class="' + aNameClass + '" data-aux-col="' + ac.idx + '" href="#">' + esc(auxLabel + ':' + ac.name) + '</a></td>';
    for (var m of metrics) rowHtml += '<td>' + formatStatValue(getStatValue(as, m), m) + '</td>';
    return rowHtml + '</tr>' + deltaRowHtml(ac);
  }

  // Δ% row: model vs aux, relative to aux (the reference dataset) — the
  // mean-difference % is the headline acceptance statistic in validation
  // comparison tables
  function deltaRowHtml(ac) {
    if (ac.matchCi === null || !stats[ac.matchCi]) return '';
    var ps = stats[ac.matchCi];
    var as = auxCompleteData.stats[ac.idx];
    var tip = '(' + header[ac.matchCi] + ' − ' + auxLabel + ':' + ac.name + ') / ' + auxLabel + ':' + ac.name;
    var rowHtml = '<tr class="stats-delta-row"><td title="' + esc(tip) + '">Δ%</td>';
    for (var m of metrics) rowHtml += '<td>' + formatDeltaPct(getStatValue(ps, m), getStatValue(as, m), m) + '</td>';
    return rowHtml + '</tr>';
  }

  if (visCols.length === 0 && auxSelectedCols.length === 0) {
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
    // Same-named aux rows directly beneath their primary
    if (auxByMatch[ci]) {
      for (var am = 0; am < auxByMatch[ci].length; am++) html += auxRowHtml(auxByMatch[ci][am]);
    }
  }
  // Matched aux rows whose primary is deselected still render, at the end
  var visSet = new Set(visCols);
  Object.keys(auxByMatch).forEach(function(ciKey) {
    if (!visSet.has(parseInt(ciKey))) {
      auxByMatch[ciKey].forEach(function(ac) { html += auxRowHtml(ac); });
    }
  });
  // Aux variables with no primary counterpart
  for (var au = 0; au < auxUnmatched.length; au++) html += auxRowHtml(auxUnmatched[au]);

  html += '</tbody></table>';
  $statsContent.innerHTML = html;
}

function renderStatsCdfPanel() {
  var chart = document.getElementById('statsCdfChart');
  if (!chart) return;

  if (statsCdfSelected.size === 0 && statsCdfAuxSelected.size === 0) {
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
  if (auxCompleteData && auxCompleteData.stats) {
    var auxLabel = auxPrefix || 'aux';
    statsCdfAuxSelected.forEach(function(ai) {
      var as = auxCompleteData.stats[ai];
      if (as && as.centroids && as.centroids.length > 0) {
        entries.push([auxLabel + ':' + auxCompleteData.header[ai], as, true]); // [2]=isAux → dashed
      }
    });
  }

  if (entries.length === 0) {
    chart.innerHTML = '<div class="stats-cdf-hint">No centroid data for selected columns</div>';
    return;
  }

  if (statsCdfMode === 'qq') {
    if (entries.length < 2) {
      chart.innerHTML = '<div class="stats-cdf-hint">Q–Q needs two curves — click another variable name (the first selected is the reference axis)</div>';
    } else {
      chart.innerHTML = renderStatsQqSvg(entries);
    }
  } else {
    chart.innerHTML = renderStatsCdfSvg(entries);
    wireStatsCdfTooltip();
  }

  // Update toolbar buttons
  document.querySelectorAll('#statsCdfToolbar .stats-scale').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.scale === statsCdfScale);
  });
  document.querySelectorAll('#statsCdfToolbar .stats-cdfmode').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.cdfmode === statsCdfMode);
  });
}

// Quantile–quantile plot: the first selected curve is the reference (X);
// every other curve plots its quantiles against the reference's at matched
// percentiles. Bias reads as offset from the 45° identity line; support
// smoothing as slope rotation. The classic model-vs-samples companion to
// the CDF overlay.
function renderStatsQqSvg(entries) {
  var isLog = statsCdfScale === 'log';
  var W = chartHostWidth(document.getElementById('statsCdfChart'), 700), plotBaseH = 420;
  var pad = { top: 20, right: 30, bottom: 64, left: 70 };
  var plotW = W - pad.left - pad.right;
  var plotH = plotBaseH - pad.top - pad.bottom;

  var legCols = 3;
  var legRowH = 16;
  var legRows = Math.ceil((entries.length - 1) / legCols);
  var legendH = 12 + legRows * legRowH + 6;
  var H = plotBaseH + legendH;

  // Quantile pairs at P1..P99
  var ref = entries[0];
  var qs = [];
  for (var p = 1; p <= 99; p++) qs.push(p / 100);
  var refQ = qs.map(function(q) { return tdQuantileFromCentroids(ref[1].centroids, ref[1].count, q); });

  var series = [];
  for (var si = 1; si < entries.length; si++) {
    var e = entries[si];
    series.push({
      name: e[0],
      isAux: !!e[2],
      color: STATSCAT_PALETTE[si % STATSCAT_PALETTE.length],
      q: qs.map(function(q) { return tdQuantileFromCentroids(e[1].centroids, e[1].count, q); })
    });
  }

  // Shared square range over everything plotted (identity line must be 45°)
  var lo = Infinity, hi = -Infinity;
  function take(v) { if (v == null) return; if (isLog && v <= 0) return; if (v < lo) lo = v; if (v > hi) hi = v; }
  refQ.forEach(take);
  series.forEach(function(s) { s.q.forEach(take); });
  if (!isFinite(lo) || !isFinite(hi)) return '<div class="stats-cdf-hint">No plottable quantiles' + (isLog ? ' (log scale needs positive values)' : '') + '</div>';
  if (hi <= lo) hi = lo + 1;
  var pad5 = isLog ? 0 : (hi - lo) * 0.05;
  lo -= pad5; hi += pad5;
  var lLo = isLog ? Math.log10(Math.max(lo, 1e-10)) : 0;
  var lHi = isLog ? Math.log10(Math.max(hi, 1e-9)) : 0;
  if (isLog && lHi <= lLo) lHi = lLo + 1;

  function sx(v) {
    if (isLog) return pad.left + ((Math.log10(Math.max(v, 1e-10)) - lLo) / (lHi - lLo)) * plotW;
    return pad.left + ((v - lo) / (hi - lo)) * plotW;
  }
  function sy(v) {
    if (isLog) return pad.top + plotH - ((Math.log10(Math.max(v, 1e-10)) - lLo) / (lHi - lLo)) * plotH;
    return pad.top + plotH - ((v - lo) / (hi - lo)) * plotH;
  }

  // Grid + ticks (same values both axes — the plot is square by construction)
  var gridSvg = '';
  var nTicks = 6;
  for (var ti = 0; ti <= nTicks; ti++) {
    var v = isLog ? Math.pow(10, lLo + ((lHi - lLo) * ti / nTicks)) : (lo + ((hi - lo) * ti / nTicks));
    var label = Math.abs(v) >= 1e5 || (Math.abs(v) < 0.01 && v !== 0) ? v.toExponential(1) : v.toFixed(Math.abs(v) < 10 ? 2 : 0);
    var x = sx(v), y = sy(v);
    gridSvg += '<line x1="' + x.toFixed(1) + '" y1="' + pad.top + '" x2="' + x.toFixed(1) + '" y2="' + (pad.top + plotH) + '" stroke="#1e2228" stroke-width="1"/>';
    gridSvg += '<text x="' + x.toFixed(1) + '" y="' + (pad.top + plotH + 16) + '" text-anchor="middle" fill="#6a737d" font-size="10">' + label + '</text>';
    gridSvg += '<line x1="' + pad.left + '" y1="' + y.toFixed(1) + '" x2="' + (pad.left + plotW) + '" y2="' + y.toFixed(1) + '" stroke="#1e2228" stroke-width="1"/>';
    gridSvg += '<text x="' + (pad.left - 8) + '" y="' + (y + 3.5).toFixed(1) + '" text-anchor="end" fill="#6a737d" font-size="10">' + label + '</text>';
  }

  // 45° identity line
  var idSvg = '<line x1="' + sx(isLog ? Math.pow(10, lLo) : lo) + '" y1="' + sy(isLog ? Math.pow(10, lLo) : lo) +
    '" x2="' + sx(isLog ? Math.pow(10, lHi) : hi) + '" y2="' + sy(isLog ? Math.pow(10, lHi) : hi) +
    '" stroke="#6a737d" stroke-width="1" stroke-dasharray="5,4" opacity="0.7"/>';

  // Points — emphasized deciles, native <title> tooltips
  var ptsSvg = '';
  series.forEach(function(s) {
    for (var i = 0; i < qs.length; i++) {
      var xv = refQ[i], yv = s.q[i];
      if (xv == null || yv == null) continue;
      if (isLog && (xv <= 0 || yv <= 0)) continue;
      var isDecile = ((i + 1) % 10) === 0 || i === 49;
      var r = isDecile ? 3.4 : 2;
      var fill = s.isAux ? 'none' : s.color;
      var stroke = s.isAux ? ' stroke="' + s.color + '" stroke-width="1.2"' : '';
      ptsSvg += '<circle cx="' + sx(xv).toFixed(1) + '" cy="' + sy(yv).toFixed(1) + '" r="' + r + '" fill="' + fill + '"' + stroke + ' opacity="0.85">' +
        '<title>P' + (i + 1) + ' — ' + esc(entries[0][0]) + ': ' + formatNum(xv) + ' · ' + esc(s.name) + ': ' + formatNum(yv) + '</title></circle>';
    }
  });

  // Legend (series only; reference is the X axis)
  var legTop = plotBaseH + 12;
  var colW = plotW / legCols;
  var legendSvg = '';
  series.forEach(function(s, li) {
    var col = li % legCols;
    var row = Math.floor(li / legCols);
    var lx = pad.left + col * colW;
    var ly = legTop + row * legRowH;
    legendSvg += s.isAux
      ? '<circle cx="' + (lx + 6) + '" cy="' + (ly + 5) + '" r="3.4" fill="none" stroke="' + s.color + '" stroke-width="1.4"/>'
      : '<circle cx="' + (lx + 6) + '" cy="' + (ly + 5) + '" r="3.4" fill="' + s.color + '"/>';
    legendSvg += '<text x="' + (lx + 16) + '" y="' + (ly + 9) + '" fill="#6a737d" font-size="9.5">' + esc(s.name) + '</text>';
  });

  var scaleLabel = isLog ? ' (log–log)' : '';
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" style="font-family:var(--mono)" id="statsCdfSvg">' +
    '<rect width="' + W + '" height="' + H + '" fill="var(--bg)" rx="4"/>' +
    gridSvg + idSvg + ptsSvg +
    '<text x="' + (W / 2) + '" y="' + (plotBaseH - 18) + '" text-anchor="middle" fill="#6a737d" font-size="10">' + esc(entries[0][0]) + ' quantiles' + scaleLabel + '</text>' +
    '<text x="14" y="' + (pad.top + plotH / 2) + '" text-anchor="middle" fill="#6a737d" font-size="10" transform="rotate(-90, 14, ' + (pad.top + plotH / 2) + ')">compared quantiles</text>' +
    '<text x="' + (W / 2) + '" y="' + (plotBaseH - 4) + '" text-anchor="middle" fill="#6a737d" font-size="9" opacity="0.7">P1–P99 · large dots at deciles · dashed = identity (no bias)</text>' +
    legendSvg +
    '</svg>';
}

// Inverse standard normal CDF — GSLIB gauinv (Kennedy & Gentle 1980, p.95),
// f64 throughout. Drives the probability-scale axis of the log-prob plot.
function normInv(p) {
  var lim = 1e-10;
  if (p < lim) return -1e10;
  if (p > 1 - lim) return 1e10;
  if (p === 0.5) return 0;
  var pp = p > 0.5 ? 1 - p : p;
  var y = Math.sqrt(Math.log(1 / (pp * pp)));
  var xp = y + ((((y * -0.0000453642210148 + -0.0204231210245) * y + -0.342242088547) * y + -1.0) * y + -0.322232431088) /
               ((((y * 0.0038560700634 + 0.103537752850) * y + 0.531103462366) * y + 0.588581570495) * y + 0.0993484626060);
  return p === pp ? -xp : xp;
}

// The classic probability-paper ruling (0.2%–99.8%, deciles emphasized in
// validation figures); the axis spans normInv of the extremes
var STATS_LOGPROB_TICKS = [0.002, 0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99, 0.998];

function renderStatsCdfSvg(entries) {
  var isLog = statsCdfScale === 'log';
  var probScale = statsCdfMode === 'logprob';
  var W = chartHostWidth(document.getElementById('statsCdfChart'), 700), plotBaseH = 380;
  var pad = { top: 20, right: 30, bottom: 50, left: 60 };
  var plotW = W - pad.left - pad.right;
  var plotH = plotBaseH - pad.top - pad.bottom;
  var zLo = normInv(STATS_LOGPROB_TICKS[0]);
  var zHi = normInv(STATS_LOGPROB_TICKS[STATS_LOGPROB_TICKS.length - 1]);

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
  function sy(v) {
    if (probScale) {
      var z = normInv(Math.min(Math.max(v, STATS_LOGPROB_TICKS[0]), STATS_LOGPROB_TICKS[STATS_LOGPROB_TICKS.length - 1]));
      return pad.top + (1 - (z - zLo) / (zHi - zLo)) * plotH;
    }
    return pad.top + (1 - v) * plotH;
  }

  var yTicks = probScale ? STATS_LOGPROB_TICKS : [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0];
  var gridSvg = '';
  for (var yi = 0; yi < yTicks.length; yi++) {
    var yt = yTicks[yi];
    var y = sy(yt);
    var ytLabel = probScale
      ? (yt * 100 < 1 || yt * 100 > 99 ? (yt * 100).toFixed(1) : (yt * 100).toFixed(0))
      : (yt * 100).toFixed(0);
    gridSvg += '<line x1="' + pad.left + '" y1="' + y + '" x2="' + (W - pad.right) + '" y2="' + y + '" stroke="#1e2228" stroke-width="1"/>';
    gridSvg += '<text x="' + (pad.left - 8) + '" y="' + (y + 3.5) + '" text-anchor="end" fill="#6a737d" font-size="10">' + ytLabel + '%</text>';
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
      var cumP = cumCount / eStats.count;
      // Probability paper has no 0%/100% — points beyond the ruling are off-scale
      if (probScale && (cumP < STATS_LOGPROB_TICKS[0] || cumP > STATS_LOGPROB_TICKS[STATS_LOGPROB_TICKS.length - 1])) continue;
      var px = sx(cMean);
      if (px < pad.left || px > W - pad.right) continue;
      points.push({ x: px, y: sy(cumP) });
    }
    if (points.length > 0) {
      var pathParts = points.map(function(p, i) { return (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1); });
      var dash = entries[gi][2] ? ' stroke-dasharray="6,4"' : '';
      curvesSvg += '<path d="' + pathParts.join(' ') + '" fill="none" stroke="' + color + '" stroke-width="1.5" opacity="0.85"' + dash + '/>';
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
    legendSvg += '<line x1="' + lx + '" y1="' + (ly + 5) + '" x2="' + (lx + 18) + '" y2="' + (ly + 5) + '" stroke="' + lColor + '" stroke-width="2.5"' + (entries[li][2] ? ' stroke-dasharray="4,3"' : '') + '/>';
    legendSvg += '<text x="' + (lx + 24) + '" y="' + (ly + 9) + '" fill="#6a737d" font-size="9.5">' + esc(lName) + '</text>';
  }

  // Store params for tooltip interaction
  _statsCdfParams = {
    entries: entries, isLog: isLog,
    probScale: probScale, zLo: zLo, zHi: zHi,
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
  var titleLabel = probScale ? (isLog ? 'Log-probability' : 'Probability' + scaleLabel) : 'CDF' + scaleLabel;
  var yAxisLabel = probScale ? 'Cumulative % (normal probability scale)' : 'Cumulative %';
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" style="font-family:var(--mono)" id="statsCdfSvg">' +
    '<rect width="' + W + '" height="' + H + '" fill="var(--bg)" rx="4"/>' +
    gridSvg + meansSvg + curvesSvg + overlaySvg +
    '<text x="' + (W / 2) + '" y="' + (plotBaseH - 4) + '" text-anchor="middle" fill="#6a737d" font-size="10">' + titleLabel + '</text>' +
    '<text x="12" y="' + (plotBaseH / 2) + '" text-anchor="middle" fill="#6a737d" font-size="10" transform="rotate(-90, 12, ' + (plotBaseH / 2) + ')">' + yAxisLabel + '</text>' +
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
    if (p.probScale) {
      var lo = STATS_LOGPROB_TICKS[0], hi = STATS_LOGPROB_TICKS[STATS_LOGPROB_TICKS.length - 1];
      var z = normInv(Math.min(Math.max(cdf, lo), hi));
      return p.pad.top + (1 - (z - p.zLo) / (p.zHi - p.zLo)) * p.plotH;
    }
    return p.pad.top + (1 - cdf) * p.plotH;
  }

  overlay.addEventListener('pointermove', function(e) {
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
        var pctTxt = (p.probScale && (cdf * 100 < 1 || cdf * 100 > 99)) ? (cdf * 100).toFixed(2) : (cdf * 100).toFixed(1);
        lines += '<div><span style="color:' + color + '">\u25CF</span> ' + esc(eName) + ': ' + pctTxt + '%</div>';
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

  overlay.addEventListener('pointerleave', function() {
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

  // --- Weight select (static template element) ---
  // Shared support weight (D3): writing here also re-points the Swath
  // tab's weight select — one role, two views
  document.getElementById('statsWeightSel').addEventListener('change', function() {
    catSetRole('model', 'weight', this.value || null);
    var $sw = document.getElementById('swathWeight');
    if ($sw) $sw.value = this.value || '';
    markAnalysisStale();
    renderStatsSidebar();
    autoSaveProject();
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
    var acb = e.target.closest('input[data-aux-col]');
    if (acb) {
      materializeStatsAuxSelected();
      var aIdx = parseInt(acb.dataset.auxCol);
      if (acb.checked) statsAuxSelected.add(aIdx);
      else statsAuxSelected.delete(aIdx);
      var aItem = acb.closest('.stats-var-item');
      if (aItem) aItem.classList.toggle('unchecked', !acb.checked);
      renderStatsTable();
      autoSaveProject();
      return;
    }
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
    document.getElementById('statsVarList').querySelectorAll('.stats-var-item[data-col]').forEach(function(el) {
      statsSelectedVars.add(parseInt(el.dataset.col));
    });
    materializeStatsAuxSelected();
    document.getElementById('statsVarList').querySelectorAll('.stats-var-item[data-aux-col]').forEach(function(el) {
      statsAuxSelected.add(parseInt(el.dataset.auxCol));
    });
    renderStatsSidebar();
    renderStatsTable();
    autoSaveProject();
  });
  document.getElementById('statsVarNone').addEventListener('click', function() {
    if (statsSelectedVars === null) statsSelectedVars = new Set(_statsNumCols);
    document.getElementById('statsVarList').querySelectorAll('.stats-var-item[data-col]').forEach(function(el) {
      statsSelectedVars.delete(parseInt(el.dataset.col));
    });
    materializeStatsAuxSelected();
    document.getElementById('statsVarList').querySelectorAll('.stats-var-item[data-aux-col]').forEach(function(el) {
      statsAuxSelected.delete(parseInt(el.dataset.auxCol));
    });
    renderStatsSidebar();
    renderStatsTable();
    autoSaveProject();
  });

  // --- Variable search (static template element) ---
  var $statsVarSearch = document.getElementById('statsVarSearch');
  $statsVarSearch.addEventListener('input', function() {
    renderStatsSidebar();
  });
  wireSearchShortcuts($statsVarSearch, document.getElementById('statsVarAll'), document.getElementById('statsVarNone'));

  // --- CDF links in table (delegation on container — innerHTML changes) ---
  $statsContent.addEventListener('click', function(e) {
    var link = e.target.closest('.cdf-link');
    if (!link) return;
    e.preventDefault();
    if (link.dataset.auxCol !== undefined) {
      var aCol = parseInt(link.dataset.auxCol);
      if (statsCdfAuxSelected.has(aCol)) statsCdfAuxSelected.delete(aCol);
      else statsCdfAuxSelected.add(aCol);
    } else {
      var col = parseInt(link.dataset.col);
      if (statsCdfSelected.has(col)) statsCdfSelected.delete(col);
      else statsCdfSelected.add(col);
    }
    renderStatsTable();
    renderStatsCdfPanel();
    autoSaveProject();
  });

  // --- CDF scale + mode buttons (static template elements) ---
  document.getElementById('statsCdfToolbar').addEventListener('click', function(e) {
    var modeBtn = e.target.closest('.stats-cdfmode');
    if (modeBtn) {
      statsCdfMode = modeBtn.dataset.cdfmode;
      renderStatsCdfPanel();
      autoSaveProject();
      return;
    }
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
