# Code Map (approximate line ranges)

All in `index.html`. Line numbers shift as features are added.

## CSS (~1–1300)

All styles including responsive breakpoints and theme variables.

### Theme Variables

```css
--bg: #08090a    --bg1: #0f1114   --bg2: #161a1e   --bg3: #1e2328
--fg: #c8cdd3    --fg-dim: #6b7280              --fg-bright: #e8ecf0
--amber: #e8a317             --amber-dim: #b07a0e
--amber-glow: #e8a31730      --blue: #4a9eff
--green: #34d399             --red: #f87171
--border: #252a30
--mono: 'IBM Plex Mono', 'JetBrains Mono', monospace
```

## HTML Body (~1300–1530)

```
.app              Landing page (header, dropzone, about, footer)
#results          Tabbed workspace (shown on file load)
  .results-toolbar    Filename, row count, timing
  .results-tabs       Tab bar (horizontal scroll on mobile)
  .results-panels     Tab content panels
    #panelPreflight     Column config, preview table, Analyze button
    #panelSummary       Geometry, file info
    #panelCalcols       Calculated columns editor
    #panelStatistics    Statistics: sidebar + table + CDF panel
    #panelCategories    Categorical value counts
.filter-footer    Global filter expression bar (bottom)
#cdfModal         CDF plot modal
```

## WORKER_CODE (~1539–2415)

Template literal string containing the Web Worker.

| Section | ~Lines | Description |
|---------|--------|-------------|
| Delimiter detection | ~1545 | Auto-detect CSV/TSV/etc |
| Type detection | ~1580 | Per-column state machine (numeric vs categorical) |
| XYZ auto-detection | ~1650 | Pattern matching on column names |
| T-digest | ~1810–1890 | Streaming approximate quantiles |
| `analyze()` | ~1889–2410 | Main single-pass streaming analysis |
| `self.onmessage` | ~2411 | Worker entry point |

## Main Thread JS (~2417–3981)

| Section | ~Lines | Description |
|---------|--------|-------------|
| App state + DOM refs | ~2417–2480 | State variables, element references |
| Tab switching | ~2482 | Tab/panel management |
| Preflight helpers | ~2491–2650 | Column config utilities |
| `runPreflight()` | ~2650 | Main-thread file sampling |
| `renderPreflight()` | ~2693 | Build preflight UI |
| `renderPreflightSidebar()` | ~2739 | Column config sidebar |
| `handleFile()` | ~2969 | File drop entry point |
| `startAnalysis()` | ~3071 | Spawn worker, begin analysis |
| `displayResults()` | ~3153 | Populate results tabs (calls `renderStatsTab()`) |
| Statistics tab | ~3260–3920 | Sidebar, percentile config, stats table, CDF panel with tooltip |
| Calcol UI | ~3920–4130 | Editor, validation, preview |
| Autocomplete | ~3540–3630 | Column name + math function completions |
| `esc()` | ~3731 | HTML escaping utility |
| Filter system | ~3748–3870 | Expression bar, apply/clear |
| CDF modal | ~3876 | Canvas-based CDF plot from t-digest centroids |

## State Variables

```javascript
currentFile          // File object
currentHeader        // string[] — includes calcol names
currentColTypes      // string[] — 'numeric'|'categorical', includes calcols
currentXYZ           // {x, y, z} — column indices
detectedXYZ          // original auto-detected XYZ
currentFilter        // {expression: string} | null
currentRowVar        // 'r' (or alternative if 'r' collides with column name)
currentCalcols       // [{id, name, expr, type}] — persist across re-analysis
currentOrigColCount  // number of original (non-calcol) columns
preflightData        // {header, sampleRows, autoTypes, delimiter, zipEntries,
                     //  selectedZipEntry, typeOverrides, skipCols, xyz, colFilters}
lastCompleteData     // last worker 'complete' message — snapshot for cancel
hasResults           // boolean — has analysis been run at least once
editingCalcolId      // null | id — calcol currently being edited
worker               // Worker instance

// Statistics tab state
statsSelectedVars    // Set<colIdx> | null — selected variables (null = all)
statsVisibleMetrics  // Set<string> | null — visible metric columns (null = defaults)
statsPercentiles     // number[] — e.g. [25, 50, 75]
statsCdfSelected     // Set<colIdx> — columns shown in CDF overlay
statsCdfScale        // 'linear' | 'log'
```
