import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TripwireLogBudget } from '../dist/infrastructure/telemetry/cpu/event-loop-tripwire-budget.js';

test('a storm is capped by both record count and bytes, with exact suppression accounting', () => {
  const count = new TripwireLogBudget();
  for (let i = 0; i < 30; i++) assert.equal(count.take(10, i).allowed, true);
  for (let i = 0; i < 7; i++) assert.equal(count.take(10, 50 + i).allowed, false);
  const next = count.take(100, 60000);
  assert.equal(next.allowed, true);
  assert.equal(next.summary.droppedRecords, 7);
  assert.equal(next.summary.droppedBytes, 70);
  assert.equal(count.drain(61000), undefined);
  const bytes = new TripwireLogBudget();
  assert.equal(bytes.take(16000, 0).allowed, true);
  assert.equal(bytes.take(385, 1).allowed, false);
  assert.equal(bytes.drain(100).droppedRecords, 1);
});
