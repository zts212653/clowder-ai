import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runTwoConnectionSameValueRace } from './task-outcome-writeback-race-fixture.js';

for (const role of ['first', 'second']) {
  test(`bounds and terminates the ${role} verdict worker before store readiness`, async () => {
    const startedAt = Date.now();
    await assert.rejects(
      runTwoConnectionSameValueRace({
        taskOutcomeDbPath: join(tmpdir(), `task-outcome-stalled-race-${Date.now()}.sqlite`),
        episodeId: 'stalled-worker-episode',
        stallFirstBeforeStore: role === 'first',
        stallSecondBeforeStore: role === 'second',
        timeoutMs: 200,
      }),
      /verdict race timed out after 200ms/,
    );
    assert.ok(Date.now() - startedAt < 1_000, 'stalled workers should be terminated within the bounded timeout');
  });
}
