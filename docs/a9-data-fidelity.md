# A9 — Data-fidelity pass: audit findings + plan

2026-06-11. Triggered by A8: the empty-column report exposed that the analyze
worker's type-detection phase skipped rows from stats, and in the starved case
zeroed everything. Arthur asked: "are there any other surprises like this
lurking around?" This is the systematic answer — every place the pipeline
silently drops, substitutes, or reinterprets data, found by reading every
pass in `src/worker.js` plus the preflight/main-thread parsing.

Principle (same as A7's consistency report and A8): **inference and loss must
be visible**. Dropping a row or nulling a value can be correct behavior —
doing it without a counter or badge is not.

**Standing rule (Arthur, 2026-06-11):** no silent "acceptable losses"
anywhere in BMA. If a loss or limitation seems genuinely necessary, it gets
confirmed explicitly before landing and registered here (the "Accepted
limitations" section below) or in `worker-protocol.md` — a code comment
alone is not documentation. Context: a comment-buried "acceptable
limitation" caused serious damage in the auditable project (May 2026), and
the worker's own "negligible row loss" comment hid the A8 bug.

## Findings

### F1 — Detection-phase row loss (model analyze) — the A8 trigger, partially fixed
- A8 fixed the starvation case (stream ends unresolved → replay; previously
  all-zero stats on any <100k-row file with an empty column).
- **Still open**: when detection resolves mid-stream, the warmup rows (≥20,
  up to 100k with a sparse column) are excluded from model stats. The aux
  pass already solved this — it forces all types from preflight and the
  worker skips detection entirely (`forced.size >= nCols` fast path, zero
  loss). The model path sends only user toggles.
- **Fix (Phase 1)**: `startAnalysis` sends preflight's effective types
  (autoTypes + user overrides) for every column, exactly like `auxtab.js`.
  Main-thread only; worker untouched; b1-differential stays green.
  Add a marker key to `analysisFingerprint()` so stale IDB caches re-analyze.
  Consequence: model stats include the warmup rows (≤20 rows on healthy
  files) — displayed decimals can shift; manual screenshots drift
  microscopically (regen at the standing manual pass).
- Trade accepted: typing authority becomes the 100-row preflight sample +
  user toggles (= what the UI already shows). The worker's 100k-row
  detection could catch late type flips the sample misses — F2's
  parse-failure counter is the compensating control.

### F2 — Parse failures are invisible (conflated with nulls)
- Stats: an unparseable value in a numeric column increments `nulls` —
  indistinguishable from a sentinel (`-999`, `NA`, blank). A column that is
  20% text reads as "has some nulls".
- Preflight: `autoDetectTypes` calls a column numeric at >0.8 numeric ratio —
  up to 20% of values silently become nulls at analysis, and nothing marks
  the column as mixed.
- Row objects (filter/calcol DSL): a numeric column's unparseable value
  stays a **string** (`r.Fe == "trace"`), while a sentinel becomes NaN and
  stats counts both as null — three representations of "bad value".
- **Fix (Phase 2)**: worker counts `parseFails` per column separately from
  sentinel nulls; new stats metric column; MIXED badge (∅-style) in
  preflight (sample-based ratio), tree, and Statistics when parseFails > 0.
  Type-system enrichment (e.g. an explicit `mixed` type with per-value
  handling rules) to be designed here — minimum viable is two types +
  loud surfacing + the existing manual toggle.

### F3 — Filter exceptions silently exclude rows
- `compileFilterFn` wraps the expression in `try { return !!(expr) } catch
  { return false }` — a filter that throws on some rows (e.g.
  `r.LITO.startsWith('OX')` where LITO is numeric on some rows) silently
  drops exactly those rows, uncounted, in every pass.
- Calcol runtime errors are likewise swallowed per row (`try { calcolFn(obj) }
  catch {}`) — the property goes missing → null downstream, uncounted.
- **Fix (Phase 2, same counters infrastructure)**: count filter exceptions
  and calcol exceptions per pass; surface beside `weightExcluded` ("N rows
  excluded by filter errors") — turning the first thrown error message into
  a warning string would also tell the user *what* broke.

### F4 — Same weight role, three behaviors
- analyze: invalid/non-positive weight → row excluded, `weightExcluded`
  counted and shown in the Statistics sidebar. ✓ the model behavior
- swath: row silently skipped, uncounted.
- GT: weight silently becomes **1** — the row stays at full tonnage.
  (GT's weight is a tonnage multiplier, not the support weight — D2/D3 —
  but "invalid → 1" vs "invalid → excluded" is still a silent divergence.)
- GT density: invalid → 1 silently; missing/invalid DXYZ → volume 1
  silently (when no blockVolume fallback).
- **Fix (Phase 3)**: pick one contract per role, count exclusions in every
  pass, and surface the counts in each tab (swath note, GT toolbar note).

### F5 — GT groupBy collapses falsy group values
- GT: `String(row[col] || '')` — numeric category code `0` lands in the
  empty-string group. Stats pass uses `String(row[col] ?? '')` and keeps
  `"0"`. Same config, different grouping between tabs.
- **Fix (Phase 3)**: `??` in GT; b1-differential divergence only for
  fixtures with falsy group values (add one).

### F6 — Geometry accepts sentinel coordinates
- `processRowGeometry` does `Number(raw)` with no NULL_SENTINELS check: an
  X of `-999` becomes a real grid position — origin/extent/blockSize
  inference corrupts — while stats nulls the same value. Also: the sentinel
  list itself (`-99`, `-999`, `-9999`) can swallow legitimate values
  (local-grid negatives, sub-datum elevations); with F2's counters the
  sentinel hits at least become countable.
- **Fix (Phase 3)**: sentinel check in geometry (divergence: only files
  with sentinel coords); consider surfacing per-axis "coords dropped".

### F7 — Caps overflow silently (except the one that doesn't)
- Categorical value cap MAX_UNIQUE_CAT=500 → `overflow` flag per column,
  shown in the UI. ✓ the model behavior
- Group-stats cap MAX_GROUPS=500 (analyze groupStats): groups beyond the
  cap silently never accumulate — no flag.
- GT group cap GT_MAX_GROUPS=200: beyond-cap groups missing from group
  curves — no flag (`__all__` still correct).
- **Fix (Phase 4)**: overflow flags + UI notes, matching the categories
  pattern.

### F8 — No quoted-field parsing, no malformed-line accounting
- Every pass splits lines with `line.split(delimiter)`; quotes are stripped
  per-field **after** splitting. A quoted field containing the delimiter
  (`"OXIDE, UPPER"`) shifts every subsequent field — values land in wrong
  columns silently. Ragged rows (wrong field count) are null-padded /
  truncated silently; no counter anywhere.
- **Fix (Phase 4)**: cheap `fields.length !== nCols` counter in preflight
  (sample, badge) and analyze (complete message, summary note). Full quoted
  parsing is a separate decision — it touches the hot loop in every pass
  (cost) and most mining exports are unquoted; counting misalignment makes
  the failure visible either way, which is the A9 bar. Revisit actual
  quote-aware splitting at B2 (the parquet adapter era) if surfaced counts
  show it matters in practice.

### Accepted limitations (the registry — additions require explicit sign-off)
Per the standing rule above, this list is the **only** place a deliberate
loss/limitation may live; each entry says what is lost, why it's accepted,
and what makes it visible.

- **Swath rows with invalid coordinates** skip that direction (binning
  needs the coordinate; the value itself is intact in other views). Becomes
  countable via F4's counters when the weight contract work lands.
- **Comment lines** are excluded from analysis — counted (`commentCount`
  in the complete message), displayable any time.
- **t-digest quantiles are approximations** — deliberate streaming design,
  accuracy contract documented in worker-protocol.md (exact below 20k
  distinct values, ≤0.05% rel error p01–p99 continuous).
- **declus excludes invalid-coordinate rows** from weight computation — by
  design (cell declustering needs positions), mismatch-guarded via
  `weightArrayMismatch`.
- **Calcol compile failure → calcols absent** — guarded upstream: the
  editor validates before apply; restore paths carry editor-validated code.
- **>100k-row files with an unresolvable column** lose the first 100k rows
  to type detection (TYPE_MAX_ROWS cap) — documented in worker-protocol.md;
  eliminated for all app flows once Phase 1 lands (full preflight types
  skip detection entirely).
- **Quote-aware field splitting deferred to ~B2** (F8): the hot-loop cost
  is real and most mining exports are unquoted; the Phase 4 ragged-row
  counters make the failure mode visible rather than silent, which is the
  A9 bar. Revisit if surfaced counts show real-world hits.

## Phasing

| Phase | Scope | Worker touched? | b1-differential |
|---|---|---|---|
| 1 | Zero row loss: model sends full preflight types + fingerprint marker | No | Green (message change, not worker change) |
| 2 | parseFails + filter/calcol error counters; MIXED badges (preflight/tree/stats); type-enrichment design | Yes | New fields only — verify no value drift |
| 3 | Weight/density contract unification, GT `??` fix, geometry sentinels | Yes | Intended divergences, one fixture each |
| 4 | Cap overflow flags; ragged-row counters in preflight + analyze | Yes | New fields only |

Each phase lands green on the full suite before the next; manuals regen
once at the end (stats decimals drift in Phase 1).
