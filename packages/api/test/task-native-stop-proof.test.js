import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { taskCliProviderIsStopped } from '../dist/domains/ball-custody/task-provider-stop-proof.js';
import { readUnixProcessSnapshotSync } from '../dist/utils/cli-process-ownership.js';

test('positive exact CLI manifest + OS teardown proves stop; empty, wrong and still-live owners do not', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Unix stop proof uses the host process table');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'task-native-owner-'));
  const previous = process.env.CAT_CAFE_DATA_DIR;
  process.env.CAT_CAFE_DATA_DIR = directory;
  const ref = {
    invocationId: 'exact-child',
    parentInvocationId: 'exact-parent',
    catId: 'codex',
    threadId: 'home',
    sourceMessageId: 'source',
  };
  let child;
  try {
    assert.equal(await taskCliProviderIsStopped(ref, 'task-user'), false, 'absence is not teardown');
    child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    await once(child, 'spawn');
    const observed = readUnixProcessSnapshotSync({ pids: [child.pid] }).get(child.pid);
    assert.ok(observed);
    const { pid, ppid, pgid, startedAt } = observed;
    const ownerId = '12345678-1234-4234-8234-123456789abc';
    const owners = join(directory, 'cli-process-owners');
    await mkdir(owners);
    await writeFile(
      join(owners, ownerId + '.json'),
      JSON.stringify({
        v: 1,
        ownerId,
        createdAt: Date.now(),
        supervisor: { pid, ppid, pgid, startedAt },
        root: { pid, ppid, pgid, startedAt },
        execution: {
          executionId: ref.parentInvocationId,
          invocationId: ref.invocationId,
          catId: ref.catId,
          threadId: ref.threadId,
          userId: 'task-user',
        },
      }),
    );
    assert.equal(await taskCliProviderIsStopped(ref, 'task-user'), false, 'the actual child is still alive');
    assert.equal(await taskCliProviderIsStopped({ ...ref, invocationId: 'other-child' }, 'task-user'), false);
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
    assert.equal(await taskCliProviderIsStopped(ref, 'task-user'), true, 'the exact recorded process is now gone');
    await writeFile(join(owners, 'invalid.json'), '{invalid');
    assert.equal(await taskCliProviderIsStopped(ref, 'task-user'), false, 'corrupt discovery is unknown');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (previous === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
