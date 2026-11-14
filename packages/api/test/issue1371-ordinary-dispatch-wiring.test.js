import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('production installs one durable Queue and canonical response recovery independently of the Live host flag', async () => {
  const index = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(index, /const invocationQueue = new InvocationQueue\(/);
  assert.match(index, /await invocationQueue\.hydrateFromLedger\(messageStore\)/);
  assert.match(index, /const queueProcessor = new QueueProcessor\(/);
  // #1838: index.ts runs response recovery through the one shared prior-process recovery function.
  assert.match(index, /await recoverPriorProcessExecutions\(/);
  const recovery = await readFile(
    new URL('../src/domains/cats/services/agents/invocation/prior-process-execution-recovery.ts', import.meta.url),
    'utf8',
  );
  const child = recovery.indexOf('new TurnExecutionStartupReconciler(');
  assert.ok(child >= 0 && child < recovery.indexOf('}).reconcileOrphans()'));
  assert.doesNotMatch(index, /A2ADispatchDispositionService|DispatchReceiptService|DispatchAdoptionAuthority/);
  assert.doesNotMatch(recovery, /A2ADispatchDispositionService|DispatchReceiptService|DispatchAdoptionAuthority/);
});
