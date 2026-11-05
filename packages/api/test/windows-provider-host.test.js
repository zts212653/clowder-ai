/**
 * #1838: each Windows provider runs in its own host, whose kernel job owns only that provider tree.
 *
 * Real processes only. The provider must not start before `launch`, its stdio and exit code must pass
 * through the host unchanged, and closing the host must reap a writer whose launcher already exited
 * while a process the API started outside the host keeps running. Everything is an isolated fixture:
 * temp directories, and only PIDs this test created.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const isWindows = process.platform === 'win32';
const { prepareWindowsProviderHost } = await import(new URL('../dist/utils/windows-provider-host.js', import.meta.url));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function killOwned(pid) {
  if (!pid || !alive(pid)) return;
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch {
    // Already gone.
  }
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'issue1838-provider-host-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = (name, lines) => {
    writeFileSync(join(dir, name), lines.join('\n'));
    return join(dir, name);
  };
  return { dir, dataDir: join(dir, 'data'), script };
}

function collect(child) {
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => {
    output.stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output.stderr += chunk;
  });
  return output;
}

test(
  'the provider starts only on launch and its stdio and exit code pass through the host',
  { skip: !isWindows, timeout: 60_000 },
  async (t) => {
    const { dir, dataDir, script } = fixture(t);
    const provider = script('echo.cjs', [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(join(dir, 'started'))}, String(process.pid));`,
      "process.stderr.write('provider-stderr\\n');",
      "process.stdin.once('data', (line) => { process.stdout.write('echo:' + line); process.exitCode = 7; process.stdin.destroy(); });",
    ]);
    const host = await prepareWindowsProviderHost({ dataDir });
    t.after(() => killOwned(host.job.apiPid));
    assert.notEqual(host.job.apiPid, process.pid, 'the API itself is not the job owner');
    assert.equal(existsSync(host.job.path), true, 'the job is recorded before anything is launched');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(existsSync(join(dir, 'started')), false, 'nothing runs before launch');

    const child = host.launch({ command: process.execPath, args: [provider], env: { ...process.env } });
    const output = collect(child);
    child.stdin.write('hello\n');
    const [code] = await once(child, 'exit');
    assert.equal(code, 7, 'the provider exit code passes through');
    assert.match(output.stdout, /echo:hello/);
    assert.match(output.stderr, /provider-stderr/);
    assert.throws(() => host.launch({ command: process.execPath, args: [provider] }), /already_launched|exited/);

    const evidence = await host.close();
    assert.deepEqual([evidence.verdict, evidence.reason], ['absent', 'job_closed_owner_gone']);
    assert.equal(existsSync(host.job.path), false, 'an absent job leaves no owner record behind');
  },
);

// `stop`: a Stop ends the host while the provider runs. `end`: the launcher exits by itself right
// after detaching its writer (the broken PPID chain), so the turn ends normally with a writer left.
for (const ending of ['stop', 'end'])
  test(
    `${ending}: the host's job reaps a detached writer, and nothing started outside it`,
    { skip: !isWindows, timeout: 60_000 },
    async (t) => {
      const { dir, dataDir, script } = fixture(t);
      const writer = script('writer.cjs', ['setInterval(() => {}, 1000);']);
      const launcher = script('launcher.cjs', [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `const writer = spawn(process.execPath, [${JSON.stringify(writer)}], { stdio: 'ignore', detached: true });`,
        'writer.unref();',
        `fs.writeFileSync(${JSON.stringify(join(dir, 'writer.pid'))}, String(writer.pid));`,
        ...(ending === 'stop' ? ['setInterval(() => {}, 1000);'] : []),
      ]);
      // A background service the API itself started: it must outlive the provider host.
      const service = spawn(process.execPath, [writer], { stdio: 'ignore', detached: true, windowsHide: true });
      service.unref();
      t.after(() => killOwned(service.pid));

      const host = await prepareWindowsProviderHost({ dataDir });
      t.after(() => killOwned(host.job.apiPid));
      host.launch({ command: process.execPath, args: [launcher], env: { ...process.env } });
      const writerPid = Number(
        await waitFor(
          () => existsSync(join(dir, 'writer.pid')) && readFileSync(join(dir, 'writer.pid'), 'utf8'),
          15_000,
          'writer',
        ),
      );
      t.after(() => killOwned(writerPid));
      // With `end` the host may already be leaving its job, so only the running case is checked here.
      if (ending === 'stop') assert.equal(alive(writerPid), true);

      // Either way the host's exit closes its job, which takes the detached writer with it; close()
      // reports that verdict instead of trusting the host exit alone.
      const evidence = await host.close();
      assert.equal(evidence.verdict, 'absent', evidence.reason);
      await waitFor(() => !alive(writerPid), 5_000, 'writer reaped');
      assert.equal(alive(service.pid), true, 'a process started outside the host keeps running');
    },
  );

test('a host closed before launch never starts its provider', { skip: !isWindows, timeout: 60_000 }, async (t) => {
  const { dir, dataDir } = fixture(t);
  const host = await prepareWindowsProviderHost({ dataDir });
  t.after(() => killOwned(host.job.apiPid));
  const evidence = await host.close();
  assert.equal(evidence.verdict, 'absent', evidence.reason);
  assert.equal(existsSync(join(dir, 'started')), false);
  assert.throws(() => host.launch({ command: process.execPath, args: ['-e', ''] }), /exited|already_launched/);
});

test('a provider crash code survives the host unchanged', { skip: !isWindows, timeout: 60_000 }, async (t) => {
  const { dataDir, script } = fixture(t);
  // 0xC0000409, the libuv crash code spawnCli recognises after a completed semantic turn.
  const provider = script('crash.cjs', ['process.exitCode = 3221226505;']);
  const host = await prepareWindowsProviderHost({ dataDir });
  t.after(() => killOwned(host.job.apiPid));
  const child = host.launch({ command: process.execPath, args: [provider], env: { ...process.env } });
  const [code] = await once(child, 'exit');
  assert.equal(code, 3221226505);
  assert.equal((await host.close()).verdict, 'absent');
});

test(
  'a missing provider command reports 127 on stderr instead of hanging',
  { skip: !isWindows, timeout: 60_000 },
  async (t) => {
    const { dataDir } = fixture(t);
    const host = await prepareWindowsProviderHost({ dataDir });
    t.after(() => killOwned(host.job.apiPid));
    const child = host.launch({ command: 'clowder-no-such-provider-1838', args: [] });
    const output = collect(child);
    const [code] = await once(child, 'exit');
    assert.equal(code, 127);
    assert.match(output.stderr, /spawn failed/);
    assert.equal((await host.close()).verdict, 'absent');
  },
);

const { createWindowsProviderHostScope, bindWindowsProviderHostScope } = await import(
  new URL('../dist/utils/windows-provider-host.js', import.meta.url)
);
const { readWindowsJobExecutionLinks } = await import(
  new URL('../dist/utils/windows-job-execution-links.js', import.meta.url)
);
const { spawnCli } = await import(new URL('../dist/utils/cli-spawn.js', import.meta.url));
const EXECUTION = {
  executionId: 'scope-parent',
  invocationId: 'scope-child',
  threadId: 'scope-thread',
  catId: 'codex',
  userId: 'scope-user',
};

test(
  'a scope links every host to the exact execution before it can launch',
  { skip: !isWindows, timeout: 90_000 },
  async (t) => {
    const { dataDir } = fixture(t);
    const scope = await createWindowsProviderHostScope({ execution: EXECUTION, dataDir });
    const first = await scope.take();
    const second = await scope.take();
    t.after(() => {
      for (const host of [first, second]) killOwned(host.job.apiPid);
    });
    assert.notEqual(first.job.jobName, second.job.jobName, 'a later provider gets its own job');
    for (const host of [first, second]) {
      const { links } = readWindowsJobExecutionLinks(host.job.jobName, dataDir);
      assert.deepEqual(
        links.map((link) => link.execution),
        [EXECUTION],
        'linked before launch',
      );
    }
    assert.equal(await scope.close(), true, 'every job verifiably closed');
    for (const host of [first, second]) assert.equal(existsSync(host.job.path), false);
    scope.clearLinks();
    for (const host of [first, second])
      assert.deepEqual(readWindowsJobExecutionLinks(host.job.jobName, dataDir).links, []);
  },
);

async function drain(iterator) {
  for (;;) if ((await iterator.next()).done) return;
}

for (const owner of ['own', 'other']) {
  test(
    `spawnCli ${owner === 'own' ? 'inside its execution scope reaps' : 'for another invocation leaves'} a broken-chain writer`,
    { skip: !isWindows, timeout: 90_000 },
    async (t) => {
      const { dir, dataDir, script } = fixture(t);
      const writer = script('writer.cjs', ['setInterval(() => {}, 1000);']);
      const launcher = script('launcher.cjs', [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `const writer = spawn(process.execPath, [${JSON.stringify(writer)}], { stdio: 'ignore', detached: true });`,
        'writer.unref();',
        `fs.writeFileSync(${JSON.stringify(join(dir, 'writer.pid'))}, String(writer.pid));`,
      ]);
      const scope = await createWindowsProviderHostScope({ execution: EXECUTION, dataDir });
      const invocationId = owner === 'own' ? EXECUTION.invocationId : 'unrelated-title-cli';
      await drain(
        bindWindowsProviderHostScope(
          () => spawnCli({ command: process.execPath, args: [launcher], invocationId })[Symbol.asyncIterator](),
          scope,
        ),
      );
      const writerPid = Number(readFileSync(join(dir, 'writer.pid'), 'utf8'));
      t.after(() => killOwned(writerPid));
      assert.equal(await scope.close(), true);
      if (owner === 'own') await waitFor(() => !alive(writerPid), 5_000, 'writer reaped with its host job');
      else assert.equal(alive(writerPid), true, "a process of another invocation is not this execution's to stop");
    },
  );
}
