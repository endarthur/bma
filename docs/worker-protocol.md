# Worker Protocol Reference

## Messages to Worker

```javascript
worker.postMessage({
  file,           // File object (transferred)
  xyzOverride,    // {x,y,z} | null
  filter,         // {expression: string} | null
  typeOverrides,  // {colIdx: 'numeric'|'categorical'} | null
  zipEntry,       // string (zip entry name) | null
  skipCols,       // number[] | null
  colFilters,     // {colIdx: {skipZeros, skipNeg}} | null
  calcols         // [{name, expr, type}] | null
});
```

## Messages from Worker

### `header` — column metadata after type detection

```javascript
{
  type: 'header',
  header,        // string[] — column names
  delimiter,     // string
  colTypes,      // string[] — 'numeric'|'categorical'
  xyzGuess,      // {x, y, z} — auto-detected coordinate column indices
  rowVarName,    // string — 'r' or alternative if 'r' collides
  calcolCount,   // number
  origColCount   // number — columns from the file (excludes calcols)
}
```

### `progress` — streaming progress updates

```javascript
{ type: 'progress', percent, rowCount }
```

### `complete` — final analysis results

```javascript
{
  type: 'complete',
  stats,          // { [colIdx]: StatsObject } — numeric column stats
  geometry,       // grid geometry detection results
  coordOrder,     // coordinate ordering info
  maxDecimals,    // max decimal places detected
  categories,     // { [colIdx]: { [value]: count } }
  rowCount,       // rows passing filter
  totalRowCount,  // total rows in file
  commentCount,   // comment/blank lines skipped
  elapsed,        // analysis time in ms
  rowVarName,     // string
  header,         // string[] — includes calcol names
  colTypes,       // string[] — includes calcol types
  xyzGuess,       // {x, y, z}
  zipName,        // string | null
  calcolCount,    // number
  origColCount    // number
}
```

### `error` — error reporting

```javascript
{ type: 'error', message }
```

## Stats Object (per numeric column)

```javascript
{
  count,                        // non-null values
  nulls,                        // null/empty/NaN count
  zeros,                        // zero-value count
  min, max, mean, std,          // basic statistics
  skewness, kurtosis,           // sample-corrected higher moments
  quantiles: { p10, p25, p50, p75, p90 },
  centroids: [[mean, count], ...]  // t-digest centroids for CDF plotting
}
```

Calcol stats use indices `origColCount + calcolIndex` as keys in the `stats` object.
