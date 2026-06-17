# Worker Protocol Reference

The worker (`src/worker.js`) is a single dispatcher routed by `e.data.mode`:

| `mode` | Function | Purpose |
|--------|----------|---------|
| *(absent)* | `analyze()` | Full stats/geometry/categories pass (default) |
| `'swath'` | `swathAnalysis()` | Multi-direction swath binning |
| `'declus'` | `declusAnalysis()` | GSLIB DECLUS cell declustering weights |
| `'colvalues'` | `colValuesAnalysis()` | Sorted values of one column (top-cut input) |
| `'section'` | `sectionAnalysis()` | Slice blocks for the Section view |
| `'gt'` | `gtAnalysis()` | Grade-tonnage curves |
| `'export'` | `exportCSV()` | Filtered CSV re-export |
| `'prepare-pack'` | `preparePack()` | CRC-32 + optional deflate for the zip packer |

Every mode reports failures as `{ type: 'error', message }`.

## Common Conventions

- **File sources** — `file` may be a CSV/TXT, a `.zip` (`zipEntry` selects an entry by name; otherwise first CSV/TXT/DAT/TSV entry; zip64 and stored/deflate supported), or a Datamine `.dm` (`dmEndianness: 'little'|'big'`, `dmFormat: 'sp'|'ep'`). ZIP/DM extraction posts `{ type: 'progress', percent: 0, rowCount: 0, note }` setup messages in **all** modes.
- **Parsing** — lines starting `#` are comments; first non-comment line is the header; delimiter auto-detected from a 20-line sample. Values in the `NULL_SENTINELS` set (`''`, `NA`, `-999`, `*`, …) parse to null/NaN for numeric columns.
- **Row variable** — filter/calcol expressions are compiled against a row object. Name defaults to `'r'` (first non-colliding of `r, d, row, _r, _d`). `rowVarOverride` fixes it (e.g. `'aux'` for the aux dataset pass) — accepted by `analyze`, `swath`, `declus`, `colvalues`, `section`; **not** by `gt` or `export`.
- **Calcols** — `calcolCode` (string code block) + `calcolMeta` (`[{name, type}]`). Compiled as `new Function(rowVarName, MATH_PREAMBLE + calcolCode)`; mutates the row object by name. Compile errors silently disable calcols; per-row runtime errors are swallowed. Calcol columns occupy **extended indices** `origColCount + i` (extended header = raw header + calcol names).
- **Filters** — global filter is `{ expression: string }`; the secondary modes (`swath`, `section`, `gt`) additionally take `localFilter` as a **bare expression string**. Both compile with a try/catch wrapper that returns `false` on runtime error; compile errors abort with an `error` message.
- **Resolved types** — only `analyze` detects column types. All other CSV-reading modes require `resolvedTypes` (the `colTypes` from a prior analyze) in the input message.

## Weight Contract (`analyze`, `swath`, `colvalues`)

Two mutually exclusive weight sources; `weightArray` takes precedence:

- `weightColName` — **name** of a raw column or calcol. Resolved against the extended header; unknown names → unweighted.
- `weightArray` — `Float64Array` of computed weights (e.g. from `declus-complete`) indexed by **filter-surviving row ordinal**: the ordinal counter increments exactly when a row passes the *global* filter (in `swath` this is before the local filter, matching the declus pass's row space). The array must come from a pass over the same file with the same global filter or ordinals misalign.

Per row: a missing/non-numeric/non-finite/`<= 0` weight (or NaN array entry) **excludes the row** from stats. `analyze` and `colvalues` count exclusions in `weightExcluded`; `swath` drops them silently. `analyze` additionally guards ordinal misalignment: its `complete` message carries `weightArrayMismatch: { expected, got } | null` when the array length doesn't match the rows consumed.

**Weighted estimator semantics** — weighted runs report *population-form* variance/std/skewness/kurtosis (count-based small-sample corrections don't apply to arbitrary-scale weights); unweighted runs keep the classic sample-corrected forms. T-digest centroids carry fractional weights, so quantiles/CDF are weighted too.

## Mode: default (`analyze`)

```javascript
worker.postMessage({
  file,              // File (CSV/TXT/ZIP/.dm)
  xyzOverride,       // {x,y,z} raw indices | null (else name-based guess + numeric fallback)
  filter,            // {expression: string} | null — global filter
  typeOverrides,     // {colIdx: 'numeric'|'categorical'} | null — forced cols skip detection;
                     //   if ALL cols are forced, the detection warmup is skipped entirely (zero row loss)
  zipEntry,          // string | null
  skipCols,          // number[] | null — raw columns excluded from stats/categories
  colFilters,        // {extIdx: {skipZeros, skipNeg}} | null — per-column value filters (matches count as nulls)
  calcolCode,        // string | null
  calcolMeta,        // [{name, type}] | null
  groupBy,           // extended col index | null — per-group stats + cross-tabs
  groupStatsCols,    // number[] (extended indices) | null — restrict which columns are grouped
  dxyzOverride,      // {dx,dy,dz} raw indices | null
  dmEndianness, dmFormat,
  rowVarOverride,    // string | null — e.g. 'aux'
  weightColName,     // string | null — see Weight Contract
  weightArray,       // Float64Array | null
  weightArrayLabel   // string | null — echoed back as weightApplied when weightArray is used
});
```

Type detection samples rows until every non-forced column has ≥20 non-null values (max 100k rows); **detection rows are excluded from stats** (negligible on block models — force all types to avoid the loss on small files). If the stream ends with types still unresolved (tiny file, or an all-empty column that can never reach 20 values), the worker resolves from what it saw and **replays the stream for the stats pass**, so those files get complete stats instead of none (A8, 2026-06-11; before this fix any sub-100k-row file containing an all-empty column analyzed to all-zero stats). Files over 100k rows with an empty column still lose the first 100k rows to detection — the pre-existing cap semantics.

### `header` — posted once types resolve

```javascript
{
  type: 'header',
  header,        // string[] — EXTENDED (raw + calcol names)
  delimiter,     // string
  colTypes,      // string[] — extended, 'numeric'|'categorical'
  xyzGuess,      // {x, y, z} raw indices (-1 if unresolved)
  rowVarName,    // string
  calcolCount,   // number
  origColCount   // number — raw columns only
}
```

### `progress` — every 25k rows

```javascript
{ type: 'progress', percent, rowCount }   // rowCount = total data rows seen
```

### `complete`

```javascript
{
  type: 'complete',
  stats,               // { [extIdx]: StatsObject } — numeric columns + numeric calcols
  geometry,            // { isRegularGrid, x|y|z: {origin, max, blockSize, minBlockSize,
                       //   subBlockSizes, isSubBlocked, uniqueCount, gridCount, extent,
                       //   decimals, regularity} } | null
                       //   (computed from ALL rows — geometry ignores the filter)
                       //   A10 4f: `regularity` = dominant spacing's share of gaps between
                       //   sorted unique coords per axis (~1 regular grid, ~0 scatter);
                       //   `isRegularGrid` = all 3 axes have blockSize AND regularity>=0.5.
                       //   Computed for ANY XYZ dataset; the main thread's dsGridMode decides
                       //   whether it counts as a grid (model='grid', else 'auto'→isRegularGrid).
  coordOrder,          // {fastest, middle, slowest, transitions, sampleSize} | null
  maxDecimals,         // {x, y, z}
  categories,          // { [extIdx]: { counts: {value: count}, overflow: bool } }
                       //   counting stops past 500 unique values (overflow = true)
  rowCount,            // rows passing filter AND weight checks
  totalRowCount,       // all data rows in file
  commentCount,        // '#' lines skipped
  elapsed,             // ms
  rowVarName,
  weightApplied,       // weightArrayLabel | resolved weight column name | null (unweighted)
  weightExcluded,      // rows dropped for invalid weight
  weightArrayMismatch, // {expected, got} | null — ordinal guard, see Weight Contract
  header, colTypes,    // extended, as in 'header'
  xyzGuess,
  zipName,             // extracted zip entry name | null
  calcolCount, origColCount,
  groupStats,          // { [extIdx]: { [groupValue]: StatsObject } } | null (max 500 groups/col)
  groupCategories,     // { [extIdx]: { [groupValue]: {value: count} } } | null
  groupBy,             // echoed groupBy index | null
  dxyzGuess            // {dx, dy, dz} raw indices (-1 if unresolved)
}
```

### Stats Object (per numeric column)

```javascript
{
  count,                        // accepted values (rows, not weight)
  sumW,                         // total weight (= count when unweighted)
  nulls,                        // null/NaN/sentinel + colFilter-skipped values
  zeros,
  min, max, mean,
  std, skewness, kurtosis,      // sample-corrected; POPULATION form when weighted
  quantiles: { p10, p25, p50, p75, p90 },   // t-digest, weighted
  centroids: [[mean, count], ...]           // t-digest centroids (counts may be fractional)
}
```

**T-digest accuracy contract (since 2026-06-11):** a digest is EXACT (one
centroid per distinct value) until it has seen more than 20 000 distinct
values — typical aux sample sets and quantized grade columns never
lossy-compress. Beyond that it degrades to a merging digest (Dunning bound,
δ = 300): ≲0.05 % relative error across p01–p99, sharpest in the tails,
~1–2k centroids. Centroids with exactly equal means always merge
(lossless). Same machinery backs the per-bin swath digests.

## Mode: `'swath'`

```javascript
worker.postMessage({
  mode: 'swath', file, zipEntry, dmEndianness, dmFormat,
  globalFilter,      // {expression} | null
  localFilter,       // bare expression string | null
  calcolCode, calcolMeta, resolvedTypes,
  xyzCols,           // [xIdx, yIdx, zIdx] raw indices
  varCols,           // extended indices of variables to bin
  directions,        // [{ key, axis: 0|1|2|null, dir: [dx,dy,dz]|null, binWidth }]
  rowVarOverride, weightColName, weightArray
});
```

All directions are binned in **one streaming pass**. Per direction: `axis != null` reads that coordinate column directly; otherwise the row's XYZ is projected onto the unit vector `dir` (only components with `|d| > 1e-12` require finite coordinates). Bins are **coordinate-anchored**: `binIdx = floor(coord / binWidth)`, `center = (binIdx + 0.5) * binWidth` — separate passes (model vs aux) over the same direction align exactly.

Weight ordinals are counted at *global*-filter acceptance, before the local filter (see Weight Contract). Invalid weights exclude the row silently (no counter).

```javascript
{ type: 'swath-progress', percent }
{
  type: 'swath-complete',
  results,   // { [direction.key]: { [varIdx]: bins[] } } — varIdx = extended index from varCols
  elapsed
}
// bins[] sorted by center; empty bins omitted:
// { center, count,            // count = raw rows, even when weighted
//   mean, std,                // weighted; population std when weighted, sample otherwise
//   centroids }               // [[mean, count], ...] t-digest per bin
```

## Mode: `'declus'`

Faithful port of GSLIB `declus.for`: sweeps `ncell + 1` cell sizes from `cellMin` to `cellMax`, averages inverse-cell-count weights over `noff` diagonal origin offsets, picks the size whose declustered mean is lowest (or highest). The naive mean is the incumbent — if no size beats it, weights stay 1 and `optCellSize` is 0.

```javascript
worker.postMessage({
  mode: 'declus', file, zipEntry, dmEndianness, dmFormat,
  globalFilter, calcolCode, calcolMeta, resolvedTypes,
  xyzCols,       // [x, y, z] raw indices; z may be -1 → 2D (z treated as 0)
  varColName,    // NAME (raw or calcol) — error if not found
  cellMin, cellMax,  // auto when unset: span/100 .. span/2 of largest extent
  ncell,         // sweep steps (default 24; 1 = single-size mode)
  noff,          // origin offsets (default 8)
  anisy, anisz,  // cell anisotropy (default 1)
  iminmax,       // 1 = maximize declustered mean, else minimize
  pinnedCell,    // >0 → recompute weights at exactly this size, overriding the
                 //   sweep optimum (the sweep curve is still returned for display)
  rowVarOverride
});
```

Errors if fewer than 2 rows have finite XYZ + variable.

```javascript
{ type: 'declus-progress', percent }   // 0–50 streaming, 50–100 sweep
{
  type: 'declus-complete',
  weights,          // Float64Array (buffer TRANSFERRED), indexed by filter-surviving
                    //   row ordinal; normalized to mean 1 over located rows;
                    //   NaN for rows without finite XYZ + variable (→ excluded +
                    //   counted when applied downstream, like any invalid weight)
  n,                // ordinal-space size = all global-filter-surviving rows
  located,          // rows with finite XYZ + variable (nd)
  curve,            // [[cellSize, declusteredMean], ...] — first entry [0, naiveMean]
  optCellSize,      // chosen size (0 = naive mean never beaten)
  declusteredMean, naiveMean,
  pinned,           // bool — pinnedCell was applied
  usedRange,        // [cmin, cmax, ncell, noff] actually used
  wtMin, wtMax, elapsed
}
```

## Mode: `'colvalues'`

Streams the file once and returns the **sorted** finite values of one column (raw or calcol) after the global filter — the exact-distribution input for top-cut analysis.

```javascript
worker.postMessage({
  mode: 'colvalues', file, zipEntry, dmEndianness, dmFormat,
  globalFilter, calcolCode, calcolMeta, resolvedTypes,
  varColName,        // NAME — error if not found
  rowVarOverride, weightColName, weightArray   // see Weight Contract
});
```

```javascript
{ type: 'colvalues-progress', percent }   // 0–90
{
  type: 'colvalues-complete',
  values,          // Float64Array, sorted ascending (buffer TRANSFERRED)
  weights,         // Float64Array | null — present iff weighted; permuted with the
                   //   sort so weights[i] pairs values[i] (buffer TRANSFERRED)
  n,               // global-filter-surviving rows (the weight ordinal space)
  finite,          // values.length — rows with a finite variable value
  weightExcluded,  // rows dropped for invalid weight (checked BEFORE the variable read)
  elapsed
}
```

## Mode: `'section'`

```javascript
worker.postMessage({
  mode: 'section', file, zipEntry, dmEndianness, dmFormat,
  globalFilter, localFilter,   // {expression} / bare string
  calcolCode, calcolMeta, resolvedTypes,
  xyzCols,       // [x, y, z] raw indices
  dxyzCols,      // [dx, dy, dz] raw indices | null (-1 entries allowed)
  normalAxis,    // 0|1|2 (x|y|z) — z = plan (h=x,v=y); x = h=y,v=z; y = h=x,v=z
  slicePos,
  tolerance,     // full slab width; rows kept within slicePos ± tolerance/2
  varCol,        // RAW column index for the colored variable
  rowVarOverride
});
```

```javascript
{ type: 'section-progress', percent }
{
  type: 'section-complete',
  blocks,        // [{ h, v, dh, dv, val }] — dh/dv 0 when no dim column; val null when non-numeric
  hAxis, vAxis,  // 'x'|'y'|'z'
  normalAxis,    // echoed (number)
  slicePos, blockCount, elapsed
}
```

## Mode: `'gt'`

```javascript
worker.postMessage({
  mode: 'gt', file, zipEntry, dmEndianness, dmFormat,
  globalFilter, localFilter,   // {expression} / bare string
  calcolCode, calcolMeta, resolvedTypes,
  gradeCols,     // extended indices of grade variables
  gradeRanges,   // [{min, max}] parallel to gradeCols
  densityCol,    // extended index | null/-1
  densityConst,  // t/m³ — takes precedence over densityCol when > 0
  weightCol,     // extended index | null/-1 — per-row tonnage multiplier (invalid → 1)
  dxyzCols,      // [dx, dy, dz] raw indices | null
  blockVolume,   // constant volume used when no dxyzCols
  groupByCol     // extended index | null — per-category curves (max 200 groups)
});
// no rowVarOverride — always primary context
```

Per row: `tonnage = volume × density × weight` where volume = `|dx·dy·dz|` (else `blockVolume`, else 1) and density defaults to 1. Each grade variable gets 10 000 bins across its `[min, max]`; results are cumulative-above-cutoff.

```javascript
{ type: 'gt-progress', percent }
{
  type: 'gt-complete',
  gradeResults: [{
    colIdx, colName,
    results,        // [{cutoff, tonnage, grade, metal}] × 10000 (ascending cutoff)
    totalTonnage,
    gradeMin, gradeMax, binWidth,
    groupResults    // { [groupValue]: {results, totalTonnage} } | null
  }],
  grouped,          // bool
  groupByColName,   // string | null
  elapsed
}
```

## Mode: `'export'`

```javascript
worker.postMessage({
  mode: 'export', file, zipEntry, dmEndianness, dmFormat,
  filter,          // {expression} | null
  calcolCode, calcolMeta, resolvedTypes,
  exportCols,      // [{name, outputName}] — name = row property (raw column or calcol)
  delimiter,       // output delimiter (default ',')
  includeHeader,   // default true
  commentLines,    // string[] | null — emitted as '# ...' lines before the header
  quoteChar,       // default '"'; '' disables quoting
  lineEnding,      // default '\n'
  nullValue,       // string written for null/NaN (default '')
  precision,       // number | null — toFixed on numbers
  decimalSep       // default '.'
});
// no rowVarOverride — always primary context
```

```javascript
{ type: 'export-chunk', csv }              // string chunks: comments, header, then ~5000-row batches
{ type: 'export-progress', percent, rowCount }
{ type: 'export-complete', rowCount, elapsed }
```

## Mode: `'prepare-pack'`

Pack preparation for the zip writer: per file, one streaming pass computes the CRC-32 of the raw bytes and (optionally) a `deflate-raw` compressed copy via `CompressionStream` on a tee'd branch.

```javascript
worker.postMessage({ mode: 'prepare-pack', files: [{ blob, deflate }] });
```

```javascript
{ type: 'pack-progress', percent }     // whole-percent ticks over total raw bytes
{ type: 'pack-prepared', results }     // [{ crc, comp }] — crc = uint32 of raw bytes,
                                       //   comp = deflated Blob | null (stored)
```
