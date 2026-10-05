import assert from 'node:assert/strict';
import { execFileSync, fork, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runSandboxedNativeTaskTest } from '../dist/tools/native-task-test-runner.js';

function processes() {
  return execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      return match ? [{ pid: Number(match[1]), command: match[2] }] : [];
    });
}

async function expectNoOrphanAfterEarlyParentDeath(sendStart) {
  const root = realpathSync(mkdtempSync(join(userInfo().homedir, '.f325-native-task-test-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'cat-cafe-native-test-')));
  // This fixture tests process lifetime; the executed test body is Host-authored and only spins.
  writeFileSync(join(scratch, 'sandbox.sb'), '(version 1)\n(allow default)\n');
  const title = `f325t-${randomBytes(4).toString('hex')}`;
  const testPath = join(workspace, 'task.test.mjs');
  writeFileSync(
    testPath,
    `import { test } from 'node:test';
process.title = ${JSON.stringify(title)};
test('bounded spin', () => { const end = Date.now() + 30_000; while (Date.now() < end) {} });
`,
  );
  const guardianPath = fileURLToPath(new URL('../dist/tools/native-task-test-guardian.js', import.meta.url));
  const input = JSON.stringify({
    workspaceRoot: workspace,
    testPath,
    scratch,
    nodeBinary: realpathSync(process.execPath),
    timeoutMs: 60_000,
  });
  const parent = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { fork } from 'node:child_process';
const guardian = fork(process.argv[1], [process.argv[2]], {
  cwd: process.argv[3], env: { PATH: '/usr/bin:/bin', TMPDIR: process.argv[4] },
  detached: true, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
});
if (process.argv[5] === 'start') guardian.send({ kind: 'start' });
process.send?.({ guardianPid: guardian.pid }, () => setTimeout(() => process.kill(process.pid, 'SIGKILL'), 10));`,
      guardianPath,
      input,
      workspace,
      tmpdir(),
      sendStart ? 'start' : 'no-start',
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  const parentClosed = new Promise((done) => parent.once('close', done));
  try {
    const guardianPid = await new Promise((done, fail) => {
      const timeout = setTimeout(() => fail(new Error('guardian fork was not reported')), 5_000);
      parent.once('message', (message) => {
        clearTimeout(timeout);
        done(message.guardianPid);
      });
      parent.once('error', fail);
    });
    assert.ok(Number.isSafeInteger(guardianPid), 'the guardian must have been forked');
    await parentClosed;
    await new Promise((done) => setTimeout(done, 2_000));
    assert.deepEqual(
      processes().filter((entry) => entry.command.includes(title)),
      [],
      'no test may outlive an early parent death',
    );
    assert.equal(existsSync(scratch), false, 'the guardian must clean its scratch after early parent death');
  } finally {
    parent.kill('SIGKILL');
    await parentClosed;
    for (const entry of processes()) {
      if (
        entry.command.includes(title) ||
        (entry.command.includes('native-task-test-guardian.js') && entry.command.includes(scratch))
      ) {
        try {
          process.kill(entry.pid, 'SIGKILL');
        } catch {
          // A matching child may already have exited between ps and kill.
        }
      }
    }
    rmSync(scratch, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

for (const sendStart of [false, true]) {
  test(
    `native task test leaves no orphan when its MCP parent dies ${sendStart ? 'after' : 'before'} start`,
    { skip: process.platform !== 'darwin' },
    () => expectNoOrphanAfterEarlyParentDeath(sendStart),
  );
}

test(
  'guardian reports a typed cancellation when stopped before start',
  { skip: process.platform !== 'darwin' },
  async () => {
    const root = realpathSync(mkdtempSync(join(userInfo().homedir, '.f325-native-task-test-')));
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'cat-cafe-native-test-')));
    const guardianPath = fileURLToPath(new URL('../dist/tools/native-task-test-guardian.js', import.meta.url));
    const guardian = fork(
      guardianPath,
      [
        JSON.stringify({
          workspaceRoot: root,
          testPath: join(root, 'task.test.mjs'),
          scratch,
          nodeBinary: realpathSync(process.execPath),
          timeoutMs: 60_000,
        }),
      ],
      {
        cwd: root,
        env: { PATH: '/usr/bin:/bin', TMPDIR: tmpdir() },
        execArgv: [],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      },
    );
    const events = [];
    guardian.on('message', (message) => events.push(message));
    const closed = new Promise((done) => guardian.once('close', done));
    try {
      guardian.send({ kind: 'stop', reason: 'cancelled' });
      const exitCode = await closed;
      assert.equal(exitCode, 0);
      assert.deepEqual(events, [{ kind: 'terminal', status: 'cancelled', exitCode: null }]);
      assert.equal(existsSync(scratch), false);
    } finally {
      guardian.kill('SIGKILL');
      await closed;
      rmSync(scratch, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('early native task cancellation is reported as cancelled', { skip: process.platform !== 'darwin' }, async () => {
  const root = realpathSync(mkdtempSync(join(userInfo().homedir, '.f325-native-task-test-')));
  writeFileSync(join(root, 'task.test.mjs'), "import { test } from 'node:test'; test('unused', () => {});\n");
  try {
    for (const delayMs of [1, 5, 15, 40]) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), delayMs);
      try {
        const result = await runSandboxedNativeTaskTest(
          { v: 1, taskId: 'task-pilot', workspaceRoot: root, testFile: 'task.test.mjs' },
          controller.signal,
        );
        assert.equal(result.status, 'cancelled', `abort after ${delayMs}ms`);
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
