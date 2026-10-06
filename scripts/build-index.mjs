// Regenerate public/reservoirs/index.json from the bundle files. Run automatically
// via predev/prebuild, so adding a reservoir is just dropping <id>.json in the folder.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'reservoirs');
const REQUIRED = ['id', 'name', 'lat', 'lon', 'min_level', 'max_level',
  'river_ids', 'rule', 'bathymetry', 'observed_levels', 'observed_inflow'];

const index = [];
for (const file of readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json' && !f.endsWith('.latest.json'))) {
  const b = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const missing = REQUIRED.filter((k) => b[k] === undefined);
  if (missing.length) console.warn(`  ${file}: missing ${missing.join(', ')}`);
  for (const k of ['id', 'name', 'lat', 'lon']) {
    if (b[k] === undefined) throw new Error(`${file}: cannot index without ${k}`);
  }
  index.push({ id: b.id, name: b.name, country: b.country || 'Other', lat: b.lat, lon: b.lon });
}
index.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(join(dir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
console.log(`reservoirs/index.json: ${index.length} reservoirs`);
