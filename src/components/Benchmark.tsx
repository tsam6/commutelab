import { Activity, ChevronDown, Sparkles } from 'lucide-react';
import { useT } from '../theme';
import { formatMinSec, formatMinutesDecimal, pct } from '../lib/format';
import { stationName, type RouteStats } from '../lib/runs';
import { TrendChart, WinGrid, RouteBadge } from './charts';

type Props = {
  route: any;
  destName: string;
  runs: any[];
  allCount: number;
  filter: 'all' | 'mine' | 'gps';
  setFilter: (f: 'all' | 'mine' | 'gps') => void;
  stats: Record<string, RouteStats>;
  winnerId: string | null;
  insight: any;
  matrix: (number | null)[][];
  onSwitch: () => void;
  onSeed: () => void;
  onLive: () => void;
};

export default function Benchmark(p: Props) {
  const T = useT();
  const { route, stats } = p;
  const card = { backgroundColor: T.secondarySystemBackground, borderColor: T.separator };
  const S = (id: string) => route.strategies.find((s: any) => s.id === id);
  const w = p.winnerId ? stats[p.winnerId] : null;
  const ranked = route.strategies
    .map((s: any) => s.id)
    .filter((id: string) => isFinite(stats[id]?.medianSec))
    .sort((a: string, b: string) => stats[a].medianSec * 0.65 + stats[a].p90Sec * 0.35 - (stats[b].medianSec * 0.65 + stats[b].p90Sec * 0.35));
  const runner = ranked.find((id: string) => id !== p.winnerId);
  const r = runner ? stats[runner] : null;

  const narrative = (() => {
    if (!w || !r || !p.winnerId) return 'Only one way to get there so far. Add another option to compare.';
    const ws = S(p.winnerId);
    const origin = stationName(route, ws.legs[0].from);
    const bike = w.avgBikeSec - r.avgBikeSec;
    const wait = r.avgWaitSec - w.avgWaitSec;
    const train = r.avgTrainSec - w.avgTrainSec;
    const parts = [];
    if (wait > 20) parts.push(<span key="w">cuts platform waiting by <b style={{ color: T.label }}>{formatMinutesDecimal(wait)}</b></span>);
    if (train > 20) parts.push(<span key="t">saves <b style={{ color: T.label }}>{formatMinutesDecimal(train)}</b> on the train</span>);
    if (bike < -20) parts.push(<span key="b">is <b style={{ color: T.label }}>{formatMinutesDecimal(-bike)}</b> shorter on the bike</span>);
    const spread = w.p90Sec - w.p10Sec < r.p90Sec - r.p10Sec;
    return (
      <>
        {bike > 20 ? (
          <>Even though biking to {origin} takes <b style={{ color: T.label }}>+{formatMinutesDecimal(bike)} longer</b> on average, Route {p.winnerId} </>
        ) : (
          <>Route {p.winnerId} </>
        )}
        {parts.length ? parts.reduce((acc: any[], el, i) => (i ? [...acc, i === parts.length - 1 ? ' and ' : ', ', el] : [el]), []) : 'edges out the others on the median'}
        {` compared with Route ${runner}`}
        {spread ? ', with a tighter spread on bad days.' : '.'}
      </>
    );
  })();

  const maxTotal = Math.max(60, ...route.strategies.map((s: any) => (stats[s.id]?.avgBikeSec ?? 0) + (stats[s.id]?.avgWaitSec ?? 0) + (stats[s.id]?.avgTrainSec ?? 0)));
  const g = p.insight?.gamble;
  const l = p.insight?.lights;

  const series = route.strategies.map((s: any) => ({ id: s.id, color: s.color, points: p.runs.filter((x) => x.strategyId === s.id).map((x) => [x.t0, x.metrics.total] as [number, number]) }));

  return (
    <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-[24px] font-bold tracking-tight leading-tight">Home → {p.destName}</h1>
          <p style={{ color: T.secondaryLabel }} className="text-[13px]">
            Benchmark from {route.docks[0].own ? 'your bike' : route.docks[0].name} (T=00:00) to {stationName(route, route.destination)}.
          </p>
        </div>
        <button type="button" onClick={p.onSwitch} style={{ backgroundColor: T.tertiarySystemBackground, color: T.label }} className="h-8 px-3 rounded-full text-[11.5px] font-semibold flex items-center gap-1 shrink-0 active:scale-95">
          <span>Switch X</span>
          <ChevronDown className="w-3.5 h-3.5" />
        </button>
      </div>

      <div style={{ backgroundColor: T.tertiarySystemBackground }} className="inline-flex rounded-[8px] p-0.5" role="group" aria-label="Which trips to include">
        {([
          ['all', `All trips (${p.allCount})`],
          ['mine', 'Recorded'],
          ['gps', 'Real GPS'],
        ] as const).map(([k, label]) => (
          <button key={k} type="button" onClick={() => p.setFilter(k)} style={{ backgroundColor: p.filter === k ? T.secondarySystemBackground : 'transparent', color: p.filter === k ? T.label : T.secondaryLabel }} className="px-2.5 py-1 rounded-[6px] text-[11.5px] font-semibold">
            {label}
          </button>
        ))}
      </div>

      {p.runs.length === 0 ? (
        <div style={card} className="p-6 rounded-[16px] border text-center space-y-4">
          <div style={{ backgroundColor: T.accentSubtle, color: T.accent }} className="w-12 h-12 rounded-full mx-auto flex items-center justify-center">
            <Activity className="w-6 h-6" />
          </div>
          <div className="space-y-1">
            <h3 className="text-[18px] font-bold">No Benchmark Trips Logged Yet</h3>
            <p style={{ color: T.secondaryLabel }} className="text-[13px] leading-relaxed">
              {p.filter === 'all' ? (
                <>
                  <b style={{ color: T.label }}>Home → {p.destName}</b> has a clean ledger. Start a trip in the Corridor tab, or fill it with sample trips the simulator makes from the real schedule.
                </>
              ) : (
                'None of your trips match this filter yet.'
              )}
            </p>
          </div>
          {p.filter === 'all' && (
            <div className="space-y-2 pt-1">
              <button type="button" onClick={p.onSeed} style={{ backgroundColor: T.accent }} className="w-full h-11 rounded-full text-white font-semibold text-[14px] flex items-center justify-center gap-2">
                <Sparkles className="w-4 h-4" />
                <span>Generate 42 Sample Trips</span>
              </button>
              <button type="button" onClick={p.onLive} style={{ backgroundColor: T.tertiarySystemBackground, color: T.label }} className="w-full h-11 rounded-full font-semibold text-[14px]">
                Go to Live Corridor
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          {/* RECOMMENDED DEFAULT */}
          {w && p.winnerId && (
            <div style={card} className="p-4 rounded-[16px] border space-y-3">
              <div className="flex items-center justify-between gap-2">
                <span style={{ backgroundColor: T.accentSubtle, color: T.accent }} className="text-[11px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full">
                  Recommended Default · Route {p.winnerId}
                </span>
                <span style={{ color: T.secondaryLabel }} className="text-[12px] font-medium tnum">{p.runs.length} trips</span>
              </div>
              <div className="flex items-center gap-2">
                <RouteBadge code={p.winnerId} color={S(p.winnerId).color} size={24} />
                <div className="text-[18px] font-bold tracking-tight">{S(p.winnerId).desc}</div>
              </div>
              <p style={{ color: T.secondaryLabel }} className="text-[13px] leading-relaxed">{narrative}</p>
              <div style={{ backgroundColor: T.tertiarySystemBackground }} className="grid grid-cols-3 gap-2 p-3 rounded-[12px] text-center tnum">
                {[
                  ['Median (P50)', formatMinutesDecimal(w.medianSec), T.label],
                  ['Bad day (P90)', formatMinutesDecimal(w.p90Sec), T.label],
                  ['Variance (±SD)', `±${formatMinutesDecimal(w.stdDevSec)}`, T.statusPositive],
                ].map(([k, v, c]) => (
                  <div key={k}>
                    <div style={{ color: T.secondaryLabel }} className="text-[11px]">{k}</div>
                    <div style={{ color: c }} className="text-[17px] font-bold mt-0.5">{v}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* PHASE BREAKDOWN */}
          <div style={card} className="p-4 rounded-[16px] border space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-[16px] font-semibold">Phase-by-Phase Breakdown</h2>
              <div className="flex items-center gap-3 text-[11px]">
                {[
                  ['Bike', T.phase.bike],
                  ['Wait', T.phase.wait],
                  ['Train', T.phase.train],
                ].map(([k, c]) => (
                  <span key={k} className="flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ backgroundColor: c }} />{k}</span>
                ))}
              </div>
            </div>
            {route.strategies.map((s: any) => {
              const st = stats[s.id];
              if (!st) return null;
              const total = st.avgBikeSec + st.avgWaitSec + st.avgTrainSec;
              const w2 = (v: number) => `${(v / maxTotal) * 100}%`;
              return (
                <div key={s.id} className="space-y-1.5">
                  <div className="flex items-center justify-between text-[13px] gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <RouteBadge code={s.id} color={s.color} size={20} />
                      <span style={{ color: T.secondaryLabel }} className="text-[12px] truncate">{s.desc}</span>
                    </div>
                    <span className="font-bold tnum">{formatMinutesDecimal(total)}</span>
                  </div>
                  <div style={{ backgroundColor: T.tertiarySystemBackground }} className="w-full h-3.5 rounded-full overflow-hidden flex">
                    <div style={{ width: w2(st.avgBikeSec), backgroundColor: T.phase.bike }} title="Bike" />
                    <div style={{ width: w2(st.avgWaitSec), backgroundColor: T.phase.wait }} title="Platform waits" />
                    <div style={{ width: w2(st.avgTrainSec), backgroundColor: T.phase.train }} title="On the train" />
                  </div>
                  <div style={{ color: T.secondaryLabel }} className="flex items-center justify-between text-[11px] tnum">
                    <span>Bike {formatMinutesDecimal(st.avgBikeSec)}</span>
                    <span>Wait {formatMinutesDecimal(st.avgWaitSec)}</span>
                    <span>Train {formatMinutesDecimal(st.avgTrainSec)}</span>
                    <span>±{formatMinutesDecimal(st.stdDevSec)} SD</span>
                  </div>
                  {st.estimated && <div style={{ color: T.tertiaryLabel }} className="text-[10.5px]">Estimated from the schedule until you log 2 trips on this route.</div>}
                </div>
              );
            })}
          </div>

          {/* HEAD TO HEAD */}
          {route.strategies.length > 1 && (
            <div style={card} className="p-4 rounded-[16px] border space-y-2">
              <h2 className="text-[16px] font-semibold">Head-to-Head Win Rate</h2>
              <p style={{ color: T.secondaryLabel }} className="text-[12px]">How often the row's trips beat the column's, comparing every pair of trips.</p>
              <WinGrid route={route} matrix={p.matrix} />
            </div>
          )}

          {/* TREND */}
          <div style={card} className="p-4 rounded-[16px] border space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-[16px] font-semibold">Trend</h2>
              <div className="flex items-center gap-2">
                {route.strategies.map((s: any) => (
                  <span key={s.id} className="flex items-center gap-1 text-[11px] tnum" style={{ color: T.secondaryLabel }}>
                    <span className="w-2.5 h-1 rounded-full" style={{ backgroundColor: s.color }} />
                    {s.id}
                  </span>
                ))}
              </div>
            </div>
            <p style={{ color: T.secondaryLabel }} className="text-[12px]">Rolling median of the last 5 trips on each route, in minutes.</p>
            <TrendChart series={series} />
          </div>

          {/* QUIRK FINDINGS */}
          {(g?.enough || (l?.enough && l.fit)) && (
            <div className="space-y-3 pb-4">
              <h2 className="text-[16px] font-semibold">Corridor Quirk Findings ({p.destName})</h2>
              {g?.enough && (
                <div style={card} className="p-4 rounded-[16px] border space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[14px] font-semibold">1. {stationName(route, g.cfg.at)} Local Gamble ({g.cfg.strategy} vs {g.cfg.alt})</span>
                    <span style={{ backgroundColor: T.accentSubtle, color: T.accent }} className="text-[11px] font-bold px-2 py-0.5 rounded-full shrink-0 tnum">{pct(g.winRate)} WIN RATE</span>
                  </div>
                  <p style={{ color: T.secondaryLabel }} className="text-[12.5px] leading-relaxed">
                    From {stationName(route, g.cfg.from)}, taking the express and changing to the local at {stationName(route, g.cfg.at)} beats staying on Route {g.cfg.alt} in {pct(g.winRate)} of trips, saving{' '}
                    <b style={{ color: T.label }}>{formatMinSec(g.avgGain)}</b> when it works and costing <b style={{ color: T.label }}>{formatMinSec(g.avgLoss)}</b> when it does not. As long as the local arrives within{' '}
                    <b style={{ color: T.label }}>{formatMinSec(g.breakeven)}</b>, Route {g.cfg.strategy} wins.
                  </p>
                </div>
              )}
              {l?.enough && l.fit && (() => {
                const with3 = (stats[l.cfg.strategy]?.medianSec ?? 0) + (3 - l.redMean) * l.fit.slope;
                const best = l.cfg.compare.map((id: string) => ({ id, m: stats[id]?.medianSec })).filter((x: any) => isFinite(x.m)).sort((a: any, b: any) => a.m - b.m)[0];
                return (
                  <div style={card} className="p-4 rounded-[16px] border space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[14px] font-semibold">{g?.enough ? 2 : 1}. {stationName(route, S(l.cfg.strategy).legs[0].from)} Red-Light Sensitivity</span>
                      <span style={{ backgroundColor: T.tertiarySystemBackground, color: T.label }} className="text-[11px] font-semibold px-2 py-0.5 rounded-full shrink-0 tnum">~{Math.round(l.fit.slope)}s / LIGHT</span>
                    </div>
                    <p style={{ color: T.secondaryLabel }} className="text-[12.5px] leading-relaxed">
                      Each red light on the bike ride to {stationName(route, S(l.cfg.strategy).legs[0].from)} adds <b style={{ color: T.label }}>~{Math.round(l.fit.slope)}s</b> (r = {l.fit.r.toFixed(2)}).
                      {best && (
                        <>
                          {' '}With 3 red lights, Route {l.cfg.strategy} would take about <b style={{ color: T.label }}>{formatMinSec(with3)}</b>, which {with3 <= best.m ? 'still beats' : 'loses to'} Route {best.id}'s median of {formatMinSec(best.m)}.
                        </>
                      )}
                    </p>
                  </div>
                );
              })()}
            </div>
          )}
        </>
      )}
    </div>
  );
}
