(async function(){
  const seasonCode = new URLSearchParams(location.search).get('season') || '2025-2026';
  const map = document.getElementById('arena-map');        // ton <svg id="arena-map"> existe déjà
  if (!map) { console.warn('SVG #arena-map non trouvé'); return; }

  // util: badge "P" pour provisionné (dans l'espace SVG)
  function addBadgeFor(elem, label='P') {
    const svg = map; // parent <svg>
    const bb = elem.getBBox();
    const r = Math.max(6, Math.min(bb.width, bb.height) * 0.20);
    const cx = bb.x + bb.width - r - 1;
    const cy = bb.y + r + 1;

    const g = document.createElementNS('http://www.w3.org/2000/svg','g');
    g.setAttribute('class','badge');

    const c = document.createElementNS('http://www.w3.org/2000/svg','circle');
    c.setAttribute('cx', cx);
    c.setAttribute('cy', cy);
    c.setAttribute('r', r);

    const t = document.createElementNS('http://www.w3.org/2000/svg','text');
    t.setAttribute('x', cx);
    t.setAttribute('y', cy);
    t.textContent = label;

    g.appendChild(c); g.appendChild(t);
    // on insère juste après l’élément pour rester au-dessus
    elem.parentNode.insertBefore(g, elem.nextSibling);
    return g;
  }

  // nettoie d’anciennes pastilles
  function clearBadges() {
    map.querySelectorAll('g.badge').forEach(n => n.remove());
  }

  // pose les états et les pastilles
  function applySeatStates(apiSeats) {
    clearBadges();
    const byId = new Map(apiSeats.map(s => [s.seatId, s]));
    const seatElems = map.querySelectorAll('[data-seat-id]'); // chaque siège dans le SVG doit avoir data-seat-id="A1-001"
    seatElems.forEach(el => {
      const sid = el.getAttribute('data-seat-id');
      const rec = byId.get(sid);
      const state = rec ? rec.status : 'available';
      el.dataset.state = state;
      el.classList.add('seat');

      if (state === 'provisioned') addBadgeFor(el, 'P');       // pastille Provisionné
      else if (state === 'held')    addBadgeFor(el, 'H');       // optionnel
      else if (state === 'booked')  addBadgeFor(el, 'X');       // optionnel
    });
  }

  // blocage au clic si non disponible
  function bindClicks() {
    map.addEventListener('click', (e) => {
      const target = e.target.closest('[data-seat-id]');
      if (!target) return;
      const state = target.dataset.state || 'available';
      const seatId = target.getAttribute('data-seat-id');
      if (state !== 'available') {
        const msg = state === 'provisioned'
          ? `Place ${seatId} provisonnée (renouvellement N-1) — non réservable.`
          : `Place ${seatId} indisponible (${state}).`;
        alert(msg);
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // logique de sélection normale (ajoute/retire du panier)
      target.classList.toggle('selected');
    });
  }

  // charge les états depuis l’API publique
  async function loadAndRender() {
    const res = await fetch(`/api/v1/public/seats?seasonCode=${encodeURIComponent(seasonCode)}`);
    if (!res.ok) { console.error('API seats error', await res.text()); return; }
    const json = await res.json();
    applySeatStates(json.seats || []);
  }

  bindClicks();
  await loadAndRender();

  // (facultatif) rafraîchit toutes les 15s pour refléter les holds
  setInterval(loadAndRender, 15000);
})();
