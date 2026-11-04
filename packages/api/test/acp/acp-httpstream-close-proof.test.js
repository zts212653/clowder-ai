import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AcpHttpStreamClient } from '../../dist/domains/cats/services/agents/providers/acp/AcpHttpStreamClient.js';

for (const beforeClose of [true, false])
  test(`a process error ${beforeClose ? 'before' : 'during'} close is not successful termination`, async (t) => {
    const signals = [];
    const child = Object.assign(new EventEmitter(), {
      pid: 12345,
      killed: false,
      exitCode: null,
      signalCode: null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill(signal) {
        signals.push(signal);
        this.killed = true;
        return true;
      },
    });
    const client = new AcpHttpStreamClient({ command: 'fixture', args: [], cwd: process.cwd(), spawnFn: () => child });
    client.discoverPort = async () => 12345;
    client.httpRequest = async () => ({ result: { agentInfo: { name: 'owned-http-test' } } });
    await client.initialize();
    if (beforeClose) child.emit('error', new Error('owned transport error'));
    let settled = false;
    const closing = client.close().then(
      () => {
        settled = true;
        return 'closed';
      },
      (error) => {
        settled = true;
        return error;
      },
    );
    t.after(async () => {
      child.emit('exit', 0, null);
      await closing;
    });
    if (!beforeClose) child.emit('error', new Error('owned shutdown error'));
    await new Promise((resolve) => setImmediate(resolve));
    if (beforeClose) {
      assert.deepEqual(signals, ['SIGTERM'], 'an earlier error must not skip stopping the owned process');
      assert.equal(settled, false, 'only real exit can finish this controlled shutdown');
      child.emit('exit', 0, null);
      assert.equal(await closing, 'closed');
    } else {
      const result = await closing;
      assert.ok(result instanceof Error);
      assert.match(result.message, /not confirmed/);
    }
  });

test('a failed spawn without a PID has no owned process to signal', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {
      assert.fail('spawn failure did not create an owned process');
    },
  });
  const client = new AcpHttpStreamClient({
    command: 'missing-owned-fixture',
    args: [],
    cwd: process.cwd(),
    spawnFn: () => {
      queueMicrotask(() => child.emit('error', new Error('owned spawn failure')));
      return child;
    },
  });
  client.discoverPort = async () => {
    throw new Error('owned spawn failure');
  };
  await assert.rejects(client.initialize(), /owned spawn failure/);
  await client.close();
});
