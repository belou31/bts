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
let stream, stopFn = null;

async function showQueueSize(){
  try { const arr = await idbGetAll(); queueSizeEl.textContent = (arr.length||0)+' en attente'; }
  catch { queueSizeEl.textContent='?' }
}
showQueueSize();

// ----- Scan API calls -----
async function postScanOnline(payload) {
  const res = await fetch(BASE + '/api/scan', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer ' + payload.token, 'X-Gate': (payload.gate||'') },
    body: JSON.stringify({ value: payload.value, eventId: payload.eventId, deviceId: navigator.userAgent, force: !!payload.force })
  });
  if (res.ok) return res.json();
  let body={}; try{ body=await res.json(); }catch{}
  const err = new Error('server'); err.server = true; err.status = res.status; err.body = body; throw err;
}

async function postScan(payload) {
  try {
    const data = await postScanOnline(payload);
    if (data.ok) statusEl.innerHTML = '<span class="ok">OK</span> — '+(data.ticket?.seatId||'')+' — '+(data.ticket?.holder?.lastName||'');
    else         statusEl.innerHTML = '<span class="ko">KO</span> — '+(data.reason||'');
    return;
  } catch(e) {
    if (e.server) {
      const msg = e.body?.reason || e.body?.error || ('HTTP ' + e.status);
      statusEl.innerHTML = '<span class="ko">Erreur</span> — ' + msg;
      return;
    }
    // offline → buffer
    await idbAdd({ ts: Date.now(), payload });
    await showQueueSize();
    statusEl.innerHTML = '<span class="ko">Hors-ligne</span> — scan sauvegardé';
    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({ type:'flush-request' });
    }
  }
}

async function flushQueue() {
  const arr = await idbGetAll();
  if (!arr.length || !navigator.onLine) return;
  let okCount=0, failCount=0;
  for (const item of arr) {
    try { await postScanOnline(item.payload); okCount++; }
    catch { failCount++; }
  }
  if (failCount===0) { await idbClear(); }
  await showQueueSize();
  if (okCount) statusEl.innerHTML = '<span class="ok">Resynchronisation</span> — '+okCount+' envoyé(s)';
}
window.addEventListener('online', flushQueue);
document.addEventListener('visibilitychange', ()=>{ if (document.visibilityState==='visible') flushQueue(); });

// ----- Caméra + décodage -----
// 1) BarcodeDetector si dispo
async function startBarcodeDetector() {
  const det = new BarcodeDetector({ formats:['qr_code'] });
  stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }});
  video.srcObject = stream; await video.play();
  let busy=false;
  const tick = async () => {
    if (!stream) return;
    try {
      const frame = await createImageBitmap(video);
      const codes = await det.detect(frame);
      frame.close && frame.close();
      if (!busy && codes && codes[0]?.rawValue) {
        busy=true;
        const eventId = document.getElementById('eventId').value.trim();
        const token   = document.getElementById('token').value.trim();
        if (!eventId || !token) { statusEl.innerHTML='<span class="ko">Event ID & token requis</span>'; busy=false; requestAnimationFrame(tick); return; }
        await postScan({ value: codes[0].rawValue, eventId, token });
        setTimeout(()=>busy=false, 600);
      }
    } catch {}
    requestAnimationFrame(tick);
  };
  tick();
  stopFn = () => { stream.getTracks().forEach(t=>t.stop()); stream=null; };
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
    if (result?.text) {
      const eventId = document.getElementById('eventId').value.trim();
      const token   = document.getElementById('token').value.trim();
      if (!eventId || !token) { statusEl.innerHTML='<span class="ko">Event ID & token requis</span>'; return; }
      await postScan({ value: result.text, eventId, token });
    }
  });
  stopFn = ()=>controls.stop();
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
