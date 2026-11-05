import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  acquireAgyNativeProfileTurn,
  waitForAgyNativeProfileTurn,
} from '../dist/domains/cats/services/agents/providers/agy-native/agy-native-profile-turn.js';
import { cleanupDurableManagedGateAttempt } from '../dist/infrastructure/managed-runner-durable-attempt.js';

test('waiting for a known live Native owner never synchronously enumerates the host', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'native-loop-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const release = acquireAgyNativeProfileTurn(home, 'first', { conversationId: 'A' });
  const original = childProcess.spawnSync;
  let fullHostReads = 0;
  childProcess.spawnSync = function (command, args, ...rest) {
    if (command === '/bin/ps' && args.includes('-ax')) fullHostReads++;
    return original.call(this, command, args, ...rest);
  };
  syncBuiltinESMExports();
  const abort = new AbortController();
  try {
    const pending = waitForAgyNativeProfileTurn(home, 'waiting', abort.signal, { conversationId: 'A' });
    setImmediate(() => abort.abort());
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(fullHostReads, 0, 'a live owner does not require a synchronous whole-host environment scan');
  } finally {
    childProcess.spawnSync = original;
    syncBuiltinESMExports();
    release();
  }
});

test('Native lease lock contention yields to cancellation instead of blocking the API', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'native-lock-loop-'));
  const release = acquireAgyNativeProfileTurn(home, 'seed');
  release();
  const child = childProcess.fork(
    new URL('./helpers/managed-job-lock-holder.mjs', import.meta.url),
    [join(home, '.cat-cafe-native-turn.sqlite')],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill();
    rmSync(home, { recursive: true, force: true });
  });
  await once(child, 'message');
  const abort = new AbortController();
  setImmediate(() => abort.abort());
  const start = performance.now();
  const pending = waitForAgyNativeProfileTurn(home, 'waiting', abort.signal);
  const synchronousMs = performance.now() - start;
  const outcome = await pending.then(
    (finish) => {
      finish();
      return 'acquired';
    },
    (error) => error.name,
  );
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  await t.diagnostic(JSON.stringify({ synchronousMs, outcome }));
  assert.ok(synchronousMs < 200, `a contended lease must return control promptly: ${synchronousMs}ms`);
  assert.equal(outcome, 'AbortError');
});

test('managed attempt absence proof uses asynchronous host scans', async () => {
  const original = childProcess.spawnSync;
  let wholeHostReads = 0;
  childProcess.spawnSync = function (command, args, ...rest) {
    if (command === '/bin/ps' && args.includes('-ax')) wholeHostReads++;
    return original.call(this, command, args, ...rest);
  };
  syncBuiltinESMExports();
  try {
    const cleanup = await cleanupDurableManagedGateAttempt('never-owned-event-loop-test-9bd0932a', 1000, 100);
    assert.equal(cleanup.proven, true);
    assert.deepEqual(cleanup.signals, [], 'absence proof never signals an unrelated process');
    assert.equal(wholeHostReads, 0, 'cleanup must not synchronously scan the API host');
  } finally {
    childProcess.spawnSync = original;
    syncBuiltinESMExports();
  }
});
