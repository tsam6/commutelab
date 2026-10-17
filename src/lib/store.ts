// Everything lives in this browser's localStorage. Sample trips are regenerated from a seed on load
// instead of being stored, so only your own trips (simulated or real GPS) take space.
const KEY = 'commutelab:v2';
const LIVE_KEY = 'commutelab:live';

export type Profile = {
  name: string;
  handle: string;
  homeOriginLabel: string;
  bikeThresholdMph: number;
};

export type Destination = {
  id: string;
  preset?: boolean;
  setup: any;
  route: any;
  runs: any[]; // your recorded trips (simulated or live GPS)
  samples?: { n: number; seed: number; endDate: number } | null;
};

export type Saved = {
  theme: 'dark' | 'light';
  mapMode: 'street' | 'diagram';
  profile: Profile;
  destinations: Destination[];
  activeId: string;
};

export function loadState(): Saved | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}

export function saveState(s: Saved) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch (err) {
    console.warn('CommuteLab: could not save to localStorage', err);
  }
}

export type LiveSession = { destId: string; startedAt: number; samples: any[] };

export function loadLive(): LiveSession | null {
  try {
    const raw = localStorage.getItem(LIVE_KEY);
    const s = raw ? (JSON.parse(raw) as LiveSession) : null;
    return s && Date.now() - s.startedAt < 3 * 3600 * 1000 && s.samples?.length ? s : null;
  } catch {
    return null;
  }
}

export function saveLive(s: LiveSession | null) {
  try {
    if (s) localStorage.setItem(LIVE_KEY, JSON.stringify(s));
    else localStorage.removeItem(LIVE_KEY);
  } catch {
    /* quota: resuming is best-effort */
  }
}
