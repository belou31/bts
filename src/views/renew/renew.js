// src/views/renew/renew.js
console.log('[renew] boot v2025-08-26 sync-css-html-js');

const $plan          = document.getElementById('venuePlan');
const $planStatus    = document.getElementById('planStatus');
const $seatsList     = document.getElementById('seatsList');

const $payerFirst    = document.getElementById('payerFirst');
const $payerLast     = document.getElementById('payerLast');
const $payerEmail    = document.getElementById('payerEmail');

const $paySchedule   = document.getElementById('paySchedule');
const $schedulePrev  = document.getElementById('schedulePreview');
const $totalBox      = document.getElementById('totalBox');
const $payBtn        = document.getElementById('payBtn');

const CSS_ESCAPE = (window.CSS && CSS.escape) ? CSS.escape : (s)=>String(s).replace(/[^a-zA-Z0-9_-]/g,'\\$&');

const CTX = {
  seasonCode: null,
  venueSlug : null,
  tokenSeats: [],
  tariffs   : [],
  prices    : [],
  pricesIdx : null,
  seatsById : new Map(),
  // pan/zoom
  svg: null, vb: { x:0, y:0, w:1000, h:1000 }, panning:false, last: {x:0,y:0}, minScale:0.25, maxScale:6
};

/* ---------- Utils ---------- */
function formatEuro(cents) { return (Number(cents||0)/100).toLocaleString('fr-FR', { style:'currency', currency:'EUR' }); }
function euroSplit(totalCents, n) {
  n = Number(n||1);
  if (n<=1) return formatEuro(totalCents);
  const base = Math.floor(totalCents / n);
  const last = totalCents - base*(n-1);
  if (n===2) return `${formatEuro(base)} + ${formatEuro(last)}`;
  if (n===3) return `${formatEuro(base)} + ${formatEuro(base)} + ${formatEuro(last)}`;
  return `${n}× ${formatEuro(base)} (dern. ${formatEuro(last)})`;
}
function zoneKeyFromSeatId(sid) {
  const s = String(sid||''); const i = s.indexOf('-');
  return (i>0) ? s.slice(0,i) : s;
}
function buildPricesIndex(prices) {
  const idx = new Map();
  for (const p of (prices||[])) {
    const z = p.zoneKey, t = String(p.tariffCode||'').toUpperCase();
    if (!idx.has(z)) idx.set(z, new Map());
    idx.get(z).set(t, Number(p.priceCents)||0);
  }
  return idx;
}
function priceFor(zoneKey, tariff) {
  const t = String(tariff||'').toUpperCase();
  const m = CTX.pricesIdx.get(zoneKey);
  if (m && m.has(t)) return m.get(t);
  const star = CTX.pricesIdx.get('*');
  if (star && star.has(t)) return star.get(t);
  return 0;
}
function tariffsForZone(zoneKey) {
  const avail = new Set();
  for (const p of CTX.prices) if (p.zoneKey===zoneKey || p.zoneKey==='*') avail.add(String(p.tariffCode||'').toUpperCase());
  const order = CTX.tariffs.map(t => String(t.code||'').toUpperCase()).filter(Boolean);
  const list = order.filter(c => avail.has(c));
  for (const c of avail) if (!list.includes(c)) list.push(c);
  return list;
}

/* ---------- SVG helpers (pan/zoom & highlight) ---------- */
function svgSetViewBox(x,y,w,h) {
  const el = CTX.svg;
  if (!el) return;
  CTX.vb = { x,y,w,h };
  el.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
  $planStatus.textContent = `Zoom ${(1000/w*100).toFixed(0)}%`; // indicatif
}
function svgInitViewBox() {
  const el = CTX.svg;
  if (!el) return;
  const vbAttr = el.getAttribute('viewBox');
  if (vbAttr) {
    const [x,y,w,h] = vbAttr.split(/\s+|,/).map(Number);
    svgSetViewBox(x,y,w,h);
  } else {
    const w = Number(el.getAttribute('width'))  || 1000;
    const h = Number(el.getAttribute('height')) || 1000;
    svgSetViewBox(0,0,w,h);
  }
}
function svgPointFromClient(clientX, clientY) {
  const rect = $plan.getBoundingClientRect();
  const mx = clientX - rect.left, my = clientY - rect.top;
  const px = CTX.vb.x + (mx/rect.width)  * CTX.vb.w;
  const py = CTX.vb.y + (my/rect.height) * CTX.vb.h;
  return { px, py, mx, my, rect };
}
function svgOnWheel(e) {
  e.preventDefault();
  const { px, py, mx, my, rect } = svgPointFromClient(e.clientX, e.clientY);
  const dir = Math.sign(e.deltaY);
  const factor = (dir>0) ? 1.111 : 0.9;  // out / in
  let w2 = CTX.vb.w * factor;
  let h2 = CTX.vb.h * factor;

  // bornes zoom
  const w0 = CTX.svg.viewBox.baseVal ? CTX.svg.viewBox.baseVal.width : CTX.vb.w;
  const minW = w0 / CTX.maxScale;
  const maxW = w0 / CTX.minScale;
  w2 = Math.max(minW, Math.min(maxW, w2));
  h2 = w2 * (CTX.vb.h / CTX.vb.w);

  const x2 = px - (mx/rect.width)*w2;
  const y2 = py - (my/rect.height)*h2;
  svgSetViewBox(x2,y2,w2,h2);
}
function svgOnDown(e) {
  if (e.button!==0) return;
  CTX.panning = true;
  CTX.last.x = e.clientX;
  CTX.last.y = e.clientY;
  e.preventDefault();
}
function svgOnMove(e) {
  if (!CTX.panning) return;
  e.preventDefault();
  const dx = e.clientX - CTX.last.x;
  const dy = e.clientY - CTX.last.y;
  CTX.last.x = e.clientX; CTX.last.y = e.clientY;

  const rect = $plan.getBoundingClientRect();
  const vx = - dx / rect.width  * CTX.vb.w;
  const vy = - dy / rect.height * CTX.vb.h;
  svgSetViewBox(CTX.vb.x + vx, CTX.vb.y + vy, CTX.vb.w, CTX.vb.h);
}
function svgOnUp()  { CTX.panning = false; }
function svgInjectSeatStyle(doc) {
  // pour éviter le scaling de stroke
  const st = doc.createElementNS('http://www.w3.org/2000/svg','style');
  st.textContent = '.seat{vector-effect:non-scaling-stroke}';
  doc.documentElement.insertBefore(st, doc.documentElement.firstChild);
}
function applyAllowedStyle(el) {
  el.classList.add('seat');
  el.style.stroke = '#0ea5e9';
  el.style.strokeWidth = '2';
  el.style.fillOpacity = '0.15';
  el.style.cursor = 'pointer';
}
function applySelectedStyle(el) {
  el.classList.add('seat');
  el.style.stroke = '#22c55e';
  el.style.strokeWidth = '3';
  el.style.fillOpacity = '0.25';
  el.style.cursor = 'pointer';
}
function markAllowedSeats(ids) {
  const doc = $plan.contentDocument; if (!doc) return;
  (ids||[]).forEach(id => {
    const el = doc.querySelector(`[data-seat-id="${CSS_ESCAPE(id)}"]`);
    if (el) applyAllowedStyle(el);
  });
}
function updateSelectedHighlights(selectedIds) {
  const doc = $plan.contentDocument; if (!doc) return;
  // 1) repasse tous les "allowed" en style allowed ( ça enlève l'ancien vert )
  (CTX.tokenSeats||[]).forEach(id => {
    const el = doc.querySelector(`[data-seat-id="${CSS_ESCAPE(id)}"]`);
    if (el) applyAllowedStyle(el);
  });
  // 2) applique le style "selected" pour la sélection courante
  (selectedIds||[]).forEach(id => {
    const el = doc.querySelector(`[data-seat-id="${CSS_ESCAPE(id)}"]`);
    if (el) applySelectedStyle(el);
  });
}
function getSelectedSeatIdsFromForm() {
  return Array.from(document.querySelectorAll('.seat-line input.seat-check:checked')).map(cb => cb.dataset.seatId);
}

/* ---------- Champs conditionnels ---------- */

function getTariffMeta(tariffCode) {
  const code = String(tariffCode||'').toUpperCase();
  return CTX.tariffs.find(t => String(t.code||'').toUpperCase() === code) || {};
}


function getTariffMeta(tariffCode) {
  const code = String(tariffCode||'').toUpperCase();
  return CTX.tariffs.find(t => String(t.code||'').toUpperCase() === code) || {};
}

function truthy(v) {
  if (v === true) return true;
  if (v === false || v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s !== '' && s !== 'false' && s !== '0' && s !== 'no' && s !== 'non';
}

function updateConditionalFields(rowEl, tariffCode) {
  const justifGroup = rowEl.querySelector('.justif-group');
  const infoGroup   = rowEl.querySelector('.info-group');
  const justifInput = rowEl.querySelector('.justif-input');
  const infoInput   = rowEl.querySelector('.info-input');

  // reset
  if (justifGroup) justifGroup.style.display = 'none';
  if (infoGroup)   infoGroup.style.display   = 'none';
  if (justifInput) { justifInput.required = false; justifInput.placeholder = ''; }

  const meta = getTariffMeta(tariffCode);
  const needField = truthy(meta.requiresField);
  const fieldLabel = meta.fieldLabel || 'Justificatif';
  const infoText   = truthy(meta.requiresInfo) ? (typeof meta.requiresInfo === 'string' ? meta.requiresInfo : 'Présentez le justificatif avec votre billet') : '';

  if (infoText && infoGroup) {
    infoGroup.style.display = '';
    if (infoInput) infoInput.placeholder = infoText;
  }
  if (needField && justifGroup) {
    justifGroup.style.display = '';
    if (justifInput) { justifInput.required = true; justifInput.placeholder = fieldLabel; }
  }

  // En repassant sur NORMAL (no requirements), on efface
  if (!needField && !infoText) {
    if (justifInput) justifInput.value = '';
    if (infoInput)   infoInput.value   = '';
  }
}


/* ---------- Rendu lignes ---------- */
function renderSeatLine(seatId, prefill) {
  const zoneKey = zoneKeyFromSeatId(seatId);
  const tariffs = tariffsForZone(zoneKey);
  const row = document.createElement('div');
  row.className = 'seat-line';
  row.dataset.seatId = seatId;

row.innerHTML = `
  <div class="form-group">
    <input type="checkbox" class="seat-check" data-seat-id="${seatId}" checked>
  </div>
  <div class="seat-id">${seatId}</div>
  <div class="form-group">
    <label>Nom (titulaire)</label>
    <input type="text" class="holder-last" placeholder="Nom" value="${(prefill?.lastName || '').replace(/"/g,'&quot;')}">
  </div>
  <div class="form-group">
    <label>Prénom (titulaire)</label>
    <input type="text" class="holder-first" placeholder="Prénom" value="${(prefill?.firstName || '').replace(/"/g,'&quot;')}">
  </div>
  <div class="form-group tariff-wrap">
    <label>Tarif</label>
    <select class="tariff-select"></select>
  </div>

  <!-- Ligne supplémentaire, sous les trois colonnes de droite -->
  <div class="extras-row">
    <div class="justif-group"><input type="text" class="justif-input" placeholder=""></div>
    <div class="info-group"><input type="text" class="info-input"  placeholder="Présentez le justificatif avec votre billet (facultatif)"></div>
  </div>
`;

  const $sel = row.querySelector('.tariff-select');

  // 🔧 construire les options "Libellé (12,00 €)" selon la zone
$sel.innerHTML = tariffs.map(code => {
  const t = CTX.tariffs.find(t => String(t.code||'').toUpperCase() === code);
  const label = t?.label || code;              // <-- label (PAS name)
  const price = priceFor(zoneKey, code);
  return `<option value="${code}">${label} (${formatEuro(price)})</option>`;
}).join('');

  // Choix par défaut
  const def = tariffs.includes('NORMAL') ? 'NORMAL' : (tariffs[0]||'');
  $sel.value = def;
  updateConditionalFields(row, $sel.value);
  updateLineTotal(row);

  // events
  row.querySelector('.seat-check').addEventListener('change', () => {
    const enabled = row.querySelector('.seat-check').checked;
    row.querySelectorAll('input, select').forEach(el => {
      if (!el.classList.contains('seat-check')) el.disabled = !enabled;
    });
    updateSelectedHighlights(getSelectedSeatIdsFromForm());
    recalcTotal();
  });
  $sel.addEventListener('change', () => {
    updateConditionalFields(row, $sel.value);
    updateLineTotal(row);
    recalcTotal();
  });

  $seatsList.appendChild(row);
}

function updateLineTotal(row) {
  const sid = row.dataset.seatId;
  const zone = zoneKeyFromSeatId(sid);
  const tariff = row.querySelector('.tariff-select')?.value || '';
  const v = priceFor(zone, tariff);
  //const box = row.querySelector('.line-total');
  //if (box) box.textContent = formatEuro(v);
}

function recalcTotal() {
  let sum = 0;
  document.querySelectorAll('.seat-line').forEach(row => {
    const on = row.querySelector('.seat-check')?.checked;
    if (!on) return;
    const sid = row.dataset.seatId;
    const zone = zoneKeyFromSeatId(sid);
    const tariff = row.querySelector('.tariff-select')?.value || '';
    sum += priceFor(zone, tariff);
  });
  $totalBox.textContent = formatEuro(sum);
  const n = Number($paySchedule.value||1);
  $schedulePrev.textContent = euroSplit(sum, n);
}

/* ---------- Chargement des données & plan ---------- */
async function loadData() {
  const apiUrl = 's/renew' + (location.search||'');
  const res = await fetch(apiUrl, { headers: { 'Accept':'application/json' }, credentials:'same-origin' });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const data = await res.json();

  // Contexte
  CTX.seasonCode = data.seasonCode || data.season;
  CTX.venueSlug  = data.venueSlug  || data.venue;
  CTX.tokenSeats = data.tokenSeats || [];
  CTX.tariffs    = data.tariffs    || [];
  CTX.prices     = data.prices     || [];
  CTX.pricesIdx  = buildPricesIndex(CTX.prices);
  (data.seats||[]).forEach(s => CTX.seatsById.set(String(s.seatId), s));

  // payer
  if (data.payer) {
    $payerFirst.value = data.payer.firstName || '';
    $payerLast.value  = data.payer.lastName  || '';
    $payerEmail.value = data.payer.email     || '';
  }

  // Rendu des lignes (cochées par défaut)
  $seatsList.innerHTML = '';
  for (const sid of CTX.tokenSeats) {
    renderSeatLine(sid, data.seatSubscribers?.[sid]);
  }

  // Plan SVG
  const svgPath = `public/venues/${CTX.venueSlug}/plan.svg`;
  $plan.data = svgPath;
  $plan.addEventListener('load', () => {
    const doc = $plan.contentDocument;
    if (!doc) return;
    CTX.svg = doc.querySelector('svg');
    if (!CTX.svg) return;

    svgInjectSeatStyle(doc);
    svgInitViewBox();

    // Interactions
    doc.addEventListener('wheel', svgOnWheel, { passive:false });
    doc.addEventListener('mousedown', svgOnDown);
    doc.addEventListener('mousemove', svgOnMove);
    doc.addEventListener('mouseup', svgOnUp);
    doc.addEventListener('mouseleave', svgOnUp);

    // Click pour (dé)cocher
    doc.addEventListener('click', (e) => {
      const target = e.target.closest('[data-seat-id]');
      if (!target) return;
      const sid = target.getAttribute('data-seat-id');
      const cb = document.querySelector(`.seat-line input.seat-check[data-seat-id="${CSS_ESCAPE(sid)}"]`);
      if (cb) {
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change', { bubbles:true }));
      }
    });

    // Highlight
    markAllowedSeats(CTX.tokenSeats);
    updateSelectedHighlights(getSelectedSeatIdsFromForm());

    $planStatus.textContent = 'Plan prêt';
  }, { once:true });

  recalcTotal();
}

/* ---------- Paiement ---------- */
async function doPay() {
  try {
    const items = [];
    document.querySelectorAll('.seat-line').forEach(row => {
      const checked = row.querySelector('.seat-check')?.checked;
      if (!checked) return;
      const seatId = row.dataset.seatId;
      const zoneKey = zoneKeyFromSeatId(seatId);
      const tariffCode = row.querySelector('.tariff-select')?.value || '';
      const firstName = row.querySelector('.holder-first')?.value || '';
      const lastName  = row.querySelector('.holder-last')?.value || '';
      const justification = row.querySelector('.justif-input')?.value || '';
      const info = row.querySelector('.info-input')?.value || '';
      items.push({ seatId, zoneKey, tariffCode, firstName, lastName, justification, info });
    });
    if (!items.length) return alert('Veuillez sélectionner au moins une place.');
    if (!$payerEmail.value) return alert('Veuillez saisir un email de contact.');

    $payBtn.disabled = true;
    const res = await fetch('s/renew' + (location.search||''), {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Accept':'application/json' },
      body: JSON.stringify({
        items,
        payer:{ firstName:$payerFirst.value||'', lastName:$payerLast.value||'', email:$payerEmail.value||'' },
        schedule: Number($paySchedule.value||1)
      })
    });
    const data = await res.json().catch(()=> ({}));
    if (!res.ok) {
      console.error('pay error', res.status, data);
      alert(`Erreur serveur (${res.status}) : ${JSON.stringify(data)}`);
      $payBtn.disabled = false; return;
    }
    if (data.redirectUrl) location.assign(data.redirectUrl);
    else { alert('Réponse inattendue.'); $payBtn.disabled=false; }
  } catch (e) {
    console.error('pay catch:', e);
    alert('Erreur : '+e.message);
    $payBtn.disabled = false;
  }
}

/* ---------- Bind global ---------- */
$paySchedule.addEventListener('change', recalcTotal);
$payBtn.addEventListener('click', doPay);

// Update highlight si (dé)cochage dans la liste
document.addEventListener('change', (e) => {
  if (e.target && e.target.matches('.seat-line input.seat-check')) {
    updateSelectedHighlights(getSelectedSeatIdsFromForm());
  }
});
document.addEventListener('change', (e) => {
  if (e.target && e.target.matches('.tariff-select')) recalcTotal();
});

/* ---------- Boot ---------- */
loadData().catch(err => {
  console.error('load error:', err);
  $planStatus.textContent = 'Impossible de charger les données. Vérifiez votre lien.';
});
