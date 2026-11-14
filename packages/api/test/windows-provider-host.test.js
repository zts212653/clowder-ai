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
    assert.equal(host.job.controller?.pid, process.pid, 'the record names the API that can launch into it');
    assert.match(host.job.controller?.createdAt ?? '', /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, 'full-precision birth');
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
    assert.equal(existsSync(host.job.path), true, 'until a stop is recorded, a restart still finds this job');
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
    for (const host of [first, second])
      assert.equal(existsSync(host.job.path), true, 'evidence stays until the stop is recorded');
    scope.clearEvidence();
    for (const host of [first, second]) {
      assert.deepEqual(readWindowsJobExecutionLinks(host.job.jobName, dataDir).links, []);
      assert.equal(existsSync(host.job.path), false, 'link and owner record leave together');
    }
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

const { recordVerifiedWindowsJobTeardowns, stopWithWindowsJobProof } = await import(
  new URL('../dist/domains/cats/services/agents/invocation/WindowsJobStopRecovery.js', import.meta.url)
);
const { InMemoryTurnExecutionStore } = await import(
  new URL('../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js', import.meta.url)
);

function startedChild() {
  const store = new InMemoryTurnExecutionStore();
  store.createRunning({
    executionId: EXECUTION.executionId,
    invocationId: EXECUTION.invocationId,
    parentInvocationId: EXECUTION.executionId,
    threadId: EXECUTION.threadId,
    catId: EXECUTION.catId,
    userId: EXECUTION.userId,
    executionKind: 'ordinary',
    startedAt: 1,
    providerLifecycleTracked: true,
  });
  store.markProviderStarted(EXECUTION.invocationId, 2);
  return store;
}

// The API confirmed the host job closed, then died before its canonical teardown was durable (or the
// write failed). The next process must still find the job and finish that stop, retrying a failure.
test(
  'a stop not yet durable keeps the whole evidence, and a failed write is retried',
  { skip: !isWindows, timeout: 90_000 },
  async (t) => {
    const { dataDir } = fixture(t);
    const scope = await createWindowsProviderHostScope({ execution: EXECUTION, dataDir });
    const host = await scope.take();
    t.after(() => killOwned(host.job.apiPid));
    await once(host.launch({ command: process.execPath, args: ['-e', ''], env: { ...process.env } }), 'exit');
    assert.equal(await scope.close(), true);
    assert.equal(existsSync(host.job.path), true, 'closed but not durably stopped: the owner record stays');

    const store = startedChild();
    let failOnce = true;
    const flaky = {
      get: (id) => store.get(id),
      recordProviderTeardown: (id, at) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('teardown write failed');
        }
        return store.recordProviderTeardown(id, at);
      },
    };
    // While its controlling API lives, a closed job is no stop: that API could still start a host.
    const whileControllerLives = await recordVerifiedWindowsJobTeardowns({ store: flaky, dataDir });
    assert.deepEqual(whileControllerLives.released, []);
    assert.deepEqual(
      whileControllerLives.preserved.filter((entry) => entry.invocationId === EXECUTION.invocationId),
      [{ invocationId: EXECUTION.invocationId, reason: 'controller_not_gone' }],
    );
    const stopWhileLives = await stopWithWindowsJobProof({
      store,
      record: await store.get(EXECUTION.invocationId),
      dataDir,
    });
    assert.deepEqual(stopWhileLives, { stopped: false, reason: 'controller_not_gone' });
    // The recorded controller is now a different process (same pid, another birth): it is gone.
    const owner = JSON.parse(readFileSync(host.job.path, 'utf8'));
    writeFileSync(
      host.job.path,
      JSON.stringify({ ...owner, controller: { ...owner.controller, createdAt: '2000-01-01T00:00:00.0000000Z' } }),
    );
    const first = await recordVerifiedWindowsJobTeardowns({ store: flaky, dataDir });
    assert.deepEqual(first.released, []);
    assert.ok(first.preserved.some((entry) => entry.reason.startsWith('teardown_write_failed')));
    assert.equal(existsSync(host.job.path), true, 'a failed write keeps the proof for the retry');
    assert.equal(readWindowsJobExecutionLinks(host.job.jobName, dataDir).links.length, 1);

    const retry = await recordVerifiedWindowsJobTeardowns({ store: flaky, dataDir });
    assert.deepEqual(retry.released, [EXECUTION.invocationId]);
    assert.equal(typeof (await store.get(EXECUTION.invocationId)).providerTeardownAt, 'number');
  },
);

// A retry ran the provider in a second host. One closed job says nothing about the other: when the
// second job's owner record is missing or unreadable, neither recovery nor a Stop may release it.
for (const damage of ['missing', 'unreadable']) {
  test(
    `an execution whose other job owner is ${damage} keeps its protection`,
    { skip: !isWindows, timeout: 90_000 },
    async (t) => {
      const { dataDir } = fixture(t);
      const scope = await createWindowsProviderHostScope({ execution: EXECUTION, dataDir });
      const first = await scope.take();
      const second = await scope.take();
      t.after(() => {
        for (const host of [first, second]) killOwned(host.job.apiPid);
      });
      assert.equal(await scope.close(), true);
      if (damage === 'missing') rmSync(second.job.path);
      else writeFileSync(second.job.path, '{ not json');

      const store = startedChild();
      const pass = await recordVerifiedWindowsJobTeardowns({ store, dataDir });
      assert.deepEqual(pass.released, []);
      assert.ok(
        pass.preserved.some(
          (entry) => entry.invocationId === EXECUTION.invocationId && entry.reason === 'linked_job_not_closed',
        ),
      );
      assert.equal((await store.get(EXECUTION.invocationId)).providerTeardownAt, undefined);

      const stop = await stopWithWindowsJobProof({ store, record: await store.get(EXECUTION.invocationId), dataDir });
      assert.equal(stop.stopped, false);
      assert.equal((await store.get(EXECUTION.invocationId)).status, 'running');
    },
  );
}

// A corrupted birth is no identity: it must not read as a different, gone process and release an
// execution whose controlling API still lives.
test('a corrupted controller birth keeps the execution protected', { skip: !isWindows, timeout: 90_000 }, async (t) => {
  const { dataDir } = fixture(t);
  const scope = await createWindowsProviderHostScope({ execution: EXECUTION, dataDir });
  const host = await scope.take();
  t.after(() => killOwned(host.job.apiPid));
  assert.equal(await scope.close(), true);
  const owner = JSON.parse(readFileSync(host.job.path, 'utf8'));
  writeFileSync(
    host.job.path,
    JSON.stringify({ ...owner, controller: { ...owner.controller, createdAt: 'not-a-process-birth' } }),
  );
  const store = startedChild();
  const pass = await recordVerifiedWindowsJobTeardowns({ store, dataDir });
  assert.deepEqual(pass.released, []);
  assert.equal((await store.get(EXECUTION.invocationId)).providerTeardownAt, undefined);
});

const { createDirectAgentCarrierSession } = await import(
  new URL('../dist/domains/cats/services/agents/providers/DirectAgentCarrierSession.js', import.meta.url)
);

// Seam 2: a direct app_server session of the turn starts in a linked host, like spawnCli does; a
// session under another invocationId (a read-only command) is not this execution's to own.
for (const owner of ['own', 'other']) {
  test(
    `a direct session ${owner === 'own' ? 'of the turn reaps' : 'of another invocation leaves'} a broken-chain writer`,
    { skip: !isWindows, timeout: 90_000 },
    async (t) => {
      const { dir, dataDir, script } = fixture(t);
      const writer = script('writer.cjs', ['setInterval(() => {}, 1000);']);
      const provider = script('provider.cjs', [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `const writer = spawn(process.execPath, [${JSON.stringify(writer)}], { stdio: 'ignore', detached: true });`,
        'writer.unref();',
        `fs.writeFileSync(${JSON.stringify(join(dir, 'writer.pid'))}, String(writer.pid));`,
        'setInterval(() => {}, 1000);',
      ]);
      const scope = await createWindowsProviderHostScope({ execution: EXECUTION, dataDir });
      const invocationId = owner === 'own' ? EXECUTION.invocationId : 'readonly-command';
      const iterator = bindWindowsProviderHostScope(
        () =>
          (async function* () {
            yield await createDirectAgentCarrierSession({ command: process.execPath, args: [provider], invocationId });
          })(),
        scope,
      );
      const wire = (await iterator.next()).value;
      const writerPid = Number(
        await waitFor(
          () => existsSync(join(dir, 'writer.pid')) && readFileSync(join(dir, 'writer.pid'), 'utf8'),
          15_000,
          'writer',
        ),
      );
      t.after(() => killOwned(writerPid));
      await wire.terminate?.();
      assert.equal(await scope.close(), true);
      if (owner === 'own') await waitFor(() => !alive(writerPid), 5_000, 'writer reaped with its host job');
      else assert.equal(alive(writerPid), true, "a session of another invocation is not this execution's to stop");
    },
  );
}
