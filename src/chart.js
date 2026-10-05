import { Chart } from 'chart.js/auto';
import 'chartjs-adapter-date-fns';
import zoomPlugin from 'chartjs-plugin-zoom';
import dragDataPlugin from 'chartjs-plugin-dragdata';

Chart.register(zoomPlugin, dragDataPlugin);

// Theme-aware chart colors for the dark panel (GEOGLOWS convention).
const AXIS = '#94a3b8';
const GRID = 'rgba(148,163,184,0.12)';
const TEXT = '#e2e8f0';

const pt = (dates, values) => dates.map((d, i) => ({ x: d, y: values[i] }));
const ms = (isoDate) => new Date(isoDate).getTime();
const DAY_MS = 86400000;
const opLines = (min, max, x0, x1) => [
  { label: 'Max level', data: [{ x: x0, y: max }, { x: x1, y: max }], borderColor: '#FF0000', borderDash: [5, 4], borderWidth: 1, pointRadius: 0, dragData: false },
  { label: 'Min level', data: [{ x: x0, y: min }, { x: x1, y: min }], borderColor: '#660066', borderDash: [5, 4], borderWidth: 1, pointRadius: 0, dragData: false },
];

// xRange (optional): { view: {min,max}, limits: {min,max} } in epoch ms — sets the
// default visible window and how far the user may zoom/pan out.
const baseOptions = (xRange, { pan = true, unit, panModifier } = {}) => {
  const time = { tooltipFormat: 'yyyy-MM-dd' };
  if (unit) { time.unit = unit; time.displayFormats = { [unit]: 'MMM d' }; }
  const x = { type: 'time', time, ticks: { color: AXIS, maxRotation: 0, autoSkip: true }, grid: { color: GRID } };
  const zoom = {
    zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' },
    pan: { enabled: pan, mode: 'x', modifierKey: panModifier },
  };
  if (xRange) {
    x.min = xRange.view.min;
    x.max = xRange.view.max;
    zoom.limits = { x: { min: xRange.limits.min, max: xRange.limits.max } };
  }
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    scales: {
      x,
      y: { title: { display: true, text: 'Level (m)', color: AXIS }, ticks: { color: AXIS }, grid: { color: GRID } },
    },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: TEXT, boxWidth: 12, font: { size: 10 }, filter: (l) => !l.text.startsWith('_') } },
      zoom,
      dragData: false, // only the forecast chart opts in
    },
  };
};

let historyChart, forecastChart;

// Observed history + reconstruction + operating-band lines. Opens on the last ~2
// years (where the reconstruction lives); zoom/pan out to the full record.
export function renderHistoryChart(canvas, { bundle, reconstruction }) {
  if (historyChart) historyChart.destroy();
  const obs = bundle.observed_levels;
  const end = reconstruction.dates.at(-1);
  const viewMin = `${Number(end.slice(0, 4)) - 2}${end.slice(4)}`;
  const xRange = { view: { min: ms(viewMin), max: ms(end) }, limits: { min: ms(obs.dates[0]), max: ms(end) } };
  historyChart = new Chart(canvas, {
    type: 'line',
    data: {
      datasets: [
        ...opLines(bundle.min_level, bundle.max_level, obs.dates[0], end),
        { label: 'Observed', data: pt(obs.dates, obs.levels), borderColor: '#0a6b7c', borderWidth: 1, pointRadius: 0, spanGaps: false },
        { label: 'Reconstruction', data: pt(reconstruction.dates, reconstruction.levels), borderColor: '#D55E00', borderWidth: 1.5, pointRadius: 0 },
      ],
    },
    options: baseOptions(xRange),
  });
  return historyChart;
}

// 15-day forecast: mean/median + min–max and p25–p75 ensemble bands + operating lines.
// drag (optional): enables dragging the Mean line vertically to back-solve outflow.
export function renderForecastChart(canvas, { bundle, band, drag, fresh }) {
  const datasets = [
    ...opLines(bundle.min_level, bundle.max_level, band.dates[0], band.dates.at(-1)),
    { label: 'Min–max', data: pt(band.dates, band.max), borderColor: 'transparent', backgroundColor: 'rgba(173,216,230,0.4)', pointRadius: 0, fill: '+1', dragData: false },
    { label: '_min', data: pt(band.dates, band.min), borderColor: 'transparent', pointRadius: 0, dragData: false },
    { label: '25–75%', data: pt(band.dates, band.p75), borderColor: 'transparent', backgroundColor: 'rgba(144,238,144,0.5)', pointRadius: 0, fill: '+1', dragData: false },
    { label: '_p25', data: pt(band.dates, band.p25), borderColor: 'transparent', pointRadius: 0, dragData: false },
    { label: 'Mean', data: pt(band.dates, band.mean), borderColor: '#0a49b0', borderWidth: 2, pointRadius: drag ? 5 : 0, pointHoverRadius: drag ? 8 : 0, pointHitRadius: drag ? 14 : 0, pointBackgroundColor: '#0a49b0', dragData: !!drag },
    { label: 'Median', data: pt(band.dates, band.median), borderColor: '#c81e1e', borderWidth: 2, pointRadius: 0, dragData: false },
  ];
  // Same chart kind + drag state: update in place so zoom survives a drag/anchor recompute.
  // `fresh` forces a rebuild (Reset button) to clear zoom and re-center.
  if (!fresh && forecastChart && forecastChart.$kind === 'stats' && forecastChart.$drag === !!drag) {
    forecastChart.data.datasets = datasets;
    forecastChart.update('none');
    return forecastChart;
  }
  if (forecastChart) forecastChart.destroy();
  const options = forecastOptions(drag);
  options.plugins.zoom.limits = { x: { min: ms(band.dates[0]) - DAY_MS, max: ms(band.dates.at(-1)) + DAY_MS } };
  forecastChart = new Chart(canvas, { type: 'line', data: { datasets }, options });
  forecastChart.$kind = 'stats';
  forecastChart.$drag = !!drag;
  canvas.ondblclick = () => forecastChart.resetZoom(); // dbl-click resets zoom/pan
  return forecastChart;
}

// Forecast chart options, with optional vertical drag on the Mean line (manual outflow).
function forecastOptions(drag) {
  const options = baseOptions(undefined, { pan: true, unit: 'day', panModifier: 'ctrl' }); // Ctrl+drag pans
  if (!drag) { options.plugins.dragData = false; return options; }
  options.interaction = { mode: 'nearest', intersect: true }; // grab the Mean handle, not an op-line
  options.plugins.dragData = {
    round: 2,
    showTooltip: true,
    dragX: false, // vertical only: the day is fixed, only the level moves
    onDragStart: (e, di, index) => { drag.start(index); },
    onDrag: (e, di, index, value) => (drag.inBounds(typeof value === 'number' ? value : value.y) ? undefined : false),
    onDragEnd: (e, di, index, value) => { drag.end(index, value); },
  };
  return options;
}

// 15-day forecast, all ensemble member trajectories + median + operating lines.
export function renderEnsembleChart(canvas, { bundle, band }) {
  if (forecastChart) forecastChart.destroy();
  const members = band.members.map((m) => ({
    label: '_member', data: pt(band.dates, m),
    borderColor: 'rgba(148,163,184,0.35)', borderWidth: 1, pointRadius: 0,
  }));
  const options = baseOptions(undefined, { pan: true, unit: 'day', panModifier: 'ctrl' }); // Ctrl+drag pans
  options.plugins.zoom.limits = { x: { min: ms(band.dates[0]) - DAY_MS, max: ms(band.dates.at(-1)) + DAY_MS } };
  forecastChart = new Chart(canvas, {
    type: 'line',
    data: {
      datasets: [
        ...opLines(bundle.min_level, bundle.max_level, band.dates[0], band.dates.at(-1)),
        ...members,
        { label: 'Median', data: pt(band.dates, band.median), borderColor: '#c81e1e', borderWidth: 2, pointRadius: 0 },
      ],
    },
    options,
  });
  forecastChart.$kind = 'ensembles';
  canvas.ondblclick = () => forecastChart.resetZoom();
  return forecastChart;
}
