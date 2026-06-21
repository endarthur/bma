// Drives BMA through the example dataset with Playwright (system Edge) and
// captures the screenshots for the user manual. Run: node manual-shots.js
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require(path.join('..', 'node_modules', 'playwright'));

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });

// ── Example data files (same generator the app ships) ──
const docStub = { getElementById: () => null };
const ex = new Function('document',
  fs.readFileSync(path.join(ROOT, 'src', 'example.js'), 'utf8') +
  '\nreturn { exampleData };')(docStub);
const data = ex.exampleData();
const MODEL = path.join(__dirname, 'bma-example-model.csv');
const SAMPLES = path.join(__dirname, 'bma-example-samples.csv');
const COLLAR = path.join(__dirname, 'bma-example-collar.csv');
const SURVEY = path.join(__dirname, 'bma-example-survey.csv');
const ASSAYS = path.join(__dirname, 'bma-example-assays.csv');
const DOMAIN = path.join(__dirname, 'bma-example-domain.csv');
fs.writeFileSync(MODEL, data.model);
fs.writeFileSync(SAMPLES, data.samples);
fs.writeFileSync(COLLAR, data.collar);
fs.writeFileSync(SURVEY, data.survey);
fs.writeFileSync(ASSAYS, data.assays);
// A11 manual: a coarse domain table (same holes, 2 bands per hole, breaks that
// don't line up with the 2 m assays) to demo merging a 2nd interval table.
(function () {
  const byHole = {};
  for (const ln of data.assays.trim().split(/\r?\n/).slice(1)) {
    const c = ln.split(','); const h = c[0], f = +c[1], t = +c[2];
    if (!byHole[h]) byHole[h] = { min: f, max: t };
    byHole[h].min = Math.min(byHole[h].min, f); byHole[h].max = Math.max(byHole[h].max, t);
  }
  const out = ['BHID,FROM,TO,DOMAIN'];
  for (const h in byHole) {
    const { min, max } = byHole[h], mid = Math.round((min + max) / 2);
    out.push(h + ',' + min + ',' + mid + ',OXIDE'); out.push(h + ',' + mid + ',' + max + ',FRESH');
  }
  fs.writeFileSync(DOMAIN, out.join('\n'));
})();

// ── Tiny static server over the repo root ──
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(buf);
  });
});

(async () => {
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1380, height: 880 }, deviceScaleFactor: 1.5 });
  page.setDefaultTimeout(20000);

  const shot = async (name) => {
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(OUT, name + '.png') });
    console.log('shot:', name);
  };
  const tab = async (id) => { await page.evaluate((tid) => showPanel(tid), id); await page.waitForTimeout(250); };
  // C6-4b sidebars collapse advanced sections by default — open them so controls
  // are visible/interactable for the manual.
  const expandSidebar = async (sidebarSel) => { await page.evaluate((s) => { var sb = document.querySelector(s); if (sb) sb.querySelectorAll('[data-sb]').forEach(x => x.classList.remove('collapsed')); }, sidebarSel); await page.waitForTimeout(150); };
  const waitAnalysis = async () => {
    await page.waitForFunction(() => typeof lastCompleteData !== 'undefined' && lastCompleteData !== null && !document.querySelector('.reanalysis-overlay'));
    await page.waitForTimeout(400);
  };

  await page.goto('http://localhost:' + port + '/');
  await page.waitForSelector('#dropzone');
  await shot('01-landing');

  // Load the model, preflight
  await page.setInputFiles('#fileInput', MODEL);
  await page.waitForSelector('#preflightSidebar .pf-sidebar-section');
  await shot('02-preflight');

  // Analyze
  await page.click('#executeBtn');
  await waitAnalysis();
  await shot('03-summary');

  // Calc (model): tutorial calcols + simulate, then re-analyze so they exist
  await tab('calcols');
  await page.evaluate(() => {
    const ta = document.getElementById('calcolCodeArea');
    ta.value = "r.RATIO = r.Fe / r.SiO2;\nr.ORE = r.Fe > 55 ? 'ore' : 'waste';";
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(900); // debounce simulate
  await shot('04-calc');
  await page.click('#executeBtn');
  await waitAnalysis();

  // Statistics (primary): select Fe CDF
  await tab('statistics');
  await page.click('a.cdf-link[data-col="3"]');
  await shot('05-statistics');

  // StatsCat: group by LITO (triggers re-analysis with grouped stats)
  await tab('statscat');
  await page.selectOption('#statsCatGroupBy', { label: 'LITO' });
  await page.waitForTimeout(400);
  const needsRun = await page.evaluate(() => typeof analysisStale !== 'undefined' && analysisStale);
  if (needsRun) { await page.click('#executeBtn'); await waitAnalysis(); await tab('statscat'); }
  await shot('06-statscat');

  // GT: density column + group by LITO
  await tab('gt');
  await expandSidebar('#gtSidebar');
  await page.selectOption('#gtDensityCol', { label: 'DENSITY' });
  await page.selectOption('#gtGroupBy', { label: 'LITO' });
  await page.waitForTimeout(300);
  await page.click('#gtGenerate');
  await page.waitForSelector('.gt-svg');
  await shot('07-gt');

  // Export tab
  await tab('export');
  await shot('08-export');

  // Drillhole ingestion (A7): trio -> mapping panel -> composites, then clear.
  // A10 phase 5: the drillhole card is per-dataset (data-dh attrs, scoped to #panelAux).
  await tab('aux');
  await page.setInputFiles('#panelAux [data-dh="fileInput"]', [COLLAR, SURVEY, ASSAYS]);
  await page.waitForSelector('#panelAux [data-dh="go"]:not([disabled])');
  await shot('25-dh-mapping');
  // A11: merge a 2nd interval table (the coarse domain table) + tick a split, then
  // bring the compositing surface + merge panel into view for the shot.
  await page.setInputFiles('#panelAux [data-dh="fileInput"]', [DOMAIN]);
  await page.waitForSelector('#panelAux .dh-merge-panel', { state: 'attached' });
  await page.evaluate(() => {
    var sp = document.querySelector('#panelAux [data-dh="split"][data-dh-col="LITO"]');
    if (sp && !sp.checked) { sp.checked = true; sp.dispatchEvent(new Event('change', { bubbles: true })); }
    var el = document.querySelector('#panelAux .dh-merge-panel');
    if (el) el.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(300);
  await shot('27-dh-merge');
  await page.evaluate(() => document.querySelector('#panelAux [data-dh="go"]').click());
  await page.waitForFunction(() => auxPreflightData && auxPreflightData.header.includes('SUPPORT'));
  await shot('26-dh-loaded');
  // A17: the report modal renders the consistency report + the before/after histogram.
  await page.evaluate(() => dhOpenReportModal(dsById('aux')));
  await page.waitForSelector('#dhReportModal.active .dh-hist', { state: 'attached' });
  await shot('28-dh-histogram');
  await page.evaluate(() => document.getElementById('dhReportClose').click());
  await page.evaluate(() => { clearAux(); dhResetAll(); });
  await page.waitForTimeout(300);

  // Aux: load samples, weight SUPPORT, analyze
  await tab('aux');
  await page.setInputFiles('#auxFileInput', SAMPLES);
  await page.waitForSelector('[data-aux="weight"]');
  await page.selectOption('[data-aux="weight"]', { label: 'SUPPORT' });
  await page.evaluate(() => { var s = document.querySelector('[data-aux="weight"]'); s.dispatchEvent(new Event('change', { bubbles: true })); });
  await shot('09-aux-config');
  await page.click('[data-act="auxAnalyze"]');
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-aux="analyzeStatus"]');
    return el && /rows analyzed|linhas/.test(el.textContent);
  });

  // Statistics with aux comparison + CDF overlay
  await tab('statistics');
  await page.waitForSelector('a.cdf-link[data-cmp-col]');
  const auxFeLink = await page.evaluateHandle(() => {
    return Array.from(document.querySelectorAll('a.cdf-link[data-cmp-col]')).find(a => a.textContent.includes(':Fe'));
  });
  await auxFeLink.asElement().click();
  await shot('10-statistics-aux');

  // Q-Q mode
  await page.click('.stats-cdfmode[data-cdfmode="qq"]');
  await shot('11-qq');
  await page.click('.stats-cdfmode[data-cdfmode="cdf"]');

  // Categories with aux comparison: focus LITO
  await tab('categories');
  await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.cat-col-item'));
    const lito = items.find(i => i.textContent.includes('LITO'));
    if (lito) lito.click();
  });
  await page.waitForSelector('#catChart svg');
  await shot('12-categories-aux');

  // Swath with aux overlay
  await tab('swath');
  await page.waitForSelector('#swathGenerate');
  await page.click('#swathGenerate');
  await page.waitForSelector('.swath-overlay-svg');
  await shot('13-swath-aux');

  // Calc in Aux mode
  await tab('calcols');
  await page.click('.calcol-mode-btn[data-mode="aux"]');
  await page.evaluate(() => {
    const ta = document.getElementById('calcolCodeArea');
    ta.value = 'aux.RATIO = aux.Fe / aux.SiO2;';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(900);
  await shot('14-calc-aux');
  await page.click('.calcol-mode-btn[data-mode="model"]');   // A10 G1: mode btns are dataset ids (was "primary")

  // Declustering: run the sweep, scroll the sidebar to the curve
  await tab('aux');
  await expandSidebar('#panelAux');
  await page.evaluate(() => {
    const el = document.querySelector('[data-act="auxDeclusRun"]');
    if (el) el.scrollIntoView({ block: 'center' });
  });
  await page.click('[data-act="auxDeclusRun"]');
  await page.waitForSelector('.aux-declus-curve', { state: 'attached' });
  await expandSidebar('#panelAux');   // the re-render re-applies collapse defaults
  await page.evaluate(() => {
    var c = document.querySelector('.aux-declus-curve'); if (c) c.scrollIntoView({ block: 'center' });
  });
  await shot('18-declus');

  // Top-cut view (four linked plots, default cap at P99)
  await page.click('.aux-view-btn[data-auxview="topcut"]');
  await page.waitForSelector('[data-aux="topcutVar"]');
  await page.selectOption('[data-aux="topcutVar"]', 'Fe');
  await page.click('[data-act="auxTopcutLoad"]');
  await page.waitForSelector('.tc-grid', { timeout: 30000 });
  await shot('19-topcut');
  await page.click('.aux-view-btn[data-auxview="preview"]');

  // Log-probability CDF mode (Fe + aux:Fe curves already selected)
  await tab('statistics');
  await page.click('.stats-cdfmode[data-cdfmode="logprob"]');
  await shot('20-logprob');
  await page.click('.stats-cdfmode[data-cdfmode="cdf"]');

  // GT theoretical overlay (ungrouped charts only)
  await tab('gt');
  await expandSidebar('#gtSidebar');
  await page.selectOption('#gtGroupBy', '-1');
  await page.check('#gtTheoEnabled');
  await page.click('#gtGenerate');
  await page.waitForFunction(() => typeof gtTheo !== 'undefined' && gtTheo && Object.keys(gtTheo.byVar).length > 0);
  await page.waitForTimeout(700);
  await shot('21-gt-theo');

  // Data tree: editor popover on an aux variable (pairing select visible)
  await tab('statistics');
  await page.click('#catalogTree .tree-ds:nth-of-type(2) .tree-row--edit[data-name="Fe"]');
  await page.waitForSelector('#treePopover.open #treePopPair');
  await shot('22-tree');
  await page.keyboard.press('Escape');

  // Context menu on a stats-table aux variable
  await page.locator('table.stats a[data-cmp-col]').first().click({ button: 'right' });
  await page.waitForSelector('.gcu-menu');
  await shot('23-ctxmenu');
  await page.keyboard.press('Escape');

  // Docking workspace (C1b): Statistics over Swath, GT floating
  await page.evaluate(() => {
    wsRails.moveTab('swath', { to: 'new-stack', railId: 'rMain', at: 1 });
    wsRails.floatTab('gt', { x: 470, y: 120, w: 640, h: 470 });
    wsRails.activateTab('statistics');
  });
  await page.waitForTimeout(800); // panel transition + chart re-render at new widths
  await shot('24-workspace');
  await page.evaluate(() => wsResetLayout());
  await page.waitForTimeout(400);

  // Pack dialog (the toolbar button is folded into the menubar on the rails shell —
  // fire its handler directly)
  await page.evaluate(() => document.getElementById('projectPack').click());
  await page.waitForSelector('#packModal.active');
  await page.fill('#packTitle', 'Projeto Serra Exemplo');
  await shot('15-pack');
  await page.click('#packCancel');

  // Update banner (staged for the manual)
  await page.evaluate(() => showUpdateBanner());
  await shot('16-update-banner');
  await page.evaluate(() => document.getElementById('updateBanner').classList.remove('on'));

  // Packed-project drop: build the example zip and drop it on a fresh page
  const exFull = new Function('document',
    fs.readFileSync(path.join(ROOT, 'src', 'example.js'), 'utf8') +
    '\nreturn { exampleData, buildStoredZip, exampleProjectJson, EXAMPLE_TUTORIAL };')(docStub);
  const enc2 = new TextEncoder();
  const zBlob = await exFull.buildStoredZip([
    { name: 'bma-example-model.csv', blob: new Blob([data.model]) },
    { name: 'bma-example-samples.csv', blob: new Blob([data.samples]) },
    { name: 'bma-example-collar.csv', blob: new Blob([data.collar]) },
    { name: 'bma-example-survey.csv', blob: new Blob([data.survey]) },
    { name: 'bma-example-assays.csv', blob: new Blob([data.assays]) },
    { name: 'bma-example.bma.json', blob: new Blob([exFull.exampleProjectJson(enc2.encode(data.model).length, enc2.encode(data.samples).length)]) },
    { name: 'TUTORIAL.txt', blob: new Blob([exFull.EXAMPLE_TUTORIAL]) }
  ]);
  const ZIPPATH = path.join(__dirname, 'bma-example.zip');
  fs.writeFileSync(ZIPPATH, Buffer.from(await zBlob.arrayBuffer()));
  const page2 = await browser.newPage({ viewport: { width: 1380, height: 880 }, deviceScaleFactor: 1.5 });
  page2.setDefaultTimeout(20000);
  await page2.goto('http://localhost:' + port + '/');
  await page2.waitForSelector('#dropzone');
  await page2.setInputFiles('#fileInput', ZIPPATH);
  await page2.waitForSelector('#confirmModal.active');
  await page2.waitForTimeout(350);
  await page2.screenshot({ path: path.join(OUT, '17-packed-load.png') });
  console.log('shot: 17-packed-load');

  // Model-optional: a fresh empty project (no model), tree + "no model" import state
  const page3 = await browser.newPage({ viewport: { width: 1380, height: 880 }, deviceScaleFactor: 1.5 });
  page3.setDefaultTimeout(20000);
  await page3.goto('http://localhost:' + port + '/');
  await page3.waitForSelector('#newProjectBtn');
  await page3.click('#newProjectBtn');
  await page3.waitForSelector('.preflight-empty-state');
  await page3.waitForTimeout(350);
  await page3.screenshot({ path: path.join(OUT, '27-empty-project.png') });
  console.log('shot: 27-empty-project');

  await browser.close();
  server.close();
  console.log('DONE — shots in', OUT);
})().catch(e => { console.error('DRIVER FAILED:', e.message); process.exit(1); });
