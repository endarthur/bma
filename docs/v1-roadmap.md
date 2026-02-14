# V1 Roadmap — Feature Architecture

Tab bar: `Preflight · Summary · Calc · Statistics · Categories · StatsCat · Export`

## 1. Calc tab — done

Calculated columns with expression editor, live preview, autocomplete, editing, `fn.*` helpers.

## 2. StatsCat tab — done

Statistics grouped by categorical variable. Dropdown to select grouping column, per-group Welford + t-digest stats, CDF overlay plots, cross-tabulation mode (count/row%/col%), variable search and selection, group sort (count/name).

## 3. Export tab — done

Stream-export with column selection, renaming, drag-and-drop reordering. Separate export worker (doesn't interfere with analysis worker). FSAA streaming path on supported browsers, Blob fallback otherwise. Applies active filters and evaluates calcol expressions during export.

## 4. Swath tab — next priority

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

---

## Future

### Datamine (.dm) file support

Read Datamine binary block model files directly, without requiring a prior CSV export.

**Context:** Datamine `.dm` files are a fixed-record binary format with a header describing field names, types, and record layout. Many resource geologists have block models in `.dm` format and currently must export to CSV via Studio before loading into BMA.

**Architecture considerations:**
- `.dm` format: fixed-length records, 4-byte floats/ints, 8-char padded field names, header record describes schema
- Can be streamed via `File.slice()` + `DataView` — fits the existing streaming architecture
- Produces the same `{header, fields[]}` rows as CSV parsing, so downstream analysis is unchanged
- Would need a format detection step in the worker (check magic bytes / file extension) before choosing CSV vs DM parser
