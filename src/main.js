import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';

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

async function addReservoirMarkers() {
  const url = `${import.meta.env.BASE_URL}reservoirs/index.json`;
  const reservoirs = await fetch(url).then((r) => r.json());
  const bounds = new maplibregl.LngLatBounds();
  for (const r of reservoirs) {
    const popup = new maplibregl.Popup({ offset: 24 }).setHTML(
      `<strong>${r.name}</strong>`
    );
    new maplibregl.Marker({ color: '#1d6fb8' })
      .setLngLat([r.lon, r.lat])
      .setPopup(popup)
      .addTo(map);
    bounds.extend([r.lon, r.lat]);
  }
  if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 80, maxZoom: 9 });
}

map.on('load', addReservoirMarkers);
