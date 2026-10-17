import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { useT } from '../theme';
import type { Geo, Scene } from '../lib/live';
import { cameraFor, createMap, fc, FONT, halo, line, ll, point, quietBasemap, setData } from './mapkit';

type Props = { route: any; scene: Scene; geo: Record<string, Geo>; follow: boolean };

/** A. Street map: real streets and real track geometry, rotated so the trip runs up the screen. */
export default function StreetMap(props: Props) {
  const T = useT();
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const ready = useRef(false);
  const puck = useRef<maplibregl.Marker | null>(null);
  const ghost = useRef<maplibregl.Marker | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const tokens = useRef(T);
  tokens.current = T;
  const framed = useRef<string>('');
  const styleUrl = useRef(T.mapStyle);

  useEffect(() => {
    styleUrl.current = tokens.current.mapStyle;
    const map = createMap(box.current!, tokens.current.mapStyle);
    mapRef.current = map;
    if (import.meta.env.DEV) (window as any).__clStreetMap = map;
    map.on('style.load', () => {
      quietBasemap(map, tokens.current.isDark);
      addLayers(map);
      ready.current = true;
      framed.current = '';
      refresh();
    });
    // the container can still be settling its size on the first frame: draw again once idle
    map.once('idle', () => {
      framed.current = '';
      refresh();
    });
    const ro = new ResizeObserver(() => {
      map.resize();
      framed.current = '';
      refresh();
    });
    ro.observe(box.current!);
    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      ready.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleUrl.current === T.mapStyle) return;
    styleUrl.current = T.mapStyle;
    ready.current = false;
    map.setStyle(T.mapStyle);
  }, [T.mapStyle]);

  useEffect(() => refresh());

  function addLayers(map: maplibregl.Map) {
    const t = tokens.current;
    const P = t.phase;
    const round = { 'line-cap': 'round' as const, 'line-join': 'round' as const };
    for (const id of ['cl-net', 'cl-bike', 'cl-walk', 'cl-ahead', 'cl-trail', 'cl-st', 'cl-pts']) setData(map, id, fc([]));
    map.addLayer({ id: 'cl-net-casing', type: 'line', source: 'cl-net', layout: round, paint: { 'line-color': t.isDark ? '#0b0d12' : '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 6, 16, 12] } });
    map.addLayer({ id: 'cl-net', type: 'line', source: 'cl-net', layout: round, paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2.6, 16, 5.5], 'line-opacity': ['case', ['get', 'alive'], 0.85, 0.3], 'line-offset': ['get', 'off'] } });
    map.addLayer({ id: 'cl-bike', type: 'line', source: 'cl-bike', layout: round, paint: { 'line-color': ['case', ['get', 'alive'], P.bike, t.tertiaryLabel], 'line-width': 2.5, 'line-opacity': ['case', ['get', 'alive'], 0.55, 0.6], 'line-dasharray': [1.5, 2] } });
    map.addLayer({ id: 'cl-walk', type: 'line', source: 'cl-walk', layout: round, paint: { 'line-color': P.buffer, 'line-width': 2.5, 'line-dasharray': [1, 1.6] } });
    map.addLayer({ id: 'cl-ahead', type: 'line', source: 'cl-ahead', layout: round, paint: { 'line-color': t.accent, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 3.2, 16, 5.5], 'line-dasharray': [1.2, 1.6], 'line-offset': ['get', 'off'] } });
    map.addLayer({
      id: 'cl-trail', type: 'line', source: 'cl-trail', layout: round,
      paint: {
        'line-color': ['match', ['get', 'kind'], 'bike', P.bike, 'wait', P.wait, 'transfer', P.transfer, 'train', P.train, P.buffer],
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 4.5, 16, 8],
        'line-offset': ['get', 'off'],
      },
    });
    map.addLayer({
      id: 'cl-st', type: 'circle', source: 'cl-st',
      paint: {
        'circle-radius': ['case', ['get', 'dest'], 8.5, ['get', 'major'], 5.5, 3.6],
        'circle-color': ['case', ['get', 'dest'], t.accent, ['get', 'major'], t.isDark ? '#f8fafc' : '#ffffff', t.isDark ? '#0b0d12' : '#ffffff'],
        'circle-stroke-color': ['case', ['get', 'dest'], '#ffffff', ['get', 'major'], t.isDark ? '#0b0d12' : '#0f172a', t.isDark ? '#e2e8f0' : '#475569'],
        'circle-stroke-width': ['case', ['get', 'dest'], 3, ['get', 'major'], 2, 1.6],
      },
    });
    map.addLayer({
      id: 'cl-pts', type: 'circle', source: 'cl-pts',
      paint: {
        'circle-radius': ['match', ['get', 'kind'], 'dock', 7, 'place', 6, 4.5],
        'circle-color': ['match', ['get', 'kind'], 'dock', P.bike, 'place', t.accent, t.label],
        'circle-stroke-color': t.isDark ? '#0b0d12' : '#ffffff',
        'circle-stroke-width': 2.5,
      },
    });
    map.addLayer({
      id: 'cl-st-label', type: 'symbol', source: 'cl-st',
      layout: { 'text-field': ['get', 'label'], 'text-font': FONT, 'text-size': ['case', ['get', 'major'], 12, 10.5], 'text-anchor': 'right', 'text-justify': 'right', 'text-offset': [-1.1, 0], 'text-max-width': 14 },
      paint: { 'text-color': ['case', ['get', 'dest'], '#ff8a4d', ['get', 'major'], t.label, t.secondaryLabel], ...halo(t.isDark) },
    });
    map.addLayer({
      id: 'cl-pts-label', type: 'symbol', source: 'cl-pts',
      layout: { 'text-field': ['get', 'label'], 'text-font': FONT, 'text-size': 11, 'text-anchor': 'left', 'text-justify': 'left', 'text-offset': [1.1, 0], 'text-max-width': 16 },
      paint: { 'text-color': ['match', ['get', 'kind'], 'dock', P.bike, 'place', '#ff8a4d', t.secondaryLabel], ...halo(t.isDark) },
    });
  }

  function refresh() {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    const { route, scene, geo, follow } = latest.current;
    const t = tokens.current;
    // Parallel tracks (local west, express east on the same street) get a small offset each way.
    const offOf = (l: any) => (l?.kind === 'express' ? 3.5 : l?.kind === 'local' ? -3.5 : 0);
    const net: any[] = [];
    const seen = new Set<string>();
    for (const s of route.strategies) {
      for (const g of geo[s.id]?.legs ?? []) {
        const key = `${g.line?.id}`;
        const alive = scene.alive.has(s.id);
        if (seen.has(key + alive)) continue;
        seen.add(key + alive);
        net.push(line(g.path, { color: g.line?.color ?? '#808183', alive, off: offOf(g.line) }));
      }
    }
    setData(map, 'cl-net', fc(net));
    const bikes = new Map<string, any>();
    for (const s of route.strategies) {
      const k = s.legs[0].from;
      const alive = scene.alive.has(s.id) || bikes.get(k)?.properties.alive;
      bikes.set(k, line(geo[s.id].bike, { alive }));
    }
    setData(map, 'cl-bike', fc([...bikes.values()]));
    setData(map, 'cl-walk', fc(route.paths?.walk?.length >= 2 && route.docks[0].id !== 'dock-own' ? [line(route.paths.walk)] : []));
    const leadGeo = geo[scene.leadId];
    const aheadOff = (i: number) => {
      const legs = leadGeo?.legs ?? [];
      const from = scene.you.kind === 'idle' || scene.you.kind === 'buffer' || scene.you.kind === 'bike' ? -1 : scene.you.leg;
      const k = from < 0 ? i - 1 : from + i;
      return k >= 0 ? offOf(legs[k]?.line) : 0;
    };
    setData(map, 'cl-ahead', fc(scene.started ? scene.ahead.filter((p) => p.length >= 2).map((p, i) => line(p, { off: aheadOff(i) })) : []));
    setData(map, 'cl-trail', fc(scene.trail.map((p) => line(p.path, { kind: p.kind, off: 0 }))));
    const leadStops = new Set<string>();
    for (const g of leadGeo?.legs ?? []) {
      leadStops.add(g.leg.from);
      leadStops.add(g.leg.to);
    }
    setData(map, 'cl-st', fc(route.stations.map((s: any) => point(s.pos, {
      label: s.destination && s.id === route.destination && route.title && route.title !== s.name ? `${s.name}\n${route.title}` : s.name,
      dest: !!s.destination && s.id === route.destination,
      major: !s.localOnly || leadStops.has(s.id),
    }))));
    const pts = [point(route.docks[0].pos, { kind: 'dock', label: route.docks[0].own ? 'Your bike' : `Citi Bike\n${route.docks[0].name}` })];
    if (!route.docks[0].own) pts.push(point(route.home.pos, { kind: 'home', label: follow ? 'Home' : '' }));
    if (route.place) pts.push(point(route.place.pos, { kind: 'place', label: '' }));
    setData(map, 'cl-pts', fc(pts));

    // markers
    const you = scene.you.pos ?? (scene.started ? null : null);
    if (you) {
      puck.current ??= new maplibregl.Marker({ element: Object.assign(document.createElement('div'), { className: 'cl-puck' }) });
      puck.current.setLngLat(ll(you)).addTo(map);
    } else puck.current?.remove();
    if (scene.ghost?.pos) {
      ghost.current ??= new maplibregl.Marker({ element: Object.assign(document.createElement('div'), { className: 'cl-ghost', title: 'Your typical day, right now' }) });
      ghost.current.setLngLat(ll(scene.ghost.pos)).addTo(map);
    } else ghost.current?.remove();

    // camera
    const bearing = route.bearing ?? 0;
    if (follow) {
      const c = you ?? route.docks[0].pos;
      const ahead = scene.ahead.find((p) => p.length >= 2);
      const look = ahead ? ahead[Math.min(ahead.length - 1, Math.floor(ahead.length / 6))] : c;
      map.jumpTo({ center: ll([(c[0] * 3 + look[0]) / 4, (c[1] * 3 + look[1]) / 4]), zoom: 15.2, bearing });
      framed.current = '';
    } else {
      const key = `${route.id}:${map.getContainer().clientWidth}x${map.getContainer().clientHeight}:${t.mapStyle}`;
      if (framed.current !== key) {
        const all = [route.home.pos, route.docks[0].pos, ...route.stations.map((s: any) => s.pos)];
        if (route.place) all.push(route.place.pos);
        const H = map.getContainer().clientHeight;
        const pad = { top: Math.min(112, H * 0.24), bottom: Math.min(150, H * 0.3), left: 130, right: 60 };
        map.jumpTo({ ...cameraFor(all, bearing, pad, map.getContainer()), bearing });
        framed.current = key;
      }
    }
  }

  return <div ref={box} className={`absolute inset-0 ${T.isDark ? 'cl-dark' : 'cl-light'}`} aria-label="Street map of the commute" />;
}
