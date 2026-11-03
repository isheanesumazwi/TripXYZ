// TripXYZ local server: serves the app, looks up vehicles and keeps live fuel prices cached.
const http = require('http');
const fs = require('fs');
const path = require('path');

loadEnv(path.join(__dirname, '.env'));
const fuel = require('./fuel');
fuel.start();

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';
const PUBLIC = path.join(__dirname, 'public');
const SNAPSHOT = path.join(PUBLIC, 'data', 'stations.json');

const DVLA = {
  apiKey: process.env.DVLA_API_KEY || '',
  url: process.env.DVLA_URL || 'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles',
};
const MOT = {
  apiKey: process.env.MOT_API_KEY || '',
  clientId: process.env.MOT_CLIENT_ID || '',
  clientSecret: process.env.MOT_CLIENT_SECRET || '',
  tokenUrl: process.env.MOT_TOKEN_URL || '',
  scope: process.env.MOT_SCOPE || 'https://tapi.dvsa.gov.uk/.default',
  baseUrl: process.env.MOT_BASE_URL || 'https://history.mot.api.gov.uk',
};
MOT.ready = Boolean(MOT.apiKey && MOT.clientId && MOT.clientSecret && MOT.tokenUrl);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Lab CO2 figures are optimistic, so the estimate is scaled to real-world driving.
const REAL_WORLD = 0.9;
function estimateEfficiency(v) {
  const fuelType = (v.fuelType || '').toUpperCase();
  if (fuelType.includes('ELECTRIC') && !fuelType.includes('HYBRID')) {
    return { kind: 'electric', milesPerKwh: 3.5, source: 'typical EV average' };
  }
  const isDiesel = fuelType.includes('DIESEL');
  const co2 = Number(v.co2Emissions);
  if (co2 > 0) {
    const litresPer100km = co2 / (isDiesel ? 26.8 : 23.1);
    const mpg = (282.481 / litresPer100km) * REAL_WORLD;
    return { kind: isDiesel ? 'diesel' : 'petrol', mpg: round1(mpg), source: `estimated from ${co2} g/km CO₂` };
  }
  const cc = Number(v.engineCapacity) || 1600;
  const year = Number(v.year);
  let mpg = 70 - cc / 100;
  if (isDiesel) mpg += 10;
  if (fuelType.includes('HYBRID')) mpg += 12;
  if (year) mpg += Math.max(-8, Math.min(5, (year - 2010) * 0.4));
  mpg = Math.max(18, Math.min(70, mpg));
  const basis = [`${cc} cc`, isDiesel ? 'diesel' : fuelType.includes('HYBRID') ? 'hybrid' : 'petrol', year].filter(Boolean).join(' ');
  return { kind: isDiesel ? 'diesel' : 'petrol', mpg: round1(mpg), source: `estimated from ${basis} engine` };
}
const round1 = (n) => Math.round(n * 10) / 10;
const titleCase = (s) => (s ? String(s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : undefined);

let motToken = null, motTokenExpiry = 0;
async function getMotToken() {
  if (motToken && Date.now() < motTokenExpiry - 60_000) return motToken;
  const r = await fetch(MOT.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials', client_id: MOT.clientId, client_secret: MOT.clientSecret, scope: MOT.scope,
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.access_token) throw new HttpError(401, 'Could not sign in to the MOT History API. Check your MOT credentials.');
  motToken = body.access_token;
  motTokenExpiry = Date.now() + (Number(body.expires_in) || 3600) * 1000;
  return motToken;
}

// Latest MOT odometer reading, projected to today from the car's average yearly mileage.
function mileageFromMot(tests) {
  if (!Array.isArray(tests)) return {};
  const reads = tests
    .filter((t) => String(t.odometerResultType || 'READ').toUpperCase() === 'READ' && Number(t.odometerValue) > 0)
    .map((t) => {
      const km = String(t.odometerUnit || '').toUpperCase().startsWith('K');
      const date = String(t.completedDate || '').replace(/^(\d{4})\.(\d{2})\.(\d{2})[ T]?/, '$1-$2-$3T');
      return { date: Date.parse(date), miles: Number(t.odometerValue) * (km ? 0.621371 : 1) };
    })
    .filter((r) => Number.isFinite(r.date))
    .sort((a, b) => a.date - b.date);
  if (!reads.length) return {};
  const first = reads[0], last = reads[reads.length - 1];
  const year = 3.156e10;
  let estimate = last.miles;
  if ((last.date - first.date) / year >= 1 && last.miles > first.miles) {
    const perYear = (last.miles - first.miles) / ((last.date - first.date) / year);
    estimate += perYear * Math.min(2, (Date.now() - last.date) / year);
  }
  return {
    motMileage: Math.round(last.miles),
    motMileageDate: new Date(last.date).toISOString().slice(0, 10),
    mileage: Math.round(estimate / 100) * 100,
  };
}

async function motLookup(reg) {
  const call = async () => fetch(`${MOT.baseUrl}/v1/trade/vehicles/registration/${encodeURIComponent(reg)}`, {
    headers: { Authorization: `Bearer ${await getMotToken()}`, 'X-API-Key': MOT.apiKey, Accept: 'application/json' },
  });
  let r = await call();
  if (r.status === 401) { motToken = null; r = await call(); }
  const body = await r.json().catch(() => ({}));
  if (r.status === 404) throw new HttpError(404, 'No vehicle found with that registration.');
  if (r.status === 401 || r.status === 403) throw new HttpError(403, 'The MOT History API rejected the request. Check your MOT credentials.');
  if (!r.ok) throw new HttpError(r.status, body.errorMessage || body.message || `MOT History API error (${r.status})`);
  const date = body.manufactureDate || body.registrationDate || body.firstUsedDate || '';
  return {
    ...mileageFromMot(body.motTests),
    registration: body.registration || reg,
    make: titleCase(body.make),
    model: titleCase(body.model),
    colour: titleCase(body.primaryColour),
    year: date ? Number(String(date).slice(0, 4)) : undefined,
    fuelType: body.fuelType,
    engineCapacity: Number(body.engineSize) || undefined,
  };
}

async function dvlaLookup(reg) {
  const r = await fetch(DVLA.url, {
    method: 'POST',
    headers: { 'x-api-key': DVLA.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ registrationNumber: reg }),
  });
  const body = await r.json().catch(() => ({}));
  if (r.status === 404) throw new HttpError(404, 'No vehicle found with that registration.');
  if (r.status === 401 || r.status === 403) throw new HttpError(403, 'The DVLA rejected the API key.');
  if (!r.ok) throw new HttpError(r.status, body?.errors?.[0]?.detail || body?.message || `DVLA error (${r.status})`);
  return {
    registration: body.registrationNumber, make: titleCase(body.make), colour: titleCase(body.colour),
    year: body.yearOfManufacture, fuelType: body.fuelType,
    engineCapacity: body.engineCapacity, co2Emissions: body.co2Emissions,
  };
}

async function vehicle(reg, res) {
  reg = (reg || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!reg || reg.length > 8) return send(res, 400, { error: 'Enter a valid registration.' });
  if (!MOT.ready && !DVLA.apiKey) return send(res, 503, { code: 'NO_KEY', error: 'Vehicle lookup is not configured.' });

  const [mot, dvla] = await Promise.allSettled([
    MOT.ready ? motLookup(reg) : Promise.reject(null),
    DVLA.apiKey ? dvlaLookup(reg) : Promise.reject(null),
  ]);
  const found = [mot, dvla].filter((x) => x.status === 'fulfilled').map((x) => x.value);
  if (!found.length) {
    const err = [mot, dvla].map((x) => x.reason).find((e) => e instanceof Error);
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    return send(res, 502, { error: 'Could not reach the vehicle lookup service.' });
  }
  const v = Object.assign({}, ...found.reverse());
  if (dvla.status === 'fulfilled') v.co2Emissions = dvla.value.co2Emissions;
  send(res, 200, { ...v, efficiency: estimateEfficiency(v) });
}

function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  if (ALLOWED_ORIGIN && p.startsWith('/api/')) res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);

  if (p === '/api/vehicle') return vehicle(url.searchParams.get('reg'), res);
  if (p === '/api/config') return send(res, 200, { vehicleLookup: MOT.ready || Boolean(DVLA.apiKey), fuel: fuel.status() });
  if (p === '/data/stations.json') return serveFile(res, fs.existsSync(fuel.CACHE_FILE) ? fuel.CACHE_FILE : SNAPSHOT);

  const file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  serveFile(res, file);
}).listen(PORT, () => {
  console.log(`\n  TripXYZ running at http://localhost:${PORT}`);
  console.log(`  Vehicle lookup: ${MOT.ready ? 'MOT History API' : ''}${MOT.ready && DVLA.apiKey ? ' + ' : ''}${DVLA.apiKey ? 'DVLA' : ''}${!MOT.ready && !DVLA.apiKey ? 'off' : ''}`);
  console.log(`  Live fuel prices: ${fuel.CONFIGURED ? 'on' : 'off'}\n`);
});
