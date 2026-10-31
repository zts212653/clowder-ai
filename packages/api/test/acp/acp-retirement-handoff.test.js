import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AcpClient } from '../../dist/domains/cats/services/agents/providers/acp/AcpClient.js';
import { AcpProcessPool } from '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js';
import { shutdownAcpChild } from '../../dist/domains/cats/services/agents/providers/acp/lifecycle/acp-child-shutdown.js';

const gate = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const tick = () => new Promise((done) => setImmediate(done));

for (const mode of ['TTL', 'LRU']) {
  for (const closePool of [false, true]) {
    test(
      `${mode} replacement waits for actual close${closePool ? ' and respects pool shutdown' : ''}`,
      { timeout: 5000 },
      async () => {
        const closing = gate(),
          exited = gate();
        const clients = [];
        const pool = new AcpProcessPool(
          { maxLiveProcesses: 1, idleTtlMs: mode === 'TTL' ? 1 : 60000 },
          { supportsMultiplexing: true },
          () => {
            const first = clients.length === 0;
            const client = {
              isAlive: true,
              isCwdIntact: true,
              async initialize() {},
              async close() {
                this.isAlive = false;
                if (first) {
                  closing.resolve();
                  await exited.promise;
                }
              },
            };
            clients.push(client);
            return client;
          },
        );
        const key = { projectPath: '/handoff', providerProfile: 'pi' };
        try {
          const first = await pool.acquire(key);
          pool.rememberSession(key, 'native-session', first);
          first.release();
          if (mode === 'TTL') await closing.promise;
          const nextKey = mode === 'LRU' ? { ...key, projectPath: '/other-project' } : key;
          const replacement = pool.acquire(nextKey, { sessionId: 'native-session' });
          await closing.promise;
          await tick();
          assert.equal(clients.length, 1, 'a replacement must not spawn while the real writer is retiring');
          if (closePool) {
            const closed = pool.closeAll();
            exited.resolve();
            await assert.rejects(replacement, /closed|retired/i);
            await closed;
            assert.equal(clients.length, 1, 'pool shutdown must not create a late replacement');
            assert.equal(pool.getMetrics().liveProcessCount, 0);
            return;
          }
          exited.resolve();
          const next = await replacement;
          assert.notEqual(next.client, first.client);
          next.release();
        } finally {
          exited.resolve();
          await pool.closeAll();
        }
      },
    );
  }
}

test('AcpClient concurrent close callers wait for the same real process exit', async () => {
  const events = new EventEmitter();
  const child = Object.assign(events, {
    pid: 12345,
    killed: false,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {
      this.killed = true;
      return true;
    },
  });
  child.stdin.on('data', (chunk) => {
    const request = JSON.parse(chunk.toString());
    child.stdout.write(JSON.stringify({ id: request.id, result: { agentInfo: { name: 'test' } } }) + '\n');
  });
  const client = new AcpClient({ command: 'fixture', args: [], cwd: '/fixture', spawnFn: () => child });
  await client.initialize();
  let firstDone = false,
    secondDone = false;
  const first = client.close().then(() => {
    firstDone = true;
  });
  const second = client.close().then(() => {
    secondDone = true;
  });
  try {
    await tick();
    assert.equal(firstDone, false);
    assert.equal(secondDone, false, 'closed/killed flags do not prove exit');
  } finally {
    child.emit('exit', 0, null);
    child.stdout.end();
    child.stderr.end();
    await Promise.all([first, second]);
  }
});

for (const pi of [false, true]) {
  test(`forced shutdown ${pi ? 'rejects unconfirmed Pi retirement' : 'still waits for actual exit'}`, async () => {
    const killed = gate();
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      kill(signal) {
        if (signal === 'SIGKILL') killed.resolve();
        return true;
      },
    });
    let settled = false;
    const closing = shutdownAcpChild(child, 1, pi);
    void closing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await killed.promise;
    assert.equal(settled, false, 'a kill signal is not an exit acknowledgement');
    child.emit('exit', null, 'SIGKILL');
    if (pi) await assert.rejects(closing, /unconfirmed/);
    else await closing;
  });
}
