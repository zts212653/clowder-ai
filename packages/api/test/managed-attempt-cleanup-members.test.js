import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { retainLiveManagedAttemptMembers } from '../dist/infrastructure/managed-runner/attempt-members.js';
import { readUnixProcessSnapshotSync } from '../dist/utils/cli-process-ownership.js';

test('an owned live identity stays accountable after its marker census disappears, until it is actually dead', async (t) => {
  const child = spawn(
    process.execPath,
    ['-e', 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'],
    {
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      child.kill('SIGKILL');
      await exit;
    }
  });
  await once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) });
  const identity = readUnixProcessSnapshotSync({ pids: [child.pid] }).get(child.pid);
  const known = new Map();
  assert.equal((await retainLiveManagedAttemptMembers(known, [identity])).length, 1);
  child.kill('SIGTERM');
  assert.equal(
    (await retainLiveManagedAttemptMembers(known, [])).length,
    1,
    'empty discovery is not proof of death for an already owned live identity',
  );
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  assert.deepEqual(await retainLiveManagedAttemptMembers(known, []), []);
});
