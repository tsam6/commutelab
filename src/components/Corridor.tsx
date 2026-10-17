import { useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Coffee, Gauge, LocateFixed, Map as MapIcon, Play, Radio, RotateCcw, SkipForward, Square, Timer, TrafficCone, TrainFront, X } from 'lucide-react';
import { useT, PHASE_LABELS } from '../theme';
import { formatMinSec, formatMinutesDecimal, signed, toMph, timeLabel } from '../lib/format';
import { legLineName, stationName, type RouteStats } from '../lib/runs';
import type { Trip } from '../hooks/useTrip';
import type { Geo, Scene } from '../lib/live';
import { pathLength } from '../engine/geo.js';
import StreetMap from './StreetMap';
import DiagramMap from './DiagramMap';
import { GhostRace, PhaseStrip, RouteBadge } from './charts';

type Props = {
  route: any;
  destName: string;
  trip: Trip;
  scene: Scene;
  geo: Record<string, Geo>;
  stats: Record<string, RouteStats>;
  winnerId: string | null;
  profiles: Record<string, any>;
  insight: any;
  homeLabel: string;
  mapMode: 'street' | 'diagram';
  setMapMode: (m: 'street' | 'diagram') => void;
};

export default function Corridor(p: Props) {
  const T = useT();
  const { route, trip, scene } = p;
  const [detent, setDetent] = useState<'PEEK' | 'HALF' | 'FULL'>('HALF');
  const [follow, setFollow] = useState(false);
  const snap = trip.snap;
  const running = trip.status === 'running';
  const started = scene.started;
  const state = snap?.state ?? 'idle';
  const sel = trip.simStrategy ?? route.strategies[0]?.id;
  const lead = scene.lead;
  const lane = scene.lane;
  const strat = (id: string) => route.strategies.find((s: any) => s.id === id);

  const waits = snap?.phases?.filter((x: any) => x.kind === 'wait') ?? [];
  const trains = snap?.phases?.filter((x: any) => x.kind === 'train') ?? [];
  const curStation = snap?.phase?.station ? stationName(route, snap.phase.station) : '';
  const underground = (() => {
    if (state !== 'train' || !snap?.phase) return false;
    const leg = lead?.legs?.[trains.length - 1];
    const ids = leg ? [leg.from, leg.to] : [];
    return ids.every((id) => route.stations.find((s: any) => s.id === id)?.structure === 'subway');
  })();

  const status = (() => {
    if (state === 'idle') return `${p.homeLabel} · Standby`;
    if (state === 'buffer') return 'Walk buffer (not counted)';
    if (state === 'bike') return snap.heading ? `Biking toward ${snap.heading.name}` : 'Biking · T=0 started';
    if (state === 'wait') return waits.length > 1 ? `Transfer at ${curStation}` : `Waiting at ${curStation}`;
    if (state === 'train') return `On the ${legLineName(route, lead, trains.length - 1)}`;
    return `Arrived · ${stationName(route, snap.record?.path?.[snap.record.path.length - 1])}`;
  })();

  // next stop on the current train, with a rough ETA
  const nextStop = (() => {
    if (state !== 'train' || !lead) return null;
    const leg = lead.legs[trains.length - 1];
    const line = route.lines.find((l: any) => l.id === leg?.lines?.[0]);
    if (!line) return null;
    const i = line.stations.indexOf(leg.from);
    const j = line.stations.indexOf(leg.to);
    const dist = line.at[i] + (line.at[j] - line.at[i]) * scene.you.frac;
    const step = i <= j ? 1 : -1;
    for (let k = i + step; k !== j + step; k += step) {
      const id = line.stations[k];
      if (line.skips.includes(id)) continue;
      const ahead = (line.at[k] - dist) * step;
      if (ahead > 40) return { name: stationName(route, id), min: Math.max(1, Math.round(ahead / Math.max(5, line.cruise) / 60)) };
    }
    return null;
  })();

  const nextChange = (() => {
    if (!lead || state === 'arrived') return null;
    const idx = state === 'train' ? trains.length : state === 'wait' ? waits.length : 1;
    const nl = lead.legs[idx];
    if (!nl) return null;
    return `Off at ${stationName(route, nl.from)} → ${legLineName(route, lead, idx)}`;
  })();

  const delta = lane ? lane.delta : 0;
  const ruled = started ? route.strategies.filter((s: any) => !scene.alive.has(s.id)) : [];

  // Lead option's phases: done and current from the engine, upcoming from your typical day.
  const pipeline = useMemo(() => {
    if (!lead) return [];
    const prof = p.profiles[lead.id];
    const rows: { kind: string; label: string; sub: string; sec: number; status: 'done' | 'now' | 'next' }[] = [];
    const phases = snap?.phases ?? [];
    const buffer = phases.find((x: any) => x.kind === 'buffer');
    rows.push({
      kind: 'buffer',
      label: `Walk to ${route.docks[0].own ? 'your bike' : route.docks[0].name} (excluded)`,
      sub: `Walks and errands stay out of the clock until you ride off`,
      sec: buffer ? (buffer.end - buffer.start) / 1000 : prof?.buffer ?? 0,
      status: !buffer ? 'next' : state === 'buffer' ? 'now' : 'done',
    });
    const real = phases.filter((x: any) => x.kind !== 'buffer');
    const kinds = ['bike', ...lead.legs.flatMap((_: any, i: number) => ['wait', 'train'])];
    kinds.forEach((k, i) => {
      const ph = real[i];
      const legIdx = Math.max(0, Math.floor((i - 1) / 2));
      const leg = lead.legs[legIdx];
      const typical = prof?.kinds?.[i] === k ? prof.secs[i] : null;
      let label = '';
      let sub = '';
      if (k === 'bike') {
        const km = pathLength(p.geo[lead.id]?.bike ?? []) / 1000;
        label = `Bike to ${stationName(route, lead.legs[0].from)}`;
        sub = `T=00:00 when you ride off${km ? ` · ${km.toFixed(1)} km` : ''}${ph ? ` · ${ph.redLights} red light${ph.redLights === 1 ? '' : 's'}` : ''}`;
      } else if (k === 'wait') {
        label = legIdx === 0 ? `${stationName(route, leg.from)} platform wait` : `Transfer at ${stationName(route, leg.from)}`;
        sub = legIdx === 0 ? 'Station geofence dwell' : `For the ${legLineName(route, lead, legIdx)}`;
      } else {
        label = `${legLineName(route, lead, legIdx)} to ${stationName(route, leg.to)}`;
        sub = ph?.crawlSec >= 20 ? `Signal crawl ${Math.round(ph.crawlSec)}s` : ph?.service ? `Running ${ph.service}` : 'In-transit velocity telemetry';
      }
      const isNow = ph && ph === snap?.phase && state !== 'arrived';
      rows.push({
        kind: k === 'wait' && legIdx > 0 ? 'transfer' : k,
        label,
        sub,
        sec: ph ? (ph.end - ph.start) / 1000 : typical ?? 0,
        status: ph ? (isNow ? 'now' : 'done') : 'next',
      });
    });
    return rows;
  }, [lead, snap, state, p.profiles, route, p.geo]);

  const strip = pipeline.filter((r) => r.kind !== 'buffer' && r.sec > 0).map((r) => ({ kind: r.kind, sec: r.sec, label: r.kind === 'train' ? r.label.split(' to ')[0] : PHASE_LABELS[r.kind].replace('Platform wait', 'Wait') }));

  const advisor = (() => {
    if (!lead) return '';
    const g = p.insight?.gamble;
    const at = g?.cfg ? stationName(route, g.cfg.at) : '';
    if (g?.enough && lead.id === g.cfg.strategy) {
      return `Break-even rule: only change to the local at ${at} if it is at most ${formatMinSec(g.breakeven)} behind you; otherwise Route ${g.cfg.alt} (${strat(g.cfg.alt)?.short}) is the safer bet. The gamble has won ${Math.round(g.winRate * 100)}% of the time.`;
    }
    if (g?.enough && lead.id === g.cfg.alt) {
      return `Safe floor: no platform gamble at ${at}. Typically ${formatMinSec(g.medAlt)} from ${stationName(route, g.cfg.from)} to the end, against ${formatMinSec(g.medGamble)} for Route ${g.cfg.strategy} when the local shows up.`;
    }
    const l = p.insight?.lights;
    if (l?.enough && lead.id === l.cfg.strategy && l.fit) {
      return `Longer bike, fewer changes: each red light on the way to ${stationName(route, lead.legs[0].from)} costs about ${Math.round(l.fit.slope)}s. Typical day: ${l.redMean.toFixed(1)} red lights.`;
    }
    const st = p.stats[lead.id];
    return st ? `${st.estimated ? 'Estimated from the schedule' : `${st.count} trips`}: median ${formatMinSec(st.medianSec)}, worst 10% ${formatMinSec(st.p90Sec)}.` : '';
  })();

  const pill = (children: any, extra = '') => (
    <div style={{ backgroundColor: T.secondarySystemBackground, borderColor: T.separator }} className={`px-3 py-1.5 rounded-full border flex items-center gap-1.5 shadow-sm ${extra}`}>
      {children}
    </div>
  );
  const seg = (on: boolean) => ({ backgroundColor: on ? T.tertiarySystemBackground : 'transparent', color: on ? T.label : T.secondaryLabel });

  const chip = (label: string, icon: any, onClick: () => void, enabled: boolean, danger = false, title = '') => (
    <button
      key={label}
      type="button"
      onClick={onClick}
      disabled={!enabled}
      title={title}
      style={{ backgroundColor: T.secondarySystemBackground, borderColor: T.separator, opacity: enabled ? 1 : 0.4, color: danger ? T.statusDelayed : T.label }}
      className="px-3 py-1.5 rounded-full border text-[11px] font-semibold flex items-center gap-1.5 shrink-0 active:scale-95 shadow-sm"
    >
      {icon}
      <span>{label}</span>
    </button>
  );

  const P50 = (id: string) => p.stats[id]?.medianSec;

  return (
    <div className="flex-1 flex flex-col relative overflow-hidden min-h-0">
      {/* MAP CANVAS */}
      <div style={{ backgroundColor: T.mapCanvas }} className="relative flex-1 min-h-[300px] overflow-hidden">
        {p.mapMode === 'street' ? (
          <StreetMap route={route} scene={scene} geo={p.geo} follow={follow} />
        ) : (
          <DiagramMap route={route} scene={scene} geo={p.geo} snap={snap} insetTop={88} insetBottom={!started ? 70 : running && trip.mode === 'sim' ? 52 : 12} />
        )}

        {/* top pills */}
        <div className="absolute top-3 left-3 right-3 z-10 flex items-start justify-between gap-2 pointer-events-none">
          <div className="pointer-events-auto min-w-0 flex-1">
            {pill(
              <>
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: state === 'idle' ? T.tertiaryLabel : state === 'buffer' ? T.statusWarning : T.statusPositive }} />
                <span className="text-[11.5px] font-semibold truncate" style={{ color: T.label }}>{status}</span>
                {underground && <small className="text-[10.5px] shrink-0" style={{ color: T.secondaryLabel }}>· underground</small>}
              </>,
              'max-w-full w-fit',
            )}
          </div>
          <div className="flex items-center gap-1.5 pointer-events-auto shrink-0">
            {nextStop ? (
              pill(
                <>
                  <Timer className="w-3.5 h-3.5" style={{ color: T.accent }} />
                  <span className="text-[11.5px] font-bold tnum">Next: {nextStop.name}</span>
                  <small className="text-[10.5px] tnum" style={{ color: T.secondaryLabel }}>· ~{nextStop.min} min</small>
                </>,
                'max-w-[170px]',
              )
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => trip.setMode(trip.mode === 'sim' ? 'live' : 'sim')}
                  disabled={running}
                  style={{
                    backgroundColor: trip.mode === 'live' ? T.accentSubtle : T.secondarySystemBackground,
                    borderColor: trip.mode === 'live' ? T.accentBorder : T.separator,
                    color: trip.mode === 'live' ? T.accent : T.secondaryLabel,
                    opacity: running ? 0.6 : 1,
                  }}
                  className="px-2.5 py-1.5 rounded-full border text-[11px] font-semibold flex items-center gap-1 shadow-sm active:scale-95"
                  title="Switch between the commute simulator and this device's GPS"
                >
                  <Radio className="w-3 h-3" />
                  <span>{trip.mode === 'live' ? 'Real GPS' : 'Sim GPS'}</span>
                </button>
                {pill(
                  <>
                    <Gauge className="w-3.5 h-3.5" style={{ color: T.accent }} />
                    <span className="text-[12.5px] font-bold tnum">{toMph(snap?.speed ?? 0).toFixed(1)}</span>
                    <span className="text-[10.5px]" style={{ color: T.secondaryLabel }}>mph</span>
                  </>,
                )}
              </>
            )}
          </div>
        </div>

        {/* view toggles */}
        <div className="absolute top-[52px] left-3 z-10 flex items-center gap-1.5">
          <div style={{ backgroundColor: T.secondarySystemBackground, borderColor: T.separator }} className="inline-flex p-0.5 rounded-full border shadow-sm" role="group" aria-label="Map style">
            <button type="button" onClick={() => p.setMapMode('street')} style={seg(p.mapMode === 'street')} className="px-2.5 py-1 rounded-full text-[11px] font-bold flex items-center gap-1" aria-pressed={p.mapMode === 'street'}>
              <MapIcon className="w-3 h-3" /> Map
            </button>
            <button type="button" onClick={() => p.setMapMode('diagram')} style={seg(p.mapMode === 'diagram')} className="px-2.5 py-1 rounded-full text-[11px] font-bold flex items-center gap-1" aria-pressed={p.mapMode === 'diagram'}>
              <TrainFront className="w-3 h-3" /> Diagram
            </button>
          </div>
          {p.mapMode === 'street' && (
            <div style={{ backgroundColor: T.secondarySystemBackground, borderColor: T.separator }} className="inline-flex p-0.5 rounded-full border shadow-sm" role="group" aria-label="Camera">
              <button type="button" onClick={() => setFollow(false)} style={seg(!follow)} className="px-2.5 py-1 rounded-full text-[11px] font-bold" aria-pressed={!follow}>Whole trip</button>
              <button type="button" onClick={() => setFollow(true)} style={seg(follow)} className="px-2.5 py-1 rounded-full text-[11px] font-bold flex items-center gap-1" aria-pressed={follow}>
                <LocateFixed className="w-3 h-3" /> Follow me
              </button>
            </div>
          )}
        </div>

        {/* bottom overlay: legend + option picker (idle) or simulator events (running) */}
        <div className="absolute left-3 right-3 bottom-3 z-10 space-y-2 pointer-events-none">
          {p.mapMode === 'street' && (
          <div className="flex flex-wrap gap-1.5 text-[10.5px] font-semibold" aria-hidden="true">
            {[
              ['Bike', T.phase.bike],
              ['Train', T.phase.train],
              ['Wait', T.phase.wait],
            ].map(([k, c]) => (
              <span key={k} style={{ backgroundColor: T.secondarySystemBackground, borderColor: T.separator, color: T.secondaryLabel }} className="px-2 py-0.5 rounded-full border flex items-center gap-1">
                <i className="w-2.5 h-1 rounded-full inline-block" style={{ backgroundColor: c }} /> {k}
              </span>
            ))}
            <span style={{ backgroundColor: T.secondarySystemBackground, borderColor: T.separator, color: T.secondaryLabel }} className="px-2 py-0.5 rounded-full border flex items-center gap-1">
              <i className="w-3 h-1 inline-block" style={{ background: `repeating-linear-gradient(90deg, ${T.accent} 0 3px, transparent 3px 5px)` }} /> Still to ride
            </span>
            {started && ruled.length > 0 && (
              <span style={{ backgroundColor: T.secondarySystemBackground, borderColor: T.separator, color: T.secondaryLabel }} className="px-2 py-0.5 rounded-full border flex items-center gap-1">
                <i className="w-2.5 h-1 rounded-full inline-block" style={{ backgroundColor: T.tertiaryLabel }} /> Ruled out
              </span>
            )}
          </div>
          )}
          {!started ? (
            <div className="flex items-stretch gap-2 overflow-x-auto no-scrollbar pointer-events-auto py-0.5">
              {route.strategies.map((s: any) => {
                const on = trip.mode === 'sim' && sel === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => trip.setSimStrategy(s.id)}
                    style={{ backgroundColor: on ? T.accent : T.secondarySystemBackground, borderColor: on ? T.accent : T.separator, color: on ? '#FFFFFF' : T.label }}
                    className="flex-1 min-w-[104px] py-2 px-3 rounded-full border text-left flex items-center justify-between gap-1.5 transition-all active:scale-95 shadow-sm"
                    title={trip.mode === 'sim' ? `Simulate a commute on Route ${s.id}` : s.desc}
                  >
                    <div className="min-w-0">
                      <div className="text-[12px] font-bold leading-tight">Route {s.id}</div>
                      <div className="text-[10px] opacity-85 tnum whitespace-nowrap">{p.stats[s.id]?.estimated ? 'est.' : 'P50'} {formatMinutesDecimal(P50(s.id))}</div>
                    </div>
                    {p.winnerId === s.id && (
                      <span style={{ backgroundColor: on ? 'rgba(255,255,255,0.22)' : T.accentSubtle, color: on ? '#FFFFFF' : T.accent }} className="text-[9px] font-bold px-1.5 py-0.5 rounded-full">BEST</span>
                    )}
                  </button>
                );
              })}
            </div>
          ) : running && trip.mode === 'sim' ? (
            <div className="flex items-center gap-1.5 overflow-x-auto py-0.5 no-scrollbar pointer-events-auto">
              {chip('+90s Walk Delay (Excluded)', <Coffee className="w-3.5 h-3.5" style={{ color: T.statusWarning }} />, () => trip.inject('errand'), state === 'buffer', false, 'Stop for an errand on the walk to the dock')}
              {chip(`Red Light (${snap?.phases?.find((x: any) => x.kind === 'bike')?.redLights ?? 0})`, <TrafficCone className="w-3.5 h-3.5" style={{ color: T.statusDelayed }} />, () => trip.inject('red'), state === 'bike', false, 'Stop at a light for 35 s')}
              {chip('Sim Signal Crawl', <AlertTriangle className="w-3.5 h-3.5" />, () => trip.inject('crawl'), state === 'train', true, 'Crawl between stations for about 2.5 min')}
              {chip('Train Late +2m', <Timer className="w-3.5 h-3.5" style={{ color: T.statusWarning }} />, () => trip.inject('late'), state === 'wait', false, 'The next train comes 2 minutes later')}
            </div>
          ) : null}
        </div>
      </div>

      {/* BOTTOM SHEET (PEEK / HALF / FULL) */}
      <div style={{ backgroundColor: T.elevatedSheet, borderColor: T.separator }} className={`rounded-t-[16px] border-t shadow-2xl px-5 pt-2 pb-4 z-20 overflow-y-auto ${detent === 'FULL' ? 'max-h-[64vh]' : 'max-h-[52vh]'}`}>
        <div className="flex items-center justify-between mb-2.5">
          <span style={{ color: T.tertiaryLabel }} className="text-[10.5px] font-semibold uppercase tracking-wider truncate max-w-[140px]">{trip.gps}</span>
          <button type="button" onClick={() => setDetent((d) => (d === 'PEEK' ? 'HALF' : d === 'HALF' ? 'FULL' : 'PEEK'))} className="py-1 px-4" aria-label="Change sheet height">
            <div style={{ backgroundColor: T.tertiaryLabel }} className="w-9 h-1 rounded-full opacity-45" />
          </button>
          <div style={{ backgroundColor: T.tertiarySystemBackground }} className="inline-flex items-center rounded-[8px] p-0.5">
            {(['PEEK', 'HALF', 'FULL'] as const).map((d) => (
              <button key={d} type="button" onClick={() => setDetent(d)} style={{ backgroundColor: detent === d ? T.secondarySystemBackground : 'transparent', color: detent === d ? T.label : T.secondaryLabel }} className="px-2 py-0.5 rounded-[6px] text-[10px] font-bold">
                {d}
              </button>
            ))}
          </div>
        </div>

        {trip.resumable && trip.status === 'idle' && (
          <div style={{ backgroundColor: T.accentSubtle, borderColor: T.accentBorder }} className="mb-3 p-3 rounded-[12px] border flex items-center justify-between gap-2">
            <div className="text-[12px]">
              <b>Unfinished GPS trip</b> from {timeLabel(trip.resumable.startedAt)}
            </div>
            <div className="flex gap-1.5 shrink-0">
              <button type="button" onClick={trip.discardResume} style={{ backgroundColor: T.tertiarySystemBackground }} className="h-8 px-3 rounded-full text-[12px] font-semibold">Discard</button>
              <button type="button" onClick={trip.resume} style={{ backgroundColor: T.accent }} className="h-8 px-3 rounded-full text-[12px] font-semibold text-white">Resume</button>
            </div>
          </div>
        )}
        {trip.notice && (
          <div style={{ backgroundColor: T.statusWarningBg, color: T.label }} className="mb-3 px-3 py-2 rounded-[12px] text-[12px] flex items-start justify-between gap-2">
            <span>{trip.notice}</span>
            <button type="button" onClick={() => trip.setNotice(null)} aria-label="Dismiss"><X className="w-3.5 h-3.5" /></button>
          </div>
        )}
        {trip.mode === 'live' && trip.status === 'idle' && !window.isSecureContext && (
          <p style={{ color: T.statusWarning }} className="mb-3 text-[12px]">Phones only allow GPS on HTTPS pages. On this Mac it works at 127.0.0.1; for your phone, see the README.</p>
        )}

        {/* CLOCK */}
        <div className="flex items-start justify-between mb-3 gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span style={{ color: T.secondaryLabel }} className="text-[11.5px] font-semibold uppercase tracking-wider">
                {!started ? `${p.destName} · Route ${sel} ${p.stats[sel]?.estimated ? 'est.' : 'P50'}` : state === 'buffer' ? 'Pre-benchmark walk (T=0 waiting)' : `Route ${scene.candidates.join(' · ')} clock`}
              </span>
              {started && state !== 'buffer' && lane && (
                <span style={{ backgroundColor: delta <= 0 ? T.statusPositiveBg : T.statusDelayedBg, color: delta <= 0 ? T.statusPositive : T.statusDelayed }} className="text-[11px] font-bold px-2 py-0.5 rounded-full tnum">
                  {signed(delta)} vs P50
                </span>
              )}
            </div>
            <div className="text-[38px] font-bold tracking-tight leading-none mt-1 tnum" style={{ color: state === 'buffer' ? T.secondaryLabel : T.label }}>
              {!started ? formatMinutesDecimal(P50(sel)) : state === 'buffer' ? formatMinSec((snap.now - snap.phases[0].start) / 1000) : formatMinSec(snap.elapsed ?? 0)}
            </div>
          </div>
          <div className="text-right shrink-0">
            <div style={{ color: T.secondaryLabel }} className="text-[11.5px] font-medium tnum">
              Walk buffer{' '}
              <b style={{ color: T.label }}>
                {!started ? formatMinutesDecimal(p.stats[sel]?.avgPreBufferSec) : formatMinSec(((snap.phases[0]?.kind === 'buffer' ? snap.phases[0].end : snap.now) - snap.phases[0].start) / 1000)}
              </b>
            </div>
            {nextChange && started && <div className="text-[12.5px] font-bold mt-1 max-w-[170px] truncate">{nextChange}</div>}
            {trip.mode === 'sim' && (
              <div style={{ backgroundColor: T.tertiarySystemBackground }} className="mt-1.5 inline-flex items-center rounded-[8px] p-0.5" role="group" aria-label="Simulation speed">
                {[1, 20, 60].map((spd) => (
                  <button key={spd} type="button" onClick={() => trip.setSpeed(spd)} style={{ backgroundColor: trip.speed === spd ? T.secondarySystemBackground : 'transparent', color: trip.speed === spd ? T.label : T.secondaryLabel }} className="px-2 py-0.5 rounded-[6px] text-[11px] font-semibold tnum">
                    {spd}x
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* options still possible; ruled-out ones shrink to struck-through badges */}
        {started && detent !== 'PEEK' && (
          <div className="flex flex-wrap items-center gap-1.5 mb-3">
            {route.strategies.filter((s: any) => scene.alive.has(s.id)).map((s: any) => (
              <span key={s.id} style={{ backgroundColor: T.secondarySystemBackground, borderColor: T.separator }} className="pl-1 pr-3 py-1 rounded-full border flex items-center gap-2 text-[12.5px] font-semibold max-w-full">
                <RouteBadge code={s.id} color={s.color} size={22} />
                <span className="truncate">{s.desc}</span>
              </span>
            ))}
            {ruled.map((s: any) => (
              <span key={s.id} style={{ backgroundColor: T.secondarySystemBackground, borderColor: T.separator, color: T.tertiaryLabel }} className="pl-1 pr-2 py-1 rounded-full border flex items-center gap-1 text-[11px] font-semibold" title={`${s.desc}: ruled out`}>
                <RouteBadge code={s.id} color={s.color} size={18} muted />
                <span style={{ textDecoration: 'line-through' }}>out</span>
              </span>
            ))}
          </div>
        )}

        {detent === 'HALF' && !started && lead && (
          <button type="button" onClick={() => setDetent('FULL')} style={{ backgroundColor: T.tertiarySystemBackground, borderColor: T.separator }} className="w-full mb-3 px-3 py-2 rounded-[12px] border flex items-center gap-2 text-left">
            <RouteBadge code={lead.id} color={lead.color} size={20} />
            <span className="text-[12.5px] font-semibold truncate flex-1">{lead.desc}</span>
            <span style={{ color: T.secondaryLabel }} className="text-[11px] shrink-0 flex items-center gap-0.5">Details <ChevronUp className="w-3.5 h-3.5" /></span>
          </button>
        )}

        {detent === 'FULL' && (
          <div className="space-y-3 mb-3">
            {lead && (
              <div style={{ backgroundColor: T.tertiarySystemBackground, borderColor: T.separator }} className="p-3.5 rounded-[16px] border">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <RouteBadge code={lead.id} color={lead.color} size={20} />
                      <span className="text-[13px] font-bold truncate">{lead.desc}</span>
                    </div>
                    <p style={{ color: T.secondaryLabel }} className="text-[12px] mt-1 leading-relaxed">{advisor}</p>
                  </div>
                  <button type="button" onClick={() => setDetent('HALF')} style={{ color: T.secondaryLabel }} className="p-1 shrink-0" aria-label="Show less">
                    <ChevronDown className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}

                <div style={{ backgroundColor: T.secondarySystemBackground, borderColor: T.separator }} className="rounded-[16px] border divide-y" role="list">
                  {pipeline.map((r, i) => (
                    <div key={i} role="listitem" style={{ borderColor: T.separator, opacity: r.status === 'next' ? 0.6 : 1 }} className="w-full px-3.5 py-2.5 flex items-center justify-between">
                      <div className="flex items-center gap-3 min-w-0 pr-2">
                        <div style={{ backgroundColor: r.status === 'now' ? T.accent : T.tertiarySystemBackground, color: r.status === 'now' ? '#FFFFFF' : T.phase[r.kind as keyof typeof T.phase] }} className="w-7 h-7 rounded-[8px] flex items-center justify-center shrink-0">
                          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: r.status === 'now' ? '#FFFFFF' : T.phase[r.kind as keyof typeof T.phase] }} />
                        </div>
                        <div className="min-w-0">
                          <div className="text-[12.5px] font-semibold truncate">{r.label}</div>
                          <div style={{ color: T.secondaryLabel }} className="text-[11px] truncate">{r.sub}</div>
                        </div>
                      </div>
                      <span style={{ color: r.status === 'now' ? T.accent : T.label }} className="text-[13px] font-bold shrink-0 tnum">
                        {r.status === 'next' && r.sec ? '~' : ''}
                        {formatMinSec(r.sec)}
                      </span>
                    </div>
                  ))}
                </div>
                {(started ? scene.lanes.length > 0 : true) && (
                  <div style={{ backgroundColor: T.secondarySystemBackground, borderColor: T.separator }} className="rounded-[16px] border p-3.5">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[13px] font-bold">Race your ghost</span>
                      <span style={{ color: T.secondaryLabel }} className="text-[11px]">○ typical day · ● you</span>
                    </div>
                    {started ? (
                      <GhostRace lanes={scene.lanes} route={route} started />
                    ) : (
                      <p style={{ color: T.secondaryLabel }} className="text-[12px]">Start a trip to race your median commute on every option still in play.</p>
                    )}
                  </div>
                )}
          </div>
        )}

        {strip.length > 0 && (
          <div className="mb-4">
            <PhaseStrip segs={strip} dashedLast={started && state !== 'arrived'} labels={detent !== 'PEEK'} />
          </div>
        )}

        {/* CTA */}
        {!running ? (
          <button type="button" onClick={trip.start} style={{ backgroundColor: T.accent }} className="w-full h-12 rounded-full text-white font-semibold text-[16px] flex items-center justify-center gap-2 shadow-lg active:scale-[0.99]">
            <Play className="w-4 h-4 fill-current" />
            <span className="truncate">{trip.mode === 'sim' ? `Simulate Trip · Route ${sel}` : `Start Trip to ${p.destName}`}</span>
          </button>
        ) : (
          <div className="flex items-center gap-2.5">
            <button type="button" onClick={trip.cancel} style={{ backgroundColor: T.tertiarySystemBackground, color: T.label }} className="h-12 px-5 rounded-full font-semibold text-[14px] flex items-center justify-center gap-1.5 active:scale-95">
              <RotateCcw className="w-4 h-4" />
              <span>Cancel</span>
            </button>
            <button type="button" onClick={trip.end} style={{ backgroundColor: T.accent }} className="flex-1 h-12 rounded-full text-white font-semibold text-[16px] flex items-center justify-center gap-2 shadow-lg active:scale-[0.99]">
              {trip.mode === 'sim' ? <SkipForward className="w-4 h-4" /> : <Square className="w-4 h-4 fill-current" />}
              <span>{trip.mode === 'sim' ? 'Skip to Arrival' : 'End Trip'}</span>
            </button>
          </div>
        )}
        {!running && (
          <p style={{ color: T.tertiaryLabel }} className="text-[11px] text-center mt-2">
            {trip.mode === 'sim' ? `A simulated you rides Route ${sel}; the detector is not told which.` : 'Hands-free: open it at your door and just commute.'}
          </p>
        )}
      </div>
    </div>
  );
}
