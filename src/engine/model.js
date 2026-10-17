// Stochastic commute "world model".
// A plan is the ground-truth sequence of movement segments for one commute. The same plan
// feeds two consumers: planToRecord() (pre-loaded history) and the GPS simulator (live testing),
// so simulated telemetry and historical numbers come from one consistent model.
import { createRng } from './rng.js';
import { haversine, pathLength, pointAlong, slicePath, splitPath } from './geo.js';
import { stationById, strategyPath, DEFAULT_MODEL, DEFAULT_THRESHOLDS } from './routes.js';

const posOf = (route, id) => stationById(route, id)?.pos;

/**
 * Stations a line serves between `from` and `to`. A line may list stations it runs through
 * without stopping (`skips`, e.g. the 4/5 express through 51 St), or skip `localOnly` stations
 * on an express service. With `path` + `at` (distance along `path` of every station) hops follow
 * the real track geometry instead of straight lines between stations.
 */
export function lineSegment(route, line, from, to, service) {
  const seq = line.stations;
  const i = seq.indexOf(from);
  const j = seq.indexOf(to);
  if (i < 0 || j < 0) return null;
  const idx = [];
  if (i <= j) for (let k = i; k <= j; k++) idx.push(k);
  else for (let k = i; k >= j; k--) idx.push(k);
  const ordered = idx.map((k) => seq[k]);
  const skipLocal = line.services?.[service]?.skipLocal;
  const skips = new Set(line.skips ?? []);
  const stopAt = ordered
    .map((id, k) => (k === 0 || k === ordered.length - 1 || !(skips.has(id) || (skipLocal && stationById(route, id)?.localOnly)) ? k : -1))
    .filter((k) => k >= 0);
  const stops = stopAt.map((k) => ordered[k]);
  const hops = [];
  for (let n = 1; n < stopAt.length; n++) {
    const a = stopAt[n - 1];
    const b = stopAt[n];
    const path = line.path && line.at
      ? slicePath(line.path, line.at[idx[a]], line.at[idx[b]])
      : ordered.slice(a, b + 1).map((id) => posOf(route, id));
    hops.push({ from: ordered[a], to: ordered[b], path });
  }
  return { stops, hops, ordered };
}

function headwayFor(route, line, service) {
  return line?.services?.[service]?.headwaySec ?? line?.headwaySec ?? route.model?.defaultHeadwaySec ?? DEFAULT_MODEL.defaultHeadwaySec;
}

/** Sample how long you stand on the platform, and which of the leg's lines shows up first. */
function sampleWait(route, rng, leg, stationId) {
  const lines = (leg.lines || []).map((id) => route.lines.find((l) => l.id === id)).filter(Boolean);
  let best = { sec: rng.uniform(0, headwayFor(route, null, leg.service)), lineId: null };
  if (lines.length) {
    best = null;
    for (const line of lines) {
      const sec = rng.uniform(0, headwayFor(route, line, leg.service));
      if (!best || sec < best.sec) best = { sec, lineId: line.id };
    }
  }
  const ov = route.model?.waitOverrides?.[stationId];
  if (ov) {
    const quick = rng.chance(ov.pQuick);
    best.sec = rng.range(quick ? ov.quick : ov.slow);
  }
  return best;
}

/**
 * Sample one commute plan.
 * opts: { startTime (ms), errand: bool|null, crawl: bool|null (first train leg), lights: 'green'|'red'|null }
 */
export function samplePlan(route, strategyId, rng, opts = {}) {
  const m = { ...DEFAULT_MODEL, ...route.model };
  const strat = route.strategies.find((s) => s.id === strategyId) ?? route.strategies[0];
  const dock = route.docks.find((d) => d.id === strat.dock) ?? route.docks[0];
  const origin = strat.legs[0].from;
  const segs = [];
  const move = (phase, path, dur, rampIn = 0, rampOut = 0, tag) => segs.push({ phase, type: 'move', path, dur, rampIn, rampOut, tag });
  const dwell = (phase, at, dur, tag, station) => segs.push({ phase, type: 'dwell', at, dur, tag, station });

  // Pre-benchmark buffer: walk to the dock (maybe with an errand), then undock.
  const buffer = { kind: 'buffer', key: 'buffer' };
  const walkPath = route.paths?.walk ?? [route.home.pos, dock.pos];
  const walkLen = pathLength(walkPath);
  const vWalk = rng.range(m.walkSpeed);
  const errand = opts.errand ?? rng.chance(m.errandProb);
  if (errand) {
    const [h, t] = splitPath(walkPath, walkLen * rng.uniform(0.2, 0.8));
    move(buffer, h, pathLength(h) / vWalk);
    dwell(buffer, t[0], rng.range(m.errandSec), 'errand');
    move(buffer, t, pathLength(t) / vWalk);
  } else {
    move(buffer, walkPath, walkLen / vWalk);
  }
  dwell(buffer, dock.pos, rng.range(m.undockSec), 'undock');

  // Bike leg, broken up by red lights.
  const bike = { kind: 'bike', key: 'bike', from: dock.id, to: origin };
  const bikePath = route.paths?.[`bike:${origin}`] ?? [dock.pos, posOf(route, origin)];
  const L = pathLength(bikePath);
  const lam = (L / 1000) * m.redLightsPerKm;
  const nLights = opts.lights === 'green' ? rng.int(0, 1) : opts.lights === 'red' ? rng.poisson(lam) + 3 : rng.poisson(lam);
  const marks = Array.from({ length: nLights }, () => rng.uniform(0.08, 0.92) * L).sort((a, b) => a - b);
  const vBike = rng.range(m.bikeSpeed);
  let rest = bikePath;
  let done = 0;
  for (const mk of marks) {
    const [piece, tail] = splitPath(rest, mk - done);
    const d = pathLength(piece) / vBike;
    move(bike, piece, d, Math.min(0.3, 6 / Math.max(d, 1)), Math.min(0.3, 6 / Math.max(d, 1)));
    dwell(bike, tail[0], rng.range(m.redLightSec), 'redlight');
    rest = tail;
    done = mk;
  }
  {
    const d = pathLength(rest) / vBike;
    move(bike, rest, d, Math.min(0.3, 6 / Math.max(d, 1)), Math.min(0.3, 8 / Math.max(d, 1)));
  }

  // Platform waits and train legs. Positions stay continuous: you walk from where the bike ride
  // (or the previous train) ended to where the next train boards, then stand there.
  const linesUsed = [];
  let crawled = false;
  let here = rest[rest.length - 1];
  strat.legs.forEach((leg, i) => {
    const wait = { kind: 'wait', key: `wait:${i}`, station: leg.from };
    const w = sampleWait(route, rng, leg, leg.from);
    const pre = i === 0 ? rng.range(m.accessSec) : rng.range(m.transferWalkSec);
    const line = route.lines.find((l) => l.id === w.lineId);
    const segInfo = line ? lineSegment(route, line, leg.from, leg.to, leg.service) : null;
    const hops = segInfo?.hops ?? [{ from: leg.from, to: leg.to, path: [posOf(route, leg.from), posOf(route, leg.to)] }];
    const board = hops[0].path[0];
    const gap = haversine(here, board);
    const walkIn = gap > 3 ? gap / 1.25 : 0;
    if (walkIn) move(wait, [here, board], walkIn);
    dwell(wait, board, Math.max(5, pre - walkIn) + w.sec, i === 0 ? 'platform' : 'transfer', leg.from);

    linesUsed.push(w.lineId);
    const train = { kind: 'train', key: `train:${i}`, from: leg.from, to: leg.to, line: w.lineId, service: leg.service ?? null };
    const cruise = line?.services?.[leg.service]?.cruise ?? line?.cruise ?? m.defaultCruise;
    const doCrawl = i === 0 && opts.crawl != null ? opts.crawl : rng.chance(line?.crawlProb ?? 0.05);
    let crawlHop = -1;
    if (doCrawl) {
      let best = -1;
      hops.forEach((h, k) => {
        const len = pathLength(h.path);
        if (len > best) { best = len; crawlHop = k; }
      });
    }
    hops.forEach((hop, k) => {
      if (k > 0) dwell(train, hop.path[0], rng.range(m.dwellSec), 'stop', hop.from);
      const len = pathLength(hop.path);
      if (k === crawlHop) {
        if (i === 0) crawled = true;
        const cs = m.crawlSpeed;
        const cd = Math.min(rng.range(line?.crawlSec ?? [60, 180]) * cs, len * 0.5);
        const [p1, r1] = splitPath(hop.path, (len - cd) / 2);
        const [pc, p2] = splitPath(r1, cd);
        const d1 = pathLength(p1) / (cruise * 0.9);
        const d2 = pathLength(p2) / (cruise * 0.9);
        move(train, p1, d1, Math.min(0.4, 20 / d1), 0);
        move(train, pc, cd / cs, 0, 0, 'crawl');
        move(train, p2, d2, 0, Math.min(0.4, 20 / d2));
      } else {
        const d = len / (cruise * 0.85);
        const r = Math.min(0.3, 20 / d);
        move(train, hop.path, d, r, r);
      }
    });
    const lastHop = hops[hops.length - 1].path;
    here = lastHop[lastHop.length - 1];
  });
  // After arriving: stand on the platform for a bit, or (opts.walkOut) walk out toward the destination.
  const after = { kind: 'after', key: 'after' };
  const place = route.place?.pos;
  if (opts.walkOut && place && haversine(here, place) > 40) {
    const d = Math.min(Math.max(haversine(here, place), 250), 400);
    const target = pointAlong([here, place], d);
    dwell(after, here, 20, 'alight');
    move(after, [here, target], d / 1.3);
    dwell(after, target, 30, 'arrived');
  } else dwell(after, here, 90, 'arrived');

  return {
    routeId: route.id,
    strategyId: strat.id,
    startTime: opts.startTime ?? Date.now(),
    segments: segs,
    meta: { errand, nLights, linesUsed, crawled },
  };
}

/** Ground-truth phases from a plan. */
export function planPhases(plan) {
  const out = [];
  const byKey = new Map();
  let t = plan.startTime;
  for (const seg of plan.segments) {
    const start = t;
    t += seg.dur * 1000;
    if (seg.phase.kind === 'after') continue;
    let p = byKey.get(seg.phase.key);
    if (!p) {
      p = { ...seg.phase, start, end: t, redLights: 0, redLightSec: 0, crawlSec: 0, stops: [], stopLog: [], distance: 0 };
      byKey.set(seg.phase.key, p);
      out.push(p);
    }
    p.end = t;
    if (seg.tag === 'redlight') { p.redLights++; p.redLightSec += seg.dur; }
    if (seg.tag === 'crawl') p.crawlSec += seg.dur;
    if (seg.tag === 'stop') { p.stops.push(seg.station); p.stopLog.push({ id: seg.station, arr: start, dep: t }); }
    if (seg.type === 'move') p.distance += pathLength(seg.path);
  }
  return out;
}

export function planToRecord(route, plan, source = 'history', id) {
  return buildRecord({ route, phases: planPhases(plan), source, id, extra: { lines: plan.meta.linesUsed.filter(Boolean), strategyId: plan.strategyId } });
}

const arrEq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Turn a list of phases (from the plan or from the live engine) into a run record with metrics. */
export function buildRecord({ route, phases, source, id, extra = {} }) {
  const th = { ...DEFAULT_THRESHOLDS, ...route.thresholds };
  const legs = phases.filter((p) => p.kind !== 'buffer');
  const trains = phases.filter((p) => p.kind === 'train');
  const waits = phases.filter((p) => p.kind === 'wait');
  const bikeP = phases.find((p) => p.kind === 'bike');
  const t0 = legs[0]?.start ?? phases[0]?.start;
  const last = trains[trains.length - 1];
  const arrival = last?.end ?? phases[phases.length - 1]?.end;
  const sec = (p) => (p.end - p.start) / 1000;
  const sum = (kind) => phases.filter((p) => p.kind === kind).reduce((a, p) => a + sec(p), 0);
  const path = last ? [...waits.map((w) => w.station), last.to] : [];
  const strategy = route.strategies.find((s) => arrEq(strategyPath(s), path));
  const first = trains[0];
  const bikeSec = bikeP ? sec(bikeP) : 0;
  const metrics = {
    total: (arrival - t0) / 1000,
    buffer: sum('buffer'),
    bike: sum('bike'),
    wait: sum('wait'),
    train: sum('train'),
    originWait: waits[0] ? sec(waits[0]) : 0,
    transferWait: waits.slice(1).reduce((a, p) => a + sec(p), 0),
    redLights: bikeP?.redLights ?? 0,
    redLightSec: bikeP?.redLightSec ?? 0,
    bikeDistM: bikeP?.distance ?? 0,
    bikeAvgKmh: bikeSec > 0 ? ((bikeP?.distance ?? 0) / bikeSec) * 3.6 : 0,
    firstTrainSec: first ? sec(first) : 0,
    firstTrainCrawlSec: first?.crawlSec ?? 0,
    crawl: (first?.crawlSec ?? 0) >= th.crawlFlagSec,
    crawlSecTotal: trains.reduce((a, p) => a + (p.crawlSec || 0), 0),
  };
  return {
    id: id ?? `${source}-${Math.round(t0)}-${Math.random().toString(36).slice(2, 6)}`,
    routeId: route.id,
    source,
    startedAt: phases[0]?.start ?? t0,
    t0,
    arrival,
    strategyId: strategy?.id ?? null,
    path,
    phases: phases.map((p) => ({ ...p, stops: [...(p.stops || [])] })),
    metrics,
    ...extra,
  };
}

/** Deterministic pre-loaded history: weekday commutes going back from `endDate`. */
export function generateHistory(route, { n = 120, seed = 7, endDate = new Date(), startHour = 7, startMin = [18, 52] } = {}) {
  const rng = createRng(seed);
  const out = [];
  const day = new Date(endDate);
  day.setHours(0, 0, 0, 0);
  let i = 0;
  while (out.length < n) {
    day.setDate(day.getDate() - 1);
    const dow = day.getDay();
    if (dow === 0 || dow === 6) continue;
    if (rng.chance(0.08)) continue; // the odd day off
    const strat = route.strategies[i % route.strategies.length];
    i++;
    const start = new Date(day);
    start.setHours(startHour, rng.int(startMin[0], startMin[1]), rng.int(0, 59), 0);
    const plan = samplePlan(route, strat.id, rng, { startTime: start.getTime() });
    out.push(planToRecord(route, plan, 'history', `h-${route.id}-${out.length}`));
  }
  return out;
}
