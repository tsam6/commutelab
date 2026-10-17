#!/usr/bin/env node
/**
 * Builds CommuteLab's bundled NYC transit data from public open data:
 *   MTA static GTFS (subway)             https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip
 *   MTA Subway Stations (data.ny.gov)    https://data.ny.gov/resource/39hk-dx4f.json
 *   Citi Bike GBFS station information   https://gbfs.lyft.com/gbfs/1.1/bkn/en/station_information.json
 *   Walk/bike paths for the preset trip  FOSSGIS OSRM, https://routing.openstreetmap.de
 *
 * Writes public/data/nyc-subway.json, public/data/citibike.json and public/data/demo-route.json.
 * Downloads go through curl (system trust store) into scripts/.cache and are reused for a week;
 * pass --fresh to download again. Usage: npm run data [-- --fresh]
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'scripts', '.cache');
const OUT = path.join(ROOT, 'public', 'data');
const FRESH = process.argv.includes('--fresh');
const UA = 'CommuteLab-data/0.2 (open-source commute benchmarking app)';
const SRC = {
  gtfs: 'https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip',
  stations: 'https://data.ny.gov/resource/39hk-dx4f.json?$limit=2000',
  citibike: 'https://gbfs.lyft.com/gbfs/1.1/bkn/en/station_information.json',
};
// Daytime window used to pick stopping patterns and measure headways (weekdays, 07:00-19:00).
const DAY_START = 7 * 3600;
const DAY_END = 19 * 3600;
const WINDOW_SEC = DAY_END - DAY_START;

mkdirSync(CACHE, { recursive: true });
mkdirSync(OUT, { recursive: true });

function download(url, file) {
  const dest = path.join(CACHE, file);
  if (!FRESH && existsSync(dest) && Date.now() - statSync(dest).mtimeMs < 7 * 864e5) return dest;
  console.log(`downloading ${url}`);
  execFileSync('curl', ['-sSfL', '-m', '240', '-A', UA, '-o', dest, url], { stdio: 'inherit' });
  return dest;
}

// ------------------------------------------------------------------ CSV helpers
function parseLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function readCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const head = parseLine(lines[0].replace(/^\uFEFF/, ''));
  return lines.slice(1).map((l) => {
    const v = parseLine(l);
    const o = {};
    head.forEach((h, i) => { o[h] = v[i] ?? ''; });
    return o;
  });
}

const zipText = (zip, name) => execFileSync('unzip', ['-p', zip, name], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

/** Stream a (quote-free) CSV member of the zip line by line: onRow(fields, headerIndex). */
function streamZipCsv(zip, name, onRow) {
  return new Promise((resolve, reject) => {
    const child = spawn('unzip', ['-p', zip, name]);
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let head = null;
    rl.on('line', (line) => {
      if (!line) return;
      if (!head) {
        head = Object.fromEntries(line.replace(/^\uFEFF/, '').split(',').map((h, i) => [h, i]));
        return;
      }
      onRow(line.split(','), head);
    });
    rl.on('close', resolve);
    child.on('error', reject);
  });
}

const parseTime = (s) => {
  const [h, m, x] = s.split(':').map(Number);
  return h * 3600 + m * 60 + x;
};
const median = (xs) => {
  const v = xs.slice().sort((a, b) => a - b);
  const n = v.length;
  return n ? (n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2) : NaN;
};
const r5 = (v) => Math.round(v * 1e5) / 1e5;

// ------------------------------------------------------------------ geometry helpers
const toRad = (d) => (d * Math.PI) / 180;
function hav(a, b) {
  const s = Math.sin(toRad(b[0] - a[0]) / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(toRad(b[1] - a[1]) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(s)));
}
const KY = 110540;
const kx = (lat) => 111320 * Math.cos(toRad(lat));

/** Douglas-Peucker in local metres. */
function simplify(pts, tolM) {
  if (pts.length < 3) return pts;
  const lat0 = pts[0][0];
  const X = (p) => [(p[1] - pts[0][1]) * kx(lat0), (p[0] - lat0) * KY];
  const xy = pts.map(X);
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = xy[a];
    const [bx, by] = xy[b];
    const dx = bx - ax;
    const dy = by - ay;
    const L2 = dx * dx + dy * dy || 1e-9;
    let best = -1;
    let bestD = 0;
    for (let i = a + 1; i < b; i++) {
      const t = Math.max(0, Math.min(1, ((xy[i][0] - ax) * dx + (xy[i][1] - ay) * dy) / L2));
      const d = Math.hypot(xy[i][0] - (ax + t * dx), xy[i][1] - (ay + t * dy));
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best > 0 && bestD > tolM) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

const cumulative = (poly) => {
  const c = [0];
  for (let i = 1; i < poly.length; i++) c.push(c[i - 1] + hav(poly[i - 1], poly[i]));
  return c;
};

/** Distance along `poly` of the projection of `p`, searching only at or after `fromDist` (minus slack). */
function projectAlong(poly, cum, p, fromDist) {
  let best = { dist: NaN, off: Infinity };
  const k = kx(p[0]);
  for (let i = 1; i < poly.length; i++) {
    if (cum[i] < fromDist - 80) continue;
    const a = poly[i - 1];
    const b = poly[i];
    const ax = (a[1] - p[1]) * k;
    const ay = (a[0] - p[0]) * KY;
    const bx = (b[1] - p[1]) * k;
    const by = (b[0] - p[0]) * KY;
    const dx = bx - ax;
    const dy = by - ay;
    const L2 = dx * dx + dy * dy || 1e-9;
    const t = Math.max(0, Math.min(1, (-ax * dx - ay * dy) / L2));
    const off = Math.hypot(ax + t * dx, ay + t * dy);
    if (off < best.off) best = { dist: cum[i - 1] + t * (cum[i] - cum[i - 1]), off };
  }
  return best;
}

// ------------------------------------------------------------------ 1. GTFS
const zip = download(SRC.gtfs, 'gtfs_subway.zip');
const stationsFile = download(SRC.stations, 'mta_stations.json');
const bikeFile = download(SRC.citibike, 'citibike_stations.json');

const today = Number(new Date().toISOString().slice(0, 10).replace(/-/g, ''));
let weekday = readCsv(zipText(zip, 'calendar.txt')).filter((c) => c.monday === '1' && c.friday === '1');
const activeNow = weekday.filter((c) => Number(c.start_date) <= today && today <= Number(c.end_date));
if (activeNow.length) weekday = activeNow;
const services = new Set(weekday.map((c) => c.service_id));
if (!services.size) throw new Error('No weekday service found in calendar.txt');

const routesCsv = readCsv(zipText(zip, 'routes.txt'));
const stopsCsv = readCsv(zipText(zip, 'stops.txt'));
const parentOf = new Map();
const gtfsStop = new Map();
for (const s of stopsCsv) {
  parentOf.set(s.stop_id, s.parent_station || s.stop_id);
  if (!s.parent_station) gtfsStop.set(s.stop_id, s);
}

const tripInfo = new Map();
for (const t of readCsv(zipText(zip, 'trips.txt'))) {
  if (services.has(t.service_id)) tripInfo.set(t.trip_id, { route: t.route_id, dir: Number(t.direction_id), shape: t.shape_id });
}
console.log(`weekday services: ${[...services].join(', ')} | trips: ${tripInfo.size}`);

const tripStops = new Map();
await streamZipCsv(zip, 'stop_times.txt', (f, h) => {
  const trip = f[h.trip_id];
  if (!tripInfo.has(trip)) return;
  let list = tripStops.get(trip);
  if (!list) tripStops.set(trip, (list = []));
  list.push([Number(f[h.stop_sequence]), parentOf.get(f[h.stop_id]) ?? f[h.stop_id], parseTime(f[h.arrival_time]), parseTime(f[h.departure_time])]);
});

// Group daytime trips into stopping patterns.
const groups = new Map();
for (const [trip, st] of tripStops) {
  st.sort((a, b) => a[0] - b[0]);
  const t0 = st[0][3];
  if (t0 < DAY_START || t0 >= DAY_END) continue;
  const info = tripInfo.get(trip);
  const stops = st.map((s) => s[1]);
  const key = `${info.route}|${info.dir}|${stops.join(',')}`;
  let g = groups.get(key);
  if (!g) groups.set(key, (g = { route: info.route, dir: info.dir, stops, n: 0, offsets: stops.map(() => []), shapes: new Map() }));
  g.n++;
  st.forEach((s, i) => g.offsets[i].push(s[2] - t0));
  g.shapes.set(info.shape, (g.shapes.get(info.shape) ?? 0) + 1);
}

const byRouteDir = new Map();
for (const g of groups.values()) {
  const k = `${g.route}|${g.dir}`;
  if (!byRouteDir.has(k)) byRouteDir.set(k, []);
  byRouteDir.get(k).push(g);
}
const kept = [];
for (const list of byRouteDir.values()) {
  const total = list.reduce((a, g) => a + g.n, 0);
  list.sort((a, b) => b.n - a.n);
  kept.push(...list.filter((g) => g.n >= Math.max(3, total * 0.1)).slice(0, 4));
}

// Track shapes for the kept patterns.
const shapePts = new Map();
for (const g of kept) for (const id of g.shapes.keys()) shapePts.set(id, []);
for (const row of readCsv(zipText(zip, 'shapes.txt'))) {
  const list = shapePts.get(row.shape_id);
  if (list) list.push([Number(row.shape_pt_sequence), Number(row.shape_pt_lat), Number(row.shape_pt_lon)]);
}
const shapes = [];
const shapeIndex = new Map();
function shapeFor(g) {
  const ids = [...g.shapes.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  for (const id of ids) {
    const raw = shapePts.get(id);
    if (!raw || raw.length < 2) continue;
    if (!shapeIndex.has(id)) {
      const poly = simplify(raw.sort((a, b) => a[0] - b[0]).map(([, la, lo]) => [la, lo]), 4).map(([la, lo]) => [r5(la), r5(lo)]);
      shapeIndex.set(id, shapes.length);
      shapes.push(poly);
    }
    return shapeIndex.get(id);
  }
  return -1;
}

const stationPos = (id) => {
  const s = gtfsStop.get(id);
  return s ? [Number(s.stop_lat), Number(s.stop_lon)] : null;
};

const patterns = [];
let unmatched = 0;
for (const g of kept.sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : a.dir - b.dir || b.n - a.n))) {
  const shape = shapeFor(g);
  let along = null;
  if (shape >= 0) {
    const poly = shapes[shape];
    const cum = cumulative(poly);
    along = [];
    let from = 0;
    for (const id of g.stops) {
      const p = stationPos(id);
      const pr = p ? projectAlong(poly, cum, p, from) : { off: Infinity };
      if (!(pr.off < 250)) { along = null; break; }
      along.push(Math.round(pr.dist));
      from = pr.dist;
    }
    if (!along) unmatched++;
  }
  patterns.push({
    route: g.route,
    dir: g.dir,
    n: g.n,
    stops: g.stops,
    t: g.offsets.map((o) => Math.round(median(o))),
    shape,
    along,
  });
}

// ------------------------------------------------------------------ 2. stations
const STRUCT = { Subway: 'subway', Elevated: 'elevated', 'At Grade': 'grade', 'Open Cut': 'open-cut', Embankment: 'embankment', Viaduct: 'viaduct' };
const mta = JSON.parse(readFileSync(stationsFile, 'utf8'));
const usedStops = new Set(patterns.flatMap((p) => p.stops));
const routesAt = new Map();
for (const p of patterns) for (const id of p.stops) {
  if (!routesAt.has(id)) routesAt.set(id, new Set());
  routesAt.get(id).add(p.route);
}
const stations = [];
const seen = new Set();
for (const s of mta) {
  const id = s.gtfs_stop_id;
  if (!id || seen.has(id)) continue;
  seen.add(id);
  const daytime = (s.daytime_routes || '').split(/\s+/).filter(Boolean);
  stations.push({
    id,
    name: s.stop_name,
    pos: [r5(Number(s.gtfs_latitude)), r5(Number(s.gtfs_longitude))],
    routes: daytime.length ? daytime : [...(routesAt.get(id) ?? [])].sort(),
    line: s.line || '',
    structure: STRUCT[s.structure] ?? 'subway',
    complex: s.complex_id || id,
    borough: s.borough || '',
  });
}
for (const id of usedStops) {
  if (seen.has(id)) continue;
  const g = gtfsStop.get(id);
  if (!g) continue;
  stations.push({ id, name: g.stop_name, pos: [r5(Number(g.stop_lat)), r5(Number(g.stop_lon))], routes: [...(routesAt.get(id) ?? [])].sort(), line: '', structure: 'subway', complex: id, borough: '' });
}

const routes = {};
for (const r of routesCsv) {
  if (!patterns.some((p) => p.route === r.route_id)) continue;
  routes[r.route_id] = {
    name: r.route_short_name || r.route_id,
    long: r.route_long_name || '',
    color: `#${(r.route_color || '808183').toUpperCase()}`,
    text: `#${(r.route_text_color || 'FFFFFF').toUpperCase()}`,
  };
}

const generated = new Date().toISOString().slice(0, 10);
writeFileSync(
  path.join(OUT, 'nyc-subway.json'),
  JSON.stringify({ generated, window: { start: DAY_START, end: DAY_END }, sources: { gtfs: SRC.gtfs, stations: SRC.stations.split('?')[0] }, routes, stations, patterns, shapes }),
);

// ------------------------------------------------------------------ 3. Citi Bike docks
const bike = JSON.parse(readFileSync(bikeFile, 'utf8')).data.stations;
const docks = bike
  .filter((d) => isFinite(d.lat) && isFinite(d.lon))
  .map((d) => [String(d.short_name || d.station_id), d.name, r5(d.lat), r5(d.lon), d.capacity ?? 0]);
writeFileSync(path.join(OUT, 'citibike.json'), JSON.stringify({ generated, source: SRC.citibike, fields: ['id', 'name', 'lat', 'lon', 'capacity'], docks }));

// ------------------------------------------------------------------ 4. the preset commute (East Village -> Hunter College)
function osrm(a, b, profile) {
  const url = `https://routing.openstreetmap.de/routed-${profile}/route/v1/driving/${a[1]},${a[0]};${b[1]},${b[0]}?overview=full&geometries=geojson`;
  try {
    const out = execFileSync('curl', ['-sSf', '-m', '30', '-A', UA, url], { encoding: 'utf8' });
    const rt = JSON.parse(out).routes[0];
    return { path: rt.geometry.coordinates.map(([lo, la]) => [r5(la), r5(lo)]), meters: Math.round(rt.distance) };
  } catch (err) {
    console.warn(`OSRM ${profile} route failed (${err.message.split('\n')[0]}); using a straight line`);
    return { path: [a, b], meters: Math.round(hav(a, b)) };
  }
}
const home = [40.72335, -73.98163]; // a made-up East Village block near Avenue B
const school = [40.768601, -73.964704]; // 695 Park Ave (Hunter College), from NYC GeoSearch
const nearest = docks.reduce((best, d) => (!best || hav(home, [d[2], d[3]]) < hav(home, [best[2], best[3]]) ? d : best), null);
const dockPos = [nearest[2], nearest[3]];
const stationById = new Map(stations.map((s) => [s.id, s]));
let walk = osrm(home, dockPos, 'foot');
if (walk.meters > 2 * hav(home, dockPos)) walk = { path: [home, dockPos], meters: Math.round(hav(home, dockPos)) }; // mid-block detour
const bikePaths = {};
for (const id of ['636', '635']) bikePaths[id] = osrm(dockPos, stationById.get(id).pos, 'bike').path;
const demo = {
  name: 'Hunter College',
  icon: 'school',
  home: { label: 'Home · East Village', pos: home },
  destination: { label: 'Hunter College · 695 Park Ave', pos: school },
  dock: nearest[0],
  options: [
    { stops: ['636', '635', '629', '628'], routes: [['6'], ['4', '5'], ['6']] },
    { stops: ['636', '628'], routes: [['6']] },
    { stops: ['635', '629', '628'], routes: [['4', '5'], ['6']] },
  ],
  paths: { walk: walk.path, bike: bikePaths },
};
writeFileSync(path.join(OUT, 'demo-route.json'), JSON.stringify(demo));

// ------------------------------------------------------------------ report
const size = (f) => `${Math.round(statSync(path.join(OUT, f)).size / 1024)} KB`;
console.log(`patterns: ${patterns.length} (${unmatched} without usable shape) | shapes: ${shapes.length} | stations: ${stations.length} | routes: ${Object.keys(routes).length}`);
console.log(`docks: ${docks.length} | preset dock: ${nearest[1]} (${Math.round(hav(home, dockPos))} m from home)`);
console.log(`files: nyc-subway.json ${size('nyc-subway.json')}, citibike.json ${size('citibike.json')}, demo-route.json ${size('demo-route.json')}`);
