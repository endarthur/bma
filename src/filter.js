// ─── Filter Expression System ────────────────────────────────────────
function rebuildFilterExpression() {
  // Gather checked values grouped by column
  const groups = {};
  $catValueTable.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
    const col = cb.dataset.col;
    if (!groups[col]) groups[col] = [];
    groups[col].push(cb.dataset.val);
  });

  // Helper: proper JS accessor for column name
  const colRef = (name) => {
    const v = currentRowVar;
    return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) ? `${v}.${name}` : `${v}["${name}"]`;
  };

  // Build expression: OR within column, AND across columns
  const parts = [];
  for (const [colIdx, vals] of Object.entries(groups)) {
    const col = colRef(currentHeader[parseInt(colIdx)]);
    const conditions = vals.map(v => `${col} == "${v}"`);
    parts.push(conditions.length === 1 ? conditions[0] : `(${conditions.join(' || ')})`);
  }

  // Get any existing manual/numeric parts the user typed
  const currentExpr = $filterExpr.value.trim();
  const autoExpr = parts.join(' && ');

  // If user hasn't manually edited, just replace entirely
  if (!currentExpr || currentExpr === lastAutoExpr) {
    $filterExpr.value = autoExpr;
  } else {
    // User has custom content — try to replace the auto-generated portion
    if (lastAutoExpr && currentExpr.includes(lastAutoExpr)) {
      $filterExpr.value = autoExpr
        ? currentExpr.replace(lastAutoExpr, autoExpr)
        : currentExpr.replace(lastAutoExpr, '').replace(/^\s*&&\s*|\s*&&\s*$/, '').trim();
    } else if (autoExpr) {
      // Can't find old auto part — append
      $filterExpr.value = currentExpr ? `${currentExpr} && ${autoExpr}` : autoExpr;
    }
  }
  lastAutoExpr = autoExpr;
}
let lastAutoExpr = '';

// Apply filter
$filterApply.addEventListener('click', () => {
  const expr = $filterExpr.value.trim();
  $filterError.classList.remove('active');
  $filterError.style.color = '';
  if (!expr) {
    currentFilter = null;
    startAnalysis(currentXYZ, null, undefined, undefined, undefined, undefined);
    return;
  }
  if (filterExprController) {
    const result = filterExprController.validate();
    if (!result.valid) return;
  }
  currentFilter = { expression: expr };
  startAnalysis(currentXYZ, currentFilter, undefined, undefined, undefined, undefined);
});

// Filter expression autocomplete + Enter-to-apply
const filterExprController = createExprInput($filterExpr, {
  errorElement: $filterError,
  mode: 'filter',
  validateOnBlur: true,
  onEnter: function() { $filterApply.click(); }
});

// Clear filter
$filterClear.addEventListener('click', () => {
  $filterExpr.value = '';
  lastAutoExpr = '';
  currentFilter = null;
  $filterError.classList.remove('active');
  // Uncheck all checkboxes
  $catValueTable.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
    cb.checked = false;
    cb.closest('tr').classList.remove('active');
  });
  startAnalysis(currentXYZ, null, undefined, undefined, undefined, undefined);
});

// Click-to-copy on geometry cells (event delegation)
$geoContent.addEventListener('click', (e) => {
  const cell = e.target.closest('.gc[data-value]');
  if (!cell) return;
  const val = cell.dataset.value;
  navigator.clipboard.writeText(val).then(() => {
    cell.classList.add('copied');
    setTimeout(() => cell.classList.remove('copied'), 800);
  });
});

// Copy full geometry table
let lastGeoData = null;
document.getElementById('copyGeoBtn').addEventListener('click', (e) => {
  if (!lastGeoData) return;
  const btn = e.currentTarget;
  const g = lastGeoData;
  const fmt = (v) => (v != null && v !== undefined) ? String(v) : '';
  const anySubBlocked = g.x.isSubBlocked || g.y.isSubBlocked || g.z.isSubBlocked;
  const rows = [
    ['', 'X', 'Y', 'Z'],
    ['Origin', fmt(g.x.origin), fmt(g.y.origin), fmt(g.z.origin)],
    ['Block Size', fmt(g.x.blockSize), fmt(g.y.blockSize), fmt(g.z.blockSize)],
  ];
  if (anySubBlocked) {
    rows.push(['Min Block', fmt(g.x.minBlockSize), fmt(g.y.minBlockSize), fmt(g.z.minBlockSize)]);
  }
  rows.push(
    ['Unique', fmt(g.x.uniqueCount), fmt(g.y.uniqueCount), fmt(g.z.uniqueCount)],
    ['Grid Count', fmt(g.x.gridCount), fmt(g.y.gridCount), fmt(g.z.gridCount)],
    ['Extent', fmt(g.x.extent), fmt(g.y.extent), fmt(g.z.extent)],
  );
  const tsv = rows.map(r => r.join('\t')).join('\n');
  navigator.clipboard.writeText(tsv).then(() => {
    btn.classList.add('copied');
    btn.textContent = 'Copied!';
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.textContent = 'Copy table';
    }, 1200);
  });
});

// Copy column overview table
document.getElementById('copyColOverviewBtn').addEventListener('click', (e) => {
  const table = document.querySelector('.col-overview');
  if (!table) return;
  const btn = e.currentTarget;
  const rows = [];
  table.querySelectorAll('tr').forEach(tr => {
    const cells = [];
    tr.querySelectorAll('th, td').forEach(td => cells.push(td.textContent.trim()));
    rows.push(cells.join('\t'));
  });
  const tsv = rows.join('\n');
  navigator.clipboard.writeText(tsv).then(() => {
    btn.classList.add('copied');
    btn.textContent = 'Copied!';
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.textContent = 'Copy table';
    }, 1200);
  });
});

// Sniff units from column names
function sniffUnits() {
  if (!currentHeader || currentHeader.length === 0) return;
  var patterns = [
    { re: /[_\s]ppm\b|\(ppm\)$/i, idx: 2 },
    { re: /[_\s]ppb\b|\(ppb\)$/i, idx: 3 },
    { re: /[_\s](?:pct|perc|prcnt)\b|\(%\)$/i, idx: 1 },
    { re: /[_\s]gt\b|\(g\/t\)$/i, idx: 4 },
    { re: /[_\s](?:opt|ozt)\b|\(oz\/t\)$/i, idx: 5 }
  ];
  var changed = false;
  for (var i = 0; i < currentHeader.length; i++) {
    if (currentColTypes[i] !== 'numeric') continue;
    var name = currentHeader[i];
    for (var pi = 0; pi < patterns.length; pi++) {
      if (patterns[pi].re.test(name)) {
        globalUnits[name] = patterns[pi].idx;
        changed = true;
        break;
      }
    }
  }
  if (changed) {
    refreshColumnUnitSelects();
    autoSaveProject();
  }
}

function refreshColumnUnitSelects() {
  document.querySelectorAll('.col-unit-select').forEach(function(sel) {
    var colName = sel.dataset.colName;
    if (colName && globalUnits[colName] != null) sel.value = globalUnits[colName];
    else sel.value = 0;
  });
}

document.getElementById('sniffUnitsBtn').addEventListener('click', sniffUnits);

// Column unit select change
document.getElementById('colOverviewContent').addEventListener('change', function(e) {
  if (e.target.classList.contains('col-unit-select')) {
    var colName = e.target.dataset.colName;
    var val = parseInt(e.target.value);
    if (val > 0) globalUnits[colName] = val;
    else delete globalUnits[colName];
    autoSaveProject();
  }
});

// Export bounding box as OBJ
document.getElementById('exportObjBtn').addEventListener('click', () => {
  if (!lastGeoData) return;
  const g = lastGeoData;
  const gx = g.x, gy = g.y, gz = g.z;
  const xMin = gx.origin - gx.blockSize / 2;
  const xMax = gx.origin + gx.gridCount * gx.blockSize - gx.blockSize / 2;
  const yMin = gy.origin - gy.blockSize / 2;
  const yMax = gy.origin + gy.gridCount * gy.blockSize - gy.blockSize / 2;
  const zMin = gz.origin - gz.blockSize / 2;
  const zMax = gz.origin + gz.gridCount * gz.blockSize - gz.blockSize / 2;
  const fname = currentFile ? currentFile.name : 'model';
  const obj = `# BMA Bounding Box \u2014 ${fname}
v ${xMin} ${yMin} ${zMin}
v ${xMax} ${yMin} ${zMin}
v ${xMax} ${yMax} ${zMin}
v ${xMin} ${yMax} ${zMin}
v ${xMin} ${yMin} ${zMax}
v ${xMax} ${yMin} ${zMax}
v ${xMax} ${yMax} ${zMax}
v ${xMin} ${yMax} ${zMax}
f 1 2 3 4
f 5 8 7 6
f 1 5 6 2
f 2 6 7 3
f 3 7 8 4
f 4 8 5 1
`;
  const blob = new Blob([obj], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fname.replace(/\.[^.]+$/, '') + '_bbox.obj';
  a.click();
  URL.revokeObjectURL(a.href);
});

