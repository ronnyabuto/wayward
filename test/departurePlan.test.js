// planDeparture decides the reply to "when should I leave?" when traffic is
// over the threshold. Pure function, no network. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDeparture } from '../src/utils/departurePlan.js';

const curve = (...minutes) => [15, 30, 45, 60, 90, 120].map((offset, i) => ({ offset, minutes: minutes[i] }));

test('CBD → Kahawa Downs, 2026-09-24 afternoon: flat forecast says leave now, no endless watch', () => {
  // 28-min no-traffic time → threshold 34. The old code replied "stays heavy
  // for at least 2 hours, I'll keep watching" and set a watch on 34. Values
  // below are the live + forecast probes taken at 15:34 that day.
  const plan = planDeparture(42, 34, curve(41, 41, 41, 43, 45, 45));
  assert.equal(plan.kind, 'flat');
  assert.equal(plan.low, 41);
  assert.equal(plan.high, 45);
});

test('forecast reaches the threshold: wait for the earliest clear point', () => {
  const plan = planDeparture(50, 34, curve(48, 40, 33, 30, 29, 29));
  assert.deepEqual(plan, { kind: 'clears', offset: 45, minutes: 33 });
});

test('never clears but waiting saves real time: recommend the best point, watch a reachable threshold', () => {
  const plan = planDeparture(45, 34, curve(44, 42, 39, 38, 38, 41));
  assert.equal(plan.kind, 'improves');
  assert.equal(plan.offset, 60, 'earliest of the tied minimum');
  assert.equal(plan.minutes, 38);
  assert.equal(plan.watchThreshold, 42);
  assert.ok(plan.watchThreshold >= plan.minutes, 'forecast says the watch can fire');
  assert.ok(plan.watchThreshold < 45, 'watch does not fire on current traffic');
});

test('saving below the noise floor counts as flat', () => {
  assert.equal(planDeparture(40, 30, curve(39, 38, 38, 39, 41, 42)).kind, 'flat');
});

test('traffic getting worse: leave now', () => {
  const plan = planDeparture(40, 30, curve(43, 47, 52, 55, 50, 45));
  assert.equal(plan.kind, 'flat');
  assert.equal(plan.low, 40);
  assert.equal(plan.high, 55);
});

test('no forecast data', () => {
  assert.deepEqual(planDeparture(40, 30, []), { kind: 'unknown' });
});

test('partial forecast (some probes failed) is still used', () => {
  const plan = planDeparture(50, 34, [{ offset: 30, minutes: 44 }, { offset: 90, minutes: 33 }]);
  assert.deepEqual(plan, { kind: 'clears', offset: 90, minutes: 33 });
});
