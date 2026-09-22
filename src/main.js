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
const markerEls = new Map(); // id -> marker element
const listEls = new Map();   // id -> sidebar <li>
let selectedId = null;

function setActive(id) {
  if (selectedId) {
    markerEls.get(selectedId)?.classList.remove('selected');
    listEls.get(selectedId)?.classList.remove('active');
  }
  selectedId = id;
  markerEls.get(id)?.classList.add('selected');
  listEls.get(id)?.classList.add('active');
}

function closePanel() {
  panel.hidden = true;
  setActive(null);
}

const shell = (name, inner) =>
  `<button class="panel-close" aria-label="Close">×</button><h2>${name}</h2>${inner}`;

// Fetch retro once, run qin -> reconstruct -> band, memoized per reservoir.
// Evict on failure so a retry refetches rather than replaying the rejection.
const resultCache = new Map();
function computeReservoir(bundle) {
  if (!resultCache.has(bundle.id)) {
    const p = (async () => {
      const retro = await retroDaily(bundle.river_ids);
      const qin = await qinToToday(bundle, retro);
      const reconstruction = reconstruct(bundle, qin);
      const band = await forecastBand(bundle, reconstruction.anchorLevel, retro);
      return { reconstruction, band };
    })();
    p.catch(() => resultCache.delete(bundle.id));
    resultCache.set(bundle.id, p);
  }
  return resultCache.get(bundle.id);
}

async function showReservoir(r) {
  panel.hidden = false;
  setActive(r.id);
  panel.innerHTML = shell(r.name,
    `<div class="loading"><span class="spinner"></span>
      <span>Computing level from GEOGLOWS v2…<br>
      <span class="muted">first load ~15–35 s · cached after</span></span></div>`);
  panel.querySelector('.panel-close').onclick = closePanel;
  try {
    const bundle = await loadBundle(r.id);
    const { reconstruction, band } = await computeReservoir(bundle);
    panel.innerHTML = shell(r.name, `
      <p class="muted">Today ~${reconstruction.anchorLevel.toFixed(2)} m ·
        operating band ${bundle.min_level}–${bundle.max_level} m · scroll to zoom</p>
      <h3>History</h3>
      <div class="chart-wrap"><canvas id="chart-history"></canvas></div>
      <h3>15-day forecast</h3>
      <div class="chart-wrap"><canvas id="chart-forecast"></canvas></div>`);
    panel.querySelector('.panel-close').onclick = closePanel;
    renderHistoryChart(panel.querySelector('#chart-history'), { bundle, reconstruction });
    renderForecastChart(panel.querySelector('#chart-forecast'), { bundle, band });
  } catch (err) {
    panel.innerHTML = shell(r.name,
      `<p class="error">Failed to load: ${err.message}</p><button class="btn-retry">Retry</button>`);
    panel.querySelector('.panel-close').onclick = closePanel;
    panel.querySelector('.btn-retry').onclick = () => showReservoir(r);
  }
}

// Build the sidebar list + map markers from the reservoir index.
async function buildUI() {
  const reservoirs = await fetch(`${BASE}reservoirs/index.json`).then((r) => r.json());
  const list = document.getElementById('reservoir-list');
  const bounds = new maplibregl.LngLatBounds();
  for (const r of reservoirs) {
    const marker = new maplibregl.Marker({ color: '#1d6fb8' })
      .setLngLat([r.lon, r.lat])
      .addTo(map);
    const el = marker.getElement();
    el.classList.add('reservoir-marker');
    el.style.cursor = 'pointer';
    el.title = r.name;
    el.addEventListener('click', () => showReservoir(r));
    markerEls.set(r.id, el);

    const li = document.createElement('li');
    li.textContent = r.name;
    li.addEventListener('click', () => showReservoir(r));
    list.appendChild(li);
    listEls.set(r.id, li);

    bounds.extend([r.lon, r.lat]);
  }
  if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 80, maxZoom: 9 });
}

map.on('load', buildUI);
