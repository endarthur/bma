// ─── Section Tab ──────────────────────────────────────────────────────

function colormap(t, scale) {
  t = Math.max(0, Math.min(1, t));
  const maps = {
    viridis: [[68,1,84],[72,35,116],[64,67,135],[52,94,141],[41,120,142],[32,144,140],[34,167,132],[68,190,112],[121,209,81],[189,222,38],[253,231,37]],
    plasma: [[13,8,135],[75,3,161],[126,3,167],[168,34,150],[199,70,117],[220,107,80],[235,146,47],[245,189,11],[244,229,37],[240,249,33]],
    inferno: [[0,0,4],[22,11,57],[66,10,104],[106,23,110],[143,41,102],[175,62,84],[204,92,55],[227,131,30],[243,177,27],[248,224,82],[252,255,164]],
    coolwarm: [[59,76,192],[98,130,234],[141,176,254],[184,208,249],[221,221,221],[245,196,173],[236,147,120],[214,96,77],[178,44,53],[140,0,31]]
  };
  const stops = maps[scale] || maps.viridis;
  const n = stops.length - 1;
  const idx = t * n;
  const i = Math.min(Math.floor(idx), n - 1);
  const f = idx - i;
  const a = stops[i], b = stops[i + 1];
  const r = Math.round(a[0] + (b[0] - a[0]) * f);
  const g = Math.round(a[1] + (b[1] - a[1]) * f);
  const bl = Math.round(a[2] + (b[2] - a[2]) * f);
  return 'rgb(' + r + ',' + g + ',' + bl + ')';
}

function renderSectionConfig(data) {
  const $bar = document.querySelector('#panelSection .section-config-bar');
  if (!$bar) return;
  const { header, colTypes, geometry } = data;
  const hasXYZ = currentXYZ.x >= 0 && currentXYZ.y >= 0 && currentXYZ.z >= 0;
  if (!hasXYZ || !geometry || !geometry.x) {
    $bar.innerHTML = '<div style="color:var(--fg-dim);font-size:0.78rem;padding:0.5rem;">Assign X/Y/Z columns in Preflight and run analysis to enable Section view.</div>';
    return;
  }
  const numCols = header.map((h, i) => ({ name: h, idx: i, type: colTypes[i] }))
    .filter(c => c.type === 'numeric' && c.idx !== currentXYZ.x && c.idx !== currentXYZ.y && c.idx !== currentXYZ.z
      && c.idx !== currentDXYZ.dx && c.idx !== currentDXYZ.dy && c.idx !== currentDXYZ.dz);
  if (numCols.length === 0) {
    $bar.innerHTML = '<div style="color:var(--fg-dim);font-size:0.78rem;padding:0.5rem;">No numeric variable columns for section coloring.</div>';
    return;
  }
  const gx = geometry.x, gy = geometry.y, gz = geometry.z;
  const axisInfo = { z: { bs: gz.blockSize, min: gz.origin, max: gz.origin + gz.extent, label: 'Z (plan)' },
                     x: { bs: gx.blockSize, min: gx.origin, max: gx.origin + gx.extent, label: 'X (east section)' },
                     y: { bs: gy.blockSize, min: gy.origin, max: gy.origin + gy.extent, label: 'Y (north section)' }};
  const defaultAxis = 'z';
  const ai = axisInfo[defaultAxis];
  const midVal = ((ai.min + ai.max) / 2).toFixed(2);
  const varOptions = numCols.map(c => '<option value="' + c.idx + '">' + esc(c.name) + '</option>').join('');

  $bar.innerHTML = `
    <label>Normal: <select id="sectionAxis">
      <option value="z">${axisInfo.z.label}</option>
      <option value="x">${axisInfo.x.label}</option>
      <option value="y">${axisInfo.y.label}</option>
    </select></label>
    <label>Slice: <input type="range" id="sectionSlider" min="${ai.min}" max="${ai.max}" step="${ai.bs}" value="${midVal}" style="width:120px">
    <span id="sectionSliceVal">${midVal}</span></label>
    <label>Tol: <input type="number" id="sectionTol" value="${ai.bs}" min="0.001" step="any" style="width:60px"></label>
    <label>Color: <select id="sectionVar">${varOptions}</select></label>
    <label>Scale: <select id="sectionScale">
      <option value="viridis">Viridis</option>
      <option value="plasma">Plasma</option>
      <option value="inferno">Inferno</option>
      <option value="coolwarm">Cool-Warm</option>
    </select></label>
    <label>Filter: <input type="text" id="sectionLocalFilter" placeholder="e.g. r.zone == 1" style="width:120px"></label>
    <label class="section-swath-toggle" id="sectionSwathToggleWrap" style="display:none"><input type="checkbox" id="sectionShowSwath"> Swath</label>
    <button class="swath-generate" id="sectionRender">Render</button>
    <button class="swath-generate" id="sectionReset" style="background:transparent;border:1px solid var(--border)">Reset View</button>`;

  // Update slider when axis changes
  const $axSel = document.getElementById('sectionAxis');
  const $slider = document.getElementById('sectionSlider');
  const $sliceVal = document.getElementById('sectionSliceVal');
  const $tol = document.getElementById('sectionTol');
  $axSel.addEventListener('change', () => {
    const a = axisInfo[$axSel.value];
    $slider.min = a.min; $slider.max = a.max; $slider.step = a.bs;
    const mid = ((a.min + a.max) / 2).toFixed(2);
    $slider.value = mid; $sliceVal.textContent = mid;
    $tol.value = a.bs;
  });
  $slider.addEventListener('input', () => { $sliceVal.textContent = parseFloat($slider.value).toFixed(2); });

  document.getElementById('sectionRender').addEventListener('click', runSection);
  document.getElementById('sectionReset').addEventListener('click', () => {
    sectionTransform = null;
    if (sectionBlocks) renderSection();
  });

  // Show swath toggle if swath data matches
  updateSectionSwathToggle();

  // Local filter autocomplete
  if (sectionExprController) sectionExprController.destroy();
  sectionExprController = createExprInput(document.getElementById('sectionLocalFilter'), { mode: 'filter' });
}

function updateSectionSwathToggle() {
  const wrap = document.getElementById('sectionSwathToggleWrap');
  if (!wrap) return;
  if (lastSwathData) {
    wrap.style.display = '';
  } else {
    wrap.style.display = 'none';
  }
}

function runSection() {
  if (sectionExprController) { const r = sectionExprController.validate(); if (!r.valid) return; }
  const axisVal = document.getElementById('sectionAxis').value;
  const slicePos = parseFloat(document.getElementById('sectionSlider').value);
  const tolerance = parseFloat(document.getElementById('sectionTol').value);
  const varCol = parseInt(document.getElementById('sectionVar').value);
  const localFilter = document.getElementById('sectionLocalFilter').value.trim();
  if (!tolerance || tolerance <= 0) return;

  if (sectionWorker) sectionWorker.terminate();
  sectionWorker = new Worker(workerUrl);

  const $progress = document.getElementById('sectionProgress');
  const $fill = document.getElementById('sectionProgressFill');
  const $label = document.getElementById('sectionProgressLabel');
  $progress.classList.add('active');
  $fill.style.width = '0%';
  $label.textContent = '0%';

  const resolvedTypes = currentColTypes.slice(0, currentOrigColCount);
  const filterPayload = currentFilter ? { expression: currentFilter.expression } : null;
  const zipEntry = preflightData ? (preflightData.selectedZipEntry || null) : null;

  const normalAxisIdx = axisVal === 'x' ? 0 : (axisVal === 'y' ? 1 : 2);
  const xyzCols = [currentXYZ.x, currentXYZ.y, currentXYZ.z];
  const dxyzCols = [currentDXYZ.dx, currentDXYZ.dy, currentDXYZ.dz];

  sectionWorker.postMessage({
    mode: 'section',
    file: currentFile,
    zipEntry,
    globalFilter: filterPayload,
    localFilter: localFilter || null,
    calcolCode: currentCalcolCode || null,
    calcolMeta: currentCalcolMeta.length > 0 ? currentCalcolMeta : null,
    resolvedTypes,
    xyzCols,
    dxyzCols,
    normalAxis: normalAxisIdx,
    slicePos,
    tolerance,
    varCol
  });

  sectionWorker.onerror = (e) => {
    $label.textContent = 'Worker error: ' + (e.message || 'unknown error');
    $label.style.color = 'var(--red)';
    setTimeout(() => { $progress.classList.remove('active'); $label.style.color = ''; }, 3000);
    sectionWorker.terminate();
    sectionWorker = null;
  };

  sectionWorker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'section-progress') {
      const pct = Math.min(99, m.percent);
      $fill.style.width = pct.toFixed(1) + '%';
      $label.textContent = pct.toFixed(0) + '%';
    } else if (m.type === 'section-complete') {
      $fill.style.width = '100%';
      $label.textContent = 'Done';
      setTimeout(() => $progress.classList.remove('active'), 800);
      sectionBlocks = m.blocks;
      sectionTransform = null;
      sectionDefaultBlockSize = null;
      if (lastGeoData) {
        const hKey = m.hAxis.toLowerCase();
        const vKey = m.vAxis.toLowerCase();
        sectionDefaultBlockSize = {
          h: lastGeoData[hKey] ? lastGeoData[hKey].blockSize : 1,
          v: lastGeoData[vKey] ? lastGeoData[vKey].blockSize : 1
        };
      }
      renderSection();
      const $info = document.getElementById('sectionInfo');
      if ($info) $info.textContent = m.blockCount.toLocaleString() + ' blocks \u00B7 ' + (m.elapsed / 1000).toFixed(1) + 's';
      // Update tab badge
      const sectionTab = document.querySelector('.results-tab[data-tab="section"]');
      if (sectionTab) sectionTab.innerHTML = 'Section <span class="tab-badge">' + m.blockCount + '</span>';
      updateSectionSwathToggle();
      sectionWorker.terminate();
      sectionWorker = null;
    } else if (m.type === 'error') {
      $label.textContent = 'Error: ' + m.message;
      $progress.classList.remove('active');
      sectionWorker.terminate();
      sectionWorker = null;
    }
  };
}

function renderSection() {
  const canvas = document.getElementById('sectionCanvas');
  if (!canvas || !sectionBlocks || sectionBlocks.length === 0) return;
  const wrap = canvas.parentElement;
  const rect = wrap.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const blocks = sectionBlocks;
  const defH = sectionDefaultBlockSize ? sectionDefaultBlockSize.h : 1;
  const defV = sectionDefaultBlockSize ? sectionDefaultBlockSize.v : 1;

  // Compute data bounds
  let dhMin = Infinity, dvMin = Infinity, hMin = Infinity, hMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  let valMin = Infinity, valMax = -Infinity;
  for (const b of blocks) {
    const dh = b.dh || defH, dv = b.dv || defV;
    if (dh < dhMin) dhMin = dh;
    if (dv < dvMin) dvMin = dv;
    const bLeft = b.h - dh / 2, bRight = b.h + dh / 2;
    const bBot = b.v - dv / 2, bTop = b.v + dv / 2;
    if (bLeft < hMin) hMin = bLeft;
    if (bRight > hMax) hMax = bRight;
    if (bBot < vMin) vMin = bBot;
    if (bTop > vMax) vMax = bTop;
    if (b.val != null) {
      if (b.val < valMin) valMin = b.val;
      if (b.val > valMax) valMax = b.val;
    }
  }
  const dataW = hMax - hMin || 1;
  const dataH = vMax - vMin || 1;
  const valRange = valMax - valMin || 1;

  const colorScale = document.getElementById('sectionScale') ? document.getElementById('sectionScale').value : 'viridis';

  // Transform: fit to view or use saved transform
  let scale, offsetX, offsetY;
  if (sectionTransform) {
    scale = sectionTransform.scale;
    offsetX = sectionTransform.offsetX;
    offsetY = sectionTransform.offsetY;
  } else {
    const marginPx = 40;
    const availW = rect.width - marginPx * 2;
    const availH = rect.height - marginPx * 2;
    scale = Math.min(availW / dataW, availH / dataH);
    offsetX = (rect.width - dataW * scale) / 2 - hMin * scale;
    offsetY = (rect.height - dataH * scale) / 2 + vMax * scale; // flip Y
    sectionTransform = { scale, offsetX, offsetY };
  }

  const toScreenX = (v) => v * scale + offsetX;
  const toScreenY = (v) => -v * scale + offsetY; // flip Y

  // Clear
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#0d1117';
  ctx.fillRect(0, 0, rect.width, rect.height);

  // Draw blocks
  const drawBorder = (dhMin * scale) > 4;
  for (const b of blocks) {
    const dh = b.dh || defH, dv = b.dv || defV;
    const sx = toScreenX(b.h - dh / 2);
    const sy = toScreenY(b.v + dv / 2);
    const sw = dh * scale;
    const sh = dv * scale;
    if (b.val != null) {
      const t = (b.val - valMin) / valRange;
      ctx.fillStyle = colormap(t, colorScale);
    } else {
      ctx.fillStyle = '#333';
    }
    ctx.fillRect(sx, sy, sw, sh);
    if (drawBorder) {
      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(sx, sy, sw, sh);
    }
  }

  // Swath overlay
  const showSwathCb = document.getElementById('sectionShowSwath');
  if (showSwathCb && showSwathCb.checked && lastSwathData) {
    const swathAxisKey = lastSwathData.axis;
    const sectionAxisEl = document.getElementById('sectionAxis');
    const normalAxis = sectionAxisEl ? sectionAxisEl.value : 'z';
    // Determine which display axis the swath axis maps to
    let swathOnH = false, swathOnV = false;
    if (normalAxis === 'z') { // plan view: h=X, v=Y
      if (swathAxisKey === 'x') swathOnH = true;
      else if (swathAxisKey === 'y') swathOnV = true;
    } else if (normalAxis === 'x') { // h=Y, v=Z
      if (swathAxisKey === 'y') swathOnH = true;
      else if (swathAxisKey === 'z') swathOnV = true;
    } else { // normalAxis === 'y': h=X, v=Z
      if (swathAxisKey === 'x') swathOnH = true;
      else if (swathAxisKey === 'z') swathOnV = true;
    }
    if (swathOnH || swathOnV) {
      const bw = lastSwathData.binWidth;
      // Get bins from first available variable
      const firstVarKey = lastSwathData.varCols && lastSwathData.varCols.length > 0 ? lastSwathData.varCols[0] : null;
      const swathBins = firstVarKey != null && lastSwathData.vars && lastSwathData.vars[firstVarKey] ? lastSwathData.vars[firstVarKey] : [];
      const binMin = swathBins.length > 0 ? swathBins[0].center - bw / 2 : 0;
      const binMax = swathBins.length > 0 ? swathBins[swathBins.length - 1].center + bw / 2 : 0;
      ctx.save();
      ctx.globalAlpha = 0.08;
      let toggle = false;
      if (swathOnH) {
        for (let bc = binMin; bc < binMax; bc += bw) {
          if (toggle) {
            const x1 = toScreenX(bc);
            const x2 = toScreenX(bc + bw);
            ctx.fillStyle = '#fff';
            ctx.fillRect(x1, 0, x2 - x1, rect.height);
          }
          toggle = !toggle;
        }
      } else {
        for (let bc = binMin; bc < binMax; bc += bw) {
          if (toggle) {
            const y1 = toScreenY(bc + bw);
            const y2 = toScreenY(bc);
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, y1, rect.width, y2 - y1);
          }
          toggle = !toggle;
        }
      }
      ctx.restore();
      // Dashed bin boundary lines
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      if (swathOnH) {
        for (let bc = binMin; bc <= binMax; bc += bw) {
          const x = toScreenX(bc);
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, rect.height); ctx.stroke();
        }
      } else {
        for (let bc = binMin; bc <= binMax; bc += bw) {
          const y = toScreenY(bc);
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(rect.width, y); ctx.stroke();
        }
      }
      ctx.restore();
    }
  }

  // Axis labels
  ctx.fillStyle = '#6a737d';
  ctx.font = '11px ' + (getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace');
  ctx.textAlign = 'center';
  // H-axis ticks
  const hSteps = Math.min(10, Math.ceil(dataW / (defH * 5)));
  const hStep = dataW / hSteps;
  for (let i = 0; i <= hSteps; i++) {
    const v = hMin + hStep * i;
    const x = toScreenX(v);
    ctx.fillText(formatNum(v), x, rect.height - 4);
  }
  // V-axis ticks
  ctx.textAlign = 'right';
  const vSteps = Math.min(10, Math.ceil(dataH / (defV * 5)));
  const vStep = dataH / vSteps;
  for (let i = 0; i <= vSteps; i++) {
    const v = vMin + vStep * i;
    const y = toScreenY(v);
    ctx.fillText(formatNum(v), pad ? 36 : 36, y + 3);
  }

  // Render colorbar
  renderColorbar(valMin, valMax, colorScale);
}

function renderColorbar(valMin, valMax, scale) {
  const $cbWrap = document.getElementById('sectionColorbar');
  if (!$cbWrap) return;
  const cb = document.getElementById('sectionColorbarCanvas');
  if (!cb) return;
  const h = $cbWrap.getBoundingClientRect().height - 40;
  cb.width = 20;
  cb.height = Math.max(h, 100);
  cb.style.width = '20px';
  cb.style.height = cb.height + 'px';
  const ctx = cb.getContext('2d');
  for (let i = 0; i < cb.height; i++) {
    const t = 1 - i / cb.height;
    ctx.fillStyle = colormap(t, scale);
    ctx.fillRect(0, i, 20, 1);
  }
  // Labels
  let labels = $cbWrap.querySelectorAll('.cb-label');
  labels.forEach(l => l.remove());
  const mkLabel = (text, top) => {
    const span = document.createElement('span');
    span.className = 'cb-label';
    span.style.cssText = 'position:absolute;right:24px;font-size:9px;color:#6a737d;' + (top ? 'top:0' : 'bottom:0');
    span.textContent = text;
    $cbWrap.appendChild(span);
  };
  mkLabel(formatNum(valMax), true);
  mkLabel(formatNum(valMin), false);
}

function wireSectionInteraction() {
  const canvas = document.getElementById('sectionCanvas');
  if (!canvas) return;

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!sectionTransform || !sectionBlocks) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const newScale = sectionTransform.scale * factor;
    sectionTransform.offsetX = mx - (mx - sectionTransform.offsetX) * factor;
    sectionTransform.offsetY = my - (my - sectionTransform.offsetY) * factor;
    sectionTransform.scale = newScale;
    renderSection();
  }, { passive: false });

  let dragging = false, dragStartX = 0, dragStartY = 0, dragOX = 0, dragOY = 0;
  canvas.addEventListener('mousedown', (e) => {
    if (!sectionTransform) return;
    dragging = true;
    dragStartX = e.clientX; dragStartY = e.clientY;
    dragOX = sectionTransform.offsetX; dragOY = sectionTransform.offsetY;
    canvas.style.cursor = 'grabbing';
  });
  window.addEventListener('mousemove', (e) => {
    if (dragging && sectionTransform) {
      sectionTransform.offsetX = dragOX + (e.clientX - dragStartX);
      sectionTransform.offsetY = dragOY + (e.clientY - dragStartY);
      renderSection();
    } else if (!dragging && sectionBlocks && sectionTransform) {
      // Hover tooltip
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      if (mx < 0 || my < 0 || mx > rect.width || my > rect.height) {
        const tip = document.getElementById('sectionTooltip');
        if (tip) tip.style.display = 'none';
        return;
      }
      // Reverse transform
      const dataX = (mx - sectionTransform.offsetX) / sectionTransform.scale;
      const dataY = -(my - sectionTransform.offsetY) / sectionTransform.scale;
      const defH = sectionDefaultBlockSize ? sectionDefaultBlockSize.h : 1;
      const defV = sectionDefaultBlockSize ? sectionDefaultBlockSize.v : 1;
      let found = null;
      for (const b of sectionBlocks) {
        const dh = b.dh || defH, dv = b.dv || defV;
        if (dataX >= b.h - dh / 2 && dataX <= b.h + dh / 2 &&
            dataY >= b.v - dv / 2 && dataY <= b.v + dv / 2) {
          found = b;
          break;
        }
      }
      const tip = document.getElementById('sectionTooltip');
      if (tip) {
        if (found) {
          tip.style.display = 'block';
          tip.style.left = (mx + 12) + 'px';
          tip.style.top = (my - 8) + 'px';
          tip.textContent = 'H=' + formatNum(found.h) + ' V=' + formatNum(found.v) + (found.val != null ? ' Val=' + formatNum(found.val) : '');
        } else {
          tip.style.display = 'none';
        }
      }
    }
  });
  window.addEventListener('mouseup', () => {
    dragging = false;
    canvas.style.cursor = 'crosshair';
  });

  // ResizeObserver for canvas
  const wrap = canvas.parentElement;
  if (wrap && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      if (sectionBlocks) renderSection();
    }).observe(wrap);
  }
}
wireSectionInteraction();

function renderCDFModal(s, name) {
  $cdfTitle.textContent = 'CDF \u2014 ' + name;
  $cdfModal.classList.add('active');

  const centroids = s.centroids;
  const totalCount = s.count;
  const points = [];
  let cumCount = 0;
  for (const [mean, count] of centroids) {
    cumCount += count;
    points.push({ x: mean, y: cumCount / totalCount });
  }

  const W = 660, H = 360;
  const pad = { top: 20, right: 30, bottom: 50, left: 60 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const xMin = s.min, xMax = s.max;
  const xRange = xMax - xMin || 1;

  function sx(v) { return pad.left + ((v - xMin) / xRange) * plotW; }
  function sy(v) { return pad.top + (1 - v) * plotH; }

  const pathParts = points.map((p, i) => (i === 0 ? 'M' : 'L') + sx(p.x).toFixed(1) + ',' + sy(p.y).toFixed(1));
  const pathD = pathParts.join(' ');

  const yTicks = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0];
  let gridSvg = '';
  for (const yt of yTicks) {
    const y = sy(yt);
    gridSvg += '<line x1="' + pad.left + '" y1="' + y + '" x2="' + (W - pad.right) + '" y2="' + y + '" stroke="#1e2228" stroke-width="1"/>';
    gridSvg += '<text x="' + (pad.left - 8) + '" y="' + (y + 3.5) + '" text-anchor="end" fill="#6a737d" font-size="10">' + (yt * 100).toFixed(0) + '%</text>';
  }

  const nxTicks = 6;
  for (let i = 0; i <= nxTicks; i++) {
    const v = xMin + (xRange * i / nxTicks);
    const x = sx(v);
    gridSvg += '<line x1="' + x + '" y1="' + pad.top + '" x2="' + x + '" y2="' + (H - pad.bottom) + '" stroke="#1e2228" stroke-width="1"/>';
    const label = Math.abs(v) >= 1e5 || (Math.abs(v) < 0.01 && v !== 0) ? v.toExponential(1) : v.toFixed(Math.abs(v) < 10 ? 2 : 0);
    gridSvg += '<text x="' + x + '" y="' + (H - pad.bottom + 16) + '" text-anchor="middle" fill="#6a737d" font-size="10">' + label + '</text>';
  }

  const q = s.quantiles;
  let markerSvg = '';
  if (q) {
    const pctiles = [
      { v: q.p10, label: 'P10' }, { v: q.p25, label: 'P25' },
      { v: q.p50, label: 'P50' }, { v: q.p75, label: 'P75' },
      { v: q.p90, label: 'P90' }
    ];
    for (const p of pctiles) {
      if (p.v === null || p.v === undefined) continue;
      const x = sx(p.v);
      const pVal = parseFloat(p.label.slice(1)) / 100;
      const y = sy(pVal);
      markerSvg += '<circle cx="' + x + '" cy="' + y + '" r="3" fill="#f0b232"/>';
    }
  }
  if (s.mean !== null) {
    const mx = sx(s.mean);
    markerSvg += '<line x1="' + mx + '" y1="' + pad.top + '" x2="' + mx + '" y2="' + (H - pad.bottom) + '" stroke="#58a6ff" stroke-width="1" stroke-dasharray="4,3"/>';
    markerSvg += '<text x="' + mx + '" y="' + (H - pad.bottom + 30) + '" text-anchor="middle" fill="#58a6ff" font-size="9">mean</text>';
  }

  const svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" style="font-family:var(--mono)">' +
    '<rect width="' + W + '" height="' + H + '" fill="var(--bg)" rx="4"/>' +
    gridSvg +
    '<path d="' + pathD + '" fill="none" stroke="var(--amber)" stroke-width="1.5"/>' +
    markerSvg +
    '<text x="' + (W / 2) + '" y="' + (H - 4) + '" text-anchor="middle" fill="#6a737d" font-size="10">' + esc(name) + '</text>' +
    '<text x="12" y="' + (H / 2) + '" text-anchor="middle" fill="#6a737d" font-size="10" transform="rotate(-90, 12, ' + (H / 2) + ')">Cumulative %</text>' +
    '</svg>';

  const cv = (s.mean && s.std && s.mean !== 0) ? Math.abs(s.std / s.mean * 100) : null;
  const zeroPct = s.count > 0 ? (s.zeros / s.count * 100) : 0;
  let statsHtml = '<div class="cdf-stats">';
  statsHtml += '<span>n=<strong>' + s.count.toLocaleString() + '</strong></span>';
  if (s.nulls > 0) statsHtml += '<span>nulls=<strong>' + s.nulls.toLocaleString() + '</strong></span>';
  if (s.zeros > 0) statsHtml += '<span>zeros=<strong>' + s.zeros.toLocaleString() + '</strong> (' + zeroPct.toFixed(1) + '%)</span>';
  statsHtml += '<span>min=<strong>' + formatNum(s.min) + '</strong></span>';
  if (q) statsHtml += '<span>P50=<strong>' + formatNum(q.p50) + '</strong></span>';
  statsHtml += '<span>mean=<strong>' + formatNum(s.mean) + '</strong></span>';
  statsHtml += '<span>max=<strong>' + formatNum(s.max) + '</strong></span>';
  if (cv !== null) statsHtml += '<span>CV=<strong>' + cv.toFixed(1) + '%</strong></span>';
  if (s.skewness !== null) statsHtml += '<span>skew=<strong>' + s.skewness.toFixed(2) + '</strong></span>';
  statsHtml += '</div>';

  $cdfBody.innerHTML = svg + statsHtml;
}

function renderXYZConfig(header, colTypes, xyzGuess) {
  const label = (axis) => {
    const idx = currentXYZ[axis];
    const name = idx >= 0 ? esc(header[idx]) : '—';
    return `<label><span class="axis-label">${axis.toUpperCase()}:</span> <span class="axis-value">${name}</span></label>`;
  };
  $xyzConfig.innerHTML = label('x') + label('y') + label('z');
}

