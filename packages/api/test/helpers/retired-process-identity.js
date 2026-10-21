import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readUnixProcessSnapshotSync } from '../../dist/utils/cli-process-ownership.js';

/** A real, reaped PID is observable as absent; an out-of-range PID is only unknown. */
export async function retiredProcessIdentity(t) {
  const child = spawn(
    process.execPath,
    ['-e', "process.send('ready'); process.on('message', () => process.exit(0));"],
    {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  await once(child, 'message');
  const identity = readUnixProcessSnapshotSync({ pids: [child.pid] })?.get(child.pid);
  assert.ok(identity);
  const exited = once(child, 'exit');
  child.send('exit');
  await exited;
  assert.equal(readUnixProcessSnapshotSync({ pids: [identity.pid] })?.has(identity.pid), false);
  return identity;
}
