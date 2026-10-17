import { useT, PHASE_LABELS } from '../theme';
import { formatMinSec } from '../lib/format';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = 864e5;
const n1 = (v: number) => (isFinite(v) ? Math.round(v * 10) / 10 : 0);

/** Strategy code in its colour ("1A"), like a subway bullet. */
export function RouteBadge({ code, color, size = 22, muted = false }: { code: string; color: string; size?: number; muted?: boolean }) {
  return (
    <span
      className="inline-flex items-center justify-center rounded-full font-bold shrink-0 tnum"
      style={{ width: size, height: size, backgroundColor: color, color: '#0B0D12', fontSize: size * 0.45, opacity: muted ? 0.45 : 1 }}
      aria-label={`Route ${code}`}
    >
      {code}
    </span>
  );
}

export const kindsOf = (phases: any[]) => {
  let seen = false;
  return phases.map((p) => {
    const k = typeof p === 'string' ? p : p.kind;
    if (k !== 'wait') return k;
    const out = seen ? 'transfer' : 'wait';
    seen = true;
    return out;
  });
};

/** Thin timeline of phases, labelled underneath (Bike 7:46 · Wait 3:10 · ...). */
export function PhaseStrip({ segs, dashedLast = false, labels = true }: { segs: { kind: string; sec: number; label?: string }[]; dashedLast?: boolean; labels?: boolean }) {
  const T = useT();
  const total = segs.reduce((a, s) => a + Math.max(0, s.sec), 0) || 1;
  return (
    <div className="w-full" role="img" aria-label="Phase timeline">
      <div className="flex gap-[3px] h-2.5">
        {segs.map((s, i) => (
          <div
            key={i}
            className="rounded-full"
            style={{
              flexGrow: Math.max(0.0001, s.sec / total),
              flexBasis: 0,
              background: dashedLast && i === segs.length - 1
                ? `repeating-linear-gradient(90deg, ${T.phase[s.kind as keyof typeof T.phase] ?? T.phase.train} 0 7px, transparent 7px 11px)`
                : T.phase[s.kind as keyof typeof T.phase] ?? T.phase.train,
            }}
            title={`${s.label ?? PHASE_LABELS[s.kind]} ${formatMinSec(s.sec)}`}
          />
        ))}
      </div>
      {labels && (
        <div className="flex gap-[3px] mt-1.5">
          {segs.map((s, i) => {
            const share = s.sec / total;
            return (
              <div key={i} className="min-w-0 overflow-hidden whitespace-nowrap text-[11px] tnum" style={{ flexGrow: Math.max(0.0001, share), flexBasis: 0, color: T.secondaryLabel }}>
                {share >= 0.2 && <>{s.label ?? PHASE_LABELS[s.kind]} </>}
                {share >= 0.085 && <b style={{ color: T.label }}>{formatMinSec(s.sec)}</b>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Race your ghost: one lane per option still possible. The hollow ring is where your typical
 * commute would be right now; the solid dot is you; the bar between them is your lead or deficit.
 */
export function GhostRace({ lanes, route, started }: { lanes: any[]; route: any; started: boolean }) {
  const T = useT();
  if (!lanes.length) return null;
  const W = 360, laneH = 10, gap = 30, top = 22, left = 34, right = 54;
  const H = top + lanes.length * (laneH + gap) - gap + 12;
  const maxT = Math.max(60, ...lanes.map((l) => Math.max(l.typical, l.elapsed))) * 1.04;
  const plotW = W - left - right;
  const X = (sec: number) => n1(left + (Math.min(Math.max(0, sec), maxT) / maxT) * plotW);
  const strat = (id: string) => route.strategies.find((s: any) => s.id === id);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Race against your typical commute">
      {started && <line x1={X(lanes[0].elapsed)} x2={X(lanes[0].elapsed)} y1={top - 14} y2={H - 4} stroke={T.tertiaryLabel} strokeDasharray="2 3" />}
      {lanes.map((l, i) => {
        const y = top + i * (laneH + gap);
        const cy = y + laneH / 2;
        const s = strat(l.id);
        const kinds = kindsOf(l.kinds);
        let acc = 0;
        const xy = X(l.progress);
        const xg = X(l.elapsed);
        const behind = l.delta > 0.5;
        return (
          <g key={l.id}>
            <circle cx={13} cy={cy} r={11} fill={s?.color ?? '#94a3b8'} />
            <text x={13} y={cy + 3.6} textAnchor="middle" fontSize={9} fontWeight={800} fill="#0B0D12">{l.id}</text>
            {kinds.map((k: string, j: number) => {
              const x = X(acc);
              const w = X(acc + l.secs[j]) - x;
              acc += l.secs[j];
              return <rect key={j} x={x} y={y} width={Math.max(0.4, w - 1)} height={laneH} rx={3} fill={T.phase[k as keyof typeof T.phase]} opacity={0.45}><title>{PHASE_LABELS[k]}: typically {formatMinSec(l.secs[j])}</title></rect>;
            })}
            <line x1={X(l.typical)} x2={X(l.typical)} y1={y - 4} y2={y + laneH + 4} stroke={T.label} strokeWidth={1.5} />
            <text x={X(l.typical)} y={y - 7} textAnchor="middle" fontSize={9.5} fill={T.secondaryLabel} className="tnum">{formatMinSec(l.typical)}</text>
            {started && Math.abs(xg - xy) > 0.6 && <rect x={Math.min(xy, xg)} y={cy - 1.75} width={Math.abs(xg - xy)} height={3.5} rx={1.75} fill={behind ? T.statusDelayed : T.statusPositive} />}
            {started && <circle cx={xg} cy={cy} r={5} fill="none" stroke={T.label} strokeWidth={2}><title>Your typical commute is here now</title></circle>}
            <circle cx={xy} cy={cy} r={6.5} fill={s?.color ?? T.accent} stroke={T.elevatedSheet} strokeWidth={1.5}><title>You</title></circle>
            <text x={W - 2} y={cy + 4} textAnchor="end" fontSize={11.5} fontWeight={700} className="tnum" fill={!started ? T.secondaryLabel : behind ? T.statusDelayed : T.statusPositive}>
              {!started ? 'ready' : `${behind ? '+' : '−'}${formatMinSec(Math.abs(l.delta))}`}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Head-to-head: how often the row's trips beat the column's, over every pair of trips. */
export function WinGrid({ route, matrix }: { route: any; matrix: (number | null)[][] }) {
  const T = useT();
  const ss = route.strategies;
  return (
    <div className="overflow-x-auto no-scrollbar">
      <table className="w-full border-separate text-[12px] tnum" style={{ borderSpacing: 4 }}>
        <thead>
          <tr>
            <th className="text-left font-semibold pr-1" style={{ color: T.tertiaryLabel, fontSize: 10.5 }}>beats →</th>
            {ss.map((s: any) => (
              <th key={s.id} className="font-semibold"><RouteBadge code={s.id} color={s.color} size={20} /></th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ss.map((a: any, i: number) => (
            <tr key={a.id}>
              <th className="text-left"><RouteBadge code={a.id} color={a.color} size={20} /></th>
              {ss.map((b: any, j: number) => {
                const v = matrix[i]?.[j];
                if (v == null || !isFinite(v)) return <td key={b.id} className="rounded-[8px] text-center py-2" style={{ backgroundColor: T.tertiarySystemBackground, color: T.tertiaryLabel }}>—</td>;
                const good = v >= 0.5;
                const strength = Math.min(1, Math.abs(v - 0.5) * 2);
                return (
                  <td
                    key={b.id}
                    className="rounded-[8px] text-center py-2 font-bold"
                    style={{ backgroundColor: good ? `rgba(48, 209, 88, ${0.1 + strength * 0.35})` : `rgba(255, 69, 58, ${0.1 + strength * 0.35})`, color: T.label }}
                    title={`Route ${a.id} beats Route ${b.id} in ${Math.round(v * 100)}% of trip pairs`}
                  >
                    {Math.round(v * 100)}%
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function niceTicks(min: number, max: number, count = 5) {
  const span = max - min || 1;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? step0;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

/** Rolling-median route time per option over calendar time. */
export function TrendChart({ series, window = 5 }: { series: { id: string; color: string; points: [number, number][] }[]; window?: number }) {
  const T = useT();
  const all = series.flatMap((s) => s.points);
  if (all.length < 4) return <p className="text-[12.5px]" style={{ color: T.secondaryLabel }}>Log a few more trips to see a trend.</p>;
  const W = 360, H = 180, L = 30, B = 26, Tp = 10, R = 8;
  const t0 = Math.min(...all.map((p) => p[0]));
  const t1 = Math.max(...all.map((p) => p[0]));
  const ys = all.map((p) => p[1] / 60);
  const ylo = Math.floor(Math.min(...ys)) - 1;
  const yhi = Math.ceil(Math.max(...ys)) + 1;
  const X = (t: number) => n1(L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R));
  const Y = (m: number) => n1(Tp + (1 - (m - ylo) / (yhi - ylo)) * (H - Tp - B));
  const d = new Date(t0);
  const months: number[] = [];
  for (let k = 0; k < 24; k++) {
    const m = new Date(d.getFullYear(), d.getMonth() + k, 1, 12).getTime();
    if (m > t1) break;
    if (m >= t0) months.push(m);
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Rolling median route time over time">
      {niceTicks(ylo, yhi, 4).map((t) => (
        <g key={t}>
          <line x1={L} x2={W - R} y1={Y(t)} y2={Y(t)} stroke={T.separator} />
          <text x={L - 6} y={Y(t) + 3} textAnchor="end" fontSize={10} fill={T.tertiaryLabel} className="tnum">{t}</text>
        </g>
      ))}
      {months.map((m) => (
        <g key={m}>
          <line x1={X(m)} x2={X(m)} y1={Tp} y2={H - B} stroke={T.separator} strokeDasharray="2 3" />
          <text x={X(m)} y={H - 9} textAnchor="middle" fontSize={10} fill={T.tertiaryLabel}>{MONTHS[new Date(m).getMonth()]}</text>
        </g>
      ))}
      {series.map((s) => {
        const pts = s.points.slice().sort((a, b) => a[0] - b[0]);
        const line = pts.map((p, i) => {
          const win = pts.slice(Math.max(0, i - window + 1), i + 1).map((q) => q[1]).sort((a, b) => a - b);
          const med = win.length % 2 ? win[(win.length - 1) / 2] : (win[win.length / 2 - 1] + win[win.length / 2]) / 2;
          return `${X(p[0])},${Y(med / 60)}`;
        });
        return (
          <g key={s.id}>
            {pts.map(([t, v], i) => <circle key={i} cx={X(t)} cy={Y(v / 60)} r={1.8} fill={s.color} opacity={0.3} />)}
            {pts.length >= 3 && <polyline points={line.join(' ')} fill="none" stroke={s.color} strokeWidth={2.4} strokeLinejoin="round" strokeLinecap="round" />}
          </g>
        );
      })}
      <text x={W - 2} y={Tp + 2} textAnchor="end" fontSize={10} fill={T.tertiaryLabel}>min</text>
    </svg>
  );
}

/**
 * GitHub-style commute calendar: one column per week, one row per weekday. Each day shows the
 * option taken (colour) and how it went against that option's median (brighter = faster).
 */
export function CommuteCalendar({ cells, onOpen }: { cells: { t: number; id: string; color: string; opacity: number; title: string }[]; onOpen: (id: string) => void }) {
  const T = useT();
  if (!cells.length) return null;
  const dayKey = (t: number) => { const d = new Date(t); d.setHours(12, 0, 0, 0); return d.getTime(); };
  const mondayOf = (t: number) => { const d = new Date(dayKey(t)); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };
  const first = mondayOf(Math.min(...cells.map((c) => c.t)));
  const last = mondayOf(Math.max(...cells.map((c) => c.t), Date.now()));
  const nWeeks = Math.round((last - first) / (7 * DAY)) + 1;
  const weekend = cells.some((c) => [0, 6].includes(new Date(c.t).getDay()));
  const rows = weekend ? 7 : 5;
  const S = 13, G = 3, Lm = 16, Tm = 15;
  const W = Lm + nWeeks * (S + G);
  const H = Tm + rows * (S + G);
  const byDay = new Map<number, any>();
  for (const c of cells) {
    const k = dayKey(c.t);
    const prev = byDay.get(k);
    if (!prev) byDay.set(k, { ...c, extra: 0 });
    else byDay.set(k, c.t > prev.t ? { ...c, extra: prev.extra + 1 } : { ...prev, extra: prev.extra + 1 });
  }
  const today = dayKey(Date.now());
  const weeks = Array.from({ length: nWeeks }, (_, w) => w);
  let lastMonth = -1;
  return (
    <div className="overflow-x-auto no-scrollbar">
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: Math.max(W, 220), maxWidth: '100%', height: 'auto' }} role="img" aria-label="Commute calendar">
        {['M', '', 'W', '', 'F', '', 'S'].slice(0, rows).map((d, i) => d && <text key={i} x={0} y={Tm + i * (S + G) + S - 3} fontSize={9} fill={T.tertiaryLabel}>{d}</text>)}
        {weeks.map((w) => {
          const m = new Date(first + w * 7 * DAY).getMonth();
          const label = m !== lastMonth && w < nWeeks - 1 ? MONTHS[m] : null;
          if (m !== lastMonth) lastMonth = m;
          return (
            <g key={w}>
              {label && <text x={Lm + w * (S + G)} y={10} fontSize={9} fill={T.tertiaryLabel}>{label}</text>}
              {Array.from({ length: rows }, (_, i) => <rect key={i} x={Lm + w * (S + G)} y={Tm + i * (S + G)} width={S} height={S} rx={3} fill={T.tertiarySystemBackground} />)}
            </g>
          );
        })}
        {[...byDay].map(([k, c]) => {
          const days = Math.round((k - first) / DAY);
          const w = Math.floor(days / 7);
          const i = days - w * 7;
          const x = Lm + w * (S + G);
          const y = Tm + i * (S + G);
          return (
            <g key={k} onClick={() => onOpen(c.id)} style={{ cursor: 'pointer' }}>
              <rect x={x} y={y} width={S} height={S} rx={3} fill={c.color} fillOpacity={Math.max(0.25, Math.min(1, c.opacity))} stroke={k === today ? T.label : 'none'} strokeWidth={1.5}>
                <title>{`${c.title}${c.extra ? ` (+${c.extra} more that day)` : ''}`}</title>
              </rect>
              {c.extra > 0 && <circle cx={x + S - 2.5} cy={y + 2.5} r={1.8} fill={T.label} />}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
