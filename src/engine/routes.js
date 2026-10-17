// Route configuration: places, geofences, transit lines and the strategies to benchmark.
import { offset } from './geo.js';

export const DEFAULT_THRESHOLDS = {
  maxAccuracyM: 80, // ignore fixes worse than this
  speedWindowSec: 6, // window for position-derived speed when the device gives none
  bikeStartSpeed: 3.0, // m/s (~11 km/h) sustained => riding
  bikeStartSustainSec: 8,
  walkMaxSpeed: 2.5, // m/s, used to confirm "stopped at a station" after a ride
  stopSpeed: 1.0, // m/s, below this you are standing still
  redLightMinSec: 5, // a bike stop at least this long counts as a red light
  trainSpeed: 6.5, // m/s (~23 km/h) sustained => on a train
  trainSustainSec: 5,
  crawlSpeed: 4.0, // m/s, train slower than this between stations = signal crawl
  crawlMinSec: 20, // shortest slow stretch counted as a crawl
  crawlFlagSec: 60, // total crawl time that flags a leg as a "slow crawl" leg
  alightDwellSec: 75, // standing at a transfer station longer than a normal dwell => you got off
  stationConfirmSec: 6, // time inside a station fence before the bike leg ends
  arrivalConfirmSec: 2,
};

export const DEFAULT_MODEL = {
  walkSpeed: [1.2, 1.45],
  errandProb: 0.25,
  errandSec: [90, 480],
  undockSec: [25, 70],
  bikeSpeed: [4.6, 5.2], // average moving speed, m/s
  redLightsPerKm: 1.3,
  redLightSec: [15, 60],
  accessSec: [50, 110], // dock + stairs + turnstile, counted as platform time
  transferWalkSec: [15, 50],
  dwellSec: [20, 40],
  defaultHeadwaySec: 360,
  defaultCruise: 12,
  crawlSpeed: 2.2,
  waitOverrides: {},
};

// Fictional neighbourhood laid out on a km grid, so geometry and timings stay consistent.
const ORIGIN = [40.675, -73.975];
const km = (e, n) => offset(ORIGIN, e * 1000, n * 1000).map((v) => Math.round(v * 1e6) / 1e6);

export function defaultRoute() {
  const st = (id, name, e, n, extra = {}) => ({ id, name, pos: km(e, n), radius: 90, ...extra });
  return {
    id: 'home-school',
    name: 'Home → School',
    builtIn: true,
    home: { name: 'Home', pos: km(0, 0), radius: 60 },
    docks: [{ id: 'dock-home', name: 'Home Bike Dock', pos: km(0.25, 0.3), radius: 50 }],
    destination: 'D',
    stations: [
      st('A', 'Station A', 1.0, 1.45),
      st('S1', 'Elm St', 1.6, 2.8),
      st('S2', 'Oak Av', 2.0, 4.2),
      st('S3', 'Pine St', 2.2, 5.6),
      st('T', 'Transfer Station', 2.3, 7.0, { transfer: true }),
      st('L1', '18 St (local)', 2.2, 8.0, { localOnly: true }),
      st('L2', '23 St (local)', 2.0, 9.0, { localOnly: true }),
      st('L3', '28 St (local)', 1.8, 10.0, { localOnly: true }),
      st('L4', '33 St (local)', 1.6, 11.0, { localOnly: true }),
      st('P', 'Penultimate Station', 1.4, 12.0, { transfer: true }),
      st('D', 'School Station', 1.3, 13.0, { destination: true }),
      st('B', 'Station B', -0.9, 1.75),
      st('E1', 'Bay Pkwy', -0.6, 4.5),
      st('E2', 'Canal St', -0.2, 7.0),
      st('E3', 'Harbor Sq', 0.3, 9.5),
      st('E4', 'Museum', 0.8, 11.5),
    ],
    paths: {
      walk: [km(0, 0), km(0.05, 0.12), km(0.2, 0.18), km(0.25, 0.3)],
      'bike:A': [km(0.25, 0.3), km(1.0, 0.3), km(1.0, 1.45)],
      'bike:B': [km(0.25, 0.3), km(-0.8, 0.3), km(-0.8, 1.75), km(-0.9, 1.75)],
    },
    lines: [
      { id: 'G', name: 'Train 1', color: '#8bc34a', stations: ['A', 'S1', 'S2', 'S3', 'T'], cruise: 13, headwaySec: 420, crawlProb: 0.22, crawlSec: [120, 540] },
      {
        id: 'TR', name: 'Trunk', color: '#ff7043', stations: ['T', 'L1', 'L2', 'L3', 'L4', 'P', 'D'], cruise: 14, crawlProb: 0.03, crawlSec: [40, 120],
        services: { express: { name: 'Express', headwaySec: 300, skipLocal: true, cruise: 16.5 }, local: { name: 'Local', headwaySec: 360 } },
      },
      { id: 'X', name: 'Express X', color: '#42a5f5', stations: ['B', 'E1', 'E2', 'E3', 'E4', 'D'], cruise: 12, headwaySec: 480, crawlProb: 0.04, crawlSec: [40, 150] },
      { id: 'Y', name: 'Express Y', color: '#ab47bc', stations: ['B', 'E1', 'E2', 'E3', 'E4', 'D'], cruise: 12, headwaySec: 480, crawlProb: 0.04, crawlSec: [40, 150] },
    ],
    strategies: [
      {
        id: '1A', label: 'Option 1A', desc: 'Short bike → Train 1 → Express → wait for Local at the penultimate stop', color: '#ff9f43', dock: 'dock-home',
        legs: [
          { from: 'A', to: 'T', lines: ['G'] },
          { from: 'T', to: 'P', lines: ['TR'], service: 'express' },
          { from: 'P', to: 'D', lines: ['TR'], service: 'local' },
        ],
      },
      {
        id: '1B', label: 'Option 1B', desc: 'Short bike → Train 1 → Local straight to the final stop', color: '#ee5a6f', dock: 'dock-home',
        legs: [
          { from: 'A', to: 'T', lines: ['G'] },
          { from: 'T', to: 'D', lines: ['TR'], service: 'local' },
        ],
      },
      {
        id: '2', label: 'Option 2', desc: 'Longer bike → Station B → either express (X or Y) direct', color: '#3dc1d3', dock: 'dock-home',
        legs: [{ from: 'B', to: 'D', lines: ['X', 'Y'] }],
      },
    ],
    model: {
      ...DEFAULT_MODEL,
      // The gamble: ~55% of the time a local is right behind the express.
      waitOverrides: { P: { pQuick: 0.55, quick: [20, 110], slow: [130, 330] } },
    },
    insights: {
      gamble: { strategy: '1A', alt: '1B', from: 'T', at: 'P' },
      lights: { strategy: '2', compare: ['1A', '1B'] },
      crawl: { line: 'G', strategies: ['1A', '1B'], rival: '2' },
    },
    thresholds: { ...DEFAULT_THRESHOLDS },
  };
}

/** A blank custom route ("Home → X") seeded from a home position. */
export function blankRoute(name, homePos) {
  const id = 'r-' + Math.random().toString(36).slice(2, 8);
  return {
    id,
    name: name || 'Home → X',
    builtIn: false,
    home: { name: 'Home', pos: homePos, radius: 60 },
    docks: [{ id: 'dock-1', name: 'Bike Dock', pos: offset(homePos, 200, 200), radius: 50 }],
    destination: 'X',
    stations: [
      { id: 'S', name: 'Start Station', pos: offset(homePos, 1500, 1500), radius: 90 },
      { id: 'X', name: 'Destination', pos: offset(homePos, 1500, 8000), radius: 90, destination: true },
    ],
    paths: {},
    lines: [],
    strategies: [{ id: 'S1', label: 'Strategy 1', desc: 'Bike to Start Station, train direct', color: '#3dc1d3', dock: 'dock-1', legs: [{ from: 'S', to: 'X', lines: [] }] }],
    model: { ...DEFAULT_MODEL },
    insights: {},
    thresholds: { ...DEFAULT_THRESHOLDS },
  };
}

/** Parse "A > T > D" into legs. */
export function legsFromPath(text) {
  const nodes = String(text).split(/[>,→\s]+/).map((s) => s.trim()).filter(Boolean);
  const legs = [];
  for (let i = 1; i < nodes.length; i++) legs.push({ from: nodes[i - 1], to: nodes[i], lines: [] });
  return legs;
}

export const strategyPath = (s) => [s.legs[0].from, ...s.legs.map((l) => l.to)];

export function stationById(route, id) {
  return route.stations.find((s) => s.id === id);
}

/** Stations where a strategy expects you to get off and wait for another train. */
export function transferStationIds(route) {
  const ids = new Set(route.stations.filter((s) => s.transfer).map((s) => s.id));
  for (const s of route.strategies) strategyPath(s).slice(1, -1).forEach((id) => ids.add(id));
  return ids;
}

export function originStationIds(route) {
  return new Set(route.strategies.map((s) => s.legs[0].from));
}

/** Stations where a strategy ends (strategies may end at different stations near the destination). */
export function destinationIds(route) {
  const ids = new Set(route.destinations ?? (route.destination ? [route.destination] : []));
  for (const s of route.strategies) if (s.legs.length) ids.add(s.legs[s.legs.length - 1].to);
  return ids;
}

/** Basic sanity checks for user-edited routes. Returns a list of problems. */
export function validateRoute(route) {
  const errs = [];
  const ids = new Set(route.stations.map((s) => s.id));
  if (!route.name) errs.push('Route needs a name.');
  if (!route.home?.pos) errs.push('Home location missing.');
  if (!route.docks?.length) errs.push('Add at least one bike dock.');
  const dests = route.destinations ?? [route.destination];
  for (const d of dests) if (!ids.has(d)) errs.push(`Destination station "${d}" is not defined.`);
  if (ids.size !== route.stations.length) errs.push('Station ids must be unique.');
  if (!route.strategies.length) errs.push('Add at least one strategy.');
  for (const s of route.strategies) {
    if (!s.legs.length) errs.push(`${s.label}: needs at least two stations in its path.`);
    for (const id of strategyPath(s)) if (!ids.has(id)) errs.push(`${s.label}: unknown station "${id}".`);
    if (s.legs.length && !dests.includes(s.legs[s.legs.length - 1].to)) errs.push(`${s.label}: must end at a destination station.`);
  }
  return errs;
}
