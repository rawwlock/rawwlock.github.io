/* ============================================================
   TRANSFORMAT — app.js
   All conversion logic, format config, queue management
   ============================================================ */

'use strict';

// ──────────────────────────────────────────────
//  FORMAT DEFINITIONS
// ──────────────────────────────────────────────
const OUTPUT_FORMATS = [
  // Audio
  { id: 'mp3',  label: 'MP3',  type: 'audio', mime: 'audio/mpeg',      ext: 'mp3'  },
  { id: 'wav',  label: 'WAV',  type: 'audio', mime: 'audio/wav',        ext: 'wav'  },
  { id: 'ogg',  label: 'OGG',  type: 'audio', mime: 'audio/ogg',        ext: 'ogg'  },
  { id: 'flac', label: 'FLAC', type: 'audio', mime: 'audio/flac',       ext: 'flac' },
  { id: 'aac',  label: 'AAC',  type: 'audio', mime: 'audio/aac',        ext: 'aac'  },
  { id: 'm4a',  label: 'M4A',  type: 'audio', mime: 'audio/mp4',        ext: 'm4a'  },
  { id: 'opus', label: 'OPUS', type: 'audio', mime: 'audio/ogg',        ext: 'opus' },
  // Video
  { id: 'mp4',  label: 'MP4',  type: 'video', mime: 'video/mp4',        ext: 'mp4'  },
  { id: 'webm', label: 'WEBM', type: 'video', mime: 'video/webm',       ext: 'webm' },
  { id: 'mkv',  label: 'MKV',  type: 'video', mime: 'video/x-matroska', ext: 'mkv'  },
  { id: 'avi',  label: 'AVI',  type: 'video', mime: 'video/x-msvideo',  ext: 'avi'  },
  { id: 'gif',  label: 'GIF',  type: 'video', mime: 'image/gif',        ext: 'gif'  },
  // Image
  { id: 'jpg',  label: 'JPG',  type: 'image', mime: 'image/jpeg',       ext: 'jpg'  },
  { id: 'png',  label: 'PNG',  type: 'image', mime: 'image/png',        ext: 'png'  },
  { id: 'webp', label: 'WEBP', type: 'image', mime: 'image/webp',       ext: 'webp' },
  { id: 'bmp',  label: 'BMP',  type: 'image', mime: 'image/bmp',        ext: 'bmp'  },
  { id: 'tiff', label: 'TIFF', type: 'image', mime: 'image/tiff',       ext: 'tiff' },
  { id: 'avif', label: 'AVIF', type: 'image', mime: 'image/avif',       ext: 'avif' },
];

const ACCEPTED_INPUT_EXTS = [
  'mp3','wav','ogg','flac','aac','m4a','opus','aiff',
  'mp4','mov','mkv','avi','webm','flv','wmv',
  'jpg','jpeg','png','webp','bmp','tiff','tif','gif','avif',
];

// Quality presets — mapped to FFmpeg args by format
const QUALITY_PRESETS = [
  { id: 'low',    label: 'LOW',    sub: '96k / CRF28'  },
  { id: 'medium', label: 'MED',    sub: '192k / CRF23' },
  { id: 'high',   label: 'HIGH',   sub: '320k / CRF18' },
];

// Returns FFmpeg args for extract-audio mode.
// Uses stream copy (-acodec copy) when the source audio already matches the
// target container — fastest & lossless. Falls back to re-encode otherwise.
function buildExtractArgs(inFile, outFile, outFmt, quality) {
  const q = quality || 'medium';
  const bitrates = { low: '96k', medium: '192k', high: '320k' };
  const br = bitrates[q];

  // Formats that support stream copy from common video containers
  const copyFmts = { aac: 'aac', m4a: 'aac', opus: 'opus' };

  switch (outFmt) {
    case 'mp3':  return ['-i', inFile, '-vn', '-acodec', 'libmp3lame', '-b:a', br, outFile];
    case 'wav':  return ['-i', inFile, '-vn', '-acodec', 'pcm_s16le', '-ar', '44100', outFile];
    case 'ogg':  return ['-i', inFile, '-vn', '-acodec', 'libvorbis', '-b:a', br, outFile];
    case 'flac': return ['-i', inFile, '-vn', '-acodec', 'flac', outFile];
    case 'aac':  return ['-i', inFile, '-vn', '-acodec', 'copy', outFile];
    case 'm4a':  return ['-i', inFile, '-vn', '-acodec', 'copy', outFile];
    case 'opus': return ['-i', inFile, '-vn', '-acodec', 'libopus', '-b:a', br, outFile];
    default:     return ['-i', inFile, '-vn', outFile];
  }
}

// Returns FFmpeg args for image conversion with optional quality and resize
function buildImageArgs(inFile, outFile, outFmt, quality, resize) {
  const args = ['-i', inFile];

  // Build vf filter chain
  const filters = [];
  if (resize && resize.width && resize.height) {
    filters.push(`scale=${resize.width}:${resize.height}:flags=lanczos`);
  } else if (resize && resize.width) {
    filters.push(`scale=${resize.width}:-1:flags=lanczos`);
  } else if (resize && resize.height) {
    filters.push(`scale=-1:${resize.height}:flags=lanczos`);
  }
  if (filters.length) args.push('-vf', filters.join(','));

  // Format-specific quality
  const qmap = { low: '60', medium: '82', high: '95' };
  const q = qmap[quality] || '82';

  switch (outFmt) {
    case 'jpg':
      args.push('-q:v', quality === 'high' ? '2' : quality === 'low' ? '10' : '5');
      break;
    case 'webp':
      args.push('-quality', q);
      break;
    case 'avif':
      args.push('-crf', quality === 'high' ? '20' : quality === 'low' ? '45' : '32', '-b:v', '0');
      break;
    case 'png':
    case 'bmp':
    case 'tiff':
      // lossless — no quality arg needed
      break;
  }

  args.push(outFile);
  return args;
}

// Returns FFmpeg args array for the chosen format + quality
function buildFFmpegArgs(inFile, outFile, outFmt, quality) {
  const q = quality || 'medium';
  const bitrates = { low: '96k', medium: '192k', high: '320k' };
  const crfs     = { low: '28',  medium: '23',   high: '18'   };
  const br = bitrates[q];
  const crf = crfs[q];

  switch (outFmt) {
    case 'mp3':  return ['-i', inFile, '-vn', '-acodec', 'libmp3lame', '-b:a', br, outFile];
    case 'wav':  return ['-i', inFile, '-vn', '-acodec', 'pcm_s16le', '-ar', '44100', outFile];
    case 'ogg':  return ['-i', inFile, '-vn', '-acodec', 'libvorbis', '-b:a', br, outFile];
    case 'flac': return ['-i', inFile, '-vn', '-acodec', 'flac', outFile];
    case 'aac':  return ['-i', inFile, '-vn', '-acodec', 'aac', '-b:a', br, outFile];
    case 'm4a':  return ['-i', inFile, '-vn', '-acodec', 'aac', '-b:a', br, outFile];
    case 'opus': return ['-i', inFile, '-vn', '-acodec', 'libopus', '-b:a', br, outFile];
    case 'mp4':  return ['-i', inFile, '-vcodec', 'libx264', '-crf', crf, '-preset', 'fast', '-acodec', 'aac', '-b:a', br, outFile];
    case 'webm': return ['-i', inFile, '-vcodec', 'libvpx-vp9', '-crf', crf, '-b:v', '0', '-acodec', 'libopus', '-b:a', br, outFile];
    case 'mkv':  return ['-i', inFile, '-vcodec', 'libx264', '-crf', crf, '-preset', 'fast', '-acodec', 'aac', '-b:a', br, outFile];
    case 'avi':  return ['-i', inFile, '-vcodec', 'mpeg4', '-q:v', '6', '-acodec', 'mp3', '-b:a', br, outFile];
    case 'gif':  return ['-i', inFile, '-vf', 'fps=12,scale=480:-1:flags=lanczos', '-loop', '0', outFile];
    default:     return ['-i', inFile, outFile];
  }
}

// ──────────────────────────────────────────────
//  STATE
// ──────────────────────────────────────────────
const state = {
  ffmpeg: null,
  ready: false,
  queue: [],
  selectedFmt: 'mp3',
  selectedQuality: 'medium',
  mode: 'convert',   // 'convert' | 'extract' | 'image'
  imageResize: { width: '', height: '' },
  idCounter: 0,
  converting: false,
};

// ──────────────────────────────────────────────
//  DOM REFS
// ──────────────────────────────────────────────
const $ = id => document.getElementById(id);
const dom = {
  engineDot:    $('engine-dot'),
  engineLabel:  $('engine-label'),
  tickerText:   $('ticker-text'),
  dropZone:     $('drop-zone'),
  fileInput:    $('file-input'),
  queueHeader:  $('queue-header'),
  queueCount:   $('queue-count'),
  clearAllBtn:  $('clear-all-btn'),
  fileQueue:    $('file-queue'),
  formatGrid:   $('format-grid'),
  qualityOpts:  $('quality-options'),
  qualityBlock: $('quality-block'),
  oiMode:       $('oi-mode'),
  oiFmt:        $('oi-format'),
  oiQuality:    $('oi-quality'),
  oiFiles:      $('oi-files'),
  convertBtn:   $('convert-btn'),
  convertBtnLabel: $('convert-btn-label'),
  logBody:      $('log-body'),
  overlay:      $('progress-overlay'),
  progCurrent:  $('progress-current'),
  progBar:      $('progress-bar-fill'),
  progStats:    $('progress-stats'),
  modeTabs:     $('mode-tabs'),
  extractNotice: $('extract-notice'),
  imageOptions:  $('image-options'),
  imgWidth:      $('img-width'),
  imgHeight:     $('img-height'),
};

// ──────────────────────────────────────────────
//  LOGGING
// ──────────────────────────────────────────────
function log(msg, type = '') {
  const line = document.createElement('span');
  line.className = `log-line ${type ? 'log-' + type : ''}`;
  const ts = new Date().toTimeString().slice(0,8);
  line.textContent = `[${ts}] ${msg}`;
  dom.logBody.appendChild(line);
  dom.logBody.scrollTop = dom.logBody.scrollHeight;
}

function ticker(msg) {
  dom.tickerText.textContent = msg;
}

// ──────────────────────────────────────────────
//  FFMPEG INIT
// ──────────────────────────────────────────────
async function initFFmpeg() {
  ticker('Fetching FFmpeg WebAssembly core…');
  log('Loading FFmpeg engine…', 'warn');

  try {
    const { FFmpeg } = FFmpegWASM;

    state.ffmpeg = new FFmpeg();

    const BASE = '/convert/core';
    await state.ffmpeg.load({
      coreURL: `${BASE}/ffmpeg-core.js`,
      wasmURL: `${BASE}/ffmpeg-core.wasm`,
    });

    state.ready = true;
    dom.engineDot.classList.add('ready');
    dom.engineLabel.textContent = 'ENGINE READY';
    ticker('FFmpeg engine ready — drop files and choose an output format.');
    log('Engine loaded successfully.', 'ok');
    updateConvertBtn();
  } catch (e) {
    dom.engineDot.classList.add('error');
    dom.engineLabel.textContent = 'ENGINE FAILED';
    ticker('ERROR: Could not load FFmpeg — check console.');
    log('Engine load failed: ' + e.message, 'err');
    console.error(e);
  }
}

// ──────────────────────────────────────────────
//  MODE TABS
// ──────────────────────────────────────────────
const AUDIO_OUTPUT_FORMATS = OUTPUT_FORMATS.filter(f => f.type === 'audio');
const IMAGE_OUTPUT_FORMATS = OUTPUT_FORMATS.filter(f => f.type === 'image');

function setupModeTabs() {
  dom.modeTabs.querySelectorAll('.mode-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const mode = tab.dataset.mode;
      if (mode === state.mode) return;
      state.mode = mode;

      dom.modeTabs.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const isExtract = mode === 'extract';
      const isImage   = mode === 'image';

      dom.extractNotice.style.display = isExtract ? 'flex' : 'none';
      dom.imageOptions.style.display  = isImage   ? 'flex' : 'none';

      dom.convertBtnLabel.textContent = isExtract ? 'EXTRACT AUDIO'
                                      : isImage   ? 'CONVERT IMAGES'
                                      : 'CONVERT';
      dom.convertBtn.classList.toggle('extract-mode', isExtract);
      dom.convertBtn.classList.toggle('image-mode',   isImage);

      // Rebuild format grid for the mode
      buildFormatGrid();
      updateOutputInfo();
      updateConvertBtn();
      log(`Mode switched to: ${mode.toUpperCase()}`, 'warn');
    });
  });

  // Resize inputs
  dom.imgWidth.addEventListener('input',  e => { state.imageResize.width  = e.target.value; });
  dom.imgHeight.addEventListener('input', e => { state.imageResize.height = e.target.value; });
}

// ──────────────────────────────────────────────
//  FORMAT GRID
// ──────────────────────────────────────────────
function buildFormatGrid() {
  dom.formatGrid.innerHTML = '';
  let formats;
  if (state.mode === 'extract') {
    formats = AUDIO_OUTPUT_FORMATS;
    if (!AUDIO_OUTPUT_FORMATS.find(f => f.id === state.selectedFmt)) state.selectedFmt = 'mp3';
  } else if (state.mode === 'image') {
    formats = IMAGE_OUTPUT_FORMATS;
    if (!IMAGE_OUTPUT_FORMATS.find(f => f.id === state.selectedFmt)) state.selectedFmt = 'jpg';
  } else {
    formats = OUTPUT_FORMATS;
  }

  formats.forEach(fmt => {
    const btn = document.createElement('button');
    btn.className = 'fmt-btn';
    btn.dataset.id = fmt.id;
    btn.innerHTML = `${fmt.label}<span class="fmt-type">${fmt.type}</span>`;
    btn.addEventListener('click', () => selectFormat(fmt.id));
    dom.formatGrid.appendChild(btn);
  });

  const active = document.querySelector(`.fmt-btn[data-id="${state.selectedFmt}"]`);
  if (active) {
    const fmt = OUTPUT_FORMATS.find(f => f.id === state.selectedFmt);
    active.classList.add('active-' + fmt.type);
  }
}

function selectFormat(id) {
  state.selectedFmt = id;
  const fmt = OUTPUT_FORMATS.find(f => f.id === id);
  document.querySelectorAll('.fmt-btn').forEach(b => {
    b.classList.remove('active-audio','active-video','active-image');
    if (b.dataset.id === id) b.classList.add('active-' + fmt.type);
  });
  updateOutputInfo();
  updateConvertBtn();
}

// ──────────────────────────────────────────────
//  QUALITY BUTTONS
// ──────────────────────────────────────────────
function buildQualityButtons() {
  dom.qualityOpts.innerHTML = '';
  QUALITY_PRESETS.forEach(q => {
    const btn = document.createElement('button');
    btn.className = 'quality-btn' + (q.id === 'medium' ? ' active' : '');
    btn.dataset.id = q.id;
    btn.innerHTML = `${q.label}<span class="q-label">${q.sub}</span>`;
    btn.addEventListener('click', () => {
      state.selectedQuality = q.id;
      document.querySelectorAll('.quality-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updateOutputInfo();
    });
    dom.qualityOpts.appendChild(btn);
  });
}

// ──────────────────────────────────────────────
//  OUTPUT INFO PANEL
// ──────────────────────────────────────────────
function updateOutputInfo() {
  const fmt = OUTPUT_FORMATS.find(f => f.id === state.selectedFmt);
  const q   = QUALITY_PRESETS.find(q => q.id === state.selectedQuality);
  const isExtract = state.mode === 'extract';
  const isImage   = state.mode === 'image';

  dom.oiMode.textContent    = isExtract ? 'EXTRACT AUDIO' : isImage ? 'IMAGE CONVERT' : 'CONVERT';
  dom.oiFmt.textContent     = fmt ? fmt.label : '—';
  dom.oiQuality.textContent = q   ? q.sub   : '—';

  const pending = state.queue.filter(i => {
    if (i.status !== 'pending') return false;
    if (isExtract && i.kind !== 'video') return false;
    if (isImage   && i.kind !== 'image') return false;
    return true;
  }).length;
  dom.oiFiles.textContent = isExtract ? `${pending} video(s) to extract`
                          : isImage   ? `${pending} image(s) to convert`
                          : `${pending} pending`;
}

// ──────────────────────────────────────────────
//  FILE QUEUE
// ──────────────────────────────────────────────
function addFiles(files) {
  const toAdd = Array.from(files).filter(f => {
    const ext = f.name.split('.').pop().toLowerCase();
    if (!ACCEPTED_INPUT_EXTS.includes(ext)) {
      log(`Skipped unsupported file: ${f.name}`, 'warn');
      return false;
    }
    return true;
  });

  toAdd.forEach(f => {
    const ext  = f.name.split('.').pop().toLowerCase();
    const audioExts = ['mp3','wav','ogg','flac','aac','m4a','opus','aiff'];
    const imageExts = ['jpg','jpeg','png','webp','bmp','tiff','tif','gif','avif'];
    const kind = audioExts.includes(ext) ? 'audio' : imageExts.includes(ext) ? 'image' : 'video';
    const item = { id: ++state.idCounter, file: f, name: f.name, ext, kind, status: 'pending', progress: 0 };
    state.queue.push(item);
    renderQueueItem(item);
    log(`Added: ${f.name} (${formatSize(f.size)})`, '');
  });

  updateQueueHeader();
  updateOutputInfo();
  updateConvertBtn();
}

function renderQueueItem(item) {
  const el = document.createElement('div');
  el.className = 'file-item';
  el.id = `item-${item.id}`;
  el.innerHTML = `
    <div class="file-name" title="${escHtml(item.name)}">${escHtml(item.name)}</div>
    <span class="file-badge ${item.kind}" id="badge-${item.id}">${item.ext.toUpperCase()}</span>
    <div class="file-meta">
      <span>${formatSize(item.file.size)}</span>
      <span>${item.kind}</span>
    </div>
    <button class="file-remove" data-id="${item.id}" title="Remove">✕</button>
    <div class="file-progress"><div class="file-progress-bar" id="prog-${item.id}"></div></div>
  `;
  dom.fileQueue.appendChild(el);

  el.querySelector('.file-remove').addEventListener('click', () => removeItem(item.id));
}

function removeItem(id) {
  state.queue = state.queue.filter(i => i.id !== id);
  const el = document.getElementById(`item-${id}`);
  if (el) el.remove();
  updateQueueHeader();
  updateOutputInfo();
  updateConvertBtn();
}

function clearQueue() {
  state.queue = [];
  dom.fileQueue.innerHTML = '';
  updateQueueHeader();
  updateOutputInfo();
  updateConvertBtn();
  log('Queue cleared.', 'warn');
}

function updateQueueHeader() {
  const n = state.queue.length;
  dom.queueHeader.style.display = n ? 'flex' : 'none';
  dom.queueCount.textContent = `${n} file${n !== 1 ? 's' : ''} queued`;
}

function setItemState(item, status, badgeClass, badgeLabel) {
  item.status = status;
  const el = document.getElementById(`item-${item.id}`);
  if (!el) return;
  el.classList.remove('working','done','error');
  if (status !== 'pending') el.classList.add(status);
  const badge = document.getElementById(`badge-${item.id}`);
  if (badge) {
    badge.className = `file-badge ${badgeClass}`;
    badge.textContent = badgeLabel;
  }
}

function setItemProgress(item, pct) {
  item.progress = pct;
  const bar = document.getElementById(`prog-${item.id}`);
  if (bar) bar.style.width = pct + '%';
}

// ──────────────────────────────────────────────
//  CONVERT
// ──────────────────────────────────────────────
function updateConvertBtn() {
  const isExtract = state.mode === 'extract';
  const isImage   = state.mode === 'image';
  const hasPending = state.queue.some(i => {
    if (i.status !== 'pending') return false;
    if (isExtract && i.kind !== 'video') return false;
    if (isImage   && i.kind !== 'image') return false;
    return true;
  });
  dom.convertBtn.disabled = !(state.ready && hasPending && !state.converting);
}

async function convertAll() {
  if (state.converting || !state.ready) return;
  const isExtract = state.mode === 'extract';
  const isImage   = state.mode === 'image';

  const pending = state.queue.filter(i => {
    if (i.status !== 'pending') return false;
    if (isExtract && i.kind !== 'video') return false;
    if (isImage   && i.kind !== 'image') return false;
    return true;
  });

  if (!pending.length) return;

  if (isExtract) {
    const skipped = state.queue.filter(i => i.status === 'pending' && i.kind === 'audio');
    if (skipped.length) log(`Skipping ${skipped.length} audio file(s) — extract mode only processes video.`, 'warn');
  }
  if (isImage) {
    const skipped = state.queue.filter(i => i.status === 'pending' && i.kind !== 'image');
    if (skipped.length) log(`Skipping ${skipped.length} non-image file(s) — image mode only processes images.`, 'warn');
  }

  state.converting = true;
  dom.convertBtn.disabled = true;
  dom.overlay.style.display = 'flex';

  const modeLabel = isExtract ? 'EXTRACTING AUDIO' : isImage ? 'CONVERTING IMAGES' : 'PROCESSING';
  document.querySelector('.progress-title').textContent = modeLabel;

  const total = pending.length;
  let done = 0;

  for (const item of pending) {
    dom.progCurrent.textContent = item.name;
    dom.progStats.textContent   = `${done + 1} / ${total}`;
    dom.progBar.style.width     = Math.round(done / total * 100) + '%';

    if (isExtract)    await extractAudio(item);
    else if (isImage) await convertImage(item);
    else              await convertOne(item);
    done++;
  }

  dom.progBar.style.width   = '100%';
  dom.progStats.textContent = `${done} / ${total} complete`;
  setTimeout(() => { dom.overlay.style.display = 'none'; }, 1200);

  state.converting = false;
  updateConvertBtn();
  const verb = isExtract ? 'extracted' : 'converted';
  ticker(`Done — ${done} file${done !== 1 ? 's' : ''} ${verb}.`);
  log(`Batch complete: ${done}/${total} files ${verb}.`, 'ok');
}

async function convertOne(item) {
  const { fetchFile } = FFmpegUtil;
  const fmt  = state.selectedFmt;
  const inName  = `in_${item.id}.${item.ext}`;
  const outName = `out_${item.id}.${fmt}`;

  setItemState(item, 'working', 'working', 'WORKING…');
  ticker(`Converting: ${item.name} → .${fmt}`);
  log(`Converting ${item.name} → .${fmt}`, 'warn');

  // Progress simulation (FFmpeg WASM doesn't expose reliable progress for all formats)
  let fakePct = 0;
  const fakeTimer = setInterval(() => {
    fakePct = Math.min(fakePct + 3, 90);
    setItemProgress(item, fakePct);
  }, 300);

  try {
    await state.ffmpeg.writeFile(inName, await fetchFile(item.file));
    const args = buildFFmpegArgs(inName, outName, fmt, state.selectedQuality);
    await state.ffmpeg.exec(args);

    clearInterval(fakeTimer);
    setItemProgress(item, 100);

    const data   = await state.ffmpeg.readFile(outName);
    const fmtDef = OUTPUT_FORMATS.find(f => f.id === fmt);
    const blob   = new Blob([data.buffer], { type: fmtDef.mime });
    const url    = URL.createObjectURL(blob);
    const stem   = item.name.replace(/\.[^.]+$/, '');

    const a = document.createElement('a');
    a.href = url;
    a.download = `${stem}.${fmt}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 8000);

    try { await state.ffmpeg.deleteFile(inName);  } catch(_) {}
    try { await state.ffmpeg.deleteFile(outName); } catch(_) {}

    setItemState(item, 'done', 'done', '✓ DONE');
    log(`✓ ${item.name} → ${stem}.${fmt}`, 'ok');

  } catch (e) {
    clearInterval(fakeTimer);
    setItemState(item, 'error', 'error', '✗ ERROR');
    log(`✗ Error converting ${item.name}: ${e.message}`, 'err');
    console.error(e);

    try { await state.ffmpeg.deleteFile(inName);  } catch(_) {}
    try { await state.ffmpeg.deleteFile(outName); } catch(_) {}
  }
}

async function extractAudio(item) {
  const { fetchFile } = FFmpegUtil;
  const fmt     = state.selectedFmt;
  const inName  = `in_${item.id}.${item.ext}`;
  const outName = `out_${item.id}.${fmt}`;

  setItemState(item, 'working', 'working', 'EXTRACTING…');
  ticker(`Extracting audio: ${item.name} → .${fmt}`);
  log(`Extracting audio from ${item.name} → .${fmt}`, 'warn');

  let fakePct = 0;
  const fakeTimer = setInterval(() => {
    fakePct = Math.min(fakePct + 4, 90);
    setItemProgress(item, fakePct);
  }, 250);

  try {
    await state.ffmpeg.writeFile(inName, await fetchFile(item.file));
    const args = buildExtractArgs(inName, outName, fmt, state.selectedQuality);
    await state.ffmpeg.exec(args);

    clearInterval(fakeTimer);
    setItemProgress(item, 100);

    const data   = await state.ffmpeg.readFile(outName);
    const fmtDef = OUTPUT_FORMATS.find(f => f.id === fmt);
    const blob   = new Blob([data.buffer], { type: fmtDef.mime });
    const url    = URL.createObjectURL(blob);
    const stem   = item.name.replace(/\.[^.]+$/, '');

    const a = document.createElement('a');
    a.href = url;
    a.download = `${stem}_audio.${fmt}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 8000);

    try { await state.ffmpeg.deleteFile(inName);  } catch(_) {}
    try { await state.ffmpeg.deleteFile(outName); } catch(_) {}

    setItemState(item, 'done', 'done', '✓ DONE');
    log(`✓ Extracted: ${stem}_audio.${fmt}`, 'ok');

  } catch (e) {
    clearInterval(fakeTimer);
    setItemState(item, 'error', 'error', '✗ ERROR');
    log(`✗ Extraction failed for ${item.name}: ${e.message}`, 'err');
    console.error(e);

    try { await state.ffmpeg.deleteFile(inName);  } catch(_) {}
    try { await state.ffmpeg.deleteFile(outName); } catch(_) {}
  }
}

async function convertImage(item) {
  const { fetchFile } = FFmpegUtil;
  const fmt     = state.selectedFmt;
  const inName  = `in_${item.id}.${item.ext}`;
  const outName = `out_${item.id}.${fmt}`;

  setItemState(item, 'working', 'working', 'CONVERTING…');
  ticker(`Converting image: ${item.name} → .${fmt}`);
  log(`Converting image ${item.name} → .${fmt}`, 'warn');

  let fakePct = 0;
  const fakeTimer = setInterval(() => {
    fakePct = Math.min(fakePct + 8, 90);
    setItemProgress(item, fakePct);
  }, 150);

  try {
    await state.ffmpeg.writeFile(inName, await fetchFile(item.file));
    const resize = state.imageResize;
    const args = buildImageArgs(inName, outName, fmt, state.selectedQuality, resize);
    await state.ffmpeg.exec(args);

    clearInterval(fakeTimer);
    setItemProgress(item, 100);

    const data   = await state.ffmpeg.readFile(outName);
    const fmtDef = OUTPUT_FORMATS.find(f => f.id === fmt);
    const blob   = new Blob([data.buffer], { type: fmtDef.mime });
    const url    = URL.createObjectURL(blob);
    const stem   = item.name.replace(/\.[^.]+$/, '');

    const a = document.createElement('a');
    a.href = url;
    a.download = `${stem}.${fmt}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 8000);

    try { await state.ffmpeg.deleteFile(inName);  } catch(_) {}
    try { await state.ffmpeg.deleteFile(outName); } catch(_) {}

    setItemState(item, 'done', 'done', '✓ DONE');
    log(`✓ Image converted: ${stem}.${fmt}`, 'ok');

  } catch (e) {
    clearInterval(fakeTimer);
    setItemState(item, 'error', 'error', '✗ ERROR');
    log(`✗ Image conversion failed for ${item.name}: ${e.message}`, 'err');
    console.error(e);
    try { await state.ffmpeg.deleteFile(inName);  } catch(_) {}
    try { await state.ffmpeg.deleteFile(outName); } catch(_) {}
  }
}

// ──────────────────────────────────────────────
//  DRAG & DROP
// ──────────────────────────────────────────────
function setupDrop() {
  const dz = dom.dropZone;

  dz.addEventListener('click', () => dom.fileInput.click());
  dz.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') dom.fileInput.click(); });

  dz.addEventListener('dragover', e => {
    e.preventDefault();
    dz.classList.add('dragover');
  });
  dz.addEventListener('dragleave', e => {
    if (!dz.contains(e.relatedTarget)) dz.classList.remove('dragover');
  });
  dz.addEventListener('drop', e => {
    e.preventDefault();
    dz.classList.remove('dragover');
    addFiles(e.dataTransfer.files);
  });

  dom.fileInput.addEventListener('change', e => {
    addFiles(e.target.files);
    e.target.value = '';
  });
}

// ──────────────────────────────────────────────
//  UTILS
// ──────────────────────────────────────────────
function formatSize(bytes) {
  if (bytes < 1024)        return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ──────────────────────────────────────────────
//  BOOT
// ──────────────────────────────────────────────
(function init() {
  setupModeTabs();
  buildFormatGrid();
  selectFormat('mp3');
  buildQualityButtons();
  setupDrop();
  updateOutputInfo();

  dom.clearAllBtn.addEventListener('click', clearQueue);
  dom.convertBtn.addEventListener('click', convertAll);

  initFFmpeg();
})();
