// ─── Categories Tab ────────────────────────────────────────────────────
let _catData = null;       // cached { categories, header, origColCount, rowCount }

function renderCategoriesTab(categories, header, origColCount, rowCount) {
  _catData = { categories, header, origColCount, rowCount };
  const catCols = Object.keys(categories).map(Number).sort(function(a,b){return a-b;});

  $catBadge.textContent = catCols.length;   // title already says "Columns"

  if (catCols.length === 0) {
    $catColList.innerHTML = '';
    $catToolbar.innerHTML = '';
    $catChart.innerHTML = '';
    $catValueTable.innerHTML = '<tbody></tbody>'; // loading a new file may have emptied the table entirely
    $catValueSearch.style.display = 'none';
    $catMainContent.innerHTML = '<div class="cat-empty">No categorical columns detected.</div>';
    return;
  }

  // Restore main content structure if replaced by empty message
  if (!$catMainContent.querySelector('.cat-chart')) {
    $catMainContent.innerHTML = '';
    $catMainContent.appendChild($catChart);
    $catMainContent.appendChild($catValueTableWrap);
  }
  $catValueSearch.style.display = '';

  // Auto-focus first column if none focused
  if (panelState.categories.focusedCol === null || !categories[panelState.categories.focusedCol]) {
    panelState.categories.focusedCol = catCols[0];
  }

  renderCatSidebar();
  renderCatMain();
  wireCatEvents();
  catRenderAllInstances();   // keep any live clones in sync with the new analysis
}

function renderCatSidebar(root) {
  if (!_catData) return;
  var els = catEls(root);
  var st = catStateForRoot(root);
  var categories = _catData.categories;
  var header = _catData.header;
  var origColCount = _catData.origColCount;
  var catCols = Object.keys(categories).map(Number).sort(function(a,b){return a-b;});
  var search = ((els.colSearch && els.colSearch.value) || '').toLowerCase();
  var html = '';
  for (var ci = 0; ci < catCols.length; ci++) {
    var i = catCols[ci];
    var name = header[i];
    if (search && !fuzzyMatch(search, name.toLowerCase())) continue;
    var cat = categories[i];
    var uniqueCount = Object.keys(cat.counts).length + (cat.overflow ? '+' : '');
    var isCalcol = i >= origColCount;
    var active = i === st.focusedCol ? ' active' : '';
    html += '<div class="cat-col-item' + active + '" data-col="' + i + '">';
    html += '<span class="col-name">' + esc(name) + '</span>';
    if (isCalcol) html += '<span class="calcol-tag">CALC</span>';
    html += '<span class="col-count">' + uniqueCount + '</span>';
    html += '</div>';
  }
  els.colList.innerHTML = html;
}

function renderCatMain(root) {
  if (!_catData || panelState.categories.focusedCol === null) return;
  renderCatDatasetChips(root);
  renderCatToolbar(root);
  renderCatSortGroup(root);
  renderCatBarChart(root);
  renderCatValueTable(root);
}

// A10 4c-iv: dataset show/hide chips. Progressive disclosure — the section
// appears only once a second comparison dataset joins (3+ total), so the
// common model+aux case stays uncluttered. Model = a static baseline chip.
function renderCatDatasetChips(root) {
  var els = catEls(root);
  var section = els.datasetsSection;
  if (!section) return;
  var allCmp = catCmpDatasets();
  if (allCmp.length < 2) { section.style.display = 'none'; return; }
  var chips = '<span class="stats-ds-chip stats-ds-chip--model" title="the model (reference) categories">Model</span>';
  allCmp.forEach(function(ds) {
    var off = panelState.categories.dsHidden.has(ds.id);
    chips += '<button class="stats-ds-chip' + (off ? ' off' : '') + '" data-ds-chip="' + esc(ds.id) +
      '" aria-pressed="' + (off ? 'false' : 'true') + '" title="' + esc(off ? 'show ' : 'hide ') + esc(dsLabel(ds.id)) +
      '">' + esc(dsLabel(ds.id)) + '</button>';
  });
  els.datasetChips.innerHTML = chips;
  section.style.display = '';
}

// A10 4c-iv: dataset show/hide chips for Categories. Keyed by dsId; lives on
// panelState.categories.dsHidden (4e-a), serialized in 4e-b.

// Comparison datasets that can mirror a categorical column — every non-model
// dataset whose last analysis produced categories. Registry order (aux, d2…).
function catCmpDatasets() {
  var out = [];
  for (var i = 1; i < datasets.length; i++) {
    var d = datasets[i];
    if (d && d.complete && d.complete.categories) out.push(d);
  }
  return out;
}
// The comparison datasets actually shown — the chips (≥2 comparison datasets)
// let the user hide any of them.
function catShownCmpDatasets() {
  return catCmpDatasets().filter(function(d) { return !panelState.categories.dsHidden.has(d.id); });
}

// Category counts of a comparison dataset's column grouped (by catalog
// property) with a model categorical column: { counts, total, overflow } or
// null. Generalizes the aux-only getCatAuxCounts so the chart/table can
// compare category proportions model-vs-any-dataset — e.g. lithology shares.
function getCatCmpCounts(ds, colName) {
  if (!ds || !ds.complete || !ds.complete.categories || !colName) return null;
  catEnsureSeeded();
  var memberSet = new Set(catGroupMembers(colName, ds.id));
  if (memberSet.size === 0) return null;
  var cats = ds.complete.categories, hdr = ds.complete.header;
  var idxs = Object.keys(cats);
  for (var i = 0; i < idxs.length; i++) {
    var ai = idxs[i];
    var aName = hdr[ai];
    if (aName && memberSet.has(aName)) {
      var cat = cats[ai];
      if (!cat || !cat.counts) return null;
      var total = 0;
      for (var v in cat.counts) total += cat.counts[v];
      return { counts: cat.counts, total: total, overflow: !!cat.overflow };
    }
  }
  return null;
}

// Shown comparison datasets that actually have a counterpart for colName, as
// [{ds, label, counts}] in registry order. The render functions iterate this.
function catCmpForCol(colName) {
  var out = [];
  catShownCmpDatasets().forEach(function(ds) {
    var c = getCatCmpCounts(ds, colName);
    if (c) out.push({ ds: ds, label: dsLabel(ds.id), counts: c });
  });
  return out;
}

// Comparison-series marker colour: the first dataset keeps the legacy aux look
// (--fg-bright open diamond); additional datasets take palette hues so they
// stay distinguishable on the shared axis.
function catCmpMarkerColor(idx) {
  return idx === 0 ? 'var(--fg-bright)' : STATSCAT_PALETTE[(idx - 1) % STATSCAT_PALETTE.length];
}

function getCatSortedEntries(colIdx) {
  if (!_catData) return [];
  var cat = _catData.categories[colIdx];
  if (!cat) return [];
  var entries = Object.entries(cat.counts);
  var colName = _catData.header[colIdx];
  var defaultSort = (typeof bmaSettings !== 'undefined' && bmaSettings && bmaSettings.defaultCatSort) ? bmaSettings.defaultCatSort : 'count-desc';
  var mode = (catVarPeek('model', colName) || {}).sortMode || defaultSort;

  if (mode === 'count-desc') {
    entries.sort(function(a,b){ return b[1] - a[1]; });
  } else if (mode === 'count-asc') {
    entries.sort(function(a,b){ return a[1] - b[1]; });
  } else if (mode === 'alpha') {
    entries.sort(function(a,b){ return a[0].localeCompare(b[0]); });
  } else if (mode === 'custom') {
    var order = (catVarPeek('model', colName) || {}).valueOrder;
    if (order) {
      var posMap = {};
      for (var oi = 0; oi < order.length; oi++) posMap[order[oi]] = oi;
      entries.sort(function(a,b){
        var pa = posMap[a[0]] !== undefined ? posMap[a[0]] : 999999;
        var pb = posMap[b[0]] !== undefined ? posMap[b[0]] : 999999;
        return pa - pb;
      });
    }
  }
  return entries;
}

// Sort controls \u2014 rendered next to the value table they reorder (C6-4c; they
// used to sit in the toolbar above the chart, far from the table).
function renderCatSortGroup(root) {
  var grp = catEls(root).sortGroup;
  var st = catStateForRoot(root);
  if (!grp || !_catData || st.focusedCol === null) return;
  var colName = _catData.header[st.focusedCol];
  var defaultSort = (typeof bmaSettings !== 'undefined' && bmaSettings && bmaSettings.defaultCatSort) ? bmaSettings.defaultCatSort : 'count-desc';
  var mode = (catVarPeek('model', colName) || {}).sortMode || defaultSort;
  grp.innerHTML =
    '<span class="cat-sort-label">Sort</span>' +
    '<button class="cat-sort-btn' + (mode === 'count-desc' ? ' active' : '') + '" data-sort="count-desc" title="Sort by count descending">Count\u2193</button>' +
    '<button class="cat-sort-btn' + (mode === 'count-asc' ? ' active' : '') + '" data-sort="count-asc" title="Sort by count ascending">Count\u2191</button>' +
    '<button class="cat-sort-btn' + (mode === 'alpha' ? ' active' : '') + '" data-sort="alpha" title="Sort alphabetically">A\u2013Z</button>' +
    '<button class="cat-sort-btn' + (mode === 'custom' ? ' active' : '') + '" data-sort="custom" title="Custom drag order">Custom</button>';
}

function renderCatToolbar(root) {
  var st = catStateForRoot(root);
  if (!_catData || st.focusedCol === null) return;
  var els = catEls(root);
  var header = _catData.header;
  var origColCount = _catData.origColCount;
  var colName = header[st.focusedCol];
  var isCalcol = st.focusedCol >= origColCount;

  var cat = _catData.categories[st.focusedCol];
  var entries = Object.entries(cat.counts);
  var uniqueCount = entries.length + (cat.overflow ? '+' : '');
  var total = entries.reduce(function(s,e){ return s + e[1]; }, 0);
  var nullCount = _catData.rowCount - total;
  var nullPct = _catData.rowCount > 0 ? (nullCount / _catData.rowCount * 100) : 0;

  // Shannon entropy \u2192 diversity (0% = one value dominates, 100% = even spread)
  var entropy = 0;
  if (total > 0) {
    for (var ei = 0; ei < entries.length; ei++) {
      var c = entries[ei][1];
      if (c <= 0) continue;
      var p = c / total;
      entropy -= p * Math.log2(p);
    }
  }
  var maxEntropy = entries.length > 1 ? Math.log2(entries.length) : 0;
  var normPct = maxEntropy > 0 ? Math.round((entropy / maxEntropy) * 100) : 0;

  // Dominant value + concentration (how many categories cover 80% of rows)
  var byCount = entries.slice().sort(function(a, b){ return b[1] - a[1]; });
  var dom = byCount.length ? byCount[0] : null;
  var domPct = dom && total > 0 ? (dom[1] / total * 100) : 0;
  var cov80 = 0, cum = 0;
  if (total > 0) {
    for (var ki = 0; ki < byCount.length; ki++) { cum += byCount[ki][1]; cov80++; if (cum / total >= 0.8) break; }
  }
  var cmps = catCmpForCol(colName);

  function stat(label, value, title) {
    return '<div class="cat-stat"' + (title ? ' title="' + esc(title) + '"' : '') + '>' +
      '<span class="cat-stat-label">' + label + '</span>' +
      '<span class="cat-stat-value">' + value + '</span></div>';
  }
  function trunc(s) { return s.length > 16 ? esc(s.slice(0, 15)) + '\u2026' : esc(s); }

  var html = '<div class="cat-toolbar-row">';
  html += '<div class="cat-toolbar-title">' + esc(colName) + (isCalcol ? ' <span class="calcol-tag">CALC</span>' : '') + '</div>';
  html += '<button class="cat-copy-btn" title="Copy value table (TSV)">Copy</button>';
  html += '</div>';

  html += '<div class="cat-stats">';
  html += stat('Categories', uniqueCount, cat.overflow ? 'value count capped during analysis (overflow)' : 'distinct non-null values');
  html += stat('Rows', total.toLocaleString(), 'rows with a value in this column');
  html += stat('Null', nullCount > 0 ? nullCount.toLocaleString() + ' <span class="cat-stat-sub">' + nullPct.toFixed(1) + '%</span>' : '0', 'rows with no value (blank / sentinel / filtered)');
  if (dom) html += stat('Dominant', trunc(dom[0]) + ' <span class="cat-stat-sub">' + domPct.toFixed(1) + '%</span>', dom[0] + ' \u2014 most frequent value');
  if (maxEntropy > 0) html += stat('Diversity', normPct + '%', 'normalized Shannon entropy (H=' + entropy.toFixed(2) + ' / ' + maxEntropy.toFixed(2) + ') \u2014 0% one value dominates, 100% even spread');
  if (total > 0 && byCount.length > 1) html += stat('80% in', cov80 + (cov80 === 1 ? ' cat' : ' cats'), 'categories making up 80% of the rows (concentration)');
  cmps.forEach(function(cm) {
    html += stat('vs ' + esc(cm.label), cm.counts.total.toLocaleString() + (cm.counts.overflow ? '+' : ''), 'grouped ' + cm.label + ':' + colName + ' \u2014 rows compared');
  });
  html += '</div>';

  els.toolbar.innerHTML = html;
}

function renderCatBarChart(root) {
  var st = catStateForRoot(root);
  if (!_catData || st.focusedCol === null) return;
  var els = catEls(root);
  var colName = _catData.header[st.focusedCol];
  var entries = getCatSortedEntries(st.focusedCol);
  if (entries.length === 0) { els.chart.innerHTML = ''; return; }

  var total = entries.reduce(function(s,e){ return s + e[1]; }, 0);
  var maxCount = 0;
  for (var i = 0; i < entries.length; i++) { if (entries[i][1] > maxCount) maxCount = entries[i][1]; }

  // Determine how many bars to show
  var showAll = st.chartShowAll || entries.length <= 30;
  var showEntries = showAll ? entries : entries.slice(0, 20);

  var barH = 18, gap = 2, labelW = 120, rightPad = 60;
  // Comparison overlay: scale each comparison dataset's shares onto the same
  // axis as the bars (bars are count/maxCount, i.e. share/maxShare).
  var cmps = catCmpForCol(colName);
  var maxShare = total > 0 ? maxCount / total : 0;
  var auxLegendH = cmps.length * 16;
  var chartH = showEntries.length * (barH + gap) + 30 + auxLegendH; // +30 for Pareto line clearance
  var chartW = chartHostWidth(els.chart, 600);
  var barAreaW = chartW - labelW - rightPad;

  var svg = '<svg viewBox="0 0 ' + chartW + ' ' + chartH + '" xmlns="http://www.w3.org/2000/svg" style="font-family:var(--mono)">';

  // Bars + Pareto
  var cumPct = 0;
  var paretoPoints = [];
  for (var bi = 0; bi < showEntries.length; bi++) {
    var val = showEntries[bi][0];
    var count = showEntries[bi][1];
    var barW = maxCount > 0 ? (count / maxCount) * barAreaW : 0;
    var y = bi * (barH + gap);
    var color = getCategoryColor(colName, val, bi);

    // Bar
    svg += '<rect x="' + labelW + '" y="' + y + '" width="' + barW.toFixed(1) + '" height="' + barH + '" fill="' + color + '" opacity="0.75" rx="2"/>';

    // Label (truncated)
    var dispVal = val.length > 18 ? val.substring(0, 17) + '\u2026' : val;
    svg += '<text x="' + (labelW - 6) + '" y="' + (y + barH / 2 + 3.5) + '" text-anchor="end" fill="var(--fg)" font-size="9.5">' + esc(dispVal) + '</text>';

    // Count + %
    var pct = total > 0 ? (count / total * 100).toFixed(1) : '0.0';
    svg += '<text x="' + (labelW + barW + 4) + '" y="' + (y + barH / 2 + 3.5) + '" fill="var(--fg-dim)" font-size="8.5">' + count.toLocaleString() + ' (' + pct + '%)</text>';

    // Comparison share markers: an open diamond at each dataset's proportion,
    // on the bar axis (first dataset --fg-bright, others palette hues).
    if (maxShare > 0) {
      for (var mi = 0; mi < cmps.length; mi++) {
        var cm = cmps[mi];
        if (cm.counts.total <= 0) continue;
        var cShare = (cm.counts.counts[val] || 0) / cm.counts.total;
        var amx = labelW + Math.min(cShare / maxShare, 1) * barAreaW;
        var amy = y + barH / 2;
        svg += '<path d="M' + amx.toFixed(1) + ',' + (amy - 4.2).toFixed(1) +
          ' L' + (amx + 4.2).toFixed(1) + ',' + amy.toFixed(1) +
          ' L' + amx.toFixed(1) + ',' + (amy + 4.2).toFixed(1) +
          ' L' + (amx - 4.2).toFixed(1) + ',' + amy.toFixed(1) + ' Z"' +
          ' fill="none" stroke="' + catCmpMarkerColor(mi) + '" stroke-width="1.2" opacity="0.85">' +
          '<title>' + esc(cm.label + ':' + colName) + ' — ' + (cShare * 100).toFixed(1) + '%</title></path>';
      }
    }

    // Pareto accumulation
    cumPct += total > 0 ? count / total * 100 : 0;
    paretoPoints.push({ x: labelW + barW, y: y + barH / 2, pct: cumPct });
  }

  // Comparison legend lines — one per overlaid dataset
  for (var li = 0; li < cmps.length; li++) {
    var lcm = cmps[li];
    var legY = showEntries.length * (barH + gap) + 24 + li * 16;
    var lgx = labelW;
    svg += '<path d="M' + lgx + ',' + (legY - 3) + ' L' + (lgx + 4.2) + ',' + (legY + 1.2) + ' L' + lgx + ',' + (legY + 5.4) + ' L' + (lgx - 4.2) + ',' + (legY + 1.2) + ' Z" fill="none" stroke="' + catCmpMarkerColor(li) + '" stroke-width="1.2" opacity="0.85"/>';
    svg += '<text x="' + (lgx + 10) + '" y="' + (legY + 4) + '" fill="var(--fg-dim)" font-size="8.5">' + esc(lcm.label + ':' + colName) + ' share, same axis' + (lcm.counts.overflow ? ' (' + esc(lcm.label) + ' overflowed — partial)' : '') + '</text>';
  }

  // Pareto line
  if (paretoPoints.length > 1 && total > 0) {
    var pPath = '';
    for (var pi = 0; pi < paretoPoints.length; pi++) {
      var px = labelW + (paretoPoints[pi].pct / 100) * barAreaW;
      var py = paretoPoints[pi].y;
      pPath += (pi === 0 ? 'M' : 'L') + px.toFixed(1) + ',' + py.toFixed(1);
    }
    svg += '<path d="' + pPath + '" fill="none" stroke="var(--action)" stroke-width="1.5" opacity="0.6" stroke-dasharray="4,3"/>';
    // Mark 80% line if it fits
    var line80y1 = 0, line80y2 = paretoPoints[paretoPoints.length - 1].y;
    var line80x = labelW + 0.8 * barAreaW;
    svg += '<line x1="' + line80x.toFixed(1) + '" y1="' + line80y1 + '" x2="' + line80x.toFixed(1) + '" y2="' + line80y2.toFixed(1) + '" stroke="var(--action)" stroke-width="0.5" opacity="0.3" stroke-dasharray="2,4"/>';
    svg += '<text x="' + line80x.toFixed(1) + '" y="' + (line80y2 + 14) + '" text-anchor="middle" fill="var(--action)" font-size="8" opacity="0.5">80%</text>';
  }

  svg += '</svg>';

  var toggleHtml = '';
  if (!showAll && entries.length > 30) {
    toggleHtml = '<div class="cat-chart-toggle">Show all ' + entries.length + ' values \u25BE</div>';
  } else if (st.chartShowAll && entries.length > 30) {
    toggleHtml = '<div class="cat-chart-toggle">Show top 20 \u25B4</div>';
  }

  els.chart.innerHTML = svg + toggleHtml;
}

function renderCatValueTable(root) {
  var st = catStateForRoot(root);
  if (!_catData || st.focusedCol === null) return;
  var els = catEls(root);
  var colName = _catData.header[st.focusedCol];
  var entries = getCatSortedEntries(st.focusedCol);
  var total = entries.reduce(function(s,e){ return s + e[1]; }, 0);
  var maxCount = 0;
  for (var i = 0; i < entries.length; i++) { if (entries[i][1] > maxCount) maxCount = entries[i][1]; }
  var defaultSort = (typeof bmaSettings !== 'undefined' && bmaSettings && bmaSettings.defaultCatSort) ? bmaSettings.defaultCatSort : 'count-desc';
  var mode = (catVarPeek('model', colName) || {}).sortMode || defaultSort;
  var isCustom = mode === 'custom';
  var search = ((els.valueSearch && els.valueSearch.value) || '').toLowerCase();

  // Limit to 500 values
  var show = entries.slice(0, 500);

  // A10 4c-iv: one n/% column-pair per shown comparison dataset (aux, d2…).
  var cmps = catCmpForCol(colName);

  var html = '<thead><tr>';
  html += '<th></th>'; // drag handle column — always present (C6: dragging sets Custom order)
  html += '<th title="Category colour">·</th>';
  html += '<th class="cat-cb-head"><input type="checkbox" data-cat-selectall title="Select all / none — ticked values filter the model"></th>';
  html += '<th>Value</th><th>Count</th><th>%</th>';
  cmps.forEach(function(cm) {
    var lbl = esc(cm.label + ':' + colName);
    html += '<th title="' + lbl + '">' + esc(cm.label) + ' n</th><th title="' + lbl + '">' + esc(cm.label) + ' %</th>';
  });
  html += '</tr></thead><tbody>';

  function cmpCells(val) {
    var s = '';
    cmps.forEach(function(cm) {
      var n = cm.counts.counts[val] || 0;
      var p = cm.counts.total > 0 ? (n / cm.counts.total * 100).toFixed(1) : '0.0';
      s += '<td class="cat-count-cell cat-aux-cell">' + (n > 0 ? n.toLocaleString() : '—') + '</td>';
      s += '<td class="cat-pct-cell cat-aux-cell">' + (n > 0 ? p + '%' : '—') + '</td>';
    });
    return s;
  }

  for (var ri = 0; ri < show.length; ri++) {
    var val = show[ri][0];
    var count = show[ri][1];
    if (search && !fuzzyMatch(search, val.toLowerCase())) continue;
    var pct = total > 0 ? (count / total * 100).toFixed(1) : '0.0';
    var barPct = maxCount > 0 ? (count / maxCount * 100).toFixed(1) : '0';
    var color = getCategoryColor(colName, val, ri);

    html += '<tr style="--bar:' + barPct + '%" data-val="' + esc(val) + '">';
    html += '<td class="cat-drag-cell' + (isCustom ? '' : ' cat-drag-cell--dormant') + '" draggable="true" title="Drag to reorder \u2014 sets Custom order">\u2261</td>';
    html += '<td class="cat-swatch-cell"><span class="cat-swatch" style="background:' + color + '" data-col="' + st.focusedCol + '" data-val="' + esc(val) + '"></span></td>';
    html += '<td class="cat-cb-cell"><input type="checkbox" data-col="' + st.focusedCol + '" data-val="' + esc(val) + '"></td>';
    html += '<td class="cat-val-cell">' + esc(val) + '</td>';
    html += '<td class="cat-count-cell">' + count.toLocaleString() + '</td>';
    html += '<td class="cat-pct-cell">' + pct + '%</td>';
    html += cmpCells(val);
    html += '</tr>';
  }

  // Values present in a comparison dataset but absent from the model \u2014 the
  // union across shown datasets, ranked by their largest comparison count.
  // Disagreements worth seeing (the legacy "aux only" rows, generalized).
  if (cmps.length > 0) {
    var primarySet = {};
    for (var pi = 0; pi < entries.length; pi++) primarySet[entries[pi][0]] = true;
    var extraMax = {};
    cmps.forEach(function(cm) {
      Object.keys(cm.counts.counts).forEach(function(v) {
        if (primarySet[v]) return;
        var n = cm.counts.counts[v] || 0;
        if (n > (extraMax[v] || 0)) extraMax[v] = n;
      });
    });
    var auxOnly = Object.keys(extraMax);
    auxOnly.sort(function(a, b) { return extraMax[b] - extraMax[a]; });
    var cmpOnlyTag = cmps.length === 1 ? esc(cmps[0].label) + ' only' : 'not in model';
    for (var ai = 0; ai < auxOnly.length; ai++) {
      var av = auxOnly[ai];
      if (search && !fuzzyMatch(search, av.toLowerCase())) continue;
      html += '<tr class="cat-aux-only" data-val="' + esc(av) + '">';
      html += '<td></td><td></td><td></td>';   // drag / swatch / checkbox columns (always present)
      html += '<td class="cat-val-cell">' + esc(av) + ' <span class="cat-aux-only-tag">' + cmpOnlyTag + '</span></td>';
      html += '<td class="cat-count-cell">\u2014</td><td class="cat-pct-cell">\u2014</td>';
      html += cmpCells(av);
      html += '</tr>';
    }
  }

  if (entries.length > 500) {
    var colSpan = 6 + cmps.length * 2;   // drag/swatch/cb/value/count/% (+ n/% per cmp ds)
    html += '<tr><td colspan="' + colSpan + '" style="color:var(--fg-dim);text-align:center;font-size:0.65rem;padding:0.4rem;">Showing 500 of ' + entries.length + ' values</td></tr>';
  }

  html += '</tbody>';
  els.valueTable.innerHTML = html;
}

function showCatColorPicker(colName, value, anchorEl, root) {
  var els = catEls(root);
  var picker = els.colorPicker;
  if (!picker) return;
  var currentColor = getCategoryColor(colName, value, 0);

  var html = '<div class="cat-color-grid">';
  for (var i = 0; i < STATSCAT_PALETTE.length; i++) {
    var c = STATSCAT_PALETTE[i];
    var sel = c.toLowerCase() === currentColor.toLowerCase() ? ' selected' : '';
    html += '<div class="cat-color-swatch' + sel + '" style="background:' + c + '" data-color="' + c + '"></div>';
  }
  html += '</div>';
  html += '<input type="text" class="cat-hex-input" placeholder="#hex" value="' + esc(currentColor) + '">';

  picker.innerHTML = html;
  picker.dataset.colName = colName;
  picker.dataset.value = value;

  // Position near the anchor
  var rect = anchorEl.getBoundingClientRect();
  var mainRect = els.main.getBoundingClientRect();
  picker.style.top = (rect.bottom - mainRect.top + 4) + 'px';
  picker.style.left = Math.max(0, rect.left - mainRect.left - 60) + 'px';
  picker.classList.add('open');
}

function hideCatColorPicker(root) {
  var picker = catEls(root).colorPicker;
  if (picker) picker.classList.remove('open');
}

function applyCatColor(colName, value, color, root) {
  var rec = catVar('model', colName);
  if (!rec.valueColors) rec.valueColors = {};
  rec.valueColors[value] = color;
  renderCatBarChart(root);
  renderCatValueTable(root);
  autoSaveProject();
}

function initCustomOrder(colName, colIdx) {
  var rec = catVar('model', colName);
  if (!rec.valueOrder) {
    var entries = getCatSortedEntries(colIdx);
    rec.valueOrder = entries.map(function(e){ return e[0]; });
  }
}

// A10 4e-c-4: event wiring per panel ROOT (was the singleton-only
// wireCatEventsOnce). Called for the singleton (#panelCategories) and for each
// clone — handlers resolve their instance via catStateForRoot(root) and render
// root-scoped, so every Categories panel is independent. The catalog
// (colors/sort/order) is shared, so an edit in one panel surfaces in any panel
// on the same column after its next render. Guarded per root (root._catWired).
function wireCatEvents(root) {
  root = root || catPanelRoot();
  if (!root || root._catWired) return;
  root._catWired = true;
  var els = catEls(root);
  var st = catStateForRoot(root);

  // Sidebar column click
  if (els.colList) els.colList.addEventListener('click', function(e) {
    var item = e.target.closest('.cat-col-item');
    if (!item) return;
    var colIdx = parseInt(item.dataset.col);
    if (colIdx === st.focusedCol) return;
    st.focusedCol = colIdx;
    st.chartShowAll = false;
    if (els.valueSearch) els.valueSearch.value = '';
    renderCatSidebar(root);
    renderCatMain(root);
    if (typeof catSyncInstanceTitle === 'function') catSyncInstanceTitle(root);
    autoSaveProject();
  });

  // Sidebar search (reads the input directly at render time, so no global mirror)
  if (els.colSearch) {
    els.colSearch.addEventListener('input', function() { renderCatSidebar(root); });
    wireSearchShortcuts(els.colSearch, null, null);
  }

  // Dataset chips (4c-iv) — toggle a comparison dataset's columns (dsHidden is
  // shared across instances for now); re-render the main area from cache.
  if (els.datasetChips) els.datasetChips.addEventListener('click', function(e) {
    var b = e.target.closest('[data-ds-chip]');
    if (!b) return;
    var id = b.dataset.dsChip;
    if (panelState.categories.dsHidden.has(id)) panelState.categories.dsHidden.delete(id);
    else panelState.categories.dsHidden.add(id);
    renderCatMain(root);
  });

  // Sort buttons (delegated on the sort group beside the value table — C6-4c)
  if (els.sortGroup) els.sortGroup.addEventListener('click', function(e) {
    var sortBtn = e.target.closest('.cat-sort-btn');
    if (!sortBtn) return;
    var colName = _catData.header[st.focusedCol];
    var newMode = sortBtn.dataset.sort;
    catVar('model', colName).sortMode = newMode;
    if (newMode === 'custom') initCustomOrder(colName, st.focusedCol);
    renderCatSortGroup(root);
    renderCatBarChart(root);
    renderCatValueTable(root);
    autoSaveProject();
  });

  // Copy button (delegated on the toolbar)
  if (els.toolbar) els.toolbar.addEventListener('click', function(e) {
    var copyBtn = e.target.closest('.cat-copy-btn');
    if (!copyBtn) return;
    var entries = getCatSortedEntries(st.focusedCol);
    var total = entries.reduce(function(s,e){ return s + e[1]; }, 0);
    var lines = ['Value\tCount\t%'];
    for (var i = 0; i < entries.length; i++) {
      var pct = total > 0 ? (entries[i][1] / total * 100).toFixed(1) : '0.0';
      lines.push(entries[i][0] + '\t' + entries[i][1] + '\t' + pct + '%');
    }
    navigator.clipboard.writeText(lines.join('\n'));
    copyBtn.textContent = 'Copied!';
    setTimeout(function(){ copyBtn.textContent = 'Copy'; }, 1500);
  });

  // Chart toggle (delegated on chart area)
  if (els.chart) els.chart.addEventListener('click', function(e) {
    if (e.target.closest('.cat-chart-toggle')) {
      st.chartShowAll = !st.chartShowAll;
      renderCatBarChart(root);
    }
  });

  // Value search
  if (els.valueSearch) {
    els.valueSearch.addEventListener('input', function() { renderCatValueTable(root); });
    wireSearchShortcuts(els.valueSearch, null, null);
  }

  // Table event delegation
  if (els.valueTable) els.valueTable.addEventListener('click', function(e) {
    // Swatch click → color picker
    var swatch = e.target.closest('.cat-swatch');
    if (swatch) {
      var colName = _catData.header[parseInt(swatch.dataset.col)];
      showCatColorPicker(colName, swatch.dataset.val, swatch, root);
      return;
    }
    // Checkbox change
    var cb = e.target.closest('input[type="checkbox"]');
    if (cb) {
      // Header select-all → toggle every visible value checkbox, then filter
      if (cb.hasAttribute('data-cat-selectall')) {
        var on = cb.checked;
        els.valueTable.querySelectorAll('.cat-cb-cell input[type="checkbox"]').forEach(function(b) {
          b.checked = on;
          var r = b.closest('tr'); if (r) r.classList.toggle('active', on);
        });
        rebuildFilterExpression();
        return;
      }
      var tr = cb.closest('tr');
      if (tr) tr.classList.toggle('active', cb.checked);
      rebuildFilterExpression();
      return;
    }
  });

  // Color picker delegation
  if (els.colorPicker) {
    els.colorPicker.addEventListener('click', function(e) {
      var swatch = e.target.closest('.cat-color-swatch');
      if (!swatch) return;
      applyCatColor(els.colorPicker.dataset.colName, els.colorPicker.dataset.value, swatch.dataset.color, root);
      hideCatColorPicker(root);
    });
    els.colorPicker.addEventListener('change', function(e) {
      if (!e.target.classList.contains('cat-hex-input')) return;
      var hex = e.target.value.trim();
      if (/^#?[0-9a-fA-F]{3,8}$/.test(hex)) {
        if (hex[0] !== '#') hex = '#' + hex;
        applyCatColor(els.colorPicker.dataset.colName, els.colorPicker.dataset.value, hex, root);
        hideCatColorPicker(root);
      }
    });
  }

  // Drag and drop for custom ordering
  var dragSrcRow = null;
  if (els.valueTable) {
    els.valueTable.addEventListener('dragstart', function(e) {
      var tr = e.target.closest('tr');
      if (!tr || !e.target.classList.contains('cat-drag-cell')) return;
      dragSrcRow = tr;
      tr.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', tr.dataset.val);
    });
    els.valueTable.addEventListener('dragover', function(e) {
      e.preventDefault();
      var tr = e.target.closest('tr');
      if (!tr || tr === dragSrcRow) return;
      e.dataTransfer.dropEffect = 'move';
      els.valueTable.querySelectorAll('.drag-over').forEach(function(el){ el.classList.remove('drag-over'); });
      tr.classList.add('drag-over');
    });
    els.valueTable.addEventListener('dragleave', function(e) {
      var tr = e.target.closest('tr');
      if (tr) tr.classList.remove('drag-over');
    });
    els.valueTable.addEventListener('drop', function(e) {
      e.preventDefault();
      var tr = e.target.closest('tr');
      if (!tr || !dragSrcRow || tr === dragSrcRow) return;
      els.valueTable.querySelectorAll('.drag-over').forEach(function(el){ el.classList.remove('drag-over'); });
      dragSrcRow.classList.remove('dragging');

      var colName = _catData.header[st.focusedCol];
      var rec = catVar('model', colName);
      if (rec.sortMode !== 'custom') {
        rec.valueOrder = getCatSortedEntries(st.focusedCol).map(function(e) { return e[0]; });
        rec.sortMode = 'custom';
        renderCatSortGroup(root);
      } else {
        initCustomOrder(colName, st.focusedCol);
      }
      var order = rec.valueOrder;
      var fromVal = dragSrcRow.dataset.val;
      var toVal = tr.dataset.val;
      var fromIdx = order.indexOf(fromVal);
      var toIdx = order.indexOf(toVal);
      if (fromIdx >= 0 && toIdx >= 0) {
        order.splice(fromIdx, 1);
        var newToIdx = order.indexOf(toVal);
        order.splice(newToIdx, 0, fromVal);
        renderCatBarChart(root);
        renderCatValueTable(root);
        autoSaveProject();
      }
      dragSrcRow = null;
    });
    els.valueTable.addEventListener('dragend', function() {
      if (dragSrcRow) dragSrcRow.classList.remove('dragging');
      els.valueTable.querySelectorAll('.drag-over').forEach(function(el){ el.classList.remove('drag-over'); });
      dragSrcRow = null;
    });
  }

  // Close any open colour picker on outside click / Escape (bound once)
  if (!wireCatEvents._docClose) {
    wireCatEvents._docClose = true;
    document.addEventListener('click', function(e) {
      if (e.target.classList && e.target.classList.contains('cat-swatch')) return;
      document.querySelectorAll('.cat-color-picker.open').forEach(function(p) {
        if (!p.contains(e.target)) p.classList.remove('open');
      });
    });
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') document.querySelectorAll('.cat-color-picker.open').forEach(function(p) { p.classList.remove('open'); });
    });
  }
}

// ─── A10 4e-c-4b: cloneable Categories instances ───────────────────────────
// A clone is a copy of #panelCategories with its ids stripped (DOM resolved by
// data-cat within the clone root, tagged data-cat-inst). Its {focusedCol,
// chartShowAll} live in catInstances[id]; the data (_catData) and catalog are
// shared, so a clone shows its OWN column from the same analysis. rails calls
// catBuildInstancePanel(id) via renderPanel; wsSpawnCategoriesInstance and the
// tab "Duplicate" create them.
var catInstSeq = 1;
var catInstanceEls = {};   // instId -> the built clone element (one per instance)
function catNextInstId() { catInstSeq += 1; return 'categories#' + catInstSeq; }

function catBuildInstancePanel(instId) {
  var tmpl = document.getElementById('panelCategories');
  if (!tmpl) return null;
  // rails may call renderPanel more than once for a tab id (addTab re-renders);
  // return the SAME clone each time (as getElementById does for singletons), so
  // a second call never leaves a duplicate clone in the DOM.
  if (catInstanceEls[instId] && document.contains(catInstanceEls[instId])) return catInstanceEls[instId];
  if (!catInstances[instId]) {
    catInstances[instId] = catNewInstState();
    catInstances[instId].focusedCol = panelState.categories.focusedCol;
  }
  var el = tmpl.cloneNode(true);
  el.removeAttribute('id');
  el.querySelectorAll('[id]').forEach(function(n) { n.removeAttribute('id'); });
  el.setAttribute('data-cat-inst', instId);
  el.setAttribute('data-tab', instId);
  el.classList.add('active');
  // The clone copied the singleton's rendered DOM — clear the search inputs and
  // any open colour picker, then render fresh from _catData into the clone.
  var els = catEls(el);
  if (els.colSearch) els.colSearch.value = '';
  if (els.valueSearch) els.valueSearch.value = '';
  if (els.colorPicker) els.colorPicker.classList.remove('open');
  wireCatEvents(el);
  catRenderInstance(el);
  catInstanceEls[instId] = el;
  return el;
}

function catRenderInstance(root) {
  if (!_catData) return;
  var st = catStateForRoot(root);
  // 4e-c-5: a restored instance carries its focused column by NAME (the header
  // may differ across reloads) — resolve to an index now that _catData exists.
  if (st._pendingFocusName != null) {
    var ri = _catData.header ? _catData.header.indexOf(st._pendingFocusName) : -1;
    if (ri >= 0 && _catData.categories[ri]) st.focusedCol = ri;
    delete st._pendingFocusName;
  }
  if (st.focusedCol == null || !_catData.categories[st.focusedCol]) st.focusedCol = panelState.categories.focusedCol;
  renderCatSidebar(root);
  renderCatMain(root);
  // NB: the tab title is synced by the spawn flow + the column-click handler,
  // NOT here — updateTab re-renders the strip, and calling it mid-build (while
  // rails is still inside renderPanel) reentrantly rebuilds the panel.
}

// Scope-derived tab title — "Categories: <focused column>" (singleton keeps its
// static "Categories" title).
function catSyncInstanceTitle(root) {
  if (!root || typeof wsRails === 'undefined' || !wsRails || typeof findTab !== 'function') return;
  var instId = root.getAttribute && root.getAttribute('data-cat-inst');
  if (!instId) return;
  var st = catInstances[instId];
  var name = (st && st.focusedCol != null && _catData && _catData.header) ? _catData.header[st.focusedCol] : null;
  if (findTab(wsRails.state, instId)) wsRails.updateTab(instId, { title: name ? 'Categories: ' + name : 'Categories' });
}

// Re-render every live clone after a (re)analysis — _catData changed under them.
function catRenderAllInstances() {
  Object.keys(catInstances).forEach(function(id) {
    var root = document.querySelector('[data-cat-inst="' + id + '"]');
    if (root) { catRenderInstance(root); catSyncInstanceTitle(root); }  // safe here — not inside a renderPanel build
  });
}

// ─── A10 4e-c-5: persist cloned Categories instances ───────────────────────
// Instances ride in the `panels` project key (serializePanelState) as
// {id, focusedCol(NAME), chartShowAll}; the tab arrangement rides in `layout`
// (wsSanitizeLayout keeps an instance id once its state is recreated). focusedCol
// is stored by NAME (the cmpSel pattern) so a reordered/changed header still
// resolves; an unresolved restore re-emits its name (loss-safe through autosave).
function serializeCatInstances() {
  var hdr = (typeof _catData !== 'undefined' && _catData) ? _catData.header : null;
  var out = [];
  Object.keys(catInstances).forEach(function(id) {
    var st = catInstances[id];
    var name = null;
    if (st._pendingFocusName != null) name = st._pendingFocusName;                 // restored, not yet resolved
    else if (st.focusedCol != null && hdr && hdr[st.focusedCol] != null) name = hdr[st.focusedCol];
    out.push({ id: id, focusedCol: name, chartShowAll: !!st.chartShowAll });
  });
  return out;
}

// Drop all per-instance state (new file / clear project), closing any live clone
// tabs first so the rails strip doesn't keep orphaned tabs.
function catResetInstances() {
  if (typeof wsRails !== 'undefined' && wsRails && typeof findTab === 'function') {
    Object.keys(catInstances).forEach(function(id) {
      if (findTab(wsRails.state, id)) { try { wsRails.closeTab(id); } catch (e) {} }
    });
  }
  catInstances = {};
  catInstanceEls = {};
  catInstSeq = 1;
}

// Recreate instances from a serialized list BEFORE the layout deserialize rebuilds
// their tabs (renderPanel → catBuildInstancePanel finds the state we seed here).
// The focused column stays pending until catRenderInstance resolves it post-analysis.
function catRestoreInstances(list) {
  catResetInstances();
  if (!Array.isArray(list)) return;
  var maxSeq = 1;
  list.forEach(function(rec) {
    if (!rec || !rec.id) return;
    var st = catNewInstState();
    st.chartShowAll = !!rec.chartShowAll;
    if (rec.focusedCol != null) st._pendingFocusName = rec.focusedCol;
    catInstances[rec.id] = st;
    var m = /^categories#(\d+)$/.exec(rec.id);
    if (m) maxSeq = Math.max(maxSeq, parseInt(m[1], 10));
  });
  catInstSeq = maxSeq;       // new spawns won't collide with restored ids
}
