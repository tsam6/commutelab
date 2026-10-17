import { useEffect, useMemo, useRef } from 'react';
import { ChevronRight, Plus } from 'lucide-react';
import { useT } from '../theme';
import { formatMinSec } from '../lib/format';
import type { RunView } from '../lib/runs';
import { stats } from '../engine/analytics.js';
import { CommuteCalendar, RouteBadge } from './charts';

type Props = {
  route: any;
  destName: string;
  runs: RunView[];
  filter: string;
  setFilter: (f: string) => void;
  focusId: string | null;
  onOpen: (r: RunView) => void;
  onNew: () => void;
  onSeed: () => void;
};

export default function Ledger(p: Props) {
  const T = useT();
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const shown = useMemo(() => (p.filter === 'ALL' ? p.runs : p.runs.filter((r) => r.code === p.filter)), [p.runs, p.filter]);

  // Calendar: colour = route taken, brightness = how the day went against that route's spread.
  const cells = useMemo(() => {
    const spread: Record<string, any> = {};
    for (const s of p.route.strategies) spread[s.id] = stats(p.runs.filter((r) => r.code === s.id).map((r) => r.total));
    return p.runs.map((r) => {
      const st = r.code ? spread[r.code] : null;
      const rel = st && st.n > 2 && st.p90 > st.p10 ? (st.p90 - r.total) / (st.p90 - st.p10) : 0.6;
      return {
        t: r.t0,
        id: r.id,
        color: r.color,
        opacity: 0.3 + 0.7 * Math.max(0, Math.min(1, rel)),
        title: `${r.date} ${r.time} · Route ${r.code ?? '?'} · ${formatMinSec(r.total)}`,
      };
    });
  }, [p.runs, p.route]);

  useEffect(() => {
    if (!p.focusId) return;
    rowRefs.current.get(p.focusId)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [p.focusId, p.filter]);

  const openFromCalendar = (id: string) => {
    const run = p.runs.find((r) => r.id === id);
    if (!run) return;
    if (p.filter !== 'ALL' && p.filter !== run.code) p.setFilter('ALL');
    p.onOpen(run);
  };

  return (
    <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-[24px] font-bold tracking-tight leading-tight">{p.destName} Ledger</h1>
          <p style={{ color: T.secondaryLabel }} className="text-[13px]">
            {p.runs.length} trips for Home → {p.destName}.
          </p>
        </div>
        <button type="button" onClick={p.onNew} style={{ backgroundColor: T.accentSubtle, color: T.accent }} className="h-9 px-3.5 rounded-full text-[12px] font-bold flex items-center gap-1.5 active:scale-95 shrink-0">
          <Plus className="w-3.5 h-3.5" />
          <span>New Dest (X)</span>
        </button>
      </div>

      {p.runs.length > 0 && (
        <div style={{ backgroundColor: T.secondarySystemBackground, borderColor: T.separator }} className="p-4 rounded-[16px] border space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-[15px] font-semibold">Commute Calendar</h2>
            <span style={{ color: T.tertiaryLabel }} className="text-[11px]">brighter = faster than usual</span>
          </div>
          <CommuteCalendar cells={cells} onOpen={openFromCalendar} />
          <div className="flex flex-wrap gap-2 pt-1">
            {p.route.strategies.map((s: any) => (
              <span key={s.id} className="flex items-center gap-1 text-[11px]" style={{ color: T.secondaryLabel }}>
                <span className="w-2.5 h-2.5 rounded-[3px]" style={{ backgroundColor: s.color }} /> Route {s.id}
              </span>
            ))}
            <span style={{ color: T.tertiaryLabel }} className="text-[11px]">· tap a day to open it</span>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
        {['ALL', ...p.route.strategies.map((s: any) => s.id)].map((f) => {
          const active = p.filter === f;
          return (
            <button key={f} type="button" onClick={() => p.setFilter(f)} style={{ backgroundColor: active ? T.accent : T.secondarySystemBackground, borderColor: active ? T.accent : T.separator, color: active ? '#FFFFFF' : T.secondaryLabel }} className="px-3.5 py-1.5 rounded-full border text-[12px] font-bold shrink-0">
              {f === 'ALL' ? 'All Trips' : `Route ${f}`}
            </button>
          );
        })}
      </div>

      {shown.length === 0 ? (
        <div style={{ backgroundColor: T.secondarySystemBackground, borderColor: T.separator }} className="p-6 rounded-[16px] border text-center space-y-3">
          <p style={{ color: T.secondaryLabel }} className="text-[13px]">No trips for this filter on Home → {p.destName}.</p>
          {p.runs.length === 0 && (
            <button type="button" onClick={p.onSeed} style={{ backgroundColor: T.accent }} className="px-4 py-2 rounded-full text-white text-[12.5px] font-semibold">
              Generate 42 Sample Trips
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-2.5 pb-4">
          {shown.map((run) => {
            const focused = p.focusId === run.id;
            return (
              <button
                key={run.id}
                ref={(el) => {
                  if (el) rowRefs.current.set(run.id, el);
                  else rowRefs.current.delete(run.id);
                }}
                type="button"
                onClick={() => p.onOpen(run)}
                style={{ backgroundColor: focused ? T.accentSubtle : T.secondarySystemBackground, borderColor: focused ? T.accent : T.separator }}
                className="w-full p-4 rounded-[16px] border text-left flex items-center justify-between gap-2 active:scale-[0.99] transition-transform"
              >
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2">
                    {run.code ? <RouteBadge code={run.code} color={run.color} size={22} /> : <span className="text-[11px] font-bold">?</span>}
                    <span className="text-[13px] font-semibold truncate">
                      {run.date} · {run.time}
                    </span>
                    {run.source !== 'history' && (
                      <span style={{ backgroundColor: run.source === 'live' ? T.accentSubtle : T.tertiarySystemBackground, color: run.source === 'live' ? T.accent : T.secondaryLabel }} className="text-[9.5px] font-bold px-1.5 py-0.5 rounded-full shrink-0">
                        {run.source === 'live' ? 'GPS' : 'SIM'}
                      </span>
                    )}
                  </div>
                  <div style={{ color: T.secondaryLabel }} className="text-[12px] flex items-center gap-3 tnum">
                    <span>Bike {formatMinSec(run.bike)}</span>
                    <span>Wait {formatMinSec(run.wait)}</span>
                    <span>Train {formatMinSec(run.train)}</span>
                  </div>
                  <div className="flex items-center gap-2 pt-0.5 flex-wrap">
                    {run.crawl && <span style={{ color: T.statusDelayed }} className="text-[11px] font-semibold">Slow first train ({run.firstTrainMph.toFixed(1)} mph)</span>}
                    {run.gambleWon != null && (
                      <span style={{ color: run.gambleWon ? T.statusPositive : T.statusDelayed }} className="text-[11px] font-semibold">
                        {run.gambleWon ? 'Local Gamble Won' : 'Missed the Quick Local'}
                      </span>
                    )}
                    {run.redLights > 0 && (
                      <span style={{ color: T.secondaryLabel }} className="text-[11px]">
                        {run.redLights} red light{run.redLights > 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <div className="text-right">
                    <div className="text-[18px] font-bold tnum">{formatMinSec(run.total)}</div>
                    <div style={{ color: T.tertiaryLabel }} className="text-[10.5px] tnum">+{formatMinSec(run.buffer)} walk</div>
                  </div>
                  <ChevronRight className="w-4 h-4" style={{ color: T.tertiaryLabel }} />
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
