// GEOGLOWS v2 streamflow fetch layer.
//
// Reads river discharge (m^3/s) for a reservoir's feeder reaches from the
// GEOGLOWS v2 Zarr archives on S3 via the `riverforecastsystem` client, and
// returns inflow series summed across those reaches — the raw (bias-uncorrected)
// input the client-side reservoir model consumes.
//
// S3 REST endpoints: HTTPS (no mixed content) and answer CORS preflight. The
// package default s3-website URLs are HTTP; the CloudFront ones 403 the preflight.

import { v2 } from 'riverforecastsystem';

export const V2_BASES = {
  forecast: 'https://geoglows-v2-forecasts.s3.us-west-2.amazonaws.com', // forecast + forecastRecords
  retro: 'https://geoglows-v2.s3.us-west-2.amazonaws.com',              // retrospective + metadata
};

const MS_PER_DAY = 86_400_000;
const dayKey = (date) => new Date(date).toISOString().slice(0, 10); // 'YYYY-MM-DD' (UTC)

// Align several {time, value} series on their shared timestamps and sum them.
// Reaches share the GEOGLOWS timestep grid, so a plain per-timestamp sum is exact.
function sumByTimestamp(series) {
  const acc = new Map(); // epoch-ms -> summed value
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

// Mean-aggregate a sub-daily {time, values} series to one value per calendar day.
function resampleDailyMean({ time, values }) {
  const sums = new Map();  // 'YYYY-MM-DD' -> {sum, n}
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

/**
 * Bias-uncorrected daily retrospective inflow (m^3/s), summed across a
 * reservoir's feeder reaches. Returns { dates: 'YYYY-MM-DD'[], q: number[] }.
 */
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

/**
 * Daily forecast-records inflow (m^3/s) bridging the retro lag to ~today, summed
 * across reaches. Uses the recent forecast window. Returns { dates, values }.
 */
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
  // Cap at the last init date: the final forecast's full horizon would otherwise
  // leak future days into a "records-to-today" series.
  const cutoff = `${endDate.slice(0, 4)}-${endDate.slice(4, 6)}-${endDate.slice(6, 8)}`;
  const daily = resampleDailyMean(summed);
  const keep = daily.dates.map((d, i) => [d, daily.values[i]]).filter(([d]) => d <= cutoff);
  return { dates: keep.map((r) => r[0]), values: keep.map((r) => r[1]) };
}

/**
 * Latest 51-member ensemble forecast inflow (m^3/s), summed across the reservoir's
 * reaches and resampled to daily means. Returns
 * { date, dates: 'YYYY-MM-DD'[], members: number[][], mean: number[] }
 * where members[m][d] is member m's daily-mean inflow on day d.
 */
export async function latestForecastEnsembleDaily(riverIds) {
  const dates = await v2.dates();
  const date = dates.at(-1); // most recent initialization (YYYYMMDD)

  // forecast() returns discharge as [member][timestep] for one reach; sum reaches
  // per (member, timestep), then resample each member to daily means.
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

export { MS_PER_DAY };
