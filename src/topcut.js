// ─── Top-cut analysis — Aux tab main-area view ─────────────────────────
// Supervisor-style Global Topcut Analysis on the aux samples: one worker
// pass returns the SORTED finite values of a variable (after the aux
// filter); prefix sums then make every candidate cap O(log n), so the cap
// line is live while dragging across four linked plots — histogram,
// log-probability, mean & CV vs cap, and % metal above cap. No auto-pick:
// the plots are the evidence, the user moves the line. Applying a cap is a
// one-click calcol (cap() already lives in the Math preamble).
//
// A10 phase 1g-b: parameterized by (ds, root) like auxtab.js. The svg
// builders take the topcut state object t (= ds.topcut) directly; the worker
// handle (auxTopcutWorker) stays global for the single aux dataset.

function auxTopcutFingerprintNow(ds) {
  ds = ds || dsById('aux');
  if (!ds.file || !ds.preflight) return null;
  var useDeclus = !!(ds.topcut && ds.topcut.useDeclus);
  return JSON.stringify({
    f: ds.file.name + '|' + ds.file.size,
    z: ds.preflight.selectedZipEntry || null,
    flt: ds.filter ? ds.filter.expression : '',
    cc: ds.calcolCode || '',
    // Weight mode is part of the distribution's identity: flipping
    // Raw | Declustered (or re-running declus) demands a reload
    uw: useDeclus,
    dw: useDeclus && ds.declus ? ds.declus.fingerprint : null
  });
}

function auxTopcutFresh(ds) {
  ds = ds || dsById('aux');
  return !!(ds.topcut && ds.topcut.values && ds.topcut.fingerprint === auxTopcutFingerprintNow(ds));
}

function renderAuxView(ds, root) {
  ds = ds || dsById('aux');
  root = root || dsConfigRoot(ds);
  var viewToggle = auxQ('[data-aux="viewToggle"]', root);
  if (!viewToggle) return;
  var hasAux = !!ds.preflight;
  viewToggle.style.display = hasAux ? '' : 'none';
  viewToggle.querySelectorAll('.aux-view-btn').forEach(function(b) {
    b.classList.toggle('active', b.dataset.auxview === ds.view);
  });
  var showTopcut = hasAux && ds.view === 'topcut';
  var showSummary = hasAux && ds.view === 'summary';
  var preview = auxQ('[data-aux="preview"]', root);
  if (preview) preview.style.display = (showTopcut || showSummary) ? 'none' : '';
  var topcut = auxQ('[data-aux="topcutView"]', root);
  if (topcut) topcut.style.display = showTopcut ? '' : 'none';
  var summary = auxQ('[data-aux="summaryView"]', root);
  if (summary) summary.style.display = showSummary ? '' : 'none';
  if (showTopcut) renderAuxTopcut(ds, root);
  if (showSummary && typeof renderAuxSummary === 'function') renderAuxSummary(ds, root);
}

// ── Capped statistics from (weighted) prefix sums ──
// k = count of values ≤ c (binary search); prefixS/prefixSS carry Σw·v and
// Σw·v² (w=1 in raw mode, prefixW = counts), so every capped moment is
// arithmetic: sum' = S[k] + (W−W[k])·c, ss' = SS[k] + (W−W[k])·c².
// Weighted runs use population variance, raw keeps the sample form —
// the same convention as every other weighted statistic in BMA.
function auxTopcutCappedStats(c, t) {
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

function renderAuxTopcut(ds, root) {
  ds = ds || dsById('aux');
  root = root || dsConfigRoot(ds);
  var topcutEl = auxQ('[data-aux="topcutView"]', root);
  if (!topcutEl || !ds.preflight) return;
  var t = ds.topcut;

  // Variable options: numeric raw columns + numeric aux calcols
  var chosen = (t && t.varName) || null;
  var varOpts = '';
  for (var i = 0; i < ds.preflight.header.length; i++) {
    if ((ds.preflight.autoTypes || [])[i] !== 'numeric') continue;
    var nm = ds.preflight.header[i];
    if (chosen === null) chosen = nm;
    varOpts += '<option value="' + esc(nm) + '"' + (nm === chosen ? ' selected' : '') + '>' + esc(nm) + '</option>';
  }
  for (var ci = 0; ci < ds.calcolMeta.length; ci++) {
    if (ds.calcolMeta[ci].type !== 'numeric') continue;
    var cn = ds.calcolMeta[ci].name;
    varOpts += '<option value="' + esc(cn) + '"' + (cn === chosen ? ' selected' : '') + '>' + esc(cn) + ' (calc)</option>';
  }

  var html = '<div class="tc-toolbar">' +
    '<label>Variable</label>' +
    '<select class="aux-select" data-aux="topcutVar" style="width:auto;min-width:120px">' + varOpts + '</select>' +
    '<button class="aux-from-main-btn" data-act="auxTopcutLoad">' + (auxTopcutFresh(ds) ? 'Reload' : 'Load distribution') + '</button>' +
    '<span class="aux-hint" data-aux="topcutStatus" style="margin:0"></span>' +
  '</div>';

  if (!auxTopcutFresh(ds)) {
    if (t && t.varName && !t.values) {
      html += '<div class="tc-empty">Restored top-cut config (' + esc(t.varName) + (t.cap != null ? ', cap ' + formatNum(t.cap) : '') + ') — load the distribution to continue.</div>';
    } else if (t && t.values) {
      html += '<div class="tc-empty" style="color:var(--warn)">Aux config changed since this distribution was loaded — reload.</div>';
    } else {
      html += '<div class="tc-empty">Load a variable’s sample distribution to analyse top cuts: histogram, log-probability, mean & CV vs cap, and metal above cap, with a draggable cap line across all four.</div>';
    }
    topcutEl.innerHTML = html;
    return;
  }

  var m = t.values.length;
  var vMin = t.values[0], vMax = t.values[m - 1];
  if (t.cap == null || !(t.cap >= vMin && t.cap <= vMax)) {
    t.cap = t.values[Math.min(m - 1, Math.floor(0.99 * m))]; // starting handle at P99 — a position, not a recommendation
  }
  var un = auxTopcutCappedStats(vMax, t);
  var cs = auxTopcutCappedStats(t.cap, t);

  var canLog = vMin > 0;
  if (!canLog) t.xlog = false;
  html += '<div class="tc-stats" data-aux="topcutStats">' + auxTopcutStatsHtml(un, cs, t) + '</div>';
  html += '<div class="tc-caprow">' +
    '<label>Cap</label>' +
    '<input type="text" class="aux-input" data-aux="topcutCap" value="' + formatNum(t.cap) + '" spellcheck="false" style="width:90px">' +
    '<button class="aux-from-main-btn" data-act="auxTopcutCopy" title="copy a capping calcol for the Calc tab (Aux mode)">Copy calcol</button>' +
    '<span class="aux-hint" data-aux="topcutCopied" style="margin:0"></span>' +
    '<span style="margin-left:auto;display:flex;gap:0.25rem">' +
      '<button class="aux-view-btn' + (!t.useDeclus ? ' active' : '') + '" data-act="auxTopcutWRaw" title="raw sample distribution — the capping convention">Raw</button>' +
      '<button class="aux-view-btn' + (t.useDeclus ? ' active' : '') + '" data-act="auxTopcutWDeclus"' +
        (typeof auxDeclusFresh === 'function' && auxDeclusFresh(ds)
          ? ' title="weight every statistic by the declustering weights — capped means/metal unbiased by drilling pattern"'
          : ' disabled title="run Declustering on the sidebar first (weights missing or stale)"') + '>Declustered</button>' +
      '<span style="width:0.4rem"></span>' +
      '<button class="aux-view-btn' + (!t.xlog ? ' active' : '') + '" data-act="auxTopcutXLin">Linear</button>' +
      '<button class="aux-view-btn' + (t.xlog ? ' active' : '') + '" data-act="auxTopcutXLog"' +
        (canLog ? ' title="log value axis on all four plots"' : ' disabled title="log X needs all values > 0 (min here is ' + formatNum(vMin) + ')"') + '>Log</button>' +
    '</span>' +
  '</div>';
  html += '<div class="tc-grid">' +
    '<div class="tc-plot">' + auxTopcutHistSvg(t) + '</div>' +
    '<div class="tc-plot">' + auxTopcutLogProbSvg(t) + '</div>' +
    '<div class="tc-plot">' + auxTopcutMeanCvSvg(t) + '</div>' +
    '<div class="tc-plot">' + auxTopcutMetalSvg(t) + '</div>' +
  '</div>';
  html += '<div class="aux-hint">drag the cap line on any plot (or type a value) · n ' + m.toLocaleString() +
    (t.n > m + (t.weightExcluded || 0) ? ' (+' + (t.n - m - (t.weightExcluded || 0)) + ' non-numeric/null excluded)' : '') +
    (t.weightExcluded ? ' (+' + t.weightExcluded + ' invalid-weight excluded)' : '') +
    ' · ' + (t.weights ? 'declustering-weighted distribution' : 'raw unweighted sample distribution (the capping convention)') + '</div>';

  topcutEl.innerHTML = html;
  auxTopcutPositionCaps(ds, root);
}

function auxTopcutStatsHtml(un, cs, t) {
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
  return '<text x="' + (P.W / 2) + '" y="11" text-anchor="middle" fill="var(--chart-ink)" font-size="9.5">' + title + '</text>' +
    (yLabel ? '<text x="10" y="' + ((P.padT + P.H - P.padB) / 2) + '" text-anchor="middle" fill="var(--chart-ink)" font-size="9" transform="rotate(-90, 10, ' + ((P.padT + P.H - P.padB) / 2) + ')">' + yLabel + '</text>' : '');
}

function tcCapMarker(ax, t) {
  var P = TC_PLOT;
  var x = ax.sx(t.cap).toFixed(1);
  return '<g class="tc-cap"><line x1="' + x + '" x2="' + x + '" y1="' + P.padT + '" y2="' + (P.H - P.padB) + '" stroke="var(--red, #e05555)" stroke-width="1.2" stroke-dasharray="5,3"/>' +
    '<text x="' + x + '" y="' + (P.padT - 4 + 10) + '" fill="var(--red, #e05555)" font-size="8.5" text-anchor="middle"></text></g>';
}

function tcXTicks(ax, x0, x1, xlog) {
  var P = TC_PLOT, out = '';
  for (var i = 0; i <= 4; i++) {
    var v = xlog ? Math.pow(10, Math.log10(x0) + (Math.log10(x1) - Math.log10(x0)) * i / 4) : x0 + (x1 - x0) * i / 4;
    var x = ax.sx(v);
    out += '<line x1="' + x.toFixed(1) + '" x2="' + x.toFixed(1) + '" y1="' + P.padT + '" y2="' + (P.H - P.padB) + '" stroke="var(--chart-grid)"/>' +
      '<text x="' + x.toFixed(1) + '" y="' + (P.H - P.padB + 13) + '" text-anchor="middle" fill="var(--chart-ink)" font-size="8.5">' + formatNum(v) + '</text>';
  }
  return out;
}

function tcSvgOpen(ax) {
  var P = TC_PLOT;
  return '<svg class="tc-svg" viewBox="0 0 ' + P.W + ' ' + P.H + '"' + ax.attrs + '><rect width="' + P.W + '" height="' + P.H + '" fill="var(--bg)" rx="3"/>';
}

function auxTopcutHistSvg(t) {
  var v = t.values, m = v.length, P = TC_PLOT;
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
  return tcSvgOpen(ax) + tcXTicks(ax, x0, x1, xlog) + bars + tcCapMarker(ax, t) + tcFrame('Histogram' + (xlog ? ' (log X)' : ''), 'count') + '</svg>';
}

function auxTopcutLogProbSvg(t) {
  var v = t.values, m = v.length, P = TC_PLOT;
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
    grid += '<line x1="' + P.padL + '" x2="' + (P.W - P.padR) + '" y1="' + y + '" y2="' + y + '" stroke="var(--chart-grid)"/>' +
      '<text x="' + (P.padL - 4) + '" y="' + (+y + 3) + '" text-anchor="end" fill="var(--chart-ink)" font-size="8">' + (p * 100) + '%</text>';
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
    pts += '<circle cx="' + ax.sx(v[i]).toFixed(1) + '" cy="' + sy(p).toFixed(1) + '" r="1.2" fill="var(--action)" opacity="0.7"/>';
  }
  return tcSvgOpen(ax) + grid + tcXTicks(ax, x0, x1, xlog) + pts + tcCapMarker(ax, t) +
    tcFrame((xlog ? 'Log-probability' : 'Probability (linear X)') + (t.weights ? ' · declustered' : ''), 'cum %') + '</svg>';
}

function auxTopcutMeanCvSvg(t) {
  var v = t.values, m = v.length, P = TC_PLOT;
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
    var s = auxTopcutCappedStats(c, t);
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
  var legend = '<text x="' + (P.padL + 4) + '" y="' + (P.padT + 9) + '" fill="var(--action)" font-size="8.5">mean</text>' +
    '<text x="' + (P.padL + 34) + '" y="' + (P.padT + 9) + '" fill="var(--info)" font-size="8.5">CV</text>';
  return tcSvgOpen(ax) + tcXTicks(ax, x0, x1, xlog) +
    '<path d="' + pM + '" fill="none" stroke="var(--action)" stroke-width="1.4"/>' +
    '<path d="' + pC + '" fill="none" stroke="var(--info)" stroke-width="1.2"/>' +
    legend + tcCapMarker(ax, t) + tcFrame('Mean & CV vs cap' + (xlog ? ' (log X)' : ''), '') + '</svg>';
}

function auxTopcutMetalSvg(t) {
  var v = t.values, m = v.length, P = TC_PLOT;
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
    var s = auxTopcutCappedStats(c, t);
    pts2.push([c, s.metalRemovedPct]);
    if (s.metalRemovedPct > yMax) yMax = s.metalRemovedPct;
  }
  if (yMax <= 0) yMax = 1;
  function sy(y) { return P.padT + (1 - y / yMax) * plotH; }
  path = pts2.map(function(p2, i2) { return (i2 ? 'L' : 'M') + ax.sx(p2[0]).toFixed(1) + ',' + sy(p2[1]).toFixed(1); }).join('');
  var grid = '';
  for (var gi = 0; gi <= 3; gi++) {
    var gy = yMax * gi / 3;
    grid += '<line x1="' + P.padL + '" x2="' + (P.W - P.padR) + '" y1="' + sy(gy).toFixed(1) + '" y2="' + sy(gy).toFixed(1) + '" stroke="var(--chart-grid)"/>' +
      '<text x="' + (P.padL - 4) + '" y="' + (sy(gy) + 3).toFixed(1) + '" text-anchor="end" fill="var(--chart-ink)" font-size="8">' + gy.toFixed(1) + '%</text>';
  }
  return tcSvgOpen(ax) + grid + tcXTicks(ax, x0, x1, xlog) +
    '<path d="' + path + '" fill="none" stroke="var(--action)" stroke-width="1.4"/>' +
    tcCapMarker(ax, t) + tcFrame('Metal removed by cap' + (xlog ? ' (log X)' : ''), '') + '</svg>';
}

// Reposition every cap marker + refresh the stats strip (drag-time path —
// curves are static, only the markers and numbers move)
function auxTopcutPositionCaps(ds, root) {
  ds = ds || dsById('aux');
  root = root || dsConfigRoot(ds);
  var t = ds.topcut;
  if (!t || !t.values) return;
  var topcutEl = auxQ('[data-aux="topcutView"]', root);
  if (!topcutEl) return;
  topcutEl.querySelectorAll('.tc-svg').forEach(function(svg) {
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
  var strip = auxQ('[data-aux="topcutStats"]', root);
  if (strip) {
    var un = auxTopcutCappedStats(t.values[t.values.length - 1], t);
    strip.innerHTML = auxTopcutStatsHtml(un, auxTopcutCappedStats(t.cap, t), t);
  }
  var inp = auxQ('[data-aux="topcutCap"]', root);
  if (inp && document.activeElement !== inp) inp.value = formatNum(t.cap);
}

function auxTopcutSetCap(c, save, ds, root) {
  ds = ds || dsById('aux');
  root = root || dsConfigRoot(ds);
  var t = ds.topcut;
  if (!t || !t.values || !isFinite(c)) return;
  var m = t.values.length;
  t.cap = Math.min(Math.max(c, t.values[0]), t.values[m - 1]);
  auxTopcutPositionCaps(ds, root);
  if (save && typeof autoSaveProject === 'function') autoSaveProject();
}

function loadAuxTopcut(ds, root) {
  ds = ds || dsById('aux');
  root = root || dsConfigRoot(ds);
  if (!ds.file || !ds.preflight) return;
  var sel = auxQ('[data-aux="topcutVar"]', root);
  var varName = sel ? sel.value : (ds.topcut && ds.topcut.varName);
  if (!varName) return;
  var $st = auxQ('[data-aux="topcutStatus"]', root);
  function tfail(msg) {
    if ($st) { $st.textContent = 'Error: ' + msg; $st.style.color = 'var(--red)'; }
    if (auxTopcutWorker) { try { auxTopcutWorker.terminate(); } catch (e) {} auxTopcutWorker = null; }
  }
  // Declustered mode: weights ride per-row, fingerprint-gated like every
  // other consumer of the declus weights
  var useDeclus = !!(ds.topcut && ds.topcut.useDeclus);
  var declusWeights = null;
  if (useDeclus) {
    if (typeof auxDeclusFresh === 'function' && auxDeclusFresh(ds)) declusWeights = ds.declus.weights;
    else { tfail('declustered weights missing or stale — run Declustering on the sidebar'); return; }
  }
  if (auxTopcutWorker) { try { auxTopcutWorker.terminate(); } catch (e) {} }
  auxTopcutWorker = new Worker(workerUrl);
  if ($st) { $st.textContent = '0%'; $st.style.color = ''; }
  auxTopcutWorker.postMessage({
    mode: 'colvalues',
    file: ds.file,
    zipEntry: ds.preflight.selectedZipEntry || null,
    globalFilter: ds.filter ? { expression: ds.filter.expression } : null,
    calcolCode: ds.calcolCode || null,
    calcolMeta: ds.calcolMeta.length > 0 ? ds.calcolMeta : null,
    resolvedTypes: ds.preflight.autoTypes,
    varColName: varName,
    weightArray: declusWeights,
    rowVarOverride: ds.rowVar,
    dmEndianness: ds.preflight.dmEndianness || null,
    dmFormat: ds.preflight.dmFormat || null
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
      var prevCap = (ds.topcut && ds.topcut.varName === varName) ? ds.topcut.cap : null;
      var prevXlog = (ds.topcut && ds.topcut.varName === varName) ? ds.topcut.xlog : undefined;
      // Default scale: log when the data is strictly positive and spans
      // ~2 decades (lognormal-shaped) — a seed, the toggle is right there
      var autoLog = msg.values[0] > 0 && (msg.values[m - 1] / msg.values[0] > 50);
      ds.topcut = {
        varName: varName, cap: prevCap,
        xlog: prevXlog !== undefined ? prevXlog : autoLog,
        useDeclus: useDeclus,
        values: msg.values, weights: msg.weights || null,
        prefixW: PW, prefixS: S, prefixSS: SS,
        n: msg.n, finite: msg.finite, weightExcluded: msg.weightExcluded || 0,
        fingerprint: auxTopcutFingerprintNow(ds)
      };
      renderAuxTopcut(ds, root);
      if (typeof autoSaveProject === 'function') autoSaveProject();
    }
  };
}

function auxTopcutCopyCalcol(ds, root) {
  ds = ds || dsById('aux');
  root = root || dsConfigRoot(ds);
  var t = ds.topcut;
  if (!t || t.cap == null) return;
  var rv = ds.rowVar;
  var safe = t.varName.replace(/[^\w]/g, '_');
  var code = rv + '.' + safe + '_cap = cap(' + rv + '.' + t.varName + ', ' + formatNum(t.cap) + ');';
  var done = auxQ('[data-aux="topcutCopied"]', root);
  function ok() { if (done) { done.textContent = 'copied — paste in Calc (Aux mode)'; setTimeout(function() { if (done) done.textContent = ''; }, 3000); } }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(code).then(ok, function() { if (done) done.textContent = code; });
  } else if (done) {
    done.textContent = code;
  }
}

// ── Wiring — the top-cut + view-toggle listeners for one dataset instance ──
// Called from wireDatasetPanel (auxtab.js) so a cloned panel wires the same.
function wireDatasetTopcut(root, ds) {
  ds = ds || dsById('aux');
  root = root || dsConfigRoot(ds);
  if (!root) return;
  var viewToggle = auxQ('[data-aux="viewToggle"]', root);
  var topcutEl = auxQ('[data-aux="topcutView"]', root);

  if (viewToggle) {
    viewToggle.addEventListener('click', function(e) {
      var btn = e.target.closest('.aux-view-btn');
      if (!btn) return;
      ds.view = btn.dataset.auxview;
      renderAuxView(ds, root);
      if (typeof autoSaveProject === 'function') autoSaveProject();
    });
  }
  if (topcutEl) {
    topcutEl.addEventListener('click', function(e) {
      var act = e.target.dataset ? e.target.dataset.act : null;
      if (act === 'auxTopcutLoad') loadAuxTopcut(ds, root);
      else if (act === 'auxTopcutCopy') auxTopcutCopyCalcol(ds, root);
      else if (act === 'auxTopcutWRaw' || act === 'auxTopcutWDeclus') {
        if (!ds.topcut) return;
        var wantDeclus = act === 'auxTopcutWDeclus';
        if (wantDeclus && !(typeof auxDeclusFresh === 'function' && auxDeclusFresh(ds))) return; // disabled anyway
        if (!!ds.topcut.useDeclus !== wantDeclus) {
          ds.topcut.useDeclus = wantDeclus;
          // The distribution itself changes — reload as pairs
          loadAuxTopcut(ds, root);
          if (typeof autoSaveProject === 'function') autoSaveProject();
        }
      }
      else if (act === 'auxTopcutXLin' || act === 'auxTopcutXLog') {
        if (!ds.topcut || !ds.topcut.values) return;
        var wantLog = act === 'auxTopcutXLog';
        if (wantLog && !(ds.topcut.values[0] > 0)) return; // disabled anyway
        if (!!ds.topcut.xlog !== wantLog) {
          ds.topcut.xlog = wantLog;
          renderAuxTopcut(ds, root);
          if (typeof autoSaveProject === 'function') autoSaveProject();
        }
      }
    });
    topcutEl.addEventListener('change', function(e) {
      var dx = e.target.dataset ? e.target.dataset.aux : null;
      if (dx === 'topcutVar') {
        // Variable switch invalidates the loaded distribution (weight mode carries over)
        if (ds.topcut && ds.topcut.varName !== e.target.value) {
          ds.topcut = { varName: e.target.value, cap: null, values: null, useDeclus: !!ds.topcut.useDeclus };
          renderAuxTopcut(ds, root);
          if (typeof autoSaveProject === 'function') autoSaveProject();
        }
      } else if (dx === 'topcutCap') {
        var c = parseFloat(e.target.value);
        if (isFinite(c)) auxTopcutSetCap(c, true, ds, root);
      }
    });
    // Cap drag across any plot — the svg is captured at pointerdown so the drag
    // keeps tracking even when the pointer leaves it
    topcutEl.addEventListener('pointerdown', function(e) {
      var svg = e.target.closest ? e.target.closest('.tc-svg') : null;
      if (!svg || !ds.topcut || !ds.topcut.values) return;
      var P = TC_PLOT;
      var x0 = parseFloat(svg.dataset.x0), x1 = parseFloat(svg.dataset.x1), xlog = svg.dataset.xlog === '1';
      function capFrom(ev) {
        var rect = svg.getBoundingClientRect();
        var vx = (ev.clientX - rect.left) * (P.W / rect.width);
        var frac = Math.min(1, Math.max(0, (vx - P.padL) / (P.W - P.padL - P.padR)));
        if (xlog) return Math.pow(10, Math.log10(x0) + frac * (Math.log10(x1) - Math.log10(x0)));
        return x0 + frac * (x1 - x0);
      }
      auxTopcutSetCap(capFrom(e), false, ds, root);
      e.preventDefault();
      function onMove(ev) { auxTopcutSetCap(capFrom(ev), false, ds, root); }
      function onUp() {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        auxTopcutSetCap(ds.topcut.cap, true, ds, root); // settle + autosave
      }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }
}

// ── Wire the static aux panel once at load (last of the dataset modules,
// so both wireDatasetPanel and wireDatasetTopcut are defined). ──
(function() {
  var auxDs = dsById('aux');
  if (auxDs && typeof wireDatasetPanel === 'function') wireDatasetPanel(dsConfigRoot(auxDs), auxDs);
})();
