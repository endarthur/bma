# V1 Roadmap — Feature Architecture

Tab bar: `Preflight · Summary · Calc · Statistics · Categories · StatsCat · Export`

## 1. Calc tab — done

Calculated columns with expression editor, live preview, autocomplete, editing, `fn.*` helpers.

## 2. StatsCat tab — done

Statistics grouped by categorical variable. Dropdown to select grouping column, per-group Welford + t-digest stats, CDF overlay plots, cross-tabulation mode (count/row%/col%), variable search and selection, group sort (count/name).

## 3. Export tab — done

Stream-export with column selection, renaming, drag-and-drop reordering. Separate export worker (doesn't interfere with analysis worker). FSAA streaming path on supported browsers, Blob fallback otherwise. Applies active filters and evaluates calcol expressions during export.

## 4. Swath tab

Spatial binning along a direction vector with per-bin statistics.

**Architecture:**
- Project coordinates onto user-defined vector (azimuth/dip), bin by distance
- One streaming pass, `Map<binIndex, StatsAccumulator>` per variable
- UI: azimuth/dip inputs, slice width, variable selection, optional local filter
- Output: line charts (mean +/- std or P25/P50/P75 ribbons) via canvas or SVG

## 5. Project Save/Load

Persist session state so users can resume work without re-configuring from scratch after a page reload.

**What to save:**
- File reference (name, size, last-modified — for re-identification on re-drop)
- Preflight config: type overrides, skipped columns, XYZ assignments, per-column value filters, selected ZIP entry
- Calculated columns (`currentCalcols` array — name, expression, type, order)
- Global filter expression
- StatsCat config: selected grouping column, selected variables
- Export config: column selection, renames, order

**What NOT to save:**
- The CSV file itself (too large; user re-drops it)
- Computed results (re-derived from analysis)

**Storage:** `localStorage` keyed by filename + size hash. JSON blob with a schema version for forward compatibility.

**UX flow:**
1. On analysis complete, auto-save project state (debounced, silent)
2. On file drop, check if a saved project matches the file signature
3. If match found, prompt: "Restore previous session?" — restores config and re-runs analysis
4. Manual save/load via a small toolbar control (download/upload `.bma.json` for sharing between machines)

**Architecture:**
- `saveProject()` — serializes config state to JSON, writes to `localStorage`
- `loadProject(file)` — parses JSON, validates schema version, applies config, triggers analysis
- `.bma.json` portable format — same JSON, downloaded/uploaded as file for cross-machine sharing
- No file content stored — project files are small (< 10 KB typically)

## 6. Block Index — analysis infrastructure

Build a per-block column statistics index during the existing analysis pass. Nearly free to compute (one min/max comparison per value per column), enables predicate pushdown for filtered re-analysis and random access for a table view.

Inspired by Parquet's row group statistics, but built on the fly from CSV — no format conversion needed.

### Index structure

```
blockIndex = {
  blockSize: 10000,          // rows per block
  totalRows: N,
  blocks: [
    {
      offset: <byte offset into decompressed text>,
      rows: 10000,
      min: Float64Array(nCols),   // per-column minimum in this block
      max: Float64Array(nCols),   // per-column maximum in this block
      nulls: Uint32Array(nCols)   // per-column null count in this block
    },
    ...
  ]
}
```

### Memory budget

At block size 10,000 rows with 50 columns:

| File rows | Blocks | Index memory |
|-----------|--------|-------------|
| 1M        | 100    | ~100 KB     |
| 10M       | 1,000  | ~1 MB       |
| 100M      | 10,000 | ~10 MB      |

Per block: 8 (offset) + 400 (min) + 400 (max) + 200 (nulls) + 4 (row count) = ~1,012 bytes.

### What it enables

**Predicate pushdown for filtered re-analysis.** On filter change, check each block's min/max against the filter predicate. Skip blocks that can't contain matching rows.

- Uncompressed CSV: skip I/O entirely for rejected blocks via `File.slice()`. A selective filter (10% of blocks match) reads 10% of the file. ~10x speedup.
- ZIP files: can't skip decompression, but skip field parsing for rejected blocks. Decompress + count `\n` to advance row counter, don't split/trim/Number(). ~2x speedup.

**Table view random access.** Byte offsets enable `File.slice(block.offset, nextBlock.offset)` for instant seek to any region of the file. For ZIP files: fast-forward the decompression stream counting newlines, parse only the target block.

**Block-level spatial heatmap (future).** If the file is spatially sorted (block models almost always are), each block corresponds to a spatial region. Min/max coordinates per block give a spatial extent. Could visualize "where are the high-grade blocks" from the index alone without re-reading data.

### Worker changes

- Maintain per-block running min/max/nulls alongside existing Welford accumulators
- At every block boundary (every N rows), snapshot stats into the index and reset
- Emit the completed block index as part of the `complete` message
- For re-analysis with a filter: accept the block index as input, use `File.slice()` to skip rejected blocks (CSV) or skip parsing for rejected blocks (ZIP)

### Categorical columns

Min/max is meaningless for categoricals. Options:
- Store nothing (skip predicate pushdown for categorical filters)
- Store a small set of distinct values per block (if < 20 unique, store them; otherwise mark as "overflow"). Enables pushdown for `r.LITO === 'BIF'` — skip blocks that don't contain 'BIF'.

## 7. Table View tab

Virtual-scrolling data browser. Render ~50 visible rows, on scroll seek to the relevant file region via the block index, parse and display.

**Architecture:**
- Uses block index byte offsets for random access
- `File.slice(offset, nextOffset)` for uncompressed CSV
- Fast-forward decompression + newline counting for ZIP
- Cache the current decompressed block in memory (~a few MB) so scrolling within a block is instant
- Applies active filter and calcol expressions to displayed rows
- Columns resizable, sortable-by-click (local sort within loaded chunk)

**UX:**
- Tab shows row count from analysis, scrollbar maps to full row range
- Click a row to inspect all field values in a detail pane
- Search/jump-to-row input
- Highlight rows that pass/fail current filter

---

## Future

### Parquet interop (optional sidecar)

Export analysis results or converted data as Parquet files for interop with Python, R, DuckDB, Spark. Import `.parquet` files for instant analysis (skip all text parsing — typed arrays straight from column chunks).

**Decision: use Parquet, don't reinvent it.** A custom binary format would gradually converge toward Parquet (dictionary encoding, column orientation, per-chunk statistics, delta encoding) but with more bugs and no ecosystem. Parquet gives 10-20x over CSV versus ~5-6x for a naive binary format, plus universal interop.

**Dependency:** `parquet-wasm` (~1MB WASM). Not bundled in the HTML — distributed as an optional sidecar file (`parquet.wasm` alongside `index.html`). Feature lights up if present, hides if absent. Lazy-loaded only when the user triggers import/export. Core BMA remains zero-dependency.

**Why not embed in the HTML:** No clean way to put binary blobs in HTML. Base64 adds 33% overhead. Polyglot files (binary appended after `</html>`) are fragile — "Save page as" strips the tail, email filters may sanitize it. The single-file identity is worth preserving for the core tool.

**Why not OMF:** Low adoption (essentially Seequent-only), imposes rigid structure that mining software can't consistently populate, and BMA's strength is being schema-agnostic.

**Custom metadata:** Use Parquet's key-value metadata section for BMA-specific fields: CRS, coordinate column tags, grade vs classification vs auxiliary column roles, parent block size, sub-block ratios. A `.bma` file extension that's internally valid Parquet — opens in BMA with full semantics, opens in any Parquet reader with raw data.

### Datamine (.dm) file support

Read Datamine binary block model files directly, without requiring a prior CSV export.

**Context:** Datamine `.dm` files are a fixed-record binary format with a header describing field names, types, and record layout. Many resource geologists have block models in `.dm` format and currently must export to CSV via Studio before loading into BMA.

**Architecture considerations:**
- `.dm` format: fixed-length records, 4-byte floats/ints, 8-char padded field names, header record describes schema
- Can be streamed via `File.slice()` + `DataView` — fits the existing streaming architecture
- Produces the same `{header, fields[]}` rows as CSV parsing, so downstream analysis is unchanged
- Would need a format detection step in the worker (check magic bytes / file extension) before choosing CSV vs DM parser

### Derived features from cached results (no re-scan)

Many high-value features can be computed from the existing `lastCompleteData` (t-digest centroids, stats, categories) without re-reading the file:

- **Grade-tonnage curves** — sweep cutoff grades against t-digest centroids. The #1 missing feature for resource geologists.
- **Histograms** — approximate frequency distribution from t-digest centroids. Complement to existing CDF plots.
- **Additional percentiles** (P5, P95, P99) — t-digest already supports arbitrary quantile queries.
- **Geometric mean / log statistics** — requires adding a `sum(ln(x))` accumulator to Welford during analysis, then computed in `finalizeAcc()`.
- **Sum/Total** — trivial: `mean * count`. Fundamental for resource quantification.
- **Correlation matrix** — requires adding streaming Pearson covariance accumulators (O(k^2) memory for k numeric columns). Feasible for typical block models (5-20 grade variables).

---

## Known issues from code review

**Bugs:**
- No `worker.onerror` handler — uncaught worker exceptions leave the analysis overlay stuck
- Stale `currentTypeOverrides`/`currentZipEntry`/`currentSkipCols`/`currentColFilters` not reset on new file load — File B can inherit config from File A
- `lastCompleteData` not cleared on new file — canceling analysis on a new file restores previous file's results
- `$errorMsg` hidden by CSS during re-analysis — non-filter worker errors vanish silently

**Code health:**
- Significant duplication between worker and main thread (delimiter detection, type detection, XYZ patterns, NULL sentinels, ZIP reading). XYZ patterns have already drifted. Consolidate via shared code injection into the worker template literal.
- Dead code: `sigfig()` in worker, `triggerPreflightAnalysis()` on main thread
- `_overflow` flag on category count objects collides with literal `"_overflow"` column values

**Performance:**
- XYZ coordinate Sets grow unbounded in worker memory (sub-blocked models with float noise). Needs sampling or cap.
- StatsCat complete message can reach 160MB+ (500 groups x 50 vars x 400 centroids). Consider streaming or chunking.
- `esc()` creates a temporary DOM element per call — replace with string substitution.
- StatsCat sidebar rebuilds full DOM + event wiring on every search keystroke

**UX:**
- Category checkbox → filter workflow is undiscoverable (no hint in UI)
- No autocomplete on filter input (calcol editor has it)
- No confirmation on calcol deletion
- No stale-results indicator on tabs after config changes
- Mobile: HTML5 drag-and-drop doesn't work for Export column reorder (needs touch fallback)
