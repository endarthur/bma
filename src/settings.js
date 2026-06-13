// ─── Settings Modal — Themes, Cache, Defaults ─────────────────────────

var bmaSettings = null;

var SETTINGS_DEFAULTS = {
  theme: 'system',
  customThemes: [null, null, null],
  defaultPercentilePreset: 'quartiles',
  customPercentiles: null,
  sigFigs: null,
  thousandsSep: 'space',
  sciNotation: 'auto',
  defaultCatSort: 'count-desc'
};

// C6-1a (D4): Switchboard light/dark/system replaces the legacy accent
// themes. Stored legacy names migrate in loadSettings().
var LEGACY_THEME_MAP = {
  'default': 'system', 'teal': 'dark', 'blue': 'dark', 'mocha': 'dark',
  'light': 'light', 'cream': 'light', 'bm77': 'dark'
};

var THEME_META_COLORS = {
  'light': '#D2D1CE',
  'dark': '#15171A'
};

var THEME_NAMES = {
  'system': 'System',
  'light': 'Light',
  'dark': 'Dark'
};

var THEME_SWATCHES = {
  'system': ['#D2D1CE', '#15171A', '#B54E1A', '#D4672E'],
  'light':  ['#D2D1CE', '#E4E3E1', '#B54E1A', '#1B6B72'],
  'dark':   ['#15171A', '#1D2024', '#D4672E', '#3A9BA3']
};

var CUSTOM_THEME_KEYS = ['name','bg','bg1','bg2','bg3','fg','fgDim','fgBright','accent','accentDim','border'];

function loadSettings() {
  try {
    var raw = localStorage.getItem('bma:settings');
    if (raw) {
      var parsed = JSON.parse(raw);
      bmaSettings = {};
      for (var k in SETTINGS_DEFAULTS) {
        bmaSettings[k] = parsed[k] !== undefined ? parsed[k] : SETTINGS_DEFAULTS[k];
      }
      // C6-1a: migrate stored legacy accent-theme names (D4)
      if (LEGACY_THEME_MAP[bmaSettings.theme]) bmaSettings.theme = LEGACY_THEME_MAP[bmaSettings.theme];
      return;
    }
  } catch (e) {}
  bmaSettings = JSON.parse(JSON.stringify(SETTINGS_DEFAULTS));
}

function saveSettings() {
  try {
    localStorage.setItem('bma:settings', JSON.stringify(bmaSettings));
  } catch (e) {}
}

// C6-1a: light / dark / system over the Switchboard tokens. 'system'
// follows prefers-color-scheme live (one media-query listener, registered
// on first apply). The template <head> has an inline first-paint snippet
// with the same resolution so a dark-OS load never flashes light.
var _themeMQ = null;
function resolvedThemeMode() {
  if (bmaSettings.theme === 'light' || bmaSettings.theme === 'dark') return bmaSettings.theme;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(name) {
  bmaSettings.theme = name;
  saveSettings();

  if (!_themeMQ && window.matchMedia) {
    _themeMQ = window.matchMedia('(prefers-color-scheme: dark)');
    var mqHandler = function() { if (bmaSettings.theme === 'system') applyTheme('system'); };
    if (_themeMQ.addEventListener) _themeMQ.addEventListener('change', mqHandler);
    else if (_themeMQ.addListener) _themeMQ.addListener(mqHandler);
  }

  // Remove custom theme style if present
  var customStyle = document.getElementById('customThemeStyle');

  if (name && name.startsWith('custom-')) {
    var idx = parseInt(name.split('-')[1], 10);
    var ct = bmaSettings.customThemes[idx];
    if (ct) {
      // custom themes predate Switchboard and are dark-styled — they
      // override the app layer over the dark base
      document.documentElement.setAttribute('data-theme', 'dark');
      var css = ':root {\n';
      css += '  --bg: ' + ct.bg + ';\n';
      css += '  --bg1: ' + ct.bg1 + ';\n';
      css += '  --bg2: ' + ct.bg2 + ';\n';
      css += '  --bg3: ' + ct.bg3 + ';\n';
      css += '  --fg: ' + ct.fg + ';\n';
      css += '  --fg-dim: ' + ct.fgDim + ';\n';
      css += '  --fg-bright: ' + ct.fgBright + ';\n';
      // C6-1b: post-triage the custom accent drives action + brand too
      // (sel/warn/info/go/fault stay on the Switchboard dark base; chart
      // chrome --chart-ink/grid inherit the dark --au-* values)
      css += '  --action: ' + ct.accent + ';\n';
      css += '  --action-soft: ' + ct.accent + '30;\n';
      css += '  --brand: ' + ct.accent + ';\n';
      css += '  --border: ' + ct.border + ';\n';
      css += '}\n';
      if (!customStyle) {
        customStyle = document.createElement('style');
        customStyle.id = 'customThemeStyle';
        document.head.appendChild(customStyle);
      }
      customStyle.textContent = css;
      updateThemeColor(ct.bg);
    }
    reRenderChartsForTheme();   // C6-1c: palette + chart chrome follow the theme
    return;
  }

  // Built-in mode: light = :root, dark = data-theme="dark"
  if (customStyle) customStyle.textContent = '';
  var mode = resolvedThemeMode();
  if (mode === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
  updateThemeColor(THEME_META_COLORS[mode]);
  reRenderChartsForTheme();     // C6-1c: palette + chart chrome follow the theme
}

function updateThemeColor(color) {
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', color);
}

// ─── Cache Enumeration ───────────────────────────────────────────────

function cacheList() {
  return openCacheDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction('results', 'readonly');
      var store = tx.objectStore('results');
      var req = store.openCursor();
      var items = [];
      req.onsuccess = function() {
        var cursor = req.result;
        if (cursor) {
          var key = cursor.key;
          var val = cursor.value;
          var size = 0;
          try { size = estimateResultBytes(val.data || val); } catch (e) {}
          items.push({ key: key, size: size });
          cursor.continue();
        } else {
          resolve(items);
        }
      };
      req.onerror = function() { reject(req.error); };
    });
  });
}

function cacheDeleteAll() {
  return openCacheDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction('results', 'readwrite');
      tx.objectStore('results').clear();
      tx.oncomplete = function() { resolve(); };
      tx.onerror = function() { reject(tx.error); };
    });
  });
}

// ─── Settings Modal Rendering ────────────────────────────────────────

function openSettings() {
  renderSettingsBody();
  $settingsModal.classList.add('active');
}

function closeSettings() {
  $settingsModal.classList.remove('active');
}

function renderSettingsBody() {
  var body = document.getElementById('settingsBody');
  if (!body) return;
  var html = '';

  // ── Theme section ──
  html += '<div class="settings-section"><div class="settings-section-title">Theme</div>';
  html += '<div class="settings-theme-grid">';
  var builtInThemes = ['system', 'light', 'dark'];
  for (var i = 0; i < builtInThemes.length; i++) {
    var tid = builtInThemes[i];
    var sw = THEME_SWATCHES[tid];
    var sel = bmaSettings.theme === tid ? ' selected' : '';
    html += '<button class="settings-swatch' + sel + '" data-theme="' + tid + '">';
    html += '<div class="settings-swatch-colors">';
    for (var s = 0; s < sw.length; s++) {
      html += '<div style="background:' + sw[s] + '"></div>';
    }
    html += '</div>';
    html += '<div class="settings-swatch-name">' + THEME_NAMES[tid] + '</div>';
    html += '</button>';
  }
  // Custom theme swatches
  for (var ci = 0; ci < 3; ci++) {
    var ct = bmaSettings.customThemes[ci];
    var ctId = 'custom-' + ci;
    var csel = bmaSettings.theme === ctId ? ' selected' : '';
    if (ct) {
      html += '<button class="settings-swatch' + csel + '" data-theme="' + ctId + '">';
      html += '<div class="settings-swatch-colors">';
      html += '<div style="background:' + esc(ct.bg) + '"></div>';
      html += '<div style="background:' + esc(ct.bg2) + '"></div>';
      html += '<div style="background:' + esc(ct.accent) + '"></div>';
      html += '<div style="background:' + esc(ct.accentDim) + '"></div>';
      html += '</div>';
      html += '<div class="settings-swatch-name">' + esc(ct.name || 'Custom ' + (ci + 1)) + '</div>';
      html += '</button>';
    }
  }
  html += '</div>';

  // Custom theme inputs
  html += '<details class="settings-custom-details"><summary>Custom themes</summary>';
  html += '<div class="settings-custom-themes">';
  for (var ci = 0; ci < 3; ci++) {
    var ct = bmaSettings.customThemes[ci];
    var placeholder = '{"name":"My Theme","bg":"#0a0a0a","bg1":"#111","bg2":"#1a1a1a","bg3":"#222","fg":"#ccc","fgDim":"#666","fgBright":"#eee","accent":"#ff6600","accentDim":"#cc5200","border":"#333"}';
    html += '<div class="settings-custom-slot">';
    html += '<label>Slot ' + (ci + 1) + '</label>';
    html += '<textarea class="settings-custom-input" data-slot="' + ci + '" rows="2" placeholder=\'' + placeholder + '\' spellcheck="false">' + (ct ? esc(JSON.stringify(ct)) : '') + '</textarea>';
    html += '<div class="settings-custom-actions">';
    html += '<button class="settings-custom-apply" data-slot="' + ci + '">Apply</button>';
    if (ct) html += '<button class="settings-custom-del" data-slot="' + ci + '">Delete</button>';
    html += '</div></div>';
  }
  html += '</div></details>';
  html += '</div>';

  // ── Saved Projects section ──
  html += '<div class="settings-section"><div class="settings-section-title">Saved Projects</div>';
  html += renderSettingsProjectList();
  html += '</div>';

  // ── Cache section ──
  html += '<div class="settings-section"><div class="settings-section-title">Cache</div>';
  html += '<div id="settingsCacheContent"><div class="settings-cache-loading">Loading...</div></div>';
  html += '</div>';

  // ── Default Percentile Preset ──
  html += '<div class="settings-section"><div class="settings-section-title">Default Percentile Preset</div>';
  html += '<div class="settings-preset-btns">';
  var presets = ['quartiles', 'deciles', 'ventiles', 'custom'];
  var presetLabels = ['Quartiles', 'Deciles', 'Ventiles', 'Custom'];
  for (var pi = 0; pi < presets.length; pi++) {
    var pa = bmaSettings.defaultPercentilePreset === presets[pi] ? ' active' : '';
    html += '<button class="settings-preset-btn' + pa + '" data-preset="' + presets[pi] + '">' + presetLabels[pi] + '</button>';
  }
  html += '</div>';
  var cpVis = bmaSettings.defaultPercentilePreset === 'custom' ? '' : ' style="display:none"';
  var cpVal = bmaSettings.customPercentiles ? bmaSettings.customPercentiles.join(', ') : '';
  html += '<input type="text" class="settings-custom-pct" id="settingsCustomPct" placeholder="e.g. 5,10,25,50,75,90,95" value="' + cpVal + '"' + cpVis + ' autocomplete="off" spellcheck="false">';
  html += '</div>';

  // ── Number Formatting ──
  html += '<div class="settings-section"><div class="settings-section-title">Number Formatting</div>';
  html += '<div class="settings-sigfigs-row"><label>Significant figures</label><select id="settingsSigFigs">';
  var sigOpts = [['', 'Auto'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5'], ['6', '6'], ['8', '8']];
  for (var si = 0; si < sigOpts.length; si++) {
    var sv = sigOpts[si][0];
    var sl = sigOpts[si][1];
    var curSig = bmaSettings.sigFigs === null ? '' : String(bmaSettings.sigFigs);
    var ssel = sv === curSig ? ' selected' : '';
    html += '<option value="' + sv + '"' + ssel + '>' + sl + '</option>';
  }
  html += '</select></div>';
  // Thousands separator
  var tSepOpts = [['space', 'Space (1\u2009234)'], ['comma', 'Comma (1,234)'], ['none', 'None (1234)']];
  var curTSep = bmaSettings.thousandsSep || 'space';
  html += '<div class="settings-sigfigs-row" style="margin-top:0.4rem"><label>Thousands separator</label><select id="settingsThousandsSep">';
  for (var ti = 0; ti < tSepOpts.length; ti++) {
    var tsel = tSepOpts[ti][0] === curTSep ? ' selected' : '';
    html += '<option value="' + tSepOpts[ti][0] + '"' + tsel + '>' + tSepOpts[ti][1] + '</option>';
  }
  html += '</select></div>';
  // Scientific notation
  var sciOpts = [['auto', 'Auto'], ['never', 'Never'], ['1e6', '\u2265 1M'], ['1e9', '\u2265 1B']];
  var curSci = bmaSettings.sciNotation || 'auto';
  html += '<div class="settings-sigfigs-row" style="margin-top:0.4rem"><label>Scientific notation</label><select id="settingsSciNotation">';
  for (var sci = 0; sci < sciOpts.length; sci++) {
    var scsel = sciOpts[sci][0] === curSci ? ' selected' : '';
    html += '<option value="' + sciOpts[sci][0] + '"' + scsel + '>' + sciOpts[sci][1] + '</option>';
  }
  html += '</select></div>';
  html += '</div>';

  // ── Default Category Sort ──
  html += '<div class="settings-section"><div class="settings-section-title">Default Category Sort</div>';
  html += '<div class="settings-preset-btns">';
  var catSorts = ['count-desc', 'count-asc', 'alpha'];
  var catSortLabels = ['Count \u2193', 'Count \u2191', 'A-Z'];
  for (var csi = 0; csi < catSorts.length; csi++) {
    var csa = bmaSettings.defaultCatSort === catSorts[csi] ? ' active' : '';
    html += '<button class="settings-preset-btn settings-cat-sort-btn' + csa + '" data-catsort="' + catSorts[csi] + '">' + catSortLabels[csi] + '</button>';
  }
  html += '</div></div>';

  body.innerHTML = html;

  // Wire events
  wireSettingsEvents();

  // Load cache info async
  loadCacheInfo();
}

function renderSettingsProjectList() {
  var projects = [];
  try {
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      if (key && key.startsWith('bma:') && key !== 'bma:settings') {
        var parts = key.substring(4); // strip 'bma:'
        var lastColon = parts.lastIndexOf(':');
        var fname = lastColon > 0 ? parts.substring(0, lastColon) : parts;
        var fsize = lastColon > 0 ? parts.substring(lastColon + 1) : '';
        var raw = localStorage.getItem(key);
        var bytes = raw ? raw.length * 2 : 0; // rough UTF-16 estimate
        var ts = null;
        try {
          var parsed = JSON.parse(raw);
          ts = parsed._ts || null;
        } catch (e) {}
        projects.push({ key: key, name: fname, size: fsize, bytes: bytes, ts: ts });
      }
    }
  } catch (e) {}

  if (projects.length === 0) {
    return '<div class="settings-cache-empty">No saved projects.</div>';
  }

  // Sort by timestamp descending (most recent first)
  projects.sort(function(a, b) { return (b.ts || 0) - (a.ts || 0); });

  var totalBytes = 0;
  for (var i = 0; i < projects.length; i++) totalBytes += projects[i].bytes;

  var html = '<div class="settings-cache-summary">' + projects.length + ' project' + (projects.length !== 1 ? 's' : '') + ' (' + formatBytes(totalBytes) + ')</div>';
  html += '<div class="settings-cache-list">';
  for (var i = 0; i < projects.length; i++) {
    var p = projects[i];
    var displayName = p.name.length > 40 ? p.name.substring(0, 37) + '...' : p.name;
    var dateStr = '';
    if (p.ts) {
      var d = new Date(p.ts);
      dateStr = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    html += '<div class="settings-cache-item">';
    html += '<span class="settings-cache-name" title="' + esc(p.name) + ' (' + (p.size ? formatBytes(Number(p.size)) : '?') + ')">' + esc(displayName) + '</span>';
    if (dateStr) html += '<span class="settings-cache-size" style="margin-right:0.4rem">' + dateStr + '</span>';
    html += '<span class="settings-cache-size">' + formatBytes(p.bytes) + '</span>';
    html += '<button class="settings-cache-del settings-proj-del" data-projkey="' + esc(p.key) + '" title="Delete saved project">\u2715</button>';
    html += '</div>';
  }
  html += '</div>';
  html += '<button class="settings-cache-clear-all" id="settingsProjClearAll">Clear all saved projects</button>';
  return html;
}

function wireSettingsEvents() {
  var body = document.getElementById('settingsBody');
  if (!body) return;

  // Theme swatches
  body.addEventListener('click', function(e) {
    var swatch = e.target.closest('.settings-swatch');
    if (swatch) {
      var tid = swatch.dataset.theme;
      applyTheme(tid);
      renderSettingsBody();
      return;
    }

    // Custom theme apply
    var applyBtn = e.target.closest('.settings-custom-apply');
    if (applyBtn) {
      var slot = parseInt(applyBtn.dataset.slot, 10);
      var textarea = body.querySelector('.settings-custom-input[data-slot="' + slot + '"]');
      if (textarea) {
        try {
          var obj = JSON.parse(textarea.value);
          // Validate keys
          var valid = true;
          for (var ki = 0; ki < CUSTOM_THEME_KEYS.length; ki++) {
            if (!obj[CUSTOM_THEME_KEYS[ki]]) { valid = false; break; }
          }
          if (!valid) {
            textarea.style.borderColor = 'var(--red)';
            return;
          }
          bmaSettings.customThemes[slot] = obj;
          applyTheme('custom-' + slot);
          renderSettingsBody();
        } catch (err) {
          textarea.style.borderColor = 'var(--red)';
        }
      }
      return;
    }

    // Custom theme delete
    var delBtn = e.target.closest('.settings-custom-del');
    if (delBtn) {
      var slot = parseInt(delBtn.dataset.slot, 10);
      bmaSettings.customThemes[slot] = null;
      if (bmaSettings.theme === 'custom-' + slot) {
        applyTheme('system');
      }
      saveSettings();
      renderSettingsBody();
      return;
    }

    // Preset buttons
    var presetBtn = e.target.closest('.settings-preset-btn');
    if (presetBtn) {
      var preset = presetBtn.dataset.preset;
      bmaSettings.defaultPercentilePreset = preset;
      if (preset === 'custom') {
        var cpInput = document.getElementById('settingsCustomPct');
        if (cpInput) cpInput.style.display = '';
      }
      saveSettings();
      body.querySelectorAll('.settings-preset-btn').forEach(function(b) { b.classList.remove('active'); });
      presetBtn.classList.add('active');
      // Show/hide custom input
      var cpInput = document.getElementById('settingsCustomPct');
      if (cpInput) cpInput.style.display = preset === 'custom' ? '' : 'none';
      return;
    }

    // Category sort buttons
    var catSortBtn = e.target.closest('.settings-cat-sort-btn');
    if (catSortBtn) {
      bmaSettings.defaultCatSort = catSortBtn.dataset.catsort;
      saveSettings();
      body.querySelectorAll('.settings-cat-sort-btn').forEach(function(b) { b.classList.remove('active'); });
      catSortBtn.classList.add('active');
      return;
    }

    // Project delete individual
    var projDel = e.target.closest('.settings-proj-del');
    if (projDel) {
      var projKey = projDel.dataset.projkey;
      if (projKey) {
        try { localStorage.removeItem(projKey); } catch (ex) {}
        // Also delete matching cache entry
        cacheDelete(projKey).catch(function() {});
        renderSettingsBody();
      }
      return;
    }

    // Project clear all
    if (e.target.closest('#settingsProjClearAll')) {
      try {
        var keysToRemove = [];
        for (var ki = 0; ki < localStorage.length; ki++) {
          var lk = localStorage.key(ki);
          if (lk && lk.startsWith('bma:') && lk !== 'bma:settings') keysToRemove.push(lk);
        }
        for (var ki = 0; ki < keysToRemove.length; ki++) localStorage.removeItem(keysToRemove[ki]);
      } catch (ex) {}
      renderSettingsBody();
      return;
    }

    // Cache delete individual
    var cacheDel = e.target.closest('.settings-cache-del');
    if (cacheDel && !cacheDel.classList.contains('settings-proj-del')) {
      var key = cacheDel.dataset.key;
      cacheDelete(key).then(function() { loadCacheInfo(); });
      return;
    }

    // Cache clear all
    if (e.target.closest('#settingsCacheClearAll')) {
      cacheDeleteAll().then(function() { loadCacheInfo(); });
      return;
    }
  });

  // Custom percentile input
  var cpInput = document.getElementById('settingsCustomPct');
  if (cpInput) {
    cpInput.addEventListener('change', function() {
      var vals = cpInput.value.split(',').map(function(s) { return parseFloat(s.trim()); }).filter(function(n) { return !isNaN(n) && n > 0 && n < 100; });
      if (vals.length > 0) {
        vals.sort(function(a, b) { return a - b; });
        bmaSettings.customPercentiles = vals;
        saveSettings();
      }
    });
  }

  // Sig figs
  var sigSelect = document.getElementById('settingsSigFigs');
  if (sigSelect) {
    sigSelect.addEventListener('change', function() {
      var v = sigSelect.value;
      bmaSettings.sigFigs = v === '' ? null : parseInt(v, 10);
      saveSettings();
      refreshFormattedViews();
    });
  }

  // Thousands separator
  var tSepSelect = document.getElementById('settingsThousandsSep');
  if (tSepSelect) {
    tSepSelect.addEventListener('change', function() {
      bmaSettings.thousandsSep = tSepSelect.value;
      saveSettings();
      refreshFormattedViews();
    });
  }

  // Scientific notation
  var sciSelect = document.getElementById('settingsSciNotation');
  if (sciSelect) {
    sciSelect.addEventListener('change', function() {
      bmaSettings.sciNotation = sciSelect.value;
      saveSettings();
      refreshFormattedViews();
    });
  }
}

function loadCacheInfo() {
  var container = document.getElementById('settingsCacheContent');
  if (!container) return;

  cacheList().then(function(items) {
    if (items.length === 0) {
      container.innerHTML = '<div class="settings-cache-empty">No cached results.</div>';
      return;
    }
    var totalSize = 0;
    for (var i = 0; i < items.length; i++) totalSize += items[i].size;
    var html = '<div class="settings-cache-summary">' + items.length + ' cached result' + (items.length !== 1 ? 's' : '') + ' (' + formatBytes(totalSize) + ')</div>';
    html += '<div class="settings-cache-list">';
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var displayKey = item.key.length > 60 ? item.key.substring(0, 57) + '...' : item.key;
      html += '<div class="settings-cache-item">';
      html += '<span class="settings-cache-name" title="' + esc(item.key) + '">' + esc(displayKey) + '</span>';
      html += '<span class="settings-cache-size">' + formatBytes(item.size) + '</span>';
      html += '<button class="settings-cache-del" data-key="' + esc(item.key) + '" title="Delete">✕</button>';
      html += '</div>';
    }
    html += '</div>';
    html += '<button class="settings-cache-clear-all" id="settingsCacheClearAll">Clear all cache</button>';
    container.innerHTML = html;
  }).catch(function() {
    container.innerHTML = '<div class="settings-cache-empty">Could not read cache.</div>';
  });
}

function refreshFormattedViews() {
  if (typeof renderStatsTable === 'function' && lastDisplayedStats) {
    renderStatsTable();
  }
  if (lastGtData) renderGtOutput();
}

// ─── Initialization ──────────────────────────────────────────────────

function initSettings() {
  loadSettings();
  applyTheme(bmaSettings.theme);

  // Modal close handlers
  $settingsClose.addEventListener('click', closeSettings);
  $settingsModal.addEventListener('click', function(e) {
    if (e.target === $settingsModal) closeSettings();
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && $settingsModal.classList.contains('active')) {
      closeSettings();
    }
  });

  // Gear button
  $settingsBtn.addEventListener('click', openSettings);
}

initSettings();
