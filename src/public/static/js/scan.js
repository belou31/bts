// ----- Déduction du préfixe côté client (robuste si BASE_PATH mal réglé)
const prefix = (window.__BTS__?.basePath ?? '').toString();
const BASE = prefix;                          // "" (DEV) ou "/bts" (INT/PROD)
const SCOPE = (window.__BTS__?.scope ?? (prefix + '/scan/')).replace('//','/');

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
const video = document.getElementById('preview');
const statusEl = document.getElementById('status');
const queueSizeEl = document.getElementById('queueSize');
const overlay = document.getElementById('overlay');
const overlayCtx = overlay ? overlay.getContext('2d') : null;
let stream, stopFn = null;
let detectionLocked = false;

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
  } else if (state === 'ko') {
    statusEl.classList.add('ko');
  }
}

const eventInput = document.getElementById('eventId');
const tokenInput = document.getElementById('token');
const loginInput = document.getElementById('login');
const passwordInput = document.getElementById('password');

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
  const slug = detectSlugFromPath();
  const token = params.get('token') || params.get('bearer') || '';
  const login = params.get('login') || params.get('user') || '';
  const password = params.get('password') || params.get('pass') || '';
  const gate = params.get('gate') || params.get('portail') || '';
  return { slug, token, login, password, gate };
})();


if (eventInput && initialContext.slug) {
  eventInput.value = initialContext.slug;
  eventInput.dataset.prefilled = 'true';
  eventInput.dataset.resolvedSlug = initialContext.slug;
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

const tokenRow = document.querySelector('.auth-row-token');
const loginRow = document.querySelector('.auth-row-login');
const passwordRow = document.querySelector('.auth-row-password');
const authModeInputs = Array.from(document.querySelectorAll('input[name="authMode"]'));

let authMode = 'token';
if (initialContext.token) authMode = 'token';
else if (initialContext.login && initialContext.password) authMode = 'basic';

const authContext = {
  mode: authMode,
  token: tokenInput ? String(tokenInput.value || '').trim() : '',
  login: loginInput ? String(loginInput.value || '').trim() : '',
  password: passwordInput ? String(passwordInput.value || '').trim() : ''
};

authModeInputs.forEach((input) => {
  input.checked = input.value === authMode;
  input.addEventListener('change', () => applyAuthMode(input.value));
});

applyAuthMode(authMode);

function applyAuthMode(mode) {
  authMode = mode === 'basic' ? 'basic' : 'token';
  authModeInputs.forEach((input) => {
    input.checked = input.value === authMode;
  });
  tokenRow?.classList.toggle('auth-hidden', authMode !== 'token');
  loginRow?.classList.toggle('auth-hidden', authMode !== 'basic');
  passwordRow?.classList.toggle('auth-hidden', authMode !== 'basic');
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
  video.style.visibility = '';
}

function captureFrameToOverlay() {
  if (!overlay || !overlayCtx) return;
  matchOverlaySize();
  if (overlay.width && overlay.height) {
    overlayCtx.drawImage(video, 0, 0, overlay.width, overlay.height);
    overlay.classList.add('show');
  }
}

function drawBoundingBox(box) {
  if (!overlay || !overlayCtx) return;
  if (!box || !overlay.width || !overlay.height || !video.videoWidth || !video.videoHeight) return;
  const scaleX = overlay.width / video.videoWidth;
  const scaleY = overlay.height / video.videoHeight;
  overlayCtx.save();
  overlayCtx.strokeStyle = '#38bdf8';
  overlayCtx.lineWidth = Math.max(overlay.width, overlay.height) / 200;
  overlayCtx.shadowColor = 'rgba(56,189,248,0.6)';
  overlayCtx.shadowBlur = 8;
  overlayCtx.strokeRect(box.x * scaleX, box.y * scaleY, box.width * scaleX, box.height * scaleY);
  overlayCtx.restore();
}

function freezeFrame({ box } = {}) {
  captureFrameToOverlay();
  if (box) drawBoundingBox(box);
  video.style.visibility = 'hidden';
  if (stream) {
    try { stream.getTracks().forEach(t => t.stop()); } catch {}
    stream = null;
  }
  try { video.pause(); } catch {}
  video.srcObject = null;
  stopFn = null;
  detectionLocked = true;
}

function showDetectionResult({ code, box } = {}) {
  if (typeof code === 'string') {
    console.info('[scan] decoded QR:', code);
  }
  freezeFrame({ box });
}

async function resetScanner() {
  if (stream) {
    try { stream.getTracks().forEach(t => t.stop()); } catch {}
    stream = null;
  }
  if (stopFn) {
    try { stopFn(); } catch {}
    stopFn = null;
  }
  video.srcObject = null;
  try { video.pause(); video.currentTime = 0; } catch {}
  video.style.visibility = '';
  clearOverlay();
  detectionLocked = false;
}

async function showQueueSize(){
  try { const arr = await idbGetAll(); queueSizeEl.textContent = (arr.length||0)+' en attente'; }
  catch { queueSizeEl.textContent='?' }
}
showQueueSize();





// ----- Scan API calls + UI helpers -----
const resultsEl = document.getElementById('results');
const historyOrder = [];
const historyMap = new Map();
const HISTORY_LIMIT = 50;
const ENTRY_LOG_LIMIT = 10;

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
  invalid_json: 'Réponse serveur invalide'
};

const ACTION_LABELS = {
  preview: 'Lecture',
  accept: 'Validation',
  reject: 'Rejet',
  confirm: 'Confirmation',
  queued: 'Hors ligne',
  sync: 'Synchronisation',
  error: 'Erreur'
};

function deviceFingerprint() {
  return navigator.userAgent || 'web';
}

function getGateName() {
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
  entry.createdAt = entry.createdAt || source.createdAt || Date.now();

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
  } else if (!entry.order) {
    entry.order = null;
  }

  if (!Array.isArray(entry.conditions)) entry.conditions = [];
  if (!Array.isArray(entry.logs)) entry.logs = Array.isArray(source.logs) ? [...source.logs] : [];

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
  while (historyOrder.length > HISTORY_LIMIT) {
    const removed = historyOrder.pop();
    historyMap.delete(removed);
  }
}

function removeHistoryEntry(entry) {
  const key = typeof entry === 'string' ? entry : keyForEntry(entry);
  const idx = historyOrder.indexOf(key);
  if (idx >= 0) historyOrder.splice(idx, 1);
  historyMap.delete(key);
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
  if (!Array.isArray(logs) || !logs.length) return null;
  const wrap = document.createElement('div');
  wrap.className = 'ticket-history';
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>Date</th><th>Action</th><th>Statut</th><th>Info</th></tr>';
  const tbody = document.createElement('tbody');
  logs.forEach((log) => {
    const tr = document.createElement('tr');
    const actionLabel = ACTION_LABELS[log.action] || log.action;
    const statusLabel = translateReason(log.status);
    tr.innerHTML = `<td>${formatDate(log.timestamp)}</td>` +
      `<td>${actionLabel}</td>` +
      `<td>${statusLabel}</td>` +
      `<td>${log.info || ''}</td>`;
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
  head.className = 'card-head';

  const headInfo = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = match.ticketId ? (match.tariffCode || 'Billet') : 'QR inconnu';
  const sub = document.createElement('div');
  sub.className = 'card-sub';
  const secondary = match.ticketId ? (match.location || '') : '';
  sub.textContent = secondary || match.qrValue || '—';
  headInfo.append(title, sub);

  head.append(headInfo);
  card.append(head);

  const body = document.createElement('div');
  body.className = 'card-body';

  if (match.ticketId) {
    const holderName = [match?.holder?.firstName, match?.holder?.lastName].filter(Boolean).join(' ').trim();
    const holderEmail = (match?.holder?.email || '').trim();
    body.append(createItem('Bénéficiaire', holderName || '—', holderEmail));

    if (match.order) {
      const contactName = [match.order.payerFirstName, match.order.payerLastName].filter(Boolean).join(' ').trim();
      const contactSub = [contactName, match.order.payerEmail].filter(Boolean).join(' • ');
      body.append(createItem('Commande', shortId(match.order.id || ''), contactSub));

      const total = Number(match.order.totalTickets || 0);
      if (total > 0) {
        const scanned = Math.min(Number(match.order.scannedTickets || 0), total);
        const index = Number(match.order.ticketIndex || 0);
        const subLine = index > 0 ? `Billet ${index}/${total}` : '';
        body.append(createItem('Billets scannés', `${scanned}/${total}`, subLine));
      }
    }
  }

  if (Array.isArray(match.conditions) && match.conditions.length) {
    const condWrap = document.createElement('div');
    condWrap.className = 'card-item';
    const label = document.createElement('span');
    label.textContent = 'Justificatifs';
    const list = document.createElement('ul');
    list.className = 'conditions';
    match.conditions.forEach((cond) => {
      const li = document.createElement('li');
      li.textContent = cond;
      list.append(li);
    });
    condWrap.append(label, list);
    body.append(condWrap);
  }

  const reasonText = match.reason ? translateReason(match.reason) : (match.status && match.status !== 'ready' ? translateReason(match.status) : '');
  if (reasonText) {
    body.append(createItem('Information', reasonText, ''));
  }

  if (match.createdAt) {
    body.append(createItem('Ajout', formatDate(match.createdAt), ''));
  }

  if (!match.ticketId) {
    const qrWrap = document.createElement('div');
    qrWrap.className = 'qr-preview';
    qrWrap.textContent = 'QR';
    body.append(qrWrap);
    drawQrInline(qrWrap, match.qrValue);
  }

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
    addBtn('Confirmer', 'confirm', () => handleConfirm(match));
  } else if (match.status === 'ready') {
    addBtn('Valider', 'accept', () => handleAccept(match));
    addBtn('Rejeter', 'reject', () => handleReject(match));
  } else if (match.status === 'already_scanned') {
    addBtn('Confirmer', 'confirm', () => handleConfirm(match));
    addBtn('Forcer l\'entrée', 'accept', () => handleAccept(match, { force: true }));
    addBtn('Rejeter', 'reject', () => handleReject(match));
  } else {
    addBtn('Confirmer', 'confirm', () => handleConfirm(match));
    addBtn('Rejeter', 'reject', () => handleReject(match));
  }

  if (actions.childElementCount > 0) {
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
    res = await fetch(BASE + '/api/scan', {
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
      matches.forEach((match) => {
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
      const readyCount = matches.filter((m) => m.status === 'ready').length;
      if (readyCount > 0) {
        updateStatus('ok', readyCount > 1 ? `${readyCount} billets prêts à valider` : 'Billet prêt à valider');
      } else {
        updateStatus('ko', 'Billet déjà scanné ou invalide');
      }
    } else {
      const entry = {
        ticketId: '',
        qrValue: raw,
        status: 'unknown',
        reason: data.reason || 'unknown_qr',
        eventId: context.eventId,
        eventSlug: context.eventSlug,
        createdAt: Date.now(),
        logs: []
      };
      const entryKey = keyForEntry(entry);
      upsertHistory(entry);
      logAction({ action: 'preview', status: data.reason || 'unknown_qr', entryKey, entry: raw, info: 'Aucun billet', event: context.eventSlug });
      renderTicketList();
      updateStatus('ko', translateReason(data.reason || 'unknown_qr'));
    }
  } catch (e) {
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
    await showQueueSize();
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
  await showQueueSize();
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

// ----- Caméra + décodage -----
// 1) BarcodeDetector si dispo
async function startBarcodeDetector() {
  const det = new BarcodeDetector({ formats: ['qr_code'] });
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
      if (!raw) {
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
      showDetectionResult({ code: raw, box });
      await previewScan(raw);
    } catch (err) {
      frame?.close?.();
      console.error(err);
      if (!detectionLocked) requestAnimationFrame(tick);
    }
  };
  tick();

  stopFn = () => {
    if (stream) {
      try { stream.getTracks().forEach(t => t.stop()); } catch {}
      stream = null;
    }
    try { video.pause(); } catch {}
    video.srcObject = null;
  };
  statusEl.textContent = 'Lecture QR (BarcodeDetector)…';
}

// 2) Fallback ZXing (corrigé)
async function startZXing() {
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
    detectionLocked = true;
    console.info('[scan] decoded QR (ZXing):', result.text);
    await previewScan(result.text);
  });
  stopFn = ()=>controls && typeof controls.stop === 'function' && controls.stop();
  statusEl.textContent = 'Lecture QR (ZXing)…';
}

async function start() {
  statusEl.textContent = 'Initialisation caméra…';
  try {
    if ('BarcodeDetector' in window) return await startBarcodeDetector();
    return await startZXing();
  } catch(e) { console.error(e); statusEl.innerHTML='<span class="ko">Erreur caméra</span>'; }
}
document.getElementById('startBtn').onclick = start;
document.getElementById('stopBtn').onclick  = ()=>{ stopFn && stopFn(); statusEl.textContent=''; };
