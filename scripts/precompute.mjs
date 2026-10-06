// Precompute each reservoir's reconstruction + forecast ensemble from GEOGLOWS v2,
// so the browser loads a static result instead of fetching/computing on select.
// Writes public/reservoirs/<id>.latest.json. Run daily in CI (npm run precompute).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { retroDaily } from '../src/geoglows.js';
import { qinToToday, forecastEnsemble } from '../src/pipeline.js';
import { reconstruct } from '../src/engine.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'reservoirs');
const generated = new Date().toISOString().slice(0, 10);

const bundles = readdirSync(dir).filter(
  (f) => f.endsWith('.json') && !f.endsWith('.latest.json') && f !== 'index.json',
);

let ok = 0;
for (const file of bundles) {
  try {
    const bundle = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    const retro = await retroDaily(bundle.river_ids);
    const reconstruction = reconstruct(bundle, await qinToToday(bundle, retro));
    const { dates, ensMatrix } = await forecastEnsemble(bundle, retro);
    writeFileSync(
      join(dir, `${bundle.id}.latest.json`),
      `${JSON.stringify({ generated, reconstruction, forecast: { dates, ensMatrix } })}\n`,
    );
    console.log(`  ${bundle.id}: ok (${reconstruction.dates.length} recon days, ${dates.length} forecast days)`);
    ok += 1;
  } catch (err) {
    console.warn(`  ${file}: FAILED ${err.message}`);
  }
}
console.log(`precompute: ${ok}/${bundles.length} reservoirs`);
if (ok === 0) process.exit(1);
