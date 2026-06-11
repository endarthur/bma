// ─── Top-cut analysis — Aux tab main-area view ─────────────────────────
// Supervisor-style Global Topcut Analysis on the aux samples: one worker
// pass returns the SORTED finite values of a variable (after the aux
// filter); prefix sums then make every candidate cap O(log n), so the cap
// line is live while dragging across four linked plots — histogram,
// log-probability, mean & CV vs cap, and % metal above cap. No auto-pick:
// the plots are the evidence, the user moves the line. Applying a cap is a
// one-click calcol (cap() already lives in the Math preamble).

var $auxViewToggle = document.getElementById('auxViewToggle');
var $auxTopcut = document.getElementById('auxTopcut');

function auxTopcutFingerprintNow() {
  if (!auxFile || !auxPreflightData) return null;
  var useDeclus = !!(auxTopcut && auxTopcut.useDeclus);
  return JSON.stringify({
    f: auxFile.name + '|' + auxFile.size,
    z: auxPreflightData.selectedZipEntry || null,
    flt: auxFilter ? auxFilter.expression : '',
    cc: auxCalcolCode || '',
    // Weight mode is part of the distribution's identity: flipping
    // Raw | Declustered (or re-running declus) demands a reload
    uw: useDeclus,
    dw: useDeclus && auxDeclus ? auxDeclus.fingerprint : null
  });
}

function auxTopcutFresh() {
  return !!(auxTopcut && auxTopcut.values && auxTopcut.fingerprint === auxTopcutFingerprintNow());
}

function renderAuxView() {
  if (!$auxViewToggle) return;
  var hasAux = !!auxPreflightData;
  $auxViewToggle.style.display = hasAux ? '' : 'none';
  $auxViewToggle.querySelectorAll('.aux-view-btn').forEach(function(b) {
    b.classList.toggle('active', b.dataset.auxview === auxView);
  });
  var showTopcut = hasAux && auxView === 'topcut';
  if ($auxPreview) $auxPreview.style.display = showTopcut ? 'none' : '';
  if ($auxTopcut) $auxTopcut.style.display = showTopcut ? '' : 'none';
  if (showTopcut) renderAuxTopcut();
}

// ── Capped statistics from (weighted) prefix sums ──
// k = count of values ≤ c (binary search); prefixS/prefixSS carry Σw·v and
// Σw·v² (w=1 in raw mode, prefixW = counts), so every capped moment is
// arithmetic: sum' = S[k] + (W−W[k])·c, ss' = SS[k] + (W−W[k])·c².
// Weighted runs use population variance, raw keeps the sample form —
// the same convention as every other weighted statistic in BMA.
function auxTopcutCappedStats(c) {
  var t = auxTopcut;
  var v = t.values, m = v.length;
  var lo = 0, hi = m;
  while (lo < hi) { var mid = (lo + hi) >> 1; if (v[mid] <= c) lo = mid + 1; else hi = mid; }
  var k = lo;
  var W = t.prefixW[m];
  var wAbove = W - t.prefixW[k];
  var sum = t.prefixS[k] + wAbove * c;
  var ss = t.prefixSS[k] + wAbove * c * c;
  var mean = sum / W;
  var variance;
  if (t.weights) variance = Math.max(0, ss / W - mean * mean);
  else variance = m > 1 ? Math.max(0, (ss - sum * sum / m) / (m - 1)) : 0;
  var std = Math.sqrt(variance);
  var metalRemoved = (t.prefixS[m] - t.prefixS[k]) - wAbove * c;
  return {
    k: k, nCapped: m - k, capShare: W > 0 ? wAbove / W : 0,
    mean: mean, std: std,
    cv: mean !== 0 ? Math.abs(std / mean * 100) : null,
    metalRemovedPct: t.prefixS[m] > 0 ? metalRemoved / t.prefixS[m] * 100 : 0
  };
}

function renderAuxTopcut() {
  if (!$auxTopcut || !auxPreflightData) return;
  var t = auxTopcut;

  // Variable options: numeric raw columns + numeric aux calcols
  var chosen = (t && t.varName) || null;
  var varOpts = '';
  for (var i = 0; i < auxPreflightData.header.length; i++) {
    if ((auxPreflightData.autoTypes || [])[i] !== 'numeric') continue;
    var nm = auxPreflightData.header[i];
    if (chosen === null) chosen = nm;
    varOpts += '<option value="' + esc(nm) + '"' + (nm === chosen ? ' selected' : '') + '>' + esc(nm) + '</option>';
  }
  for (var ci = 0; ci < auxCalcolMeta.length; ci++) {
    if (auxCalcolMeta[ci].type !== 'numeric') continue;
    var cn = auxCalcolMeta[ci].name;
    varOpts += '<option value="' + esc(cn) + '"' + (cn === chosen ? ' selected' : '') + '>' + esc(cn) + ' (calc)</option>';
  }

  var html = '<div class="tc-toolbar">' +
    '<label>Variable</label>' +
    '<select class="aux-select" id="auxTopcutVar" style="width:auto;min-width:120px">' + varOpts + '</select>' +
    '<button class="aux-from-main-btn" id="auxTopcutLoadBtn">' + (auxTopcutFresh() ? 'Reload' : 'Load distribution') + '</button>' +
    '<span class="aux-hint" id="auxTopcutStatus" style="margin:0"></span>' +
  '</div>';

  if (!auxTopcutFresh()) {
    if (t && t.varName && !t.values) {
      html += '<div class="tc-empty">Restored top-cut config (' + esc(t.varName) + (t.cap != null ? ', cap ' + formatNum(t.cap) : '') + ') — load the distribution to continue.</div>';
    } else if (t && t.values) {
      html += '<div class="tc-empty" style="color:var(--amber)">Aux config changed since this distribution was loaded — reload.</div>';
    } else {
      html += '<div class="tc-empty">Load a variable’s sample distribution to analyse top cuts: histogram, log-probability, mean & CV vs cap, and metal above cap, with a draggable cap line across all four.</div>';
    }
    $auxTopcut.innerHTML = html;
    return;
  }

  var m = t.values.length;
  var vMin = t.values[0], vMax = t.values[m - 1];
  if (t.cap == null || !(t.cap >= vMin && t.cap <= vMax)) {
    t.cap = t.values[Math.min(m - 1, Math.floor(0.99 * m))]; // starting handle at P99 — a position, not a recommendation
  }
  var un = auxTopcutCappedStats(vMax);
  var cs = auxTopcutCappedStats(t.cap);

  var canLog = vMin > 0;
  if (!canLog) t.xlog = false;
  html += '<div class="tc-stats" id="auxTopcutStats">' + auxTopcutStatsHtml(un, cs) + '</div>';
  html += '<div class="tc-caprow">' +
    '<label>Cap</label>' +
    '<input type="text" class="aux-input" id="auxTopcutCapInput" value="' + formatNum(t.cap) + '" spellcheck="false" style="width:90px">' +
    '<button class="aux-from-main-btn" id="auxTopcutCopyBtn" title="copy a capping calcol for the Calc tab (Aux mode)">Copy calcol</button>' +
    '<span class="aux-hint" id="auxTopcutCopied" style="margin:0"></span>' +
    '<span style="margin-left:auto;display:flex;gap:0.25rem">' +
      '<button class="aux-view-btn' + (!t.useDeclus ? ' active' : '') + '" id="auxTopcutWRaw" title="raw sample distribution — the capping convention">Raw</button>' +
      '<button class="aux-view-btn' + (t.useDeclus ? ' active' : '') + '" id="auxTopcutWDeclus"' +
        (typeof auxDeclusFresh === 'function' && auxDeclusFresh()
          ? ' title="weight every statistic by the declustering weights — capped means/metal unbiased by drilling pattern"'
          : ' disabled title="run Declustering on the sidebar first (weights missing or stale)"') + '>Declustered</button>' +
      '<span style="width:0.4rem"></span>' +
      '<button class="aux-view-btn' + (!t.xlog ? ' active' : '') + '" id="auxTopcutXLin">Linear</button>' +
      '<button class="aux-view-btn' + (t.xlog ? ' active' : '') + '" id="auxTopcutXLog"' +
        (canLog ? ' title="log value axis on all four plots"' : ' disabled title="log X needs all values > 0 (min here is ' + formatNum(vMin) + ')"') + '>Log</button>' +
    '</span>' +
  '</div>';
  html += '<div class="tc-grid">' +
    '<div class="tc-plot">' + auxTopcutHistSvg() + '</div>' +
    '<div class="tc-plot">' + auxTopcutLogProbSvg() + '</div>' +
    '<div class="tc-plot">' + auxTopcutMeanCvSvg() + '</div>' +
    '<div class="tc-plot">' + auxTopcutMetalSvg() + '</div>' +
  '</div>';
  html += '<div class="aux-hint">drag the cap line on any plot (or type a value) · n ' + m.toLocaleString() +
    (t.n > m + (t.weightExcluded || 0) ? ' (+' + (t.n - m - (t.weightExcluded || 0)) + ' non-numeric/null excluded)' : '') +
    (t.weightExcluded ? ' (+' + t.weightExcluded + ' invalid-weight excluded)' : '') +
    ' · ' + (t.weights ? 'declustering-weighted distribution' : 'raw unweighted sample distribution (the capping convention)') + '</div>';

  $auxTopcut.innerHTML = html;
  auxTopcutPositionCaps();
}

function auxTopcutStatsHtml(un, cs) {
  var t = auxTopcut;
  function d(a, b) {
    if (b === 0 || b == null || a == null) return '';
    var p = (a - b) / Math.abs(b) * 100;
    return ' <span class="tc-delta">(' + (p >= 0 ? '+' : '−') + Math.abs(p).toFixed(1) + '%)</span>';
  }
  return '<span><em>uncapped' + (t.weights ? ' (declustered)' : '') + '</em> mean <strong>' + formatNum(un.mean) + '</strong> · CV ' + (un.cv != null ? un.cv.toFixed(1) : '—') + ' · max ' + formatNum(t.values[t.values.length - 1]) + '</span>' +
    '<span><em>cap ' + formatNum(t.cap) + '</em> caps <strong>' + cs.nCapped.toLocaleString() + '</strong> <span title="' + (t.weights ? 'share of total declustering weight' : 'share of samples') + '">(' + (cs.capShare * 100).toFixed(2) + '%)</span>' +
    ' · mean <strong>' + formatNum(cs.mean) + '</strong>' + d(cs.mean, un.mean) +
    ' · CV ' + (cs.cv != null ? cs.cv.toFixed(1) : '—') + d(cs.cv, un.cv) +
    ' · metal removed <strong>' + cs.metalRemovedPct.toFixed(2) + '%</strong></span>';
}

// ── Plot geometry ── all four share the value domain on X, so the cap drag
// is the same mapping everywhere; per-svg constants ride in data attributes
var TC_PLOT = { W: 430, H: 215, padL: 46, padR: 14, padT: 18, padB: 30 };

function tcAxis(x0, x1, xlog) {
  var P = TC_PLOT, plotW = P.W - P.padL - P.padR;
  var lx0 = xlog ? Math.log10(x0) : x0, lx1 = xlog ? Math.log10(x1) : x1;
  if (lx1 <= lx0) lx1 = lx0 + 1;
  return {
    sx: function(v) { var lv = xlog ? Math.log10(Math.max(v, 1e-12)) : v; return P.padL + (lv - lx0) / (lx1 - lx0) * plotW; },
    attrs: ' data-x0="' + x0 + '" data-x1="' + x1 + '" data-xlog="' + (xlog ? 1 : 0) + '"',
    plotW: plotW
  };
}

function tcFrame(title, yLabel) {
  var P = TC_PLOT;
  return '<text x="' + (P.W / 2) + '" y="11" text-anchor="middle" fill="#6a737d" font-size="9.5">' + title + '</text>' +
    (yLabel ? '<text x="10" y="' + ((P.padT + P.H - P.padB) / 2) + '" text-anchor="middle" fill="#6a737d" font-size="9" transform="rotate(-90, 10, ' + ((P.padT + P.H - P.padB) / 2) + ')">' + yLabel + '</text>' : '');
}

function tcCapMarker(ax) {
  var P = TC_PLOT;
  var x = ax.sx(auxTopcut.cap).toFixed(1);
  return '<g class="tc-cap"><line x1="' + x + '" x2="' + x + '" y1="' + P.padT + '" y2="' + (P.H - P.padB) + '" stroke="var(--red, #e05555)" stroke-width="1.2" stroke-dasharray="5,3"/>' +
    '<text x="' + x + '" y="' + (P.padT - 4 + 10) + '" fill="var(--red, #e05555)" font-size="8.5" text-anchor="middle"></text></g>';
}

function tcXTicks(ax, x0, x1, xlog) {
  var P = TC_PLOT, out = '';
  for (var i = 0; i <= 4; i++) {
    var v = xlog ? Math.pow(10, Math.log10(x0) + (Math.log10(x1) - Math.log10(x0)) * i / 4) : x0 + (x1 - x0) * i / 4;
    var x = ax.sx(v);
    out += '<line x1="' + x.toFixed(1) + '" x2="' + x.toFixed(1) + '" y1="' + P.padT + '" y2="' + (P.H - P.padB) + '" stroke="#1e2228"/>' +
      '<text x="' + x.toFixed(1) + '" y="' + (P.H - P.padB + 13) + '" text-anchor="middle" fill="#6a737d" font-size="8.5">' + formatNum(v) + '</text>';
  }
  return out;
}

function tcSvgOpen(ax) {
  var P = TC_PLOT;
  return '<svg class="tc-svg" viewBox="0 0 ' + P.W + ' ' + P.H + '"' + ax.attrs + '><rect width="' + P.W + '" height="' + P.H + '" fill="var(--bg)" rx="3"/>';
}

function auxTopcutHistSvg() {
  var t = auxTopcut, v = t.values, m = v.length, P = TC_PLOT;
  var xlog = !!t.xlog;
  var x0 = v[0], x1 = v[m - 1];
  if (x1 <= x0) x1 = x0 + 1;
  var ax = tcAxis(x0, x1, xlog);
  // Bins are equal-width in display space: log-spaced bins under log X;
  // weighted mode stacks declustering weight instead of counts
  var nb = 50, bins = new Array(nb).fill(0);
  var l0 = xlog ? Math.log10(x0) : x0, l1 = xlog ? Math.log10(x1) : x1;
  for (var i = 0; i < m; i++) {
    var lv = xlog ? Math.log10(v[i]) : v[i];
    var b = Math.min(nb - 1, Math.max(0, Math.floor((lv - l0) / (l1 - l0) * nb)));
    bins[b] += t.weights ? t.weights[i] : 1;
  }
  var bMax = Math.max.apply(null, bins) || 1;
  var plotH = P.H - P.padT - P.padB;
  var bw = ax.plotW / nb;
  var bars = '';
  for (var b2 = 0; b2 < nb; b2++) {
    if (!bins[b2]) continue;
    var bh = bins[b2] / bMax * plotH;
    bars += '<rect x="' + (P.padL + b2 * bw).toFixed(1) + '" y="' + (P.padT + plotH - bh).toFixed(1) + '" width="' + Math.max(0.5, bw - 0.6).toFixed(1) + '" height="' + bh.toFixed(1) + '" fill="rgba(240,178,50,0.45)"/>';
  }
  return tcSvgOpen(ax) + tcXTicks(ax, x0, x1, xlog) + bars + tcCapMarker(ax) + tcFrame('Histogram' + (xlog ? ' (log X)' : ''), 'count') + '</svg>';
}

function auxTopcutLogProbSvg() {
  var t = auxTopcut, v = t.values, m = v.length, P = TC_PLOT;
  var xlog = !!t.xlog;
  var x0 = v[0], x1 = v[m - 1];
  if (x1 <= x0) x1 = x0 + 1;
  var ax = tcAxis(x0, x1, xlog);
  var pLo = STATS_LOGPROB_TICKS[0], pHi = STATS_LOGPROB_TICKS[STATS_LOGPROB_TICKS.length - 1];
  var zLo = normInv(pLo), zHi = normInv(pHi);
  var plotH = P.H - P.padT - P.padB;
  function sy(p) { return P.padT + (1 - (normInv(p) - zLo) / (zHi - zLo)) * plotH; }
  var grid = '';
  [0.01, 0.1, 0.5, 0.9, 0.99].forEach(function(p) {
    var y = sy(p).toFixed(1);
    grid += '<line x1="' + P.padL + '" x2="' + (P.W - P.padR) + '" y1="' + y + '" y2="' + y + '" stroke="#1e2228"/>' +
      '<text x="' + (P.padL - 4) + '" y="' + (+y + 3) + '" text-anchor="end" fill="#6a737d" font-size="8">' + (p * 100) + '%</text>';
  });
  // Cumulative probability is weight-cumulative in declustered mode
  var step = Math.max(1, Math.floor(m / 360));
  var pts = '';
  var W = t.prefixW[m];
  for (var i = 0; i < m; i += step) {
    var p = t.weights
      ? (t.prefixW[i] + t.weights[i] / 2) / W
      : (i + 0.5) / m;
    if (p < pLo || p > pHi) continue;
    pts += '<circle cx="' + ax.sx(v[i]).toFixed(1) + '" cy="' + sy(p).toFixed(1) + '" r="1.2" fill="var(--amber)" opacity="0.7"/>';
  }
  return tcSvgOpen(ax) + grid + tcXTicks(ax, x0, x1, xlog) + pts + tcCapMarker(ax) +
    tcFrame((xlog ? 'Log-probability' : 'Probability (linear X)') + (t.weights ? ' · declustered' : ''), 'cum %') + '</svg>';
}

function auxTopcutMeanCvSvg() {
  var t = auxTopcut, v = t.values, m = v.length, P = TC_PLOT;
  var xlog = !!t.xlog;
  var x0 = v[Math.floor(m * 0.5)], x1 = v[m - 1];
  if (x1 <= x0) { x0 = v[0]; x1 = v[m - 1] || x0 + 1; }
  if (x1 <= x0) x1 = x0 + 1;
  var ax = tcAxis(x0, x1, xlog);
  var N = 220, means = [], cvs = [];
  var mnLo = Infinity, mnHi = -Infinity, cvLo = Infinity, cvHi = -Infinity;
  for (var i = 0; i <= N; i++) {
    var c = xlog ? Math.pow(10, Math.log10(x0) + (Math.log10(x1) - Math.log10(x0)) * i / N)
                 : x0 + (x1 - x0) * i / N;
    var s = auxTopcutCappedStats(c);
    means.push([c, s.mean]); cvs.push([c, s.cv]);
    if (s.mean < mnLo) mnLo = s.mean; if (s.mean > mnHi) mnHi = s.mean;
    if (s.cv != null) { if (s.cv < cvLo) cvLo = s.cv; if (s.cv > cvHi) cvHi = s.cv; }
  }
  if (mnHi <= mnLo) mnHi = mnLo + 1;
  if (cvHi <= cvLo) cvHi = cvLo + 1;
  var plotH = P.H - P.padT - P.padB;
  function syM(y) { return P.padT + (1 - (y - mnLo) / (mnHi - mnLo)) * plotH; }
  function syC(y) { return P.padT + (1 - (y - cvLo) / (cvHi - cvLo)) * plotH; }
  var pM = means.map(function(p2, i2) { return (i2 ? 'L' : 'M') + ax.sx(p2[0]).toFixed(1) + ',' + syM(p2[1]).toFixed(1); }).join('');
  var pC = cvs.filter(function(p2) { return p2[1] != null; }).map(function(p2, i2) { return (i2 ? 'L' : 'M') + ax.sx(p2[0]).toFixed(1) + ',' + syC(p2[1]).toFixed(1); }).join('');
  var legend = '<text x="' + (P.padL + 4) + '" y="' + (P.padT + 9) + '" fill="var(--amber)" font-size="8.5">mean</text>' +
    '<text x="' + (P.padL + 34) + '" y="' + (P.padT + 9) + '" fill="#56b6c2" font-size="8.5">CV</text>';
  return tcSvgOpen(ax) + tcXTicks(ax, x0, x1, xlog) +
    '<path d="' + pM + '" fill="none" stroke="var(--amber)" stroke-width="1.4"/>' +
    '<path d="' + pC + '" fill="none" stroke="#56b6c2" stroke-width="1.2"/>' +
    legend + tcCapMarker(ax) + tcFrame('Mean & CV vs cap' + (xlog ? ' (log X)' : ''), '') + '</svg>';
}

function auxTopcutMetalSvg() {
  var t = auxTopcut, v = t.values, m = v.length, P = TC_PLOT;
  var xlog = !!t.xlog;
  var x0 = v[0], x1 = v[m - 1];
  if (x1 <= x0) x1 = x0 + 1;
  var ax = tcAxis(x0, x1, xlog);
  var plotH = P.H - P.padT - P.padB;
  var total = t.prefixS[m] || 1;
  var N = 240, path = '';
  var yMax = 0, pts2 = [];
  for (var i = 0; i <= N; i++) {
    var c = xlog ? Math.pow(10, Math.log10(x0) + (Math.log10(x1) - Math.log10(x0)) * i / N)
                 : x0 + (x1 - x0) * i / N;
    var s = auxTopcutCappedStats(c);
    pts2.push([c, s.metalRemovedPct]);
    if (s.metalRemovedPct > yMax) yMax = s.metalRemovedPct;
  }
  if (yMax <= 0) yMax = 1;
  function sy(y) { return P.padT + (1 - y / yMax) * plotH; }
  path = pts2.map(function(p2, i2) { return (i2 ? 'L' : 'M') + ax.sx(p2[0]).toFixed(1) + ',' + sy(p2[1]).toFixed(1); }).join('');
  var grid = '';
  for (var gi = 0; gi <= 3; gi++) {
    var gy = yMax * gi / 3;
    grid += '<line x1="' + P.padL + '" x2="' + (P.W - P.padR) + '" y1="' + sy(gy).toFixed(1) + '" y2="' + sy(gy).toFixed(1) + '" stroke="#1e2228"/>' +
      '<text x="' + (P.padL - 4) + '" y="' + (sy(gy) + 3).toFixed(1) + '" text-anchor="end" fill="#6a737d" font-size="8">' + gy.toFixed(1) + '%</text>';
  }
  return tcSvgOpen(ax) + grid + tcXTicks(ax, x0, x1, xlog) +
    '<path d="' + path + '" fill="none" stroke="var(--amber)" stroke-width="1.4"/>' +
    tcCapMarker(ax) + tcFrame('Metal removed by cap' + (xlog ? ' (log X)' : ''), '') + '</svg>';
}

// Reposition every cap marker + refresh the stats strip (drag-time path —
// curves are static, only the markers and numbers move)
function auxTopcutPositionCaps() {
  var t = auxTopcut;
  if (!t || !t.values) return;
  document.querySelectorAll('#auxTopcut .tc-svg').forEach(function(svg) {
    var x0 = parseFloat(svg.dataset.x0), x1 = parseFloat(svg.dataset.x1), xlog = svg.dataset.xlog === '1';
    var P = TC_PLOT, plotW = P.W - P.padL - P.padR;
    var lx0 = xlog ? Math.log10(x0) : x0, lx1 = xlog ? Math.log10(x1) : x1;
    var lv = xlog ? Math.log10(Math.max(t.cap, 1e-12)) : t.cap;
    var x = P.padL + Math.min(1, Math.max(0, (lv - lx0) / (lx1 - lx0))) * plotW;
    var g = svg.querySelector('.tc-cap');
    if (!g) return;
    var line = g.querySelector('line'), txt = g.querySelector('text');
    line.setAttribute('x1', x.toFixed(1)); line.setAttribute('x2', x.toFixed(1));
    txt.setAttribute('x', x.toFixed(1));
    txt.textContent = formatNum(t.cap);
    txt.setAttribute('text-anchor', x > P.W * 0.8 ? 'end' : (x < P.W * 0.2 ? 'start' : 'middle'));
  });
  var strip = document.getElementById('auxTopcutStats');
  if (strip) {
    var un = auxTopcutCappedStats(t.values[t.values.length - 1]);
    strip.innerHTML = auxTopcutStatsHtml(un, auxTopcutCappedStats(t.cap));
  }
  var inp = document.getElementById('auxTopcutCapInput');
  if (inp && document.activeElement !== inp) inp.value = formatNum(t.cap);
}

function auxTopcutSetCap(c, save) {
  var t = auxTopcut;
  if (!t || !t.values || !isFinite(c)) return;
  var m = t.values.length;
  t.cap = Math.min(Math.max(c, t.values[0]), t.values[m - 1]);
  auxTopcutPositionCaps();
  if (save && typeof autoSaveProject === 'function') autoSaveProject();
}

function loadAuxTopcut() {
  if (!auxFile || !auxPreflightData) return;
  var sel = document.getElementById('auxTopcutVar');
  var varName = sel ? sel.value : (auxTopcut && auxTopcut.varName);
  if (!varName) return;
  var $st = document.getElementById('auxTopcutStatus');
  function tfail(msg) {
    if ($st) { $st.textContent = 'Error: ' + msg; $st.style.color = 'var(--red)'; }
    if (auxTopcutWorker) { try { auxTopcutWorker.terminate(); } catch (e) {} auxTopcutWorker = null; }
  }
  // Declustered mode: weights ride per-row, fingerprint-gated like every
  // other consumer of the declus weights
  var useDeclus = !!(auxTopcut && auxTopcut.useDeclus);
  var declusWeights = null;
  if (useDeclus) {
    if (typeof auxDeclusFresh === 'function' && auxDeclusFresh()) declusWeights = auxDeclus.weights;
    else { tfail('declustered weights missing or stale — run Declustering on the sidebar'); return; }
  }
  if (auxTopcutWorker) { try { auxTopcutWorker.terminate(); } catch (e) {} }
  auxTopcutWorker = new Worker(workerUrl);
  if ($st) { $st.textContent = '0%'; $st.style.color = ''; }
  auxTopcutWorker.postMessage({
    mode: 'colvalues',
    file: auxFile,
    zipEntry: auxPreflightData.selectedZipEntry || null,
    globalFilter: auxFilter ? { expression: auxFilter.expression } : null,
    calcolCode: auxCalcolCode || null,
    calcolMeta: auxCalcolMeta.length > 0 ? auxCalcolMeta : null,
    resolvedTypes: auxPreflightData.autoTypes,
    varColName: varName,
    weightArray: declusWeights,
    rowVarOverride: AUX_ROW_VAR,
    dmEndianness: auxPreflightData.dmEndianness || null,
    dmFormat: auxPreflightData.dmFormat || null
  });
  auxTopcutWorker.onerror = function(e) { tfail(e.message || 'unknown error'); };
  auxTopcutWorker.onmessage = function(e) {
    var msg = e.data;
    if (msg.type === 'colvalues-progress') {
      if ($st) $st.textContent = Math.min(99, msg.percent).toFixed(0) + '%';
    } else if (msg.type === 'error') {
      tfail(msg.message);
    } else if (msg.type === 'colvalues-complete') {
      auxTopcutWorker.terminate();
      auxTopcutWorker = null;
      if (msg.finite < 2) { tfail('Not enough numeric values.'); return; }
      var m = msg.values.length;
      // Prefix sums of w, w·v, w·v² (w = 1 in raw mode)
      var PW = new Float64Array(m + 1), S = new Float64Array(m + 1), SS = new Float64Array(m + 1);
      for (var i = 0; i < m; i++) {
        var wi = msg.weights ? msg.weights[i] : 1;
        PW[i + 1] = PW[i] + wi;
        S[i + 1] = S[i] + wi * msg.values[i];
        SS[i + 1] = SS[i] + wi * msg.values[i] * msg.values[i];
      }
      var prevCap = (auxTopcut && auxTopcut.varName === varName) ? auxTopcut.cap : null;
      var prevXlog = (auxTopcut && auxTopcut.varName === varName) ? auxTopcut.xlog : undefined;
      // Default scale: log when the data is strictly positive and spans
      // ~2 decades (lognormal-shaped) — a seed, the toggle is right there
      var autoLog = msg.values[0] > 0 && (msg.values[m - 1] / msg.values[0] > 50);
      auxTopcut = {
        varName: varName, cap: prevCap,
        xlog: prevXlog !== undefined ? prevXlog : autoLog,
        useDeclus: useDeclus,
        values: msg.values, weights: msg.weights || null,
        prefixW: PW, prefixS: S, prefixSS: SS,
        n: msg.n, finite: msg.finite, weightExcluded: msg.weightExcluded || 0,
        fingerprint: auxTopcutFingerprintNow()
      };
      renderAuxTopcut();
      if (typeof autoSaveProject === 'function') autoSaveProject();
    }
  };
}

function auxTopcutCopyCalcol() {
  var t = auxTopcut;
  if (!t || t.cap == null) return;
  var safe = t.varName.replace(/[^\w]/g, '_');
  var code = 'aux.' + safe + '_cap = cap(aux.' + t.varName + ', ' + formatNum(t.cap) + ');';
  var done = document.getElementById('auxTopcutCopied');
  function ok() { if (done) { done.textContent = 'copied — paste in Calc (Aux mode)'; setTimeout(function() { if (done) done.textContent = ''; }, 3000); } }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(code).then(ok, function() { if (done) done.textContent = code; });
  } else if (done) {
    done.textContent = code;
  }
}

// ── Wiring (static container — listeners attach once) ──
if ($auxViewToggle) {
  $auxViewToggle.addEventListener('click', function(e) {
    var btn = e.target.closest('.aux-view-btn');
    if (!btn) return;
    auxView = btn.dataset.auxview;
    renderAuxView();
    if (typeof autoSaveProject === 'function') autoSaveProject();
  });
}
if ($auxTopcut) {
  $auxTopcut.addEventListener('click', function(e) {
    if (e.target.id === 'auxTopcutLoadBtn') loadAuxTopcut();
    else if (e.target.id === 'auxTopcutCopyBtn') auxTopcutCopyCalcol();
    else if (e.target.id === 'auxTopcutWRaw' || e.target.id === 'auxTopcutWDeclus') {
      if (!auxTopcut) return;
      var wantDeclus = e.target.id === 'auxTopcutWDeclus';
      if (wantDeclus && !(typeof auxDeclusFresh === 'function' && auxDeclusFresh())) return; // disabled anyway
      if (!!auxTopcut.useDeclus !== wantDeclus) {
        auxTopcut.useDeclus = wantDeclus;
        // The distribution itself changes — reload as pairs
        loadAuxTopcut();
        if (typeof autoSaveProject === 'function') autoSaveProject();
      }
    }
    else if (e.target.id === 'auxTopcutXLin' || e.target.id === 'auxTopcutXLog') {
      if (!auxTopcut || !auxTopcut.values) return;
      var wantLog = e.target.id === 'auxTopcutXLog';
      if (wantLog && !(auxTopcut.values[0] > 0)) return; // disabled anyway
      if (!!auxTopcut.xlog !== wantLog) {
        auxTopcut.xlog = wantLog;
        renderAuxTopcut();
        if (typeof autoSaveProject === 'function') autoSaveProject();
      }
    }
  });
  $auxTopcut.addEventListener('change', function(e) {
    if (e.target.id === 'auxTopcutVar') {
      // Variable switch invalidates the loaded distribution (weight mode carries over)
      if (auxTopcut && auxTopcut.varName !== e.target.value) {
        auxTopcut = { varName: e.target.value, cap: null, values: null, useDeclus: !!auxTopcut.useDeclus };
        renderAuxTopcut();
        if (typeof autoSaveProject === 'function') autoSaveProject();
      }
    } else if (e.target.id === 'auxTopcutCapInput') {
      var c = parseFloat(e.target.value);
      if (isFinite(c)) auxTopcutSetCap(c, true);
    }
  });
  // Cap drag across any plot — the svg is captured at mousedown so the drag
  // keeps tracking even when the pointer leaves it
  $auxTopcut.addEventListener('mousedown', function(e) {
    var svg = e.target.closest ? e.target.closest('.tc-svg') : null;
    if (!svg || !auxTopcut || !auxTopcut.values) return;
    var P = TC_PLOT;
    var x0 = parseFloat(svg.dataset.x0), x1 = parseFloat(svg.dataset.x1), xlog = svg.dataset.xlog === '1';
    function capFrom(ev) {
      var rect = svg.getBoundingClientRect();
      var vx = (ev.clientX - rect.left) * (P.W / rect.width);
      var frac = Math.min(1, Math.max(0, (vx - P.padL) / (P.W - P.padL - P.padR)));
      if (xlog) return Math.pow(10, Math.log10(x0) + frac * (Math.log10(x1) - Math.log10(x0)));
      return x0 + frac * (x1 - x0);
    }
    auxTopcutSetCap(capFrom(e), false);
    e.preventDefault();
    function onMove(ev) { auxTopcutSetCap(capFrom(ev), false); }
    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      auxTopcutSetCap(auxTopcut.cap, true); // settle + autosave
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}