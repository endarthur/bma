// ─── Main App ──────────────────────────────────────────────────────────
const workerBlob = new Blob([WORKER_CODE], { type: 'application/javascript' });
const workerUrl = URL.createObjectURL(workerBlob);

let currentFile = null;
let currentHeader = [];
let currentColTypes = [];
let currentXYZ = { x: -1, y: -1, z: -1 };
let detectedXYZ = { x: -1, y: -1, z: -1 };
let currentFilter = null; // { expression: string }
let currentRowVar = 'r';
let worker = null;
let preflightData = null; // { header, sampleRows, autoTypes, delimiter, zipEntries, selectedZipEntry }

// ─── Aux dataset state (compare block model vs source samples/composites) ──
let auxFile = null;            // the loaded auxiliary File
let auxHandle = null;          // FSAA handle for re-open (if available)
let auxPreflightData = null;   // runPreflight() result for the aux file (header, xyz, types, sampleRows)
let auxCompleteData = null;    // snapshot of the last aux analysis (parallel to lastCompleteData)
let auxData = null;            // aux stats object for comparison rendering
let auxPrefix = 'aux';         // display-only label prefix for aux pseudo-columns (e.g. "aux:Fe")
let auxFilter = null;          // { expression } — references aux columns via the fixed AUX_ROW_VAR handle
let auxWorker = null;          // worker handle for the aux analysis pass
let pendingAuxRestore = null;  // aux config from a loaded project, applied once the aux file is (re)loaded
const AUX_ROW_VAR = 'aux';     // fixed code handle for aux filter/calc expressions (NOT the display prefix)
let auxStale = false;              // aux config changed since last aux analysis
let auxCalcolCode = '';            // calculated-columns code block for the aux dataset (uses aux.)
let auxCalcolMeta = [];            // [{name, type}] detected from aux calcol simulation
let calcolMode = 'primary';        // which dataset the Calc editor is editing: 'primary' | 'aux'
let projectTitle = null;           // optional project title (pack dialog) — display + archive naming
let statsCdfMode = 'cdf';          // CDF panel mode: 'cdf' | 'qq'
let currentWeightName = null;      // weight column (by name, raw or calcol) for the primary analysis
let auxWeightName = null;          // weight column (by name) for the aux passes — set on the Aux tab
let statsAuxSelected = null;       // Set of aux col indices shown in the stats table (null = defaults)
let statsCdfAuxSelected = new Set(); // aux col indices with CDF curves
let pendingStatsAuxRestore = null;   // { selected: [names], cdf: [names] } applied when aux analysis completes

var HAS_FSAA = typeof window.showOpenFilePicker === 'function';

// Fuzzy subsequence match — returns true if all chars in query appear in order within target.
// Both should be lowercase. Empty query matches everything.
function fuzzyMatch(query, target) {
  if (!query) return true;
  var qi = 0;
  for (var ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) qi++;
  }
  return qi === query.length;
}

// Wire keyboard shortcuts on a search input: Esc=clear, Alt+A=all, Alt+Shift+A=none
function wireSearchShortcuts(input, allBtn, noneBtn) {
  if (!input) return;
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (input.value) {
        input.value = '';
        input.dispatchEvent(new Event('input'));
      } else {
        input.blur();
      }
    } else if (e.altKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      if (e.shiftKey) { if (noneBtn) noneBtn.click(); }
      else { if (allBtn) allBtn.click(); }
    }
  });
}

const $dropzone = document.getElementById('dropzone');
const $fileInput = document.getElementById('fileInput');
const $recentFiles = document.getElementById('recentFiles');
const $panelPreflight = document.getElementById('panelPreflight');
const $preflightZip = document.getElementById('preflightZip');
const $preflightHead = document.getElementById('preflightHead');
const $preflightPreview = document.getElementById('preflightPreview');
const $results = document.getElementById('results');
const $fileInfo = document.getElementById('fileInfo');
const $geoContent = document.getElementById('geoContent');
const $geoBadge = document.getElementById('geoBadge');
const $geoSection = document.getElementById('geoSection');
const $xyzConfig = document.getElementById('xyzConfig');
const $statsContent = document.getElementById('statsContent');
const $statsBadge = document.getElementById('statsBadge');
const $statsBody = document.getElementById('statsBody');
const $statsSidebar = document.getElementById('statsSidebar');
const $statsMain = document.getElementById('statsMain');
const $statsCdfPanel = document.getElementById('statsCdfPanel');
const $catBadge = document.getElementById('catBadge');
const $catBody = document.getElementById('catBody');
const $catSidebar = document.getElementById('catSidebar');
const $catColList = document.getElementById('catColList');
const $catColSearch = document.getElementById('catColSearch');
const $catMain = document.getElementById('catMain');
const $catToolbar = document.getElementById('catToolbar');
const $catMainContent = document.getElementById('catMainContent');
const $catChart = document.getElementById('catChart');
const $catValueTableWrap = document.getElementById('catValueTableWrap');
const $catValueSearch = document.getElementById('catValueSearch');
const $catValueTable = document.getElementById('catValueTable');
const $catColorPicker = document.getElementById('catColorPicker');
const $appFooter = document.getElementById('appFooter');
const $filterSection = document.getElementById('filterSection');
const $filterExpr = document.getElementById('filterExpr');
const $filterApply = document.getElementById('filterApply');
const $filterClear = document.getElementById('filterClear');
const $filterError = document.getElementById('filterError');
const $errorMsg = document.getElementById('errorMsg');
const $resultsToolbar = document.getElementById('resultsToolbar');
const $resultsFilename = document.getElementById('resultsFilename');
const $resultsRowInfo = document.getElementById('resultsRowInfo');
const $resultsTimeInfo = document.getElementById('resultsTimeInfo');
const $resultsMemInfo = document.getElementById('resultsMemInfo');
const $backToPreflight = document.getElementById('backToPreflight');
const $projectSave = document.getElementById('projectSave');
const $projectLoad = document.getElementById('projectLoad');
const $projectClear = document.getElementById('projectClear');
const $projectFileInput = document.getElementById('projectFileInput');
const $toolbarOverflow = document.getElementById('toolbarOverflow');
const $toolbarMenu = document.getElementById('toolbarMenu');
const $cdfModal = document.getElementById('cdfModal');
const $cdfTitle = document.getElementById('cdfTitle');
const $cdfBody = document.getElementById('cdfBody');
const $cdfClose = document.getElementById('cdfClose');
const $settingsModal = document.getElementById('settingsModal');
const $settingsClose = document.getElementById('settingsClose');
const $settingsBtn = document.getElementById('settingsBtn');
const $resultsTabs = document.getElementById('resultsTabs');
const $statsCatContent = document.getElementById('statsCatContent');
const $statsCatBadge = document.getElementById('statsCatBadge');
const $statsCatGroupBy = document.getElementById('statsCatGroupBy');
const $statsCatVarList = document.getElementById('statsCatVarList');
const $statsCatGroupList = document.getElementById('statsCatGroupList');
const $statsCatVarSearch = document.getElementById('statsCatVarSearch');
const $statsCatGroupSearch = document.getElementById('statsCatGroupSearch');
const $statsCatGroupAll = document.getElementById('statsCatGroupAll');
const $statsCatGroupNone = document.getElementById('statsCatGroupNone');
const $statsCatGroupSort = document.getElementById('statsCatGroupSort');
const $statsCatVarAll = document.getElementById('statsCatVarAll');
const $statsCatVarNone = document.getElementById('statsCatVarNone');
const $statsCatVarFilter = document.getElementById('statsCatVarFilter');
let lastDisplayedStats = null;
let lastDisplayedHeader = null;
let currentCalcolCode = '';
let currentCalcolMeta = []; // [{name, type}]
let currentOrigColCount = 0;
let lastCompleteData = null; // snapshot for cancel
let currentGroupBy = null; // column index for StatsCat grouping
let currentStatsCatVar = null; // selected numeric column index
let currentStatsCatChecked = null; // Set<string> of checked group values (null = all)
let lastStatsCatData = null; // cached full data for re-render
let statsCatGroupSortMode = null; // null = inherit from Categories tab, or 'count-desc'|'count-asc'|'alpha'|'custom'
let statsCatSelectedVars = new Set(); // col indices selected for group stats analysis
let statsCatCdfScale = 'linear'; // 'linear' or 'log'
let statsCatCdfManual = false;
let statsCatCdfMin = null;
let statsCatCdfMax = null;
let statsCatCrossMode = 'count'; // 'count', 'row', 'col'
let statsCatShowSelectedOnly = false;

// Categories tab state
let catFocusedCol = null;           // column index focused in main area
let catSortModes = {};              // { colName: 'count-desc'|'count-asc'|'alpha'|'custom' }
let catCustomOrders = {};           // { colName: [val1, val2, ...] }
let catColorOverrides = {};         // { colName: { value: '#hex' } }
let catChartShowAll = false;        // show all bars vs top 20
let _catEventsWired = false;

function getCategoryColor(colName, value, fallbackIdx) {
  if (catColorOverrides[colName] && catColorOverrides[colName][value])
    return catColorOverrides[colName][value];
  return STATSCAT_PALETTE[(fallbackIdx || 0) % STATSCAT_PALETTE.length];
}

// Statistics tab state
let statsSelectedVars = null;     // Set<colIdx> or null (= all)
let statsVisibleMetrics = null;   // Set<string> or null (= all)
let statsPercentiles = [25, 50, 75]; // current percentile list
let statsCdfSelected = new Set(); // Set<colIdx> toggled for CDF overlay
let statsCdfScale = 'linear';     // 'linear' | 'log'

// Export
let exportWorker = null;
let exportColumns = []; // [{name, outputName, type, selected, isCalcol}]
let exportDelimiter = ',';
let exportIncludeHeader = true;
let exportCommentHeader = false;
let exportCommentText = '';
let exportQuoteChar = '"';       // '"', "'", '' (none)
let exportLineEnding = '\n';     // '\n' or '\r\n'
let exportNullValue = '';        // string to write for NaN/null
let exportPrecision = null;      // null = auto (passthrough), or integer (decimal places)
let exportDecimalSep = '.';      // '.' or ','
let exportSourcePrecision = {};  // {colName: maxDp} detected from preflight
const $exportColList = document.getElementById('exportColList');
const $exportBadge = document.getElementById('exportBadge');
const $exportDownload = document.getElementById('exportDownload');
const $exportInfo = document.getElementById('exportInfo');
const $exportProgress = document.getElementById('exportProgress');
const $exportProgressLabel = document.getElementById('exportProgressLabel');
const $exportProgressFill = document.getElementById('exportProgressFill');
const $exportColSearch = document.getElementById('exportColSearch');
const $exportBody = document.getElementById('exportBody');
const $exportToolbar = document.getElementById('exportToolbar');
const $exportRowPreview = document.getElementById('exportRowPreview');
const $exportIncludeHeader = document.getElementById('exportIncludeHeader');
const $exportCommentHeader = document.getElementById('exportCommentHeader');
const $exportCommentSection = document.getElementById('exportCommentSection');
const $exportCommentText = document.getElementById('exportCommentText');
const $exportCommentGenerate = document.getElementById('exportCommentGenerate');
const $exportCustomDelim = document.getElementById('exportCustomDelim');
const $exportFormatSection = document.getElementById('exportFormatSection');
const $exportPreview = document.getElementById('exportPreview');
const $exportPreviewPre = document.getElementById('exportPreviewPre');
const $exportPreviewInfo = document.getElementById('exportPreviewInfo');
const $exportPrecisionSelect = document.getElementById('exportPrecisionSelect');
const $exportPrecisionInput = document.getElementById('exportPrecisionInput');
const $exportNullSelect = document.getElementById('exportNullSelect');
const $exportNullInput = document.getElementById('exportNullInput');
const $exportPrecisionWarn = document.getElementById('exportPrecisionWarn');

// DXYZ state
let currentDXYZ = { dx: -1, dy: -1, dz: -1 };

// Swath state
let swathWorker = null;
let lastSwathData = null;
let swathExprController = null;
let swathColorOverrides = {};   // { colName: '#hex' }

function getSwathVarColor(colName, paletteIdx) {
  if (swathColorOverrides[colName]) return swathColorOverrides[colName];
  return STATSCAT_PALETTE[paletteIdx % STATSCAT_PALETTE.length];
}

// GT state
let gtWorker = null;
let lastGtData = null;
let gtExprController = null;

// Section state
let sectionBlocks = null;
let sectionTransform = null;
let sectionDefaultBlockSize = null;
let sectionWorker = null;
let sectionExprController = null;

// Project save/load
let pendingProjectRestore = null;
let autoSaveTimer = null;

const STATSCAT_PALETTE = [
  '#4a9eff','#34d399','#f87171','#a78bfa','#fb923c',
  '#22d3ee','#f472b6','#facc15','#818cf8','#2dd4bf',
  '#e879f9','#84cc16','#f97316','#38bdf8','#c084fc',
  '#a3e635','#fb7185','#67e8f9','#d946ef','#fbbf24'
];

const GRADE_UNITS = [
  { label: '(raw)',  symbol: '',     factor: 1 },
  { label: '%',      symbol: '%',    factor: 0.01 },
  { label: 'ppm',    symbol: 'ppm',  factor: 1e-6 },
  { label: 'ppb',    symbol: 'ppb',  factor: 1e-9 },
  { label: 'g/t',    symbol: 'g/t',  factor: 1e-6 },
  { label: 'oz/t',   symbol: 'oz/t', factor: 3.11035e-5 }
];
let globalUnits = {}; // { colName: unitIdx }

// Calcol editor DOM refs
const $calcolBadge = document.getElementById('calcolBadge');
const $calcolCodeArea = document.getElementById('calcolCodeArea');
const $calcolCodePre = document.getElementById('calcolCodePre');
const $calcolSimBtn = document.getElementById('calcolSimBtn');
const $calcolError = document.getElementById('calcolError');
const $calcolVarBrowser = document.getElementById('calcolVarBrowser');
const $calcolVarSearch = document.getElementById('calcolVarSearch');
const $calcolVarList = document.getElementById('calcolVarList');
const $calcolFnList = document.getElementById('calcolFnList');
const $calcolDetected = document.getElementById('calcolDetected');
const $calcolPreviewTable = document.getElementById('calcolPreviewTable');
const $calcolDataSrc = document.getElementById('calcolDataSrc');
const $calcolAc = document.getElementById('calcolAc');

// Tab switching
function switchTab(tabId) {
  $resultsTabs.querySelectorAll('.results-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabId));
  document.querySelectorAll('.results-panel').forEach(p => p.classList.toggle('active', p.dataset.tab === tabId));
}
$resultsTabs.addEventListener('click', (e) => {
  const tab = e.target.closest('.results-tab');
  if (tab) {
    switchTab(tab.dataset.tab);
    if ($helpOverlay && $helpOverlay.classList.contains('active')) renderHelp(tab.dataset.tab);
    if (typeof autoSaveProject === 'function') autoSaveProject();
  }
});

// Help overlay
const $helpOverlay = document.getElementById('helpOverlay');
const $helpBody = document.getElementById('helpBody');
const $helpTitle = document.getElementById('helpTitle');
const $helpBtn = document.getElementById('helpBtn');

var _helpShortcuts =
  '<div class="help-section"><div class="help-section-title">Shortcuts</div>' +
  '<div class="help-row"><kbd>F1</kbd> <span>Toggle this help panel</span></div>' +
  '<div class="help-row"><kbd>Alt+V</kbd> <span>Focus variable search on current tab</span></div>' +
  '<div class="help-row"><kbd>Esc</kbd> <span>Clear search (blur if empty)</span></div>' +
  '<div class="help-row"><kbd>Alt+A</kbd> <span>Select all visible</span></div>' +
  '<div class="help-row"><kbd>Alt+Shift+A</kbd> <span>Deselect all visible</span></div></div>';

var _helpTabs = {
  aux: {
    title: 'Aux',
    html:
      '<div class="help-section"><div class="help-section-title">Overview</div>' +
      '<div class="help-row"><span>Load a second dataset — e.g. the composites/samples behind this block model — to compare against it. Aux runs as its own analysis pass; its variables appear across Statistics, CDF, and Swath with a label prefix.</span></div>' +
      '<div class="help-row"><span>Drop a file, or — when the main data came from a multi-entry archive — pick another entry from it (<em>use an entry from…</em>). Dropping a zip on this tab offers a <strong>ZIP entry</strong> selector in the sidebar.</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Configuration</div>' +
      '<div class="help-row"><span><strong>Display prefix</strong> — cosmetic label for aux variables (e.g. <code>aux:Fe</code>). Does not affect expressions.</span></div>' +
      '<div class="help-row"><span><strong>Coordinates</strong> — assign X/Y/Z. Aux and the block model must share the same coordinate space for swath overlays to align.</span></div>' +
      '<div class="help-row"><span><strong>Aux filter</strong> — pre-filter aux rows. Reference aux columns as <code>aux.</code>… regardless of the display prefix.</span></div>' +
      '<div class="help-row"><span><strong>Weight</strong> — e.g. declustering weights (a column or an aux calcol). Applied to every aux statistic: Statistics rows, CDF overlay, and the swath series. Rows with missing/≤0 weight are excluded.</span></div>' +
      '<div class="help-row"><span><strong>Analyze</strong> — run the full aux statistics pass. Required for the Statistics-tab comparison and CDF overlay; the Swath overlay runs its own pass and does not need it.</span></div>' +
      '<div class="help-row"><span><strong>Aux calcols</strong> — switch the Calc tab to <strong>Aux</strong> to define calculated columns on the aux rows (<code>aux.</code> syntax); they join the comparisons and the weight list.</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Scope</div>' +
      '<div class="help-row"><span>Comparison is statistical/spatial — aux is a separate set of rows, not extra columns. No geometry, export, or per-row joins.</span></div></div>'
  },
  preflight: {
    title: 'Preflight',
    html:
      '<div class="help-section"><div class="help-section-title">Overview</div>' +
      '<div class="help-row"><span>Configure your file before analysis. Set column types, assign coordinate columns, and preview the data.</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Sidebar</div>' +
      '<div class="help-row"><span><strong>Type override</strong> \u2014 force a column to numeric or categorical</span></div>' +
      '<div class="help-row"><span><strong>Skip</strong> \u2014 uncheck to exclude a column from analysis entirely</span></div>' +
      '<div class="help-row"><span><strong>XYZ</strong> \u2014 assign coordinate columns for geometry detection, swath, section, and GT block volume</span></div>' +
      '<div class="help-row"><span><strong>DXYZ</strong> \u2014 optional per-block dimension columns for sub-blocked models</span></div>' +
      '<div class="help-row"><span><strong>Column filter</strong> \u2014 per-column expressions to pre-filter rows (e.g. <code>> 0</code>)</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">ZIP files</div>' +
      '<div class="help-row"><span>Drop a .zip and select which CSV entry to analyze from the dropdown.</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Projects</div>' +
      '<div class="help-row"><span><strong>Save</strong> (toolbar) — download the workspace config as <code>.bma.json</code>. Drop it on the landing page later, then drop the matching data file to apply it.</span></div>' +
      '<div class="help-row"><span><strong>Pack</strong> (toolbar) — bundle the data file(s), the aux dataset, and the project into one portable <code>.bma.zip</code>. The dialog sets a project title, picks contents, and toggles deflate compression; archives use Zip64 automatically, so size is not a limit. Dropping a packed zip offers to load everything pre-configured.</span></div></div>'
  },
  summary: {
    title: 'Summary',
    html:
      '<div class="help-section"><div class="help-section-title">Overview</div>' +
      '<div class="help-row"><span>File metadata, grid geometry, and column overview with type/completeness info.</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Grid Geometry</div>' +
      '<div class="help-row"><span>Auto-detected XYZ extents, block sizes, sub-block ratios. Requires XYZ assignment in Preflight.</span></div>' +
      '<div class="help-row"><span><strong>OBJ Export</strong> \u2014 download bounding box as a 3D mesh file</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Column Overview</div>' +
      '<div class="help-row"><span>Table of all columns with type, count, nulls, zeros, completeness, and range.</span></div>' +
      '<div class="help-row"><span><strong>Unit</strong> column \u2014 assign grade units (%, ppm, g/t, etc.) that propagate to GT and Swath</span></div>' +
      '<div class="help-row"><span><strong>Sniff units</strong> \u2014 auto-detect units from column name patterns like <code>_ppm</code>, <code>(g/t)</code>, <code>_pct</code></span></div>' +
      '<div class="help-row"><span><strong>Copy table</strong> \u2014 copy the overview as tab-separated text</span></div></div>'
  },
  calcols: {
    title: 'Calculated Columns',
    html:
      '<div class="help-section"><div class="help-section-title">Overview</div>' +
      '<div class="help-row"><span>Define new variables using JavaScript expressions. Calcols are computed during analysis and available in all tabs including filters.</span></div>' +
      '<div class="help-row"><span><strong>Model | Aux toggle</strong> — with an aux dataset loaded, switch the editor to define calcols on the aux rows instead. Aux code references columns as <code>aux.</code>… and its results feed the aux Statistics/CDF/Swath comparisons (and the aux filter).</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Syntax</div>' +
      '<div class="help-row"><span>Write assignments to <code>r</code>: e.g. <code>r.ratio = r.Au / r.Ag</code></span></div>' +
      '<div class="help-row"><span>Access any column as <code>r.column_name</code>. Spaces in names use bracket notation.</span></div>' +
      '<div class="help-row"><span>All Math functions available: <code>abs</code>, <code>sqrt</code>, <code>log</code>, <code>pow</code>, <code>min</code>, <code>max</code>, <code>round</code>, <code>floor</code>, <code>ceil</code>, etc.</span></div>' +
      '<div class="help-row"><span>Helpers: <code>clamp(v, lo, hi)</code>, <code>ifnull(v, fallback)</code>, <code>between(v, lo, hi)</code>, <code>remap(v, inLo, inHi, outLo, outHi)</code></span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Tips</div>' +
      '<div class="help-row"><span><strong>Simulate</strong> \u2014 preview calcol values on sample rows before re-analyzing</span></div>' +
      '<div class="help-row"><span><strong>Ordering matters</strong> \u2014 later lines can reference earlier calcols</span></div>' +
      '<div class="help-row"><span><strong>Variable browser</strong> \u2014 click a column name to insert it at cursor</span></div></div>'
  },
  statistics: {
    title: 'Statistics',
    html:
      '<div class="help-section"><div class="help-section-title">Overview</div>' +
      '<div class="help-row"><span>Per-variable descriptive statistics table with selectable metrics and CDF overlays.</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Sidebar</div>' +
      '<div class="help-row"><span><strong>Variables</strong> \u2014 check/uncheck to show/hide columns in the table</span></div>' +
      '<div class="help-row"><span><strong>Metrics</strong> \u2014 toggle which statistics rows to display (mean, std, min, max, percentiles, etc.)</span></div>' +
      '<div class="help-row"><span><strong>Percentiles</strong> \u2014 customize which percentiles are shown (preset or custom comma-separated)</span></div>' +
      '<div class="help-row"><span><strong>Weight</strong> \u2014 weight all numeric statistics by a column or calcol (e.g. ore proportion). Re-run analysis to apply. Weighted runs use population-form std/skew/kurt; rows with missing/\u22640 weight are excluded (count shown below the select). Toggle the <strong>\u03a3W</strong> metric to see weight totals.</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">CDF</div>' +
      '<div class="help-row"><span>Click the <strong>CDF</strong> link on any variable row to open a cumulative distribution overlay.</span></div>' +
      '<div class="help-row"><span>Toggle multiple variables to compare CDFs. Linear or log scale.</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Aux comparison</div>' +
      '<div class="help-row"><span>After running <strong>Analyze</strong> on the Aux tab, aux variables appear at the bottom of the sidebar. A same-named aux variable shows as an indented row right under its model counterpart — mean against mean, CV against CV.</span></div>' +
      '<div class="help-row"><span>Click an aux row’s name to overlay its CDF as a dashed curve. A steeper model CDF over a flatter sample CDF is the classic kriging smoothing signature.</span></div>' +
      '<div class="help-row"><span><strong>Q–Q mode</strong> — switch the panel to a quantile–quantile plot: the first selected curve is the reference axis, every other curve plots against it at P1–P99 (large dots at deciles). Offset from the dashed identity line = bias; slope rotation = support/smoothing difference. Hover dots for values.</span></div></div>'
  },
  categories: {
    title: 'Categories',
    html:
      '<div class="help-section"><div class="help-section-title">Overview</div>' +
      '<div class="help-row"><span>Explore categorical columns with bar charts, value tables, color customization, and filter integration.</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Sidebar</div>' +
      '<div class="help-row"><span>Click a column to focus it in the main area. Search to filter the list.</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Main Area</div>' +
      '<div class="help-row"><span><strong>Bar chart</strong> \u2014 shows top 20 values by default; click Show All for the full set</span></div>' +
      '<div class="help-row"><span><strong>Sort</strong> \u2014 cycle through count-desc, count-asc, alphabetical, and custom drag order</span></div>' +
      '<div class="help-row"><span><strong>Colors</strong> \u2014 click a color swatch in the value table to customize. Colors are used consistently across all tabs.</span></div>' +
      '<div class="help-row"><span><strong>Filter checkboxes</strong> \u2014 uncheck values to add them to the global filter expression</span></div>' +
      '<div class="help-row"><span><strong>Custom order</strong> \u2014 drag rows in the value table to reorder; used in StatsCat, GT group-by, etc.</span></div>' +
      '<div class="help-row"><span><strong>Aux comparison</strong> \u2014 when the analyzed aux dataset shares a same-named categorical column, the chart overlays open diamonds at the aux shares (same axis as the bars) and the table gains aux n / aux % columns, with aux-only values listed at the bottom. Domain proportions model-vs-samples at a glance.</span></div></div>'
  },
  statscat: {
    title: 'StatsCat',
    html:
      '<div class="help-section"><div class="help-section-title">Overview</div>' +
      '<div class="help-row"><span>Group-by analysis: select a categorical column to split numeric variables into groups.</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Setup</div>' +
      '<div class="help-row"><span><strong>Group by</strong> \u2014 select which categorical column defines the groups</span></div>' +
      '<div class="help-row"><span><strong>Variables</strong> \u2014 check numeric columns to include in grouped stats (triggers re-analysis if new columns needed)</span></div>' +
      '<div class="help-row"><span><strong>Groups</strong> \u2014 check/uncheck group values to show/hide in the output</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Output</div>' +
      '<div class="help-row"><span><strong>Stats table</strong> \u2014 per-group mean, std, count, percentiles for each selected variable</span></div>' +
      '<div class="help-row"><span><strong>Cross-tabulation</strong> \u2014 count/row%/col% matrix of two categorical columns</span></div>' +
      '<div class="help-row"><span><strong>CDF overlay</strong> \u2014 grouped CDFs colored by category. Linear or log scale, manual range.</span></div>' +
      '<div class="help-row"><span>When a <strong>Weight</strong> is set on the Statistics tab, grouped statistics are weighted with it too (same analysis pass).</span></div></div>'
  },
  export: {
    title: 'Export',
    html:
      '<div class="help-section"><div class="help-section-title">Overview</div>' +
      '<div class="help-row"><span>Export filtered and transformed data as CSV. Includes calculated columns, column reorder, and format options.</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Columns</div>' +
      '<div class="help-row"><span><strong>Check/uncheck</strong> \u2014 select which columns to include</span></div>' +
      '<div class="help-row"><span><strong>Rename</strong> \u2014 click the rename field to change output column name</span></div>' +
      '<div class="help-row"><span><strong>Reorder</strong> \u2014 drag the grip handle to change column order</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Format Options</div>' +
      '<div class="help-row"><span><strong>Delimiter</strong> \u2014 comma, tab, semicolon, space, or custom</span></div>' +
      '<div class="help-row"><span><strong>Quote char</strong> \u2014 double, single, or none</span></div>' +
      '<div class="help-row"><span><strong>Precision</strong> \u2014 auto (preserve source), or fixed decimal places</span></div>' +
      '<div class="help-row"><span><strong>Null value</strong> \u2014 string to write for missing data (empty, NaN, -999, etc.)</span></div>' +
      '<div class="help-row"><span><strong>Decimal separator</strong> \u2014 period or comma (European)</span></div>' +
      '<div class="help-row"><span><strong>Comment header</strong> \u2014 optional metadata block prepended to the file</span></div></div>'
  },
  gt: {
    title: 'Grade-Tonnage',
    html:
      '<div class="help-section"><div class="help-section-title">Overview</div>' +
      '<div class="help-row"><span>Grade-tonnage analysis: sweep cutoff grades to produce tonnage, mean grade, and metal content curves.</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Configuration</div>' +
      '<div class="help-row"><span><strong>Grade variables</strong> \u2014 check one or more numeric columns. Each produces its own chart + table.</span></div>' +
      '<div class="help-row"><span><strong>Unit selects</strong> \u2014 per-variable units (%, ppm, g/t, etc.) control the grade factor for metal content. Inherits from global units; override locally.</span></div>' +
      '<div class="help-row"><span><strong>Sync units</strong> \u2014 pull unit assignments from Column Overview</span></div>' +
      '<div class="help-row"><span><strong>Density</strong> \u2014 a column, a constant (e.g. 2.8 t/m\u00b3), or none. Tonnage = volume \u00d7 density; with none, density is 1, so "tonnage" is really volume (m\u00b3).</span></div>' +
      '<div class="help-row"><span><strong>Weight</strong> \u2014 optional column for pre-computed block weights</span></div>' +
      '<div class="help-row"><span><strong>Block volume</strong> \u2014 auto from geometry or DXYZ; override with a custom value</span></div>' +
      '<div class="help-row"><span><strong>Tonnage unit</strong> \u2014 t, kt, Mt, or custom divisor</span></div>' +
      '<div class="help-row"><span><strong>Group by</strong> \u2014 segment by a categorical column for per-group curves</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Cutoffs</div>' +
      '<div class="help-row"><span><strong>Range</strong> mode \u2014 min/max/step generates evenly-spaced cutoffs</span></div>' +
      '<div class="help-row"><span><strong>Custom</strong> mode \u2014 comma-separated list of specific cutoff values</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Output</div>' +
      '<div class="help-row"><span>Chart with tonnage (amber, left Y), grade (blue, right Y), and metal (green, dashed). Hover for crosshair readout.</span></div>' +
      '<div class="help-row"><span><strong>Copy SVG / Download PNG</strong> — export each chart (PNG is a light-themed 2× render; both carry the variable name as a title)</span></div>' +
      '<div class="help-row"><span>Collapsible table below each chart. Copy button for clipboard export.</span></div></div>'
  },
  swath: {
    title: 'Swath Plots',
    html:
      '<div class="help-section"><div class="help-section-title">Overview</div>' +
      '<div class="help-row"><span>Spatial trend plots: bin blocks along an axis and show how variable values change across the model.</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Configuration</div>' +
      '<div class="help-row"><span><strong>Axis</strong> \u2014 X (W\u2192E), Y (S\u2192N), Z (Bottom\u2192Top), or Custom (arbitrary azimuth)</span></div>' +
      '<div class="help-row"><span><strong>Custom axis</strong> \u2014 enter azimuth (0\u00b0=N, clockwise) and optional plunge (\u00b0 below horizontal). Projects XY(Z) onto that direction for binning.</span></div>' +
      '<div class="help-row"><span><strong>Bin width</strong> \u2014 defaults to block size; override for wider bins</span></div>' +
      '<div class="help-row"><span><strong>Statistic</strong> \u2014 Mean\u00b1Std, P25/P50/P75, or P10/P50/P90</span></div>' +
      '<div class="help-row"><span><strong>Weight (model)</strong> \u2014 weight the model series\u2019 bin statistics by a column or calcol. The aux series uses the weight set on the Aux tab.</span></div>' +
      '<div class="help-row"><span><strong>Variables</strong> \u2014 check one or more. Each gets its own Y-axis + ribbon on the overlay chart.</span></div>' +
      '<div class="help-row"><span><strong>Color swatch</strong> \u2014 click the colored square next to a variable name to customize its chart color</span></div>' +
      '<div class="help-row"><span><strong>Unit selects</strong> \u2014 per-variable units shown on axis labels, table headers, and tooltip. Inherits from global units.</span></div>' +
      '<div class="help-row"><span><strong>Sync units</strong> \u2014 pull unit assignments from Column Overview</span></div>' +
      '<div class="help-row"><span><strong>Aux overlay</strong> \u2014 with an aux dataset loaded (Aux tab), its variables appear at the bottom of the list and plot as dashed series. A same-named aux variable shares the model variable\u2019s color and Y scale, so model-vs-data bias reads directly off the chart. The aux pass applies the Aux tab filter (not the local filter below).</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Display</div>' +
      '<div class="help-row"><span><strong>Show bands</strong> \u2014 toggle the \u00b1 ribbons (std/percentile range). Disable to see center lines only.</span></div>' +
      '<div class="help-row"><span><strong>Show count bars</strong> \u2014 toggle the count histogram below the chart</span></div>' +
      '<div class="help-row"><span><strong>Show table</strong> \u2014 toggle the data table below the chart</span></div>' +
      '<div class="help-row"><span><strong>Y Scale</strong> \u2014 Linear or Log. Log clamps to positive values.</span></div>' +
      '<div class="help-row"><span><strong>Layout</strong> \u2014 Overlay (all variables on one chart) or Split (one chart per variable, stacked vertically)</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Output</div>' +
      '<div class="help-row"><span>Overlay chart with one ribbon+line per variable. Count bars below show bin population.</span></div>' +
      '<div class="help-row"><span>Hover for crosshair with per-variable center \u00b1 range values.</span></div>' +
      '<div class="help-row"><span><strong>Copy SVG</strong> \u2014 copy chart as SVG markup to clipboard</span></div>' +
      '<div class="help-row"><span><strong>Download PNG</strong> \u2014 download chart as a light-themed PNG at 2\u00d7 resolution</span></div>' +
      '<div class="help-row"><span>Collapsible data table with per-bin statistics. Copy to clipboard.</span></div></div>'
  },
  section: {
    title: 'Section View',
    html:
      '<div class="help-section"><div class="help-section-title">Overview</div>' +
      '<div class="help-row"><span>2D slice view of the block model. Select a plane, navigate through slices, and color by any variable.</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Configuration</div>' +
      '<div class="help-row"><span><strong>Plane</strong> \u2014 XY (plan), XZ (long section), or YZ (cross section)</span></div>' +
      '<div class="help-row"><span><strong>Slice</strong> \u2014 slider or input to select which slice along the normal axis</span></div>' +
      '<div class="help-row"><span><strong>Color by</strong> \u2014 numeric (continuous colormap) or categorical (category colors from Categories tab)</span></div></div>' +
      '<div class="help-section"><div class="help-section-title">Interaction</div>' +
      '<div class="help-row"><span>Pan by dragging, zoom with scroll wheel. Hover blocks for tooltip.</span></div></div>'
  }
};

function getActiveTabId() {
  var t = document.querySelector('.results-tab.active');
  return t ? t.dataset.tab : 'preflight';
}

function renderHelp(tabId) {
  var info = _helpTabs[tabId];
  if (!info) { $helpBody.innerHTML = ''; $helpTitle.textContent = 'Help'; return; }
  $helpTitle.textContent = info.title;
  $helpBody.innerHTML = _helpShortcuts + info.html;
}

function toggleHelp() {
  var opening = !$helpOverlay.classList.contains('active');
  $helpOverlay.classList.toggle('active');
  if (opening) renderHelp(getActiveTabId());
}

$helpBtn.addEventListener('click', toggleHelp);
document.getElementById('helpClose').addEventListener('click', function() {
  $helpOverlay.classList.remove('active');
});

// Global keyboard shortcuts
var _tabSearchMap = {
  statistics: 'statsVarSearch',
  categories: 'catColSearch',
  statscat: 'statsCatVarSearch',
  export: 'exportColSearch',
  calcols: 'calcolVarSearch',
  gt: 'gtVarSearch',
  swath: 'swathVarSearch'
};
document.addEventListener('keydown', function(e) {
  // F1 — toggle help
  if (e.key === 'F1') {
    e.preventDefault();
    toggleHelp();
    return;
  }
  // Escape — close help if open
  if (e.key === 'Escape' && $helpOverlay.classList.contains('active')) {
    $helpOverlay.classList.remove('active');
    return;
  }
  // Alt+V — focus variable search on active tab
  if (e.altKey && e.key.toLowerCase() === 'v') {
    e.preventDefault();
    var activeTab = document.querySelector('.results-tab.active');
    if (!activeTab) return;
    var searchId = _tabSearchMap[activeTab.dataset.tab];
    if (searchId) {
      var el = document.getElementById(searchId);
      if (el) { el.focus(); el.select(); }
    }
    return;
  }
});

