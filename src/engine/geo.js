// Geodesy helpers. Positions are [lat, lon] in degrees; distances in meters.

const R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

export function haversine(a, b) {
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing a -> b, degrees clockwise from north, 0..360. */
export function bearing(a, b) {
  const p1 = toRad(a[0]);
  const p2 = toRad(b[0]);
  const dl = toRad(b[1] - a[1]);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Smallest absolute difference between two bearings, 0..180. */
export function bearingDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Move `origin` by meters east/north (small-distance approximation). */
export function offset(origin, eastM, northM) {
  const lat = origin[0] + northM / 111320;
  const lon = origin[1] + eastM / (111320 * Math.cos(toRad(origin[0])));
  return [lat, lon];
}

export function pathLength(path) {
  let d = 0;
  for (let i = 1; i < path.length; i++) d += haversine(path[i - 1], path[i]);
  return d;
}

/** Point at distance `dist` along a polyline (clamped to its ends). */
export function pointAlong(path, dist) {
  if (dist <= 0) return path[0].slice();
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const seg = haversine(path[i - 1], path[i]);
    if (acc + seg >= dist) {
      const f = seg === 0 ? 0 : (dist - acc) / seg;
      const a = path[i - 1];
      const b = path[i];
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
    acc += seg;
  }
  return path[path.length - 1].slice();
}

/** Split a polyline at distance `dist` into [head, tail]. */
export function splitPath(path, dist) {
  const head = [path[0]];
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const seg = haversine(path[i - 1], path[i]);
    if (acc + seg >= dist) {
      const p = pointAlong([path[i - 1], path[i]], dist - acc);
      head.push(p);
      return [head, [p, ...path.slice(i)]];
    }
    head.push(path[i]);
    acc += seg;
  }
  const end = path[path.length - 1];
  return [head, [end, end]];
}

/** Cumulative distance at every vertex of a polyline. */
export function cumulative(path) {
  const out = [0];
  for (let i = 1; i < path.length; i++) out.push(out[i - 1] + haversine(path[i - 1], path[i]));
  return out;
}

/** Sub-polyline between distances d0 and d1 along `path` (reversed when d1 < d0). */
export function slicePath(path, d0, d1, cum = cumulative(path)) {
  if (d1 < d0) return slicePath(path, d1, d0, cum).reverse();
  const total = cum[cum.length - 1];
  const a = Math.max(0, Math.min(total, d0));
  const b = Math.max(0, Math.min(total, d1));
  const out = [pointAlong(path, a)];
  for (let i = 1; i < path.length - 1; i++) if (cum[i] > a && cum[i] < b) out.push(path[i]);
  out.push(pointAlong(path, b));
  return out;
}

/** Projection of `p` onto `path`: distance along it and offset from it, in metres. */
export function projectOnPath(path, p, cum = cumulative(path)) {
  const kx = 111320 * Math.cos(toRad(p[0]));
  const ky = 110540;
  let best = { dist: 0, off: Infinity };
  for (let i = 1; i < path.length; i++) {
    const ax = (path[i - 1][1] - p[1]) * kx;
    const ay = (path[i - 1][0] - p[0]) * ky;
    const dx = (path[i][1] - p[1]) * kx - ax;
    const dy = (path[i][0] - p[0]) * ky - ay;
    const L2 = dx * dx + dy * dy || 1e-9;
    const t = Math.max(0, Math.min(1, (-ax * dx - ay * dy) / L2));
    const off = Math.hypot(ax + t * dx, ay + t * dy);
    if (off < best.off) best = { dist: cum[i - 1] + t * (cum[i] - cum[i - 1]), off };
  }
  return best;
}

/** Add isotropic gaussian noise of ~`meters` standard deviation. */
export function jitter(p, meters, gauss) {
  if (!meters) return p;
  return offset(p, gauss() * meters, gauss() * meters);
}
