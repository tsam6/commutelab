// Keyless public services, called straight from the browser (both send CORS headers).
// What you type in an address box goes to NYC Planning's GeoSearch; the coordinates of your
// home, dock and stations go to the FOSSGIS OSRM servers when a route's bike paths are drawn.

export type Place = { label: string; name: string; borough: string; pos: [number, number] };

/** GeoSearch returns some venues in capitals ("BARCLAY'S CENTER"); show them in title case. */
const tidy = (s: string) =>
  s.length > 3 && s === s.toUpperCase() && /[A-Z]/.test(s)
    ? s.toLowerCase().replace(/(^|[\s\-/(])([a-z])/g, (_, a, b) => a + b.toUpperCase())
    : s;

export async function geosearch(text: string, signal?: AbortSignal): Promise<Place[]> {
  const q = text.trim();
  if (q.length < 3) return [];
  const res = await fetch(`https://geosearch.planninglabs.nyc/v2/autocomplete?text=${encodeURIComponent(q)}`, { signal });
  if (!res.ok) throw new Error(`Address search failed (${res.status})`);
  const json = await res.json();
  return (json.features ?? []).slice(0, 6).map((f: any) => {
    const name = tidy(f.properties?.name ?? f.properties?.label ?? q);
    const label = String(f.properties?.label ?? name).split(', ').map((part: string, i: number) => (i === 0 ? tidy(part) : part)).join(', ');
    return {
      label,
      name,
      borough: f.properties?.borough ?? '',
      pos: [f.geometry.coordinates[1], f.geometry.coordinates[0]] as [number, number],
    };
  });
}

/** Street route from a to b ([lat, lon]); null when the router is unreachable. */
export async function osrmRoute(a: number[], b: number[], profile: 'bike' | 'foot'): Promise<{ path: number[][]; meters: number } | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const url = `https://routing.openstreetmap.de/routed-${profile}/route/v1/driving/${a[1]},${a[0]};${b[1]},${b[0]}?overview=full&geometries=geojson`;
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) return null;
    const rt = (await res.json()).routes?.[0];
    if (!rt) return null;
    return {
      path: rt.geometry.coordinates.map(([lo, la]: number[]) => [Math.round(la * 1e5) / 1e5, Math.round(lo * 1e5) / 1e5]),
      meters: rt.distance,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
