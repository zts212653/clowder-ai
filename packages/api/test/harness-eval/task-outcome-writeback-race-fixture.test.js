import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runTwoConnectionSameValueRace } from './task-outcome-writeback-race-fixture.js';

test('bounds and terminates a verdict worker that never opens its episode store', async () => {
  const startedAt = Date.now();
  await assert.rejects(
    runTwoConnectionSameValueRace({
      taskOutcomeDbPath: join(tmpdir(), `task-outcome-stalled-race-${Date.now()}.sqlite`),
      episodeId: 'stalled-worker-episode',
      stallSecondBeforeStore: true,
      timeoutMs: 200,
    }),
    /verdict race timed out after 200ms/,
  );
  assert.ok(Date.now() - startedAt < 1_000, 'stalled workers should be terminated within the bounded timeout');
});
