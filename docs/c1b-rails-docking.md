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
2. **C1b-1 — vendor rails + shell**: `src/vendor-rails.js` + token map +
   `workspace.js`; default layout; `showPanel`; badges; tree rail;
   breakpoint shell switch. Smokes updated where they click
   `.results-tab` (drive `showPanel` or the rails strip instead — keep a
   compatibility shim so existing smokes pass unchanged if possible).
3. **C1b-2 — layout persistence** + reset-layout action + floats enabled.
4. **C1b-3 — cleanup**: retire desktop tab bar; keep legacy shell <700px;
   update help texts; manual section + screenshots (both languages).

## Decisions

| # | Decision | Call |
|---|---|---|
| D1 | Vendor rails as-is (`vendor-rails.js` + rails.css), pin upstream commit in header | **Made** |
| D2 | Skip rails-default.css; map `--rails-*` tokens to BMA vars | **Made** |
| D3 | Default layout = tree rail + single main stack (familiar-first) | **Made** — a curated multi-panel default would impose a workflow; let users split |
| D4 | Floats on from the start? | **Proposed: yes** (free feature, big value on wide screens) — flag for Arthur, easy to defer to C1b-2 |
| D5 | Legacy tab shell survives <700px until C1c | **Made** (C1c constraint) |
| D6 | C1b-0 (chart widths) lands independently first | **Made** — lowest risk, immediate payoff |

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
