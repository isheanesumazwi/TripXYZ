// Vehicle lookup shared by the local server and the Netlify function.
// Uses the DVSA MOT History API and, optionally, the DVLA Vehicle Enquiry Service.

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

// `env` is a function that returns a setting by name, so this works with
// process.env locally and Netlify.env on Netlify.
function createVehicleLookup(getEnv) {
  const env = (key) => String(getEnv(key) ?? '').trim().replace(/^['"]|['"]$/g, '');
  const dvla = {
    apiKey: env('DVLA_API_KEY') || '',
    url: env('DVLA_URL') || 'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles',
  };
  const mot = {
    apiKey: env('MOT_API_KEY') || '',
    clientId: env('MOT_CLIENT_ID') || '',
    clientSecret: env('MOT_CLIENT_SECRET') || '',
    tokenUrl: env('MOT_TOKEN_URL') || '',
    scope: env('MOT_SCOPE') || 'https://tapi.dvsa.gov.uk/.default',
    baseUrl: env('MOT_BASE_URL') || 'https://history.mot.api.gov.uk',
  };
  mot.ready = Boolean(mot.apiKey && mot.clientId && mot.clientSecret && mot.tokenUrl);

  let motToken = null, motTokenExpiry = 0;
  async function getMotToken() {
    if (motToken && Date.now() < motTokenExpiry - 60_000) return motToken;
    const r = await fetch(mot.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials', client_id: mot.clientId, client_secret: mot.clientSecret, scope: mot.scope,
      }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body.access_token) throw new HttpError(401, 'Could not sign in to the MOT History API. Check your MOT credentials.');
    motToken = body.access_token;
    motTokenExpiry = Date.now() + (Number(body.expires_in) || 3600) * 1000;
    return motToken;
  }

  async function motLookup(reg) {
    const call = async () => fetch(`${mot.baseUrl}/v1/trade/vehicles/registration/${encodeURIComponent(reg)}`, {
      headers: { Authorization: `Bearer ${await getMotToken()}`, 'X-API-Key': mot.apiKey, Accept: 'application/json' },
    });
    let r = await call();
    if (r.status === 401) { motToken = null; r = await call(); }
    const body = await r.json().catch(() => ({}));
    if (r.status === 404) throw new HttpError(404, 'No vehicle found with that registration.');
    if (r.status === 401 || r.status === 403) {
      const reason = body.message || body.Message || body.errorMessage || '';
      throw new HttpError(403, `The MOT History API rejected the request (${r.status}${reason ? `: ${reason}` : ''}). Check your MOT credentials.`);
    }
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
    const r = await fetch(dvla.url, {
      method: 'POST',
      headers: { 'x-api-key': dvla.apiKey, 'Content-Type': 'application/json' },
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

  // Returns { status, body } so callers can send it with any HTTP framework.
  async function lookup(rawReg) {
    const reg = String(rawReg || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!reg || reg.length > 8) return { status: 400, body: { error: 'Enter a valid registration.' } };
    if (!mot.ready && !dvla.apiKey) return { status: 503, body: { code: 'NO_KEY', error: 'Vehicle lookup is not configured.' } };

    const [fromMot, fromDvla] = await Promise.allSettled([
      mot.ready ? motLookup(reg) : Promise.reject(null),
      dvla.apiKey ? dvlaLookup(reg) : Promise.reject(null),
    ]);
    const found = [fromMot, fromDvla].filter((x) => x.status === 'fulfilled').map((x) => x.value);
    if (!found.length) {
      const err = [fromMot, fromDvla].map((x) => x.reason).find((e) => e instanceof Error);
      if (err instanceof HttpError) return { status: err.status, body: { error: err.message } };
      return { status: 502, body: { error: 'Could not reach the vehicle lookup service.' } };
    }
    const v = Object.assign({}, ...found.reverse());
    if (fromDvla.status === 'fulfilled') v.co2Emissions = fromDvla.value.co2Emissions;
    return { status: 200, body: { ...v, efficiency: estimateEfficiency(v) } };
  }

  return {
    lookup,
    enabled: mot.ready || Boolean(dvla.apiKey),
    sources: [mot.ready && 'MOT History API', dvla.apiKey && 'DVLA'].filter(Boolean),
  };
}

module.exports = { createVehicleLookup };
