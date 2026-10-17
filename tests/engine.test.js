import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultRoute, blankRoute, validateRoute, legsFromPath } from '../src/engine/routes.js';
import { samplePlan, planToRecord, generateHistory } from '../src/engine/model.js';
import { createSimulator, simulateAll, profile } from '../src/engine/simulator.js';
import { runEngine, createEngine } from '../src/engine/engine.js';
import { createRng } from '../src/engine/rng.js';

const route = defaultRoute();
const T0 = new Date('2026-10-05T07:30:00').getTime();

function detect(strategyId, seed, planOpts = {}, simOpts = {}) {
  const plan = samplePlan(route, strategyId, createRng(seed), { startTime: T0, ...planOpts });
  const truth = planToRecord(route, plan);
  const eng = runEngine(route, simulateAll(plan, { seed, ...simOpts }), { source: 'sim' });
  return { plan, truth, rec: eng.record, eng };
}

test('trapezoid profile covers full distance', () => {
  assert.ok(Math.abs(profile(1, 0.2, 0.2).d - 1) < 1e-9);
  assert.ok(Math.abs(profile(0, 0.2, 0.2).d) < 1e-9);
  assert.ok(Math.abs(profile(0.5, 0, 0).d - 0.5) < 1e-9);
});

for (const id of ['1A', '1B', '2']) {
  test(`engine classifies strategy ${id} across many simulated commutes`, () => {
    for (let seed = 1; seed <= 25; seed++) {
      const { truth, rec } = detect(id, seed);
      assert.ok(rec, `seed ${seed}: no arrival detected`);
      assert.equal(rec.strategyId, id, `seed ${seed}: path ${rec.path.join('>')}`);
      // benchmark total within 45 s of ground truth, buffer excluded
      assert.ok(Math.abs(rec.metrics.total - truth.metrics.total) < 45, `seed ${seed}: total ${rec.metrics.total} vs ${truth.metrics.total}`);
      assert.ok(Math.abs(rec.metrics.bike - truth.metrics.bike) < 45, `seed ${seed}: bike ${rec.metrics.bike} vs ${truth.metrics.bike}`);
      assert.ok(Math.abs(rec.metrics.train - truth.metrics.train) < 45, `seed ${seed}: train ${rec.metrics.train} vs ${truth.metrics.train}`);
      assert.ok(Math.abs(rec.t0 - truth.t0) < 30000, `seed ${seed}: T0 off by ${(rec.t0 - truth.t0) / 1000}s`);
    }
  });
}

test('quick express→local catches at the penultimate stop are still 1A', () => {
  // force short waits by trying many seeds and checking those with short penultimate waits
  let checked = 0;
  for (let seed = 100; seed < 160; seed++) {
    const { truth, rec } = detect('1A', seed);
    const pw = truth.phases.find((p) => p.kind === 'wait' && p.station === 'P');
    if ((pw.end - pw.start) / 1000 < 75) {
      checked++;
      assert.equal(rec.strategyId, '1A', `seed ${seed}`);
    }
  }
  assert.ok(checked > 3, `only ${checked} quick catches sampled`);
});

test('red lights are counted', () => {
  for (let seed = 1; seed <= 15; seed++) {
    const { truth, rec } = detect('2', seed);
    assert.ok(Math.abs(rec.metrics.redLights - truth.metrics.redLights) <= 1, `seed ${seed}: ${rec.metrics.redLights} vs ${truth.metrics.redLights}`);
  }
});

test('slow crawl on Train 1 is flagged, and not flagged when absent', () => {
  for (let seed = 1; seed <= 10; seed++) {
    assert.equal(detect('1B', seed, { crawl: true }).rec.metrics.crawl, true, `seed ${seed} crawl`);
    assert.equal(detect('1B', seed, { crawl: false }).rec.metrics.crawl, false, `seed ${seed} no crawl`);
  }
});

test('express vs local service is inferred from skipped local stations', () => {
  const a = detect('1A', 3).rec.phases.filter((p) => p.kind === 'train');
  assert.equal(a[1].service, 'express');
  const b = detect('1B', 3).rec.phases.filter((p) => p.kind === 'train');
  assert.equal(b[1].service, 'local');
});

test('errand during the walk is excluded from route time', () => {
  const plain = detect('2', 5, { errand: false });
  const errand = detect('2', 5, { errand: true });
  assert.ok(errand.rec.metrics.buffer > plain.rec.metrics.buffer + 60);
  assert.ok(Math.abs(errand.rec.metrics.total - errand.truth.metrics.total) < 45);
});

test('distraction injected mid-walk via simulator is buffer, not route time', () => {
  const plan = samplePlan(route, '2', createRng(8), { startTime: T0, errand: false });
  const truth = planToRecord(route, plan);
  const sim = createSimulator(plan, { seed: 8 });
  const eng = createEngine(route);
  for (let i = 0; i < 60; i++) eng.push(sim.step());
  sim.injectDelay(300);
  for (let s = sim.step(); s; s = sim.step()) eng.push(s);
  const rec = eng.record;
  assert.equal(rec.strategyId, '2');
  assert.ok(rec.metrics.buffer > truth.metrics.buffer + 250);
  assert.ok(Math.abs(rec.metrics.total - truth.metrics.total) < 45);
});

test('works without device-reported speed (position-derived speed)', () => {
  for (let seed = 1; seed <= 8; seed++) {
    for (const id of ['1A', '1B', '2']) {
      const { truth, rec } = detect(id, seed, {}, { reportSpeed: false, noiseM: 3 });
      assert.ok(rec, `${id}/${seed} no arrival`);
      assert.equal(rec.strategyId, id, `${id}/${seed}: ${rec.path.join('>')}`);
      assert.ok(Math.abs(rec.metrics.total - truth.metrics.total) < 60, `${id}/${seed}`);
    }
  }
});

test('history: deterministic, balanced, realistic ranges', () => {
  const h = generateHistory(route, { n: 90, endDate: new Date('2026-10-13') });
  const h2 = generateHistory(route, { n: 90, endDate: new Date('2026-10-13') });
  assert.equal(h.length, 90);
  assert.deepEqual(h.map((r) => r.metrics.total), h2.map((r) => r.metrics.total));
  const by = (id) => h.filter((r) => r.strategyId === id);
  for (const id of ['1A', '1B', '2']) assert.equal(by(id).length, 30);
  const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const bike1 = med(by('1A').map((r) => r.metrics.bike)) / 60;
  const bike2 = med(by('2').map((r) => r.metrics.bike)) / 60;
  assert.ok(bike1 > 6.5 && bike1 < 9.5, `opt1 bike ${bike1}`);
  assert.ok(bike2 > 9.5 && bike2 < 13, `opt2 bike ${bike2}`);
  assert.ok(bike2 - bike1 > 1.5 && bike2 - bike1 < 5, `delta ${bike2 - bike1}`);
});

test('custom route: blank route validates and is trackable end to end', () => {
  const r = blankRoute('Home → Gym', [40.7, -73.95]);
  assert.deepEqual(validateRoute(r), []);
  r.stations.push({ id: 'M', name: 'Mid', pos: [40.73, -73.935], radius: 90 });
  r.strategies.push({ id: 'S2', label: 'Via Mid', color: '#f00', dock: 'dock-1', legs: legsFromPath('S > M > X') });
  assert.deepEqual(validateRoute(r), []);
  for (const id of ['S1', 'S2']) {
    const plan = samplePlan(r, id, createRng(4), { startTime: T0 });
    const rec = runEngine(r, simulateAll(plan, { seed: 4 })).record;
    assert.ok(rec, id);
    assert.equal(rec.strategyId, id);
  }
});

test('validateRoute catches broken strategies', () => {
  const r = blankRoute('x', [40.7, -73.95]);
  r.strategies[0].legs = legsFromPath('S > NOPE');
  assert.ok(validateRoute(r).length >= 1);
});
