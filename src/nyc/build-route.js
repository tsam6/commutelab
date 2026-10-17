// Real NYC transit data -> engine routes.
// The user picks places and taps stations; everything the engine and simulator need (geofences,
// which stations each train skips, track geometry, scheduled run times, headways) comes from the
// bundled MTA GTFS / data.ny.gov / Citi Bike snapshot built by scripts/build-nyc-data.mjs.
import { haversine, cumulative, slicePath, projectOnPath, pathLength, bearing } from '../engine/geo.js';
import { DEFAULT_MODEL, DEFAULT_THRESHOLDS, strategyPath } from '../engine/routes.js';

export const STRATEGY_COLORS = ['#FF9F43', '#FF5E7E', '#3DC1D3', '#A78BFA', '#FACC15', '#34D399'];
const ROUTE_ORDER = '1234567ACEBDFMGJZLNQRWSH';
const DWELL_MEAN = (DEFAULT_MODEL.dwellSec[0] + DEFAULT_MODEL.dwellSec[1]) / 2;

/** "6X" (rush-hour diamond express) and friends count as their base route. */
const baseRoute = (r, routes) => (/^[0-9A-Z]X$/.test(r) && routes[r[0]] ? r[0] : r);
export const routeSort = (a, b) => {
  const ia = ROUTE_ORDER.indexOf(a[0]);
  const ib = ROUTE_ORDER.indexOf(b[0]);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
};
export const nodeId = (complex) => `c${complex}`;

/** Build lookup tables once per data load. */
export function indexData(subway, citibike) {
  const stations = new Map(subway.stations.map((s) => [s.id, s]));
  const complexes = new Map();
  for (const s of subway.stations) {
    let c = complexes.get(s.complex);
    if (!c) complexes.set(s.complex, (c = { id: nodeId(s.complex), complex: s.complex, members: [], routes: new Set() }));
    c.members.push(s);
    s.routes.forEach((r) => c.routes.add(baseRoute(r, subway.routes)));
  }
  for (const c of complexes.values()) {
    c.pos = [c.members.reduce((a, s) => a + s.pos[0], 0) / c.members.length, c.members.reduce((a, s) => a + s.pos[1], 0) / c.members.length];
    const main = c.members.slice().sort((a, b) => b.routes.length - a.routes.length)[0];
    c.name = main.name;
    c.names = [...new Set(c.members.map((s) => s.name))];
    c.routes = [...c.routes].sort(routeSort);
    c.structure = main.structure;
    c.borough = main.borough;
  }
  const byNode = new Map([...complexes.values()].map((c) => [c.id, c]));
  const patternsAt = new Map();
  subway.patterns.forEach((p, pi) => p.stops.forEach((id, k) => {
    if (!patternsAt.has(id)) patternsAt.set(id, []);
    patternsAt.get(id).push({ p: pi, k });
  }));
  const docks = (citibike?.docks ?? []).map(([id, name, lat, lon, capacity]) => ({ id: String(id), name, pos: [lat, lon], capacity }));
  return { subway, stations, complexes, byNode, patternsAt, docks, shapeCum: new Map() };
}

/** A tapped id (complex node "c602" or a GTFS stop id "635") -> complex node. */
export function nodeOf(idx, id) {
  if (idx.byNode.has(id)) return idx.byNode.get(id);
  const st = idx.stations.get(id);
  return st ? idx.complexes.get(st.complex) : null;
}

export function nearestDocks(idx, pos, n = 5) {
  return idx.docks
    .map((d) => ({ ...d, dist: haversine(pos, d.pos) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, n);
}

export function stationsNear(idx, pos, radiusM) {
  return [...idx.byNode.values()]
    .map((c) => ({ ...c, dist: haversine(pos, c.pos) }))
    .filter((c) => c.dist <= radiusM)
    .sort((a, b) => a.dist - b.dist);
}

function shapeCum(idx, shape) {
  if (!idx.shapeCum.has(shape)) idx.shapeCum.set(shape, cumulative(idx.subway.shapes[shape]));
  return idx.shapeCum.get(shape);
}

/**
 * Every way to ride from one station to another without changing trains, grouped by stopping
 * pattern: e.g. 14 St-Union Sq -> 59 St gives the 4/5 express (2 stops) and the 6 local (6 stops).
 * Sorted by expected time (half the headway + scheduled ride).
 */
export function connections(idx, fromId, toId) {
  const A = nodeOf(idx, fromId);
  const B = nodeOf(idx, toId);
  if (!A || !B || A === B) return [];
  const routes = idx.subway.routes;
  const window = (idx.subway.window?.end ?? 68400) - (idx.subway.window?.start ?? 25200);
  const inB = new Set(B.members.map((s) => s.id));
  const groups = new Map();
  for (const a of A.members) {
    for (const { p, k } of idx.patternsAt.get(a.id) ?? []) {
      const pat = idx.subway.patterns[p];
      const j = pat.stops.findIndex((id, n) => n > k && inB.has(id));
      if (j < 0) continue;
      const stops = pat.stops.slice(k, j + 1);
      const key = stops.join(',');
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { key, stops, routes: new Set(), trips: 0, secs: [], patterns: [] }));
      g.routes.add(baseRoute(pat.route, routes));
      g.trips += pat.n;
      g.secs.push([pat.t[j] - pat.t[k], pat.n]);
      g.patterns.push({ p, i: k, j });
    }
  }
  const list = [...groups.values()].map((g) => {
    const rep = g.patterns.slice().sort((a, b) => idx.subway.patterns[b.p].n - idx.subway.patterns[a.p].n)[0];
    const totalN = g.secs.reduce((a, [, n]) => a + n, 0);
    const sec = g.secs.reduce((a, [s, n]) => a + s * n, 0) / totalN;
    const headway = window / Math.max(1, g.trips);
    const rs = [...g.routes].sort(routeSort);
    return {
      key: g.key,
      routes: rs,
      label: rs.join('/'),
      color: routes[rs[0]]?.color ?? '#808183',
      text: routes[rs[0]]?.text ?? '#FFFFFF',
      stops: g.stops,
      nStops: g.stops.length - 1,
      sec,
      headway,
      expected: sec + headway / 2,
      rep,
    };
  });
  // Physical order and skipped stations: a sibling pattern on the same platforms with more stops.
  for (const c of list) {
    const set = new Set(c.stops);
    const local = list
      .filter((o) => o !== c && o.stops[0] === c.stops[0] && o.stops[o.stops.length - 1] === c.stops[c.stops.length - 1] && o.stops.length > c.stops.length && c.stops.every((s) => o.stops.includes(s)))
      .sort((a, b) => b.stops.length - a.stops.length)[0];
    c.physical = local ? local.stops : c.stops;
    c.skips = c.physical.filter((s) => !set.has(s));
    // A ride is "local" when some other train stops at one of its stations and goes straight on to a
    // later one of its stations, skipping stops in between (the 4/5 runs Union Sq -> Grand Central).
    const at = new Map(c.stops.map((id, n) => [id, n]));
    const localRide = c.stops.some((id) =>
      (idx.patternsAt.get(id) ?? []).some(({ p, k }) => {
        const nx = idx.subway.patterns[p].stops[k + 1];
        const j = nx == null ? undefined : at.get(nx);
        return j != null && j > at.get(id) + 1;
      }),
    );
    c.kind = c.skips.length ? 'express' : localRide ? 'local' : null;
  }
  return list.sort((a, b) => a.expected - b.expected);
}

/** Track geometry for one connection, plus the distance along it of every physical station. */
function connectionGeometry(idx, c) {
  const pat = idx.subway.patterns[c.rep.p];
  const pos = (id) => idx.stations.get(id)?.pos;
  if (pat.shape >= 0 && pat.along) {
    const shape = idx.subway.shapes[pat.shape];
    const cum = shapeCum(idx, pat.shape);
    const d0 = pat.along[c.rep.i];
    const d1 = pat.along[c.rep.j];
    const path = slicePath(shape, d0, d1, cum);
    const pcum = cumulative(path);
    const at = c.physical.map((id, n) => {
      if (n === 0) return 0;
      if (n === c.physical.length - 1) return pcum[pcum.length - 1];
      const k = pat.stops.indexOf(id);
      if (k >= c.rep.i && k <= c.rep.j) return pat.along[k] - d0;
      return projectOnPath(path, pos(id), pcum).dist;
    });
    for (let n = 1; n < at.length; n++) at[n] = Math.max(at[n], at[n - 1] + 1);
    return { path, at };
  }
  const path = c.physical.map(pos);
  return { path, at: cumulative(path) };
}

/** Option codes the CommuteLab way: options sharing a first station are 1A/1B, the next station is 2... */
export function optionCodes(options) {
  const origins = [];
  for (const o of options) if (!origins.includes(o.stops[0])) origins.push(o.stops[0]);
  const count = (origin) => options.filter((o) => o.stops[0] === origin).length;
  const seen = {};
  return options.map((o) => {
    const g = origins.indexOf(o.stops[0]) + 1;
    if (count(o.stops[0]) === 1) return String(g);
    seen[g] = (seen[g] ?? 0) + 1;
    return `${g}${String.fromCharCode(64 + seen[g])}`;
  });
}

const legName = (cs) => {
  const routes = [...new Set(cs.flatMap((c) => c.routes))].sort(routeSort);
  const kind = cs.every((c) => c.kind === 'express') ? ' express' : '';
  return `${routes.join('/')}${kind}`;
};

/**
 * setup = {
 *   name, icon, home: {label, pos}, destination: {label, pos},
 *   dock: Citi Bike id | 'own' (your own bike, from home),
 *   options: [{ stops: [station ids, in riding order], routes: [[route ids], ...one per leg] }],
 *   paths: { walk?: [[lat, lon]], bike?: { [station id]: [[lat, lon]] } },
 *   thresholds?: {...}
 * }
 * Returns { route, problems }. `problems` lists anything that prevented a complete route.
 */
export function buildRoute(idx, setup, { id } = {}) {
  const problems = [];
  const homePos = setup.home.pos;
  const own = setup.dock === 'own';
  const dockData = own ? null : idx.docks.find((d) => d.id === String(setup.dock)) ?? nearestDocks(idx, homePos, 1)[0];
  const dock = own
    ? { id: 'dock-own', name: 'Your bike', pos: homePos, radius: 40, own: true }
    : { id: `dock-${dockData.id}`, name: dockData.name, pos: dockData.pos, radius: 45, citibike: dockData.id };

  const nodes = new Map(); // node id -> { node, platforms:Set }
  const use = (node, platform) => {
    if (!nodes.has(node.id)) nodes.set(node.id, { node, platforms: new Set() });
    if (platform) nodes.get(node.id).platforms.add(platform);
  };
  const lines = [];
  const strategies = [];
  const codes = optionCodes(setup.options.map((o) => ({ ...o, stops: o.stops.map((s) => nodeOf(idx, s)?.id ?? s) })));
  const paths = { walk: setup.paths?.walk?.length >= 2 ? setup.paths.walk : [homePos, dock.pos] };

  setup.options.forEach((opt, oi) => {
    const stops = opt.stops.map((s) => nodeOf(idx, s));
    if (stops.length < 2 || stops.some((s) => !s)) {
      problems.push(`Option ${oi + 1}: tap at least the station you start from and the one you get off at.`);
      return;
    }
    const legs = [];
    const legConns = [];
    for (let k = 1; k < stops.length; k++) {
      const all = connections(idx, stops[k - 1].id, stops[k].id);
      if (!all.length) {
        problems.push(`Option ${oi + 1}: no train runs from ${stops[k - 1].name} to ${stops[k].name} without changing. Add the station where you change in between.`);
        return;
      }
      const want = (opt.routes?.[k - 1] ?? []).map((r) => baseRoute(r, idx.subway.routes));
      let chosen = want.length ? all.filter((c) => c.routes.some((r) => want.includes(r))) : [];
      if (!chosen.length) chosen = [all[0]];
      const lineIds = chosen.map((c) => {
        const geo = connectionGeometry(idx, c);
        const lineStations = c.physical.map((pid) => nodeOf(idx, pid).id);
        c.physical.forEach((pid) => use(nodeOf(idx, pid), pid));
        const len = pathLength(geo.path);
        const ride = Math.max(len / 25, c.sec - Math.max(0, c.nStops - 1) * DWELL_MEAN);
        const line = {
          id: `L${lines.length + 1}`,
          name: c.label,
          routes: c.routes,
          color: c.color,
          text: c.text,
          kind: c.kind,
          stations: lineStations,
          skips: c.skips.map((pid) => nodeOf(idx, pid).id),
          path: geo.path,
          at: geo.at,
          cruise: Math.max(6, Math.min(26, len / (0.85 * ride))),
          headwaySec: Math.round(c.headway),
          schedSec: Math.round(c.sec),
          crawlProb: 0.06,
          crawlSec: [60, 240],
        };
        lines.push(line);
        return line.id;
      });
      legs.push({ from: stops[k - 1].id, to: stops[k].id, lines: lineIds, service: chosen.every((c) => c.kind === 'express') ? 'express' : chosen.every((c) => c.kind === 'local') ? 'local' : undefined });
      legConns.push(chosen);
    }
    const origin = stops[0];
    const routesText = legConns.map(legName);
    const single = legConns.length === 1 && legConns[0].every((c) => c.kind !== 'express');
    const short = single ? `${routesText[0]}${legConns[0].some((c) => c.kind === 'local') ? ' local' : ''} all the way` : routesText.join(' → ');
    const firstPlatform = idx.subway.patterns[legConns[0][0].rep.p].stops[legConns[0][0].rep.i];
    const bikePath = setup.paths?.bike?.[firstPlatform] ?? setup.paths?.bike?.[origin.id];
    paths[`bike:${origin.id}`] ??= bikePath?.length >= 2 ? bikePath : [dock.pos, idx.stations.get(firstPlatform)?.pos ?? origin.pos];
    strategies.push({
      id: codes[oi],
      label: `Route ${codes[oi]}`,
      desc: `${origin.name} · ${short}`,
      short,
      color: STRATEGY_COLORS[oi % STRATEGY_COLORS.length],
      dock: dock.id,
      legs,
    });
  });

  // Geofences: one per station complex, sized to its platforms and kept clear of its neighbours.
  const stationList = [...nodes.values()].map(({ node, platforms }) => {
    const plats = [...platforms].map((p) => idx.stations.get(p)).filter(Boolean);
    const pos = plats.length
      ? [plats.reduce((a, s) => a + s.pos[0], 0) / plats.length, plats.reduce((a, s) => a + s.pos[1], 0) / plats.length]
      : node.pos;
    const spread = Math.max(0, ...plats.map((s) => haversine(pos, s.pos)));
    const nameFrom = plats.find((s) => s.routes.length) ?? plats[0];
    return {
      id: node.id,
      name: nameFrom?.name ?? node.name,
      pos,
      radius: Math.min(300, 110 + spread),
      complex: node.complex,
      platforms: [...platforms],
      structure: node.structure,
      routes: node.routes,
    };
  });
  for (const s of stationList) {
    const nearest = Math.min(Infinity, ...stationList.filter((o) => o !== s).map((o) => haversine(s.pos, o.pos)));
    if (isFinite(nearest)) s.radius = Math.round(Math.max(60, Math.min(s.radius, nearest * 0.45)));
  }
  const interior = new Set(strategies.flatMap((s) => strategyPath(s).slice(1, -1)));
  const finals = [...new Set(strategies.map((s) => s.legs[s.legs.length - 1].to))];
  const skipped = new Set(lines.flatMap((l) => l.skips));
  for (const s of stationList) {
    if (interior.has(s.id)) s.transfer = true;
    if (finals.includes(s.id)) s.destination = true;
    if (skipped.has(s.id)) s.localOnly = true;
  }

  const thresholds = { ...DEFAULT_THRESHOLDS, ...(setup.thresholds ?? {}) };
  const route = {
    id: id ?? `r-${Math.random().toString(36).slice(2, 8)}`,
    name: `Home → ${setup.name || setup.destination?.label || 'X'}`,
    title: setup.name || 'X',
    icon: setup.icon || 'office',
    builtIn: false,
    home: { name: setup.home.label || 'Home', pos: homePos, radius: 60 },
    place: setup.destination ? { name: setup.destination.label, pos: setup.destination.pos } : null,
    docks: [dock],
    destination: finals[0],
    destinations: finals,
    stations: stationList,
    paths,
    lines,
    strategies,
    model: { ...DEFAULT_MODEL },
    thresholds,
  };
  route.insights = deriveInsights(route);
  route.bearing = mapBearing(route);
  if (!strategies.length && !problems.length) problems.push('Add at least one way to get there.');
  return { route, problems };
}

/**
 * Map rotation: Manhattan's street grid runs ~29° east of north, so trips that run up or down the
 * island get 29° (avenues vertical, uptown up). Anything else stays north-up; a southbound trip is
 * never flipped upside down.
 */
export function mapBearing(route) {
  const a = route.home.pos;
  const b = route.place?.pos ?? route.stations.find((s) => s.id === route.destination)?.pos;
  if (!b || haversine(a, b) < 300) return 0;
  const br = bearing(a, b);
  const d = (x) => Math.abs(((br - x + 540) % 360) - 180);
  return d(29) <= 35 || d(209) <= 35 ? 29 : 0;
}

/** Which CommuteLab "quirk" questions this route can answer (express->local gamble, red lights, crawls). */
export function deriveInsights(route) {
  const out = {};
  const path = (s) => strategyPath(s);
  const lineOf = (leg) => route.lines.find((l) => l.id === leg.lines[0]);
  for (const A of route.strategies) {
    const pa = path(A);
    if (pa.length < 3 || out.gamble) continue;
    const [T, P, D] = pa.slice(-3);
    const ride = A.legs[A.legs.length - 2];
    if (!ride.lines.some((id) => route.lines.find((l) => l.id === id)?.skips?.length)) continue;
    for (const B of route.strategies) {
      if (B === A || path(B)[path(B).length - 1] !== D || path(B).includes(P)) continue;
      const last = lineOf(B.legs[B.legs.length - 1]);
      if (last?.stations.includes(T) && last.stations.includes(P)) {
        out.gamble = { strategy: A.id, alt: B.id, from: T, at: P };
        break;
      }
    }
  }
  const bikeLen = (s) => pathLength(route.paths[`bike:${s.legs[0].from}`] ?? [route.docks[0].pos, route.docks[0].pos]);
  if (route.strategies.length >= 2) {
    const sorted = route.strategies.slice().sort((a, b) => bikeLen(b) - bikeLen(a));
    if (bikeLen(sorted[0]) - bikeLen(sorted[sorted.length - 1]) > 250) {
      out.lights = { strategy: sorted[0].id, compare: sorted.slice(1).map((s) => s.id) };
    }
    const byFirst = new Map();
    for (const s of route.strategies) {
      const key = lineOf(s.legs[0])?.routes.join('/') ?? '';
      if (!byFirst.has(key)) byFirst.set(key, []);
      byFirst.get(key).push(s);
    }
    if (byFirst.size >= 2) {
      const [, group] = [...byFirst.entries()].sort((a, b) => b[1].length - a[1].length)[0];
      const rival = route.strategies.find((s) => !group.includes(s));
      out.crawl = { line: group[0].legs[0].lines[0], lineName: lineOf(group[0].legs[0])?.name, strategies: group.map((s) => s.id), rival: rival.id };
    }
  }
  return out;
}

/** Track geometry of one strategy leg (for maps). */
export function legPath(route, leg) {
  const line = route.lines.find((l) => l.id === leg.lines[0]);
  if (!line) return [];
  const i = line.stations.indexOf(leg.from);
  const j = line.stations.indexOf(leg.to);
  if (i < 0 || j < 0) return [];
  return slicePath(line.path, line.at[i], line.at[j]);
}
