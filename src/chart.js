import { Chart } from 'chart.js/auto';
import 'chartjs-adapter-date-fns';
import zoomPlugin from 'chartjs-plugin-zoom';

Chart.register(zoomPlugin);

const pt = (dates, values) => dates.map((d, i) => ({ x: d, y: values[i] }));
const opLines = (min, max, x0, x1) => [
  { label: 'Max level', data: [{ x: x0, y: max }, { x: x1, y: max }], borderColor: '#b00020', borderDash: [5, 4], borderWidth: 1, pointRadius: 0 },
  { label: 'Min level', data: [{ x: x0, y: min }, { x: x1, y: min }], borderColor: '#660066', borderDash: [5, 4], borderWidth: 1, pointRadius: 0 },
];

const baseOptions = () => ({
  responsive: true,
  maintainAspectRatio: false,
  animation: false,
  scales: {
    x: { type: 'time', time: { tooltipFormat: 'yyyy-MM-dd' } },
    y: { title: { display: true, text: 'Level (m)' } },
  },
  interaction: { mode: 'index', intersect: false },
  plugins: {
    legend: { labels: { boxWidth: 12, font: { size: 10 }, filter: (l) => !l.text.startsWith('_') } },
    zoom: {
      zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' },
      pan: { enabled: true, mode: 'x' },
    },
  },
});

let historyChart, forecastChart;

// Observed history + reconstruction + operating-band lines, full timeline.
export function renderHistoryChart(canvas, { bundle, reconstruction }) {
  if (historyChart) historyChart.destroy();
  const obs = bundle.observed_levels;
  historyChart = new Chart(canvas, {
    type: 'line',
    data: {
      datasets: [
        ...opLines(bundle.min_level, bundle.max_level, obs.dates[0], reconstruction.dates.at(-1)),
        { label: 'Observed', data: pt(obs.dates, obs.levels), borderColor: '#1d6fb8', borderWidth: 1, pointRadius: 0, spanGaps: false },
        { label: 'Reconstruction', data: pt(reconstruction.dates, reconstruction.levels), borderColor: '#e8890c', borderWidth: 1.5, pointRadius: 0 },
      ],
    },
    options: baseOptions(),
  });
  return historyChart;
}

// 15-day forecast: median + min–max ensemble band + operating-band lines.
export function renderForecastChart(canvas, { bundle, band }) {
  if (forecastChart) forecastChart.destroy();
  forecastChart = new Chart(canvas, {
    type: 'line',
    data: {
      datasets: [
        ...opLines(bundle.min_level, bundle.max_level, band.dates[0], band.dates.at(-1)),
        { label: 'Min–max', data: pt(band.dates, band.max), borderColor: 'transparent', backgroundColor: 'rgba(173,216,230,0.4)', pointRadius: 0, fill: '+1' },
        { label: '_min', data: pt(band.dates, band.min), borderColor: 'transparent', pointRadius: 0 },
        { label: '25–75%', data: pt(band.dates, band.p75), borderColor: 'transparent', backgroundColor: 'rgba(144,238,144,0.5)', pointRadius: 0, fill: '+1' },
        { label: '_p25', data: pt(band.dates, band.p25), borderColor: 'transparent', pointRadius: 0 },
        { label: 'Mean', data: pt(band.dates, band.mean), borderColor: '#0a49b0', borderWidth: 2, pointRadius: 0 },
        { label: 'Median', data: pt(band.dates, band.median), borderColor: '#c81e1e', borderWidth: 2, pointRadius: 0 },
      ],
    },
    options: baseOptions(),
  });
  return forecastChart;
}
