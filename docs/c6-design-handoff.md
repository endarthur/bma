# C6 handoff brief — for Claude Design

2026-06-12. You're being brought in by Arthur to drive the **C6 design
overhaul** of BMA (Block Model Atelier). This file is your orientation; the
plan of record is [`c6-design-overhaul.md`](c6-design-overhaul.md). Welcome.

## What BMA is

A client-side CSV/.dm block model analyzer for mining/geostatistics —
resource geologists validating block models against drillhole samples
(JORC/NI 43-101 QA work). The distributable is **one `index.html`**: no
server, no framework, no bundler. Source lives in `src/`, assembled by
`node build.js`. Users are professionals on desktop monitors; a mobile
review-mode shell (C1c) is planned separately.

Identity: "Geoscientific Chaos Union" (GCU). Current look: dark terminal,
amber accent, mono-only. The team is "1+i developers" (Arthur + Claude);
the culture docs to know: no silent data loss (we surface everything —
badges/warns are load-bearing, not decoration), no magic-only UI (inferred
state must be visible and overridable).

## Your mission

Arthur: "we won't release before we make the UI as a whole way better …
we need a good design overhaul … the theme might be a bit too dark …
think hard." The release of ~15 features is **gated on this work**.

Read in order:
1. [`c6-design-overhaul.md`](c6-design-overhaul.md) — diagnoses, the
   Switchboard adoption rationale, phases C6-0…C6-5, and **decisions D1–D5
   that are PENDING with Arthur** (accent identity, font embedding, default
   theme, legacy-theme culling, menubar scope). Your design exploration
   feeds these decisions.
2. [`ui-design-system.md`](ui-design-system.md) — the **current** system
   (tokens, components, layout patterns, naming). You are superseding parts
   of it; what survives should be re-documented at the end.
3. `../auditable/ext/switchboard/SPEC.md` — the GCU design language you're
   adopting: token map, six-accent semantics (orange=action, teal=info,
   green=go, amber=caution, red=fault, indigo=selected), Barlow/Space Mono
   doctrinal split, component patterns, accessibility, anti-patterns.
   `switchboard.css` (93 lines) + `theme.js` + `fonts/` live beside it.
4. `CLAUDE.md` at the repo root — build/dev mechanics and standing rules
   (note: it's untracked, but you have folder access).

## Screenshots — `experiments/c6-shots/` (1600×900 @1.5x, current build)

| Shot | What it shows / what hurts |
|---|---|
| `01-landing-dropzone` | First-touch surface. Sparse; recents + example affordances exist but don't compose |
| `02-preflight` | Column config sidebar + sample table. The densest config surface |
| `03-summary` | Landing tab after analysis: geometry card, file info, column overview. Where the C6-5 data-health block will live |
| `04-aux-empty-state` | **Arthur's screenshot — the trigger.** Three unrelated blocks in a void; drillhole card styled as an afterthought; 0.65rem mono hint walls. Redesign target (C6-3) |
| `05-aux-loaded` | Aux config sidebar (prefix/coords/filter/weight/declustering) + preview |
| `06-statistics` | Sidebar (metrics toggles, percentiles, weight, variable list) + model/aux/Δ% table + CDF panel. Note ∅/✱ badge language |
| `07-swath` | Multi-direction swath + aux overlay + count strip. Sidebar: directions/statistic/display/variables/filter — flat wall |
| `08-gt` | **The C5 trigger**: nine undifferentiated sidebar sections (grades/density/weight/group/volume/units/format/cutoffs/filter/theoretical) before the Generate button |
| `09-categories` | Category chart + table + color chips |
| `10-tree-popover` | The C1a catalog tree row editor (color/unit/roles/pairing) |
| `11-context-menu` | The unified right-click menu (@gcu/menu) on a tree variable |
| `12-toolbar-menu` | The toolbar ⋮ with **Panels submenu expanded — the hidden reopen-closed-tabs affordance** that motivates the menubar's View menu |
| `13-workspace-split-float` | Rails docking: split stack + GT floated at 640×470 — see the sidebar wall problem compressed into a float |
| `14-settings-themes` | The legacy theme grid (default/teal/blue/mocha/light/cream/bm77 + custom slots) — superseded by Switchboard light/dark per D4 |
| `15/16-legacy-light-*` | The existing "light" theme — an accent remap on dark surfaces, not a designed light mode. The case for Switchboard |
| `17-preflight-dirty-badges` | A pathological file: EMPTY/MIXED column badges, ragged-row warn — the A8/A9 trust language in preflight |
| `18-summary-dirty-warns` | Coordinate-sentinel note in the geometry card |
| `19-statistics-dirty-warns` | ∅/✱ badges + the red `.swath-aux-warn` note style (class itself is slated for rename to `.warn-note`, C6-0) |
| `20/21-mobile-*` | 390×844 legacy tab shell — what C1c will turn into a pager. Tokens you define will flow here |

Regenerate any time: `node experiments/c6-shots.js` (add states as you need;
the file shows the Playwright patterns — `showPanel(id)`, `openSettings()`,
`applyTheme(name)`, `wsRails.moveTab/floatTab`, the dirty fixture).
The user-manual set (26 broader shots, slightly older build) is in
`experiments/manual/shots/`.

## Hard constraints

- **Single file, vanilla JS, no build-time CSS tooling.** All CSS is
  `src/styles.css`, concatenated by `node build.js` into `index.html`.
  Never hand-edit `index.html`. Verify with `node build.js && node check.js`.
- **The vendored components already read `--au-*`** (rails, menu — see
  `src/vendor-rails.js`, `src/vendor-menu.js`, and the `--rails-*` mapping
  block near the end of styles.css). Adoption plan: BMA's existing tokens
  (`--bg`, `--amber`, …) become an app layer **bound to** `--au-*`, so the
  body of styles.css keeps working; deltas are documented overrides.
- **Charts are inline SVG** generated by JS with colors mostly from the
  catalog palette + tokens; check `getSwathVarColor`/`STATSCAT_PALETTE`
  (core.js) when reasoning about chart colors on light surfaces — this is
  the one place "light theme" needs real design attention (grid lines,
  ribbons, crosshairs are currently dark-tuned).
- **Smokes must stay green** — they assert structure/behavior, not colors:
  `node experiments/{tree,rails,a9,empty-col,delta-row,declus-ui,topcut,logprob,gt-theo,drillhole}-smoke*.js`
  and `sidebar-scroll-check.js`. If you move markup, update selectors in the
  same change. Worker harnesses don't touch UI.
- **Don't push** — commit locally; Arthur decides pushes. `experiments/` is
  untracked scratch (screenshots live there on purpose).
- Eyeball your changes — screenshot after every visual change (house rule;
  it has caught real bugs).

## Working split (suggestion, Arthur arbitrates)

- C6-0 paper cuts are implementation-ready and design-independent; the
  resident session can take them any time.
- C6-1 (Switchboard foundation) is where your design authority matters
  most: the `--sw-* → --au-* → BMA` mapping, the typography split applied
  to BMA's surfaces, chart palette on light, and recommendations for D1–D4.
- C6-2/3/4 (menubar, aux empty state, sidebar flow) want
  mockups-before-code — even ASCII or annotated-screenshot level.
- Hand findings back as docs in `docs/` (this folder) and/or direct edits;
  the design doc's phase log is the shared ledger. The resident session
  keeps memory of decisions across sessions, so record decisions in the doc,
  not just in conversation.
