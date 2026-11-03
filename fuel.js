// Downloads every UK forecourt and its prices from the Fuel Finder API.
const fs = require('fs');
const path = require('path');
const { encode } = require('./public/geo');

const CFG = {
  clientId: process.env.FUEL_FINDER_CLIENT_ID || '',
  clientSecret: process.env.FUEL_FINDER_CLIENT_SECRET || '',
  baseUrl: (process.env.FUEL_FINDER_BASE_URL || 'https://www.fuel-finder.service.gov.uk').replace(/\/$/, ''),
  refreshMs: (Number(process.env.FUEL_REFRESH_MINUTES) || 60) * 60_000,
};
const CONFIGURED = Boolean(CFG.clientId && CFG.clientSecret);
const CACHE_FILE = path.join(__dirname, 'data', 'stations.json');
const MIN_GAP_MS = 2100;
const MAX_BATCHES = 80;
const UA = 'TripXYZ/1.0';

const state = { updatedAt: null, count: 0, loading: false, error: null };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRequest = 0;
async function paced(fn) {
  const wait = lastRequest + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequest = Date.now();
  return fn();
}

let token = null, tokenExpiry = 0;
async function getToken() {
  if (token && Date.now() < tokenExpiry) return token;
  const r = await paced(() => fetch(`${CFG.baseUrl}/api/v1/oauth/generate_access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ client_id: CFG.clientId, client_secret: CFG.clientSecret }),
  }));
  const body = await r.json().catch(() => ({}));
  const data = body && typeof body.data === 'object' ? body.data : body;
  if (!r.ok || !data?.access_token) {
    throw new Error(`Fuel Finder sign-in failed (${r.status}). Check FUEL_FINDER_CLIENT_ID and FUEL_FINDER_CLIENT_SECRET.`);
  }
  token = data.access_token;
  tokenExpiry = Date.now() + (Math.max(Number(data.expires_in) || 3600, 120) - 60) * 1000;
  return token;
}

async function apiGet(endpoint, params) {
  const url = `${CFG.baseUrl}${endpoint}?${new URLSearchParams(params)}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const t = await getToken();
    const r = await paced(() => fetch(url, { headers: { Authorization: `Bearer ${t}`, Accept: 'application/json', 'User-Agent': UA } }));
    if (r.status === 401) { token = null; continue; }
    if (r.status === 429) { await sleep(Math.min(60, 5 * 2 ** attempt) * 1000); continue; }
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Fuel Finder ${endpoint} failed (${r.status})`);
    return r.json();
  }
  throw new Error(`Fuel Finder ${endpoint} kept failing.`);
}

async function fetchAll(endpoint) {
  const rows = [];
  let prevSignature = null;
  for (let batch = 1; batch <= MAX_BATCHES; batch++) {
    const payload = await apiGet(endpoint, { 'batch-number': batch });
    if (payload == null) break;
    const list = Array.isArray(payload) ? payload
      : Array.isArray(payload.data) ? payload.data
      : Array.isArray(payload.results) ? payload.results : [];
    if (!list.length) break;
    const signature = `${list.length}:${idOf(list[0])}:${idOf(list[list.length - 1])}`;
    if (signature === prevSignature) break;
    prevSignature = signature;
    rows.push(...list);
    const total = Number(payload.total_batches ?? payload.total_pages ?? payload.meta?.total_batches ?? payload.pagination?.total_pages);
    if (total && batch >= total) break;
  }
  return rows;
}

const idOf = (row) => String(row?.node_id ?? row?.site_id ?? row?.id ?? row?.station_id ?? row?.pfs_id ?? '').trim();

// Retailers report in pounds (1.339), pence (133.9) or tenths of a penny (1339).
function toPence(v) {
  const n = Number(typeof v === 'object' && v !== null ? (v.price ?? v.value ?? v.amount) : v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const p = n < 10 ? n * 100 : n >= 1000 ? n / 10 : n;
  return p >= 50 && p <= 500 ? Math.round(p * 10) / 10 : null;
}

const GRADE = { E10: 'E10', E5: 'E5', B7: 'B7', B7_STANDARD: 'B7', SDV: 'SDV', B7_PREMIUM: 'SDV' };
function pricesOf(row) {
  const prices = {}, times = [];
  let entries = row.fuel_prices ?? row.fuelPrices ?? row.prices ?? [];
  if (!Array.isArray(entries)) {
    entries = Object.entries(entries).map(([k, v]) => (typeof v === 'object' ? { fuel_type: k, ...v } : { fuel_type: k, price: v }));
  }
  for (const e of entries) {
    const grade = GRADE[String(e.fuel_type ?? e.fuelType ?? e.type ?? e.grade ?? '').trim().toUpperCase().replace(/[-\s]/g, '_')];
    const p = toPence(e.price ?? e.value ?? e.pump_price ?? e.pence_per_litre ?? e.amount);
    if (!grade || !p) continue;
    prices[grade] = p;
    const t = e.price_last_updated ?? e.last_updated ?? e.updated_at;
    if (t) times.push(String(t));
  }
  return { prices, updated: times.sort().pop() || null };
}

const isClosed = (row) => Boolean(row.permanent_closure || row.is_permanently_closed || row.permanently_closed
  || row.temporary_closure || row.is_temporarily_closed);

const KEEP_UPPER = new Set(['BP', 'MFG', 'JET', 'EG', 'UK', 'MRH', 'RS', 'SGN']);
const titleCase = (s) => (s ? String(s).toLowerCase().replace(/\b[a-z][a-z']*/g,
  (w) => (KEEP_UPPER.has(w.toUpperCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))) : '');

// "Reading Extra - Petrol Filling Station" with brand Tesco becomes "Tesco Reading Extra".
function displayName(name, brand) {
  let n = name.replace(/\s*-\s*petrol filling station$/i, '').replace(/\s+pfs$/i, '').trim();
  if (brand && !n.toLowerCase().includes(brand.toLowerCase().split(' ')[0])) n = `${brand} ${n}`.trim();
  return n || brand || 'Fuel station';
}

function merge(infoRows, priceRows) {
  const byId = new Map();
  for (const row of infoRows) {
    const id = idOf(row);
    if (!id || isClosed(row)) continue;
    const loc = row.location || {};
    const lat = Number(loc.latitude ?? row.latitude), lon = Number(loc.longitude ?? row.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
    const brand = titleCase(row.brand_name || row.trading_name || '');
    byId.set(id, {
      id,
      name: displayName(titleCase(row.trading_name || row.brand_name || ''), brand),
      brand,
      address: [loc.address_line_1, loc.address_line_2, loc.city].filter(Boolean).map(titleCase).join(', '),
      postcode: (loc.postcode || '').toUpperCase(),
      lat, lon, prices: {}, updated: null,
    });
  }
  for (const row of priceRows) {
    const s = byId.get(idOf(row));
    if (!s) continue;
    const { prices, updated } = pricesOf(row);
    Object.assign(s.prices, prices);
    if (updated && (!s.updated || updated > s.updated)) s.updated = updated;
  }
  return [...byId.values()].filter((s) => Object.keys(s.prices).length);
}

async function download() {
  const info = await fetchAll('/api/v1/pfs');
  const prices = await fetchAll('/api/v1/pfs/fuel-prices');
  const stations = merge(info, prices);
  if (!stations.length) throw new Error('Fuel Finder returned no stations with prices.');
  return encode(stations, new Date().toISOString());
}

function writeCache(data, file = CACHE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}

async function refresh() {
  if (!CONFIGURED || state.loading) return;
  state.loading = true;
  const started = Date.now();
  try {
    const data = await download();
    writeCache(data);
    Object.assign(state, { updatedAt: data.updatedAt, count: data.stations.length, error: null });
    console.log(`  Fuel prices updated: ${data.stations.length} stations in ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (e) {
    state.error = e.message;
    console.error(`  Fuel price refresh failed: ${e.message}`);
  } finally {
    state.loading = false;
  }
}

function start() {
  if (!CONFIGURED) return;
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (Array.isArray(cached.fields)) Object.assign(state, { updatedAt: cached.updatedAt, count: cached.stations.length });
  } catch { /* no cache yet */ }
  const age = state.updatedAt ? Date.now() - Date.parse(state.updatedAt) : Infinity;
  setTimeout(refresh, age > CFG.refreshMs ? 0 : CFG.refreshMs - age);
  setInterval(refresh, CFG.refreshMs).unref();
}

const status = () => ({ configured: CONFIGURED, ready: state.count > 0, ...state });

module.exports = { start, status, download, writeCache, CACHE_FILE, CONFIGURED };
