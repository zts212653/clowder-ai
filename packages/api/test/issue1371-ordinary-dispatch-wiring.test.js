import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('production installs one durable Queue and canonical response recovery independently of the Live host flag', async () => {
  const index = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(index, /const invocationQueue = new InvocationQueue\(/);
  assert.match(index, /await invocationQueue\.hydrateFromLedger\(messageStore\)/);
  assert.match(index, /const queueProcessor = new QueueProcessor\(/);
  assert.match(index, /new TurnExecutionStartupReconciler\(/);
  assert.doesNotMatch(index, /A2ADispatchDispositionService|DispatchReceiptService|DispatchAdoptionAuthority/);
});
