// Downloads public EV charge points from GRIDSERVE (OCPI format) and Open Charge Map,
// and merges them into one list.
const fs = require('fs');
const path = require('path');
const { encodeChargers, createIndex } = require('./public/geo');
const opencharge = require('./lib/opencharge');

const CFG = {
  apiKey: process.env.GRIDSERVE_API_KEY || '',
  baseUrl: (process.env.GRIDSERVE_BASE_URL || 'https://api.gridserve.com/ocpi/v1').replace(/\/$/, ''),
  refreshMs: (Number(process.env.CHARGER_REFRESH_MINUTES) || 360) * 60_000,
};
const CONFIGURED = Boolean(CFG.apiKey) || opencharge.CONFIGURED;
const CACHE_FILE = path.join(__dirname, 'data', 'chargers.json');
const OCM_CACHE_FILE = process.env.OCM_CACHE_FILE || path.join(__dirname, 'data', 'ocm-cache.json');
const PAGE_SIZE = 500;
const MAX_PAGES = 100;

const state = { updatedAt: null, count: 0, loading: false, error: null };

async function apiGet(endpoint, params = {}) {
  const url = `${CFG.baseUrl}${endpoint}${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ''}`;
  const r = await fetch(url, { headers: { 'ec-subscription-key': CFG.apiKey, Accept: 'application/json' } });
  if (r.status === 401 || r.status === 403) throw new Error(`GRIDSERVE rejected the API key (${r.status}).`);
  if (!r.ok) throw new Error(`GRIDSERVE ${endpoint} failed (${r.status})`);
  return { body: await r.json(), total: Number(r.headers.get('x-total-count')) || null };
}

// OCPI responses wrap lists as { data: [...] }; GRIDSERVE's examples use { locations: [...] }.
const listFrom = (body, key) => (Array.isArray(body) ? body
  : Array.isArray(body?.[key]) ? body[key]
  : Array.isArray(body?.data) ? body.data
  : Array.isArray(body?.data?.[key]) ? body.data[key] : []);

async function fetchAll(endpoint, key) {
  const rows = [], seen = new Set();
  for (let page = 0; page < MAX_PAGES; page++) {
    const { body, total } = await apiGet(endpoint, { offset: page * PAGE_SIZE, limit: PAGE_SIZE });
    const list = listFrom(body, key);
    const fresh = list.filter((x) => !seen.has(x.id));
    fresh.forEach((x) => seen.add(x.id));
    rows.push(...fresh);
    if (!fresh.length || list.length < PAGE_SIZE || (total && rows.length >= total)) break;
  }
  return rows;
}

// Price per kWh in pence including VAT, from an OCPI tariff.
function pencePerKwh(tariff) {
  for (const element of tariff?.elements || []) {
    for (const c of element.price_components || []) {
      if (c.type === 'ENERGY' && Number(c.price) > 0) {
        const vat = tariff.vat ?? c.vat ?? 0;
        return Math.round(Number(c.price) * (1 + Number(vat) / 100) * 1000) / 10;
      }
    }
  }
  return null;
}

const CONNECTOR_NAMES = {
  IEC_62196_T2_COMBO: 'CCS', IEC_62196_T1_COMBO: 'CCS1', CHADEMO: 'CHAdeMO',
  IEC_62196_T2: 'Type 2', IEC_62196_T1: 'Type 1', DOMESTIC_G: '3-pin', TESLA_S: 'Tesla',
};

// OCPI 2.2 gives max_electric_power in watts; OCPI 2.1 gives voltage and amperage.
function connectorKw(c) {
  if (Number(c.max_electric_power) > 0) return Number(c.max_electric_power) / 1000;
  const v = Number(c.max_voltage ?? c.voltage), a = Number(c.max_amperage ?? c.amperage);
  if (!(v > 0 && a > 0)) return 0;
  const phases = c.power_type === 'AC_3_PHASE' ? 3 : 1;
  return (v * a * (phases === 3 ? Math.sqrt(3) : 1)) / 1000;
}

// GRIDSERVE prefixes site names with a network code.
const NETWORKS = { EH: 'GRIDSERVE Electric Highway', HU: 'GRIDSERVE Electric Hub', EHGV: 'GRIDSERVE Electric Freightway' };
const CONNECTOR_ORDER = ['CCS', 'CHAdeMO', 'Type 2', 'CCS1', 'Type 1', 'Tesla', '3-pin'];

function siteName(loc) {
  const raw = String(loc.name || '').trim();
  const m = raw.match(/^([A-Za-z]{1,5})\s*-\s*(.+)$/);
  const code = m && NETWORKS[m[1].toUpperCase()] ? m[1].toUpperCase() : null;
  const operator = code ? NETWORKS[code]
    : /forecourt/i.test(raw) ? 'GRIDSERVE Electric Forecourt'
    : String(loc.operator?.name || 'GRIDSERVE').replace(/-GRD$/i, '');
  return { name: code ? m[2].trim() : raw || 'GRIDSERVE charge point', operator, forLorries: code === 'EHGV' || /freightway/i.test(loc.operator?.name || '') };
}

const isRemoved = (evse) => ['REMOVED', 'PLANNED'].includes(String(evse.status || '').toUpperCase());

function toCharger(loc, tariffs) {
  const lat = Number(loc.coordinates?.latitude), lon = Number(loc.coordinates?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || loc.publish === false) return null;
  const { name, operator, forLorries } = siteName(loc);
  if (forLorries) return null;
  const evses = (loc.evses || []).filter((e) => !isRemoved(e));
  const connectors = evses.flatMap((e) => e.connectors || []);
  const kws = connectors.map(connectorKw).filter((k) => k > 0);
  const rank = (t) => (CONNECTOR_ORDER.indexOf(t) + 1) || 99;
  const types = [...new Set(connectors.map((c) => CONNECTOR_NAMES[c.standard] || c.standard).filter(Boolean))].sort((a, b) => rank(a) - rank(b));
  // Headline price is the tariff on the fastest connector, since that is what a driver
  // stopping on a journey would use; fall back to the cheapest published tariff.
  const tariffOf = (c) => (c.tariff_ids || (c.tariff_id ? [c.tariff_id] : [])).map((id) => pencePerKwh(tariffs.get(id))).filter((p) => p != null);
  const fastestPriced = [...connectors].sort((x, y) => connectorKw(y) - connectorKw(x)).find((c) => tariffOf(c).length);
  const prices = fastestPriced ? tariffOf(fastestPriced) : [];
  return {
    id: String(loc.id),
    name,
    operator,
    address: [loc.address, loc.city].filter(Boolean).join(', '),
    postcode: String(loc.postal_code || '').toUpperCase(),
    lat, lon,
    maxKw: kws.length ? Math.round(Math.max(...kws)) : null,
    points: evses.length || connectors.length,
    connectors: types,
    price: prices.length ? Math.min(...prices) : null,
  };
}

async function downloadGridserve() {
  const [locations, tariffList] = await Promise.all([
    fetchAll('/locations', 'locations'),
    fetchAll('/tariffs', 'tariffs').catch(() => []),
  ]);
  const tariffs = new Map(tariffList.map((t) => [String(t.id), t]));
  return locations.map((l) => toCharger(l, tariffs)).filter(Boolean);
}

// Open Charge Map also lists GRIDSERVE sites. Keep GRIDSERVE's own record, which has
// live tariffs, and drop OCM entries for the same network or within about 80 metres of one.
const SAME_SITE_MILES = 0.05;
function withoutDuplicates(gridserve, others) {
  if (!gridserve.length) return others;
  const index = createIndex(gridserve);
  return others.filter((c) => !/gridserve|electric highway|ecotricity/i.test(c.operator)
    && !index.near(c.lat, c.lon, SAME_SITE_MILES).length);
}

async function download() {
  const [gs, ocm] = await Promise.allSettled([
    CFG.apiKey ? downloadGridserve() : Promise.resolve([]),
    opencharge.load(OCM_CACHE_FILE),
  ]);
  for (const [name, result] of [['GRIDSERVE', gs], ['Open Charge Map', ocm]]) {
    if (result.status === 'rejected') console.error(`  ${name} charge points failed: ${result.reason.message}`);
  }
  const gridserve = gs.status === 'fulfilled' ? gs.value : [];
  const others = ocm.status === 'fulfilled' ? withoutDuplicates(gridserve, ocm.value) : [];
  const chargers = [...gridserve, ...others];
  if (!chargers.length) {
    throw new Error([gs, ocm].map((r) => r.reason?.message).filter(Boolean).join(' ') || 'No charge points returned.');
  }
  return encodeChargers(chargers, new Date().toISOString());
}

function writeCache(data, file = CACHE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}

async function refresh() {
  if (!CONFIGURED || state.loading) return;
  state.loading = true;
  try {
    const data = await download();
    writeCache(data);
    Object.assign(state, { updatedAt: data.updatedAt, count: data.chargers.length, error: null });
    console.log(`  Charge points updated: ${data.chargers.length} locations`);
  } catch (e) {
    state.error = e.message;
    console.error(`  Charge point refresh failed: ${e.message}`);
  } finally {
    state.loading = false;
  }
}

function start() {
  if (!CONFIGURED) return;
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    Object.assign(state, { updatedAt: cached.updatedAt, count: cached.chargers.length });
  } catch { /* no cache yet */ }
  const age = state.updatedAt ? Date.now() - Date.parse(state.updatedAt) : Infinity;
  setTimeout(refresh, age > CFG.refreshMs ? 0 : CFG.refreshMs - age);
  setInterval(refresh, CFG.refreshMs).unref();
}

const status = () => ({ configured: CONFIGURED, ready: state.count > 0, ...state });

module.exports = { start, status, download, writeCache, CACHE_FILE, CONFIGURED };
