(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const CONFIG = { apiBase: '', ...(window.TRIPXYZ_CONFIG || {}) };
  const LITRES_PER_GALLON = 4.54609;
  const METERS_PER_MILE = 1609.344;
  const ROUTE_SEARCH_MILES = 5;

  const DEFAULTS = {
    petrol: { efficiency: 45, price: 170.9 },
    diesel: { efficiency: 52, price: 198.9 },
    electric: { efficiency: 3.5, price: 28 },
  };
  const GRADES = { petrol: ['E10', 'E5'], diesel: ['B7', 'SDV'] };
  const GRADE_NAMES = { E10: 'Unleaded (E10)', E5: 'Super unleaded (E5)', B7: 'Diesel (B7)', SDV: 'Super diesel' };
  const HERO = {
    trip: ['How much will<br /><span class="accent">the drive cost?</span>', "Enter your reg, pick where you're going, and get the distance and fuel cost in seconds."],
    near: ['Where is fuel<br /><span class="accent">cheapest near you?</span>', 'Pick a town, postcode or your location to see live pump prices around it.'],
  };

  const saved = JSON.parse(localStorage.getItem('tripxyz') || '{}');
  const state = {
    mode: saved.mode || 'trip',
    trip: saved.trip || 'single',
    fuel: saved.fuel || 'petrol',
    fuels: { ...structuredClone(DEFAULTS), ...(saved.fuels || {}) },
    mileage: saved.mileage || null,
    people: 1,
    from: null, to: null, nearPlace: null,
    route: null,
    routeStations: [],
    near: null,
    nearFuel: saved.nearFuel || 'petrol',
    radius: saved.radius || 3,
    detour: saved.detour || 1,
    showPrices: saved.showPrices ?? true,
    tescoOnly: false,
    sortPrice: true,
    priceMode: 'manual',
    priceSource: null,
    prices: { loaded: false, updatedAt: null, index: null, count: 0, averages: null },
  };
  const persist = () => localStorage.setItem('tripxyz', JSON.stringify({
    mode: state.mode, trip: state.trip, fuel: state.fuel, fuels: state.fuels, mileage: state.mileage,
    nearFuel: state.nearFuel, radius: state.radius, detour: state.detour, showPrices: state.showPrices,
  }));

  // ---------------------------------------------------------------- helpers
  const gbp = (n) => n.toLocaleString('en-GB', { style: 'currency', currency: 'GBP' });
  const fmt = (n, d = 0) => n.toLocaleString('en-GB', { maximumFractionDigits: d, minimumFractionDigits: d });
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function getJson(url, options) {
    const r = await fetch(url, options);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { status: r.status, code: data.code });
    return data;
  }
  function duration(sec) {
    const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m} min`;
  }
  function ago(iso) {
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) return '';
    const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (mins < 60) return `${mins} min ago`;
    if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`;
    return `${Math.round(mins / 1440)} days ago`;
  }

  // ---------------------------------------------------------------- external services
  const services = {
    async places(q) {
      const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=en&lat=53.5&lon=-2.0`;
      const data = await getJson(url);
      return (data.features || []).map((f) => {
        const p = f.properties;
        const label = p.name || [p.housenumber, p.street].filter(Boolean).join(' ') || p.postcode || p.city;
        const detail = [p.street && p.name ? p.street : null, p.city || p.town || p.county, p.postcode, p.country]
          .filter((x, i, a) => x && x !== label && a.indexOf(x) === i).join(', ');
        return { label, detail, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] };
      });
    },
    async route(a, b) {
      const url = `https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson`;
      const data = await getJson(url).catch(() => { throw new Error('Routing service is unavailable right now.'); });
      if (data.code !== 'Ok' || !data.routes?.length) throw new Error('No driving route found between those places.');
      const best = data.routes[0];
      return { meters: best.distance, seconds: best.duration, geometry: best.geometry };
    },
    vehicle: (reg) => getJson(`${CONFIG.apiBase}api/vehicle?reg=${encodeURIComponent(reg)}`),
    config: () => getJson(`${CONFIG.apiBase}api/config`),
    stations: () => getJson('data/stations.json'),
  };

  // ---------------------------------------------------------------- segmented controls
  function segmented(el, value, onChange) {
    const btns = $$('button', el), thumb = $('.seg-thumb', el);
    const set = (v, fire) => {
      const i = Math.max(0, btns.findIndex((b) => b.dataset.value === String(v)));
      btns.forEach((b, j) => b.setAttribute('aria-checked', String(j === i)));
      thumb.style.width = `calc((100% - 6px) / ${btns.length})`;
      thumb.style.transform = `translateX(${i * 100}%)`;
      if (fire) onChange(btns[i].dataset.value);
    };
    btns.forEach((b) => b.addEventListener('click', () => set(b.dataset.value, true)));
    set(value, false);
    return { set };
  }

  segmented($('#tripType'), state.trip, (v) => { state.trip = v; persist(); render(); });
  const fuelSeg = segmented($('#fuelType'), state.fuel, (v) => {
    state.fuel = v; persist(); syncFuelInputs(); renderMileageHint();
    if (state.route) { applyAutoPrice(); refreshStations(); }
    render();
  });
  segmented($('#detour'), state.detour, (v) => {
    state.detour = Number(v); persist();
    if (state.priceMode === 'auto') applyAutoPrice();
    refreshStations(); render();
  });

  // ---------------------------------------------------------------- mileage
  // No loss for the first 20k miles, then about 1% per 10k miles, capped at 15%.
  // Electric cars lose range more slowly, so they get half the penalty.
  function wearPenalty() {
    const m = Number(state.mileage);
    if (!m || m <= 20000) return 0;
    const p = Math.min(0.15, ((m - 20000) / 10000) * 0.01);
    return state.fuel === 'electric' ? p / 2 : p;
  }
  const effectiveEfficiency = () => state.fuels[state.fuel].efficiency * (1 - wearPenalty());
  const effUnit = () => (state.fuel === 'electric' ? 'mi/kWh' : 'mpg');

  const mileageInput = $('#mileage'), mileageHint = $('#mileageHint');
  if (state.mileage) mileageInput.value = state.mileage;
  function renderMileageHint(prefix = '') {
    const pen = wearPenalty();
    mileageHint.className = 'hint';
    mileageHint.innerHTML = pen
      ? `${prefix}Economy reduced ${fmt(pen * 100, 1)}% for mileage: using <b>${fmt(effectiveEfficiency(), 1)} ${effUnit()}</b>. Clear the mileage if you entered your car's real-world economy.`
      : (prefix || (state.mileage ? 'Low mileage: no adjustment needed.' : ''));
  }
  mileageInput.addEventListener('input', () => {
    const m = parseInt(mileageInput.value, 10);
    state.mileage = m > 0 ? m : null;
    persist(); renderMileageHint(); render();
  });

  // ---------------------------------------------------------------- fuel inputs
  const effInput = $('#efficiency'), priceInput = $('#price');
  function syncFuelInputs() {
    const f = state.fuels[state.fuel], ev = state.fuel === 'electric';
    $('#effLabel').textContent = ev ? 'Efficiency' : 'Fuel economy';
    $('#effUnit').textContent = effUnit();
    $('#priceLabel').textContent = ev ? 'Price per kWh' : 'Price per litre';
    effInput.step = ev ? '0.1' : '1';
    effInput.value = f.efficiency;
    priceInput.value = f.price;
  }
  effInput.addEventListener('input', () => {
    const e = parseFloat(effInput.value);
    if (e > 0) state.fuels[state.fuel].efficiency = e;
    persist(); renderMileageHint(); render();
  });
  priceInput.addEventListener('input', () => {
    const p = parseFloat(priceInput.value);
    if (p > 0) state.fuels[state.fuel].price = p;
    delete state.fuels[state.fuel].livePriceDefault;
    state.priceMode = 'manual'; state.priceSource = null;
    persist(); renderPriceHint(); render();
  });
  syncFuelInputs();
  renderMileageHint();

  $$('.stepper button').forEach((b) => b.addEventListener('click', () => {
    state.people = Math.min(9, Math.max(1, state.people + Number(b.dataset.step)));
    $('#people').textContent = state.people;
    render();
  }));

  // ---------------------------------------------------------------- vehicle lookup
  const regInput = $('#reg'), lookupBtn = $('#lookupBtn'), vMsg = $('#vehicleMsg'), vCard = $('#vehicleCard');
  const carIcon = '<svg viewBox="0 0 24 24"><path d="M5 17h14M3 13l2-6a2 2 0 0 1 1.9-1.4h10.2A2 2 0 0 1 19 7l2 6v4a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H6v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><circle cx="7.5" cy="13.5" r="1"/><circle cx="16.5" cy="13.5" r="1"/></svg>';
  let vehicleLookup = true;

  regInput.addEventListener('input', () => { regInput.value = regInput.value.toUpperCase().replace(/[^A-Z0-9 ]/g, ''); });
  regInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); lookup(); } });
  lookupBtn.addEventListener('click', lookup);

  const showVehicleMessage = (text, warn) => { vMsg.className = warn ? 'hint warn' : 'hint'; vMsg.textContent = text; };

  async function lookup() {
    const reg = regInput.value.replace(/\s/g, '');
    if (!reg) { showVehicleMessage('Enter a registration first.', true); regInput.focus(); return; }
    if (!vehicleLookup) { showVehicleMessage('Registration lookup needs the TripXYZ server. Choose your fuel and economy below.', true); return; }
    lookupBtn.disabled = true; lookupBtn.textContent = '…';
    vMsg.textContent = ''; vCard.classList.add('hidden');
    try {
      const v = await services.vehicle(reg);
      const kind = v.efficiency.kind;
      state.fuel = kind;
      state.fuels[kind].efficiency = kind === 'electric' ? v.efficiency.milesPerKwh : v.efficiency.mpg;
      fuelSeg.set(kind, false); syncFuelInputs(); persist();
      if (state.route) { applyAutoPrice(); refreshStations(); }

      const title = [v.year, v.make, v.model].filter(Boolean).join(' ');
      const meta = [v.colour, v.fuelType && v.fuelType.toLowerCase(), v.engineCapacity && `${v.engineCapacity} cc`].filter(Boolean).join(' · ');
      vCard.innerHTML = `<div class="v-icon">${carIcon}</div><div><div class="v-title">${escapeHtml(title || v.registration)}</div><div class="v-meta">${escapeHtml(meta)}</div></div>`;
      vCard.classList.remove('hidden');
      showVehicleMessage(`Economy ${v.efficiency.source}. You can adjust it below.`);

      if (v.mileage) {
        state.mileage = v.mileage; mileageInput.value = v.mileage; persist();
        const when = new Date(v.motMileageDate).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
        const projected = v.mileage !== Math.round(v.motMileage / 100) * 100;
        renderMileageHint(`Last MOT (${when}): ${fmt(v.motMileage)} miles${projected ? `, so about ${fmt(v.mileage)} today` : ''}. `);
      } else {
        renderMileageHint();
      }
      render();
    } catch (e) {
      showVehicleMessage(e.status === 404 && !e.code ? 'Registration lookup needs the TripXYZ server.' : e.message, true);
    } finally {
      lookupBtn.disabled = false; lookupBtn.textContent = 'Find';
    }
  }

  // ---------------------------------------------------------------- place search
  function autocomplete(input, key) {
    const list = input.parentElement.querySelector('.suggest');
    let items = [], active = -1, seq = 0;
    const close = () => { list.classList.remove('open'); active = -1; };
    const choose = (i) => {
      const it = items[i];
      if (!it) return;
      state[key] = it;
      input.value = it.detail ? `${it.label}, ${it.detail.split(',')[0]}` : it.label;
      close();
    };
    const paint = () => {
      list.innerHTML = items.map((it, i) =>
        `<li role="option" aria-selected="${i === active}" data-i="${i}"><div class="s-main">${escapeHtml(it.label)}</div><div class="s-sub">${escapeHtml(it.detail)}</div></li>`).join('');
      list.classList.toggle('open', items.length > 0);
    };
    const search = debounce(async (q) => {
      const my = ++seq;
      try {
        const results = await services.places(q);
        if (my !== seq || document.activeElement !== input) return;
        items = results; active = -1; paint();
      } catch { /* transient search errors are ignored */ }
    }, 250);

    input.addEventListener('input', () => {
      state[key] = null;
      const q = input.value.trim();
      if (q.length < 2) { items = []; close(); return; }
      search(q);
    });
    input.addEventListener('keydown', (e) => {
      if (!list.classList.contains('open')) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; paint(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; paint(); }
      else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(active); }
      else if (e.key === 'Escape') close();
    });
    list.addEventListener('mousedown', (e) => {
      const li = e.target.closest('li');
      if (!li) return;
      e.preventDefault(); choose(Number(li.dataset.i));
    });
    input.addEventListener('blur', () => setTimeout(close, 120));
  }
  autocomplete($('#from'), 'from');
  autocomplete($('#to'), 'to');
  autocomplete($('#nearPlace'), 'nearPlace');

  async function resolve(key, input) {
    if (state[key]) return state[key];
    const q = input.value.trim();
    if (!q) throw new Error({ from: 'Enter a starting point.', to: 'Enter a destination.' }[key] || 'Enter a town, postcode or address.');
    const results = await services.places(q);
    if (!results.length) throw new Error(`Couldn't find “${q}”.`);
    state[key] = results[0];
    return results[0];
  }

  function useMyLocation(button, key, input, onDone, onError) {
    if (!navigator.geolocation) return onError('Location is not available in this browser.');
    button.classList.add('locating');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        button.classList.remove('locating');
        state[key] = { label: 'My location', detail: '', lat: pos.coords.latitude, lon: pos.coords.longitude };
        input.value = 'My location';
        onDone?.();
      },
      () => { button.classList.remove('locating'); onError('Could not get your location. Check browser permissions.'); },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  $('#swapBtn').addEventListener('click', () => {
    const f = $('#from'), t = $('#to');
    [f.value, t.value] = [t.value, f.value];
    [state.from, state.to] = [state.to, state.from];
  });
  $('#locateBtn').addEventListener('click', () => useMyLocation($('#locateBtn'), 'from', $('#from'), null, showError));

  // ---------------------------------------------------------------- live prices
  async function loadPrices() {
    try {
      const data = await services.stations();
      const stations = TripGeo.decode(data);
      state.prices = {
        loaded: true, updatedAt: data.updatedAt, count: stations.length,
        index: TripGeo.createIndex(stations), averages: TripGeo.medians(stations),
      };
      applyLiveDefaults();
    } catch {
      state.prices.loaded = false;
    }
    refreshStations();
  }

  function applyLiveDefaults() {
    const avg = state.prices.averages;
    if (!avg) return;
    const builtIn = { petrol: [135.9, DEFAULTS.petrol.price], diesel: [141.9, DEFAULTS.diesel.price] };
    for (const [fuel, grade] of [['petrol', 'E10'], ['diesel', 'B7']]) {
      const f = state.fuels[fuel];
      if (avg[grade] && (builtIn[fuel].includes(f.price) || f.livePriceDefault)) {
        f.price = avg[grade];
        f.livePriceDefault = true;
      }
    }
    if (state.priceMode !== 'auto') syncFuelInputs();
    persist();
  }

  const curFuel = () => (state.mode === 'near' ? state.nearFuel : state.fuel);
  const curStations = () => (state.mode === 'near' ? state.near?.stations || [] : state.routeStations);
  const limit = () => (state.mode === 'near' ? state.radius : state.detour);

  function priceAt(s) {
    for (const g of GRADES[curFuel()] || []) if (s.prices[g]) return { grade: g, p: s.prices[g] };
    return null;
  }
  function visibleStations() {
    if (!GRADES[curFuel()]) return [];
    return curStations().filter((s) => s.off <= limit() && priceAt(s));
  }
  const cheapest = (list) => list.reduce((best, s) => (!best || priceAt(s).p < priceAt(best).p ? s : best), null);

  function applyAutoPrice() {
    const list = visibleStations();
    const pick = cheapest(list.filter((s) => s.tesco)) || cheapest(list);
    state.priceSource = pick;
    if (pick) {
      state.priceMode = 'auto';
      state.fuels[state.fuel].price = priceAt(pick).p;
      priceInput.value = priceAt(pick).p;
      persist();
    }
    renderPriceHint();
  }

  function setPriceFrom(s, fuel = state.fuel) {
    const pr = priceAt(s);
    if (!pr) return;
    state.fuels[fuel].price = pr.p;
    priceInput.value = pr.p;
    state.priceMode = s === state.priceSource ? 'auto' : 'manual';
    persist();
    if (state.priceMode === 'auto') renderPriceHint();
    else showPriceHint(`<span class="tag live">LIVE</span> <span>Using <b>${escapeHtml(s.name)}</b>${s.postcode ? `, ${escapeHtml(s.postcode)}` : ''}.</span>`, state.route);
    render();
  }

  const priceHint = $('#priceHint');
  function showPriceHint(html, withReset) {
    priceHint.className = 'hint price-hint';
    priceHint.innerHTML = html + (withReset ? ' <button type="button" class="link-btn" data-action="use-tesco">Use cheapest Tesco on route</button>' : '');
  }
  priceHint.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="use-tesco"]')) { applyAutoPrice(); refreshStations(); render(); }
  });

  function renderPriceHint() {
    if (state.fuel === 'electric' || !state.route) { priceHint.innerHTML = ''; return; }
    if (state.priceMode === 'auto' && state.priceSource) {
      const s = state.priceSource;
      const label = s.tesco ? 'Cheapest Tesco on your route' : 'No Tesco on your route. Cheapest station';
      return showPriceHint(`<span class="tag live">LIVE</span> <span>${label}: <b>${escapeHtml(s.name)}</b>${s.postcode ? `, ${escapeHtml(s.postcode)}` : ''}</span>`);
    }
    if (visibleStations().length) return showPriceHint('<span>Using your own price.</span>', true);
    if (!state.prices.loaded) return showPriceHint('<span>Live prices are unavailable right now.</span>');
    showPriceHint('<span>No stations with live prices within your detour. Try a wider detour.</span>');
  }

  // ---------------------------------------------------------------- map
  let map, routeLayer, endpointMarkers = [], stationLayer, nearCircle, nearPin;
  const stationMarkers = new Map();
  const pinIcon = (cls) => L.divIcon({ className: '', html: `<div class="map-pin ${cls}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] });

  if (window.L) {
    map = L.map('map', { zoomControl: true }).setView([54.2, -2.5], 5);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, className: 'dark-tiles', attribution: '© OpenStreetMap',
    }).addTo(map);
    stationLayer = L.layerGroup().addTo(map);

    let zoomedIn = null;
    map.on('zoomend', () => {
      const z = map.getZoom() >= 12;
      if (z !== zoomedIn && stationMarkers.size) drawStations();
      zoomedIn = z;
    });

    map.getContainer().addEventListener('click', (e) => {
      const btn = e.target.closest('button.pp-btn');
      if (!btn) return;
      const s = curStations().find((x) => x.id === btn.dataset.id);
      if (!s) return;
      map.closePopup();
      if (state.mode === 'near') {
        const fuel = state.nearFuel, pr = priceAt(s);
        setMode('trip');
        state.fuel = fuel; fuelSeg.set(fuel, false); syncFuelInputs(); renderMileageHint();
        state.fuels[fuel].price = pr.p; priceInput.value = pr.p;
        state.priceMode = 'manual'; state.priceSource = null; persist();
        showPriceHint(`<span class="tag live">LIVE</span> <span>Using <b>${escapeHtml(s.name)}</b>${s.postcode ? `, ${escapeHtml(s.postcode)}` : ''}.</span>`);
        render();
      } else {
        setPriceFrom(s);
      }
    });
  }

  function clearMap() {
    if (!map) return;
    routeLayer?.remove(); routeLayer = null;
    endpointMarkers.forEach((m) => m.remove()); endpointMarkers = [];
    nearCircle?.remove(); nearCircle = null;
    nearPin?.remove(); nearPin = null;
    stationLayer.clearLayers(); stationMarkers.clear();
  }

  function drawRoute() {
    if (!map || !state.route) return;
    const { geometry, a, b } = state.route;
    const glow = L.geoJSON(geometry, { style: { color: '#4caf7d', weight: 12, opacity: 0.2 } });
    const line = L.geoJSON(geometry, { style: { color: '#4caf7d', weight: 4.5, opacity: 1 } });
    routeLayer = L.layerGroup([glow, line]).addTo(map);
    endpointMarkers = [
      L.marker([a.lat, a.lon], { icon: pinIcon('start'), zIndexOffset: 2000 }).addTo(map),
      L.marker([b.lat, b.lon], { icon: pinIcon('end'), zIndexOffset: 2000 }).addTo(map),
    ];
    return line.getBounds();
  }

  function drawNearArea() {
    if (!map || !state.near) return;
    const { lat, lon } = state.near.place;
    nearCircle = L.circle([lat, lon], {
      radius: state.radius * METERS_PER_MILE, color: '#4caf7d', weight: 1.5, opacity: 0.7,
      fillColor: '#004225', fillOpacity: 0.18, interactive: false,
    }).addTo(map);
    nearPin = L.marker([lat, lon], { icon: pinIcon('start'), zIndexOffset: 2000 }).addTo(map);
    return nearCircle.getBounds();
  }

  function stationIcon(s, best, label) {
    const cls = `${s.tesco ? 'tesco' : ''} ${best ? 'best' : ''}`;
    const html = label
      ? `<div class="st-pill ${cls}">${fmt(priceAt(s).p, 1)}</div>`
      : `<div class="st-dot ${cls}"></div>`;
    return L.divIcon({ className: 'st-icon', html, iconSize: [0, 0] });
  }

  const whereText = (s, short) => (state.mode === 'near' || s.along == null
    ? `${fmt(s.off, 1)} mi away`
    : short ? `${fmt(s.along, 0)} mi in · ${fmt(s.off, 1)} mi off` : `${fmt(s.along, 0)} mi into the trip · ${fmt(s.off, 1)} mi off route`);

  const POPUP_OPTIONS = { maxWidth: 270, autoPanPaddingTopLeft: [12, 56], autoPanPaddingBottomRight: [12, 16] };
  const isApple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent) && (navigator.maxTouchPoints > 1 || /iPhone|iPod/.test(navigator.userAgent));
  const directionsUrl = (s) => (isApple
    ? `https://maps.apple.com/?daddr=${s.lat},${s.lon}&dirflg=d`
    : `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}&travelmode=driving`);

  function popupHtml(s) {
    const sel = priceAt(s)?.grade;
    const rows = Object.entries(s.prices).map(([g, p]) =>
      `<span class="${g === sel ? 'sel' : ''}">${GRADE_NAMES[g] || g}</span><span class="${g === sel ? 'sel' : ''}">${fmt(p, 1)}p</span>`).join('');
    const updated = ago(s.updated);
    const brand = s.brand && !s.name.toLowerCase().startsWith(s.brand.toLowerCase()) ? `<div class="pp-brand">${escapeHtml(s.brand)}</div>` : '';
    return `<div class="pp-title">${escapeHtml(s.name)} ${s.tesco ? '<span class="tag tesco">TESCO</span>' : ''}</div>
      ${brand}
      <div class="pp-addr">${escapeHtml(s.address)}</div>
      ${s.postcode ? `<div class="pp-postcode">${escapeHtml(s.postcode)}</div>` : ''}
      <div class="pp-prices">${rows}</div>
      <div class="pp-meta">${whereText(s)}${updated ? ` · updated ${updated}` : ''}</div>
      <div class="pp-actions">
        <a class="pp-btn pp-dir" href="${directionsUrl(s)}" target="_blank" rel="noopener">Directions</a>
        <button class="pp-btn" data-id="${escapeHtml(s.id)}">${state.mode === 'near' ? 'Use price' : 'Use this price'}</button>
      </div>`;
  }

  function drawStations() {
    if (!map) return;
    stationLayer.clearLayers(); stationMarkers.clear();
    const list = state.showPrices ? visibleStations() : [];
    $('#mapLegend').classList.toggle('hidden', !list.length);
    if (!list.length) return;

    const best = cheapest(list);
    const byPrice = [...list].sort((a, b) => priceAt(a).p - priceAt(b).p);
    let labelled = null;
    if (list.length > 25 && map.getZoom() < 12) {
      labelled = new Set(byPrice.slice(0, 10));
      const tesco = byPrice.find((s) => s.tesco);
      if (tesco) labelled.add(tesco);
    }
    [...byPrice].reverse().forEach((s) => {
      const isBest = s === best;
      const label = !labelled || labelled.has(s);
      const marker = L.marker([s.lat, s.lon], {
        icon: stationIcon(s, isBest, label),
        zIndexOffset: isBest ? 1500 : label ? 800 : s.tesco ? 500 : 0,
        keyboard: false,
      }).bindPopup(() => popupHtml(s), POPUP_OPTIONS);
      stationLayer.addLayer(marker);
      stationMarkers.set(s.id, marker);
    });
  }

  $('#showPrices').checked = state.showPrices;
  $('#showPrices').addEventListener('change', (e) => { state.showPrices = e.target.checked; persist(); drawStations(); });

  // ---------------------------------------------------------------- station list
  const stopsCard = $('#stopsCard');
  $('#tescoOnly').addEventListener('change', (e) => { state.tescoOnly = e.target.checked; renderStops(); });
  $('#sortPrice').addEventListener('change', (e) => { state.sortPrice = e.target.checked; renderStops(); });

  function focusStation(id) {
    const s = curStations().find((x) => x.id === id);
    if (!s || !map) return;
    map.flyTo([s.lat, s.lon], Math.max(map.getZoom(), 13), { duration: 0.8 });
    setTimeout(() => {
      const m = stationMarkers.get(id);
      if (m) m.openPopup();
      else L.popup(POPUP_OPTIONS).setLatLng([s.lat, s.lon]).setContent(popupHtml(s)).openOn(map);
    }, 900);
    if (window.innerWidth <= 960) $('.map-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function highlight(label, s, cls = '') {
    if (!s) return `<div class="hl empty"><div class="hl-lbl">${label}</div><div class="hl-meta">None in range</div></div>`;
    return `<button type="button" class="hl ${cls}" data-id="${escapeHtml(s.id)}">
      <div class="hl-lbl">${label}</div>
      <div class="hl-price">${fmt(priceAt(s).p, 1)}p</div>
      <div class="hl-name">${escapeHtml(s.name)}</div>
      <div class="hl-meta">${whereText(s, true)}</div>
    </button>`;
  }

  function renderStops() {
    const near = state.mode === 'near';
    const show = state.prices.loaded && (near ? state.near : state.route && GRADES[state.fuel]);
    stopsCard.classList.toggle('hidden', !show);
    if (!show) return;

    $('#stopsTitle').textContent = near ? `Fuel prices near ${state.near.place.label}` : 'Fuel stations on your route';
    $('#detour').classList.toggle('hidden', near);

    const all = visibleStations();
    const best = cheapest(all), tesco = cheapest(all.filter((s) => s.tesco));
    const tescoCount = all.filter((s) => s.tesco).length;
    const grade = GRADE_NAMES[GRADES[curFuel()][0]];
    $('#stopsSub').textContent = `${all.length} stations selling ${grade} · ${tescoCount} Tesco · prices updated ${ago(state.prices.updatedAt)}`;
    $('#highlights').innerHTML = all.length
      ? highlight('<span class="tag tesco">TESCO</span> Cheapest Tesco', tesco) + highlight(near ? '★ Cheapest nearby' : '★ Cheapest on route', best, 'best')
      : '';

    const order = (s) => (near ? s.off : s.along);
    const list = (state.tescoOnly ? all.filter((s) => s.tesco) : all)
      .sort(state.sortPrice ? (a, b) => priceAt(a).p - priceAt(b).p || order(a) - order(b) : (a, b) => order(a) - order(b));

    $('#stopsList').innerHTML = list.length ? list.slice(0, 60).map((s) => {
      const pr = priceAt(s);
      const tag = s.tesco && !/tesco/i.test(s.name) ? ' <span class="tag tesco">TESCO</span>' : '';
      return `<li data-id="${escapeHtml(s.id)}" class="${s === best ? 'best' : ''}">
        <span class="s-name">${escapeHtml(s.name)}${tag}</span>
        <span class="s-price">${fmt(pr.p, 1)}p<small>${pr.grade}</small></span>
        <span class="s-meta">${whereText(s, true)} · ${escapeHtml([s.postcode, s.address].filter(Boolean).join(' · '))}</span>
      </li>`;
    }).join('') : `<li class="none">${near ? 'No stations match. Try a bigger radius.' : 'No stations match. Try a wider detour.'}</li>`;
  }
  $('#stopsList').addEventListener('click', (e) => { const li = e.target.closest('li[data-id]'); if (li) focusStation(li.dataset.id); });
  $('#highlights').addEventListener('click', (e) => { const b = e.target.closest('.hl[data-id]'); if (b) focusStation(b.dataset.id); });

  function refreshStations() { drawStations(); renderStops(); renderPriceHint(); }

  // ---------------------------------------------------------------- modes
  function setMode(mode) {
    state.mode = mode; persist();
    modeSeg.set(mode, false);
    $('.hero h1').innerHTML = HERO[mode][0];
    $('.hero p').textContent = HERO[mode][1];
    $('#tripForm').classList.toggle('hidden', mode !== 'trip');
    $('#nearForm').classList.toggle('hidden', mode !== 'near');
    $('#resultCard').classList.toggle('hidden', mode !== 'trip');
    clearMap();
    if (mode === 'trip') drawRoute(); else drawNearArea();
    refreshStations();
    map?.invalidateSize();
  }
  const modeSeg = segmented($('#mode'), state.mode, setMode);

  // ---------------------------------------------------------------- area search
  const nearForm = $('#nearForm'), nearMsg = $('#nearMsg'), nearBtn = $('#nearBtn');
  segmented($('#nearFuel'), state.nearFuel, (v) => { state.nearFuel = v; persist(); if (state.mode === 'near') refreshStations(); });
  segmented($('#radius'), state.radius, (v) => { state.radius = Number(v); persist(); if (state.near) nearForm.requestSubmit(); });
  $('#nearLocateBtn').addEventListener('click', () => useMyLocation(
    $('#nearLocateBtn'), 'nearPlace', $('#nearPlace'),
    () => nearForm.requestSubmit(),
    (m) => { nearMsg.textContent = m; },
  ));

  nearForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    nearMsg.textContent = '';
    if (!state.prices.loaded) { nearMsg.textContent = 'Live prices are unavailable right now. Try again shortly.'; return; }
    nearBtn.classList.add('loading'); nearBtn.disabled = true;
    try {
      const place = await resolve('nearPlace', $('#nearPlace'));
      state.near = { place, stations: state.prices.index.near(place.lat, place.lon, state.radius) };
      clearMap();
      const bounds = drawNearArea();
      refreshStations();
      if (bounds) map.fitBounds(bounds, { padding: [24, 24] });
      if (window.innerWidth <= 960) $('.map-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      nearMsg.textContent = err.message;
    } finally {
      nearBtn.classList.remove('loading'); nearBtn.disabled = false;
    }
  });

  // ---------------------------------------------------------------- trip calculation
  const tripForm = $('#tripForm'), calcBtn = $('#calcBtn'), formMsg = $('#formMsg');
  function showError(m) { formMsg.textContent = m; }

  tripForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    calcBtn.classList.add('loading'); calcBtn.disabled = true;
    try {
      const a = await resolve('from', $('#from'));
      const b = await resolve('to', $('#to'));
      const r = await services.route(a, b);
      state.route = { ...r, a, b };
      state.routeStations = state.prices.index ? state.prices.index.alongRoute(r.geometry.coordinates, ROUTE_SEARCH_MILES) : [];
      clearMap();
      const bounds = drawRoute();
      if (GRADES[state.fuel]) applyAutoPrice();
      refreshStations();
      if (bounds) map.fitBounds(bounds, { padding: [36, 36] });
      render(true);
      if (window.innerWidth <= 960) $('#resultCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      showError(err.message);
    } finally {
      calcBtn.classList.remove('loading'); calcBtn.disabled = false;
    }
  });

  let shownCost = 0, raf;
  function animateCost(el, to) {
    cancelAnimationFrame(raf);
    const from = shownCost, start = performance.now();
    const tick = (t) => {
      const k = Math.min(1, (t - start) / 700);
      shownCost = from + (to - from) * (1 - Math.pow(1 - k, 3));
      el.textContent = gbp(shownCost);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  function render(fresh = false) {
    const ret = state.trip === 'return';
    $('#resBadge').textContent = ret ? 'Return trip' : 'One way';
    const r = state.route;
    if (!r) return;

    const legs = ret ? 2 : 1;
    const oneWayMiles = r.meters / METERS_PER_MILE;
    const miles = oneWayMiles * legs;
    const km = (r.meters / 1000) * legs;
    const price = state.fuels[state.fuel].price;
    const efficiency = effectiveEfficiency();
    const ev = state.fuel === 'electric';
    const units = ev ? miles / efficiency : (miles / efficiency) * LITRES_PER_GALLON;
    const cost = (units * price) / 100;

    const card = $('#resultCard');
    card.classList.add('has');
    if (fresh) { card.classList.remove('pop'); void card.offsetWidth; card.classList.add('pop'); }

    animateCost($('#resCost'), cost);
    $('#resTripLabel').textContent = ret ? 'Estimated fuel cost, there and back' : 'Estimated fuel cost';
    $('#resPerPerson').textContent = state.people > 1 ? `${gbp(cost / state.people)} each between ${state.people} people` : ' ';
    $('#resDist').textContent = `${fmt(miles, miles < 100 ? 1 : 0)} mi`;
    $('#resDistSub').textContent = ret ? `${fmt(oneWayMiles, oneWayMiles < 100 ? 1 : 0)} mi each way` : `${fmt(km, 0)} km`;
    $('#resTime').textContent = duration(r.seconds * legs);
    $('#resFuelLbl').textContent = ev ? 'Energy used' : 'Fuel used';
    $('#resFuel').textContent = ev ? `${fmt(units, 1)} kWh` : `${fmt(units, 1)} L`;
    $('#resFuelSub').textContent = `at ${fmt(efficiency, 1)} ${effUnit()} · ${fmt(price, 1)}p`;
    $('#resPerMile').textContent = `${fmt((cost / miles) * 100, 1)}p`;
  }

  // ---------------------------------------------------------------- start up
  if (state.mode !== 'trip') setMode(state.mode);
  loadPrices();
  services.config()
    .then((c) => { vehicleLookup = Boolean(c.vehicleLookup); })
    .catch(() => { vehicleLookup = false; })
    .finally(() => {
      if (!vehicleLookup) showVehicleMessage('Registration lookup is off on this site. Choose your fuel and enter your economy below.');
    });
})();
