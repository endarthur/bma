#!/usr/bin/env node
// Syntax-check src/ files and the built index.html
const fs = require('fs');
const path = require('path');

const src = (f) => path.join(__dirname, 'src', f);
let ok = true;

function check(label, code) {
  try {
    new Function(code);
    console.log('  OK  %s', label);
  } catch (e) {
    console.error(' FAIL %s — %s', label, e.message);
    ok = false;
  }
}

// 1. Check source files
console.log('Source files:');
check('src/worker.js', fs.readFileSync(src('worker.js'), 'utf-8'));

const APP_MODULES = [
  'core.js', 'preflight.js', 'project.js', 'export.js',
  'swath.js', 'section.js', 'calcol.js', 'events.js',
  'filter.js', 'cdf.js',
];
// Individual modules reference shared globals, so check them concatenated
const appCode = APP_MODULES.map(f => fs.readFileSync(src(f), 'utf-8')).join('\n');
check('src/app modules', appCode);

// 2. Check built output
const indexPath = path.join(__dirname, 'index.html');
if (fs.existsSync(indexPath)) {
  console.log('\nBuilt output:');
  const html = fs.readFileSync(indexPath, 'utf-8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (m) {
    check('index.html <script>', m[1]);
  } else {
    console.error(' FAIL index.html — no <script> block found');
    ok = false;
  }
} else {
  console.log('\nindex.html not found — run `node build.js` first');
  ok = false;
}

process.exit(ok ? 0 : 1);
