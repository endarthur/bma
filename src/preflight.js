// ─── Preflight: main-thread helpers ────────────────────────────────────

const DELIMITERS_MAIN = [',', '\t', ';', '|', ' '];
const NULL_SENTINELS_MAIN = new Set(['', 'NA', 'NaN', 'na', 'nan', 'N/A', 'n/a', 'null', 'NULL', '*', '-', '-999', '-99', '#N/A', 'VOID', 'void', '-1.0e+32', '-1e+32', '1e+31', '-9999', '-99999']);

function detectDelimiterMain(lines) {
  let best = ',', bestScore = -1;
  for (const d of DELIMITERS_MAIN) {
    const counts = lines.map(l => l.split(d).length);
    if (counts[0] < 2) continue;
    const allSame = counts.every(c => c === counts[0]);
    const score = allSame ? counts[0] * 1000 + counts.length : counts[0];
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

function autoDetectTypes(header, rows) {
  const types = [];
  for (let col = 0; col < header.length; col++) {
    let num = 0, nonNum = 0;
    for (const row of rows) {
      if (col >= row.length) continue;
      const v = row[col].trim();
      if (NULL_SENTINELS_MAIN.has(v)) continue;
      if (!isNaN(Number(v))) num++;
      else nonNum++;
    }
    const total = num + nonNum;
    if (total === 0) types.push('numeric');
    else if (nonNum === 0) types.push('numeric');
    else if (num === 0) types.push('categorical');
    else types.push((num / total > 0.8) ? 'numeric' : 'categorical');
  }
  return types;
}

function readUint16(buf, off) { return buf[off] | (buf[off+1] << 8); }
function readUint32(buf, off) { return (buf[off] | (buf[off+1] << 8) | (buf[off+2] << 16) | (buf[off+3] << 24)) >>> 0; }

async function listZipEntries(file) {
  const tailSize = Math.min(65557, file.size);
  const tail = new Uint8Array(await file.slice(file.size - tailSize).arrayBuffer());
  let eocdPos = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (readUint32(tail, i) === 0x06054b50) { eocdPos = i; break; }
  }
  if (eocdPos < 0) throw new Error('Not a valid ZIP file');
  const cdEntries = readUint16(tail, eocdPos + 8);
  const cdSize = readUint32(tail, eocdPos + 12);
  const cdOffset = readUint32(tail, eocdPos + 16);
  const cd = new Uint8Array(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const entries = [];
  let pos = 0;
  for (let i = 0; i < cdEntries && pos < cd.length; i++) {
    if (readUint32(cd, pos) !== 0x02014b50) break;
    const method = readUint16(cd, pos + 10);
    const compSize = readUint32(cd, pos + 20);
    const uncompSize = readUint32(cd, pos + 24);
    const nameLen = readUint16(cd, pos + 28);
    const extraLen = readUint16(cd, pos + 30);
    const commentLen = readUint16(cd, pos + 32);
    const localOffset = readUint32(cd, pos + 42);
    const name = new TextDecoder().decode(cd.slice(pos + 46, pos + 46 + nameLen));
    if (!name.endsWith('/') && !name.startsWith('__MACOSX') && !name.startsWith('.')) {
      entries.push({ name, method, compSize, uncompSize, localOffset });
    }
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readPreviewFromZipEntry(file, entry, maxLines) {
  const lh = new Uint8Array(await file.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
  const lhNameLen = readUint16(lh, 26);
  const lhExtraLen = readUint16(lh, 28);
  const dataStart = entry.localOffset + 30 + lhNameLen + lhExtraLen;
  const compSlice = file.slice(dataStart, dataStart + entry.compSize);
  let stream;
  if (entry.method === 0) stream = compSlice.stream();
  else if (entry.method === 8) stream = compSlice.stream().pipeThrough(new DecompressionStream('deflate-raw'));
  else throw new Error('Unsupported compression method');
  return readLinesFromStream(stream, maxLines);
}

async function readLinesFromStream(stream, maxLines) {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '', lines = [];
  while (lines.length < maxLines + 1) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += value;
    const parts = buf.split('\n');
    buf = parts.pop();
    for (const p of parts) {
      const trimmed = p.replace(/\r$/, '');
      if (trimmed.startsWith('#')) continue;
      lines.push(trimmed);
      if (lines.length >= maxLines + 1) break;
    }
  }
  if (buf && lines.length < maxLines + 1) {
    const trimmed = buf.replace(/\r$/, '');
    if (!trimmed.startsWith('#')) lines.push(trimmed);
  }
  reader.cancel();
  return lines;
}

const CSV_EXTENSIONS_MAIN = /\.(csv|txt|dat|tsv)$/i;

// Columns that should NOT get default >0 filtering
const NOFILT_RE = /^(id|index|row|block.?id|parent|d[xyz]|dim[xyz]?|size[xyz]?|n[xyz]|i[xyz]|ij[k]?|count|flag|code|mask|domain|[xyz]inc|[xyz]dis|[xyz]len|[xyz]size|d[_-]?[xyz]|[xyz][_-]?dim|[xyz][_-]?size|size[_-]?[xyz])$/i;

function buildDefaultColFilters(header, autoTypes, xyz) {
  const xyzSet = new Set([xyz.x, xyz.y, xyz.z].filter(v => v >= 0));
  const filters = {};
  for (let i = 0; i < header.length; i++) {
    if (autoTypes[i] !== 'numeric') continue;
    if (xyzSet.has(i)) continue;
    if (NOFILT_RE.test(header[i])) continue;
    filters[i] = { skipZeros: true, skipNeg: true };
  }
  return filters;
}

function isFilterableCol(header, i, autoTypes, typeOverrides, xyz, skipCols) {
  const t = typeOverrides[i] || autoTypes[i];
  if (t !== 'numeric') return false;
  if (skipCols.has(i)) return false;
  const xyzSet = new Set([xyz.x, xyz.y, xyz.z].filter(v => v >= 0));
  if (xyzSet.has(i)) return false;
  if (NOFILT_RE.test(header[i])) return false;
  return true;
}

const XYZ_PATTERNS_MAIN = {
  x: [/^x$/i, /^xc$/i, /^x[_-]?cent/i, /^mid[_-]?x$/i, /^centroid[_-]?x$/i, /^east/i, /^x[_-]?coord$/i],
  y: [/^y$/i, /^yc$/i, /^y[_-]?cent/i, /^mid[_-]?y$/i, /^centroid[_-]?y$/i, /^north/i, /^y[_-]?coord$/i],
  z: [/^z$/i, /^zc$/i, /^z[_-]?cent/i, /^mid[_-]?z$/i, /^centroid[_-]?z$/i, /^elev/i, /^rl$/i, /^z[_-]?coord$/i, /^level$/i, /^bench$/i]
};

function guessXYZMain(header, types) {
  const result = { x: -1, y: -1, z: -1 };
  for (const axis of ['x', 'y', 'z']) {
    for (const pat of XYZ_PATTERNS_MAIN[axis]) {
      const idx = header.findIndex((h, i) => types[i] === 'numeric' && pat.test(h.trim()));
      if (idx >= 0) { result[axis] = idx; break; }
    }
  }
  if (result.x < 0 || result.y < 0 || result.z < 0) {
    const numCols = header.map((_, i) => i).filter(i => types[i] === 'numeric');
    if (numCols.length >= 3 && result.x < 0 && result.y < 0 && result.z < 0) {
      result.x = numCols[0]; result.y = numCols[1]; result.z = numCols[2];
    }
  }
  return result;
}

const DXYZ_PATTERNS_MAIN = {
  dx: [/^dx$/i, /^xinc$/i, /^xdis$/i, /^xsize$/i, /^dimx$/i, /^xlen$/i, /^x[_-]?dim$/i, /^x[_-]?size$/i, /^d[_-]?x$/i, /^size[_-]?x$/i],
  dy: [/^dy$/i, /^yinc$/i, /^ydis$/i, /^ysize$/i, /^dimy$/i, /^ylen$/i, /^y[_-]?dim$/i, /^y[_-]?size$/i, /^d[_-]?y$/i, /^size[_-]?y$/i],
  dz: [/^dz$/i, /^zinc$/i, /^zdis$/i, /^zsize$/i, /^dimz$/i, /^zlen$/i, /^z[_-]?dim$/i, /^z[_-]?size$/i, /^d[_-]?z$/i, /^size[_-]?z$/i]
};

function guessDXYZMain(header, types) {
  const result = { dx: -1, dy: -1, dz: -1 };
  for (const axis of ['dx', 'dy', 'dz']) {
    for (const pat of DXYZ_PATTERNS_MAIN[axis]) {
      const idx = header.findIndex((h, i) => types[i] === 'numeric' && pat.test(h.trim()));
      if (idx >= 0) { result[axis] = idx; break; }
    }
  }
  return result;
}

async function runPreflight(file) {
  const isZip = file.name.toLowerCase().endsWith('.zip') || file.type === 'application/zip';
  let zipEntries = null;
  let lines;

  if (isZip) {
    zipEntries = await listZipEntries(file);
    const csvEntries = zipEntries.filter(e => CSV_EXTENSIONS_MAIN.test(e.name));
    if (csvEntries.length === 0) throw new Error('No CSV/TXT/DAT files found in ZIP. Contents: ' + zipEntries.map(e => e.name).join(', '));
    // Preview the first CSV entry
    lines = await readPreviewFromZipEntry(file, csvEntries[0], 100);
  } else {
    // Read first ~64KB for preview
    lines = await readLinesFromStream(file.slice(0, 256 * 1024).stream(), 100);
  }

  if (lines.length < 2) throw new Error('File appears empty or has no data rows.');

  const delimiter = detectDelimiterMain(lines.slice(0, 20));
  const header = lines[0].split(delimiter).map(h => h.trim().replace(/^["']|["']$/g, ''));
  const sampleRows = lines.slice(1)
    .filter(l => l.trim())
    .map(l => l.split(delimiter).map(f => f.trim().replace(/^["']|["']$/g, '')));
  const autoTypes = autoDetectTypes(header, sampleRows);
  const xyzGuess = guessXYZMain(header, autoTypes);
  const dxyzGuess = guessDXYZMain(header, autoTypes);

  // Determine which numeric columns should default to >0 filtering
  const defaultFilters = buildDefaultColFilters(header, autoTypes, xyzGuess);

  return {
    header,
    sampleRows,
    autoTypes,
    delimiter,
    zipEntries: zipEntries ? zipEntries.filter(e => CSV_EXTENSIONS_MAIN.test(e.name)) : null,
    selectedZipEntry: zipEntries ? zipEntries.filter(e => CSV_EXTENSIONS_MAIN.test(e.name))[0]?.name : null,
    typeOverrides: {},
    xyz: { ...xyzGuess },
    dxyz: { ...dxyzGuess },
    skipCols: new Set(),
    colFilters: defaultFilters
  };
}

function renderPreflight(data) {
  preflightData = data;
  if (!data.colFilters) data.colFilters = {};

  // ZIP file selector
  if (data.zipEntries && data.zipEntries.length > 1) {
    const opts = data.zipEntries.map(e =>
      `<option value="${esc(e.name)}" ${e.name === data.selectedZipEntry ? 'selected' : ''}>${esc(e.name)}</option>`
    ).join('');
    $preflightZip.innerHTML = `ZIP: <select id="zipSelect">${opts}</select>` +
      `<span class="zip-size">${data.zipEntries.length} files</span>`;
    document.getElementById('zipSelect').addEventListener('change', async (e) => {
      const name = e.target.value;
      data.selectedZipEntry = name;
      const entry = data.zipEntries.find(z => z.name === name);
      try {
        const lines = await readPreviewFromZipEntry(currentFile, entry, 100);
        const delimiter = detectDelimiterMain(lines.slice(0, 20));
        data.header = lines[0].split(delimiter).map(h => h.trim().replace(/^["']|["']$/g, ''));
        data.sampleRows = lines.slice(1).filter(l => l.trim())
          .map(l => l.split(delimiter).map(f => f.trim().replace(/^["']|["']$/g, '')));
        data.delimiter = delimiter;
        data.autoTypes = autoDetectTypes(data.header, data.sampleRows);
        data.typeOverrides = {};
        data.skipCols = new Set();
        data.xyz = guessXYZMain(data.header, data.autoTypes);
        data.colFilters = buildDefaultColFilters(data.header, data.autoTypes, data.xyz);
        renderPreflightSidebar(data);
        renderPreflightTable(data);
      } catch(err) {
        $preflightPreview.innerHTML = `<div style="padding:1rem;color:var(--red)">${esc(err.message)}</div>`;
      }
    });
  } else if (data.zipEntries && data.zipEntries.length === 1) {
    $preflightZip.innerHTML = `ZIP: <strong style="color:var(--fg-bright)">${esc(data.zipEntries[0].name)}</strong>` +
      `<span class="zip-size">${formatSize(data.zipEntries[0].uncompSize)}</span>`;
  } else {
    $preflightZip.innerHTML = '';
  }
  $preflightHead.style.display = $preflightZip.innerHTML ? '' : 'none';

  renderPreflightSidebar(data);
  renderPreflightTable(data);
}

const $preflightSidebar = document.getElementById('preflightSidebar');

function renderPreflightSidebar(data) {
  const { header, autoTypes, typeOverrides, skipCols, colFilters } = data;
  const enabledCount = header.length - skipCols.size;

  let html = `<div class="pf-sidebar-section">
    <div class="pf-sidebar-section-title">Coordinate Axes</div>
    <div id="pfXyzWrap"></div>
  </div>`;

  html += `<div class="pf-sidebar-section">
    <div class="pf-sidebar-section-title">Block Dimensions</div>
    <div id="pfDxyzWrap"></div>
  </div>`;

  // Column list header with search
  html += `<div class="pf-sidebar-section" style="padding-bottom:0.3rem">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.35rem">
      <div class="pf-sidebar-section-title" style="margin:0">Columns</div>
      <div class="pf-sidebar-actions">
        <button id="pfSelectAll">all</button>
        <button id="pfSelectNone">none</button>
        <span class="pf-col-count"><span id="pfEnabledCount">${enabledCount}</span>/${header.length}</span>
      </div>
    </div>
    <input type="text" class="pf-search" id="pfSearch" placeholder="Search columns…" autocomplete="off" spellcheck="false">
    <div class="pf-bulk-filters">
      <button id="pfFilterAllGt0" title="Set >0 filter on all grade columns">&gt;0 all</button>
      <button id="pfFilterClear" title="Clear all value filters">clear filters</button>
      <span class="pf-filter-count"></span>
    </div>
  </div>`;

  // Column list — always render both filter buttons; hide via class when not filterable
  html += '<div class="pf-col-list" id="pfColList">';
  for (let i = 0; i < header.length; i++) {
    const currentType = typeOverrides[i] || autoTypes[i];
    const label = currentType === 'numeric' ? 'NUM' : 'CAT';
    const isSkipped = skipCols.has(i);
    const cf = colFilters[i] || {};
    const filterable = isFilterableCol(header, i, autoTypes, typeOverrides, data.xyz, skipCols);
    const hideCls = filterable ? '' : ' pf-filter-hidden';
    html += `<div class="pf-col-item${isSkipped ? ' skipped' : ''}" data-col="${i}" data-name="${esc(header[i]).toLowerCase()}">
      <span class="col-idx">${i}</span>
      <input type="checkbox" class="pf-col-check" data-col="${i}" ${!isSkipped ? 'checked' : ''}>
      <span class="pf-col-name" title="${esc(header[i])}">${esc(header[i])}</span>
      <div class="pf-col-controls">
        <button class="pf-filter-btn${cf.skipNeg ? ' active' : ''}${hideCls}" data-col="${i}" data-filter="skipNeg" title="Exclude negatives">≥0</button>
        <button class="pf-filter-btn${cf.skipZeros ? ' active' : ''}${hideCls}" data-col="${i}" data-filter="skipZeros" title="Exclude zeros">≠0</button>
        <button class="type-toggle" data-col="${i}" data-type="${currentType}">${label}</button>
      </div>
    </div>`;
  }
  html += '</div>';


  $preflightSidebar.innerHTML = html;

  // Build XYZ and DXYZ dropdowns and update counts
  rebuildPfXyz(data);
  rebuildPfDxyz(data);
  updatePfCounts(data);

  // === Wire event delegation (once per render) ===

  const $pfColList = document.getElementById('pfColList');

  // Delegated click on column list: type toggles + filter buttons
  $pfColList.addEventListener('click', (e) => {
    const btn = e.target.closest('.type-toggle');
    if (btn) { handlePfTypeToggle(btn, data); return; }
    const fbtn = e.target.closest('.pf-filter-btn');
    if (fbtn) { handlePfFilterBtn(fbtn, data); return; }
  });

  // Delegated change on column list: checkboxes
  $pfColList.addEventListener('change', (e) => {
    const cb = e.target.closest('.pf-col-check');
    if (cb) handlePfCheckbox(cb, data);
  });

  // Search
  const $search = document.getElementById('pfSearch');
  $search.addEventListener('input', () => {
    const q = $search.value.toLowerCase().trim();
    $pfColList.querySelectorAll('.pf-col-item').forEach(el => {
      el.style.display = (!q || el.dataset.name.includes(q)) ? '' : 'none';
    });
    // Update All/None labels based on search state
    const $all = document.getElementById('pfSelectAll');
    const $none = document.getElementById('pfSelectNone');
    if ($all) $all.textContent = q ? 'all visible' : 'all';
    if ($none) $none.textContent = q ? 'none visible' : 'none';
  });
  $search.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.stopPropagation(); });

  // Select all / none — search-aware
  document.getElementById('pfSelectAll').addEventListener('click', () => handlePfSelectAll(data));
  document.getElementById('pfSelectNone').addEventListener('click', () => handlePfSelectNone(data));

  // Bulk filter buttons
  document.getElementById('pfFilterAllGt0').addEventListener('click', () => handlePfBulkFilterAll(data));
  document.getElementById('pfFilterClear').addEventListener('click', () => handlePfBulkFilterClear(data));

}

// --- Preflight sidebar helper functions ---

function rebuildPfXyz(data) {
  const { header, autoTypes, typeOverrides, skipCols } = data;
  const types = header.map((_, i) => typeOverrides[i] || autoTypes[i]);
  const numCols = header.map((_, i) => i).filter(i => types[i] === 'numeric' && !skipCols.has(i));

  function makeAxisSelect(axis) {
    const current = data.xyz[axis];
    let opts = `<option value="-1" ${current < 0 ? 'selected' : ''}>—</option>`;
    for (const i of numCols) {
      opts += `<option value="${i}" ${i === current ? 'selected' : ''}>${esc(header[i])}</option>`;
    }
    return `<label><span class="axis-label">${axis.toUpperCase()}</span><select data-axis="${axis}">${opts}</select></label>`;
  }

  const wrap = document.getElementById('pfXyzWrap');
  if (!wrap) return;
  wrap.innerHTML = `<div class="pf-xyz-row">${makeAxisSelect('x')}${makeAxisSelect('y')}${makeAxisSelect('z')}</div>`;
  wirePfXyzHandlers(data);
}

function wirePfXyzHandlers(data) {
  const wrap = document.getElementById('pfXyzWrap');
  if (!wrap) return;
  wrap.querySelectorAll('select').forEach(sel => {
    sel.addEventListener('change', () => {
      data.xyz[sel.dataset.axis] = parseInt(sel.value);
      updateAllFilterButtonVisibility(data);
      updatePfCounts(data);
      markAnalysisStale();
    });
  });
}

function rebuildPfDxyz(data) {
  const { header, autoTypes, typeOverrides, skipCols } = data;
  if (!data.dxyz) data.dxyz = { dx: -1, dy: -1, dz: -1 };
  const types = header.map((_, i) => typeOverrides[i] || autoTypes[i]);
  const numCols = header.map((_, i) => i).filter(i => types[i] === 'numeric' && !skipCols.has(i));

  function makeDAxisSelect(axis) {
    const current = data.dxyz[axis];
    let opts = `<option value="-1" ${current < 0 ? 'selected' : ''}>None</option>`;
    for (const i of numCols) {
      opts += `<option value="${i}" ${i === current ? 'selected' : ''}>${esc(header[i])}</option>`;
    }
    return `<label><span class="axis-label">${axis.toUpperCase()}</span><select data-daxis="${axis}">${opts}</select></label>`;
  }

  const wrap = document.getElementById('pfDxyzWrap');
  if (!wrap) return;
  wrap.innerHTML = `<div class="pf-xyz-row">${makeDAxisSelect('dx')}${makeDAxisSelect('dy')}${makeDAxisSelect('dz')}</div>`;
  wrap.querySelectorAll('select').forEach(sel => {
    sel.addEventListener('change', () => {
      data.dxyz[sel.dataset.daxis] = parseInt(sel.value);
      markAnalysisStale();
    });
  });
}

function updatePfCounts(data) {
  const { header, autoTypes, typeOverrides, skipCols, colFilters } = data;
  // Enabled count
  const $en = document.getElementById('pfEnabledCount');
  if ($en) $en.textContent = header.length - skipCols.size;
  // Filter count
  const filterableCols = header.map((_, i) => i).filter(i => isFilterableCol(header, i, autoTypes, typeOverrides, data.xyz, skipCols));
  const activeFilterCount = filterableCols.filter(i => colFilters[i] && (colFilters[i].skipZeros || colFilters[i].skipNeg)).length;
  const $fc = $preflightSidebar.querySelector('.pf-filter-count');
  if ($fc) $fc.textContent = `${activeFilterCount}/${filterableCols.length} filtered`;
}

function updateAllFilterButtonVisibility(data) {
  const { header, autoTypes, typeOverrides, skipCols } = data;
  const $pfColList = document.getElementById('pfColList');
  if (!$pfColList) return;
  $pfColList.querySelectorAll('.pf-col-item').forEach(item => {
    const col = parseInt(item.dataset.col);
    const filterable = isFilterableCol(header, col, autoTypes, typeOverrides, data.xyz, skipCols);
    item.querySelectorAll('.pf-filter-btn').forEach(btn => {
      btn.classList.toggle('pf-filter-hidden', !filterable);
    });
  });
}

function updateItemFilterability(item, col, data) {
  const { header, autoTypes, typeOverrides, skipCols } = data;
  const filterable = isFilterableCol(header, col, autoTypes, typeOverrides, data.xyz, skipCols);
  item.querySelectorAll('.pf-filter-btn').forEach(btn => {
    btn.classList.toggle('pf-filter-hidden', !filterable);
  });
}

// --- Preflight sidebar handler functions ---

function handlePfTypeToggle(btn, data) {
  const { autoTypes, typeOverrides, colFilters } = data;
  const col = parseInt(btn.dataset.col);
  const current = btn.dataset.type;
  const next = current === 'numeric' ? 'categorical' : 'numeric';
  if (next !== autoTypes[col]) {
    typeOverrides[col] = next;
  } else {
    delete typeOverrides[col];
  }
  if (next === 'categorical') {
    for (const axis of ['x', 'y', 'z']) {
      if (data.xyz[axis] === col) data.xyz[axis] = -1;
    }
    delete colFilters[col];
    // Clear active state on filter buttons for this column
    const item = btn.closest('.pf-col-item');
    item.querySelectorAll('.pf-filter-btn').forEach(fb => fb.classList.remove('active'));
  }
  // Update button text and data attribute
  btn.dataset.type = next;
  btn.textContent = next === 'numeric' ? 'NUM' : 'CAT';
  // Update filter button visibility for this item
  updateItemFilterability(btn.closest('.pf-col-item'), col, data);
  rebuildPfXyz(data);
  updatePfCounts(data);
  markAnalysisStale();
}

function handlePfCheckbox(cb, data) {
  const { header, skipCols, colFilters } = data;
  const col = parseInt(cb.dataset.col);
  if (cb.checked) {
    skipCols.delete(col);
  } else {
    skipCols.add(col);
    for (const axis of ['x', 'y', 'z']) {
      if (data.xyz[axis] === col) data.xyz[axis] = -1;
    }
    delete colFilters[col];
    // Clear active state on filter buttons
    const item = cb.closest('.pf-col-item');
    item.querySelectorAll('.pf-filter-btn').forEach(fb => fb.classList.remove('active'));
  }
  cb.closest('.pf-col-item').classList.toggle('skipped', !cb.checked);
  updateItemFilterability(cb.closest('.pf-col-item'), col, data);
  rebuildPfXyz(data);
  updatePfCounts(data);
  updatePreviewDimming(data);
  markAnalysisStale();
}

function handlePfFilterBtn(btn, data) {
  const { colFilters } = data;
  const col = parseInt(btn.dataset.col);
  const filter = btn.dataset.filter;
  if (!colFilters[col]) colFilters[col] = {};
  colFilters[col][filter] = !colFilters[col][filter];
  if (!colFilters[col][filter]) delete colFilters[col][filter];
  if (Object.keys(colFilters[col]).length === 0) delete colFilters[col];
  btn.classList.toggle('active');
  updatePfCounts(data);
  markAnalysisStale();
}

function handlePfSelectAll(data) {
  const { header, skipCols } = data;
  const $pfColList = document.getElementById('pfColList');
  if (!$pfColList) return;
  // Only affect visible (search-matched) items
  $pfColList.querySelectorAll('.pf-col-item').forEach(item => {
    if (item.style.display === 'none') return; // hidden by search
    const col = parseInt(item.dataset.col);
    skipCols.delete(col);
    item.classList.remove('skipped');
    const cb = item.querySelector('.pf-col-check');
    if (cb) cb.checked = true;
    updateItemFilterability(item, col, data);
  });
  rebuildPfXyz(data);
  updatePfCounts(data);
  updatePreviewDimming(data);
  markAnalysisStale();
}

function handlePfSelectNone(data) {
  const { header, skipCols, colFilters } = data;
  const $pfColList = document.getElementById('pfColList');
  if (!$pfColList) return;
  // Only affect visible (search-matched) items
  $pfColList.querySelectorAll('.pf-col-item').forEach(item => {
    if (item.style.display === 'none') return; // hidden by search
    const col = parseInt(item.dataset.col);
    skipCols.add(col);
    // Clear XYZ assignments for this column
    for (const axis of ['x', 'y', 'z']) {
      if (data.xyz[axis] === col) data.xyz[axis] = -1;
    }
    delete colFilters[col];
    item.classList.add('skipped');
    const cb = item.querySelector('.pf-col-check');
    if (cb) cb.checked = false;
    // Clear filter active states and hide buttons
    item.querySelectorAll('.pf-filter-btn').forEach(fb => {
      fb.classList.remove('active');
      fb.classList.add('pf-filter-hidden');
    });
  });
  rebuildPfXyz(data);
  updatePfCounts(data);
  updatePreviewDimming(data);
  markAnalysisStale();
}

function handlePfBulkFilterAll(data) {
  const { header, autoTypes, typeOverrides, skipCols, colFilters } = data;
  const filterableCols = header.map((_, i) => i).filter(i => isFilterableCol(header, i, autoTypes, typeOverrides, data.xyz, skipCols));
  for (const i of filterableCols) {
    colFilters[i] = { skipZeros: true, skipNeg: true };
  }
  // Set active class on all visible filter buttons for filterable cols
  const $pfColList = document.getElementById('pfColList');
  if ($pfColList) {
    $pfColList.querySelectorAll('.pf-filter-btn').forEach(btn => {
      const col = parseInt(btn.dataset.col);
      if (filterableCols.includes(col)) btn.classList.add('active');
    });
  }
  updatePfCounts(data);
  markAnalysisStale();
}

function handlePfBulkFilterClear(data) {
  const { colFilters } = data;
  for (const key of Object.keys(colFilters)) delete colFilters[key];
  // Remove active class from all filter buttons
  const $pfColList = document.getElementById('pfColList');
  if ($pfColList) {
    $pfColList.querySelectorAll('.pf-filter-btn').forEach(btn => btn.classList.remove('active'));
  }
  updatePfCounts(data);
  markAnalysisStale();
}

function updatePreviewDimming(data) {
  const table = $preflightPreview.querySelector('table');
  if (!table) return;
  for (let c = 0; c < data.header.length; c++) {
    const colIdx = c + 1;
    const isSkipped = data.skipCols.has(c);
    table.querySelectorAll(`th:nth-child(${colIdx + 1}), td:nth-child(${colIdx + 1})`).forEach(el => {
      el.classList.toggle('col-skipped', isSkipped);
    });
  }
}

function renderPreflightTable(data) {
  const { header, sampleRows, skipCols } = data;

  let thead = '<tr><th style="color:var(--fg-dim);opacity:0.5">#</th>';
  for (let i = 0; i < header.length; i++) {
    const dimClass = skipCols.has(i) ? ' class="col-skipped"' : '';
    thead += `<th${dimClass}>${esc(header[i])}</th>`;
  }
  thead += '</tr>';

  let tbody = '';
  for (let r = 0; r < sampleRows.length; r++) {
    tbody += `<tr><td>${r}</td>`;
    for (let c = 0; c < header.length; c++) {
      const val = (sampleRows[r] && sampleRows[r][c]) || '';
      const dimClass = skipCols.has(c) ? ' class="col-skipped"' : '';
      tbody += `<td${dimClass}>${esc(val)}</td>`;
    }
    tbody += '</tr>';
  }

  $preflightPreview.innerHTML = `<table><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
}

function formatNum(v, decimals) {
  if (v === null || v === undefined) return '—';
  if (Math.abs(v) >= 1e6 || (Math.abs(v) < 0.001 && v !== 0)) return v.toExponential(decimals ?? 3);
  if (Number.isInteger(v)) return v.toLocaleString();
  return v.toLocaleString(undefined, { minimumFractionDigits: decimals ?? 2, maximumFractionDigits: decimals ?? 4 });
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function delimName(d) {
  if (d === ',') return 'comma';
  if (d === '\t') return 'tab';
  if (d === ';') return 'semicolon';
  if (d === '|') return 'pipe';
  if (d === ' ') return 'space';
  return JSON.stringify(d);
}

