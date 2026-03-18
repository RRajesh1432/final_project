/**
 * PFT-AST Frontend · Unified App Script
 * Works on all 4 pages. PAGE variable set per-page.
 * Connects to BACKEND_URL (Railway) via Socket.IO + REST.
 */
'use strict';

// ── Config ─────────────────────────────────────────────────────
// Set BACKEND_URL in Vercel env vars → window.BACKEND_URL
// Falls back to same origin for local dev
const API = window.BACKEND_URL || '';

const THREATS = ['gunshot','explosion','glass','scream','siren'];
const TAU = 0.75;

// ── State ──────────────────────────────────────────────────────
let _chart = null, _socket = null, _swReg = null;
let _mediaRec = null, _chunks = [], _blob = null;
let _timerInt = null, _recSecs = 0;
let _actx = null, _analyser = null, _raf = null;
let _feedCt = 0, _alertCt = 0, _subbed = false;
let _deferredInstall = null;
let _deviceId     = null;   // persistent device ID stored in localStorage
let _userLocation = null;   // {lat, lng} from browser geolocation
let _liveActive   = false;  // continuous recording active flag
let _liveStream   = null;   // MediaStream for continuous recording
let _liveChunkN   = 0;      // chunk counter
// model polling handled by v6 startModelPoll / _modelReady

// ═══════════════════════════════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════════════════════════════
function initPage() {
  initDeviceInfo();
  highlightNav();
  connectSocket();
  registerSW();
  fetchStats();
  startModelPoll();   // poll /api/status until model is ready

  const P = window.PAGE;
  if (P === 'dashboard')     initDash();
  if (P === 'analyze')       { initAnalyze(); _enableAnalyzeBtn(false); }
  if (P === 'history')       initHistory();
  if (P === 'alerts')        initAlerts();
  if (P === 'localise')      initLocalise();
  _initNewSocketHandlers();
}


// ═══════════════════════════════════════════════════════════════
//  NAV
// ═══════════════════════════════════════════════════════════════
function highlightNav() {
  const P = window.PAGE;
  document.querySelectorAll('.nav-a').forEach(a => a.classList.toggle('on', a.dataset.p === P));
  document.querySelectorAll('.bn').forEach(a => a.classList.toggle('on', a.dataset.p === P));
}
function openNav() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('overlay').classList.add('on');
}
function closeNav() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('overlay')?.classList.remove('on');
}

// ═══════════════════════════════════════════════════════════════
//  SERVICE WORKER + PWA INSTALL
// ═══════════════════════════════════════════════════════════════
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').then(r => {
    _swReg = r;
    checkSub();
  }).catch(e => console.warn('[SW]', e));

  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    _deferredInstall = e;
    const btn = document.getElementById('btnInstall');
    const st  = document.getElementById('installSt');
    if (btn) btn.style.display = 'block';
    if (st)  st.textContent = 'App can be installed — tap button above';
  });
  window.addEventListener('appinstalled', () => {
    const st = document.getElementById('installSt');
    if (st) st.textContent = '✓ App installed successfully!';
    const btn = document.getElementById('btnInstall');
    if (btn) btn.style.display = 'none';
  });
}

function doInstall() {
  if (!_deferredInstall) return;
  _deferredInstall.prompt();
}

// ═══════════════════════════════════════════════════════════════
//  PUSH NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════
async function checkSub() {
  if (!_swReg) return;
  try {
    const s = await _swReg.pushManager.getSubscription();
    _subbed = !!s;
    updateSubUI();
  } catch(_) {}
}

async function togglePush() {
  _subbed ? await unsubscribePush() : await subscribePush();
}

async function subscribePush() {
  if (!_swReg) return;
  try {
    const res = await apiFetch('/api/vapid-key');
    if (!res.key) { setPushStatus('Push not configured on server.'); return; }

    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { setPushStatus('Permission denied.'); return; }

    const sub = await _swReg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64ToUint8(res.key)
    });
    await apiPost('/api/subscribe', sub.toJSON());
    _subbed = true;
    updateSubUI();
  } catch (e) { setPushStatus('Error: ' + e.message); }
}

async function unsubscribePush() {
  try {
    const sub = await _swReg?.pushManager.getSubscription();
    if (sub) {
      await apiPost('/api/unsubscribe', { endpoint: sub.endpoint });
      await sub.unsubscribe();
    }
    _subbed = false;
    updateSubUI();
  } catch(e) { console.error(e); }
}

function updateSubUI() {
  const btn = document.getElementById('btnPush');
  const st  = document.getElementById('pushSt');
  if (!btn) return;
  if (_subbed) {
    btn.textContent = 'Disable Notifications';
    btn.classList.add('sub');
    if (st) st.textContent = '✓ Push enabled — you\'ll get alerts when app is closed';
  } else {
    btn.textContent = 'Enable Push Notifications';
    btn.classList.remove('sub');
    if (st) st.textContent = 'Not subscribed yet';
  }
}
function setPushStatus(msg) { const el = document.getElementById('pushSt'); if (el) el.textContent = msg; }
function b64ToUint8(b64) {
  const p = '='.repeat((4 - b64.length%4)%4);
  const raw = atob((b64+p).replace(/-/g,'+').replace(/_/g,'/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// ═══════════════════════════════════════════════════════════════
//  SOCKET.IO
// ═══════════════════════════════════════════════════════════════
function connectSocket() {
  _socket = io(API, { transports: ['websocket','polling'], reconnectionDelay: 2000 });
  _socket.on('connect',    () => setConn(true));
  _socket.on('disconnect', () => setConn(false));
  _socket.on('reconnect',  () => setConn(true));
  _socket.on('stats_update', s => updateStatTiles(s));

  // ← fires when ANY device (mobile or desktop) submits audio
  _socket.on('analysis_result', data => {
    updateStatTiles(data.stats);
    if (data.threat_detected) {
      bumpAlerts();
      showBanner(data);
      setStatusChip(true);
    } else {
      setStatusChip(false);
    }
    if (window.PAGE === 'dashboard') { renderDash(data); addFeedRow(data); }
    if (window.PAGE === 'alerts')    { prependLiveAlert(data); }
    if (window.PAGE === 'history')   { fetchHistory(); }
  });
}

function setConn(on) {
  const el = document.getElementById('connBadge');
  const ld = document.getElementById('liveDot');
  const ll = document.getElementById('liveLabel');
  if (el) el.className = 'conn-badge' + (on ? '' : ' off');
  if (ld) ld.parentElement.className = 'live-pill' + (on ? '' : ' off');
  if (ll) ll.textContent = on ? 'SYSTEM ONLINE' : 'RECONNECTING...';
}

// ═══════════════════════════════════════════════════════════════
//  API HELPERS
// ═══════════════════════════════════════════════════════════════
async function apiFetch(path) {
  const r = await fetch(API + path);
  return r.json();
}
async function apiPost(path, body) {
  const r = await fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
async function apiPredict(formData) {
  const r = await fetch(API + '/api/predict', { method: 'POST', body: formData });
  return r.json();
}

// ═══════════════════════════════════════════════════════════════
//  STATS
// ═══════════════════════════════════════════════════════════════
async function fetchStats() {
  try { updateStatTiles(await apiFetch('/api/stats')); } catch(_) {}
}
function updateStatTiles(s) {
  set('sTotal',   s.total   ?? 0);
  set('sThreat',  s.threats ?? 0);
  set('sAvg',     s.avg_score != null ? (s.avg_score*100).toFixed(1)+'%' : '—');
  set('sRate',    (s.threat_rate ?? 0)+'%');
}

// ═══════════════════════════════════════════════════════════════
//  UI HELPERS
// ═══════════════════════════════════════════════════════════════
function set(id, v) { const e = document.getElementById(id); if (e) e.textContent = v; }

function setStatusChip(danger) {
  const el = document.getElementById('statusChip');
  if (!el) return;
  el.className = 'status-chip' + (danger ? ' danger' : '');
  el.querySelector('.status-txt').textContent = danger ? 'THREAT' : 'SAFE';
}

function showBanner(data) {
  const bar = document.getElementById('alertBanner');
  const det = document.getElementById('bannerDetail');
  if (!bar) return;
  const top = data.multi_threat?.[0]?.label || 'Unknown';
  if (det) det.textContent = `${top.toUpperCase()} · ${(data.threat_score*100).toFixed(1)}% · ${data.source}`;
  bar.classList.add('show');
  setTimeout(() => bar.classList.remove('show'), 9000);
}

function closeBanner() { document.getElementById('alertBanner')?.classList.remove('show'); }

function bumpAlerts() {
  _alertCt++;
  const bc  = document.getElementById('bellCount');
  const nb  = document.getElementById('bellBtn');
  const bnd = document.getElementById('bnAlertDot');
  const nbd = document.getElementById('navAlertBadge');
  if (bc)  { bc.textContent = _alertCt; bc.classList.add('show'); }
  if (nb)  nb.classList.add('danger');
  if (bnd) { bnd.textContent = _alertCt; bnd.classList.add('show'); }
  if (nbd) { nbd.textContent = _alertCt; nbd.classList.add('show'); }
}

let _loaderTimer = null;

const _LOADER_STEPS = [
  [0,   'Uploading audio...'],
  [800, 'Decoding audio (10s clip)...'],
  [1500,'Building mel spectrogram...'],
  [2200,'Running AST inference (batched)...'],
  [4000,'Processing 5 temporal segments...'],
  [5500,'Finalising results...'],
];

function showLoader(msg) {
  const el = document.getElementById('loader');
  if (el) el.classList.add('on');
  const m  = document.getElementById('loaderMsg');
  const t  = document.getElementById('loaderTimer');
  if (m && msg) m.textContent = msg;
  // animated step messages
  clearTimeout(_loaderTimer);
  let start = Date.now();
  let si = 0;
  function tick() {
    let elapsed = Date.now() - start;
    while (si < _LOADER_STEPS.length && elapsed >= _LOADER_STEPS[si][0]) si++;
    if (si < _LOADER_STEPS.length) {
      if (m) m.textContent = _LOADER_STEPS[si][1];
    }
    if (t) t.textContent = (elapsed / 1000).toFixed(1) + 's';
    _loaderTimer = setTimeout(tick, 200);
  }
  tick();
}

function hideLoader() {
  clearTimeout(_loaderTimer);
  document.getElementById('loader')?.classList.remove('on');
  const t = document.getElementById('loaderTimer');
  if (t) t.textContent = '';
}

// ═══════════════════════════════════════════════════════════════
//  DASHBOARD
// ═══════════════════════════════════════════════════════════════
function initDash() {}

function renderDash(data) {
  drawGauge(data.threat_score, data.risk);
  renderSpec(data.spectrogram);
  renderClasses(data.all_sounds, 'clsList', 12);
  drawProbChart(data.frames);
  renderThrBreak(data.threat_detail || data.multi_threat);
  renderTimeline(data.frames);
}

function addFeedRow(data) {
  _feedCt++;
  const list = document.getElementById('feedList');
  if (!list) return;
  list.querySelector('.empty')?.remove();
  const top = data.all_sounds?.[0]?.label || '—';
  const t   = data.threat_detected;
  const src = data.source || 'upload';
  const el  = document.createElement('div');
  el.className = `feed-row${t ? ' thr' : ''}`;
  el.innerHTML = `
    <div class="fd${t?' thr':''}"></div>
    <div class="fi"><div class="fc">${top}</div><div class="fm">${t?'⚠ THREAT · ':''}${new Date().toLocaleTimeString()}</div></div>
    <div class="fs-n${t?' thr':''}">${(data.threat_score*100).toFixed(1)}%</div>
    <span class="f-src ${src}">${src}</span>`;
  list.insertBefore(el, list.firstChild);
  while (list.children.length > 20) list.removeChild(list.lastChild);
  set('feedCount', _feedCt + ' event' + (_feedCt===1?'':'s'));
}

// ═══════════════════════════════════════════════════════════════
//  ANALYZE
// ═══════════════════════════════════════════════════════════════
function initAnalyze() {
  const dz    = document.getElementById('dropzone');
  const input = document.getElementById('audioIn');
  if (dz) {
    dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragleave', ()  => dz.classList.remove('over'));
    dz.addEventListener('drop',      e  => { e.preventDefault(); dz.classList.remove('over'); if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); });
    dz.addEventListener('click',     e  => { if (e.target.tagName !== 'BUTTON') input?.click(); });
  }
  if (input) input.addEventListener('change', () => { if (input.files[0]) setFile(input.files[0]); });
}

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('on', p.id === 'pane-'+tab));
}

function setFile(file) {
  const dt = new DataTransfer(); dt.items.add(file);
  const inp = document.getElementById('audioIn');
  if (inp) inp.files = dt.files;
  document.getElementById('dropzone').style.display = 'none';
  const chip = document.getElementById('fileChip');
  if (chip) chip.classList.add('show');
  set('fcName', file.name); set('fcSize', fmtBytes(file.size));
}

function clearFile() {
  const inp = document.getElementById('audioIn');
  if (inp) inp.value = '';
  document.getElementById('dropzone').style.display = '';
  document.getElementById('fileChip')?.classList.remove('show');
}

async function analyzeUpload() {
  const inp = document.getElementById('audioIn');
  if (!inp?.files[0]) { alert('Select an audio file first.'); return; }
  if (!_modelReady) { alert('Model is still loading. Please wait 1-2 minutes.'); return; }
  showLoader('Analyzing with PFT-AST...');
  const fd = new FormData(); fd.append('audio', inp.files[0]); fd.append('source','upload');
  fd.append('device_id', _deviceId||''); fd.append('location', getLocationString());
  try {
    const r    = await fetch(API + '/api/predict', { method: 'POST', body: fd });
    const data = await r.json();
    if (!r.ok) {
      if (r.status === 503) { alert('Model is still loading. Please wait and retry.'); return; }
      alert('Error: ' + (data.error || r.statusText)); return;
    }
    showResult(data);
  } catch(e) { alert('Network error: ' + e.message); }
  finally { hideLoader(); }
}

async function analyzeRec() {
  if (!_blob) return;
  if (!_modelReady) { alert('Model is still loading. Please wait 1-2 minutes.'); return; }
  showLoader('Analyzing recording...');
  const ext  = _blob.type.includes('ogg') ? 'ogg' : 'webm';
  const file = new File([_blob], 'rec.' + ext, { type: _blob.type });
  const fd   = new FormData(); fd.append('audio', file); fd.append('source','record');
  fd.append('device_id', _deviceId||''); fd.append('location', getLocationString());
  try {
    const r    = await fetch(API + '/api/predict', { method: 'POST', body: fd });
    const data = await r.json();
    if (!r.ok) {
      if (r.status === 503) { alert('Model is still loading. Please wait and retry.'); return; }
      alert('Error: ' + (data.error || r.statusText)); return;
    }
    showResult(data);
  } catch(e) { alert('Network error: ' + e.message); }
  finally { hideLoader(); }
}

function showResult(data) {
  const card = document.getElementById('resultCard');
  if (!card) return;
  card.style.display = 'block';
  const pct  = (data.threat_score*100).toFixed(1)+'%';
  const risk = data.risk || (data.threat_detected ? 'HIGH' : 'SAFE');

  // ── Result summary card ──────────────────────────────────
  set('resPct', pct);
  const rt = document.getElementById('resRisk');
  if (rt) { rt.textContent = risk; rt.className = 'rtag r-' + risk.toLowerCase(); }
  drawMiniGauge('resGauge', data.threat_score);

  // Detection method label
  const det = document.getElementById('resDetectedVia');
  if (det && data.threat_detected) {
    det.textContent = `Detected via: Score_t=${(data.threat_score).toFixed(3)}>=${data.threshold||0.25}`;
    det.style.display = 'block';
  } else if (det) { det.style.display = 'none'; }

  // Cache hit badge
  const ch = document.getElementById('resCacheHit');
  if (ch) { ch.style.display = data.cache_hit ? 'inline-flex' : 'none'; }

  // Top 10 classes
  renderClasses(data.all_sounds, 'resClasses', 10);

  // ── Full analysis panels ─────────────────────────────────
  const full = document.getElementById('fullResult');
  if (full) full.style.display = 'block';

  // Spectrogram
  const sp = document.getElementById('resSpec');
  if (sp && data.spectrogram) { sp.src = `data:image/png;base64,${data.spectrogram}`; sp.style.display='block'; }

  // Waveform
  const wv = document.getElementById('resWave');
  if (wv && data.waveform_img) { wv.src = `data:image/png;base64,${data.waveform_img}`; wv.style.display='block'; }

  // Threat class scores (5 bars)
  renderThreatDetail(data.threat_detail || data.multi_threat);

  // Audio metadata
  renderAudioMeta(data);

  // Temporal segments
  renderTemporalFrames(data.frames);

  card.scrollIntoView({ behavior: 'smooth' });
  if (data.threat_detected) showBanner(data);
}

function renderThreatDetail(threats) {
  const el = document.getElementById('resThrDetail'); if (!el || !threats) return;
  const TAU_DISPLAY = 0.25; // base model threshold
  el.innerHTML = threats.map(t => {
    const pct   = t.pct !== undefined ? t.pct : (t.score||0)*100;
    const label = t.class || t.label || '—';
    const cls   = pct >= 25 ? 'high' : pct >= 10 ? 'med' : 'low';
    const flag  = pct >= TAU_DISPLAY*100;
    return `<div class="thr-detail-row">
      <div class="thr-detail-hd">
        <span class="thr-detail-name">${label}</span>
        <span class="thr-detail-pct ${flag?'flag':''}">${pct.toFixed(1)}%</span>
      </div>
      <div class="thr-detail-bar-bg">
        <div class="thr-detail-bar ${cls}" style="width:${Math.min(pct,100)}%"></div>
      </div>
    </div>`;
  }).join('');
}

function renderAudioMeta(data) {
  const el = document.getElementById('resAudioMeta'); if (!el) return;
  el.innerHTML = `
    <div class="meta-tile"><div class="meta-tile-val">${data.duration||'—'}s</div><div class="meta-tile-lbl">DURATION</div></div>
    <div class="meta-tile"><div class="meta-tile-val">${data.sample_rate||16000}</div><div class="meta-tile-lbl">SAMPLE RATE</div></div>
    <div class="meta-tile"><div class="meta-tile-val">${data.all_sounds?.length||527}</div><div class="meta-tile-lbl">CLASSES</div></div>
    <div class="meta-tile"><div class="meta-tile-val thr">${(data.threshold||0.25).toFixed(2)}</div><div class="meta-tile-lbl">THRESHOLD &tau;</div></div>`;
}

function renderTemporalFrames(frames) {
  const el = document.getElementById('resFrames'); if (!el || !frames) return;
  el.innerHTML = frames.map(f => {
    const pct = (f.threat_score*100).toFixed(1);
    const isThr = f.is_threat || f.threat_score >= 0.25;
    return `<div class="seg-card ${isThr?'threat':''}">
      <div class="seg-time">${f.start}s &ndash; ${f.end}s</div>
      <div class="seg-label ${isThr?'threat':''}">${f.label}</div>
      <div class="seg-score ${isThr?'threat':''}">${pct}%</div>
      ${isThr ? '<div class="seg-badge threat">&#x26A0; THREAT</div>' : '<div class="seg-badge safe">&#x2713; Safe</div>'}
    </div>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════════════
//  RECORDING
// ═══════════════════════════════════════════════════════════════
function getMime() {
  return ['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/mp4','audio/webm'].find(t => MediaRecorder.isTypeSupported(t)) || '';
}

async function toggleRec() {
  (_mediaRec?.state === 'recording') ? stopRec() : await startRec();
}

async function startRec() {
  _chunks = []; _blob = null;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate:16000, channelCount:1, echoCancellation:true } });
    _actx    = new AudioContext();
    _analyser = _actx.createAnalyser(); _analyser.fftSize = 512;
    _actx.createMediaStreamSource(stream).connect(_analyser);
    drawRecWave();

    _mediaRec = new MediaRecorder(stream, { mimeType: getMime() });
    _mediaRec.ondataavailable = e => { if (e.data.size>0) _chunks.push(e.data); };
    _mediaRec.onstop = () => {
      _blob = new Blob(_chunks, { type: getMime() || 'audio/webm' });
      stopRecViz();
      const btn = document.getElementById('btnAnalyzeRec');
      if (btn) btn.disabled = false;
      setRecLbl('Ready · ' + _recSecs + 's recorded');
    };
    _mediaRec.start(100);

    _recSecs = 0;
    _timerInt = setInterval(() => {
      _recSecs++;
      const el = document.getElementById('recTimer');
      if (el) { el.textContent = `${pad(_recSecs/60|0)}:${pad(_recSecs%60)}`; el.classList.add('on'); }
      if (_recSecs >= 60) stopRec();
    }, 1000);

    document.getElementById('btnRec')?.classList.add('on');
    set('recBtnLbl', 'Stop');
    setRecLbl('● RECORDING');
  } catch(e) { alert('Mic access denied: '+e.message); }
}

function stopRec() {
  if (_mediaRec?.state === 'recording') { _mediaRec.stop(); _mediaRec.stream.getTracks().forEach(t=>t.stop()); }
  clearInterval(_timerInt);
  document.getElementById('btnRec')?.classList.remove('on');
  set('recBtnLbl', 'Record');
  document.getElementById('recTimer')?.classList.remove('on');
}

function drawRecWave() {
  const canvas = document.getElementById('recC');
  if (!canvas || !_analyser) return;
  canvas.width  = canvas.offsetWidth * devicePixelRatio;
  canvas.height = 80 * devicePixelRatio;
  const ctx = canvas.getContext('2d');
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const W = canvas.offsetWidth, H = 80;
  const buf = new Uint8Array(_analyser.frequencyBinCount);
  function draw() {
    _raf = requestAnimationFrame(draw);
    _analyser.getByteTimeDomainData(buf);
    ctx.clearRect(0,0,W,H);
    ctx.beginPath(); ctx.strokeStyle='#00e5ff'; ctx.lineWidth=1.5;
    buf.forEach((v,i) => { const y=(v/128)*(H/2); i?ctx.lineTo(i*(W/buf.length),y):ctx.moveTo(0,y); });
    ctx.stroke();
  }
  draw();
}

function stopRecViz() {
  cancelAnimationFrame(_raf);
  if (_actx) { _actx.close(); _actx=null; }
}

function setRecLbl(msg) { const e=document.getElementById('recVizLbl'); if(e) e.textContent=msg; }
function pad(n) { return String(n).padStart(2,'0'); }

// ═══════════════════════════════════════════════════════════════
//  HISTORY
// ═══════════════════════════════════════════════════════════════
async function initHistory() { await fetchHistory(); }

async function fetchHistory() {
  try {
    const [hist, stats] = await Promise.all([apiFetch('/api/history?limit=100'), apiFetch('/api/stats')]);
    updateStatTiles(stats);
    renderHistStats(stats);
    renderHistTable(hist);
  } catch(e) { console.error(e); }
}

function renderHistStats(s) {
  const el = document.getElementById('histStats');
  if (!el) return;
  el.innerHTML = `
    <div class="stat"><div class="stat-ic si-c"><svg width="17" height="17" viewBox="0 0 17 17" fill="none" stroke="#00e5ff" stroke-width="1.5"><rect x="2" y="2" width="13" height="13" rx="2"/><line x1="2" y1="7" x2="15" y2="7"/></svg></div><div><div class="stat-n">${s.total}</div><div class="stat-l">Total</div></div></div>
    <div class="stat r"><div class="stat-ic si-r"><svg width="17" height="17" viewBox="0 0 17 17" fill="none" stroke="#ff5252" stroke-width="1.5"><path d="M8.5 2L1 15h15L8.5 2z"/><line x1="8.5" y1="8" x2="8.5" y2="11"/></svg></div><div><div class="stat-n">${s.threats}</div><div class="stat-l">Threats</div></div></div>
    <div class="stat"><div class="stat-ic si-g"><svg width="17" height="17" viewBox="0 0 17 17" fill="none" stroke="#00e676" stroke-width="1.5"><path d="M8.5 1L2 4.5v5.5c0 3.5 3 6 6.5 6s6.5-2.5 6.5-6V4.5L8.5 1z"/></svg></div><div><div class="stat-n">${s.safe}</div><div class="stat-l">Safe</div></div></div>
    <div class="stat"><div class="stat-ic si-y"><svg width="17" height="17" viewBox="0 0 17 17" fill="none" stroke="#ffc107" stroke-width="1.5"><circle cx="8.5" cy="8.5" r="6.5"/><line x1="8.5" y1="5" x2="8.5" y2="8.5"/><line x1="8.5" y1="8.5" x2="11" y2="10"/></svg></div><div><div class="stat-n">${s.threat_rate}%</div><div class="stat-l">Rate</div></div></div>`;
}

function renderHistTable(rows) {
  const el = document.getElementById('histTable');
  if (!el) return;
  if (!rows.length) { el.innerHTML = '<div class="empty" style="padding:28px">No analyses yet.</div>'; return; }
  const rTag = r => `<span class="rtag r-${r.toLowerCase()}">${r}</span>`;
  el.innerHTML = `
    <div class="h-hd"><div>#</div><div>Top Class</div><div>Score</div><div>Risk</div><div>Source</div><div>Time</div><div></div></div>
    ${rows.map(r=>`
    <div class="h-row${r.threat?' thr':''}" onclick="openHistoryModal(${r.id})" style="cursor:pointer">
      <div class="h-id">${r.id}</div>
      <div class="h-cls">${r.top_class||'—'}</div>
      <div class="h-sc">${(r.score*100).toFixed(1)}%</div>
      <div>${rTag(r.risk)}</div>
      <div><span class="s-tag">${r.source||'upload'}</span></div>
      <div class="h-time">${r.date||''} ${r.time||''}</div>
      <div><button class="h-view-btn" onclick="event.stopPropagation();openHistoryModal(${r.id})">View &#8599;</button></div>
    </div>`).join('')}`;
}

// ═══════════════════════════════════════════════════════════════
//  ALERTS PAGE
// ═══════════════════════════════════════════════════════════════
async function initAlerts() {
  initNtfy();
  checkSub();
  try {
    const data = await apiFetch('/api/alerts');
    renderHistAlerts(data);
  } catch(_) {}
}

function renderHistAlerts(rows) {
  const el = document.getElementById('histAlerts');
  if (!el) return;
  if (!rows.length) { el.innerHTML = '<div class="empty" style="padding:24px">No threats recorded yet.</div>'; return; }
  el.innerHTML = rows.map(r => `
    <div class="alert-item">
      <div class="ai-icon">⚠</div>
      <div class="ai-body">
        <div class="ai-title">${(r.top_class||'Unknown').toUpperCase()}</div>
        <div class="ai-detail">Score ${(r.score*100).toFixed(1)}% · Source: ${r.source||'upload'}</div>
        <div class="ai-time">${r.date} ${r.time}</div>
      </div>
      <div class="ai-score">${(r.score*100).toFixed(0)}%</div>
    </div>`).join('');
}

function prependLiveAlert(data) {
  const el   = document.getElementById('liveAlerts');
  if (!el) return;
  el.querySelector('.empty')?.remove();
  const top  = data.multi_threat?.[0]?.label || 'Unknown';
  const item = document.createElement('div');
  item.className = 'alert-item';
  item.innerHTML = `
    <div class="ai-icon">⚠</div>
    <div class="ai-body">
      <div class="ai-title">${top.toUpperCase()} — LIVE</div>
      <div class="ai-detail">Score ${(data.threat_score*100).toFixed(1)}% · ${data.source}</div>
      <div class="ai-time">${new Date().toLocaleString()}</div>
    </div>
    <div class="ai-score" style="color:var(--red2)">${(data.threat_score*100).toFixed(0)}%</div>`;
  el.insertBefore(item, el.firstChild);
  const n = el.querySelectorAll('.alert-item').length;
  set('liveAlertCt', n + ' alert' + (n===1?'':'s'));
}

// ═══════════════════════════════════════════════════════════════
//  GAUGE
// ═══════════════════════════════════════════════════════════════
function drawGauge(score, risk) {
  const canvas = document.getElementById('gaugeC');
  if (!canvas) return;
  const S=160, cx=S/2, cy=S/2, r=66;
  canvas.width=S; canvas.height=S;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,S,S);

  // Track
  ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2);
  ctx.strokeStyle='rgba(255,255,255,.04)'; ctx.lineWidth=12; ctx.stroke();

  // Zones
  [[0,.3,'rgba(0,230,118,.07)'],[.3,TAU,'rgba(255,193,7,.07)'],[TAU,1,'rgba(255,23,68,.07)']].forEach(([a,b,c])=>{
    ctx.beginPath(); ctx.arc(cx,cy,r,-Math.PI/2+a*Math.PI*2,-Math.PI/2+b*Math.PI*2);
    ctx.strokeStyle=c; ctx.lineWidth=12; ctx.stroke();
  });

  // Fill
  const clr = score>=TAU ? '#ff1744' : score>=.3 ? '#ffc107' : '#00e676';
  const g = ctx.createLinearGradient(cx-r,cy,cx+r,cy);
  if (score>=TAU){ g.addColorStop(0,'#ff1744'); g.addColorStop(1,'#ff6d00'); }
  else if(score>=.3){ g.addColorStop(0,'#ffc107'); g.addColorStop(1,'#ffea00'); }
  else{ g.addColorStop(0,'#00e676'); g.addColorStop(1,'#69f0ae'); }

  ctx.beginPath(); ctx.arc(cx,cy,r,-Math.PI/2,-Math.PI/2+(score||0)*Math.PI*2);
  ctx.strokeStyle=g; ctx.lineWidth=12; ctx.lineCap='round'; ctx.stroke();
  if (score>=TAU) {
    ctx.beginPath(); ctx.arc(cx,cy,r,-Math.PI/2,-Math.PI/2+score*Math.PI*2);
    ctx.strokeStyle='rgba(255,23,68,.2)'; ctx.lineWidth=20; ctx.stroke();
  }

  // τ marker
  const ta=-Math.PI/2+TAU*Math.PI*2;
  ctx.beginPath();
  ctx.moveTo(cx+(r-7)*Math.cos(ta), cy+(r-7)*Math.sin(ta));
  ctx.lineTo(cx+(r+6)*Math.cos(ta), cy+(r+6)*Math.sin(ta));
  ctx.strokeStyle='rgba(255,255,255,.45)'; ctx.lineWidth=2; ctx.lineCap='round'; ctx.stroke();

  const pe=document.getElementById('gaugePct'); const le=document.getElementById('gaugeRisk');
  if(pe){ pe.textContent=score!=null?Math.round(score*100)+'%':'—'; pe.style.color=clr; }
  if(le){ le.textContent=risk||'—'; le.className='gauge-risk'+(risk==='HIGH'?' danger':risk==='MEDIUM'?' medium':''); }
}

function drawMiniGauge(id, score) {
  const canvas=document.getElementById(id); if(!canvas) return;
  const S=84,cx=S/2,cy=S/2,r=32;
  canvas.width=S; canvas.height=S;
  const ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,S,S);
  ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.strokeStyle='rgba(255,255,255,.05)'; ctx.lineWidth=7; ctx.stroke();
  const clr=score>=TAU?'#ff1744':score>=.3?'#ffc107':'#00e676';
  ctx.beginPath(); ctx.arc(cx,cy,r,-Math.PI/2,-Math.PI/2+(score||0)*Math.PI*2);
  ctx.strokeStyle=clr; ctx.lineWidth=7; ctx.lineCap='round'; ctx.stroke();
  ctx.fillStyle=clr; ctx.font='bold 13px Orbitron,sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText(Math.round(score*100)+'%', cx, cy);
}

// ═══════════════════════════════════════════════════════════════
//  SPECTROGRAM
// ═══════════════════════════════════════════════════════════════
function renderSpec(b64) {
  const img=document.getElementById('specImg'); const emp=document.getElementById('specEmpty');
  if(!img||!b64) return;
  img.src=`data:image/png;base64,${b64}`; img.style.display='block';
  if(emp) emp.style.display='none';
}

// ═══════════════════════════════════════════════════════════════
//  CHART
// ═══════════════════════════════════════════════════════════════
function drawProbChart(frames) {
  const el=document.getElementById('probChart'); if(!el) return;
  if(_chart) _chart.destroy();
  const labels=frames.map(f=>f.start+'s');
  const probs=frames.map(f=>+(f.confidence*100).toFixed(1));
  _chart=new Chart(el.getContext('2d'),{
    type:'line',
    data:{labels,datasets:[{label:'Threat %',data:probs,fill:true,tension:.42,borderColor:'#00e5ff',borderWidth:2,
      backgroundColor:c=>{const g=c.chart.ctx.createLinearGradient(0,0,0,120);g.addColorStop(0,'rgba(0,229,255,.13)');g.addColorStop(1,'rgba(0,229,255,0)');return g;},
      pointBackgroundColor:probs.map(p=>p>=75?'#ff1744':p>=30?'#ffc107':'#00e676'),
      pointRadius:5,pointHoverRadius:7}]},
    options:{responsive:true,maintainAspectRatio:true,
      plugins:{legend:{display:false},tooltip:{backgroundColor:'rgba(10,20,34,.95)',borderColor:'rgba(0,229,255,.3)',borderWidth:1,titleColor:'#8ba7c7',bodyColor:'#00e5ff',bodyFont:{family:'Space Mono',size:11}}},
      scales:{x:{ticks:{color:'#4a6080',font:{family:'Space Mono',size:9}},grid:{color:'rgba(255,255,255,.025)'}},
              y:{min:0,max:100,ticks:{color:'#4a6080',font:{family:'Space Mono',size:9},callback:v=>v+'%'},grid:{color:'rgba(255,255,255,.025)'}}}}
  });
}

// ═══════════════════════════════════════════════════════════════
//  THREAT BREAKDOWN
// ═══════════════════════════════════════════════════════════════
function renderThrBreak(threats) {
  const el=document.getElementById('thrList'); if(!el) return;
  if(!threats?.length){el.innerHTML='<div class="empty">No threat classes detected</div>';return;}
  el.innerHTML=threats.map(t=>{const p=(t.score*100).toFixed(1);return`<div class="thr-row"><div class="thr-hd"><span class="thr-n">${t.label}</span><span class="thr-p">${p}%</span></div><div class="thr-bg"><div class="thr-fill" style="width:${p}%"></div></div></div>`}).join('');
}

// ═══════════════════════════════════════════════════════════════
//  TIMELINE
// ═══════════════════════════════════════════════════════════════
function renderTimeline(frames) {
  const el=document.getElementById('tlList'); if(!el) return;
  el.innerHTML=frames.map(f=>{const t=f.is_threat||THREATS.some(x=>f.label.includes(x));return`<div class="tl-row${t?' thr':''}"><div class="tl-d${t?' thr':''}"></div><span class="tl-t">${f.start}–${f.end}s</span><span class="tl-l${t?' thr':''}">${f.label}</span><span class="tl-c">${(f.confidence*100).toFixed(0)}%</span></div>`;}).join('');
}

// ═══════════════════════════════════════════════════════════════
//  CLASSES LIST
// ═══════════════════════════════════════════════════════════════
function renderClasses(sounds, id, max) {
  const el=document.getElementById(id); if(!el) return;
  if(!sounds?.length){el.innerHTML='<div class="empty">No data</div>';return;}
  const list=max?sounds.slice(0,max):sounds;
  el.innerHTML=list.map(s=>{const p=(s.score*100).toFixed(1);const t=THREATS.some(x=>s.label.includes(x));return`<div class="cls-row${t?' thr':''}"><span class="cls-n">${s.label}</span><div class="cls-bg"><div class="cls-fill" style="width:${Math.min(parseFloat(p)*3,100)}%"></div></div><span class="cls-p">${p}%</span></div>`;}).join('');
}

// ═══════════════════════════════════════════════════════════════
//  UTILS
// ═══════════════════════════════════════════════════════════════
function fmtBytes(n) {
  if(n<1024) return n+'B'; if(n<1048576) return (n/1024).toFixed(1)+'KB';
  return (n/1048576).toFixed(1)+'MB';
}

// ═══════════════════════════════════════════════════════════════
//  MODEL STATUS POLLING
//  Polls /api/status every 5s until model is ready.
//  Shows a banner while loading; enables Analyze button when ready.
// ═══════════════════════════════════════════════════════════════
let _modelReady = false;
let _modelPollTimer = null;

function startModelPoll() {
  if (_modelReady) return;
  _setModelBanner('loading');
  _pollModel();
}

async function _pollModel() {
  try {
    const res = await apiFetch('/api/status');
    if (res.ready) {
      _modelReady = true;
      clearTimeout(_modelPollTimer);
      _setModelBanner('ready');
      _enableAnalyzeBtn(true);
      return;
    }
    if (res.error) {
      _setModelBanner('error', res.error);
      return;  // stop polling on hard error
    }
  } catch(_) {}
  // retry in 5s
  _modelPollTimer = setTimeout(_pollModel, 5000);
}

function _setModelBanner(state, msg) {
  const el = document.getElementById('modelBanner');
  if (!el) return;
  if (state === 'ready') {
    el.className = 'model-banner ready';
    el.textContent = '✓ Model ready — you can now analyze audio';
    setTimeout(() => { el.style.display = 'none'; }, 4000);
  } else if (state === 'error') {
    el.className = 'model-banner error';
    el.textContent = 'Model error: ' + (msg || 'unknown');
    el.style.display = 'block';
  } else {
    el.className = 'model-banner loading';
    el.textContent = '⏳ Model is loading (1–2 min first time)…';
    el.style.display = 'block';
  }
}

function _enableAnalyzeBtn(on) {
  const btns = document.querySelectorAll('.btn-primary, .btn-analyze-r');
  btns.forEach(b => { b.disabled = !on; });
}


// ═══════════════════════════════════════════════════════════════
//  IDEA 2: LLM CONTEXT VERDICT
//  Displays Claude's false-alarm analysis on the dashboard
//  Arrives via WebSocket event 'context_verdict'
// ═══════════════════════════════════════════════════════════════

function renderContextVerdict(verdict) {
  const el = document.getElementById('contextVerdictCard');
  if (!el) return;

  const action  = verdict.action  || 'MONITOR';
  const genuine = verdict.genuine;
  const conf    = verdict.confidence || 0;
  const label   = verdict.pattern_label || 'unknown';
  const reason  = verdict.reasoning || '';
  const err     = verdict.error;

  const actionColor = action === 'ALERT' ? 'var(--red2)' :
                      action === 'DISMISS' ? '#00e676' : '#ffc107';

  el.style.display = 'block';
  el.innerHTML = `
    <div class="card-hd"><span class="card-title">AI CONTEXT VERDICT</span>
      <span style="font-size:9px;padding:2px 8px;border-radius:10px;background:${actionColor}22;color:${actionColor};margin-left:8px;font-weight:600">${action}</span>
    </div>
    <div class="card-sub">Claude analysed the last 10 detections to assess false-alarm probability</div>
    <div style="padding:10px 16px 14px">
      ${err ? `<div style="font-size:11px;color:var(--t3)">${err}</div>` : `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
        <div style="font-size:28px;font-weight:700;font-family:'Orbitron',sans-serif;color:${actionColor}">${Math.round(conf*100)}%</div>
        <div>
          <div style="font-size:10px;color:var(--t3)">CONFIDENCE</div>
          <div style="font-size:11px;color:var(--t2);margin-top:2px">${genuine === true ? 'Genuine threat' : genuine === false ? 'Likely false positive' : 'Uncertain'}</div>
        </div>
      </div>
      <div style="font-size:9px;letter-spacing:2px;color:var(--t3);margin-bottom:4px">PATTERN</div>
      <div style="font-size:11px;color:var(--teal);margin-bottom:8px">${label.replace(/_/g,' ')}</div>
      <div style="font-size:9px;letter-spacing:2px;color:var(--t3);margin-bottom:4px">REASONING</div>
      <div style="font-size:11px;color:var(--t2);line-height:1.5">${reason}</div>
      `}
    </div>`;
}

// ═══════════════════════════════════════════════════════════════
//  IDEA 3: LOCALISE PAGE
//  Device registration, floor-plan map, TDOA source display
// ═══════════════════════════════════════════════════════════════

// Persistent device ID for this browser
function getDeviceId() {
  let id = localStorage.getItem('pft_device_id');
  if (!id) {
    id = 'dev_' + Math.random().toString(36).slice(2,10);
    localStorage.setItem('pft_device_id', id);
  }
  return id;
}

let _regPos    = null;   // {x,y} 0-100 grid
let _regCanvas = null;
let _locCanvas = null;
let _knownDevices = [];
let _lastLoc      = null;

function initLocalise() {
  _regCanvas = document.getElementById('regMapC');
  _locCanvas = document.getElementById('locMapC');

  // Pre-fill device name from localStorage
  const nameEl = document.getElementById('devName');
  if (nameEl) nameEl.value = localStorage.getItem('pft_device_name') || '';

  if (_regCanvas) {
    _regCanvas.addEventListener('click', onRegMapClick);
    drawRegMap();
  }

  loadDevices();
  loadLocHistory();

  if (_locCanvas) drawLocMap(null, []);
}

// ── Floor plan interaction ────────────────────────────────────

function onRegMapClick(e) {
  const rect = _regCanvas.getBoundingClientRect();
  const px   = ((e.clientX - rect.left) / rect.width)  * 100;
  const py   = ((e.clientY - rect.top)  / rect.height) * 100;
  _regPos = { x: Math.round(px), y: Math.round(py) };
  const lbl = document.getElementById('regPosLabel');
  if (lbl) lbl.textContent = `Position: (${_regPos.x}, ${_regPos.y})`;
  const hint = document.getElementById('regMapHint');
  if (hint) hint.style.display = 'none';
  drawRegMap();
}

function drawRegMap() {
  if (!_regCanvas) return;
  const W = _regCanvas.offsetWidth  || 300;
  const H = _regCanvas.offsetHeight || 160;
  _regCanvas.width  = W * devicePixelRatio;
  _regCanvas.height = H * devicePixelRatio;
  const ctx = _regCanvas.getContext('2d');
  ctx.scale(devicePixelRatio, devicePixelRatio);

  // Background grid
  ctx.fillStyle = 'rgba(0,0,0,0.01)';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += W/10) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
  for (let y = 0; y <= H; y += H/10) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }

  // Draw existing devices
  _knownDevices.forEach(dev => {
    const dx = (dev.x/100)*W;
    const dy = (dev.y/100)*H;
    ctx.beginPath();
    ctx.arc(dx, dy, 6, 0, Math.PI*2);
    ctx.fillStyle = 'rgba(0,229,255,0.3)';
    ctx.fill();
    ctx.strokeStyle = '#00e5ff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#8ba7c7';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(dev.device_name.slice(0,12), dx, dy-10);
  });

  // Draw selected position
  if (_regPos) {
    const px = (_regPos.x/100)*W;
    const py = (_regPos.y/100)*H;
    ctx.beginPath();
    ctx.arc(px, py, 8, 0, Math.PI*2);
    ctx.fillStyle = 'rgba(255,193,7,0.25)';
    ctx.fill();
    ctx.strokeStyle = '#ffc107';
    ctx.lineWidth = 2;
    ctx.stroke();
    // Cross
    ctx.strokeStyle = '#ffc107';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(px-12,py); ctx.lineTo(px+12,py); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(px,py-12); ctx.lineTo(px,py+12); ctx.stroke();
  }
}

function drawLocMap(loc, devices) {
  if (!_locCanvas) return;
  const W = _locCanvas.offsetWidth  || 400;
  const H = Math.round(W * 0.6);
  _locCanvas.width  = W * devicePixelRatio;
  _locCanvas.height = H * devicePixelRatio;
  _locCanvas.style.height = H + 'px';
  const ctx = _locCanvas.getContext('2d');
  ctx.scale(devicePixelRatio, devicePixelRatio);

  // Background
  ctx.fillStyle = 'rgba(6,12,23,0.8)';
  ctx.fillRect(0, 0, W, H);

  // Grid
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += W/10) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
  for (let y = 0; y <= H; y += H/10) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }

  // Room border
  ctx.strokeStyle = 'rgba(0,229,255,0.15)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(10, 10, W-20, H-20);

  // Draw devices
  const allDevs = devices.length ? devices : _knownDevices;
  allDevs.forEach(dev => {
    const dx = 10 + (dev.x/100)*(W-20);
    const dy = 10 + (dev.y/100)*(H-20);

    // TDOA hyperbola suggestion line (if source known)
    if (loc) {
      const sx = 10 + (loc.source_x/100)*(W-20);
      const sy = 10 + (loc.source_y/100)*(H-20);
      ctx.beginPath();
      ctx.moveTo(dx, dy);
      ctx.lineTo(sx, sy);
      ctx.strokeStyle = 'rgba(0,229,255,0.08)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4,4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.beginPath();
    ctx.arc(dx, dy, 7, 0, Math.PI*2);
    ctx.fillStyle = 'rgba(0,229,255,0.2)';
    ctx.fill();
    ctx.strokeStyle = '#00e5ff';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Pulse ring if used in last localisation
    const wasUsed = loc && loc.devices && loc.devices.some(d => d.id === dev.device_id);
    if (wasUsed) {
      ctx.beginPath();
      ctx.arc(dx, dy, 12, 0, Math.PI*2);
      ctx.strokeStyle = 'rgba(0,229,255,0.4)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    ctx.fillStyle = '#8ba7c7';
    ctx.font = `${Math.max(9, W/45)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText((dev.device_name || dev.name || '?').slice(0,14), dx, dy - 12);
  });

  // Draw source position
  if (loc) {
    const sx = 10 + (loc.source_x/100)*(W-20);
    const sy = 10 + (loc.source_y/100)*(H-20);

    // Confidence radius circle
    const confR = Math.max(15, (1-loc.confidence)*W*0.25);
    ctx.beginPath();
    ctx.arc(sx, sy, confR, 0, Math.PI*2);
    ctx.fillStyle = 'rgba(255,23,68,0.06)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,23,68,0.3)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3,3]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Source marker
    ctx.beginPath();
    ctx.arc(sx, sy, 10, 0, Math.PI*2);
    ctx.fillStyle = 'rgba(255,23,68,0.3)';
    ctx.fill();
    ctx.strokeStyle = '#ff1744';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Cross
    ctx.strokeStyle = '#ff1744';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(sx-14,sy); ctx.lineTo(sx+14,sy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sx,sy-14); ctx.lineTo(sx,sy+14); ctx.stroke();

    // Label
    ctx.fillStyle = '#ff5252';
    ctx.font = `bold ${Math.max(10,W/38)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('THREAT SOURCE', sx, sy - 18);
    ctx.fillStyle = 'rgba(255,82,82,0.7)';
    ctx.font = `${Math.max(9,W/45)}px sans-serif`;
    ctx.fillText(`(${loc.source_x}, ${loc.source_y})`, sx, sy + 22);
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for multi-device threat detections...', W/2, H/2);
  }
}

// ── Device registration ───────────────────────────────────────

async function registerDevice() {
  const nameEl = document.getElementById('devName');
  const roomEl = document.getElementById('devRoom');
  const stEl   = document.getElementById('regStatus');
  const name   = nameEl?.value.trim();

  if (!name) { if (stEl) stEl.textContent = 'Please enter a device name.'; return; }
  if (!_regPos) { if (stEl) stEl.textContent = 'Please tap the floor plan to set position.'; return; }

  const deviceId = getDeviceId();
  localStorage.setItem('pft_device_name', name);

  try {
    const res = await apiPost('/api/devices/register', {
      device_id:   deviceId,
      device_name: name,
      x: _regPos.x,
      y: _regPos.y,
      room: roomEl?.value.trim() || 'default',
    });
    if (res.ok) {
      if (stEl) stEl.textContent = `Registered as "${name}" at (${_regPos.x}, ${_regPos.y})`;
      await loadDevices();
    }
  } catch(e) {
    if (stEl) stEl.textContent = 'Error: ' + e.message;
  }
}

async function loadDevices() {
  try {
    _knownDevices = await apiFetch('/api/devices');
    renderDeviceList();
    drawRegMap();
    drawLocMap(_lastLoc, _knownDevices);
  } catch(_) {}
}

function renderDeviceList() {
  const el = document.getElementById('devicesList');
  if (!el) return;
  const myId = getDeviceId();
  if (!_knownDevices.length) {
    el.innerHTML = '<div style="color:var(--t3)">No devices registered yet</div>';
    return;
  }
  el.innerHTML = _knownDevices.map(d => `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--b)">
      <span style="width:8px;height:8px;border-radius:50%;background:${d.device_id===myId?'#00e676':'#00e5ff'};flex-shrink:0"></span>
      <div style="flex:1;min-width:0">
        <div style="font-size:11px;color:var(--t1);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${d.device_name}${d.device_id===myId?' (you)':''}</div>
        <div style="font-size:9px;color:var(--t3)">(${Math.round(d.x)}, ${Math.round(d.y)}) · ${d.room||'default'}</div>
      </div>
    </div>`).join('');
  set('devCountLabel', _knownDevices.length);
}

// ── Localisation result display ───────────────────────────────

function renderLocResult(loc) {
  _lastLoc = loc;
  drawLocMap(loc, _knownDevices);

  set('locCoords', `(${loc.source_x}, ${loc.source_y})`);
  const pct = Math.round(loc.confidence * 100);
  const bar = document.getElementById('locConfBar');
  if (bar) bar.style.width = pct + '%';
  set('locConfPct', pct + '% confidence');
  set('locClass', loc.top_class || '—');
  set('errorMLabel', loc.error_m != null ? loc.error_m : '—');

  const badge = document.getElementById('locConfBadge');
  if (badge) {
    badge.textContent = pct >= 70 ? 'HIGH CONFIDENCE' : pct >= 40 ? 'MODERATE' : 'LOW CONFIDENCE';
    badge.style.color = pct >= 70 ? '#ff1744' : pct >= 40 ? '#ffc107' : '#8ba7c7';
    badge.style.background = pct >= 70 ? 'rgba(255,23,68,0.1)' : 'rgba(255,193,7,0.1)';
  }

  const devEl = document.getElementById('locDevices');
  if (devEl && loc.devices) {
    devEl.innerHTML = loc.devices.map(d =>
      `<div style="display:flex;gap:6px;align-items:center">
        <span style="width:6px;height:6px;border-radius:50%;background:#00e5ff;flex-shrink:0"></span>
        <span>${d.name} · ${Math.round(d.score*100)}%</span>
      </div>`
    ).join('');
  }
}

async function loadLocHistory() {
  try {
    const rows = await apiFetch('/api/localise/history');
    const el   = document.getElementById('locHistory');
    if (!el) return;
    if (!rows.length) return;
    el.innerHTML = rows.map(r => `
      <div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--b);align-items:center">
        <div style="width:36px;height:36px;border-radius:6px;background:rgba(255,23,68,0.1);border:1px solid rgba(255,23,68,0.3);display:flex;align-items:center;justify-content:center;font-size:9px;color:#ff5252;text-align:center;flex-shrink:0">
          ${Math.round(r.source_x)}<br>${Math.round(r.source_y)}
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:11px;color:var(--t1)">${r.top_class||'unknown'} · ${Math.round(r.confidence*100)}% conf</div>
          <div style="font-size:9px;color:var(--t3)">${r.device_count} device(s) · ±${r.error_m||'?'}m · ${r.created_at||''}</div>
        </div>
      </div>`).join('');

    // Show latest on map
    if (rows[0]) renderLocResult({...rows[0], devices: JSON.parse(rows[0].devices_json||'[]')});
  } catch(_) {}
}

// ── Socket.IO handlers for new events ────────────────────────

function _initNewSocketHandlers() {
  if (!_socket) return;

  // Idea 2: context verdict arrives async
  _socket.on('context_verdict', data => {
    if (data.verdict) renderContextVerdict(data.verdict);
  });

  // Idea 3: new localisation result
  _socket.on('localisation_result', data => {
    renderLocResult(data);
    if (window.PAGE === 'localise') loadLocHistory();
  });

  // Idea 3: devices list updated
  _socket.on('devices_update', data => {
    if (data.devices) {
      _knownDevices = data.devices;
      renderDeviceList();
      drawRegMap();
      if (_lastLoc) drawLocMap(_lastLoc, _knownDevices);
    }
  });
}

// ── Submit localisation event after threat detection ─────────

async function submitLocEvent(analysisId, score, topClass) {
  const deviceId = getDeviceId();
  // Only if this device is registered
  const known = _knownDevices.find(d => d.device_id === deviceId);
  if (!known) return;

  try {
    await apiPost('/api/localise/event', {
      device_id:    deviceId,
      analysis_id:  analysisId,
      score:        score,
      top_class:    topClass,
      timestamp_ms: Date.now(),
    });
  } catch(_) {}
}


// ═══════════════════════════════════════════════════════════════
//  DEVICE ID & GEOLOCATION
// ═══════════════════════════════════════════════════════════════
function initDeviceInfo() {
  _deviceId = localStorage.getItem('pft_device_id');
  if (!_deviceId) {
    _deviceId = 'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,8);
    localStorage.setItem('pft_device_id', _deviceId);
  }
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => { _userLocation = { lat: pos.coords.latitude.toFixed(5), lng: pos.coords.longitude.toFixed(5) }; },
      () => {},
      { timeout: 8000, maximumAge: 300000 }
    );
  }
}
function getLocationString() {
  return _userLocation ? `${_userLocation.lat},${_userLocation.lng}` : '';
}

// ═══════════════════════════════════════════════════════════════
//  BROWSER NOTIFICATION
// ═══════════════════════════════════════════════════════════════
async function requestNotifPermission() {
  if ('Notification' in window && Notification.permission === 'default')
    setTimeout(() => Notification.requestPermission(), 3000);
}
function showBrowserNotif(data) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const top = data.multi_threat?.[0]?.label || data.top_class || 'Unknown';
  const pct = (data.threat_score * 100).toFixed(1);
  const n = new Notification(`THREAT: ${top.toUpperCase()}`, {
    body: `Score: ${pct}%  |  Source: ${data.source||'unknown'}`,
    icon: '/icons/icon-192.png', badge: '/icons/badge-72.png',
    tag: 'pft-threat', renotify: true, requireInteraction: true,
    vibrate: [500,100,500,100,500],
  });
  n.onclick = () => { window.focus(); n.close(); };
  setTimeout(() => n.close(), 15000);
}

// ═══════════════════════════════════════════════════════════════
//  HISTORY MODAL
// ═══════════════════════════════════════════════════════════════
async function openHistoryModal(id) {
  const modal = document.getElementById('histModal');
  const body  = document.getElementById('histModalBody');
  if (!modal || !body) return;
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
  body.innerHTML = `<div style="padding:48px;text-align:center;color:#64748B">Loading analysis #${id}...</div>`;
  try {
    const data = await apiFetch('/api/history/' + id);
    if (data.error) { body.innerHTML = `<div style="padding:32px;color:#DC2626">Error: ${data.error}</div>`; return; }
    const risk = data.risk || 'SAFE';
    const pct  = ((data.threat_score||data.score||0)*100).toFixed(1);
    const isT  = data.threat_detected || data.threat;
    // Context verdict
    let cvHtml = '';
    const cv = data.context_verdict ? (typeof data.context_verdict==='string' ? JSON.parse(data.context_verdict) : data.context_verdict) : null;
    if (cv) {
      const ac = cv.action === 'ALERT' ? '#DC2626' : cv.action === 'DISMISS' ? '#059669' : '#D97706';
      cvHtml = `<div style="margin-top:12px;padding:12px;border-radius:8px;border:1px solid ${ac}20;background:${ac}08">
        <div style="display:flex;gap:10px;align-items:center;margin-bottom:6px">
          <span style="font-size:10px;font-weight:800;padding:3px 10px;border-radius:12px;background:${ac};color:#fff">${cv.action}</span>
          <span style="font-size:10px;color:#64748B">${cv.pattern_label||''}</span>
          <span style="font-size:10px;color:#64748B;margin-left:auto">LLM confidence: ${((cv.confidence||0)*100).toFixed(0)}%</span>
        </div>
        <div style="font-size:11px;color:#334155">${cv.reasoning||''}</div>
      </div>`;
    }
    body.innerHTML = `
      <div style="padding:16px;background:${isT?'#FEF2F2':'#F0FDF4'};border-radius:8px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center">
        <div>
          <span style="font-size:10px;font-weight:800;padding:4px 12px;border-radius:20px;background:${isT?'#DC2626':risk==='MEDIUM'?'#D97706':'#059669'};color:#fff">${isT?'⚠ ':' '}${risk}</span>
          <div style="font-size:16px;font-weight:800;margin-top:6px">Analysis #${id}</div>
          <div style="font-size:11px;color:#64748B;margin-top:2px">${data.date||''} ${data.time||''} · ${data.source||'upload'} · ${data.duration||'—'}s</div>
        </div>
        <div style="font-size:40px;font-weight:900;color:${isT?'#DC2626':risk==='MEDIUM'?'#D97706':'#059669'}">${pct}%</div>
      </div>
      ${cvHtml}
      ${data.spectrogram ? `<div style="margin-top:12px"><div style="font-size:9px;letter-spacing:2px;color:#94A3B8;margin-bottom:6px">LOG-MEL SPECTROGRAM</div><img src="data:image/png;base64,${data.spectrogram}" style="width:100%;border-radius:6px"></div>` : '<div style="padding:20px;text-align:center;color:#94A3B8;font-size:11px">Spectrogram not available for older records</div>'}
    `;
  } catch(e) {
    body.innerHTML = `<div style="padding:32px;color:#DC2626">Failed: ${e.message}</div>`;
  }
}
function closeHistoryModal() {
  document.getElementById('histModal')?.classList.remove('open');
  document.body.style.overflow = '';
}

// ═══════════════════════════════════════════════════════════════
//  NTFY.SH FUNCTIONS
// ═══════════════════════════════════════════════════════════════
async function initNtfy() {
  try {
    const cfg = await apiFetch('/api/ntfy-config');
    if (cfg.topic) setNtfyConfigured(cfg.topic);
  } catch(_) {}
}
function setNtfyConfigured(topic) {
  const badge = document.getElementById('ntfyBadge');
  const cur   = document.getElementById('ntfyCurrent');
  const curT  = document.getElementById('ntfyCurrentTopic');
  const input = document.getElementById('ntfyTopicInput');
  const done  = document.getElementById('ntfyDoneStep');
  const at    = document.getElementById('ntfyActiveTopic');
  if (badge) { badge.textContent='ACTIVE'; badge.style.background='#D1FAE5'; badge.style.color='#059669'; }
  if (cur)   cur.style.display  = 'block';
  if (curT)  curT.textContent   = topic;
  if (input) input.style.display= 'none';
  if (done)  done.style.display = 'flex';
  if (at)    at.textContent     = topic;
  ['ntfyStep2Num','ntfyStep3Num'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.textContent='✓'; el.classList.add('done'); }
  });
}
function changeNtfyTopic() {
  const input = document.getElementById('ntfyTopicInput');
  const cur   = document.getElementById('ntfyCurrent');
  if (input) input.style.display = '';
  if (cur)   cur.style.display   = 'none';
}
async function saveNtfyTopic() {
  const input  = document.getElementById('ntfyTopicInput');
  const result = document.getElementById('ntfySaveResult');
  const btn    = document.querySelector('.ntfy-save-btn');
  const topic  = (input?.value || '').trim();
  if (!topic || topic.length < 3) { showNtfyResult(result, 'Enter a topic (min 3 chars)', false); return; }
  if (btn) { btn.textContent='Saving...'; btn.disabled=true; }
  try {
    const data = await apiPost('/api/ntfy-config', {topic});
    if (data.ok) { showNtfyResult(result, `Saved! Open ntfy app and subscribe to "${topic}"`, true); setNtfyConfigured(topic); }
    else         { showNtfyResult(result, data.error || 'Failed', false); }
  } catch(e) { showNtfyResult(result, e.message, false); }
  finally { if (btn) { btn.textContent='Save'; btn.disabled=false; } }
}
async function testNtfy() {
  const btn    = document.getElementById('ntfyTestBtn');
  const result = document.getElementById('ntfyTestResult');
  if (btn) { btn.textContent='Sending...'; btn.disabled=true; }
  try {
    const data = await fetch(API+'/api/ntfy-test', {method:'POST'}).then(r=>r.json());
    if (data.ok) {
      showNtfyResult(result, data.message, true);
      const done = document.getElementById('ntfyDoneStep');
      if (done) done.style.display='flex';
    } else showNtfyResult(result, data.error||'Failed', false);
  } catch(e) { showNtfyResult(result, e.message, false); }
  finally { if (btn) { btn.textContent='Send Test to My Phone Now'; btn.disabled=false; } }
}
function showNtfyResult(el, msg, ok) {
  if (!el) return;
  el.textContent = msg; el.style.display = 'block';
  el.style.color = ok?'#059669':'#DC2626';
  el.style.background = ok?'#F0FDF4':'#FEF2F2';
  el.style.border = `1px solid ${ok?'#A7F3D0':'#FECACA'}`;
  el.style.borderRadius = '6px'; el.style.padding = '8px 10px'; el.style.fontSize = '11px'; el.style.marginTop='6px';
}

// ═══════════════════════════════════════════════════════════════
//  CONTINUOUS LIVE RECORDING
// ═══════════════════════════════════════════════════════════════
function switchRecMode(mode) {
  document.getElementById('recModeSnap').style.display = mode==='snap' ? '' : 'none';
  document.getElementById('recModeLive').style.display = mode==='live' ? '' : 'none';
  document.getElementById('modeSnap').classList.toggle('on', mode==='snap');
  document.getElementById('modeLive').classList.toggle('on', mode==='live');
  if (mode==='snap' && _liveActive) stopLiveRec();
}
async function startLiveRec() {
  try {
    _liveStream = await navigator.mediaDevices.getUserMedia({audio:{sampleRate:16000,channelCount:1,echoCancellation:true}});
  } catch(e) { alert('Mic access denied: '+e.message); return; }
  _liveActive=true; _liveChunkN=0;
  const btn = document.getElementById('btnLiveRec');
  if (btn) { btn.textContent='Stop Live Analysis'; btn.classList.add('on'); }
  document.getElementById('liveStatusBadge').style.display='flex';
  const feed=document.getElementById('liveChunkFeed'); if(feed) feed.innerHTML='';
  startNextChunk();
}
function startNextChunk() {
  if (!_liveActive) return;
  _liveChunkN++;
  const chunkN=_liveChunkN, chunks=[], mime=getMime();
  set('liveChunkLabel', `Chunk #${chunkN} analyzing...`);
  const rec = new MediaRecorder(_liveStream, {mimeType:mime});
  rec.ondataavailable = e => { if(e.data.size>0) chunks.push(e.data); };
  rec.onstop = async () => {
    if (!_liveActive && chunkN>1) return;
    const blob=new Blob(chunks,{type:mime||'audio/webm'});
    if (blob.size<1000) { if(_liveActive) startNextChunk(); return; }
    addLiveChunkPending(chunkN);
    try {
      const ext=mime.includes('ogg')?'ogg':'webm';
      const fd=new FormData();
      fd.append('audio', new File([blob],`chunk_${chunkN}.${ext}`,{type:mime}));
      fd.append('source','live');
      fd.append('device_id', _deviceId||'');
      fd.append('location', getLocationString());
      const r = await fetch(API+'/api/predict',{method:'POST',body:fd});
      const data = await r.json();
      if (data.error) { updateLiveChunk(chunkN,null,data.error); }
      else {
        data.chunk_n=chunkN; updateLiveChunk(chunkN,data);
        if (data.threat_detected) { showBanner(data); showBrowserNotif(data); bumpAlerts(); }
      }
    } catch(e) { updateLiveChunk(chunkN,null,e.message); }
    if (_liveActive) startNextChunk();
  };
  rec.start();
  setTimeout(() => { if(rec.state==='recording') rec.stop(); }, 10000);
}
function stopLiveRec() {
  _liveActive=false;
  if(_liveStream) { _liveStream.getTracks().forEach(t=>t.stop()); _liveStream=null; }
  stopRecViz();
  const btn=document.getElementById('btnLiveRec');
  if(btn) { btn.textContent='Start Live Analysis'; btn.classList.remove('on'); }
  document.getElementById('liveStatusBadge').style.display='none';
  set('liveChunkLabel',`Done — ${_liveChunkN} chunk(s)`);
}
function addLiveChunkPending(n) {
  const feed=document.getElementById('liveChunkFeed'); if(!feed) return;
  const el=document.createElement('div');
  el.className='live-chunk-row pending'; el.id=`lc-${n}`;
  el.innerHTML=`<div class="lc-n">#${n}</div><div class="lc-info"><div class="lc-label">Analyzing...</div><div class="lc-bar-bg"><div class="lc-bar" style="width:0%"></div></div></div><div class="lc-score">—</div>`;
  feed.insertBefore(el,feed.firstChild);
  while(feed.children.length>15) feed.removeChild(feed.lastChild);
}
function updateLiveChunk(n,data,err) {
  const el=document.getElementById(`lc-${n}`); if(!el) return;
  if(err||!data) { el.className='live-chunk-row error'; el.querySelector('.lc-label').textContent=err||'Error'; return; }
  const pct=(data.threat_score*100).toFixed(1);
  const risk=data.risk||'SAFE';
  const cls=data.threat_detected?'threat':(data.threat_score>=0.20?'medium':'safe');
  el.className=`live-chunk-row ${cls}`;
  el.querySelector('.lc-label').textContent=data.all_sounds?.[0]?.label||'—';
  el.querySelector('.lc-bar').style.width=Math.min(data.threat_score*100,100)+'%';
  el.querySelector('.lc-bar').className=`lc-bar ${cls}`;
  el.querySelector('.lc-score').innerHTML=`<span class="rtag r-${risk.toLowerCase()}">${pct}%</span>`;
}
