import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { ArrowRight, Bike, CheckCircle2, ChevronDown, ChevronUp, Loader2, MapPin, Plus, Search, Undo2, X } from 'lucide-react';
import { useT } from '../theme';
import { formatMinSec } from '../lib/format';
import { geosearch, osrmRoute, type Place } from '../lib/services';
import { buildRoute, connections, nearestDocks, nodeOf, optionCodes, stationsNear, STRATEGY_COLORS } from '../nyc/build-route.js';
import { DEFAULT_THRESHOLDS } from '../engine/routes.js';
import { haversine } from '../engine/geo.js';
import { SAMPLE_TRIPS, type Nyc } from '../nyc/data';
import type { Destination } from '../lib/store';
import { createMap, fc, FONT, halo, line, ll, point, quietBasemap, setData } from './mapkit';
import { CloseBtn, destIcon } from './Sheets';

type Pin = { label: string; pos: [number, number] };
type Opt = { stops: string[]; routes: string[][] };

const ADVANCED: { k: keyof typeof DEFAULT_THRESHOLDS; label: string; unit: string; step: number }[] = [
  { k: 'alightDwellSec', label: 'Standing still this long at a change station means you got off', unit: 's', step: 5 },
  { k: 'stationConfirmSec', label: 'Time inside a station before the bike leg ends', unit: 's', step: 1 },
  { k: 'trainSpeed', label: 'Sustained speed that means you are on a train', unit: 'm/s', step: 0.5 },
  { k: 'trainSustainSec', label: '…held for', unit: 's', step: 1 },
  { k: 'redLightMinSec', label: 'A bike stop at least this long counts as a red light', unit: 's', step: 1 },
  { k: 'crawlSpeed', label: 'A train slower than this between stations is crawling', unit: 'm/s', step: 0.5 },
  { k: 'crawlFlagSec', label: 'Crawl time that flags a slow first train', unit: 's', step: 5 },
  { k: 'maxAccuracyM', label: 'Ignore GPS fixes less accurate than', unit: 'm', step: 5 },
  { k: 'arrivalConfirmSec', label: 'Stopped this long at your last station means you arrived', unit: 's', step: 1 },
];

function AddressBox({ label, value, onPick, onPinMode, pinning, placeholder }: { label: string; value: Pin | null; onPick: (p: Pin) => void; onPinMode: () => void; pinning: boolean; placeholder: string }) {
  const T = useT();
  const [text, setText] = useState(value?.label ?? '');
  const [hits, setHits] = useState<Place[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => setText(value?.label ?? ''), [value?.label]);
  useEffect(() => {
    if (!open || text.trim().length < 3) {
      setHits([]);
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      geosearch(text, ctl.signal)
        .then((h) => { setHits(h); setErr(null); })
        .catch((e) => { if (e.name !== 'AbortError') setErr('Address search is unreachable. Drop a pin on the map instead.'); });
    }, 250);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [text, open]);
  return (
    <div className="relative">
      <span style={{ color: T.secondaryLabel }} className="text-[11px] font-semibold block mb-1">{label}</span>
      <div className="flex gap-1.5">
        <div style={{ backgroundColor: T.tertiarySystemBackground, borderColor: T.separator }} className="flex-1 flex items-center gap-2 px-3 rounded-[8px] border">
          <Search className="w-3.5 h-3.5 shrink-0" style={{ color: T.tertiaryLabel }} />
          <input
            type="text"
            value={text}
            placeholder={placeholder}
            onChange={(e) => { setText(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            style={{ color: T.label }}
            className="flex-1 py-2 bg-transparent text-[13px] font-medium focus:outline-none min-w-0"
            aria-label={label}
          />
        </div>
        <button type="button" onClick={onPinMode} style={{ backgroundColor: pinning ? T.accent : T.tertiarySystemBackground, color: pinning ? '#fff' : T.label }} className="px-2.5 rounded-[8px] text-[11px] font-semibold flex items-center gap-1 shrink-0" aria-pressed={pinning} title="Drop a pin on the map instead">
          <MapPin className="w-3.5 h-3.5" /> Pin
        </button>
      </div>
      {open && (hits.length > 0 || err) && (
        <div style={{ backgroundColor: T.elevatedSheet, borderColor: T.separator }} className="absolute z-30 left-0 right-0 mt-1 rounded-[12px] border shadow-2xl overflow-hidden">
          {err && <div style={{ color: T.statusDelayed }} className="px-3 py-2 text-[12px]">{err}</div>}
          {hits.map((h, i) => (
            <button key={i} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { onPick({ label: h.label, pos: h.pos }); setText(h.label); setOpen(false); }} style={{ borderColor: T.separator }} className="w-full text-left px-3 py-2 text-[12.5px] border-b last:border-b-0">
              <div className="font-semibold truncate">{h.name}</div>
              <div style={{ color: T.secondaryLabel }} className="text-[11px] truncate">{h.label}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Interactive map for setup: tap stations and docks, or drop a pin. */
function SetupMap({ nyc, home, dest, dockId, draft, preview, placing, onStation, onDock, onPlace, flyTo }: {
  nyc: Nyc; home: Pin | null; dest: Pin | null; dockId: string | null; draft: string[]; preview: any; placing: boolean;
  onStation: (id: string) => void; onDock: (id: string) => void; onPlace: (pos: [number, number]) => void; flyTo: number[] | null;
}) {
  const T = useT();
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const ready = useRef(false);
  const latest = useRef<any>(null);
  latest.current = { home, dest, dockId, draft, preview, placing, onStation, onDock, onPlace };
  const pins = useRef<{ home?: maplibregl.Marker; dest?: maplibregl.Marker }>({});
  const tokens = useRef(T);
  tokens.current = T;

  useEffect(() => {
    const map = createMap(box.current!, tokens.current.mapStyle);
    mapRef.current = map;
    map.on('style.load', () => {
      const t = tokens.current;
      quietBasemap(map, t.isDark);
      const stations = [...nyc.idx.byNode.values()].map((c: any) => point(c.pos, { id: c.id, label: c.name, routes: c.routes.join(' ') }));
      setData(map, 'su-st', fc(stations));
      setData(map, 'su-docks', fc([]));
      setData(map, 'su-lines', fc([]));
      setData(map, 'su-sel', fc([]));
      map.addLayer({ id: 'su-lines', type: 'line', source: 'su-lines', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': ['case', ['get', 'bike'], 2.5, 4], 'line-opacity': 0.9 } });
      map.addLayer({ id: 'su-docks', type: 'circle', source: 'su-docks', paint: { 'circle-radius': ['case', ['get', 'on'], 8, 5], 'circle-color': t.phase.bike, 'circle-stroke-color': ['case', ['get', 'on'], '#ffffff', t.isDark ? '#0b0d12' : '#ffffff'], 'circle-stroke-width': ['case', ['get', 'on'], 3, 1.5] } });
      map.addLayer({ id: 'su-st', type: 'circle', source: 'su-st', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2.5, 14, 6], 'circle-color': t.isDark ? '#f8fafc' : '#ffffff', 'circle-stroke-color': t.isDark ? '#0b0d12' : '#0f172a', 'circle-stroke-width': 1.5 } });
      map.addLayer({ id: 'su-sel', type: 'circle', source: 'su-sel', paint: { 'circle-radius': 11, 'circle-color': t.accent, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 } });
      map.addLayer({ id: 'su-sel-n', type: 'symbol', source: 'su-sel', layout: { 'text-field': ['get', 'n'], 'text-font': FONT, 'text-size': 11, 'text-allow-overlap': true }, paint: { 'text-color': '#ffffff' } });
      map.addLayer({
        id: 'su-st-label', type: 'symbol', source: 'su-st', minzoom: 12.6,
        layout: { 'text-field': ['concat', ['get', 'label'], '\n', ['get', 'routes']], 'text-font': FONT, 'text-size': 10.5, 'text-anchor': 'left', 'text-offset': [0.9, 0], 'text-justify': 'left', 'text-max-width': 12 },
        paint: { 'text-color': t.label, ...halo(t.isDark) },
      });
      ready.current = true;
      refresh();
      fit();
    });
    map.on('click', (e) => {
      const L = latest.current;
      const bbox: [maplibregl.PointLike, maplibregl.PointLike] = [[e.point.x - 10, e.point.y - 10], [e.point.x + 10, e.point.y + 10]];
      if (!L.placing) {
        const st = map.queryRenderedFeatures(bbox, { layers: ['su-sel', 'su-st'] }).find((f) => f.layer.id === 'su-st');
        if (st) return L.onStation(st.properties.id);
        const dk = map.queryRenderedFeatures(bbox, { layers: ['su-docks'] })[0];
        if (dk) return L.onDock(String(dk.properties.id));
      }
      if (L.placing) L.onPlace([e.lngLat.lat, e.lngLat.lng]);
    });
    map.on('mouseenter', 'su-st', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'su-st', () => { map.getCanvas().style.cursor = ''; });
    return () => { map.remove(); mapRef.current = null; ready.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => refresh());
  useEffect(() => fit(), [home?.pos?.join(), dest?.pos?.join()]);
  useEffect(() => {
    if (flyTo && mapRef.current) mapRef.current.easeTo({ center: ll(flyTo), zoom: Math.max(14, mapRef.current.getZoom()), duration: 400 });
  }, [flyTo?.join()]);

  function fit() {
    const map = mapRef.current;
    if (!map) return;
    const pts = [home?.pos, dest?.pos].filter(Boolean) as number[][];
    if (pts.length === 1) map.jumpTo({ center: ll(pts[0]), zoom: 14 });
    else if (pts.length === 2) {
      const b = new maplibregl.LngLatBounds(ll(pts[0]), ll(pts[0]));
      b.extend(ll(pts[1]));
      map.fitBounds(b, { padding: 50, duration: 0, maxZoom: 15 });
    }
  }

  function refresh() {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    const L = latest.current;
    const t = tokens.current;
    const docks = L.home ? nearestDocks(nyc.idx, L.home.pos, 12).filter((d: any) => d.dist < 1500) : [];
    setData(map, 'su-docks', fc(docks.map((d: any) => point(d.pos, { id: d.id, on: d.id === L.dockId }))));
    const lines: any[] = [];
    if (L.preview) {
      for (const ln of L.preview.lines) lines.push(line(ln.path, { color: ln.color, bike: false }));
      for (const [k, p] of Object.entries(L.preview.paths ?? {})) if (k.startsWith('bike:')) lines.push(line(p as number[][], { color: t.phase.bike, bike: true }));
    }
    setData(map, 'su-lines', fc(lines));
    setData(map, 'su-sel', fc(L.draft.map((id: string, i: number) => {
      const c = nyc.idx.byNode.get(id);
      return c ? point(c.pos, { n: String(i + 1) }) : null;
    }).filter(Boolean)));
    for (const [k, pin, color] of [['home', L.home, '#f8fafc'], ['dest', L.dest, t.accent]] as const) {
      if (pin) {
        pins.current[k] ??= new maplibregl.Marker({ element: Object.assign(document.createElement('div'), { className: 'cl-pin', style: `background:${color}` }), anchor: 'bottom' });
        pins.current[k]!.setLngLat(ll(pin.pos)).addTo(map);
      } else pins.current[k]?.remove();
    }
    map.getCanvas().style.cursor = L.placing ? 'crosshair' : '';
  }

  return <div ref={box} className={`absolute inset-0 ${T.isDark ? 'cl-dark' : 'cl-light'}`} aria-label="Map: tap stations and docks" />;
}

export default function RouteSetup({ nyc, homeDefault, onCancel, onCreate }: { nyc: Nyc; homeDefault: Pin | null; onCancel: () => void; onCreate: (d: Destination) => void }) {
  const T = useT();
  const idx = nyc.idx;
  const [step, setStep] = useState(1);
  const [home, setHome] = useState<Pin | null>(homeDefault);
  const [dest, setDest] = useState<Pin | null>(null);
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('office');
  const [placing, setPlacing] = useState<'home' | 'dest' | null>(null);
  const [dockChoice, setDockChoice] = useState<string | null>(null);
  const [options, setOptions] = useState<Opt[]>([]);
  const [draft, setDraft] = useState<Opt>({ stops: [], routes: [] });
  const [toast, setToast] = useState<string | null>(null);
  const [seed, setSeed] = useState(true);
  const [adv, setAdv] = useState(false);
  const [th, setTh] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [flyTo, setFlyTo] = useState<number[] | null>(null);

  const docks = useMemo(() => (home ? nearestDocks(idx, home.pos, 5) : []), [idx, home]);
  const dock = dockChoice ?? docks[0]?.id ?? 'own';
  const nearHome = useMemo(() => (home ? stationsNear(idx, home.pos, 3000).slice(0, 8) : []), [idx, home]);
  const nearDest = useMemo(() => (dest ? stationsNear(idx, dest.pos, 1200).slice(0, 6) : []), [idx, dest]);

  const setupFor = (opts: Opt[], paths?: any) => ({
    name: name.trim() || dest?.label.split(',')[0] || 'X',
    icon,
    home: { label: home?.label ?? 'Home', pos: home?.pos },
    destination: dest ? { label: dest.label, pos: dest.pos } : null,
    dock,
    options: opts,
    paths,
    thresholds: th,
  });
  const liveOpts = useMemo(() => [...options, ...(draft.stops.length >= 2 ? [draft] : [])], [options, draft]);
  const preview = useMemo(() => {
    if (!home || !liveOpts.length) return null;
    try {
      return buildRoute(idx, setupFor(liveOpts)).route;
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, home, dest, dock, liveOpts]);
  const codes = optionCodes(liveOpts.map((o) => ({ stops: o.stops })));

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 4000);
  };

  const tapStation = (id: string) => {
    const node = nodeOf(idx, id);
    if (!node) return;
    setFlyTo(node.pos);
    if (step !== 2) return;
    const last = draft.stops[draft.stops.length - 1];
    if (last === node.id) return;
    if (draft.stops.includes(node.id)) return flash(`${node.name} is already in this option.`);
    if (last && !connections(idx, last, node.id).length) {
      return flash(`No train runs from ${nodeOf(idx, last).name} to ${node.name} without changing. Tap the station where you change first.`);
    }
    setDraft({ stops: [...draft.stops, node.id], routes: last ? [...draft.routes, []] : draft.routes });
  };

  const toggleRoute = (leg: number, routes: string[]) => {
    const auto = connections(idx, draft.stops[leg], draft.stops[leg + 1])[0]?.routes ?? [];
    const cur = draft.routes[leg]?.length ? draft.routes[leg] : auto;
    const has = routes.every((r) => cur.includes(r));
    let next = has ? cur.filter((r) => !routes.includes(r)) : [...new Set([...cur, ...routes])];
    if (!next.length) next = routes; // always keep at least one train for the ride
    const rs = draft.routes.slice();
    rs[leg] = next;
    setDraft({ ...draft, routes: rs });
  };

  const commitDraft = () => {
    if (draft.stops.length < 2) return;
    setOptions([...options, draft]);
    setDraft({ stops: [], routes: [] });
  };

  const create = async () => {
    if (!home) return;
    const opts = liveOpts;
    setBusy('Drawing your bike and walking routes…');
    const draftRoute = buildRoute(idx, setupFor(opts)).route;
    const paths: any = { bike: {} };
    const d0 = draftRoute.docks[0];
    if (!d0.own) {
      const walk = await osrmRoute(home.pos, d0.pos, 'foot');
      paths.walk = walk && walk.meters <= 2 * haversine(home.pos, d0.pos) + 40 ? walk.path : [home.pos, d0.pos];
    }
    for (const s of draftRoute.strategies) {
      const o = s.legs[0].from;
      if (paths.bike[o]) continue;
      const straight = draftRoute.paths[`bike:${o}`];
      const r = await osrmRoute(straight[0], straight[straight.length - 1], 'bike');
      paths.bike[o] = r?.path ?? straight;
    }
    const setup = setupFor(opts, paths);
    const { route, problems } = buildRoute(idx, setup);
    setBusy(null);
    if (problems.length) return flash(problems[0]);
    onCreate({ id: route.id, setup, route, runs: [], samples: seed ? { n: SAMPLE_TRIPS, seed: Math.floor(Math.random() * 1e6), endDate: Date.now() } : null });
  };

  const field = { backgroundColor: T.tertiarySystemBackground, borderColor: T.separator, color: T.label };
  const canNext = step === 1 ? !!home && !!dest : step === 2 ? liveOpts.length > 0 : true;
  const stName = (id: string) => nodeOf(idx, id)?.name ?? id;

  const stationChip = (c: any, sub: string) => (
    <button key={c.id} type="button" onClick={() => tapStation(c.id)} style={{ backgroundColor: T.secondarySystemBackground, borderColor: draft.stops.includes(c.id) ? T.accent : T.separator }} className="px-2.5 py-1.5 rounded-full border text-[11.5px] font-semibold flex items-center gap-1.5 shrink-0">
      <span className="truncate max-w-[130px]">{c.name}</span>
      <span style={{ color: T.secondaryLabel }} className="font-medium tnum">{c.routes.slice(0, 4).join(' ')}{c.routes.length > 4 ? '…' : ''} · {sub}</span>
    </button>
  );

  return (
    <div className="absolute inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-end justify-center" role="dialog" aria-modal="true" aria-label="New destination">
      <div style={{ backgroundColor: T.elevatedSheet, borderColor: T.separator }} className="w-full h-[94%] rounded-t-[16px] border-t flex flex-col overflow-hidden">
        {/* header */}
        <div className="px-5 pt-4 pb-3 space-y-3 shrink-0">
          <div className="flex items-start justify-between gap-2">
            <div>
              <span style={{ backgroundColor: T.accentSubtle, color: T.accent }} className="text-[10.5px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full">Step {step} of 3</span>
              <h3 className="text-[20px] font-bold mt-1">{step === 1 ? 'Where are you going?' : step === 2 ? 'How do you get there?' : 'Review & Launch'}</h3>
            </div>
            <CloseBtn onClick={onCancel} />
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {[1, 2, 3].map((s) => (
              <button key={s} type="button" onClick={() => (s < step || canNext) && s <= (home && dest ? (liveOpts.length ? 3 : 2) : 1) && setStep(s)} style={{ backgroundColor: s <= step ? T.accent : T.tertiarySystemBackground }} className="h-1.5 rounded-full" aria-label={`Step ${s}`} />
            ))}
          </div>
        </div>

        {/* map */}
        {step < 3 && (
          <div className="relative h-[36%] min-h-[210px] shrink-0" style={{ backgroundColor: T.mapCanvas }}>
            <SetupMap
              nyc={nyc}
              home={home}
              dest={dest}
              dockId={dock === 'own' ? null : dock}
              draft={draft.stops}
              preview={preview}
              placing={!!placing}
              onStation={tapStation}
              onDock={(id) => setDockChoice(id)}
              onPlace={(pos) => {
                const pin = { label: placing === 'home' ? 'Dropped pin (home)' : 'Dropped pin', pos };
                if (placing === 'home') setHome(pin);
                else setDest(pin);
                setPlacing(null);
              }}
              flyTo={flyTo}
            />
            {placing && (
              <div style={{ backgroundColor: T.accent }} className="absolute top-2 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full text-white text-[12px] font-semibold shadow-lg">
                Tap the map to place {placing === 'home' ? 'home' : 'your destination'}
              </div>
            )}
            {toast && (
              <div style={{ backgroundColor: T.elevatedSheet, borderColor: T.statusDelayed, color: T.label }} className="absolute bottom-2 left-2 right-2 px-3 py-2 rounded-[12px] border text-[12px] shadow-lg" role="alert">
                {toast}
              </div>
            )}
          </div>
        )}

        {/* body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 text-[13px]">
          {step === 1 && (
            <>
              <AddressBox label="From (home)" placeholder="Search an address, e.g. 120 E 4th St" value={home} onPick={setHome} pinning={placing === 'home'} onPinMode={() => setPlacing(placing === 'home' ? null : 'home')} />
              <AddressBox label="To (destination)" placeholder="Search an address or place" value={dest} onPick={(p) => { setDest(p); if (!name) setName(p.label.split(',')[0]); }} pinning={placing === 'dest'} onPinMode={() => setPlacing(placing === 'dest' ? null : 'dest')} />
              <div className="grid grid-cols-[1fr_auto] gap-2.5 items-end">
                <label className="space-y-1 block">
                  <span style={{ color: T.secondaryLabel }} className="text-[11px] font-semibold block">Destination name (X)</span>
                  <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Internship Office" style={field} className="w-full px-3 py-2 rounded-[8px] border font-semibold focus:outline-none" />
                </label>
                <div className="flex gap-1" role="group" aria-label="Icon">
                  {['school', 'lab', 'office'].map((ic) => (
                    <button key={ic} type="button" onClick={() => setIcon(ic)} style={{ backgroundColor: icon === ic ? T.accent : T.tertiarySystemBackground, color: icon === ic ? '#fff' : T.secondaryLabel }} className="w-9 h-9 rounded-[10px] flex items-center justify-center" aria-pressed={icon === ic} aria-label={ic}>
                      {destIcon(ic)}
                    </button>
                  ))}
                </div>
              </div>
              <p style={{ color: T.tertiaryLabel }} className="text-[11.5px]">Addresses are looked up with NYC Planning's GeoSearch. Use Pin to place a spot by hand instead.</p>
            </>
          )}

          {step === 2 && (
            <>
              <div>
                <span style={{ color: T.secondaryLabel }} className="text-[11px] font-semibold flex items-center gap-1 mb-1.5"><Bike className="w-3.5 h-3.5" /> Bike from (tap a green dot on the map to change)</span>
                <div className="flex gap-1.5 overflow-x-auto no-scrollbar pb-0.5">
                  {docks.map((d) => (
                    <button key={d.id} type="button" onClick={() => { setDockChoice(d.id); setFlyTo(d.pos); }} style={{ backgroundColor: dock === d.id ? T.phase.bike : T.secondarySystemBackground, color: dock === d.id ? '#0B0D12' : T.label, borderColor: T.separator }} className="px-2.5 py-1.5 rounded-full border text-[11.5px] font-semibold shrink-0 tnum">
                      {d.name} · {Math.round(d.dist)} m
                    </button>
                  ))}
                  <button type="button" onClick={() => setDockChoice('own')} style={{ backgroundColor: dock === 'own' ? T.phase.bike : T.secondarySystemBackground, color: dock === 'own' ? '#0B0D12' : T.label, borderColor: T.separator }} className="px-2.5 py-1.5 rounded-full border text-[11.5px] font-semibold shrink-0">
                    My own bike (from home)
                  </button>
                </div>
              </div>

              {options.length > 0 && (
                <div className="space-y-1.5">
                  {options.map((o, i) => (
                    <div key={i} style={{ backgroundColor: T.secondarySystemBackground, borderColor: T.separator }} className="p-2.5 rounded-[12px] border flex items-center gap-2">
                      <span className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0" style={{ backgroundColor: STRATEGY_COLORS[i % STRATEGY_COLORS.length], color: '#0B0D12' }}>{codes[i]}</span>
                      <span className="flex-1 min-w-0 truncate font-semibold">{preview?.strategies?.[i]?.desc ?? o.stops.map(stName).join(' → ')}</span>
                      <button type="button" onClick={() => setOptions(options.filter((_, j) => j !== i))} style={{ color: T.tertiaryLabel }} aria-label={`Remove option ${codes[i]}`}><X className="w-4 h-4" /></button>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ backgroundColor: T.secondarySystemBackground, borderColor: draft.stops.length ? T.accent : T.separator }} className="p-3 rounded-[12px] border space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-bold">{options.length ? `Another way (option ${options.length + 1})` : 'Your first way to get there'}</span>
                  {draft.stops.length > 0 && (
                    <button type="button" onClick={() => setDraft({ stops: draft.stops.slice(0, -1), routes: draft.routes.slice(0, Math.max(0, draft.stops.length - 2)) })} style={{ color: T.secondaryLabel }} className="text-[11.5px] font-semibold flex items-center gap-1">
                      <Undo2 className="w-3.5 h-3.5" /> Undo
                    </button>
                  )}
                </div>
                {draft.stops.length === 0 ? (
                  <p style={{ color: T.secondaryLabel }} className="text-[12px] leading-relaxed">Tap the station you bike to, then each station where you change trains, then the one you get off at. Tap stations on the map or pick them below.</p>
                ) : (
                  <div className="space-y-2">
                    {draft.stops.map((id, i) => (
                      <div key={id}>
                        <div className="flex items-center gap-2">
                          <span style={{ backgroundColor: T.accent }} className="w-5 h-5 rounded-full text-white text-[10px] font-bold flex items-center justify-center shrink-0">{i + 1}</span>
                          <span className="font-semibold truncate">{stName(id)}</span>
                          <span style={{ color: T.tertiaryLabel }} className="text-[11px] shrink-0">{i === 0 ? 'bike here' : i === draft.stops.length - 1 ? 'get off' : 'change'}</span>
                        </div>
                        {i < draft.stops.length - 1 && (
                          <div className="ml-7 my-1.5 flex flex-wrap gap-1.5">
                            {connections(idx, id, draft.stops[i + 1]).slice(0, 5).map((c: any, ci: number) => {
                              const sel = draft.routes[i] ?? [];
                              const on = sel.length ? c.routes.some((r: string) => sel.includes(r)) : ci === 0;
                              return (
                                <button key={c.key} type="button" onClick={() => toggleRoute(i, c.routes)} style={{ backgroundColor: on ? c.color : T.tertiarySystemBackground, color: on ? c.text : T.label, borderColor: T.separator }} className="px-2.5 py-1 rounded-full border text-[11px] font-bold tnum" aria-pressed={on} title={`${c.nStops} stop${c.nStops === 1 ? '' : 's'}, about ${Math.round(c.sec / 60)} min, every ~${Math.round(c.headway / 60)} min`}>
                                  {c.label}
                                  {c.kind ? ` ${c.kind}` : ''} · {c.nStops} stop{c.nStops === 1 ? '' : 's'} · ~{Math.round(c.sec / 60)}m
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ))}
                    <p style={{ color: T.tertiaryLabel }} className="text-[11px]">Pick more than one train for a ride to take whichever comes first.</p>
                  </div>
                )}
                <div className="flex gap-1.5 overflow-x-auto no-scrollbar">
                  {(draft.stops.length === 0 ? nearHome : nearDest.length ? nearDest : nearHome).map((c: any) => stationChip(c, `${(c.dist / 1000).toFixed(1)} km`))}
                </div>
                <div style={{ color: T.tertiaryLabel }} className="text-[10.5px]">{draft.stops.length === 0 ? 'Stations near home' : 'Stations near your destination'} · or tap any station on the map</div>
                {draft.stops.length >= 2 && (
                  <button type="button" onClick={commitDraft} style={{ backgroundColor: T.tertiarySystemBackground, color: T.label }} className="w-full h-10 rounded-full font-semibold text-[13px] flex items-center justify-center gap-1.5">
                    <Plus className="w-4 h-4" /> Add another way
                  </button>
                )}
              </div>
            </>
          )}

          {step === 3 && preview && (
            <>
              <div style={{ backgroundColor: T.secondarySystemBackground, borderColor: T.separator }} className="p-3.5 rounded-[16px] border space-y-2">
                <div className="flex items-center gap-2">
                  {destIcon(icon)}
                  <span className="text-[15px] font-bold">{preview.name}</span>
                </div>
                <div style={{ color: T.secondaryLabel }} className="text-[12px]">
                  {home?.label} → {dest?.label} · bike from {preview.docks[0].own ? 'home' : preview.docks[0].name}
                </div>
                <div className="space-y-1.5 pt-1">
                  {preview.strategies.map((s: any) => {
                    const sched = s.legs.reduce((a: number, l: any) => a + (preview.lines.find((x: any) => x.id === l.lines[0])?.schedSec ?? 0), 0);
                    return (
                      <div key={s.id} className="flex items-center gap-2">
                        <span className="w-6 h-6 rounded-full text-[10px] font-bold flex items-center justify-center shrink-0" style={{ backgroundColor: s.color, color: '#0B0D12' }}>{s.id}</span>
                        <span className="flex-1 min-w-0 truncate font-semibold">{s.desc}</span>
                        <span style={{ color: T.secondaryLabel }} className="text-[11px] tnum shrink-0">{formatMinSec(sched)} on trains</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              <button type="button" onClick={() => setSeed(!seed)} style={{ backgroundColor: seed ? T.accentSubtle : T.secondarySystemBackground, borderColor: seed ? T.accent : T.separator }} className="w-full p-3.5 rounded-[12px] border flex items-center justify-between text-left gap-2" aria-pressed={seed}>
                <div>
                  <div className="text-[13px] font-bold">{seed ? `Fill with ${SAMPLE_TRIPS} sample trips` : 'Start with a clean 0-trip ledger'}</div>
                  <div style={{ color: T.secondaryLabel }} className="text-[11px] mt-0.5">{seed ? 'Simulated from the real schedule, so P50/P90, the calendar and your ghost work right away. Marked as samples.' : 'Log every trip from scratch, starting with trip #1.'}</div>
                </div>
                <div style={{ backgroundColor: seed ? T.accent : T.tertiarySystemBackground }} className="w-6 h-6 rounded-full flex items-center justify-center text-white shrink-0">{seed && <CheckCircle2 className="w-4 h-4" />}</div>
              </button>

              <div style={{ backgroundColor: T.secondarySystemBackground, borderColor: T.separator }} className="rounded-[12px] border">
                <button type="button" onClick={() => setAdv(!adv)} className="w-full p-3 flex items-center justify-between text-[13px] font-semibold" aria-expanded={adv}>
                  <span>Advanced detection settings</span>
                  {adv ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </button>
                {adv && (
                  <div className="px-3 pb-3 space-y-2">
                    {ADVANCED.map((a) => (
                      <label key={a.k} className="flex items-center justify-between gap-3">
                        <span style={{ color: T.secondaryLabel }} className="text-[11.5px]">{a.label}</span>
                        <span className="flex items-center gap-1 shrink-0">
                          <input type="number" step={a.step} value={th[a.k] ?? DEFAULT_THRESHOLDS[a.k]} onChange={(e) => setTh({ ...th, [a.k]: Number(e.target.value) })} style={field} className="w-16 px-2 py-1 rounded-[6px] border text-[12px] text-right tnum focus:outline-none" />
                          <span style={{ color: T.tertiaryLabel }} className="text-[11px] w-7">{a.unit}</span>
                        </span>
                      </label>
                    ))}
                    <button type="button" onClick={() => setTh({})} style={{ color: T.accent }} className="text-[11.5px] font-semibold">Reset to defaults</button>
                  </div>
                )}
              </div>
              {toast && <div style={{ color: T.statusDelayed }} className="text-[12px]" role="alert">{toast}</div>}
            </>
          )}
        </div>

        {/* footer */}
        <div className="px-5 pb-5 pt-2 flex items-center gap-2 shrink-0" style={{ borderTop: `1px solid ${T.separator}` }}>
          {step > 1 && (
            <button type="button" onClick={() => setStep(step - 1)} style={{ backgroundColor: T.tertiarySystemBackground, color: T.label }} className="h-11 px-5 rounded-full font-semibold text-[14px]">Back</button>
          )}
          {step < 3 ? (
            <button type="button" disabled={!canNext} onClick={() => { if (step === 2) commitDraft(); setStep(step + 1); }} style={{ backgroundColor: T.accent, opacity: canNext ? 1 : 0.45 }} className="flex-1 h-11 rounded-full text-white font-semibold text-[15px] flex items-center justify-center gap-1.5">
              <span>{step === 1 ? 'Choose stations' : 'Review'}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          ) : (
            <button type="button" disabled={!!busy} onClick={create} style={{ backgroundColor: T.accent }} className="flex-1 min-w-0 h-11 px-4 rounded-full text-white font-semibold text-[15px] flex items-center justify-center gap-1.5 shadow-lg">
              {busy ? <Loader2 className="w-4 h-4 animate-spin shrink-0" /> : <CheckCircle2 className="w-4 h-4 shrink-0" />}
              <span className="truncate min-w-0">{busy ?? `Launch Home → ${name.trim() || 'X'}`}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
