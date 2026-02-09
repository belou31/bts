// ----- Déduction du préfixe côté client (robuste si BASE_PATH mal réglé)
const prefix = (window.__BTS__?.basePath ?? '').toString();
const BASE = prefix;                          // "" (DEV) ou "/bts" (INT/PROD)
const SCOPE = (window.__BTS__?.scope ?? (prefix + '/control/scan/')).replace('//','/');

// ----- PWA install -----
let deferredPrompt=null;
const installBtn = document.getElementById('installBtn');
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt=e; installBtn.style.display='inline-block'; });
installBtn?.addEventListener('click', async ()=>{ if(!deferredPrompt) return; deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt=null; installBtn.style.display='none'; });

// ----- Network badge -----
const netBadge = document.getElementById('net');
function updateNet() { netBadge.textContent = navigator.onLine ? 'online' : 'offline'; netBadge.style.color = navigator.onLine ? '#22c55e' : '#ef4444'; }
window.addEventListener('online', updateNet); window.addEventListener('offline', updateNet); updateNet();

// ----- Service worker registration -----
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(SCOPE + 'sw.js', { scope: SCOPE }).catch(()=>{});
}

// ----- IndexedDB (offline queue) -----
const DB_NAME='bts-scan-db', STORE='pending_scans';
function idb() {
  return new Promise((res,rej)=>{
    const req = indexedDB.open(DB_NAME,1);
    req.onupgradeneeded = ()=>{ req.result.createObjectStore(STORE,{ keyPath:'id', autoIncrement:true }); };
    req.onsuccess = ()=>res(req.result); req.onerror = ()=>rej(req.error);
  });
}
async function idbAdd(obj){ const db=await idb(); await new Promise((ok,ko)=>{ const tx=db.transaction(STORE,'readwrite'); tx.objectStore(STORE).add(obj); tx.oncomplete=ok; tx.onerror=ko; }); db.close(); }
async function idbGetAll(){ const db=await idb(); const out=await new Promise((ok,ko)=>{ const tx=db.transaction(STORE,'readonly'); const req=tx.objectStore(STORE).getAll(); req.onsuccess=()=>ok(req.result||[]); req.onerror=ko; }); db.close(); return out; }
async function idbClear(){ const db=await idb(); await new Promise((ok,ko)=>{ const tx=db.transaction(STORE,'readwrite'); tx.objectStore(STORE).clear(); tx.oncomplete=ok; tx.onerror=ko; }); db.close(); }

// ----- UI refs -----
const previewWrapper = document.getElementById('previewWrapper');
const video = document.getElementById('preview');
const statusEl = document.getElementById('status');
const scannedCountEl = document.getElementById('scannedCount');
const previewBadge = document.getElementById('previewBadge');
const overlay = document.getElementById('overlay');
const overlayCtx = overlay ? overlay.getContext('2d') : null;
let stream, stopFn = null;
let detectionLocked = false;
const RECENT_SCAN_WINDOW_MS = 8000;
const RECENT_SCAN_TTL_MS = 15000;
const recentScanTimestamps = new Map();
let previewFlashTimer = null;
let previewBadgeTimer = null;

function hidePreviewGain() {
  if (previewBadgeTimer) {
    clearTimeout(previewBadgeTimer);
    previewBadgeTimer = null;
  }
  if (previewBadge) {
    previewBadge.classList.remove('show');
    previewBadge.textContent = '';
  }
}

function showPreviewGain(count) {
  if (!previewBadge) return;
  if (!(count > 0)) {
    hidePreviewGain();
    return;
  }
  previewBadge.textContent = `+${count}`;
  previewBadge.classList.add('show');
  if (previewBadgeTimer) clearTimeout(previewBadgeTimer);
  previewBadgeTimer = setTimeout(() => {
    hidePreviewGain();
  }, 650);
}

function triggerPreviewFlash() {
  if (!previewWrapper) return;
  previewWrapper.classList.remove('flash-success');
  if (previewFlashTimer) {
    clearTimeout(previewFlashTimer);
    previewFlashTimer = null;
  }
  // Force reflow to restart animation
  void previewWrapper.offsetWidth;
  previewWrapper.classList.add('flash-success');
  previewFlashTimer = setTimeout(() => {
    previewWrapper.classList.remove('flash-success');
    previewFlashTimer = null;
  }, 700);
}

function encodeBasicCredentials(login, password) {
  const pair = `${login}:${password}`;
  try {
    return btoa(pair);
  } catch {
    try {
      if (typeof TextEncoder !== 'undefined') {
        const bytes = new TextEncoder().encode(pair);
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary);
      }
    } catch {}
    // Fallback for browsers without TextEncoder
    return btoa(unescape(encodeURIComponent(pair)));
  }
}

function updateStatus(state, text) {
  if (!statusEl) return;
  statusEl.textContent = text || '';
  statusEl.classList.remove('ok', 'ko');
  if (state === 'ok') {
    statusEl.classList.add('ok');
    triggerPreviewFlash();
  } else if (state === 'ko') {
    statusEl.classList.add('ko');
    hidePreviewGain();
  } else {
    hidePreviewGain();
  }
}

const eventInput = document.getElementById('eventId');
const eventSelect = document.getElementById('eventSelect');
const tokenInput = document.getElementById('token');
const loginInput = document.getElementById('login');
const passwordInput = document.getElementById('password');
const gateInput = document.getElementById('gate');
const authFields = document.querySelector('.auth-fields');
const authToggle = document.getElementById('authToggle');
const scanToggle = document.getElementById('scanToggle');
const modeToggle = document.getElementById('modeToggle');
const authToggleLabel = authToggle?.querySelector('.toggle-label');
const scanToggleLabel = scanToggle?.querySelector('.toggle-label');
const modeToggleLabel = modeToggle?.querySelector('.toggle-label');
const modeOptionTicket = modeToggle?.querySelector('.toggle-option.ticket');
const modeOptionOrder = modeToggle?.querySelector('.toggle-option.order');
const modeInline = document.querySelector('.mode-inline');
const scanInline = document.querySelector('.scan-inline');
const knownEvents = new Map();

const bodyEl = document.body || document.querySelector('body');
const portraitQuery = typeof window.matchMedia === 'function' ? window.matchMedia('(orientation: portrait)') : null;
const narrowQuery = typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 768px)') : null;
const previewControlsCol = document.createElement('div');
previewControlsCol.className = 'preview-controls-col';
if (previewWrapper) {
  previewWrapper.append(previewControlsCol);
}
const modeInlineHomeParent = modeInline?.parentElement || null;
const scanInlineHomeParent = scanInline?.parentElement || null;
const modeInlineHomeMarker = (modeInline && modeInlineHomeParent)
  ? document.createComment('mode-inline-home')
  : null;
const scanInlineHomeMarker = (scanInline && scanInlineHomeParent)
  ? document.createComment('scan-inline-home')
  : null;
if (modeInline && modeInlineHomeParent && modeInlineHomeMarker) {
  modeInlineHomeParent.insertBefore(modeInlineHomeMarker, modeInline.nextSibling);
}
if (scanInline && scanInlineHomeParent && scanInlineHomeMarker) {
  scanInlineHomeParent.insertBefore(scanInlineHomeMarker, scanInline.nextSibling);
}
const scanCountContainer = scannedCountEl ? scannedCountEl.parentElement : null;
const scanCountHomeParent = scanCountContainer?.parentElement || null;
const scanCountHomeMarker = (scanCountContainer && scanCountHomeParent)
  ? document.createComment('scan-count-home')
  : null;
if (scanCountContainer && scanCountHomeMarker && scanCountHomeParent) {
  scanCountHomeParent.insertBefore(scanCountHomeMarker, scanCountContainer.nextSibling);
}

const HISTORY_ACTION_MAP = {
  accept: { action: 'accept', status: 'accepted' },
  force: { action: 'accept', status: 'forced_accept' },
  auto: { action: 'accept', status: 'auto_accept' },
  exit: { action: 'exit', status: 'sortie' }
};
let scanActive = false;
let loadMode = 'order';
if (previewWrapper) previewWrapper.classList.add('hidden');

function detectSlugFromPath() {
  try {
    const scopeUrl = new URL(SCOPE, window.location.origin);
    const scopePath = scopeUrl.pathname.endsWith('/') ? scopeUrl.pathname : scopeUrl.pathname + '/';
    const pathname = window.location.pathname;
    if (!pathname.startsWith(scopePath)) return '';
    const remainder = pathname.slice(scopePath.length).replace(/^\//, '');
    const [first] = remainder.split('/');
    return first || '';
  } catch {
    return '';
  }
}

const initialContext = (() => {
  const params = new URLSearchParams(window.location.search);
  const slugParam = params.get('event') || params.get('eventSlug') || params.get('slug') || '';
  const slugFromPath = detectSlugFromPath();
  const slug = String(slugParam || slugFromPath || '').trim();
  const token = params.get('token') || params.get('bearer') || '';
  const login = params.get('login') || params.get('user') || '';
  const password = params.get('password') || params.get('pass') || '';
  const gate = params.get('gate') || params.get('portail') || '';
  return { slug, token, login, password, gate };
})();

function formatEventOptionLabel(event) {
  const name = event?.name || event?.slug || 'Événement';
  if (!event?.startsAt) return name;
  const date = new Date(event.startsAt);
  if (!Number.isFinite(date.getTime())) return name;
  const formatter = new Intl.DateTimeFormat('fr-FR', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });
  return `${formatter.format(date)} — ${name}`;
}

function updateEventInput(slug, eventData = null) {
  if (!eventInput) return;
  const value = String(slug || '').trim();
  eventInput.value = value;
  if (value) {
    eventInput.dataset.prefilled = 'true';
    if (eventData?.id) eventInput.dataset.resolvedId = eventData.id;
    else delete eventInput.dataset.resolvedId;
    if (eventData?.slug) eventInput.dataset.resolvedSlug = eventData.slug;
    else eventInput.dataset.resolvedSlug = value;
  } else {
    delete eventInput.dataset.prefilled;
    delete eventInput.dataset.resolvedId;
    delete eventInput.dataset.resolvedSlug;
  }
  if (eventSelect) eventSelect.value = value || '';
}

async function loadEventOptions() {
  if (!eventSelect) return;
  try {
    const res = await fetch(`${SCOPE}events.json`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const list = Array.isArray(data?.events) ? data.events : [];
    knownEvents.clear();
    const currentValue = eventInput ? String(eventInput.value || '').trim() : '';

    eventSelect.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Sélectionner un événement';
    eventSelect.append(placeholder);

    list
      .slice()
      .sort((a, b) => {
        const da = a?.startsAt ? new Date(a.startsAt).getTime() : 0;
        const db = b?.startsAt ? new Date(b.startsAt).getTime() : 0;
        return da - db;
      })
      .forEach((ev) => {
        const slug = String(ev?.slug || '').trim();
        if (!slug) return;
        const normalized = {
          id: String(ev?._id || ev?.id || ''),
          slug,
          name: ev?.name || slug,
          startsAt: ev?.startsAt || null,
          seasonCode: ev?.seasonCode || null,
          venueSlug: ev?.venueSlug || null
        };
        knownEvents.set(slug, normalized);
        if (normalized.id) knownEvents.set(normalized.id, normalized);
        const opt = document.createElement('option');
        opt.value = slug;
        opt.textContent = formatEventOptionLabel(normalized);
        eventSelect.append(opt);
      });

    if (currentValue && !knownEvents.has(currentValue)) {
      const fallback = {
        id: null,
        slug: currentValue,
        name: currentValue,
        startsAt: null,
        seasonCode: null,
        venueSlug: null
      };
      knownEvents.set(currentValue, fallback);
      const opt = document.createElement('option');
      opt.value = currentValue;
      opt.textContent = fallback.name;
      eventSelect.append(opt);
    }

    if (currentValue && knownEvents.has(currentValue)) {
      eventSelect.value = currentValue;
      updateEventInput(currentValue, knownEvents.get(currentValue));
    } else {
      eventSelect.value = '';
      updateEventInput('', null);
    }
  } catch (err) {
    console.warn('[scan] events fetch failed:', err?.message || err);
    if (eventSelect && !eventSelect.children.length) {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Sélectionner un événement';
      eventSelect.append(placeholder);
      if (eventInput?.value) {
        const opt = document.createElement('option');
        opt.value = eventInput.value;
        opt.textContent = eventInput.value;
        eventSelect.append(opt);
      }
    }
  }
}

if (eventInput && initialContext.slug) {
  updateEventInput(initialContext.slug, { slug: initialContext.slug });
}
if (tokenInput && initialContext.token) {
  tokenInput.value = initialContext.token;
  tokenInput.dataset.prefilled = 'true';
}
if (loginInput && initialContext.login) {
  loginInput.value = initialContext.login;
  loginInput.dataset.prefilled = 'true';
}
if (passwordInput && initialContext.password) {
  passwordInput.value = initialContext.password;
  passwordInput.dataset.prefilled = 'true';
}
const defaultGateValue = initialContext.gate || getStoredGate();
if (gateInput && defaultGateValue) {
  gateInput.value = defaultGateValue;
}
gateInput?.addEventListener('input', () => {
  const value = String(gateInput.value || '').trim();
  setStoredGate(value);
});

if (eventSelect) {
  eventSelect.addEventListener('change', () => {
    const value = eventSelect.value;
    const ev = knownEvents.get(value) || null;
    updateEventInput(value, ev);
  });
}

loadEventOptions();
setScanToggleState(false);

const tokenRow = document.querySelector('.auth-row-token');
const loginRow = document.querySelector('.auth-row-login');
const passwordRow = document.querySelector('.auth-row-password');

let authMode = 'token';
if (initialContext.token) authMode = 'token';
else if (initialContext.login && initialContext.password) authMode = 'basic';

const authContext = {
  mode: authMode,
  token: tokenInput ? String(tokenInput.value || '').trim() : '',
  login: loginInput ? String(loginInput.value || '').trim() : '',
  password: passwordInput ? String(passwordInput.value || '').trim() : ''
};

function updateAuthToggleUI() {
  if (!authToggle) return;
  const isBasic = authMode === 'basic';
  authToggle.classList.toggle('on', isBasic);
  authToggle.setAttribute('aria-checked', isBasic ? 'true' : 'false');
  if (authToggleLabel) {
    authToggleLabel.textContent = isBasic ? 'LOGIN' : 'TOKEN';
  }
}

applyAuthMode(authMode);
updateAuthToggleUI();
authToggle?.addEventListener('click', () => {
  applyAuthMode(authMode === 'token' ? 'basic' : 'token');
});
authToggle?.addEventListener('keydown', (e) => {
  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    applyAuthMode(authMode === 'token' ? 'basic' : 'token');
  }
});

function updateModeToggleUI() {
  if (!modeToggle) return;
  const isOrder = loadMode === 'order';
  const compactLabels = bodyEl?.classList.contains('scan-immersive');
  const ticketLabel = compactLabels ? 'TCKT' : 'Ticket';
  const orderLabel = compactLabels ? 'ORDR' : 'Commande';
  modeToggle.classList.toggle('on', isOrder);
  modeToggle.setAttribute('aria-checked', isOrder ? 'true' : 'false');
  if (modeToggleLabel) modeToggleLabel.textContent = isOrder ? orderLabel : ticketLabel;
  if (modeOptionTicket) modeOptionTicket.textContent = ticketLabel;
  if (modeOptionOrder) modeOptionOrder.textContent = orderLabel;
}

updateModeToggleUI();
modeToggle?.addEventListener('click', () => {
  loadMode = loadMode === 'order' ? 'ticket' : 'order';
  updateModeToggleUI();
});
modeToggle?.addEventListener('keydown', (e) => {
  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    loadMode = loadMode === 'order' ? 'ticket' : 'order';
    updateModeToggleUI();
  }
});

function applyAuthMode(mode) {
  authMode = mode === 'basic' ? 'basic' : 'token';
  tokenRow?.classList.toggle('auth-hidden', authMode !== 'token');
  loginRow?.classList.toggle('auth-hidden', authMode !== 'basic');
  passwordRow?.classList.toggle('auth-hidden', authMode !== 'basic');
  authFields?.classList.toggle('basic-mode', authMode === 'basic');
  updateAuthToggleUI();
}

function getAuthContext() {
  const mode = authMode;
  let tokenValue = '';
  let loginValue = '';
  let passwordValue = '';
  if (mode === 'token') {
    tokenValue = tokenInput ? String(tokenInput.value || '').trim() : '';
  } else {
    loginValue = loginInput ? String(loginInput.value || '').trim() : '';
    passwordValue = passwordInput ? String(passwordInput.value || '').trim() : '';
  }
  authContext.mode = mode;
  authContext.token = tokenValue;
  authContext.login = loginValue;
  authContext.password = passwordValue;
  return {
    mode,
    token: tokenValue,
    login: loginValue,
    password: passwordValue
  };
}

function getEventValueForRequest(fallback = '') {
  const resolvedId = eventInput?.dataset.resolvedId ? String(eventInput.dataset.resolvedId).trim() : '';
  const resolvedSlug = eventInput?.dataset.resolvedSlug ? String(eventInput.dataset.resolvedSlug).trim() : '';
  const raw = eventInput ? String(eventInput.value || '').trim() : '';
  return resolvedId || resolvedSlug || raw || fallback;
}

function matchOverlaySize() {
  if (!overlay || !overlayCtx) return;
  if (!video.videoWidth || !video.videoHeight) return;
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;
  overlay.style.width = `${video.clientWidth}px`;
  overlay.style.height = `${video.clientHeight}px`;
}

function clearOverlay() {
  if (!overlay || !overlayCtx) return;
  overlayCtx.clearRect(0, 0, overlay.width || 0, overlay.height || 0);
  overlay.classList.remove('show');
}

function flashBoundingBox(box, color = '#38bdf8', duration = 320) {
  if (!overlay || !overlayCtx || !box) return;
  matchOverlaySize();
  if (!overlay.width || !overlay.height || !video.videoWidth || !video.videoHeight) return;
  const scaleX = overlay.width / video.videoWidth;
  const scaleY = overlay.height / video.videoHeight;
  overlayCtx.save();
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  overlayCtx.strokeStyle = color;
  overlayCtx.lineWidth = Math.max(overlay.width, overlay.height) / 200;
  overlayCtx.shadowColor = color;
  overlayCtx.shadowBlur = 8;
  overlayCtx.strokeRect(box.x * scaleX, box.y * scaleY, box.width * scaleX, box.height * scaleY);
  overlayCtx.restore();
  overlay.classList.add('show');
  setTimeout(clearOverlay, duration);
}

function showDetectionVisual({ code, box } = {}) {
  if (typeof code === 'string') {
    console.info('[scan] decoded QR:', code);
  }
  if (box) {
    flashBoundingBox(box);
  }
}

function markRecentScan(value) {
  const key = String(value || '').trim();
  if (!key) return;
  const now = Date.now();
  recentScanTimestamps.set(key, now);
  setTimeout(() => {
    const stored = recentScanTimestamps.get(key);
    if (stored && stored <= now) recentScanTimestamps.delete(key);
  }, RECENT_SCAN_TTL_MS);
}

function isRecentlyScanned(value, withinMs = RECENT_SCAN_WINDOW_MS) {
  const key = String(value || '').trim();
  if (!key) return false;
  const last = recentScanTimestamps.get(key) || 0;
  return last && (Date.now() - last) < withinMs;
}

function shouldUseImmersiveMode() {
  if (!scanActive) return false;
  const portraitOk = portraitQuery ? portraitQuery.matches : true;
  const narrowOk = narrowQuery ? narrowQuery.matches : true;
  return portraitOk && narrowOk;
}

function relocateScanCount(immersive) {
  if (!scanCountContainer) return;
  if (immersive) {
    if (previewWrapper && scanCountContainer.parentElement !== previewWrapper) {
      previewWrapper.append(scanCountContainer);
    }
    return;
  }
  if (scanCountHomeParent && scanCountHomeMarker && scanCountContainer.parentElement !== scanCountHomeParent) {
    scanCountHomeParent.insertBefore(scanCountContainer, scanCountHomeMarker);
  }
}

function relocateImmersiveControls(immersive) {
  if (!previewWrapper || !previewControlsCol || !previewControlsCol.parentElement) return;
  if (immersive) {
    if (modeInline && modeInline.parentElement !== previewControlsCol) {
      previewControlsCol.append(modeInline);
    }
    if (scanInline && scanInline.parentElement !== previewControlsCol) {
      previewControlsCol.append(scanInline);
    }
    return;
  }
  if (modeInline && modeInlineHomeParent && modeInlineHomeMarker && modeInline.parentElement !== modeInlineHomeParent) {
    modeInlineHomeParent.insertBefore(modeInline, modeInlineHomeMarker);
  }
  if (scanInline && scanInlineHomeParent && scanInlineHomeMarker && scanInline.parentElement !== scanInlineHomeParent) {
    scanInlineHomeParent.insertBefore(scanInline, scanInlineHomeMarker);
  }
}

function updateImmersiveMode() {
  if (!bodyEl) return;
  const immersive = shouldUseImmersiveMode();
  bodyEl.classList.toggle('scan-immersive', immersive);
  relocateImmersiveControls(immersive);
  relocateScanCount(immersive);
  updateModeToggleUI();
}

if (portraitQuery) {
  const portraitHandler = () => updateImmersiveMode();
  if (typeof portraitQuery.addEventListener === 'function') {
    portraitQuery.addEventListener('change', portraitHandler);
  } else if (typeof portraitQuery.addListener === 'function') {
    portraitQuery.addListener(portraitHandler);
  }
}

if (narrowQuery) {
  const narrowHandler = () => updateImmersiveMode();
  if (typeof narrowQuery.addEventListener === 'function') {
    narrowQuery.addEventListener('change', narrowHandler);
  } else if (typeof narrowQuery.addListener === 'function') {
    narrowQuery.addListener(narrowHandler);
  }
}

window.addEventListener('resize', updateImmersiveMode);
window.addEventListener('orientationchange', updateImmersiveMode);
updateImmersiveMode();

function setScanToggleState(state) {
  scanActive = !!state;
  if (scanToggle) {
    scanToggle.classList.toggle('on', scanActive);
    scanToggle.setAttribute('aria-checked', scanActive ? 'true' : 'false');
    if (scanToggleLabel) {
      scanToggleLabel.textContent = scanActive ? 'SCAN ON' : 'SCAN OFF';
    }
  }
  if (previewWrapper) {
    previewWrapper.classList.toggle('hidden', !scanActive);
  }
  if (!scanActive) {
    hidePreviewGain();
  }
  updateImmersiveMode();
}

function stopScanning() {
  if (stopFn) {
    try { stopFn(); } catch {}
    stopFn = null;
  }
  if (stream) {
    try { stream.getTracks().forEach((t) => t.stop()); } catch {}
    stream = null;
  }
  if (video) {
    try { video.pause(); video.currentTime = 0; } catch {}
    video.srcObject = null;
    video.style.visibility = '';
  }
  clearOverlay();
  detectionLocked = false;
  recentScanTimestamps.clear();
  lastPreviewLookup.clear();
  hidePreviewGain();
}

// ----- Scan history storage -----
const resultsEl = document.getElementById('results');
const historyOrder = [];
const historyMap = new Map();
const HISTORY_LIMIT = 20;
const ENTRY_LOG_LIMIT = 10;
const lastPreviewLookup = new Map();

function updateScannedCountDisplay() {
  if (!scannedCountEl) return;
  const count = Math.max(0, historyOrder.length);
  scannedCountEl.textContent = String(count);
}
updateScannedCountDisplay();





// ----- Scan API calls + UI helpers -----

const REASON_MESSAGES = {
  unknown: 'Statut inconnu',
  ready: 'Billet prêt à valider',
  unknown_qr: 'QR inconnu pour cet événement',
  wrong_event: 'Ce billet appartient à un autre événement',
  already_scanned: 'Billet déjà scanné',
  invalid_signature: 'Signature invalide',
  mismatch_qr: 'QR non reconnu pour ce billet',
  unknown_ticket: 'Billet introuvable',
  event_not_found: 'Événement introuvable',
  event_required: 'Identifiant d\'événement requis',
  accepted: 'Billet validé',
  forced_accept: 'Entrée forcée',
  auto_accept: 'Billet validé automatiquement',
  confirmed_ticket: 'Billet confirmé',
  confirmed_already_scanned: 'Situation confirmée sur billet déjà scanné',
  confirmed_unknown_qr: 'QR inconnu confirmé',
  confirmed_wrong_event: 'Billet confirmé pour un autre événement',
  rejected: 'Billet rejeté',
  queued: 'Enregistré hors ligne',
  sync: 'Synchronisation effectuée',
  error: 'Erreur',
  invalid_response: 'Réponse inattendue du serveur',
  invalid_json: 'Réponse serveur invalide',
  sortie: 'Sortie enregistrée'
};

const ACTION_LABELS = {
  preview: 'Lecture',
  accept: 'Validation',
  reject: 'Rejet',
  confirm: 'Confirmation',
  queued: 'Hors ligne',
  sync: 'Synchronisation',
  error: 'Erreur',
  exit: 'Sortie'
};

function deviceFingerprint() {
  return navigator.userAgent || 'web';
}

const GATE_STORAGE_KEY = 'bts-scan-gate';
function getStoredGate() {
  try {
    const raw = localStorage.getItem(GATE_STORAGE_KEY);
    return raw ? String(raw) : '';
  } catch {
    return '';
  }
}

function setStoredGate(value) {
  try {
    if (value) localStorage.setItem(GATE_STORAGE_KEY, value);
    else localStorage.removeItem(GATE_STORAGE_KEY);
  } catch {}
}

function getGateName() {
  const inputVal = gateInput ? String(gateInput.value || '').trim() : '';
  if (inputVal) return inputVal;
  const stored = getStoredGate();
  if (stored) return stored;
  return initialContext.gate || '';
}

function shortId(id) {
  if (!id) return '';
  const str = String(id);
  return str.length > 6 ? '#' + str.slice(-6).toUpperCase() : '#' + str;
}

function translateReason(reason) {
  return REASON_MESSAGES[reason] || reason || 'Information';
}

function formatDate(value) {
  if (!value) return '';
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('fr-FR', { hour12: false });
  } catch {
    return '';
  }
}

async function drawQrInline(container, value) {
  if (!container) return;
  const text = String(value || '').trim();
  if (!text) {
    container.textContent = 'QR';
    return;
  }

  const url = `${SCOPE}qr.svg?value=${encodeURIComponent(text)}`;
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('http_' + res.status);
    const svg = await res.text();
    const trimmed = svg.trim();
    if (!trimmed.startsWith('<svg')) {
      container.textContent = text;
      return;
    }
    container.innerHTML = trimmed;
  } catch {
    container.textContent = text;
  }
}
function createItem(label, main, sub) {
  const wrap = document.createElement('div');
  wrap.className = 'card-item';
  const labelEl = document.createElement('span');
  labelEl.textContent = label;
  wrap.append(labelEl);
  const valueEl = document.createElement('strong');
  valueEl.textContent = main || '—';
  wrap.append(valueEl);
  if (sub) {
    const subEl = document.createElement('span');
    subEl.className = 'card-subline';
    subEl.textContent = sub;
    wrap.append(subEl);
  }
  return wrap;
}


function cloneEntry(entry) {
  const copy = { ...entry };
  if (entry.holder) copy.holder = { ...entry.holder };
  if (entry.order) copy.order = { ...entry.order };
  if (Array.isArray(entry.conditions)) copy.conditions = [...entry.conditions];
  if (Array.isArray(entry.logs)) copy.logs = [...entry.logs];
  return copy;
}

function enrichEntryBase(source = {}, context = {}) {
  const entry = cloneEntry(source || {});

  entry.ticketId = entry.ticketId || source.ticketId || null;
  entry.qrValue = entry.qrValue || source.qrValue || context.qrValue || '';
  entry.status = entry.status || source.status || (entry.ticketId ? 'ready' : 'unknown');
  entry.reason = entry.reason || source.reason || (entry.ticketId ? '' : 'unknown_qr');
  entry.eventId = entry.eventId || source.eventId || context.eventId || '';
  entry.eventSlug = entry.eventSlug || source.eventSlug || context.eventSlug || '';
  entry.subscription = entry.subscription ?? source.subscription ?? false;
  entry.createdAt = entry.createdAt || source.createdAt || Date.now();
  entry.scanCount = typeof source.scanCount === 'number' ? source.scanCount : (entry.scanCount || 0);

  if (!entry.holder && source.holder) entry.holder = { ...source.holder };
  entry.holder = entry.holder || { firstName: '', lastName: '', email: '' };

  if (source.order) {
    entry.order = { ...source.order };
    entry.order.id = entry.order.id || entry.order._id || '';
    entry.order.payerFirstName = entry.order.payerFirstName || '';
    entry.order.payerLastName = entry.order.payerLastName || '';
    entry.order.payerEmail = entry.order.payerEmail || '';
    entry.order.totalTickets = entry.order.totalTickets ?? 0;
    entry.order.scannedTickets = entry.order.scannedTickets ?? 0;
    entry.order.ticketIndex = entry.order.ticketIndex ?? null;
    entry.order.subscription = entry.order.subscription ?? entry.subscription ?? false;
    if (Array.isArray(source.order.tickets)) {
      entry.order.tickets = source.order.tickets.map((t) => ({ ...t }));
    }
  } else if (!entry.order) {
    entry.order = null;
  }

  if (!Array.isArray(entry.conditions)) entry.conditions = [];
  if (!Array.isArray(entry.logs)) entry.logs = Array.isArray(source.logs) ? [...source.logs] : [];

  if (Array.isArray(source.scanHistory)) {
    const historyLogs = source.scanHistory.map((item) => {
      const mapping = HISTORY_ACTION_MAP[item.action] || { action: 'preview', status: item.action || 'info' };
      return {
        timestamp: item.when ? new Date(item.when).getTime() : Date.now(),
        action: mapping.action,
        status: mapping.status,
        info: item.by || ''
      };
    });
    entry.logs = Array.isArray(entry.logs) ? [...entry.logs, ...historyLogs] : historyLogs;
  }

  entry.logs = Array.isArray(entry.logs) ? entry.logs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)) : [];
  if (entry.logs.length > ENTRY_LOG_LIMIT) entry.logs = entry.logs.slice(0, ENTRY_LOG_LIMIT);

  return entry;
}

function keyForEntry(match) {
  if (match?.ticketId) return `ticket:${match.ticketId}`;
  return `qr:${match?.qrValue || ''}`;
}

function upsertHistory(entry) {
  const key = keyForEntry(entry);
  const existing = historyMap.get(key);
  const copy = cloneEntry(entry);
  copy.createdAt = copy.createdAt || Date.now();
  copy.status = copy.status || 'ready';
  copy.logs = existing?.logs ? [...existing.logs] : (copy.logs || []);
  const existingIndex = historyOrder.indexOf(key);
  if (existingIndex >= 0) historyOrder.splice(existingIndex, 1);
  historyOrder.unshift(key);
  historyMap.set(key, copy);
  if (copy.logs.length > ENTRY_LOG_LIMIT) copy.logs = copy.logs.slice(0, ENTRY_LOG_LIMIT);
  while (historyOrder.length > HISTORY_LIMIT) {
    const removed = historyOrder.pop();
    historyMap.delete(removed);
  }
}

function removeHistoryEntry(entry) {
  const key = typeof entry === 'string' ? entry : keyForEntry(entry);
  const existing = historyMap.get(key);
  const idx = historyOrder.indexOf(key);
  if (idx >= 0) historyOrder.splice(idx, 1);
  historyMap.delete(key);
  const raw = existing?.qrValue || (typeof entry === 'object' ? entry?.qrValue : null);
  if (raw) lastPreviewLookup.delete(raw);
}

function getHistoryEntries() {
  return historyOrder.map((key) => historyMap.get(key)).filter(Boolean);
}

function logAction({ action, status, entryKey, info, event }) {
  if (!entryKey) return;
  const entry = historyMap.get(entryKey);
  if (!entry) return;
  entry.logs = Array.isArray(entry.logs) ? entry.logs : [];
  entry.logs.unshift({
    timestamp: Date.now(),
    action,
    status,
    info,
    event
  });
  if (entry.logs.length > ENTRY_LOG_LIMIT) entry.logs.pop();
}

function renderTicketHistory(logs) {
  if (!Array.isArray(logs) || logs.length <= 1) return null;
  const entries = logs.slice(1); // skip current action
  if (!entries.length) return null;
  const wrap = document.createElement('div');
  wrap.className = 'ticket-history';
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>Date</th><th>Action</th><th>Statut</th></tr>';
  const tbody = document.createElement('tbody');
  entries.forEach((log) => {
    const tr = document.createElement('tr');
    const actionLabel = ACTION_LABELS[log.action] || log.action;
    const statusLabel = translateReason(log.status);
    tr.innerHTML = `<td>${formatDate(log.timestamp)}</td>` +
      `<td>${actionLabel}</td>` +
      `<td>${statusLabel}</td>`;
    tbody.append(tr);
  });
  table.append(thead, tbody);
  wrap.append(table);
  return wrap;
}

function renderTicketList() {
  if (!resultsEl) return;
  resultsEl.innerHTML = '';
  const entries = getHistoryEntries();
  updateScannedCountDisplay();
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'results-empty';
    empty.textContent = 'Scannez un billet pour afficher le détail ici.';
    resultsEl.append(empty);
    return;
  }
  entries.forEach((entry) => {
    resultsEl.append(buildTicketCard(entry));
  });
}

function buildTicketCard(match) {
  const card = document.createElement('div');
  card.className = 'ticket-card';
  card.dataset.entryKey = keyForEntry(match);

  const head = document.createElement('div');
  head.className = 'card-head visually-hidden';

  const headInfo = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = match.ticketId ? shortId(match.ticketId) : (match.qrValue || 'QR');
  const sub = document.createElement('div');
  sub.className = 'card-sub';
  sub.textContent = match.status ? translateReason(match.status) : '';
  headInfo.append(title);
  if (sub.textContent) headInfo.append(sub);

  head.append(headInfo);
  card.append(head);

  const body = document.createElement('div');
  body.className = 'card-body';

  const sectionTariff = document.createElement('div');
  sectionTariff.className = 'card-section section-tariff';
  const tariffTitle = document.createElement('div');
  tariffTitle.className = 'section-title';
  const isSubscription = !!match.subscription;
  tariffTitle.textContent = isSubscription ? 'Abonnement' : 'Tarif';
  if (isSubscription) tariffTitle.classList.add('subscription');
  sectionTariff.append(tariffTitle);
  const tariffDetails = match.tariff || {};
  const fallbackTariffText = match.ticketId ? '—' : 'QR';
  const labelRaw = String(match.tariffLabel || tariffDetails.label || '').trim();
  const codeRaw = String(match.tariffCode || tariffDetails.code || '').trim();
  const displayLabel = labelRaw || codeRaw || fallbackTariffText;

  const tariffMain = document.createElement('div');
  tariffMain.className = 'card-item highlight';
  const tariffMainContent = document.createElement('div');
  tariffMainContent.className = 'card-item-content';
  const tariffLabelEl = document.createElement('strong');
  tariffLabelEl.textContent = displayLabel;
  tariffMainContent.append(tariffLabelEl);
  tariffMain.append(tariffMainContent);
  sectionTariff.append(tariffMain);

  const fieldLabelText = String(match.tariffFieldLabel || tariffDetails.fieldLabel || '').trim();
  const requiresInfoText = String(match.tariffRequiresInfo || tariffDetails.requiresInfo || '').trim();
  const rawRequiresField = match.tariffRequiresField ?? tariffDetails.requiresField ?? null;
  let requiresFieldKey = '';
  let hasRequiresField = false;
  if (typeof rawRequiresField === 'boolean') {
    hasRequiresField = rawRequiresField;
  } else if (rawRequiresField != null) {
    const rawStr = String(rawRequiresField).trim();
    if (rawStr) {
      const lower = rawStr.toLowerCase();
      if (!['false', '0', 'no', 'n'].includes(lower)) {
        hasRequiresField = true;
        if (!['true', '1', 'yes', 'y'].includes(lower)) {
          requiresFieldKey = rawStr;
        }
      }
    }
  }
  if (hasRequiresField) {
    const fieldItem = document.createElement('div');
    fieldItem.className = 'card-item inline';
    const titleLabel = fieldLabelText || requiresFieldKey || 'Justificatif';
    const fieldLabelEl = document.createElement('span');
    fieldLabelEl.textContent = `${titleLabel} :`;
    fieldItem.append(fieldLabelEl);
    const fieldValueEl = document.createElement('strong');
    fieldValueEl.textContent = requiresFieldKey || 'Requis';
    fieldItem.append(fieldValueEl);
    sectionTariff.append(fieldItem);
  }

  const infoItem = document.createElement('div');
  infoItem.className = 'card-item';
  const tariffInfoContent = document.createElement('div');
  tariffInfoContent.className = 'card-item-content';
  const infoValueEl = document.createElement('strong');
  infoValueEl.textContent = requiresInfoText || '—';
  tariffInfoContent.append(infoValueEl);
  infoItem.append(tariffInfoContent);
  sectionTariff.append(infoItem);
  if (requiresInfoText) {
    sectionTariff.classList.add('attention');
  }
  if (Array.isArray(match.conditions) && match.conditions.length) {
    match.conditions.forEach((cond, idx) => {
      const badgeWrap = document.createElement('div');
      badgeWrap.className = 'card-item';
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = cond;
      if (idx % 2 === 1) badge.classList.add('alt');
      badgeWrap.append(badge);
      sectionTariff.append(badgeWrap);
    });
  }
  body.append(sectionTariff);

  const sectionSeat = document.createElement('div');
  sectionSeat.className = 'card-section section-seat';
  const seatTitle = document.createElement('div');
  seatTitle.className = 'section-subtitle';
  seatTitle.textContent = 'Place — Bénéficiaire';
  sectionSeat.append(seatTitle);
  const seatInfo = document.createElement('div');
  seatInfo.className = 'card-item highlight';
  const seatInfoContent = document.createElement('div');
  seatInfoContent.className = 'card-item-content';
  const seatInfoStrong = document.createElement('strong');
  seatInfoStrong.textContent = match.location || match.qrValue || '—';
  seatInfoContent.append(seatInfoStrong);
  seatInfo.append(seatInfoContent);
  sectionSeat.append(seatInfo);
  const holderName = [match?.holder?.firstName, match?.holder?.lastName].filter(Boolean).join(' ').trim();
  const holderEmail = (match?.holder?.email || '').trim();
  const beneficiary = document.createElement('div');
  beneficiary.className = 'card-item';
  const beneficiaryContent = document.createElement('div');
  beneficiaryContent.className = 'card-item-content';
  const beneficiaryLineRaw = [holderName, holderEmail].filter(Boolean).join(' • ');
  const beneficiaryLine = beneficiaryLineRaw || '—';
  const beneficiaryStrong = document.createElement('strong');
  beneficiaryStrong.textContent = beneficiaryLine;
  beneficiaryContent.append(beneficiaryStrong);
  beneficiary.append(beneficiaryContent);
  sectionSeat.append(beneficiary);
  if (!match.ticketId) {
    const qrWrap = document.createElement('div');
    qrWrap.className = 'qr-preview';
    qrWrap.textContent = 'QR';
    sectionSeat.append(qrWrap);
    drawQrInline(qrWrap, match.qrValue);
  }
  body.append(sectionSeat);

  const sectionInfo = document.createElement('div');
  sectionInfo.className = 'card-section section-info';
  const infoTitle = document.createElement('div');
  infoTitle.className = 'section-subtitle';
  infoTitle.textContent = 'Information';
  sectionInfo.append(infoTitle);
  const reasonText = match.reason ? translateReason(match.reason) : (match.status && match.status !== 'ready' ? translateReason(match.status) : '');
  const qrLine = document.createElement('div');
  qrLine.className = 'card-item inline';
  const qrValue = match.ticketId ? shortId(match.ticketId) : (match.qrValue || '—');
  qrLine.innerHTML = `<span>QR :</span><strong>${qrValue}</strong>`;
  sectionInfo.append(qrLine);

  const infoContent = document.createElement('div');
  infoContent.className = 'card-item highlight';
  const infoContentWrap = document.createElement('div');
  infoContentWrap.className = 'card-item-content';
  const details = [];
  if (reasonText) details.push(reasonText);
  if (match.scanCount) details.push(`${match.scanCount} passage(s)`);
  const infoStrong = document.createElement('strong');
  infoStrong.textContent = details.join(' • ') || '—';
  infoContentWrap.append(infoStrong);
  infoContent.append(infoContentWrap);
  sectionInfo.append(infoContent);
  body.append(sectionInfo);

  const sectionOrder = document.createElement('div');
  sectionOrder.className = 'card-section section-order';
  const orderHeader = document.createElement('div');
  orderHeader.className = 'section-title-row';
  const orderTitle = document.createElement('div');
  orderTitle.className = 'section-title';
  orderTitle.textContent = 'Commande';
  orderHeader.append(orderTitle);
  sectionOrder.append(orderHeader);
  if (match.order) {
    const idLine = document.createElement('div');
    idLine.className = 'card-item highlight';
    const idWrap = document.createElement('div');
    idWrap.className = 'card-item-content';
    const idStrong = document.createElement('strong');
    idStrong.textContent = `#${match.order.id || '—'}`;
    idWrap.append(idStrong);
    idLine.append(idWrap);
    sectionOrder.append(idLine);
    const total = Number(match.order.totalTickets || 0);
    if (total > 0) {
      const scanned = Math.min(Number(match.order.scannedTickets || 0), total);
      const index = Number(match.order.ticketIndex || 0);
      const billetLabel = index > 0 ? `${index}/${total}` : `${scanned}/${total}`;
      sectionOrder.querySelector('.section-title').innerHTML = `Commande — <strong>${billetLabel}</strong>`;
    }
    const contactName = [match.order.payerFirstName, match.order.payerLastName].filter(Boolean).join(' ').trim();
    const contactLabel = document.createElement('div');
    contactLabel.className = 'card-item';
    const contactWrap = document.createElement('div');
    contactWrap.className = 'card-item-content';
    const contactLine = [contactName, match.order.payerEmail].filter(Boolean).join(' • ') || '—';
    const contactStrong = document.createElement('strong');
    contactStrong.textContent = contactLine;
    contactWrap.append(contactStrong);
    contactLabel.append(contactWrap);
    sectionOrder.append(contactLabel);

  } else {
    const fallback = document.createElement('div');
    fallback.className = 'card-item';
    const fallbackWrap = document.createElement('div');
    fallbackWrap.className = 'card-item-content';
    const fallbackStrong = document.createElement('strong');
    fallbackStrong.textContent = '—';
    fallbackWrap.append(fallbackStrong);
    fallback.append(fallbackWrap);
    sectionOrder.append(fallback);
  }
  body.append(sectionOrder);

  card.append(body);

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const addBtn = (label, className, handler) => {
    const btn = document.createElement('button');
    btn.classList.add(className);
    btn.textContent = label;
    btn.addEventListener('click', handler);
    actions.append(btn);
    return btn;
  };

  if (!match.ticketId) {
    addBtn('Accepter', 'action-accept', () => handleConfirm(match));
    addBtn('Refuser', 'action-reject', () => { removeHistoryEntry(match); renderTicketList(); });
  } else if (match.status === 'ready') {
    addBtn('Accepter', 'action-accept', () => handleAccept(match));
    addBtn('Refuser', 'action-reject', () => handleReject(match));
  } else if (match.status === 'already_scanned') {
    addBtn('SORTIR', 'action-cancel', () => handleExit(match));
    addBtn('Forcer', 'action-force', () => handleAccept(match, { force: true }));
    addBtn('Refuser', 'action-reject', () => handleReject(match));
  } else {
    addBtn('SORTIR', 'action-cancel', () => handleExit(match));
    addBtn('Refuser', 'action-reject', () => handleReject(match));
  }

  const hasActions = actions.childElementCount > 0;
  if (hasActions) {
    card.append(actions);
  }

  const historyTable = renderTicketHistory(match.logs);
  if (historyTable) card.append(historyTable);

  return card;
}

renderTicketList();
async function postScanOnline(payload) {
  const headers = { 'Content-Type': 'application/json' };
  const authMode = payload.authMode || ((payload.login && payload.password) ? 'basic' : 'token');
  if (authMode === 'basic' && payload.login && payload.password) {
    headers['Authorization'] = 'Basic ' + encodeBasicCredentials(payload.login, payload.password);
  } else if (authMode === 'token' && payload.token) {
    headers['Authorization'] = 'Bearer ' + payload.token;
  }
  if (payload.gate) headers['X-Gate'] = payload.gate;

  const body = {
    value: payload.value,
    eventId: payload.eventId,
    decision: payload.decision || 'preview',
    deviceId: payload.deviceId || deviceFingerprint()
  };
  if (payload.ticketId) body.ticketId = payload.ticketId;
  if (payload.force) body.force = true;

  let res;
  try {
    res = await fetch(BASE + '/control/api/scan', {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
  } catch (err) {
    err.network = true;
    throw err;
  }

  const contentType = String(res.headers.get('content-type') || '').toLowerCase();
  const isJson = contentType.includes('application/json');

  if (res.ok) {
    if (isJson) {
      return res.json();
    }
    const text = await res.text().catch(() => '');
    const err = new Error('server');
    err.server = true;
    err.status = res.status;
    err.body = { error: 'invalid_response', body: text.slice(0, 2000) };
    throw err;
  }

  const err = new Error('server');
  err.server = true;
  err.status = res.status;
  if (isJson) {
    try {
      err.body = await res.json();
    } catch {
      err.body = { error: 'invalid_json' };
    }
  } else {
    const text = await res.text().catch(() => '');
    err.body = { error: 'invalid_response', body: text.slice(0, 2000) };
  }
  throw err;
}

async function previewScan(raw) {
  if (!raw) return;
  const lastTs = lastPreviewLookup.get(raw);
  if (lastTs && (Date.now() - lastTs) < 15000) {
    return;
  }
  const auth = getAuthContext();
  const eventValue = getEventValueForRequest();
  if (!eventValue) {
    updateStatus('ko', 'Event requis');
    return;
  }
  if (auth.mode === 'token' && !auth.token) {
    updateStatus('ko', 'Token requis');
    return;
  }
  if (auth.mode === 'basic' && (!auth.login || !auth.password)) {
    updateStatus('ko', 'Identifiants requis');
    return;
  }

  const payload = {
    value: raw,
    eventId: eventValue,
    authMode: auth.mode,
    token: auth.token,
    login: auth.login,
    password: auth.password,
    decision: 'preview',
    deviceId: deviceFingerprint(),
    gate: getGateName()
  };
  try {
    const data = await postScanOnline(payload);
    lastPreviewLookup.set(raw, Date.now());
    const context = {
      qrValue: raw,
      eventId: data.event?.id || eventValue,
      eventSlug: data.event?.slug || eventValue
    };
    lastContext = context;
    if (eventInput && data.event?.id) {
      eventInput.dataset.resolvedId = data.event.id;
    }
    if (eventInput && data.event?.slug) {
      eventInput.value = data.event.slug;
      eventInput.dataset.resolvedSlug = data.event.slug;
    }

    const matches = Array.isArray(data.matches) ? data.matches : [];
    if (matches.length) {
      const cards = matches.filter((match) => loadMode === 'order' ? true : (match.isPrimary || (!match.ticketId && match.qrValue === raw)));

      cards.forEach((match) => {
        const entry = enrichEntryBase(match, context);
        const entryKey = keyForEntry(entry);
        upsertHistory(entry);
        const entryLabel = match.ticketId ? shortId(match.ticketId) : match.qrValue;
        logAction({
          action: 'preview',
          status: match.status || 'unknown',
          entryKey,
          entry: entryLabel,
          info: match.location || '',
          event: context.eventSlug
        });
      });
      renderTicketList();
      const readyCount = cards.filter((m) => m.status === 'ready').length;
      showPreviewGain(readyCount);
      if (readyCount > 0) {
        updateStatus('ok', readyCount > 1 ? `${readyCount} billets prêts à valider` : 'Billet prêt à valider');
      } else {
        updateStatus('', '');
      }
    } else {
      // No card, keep status unchanged
      hidePreviewGain();
    }
  } catch (e) {
    lastPreviewLookup.set(raw, Date.now());
    if (e.server) {
      const reason = e.body?.reason || 'error';
      updateStatus('ko', translateReason(reason) || e.body?.error || ('HTTP ' + e.status));
      logAction({ action: 'preview', status: reason, entryKey: null, entry: raw, info: 'Erreur serveur', event: eventValue });
      return;
    }

    const offlineEntry = {
      ticketId: '',
      qrValue: raw,
      status: 'queued',
      reason: 'queued',
      eventId: null,
      eventSlug: eventValue,
      createdAt: Date.now(),
      logs: []
    };
    const entryKey = keyForEntry(offlineEntry);
    upsertHistory(offlineEntry);
    logAction({ action: 'queued', status: 'queued', entryKey, entry: raw, info: 'Enregistré hors ligne', event: eventValue });
    renderTicketList();

    await idbAdd({ ts: Date.now(), payload: {
      value: raw,
      eventId: eventValue,
      authMode: auth.mode,
      token: auth.mode === 'token' ? auth.token : '',
      login: auth.mode === 'basic' ? auth.login : '',
      password: auth.mode === 'basic' ? auth.password : '',
      decision: 'auto',
      deviceId: deviceFingerprint(),
      gate: getGateName()
    }});
    const networkMsg = e?.message ? `Connexion perdue — ${e.message}` : 'Hors-ligne — validation différée';
    updateStatus('ko', networkMsg);
    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'flush-request' });
    }
  }
}

async function handleAccept(match, options = {}) {
  if (!match?.ticketId) return;
  const auth = getAuthContext();
  const eventId = match.eventId || lastContext?.eventId || getEventValueForRequest();
  if (!eventId) {
    updateStatus('ko', 'Event requis');
    return;
  }
  if (auth.mode === 'token' && !auth.token) {
    updateStatus('ko', 'Token requis');
    return;
  }
  if (auth.mode === 'basic' && (!auth.login || !auth.password)) {
    updateStatus('ko', 'Identifiants requis');
    return;
  }

  const entryKey = keyForEntry(match);
  const payload = {
    value: match.qrValue || lastContext?.qrValue || '',
    eventId,
    authMode: auth.mode,
    token: auth.token,
    login: auth.login,
    password: auth.password,
    decision: 'accept',
    ticketId: match.ticketId,
    deviceId: deviceFingerprint(),
    gate: getGateName()
  };
  if (options.force) payload.force = true;

  try {
    const data = await postScanOnline(payload);
    if (data.ok) {
      logAction({
        action: 'accept',
        status: options.force ? 'forced_accept' : 'accepted',
        entryKey,
        entry: shortId(match.ticketId),
        info: match.location || '',
        event: match.eventSlug || eventId
      });
      removeHistoryEntry(entryKey);
      renderTicketList();
      updateStatus('ok', options.force ? 'Entrée forcée' : 'Billet validé');
    } else {
      if (data.ticket) {
        const entry = enrichEntryBase(data.ticket, { eventId, eventSlug: match.eventSlug || eventId, qrValue: match.qrValue });
        upsertHistory(entry);
        logAction({
          action: 'accept',
          status: data.reason || 'error',
          entryKey: keyForEntry(entry),
          entry: shortId(data.ticket.ticketId || match.ticketId),
          info: 'Refus serveur',
          event: match.eventSlug || eventId
        });
      } else {
        logAction({ action: 'accept', status: data.reason || 'error', entryKey, entry: shortId(match.ticketId), info: 'Refus serveur', event: match.eventSlug || eventId });
      }
      renderTicketList();
      updateStatus('ko', translateReason(data.reason));
    }
  } catch (e) {
    if (e.server) {
      if (e.body?.ticket) {
        const entry = enrichEntryBase(e.body.ticket, { eventId, eventSlug: match.eventSlug || eventId, qrValue: match.qrValue });
        upsertHistory(entry);
        logAction({ action: 'accept', status: e.body?.reason || 'error', entryKey: keyForEntry(entry), entry: shortId(match.ticketId), info: 'Erreur serveur', event: match.eventSlug || eventId });
      } else {
        logAction({ action: 'accept', status: e.body?.reason || 'error', entryKey, entry: shortId(match.ticketId), info: 'Erreur serveur', event: match.eventSlug || eventId });
      }
      renderTicketList();
      updateStatus('ko', translateReason(e.body?.reason) || e.body?.error || ('HTTP ' + e.status));
      return;
    }
    logAction({ action: 'accept', status: 'error', entryKey, entry: shortId(match.ticketId), info: 'Hors ligne', event: match.eventSlug || eventId });
    renderTicketList();
    updateStatus('ko', 'Hors-ligne — action impossible');
  }
}

async function handleReject(match) {
  const auth = getAuthContext();
  const eventId = match.eventId || lastContext?.eventId || getEventValueForRequest();
  if (!eventId) {
    updateStatus('ko', 'Event requis');
    return;
  }
  if (auth.mode === 'token' && !auth.token) {
    updateStatus('ko', 'Token requis');
    return;
  }
  if (auth.mode === 'basic' && (!auth.login || !auth.password)) {
    updateStatus('ko', 'Identifiants requis');
    return;
  }

  const entryKey = keyForEntry(match);
  const payload = {
    value: match.qrValue || lastContext?.qrValue || '',
    eventId,
    authMode: auth.mode,
    token: auth.token,
    login: auth.login,
    password: auth.password,
    decision: 'reject',
    ticketId: match.ticketId || undefined,
    deviceId: deviceFingerprint(),
    gate: getGateName()
  };
  try {
    await postScanOnline(payload);
    logAction({ action: 'reject', status: 'rejected', entryKey, entry: match.ticketId ? shortId(match.ticketId) : match.qrValue, info: match.location || '', event: match.eventSlug || eventId });
    removeHistoryEntry(entryKey);
    renderTicketList();
    updateStatus('ko', 'Billet rejeté');
  } catch (e) {
    if (e.server) {
      logAction({ action: 'reject', status: e.body?.reason || 'error', entryKey, entry: match.ticketId ? shortId(match.ticketId) : match.qrValue, info: 'Erreur serveur', event: match.eventSlug || eventId });
      renderTicketList();
      updateStatus('ko', translateReason(e.body?.reason) || e.body?.error || ('HTTP ' + e.status));
      return;
    }
    logAction({ action: 'reject', status: 'error', entryKey, entry: match.ticketId ? shortId(match.ticketId) : match.qrValue, info: 'Hors ligne', event: match.eventSlug || eventId });
    renderTicketList();
    updateStatus('ko', 'Hors-ligne — action impossible');
  }
}

async function handleConfirm(match) {
  const auth = getAuthContext();
  const eventId = match.eventId || lastContext?.eventId || getEventValueForRequest();
  if (!eventId) {
    updateStatus('ko', 'Event requis');
    return;
  }
  if (auth.mode === 'token' && !auth.token) {
    updateStatus('ko', 'Token requis');
    return;
  }
  if (auth.mode === 'basic' && (!auth.login || !auth.password)) {
    updateStatus('ko', 'Identifiants requis');
    return;
  }

  const entryKey = keyForEntry(match);
  const payload = {
    value: match.qrValue || lastContext?.qrValue || '',
    eventId,
    authMode: auth.mode,
    token: auth.token,
    login: auth.login,
    password: auth.password,
    decision: 'confirm',
    ticketId: match.ticketId || undefined,
    deviceId: deviceFingerprint(),
    gate: getGateName()
  };
  try {
    await postScanOnline(payload);
    logAction({ action: 'confirm', status: match.status === 'already_scanned' ? 'confirmed_already_scanned' : 'confirmed_ticket', entryKey, entry: match.ticketId ? shortId(match.ticketId) : match.qrValue, info: match.location || '', event: match.eventSlug || eventId });
    removeHistoryEntry(entryKey);
    renderTicketList();
    updateStatus('ok', 'Situation confirmée');
  } catch (e) {
    if (e.server) {
      logAction({ action: 'confirm', status: e.body?.reason || 'error', entryKey, entry: match.ticketId ? shortId(match.ticketId) : match.qrValue, info: 'Erreur serveur', event: match.eventSlug || eventId });
      renderTicketList();
      updateStatus('ko', translateReason(e.body?.reason) || e.body?.error || ('HTTP ' + e.status));
      return;
    }
    logAction({ action: 'confirm', status: 'error', entryKey, entry: match.ticketId ? shortId(match.ticketId) : match.qrValue, info: 'Hors ligne', event: match.eventSlug || eventId });
    renderTicketList();
    updateStatus('ko', 'Hors-ligne — action impossible');
  }
}

async function handleExit(match) {
  const auth = getAuthContext();
  const eventId = match.eventId || lastContext?.eventId || getEventValueForRequest();
  if (!eventId) {
    updateStatus('ko', 'Event requis');
    return;
  }
  if (auth.mode === 'token' && !auth.token) {
    updateStatus('ko', 'Token requis');
    return;
  }
  if (auth.mode === 'basic' && (!auth.login || !auth.password)) {
    updateStatus('ko', 'Identifiants requis');
    return;
  }

  const payload = {
    value: match.qrValue || lastContext?.qrValue || '',
    eventId,
    authMode: auth.mode,
    token: auth.token,
    login: auth.login,
    password: auth.password,
    decision: 'exit',
    ticketId: match.ticketId || undefined,
    deviceId: deviceFingerprint(),
    gate: getGateName()
  };

  try {
    await postScanOnline(payload);
    logAction({ action: 'exit', status: 'sortie', entryKey: keyForEntry(match), entry: match.ticketId ? shortId(match.ticketId) : match.qrValue, info: 'Sortie', event: match.eventSlug || eventId });
    removeHistoryEntry(match);
    renderTicketList();
    updateStatus('ok', 'Sortie effectuée');
  } catch (e) {
    if (e.server) {
      updateStatus('ko', translateReason(e.body?.reason) || e.body?.error || ('HTTP ' + e.status));
      return;
    }
    updateStatus('ko', 'Hors-ligne — action impossible');
  }
}

async function flushQueue() {
  const arr = await idbGetAll();
  if (!arr.length || !navigator.onLine) return;
  let okCount = 0;
  let failCount = 0;
  for (const item of arr) {
    try {
      await postScanOnline({
        ...item.payload,
        deviceId: item.payload?.deviceId || deviceFingerprint(),
        gate: item.payload?.gate || getGateName()
      });
      const entryKey = keyForEntry({ ticketId: item.payload?.ticketId || '', qrValue: item.payload?.value || '' });
      removeHistoryEntry(entryKey);
      okCount++;
    } catch {
      failCount++;
    }
  }
  if (failCount === 0) {
    await idbClear();
  }
  renderTicketList();
  if (okCount) {
    updateStatus('ok', `${okCount} scan(s) synchronisés`);
    logAction({ action: 'sync', status: 'sync', entryKey: null, entry: `${okCount} élément(s)`, info: failCount ? `${failCount} échec(s)` : '', event: lastContext?.eventSlug || '' });
  }
  if (failCount) {
    updateStatus('ko', `${failCount} synchronisation(s) en échec`);
    logAction({ action: 'sync', status: 'error', entryKey: null, entry: `${failCount} échec(s)`, info: 'Réessayer la synchronisation', event: lastContext?.eventSlug || '' });
  }
}
window.addEventListener('online', flushQueue);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') flushQueue();
});
window.addEventListener('beforeunload', () => {
  stopScanning();
  setScanToggleState(false);
});

// ----- Caméra + décodage -----
// 1) BarcodeDetector si dispo
async function startBarcodeDetector() {
  const det = new BarcodeDetector({ formats: ['qr_code'] });
  stopScanning();
  detectionLocked = false;
  clearOverlay();
  stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  video.srcObject = stream;
  await video.play();
  matchOverlaySize();

  const tick = async () => {
    if (!stream || detectionLocked) return;
    let frame = null;
    try {
      frame = await createImageBitmap(video);
      const codes = await det.detect(frame);
      frame?.close?.();
      if (!codes?.length) {
        requestAnimationFrame(tick);
        return;
      }

      const raw = codes[0]?.rawValue;
      const box = codes[0]?.boundingBox || null;
      const normalized = typeof raw === 'string' ? raw.trim() : '';
      if (!normalized) {
        requestAnimationFrame(tick);
        return;
      }

      const eventValue = getEventValueForRequest();
      const auth = getAuthContext();
      if (!eventValue) {
        statusEl.innerHTML = '<span class="ko">Event requis</span>';
        requestAnimationFrame(tick);
        return;
      }
      if (auth.mode === 'token' && !auth.token) {
        statusEl.innerHTML = '<span class="ko">Token requis</span>';
        requestAnimationFrame(tick);
        return;
      }
      if (auth.mode === 'basic' && (!auth.login || !auth.password)) {
        statusEl.innerHTML = '<span class="ko">Identifiants requis</span>';
        requestAnimationFrame(tick);
        return;
      }

      detectionLocked = true;
      if (isRecentlyScanned(normalized)) {
        detectionLocked = false;
        requestAnimationFrame(tick);
        return;
      }
      showDetectionVisual({ code: normalized, box });
      markRecentScan(normalized);
      try {
        await previewScan(normalized);
      } finally {
        detectionLocked = false;
        requestAnimationFrame(tick);
      }
    } catch (err) {
      frame?.close?.();
      console.error(err);
      if (!detectionLocked) requestAnimationFrame(tick);
    }
  };
  tick();

  stopFn = () => {
    if (stream) {
      try { stream.getTracks().forEach((t) => t.stop()); } catch {}
      stream = null;
    }
    try { video.pause(); } catch {}
    video.srcObject = null;
  };
}

// 2) Fallback ZXing (corrigé)
async function startZXing() {
  stopScanning();
  const s = document.createElement('script');
  s.src = 'https://unpkg.com/@zxing/library@0.20.0';
  await new Promise((ok,ko)=>{ s.onload=ok; s.onerror=ko; document.head.appendChild(s);});

  const reader = new ZXing.BrowserMultiFormatReader();

  async function getVideoInputs() {
    if (typeof ZXing.BrowserMultiFormatReader.listVideoInputDevices === 'function') {
      return await ZXing.BrowserMultiFormatReader.listVideoInputDevices();
    }
    if (navigator.mediaDevices?.enumerateDevices) {
      const all = await navigator.mediaDevices.enumerateDevices();
      return all.filter(d => d.kind === 'videoinput');
    }
    return [];
  }
  async function pickDeviceId(inputs) {
    if (!inputs || !inputs.length) return null;
    const back = inputs.find(d => /back|arrière|environment/i.test(d.label || ''));
    return (back || inputs[0]).deviceId || null;
  }

  let devices = await getVideoInputs();
  let deviceId = await pickDeviceId(devices);

  if (!deviceId) {
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } });
      const track = tmp.getVideoTracks()[0];
      const settings = track?.getSettings?.() || {};
      deviceId = settings.deviceId || null;
      track && track.stop();
    } catch { /* ignore */ }
  }

  const controls = await reader.decodeFromVideoDevice(deviceId ?? null, video, async (result) => {
    if (!result?.text) return;
    if (detectionLocked) return;
    const eventValue = getEventValueForRequest();
    const auth = getAuthContext();
    if (!eventValue) { statusEl.innerHTML='<span class="ko">Event requis</span>'; return; }
    if (auth.mode === 'token' && !auth.token) { statusEl.innerHTML='<span class="ko">Token requis</span>'; return; }
    if (auth.mode === 'basic' && (!auth.login || !auth.password)) { statusEl.innerHTML='<span class="ko">Identifiants requis</span>'; return; }
    const normalized = result.text.trim();
    if (isRecentlyScanned(normalized)) return;
    detectionLocked = true;
    showDetectionVisual({ code: normalized });
    markRecentScan(normalized);
    try {
      await previewScan(normalized);
    } finally {
      detectionLocked = false;
    }
  });
  stopFn = () => {
    controls && typeof controls.stop === 'function' && controls.stop();
    try { video.pause(); } catch {}
    video.srcObject = null;
    stream = null;
  };
}

async function start() {
  statusEl.textContent = 'Initialisation caméra…';
  try {
    if ('BarcodeDetector' in window) {
      await startBarcodeDetector();
    } else {
      await startZXing();
    }
  } catch(e) {
    console.error(e);
    statusEl.innerHTML = '<span class="ko">Erreur caméra</span>';
    throw e;
  }
}

async function enableScan() {
  if (scanActive) return;
  try {
    await start();
    setScanToggleState(true);
    statusEl.classList.remove('ok', 'ko');
    statusEl.textContent = 'Scan actif.';
  } catch (err) {
    setScanToggleState(false);
    throw err;
  }
}

function disableScan() {
  if (!scanActive && !stream && !stopFn) return;
  stopScanning();
  setScanToggleState(false);
  statusEl.classList.remove('ok', 'ko');
  statusEl.textContent = 'Prêt.';
}

scanToggle?.addEventListener('click', async () => {
  try {
    if (scanActive) {
      disableScan();
    } else {
      await enableScan();
    }
  } catch (err) {
    console.error(err);
  }
});

scanToggle?.addEventListener('keydown', async (e) => {
  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    try {
      if (scanActive) {
        disableScan();
      } else {
        await enableScan();
      }
    } catch (err) {
      console.error(err);
    }
  }
});
