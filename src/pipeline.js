// engine.qin_to_today: retro -> correctHistorical, bridged to today with corrected
// forecast records (retro-only fallback).

import { retroDaily, forecastRecordsDaily, latestForecastEnsembleDaily } from './geoglows.js';
import { correctHistorical, correctForecast } from './bias.js';
import { propagateBand, bandStats } from './engine.js';

// retroC plus frC entries strictly after retroC's last date; sorted, dedup keep-last.
function stitch(retroC, frC) {
  const cutoff = retroC.dates[retroC.dates.length - 1];
  const map = new Map();
  retroC.dates.forEach((d, i) => map.set(d, retroC.values[i]));
  frC.dates.forEach((d, i) => { if (d > cutoff) map.set(d, frC.values[i]); });
  const dates = [...map.keys()].sort();
  return { dates, values: dates.map((d) => map.get(d)) };
}

// Bias-corrected daily inflow, history -> today. -> { dates, values }.
// Pass a pre-fetched retro to avoid re-downloading it.
export async function qinToToday(bundle, retro) {
  const rids = bundle.river_ids;
  const obs = { dates: bundle.observed_inflow.dates, values: bundle.observed_inflow.qin };
  retro = retro ?? await retroDaily(rids);
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

// Bias-corrected daily ensemble inflow matrix (days x members), anchor-independent.
export async function forecastEnsemble(bundle, retro) {
  const rids = bundle.river_ids;
  const obs = { dates: bundle.observed_inflow.dates, values: bundle.observed_inflow.qin };
  const [retroData, fc] = await Promise.all([retro ?? retroDaily(rids), latestForecastEnsembleDaily(rids)]);
  const sim = { dates: retroData.dates, values: retroData.q };
  const meanCor = correctForecast({ dates: fc.dates, values: fc.mean }, sim, obs);
  const factor = fc.dates.map((_, d) =>
    fc.mean[d] > 0 ? Math.min(5, Math.max(0.2, meanCor.values[d] / fc.mean[d])) : 1);
  const ensMatrix = fc.dates.map((_, d) => fc.members.map((mem) => mem[d] * factor[d]));
  return { dates: fc.dates, ensMatrix };
}

// Ensemble forecast band from the anchor -> bandStats { dates, min, ... }.
export async function forecastBand(bundle, anchorLevel, retro) {
  const { dates, ensMatrix } = await forecastEnsemble(bundle, retro);
  const { traj, qoutSeq } = propagateBand(bundle, anchorLevel, ensMatrix);
  return bandStats(dates, traj, qoutSeq);
}
