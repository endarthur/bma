// ─── Grade-Tonnage (GT) Tab ──────────────────────────────────────────

const GT_TONNAGE_UNITS = [
  { label: 't',  symbol: 't',  divisor: 1 },
  { label: 'kt', symbol: 'kt', divisor: 1e3 },
  { label: 'Mt', symbol: 'Mt', divisor: 1e6 },
  { label: 'Custom\u2026', symbol: null, divisor: null }
];
// Metal column/curve units \u2014 divisor is tonnes of metal per displayed unit.
// 'tonnage' means follow the tonnage unit (historic default).
const GT_METAL_UNITS = [
  { label: '= tonnage', symbol: null, divisor: 'tonnage' },
  { label: 't',   symbol: 't',   divisor: 1 },
  { label: 'kt',  symbol: 'kt',  divisor: 1e3 },
  { label: 'Mt',  symbol: 'Mt',  divisor: 1e6 },
  { label: 'kg',  symbol: 'kg',  divisor: 1e-3 },
  { label: 'oz',  symbol: 'oz',  divisor: 3.11034768e-5 },
  { label: 'koz', symbol: 'koz', divisor: 3.11034768e-2 },
  { label: 'Moz', symbol: 'Moz', divisor: 31.1034768 },
  { label: 'lb',  symbol: 'lb',  divisor: 4.5359237e-4 },
  { label: 'klb', symbol: 'klb', divisor: 0.45359237 },
  { label: 'Mlb', symbol: 'Mlb', divisor: 453.59237 },
  { label: 'Custom\u2026', symbol: null, divisor: null }
];
const GT_GRADE_UNITS = GRADE_UNITS.concat([{ label: 'Custom\u2026', symbol: null, factor: null }]);

let gtNumCols = [];
let gtCatCols = [];
let gtTableCollapsed = new Set(); // collapsed table sections by column name (C6-0)
let gtStale = false;              // result no longer matches the sidebar (C6-5)

// Mark the GT result stale (config changed since the last Generate). Live
// re-render controls (units/dp/group-values) are excluded by the callers.
function gtMarkStale() {
  if (gtStale || !lastGtData) return;
  gtStale = true;
  if (typeof setGenStale === 'function') setGenStale('gtGenerate', true);
}

// A10 4g: feature-detect the block-volume source. Volume-weighted tonnage needs
// a volume source; without one GT falls back to count-based (1 per row), with
// the Weight select available as a per-row tonnage/volume multiplier. Sources,
// in priority: per-row DXYZ columns → the model's grid geometry — but only when
// it COUNTS as a grid (dsHasGrid respects the 4f grid/point override, so a model
// classified as points no longer silently uses its geometry volume) → else
// count-based. Returns { display, hint, value, kind }.
function gtVolumeSource() {
  var hasDXYZ = currentDXYZ.dx >= 0 && currentDXYZ.dy >= 0 && currentDXYZ.dz >= 0;
  if (hasDXYZ) return { display: 'Per-row DXYZ columns', hint: '', value: '', kind: 'dxyz' };
  var geo = lastCompleteData && lastCompleteData.geometry;
  var isGrid = (typeof dsHasGrid === 'function') && dsHasGrid(dsById('model'));
  if (isGrid && geo && geo.x && geo.y && geo.z && geo.x.blockSize && geo.y.blockSize && geo.z.blockSize) {
    var bv = geo.x.blockSize * geo.y.blockSize * geo.z.blockSize;
    return {
      display: 'Geometry: ' + geo.x.blockSize + ' × ' + geo.y.blockSize + ' × ' + geo.z.blockSize + ' = ' + formatNum(bv) + ' m³',
      hint: '', value: bv, kind: 'geometry'
    };
  }
  // Not a grid → count-based. Name why + how to get volume-weighting when the
  // model carries a detectable block size but is classified as points.
  var hint = (geo && geo.x && geo.x.blockSize)
    ? 'Classified as points — for volume-weighted tonnage set this dataset to “grid” in Import Model, assign DXYZ, set an Override, or pick a tonnage/volume column under Weight.'
    : '';
  return { display: 'Count-based (1 per row)', hint: hint, value: '', kind: 'count' };
}

// A10 4g: refresh just the GT volume-source display + auto-managed override when
// the model's grid classification changes (4f override). No-op if GT isn't built
// yet. The override is auto-managed only while it carries data-gt-auto (set on
// the geometry prefill, cleared once the user types a value).
function gtRefreshVolumeSource() {
  var $d = document.getElementById('gtVolDisplay');
  if (!$d) return;
  var info = gtVolumeSource();
  $d.textContent = info.display;
  var $h = document.getElementById('gtVolHint');
  if ($h) { $h.innerHTML = info.hint ? esc(info.hint) : ''; $h.style.display = info.hint ? '' : 'none'; }
  var $ov = document.getElementById('gtVolOverride');
  if ($ov && ($ov.dataset.gtAuto || $ov.value === '')) {
    if (info.kind === 'geometry') { $ov.value = info.value; $ov.dataset.gtAuto = '1'; }
    else { $ov.value = ''; delete $ov.dataset.gtAuto; }
  }
  gtMarkStale();
}

function renderGtConfig(data) {
  var $sidebar = document.getElementById('gtSidebar');
  var $content = document.getElementById('gtContent');
  if (!$sidebar) return;
  var header = data.header, colTypes = data.colTypes, geometry = data.geometry;

  // Reset cached results
  lastGtData = null;

  // Gather numeric columns (excluding XYZ/DXYZ)
  var excludeSet = new Set();
  if (currentXYZ.x >= 0) excludeSet.add(currentXYZ.x);
  if (currentXYZ.y >= 0) excludeSet.add(currentXYZ.y);
  if (currentXYZ.z >= 0) excludeSet.add(currentXYZ.z);
  if (currentDXYZ.dx >= 0) excludeSet.add(currentDXYZ.dx);
  if (currentDXYZ.dy >= 0) excludeSet.add(currentDXYZ.dy);
  if (currentDXYZ.dz >= 0) excludeSet.add(currentDXYZ.dz);

  gtNumCols = header.map(function(h, i) { return { name: h, idx: i, type: colTypes[i] }; })
    .filter(function(c) { return c.type === 'numeric' && !excludeSet.has(c.idx); });

  gtCatCols = header.map(function(h, i) { return { name: h, idx: i, type: colTypes[i] }; })
    .filter(function(c) { return c.type === 'categorical'; });

  if (gtNumCols.length === 0) {
    $sidebar.innerHTML = '';
    $content.innerHTML = '<div class="gt-hint">No numeric variable columns available for grade-tonnage analysis.</div>';
    return;
  }

  // Auto-detect block volume \u2014 feature-detected + grid-classification aware (4g)
  var volInfo = gtVolumeSource();
  var volDisplay = volInfo.display;
  var volHint = volInfo.hint;
  var volValue = volInfo.value;

  // Grade variable checkbox list with per-variable unit selects
  var varItems = gtNumCols.map(function(c, i) {
    var defUnit = catPropUnit('model', c.name);
    var opts = GT_GRADE_UNITS.slice(0, -1).map(function(u, ui) {
      return '<option value="' + ui + '"' + (ui === defUnit ? ' selected' : '') + '>' + esc(u.label) + '</option>';
    }).join('');
    var emptyTag = colIsEmpty('model', c.idx) ? '<span class="empty-tag" title="' + EMPTY_COL_TITLE + '">∅</span>' : '';
    return '<label class="gt-var-item"><input type="checkbox" value="' + c.idx + '"' + (i === 0 ? ' checked' : '') + '><span>' + esc(c.name) + '</span>' + emptyTag +
      '<select class="gt-var-unit" data-col="' + c.idx + '">' + opts + '</select></label>';
  }).join('');

  var numColOpts = gtNumCols.map(function(c) {
    return '<option value="' + c.idx + '">' + esc(c.name) + '</option>';
  }).join('');
  var densityOpts = '<option value="-1">\u2014 none (tonnage = volume)</option>' +
    '<option value="const">Constant\u2026</option>' + numColOpts;
  var weightOpts = '<option value="-1">\u2014 none</option>' + numColOpts;

  var tonnageUnitOpts = GT_TONNAGE_UNITS.map(function(u, i) {
    return '<option value="' + i + '">' + esc(u.label) + '</option>';
  }).join('');
  var metalUnitOpts = GT_METAL_UNITS.map(function(u, i) {
    return '<option value="' + i + '">' + esc(u.label) + '</option>';
  }).join('');
  var dpOpts = '<option value="">auto</option>';
  for (var dpi = 0; dpi <= 6; dpi++) dpOpts += '<option value="' + dpi + '">' + dpi + ' dp</option>';

  // Group-by dropdown
  var groupByOpts = '<option value="-1">\u2014 none</option>' + gtCatCols.map(function(c) {
    return '<option value="' + c.idx + '">' + esc(c.name) + '</option>';
  }).join('');

  // Default cutoff range from first grade column stats
  var defMin = 0, defMax = 1, defStep = 0.05;
  var firstGrade = gtNumCols[0];
  if (lastCompleteData && lastCompleteData.stats && lastCompleteData.stats[firstGrade.idx]) {
    var gs = lastCompleteData.stats[firstGrade.idx];
    defMin = gs.min != null ? Math.floor(gs.min * 100) / 100 : 0;
    defMax = gs.max != null ? Math.ceil(gs.max * 100) / 100 : 1;
    defStep = +((defMax - defMin) / 20).toPrecision(2) || 0.05;
  }

  $sidebar.innerHTML =
    '<div class="gt-sidebar-section--grow" data-sb="vars">' +
      '<div class="gt-sidebar-title">Grade Variables</div>' +
      '<input type="text" class="gt-input gt-var-search" id="gtVarSearch" placeholder="search\u2026" spellcheck="false">' +
      '<div class="gt-var-btns"><button id="gtVarAll">All</button><button id="gtVarNone">None</button></div>' +
      '<div class="gt-var-list" id="gtVarList">' + varItems + '</div>' +
    '</div>' +
    '<div class="gt-sidebar-section" data-sb="density">' +
      '<div class="gt-sidebar-title">Density (optional)</div>' +
      '<select class="gt-select" id="gtDensityCol">' + densityOpts + '</select>' +
      '<div id="gtDensityConstWrap" style="display:none;margin-top:0.3rem;align-items:center;gap:0.3rem">' +
        '<input type="number" class="gt-input" id="gtDensityConst" value="2.7" min="0" step="any" placeholder="2.7">' +
        '<span style="font-size:0.62rem;color:var(--fg-dim);white-space:nowrap">t/m³</span>' +
      '</div>' +
    '</div>' +
    '<div class="gt-sidebar-section" data-sb="weight">' +
      '<div class="gt-sidebar-title">Weight (optional)</div>' +
      '<select class="gt-select" id="gtWeightCol">' + weightOpts + '</select>' +
    '</div>' +
    '<div class="gt-sidebar-section" data-sb="group">' +
      '<div class="gt-sidebar-title">Group by (optional)</div>' +
      '<select class="gt-select" id="gtGroupBy">' + groupByOpts + '</select>' +
      '<div class="gt-group-values" id="gtGroupValues" style="display:none">' +
        '<div class="gt-var-btns"><button id="gtGrpAll">All</button><button id="gtGrpNone">None</button></div>' +
        '<div class="gt-var-list" id="gtGrpList"></div>' +
      '</div>' +
    '</div>' +
    '<div class="gt-sidebar-section" data-sb="volume">' +
      '<div class="gt-sidebar-title">Block Volume</div>' +
      '<div class="gt-vol-display" id="gtVolDisplay">' + esc(volDisplay) + '</div>' +
      '<div class="gt-vol-hint" id="gtVolHint"' + (volHint ? '' : ' style="display:none"') + '>' + (volHint ? esc(volHint) : '') + '</div>' +
      '<div style="display:flex;gap:0.3rem;align-items:center;margin-top:0.2rem">' +
        '<span style="font-size:0.62rem;color:var(--fg-dim);white-space:nowrap">Override (m\u00b3)</span>' +
        '<input type="number" class="gt-input" id="gtVolOverride" value="' + volValue + '"' + (volValue !== '' ? ' data-gt-auto="1"' : '') + ' min="0" step="any" placeholder="auto">' +
      '</div>' +
    '</div>' +
    '<div class="gt-sidebar-section" data-sb="units">' +
      '<div class="gt-sidebar-title">Units &amp; Format</div>' +
      '<div class="gt-unit-row"><span class="gt-unit-label">Tonnage</span><select class="gt-select" id="gtTonnageUnit">' + tonnageUnitOpts + '</select><select class="gt-select gt-dp-select" id="gtTonnageDp" title="Decimal places">' + dpOpts + '</select></div>' +
      '<div id="gtCustomTonnageWrap" style="display:none;margin-bottom:0.3rem">' +
        '<div style="display:flex;gap:0.3rem">' +
          '<input type="text" class="gt-input" id="gtCustomTonnageSym" placeholder="symbol" style="width:50px">' +
          '<input type="number" class="gt-input" id="gtCustomTonnageDiv" placeholder="divisor" step="any">' +
        '</div>' +
      '</div>' +
      '<div class="gt-unit-row"><span class="gt-unit-label">Metal</span><select class="gt-select" id="gtMetalUnit">' + metalUnitOpts + '</select><select class="gt-select gt-dp-select" id="gtMetalDp" title="Decimal places">' + dpOpts + '</select></div>' +
      '<div id="gtCustomMetalWrap" style="display:none;margin-bottom:0.3rem">' +
        '<div style="display:flex;gap:0.3rem">' +
          '<input type="text" class="gt-input" id="gtCustomMetalSym" placeholder="symbol" style="width:50px">' +
          '<input type="number" class="gt-input" id="gtCustomMetalDiv" placeholder="t per unit" step="any" title="Tonnes of metal per displayed unit">' +
        '</div>' +
      '</div>' +
      '<div class="gt-unit-row"><span class="gt-unit-label">Grade</span><span class="gt-unit-note">unit set per variable</span><select class="gt-select gt-dp-select" id="gtGradeDp" title="Decimal places">' + dpOpts + '</select></div>' +
    '</div>' +
    '<div class="gt-sidebar-section" data-sb="cutoffs">' +
      '<div class="gt-sidebar-title">Cutoffs</div>' +
      '<div style="margin-bottom:0.3rem">' +
        '<label class="gt-radio-label"><input type="radio" name="gtCutoffMode" value="range" checked> Range</label>' +
        '<label class="gt-radio-label"><input type="radio" name="gtCutoffMode" value="custom"> Custom</label>' +
      '</div>' +
      '<div id="gtCutoffRange">' +
        '<div style="display:flex;gap:0.3rem">' +
          '<label style="flex:1;display:flex;flex-direction:column;gap:0.1rem"><span style="font-size:0.62rem;color:var(--fg-dim)">Min</span><input type="number" class="gt-input" id="gtCutoffMin" value="' + defMin + '" step="any"></label>' +
          '<label style="flex:1;display:flex;flex-direction:column;gap:0.1rem"><span style="font-size:0.62rem;color:var(--fg-dim)">Max</span><input type="number" class="gt-input" id="gtCutoffMax" value="' + defMax + '" step="any"></label>' +
          '<label style="flex:1;display:flex;flex-direction:column;gap:0.1rem"><span style="font-size:0.62rem;color:var(--fg-dim)">Step</span><input type="number" class="gt-input" id="gtCutoffStep" value="' + defStep + '" step="any" min="0"></label>' +
        '</div>' +
        '<select class="gt-select" id="gtRangeFrom" style="margin-top:0.3rem" title="Set Min/Max/Step from a variable’s data range">' +
          '<option value="">↧ copy range from variable…</option>' + numColOpts +
        '</select>' +
      '</div>' +
      '<div id="gtCutoffCustom" style="display:none">' +
        '<input type="text" class="gt-input" id="gtCutoffCustomText" placeholder="0.2, 0.5, 1.0, 2.0, 5.0" spellcheck="false">' +
      '</div>' +
    '</div>' +
    '<div class="gt-sidebar-section" data-sb="filter">' +
      '<div class="gt-sidebar-title">Local Filter</div>' +
      '<input type="text" class="gt-input" id="gtLocalFilter" placeholder="e.g. r.zone == 1" autocomplete="off" spellcheck="false">' +
    '</div>' +
    '<div class="gt-sidebar-section" data-sb="theo">' +
      '<div class="gt-sidebar-title">Theoretical (samples)</div>' +
      '<label class="gt-radio-label" style="display:block"><input type="checkbox" id="gtTheoEnabled"> Overlay theoretical GT</label>' +
      '<select class="gt-select" id="gtTheoEngine" style="margin-top:0.25rem">' +
        '<option value="affine">Affine correction</option>' +
        '<option value="dgm" disabled>DGM (Hermite) — next</option>' +
      '</select>' +
      gtTheoSourceSelectHtml() +
      '<div style="display:flex;gap:0.3rem;align-items:center;margin-top:0.3rem">' +
        '<span style="font-size:0.62rem;color:var(--fg-dim);white-space:nowrap" title="variance reduction factor: Var(blocks)/Var(samples). From your estimation work, or explore — never derived from the model (circular)">f</span>' +
        '<input type="range" id="gtTheoF" min="0.05" max="1" step="0.01" value="0.6" style="flex:1">' +
        '<input type="number" class="gt-input" id="gtTheoFNum" value="0.6" min="0.05" max="1" step="0.01" style="width:52px">' +
      '</div>' +
      '<div class="gt-theo-status" id="gtTheoStatus"></div>' +
    '</div>' +
    '<div class="sb-footer">' +
      '<button class="gt-generate" id="gtGenerate">Generate</button>' +
      '<div class="gen-stale-note">↻ config changed — re-run</div>' +
      '<div class="gt-progress" id="gtProgress">' +
        '<div class="gt-progress-bar"><div class="gt-progress-fill" id="gtProgressFill"></div></div>' +
        '<div class="gt-progress-label" id="gtProgressLabel"></div>' +
      '</div>' +
    '</div>';

  // C6-4b — collapsible sections; everything past Grade Variables collapsed
  // by default (the "nine sections in a wall" fix), Generate in a sticky footer
  wsEnhanceSidebar('gt', $sidebar, {
    density: 'collapsed', weight: 'collapsed', group: 'collapsed', volume: 'collapsed',
    units: 'collapsed', cutoffs: 'collapsed', filter: 'collapsed', theo: 'collapsed'
  });

  $content.innerHTML = '<div class="gt-hint">Select grade variables and click Generate.</div>';

  // Wire events — autosave on any sidebar change; mark the result stale on
  // changes that need a worker re-run. Units/dp/grade-unit and group-value
  // toggles re-render client-side from cache (excluded below).
  var GT_LIVE_IDS = ['gtTonnageUnit', 'gtMetalUnit', 'gtTonnageDp', 'gtGradeDp', 'gtMetalDp',
    'gtCustomTonnageSym', 'gtCustomTonnageDiv', 'gtCustomMetalSym', 'gtCustomMetalDiv', 'gtGrpAll', 'gtGrpNone', 'gtVarSearch',
    'gtTheoEnabled', 'gtTheoEngine', 'gtTheoF', 'gtTheoFNum'];  // theo re-renders client-side from cache
  function gtIsLiveTarget(t) {
    return !t || GT_LIVE_IDS.indexOf(t.id) >= 0 || t.classList.contains('gt-var-unit') || (t.closest && t.closest('#gtGrpList'));
  }
  $sidebar.addEventListener('change', function(e) {
    autoSaveProject();
    if (!gtIsLiveTarget(e.target)) gtMarkStale();
  });
  $sidebar.addEventListener('input', function(e) {
    // 4g: a user-typed Override is no longer the auto geometry value
    if (e.target.id === 'gtVolOverride') delete e.target.dataset.gtAuto;
    if (e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && e.target.type !== 'radio') autoSaveProject();
    if ((e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') && !gtIsLiveTarget(e.target)) gtMarkStale();
  });

  var $tonnageUnit = document.getElementById('gtTonnageUnit');

  // Variable search filter
  var $gtVarSearch = document.getElementById('gtVarSearch');
  $gtVarSearch.addEventListener('input', function() {
    var q = this.value.toLowerCase();
    document.querySelectorAll('#gtVarList .gt-var-item').forEach(function(item) {
      var name = item.querySelector('span').textContent.toLowerCase();
      item.style.display = fuzzyMatch(q, name) ? '' : 'none';
    });
  });
  wireSearchShortcuts($gtVarSearch, document.getElementById('gtVarAll'), document.getElementById('gtVarNone'));

  // All/None buttons for grade variables (only affect visible items)
  document.getElementById('gtVarAll').addEventListener('click', function() {
    document.querySelectorAll('#gtVarList .gt-var-item').forEach(function(item) {
      if (item.style.display !== 'none') item.querySelector('input[type="checkbox"]').checked = true;
    });
  });
  document.getElementById('gtVarNone').addEventListener('click', function() {
    document.querySelectorAll('#gtVarList .gt-var-item').forEach(function(item) {
      if (item.style.display !== 'none') item.querySelector('input[type="checkbox"]').checked = false;
    });
  });

  // Theoretical overlay controls — slider re-renders through a small
  // debounce so dragging f stays smooth
  var $theoCb = document.getElementById('gtTheoEnabled');
  var $theoF = document.getElementById('gtTheoF');
  var $theoFNum = document.getElementById('gtTheoFNum');
  var theoRerender = (function() {
    var t = null;
    return function() {
      if (t) return;
      t = setTimeout(function() { t = null; if (lastGtData) renderGtOutput(); }, 60);
    };
  })();
  if ($theoCb) $theoCb.addEventListener('change', function() {
    gtTheoSetStatus($theoCb.checked && !lastGtData ? 'Generate to draw the overlay' : '');
    if (lastGtData) renderGtOutput();
  });
  if ($theoF) $theoF.addEventListener('input', function() {
    if ($theoFNum) $theoFNum.value = $theoF.value;
    if (gtTheoActive()) theoRerender();
  });
  if ($theoFNum) $theoFNum.addEventListener('input', function() {
    var fv = parseFloat($theoFNum.value);
    if (isFinite(fv) && fv >= 0.05 && fv <= 1 && $theoF) $theoF.value = fv;
    if (gtTheoActive()) theoRerender();
  });
  // G2: wire the theoretical-curve source picker (rebuilt + bound here)
  refreshGtTheoSource();

  // Cutoff mode radio
  document.querySelectorAll('input[name="gtCutoffMode"]').forEach(function(r) {
    r.addEventListener('change', function() {
      document.getElementById('gtCutoffRange').style.display = r.value === 'range' ? '' : 'none';
      document.getElementById('gtCutoffCustom').style.display = r.value === 'custom' ? '' : 'none';
    });
  });

  // Unit custom toggles
  $tonnageUnit.addEventListener('change', function() {
    var idx = parseInt($tonnageUnit.value);
    document.getElementById('gtCustomTonnageWrap').style.display = GT_TONNAGE_UNITS[idx].divisor === null ? '' : 'none';
    if (lastGtData) renderGtOutput();
  });
  var $metalUnit = document.getElementById('gtMetalUnit');
  $metalUnit.addEventListener('change', function() {
    var idx = parseInt($metalUnit.value);
    document.getElementById('gtCustomMetalWrap').style.display = (GT_METAL_UNITS[idx] || {}).divisor === null ? '' : 'none';
    if (lastGtData) renderGtOutput();
  });
  // Decimal-place selects and custom unit fields — live re-render
  ['gtTonnageDp', 'gtGradeDp', 'gtMetalDp', 'gtCustomTonnageSym', 'gtCustomTonnageDiv', 'gtCustomMetalSym', 'gtCustomMetalDiv'].forEach(function(id) {
    document.getElementById(id).addEventListener('change', function() {
      if (lastGtData) renderGtOutput();
    });
  });

  // Copy cutoff Min/Max/Step from a variable's analyzed range
  document.getElementById('gtRangeFrom').addEventListener('change', function() {
    var idx = parseInt(this.value);
    this.value = '';
    if (!(idx >= 0) || !lastCompleteData || !lastCompleteData.stats || !lastCompleteData.stats[idx]) return;
    var st = lastCompleteData.stats[idx];
    if (st.min == null || st.max == null) return;
    var mn = Math.floor(st.min * 100) / 100;
    var mx = Math.ceil(st.max * 100) / 100;
    document.getElementById('gtCutoffMin').value = mn;
    document.getElementById('gtCutoffMax').value = mx;
    document.getElementById('gtCutoffStep').value = +((mx - mn) / 20).toPrecision(2) || 0.05;
    autoSaveProject();
  });
  // Constant density input toggle
  document.getElementById('gtDensityCol').addEventListener('change', function() {
    document.getElementById('gtDensityConstWrap').style.display = this.value === 'const' ? 'flex' : 'none';
  });
  // Per-variable grade unit change — write-through to the catalog (one unit
  // per variable, D2), mirror the other unit selects, re-render if results
  document.getElementById('gtVarList').addEventListener('change', function(e) {
    if (e.target.classList.contains('gt-var-unit')) {
      var un = currentHeader[parseInt(e.target.dataset.col)];
      if (un) catSetUnit('model', un, parseInt(e.target.value));
      catRefreshUnitSelects();
      if (lastGtData) renderGtOutput();
      autoSaveProject();
    }
  });

  // Group-by dropdown change — populate group value checkboxes
  document.getElementById('gtGroupBy').addEventListener('change', function() {
    updateGroupByValues();
  });

  // Group value All/None buttons
  document.getElementById('gtGrpAll').addEventListener('click', function() {
    document.querySelectorAll('#gtGrpList input[type="checkbox"]').forEach(function(cb) { cb.checked = true; });
    if (lastGtData) renderGtOutput();
  });
  document.getElementById('gtGrpNone').addEventListener('click', function() {
    document.querySelectorAll('#gtGrpList input[type="checkbox"]').forEach(function(cb) { cb.checked = false; });
    if (lastGtData) renderGtOutput();
  });

  // Group value checkbox change — re-render
  document.getElementById('gtGrpList').addEventListener('change', function() {
    if (lastGtData) renderGtOutput();
  });

  // Generate button
  document.getElementById('gtGenerate').addEventListener('click', runGt);

  // Local filter autocomplete
  if (gtExprController) gtExprController.destroy();
  gtExprController = createExprInput(document.getElementById('gtLocalFilter'), { mode: 'filter' });
}

function updateGroupByValues() {
  var $wrap = document.getElementById('gtGroupValues');
  var $list = document.getElementById('gtGrpList');
  var colIdx = parseInt(document.getElementById('gtGroupBy').value);
  if (colIdx < 0 || !lastCompleteData || !lastCompleteData.categories) {
    $wrap.style.display = 'none';
    $list.innerHTML = '';
    return;
  }
  var catEntry = lastCompleteData.categories[colIdx];
  if (!catEntry || !catEntry.counts) { $wrap.style.display = 'none'; return; }
  var cats = catEntry.counts;
  var colName = currentHeader[colIdx] || '';
  var values = Object.keys(cats);
  // Use custom order if available
  var gtGrpOrder = (catVarPeek('model', colName) || {}).valueOrder;
  if (gtGrpOrder) {
    var orderedSet = new Set(gtGrpOrder);
    var ordered = gtGrpOrder.filter(function(v) { return cats[v] != null; });
    var rest = values.filter(function(v) { return !orderedSet.has(v); }).sort();
    values = ordered.concat(rest);
  } else {
    values.sort();
  }
  var html = '<label class="gt-var-item"><input type="checkbox" value="__total__" checked><span>Total (all)</span></label>';
  for (var i = 0; i < values.length; i++) {
    html += '<label class="gt-var-item"><input type="checkbox" value="' + esc(values[i]) + '" checked><span>' + esc(values[i]) + '</span></label>';
  }
  $list.innerHTML = html;
  $wrap.style.display = '';
}

function getGtTonnageUnit() {
  var tIdx = parseInt(document.getElementById('gtTonnageUnit').value);
  var tu = GT_TONNAGE_UNITS[tIdx] || GT_TONNAGE_UNITS[0];
  var tonnageDivisor = tu.divisor;
  var tonnageSymbol = tu.symbol;
  if (tonnageDivisor === null) {
    tonnageSymbol = document.getElementById('gtCustomTonnageSym').value || 'units';
    tonnageDivisor = parseFloat(document.getElementById('gtCustomTonnageDiv').value) || 1;
  }
  var mSel = document.getElementById('gtMetalUnit');
  var mu = GT_METAL_UNITS[mSel ? parseInt(mSel.value) : 0] || GT_METAL_UNITS[0];
  var metalDivisor = mu.divisor;
  var metalSymbol = mu.symbol;
  if (metalDivisor === 'tonnage') {
    metalDivisor = tonnageDivisor;
    metalSymbol = tonnageSymbol;
  } else if (metalDivisor === null) {
    metalSymbol = document.getElementById('gtCustomMetalSym').value || 'units';
    metalDivisor = parseFloat(document.getElementById('gtCustomMetalDiv').value) || 1;
  }
  return { tonnageDivisor: tonnageDivisor, tonnageSymbol: tonnageSymbol, metalDivisor: metalDivisor, metalSymbol: metalSymbol };
}

function getGtFormats() {
  function dp(id) { var el = document.getElementById(id); return el && el.value !== '' ? parseInt(el.value) : null; }
  return { tonnageDp: dp('gtTonnageDp'), gradeDp: dp('gtGradeDp'), metalDp: dp('gtMetalDp') };
}

// Fixed decimal places when set, formatNum auto-formatting otherwise
function gtFmt(v, dp) {
  if (v == null || !isFinite(v) || dp == null) return formatNum(v);
  return addThousandsSep(v.toFixed(dp));
}

function getGtGradeUnit(colIdx) {
  var idx = currentHeader[colIdx] ? catPropUnit('model', currentHeader[colIdx]) : 0;
  var gu = GT_GRADE_UNITS[idx] || GT_GRADE_UNITS[0];
  return { gradeFactor: gu.factor, gradeSymbol: gu.symbol };
}

function getGtCutoffs() {
  var mode = document.querySelector('input[name="gtCutoffMode"]:checked').value;
  var cutoffs = [];
  if (mode === 'range') {
    var mn = parseFloat(document.getElementById('gtCutoffMin').value);
    var mx = parseFloat(document.getElementById('gtCutoffMax').value);
    var step = parseFloat(document.getElementById('gtCutoffStep').value);
    if (!isFinite(mn) || !isFinite(mx) || !isFinite(step) || step <= 0) return [];
    for (var v = mn; v <= mx + step * 0.001; v += step) {
      cutoffs.push(+v.toPrecision(10));
    }
  } else {
    var txt = document.getElementById('gtCutoffCustomText').value;
    txt.split(/[,;\s]+/).forEach(function(s) {
      var v = parseFloat(s.trim());
      if (isFinite(v)) cutoffs.push(v);
    });
    cutoffs.sort(function(a, b) { return a - b; });
  }
  return cutoffs;
}

function getGtCheckedGradeCols() {
  var checked = [];
  document.querySelectorAll('#gtVarList input[type="checkbox"]:checked').forEach(function(cb) {
    checked.push(parseInt(cb.value));
  });
  return checked;
}

function runGt() {
  if (gtExprController) { var r = gtExprController.validate(); if (!r.valid) return; }
  var gradeCols = getGtCheckedGradeCols();
  if (gradeCols.length === 0) return;

  var densitySel = document.getElementById('gtDensityCol').value;
  var densityCol = densitySel === 'const' ? -1 : parseInt(densitySel);
  var densityConst = null;
  if (densitySel === 'const') {
    densityConst = parseFloat(document.getElementById('gtDensityConst').value);
    if (!(densityConst > 0)) densityConst = null;
  }
  var weightCol = parseInt(document.getElementById('gtWeightCol').value);
  var groupByCol = parseInt(document.getElementById('gtGroupBy').value);
  var localFilter = document.getElementById('gtLocalFilter').value.trim();
  var volOverride = parseFloat(document.getElementById('gtVolOverride').value);

  // Compute per-variable grade ranges from stats
  var gradeRanges = [];
  for (var i = 0; i < gradeCols.length; i++) {
    var gc = gradeCols[i];
    var gradeMin = 0, gradeMax = 1;
    if (lastCompleteData && lastCompleteData.stats && lastCompleteData.stats[gc]) {
      var gs = lastCompleteData.stats[gc];
      gradeMin = gs.min != null ? gs.min : 0;
      gradeMax = gs.max != null ? gs.max : 1;
    }
    var range = gradeMax - gradeMin;
    if (range <= 0) range = 1;
    gradeMin -= range * 0.001;
    gradeMax += range * 0.001;
    gradeRanges.push({ min: gradeMin, max: gradeMax });
  }

  // Determine block volume
  var blockVolume = 0;
  var dxyzCols = null;
  var hasDXYZ = currentDXYZ.dx >= 0 && currentDXYZ.dy >= 0 && currentDXYZ.dz >= 0;
  if (isFinite(volOverride) && volOverride > 0) {
    blockVolume = volOverride;
  } else if (hasDXYZ) {
    dxyzCols = [currentDXYZ.dx, currentDXYZ.dy, currentDXYZ.dz];
  } else if (lastCompleteData && lastCompleteData.geometry &&
             (typeof dsHasGrid !== 'function' || dsHasGrid(dsById('model')))) {
    // 4g: only use the geometry block volume when the model COUNTS as a grid —
    // a points-classified model falls through to count-based tonnage.
    var geo = lastCompleteData.geometry;
    if (geo.x && geo.y && geo.z && geo.x.blockSize && geo.y.blockSize && geo.z.blockSize) {
      blockVolume = geo.x.blockSize * geo.y.blockSize * geo.z.blockSize;
    }
  }

  if (gtWorker) gtWorker.terminate();
  gtWorker = new Worker(workerUrl);

  var $progress = document.getElementById('gtProgress');
  var $fill = document.getElementById('gtProgressFill');
  var $label = document.getElementById('gtProgressLabel');
  var $content = document.getElementById('gtContent');
  $progress.classList.add('active');
  $fill.style.width = '0%';
  $label.textContent = '0%';
  $content.innerHTML = '';

  var $btn = document.getElementById('gtGenerate');
  if ($btn) $btn.disabled = true;

  var resolvedTypes = currentColTypes.slice(0, currentOrigColCount);
  var filterPayload = currentFilter ? { expression: currentFilter.expression } : null;
  var zipEntry = preflightData ? (preflightData.selectedZipEntry || null) : null;

  gtWorker.postMessage({
    mode: 'gt',
    file: currentFile,
    zipEntry: zipEntry,
    globalFilter: filterPayload,
    localFilter: localFilter || null,
    calcolCode: currentCalcolCode || null,
    calcolMeta: currentCalcolMeta.length > 0 ? currentCalcolMeta : null,
    resolvedTypes: resolvedTypes,
    gradeCols: gradeCols,
    gradeRanges: gradeRanges,
    densityCol: densityCol >= 0 ? densityCol : null,
    densityConst: densityConst,
    weightCol: weightCol >= 0 ? weightCol : null,
    dxyzCols: dxyzCols,
    blockVolume: blockVolume,
    groupByCol: groupByCol >= 0 ? groupByCol : null,
    dmEndianness: preflightData && preflightData.dmEndianness || null,
    dmFormat: preflightData && preflightData.dmFormat || null
  });

  gtWorker.onerror = function(e) {
    $label.textContent = 'Worker error: ' + (e.message || 'unknown error');
    $label.style.color = 'var(--red)';
    setTimeout(function() { $progress.classList.remove('active'); $label.style.color = ''; }, 3000);
    if ($btn) $btn.disabled = false;
    gtWorker.terminate();
    gtWorker = null;
  };

  gtWorker.onmessage = function(e) {
    var m = e.data;
    if (m.type === 'gt-progress') {
      var pct = Math.min(99, m.percent);
      $fill.style.width = pct.toFixed(1) + '%';
      $label.textContent = pct.toFixed(0) + '%';
    } else if (m.type === 'gt-complete') {
      $fill.style.width = '100%';
      $label.textContent = 'Done';
      setTimeout(function() { $progress.classList.remove('active'); }, 800);
      if ($btn) $btn.disabled = false;
      lastGtData = m;
      gtStale = false;
      if (typeof setGenStale === 'function') setGenStale('gtGenerate', false);
      renderGtOutput();
      // Update tab badge with number of selected grade variables
      if (m.gradeResults) wsTabBadge('gt', 'GT', m.gradeResults.length);
      gtWorker.terminate();
      gtWorker = null;
    } else if (m.type === 'error') {
      $label.textContent = 'Error: ' + m.message;
      setTimeout(function() { $progress.classList.remove('active'); }, 2000);
      if ($btn) $btn.disabled = false;
      gtWorker.terminate();
      gtWorker = null;
    }
  };
}

function renderGtOutput() {
  if (!lastGtData || !lastGtData.gradeResults) return;
  var $content = document.getElementById('gtContent');
  if (!$content) return;
  var cutoffs = getGtCutoffs();
  var tonnageUnit = getGtTonnageUnit();
  var fmts = getGtFormats();
  function unitsFor(colIdx) {
    var g = getGtGradeUnit(colIdx);
    return {
      tonnageDivisor: tonnageUnit.tonnageDivisor,
      tonnageSymbol: tonnageUnit.tonnageSymbol,
      metalDivisor: tonnageUnit.metalDivisor,
      metalSymbol: tonnageUnit.metalSymbol,
      gradeFactor: g.gradeFactor,
      gradeSymbol: g.gradeSymbol,
      tonnageDp: fmts.tonnageDp,
      gradeDp: fmts.gradeDp,
      metalDp: fmts.metalDp
    };
  }
  if (cutoffs.length === 0) {
    $content.innerHTML = '<div class="gt-hint">No valid cutoffs defined.</div>';
    return;
  }

  // Determine which groups are selected (if grouped)
  var selectedGroups = new Set();
  var showTotal = false;
  var isGrouped = lastGtData.grouped;
  if (isGrouped) {
    document.querySelectorAll('#gtGrpList input:checked').forEach(function(cb) {
      if (cb.value === '__total__') showTotal = true;
      else selectedGroups.add(cb.value);
    });
  }

  var gradeResults = lastGtData.gradeResults;
  var html = workerErrNote(lastGtData);
  // A9 F4: rows excluded for invalid per-row tonnage inputs
  if (lastGtData.excluded) {
    var ex = lastGtData.excluded;
    var exParts = [];
    if (ex.volume > 0) exParts.push(ex.volume.toLocaleString() + ' invalid block dims');
    if (ex.density > 0) exParts.push(ex.density.toLocaleString() + ' invalid density');
    if (ex.weight > 0) exParts.push(ex.weight.toLocaleString() + ' invalid weight');
    var exTotal = ex.volume + ex.density + ex.weight;
    html += '<div class="warn-note">' + exTotal.toLocaleString() + ' row' + (exTotal === 1 ? '' : 's') +
      ' excluded from GT (' + exParts.join(', ') + ').</div>';
  }
  // A9 F7: GT group cap
  if (lastGtData.groupOverflow) {
    html += '<div class="warn-note">Group cap reached (200) — groups beyond the first 200 values are missing from the group curves (totals are unaffected).</div>';
  }
  html += '<div class="gt-toolbar"><span class="gt-elapsed">' + (lastGtData.elapsed / 1000).toFixed(1) + 's</span></div>';

  // Theoretical overlay: kick a (re)load when enabled but not covered/fresh;
  // the load completion re-renders. Grouped charts skip the overlay.
  var theoOn = gtTheoActive();
  if (theoOn && isGrouped) gtTheoSetStatus('overlay shows on ungrouped charts only');
  if (theoOn && !isGrouped && !gtTheoLoading && gtTheoSourceDs()) {
    var matchedNow = gtTheoMatchedVars();
    var covered = gtTheo && gtTheo.fingerprint === gtTheoFingerprintNow(Object.keys(gtTheo.byVar)) &&
      matchedNow.length > 0 && matchedNow.every(function(v) { return gtTheo.byVar[v.auxName]; });
    if (!covered && matchedNow.length > 0) runGtTheoLoad();
  }

  for (var gi = 0; gi < gradeResults.length; gi++) {
    var gr = gradeResults[gi];
    var units = unitsFor(gr.colIdx);
    var theo = null;
    if (theoOn && !isGrouped && gtTheo && gtTheo.fingerprint === gtTheoFingerprintNow(Object.keys(gtTheo.byVar))) {
      var mv = gtTheoMatchedVars().filter(function(v) { return v.colName === gr.colName; })[0];
      if (mv && gtTheo.byVar[mv.auxName]) {
        var fVal = gtTheoF();
        theo = {
          f: fVal,
          points: gtTheoCurve(gtTheo.byVar[mv.auxName], cutoffs, fVal).map(function(p) {
            return { cutoff: p.cutoff, tonnage: p.tFrac * gr.totalTonnage / (units.tonnageDivisor || 1), grade: p.grade };
          })
        };
      }
    }
    if (gradeResults.length > 1) {
      html += '<div class="gt-chart-title">' + esc(gr.colName) + (units.gradeSymbol ? ' (' + esc(units.gradeSymbol) + ')' : '') + '</div>';
    }
    html += '<div class="swath-chart-toolbar">' +
      '<button class="swath-chart-btn" data-gt-copysvg="' + gi + '">Copy SVG</button>' +
      '<button class="swath-chart-btn" data-gt-png="' + gi + '" data-col-name="' + esc(gr.colName || '') + '">Download PNG</button>' +
    '</div>';
    html += '<div class="gt-chart-wrap">' + renderGtChart(gr, cutoffs, units, isGrouped, gi, selectedGroups, showTotal, theo) + '</div>';
    // Collapsible table with per-table copy button. Collapse state lives in
    // gtTableCollapsed (by column name), not the DOM \u2014 the chart-width
    // observers rebuild this area (a collapse changes the scrollbar, which
    // changes content width), and DOM-only state reopened the table (C6-0)
    var tableTitle = gradeResults.length > 1 ? esc(gr.colName) + (units.gradeSymbol ? ' (' + esc(units.gradeSymbol) + ')' : '') : 'Table';
    var tCollapsed = gtTableCollapsed.has(gr.colName);
    html += '<div class="gt-table-section">' +
      '<div class="gt-table-header" data-gt-collapse="' + gi + '">' +
        '<span class="gt-table-toggle">' + (tCollapsed ? '\u25B6' : '\u25BC') + '</span> ' + tableTitle +
        '<button class="gt-copy-btn" data-gt-copy="' + gi + '">Copy</button>' +
      '</div>' +
      '<div class="gt-table-body" id="gtTableBody' + gi + '"' + (tCollapsed ? ' style="display:none"' : '') + '>' +
        '<div class="gt-table-wrap">' + renderGtTable(gr, cutoffs, units, isGrouped, gi, selectedGroups, showTotal) + '</div>' +
      '</div>' +
    '</div>';
  }

  $content.innerHTML = html;

  // Wire per-table copy buttons
  $content.querySelectorAll('[data-gt-copy]').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var idx = btn.dataset.gtCopy;
      var table = document.querySelector('#gtTableBody' + idx + ' .gt-table');
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

  // Wire chart export buttons
  $content.querySelectorAll('[data-gt-copysvg]').forEach(function(btn) {
    btn.addEventListener('click', function() { copyGtSvg(btn.dataset.gtCopysvg, btn); });
  });
  $content.querySelectorAll('[data-gt-png]').forEach(function(btn) {
    btn.addEventListener('click', function() { downloadGtPng(btn.dataset.gtPng, btn.dataset.colName); });
  });

  // Wire collapsible table headers \u2014 state in gtTableCollapsed (C6-0)
  $content.querySelectorAll('[data-gt-collapse]').forEach(function(hdr) {
    hdr.addEventListener('click', function() {
      var idx = hdr.dataset.gtCollapse;
      var colName = (lastGtData.gradeResults[idx] || {}).colName;
      var body = document.getElementById('gtTableBody' + idx);
      var toggle = hdr.querySelector('.gt-table-toggle');
      if (body.style.display === 'none') {
        body.style.display = '';
        toggle.textContent = '\u25BC';
        gtTableCollapsed.delete(colName);
      } else {
        body.style.display = 'none';
        toggle.textContent = '\u25B6';
        gtTableCollapsed.add(colName);
      }
    });
  });

  // Wire crosshairs for each chart
  for (var ci = 0; ci < gradeResults.length; ci++) {
    wireGtCrosshair(gradeResults[ci], cutoffs, unitsFor(gradeResults[ci].colIdx), ci);
  }
}

// ─── Theoretical GT from the aux samples ────────────────────────────────
// Change-of-support overlay: the sample distribution (weighted as the aux
// stats are — declustering/length weights included) corrected to block
// support and drawn against the model's actual GT curve. The variance
// reduction factor f = Var(blocks)/Var(samples) is USER INPUT — never
// derived from the model being validated (that would be circular).
// v0 engine: affine correction Z_v = m + √f·(Z − m). Honest about its
// crudeness (shape is preserved exactly); the DGM (Hermite) engine slots
// in here next.
var gtTheo = null;        // { byVar: {SRCNAME: dist}, fingerprint } — dist = sorted weighted distribution + prefix sums
var gtTheoLoading = false;
var gtTheoDsId = null;     // A10 G2: which comparison dataset supplies the theoretical (samples) distribution; null = the first one with a file

// The comparison dataset the theoretical curve is drawn from (any d2+, not just
// the singleton aux). Defaults to the first comparison dataset with a file.
function gtTheoSourceDs() {
  if (gtTheoDsId) { var d = dsById(gtTheoDsId); if (d && d.id !== 'model' && d.file) return d; }
  for (var i = 1; i < datasets.length; i++) { if (datasets[i].file) return datasets[i]; }
  return null;
}

function gtTheoFingerprintNow(srcNames) {
  var ds = gtTheoSourceDs();
  if (!ds || !ds.file || !ds.preflight) return null;
  return JSON.stringify({
    ds: ds.id,
    f: ds.file.name + '|' + ds.file.size,
    z: ds.preflight.selectedZipEntry || null,
    flt: ds.filter ? ds.filter.expression : '',
    cc: ds.calcolCode || '',
    w: catRole(ds.id, 'weight') || '',
    dw: catRole(ds.id, 'weight') === AUX_DECLUS_WEIGHT && ds.declus ? ds.declus.fingerprint : null,
    vars: srcNames.slice().sort()
  });
}

// Checked GT grade variables matched to the source dataset's numeric columns/
// calcols through the catalog grouping — the same grouping as Statistics/Swath
function gtTheoMatchedVars() {
  var ds = gtTheoSourceDs();
  if (!ds || !ds.preflight) return [];
  catEnsureSeeded();
  var srcNumeric = {};
  for (var i = 0; i < ds.preflight.header.length; i++) {
    if ((ds.preflight.autoTypes || [])[i] === 'numeric') srcNumeric[ds.preflight.header[i]] = true;
  }
  for (var ci = 0; ci < (ds.calcolMeta || []).length; ci++) {
    if (ds.calcolMeta[ci].type === 'numeric') srcNumeric[ds.calcolMeta[ci].name] = true;
  }
  var out = [];
  document.querySelectorAll('#gtVarList input[type="checkbox"]:checked').forEach(function(cb) {
    var colIdx = parseInt(cb.value);
    var colName = currentHeader[colIdx];
    if (!colName) return;
    var srcName = catGroupMembers(colName, ds.id).filter(function(n) { return srcNumeric[n]; })[0];
    if (srcName) out.push({ colIdx: colIdx, colName: colName, auxName: srcName });
  });
  return out;
}

function gtTheoSetStatus(msg, isErr) {
  var el = document.getElementById('gtTheoStatus');
  if (el) { el.textContent = msg || ''; el.style.color = isErr ? 'var(--red)' : ''; }
}

// A10 G2: a "from <dataset>" picker, shown only when 2+ comparison datasets have
// files (with one, the source is implicit — old behavior). Lets the theoretical
// curve be drawn from any comparison dataset, not just the singleton aux. The
// picker lives in a stable wrapper so it can be refreshed in place as datasets
// load/clear (the GT sidebar itself is built once, on the model analysis).
function gtTheoSourceInnerHtml() {
  var srcs = [];
  for (var i = 1; i < datasets.length; i++) { if (datasets[i].file) srcs.push(datasets[i]); }
  if (srcs.length < 2) return '';
  var cur = (gtTheoSourceDs() || {}).id;
  return '<div style="display:flex;gap:0.3rem;align-items:center;margin-top:0.3rem">' +
    '<span style="font-size:0.62rem;color:var(--fg-dim);white-space:nowrap">from</span>' +
    '<select class="gt-select" id="gtTheoSource" style="flex:1">' +
    srcs.map(function(d) { return '<option value="' + d.id + '"' + (d.id === cur ? ' selected' : '') + '>' + esc(dsLabel(d.id)) + '</option>'; }).join('') +
    '</select></div>';
}
function gtTheoSourceSelectHtml() { return '<div id="gtTheoSourceWrap">' + gtTheoSourceInnerHtml() + '</div>'; }

// Rebuild the source picker in place + (re)wire it — called when comparison
// datasets change so the picker reflects the current set without a full GT
// sidebar rebuild (which would drop the user's grade selections).
function refreshGtTheoSource() {
  var wrap = document.getElementById('gtTheoSourceWrap');
  if (!wrap) return;
  wrap.innerHTML = gtTheoSourceInnerHtml();
  var sel = document.getElementById('gtTheoSource');
  if (sel) sel.addEventListener('change', function() {
    gtTheoDsId = sel.value;
    gtTheo = null;
    if (gtTheoActive() && lastGtData) renderGtOutput();
    if (typeof autoSaveProject === 'function') autoSaveProject();
  });
}

// Sequential colvalues passes (one per matched variable) → weighted sorted
// distributions with prefix sums of w and w·v
function runGtTheoLoad() {
  if (gtTheoLoading) return;
  var ds = gtTheoSourceDs();
  var matched = gtTheoMatchedVars();
  if (!ds || !ds.file || matched.length === 0) {
    gtTheoSetStatus(ds && ds.file ? 'no checked grade variable has a match in ' + dsLabel(ds.id) : 'load a comparison dataset first', true);
    return;
  }
  // Weight resolution mirrors the source dataset's analyze pass
  var weightArray = null, weightCol = null;
  var theoWeight = catRole(ds.id, 'weight');
  if (theoWeight === AUX_DECLUS_WEIGHT) {
    if (typeof auxDeclusFresh === 'function' && auxDeclusFresh(ds) && ds.declus) weightArray = ds.declus.weights;
    else { gtTheoSetStatus('declustered weights missing or stale — re-run Declustering on ' + dsLabel(ds.id), true); return; }
  } else if (theoWeight) {
    weightCol = theoWeight;
  }

  gtTheoLoading = true;
  var byVar = {}, queue = matched.slice();
  var fp = gtTheoFingerprintNow(matched.map(function(v) { return v.auxName; }));

  function fail(msg) {
    gtTheoLoading = false;
    gtTheoSetStatus('Error: ' + msg, true);
  }
  function next() {
    if (queue.length === 0) {
      gtTheo = { byVar: byVar, fingerprint: fp };
      gtTheoLoading = false;
      var names = Object.keys(byVar);
      gtTheoSetStatus(names.map(function(nm) { return nm + ' (' + byVar[nm].values.length.toLocaleString() + ')'; }).join(' · '));
      if (lastGtData) renderGtOutput();
      return;
    }
    var v = queue.shift();
    gtTheoSetStatus('loading ' + v.auxName + '…');
    var w = new Worker(workerUrl);
    w.postMessage({
      mode: 'colvalues',
      file: ds.file,
      zipEntry: ds.preflight.selectedZipEntry || null,
      globalFilter: ds.filter ? { expression: ds.filter.expression } : null,
      calcolCode: ds.calcolCode || null,
      calcolMeta: (ds.calcolMeta && ds.calcolMeta.length > 0) ? ds.calcolMeta : null,
      resolvedTypes: ds.preflight.autoTypes,
      varColName: v.auxName,
      weightColName: weightCol,
      weightArray: weightArray,
      rowVarOverride: ds.rowVar,
      dmEndianness: ds.preflight.dmEndianness || null,
      dmFormat: ds.preflight.dmFormat || null
    });
    w.onerror = function(e) { w.terminate(); fail(e.message || 'unknown error'); };
    w.onmessage = function(e) {
      var m = e.data;
      if (m.type === 'error') { w.terminate(); fail(m.message); return; }
      if (m.type !== 'colvalues-complete') return;
      w.terminate();
      if (m.finite < 2) { fail('not enough numeric values for ' + v.auxName); return; }
      var nVals = m.values.length;
      var prefW = new Float64Array(nVals + 1), prefWV = new Float64Array(nVals + 1);
      for (var i = 0; i < nVals; i++) {
        var wi = m.weights ? m.weights[i] : 1;
        prefW[i + 1] = prefW[i] + wi;
        prefWV[i + 1] = prefWV[i] + wi * m.values[i];
      }
      byVar[v.auxName] = {
        values: m.values, weights: m.weights,
        prefW: prefW, prefWV: prefWV,
        W: prefW[nVals], WV: prefWV[nVals]
      };
      next();
    };
  }
  next();
}

// Affine theoretical GT at the model's cutoffs: tonnage FRACTION above
// cutoff and mean grade above, on the support-corrected distribution.
// Monotone transform ⇒ evaluate on raw values at x = m + (c−m)/√f.
function gtTheoCurve(dist, cutoffs, f) {
  var v = dist.values, n = v.length;
  var m = dist.WV / dist.W;
  var sf = Math.sqrt(Math.max(f, 1e-6));
  return cutoffs.map(function(c) {
    var x = m + (c - m) / sf;
    var lo = 0, hi = n;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (v[mid] <= x) lo = mid + 1; else hi = mid; }
    var wAbove = dist.W - dist.prefW[lo];
    if (!(wAbove > 0)) return { cutoff: c, tFrac: 0, grade: 0 };
    var meanAboveRaw = (dist.WV - dist.prefWV[lo]) / wAbove;
    return { cutoff: c, tFrac: wAbove / dist.W, grade: m + sf * (meanAboveRaw - m) };
  });
}

function gtTheoF() {
  var el = document.getElementById('gtTheoFNum');
  var f = el ? parseFloat(el.value) : 0.6;
  return isFinite(f) && f > 0 && f <= 1 ? f : 0.6;
}

function gtTheoActive() {
  var cb = document.getElementById('gtTheoEnabled');
  return !!(cb && cb.checked);
}

function interpolateGt(results, cutoff, binWidth, gradeMin) {
  var zero = { tonnage: 0, grade: 0, metal: 0 };
  if (!results || results.length === 0) return zero;
  if (!binWidth || !isFinite(binWidth)) return results[0] || zero;
  var idx = (cutoff - gradeMin) / binWidth;
  if (!isFinite(idx)) return results[0] || zero;
  // Clamp the index, not just the bin: cutoffs outside the histogram range
  // must not extrapolate (a cutoff below the data min includes everything)
  if (idx < 0) idx = 0;
  if (idx > results.length - 1) idx = results.length - 1;
  var lo = Math.floor(idx);
  var hi = lo + 1;
  if (hi >= results.length) hi = results.length - 1;
  if (lo === hi) return results[lo] || zero;
  var a = results[lo], b = results[hi];
  if (!a || !b) return a || b || zero;
  var frac = idx - lo;
  return {
    tonnage: a.tonnage + (b.tonnage - a.tonnage) * frac,
    grade: a.grade + (b.grade - a.grade) * frac,
    metal: a.metal + (b.metal - a.metal) * frac
  };
}

function renderGtChart(grData, cutoffs, units, isGrouped, chartIdx, selectedGroups, showTotal, theo) {
  var results = grData.results;
  if (!results || results.length === 0) return '<div class="gt-hint">No GT data available.</div>';
  // A8: zero total tonnage = no row contributed (empty column, everything
  // filtered) — say so instead of drawing an all-zero curve
  if (!(grData.totalTonnage > 0)) {
    return '<div class="gt-hint">No data for ' + esc(grData.colName || 'this variable') +
      ' — column empty or every value filtered out.</div>';
  }
  var binWidth = grData.binWidth;
  var gradeMin = grData.gradeMin;
  var totalTonnage = grData.totalTonnage;
  var td = units.tonnageDivisor || 1;
  var gf = units.gradeFactor || 1;
  var md = units.metalDivisor || td;
  var clipId = 'gt-clip-' + chartIdx;

  // Determine if we render grouped overlay
  var groupResults = isGrouped && grData.groupResults ? grData.groupResults : null;
  var allGroupNames = groupResults ? Object.keys(groupResults).sort() : [];
  // Filter to selected groups
  var groupNames = allGroupNames;
  if (groupResults && selectedGroups && selectedGroups.size > 0) {
    groupNames = allGroupNames.filter(function(n) { return selectedGroups.has(n); });
  } else if (groupResults && selectedGroups && selectedGroups.size === 0 && !showTotal) {
    groupNames = [];
  }

  // Sample curve at cutoffs (overall)
  var points = cutoffs.map(function(c) {
    var p = interpolateGt(results, c, binWidth, gradeMin);
    return { cutoff: c, tonnage: p.tonnage / td, grade: p.grade, metal: p.metal * gf / md };
  });

  var W = chartHostWidth(document.getElementById('gtContent'), 720, 560, 34), H = 380;
  var pad = { top: 30, right: 75, bottom: 50, left: 75 };
  var plotW = W - pad.left - pad.right;
  var plotH = H - pad.top - pad.bottom;

  // Tonnage range (left Y) — theoretical included so the overlay never clips
  var tMin = 0, tMax = Math.max.apply(null, points.map(function(p) { return p.tonnage; })) || 1;
  if (theo) tMax = Math.max(tMax, Math.max.apply(null, theo.points.map(function(p) { return p.tonnage; })) || 0);
  tMax += tMax * 0.05;

  // Grade range (right Y) — only from points with tonnage > 0
  var validGrades = points.filter(function(p) { return p.tonnage > 0; }).map(function(p) { return p.grade; });
  if (theo) validGrades = validGrades.concat(theo.points.filter(function(p) { return p.tonnage > 0; }).map(function(p) { return p.grade; }));
  if (validGrades.length === 0) validGrades = [0, 1];
  var gMin = Math.min.apply(null, validGrades);
  var gMax = Math.max.apply(null, validGrades);
  if (gMin === gMax) { gMin -= 0.5; gMax += 0.5; }
  var gPadding = (gMax - gMin) * 0.05;
  gMin -= gPadding; gMax += gPadding;
  if (gMin < 0) gMin = 0;

  // X range
  var xMin = cutoffs[0], xMax = cutoffs[cutoffs.length - 1];
  var xRange = xMax - xMin || 1;

  var sx = function(v) { return pad.left + ((v - xMin) / xRange) * plotW; };
  var syT = function(v) { return pad.top + ((tMax - v) / (tMax - tMin)) * plotH; };
  var syG = function(v) { return pad.top + ((gMax - v) / (gMax - gMin)) * plotH; };

  // Grid
  var svg = '';
  var nxTicks = Math.min(10, cutoffs.length);
  for (var i = 0; i <= nxTicks; i++) {
    var v = xMin + (xRange * i / nxTicks);
    var x = sx(v);
    svg += '<line x1="' + x.toFixed(1) + '" y1="' + pad.top + '" x2="' + x.toFixed(1) + '" y2="' + (H - pad.bottom) + '" stroke="var(--chart-grid)" stroke-width="1"/>';
    svg += '<text x="' + x.toFixed(1) + '" y="' + (H - pad.bottom + 14) + '" text-anchor="middle" fill="var(--chart-ink)" font-size="9">' + gtFmt(v, units.gradeDp) + '</text>';
  }
  var nyTicks = 6;
  for (var j = 0; j <= nyTicks; j++) {
    var tv = tMin + ((tMax - tMin) * j / nyTicks);
    var y = syT(tv);
    svg += '<line x1="' + pad.left + '" y1="' + y.toFixed(1) + '" x2="' + (W - pad.right) + '" y2="' + y.toFixed(1) + '" stroke="var(--chart-grid)" stroke-width="1"/>';
    svg += '<text x="' + (pad.left - 6) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end" fill="var(--action)" font-size="9">' + gtFmt(tv, units.tonnageDp) + '</text>';
    var gv = gMin + ((gMax - gMin) * j / nyTicks);
    svg += '<text x="' + (W - pad.right + 6) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="start" fill="var(--blue)" font-size="9">' + gtFmt(gv, units.gradeDp) + '</text>';
  }

  // Clip path
  svg += '<defs><clipPath id="' + clipId + '"><rect x="' + pad.left + '" y="' + pad.top + '" width="' + plotW + '" height="' + plotH + '"/></clipPath></defs>';
  svg += '<g clip-path="url(#' + clipId + ')">';

  if (groupNames.length > 0 || (isGrouped && showTotal)) {
    // "Total" line from overall results
    if (showTotal) {
      var tTotalP = '';
      var gTotalP = '';
      for (var ti = 0; ti < points.length; ti++) {
        tTotalP += (ti === 0 ? 'M' : 'L') + sx(points[ti].cutoff).toFixed(1) + ',' + syT(points[ti].tonnage).toFixed(1);
        if (points[ti].tonnage > 0) {
          gTotalP += (gTotalP ? 'L' : 'M') + sx(points[ti].cutoff).toFixed(1) + ',' + syG(points[ti].grade).toFixed(1);
        }
      }
      svg += '<path d="' + tTotalP + '" fill="none" stroke="var(--action)" stroke-width="2.5" opacity="0.7"/>';
      if (gTotalP) svg += '<path d="' + gTotalP + '" fill="none" stroke="var(--blue)" stroke-width="2" stroke-dasharray="4,3" opacity="0.7"/>';
    }
    // Grouped overlay: draw tonnage + grade per group with colors
    for (var gi = 0; gi < groupNames.length; gi++) {
      var gn = groupNames[gi];
      var grd = groupResults[gn];
      var colorIdx = allGroupNames.indexOf(gn);
      var color = getCategoryColor(lastGtData.groupByColName || '', gn, colorIdx >= 0 ? colorIdx : gi);
      var grpPts = cutoffs.map(function(c) {
        var p = interpolateGt(grd.results, c, binWidth, gradeMin);
        return { cutoff: c, tonnage: p.tonnage / td, grade: p.grade };
      });
      // Tonnage line (solid)
      var tP = '';
      for (var k = 0; k < grpPts.length; k++) {
        tP += (k === 0 ? 'M' : 'L') + sx(grpPts[k].cutoff).toFixed(1) + ',' + syT(grpPts[k].tonnage).toFixed(1);
      }
      svg += '<path d="' + tP + '" fill="none" stroke="' + color + '" stroke-width="1.5"/>';
      // Grade line (dashed) — clip where tonnage is 0
      var gP = '';
      for (var l = 0; l < grpPts.length; l++) {
        if (grpPts[l].tonnage > 0) {
          gP += (gP ? 'L' : 'M') + sx(grpPts[l].cutoff).toFixed(1) + ',' + syG(grpPts[l].grade).toFixed(1);
        }
      }
      if (gP) svg += '<path d="' + gP + '" fill="none" stroke="' + color + '" stroke-width="1" stroke-dasharray="4,3"/>';
    }
  } else {
    // Ungrouped: standard tonnage + grade + metal lines
    var tPath = '';
    for (var k = 0; k < points.length; k++) {
      tPath += (k === 0 ? 'M' : 'L') + sx(points[k].cutoff).toFixed(1) + ',' + syT(points[k].tonnage).toFixed(1);
    }
    svg += '<path d="' + tPath + '" fill="none" stroke="var(--action)" stroke-width="2"/>';

    var gPath = '';
    for (var l = 0; l < points.length; l++) {
      if (points[l].tonnage > 0) {
        gPath += (gPath ? 'L' : 'M') + sx(points[l].cutoff).toFixed(1) + ',' + syG(points[l].grade).toFixed(1);
      }
    }
    if (gPath) svg += '<path d="' + gPath + '" fill="none" stroke="var(--blue)" stroke-width="2"/>';

    var mMax = Math.max.apply(null, points.map(function(p) { return p.metal; })) || 1;
    var syM = function(v) { return pad.top + ((mMax - v) / mMax) * plotH; };
    var mPath = '';
    for (var n = 0; n < points.length; n++) {
      mPath += (n === 0 ? 'M' : 'L') + sx(points[n].cutoff).toFixed(1) + ',' + syM(points[n].metal).toFixed(1);
    }
    svg += '<path d="' + mPath + '" fill="none" stroke="var(--green)" stroke-width="1.5" stroke-dasharray="4,3"/>';

    // Theoretical GT (samples at block support, scaled to model total tonnage)
    if (theo) {
      var thT = '', thG = '';
      for (var th = 0; th < theo.points.length; th++) {
        var tp = theo.points[th];
        thT += (th === 0 ? 'M' : 'L') + sx(tp.cutoff).toFixed(1) + ',' + syT(tp.tonnage).toFixed(1);
        if (tp.tonnage > 0) thG += (thG ? 'L' : 'M') + sx(tp.cutoff).toFixed(1) + ',' + syG(tp.grade).toFixed(1);
      }
      svg += '<path d="' + thT + '" fill="none" stroke="var(--action)" stroke-width="1.3" stroke-dasharray="7,4" opacity="0.9"/>';
      if (thG) svg += '<path d="' + thG + '" fill="none" stroke="var(--blue)" stroke-width="1.3" stroke-dasharray="7,4" opacity="0.9"/>';
    }
  }

  svg += '</g>'; // close clip group

  // Axis labels
  svg += '<text x="' + (W / 2) + '" y="' + (H - 6) + '" text-anchor="middle" fill="var(--chart-ink)" font-size="10">Cutoff' + (units.gradeSymbol ? ' (' + esc(units.gradeSymbol) + ')' : '') + '</text>';
  svg += '<text x="12" y="' + (H / 2) + '" text-anchor="middle" fill="var(--action)" font-size="10" transform="rotate(-90, 12, ' + (H / 2) + ')">Tonnage (' + esc(units.tonnageSymbol) + ')</text>';
  svg += '<text x="' + (W - 8) + '" y="' + (H / 2) + '" text-anchor="middle" fill="var(--blue)" font-size="10" transform="rotate(90, ' + (W - 8) + ', ' + (H / 2) + ')">Grade' + (units.gradeSymbol ? ' (' + esc(units.gradeSymbol) + ')' : '') + '</text>';

  // Legend
  if (groupNames.length > 0 || (isGrouped && showTotal)) {
    var legY = pad.top + 6;
    if (showTotal) {
      svg += '<rect x="' + (pad.left + 10) + '" y="' + legY + '" width="10" height="3" fill="var(--action)" rx="1" opacity="0.7"/>';
      svg += '<text x="' + (pad.left + 24) + '" y="' + (legY + 4) + '" fill="var(--action)" font-size="7">Total</text>';
      legY += 11;
    }
    for (var gi = 0; gi < Math.min(groupNames.length, 15); gi++) {
      var gn = groupNames[gi];
      var colorIdx = allGroupNames.indexOf(gn);
      var color = getCategoryColor(lastGtData.groupByColName || '', gn, colorIdx >= 0 ? colorIdx : gi);
      svg += '<rect x="' + (pad.left + 10) + '" y="' + legY + '" width="10" height="3" fill="' + color + '" rx="1"/>';
      svg += '<text x="' + (pad.left + 24) + '" y="' + (legY + 4) + '" fill="' + color + '" font-size="7">' + esc(gn) + '</text>';
      legY += 11;
    }
    if (groupNames.length > 15) {
      svg += '<text x="' + (pad.left + 24) + '" y="' + (legY + 4) + '" fill="var(--fg-dim)" font-size="7">+' + (groupNames.length - 15) + ' more</text>';
    }
  } else {
    svg += '<rect x="' + (pad.left + 10) + '" y="' + (pad.top + 6) + '" width="10" height="3" fill="var(--action)" rx="1"/>';
    svg += '<text x="' + (pad.left + 24) + '" y="' + (pad.top + 10) + '" fill="var(--action)" font-size="8">Tonnage</text>';
    svg += '<rect x="' + (pad.left + 10) + '" y="' + (pad.top + 18) + '" width="10" height="3" fill="var(--blue)" rx="1"/>';
    svg += '<text x="' + (pad.left + 24) + '" y="' + (pad.top + 22) + '" fill="var(--blue)" font-size="8">Grade</text>';
    svg += '<line x1="' + (pad.left + 10) + '" y1="' + (pad.top + 31.5) + '" x2="' + (pad.left + 20) + '" y2="' + (pad.top + 31.5) + '" stroke="var(--green)" stroke-width="1.5" stroke-dasharray="3,2"/>';
    svg += '<text x="' + (pad.left + 24) + '" y="' + (pad.top + 34) + '" fill="var(--green)" font-size="8">Metal (' + esc(units.metalSymbol) + ')</text>';
    if (theo) {
      svg += '<line x1="' + (pad.left + 10) + '" y1="' + (pad.top + 43.5) + '" x2="' + (pad.left + 20) + '" y2="' + (pad.top + 43.5) + '" stroke="var(--action)" stroke-width="1.3" stroke-dasharray="5,3"/>';
      svg += '<line x1="' + (pad.left + 10) + '" y1="' + (pad.top + 47.5) + '" x2="' + (pad.left + 20) + '" y2="' + (pad.top + 47.5) + '" stroke="var(--blue)" stroke-width="1.3" stroke-dasharray="5,3"/>';
      svg += '<text x="' + (pad.left + 24) + '" y="' + (pad.top + 48) + '" fill="var(--fg-dim)" font-size="8">Theoretical (samples, affine f=' + theo.f.toFixed(2) + ', scaled to model total)</text>';
    }
  }

  // Crosshair overlay area
  svg += '<rect class="gt-crosshair-area" x="' + pad.left + '" y="' + pad.top + '" width="' + plotW + '" height="' + plotH + '" fill="transparent"/>';
  svg += '<line class="gt-crosshair-line" x1="0" y1="' + pad.top + '" x2="0" y2="' + (H - pad.bottom) + '" stroke="var(--fg-dim)" stroke-width="1" opacity="0" stroke-dasharray="3,3"/>';
  svg += '<g class="gt-crosshair-tooltip" opacity="0"><rect class="gt-tt-bg" rx="3" ry="3"/><text class="gt-tt-text" font-size="9"></text></g>';

  // Variable title inside the SVG, so copied/downloaded charts identify themselves
  var chartTitle = esc(grData.colName || '') +
    (units.gradeSymbol ? ' (' + esc(units.gradeSymbol) + ')' : '') + ' — Grade-Tonnage';

  return '<svg class="gt-svg" data-chart-idx="' + chartIdx + '" viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" style="font-family:var(--mono);width:100%;height:auto" ' +
    'data-pad-left="' + pad.left + '" data-pad-right="' + pad.right + '" data-pad-top="' + pad.top + '" data-pad-bottom="' + pad.bottom + '" ' +
    'data-w="' + W + '" data-h="' + H + '" data-xmin="' + xMin + '" data-xmax="' + xMax + '">' +
    '<rect width="' + W + '" height="' + H + '" fill="var(--bg)" rx="4"/>' +
    '<text x="' + (W / 2) + '" y="17" text-anchor="middle" fill="var(--chart-ink)" font-size="11" font-weight="600">' + chartTitle + '</text>' +
    svg +
    '</svg>';
}

function copyGtSvg(chartIdx, btn) {
  var svgEl = document.querySelector('.gt-svg[data-chart-idx="' + chartIdx + '"]');
  if (!svgEl) return;
  navigator.clipboard.writeText(svgEl.outerHTML).then(function() {
    btn.textContent = 'Copied!';
    setTimeout(function() { btn.textContent = 'Copy SVG'; }, 1500);
  });
}

function downloadGtPng(chartIdx, colName) {
  var svgEl = document.querySelector('.gt-svg[data-chart-idx="' + chartIdx + '"]');
  if (!svgEl) return;
  var clone = svgEl.cloneNode(true);
  var area = clone.querySelector('.gt-crosshair-area');
  var crossLine = clone.querySelector('.gt-crosshair-line');
  var ttGroup = clone.querySelector('.gt-crosshair-tooltip');
  if (area) area.remove();
  if (crossLine) crossLine.remove();
  if (ttGroup) ttGroup.remove();
  var svgData = new XMLSerializer().serializeToString(clone);
  // Resolve series colors from the live theme, retheme neutrals for light bg
  var cs = getComputedStyle(document.documentElement);
  function cssVar(name, fallback) { var v = cs.getPropertyValue(name).trim(); return v || fallback; }
  svgData = svgData.replace(/var\(--action\)/g, cssVar('--action', '#b54e1a'));
  svgData = svgData.replace(/var\(--blue\)/g, cssVar('--blue', '#2563eb'));
  svgData = svgData.replace(/var\(--green\)/g, cssVar('--green', '#1a7a52'));
  svgData = svgData.replace(/fill="var\(--bg\)"/g, 'fill="white"');
  svgData = svgData.replace(/var\(--bg1\)/g, '#f5f5f5');
  svgData = svgData.replace(/var\(--fg-dim\)/g, '#555');
  svgData = svgData.replace(/var\(--fg\)/g, '#333');
  svgData = svgData.replace(/var\(--border\)/g, '#ddd');
  svgData = svgData.replace(/fill="var(--chart-ink)"/g, 'fill="#555"');
  svgData = svgData.replace(/stroke="var(--chart-grid)"/g, 'stroke="#ddd"');
  svgData = svgData.replace(/style="font-family:var\(--mono\)[^"]*"/g, 'style="font-family:monospace"');
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
      a.download = 'gt_' + (colName || 'plot').replace(/[^\p{L}\p{N}_-]+/gu, '_') + '.png';
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  };
  img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
}

function wireGtCrosshair(grData, cutoffs, units, chartIdx) {
  var svgEl = document.querySelector('.gt-svg[data-chart-idx="' + chartIdx + '"]');
  if (!svgEl) return;
  var area = svgEl.querySelector('.gt-crosshair-area');
  var line = svgEl.querySelector('.gt-crosshair-line');
  var ttGroup = svgEl.querySelector('.gt-crosshair-tooltip');
  var ttBg = svgEl.querySelector('.gt-tt-bg');
  var ttText = svgEl.querySelector('.gt-tt-text');
  if (!area || !line || !ttGroup) return;

  var padLeft = parseFloat(svgEl.dataset.padLeft);
  var W = parseFloat(svgEl.dataset.w);
  var xMin = parseFloat(svgEl.dataset.xmin);
  var xMax = parseFloat(svgEl.dataset.xmax);
  var padRight = parseFloat(svgEl.dataset.padRight);
  var plotW = W - padLeft - padRight;

  function onMove(e) {
    var pt = svgEl.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    var svgX = pt.matrixTransform(svgEl.getScreenCTM().inverse()).x;
    var cutoff = xMin + ((svgX - padLeft) / plotW) * (xMax - xMin);
    if (cutoff < xMin) cutoff = xMin;
    if (cutoff > xMax) cutoff = xMax;

    var p = interpolateGt(grData.results, cutoff, grData.binWidth, grData.gradeMin);
    var td = units.tonnageDivisor;
    var gf = units.gradeFactor;
    var md = units.metalDivisor || td;
    var tonnage = p.tonnage / td;
    var grade = p.grade;
    var metal = p.metal * gf / md;
    var pctTotal = grData.totalTonnage > 0 ? (p.tonnage / grData.totalTonnage * 100) : 0;

    line.setAttribute('x1', svgX.toFixed(1));
    line.setAttribute('x2', svgX.toFixed(1));
    line.setAttribute('opacity', '1');

    var lines = [
      'Cutoff: ' + gtFmt(cutoff, units.gradeDp),
      'Tonnage: ' + gtFmt(tonnage, units.tonnageDp) + ' ' + units.tonnageSymbol,
      'Grade: ' + gtFmt(grade, units.gradeDp) + (units.gradeSymbol ? ' ' + units.gradeSymbol : ''),
      'Metal: ' + gtFmt(metal, units.metalDp) + ' ' + units.metalSymbol,
      '% Total: ' + pctTotal.toFixed(1) + '%'
    ];

    var lineH = 13;
    var ttW = 140;
    var ttH = lines.length * lineH + 8;
    var tx = svgX + 10;
    var ty = 40;
    if (tx + ttW > W - 10) tx = svgX - ttW - 10;

    ttBg.setAttribute('x', tx);
    ttBg.setAttribute('y', ty);
    ttBg.setAttribute('width', ttW);
    ttBg.setAttribute('height', ttH);
    ttBg.setAttribute('fill', 'var(--bg1)');
    ttBg.setAttribute('stroke', 'var(--border)');

    var textHtml = '';
    for (var i = 0; i < lines.length; i++) {
      textHtml += '<tspan x="' + (tx + 6) + '" dy="' + (i === 0 ? (ty + lineH) : lineH) + '" fill="var(--fg)">' + esc(lines[i]) + '</tspan>';
    }
    ttText.innerHTML = textHtml;
    ttGroup.setAttribute('opacity', '1');
  }

  function onLeave() {
    line.setAttribute('opacity', '0');
    ttGroup.setAttribute('opacity', '0');
  }

  area.addEventListener('pointermove', onMove);
  area.addEventListener('pointerleave', onLeave);
}

function renderGtTable(grData, cutoffs, units, isGrouped, tableIdx, selectedGroups, showTotal) {
  var results = grData.results;
  var binWidth = grData.binWidth;
  var gradeMin = grData.gradeMin;
  var totalTonnage = grData.totalTonnage;
  var td = units.tonnageDivisor;
  var gf = units.gradeFactor;
  var md = units.metalDivisor || td;
  var groupResults = isGrouped && grData.groupResults ? grData.groupResults : null;
  var allGroupNames = groupResults ? Object.keys(groupResults).sort() : [];
  var groupNames = allGroupNames;
  if (groupResults && selectedGroups && selectedGroups.size > 0) {
    groupNames = allGroupNames.filter(function(n) { return selectedGroups.has(n); });
  } else if (groupResults && selectedGroups && selectedGroups.size === 0 && !showTotal) {
    groupNames = [];
  }

  var hasGroupCol = groupNames.length > 0 || (isGrouped && showTotal);
  var gradeLabel = 'Grade' + (units.gradeSymbol ? ' (' + esc(units.gradeSymbol) + ')' : '');
  var html = '<table class="gt-table" id="gtResultTable' + tableIdx + '">';
  html += '<thead><tr>';
  if (hasGroupCol) html += '<th>Group</th>';
  html += '<th>Cutoff' + (units.gradeSymbol ? ' (' + esc(units.gradeSymbol) + ')' : '') + '</th>';
  html += '<th>Tonnage (' + esc(units.tonnageSymbol) + ')</th>';
  html += '<th>' + gradeLabel + '</th>';
  html += '<th>Metal (' + esc(units.metalSymbol) + ')</th>';
  html += '<th>% Total</th>';
  html += '</tr></thead><tbody>';

  if (hasGroupCol) {
    // "Total" block first if requested
    if (showTotal) {
      for (var ti = 0; ti < cutoffs.length; ti++) {
        var c = cutoffs[ti];
        var p = interpolateGt(results, c, binWidth, gradeMin);
        var tonnage = p.tonnage / td;
        var grade = p.grade;
        var metal = p.metal * gf / md;
        var pctTotal = totalTonnage > 0 ? (p.tonnage / totalTonnage * 100) : 0;
        html += '<tr>';
        if (ti === 0) html += '<td rowspan="' + cutoffs.length + '" style="color:var(--fg-bright);font-weight:600">Total</td>';
        html += '<td>' + gtFmt(c, units.gradeDp) + '</td>';
        html += '<td>' + gtFmt(tonnage, units.tonnageDp) + '</td>';
        html += '<td>' + gtFmt(grade, units.gradeDp) + '</td>';
        html += '<td>' + gtFmt(metal, units.metalDp) + '</td>';
        html += '<td>' + pctTotal.toFixed(1) + '%</td>';
        html += '</tr>';
      }
    }
    // Grouped table: rows grouped by group value then cutoff
    for (var gi = 0; gi < groupNames.length; gi++) {
      var gn = groupNames[gi];
      var grd = groupResults[gn];
      for (var ci = 0; ci < cutoffs.length; ci++) {
        var c = cutoffs[ci];
        var p = interpolateGt(grd.results, c, binWidth, gradeMin);
        var tonnage = p.tonnage / td;
        var grade = p.grade;
        var metal = p.metal * gf / md;
        var pctTotal = grd.totalTonnage > 0 ? (p.tonnage / grd.totalTonnage * 100) : 0;
        html += '<tr>';
        if (ci === 0) html += '<td rowspan="' + cutoffs.length + '">' + esc(gn) + '</td>';
        html += '<td>' + gtFmt(c, units.gradeDp) + '</td>';
        html += '<td>' + gtFmt(tonnage, units.tonnageDp) + '</td>';
        html += '<td>' + gtFmt(grade, units.gradeDp) + '</td>';
        html += '<td>' + gtFmt(metal, units.metalDp) + '</td>';
        html += '<td>' + pctTotal.toFixed(1) + '%</td>';
        html += '</tr>';
      }
    }
  } else {
    // Ungrouped table
    for (var i = 0; i < cutoffs.length; i++) {
      var c = cutoffs[i];
      var p = interpolateGt(results, c, binWidth, gradeMin);
      var tonnage = p.tonnage / td;
      var grade = p.grade;
      var metal = p.metal * gf / md;
      var pctTotal = totalTonnage > 0 ? (p.tonnage / totalTonnage * 100) : 0;
      html += '<tr>';
      html += '<td>' + gtFmt(c, units.gradeDp) + '</td>';
      html += '<td>' + gtFmt(tonnage, units.tonnageDp) + '</td>';
      html += '<td>' + gtFmt(grade, units.gradeDp) + '</td>';
      html += '<td>' + gtFmt(metal, units.metalDp) + '</td>';
      html += '<td>' + pctTotal.toFixed(1) + '%</td>';
      html += '</tr>';
    }
  }
  html += '</tbody></table>';
  return html;
}

function resetGtState() {
  lastGtData = null;
  if (gtWorker) { gtWorker.terminate(); gtWorker = null; }
  if (gtExprController) { gtExprController.destroy(); gtExprController = null; }
}
