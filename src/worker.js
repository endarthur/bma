const DELIMITERS = [',', '\t', ';', '|', ' '];
const MAX_UNIQUE_CAT = 500;
const MAX_GROUPS = 500;

// XYZ name patterns
const XYZ_PATTERNS = {
  x: [/^x$/i, /^xc$/i, /^x[_-]?cent(re|er)?$/i, /^mid[_-]?x$/i, /^centroid[_-]?x$/i, /^east(ing)?$/i, /^x[_-]?coord$/i, /^xcenter$/i, /^xmid$/i, /^xblock$/i],
  y: [/^y$/i, /^yc$/i, /^y[_-]?cent(re|er)?$/i, /^mid[_-]?y$/i, /^centroid[_-]?y$/i, /^north(ing)?$/i, /^y[_-]?coord$/i, /^ycenter$/i, /^ymid$/i, /^yblock$/i],
  z: [/^z$/i, /^zc$/i, /^z[_-]?cent(re|er)?$/i, /^mid[_-]?z$/i, /^centroid[_-]?z$/i, /^elev(ation)?$/i, /^rl$/i, /^z[_-]?coord$/i, /^zcenter$/i, /^zmid$/i, /^zblock$/i, /^level$/i, /^bench$/i]
};

const DXYZ_PATTERNS = {
  dx: [/^dx$/i, /^xinc$/i, /^xdis$/i, /^xsize$/i, /^dimx$/i, /^xlen$/i, /^x[_-]?dim$/i, /^x[_-]?size$/i, /^d[_-]?x$/i, /^size[_-]?x$/i],
  dy: [/^dy$/i, /^yinc$/i, /^ydis$/i, /^ysize$/i, /^dimy$/i, /^ylen$/i, /^y[_-]?dim$/i, /^y[_-]?size$/i, /^d[_-]?y$/i, /^size[_-]?y$/i],
  dz: [/^dz$/i, /^zinc$/i, /^zdis$/i, /^zsize$/i, /^dimz$/i, /^zlen$/i, /^z[_-]?dim$/i, /^z[_-]?size$/i, /^d[_-]?z$/i, /^size[_-]?z$/i]
};

function guessDXYZ(header, types) {
  const result = { dx: -1, dy: -1, dz: -1 };
  for (const axis of ['dx', 'dy', 'dz']) {
    for (const pat of DXYZ_PATTERNS[axis]) {
      const idx = header.findIndex((h, i) => types[i] === 'numeric' && pat.test(h.trim()));
      if (idx >= 0) { result[axis] = idx; break; }
    }
  }
  return result;
}

function detectDelimiter(lines) {
  let best = ',', bestScore = -1;
  for (const d of DELIMITERS) {
    const counts = lines.map(l => l.split(d).length);
    if (counts[0] < 2) continue;
    const allSame = counts.every(c => c === counts[0]);
    const score = allSame ? counts[0] * 1000 + counts.length : counts[0];
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

const NULL_SENTINELS = new Set(['', 'NA', 'NaN', 'na', 'nan', 'N/A', 'n/a', 'null', 'NULL', '*', '-', '-999', '-99', '#N/A', 'VOID', 'void', '-1.0e+32', '-1e+32', '1e+31', '-9999', '-99999']);

function guessXYZ(header, types) {
  const result = { x: -1, y: -1, z: -1 };
  for (const axis of ['x', 'y', 'z']) {
    for (const pat of XYZ_PATTERNS[axis]) {
      const idx = header.findIndex((h, i) => types[i] === 'numeric' && pat.test(h.trim()));
      if (idx >= 0) { result[axis] = idx; break; }
    }
  }
  // Fallback: if not all found, look for first 3 numeric columns
  if (result.x < 0 || result.y < 0 || result.z < 0) {
    const numCols = header.map((h, i) => i).filter(i => types[i] === 'numeric');
    if (numCols.length >= 3 && result.x < 0 && result.y < 0 && result.z < 0) {
      result.x = numCols[0]; result.y = numCols[1]; result.z = numCols[2];
    }
  }
  return result;
}

function computeGeometry(xVals, yVals, zVals, decimals, dims) {
  const axes = { x: xVals, y: yVals, z: zVals };
  const result = {};
  for (const [axis, vals] of Object.entries(axes)) {
    if (!vals || vals.length === 0) { result[axis] = null; continue; }
    const dp = decimals[axis];
    const rnd = (v) => {
      if (v === null) return null;
      const factor = Math.pow(10, dp);
      return Math.round(v * factor) / factor;
    };
    const sorted = Float64Array.from(vals).sort();
    const min = sorted[0], max = sorted[sorted.length - 1];
    const count = sorted.length;

    // Collect all spacings and their frequencies
    const spacingCounts = {};
    if (count > 1) {
      for (let i = 1; i < sorted.length; i++) {
        const d = rnd(sorted[i] - sorted[i - 1]);
        if (d > 0) spacingCounts[d] = (spacingCounts[d] || 0) + 1;
      }
    }

    const spacings = Object.entries(spacingCounts)
      .map(([s, c]) => ({ size: Number(s), count: c }))
      .sort((a, b) => b.count - a.count);

    let parentSize = null;
    let subBlockSizes = [];
    let isSubBlocked = false;

    if (spacings.length === 0) {
      // Single unique value
    } else if (spacings.length === 1) {
      // Regular grid
      parentSize = spacings[0].size;
    } else {
      // Multiple spacings — check for sub-block pattern
      // Parent block = largest spacing that appears frequently
      // "frequently" = at least 5% of total spacings
      const totalSpacings = spacings.reduce((s, x) => s + x.count, 0);
      const significant = spacings.filter(s => s.count / totalSpacings > 0.02);

      if (significant.length === 1) {
        parentSize = significant[0].size;
      } else {
        // Find the largest significant spacing as candidate parent
        const sorted_sig = significant.slice().sort((a, b) => b.size - a.size);
        const candidateParent = sorted_sig[0].size;

        // Check if smaller spacings are clean divisors of the parent
        const subs = [];
        let allDivisors = true;
        for (const s of sorted_sig.slice(1)) {
          const ratio = candidateParent / s.size;
          const roundedRatio = Math.round(ratio);
          if (roundedRatio >= 2 && Math.abs(ratio - roundedRatio) < 0.05) {
            subs.push({ size: s.size, ratio: roundedRatio, count: s.count });
          } else {
            allDivisors = false;
          }
        }

        if (subs.length > 0) {
          // Sub-block model detected
          parentSize = rnd(candidateParent);
          subBlockSizes = subs.map(s => ({ size: rnd(s.size), ratio: s.ratio, count: s.count }));
          isSubBlocked = true;
        } else {
          // Irregular spacings — use most frequent as best guess
          parentSize = spacings[0].size;
        }
      }
    }

    // Override from explicit dimension columns if available
    if (dims && dims[axis] && dims[axis].length > 0) {
      const dimVals = dims[axis];
      const uniqueDims = [...new Set(dimVals)].sort((a, b) => a - b);
      const maxDim = Math.max(...uniqueDims);
      if (uniqueDims.length === 1) {
        parentSize = rnd(uniqueDims[0]);
        isSubBlocked = false;
        subBlockSizes = [];
      } else {
        parentSize = rnd(maxDim);
        isSubBlocked = true;
        subBlockSizes = uniqueDims.filter(d => d < maxDim).map(d => ({
          size: rnd(d), ratio: Math.round(maxDim / d), count: dimVals.filter(v => v === d).length
        }));
      }
    }

    const origin = rnd(min);
    const maxR = rnd(max);
    const nBlocks = parentSize ? Math.round((maxR - origin) / parentSize) + 1 : count;
    const extent = parentSize ? rnd(nBlocks * parentSize) : rnd(maxR - origin);
    const minBlockSize = spacings.length > 0 ? spacings[spacings.length - 1].size : null;

    result[axis] = {
      origin,
      max: maxR,
      blockSize: parentSize,
      minBlockSize: isSubBlocked ? rnd(Math.min(...subBlockSizes.map(s => s.size))) : null,
      subBlockSizes: isSubBlocked ? subBlockSizes : [],
      isSubBlocked,
      uniqueCount: count,
      gridCount: nBlocks,
      extent,
      decimals: dp
    };
  }
  return result;
}

// Round to n significant figures for display
// ─── ZIP support ──────────────────────────────────────────────────────
const CSV_EXTENSIONS = /\.(csv|txt|dat|tsv)$/i;

async function readBytes(file, offset, length) {
  const blob = file.slice(offset, offset + length);
  return new Uint8Array(await blob.arrayBuffer());
}

function readUint16(buf, off) { return buf[off] | (buf[off+1] << 8); }
function readUint32(buf, off) { return (buf[off] | (buf[off+1] << 8) | (buf[off+2] << 16) | (buf[off+3] << 24)) >>> 0; }

async function extractCSVFromZip(file, targetEntry) {
  self.postMessage({ type: 'progress', percent: 0, rowCount: 0, note: 'Reading ZIP headers...' });

  // Read last 64KB to find End of Central Directory
  const tailSize = Math.min(65557, file.size);
  const tail = await readBytes(file, file.size - tailSize, tailSize);

  let eocdPos = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (readUint32(tail, i) === 0x06054b50) { eocdPos = i; break; }
  }
  if (eocdPos < 0) throw new Error('Not a valid ZIP file (EOCD not found)');

  const cdEntries = readUint16(tail, eocdPos + 8);
  const cdSize = readUint32(tail, eocdPos + 12);
  const cdOffset = readUint32(tail, eocdPos + 16);

  // Read central directory
  const cd = await readBytes(file, cdOffset, cdSize);
  const entries = [];
  let pos = 0;
  for (let i = 0; i < cdEntries && pos < cd.length; i++) {
    if (readUint32(cd, pos) !== 0x02014b50) break;
    const method = readUint16(cd, pos + 10);
    const compSize = readUint32(cd, pos + 20);
    const uncompSize = readUint32(cd, pos + 24);
    const nameLen = readUint16(cd, pos + 28);
    const extraLen = readUint16(cd, pos + 30);
    const commentLen = readUint16(cd, pos + 32);
    const localOffset = readUint32(cd, pos + 42);
    const name = new TextDecoder().decode(cd.slice(pos + 46, pos + 46 + nameLen));
    entries.push({ name, method, compSize, uncompSize, localOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }

  // Find CSV entry: use targetEntry if specified, otherwise first CSV
  let csvEntry;
  if (targetEntry) {
    csvEntry = entries.find(e => e.name === targetEntry);
    if (!csvEntry) throw new Error('Entry not found in ZIP: ' + targetEntry);
  } else {
    csvEntry = entries.find(e =>
      !e.name.endsWith('/') &&
      !e.name.startsWith('__MACOSX') &&
      !e.name.startsWith('.') &&
      CSV_EXTENSIONS.test(e.name)
    );
  }

  if (!csvEntry) {
    const names = entries.filter(e => !e.name.endsWith('/')).map(e => e.name).join(', ');
    throw new Error('No CSV/TXT/DAT file found in ZIP. Contents: ' + names);
  }

  self.postMessage({ type: 'progress', percent: 0, rowCount: 0, note: 'Streaming ' + csvEntry.name + '...' });

  // Read local file header (30 bytes + variable) to find data start
  const lh = await readBytes(file, csvEntry.localOffset, 30);
  const lhNameLen = readUint16(lh, 26);
  const lhExtraLen = readUint16(lh, 28);
  const dataStart = csvEntry.localOffset + 30 + lhNameLen + lhExtraLen;

  // Slice compressed data directly from file — no full load
  const compressedSlice = file.slice(dataStart, dataStart + csvEntry.compSize);

  if (csvEntry.method === 0) {
    // Stored
    return { stream: () => compressedSlice.stream(), size: csvEntry.uncompSize, name: csvEntry.name };
  } else if (csvEntry.method === 8) {
    // Deflate — stream through DecompressionStream
    return {
      stream: () => compressedSlice.stream().pipeThrough(new DecompressionStream('deflate-raw')),
      size: csvEntry.uncompSize,
      name: csvEntry.name
    };
  } else {
    throw new Error('Unsupported ZIP compression method: ' + csvEntry.method);
  }
}

function isZipFile(file) {
  return file.name.toLowerCase().endsWith('.zip') || file.type === 'application/zip';
}

async function readSample(file, maxLines) {
  const stream = file.stream().pipeThrough(new TextDecoderStream());
  const reader = stream.getReader();
  let buf = '', lines = [], done = false;
  while (!done && lines.length < maxLines + 1) {
    const res = await reader.read();
    if (res.done) { done = true; break; }
    buf += res.value;
    const parts = buf.split('\n');
    buf = parts.pop();
    for (const p of parts) {
      const trimmed = p.replace(/\r$/, '');
      if (trimmed.startsWith('#')) continue;
      lines.push(trimmed);
      if (lines.length >= maxLines + 1) break;
    }
  }
  if (buf && lines.length < maxLines + 1) {
    const trimmed = buf.replace(/\r$/, '');
    if (!trimmed.startsWith('#')) lines.push(trimmed);
  }
  reader.cancel();
  return lines;
}

// ─── T-Digest for streaming approximate quantiles ─────────────────────
const TD_COMPRESSION = 100;
const TD_BUFFER_SIZE = 2000;

function newTDigest() {
  return { centroids: [], buffer: [], totalCount: 0 };
}

function tdAdd(td, value) {
  td.buffer.push(value);
  td.totalCount++;
  if (td.buffer.length >= TD_BUFFER_SIZE) tdFlush(td);
}

function tdFlush(td) {
  if (td.buffer.length === 0) return;
  td.buffer.sort((a, b) => a - b);
  // Merge sorted buffer with sorted centroids
  const merged = [];
  let bi = 0, ci = 0;
  while (bi < td.buffer.length || ci < td.centroids.length) {
    if (bi < td.buffer.length && (ci >= td.centroids.length || td.buffer[bi] <= td.centroids[ci].mean)) {
      merged.push({ mean: td.buffer[bi], count: 1 });
      bi++;
    } else {
      merged.push({ mean: td.centroids[ci].mean, count: td.centroids[ci].count });
      ci++;
    }
  }
  td.buffer = [];
  td.centroids = tdCompress(merged, td.totalCount);
}

function tdCompress(centroids, totalCount) {
  if (centroids.length <= 1) return centroids;
  const result = [centroids[0]];
  let cumCount = centroids[0].count;
  for (let i = 1; i < centroids.length; i++) {
    const c = centroids[i];
    const last = result[result.length - 1];
    const q = cumCount / totalCount;
    const maxSize = Math.max(1, Math.floor(4 * TD_COMPRESSION * q * (1 - q)));
    if (last.count + c.count <= maxSize) {
      const newCount = last.count + c.count;
      last.mean += (c.mean - last.mean) * c.count / newCount;
      last.count = newCount;
    } else {
      result.push({ mean: c.mean, count: c.count });
    }
    cumCount += c.count;
  }
  return result;
}

function tdQuantile(td, q) {
  tdFlush(td);
  const centroids = td.centroids;
  if (centroids.length === 0) return null;
  if (centroids.length === 1) return centroids[0].mean;
  if (q <= 0) return centroids[0].mean;
  if (q >= 1) return centroids[centroids.length - 1].mean;

  const target = q * td.totalCount;
  let cumCount = 0;
  for (let i = 0; i < centroids.length; i++) {
    const c = centroids[i];
    const lo = cumCount;
    const mid = lo + c.count / 2;
    if (target < mid) {
      if (i === 0) return c.mean;
      const prev = centroids[i - 1];
      const prevMid = lo - prev.count / 2;
      const t = (target - prevMid) / (mid - prevMid);
      return prev.mean + t * (c.mean - prev.mean);
    }
    cumCount += c.count;
  }
  return centroids[centroids.length - 1].mean;
}

const MATH_PREAMBLE = 'const {abs,sqrt,pow,log,log2,log10,exp,min,max,round,floor,ceil,sign,trunc,hypot,sin,cos,tan,asin,acos,atan,atan2,PI,E}=Math;const fn={cap:(v,lo,hi)=>v==null?null:hi===undefined?Math.min(v,lo):Math.min(Math.max(v,lo),hi),ifnull:(v,d)=>(v==null||v!==v)?d:v,between:(v,lo,hi)=>v!=null&&v>=lo&&v<=hi,remap:(v,m,d)=>m.hasOwnProperty(v)?m[v]:(d!==undefined?d:null),round:(v,n)=>{const f=Math.pow(10,n||0);return Math.round(v*f)/f;},clamp:(v,lo,hi)=>Math.min(Math.max(v,lo),hi),isnum:(v)=>Number.isFinite(v),ifnum:(v,d)=>Number.isFinite(v)?v:(d!==undefined?d:NaN)};const clamp=fn.clamp;const cap=fn.cap;const ifnull=fn.ifnull;const between=fn.between;const remap=fn.remap;const isnum=fn.isnum;const ifnum=fn.ifnum;';

async function analyze(file, xyzOverride, filter, typeOverrides, zipEntry, skipCols, colFilters, calcolCode, calcolMeta, groupBy, groupStatsCols, dxyzOverride) {
  const startTime = performance.now();

  // ZIP extraction
  let csvFile = file;
  let zipName = null;
  if (isZipFile(file)) {
    try {
      csvFile = await extractCSVFromZip(file, zipEntry);
      zipName = csvFile.name;
    } catch(e) {
      self.postMessage({ type: 'error', message: e.message });
      return;
    }
  }

  // Tiny sample for delimiter + header only
  const sampleLines = await readSample(csvFile, 50);
  if (sampleLines.length < 2) {
    self.postMessage({ type: 'error', message: 'File appears empty or has no data rows.' });
    return;
  }

  const delimiter = detectDelimiter(sampleLines.slice(0, 20));
  const header = sampleLines[0].split(delimiter).map(h => h.trim().replace(/^["']|["']$/g, ''));
  const nCols = header.length;

  // Pick a row variable name that doesn't collide with a column name
  let rowVarName = 'r';
  const colSet = new Set(header);
  for (const candidate of ['r', 'd', 'row', '_r', '_d']) {
    if (!colSet.has(candidate)) { rowVarName = candidate; break; }
  }

  // ── Per-column type detection state ──
  const TYPE_MIN_NONNULL = 20;
  const TYPE_MAX_ROWS = 100000;
  const detect_num = new Int32Array(nCols);
  const detect_nonNum = new Int32Array(nCols);
  const forced = new Set(); // columns with forced types
  let colTypes = null; // null = still detecting
  let typesResolved = false;
  let detectRowCount = 0;

  // Apply type overrides — these columns skip detection
  if (typeOverrides) {
    for (const [col, type] of Object.entries(typeOverrides)) {
      forced.add(Number(col));
    }
  }

  function resolveTypes() {
    const types = new Array(nCols);
    for (let col = 0; col < nCols; col++) {
      if (typeOverrides && typeOverrides[col]) {
        types[col] = typeOverrides[col];
        continue;
      }
      const n = detect_num[col], nn = detect_nonNum[col], total = n + nn;
      if (total === 0) types[col] = 'numeric';
      else if (nn === 0) types[col] = 'numeric';
      else if (n === 0) types[col] = 'categorical';
      else types[col] = (n / total > 0.8) ? 'numeric' : 'categorical';
    }
    return types;
  }

  function checkAllResolved() {
    for (let col = 0; col < nCols; col++) {
      if (forced.has(col)) continue;
      if (detect_num[col] + detect_nonNum[col] < TYPE_MIN_NONNULL) return false;
    }
    return true;
  }

  // ── XYZ guess (name-based, no types needed) ──
  function guessXYZByName() {
    const result = { x: -1, y: -1, z: -1 };
    for (const axis of ['x', 'y', 'z']) {
      for (const pat of XYZ_PATTERNS[axis]) {
        const idx = header.findIndex(h => pat.test(h.trim()));
        if (idx >= 0) { result[axis] = idx; break; }
      }
    }
    return result;
  }
  let xyzGuess = xyzOverride || guessXYZByName();
  const xyzSets = { x: new Set(), y: new Set(), z: new Set() };
  let hasXYZ = xyzGuess.x >= 0 && xyzGuess.y >= 0 && xyzGuess.z >= 0;

  // DXYZ guess
  function guessDXYZByName() {
    const result = { dx: -1, dy: -1, dz: -1 };
    for (const axis of ['dx', 'dy', 'dz']) {
      for (const pat of DXYZ_PATTERNS[axis]) {
        const idx = header.findIndex(h => pat.test(h.trim()));
        if (idx >= 0) { result[axis] = idx; break; }
      }
    }
    return result;
  }
  let dxyzGuess = dxyzOverride || guessDXYZByName();
  let hasDXYZ = dxyzGuess.dx >= 0 || dxyzGuess.dy >= 0 || dxyzGuess.dz >= 0;
  const dxyzSets = { dx: [], dy: [], dz: [] };

  // Coordinate ordering detection
  const ORDER_SAMPLE = 50000;
  const prevCoord = { x: null, y: null, z: null };
  const transitions = { x: 0, y: 0, z: 0 };
  let orderSampleCount = 0;

  // Decimal precision detection
  const maxDecimals = { x: 0, y: 0, z: 0 };
  const PRECISION_SAMPLE = 10000;
  let precisionSampleCount = 0;

  // ── Stats accumulators (initialized after type detection) ──
  let stats = null;
  let catCounts = null;
  let numericCols = null;
  let catCols = null;
  let filterFn = null;
  let groupByCol = (groupBy !== null && groupBy !== undefined) ? groupBy : null;
  let groupByColName = null;
  let groupStats = {};
  let groupCategories = {};

  // ── Calcol compiled function ──
  let calcolFn = null;
  let calcolNumCols = [];
  let calcolCatCols = [];

  function initStatsPhase() {
    const skip = skipCols ? new Set(skipCols.map(Number)) : new Set();
    numericCols = header.map((_, i) => i).filter(i => colTypes[i] === 'numeric' && !skip.has(i));
    catCols = header.map((_, i) => i).filter(i => colTypes[i] === 'categorical' && !skip.has(i));
    stats = {};
    for (const i of numericCols) {
      stats[i] = { count: 0, min: Infinity, max: -Infinity, m1: 0, m2: 0, m3: 0, m4: 0, nulls: 0, zeros: 0, td: newTDigest() };
    }
    catCounts = {};
    for (const i of catCols) catCounts[i] = {};

    // Compile calcol code block
    calcolFn = null;
    calcolNumCols = [];
    calcolCatCols = [];
    if (calcolCode && calcolMeta && calcolMeta.length > 0) {
      try {
        calcolFn = new Function(rowVarName, MATH_PREAMBLE + calcolCode);
      } catch(e) {
        calcolFn = null; // compilation failed — skip calcols silently
      }
      for (let ci = 0; ci < calcolMeta.length; ci++) {
        const cm = calcolMeta[ci];
        const idx = nCols + ci;
        if (cm.type === 'numeric') {
          calcolNumCols.push(idx);
          stats[idx] = { count: 0, min: Infinity, max: -Infinity, m1: 0, m2: 0, m3: 0, m4: 0, nulls: 0, zeros: 0, td: newTDigest() };
        } else {
          calcolCatCols.push(idx);
          catCounts[idx] = {};
        }
      }
    }

    // GroupBy init
    if (groupByCol !== null) {
      // Resolve groupBy column name (may be a calcol)
      if (groupByCol < nCols) {
        groupByColName = header[groupByCol];
      } else if (calcolMeta && groupByCol - nCols < calcolMeta.length) {
        groupByColName = calcolMeta[groupByCol - nCols].name;
      }
      const allNum = [...numericCols, ...calcolNumCols];
      const allCat = [...catCols, ...calcolCatCols];
      const gsColSet = groupStatsCols ? new Set(groupStatsCols) : null;
      for (const i of allNum) {
        if (!gsColSet || gsColSet.has(i)) groupStats[i] = new Map();
      }
      for (const i of allCat) {
        if (i === groupByCol) continue;
        if (!gsColSet || gsColSet.has(i)) groupCategories[i] = new Map();
      }
    }

    // Apply XYZ fallback now that types are known
    if (!hasXYZ && !xyzOverride) {
      xyzGuess = guessXYZ(header, colTypes);
      hasXYZ = xyzGuess.x >= 0 && xyzGuess.y >= 0 && xyzGuess.z >= 0;
    }

    // Compile filter
    const filterExpr = filter ? filter.expression : null;
    if (filterExpr) {
      try {
        filterFn = new Function(rowVarName, MATH_PREAMBLE + 'try { return !!(' + filterExpr + '); } catch(e) { return false; }');
      } catch(e) {
        self.postMessage({ type: 'error', message: 'Filter expression error: ' + e.message });
      }
    }

    // Build extended header/types for calcols
    const extHeader = [...header];
    const extTypes = [...colTypes];
    if (calcolMeta) {
      for (const cm of calcolMeta) {
        extHeader.push(cm.name);
        extTypes.push(cm.type);
      }
    }

    self.postMessage({ type: 'header', header: extHeader, delimiter, colTypes: extTypes, xyzGuess, rowVarName, calcolCount: calcolMeta ? calcolMeta.length : 0, origColCount: nCols });
  }

  function buildRow(fields) {
    const obj = {};
    for (let i = 0; i < nCols; i++) {
      const raw = (fields[i] || '').trim().replace(/^["']|["']$/g, '');
      obj[header[i]] = colTypes[i] === 'numeric' ? (NULL_SENTINELS.has(raw) ? NaN : (isNaN(Number(raw)) ? raw : Number(raw))) : raw;
    }
    // Evaluate calcol code block — mutates obj, adding new properties
    if (calcolFn) {
      obj.META = { cat: [], num: [] };
      try { calcolFn(obj); } catch(e) { /* calcol runtime error — skip */ }
      delete obj.META;
    }
    return obj;
  }

  function welfordAdd(s, v) {
    s.count++;
    if (v === 0) s.zeros++;
    if (v < s.min) s.min = v;
    if (v > s.max) s.max = v;
    const n = s.count;
    const delta = v - s.m1;
    const delta_n = delta / n;
    const delta_n2 = delta_n * delta_n;
    const term1 = delta * delta_n * (n - 1);
    s.m4 += term1 * delta_n2 * (n * n - 3 * n + 3) + 6 * delta_n2 * s.m2 - 4 * delta_n * s.m3;
    s.m3 += term1 * delta_n * (n - 2) - 3 * delta_n * s.m2;
    s.m2 += term1;
    s.m1 += delta_n;
    tdAdd(s.td, v);
  }

  function newAcc() {
    return { count: 0, min: Infinity, max: -Infinity, m1: 0, m2: 0, m3: 0, m4: 0, nulls: 0, zeros: 0, td: newTDigest() };
  }

  function getGroupAcc(map, gv) {
    let acc = map.get(gv);
    if (acc) return acc;
    if (map.size >= MAX_GROUPS) return null;
    acc = newAcc();
    map.set(gv, acc);
    return acc;
  }

  function finalizeAcc(s) {
    const n = s.count;
    const variance = n > 1 ? s.m2 / (n - 1) : null;
    const std = variance !== null ? Math.sqrt(variance) : null;
    let skewness = null;
    if (n > 2 && s.m2 > 0) {
      skewness = (Math.sqrt(n) * s.m3) / Math.pow(s.m2, 1.5);
      skewness *= Math.sqrt(n * (n - 1)) / (n - 2);
    }
    let kurtosis = null;
    if (n > 3 && s.m2 > 0) {
      kurtosis = (n * s.m4) / (s.m2 * s.m2) - 3;
      kurtosis = ((n - 1) / ((n - 2) * (n - 3))) * ((n + 1) * kurtosis + 6);
    }
    let quantiles = null;
    let centroids = null;
    if (n > 0) {
      tdFlush(s.td);
      quantiles = {
        p10: tdQuantile(s.td, 0.10),
        p25: tdQuantile(s.td, 0.25),
        p50: tdQuantile(s.td, 0.50),
        p75: tdQuantile(s.td, 0.75),
        p90: tdQuantile(s.td, 0.90)
      };
      centroids = s.td.centroids.map(c => [c.mean, c.count]);
    }
    return {
      count: n, nulls: s.nulls, zeros: s.zeros,
      min: n > 0 ? s.min : null, max: n > 0 ? s.max : null,
      mean: n > 0 ? s.m1 : null, std, skewness, kurtosis, quantiles, centroids
    };
  }

  function processCalcolStats(row) {
    const gv = groupByCol !== null ? String(row[groupByColName] ?? '') : null;
    for (const idx of calcolNumCols) {
      const cm = calcolMeta[idx - nCols];
      let v = row[cm.name];
      if (typeof v === 'boolean') v = v ? 1 : 0;
      const s = stats[idx];
      if (v === null || v === undefined || (typeof v !== 'number') || !isFinite(v)) { s.nulls++; if (gv !== null && groupStats[idx]) { const ga = getGroupAcc(groupStats[idx], gv); if (ga) ga.nulls++; } continue; }
      // Per-column value filters
      const cf = colFilters ? colFilters[idx] : null;
      if (cf) {
        if (cf.skipZeros && v === 0) { s.nulls++; if (gv !== null && groupStats[idx]) { const ga = getGroupAcc(groupStats[idx], gv); if (ga) ga.nulls++; } continue; }
        if (cf.skipNeg && v < 0) { s.nulls++; if (gv !== null && groupStats[idx]) { const ga = getGroupAcc(groupStats[idx], gv); if (ga) ga.nulls++; } continue; }
      }
      welfordAdd(s, v);
      if (gv !== null && groupStats[idx]) {
        const ga = getGroupAcc(groupStats[idx], gv);
        if (ga) welfordAdd(ga, v);
      }
    }
    for (const idx of calcolCatCols) {
      const cm = calcolMeta[idx - nCols];
      const v = row[cm.name];
      if (v === null || v === undefined || v === '') continue;
      const sv = String(v);
      const counts = catCounts[idx];
      if (counts._overflow) continue;
      counts[sv] = (counts[sv] || 0) + 1;
      if (Object.keys(counts).length > MAX_UNIQUE_CAT) counts._overflow = true;
      // Cross-tab counting
      if (gv !== null && groupCategories[idx]) {
        let gm = groupCategories[idx].get(gv);
        if (!gm) { gm = {}; groupCategories[idx].set(gv, gm); }
        gm[sv] = (gm[sv] || 0) + 1;
      }
    }
  }

  function processRowStats(fields, row) {
    const gv = groupByCol !== null ? (groupByCol >= nCols && row ? String(row[groupByColName] ?? '') : (fields[groupByCol] || '').trim().replace(/^["']|["']$/g, '')) : null;
    for (const i of numericCols) {
      const raw = (fields[i] || '').trim().replace(/^["']|["']$/g, '');
      if (NULL_SENTINELS.has(raw)) { stats[i].nulls++; if (gv !== null && groupStats[i]) { const ga = getGroupAcc(groupStats[i], gv); if (ga) ga.nulls++; } continue; }
      const v = Number(raw);
      if (!isFinite(v)) { stats[i].nulls++; if (gv !== null && groupStats[i]) { const ga = getGroupAcc(groupStats[i], gv); if (ga) ga.nulls++; } continue; }
      const s = stats[i];
      // Per-column value filters
      const cf = colFilters ? colFilters[i] : null;
      if (cf) {
        if (cf.skipZeros && v === 0) { s.nulls++; if (gv !== null && groupStats[i]) { const ga = getGroupAcc(groupStats[i], gv); if (ga) ga.nulls++; } continue; }
        if (cf.skipNeg && v < 0) { s.nulls++; if (gv !== null && groupStats[i]) { const ga = getGroupAcc(groupStats[i], gv); if (ga) ga.nulls++; } continue; }
      }
      welfordAdd(s, v);
      if (gv !== null && groupStats[i]) {
        const ga = getGroupAcc(groupStats[i], gv);
        if (ga) welfordAdd(ga, v);
      }
    }
    for (const i of catCols) {
      const v = (fields[i] || '').trim().replace(/^["']|["']$/g, '');
      if (!v) continue;
      const cc = catCounts[i];
      if (cc._overflow) continue;
      cc[v] = (cc[v] || 0) + 1;
      if (Object.keys(cc).length > MAX_UNIQUE_CAT) cc._overflow = true;
      // Cross-tab counting
      if (gv !== null && groupCategories[i]) {
        let gm = groupCategories[i].get(gv);
        if (!gm) { gm = {}; groupCategories[i].set(gv, gm); }
        gm[v] = (gm[v] || 0) + 1;
      }
    }
  }

  function processRowGeometry(fields) {
    if (!hasXYZ) return;
    for (const axis of ['x', 'y', 'z']) {
      const raw = (fields[xyzGuess[axis]] || '').trim();
      const v = Number(raw);
      if (isFinite(v)) {
        xyzSets[axis].add(v);
        if (precisionSampleCount < PRECISION_SAMPLE) {
          const dotIdx = raw.indexOf('.');
          if (dotIdx >= 0) {
            const dp = raw.length - dotIdx - 1;
            if (dp > maxDecimals[axis]) maxDecimals[axis] = dp;
          }
        }
        if (orderSampleCount < ORDER_SAMPLE) {
          if (prevCoord[axis] !== null && v !== prevCoord[axis]) transitions[axis]++;
          prevCoord[axis] = v;
        }
      }
    }
    // Collect DXYZ dimension values
    if (hasDXYZ) {
      for (const [dAxis, coordAxis] of [['dx','x'],['dy','y'],['dz','z']]) {
        if (dxyzGuess[dAxis] >= 0) {
          const raw = (fields[dxyzGuess[dAxis]] || '').trim();
          const v = Number(raw);
          if (isFinite(v) && v > 0) dxyzSets[dAxis].push(v);
        }
      }
    }
    if (orderSampleCount < ORDER_SAMPLE) orderSampleCount++;
    if (precisionSampleCount < PRECISION_SAMPLE) precisionSampleCount++;
  }

  // ── Single-pass stream ──
  const stream = csvFile.stream().pipeThrough(new TextDecoderStream());
  const reader = stream.getReader();
  let buffer = '', isFirstLine = true, rowCount = 0, totalRowCount = 0, totalChars = 0, commentCount = 0;
  let lastProgress = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalChars += value.length;
    buffer += value;

    const parts = buffer.split('\n');
    buffer = parts.pop();

    for (const raw of parts) {
      const line = raw.replace(/\r$/, '');
      if (line.startsWith('#')) { commentCount++; continue; }
      if (isFirstLine) { isFirstLine = false; continue; }
      if (!line) continue;

      const fields = line.split(delimiter);

      // Geometry — always, unfiltered
      processRowGeometry(fields);

      totalRowCount++;

      // ── Type detection phase ──
      if (!typesResolved) {
        detectRowCount++;
        for (let col = 0; col < nCols && col < fields.length; col++) {
          if (forced.has(col)) continue;
          const v = (fields[col] || '').trim().replace(/^["']|["']$/g, '');
          if (NULL_SENTINELS.has(v)) continue;
          if (!isNaN(Number(v))) detect_num[col]++;
          else detect_nonNum[col]++;
        }
        if (checkAllResolved() || detectRowCount >= TYPE_MAX_ROWS) {
          typesResolved = true;
          colTypes = resolveTypes();
          initStatsPhase();
        }
        continue; // skip stats during detection — negligible row loss
      }

      // ── Stats phase (filter + accumulate) ──
      const hasCalcols = calcolFn !== null;
      const needsRow = hasCalcols || filterFn || (groupByCol !== null && groupByCol >= nCols);
      let row = null;
      if (needsRow) row = buildRow(fields);
      if (filterFn) {
        if (!filterFn(row)) continue;
      }
      rowCount++;
      processRowStats(fields, row);
      if (hasCalcols) processCalcolStats(row);

      // Progress
      if (totalRowCount - lastProgress >= 25000) {
        lastProgress = totalRowCount;
        self.postMessage({ type: 'progress', percent: (totalChars / csvFile.size) * 100, rowCount: totalRowCount });
      }
    }
  }

  // Process last buffer line
  if (buffer) {
    const line = buffer.replace(/\r$/, '');
    if (line && !line.startsWith('#') && !isFirstLine) {
      const fields = line.split(delimiter);
      processRowGeometry(fields);
      totalRowCount++;
      if (!typesResolved) {
        for (let col = 0; col < nCols && col < fields.length; col++) {
          if (forced.has(col)) continue;
          const v = (fields[col] || '').trim().replace(/^["']|["']$/g, '');
          if (NULL_SENTINELS.has(v)) continue;
          if (!isNaN(Number(v))) detect_num[col]++;
          else detect_nonNum[col]++;
        }
        typesResolved = true;
        colTypes = resolveTypes();
        initStatsPhase();
      } else {
        const hasCalcols2 = calcolFn !== null;
        const needsRow2 = hasCalcols2 || filterFn || (groupByCol !== null && groupByCol >= nCols);
        let row2 = null;
        if (needsRow2) row2 = buildRow(fields);
        let passFilter = true;
        if (filterFn) passFilter = filterFn(row2);
        if (passFilter) {
          rowCount++;
          processRowStats(fields, row2);
          if (hasCalcols2) processCalcolStats(row2);
        }
      }
    }
  }

  // Edge case: file was so small that detection never triggered
  if (!typesResolved) {
    typesResolved = true;
    colTypes = resolveTypes();
    initStatsPhase();
  }

  // Finalize stats
  const finalStats = {};
  const allNumCols = [...numericCols, ...calcolNumCols];
  for (const i of allNumCols) {
    finalStats[i] = finalizeAcc(stats[i]);
  }

  // Finalize group stats
  const finalGroupStats = {};
  const finalGroupCategories = {};
  if (groupByCol !== null) {
    for (const i of allNumCols) {
      if (!groupStats[i]) continue;
      const gMap = {};
      for (const [gv, acc] of groupStats[i]) {
        gMap[gv] = finalizeAcc(acc);
      }
      finalGroupStats[i] = gMap;
    }
    const gcCatCols = [...catCols, ...calcolCatCols];
    for (const i of gcCatCols) {
      if (!groupCategories[i]) continue;
      const gMap = {};
      for (const [gv, counts] of groupCategories[i]) {
        gMap[gv] = counts;
      }
      finalGroupCategories[i] = gMap;
    }
  }

  // Geometry
  // Build dims from DXYZ columns if available
  const dimsForGeometry = hasDXYZ ? {
    x: dxyzSets.dx.length > 0 ? dxyzSets.dx : null,
    y: dxyzSets.dy.length > 0 ? dxyzSets.dy : null,
    z: dxyzSets.dz.length > 0 ? dxyzSets.dz : null
  } : null;

  const geometry = hasXYZ ? computeGeometry(
    Array.from(xyzSets.x), Array.from(xyzSets.y), Array.from(xyzSets.z), maxDecimals, dimsForGeometry
  ) : null;

  // Coordinate ordering (most transitions = fastest varying = innermost loop)
  let coordOrder = null;
  if (hasXYZ && orderSampleCount > 10) {
    const axes = ['x', 'y', 'z'];
    const sorted = axes.slice().sort((a, b) => transitions[b] - transitions[a]);
    coordOrder = {
      fastest: sorted[0].toUpperCase(),
      middle: sorted[1].toUpperCase(),
      slowest: sorted[2].toUpperCase(),
      transitions: { x: transitions.x, y: transitions.y, z: transitions.z },
      sampleSize: orderSampleCount
    };
  }

  // Clean category counts
  const finalCats = {};
  const allCatCols = [...catCols, ...calcolCatCols];
  for (const i of allCatCols) {
    const cc = { ...catCounts[i] };
    const overflow = cc._overflow;
    delete cc._overflow;
    finalCats[i] = { counts: cc, overflow: !!overflow };
  }

  // Build extended header/types for complete message
  const extHeaderFinal = [...header];
  const extTypesFinal = [...colTypes];
  if (calcolMeta) {
    for (const cm of calcolMeta) {
      extHeaderFinal.push(cm.name);
      extTypesFinal.push(cm.type);
    }
  }

  const elapsed = performance.now() - startTime;

  self.postMessage({
    type: 'complete',
    stats: finalStats,
    geometry,
    coordOrder,
    maxDecimals,
    categories: finalCats,
    rowCount,
    totalRowCount,
    commentCount,
    elapsed,
    rowVarName,
    header: extHeaderFinal,
    colTypes: extTypesFinal,
    xyzGuess,
    zipName,
    calcolCount: calcolMeta ? calcolMeta.length : 0,
    origColCount: nCols,
    groupStats: groupByCol !== null ? finalGroupStats : null,
    groupCategories: groupByCol !== null ? finalGroupCategories : null,
    groupBy: groupByCol,
    dxyzGuess
  });
}

async function exportCSV(data) {
  const { file, filter, zipEntry, calcolCode, calcolMeta, resolvedTypes, exportCols } = data;
  const outDelim = data.delimiter || ',';
  const includeHeader = data.includeHeader !== false;
  const commentLines = data.commentLines || null;
  const quoteChar = data.quoteChar !== undefined ? data.quoteChar : '"';
  const lineEnding = data.lineEnding || '\n';
  const nullValue = data.nullValue !== undefined ? data.nullValue : '';
  const precision = data.precision !== undefined ? data.precision : null;
  const decimalSep = data.decimalSep || '.';
  const startTime = performance.now();

  let csvFile = file;
  if (isZipFile(file)) {
    try { csvFile = await extractCSVFromZip(file, zipEntry); }
    catch(e) { self.postMessage({ type: 'error', message: e.message }); return; }
  }

  const sampleLines = await readSample(csvFile, 50);
  if (sampleLines.length < 2) {
    self.postMessage({ type: 'error', message: 'File appears empty or has no data rows.' });
    return;
  }

  const delimiter = detectDelimiter(sampleLines.slice(0, 20));
  const header = sampleLines[0].split(delimiter).map(h => h.trim().replace(/^["']|["']$/g, ''));
  const nCols = header.length;

  let rowVarName = 'r';
  const colSet = new Set(header);
  for (const candidate of ['r', 'd', 'row', '_r', '_d']) {
    if (!colSet.has(candidate)) { rowVarName = candidate; break; }
  }

  const colTypes = resolvedTypes;

  // Compile calcol code block
  let calcolFn = null;
  if (calcolCode && calcolMeta && calcolMeta.length > 0) {
    try { calcolFn = new Function(rowVarName, MATH_PREAMBLE + calcolCode); }
    catch(e) { calcolFn = null; }
  }

  // Compile filter
  let filterFn = null;
  const filterExpr = filter ? filter.expression : null;
  if (filterExpr) {
    try {
      filterFn = new Function(rowVarName, MATH_PREAMBLE + 'try { return !!(' + filterExpr + '); } catch(e) { return false; }');
    } catch(e) {
      self.postMessage({ type: 'error', message: 'Filter expression error: ' + e.message });
      return;
    }
  }

  // Precompute escaped quoteChar regex
  var qcEscRe = null;
  if (quoteChar) {
    qcEscRe = new RegExp(quoteChar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  }

  function buildRow(fields) {
    const obj = {};
    for (let i = 0; i < nCols; i++) {
      const raw = (fields[i] || '').trim().replace(/^["']|["']$/g, '');
      obj[header[i]] = colTypes[i] === 'numeric' ? (NULL_SENTINELS.has(raw) ? NaN : (isNaN(Number(raw)) ? raw : Number(raw))) : raw;
    }
    if (calcolFn) { obj.META = { cat: [], num: [] }; try { calcolFn(obj); } catch(e) { /* skip */ } delete obj.META; }
    return obj;
  }

  function csvEscape(v) {
    if (v === null || v === undefined || (typeof v === 'number' && !isFinite(v))) return nullValue;
    var s;
    if (typeof v === 'number') {
      s = precision !== null ? v.toFixed(precision) : String(v);
      if (decimalSep !== '.') s = s.replace('.', decimalSep);
    } else {
      s = String(v);
    }
    if (quoteChar && (s.indexOf(outDelim) >= 0 || s.indexOf(quoteChar) >= 0 || s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0)) {
      return quoteChar + s.replace(qcEscRe, quoteChar + quoteChar) + quoteChar;
    }
    return s;
  }

  // Comment header lines
  if (commentLines && commentLines.length > 0) {
    const commentBlock = commentLines.map(function(l) { return '# ' + l; }).join(lineEnding) + lineEnding;
    self.postMessage({ type: 'export-chunk', csv: commentBlock });
  }

  // CSV header row
  if (includeHeader) {
    const headerLine = exportCols.map(function(c) { return csvEscape(c.outputName); }).join(outDelim) + lineEnding;
    self.postMessage({ type: 'export-chunk', csv: headerLine });
  }

  const stream = csvFile.stream().pipeThrough(new TextDecoderStream());
  const reader = stream.getReader();
  let buffer = '', isFirstLine = true, rowCount = 0, totalChars = 0;
  let lastProgress = 0;
  let chunkLines = [];
  const CHUNK_SIZE = 5000;

  function flushChunk() {
    if (chunkLines.length === 0) return;
    self.postMessage({ type: 'export-chunk', csv: chunkLines.join('') });
    chunkLines = [];
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalChars += value.length;
    buffer += value;

    const parts = buffer.split('\n');
    buffer = parts.pop();

    for (const raw of parts) {
      const line = raw.replace(/\r$/, '');
      if (line.startsWith('#')) continue;
      if (isFirstLine) { isFirstLine = false; continue; }
      if (!line) continue;

      const fields = line.split(delimiter);
      const row = buildRow(fields);
      if (filterFn && !filterFn(row)) continue;

      rowCount++;
      const csvLine = exportCols.map(c => csvEscape(row[c.name])).join(outDelim) + lineEnding;
      chunkLines.push(csvLine);

      if (chunkLines.length >= CHUNK_SIZE) {
        flushChunk();
        self.postMessage({ type: 'export-progress', percent: (totalChars / csvFile.size) * 100, rowCount });
      }
    }
  }

  // Last buffer line
  if (buffer) {
    const line = buffer.replace(/\r$/, '');
    if (line && !line.startsWith('#') && !isFirstLine) {
      const fields = line.split(delimiter);
      const row = buildRow(fields);
      if (!filterFn || filterFn(row)) {
        rowCount++;
        chunkLines.push(exportCols.map(c => csvEscape(row[c.name])).join(outDelim) + lineEnding);
      }
    }
  }
  flushChunk();

  const elapsed = performance.now() - startTime;
  self.postMessage({ type: 'export-complete', rowCount, elapsed });
}

async function swathAnalysis(data) {
  const { file, zipEntry, globalFilter, localFilter, calcolCode, calcolMeta, resolvedTypes,
          xyzCols, dxyzCols, axis, varCols, binWidth } = data;
  const startTime = performance.now();

  let csvFile = file;
  if (isZipFile(file)) {
    try { csvFile = await extractCSVFromZip(file, zipEntry); }
    catch(e) { self.postMessage({ type: 'error', message: e.message }); return; }
  }

  const sampleLines = await readSample(csvFile, 50);
  if (sampleLines.length < 2) { self.postMessage({ type: 'error', message: 'File appears empty.' }); return; }

  const delimiter = detectDelimiter(sampleLines.slice(0, 20));
  const header = sampleLines[0].split(delimiter).map(h => h.trim().replace(/^["']|["']$/g, ''));
  const nCols = header.length;
  let rowVarName = 'r';
  const colSet = new Set(header);
  for (const c of ['r','d','row','_r','_d']) { if (!colSet.has(c)) { rowVarName = c; break; } }

  const colTypes = resolvedTypes;

  let calcolFn = null;
  if (calcolCode && calcolMeta && calcolMeta.length > 0) {
    try { calcolFn = new Function(rowVarName, MATH_PREAMBLE + calcolCode); }
    catch(e) { calcolFn = null; }
  }

  let globalFn = null, localFn = null;
  if (globalFilter) {
    try { globalFn = new Function(rowVarName, MATH_PREAMBLE + 'try { return !!(' + globalFilter.expression + '); } catch(e) { return false; }'); }
    catch(e) { self.postMessage({ type: 'error', message: 'Global filter error: ' + e.message }); return; }
  }
  if (localFilter) {
    try { localFn = new Function(rowVarName, MATH_PREAMBLE + 'try { return !!(' + localFilter + '); } catch(e) { return false; }'); }
    catch(e) { self.postMessage({ type: 'error', message: 'Local filter error: ' + e.message }); return; }
  }

  function buildRow(fields) {
    const obj = {};
    for (let i = 0; i < nCols; i++) {
      const raw = (fields[i] || '').trim().replace(/^["']|["']$/g, '');
      obj[header[i]] = colTypes[i] === 'numeric' ? (NULL_SENTINELS.has(raw) ? NaN : (isNaN(Number(raw)) ? raw : Number(raw))) : raw;
    }
    if (calcolFn) { obj.META = { cat: [], num: [] }; try { calcolFn(obj); } catch(e) { /* skip */ } delete obj.META; }
    return obj;
  }

  const axisIdx = xyzCols[axis];
  const axisName = header[axisIdx];

  // Resolve variable column names
  const varNames = varCols.map(vi => header[vi]);

  // Per-variable bins: Map<binIdx, {vars: {varIdx: {count,sum,sumSq,td}}, center}>
  const bins = new Map();

  function getBin(coord) {
    const idx = Math.floor(coord / binWidth);
    let b = bins.get(idx);
    if (!b) {
      b = { center: (idx + 0.5) * binWidth, vars: {} };
      for (const vi of varCols) {
        b.vars[vi] = { count: 0, sum: 0, sumSq: 0, td: newTDigest() };
      }
      bins.set(idx, b);
    }
    return b;
  }

  function processRow(row) {
    const coord = row[axisName];
    if (coord == null || isNaN(coord)) return;
    const bin = getBin(coord);
    for (let vi = 0; vi < varCols.length; vi++) {
      const val = row[varNames[vi]];
      if (val == null || typeof val !== 'number' || isNaN(val)) continue;
      const vb = bin.vars[varCols[vi]];
      vb.count++;
      vb.sum += val;
      vb.sumSq += val * val;
      tdAdd(vb.td, val);
    }
  }

  const stream = csvFile.stream().pipeThrough(new TextDecoderStream());
  const reader = stream.getReader();
  let buffer = '', isFirstLine = true, totalChars = 0, lastProgress = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalChars += value.length;
    buffer += value;
    const parts = buffer.split('\n');
    buffer = parts.pop();

    for (const raw of parts) {
      const line = raw.replace(/\r$/, '');
      if (line.startsWith('#')) continue;
      if (isFirstLine) { isFirstLine = false; continue; }
      if (!line) continue;

      const fields = line.split(delimiter);
      const row = buildRow(fields);
      if (globalFn && !globalFn(row)) continue;
      if (localFn && !localFn(row)) continue;
      processRow(row);

      if (totalChars - lastProgress >= 500000) {
        lastProgress = totalChars;
        self.postMessage({ type: 'swath-progress', percent: (totalChars / csvFile.size) * 100 });
      }
    }
  }
  if (buffer) {
    const line = buffer.replace(/\r$/, '');
    if (line && !line.startsWith('#') && !isFirstLine) {
      const fields = line.split(delimiter);
      const row = buildRow(fields);
      if ((!globalFn || globalFn(row)) && (!localFn || localFn(row))) {
        processRow(row);
      }
    }
  }

  // Finalize: produce per-variable bin arrays
  const vars = {};
  for (const vi of varCols) {
    const arr = [];
    for (const [, b] of bins) {
      const vb = b.vars[vi];
      if (vb.count === 0) continue;
      tdFlush(vb.td);
      const mean = vb.sum / vb.count;
      const variance = vb.count > 1 ? (vb.sumSq - vb.sum * vb.sum / vb.count) / (vb.count - 1) : 0;
      arr.push({
        center: b.center, count: vb.count, mean,
        std: Math.sqrt(Math.max(0, variance)),
        centroids: vb.td.centroids.map(c => [c.mean, c.count])
      });
    }
    arr.sort((a, b) => a.center - b.center);
    vars[vi] = arr;
  }

  const elapsed = performance.now() - startTime;
  self.postMessage({ type: 'swath-complete', vars, elapsed, axis });
}

async function sectionAnalysis(data) {
  const { file, zipEntry, globalFilter, localFilter, calcolCode, calcolMeta, resolvedTypes,
          xyzCols, dxyzCols, normalAxis, slicePos, tolerance, varCol } = data;
  const startTime = performance.now();

  let csvFile = file;
  if (isZipFile(file)) {
    try { csvFile = await extractCSVFromZip(file, zipEntry); }
    catch(e) { self.postMessage({ type: 'error', message: e.message }); return; }
  }

  const sampleLines = await readSample(csvFile, 50);
  if (sampleLines.length < 2) { self.postMessage({ type: 'error', message: 'File appears empty.' }); return; }

  const delimiter = detectDelimiter(sampleLines.slice(0, 20));
  const header = sampleLines[0].split(delimiter).map(h => h.trim().replace(/^["']|["']$/g, ''));
  const nCols = header.length;
  let rowVarName = 'r';
  const colSet = new Set(header);
  for (const c of ['r','d','row','_r','_d']) { if (!colSet.has(c)) { rowVarName = c; break; } }

  const colTypes = resolvedTypes;

  let calcolFn = null;
  if (calcolCode && calcolMeta && calcolMeta.length > 0) {
    try { calcolFn = new Function(rowVarName, MATH_PREAMBLE + calcolCode); }
    catch(e) { calcolFn = null; }
  }

  let globalFn = null, localFn = null;
  if (globalFilter) {
    try { globalFn = new Function(rowVarName, MATH_PREAMBLE + 'try { return !!(' + globalFilter.expression + '); } catch(e) { return false; }'); }
    catch(e) { self.postMessage({ type: 'error', message: 'Global filter error: ' + e.message }); return; }
  }
  if (localFilter) {
    try { localFn = new Function(rowVarName, MATH_PREAMBLE + 'try { return !!(' + localFilter + '); } catch(e) { return false; }'); }
    catch(e) { self.postMessage({ type: 'error', message: 'Local filter error: ' + e.message }); return; }
  }

  function buildRow(fields) {
    const obj = {};
    for (let i = 0; i < nCols; i++) {
      const raw = (fields[i] || '').trim().replace(/^["']|["']$/g, '');
      obj[header[i]] = colTypes[i] === 'numeric' ? (NULL_SENTINELS.has(raw) ? NaN : (isNaN(Number(raw)) ? raw : Number(raw))) : raw;
    }
    if (calcolFn) { obj.META = { cat: [], num: [] }; try { calcolFn(obj); } catch(e) { /* skip */ } delete obj.META; }
    return obj;
  }

  // Map normalAxis from int (0/1/2) to string key
  const axisKeys = ['x','y','z'];
  const normalAxisKey = axisKeys[normalAxis];
  const aToI = {x:0, y:1, z:2};

  // Determine axes: normal vs h vs v
  const axisMap = {
    z: { h: 'x', v: 'y' },  // plan view
    x: { h: 'y', v: 'z' },  // east section
    y: { h: 'x', v: 'z' }   // north section
  };
  const { h: hAxis, v: vAxis } = axisMap[normalAxisKey];
  const normalIdx = xyzCols[aToI[normalAxisKey]];
  const hIdx = xyzCols[aToI[hAxis]];
  const vIdx = xyzCols[aToI[vAxis]];
  const normalName = header[normalIdx];
  const hName = header[hIdx];
  const vName = header[vIdx];

  // Variable column name
  const varName = header[varCol];

  // DXYZ column names (may be -1 if not assigned)
  const dhIdx = dxyzCols ? dxyzCols[aToI[hAxis]] : -1;
  const dvIdx = dxyzCols ? dxyzCols[aToI[vAxis]] : -1;
  const dhName = dhIdx >= 0 ? header[dhIdx] : null;
  const dvName = dvIdx >= 0 ? header[dvIdx] : null;

  const halfTol = tolerance / 2;
  const blocks = [];

  const stream = csvFile.stream().pipeThrough(new TextDecoderStream());
  const reader = stream.getReader();
  let buf = '', isFirstLine = true, totalChars = 0, lastProgress = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalChars += value.length;
    buf += value;
    const parts = buf.split('\n');
    buf = parts.pop();

    for (const raw of parts) {
      const line = raw.replace(/\r$/, '');
      if (line.startsWith('#')) continue;
      if (isFirstLine) { isFirstLine = false; continue; }
      if (!line) continue;

      const fields = line.split(delimiter);
      const row = buildRow(fields);
      if (globalFn && !globalFn(row)) continue;
      if (localFn && !localFn(row)) continue;

      const nv = row[normalName];
      if (nv == null || isNaN(nv)) continue;
      if (nv < slicePos - halfTol || nv > slicePos + halfTol) continue;

      const h = row[hName];
      const v = row[vName];
      if (h == null || !isFinite(h) || v == null || !isFinite(v)) continue;

      const val = row[varName];
      const dh = dhName ? row[dhName] : 0;
      const dv = dvName ? row[dvName] : 0;

      blocks.push({
        h, v,
        dh: (typeof dh === 'number' && !isNaN(dh)) ? dh : 0,
        dv: (typeof dv === 'number' && !isNaN(dv)) ? dv : 0,
        val: (typeof val === 'number' && !isNaN(val)) ? val : null
      });

      if (totalChars - lastProgress >= 500000) {
        lastProgress = totalChars;
        self.postMessage({ type: 'section-progress', percent: (totalChars / csvFile.size) * 100 });
      }
    }
  }
  // Last buffer line
  if (buf) {
    const line = buf.replace(/\r$/, '');
    if (line && !line.startsWith('#') && !isFirstLine) {
      const fields = line.split(delimiter);
      const row = buildRow(fields);
      if ((!globalFn || globalFn(row)) && (!localFn || localFn(row))) {
        const nv = row[normalName];
        if (nv != null && !isNaN(nv) && nv >= slicePos - halfTol && nv <= slicePos + halfTol) {
          const h = row[hName]; const v = row[vName];
          if (h != null && isFinite(h) && v != null && isFinite(v)) {
            const val = row[varName];
            const dh = dhName ? row[dhName] : 0;
            const dv = dvName ? row[dvName] : 0;
            blocks.push({
              h, v,
              dh: (typeof dh === 'number' && !isNaN(dh)) ? dh : 0,
              dv: (typeof dv === 'number' && !isNaN(dv)) ? dv : 0,
              val: (typeof val === 'number' && !isNaN(val)) ? val : null
            });
          }
        }
      }
    }
  }

  const elapsed = performance.now() - startTime;
  self.postMessage({
    type: 'section-complete',
    blocks,
    hAxis, vAxis, normalAxis, slicePos,
    blockCount: blocks.length,
    elapsed
  });
}

async function gtAnalysis(data) {
  var startTime = performance.now();
  var file = data.file, zipEntry = data.zipEntry, globalFilter = data.globalFilter,
      localFilter = data.localFilter, calcolCode = data.calcolCode, calcolMeta = data.calcolMeta,
      resolvedTypes = data.resolvedTypes,
      densityCol = data.densityCol, weightCol = data.weightCol,
      dxyzCols = data.dxyzCols, blockVolume = data.blockVolume,
      groupByCol = data.groupByCol != null ? data.groupByCol : null;

  // Multi-grade: gradeCols + gradeRanges arrays
  var gradeCols = data.gradeCols;
  var gradeRanges = data.gradeRanges;

  var csvFile = file;
  if (isZipFile(file)) {
    try { csvFile = await extractCSVFromZip(file, zipEntry); }
    catch(e) { self.postMessage({ type: 'error', message: e.message }); return; }
  }

  var sampleLines = await readSample(csvFile, 50);
  if (sampleLines.length < 2) { self.postMessage({ type: 'error', message: 'File appears empty.' }); return; }

  var delimiter = detectDelimiter(sampleLines.slice(0, 20));
  var header = sampleLines[0].split(delimiter).map(function(h) { return h.trim().replace(/^["']|["']$/g, ''); });
  var nCols = header.length;
  var rowVarName = 'r';
  var colSet = new Set(header);
  for (var ci = 0; ci < ['r','d','row','_r','_d'].length; ci++) {
    var cand = ['r','d','row','_r','_d'][ci];
    if (!colSet.has(cand)) { rowVarName = cand; break; }
  }

  var colTypes = resolvedTypes;

  var calcolFn = null;
  if (calcolCode && calcolMeta && calcolMeta.length > 0) {
    try { calcolFn = new Function(rowVarName, MATH_PREAMBLE + calcolCode); }
    catch(e) { calcolFn = null; }
  }

  var globalFn = null, localFn = null;
  if (globalFilter) {
    try { globalFn = new Function(rowVarName, MATH_PREAMBLE + 'try { return !!(' + globalFilter.expression + '); } catch(e) { return false; }'); }
    catch(e) { self.postMessage({ type: 'error', message: 'Global filter error: ' + e.message }); return; }
  }
  if (localFilter) {
    try { localFn = new Function(rowVarName, MATH_PREAMBLE + 'try { return !!(' + localFilter + '); } catch(e) { return false; }'); }
    catch(e) { self.postMessage({ type: 'error', message: 'Local filter error: ' + e.message }); return; }
  }

  function buildRow(fields) {
    var obj = {};
    for (var i = 0; i < nCols; i++) {
      var raw = (fields[i] || '').trim().replace(/^["']|["']$/g, '');
      obj[header[i]] = colTypes[i] === 'numeric' ? (NULL_SENTINELS.has(raw) ? NaN : (isNaN(Number(raw)) ? raw : Number(raw))) : raw;
    }
    if (calcolFn) { obj.META = { cat: [], num: [] }; try { calcolFn(obj); } catch(e) {} delete obj.META; }
    return obj;
  }

  // Resolve column names
  function resolveColName(idx) {
    if (idx >= nCols && calcolMeta) return calcolMeta[idx - nCols].name;
    return header[idx];
  }

  var densityColName = densityCol != null && densityCol >= 0 ? resolveColName(densityCol) : null;
  var weightColName = weightCol != null && weightCol >= 0 ? resolveColName(weightCol) : null;
  var dxyzNames = dxyzCols ? [header[dxyzCols[0]], header[dxyzCols[1]], header[dxyzCols[2]]] : null;

  // Resolve group-by column name
  var groupByColName = groupByCol !== null ? resolveColName(groupByCol) : null;
  var GT_MAX_GROUPS = 200;

  // Per-grade-variable bin arrays
  var N_BINS = 10000;
  var gradeInfo = [];
  for (var gi = 0; gi < gradeCols.length; gi++) {
    var gc = gradeCols[gi];
    var gr = gradeRanges[gi];
    var colName = resolveColName(gc);
    var bw = (gr.max - gr.min) / N_BINS;
    gradeInfo.push({
      colIdx: gc,
      colName: colName,
      gradeMin: gr.min,
      gradeMax: gr.max,
      binWidth: bw,
      groups: {} // groupVal -> { tonnageBins, metalBins }
    });
    // Create default (ungrouped) bins
    gradeInfo[gi].groups['__all__'] = {
      tonnageBins: new Float64Array(N_BINS),
      metalBins: new Float64Array(N_BINS)
    };
  }

  function getGroupBins(gInfo, gv) {
    var bins = gInfo.groups[gv];
    if (bins) return bins;
    if (Object.keys(gInfo.groups).length >= GT_MAX_GROUPS + 1) return null; // +1 for __all__
    bins = { tonnageBins: new Float64Array(N_BINS), metalBins: new Float64Array(N_BINS) };
    gInfo.groups[gv] = bins;
    return bins;
  }

  function processRowGt(row, tonnage) {
    var gv = groupByColName ? String(row[groupByColName] || '') : null;
    for (var gi = 0; gi < gradeInfo.length; gi++) {
      var info = gradeInfo[gi];
      var grade = row[info.colName];
      if (grade == null || typeof grade !== 'number' || !isFinite(grade)) continue;
      var metal = grade * tonnage;
      var binIdx = Math.floor((grade - info.gradeMin) / info.binWidth);
      if (binIdx < 0) binIdx = 0;
      if (binIdx >= N_BINS) binIdx = N_BINS - 1;
      // Always accumulate into __all__
      info.groups['__all__'].tonnageBins[binIdx] += tonnage;
      info.groups['__all__'].metalBins[binIdx] += metal;
      // Group bins
      if (gv !== null) {
        var gb = getGroupBins(info, gv);
        if (gb) {
          gb.tonnageBins[binIdx] += tonnage;
          gb.metalBins[binIdx] += metal;
        }
      }
    }
  }

  var stream = csvFile.stream().pipeThrough(new TextDecoderStream());
  var reader = stream.getReader();
  var buffer = '', isFirstLine = true, totalChars = 0, lastProgress = 0;

  while (true) {
    var res = await reader.read();
    if (res.done) break;
    totalChars += res.value.length;
    buffer += res.value;
    var parts = buffer.split('\n');
    buffer = parts.pop();

    for (var pi = 0; pi < parts.length; pi++) {
      var line = parts[pi].replace(/\r$/, '');
      if (line.startsWith('#')) continue;
      if (isFirstLine) { isFirstLine = false; continue; }
      if (!line) continue;

      var fields = line.split(delimiter);
      var row = buildRow(fields);
      if (globalFn && !globalFn(row)) continue;
      if (localFn && !localFn(row)) continue;

      // Compute tonnage for this block
      var volume = 1;
      if (dxyzNames) {
        var dx = row[dxyzNames[0]], dy = row[dxyzNames[1]], dz = row[dxyzNames[2]];
        if (typeof dx === 'number' && typeof dy === 'number' && typeof dz === 'number' && isFinite(dx) && isFinite(dy) && isFinite(dz)) {
          volume = Math.abs(dx) * Math.abs(dy) * Math.abs(dz);
        }
      } else if (blockVolume > 0) {
        volume = blockVolume;
      }
      var density = 1;
      if (densityColName) {
        var dv = row[densityColName];
        if (typeof dv === 'number' && isFinite(dv) && dv > 0) density = dv;
      }
      var weight = 1;
      if (weightColName) {
        var wv = row[weightColName];
        if (typeof wv === 'number' && isFinite(wv) && wv > 0) weight = wv;
      }
      var tonnage = volume * density * weight;
      processRowGt(row, tonnage);

      if (totalChars - lastProgress >= 500000) {
        lastProgress = totalChars;
        self.postMessage({ type: 'gt-progress', percent: (totalChars / csvFile.size) * 100 });
      }
    }
  }
  // Last buffer line
  if (buffer) {
    var lastLine = buffer.replace(/\r$/, '');
    if (lastLine && !lastLine.startsWith('#') && !isFirstLine) {
      var lastFields = lastLine.split(delimiter);
      var lastRow = buildRow(lastFields);
      if ((!globalFn || globalFn(lastRow)) && (!localFn || localFn(lastRow))) {
        var lVol = 1;
        if (dxyzNames) {
          var ldx = lastRow[dxyzNames[0]], ldy = lastRow[dxyzNames[1]], ldz = lastRow[dxyzNames[2]];
          if (typeof ldx === 'number' && typeof ldy === 'number' && typeof ldz === 'number' && isFinite(ldx) && isFinite(ldy) && isFinite(ldz)) {
            lVol = Math.abs(ldx) * Math.abs(ldy) * Math.abs(ldz);
          }
        } else if (blockVolume > 0) {
          lVol = blockVolume;
        }
        var lDen = 1;
        if (densityColName) { var ldv = lastRow[densityColName]; if (typeof ldv === 'number' && isFinite(ldv) && ldv > 0) lDen = ldv; }
        var lWt = 1;
        if (weightColName) { var lwv = lastRow[weightColName]; if (typeof lwv === 'number' && isFinite(lwv) && lwv > 0) lWt = lwv; }
        var lTon = lVol * lDen * lWt;
        processRowGt(lastRow, lTon);
      }
    }
  }

  // Post-process: cumulative sums for each grade variable and group
  function buildResults(tonnageBins, metalBins, gradeMin, binWidth) {
    var cumTonnage = new Float64Array(N_BINS);
    var cumMetal = new Float64Array(N_BINS);
    cumTonnage[N_BINS - 1] = tonnageBins[N_BINS - 1];
    cumMetal[N_BINS - 1] = metalBins[N_BINS - 1];
    for (var i = N_BINS - 2; i >= 0; i--) {
      cumTonnage[i] = cumTonnage[i + 1] + tonnageBins[i];
      cumMetal[i] = cumMetal[i + 1] + metalBins[i];
    }
    var totalTonnage = cumTonnage[0];
    var results = [];
    for (var j = 0; j < N_BINS; j++) {
      results.push({
        cutoff: gradeMin + j * binWidth,
        tonnage: cumTonnage[j],
        grade: cumTonnage[j] > 0 ? cumMetal[j] / cumTonnage[j] : 0,
        metal: cumMetal[j]
      });
    }
    return { results: results, totalTonnage: totalTonnage };
  }

  var gradeResults = [];
  for (var gi = 0; gi < gradeInfo.length; gi++) {
    var info = gradeInfo[gi];
    var allBins = info.groups['__all__'];
    var allResult = buildResults(allBins.tonnageBins, allBins.metalBins, info.gradeMin, info.binWidth);
    var groupResults = null;
    if (groupByColName) {
      groupResults = {};
      for (var gv in info.groups) {
        if (gv === '__all__') continue;
        var gb = info.groups[gv];
        groupResults[gv] = buildResults(gb.tonnageBins, gb.metalBins, info.gradeMin, info.binWidth);
      }
    }
    gradeResults.push({
      colIdx: info.colIdx,
      colName: info.colName,
      results: allResult.results,
      totalTonnage: allResult.totalTonnage,
      gradeMin: info.gradeMin,
      gradeMax: info.gradeMax,
      binWidth: info.binWidth,
      groupResults: groupResults
    });
  }

  var elapsed = performance.now() - startTime;
  self.postMessage({
    type: 'gt-complete',
    gradeResults: gradeResults,
    grouped: groupByColName !== null,
    groupByColName: groupByColName,
    elapsed: elapsed
  });
}

self.onmessage = (e) => {
  if (e.data.mode === 'export') {
    exportCSV(e.data);
  } else if (e.data.mode === 'swath') {
    swathAnalysis(e.data);
  } else if (e.data.mode === 'section') {
    sectionAnalysis(e.data);
  } else if (e.data.mode === 'gt') {
    gtAnalysis(e.data);
  } else {
    const { file, xyzOverride, filter, typeOverrides, zipEntry, skipCols, colFilters, calcolCode, calcolMeta, groupBy, groupStatsCols, dxyzOverride } = e.data;
    analyze(file, xyzOverride, filter, typeOverrides, zipEntry, skipCols, colFilters, calcolCode, calcolMeta, groupBy, groupStatsCols, dxyzOverride);
  }
};
