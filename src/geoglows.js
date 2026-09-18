// GEOGLOWS v2 streamflow fetch: per-reach discharge (m^3/s) from S3 Zarr, summed.
// S3 REST bases only — HTTPS + CORS preflight (CloudFront 403s the preflight).

import { v2 } from 'riverforecastsystem';

export const V2_BASES = {
  forecast: 'https://geoglows-v2-forecasts.s3.us-west-2.amazonaws.com', // forecast + forecastRecords
  retro: 'https://geoglows-v2.s3.us-west-2.amazonaws.com',              // retrospective + metadata
};

const dayKey = (date) => new Date(date).toISOString().slice(0, 10);

// Sum several {time, values} series on their shared timestamps.
function sumByTimestamp(series) {
  const acc = new Map();
  for (const { time, values } of series) {
    for (let i = 0; i < time.length; i++) {
      const v = values[i];
      if (v == null || Number.isNaN(v)) continue;
      const k = new Date(time[i]).getTime();
      acc.set(k, (acc.get(k) ?? 0) + v);
    }
  }
  const times = [...acc.keys()].sort((a, b) => a - b);
  return { time: times.map((t) => new Date(t)), values: times.map((t) => acc.get(t)) };
}

// Mean-aggregate a sub-daily {time, values} series to daily.
function resampleDailyMean({ time, values }) {
  const sums = new Map();
  for (let i = 0; i < time.length; i++) {
    const v = values[i];
    if (v == null || Number.isNaN(v)) continue;
    const k = dayKey(time[i]);
    const cur = sums.get(k) ?? { sum: 0, n: 0 };
    cur.sum += v; cur.n += 1;
    sums.set(k, cur);
  }
  const dates = [...sums.keys()].sort();
  return { dates, values: dates.map((d) => sums.get(d).sum / sums.get(d).n) };
}

// Bias-uncorrected daily retrospective inflow, summed over reaches -> { dates, q }.
export async function retroDaily(riverIds) {
  const perReach = await Promise.all(
    riverIds.map(async (riverId) => {
      const { time, discharge } = await v2.retrospective({
        baseUrl: V2_BASES.retro, resolution: 'daily', riverId,
      });
      return { time, values: discharge.map((q) => (q < 0 ? 0 : q)) };
    }),
  );
  const summed = sumByTimestamp(perReach);
  return { dates: summed.time.map(dayKey), q: summed.values };
}

// Daily forecast-records inflow bridging the retro lag to ~today -> { dates, values }.
export async function forecastRecordsDaily(riverIds) {
  const dates = await v2.dates();
  const startDate = dates[Math.max(0, dates.length - 14)];
  const endDate = dates.at(-1);
  const perReach = await Promise.all(
    riverIds.map((riverId) =>
      v2.forecastRecords({ baseUrl: V2_BASES.forecast, riverId, startDate, endDate })),
  );
  const summed = sumByTimestamp(
    perReach.map((r) => ({ time: r.time, values: r.flow_median.map((q) => (q < 0 ? 0 : q)) })),
  );
  // Cap at the last init date so the final forecast's future horizon doesn't leak in.
  const cutoff = `${endDate.slice(0, 4)}-${endDate.slice(4, 6)}-${endDate.slice(6, 8)}`;
  const daily = resampleDailyMean(summed);
  const keep = daily.dates.map((d, i) => [d, daily.values[i]]).filter(([d]) => d <= cutoff);
  return { dates: keep.map((r) => r[0]), values: keep.map((r) => r[1]) };
}

// Latest 51-member ensemble inflow, summed over reaches, daily.
// -> { date, dates, members: number[][], mean: number[] } (members[m][d]).
export async function latestForecastEnsembleDaily(riverIds) {
  const dates = await v2.dates();
  const date = dates.at(-1); // most recent init (YYYYMMDD)

  // Sum reaches per (member, timestep), then resample each member to daily.
  const perReach = await Promise.all(
    riverIds.map((riverId) => v2.forecast({ baseUrl: V2_BASES.forecast, date, riverId })),
  );
  const time = perReach[0].time;
  const nMembers = perReach[0].discharge.length;

  const members = [];
  const meanAcc = [];
  for (let m = 0; m < nMembers; m++) {
    const summed = time.map((_, t) => {
      let s = 0;
      for (const reach of perReach) {
        const v = reach.discharge[m][t];
        if (v != null && !Number.isNaN(v)) s += v < 0 ? 0 : v;
      }
      return s;
    });
    const daily = resampleDailyMean({ time, values: summed });
    members.push(daily.values);
    meanAcc.push(daily);
  }

  const dailyDates = meanAcc[0].dates;
  const mean = dailyDates.map((_, d) =>
    members.reduce((s, mem) => s + mem[d], 0) / members.length);

  return { date, dates: dailyDates, members, mean };
}
