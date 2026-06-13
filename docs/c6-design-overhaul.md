# C6 — Design overhaul: Switchboard, menubar, surface UX

2026-06-11. Arthur: "we won't release before we make the UI as a whole way
better… we need a good design overhaul for BMA." Triggers, verbatim: desktop
is crying for a menubar; the aux-loading empty state is weak; GT/swath table
collapse immediately reopens; coordinate rows have no context menu; no
(discoverable) way to re-raise closed tabs; the theme is "a bit too dark" —
consider `@gcu/switchboard`.

Gate: **release blocks on this work** (plus the standing manuals regen).

## Diagnoses of the reported issues

- **GT/swath table collapse reopens (bug).** The toggle works, but collapsing
  changes content height → the scrollbar appears/disappears → content width
  shifts past the chart-width observer's 8px threshold (C1b-0) → the debounced
  re-render rebuilds the output area from cache 150ms later with the table at
  its default open state. Collapse state lives only in the DOM. Fix: persist
  collapse state in module state (`gtTableCollapsed`/`swathTableCollapsed`
  sets), honor it at render — the C5 "survive the rebuild" convention applied
  to output areas.
- **Coordinate rows have no context menu (gap).** `coordRow()` in tree.js
  renders without the `data-ds/name/kind` attributes, so the variable provider
  never matches and right-click falls through to the native menu. Fix: row
  attrs with `kind="coord"` + a provider branch (axis assignment info,
  "Change axes in Preflight" deep link, copy name).
- **Re-raise closed tabs exists but is invisible.** Panels submenu in the
  toolbar ⋮ and the strip-background right-click (C1b-3) both reopen closed
  panels — Arthur couldn't find them, which is the verdict on discoverability,
  not on the feature. The menubar's View menu becomes the canonical home.
- **Aux empty state (screenshot reviewed).** Three unrelated-looking blocks
  floating in a void: a small dropzone, a drillhole card styled as an
  afterthought, and a wall of tiny mono hint text. No hierarchy, no guidance,
  dead space everywhere. Redesign in C6-3.
- **"Too dark."** Default theme is #08090a-on-amber with five accent remaps
  (`teal/blue/mocha/light/cream/bm77`); the existing "light" is an accent swap,
  not a designed light surface. Switchboard solves this properly (below).

## Switchboard adoption (the foundation)

`@gcu/switchboard` (`../auditable/ext/switchboard`, v1.0 spec / v0.1 package)
is the GCU UI toolkit: a 93-line canonical token file (Layer 1 `--sw-*`
swatches, Layer 2 `--au-*` semantic API), light (`:root`, equipment gray) +
dark (basalt) themes, six functional accents with doctrinal semantics
(orange=action, teal=info, green=go, amber=caution, red=fault,
indigo=selected), Barlow + Space Mono with a strict human/machine typography
split, and a ~1KB `theme.js` (first-paint from storage/OS, toggle, persist).

Why it fits BMA specifically:

- **Our vendored components already speak it.** rails and menu read `--au-*`
  tokens; today BMA maps them to its ad-hoc tokens. Adoption deletes that
  impedance.
- **A real light theme for free** — equipment gray, not an accent remap. Dark
  (basalt #15171A) is also gentler than BMA's near-black #08090a, directly
  answering "too dark" in both modes.
- **The six accents fix a semantic squint.** BMA's amber means action AND
  identity AND warning. A9 just made warnings prominent — they deserve their
  own color (amber=caution) distinct from buttons (orange=action) and errors
  (red=fault). Numeric/categorical type indicators map to info/go.
- **The typography split fixes the hint walls.** BMA is mono-only at
  0.55–0.78rem; prose (hints, empty states, help, descriptions) is hard work
  to read — the aux screenshot is the proof. Barlow for human text, Space
  Mono for labels/values/data, per SPEC §5. Data surfaces stay mono.
- **GCU family identity.** Everything under the org ships on Switchboard.

Mechanics: vendor `switchboard.css` + `theme.js` (tiny, pin upstream hash as
usual); BMA's existing tokens (`--bg`, `--amber`, …) become the app layer
*bound to* `--au-*` (`--bg: var(--au-surface-deep)` etc.), so the bulk of
styles.css keeps working untouched; per-token deltas where BMA's scale
doesn't line up 1:1 (BMA has 3 text levels vs fg/muted/soft) are documented
overrides, the cascade-delta pattern the package sanctions. The old accent
themes (`teal/blue/mocha/cream/bm77`) are superseded — either cull to
light/dark or keep one or two as accent overrides on top (decision D4).

## Phasing

| Phase | Scope | Size |
|---|---|---|
| **C6-0** | Paper cuts, no design dependency: GT/swath collapse-state persistence; coord-row context menu; rename app-wide `.swath-aux-warn` → `.warn-note` (A9 left a swath-prefixed class everywhere, against our own convention) | S |
| **C6-1** | **Switchboard foundation**: vendor css+theme.js; rebind BMA tokens as the app layer; light/dark with `prefers-color-scheme` first paint + toggle; six-accent semantics (action/caution/fault/info/go split); typography split (Barlow for prose surfaces, Space Mono for data/labels); fonts embedded at build (subset, ~130KB base64 on a 1.2MB file); cull/keep legacy accent themes per D4; UI scale setting (root font-size) in Settings | M–L |
| **C6-2** | **Menubar** (desktop ≥701px): `MenuBar` from the already-vendored @gcu/menu across the top. **File** (project-verb naming per Arthur 2026-06-12): Open… / Open recent ▸ / **Save** (peace-of-mind flush of the continuous autosave + a visible "Saved ✓" beat; Ctrl+S) / Save as… (C8, duplicates under a new name) / **Export project** (.bma.json — was "Save") / **Import project** (was "Load") / Pack… / Clear. **View**: Panels ▸ (checkmarks — the canonical reopen-closed-tabs home), Reset layout, Data tree, Theme ▸, UI scale. **Data**: Analyze, Filter…, Calculated columns…, Datasets…. **Help**: tutorial, manual, F1 overlay, about + version. **Positioning principle (Arthur 2026-06-12: "on desktop it really needs strategic positioning, and upper right corner ain't that")**: the menubar sits **top-left** — command discovery follows reading order; upper-right is status/furniture territory, and an unlabeled ⋮ there fails twice (wrong corner, no names). On desktop the kebab is REMOVED outright, not relocated; the ? and theme icons fold into Help and View; Settings… lands at the bottom of File. The kebab survives only <701px (mobile thumb-reach calculus is different). Toolbar slims to filename + stats + filter (D5 amendment). Layout presets land here later (View → Layouts). *(Toolbar/⋮ labels already renamed Export/Import ahead of the menubar, 2026-06-12.)* | M |
| **C6-3** | **Aux empty state + onboarding surfaces**: redesign aux landing as two peer cards (point data / drillhole set) with a Barlow intro line, load-example affordance, recent aux files; same pass over the main dropzone (logo, example link, recents already exist — compose them) | S–M |
| **C6-4** | **C5 executed** (sidebar flow — keeps its roadmap row, done inside the overhaul so it lands on the new tokens): shared collapsible-section primitive, per-tab order rethink (selection + action above the fold, advanced collapsed + remembered), sticky Generate, survive-rebuild convention. **Plus (Arthur 2026-06-12): whole-sidebar collapse on every surface** — a chevron rail like the data tree's, giving the results the full width, with an unmissable re-expand affordance (a slim labeled strip, not a bare sliver); collapsed state per panel, persisted. **And a Categories-surface pass**: the sort buttons live in the chart header far from the table they affect; the value-checkbox column is unlabeled; the surface wants the C5 treatment + a header rethink (drag-reorder discoverability already fixed 2026-06-12 — handles always visible, dragging switches to Custom) | M |
| **C6-5** | **Trust + delight batch**: Summary data-health block (assembles A8/A9 counters — empty/mixed/ragged/filter/calcol/weight/coords — into one glanceable card with per-tab links; the A7-report pattern promoted to the whole app); uniform staleness treatment on every Generate button; light discoverability pass (tree-footer hint, empty-workspace "drag tabs to split" line) | M |
| then | Manuals regen both languages (every screenshot is stale after C6-1) + release | — |

Layout presets (View → Layouts: "Validation" tiling Stats+Swath+GT, etc.) are
post-release sugar unless trivial during C6-2 — rails already
serializes/applies layouts, a preset is canned JSON.

## Phase log

- **C6-5 (trust + delight batch) ✅ (2026-06-13) — C6 BUILD WORK COMPLETE.**
  Three pieces, per-commit:
  - **C6-5a Data Health card** (`renderHealthCard` in project.js): the A7
    drillhole consistency-report pattern promoted app-wide. A new
    `#healthSection` on Summary (after Geometry) aggregates the scattered
    A8/A9 counters — empty columns, non-numeric/parse-fail columns, ragged
    rows, filter errors, calcol errors, invalid-weight rows, ignored
    coordinates, group-cap overflow — into one card. Clean → green "✓ No
    data-quality issues" + CLEAN badge; issues → one warn row each (count chip
    + label + affected names/first-error + a per-tab **View →** link via
    `showPanel`) + an "N checks" badge. Reads the analyze 'complete' message
    (gotcha: `stats` is keyed by column index, not a dense array — iterate by
    `header.length`). The scattered badges/notes stay; the card aggregates.
  - **C6-5b uniform staleness**: `executeBtn`'s clean/orange "dim when done"
    pattern generalized to every action button. `setGenStale(btnId, stale)`
    (core.js) toggles `.gen-done` (subdued) + a sibling `.gen-stale-note`
    ("↻ config changed — re-run"; explicit `display:block` since `''` falls
    back to the CSS `none`). GT (`gtStale`) + Swath (`swathStale`) get a stale
    flag set from the blanket sidebar change/input handlers **excluding the
    controls that re-render client-side from cache** (GT: units/dp/grade-unit/
    group-values/theoretical; Swath: statistic/display/y-scale/layout/units/
    color-picker), cleared on a successful complete. Aux's Analyze dims on
    success / returns to orange in `markAuxStale`.
  - **C6-5c discoverability**: a `.tree-foot-hint` footer in the catalog tree
    ("Right-click a variable for actions · drag a tab edge to split the view",
    once results exist; the drag clause only on the rails shell) + a
    `renderEmpty` callback on the rails instance (safety-net hint when every
    tab/rail is closed — "reopen panels from View ▸ Panels").
  - c6-smoke +5 asserts (health clean/badge, tree footer; plus the 5b/5c
    shots). Full suite green; worker untouched (b1-differential 29/29
    bit-identical). Shots: `experiments/c6-5{a,b,c}-shot.js`. **All of C6 is
    now done — next: regen both manuals (every screenshot is stale post-C6)
    then push + tag the release.**
- **C6-4b (sidebar flow) ✅ (2026-06-13)** — **C6-4 complete.** The C5 sidebar
  flow executed on the new tokens: a shared collapsible-section primitive +
  per-tab order rethink + sticky action footers, landed per-surface.
  - **Shared primitive** (`wsEnhanceSidebar(panelId, sidebar, defaults)`,
    workspace.js): a section marked `data-sb="<key>"` has its first child (the
    title) promoted to a clickable `.sb-sec-head` with a chevron; `.collapsed`
    hides the body (`!important` so it beats the inline `display:flex` some
    renderers set on conditional sub-wraps — GT density-const, custom
    cutoff/units). Open/closed persists per `panelId:key` in `SB_SECTIONS`,
    serialized as the project `sidebars.sections` key, restored in
    `applyProject`. Re-run-safe (per-render markup gets fresh listeners; static
    markup guarded by `data-sb-bound`); static (persistent-DOM) sidebars stamp
    `data-sb-panel`/`-default` so `wsApplySidebarSections` re-resolves them on
    restore (stored value, else the section's default). Generalizes tree.js's
    `<details>` open-state convention; uses div+enhancer (not literal
    `<details>`) so the flex `--grow` var-lists keep filling + scrolling.
    Alt+V opens a collapsed section before focusing its search.
  - **Sticky action footer** (`.sb-footer`, `position:sticky;bottom:0` +
    `margin-top:auto`): Generate/Analyze pinned at the sidebar bottom, reachable
    past a scrolling section wall. On Swath, GT, Aux.
  - **Per surface**: **Swath** — advanced (Statistic/Display/Local Filter)
    collapsed, primary (Directions/Variables) open, Generate→footer. **GT** (the
    documented trigger) — the nine-section wall now leads with Grade Variables;
    Density/Weight/Group/Volume/Units/Cutoffs/Filter/Theoretical collapse by
    default, Generate→sticky footer (GT's sidebar scrolls). **Statistics** —
    Percentiles/Weight/Metrics collapsible (Weight collapsed); **StatsCat** —
    Group By collapsible; the grow var/value lists keep their primary role +
    mobile accordion (which only targets `--grow`, so no double-bind).
    **Categories**/**Export** left as-is (only a primary header among non-grow
    sections; Categories got its layout pass in C6-4c). **Aux** — Display
    prefix/Aux filter/Declustering collapsed, Coordinates/Weight open,
    Analyze→sticky footer. **Preflight** — Coordinate Axes/Block Dimensions/DM
    Format collapsible but **default open** (review surface — inferred config
    stays visible, surface-everything rule).
  - Smokes that click into now-collapsed sections expand them first
    (gt-theo, declus-ui, topcut, sidebar-scroll-check — the C5-sanctioned
    expand-before-click); `sidebar-scroll-check` now also proves the sticky
    Analyze footer stays reachable while the aux sidebar scrolls. c6-smoke +6
    section/footer asserts. Worker untouched (b1-differential 29/29
    bit-identical). Shots: `experiments/c6-4b-shot.js` (swath/gt/stats/aux/
    preflight, both themes). **C6-4 done; next: C6-5** (data-health /
    staleness / discoverability), then manuals regen + release.
- **C6-4c (Categories surface) ✅ (2026-06-13)** — the Categories tab reworked
  to be more useful + informative (Arthur: "make the categories tab more useful
  and informative overall"):
  - **Header rethink → informative stat strip**: the cramped one-line mono meta
    badge becomes a labeled readout — Categories / Rows / Null (n + %) /
    Dominant (top value + share) / Diversity (normalized Shannon entropy) / 80%
    in (categories covering 80% of rows = concentration) / vs aux. Title row
    carries the name + Copy.
  - **Sort controls moved beside the value table** they reorder (were in the
    header far above, past the chart): a `#catSortGroup` in a new `.cat-table-bar`
    next to the value search. Buttons keep `.cat-sort-btn[data-sort]` + `.active`
    (smoke-stable); handler rebound to the group; drag-to-custom updates it.
  - **Value-checkbox column labeled**: a select-all checkbox in the column
    header + a "Tick values to filter the model…" hint. Select-all toggles all
    visible value boxes and rebuilds the filter; `rebuildFilterExpression`
    rescoped to `.cat-cb-cell` so the header box never pollutes the expression.
    Fixed a latent aux-only-row cell-misalignment (always 3 leading cells now).
  - Sidebar badge trimmed ("Columns 1 columns" → "1").
  - Suite 18/18 (c6-smoke +4 asserts; `experiments/c6-4c-shot.js`). **C6-4
    remaining: 4b** (C5 sidebar flow — collapsible sections + reorder + sticky
    Generate), saved for a fresh session.
- **C6-4a (whole-sidebar collapse) ✅ (2026-06-13)** — first C6-4 sub-slice
  (the piece Arthur added to C5's scope). Every analysis surface's control
  sidebar collapses to hand the results the full width: a permanent slim
  chevron **rail** (`.sb-rail`, a flex child of each `X-body` inserted left of
  the sidebar, so it survives the sidebar's own innerHTML re-renders) — ◀
  collapses; when `.sb-collapsed` the sidebar (`.sb-panel`) hides and the rail
  widens into a labeled vertical ▶ strip (the "slim labeled strip, not a bare
  sliver"). Wired for Statistics / Categories / StatsCat / GT / Swath / Export
  via `wsInitSidebars()` (workspace.js); state per-panel in `SIDEBAR_COLLAPSED`,
  persisted as the project `sidebars.collapsed` key, restored in `applyProject`.
  Charts redraw at the new width through the C1b-0 observers (verified: GT
  content 849→1097px on collapse). Desktop only (`@media min-width:701px`;
  rail hidden < 701 where sidebars stack). Suite 18/18 (c6-smoke +3 asserts;
  `experiments/c6-4-shot.js`). **Remaining C6-4: 4b** the C5 sidebar flow
  (collapsible *sections* within each sidebar, per-tab reorder, sticky
  Generate — the "nine sections in a wall" fix) and **4c** the Categories pass
  (sort buttons by the table, label the checkbox column).
- **C6-3 (add-dataset surface) ✅ (2026-06-13)** — the aux empty state
  ("three floating blocks in a void") rebuilt as the **Add a dataset**
  surface, designed against [`a10-n-datasets.md`](a10-n-datasets.md) so it's
  architecturally right when the registry lands: a Barlow `<h2>` + intro line
  (names the loaded model via `#dsModelName`, set in `renderAuxFromMain`) over
  **two equal peer cards** — **Point data** (the dropzone + the from-zip-entry
  affordance) and **Drillhole set** (the existing `#dhCard`, now a `.ds-card`
  peer sharing the `.ds-card-head` shell; its standalone box CSS dropped). The
  surface is top-aligned + scrollable, cards `flex 1 1 360px` (wrap on narrow).
  Load errors moved from the deleted `.aux-empty-hint` wall to `#auxLoadError`.
  Drillhole ingestion untouched (all `#dh*` ids + `.dh-slot` preserved; drillhole
  smoke green). **Deferred with reasons** (noted for follow-up): a load-example-
  composites button (the example samples only match the example model's
  coordinates — misleading against a real model) and recent-aux quick-load
  (recents store keys/metadata, not file bytes — can't re-read without a
  handle). The C8 "project home" landing redesign stays C8's. Suite 18/18
  (c6-smoke +3 add-dataset asserts); both modes shot (`experiments/c6-3-shot.js`).
- **C6-2 (menubar) ✅ (2026-06-13)** — desktop top-left command bar via the
  already-vendored `@gcu/menu` `MenuBar` (`src/workspace.js`), mounted on
  `#appMenubar` in `buildRailsShell()`, destroyed in `wsExitRails()` (rails
  shell only):
  - **File**: Open… (triggers `#fileInput`) / Open recent ▸ (factory off
    `wsRecentsCache`, fed by `renderRecentFiles`) / Save (Ctrl+S — flushes the
    continuous autosave immediately + flashes a "Saved ✓" beat in the toolbar;
    `flushProjectSave()`) / Export project (.bma.json) / Import project… / Pack…
    / Clear project / Close file / Settings…. **Save as… deferred to C8.**
  - **View**: Panels ▸ (the canonical reopen-closed-tabs home, live checkmarks)
    / Data tree (toggle) / Reset layout / Theme ▸ (live) / UI scale ▸.
  - **Data**: Analyze / Filter… (focuses the filter input) / Calculated
    columns… / Datasets… (opens Aux — the A10 add-dataset surface).
  - **Help**: Keyboard shortcuts (F1) / Download example dataset / About BMA
    (version via bmaConfirm). **Manual omitted** — no hosted URL yet; add when
    the manual ships to Pages.
  - **Live menus for free**: each section's `items` is a factory (Menu.show
    re-evaluates via `evaluateItems` on every open), so panel/theme/scale/tree
    checkmarks always reflect current state — no manual `refresh()`.
  - **Toolbar slimmed (D5)**: on `#results.rails-shell` the whole
    `.toolbar-right` (Export/Import/Pack/Clear buttons, ?/⚙ icons, the ⋮ kebab)
    and the ✕ close-file button are `display:none` — folded into the menus.
    Toolbar is now menubar + filename (brand) + stats. The kebab + buttons
    survive < 701px untouched (the legacy shell's menu); the mobile kebab
    gained Open + Save for parity.
  - **UI scale** (the deferred C6-1c item): `applyUiScale(pct)` multiplies the
    14px root font-size; `bmaSettings.uiScale` persisted, applied in
    `initSettings`. View → UI scale ▸ (90/100/110/125/150%).
  - Suite 18/18 (c6-smoke +7 menubar asserts; rails-smoke Panels/Reset now
    driven via the View trigger; c6/drillhole pack smokes call `openPackModal()`
    since the toolbar button is hidden). Both modes shot
    (`experiments/c6-2-shot.js`). **C6-1 + C6-2 complete; next: C6-3 aux/add-
    dataset surface, or C6-4 (C5 sidebar flow).**
- **C6-1c (chart colors) ✅ (2026-06-13)** — the muddy light-surface charts
  fixed; **C6-1 foundation complete** bar the UI-scale setting (carried to a
  follow-up):
  - **Theme-aware series palette**: `STATSCAT_PALETTE` was one fixed set of
    dark-theme neon hexes — fine on basalt, washed to pastel on equipment
    gray, and three translucent neon bands stacked into mud. Replaced with
    dual-tuned `CHART_PALETTE_LIGHT`/`DARK` (8 colors, colorblind-aware,
    Switchboard eye-comfort character), ordered blue→orange→green→purple→
    red→teal→magenta→gold so the common 2–3-series swath is maximally
    distinct and red is off the lead (a plain series shouldn't read as a
    fault). `STATSCAT_PALETTE` is now a **live binding** repointed by
    `refreshChartPalette()` (keys off the resolved `data-theme` attribute, so
    custom themes get the dark variant). Arthur approved the palette from a
    both-surfaces render (`experiments/c6-1c-palette.js`).
  - **Chart chrome tokens**: the near-black `#1e2228` grid (heavy on light)
    → `--chart-grid` (`--au-border`); the `#6a737d` axis/title/legend labels
    → `--chart-ink` (`--au-fg-muted`) — both theme-aware, baked on SVG/PNG
    export (export-bake regex literals rewritten to match). Stray `#56b6c2`
    (top-cut CV) and `#58a6ff` (section mean marker) → `--info`.
  - **`--amber` chart-interim retired**: every `var(--amber)` chart stroke
    (GT tonnage, top-cut mean, categories pareto, section CDF, aux declus
    curve, stats crosshair) → `var(--action)`; the `--amber/-dim/-glow`
    `:root` definitions deleted and dropped from the custom-theme emit. Zero
    `--amber`/`#6a737d`/`#1e2228` left in chart code (asserted).
  - **Theme-change re-render hook**: `applyTheme()` calls
    `reRenderChartsForTheme()` (both built-in and custom paths) — repoints the
    palette and redraws every cached chart through the same guarded renders
    the C1b-0 width-observers use, so a Light/Dark flip recolors live instead
    of waiting for the next Generate. Canvas 2D (section) reads colors via a
    new `cssVal()` resolver since it can't consume `var()`.
  - Suite 18/18; worker untouched (b1-differential bit-identical); both modes
    re-shot. Sweep tool kept: `experiments/c6-1c-charts.js`. **Leftover: the
    UI-scale setting** (root font-size in Settings) — small, slots into C6-2
    or a quick follow-up.
- **C6-1b ✅ (2026-06-12)** — the three C6-1a leftovers landed:
  - **Accent triage (D1)**: ~160 styles.css sites + 10 non-chart JS inline
    sites split off the interim all-amber binding. The mapping: primary
    buttons / input `:focus` borders / progress fills / hover affordances /
    grab handles / caret → **action**; active tabs (legacy + rails accent) /
    selected toggles+presets / sidebar selections / checkbox+radio
    `accent-color` / drop-target indicators / menu checkmarks →
    **selected**; ✱ mixed tags, CONST badges, tree concern badges, weight
    notes, stale/config-changed notices, export precision warn, dh
    dip-convention box, sub-blocked notice (was hardcoded `rgba(255,180,0)`)
    → **warn**; wordmark, toolbar title, GCU logo, build badge, landing
    bullets → **brand** (`--brand: var(--sw-amber)`, deliberately
    swatch-level — identity, not caution); panel/modal headers de-ambered to
    `--fg`; count badges / axis labels (X·Y·Z, dh slot roles) / links /
    update banner / completeness bars → **info**; copied-states → **go**;
    categorical type toggle → **go** (matches cv-type.cat). Aux-row tints
    + the `var(--red, #hex)` fallbacks + dark-only hardcodes (`#1a1e22`,
    `#2d333b`, white-alpha tints) converted to tokens/`color-mix`.
    `--amber/-dim/-glow` survive as documented **chart-interim** tokens
    (JS SVG strokes) until the C6-1c chart pass; custom theme slots now
    emit `--action`/`--brand` from their accent. Migration scripts kept:
    `experiments/c6-1b-triage.js` (exact-literal pairs, occurrence-count
    asserted, zero-residue check) + `c6-1b-typography.js`.
  - **Font embed (D2)**: `src/fonts/` = barlow-400/600 + space-mono-400/700
    woff2 + OFL.txt copied from switchboard upstream; build.js inlines them
    as base64 `@font-face` via the `__INJECT_FONTS__` marker (~105KB,
    index.html now 1.28MB); Google Fonts `<link>` + the sw.js fonts route
    removed (app is now fully offline-self-contained); `--mono` →
    `--au-font-mono` (Space Mono), `--sans` added. Mono weights 500/600
    resolve to the 400/700 cuts by CSS font-matching — accepted.
  - **Typography (SPEC §5)**: Barlow on prose surfaces (about, landing
    sub/footer, dropzone labels, empty-state hints, modal prose, pack
    notes, help rows, aux hints, tree notes) with sizes bumped ~0.75–1.05rem;
    landing h1 1.25rem, about h2 a real 1.05rem heading; font-size floor
    raised two-tier (≤0.55rem → 0.62, 0.58–0.62 → 0.65) in `font-size:`/
    `font:` declarations only (paddings untouched), styles.css + app JS
    inline styles (SVG chart text excluded). Control panels stay mono.
  - Suite 18/18 green (c6-smoke flaked on browser launch in the batch run,
    passes standalone); both modes eyeballed via `c6-theme-shots.js`.
    Worker untouched (b1-differential 29/29 bit-identical).
- **C6-1a ✅ ea5ed3e (2026-06-12)** — Switchboard tokens vendored (pinned
  eff8abb) into the styles.css head; BMA tokens = app layer over `--au-*`
  (documented deltas: fg-bright==fg, amber→action interim, mono unchanged);
  Light/Dark/System with live OS-follow + first-paint head snippet; legacy
  themes culled with stored-name migration; custom slots ride the dark
  base. Both modes eyeballed (`experiments/c6-theme-shots.js`); suite green
  — smokes now exercise LIGHT by default (headless). Remaining C6-1 slice:
  **C6-1c** chart tokens + light-safe palette (bring Arthur candidates
  rendered on BOTH surfaces before committing) + theme-change re-render
  hook (reuse the chart-width observers' cached re-render entries) +
  retire the `--amber` chart-interim tokens; UI scale setting.
- **C6-0 ✅ fd4456a (2026-06-12)** — collapse state in module state
  (`gtTableCollapsed` by column name / `swathTableCollapsed`), renders
  state-driven; coord rows resolve in the context menu (axis header,
  change-assignment deep link, copy name); `.swath-aux-warn` → `.warn-note`
  app-wide (12 JS sites + shared CSS block). New smoke
  `experiments/c6-smoke.js` (7 asserts — grows with each C6 phase).

## Decisions — ALL DECIDED (Arthur, 2026-06-12: "I agree with all Ds")

- **D1 ✓ — full Switchboard accent semantics.** Orange = action
  (Generate/Apply/primary buttons), amber = caution (warnings, badges of
  concern), red = fault, teal = info, green = go, indigo = selected. Brand
  amber survives where brand belongs (header/identity moments), not on
  actions. The triage of today's ~all-amber usage sites is the bulk of the
  C6-1 accent pass.
- **D2 ✓ — embed fonts.** Barlow 400/600 + Space Mono 400/700 subsets,
  base64 at build (~130KB on a 1.2MB file).
- **D3 ✓ — follow `prefers-color-scheme`**, user override persisted
  (Light / Dark / System).
- **D4 ✓ — cull the legacy accent themes** (`teal/blue/mocha/cream/bm77` +
  the fake `light`). Stored `bmaSettings.theme` migrates: light/cream →
  light, default → system, others → dark. Settings becomes
  Light / Dark / System + UI scale.
- **D5 ✓ — File / View / Data / Help**, plus the amendment from the design
  review: the toolbar's SAVE/PACK/LOAD/CLEAR button row folds into the File
  menu — the toolbar slims to filename + stats + filter, which also
  de-ambers the header.

## Strategy amendments (2026-06-12, the "where is this all going" session)

- **C6-3 is redesigned in place**: not "make the aux empty state pretty"
  but **design the Add-dataset surface** — a dataset list (card per
  dataset: name, source, rows, stale, ★ reference, remove) + one Add flow
  with two peer paths (point data / drillhole set), room for the 3rd and
  4th datasets. Designed against [`a10-n-datasets.md`](a10-n-datasets.md)
  so the surface is architecturally right on arrival even while the
  registry refactor lands later.
- Downstream rows minted on the same arc: A10 (N datasets), A11
  (multi-table drillholes), A12 (contact analysis), **C7 validation report
  export** — the convergence point C6's light theme + tokenized charts
  exists to serve (print-ready figures).
- **C8 project system** (2026-06-12) shapes two C6 surfaces: the C6-2 File
  menu is project lifecycle (New / Open recent ▸ / Rename / Save as… /
  Pack / Export config), and the C6-3 landing redesign is the project
  home — drop-a-file hero + named project cards (absorbing file-recents).
  Design both with C8's object model in mind; implement C8 after.

## Constraints

- Every phase lands suite-green (the smokes assert structure/behavior, not
  colors — C6-1 should pass unchanged; menubar/aux/C5 phases adjust selectors
  where markup moves).
- Singleton-panel architecture, rails integration, and the legacy <700px
  shell are untouched; C1c (mobile pager) remains separate and benefits from
  the same tokens.
- Worker untouched throughout (pure UI track).
- bm77 etc. removal must migrate stored `bmaSettings.theme` values gracefully.
