// Downloads live prices and writes the file published with the website.
// Usage: FUEL_FINDER_CLIENT_ID=... FUEL_FINDER_CLIENT_SECRET=... node scripts/update-prices.js [output]
const path = require('path');
const fuel = require('../fuel');

const out = path.resolve(process.argv[2] || path.join(__dirname, '..', 'public', 'data', 'stations.json'));

(async () => {
  if (!fuel.CONFIGURED) {
    console.error('FUEL_FINDER_CLIENT_ID and FUEL_FINDER_CLIENT_SECRET must be set.');
    process.exit(1);
  }
  const data = await fuel.download();
  fuel.writeCache(data, out);
  console.log(`Wrote ${data.stations.length} stations to ${out}`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
