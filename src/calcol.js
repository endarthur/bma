// ─── Calcol UI — Code Editor with Variable Browser ───────────────────

const MATH_PREAMBLE_MAIN = 'const {abs,sqrt,pow,log,log2,log10,exp,min,max,round,floor,ceil,sign,trunc,hypot,sin,cos,tan,asin,acos,atan,atan2,PI,E}=Math;const fn={cap:(v,lo,hi)=>v==null?null:hi===undefined?Math.min(v,lo):Math.min(Math.max(v,lo),hi),ifnull:(v,d)=>(v==null||v!==v)?d:v,between:(v,lo,hi)=>v!=null&&v>=lo&&v<=hi,remap:(v,m,d)=>m.hasOwnProperty(v)?m[v]:(d!==undefined?d:null),round:(v,n)=>{const f=Math.pow(10,n||0);return Math.round(v*f)/f;},clamp:(v,lo,hi)=>Math.min(Math.max(v,lo),hi),isnum:(v)=>Number.isFinite(v),ifnum:(v,d)=>Number.isFinite(v)?v:(d!==undefined?d:NaN)};const clamp=fn.clamp;const cap=fn.cap;const ifnull=fn.ifnull;const between=fn.between;const remap=fn.remap;const isnum=fn.isnum;const ifnum=fn.ifnum;';

// Math functions available in expressions (for autocomplete and sidebar)
const MATH_COMPLETIONS = [
  { label: 'abs(x)', insert: 'abs(', desc: 'absolute value' },
  { label: 'sqrt(x)', insert: 'sqrt(', desc: 'square root' },
  { label: 'pow(x, n)', insert: 'pow(', desc: 'x to the power n' },
  { label: 'log(x)', insert: 'log(', desc: 'natural log' },
  { label: 'log2(x)', insert: 'log2(', desc: 'log base 2' },
  { label: 'log10(x)', insert: 'log10(', desc: 'log base 10' },
  { label: 'exp(x)', insert: 'exp(', desc: 'e^x' },
  { label: 'min(a, b)', insert: 'min(', desc: 'minimum' },
  { label: 'max(a, b)', insert: 'max(', desc: 'maximum' },
  { label: 'round(x)', insert: 'round(', desc: 'round to integer' },
  { label: 'floor(x)', insert: 'floor(', desc: 'round down' },
  { label: 'ceil(x)', insert: 'ceil(', desc: 'round up' },
  { label: 'sign(x)', insert: 'sign(', desc: '-1, 0, or 1' },
  { label: 'trunc(x)', insert: 'trunc(', desc: 'integer part' },
  { label: 'clamp(v, lo, hi)', insert: 'clamp(', desc: 'constrain to range' },
  { label: 'cap(v, hi)', insert: 'cap(', desc: 'cap at maximum' },
  { label: 'ifnull(v, default)', insert: 'ifnull(', desc: 'default for null/NaN' },
  { label: 'ifnum(v, default)', insert: 'ifnum(', desc: 'default for non-finite' },
  { label: 'isnum(v)', insert: 'isnum(', desc: 'true if finite number' },
  { label: 'between(v, lo, hi)', insert: 'between(', desc: 'boolean range test' },
  { label: 'remap(v, map)', insert: 'remap(', desc: 'lookup table' },
  { label: 'fn.round(v, n)', insert: 'fn.round(', desc: 'round to n decimals' },
  { label: 'PI', insert: 'PI', desc: '3.14159...' },
  { label: 'E', insert: 'E', desc: '2.71828...' },
];

// ── Syntax Highlighter ────────────────────────────────────────────────
const HL_KEYWORDS = new Set(['if','else','for','while','do','switch','case','break','continue','return','const','let','var','of','in','new','typeof','instanceof','null','undefined','true','false','NaN','Infinity']);
const HL_BUILTINS = new Set(['abs','sqrt','pow','log','log2','log10','exp','min','max','round','floor','ceil','sign','trunc','hypot','clamp','cap','ifnull','ifnum','isnum','between','remap','PI','E','fn','String','Number','Boolean','parseInt','parseFloat','isNaN','isFinite','Math']);

function highlightCode(code) {
  if (!code) return '\n'; // ensure pre has content for sizing
  const rv = currentRowVar || 'r';
  let html = '';
  let i = 0;
  const len = code.length;
  while (i < len) {
    const ch = code[i];
    // Comments
    if (ch === '/' && i + 1 < len && code[i + 1] === '/') {
      let end = code.indexOf('\n', i);
      if (end < 0) end = len;
      html += '<span class="hl-comment">' + esc(code.substring(i, end)) + '</span>';
      i = end;
      continue;
    }
    if (ch === '/' && i + 1 < len && code[i + 1] === '*') {
      let end = code.indexOf('*/', i + 2);
      if (end < 0) end = len; else end += 2;
      html += '<span class="hl-comment">' + esc(code.substring(i, end)) + '</span>';
      i = end;
      continue;
    }
    // Strings
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < len && code[j] !== ch) {
        if (code[j] === '\\') j++;
        j++;
      }
      if (j < len) j++;
      html += '<span class="hl-string">' + esc(code.substring(i, j)) + '</span>';
      i = j;
      continue;
    }
    // Numbers
    if ((ch >= '0' && ch <= '9') || (ch === '.' && i + 1 < len && code[i + 1] >= '0' && code[i + 1] <= '9')) {
      let j = i;
      if (ch === '0' && j + 1 < len && (code[j + 1] === 'x' || code[j + 1] === 'X')) {
        j += 2;
        while (j < len && /[0-9a-fA-F]/.test(code[j])) j++;
      } else {
        while (j < len && ((code[j] >= '0' && code[j] <= '9') || code[j] === '.')) j++;
        if (j < len && (code[j] === 'e' || code[j] === 'E')) {
          j++;
          if (j < len && (code[j] === '+' || code[j] === '-')) j++;
          while (j < len && code[j] >= '0' && code[j] <= '9') j++;
        }
      }
      html += '<span class="hl-number">' + esc(code.substring(i, j)) + '</span>';
      i = j;
      continue;
    }
    // Identifiers / keywords / r. access
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$') {
      let j = i + 1;
      while (j < len && ((code[j] >= 'a' && code[j] <= 'z') || (code[j] >= 'A' && code[j] <= 'Z') || (code[j] >= '0' && code[j] <= '9') || code[j] === '_' || code[j] === '$')) j++;
      const word = code.substring(i, j);
      if (word === rv && j < len && (code[j] === '.' || code[j] === '[')) {
        // r.xxx or r[...] — highlight as row access
        let end = j;
        if (code[j] === '.') {
          end++;
          while (end < len && ((code[end] >= 'a' && code[end] <= 'z') || (code[end] >= 'A' && code[end] <= 'Z') || (code[end] >= '0' && code[end] <= '9') || code[end] === '_')) end++;
        } else if (code[j] === '[') {
          end++;
          let depth = 1;
          while (end < len && depth > 0) {
            if (code[end] === '[') depth++;
            else if (code[end] === ']') depth--;
            if (depth > 0) end++;
          }
          if (end < len) end++;
        }
        html += '<span class="hl-rowaccess">' + esc(code.substring(i, end)) + '</span>';
        i = end;
      } else if (HL_KEYWORDS.has(word)) {
        html += '<span class="hl-keyword">' + esc(word) + '</span>';
        i = j;
      } else if (HL_BUILTINS.has(word)) {
        html += '<span class="hl-function">' + esc(word) + '</span>';
        i = j;
      } else {
        html += '<span class="hl-text">' + esc(word) + '</span>';
        i = j;
      }
      continue;
    }
    // Operators
    if ('=<>!&|+-*/%?:'.indexOf(ch) >= 0) {
      html += '<span class="hl-operator">' + esc(ch) + '</span>';
      i++;
      continue;
    }
    // Punctuation (semicolons, brackets, commas, dots)
    if (';{}()[],'.indexOf(ch) >= 0) {
      html += '<span class="hl-punct">' + esc(ch) + '</span>';
      i++;
      continue;
    }
    // Standalone dot (method calls, etc.)
    if (ch === '.') {
      html += '<span class="hl-punct">.</span>';
      i++;
      continue;
    }
    // Whitespace and other chars
    html += esc(ch);
    i++;
  }
  return html + '\n'; // trailing newline keeps pre sized correctly
}

// ── Code Editor Controller ────────────────────────────────────────────
let calcolSimTimer = null;

function syncCodeHighlight() {
  $calcolCodePre.innerHTML = highlightCode($calcolCodeArea.value);
}

function syncCodeScroll() {
  $calcolCodePre.scrollTop = $calcolCodeArea.scrollTop;
  $calcolCodePre.scrollLeft = $calcolCodeArea.scrollLeft;
}

// ── Calcol Autocomplete ──────────────────────────────────────────────
var calcolAcItems = [];
var calcolAcSelected = -1;
var calcolAcMirror = null;

function getEditorTokenAtCursor() {
  var pos = $calcolCodeArea.selectionStart;
  var text = $calcolCodeArea.value.substring(0, pos);
  // Only scan current line
  var lineStart = text.lastIndexOf('\n') + 1;
  var lineText = text.substring(lineStart);
  var rv = currentRowVar || 'r';
  var pat = new RegExp('(?:' + rv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.)?([a-zA-Z_][a-zA-Z0-9_]*)$');
  var match = lineText.match(pat);
  if (!match) return { token: '', start: pos, hasPrefix: false, fullLen: 0 };
  var full = match[0];
  var hasPrefix = full.indexOf(rv + '.') === 0;
  var token = match[1];
  var start = pos - full.length;
  return { token: token, start: start, hasPrefix: hasPrefix, fullLen: full.length };
}

function calcolAcPosition() {
  // Create mirror div to measure cursor position
  if (!calcolAcMirror) {
    calcolAcMirror = document.createElement('div');
    calcolAcMirror.style.cssText = 'position:absolute;top:0;left:0;visibility:hidden;white-space:pre-wrap;word-wrap:break-word;overflow:hidden;pointer-events:none;';
    document.body.appendChild(calcolAcMirror);
  }
  var cs = getComputedStyle($calcolCodeArea);
  calcolAcMirror.style.fontFamily = cs.fontFamily;
  calcolAcMirror.style.fontSize = cs.fontSize;
  calcolAcMirror.style.lineHeight = cs.lineHeight;
  calcolAcMirror.style.padding = cs.padding;
  calcolAcMirror.style.tabSize = cs.tabSize;
  calcolAcMirror.style.width = $calcolCodeArea.clientWidth + 'px';

  var pos = $calcolCodeArea.selectionStart;
  var textBefore = $calcolCodeArea.value.substring(0, pos);
  calcolAcMirror.textContent = '';
  // Split into pre-text and marker
  var textNode = document.createTextNode(textBefore);
  var marker = document.createElement('span');
  marker.textContent = '|';
  calcolAcMirror.appendChild(textNode);
  calcolAcMirror.appendChild(marker);

  var wrap = $calcolCodeArea.parentElement; // .calcol-code-wrap
  var markerTop = marker.offsetTop;
  var markerLeft = marker.offsetLeft;

  // Adjust for textarea scroll
  var top = markerTop - $calcolCodeArea.scrollTop;
  var left = markerLeft - $calcolCodeArea.scrollLeft;

  // Position popup below cursor line
  var lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.6;
  $calcolAc.style.top = (top + lineHeight) + 'px';
  $calcolAc.style.left = Math.min(left, wrap.clientWidth - 220) + 'px';
}

function calcolAcShow() {
  var tok = getEditorTokenAtCursor();
  if (!tok.token || tok.token.length < 1) { calcolAcHide(); return; }
  var lc = tok.token.toLowerCase();
  calcolAcItems = buildExprAcItems().filter(function(it) {
    var target = it.kind === 'col' || it.kind === 'calc' ? it.label : it.insert;
    return target.toLowerCase().indexOf(lc) === 0 || it.label.toLowerCase().indexOf(lc) === 0;
  }).slice(0, 10);
  if (calcolAcItems.length === 0) { calcolAcHide(); return; }
  calcolAcSelected = 0;
  calcolAcRender();
  calcolAcPosition();
  $calcolAc.classList.add('open');
}

function calcolAcHide() {
  $calcolAc.classList.remove('open');
  calcolAcItems = [];
  calcolAcSelected = -1;
}

function calcolAcRender() {
  $calcolAc.innerHTML = calcolAcItems.map(function(it, i) {
    var cls = it.kind === 'col' ? 'ac-col' : it.kind === 'calc' ? 'ac-calc' : 'ac-fn';
    return '<div class="ac-item ' + cls + (i === calcolAcSelected ? ' selected' : '') + '" data-idx="' + i + '">' +
      '<span class="ac-label">' + esc(it.label) + '</span>' +
      (it.desc ? '<span class="ac-desc">' + esc(it.desc) + '</span>' : '') +
      '</div>';
  }).join('');
  $calcolAc.querySelectorAll('.ac-item').forEach(function(el) {
    el.addEventListener('mousedown', function(e) {
      e.preventDefault();
      calcolAcAccept(parseInt(el.dataset.idx));
    });
  });
}

function calcolAcAccept(idx) {
  var item = calcolAcItems[idx];
  if (!item) return;
  var tok = getEditorTokenAtCursor();
  $calcolCodeArea.focus();
  $calcolCodeArea.selectionStart = tok.start;
  $calcolCodeArea.selectionEnd = tok.start + tok.fullLen;
  document.execCommand('insertText', false, item.insert);
  calcolAcHide();
  currentCalcolCode = $calcolCodeArea.value;
  syncCodeHighlight();
  clearTimeout(calcolSimTimer);
  calcolSimTimer = setTimeout(simulateCalcol, 600);
  markAnalysisStale();
}

function calcolAcIsOpen() {
  return $calcolAc.classList.contains('open') && calcolAcItems.length > 0;
}

function initCalcolEditor() {
  // Sync highlight on input
  $calcolCodeArea.addEventListener('input', function() {
    syncCodeHighlight();
    currentCalcolCode = $calcolCodeArea.value;
    $calcolError.textContent = '';
    clearTimeout(calcolSimTimer);
    calcolSimTimer = setTimeout(simulateCalcol, 600);
    markAnalysisStale();
    autoSaveProject();
    calcolAcShow();
  });

  // Sync scroll — also reposition autocomplete
  $calcolCodeArea.addEventListener('scroll', function() {
    syncCodeScroll();
    if (calcolAcIsOpen()) calcolAcPosition();
  });

  // Keyboard handling
  $calcolCodeArea.addEventListener('keydown', function(e) {
    // Autocomplete navigation
    if (calcolAcIsOpen()) {
      if (e.key === 'ArrowDown') { e.preventDefault(); calcolAcSelected = (calcolAcSelected + 1) % calcolAcItems.length; calcolAcRender(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); calcolAcSelected = (calcolAcSelected - 1 + calcolAcItems.length) % calcolAcItems.length; calcolAcRender(); return; }
      if (e.key === 'Enter' || (e.key === 'Tab' && calcolAcSelected >= 0)) { e.preventDefault(); calcolAcAccept(calcolAcSelected); return; }
      if (e.key === 'Escape') { e.preventDefault(); calcolAcHide(); return; }
    }
    // Tab key inserts 2 spaces (when autocomplete not open)
    if (e.key === 'Tab') {
      e.preventDefault();
      document.execCommand('insertText', false, '  ');
      syncCodeHighlight();
      currentCalcolCode = this.value;
    }
    // Ctrl+Space triggers autocomplete
    if (e.key === ' ' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      calcolAcShow();
    }
  });

  // Dismiss autocomplete on blur
  $calcolCodeArea.addEventListener('blur', function() {
    setTimeout(calcolAcHide, 150);
  });

  // Simulate button
  $calcolSimBtn.addEventListener('click', simulateCalcol);

  // Render function list in sidebar
  renderFunctionList();

  // Initial highlight
  syncCodeHighlight();
}

// ── Variable Browser ──────────────────────────────────────────────────
function renderVariableBrowser() {
  var hdr = preflightData ? preflightData.header : currentHeader;
  var types = preflightData ? (preflightData.autoTypes || []) : currentColTypes;
  var typeOv = preflightData ? (preflightData.typeOverrides || {}) : {};
  if (!hdr || hdr.length === 0) {
    $calcolVarList.innerHTML = '<div class="calcol-empty-hint">No file loaded.</div>';
    return;
  }
  var search = $calcolVarSearch.value.toLowerCase();
  var stats = lastCompleteData ? lastCompleteData.stats : null;
  var cats = lastCompleteData ? lastCompleteData.categories : null;
  var rv = currentRowVar || 'r';
  var html = '';
  for (var i = 0; i < hdr.length; i++) {
    var name = hdr[i];
    if (search && name.toLowerCase().indexOf(search) === -1) continue;
    var type = typeOv[i] || types[i] || 'numeric';
    var isNum = type === 'numeric';
    var typeTag = isNum ? '<span class="cv-type num">NUM</span>' : '<span class="cv-type cat">CAT</span>';
    html += '<div class="calcol-var-item" data-idx="' + i + '" data-name="' + esc(name) + '">';
    html += '<span class="cv-toggle" data-idx="' + i + '">\u25B8</span>';
    html += '<span class="cv-name">' + esc(name) + '</span>';
    html += typeTag;
    html += '</div>';
    // Detail panel (hidden by default)
    html += '<div class="calcol-var-detail" id="cvDetail' + i + '">';
    if (stats && stats[i] && isNum) {
      var s = stats[i];
      html += '<div class="cv-stat"><span class="cv-stat-label">min:</span><span class="cv-stat-value">' + formatNum(s.min) + '</span></div>';
      html += '<div class="cv-stat"><span class="cv-stat-label">max:</span><span class="cv-stat-value">' + formatNum(s.max) + '</span></div>';
      html += '<div class="cv-stat"><span class="cv-stat-label">mean:</span><span class="cv-stat-value">' + formatNum(s.mean) + '</span></div>';
      html += '<div class="cv-stat"><span class="cv-stat-label">nulls:</span><span class="cv-stat-value">' + s.nulls + '</span></div>';
    } else if (cats && cats[i] && !isNum) {
      var entries = Object.entries(cats[i].counts).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 8);
      for (var ei = 0; ei < entries.length; ei++) {
        html += '<div class="cv-cat-val" data-val="' + esc(entries[ei][0]) + '">' + esc(entries[ei][0]) + ' <span style="color:var(--fg-dim)">(' + entries[ei][1] + ')</span></div>';
      }
    } else {
      html += '<div style="color:var(--fg-dim)">Run analysis for stats</div>';
    }
    html += '</div>';
  }
  $calcolVarList.innerHTML = html;

  // Wire click events
  $calcolVarList.querySelectorAll('.calcol-var-item').forEach(function(el) {
    // Click on name inserts r.colName at cursor
    el.querySelector('.cv-name').addEventListener('click', function() {
      var name = el.dataset.name;
      var insert = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) ? rv + '.' + name : rv + '["' + name + '"]';
      insertAtCursor(insert);
    });
    // Click on toggle expands detail
    el.querySelector('.cv-toggle').addEventListener('click', function(e) {
      e.stopPropagation();
      var idx = el.dataset.idx;
      var detail = document.getElementById('cvDetail' + idx);
      var isOpen = detail.classList.contains('open');
      // Close all first
      $calcolVarList.querySelectorAll('.calcol-var-detail.open').forEach(function(d) { d.classList.remove('open'); });
      $calcolVarList.querySelectorAll('.cv-toggle').forEach(function(t) { t.textContent = '\u25B8'; });
      if (!isOpen) {
        detail.classList.add('open');
        this.textContent = '\u25BE';
      }
    });
  });

  // Wire category value clicks to insert literals
  $calcolVarList.querySelectorAll('.cv-cat-val').forEach(function(el) {
    el.addEventListener('click', function() {
      insertAtCursor("'" + el.dataset.val.replace(/'/g, "\\'") + "'");
    });
  });
}

function renderFunctionList() {
  var html = '';
  for (var i = 0; i < MATH_COMPLETIONS.length; i++) {
    var m = MATH_COMPLETIONS[i];
    html += '<div class="calcol-fn-item" data-insert="' + esc(m.insert) + '">';
    html += '<span class="cfn-name">' + esc(m.label) + '</span>';
    html += '<span class="cfn-desc">' + esc(m.desc) + '</span>';
    html += '</div>';
  }
  $calcolFnList.innerHTML = html;
  $calcolFnList.querySelectorAll('.calcol-fn-item').forEach(function(el) {
    el.addEventListener('click', function() {
      insertAtCursor(el.dataset.insert);
    });
  });
}

function insertAtCursor(text) {
  $calcolCodeArea.focus();
  document.execCommand('insertText', false, text);
  currentCalcolCode = $calcolCodeArea.value;
  syncCodeHighlight();
  clearTimeout(calcolSimTimer);
  calcolSimTimer = setTimeout(simulateCalcol, 600);
  markAnalysisStale();
}

// Variable search
if ($calcolVarSearch) {
  $calcolVarSearch.addEventListener('input', renderVariableBrowser);
}

// ── Simulate / Preview ────────────────────────────────────────────────
function getSampleRows() {
  var src = $calcolDataSrc ? $calcolDataSrc.value : 'preflight';
  if (src === 'simulated' && lastCompleteData) {
    return generateSyntheticRows();
  }
  // Preflight sample rows
  if (!preflightData || !preflightData.sampleRows) return [];
  var hdr = preflightData.header;
  var autoTypes = preflightData.autoTypes || [];
  var typeOv = preflightData.typeOverrides || {};
  var rv = currentRowVar || 'r';
  return preflightData.sampleRows.slice(0, 10).map(function(fields) {
    var obj = {};
    for (var i = 0; i < hdr.length; i++) {
      var raw = (fields[i] || '').trim().replace(/^["']|["']$/g, '');
      var type = typeOv[i] || autoTypes[i];
      obj[hdr[i]] = type === 'numeric' ? (raw === '' ? null : (isNaN(Number(raw)) ? raw : Number(raw))) : raw;
    }
    return obj;
  });
}

function generateSyntheticRows() {
  if (!lastCompleteData) return [];
  var data = lastCompleteData;
  var hdr = data.header;
  var colTypes = data.colTypes;
  var stats = data.stats;
  var cats = data.categories;
  var origCount = data.origColCount || hdr.length;
  var rows = [];
  for (var ri = 0; ri < 20; ri++) {
    var obj = {};
    for (var ci = 0; ci < origCount; ci++) {
      var name = hdr[ci];
      if (colTypes[ci] === 'numeric' && stats[ci]) {
        var s = stats[ci];
        if (s.centroids && s.centroids.length > 0) {
          // Weighted random from t-digest centroids
          var total = s.centroids.reduce(function(a, c) { return a + c[1]; }, 0);
          var r = Math.random() * total;
          var cum = 0;
          for (var k = 0; k < s.centroids.length; k++) {
            cum += s.centroids[k][1];
            if (r <= cum) { obj[name] = s.centroids[k][0]; break; }
          }
          if (obj[name] === undefined) obj[name] = s.mean;
        } else {
          obj[name] = s.mean;
        }
      } else if (colTypes[ci] === 'categorical' && cats[ci]) {
        var entries = Object.entries(cats[ci].counts);
        if (entries.length > 0) {
          var total2 = entries.reduce(function(a, e) { return a + e[1]; }, 0);
          var r2 = Math.random() * total2;
          var cum2 = 0;
          for (var k2 = 0; k2 < entries.length; k2++) {
            cum2 += entries[k2][1];
            if (r2 <= cum2) { obj[name] = entries[k2][0]; break; }
          }
          if (obj[name] === undefined) obj[name] = entries[0][0];
        } else {
          obj[name] = '';
        }
      } else {
        obj[name] = null;
      }
    }
    rows.push(obj);
  }
  return rows;
}

function simulateCalcol() {
  var code = currentCalcolCode.trim();
  if (!code) {
    currentCalcolMeta = [];
    $calcolDetected.innerHTML = '<div class="calcol-empty-hint">Write code and click Simulate to detect new columns.</div>';
    $calcolPreviewTable.innerHTML = '<div class="calcol-empty-hint">No preview yet.</div>';
    $calcolError.textContent = '';
    updateCalcolBadge();
    return;
  }

  var rv = currentRowVar || 'r';
  var hdr = preflightData ? preflightData.header : currentHeader;
  if (!hdr || hdr.length === 0) {
    $calcolError.textContent = 'No file loaded — load a CSV first.';
    return;
  }
  var origKeys = new Set(hdr);

  // Compile
  var calcolFn;
  try {
    calcolFn = new Function(rv, MATH_PREAMBLE_MAIN + code);
  } catch(e) {
    $calcolError.textContent = 'Syntax: ' + e.message;
    return;
  }

  // Run against sample rows
  var rows = getSampleRows();
  if (rows.length === 0) {
    $calcolError.textContent = 'No sample rows available.';
    return;
  }

  var detectedKeys = new Set();
  var previewRows = [];
  var errors = [];
  var metaCat = new Set();
  var metaNum = new Set();
  for (var ri = 0; ri < rows.length; ri++) {
    var obj = Object.assign({}, rows[ri]);
    obj.META = { cat: [], num: [] };
    try {
      calcolFn(obj);
    } catch(e) {
      if (errors.length < 3) errors.push('Row ' + (ri + 1) + ': ' + e.message);
      delete obj.META;
      previewRows.push(obj);
      continue;
    }
    // Collect META type overrides
    if (obj.META) {
      for (var mi2 = 0; mi2 < obj.META.cat.length; mi2++) metaCat.add(obj.META.cat[mi2]);
      for (var mi3 = 0; mi3 < obj.META.num.length; mi3++) metaNum.add(obj.META.num[mi3]);
    }
    delete obj.META;
    // Detect new keys
    var keys = Object.keys(obj);
    for (var ki = 0; ki < keys.length; ki++) {
      if (!origKeys.has(keys[ki])) detectedKeys.add(keys[ki]);
    }
    previewRows.push(obj);
  }

  if (errors.length > 0) {
    $calcolError.textContent = errors[0];
  } else {
    $calcolError.textContent = '';
  }

  // Auto-detect types
  var detectedArr = Array.from(detectedKeys);
  var meta = [];
  for (var di = 0; di < detectedArr.length; di++) {
    var name = detectedArr[di];
    var allNum = true;
    var hasValue = false;
    for (var ri2 = 0; ri2 < previewRows.length; ri2++) {
      var v = previewRows[ri2][name];
      if (v === null || v === undefined) continue;
      hasValue = true;
      if (typeof v === 'boolean') continue; // booleans count as numeric
      if (typeof v !== 'number' || isNaN(v)) { allNum = false; break; }
    }
    var autoType = (hasValue && allNum) ? 'numeric' : 'categorical';
    if (metaCat.has(name)) autoType = 'categorical';
    if (metaNum.has(name)) autoType = 'numeric';
    meta.push({ name: name, type: autoType });
  }

  currentCalcolMeta = meta;
  updateCalcolBadge();

  // Render detected columns
  if (meta.length === 0) {
    $calcolDetected.innerHTML = '<div class="calcol-empty-hint">No new columns detected. Assign properties to <code>' + rv + '</code>.</div>';
  } else {
    var dHtml = '';
    for (var mi = 0; mi < meta.length; mi++) {
      var m = meta[mi];
      var tc = m.type === 'numeric' ? 'num' : 'cat';
      var tl = m.type === 'numeric' ? 'NUM' : 'CAT';
      dHtml += '<div class="calcol-det-item"><span class="cd-name">' + esc(m.name) + '</span><span class="cd-type ' + tc + '">' + tl + '</span></div>';
    }
    $calcolDetected.innerHTML = dHtml;
  }

  // Render preview table
  if (meta.length === 0) {
    $calcolPreviewTable.innerHTML = '<div class="calcol-empty-hint">No new columns to preview.</div>';
  } else {
    var tHtml = '<table><thead><tr><th>#</th>';
    for (var hi = 0; hi < meta.length; hi++) {
      tHtml += '<th>' + esc(meta[hi].name) + '</th>';
    }
    tHtml += '</tr></thead><tbody>';
    var maxRows = Math.min(previewRows.length, 10);
    for (var pri = 0; pri < maxRows; pri++) {
      tHtml += '<tr><td style="color:var(--fg-dim)">' + (pri + 1) + '</td>';
      for (var ci = 0; ci < meta.length; ci++) {
        var val = previewRows[pri][meta[ci].name];
        var isErr = false;
        var display;
        if (val === null || val === undefined) {
          display = '<i style="color:var(--fg-dim)">null</i>';
        } else {
          display = esc(String(val));
        }
        tHtml += '<td>' + display + '</td>';
      }
      tHtml += '</tr>';
    }
    tHtml += '</tbody></table>';
    $calcolPreviewTable.innerHTML = tHtml;
  }
}

// ── Data Source Toggle ────────────────────────────────────────────────
if ($calcolDataSrc) {
  $calcolDataSrc.addEventListener('change', function() {
    simulateCalcol();
  });
}

function enableSimulatedDataSource() {
  if (!$calcolDataSrc) return;
  var opt = $calcolDataSrc.querySelector('option[value="simulated"]');
  if (opt) opt.disabled = false;
}

// ── Badge / Integration ───────────────────────────────────────────────
function updateCalcolBadge() {
  if (!$calcolBadge) return;
  $calcolBadge.textContent = currentCalcolMeta.length;
  var calcolTab = $resultsTabs.querySelector('[data-tab="calcols"]');
  if (calcolTab) calcolTab.innerHTML = 'Calc <span class="tab-badge">' + currentCalcolMeta.length + '</span>';
}

function setCalcolCode(code) {
  currentCalcolCode = code;
  if ($calcolCodeArea) {
    $calcolCodeArea.value = code;
    syncCodeHighlight();
  }
}

// ── Expression Input System (used by filter) ──────────────────────────

function getTokenAtCursor(el) {
  var pos = el.selectionStart;
  var text = el.value.substring(0, pos);
  var match = text.match(/(?:r\.)?([a-zA-Z_][a-zA-Z0-9_]*)$/);
  if (!match) return { token: '', start: pos, hasPrefix: false };
  var full = match[0];
  var hasPrefix = full.startsWith('r.');
  var token = match[1];
  var start = pos - full.length;
  return { token: token, start: start, hasPrefix: hasPrefix, fullLen: full.length };
}

function buildExprAcItems(opts) {
  if (!opts) opts = {};
  var items = [];
  var hdr = preflightData ? preflightData.header : currentHeader;
  if (hdr) {
    for (var i = 0; i < hdr.length; i++) {
      items.push({ label: hdr[i], insert: 'r.' + hdr[i], kind: 'col' });
    }
  }
  for (var ci = 0; ci < currentCalcolMeta.length; ci++) {
    var cc = currentCalcolMeta[ci];
    items.push({ label: cc.name, insert: 'r.' + cc.name, kind: 'calc' });
  }
  for (var mi = 0; mi < MATH_COMPLETIONS.length; mi++) {
    var m = MATH_COMPLETIONS[mi];
    items.push({ label: m.label, insert: m.insert, kind: 'fn', desc: m.desc });
  }
  return items;
}

function validateExpression(expr, mode) {
  var rv = currentRowVar || 'r';
  var wrapped = mode === 'filter' ? '!!(' + expr + ')' : '(' + expr + ')';
  try {
    new Function(rv, MATH_PREAMBLE_MAIN + 'return ' + wrapped);
  } catch(e) {
    return { valid: false, error: 'Syntax error: ' + e.message, warnings: [] };
  }
  var warnings = [];
  var knownNames = new Set();
  var hdr = preflightData ? preflightData.header : currentHeader;
  if (hdr) hdr.forEach(function(n) { knownNames.add(n); });
  currentCalcolMeta.forEach(function(c) { knownNames.add(c.name); });
  var checked = new Set();
  var patterns = [/\br\.([a-zA-Z_]\w*)/g, /\br\["([^"]+)"\]/g, /\br\['([^']+)'\]/g];
  for (var pi = 0; pi < patterns.length; pi++) {
    for (var m of expr.matchAll(patterns[pi])) {
      if (!checked.has(m[1])) {
        checked.add(m[1]);
        if (!knownNames.has(m[1])) warnings.push('Unknown column: "' + m[1] + '"');
      }
    }
  }
  return { valid: true, error: null, warnings: warnings };
}

function createExprInput(element, options) {
  var opts = Object.assign({
    dropdownElement: null, errorElement: null,
    onInput: null, onAccept: null, onEnter: null,
    mode: 'filter', validateOnBlur: true
  }, options);

  var items = [], selected = -1, lastResult = null, debounceTimer = null;
  var createdWrapper = null, createdDropdown = null, createdError = null;
  var parentMadeRelative = false;

  var dropdown = opts.dropdownElement;
  if (!dropdown) {
    dropdown = document.createElement('div');
    dropdown.className = 'expr-ac';
    createdDropdown = dropdown;
    var parent = element.parentElement;
    var parentPos = getComputedStyle(parent).position;
    if (!parentPos || parentPos === 'static') {
      var parentDisplay = getComputedStyle(parent).display;
      var parentFlexDir = getComputedStyle(parent).flexDirection;
      if ((parentDisplay === 'flex' || parentDisplay === 'inline-flex') && parentFlexDir === 'row') {
        var wrap = document.createElement('span');
        wrap.className = 'expr-ac-wrap';
        wrap.style.flex = '1';
        wrap.style.minWidth = '0';
        parent.insertBefore(wrap, element);
        wrap.appendChild(element);
        wrap.appendChild(dropdown);
        createdWrapper = wrap;
      } else {
        parent.style.position = 'relative';
        parentMadeRelative = true;
        parent.insertBefore(dropdown, element.nextSibling);
      }
    } else {
      parent.insertBefore(dropdown, element.nextSibling);
    }
  }

  var errEl = opts.errorElement;
  if (!errEl) {
    errEl = document.createElement('div');
    errEl.className = 'expr-error';
    var after = createdWrapper || element;
    after.parentElement.insertBefore(errEl, after.nextSibling);
    createdError = errEl;
  }

  function showAc() {
    var tok = getTokenAtCursor(element);
    if (!tok.token || tok.token.length < 1) { hideAc(); return; }
    var lc = tok.token.toLowerCase();
    items = buildExprAcItems().filter(function(it) {
      var target = it.kind === 'col' || it.kind === 'calc' ? it.label : it.insert;
      return target.toLowerCase().startsWith(lc) || it.label.toLowerCase().startsWith(lc);
    }).slice(0, 10);
    if (items.length === 0) { hideAc(); return; }
    selected = 0;
    renderAc();
    dropdown.classList.add('open');
  }

  function hideAc() {
    dropdown.classList.remove('open');
    items = [];
    selected = -1;
  }

  function renderAc() {
    dropdown.innerHTML = items.map(function(it, i) {
      var cls = it.kind === 'col' ? 'ac-col' : it.kind === 'calc' ? 'ac-calc' : 'ac-fn';
      return '<div class="ac-item ' + cls + (i === selected ? ' selected' : '') + '" data-idx="' + i + '">' +
        '<span class="ac-label">' + esc(it.label) + '</span>' +
        (it.desc ? '<span class="ac-desc">' + esc(it.desc) + '</span>' : '') +
        '</div>';
    }).join('');
    dropdown.querySelectorAll('.ac-item').forEach(function(el) {
      el.addEventListener('mousedown', function(e) {
        e.preventDefault();
        acceptAc(parseInt(el.dataset.idx));
      });
    });
  }

  function acceptAc(idx) {
    var item = items[idx];
    if (!item) return;
    var tok = getTokenAtCursor(element);
    var before = element.value.substring(0, tok.start);
    var after = element.value.substring(tok.start + tok.fullLen);
    element.value = before + item.insert + after;
    var newPos = before.length + item.insert.length;
    element.setSelectionRange(newPos, newPos);
    hideAc();
    if (opts.onAccept) opts.onAccept(element.value);
    element.focus();
  }

  function showValidation(result) {
    if (!errEl) return;
    if (!result.valid) {
      errEl.textContent = result.error;
      errEl.classList.add('active');
      errEl.style.color = '';
    } else if (result.warnings.length) {
      errEl.textContent = result.warnings.join('; ');
      errEl.classList.add('active');
      errEl.style.color = 'var(--amber-dim)';
    } else {
      errEl.textContent = '';
      errEl.classList.remove('active');
      errEl.style.color = '';
    }
  }

  function validate() {
    var expr = element.value.trim();
    if (!expr) {
      lastResult = { valid: true, error: null, warnings: [] };
      showValidation(lastResult);
      return lastResult;
    }
    lastResult = validateExpression(expr, opts.mode);
    showValidation(lastResult);
    return lastResult;
  }

  function onInputHandler() {
    if (opts.onInput) opts.onInput(element.value);
    showAc();
    if (opts.validateOnBlur) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(validate, 400);
    }
  }

  function onBlurHandler() {
    setTimeout(hideAc, 150);
    if (opts.validateOnBlur) validate();
  }

  function onKeydownHandler(e) {
    if (dropdown.classList.contains('open') && items.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); selected = (selected + 1) % items.length; renderAc(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); selected = (selected - 1 + items.length) % items.length; renderAc(); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && selected >= 0)) { e.preventDefault(); acceptAc(selected); return; }
      if (e.key === 'Escape') { hideAc(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && opts.onEnter) {
      e.preventDefault();
      opts.onEnter();
    }
  }

  element.addEventListener('input', onInputHandler);
  element.addEventListener('blur', onBlurHandler);
  element.addEventListener('keydown', onKeydownHandler);

  return {
    validate: validate,
    getErrors: function() { return lastResult; },
    destroy: function() {
      element.removeEventListener('input', onInputHandler);
      element.removeEventListener('blur', onBlurHandler);
      element.removeEventListener('keydown', onKeydownHandler);
      clearTimeout(debounceTimer);
      hideAc();
      if (createdWrapper && createdWrapper.parentElement) {
        createdWrapper.parentElement.insertBefore(element, createdWrapper);
        createdWrapper.remove();
      }
      if (parentMadeRelative && element.parentElement) {
        element.parentElement.style.position = '';
      }
      if (createdDropdown && createdDropdown.parentElement) createdDropdown.remove();
      if (createdError && createdError.parentElement) createdError.remove();
    }
  };
}

// ── Utility functions ─────────────────────────────────────────────────
function fi(label, value) {
  return '<div class="fi-item"><span class="fi-label">' + label + ':</span><span class="fi-value">' + value + '</span></div>';
}

function geoRowT(label, vx, vy, vz) {
  var fmt = function(v) { return (v != null && v !== undefined) ? String(v) : '\u2014'; };
  var cell = function(v) {
    var s = fmt(v);
    return s === '\u2014'
      ? '<div class="gc">' + s + '</div>'
      : '<div class="gc" data-value="' + s + '">' + s + '<span class="copy-toast">copied</span></div>';
  };
  return '<div class="gl">' + label + '</div>' + cell(vx) + cell(vy) + cell(vz);
}

function esc(s) {
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ── Initialize on load ────────────────────────────────────────────────
initCalcolEditor();
