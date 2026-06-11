#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const src = (...p) => path.join(__dirname, 'src', ...p);
const read = (f) => fs.readFileSync(f, 'utf-8');

// Read source files (trimEnd to avoid extra blank lines at injection boundaries)
const template = read(src('template.html'));
const css = read(src('styles.css')).trimEnd();
const workerRaw = read(src('worker.js')).trimEnd();

// App modules — concatenated in order (core must be first, cdf/events last)
const APP_MODULES = [
  'core.js',
  'preflight.js',
  'auxtab.js',
  'topcut.js',
  'project.js',
  'statistics.js',
  'export.js',
  'swath.js',
  'gt.js',
  'section.js',
  'calcol.js',
  'events.js',
  'filter.js',
  'settings.js',
  'categories.js',
  'cdf.js',
  'example.js',
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
