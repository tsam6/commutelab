// Hands-free commute state machine.
// Feed it GPS fixes ({t, lat, lon, accuracy?, speed?}); it detects
// buffer -> bike -> platform wait -> train -> (transfer wait -> train)* -> arrived
// using geofences, velocity and dwell times, then emits a run record.
//
// On a train it also checks every option still possible against what the train actually did:
// an option's leg must stop where that line stops and may only run through stations that line
// skips. When no option explains a ride, the engine looks back for the stop where you must have
// changed trains (a quick cross-platform transfer shorter than any dwell rule can catch).
import { haversine, bearing, bearingDiff } from './geo.js';
import { DEFAULT_THRESHOLDS, transferStationIds, originStationIds, destinationIds, strategyPath, stationById } from './routes.js';
import { buildRecord, lineSegment } from './model.js';

export const STATE_LABEL = {
  idle: 'Waiting for GPS',
  buffer: 'Pre-benchmark buffer',
  bike: 'Biking',
  wait: 'Platform wait',
  train: 'On the train',
  arrived: 'Arrived',
};

/**
 * For every strategy leg: the stations it physically runs through (`seq`), the ones it stops at,
 * and `rel`: every station any strategy sharing the same path so far runs through on this leg.
 * Only stations in `rel` count as evidence for or against a leg, so a fence clipped by a nearby
 * station on some other option's line cannot rule the right option out.
 */
function legInfo(route) {
  const out = new Map();
  for (const s of route.strategies) {
    s.legs.forEach((leg, k) => {
      const seq = new Set([leg.from, leg.to]);
      const stops = new Set([leg.from, leg.to]);
      let known = false;
      for (const id of leg.lines || []) {
        const line = route.lines?.find((l) => l.id === id);
        const seg = line && lineSegment(route, line, leg.from, leg.to, leg.service);
        if (!seg) continue;
        known = true;
        seg.ordered.forEach((x) => seq.add(x));
        seg.stops.forEach((x) => stops.add(x));
      }
      if (known) out.set(`${s.id}:${k}`, { seq, stops, rel: new Set(seq) });
    });
  }
  for (const s of route.strategies) {
    const path = strategyPath(s);
    s.legs.forEach((_, k) => {
      const info = out.get(`${s.id}:${k}`);
      if (!info) return;
      for (const o of route.strategies) {
        const op = strategyPath(o);
        const other = out.get(`${o.id}:${k}`);
        if (other && op.length > k && path.slice(0, k + 1).every((id, i) => op[i] === id)) other.seq.forEach((x) => info.rel.add(x));
      }
    });
  }
  return out;
}

export function createEngine(route, { source = 'live', onEvent } = {}) {
  const th = { ...DEFAULT_THRESHOLDS, ...route.thresholds };
  const transferIds = transferStationIds(route);
  const originIds = originStationIds(route);
  const destIds = destinationIds(route);
  const legs = legInfo(route);
  const localOnly = (id) => stationById(route, id)?.localOnly;

  let state = 'idle';
  const phases = [];
  let cur = null;
  const events = [];
  const trail = []; // {t, pos, v}
  const recent = []; // samples for speed estimation
  let lastSample = null;
  let speed = 0;
  let record = null;

  // per-state scratch
  let lastStillT = null;
  let highSince = null;
  let inDock = false;
  let dockExitT = null;
  let bikeStopStart = null;
  let stationCand = null;
  let trainSince = null;
  let stopStart = null;
  let stopStation = null;
  let slowSince = null;
  let awaySince = null;
  let rideOffSince = null;
  const inFence = new Map();
  const fenceEntry = new Map();

  const log = (t, kind, text) => {
    const e = { t, kind, text };
    events.push(e);
    onEvent?.(e);
  };

  const blank = (kind, start, extra = {}) => ({
    kind, key: `${kind}:${phases.length}`, start, end: start,
    redLights: 0, redLightSec: 0, crawlSec: 0, crawlEpisodes: 0, crawlLog: [],
    stops: [], passes: [], passLog: [], distance: 0, ...extra,
  });
  const open = (kind, start, extra = {}) => {
    cur = blank(kind, start, extra);
    phases.push(cur);
  };
  const close = (end, extra = {}) => {
    if (!cur) return;
    Object.assign(cur, extra);
    cur.end = end;
    cur.distance = trailDistance(cur.start, cur.end);
    cur = null;
  };

  function trailDistance(a, b) {
    let d = 0;
    for (let i = 1; i < trail.length; i++) {
      if (trail[i].t <= a || trail[i - 1].t >= b) continue;
      d += haversine(trail[i - 1].pos, trail[i].pos);
    }
    return d;
  }

  const fenceOf = (pos, list) => {
    let best = null;
    let bestD = Infinity;
    for (const s of list) {
      const d = haversine(pos, s.pos);
      if (d <= s.radius && d < bestD) { best = s; bestD = d; }
    }
    return best;
  };

  function estimateSpeed(s) {
    recent.push(s);
    while (recent.length > 2 && s.t - recent[0].t > 30000) recent.shift();
    if (s.speed != null && s.speed >= 0) {
      const g = recent.slice(-3).map((r) => r.speed).filter((v) => v != null && v >= 0).sort((a, b) => a - b);
      return g[Math.floor(g.length / 2)] ?? s.speed;
    }
    // no device speed: displacement over a short window (robust to per-fix jitter)
    let ref = null;
    for (let i = recent.length - 2; i >= 0; i--) {
      ref = recent[i];
      if (s.t - recent[i].t >= th.speedWindowSec * 1000) break;
    }
    if (!ref || ref === s) return 0;
    const dt = (s.t - ref.t) / 1000;
    return dt > 0 ? haversine(ref.pos, s.pos) / dt : 0;
  }

  // ------------------------------------------------------------------ which options still fit
  const waitStations = () => phases.filter((p) => p.kind === 'wait').map((p) => p.station);
  const prefixOk = (s, waits) => {
    const path = strategyPath(s);
    return waits.every((w, i) => path[i] === w);
  };

  /** Does leg k of strategy s fit what the train did between t0 and t1? */
  function legFits(s, k, ph, t0, t1) {
    const info = legs.get(`${s.id}:${k}`);
    if (!info) return true;
    for (const p of ph.passLog) {
      if (p.t >= t0 && p.t < t1 && info.rel.has(p.id) && (!info.seq.has(p.id) || info.stops.has(p.id))) return false;
    }
    for (const x of ph.stops) if (x.arr >= t0 && x.arr < t1 && info.rel.has(x.id) && !info.stops.has(x.id)) return false;
    return true;
  }

  /** Every train ridden so far (leg i = train phase i) fits strategy s. */
  function fitsSoFar(s) {
    const trains = phases.filter((p) => p.kind === 'train');
    return trains.every((ph, i) => s.legs.length > i && legFits(s, i, ph, ph.start, Infinity));
  }

  /** Strategies consistent with the waits so far and with how every train behaved (stops, pass-throughs). */
  function live() {
    const waits = waitStations();
    const base = route.strategies.filter((s) => prefixOk(s, waits));
    const fit = base.filter(fitsSoFar);
    return fit.length ? fit : base;
  }

  /** For each strategy still possible, the station it gets off at on the current train. */
  function nextNodes() {
    const n = waitStations().length;
    return live().map((s) => strategyPath(s)).filter((p) => p.length > n).map((p) => p[n]);
  }

  /** At a stop at `id`: does some option end here, change trains here, or ride on? */
  function exitOptions(id) {
    const n = waitStations().length;
    const cands = live();
    if (!cands.length) return { ends: destIds.has(id), transfers: false, through: false, allEnd: destIds.has(id) };
    let ends = false;
    let transfers = false;
    let through = false;
    for (const s of cands) {
      const path = strategyPath(s);
      if (path.length <= n) continue;
      if (path[n] !== id) through = true;
      else if (path.length === n + 1) ends = true;
      else transfers = true;
    }
    return { ends, transfers, through, allEnd: ends && !transfers && !through };
  }

  /** Some option still possible ends at the station you are waiting at. */
  function endsAtWait() {
    const waits = waitStations();
    return route.strategies.some((s) => strategyPath(s).length === waits.length && prefixOk(s, waits));
  }

  /**
   * Did you get off at this transfer station? Decided by, in order:
   *  1. every strategy still possible changes trains here (e.g. Train 1 → Transfer Station);
   *  2. this train ran express through local-only stations, and a strategy gets off here
   *     (express → penultimate: the express does not serve your final local stop);
   *  3. otherwise, standing still longer than a normal station dwell.
   */
  function shouldAlight(stationId, dwell) {
    const nexts = nextNodes();
    if (nexts.length && nexts.every((n) => n === stationId)) return true;
    const ranExpress = cur.passes.some(localOnly) && !cur.stops.some((x) => localOnly(x.id));
    if (ranExpress && nexts.includes(stationId)) return true;
    return dwell >= th.alightDwellSec;
  }

  /** No option explains this ride: find the earlier stop where you must have changed trains, and split there. */
  function reviewTrain() {
    const waits = waitStations();
    const k = waits.length - 1;
    const base = route.strategies.filter((s) => prefixOk(s, waits) && s.legs.length > k);
    if (!base.length || base.some((s) => legFits(s, k, cur, cur.start, Infinity))) return;
    for (const stop of cur.stops) {
      for (const s of base) {
        const path = strategyPath(s);
        if (path[k + 1] !== stop.id || s.legs.length <= k + 1) continue;
        if (legFits(s, k, cur, cur.start, stop.arr) && legFits(s, k + 1, cur, stop.dep, Infinity)) {
          splitAt(stop);
          return;
        }
      }
    }
  }

  function serviceOf(ph) {
    if (ph.stops.some((x) => localOnly(x.id))) return 'local';
    if (ph.passes.some(localOnly)) return 'express';
    return null;
  }

  function settleCrawl(ph) {
    ph.crawlSec = ph.crawlLog.reduce((a, c) => a + c.dur, 0);
    ph.crawlEpisodes = ph.crawlLog.length;
  }

  function splitAt(stop) {
    const first = cur;
    const second = blank('train', stop.dep, { from: stop.id });
    second.passLog = first.passLog.filter((p) => p.t >= stop.dep);
    second.stops = first.stops.filter((x) => x.arr > stop.arr);
    second.crawlLog = first.crawlLog.filter((c) => c.start >= stop.dep);
    first.passLog = first.passLog.filter((p) => p.t < stop.arr);
    first.stops = first.stops.filter((x) => x.arr < stop.arr);
    first.crawlLog = first.crawlLog.filter((c) => c.start < stop.arr);
    for (const ph of [first, second]) {
      ph.passes = ph.passLog.map((p) => p.id);
      settleCrawl(ph);
    }
    first.end = stop.arr;
    first.to = stop.id;
    first.service = serviceOf(first);
    first.distance = trailDistance(first.start, first.end);
    const wait = blank('wait', stop.arr, { station: stop.id });
    wait.end = stop.dep;
    wait.distance = trailDistance(stop.arr, stop.dep);
    phases.push(wait);
    second.key = `train:${phases.length}`;
    phases.push(second);
    cur = second;
    log(stop.arr, 'wait', `Changed trains at ${stationById(route, stop.id)?.name ?? stop.id} (quick transfer)`);
  }

  function flushCrawl(t) {
    if (slowSince != null && cur) {
      const dur = (t - slowSince) / 1000;
      if (dur >= th.crawlMinSec) {
        cur.crawlLog.push({ start: slowSince, dur });
        settleCrawl(cur);
        log(slowSince, 'crawl', `Slow signal crawl (${Math.round(dur)} s under ${Math.round(th.crawlSpeed * 3.6)} km/h)`);
      }
    }
    slowSince = null;
  }

  function finishTrain(at, to) {
    flushCrawl(at);
    cur.stops = cur.stops.filter((x) => x.arr < at);
    cur.passLog = cur.passLog.filter((p) => p.t < at);
    cur.passes = cur.passLog.map((p) => p.id);
    cur.crawlLog = cur.crawlLog.filter((c) => c.start < at);
    settleCrawl(cur);
    close(at, { to, service: serviceOf(cur) });
    stopStart = null;
    stopStation = null;
  }

  function cleanPhases() {
    return phases.map(({ passLog, crawlLog, ...p }) => ({
      ...p,
      stops: p.stops.map((x) => (typeof x === 'string' ? x : x.id)),
      stopLog: p.stops.filter((x) => typeof x !== 'string').map((x) => ({ id: x.id, arr: x.arr, dep: x.dep })),
    }));
  }

  /** The "platform wait" was a stop beside the station: put it back into the bike leg as a red light. */
  function resumeBike(t) {
    const wait = phases.pop();
    const bikeP = phases[phases.length - 1];
    const stopSec = Math.max(0, (rideOffSince - wait.start) / 1000);
    bikeP.redLights++;
    bikeP.redLightSec += stopSec;
    delete bikeP.to;
    cur = bikeP;
    state = 'bike';
    stationCand = null;
    bikeStopStart = null;
    rideOffSince = null;
    log(wait.start, 'stop', `Rode on from ${stationById(route, wait.station)?.name ?? wait.station} — a stop on the way, not the platform`);
  }

  function arrive(at, id, t) {
    if (state === 'train') finishTrain(at, id);
    else if (state === 'wait' && cur) {
      phases.pop(); // that "wait" was you walking out of the station
      cur = null;
    }
    state = 'arrived';
    log(at, 'arrived', `Arrived ${stationById(route, id)?.name ?? id} — benchmark stopped`);
    const path = [...waitStations(), id].join('>');
    const same = route.strategies.filter((s) => strategyPath(s).join('>') === path);
    const pick = same.find(fitsSoFar) ?? same[0];
    record = buildRecord({ route, phases: cleanPhases(), source, extra: pick ? { strategyId: pick.id } : {} });
    const strat = route.strategies.find((x) => x.id === record.strategyId);
    log(t, 'summary', `${strat ? strat.label : 'Unmatched route ' + record.path.join(' → ')}: ${fmt(record.metrics.total)}`);
  }

  // ------------------------------------------------------------------ the state machine
  function push(raw) {
    if (state === 'arrived') return snapshot();
    if (raw.accuracy != null && raw.accuracy > th.maxAccuracyM) return snapshot();
    const s = { t: raw.t, pos: [raw.lat, raw.lon], speed: raw.speed ?? null };
    if (lastSample && s.t <= lastSample.t) return snapshot();
    lastSample = s;
    const v = estimateSpeed(s);
    speed = v;
    trail.push({ t: s.t, pos: s.pos, v });
    const t = s.t;

    if (state === 'idle') {
      state = 'buffer';
      open('buffer', t);
      log(t, 'buffer', 'Tracking started — pre-benchmark buffer (not counted)');
    }

    if (state === 'buffer') {
      const dock = fenceOf(s.pos, route.docks);
      if (inDock && !dock) dockExitT = t;
      inDock = !!dock;
      if (v < th.stopSpeed) lastStillT = t;
      if (v >= th.bikeStartSpeed) highSince ??= t;
      else if (v < 2.0) highSince = null;
      if (highSince != null && t - highSince >= th.bikeStartSustainSec * 1000) {
        let t0 = highSince;
        if (lastStillT != null && highSince - lastStillT <= 120000) t0 = lastStillT;
        else if (dockExitT != null && highSince - dockExitT <= 60000) t0 = dockExitT;
        close(t0);
        open('bike', t0);
        state = 'bike';
        bikeStopStart = null;
        stationCand = null;
        log(t0, 'bike', 'Benchmark started — T = 00:00 (riding)');
      }
    } else if (state === 'bike') {
      if (v < th.stopSpeed) bikeStopStart ??= t;
      else if (bikeStopStart != null) {
        const dur = (t - bikeStopStart) / 1000;
        if (dur >= th.redLightMinSec) {
          cur.redLights++;
          cur.redLightSec += dur;
          log(bikeStopStart, 'stop', `Red light / stop #${cur.redLights} (${Math.round(dur)} s)`);
        }
        bikeStopStart = null;
      }
      const candidates = route.stations.filter((st) => originIds.has(st.id));
      const st = fenceOf(s.pos, candidates.length ? candidates : route.stations);
      if (st) {
        if (!stationCand || stationCand.id !== st.id) stationCand = { id: st.id, entryT: t };
        if (t - stationCand.entryT >= th.stationConfirmSec * 1000 && v < th.walkMaxSpeed) {
          const entry = stationCand.entryT;
          bikeStopStart = null;
          close(entry, { to: st.id });
          open('wait', entry, { station: st.id });
          state = 'wait';
          lastStillT = t;
          trainSince = null;
          const opts = route.strategies.filter((x) => x.legs[0].from === st.id).map((x) => x.label);
          log(entry, 'wait', `Arrived ${st.name} — platform wait${opts.length ? ` (${opts.join(' / ')})` : ''}`);
        }
      } else stationCand = null;
    } else if (state === 'wait') {
      if (v < th.stopSpeed) lastStillT = t;
      if (v >= th.trainSpeed) trainSince ??= t;
      else if (v < th.trainSpeed * 0.6) trainSince = null;
      if (trainSince != null && t - trainSince >= th.trainSustainSec * 1000) {
        const dep = lastStillT != null && trainSince - lastStillT < 60000 ? lastStillT : trainSince;
        const from = cur.station;
        close(dep);
        open('train', dep, { from });
        state = 'train';
        stopStart = null;
        stopStation = null;
        slowSince = null;
        awaySince = null;
        inFence.clear();
        const fromSt = stationById(route, from);
        if (fromSt) inFence.set(from, true);
        log(dep, 'train', `Train departed ${fromSt?.name ?? from}`);
      } else if (!phases.some((p) => p.kind === 'train')) {
        // riding off again at bike speed: that stop was a red light by the station, not the platform
        const st = stationById(route, cur.station);
        if (st && v >= th.bikeStartSpeed && v < th.trainSpeed && haversine(s.pos, st.pos) > st.radius + 20) {
          rideOffSince ??= t;
          if (t - rideOffSince >= 5000) resumeBike(t);
        } else rideOffSince = null;
      } else if (endsAtWait()) {
        // walked out of a station where one of your options ends: you arrived when the train did
        const st = stationById(route, cur.station);
        if (st && v < th.walkMaxSpeed && haversine(s.pos, st.pos) > st.radius + 25) {
          awaySince ??= t;
          if (t - awaySince >= 8000) arrive(cur.start, cur.station, t);
        } else awaySince = null;
      }
    } else if (state === 'train') {
      const here = fenceOf(s.pos, route.stations);
      let changed = false;
      // fence entries/exits, to know which stations the train ran through without stopping.
      // Hysteresis (exit only 20 m past the edge) and a minimum time inside keep GPS noise at a
      // fence edge from looking like a ride-through.
      for (const st of route.stations) {
        const d = haversine(s.pos, st.pos);
        const was = inFence.get(st.id) ?? false;
        const inside = d <= st.radius + (was ? 20 : 0);
        if (!was && inside) fenceEntry.set(st.id, t);
        const stoppedHere = cur.stops.some((x) => x.id === st.id) || (stopStart != null && stopStation === st.id);
        if (was && !inside && st.id !== cur.from && !stoppedHere && t - (fenceEntry.get(st.id) ?? t) >= 3000) {
          cur.passes.push(st.id);
          cur.passLog.push({ id: st.id, t });
          changed = true;
        }
        inFence.set(st.id, inside);
      }
      // a stop starts below walking-still speed and only ends once the train is really moving
      // again, so walking along the platform (or out of the station) keeps it one stop
      if (stopStart == null) {
        if (v < th.stopSpeed) { stopStart = t; stopStation = here?.id ?? null; }
      } else if (v >= th.walkMaxSpeed) {
        if (stopStation && stopStation !== cur.from) {
          cur.stops.push({ id: stopStation, arr: stopStart, dep: t });
          changed = true;
        }
        stopStart = null;
        stopStation = null;
      } else if (!stopStation && here) stopStation = here.id; // crept in after a stop just outside

      // signal crawl: slow (or stopped) between stations
      if (v < th.crawlSpeed && !here) slowSince ??= t;
      else flushCrawl(t);

      if (changed) reviewTrain();

      if (stopStart != null && stopStation && stopStation !== cur.from) {
        const dwell = (t - stopStart) / 1000;
        const ex = exitOptions(stopStation);
        if (ex.allEnd && dwell >= th.arrivalConfirmSec) arrive(stopStart, stopStation, t);
        else if (ex.ends && !ex.transfers && dwell >= th.alightDwellSec) arrive(stopStart, stopStation, t);
        else if (destIds.has(stopStation) && !transferIds.has(stopStation) && dwell >= th.alightDwellSec * 1.5) arrive(stopStart, stopStation, t);
        else if (transferIds.has(stopStation) && shouldAlight(stopStation, dwell)) {
          const at = stopStart;
          const id = stopStation;
          finishTrain(at, id);
          open('wait', at, { station: id });
          state = 'wait';
          lastStillT = t;
          trainSince = null;
          awaySince = null;
          log(at, 'wait', `Got off at ${stationById(route, id)?.name ?? id} — transfer wait`);
        }
      }
    }
    if (cur) cur.end = t;
    return snapshot();
  }

  function candidates() {
    return live().map((s) => s.id);
  }

  /** While biking: which origin station are we heading toward (by travel bearing)? */
  function heading() {
    if (state !== 'bike' || trail.length < 2) return null;
    const now = trail[trail.length - 1];
    let ref = null;
    for (let i = trail.length - 2; i >= 0; i--) {
      if (now.t - trail[i].t >= 20000) { ref = trail[i]; break; }
    }
    if (!ref || haversine(ref.pos, now.pos) < 40) return null;
    const travel = bearing(ref.pos, now.pos);
    let best = null;
    for (const id of originIds) {
      const st = stationById(route, id);
      if (!st) continue;
      const diff = bearingDiff(travel, bearing(now.pos, st.pos));
      if (!best || diff < best.diff) best = { id, name: st.name, diff, travel, distM: haversine(now.pos, st.pos) };
    }
    return best;
  }

  function snapshot() {
    const now = lastSample?.t ?? null;
    const t0 = phases.find((p) => p.kind !== 'buffer')?.start ?? null;
    return {
      state,
      label: STATE_LABEL[state],
      now,
      speed,
      pos: lastSample?.pos ?? null,
      t0,
      elapsed: t0 != null && now != null ? ((record ? record.arrival : now) - t0) / 1000 : null,
      phase: cur,
      phases,
      events,
      trail,
      candidates: candidates(),
      heading: heading(),
      record,
      inStation: lastSample ? fenceOf(lastSample.pos, route.stations)?.id ?? null : null,
    };
  }

  /**
   * End the trip by hand (CommuteLab's "End Trip"): on a train, you arrived where the leading
   * option ends; waiting after a train, you arrived at that station. Returns the record, or null
   * when you have not been on a train yet (nothing to benchmark).
   */
  function finish(t = lastSample?.t) {
    if (state === 'arrived') return record;
    if (!lastSample) return null;
    if (state === 'train') {
      const ends = live().map((s) => strategyPath(s)).map((p) => p[p.length - 1]);
      const id = stopStation && destIds.has(stopStation) ? stopStation : ends[0] ?? cur.from;
      arrive(stopStart ?? t, id, t);
    } else if (state === 'wait' && phases.some((p) => p.kind === 'train')) arrive(cur.start, cur.station, t);
    else return null;
    record.manual = true;
    return record;
  }

  return { push, snapshot, finish, get record() { return record; }, get state() { return state; } };
}

export function fmt(sec) {
  if (sec == null || !isFinite(sec)) return '—';
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

/** Convenience: run a whole sample list through a fresh engine. */
export function runEngine(route, samples, opts) {
  const e = createEngine(route, opts);
  for (const s of samples) e.push(s);
  return e;
}
