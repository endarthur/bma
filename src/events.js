// ─── Event Handlers ──────────────────────────────────────────────────
$dropzone.addEventListener('dragover', (e) => { e.preventDefault(); $dropzone.classList.add('drag-over'); });
$dropzone.addEventListener('dragleave', () => $dropzone.classList.remove('drag-over'));
$dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  $dropzone.classList.remove('drag-over');
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
$fileInput.addEventListener('change', (e) => { if (e.target.files.length) handleFile(e.target.files[0]); });

