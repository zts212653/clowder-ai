import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ManagedJobService } from '../dist/domains/managed-job/ManagedJobService.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

async function until(check, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(25);
  }
  throw new Error(`Timed out: ${label}`);
}

// The job is gated by a file, not a guessed sleep: API #2 must observe it alive before it may exit.
// Three real API processes share only persistent stores; QueueProcessor/Router run the receiver.
// The model provider records its input and ends deterministically without external network calls.
test(
  'sqlite command survives API death and delivers its real failure exactly once across two restarts',
  {
    skip: redisIsolationSkipReason(process.env.REDIS_URL),
    timeout: 90_000,
  },
  async (t) => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'managed command restart');
    const root = mkdtempSync(join(tmpdir(), 'managed-command-api-restart-'));
    const children = [];
    t.after(async () => {
      writeFileSync(join(root, 'release'), 'cleanup');
      for (const child of children) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        const ended = once(child, 'exit');
        child.kill('SIGTERM');
        await Promise.race([ended, delay(5_000, undefined, { ref: false })]);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await ended;
        }
      }
      const service = new ManagedJobService(root);
      await until(async () => {
        await service.reconcile();
        return service
          .list()
          .every((job) =>
            ['succeeded', 'failed', 'cancelled', 'lost', 'timed_out'].includes(
              service.get(job.definition.principal, job.jobId).state,
            ),
          );
      }, 'owned command cleanup');
      rmSync(root, { recursive: true, force: true });
    });
    async function startApi() {
      const child = spawn(
        process.execPath,
        [new URL('./helpers/managed-command-restart-api.mjs', import.meta.url).pathname],
        {
          env: { ...process.env, CAT_CAFE_DATA_DIR: root, REDIS_KEY_PREFIX: `restart-1843:${root.split('/').at(-1)}:` },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      children.push(child);
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr.on('data', (chunk) => {
        output += chunk;
      });
      const ready = await until(() => {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`API exited: ${output}`);
        const line = output.split('\n').find((entry) => entry.startsWith('RESTART_API_READY:'));
        return line && JSON.parse(line.slice('RESTART_API_READY:'.length));
      }, 'isolated HTTP API ready').catch((error) => {
        throw new Error(`${error.message}\n${output.slice(-8000)}`, { cause: error });
      });
      const get = async (path) => {
        const response = await fetch(`${ready.address}${path}`, { signal: AbortSignal.timeout(5_000) });
        assert.equal(response.status, 200, await response.clone().text());
        return response.json();
      };
      return { child, get, address: ready.address };
    }
    async function crash(api) {
      const ended = once(api.child, 'exit');
      api.child.kill('SIGKILL');
      await ended;
    }
    const commandFile = join(root, 'command.cjs');
    writeFileSync(
      commandFile,
      `const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(join(root, 'command-starts'))}, ${JSON.stringify('once\n')});
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(join(root, 'release'))})) return;
  clearInterval(timer); console.log('REAL-RESULT-1843'); process.exitCode = 3;
}, 20);\n`,
    );
    const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
    const first = await startApi();
    const auth = await first.get('/fixture/auth');
    const response = await fetch(`${first.address}/api/callbacks/hold-ball`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-invocation-id': auth.invocationId,
        'x-callback-token': auth.callbackToken,
      },
      body: JSON.stringify({
        reason: 'restart regression',
        nextStep: 'inspect original result',
        wakeWhen: {
          command: `${quote(process.execPath)} ${quote(commandFile)}`,
          cwd: root,
          executionSlaMs: 60_000,
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const { taskId } = await response.json();
    await until(
      async () => (await first.get('/fixture/state')).jobs.some((job) => job.state === 'running'),
      'real worker running',
    );
    await crash(first);

    const second = await startApi();
    const alive = await second.get('/fixture/state');
    assert.equal(
      alive.tasks.find((task) => task.id === taskId).params.holdLifecycle.managedCommand.state,
      'command_running',
    );
    assert.equal(alive.jobs[0].state, 'running');
    assert.equal(existsSync(join(root, 'provider-inputs.jsonl')), false, 'no premature restart-loss wake');
    writeFileSync(join(root, 'release'), 'finish original execution');
    const settled = await until(async () => {
      const state = await second.get('/fixture/state');
      return (
        state.tasks.find((task) => task.id === taskId).params.holdLifecycle.managedCommand.state === 'consumed' && state
      );
    }, 'original result consumed by actual receiver');
    const result = settled.tasks.find((task) => task.id === taskId).params.holdLifecycle.managedCommand.result;
    assert.equal(result.exitCode, 3);
    assert.match(result.tailOutput, /REAL-RESULT-1843/);
    assert.equal(settled.jobs[0].state, 'failed');
    assert.equal(
      settled.messages.filter(
        (message) => message.source?.meta?.taskId === taskId && message.source.meta.phase === 'wake',
      ).length,
      1,
    );
    assert.equal(settled.lostReceipts.length, 0);
    await crash(second);
    const third = await startApi();
    assert.equal((await third.get('/fixture/state')).queue.length, 0);
    const inputs = readFileSync(join(root, 'provider-inputs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(inputs.length, 1, 'recovery must not mint a second receiver execution');
    assert.match(inputs[0].prompt, /REAL-RESULT-1843/);
    assert.equal(
      inputs[0].prompt.includes('退出码 3'),
      true,
      'the receiver must see the real nonzero exit, not only stdout',
    );
    const wake = settled.messages.find(
      (message) => message.source?.meta?.taskId === taskId && message.source.meta.phase === 'wake',
    );
    const responseId = wake.lifecycle.dispatchRefs.find((ref) => ref.targetId === 'opus').statusMessageId;
    const receiver = settled.messages.find((message) => message.id === responseId);
    assert.equal(receiver.lifecycle.status, 'completed');
    assert.equal(receiver.lifecycle.invocationId, inputs[0].invocationId);
    assert.equal(readFileSync(join(root, 'command-starts'), 'utf8'), 'once\n');
  },
);
