# I/O Architecture — Row Sources, Sidecar Index, Fixed-Width

Design note, 2026-06. Status: **§1 row-source split implemented 2026-06-11**
(see §1 status note); §2–§3 planned. Captures the direction agreed after
profiling the .dm path.

## Problem

Every analysis pass (analyze, swath, GT, section, export, aux) re-streams
the source file and carries its own copy of the same loop: format
detection, delimiter sniff, line split, `buildRow`, filter/weight/calcol
plumbing, then its accumulators. Format decoding and statistics are
interleaved, so every new format pays the text-pipeline tax.

The .dm path makes this concrete. `extractCSVFromDM` (worker.js) converts
binary pages into a *synthesized CSV text stream*, which then goes through
the normal CSV parser. Per numeric value: `getFloat32` → `String(v)` →
UTF-8 encode → UTF-8 decode → split/trim/unquote → `Number(v)`. Measured
costs (Node, 2M values):

| step | cost |
|---|---|
| `getFloat32` direct | 28 ms |
| `String(float32-promoted double)` | 630 ms, avg **17.1 chars** (promotion noise: 55.3f → "55.29999923706055") |
| `Number(...)` re-parse of those | 313 ms |
| same values as 2dp CSV text | 342 + 227 ms, avg 4.9 chars |

So the text round-trip is ~30× the binary read it wraps, and the
synthesized CSV is ~3.5× more text than the equivalent real CSV. On top of
that, the virtual stream awaits one `file.slice(off, off+2048).arrayBuffer()`
**per DM page** — ~524k async round-trips per GB, vs ~1–2k chunks for
`file.stream()` on a CSV.

### Near-term .dm patches (independent of the refactor)

Cheap, contained, can land anytime:

1. **Batch page reads** — slice ~2 MB (≈1000 SP pages) per pull instead of
   one page. Kills the 500k-await problem. ✅ **DONE 2026-06-11** (with the
   B1 split; verified bit-identical incl. multi-batch and truncated-page
   cases in `experiments/b1-differential.js`).
2. **Stringify at float32 precision** — `toPrecision(7)`-style shortest
   output instead of `String(v)`. Float32 carries ~7.2 significant digits;
   the other 10 are promotion noise. Shrinks the virtual CSV ~3× and
   speeds both stringify and re-parse. **Deliberately NOT landed with B1**:
   it changes the parsed doubles (`String→Number` round-trips exactly;
   `toPrecision(7)` does not), so it breaks bit-identity — needs its own
   accuracy decision.

## 1. Row-source split (prerequisite)

> **Status: implemented 2026-06-11 (B1).** `makeRowSource()` /
> `streamCsvLines()` / `forEachRow()` in `src/worker.js` own container
> extraction (zip/.dm), delimiter+header sniff, row-variable choice, calcol
> compilation, `buildRow`, and the line loop incl. the unterminated-tail
> handling; all seven passes consume it. Passes kept their filter ordering,
> the weight-ordinal contract, and accumulators verbatim. Verified
> bit-identical against the pre-split worker over all modes
> (`experiments/b1-differential.js`, 29 cases). **Not yet done:** the
> binary `DmRowSource` below — .dm still flows through the synthesized-CSV
> text pipeline (now with batched page reads). Going binary changes
> observable outputs (decimal-precision detection reads field strings), so
> it rides on a later step where passes stop re-parsing raw fields.

Separate *format decoding* from *statistics*. A source owns everything up
to and including producing a row object; passes own everything after.

```javascript
// sketch
const source = makeRowSource(file, {
  zipEntry, dmEndianness, dmFormat,   // format config
  resolvedTypes, calcolCode, calcolMeta,
  globalFilter, localFilter, weightColName
});
await source.forEachRow((row, weight) => { /* accumulate */ },
                        (percent) => { /* progress */ });
```

Contract that must survive: **row objects with named properties**, because
filters and calcols are user JS (`r.Fe > 30`). The win is everything
before the row object, not after.

Sources:

- `CsvRowSource` — current text pipeline, extracted once instead of five
  times.
- `DmRowSource` — reads floats/strings straight off page buffers into row
  objects. No stringify, no UTF-8 round trip, no `Number()`. This is the
  real .dm fix (the near-term patches above become obsolete on this path).
- `FixedWidthRowSource` — see §3.
- Future binary/columnar sources slot in the same way.

Mechanical but large: worker.js's five passes share ~80% of their
streaming boilerplate. Highly testable — same inputs must produce
bit-identical outputs per pass.

## 2. Sidecar index (`<name>.bmaidx`)

> **Reframed 2026-06-21 (Arthur):** §2 + §3 are largely **superseded by adopting
> parquet** (B2) as the on-disk format inside an FSAA-mounted project folder
> (`docs/fsaa-project-folders.md`). Parquet files already carry per-row-group
> zone maps (min/max), are columnar (column projection), and are seekable by row
> group (parallel scans) — i.e. *the metadata this sidecar would hand-build for
> CSV comes for free when the data is parquet.* The `ParquetRowSource` drops into
> the §1 seam where `DmRowSource`/`FixedWidthRowSource` were planned. Keep §2/§3
> only for the case of plain CSVs the user won't convert; the primary path is
> convert-to-parquet-in-the-folder-on-import. The pieces below still describe the
> shape of the metadata (now parquet's, not ours).

Parquet-style chunk metadata for files people already have, generated on
first analysis. No second copy of multi-GB data, works for plain CSV.

Per chunk (target ~64K rows or ~8 MB, newline-aligned for text):

- **byte offset + row count** — random access; enables parallel scans of
  plain CSV (see Parallelism below).
- **zone maps** — per numeric column min/max; per categorical column the
  distinct set (capped, with overflow flag). This is the "basic stats to
  help with filtering": a chunk is skipped only when the filter *provably*
  cannot match it.
- optionally per-chunk Welford state + t-digest, so an unfiltered Analyze
  merges chunk stats without touching the data at all.

File-level: column names/types (skip preflight re-detection), total rows,
detected delimiter, format tag.

**Predicate extraction.** Filters are arbitrary JS, so pushdown cannot be
total. Extract conservative conjunctive clauses from the common shapes —
`r.X > c`, `r.X >= c`, `<`, `<=`, `===`/`!==` on categoricals, joined by
`&&` — and evaluate them against zone maps. Anything unrecognized
contributes no pruning (full scan), never a wrong skip. Same playbook as
Parquet/ORC readers.

> **Better than shape-matching (2026-06-21, Arthur):** route the filter/calcol
> DSL through an **expression IR** (`../auditable/ext/air`) instead of compiling
> straight to `new Function`. The IR is *analyzable* — walk it for the clauses
> above (principled, not regex shapes), still compile it to JS for the row path,
> and it's the same IR that enables the parquet **vectorized fast path** (no
> calcols + pushdown-able filter ⇒ stay columnar, skip row groups). This is the
> `air`/pushdown phase of **C12** (`docs/derivation-lineage.md`); sequence with B2.

**Staleness/identity.** Sidecar records data-file size + `lastModified` +
hash of first/last N bytes. Mismatch ⇒ index ignored and rebuilt. Fits the
existing recents/FSAA-handle machinery; for drag-dropped Files without a
handle the index lives in IndexedDB keyed by the same identity tuple.

**Parallelism.** Chunk offsets make any indexed file seekable, so a pass
can fan out N workers over chunk ranges and merge accumulators. Welford
states, counts/sums, and t-digests all merge; category maps union. This is
the largest absolute speedup available (≈ cores ×) and falls out of the
index + row-source work.

## 3. Fixed-width conversion (CSV ⇄ fixed width)

Optional "make my file ideal" tool for users who want to keep data as
text. Honest accounting: single-threaded parse gain over CSV is only
~1.5–2.5× (still bytes → string → `Number()`; saved work is delimiter
scanning, quote/trim handling, offset arithmetic instead of split). The
real value is **seekability without an index**: fixed record size ⇒ exact
byte ranges per worker, sampling without scanning, binary search on a
sorted column.

- Export side: new layout option in the Export tab (fixed column widths,
  padding, precision — the precision/null machinery already exists).
  GSLIB/Datamine users are at home with this.
- Import side: `FixedWidthRowSource` + a width spec (sniffed from ruled
  header or user-defined in preflight).

## Sequencing

1. Row-source split — prerequisite, deletes duplicated code. ✅ DONE
   2026-06-11 (text pipeline; the binary `DmRowSource` decode that buys the
   ~10×+ on .dm is still ahead — see §1 status note).
2. Sidecar index — speeds every format including existing CSVs; enables
   predicate skipping and parallel scans.
3. Fixed-width conversion — optional last; with the index in place,
   plain CSV already gets most of the seekability benefit.

(Near-term .dm patches from §0 can land before any of this.)
