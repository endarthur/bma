# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BMA (Block Model Atelier) is a single-file, client-side CSV block model analyzer for mining/geostatistics. Everything lives in `bma.html` (~3980 lines) — no dependencies, no build step, no server. It runs entirely in the browser using Web Workers and the File API.

Target users are resource geologists analyzing block model CSV exports from mining software (Isatis, Vulcan, Surpac, Leapfrog, Datamine).

## Development

There is no build system, package manager, or test suite. The entire app is one HTML file.

**Syntax checking** (extract and verify JS):
```bash
node -e "..." # extract <script> content and WORKER_CODE, new Function() each
```

**Running**: Open `bma.html` directly in a browser. No server needed.

## Architecture

### File Layout (`bma.html`)

| Section | Approx Lines | Description |
|---------|-------------|-------------|
| CSS | 1–1300 | Dark amber theme, all styles |
| HTML body | 1300–1530 | Landing page, tabbed workspace, filter bar, CDF modal |
| WORKER_CODE | ~1539–2415 | Web Worker as template literal string |
| Main thread JS | ~2417–3981 | App state, UI, event wiring |

### Data Flow

1. **File drop** → `handleFile()` → shows tabbed workspace on Preflight tab
2. **Preflight** → `runPreflight()` reads first 100 lines on main thread, detects delimiter/types/XYZ, builds column config
3. **Analyze** → `startAnalysis()` spawns Web Worker with file + config
4. **Worker** → single-pass streaming analysis (type detection → Welford stats + t-digest quantiles + geometry + calcols)
5. **Complete** → `displayResults()` populates Summary/Statistics/Categories tabs

### Key Architecture Decisions

- **Single file, vanilla JS** — no frameworks, no bundler
- **Streaming** — uses `File.stream()` + `TextDecoderStream`, never loads full file into memory
- **Web Worker** — all analysis runs off main thread
- **Single-pass** — type detection, stats, geometry, and calculated columns all computed in one file read
- **Worker code is a template literal** — the `WORKER_CODE` constant is a backtick-delimited string. Watch for unescaped backticks or `${` inside it (currently avoided via string concat)
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

### Key Functions (approximate line numbers)

| Function | ~Line | Purpose |
|----------|-------|---------|
| `runPreflight()` | 2650 | Main-thread file sampling |
| `renderPreflight()` | 2693 | Build preflight UI |
| `renderPreflightSidebar()` | 2739 | Column config sidebar |
| `handleFile()` | 2969 | File drop entry point |
| `startAnalysis()` | 3071 | Spawn worker, begin analysis |
| `displayResults()` | 3153 | Populate results tabs |
| `esc()` | 3731 | HTML escaping utility |
| `formatNum()` | — | Significant figures formatting for stats |

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
