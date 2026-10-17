import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, ChevronDown, Layers, Loader2, Moon, Navigation, SlidersHorizontal, Sun, User } from 'lucide-react';
import { getSemanticTokens, ThemeCtx } from './theme';
import { loadNyc, presetDestination, SAMPLE_TRIPS, type Nyc } from './nyc/data';
import { loadState, saveState, type Destination, type Profile, type Saved } from './lib/store';
import { estimateRecords, estimateStats, routeInsights, sampleRuns, statsByRoute, viewRun, winner, type RunView } from './lib/runs';
import { strategyProfiles, winMatrix } from './engine/analytics.js';
import { buildScene, strategyGeometry } from './lib/live';
import { useTrip } from './hooks/useTrip';
import Corridor from './components/Corridor';
import Benchmark from './components/Benchmark';
import Ledger from './components/Ledger';
import RouteSetup from './components/RouteSetup';
import { Account, Receipt, Switcher, WhatIf } from './components/Sheets';

const DEFAULT_PROFILE: Profile = { name: 'Alex Rivera', handle: '@alex_commutes', homeOriginLabel: 'Home Front Door', bikeThresholdMph: 7.5 };

function initialState(nyc: Nyc): Saved {
  const preset = presetDestination(nyc);
  const saved = loadState();
  if (!saved?.destinations?.length) {
    return { theme: 'dark', mapMode: 'street', profile: DEFAULT_PROFILE, destinations: [preset], activeId: preset.id };
  }
  // The preset is rebuilt from the current data snapshot; your own routes keep what you set up.
  const destinations = saved.destinations.map((d) => (d.preset ? { ...preset, runs: d.runs ?? [], samples: d.samples === undefined ? preset.samples : d.samples } : d));
  if (!destinations.some((d) => d.preset)) destinations.unshift(preset);
  const activeId = destinations.some((d) => d.id === saved.activeId) ? saved.activeId : destinations[0].id;
  return { theme: saved.theme ?? 'dark', mapMode: saved.mapMode ?? 'street', profile: { ...DEFAULT_PROFILE, ...saved.profile }, destinations, activeId };
}

export default function App() {
  const [nyc, setNyc] = useState<Nyc | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    loadNyc().then(setNyc).catch((e) => setErr(String(e.message || e)));
  }, []);
  const prefersDark = typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches !== false;
  const tokens = getSemanticTokens(prefersDark ? 'dark' : 'light');
  if (!nyc) {
    return (
      <ThemeCtx.Provider value={tokens}>
        <div style={{ backgroundColor: tokens.systemBackground, color: tokens.label }} className="min-h-screen flex items-center justify-center p-6 text-center">
          {err ? (
            <div className="space-y-2 max-w-sm">
              <div className="text-[18px] font-bold">Could not load the NYC transit data</div>
              <p style={{ color: tokens.secondaryLabel }} className="text-[13px]">{err}. Run <code>npm run data</code> to rebuild public/data, then reload.</p>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-[14px]" style={{ color: tokens.secondaryLabel }}>
              <Loader2 className="w-4 h-4 animate-spin" /> Loading MTA stations and Citi Bike docks…
            </div>
          )}
        </div>
      </ThemeCtx.Provider>
    );
  }
  return <Main nyc={nyc} />;
}

function Main({ nyc }: { nyc: Nyc }) {
  const [state, setState] = useState<Saved>(() => initialState(nyc));
  useEffect(() => saveState(state), [state]);
  const tokens = useMemo(() => getSemanticTokens(state.theme), [state.theme]);
  const update = (fn: (s: Saved) => Saved) => setState((s) => fn(s));
  const dest = state.destinations.find((d) => d.id === state.activeId) ?? state.destinations[0];
  const route = dest.route;
  const destName = route.title;

  const [nav, setNav] = useState<'LIVE' | 'BENCHMARK' | 'RUNS'>('LIVE');
  const [ledgerFilter, setLedgerFilter] = useState('ALL');
  const [benchFilter, setBenchFilter] = useState<'all' | 'mine' | 'gps'>('all');
  const [receipt, setReceipt] = useState<RunView | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<null | 'switcher' | 'account' | 'whatif' | 'setup'>(null);

  // ---------------------------------------------------------------- trips and statistics
  const samples = useMemo(() => sampleRuns(route, dest.samples), [route, dest.samples]);
  const allRecs = useMemo(() => [...dest.runs, ...samples].sort((a, b) => b.t0 - a.t0), [dest.runs, samples]);
  const benchRecs = useMemo(() => (benchFilter === 'all' ? allRecs : benchFilter === 'mine' ? dest.runs : dest.runs.filter((r) => r.source === 'live')), [benchFilter, allRecs, dest.runs]);
  const estRecs = useMemo(() => estimateRecords(route), [route]);
  const estimates = useMemo(() => estimateStats(route, estRecs), [route, estRecs]);
  const stats = useMemo(() => statsByRoute(route, benchRecs, estimates), [route, benchRecs, estimates]);
  const winnerId = useMemo(() => winner(route, stats), [route, stats]);
  const insight = useMemo(() => routeInsights(route, benchRecs), [route, benchRecs]);
  const profiles = useMemo(() => {
    const mine = strategyProfiles(route, allRecs);
    const est = strategyProfiles(route, estRecs);
    const out: Record<string, any> = {};
    for (const s of route.strategies) out[s.id] = mine[s.id] && mine[s.id].n >= 3 ? mine[s.id] : est[s.id];
    return out;
  }, [route, allRecs, estRecs]);
  const gambleCfg = insight.gamble?.enough ? { at: insight.gamble.cfg.at, strategy: insight.gamble.cfg.strategy, breakeven: insight.gamble.breakeven } : null;
  const views = useMemo(() => allRecs.map((r) => viewRun(route, r, gambleCfg)), [allRecs, route, gambleCfg?.breakeven]); // eslint-disable-line react-hooks/exhaustive-deps
  const matrix = useMemo(() => winMatrix(route, benchRecs), [route, benchRecs]);
  const geo = useMemo(() => strategyGeometry(route), [route]);
  const counts = useMemo(() => Object.fromEntries(state.destinations.map((d) => [d.id, d.runs.length + (d.samples?.n ?? 0)])), [state.destinations]);

  const onRecord = useCallback(
    (rec: any) => {
      update((s) => ({ ...s, destinations: s.destinations.map((d) => (d.id === dest.id ? { ...d, runs: [rec, ...d.runs] } : d)) }));
      setReceipt(viewRun(route, rec, gambleCfg));
      setFocusId(rec.id);
    },
    [dest.id, route, gambleCfg?.breakeven], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const trip = useTrip({ route, destId: dest.id, bikeThresholdMph: state.profile.bikeThresholdMph, onRecord });
  const scene = buildScene(trip.route, trip.snap, profiles, geo, trip.simStrategy);

  // ---------------------------------------------------------------- actions
  const selectDest = (id: string) => {
    if (trip.status === 'running') trip.cancel();
    update((s) => ({ ...s, activeId: id }));
    setLedgerFilter('ALL');
    setSheet(null);
    setReceipt(null);
  };
  const deleteDest = (id: string) => {
    update((s) => {
      const target = s.destinations.find((d) => d.id === id);
      if (!target || target.preset || s.destinations.length <= 1) return s;
      const rest = s.destinations.filter((d) => d.id !== id);
      return { ...s, destinations: rest, activeId: s.activeId === id ? rest[0].id : s.activeId };
    });
  };
  const seed = () =>
    update((s) => ({ ...s, destinations: s.destinations.map((d) => (d.id === dest.id ? { ...d, samples: { n: SAMPLE_TRIPS, seed: Math.floor(Math.random() * 1e6), endDate: Date.now() } } : d)) }));
  const deleteRun = (id: string) => {
    update((s) => ({ ...s, destinations: s.destinations.map((d) => (d.id === dest.id ? { ...d, runs: d.runs.filter((r) => r.id !== id) } : d)) }));
    setReceipt(null);
  };
  const created = (d: Destination) => {
    if (trip.status === 'running') trip.cancel();
    update((s) => ({ ...s, destinations: [...s.destinations, d], activeId: d.id }));
    setSheet(null);
    setNav('LIVE');
  };
  const closeReceipt = () => {
    setReceipt(null);
    trip.dismiss();
  };
  const openRun = (r: RunView) => {
    setFocusId(r.id);
    setReceipt(r);
  };

  const T = tokens;
  const headerBtn = { backgroundColor: T.tertiarySystemBackground, color: T.label };

  return (
    <ThemeCtx.Provider value={tokens}>
      <div style={{ backgroundColor: T.systemBackground, color: T.label, fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", system-ui, sans-serif' }} className="min-h-[100dvh] w-full flex justify-center items-start sm:py-4 select-none">
        <div style={{ backgroundColor: T.systemBackground, borderColor: T.separator }} className="w-full max-w-[430px] h-[100dvh] sm:h-[900px] sm:rounded-[40px] sm:border shadow-2xl relative overflow-hidden flex flex-col">
          {/* HEADER */}
          <header style={{ backgroundColor: T.secondarySystemBackground, borderColor: T.separator }} className="px-4 pt-3.5 pb-3 border-b z-30 flex items-center justify-between gap-2 shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <div style={{ backgroundColor: T.accent }} className="w-7 h-7 rounded-[8px] flex items-center justify-center text-white shadow-sm shrink-0" aria-hidden="true">
                <Navigation className="w-4 h-4" />
              </div>
              <button type="button" onClick={() => setSheet('switcher')} style={{ backgroundColor: T.accentSubtle, borderColor: T.accentBorder, color: T.accent }} className="h-8 px-3 rounded-full border flex items-center gap-1.5 text-[11.5px] font-bold tracking-tight active:scale-95 min-w-0" title="Switch destination or add Home → X">
                <span className="truncate">HOME → {destName.toUpperCase()}</span>
                <ChevronDown className="w-3.5 h-3.5 shrink-0" />
              </button>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button type="button" onClick={() => setSheet('whatif')} style={headerBtn} className="h-8 px-2.5 rounded-full flex items-center gap-1 text-[11.5px] font-semibold active:scale-95" title="Crossover break-even simulator" aria-label="Thresholds: crossover break-even simulator">
                <SlidersHorizontal className="w-3.5 h-3.5" style={{ color: T.accent }} />
                <span className="hidden min-[420px]:inline">Thresholds</span>
              </button>
              <button type="button" onClick={() => setSheet('switcher')} style={headerBtn} className="w-8 h-8 rounded-full flex items-center justify-center active:scale-95" aria-label="Account and destinations">
                <User className="w-4 h-4" style={{ color: T.accent }} />
              </button>
              <button type="button" onClick={() => update((s) => ({ ...s, theme: s.theme === 'dark' ? 'light' : 'dark' }))} style={{ backgroundColor: T.tertiarySystemBackground, color: T.secondaryLabel }} className="w-8 h-8 rounded-full flex items-center justify-center active:scale-95" aria-label="Toggle light or dark mode">
                {state.theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </button>
            </div>
          </header>

          {/* VIEWS */}
          {nav === 'LIVE' && (
            <Corridor
              route={trip.route}
              destName={destName}
              trip={trip}
              scene={scene}
              geo={geo}
              stats={stats}
              winnerId={winnerId}
              profiles={profiles}
              insight={insight}
              homeLabel={state.profile.homeOriginLabel}
              mapMode={state.mapMode}
              setMapMode={(m) => update((s) => ({ ...s, mapMode: m }))}
            />
          )}
          {nav === 'BENCHMARK' && (
            <Benchmark
              route={route}
              destName={destName}
              runs={benchRecs}
              allCount={allRecs.length}
              filter={benchFilter}
              setFilter={setBenchFilter}
              stats={stats}
              winnerId={winnerId}
              insight={insight}
              matrix={matrix}
              onSwitch={() => setSheet('switcher')}
              onSeed={seed}
              onLive={() => setNav('LIVE')}
            />
          )}
          {nav === 'RUNS' && (
            <Ledger route={route} destName={destName} runs={views} filter={ledgerFilter} setFilter={setLedgerFilter} focusId={focusId} onOpen={openRun} onNew={() => setSheet('setup')} onSeed={seed} />
          )}

          {/* TAB BAR */}
          <nav style={{ backgroundColor: T.secondarySystemBackground, borderColor: T.separator }} className="px-6 py-2.5 border-t flex items-center justify-around z-30 shrink-0" aria-label="Sections">
            {[
              { id: 'LIVE' as const, label: 'Corridor', icon: Navigation },
              { id: 'BENCHMARK' as const, label: 'Benchmark', icon: Activity },
              { id: 'RUNS' as const, label: 'Ledger', icon: Layers },
            ].map((tab) => {
              const Icon = tab.icon;
              const active = nav === tab.id;
              return (
                <button key={tab.id} type="button" onClick={() => setNav(tab.id)} style={{ color: active ? T.accent : T.secondaryLabel }} className="flex flex-col items-center gap-1 py-0.5 px-4" aria-current={active ? 'page' : undefined}>
                  <Icon className="w-5 h-5" />
                  <span className="text-[11px] font-semibold">{tab.label}</span>
                </button>
              );
            })}
          </nav>

          {/* SHEETS */}
          {sheet === 'switcher' && (
            <Switcher
              profile={state.profile}
              destinations={state.destinations}
              activeId={dest.id}
              counts={counts}
              onSelect={selectDest}
              onDelete={deleteDest}
              onNew={() => setSheet('setup')}
              onAccount={() => setSheet('account')}
              onClose={() => setSheet(null)}
            />
          )}
          {sheet === 'account' && (
            <Account profile={state.profile} theme={state.theme} onSave={(p) => update((s) => ({ ...s, profile: p }))} onTheme={() => update((s) => ({ ...s, theme: s.theme === 'dark' ? 'light' : 'dark' }))} onClose={() => setSheet(null)} />
          )}
          {sheet === 'whatif' && <WhatIf route={route} destName={destName} profiles={profiles} insight={insight} onClose={() => setSheet(null)} />}
          {sheet === 'setup' && <RouteSetup nyc={nyc} homeDefault={{ label: route.home.name, pos: route.home.pos }} onCancel={() => setSheet(null)} onCreate={created} />}
          {receipt && <Receipt run={receipt} route={route} destName={destName} allRuns={allRecs} onClose={closeReceipt} onDelete={() => deleteRun(receipt.id)} />}
        </div>
      </div>
    </ThemeCtx.Provider>
  );
}
