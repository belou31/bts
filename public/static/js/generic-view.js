// static/js/generic-view.js

/* ========= Util DOM ========= */
const $  = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

/* ========= Contexte / Config ========= */
const CONFIG = (window.BTS_VIEW_CONFIG || {
  title: 'Billetterie',
  api: { status: 's/renew'+(location.search||''), checkout: 's/renew'+(location.search||'') },
  selection: { type: 'seats' } // seats | zones
});
const PAGE_TITLE = CONFIG.pageTitle || CONFIG.title || 'Billetterie';
document.title = PAGE_TITLE + ' — BTS';

/* ========= Hooks & API ========= */
const HOOKS = { afterData: [], planReady: [], cartChanged: [] };
function onHook(name, fn) { (HOOKS[name] || (HOOKS[name] = [])).push(fn); }
async function emitHook(name, payload) {
  for (const fn of (HOOKS[name] || [])) { try { await fn(payload); } catch(e){ console.warn('[BTS hook]', name, e); } }
}

/* API exposée aux vues spécifiques (TBH7, public, renew…) */
window.BTS_VIEW = {
  on: onHook,
  api: {
    addRowForSeat(seatLike) {
      const $rows = document.querySelector('#cartRows');
      const row = makeRowForSeat(seatLike);
      $rows.appendChild(row);
      updateTotals(); updateInstallmentsPreview(); syncSelectedHighlights();
      emitHook('cartChanged', { ctx: CTX });
      return row;
    },
    getCTX: () => CTX,
    getData: () => CTX.raw || null,
    findSeatElement,
    setSeatState,
    addSeatClass,
    removeSeatClass,
    recomputeTotals() {
      updateTotals(); updateInstallmentsPreview(); syncSelectedHighlights();
      emitHook('cartChanged', { ctx: CTX });
    }
  },
  setFeedback: null,
  collectCheckoutPayload: null,
  submitPayment: null
};


// Classes SVG utilisées (tu peux les surcharger via window.BTS_VIEW_CONFIG.svgSeatClasses)
const ASSET_BASE = (() => {
  const raw = CONFIG.assetsBase || CONFIG.assetBase || CONFIG.assetPrefix || 'dynamic/';
  if (!raw) return 'dynamic/';
  return raw.endsWith('/') ? raw : `${raw}/`;
})();

const CLASSES = Object.assign({
  allowed:   'seat-allowed',    // sièges "autorisés" par le token (highlight doux)
  selected:  'seat-selected',   // sièges présents dans le panier
  booked:    'seat-booked',     // déjà vendus
  busy:      'seat-busy',       // provisionnés / bloqués
  available: 'seat-available'   // disponible par défaut
}, (CONFIG.svgSeatClasses || {}));

// Debug flag: ?debug=1 ou BTS_VIEW_CONFIG.debug = true
const DEBUG = (CONFIG.debug === true) || (new URLSearchParams(location.search).get('debug') === '1');
const dlog = (...args) => { if (DEBUG) console.debug('[BTS]', ...args); };

// Expose pour inspection console
window.BTS_DEBUG = {
  get CTX(){ return CTX; },
  get CONFIG(){ return CONFIG; },
};


/* ========= Etat ========= */
const CTX = {
  seasonCode:null, venueSlug:null,
  tariffs:[], prices:[], seats:[], tokenSeats:[],
  seatSubscribers:{}, payer:{ firstName:'', lastName:'', email:'' },
  pricesIdx:null, tariffMap:new Map(),
  currentTotal:0,
  svgDoc:null,
  seatSubById:new Map()   // <- NEW: index normalisé seatId -> {firstName,lastName,email}  
};

// Index rapide: seatId -> status
let SEAT_STATUS = new Map();

// Normalisation des états venant de l’API
function mapSeatState(st) {
  const v = String(st || '').trim().toLowerCase();
  if (!v) return 'available';                 // ⬅️ défaut à "available"
  if (v === 'free' || v === 'open') return 'available';
  if (v === 'sold') return 'booked';
  if (v === 'blocked' || v === 'provisioned' || v === 'hold' || v === 'held') return 'busy';
  return v; // 'available' | 'booked' | 'busy' | autres valeurs déjà normalisées
}

/* ========= Helpers prix/sièges ========= */
const fmtEuro = cents => (Number(cents||0)/100).toLocaleString('fr-FR', { style:'currency', currency:'EUR' });
const normSeatId = s => String(s||'').trim();
const zoneKeyFromSeatId = seatId => String(seatId||'').split('-')[0] || '';

// --- Helpers siège (parsing voisinage) ---
function parseSeatId(sid){
  const m = String(sid||'').match(/^([^-\s]+)-([A-Za-z]+)-(\d{1,3})$/);
  if (!m) return null;
  return { zone:m[1], row:m[2], num: Number(m[3]), width: m[3].length };
}
function makeSeatId(zone,row,num,width){
  return `${zone}-${row}-${String(num).padStart(width||3,'0')}`;
}

function buildPricesIndex(list) {
  // Map zoneKey -> Map tariffCode -> priceCents
  const idx = new Map();
  for (const p of list || []) {
    const z = p.zoneKey || '*';
    const t = String(p.tariffCode||'').toUpperCase();
    if (!idx.has(z)) idx.set(z, new Map());
    idx.get(z).set(t, Number(p.priceCents)||0);
  }
  return idx;
}
function tariffsForZone(tariffs, pricesIdx, zoneKey) {
  const zMap = pricesIdx.get(zoneKey) || new Map();
  const star = pricesIdx.get('*') || new Map();
  const codes = new Set([...zMap.keys(), ...star.keys()]);
  const list = tariffs.filter(t => codes.has(String(t.code||'').toUpperCase()));
  list.sort((a, b) => {
    const aOrder = Number.isFinite(Number(a?.sortOrder)) ? Number(a.sortOrder) : Number.MAX_SAFE_INTEGER;
    const bOrder = Number.isFinite(Number(b?.sortOrder)) ? Number(b.sortOrder) : Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) return aOrder - bOrder;

    const aCode = String(a?.code || '').toUpperCase();
    const bCode = String(b?.code || '').toUpperCase();
    if (aCode === 'NORMAL' && bCode !== 'NORMAL') return -1;
    if (bCode === 'NORMAL' && aCode !== 'NORMAL') return 1;
    return aCode.localeCompare(bCode, 'fr', { sensitivity: 'base' });
  });
  return list;
}
function computeLineAmount(pricesIdx, zoneKey, tariffCode) {
  const t = String(tariffCode||'').toUpperCase();
  const zMap = pricesIdx.get(zoneKey);
  if (zMap && zMap.has(t)) return zMap.get(t);
  const star = pricesIdx.get('*');
  if (star && star.has(t)) return star.get(t);
  return 0;
}

// ---- NO SINGLE GAP (local, fenêtre ±2, bords tolérés) ----
const isVirtualZoneSeatId = sid => /^.+-Z\d{3,}$/i.test(String(sid||''));

function seatDisplayLabel(seatLike, seatId, zoneKey) {
  // 1) si le front a fourni label (ex: "Debout"), on prend ça
  if (seatLike?.label) return String(seatLike.label);
  // 2) si c’est un ID virtuel “zone”, on affiche la zone (ex: "DEBOUT")
  if (isVirtualZoneSeatId(seatId)) return String(zoneKey||'') || seatId;
  // 3) sinon, on garde l’ID siège
  return seatId;
}


function buildSelectedSet(items){
  const set = new Set();
  for (const it of (items||[])) {
    const sid = String(it?.seatId||'').trim();
    if (!sid || isVirtualZoneSeatId(sid)) continue;
    if (!parseSeatId(sid)) continue; // ignore formats non standards
    set.add(sid);
  }
  return set;
}
function statusOf(sid){
  return (SEAT_STATUS.get(sid) || '').toLowerCase();
}
function isOccupied(sid, selectedSet){
  if (!sid) return false;
  if (selectedSet?.has(sid)) return true;                  // la sélection actuelle “occupe”
  const st = statusOf(sid);
  return st==='booked' || st==='sold' || st==='busy' || st==='blocked' || st==='provisioned';
}
function isAvailableSeat(sid, selectedSet){
  if (!sid) return false;
  if (selectedSet?.has(sid)) return false;                 // déjà pris par la sélection
  const st = statusOf(sid);
  return st === 'available' || st === '';                  // tolère l'ancien cas vide (ceinture+bretelles)
}

// Compte le nb de places "libres" contiguës jusqu'à 2 de part et d'autre,
// en considérant le BORD de tribune comme ">=2 libres" pour ne JAMAIS bloquer.
function countAvailSide(zone,row,startNum,width,dir,sel){
  // dir = -1 (gauche) → on part de startNum-1 ; dir = +1 (droite) → startNum+1
  let count = 0;
  for (let step = 1; step <= 2; step++) {
    const n = startNum + dir*step;
    const sid = makeSeatId(zone,row,n,width);
    if (!SEAT_STATUS.has(sid)) {
      // au bord de la tribune : on considère comme ">= 2" pour éviter tout blocage
      return 2;
    }
    if (isAvailableSeat(sid, sel)) {
      count++;
    } else {
      break;
    }
  }
  return count; // 0, 1 ou 2 (2 = "au moins 2")
}


function checkLocalNoSingleGap(items){
  const sel = buildSelectedSet(items);
  if (!sel.size) return null;

  for (const sid of sel) {
    const p = parseSeatId(sid); if (!p) continue;

    // On ne traite que le siège "bord gauche" d'un bloc sélectionné pour éviter les doublons
    const L1 = makeSeatId(p.zone,p.row,p.num-1,p.width);
    if (sel.has(L1)) continue; // pas le bord gauche du bloc → on passe

    // Trouver l’extrémité droite du bloc (bord droit)
    let rightNum = p.num;
    while (sel.has(makeSeatId(p.zone,p.row,rightNum+1,p.width))) rightNum++;
    const leftNum = p.num; // on est bien le bord gauche du bloc

    const blockLen = (rightNum - leftNum + 1);

    // Comptes de libres contigus à gauche/droite (bornés à 2 ; bord = 2)
    const leftAvail  = countAvailSide(p.zone,p.row,leftNum, p.width, -1, sel);
    const rightAvail = countAvailSide(p.zone,p.row,rightNum,p.width, +1, sel);
if (DEBUG) dlog('gapCheck', { row:p.row, zone:p.zone, blockLen, leftAvail, rightAvail, leftNum, rightNum });
    // Règle (STRICT) :
    //  - bloc = 1  → interdit si left==1 ou right==1
    //  - bloc ≥ 2  → interdit si left==1 OU right==1  (même un seul côté)
    if (blockLen <= 1) {
      if (leftAvail === 1)  return { zone:p.zone, row:p.row, side:'left',  seat:sid };
      if (rightAvail === 1) return { zone:p.zone, row:p.row, side:'right', seat:sid };
    } else {
      if (leftAvail === 1 && rightAvail === 1) return { zone:p.zone, row:p.row, side:'both',  seat:sid };
      if (leftAvail === 1 && rightAvail > 0)   return { zone:p.zone, row:p.row, side:'left',  seat:sid };
      if (rightAvail === 1 && leftAvail > 0)    return { zone:p.zone, row:p.row, side:'right', seat:sid };
    }

  }
  return null;
}

const STATE_CLASSES = new Set([CLASSES.available, CLASSES.booked, CLASSES.busy]);

function seatEl(sid) { return findSeatElement(sid); }

function clearStateClasses(el) {
  for (const c of STATE_CLASSES) el.classList.remove(c);
}

function setSeatState(sid, state) {
  const el = seatEl(sid);
  if (!el) return false;
  clearStateClasses(el);
  // état principal
  const st = String(state || '').toLowerCase();
  if (st === 'booked' || st === 'sold') {
    el.classList.add(CLASSES.booked);
  } else if (st === 'busy' || st === 'provisioned' || st === 'blocked') {
    el.classList.add(CLASSES.busy);
  } else {
    el.classList.add(CLASSES.available);
  }
  return true;
}

function addSeatClass(sid, cls) {
  const el = seatEl(sid); if (!el) return false;
  el.classList.add(cls); return true;
}
function removeSeatClass(sid, cls) {
  const el = seatEl(sid); if (!el) return false;
  el.classList.remove(cls); return true;
}


/* ========= Extras tarifaires (schéma strict) ========= */
 function extrasFromTariffCode(code) {
  const codeUp = String(code||'').toUpperCase();
  if (codeUp === 'NORMAL') return { needsJustif:false, fieldLabel:'', infoText:'' };
  const t = CTX.tariffMap.get(codeUp) || {};
  // STRICT: uniquement true booléen ou chaîne "true"
  const rf = t?.requiresField;
  const needsJustif = (rf === true) || (String(rf).toLowerCase() === 'true');

   const fieldLabel  = String(t?.fieldLabel || '').trim();
   const infoText    = String(t?.requiresInfo || '').trim();
   return { needsJustif, fieldLabel, infoText };
}


/* ========= PLAN (zoom/pan/highlight) ========= */
function onPlanReady($obj) {
  const doc = $obj.contentDocument;
  const svg = doc?.querySelector('svg');
  if (!svg) { console.warn('SVG not found'); return; }
  CTX.svgDoc = doc;

  // wrapper pan/zoom
  let host = svg.querySelector('#zoomHost');
  if (!host) {
    host = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
    host.setAttribute('id','zoomHost');
    while (svg.firstChild) host.appendChild(svg.firstChild);
    svg.appendChild(host);
  }

  // ⬅️ NEW: empêcher les <text> / labels SVG de capter les clics (laisser passer vers les zones)
  try {
    const style = doc.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = `
      text, .zone-label, .seat-label, [data-label] { pointer-events: none; }
    `;
    svg.insertBefore(style, svg.firstChild);
  } catch (e) { /* no-op */ }

  let scale = 1, tx = 0, ty = 0;
  let dragging = false, last = {x:0, y:0};
  const apply = () => host.setAttribute('transform', `translate(${tx},${ty}) scale(${scale})`);
  const svgPoint = (evt) => {
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX; pt.y = evt.clientY;
    const m = svg.getScreenCTM().inverse();
    return pt.matrixTransform(m);
  };

  svg.addEventListener('wheel', (evt) => {
    evt.preventDefault();
    const delta = -(evt.deltaY || evt.wheelDelta || 0);
    const factor = Math.exp(delta * 0.0015);
    const p = svgPoint(evt);
    const newScale = Math.min(10, Math.max(0.25, scale * factor));
    const k = newScale / scale;
    tx = p.x - (p.x - tx) * k;
    ty = p.y - (p.y - ty) * k;
    scale = newScale; apply();
  }, { passive:false });

  const onDown = (evt) => { dragging = true; $('#venuePlan').classList.add('grabbing'); last = svgPoint(evt); };
  const onMove = (evt) => { if (!dragging) return; const p = svgPoint(evt); tx += (p.x-last.x); ty += (p.y-last.y); last = p; apply(); };
  const onUp   = () => { dragging = false; $('#venuePlan').classList.remove('grabbing'); };

  svg.addEventListener('mousedown', onDown);
  svg.addEventListener('mousemove', onMove);
  svg.addEventListener('mouseup', onUp);
  svg.addEventListener('mouseleave', onUp);

  // États initiaux
  if (Array.isArray(CTX.seats) && CTX.seats.length) {
    for (const s of CTX.seats) setSeatState(s.seatId, s.status);
  } else if (Array.isArray(CTX.tokenSeats)) {
    for (const sid of CTX.tokenSeats) setSeatState(sid, 'available');
  }

  // sièges autorisés (overlay doux)
  if (Array.isArray(CTX.tokenSeats)) {
    for (const sid of CTX.tokenSeats) addSeatClass(sid, CLASSES.allowed);
  }

  // sélection courante
  syncSelectedHighlights();
  emitHook('planReady', { ctx: CTX, svgDoc: CTX.svgDoc });
}


function findSeatElement(sid) {
  const doc = CTX.svgDoc;
  if (!doc) return null;
  const escapedId = sid.replace(/([\\.])/g, '\\$1');
  const queries = [
    `[data-seat-id="${sid}"]`,
    `[data-seat="${sid}"]`,
    `#${escapedId}`,
    `#seat_${escapedId}`
  ];
  for (const sel of queries) {
    const el = doc.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function syncSelectedHighlights() {
  const doc = CTX.svgDoc;
  if (!doc) return;

  // purge la classe "selected" actuelle
 doc.querySelectorAll('.' + CLASSES.selected.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'))
    .forEach(el => el.classList.remove(CLASSES.selected));

  // ajoute pour chaque ligne du panier
  $$('.cart-row').forEach(row => {
    const sid = row.dataset.seatId || '';
    if (!sid) return;                    // ⬅️ évite querySelector('#')
    addSeatClass(sid, CLASSES.selected);
  });
}

/* ========= LIGNES (cart) ========= */
function applyTariffExtrasOnRow(row) {
  const code = $('.tariff-select', row).value;
  const { needsJustif, fieldLabel, infoText } = extrasFromTariffCode(code);

  const $extra = $('.line-extra-inline', row);
  const $justWrap = $('.extra-justif', $extra);
  const $lab   = $('.extra-label', $extra);
  const $inp   = $('.extra-input', $extra);
  const $sep   = $('.extra-sep', $extra);
  const $info  = $('.extra-info',  $extra);

  // reset
  $lab.textContent = '';
  $inp.value = '';
  $inp.placeholder = '';
  $info.textContent = '';

  let show = false;

  if (needsJustif) {
   $justWrap.hidden = false;
   $justWrap.style.display = 'flex';     // ⬅️ force visible

   const lbl = fieldLabel || 'Justificatif';
    $lab.textContent = lbl;
    $inp.placeholder = lbl;
    show = true;
  } else {
    $justWrap.hidden = true;       // input totalement masqué
    $justWrap.style.display = 'none';     // ⬅️ force caché

    $lab.textContent = '';         // (sécurité)
    $inp.value = '';               // (sécurité)
    $inp.placeholder = '';
  }

  if (infoText) {
    $info.hidden = false;
    $info.textContent = infoText;
    show = true;
  } else {
    $info.hidden = true;
  }

  // séparateur “•” uniquement si les deux blocs sont visibles
  $sep.hidden = !(!$justWrap.hidden && !$info.hidden);
  $sep.style.display = $sep.hidden ? 'none' : '';

  $extra.hidden = !show;
  $extra.style.display = show ? 'flex' : 'none';
}

function makeRowForSeat(seat) {

  const seatId = normSeatId(seat?.seatId || seat?.id || seat?.label || '');
  const z = seat?.zoneKey ? String(seat.zoneKey) : zoneKeyFromSeatId(seatId);
  const seatDisplay = seatDisplayLabel(seat, seatId, z);   // ⬅️ “DEBOUT” plutôt que “DEBOUT-Z001”
    
    // a) abonné lié au siège (index normalisé) ou fallback sur les champs du siège
  const subs = CTX.seatSubById.get(seatId) || {
    firstName: seat?.holderFirstName ?? seat?.firstName ?? '',
    lastName : seat?.holderLastName  ?? seat?.lastName  ?? '',
    email    : seat?.holderEmail     ?? seat?.email     ?? ''
  };
  const list = tariffsForZone(CTX.tariffs, CTX.pricesIdx, z);
  const def  = list.find(t => String(t.code).toUpperCase()==='NORMAL') || list[0] || null;

  const row = document.createElement('div');
  row.className = 'cart-row';
  row.dataset.seatId = seatId;
  row.dataset.zoneKey = z;

  row.innerHTML = `
    <button class="trash" title="Supprimer" aria-label="Supprimer la ligne" type="button">🗑</button>
    <div class="col seat"><span class="seat-label" title="${seatDisplay}">${seatDisplay}</span></div>    <div class="col name"><input type="text" class="holder-last"  placeholder="Nom" value="${subs.lastName || ''}"></div>
    <div class="col name"><input type="text" class="holder-first" placeholder="Prénom" value="${subs.firstName || ''}"></div>
    <div class="col tariff"><select class="tariff-select"></select></div>

    <!-- sous-ligne compacte (visible uniquement si extras requis) -->
    <div class="line-extra-inline" hidden>
      <div class="extra-justif" hidden>
        <span class="extra-label"></span>
        <input type="text" class="extra-input" />
      </div>
      <span class="extra-sep" aria-hidden="true" hidden>•</span>
      <span class="extra-info" hidden></span>
    </div>
  `;

  // Tarifs pour la zone
  const $sel = $('.tariff-select', row);
  for (const t of list) {
    const opt = document.createElement('option');
    opt.value = t.code;
    const price = computeLineAmount(CTX.pricesIdx, z, t.code);
    opt.textContent = `${t.label || t.code} — ${fmtEuro(price)}`;
    $sel.appendChild(opt);
  }
  if (def) $sel.value = def.code;

  // Listeners
  $sel.addEventListener('change', () => { applyTariffExtrasOnRow(row); updateTotals(); updateInstallmentsPreview(); });
  $('.holder-first', row).addEventListener('input', syncPayerMaybe);
  $('.holder-last',  row).addEventListener('input', syncPayerMaybe);
  $('.trash', row).addEventListener('click', () => {
    row.remove();
    updateTotals();
    updateInstallmentsPreview();
    syncSelectedHighlights(); // MAJ plan
   emitHook('cartChanged', { ctx: CTX });
  });

  applyTariffExtrasOnRow(row);
  return row;
}

/* ========= Totaux & échéancier ========= */
function updateTotals() {
  let total = 0;
  $$('.cart-row').forEach(row => {
    const seatId = row.dataset.seatId || '';
    // ⬅️ privilégie la zone portée dans dataset (lignes “zone” incluses)
    const z = row.dataset.zoneKey || zoneKeyFromSeatId(seatId);
    const tariff = $('.tariff-select', row).value;
    total += computeLineAmount(CTX.pricesIdx, z, tariff);
  });
  CTX.currentTotal = total;
  $('#totalBox').textContent = fmtEuro(total);
  $('#payBtn').disabled = (total <= 0);
}

function updateInstallmentsPreview() {
  const scheduleEl = $('#paySchedule');
  const previewEl  = $('#schedulePreview');
  if (!scheduleEl || !previewEl) return;
  const schedule = Number(scheduleEl.value || 1);
  const total = CTX.currentTotal || 0;
  if (schedule <= 1 || total <= 0) {
    previewEl.textContent = '—';
    return;
  }
  const base = Math.floor(total / schedule);
  const parts = Array(schedule).fill(base);
  parts[schedule-1] = total - base*(schedule-1);
  previewEl.textContent = parts.map(p => fmtEuro(p)).join(' + ');
}

function syncPayerMaybe() {
  const pf = $('#payerFirst'), pl = $('#payerLast'), pe = $('#payerEmail');
  if (!pf.value && !pl.value) {
    const firstRow = $('.cart-row');
    if (firstRow) {
      const fn = $('.holder-first', firstRow).value;
      const ln = $('.holder-last',  firstRow).value;
      if (fn) pf.value = fn;
      if (ln) pl.value = ln;
      const sid = firstRow.dataset.seatId;
      const sub = CTX.seatSubById.get(sid);
dlog('syncPayerMaybe from first row:', { sid, sub, before: { pf: pf.value, pl: pl.value, pe: pe.value }});

      if (sub?.email && !pe.value) pe.value = sub.email;
dlog('syncPayerMaybe after:', { pf: pf.value, pl: pl.value, pe: pe.value });
    }
  }
}

function autoFillNames(kind) {
  const selector = kind === 'first' ? '.holder-first' : '.holder-last';
  const inputs = Array.from(document.querySelectorAll(`#cartRows ${selector}`));
  if (!inputs.length) return;

  let sourceValue = '';
  const firstFilled = inputs.find(inp => String(inp.value || '').trim());
  if (firstFilled) {
    sourceValue = String(firstFilled.value || '').trim();
  } else {
    const payer = document.querySelector(kind === 'first' ? '#payerFirst' : '#payerLast');
    sourceValue = String(payer?.value || '').trim();
  }
  if (!sourceValue) return;

  inputs.forEach(inp => {
    if (!String(inp.value || '').trim()) {
      inp.value = sourceValue;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}

function attachNameAutofillButtons() {
  const head = document.querySelector('.lines-head');
  if (!head) return;
  const makeBtn = (kind) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'auto-fill-btn';
    btn.textContent = '↳';
    btn.title = kind === 'first'
      ? 'Copier ce prénom sur toutes les lignes vides'
      : 'Copier ce nom sur toutes les lignes vides';
    btn.addEventListener('click', () => autoFillNames(kind));
    return btn;
  };

  Array.from(head.children).forEach(div => {
    const label = String(div.textContent || '').trim().toLowerCase();
    if (label === 'nom') div.appendChild(makeBtn('last'));
    if (label === 'prénom') div.appendChild(makeBtn('first'));
  });
}

/* ========= Soumission paiement ========= */
// ————— Helpers feedback (humain lisible) —————
function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])); }
const WARN_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="#F7B500" d="M1 21h22L12 2 1 21z"/><path fill="#111" d="M13 18h-2v-2h2v2zm0-4h-2V9h2v5z"/></svg>';
const OK_SVG   = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#22c55e"/><path d="M8 12.5l2.5 2.5L16 9.5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function setFeedback(kind, title, details=[]) {
  const el = $('#feedback'); if (!el) return;
  el.className = `feedback ${kind==='error' ? 'err' : (kind==='ok' ? 'ok' : '')}`;
  el.setAttribute('role','alert'); // accessibilité
  const list = (details && details.length)
    ? `<ul class="fb-list">` + details.map(d=>`<li>${escapeHtml(d)}</li>`).join('') + `</ul>`
    : '';
  const icon = kind==='error' ? WARN_SVG : (kind==='ok' ? OK_SVG : '');
  el.innerHTML = `<span class="fb-icon">${icon}</span><span class="fb-text"><strong>${escapeHtml(title||'')}</strong>${list}</span>`;
}
window.BTS_VIEW.setFeedback = setFeedback;

// ——— Extraction "human-friendly" des erreurs ${currentPaymentProviderLabel()}, même quand elles
// arrivent sous forme de chaîne contenant du JSON imbriqué.
function extractHaMessages(from) {
  try {
    // Cas 1 : objet JSON déjà parsé
    if (from && typeof from === 'object') {
      if (Array.isArray(from.errors)) {
        return from.errors.map(e => e?.message || e?.code || 'Champ invalide');
      }
      if (from.error && typeof from.error === 'object' && Array.isArray(from.error.errors)) {
        return from.error.errors.map(e => e?.message || e?.code || 'Champ invalide');
      }
      // Certains backends encapsulent encore sous .error.message (string JSON)
      if (typeof from.error === 'string') {
        return extractHaMessages(from.error);
      }
    }
    // Cas 2 : chaîne brute (ex: "${currentPaymentProviderLabel()} checkout 400 {\"errors\":[{...}]}")
    const text = typeof from === 'string' ? from : '';
    if (!text) return [];
    // a) si la chaîne entière est du JSON
    if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
      try {
        const j = JSON.parse(text);
        return extractHaMessages(j);
      } catch {/* on continue */}
    }
    // b) extraire toutes les valeurs "message":"...".
    const msgs = [];
    const re = /"message"\s*:\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(text))) {
      msgs.push(m[1]);
    }
    if (msgs.length) return msgs;
    // c) fallback : si on voit "${currentPaymentProviderLabel()} checkout 400", message générique
    if (/helloasso\s+checkout\s+400/i.test(text)) {
      return ['Certaines informations ne sont pas valides. Veuillez corriger les champs en erreur.'];
    }
    return [];
  } catch {
    return [];
  }
}


function collectCheckoutPayload() {
  setFeedback('', ''); // clear

  // ── Vérification: pour chaque place, au moins Nom OU Prénom ────────────────
  // Réinitialise d'éventuels marquages d'erreur précédents
  $$('.holder-first, .holder-last').forEach(inp => inp.removeAttribute('aria-invalid'));
  const missingNameRows = [];
  let firstBad = null;
  $$('.cart-row').forEach(row => {
    const fn = $('.holder-first', row)?.value?.trim();
    const ln = $('.holder-last',  row)?.value?.trim();
    if (!fn && !ln) {
      const label = $('.seat-label', row)?.textContent?.trim() || row.dataset.seatId || `Ligne`;
      missingNameRows.push(label);
      // marque les deux champs en erreur (accessibilité)
      $('.holder-first', row)?.setAttribute('aria-invalid','true');
      $('.holder-last',  row)?.setAttribute('aria-invalid','true');
      if (!firstBad) firstBad = $('.holder-last', row) || $('.holder-first', row);
    }
  });
  if (missingNameRows.length) {
    setFeedback('error', 'Informations manquantes', missingNameRows.map(l => `« ${l} » : saisir un nom ou un prénom.`));
    try { firstBad?.focus(); } catch {}
    return;
  }

  const items = [];
  $$('.cart-row').forEach(row => {
    const seatId = row.dataset.seatId;
    const zoneKey = row.dataset.zoneKey || zoneKeyFromSeatId(seatId);
    const holderFirst = $('.holder-first', row).value.trim();
    const holderLast  = $('.holder-last',  row).value.trim();
    const tariffCode  = $('.tariff-select', row).value;

    const justif = $('.extra-input', row)?.value?.trim() || '';
    const info   = $('.extra-info',  row)?.textContent?.trim() || '';
    items.push({ seatId, zoneKey, firstName: holderFirst, lastName: holderLast, tariffCode, justif, info });
});

  if (!items.length) {
    setFeedback('error', 'Veuillez ajouter au moins une ligne.');
    return;
  }

  const payer = {
    firstName: $('#payerFirst').value.trim(),
    lastName : $('#payerLast').value.trim(),
    email    : $('#payerEmail').value.trim()
  };
  if (!payer.email) {
    setFeedback('error', 'Renseignez un email de contact.');
    try { $('#payerEmail').focus(); } catch {}
    return;
  }

  // 💡 Vérification locale “no single gap” (fenêtre ±2 ; bords autorisés)
  const gap = checkLocalNoSingleGap(items);
  if (gap) {
    setFeedback('error', 'Règle de placement', [
      `Votre sélection créerait un siège isolé en rangée ${gap.row} (zone ${gap.zone}). Merci de choisir une autre combinaison.`
    ]);
    return;
  }

  const scheduleEl = $('#paySchedule');
  const schedule = Number(scheduleEl ? (scheduleEl.value || 1) : 1);
  const totalAmount = CTX.currentTotal || 0;
  return { items, payer, schedule, totalAmount };
}
window.BTS_VIEW.collectCheckoutPayload = collectCheckoutPayload;

async function submitPayment() {
  const payload = collectCheckoutPayload();
  if (!payload) return;
  const { items, payer, schedule, totalAmount } = payload;

  // Open a blank window NOW, while we still have the user gesture context.
  // After any await the browser popup-blocker would reject window.open().
  // Do NOT use noopener here — it causes browsers to return null, losing the reference.
  const preWin = window.open('about:blank', '_blank');

  $('#payBtn').disabled = true;

  try {
    const res = await fetch(CONFIG.api.checkout, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Accept':'application/json' },
      credentials:'same-origin',
      body: JSON.stringify({ items, payer, schedule, totalAmount })
    });

    if (!res.ok) {
      let title = 'Une erreur est survenue.';
      let details = [];
      try {
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if (ct.includes('application/json')) {
          const err = await res.json();

          // 🔹 Règle anti-trou (nouvelle clé renvoyée par l’API)
          if (err?.error === 'no_single_gap' || err?.code === 'no_single_gap' || err?.error === 'single_gap_rule') {
            title = 'Règle de placement';
            if (err?.message) {
              details = [err.message];
            } else {
              // Essaye d’extraire une explication depuis problems[0]
              const g = Array.isArray(err?.problems) && err.problems.length ? err.problems[0] : null;
              const row  = g?.row || err?.row || err?.rowKey || '';
              const zone = g?.zoneKey || err?.zoneKey || '';
              details = [`Votre sélection créerait un siège isolé${row||zone ? ` en rangée ${row} (zone ${zone})` : ''}. Merci de choisir une autre combinaison.`];
            }
          }
          // 🔹 Siège indisponible
          else if (err?.error === 'seat_unavailable') {
            title = 'Siège indisponible';
            const sid = err?.seatId || '';
            const st  = err?.status || '';
            details = [`Le siège ${sid} n’est plus disponible (${st || 'indisponible'}).`];
          }
          // 🔹 Quota dépassé (zones)
          else if (err?.error === 'quota_exceeded') {
            title = 'Quota atteint';
            const z = err?.zoneKey || '';
            const r = typeof err?.remaining === 'number' ? err.remaining : 0;
            details = [`Le quota est atteint pour la zone ${z}. Places restantes: ${r}.`];
          }
          // 🔹 Quota prévente partenaire
          else if (err?.error === 'partner_presale_quota_exceeded') {
            title = 'Quota prévente atteint';
            const r = typeof err?.remaining === 'number' ? err.remaining : 0;
            details = [`Plus de places disponibles en prévente partenaire (restant: ${r}).`];
          }
          // 🔹 Zone invalide
          else if (err?.error === 'invalid_zone') {
            title = 'Zone inconnue';
            details = [`La zone demandée n’existe pas ou n’est pas éligible.`];
          }
          // 🔹 Billetterie fermée (évènement non ouvert)
          else if (
            err?.error === 'event_not_on_sale' ||
            (typeof err?.error === 'string' && err.error.toLowerCase().includes('vente ferm'))
          ) {
            title = 'Billetterie fermée';
            details = ['Les ventes sont closes pour cet événement.'];
          }
          // 🔹 Panier vide / email manquant / échéancier invalide
          else if (err?.error === 'no_lines') {
            title = 'Veuillez ajouter au moins une ligne.';
          } else if (err?.error === 'payer_email_required') {
            title = 'Renseignez un email de contact.';
          } else if (err?.error === 'invalid_schedule') {
            title = 'Échéancier invalide';
            details = ['Choisissez 1, 2 ou 3 échéances.'];
          }
          // 🔹 Tableau d’erreurs ${currentPaymentProviderLabel()} structuré
          else if (Array.isArray(err?.errors) && err.errors.length) {
            title = 'Veuillez corriger les éléments suivants :';
            details = err.errors.map(e => e?.message || e?.code || 'Champ invalide');
          }
          // 🔹 Message “métier” direct
          else if (typeof err?.message === 'string' && err.message.trim()) {
            title = err.message.trim();
          }
          // 🔹 Extraction des messages ${currentPaymentProviderLabel()} depuis une chaîne imbriquée
          else {
            const msgs = extractHaMessages(err);
            if (msgs.length) {
              title = 'Veuillez corriger les éléments suivants :';
              details = msgs;
            } else {
              title = 'Impossible de traiter votre demande. Réessayez.';
            }
          }
        } else {
          // Texte brut : tenter extraction messages HA, sinon générique
        const rawText = await res.text();
        const msgs = extractHaMessages(rawText);
        if (msgs.length) {
          title = 'Veuillez corriger les éléments suivants :';
          details = msgs;
        } else if (typeof rawText === 'string' && rawText.toLowerCase().includes('vente ferm')) {
          title = 'Billetterie fermée';
          details = ['Les ventes sont closes pour cet événement.'];
        } else {
          title = (res.status >= 500)
            ? 'Un problème technique est survenu. Réessayez dans quelques instants.'
            : 'Impossible de traiter votre demande. Vérifiez vos informations puis réessayez.';
        }
        }
      } catch {
        title = 'Un problème technique est survenu. Réessayez dans quelques instants.';
      }
      try { if (preWin && !preWin.closed) preWin.close(); } catch {}
      setFeedback('error', title, details);
      $('#payBtn').disabled = false;
      return;
    }


    const out = await res.json();
    const orderId     = out.orderId || '';
    const providerUrl = out.providerUrl || null;
    const statusUrl   = out.statusUrl   || null;
    const returnUrl   = out.returnUrl   || null;
    // Legacy fallback: /pay/start or checkout-embedded redirect
    const fallbackUrl = out.redirectUrl || out?.checkout?.redirectUrl || out?.checkout?.url;

    if (providerUrl && statusUrl) {
      // ── New flow: navigate the pre-opened window to the provider, show inline status panel ──
      openPaymentPanel({ orderId, providerUrl, statusUrl, returnUrl: returnUrl || fallbackUrl, win: preWin });
    } else if (fallbackUrl) {
      // ── Legacy flow: navigate to /pay/start ──
      if (preWin && !preWin.closed) {
        preWin.location.href = fallbackUrl;
      } else {
        setFeedback('ok', 'Redirection vers le paiement…');
        location.href = fallbackUrl;
      }
    } else {
      try { if (preWin && !preWin.closed) preWin.close(); } catch {}
      throw new Error('Réponse inattendue du serveur.');
    }
  } catch (e) {
    console.error('pay error:', e);
    try { if (preWin && !preWin.closed) preWin.close(); } catch {}
    setFeedback('error', 'Impossible de démarrer le paiement. Réessayez dans quelques instants.');
    $('#payBtn').disabled = false;
  }
}

function openPaymentPanel({ orderId, providerUrl, statusUrl, returnUrl, win }) {
  // Navigate the pre-opened window (or fall back to current tab if it was blocked)
  if (win && !win.closed) {
    try { win.location.href = providerUrl; } catch {}
  } else {
    // Popup was blocked — navigate current tab; /pay/return will confirm via DB
    window.location.href = providerUrl;
    return;
  }

  // Reveal the panel
  const panel = document.getElementById('paymentPanel');
  const body  = document.getElementById('paymentPanelBody');
  if (panel) {
    panel.hidden = false;
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  setFeedback('ok', 'Paiement ouvert dans un nouvel onglet. Cette page se mettra à jour automatiquement.');

  if (!body) return;
  body.innerHTML = `
    <div class="pay-status-row">
      <span class="pay-spinner"></span>
      En attente de confirmation du paiement…
    </div>
    <p class="pay-status-hint">Complétez le paiement dans l\'onglet qui vient de s\'ouvrir. Cette section se mettra à jour automatiquement.</p>
  `;

  function showConfirmed() {
    panel?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    body.innerHTML = `
      <div class="pay-status-row pay-status-confirmed">
        <span class="pay-status-success">✓ Paiement confirmé !</span>
        <a href="${returnUrl}" class="pay-status-open-link" target="_blank">Ouvrir en plein écran ↗</a>
      </div>
      <iframe src="${returnUrl}" class="pay-return-iframe" title="Confirmation de commande"></iframe>
    `;
  }

  let confirmed = false;
  function onConfirmed() {
    if (confirmed) return;
    confirmed = true;
    clearInterval(timer);
    try { bc.close(); } catch {}
    window.removeEventListener('message', onMessage);
    try { win.close(); } catch {}
    showConfirmed();
  }

  // Fast path 1: BroadcastChannel — /pay/return posts this when state=success
  let bc;
  try {
    bc = new BroadcastChannel('bts_payment');
    bc.onmessage = function(evt) {
      if (evt.data?.type === 'paid') onConfirmed();
    };
  } catch(e) {}

  // Fast path 2: postMessage from the new tab (opener scenario)
  function onMessage(evt) {
    if (evt.data?.type === 'bts_paid') onConfirmed();
  }
  window.addEventListener('message', onMessage);

  // Fallback: poll /pay/status every 3 s in case the tab was closed before broadcasting
  let attempts = 0;
  const maxAttempts = 240; // ~12 min at 3 s intervals
  const timer = setInterval(async function () {
    attempts++;
    if (attempts > maxAttempts) {
      clearInterval(timer);
      try { bc.close(); } catch {}
      window.removeEventListener('message', onMessage);
      body.innerHTML = `<div class="pay-status-timeout">Vérification expirée. <a href="${returnUrl}">Vérifier le statut de la commande</a></div>`;
      return;
    }
    try {
      const r = await fetch(statusUrl, { cache: 'no-store', credentials: 'same-origin' });
      if (!r.ok) { console.warn('[bts/poll] status fetch non-ok:', r.status); return; }
      const d = await r.json();
      if (d.paid) onConfirmed();
    } catch (e) { console.warn('[bts/poll] fetch error:', e?.message || e); }
  }, 3000);
}

/* ========= Chargement ========= */
async function loadData() {
  const res = await fetch(CONFIG.api.status, { headers:{ 'Accept':'application/json' }, credentials:'same-origin' });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text().catch(()=>res.status)}`);
  const data = await res.json();

dlog('status payload keys:', Object.keys(data||{}));
dlog('payload sample:', {
  seats: data?.seats,
  seatSubscribers: data?.seatSubscribers,
  payer: data?.payer,
  payerFirstName: data?.payerFirstName, payerLastName: data?.payerLastName, payerEmail: data?.payerEmail
});

  CTX.seasonCode = data.seasonCode || data.season || null;
  CTX.venueSlug  = data.venueSlug  || data.venue  || null;
  CTX.tariffs    = Array.isArray(data.tariffs) ? data.tariffs : [];
  CTX.prices     = Array.isArray(data.prices)  ? data.prices  : [];
  CTX.seats      = Array.isArray(data.seats)   ? data.seats   : [];
  CTX.tokenSeats = Array.isArray(data.tokenSeats) ? data.tokenSeats.map(normSeatId) : [];
  CTX.zones      = Array.isArray(data.zones) ? data.zones : [];
  const resolvedVenueView = data.venueView || data.event?.venueView || null;
  if (!CONFIG.venueView && resolvedVenueView) {
    CONFIG.venueView = resolvedVenueView;
  }
  // a) seatSubscribers -> index normalisé
  CTX.seatSubscribers = data.seatSubscribers || {};
  CTX.seatSubById = new Map();
  // Index rapide des statuts de siège

  SEAT_STATUS = new Map(
    (CTX.seats || []).map(s => [ String(s.seatId).trim(), mapSeatState(s.status) ])
  );
  dlog('SEAT_STATUS sample:', Array.from(SEAT_STATUS.entries()).slice(0,8));
  

let mappedCount = 0;
if (Array.isArray(CTX.seatSubscribers)) {
  for (const sub of CTX.seatSubscribers) {
    const sid = normSeatId(sub?.seatId || sub?.id || sub?.label);
    if (!sid) continue;
    const firstName = sub?.firstName ?? sub?.holderFirstName ?? '';
    const lastName  = sub?.lastName  ?? sub?.holderLastName  ?? '';
    const email     = sub?.email     ?? sub?.holderEmail     ?? '';
    CTX.seatSubById.set(sid, { firstName, lastName, email });
    mappedCount++;
  }
} else {
dlog('seats array (raw):', CTX.seats);

for (const [rawId, sub] of Object.entries(CTX.seatSubscribers||{})) {
    const sid = normSeatId(rawId);
    const firstName = sub?.firstName ?? sub?.holderFirstName ?? '';
    const lastName  = sub?.lastName  ?? sub?.holderLastName  ?? '';
    const email     = sub?.email     ?? sub?.holderEmail     ?? '';
    CTX.seatSubById.set(sid, { firstName, lastName, email });
    mappedCount++;
  }
}
dlog('seatSubById mapped entries:', mappedCount, Array.from(CTX.seatSubById.entries()).slice(0,5));

  // 🔧 COMPLÉMENT: si des infos abonnés sont présentes dans `seats`, on les injecte
  let enriched = 0;
  for (const s of (CTX.seats || [])) {
    const sid = normSeatId(typeof s === 'string' ? s : (s?.seatId || s?.id || s?.label || ''));
    if (!sid) continue;
    const cur = CTX.seatSubById.get(sid) || {};
    const firstName = cur.firstName || s?.holderFirstName || s?.firstName || s?.subscriber?.firstName || '';
    const lastName  = cur.lastName  || s?.holderLastName  || s?.lastName  || s?.subscriber?.lastName  || '';
    const email     = cur.email     || s?.holderEmail     || s?.email     || s?.subscriber?.email     || '';
    if ((firstName || lastName || email)) {
      CTX.seatSubById.set(sid, { firstName, lastName, email });
      enriched++;
    }
  }
  dlog('seatSubById enriched from seats:', enriched, Array.from(CTX.seatSubById.entries()).slice(0,5));

if (Array.isArray(CTX.seatSubscribers)) {
    for (const sub of CTX.seatSubscribers) {
      const sid = normSeatId(sub?.seatId || sub?.id || sub?.label);
      if (!sid) continue;
      const firstName = sub?.firstName ?? sub?.holderFirstName ?? '';
      const lastName  = sub?.lastName  ?? sub?.holderLastName  ?? '';
      const email     = sub?.email     ?? sub?.holderEmail     ?? '';
      CTX.seatSubById.set(sid, { firstName, lastName, email });
    }
  } else {
    for (const [rawId, sub] of Object.entries(CTX.seatSubscribers)) {
      const sid = normSeatId(rawId);
      const firstName = sub?.firstName ?? sub?.holderFirstName ?? '';
      const lastName  = sub?.lastName  ?? sub?.holderLastName  ?? '';
      const email     = sub?.email     ?? sub?.holderEmail     ?? '';
      CTX.seatSubById.set(sid, { firstName, lastName, email });
    }
  }

  // b) payer : accepter payerFirstName/payerLastName/payerEmail
  const p = data.payer || {};
  CTX.payer = {
    firstName: p.firstName ?? p.payerFirstName ?? data.payerFirstName ?? '',
    lastName : p.lastName  ?? p.payerLastName  ?? data.payerLastName  ?? '',
    email    : p.email     ?? p.payerEmail     ?? data.payerEmail     ?? ''
  };

  CTX.pricesIdx = buildPricesIndex(CTX.prices);
  CTX.tariffMap.clear();

  dlog('payer resolved:', CTX.payer);

  for (const t of CTX.tariffs) CTX.tariffMap.set(String(t.code||'').toUpperCase(), t);

  // Plan
  const $planObj = $('#venuePlan');
  let planPath = null;
  if (typeof CONFIG.venuePlanPath === 'string' && CONFIG.venuePlanPath) {
    planPath = CONFIG.venuePlanPath;
  } else if (typeof CONFIG.venuePlanPath === 'function') {
    try {
      planPath = CONFIG.venuePlanPath(CTX.venueSlug, { assetsBase: ASSET_BASE });
    } catch (err) {
      console.warn('venuePlanPath failed:', err);
    }
  }
  if (!planPath) {
    const slug = String(CTX.venueSlug || '').trim();
    if (slug) {
      const safeSlug = encodeURIComponent(slug);
      const base = (CONFIG.venuePlanBase || `${ASSET_BASE}venues/`);
      const normalizedBase = base.endsWith('/') ? base : `${base}/`;
      if (CONFIG.venueView) {
        const viewSlug = encodeURIComponent(CONFIG.venueView);
        planPath = `${normalizedBase}${safeSlug}/views/${viewSlug}.svg`;
      } else {
        planPath = `${normalizedBase}${safeSlug}/plan.svg`;
      }
    }
  }
  if (planPath) {
    $planObj.setAttribute('data', planPath);
  }
  $planObj.addEventListener('load', () => { try { onPlanReady($planObj); } catch(e){ console.warn('plan init failed:', e); } }, { once:true });

// Lignes (renew = sièges connus) — activable/désactivable par config
const $rows = $('#cartRows');
const BUILD_ROWS = (CONFIG.buildRowsFromData !== false);
if (BUILD_ROWS) {
  $rows.innerHTML = ''; // uniquement quand on reconstruit depuis les données (ex: renew)
  // Ne pas remettre dans le panier les sièges déjà "booked" (ou "sold")
  const initialSeats = Array.isArray(CTX.seats) ? CTX.seats : [];
  for (const seat of initialSeats) {
    const st = String(seat?.status || '').toLowerCase();
    if (st === 'booked' || st === 'sold') continue; // ⛔ déjà réservés → ignorés
    $rows.appendChild(makeRowForSeat(seat));        // ✅ sièges encore à renouveler
  }
}

  // Payer — ne pas écraser ce que l'utilisateur a déjà saisi
  if (!$('#payerFirst').value) $('#payerFirst').value = CTX.payer.firstName || '';
  if (!$('#payerLast').value)  $('#payerLast').value  = CTX.payer.lastName  || '';
  if (!$('#payerEmail').value) $('#payerEmail').value = CTX.payer.email     || '';

dlog('payer inputs after set:', {
  first: $('#payerFirst').value, last: $('#payerLast').value, email: $('#payerEmail').value
});

  updateTotals(); updateInstallmentsPreview();
  syncSelectedHighlights();
  CTX.raw = data;              // expose le payload brut aux vues spécifiques
  emitHook('afterData', { ctx: CTX, data });
  // c) Si pas de contact côté API, complète depuis la 1ʳᵉ ligne
  if (!$('#payerFirst').value && !$('#payerLast').value) {
    syncPayerMaybe();
  }  
}

/* ========= Boot ========= */
document.addEventListener('DOMContentLoaded', async () => {
  dlog('boot generic-view.js v2025-09-04', { href: location.href, ts: Date.now() });

  const h1 = $('#pageTitle'); if (h1) h1.textContent = PAGE_TITLE;

  const pageEl = $('#page') || $('.page');
  // ——— gestion du layout (auto par défaut, verrou si clic utilisateur)
  const guessAutoLayout = () => (window.innerWidth > window.innerHeight) ? 'row' : 'col';
  let layoutLock = null; // null = auto ; 'row' | 'col' = verrou

  // Affiche l’icône de la **cible** (le prochain layout si on clique)
  function setLayoutIconForTarget(currentMode){
    const btn = $('#layoutToggle'); if (!btn) return;
    const target = (currentMode === 'row') ? 'col' : 'row';
    const showH = (target === 'row'); // prochain état = horizontal → icône horizontale
    $('.icon-h', btn)?.toggleAttribute('hidden', !showH);
    $('.icon-v', btn)?.toggleAttribute('hidden',  showH);
  }
  function applyLayout(){
    const mode = layoutLock || guessAutoLayout();
    if (pageEl) pageEl.setAttribute('data-layout', mode);
    setLayoutIconForTarget(mode); // affiche l’icône de la **cible** (prochain layout)
  }

  
  window.addEventListener('resize', () => { if (!layoutLock) applyLayout(); });

  window.BTS_VIEW.refresh = loadData;

  try { await loadData(); }
  catch (e) {
    console.error('load error:', e);
    $('#feedback').classList.add('err');
    $('#feedback').textContent = 'Impossible de charger les données. Vérifiez votre lien.';
  }
  attachNameAutofillButtons();
  $('#payBtn').addEventListener('click', submitPayment);
  window.BTS_VIEW.submitPayment = submitPayment;
  const scheduleControl = $('#paySchedule');
  if (scheduleControl) scheduleControl.addEventListener('change', updateInstallmentsPreview);

  // ——— actions Plan
  // 1) Toggle layout (verrouille le mode jusqu’à ce que l’utilisateur re-clique)
  const layoutBtn = $('#layoutToggle');
  if (layoutBtn && pageEl) {
    layoutBtn.addEventListener('click', () => {
      const current = pageEl.getAttribute('data-layout') || guessAutoLayout();
      const next = (current === 'row') ? 'col' : 'row';
      layoutLock = next;               // on verrouille
      pageEl.setAttribute('data-layout', next);
      // après bascule, la nouvelle **cible** est l’inverse de `next`
      setLayoutIconForTarget(next);
    });
  }
  // 2) Plein écran du plan
  const fsBtn = $('#fsToggle');
  const planWrap = $('.plan-wrap');
  if (fsBtn && planWrap) {
    const isMobileUA = /Android|iP(ad|hone|od)/i.test(navigator.userAgent || '');
    // Sur mobile/tablette, on force le mode simulé pour conserver le pinch-zoom.
    const supportsNativeFs = !isMobileUA && !!(planWrap.requestFullscreen || planWrap.webkitRequestFullscreen);
    const host = planWrap || $('#plan'); // cible sûre : le conteneur du plan
    let simFullscreen = false;

    const updateIcons = (isFull) => {
      $('.icon-big',   fsBtn)?.toggleAttribute('hidden',  isFull);
      $('.icon-small', fsBtn)?.toggleAttribute('hidden', !isFull);
    };

    // plein écran sur le panneau plan (native si possible, sinon fallback)
    fsBtn.addEventListener('click', async () => {
      const entering = !(document.fullscreenElement || simFullscreen);
      try {
        if (entering) {
          if (supportsNativeFs) {
            await (host.requestFullscreen?.() || host.webkitRequestFullscreen?.());
            updateIcons(true);
          } else {
            simFullscreen = true;
            host.classList.add('fs-simulated');
            document.body.classList.add('fs-lock');
            updateIcons(true);
          }
        } else {
          if (document.fullscreenElement && (document.exitFullscreen || document.webkitExitFullscreen)) {
            await (document.exitFullscreen?.() || document.webkitExitFullscreen?.());
          }
          if (simFullscreen) {
            simFullscreen = false;
            host.classList.remove('fs-simulated');
            document.body.classList.remove('fs-lock');
          }
          updateIcons(false);
        }
      } catch {
        const isFS = !!(document.fullscreenElement || simFullscreen);
        updateIcons(isFS);
      }
    });

    // garde-fou : synchro icônes même si l’API native change l’état
    const onFsChange = () => {
      const isFS = !!(document.fullscreenElement || simFullscreen);
      updateIcons(isFS);
      if (!document.fullscreenElement && simFullscreen) {
        simFullscreen = false;
        host.classList.remove('fs-simulated');
        document.body.classList.remove('fs-lock');
      }
    };
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
    
  }

  // Pinch-zoom custom sur le plan (évite le zoom global de la page)
  const planObj = $('#venuePlan');
  if (planWrap && planObj) {
    let baseScale = 1;
    let startDistance = null;
    const active = new Map();
    const minScale = 1;
    const maxScale = 3;

    const distance = () => {
      if (active.size < 2) return null;
      const pts = Array.from(active.values());
      const dx = pts[0].x - pts[1].x;
      const dy = pts[0].y - pts[1].y;
      return Math.hypot(dx, dy);
    };

    const applyScale = (scale) => {
      const clamped = Math.max(minScale, Math.min(maxScale, scale));
      planObj.style.transformOrigin = 'center center';
      planObj.style.transform = `scale(${clamped})`;
      planObj.dataset.zoom = String(clamped);
      return clamped;
    };

    const resetPointers = () => {
      startDistance = null;
      active.clear();
    };

    const onPointerDown = (ev) => {
      if (ev.pointerType === 'touch') {
        active.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        if (active.size === 2) startDistance = distance();
      }
    };

    const onPointerMove = (ev) => {
      if (!active.has(ev.pointerId)) return;
      active.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (active.size >= 2 && startDistance) {
        const dist = distance();
        if (dist) {
          const newScale = applyScale(baseScale * (dist / startDistance));
          planWrap.classList.toggle('zoomed', newScale > 1.02);
          ev.preventDefault();
        }
      }
    };

    const endPointer = (ev) => {
      if (active.has(ev.pointerId)) active.delete(ev.pointerId);
      if (active.size < 2 && startDistance) {
        const current = Number(planObj.dataset.zoom || baseScale || 1);
        baseScale = current;
        startDistance = null;
      }
    };
    planWrap.addEventListener('pointerdown', onPointerDown, { passive: false, capture: true });
    planWrap.addEventListener('pointermove', onPointerMove, { passive: false, capture: true });
    planWrap.addEventListener('pointerup', endPointer, { capture: true });
    planWrap.addEventListener('pointercancel', endPointer, { capture: true });
    planWrap.addEventListener('pointerout', endPointer, { capture: true });
    planWrap.addEventListener('pointerleave', endPointer, { capture: true });
  }

  // layout initial (icône = cible)
  applyLayout();
});
