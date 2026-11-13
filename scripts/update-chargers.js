// Downloads EV charge points and writes the file published with the website.
// Usage: GRIDSERVE_API_KEY=... OCM_API_KEY=... node scripts/update-chargers.js [output]
const path = require('path');
const chargers = require('../chargers');

const out = path.resolve(process.argv[2] || path.join(__dirname, '..', 'public', 'data', 'chargers.json'));

(async () => {
  if (!chargers.CONFIGURED) {
    console.error('Set GRIDSERVE_API_KEY and/or OCM_API_KEY.');
    process.exit(1);
  }
  const data = await chargers.download();
  chargers.writeCache(data, out);
  console.log(`Wrote ${data.chargers.length} charge point locations to ${out}`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
