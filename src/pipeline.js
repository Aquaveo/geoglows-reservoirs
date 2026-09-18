// Assemble bias-corrected daily inflow from history to ~today (engine.qin_to_today):
// live retro -> correctHistorical, then bridge the retro lag with corrected
// forecast records. Falls back to retro-only if records are unavailable.

import { retroDaily, forecastRecordsDaily } from './geoglows.js';
import { correctHistorical, correctForecast } from './bias.js';

// retroC plus frC entries strictly after retroC's last date; sorted, dedup keep-last.
function stitch(retroC, frC) {
  const cutoff = retroC.dates[retroC.dates.length - 1];
  const map = new Map();
  retroC.dates.forEach((d, i) => map.set(d, retroC.values[i]));
  frC.dates.forEach((d, i) => { if (d > cutoff) map.set(d, frC.values[i]); });
  const dates = [...map.keys()].sort();
  return { dates, values: dates.map((d) => map.get(d)) };
}

/**
 * Bias-corrected daily inflow (m^3/s) for a reservoir, history -> ~today.
 * Returns { dates: 'YYYY-MM-DD'[], values: number[] }.
 */
export async function qinToToday(bundle) {
  const rids = bundle.river_ids;
  const obs = { dates: bundle.observed_inflow.dates, values: bundle.observed_inflow.qin };
  const retro = await retroDaily(rids);
  const sim = { dates: retro.dates, values: retro.q };
  const retroC = correctHistorical(sim, obs);
  try {
    const fr = await forecastRecordsDaily(rids);
    if (!fr.dates.length) return retroC;
    return stitch(retroC, correctForecast(fr, sim, obs));
  } catch {
    return retroC;
  }
}
