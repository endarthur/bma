// ─── PWA glue: registration, build badge, update banner ──────────────
// (GCU pattern, adapted from @gcu/weir.) The corner badge shows the build
// hash; clicking it asks the service worker to revalidate the shell. When
// fresh bytes differ from the cached app (background or on-demand), the
// banner offers a reload.

function showUpdateBanner() {
  var b = document.getElementById('updateBanner');
  if (b) b.classList.add('on');
}

function flashBuildBadge(text, ms) {
  var badge = document.getElementById('buildBadge');
  if (!badge) return;
  var orig = badge.dataset.hash;
  badge.textContent = text;
  setTimeout(function() { badge.textContent = orig; }, ms || 2000);
}

// Check for a shell update. Handles the page not being controlled by the SW
// (cold start of an installed PWA, or eviction) — that page came straight
// from the network, so it's already current.
async function checkForUpdateNow() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return 'unsupported';
  var reg = null;
  try { reg = await navigator.serviceWorker.getRegistration(); } catch (e) { /* ignore */ }
  if (!reg) return 'none';
  try { await reg.update(); } catch (e) { /* sw.js re-check failed — ignore */ }
  if (reg.waiting) return 'waiting';
  var ctrl = navigator.serviceWorker.controller;
  if (!ctrl) return 'uncontrolled';
  await new Promise(function(resolve) {
    var ch = new MessageChannel();
    ch.port1.onmessage = function(e) { if (e.data && e.data.type === 'bma:check-complete') resolve(); };
    ctrl.postMessage({ type: 'bma:check-now' }, [ch.port2]);
    setTimeout(resolve, 8000);   // don't hang if the SW is silent
  });
  return 'checked';
}

(function initPwa() {
  var $reload = document.getElementById('updateReload');
  var $dismiss = document.getElementById('updateDismiss');
  if ($reload) $reload.addEventListener('click', function() { location.reload(); });
  if ($dismiss) $dismiss.addEventListener('click', function() {
    document.getElementById('updateBanner').classList.remove('on');
  });

  var badge = document.getElementById('buildBadge');
  if (badge) {
    badge.dataset.hash = badge.textContent;
    badge.addEventListener('click', async function() {
      badge.textContent = 'checking…';
      var state = await checkForUpdateNow();
      if (state === 'waiting') {
        showUpdateBanner();
        badge.textContent = badge.dataset.hash;
      } else if (state === 'checked') {
        // If bytes changed, the SW posts bma:update-available and the banner
        // appears; either way confirm the check ran
        flashBuildBadge('✓ checked', 2000);
      } else if (state === 'uncontrolled' || state === 'none') {
        flashBuildBadge('✓ latest', 2000);
      } else {
        flashBuildBadge('n/a', 2000);
      }
    });
  }

  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').catch(function() { /* app works without */ });
  navigator.serviceWorker.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'bma:update-available') showUpdateBanner();
  });
})();
