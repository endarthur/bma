// ─── CDF Plot ─────────────────────────────────────────────────────────
$cdfClose.addEventListener('click', () => $cdfModal.classList.remove('active'));
$cdfModal.addEventListener('click', (e) => { if (e.target === $cdfModal) $cdfModal.classList.remove('active'); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $cdfModal.classList.contains('active')) $cdfModal.classList.remove('active'); });

function showCDF(colIdx) {
  const s = lastDisplayedStats[colIdx];
  const name = lastDisplayedHeader[colIdx];
  if (!s || !s.centroids || s.centroids.length === 0) return;
  renderCDFModal(s, name);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js');
}

// Load recent files on page load
renderRecentFiles();
