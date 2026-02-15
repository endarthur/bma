# BMA UI/UX Design System

Reference document for consistent implementation of new features and tabs.

## Theme

Dark terminal aesthetic with amber accent. Monospace-only. "Geoscientific Chaos Union" branding.

## Color Tokens

| Token | Value | Use |
|-------|-------|-----|
| `--bg` | `#08090a` | Primary background (darkest) |
| `--bg1` | `#0f1114` | Sidebar backgrounds, table headers |
| `--bg2` | `#161a1e` | Section heads, hover backgrounds |
| `--bg3` | `#1e2328` | Raised surfaces, scrollbar thumbs |
| `--fg` | `#c8cdd3` | Primary text |
| `--fg-dim` | `#6b7280` | Labels, hints, disabled text |
| `--fg-bright` | `#e8ecf0` | Emphasized text, input values |
| `--amber` | `#e8a317` | Primary accent, active states, buttons |
| `--amber-dim` | `#b07a0e` | Badge backgrounds |
| `--amber-glow` | `#e8a31730` | Selected item backgrounds |
| `--blue` | `#4a9eff` | Numeric type indicators |
| `--green` | `#34d399` | Categorical type indicators |
| `--red` | `#f87171` | Errors, warnings |
| `--border` | `#252a30` | All borders and dividers |
| `--mono` | IBM Plex Mono, JetBrains Mono | Only font family used |

## Typography Scale

| Use | Size | Weight | Color | Extras |
|-----|------|--------|-------|--------|
| Panel heading | 0.78rem | 600 | `--amber` | uppercase, 0.06em spacing |
| Sidebar title | 0.62rem | 400 | `--fg-dim` | uppercase, 0.08em spacing |
| Body / inputs | 0.72rem | 400 | `--fg` / `--fg-bright` | |
| Labels | 0.65rem | 600 | `--fg-dim` | 0.04em spacing |
| Hints | 0.78rem | 400 | `--fg-dim` | opacity 0.5, centered |
| Badges | 0.55rem | 600 | `--bg` on `--amber-dim` | pill shape |
| Tiny text | 0.6rem | 400 | `--fg-dim` | bin labels, axis ticks |

## Layout Patterns

### Pattern A: Sidebar + Content (preferred for data exploration tabs)

Used by: **Preflight, StatsCat, Swath**

```
.tab-body {
  display: flex;
  flex: 1;
  min-height: 0;
}
.tab-sidebar {
  width: 260px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg1);
}
.tab-content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 1rem;
}
```

**Sidebar sections** stack vertically with `border-bottom` dividers:
- **Fixed sections** (`padding: 0.5rem 0.7rem; flex-shrink: 0;`): dropdowns, inputs, buttons
- **Growable sections** (`flex: 1; min-height: 0; overflow: hidden;`): scrollable lists

**Mobile (max-width: 700px)**: Sidebar goes full-width on top, content below. Sections become collapsible.

### Pattern B: Config Bar + Canvas (for spatial/visual views)

Used by: **Section**

```
.config-bar {
  display: flex;
  gap: 0.6rem;
  flex-wrap: wrap;
  align-items: flex-end;
  padding: 0.6rem 1rem;
  border-bottom: 1px solid var(--border);
}
.canvas-wrap {
  position: relative;
  flex: 1;
  min-height: 300px;
  overflow: hidden;
}
```

Appropriate when: full-viewport interactive canvas, controls are few and flat.

### Pattern C: Scrollable Card Layout (for output/results)

Used by: **Summary, Statistics, Categories, Export**

```
.panel-inner {
  padding: 1rem;
  max-width: 1600px;
  margin: 0 auto;
}
```

Contains `.section` blocks with `.section-head` + `.section-body`.

## Component Library

### Select

```css
.tab-select {
  font-family: var(--mono);
  font-size: 0.72rem;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 0.2rem 0.5rem;
  width: 100%;
  cursor: pointer;
}
.tab-select:focus { border-color: var(--amber); outline: none; }
```

### Text Input

```css
.tab-input {
  font-family: var(--mono);
  font-size: 0.72rem;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 0.2rem 0.5rem;
  width: 100%;
}
.tab-input:focus { border-color: var(--amber); outline: none; }
```

### Search / Filter Input (styled dark)

```css
.tab-search {
  width: 100%;
  background: var(--bg);
  color: var(--fg-bright);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 0.3rem 0.5rem;
  font-family: var(--mono);
  font-size: 0.68rem;
}
.tab-search::placeholder { color: var(--fg-dim); opacity: 0.5; }
.tab-search:focus { outline: none; border-color: var(--amber); }
```

**Never use raw `<input>` without dark styling.** Every input must have `background: var(--bg)` and amber focus border.

### Primary Button (Generate / Render / Execute)

```css
.tab-primary-btn {
  background: var(--amber);
  color: var(--bg);
  border: none;
  padding: 0.4rem 1rem;
  border-radius: 3px;
  cursor: pointer;
  font: 600 0.75rem var(--mono);
  width: 100%;  /* full-width in sidebar context */
}
.tab-primary-btn:hover { filter: brightness(1.15); }
.tab-primary-btn:disabled { opacity: 0.4; cursor: not-allowed; }
```

### Secondary Button (Reset / Clear / Toggle)

```css
background: none;
border: 1px solid var(--border);
color: var(--fg-dim);
padding: 0.3rem 0.6rem;
border-radius: 3px;
font: 0.68rem var(--mono);
```

Hover: `border-color: var(--fg-dim); color: var(--fg);`

### Checkbox List Item

```css
.tab-var-item {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.2rem 0.4rem;
  font-size: 0.72rem;
  cursor: pointer;
  border-radius: 2px;
}
.tab-var-item:hover { background: var(--bg2); }
.tab-var-item input { cursor: pointer; accent-color: var(--amber); }
```

### Progress Bar

```css
.tab-progress { display: none; margin-top: 0.4rem; }
.tab-progress.active { display: block; }
.tab-progress-bar {
  height: 4px;
  background: var(--bg2);
  border-radius: 2px;
  overflow: hidden;
}
.tab-progress-fill {
  height: 100%;
  width: 0;
  background: var(--amber);
  transition: width 0.15s;
}
.tab-progress-label {
  font-size: 0.62rem;
  color: var(--fg-dim);
  margin-top: 0.2rem;
}
```

Progress bar goes **below the Generate button** in sidebar layout, visible during computation.

### Expression Input (autocomplete + validation)

Attaches autocomplete and syntax validation to any `<input>` or `<textarea>` that accepts expression DSL (e.g. `r.Fe > 60`). Created via `createExprInput(element, options)`.

**API**:

```js
const controller = createExprInput(element, {
  dropdownElement: null,   // existing dropdown div (null = auto-create)
  errorElement: null,      // existing error div (null = auto-create)
  excludeCalcolId: null,   // () => id, for calcol editor to skip self
  onInput: null,           // (val) => void, called on input
  onAccept: null,          // (val) => void, called after AC accept
  onEnter: null,           // () => void, called on Enter when AC closed
  mode: 'filter',          // 'filter' wraps as !!(expr), 'expression' as (expr)
  validateOnBlur: true     // run validation on blur + debounced input
});

// Returns:
controller.validate()   // run validation, update error element, return { valid, error, warnings[] }
controller.getErrors()  // last validation result without re-running
controller.destroy()    // remove listeners, cleanup created DOM
```

**Auto-created DOM**: When `dropdownElement` is null, the factory wraps the input in `<span class="expr-ac-wrap">` (for positioning) and creates a `<div class="expr-ac">` dropdown. When `errorElement` is null, it creates `<div class="expr-error">` after the input.

**CSS classes**:

```css
.expr-ac-wrap          /* position: relative wrapper */
.expr-ac               /* dropdown (same style as .calcol-ac) */
.expr-ac.open          /* visible state */
.expr-error            /* error/warning text (hidden by default) */
.expr-error.active     /* visible state */
```

**Dynamic inputs (destroy/recreate pattern)**: For inputs inside dynamically rendered HTML (swath sidebar, section config bar), call `destroy()` before the parent innerHTML is replaced, then re-create:

```js
let myController = null;

function renderMyConfig() {
  if (myController) myController.destroy();
  $container.innerHTML = '...';  // creates new input
  myController = createExprInput(document.getElementById('myFilter'), { mode: 'filter' });
}
```

**Pre-validation before worker dispatch**: Call `validate()` before sending to worker to catch syntax errors early:

```js
if (myController) { const r = myController.validate(); if (!r.valid) return; }
```

**Existing usage sites**: calcol editor (with `dropdownElement`/`errorElement` reuse), footer filter, swath local filter, section local filter.

### Hint / Empty State

```css
.tab-hint {
  color: var(--fg-dim);
  font-size: 0.78rem;
  padding: 2rem;
  text-align: center;
  opacity: 0.5;
}
```

## Interactive States

| State | Style |
|-------|-------|
| Hover (buttons) | `filter: brightness(1.15)` or border/color upgrade |
| Hover (rows) | `background: var(--bg2)` |
| Focus (all inputs) | `border-color: var(--amber); outline: none;` |
| Active tab | `color: var(--amber); border-bottom-color: var(--amber);` |
| Selected item | `background: var(--amber-glow); border-left: 2px solid var(--amber);` |
| Disabled | `opacity: 0.4; cursor: not-allowed;` |
| Transition | `0.15s` for all interactive feedback |

## Spacing Rules

| Context | Value |
|---------|-------|
| Container padding | 1rem |
| Sidebar section padding | 0.5rem 0.7rem |
| Between sidebar sections | `border-bottom` (no margin) |
| Input vertical gap | 0.3rem - 0.4rem |
| Flex gaps (small) | 0.3rem |
| Flex gaps (medium) | 0.6rem |
| Flex gaps (large) | 1rem |
| Chart card spacing | margin-bottom: 1.5rem |

## Responsive Breakpoints

| Breakpoint | Behavior |
|------------|----------|
| max-width: 700px | Sidebars stack vertically (full-width), sections collapsible, toolbar collapses |
| min-width: 1024px | Wider padding, summary grid 2-column |
| min-width: 1400px | Even wider padding |

## CSS Naming Convention

**Pattern**: `{tab}-{component}` with hyphens. Each tab owns a prefix:

| Prefix | Tab |
|--------|-----|
| `pf-` | Preflight |
| `statscat-` | StatsCat |
| `swath-` | Swath |
| `section-` | Section |
| `export-` | Export |
| `cat-` | Categories |
| `calcol-` | Calculated Columns |
| `filter-` | Footer Filter |
| `toolbar-` | Results Toolbar |
| `cdf-` | CDF Modal |
| `geo-` | Geometry |

Modifiers use `--` suffix: `.statscat-sidebar-section--grow`

State classes: `.active`, `.editing`, `.collapsed`, `.hidden`, `.skipped`

## New Tab Checklist

When implementing a new tab:

1. **Choose layout pattern** A (sidebar+content) or B (config-bar+canvas) based on the tab's purpose
2. **Use the tab's prefix** for all CSS classes (e.g., `variogram-sidebar`, `variogram-content`)
3. **Clone component styles** from this doc (don't invent new input/button styles)
4. **Style all inputs** with dark background + amber focus (never leave raw white inputs)
5. **Add progress bar** below the action button in the sidebar
6. **Add hint text** for empty/initial state
7. **Add mobile breakpoint** at 700px (sidebar stacks on top)
8. **Worker communication**: use `{type: 'tab-progress'}` and `{type: 'tab-complete'}` naming
9. **Disable action button** during computation, re-enable on complete/error
10. **Tab badge**: update with result count on completion

## Anti-Patterns (avoid)

- Raw white `<input>` elements without dark theme styling
- Flat horizontal toolbar for tabs with many controls (use sidebar instead)
- Single-variable selection when multi-variable makes sense
- Missing progress indication during file reads
- Inline styles instead of CSS classes (except dynamic values like widths)
- Creating new color values outside the token system
- Sans-serif fonts or non-monospace type
