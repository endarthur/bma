# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BMA (Block Model Atelier) is a client-side CSV block model analyzer for mining/geostatistics. The distributable is a single `index.html` — no dependencies, no server. It runs entirely in the browser using Web Workers and the File API. Source code lives in `src/` and is assembled by `node build.js`.

Target users are resource geologists analyzing block model CSV exports from mining software (Isatis, Vulcan, Surpac, Leapfrog, Datamine).

## Development

Source is split into `src/` files. `index.html` is generated — do not hand-edit it.

**Build** (requires Node.js):
```bash
node build.js    # assembles src/ → index.html
node check.js    # syntax-checks src/ files and built output
```

**Running**: Open `index.html` directly in a browser. No server needed.

## Architecture

### File Layout

```
src/
├── template.html   # HTML skeleton with __INJECT_CSS/WORKER/APP__ markers
├── styles.css      # All CSS (no <style> tags)
├── worker.js       # Web Worker code (normal JS, not escaped)
├── core.js         # App state, DOM refs, tab switching (loaded first)
├── preflight.js    # File sampling, preflight UI, sidebar config
├── project.js      # Save/load projects, autosave, restore
├── statistics.js   # Statistics tab — sidebar, percentiles, CDF panel
├── export.js       # Export tab — column selection, CSV download
├── swath.js        # Swath plot tab
├── section.js      # Section view tab
├── calcol.js       # Calculated columns editor UI
├── events.js       # File drop/input event handlers
├── filter.js       # Filter expression system, category checkboxes
└── cdf.js          # CDF modal, service worker registration
build.js            # Node.js build script: src/ → index.html
check.js            # Syntax checker for src/ and built output
index.html          # Generated output — do not edit directly
```

`build.js` reads `src/template.html`, injects CSS, wraps `worker.js` in a template literal (escaping `\`, `` ` ``, `${`), then concatenates the app modules in the order listed in `APP_MODULES` (core.js first). To add a new module, create the file in `src/` and add it to `APP_MODULES` in `build.js`.

### Data Flow

1. **File drop** → `handleFile()` → shows tabbed workspace on Preflight tab
2. **Preflight** → `runPreflight()` reads first 100 lines on main thread, detects delimiter/types/XYZ, builds column config
3. **Analyze** → `startAnalysis()` spawns Web Worker with file + config
4. **Worker** → single-pass streaming analysis (type detection → Welford stats + t-digest quantiles + geometry + calcols)
5. **Complete** → `displayResults()` populates Summary/Statistics/Categories tabs

### Key Architecture Decisions

- **Single distributable, vanilla JS** — no frameworks, no bundler; `build.js` concatenates `src/` into one HTML file
- **Streaming** — uses `File.stream()` + `TextDecoderStream`, never loads full file into memory
- **Web Worker** — all analysis runs off main thread
- **Single-pass** — type detection, stats, geometry, and calculated columns all computed in one file read
- **Worker code** — `src/worker.js` is normal JS; `build.js` escapes and wraps it in a template literal as `WORKER_CODE`. Avoid backticks and `${` in worker code (use string concat instead)
- **Preflight is a tab** — the tabbed workspace appears as soon as a file is dropped, before any analysis runs
- **Overlay for re-analysis** — semi-transparent overlay with progress bar + cancel. Cancel terminates worker, restores previous results from `lastCompleteData`
- **Expression DSL** — filters and calcols use `r.column_name` syntax compiled to JS via `new Function()`. A `MATH_PREAMBLE` injects destructured Math functions and helpers (`clamp`, `cap`, `ifnull`, `between`, `remap`, `fn.round`)
- **Filters can reference calcols** — `buildRow()` evaluates calcols before the filter runs, so filter expressions can use calculated column values

### Worker Protocol

Messages **to** worker: `{file, xyzOverride, filter, typeOverrides, zipEntry, skipCols, colFilters, calcols}`

Messages **from** worker:
- `{type: 'header', ...}` — column metadata after detection
- `{type: 'progress', percent, rowCount}` — streaming progress
- `{type: 'complete', stats, geometry, categories, ...}` — final results
- `{type: 'error', message}` — error reporting

### Key State Variables (main thread)

- `currentFile`, `currentHeader`, `currentColTypes`, `currentXYZ` — active file and schema
- `currentFilter` — global filter expression (`{expression: string}` or null)
- `currentCalcols` — calculated column definitions `[{id, name, expr, type}]`
- `preflightData` — preflight sampling results
- `lastCompleteData` — snapshot of last successful analysis (used for cancel restore)
- `currentRowVar` — variable name for row expressions (default `'r'`, changes if column named `r` exists)
- `statsSelectedVars`, `statsVisibleMetrics`, `statsPercentiles`, `statsCdfSelected`, `statsCdfScale` — Statistics tab UI state

### Key Functions

| Function | File | Purpose |
|----------|------|---------|
| `runPreflight()` | preflight.js | Main-thread file sampling |
| `renderPreflight()` | preflight.js | Build preflight UI |
| `renderPreflightSidebar()` | preflight.js | Column config sidebar |
| `handleFile()` | project.js | File drop entry point |
| `startAnalysis()` | project.js | Spawn worker, begin analysis |
| `displayResults()` | project.js | Populate results tabs |
| `renderStatsTab()` | statistics.js | Build statistics sidebar + table + CDF panel |
| `tdQuantileFromCentroids()` | statistics.js | Client-side quantile from t-digest centroids |
| `esc()` | calcol.js | HTML escaping utility |
| `formatNum()` | preflight.js | Significant figures formatting for stats |

## Theme

"Geoscientific Chaos Union" (GCU) branding. Dark terminal aesthetic with amber accent. CSS uses custom properties (`--bg`, `--amber`, `--mono`, etc.).

## Known Gotchas

- **Calcol ordering matters**: later calcols can reference earlier ones, but there's no topological sort — array order in `currentCalcols` determines evaluation order
- **Name collisions**: calcol names matching Math preamble functions (`abs`, `sqrt`, etc.) will be shadowed by the preamble `const` declarations
- **Autocomplete positioning**: uses `position: absolute; bottom: 100%` inside a relative label — may clip in some layouts

## Reference Docs

- [`docs/worker-protocol.md`](docs/worker-protocol.md) — full worker message schemas and stats object structure
- [`docs/v1-roadmap.md`](docs/v1-roadmap.md) — V1 feature architecture (StatsCat, Swath, Export)
- [`docs/code-map.md`](docs/code-map.md) — detailed line ranges, HTML structure, CSS variables, state variables
- [`docs/ui-design-system.md`](docs/ui-design-system.md) — UI/UX design system: layout patterns, component library, color tokens, naming conventions, new tab checklist
