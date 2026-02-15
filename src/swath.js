// ─── Swath Tab ────────────────────────────────────────────────────────

let swathNumCols = [];

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
  const varItems = swathNumCols.map(c =>
    '<label class="swath-var-item"><input type="checkbox" value="' + c.idx + '" checked><span>' + esc(c.name) + '</span></label>'
  ).join('');

  $sidebar.innerHTML = `
    <div class="swath-sidebar-section">
      <div class="swath-sidebar-title">Axis</div>
      <select class="swath-select" id="swathAxis">${axes.map(a => '<option value="' + a.key + '">' + a.label + '</option>').join('')}</select>
      <div style="margin-top:0.4rem">
        <div class="swath-sidebar-title">Bin Width</div>
        <input type="number" class="swath-input" id="swathBinWidth" value="${defaultBs}" min="0.001" step="any">
        <div class="swath-bin-label" id="swathBinLabel">${defaultBs}m blocks</div>
      </div>
    </div>
    <div class="swath-sidebar-section">
      <div class="swath-sidebar-title">Statistic</div>
      <select class="swath-select" id="swathStat">
        <option value="mean_std">Mean \u00b1 Std</option>
        <option value="p25_50_75">P25 / P50 / P75</option>
        <option value="p10_50_90">P10 / P50 / P90</option>
      </select>
    </div>
    <div class="swath-sidebar-section--grow">
      <div class="swath-sidebar-title">Variables</div>
      <div class="swath-var-btns">
        <button id="swathVarAll">All</button>
        <button id="swathVarNone">None</button>
      </div>
      <div class="swath-var-list" id="swathVarList">${varItems}</div>
    </div>
    <div class="swath-sidebar-section">
      <div class="swath-sidebar-title">Local Filter</div>
      <input type="text" class="swath-search" id="swathLocalFilter" placeholder="e.g. r.zone == 1" autocomplete="off" spellcheck="false">
    </div>
    <div class="swath-sidebar-section">
      <button class="swath-generate" id="swathGenerate">Generate</button>
      <div class="swath-progress" id="swathProgress">
        <div class="swath-progress-bar"><div class="swath-progress-fill" id="swathProgressFill"></div></div>
        <div class="swath-progress-label" id="swathProgressLabel"></div>
      </div>
    </div>`;

  $content.innerHTML = '<div class="swath-hint">Select variables and click Generate to create swath plots.</div>';

  // Update bin width + label when axis changes
  const $axis = document.getElementById('swathAxis');
  const $binWidth = document.getElementById('swathBinWidth');
  const $binLabel = document.getElementById('swathBinLabel');
  $axis.addEventListener('change', () => {
    const a = axes.find(ax => ax.key === $axis.value);
    if (a) {
      $binWidth.value = a.bs;
      $binLabel.textContent = a.bs + 'm blocks';
    }
  });
  $binWidth.addEventListener('input', () => {
    const a = axes.find(ax => ax.key === $axis.value);
    $binLabel.textContent = (a ? a.bs : '') + 'm blocks';
  });

  // All/None buttons
  document.getElementById('swathVarAll').addEventListener('click', () => {
    document.querySelectorAll('#swathVarList input[type="checkbox"]').forEach(cb => cb.checked = true);
  });
  document.getElementById('swathVarNone').addEventListener('click', () => {
    document.querySelectorAll('#swathVarList input[type="checkbox"]').forEach(cb => cb.checked = false);
  });

  // Generate button
  document.getElementById('swathGenerate').addEventListener('click', runSwath);

  // Stat change re-renders from cache
  document.getElementById('swathStat').addEventListener('change', () => {
    if (lastSwathData) renderSwathCharts(lastSwathData, document.getElementById('swathStat').value);
  });

  // Local filter autocomplete
  if (swathExprController) swathExprController.destroy();
  swathExprController = createExprInput(document.getElementById('swathLocalFilter'), { mode: 'filter' });
}

function runSwath() {
  if (swathExprController) { const r = swathExprController.validate(); if (!r.valid) return; }
  const axisVal = document.getElementById('swathAxis').value;
  const binWidth = parseFloat(document.getElementById('swathBinWidth').value);
  const stat = document.getElementById('swathStat').value;
  const localFilter = document.getElementById('swathLocalFilter').value.trim();
  if (!binWidth || binWidth <= 0) return;

  // Gather selected variable column indices
  const varCols = [];
  document.querySelectorAll('#swathVarList input[type="checkbox"]:checked').forEach(cb => {
    varCols.push(parseInt(cb.value));
  });
  if (varCols.length === 0) return;

  if (swathWorker) swathWorker.terminate();
  swathWorker = new Worker(workerUrl);

  const $progress = document.getElementById('swathProgress');
  const $fill = document.getElementById('swathProgressFill');
  const $label = document.getElementById('swathProgressLabel');
  const $content = document.getElementById('swathContent');
  $progress.classList.add('active');
  $fill.style.width = '0%';
  $label.textContent = '0%';
  $content.innerHTML = '';

  const $btn = document.getElementById('swathGenerate');
  if ($btn) $btn.disabled = true;

  const resolvedTypes = currentColTypes.slice(0, currentOrigColCount);
  const filterPayload = currentFilter ? { expression: currentFilter.expression } : null;
  const zipEntry = preflightData ? (preflightData.selectedZipEntry || null) : null;

  const axisIdx = axisVal === 'x' ? 0 : (axisVal === 'y' ? 1 : 2);
  const xyzCols = [currentXYZ.x, currentXYZ.y, currentXYZ.z];
  const dxyzCols = [currentDXYZ.dx, currentDXYZ.dy, currentDXYZ.dz];

  swathWorker.postMessage({
    mode: 'swath',
    file: currentFile,
    zipEntry,
    globalFilter: filterPayload,
    localFilter: localFilter || null,
    calcolCode: currentCalcolCode || null,
    calcolMeta: currentCalcolMeta.length > 0 ? currentCalcolMeta : null,
    resolvedTypes,
    xyzCols,
    dxyzCols,
    axis: axisIdx,
    varCols,
    binWidth
  });

  swathWorker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'swath-progress') {
      const pct = Math.min(99, m.percent);
      $fill.style.width = pct.toFixed(1) + '%';
      $label.textContent = pct.toFixed(0) + '%';
    } else if (m.type === 'swath-complete') {
      $fill.style.width = '100%';
      $label.textContent = 'Done';
      setTimeout(() => $progress.classList.remove('active'), 800);
      if ($btn) $btn.disabled = false;
      lastSwathData = { vars: m.vars, axis: axisVal, axisIdx: axisIdx, binWidth, varCols, elapsed: m.elapsed };
      renderSwathCharts(lastSwathData, stat);
      // Update tab badge
      const totalBins = Object.values(m.vars).reduce((s, arr) => Math.max(s, arr.length), 0);
      const swathTab = document.querySelector('.results-tab[data-tab="swath"]');
      if (swathTab) swathTab.innerHTML = 'Swath <span class="tab-badge">' + totalBins + ' bins</span>';
      swathWorker.terminate();
      swathWorker = null;
    } else if (m.type === 'error') {
      $label.textContent = 'Error: ' + m.message;
      setTimeout(() => $progress.classList.remove('active'), 2000);
      if ($btn) $btn.disabled = false;
      swathWorker.terminate();
      swathWorker = null;
    }
  };
}

function queryTDigestPercentile(centroids, p) {
  if (!centroids || centroids.length === 0) return null;
  let total = 0;
  for (const [, c] of centroids) total += c;
  if (total === 0) return null;
  const target = p * total;
  let cum = 0;
  for (let i = 0; i < centroids.length; i++) {
    const [mean, count] = centroids[i];
    cum += count;
    if (cum >= target) return mean;
  }
  return centroids[centroids.length - 1][0];
}

function renderSwathCharts(swathData, stat) {
  const $content = document.getElementById('swathContent');
  if (!$content || !swathData || !swathData.vars) {
    if ($content) $content.innerHTML = '<div class="swath-hint">No data.</div>';
    return;
  }
  const varCols = swathData.varCols || [];
  const hasData = varCols.some(vi => swathData.vars[vi] && swathData.vars[vi].length > 0);
  if (!hasData) {
    $content.innerHTML = '<div class="swath-hint">No data in selected bins.</div>';
    return;
  }
  let html = '';
  for (const vi of varCols) {
    const bins = (swathData.vars[vi] || []).filter(b => b.count > 0).sort((a, b) => a.center - b.center);
    if (bins.length === 0) continue;
    html += '<div class="swath-chart-card">' + renderSingleSwathSvg(bins, swathData, vi, stat) + '</div>';
  }
  $content.innerHTML = html || '<div class="swath-hint">No data in selected bins.</div>';
}

function renderSingleSwathSvg(bins, swathData, varColIdx, stat) {
  const varName = currentHeader[varColIdx] || 'Variable';
  const axisLabel = swathData.axis.toUpperCase();
  const bw = swathData.binWidth;

  let centerLine = [], upperLine = [], lowerLine = [];
  for (const bin of bins) {
    const x = bin.center;
    if (stat === 'mean_std') {
      centerLine.push({ x, y: bin.mean });
      upperLine.push({ x, y: bin.mean + bin.std });
      lowerLine.push({ x, y: bin.mean - bin.std });
    } else if (stat === 'p25_50_75') {
      centerLine.push({ x, y: queryTDigestPercentile(bin.centroids, 0.50) });
      upperLine.push({ x, y: queryTDigestPercentile(bin.centroids, 0.75) });
      lowerLine.push({ x, y: queryTDigestPercentile(bin.centroids, 0.25) });
    } else {
      centerLine.push({ x, y: queryTDigestPercentile(bin.centroids, 0.50) });
      upperLine.push({ x, y: queryTDigestPercentile(bin.centroids, 0.90) });
      lowerLine.push({ x, y: queryTDigestPercentile(bin.centroids, 0.10) });
    }
  }

  const W = 720, H = 340;
  const pad = { top: 30, right: 40, bottom: 70, left: 65 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const xMin = bins[0].center - bw / 2;
  const xMax = bins[bins.length - 1].center + bw / 2;
  const xRange = xMax - xMin || 1;

  let allY = [];
  for (const p of [...centerLine, ...upperLine, ...lowerLine]) { if (p.y != null) allY.push(p.y); }
  let yMin = Math.min(...allY), yMax = Math.max(...allY);
  const yPad = (yMax - yMin) * 0.1 || 1;
  yMin -= yPad; yMax += yPad;
  const yRange = yMax - yMin || 1;

  const sx = (v) => pad.left + ((v - xMin) / xRange) * plotW;
  const sy = (v) => pad.top + ((yMax - v) / yRange) * plotH;

  const ribbonColor = stat === 'mean_std' ? 'rgba(240,178,50,0.2)' : 'rgba(88,166,255,0.2)';
  const lineColor = stat === 'mean_std' ? '#f0b232' : '#58a6ff';

  let ribbonPath = '';
  for (let i = 0; i < bins.length; i++) {
    ribbonPath += (i === 0 ? 'M' : 'L') + sx(upperLine[i].x).toFixed(1) + ',' + sy(upperLine[i].y != null ? upperLine[i].y : 0).toFixed(1);
  }
  for (let i = bins.length - 1; i >= 0; i--) {
    ribbonPath += 'L' + sx(lowerLine[i].x).toFixed(1) + ',' + sy(lowerLine[i].y != null ? lowerLine[i].y : 0).toFixed(1);
  }
  ribbonPath += 'Z';

  let centerPath = '';
  for (let i = 0; i < bins.length; i++) {
    centerPath += (i === 0 ? 'M' : 'L') + sx(centerLine[i].x).toFixed(1) + ',' + sy(centerLine[i].y != null ? centerLine[i].y : 0).toFixed(1);
  }

  let gridSvg = '';
  const nxTicks = Math.min(10, bins.length);
  for (let i = 0; i <= nxTicks; i++) {
    const v = xMin + (xRange * i / nxTicks);
    const x = sx(v);
    gridSvg += '<line x1="' + x.toFixed(1) + '" y1="' + pad.top + '" x2="' + x.toFixed(1) + '" y2="' + (H - pad.bottom) + '" stroke="#1e2228" stroke-width="1"/>';
    gridSvg += '<text x="' + x.toFixed(1) + '" y="' + (H - pad.bottom + 14) + '" text-anchor="middle" fill="#6a737d" font-size="9">' + formatNum(v) + '</text>';
  }
  const nyTicks = 6;
  for (let i = 0; i <= nyTicks; i++) {
    const v = yMin + (yRange * i / nyTicks);
    const y = sy(v);
    gridSvg += '<line x1="' + pad.left + '" y1="' + y.toFixed(1) + '" x2="' + (W - pad.right) + '" y2="' + y.toFixed(1) + '" stroke="#1e2228" stroke-width="1"/>';
    gridSvg += '<text x="' + (pad.left - 6) + '" y="' + (y + 3) + '" text-anchor="end" fill="#6a737d" font-size="9">' + formatNum(v) + '</text>';
  }

  const maxCount = Math.max(...bins.map(b => b.count));
  const barH = 20;
  let countBars = '';
  for (const bin of bins) {
    const bx = sx(bin.center - bw / 2);
    const bwPx = sx(bin.center + bw / 2) - bx;
    const bh = maxCount > 0 ? (bin.count / maxCount) * barH : 0;
    countBars += '<rect x="' + bx.toFixed(1) + '" y="' + (H - pad.bottom + 26 + barH - bh).toFixed(1) + '" width="' + Math.max(1, bwPx - 1).toFixed(1) + '" height="' + bh.toFixed(1) + '" fill="rgba(240,178,50,0.3)"/>';
  }

  const axisKey = swathData.axis;
  let dirLeft = '', dirRight = '';
  if (axisKey === 'x') { dirLeft = 'W'; dirRight = 'E'; }
  else if (axisKey === 'y') { dirLeft = 'S'; dirRight = 'N'; }
  else { dirLeft = 'Bottom'; dirRight = 'Top'; }
  const dirSvg = '<text x="' + (pad.left + 4) + '" y="' + (pad.top - 8) + '" fill="#6a737d" font-size="10">' + dirLeft + ' (' + formatNum(xMin) + ')</text>' +
    '<text x="' + (W - pad.right - 4) + '" y="' + (pad.top - 8) + '" text-anchor="end" fill="#6a737d" font-size="10">' + dirRight + ' (' + formatNum(xMax) + ')</text>';

  const statLabels = { mean_std: 'Mean \u00b1 Std', p25_50_75: 'P25/P50/P75', p10_50_90: 'P10/P50/P90' };

  return '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" style="font-family:var(--mono);width:100%;height:100%">' +
    '<rect width="' + W + '" height="' + H + '" fill="var(--bg)" rx="4"/>' +
    gridSvg + dirSvg +
    '<path d="' + ribbonPath + '" fill="' + ribbonColor + '"/>' +
    '<path d="' + centerPath + '" fill="none" stroke="' + lineColor + '" stroke-width="1.5"/>' +
    countBars +
    '<text x="' + (W / 2) + '" y="' + (H - 6) + '" text-anchor="middle" fill="#6a737d" font-size="10">' + axisLabel + ' Coordinate &mdash; ' + esc(varName) + ' (' + (statLabels[stat] || stat) + ')</text>' +
    '<text x="12" y="' + (H / 2) + '" text-anchor="middle" fill="#6a737d" font-size="10" transform="rotate(-90, 12, ' + (H / 2) + ')">' + esc(varName) + '</text>' +
    '</svg>';
}

