// ===== Helpers =====
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
const fmtEuro = c => (Number(c||0)/100).toFixed(2).replace('.', ',') + ' €';
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

// BasePath: /bts en INT/PROD, vide en DEV
function getBase() {
  const m = location.pathname.match(/^(.*)\/tbh7(?:\/|$)/);
  return m ? m[1] : '';
}
const BASE = getBase();
const API_STATUS   = `${BASE}/api/tbh7/status`;
const API_CHECKOUT = `${BASE}/api/tbh7/checkout`;

const CTX = {
  seasonCode: null,
  zones: [],
  tariffsByZone: {},               // { [zoneKey]: { [code]: {amountCents,label,requiresField,fieldLabel,requiresInfo} } }
  svg: { el: null, viewBox: null, minScale: 0.25, maxScale: 6 },
  totalCents: 0
};

document.addEventListener('DOMContentLoaded', () => {
  bindUI();
  loadStatus().catch(err => showMsg(err.message));
});

function bindUI() {
  $('#zoneSelect').addEventListener('change', onZoneChange);
  $('#btnAdd').addEventListener('click', (e)=>{ e.preventDefault(); addRow(); });
  $('#btnRemove').addEventListener('click', (e)=>{ e.preventDefault(); removeRow(); });
  $('#btnZoomIn').addEventListener('click', ()=> zoomAtCenter(1.2));
  $('#btnZoomOut').addEventListener('click', ()=> zoomAtCenter(1/1.2));
  $('#btnReset').addEventListener('click', resetView);
  $('#installments').addEventListener('change', updateSplitInfo);  // maj info échéancier
  $('#payBtn').addEventListener('click', (e)=>{ e.preventDefault(); checkout().catch(err => showMsg(err.message)); });
}

function showMsg(txt) { $('#msg').textContent = txt || ''; }

// ===== Status / data =====
async function loadStatus() {
  const y = new Date().getFullYear();
  const season = `${y}-${y+1}`;
  const res = await fetch(`${API_STATUS}?season=${encodeURIComponent(season)}`, { headers: { 'Accept': 'application/json' }});
  if (!res.ok) throw new Error(`Status ${res.status}`);
  const j = await res.json();

  CTX.seasonCode = j.seasonCode || season;
  CTX.zones = Array.isArray(j.zones) ? j.zones : [];

  // Tariffs meta by zone (enrichi comme renew)
  CTX.tariffsByZone = {};
  for (const z of CTX.zones) {
    const map = {};
    for (const p of (z.prices || [])) {
      map[p.code] = {
        amountCents: Number(p.amountCents || 0),
        label: p.label || p.code,
        requiresField: !!p.requiresField,
        fieldLabel: p.fieldLabel || null,
        requiresInfo: p.requiresInfo || null
      };
    }
    CTX.tariffsByZone[z.zoneKey] = map;
  }

  // UI zones
  const $zone = $('#zoneSelect');
  $zone.innerHTML = '';
  CTX.zones.forEach(z => {
    const opt = document.createElement('option');
    opt.value = z.zoneKey;
    opt.textContent = z.name || z.zoneKey;
    $zone.appendChild(opt);
  });

  // Table: 1 ligne par défaut
  $('#rows').innerHTML = '';
  addRow();

  // Plan SVG
  const planUrl = `${BASE}/static/venues/patinoire-blagnac/plan.svg`;
  const obj = $('#venuePlan');
  obj.setAttribute('data', planUrl);
  obj.addEventListener('load', () => {
    const svgDoc = obj.contentDocument;
    const svg = svgDoc && svgDoc.documentElement;
    if (!svg) return;

    CTX.svg.el = svg;
    ensureViewBox(svg);
    resetView();

    bindPanZoom(svg);
    bindZonesOnPlan(svg, CTX.zones);
    onZoneChange(); // highlight initial
  }, { once: true });
}

// ===== Table personnes =====
function addRow() {
  const $tbody = $('#rows');
  const idx = ($tbody.querySelectorAll('tr.row').length) + 1;

  const tr = document.createElement('tr');
  tr.className = 'row';
  tr.innerHTML = `
    <td class="muted">${idx}</td>
    <td><input class="fn" type="text" placeholder="Prénom" /></td>
    <td><input class="ln" type="text" placeholder="Nom" /></td>
    <td><select class="tariff"></select></td>
  `;
  $tbody.appendChild(tr);

  const details = document.createElement('tr');
  details.className = 'row-details hidden';
  details.innerHTML = `<td></td><td colspan="3"><div class="detail-wrap"></div></td>`;
  $tbody.appendChild(details);

  fillTariffsForRow(tr);
  tr.querySelector('.tariff').addEventListener('change', () => { ensureDetailsForRow(tr, details); updateTotals(); });
  ensureDetailsForRow(tr, details);
  updateTotals();
}

function removeRow() {
  const $tbody = $('#rows');
  const rows = $tbody.querySelectorAll('tr.row');
  if (rows.length <= 1) return;
  // supprime la paire (details + row)
  $tbody.removeChild($tbody.lastElementChild);
  $tbody.removeChild($tbody.lastElementChild);
  // reindex
  $$('#rows tr.row').forEach((tr,i)=> tr.querySelector('td').textContent = String(i+1));
  updateTotals();
}

function fillTariffsForRow(tr) {
  const zkey = $('#zoneSelect').value;
  const map = CTX.tariffsByZone[zkey] || {};
  const $sel = tr.querySelector('select.tariff');
  $sel.innerHTML = '';
  Object.entries(map).forEach(([code, meta]) => {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = `${meta.label} — ${fmtEuro(meta.amountCents)}`;
    $sel.appendChild(opt);
  });
}

function ensureDetailsForRow(tr, detailsTr) {
  const zkey = $('#zoneSelect').value;
  const code = tr.querySelector('.tariff').value;
  const meta = CTX.tariffsByZone[zkey]?.[code] || {};
  const wrap = detailsTr.querySelector('.detail-wrap');
  wrap.innerHTML = '';

  const parts = [];
  if (meta.requiresField) {
    parts.push(`
      <label class="justif">
        ${meta.fieldLabel || 'Justificatif'} :
        <input class="fieldValue" type="text" placeholder="${meta.fieldLabel || 'ex: numéro étudiant'}" />
      </label>
    `);
  }
  if (meta.requiresInfo) {
    parts.push(`<p class="info muted">${meta.requiresInfo}</p>`);
  }

  if (parts.length) {
    detailsTr.classList.remove('hidden');
    wrap.innerHTML = parts.join('');
  } else {
    detailsTr.classList.add('hidden');
  }
}

function updateTotals() {
  const zkey = $('#zoneSelect').value;
  const map = CTX.tariffsByZone[zkey] || {};
  let total = 0;
  $$('#rows tr.row').forEach(tr => {
    const code = tr.querySelector('.tariff').value;
    const unit = map[code]?.amountCents || 0;
    total += unit;
  });
  CTX.totalCents = total;
  $('#totalEuro').textContent = fmtEuro(total);
  updateSplitInfo();
}

function onZoneChange() {
  const rows = $$('#rows tr.row');
  const details = $$('#rows tr.row-details');
  rows.forEach((tr, i) => { fillTariffsForRow(tr); ensureDetailsForRow(tr, details[i]); });
  updateTotals();
  highlightZoneOnPlan($('#zoneSelect').value);
}

// ===== Paiement / échéancier =====
function splitInstallments(totalCents, n) {
  n = Math.max(1, Number(n||1));
  const base = Math.floor(totalCents / n);
  const rem  = totalCents % n;
  const arr = Array(n).fill(base);
  for (let i=0; i<rem; i++) arr[i] += 1;
  return arr;
}

function updateSplitInfo() {
  const n = Math.max(1, Number($('#installments').value || 1));
  if (!Number.isFinite(CTX.totalCents) || CTX.totalCents <= 0) {
    $('#splitInfo').textContent = '';
    return;
  }
  if (n === 1) {
    $('#splitInfo').textContent = '';
    return;
  }
  const arr = splitInstallments(CTX.totalCents, n);
  const per = arr.map(c => fmtEuro(c)).join(' + ');
  $('#splitInfo').textContent = `${n} échéances : ${per} = ${fmtEuro(CTX.totalCents)}`;
}

async function checkout() {
  showMsg('Préparation du paiement…');

  const payer = {
    firstName: $('#payerFirstName').value.trim(),
    lastName:  $('#payerLastName').value.trim(),
    email:     $('#payerEmail').value.trim()
  };
  if (!payer.firstName || !payer.lastName || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(payer.email)) {
    showMsg('Renseignez le contact (prénom, nom, email valide).');
    return;
  }

  const zkey = $('#zoneSelect').value;

  const persons = $$('#rows tr.row').map((tr, i) => {
    const detailsTr = $$('#rows tr.row-details')[i];
    const fieldInput = detailsTr?.querySelector('.fieldValue');
    return {
      firstName: tr.querySelector('.fn').value.trim(),
      lastName:  tr.querySelector('.ln').value.trim(),
      tariffCode: tr.querySelector('.tariff').value,
      fieldValue: fieldInput ? fieldInput.value.trim() : null
    };
  });

  if (persons.some(p => !p.firstName || !p.lastName)) {
    showMsg('Chaque abonné doit avoir un prénom et un nom.');
    return;
  }

  // agrège par tarif
  const byTariff = new Map();
  persons.forEach(p => byTariff.set(p.tariffCode, (byTariff.get(p.tariffCode)||0) + 1));
  const items = [...byTariff.entries()].map(([tariffCode, qty]) => ({ zoneKey: zkey, tariffCode, qty }));

  const body = {
    seasonCode: CTX.seasonCode,
    campaignCode: `TBH7-${new Date().getFullYear()}`,
    payer,
    paymentSplit: Number($('#installments').value || 1),
    items,
    persons: persons.map(p => ({ ...p, zoneKey: zkey }))
  };

  const res = await fetch(API_CHECKOUT, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const t = await res.text().catch(()=>`${res.status}`);
    showMsg(`Erreur: ${t}`);
    return;
  }
  const j = await res.json();
  const url = j.redirectUrl || j.checkoutUrl;
  if (!url) { showMsg('Pas de redirectUrl renvoyée.'); return; }
  location.href = url;
}

// ===== Plan : pan/zoom + zones =====
function ensureViewBox(svg) {
  if (!svg.getAttribute('viewBox')) {
    const w = Number(svg.getAttribute('width') || 1200);
    const h = Number(svg.getAttribute('height') || 800);
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  }
  const vb = svg.getAttribute('viewBox').split(/\s+/).map(Number);
  CTX.svg.viewBox = { x: vb[0], y: vb[1], w: vb[2], h: vb[3], baseW: vb[2], baseH: vb[3] };
}

function setViewBox(svg, x, y, w, h) {
  const baseW = CTX.svg.viewBox.baseW;
  const baseH = CTX.svg.viewBox.baseH;
  const maxX = Math.max(baseW - w, 0);
  const maxY = Math.max(baseH - h, 0);
  const nx = clamp(x, 0, maxX);
  const ny = clamp(y, 0, maxY);
  svg.setAttribute('viewBox', `${nx} ${ny} ${w} ${h}`);
  CTX.svg.viewBox = { ...CTX.svg.viewBox, x: nx, y: ny, w, h };
}

function clientToSvg(svg, clientX, clientY) {
  const pt = svg.createSVGPoint();
  pt.x = clientX; pt.y = clientY;
  const ctm = svg.getScreenCTM().inverse();
  return pt.matrixTransform(ctm);
}

function zoomAt(svg, factor, clientX, clientY) {
  const vb = CTX.svg.viewBox;
  // borne largeur/hauteur
  let newW = vb.w / factor;
  let newH = vb.h / factor;
  const minW = vb.baseW / CTX.svg.maxScale;
  const maxW = vb.baseW / CTX.svg.minScale;
  newW = Math.min(Math.max(newW, minW), maxW);
  newH = Math.min(Math.max(newH, minW * (vb.baseH/vb.baseW)), maxW * (vb.baseH/vb.baseW));

  // centre sur le pointeur
  const p = clientToSvg(svg, clientX, clientY);
  const relX = (p.x - vb.x) / vb.w;
  const relY = (p.y - vb.y) / vb.h;
  const nx = p.x - relX * newW;
  const ny = p.y - relY * newH;

  setViewBox(svg, nx, ny, newW, newH);
}

function zoomAtCenter(factor) {
  const svg = CTX.svg.el;
  if (!svg) return;
  const rect = svg.getBoundingClientRect();
  zoomAt(svg, factor, rect.left + rect.width/2, rect.top + rect.height/2);
}

function resetView() {
  const svg = CTX.svg.el;
  if (!svg) return;
  setViewBox(svg, 0, 0, CTX.svg.viewBox.baseW, CTX.svg.viewBox.baseH);
}

function bindPanZoom(svg) {
  // Molette = zoom (centré curseur)
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1/1.15;
    zoomAt(svg, factor, e.clientX, e.clientY);
  }, { passive: false });

  // Drag = pan (calcul en pixels -> coordonnées viewBox)
  let dragging = false;
  let startClient = null;
  let startVB = null;

  svg.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startClient = { x: e.clientX, y: e.clientY };
    startVB = { ...CTX.svg.viewBox };
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = svg.getBoundingClientRect();
    const scaleX = startVB.w / rect.width;
    const scaleY = startVB.h / rect.height;
    const dx = (e.clientX - startClient.x) * scaleX;
    const dy = (e.clientY - startClient.y) * scaleY;
    setViewBox(svg, startVB.x - dx, startVB.y - dy, startVB.w, startVB.h);
  });

  window.addEventListener('mouseup', () => { dragging = false; });
}

function bindZonesOnPlan(svg, zones) {
  zones.forEach(z => {
    let el = z.svgSelector ? svg.querySelector(z.svgSelector) : null;
    if (!el) el = svg.querySelector(`[data-zone-key="${z.zoneKey}"]`);
    if (!el) el = svg.getElementById(z.zoneKey);
    if (!el) return;

    el.style.cursor = 'pointer';
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'button');
    el.dataset.zoneKey = z.zoneKey;

    const hover = on => el.classList.toggle('zone-hover', !!on);
    el.addEventListener('mouseenter', ()=> hover(true));
    el.addEventListener('mouseleave', ()=> hover(false));
    el.addEventListener('click', () => { $('#zoneSelect').value = z.zoneKey; onZoneChange(); });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#zoneSelect').value = z.zoneKey; onZoneChange(); }
    });
  });
}

function highlightZoneOnPlan(zoneKey) {
  const svg = CTX.svg.el;
  if (!svg) return;
  $$('.zone-selected', svg).forEach(el => el.classList.remove('zone-selected'));
  const zone = CTX.zones.find(z => z.zoneKey === zoneKey);
  if (!zone) return;
  let el = zone.svgSelector ? svg.querySelector(zone.svgSelector) : null;
  if (!el) el = svg.querySelector(`[data-zone-key="${zone.zoneKey}"]`);
  if (!el) el = svg.getElementById(zone.zoneKey);
  if (el) el.classList.add('zone-selected');
}
