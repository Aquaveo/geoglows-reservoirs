// Port of geoglows.bias correct_historical + correct_forecast (geoglows 2.2.0):
// monthly Sturges-histogram quantile mapping of simulated flow onto observed flow.

// scipy.interpolate.interp1d(kind='linear'): searchsorted-left, index clipped
// to [1, n-1], then linear between neighbors (so out-of-domain extrapolates).
function interp1d(xs, ys) {
  const n = xs.length;
  return (q) => {
    let lo = 0, hi = n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (xs[m] < q) lo = m + 1; else hi = m; }
    let i = Math.min(Math.max(lo, 1), n - 1);
    const x0 = xs[i - 1], x1 = xs[i];
    const slope = (ys[i] - ys[i - 1]) / (x1 - x0);
    return slope * (q - x0) + ys[i - 1];
  };
}

// np.arange(start, stop, step): n = ceil((stop-start)/step) values.
function arange(start, stop, step) {
  const n = Math.max(0, Math.ceil((stop - start) / step));
  return Array.from({ length: n }, (_, i) => start + i * step);
}

// np.histogram(data, bins=edges) counts; last bin includes the right edge.
function histogram(data, edges) {
  const counts = new Array(edges.length - 1).fill(0);
  const last = edges.length - 1;
  for (const x of data) {
    if (x < edges[0] || x > edges[last]) continue;
    let k = 0;
    while (k < last && !(x < edges[k + 1])) k++;
    if (x === edges[last]) k = last - 1;
    counts[k]++;
  }
  return counts;
}

// geoglows._flow_and_probability_mapper: build flow<->cumulative-probability map.
function flowProbabilityMapper(data, mode) {
  const maxVal0 = Math.ceil(Math.max(...data));
  const minVal = Math.floor(Math.min(...data));
  const maxVal = maxVal0 === minVal ? maxVal0 + 0.1 : maxVal0;
  const nClasses = Math.ceil(1 + 3.322 * Math.log10(data.length));
  const step = (maxVal - minVal) / nClasses;
  const bins = arange(-step, maxVal + 2 * step, step);
  const counts = histogram(data, bins);
  const binEdges = bins.slice(1); // right edges, len == counts
  const norm = counts.map((c) => c / data.length);
  const cdf = [];
  norm.reduce((acc, c, i) => (cdf[i] = acc + c), 0);
  return mode === 'prob' ? interp1d(binEdges, cdf) : interp1d(cdf, binEdges);
}

const monthOf = (isoDate) => Number(isoDate.slice(5, 7));

/**
 * Monthly quantile-map simulated flow onto observed flow.
 * sim/obs: { dates: 'YYYY-MM-DD'[], values: number[] }.
 * Returns { dates, values } for sim's dates, corrected and clipped >= 0, sorted.
 */
export function correctHistorical(sim, obs) {
  const months = [...new Set(sim.dates.map(monthOf))].sort((a, b) => a - b);
  const out = [];
  for (const month of months) {
    const simMonth = filterMonth(sim, month);
    const obsMonth = filterMonth(obs, month);
    const toProb = flowProbabilityMapper(simMonth.values, 'prob');
    const toFlow = flowProbabilityMapper(obsMonth.values, 'flow');
    for (let i = 0; i < simMonth.values.length; i++) {
      out.push([simMonth.dates[i], Math.max(0, toFlow(toProb(simMonth.values[i])))]);
    }
  }
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { dates: out.map((r) => r[0]), values: out.map((r) => r[1]) };
}

/**
 * Correct a short-term forecast series against sim/obs using a single month's
 * mapping (the month of forecast.dates[useMonth]; useMonth 0=first, -1=last).
 * forecast/sim/obs: { dates, values }. Returns { dates, values } clipped >= 0.
 */
export function correctForecast(forecast, sim, obs, useMonth = 0) {
  const idx = useMonth < 0 ? forecast.dates.length + useMonth : useMonth;
  const month = monthOf(forecast.dates[idx]);
  const toProb = flowProbabilityMapper(filterMonth(sim, month).values, 'prob');
  const toFlow = flowProbabilityMapper(filterMonth(obs, month).values, 'flow');
  const values = forecast.values.map((v) =>
    v == null || Number.isNaN(v) ? v : Math.max(0, toFlow(toProb(v))));
  return { dates: forecast.dates, values };
}

function filterMonth({ dates, values }, month) {
  const d = [], v = [];
  for (let i = 0; i < dates.length; i++) {
    if (monthOf(dates[i]) === month && values[i] != null && !Number.isNaN(values[i])) {
      d.push(dates[i]); v.push(values[i]);
    }
  }
  return { dates: d, values: v };
}
