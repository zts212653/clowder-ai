import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createMemoizedHostVersionProbe } from '../dist/domains/cats/services/agents/providers/mcp-schema-delivery-capability.js';

test('R10: concurrent cold host versions await one asynchronous probe', async () => {
  let calls = 0;
  const probe = createMemoizedHostVersionProbe(async () => {
    calls++;
    await delay(30);
    return 'codex-cli 0.149.1';
  });
  const results = await Promise.all([probe('codex'), probe('codex')]);
  assert.deepEqual(results, ['0.149.1', '0.149.1']);
  assert.equal(calls, 1);
});
