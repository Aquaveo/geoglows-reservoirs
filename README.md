# GEOGLOWS Reservoirs

A generic reservoir monitor. It shows preset reservoirs on a map and a sidebar;
selecting one shows its reconstructed water level and a 15-day ensemble forecast
band. The reservoir model (bias correction + water balance) runs in the browser,
reading GEOGLOWS v2 streamflow via the
[`riverforecastsystem`](https://github.com/Aquaveo/js-riverforecastsystem) package,
and ships as a static site (GitHub Pages).

It is a config-driven reimagining of the Tethys `reservoir_management` app: add a
reservoir by dropping in a data bundle, no code change.

## Stack
- Vite + vanilla ES modules (no framework)
- MapLibre GL JS (map)
- Chart.js (plots)
- `riverforecastsystem` (GEOGLOWS v2 data)

## Develop
```bash
npm install
npm run dev      # http://localhost:5173/geoglows-reservoirs/
npm run build    # -> dist/
npm run preview
```

## Adding a reservoir
1. Copy [`examples/reservoir.example.json`](examples/reservoir.example.json) to `public/reservoirs/<id>.json`.
2. Fill in your reservoir's data (fields and sourcing below).
3. Run `npm run dev` (or `npm run build`). The map marker, sidebar entry, and
   `index.json` regenerate automatically via `scripts/build-index.mjs` (or run
   `npm run reservoirs`), which warns on any missing field. `index.json` is
   generated — don't edit it by hand.

### Bundle format (`public/reservoirs/<id>.json`)
| field | type | description |
| --- | --- | --- |
| `id` | string | unique id; matches the filename (`<id>.json`) |
| `name` | string | display name |
| `lat`, `lon` | number | marker location |
| `min_level`, `max_level` | number | operating band (m) |
| `ymin` | number | optional y-axis floor for plots |
| `river_ids` | number[] | GEOGLOWS v2 river ids feeding the reservoir (inflow is summed) |
| `rule` | `{breakpoints:[k1,k2], coef:[c0,c1,c2,c3]}` | outflow rule `Qout = c0 + c1·w + c2·max(0,w−k1) + c3·max(0,w−k2)`, `w` = previous level |
| `bathymetry` | `{elev:number[], vol:number[]}` | elevation (m) ↔ volume (m³) curve, ascending by elevation |
| `observed_levels` | `{dates:string[], levels:(number\|null)[]}` | observed level (m); `null` marks a gap. Last non-null point is the reconstruction anchor |
| `observed_inflow` | `{dates:string[], qin:number[]}` | observed inflow (m³/s) — the bias-correction target |

Dates are `YYYY-MM-DD`.

### Where each field comes from
- **`river_ids`** — GEOGLOWS v2 reach IDs (LINKNO) of the rivers flowing into the reservoir; inflow is summed across them. Find them on the GEOGLOWS RFS map (apps.geoglows.org) or via the GEOGLOWS API.
- **`bathymetry`** — the reservoir's elevation↔storage curve from a bathymetric survey: `elev` in metres (ascending), `vol` the matching storage in m³.
- **`rule`** — the outflow operation rule (a fitted piecewise-linear hedging curve). If you don't have one, start with a rough default and refine.
- **`observed_levels` / `observed_inflow`** — historical daily records from the dam operator (level in m, inflow in m³/s). Insert a `null` level to break the plotted line across a real gap.
- **`min_level` / `max_level`** — the operating band (drawn as reference lines); **`ymin`** is an optional y-axis floor for the history plot.

> Bias correction maps GEOGLOWS inflow onto your observed inflow **per calendar month**, so it needs a substantial observed-inflow history (ideally several years covering all months). The tiny series in the example only show the shape — they won't produce a meaningful forecast.

For the Dominican Republic reservoirs these fields are extracted once from the
Tethys app's Excel workbooks; author them from your own data for a new reservoir.

## How it works (per reservoir, in the browser)
1. Fetch GEOGLOWS v2 **retrospective** inflow and bias-correct it against the
   bundle's observed inflow (monthly Sturges-histogram quantile mapping).
2. Run a daily **water balance** from the last observed level to today
   (`reconstruction`), using the operation `rule` for outflow and the
   `bathymetry` curve for level↔volume.
3. Bias-correct the latest 51-member **ensemble forecast** and propagate it 15
   days from the anchor into a percentile band.

## Deploy
Pushing to `main` builds and publishes to GitHub Pages via
`.github/workflows/deploy.yml`. The Vite `base` is `/geoglows-reservoirs/`;
adjust it in `vite.config.js` if the repo/site path differs.
