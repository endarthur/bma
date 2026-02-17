// ─── Event Handlers ──────────────────────────────────────────────────
$dropzone.addEventListener('dragover', (e) => { e.preventDefault(); $dropzone.classList.add('drag-over'); });
$dropzone.addEventListener('dragleave', () => $dropzone.classList.remove('drag-over'));
$dropzone.addEventListener('drop', async (e) => {
  e.preventDefault();
  $dropzone.classList.remove('drag-over');
  if (!e.dataTransfer.items || !e.dataTransfer.items.length) {
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0], null);
    return;
  }
  var handle = null;
  if (HAS_FSAA && e.dataTransfer.items[0].getAsFileSystemHandle) {
    try { handle = await e.dataTransfer.items[0].getAsFileSystemHandle(); } catch (ex) {}
  }
  var file = handle ? await handle.getFile() : (e.dataTransfer.files[0] || null);
  if (file) handleFile(file, handle);
});

// Click to browse — use FSAA showOpenFilePicker when available
if (HAS_FSAA) {
  $dropzone.addEventListener('click', async (e) => {
    if (e.target === $fileInput) return;
    e.preventDefault();
    try {
      var handles = await window.showOpenFilePicker({
        types: [
          { description: 'CSV files', accept: { 'text/*': ['.csv', '.txt', '.dat'] } },
          { description: 'ZIP files', accept: { 'application/zip': ['.zip'] } }
        ],
        multiple: false
      });
      var handle = handles[0];
      var file = await handle.getFile();
      handleFile(file, handle);
    } catch (ex) { /* user cancelled picker */ }
  });
  $fileInput.style.display = 'none';
}

$fileInput.addEventListener('change', (e) => { if (e.target.files.length) handleFile(e.target.files[0], null); });
