# GEOGLOWS Reservoirs

A generic, **no-backend** reservoir monitor. It displays preset reservoirs on a
map; selecting one shows its reconstructed water level and a 15-day ensemble
forecast band, with interactive outflow editing. The reservoir model
(bias-correction + water balance) runs entirely in the browser, reading GEOGLOWS
v2 streamflow via the [`riverforecastsystem`](https://github.com/Aquaveo/js-riverforecastsystem)
package. Deploys as static files to GitHub Pages.

It is a generic, config-driven reimagining of the Tethys
`reservoir_management` app — add a reservoir by dropping in a data bundle, no
code change.

## Stack
- Vite + vanilla ES modules (no framework)
- MapLibre GL JS (map)
- Chart.js (plots) — *added in a later phase*
- `riverforecastsystem` (GEOGLOWS v2 data) — *added in a later phase*

## Develop
```bash
npm install
npm run dev      # http://localhost:5173/geoglows-reservoirs/
npm run build    # -> dist/
npm run preview
```

## Reservoir config
- `public/reservoirs/index.json` — reservoir list (id, name, lat/lon, operating band, GEOGLOWS river_ids).
- `public/reservoirs/<id>.json` — per-reservoir bundle (bathymetry curve, operation rule, observed levels, observed inflow reference, anchor). *Added in Phase 2.*

## Deploy
Pushing to `main` builds and publishes to GitHub Pages via
`.github/workflows/deploy.yml`. The Vite `base` is `/geoglows-reservoirs/`;
adjust it in `vite.config.js` if the repo/site path differs.
