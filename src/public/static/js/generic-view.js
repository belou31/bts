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
document.title = (CONFIG.pageTitle || CONFIG.title || 'Billetterie') + ' — BTS';

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
  }
};


// Classes SVG utilisées (tu peux les surcharger via window.BTS_VIEW_CONFIG.svgSeatClasses)
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
  list.sort((a,b) => (String(a.code).toUpperCase()==='NORMAL'? -1 : 0) + (String(b.code).toUpperCase()==='NORMAL'? 1 : 0));
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
  const queries = [
    `#${CSS.escape(sid)}`,
    `[id="${sid}"]`,
    `[data-seat-id="${sid}"]`,
    `[data-seat="${sid}"]`,
    `[data-id="${sid}"]`,
    `[data-seatid="${sid}"]`,
    `[id$="${sid}"]`
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
    const sid = row.dataset.seatId;
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
  const seatDisplay = String(seat?.label || seatId);

  const z = seat?.zoneKey ? String(seat.zoneKey) : zoneKeyFromSeatId(seatId);
    
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
    const seatId = row.dataset.seatId;
    const z = zoneKeyFromSeatId(seatId);
    const tariff = $('.tariff-select', row).value;
    total += computeLineAmount(CTX.pricesIdx, z, tariff);
  });
  CTX.currentTotal = total;
  $('#totalBox').textContent = fmtEuro(total);
  $('#payBtn').disabled = (total <= 0);
}

function updateInstallmentsPreview() {
  const schedule = Number($('#paySchedule').value || 1);
  const total = CTX.currentTotal || 0;
  if (schedule <= 1 || total <= 0) {
    $('#schedulePreview').textContent = '—';
    return;
  }
  const base = Math.floor(total / schedule);
  const parts = Array(schedule).fill(base);
  parts[schedule-1] = total - base*(schedule-1);
  $('#schedulePreview').textContent = parts.map(p => fmtEuro(p)).join(' + ');
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

// ——— Extraction "human-friendly" des erreurs HelloAsso, même quand elles
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
    // Cas 2 : chaîne brute (ex: "HelloAsso checkout 400 {\"errors\":[{...}]}")
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
    // c) fallback : si on voit "HelloAsso checkout 400", message générique
    if (/helloasso\s+checkout\s+400/i.test(text)) {
      return ['Certaines informations ne sont pas valides. Veuillez corriger les champs en erreur.'];
    }
    return [];
  } catch {
    return [];
  }
}


async function submitPayment() {
  setFeedback('', ''); // clear

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

  const schedule = Number($('#paySchedule').value || 1);
  const totalAmount = CTX.currentTotal || 0;

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
          // 🔹 Zone invalide
          else if (err?.error === 'invalid_zone') {
            title = 'Zone inconnue';
            details = [`La zone demandée n’existe pas ou n’est pas éligible.`];
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
          // 🔹 Tableau d’erreurs HelloAsso structuré
          else if (Array.isArray(err?.errors) && err.errors.length) {
            title = 'Veuillez corriger les éléments suivants :';
            details = err.errors.map(e => e?.message || e?.code || 'Champ invalide');
          }
          // 🔹 Message “métier” direct
          else if (typeof err?.message === 'string' && err.message.trim()) {
            title = err.message.trim();
          }
          // 🔹 Extraction des messages HelloAsso depuis une chaîne imbriquée
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
          } else {
            title = (res.status >= 500)
              ? 'Un problème technique est survenu. Réessayez dans quelques instants.'
              : 'Impossible de traiter votre demande. Vérifiez vos informations puis réessayez.';
          }
        }
      } catch {
        title = 'Un problème technique est survenu. Réessayez dans quelques instants.';
      }
      setFeedback('error', title, details);
      $('#payBtn').disabled = false;
      return;
    }
    
    
    const out = await res.json();
    if (out.redirectUrl) {
      setFeedback('ok', 'Redirection vers le paiement…');
      location.href = out.redirectUrl;
    } else {
      throw new Error('Réponse inattendue du serveur.');
    }
  } catch (e) {
    console.error('pay error:', e);
    setFeedback('error', 'Impossible de démarrer le paiement. Réessayez dans quelques instants.');

    $('#payBtn').disabled = false;
  }
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
  const planPath = (CONFIG.venuePlanPath ? CONFIG.venuePlanPath(CTX.venueSlug) : `static/venues/${CTX.venueSlug}/plan.svg`);
  $planObj.setAttribute('data', planPath);
  $planObj.addEventListener('load', () => { try { onPlanReady($planObj); } catch(e){ console.warn('plan init failed:', e); } }, { once:true });

// Lignes (renew = sièges connus) — activable/désactivable par config
const $rows = $('#cartRows'); $rows.innerHTML = '';
const BUILD_ROWS = (CONFIG.buildRowsFromData !== false);
if (BUILD_ROWS) {
  // Ne pas remettre dans le panier les sièges déjà "booked" (ou "sold")
  const initialSeats = Array.isArray(CTX.seats) ? CTX.seats : [];
  for (const seat of initialSeats) {
    const st = String(seat?.status || '').toLowerCase();
    if (st === 'booked' || st === 'sold') continue; // ⛔ déjà réservés → ignorés
    $rows.appendChild(makeRowForSeat(seat));        // ✅ sièges encore à renouveler
  }
}

  // Payer
  $('#payerFirst').value = CTX.payer.firstName || '';
  $('#payerLast').value  = CTX.payer.lastName  || '';
  $('#payerEmail').value = CTX.payer.email     || '';

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

  const h1 = $('#pageTitle'); if (h1) h1.textContent = CONFIG.title || 'Billetterie';

  try { await loadData(); }
  catch (e) {
    console.error('load error:', e);
    $('#feedback').classList.add('err');
    $('#feedback').textContent = 'Impossible de charger les données. Vérifiez votre lien.';
  }
  $('#payBtn').addEventListener('click', submitPayment);
  $('#paySchedule').addEventListener('change', updateInstallmentsPreview);
});