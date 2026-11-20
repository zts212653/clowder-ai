import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

for (const scenario of ['log-open-failure', 'normal-close', 'exit-after-start'])
  test(`foreground admission after ${scenario}`, { timeout: 10000 }, async (t) => {
    const folder = await mkdtemp(join(tmpdir(), 'owned-tripwire-startup-'));
    if (scenario === 'log-open-failure')
      await mkdir(join(folder, `event-loop-tripwire.${new Date().toISOString().slice(0, 10)}.ndjson`));
    const child = fork(
      new URL('./helpers/tripwire-inspector-fault-api.mjs', import.meta.url),
      [scenario === 'exit-after-start' ? scenario : 'no-fault', 'hold', folder],
      { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    const events = [];
    let stderr = '';
    child.on('message', (event) => events.push(event));
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const exited = once(child, 'exit');
    t.after(async () => {
      if (child.connected) child.send({ type: 'close' });
      const timer = setTimeout(() => child.kill('SIGKILL'), 1500);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
        await rm(folder, { recursive: true, force: true });
      }
    });
    async function wait(predicate) {
      const until = performance.now() + 5000;
      while (performance.now() < until) {
        const found = events.find(predicate);
        if (found) return found;
        assert.equal(child.exitCode, null, stderr);
        await delay(10);
      }
      assert.fail(`missing event: ${JSON.stringify(events)} ${stderr}`);
    }
    const readiness = await wait((event) => event.type === 'ready');
    if (scenario !== 'exit-after-start') assert.equal(readiness.ready, scenario === 'normal-close');
    if (scenario === 'log-open-failure') {
      assert.equal((await wait((event) => event.type === 'observer-error')).code, 'EISDIR');
      assert.equal(
        events.some((event) => event.type === 'test-control'),
        false,
      );
      assert.equal(
        events.some((event) => event.type === 'test-profiler-state'),
        false,
      );
    } else if (scenario === 'exit-after-start') {
      assert.equal((await wait((event) => event.type === 'test-control')).failed, false);
      assert.ok(events.some((event) => event.type === 'test-profiler-state' && event.safe === false));
    } else {
      await wait((event) => event.type === 'test-control' && event.stage === 'start-delivered');
      child.send({ type: 'close-observer' });
      await wait((event) => event.type === 'observer-closed');
    }
    await wait((event) => event.type === 'observer-exit');
    child.send({ type: 'foreground', id: 'after-exit' });
    const result = await wait((event) => event.type === 'foreground-result');
    assert.equal(result.admitted, scenario !== 'exit-after-start', 'foreground must follow the last dispatch proof');
    if (scenario !== 'exit-after-start') assert.equal(result.status, 'sampled');
  });
