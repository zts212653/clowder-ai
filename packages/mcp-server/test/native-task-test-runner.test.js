import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runSandboxedNativeTaskTest } from '../dist/tools/native-task-test-runner.js';

test(
  'native task test gets one read-only workspace, no host env, network, or child process',
  { skip: process.platform !== 'darwin' },
  async () => {
    const root = realpathSync(mkdtempSync(join(userInfo().homedir, '.f325-native-task-test-')));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const secret = join(root, 'fake-secret.txt');
    const output = join(workspace, 'workspace-write.txt');
    const testFile = join(workspace, 'task.test.mjs');
    writeFileSync(secret, 'FAKE-SECRET');
    writeFileSync(
      testFile,
      `import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { connect } from 'node:net';
test('bounded host test', async () => {
  assert.equal(process.env.F325_FAKE_HOST_TOKEN, undefined);
  assert.throws(() => readFileSync(${JSON.stringify(secret)}, 'utf8'), { code: 'EPERM' });
  assert.throws(() => writeFileSync(${JSON.stringify(output)}, 'bad'), { code: 'EPERM' });
  assert.throws(() => execFileSync('/bin/true'));
  const network = await new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: 9 });
    socket.on('connect', () => { socket.destroy(); resolve('allowed'); });
    socket.on('error', (error) => resolve(error.code));
  });
  assert.equal(network, 'EPERM');
});
`,
    );
    const saved = process.env.F325_FAKE_HOST_TOKEN;
    process.env.F325_FAKE_HOST_TOKEN = 'FAKE-HOST-TOKEN';
    try {
      const result = await runSandboxedNativeTaskTest({
        v: 1,
        taskId: 'task-pilot',
        workspaceRoot: workspace,
        testFile: 'task.test.mjs',
      });
      assert.equal(result.status, 'passed', result.output);
      assert.equal(result.exitCode, 0);
      assert.equal(readFileSync(secret, 'utf8'), 'FAKE-SECRET');
      assert.throws(() => readFileSync(output), /ENOENT/);
      assert.ok(!result.output.includes('FAKE-HOST-TOKEN'));
    } finally {
      if (saved === undefined) delete process.env.F325_FAKE_HOST_TOKEN;
      else process.env.F325_FAKE_HOST_TOKEN = saved;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'native task test refuses a symlink target before execution',
  { skip: process.platform !== 'darwin' },
  async () => {
    const root = realpathSync(mkdtempSync(join(userInfo().homedir, '.f325-native-task-test-')));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    writeFileSync(join(root, 'outside.test.mjs'), 'throw new Error("must not run")');
    symlinkSync(join(root, 'outside.test.mjs'), join(workspace, 'task.test.mjs'));
    try {
      await assert.rejects(
        runSandboxedNativeTaskTest({ v: 1, taskId: 'task-pilot', workspaceRoot: workspace, testFile: 'task.test.mjs' }),
        /symlink|outside|file/i,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('native task test stops a running test after cancellation', { skip: process.platform !== 'darwin' }, async () => {
  const root = realpathSync(mkdtempSync(join(userInfo().homedir, '.f325-native-task-test-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(
    join(workspace, 'task.test.mjs'),
    `import { test } from 'node:test';
test('waiting', async () => { await new Promise(() => {}); });
`,
  );
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    const result = await runSandboxedNativeTaskTest(
      { v: 1, taskId: 'task-pilot', workspaceRoot: workspace, testFile: 'task.test.mjs' },
      controller.signal,
    );
    assert.equal(result.status, 'cancelled');
    assert.ok(Date.now() - startedAt < 4_000, 'cancellation must terminate the only sandboxed process promptly');
  } finally {
    clearTimeout(timer);
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  'native task test cannot signal a process outside its sandbox',
  { skip: process.platform !== 'darwin' },
  async () => {
    const root = realpathSync(mkdtempSync(join(userInfo().homedir, '.f325-native-task-test-')));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const outside = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    const outsideClosed = new Promise((done) => outside.once('close', done));
    try {
      await new Promise((done, fail) => {
        outside.once('spawn', done);
        outside.once('error', fail);
      });
      writeFileSync(
        join(workspace, 'task.test.mjs'),
        `import { test } from 'node:test';
import { strict as assert } from 'node:assert';
test('cannot terminate a host process', () => {
  assert.throws(() => process.kill(${outside.pid}, 0), { code: 'EPERM' });
  assert.throws(() => process.kill(${outside.pid}, 'SIGTERM'), { code: 'EPERM' });
});
`,
      );
      const result = await runSandboxedNativeTaskTest({
        v: 1,
        taskId: 'task-pilot',
        workspaceRoot: workspace,
        testFile: 'task.test.mjs',
      });
      assert.equal(result.status, 'passed', result.output);
      assert.equal(outside.exitCode, null, 'a host process must remain alive');
    } finally {
      outside.kill('SIGKILL');
      await outsideClosed;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('native task test ends when its MCP parent is killed', { skip: process.platform !== 'darwin' }, async () => {
  const root = realpathSync(mkdtempSync(join(userInfo().homedir, '.f325-native-task-test-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const title = `f325t-${randomBytes(4).toString('hex')}`;
  writeFileSync(
    join(workspace, 'task.test.mjs'),
    `import { test } from 'node:test';
process.title = ${JSON.stringify(title)};
test('bounded spin', () => { const end = Date.now() + 30_000; while (Date.now() < end) {} });
`,
  );
  const grant = { v: 1, taskId: 'task-pilot', workspaceRoot: workspace, testFile: 'task.test.mjs' };
  const runnerUrl = new URL('../dist/tools/native-task-test-runner.js', import.meta.url).href;
  const parent = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { runSandboxedNativeTaskTest } from ${JSON.stringify(runnerUrl)}; await runSandboxedNativeTaskTest(${JSON.stringify(grant)});`,
    ],
    { stdio: 'ignore' },
  );
  const parentClosed = new Promise((done) => parent.once('close', done));
  const matchingPids = () =>
    execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
      .split('\n')
      .flatMap((line) => {
        const match = line.trim().match(/^(\d+)\s+(.+)$/);
        return match?.[2].includes(title) ? [Number(match[1])] : [];
      });
  try {
    let testPid;
    for (let attempt = 0; attempt < 100; attempt++) {
      testPid = matchingPids()[0];
      if (testPid) break;
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.ok(testPid, 'the model-authored test process must have started');
    parent.kill('SIGKILL');
    await parentClosed;
    await new Promise((done) => setTimeout(done, 1_500));
    assert.deepEqual(matchingPids(), [], 'the test must not survive its MCP parent');
  } finally {
    parent.kill('SIGKILL');
    await parentClosed;
    for (const pid of matchingPids()) process.kill(pid, 'SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});
