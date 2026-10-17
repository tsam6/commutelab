import { indexData, buildRoute } from './build-route.js';
import type { Destination } from '../lib/store';

export type Nyc = { idx: any; demo: any; generated: string };

let cache: Promise<Nyc> | null = null;

const getJson = async (file: string) => {
  const res = await fetch(`${import.meta.env.BASE_URL}data/${file}`);
  if (!res.ok) throw new Error(`Could not load ${file} (${res.status})`);
  return res.json();
};

/** Real MTA stations/lines and Citi Bike docks, bundled by `npm run data`. Loaded once. */
export function loadNyc(): Promise<Nyc> {
  cache ??= Promise.all([getJson('nyc-subway.json'), getJson('citibike.json'), getJson('demo-route.json')]).then(([subway, bikes, demo]) => ({
    idx: indexData(subway, bikes),
    demo,
    generated: subway.generated,
  }));
  return cache;
}

export const SAMPLE_TRIPS = 42;

/** The preset "Home → Hunter College" destination, built from the real data with sample history. */
export function presetDestination(nyc: Nyc): Destination {
  const { route } = buildRoute(nyc.idx, nyc.demo, { id: 'dest-hunter' });
  return {
    id: 'dest-hunter',
    preset: true,
    setup: nyc.demo,
    route,
    runs: [],
    samples: { n: SAMPLE_TRIPS, seed: 7, endDate: Date.now() },
  };
}
