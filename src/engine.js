// Daily reservoir water balance (engine.reconstruct + model.rule_qout):
//   V(t) = clip(V(t-1) + (Qin - Qout)*86400, vmin, vmax),  Qout = rule(level)

// np.interp: clamp at the ends, linear between; xs ascending.
function interp(x, xs, ys) {
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0, hi = n - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (xs[m] <= x) lo = m; else hi = m - 1; }
  const x0 = xs[lo], x1 = xs[lo + 1];
  return x1 === x0 ? ys[lo] : ys[lo] + (ys[lo + 1] - ys[lo]) * (x - x0) / (x1 - x0);
}

const levelToVolume = (level, { elev, vol }) => interp(level, elev, vol);
const volumeToLevel = (v, { elev, vol }) => interp(v, vol, elev);

// rule: Qout = c0 + c1*w + c2*max(0,w-k1) + c3*max(0,w-k2), clamped >= 0.
export function ruleQout(level, rule) {
  const [k1, k2] = rule.breakpoints;
  const [c0, c1, c2, c3] = rule.coef;
  const q = c0 + c1 * level + c2 * Math.max(0, level - k1) + c3 * Math.max(0, level - k2);
  return Math.max(0, q);
}

// Last observed (non-null) level in a bundle: the reconstruction anchor start.
function lastObserved({ dates, levels }) {
  for (let i = levels.length - 1; i >= 0; i--) {
    if (levels[i] != null) return { date: dates[i], level: levels[i] };
  }
  throw new Error('no observed level in bundle');
}

// Carry the level from the last observed datum forward on bias-corrected inflow.
// qin: { dates, values } -> { anchorDate, anchorLevel, dates, levels, qin, qout }.
export function reconstruct(bundle, qin) {
  const { date: startDate, level: startLevel } = lastObserved(bundle.observed_levels);
  const bathy = bundle.bathymetry;
  const vmin = Math.min(...bathy.vol);
  const vmax = Math.max(...bathy.vol);

  const dates = [startDate];
  const levels = [startLevel];
  const qins = [null];
  const qouts = [null];

  let v = levelToVolume(startLevel, bathy);
  let wsePrev = startLevel;
  for (let i = 0; i < qin.dates.length; i++) {
    if (qin.dates[i] <= startDate) continue; // future inflow only
    const q = qin.values[i];
    const qout = ruleQout(wsePrev, bundle.rule);
    v = Math.min(Math.max(v + (q - qout) * 86400, vmin), vmax);
    wsePrev = volumeToLevel(v, bathy);
    dates.push(qin.dates[i]);
    levels.push(wsePrev);
    qins.push(q);
    qouts.push(qout);
  }

  return {
    anchorDate: dates[dates.length - 1],
    anchorLevel: levels[levels.length - 1],
    dates, levels, qin: qins, qout: qouts,
  };
}
