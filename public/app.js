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
    stops: [{ id: 1, place: null, text: '' }, { id: 2, place: null, text: '' }],
    nearPlace: null,
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
    chargers: { loaded: false, updatedAt: null, index: null, count: 0 },
    routeChargers: [],
    speeds: new Set(saved.speeds || ['slow', 'fast', 'rapid', 'ultra']),
  };
  const persist = () => localStorage.setItem('tripxyz', JSON.stringify({
    mode: state.mode, trip: state.trip, fuel: state.fuel, fuels: state.fuels, mileage: state.mileage,
    nearFuel: state.nearFuel, radius: state.radius, detour: state.detour, showPrices: state.showPrices,
    speeds: [...state.speeds],
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
    async route(points) {
      const coords = points.map((p) => `${p.lon},${p.lat}`).join(';');
      const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`;
      const data = await getJson(url).catch(() => { throw new Error('Routing service is unavailable right now.'); });
      if (data.code !== 'Ok' || !data.routes?.length) throw new Error('No driving route found between those places.');
      const best = data.routes[0];
      return {
        meters: best.distance, seconds: best.duration, geometry: best.geometry,
        legs: best.legs.map((l) => ({ meters: l.distance, seconds: l.duration })),
      };
    },
    vehicle: (reg) => getJson(`${CONFIG.apiBase}api/vehicle?reg=${encodeURIComponent(reg)}`),
    config: () => getJson(`${CONFIG.apiBase}api/config`),
    stations: () => getJson('data/stations.json'),
    chargers: () => getJson('data/chargers.json'),
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

  segmented($('#tripType'), state.trip, (v) => {
    state.trip = v; persist();
    if (state.route) tripForm.requestSubmit(); else render();
  });
  const fuelSeg = segmented($('#fuelType'), state.fuel, (v) => {
    state.fuel = v; persist(); syncFuelInputs(); renderMileageHint();
    if (v === 'electric') loadChargers();
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
  function autocomplete(input, holder, key) {
    const list = input.parentElement.querySelector('.suggest');
    let items = [], active = -1, seq = 0;
    const close = () => { list.classList.remove('open'); active = -1; };
    const choose = (i) => {
      const it = items[i];
      if (!it) return;
      holder[key] = it;
      input.value = it.detail ? `${it.label}, ${it.detail.split(',')[0]}` : it.label;
      if ('text' in holder) holder.text = input.value;
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
      holder[key] = null;
      if ('text' in holder) holder.text = input.value;
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
  autocomplete($('#nearPlace'), state, 'nearPlace');

  async function resolve(holder, key, input, emptyMessage) {
    if (holder[key]) return holder[key];
    const q = input.value.trim();
    if (!q) throw new Error(emptyMessage);
    const results = await services.places(q);
    if (!results.length) throw new Error(`Couldn't find “${q}”.`);
    holder[key] = results[0];
    return results[0];
  }

  function useMyLocation(button, holder, key, input, onDone, onError) {
    if (!navigator.geolocation) return onError('Location is not available in this browser.');
    button.classList.add('locating');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        button.classList.remove('locating');
        holder[key] = { label: 'My location', detail: '', lat: pos.coords.latitude, lon: pos.coords.longitude };
        input.value = 'My location';
        if ('text' in holder) holder.text = input.value;
        onDone?.();
      },
      () => { button.classList.remove('locating'); onError('Could not get your location. Check browser permissions.'); },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  // ---------------------------------------------------------------- stops
  const MAX_STOPS = 10;
  const letter = (i) => String.fromCharCode(65 + i);
  const stopsEditor = $('#stopsEditor'), addStopBtn = $('#addStopBtn');
  let nextStopId = 3;

  const icons = {
    locate: '<svg viewBox="0 0 24 24"><path d="M12 2v3m0 14v3M2 12h3m14 0h3"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2" class="fill"/></svg>',
    up: '<svg viewBox="0 0 24 24"><path d="m6 15 6-6 6 6"/></svg>',
    remove: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    reverse: '<svg viewBox="0 0 24 24"><path d="M7 4v16M7 4 3 8m4-4 4 4M17 20V4m0 16-4-4m4 4 4-4"/></svg>',
  };

  function placeholderFor(i, n) {
    if (i === 0) return 'Starting point';
    if (i === n - 1) return 'Destination';
    return `Stop ${letter(i)}`;
  }

  function renderStopInputs(focusId) {
    const n = state.stops.length;
    stopsEditor.innerHTML = state.stops.map((stop, i) => `
      <div class="stop-row ${i === 0 ? 'first' : ''} ${i === n - 1 ? 'last' : ''}" data-id="${stop.id}">
        <span class="stop-badge" aria-hidden="true">${letter(i)}</span>
        <div class="field ac">
          <input placeholder="${placeholderFor(i, n)}" aria-label="${placeholderFor(i, n)}" value="${escapeHtml(stop.text)}" />
          ${i === 0 ? `<button type="button" class="icon-btn" data-action="locate" title="Use my location" aria-label="Use my location">${icons.locate}</button>` : ''}
          <ul class="suggest" role="listbox"></ul>
        </div>
        <div class="stop-actions">
          ${i > 0 ? `<button type="button" class="icon-btn" data-action="up" title="Move up" aria-label="Move stop ${letter(i)} up">${icons.up}</button>` : '<span class="icon-spacer"></span>'}
          ${n > 2 ? `<button type="button" class="icon-btn" data-action="remove" title="Remove stop" aria-label="Remove stop ${letter(i)}">${icons.remove}</button>`
            : i === 0 ? `<button type="button" class="icon-btn" data-action="reverse" title="Reverse route" aria-label="Reverse route">${icons.reverse}</button>` : '<span class="icon-spacer"></span>'}
        </div>
      </div>`).join('');

    $$('.stop-row', stopsEditor).forEach((row, i) => {
      const input = $('input', row);
      autocomplete(input, state.stops[i], 'place');
      if (Number(row.dataset.id) === focusId) input.focus();
    });
    addStopBtn.classList.toggle('hidden', n >= MAX_STOPS);
  }

  stopsEditor.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const row = btn.closest('.stop-row');
    const i = state.stops.findIndex((s) => s.id === Number(row.dataset.id));
    const action = btn.dataset.action;
    if (action === 'locate') {
      return useMyLocation(btn, state.stops[i], 'place', $('input', row), null, showError);
    }
    if (action === 'up' && i > 0) [state.stops[i - 1], state.stops[i]] = [state.stops[i], state.stops[i - 1]];
    if (action === 'remove' && state.stops.length > 2) state.stops.splice(i, 1);
    if (action === 'reverse') state.stops.reverse();
    renderStopInputs();
  });

  addStopBtn.addEventListener('click', () => {
    if (state.stops.length >= MAX_STOPS) return;
    const stop = { id: nextStopId++, place: null, text: '' };
    state.stops.push(stop);
    renderStopInputs(stop.id);
  });

  renderStopInputs();

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

  // The charger file is large, so it is only downloaded once someone looks for EV charging.
  let chargersPromise = null;
  function loadChargers() {
    chargersPromise ??= (async () => {
      try {
        const data = await services.chargers();
        const chargers = TripGeo.decodeChargers(data);
        const index = TripGeo.createIndex(chargers);
        state.chargers = { loaded: true, updatedAt: data.updatedAt, count: chargers.length, index };
        if (state.route) state.routeChargers = index.alongRoute(state.route.geometry.coordinates, ROUTE_SEARCH_MILES);
        if (state.near) state.near.chargers = index.near(state.near.place.lat, state.near.place.lon, state.radius);
      } catch {
        state.chargers.loaded = false;
        chargersPromise = null;
      }
      refreshStations();
    })();
    return chargersPromise;
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
  const isEV = () => curFuel() === 'electric';
  const curStations = () => {
    if (state.mode === 'near') return isEV() ? state.near?.chargers || [] : state.near?.stations || [];
    return isEV() ? state.routeChargers : state.routeStations;
  };
  const limit = () => (state.mode === 'near' ? state.radius : state.detour);
  const dataset = () => (isEV() ? state.chargers : state.prices);

  // For fuel stations: the price of the selected grade. For chargers: the price per kWh, if published.
  function priceAt(s) {
    if (s.kind === 'charger') return { grade: `${s.maxKw ?? '?'} kW`, p: s.price ?? null };
    for (const g of GRADES[curFuel()] || []) if (s.prices[g]) return { grade: g, p: s.prices[g] };
    return null;
  }
  function visibleStations() {
    if (isEV()) return curStations().filter((s) => s.off <= limit() && state.speeds.has(s.speed));
    if (!GRADES[curFuel()]) return [];
    return curStations().filter((s) => s.off <= limit() && priceAt(s));
  }
  // Tesla-only sites are left out of "cheapest" because most EVs cannot use them.
  const priced = (list) => list.filter((s) => priceAt(s)?.p != null && !(s.kind === 'charger' && /tesla[- ]only/i.test(s.operator || '')));
  const cheapest = (list) => priced(list).reduce((best, s) => (!best || priceAt(s).p < priceAt(best).p ? s : best), null);
  const fastest = (list) => list.reduce((best, s) => (!best || (s.maxKw || 0) > (best.maxKw || 0) ? s : best), null);
  const SPEED_LABEL = Object.fromEntries(TripGeo.SPEEDS.map((s) => [s.id, s.label]));

  function applyAutoPrice() {
    if (!GRADES[state.fuel]) return;
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
    else showPriceHint(`<span class="tag live">LIVE</span> <span>Using <b>${escapeHtml(s.name)}</b>${s.postcode ? `, ${escapeHtml(s.postcode)}` : ''}.</span>`, state.route && !isEV());
    render();
  }

  const priceHint = $('#priceHint');
  function showPriceHint(html, withReset) {
    priceHint.className = 'hint price-hint';
    priceHint.innerHTML = html + (withReset ? ' <button type="button" class="link-btn" data-action="use-tesco">Use cheapest Tesco on route</button>' : '');
  }
  priceHint.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="use-tesco"]')) { applyAutoPrice(); refreshStations(); render(); }
    if (e.target.closest('[data-action="use-charger"]')) { const c = journeyCharger(); if (c) setPriceFrom(c); }
  });

  // A long trip is charged at rapid or ultra-rapid chargers, so suggest the cheapest paid one.
  // "Free" listings are skipped: they are often out of date or for customers only.
  function journeyCharger() {
    const paid = visibleStations().filter((s) => s.price > 0);
    return cheapest(paid.filter((s) => s.speed === 'rapid' || s.speed === 'ultra')) || cheapest(paid);
  }

  function renderPriceHint() {
    if (!state.route) { priceHint.innerHTML = ''; return; }
    if (state.fuel === 'electric') {
      const c = journeyCharger();
      if (!c) { priceHint.innerHTML = ''; return; }
      const kind = c.speed === 'rapid' || c.speed === 'ultra' ? 'rapid charger' : 'public charger';
      priceHint.className = 'hint price-hint';
      priceHint.innerHTML = `<span>Cheapest ${kind} on your route: <b>${escapeHtml(c.name)}</b>, ${chargerPrice(c, true)}.</span>
        <button type="button" class="link-btn" data-action="use-charger">Use this price</button>`;
      return;
    }
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
  // The map loads asynchronously (Google Maps or OpenStreetMap, see map.js), so every
  // drawing function checks for it and everything is redrawn once it is ready.
  let map = null, routeLayer = null, endpointMarkers = [], nearCircle = null, nearPin = null;
  const stationMarkers = new Map();

  function onMapClick(e) {
    const btn = e.target.closest('button.pp-btn');
    if (!btn) return;
    const s = curStations().find((x) => x.id === btn.dataset.id);
    if (!s) return;
    map.closePopup();
    if (state.mode === 'near') {
      const fuel = state.nearFuel, pr = priceAt(s);
      if (pr?.p == null) return;
      setMode('trip');
      state.fuel = fuel; fuelSeg.set(fuel, false); syncFuelInputs(); renderMileageHint();
      state.fuels[fuel].price = pr.p; priceInput.value = pr.p;
      state.priceMode = 'manual'; state.priceSource = null; persist();
      showPriceHint(`<span class="tag live">LIVE</span> <span>Using <b>${escapeHtml(s.name)}</b>${s.postcode ? `, ${escapeHtml(s.postcode)}` : ''}.</span>`);
      render();
    } else {
      setPriceFrom(s);
    }
  }

  function redrawMap(fit) {
    clearMap();
    const bounds = state.mode === 'trip' ? drawRoute() : drawNearArea();
    drawStations();
    if (fit && bounds) map.fitBounds(bounds, state.mode === 'trip' ? 36 : 24);
  }

  let usingFallback = false;
  async function initMap(useGoogle = true) {
    const el = $('#map');
    el.innerHTML = '';
    try {
      map = await TripMap.createMap(el, {
        ...CONFIG,
        googleMapsKey: useGoogle ? CONFIG.googleMapsKey : '',
        onFail: () => { if (!usingFallback) { usingFallback = true; map = null; initMap(false); } },
      });
    } catch {
      map = null;
      return;
    }
    $('.map-card').classList.toggle('google', map.kind === 'google');
    let zoomedIn = null;
    map.onZoom(() => {
      const z = map.getZoom() >= 12;
      if (z !== zoomedIn && stationMarkers.size) drawStations();
      zoomedIn = z;
    });
    map.container.addEventListener('click', onMapClick);
    redrawMap(true);
  }

  function clearMap() {
    if (!map) return;
    routeLayer?.remove(); routeLayer = null;
    endpointMarkers.forEach((m) => m.remove()); endpointMarkers = [];
    nearCircle?.remove(); nearCircle = null;
    nearPin?.remove(); nearPin = null;
    clearStations();
  }

  function clearStations() {
    stationMarkers.forEach((m) => m.remove());
    stationMarkers.clear();
  }

  function drawRoute() {
    if (!map || !state.route) return;
    const { geometry, points } = state.route;
    routeLayer = map.addRoute(geometry);
    endpointMarkers = points.map((p, i) => map.addMarker({
      lat: p.lat, lon: p.lon, size: 28, zIndex: 2000 + i, title: p.label,
      html: `<div class="stop-pin ${i === 0 ? 'first' : ''} ${i === points.length - 1 ? 'last' : ''}">${letter(i)}</div>`,
    }));
    return routeLayer.bounds;
  }

  function drawNearArea() {
    if (!map || !state.near) return;
    const { lat, lon } = state.near.place;
    nearCircle = map.addCircle(lat, lon, state.radius * METERS_PER_MILE);
    nearPin = map.addMarker({ lat, lon, size: 18, zIndex: 2000, html: '<div class="map-pin start"></div>' });
    return nearCircle.bounds;
  }

  function stationHtml(s, best, label) {
    const ev = s.kind === 'charger';
    const cls = ev ? `ev ${s.speed} ${best ? 'best' : ''}` : `${s.tesco ? 'tesco' : ''} ${best ? 'best' : ''}`;
    const text = ev ? `⚡${s.maxKw ?? '?'}kW` : fmt(priceAt(s).p, 1);
    return label ? `<div class="st-pill ${cls}">${text}</div>` : `<div class="st-dot ${cls}"></div>`;
  }

  function renderLegend(show) {
    const legend = $('#mapLegend');
    legend.classList.toggle('hidden', !show);
    legend.innerHTML = isEV()
      ? '<span><i class="lg ultra"></i>Ultra-rapid</span><span><i class="lg rapid"></i>Rapid</span><span><i class="lg fast"></i>Fast / slow</span>'
      : '<span><i class="lg cheapest"></i>Cheapest</span><span><i class="lg tesco"></i>Tesco</span><span><i class="lg other"></i>Other</span>';
  }

  const whereText = (s, short) => (state.mode === 'near' || s.along == null
    ? `${fmt(s.off, 1)} mi away`
    : short ? `${fmt(s.along, 0)} mi in · ${fmt(s.off, 1)} mi off` : `${fmt(s.along, 0)} mi into the trip · ${fmt(s.off, 1)} mi off route`);

  const isApple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent) && (navigator.maxTouchPoints > 1 || /iPhone|iPod/.test(navigator.userAgent));
  const directionsUrl = (s) => (isApple
    ? `https://maps.apple.com/?daddr=${s.lat},${s.lon}&dirflg=d`
    : `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}&travelmode=driving`);

  const chargerPrice = (s, long) => (s.price === 0 ? 'Free'
    : s.price != null ? `${fmt(s.price, 1)}p${long ? '/kWh' : ''}`
    : long && s.cost ? escapeHtml(s.cost) : long ? 'Not published' : 'price n/a');

  function chargerPopupHtml(s) {
    const speed = TripGeo.SPEEDS.find((x) => x.id === s.speed);
    return `<div class="pp-title">${escapeHtml(s.name)} <span class="tag ev ${s.speed}">${escapeHtml(speed?.label || '')}</span></div>
      <div class="pp-brand">${escapeHtml(s.operator)}</div>
      <div class="pp-addr">${escapeHtml(s.address)}</div>
      ${s.postcode ? `<div class="pp-postcode">${escapeHtml(s.postcode)}</div>` : ''}
      <div class="pp-prices">
        <span>Max power</span><span class="sel">${s.maxKw ? `${s.maxKw} kW` : 'Not published'}</span>
        <span>Chargers</span><span>${s.points || '—'}</span>
        <span>Connectors</span><span>${escapeHtml(s.connectors.join(', ') || '—')}</span>
        <span>Price</span><span>${chargerPrice(s, true)}</span>
      </div>
      <div class="pp-meta">${whereText(s)}</div>
      <div class="pp-actions">
        <a class="pp-btn pp-dir" href="${directionsUrl(s)}" target="_blank" rel="noopener">Directions</a>
        ${s.price != null ? `<button class="pp-btn" data-id="${escapeHtml(s.id)}">${state.mode === 'near' ? 'Use price' : 'Use this price'}</button>` : ''}
      </div>`;
  }

  function popupHtml(s) {
    if (s.kind === 'charger') return chargerPopupHtml(s);
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
    clearStations();
    const list = state.showPrices ? visibleStations() : [];
    renderLegend(list.length > 0);
    if (!list.length) return;

    const ev = isEV();
    const best = ev ? fastest(list) : cheapest(list);
    // Fuel: cheapest first. Chargers: fastest first.
    const byPrice = [...list].sort(ev ? (a, b) => (b.maxKw || 0) - (a.maxKw || 0) : (a, b) => priceAt(a).p - priceAt(b).p);
    let labelled = null;
    if (list.length > 25 && map.getZoom() < 12) {
      labelled = new Set(byPrice.slice(0, 10));
      const tesco = byPrice.find((s) => s.tesco);
      if (tesco) labelled.add(tesco);
    }
    [...byPrice].reverse().forEach((s) => {
      const isBest = s === best;
      const label = !labelled || labelled.has(s);
      const marker = map.addMarker({
        lat: s.lat, lon: s.lon, html: stationHtml(s, isBest, label),
        zIndex: isBest ? 1500 : label ? 800 : s.tesco ? 500 : 0,
        popup: () => popupHtml(s),
      });
      stationMarkers.set(s.id, marker);
    });
  }

  $('#showPrices').checked = state.showPrices;
  $('#showPrices').addEventListener('change', (e) => { state.showPrices = e.target.checked; persist(); drawStations(); });

  // ---------------------------------------------------------------- station list
  const stopsCard = $('#stopsCard');
  $('#tescoOnly').addEventListener('change', (e) => { state.tescoOnly = e.target.checked; renderStops(); });

  const speedFilter = $('#speedFilter');
  speedFilter.innerHTML = TripGeo.SPEEDS.map((s) =>
    `<label class="chip-toggle speed ${s.id}" title="${s.range}"><input type="checkbox" value="${s.id}" ${state.speeds.has(s.id) ? 'checked' : ''} /><span>${s.label}</span></label>`).join('');
  speedFilter.addEventListener('change', (e) => {
    if (e.target.checked) state.speeds.add(e.target.value); else state.speeds.delete(e.target.value);
    persist(); refreshStations();
  });
  $('#sortPrice').addEventListener('change', (e) => { state.sortPrice = e.target.checked; renderStops(); });

  function focusStation(id) {
    const s = curStations().find((x) => x.id === id);
    if (!s || !map) return;
    map.flyTo(s.lat, s.lon, 13);
    setTimeout(() => {
      const m = stationMarkers.get(id);
      if (m) m.openPopup();
      else map.openPopupAt(s.lat, s.lon, popupHtml(s));
    }, 900);
    if (window.innerWidth <= 960) $('.map-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function highlight(label, s, cls = '', value) {
    if (!s) return `<div class="hl empty"><div class="hl-lbl">${label}</div><div class="hl-meta">None in range</div></div>`;
    return `<button type="button" class="hl ${cls}" data-id="${escapeHtml(s.id)}">
      <div class="hl-lbl">${label}</div>
      <div class="hl-price">${value ?? `${fmt(priceAt(s).p, 1)}p`}</div>
      <div class="hl-name">${escapeHtml(s.name)}</div>
      <div class="hl-meta">${whereText(s, true)}</div>
    </button>`;
  }

  function renderStops() {
    const near = state.mode === 'near';
    const show = dataset().loaded && (near ? state.near : state.route);
    stopsCard.classList.toggle('hidden', !show);
    if (!show) return;
    stopsCard.classList.toggle('is-ev', isEV());
    if (isEV()) return renderChargers(near);

    $('#stopsTitle').textContent = near ? `Fuel prices near ${state.near.place.label}` : 'Fuel stations on your route';
    $('#stopsNote').textContent = 'Live prices from the UK Government Fuel Finder scheme. Detour is straight-line distance from the route.';
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
  function renderChargers(near) {
    $('#stopsTitle').textContent = near ? `EV chargers near ${state.near.place.label}` : 'EV chargers on your route';
    $('#detour').classList.toggle('hidden', near);
    $('#stopsNote').textContent = 'Charge points from GRIDSERVE and Open Charge Map. GRIDSERVE prices include VAT; other prices are as listed by the operator. Detour is straight-line distance from the route.';

    const all = visibleStations();
    const anyInRange = curStations().filter((s) => s.off <= limit());
    const counts = TripGeo.SPEEDS.map((sp) => `${anyInRange.filter((s) => s.speed === sp.id).length} ${sp.label.toLowerCase()}`).filter((t) => !t.startsWith('0 '));
    $('#stopsSub').textContent = `${all.length} charging location${all.length === 1 ? '' : 's'} shown${counts.length ? ` · ${counts.join(', ')} in range` : ''} · updated ${ago(state.chargers.updatedAt)}`;

    const fast = fastest(all), cheap = cheapest(all);
    $('#highlights').innerHTML = all.length
      ? highlight('⚡ Fastest', fast, '', fast ? `${fast.maxKw ?? '?'} kW` : '') +
        highlight('★ Cheapest per kWh', cheap, 'best', cheap ? chargerPrice(cheap) : '')
      : '';

    const order = (s) => (near ? s.off : s.along);
    const byPrice = (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity) || (b.maxKw || 0) - (a.maxKw || 0);
    const list = [...all].sort(state.sortPrice ? byPrice : (a, b) => order(a) - order(b));

    $('#stopsList').innerHTML = list.length ? list.slice(0, 60).map((s) => `
      <li data-id="${escapeHtml(s.id)}" class="${s === cheap ? 'best' : ''}">
        <span class="s-name">${escapeHtml(s.name)} <span class="tag ev ${s.speed}">${SPEED_LABEL[s.speed]}</span></span>
        <span class="s-price">${s.maxKw ?? '?'} kW<small>${s.price != null ? chargerPrice(s, true) : 'price n/a'}</small></span>
        <span class="s-meta">${whereText(s, true)} · ${escapeHtml([s.connectors.join(', '), s.postcode].filter(Boolean).join(' · '))}</span>
      </li>`).join('')
      : `<li class="none">${state.speeds.size ? (near ? 'No chargers match. Try a bigger radius or another speed.' : 'No chargers match. Try a wider detour or another speed.') : 'Choose at least one charger speed.'}</li>`;
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
    if (map) { map.resize(); redrawMap(false); }
    renderStops(); renderPriceHint();
  }
  const modeSeg = segmented($('#mode'), state.mode, setMode);

  // ---------------------------------------------------------------- area search
  const nearForm = $('#nearForm'), nearMsg = $('#nearMsg'), nearBtn = $('#nearBtn');
  segmented($('#nearFuel'), state.nearFuel, (v) => {
    state.nearFuel = v; persist();
    if (v === 'electric') loadChargers();
    if (state.mode === 'near') refreshStations();
  });
  segmented($('#radius'), state.radius, (v) => { state.radius = Number(v); persist(); if (state.near) nearForm.requestSubmit(); });
  $('#nearLocateBtn').addEventListener('click', () => useMyLocation(
    $('#nearLocateBtn'), state, 'nearPlace', $('#nearPlace'),
    () => nearForm.requestSubmit(),
    (m) => { nearMsg.textContent = m; },
  ));

  nearForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    nearMsg.textContent = '';
    if (isEV()) await loadChargers();
    if (!dataset().loaded) {
      nearMsg.textContent = isEV() ? 'Charge point data is unavailable right now.' : 'Live prices are unavailable right now. Try again shortly.';
      return;
    }
    nearBtn.classList.add('loading'); nearBtn.disabled = true;
    try {
      const place = await resolve(state, 'nearPlace', $('#nearPlace'), 'Enter a town, postcode or address.');
      state.near = {
        place,
        stations: state.prices.index ? state.prices.index.near(place.lat, place.lon, state.radius) : [],
        chargers: state.chargers.index ? state.chargers.index.near(place.lat, place.lon, state.radius) : [],
      };
      if (map) redrawMap(true);
      renderStops(); renderPriceHint();
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
      const rows = $$('.stop-row', stopsEditor);
      const points = [];
      for (const [i, stop] of state.stops.entries()) {
        const n = state.stops.length;
        const empty = i === 0 ? 'Enter a starting point.' : i === n - 1 ? 'Enter a destination.' : `Enter stop ${letter(i)} or remove it.`;
        points.push(await resolve(stop, 'place', $('input', rows[i]), empty));
      }
      if (state.fuel === 'electric') await loadChargers();
      const roundTrip = state.trip === 'return';
      const r = await services.route(roundTrip ? [...points, points[0]] : points);
      state.route = { ...r, points, roundTrip };
      state.routeStations = state.prices.index ? state.prices.index.alongRoute(r.geometry.coordinates, ROUTE_SEARCH_MILES) : [];
      state.routeChargers = state.chargers.index ? state.chargers.index.alongRoute(r.geometry.coordinates, ROUTE_SEARCH_MILES) : [];
      if (GRADES[state.fuel]) applyAutoPrice();
      if (map) redrawMap(true);
      renderStops(); renderPriceHint();
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
    const r = state.route;
    if (!r) { $('#resBadge').textContent = state.trip === 'return' ? 'Return trip' : 'One way'; return; }

    const miles = r.meters / METERS_PER_MILE;
    const km = r.meters / 1000;
    const legMiles = r.legs.map((l) => l.meters / METERS_PER_MILE);
    const price = state.fuels[state.fuel].price;
    const efficiency = effectiveEfficiency();
    const ev = state.fuel === 'electric';
    const units = ev ? miles / efficiency : (miles / efficiency) * LITRES_PER_GALLON;
    const cost = (units * price) / 100;

    const card = $('#resultCard');
    card.classList.add('has');
    if (fresh) { card.classList.remove('pop'); void card.offsetWidth; card.classList.add('pop'); }

    animateCost($('#resCost'), cost);
    $('#resTripLabel').textContent = r.roundTrip ? 'Estimated fuel cost, there and back' : 'Estimated fuel cost';
    $('#resBadge').textContent = r.points.length > 2
      ? `${r.points.length} stops${r.roundTrip ? ' · return' : ''}`
      : r.roundTrip ? 'Return trip' : 'One way';
    $('#resPerPerson').textContent = state.people > 1 ? `${gbp(cost / state.people)} each between ${state.people} people` : ' ';
    $('#resDist').textContent = `${fmt(miles, miles < 100 ? 1 : 0)} mi`;
    const miText = (m) => `${fmt(m, m < 100 ? 1 : 0)} mi`;
    $('#resDistSub').textContent = r.roundTrip && r.points.length === 2
      ? `${miText(legMiles[0])} each way`
      : r.legs.length > 1 ? `${r.legs.length} legs · ${fmt(km, 0)} km` : `${fmt(km, 0)} km`;
    $('#resTime').textContent = duration(r.seconds);
    const legsList = $('#resLegs');
    legsList.classList.toggle('hidden', r.legs.length < 2);
    legsList.innerHTML = r.legs.map((leg, i) => {
      const to = i + 1 < r.points.length ? i + 1 : 0;
      return `<li><span class="leg-route"><b>${letter(i)}</b><span class="leg-arrow">→</span><b>${letter(to)}</b>
        <span class="leg-name">${escapeHtml(r.points[to].label)}</span></span>
        <span class="leg-stats">${miText(legMiles[i])} · ${duration(leg.seconds)}</span></li>`;
    }).join('');
    $('#resFuelLbl').textContent = ev ? 'Energy used' : 'Fuel used';
    $('#resFuel').textContent = ev ? `${fmt(units, 1)} kWh` : `${fmt(units, 1)} L`;
    $('#resFuelSub').textContent = `at ${fmt(efficiency, 1)} ${effUnit()} · ${fmt(price, 1)}p`;
    $('#resPerMile').textContent = `${fmt((cost / miles) * 100, 1)}p`;
  }

  // ---------------------------------------------------------------- start up
  initMap();
  if (state.mode !== 'trip') setMode(state.mode);
  loadPrices();
  if (state.fuel === 'electric' || state.nearFuel === 'electric') loadChargers();
  services.config()
    .then((c) => { vehicleLookup = Boolean(c.vehicleLookup); })
    .catch(() => { vehicleLookup = false; })
    .finally(() => {
      if (!vehicleLookup) showVehicleMessage('Registration lookup is off on this site. Choose your fuel and enter your economy below.');
    });
})();
