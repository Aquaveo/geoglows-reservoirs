import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { qinToToday, forecastEnsemble } from './pipeline.js';
import { retroDaily } from './geoglows.js';
import { reconstruct, propagateBand, bandStats, levelBounds, solveQout } from './engine.js';
import { renderHistoryChart, renderForecastChart, renderEnsembleChart } from './chart.js';
import { downloadCsv } from './csv.js';

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
const idCountry = new Map(); // id -> country (folder)
const groups = new Map();    // country -> { itemsEl, headerEl }
let selectedId = null;

function expandGroup(country, expand) {
  const g = groups.get(country);
  if (!g) return;
  g.itemsEl.hidden = !expand;
  g.headerEl.classList.toggle('expanded', expand);
}

function setActive(id) {
  if (selectedId) {
    markerEls.get(selectedId)?.classList.remove('selected');
    listEls.get(selectedId)?.classList.remove('active');
  }
  selectedId = id;
  if (id) {
    markerEls.get(id)?.classList.add('selected');
    listEls.get(id)?.classList.add('active');
    expandGroup(idCountry.get(id), true); // auto-expand the containing folder
  }
}

function closePanel() {
  panel.hidden = true;
  setActive(null);
}

const esc = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// CSV rows for the History tab: one continuous level series, recent-first, tagged by
// source. Observed and reconstruction spans are disjoint (they meet at the anchor).
function historyRows(bundle, reconstruction) {
  const rows = [['date', 'level_m', 'source']];
  // Reconstruction (anchor->today); skip index 0, the anchor is the last observed row.
  for (let i = reconstruction.dates.length - 1; i >= 1; i--) {
    rows.push([reconstruction.dates[i], reconstruction.levels[i].toFixed(3), 'reconstruction']);
  }
  const { dates, levels } = bundle.observed_levels;
  for (let i = dates.length - 1; i >= 0; i--) {
    if (levels[i] != null) rows.push([dates[i], levels[i].toFixed(3), 'observed']);
  }
  return rows;
}

// CSV rows for the Forecast tab: the current percentile band + outflow schedule.
function forecastRows(band) {
  const rows = [['date', 'min_m', 'p25_m', 'median_m', 'p75_m', 'max_m', 'mean_m', 'outflow_m3s']];
  band.dates.forEach((d, i) => rows.push([
    d, band.min[i].toFixed(3), band.p25[i].toFixed(3), band.median[i].toFixed(3),
    band.p75[i].toFixed(3), band.max[i].toFixed(3), band.mean[i].toFixed(3), band.qout[i].toFixed(3),
  ]));
  return rows;
}
const shell = (name, inner) =>
  `<button class="panel-close" aria-label="Close">×</button><h2>${esc(name)}</h2>${inner}`;

// Build the interactive result (band + re-propagation closures) from ensemble inputs.
function assembleResult(bundle, reconstruction, dates, ensMatrix) {
  // Re-propagate the band from any anchor + optional manual outflow (instant).
  const recomputeBand = (anchorLevel, qoutOverride) => {
    const { traj, qoutSeq } = propagateBand(bundle, anchorLevel, ensMatrix, qoutOverride);
    return bandStats(dates, traj, qoutSeq);
  };
  // Inverse (manual outflow): a day's achievable mean-level range, and the outflow
  // that lands the mean at a dragged target.
  const levelBoundsAt = (anchorLevel, qoutSeq, day) =>
    levelBounds(bundle, anchorLevel, ensMatrix, qoutSeq, day);
  const solveQoutAt = (anchorLevel, qoutSeq, day, target) =>
    solveQout(bundle, anchorLevel, ensMatrix, qoutSeq, day, target);
  const band = recomputeBand(reconstruction.anchorLevel);
  return { reconstruction, band, recomputeBand, levelBoundsAt, solveQoutAt };
}

// Daily precompute (scripts/precompute.mjs) if published; null -> compute live.
async function loadPrecomputed(id) {
  try {
    const r = await fetch(`${BASE}reservoirs/${id}.latest.json`, { cache: 'no-cache' });
    if (!r.ok) return null;
    const { generated, reconstruction, forecast } = await r.json();
    const dates = forecast?.dates;
    const ens = forecast?.ensMatrix;
    // Any shape problem -> null, so computeReservoir falls through to live compute.
    const valid = reconstruction?.dates?.length && Number.isFinite(reconstruction.anchorLevel)
      && Array.isArray(dates) && dates.length
      && Array.isArray(ens) && ens.length === dates.length
      && Array.isArray(ens[0]) && ens[0].length;
    return valid ? { generated, reconstruction, dates, ensMatrix: ens } : null;
  } catch {
    return null;
  }
}

// Precomputed result if available; else fetch GEOGLOWS and compute in the browser.
// Memoized per reservoir; evict on failure so a retry refetches.
const resultCache = new Map();
function computeReservoir(bundle) {
  if (!resultCache.has(bundle.id)) {
    const p = (async () => {
      const pre = await loadPrecomputed(bundle.id);
      if (pre) return { ...assembleResult(bundle, pre.reconstruction, pre.dates, pre.ensMatrix), generated: pre.generated };
      const retro = await retroDaily(bundle.river_ids);
      const reconstruction = reconstruct(bundle, await qinToToday(bundle, retro));
      const { dates, ensMatrix } = await forecastEnsemble(bundle, retro);
      return { ...assembleResult(bundle, reconstruction, dates, ensMatrix), generated: null };
    })();
    p.catch(() => resultCache.delete(bundle.id));
    resultCache.set(bundle.id, p);
  }
  return resultCache.get(bundle.id);
}

// Warm the cache from precomputed results only (never triggers live compute), so
// opening a reservoir is instant. Reservoirs without a precompute stay on-demand.
async function preloadReservoir(id) {
  if (resultCache.has(id)) return;
  const pre = await loadPrecomputed(id);
  if (!pre) return;
  const bundle = await loadBundle(id);
  resultCache.set(id, Promise.resolve({
    ...assembleResult(bundle, pre.reconstruction, pre.dates, pre.ensMatrix), generated: pre.generated,
  }));
}

// Today's-level control: calls onAnchor(level), debounced and clamped, when changed.
// onReset (optional) fires after the Reset button restores the estimate.
function wireAnchor(bundle, estimate, onAnchor, onReset) {
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
    onReset?.();
  });
}

// Wire the forecast tab (anchor, stats/ensembles view, rule/manual outflow).
// Returns render() to (re)draw the active view; state persists across tab switches.
function setupForecast(bundle, reconstruction, initialBand, recomputeBand, levelBoundsAt, solveQoutAt) {
  let band = initialBand;
  let anchor = reconstruction.anchorLevel;
  let qout = null; // null = rule (auto); array = manual override
  let view = 'stats';

  const canvas = () => panel.querySelector('#chart-forecast');
  const tableWrap = panel.querySelector('.qout-table-wrap');

  // Drag the Mean line (manual mode): clamp to the day's achievable range, back-solve
  // the outflow, update the table cell, and re-propagate.
  let dragLo = -Infinity, dragHi = Infinity;
  const drag = {
    start: (day) => { ({ lo: dragLo, hi: dragHi } = levelBoundsAt(anchor, qout, day)); },
    inBounds: (v) => v >= dragLo && v <= dragHi,
    end: (day, value) => {
      const level = typeof value === 'number' ? value : value.y; // onDragEnd passes the {x,y} point
      const target = Math.min(Math.max(level, dragLo), dragHi);
      qout[day] = solveQoutAt(anchor, qout, day, target);
      const inp = tableWrap.querySelectorAll('input')[day];
      if (inp) inp.value = qout[day].toFixed(1);
      setTimeout(recompute, 0); // defer: don't rebuild the chart inside its own drag event
    },
  };

  const render = (fresh) => {
    if (view === 'stats') renderForecastChart(canvas(), { bundle, band, drag: qout ? drag : null, fresh });
    else renderEnsembleChart(canvas(), { bundle, band });
  };
  const recompute = (fresh) => { band = recomputeBand(anchor, qout); render(fresh); };

  wireAnchor(bundle, anchor, (v) => { anchor = v; recompute(); }, () => {
    anchor = reconstruction.anchorLevel;
    if (qout !== null) qout = [...recomputeBand(anchor, null).qout]; // restore the rule-default schedule
    recompute(true);                 // fresh render: reset zoom and re-center
    if (qout !== null) buildTable();  // re-prefill the table from the reset band
  });

  const segs = (sel, fn) => panel.querySelectorAll(sel).forEach((b) => {
    b.onclick = () => { panel.querySelectorAll(sel).forEach((x) => x.classList.toggle('active', x === b)); fn(b); };
  });
  segs('#view-toggle .seg', (b) => { view = b.dataset.view; render(); });

  let qTimer;
  const buildTable = () => {
    tableWrap.innerHTML = `<table class="qout-table"><caption>Outflow (m³/s)</caption><thead><tr>${
      band.dates.map((d) => `<th>${d.slice(5)}</th>`).join('')
    }</tr></thead><tbody><tr>${
      band.qout.map((q) => `<td><input type="number" min="0" step="0.1" value="${q.toFixed(1)}"></td>`).join('')
    }</tr></tbody></table>`;
    tableWrap.querySelectorAll('input').forEach((inp) => {
      inp.addEventListener('input', () => {
        clearTimeout(qTimer);
        qTimer = setTimeout(() => {
          qout = [...tableWrap.querySelectorAll('input')].map((i) => Math.max(0, parseFloat(i.value) || 0));
          recompute();
        }, 200);
      });
      inp.addEventListener('change', () => { inp.value = Math.max(0, parseFloat(inp.value) || 0).toFixed(1); });
    });
  };
  segs('#qout-toggle .seg', (b) => {
    if (b.dataset.qmode === 'rule') { qout = null; tableWrap.hidden = true; recompute(); }
    // manual: seed the schedule from the current rule run, enable the table + drag handles
    else { qout = [...band.qout]; buildTable(); tableWrap.hidden = false; render(); }
  });

  return { render, getBand: () => band };
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
    const { reconstruction, band, recomputeBand, levelBoundsAt, solveQoutAt, generated } = await computeReservoir(bundle);
    panel.innerHTML = shell(r.name, `
      <p class="muted">operating band ${bundle.min_level}–${bundle.max_level} m${generated ? ` · forecast as of ${esc(generated)}` : ''}</p>
      <div class="tabs">
        <button class="tab" data-tab="history">History</button>
        <button class="tab" data-tab="forecast">15-day forecast</button>
        <button class="btn-download" id="dl-csv" title="Download the current tab's data as CSV">Download CSV</button>
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

    const fc = setupForecast(bundle, reconstruction, band, recomputeBand, levelBoundsAt, solveQoutAt);
    const showTab = (name) => {
      panel.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
      panel.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
      if (name === 'history') renderHistoryChart(panel.querySelector('#chart-history'), { bundle, reconstruction });
      else fc.render();
    };
    panel.querySelectorAll('.tab').forEach((t) => { t.onclick = () => showTab(t.dataset.tab); });
    panel.querySelector('#dl-csv').onclick = () => {
      if (panel.querySelector('.tab.active')?.dataset.tab === 'forecast') {
        downloadCsv(`${r.id}-forecast.csv`, forecastRows(fc.getBand()));
      } else {
        downloadCsv(`${r.id}-history.csv`, historyRows(bundle, reconstruction));
      }
    };
    showTab('history');
  } catch (err) {
    panel.innerHTML = shell(r.name,
      `<p class="error">Failed to load: ${esc(err.message)}</p><button class="btn-retry">Retry</button>`);
    panel.querySelector('.panel-close').onclick = closePanel;
    panel.querySelector('.btn-retry').onclick = () => showReservoir(r);
  }
}

const EYE_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';

// Build the sidebar as country folders + map markers from the reservoir index.
async function buildUI() {
  const reservoirs = await fetch(`${BASE}reservoirs/index.json`).then((r) => r.json());
  const list = document.getElementById('reservoir-list');
  const bounds = new maplibregl.LngLatBounds();

  const byCountry = new Map();
  for (const r of reservoirs) {
    if (!byCountry.has(r.country)) byCountry.set(r.country, []);
    byCountry.get(r.country).push(r);
    idCountry.set(r.id, r.country);
  }

  for (const [country, items] of [...byCountry].sort((a, b) => a[0].localeCompare(b[0]))) {
    const groupEl = document.createElement('li');
    groupEl.className = 'group';
    const header = document.createElement('div');
    header.className = 'group-header expanded';
    header.innerHTML = `<span class="chevron"></span><span class="group-name"></span>`
      + `<span class="group-count">${items.length}</span>`
      + `<button class="eye" title="Show/hide on map" aria-label="Show/hide on map">${EYE_SVG}</button>`;
    header.querySelector('.group-name').textContent = country;
    const itemsEl = document.createElement('ul');
    itemsEl.className = 'group-items';

    const groupMarkers = [];
    for (const r of items.sort((a, b) => a.name.localeCompare(b.name))) {
      const marker = new maplibregl.Marker({ color: '#38bdf8' }).setLngLat([r.lon, r.lat]).addTo(map);
      const el = marker.getElement();
      el.classList.add('reservoir-marker');
      el.style.cursor = 'pointer';
      el.title = r.name;
      el.addEventListener('click', () => showReservoir(r));
      markerEls.set(r.id, el);
      groupMarkers.push(el);

      const li = document.createElement('li');
      li.className = 'reservoir-item';
      li.textContent = r.name;
      li.addEventListener('click', () => showReservoir(r));
      itemsEl.appendChild(li);
      listEls.set(r.id, li);
      bounds.extend([r.lon, r.lat]);
    }

    groups.set(country, { itemsEl, headerEl: header });
    header.addEventListener('click', (e) => {
      if (e.target.closest('.eye')) return;
      expandGroup(country, itemsEl.hidden); // toggle
    });
    let visible = true;
    header.querySelector('.eye').addEventListener('click', (e) => {
      e.stopPropagation();
      visible = !visible;
      groupMarkers.forEach((m) => { m.style.display = visible ? '' : 'none'; });
      e.currentTarget.classList.toggle('off', !visible);
    });

    groupEl.append(header, itemsEl);
    list.appendChild(groupEl);
  }
  if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 80, maxZoom: 9 });
  reservoirs.forEach((r) => preloadReservoir(r.id).catch(() => {})); // warm cache for instant open
}

map.on('load', buildUI);
