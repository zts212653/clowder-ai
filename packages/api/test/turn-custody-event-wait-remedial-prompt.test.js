import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('serial routing cannot restore hidden corrective model invocations', () => {
  const source = readFileSync(
    new URL('../src/domains/cats/services/agents/routing/route-serial.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /buildTurnCustodyStopGateRemedialPrompt|runTurnCustodyStopGateRemedial/);
  assert.doesNotMatch(source, /executionKind: 'routing_guard'/);
});
