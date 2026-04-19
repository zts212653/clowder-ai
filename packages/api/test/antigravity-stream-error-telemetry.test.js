import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('F061 Phase 2d: Antigravity stream_error telemetry', () => {
  test('exports buffered/recovered/expired counters from instruments.ts', async () => {
    const instruments = await import('../dist/infrastructure/telemetry/instruments.js');

    for (const name of [
      'antigravityStreamErrorBuffered',
      'antigravityStreamErrorRecovered',
      'antigravityStreamErrorExpired',
    ]) {
      assert.ok(instruments[name], `missing telemetry counter export: ${name}`);
      assert.equal(typeof instruments[name].add, 'function', `${name} should expose .add()`);
    }
  });
});
