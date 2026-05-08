(function () {
  // ---------- Helpers ----------
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  function loadAuthHeader() {
    return localStorage.getItem('bts_admin_auth_header') || '';
  }
  function saveAuthHeader(v) {
    localStorage.setItem('bts_admin_auth_header', v || '');
  }
  function makeHeaders() {
    const h = { 'Content-Type': 'application/json' };
    const raw = loadAuthHeader().trim();
    if (!raw) return h;
    if (raw.includes(':')) {
      const i = raw.indexOf(':');
      const k = raw.slice(0, i).trim();
      const v = raw.slice(i + 1).trim();
      if (k && v) h[k] = v;
    } else {
      h['Authorization'] = raw; // ex: "Bearer xxxxx"
    }
    return h;
  }
  async function fetchJson(url, opts = {}) {
    const res = await fetch(url, { ...opts, headers: { ...makeHeaders(), ...(opts.headers || {}) } });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.json();
  }
  function toCsv(rows) {
    const esc = s => `"${String(s ?? '').replace(/"/g,'""')}"`;
    return rows.map(r => Object.values(r).map(esc).join(',')).join('\n');
  }
  async function downloadCsv(url, filename) {
    const res = await fetch(url, { headers: makeHeaders() });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------- Tabs ----------
  $$('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      $$('.panel').forEach(p => p.classList.remove('active'));
      $('#tab-' + tab).classList.add('active');
    });
  });

  // ---------- Auth header ----------
  $('#authHeader').value = loadAuthHeader();
  $('#saveAuth').addEventListener('click', () => {
    saveAuthHeader($('#authHeader').value);
    alert('Auth header enregistré.');
  });

  // ---------- CATALOG ----------
  async function loadCatalog() {
    const data = await fetchJson('/api/admin/tariff-catalog?all=1');
    const tbody = $('#catTable tbody');
    tbody.innerHTML = '';
    for (const it of data.items) {
      tbody.appendChild(renderCatRow(it));
    }
  }

  function renderCatRow(it = {}) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input class="cell" data-k="code" value="${it.code || ''}" ${it._id ? 'readonly' : ''}></td>
      <td><input class="cell" data-k="label" value="${it.label || ''}"></td>
      <td><input class="cell" data-k="requiresField" value="${it.requiresField || ''}"></td>
      <td><input class="cell" data-k="fieldLabel" value="${it.fieldLabel || ''}"></td>
      <td><input class="cell" data-k="requiresInfo" value="${it.requiresInfo || ''}"></td>
      <td><input class="cell" data-k="active" value="${it.active ? 'true' : 'false'}"></td>
      <td><input class="cell" data-k="sortOrder" value="${it.sortOrder ?? 100}"></td>
      <td>
        <button class="btn ok">Enregistrer</button>
        ${it._id ? '<button class="btn danger">Supprimer</button>' : ''}
      </td>
    `;
    const btns = tr.querySelectorAll('button');
    btns[0].addEventListener('click', async () => {
      const row = readRow(tr);
      row.code = String(row.code || '').toUpperCase().trim();
      row.active = String(row.active || '').toLowerCase() !== 'false';
      row.sortOrder = Number(row.sortOrder || 100);
      await fetchJson('/api/admin/tariff-catalog', {
        method: 'PUT',
        body: JSON.stringify(row)
      });
      await loadCatalog();
    });
    if (btns[1]) {
      btns[1].addEventListener('click', async () => {
        if (!confirm('Supprimer ce tarif ?')) return;
        const code = tr.querySelector('[data-k="code"]').value.toUpperCase();
        await fetchJson('/api/admin/tariff-catalog', {
          method: 'DELETE',
          body: JSON.stringify({ code })
        });
        tr.remove();
      });
    }
    return tr;
  }

  function readRow(tr) {
    const obj = {};
    tr.querySelectorAll('input.cell').forEach(inp => obj[inp.dataset.k] = inp.value);
    return obj;
  }

  $('#btnCatReload').addEventListener('click', loadCatalog);
  $('#btnCatAdd').addEventListener('click', () => {
    $('#catTable tbody').prepend(renderCatRow({}));
  });

  $('#btnCatExport').addEventListener('click', async () => {
    await downloadCsv('/api/admin/tariff-catalog/export.csv', 'tariff_catalog.csv');
  });

  $('#btnCatImport').addEventListener('click', async () => {
    const f = $('#catCsvFile').files[0];
    if (!f) return alert('Choisis un fichier CSV.');
    const text = await f.text();
    const rows = parseCsv(text); // array of objects
    if (!rows.length) return alert('CSV vide ?');
    // normaliser
    const items = rows.map(r => ({
      code: String(r.code || r.CODE || '').toUpperCase(),
      label: r.label || r.LABEL || '',
      requiresField: r.requiresField || r.REQUIRESFIELD || '',
      fieldLabel: r.fieldLabel || r.FIELDLABEL || '',
      requiresInfo: r.requiresInfo || r.REQUIRESINFO || '',
      active: parseBool(r.active ?? r.ACTIVE, true),
      sortOrder: Number(r.sortOrder ?? r.SORTORDER ?? 100)
    })).filter(x => x.code && x.label);
    await fetchJson('/api/admin/tariff-catalog/batch', {
      method: 'POST',
      body: JSON.stringify({ items })
    });
    await loadCatalog();
    alert(`Import OK (${items.length} lignes)`);
  });

  // ---------- PRICES ----------
  async function loadPrices() {
    const season = $('#pSeason').value.trim();
    const venue  = $('#pVenue').value.trim();
    if (!season || !venue) return alert('Saison et venue requis.');
    const data = await fetchJson(`/api/admin/tariffs?season=${encodeURIComponent(season)}&venue=${encodeURIComponent(venue)}`);
    const tbody = $('#priceTable tbody');
    tbody.innerHTML = '';
    for (const it of data.items) {
      tbody.appendChild(renderPriceRow(it));
    }
  }

  function renderPriceRow(it = {}) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input class="cell" data-k="zoneKey" value="${it.zoneKey || ''}"></td>
      <td><input class="cell" data-k="tariffCode" value="${it.tariffCode || ''}"></td>
      <td><input class="cell" data-k="priceCents" value="${it.priceCents ?? ''}"></td>
      <td>
        <button class="btn ok">Enregistrer</button>
      </td>
    `;
    tr.querySelector('.btn.ok').addEventListener('click', async () => {
      const season = $('#pSeason').value.trim();
      const venue  = $('#pVenue').value.trim();
      const row = readRow(tr);
      row.tariffCode = String(row.tariffCode || '').toUpperCase().trim();
      row.priceCents = Number(row.priceCents || 0);
      await fetchJson('/api/admin/tariffs', {
        method: 'PUT',
        body: JSON.stringify({
          seasonCode: season,
          venueSlug: venue,
          zoneKey: row.zoneKey,
          tariffCode: row.tariffCode,
          priceCents: row.priceCents
        })
      });
      alert('Enregistré.');
    });
    return tr;
  }

  $('#btnPriceReload').addEventListener('click', loadPrices);
  $('#btnPriceAdd').addEventListener('click', () => {
    $('#priceTable tbody').prepend(renderPriceRow({}));
  });

  $('#btnPriceExport').addEventListener('click', async () => {
    const season = $('#pSeason').value.trim();
    const venue  = $('#pVenue').value.trim();
    if (!season || !venue) return alert('Saison et venue requis.');
    await downloadCsv(`/api/admin/tariffs/export.csv?season=${encodeURIComponent(season)}&venue=${encodeURIComponent(venue)}`, `tariffs_${season}_${venue}.csv`);
  });

  $('#btnPriceImport').addEventListener('click', async () => {
    const season = $('#pSeason').value.trim();
    const venue  = $('#pVenue').value.trim();
    if (!season || !venue) return alert('Saison et venue requis.');
    const f = $('#priceCsvFile').files[0];
    if (!f) return alert('Choisis un fichier CSV.');
    const text = await f.text();
    const rows = parseCsv(text);
    if (!rows.length) return alert('CSV vide ?');

    const items = rows.map(r => {
      let cents = Number(r.priceCents ?? r.PRICECENTS);
      if (!Number.isFinite(cents)) {
        const euro = (r.priceEuro ?? r.PRICEEURO ?? '').toString().replace(',', '.');
        const n = Number(euro);
        cents = Number.isFinite(n) ? Math.round(n * 100) : NaN;
      }
      return {
        zoneKey: r.zoneKey ?? r.ZONEKEY ?? r.zone ?? r.ZONE,
        tariffCode: String(r.tariffCode ?? r.TARIFFCODE ?? r.tariff ?? r.TARIFF || '').toUpperCase(),
        priceCents: cents
      };
    }).filter(x => x.zoneKey && x.tariffCode && Number.isFinite(x.priceCents));

    await fetchJson('/api/admin/tariffs/batch', {
      method: 'POST',
      body: JSON.stringify({ seasonCode: season, venueSlug: venue, items })
    });
    await loadPrices();
    alert(`Import OK (${items.length} lignes)`);
  });

  // ---------- CSV parser simple ----------
  function parseCsv(text) {
    const lines = text.replace(/\r/g,'').split('\n').filter(Boolean);
    if (!lines.length) return [];
    const headers = splitCsvLine(lines[0]).map(h => h.trim());
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = splitCsvLine(lines[i]);
      const obj = {};
      headers.forEach((h, idx) => obj[h] = cells[idx] ?? '');
      rows.push(obj);
    }
    return rows;
  }
  function splitCsvLine(line) {
    const out = [];
    let cur = '', q = false;
    for (let i=0; i<line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i+1] === '"') { cur += '"'; i++; }
        else if (c === '"') { q = false; }
        else cur += c;
      } else {
        if (c === '"') q = true;
        else if (c === ',') { out.push(cur); cur = ''; }
        else cur += c;
      }
    }
    out.push(cur);
    return out;
  }
  function parseBool(v, def=true) {
    if (v == null || v === '') return def;
    const s = String(v).trim().toLowerCase();
    if (['1','true','yes','y','on'].includes(s)) return true;
    if (['0','false','no','n','off'].includes(s)) return false;
    return def;
  }

  // init
  $('#pSeason').value = (new Date().getFullYear()) + '-' + (new Date().getFullYear()+1);
  loadCatalog().catch(err => console.error(err));
})();
