#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const src = (...p) => path.join(__dirname, 'src', ...p);
const read = (f) => fs.readFileSync(f, 'utf-8');

// Read source files (trimEnd to avoid extra blank lines at injection boundaries)
const template = read(src('template.html'));
let css = read(src('styles.css')).trimEnd();
const workerRaw = read(src('worker.js')).trimEnd();

// C6-1b (D2): embed the Switchboard font subsets as base64 @font-face.
// Files are COPIES from auditable/ext/switchboard/fonts/ (OFL.txt alongside) —
// re-copy from upstream to update, don't edit. ~78KB raw → ~105KB base64.
const FONTS = [
  ['Barlow', 400, 'barlow-400.woff2'],
  ['Barlow', 600, 'barlow-600.woff2'],
  ['Space Mono', 400, 'space-mono-400.woff2'],
  ['Space Mono', 700, 'space-mono-700.woff2'],
];
const fontCss = FONTS.map(([family, weight, file]) => {
  const b64 = fs.readFileSync(src('fonts', file)).toString('base64');
  return `@font-face { font-family: '${family}'; font-style: normal; font-weight: ${weight}; font-display: swap; src: url(data:font/woff2;base64,${b64}) format('woff2'); }`;
}).join('\n');
css = css.replace('/* __INJECT_FONTS__ */', () => fontCss);

// App modules — concatenated in order (core must be first, cdf/events last)
const APP_MODULES = [
  'core.js',
  'derivation.js',     // C12-P0 — the Derivation contract (derived-data DAG), inert projection over live state
  'vendor-rails.js',   // vendored @gcu/rails (C1b) — pinned, see file header
  'vendor-menu.js',    // vendored @gcu/menu (C1b-3, D7) — pinned, call via Menu.*
  'vendor-drillhole.js', // @gcu/drillhole REVERSE-vendored (A7 D9) — born here, upstreams to auditable/ext later
  'preflight.js',
  'auxtab.js',
  'drillhole.js',      // A7 drillhole ingestion UI (uses vendor-drillhole.js + auxtab's loadAuxFile)
  'topcut.js',
  'project.js',
  'statistics.js',
  'export.js',
  'swath.js',
  'crosstab.js',       // A19 categorical cross-tabulation tab (own worker pass)
  'gt.js',
  'section.js',
  'calcol.js',
  'events.js',
  'filter.js',
  'settings.js',
  'categories.js',
  'tree.js',
  'ctxmenu.js',
  'cdf.js',
  'example.js',
  'workspace.js',      // C1b shells — top-level init must run after tree.js
  'pwa.js',
];
const app = APP_MODULES.map(f => read(src(f)).trimEnd()).join('\n\n');

// Escape worker code for template literal embedding:
// - Backslashes: \ → \\  (must be first)
// - Backticks:   ` → \`
// - ${:          ${ → \${
const workerEscaped = workerRaw
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$\{/g, '\\${');

const workerBlock = `// ─── Worker Code (inlined as Blob) ────────────────────────────────────\nconst WORKER_CODE = \`\n${workerEscaped}\n\`;\n`;

// Assemble (use function replacements to avoid $' $` $& special patterns)
let output = template
  .replace('/* __INJECT_CSS__ */', () => css)
  .replace('// __INJECT_WORKER__', () => workerBlock)
  .replace('// __INJECT_APP__', () => app);

// Build id: short content hash of the assembled bundle (deterministic — same
// src, same hash). Injected into the page (corner badge) and the service
// worker cache name, so every deploy auto-busts old SW caches.
const buildId = crypto.createHash('sha256').update(output).digest('hex').slice(0, 7);
output = output.replace(/__BMA_BUILD__/g, buildId);

const swSource = read(src('sw.js')).replace(/__BMA_BUILD__/g, buildId);
fs.writeFileSync(path.join(__dirname, 'sw.js'), swSource);

fs.writeFileSync(path.join(__dirname, 'index.html'), output);
console.log('Built index.html (%d bytes) — build %s', Buffer.byteLength(output), buildId);
