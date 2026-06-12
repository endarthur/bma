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
function readUint64(buf, off) { return readUint32(buf, off) + readUint32(buf, off + 4) * 4294967296; }

// Resolve a central-directory entry's zip64 extra field (tag 0x0001):
// 8-byte values present only for fields that hit the 32-bit sentinel,
// in the order uncompSize, compSize, localOffset
function zip64Resolve(cd, pos, nameLen, extraLen, sizes) {
  if (sizes.compSize !== 0xFFFFFFFF && sizes.uncompSize !== 0xFFFFFFFF && sizes.localOffset !== 0xFFFFFFFF) return sizes;
  let ep = pos + 46 + nameLen;
  const eEnd = ep + extraLen;
  while (ep + 4 <= eEnd) {
    const tag = readUint16(cd, ep);
    const tsize = readUint16(cd, ep + 2);
    if (tag === 0x0001) {
      let fp = ep + 4;
      if (sizes.uncompSize === 0xFFFFFFFF) { sizes.uncompSize = readUint64(cd, fp); fp += 8; }
      if (sizes.compSize === 0xFFFFFFFF) { sizes.compSize = readUint64(cd, fp); fp += 8; }
      if (sizes.localOffset === 0xFFFFFFFF) { sizes.localOffset = readUint64(cd, fp); fp += 8; }
      break;
    }
    ep += 4 + tsize;
  }
  return sizes;
}

async function extractCSVFromZip(file, targetEntry) {
  self.postMessage({ type: 'progress', percent: 0, rowCount: 0, note: 'Reading ZIP headers...' });

  // Read last 64KB to find End of Central Directory
  const tailSize = Math.min(65557, file.size);
  const tailStart = file.size - tailSize;
  const tail = await readBytes(file, tailStart, tailSize);

  let eocdPos = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (readUint32(tail, i) === 0x06054b50) { eocdPos = i; break; }
  }
  if (eocdPos < 0) throw new Error('Not a valid ZIP file (EOCD not found)');

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
    const z64Offset = readUint64(tail, locPos + 8);
    const z64 = await readBytes(file, z64Offset, 56);
    if (readUint32(z64, 0) !== 0x06064b50) throw new Error('Invalid zip64 EOCD record');
    cdEntries = readUint64(z64, 32);
    cdSize = readUint64(z64, 40);
    cdOffset = readUint64(z64, 48);
  }

  // Read central directory
  const cd = await readBytes(file, cdOffset, cdSize);
  const entries = [];
  let pos = 0;
  for (let i = 0; i < cdEntries && pos < cd.length; i++) {
    if (readUint32(cd, pos) !== 0x02014b50) break;
    const method = readUint16(cd, pos + 10);
    const nameLen = readUint16(cd, pos + 28);
    const extraLen = readUint16(cd, pos + 30);
    const commentLen = readUint16(cd, pos + 32);
    const sizes = zip64Resolve(cd, pos, nameLen, extraLen, {
      compSize: readUint32(cd, pos + 20),
      uncompSize: readUint32(cd, pos + 24),
      localOffset: readUint32(cd, pos + 42)
    });
    const name = new TextDecoder().decode(cd.slice(pos + 46, pos + 46 + nameLen));
    entries.push({ name, method, compSize: sizes.compSize, uncompSize: sizes.uncompSize, localOffset: sizes.localOffset });
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
// Merging digest with the standard size bound (weight ≤ 4·n·q(1−q)/δ,
// Dunning) — the bound used before 2026-06-11 was the ABSOLUTE form
// 4·δ·q(1−q), which degraded to ~n/100 centroids on large files and made
// the digest ~77% of analyze wall-clock. Two accuracy refinements ride on
// the fix:
//  • centroids with exactly equal means always merge (lossless — quantized
//    grades collapse to one centroid per distinct value)
//  • exact phase: a digest never lossy-compresses until it holds more than
//    TD_EXACT_LIMIT distinct values, so small datasets (typical aux sample
//    sets) and low-cardinality columns report EXACT quantiles; only
//    genuinely continuous high-count columns degrade to the digest
const TD_COMPRESSION = 300;
const TD_BUFFER_SIZE = 2000;
const TD_EXACT_LIMIT = 20000;

function newTDigest() {
  return { centroids: [], buffer: [], totalCount: 0, exact: true };
}

// Weighted ingest: each buffered point is [value, weight]. Centroid counts
// are continuous quantities everywhere downstream (compress, quantile, CDF),
// so fractional weights flow through untouched. Unweighted callers omit w.
function tdAdd(td, value, w) {
  if (w === undefined) w = 1;
  td.buffer.push([value, w]);
  td.totalCount += w;
  if (td.buffer.length >= (td.exact ? TD_EXACT_LIMIT : TD_BUFFER_SIZE)) tdFlush(td);
}

function tdFlush(td) {
  if (td.buffer.length === 0) return;
  td.buffer.sort((a, b) => a[0] - b[0]);
  // Merge sorted buffer with sorted centroids
  const merged = [];
  let bi = 0, ci = 0;
  while (bi < td.buffer.length || ci < td.centroids.length) {
    if (bi < td.buffer.length && (ci >= td.centroids.length || td.buffer[bi][0] <= td.centroids[ci].mean)) {
      merged.push({ mean: td.buffer[bi][0], count: td.buffer[bi][1] });
      bi++;
    } else {
      merged.push({ mean: td.centroids[ci].mean, count: td.centroids[ci].count });
      ci++;
    }
  }
  td.buffer = [];
  if (td.exact) {
    const collapsed = tdMergeEqual(merged);
    if (collapsed.length <= TD_EXACT_LIMIT) {
      td.centroids = collapsed; // still exact: no lossy merge has happened
      return;
    }
    td.exact = false; // too many distinct values — degrade to a real digest
    td.centroids = tdCompress(collapsed, td.totalCount);
    return;
  }
  td.centroids = tdCompress(merged, td.totalCount);
}

// Lossless collapse: adjacent centroids with identical means become one
function tdMergeEqual(centroids) {
  if (centroids.length <= 1) return centroids;
  const result = [centroids[0]];
  for (let i = 1; i < centroids.length; i++) {
    const c = centroids[i];
    const last = result[result.length - 1];
    if (c.mean === last.mean) last.count += c.count;
    else result.push(c);
  }
  return result;
}

function tdCompress(centroids, totalCount) {
  if (centroids.length <= 1) return centroids;
  const result = [centroids[0]];
  let cumCount = centroids[0].count;
  for (let i = 1; i < centroids.length; i++) {
    const c = centroids[i];
    const last = result[result.length - 1];
    const q = cumCount / totalCount;
    const maxSize = Math.max(1, Math.floor(4 * totalCount * q * (1 - q) / TD_COMPRESSION));
    if (c.mean === last.mean || last.count + c.count <= maxSize) {
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

// ─── Row source: shared format-decoding pipeline ──────────────────────
// A row source owns everything between the raw File and a row object:
// container extraction (ZIP entry / Datamine .dm → CSV stream), delimiter
// and header sniffing, row-variable choice, calcol compilation, and the
// line-streaming loop with its comment/header/tail handling. Passes own
// everything after the row: filter ordering, the weight-ordinal contract,
// and their accumulators. Future binary sources (.dm direct, parquet)
// slot in behind the same surface.

function pickRowVarName(header, rowVarOverride) {
  if (rowVarOverride) return rowVarOverride;
  const colSet = new Set(header);
  for (const c of ['r', 'd', 'row', '_r', '_d']) {
    if (!colSet.has(c)) return c;
  }
  return 'r';
}

function buildExtHeader(header, calcolMeta) {
  const ext = [...header];
  if (calcolMeta) { for (const cm of calcolMeta) ext.push(cm.name); }
  return ext;
}

// Compile the calcol code block; a failed compile disables calcols silently
function compileCalcolFn(rowVarName, calcolCode, calcolMeta) {
  if (!calcolCode || !calcolMeta || calcolMeta.length === 0) return null;
  try { return new Function(rowVarName, MATH_PREAMBLE + calcolCode); }
  catch (e) { return null; }
}

// Compile a filter expression: per-row runtime errors return false but are
// COUNTED on the returned function (fn.errCount / fn.firstErr) so passes can
// report excluded rows instead of dropping them silently (A9 F3). Compile
// errors throw (callers decide whether to abort or continue).
function compileFilterFn(rowVarName, expr) {
  const raw = new Function(rowVarName, MATH_PREAMBLE + 'return !!(' + expr + ');');
  const fn = function(row) {
    try { return raw(row); }
    catch (e) {
      fn.errCount++;
      if (fn.errCount === 1) fn.firstErr = e.message;
      return false;
    }
  };
  fn.errCount = 0;
  fn.firstErr = null;
  return fn;
}

// A9 F3 payloads — null when nothing went wrong, so messages without
// problems are unchanged
function filterErrPayload(globalFn, localFn) {
  const g = globalFn ? globalFn.errCount : 0;
  const l = localFn ? localFn.errCount : 0;
  if (!g && !l) return null;
  return { global: g, local: l, message: (g ? globalFn.firstErr : localFn.firstErr) || '' };
}
function calcolErrPayload(src) {
  if (!src || !src.calcolErrCount) return null;
  return { count: src.calcolErrCount, message: src.calcolFirstErr || '' };
}

// makeRowSource(file, opts) → source. Throws on extraction/sniff failure
// (callers post {type:'error'}). opts:
//   zipEntry, dmEndianness, dmFormat — container config
//   emptyMessage — error text for an empty/headers-only file
//   rowVarOverride — caller-fixed row variable (e.g. 'aux')
//   resolvedTypes — colTypes from a prior analyze; omitted for analyze
//     itself, which assigns source.colTypes once detection resolves
//   calcolCode, calcolMeta — calcol block, compiled here
async function makeRowSource(file, opts) {
  opts = opts || {};
  let csvFile = file, zipName = null;
  if (isZipFile(file)) {
    csvFile = await extractCSVFromZip(file, opts.zipEntry);
    zipName = csvFile.name;
  } else if (isDmFile(file)) {
    csvFile = await extractCSVFromDM(file, opts.dmEndianness || 'little', opts.dmFormat || 'sp');
  }

  // Tiny sample for delimiter + header only
  const sampleLines = await readSample(csvFile, 50);
  if (sampleLines.length < 2) throw new Error(opts.emptyMessage || 'File appears empty.');
  const delimiter = detectDelimiter(sampleLines.slice(0, 20));
  const header = sampleLines[0].split(delimiter).map(h => h.trim().replace(/^["']|["']$/g, ''));
  const rowVarName = pickRowVarName(header, opts.rowVarOverride);

  const source = {
    csvFile, zipName, delimiter, header,
    nCols: header.length,
    rowVarName,
    colTypes: opts.resolvedTypes || null,
    calcolFn: compileCalcolFn(rowVarName, opts.calcolCode, opts.calcolMeta),
    extHeader: buildExtHeader(header, opts.calcolMeta),
    calcolErrCount: 0,
    calcolFirstErr: null
  };
  source.buildRow = makeBuildRow(source);
  source.stream = (handlers) => streamCsvLines(csvFile, handlers);
  source.forEachRow = (handlers) => forEachSourceRow(source, handlers);
  return source;
}

// Row objects carry named properties because filters and calcols are user
// JS (r.Fe > 30). colTypes/calcolFn are read off the source per call —
// analyze assigns colTypes mid-stream once type detection resolves.
function makeBuildRow(source) {
  const header = source.header, nCols = source.nCols;
  return function buildRow(fields) {
    const colTypes = source.colTypes;
    const obj = {};
    for (let i = 0; i < nCols; i++) {
      const raw = (fields[i] || '').trim().replace(/^["']|["']$/g, '');
      obj[header[i]] = colTypes[i] === 'numeric' ? (NULL_SENTINELS.has(raw) ? NaN : (isNaN(Number(raw)) ? raw : Number(raw))) : raw;
    }
    // Evaluate calcol code block — mutates obj, adding new properties.
    // Runtime errors skip the row's calcols but are counted on the source
    // (A9 F3) — passes report them via calcolErrPayload
    if (source.calcolFn) {
      obj.META = { cat: [], num: [] };
      try { source.calcolFn(obj); }
      catch (e) {
        source.calcolErrCount++;
        if (source.calcolErrCount === 1) source.calcolFirstErr = e.message;
      }
      delete obj.META;
    }
    return obj;
  };
}

// The one streaming loop: chunk decode, line split, \r strip, comment and
// header-line skipping, and the final unterminated-line tail. handlers:
//   line(line, totalChars) — every data line, INCLUDING the tail
//   comment() — '#' lines in the main loop (a tail comment is skipped
//     silently, matching the historical per-pass loops)
//   chunk(totalChars) — after each decoded chunk's lines (progress hooks)
async function streamCsvLines(csvFile, handlers) {
  const stream = csvFile.stream().pipeThrough(new TextDecoderStream());
  const reader = stream.getReader();
  let buffer = '', isFirstLine = true, totalChars = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalChars += value.length;
    buffer += value;
    const parts = buffer.split('\n');
    buffer = parts.pop();
    for (const raw of parts) {
      const line = raw.replace(/\r$/, '');
      if (line.startsWith('#')) { if (handlers.comment) handlers.comment(); continue; }
      if (isFirstLine) { isFirstLine = false; continue; }
      if (!line) continue;
      handlers.line(line, totalChars);
    }
    if (handlers.chunk) handlers.chunk(totalChars);
  }
  // Process last buffer line
  if (buffer) {
    const line = buffer.replace(/\r$/, '');
    if (line && !line.startsWith('#') && !isFirstLine) handlers.line(line, totalChars);
  }
}

// Field-split + row build + global filter, delivering only accepted rows.
// Weight ordinals downstream count on handler invocation — i.e. at
// GLOBAL-filter acceptance, before any local filter (the declus row space).
function forEachSourceRow(source, handlers) {
  const globalFn = handlers.globalFn || null;
  const buildRow = source.buildRow, delimiter = source.delimiter;
  return streamCsvLines(source.csvFile, {
    chunk: handlers.chunk,
    line(line, totalChars) {
      const fields = line.split(delimiter);
      const row = buildRow(fields);
      if (globalFn && !globalFn(row)) return;
      handlers.row(row, fields, totalChars);
    }
  });
}

async function analyze(file, xyzOverride, filter, typeOverrides, zipEntry, skipCols, colFilters, calcolCode, calcolMeta, groupBy, groupStatsCols, dxyzOverride, dmEndianness, dmFormat, rowVarOverride, weightColName, weightArray, weightArrayLabel) {
  const startTime = performance.now();
  let weightName = null;      // resolved weight column (raw or calcol), null = unweighted
  let weightExcluded = 0;     // rows dropped for missing/non-positive weight
  // Computed weights by filter-surviving row ordinal (e.g. declustering) —
  // the array must come from a pass with the SAME file and filter, so the
  // ordinals line up. NaN/invalid entries exclude the row like any bad weight.
  const wArr = weightArray || null;
  let wOrd = 0;

  // Row source: container extraction + delimiter/header sniff + calcol
  // compile. colTypes stays unset — this pass detects them mid-stream and
  // assigns src.colTypes once resolved (buildRow reads it live).
  let src;
  try {
    src = await makeRowSource(file, {
      zipEntry, dmEndianness, dmFormat, rowVarOverride, calcolCode, calcolMeta,
      emptyMessage: 'File appears empty or has no data rows.'
    });
  } catch (e) {
    self.postMessage({ type: 'error', message: e.message });
    return;
  }
  const csvFile = src.csvFile;
  const zipName = src.zipName;
  const delimiter = src.delimiter;
  const header = src.header;
  const nCols = src.nCols;
  const rowVarName = src.rowVarName;
  const calcolFn = src.calcolFn;
  const buildRow = src.buildRow;

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
  let catOverflow = null;
  let numericCols = null;
  let catCols = null;
  let filterFn = null;
  let groupByCol = (groupBy !== null && groupBy !== undefined) ? groupBy : null;
  let groupByColName = null;
  let groupStats = {};
  let groupCategories = {};

  // ── Calcol column registration (the code itself compiles in the source) ──
  let calcolNumCols = [];
  let calcolCatCols = [];

  function initStatsPhase() {
    const skip = skipCols ? new Set(skipCols.map(Number)) : new Set();
    numericCols = header.map((_, i) => i).filter(i => colTypes[i] === 'numeric' && !skip.has(i));
    catCols = header.map((_, i) => i).filter(i => colTypes[i] === 'categorical' && !skip.has(i));
    // Resolve the weight column by name (raw column or calcol)
    weightName = null;
    if (weightColName) {
      const inRaw = header.indexOf(weightColName) >= 0;
      const inCalc = calcolMeta ? calcolMeta.some(cm => cm.name === weightColName) : false;
      if (inRaw || inCalc) weightName = weightColName;
    }
    stats = {};
    for (const i of numericCols) {
      stats[i] = newAcc();
    }
    catCounts = {};
    catOverflow = new Set();
    for (const i of catCols) catCounts[i] = {};

    // Register calcol columns — even when the code block failed to compile
    // the columns exist (and stay empty), matching historical behavior
    calcolNumCols = [];
    calcolCatCols = [];
    if (calcolCode && calcolMeta && calcolMeta.length > 0) {
      for (let ci = 0; ci < calcolMeta.length; ci++) {
        const cm = calcolMeta[ci];
        const idx = nCols + ci;
        if (cm.type === 'numeric') {
          calcolNumCols.push(idx);
          stats[idx] = newAcc();
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
        filterFn = compileFilterFn(rowVarName, filterExpr);
      } catch(e) {
        self.postMessage({ type: 'error', message: 'Filter expression error: ' + e.message });
      }
    }

    // Extended types for calcols (the extended header comes from the source)
    const extTypes = [...colTypes];
    if (calcolMeta) {
      for (const cm of calcolMeta) extTypes.push(cm.type);
    }

    self.postMessage({ type: 'header', header: src.extHeader, delimiter, colTypes: extTypes, xyzGuess, rowVarName, calcolCount: calcolMeta ? calcolMeta.length : 0, origColCount: nCols });
  }

  // Weighted one-pass moments: merge the accumulator with a single point of
  // weight w (Chan/Pébay pairwise-merge formulas with the point's own
  // M2..M4 = 0). At w = 1 these reduce algebraically to the classic
  // unweighted Pébay update this replaces.
  function welfordAdd(s, v, w) {
    if (w === undefined) w = 1;
    s.count++;
    if (v === 0) s.zeros++;
    if (v < s.min) s.min = v;
    if (v > s.max) s.max = v;
    const wa = s.sumW;        // old weight total
    const W = wa + w;
    const delta = v - s.m1;
    const r = delta * w / W;  // m1 increment
    const t = delta * r * wa; // M2 increment
    s.m4 += t * delta * delta * (wa * wa - wa * w + w * w) / (W * W) + 6 * r * r * s.m2 - 4 * r * s.m3;
    s.m3 += t * delta * (wa - w) / W - 3 * r * s.m2;
    s.m2 += t;
    s.m1 += r;
    s.sumW = W;
    tdAdd(s.td, v, w);
  }

  function newAcc() {
    return { count: 0, sumW: 0, min: Infinity, max: -Infinity, m1: 0, m2: 0, m3: 0, m4: 0, nulls: 0, zeros: 0, parseFails: 0, td: newTDigest() };
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
    let variance, std = null, skewness = null, kurtosis = null;
    if (weightName || wArr) {
      // Weighted run: population-form estimators — count-based small-sample
      // bias corrections don't apply to arbitrary-scale weights
      const W = s.sumW;
      variance = (n > 1 && W > 0) ? s.m2 / W : null;
      std = variance !== null ? Math.sqrt(Math.max(0, variance)) : null;
      if (n > 2 && s.m2 > 0 && W > 0) skewness = (Math.sqrt(W) * s.m3) / Math.pow(s.m2, 1.5);
      if (n > 3 && s.m2 > 0) kurtosis = (W * s.m4) / (s.m2 * s.m2) - 3;
    } else {
      variance = n > 1 ? s.m2 / (n - 1) : null;
      std = variance !== null ? Math.sqrt(variance) : null;
      if (n > 2 && s.m2 > 0) {
        skewness = (Math.sqrt(n) * s.m3) / Math.pow(s.m2, 1.5);
        skewness *= Math.sqrt(n * (n - 1)) / (n - 2);
      }
      if (n > 3 && s.m2 > 0) {
        kurtosis = (n * s.m4) / (s.m2 * s.m2) - 3;
        kurtosis = ((n - 1) / ((n - 2) * (n - 3))) * ((n + 1) * kurtosis + 6);
      }
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
      count: n, sumW: s.sumW, nulls: s.nulls, zeros: s.zeros, parseFails: s.parseFails,
      min: n > 0 ? s.min : null, max: n > 0 ? s.max : null,
      mean: n > 0 ? s.m1 : null, std, skewness, kurtosis, quantiles, centroids
    };
  }

  function processCalcolStats(row, w) {
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
      welfordAdd(s, v, w);
      if (gv !== null && groupStats[idx]) {
        const ga = getGroupAcc(groupStats[idx], gv);
        if (ga) welfordAdd(ga, v, w);
      }
    }
    for (const idx of calcolCatCols) {
      const cm = calcolMeta[idx - nCols];
      const v = row[cm.name];
      if (v === null || v === undefined || v === '') continue;
      const sv = String(v);
      const counts = catCounts[idx];
      if (catOverflow.has(idx)) continue;
      counts[sv] = (counts[sv] || 0) + 1;
      if (Object.keys(counts).length > MAX_UNIQUE_CAT) catOverflow.add(idx);
      // Cross-tab counting
      if (gv !== null && groupCategories[idx]) {
        let gm = groupCategories[idx].get(gv);
        if (!gm) { gm = {}; groupCategories[idx].set(gv, gm); }
        gm[sv] = (gm[sv] || 0) + 1;
      }
    }
  }

  function processRowStats(fields, row, w) {
    const gv = groupByCol !== null ? (groupByCol >= nCols && row ? String(row[groupByColName] ?? '') : (fields[groupByCol] || '').trim().replace(/^["']|["']$/g, '')) : null;
    for (const i of numericCols) {
      const raw = (fields[i] || '').trim().replace(/^["']|["']$/g, '');
      if (NULL_SENTINELS.has(raw)) { stats[i].nulls++; if (gv !== null && groupStats[i]) { const ga = getGroupAcc(groupStats[i], gv); if (ga) ga.nulls++; } continue; }
      const v = Number(raw);
      // Non-sentinel value that fails to parse as a number — counted apart
      // from nulls (A9 F2): the column may be mixed-type, surfaced as a badge
      if (!isFinite(v)) { stats[i].nulls++; stats[i].parseFails++; if (gv !== null && groupStats[i]) { const ga = getGroupAcc(groupStats[i], gv); if (ga) { ga.nulls++; ga.parseFails++; } } continue; }
      const s = stats[i];
      // Per-column value filters
      const cf = colFilters ? colFilters[i] : null;
      if (cf) {
        if (cf.skipZeros && v === 0) { s.nulls++; if (gv !== null && groupStats[i]) { const ga = getGroupAcc(groupStats[i], gv); if (ga) ga.nulls++; } continue; }
        if (cf.skipNeg && v < 0) { s.nulls++; if (gv !== null && groupStats[i]) { const ga = getGroupAcc(groupStats[i], gv); if (ga) ga.nulls++; } continue; }
      }
      welfordAdd(s, v, w);
      if (gv !== null && groupStats[i]) {
        const ga = getGroupAcc(groupStats[i], gv);
        if (ga) welfordAdd(ga, v, w);
      }
    }
    for (const i of catCols) {
      const v = (fields[i] || '').trim().replace(/^["']|["']$/g, '');
      if (!v) continue;
      const cc = catCounts[i];
      if (catOverflow.has(i)) continue;
      cc[v] = (cc[v] || 0) + 1;
      if (Object.keys(cc).length > MAX_UNIQUE_CAT) catOverflow.add(i);
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

  // When every column's type is forced, skip the detection phase entirely —
  // zero row loss. Both the model and aux passes send their full preflight
  // types (A9-1); detection below remains as a fallback for direct worker
  // use without preflight, and its rows are excluded from stats.
  if (forced.size >= nCols) {
    typesResolved = true;
    colTypes = src.colTypes = resolveTypes();
    initStatsPhase();
  }

  // ── Single-pass stream ──
  let rowCount = 0, totalRowCount = 0, commentCount = 0;
  let lastProgress = 0;

  // ── Stats phase (filter + accumulate) — one data line ──
  function statsLine(fields) {
    const hasCalcols = calcolFn !== null;
    const needsRow = hasCalcols || filterFn || (groupByCol !== null && groupByCol >= nCols) || weightName !== null;
    let row = null;
    if (needsRow) row = buildRow(fields);
    if (filterFn) {
      if (!filterFn(row)) return;
    }
    let rowW = 1;
    if (wArr) {
      const wv = wArr[wOrd++];
      if (!(wv > 0) || !isFinite(wv)) { weightExcluded++; return; }
      rowW = wv;
    } else if (weightName) {
      const wv = row[weightName];
      if (typeof wv !== 'number' || !isFinite(wv) || wv <= 0) { weightExcluded++; return; }
      rowW = wv;
    }
    rowCount++;
    processRowStats(fields, row, rowW);
    if (hasCalcols) processCalcolStats(row, rowW);
  }

  await src.stream({
    comment() { commentCount++; },
    line(line, totalChars) {
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
          colTypes = src.colTypes = resolveTypes();
          initStatsPhase();
        }
        return; // skip stats during detection — negligible row loss
      }

      statsLine(fields);

      // Progress
      if (totalRowCount - lastProgress >= 25000) {
        lastProgress = totalRowCount;
        self.postMessage({ type: 'progress', percent: (totalChars / csvFile.size) * 100, rowCount: totalRowCount });
      }
    }
  });

  // The whole file fit inside the detection phase — a tiny file, or a column
  // with too few values to resolve (an all-empty column never resolves, A8).
  // Detection skipped stats for every line, so resolve types and replay the
  // stream for the stats pass alone (geometry and row counters already
  // accumulated; the weight ordinal was never advanced). Bounded cost: only
  // files that end before TYPE_MAX_ROWS can get here.
  if (!typesResolved) {
    typesResolved = true;
    colTypes = src.colTypes = resolveTypes();
    initStatsPhase();
    await src.stream({
      line(line) { statsLine(line.split(delimiter)); }
    });
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
    const cc = catCounts[i];
    finalCats[i] = { counts: cc, overflow: catOverflow.has(i) };
  }

  // Extended types for the complete message (header comes from the source)
  const extTypesFinal = [...colTypes];
  if (calcolMeta) {
    for (const cm of calcolMeta) extTypesFinal.push(cm.type);
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
    weightApplied: wArr ? (weightArrayLabel || '(weights)') : weightName,
    weightExcluded,
    // Ordinal misalignment guard: the weight array must cover exactly the
    // filter-surviving rows; a mismatch means file/filter drifted since the
    // weights were computed
    weightArrayMismatch: wArr && wOrd !== wArr.length ? { expected: wArr.length, got: wOrd } : null,
    filterErrors: filterErrPayload(filterFn, null),
    calcolErrors: calcolErrPayload(src),
    header: src.extHeader,
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

  let src;
  try {
    src = await makeRowSource(file, {
      zipEntry, dmEndianness: data.dmEndianness, dmFormat: data.dmFormat,
      resolvedTypes, calcolCode, calcolMeta,
      emptyMessage: 'File appears empty or has no data rows.'
    });
  } catch(e) {
    self.postMessage({ type: 'error', message: e.message });
    return;
  }
  const csvFile = src.csvFile;

  // Compile filter
  let filterFn = null;
  const filterExpr = filter ? filter.expression : null;
  if (filterExpr) {
    try {
      filterFn = compileFilterFn(src.rowVarName, filterExpr);
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

  let rowCount = 0;
  let chunkLines = [];
  const CHUNK_SIZE = 5000;

  function flushChunk() {
    if (chunkLines.length === 0) return;
    self.postMessage({ type: 'export-chunk', csv: chunkLines.join('') });
    chunkLines = [];
  }

  await src.forEachRow({
    globalFn: filterFn,
    row(row, fields, totalChars) {
      rowCount++;
      chunkLines.push(exportCols.map(c => csvEscape(row[c.name])).join(outDelim) + lineEnding);

      if (chunkLines.length >= CHUNK_SIZE) {
        flushChunk();
        self.postMessage({ type: 'export-progress', percent: (totalChars / csvFile.size) * 100, rowCount });
      }
    }
  });
  flushChunk();

  const elapsed = performance.now() - startTime;
  self.postMessage({ type: 'export-complete', rowCount, elapsed, filterErrors: filterErrPayload(filterFn, null), calcolErrors: calcolErrPayload(src) });
}

async function swathAnalysis(data) {
  const { file, zipEntry, globalFilter, localFilter, calcolCode, calcolMeta, resolvedTypes,
          xyzCols, varCols, directions } = data;
  const startTime = performance.now();

  let src;
  try {
    src = await makeRowSource(file, {
      zipEntry, dmEndianness: data.dmEndianness, dmFormat: data.dmFormat,
      rowVarOverride: data.rowVarOverride, resolvedTypes, calcolCode, calcolMeta
    });
  } catch(e) {
    self.postMessage({ type: 'error', message: e.message });
    return;
  }
  const csvFile = src.csvFile, header = src.header;

  let globalFn = null, localFn = null;
  if (globalFilter) {
    try { globalFn = compileFilterFn(src.rowVarName, globalFilter.expression); }
    catch(e) { self.postMessage({ type: 'error', message: 'Global filter error: ' + e.message }); return; }
  }
  if (localFilter) {
    try { localFn = compileFilterFn(src.rowVarName, localFilter); }
    catch(e) { self.postMessage({ type: 'error', message: 'Local filter error: ' + e.message }); return; }
  }

  // Directions: [{ key, axis: 0|1|2|null, dir: [dx,dy,dz]|null, binWidth }].
  // All directions are binned in the same streaming pass — an orthogonal
  // direction reads its coordinate column directly, a vector direction
  // projects the row's XYZ onto the unit vector.
  const xName = header[xyzCols[0]], yName = header[xyzCols[1]], zName = header[xyzCols[2]];
  const dirCfgs = directions.map(function(d) {
    return {
      key: d.key,
      binWidth: d.binWidth,
      coordName: d.axis != null ? header[xyzCols[d.axis]] : null,
      dir: d.axis != null ? null : d.dir,
      bins: new Map()
    };
  });

  // Resolve variable column names against the extended header — calcol
  // indices live past the raw columns, and the calcol code sets them on
  // the row by name inside the source's buildRow
  const varNames = varCols.map(vi => src.extHeader[vi]);

  // Optional row weight (raw column or calcol, by name)
  let weightName = null;
  if (data.weightColName && src.extHeader.indexOf(data.weightColName) >= 0) weightName = data.weightColName;
  // Or computed weights by global-filter-surviving ordinal (declustering) —
  // counted at global acceptance, BEFORE the local filter, to match the
  // declus pass's row space
  const wArr = data.weightArray || null;
  let wOrd = 0;

  // Per-direction, per-variable bins: Map<binIdx, {vars: {varIdx: {count,sum,sumSq,td}}, center}>
  function getBin(cfg, coord) {
    const idx = Math.floor(coord / cfg.binWidth);
    let b = cfg.bins.get(idx);
    if (!b) {
      b = { center: (idx + 0.5) * cfg.binWidth, vars: {} };
      for (const vi of varCols) {
        b.vars[vi] = { count: 0, wsum: 0, sum: 0, sumSq: 0, td: newTDigest() };
      }
      cfg.bins.set(idx, b);
    }
    return b;
  }

  function processRow(row, w) {
    if (w === undefined) w = 1;
    for (var di = 0; di < dirCfgs.length; di++) {
      var cfg = dirCfgs[di];
      var coord;
      if (cfg.coordName) {
        coord = row[cfg.coordName];
        if (coord == null || isNaN(coord)) continue;
      } else {
        // Project onto the unit vector; only components the direction actually
        // uses are required (a horizontal direction tolerates a missing Z)
        var dv = cfg.dir;
        coord = 0;
        var ok = true;
        if (Math.abs(dv[0]) > 1e-12) { var xv = row[xName]; if (xv == null || isNaN(xv)) ok = false; else coord += xv * dv[0]; }
        if (ok && Math.abs(dv[1]) > 1e-12) { var yv = row[yName]; if (yv == null || isNaN(yv)) ok = false; else coord += yv * dv[1]; }
        if (ok && Math.abs(dv[2]) > 1e-12) { var zv = row[zName]; if (zv == null || isNaN(zv)) ok = false; else coord += zv * dv[2]; }
        if (!ok) continue;
      }
      var bin = getBin(cfg, coord);
      for (var vi = 0; vi < varCols.length; vi++) {
        var val = row[varNames[vi]];
        if (val == null || typeof val !== 'number' || isNaN(val)) continue;
        var vb = bin.vars[varCols[vi]];
        vb.count++;
        vb.wsum += w;
        vb.sum += val * w;
        vb.sumSq += val * val * w;
        tdAdd(vb.td, val, w);
      }
    }
  }

  let lastProgress = 0;
  await src.forEachRow({
    globalFn,
    row(row, fields, totalChars) {
      // Weight ordinal is consumed at GLOBAL acceptance, before the local
      // filter, to match the declus pass's row space
      let awv = null;
      if (wArr) awv = wArr[wOrd++];
      if (localFn && !localFn(row)) return;
      let rw = 1;
      if (wArr) {
        if (!(awv > 0) || !isFinite(awv)) return;
        rw = awv;
      } else if (weightName) {
        const wv = row[weightName];
        if (typeof wv !== 'number' || !isFinite(wv) || wv <= 0) return;
        rw = wv;
      }
      processRow(row, rw);

      if (totalChars - lastProgress >= 500000) {
        lastProgress = totalChars;
        self.postMessage({ type: 'swath-progress', percent: (totalChars / csvFile.size) * 100 });
      }
    }
  });

  // Finalize: per-direction, per-variable bin arrays
  const results = {};
  for (const cfg of dirCfgs) {
    const vars = {};
    for (const vi of varCols) {
      const arr = [];
      for (const [, b] of cfg.bins) {
        const vb = b.vars[vi];
        if (vb.count === 0) continue;
        tdFlush(vb.td);
        const mean = vb.sum / vb.wsum;
        // Weighted runs use population variance; unweighted keeps the original
        // sample formula (wsum === count there, so sums are unchanged)
        const variance = (weightName || wArr)
          ? (vb.wsum > 0 ? Math.max(0, vb.sumSq / vb.wsum - mean * mean) : 0)
          : (vb.count > 1 ? (vb.sumSq - vb.sum * vb.sum / vb.count) / (vb.count - 1) : 0);
        arr.push({
          center: b.center, count: vb.count, mean,
          std: Math.sqrt(Math.max(0, variance)),
          centroids: vb.td.centroids.map(c => [c.mean, c.count])
        });
      }
      arr.sort((a, b) => a.center - b.center);
      vars[vi] = arr;
    }
    results[cfg.key] = vars;
  }

  const elapsed = performance.now() - startTime;
  self.postMessage({ type: 'swath-complete', results, elapsed, filterErrors: filterErrPayload(globalFn, localFn), calcolErrors: calcolErrPayload(src) });
}

// ─── Cell declustering (GSLIB DECLUS) ─────────────────────────────────
// Faithful port of declus.for (Deutsch & Journel; the Fortran is the spec,
// f64 throughout): sweep ncell+1 cell sizes from cellMin to cellMax, average
// inverse-cell-count weights over noff diagonal origin offsets, pick the
// size whose declustered mean is lowest (or highest, per criterion). The
// naive mean is the incumbent — if no size beats it, weights stay 1 and
// optCellSize is 0.
//
// Output weights are aligned to FILTER-SURVIVING row ordinals (the same
// rows an aux analyze/swath pass with the same global filter accepts), so
// they can be applied by position in later passes. Rows without finite
// XYZ + variable get NaN (excluded + counted downstream, like any invalid
// weight).
async function declusAnalysis(data) {
  const { file, zipEntry, globalFilter, calcolCode, calcolMeta, resolvedTypes, xyzCols, varColName } = data;
  const startTime = performance.now();

  let src;
  try {
    src = await makeRowSource(file, {
      zipEntry, dmEndianness: data.dmEndianness, dmFormat: data.dmFormat,
      rowVarOverride: data.rowVarOverride, resolvedTypes, calcolCode, calcolMeta
    });
  } catch(e) {
    self.postMessage({ type: 'error', message: e.message });
    return;
  }
  const csvFile = src.csvFile, header = src.header;

  let globalFn = null;
  if (globalFilter) {
    try { globalFn = compileFilterFn(src.rowVarName, globalFilter.expression); }
    catch(e) { self.postMessage({ type: 'error', message: 'Global filter error: ' + e.message }); return; }
  }

  const xName = header[xyzCols[0]], yName = header[xyzCols[1]];
  const zName = xyzCols[2] >= 0 ? header[xyzCols[2]] : null; // 2D allowed: z = 0 (declus.for iz<=0)
  if (src.extHeader.indexOf(varColName) < 0) {
    self.postMessage({ type: 'error', message: 'Declustering variable not found: ' + varColName });
    return;
  }

  // Collect located rows; n counts every filter-surviving row (the ordinal space)
  const xs = [], ys = [], zs = [], vs = [], ord = [];
  let n = 0, lastProgress = 0;

  await src.forEachRow({
    globalFn,
    row(row) {
      const o = n++;
      const xv = row[xName], yv = row[yName];
      const zv = zName ? row[zName] : 0;
      const vv = row[varColName];
      if (typeof xv === 'number' && isFinite(xv) && typeof yv === 'number' && isFinite(yv) &&
          typeof zv === 'number' && isFinite(zv) && typeof vv === 'number' && isFinite(vv)) {
        xs.push(xv); ys.push(yv); zs.push(zv); vs.push(vv); ord.push(o);
      }
    },
    chunk(totalChars) {
      if (totalChars - lastProgress >= 500000) {
        lastProgress = totalChars;
        self.postMessage({ type: 'declus-progress', percent: (totalChars / csvFile.size) * 50 });
      }
    }
  });

  const nd = xs.length;
  if (nd < 2) {
    self.postMessage({ type: 'error', message: 'Not enough located rows to decluster (need at least 2 with valid coordinates and variable).' });
    return;
  }

  // Extents and naive mean (declus.for lines 312-323)
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity, zmin = Infinity, zmax = -Infinity;
  let vrav = 0;
  for (let i = 0; i < nd; i++) {
    vrav += vs[i];
    if (xs[i] < xmin) xmin = xs[i]; if (xs[i] > xmax) xmax = xs[i];
    if (ys[i] < ymin) ymin = ys[i]; if (ys[i] > ymax) ymax = ys[i];
    if (zs[i] < zmin) zmin = zs[i]; if (zs[i] > zmax) zmax = zs[i];
  }
  vrav /= nd;

  // Auto cell-size range when unset: span/100 .. span/2 of the largest extent
  const L = Math.max(xmax - xmin, ymax - ymin, zmax - zmin) || 1;
  let cmin = data.cellMin, cmax = data.cellMax;
  if (!(cmin > 0)) cmin = L / 100;
  if (!(cmax > 0)) cmax = L / 2;
  if (cmax < cmin) { const t = cmin; cmin = cmax; cmax = t; }
  let ncell = (data.ncell > 0) ? Math.floor(data.ncell) : 24;
  const noff = (data.noff > 0) ? Math.floor(data.noff) : 8;
  const anisy = (data.anisy > 0) ? data.anisy : 1;
  const anisz = (data.anisz > 0) ? data.anisz : 1;
  const wantMin = data.iminmax !== 1;
  if (ncell === 1) cmax = cmin; // declus.for: single-size mode

  const wtopt = new Float64Array(nd).fill(1);
  const wt = new Float64Array(nd);
  const cellIdx = new Int32Array(nd);
  let vrop = vrav, best = 0;
  const curve = [[0, vrav]];

  const xo1 = xmin - 0.01, yo1 = ymin - 0.01, zo1 = zmin - 0.01;
  const xinc = (cmax - cmin) / ncell;
  const yinc = anisy * xinc, zinc = anisz * xinc;
  let xcs = cmin - xinc, ycs = cmin * anisy - yinc, zcs = cmin * anisz - zinc;
  const roff = noff;

  for (let lp = 1; lp <= ncell + 1; lp++) {
    xcs += xinc; ycs += yinc; zcs += zinc;
    wt.fill(0);
    const ncellx = Math.floor((xmax - (xo1 - xcs)) / xcs) + 1;
    const ncelly = Math.floor((ymax - (yo1 - ycs)) / ycs) + 1;
    const xfac = Math.min(xcs / roff, 0.5 * (xmax - xmin));
    const yfac = Math.min(ycs / roff, 0.5 * (ymax - ymin));
    const zfac = Math.min(zcs / roff, 0.5 * (zmax - zmin));
    for (let kp = 1; kp <= noff; kp++) {
      const xo = xo1 - (kp - 1) * xfac;
      const yo = yo1 - (kp - 1) * yfac;
      const zo = zo1 - (kp - 1) * zfac;
      const cellwt = new Map();
      for (let i = 0; i < nd; i++) {
        const icellx = Math.floor((xs[i] - xo) / xcs) + 1;
        const icelly = Math.floor((ys[i] - yo) / ycs) + 1;
        const icellz = Math.floor((zs[i] - zo) / zcs) + 1;
        const icell = icellx + (icelly - 1) * ncellx + (icellz - 1) * ncelly * ncellx;
        cellIdx[i] = icell;
        cellwt.set(icell, (cellwt.get(icell) || 0) + 1);
      }
      let sumw = 0;
      for (let i = 0; i < nd; i++) sumw += 1 / cellwt.get(cellIdx[i]);
      sumw = 1 / sumw;
      for (let i = 0; i < nd; i++) wt[i] += (1 / cellwt.get(cellIdx[i])) * sumw;
    }
    let sumw = 0, sumwg = 0;
    for (let i = 0; i < nd; i++) { sumw += wt[i]; sumwg += wt[i] * vs[i]; }
    const vrcr = sumwg / sumw;
    curve.push([xcs, vrcr]);
    if ((wantMin && vrcr < vrop) || (!wantMin && vrcr > vrop) || ncell === 1) {
      best = xcs; vrop = vrcr;
      wtopt.set(wt);
    }
    self.postMessage({ type: 'declus-progress', percent: 50 + 50 * lp / (ncell + 1) });
  }

  // Pinned cell size: the user chose a size on the curve — recompute the
  // weights at exactly that size and let it override the sweep optimum
  // (the sweep curve above is kept for display)
  const pinnedCell = (data.pinnedCell > 0) ? data.pinnedCell : null;
  if (pinnedCell) {
    const pxcs = pinnedCell, pycs = pinnedCell * anisy, pzcs = pinnedCell * anisz;
    wt.fill(0);
    const ncellx = Math.floor((xmax - (xo1 - pxcs)) / pxcs) + 1;
    const ncelly = Math.floor((ymax - (yo1 - pycs)) / pycs) + 1;
    const xfac = Math.min(pxcs / roff, 0.5 * (xmax - xmin));
    const yfac = Math.min(pycs / roff, 0.5 * (ymax - ymin));
    const zfac = Math.min(pzcs / roff, 0.5 * (zmax - zmin));
    for (let kp = 1; kp <= noff; kp++) {
      const xo = xo1 - (kp - 1) * xfac;
      const yo = yo1 - (kp - 1) * yfac;
      const zo = zo1 - (kp - 1) * zfac;
      const cellwt = new Map();
      for (let i = 0; i < nd; i++) {
        const icellx = Math.floor((xs[i] - xo) / pxcs) + 1;
        const icelly = Math.floor((ys[i] - yo) / pycs) + 1;
        const icellz = Math.floor((zs[i] - zo) / pzcs) + 1;
        const icell = icellx + (icelly - 1) * ncellx + (icellz - 1) * ncelly * ncellx;
        cellIdx[i] = icell;
        cellwt.set(icell, (cellwt.get(icell) || 0) + 1);
      }
      let sumw = 0;
      for (let i = 0; i < nd; i++) sumw += 1 / cellwt.get(cellIdx[i]);
      sumw = 1 / sumw;
      for (let i = 0; i < nd; i++) wt[i] += (1 / cellwt.get(cellIdx[i])) * sumw;
    }
    let sumw = 0, sumwg = 0;
    for (let i = 0; i < nd; i++) { sumw += wt[i]; sumwg += wt[i] * vs[i]; }
    best = pinnedCell;
    vrop = sumwg / sumw;
    wtopt.set(wt);
  }

  // Normalize optimal weights to mean 1 (facto = nd/sumw)
  let sumo = 0;
  for (let i = 0; i < nd; i++) sumo += wtopt[i];
  const facto = nd / sumo;
  let wtMin = Infinity, wtMax = -Infinity;
  for (let i = 0; i < nd; i++) {
    wtopt[i] *= facto;
    if (wtopt[i] < wtMin) wtMin = wtopt[i];
    if (wtopt[i] > wtMax) wtMax = wtopt[i];
  }

  // Weights by filter-surviving ordinal; unlocated rows NaN
  const weights = new Float64Array(n).fill(NaN);
  for (let i = 0; i < nd; i++) weights[ord[i]] = wtopt[i];

  const elapsed = performance.now() - startTime;
  self.postMessage({
    type: 'declus-complete',
    weights, n, located: nd,
    curve, optCellSize: best, declusteredMean: vrop, naiveMean: vrav,
    pinned: !!pinnedCell,
    usedRange: [cmin, cmax, ncell, noff], wtMin, wtMax, elapsed,
    filterErrors: filterErrPayload(globalFn, null), calcolErrors: calcolErrPayload(src)
  }, [weights.buffer]);
}

// ─── Column values pass ───────────────────────────────────────────────
// Streams the file once and returns the SORTED finite values of one column
// (raw or calcol) after the global filter — the exact-distribution input
// for top-cut analysis, where prefix sums make every candidate cap O(log n).
async function colValuesAnalysis(data) {
  const { file, zipEntry, globalFilter, calcolCode, calcolMeta, resolvedTypes, varColName } = data;
  const startTime = performance.now();

  let src;
  try {
    src = await makeRowSource(file, {
      zipEntry, dmEndianness: data.dmEndianness, dmFormat: data.dmFormat,
      rowVarOverride: data.rowVarOverride, resolvedTypes, calcolCode, calcolMeta
    });
  } catch(e) {
    self.postMessage({ type: 'error', message: e.message });
    return;
  }
  const csvFile = src.csvFile;

  let globalFn = null;
  if (globalFilter) {
    try { globalFn = compileFilterFn(src.rowVarName, globalFilter.expression); }
    catch(e) { self.postMessage({ type: 'error', message: 'Global filter error: ' + e.message }); return; }
  }

  if (src.extHeader.indexOf(varColName) < 0) {
    self.postMessage({ type: 'error', message: 'Variable not found: ' + varColName });
    return;
  }

  // Optional row weight: a column/calcol by name, or a computed array by
  // global-filter-surviving ordinal (declustering weights) — same contract
  // as analyze/swath. Invalid weights exclude the row, counted.
  let weightName = null;
  if (data.weightColName && src.extHeader.indexOf(data.weightColName) >= 0) weightName = data.weightColName;
  const wArr = data.weightArray || null;
  let weightExcluded = 0;

  const vals = [], wts = [];
  const weighted = !!(weightName || wArr);
  let n = 0, lastProgress = 0;

  await src.forEachRow({
    globalFn,
    row(row) {
      const ord = n++;
      let w = 1;
      if (wArr) {
        const wv = wArr[ord];
        if (!(wv > 0) || !isFinite(wv)) { weightExcluded++; return; }
        w = wv;
      } else if (weightName) {
        const wv = row[weightName];
        if (typeof wv !== 'number' || !isFinite(wv) || wv <= 0) { weightExcluded++; return; }
        w = wv;
      }
      const v = row[varColName];
      if (typeof v === 'number' && isFinite(v)) {
        vals.push(v);
        if (weighted) wts.push(w);
      }
    },
    chunk(totalChars) {
      if (totalChars - lastProgress >= 500000) {
        lastProgress = totalChars;
        self.postMessage({ type: 'colvalues-progress', percent: (totalChars / csvFile.size) * 90 });
      }
    }
  });

  let values, weights = null;
  if (weighted) {
    // Sort pairs by value, weights permuted along
    const idx = Array.from(vals.keys()).sort((a, b) => vals[a] - vals[b]);
    values = new Float64Array(vals.length);
    weights = new Float64Array(vals.length);
    for (let i = 0; i < idx.length; i++) { values[i] = vals[idx[i]]; weights[i] = wts[idx[i]]; }
  } else {
    values = Float64Array.from(vals);
    values.sort();
  }

  const elapsed = performance.now() - startTime;
  const transfers = [values.buffer];
  if (weights) transfers.push(weights.buffer);
  self.postMessage({
    type: 'colvalues-complete',
    values, weights, n, finite: values.length, weightExcluded, elapsed,
    filterErrors: filterErrPayload(globalFn, null), calcolErrors: calcolErrPayload(src)
  }, transfers);
}

async function sectionAnalysis(data) {
  const { file, zipEntry, globalFilter, localFilter, calcolCode, calcolMeta, resolvedTypes,
          xyzCols, dxyzCols, normalAxis, slicePos, tolerance, varCol } = data;
  const startTime = performance.now();

  let src;
  try {
    src = await makeRowSource(file, {
      zipEntry, dmEndianness: data.dmEndianness, dmFormat: data.dmFormat,
      rowVarOverride: data.rowVarOverride, resolvedTypes, calcolCode, calcolMeta
    });
  } catch(e) {
    self.postMessage({ type: 'error', message: e.message });
    return;
  }
  const csvFile = src.csvFile, header = src.header;

  let globalFn = null, localFn = null;
  if (globalFilter) {
    try { globalFn = compileFilterFn(src.rowVarName, globalFilter.expression); }
    catch(e) { self.postMessage({ type: 'error', message: 'Global filter error: ' + e.message }); return; }
  }
  if (localFilter) {
    try { localFn = compileFilterFn(src.rowVarName, localFilter); }
    catch(e) { self.postMessage({ type: 'error', message: 'Local filter error: ' + e.message }); return; }
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
  let lastProgress = 0;

  await src.forEachRow({
    globalFn,
    row(row, fields, totalChars) {
      if (localFn && !localFn(row)) return;

      const nv = row[normalName];
      if (nv == null || isNaN(nv)) return;
      if (nv < slicePos - halfTol || nv > slicePos + halfTol) return;

      const h = row[hName];
      const v = row[vName];
      if (h == null || !isFinite(h) || v == null || !isFinite(v)) return;

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
  });

  const elapsed = performance.now() - startTime;
  self.postMessage({
    type: 'section-complete',
    blocks,
    hAxis, vAxis, normalAxis, slicePos,
    blockCount: blocks.length,
    elapsed,
    filterErrors: filterErrPayload(globalFn, localFn),
    calcolErrors: calcolErrPayload(src)
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

  // Constant density (t/m3) — takes precedence over a density column
  var densityConst = (data.densityConst != null && data.densityConst > 0) ? data.densityConst : null;

  var src;
  try {
    src = await makeRowSource(file, {
      zipEntry, dmEndianness: data.dmEndianness, dmFormat: data.dmFormat,
      resolvedTypes: resolvedTypes, calcolCode: calcolCode, calcolMeta: calcolMeta
    });
  } catch(e) {
    self.postMessage({ type: 'error', message: e.message });
    return;
  }
  var csvFile = src.csvFile;
  var header = src.header;
  var nCols = src.nCols;

  var globalFn = null, localFn = null;
  if (globalFilter) {
    try { globalFn = compileFilterFn(src.rowVarName, globalFilter.expression); }
    catch(e) { self.postMessage({ type: 'error', message: 'Global filter error: ' + e.message }); return; }
  }
  if (localFilter) {
    try { localFn = compileFilterFn(src.rowVarName, localFilter); }
    catch(e) { self.postMessage({ type: 'error', message: 'Local filter error: ' + e.message }); return; }
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

  var lastProgress = 0;
  await src.forEachRow({
    globalFn: globalFn,
    row: function(row, fields, totalChars) {
      if (localFn && !localFn(row)) return;

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
      if (densityConst != null) {
        density = densityConst;
      } else if (densityColName) {
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
  });

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
    elapsed: elapsed,
    filterErrors: filterErrPayload(globalFn, localFn),
    calcolErrors: calcolErrPayload(src)
  });
}

// ─── Datamine .dm binary support (worker) ─────────────────────────────

function isDmFile(file) {
  return file.name.toLowerCase().endsWith('.dm');
}

function dmReadTextW(dv, offset, nWords, fmt) {
  var result = '';
  var step = fmt === 'ep' ? 8 : 4;
  for (var w = 0; w < nWords; w++) {
    var base = offset + w * step;
    for (var b = 0; b < 4; b++) {
      var ch = dv.getUint8(base + b);
      if (ch >= 32 && ch < 127) result += String.fromCharCode(ch);
    }
  }
  return result.trim();
}

function parseDmDD_worker(dv, endianness, fmt) {
  var isLE = endianness === 'little';
  var ws = fmt === 'ep' ? 8 : 4;
  var pageSize = fmt === 'ep' ? 4096 : 2048;
  var readNum = fmt === 'ep'
    ? function(off) { return dv.getFloat64(off, isLE); }
    : function(off) { return dv.getFloat32(off, isLE); };

  var fileName = dmReadTextW(dv, 0, 2, fmt);
  var descOff = fmt === 'ep' ? 32 : 16;
  var description = dmReadTextW(dv, descOff, 20, fmt);
  var dateOff = fmt === 'ep' ? 192 : 96;
  var totalFields = Math.round(readNum(dateOff + ws));
  var lastPage = Math.round(readNum(dateOff + ws * 2));
  var lastRecordInLastPage = Math.round(readNum(dateOff + ws * 3));

  var fieldStart = dateOff + ws * 4;
  var fieldSize = ws * 7;
  var rawFields = [];
  for (var f = 0; f < totalFields; f++) {
    var fOff = fieldStart + f * fieldSize;
    if (fOff + fieldSize > pageSize) break;
    var name = dmReadTextW(dv, fOff, 2, fmt);
    var typeStr = dmReadTextW(dv, fOff + ws * 2, 1, fmt);
    var sw = Math.round(readNum(fOff + ws * 3));
    var lenf = Math.round(readNum(fOff + ws * 4));
    var defaultValue = readNum(fOff + ws * 6);
    rawFields.push({ name: name, type: typeStr.charAt(0).toUpperCase(), sw: sw, lenf: lenf, defaultValue: defaultValue });
  }

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
    var sorted = cm.entries.slice().sort(function(a, b) { return a.lenf - b.lenf; });
    var swPositions = [];
    for (var si = 0; si < sorted.length; si++) {
      swPositions.push(sorted[si].sw);
      if (sorted[si].sw > maxLen) maxLen = sorted[si].sw;
    }
    var constantValue = null;
    if (isConstant) {
      if (colType === 'numeric') {
        constantValue = (Math.abs(cm.defaultValue) > 9.9e29) ? '' : String(cm.defaultValue);
      } else {
        constantValue = '';
        for (var ei = 0; ei < sorted.length; ei++) {
          var defBytes = sorted[ei].defaultValue;
          var tmpBuf = new ArrayBuffer(fmt === 'ep' ? 8 : 4);
          var tmpDv = new DataView(tmpBuf);
          if (fmt === 'ep') tmpDv.setFloat64(0, defBytes, isLE);
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
      name: cm.name, type: colType, swPositions: swPositions,
      defaultValue: cm.defaultValue, isConstant: isConstant, constantValue: constantValue
    });
  }

  var recordsPerPage = maxLen > 0 ? Math.floor(508 / maxLen) : 0;
  return {
    fileName: fileName, description: description,
    totalFields: totalFields, lastPage: lastPage,
    lastRecordInLastPage: lastRecordInLastPage,
    columns: columns, maxLen: maxLen,
    recordsPerPage: recordsPerPage,
    pageSize: pageSize, wordSize: ws
  };
}

function extractCSVFromDM(file, endianness, fmt) {
  var ws = fmt === 'ep' ? 8 : 4;
  var pageSize = fmt === 'ep' ? 4096 : 2048;
  var isLE = endianness === 'little';

  return file.slice(0, pageSize).arrayBuffer().then(function(ddBuf) {
    var ddView = new DataView(ddBuf);
    var info = parseDmDD_worker(ddView, endianness, fmt);
    var columns = info.columns;
    var maxLen = info.maxLen;
    var recsPerPage = info.recordsPerPage;
    var lastPage = info.lastPage;
    var lastRecInLast = info.lastRecordInLastPage;
    var totalRecords = lastPage > 1
      ? (lastPage - 2) * recsPerPage + lastRecInLast
      : lastRecInLast;

    var readNumFn = fmt === 'ep'
      ? function(dv, off) { return dv.getFloat64(off, isLE); }
      : function(dv, off) { return dv.getFloat32(off, isLE); };

    // Build CSV header line
    var headerParts = [];
    for (var hi = 0; hi < columns.length; hi++) {
      var cn = columns[hi].name;
      if (cn.indexOf(',') >= 0) cn = '"' + cn + '"';
      headerParts.push(cn);
    }
    var headerLine = headerParts.join(',') + '\n';

    var estSize = totalRecords * columns.length * 10;

    // Batched page reads: one ~2MB slice (≈1000 SP pages) per pull instead
    // of one page — a per-page slice().arrayBuffer() costs ~524k async
    // round-trips per GB. The synthesized CSV bytes are unchanged.
    var PAGES_PER_BATCH = Math.max(1, Math.floor((2 * 1024 * 1024) / pageSize));

    // stream() factory — creates a fresh ReadableStream each call
    function makeStream() {
      var curPage = 2;
      return new ReadableStream({
        start: function(controller) {
          var enc = new TextEncoder();
          controller.enqueue(enc.encode(headerLine));
        },
        pull: function(controller) {
          if (curPage > lastPage) {
            controller.close();
            return;
          }
          var batchStart = curPage;
          var batchEnd = Math.min(lastPage, batchStart + PAGES_PER_BATCH - 1);
          curPage = batchEnd + 1;
          var offset = (batchStart - 1) * pageSize;
          return file.slice(offset, batchEnd * pageSize).arrayBuffer().then(function(batchBuf) {
            var dv = new DataView(batchBuf);
            var lines = '';
            for (var pgIdx = batchStart; pgIdx <= batchEnd; pgIdx++) {
              var pageBase = (pgIdx - batchStart) * pageSize;
              // a truncated final page bounds its own records, as before
              var pageEnd = Math.min(batchBuf.byteLength, pageBase + pageSize);
              var recsThisPage = (pgIdx === lastPage) ? lastRecInLast : recsPerPage;
              for (var ri = 0; ri < recsThisPage; ri++) {
                var recStart = pageBase + ri * maxLen * ws;
                var fields = [];
                for (var ci = 0; ci < columns.length; ci++) {
                  var col = columns[ci];
                  if (col.isConstant) {
                    var cv = col.constantValue || '';
                    if (cv.indexOf(',') >= 0) cv = '"' + cv + '"';
                    fields.push(cv);
                    continue;
                  }
                  if (col.type === 'numeric') {
                    var nOff = recStart + (col.swPositions[0] - 1) * ws;
                    if (nOff + ws > pageEnd) { fields.push(''); continue; }
                    var v = readNumFn(dv, nOff);
                    if (Math.abs(v) > 9.9e29) fields.push('');
                    else fields.push(String(v));
                  } else {
                    var text = '';
                    for (var si = 0; si < col.swPositions.length; si++) {
                      var aOff = recStart + (col.swPositions[si] - 1) * ws;
                      if (aOff + 4 > pageEnd) continue;
                      for (var b = 0; b < 4; b++) {
                        var ch = dv.getUint8(aOff + b);
                        if (ch >= 32 && ch < 127) text += String.fromCharCode(ch);
                      }
                    }
                    text = text.trim();
                    if (text.indexOf(',') >= 0) text = '"' + text + '"';
                    fields.push(text);
                  }
                }
                lines += fields.join(',') + '\n';
              }
            }
            var enc = new TextEncoder();
            controller.enqueue(enc.encode(lines));
          });
        }
      });
    }

    return { stream: makeStream, size: estSize, name: file.name.replace(/\.dm$/i, '.csv') };
  });
}

// Pack preparation: per file, stream once computing the CRC-32 of the raw
// bytes and (optionally) a deflated copy via CompressionStream on a tee'd
// branch. Posts progress; returns [{crc, comp|null}] — comp is a Blob.
var _packCrcTable = null;
function packCrcUpdate(crc, bytes) {
  if (!_packCrcTable) {
    _packCrcTable = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      _packCrcTable[n] = c;
    }
  }
  for (var i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ _packCrcTable[(crc ^ bytes[i]) & 0xFF];
  return crc;
}

async function preparePack(data) {
  var files = data.files; // [{blob, deflate}]
  var totalBytes = 0;
  for (var bi = 0; bi < files.length; bi++) totalBytes += files[bi].blob.size;
  var done = 0, lastPct = -1;

  function progressTick(n) {
    done += n;
    var pct = totalBytes > 0 ? Math.round((done / totalBytes) * 100) : 100;
    if (pct !== lastPct) { lastPct = pct; self.postMessage({ type: 'pack-progress', percent: pct }); }
  }

  async function crcOfStream(rs) {
    var crc = -1;
    var reader = rs.getReader();
    while (true) {
      var r = await reader.read();
      if (r.done) break;
      crc = packCrcUpdate(crc, r.value);
      progressTick(r.value.length);
    }
    return (crc ^ -1) >>> 0;
  }

  try {
    var results = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (f.deflate && typeof CompressionStream !== 'undefined') {
        var tees = f.blob.stream().tee();
        var crcPromise = crcOfStream(tees[0]);
        var compPromise = new Response(tees[1].pipeThrough(new CompressionStream('deflate-raw'))).blob();
        results.push({ crc: await crcPromise, comp: await compPromise });
      } else {
        results.push({ crc: await crcOfStream(f.blob.stream()), comp: null });
      }
    }
    self.postMessage({ type: 'pack-prepared', results: results });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
}

self.onmessage = (e) => {
  if (e.data.mode === 'export') {
    exportCSV(e.data);
  } else if (e.data.mode === 'prepare-pack') {
    preparePack(e.data);
  } else if (e.data.mode === 'swath') {
    swathAnalysis(e.data);
  } else if (e.data.mode === 'declus') {
    declusAnalysis(e.data);
  } else if (e.data.mode === 'colvalues') {
    colValuesAnalysis(e.data);
  } else if (e.data.mode === 'section') {
    sectionAnalysis(e.data);
  } else if (e.data.mode === 'gt') {
    gtAnalysis(e.data);
  } else {
    const { file, xyzOverride, filter, typeOverrides, zipEntry, skipCols, colFilters, calcolCode, calcolMeta, groupBy, groupStatsCols, dxyzOverride, dmEndianness, dmFormat, rowVarOverride, weightColName, weightArray, weightArrayLabel } = e.data;
    analyze(file, xyzOverride, filter, typeOverrides, zipEntry, skipCols, colFilters, calcolCode, calcolMeta, groupBy, groupStatsCols, dxyzOverride, dmEndianness, dmFormat, rowVarOverride, weightColName, weightArray, weightArrayLabel);
  }
};
