// Station data format and spatial search, shared by the browser and Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TripGeo = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const GRADES = ['E10', 'E5', 'B7', 'SDV'];
  const FIELDS = ['id', 'name', 'brand', 'address', 'postcode', 'lat', 'lon', 'updated', ...GRADES];
  const EARTH_RADIUS_MILES = 3958.8;
  const CELL = 0.05;

  // Compact, column-ordered JSON keeps the published file small enough for phones.
  function encode(stations, updatedAt) {
    return {
      updatedAt,
      fields: FIELDS,
      stations: stations.map((s) => [
        s.id, s.name, s.brand, s.address, s.postcode,
        Math.round(s.lat * 1e5) / 1e5, Math.round(s.lon * 1e5) / 1e5, toMinutes(s.updated),
        ...GRADES.map((g) => s.prices[g] ?? null),
      ]),
    };
  }

  function decode(data) {
    const idx = Object.fromEntries((data.fields || FIELDS).map((f, i) => [f, i]));
    return data.stations.map((row) => {
      const prices = {};
      for (const g of GRADES) if (row[idx[g]] != null) prices[g] = row[idx[g]];
      const s = {
        id: row[idx.id], name: row[idx.name], brand: row[idx.brand], address: row[idx.address],
        postcode: row[idx.postcode], lat: row[idx.lat], lon: row[idx.lon], updated: fromMinutes(row[idx.updated]), prices,
      };
      s.tesco = /tesco/i.test(`${s.brand} ${s.name}`);
      return s;
    });
  }

  // Timestamps are stored as whole minutes since 1970 to keep the file small.
  function toMinutes(t) {
    if (t == null || t === '') return null;
    if (typeof t === 'number') return t > 1e11 ? Math.round(t / 60000) : t;
    const iso = String(t).replace(/^(\d{2})\/(\d{2})\/(\d{4})/, '$3-$2-$1');
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? Math.round(ms / 60000) : null;
  }
  const fromMinutes = (m) => (typeof m === 'number' ? new Date(m * 60000).toISOString() : m || null);

  function miles(aLat, aLon, bLat, bLon) {
    const r = Math.PI / 180;
    const dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h));
  }

  function createIndex(stations) {
    const grid = new Map();
    for (const s of stations) {
      const key = `${Math.floor(s.lat / CELL)}:${Math.floor(s.lon / CELL)}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(s);
    }

    function eachNearby(lat, lon, radius, fn) {
      const reachLat = Math.ceil(radius / 69 / CELL) + 1;
      const reachLon = Math.ceil(radius / (69 * Math.cos(lat * Math.PI / 180)) / CELL) + 1;
      const ci = Math.floor(lat / CELL), cj = Math.floor(lon / CELL);
      for (let i = ci - reachLat; i <= ci + reachLat; i++) {
        for (let j = cj - reachLon; j <= cj + reachLon; j++) {
          for (const s of grid.get(`${i}:${j}`) || []) {
            const d = miles(lat, lon, s.lat, s.lon);
            if (d <= radius) fn(s, d);
          }
        }
      }
    }

    // Stations within `radius` miles of a point. `off` is the distance from it.
    function near(lat, lon, radius) {
      const out = [];
      eachNearby(lat, lon, radius, (s, d) => out.push({ ...s, off: round(d, 2) }));
      return out.sort((a, b) => a.off - b.off);
    }

    // Stations within `maxOff` miles of a route given as [[lon, lat], ...].
    // `along` is the distance from the start, `off` the distance from the road.
    function alongRoute(coords, maxOff) {
      const found = new Map();
      const step = 0.25;
      let along = 0;
      const visit = (lat, lon, at) => eachNearby(lat, lon, maxOff, (s, d) => {
        const prev = found.get(s);
        if (!prev || d < prev.off) found.set(s, { off: d, along: at });
      });
      coords.forEach(([lon, lat], k) => {
        if (k === 0) return visit(lat, lon, 0);
        const [plon, plat] = coords[k - 1];
        const seg = miles(plat, plon, lat, lon);
        const n = Math.max(1, Math.ceil(seg / step));
        for (let t = 1; t <= n; t++) {
          const f = t / n;
          visit(plat + (lat - plat) * f, plon + (lon - plon) * f, along + seg * f);
        }
        along += seg;
      });
      return [...found.entries()]
        .map(([s, m]) => ({ ...s, off: round(m.off, 2), along: round(m.along, 1) }))
        .sort((a, b) => a.along - b.along);
    }

    return { near, alongRoute };
  }

  function medians(stations) {
    const out = {};
    for (const g of GRADES) {
      const v = stations.map((s) => s.prices[g]).filter(Boolean).sort((a, b) => a - b);
      if (v.length) out[g] = v[Math.floor(v.length / 2)];
    }
    return out;
  }

  const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

  return { GRADES, encode, decode, createIndex, medians, miles };
});
