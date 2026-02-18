// ─── Categories Tab ────────────────────────────────────────────────────
let _catData = null;       // cached { categories, header, origColCount, rowCount }
let _catColSearch = '';

function renderCategoriesTab(categories, header, origColCount, rowCount) {
  _catData = { categories, header, origColCount, rowCount };
  const catCols = Object.keys(categories).map(Number).sort(function(a,b){return a-b;});

  $catBadge.textContent = catCols.length + ' columns';

  if (catCols.length === 0) {
    $catColList.innerHTML = '';
    $catToolbar.innerHTML = '';
    $catChart.innerHTML = '';
    $catValueTable.querySelector('tbody').innerHTML = '';
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
  if (catFocusedCol === null || !categories[catFocusedCol]) {
    catFocusedCol = catCols[0];
  }

  renderCatSidebar();
  renderCatMain();
  wireCatEventsOnce();
}

function renderCatSidebar() {
  if (!_catData) return;
  var categories = _catData.categories;
  var header = _catData.header;
  var origColCount = _catData.origColCount;
  var catCols = Object.keys(categories).map(Number).sort(function(a,b){return a-b;});
  var search = _catColSearch.toLowerCase();
  var html = '';
  for (var ci = 0; ci < catCols.length; ci++) {
    var i = catCols[ci];
    var name = header[i];
    if (search && !fuzzyMatch(search, name.toLowerCase())) continue;
    var cat = categories[i];
    var uniqueCount = Object.keys(cat.counts).length + (cat.overflow ? '+' : '');
    var isCalcol = i >= origColCount;
    var active = i === catFocusedCol ? ' active' : '';
    html += '<div class="cat-col-item' + active + '" data-col="' + i + '">';
    html += '<span class="col-name">' + esc(name) + '</span>';
    if (isCalcol) html += '<span class="calcol-tag">CALC</span>';
    html += '<span class="col-count">' + uniqueCount + '</span>';
    html += '</div>';
  }
  $catColList.innerHTML = html;
}

function renderCatMain() {
  if (!_catData || catFocusedCol === null) return;
  renderCatToolbar();
  renderCatBarChart();
  renderCatValueTable();
}

function getCatSortedEntries(colIdx) {
  if (!_catData) return [];
  var cat = _catData.categories[colIdx];
  if (!cat) return [];
  var entries = Object.entries(cat.counts);
  var colName = _catData.header[colIdx];
  var defaultSort = (typeof bmaSettings !== 'undefined' && bmaSettings && bmaSettings.defaultCatSort) ? bmaSettings.defaultCatSort : 'count-desc';
  var mode = catSortModes[colName] || defaultSort;

  if (mode === 'count-desc') {
    entries.sort(function(a,b){ return b[1] - a[1]; });
  } else if (mode === 'count-asc') {
    entries.sort(function(a,b){ return a[1] - b[1]; });
  } else if (mode === 'alpha') {
    entries.sort(function(a,b){ return a[0].localeCompare(b[0]); });
  } else if (mode === 'custom') {
    var order = catCustomOrders[colName];
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

function renderCatToolbar() {
  if (!_catData || catFocusedCol === null) return;
  var header = _catData.header;
  var origColCount = _catData.origColCount;
  var colName = header[catFocusedCol];
  var isCalcol = catFocusedCol >= origColCount;
  var defaultSort = (typeof bmaSettings !== 'undefined' && bmaSettings && bmaSettings.defaultCatSort) ? bmaSettings.defaultCatSort : 'count-desc';
  var mode = catSortModes[colName] || defaultSort;

  // Meta info
  var cat = _catData.categories[catFocusedCol];
  var entries = Object.entries(cat.counts);
  var uniqueCount = entries.length + (cat.overflow ? '+' : '');
  var total = entries.reduce(function(s,e){ return s + e[1]; }, 0);
  var nullCount = _catData.rowCount - total;
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

  var html = '<div class="cat-toolbar-title">' + esc(colName);
  if (isCalcol) html += ' <span class="calcol-tag">CALC</span>';
  html += '</div>';

  // Meta badges
  html += '<span style="font-size:0.62rem;color:var(--fg-dim)">' + uniqueCount + ' unique';
  if (nullCount > 0) html += ' \u00B7 ' + nullCount.toLocaleString() + ' null';
  if (maxEntropy > 0) html += ' \u00B7 H=' + entropy.toFixed(2) + ' (' + normPct + '%)';
  html += '</span>';

  // Sort buttons
  html += '<div class="cat-sort-group">';
  html += '<button class="cat-sort-btn' + (mode === 'count-desc' ? ' active' : '') + '" data-sort="count-desc" title="Sort by count descending">Count\u2193</button>';
  html += '<button class="cat-sort-btn' + (mode === 'count-asc' ? ' active' : '') + '" data-sort="count-asc" title="Sort by count ascending">Count\u2191</button>';
  html += '<button class="cat-sort-btn' + (mode === 'alpha' ? ' active' : '') + '" data-sort="alpha" title="Sort alphabetically">A-Z</button>';
  html += '<button class="cat-sort-btn' + (mode === 'custom' ? ' active' : '') + '" data-sort="custom" title="Custom drag order">Custom</button>';
  html += '</div>';

  // Copy button
  html += '<button class="cat-copy-btn" id="catCopyBtn" title="Copy as table">Copy</button>';

  $catToolbar.innerHTML = html;
}

function renderCatBarChart() {
  if (!_catData || catFocusedCol === null) return;
  var colName = _catData.header[catFocusedCol];
  var entries = getCatSortedEntries(catFocusedCol);
  if (entries.length === 0) { $catChart.innerHTML = ''; return; }

  var total = entries.reduce(function(s,e){ return s + e[1]; }, 0);
  var maxCount = 0;
  for (var i = 0; i < entries.length; i++) { if (entries[i][1] > maxCount) maxCount = entries[i][1]; }

  // Determine how many bars to show
  var showAll = catChartShowAll || entries.length <= 30;
  var showEntries = showAll ? entries : entries.slice(0, 20);

  var barH = 18, gap = 2, labelW = 120, rightPad = 60;
  var chartH = showEntries.length * (barH + gap) + 30; // +30 for Pareto line clearance
  var chartW = 600;
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

    // Pareto accumulation
    cumPct += total > 0 ? count / total * 100 : 0;
    paretoPoints.push({ x: labelW + barW, y: y + barH / 2, pct: cumPct });
  }

  // Pareto line
  if (paretoPoints.length > 1 && total > 0) {
    var pPath = '';
    for (var pi = 0; pi < paretoPoints.length; pi++) {
      var px = labelW + (paretoPoints[pi].pct / 100) * barAreaW;
      var py = paretoPoints[pi].y;
      pPath += (pi === 0 ? 'M' : 'L') + px.toFixed(1) + ',' + py.toFixed(1);
    }
    svg += '<path d="' + pPath + '" fill="none" stroke="var(--amber)" stroke-width="1.5" opacity="0.6" stroke-dasharray="4,3"/>';
    // Mark 80% line if it fits
    var line80y1 = 0, line80y2 = paretoPoints[paretoPoints.length - 1].y;
    var line80x = labelW + 0.8 * barAreaW;
    svg += '<line x1="' + line80x.toFixed(1) + '" y1="' + line80y1 + '" x2="' + line80x.toFixed(1) + '" y2="' + line80y2.toFixed(1) + '" stroke="var(--amber)" stroke-width="0.5" opacity="0.3" stroke-dasharray="2,4"/>';
    svg += '<text x="' + line80x.toFixed(1) + '" y="' + (line80y2 + 14) + '" text-anchor="middle" fill="var(--amber)" font-size="8" opacity="0.5">80%</text>';
  }

  svg += '</svg>';

  var toggleHtml = '';
  if (!showAll && entries.length > 30) {
    toggleHtml = '<div class="cat-chart-toggle" id="catChartToggle">Show all ' + entries.length + ' values \u25BE</div>';
  } else if (catChartShowAll && entries.length > 30) {
    toggleHtml = '<div class="cat-chart-toggle" id="catChartToggle">Show top 20 \u25B4</div>';
  }

  $catChart.innerHTML = svg + toggleHtml;
}

function renderCatValueTable() {
  if (!_catData || catFocusedCol === null) return;
  var colName = _catData.header[catFocusedCol];
  var entries = getCatSortedEntries(catFocusedCol);
  var total = entries.reduce(function(s,e){ return s + e[1]; }, 0);
  var maxCount = 0;
  for (var i = 0; i < entries.length; i++) { if (entries[i][1] > maxCount) maxCount = entries[i][1]; }
  var defaultSort = (typeof bmaSettings !== 'undefined' && bmaSettings && bmaSettings.defaultCatSort) ? bmaSettings.defaultCatSort : 'count-desc';
  var mode = catSortModes[colName] || defaultSort;
  var isCustom = mode === 'custom';
  var search = ($catValueSearch.value || '').toLowerCase();

  // Limit to 500 values
  var show = entries.slice(0, 500);

  var html = '<thead><tr>';
  if (isCustom) html += '<th></th>'; // drag handle column
  html += '<th></th><th></th><th>Value</th><th>Count</th><th>%</th></tr></thead><tbody>';

  for (var ri = 0; ri < show.length; ri++) {
    var val = show[ri][0];
    var count = show[ri][1];
    if (search && !fuzzyMatch(search, val.toLowerCase())) continue;
    var pct = total > 0 ? (count / total * 100).toFixed(1) : '0.0';
    var barPct = maxCount > 0 ? (count / maxCount * 100).toFixed(1) : '0';
    var color = getCategoryColor(colName, val, ri);

    html += '<tr style="--bar:' + barPct + '%" data-val="' + esc(val) + '">';
    if (isCustom) html += '<td class="cat-drag-cell" draggable="true">\u2261</td>';
    html += '<td class="cat-swatch-cell"><span class="cat-swatch" style="background:' + color + '" data-col="' + catFocusedCol + '" data-val="' + esc(val) + '"></span></td>';
    html += '<td class="cat-cb-cell"><input type="checkbox" data-col="' + catFocusedCol + '" data-val="' + esc(val) + '"></td>';
    html += '<td class="cat-val-cell">' + esc(val) + '</td>';
    html += '<td class="cat-count-cell">' + count.toLocaleString() + '</td>';
    html += '<td class="cat-pct-cell">' + pct + '%</td>';
    html += '</tr>';
  }

  if (entries.length > 500) {
    var colSpan = isCustom ? 7 : 6;
    html += '<tr><td colspan="' + colSpan + '" style="color:var(--fg-dim);text-align:center;font-size:0.65rem;padding:0.4rem;">Showing 500 of ' + entries.length + ' values</td></tr>';
  }

  html += '</tbody>';
  $catValueTable.innerHTML = html;
}

function showCatColorPicker(colName, value, anchorEl) {
  var currentColor = getCategoryColor(colName, value, 0);

  var html = '<div class="cat-color-grid">';
  for (var i = 0; i < STATSCAT_PALETTE.length; i++) {
    var c = STATSCAT_PALETTE[i];
    var sel = c.toLowerCase() === currentColor.toLowerCase() ? ' selected' : '';
    html += '<div class="cat-color-swatch' + sel + '" style="background:' + c + '" data-color="' + c + '"></div>';
  }
  html += '</div>';
  html += '<input type="text" class="cat-hex-input" placeholder="#hex" value="' + esc(currentColor) + '">';

  $catColorPicker.innerHTML = html;
  $catColorPicker.dataset.colName = colName;
  $catColorPicker.dataset.value = value;

  // Position near the anchor
  var rect = anchorEl.getBoundingClientRect();
  var mainRect = $catMain.getBoundingClientRect();
  $catColorPicker.style.top = (rect.bottom - mainRect.top + 4) + 'px';
  $catColorPicker.style.left = Math.max(0, rect.left - mainRect.left - 60) + 'px';
  $catColorPicker.classList.add('open');
}

function hideCatColorPicker() {
  $catColorPicker.classList.remove('open');
}

function applyCatColor(colName, value, color) {
  if (!catColorOverrides[colName]) catColorOverrides[colName] = {};
  catColorOverrides[colName][value] = color;
  renderCatBarChart();
  renderCatValueTable();
  autoSaveProject();
}

function initCustomOrder(colName) {
  if (!catCustomOrders[colName]) {
    var entries = getCatSortedEntries(catFocusedCol);
    catCustomOrders[colName] = entries.map(function(e){ return e[0]; });
  }
}

function wireCatEventsOnce() {
  if (_catEventsWired) return;
  _catEventsWired = true;

  // Sidebar column click
  $catColList.addEventListener('click', function(e) {
    var item = e.target.closest('.cat-col-item');
    if (!item) return;
    var colIdx = parseInt(item.dataset.col);
    if (colIdx === catFocusedCol) return;
    catFocusedCol = colIdx;
    catChartShowAll = false;
    $catValueSearch.value = '';
    renderCatSidebar();
    renderCatMain();
    autoSaveProject();
  });

  // Sidebar search
  $catColSearch.addEventListener('input', function() {
    _catColSearch = $catColSearch.value;
    renderCatSidebar();
  });
  wireSearchShortcuts($catColSearch, null, null);

  // Sort buttons (delegated on toolbar)
  $catToolbar.addEventListener('click', function(e) {
    var sortBtn = e.target.closest('.cat-sort-btn');
    if (sortBtn) {
      var colName = _catData.header[catFocusedCol];
      var newMode = sortBtn.dataset.sort;
      catSortModes[colName] = newMode;
      if (newMode === 'custom') initCustomOrder(colName);
      renderCatToolbar();
      renderCatBarChart();
      renderCatValueTable();
      autoSaveProject();
      return;
    }

    // Copy button
    var copyBtn = e.target.closest('#catCopyBtn');
    if (copyBtn) {
      var entries = getCatSortedEntries(catFocusedCol);
      var total = entries.reduce(function(s,e){ return s + e[1]; }, 0);
      var lines = ['Value\tCount\t%'];
      for (var i = 0; i < entries.length; i++) {
        var pct = total > 0 ? (entries[i][1] / total * 100).toFixed(1) : '0.0';
        lines.push(entries[i][0] + '\t' + entries[i][1] + '\t' + pct + '%');
      }
      navigator.clipboard.writeText(lines.join('\n'));
      copyBtn.textContent = 'Copied!';
      setTimeout(function(){ copyBtn.textContent = 'Copy'; }, 1500);
    }
  });

  // Chart toggle (delegated on chart area)
  $catChart.addEventListener('click', function(e) {
    if (e.target.closest('.cat-chart-toggle')) {
      catChartShowAll = !catChartShowAll;
      renderCatBarChart();
    }
  });

  // Value search
  $catValueSearch.addEventListener('input', function() {
    renderCatValueTable();
  });
  wireSearchShortcuts($catValueSearch, null, null);

  // Table event delegation
  $catValueTable.addEventListener('click', function(e) {
    // Swatch click → color picker
    var swatch = e.target.closest('.cat-swatch');
    if (swatch) {
      var colName = _catData.header[parseInt(swatch.dataset.col)];
      showCatColorPicker(colName, swatch.dataset.val, swatch);
      return;
    }

    // Checkbox change
    var cb = e.target.closest('input[type="checkbox"]');
    if (cb) {
      var tr = cb.closest('tr');
      if (tr) tr.classList.toggle('active', cb.checked);
      rebuildFilterExpression();
      return;
    }
  });

  // Color picker delegation
  $catColorPicker.addEventListener('click', function(e) {
    var swatch = e.target.closest('.cat-color-swatch');
    if (swatch) {
      var cn = $catColorPicker.dataset.colName;
      var v = $catColorPicker.dataset.value;
      applyCatColor(cn, v, swatch.dataset.color);
      hideCatColorPicker();
      return;
    }
  });

  // Hex input
  $catColorPicker.addEventListener('change', function(e) {
    if (e.target.classList.contains('cat-hex-input')) {
      var hex = e.target.value.trim();
      if (/^#?[0-9a-fA-F]{3,8}$/.test(hex)) {
        if (hex[0] !== '#') hex = '#' + hex;
        var cn = $catColorPicker.dataset.colName;
        var v = $catColorPicker.dataset.value;
        applyCatColor(cn, v, hex);
        hideCatColorPicker();
      }
    }
  });

  // Close color picker on click outside
  document.addEventListener('click', function(e) {
    if (!$catColorPicker.classList.contains('open')) return;
    if ($catColorPicker.contains(e.target)) return;
    if (e.target.classList.contains('cat-swatch')) return;
    hideCatColorPicker();
  });

  // Close color picker on Escape
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && $catColorPicker.classList.contains('open')) {
      hideCatColorPicker();
    }
  });

  // Drag and drop for custom ordering
  var dragSrcRow = null;
  $catValueTable.addEventListener('dragstart', function(e) {
    var tr = e.target.closest('tr');
    if (!tr || !e.target.classList.contains('cat-drag-cell')) return;
    dragSrcRow = tr;
    tr.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tr.dataset.val);
  });

  $catValueTable.addEventListener('dragover', function(e) {
    e.preventDefault();
    var tr = e.target.closest('tr');
    if (!tr || tr === dragSrcRow) return;
    e.dataTransfer.dropEffect = 'move';
    // Clear previous drag-over
    $catValueTable.querySelectorAll('.drag-over').forEach(function(el){ el.classList.remove('drag-over'); });
    tr.classList.add('drag-over');
  });

  $catValueTable.addEventListener('dragleave', function(e) {
    var tr = e.target.closest('tr');
    if (tr) tr.classList.remove('drag-over');
  });

  $catValueTable.addEventListener('drop', function(e) {
    e.preventDefault();
    var tr = e.target.closest('tr');
    if (!tr || !dragSrcRow || tr === dragSrcRow) return;
    $catValueTable.querySelectorAll('.drag-over').forEach(function(el){ el.classList.remove('drag-over'); });
    dragSrcRow.classList.remove('dragging');

    var colName = _catData.header[catFocusedCol];
    initCustomOrder(colName);
    var order = catCustomOrders[colName];
    var fromVal = dragSrcRow.dataset.val;
    var toVal = tr.dataset.val;
    var fromIdx = order.indexOf(fromVal);
    var toIdx = order.indexOf(toVal);
    if (fromIdx >= 0 && toIdx >= 0) {
      order.splice(fromIdx, 1);
      var newToIdx = order.indexOf(toVal);
      order.splice(newToIdx, 0, fromVal);
      renderCatBarChart();
      renderCatValueTable();
      autoSaveProject();
    }
    dragSrcRow = null;
  });

  $catValueTable.addEventListener('dragend', function() {
    if (dragSrcRow) dragSrcRow.classList.remove('dragging');
    $catValueTable.querySelectorAll('.drag-over').forEach(function(el){ el.classList.remove('drag-over'); });
    dragSrcRow = null;
  });
}
