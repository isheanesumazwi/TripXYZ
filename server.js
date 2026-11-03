// TripXYZ local server: serves the app, looks up vehicles and keeps live fuel prices cached.
const http = require('http');
const fs = require('fs');
const path = require('path');

loadEnv(path.join(__dirname, '.env'));
const fuel = require('./fuel');
const { createVehicleLookup } = require('./lib/vehicle');

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';
const PUBLIC = path.join(__dirname, 'public');
const SNAPSHOT = path.join(PUBLIC, 'data', 'stations.json');
const vehicles = createVehicleLookup((key) => process.env[key]);

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

function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

fuel.start();

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  if (ALLOWED_ORIGIN && p.startsWith('/api/')) res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);

  if (p === '/api/vehicle') {
    const { status, body } = await vehicles.lookup(url.searchParams.get('reg'));
    return send(res, status, body);
  }
  if (p === '/api/config') return send(res, 200, { vehicleLookup: vehicles.enabled, fuel: fuel.status() });
  if (p === '/data/stations.json') return serveFile(res, fs.existsSync(fuel.CACHE_FILE) ? fuel.CACHE_FILE : SNAPSHOT);

  const file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  serveFile(res, file);
}).listen(PORT, () => {
  console.log(`\n  TripXYZ running at http://localhost:${PORT}`);
  console.log(`  Vehicle lookup: ${vehicles.sources.join(' + ') || 'off'}`);
  console.log(`  Live fuel prices: ${fuel.CONFIGURED ? 'on' : 'off'}\n`);
});
