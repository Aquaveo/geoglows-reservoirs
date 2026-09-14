import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { retroDaily, latestForecastEnsembleDaily } from './geoglows.js';

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

// Side panel: for now a status readout proving GEOGLOWS v2 data reaches the
// browser. The reconstruction/forecast charts replace this in a later phase.
const panel = document.getElementById('panel');
const fmt = (n) => Number(n).toFixed(2);

async function showReservoir(r) {
  panel.hidden = false;
  panel.innerHTML = `<h2>${r.name}</h2><p class="muted">Fetching GEOGLOWS v2 inflow…</p>`;
  try {
    const bundle = await loadBundle(r.id);
    const rids = bundle.river_ids;
    const [retro, fc] = await Promise.all([
      retroDaily(rids),
      latestForecastEnsembleDaily(rids),
    ]);
    const spread0 = [
      Math.min(...fc.members.map((m) => m[0])),
      Math.max(...fc.members.map((m) => m[0])),
    ];
    panel.innerHTML = `
      <h2>${r.name}</h2>
      <p class="muted">Operating band ${bundle.min_level}–${bundle.max_level} m ·
        ${rids.length} feeder reach${rids.length > 1 ? 'es' : ''}</p>
      <dl>
        <dt>Retrospective inflow</dt>
        <dd>${retro.dates.length.toLocaleString()} daily pts,
          ${retro.dates[0]} → ${retro.dates.at(-1)}<br>
          latest ${fmt(retro.q.at(-1))} m³/s</dd>
        <dt>Forecast ensemble (init ${fc.date})</dt>
        <dd>${fc.members.length} members × ${fc.dates.length} days<br>
          mean today ${fmt(fc.mean[0])} m³/s · day-${fc.dates.length}
          ${fmt(fc.mean.at(-1))} m³/s<br>
          day-0 spread ${fmt(spread0[0])}–${fmt(spread0[1])} m³/s</dd>
      </dl>`;
  } catch (err) {
    panel.innerHTML = `<h2>${r.name}</h2><p class="error">Fetch failed: ${err.message}</p>`;
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
