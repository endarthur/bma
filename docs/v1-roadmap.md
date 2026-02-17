# V1 Roadmap — Feature Architecture

Tab bar: `Preflight · Summary · Calc · Statistics · Categories · StatsCat · Export · GT · Swath · Section`

## 1. Calc tab — done

Calculated columns with expression editor, live preview, autocomplete, editing, `fn.*` helpers.

## 2. StatsCat tab — done

Statistics grouped by categorical variable. Dropdown to select grouping column, per-group Welford + t-digest stats, CDF overlay plots, cross-tabulation mode (count/row%/col%), variable search and selection, group sort (count/name).

## 3. Export tab — done

Stream-export with column selection, renaming, drag-and-drop reordering. Format settings: arbitrary delimiter (presets + custom), quote character, line endings, null representation, number precision with truncation warning, decimal separator with conflict detection. Live preview of first 100 rows. Separate export worker. FSAA streaming path on supported browsers, Blob fallback otherwise.

## 4. Swath tab — needs polish

Functional but needs fixing and polishing. Spatial binning along a coordinate axis with per-bin statistics.

## 5. Section tab — needs overhaul

Exists but needs a full overhaul.

## 6. Project Save/Load — done

Auto-save to localStorage, manual save/load `.bma.json`, recent files with FSAA handle persistence.

## 7. Grade-Tonnage tab

Grade-tonnage curves and tables. The #1 missing feature for resource geologists — GT curves drive cutoff optimization and resource reporting.

### Concept

Sweep cutoff grades from low to high. At each cutoff, compute tonnage, mean grade, and contained metal for all blocks above the cutoff. Display as interactive chart + exportable table.

### Optional selections (require Generate)

Three optional inputs that change the computation, making a Generate button necessary:

1. **Density column** — numeric column for bulk density (t/m³). Tonnage = volume × density. If not selected, tonnage = volume (density assumed 1) or count-based if no geometry.
2. **Weight/proportion column** — numeric column for block weighting. Multiplicative factor: tonnage = volume × density × weight. Use cases: partial blocks in sub-block models, compositing weights, ore fraction.
3. **Local filter** — filter expression specific to the GT analysis, independent of the global filter. Common use: GT within a pit shell (`r.pit_shell <= 5`), within a geological domain (`r.LITO === 'oxide'`), or above a depth.

### Worker approach

Always a dedicated worker pass (not derived from cached centroids) — GT curves appear in financial reporting, so approximation errors are unacceptable.

**Streaming histogram approach (constant memory):**
1. First determine grade min/max (from cached `lastCompleteData.stats[gradeCol]`)
2. Allocate fine-grained histogram: N bins (e.g., 10,000) spanning `[min, max]`
3. Each bin stores: `totalTonnage`, `totalMetal` (grade × tonnage)
4. Stream file, apply global filter + local GT filter, for each passing row:
   - `grade = row[gradeCol]`
   - `volume = dx × dy × dz` (from geometry or DXYZ columns, or user-supplied constant)
   - `tonnage = volume × density × weight` (density/weight default to 1 if not selected)
   - `metal = grade × tonnage`
   - Bin index = `floor((grade - min) / binWidth)`
   - Accumulate `bins[i].tonnage += tonnage`, `bins[i].metal += metal`
5. Post-process: cumulative sum from right to left → `tonnageAbove[i]`, `metalAbove[i]`, `gradeAbove[i] = metalAbove[i] / tonnageAbove[i]`

**Memory:** ~240 KB for 10,000 bins regardless of file size. Streams the full file but only needs grade + density + weight + XYZ columns per row.

### Block volume resolution

Priority order:
1. Per-row DXYZ columns (sub-block models): `volume = row[dx] × row[dy] × row[dz]`
2. Detected geometry block size: `volume = geo.x.blockSize × geo.y.blockSize × geo.z.blockSize`
3. User-supplied constant (manual input in sidebar)
4. Fallback: count-based (tonnage = 1 per row, no volume)

### Layout

Sidebar + main, matching other tabs:

**Sidebar:**
- Grade variable selector (numeric columns dropdown)
- Density column (optional, dropdown with "—" default)
- Weight column (optional, dropdown with "—" default)
- Block volume display (auto-detected, with manual override input)
- Local filter textarea
- Cutoff range: min, max, step (auto-populated from grade stats, editable)
- **Generate** button

**Main:**
- GT chart (SVG): cutoff on X-axis, tonnage on left Y-axis, grade on right Y-axis, optional metal curve. Interactive crosshair showing values at cursor position.
- GT table below chart: cutoff, tonnage (Mt), grade (mean above cutoff), metal (tonnage × grade), % of total tonnage. Sortable, copyable, exportable.
- Progress bar during generation.

### Project save/load

Persist: grade column (by name), density column, weight column, local filter, cutoff range/step, volume override.

## 8. Histograms in Statistics tab

Approximate frequency histograms from cached t-digest centroids. No file re-read needed.

### Concept

Reconstruct an approximate frequency distribution from the t-digest centroids already stored in `lastCompleteData`. Each centroid represents a cluster of nearby values with a known count — redistribute centroid mass into histogram bins using linear interpolation between centroid means.

### Architecture

- **Bin count selector**: dropdown or input (20, 50, 100 bins, or auto based on Freedman-Diaconis / Sturges rule using cached stats)
- **Data source**: `lastCompleteData.stats[colIdx].centroids` — array of `[mean, count]` pairs, already sorted
- **Rendering**: SVG bar chart in the CDF panel area. Toggle between CDF and Histogram view (or show both stacked).
- **Multi-variable overlay**: same variable selection as CDF — click column names to toggle. Semi-transparent bars or side-by-side grouped bars.
- **Axis**: X = value range, Y = frequency (count) or density (normalized). Toggle between count and density.

### Integration with Statistics tab

- Add CDF/Histogram toggle buttons to the CDF toolbar (alongside Linear/Log scale)
- Histogram shares the same variable selection (click column headers to add/remove)
- SVG/PNG download works for histogram too
- Log scale applies to X-axis (useful for lognormal grade distributions)

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

Features computable from existing `lastCompleteData` without re-reading the file:

- **Additional percentiles** (P5, P95, P99) — t-digest already supports arbitrary quantile queries.
- **Geometric mean / log statistics** — requires adding a `sum(ln(x))` accumulator to Welford during analysis, then computed in `finalizeAcc()`.
- **Sum/Total** — trivial: `mean * count`. Fundamental for resource quantification.
- **Correlation matrix** — requires adding streaming Pearson covariance accumulators (O(k^2) memory for k numeric columns). Feasible for typical block models (5-20 grade variables).

Note: Grade-tonnage curves (section 7) and histograms (section 8) have been promoted to full feature sections above.

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
