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

// numpy linear percentile over an ascending-sorted array.
function percentile(sortedAsc, p) {
  const n = sortedAsc.length;
  if (n === 1) return sortedAsc[0];
  const rank = (p / 100) * (n - 1);
  const lo = Math.floor(rank), hi = Math.ceil(rank);
  return lo === hi ? sortedAsc[lo] : sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (rank - lo);
}

// Propagate every ensemble member from the anchor with one shared outflow schedule
// (from the ensemble-mean run unless qoutOverride is given). ensMatrix: days x members.
// Returns { traj (days x members of levels), qoutSeq }.
export function propagateBand(bundle, anchorLevel, ensMatrix, qoutOverride) {
  const bathy = bundle.bathymetry;
  const vmin = Math.min(...bathy.vol), vmax = Math.max(...bathy.vol);
  const v0 = levelToVolume(anchorLevel, bathy);
  const ndays = ensMatrix.length, nmem = ensMatrix[0].length;

  // Fill NaN members with that day's cross-member mean.
  const filled = ensMatrix.map((row) => {
    const valid = row.filter((v) => v != null && !Number.isNaN(v));
    const mean = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
    return row.map((v) => (v == null || Number.isNaN(v) ? mean : v));
  });

  let qoutSeq;
  if (qoutOverride) {
    qoutSeq = Array.from({ length: ndays }, (_, t) =>
      qoutOverride[Math.min(t, qoutOverride.length - 1)] ?? 0);
  } else {
    qoutSeq = [];
    let v = v0, wsePrev = anchorLevel;
    for (let t = 0; t < ndays; t++) {
      const dayMean = filled[t].reduce((a, b) => a + b, 0) / nmem;
      const qo = ruleQout(wsePrev, bundle.rule);
      qoutSeq.push(qo);
      v = Math.min(Math.max(v + (dayMean - qo) * 86400, vmin), vmax);
      wsePrev = volumeToLevel(v, bathy);
    }
  }

  const traj = Array.from({ length: ndays }, () => new Array(nmem));
  for (let m = 0; m < nmem; m++) {
    let v = v0;
    for (let t = 0; t < ndays; t++) {
      v = Math.min(Math.max(v + (filled[t][m] - qoutSeq[t]) * 86400, vmin), vmax);
      traj[t][m] = volumeToLevel(v, bathy);
    }
  }
  return { traj, qoutSeq };
}

// Reduce a days x members level matrix to per-day percentile bands.
export function bandStats(dates, traj, qoutSeq) {
  const perDay = (fn) => traj.map((row) => fn([...row].sort((a, b) => a - b), row));
  return {
    dates,
    min: perDay((s) => s[0]),
    p25: perDay((s) => percentile(s, 25)),
    median: perDay((s) => percentile(s, 50)),
    p75: perDay((s) => percentile(s, 75)),
    max: perDay((s) => s[s.length - 1]),
    mean: perDay((_, row) => row.reduce((a, b) => a + b, 0) / row.length),
    members: traj[0].map((_, m) => traj.map((row) => row[m])),
    qout: qoutSeq,
  };
}

// --- Manual-outflow inverse: drag a day's mean level to the outflow that achieves it ---

const DRAIN_MAX = 1e7; // m^3/s bisection ceiling; clamps the balance to the dead pool

// Member-mean forecast level per day for an explicit outflow schedule.
function meanLevels(bundle, anchorLevel, ensMatrix, qoutSeq) {
  const { traj } = propagateBand(bundle, anchorLevel, ensMatrix, qoutSeq);
  return traj.map((row) => row.reduce((a, b) => a + b, 0) / row.length);
}

// Achievable mean-level range for `day`: release 0 (highest) to full drain (dead pool).
export function levelBounds(bundle, anchorLevel, ensMatrix, qoutSeq, day) {
  const hiSeq = qoutSeq.slice(); hiSeq[day] = 0;
  const loSeq = qoutSeq.slice(); loSeq[day] = DRAIN_MAX;
  return {
    hi: meanLevels(bundle, anchorLevel, ensMatrix, hiSeq)[day],
    lo: meanLevels(bundle, anchorLevel, ensMatrix, loSeq)[day],
  };
}

// Outflow (m^3/s) on `day` whose mean level matches `target`, by bisection
// (mean level decreases monotonically with outflow).
export function solveQout(bundle, anchorLevel, ensMatrix, qoutSeq, day, target) {
  let lo = 0, hi = DRAIN_MAX;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const seq = qoutSeq.slice(); seq[day] = mid;
    if (meanLevels(bundle, anchorLevel, ensMatrix, seq)[day] > target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
