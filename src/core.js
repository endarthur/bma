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

var HAS_FSAA = typeof window.showOpenFilePicker === 'function';

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
    if (typeof autoSaveProject === 'function') autoSaveProject();
  }
});

