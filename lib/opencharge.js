// Downloads UK charge points from Open Charge Map and normalises them.
// The full UK list is large, so it is cached on disk and refreshed at most once a day,
// in line with Open Charge Map's fair usage policy.
const fs = require('fs');
const path = require('path');

const CFG = {
  apiKey: process.env.OCM_API_KEY || '',
  baseUrl: (process.env.OCM_BASE_URL || 'https://api.openchargemap.io/v3').replace(/\/$/, ''),
  maxAgeMs: (Number(process.env.OCM_REFRESH_HOURS) || 24) * 3_600_000,
};
const CONFIGURED = Boolean(CFG.apiKey);
const BATCH = 2000;
const MAX_BATCHES = 200;
const UA = 'TripXYZ/1.0 (https://github.com/isheanesumazwi/TripXYZ)';

async function get(endpoint, params) {
  const url = `${CFG.baseUrl}${endpoint}?${new URLSearchParams({ ...params, key: CFG.apiKey })}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { headers: { 'X-API-Key': CFG.apiKey, 'User-Agent': UA, Accept: 'application/json' } });
    if (r.status === 401 || r.status === 403) throw new Error(`Open Charge Map rejected the API key (${r.status}).`);
    if (r.status === 429 || r.status >= 500) { await new Promise((res) => setTimeout(res, 5000 * (attempt + 1))); continue; }
    if (!r.ok) throw new Error(`Open Charge Map ${endpoint} failed (${r.status})`);
    return r.json();
  }
  throw new Error(`Open Charge Map ${endpoint} kept failing.`);
}

// Pages through every UK site in order of last modification, as OCM recommends.
async function fetchAllPois() {
  const byId = new Map();
  let since = '2000-01-01T00:00:00Z';
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const list = await get('/poi', {
      countrycode: 'GB', maxresults: BATCH, compact: 'true', verbose: 'false',
      sortby: 'modified_asc', modifiedsince: since,
    });
    if (!Array.isArray(list) || !list.length) break;
    let added = 0;
    for (const poi of list) if (!byId.has(poi.ID)) { byId.set(poi.ID, poi); added++; }
    const last = list[list.length - 1];
    const next = last.DateLastStatusUpdate || last.DateLastVerified || last.DateCreated;
    if (!added || list.length < BATCH || !next || next === since) break;
    since = next;
  }
  return [...byId.values()];
}

const CONNECTORS = [
  [/ccs|combo/i, 'CCS'], [/chademo/i, 'CHAdeMO'], [/type 2|mennekes|iec 62196-2/i, 'Type 2'],
  [/type 1|j1772/i, 'Type 1'], [/tesla|nacs/i, 'Tesla'], [/bs1363|3 pin|13 amp/i, '3-pin'], [/commando|iec 60309/i, 'Commando'],
];
const CONNECTOR_ORDER = ['CCS', 'CHAdeMO', 'Type 2', 'Type 1', 'Tesla', '3-pin', 'Commando'];
const connectorName = (title) => (CONNECTORS.find(([re]) => re.test(title || '')) || [])[1] || null;

// Typical power when a site lists only its charging level.
const LEVEL_KW = { 1: 3, 2: 7, 3: 50 };

// "£0.79/kWh", "79p per kWh", "Free" -> pence per kWh, or null if not stated per kWh.
function pencePerKwh(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  if (/^\s*free\b/.test(t) || /\bfree (to use|of charge)\b/.test(t)) return 0;
  const pounds = t.match(/£\s*(\d+(?:\.\d+)?)\s*(?:\/|per)\s*kwh/);
  if (pounds) return Math.round(Number(pounds[1]) * 1000) / 10;
  const pence = t.match(/(\d+(?:\.\d+)?)\s*p\s*(?:\/|per)\s*kwh/);
  if (pence) return Math.round(Number(pence[1]) * 10) / 10;
  return null;
}

function toCharger(poi, ref) {
  const a = poi.AddressInfo || {};
  const lat = Number(a.Latitude), lon = Number(a.Longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const status = ref.status.get(poi.StatusTypeID);
  if (status && status.IsOperational === false) return null;
  const usage = ref.usage.get(poi.UsageTypeID);
  if (usage && /private/i.test(usage.Title || '')) return null;

  const connections = (poi.Connections || []).filter((c) => {
    const s = ref.status.get(c.StatusTypeID);
    return !(s && s.IsOperational === false);
  });
  const kws = connections.map((c) => Number(c.PowerKW) || LEVEL_KW[c.LevelID] || 0).filter((k) => k > 0);
  const rank = (t) => (CONNECTOR_ORDER.indexOf(t) + 1) || 99;
  const types = [...new Set(connections.map((c) => connectorName(ref.connection.get(c.ConnectionTypeID)?.Title)).filter(Boolean))]
    .sort((x, y) => rank(x) - rank(y));
  const points = Number(poi.NumberOfPoints) || connections.reduce((n, c) => n + (Number(c.Quantity) || 1), 0);
  const operator = ref.operator.get(poi.OperatorID)?.Title;

  return {
    id: `ocm-${poi.ID}`,
    name: a.Title || operator || 'Charge point',
    operator: operator && !/unknown/i.test(operator) ? operator.replace(/\s*\((uk|gb|united kingdom)\)\s*$/i, '') : 'Independent',
    address: [a.AddressLine1, a.Town].filter(Boolean).join(', '),
    postcode: String(a.Postcode || '').toUpperCase().trim(),
    lat, lon,
    maxKw: kws.length ? Math.round(Math.max(...kws)) : null,
    points,
    connectors: types,
    price: pencePerKwh(poi.UsageCost),
    cost: poi.UsageCost ? String(poi.UsageCost).slice(0, 80) : '',
  };
}

async function download() {
  const data = await get('/referencedata', { countryid: 1 });
  const index = (list) => new Map((list || []).map((x) => [x.ID, x]));
  const ref = {
    status: index(data.StatusTypes), usage: index(data.UsageTypes),
    connection: index(data.ConnectionTypes), operator: index(data.Operators),
  };
  const pois = await fetchAllPois();
  return pois.map((p) => toCharger(p, ref)).filter(Boolean);
}

// Uses the day-old cache when it is fresh enough; otherwise downloads again.
async function load(cacheFile) {
  if (!CONFIGURED) return [];
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (Date.now() - Date.parse(cached.updatedAt) < CFG.maxAgeMs && Array.isArray(cached.chargers)) return cached.chargers;
  } catch { /* no cache yet */ }
  const chargers = await download();
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ updatedAt: new Date().toISOString(), chargers }));
  return chargers;
}

module.exports = { load, CONFIGURED, pencePerKwh };
