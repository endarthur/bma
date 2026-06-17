// ─── Example dataset generator ────────────────────────────────────────
// Landing-page button that builds and downloads bma-example.zip: a synthetic
// block model + the composites "behind" it + TUTORIAL.txt. Everything is
// generated client-side and deterministic (seeded PRNG), so every download
// is byte-identical. Three plantings make the tutorial's punchlines show up:
// a +2 Fe assay bias on the samples, an infill campaign clustered in the
// high-grade east (declustering separates it from the assay bias), and the
// model's Fe trend along X (swaths, block-support smoothing).

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

// Assemble a zip from prepared entries:
//   [{name, crc, method (0|8), data (Blob written to the archive),
//     uncompSize (raw bytes; equals data.size for stored entries)}]
// Data blobs are referenced, never copied. Writes Zip64 records (extended
// info extras + zip64 EOCD + locator) automatically whenever any size,
// offset, or count exceeds the zip32 fields — BMA's whole point is huge
// files, so the container can't be the ceiling. opts.forceZip64 exists so
// tests can exercise the zip64 records without multi-GB fixtures.
function assembleZip(entriesIn, opts) {
  opts = opts || {};
  var enc = new TextEncoder();
  var dosTime = (12 << 11);                              // 12:00:00
  var dosDate = ((2026 - 1980) << 9) | (6 << 5) | 9;     // 2026-06-09
  var MAX32 = 0xFFFFFFFE;

  function record(byteLen, write) {
    var buf = new ArrayBuffer(byteLen);
    var dv = new DataView(buf);
    var u8 = new Uint8Array(buf);
    var pos = 0;
    write({
      u16: function(v) { dv.setUint16(pos, v, true); pos += 2; },
      u32: function(v) { dv.setUint32(pos, v, true); pos += 4; },
      u64: function(v) {
        dv.setUint32(pos, v % 4294967296, true);
        dv.setUint32(pos + 4, Math.floor(v / 4294967296), true);
        pos += 8;
      },
      put: function(bytes) { u8.set(bytes, pos); pos += bytes.length; }
    });
    return buf;
  }

  // Layout pass: offsets depend on whether each local header carries a
  // zip64 extra (sizes overflow only — offsets don't live in local headers)
  var entries = entriesIn.map(function(f) {
    return {
      nameBytes: enc.encode(f.name), data: f.data, crc: f.crc,
      method: f.method || 0, uncompSize: f.uncompSize != null ? f.uncompSize : f.data.size,
      // Bit 11: name is UTF-8 — without it readers decode non-ASCII as CP437
      flags: /[^\x00-\x7F]/.test(f.name) ? 0x0800 : 0
    };
  });
  var offset = 0;
  entries.forEach(function(e) {
    e.sizes64 = opts.forceZip64 || e.uncompSize > MAX32 || e.data.size > MAX32;
    e.offset = offset;
    e.offset64 = opts.forceZip64 || e.offset > MAX32;
    offset += 30 + e.nameBytes.length + (e.sizes64 ? 20 : 0) + e.data.size;
  });
  var cdStart = offset;
  var zip64Mode = opts.forceZip64 || cdStart > MAX32 || entries.length > 0xFFFE ||
    entries.some(function(e) { return e.sizes64 || e.offset64; });

  var parts = [];
  entries.forEach(function(e) {
    var verNeed = e.sizes64 ? 45 : 20;
    parts.push(record(30 + e.nameBytes.length + (e.sizes64 ? 20 : 0), function(w) {
      w.u32(0x04034b50); w.u16(verNeed); w.u16(e.flags); w.u16(e.method); w.u16(dosTime); w.u16(dosDate);
      w.u32(e.crc);
      w.u32(e.sizes64 ? 0xFFFFFFFF : e.data.size);
      w.u32(e.sizes64 ? 0xFFFFFFFF : e.uncompSize);
      w.u16(e.nameBytes.length); w.u16(e.sizes64 ? 20 : 0); w.put(e.nameBytes);
      if (e.sizes64) { w.u16(0x0001); w.u16(16); w.u64(e.uncompSize); w.u64(e.data.size); }
    }));
    parts.push(e.data); // referenced, not copied
  });

  var cdSize = 0;
  entries.forEach(function(e) {
    var extraLen = (e.sizes64 ? 16 : 0) + (e.offset64 ? 8 : 0);
    if (extraLen > 0) extraLen += 4;
    var recLen = 46 + e.nameBytes.length + extraLen;
    parts.push(record(recLen, function(w) {
      w.u32(0x02014b50); w.u16(zip64Mode ? 45 : 20); w.u16(e.sizes64 || e.offset64 ? 45 : 20);
      w.u16(e.flags); w.u16(e.method); w.u16(dosTime); w.u16(dosDate);
      w.u32(e.crc);
      w.u32(e.sizes64 ? 0xFFFFFFFF : e.data.size);
      w.u32(e.sizes64 ? 0xFFFFFFFF : e.uncompSize);
      w.u16(e.nameBytes.length); w.u16(extraLen); w.u16(0); w.u16(0); w.u16(0); w.u32(0);
      w.u32(e.offset64 ? 0xFFFFFFFF : e.offset);
      w.put(e.nameBytes);
      if (extraLen > 0) {
        w.u16(0x0001); w.u16(extraLen - 4);
        if (e.sizes64) { w.u64(e.uncompSize); w.u64(e.data.size); }
        if (e.offset64) w.u64(e.offset);
      }
    }));
    cdSize += recLen;
  });

  if (zip64Mode) {
    var z64EocdOffset = cdStart + cdSize;
    parts.push(record(56, function(w) {
      w.u32(0x06064b50); w.u64(44); w.u16(45); w.u16(45); w.u32(0); w.u32(0);
      w.u64(entries.length); w.u64(entries.length); w.u64(cdSize); w.u64(cdStart);
    }));
    parts.push(record(20, function(w) {
      w.u32(0x07064b50); w.u32(0); w.u64(z64EocdOffset); w.u32(1);
    }));
    parts.push(record(22, function(w) {
      w.u32(0x06054b50); w.u16(0); w.u16(0); w.u16(0xFFFF); w.u16(0xFFFF);
      w.u32(0xFFFFFFFF); w.u32(0xFFFFFFFF); w.u16(0);
    }));
  } else {
    parts.push(record(22, function(w) {
      w.u32(0x06054b50); w.u16(0); w.u16(0); w.u16(entries.length); w.u16(entries.length);
      w.u32(cdSize); w.u32(cdStart); w.u16(0);
    }));
  }
  return new Blob(parts, { type: 'application/zip' });
}

// Convenience for small text payloads (the example download): store-mode
// with the CRC computed inline.
async function buildStoredZip(files, onProgress, precomputedCrcs) {
  var totalBytes = 0;
  for (var fi = 0; fi < files.length; fi++) totalBytes += files[fi].blob.size;
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
    entries.push({ name: f.name, crc: crcFinal, method: 0, data: f.blob, uncompSize: f.blob.size });
  }
  return assembleZip(entries);
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

  // Composites: 420 exploration samples across the volume plus a 140-hole
  // infill campaign clustered in the high-grade east — naive sample stats
  // therefore conflate SAMPLING bias (clustering) with the planted +2 Fe
  // ASSAY bias; cell declustering separates the two. Point support (more
  // noise) and composite lengths complete the picture.
  var samples = 'EAST,NORTH,ELEV,Fe,SiO2,Al2O3,LITO,SUPPORT\n';
  function sampleAt(sx, sy, sz) {
    var sfe = clampv(feAt(sx / 10, sy / 10, sz / 10) + 2.0 + gauss() * 3.2, 25, 70);
    var ssio2 = clampv(38 - 0.45 * sfe + gauss() * 2.4, 0.3, 34);
    var sal = clampv(3.5 + 1.2 * Math.cos(sx / 40) + gauss() * 1.1, 0.1, 11);
    // Same lithology rule as the model, applied to the BIASED Fe — so the
    // logged proportions disagree with the model's (more HEM/ITA), which is
    // exactly what the Categories comparison exists to show. A few samples
    // log a unit the model never used.
    var slito = sfe > 58 ? 'HEM' : (sfe > 48 ? 'ITA' : 'CGA');
    if (rnd() < 0.02) slito = 'CAN';
    var sup = (0.5 + rnd() * 2.5);
    samples += (600000 + sx).toFixed(1) + ',' + (7780000 + sy).toFixed(1) + ',' + (800 + sz).toFixed(1) + ',' +
      sfe.toFixed(2) + ',' + ssio2.toFixed(2) + ',' + sal.toFixed(2) + ',' + slito + ',' + sup.toFixed(2) + '\n';
  }
  for (var si = 0; si < 420; si++) {
    sampleAt(rnd() * 240, rnd() * 240, rnd() * 100);
  }
  // Infill: tight drilling chasing grade in the east (~9% of the area
  // holding 25% of the samples)
  for (var ii = 0; ii < 140; ii++) {
    sampleAt(175 + rnd() * 60, 55 + rnd() * 90, rnd() * 100);
  }

  // Drillhole set (A7): the same deposit as RAW drillhole tables — 20 grid
  // holes + 10 infill holes clustered in the high-grade east (the same
  // clustering story as the samples), 2 m assay intervals carrying the same
  // +2 Fe assay bias at point support. Survey dips are NEGATIVE-down on
  // purpose (the dip-convention toggle's teaching moment); alternating grid
  // holes are inclined westward and steepen ~3°/50 m so the minimum-curvature
  // desurvey has something to do. Generated AFTER the samples so the shared
  // RNG sequence keeps model/samples byte-identical to earlier releases.
  var collar = 'BHID,XCOLLAR,YCOLLAR,ZCOLLAR,EOH\n';
  var survey = 'BHID,AT,AZIMUTH,DIP\n';
  var assays = 'BHID,FROM,TO,Fe,SiO2,Al2O3,LITO\n';
  var holeNo = 0;
  function makeHole(hx, hy, inclined) {
    holeNo++;
    var id = 'DH' + (holeNo < 10 ? '0' : '') + holeNo;
    collar += id + ',' + (600000 + hx).toFixed(1) + ',' + (7780000 + hy).toFixed(1) + ',900.0,100\n';
    var az = inclined ? 270 : 0;
    var dip0 = inclined ? -60 : -90; // negative-down convention
    survey += id + ',0,' + az + ',' + dip0 + '\n';
    survey += id + ',50,' + az + ',' + (inclined ? dip0 - 3 : dip0) + '\n';
    survey += id + ',100,' + az + ',' + (inclined ? dip0 - 6 : dip0) + '\n';
    // integrate the path in 1 m steps with linearly interpolated dip so the
    // assays sample the field where BMA's desurvey will place the composites
    var px = hx, py = hy, pe = 900, dCur = 0;
    var azr = az * Math.PI / 180;
    function stepPath(len) {
      var dip = (inclined ? dip0 - (dCur / 50) * 3 : dip0) * Math.PI / 180;
      px += len * Math.sin(azr) * Math.cos(dip);
      py += len * Math.cos(azr) * Math.cos(dip);
      pe += len * Math.sin(dip);
      dCur += len;
    }
    for (var d = 0; d < 100; d += 2) {
      stepPath(1); // interval midpoint
      var sz = clampv(pe - 800, 0, 100);
      var afe = clampv(feAt(px / 10, py / 10, sz / 10) + 2.0 + gauss() * 3.2, 25, 70);
      var asio2 = clampv(38 - 0.45 * afe + gauss() * 2.4, 0.3, 34);
      var aal = clampv(3.5 + 1.2 * Math.cos(px / 40) + gauss() * 1.1, 0.1, 11);
      var alito = afe > 58 ? 'HEM' : (afe > 48 ? 'ITA' : 'CGA');
      if (rnd() < 0.02) alito = 'CAN';
      assays += id + ',' + d + ',' + (d + 2) + ',' + afe.toFixed(2) + ',' +
        asio2.toFixed(2) + ',' + aal.toFixed(2) + ',' + alito + '\n';
      stepPath(1);
    }
  }
  for (var gi = 0; gi < 5; gi++) {
    for (var gj = 0; gj < 4; gj++) {
      makeHole(24 + gi * 48, 30 + gj * 60, (gi + gj) % 2 === 1);
    }
  }
  for (var fi = 0; fi < 10; fi++) {
    makeHole(175 + rnd() * 60, 55 + rnd() * 90, false);
  }

  return { model: model, samples: samples, collar: collar, survey: survey, assays: assays };
}

var EXAMPLE_TUTORIAL = [
'# BMA example dataset — tutorial',
'',
'Synthetic files from the same imaginary iron deposit:',
'',
'- bma-example-model.csv   — a 24 x 24 x 10 block model (10 m blocks):',
'                            X,Y,Z, Fe, SiO2, Al2O3, DENSITY, LITO',
'- bma-example-samples.csv — 560 drillhole composites: EAST,NORTH,ELEV,',
'                            Fe, SiO2, Al2O3, LITO, SUPPORT (composite length, m)',
'- bma-example-collar.csv / -survey.csv / -assays.csv — the same campaign',
'                            as RAW drillhole tables (30 holes, 2 m assay',
'                            intervals) for the drillhole-ingestion chapter',
'',
'Fe trends from ~44% in the west to ~57% in the east, with a fold along Y.',
'Three things are planted for you to find: the samples carry a +2% Fe',
'assay bias relative to the model; an infill campaign clusters a quarter',
'of the holes in the high-grade east (sampling bias); and the model (block',
'support) is smoother than the point-support samples. All three are',
'classic validation findings.',
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
'Drop bma-example-model.csv on the landing page. Import Model detects the',
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
'On the Swath tab: keep direction X checked, check Fe and SiO2, Generate.',
'Fe climbs eastward while SiO2 mirrors it downward (anticorrelated).',
'Check Y and Z too and Generate again: each direction gets its own tab',
'above the chart. Try Layout: Split, or Custom (rotated U/V/W) with',
'dip direction 45 to swath along a rotated frame.',
'',
'## 6. The aux dataset — model vs samples',
'',
'Open the Aux tab and drop bma-example-samples.csv. EAST/NORTH/ELEV are',
'detected as coordinates. Set Weight to SUPPORT (length-weighted compositing',
'statistics) and click Analyze.',
'',
'- Statistics now shows aux:Fe as an indented row right under Fe, with a',
'  Δ% row reading the difference per metric. The sample mean runs well',
'  above the model — MORE than the planted +2 bias, because the clustered',
'  infill drags the naive mean up too. Section 7 untangles the two.',
'- Click aux:Fe to overlay its CDF (dashed): the model curve is steeper —',
'  block support smooths away the tails the samples still have.',
'- On Swath, the aux variables appear at the bottom of the list, already',
'  checked. Generate: the dashed sample line rides above the solid model',
'  line in every bin. Same color = same variable, dashed = other dataset.',
'- In Statistics, switch the CDF panel to Q-Q mode with Fe and aux:Fe',
'  selected: the points sit parallel to-but-above the identity line.',
'  That offset IS the bias, read quantile by quantile.',
'- Try the Prob mode too: the same curves on normal probability paper',
'  (0.2-99.8%). With log X this is the classic log-probability plot -',
'  straight means lognormal, breaks mean mixed populations.',
'- On Categories, focus LITO: open diamonds mark the logged shares over',
'  the modelled bars (the samples log more HEM/ITA — biased Fe, same',
'  classification rule), and a rare unit appears as "aux only".',
'',
'## 7. Declustering — sampling bias vs assay bias',
'',
'The infill holes oversample the high-grade east, so the naive sample mean',
'is not comparable to the model mean: part of the gap is clustering, not',
'assay bias. In the Declustering section of the Aux tab, keep Var = Fe and',
'click Run declustering. The curve shows the declustered mean for every',
'cell size — hover to inspect, click a point to pin a size by hand (the',
'sweep optimum is marked). With ~10 m sample spacing in the infill zone,',
'sizes around 20-60 m do the real work.',
'',
'Click "Use as aux weight" and re-run Analyze. The Δ% row under Fe drops',
'to roughly the planted +2 assay bias — the clustering component is gone.',
'That separation (declustered comparison isolates assay bias from drilling',
'pattern) is exactly why validation tables decluster composites first.',
'(BMA applies one weight at a time: switching to declustered weights',
'replaces the SUPPORT length-weighting from section 6.)',
'',
'## 8. Top cuts',
'',
'Switch the Aux tab main area from Preview to Top-cut, keep Variable = Fe',
'and click Load distribution. Four linked plots share one draggable cap',
'line: histogram, log-probability, mean & CV vs cap, and metal removed.',
'The convention is to read the break near the top of the log-probability',
'curve against the metal a cap would remove - BMA never picks for you.',
'Copy calcol hands you a capping line (cap() is built in) for the Calc',
'tab, and the capped variable then flows into every comparison.',
'',
'## 9. Theoretical grade-tonnage',
'',
'Back on the GT tab (Fe checked, declustered weights still applied on the',
'Aux tab): tick "Overlay theoretical GT" in the Theoretical (samples)',
'section. The dashed pair is the GT curve the samples predict at block',
'support, scaled to the model total. Drag f - the variance reduction',
'factor Var(blocks)/Var(samples) - and watch whether the model curves',
'meet the theoretical pair at any plausible f. At f=1 the overlay is the',
'sample GT itself; f is yours to bring, never derived from the model.',
'',
'## 10. Aux calculated columns',
'',
'On the Calc tab, switch the toggle to Aux and paste:',
'',
'    aux.RATIO = aux.Fe / aux.SiO2;',
'',
'Simulate, then re-run Analyze on the Aux tab. Because it shares the name',
'RATIO with the model calcol, it pairs up automatically: same row in',
'Statistics, same axis and color (dashed) in Swath. The same trick cleans',
'data before a top cut: aux.FE_CLEAN = aux.Fe < 0 ? null : aux.Fe;',
'',
'## 11. Drillholes — from raw tables to composites',
'',
'Sections 6-10 used a pre-composited samples file. Real campaigns start',
'rawer: a collar table, a survey table, an assay-interval table. BMA',
'composites those itself. Remove the current aux dataset (X Remove on the',
'Aux tab), then drop bma-example-collar.csv, bma-example-survey.csv and',
'bma-example-assays.csv together onto the "Drillhole set" card.',
'',
'Each file lands in its role (detected from the headers) and the column',
'mapping appears, already filled in. Note the highlighted Dip convention',
'row: this survey file uses NEGATIVE-down dips (-90 = vertical), BMA',
'detected that from the data, and the toggle is there to override it -',
'always check it against how your surveys were exported. Leave composite',
'length at the detected 2 m and click Composite & load.',
'',
'The consistency report lists everything that did not join cleanly, then',
'the composites load as the aux dataset: desurveyed XYZ (ten of the holes',
'are inclined and curve gently - minimum curvature handles that), one row',
'per 2 m composite, and a SUPPORT column already set as the aux weight.',
'From here everything in sections 6-10 works the same: Analyze, and the',
'dh:Fe rows show the familiar +2 bias story. Pack (toolbar) now carries',
'the three RAW files plus your recipe - the composites are re-derived,',
'never stored.',
'',
'## 12. Where to go from here',
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
      calcolMeta: [{ name: 'RATIO', type: 'numeric' }],
      declus: { params: { varName: 'Fe', cellMin: null, cellMax: null, ncell: 24, noff: 8, anisy: 1, anisz: 1, criterion: 'min', pinned: null } }
    },
    statsTab: { cdfSelected: [3] },
    gt: {
      gradeCols: ['Fe'], groupByCol: 'LITO', densityCol: 'DENSITY',
      densityConst: null, weightCol: null, localFilter: '',
      cutoffMode: 'range', cutoffMin: 44, cutoffMax: 62, cutoffStep: 1, cutoffCustom: ''
    },
    swath: {
      dirMode: 'ortho',
      directions: { x: { on: true, bin: 10 }, y: { on: false, bin: 10 }, z: { on: false, bin: 5 } },
      dipDir: 0, dip: 0, rake: 90,
      stat: 'mean_std',
      checkedVars: ['Fe', 'SiO2'], localFilter: '', weight: null,
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
    { name: 'bma-example-collar.csv', blob: new Blob([data.collar]) },
    { name: 'bma-example-survey.csv', blob: new Blob([data.survey]) },
    { name: 'bma-example-assays.csv', blob: new Blob([data.assays]) },
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
