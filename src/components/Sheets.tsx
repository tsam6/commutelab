import { useMemo, useState } from 'react';
import { Building2, Check, CheckCircle2, FlaskConical, GraduationCap, Moon, Plus, Sun, Trash2, Trophy, User, X } from 'lucide-react';
import { useT } from '../theme';
import { formatMinSec, formatMinutesDecimal } from '../lib/format';
import { stationName, type RunView } from '../lib/runs';
import type { Destination, Profile } from '../lib/store';
import { rankOf } from '../engine/analytics.js';
import { RouteBadge } from './charts';

export function Sheet({ onClose, children, label, z = 'z-40' }: { onClose: () => void; children: any; label: string; z?: string }) {
  const T = useT();
  return (
    <div className={`absolute inset-0 ${z} bg-black/60 backdrop-blur-sm flex items-end justify-center`} role="dialog" aria-modal="true" aria-label={label} onClick={onClose}>
      <div style={{ backgroundColor: T.elevatedSheet, borderColor: T.separator }} className="w-full rounded-t-[16px] border-t p-5 space-y-4 max-h-[88%] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

export function CloseBtn({ onClick }: { onClick: () => void }) {
  const T = useT();
  return (
    <button type="button" onClick={onClick} style={{ backgroundColor: T.tertiarySystemBackground }} className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" aria-label="Close">
      <X className="w-4 h-4" />
    </button>
  );
}

export const destIcon = (icon: string, className = 'w-4 h-4') =>
  icon === 'school' ? <GraduationCap className={className} /> : icon === 'lab' ? <FlaskConical className={className} /> : <Building2 className={className} />;

/** Verified commute receipt (CommuteLab), now with the detector's verdict and your rank. */
export function Receipt({ run, route, destName, allRuns, onClose, onDelete }: { run: RunView; route: any; destName: string; allRuns: any[]; onClose: () => void; onDelete?: () => void }) {
  const T = useT();
  const rank = run.code ? rankOf(allRuns, run.record) : null;
  const truth = run.record.simTruth;
  const row = { borderColor: T.separator };
  return (
    <Sheet onClose={onClose} label="Commute receipt">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <span style={{ backgroundColor: T.accentSubtle, color: T.accent }} className="text-[11px] font-bold uppercase px-2.5 py-0.5 rounded-full">
            Verified Commute Receipt · {destName}
          </span>
          <h3 className="text-[22px] font-bold mt-1 flex items-center gap-2">
            {run.code && <RouteBadge code={run.code} color={run.color} size={26} />}
            {run.code ? `Route ${run.code} Complete` : 'Trip Complete'}
          </h3>
          <p style={{ color: T.secondaryLabel }} className="text-[12.5px] truncate">
            {run.desc} · {run.date} {run.time}
          </p>
        </div>
        <CloseBtn onClick={onClose} />
      </div>

      <div style={{ backgroundColor: T.secondarySystemBackground, borderColor: T.separator }} className="p-4 rounded-[16px] border flex items-center justify-between tnum">
        <div>
          <div style={{ color: T.secondaryLabel }} className="text-[12px]">Official Benchmark Time</div>
          <div className="text-[32px] font-bold tracking-tight">{formatMinSec(run.total)}</div>
        </div>
        <div className="text-right">
          <div style={{ color: T.secondaryLabel }} className="text-[12px]">Excluded Walk Buffer</div>
          <div className="text-[16px] font-semibold">{formatMinSec(run.buffer)}</div>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {rank && rank.of > 1 && (
          <span style={{ backgroundColor: rank.pb ? T.statusPositiveBg : T.tertiarySystemBackground, color: rank.pb ? T.statusPositive : T.label }} className="text-[11.5px] font-bold px-2.5 py-1 rounded-full flex items-center gap-1 tnum">
            {rank.pb && <Trophy className="w-3.5 h-3.5" />}#{rank.rank} of {rank.of} on Route {run.code}
            {rank.pb ? ' · personal best' : ''}
          </span>
        )}
        {truth && (
          <span style={{ backgroundColor: truth === run.code ? T.statusPositiveBg : T.statusDelayedBg, color: truth === run.code ? T.statusPositive : T.statusDelayed }} className="text-[11.5px] font-bold px-2.5 py-1 rounded-full flex items-center gap-1">
            <CheckCircle2 className="w-3.5 h-3.5" />
            {truth === run.code ? `Detector matched the simulated Route ${truth}` : `Simulated ${truth}, detector said ${run.code ?? 'no match'}`}
          </span>
        )}
        {run.record.manual && <span style={{ backgroundColor: T.statusWarningBg, color: T.label }} className="text-[11.5px] font-semibold px-2.5 py-1 rounded-full">Ended by hand</span>}
        {run.sample && <span style={{ backgroundColor: T.tertiarySystemBackground, color: T.secondaryLabel }} className="text-[11.5px] font-semibold px-2.5 py-1 rounded-full">Sample trip (simulated history)</span>}
      </div>

      <div style={{ backgroundColor: T.secondarySystemBackground, borderColor: T.separator }} className="rounded-[16px] border divide-y text-[13px] tnum">
        {run.legs.map((l, i) => (
          <div key={i} style={row} className="px-4 py-2.5 flex justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: T.phase[l.kind as keyof typeof T.phase] }} />
                <span className="font-medium truncate">{l.label}</span>
              </div>
              <div style={{ color: T.secondaryLabel }} className="text-[11px] ml-4 truncate">{l.sub}</div>
            </div>
            <span className="font-semibold shrink-0">{formatMinSec(l.sec)}</span>
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        {onDelete && !run.sample && (
          <button type="button" onClick={onDelete} style={{ backgroundColor: T.tertiarySystemBackground, color: T.statusDelayed }} className="h-12 px-4 rounded-full font-semibold text-[14px] flex items-center gap-1.5">
            <Trash2 className="w-4 h-4" /> Delete
          </button>
        )}
        <button type="button" onClick={onClose} style={{ backgroundColor: T.accent }} className="flex-1 h-12 rounded-full text-white font-semibold text-[16px]">
          Done
        </button>
      </div>
      <p style={{ color: T.tertiaryLabel }} className="text-[11px] text-center">Ended at {stationName(route, run.record.path[run.record.path.length - 1])}</p>
    </Sheet>
  );
}

/** Destination workspaces + account hub (CommuteLab Sheet 1). */
export function Switcher({ profile, destinations, activeId, counts, onSelect, onDelete, onNew, onAccount, onClose }: {
  profile: Profile;
  destinations: Destination[];
  activeId: string;
  counts: Record<string, number>;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
  onAccount: () => void;
  onClose: () => void;
}) {
  const T = useT();
  const initials = profile.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase();
  return (
    <Sheet onClose={onClose} label="Destinations and account">
      <div className="flex items-center justify-between">
        <button type="button" onClick={onAccount} className="flex items-center gap-3 text-left">
          <div style={{ backgroundColor: T.accentSubtle, color: T.accent }} className="w-10 h-10 rounded-full flex items-center justify-center font-bold text-[15px]">{initials || <User className="w-4 h-4" />}</div>
          <div>
            <div className="text-[16px] font-bold">{profile.name}</div>
            <div style={{ color: T.secondaryLabel }} className="text-[12px]">
              {profile.handle} · Origin: {profile.homeOriginLabel}
            </div>
          </div>
        </button>
        <CloseBtn onClick={onClose} />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span style={{ color: T.secondaryLabel }} className="text-[11.5px] font-bold uppercase tracking-wider">Your Destination Benchmarks (Home → X)</span>
          <span style={{ color: T.tertiaryLabel }} className="text-[11px]">{destinations.length} workspaces</span>
        </div>
        {destinations.map((d) => {
          const on = d.id === activeId;
          const r = d.route;
          return (
            <div key={d.id} style={{ backgroundColor: on ? T.accentSubtle : T.secondarySystemBackground, borderColor: on ? T.accent : T.separator }} className="p-3.5 rounded-[16px] border flex items-center justify-between gap-2">
              <button type="button" onClick={() => onSelect(d.id)} className="flex-1 text-left flex items-center gap-3 min-w-0">
                <div style={{ backgroundColor: on ? T.accent : T.tertiarySystemBackground, color: on ? '#FFFFFF' : T.secondaryLabel }} className="w-9 h-9 rounded-[10px] flex items-center justify-center shrink-0">
                  {destIcon(r.icon)}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[14.5px] font-bold truncate">Home → {r.title}</span>
                    {d.preset && <span style={{ backgroundColor: T.tertiarySystemBackground, color: T.secondaryLabel }} className="text-[9.5px] font-bold px-2 py-0.5 rounded-full">PRESET</span>}
                  </div>
                  <div style={{ color: T.secondaryLabel }} className="text-[11.5px] truncate mt-0.5">
                    {r.strategies.map((s: any) => `${s.id}: ${stationName(r, s.legs[0].from)}`).join(' vs ')} · {counts[d.id] ?? 0} trips
                  </div>
                </div>
              </button>
              <div className="flex items-center gap-1.5 shrink-0">
                {on ? (
                  <span style={{ backgroundColor: T.accent }} className="w-6 h-6 rounded-full flex items-center justify-center text-white"><Check className="w-3.5 h-3.5" /></span>
                ) : (
                  !d.preset && (
                    <button type="button" onClick={() => onDelete(d.id)} style={{ color: T.tertiaryLabel }} className="p-1.5" aria-label={`Delete Home → ${r.title}`}>
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="space-y-2 pt-1">
        <button type="button" onClick={onNew} style={{ backgroundColor: T.accent }} className="w-full h-12 rounded-full text-white font-semibold text-[15px] flex items-center justify-center gap-2 shadow-md">
          <Plus className="w-4 h-4" />
          <span>Add New Destination Commute (Home → X)</span>
        </button>
        <button type="button" onClick={onAccount} style={{ backgroundColor: T.tertiarySystemBackground, color: T.label }} className="w-full h-11 rounded-full font-semibold text-[13.5px] flex items-center justify-center gap-2">
          <User className="w-4 h-4" style={{ color: T.accent }} />
          <span>Account & Cycling Trigger</span>
        </button>
      </div>
    </Sheet>
  );
}

/** Account & home origin (CommuteLab onboarding step 1), plus theme. */
export function Account({ profile, theme, onSave, onTheme, onClose }: { profile: Profile; theme: 'dark' | 'light'; onSave: (p: Profile) => void; onTheme: () => void; onClose: () => void }) {
  const T = useT();
  const [d, setD] = useState(profile);
  const field = { backgroundColor: T.tertiarySystemBackground, borderColor: T.separator, color: T.label };
  const input = (label: string, k: 'name' | 'handle' | 'homeOriginLabel') => (
    <label className="space-y-1 block">
      <span style={{ color: T.secondaryLabel }} className="text-[11px] font-semibold block">{label}</span>
      <input type="text" value={d[k]} onChange={(e) => setD({ ...d, [k]: e.target.value })} style={field} className="w-full px-3 py-2 rounded-[8px] border font-medium focus:outline-none text-[13px]" />
    </label>
  );
  return (
    <Sheet onClose={onClose} label="Account">
      <div className="flex items-center justify-between">
        <h3 className="text-[20px] font-bold">Account & Home Origin</h3>
        <CloseBtn onClick={onClose} />
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        {input('Your Name', 'name')}
        {input('Commuter Handle', 'handle')}
      </div>
      {input('Home Origin Label', 'homeOriginLabel')}
      <div style={{ backgroundColor: T.secondarySystemBackground, borderColor: T.separator }} className="p-3 rounded-[12px] border space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[12.5px] font-semibold">Auto-Start Cycling Velocity Trigger</div>
            <div style={{ color: T.secondaryLabel }} className="text-[11px]">The clock starts once you hold this speed for 8 s. Walks and coffee stops stay below it.</div>
          </div>
          <span style={{ color: T.accent }} className="text-[14px] font-bold tnum shrink-0">&gt; {d.bikeThresholdMph.toFixed(1)} mph</span>
        </div>
        <input type="range" min={5} max={12} step={0.5} value={d.bikeThresholdMph} onChange={(e) => setD({ ...d, bikeThresholdMph: Number(e.target.value) })} className="w-full accent-[#FF5500]" aria-label="Cycling trigger speed" />
      </div>
      <button type="button" onClick={onTheme} style={{ backgroundColor: T.secondarySystemBackground, borderColor: T.separator }} className="w-full p-3 rounded-[12px] border flex items-center justify-between text-[13px] font-semibold">
        <span>Appearance</span>
        <span className="flex items-center gap-1.5" style={{ color: T.secondaryLabel }}>
          {theme === 'dark' ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />} {theme === 'dark' ? 'Dark' : 'Light'}
        </span>
      </button>
      <button type="button" onClick={() => { onSave(d); onClose(); }} style={{ backgroundColor: T.accent }} className="w-full h-11 rounded-full text-white font-semibold text-[15px]">
        Save
      </button>
    </Sheet>
  );
}

/**
 * Crossover simulator (CommuteLab): how red lights, a signal crawl and the wait for the local
 * shift the winner. Starts from each route's typical phases (median of your trips).
 */
export function WhatIf({ route, destName, profiles, insight, onClose }: { route: any; destName: string; profiles: Record<string, any>; insight: any; onClose: () => void }) {
  const T = useT();
  const l = insight?.lights;
  const g = insight?.gamble;
  const c = route.insights?.crawl;
  const slope = l?.enough && l.fit ? Math.max(5, l.fit.slope) : 35;
  const lightsFor = l?.cfg?.strategy ?? null;
  const typLights = l?.enough ? Math.round(l.redMean) : 2;
  const waitAt = g?.cfg?.at ?? route.insights?.gamble?.at;
  const typWait = g?.enough ? g.waitStats.median / 60 : 2;
  const [lights, setLights] = useState(typLights);
  const [crawl, setCrawl] = useState(0);
  const [wait, setWait] = useState(Math.round(typWait * 5) / 5);

  const proj = useMemo(() => {
    const out: Record<string, number> = {};
    for (const s of route.strategies) {
      const prof = profiles[s.id];
      if (!prof) continue;
      let total = prof.typical;
      if (!lightsFor || lightsFor === s.id) total += (lights - typLights) * slope;
      const crawlSet = c ? c.strategies : route.strategies.map((x: any) => x.id);
      if (crawlSet.includes(s.id)) total += crawl * 60;
      const gs = g?.cfg?.strategy ?? route.insights?.gamble?.strategy;
      if (gs === s.id) {
        // replace the typical wait at the gamble station with the slider's
        let wi = -1;
        prof.kinds.forEach((k: string, i: number) => {
          if (k === 'wait') {
            wi++;
            if (s.legs[wi]?.from === waitAt) total += wait * 60 - prof.secs[i];
          }
        });
      }
      out[s.id] = total;
    }
    return out;
  }, [route, profiles, lights, crawl, wait, slope, lightsFor, typLights, c, g, waitAt]);
  const best = Math.min(...Object.values(proj));
  const S = (id: string) => route.strategies.find((s: any) => s.id === id);

  return (
    <Sheet onClose={onClose} label="Crossover simulator">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-[20px] font-bold">Crossover Simulator ({destName})</h3>
          <p style={{ color: T.secondaryLabel }} className="text-[12.5px]">Test how red lights, train crawls and the local's timing shift the winning route.</p>
        </div>
        <CloseBtn onClick={onClose} />
      </div>
      <div style={{ backgroundColor: T.tertiarySystemBackground }} className="grid gap-2 p-3 rounded-[16px] text-center tnum" role="status" aria-live="polite">
        <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(3, route.strategies.length)}, minmax(0, 1fr))` }}>
          {route.strategies.map((s: any) => {
            const sec = proj[s.id];
            const fastest = sec === best;
            return (
              <div key={s.id} style={{ backgroundColor: fastest ? T.secondarySystemBackground : 'transparent', borderColor: fastest ? T.accent : 'transparent' }} className="p-2 rounded-[12px] border">
                <div className="text-[11px] font-bold flex items-center justify-center gap-1"><RouteBadge code={s.id} color={s.color} size={16} /> Route {s.id}</div>
                <div style={{ color: fastest ? T.accent : T.label }} className="text-[18px] font-bold mt-0.5">{formatMinutesDecimal(sec)}</div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="space-y-3 text-[13px] tnum">
        <div>
          <div className="flex justify-between mb-1 gap-2">
            <span>{lightsFor ? `${stationName(route, S(lightsFor).legs[0].from)} bike ride: red lights` : 'Red lights on the bike'} (+{Math.round(slope)}s each)</span>
            <span className="font-bold shrink-0">{lights} lights</span>
          </div>
          <input type="range" min={0} max={6} step={1} value={lights} onChange={(e) => setLights(Number(e.target.value))} className="w-full accent-[#FF5500]" aria-label="Red lights" />
        </div>
        <div>
          <div className="flex justify-between mb-1 gap-2">
            <span>{c ? `${c.lineName} signal crawl (Routes ${c.strategies.join(', ')})` : 'First-train signal crawl'}</span>
            <span className="font-bold shrink-0">+{crawl}m</span>
          </div>
          <input type="range" min={0} max={6} step={0.5} value={crawl} onChange={(e) => setCrawl(Number(e.target.value))} className="w-full accent-[#FF5500]" aria-label="Signal crawl minutes" />
        </div>
        {waitAt && (
          <div>
            <div className="flex justify-between mb-1 gap-2">
              <span>Route {g?.cfg?.strategy ?? route.insights.gamble.strategy}: wait for the local at {stationName(route, waitAt)}</span>
              <span className="font-bold shrink-0">{wait.toFixed(1)}m</span>
            </div>
            <input type="range" min={0} max={6} step={0.2} value={wait} onChange={(e) => setWait(Number(e.target.value))} className="w-full accent-[#FF5500]" aria-label="Local wait minutes" />
          </div>
        )}
      </div>
      <p style={{ color: T.tertiaryLabel }} className="text-[11px]">Sliders start at your typical day: the median of each phase over your trips.</p>
      <button type="button" onClick={onClose} style={{ backgroundColor: T.accent }} className="w-full h-11 rounded-full text-white font-semibold text-[15px]">
        Done
      </button>
    </Sheet>
  );
}
