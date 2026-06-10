// ─── Example dataset generator ────────────────────────────────────────
// Landing-page button that builds and downloads bma-example.zip: a synthetic
// block model + the composites "behind" it + TUTORIAL.txt. Everything is
// generated client-side and deterministic (seeded PRNG), so every download
// is byte-identical. The samples carry a planted +2% Fe bias and the model
// an Fe trend along X, so the tutorial's punchlines actually show up.

// ── Minimal store-mode ZIP writer (no compression, no dependencies) ──
// Assembles the archive from Blob parts: data blobs are referenced, never
// copied, so packing multi-GB files stays memory-flat — the only full read
// is the streaming CRC pass.
var _crcTable = null;
function crc32Update(crc, bytes) {
  if (!_crcTable) {
    _crcTable = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      _crcTable[n] = c;
    }
  }
  for (var i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ _crcTable[(crc ^ bytes[i]) & 0xFF];
  return crc;
}

// files: [{name, blob}] → Blob (zip, stored entries). onProgress(percent)
// covers the CRC read pass. Pass precomputedCrcs (one per file, e.g. from
// the worker's crc32 mode) to skip the main-thread read entirely.
async function buildStoredZip(files, onProgress, precomputedCrcs) {
  var enc = new TextEncoder();
  var dosTime = (12 << 11);                              // 12:00:00
  var dosDate = ((2026 - 1980) << 9) | (6 << 5) | 9;     // 2026-06-09

  var totalBytes = 0;
  var archiveBytes = 22;
  for (var fi = 0; fi < files.length; fi++) {
    var nb = enc.encode(files[fi].name).length;
    totalBytes += files[fi].blob.size;
    archiveBytes += 30 + nb + files[fi].blob.size + 46 + nb;
  }
  if (archiveBytes > 0xFFFFFF00) throw new Error('Archive would exceed the 4 GB ZIP limit.');

  // CRC pass — the one full read of the data (skipped when precomputed)
  var entries = [];
  var done = 0;
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    var crcFinal;
    if (precomputedCrcs) {
      crcFinal = precomputedCrcs[i];
    } else {
      var crc = -1;
      var reader = f.blob.stream().getReader();
      while (true) {
        var r = await reader.read();
        if (r.done) break;
        crc = crc32Update(crc, r.value);
        done += r.value.length;
        if (onProgress && totalBytes > 0) onProgress(Math.round((done / totalBytes) * 100));
      }
      crcFinal = (crc ^ -1) >>> 0;
    }
    entries.push({ nameBytes: enc.encode(f.name), blob: f.blob, crc: crcFinal, offset: 0 });
  }

  function record(byteLen, write) {
    var buf = new ArrayBuffer(byteLen);
    var dv = new DataView(buf);
    var u8 = new Uint8Array(buf);
    var pos = 0;
    write({
      u16: function(v) { dv.setUint16(pos, v, true); pos += 2; },
      u32: function(v) { dv.setUint32(pos, v, true); pos += 4; },
      put: function(bytes) { u8.set(bytes, pos); pos += bytes.length; }
    });
    return buf;
  }

  var parts = [];
  var offset = 0;
  entries.forEach(function(e) {
    e.offset = offset;
    var size = e.blob.size;
    parts.push(record(30 + e.nameBytes.length, function(w) {
      w.u32(0x04034b50); w.u16(20); w.u16(0); w.u16(0); w.u16(dosTime); w.u16(dosDate);
      w.u32(e.crc); w.u32(size); w.u32(size);
      w.u16(e.nameBytes.length); w.u16(0); w.put(e.nameBytes);
    }));
    parts.push(e.blob); // referenced, not copied
    offset += 30 + e.nameBytes.length + size;
  });
  var cdStart = offset;
  var cdSize = 0;
  entries.forEach(function(e) {
    var size = e.blob.size;
    parts.push(record(46 + e.nameBytes.length, function(w) {
      w.u32(0x02014b50); w.u16(20); w.u16(20); w.u16(0); w.u16(0); w.u16(dosTime); w.u16(dosDate);
      w.u32(e.crc); w.u32(size); w.u32(size);
      w.u16(e.nameBytes.length); w.u16(0); w.u16(0); w.u16(0); w.u16(0); w.u32(0); w.u32(e.offset);
      w.put(e.nameBytes);
    }));
    cdSize += 46 + e.nameBytes.length;
  });
  parts.push(record(22, function(w) {
    w.u32(0x06054b50); w.u16(0); w.u16(0); w.u16(entries.length); w.u16(entries.length);
    w.u32(cdSize); w.u32(cdStart); w.u16(0);
  }));
  return new Blob(parts, { type: 'application/zip' });
}

// ── Deterministic data generation ──
function exampleData() {
  var seed = 19937;
  function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
  function gauss() { return (rnd() + rnd() + rnd() + rnd() - 2) / 2; } // ~N(0, 0.29)
  function clampv(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // The shared "geology": Fe trend along X, fold along Y, slight depth trend.
  // xi/yi in block units (0..23), zi in levels (0..9) — continuous for samples.
  function feAt(xi, yi, zi) { return 44 + 0.55 * xi + 3.5 * Math.sin(yi / 3.5) + 0.45 * (zi - 4.5); }

  // Block model: 24 x 24 x 10 grid, 10 m blocks, SMU-style smooth values
  var model = 'X,Y,Z,Fe,SiO2,Al2O3,DENSITY,LITO\n';
  for (var xi = 0; xi < 24; xi++) {
    for (var yi = 0; yi < 24; yi++) {
      for (var zi = 0; zi < 10; zi++) {
        var fe = clampv(feAt(xi, yi, zi) + gauss() * 1.6, 30, 68);
        var sio2 = clampv(38 - 0.45 * fe + gauss() * 1.4, 0.5, 30);
        var al = clampv(3.5 + 1.2 * Math.cos(xi / 4) + gauss() * 0.7, 0.2, 9);
        var den = clampv(2.1 + 0.028 * fe + gauss() * 0.05, 2.2, 4.2);
        var lito = fe > 58 ? 'HEM' : (fe > 48 ? 'ITA' : 'CGA');
        model += (600005 + xi * 10) + ',' + (7780005 + yi * 10) + ',' + (805 + zi * 10) + ',' +
          fe.toFixed(2) + ',' + sio2.toFixed(2) + ',' + al.toFixed(2) + ',' + den.toFixed(3) + ',' + lito + '\n';
      }
    }
  }

  // Composites: 420 samples in the same volume, same geology but with a
  // planted +2% Fe bias, more noise (point support), and composite lengths
  var samples = 'EAST,NORTH,ELEV,Fe,SiO2,Al2O3,SUPPORT\n';
  for (var si = 0; si < 420; si++) {
    var sx = rnd() * 240, sy = rnd() * 240, sz = rnd() * 100;
    var sfe = clampv(feAt(sx / 10, sy / 10, sz / 10) + 2.0 + gauss() * 3.2, 25, 70);
    var ssio2 = clampv(38 - 0.45 * sfe + gauss() * 2.4, 0.3, 34);
    var sal = clampv(3.5 + 1.2 * Math.cos(sx / 40) + gauss() * 1.1, 0.1, 11);
    var sup = (0.5 + rnd() * 2.5);
    samples += (600000 + sx).toFixed(1) + ',' + (7780000 + sy).toFixed(1) + ',' + (800 + sz).toFixed(1) + ',' +
      sfe.toFixed(2) + ',' + ssio2.toFixed(2) + ',' + sal.toFixed(2) + ',' + sup.toFixed(2) + '\n';
  }

  return { model: model, samples: samples };
}

var EXAMPLE_TUTORIAL = [
'# BMA example dataset — tutorial',
'',
'Two synthetic files from the same imaginary iron deposit:',
'',
'- bma-example-model.csv   — a 24 x 24 x 10 block model (10 m blocks):',
'                            X,Y,Z, Fe, SiO2, Al2O3, DENSITY, LITO',
'- bma-example-samples.csv — 420 drillhole composites: EAST,NORTH,ELEV,',
'                            Fe, SiO2, Al2O3, SUPPORT (composite length, m)',
'',
'Fe trends from ~44% in the west to ~57% in the east, with a fold along Y.',
'Two things are planted for you to find: the samples carry a +2% Fe bias',
'relative to the model, and the model (block support) is smoother than the',
'point-support samples. Both are classic validation findings.',
'',
'## 0. The shortcut',
'',
'This zip is itself a packed BMA project: drop the whole bma-example.zip',
'onto BMA and confirm the prompt — both files load with calcols, GT, swath,',
'and the aux comparison already configured. The steps below build the same',
'setup by hand, which is the better way to learn the app. (You can pack',
'your own projects the same way with the Pack button in the toolbar.)',
'',
'## 1. Load the model',
'',
'Drop bma-example-model.csv on the landing page. Preflight detects the',
'delimiter, types, and X/Y/Z automatically — just hit Execute (bottom right).',
'Check Summary: 10 m blocks, 24 x 24 x 10 grid, fill ratio 100%.',
'',
'## 2. Statistics',
'',
'Open Statistics. Click a variable name (e.g. Fe) to add its CDF curve.',
'Try Weight: select DENSITY and re-run Execute — statistics become',
'mass-weighted instead of block-count-weighted (denser = iron-richer blocks',
'count more, so the weighted Fe mean is higher). Toggle the SW metric to',
'see total weight. Set Weight back to none and Execute again.',
'',
'## 3. Calculated columns',
'',
'On the Calc tab, paste:',
'',
'    r.RATIO = r.Fe / r.SiO2;',
'    r.ORE = r.Fe > 55 ? \'ore\' : \'waste\';',
'',
'Click Simulate to preview, then Execute. RATIO appears in Statistics and',
'Swath; ORE shows up in Categories and as a GT group-by candidate.',
'',
'## 4. Grade-tonnage',
'',
'On the GT tab: check Fe, set Density to the DENSITY column (or try',
'Constant 3.4 t/m3), cutoffs 44 to 62 step 1, Group by LITO. Generate.',
'The HEM curve sits high and flat; CGA dies quickly with cutoff.',
'Use Copy SVG / Download PNG to take the chart with you.',
'',
'## 5. Swath plots',
'',
'On the Swath tab: keep axis X, check Fe and SiO2, Generate. Fe climbs',
'eastward while SiO2 mirrors it downward (they are anticorrelated).',
'Try Layout: Split, and a Custom axis at azimuth 45.',
'',
'## 6. The aux dataset — model vs samples',
'',
'Open the Aux tab and drop bma-example-samples.csv. EAST/NORTH/ELEV are',
'detected as coordinates. Set Weight to SUPPORT (length-weighted compositing',
'statistics) and click Analyze.',
'',
'- Statistics now shows aux:Fe as an indented row right under Fe:',
'  the sample mean runs about +2% above the model. That is the planted bias.',
'- Click aux:Fe to overlay its CDF (dashed): the model curve is steeper —',
'  block support smooths away the tails the samples still have.',
'- On Swath, the aux variables appear at the bottom of the list, already',
'  checked. Generate: the dashed sample line rides above the solid model',
'  line in every bin. Same color = same variable, dashed = other dataset.',
'',
'## 7. Aux calculated columns',
'',
'On the Calc tab, switch the toggle to Aux and paste:',
'',
'    aux.RATIO = aux.Fe / aux.SiO2;',
'',
'Simulate, then re-run Analyze on the Aux tab. Because it shares the name',
'RATIO with the model calcol, it pairs up automatically: same row in',
'Statistics, same axis and color (dashed) in Swath.',
'',
'## 8. Where to go from here',
'',
'Everything you configured is autosaved per file — reload the page and drop',
'the same file to pick up where you left off. The aux filter box accepts',
'aux. expressions (e.g. aux.SUPPORT > 1), the global filter accepts r.',
'expressions, and F1 opens contextual help on every tab.',
''
].join('\n');

// A ready-made project for the example: dropping the zip back onto BMA
// offers to load everything pre-configured (calcols, GT, swath, aux).
// Shapes mirror serializeProject() — all references are by column name.
function exampleProjectJson(modelSize, samplesSize) {
  return JSON.stringify({
    _bma: 1,
    file: { name: 'bma-example-model.csv', size: modelSize },
    preflight: {
      typeOverrides: {}, skipCols: [], colFilters: {},
      xyz: { x: 0, y: 1, z: 2 }, dxyz: { dx: -1, dy: -1, dz: -1 },
      selectedZipEntry: null
    },
    calcolCode: "r.RATIO = r.Fe / r.SiO2;\nr.ORE = r.Fe > 55 ? 'ore' : 'waste';",
    calcolMeta: [{ name: 'RATIO', type: 'numeric' }, { name: 'ORE', type: 'categorical' }],
    filter: null,
    filterText: '',
    aux: {
      fileName: 'bma-example-samples.csv', fileSize: samplesSize,
      prefix: 'aux', xyz: { x: 0, y: 1, z: 2 }, filter: '',
      weight: 'SUPPORT',
      calcolCode: 'aux.RATIO = aux.Fe / aux.SiO2;',
      calcolMeta: [{ name: 'RATIO', type: 'numeric' }]
    },
    statsTab: { cdfSelected: [3] },
    gt: {
      gradeCols: ['Fe'], groupByCol: 'LITO', densityCol: 'DENSITY',
      densityConst: null, weightCol: null, localFilter: '',
      cutoffMode: 'range', cutoffMin: 44, cutoffMax: 62, cutoffStep: 1, cutoffCustom: ''
    },
    swath: {
      axis: 'x', binWidth: 10, stat: 'mean_std',
      checkedVars: ['Fe', 'SiO2'], localFilter: '',
      azimuth: null, plunge: null, weight: null,
      auxCheckedVars: ['Fe'], auxUnits: null, units: null, colorOverrides: null,
      display: { showBands: true, showCounts: true, showTable: true, yScale: 'linear', layout: 'overlay' }
    },
    activeTab: 'summary'
  }, null, 2);
}

async function downloadExampleZip() {
  var data = exampleData();
  var enc = new TextEncoder();
  var modelSize = enc.encode(data.model).length;
  var samplesSize = enc.encode(data.samples).length;
  var blob = await buildStoredZip([
    { name: 'bma-example-model.csv', blob: new Blob([data.model]) },
    { name: 'bma-example-samples.csv', blob: new Blob([data.samples]) },
    { name: 'bma-example.bma.json', blob: new Blob([exampleProjectJson(modelSize, samplesSize)]) },
    { name: 'TUTORIAL.txt', blob: new Blob([EXAMPLE_TUTORIAL]) }
  ]);
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'bma-example.zip';
  a.click();
  URL.revokeObjectURL(url);
}

// ── Landing button wiring ──
var $exampleBtn = document.getElementById('exampleDownload');
if ($exampleBtn) $exampleBtn.addEventListener('click', downloadExampleZip);
