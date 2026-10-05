import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('production installs ordinary adoption and receipt repair independently of the Live host flag', async () => {
  const index = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const construction = index.slice(
    index.indexOf('a2aDispatchDispositionService = new A2ADispatchDispositionService'),
    index.indexOf('const { CoordinationTerminalRetirement }'),
  );
  assert.match(construction, /adoptionAuthority: new DispatchAdoptionAuthority\(\{/);
  assert.match(construction, /executions: turnExecutionStore/);
  assert.match(construction, /messages: messageStore/);
  assert.match(construction, /adoptions: turnCustodyAdoptionRegistry/);
  assert.match(construction, /dispatchReceiptService\.repair\(input\)/);
  assert.doesNotMatch(construction, /liveCompanionSessions && dispatchReceiptService/);
});
