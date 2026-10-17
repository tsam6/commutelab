// Benchmark statistics and quirk/hypothesis insights.

export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function stats(xs) {
  const v = xs.filter((x) => isFinite(x)).slice().sort((a, b) => a - b);
  const n = v.length;
  if (!n) return { n: 0 };
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return {
    n, mean, sd, min: v[0], max: v[n - 1],
    median: quantile(v, 0.5), p10: quantile(v, 0.1), p25: quantile(v, 0.25), p75: quantile(v, 0.75), p90: quantile(v, 0.9),
    cv: mean ? sd / mean : 0,
  };
}

const median = (xs) => stats(xs).median;

/** P(a < b) over every pair — "how often does A beat B head to head". */
export function pBeats(a, b) {
  if (!a.length || !b.length) return NaN;
  let w = 0;
  for (const x of a) for (const y of b) w += x < y ? 1 : x === y ? 0.5 : 0;
  return w / (a.length * b.length);
}

export function linreg(points) {
  const n = points.length;
  if (n < 3) return null;
  const mx = points.reduce((a, p) => a + p[0], 0) / n;
  const my = points.reduce((a, p) => a + p[1], 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of points) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  if (!sxx) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, r: syy ? sxy / Math.sqrt(sxx * syy) : 0 };
}

const runsOf = (runs, id) => runs.filter((r) => r.strategyId === id);
const dur = (p) => (p.end - p.start) / 1000;

export function byStrategy(route, runs) {
  return route.strategies.map((s) => {
    const rs = runsOf(runs, s.id);
    const mean = (k) => (rs.length ? rs.reduce((a, r) => a + r.metrics[k], 0) / rs.length : 0);
    return {
      strategy: s,
      runs: rs,
      total: stats(rs.map((r) => r.metrics.total)),
      phases: { buffer: mean('buffer'), bike: mean('bike'), wait: mean('wait'), train: mean('train'), originWait: mean('originWait'), transferWait: mean('transferWait') },
    };
  });
}

export function winMatrix(route, runs) {
  const t = (id) => runsOf(runs, id).map((r) => r.metrics.total);
  return route.strategies.map((a) => route.strategies.map((b) => (a.id === b.id ? null : pBeats(t(a.id), t(b.id)))));
}

/** Seconds from arriving at `stationId` (getting off there, or stopping there on the way) to arriving at the destination. */
function fromStation(run, stationId) {
  const p = run.phases.find((x) => x.kind === 'train' && x.to === stationId);
  if (p) return (run.arrival - p.end) / 1000;
  for (const x of run.phases) {
    if (x.kind !== 'train') continue;
    const s = (x.stopLog || []).find((y) => y.id === stationId);
    if (s) return (run.arrival - s.arr) / 1000;
  }
  return NaN;
}

function gambleInsight(route, runs) {
  const cfg = route.insights?.gamble;
  if (!cfg) return null;
  const A = runsOf(runs, cfg.strategy);
  const B = runsOf(runs, cfg.alt);
  if (A.length < 3 || B.length < 3) return { cfg, enough: false };
  const aSeg = A.map((r) => fromStation(r, cfg.from));
  const bSeg = B.map((r) => fromStation(r, cfg.from));
  const medB = median(bSeg);
  const waitAt = (r) => r.phases.filter((p) => p.kind === 'wait' && p.station === cfg.at).reduce((a, p) => a + dur(p), 0);
  const waits = A.map(waitAt);
  const wins = aSeg.map((x) => x < medB);
  const winRate = wins.filter(Boolean).length / A.length;
  const gains = aSeg.filter((x) => x < medB).map((x) => medB - x);
  const losses = aSeg.filter((x) => x >= medB).map((x) => x - medB);
  // How long can you afford to wait for the local and still beat going local all the way?
  const breakeven = medB - median(aSeg.map((x, i) => x - waits[i]));
  return {
    cfg, enough: true, n: A.length, nAlt: B.length,
    winRate,
    headToHead: pBeats(aSeg, bSeg),
    medGamble: median(aSeg), medAlt: medB,
    avgGain: gains.length ? gains.reduce((a, b) => a + b, 0) / gains.length : 0,
    avgLoss: losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0,
    waits,
    waitStats: stats(waits),
    quickRate: waits.filter((w) => w <= 120).length / waits.length,
    breakeven,
    segStats: { gamble: stats(aSeg), alt: stats(bSeg) },
  };
}

function lightsInsight(route, runs) {
  const cfg = route.insights?.lights;
  if (!cfg) return null;
  const S = runsOf(runs, cfg.strategy);
  if (S.length < 5) return { cfg, enough: false };
  const pts = S.map((r) => [r.metrics.redLights, r.metrics.bike]);
  const fit = linreg(pts);
  const cmp = runs.filter((r) => cfg.compare.includes(r.strategyId));
  const cmpBikeMed = median(cmp.map((r) => r.metrics.bike));
  const buckets = [
    { label: 'Green wave (0–2 reds)', test: (n) => n <= 2 },
    { label: 'Some reds (3–4)', test: (n) => n >= 3 && n <= 4 },
    { label: 'Red-heavy (5+)', test: (n) => n >= 5 },
  ].map((b) => {
    const rs = S.filter((r) => b.test(r.metrics.redLights));
    return {
      label: b.label, n: rs.length,
      bike: median(rs.map((r) => r.metrics.bike)),
      total: median(rs.map((r) => r.metrics.total)),
      deltaVsCompare: median(rs.map((r) => r.metrics.bike)) - cmpBikeMed,
    };
  });
  const cmpTotalMed = Math.min(...cfg.compare.map((id) => median(runsOf(runs, id).map((r) => r.metrics.total))).filter(isFinite));
  return {
    cfg, enough: true, n: S.length, fit,
    points: pts,
    comparePoints: cmp.map((r) => [r.metrics.redLights, r.metrics.bike]),
    bikeMed: median(S.map((r) => r.metrics.bike)),
    cmpBikeMed,
    deltaMed: median(S.map((r) => r.metrics.bike)) - cmpBikeMed,
    redMean: S.reduce((a, r) => a + r.metrics.redLights, 0) / S.length,
    redSecMean: S.reduce((a, r) => a + r.metrics.redLightSec, 0) / S.length,
    buckets,
    cmpTotalMed,
  };
}

function crawlInsight(route, runs) {
  const cfg = route.insights?.crawl;
  if (!cfg) return null;
  const O = runs.filter((r) => cfg.strategies.includes(r.strategyId));
  const rival = runsOf(runs, cfg.rival);
  if (O.length < 5 || rival.length < 3) return { cfg, enough: false };
  const crawl = O.filter((r) => r.metrics.crawl);
  const clean = O.filter((r) => !r.metrics.crawl);
  const rivalMed = median(rival.map((r) => r.metrics.total));
  const ruined = crawl.filter((r) => r.metrics.total > rivalMed);
  const losses = O.filter((r) => r.metrics.total > rivalMed);
  const rivalCrawl = rival.filter((r) => r.metrics.crawlSecTotal >= (route.thresholds?.crawlFlagSec ?? 60));
  return {
    cfg, enough: true, n: O.length,
    rate: crawl.length / O.length,
    nCrawl: crawl.length,
    medCrawl: median(crawl.map((r) => r.metrics.total)),
    medClean: median(clean.map((r) => r.metrics.total)),
    cost: median(crawl.map((r) => r.metrics.total)) - median(clean.map((r) => r.metrics.total)),
    avgCrawlSec: crawl.length ? crawl.reduce((a, r) => a + r.metrics.firstTrainCrawlSec, 0) / crawl.length : 0,
    ruinedRate: crawl.length ? ruined.length / crawl.length : 0,
    lossShareFromCrawl: losses.length ? losses.filter((r) => r.metrics.crawl).length / losses.length : 0,
    cleanWinRate: clean.length ? clean.filter((r) => r.metrics.total <= rivalMed).length / clean.length : 0,
    rivalMed,
    rivalRate: rivalCrawl.length / rival.length,
    firstTrain: { crawl: median(crawl.map((r) => r.metrics.firstTrainSec)), clean: median(clean.map((r) => r.metrics.firstTrainSec)) },
  };
}

export function verdict(route, runs) {
  const rows = byStrategy(route, runs).filter((r) => r.total.n >= 3);
  if (!rows.length) return null;
  const best = (fn) => rows.reduce((a, b) => (fn(b) < fn(a) ? b : a));
  return {
    fastest: best((r) => r.total.median),
    consistent: best((r) => r.total.p90 - r.total.p10),
    worstDay: best((r) => r.total.p90),
    rows,
  };
}

export function insights(route, runs) {
  return { gamble: gambleInsight(route, runs), lights: lightsInsight(route, runs), crawl: crawlInsight(route, runs), verdict: verdict(route, runs) };
}

// ---------------------------------------------------------------------------------------------
// Racing your own history (Track tab): typical phase durations per strategy, and where a
// "ghost" running your median commute would be right now compared with you.
// ---------------------------------------------------------------------------------------------

const legPhases = (run) => run.phases.filter((p) => p.kind !== 'buffer');
const kindKey = (run) => legPhases(run).map((p) => p.kind).join('>');

/**
 * Median duration of each phase position for one strategy's runs. Positions follow the run's
 * own order (bike, wait, train, [wait, train]...); only runs with the most common phase shape count.
 */
export function phaseProfile(runs) {
  if (!runs?.length) return null;
  const counts = new Map();
  for (const r of runs) counts.set(kindKey(r), (counts.get(kindKey(r)) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  if (!top) return null;
  const kinds = top.split('>');
  const same = runs.filter((r) => kindKey(r) === top);
  const secs = kinds.map((_, i) => median(same.map((r) => { const p = legPhases(r)[i]; return (p.end - p.start) / 1000; })));
  if (secs.some((s) => !isFinite(s))) return null;
  return {
    kinds,
    secs,
    typical: secs.reduce((a, b) => a + b, 0),
    medianTotal: median(runs.map((r) => r.metrics.total)),
    buffer: median(runs.map((r) => r.metrics.buffer)),
    n: runs.length,
  };
}

/** phaseProfile for every strategy of a route (null where there is no data). */
export function strategyProfiles(route, runs) {
  const out = {};
  for (const s of route.strategies) out[s.id] = phaseProfile(runs.filter((r) => r.strategyId === s.id));
  return out;
}

/**
 * Live race against your median, one lane per strategy still possible.
 * progress = where a typical run would be at your current point (in seconds of typical time);
 * delta    = elapsed − progress (positive = you are behind your typical commute).
 */
export function ghostRace(profiles, { phases = [], now = null, t0 = null, candidates = [], done = false, minRuns = 3 } = {}) {
  const mine = phases.filter((p) => p.kind !== 'buffer');
  const elapsed = t0 != null && now != null ? Math.max(0, (now - t0) / 1000) : 0;
  const out = [];
  for (const id of candidates) {
    const prof = profiles?.[id];
    if (!prof || prof.n < minRuns) continue;
    if (mine.length > prof.kinds.length || mine.some((p, i) => p.kind !== prof.kinds[i])) continue;
    let progress = 0;
    if (done) progress = prof.typical;
    else {
      mine.forEach((p, i) => {
        if (i < mine.length - 1) progress += prof.secs[i];
        else progress += Math.min(prof.secs[i], Math.max(0, ((now ?? p.end) - p.start) / 1000));
      });
    }
    const remaining = Math.max(0, prof.typical - progress);
    out.push({
      id,
      ...prof,
      progress,
      elapsed,
      delta: elapsed - progress,
      remaining,
      projected: elapsed + remaining,
      eta: now != null ? now + remaining * 1000 : null,
    });
  }
  return out;
}

/** Rank of a run among its strategy's runs (1 = fastest) and whether it is a personal best. */
export function rankOf(runs, run) {
  const same = runs.filter((r) => r.strategyId === run.strategyId && r.strategyId != null);
  const sorted = same.map((r) => r.metrics.total).sort((a, b) => a - b);
  const rank = sorted.findIndex((t) => t >= run.metrics.total) + 1;
  return { rank: rank || sorted.length, of: sorted.length, pb: sorted.length > 1 && rank === 1 };
}
