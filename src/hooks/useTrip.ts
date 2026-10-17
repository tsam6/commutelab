import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createEngine } from '../engine/engine.js';
import { samplePlan } from '../engine/model.js';
import { createSimulator } from '../engine/simulator.js';
import { createRng } from '../engine/rng.js';
import { loadLive, saveLive, type LiveSession } from '../lib/store';

export type TripMode = 'sim' | 'live';
export type TripStatus = 'idle' | 'running' | 'arrived';
export type Injection = 'errand' | 'red' | 'crawl' | 'late';

/**
 * One commute at a time. In Sim mode a simulated commuter (taking the option you pick, hidden from
 * the detector) feeds 1 Hz GPS fixes to the engine at 1x/20x/60x. In Real GPS mode the browser's
 * watchPosition does. Either way the engine alone decides phases, the option taken and the time.
 */
export function useTrip({ route, destId, bikeThresholdMph, onRecord }: { route: any; destId: string; bikeThresholdMph: number; onRecord: (rec: any) => void }) {
  const [mode, setMode] = useState<TripMode>('sim');
  const [speed, setSpeed] = useState(20);
  const [simStrategy, setSimStrategy] = useState<string | null>(null);
  const [status, setStatus] = useState<TripStatus>('idle');
  const [snap, setSnap] = useState<any>(null);
  const [gps, setGps] = useState('Simulated telemetry');
  const [notice, setNotice] = useState<string | null>(null);
  const [resumable, setResumable] = useState<LiveSession | null>(null);
  const eng = useRef<any>(null);
  const sim = useRef<any>(null);
  const runMode = useRef<TripMode>('sim');
  const watch = useRef<number | null>(null);
  const wake = useRef<any>(null);
  const carry = useRef(0);
  const liveSession = useRef<LiveSession | null>(null);
  const onRecordRef = useRef(onRecord);
  onRecordRef.current = onRecord;

  const effRoute = useMemo(
    () => ({ ...route, thresholds: { ...route.thresholds, bikeStartSpeed: Math.max(2, bikeThresholdMph / 2.23694) } }),
    [route, bikeThresholdMph],
  );

  // A different destination resets everything.
  useEffect(() => {
    stopDevices();
    eng.current = null;
    sim.current = null;
    setStatus('idle');
    setSnap(null);
    setSimStrategy(route.strategies[0]?.id ?? null);
    const saved = loadLive();
    setResumable(saved && saved.destId === destId ? saved : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destId, route.id]);

  function stopDevices() {
    if (watch.current != null && 'geolocation' in navigator) navigator.geolocation.clearWatch(watch.current);
    watch.current = null;
    wake.current?.release?.().catch(() => undefined);
    wake.current = null;
  }

  const requestWake = async () => {
    try {
      wake.current = await (navigator as any).wakeLock?.request('screen');
    } catch {
      /* not supported or not allowed: the trip still runs */
    }
  };

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible' && status === 'running' && runMode.current === 'live') requestWake();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [status]);

  useEffect(() => () => stopDevices(), []);

  const complete = useCallback((rec: any) => {
    stopDevices();
    if (runMode.current === 'live') {
      saveLive(null);
      liveSession.current = null;
    }
    if (sim.current?.truth) rec.simTruth = sim.current.truth;
    setSnap(eng.current?.snapshot() ?? null);
    setStatus('arrived');
    onRecordRef.current(rec);
  }, []);

  function startGps(e: any, session: LiveSession) {
    if (!('geolocation' in navigator)) {
      setGps('Geolocation unavailable');
      return;
    }
    setGps(window.isSecureContext ? 'Locking GPS…' : 'GPS needs HTTPS');
    liveSession.current = session;
    watch.current = navigator.geolocation.watchPosition(
      (pos) => {
        const fix = {
          t: pos.timestamp || Date.now(),
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          speed: pos.coords.speed != null && pos.coords.speed >= 0 ? pos.coords.speed : null,
        };
        const s = e.push(fix);
        session.samples.push(fix);
        if (session.samples.length % 5 === 0) saveLive(session);
        setGps(`Live GPS (±${Math.round(pos.coords.accuracy || 0)}m)`);
        if (s.state === 'arrived') complete(s.record);
        else setSnap(e.snapshot());
      },
      (err) => setGps(err.code === 1 ? 'Location permission denied' : 'GPS signal lost — still tracking'),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
    );
    requestWake();
  }

  const start = () => {
    stopDevices();
    setNotice(null);
    const e = createEngine(effRoute, { source: mode === 'sim' ? 'sim' : 'live' });
    eng.current = e;
    carry.current = 0;
    runMode.current = mode;
    if (mode === 'sim') {
      const sid = simStrategy ?? effRoute.strategies[0].id;
      const seed = (Date.now() % 1000003) + 1;
      const plan = samplePlan(effRoute, sid, createRng(seed), { startTime: Date.now() });
      sim.current = createSimulator(plan, { seed, noiseM: 3 });
      sim.current.truth = sid;
      setGps('Simulated telemetry');
    } else {
      sim.current = null;
      startGps(e, { destId, startedAt: Date.now(), samples: [] });
    }
    setSnap(e.snapshot());
    setStatus('running');
  };

  const resume = () => {
    const saved = loadLive();
    if (!saved || saved.destId !== destId) return;
    const e = createEngine(effRoute, { source: 'live' });
    for (const fix of saved.samples) e.push(fix);
    eng.current = e;
    sim.current = null;
    runMode.current = 'live';
    setMode('live');
    setResumable(null);
    setSnap(e.snapshot());
    setStatus('running');
    startGps(e, saved);
  };

  const discardResume = () => {
    saveLive(null);
    setResumable(null);
  };

  // Simulator clock: 4 ticks a second, `speed` simulated seconds per real second.
  useEffect(() => {
    if (status !== 'running' || runMode.current !== 'sim') return;
    const id = setInterval(() => {
      const e = eng.current;
      const s = sim.current;
      if (!e || !s) return;
      carry.current += speed / 4;
      let n = Math.floor(carry.current);
      carry.current -= n;
      while (n-- > 0) {
        const fix = s.step();
        if (!fix) break;
        if (e.push(fix).state === 'arrived') break;
      }
      const now = e.snapshot();
      if (now.state === 'arrived') complete(now.record);
      else if (s.done) {
        const rec = e.finish();
        if (rec) complete(rec);
        else {
          setStatus('idle');
          setSnap(null);
          setNotice('The simulated trip ended before a train was detected.');
        }
      } else setSnap(now);
    }, 250);
    return () => clearInterval(id);
  }, [status, speed, complete]);

  const cancel = () => {
    stopDevices();
    if (runMode.current === 'live') saveLive(null);
    eng.current = null;
    sim.current = null;
    setStatus('idle');
    setSnap(null);
  };

  /** Sim: skip to arrival. Real GPS: end the trip here (for when GPS missed an underground arrival). */
  const end = () => {
    const e = eng.current;
    if (!e) return;
    if (runMode.current === 'sim' && sim.current) {
      for (let fix = sim.current.step(); fix; fix = sim.current.step()) if (e.push(fix).state === 'arrived') break;
    }
    const rec = e.record ?? e.finish();
    if (rec) complete(rec);
    else {
      cancel();
      setNotice('Nothing saved: the benchmark needs at least one train ride.');
    }
  };

  const inject = (kind: Injection) => {
    const s = sim.current;
    if (!s) return false;
    if (kind === 'errand') s.injectDelay(90, 'errand');
    else if (kind === 'red') s.injectDelay(35, 'redlight');
    else if (kind === 'late') s.injectDelay(120, 'late');
    else if (kind === 'crawl') return s.injectSlow(150) > 0;
    return true;
  };

  const dismiss = () => {
    if (status === 'arrived') {
      setStatus('idle');
      setSnap(null);
    }
  };

  return {
    mode,
    setMode: (m: TripMode) => status === 'idle' && setMode(m),
    speed,
    setSpeed,
    simStrategy,
    setSimStrategy,
    status,
    snap,
    gps: mode === 'sim' && status === 'idle' ? 'Simulated telemetry' : gps,
    notice,
    setNotice,
    start,
    cancel,
    end,
    inject,
    dismiss,
    resumable,
    resume,
    discardResume,
    truth: sim.current?.truth ?? null,
    route: effRoute,
  };
}

export type Trip = ReturnType<typeof useTrip>;
