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
| **C6-2** | **Menubar** (desktop ≥701px): `MenuBar` from the already-vendored @gcu/menu across the top. File (open/save/pack/load/recent/clear), View (Panels with checkmarks — the canonical reopen-closed-tabs home — reset layout, tree, theme, UI scale), Data (analyze/filter/calc/aux), Help (tutorial, manual, F1 overlay, about+version). Absorbs the toolbar ⋮ (kebab stays <701px). Layout presets land here later (View → Layouts) | M |
| **C6-3** | **Aux empty state + onboarding surfaces**: redesign aux landing as two peer cards (point data / drillhole set) with a Barlow intro line, load-example affordance, recent aux files; same pass over the main dropzone (logo, example link, recents already exist — compose them) | S–M |
| **C6-4** | **C5 executed** (sidebar flow — keeps its roadmap row, done inside the overhaul so it lands on the new tokens): shared collapsible-section primitive, per-tab order rethink (selection + action above the fold, advanced collapsed + remembered), sticky Generate, survive-rebuild convention | M |
| **C6-5** | **Trust + delight batch**: Summary data-health block (assembles A8/A9 counters — empty/mixed/ragged/filter/calcol/weight/coords — into one glanceable card with per-tab links; the A7-report pattern promoted to the whole app); uniform staleness treatment on every Generate button; light discoverability pass (tree-footer hint, empty-workspace "drag tabs to split" line) | M |
| then | Manuals regen both languages (every screenshot is stale after C6-1) + release | — |

Layout presets (View → Layouts: "Validation" tiling Stats+Swath+GT, etc.) are
post-release sugar unless trivial during C6-2 — rails already
serializes/applies layouts, a preset is canned JSON.

## Decisions needed (Arthur)

- **D1 — accent identity.** Full Switchboard semantics: Generate/active
  become orange (#D4672E dark), amber reserved for warnings? Or keep
  amber-as-action as a documented BMA delta (`--au-action: amber`)? Canon
  recommendation: take orange; amber's new caution role is exactly what A9
  needs, and BMA stops fighting the family look.
- **D2 — fonts.** Embed Barlow+Space Mono subsets at build (+~130KB base64,
  single-file stays sovereign) vs system-stack fallback only (0KB, look
  varies by machine)? Recommendation: embed.
- **D3 — default theme.** First paint from `prefers-color-scheme` (auditable
  behavior) vs dark default with light opt-in? Recommendation: OS-follow.
- **D4 — legacy accent themes.** Cull `teal/blue/mocha/cream/bm77` (settings
  grid becomes Light / Dark / scale) vs port them as accent overrides?
  Recommendation: cull at C6-1, re-add by request — they were exploration,
  Switchboard is the decision.
- **D5 — menubar scope.** File/View/Data/Help as listed, or minimal
  File/View/Help? Any items Arthur wants that aren't listed?

## Constraints

- Every phase lands suite-green (the smokes assert structure/behavior, not
  colors — C6-1 should pass unchanged; menubar/aux/C5 phases adjust selectors
  where markup moves).
- Singleton-panel architecture, rails integration, and the legacy <700px
  shell are untouched; C1c (mobile pager) remains separate and benefits from
  the same tokens.
- Worker untouched throughout (pure UI track).
- bm77 etc. removal must migrate stored `bmaSettings.theme` values gracefully.
