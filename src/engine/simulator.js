// GPS / telemetry simulator: plays a commute plan back as 1 Hz fixes.
// Supports injecting a distraction/errand delay at the current position at any moment.
import { pathLength, pointAlong, splitPath, jitter } from './geo.js';
import { createRng } from './rng.js';

/** Fraction of distance covered and normalised speed at time fraction tau, trapezoid profile. */
export function profile(tau, rIn, rOut) {
  const vmax = 1 / (1 - rIn / 2 - rOut / 2);
  if (rIn > 0 && tau < rIn) return { d: (0.5 * vmax * tau * tau) / rIn, v: (vmax * tau) / rIn };
  if (rOut > 0 && tau > 1 - rOut) {
    const u = 1 - tau;
    return { d: 1 - (0.5 * vmax * u * u) / rOut, v: (vmax * u) / rOut };
  }
  return { d: 0.5 * vmax * rIn + vmax * (tau - rIn), v: vmax };
}

export function createSimulator(plan, { noiseM = 3, seed = 99, reportSpeed = true } = {}) {
  const rng = createRng(seed);
  const segs = plan.segments.map((s) => ({ ...s, len: s.type === 'move' ? pathLength(s.path) : 0 }));
  let idx = 0;
  let segT = 0; // seconds into current segment
  let t = plan.startTime;
  let done = false;

  function stateAt() {
    const seg = segs[idx];
    if (!seg) return null;
    if (seg.type === 'dwell') return { pos: seg.at, v: 0, seg };
    const tau = seg.dur > 0 ? Math.min(1, segT / seg.dur) : 1;
    const p = profile(tau, seg.rampIn || 0, seg.rampOut || 0);
    return { pos: pointAlong(seg.path, p.d * seg.len), v: (p.v * seg.len) / Math.max(seg.dur, 1e-6), seg };
  }

  /** Advance one simulated second and return a GPS fix (or null when finished). */
  function step(dt = 1) {
    if (done) return null;
    segT += dt;
    t += dt * 1000;
    while (segs[idx] && segT >= segs[idx].dur) {
      segT -= segs[idx].dur;
      idx++;
    }
    const st = stateAt();
    if (!st) {
      done = true;
      return null;
    }
    const pos = jitter(st.pos, noiseM, rng.gauss);
    return {
      t,
      lat: pos[0],
      lon: pos[1],
      accuracy: noiseM ? Math.max(3, noiseM * 1.5) : 5,
      speed: reportSpeed ? Math.max(0, st.v + (noiseM ? rng.gauss() * 0.25 : 0)) : null,
      truth: st.seg.phase.kind,
      tag: st.seg.tag ?? null,
    };
  }

  /** Stop where you are for `sec` seconds (an errand, a chat, a detour). */
  function injectDelay(sec, tag = 'errand') {
    const seg = segs[idx];
    if (!seg || done) return;
    if (seg.type === 'dwell') {
      seg.dur += sec;
      return;
    }
    const tau = Math.min(1, segT / seg.dur);
    const p = profile(tau, seg.rampIn || 0, seg.rampOut || 0);
    const [head, tail] = splitPath(seg.path, p.d * seg.len);
    const remaining = Math.max(1, seg.dur - segT);
    const consumed = { ...seg, path: head, len: pathLength(head), dur: segT, rampOut: 0 };
    const pause = { phase: seg.phase, type: 'dwell', at: tail[0], dur: sec, tag, len: 0 };
    const rest = { ...seg, path: tail, len: pathLength(tail), dur: remaining, rampIn: Math.min(0.3, 6 / remaining) };
    segs.splice(idx, 1, consumed, pause, rest);
    idx += 1;
    segT = 0;
  }

  /**
   * Crawl for about `sec` seconds (a signal crawl, if you are on a train), at `speed` m/s or slower
   * (never below a walking crawl), staying clear of station fences. A crawl longer than the track
   * left before the next station carries on after it, up to the end of the current phase.
   * Returns the crawl seconds actually added (0 when there is no track left to crawl on).
   */
  function injectSlow(sec, speed = 2.2, tag = 'crawl') {
    if (done || !segs[idx]) return 0;
    const key = segs[idx].phase.key;
    let left = sec;
    let applied = 0;
    for (let k = idx; k < segs.length && segs[k].phase.key === key && left > 5; k++) {
      const seg = segs[k];
      if (seg.type !== 'move' || seg.dur <= 0 || seg.tag === tag) continue;
      const t0 = k === idx ? segT : 0;
      const p = profile(Math.min(1, t0 / seg.dur), seg.rampIn || 0, seg.rampOut || 0);
      const covered = p.d * seg.len;
      const remainingLen = seg.len - covered;
      const lead = Math.max(0, 130 - covered); // clear the station you just left...
      const room = remainingLen - lead - 130; // ...and the one you are heading to
      if (room < 80) continue;
      const v = Math.max(1.5, Math.min(speed, room / left));
      const slowLen = Math.min(v * left, room);
      const remainingDur = Math.max(1, seg.dur - t0);
      const [head, tail] = splitPath(seg.path, covered);
      const [leadPath, tail2] = splitPath(tail, lead);
      const [slowPath, rest] = splitPath(tail2, slowLen);
      const restLen = pathLength(rest);
      const restDur = Math.max(4, remainingDur * (restLen / remainingLen));
      const pieces = [];
      if (t0 > 0) pieces.push({ ...seg, path: head, len: pathLength(head), dur: t0, rampOut: 0 });
      if (lead > 1) {
        const d = Math.max(1, (remainingDur * lead) / remainingLen);
        pieces.push({ ...seg, path: leadPath, len: pathLength(leadPath), dur: d, rampIn: t0 > 0 ? 0 : seg.rampIn || 0, rampOut: Math.min(0.5, 8 / d) });
      }
      pieces.push({ ...seg, path: slowPath, len: pathLength(slowPath), dur: slowLen / v, rampIn: 0, rampOut: 0, tag });
      pieces.push({ ...seg, path: rest, len: restLen, dur: restDur, rampIn: Math.min(0.3, 15 / restDur), tag: seg.tag });
      segs.splice(k, 1, ...pieces);
      if (k === idx) {
        if (t0 > 0) idx += 1;
        segT = 0;
      }
      k += pieces.length - 1;
      left -= slowLen / v;
      applied += slowLen / v;
    }
    return applied;
  }

  return {
    step,
    injectDelay,
    injectSlow,
    get t() { return t; },
    get done() { return done; },
    get current() { return segs[idx] ?? null; },
    get progress() {
      const total = segs.reduce((a, s) => a + s.dur, 0);
      const past = segs.slice(0, idx).reduce((a, s) => a + s.dur, 0) + segT;
      return Math.min(1, past / total);
    },
  };
}

/** Run a plan through the simulator to completion and return all fixes. */
export function simulateAll(plan, opts) {
  const sim = createSimulator(plan, opts);
  const out = [];
  for (let s = sim.step(); s; s = sim.step()) out.push(s);
  return out;
}
