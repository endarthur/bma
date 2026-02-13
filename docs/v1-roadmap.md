# V1 Roadmap — Feature Architecture

Target tab bar: `Preflight · Summary · Calc · Statistics · StatsCat · Swath · Categories · Export`

(Or fold Categories into StatsCat for 7 tabs.)

## 1. Calc tab — done

Calculated columns with expression editor, live preview, autocomplete, editing, `fn.*` helpers.

## 2. StatsCat tab — next priority

Statistics grouped by categorical variable. "Show me grade stats by lithology/domain."

**Architecture:**
- One streaming pass in worker, `Map<categoryValue, StatsAccumulator>` per numeric column
- Same Welford + t-digest already implemented
- UI: dropdown to select grouping column, table per numeric column with one row per category value
- Consider folding the existing Categories tab into this (Categories = "no numeric selected" view) to reduce tab count

**Worker changes:**
- New `statsCat` section in worker: accept `groupBy: colIndex`, accumulate per-group stats
- Output: `{ [numColIdx]: { [categoryValue]: statsObject } }`

## 3. Swath tab

Spatial binning along a direction vector with per-bin statistics.

**Architecture:**
- Project coordinates onto user-defined vector (azimuth/dip), bin by distance
- One streaming pass, `Map<binIndex, StatsAccumulator>` per variable
- UI: azimuth/dip inputs, slice width, variable selection, optional local filter
- Output: line charts (mean ± std or P25/P50/P75 ribbons) via canvas

## 4. Export tab

CSV export with column selection, reordering, renaming.

**Architecture:**
- Stream through rows, evaluate calcol expressions, write selected columns
- UI: column checklist with output name editing, drag-to-reorder
- Conflict detection if multiple columns map to same output name
- Download as CSV blob
