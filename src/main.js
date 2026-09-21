import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { qinToToday, forecastBand } from './pipeline.js';
import { retroDaily } from './geoglows.js';
import { reconstruct } from './engine.js';
import { renderHistoryChart, renderForecastChart } from './chart.js';

const BASE = import.meta.env.BASE_URL;

// Per-reservoir bundle (bathymetry, rule, observed series, river_ids), cached.
const bundleCache = new Map();
function loadBundle(id) {
  if (!bundleCache.has(id)) {
    bundleCache.set(id, fetch(`${BASE}reservoirs/${id}.json`).then((r) => r.json()));
  }
  return bundleCache.get(id);
}

// Keyless CARTO Voyager raster basemap (OSM data, © CARTO).
const style = {
  version: 8,
  sources: {
    carto: {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
        'https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
        'https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors © CARTO',
    },
  },
  layers: [{ id: 'carto', type: 'raster', source: 'carto' }],
};

const map = new maplibregl.Map({
  container: 'map',
  style,
  center: [-70.5, 18.9],
  zoom: 7,
});
map.addControl(new maplibregl.NavigationControl(), 'top-right');

const panel = document.getElementById('panel');

// Fetch retro once, run qin -> reconstruct -> band, memoized per reservoir.
const resultCache = new Map();
function computeReservoir(bundle) {
  if (!resultCache.has(bundle.id)) {
    resultCache.set(bundle.id, (async () => {
      const retro = await retroDaily(bundle.river_ids);
      const qin = await qinToToday(bundle, retro);
      const reconstruction = reconstruct(bundle, qin);
      const band = await forecastBand(bundle, reconstruction.anchorLevel, retro);
      return { reconstruction, band };
    })());
  }
  return resultCache.get(bundle.id);
}

async function showReservoir(r) {
  panel.hidden = false;
  panel.innerHTML = `<h2>${r.name}</h2><p class="muted">Computing level from GEOGLOWS v2…</p>`;
  try {
    const bundle = await loadBundle(r.id);
    const { reconstruction, band } = await computeReservoir(bundle);
    panel.innerHTML = `
      <h2>${r.name}</h2>
      <p class="muted">Today ~${reconstruction.anchorLevel.toFixed(2)} m ·
        band ${bundle.min_level}–${bundle.max_level} m · scroll to zoom</p>
      <h3>History</h3>
      <div class="chart-wrap"><canvas id="chart-history"></canvas></div>
      <h3>15-day forecast</h3>
      <div class="chart-wrap"><canvas id="chart-forecast"></canvas></div>`;
    renderHistoryChart(panel.querySelector('#chart-history'), { bundle, reconstruction });
    renderForecastChart(panel.querySelector('#chart-forecast'), { bundle, band });
  } catch (err) {
    panel.innerHTML = `<h2>${r.name}</h2><p class="error">Failed: ${err.message}</p>`;
  }
}

async function addReservoirMarkers() {
  const reservoirs = await fetch(`${BASE}reservoirs/index.json`).then((r) => r.json());
  const bounds = new maplibregl.LngLatBounds();
  for (const r of reservoirs) {
    const popup = new maplibregl.Popup({ offset: 24 }).setHTML(`<strong>${r.name}</strong>`);
    const marker = new maplibregl.Marker({ color: '#1d6fb8' })
      .setLngLat([r.lon, r.lat])
      .setPopup(popup)
      .addTo(map);
    marker.getElement().style.cursor = 'pointer';
    marker.getElement().addEventListener('click', () => showReservoir(r));
    bounds.extend([r.lon, r.lat]);
  }
  if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 80, maxZoom: 9 });
}

map.on('load', addReservoirMarkers);
