import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../theme';
import { pathLength } from '../engine/geo.js';
import { formatMinSec } from '../lib/format';
import type { Geo, Moment, Scene } from '../lib/live';

type Props = { route: any; scene: Scene; geo: Record<string, Geo>; snap: any; insetTop?: number; insetBottom?: number };

type Track = { key: string; routes: string[]; color: string; text: string; kind: string | null; lines: any[]; x: number; nodes: Set<string>; stops: Set<string>; skips: Set<string> };

/** Lay out any route as a schematic: one column per train service, stations stacked in riding order. */
function layout(route: any) {
  const tracks = new Map<string, Track>();
  const trackOfLine = new Map<string, Track>();
  for (const s of route.strategies) {
    for (const leg of s.legs) {
      for (const id of leg.lines) {
        const l = route.lines.find((x: any) => x.id === id);
        if (!l) continue;
        const key = l.routes.join('/');
        let t = tracks.get(key);
        if (!t) tracks.set(key, (t = { key, routes: l.routes, color: l.color, text: l.text, kind: l.kind, lines: [], x: 0, nodes: new Set(), stops: new Set(), skips: new Set() }));
        if (!t.lines.includes(l)) t.lines.push(l);
        trackOfLine.set(l.id, t);
        const i = l.stations.indexOf(leg.from);
        const j = l.stations.indexOf(leg.to);
        const [a, b] = i <= j ? [i, j] : [j, i];
        for (let k = a; k <= b; k++) {
          const n = l.stations[k];
          t.nodes.add(n);
          if (l.skips.includes(n)) t.skips.add(n);
          else t.stops.add(n);
        }
        if (l.kind === 'express') t.kind = 'express';
      }
    }
  }
  for (const t of tracks.values()) for (const n of t.stops) t.skips.delete(n);

  // Longest-path layering over every ridden hop: parallel services share rows.
  const preds = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    if (a === b) return;
    if (!preds.has(b)) preds.set(b, new Set());
    preds.get(b)!.add(a);
  };
  const used = new Set<string>();
  for (const s of route.strategies) {
    for (const leg of s.legs) {
      used.add(leg.from);
      used.add(leg.to);
      for (const id of leg.lines) {
        const l = route.lines.find((x: any) => x.id === id);
        if (!l) continue;
        const i = l.stations.indexOf(leg.from);
        const j = l.stations.indexOf(leg.to);
        const step = i <= j ? 1 : -1;
        for (let k = i; k !== j; k += step) {
          add(l.stations[k], l.stations[k + step]);
          used.add(l.stations[k + step]);
        }
      }
    }
  }
  const layer = new Map<string, number>();
  const visit = (id: string, stack: Set<string>): number => {
    if (layer.has(id)) return layer.get(id)!;
    if (stack.has(id)) return 0;
    stack.add(id);
    let best = 0;
    for (const p of preds.get(id) ?? []) best = Math.max(best, visit(p, stack) + 1);
    stack.delete(id);
    layer.set(id, best);
    return best;
  };
  for (const id of used) visit(id, new Set());
  const rows = Math.max(1, ...[...layer.values()].map((v) => v + 1));

  const list = [...tracks.values()];
  const n = list.length;
  list.forEach((t, i) => { t.x = 178 + (i - (n - 1) / 2) * 32; });
  return { tracks: list, trackOfLine, layer, rows };
}

/** Sample a cubic Bézier into a polyline. */
function bez(p0: number[], c1: number[], c2: number[], p3: number[], n = 24) {
  const out: number[][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p3[1],
    ]);
  }
  return out;
}
const poly = (pts: number[][]) => pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
const prefix = (pts: number[][], f: number) => {
  const k = Math.max(1, Math.round(f * (pts.length - 1)));
  return pts.slice(0, k + 1);
};
const suffix = (pts: number[][], f: number) => pts.slice(Math.min(pts.length - 2, Math.round(f * (pts.length - 1))));

/** B. Subway diagram, drawn from the route itself (no hand-made picture per destination). */
export default function DiagramMap({ route, scene, geo, snap, insetTop = 92, insetBottom = 80 }: Props) {
  const T = useT();
  const L = useMemo(() => layout(route), [route]);
  const box = useRef<HTMLDivElement>(null);
  const [aspect, setAspect] = useState(1.15);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => {
      const r = e.contentRect;
      if (r.width > 0 && r.height > 0) setAspect(r.height / r.width);
    });
    ro.observe(box.current!);
    return () => ro.disconnect();
  }, []);
  const C = {
    bike: T.phase.bike, wait: T.phase.wait, transfer: T.phase.transfer, train: T.phase.train, accent: T.accent,
    dim: T.tertiaryLabel, label: T.label, label2: T.secondaryLabel, canvas: T.mapCanvas, sep: T.separator,
    skip: T.isDark ? '#7d879a' : '#94a3b8', pill: T.isDark ? '#f8fafc' : '#ffffff', pillStroke: T.isDark ? T.mapCanvas : '#0f172a',
  };
  // Row spacing adapts to the free area so the diagram fills it; dense routes get compact labels.
  const W = 390;
  const yTop = 38;
  const bottomArea = 88;
  const gap = Math.max(17, Math.min(44, (W * aspect - yTop - bottomArea) / Math.max(1, L.rows - 1)));
  const compact = gap < 25;
  const yBottom = yTop + (L.rows - 1) * gap;
  const Y = (id: string) => yBottom - (L.layer.get(id) ?? 0) * gap;
  const xs = L.tracks.map((t) => t.x);
  const xMin = Math.min(...xs, 178);
  const xMax = Math.max(...xs, 178);
  const own = route.docks[0].own;
  const dock = [Math.min(W - 70, xMax + 92), yBottom + 46];
  const home = own ? dock : [dock[0] - 52, dock[1] + 28];
  const H = home[1] + 14;
  const nodeName = (id: string) => route.stations.find((s: any) => s.id === id)?.name?.replace('-', '–') ?? id;
  const station = (id: string) => route.stations.find((s: any) => s.id === id);
  const trackOf = (leg: any) => L.trackOfLine.get(leg.lines[0]);
  const lead = scene.lead;
  const leadGeo = geo[scene.leadId];

  // x of the column where a strategy boards at its origin
  const originX = (s: any) => trackOf(s.legs[0])?.x ?? xMin;
  const bikeCurve = (s: any) => {
    const o = s.legs[0].from;
    const ox = originX(s);
    const oy = Y(o);
    return bez(dock, [dock[0] - 70, dock[1]], [ox + 6, oy + 52], [ox, oy]);
  };

  /** y on the diagram for a fraction of a leg, interpolated between its stations by real distance. */
  const legY = (leg: any, frac: number) => {
    const l = route.lines.find((x: any) => x.id === leg.lines[0]);
    if (!l) return Y(leg.from) + (Y(leg.to) - Y(leg.from)) * frac;
    const i = l.stations.indexOf(leg.from);
    const j = l.stations.indexOf(leg.to);
    const d = l.at[i] + (l.at[j] - l.at[i]) * frac;
    const step = i <= j ? 1 : -1;
    for (let k = i; k !== j; k += step) {
      const a = l.at[k];
      const b = l.at[k + step];
      if ((d - a) * (d - b) <= 0) {
        const f = b === a ? 0 : (d - a) / (b - a);
        return Y(l.stations[k]) + (Y(l.stations[k + step]) - Y(l.stations[k])) * f;
      }
    }
    return Y(leg.to);
  };

  const pointFor = (m: Moment | null, s: any): number[] | null => {
    if (!m || !s) return null;
    if (m.kind === 'buffer') return [(home[0] + dock[0]) / 2, (home[1] + dock[1]) / 2];
    if (m.kind === 'bike') {
      const c = bikeCurve(s);
      return c[Math.round(m.frac * (c.length - 1))];
    }
    const leg = s.legs[m.leg];
    if (!leg) return null;
    const x = trackOf(leg)?.x ?? xMin;
    if (m.kind === 'wait') return [x, Y(leg.from)];
    if (m.kind === 'arrived') return [x, Y(s.legs[s.legs.length - 1].to)];
    return [x, legY(leg, m.frac)];
  };

  const els: JSX.Element[] = [];
  let k = 0;
  const key = () => `d${k++}`;
  const text = (x: number, y: number, s: string | JSX.Element, o: any = {}) => (
    <text key={key()} x={x} y={y} fill={o.fill ?? C.label2} fontSize={o.size ?? 11} fontWeight={o.weight ?? 600} textAnchor={o.anchor ?? 'start'}>{s}</text>
  );

  // grid
  for (let y = 20; y < H; y += 40) els.push(<line key={key()} x1={0} x2={W} y1={y} y2={y} stroke={C.sep} />);
  for (let x = 30; x < W; x += 40) els.push(<line key={key()} x1={x} x2={x} y1={0} y2={H} stroke={C.sep} />);

  // tracks (faint) + bullets
  for (const t of L.tracks) {
    const ys = [...t.nodes].map(Y);
    const y0 = Math.min(...ys);
    const y1 = Math.max(...ys);
    els.push(<line key={key()} x1={t.x} x2={t.x} y1={y0} y2={y1} stroke={t.color} strokeWidth={5} strokeLinecap="round" opacity={0.3} />);
    t.routes.forEach((r, i) => {
      const bx = t.x + (i - (t.routes.length - 1) / 2) * 20;
      const by = y0 - 28;
      els.push(
        <g key={key()}>
          <circle cx={bx} cy={by} r={9} fill={t.color} />
          <text x={bx} y={by + 3.6} fill={t.text} fontSize={r.length > 1 ? 8 : 10.5} fontWeight={800} textAnchor="middle">{r}</text>
        </g>,
      );
    });
  }

  // bike rides: alive (green, faint until ridden), ruled out (dashed grey)
  const origins = new Map<string, any>();
  for (const s of route.strategies) {
    const o = s.legs[0].from;
    const prev = origins.get(o);
    if (!prev || (scene.alive.has(s.id) && !scene.alive.has(prev.id))) origins.set(o, s);
  }
  const biked = snap?.phases?.some((p: any) => p.kind !== 'buffer');
  for (const [o, s] of origins) {
    const c = bikeCurve(s);
    const alive = route.strategies.some((x: any) => x.legs[0].from === o && scene.alive.has(x.id));
    if (!alive) {
      els.push(<polyline key={key()} points={poly(c)} fill="none" stroke={C.dim} strokeWidth={2.5} strokeDasharray="3 4" opacity={0.7} />);
      const mid = c[Math.floor(c.length * 0.55)];
      els.push(text(Math.min(W - 6, mid[0] + 70), mid[1] - 4, `Bike to ${nodeName(o)}`, { fill: C.dim, size: 10, anchor: 'end' }));
      els.push(text(Math.min(W - 6, mid[0] + 70), mid[1] + 9, 'ruled out', { fill: C.dim, size: 10, anchor: 'end' }));
    } else if (!(scene.started && s.id === scene.leadId && biked)) {
      els.push(<polyline key={key()} points={poly(c)} fill="none" stroke={C.bike} strokeWidth={3} strokeLinecap="round" opacity={0.35} />);
    }
  }

  // stations
  const allNodes = new Set<string>(L.tracks.flatMap((t) => [...t.nodes]));
  for (const id of allNodes) {
    const y = Y(id);
    const st = station(id);
    const stoppers = L.tracks.filter((t) => t.stops.has(id));
    const skippedBy = L.tracks.filter((t) => t.skips.has(id));
    const dest = st?.destination;
    const pill = stoppers.length >= 2;
    if (pill) {
      const x0 = Math.min(...stoppers.map((t) => t.x));
      const x1 = Math.max(...stoppers.map((t) => t.x));
      els.push(<rect key={key()} x={x0 - 8} y={y - 8} width={x1 - x0 + 16} height={16} rx={8} fill={C.pill} stroke={C.pillStroke} strokeWidth={2.5} />);
    } else if (stoppers.length === 1 && dest) {
      els.push(<circle key={key()} cx={stoppers[0].x} cy={y} r={10} fill={C.accent} stroke="#fff" strokeWidth={3} />);
    } else if (stoppers.length === 1) {
      els.push(<circle key={key()} cx={stoppers[0].x} cy={y} r={5} fill={C.canvas} stroke={T.isDark ? '#e2e8f0' : '#475569'} strokeWidth={2} />);
    }
    const skipped = skippedBy.length > 0 && !pill;
    const big = pill || dest;
    els.push(text(xMin - 18, y + 4, nodeName(id), { anchor: 'end', size: compact ? (big ? 11 : 10) : big ? 12 : 11, weight: big ? 700 : 600, fill: dest ? '#ff8a4d' : big ? C.label : skipped ? C.skip : C.label2 }));
    if (skipped && !compact) els.push(text(xMin - 18, y + 16, 'express skips', { anchor: 'end', size: 9, fill: C.skip }));
    if (dest && id === route.destination && !compact && route.title && route.title !== st?.name) els.push(text(xMin - 18, y + 18, route.title, { anchor: 'end', size: 10, fill: '#ff8a4d' }));
  }

  // ridden so far, from the engine's phases (bike, trains), and what is still to ride
  const tag = (x: number, y: number, label: string, val: string, color: string) => (
    <text key={key()} x={x} y={y} fill={color} fontSize={11} fontWeight={700}>
      {label} <tspan fill={C.label} fontWeight={700}>{val}</tspan>
    </text>
  );
  const right = xMax + 16;
  const you = pointFor(scene.you, lead);
  if (lead) {
    const phases = scene.started ? snap.phases.filter((p: any) => p.kind !== 'buffer') : [];
    let ti = 0;
    let wi = 0;
    for (const p of phases) {
      const dur = ((p.end ?? snap.now) - p.start) / 1000;
      const isCur = snap.state !== 'arrived' && p === snap.phase;
      if (p.kind === 'bike') {
        const c = bikeCurve(lead);
        const pts = isCur ? prefix(c, scene.you.frac) : c;
        els.push(<polyline key={key()} points={poly(pts)} fill="none" stroke={C.bike} strokeWidth={5} strokeLinecap="round" />);
        const o = lead.legs[0].from;
        const bikeM = pathLength(leadGeo?.bike ?? []);
        els.push(
          <text key={key()} x={xMin - 18} y={Y(o) + 50} fontSize={11} textAnchor="end" fontWeight={700}>
            <tspan fill={C.bike}>Bike</tspan> <tspan fill={C.label}>{formatMinSec(dur)}</tspan>
          </text>,
        );
        if (bikeM > 0) els.push(text(xMin - 18, Y(o) + 64, `${(bikeM / 1000).toFixed(1)} km from the dock`, { anchor: 'end', size: 9.5, fill: C.skip }));
      } else if (p.kind === 'wait') {
        const leg = lead.legs[wi];
        if (leg) els.push(tag(Math.max(right, (trackOf(leg)?.x ?? xMax) + 16), Y(leg.from) + 4, wi === 0 ? 'Wait' : 'Transfer', formatMinSec(dur), wi === 0 ? C.wait : C.transfer));
        wi++;
      } else if (p.kind === 'train') {
        const leg = lead.legs[ti];
        if (leg) {
          const x = trackOf(leg)?.x ?? xMin;
          const yEnd = isCur ? legY(leg, scene.you.frac) : Y(leg.to);
          els.push(<line key={key()} x1={x} x2={x} y1={Y(leg.from)} y2={yEnd} stroke={C.train} strokeWidth={5} strokeLinecap="round" />);
          const name = trackOf(leg)?.key ?? 'Train';
          const kind = trackOf(leg)?.kind === 'express' ? ' express' : trackOf(leg)?.kind === 'local' ? ' local' : '';
          const yLabel = isCur ? yEnd + 4 : (Y(leg.from) + Y(leg.to)) / 2 + 4;
          els.push(tag(x + 16, yLabel, `${name}${kind}`, `${formatMinSec(dur)}${isCur ? ' so far' : ''}`, C.train));
        }
        ti++;
      }
    }
    // still to ride (dashed accent)
    if (snap?.state !== 'arrived') {
      const from = scene.you;
      const startLeg = from.kind === 'train' || from.kind === 'wait' ? from.leg : 0;
      if (from.kind === 'idle' || from.kind === 'buffer') {
        els.push(<polyline key={key()} points={poly(bikeCurve(lead))} fill="none" stroke={C.accent} strokeWidth={3.5} strokeDasharray="4 5" strokeLinecap="round" />);
      } else if (from.kind === 'bike') {
        els.push(<polyline key={key()} points={poly(suffix(bikeCurve(lead), from.frac))} fill="none" stroke={C.accent} strokeWidth={3.5} strokeDasharray="4 5" strokeLinecap="round" />);
      }
      lead.legs.forEach((leg: any, i: number) => {
        if (i < startLeg) return;
        const x = trackOf(leg)?.x ?? xMin;
        const y0 = i === startLeg && from.kind === 'train' ? legY(leg, from.frac) : Y(leg.from);
        els.push(<line key={key()} x1={x} x2={x} y1={y0} y2={Y(leg.to)} stroke={C.accent} strokeWidth={3.5} strokeDasharray="4 5" strokeLinecap="round" />);
      });
      // the next change on the leading option: "Off here → 6 local · 1 stop"
      const nextIdx = from.kind === 'train' || from.kind === 'wait' ? from.leg + 1 : 1;
      const nl = lead.legs[nextIdx];
      if (nl && scene.started) {
        const t = trackOf(nl);
        const l = route.lines.find((x2: any) => x2.id === nl.lines[0]);
        let stops = 1;
        if (l) {
          const a = l.stations.indexOf(nl.from);
          const b = l.stations.indexOf(nl.to);
          const between = l.stations.slice(Math.min(a, b) + 1, Math.max(a, b));
          stops = between.filter((sid: string) => !l.skips.includes(sid)).length + 1;
        }
        const kind = t?.kind === 'local' ? ' local' : t?.kind === 'express' ? ' express' : '';
        const prevX = trackOf(lead.legs[nextIdx - 1])?.x ?? xMax;
        els.push(tag(Math.max(prevX, t?.x ?? xMax) + 16, Y(nl.from) + 4, `Off here → ${t?.key ?? ''}${kind}`, `${stops} stop${stops === 1 ? '' : 's'}`, C.accent));
      }
    }
  }

  // home + dock
  if (!own) {
    els.push(<line key={key()} x1={home[0]} y1={home[1]} x2={dock[0]} y2={dock[1]} stroke={T.phase.buffer} strokeWidth={3} strokeDasharray="3 4" strokeLinecap="round" />);
    els.push(<circle key={key()} cx={home[0]} cy={home[1]} r={5} fill={C.label} stroke={C.canvas} strokeWidth={2} />);
    els.push(text(home[0] - 11, home[1] + 4, 'Home', { fill: C.label, anchor: 'end' }));
  }
  els.push(<circle key={key()} cx={dock[0]} cy={dock[1]} r={7} fill={C.bike} stroke={C.canvas} strokeWidth={2.5} />);
  els.push(text(dock[0] + 12, dock[1] + 4, own ? 'Your bike' : 'Citi Bike', { fill: C.bike, weight: 700 }));
  if (!own) els.push(text(dock[0] + 12, dock[1] + 17, route.docks[0].name, { size: 9.5 }));

  // ghost (typical day, hollow) and you (solid, with halo)
  const g = pointFor(scene.ghost, lead);
  if (g) els.push(<circle key={key()} cx={g[0]} cy={g[1]} r={6.5} fill="none" stroke={C.label} strokeWidth={2.5} opacity={0.85}><title>Your typical day, right now</title></circle>);
  if (you && scene.started) {
    els.push(<circle key={key()} cx={you[0]} cy={you[1]} r={13} fill={C.accent} opacity={0.28} />);
    els.push(<circle key={key()} cx={you[0]} cy={you[1]} r={6.5} fill={C.accent} stroke="#fff" strokeWidth={2.5} />);
  }

  return (
    <div ref={box} className="absolute inset-x-0" style={{ top: insetTop, bottom: insetBottom }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="w-full h-full" role="img" aria-label={`Subway diagram of ${route.name}`}>
        <g fontFamily="-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif">{els}</g>
      </svg>
    </div>
  );
}
