// Map layer: Google Maps when a key is configured, otherwise Leaflet with OpenStreetMap.
// Both expose the same small interface, so the rest of the app never touches a map library.
(function () {
  'use strict';

  const UK = { lat: 54.2, lon: -2.5, zoom: 5 };
  const GREEN = '#4caf7d';

  // ---------------------------------------------------------------- Google Maps
  let onLateAuthFailure = null;

  function loadGoogle(key) {
    if (window.google?.maps?.Map) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const cb = `__tripxyzMaps${Date.now()}`;
      const timer = setTimeout(() => reject(new Error('Google Maps took too long to load.')), 15000);
      window[cb] = () => { settled = true; clearTimeout(timer); delete window[cb]; resolve(); };
      // Google calls this when the key is rejected, the API is not enabled, or the site
      // is not on the key's allowed list. It can happen after the map has appeared.
      window.gm_authFailure = () => {
        clearTimeout(timer);
        if (!settled) { settled = true; reject(new Error('Google Maps rejected the API key.')); }
        else onLateAuthFailure?.();
      };
      const s = document.createElement('script');
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&libraries=marker&loading=async&callback=${cb}`;
      s.async = true;
      s.onerror = () => { clearTimeout(timer); reject(new Error('Google Maps could not be loaded.')); };
      document.head.appendChild(s);
    });
  }

  async function createGoogleMap(el, cfg) {
    onLateAuthFailure = () => { console.warn('Google Maps rejected the API key. Falling back to OpenStreetMap.'); cfg.onFail?.(); };
    await loadGoogle(cfg.googleMapsKey);
    const { Map, InfoWindow, Polyline, Circle, LatLngBounds, ColorScheme } = google.maps;
    const { AdvancedMarkerElement } = await google.maps.importLibrary('marker');

    const map = new Map(el, {
      center: { lat: UK.lat, lng: UK.lon }, zoom: UK.zoom,
      mapId: cfg.googleMapId || 'DEMO_MAP_ID',
      colorScheme: ColorScheme?.[cfg.mapColorScheme] ?? ColorScheme?.DARK,
      disableDefaultUI: true, zoomControl: true, clickableIcons: false, gestureHandling: 'greedy',
    });
    const info = new InfoWindow({ maxWidth: 280 });
    const toBounds = (b) => ({ south: b.getSouthWest().lat(), west: b.getSouthWest().lng(), north: b.getNorthEast().lat(), east: b.getNorthEast().lng() });

    return {
      kind: 'google',
      container: el,
      getZoom: () => map.getZoom(),
      onZoom: (fn) => map.addListener('zoom_changed', fn),
      resize: () => {},
      fitBounds(b, padding = 36) {
        map.fitBounds(new LatLngBounds({ lat: b.south, lng: b.west }, { lat: b.north, lng: b.east }), padding);
      },
      flyTo(lat, lon, zoom) {
        map.panTo({ lat, lng: lon });
        if (zoom > map.getZoom()) setTimeout(() => map.setZoom(zoom), 250);
      },
      addRoute(geometry) {
        const path = geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
        const glow = new Polyline({ map, path, strokeColor: GREEN, strokeOpacity: 0.25, strokeWeight: 12, clickable: false });
        const line = new Polyline({ map, path, strokeColor: GREEN, strokeOpacity: 1, strokeWeight: 4.5, clickable: false });
        const bounds = new LatLngBounds();
        path.forEach((p) => bounds.extend(p));
        return { bounds: toBounds(bounds), remove() { glow.setMap(null); line.setMap(null); } };
      },
      addCircle(lat, lon, radius) {
        const circle = new Circle({
          map, center: { lat, lng: lon }, radius, clickable: false,
          strokeColor: GREEN, strokeOpacity: 0.7, strokeWeight: 1.5, fillColor: '#004225', fillOpacity: 0.18,
        });
        return { bounds: toBounds(circle.getBounds()), remove: () => circle.setMap(null) };
      },
      addMarker({ lat, lon, html, zIndex = 0, title, popup }) {
        const content = document.createElement('div');
        content.className = 'gm-pin';
        content.innerHTML = html;
        const marker = new AdvancedMarkerElement({ map, position: { lat, lng: lon }, content, zIndex, title });
        const open = () => { info.setContent(popup()); info.open({ map, anchor: marker }); };
        if (popup) marker.addListener('click', open);
        return { remove: () => { marker.map = null; }, openPopup: popup ? open : () => {} };
      },
      openPopupAt(lat, lon, html) {
        info.setContent(html);
        info.setPosition({ lat, lng: lon });
        info.open({ map });
      },
      closePopup: () => info.close(),
    };
  }

  // ---------------------------------------------------------------- Leaflet
  function createLeafletMap(el) {
    delete el._leaflet_id;
    const map = L.map(el, { zoomControl: true }).setView([UK.lat, UK.lon], UK.zoom);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, className: 'dark-tiles', attribution: '© OpenStreetMap',
    }).addTo(map);
    const popupOptions = { maxWidth: 270, autoPanPaddingTopLeft: [12, 56], autoPanPaddingBottomRight: [12, 16] };
    const toBounds = (b) => ({ south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() });

    return {
      kind: 'leaflet',
      container: el,
      getZoom: () => map.getZoom(),
      onZoom: (fn) => map.on('zoomend', fn),
      resize: () => map.invalidateSize(),
      fitBounds: (b, padding = 36) => map.fitBounds([[b.south, b.west], [b.north, b.east]], { padding: [padding, padding] }),
      flyTo: (lat, lon, zoom) => map.flyTo([lat, lon], Math.max(map.getZoom(), zoom), { duration: 0.8 }),
      addRoute(geometry) {
        const glow = L.geoJSON(geometry, { style: { color: GREEN, weight: 12, opacity: 0.2 } });
        const line = L.geoJSON(geometry, { style: { color: GREEN, weight: 4.5, opacity: 1 } });
        const layer = L.layerGroup([glow, line]).addTo(map);
        return { bounds: toBounds(line.getBounds()), remove: () => layer.remove() };
      },
      addCircle(lat, lon, radius) {
        const circle = L.circle([lat, lon], {
          radius, color: GREEN, weight: 1.5, opacity: 0.7, fillColor: '#004225', fillOpacity: 0.18, interactive: false,
        }).addTo(map);
        return { bounds: toBounds(circle.getBounds()), remove: () => circle.remove() };
      },
      addMarker({ lat, lon, html, zIndex = 0, title, popup, size = 0 }) {
        const icon = size
          ? L.divIcon({ className: '', html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] })
          : L.divIcon({ className: 'st-icon', html, iconSize: [0, 0] });
        const marker = L.marker([lat, lon], { icon, zIndexOffset: zIndex, keyboard: false }).addTo(map);
        if (title) marker.bindTooltip(String(title).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`), { direction: 'top', offset: [0, -size / 2] });
        if (popup) marker.bindPopup(popup, popupOptions);
        return { remove: () => marker.remove(), openPopup: () => marker.openPopup() };
      },
      openPopupAt: (lat, lon, html) => L.popup(popupOptions).setLatLng([lat, lon]).setContent(html).openOn(map),
      closePopup: () => map.closePopup(),
    };
  }

  // ---------------------------------------------------------------- choose
  async function createMap(el, cfg = {}) {
    if (cfg.googleMapsKey) {
      try {
        return await createGoogleMap(el, cfg);
      } catch (e) {
        console.warn(`${e.message} Falling back to OpenStreetMap.`);
        el.innerHTML = '';
      }
    }
    if (!window.L) throw new Error('No map library available.');
    return createLeafletMap(el);
  }

  window.TripMap = { createMap };
})();
