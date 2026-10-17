import maplibregl from 'maplibre-gl';

export const ll = (p: number[]) => [p[1], p[0]] as [number, number];
export const line = (path: number[][], props: Record<string, any> = {}) => ({
  type: 'Feature' as const,
  properties: props,
  geometry: { type: 'LineString' as const, coordinates: path.map(ll) },
});
export const point = (p: number[], props: Record<string, any> = {}) => ({
  type: 'Feature' as const,
  properties: props,
  geometry: { type: 'Point' as const, coordinates: ll(p) },
});
export const fc = (features: any[]) => ({ type: 'FeatureCollection' as const, features });
export const FONT = ['Noto Sans Regular'];

export function createMap(container: HTMLElement, style: string) {
  const map = new maplibregl.Map({
    container,
    style,
    attributionControl: false,
    pitchWithRotate: false,
    dragRotate: false,
    touchPitch: false,
    fadeDuration: 0,
    center: [-73.98, 40.74],
    zoom: 12,
  });
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'top-right');
  map.touchZoomRotate.disableRotation();
  // collapse the compact attribution to its (i) button once it has rendered
  map.once('idle', () => {
    const attrib = container.querySelector('.maplibregl-ctrl-attrib');
    attrib?.classList.remove('maplibregl-compact-show');
    attrib?.removeAttribute('open');
  });
  return map;
}

/** Quieten the basemap so the commute is the brightest thing on screen. */
export function quietBasemap(map: maplibregl.Map, isDark: boolean) {
  for (const l of map.getStyle().layers ?? []) {
    try {
      if (l.type === 'line') map.setPaintProperty(l.id, 'line-opacity', isDark ? 0.5 : 0.65);
      if (l.type === 'symbol') map.setPaintProperty(l.id, 'text-opacity', isDark ? 0.45 : 0.6);
      if (isDark && l.type === 'fill' && /water/.test(l.id)) map.setPaintProperty(l.id, 'fill-color', '#0d1726');
      if (isDark && l.type === 'background') map.setPaintProperty(l.id, 'background-color', '#0b0d12');
    } catch {
      /* some layers have expression-driven paint; leave them */
    }
  }
}

export function setData(map: maplibregl.Map, id: string, data: any) {
  const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
  if (src) src.setData(data);
  else map.addSource(id, { type: 'geojson', data });
}

/**
 * Fit points into a padded box on a ROTATED map (fitBounds fits the unrotated lat/lon box, which
 * leaves a tall diagonal route tiny). Returns { center, zoom } for jumpTo.
 */
export function cameraFor(pts: number[][], bearingDeg: number, pad: { top: number; bottom: number; left: number; right: number }, el: HTMLElement) {
  const W = Math.max(50, el.clientWidth);
  const H = Math.max(50, el.clientHeight);
  const lat0 = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const lon0 = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110540;
  const th = (bearingDeg * Math.PI) / 180;
  const r = pts.map((p) => {
    const e = (p[1] - lon0) * kx;
    const n = (p[0] - lat0) * ky;
    return [e * Math.cos(th) - n * Math.sin(th), n * Math.cos(th) + e * Math.sin(th)];
  });
  const xs = r.map((q) => q[0]);
  const ys = r.map((q) => q[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const aw = Math.max(40, W - pad.left - pad.right);
  const ah = Math.max(40, H - pad.top - pad.bottom);
  const mpp = Math.max((x1 - x0) / aw, (y1 - y0) / ah, 0.6);
  const cx = (x0 + x1) / 2 + (W / 2 - (pad.left + aw / 2)) * mpp;
  const cy = (y0 + y1) / 2 - (H / 2 - (pad.top + ah / 2)) * mpp;
  const e = cx * Math.cos(th) + cy * Math.sin(th);
  const n = -cx * Math.sin(th) + cy * Math.cos(th);
  const lat = lat0 + n / ky;
  return {
    center: [lon0 + e / kx, lat] as [number, number],
    zoom: Math.min(17, Math.log2((40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * mpp))),
  };
}

export const halo = (isDark: boolean) => ({ 'text-halo-color': isDark ? '#0b0d12' : '#ffffff', 'text-halo-width': 1.8 });
