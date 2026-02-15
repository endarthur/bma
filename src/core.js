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

const $dropzone = document.getElementById('dropzone');
const $fileInput = document.getElementById('fileInput');
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
const $catContent = document.getElementById('catContent');
const $catBadge = document.getElementById('catBadge');
const $catSection = document.getElementById('catSection');
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
let statsCatGroupSortMode = 'count'; // 'count' or 'name'
let statsCatSelectedVars = new Set(); // col indices selected for group stats analysis
let statsCatCdfScale = 'linear'; // 'linear' or 'log'
let statsCatCdfManual = false;
let statsCatCdfMin = null;
let statsCatCdfMax = null;
let statsCatCrossMode = 'count'; // 'count', 'row', 'col'
let statsCatShowSelectedOnly = false;

// Export
let exportWorker = null;
let exportColumns = []; // [{name, outputName, type, selected, isCalcol}]
const $exportColList = document.getElementById('exportColList');
const $exportBadge = document.getElementById('exportBadge');
const $exportDownload = document.getElementById('exportDownload');
const $exportInfo = document.getElementById('exportInfo');
const $exportProgress = document.getElementById('exportProgress');
const $exportProgressLabel = document.getElementById('exportProgressLabel');
const $exportProgressFill = document.getElementById('exportProgressFill');

// DXYZ state
let currentDXYZ = { dx: -1, dy: -1, dz: -1 };

// Swath state
let swathWorker = null;
let lastSwathData = null;
let swathExprController = null;

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
  if (tab) switchTab(tab.dataset.tab);
});

