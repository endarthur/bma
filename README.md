# BMA — Block Model Atelier

Client-side CSV block model analyzer for mining and geostatistics. Drop a file, get instant statistics — nothing leaves your browser.

**[Live app](https://endarthur.github.io/bma/)**

## What it does

BMA analyzes block model CSV exports from mining software (Isatis, Vulcan, Surpac, Leapfrog, Datamine). It streams files row-by-row using Web Workers, so multi-gigabyte models work on modest hardware without uploading anything to a server.

- **Preflight** — auto-detects delimiters, column types, and XYZ coordinates; lets you override types, skip columns, and set per-column value filters before analysis
- **Summary** — file metadata, grid geometry, block dimensions, sub-block detection, fill ratio, coordinate ordering
- **Calc** — calculated columns with an expression editor (`r.Fe / r.SiO2`), live preview, autocomplete, and chained evaluation
- **Statistics** — Welford online stats (mean, std, CV%, skewness, kurtosis), t-digest quantiles (P10–P90), CDF plots, per-column zero/negative filters
- **Categories** — value counts, frequency bars, Shannon entropy, search and collapse
- **StatsCat** — statistics grouped by a categorical variable with per-group tables and CDF overlays, cross-tabulation mode
- **Export** — stream-export selected/renamed/reordered columns as CSV with drag-and-drop column ordering

Global row filter expressions use JavaScript syntax on row objects: `r.LITO === 'BIF' && r.fe_pct > 30`. Filters can reference calculated columns.

## Usage

Open `index.html` in a browser. No server, no install, no dependencies.

Supports `.csv`, `.txt`, `.dat`, and `.zip` files. Also installable as a PWA.

## Architecture

Everything lives in a single `index.html` file (~6000 lines) — CSS, HTML, Web Worker (as a template literal), and main-thread JS. No frameworks, no bundler, no build step.

Key design decisions:

- **Streaming** — `File.stream()` + `TextDecoderStream`, never loads the full file into memory
- **Single-pass** — type detection, stats, geometry, and calculated columns all computed in one file read
- **Web Worker** — all analysis runs off the main thread; a separate worker handles export
- **Expression DSL** — filters and calcols compile to JS via `new Function()` with a math preamble (`abs`, `sqrt`, `clamp`, `ifnull`, `between`, `remap`, etc.)

See [`docs/`](docs/) for detailed architecture docs.

## License

[MIT](LICENSE) — Arthur Endlein, 2026
