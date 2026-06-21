// ─── @gcu/drillhole (REVERSE-VENDORED — lives here first) ───────────────
// A7 Phase 0 (docs/a7-drillhole-ingestion.md, D9: Arthur 2026-06-11).
// Developed in BMA in the upstream ext-source style; destined for
// auditable/ext/drillhole once it settles (the auditable repo has an
// active claude session — no concurrent edits there). Dee's inline
// desurvey (ext/dee/src/layers.js) adopts this lib after the transfer.
// App code calls via `Drillhole.*` only.
//
// Pure functions, zero DOM, zero deps. Conventions (D1):
// - azimuth: degrees clockwise from north
// - dip: MINING convention, positive down (normalizeSurveys() flips
//   neg-down files; detectDipConvention() infers from the median)
// - depths/lengths: any consistent unit (meters in practice)
// Oracle harness: experiments/drillhole-test.js (analytic arcs + hand
// fixtures — the DECLUS playbook).

// -- desurvey.js --

// Unit tangent from azimuth/dip (mining pos-down): x east, y north, z up.
function dhTangent(azDeg, dipDeg) {
  var az = azDeg * Math.PI / 180, dip = dipDeg * Math.PI / 180;
  var c = Math.cos(dip);
  return [Math.sin(az) * c, Math.cos(az) * c, -Math.sin(dip)];
}

// 'pos-down' (mining: +60 = 60° below horizontal) vs 'neg-down' (signed
// math: -60 = below). Inferred from the median dip — exploration holes
// point down, so the sign of the bulk tells the convention.
function dhDetectDipConvention(surveys) {
  var dips = [];
  for (var i = 0; i < surveys.length; i++) {
    var d = surveys[i].dip;
    if (typeof d === 'number' && isFinite(d) && d !== 0) dips.push(d);
  }
  if (dips.length === 0) return 'pos-down';
  dips.sort(function(a, b) { return a - b; });
  var med = dips[Math.floor(dips.length / 2)];
  return med < 0 ? 'neg-down' : 'pos-down';
}

// Sort, dedupe (last wins), normalize dip to pos-down, synthesize a station
// at depth 0 when the list starts deeper (copies the first attitude).
// Returns { stations: [{depth, az, dip}], dupCount, badCount }.
function dhNormalizeSurveys(rawSurveys, dipConvention) {
  var flip = dipConvention === 'neg-down' ? -1 : 1;
  var clean = [], badCount = 0;
  for (var i = 0; i < rawSurveys.length; i++) {
    var s = rawSurveys[i];
    var depth = s.depth, az = s.az, dip = s.dip * flip;
    if (!isFinite(depth) || depth < 0 || !isFinite(az) || !isFinite(dip) || Math.abs(dip) > 90.000001) {
      badCount++;
      continue;
    }
    clean.push({ depth: depth, az: az, dip: dip });
  }
  clean.sort(function(a, b) { return a.depth - b.depth; });
  var stations = [], dupCount = 0;
  for (var j = 0; j < clean.length; j++) {
    if (stations.length && Math.abs(stations[stations.length - 1].depth - clean[j].depth) < 1e-9) {
      stations[stations.length - 1] = clean[j]; // last wins
      dupCount++;
    } else {
      stations.push(clean[j]);
    }
  }
  if (stations.length && stations[0].depth > 1e-9) {
    stations.unshift({ depth: 0, az: stations[0].az, dip: stations[0].dip });
  }
  return { stations: stations, dupCount: dupCount, badCount: badCount };
}

// Desurvey one hole. Methods:
// - 'minimumCurvature' (default): circular-arc model, RF = (2/θ)·tan(θ/2)
// - 'balancedTangential': the same without RF — averages the two end
//   tangents per segment (matches legacy desurveys from several packages)
// - 'tangential': straight segments along the LOWER station's attitude
//   (sparse/legacy surveys; matches dee's simple-tangential seed)
// collar = [x, y, z]; stations from dhNormalizeSurveys (pos-down).
// Returns { method, depths, px, py, pz, tx, ty, tz } — tangents and the
// method ride along so dhPositionAt interpolates consistently.
function dhDesurveyHole(collar, stations, method) {
  method = method || 'minimumCurvature';
  var n = stations.length;
  var out = {
    method: method,
    depths: new Float64Array(n),
    px: new Float64Array(n), py: new Float64Array(n), pz: new Float64Array(n),
    tx: new Float64Array(n), ty: new Float64Array(n), tz: new Float64Array(n),
  };
  for (var i = 0; i < n; i++) {
    out.depths[i] = stations[i].depth;
    var t = dhTangent(stations[i].az, stations[i].dip);
    out.tx[i] = t[0]; out.ty[i] = t[1]; out.tz[i] = t[2];
  }
  out.px[0] = collar[0]; out.py[0] = collar[1]; out.pz[0] = collar[2];

  for (var k = 1; k < n; k++) {
    var dl = out.depths[k] - out.depths[k - 1];
    if (method === 'tangential') {
      out.px[k] = out.px[k - 1] + dl * out.tx[k];
      out.py[k] = out.py[k - 1] + dl * out.ty[k];
      out.pz[k] = out.pz[k - 1] + dl * out.tz[k];
    } else {
      var rf = 1; // balanced tangential
      if (method !== 'balancedTangential') {
        // minimum curvature: RF = (2/θ)·tan(θ/2)
        var dot = out.tx[k - 1] * out.tx[k] + out.ty[k - 1] * out.ty[k] + out.tz[k - 1] * out.tz[k];
        var dogleg = Math.acos(Math.max(-1, Math.min(1, dot)));
        rf = dogleg > 1e-6 ? (2 / dogleg) * Math.tan(dogleg / 2) : 1;
      }
      out.px[k] = out.px[k - 1] + 0.5 * dl * (out.tx[k - 1] + out.tx[k]) * rf;
      out.py[k] = out.py[k - 1] + 0.5 * dl * (out.ty[k - 1] + out.ty[k]) * rf;
      out.pz[k] = out.pz[k - 1] + 0.5 * dl * (out.tz[k - 1] + out.tz[k]) * rf;
    }
  }
  return out;
}

// Position at an arbitrary down-hole depth, consistent with the hole's
// desurvey method (depths between stations must land on the SAME path the
// stations were placed on):
// - minimumCurvature: arc-correct (D2) — the closed-form integral of the
//   slerp of the end tangents:
//   p(s) = p1 + L/(θ·sinθ)·[(cos(θ−φ) − cosθ)·d1 + (1 − cosφ)·d2], φ = θ·s/L
//   (at s = L this reduces to the RF endpoint formula; the harness pins
//   mid-segment points to an analytic circle at 1e-14)
// - tangential: straight along the lower station's attitude (how the
//   segment was built)
// - balancedTangential: linear along the segment chord
// Beyond the last station: straight extrapolation along the last tangent
// (standard practice — intervals routinely outrun the survey).
function dhPositionAt(hole, depth) {
  var d = hole.depths, n = d.length;
  if (n === 0) return null;
  if (depth <= d[0]) {
    var s0 = depth - d[0]; // above collar station (negative) — straight
    return [hole.px[0] + s0 * hole.tx[0], hole.py[0] + s0 * hole.ty[0], hole.pz[0] + s0 * hole.tz[0]];
  }
  if (depth >= d[n - 1]) {
    var sE = depth - d[n - 1];
    return [hole.px[n - 1] + sE * hole.tx[n - 1], hole.py[n - 1] + sE * hole.ty[n - 1], hole.pz[n - 1] + sE * hole.tz[n - 1]];
  }
  // binary search: segment [lo, lo+1] with d[lo] <= depth < d[lo+1]
  var lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    var mid = (lo + hi) >> 1;
    if (d[mid] <= depth) lo = mid; else hi = mid;
  }
  var L = d[lo + 1] - d[lo], s = depth - d[lo];
  if (L < 1e-12) return [hole.px[lo], hole.py[lo], hole.pz[lo]];

  if (hole.method === 'tangential') {
    return [
      hole.px[lo] + s * hole.tx[lo + 1],
      hole.py[lo] + s * hole.ty[lo + 1],
      hole.pz[lo] + s * hole.tz[lo + 1],
    ];
  }
  if (hole.method === 'balancedTangential') {
    var t = s / L;
    return [
      hole.px[lo] + t * (hole.px[lo + 1] - hole.px[lo]),
      hole.py[lo] + t * (hole.py[lo + 1] - hole.py[lo]),
      hole.pz[lo] + t * (hole.pz[lo + 1] - hole.pz[lo]),
    ];
  }

  var d1 = [hole.tx[lo], hole.ty[lo], hole.tz[lo]];
  var d2 = [hole.tx[lo + 1], hole.ty[lo + 1], hole.tz[lo + 1]];
  var dot = d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2];
  var theta = Math.acos(Math.max(-1, Math.min(1, dot)));
  if (theta < 1e-9) {
    return [hole.px[lo] + s * d1[0], hole.py[lo] + s * d1[1], hole.pz[lo] + s * d1[2]];
  }
  var phi = theta * s / L;
  var k = L / (theta * Math.sin(theta));
  var a = (Math.cos(theta - phi) - Math.cos(theta)) * k;
  var b = (1 - Math.cos(phi)) * k;
  return [
    hole.px[lo] + a * d1[0] + b * d2[0],
    hole.py[lo] + a * d1[1] + b * d2[1],
    hole.pz[lo] + a * d1[2] + b * d2[2],
  ];
}

// -- validate.js --

// Join + check the three tables. Nothing is silently dropped: every
// exclusion lands in the report with a count and a BHID list.
// tables = {
//   collars:  [{ bhid, x, y, z, eoh }],            // eoh optional/null
//   surveys:  [{ bhid, depth, az, dip }],           // dip raw (per file)
//   intervals: { bhid: [], from: [], to: [],
//                cols: [{ name, type: 'num'|'cat', values: [] }] }
// }
// opts = { dipConvention: 'auto'|'pos-down'|'neg-down', method }
function dhValidate(tables, opts) {
  opts = opts || {};
  var checks = {};
  function hit(id, label, bhid) {
    var c = checks[id];
    if (!c) { c = checks[id] = { id: id, label: label, count: 0, bhids: [] }; }
    c.count++;
    if (bhid != null && c.bhids.indexOf(bhid) < 0 && c.bhids.length < 200) c.bhids.push(bhid);
  }

  var dipConvention = opts.dipConvention || 'auto';
  if (dipConvention === 'auto') dipConvention = dhDetectDipConvention(tables.surveys || []);

  // collars
  var holes = {}; // bhid → { collar, eoh, surveys: [], iv: [indices] }
  var order = [];
  for (var ci = 0; ci < (tables.collars || []).length; ci++) {
    var c0 = tables.collars[ci];
    var bid = String(c0.bhid).trim();
    if (!bid) { hit('bad-collar', 'Collar rows with missing BHID or non-numeric coordinates', null); continue; }
    if (!isFinite(c0.x) || !isFinite(c0.y) || !isFinite(c0.z)) {
      hit('bad-collar', 'Collar rows with missing BHID or non-numeric coordinates', bid);
      continue;
    }
    if (holes[bid]) { hit('dup-collar', 'Duplicate collar BHIDs (first kept)', bid); continue; }
    holes[bid] = {
      bhid: bid, collar: [c0.x, c0.y, c0.z],
      eoh: isFinite(c0.eoh) ? c0.eoh : null,
      rawSurveys: [], iv: []
    };
    order.push(bid);
  }

  // surveys
  for (var si = 0; si < (tables.surveys || []).length; si++) {
    var s0 = tables.surveys[si];
    var sb = String(s0.bhid).trim();
    var h = holes[sb];
    if (!h) { hit('orphan-survey', 'Survey rows whose BHID has no collar (excluded)', sb); continue; }
    h.rawSurveys.push({ depth: s0.depth, az: s0.az, dip: s0.dip });
  }

  // intervals
  var iv = tables.intervals || { bhid: [], from: [], to: [], cols: [] };
  var nIv = iv.bhid.length;
  for (var ii = 0; ii < nIv; ii++) {
    var ib = String(iv.bhid[ii]).trim();
    var h2 = holes[ib];
    if (!h2) { hit('orphan-interval', 'Interval rows whose BHID has no collar (excluded)', ib); continue; }
    var f = iv.from[ii], t = iv.to[ii];
    if (!isFinite(f) || !isFinite(t) || f < 0 || t <= f) {
      hit('bad-interval', 'Interval rows with FROM ≥ TO, negative or non-numeric depths (excluded)', ib);
      continue;
    }
    h2.iv.push(ii);
  }

  // per-hole structure
  var ready = [];
  for (var oi = 0; oi < order.length; oi++) {
    var hh = holes[order[oi]];
    if (hh.iv.length === 0) { hit('collar-no-intervals', 'Collars with no interval rows (hole skipped)', hh.bhid); continue; }

    var norm = dhNormalizeSurveys(hh.rawSurveys, dipConvention);
    if (norm.badCount) for (var bi = 0; bi < norm.badCount; bi++) hit('bad-survey', 'Survey rows with non-numeric depth/azimuth or |dip| > 90 (excluded)', hh.bhid);
    if (norm.dupCount) for (var di = 0; di < norm.dupCount; di++) hit('dup-survey-depth', 'Duplicate survey depths in a hole (last kept)', hh.bhid);
    if (norm.stations.length === 0) {
      // no usable survey → straight down (counted, never silent)
      hit('collar-no-survey', 'Holes with no usable survey (desurveyed straight down)', hh.bhid);
      norm.stations = [{ depth: 0, az: 0, dip: 90 }];
    }
    hh.stations = norm.stations;

    // EOH advisories (kept, counted)
    if (hh.eoh != null) {
      var lastSurvey = norm.stations[norm.stations.length - 1].depth;
      if (lastSurvey > hh.eoh + 1e-9) hit('past-eoh', 'Survey or interval depths past the collar EOH (kept — EOH is advisory)', hh.bhid);
      for (var ei = 0; ei < hh.iv.length; ei++) {
        if (iv.to[hh.iv[ei]] > hh.eoh + 1e-9) {
          hit('past-eoh', 'Survey or interval depths past the collar EOH (kept — EOH is advisory)', hh.bhid);
          break;
        }
      }
    }

    // overlap flag (composited as-is; SUPPORT double-counts — flagged per hole)
    var idx = hh.iv.slice().sort(function(a, b) { return iv.from[a] - iv.from[b]; });
    for (var vi = 1; vi < idx.length; vi++) {
      if (iv.from[idx[vi]] < iv.to[idx[vi - 1]] - 1e-9) {
        hit('overlap', 'Holes with overlapping intervals (composited as-is; SUPPORT double-counts)', hh.bhid);
        break;
      }
    }
    hh.iv = idx;
    ready.push(hh);
  }

  return { holes: ready, checks: checks, dipConvention: dipConvention, intervals: iv };
}

// -- composite.js --

// Tidied mode of (TO−FROM) — the default composite length (D3; a seed,
// always user-editable).
function dhDefaultLength(intervals) {
  var counts = {};
  var n = intervals.from.length; // only FROM/TO matter — callers may omit bhid
  for (var i = 0; i < n; i++) {
    var len = intervals.to[i] - intervals.from[i];
    if (!isFinite(len) || len <= 0) continue;
    var key = (Math.round(len * 100) / 100).toFixed(2); // 1cm buckets
    counts[key] = (counts[key] || 0) + 1;
  }
  var best = null, bestN = 0;
  for (var k in counts) { if (counts[k] > bestN) { bestN = counts[k]; best = parseFloat(k); } }
  return best || 1;
}

// Fixed-length down-hole composites over validated holes.
// opts = { length, domainColName|null, minCoverage (0..1)|null }
// Numeric: length-weighted mean over covered length WITH a value (missing
// assays shrink that column's weight, never poison the mean; no value in
// the window → null). Categorical: majority by covered length (D6).
// SUPPORT = total covered length (D5: low coverage emitted, not dropped;
// the optional minCoverage filter is visible and counted). XYZ = the
// covered-length centroid depth on the desurveyed path.
function dhComposite(validated, opts) {
  var ivt = validated.intervals;
  var cols = ivt.cols || [];
  var L = opts.length;
  var domainIdx = -1, densityIdx = -1;
  for (var dci = 0; dci < cols.length; dci++) {
    if (opts.domainColName && cols[dci].name === opts.domainColName) domainIdx = dci;
    // A11 P3: optional mass weighting — numeric means weight by length × density
    // (the density column itself stays length-weighted). Missing density on an
    // interval excludes it from mass-weighting and is counted (never silent).
    if (opts.densityColName && cols[dci].name === opts.densityColName && cols[dci].type === 'num') densityIdx = dci;
  }
  // A11 P3: per-column combine rules keyed by column name. Numeric: 'mean'
  // (default, length/mass-weighted), 'sum' (Σ length×value), 'min', 'max'.
  // Categorical: 'majority' (default, by covered length), 'first' (shallowest).
  // An unknown rule for a column's type falls back to that type's default.
  var combineMap = opts.combine || {};
  var checks = validated.checks;
  function hit(id, label, bhid) {
    var c = checks[id];
    if (!c) { c = checks[id] = { id: id, label: label, count: 0, bhids: [] }; }
    c.count++;
    if (bhid != null && c.bhids.indexOf(bhid) < 0 && c.bhids.length < 200) c.bhids.push(bhid);
  }

  var header = ['BHID', 'X', 'Y', 'Z', 'FROM', 'TO', 'SUPPORT'];
  for (var hc = 0; hc < cols.length; hc++) header.push(cols[hc].name);
  var rows = [];

  for (var hI = 0; hI < validated.holes.length; hI++) {
    var hole = validated.holes[hI];
    var path = dhDesurveyHole(hole.collar, hole.stations, opts.method);
    var idx = hole.iv; // sorted by FROM

    // domain runs: contiguous spans sharing the domain value (D4) —
    // composites restart at every change; without a domain column the
    // whole hole is one run. Run extent = min(FROM)…max(TO) over the run
    // (sorted by FROM, so max(TO) needs a scan — an early long interval
    // can outrun the last one).
    function makeRun(slice) {
      var maxTo = -Infinity;
      for (var mi = 0; mi < slice.length; mi++) maxTo = Math.max(maxTo, ivt.to[slice[mi]]);
      return { from: ivt.from[slice[0]], to: maxTo, idx: slice };
    }
    var runs = [];
    if (domainIdx < 0) {
      runs.push(makeRun(idx));
    } else {
      var runStart = 0;
      for (var ri = 1; ri <= idx.length; ri++) {
        var changed = ri === idx.length ||
          String(cols[domainIdx].values[idx[ri]]) !== String(cols[domainIdx].values[idx[runStart]]);
        if (changed) {
          runs.push(makeRun(idx.slice(runStart, ri)));
          runStart = ri;
        }
      }
    }

    for (var rI = 0; rI < runs.length; rI++) {
      var run = runs[rI];
      var nWin = Math.ceil((run.to - run.from - 1e-9) / L);
      for (var wI = 0; wI < nWin; wI++) {
        var w0 = run.from + wI * L; // index-stepped: no float drift over long holes
        var w1 = Math.min(w0 + L, run.to);
        var covered = 0, centroidW = 0, hadMissingDensity = false;
        var numW = new Float64Array(cols.length);
        var numSum = new Float64Array(cols.length);
        var numLSum = new Float64Array(cols.length);     // Σ length×value (for 'sum')
        var numMin = new Float64Array(cols.length);
        var numMax = new Float64Array(cols.length);
        var seenNum = new Uint8Array(cols.length);
        var catW = [], catFirst = []; // per col: {value → weight}, and first value by depth
        for (var ci2 = 0; ci2 < cols.length; ci2++) { catW.push(null); catFirst.push(undefined); numMin[ci2] = Infinity; numMax[ci2] = -Infinity; }

        for (var k2 = 0; k2 < run.idx.length; k2++) {
          var r = run.idx[k2];
          var ovFrom = Math.max(w0, ivt.from[r]);
          var ovTo = Math.min(w1, ivt.to[r]);
          var ov = ovTo - ovFrom;
          if (ov <= 1e-12) continue;
          covered += ov;
          centroidW += ov * (ovFrom + ovTo) / 2;
          // mass weight for numeric grades when a density column is set; the
          // density column itself stays length-weighted (no self-reference).
          var massW = ov;
          if (densityIdx >= 0) {
            var dval = cols[densityIdx].values[r];
            if (typeof dval === 'number' && isFinite(dval) && dval > 0) massW = ov * dval;
            else { massW = 0; hadMissingDensity = true; }
          }
          for (var c3 = 0; c3 < cols.length; c3++) {
            var v = cols[c3].values[r];
            if (cols[c3].type === 'num') {
              var nw = (c3 === densityIdx) ? ov : massW;   // density col: length-weighted
              if (typeof v === 'number' && isFinite(v)) {
                numW[c3] += nw; numSum[c3] += nw * v;       // weighted mean
                numLSum[c3] += ov * v;                       // length integral (sum)
                if (v < numMin[c3]) numMin[c3] = v;
                if (v > numMax[c3]) numMax[c3] = v;
                seenNum[c3] = 1;
              }
            } else {
              if (v != null && v !== '') {
                if (!catW[c3]) catW[c3] = {};
                var sk = String(v);
                catW[c3][sk] = (catW[c3][sk] || 0) + ov;
                if (catFirst[c3] === undefined) catFirst[c3] = sk;   // run is FROM-sorted → shallowest first
              }
            }
          }
        }
        if (covered <= 1e-12) continue; // window entirely in a gap — nothing to emit

        if (opts.minCoverage && covered / (w1 - w0) < opts.minCoverage) {
          hit('low-coverage-filtered', 'Composites below the min-coverage filter (dropped — filter is user-set)', hole.bhid);
          continue;
        }
        if (hadMissingDensity) hit('missing-density', 'Composites with intervals lacking usable density (excluded from mass-weighting)', hole.bhid);

        var midDepth = centroidW / covered;
        var pos = dhPositionAt(path, midDepth);
        var row = [hole.bhid, pos[0], pos[1], pos[2], w0, w1, covered];
        for (var c4 = 0; c4 < cols.length; c4++) {
          if (cols[c4].type === 'num') {
            var nrule = combineMap[cols[c4].name];
            if (nrule === 'sum') row.push(seenNum[c4] ? numLSum[c4] : null);
            else if (nrule === 'min') row.push(seenNum[c4] ? numMin[c4] : null);
            else if (nrule === 'max') row.push(seenNum[c4] ? numMax[c4] : null);
            else row.push(numW[c4] > 0 ? numSum[c4] / numW[c4] : null);   // 'mean' (default)
          } else {
            if (combineMap[cols[c4].name] === 'first') { row.push(catFirst[c4] !== undefined ? catFirst[c4] : null); continue; }
            var bag = catW[c4];
            if (!bag) { row.push(null); continue; }
            var bestV = null, bestW = -1, total = 0;
            for (var key2 in bag) { total += bag[key2]; if (bag[key2] > bestW) { bestW = bag[key2]; bestV = key2; } }
            if (bestW < total - 1e-9) hit('mixed-domain', 'Composites whose categorical majority is < 100% of covered length', hole.bhid);
            row.push(bestV);
          }
        }
        rows.push(row);
      }
    }
  }

  return { header: header, rows: rows };
}

// -- process.js --

// One-call pipeline: validate → desurvey → composite. What BMA's Aux
// ingestion calls; everything else is exposed for tests and future reuse.
// Returns { header, rows, report }.
function dhProcess(tables, opts) {
  opts = opts || {};
  var validated = dhValidate(tables, opts);
  var length = (typeof opts.compositeLength === 'number' && opts.compositeLength > 0)
    ? opts.compositeLength
    : dhDefaultLength(validated.intervals);
  var result = dhComposite(validated, {
    length: length,
    method: opts.method || 'minimumCurvature',
    domainColName: opts.domainCol || null,
    densityColName: opts.densityCol || null,
    combine: opts.combine || null,
    minCoverage: opts.minCoverage || null,
  });
  var checkList = [];
  for (var k in validated.checks) checkList.push(validated.checks[k]);
  return {
    header: result.header,
    rows: result.rows,
    report: {
      checks: checkList,
      nHoles: validated.holes.length,
      nComposites: result.rows.length,
      dipConvention: validated.dipConvention,
      compositeLength: length,
    },
  };
}

// -- main.js --

const Drillhole = {
  tangent: dhTangent,
  detectDipConvention: dhDetectDipConvention,
  normalizeSurveys: dhNormalizeSurveys,
  desurveyHole: dhDesurveyHole,
  positionAt: dhPositionAt,
  validate: dhValidate,
  defaultLength: dhDefaultLength,
  composite: dhComposite,
  process: dhProcess,
};

// (Reverse vendoring: no export statement — BMA concatenates modules into
// one script. The upstream transfer adds `export { ... }` in main.js.)
