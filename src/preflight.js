// ─── Preflight: main-thread helpers ────────────────────────────────────

const DELIMITERS_MAIN = [',', '\t', ';', '|', ' '];
const NULL_SENTINELS_MAIN = new Set(['', 'NA', 'NaN', 'na', 'nan', 'N/A', 'n/a', 'null', 'NULL', '*', '-', '-999', '-99', '#N/A', 'VOID', 'void', '-1.0e+32', '-1e+32', '1e+31', '-9999', '-99999']);

function detectDelimiterMain(lines) {
  let best = ',', bestScore = -1;
  for (const d of DELIMITERS_MAIN) {
    const counts = lines.map(l => l.split(d).length);
    if (counts[0] < 2) continue;
    const allSame = counts.every(c => c === counts[0]);
    const score = allSame ? counts[0] * 1000 + counts.length : counts[0];
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

function autoDetectTypes(header, rows) {
  const types = [];
  for (let col = 0; col < header.length; col++) {
    let num = 0, nonNum = 0;
    for (const row of rows) {
      if (col >= row.length) continue;
      const v = row[col].trim();
      if (NULL_SENTINELS_MAIN.has(v)) continue;
      if (!isNaN(Number(v))) num++;
      else nonNum++;
    }
    const total = num + nonNum;
    if (total === 0) types.push('numeric');
    else if (nonNum === 0) types.push('numeric');
    else if (num === 0) types.push('categorical');
    else types.push((num / total > 0.8) ? 'numeric' : 'categorical');
  }
  return types;
}

function readUint16(buf, off) { return buf[off] | (buf[off+1] << 8); }
function readUint32(buf, off) { return (buf[off] | (buf[off+1] << 8) | (buf[off+2] << 16) | (buf[off+3] << 24)) >>> 0; }

function readUint64Main(buf, off) { return readUint32(buf, off) + readUint32(buf, off + 4) * 4294967296; }

// Zip64 extra field (tag 0x0001): 8-byte values present only for fields at
// the 32-bit sentinel, in the order uncompSize, compSize, localOffset
function zip64ResolveMain(cd, pos, nameLen, extraLen, sizes) {
  if (sizes.compSize !== 0xFFFFFFFF && sizes.uncompSize !== 0xFFFFFFFF && sizes.localOffset !== 0xFFFFFFFF) return sizes;
  let ep = pos + 46 + nameLen;
  const eEnd = ep + extraLen;
  while (ep + 4 <= eEnd) {
    const tag = readUint16(cd, ep);
    const tsize = readUint16(cd, ep + 2);
    if (tag === 0x0001) {
      let fp = ep + 4;
      if (sizes.uncompSize === 0xFFFFFFFF) { sizes.uncompSize = readUint64Main(cd, fp); fp += 8; }
      if (sizes.compSize === 0xFFFFFFFF) { sizes.compSize = readUint64Main(cd, fp); fp += 8; }
      if (sizes.localOffset === 0xFFFFFFFF) { sizes.localOffset = readUint64Main(cd, fp); fp += 8; }
      break;
    }
    ep += 4 + tsize;
  }
  return sizes;
}

async function listZipEntries(file) {
  const tailSize = Math.min(65557, file.size);
  const tail = new Uint8Array(await file.slice(file.size - tailSize).arrayBuffer());
  let eocdPos = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (readUint32(tail, i) === 0x06054b50) { eocdPos = i; break; }
  }
  if (eocdPos < 0) throw new Error('Not a valid ZIP file');
  let cdEntries = readUint16(tail, eocdPos + 8);
  let cdSize = readUint32(tail, eocdPos + 12);
  let cdOffset = readUint32(tail, eocdPos + 16);

  // Zip64: sentinel values point to the zip64 EOCD record via the locator
  if (cdEntries === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) {
    let locPos = -1;
    for (let i = eocdPos - 20; i >= 0; i--) {
      if (readUint32(tail, i) === 0x07064b50) { locPos = i; break; }
    }
    if (locPos < 0) throw new Error('Zip64 archive missing EOCD locator');
    const z64Offset = readUint64Main(tail, locPos + 8);
    const z64 = new Uint8Array(await file.slice(z64Offset, z64Offset + 56).arrayBuffer());
    if (readUint32(z64, 0) !== 0x06064b50) throw new Error('Invalid zip64 EOCD record');
    cdEntries = readUint64Main(z64, 32);
    cdSize = readUint64Main(z64, 40);
    cdOffset = readUint64Main(z64, 48);
  }

  const cd = new Uint8Array(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const entries = [];
  let pos = 0;
  for (let i = 0; i < cdEntries && pos < cd.length; i++) {
    if (readUint32(cd, pos) !== 0x02014b50) break;
    const method = readUint16(cd, pos + 10);
    const nameLen = readUint16(cd, pos + 28);
    const extraLen = readUint16(cd, pos + 30);
    const commentLen = readUint16(cd, pos + 32);
    const sizes = zip64ResolveMain(cd, pos, nameLen, extraLen, {
      compSize: readUint32(cd, pos + 20),
      uncompSize: readUint32(cd, pos + 24),
      localOffset: readUint32(cd, pos + 42)
    });
    const name = new TextDecoder().decode(cd.slice(pos + 46, pos + 46 + nameLen));
    if (!name.endsWith('/') && !name.startsWith('__MACOSX') && !name.startsWith('.')) {
      entries.push({ name, method, compSize: sizes.compSize, uncompSize: sizes.uncompSize, localOffset: sizes.localOffset });
    }
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function zipEntryCompSlice(file, entry) {
  const lh = new Uint8Array(await file.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
  const lhNameLen = readUint16(lh, 26);
  const lhExtraLen = readUint16(lh, 28);
  const dataStart = entry.localOffset + 30 + lhNameLen + lhExtraLen;
  return file.slice(dataStart, dataStart + entry.compSize);
}

async function readPreviewFromZipEntry(file, entry, maxLines) {
  const compSlice = await zipEntryCompSlice(file, entry);
  let stream;
  if (entry.method === 0) stream = compSlice.stream();
  else if (entry.method === 8) stream = compSlice.stream().pipeThrough(new DecompressionStream('deflate-raw'));
  else throw new Error('Unsupported compression method');
  return readLinesFromStream(stream, maxLines);
}

// Full text of a (small) zip entry — used for packed .bma.json projects
async function readZipEntryText(file, entry) {
  const compSlice = await zipEntryCompSlice(file, entry);
  if (entry.method === 0) return compSlice.text();
  if (entry.method === 8) return new Response(compSlice.stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
  throw new Error('Unsupported compression method');
}

// Materialize a zip entry as a standalone File. Stored entries are zero-copy
// (a lazy slice view into the archive), so even multi-GB packed models cost
// nothing to "extract"; deflated entries are decompressed into memory.
async function zipEntryToFile(file, entry) {
  const compSlice = await zipEntryCompSlice(file, entry);
  if (entry.method === 0) return new File([compSlice], entry.name);
  if (entry.method === 8) {
    const blob = await new Response(compSlice.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
    return new File([blob], entry.name);
  }
  throw new Error('Unsupported compression method');
}

async function readLinesFromStream(stream, maxLines, captureComments) {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '', lines = [], commentLines = [], headerReached = false;
  while (lines.length < maxLines + 1) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += value;
    const parts = buf.split('\n');
    buf = parts.pop();
    for (const p of parts) {
      const trimmed = p.replace(/\r$/, '');
      if (trimmed.startsWith('#')) {
        if (captureComments && !headerReached) commentLines.push(trimmed.replace(/^#\s?/, ''));
        continue;
      }
      headerReached = true;
      lines.push(trimmed);
      if (lines.length >= maxLines + 1) break;
    }
  }
  if (buf && lines.length < maxLines + 1) {
    const trimmed = buf.replace(/\r$/, '');
    if (trimmed.startsWith('#')) {
      if (captureComments && !headerReached) commentLines.push(trimmed.replace(/^#\s?/, ''));
    } else {
      lines.push(trimmed);
    }
  }
  reader.cancel();
  if (captureComments) return { lines, commentLines };
  return lines;
}

const CSV_EXTENSIONS_MAIN = /\.(csv|txt|dat|tsv)$/i;

// Columns that should NOT get default >0 filtering
const NOFILT_RE = /^(id|index|row|block.?id|parent|d[xyz]|dim[xyz]?|size[xyz]?|n[xyz]|i[xyz]|ij[k]?|count|flag|code|mask|domain|[xyz]inc|[xyz]dis|[xyz]len|[xyz]size|d[_-]?[xyz]|[xyz][_-]?dim|[xyz][_-]?size|size[_-]?[xyz])$/i;

function buildDefaultColFilters(header, autoTypes, xyz) {
  const xyzSet = new Set([xyz.x, xyz.y, xyz.z].filter(v => v >= 0));
  const filters = {};
  for (let i = 0; i < header.length; i++) {
    if (autoTypes[i] !== 'numeric') continue;
    if (xyzSet.has(i)) continue;
    if (NOFILT_RE.test(header[i])) continue;
    filters[i] = { skipZeros: true, skipNeg: true };
  }
  return filters;
}

function isFilterableCol(header, i, autoTypes, typeOverrides, xyz, skipCols) {
  const t = typeOverrides[i] || autoTypes[i];
  if (t !== 'numeric') return false;
  if (skipCols.has(i)) return false;
  const xyzSet = new Set([xyz.x, xyz.y, xyz.z].filter(v => v >= 0));
  if (xyzSet.has(i)) return false;
  if (NOFILT_RE.test(header[i])) return false;
  return true;
}

const XYZ_PATTERNS_MAIN = {
  x: [/^x$/i, /^xc$/i, /^x[_-]?cent/i, /^mid[_-]?x$/i, /^centroid[_-]?x$/i, /^east/i, /^x[_-]?coord$/i],
  y: [/^y$/i, /^yc$/i, /^y[_-]?cent/i, /^mid[_-]?y$/i, /^centroid[_-]?y$/i, /^north/i, /^y[_-]?coord$/i],
  z: [/^z$/i, /^zc$/i, /^z[_-]?cent/i, /^mid[_-]?z$/i, /^centroid[_-]?z$/i, /^elev/i, /^rl$/i, /^z[_-]?coord$/i, /^level$/i, /^bench$/i]
};

function guessXYZMain(header, types) {
  const result = { x: -1, y: -1, z: -1 };
  for (const axis of ['x', 'y', 'z']) {
    for (const pat of XYZ_PATTERNS_MAIN[axis]) {
      const idx = header.findIndex((h, i) => types[i] === 'numeric' && pat.test(h.trim()));
      if (idx >= 0) { result[axis] = idx; break; }
    }
  }
  if (result.x < 0 || result.y < 0 || result.z < 0) {
    const numCols = header.map((_, i) => i).filter(i => types[i] === 'numeric');
    if (numCols.length >= 3 && result.x < 0 && result.y < 0 && result.z < 0) {
      result.x = numCols[0]; result.y = numCols[1]; result.z = numCols[2];
    }
  }
  return result;
}

const DXYZ_PATTERNS_MAIN = {
  dx: [/^dx$/i, /^xinc$/i, /^xdis$/i, /^xsize$/i, /^dimx$/i, /^xlen$/i, /^x[_-]?dim$/i, /^x[_-]?size$/i, /^d[_-]?x$/i, /^size[_-]?x$/i],
  dy: [/^dy$/i, /^yinc$/i, /^ydis$/i, /^ysize$/i, /^dimy$/i, /^ylen$/i, /^y[_-]?dim$/i, /^y[_-]?size$/i, /^d[_-]?y$/i, /^size[_-]?y$/i],
  dz: [/^dz$/i, /^zinc$/i, /^zdis$/i, /^zsize$/i, /^dimz$/i, /^zlen$/i, /^z[_-]?dim$/i, /^z[_-]?size$/i, /^d[_-]?z$/i, /^size[_-]?z$/i]
};

function guessDXYZMain(header, types) {
  const result = { dx: -1, dy: -1, dz: -1 };
  for (const axis of ['dx', 'dy', 'dz']) {
    for (const pat of DXYZ_PATTERNS_MAIN[axis]) {
      const idx = header.findIndex((h, i) => types[i] === 'numeric' && pat.test(h.trim()));
      if (idx >= 0) { result[axis] = idx; break; }
    }
  }
  return result;
}

// ─── Datamine .dm binary support ──────────────────────────────────────

function dmReadText(dv, offset, nWords, format) {
  var result = '';
  var step = format === 'ep' ? 8 : 4;
  for (var w = 0; w < nWords; w++) {
    var base = offset + w * step;
    for (var b = 0; b < 4; b++) {
      var ch = dv.getUint8(base + b);
      if (ch >= 32 && ch < 127) result += String.fromCharCode(ch);
    }
  }
  return result.trim();
}

function parseDmDD(dv, endianness, format) {
  var isLE = endianness === 'little';
  var ws = format === 'ep' ? 8 : 4; // word size
  var pageSize = format === 'ep' ? 4096 : 2048;
  var readNum = format === 'ep'
    ? function(off) { return dv.getFloat64(off, isLE); }
    : function(off) { return dv.getFloat32(off, isLE); };

  // DD header fields
  var fileName = dmReadText(dv, 0, 2, format);
  // Skip database name (words 3-4)
  var descOff = format === 'ep' ? 32 : 16;
  var description = dmReadText(dv, descOff, 20, format);
  var dateOff = format === 'ep' ? 192 : 96;
  var dateVal = Math.round(readNum(dateOff));
  var totalFields = Math.round(readNum(dateOff + ws));
  var lastPage = Math.round(readNum(dateOff + ws * 2));
  var lastRecordInLastPage = Math.round(readNum(dateOff + ws * 3));

  // Field definitions start after the header (word 29 for SP = byte 112, word 29 for EP = byte 224)
  var fieldStart = dateOff + ws * 4;
  var fieldSize = ws * 7; // 7 words per field definition
  var rawFields = [];
  for (var f = 0; f < totalFields; f++) {
    var fOff = fieldStart + f * fieldSize;
    if (fOff + fieldSize > pageSize) break;
    var name = dmReadText(dv, fOff, 2, format);
    var typeStr = dmReadText(dv, fOff + ws * 2, 1, format);
    var sw = Math.round(readNum(fOff + ws * 3));
    var lenf = Math.round(readNum(fOff + ws * 4));
    // word 6 unused
    var defaultValue = readNum(fOff + ws * 6);
    rawFields.push({ name: name, type: typeStr.charAt(0).toUpperCase(), sw: sw, lenf: lenf, defaultValue: defaultValue });
  }

  // Reconstruct columns: group rawFields by name
  var colMap = {};
  var colOrder = [];
  for (var i = 0; i < rawFields.length; i++) {
    var rf = rawFields[i];
    if (!colMap[rf.name]) {
      colMap[rf.name] = { name: rf.name, rawType: rf.type, entries: [], defaultValue: rf.defaultValue };
      colOrder.push(rf.name);
    }
    colMap[rf.name].entries.push(rf);
  }

  var columns = [];
  var maxLen = 0;
  for (var ci = 0; ci < colOrder.length; ci++) {
    var cm = colMap[colOrder[ci]];
    var isConstant = cm.entries[0].sw === 0;
    var colType = cm.rawType === 'A' ? 'categorical' : 'numeric';
    // Collect SW positions ordered by LENF
    var sorted = cm.entries.slice().sort(function(a, b) { return a.lenf - b.lenf; });
    var swPositions = sorted.map(function(e) { return e.sw; });
    // Track max SW for record length
    for (var si = 0; si < swPositions.length; si++) {
      if (swPositions[si] > maxLen) maxLen = swPositions[si];
    }
    // Default value for constants: convert numeric default to string for alpha
    var constantValue = null;
    if (isConstant) {
      if (colType === 'numeric') {
        constantValue = (Math.abs(cm.defaultValue) > 9.9e29) ? '' : String(cm.defaultValue);
      } else {
        // Alpha constant — decode default as text from the raw float bytes
        constantValue = '';
        for (var ei = 0; ei < sorted.length; ei++) {
          var defBytes = sorted[ei].defaultValue;
          // For alpha constants, the default is stored as a float whose bytes represent ASCII
          var tmpBuf = new ArrayBuffer(format === 'ep' ? 8 : 4);
          var tmpDv = new DataView(tmpBuf);
          if (format === 'ep') tmpDv.setFloat64(0, defBytes, isLE);
          else tmpDv.setFloat32(0, defBytes, isLE);
          for (var bi = 0; bi < 4; bi++) {
            var cb = tmpDv.getUint8(bi);
            if (cb >= 32 && cb < 127) constantValue += String.fromCharCode(cb);
          }
        }
        constantValue = constantValue.trim();
      }
    }
    columns.push({
      name: cm.name,
      type: colType,
      swPositions: swPositions,
      defaultValue: cm.defaultValue,
      isConstant: isConstant,
      constantValue: constantValue
    });
  }

  var recordsPerPage = maxLen > 0 ? Math.floor(508 / maxLen) : 0;

  return {
    fileName: fileName,
    description: description,
    date: dateVal,
    totalFields: totalFields,
    lastPage: lastPage,
    lastRecordInLastPage: lastRecordInLastPage,
    rawFields: rawFields,
    columns: columns,
    maxLen: maxLen,
    recordsPerPage: recordsPerPage,
    pageSize: pageSize,
    wordSize: ws
  };
}

async function detectDmFormat(file) {
  var size = Math.min(4096, file.size);
  var buf = await file.slice(0, size).arrayBuffer();
  var dv = new DataView(buf);

  function isPrintableAscii(dv, off, len) {
    for (var i = 0; i < len; i++) {
      if (off + i >= dv.byteLength) return false;
      var ch = dv.getUint8(off + i);
      if (ch < 32 || ch >= 127) return false;
    }
    return true;
  }

  function tryFormat(fmt, endian) {
    var ws = fmt === 'ep' ? 8 : 4;
    var isLE = endian === 'little';
    // Field count offset: SP=96+ws=100, EP=192+ws=200
    var dateOff = fmt === 'ep' ? 192 : 96;
    var fcOff = dateOff + ws;
    if (fcOff + ws > dv.byteLength) return false;
    var fc;
    if (fmt === 'ep') fc = dv.getFloat64(fcOff, isLE);
    else fc = dv.getFloat32(fcOff, isLE);
    var rounded = Math.round(fc);
    if (rounded < 1 || rounded > 500 || Math.abs(fc - rounded) > 0.01) return false;
    // Check first field name is printable ASCII
    var fieldStart = dateOff + ws * 4;
    if (fieldStart + 4 > dv.byteLength) return false;
    if (!isPrintableAscii(dv, fieldStart, 4)) return false;
    return true;
  }

  // Try in order: SP+LE, SP+BE, EP+LE, EP+BE
  var combos = [
    { format: 'sp', endianness: 'little' },
    { format: 'sp', endianness: 'big' },
    { format: 'ep', endianness: 'little' },
    { format: 'ep', endianness: 'big' }
  ];
  for (var i = 0; i < combos.length; i++) {
    if (tryFormat(combos[i].format, combos[i].endianness)) return combos[i];
  }
  return null;
}

async function readDmSampleRows(file, dmInfo, maxRows, endianness) {
  var pageSize = dmInfo.pageSize;
  var ws = dmInfo.wordSize;
  var maxLen = dmInfo.maxLen;
  var recsPerPage = dmInfo.recordsPerPage;
  var columns = dmInfo.columns;
  var isLE = endianness === 'little';
  var format = ws === 8 ? 'ep' : 'sp';

  // Read page 2 (first data page)
  if (file.size < pageSize * 2) return [];
  var dataBuf = await file.slice(pageSize, pageSize * 2).arrayBuffer();
  var dv = new DataView(dataBuf);

  var totalRecords = dmInfo.lastPage > 1
    ? (dmInfo.lastPage - 2) * recsPerPage + dmInfo.lastRecordInLastPage
    : dmInfo.lastRecordInLastPage;
  var recsThisPage = Math.min(recsPerPage, totalRecords, maxRows);

  var readNum = format === 'ep'
    ? function(off) { return dv.getFloat64(off, isLE); }
    : function(off) { return dv.getFloat32(off, isLE); };

  var rows = [];
  for (var ri = 0; ri < recsThisPage; ri++) {
    var recStart = ri * maxLen * ws;
    var row = [];
    for (var ci = 0; ci < columns.length; ci++) {
      var col = columns[ci];
      if (col.isConstant) {
        row.push(col.constantValue || '');
        continue;
      }
      if (col.type === 'numeric') {
        var off = recStart + (col.swPositions[0] - 1) * ws;
        if (off + ws > dataBuf.byteLength) { row.push(''); continue; }
        var v = readNum(off);
        if (Math.abs(v) > 9.9e29) row.push('');
        else row.push(String(v));
      } else {
        // Alpha — read 4 bytes per SW position
        var text = '';
        for (var si = 0; si < col.swPositions.length; si++) {
          var aOff = recStart + (col.swPositions[si] - 1) * ws;
          if (aOff + 4 > dataBuf.byteLength) continue;
          for (var b = 0; b < 4; b++) {
            var ch = dv.getUint8(aOff + b);
            if (ch >= 32 && ch < 127) text += String.fromCharCode(ch);
          }
        }
        row.push(text.trim());
      }
    }
    rows.push(row);
  }
  return rows;
}

async function runPreflight(file) {
  const isZip = file.name.toLowerCase().endsWith('.zip') || file.type === 'application/zip';
  const isDm = file.name.toLowerCase().endsWith('.dm');
  let zipEntries = null;
  let lines;

  let commentLines = [];
  if (isDm) {
    const dmDetected = await detectDmFormat(file);
    if (!dmDetected) throw new Error('Unable to detect DM format. File may not be a valid Datamine binary.');
    const pageSize = dmDetected.format === 'ep' ? 4096 : 2048;
    const buf = await file.slice(0, pageSize).arrayBuffer();
    const dv = new DataView(buf);
    const dmInfo = parseDmDD(dv, dmDetected.endianness, dmDetected.format);
    const header = dmInfo.columns.map(c => c.name);
    const autoTypes = dmInfo.columns.map(c => c.type);
    const sampleRows = await readDmSampleRows(file, dmInfo, 100, dmDetected.endianness);
    const xyzGuess = guessXYZMain(header, autoTypes);
    const dxyzGuess = guessDXYZMain(header, autoTypes);
    const defaultFilters = buildDefaultColFilters(header, autoTypes, xyzGuess);
    return {
      header,
      sampleRows,
      autoTypes,
      delimiter: ',',
      zipEntries: null,
      selectedZipEntry: null,
      typeOverrides: {},
      xyz: { ...xyzGuess },
      dxyz: { ...dxyzGuess },
      skipCols: new Set(),
      colFilters: defaultFilters,
      commentLines: [],
      isDm: true,
      dmFormat: dmDetected.format,
      dmEndianness: dmDetected.endianness,
      dmInfo: dmInfo
    };
  } else if (isZip) {
    zipEntries = await listZipEntries(file);
    const csvEntries = zipEntries.filter(e => CSV_EXTENSIONS_MAIN.test(e.name));
    if (csvEntries.length === 0) throw new Error('No CSV/TXT/DAT files found in ZIP. Contents: ' + zipEntries.map(e => e.name).join(', '));
    // Preview the first CSV entry
    lines = await readPreviewFromZipEntry(file, csvEntries[0], 100);
  } else {
    // Read first ~64KB for preview, capture leading comment lines
    const result = await readLinesFromStream(file.slice(0, 256 * 1024).stream(), 100, true);
    lines = result.lines;
    commentLines = result.commentLines;
  }

  if (lines.length < 2) throw new Error('File appears empty or has no data rows.');

  const delimiter = detectDelimiterMain(lines.slice(0, 20));
  const header = lines[0].split(delimiter).map(h => h.trim().replace(/^["']|["']$/g, ''));
  const sampleRows = lines.slice(1)
    .filter(l => l.trim())
    .map(l => l.split(delimiter).map(f => f.trim().replace(/^["']|["']$/g, '')));
  const autoTypes = autoDetectTypes(header, sampleRows);
  const xyzGuess = guessXYZMain(header, autoTypes);
  const dxyzGuess = guessDXYZMain(header, autoTypes);

  // Determine which numeric columns should default to >0 filtering
  const defaultFilters = buildDefaultColFilters(header, autoTypes, xyzGuess);

  return {
    header,
    sampleRows,
    autoTypes,
    delimiter,
    zipEntries: zipEntries ? zipEntries.filter(e => CSV_EXTENSIONS_MAIN.test(e.name)) : null,
    selectedZipEntry: zipEntries ? zipEntries.filter(e => CSV_EXTENSIONS_MAIN.test(e.name))[0]?.name : null,
    typeOverrides: {},
    xyz: { ...xyzGuess },
    dxyz: { ...dxyzGuess },
    skipCols: new Set(),
    colFilters: defaultFilters,
    commentLines
  };
}

// Re-point a zip preflight at a different entry: recompute header, sample,
// types, and defaults from that entry (no rendering — callers render)
async function loadZipEntryIntoPreflight(file, data, entryName) {
  const entry = data.zipEntries.find(z => z.name === entryName);
  if (!entry) return;
  data.selectedZipEntry = entryName;
  const lines = await readPreviewFromZipEntry(file, entry, 100);
  const delimiter = detectDelimiterMain(lines.slice(0, 20));
  data.header = lines[0].split(delimiter).map(h => h.trim().replace(/^["']|["']$/g, ''));
  data.sampleRows = lines.slice(1).filter(l => l.trim())
    .map(l => l.split(delimiter).map(f => f.trim().replace(/^["']|["']$/g, '')));
  data.delimiter = delimiter;
  data.autoTypes = autoDetectTypes(data.header, data.sampleRows);
  data.typeOverrides = {};
  data.skipCols = new Set();
  data.xyz = guessXYZMain(data.header, data.autoTypes);
  data.colFilters = buildDefaultColFilters(data.header, data.autoTypes, data.xyz);
}

function renderPreflight(data) {
  preflightData = data;
  if (!data.colFilters) data.colFilters = {};

  // ZIP file selector
  if (data.zipEntries && data.zipEntries.length > 1) {
    const opts = data.zipEntries.map(e =>
      `<option value="${esc(e.name)}" ${e.name === data.selectedZipEntry ? 'selected' : ''}>${esc(e.name)}</option>`
    ).join('');
    $preflightZip.innerHTML = `ZIP: <select id="zipSelect">${opts}</select>` +
      `<span class="zip-size">${data.zipEntries.length} files</span>`;
    document.getElementById('zipSelect').addEventListener('change', async (e) => {
      const name = e.target.value;
      try {
        await loadZipEntryIntoPreflight(currentFile, data, name);
        renderPreflightSidebar(data);
        renderPreflightTable(data);
      } catch(err) {
        $preflightPreview.innerHTML = `<div style="padding:1rem;color:var(--red)">${esc(err.message)}</div>`;
      }
    });
  } else if (data.zipEntries && data.zipEntries.length === 1) {
    $preflightZip.innerHTML = `ZIP: <strong style="color:var(--fg-bright)">${esc(data.zipEntries[0].name)}</strong>` +
      `<span class="zip-size">${formatSize(data.zipEntries[0].uncompSize)}</span>`;
  } else if (data.isDm && data.dmInfo) {
    const totalRecs = data.dmInfo.lastPage > 1
      ? (data.dmInfo.lastPage - 2) * data.dmInfo.recordsPerPage + data.dmInfo.lastRecordInLastPage
      : data.dmInfo.lastRecordInLastPage;
    const fmtLabel = data.dmFormat === 'ep' ? 'EP (REAL*8)' : 'SP (REAL*4)';
    const endLabel = data.dmEndianness === 'big' ? 'Big-Endian' : 'Little-Endian';
    $preflightZip.innerHTML = 'DM: <strong style="color:var(--fg-bright)">' + esc(data.dmInfo.fileName || currentFile.name) + '</strong>' +
      '<span class="zip-size">' + fmtLabel + ', ' + endLabel + ' \u2014 ' + data.dmInfo.columns.length + ' fields, ' + totalRecs + ' records</span>';
  } else {
    $preflightZip.innerHTML = '';
  }
  $preflightHead.style.display = $preflightZip.innerHTML ? '' : 'none';

  renderPreflightSidebar(data);
  renderPreflightTable(data);
}

const $preflightSidebar = document.getElementById('preflightSidebar');

function renderPreflightSidebar(data) {
  const { header, autoTypes, typeOverrides, skipCols, colFilters } = data;
  const enabledCount = header.length - skipCols.size;

  let html = `<div class="pf-sidebar-section">
    <div class="pf-sidebar-section-title">Coordinate Axes</div>
    <div id="pfXyzWrap"></div>
  </div>`;

  html += `<div class="pf-sidebar-section">
    <div class="pf-sidebar-section-title">Block Dimensions</div>
    <div id="pfDxyzWrap"></div>
  </div>`;

  // DM format options (only shown for .dm files)
  if (data.isDm) {
    html += `<div class="pf-sidebar-section" id="pfDmOptions">
      <div class="pf-sidebar-section-title">DM Format</div>
      <div style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.3rem">
        <span style="font-size:0.8rem;color:var(--fg-dim)">Byte order</span>
        <select class="pf-select" id="pfEndianness">
          <option value="little"${data.dmEndianness === 'little' ? ' selected' : ''}>Little-Endian</option>
          <option value="big"${data.dmEndianness === 'big' ? ' selected' : ''}>Big-Endian</option>
        </select>
      </div>
      <div style="display:flex;gap:0.5rem;align-items:center">
        <span style="font-size:0.8rem;color:var(--fg-dim)">Precision</span>
        <select class="pf-select" id="pfDmFormat">
          <option value="sp"${data.dmFormat === 'sp' ? ' selected' : ''}>Single (REAL*4)</option>
          <option value="ep"${data.dmFormat === 'ep' ? ' selected' : ''}>Extended (REAL*8)</option>
        </select>
      </div>
    </div>`;
  }

  // Column list header with search
  html += `<div class="pf-sidebar-section" style="padding-bottom:0.3rem">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.35rem">
      <div class="pf-sidebar-section-title" style="margin:0">Columns</div>
      <div class="pf-sidebar-actions">
        <button id="pfSelectAll">all</button>
        <button id="pfSelectNone">none</button>
        <span class="pf-col-count"><span id="pfEnabledCount">${enabledCount}</span>/${header.length}</span>
      </div>
    </div>
    <input type="text" class="pf-search" id="pfSearch" placeholder="Search columns…" autocomplete="off" spellcheck="false">
    <div class="pf-bulk-filters">
      <button id="pfFilterAllGt0" title="Set >0 filter on all grade columns">&gt;0 all</button>
      <button id="pfFilterClear" title="Clear all value filters">clear filters</button>
      <span class="pf-filter-count"></span>
    </div>
  </div>`;

  // Column list — always render both filter buttons; hide via class when not filterable
  const dmCols = data.isDm && data.dmInfo ? data.dmInfo.columns : null;
  // A8: columns blank throughout the sample (every value a null sentinel) —
  // these will analyze to zero valid values, flag before the user gets there
  const sampleEmpty = header.map((_, i) => {
    if (!data.sampleRows || data.sampleRows.length === 0) return false;
    return data.sampleRows.every(row => NULL_SENTINELS_MAIN.has(i < row.length ? row[i].trim() : ''));
  });
  // A9 F2: non-numeric values in the sample — shown when the column's
  // effective type is numeric (those values analyze to nulls). Computed
  // type-independently; the badge hides/shows on type toggle.
  const sampleMixed = header.map((_, i) => {
    if (!data.sampleRows || data.sampleRows.length === 0) return 0;
    let bad = 0;
    for (const row of data.sampleRows) {
      const v = i < row.length ? row[i].trim() : '';
      if (NULL_SENTINELS_MAIN.has(v)) continue;
      if (isNaN(Number(v))) bad++;
    }
    return bad;
  });
  // A9 F8: ragged sample rows — the field-count mismatch that quoted
  // delimiters or a wrong delimiter produce; misaligned values analyze
  // into the wrong columns
  const raggedSample = (!data.isDm && data.sampleRows)
    ? data.sampleRows.filter(r => r.length !== header.length).length : 0;
  if (raggedSample > 0) {
    html += `<div class="swath-aux-warn" style="margin:0 0 0.4rem;">${raggedSample} of ${data.sampleRows.length} sampled rows have a different field count than the header — check delimiter and quoting.</div>`;
  }
  html += '<div class="pf-col-list" id="pfColList">';
  for (let i = 0; i < header.length; i++) {
    const currentType = typeOverrides[i] || autoTypes[i];
    const label = currentType === 'numeric' ? 'NUM' : 'CAT';
    const isSkipped = skipCols.has(i);
    const cf = colFilters[i] || {};
    const filterable = isFilterableCol(header, i, autoTypes, typeOverrides, data.xyz, skipCols);
    const hideCls = filterable ? '' : ' pf-filter-hidden';
    const isDmConst = dmCols && dmCols[i] && dmCols[i].isConstant;
    const constStyle = isDmConst ? ' style="border-left:2px solid var(--amber-dim,rgba(184,115,51,0.4))"' : '';
    const constTooltip = isDmConst ? ' title="File constant \u2014 same value for all records: ' + esc(String(dmCols[i].constantValue || '')) + '"' : '';
    html += `<div class="pf-col-item${isSkipped ? ' skipped' : ''}" data-col="${i}" data-name="${esc(header[i]).toLowerCase()}"${constStyle}>
      <span class="col-idx">${i}</span>
      <input type="checkbox" class="pf-col-check" data-col="${i}" ${!isSkipped ? 'checked' : ''}>
      <span class="pf-col-name"${isDmConst ? constTooltip : ` title="${esc(header[i])}"`}>${esc(header[i])}</span>
      <div class="pf-col-controls">
        ${isDmConst ? '<span class="pf-const-badge" title="File constant">CONST</span>' : ''}
        ${sampleEmpty[i] && !isDmConst ? `<span class="pf-const-badge pf-empty-badge" title="No values in the first ${data.sampleRows.length} sampled rows — column appears empty">EMPTY</span>` : ''}
        ${sampleMixed[i] > 0 && !isDmConst ? `<span class="pf-const-badge pf-mixed-badge" data-col="${i}" title="${sampleMixed[i]} of ${data.sampleRows.length} sampled values aren't numeric — as NUM they become nulls; toggle to CAT if this is a category column"${currentType !== 'numeric' ? ' style="display:none"' : ''}>MIXED</span>` : ''}
        <button class="pf-filter-btn${cf.skipNeg ? ' active' : ''}${hideCls}" data-col="${i}" data-filter="skipNeg" title="Exclude negatives">≥0</button>
        <button class="pf-filter-btn${cf.skipZeros ? ' active' : ''}${hideCls}" data-col="${i}" data-filter="skipZeros" title="Exclude zeros">≠0</button>
        <button class="type-toggle" data-col="${i}" data-type="${currentType}">${label}</button>
      </div>
    </div>`;
  }
  html += '</div>';


  $preflightSidebar.innerHTML = html;

  // Build XYZ and DXYZ dropdowns and update counts
  rebuildPfXyz(data);
  rebuildPfDxyz(data);
  updatePfCounts(data);

  // === Wire event delegation (once per render) ===

  const $pfColList = document.getElementById('pfColList');

  // Delegated click on column list: type toggles + filter buttons
  $pfColList.addEventListener('click', (e) => {
    const btn = e.target.closest('.type-toggle');
    if (btn) { handlePfTypeToggle(btn, data); return; }
    const fbtn = e.target.closest('.pf-filter-btn');
    if (fbtn) { handlePfFilterBtn(fbtn, data); return; }
  });

  // Delegated change on column list: checkboxes
  $pfColList.addEventListener('change', (e) => {
    const cb = e.target.closest('.pf-col-check');
    if (cb) handlePfCheckbox(cb, data);
  });

  // Search
  const $search = document.getElementById('pfSearch');
  $search.addEventListener('input', () => {
    const q = $search.value.toLowerCase().trim();
    $pfColList.querySelectorAll('.pf-col-item').forEach(el => {
      el.style.display = (!q || el.dataset.name.includes(q)) ? '' : 'none';
    });
    // Update All/None labels based on search state
    const $all = document.getElementById('pfSelectAll');
    const $none = document.getElementById('pfSelectNone');
    if ($all) $all.textContent = q ? 'all visible' : 'all';
    if ($none) $none.textContent = q ? 'none visible' : 'none';
  });
  $search.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.stopPropagation(); });

  // Select all / none — search-aware
  document.getElementById('pfSelectAll').addEventListener('click', () => handlePfSelectAll(data));
  document.getElementById('pfSelectNone').addEventListener('click', () => handlePfSelectNone(data));

  // Bulk filter buttons
  document.getElementById('pfFilterAllGt0').addEventListener('click', () => handlePfBulkFilterAll(data));
  document.getElementById('pfFilterClear').addEventListener('click', () => handlePfBulkFilterClear(data));

  // DM format override handlers
  if (data.isDm) {
    const $pfEnd = document.getElementById('pfEndianness');
    const $pfFmt = document.getElementById('pfDmFormat');
    if ($pfEnd) $pfEnd.addEventListener('change', () => handleDmFormatChange(data));
    if ($pfFmt) $pfFmt.addEventListener('change', () => handleDmFormatChange(data));
  }

}

// --- Preflight sidebar helper functions ---

function rebuildPfXyz(data) {
  const { header, autoTypes, typeOverrides, skipCols } = data;
  const types = header.map((_, i) => typeOverrides[i] || autoTypes[i]);
  const numCols = header.map((_, i) => i).filter(i => types[i] === 'numeric' && !skipCols.has(i));

  function makeAxisSelect(axis) {
    const current = data.xyz[axis];
    let opts = `<option value="-1" ${current < 0 ? 'selected' : ''}>—</option>`;
    for (const i of numCols) {
      opts += `<option value="${i}" ${i === current ? 'selected' : ''}>${esc(header[i])}</option>`;
    }
    return `<label><span class="axis-label">${axis.toUpperCase()}</span><select data-axis="${axis}">${opts}</select></label>`;
  }

  const wrap = document.getElementById('pfXyzWrap');
  if (!wrap) return;
  wrap.innerHTML = `<div class="pf-xyz-row">${makeAxisSelect('x')}${makeAxisSelect('y')}${makeAxisSelect('z')}</div>`;
  wirePfXyzHandlers(data);
}

function wirePfXyzHandlers(data) {
  const wrap = document.getElementById('pfXyzWrap');
  if (!wrap) return;
  wrap.querySelectorAll('select').forEach(sel => {
    sel.addEventListener('change', () => {
      data.xyz[sel.dataset.axis] = parseInt(sel.value);
      updateAllFilterButtonVisibility(data);
      updatePfCounts(data);
      markAnalysisStale();
    });
  });
}

function rebuildPfDxyz(data) {
  const { header, autoTypes, typeOverrides, skipCols } = data;
  if (!data.dxyz) data.dxyz = { dx: -1, dy: -1, dz: -1 };
  const types = header.map((_, i) => typeOverrides[i] || autoTypes[i]);
  const numCols = header.map((_, i) => i).filter(i => types[i] === 'numeric' && !skipCols.has(i));

  function makeDAxisSelect(axis) {
    const current = data.dxyz[axis];
    let opts = `<option value="-1" ${current < 0 ? 'selected' : ''}>None</option>`;
    for (const i of numCols) {
      opts += `<option value="${i}" ${i === current ? 'selected' : ''}>${esc(header[i])}</option>`;
    }
    return `<label><span class="axis-label">${axis.toUpperCase()}</span><select data-daxis="${axis}">${opts}</select></label>`;
  }

  const wrap = document.getElementById('pfDxyzWrap');
  if (!wrap) return;
  wrap.innerHTML = `<div class="pf-xyz-row">${makeDAxisSelect('dx')}${makeDAxisSelect('dy')}${makeDAxisSelect('dz')}</div>`;
  wrap.querySelectorAll('select').forEach(sel => {
    sel.addEventListener('change', () => {
      data.dxyz[sel.dataset.daxis] = parseInt(sel.value);
      markAnalysisStale();
    });
  });
}

function updatePfCounts(data) {
  const { header, autoTypes, typeOverrides, skipCols, colFilters } = data;
  // Enabled count
  const $en = document.getElementById('pfEnabledCount');
  if ($en) $en.textContent = header.length - skipCols.size;
  // Filter count
  const filterableCols = header.map((_, i) => i).filter(i => isFilterableCol(header, i, autoTypes, typeOverrides, data.xyz, skipCols));
  const activeFilterCount = filterableCols.filter(i => colFilters[i] && (colFilters[i].skipZeros || colFilters[i].skipNeg)).length;
  const $fc = $preflightSidebar.querySelector('.pf-filter-count');
  if ($fc) $fc.textContent = `${activeFilterCount}/${filterableCols.length} filtered`;
}

function updateAllFilterButtonVisibility(data) {
  const { header, autoTypes, typeOverrides, skipCols } = data;
  const $pfColList = document.getElementById('pfColList');
  if (!$pfColList) return;
  $pfColList.querySelectorAll('.pf-col-item').forEach(item => {
    const col = parseInt(item.dataset.col);
    const filterable = isFilterableCol(header, col, autoTypes, typeOverrides, data.xyz, skipCols);
    item.querySelectorAll('.pf-filter-btn').forEach(btn => {
      btn.classList.toggle('pf-filter-hidden', !filterable);
    });
  });
}

function updateItemFilterability(item, col, data) {
  const { header, autoTypes, typeOverrides, skipCols } = data;
  const filterable = isFilterableCol(header, col, autoTypes, typeOverrides, data.xyz, skipCols);
  item.querySelectorAll('.pf-filter-btn').forEach(btn => {
    btn.classList.toggle('pf-filter-hidden', !filterable);
  });
}

// --- Preflight sidebar handler functions ---

function handlePfTypeToggle(btn, data) {
  const { autoTypes, typeOverrides, colFilters } = data;
  const col = parseInt(btn.dataset.col);
  const current = btn.dataset.type;
  const next = current === 'numeric' ? 'categorical' : 'numeric';
  if (next !== autoTypes[col]) {
    typeOverrides[col] = next;
  } else {
    delete typeOverrides[col];
  }
  if (next === 'categorical') {
    for (const axis of ['x', 'y', 'z']) {
      if (data.xyz[axis] === col) data.xyz[axis] = -1;
    }
    delete colFilters[col];
    // Clear active state on filter buttons for this column
    const item = btn.closest('.pf-col-item');
    item.querySelectorAll('.pf-filter-btn').forEach(fb => fb.classList.remove('active'));
  }
  // Update button text and data attribute
  btn.dataset.type = next;
  btn.textContent = next === 'numeric' ? 'NUM' : 'CAT';
  // MIXED badge only applies while the column is numeric (A9 F2)
  const mixedBadge = btn.closest('.pf-col-item').querySelector('.pf-mixed-badge');
  if (mixedBadge) mixedBadge.style.display = next === 'numeric' ? '' : 'none';
  // Update filter button visibility for this item
  updateItemFilterability(btn.closest('.pf-col-item'), col, data);
  rebuildPfXyz(data);
  updatePfCounts(data);
  markAnalysisStale();
}

function handlePfCheckbox(cb, data) {
  const { header, skipCols, colFilters } = data;
  const col = parseInt(cb.dataset.col);
  if (cb.checked) {
    skipCols.delete(col);
  } else {
    skipCols.add(col);
    for (const axis of ['x', 'y', 'z']) {
      if (data.xyz[axis] === col) data.xyz[axis] = -1;
    }
    delete colFilters[col];
    // Clear active state on filter buttons
    const item = cb.closest('.pf-col-item');
    item.querySelectorAll('.pf-filter-btn').forEach(fb => fb.classList.remove('active'));
  }
  cb.closest('.pf-col-item').classList.toggle('skipped', !cb.checked);
  updateItemFilterability(cb.closest('.pf-col-item'), col, data);
  rebuildPfXyz(data);
  updatePfCounts(data);
  updatePreviewDimming(data);
  markAnalysisStale();
}

function handlePfFilterBtn(btn, data) {
  const { colFilters } = data;
  const col = parseInt(btn.dataset.col);
  const filter = btn.dataset.filter;
  if (!colFilters[col]) colFilters[col] = {};
  colFilters[col][filter] = !colFilters[col][filter];
  if (!colFilters[col][filter]) delete colFilters[col][filter];
  if (Object.keys(colFilters[col]).length === 0) delete colFilters[col];
  btn.classList.toggle('active');
  updatePfCounts(data);
  markAnalysisStale();
}

function handlePfSelectAll(data) {
  const { header, skipCols } = data;
  const $pfColList = document.getElementById('pfColList');
  if (!$pfColList) return;
  // Only affect visible (search-matched) items
  $pfColList.querySelectorAll('.pf-col-item').forEach(item => {
    if (item.style.display === 'none') return; // hidden by search
    const col = parseInt(item.dataset.col);
    skipCols.delete(col);
    item.classList.remove('skipped');
    const cb = item.querySelector('.pf-col-check');
    if (cb) cb.checked = true;
    updateItemFilterability(item, col, data);
  });
  rebuildPfXyz(data);
  updatePfCounts(data);
  updatePreviewDimming(data);
  markAnalysisStale();
}

function handlePfSelectNone(data) {
  const { header, skipCols, colFilters } = data;
  const $pfColList = document.getElementById('pfColList');
  if (!$pfColList) return;
  // Only affect visible (search-matched) items
  $pfColList.querySelectorAll('.pf-col-item').forEach(item => {
    if (item.style.display === 'none') return; // hidden by search
    const col = parseInt(item.dataset.col);
    skipCols.add(col);
    // Clear XYZ assignments for this column
    for (const axis of ['x', 'y', 'z']) {
      if (data.xyz[axis] === col) data.xyz[axis] = -1;
    }
    delete colFilters[col];
    item.classList.add('skipped');
    const cb = item.querySelector('.pf-col-check');
    if (cb) cb.checked = false;
    // Clear filter active states and hide buttons
    item.querySelectorAll('.pf-filter-btn').forEach(fb => {
      fb.classList.remove('active');
      fb.classList.add('pf-filter-hidden');
    });
  });
  rebuildPfXyz(data);
  updatePfCounts(data);
  updatePreviewDimming(data);
  markAnalysisStale();
}

function handlePfBulkFilterAll(data) {
  const { header, autoTypes, typeOverrides, skipCols, colFilters } = data;
  const filterableCols = header.map((_, i) => i).filter(i => isFilterableCol(header, i, autoTypes, typeOverrides, data.xyz, skipCols));
  for (const i of filterableCols) {
    colFilters[i] = { skipZeros: true, skipNeg: true };
  }
  // Set active class on all visible filter buttons for filterable cols
  const $pfColList = document.getElementById('pfColList');
  if ($pfColList) {
    $pfColList.querySelectorAll('.pf-filter-btn').forEach(btn => {
      const col = parseInt(btn.dataset.col);
      if (filterableCols.includes(col)) btn.classList.add('active');
    });
  }
  updatePfCounts(data);
  markAnalysisStale();
}

function handlePfBulkFilterClear(data) {
  const { colFilters } = data;
  for (const key of Object.keys(colFilters)) delete colFilters[key];
  // Remove active class from all filter buttons
  const $pfColList = document.getElementById('pfColList');
  if ($pfColList) {
    $pfColList.querySelectorAll('.pf-filter-btn').forEach(btn => btn.classList.remove('active'));
  }
  updatePfCounts(data);
  markAnalysisStale();
}

async function handleDmFormatChange(data) {
  const $pfEnd = document.getElementById('pfEndianness');
  const $pfFmt = document.getElementById('pfDmFormat');
  if (!$pfEnd || !$pfFmt) return;
  const newEndianness = $pfEnd.value;
  const newFormat = $pfFmt.value;
  try {
    const pageSize = newFormat === 'ep' ? 4096 : 2048;
    const buf = await currentFile.slice(0, pageSize).arrayBuffer();
    const dv = new DataView(buf);
    const dmInfo = parseDmDD(dv, newEndianness, newFormat);
    data.dmEndianness = newEndianness;
    data.dmFormat = newFormat;
    data.dmInfo = dmInfo;
    data.header = dmInfo.columns.map(c => c.name);
    data.autoTypes = dmInfo.columns.map(c => c.type);
    data.sampleRows = await readDmSampleRows(currentFile, dmInfo, 100, newEndianness);
    data.typeOverrides = {};
    data.skipCols = new Set();
    data.xyz = guessXYZMain(data.header, data.autoTypes);
    data.dxyz = guessDXYZMain(data.header, data.autoTypes);
    data.colFilters = buildDefaultColFilters(data.header, data.autoTypes, data.xyz);
    renderPreflight(data);
  } catch(err) {
    $preflightPreview.innerHTML = '<div style="padding:1rem;color:var(--red)">' + esc(err.message) + '</div>';
  }
}

function updatePreviewDimming(data) {
  const table = $preflightPreview.querySelector('table');
  if (!table) return;
  for (let c = 0; c < data.header.length; c++) {
    const colIdx = c + 1;
    const isSkipped = data.skipCols.has(c);
    table.querySelectorAll(`th:nth-child(${colIdx + 1}), td:nth-child(${colIdx + 1})`).forEach(el => {
      el.classList.toggle('col-skipped', isSkipped);
    });
  }
}

function renderPreflightTable(data) {
  const { header, sampleRows, skipCols } = data;

  let thead = '<tr><th style="color:var(--fg-dim);opacity:0.5">#</th>';
  for (let i = 0; i < header.length; i++) {
    const dimClass = skipCols.has(i) ? ' class="col-skipped"' : '';
    thead += `<th${dimClass}>${esc(header[i])}</th>`;
  }
  thead += '</tr>';

  let tbody = '';
  for (let r = 0; r < sampleRows.length; r++) {
    tbody += `<tr><td>${r}</td>`;
    for (let c = 0; c < header.length; c++) {
      const val = (sampleRows[r] && sampleRows[r][c]) || '';
      const dimClass = skipCols.has(c) ? ' class="col-skipped"' : '';
      tbody += `<td${dimClass}>${esc(val)}</td>`;
    }
    tbody += '</tr>';
  }

  $preflightPreview.innerHTML = `<table><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
}

function addThousandsSep(s) {
  var sep = (typeof bmaSettings !== 'undefined' && bmaSettings && bmaSettings.thousandsSep) || 'space';
  if (sep === 'none') return s;
  var sepChar = sep === 'comma' ? ',' : '\u2009'; // thin space
  var parts = s.split('.');
  var intPart = parts[0];
  var neg = '';
  if (intPart.startsWith('-')) { neg = '-'; intPart = intPart.substring(1); }
  if (intPart.length <= 3) return s;
  var result = '';
  for (var i = intPart.length - 1, count = 0; i >= 0; i--, count++) {
    if (count > 0 && count % 3 === 0) result = sepChar + result;
    result = intPart[i] + result;
  }
  return neg + result + (parts.length > 1 ? '.' + parts[1] : '');
}

function formatNum(v, decimals) {
  if (v === null || v === undefined) return '\u2014';
  var d = decimals;
  if (d === undefined && typeof bmaSettings !== 'undefined' && bmaSettings && bmaSettings.sigFigs !== null) {
    d = bmaSettings.sigFigs;
  }
  // Sci notation check
  var sciMode = (typeof bmaSettings !== 'undefined' && bmaSettings && bmaSettings.sciNotation) || 'auto';
  var useSci = false;
  if (sciMode === 'auto') {
    useSci = Math.abs(v) >= 1e6 || (Math.abs(v) < 0.001 && v !== 0);
  } else if (sciMode !== 'never') {
    var threshold = parseFloat(sciMode);
    useSci = isFinite(threshold) && (Math.abs(v) >= threshold || (Math.abs(v) < 0.001 && v !== 0));
  }
  if (useSci) return v.toExponential(d != null ? d : 3);
  // Fixed-point formatting
  var fracDigits = d != null ? d : (Math.abs(v) >= 100 ? 2 : Math.abs(v) >= 1 ? 3 : 4);
  if (Number.isInteger(v)) return addThousandsSep(String(v));
  var s = v.toFixed(fracDigits);
  // Trim trailing zeros to min 2
  var fparts = s.split('.');
  if (fparts.length === 2) {
    var minFrac = d != null ? d : 2;
    while (fparts[1].length > minFrac && fparts[1].endsWith('0')) fparts[1] = fparts[1].slice(0, -1);
    s = fparts[0] + '.' + fparts[1];
  }
  return addThousandsSep(s);
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function delimName(d) {
  if (d === ',') return 'comma';
  if (d === '\t') return 'tab';
  if (d === ';') return 'semicolon';
  if (d === '|') return 'pipe';
  if (d === ' ') return 'space';
  return JSON.stringify(d);
}

