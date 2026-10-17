import { byStrategy, insights as computeInsights, stats } from '../engine/analytics.js';
import { samplePlan, planToRecord, generateHistory } from '../engine/model.js';
import { createRng } from '../engine/rng.js';
import { strategyPath } from '../engine/routes.js';
import { dayLabel, timeLabel, toMph } from './format';

export type Leg = { kind: string; label: string; sub: string; sec: number; station?: string };

export type RunView = {
  id: string;
  code: string | null;
  color: string;
  desc: string;
  source: string;
  sample: boolean;
  startedAt: number;
  t0: number;
  date: string;
  time: string;
  total: number;
  buffer: number;
  bike: number;
  wait: number;
  train: number;
  redLights: number;
  firstTrainMph: number;
  crawl: boolean;
  gambleWon: boolean | null;
  legs: Leg[];
  record: any;
};

const sec = (p: any) => (p.end - p.start) / 1000;
export const stationName = (route: any, id: string) => route.stations.find((s: any) => s.id === id)?.name ?? id;
export const strategyOf = (route: any, id: string | null) => route.strategies.find((s: any) => s.id === id);

/** Line names for train leg `i` of a strategy ("4/5 express", "6"). */
export function legLineName(route: any, strategy: any, i: number) {
  const leg = strategy?.legs?.[i];
  if (!leg) return 'Train';
  const names = leg.lines.map((id: string) => route.lines.find((l: any) => l.id === id)).filter(Boolean);
  const label = [...new Set(names.flatMap((l: any) => l.routes))].join('/');
  const kind = names.length && names.every((l: any) => l.kind === 'express') ? ' express' : names.some((l: any) => l.kind === 'local') ? ' local' : '';
  return `${label || 'Train'}${kind}`;
}

/** Turn an engine record into what the CommuteLab screens show. */
export function viewRun(route: any, rec: any, gamble?: { at: string; strategy: string; breakeven: number } | null): RunView {
  const strat = strategyOf(route, rec.strategyId);
  const phases = rec.phases.filter((p: any) => p.kind !== 'buffer');
  const legs: Leg[] = [];
  let train = 0;
  let waits = 0;
  for (const p of phases) {
    if (p.kind === 'bike') {
      legs.push({ kind: 'bike', label: `Bike to ${stationName(route, p.to ?? rec.path[0])}`, sub: `${p.redLights} red light${p.redLights === 1 ? '' : 's'} · ${(p.distance / 1000).toFixed(1)} km`, sec: sec(p) });
    } else if (p.kind === 'wait') {
      const first = waits++ === 0;
      legs.push({ kind: first ? 'wait' : 'transfer', label: first ? `${stationName(route, p.station)} platform wait` : `Transfer at ${stationName(route, p.station)}`, sub: first ? 'Station geofence dwell' : 'Off one train, waiting for the next', sec: sec(p), station: p.station });
    } else if (p.kind === 'train') {
      const name = legLineName(route, strat, train++);
      const mph = sec(p) > 0 ? toMph(p.distance / sec(p)) : 0;
      const crawl = p.crawlSec >= (route.thresholds?.crawlFlagSec ?? 60);
      legs.push({ kind: 'train', label: `${name} to ${stationName(route, p.to)}`, sub: `${mph.toFixed(1)} mph avg${p.service ? ` · ran ${p.service}` : ''}${crawl ? ` · crawled ${Math.round(p.crawlSec)}s` : ''}`, sec: sec(p) });
    }
  }
  const firstTrain = phases.find((p: any) => p.kind === 'train');
  let gambleWon: boolean | null = null;
  if (gamble && rec.strategyId === gamble.strategy && isFinite(gamble.breakeven)) {
    const w = rec.phases.filter((p: any) => p.kind === 'wait' && p.station === gamble.at).reduce((a: number, p: any) => a + sec(p), 0);
    gambleWon = w <= gamble.breakeven;
  }
  return {
    id: rec.id,
    code: rec.strategyId,
    color: strat?.color ?? '#94A3B8',
    desc: strat?.desc ?? `Unmatched: ${rec.path.map((id: string) => stationName(route, id)).join(' → ')}`,
    source: rec.source,
    sample: rec.source === 'history',
    startedAt: rec.startedAt,
    t0: rec.t0,
    date: dayLabel(rec.t0),
    time: timeLabel(rec.t0),
    total: rec.metrics.total,
    buffer: rec.metrics.buffer,
    bike: rec.metrics.bike,
    wait: rec.metrics.wait,
    train: rec.metrics.train,
    redLights: rec.metrics.redLights,
    firstTrainMph: firstTrain && sec(firstTrain) > 0 ? toMph(firstTrain.distance / sec(firstTrain)) : 0,
    crawl: rec.metrics.crawl,
    gambleWon,
    legs,
    record: rec,
  };
}

/** Sample history is regenerated from its seed rather than stored. */
export function sampleRuns(route: any, samples: { n: number; seed: number; endDate: number } | null | undefined) {
  if (!samples || !route.strategies.length) return [];
  return generateHistory(route, { n: samples.n, seed: samples.seed, endDate: new Date(samples.endDate), startHour: 8, startMin: [0, 35] });
}

/** What the model expects before you have any trips: 15 simulated commutes per option. */
export function estimateRecords(route: any) {
  const out: any[] = [];
  for (const s of route.strategies) {
    const rng = createRng(1234);
    for (let i = 0; i < 15; i++) out.push(planToRecord(route, samplePlan(route, s.id, rng, { startTime: Date.UTC(2026, 0, 5 + i, 13) }), 'estimate', `est-${s.id}-${i}`));
  }
  return out;
}

export function estimateStats(route: any, recs = estimateRecords(route)) {
  const out: Record<string, any> = {};
  for (const s of route.strategies) out[s.id] = statsFor(recs.filter((r) => r.strategyId === s.id));
  return out;
}

export type RouteStats = {
  count: number;
  medianSec: number;
  meanSec: number;
  p90Sec: number;
  p10Sec: number;
  stdDevSec: number;
  avgBikeSec: number;
  avgWaitSec: number;
  avgTrainSec: number;
  avgPreBufferSec: number;
  estimated?: boolean;
};

function statsFor(recs: any[]): RouteStats {
  const t = stats(recs.map((r) => r.metrics.total));
  const mean = (k: string) => (recs.length ? recs.reduce((a, r) => a + r.metrics[k], 0) / recs.length : 0);
  return {
    count: recs.length,
    medianSec: t.median,
    meanSec: t.mean,
    p90Sec: t.p90,
    p10Sec: t.p10,
    stdDevSec: t.sd,
    avgBikeSec: mean('bike'),
    avgWaitSec: mean('wait'),
    avgTrainSec: mean('train'),
    avgPreBufferSec: mean('buffer'),
  };
}

/** CommuteLab's per-route stats, falling back to the model's estimate for routes with no trips yet. */
export function statsByRoute(route: any, runs: any[], estimates: Record<string, RouteStats>) {
  const out: Record<string, RouteStats> = {};
  for (const s of route.strategies) {
    const mine = runs.filter((r) => r.strategyId === s.id);
    out[s.id] = mine.length >= 2 ? statsFor(mine) : { ...(estimates[s.id] ?? statsFor([])), count: mine.length, estimated: true };
  }
  return out;
}

/** Reliability-adjusted winner (P50 + P90 consistency), as in CommuteLab. */
export function winner(route: any, st: Record<string, RouteStats>) {
  const score = (id: string) => st[id].medianSec * 0.65 + st[id].p90Sec * 0.35;
  const ids = route.strategies.map((s: any) => s.id).filter((id: string) => isFinite(score(id)));
  return ids.length ? ids.reduce((best: string, cur: string) => (score(cur) < score(best) ? cur : best)) : null;
}

export function routeInsights(route: any, runs: any[]) {
  const ins = computeInsights({ ...route, insights: route.insights ?? {} }, runs);
  return ins;
}

export const pathText = (route: any, s: any) => strategyPath(s).map((id: string) => stationName(route, id)).join(' → ');
export { byStrategy };
