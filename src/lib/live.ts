// What both map views draw for one moment of a trip: the option network, the trail you rode
// (coloured by phase), where you are, where your typical day would be (the ghost), and what is
// still to ride on the leading option.
import { ghostRace } from '../engine/analytics.js';
import { cumulative, pathLength, pointAlong, projectOnPath, slicePath } from '../engine/geo.js';
import { legPath } from '../nyc/build-route.js';

export type Geo = { bike: number[][]; legs: { leg: any; path: number[][]; line: any }[] };
export type Moment = { kind: 'idle' | 'buffer' | 'bike' | 'wait' | 'train' | 'arrived'; leg: number; frac: number; pos: number[] | null };

const stationPos = (route: any, id: string) => route.stations.find((s: any) => s.id === id)?.pos;

export function strategyGeometry(route: any): Record<string, Geo> {
  const out: Record<string, Geo> = {};
  for (const s of route.strategies) {
    const origin = s.legs[0]?.from;
    const bike = route.paths?.[`bike:${origin}`] ?? [route.docks[0].pos, stationPos(route, origin)];
    out[s.id] = {
      bike,
      legs: s.legs.map((leg: any) => {
        const path = legPath(route, leg);
        return { leg, path: path.length >= 2 ? path : [stationPos(route, leg.from), stationPos(route, leg.to)], line: route.lines.find((l: any) => l.id === leg.lines[0]) };
      }),
    };
  }
  return out;
}

/** Trail split by phase, first platform wait told apart from transfer waits. */
export function trailPieces(snap: any) {
  if (!snap?.trail?.length) return [];
  const out: { kind: string; path: number[][] }[] = [];
  let waits = 0;
  for (const p of snap.phases) {
    const kind = p.kind === 'wait' ? (waits++ ? 'transfer' : 'wait') : p.kind;
    const pts = [];
    for (const x of snap.trail) if (x.t >= p.start && x.t <= p.end) pts.push(x.pos);
    if (pts.length >= 2) out.push({ kind, path: pts });
  }
  return out;
}

const fracAlong = (path: number[][], pos: number[]) => {
  if (!path || path.length < 2 || !pos) return 0;
  const cum = cumulative(path);
  const total = cum[cum.length - 1] || 1;
  return Math.max(0, Math.min(1, projectOnPath(path, pos, cum).dist / total));
};

/** Where you are, in terms of the leading option's structure. */
export function youMoment(snap: any, geo: Geo | undefined): Moment {
  if (!snap || snap.state === 'idle' || !snap.pos) return { kind: 'idle', leg: 0, frac: 0, pos: null };
  const trains = snap.phases.filter((p: any) => p.kind === 'train').length;
  const waits = snap.phases.filter((p: any) => p.kind === 'wait').length;
  const pos = snap.pos;
  if (snap.state === 'buffer') return { kind: 'buffer', leg: 0, frac: 0, pos };
  if (snap.state === 'bike') return { kind: 'bike', leg: 0, frac: geo ? fracAlong(geo.bike, pos) : 0, pos };
  if (snap.state === 'wait') return { kind: 'wait', leg: Math.max(0, waits - 1), frac: 0, pos };
  if (snap.state === 'train') {
    const leg = Math.max(0, trains - 1);
    return { kind: 'train', leg, frac: geo?.legs[leg] ? fracAlong(geo.legs[leg].path, pos) : 0, pos };
  }
  return { kind: 'arrived', leg: Math.max(0, trains - 1), frac: 1, pos };
}

/** Position after `t` seconds of a typical commute on this option (profile = analytics.phaseProfile). */
export function typicalMoment(prof: any, geo: Geo | undefined, t: number): Moment | null {
  if (!prof || !geo) return null;
  let acc = 0;
  for (let i = 0; i < prof.kinds.length; i++) {
    const d = prof.secs[i];
    if (t <= acc + d || i === prof.kinds.length - 1) {
      const frac = d > 0 ? Math.max(0, Math.min(1, (t - acc) / d)) : 1;
      const kind = prof.kinds[i];
      const leg = Math.max(0, Math.floor((i - 1) / 2));
      if (kind === 'bike') return { kind, leg: 0, frac, pos: pointAlong(geo.bike, frac * pathLength(geo.bike)) };
      if (kind === 'wait') {
        const p = geo.legs[leg]?.path;
        return { kind, leg, frac, pos: p?.[0] ?? null };
      }
      const p = geo.legs[leg]?.path;
      return { kind: 'train', leg, frac, pos: p ? pointAlong(p, frac * pathLength(p)) : null };
    }
    acc += d;
  }
  return null;
}

/** The rest of the leading option from where you are now. */
export function aheadPath(geo: Geo | undefined, you: Moment): number[][][] {
  if (!geo) return [];
  const out: number[][][] = [];
  const legsFrom = (k: number) => geo.legs.slice(k).map((l) => l.path);
  if (you.kind === 'idle' || you.kind === 'buffer') return [geo.bike, ...legsFrom(0)];
  if (you.kind === 'bike') {
    const L = pathLength(geo.bike);
    out.push(slicePath(geo.bike, you.frac * L, L));
    return [...out, ...legsFrom(0)];
  }
  if (you.kind === 'wait') return legsFrom(you.leg);
  if (you.kind === 'train') {
    const p = geo.legs[you.leg]?.path;
    if (p) {
      const L = pathLength(p);
      out.push(slicePath(p, you.frac * L, L));
    }
    return [...out, ...legsFrom(you.leg + 1)];
  }
  return [];
}

/** Everything the maps need for this moment. */
export function buildScene(route: any, snap: any, profiles: any, geoAll: Record<string, Geo>, preview: string | null) {
  const started = !!snap && snap.state !== 'idle';
  const candidates: string[] = started ? snap.candidates : route.strategies.map((s: any) => s.id);
  const lanes = started && snap.t0 != null
    ? ghostRace(profiles, { phases: snap.phases, now: snap.now, t0: snap.t0, candidates, done: snap.state === 'arrived', minRuns: 3 })
    : [];
  const leadId = started
    ? lanes.slice().sort((a: any, b: any) => a.projected - b.projected)[0]?.id ?? candidates[0]
    : preview ?? route.strategies[0]?.id;
  const geo = geoAll[leadId];
  const you = youMoment(snap, geo);
  const lane = lanes.find((l: any) => l.id === leadId);
  const ghost = started && lane && snap.state !== 'arrived' && you.kind !== 'buffer' ? typicalMoment(profiles[leadId], geo, lane.elapsed) : null;
  return {
    started,
    candidates,
    alive: new Set(candidates),
    leadId,
    lead: route.strategies.find((s: any) => s.id === leadId),
    lanes,
    lane,
    trail: trailPieces(snap),
    you,
    ghost,
    ahead: snap?.state === 'arrived' ? [] : aheadPath(geo, you),
  };
}

export type Scene = ReturnType<typeof buildScene>;
