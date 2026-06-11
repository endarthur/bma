# C1b Design — Rails Docking Workspace

Design note, 2026-06-11. Status: **design pass, not implemented**. Companion
to `docs/v2-roadmap.md` row C1b; builds on C1a (catalog + tree). Library
studied at `../auditable/ext/rails` (@gcu/rails 0.1.0).

## Goal

Panels that can coexist — Statistics next to Swath, GT under Categories —
with the catalog tree as a collapsible left rail, replacing the
one-tab-at-a-time workspace on desktop. Below 700px nothing changes (the
existing tab shell stays; C1c later turns it into a proper pager).

## The library (verdict: vendor as-is)

@gcu/rails 0.1.0 (`../auditable/ext/rails`): zero runtime dependencies,
MIT, plain DOM + flexbox + pointer events. Model: **rails (columns) →
stacks (tab groups) → tabs (panels)**, plus flat floats (tear-off
windows); no recursion. Key properties verified against source:

- `createRails(host, { initialState, renderPanel(tab) → Element, onPanelDestroy })`
  — `renderPanel` is called lazily once per tab; the returned element is
  **never reparented**, only positioned via `style.left/top/width/height`.
  Iframes/canvases/form state survive every drag/split/float.
- API: `addTab/closeTab({preserve})/moveTab/floatTab/activateTab/updateTab
  (badges!)/serialize(replacer)/deserialize/batch/on/off/destroy`; preserved
  panels for singleton content.
- Built-in ResizeObserver on the host repositions panels; **no resize event
  is emitted to panel content** — content observes its own element
  (mechanism, not policy; see chart strategy below).
- Persistence: `serialize()` → JSON of the rails/stacks/tabs/floats shape;
  `deserialize()` validates and **evicts tabs the consumer no longer
  registers** — exactly what a project restore wants.
- Styling: `rails.css` (structural only, 8.7 KB) + optional
  `rails-default.css` with `--rails-*` tokens. We skip the default theme and
  map tokens to BMA's (`--rails-bg→--bg`, `--rails-surface→--bg1`,
  `--rails-chrome→--bg2`, `--rails-border→--border`, `--rails-accent→--amber`,
  `--rails-text/dim→--fg/--fg-dim`, `--rails-font-mono→--mono`).
- Embedding: the shipped `index.js` is import/export-stripped concatenated
  source — the same pattern as BMA's build. Vendor as
  `src/vendor-rails.js` (new `APP_MODULES` entry right after `core.js`)
  plus `rails.css` appended into `styles.css` with a vendor banner. Record
  the upstream commit hash in the file header for re-vendoring.
- Maturity: no TODO/FIXME, ARIA + keyboard + touch handled, 64 KB SPEC,
  working demo. Pre-1.0, so pin the vendored copy and re-vendor
  deliberately.

## Architecture

### Panels are singletons; shells are interchangeable

The existing `.results-panel` divs (preflight, aux, summary, calcols,
statistics, categories, statscat, gt, swath, export — section stays
hidden) become a **panel registry**:

```javascript
// workspace.js (new module)
const PANELS = [
  { id: 'preflight', title: 'Preflight', el: '#panelPreflight' },
  { id: 'statistics', title: 'Statistics', el: '#panelStatistics' },
  ...
];
showPanel(id)   // shell-agnostic: rails.activateTab(id) OR legacy switchTab(id)
```

Two shells consume the registry:

- **Rails shell (≥ 701px)**: `createRails` over a host that replaces
  `.results-main`; `renderPanel(tab)` returns the singleton panel element
  (BMA reparents it into the rails host once at shell init — rails never
  does afterwards). The catalog tree is a **collapsible rail**
  (`rail.collapsible: true`, fixed `width`) holding a single "Data" tab —
  this replaces the C1a tree-toggle/proto-sheet on desktop.
- **Legacy tab shell (< 700px)**: today's tab bar + `.results-panel.active`,
  untouched. C1c upgrades it to a pager; the panels are the same elements.

Shell choice at file-load time by viewport (`matchMedia`), re-evaluated on
breakpoint crossing with a teardown/re-home (`rails.destroy()` + panels
moved back to `.results-panels`). Panels must keep working in both — the
C1c constraint, now enforced by construction.

### Default layout = familiar

The initial rails state reproduces today's UX so nothing is foreign:

```
rail 0 (collapsible, width 250): [ Data (tree) ]
rail 1 (flex 1):                 [ Preflight | Aux | Summary | Calc |
                                   Statistics | Categories | StatsCat |
                                   GT | Swath | Export ]   ← one stack
```

One stack of tabs looks and behaves like the current tab bar; the new
power (drag a tab down to split, tear off a float) is discoverable, not
imposed. "Reset layout" action in the toolbar overflow menu restores this
state.

### Existing call sites

- `switchTab(id)` (core.js) becomes the legacy-shell arm of `showPanel(id)`;
  all programmatic callers (project restore `activeTab`, ctx-menu "Focus in
  Categories", help deep-links) switch to `showPanel`.
- Tab badges (`Statistics <span class=badge>7</span>` etc., set in
  displayResults) → `rails.updateTab(id, { badge })` on the rails shell.
- `activeTab` in `serializeProject()` keeps working (active tab of the main
  stack); a new sibling key stores the layout (below).
- The toolbar, action bar (Analyze + FILTER), modals, help overlay stay
  global chrome above/over the workspace. F1 help keys off the focused
  stack's active tab.
- The `.results-panel.active` CSS-scoping convention (and its bug class)
  dies on the rails shell — panels are positioned, not display-toggled.
  Keep the `.active` rules until the legacy shell is C1c'd.

## Chart strategy — container-width rendering (the bulk)

Inventory of fixed logical widths (all render SVG strings, viewBox-scaled):

| Renderer | Site | W today |
|---|---|---|
| Statistics CDF/Prob | statistics.js:433 | 700 |
| Q–Q | statistics.js:564 | 700 |
| StatsCat CDF | project.js:2344 | 700 |
| GT charts | gt.js:940 | 720 |
| Swath overlay | swath.js:961 | 720 + extraAxes·55 |
| Swath split | swath.js:1234 | 720 |
| Categories chart | categories.js | container-ish (verify) |
| Top-cut grid | topcut.js | 2×2 fixed cells |
| Section canvas | section.js:512 | 660 (hidden tab — skip) |

Plan: one shared helper in core.js,

```javascript
// observeChartWidth(container, render) — debounced (rAF + 150ms trailing)
// ResizeObserver calling render(px) on width change; render guards against
// thrash by skipping when |Δw| < 8px. Returns disconnect().
```

and each renderer's `var W = 700` becomes
`var W = Math.max(560, hostWidth)` with `hostWidth` supplied by the
helper (fallback to today's constants when unobserved). Re-render entry
points already exist and are cheap (all draw from cached data:
`renderStatsCdfPanel`, `renderGtOutput`, `renderSwathOutput`,
`renderCatBarChart`, statscat re-render).

**This phase is shippable before rails lands** — it already fixes the
tree-toggle reflow today and is the C1c mobile enabler. It is the bulk of
C1b by volume and carries near-zero regression risk per chart (the W
constant changes provenance, nothing else).

## Persistence

New project key:

```javascript
layout: {
  v: 1,
  rails: rails.serialize()   // JSON string, only when the rails shell is up
}
```

- Saved through the existing `autoSaveProject()` via `rails.on('layout:change', autoSaveProject)`.
- Restore: hydrate after panels register; `deserialize` evicts stale tab ids
  itself. Missing/invalid `layout` → default layout. `tree.open` (C1a key)
  maps onto the tree rail's collapsed state (kept for the legacy shell).
- Pack/Save carry it automatically (it rides `serializeProject()`).

## Phasing (each lands green)

1. **C1b-0 — container-width charts** (no rails yet): `observeChartWidth`
   helper + convert the seven renderers. Full smoke suite green; new
   assertions: chart svg width tracks container after a tree toggle.
   ✅ **DONE 2026-06-11 (253560c)** — six renderers converted (top-cut kept
   fixed cells: its drag math is scale-aware, revisit with panels; section
   hidden); the Statistics 340px max-height that letterboxed every CDF is
   gone; tree-smoke asserts the viewBox widens on tree close.
2. **C1b-1 — vendor rails + shell**: `src/vendor-rails.js` + token map +
   `workspace.js`; default layout; `showPanel`; badges; tree rail;
   breakpoint shell switch. Smokes updated where they click
   `.results-tab` (drive `showPanel` or the rails strip instead — keep a
   compatibility shim so existing smokes pass unchanged if possible).
   ✅ **DONE 2026-06-11** — vendored at upstream `5a6c7ab` (as-is, zero local
   changes; `export` line stripped, header records the hash); theme maps
   `--rails-*` onto BMA vars so every built-in theme restyles the chrome.
   Shim = the legacy tab bar stays visible and two-way-synced on the rails
   shell (clicks route through `showPanel`; `tab:activate` mirrors
   `.results-tab.active`), so all six smokes pass unchanged; it retires in
   C1b-3. Floats stay off until C1b-2 (`canCreateFloat` false + `new-float`
   zone disabled); tabs are `closeable:false` for now. `tree.open` ↔
   tree-rail collapsed state synced both ways (rail buttons, `#treeToggle`,
   project restore). Panels under rails carry `.active` permanently — the
   wrapper controls visibility, the class keeps per-panel display rules.
   `wsTabBadge()` is the one badge setter for both shells. New
   `experiments/rails-smoke.js` covers shell boot, default layout, legacy-bar
   sync, split-by-drag (no overlap after the 140ms panel transition), badge
   mirroring, tree-rail collapse sync, and the breakpoint teardown/re-home.
   Found + fixed: `.gt-sidebar-section--grow` had no `overflow` and painted
   over the sections below it at short panel heights (now `overflow:hidden`,
   matching stats/statscat/swath). Known quirk for C1b-2: the tree rail's
   fixed `width: 250` wins over flex on every chrome rebuild, so dragging
   the rail splitter next to it doesn't stick.
3. **C1b-2 — layout persistence** + reset-layout action + floats enabled.
   ✅ **DONE 2026-06-11** — floats on per D4 (`dropZones: {'tab-append-body':
   false}` only); tabs are closeable now: close destroys the rails tab but
   the singleton panel re-homes to `.results-panels`, and `showPanel`
   re-adds on demand (the legacy tab bar is the reopen affordance until
   C1b-3 — its replacement needs deciding then). `layout` project key =
   `{v: 1, rails: serialize()}`, written by `serializeProject()` from the
   live instance or `wsLastLayout` (so a project saved on mobile keeps the
   desktop layout); autosaved via `rails.on('layout:change')`; restored in
   `applyProject` through `wsApplyLayout`, which sanitizes first
   (unregistered/duplicate tab ids, empty stacks/rails/floats dropped, Data
   tab required) and falls back to the default layout on anything invalid.
   `wsLastLayout` also carries the arrangement across breakpoint crossings.
   Reset layout lives in the toolbar ⋮ menu (now visible on desktop, item
   shown only on the rails shell). New file / Clear project → default
   layout. Workspace z-containment: `.results-main { z-index: 0 }` makes it
   a stacking context so float chrome (z 100+) can't paint over the
   document-level modals (z 100) / popovers; help overlay bumped to z 5000
   (above floats, below the drag scrim). rails-smoke extended: tear-off via
   the new-float zone, float ✕ → re-home → legacy-bar re-add, autosaved
   layout JSON, breakpoint retention, reload-restores-layout, reset action.
4. **C1b-3 — retire the desktop tab bar** (+ vendor @gcu/menu, D7): the
   rails strip becomes the only tab bar ≥701px; the legacy bar stays for
   the <700px shell. Retiring it creates three menu-shaped holes — two of
   which exist today — all served by `Menu.show` from @gcu/menu:
   - **Reopen affordance**: closed panels lose their legacy-bar buttons.
     A "Panels" menu (toolbar ⋮ submenu and/or strip context menu) listing
     every registered panel with `checked` per open tab; selecting a
     closed one routes through `showPanel` (activate-or-add already
     handles it). Factory items evaluate on open — always live.
   - **`strip:overflow` is currently dead**: rails shows a ⋯ button when a
     strip's tabs overflow and emits the clipped tabs + anchor coords, but
     C1b-1 never wired a consumer (upstream ships no menu UI by design).
     `Menu.show(overflowTabs, { x, y })` → activateTab.
   - **Tab/strip/float-titlebar context menus**: rails emits
     `tab:contextmenu` / `strip:contextmenu` / `float:titlebar:contextmenu`;
     nothing consumes them. Float / Close / Close others / Move to new
     rail is standard docking UX.
   Also: smokes' `.results-tab` click sites → `showPanel()` (mechanical,
   ~15 sites incl. manual-shots' `tab()` helper); `#treeToggle` needs a new
   home (rail's own ◀/▶ buttons may suffice — decide then); badge mirror
   keeps writing the hidden legacy buttons (they remain the <700px shell
   and the state store) — `wsTabBadge` unchanged; update help texts;
   manual section + screenshots (both languages).
   ✅ **DONE 2026-06-11 (incl. manuals)** — manuals: new §2.4 "The
   workspace: panels that coexist" in both languages + §13 tree-toggle
   sentence fixed (rail ◀/▶ buttons); all 24 screenshots regenerated at
   the rails-shell build (new `24-workspace.png`: split + float); both
   PDFs regenerated (pt-BR 34pp, EN 33pp); `experiments/bma.html` offline
   copy refreshed. Code/help details:
   @gcu/menu vendored per D7 (`src/vendor-menu.js` + menu.css + `--ui-*`
   token map; toolbar ⋮ is now a `Menu.dropdown` with factory items, the
   old `.toolbar-menu` HTML/CSS/JS removed). Legacy bar hidden via
   `#results.rails-shell .results-tabs` — class set only after
   `createRails` succeeds, so a rails failure leaves the legacy shell
   usable; the bar stays in the DOM as state/badge store and the <700px
   shell. Menu surfaces wired in `buildRailsShell`: Panels (⋮ submenu +
   strip-background right-click, checkmarks per open tab → `showPanel`),
   `strip:overflow` ⋯ (was dead since C1b-1), tab right-click
   (Float/Dock, Move to new rail, Close, Close others), float titlebar
   right-click (Dock/Close). `#treeToggle` decision: rail ◀/▶ buttons
   suffice on desktop; the button still works on the mobile bar and
   `toggleCatalogTree()` remains the programmatic path. F1 help gains a
   Workspace section on the rails shell. Smokes: 14 click sites converted
   to `showPanel()` evaluates across 8 files + manual-shots' `tab()`
   helper; rails-smoke reworked to 35 asserts (hidden bar, strip clicks,
   Panels reopen incl. checkmark states, tab/strip ctx menus, overflow
   menu at 820px). Full suite green (9/9 incl. sidebar-scroll).
5. **C4 — menu unification** (roadmapped as its own Track C row; was
   provisionally "C1b-4" before the naming convention settled): swap `ctxmenu.js`'s
   hand-rolled `#bmaCtxMenu` rendering for `Menu.show` while keeping the
   provider architecture (providers keep producing `{label, action}`
   items; gains: keyboard nav + typeahead, `checked` states for the
   CDF/weight toggles, real submenus — "Pair with…" can list targets
   inline instead of bouncing to the popover, `danger` styling). Replace
   the hand-rolled toolbar `.toolbar-menu` with `Menu.dropdown`. Keep
   native `<select>`s for forms; `MenuBar` stays unused (BMA's toolbar is
   buttons, not a File/Edit bar).

## Decisions

| # | Decision | Call |
|---|---|---|
| D1 | Vendor rails as-is (`vendor-rails.js` + rails.css), pin upstream commit in header | **Made** |
| D2 | Skip rails-default.css; map `--rails-*` tokens to BMA vars | **Made** |
| D3 | Default layout = tree rail + single main stack (familiar-first) | **Made** — a curated multi-panel default would impose a workflow; let users split |
| D4 | Floats on from the start? | **DECIDED (Arthur, 2026-06-11): yes — with `dropZones: { 'tab-append-body': false }`.** Full-body drop targets make floats unusable: any move snaps them into a stack. Docking happens on tab strips/titlebars/edges only. (Rails supports this natively; its own demo ships the same config with the same rationale.) Available zone toggles in drag.js: `new-float`, `new-rail`, `new-stack`, `tab-append-strip`, `tab-insert`, `tab-append-body`, `float-titlebar` |
| D5 | Legacy tab shell survives <700px until C1c | **Made** (C1c constraint) |
| D6 | C1b-0 (chart widths) lands independently first | **Made** — lowest risk, immediate payoff |
| D7 | Vendor @gcu/menu for the C1b-3 menu surfaces | **Proposed (Arthur raised it, 2026-06-11)** — `../auditable/ext/menu`, same upstream repo/commit as rails (`5a6c7ab`), same vendoring shape (bundled index.js, strip the `export` line, `gcu-menu-*` CSS prefix). Verified: zero top-level name collisions with BMA modules (but its names are generic — `show`, `dismiss`, `isOpen` at script scope; always call via `Menu.*`, re-check collisions on re-vendor). Token map `--ui-*`→BMA: bg-raised→`--bg2`, bg-hover→`--bg3`, fg→`--fg`, fg-muted→`--fg-dim`, fg-error→`--red`, border→`--border`, font→`--mono`, z-dropdown above the workspace stacking context (menus mount at document level). Drag-aware hook reads a `rails-dragging`/`gcu-dragging` class on `body` — rails puts it on panels, not body; only matters for hover-open submenus during drags, skip unless it bites. |

## Known hazards

- Smokes drive `.results-tab[data-tab=…]` clicks everywhere — keep those
  selectors working via a shim during C1b-1 or update all six smokes in the
  same commit (prefer the shim; one change at a time).
- Panels currently assume full workspace width; inner sidebars (260–340px)
  + a chart in a half-width stack get cramped — min stack width and the
  chart minimum (560px) cover the worst; sidebar slimming is post-C1b.
- `displayResults()` rebuilds sidebars on re-analysis; with multiple panels
  visible the rebuild now happens while visible — the snapshot/restore
  convention (new-tab checklist) already handles state, but watch for
  scroll-position jumps.
- Swath/GT renderers post into elements queried by id — ids are unique
  singletons, fine; but **two stacks showing the same tab is impossible**
  (a tab lives in exactly one stack), so no duplicate-id risk.
- rails is pre-1.0: pin the vendored copy; re-vendor deliberately with the
  upstream hash recorded.
