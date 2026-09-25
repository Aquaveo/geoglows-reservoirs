import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { qinToToday, forecastEnsemble } from './pipeline.js';
import { retroDaily } from './geoglows.js';
import { reconstruct, propagateBand, bandStats } from './engine.js';
import { renderHistoryChart, renderForecastChart, renderEnsembleChart } from './chart.js';

const BASE = import.meta.env.BASE_URL;

// Per-reservoir bundle (bathymetry, rule, observed series, river_ids), cached.
const bundleCache = new Map();
function loadBundle(id) {
  if (!bundleCache.has(id)) {
    bundleCache.set(id, fetch(`${BASE}reservoirs/${id}.json`).then((r) => r.json()));
  }
  return bundleCache.get(id);
}

// Keyless Esri World Imagery (satellite) + place labels — colorful and dark-toned,
// the basemap family GEOGLOWS uses.
const esri = (service) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/{z}/{y}/{x}`;
const style = {
  version: 8,
  sources: {
    esriBase: {
      type: 'raster',
      tiles: [esri('World_Imagery')],
      tileSize: 256,
      attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS user community',
    },
    esriRef: { type: 'raster', tiles: [esri('Reference/World_Boundaries_and_Places')], tileSize: 256 },
  },
  layers: [
    { id: 'esri-base', type: 'raster', source: 'esriBase' },
    { id: 'esri-ref', type: 'raster', source: 'esriRef' },
  ],
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

const esc = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shell = (name, inner) =>
  `<button class="panel-close" aria-label="Close">×</button><h2>${esc(name)}</h2>${inner}`;

// Fetch retro once, run qin -> reconstruct -> band, memoized per reservoir.
// Evict on failure so a retry refetches rather than replaying the rejection.
const resultCache = new Map();
function computeReservoir(bundle) {
  if (!resultCache.has(bundle.id)) {
    const p = (async () => {
      const retro = await retroDaily(bundle.river_ids);
      const qin = await qinToToday(bundle, retro);
      const reconstruction = reconstruct(bundle, qin);
      const { dates, ensMatrix } = await forecastEnsemble(bundle, retro);
      // Re-propagate the band from any anchor + optional manual outflow (instant).
      const recomputeBand = (anchorLevel, qoutOverride) => {
        const { traj, qoutSeq } = propagateBand(bundle, anchorLevel, ensMatrix, qoutOverride);
        return bandStats(dates, traj, qoutSeq);
      };
      const band = recomputeBand(reconstruction.anchorLevel);
      return { reconstruction, band, recomputeBand };
    })();
    p.catch(() => resultCache.delete(bundle.id));
    resultCache.set(bundle.id, p);
  }
  return resultCache.get(bundle.id);
}

// Today's-level control: calls onAnchor(level), debounced and clamped, when changed.
function wireAnchor(bundle, estimate, onAnchor) {
  const num = panel.querySelector('#anchor-num');
  const slider = panel.querySelector('#anchor-slider');
  const lo = Math.min(bundle.min_level - 3, estimate);
  const hi = Math.max(bundle.max_level + 2, estimate);
  const clamp = (v) => Math.min(Math.max(v, lo), hi);
  for (const el of [num, slider]) { el.min = lo; el.max = hi; }
  num.value = estimate.toFixed(2);
  slider.value = estimate;

  let timer;
  const apply = (v) => {
    if (Number.isNaN(v)) return;
    clearTimeout(timer);
    timer = setTimeout(() => onAnchor(clamp(v)), 150);
  };
  num.addEventListener('input', () => {
    const c = clamp(parseFloat(num.value));
    if (!Number.isNaN(c)) slider.value = c;
    apply(parseFloat(num.value));
  });
  num.addEventListener('change', () => {
    const c = clamp(parseFloat(num.value));
    if (!Number.isNaN(c)) num.value = c.toFixed(2);
  });
  slider.addEventListener('input', () => {
    num.value = parseFloat(slider.value).toFixed(2);
    apply(parseFloat(slider.value));
  });
  panel.querySelector('#anchor-reset').addEventListener('click', () => {
    num.value = estimate.toFixed(2); slider.value = estimate; apply(estimate);
  });
}

// Wire the forecast tab (anchor, stats/ensembles view, rule/manual outflow).
// Returns render() to (re)draw the active view; state persists across tab switches.
function setupForecast(bundle, reconstruction, initialBand, recomputeBand) {
  let band = initialBand;
  let anchor = reconstruction.anchorLevel;
  let qout = null; // null = rule (auto); array = manual override
  let view = 'stats';

  const canvas = () => panel.querySelector('#chart-forecast');
  const render = () => (view === 'stats' ? renderForecastChart : renderEnsembleChart)(canvas(), { bundle, band });
  const recompute = () => { band = recomputeBand(anchor, qout); render(); };

  wireAnchor(bundle, anchor, (v) => { anchor = v; recompute(); });

  const segs = (sel, fn) => panel.querySelectorAll(sel).forEach((b) => {
    b.onclick = () => { panel.querySelectorAll(sel).forEach((x) => x.classList.toggle('active', x === b)); fn(b); };
  });
  segs('#view-toggle .seg', (b) => { view = b.dataset.view; render(); });

  const tableWrap = panel.querySelector('.qout-table-wrap');
  let qTimer;
  const buildTable = () => {
    tableWrap.innerHTML = `<table class="qout-table"><thead><tr>${
      band.dates.map((d) => `<th>${d.slice(5)}</th>`).join('')
    }</tr></thead><tbody><tr>${
      band.qout.map((q) => `<td><input type="number" step="0.1" value="${q.toFixed(1)}"></td>`).join('')
    }</tr></tbody></table>`;
    tableWrap.querySelectorAll('input').forEach((inp) => inp.addEventListener('input', () => {
      clearTimeout(qTimer);
      qTimer = setTimeout(() => {
        qout = [...tableWrap.querySelectorAll('input')].map((i) => parseFloat(i.value) || 0);
        recompute();
      }, 200);
    }));
  };
  segs('#qout-toggle .seg', (b) => {
    if (b.dataset.qmode === 'rule') { qout = null; tableWrap.hidden = true; recompute(); }
    else { buildTable(); tableWrap.hidden = false; } // prefill from the current rule schedule
  });

  return render;
}

async function showReservoir(r) {
  panel.hidden = false;
  setActive(r.id);
  panel.innerHTML = shell(r.name,
    `<div class="loading"><span class="spinner"></span>
      <span>Computing level from GEOGLOWS v2…</span></div>`);
  panel.querySelector('.panel-close').onclick = closePanel;
  try {
    const bundle = await loadBundle(r.id);
    const { reconstruction, band, recomputeBand } = await computeReservoir(bundle);
    panel.innerHTML = shell(r.name, `
      <p class="muted">operating band ${bundle.min_level}–${bundle.max_level} m</p>
      <div class="tabs">
        <button class="tab" data-tab="history">History</button>
        <button class="tab" data-tab="forecast">15-day forecast</button>
      </div>
      <div class="tab-panel" data-panel="history">
        <div class="chart-wrap"><canvas id="chart-history"></canvas></div>
      </div>
      <div class="tab-panel" data-panel="forecast" hidden>
        <div class="anchor-ctl">
          <label for="anchor-num">Today's level (m)</label>
          <input type="number" id="anchor-num" step="0.05">
          <input type="range" id="anchor-slider" step="0.05">
          <button class="btn-reset" id="anchor-reset" title="Reset to model estimate">Reset</button>
        </div>
        <div class="fc-row">
          <div class="seg-group" id="view-toggle">
            <button class="seg active" data-view="stats">Statistics</button>
            <button class="seg" data-view="ensembles">Ensembles</button>
          </div>
          <div class="seg-labeled">
            <span class="seg-label">Outflow</span>
            <div class="seg-group" id="qout-toggle">
              <button class="seg active" data-qmode="rule">Rule</button>
              <button class="seg" data-qmode="manual">Manual</button>
            </div>
          </div>
        </div>
        <div class="qout-table-wrap" hidden></div>
        <div class="chart-wrap"><canvas id="chart-forecast"></canvas></div>
      </div>`);
    panel.querySelector('.panel-close').onclick = closePanel;

    const renderForecast = setupForecast(bundle, reconstruction, band, recomputeBand);
    const showTab = (name) => {
      panel.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
      panel.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
      if (name === 'history') renderHistoryChart(panel.querySelector('#chart-history'), { bundle, reconstruction });
      else renderForecast();
    };
    panel.querySelectorAll('.tab').forEach((t) => { t.onclick = () => showTab(t.dataset.tab); });
    showTab('history');
  } catch (err) {
    panel.innerHTML = shell(r.name,
      `<p class="error">Failed to load: ${esc(err.message)}</p><button class="btn-retry">Retry</button>`);
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
    const marker = new maplibregl.Marker({ color: '#38bdf8' })
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
