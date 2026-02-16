#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

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
  'project.js',
  'statistics.js',
  'export.js',
  'swath.js',
  'section.js',
  'calcol.js',
  'events.js',
  'filter.js',
  'settings.js',
  'cdf.js',
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

fs.writeFileSync(path.join(__dirname, 'index.html'), output);
console.log('Built index.html (%d bytes)', Buffer.byteLength(output));
