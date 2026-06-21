// Renders manual/manual-en.html to BMA-Manual-EN.pdf via Edge.
const path = require('path');
const fs = require('fs');
const { chromium } = require(path.join('..', 'node_modules', 'playwright'));

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  await page.goto('file:///' + path.join(__dirname, 'manual-en.html').replace(/\\/g, '/'));
  await page.waitForLoadState('networkidle');
  const out = path.join(__dirname, 'BMA-Manual-EN.pdf');
  await page.pdf({
    path: out,
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate: '<div style="width:100%;text-align:center;font-size:7.5px;color:#999;font-family:Consolas,monospace;">BMA — User Manual · <span class="pageNumber"></span>/<span class="totalPages"></span></div>',
    margin: { top: '14mm', bottom: '16mm', left: '0', right: '0' }
  });
  await browser.close();
  const bytes = fs.readFileSync(out);
  const pages = (bytes.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  console.log('PDF written:', out, '—', (bytes.length / 1024 / 1024).toFixed(1), 'MB,', pages, 'pages');
})().catch(e => { console.error('PDF FAILED:', e.message); process.exit(1); });
