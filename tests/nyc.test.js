import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { indexData, buildRoute, connections, nodeOf, nearestDocks, optionCodes } from '../src/nyc/build-route.js';
import { samplePlan, planToRecord, generateHistory } from '../src/engine/model.js';
import { createSimulator, simulateAll } from '../src/engine/simulator.js';
import { createEngine, runEngine } from '../src/engine/engine.js';
import { validateRoute } from '../src/engine/routes.js';
import { createRng } from '../src/engine/rng.js';
import { byStrategy, insights, strategyProfiles, ghostRace, winMatrix } from '../src/engine/analytics.js';

const load = (f) => JSON.parse(readFileSync(new URL(`../public/data/${f}`, import.meta.url), 'utf8'));
const idx = indexData(load('nyc-subway.json'), load('citibike.json'));
const demo = load('demo-route.json');
const { route, problems } = buildRoute(idx, demo, { id: 'demo' });
const T0 = new Date('2026-10-05T08:10:00').getTime();
const name = (id) => route.stations.find((s) => s.id === id)?.name ?? id;

function detect(r, id, seed, planOpts = {}, simOpts = {}) {
  const plan = samplePlan(r, id, createRng(seed), { startTime: T0, ...planOpts });
  const truth = planToRecord(r, plan);
  const rec = runEngine(r, simulateAll(plan, { seed, ...simOpts }), { source: 'sim' }).record;
  return { plan, truth, rec };
}

test('data: Lexington Av 4/5 express skips the local stops the 6 makes', () => {
  const cs = connections(idx, '635', '629'); // 14 St-Union Sq -> 59 St
  const exp = cs.find((c) => c.routes.includes('4'));
  const loc = cs.find((c) => c.routes.includes('6'));
  assert.ok(exp && loc, cs.map((c) => c.label).join(', '));
  assert.deepEqual(exp.routes, ['4', '5']);
  assert.equal(exp.kind, 'express');
  assert.equal(loc.kind, 'local');
  assert.deepEqual(exp.skips.map((id) => idx.stations.get(id).name), ['23 St-Baruch College', '28 St', '33 St', '51 St']);
  assert.ok(exp.expected < loc.expected, `express ${exp.expected} vs local ${loc.expected}`);
  assert.ok(exp.headway > 120 && exp.headway < 900, `headway ${exp.headway}`);
});

test('data: ride labels: the D over the Manhattan Bridge is not a "local"; the 6 through Midtown is', () => {
  const d = connections(idx, 'D21', 'R31').find((c) => c.routes.includes('D')); // Broadway-Lafayette -> Atlantic Av
  assert.ok(d, 'D connection');
  assert.notEqual(d.kind, 'local');
  const six = connections(idx, '636', '628').find((c) => c.routes.includes('6')); // Astor Pl -> 68 St
  assert.equal(six.kind, 'local');
  const short = connections(idx, '636', '635').find((c) => c.routes.includes('6')); // Astor Pl -> Union Sq
  assert.equal(short.kind, null);
});

test('data: complexes merge platforms; docks are real', () => {
  assert.equal(nodeOf(idx, '629').id, nodeOf(idx, 'R11').id); // 59 St and Lexington Av/59 St
  assert.ok(idx.byNode.size > 400 && idx.byNode.size < 496);
  assert.ok(idx.docks.length > 2000);
  assert.equal(nearestDocks(idx, demo.home.pos, 1)[0].name, 'E 4 St & Ave B');
});

test('demo route: three options with the right codes, labels, fences and insights', () => {
  assert.deepEqual(problems, []);
  assert.deepEqual(validateRoute(route), []);
  assert.deepEqual(route.strategies.map((s) => s.id), ['1A', '1B', '2']);
  assert.deepEqual(route.strategies.map((s) => s.desc), ['Astor Pl · 6 → 4/5 express → 6', 'Astor Pl · 6 local all the way', '14 St-Union Sq · 4/5 express → 6']);
  assert.equal(name(route.destination), '68 St-Hunter College');
  assert.deepEqual(route.insights.gamble, { strategy: '1A', alt: '1B', from: nodeOf(idx, '635').id, at: nodeOf(idx, '629').id });
  assert.equal(route.insights.lights?.strategy, '2');
  assert.equal(route.bearing, 29);
  for (const s of route.stations) assert.ok(s.radius >= 60 && s.radius <= 300, `${s.name} radius ${s.radius}`);
  assert.ok(route.stations.find((s) => s.name === '51 St').localOnly);
  assert.deepEqual(optionCodes([{ stops: ['a'] }, { stops: ['a'] }, { stops: ['b'] }]), ['1A', '1B', '2']);
});

test('demo route: simulated trains follow real track geometry', () => {
  const plan = samplePlan(route, '2', createRng(3), { startTime: T0 });
  const train = plan.segments.filter((s) => s.phase.kind === 'train' && s.type === 'move');
  const straight = route.stations.length; // a straight-line fallback would have ~1 vertex per station
  assert.ok(train.reduce((a, s) => a + s.path.length, 0) > straight, 'train paths should follow the GTFS shapes');
  const express = route.lines.find((l) => l.name === '4/5');
  assert.ok(express.path.length > 6 && express.at.length === express.stations.length);
  const stops = plan.segments.filter((s) => s.tag === 'stop').map((s) => name(s.station));
  assert.deepEqual(stops, ['Grand Central-42 St']);
});

for (const id of ['1A', '1B', '2']) {
  test(`engine detects ${id} on the real NYC route (20 simulated commutes)`, () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { truth, rec } = detect(route, id, seed);
      assert.ok(rec, `seed ${seed}: no arrival detected`);
      assert.equal(rec.strategyId, id, `seed ${seed}: path ${rec.path.map(name).join(' > ')}`);
      assert.ok(Math.abs(rec.metrics.total - truth.metrics.total) < 45, `seed ${seed}: total ${rec.metrics.total} vs ${truth.metrics.total}`);
      assert.ok(Math.abs(rec.metrics.bike - truth.metrics.bike) < 45, `seed ${seed}: bike ${rec.metrics.bike} vs ${truth.metrics.bike}`);
      assert.ok(Math.abs(rec.t0 - truth.t0) < 30000, `seed ${seed}: T0 off by ${(rec.t0 - truth.t0) / 1000}s`);
    }
  });
}

test('engine works without device speed on the NYC route', () => {
  for (const id of ['1A', '1B', '2']) {
    for (let seed = 30; seed < 36; seed++) {
      const { truth, rec } = detect(route, id, seed, {}, { reportSpeed: false });
      assert.ok(rec, `${id}/${seed}: no arrival`);
      assert.equal(rec.strategyId, id, `${id}/${seed}: ${rec.path.map(name).join(' > ')}`);
      assert.ok(Math.abs(rec.metrics.total - truth.metrics.total) < 60, `${id}/${seed}`);
    }
  }
});

test('options ending at different stations: riding through one option’s end station does not stop the clock', () => {
  const setup = {
    ...demo,
    options: [
      { stops: ['636', '628'], routes: [['6']] }, // Astor Pl -> 68 St on the 6
      { stops: ['636', '629'], routes: [['6']] }, // Astor Pl -> 59 St on the 6, walk from there
    ],
  };
  const { route: r, problems: p } = buildRoute(idx, setup, { id: 'two-ends' });
  assert.deepEqual(p, []);
  assert.equal(r.destinations.length, 2);
  for (const id of r.strategies.map((s) => s.id)) {
    for (let seed = 1; seed <= 8; seed++) {
      const { truth, rec } = detect(r, id, seed);
      assert.ok(rec, `${id}/${seed}: no arrival`);
      assert.equal(rec.strategyId, id, `${id}/${seed}: ${rec.path.join('>')}`);
      assert.ok(Math.abs(rec.metrics.total - truth.metrics.total) < 45, `${id}/${seed}: ${rec.metrics.total} vs ${truth.metrics.total}`);
    }
  }
  // walking straight out of the end station (instead of standing on the platform) also ends the trip
  const { truth, rec } = detect(r, r.strategies[1].id, 4, { walkOut: true });
  assert.ok(rec);
  assert.equal(rec.strategyId, r.strategies[1].id);
  assert.ok(Math.abs(rec.metrics.total - truth.metrics.total) < 45);
});

test('injected delay mid-bike counts as a red light; crawl injection is flagged', () => {
  const plan = samplePlan(route, '1B', createRng(11), { startTime: T0, errand: false, crawl: false, lights: 'green' });
  const sim = createSimulator(plan, { seed: 11 });
  const eng = createEngine(route);
  let snap;
  let delayed = false;
  let crawled = false;
  for (let fix = sim.step(); fix; fix = sim.step()) {
    snap = eng.push(fix);
    if (!delayed && snap.state === 'bike' && snap.now - snap.t0 > 120000) { sim.injectDelay(40, 'redlight'); delayed = true; }
    if (!crawled && snap.state === 'train' && snap.now - snap.phase.start > 30000) crawled = sim.injectSlow(120);
  }
  const rec = eng.record;
  assert.ok(delayed && crawled && rec);
  assert.equal(rec.strategyId, '1B');
  assert.ok(rec.metrics.redLights >= 1);
  assert.ok(rec.metrics.crawl, `crawl ${rec.metrics.firstTrainCrawlSec}`);
});

test('sample history feeds every analytic the app shows', () => {
  const runs = generateHistory(route, { n: 42, seed: 5, endDate: new Date('2026-10-15'), startHour: 8, startMin: [0, 35] });
  assert.equal(runs.length, 42);
  const rows = byStrategy(route, runs);
  for (const r of rows) assert.ok(r.total.n === 14 && r.total.median > 900 && r.total.median < 2400, `${r.strategy.id} median ${r.total.median}`);
  const ins = insights(route, runs);
  assert.ok(ins.gamble?.enough && isFinite(ins.gamble.winRate) && isFinite(ins.gamble.breakeven), JSON.stringify(ins.gamble?.cfg));
  assert.ok(ins.lights?.enough && ins.lights.fit, 'lights');
  const m = winMatrix(route, runs);
  assert.ok(m.flat().filter((v) => v != null).every((v) => v >= 0 && v <= 1));
  const profiles = strategyProfiles(route, runs);
  const lanes = ghostRace(profiles, { phases: [], now: T0, t0: T0, candidates: ['1A', '1B', '2'] });
  assert.equal(lanes.length, 3);
});
