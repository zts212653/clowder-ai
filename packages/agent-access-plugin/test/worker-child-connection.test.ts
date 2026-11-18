import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';
import { attachWorkerChildConnection } from '../src/runtime/acp/worker-child-connection.ts';

/** A controllable handle that behaves like the Host-side `WorkerAcpChildHandle` answer. */
function fakeHandle(overrides = {}) {
  const writes = [];
  let terminate;
  const terminated = new Promise((resolve) => {
    terminate = resolve;
  });
  let writable = overrides.writable ?? true;
  let killed = false;
  let shutdownArgs;
  const handle = {
    pid: 4242,
    stdout: Readable.from(['']),
    stderr: Readable.from(['']),
    isWritable: () => writable,
    isKilled: () => killed,
    write: (line) => {
      if (overrides.writeRejects) return Promise.reject(overrides.writeRejects);
      writes.push(line);
    },
    termination: () => terminated,
    shutdown: async (graceMs, endStdin) => {
      shutdownArgs = { graceMs, endStdin };
    },
  };
  return {
    handle,
    writes,
    get shutdownArgs() {
      return shutdownArgs;
    },
    emitError: (error) => terminate({ kind: 'error', error }),
    emitExit: (code, signal) => terminate({ kind: 'exit', code, signal }),
    setWritable: (value) => {
      writable = value;
    },
    setKilled: (value) => {
      killed = value;
    },
  };
}

describe('attachWorkerChildConnection', () => {
  test('exposes the Host-answered pid and pipes through the admitted launch capability', async () => {
    const fake = fakeHandle();
    const connection = await attachWorkerChildConnection(async () => fake.handle);
    assert.equal(connection.pid, 4242);
    assert.equal(connection.stdout, fake.handle.stdout);
    assert.equal(connection.stderr, fake.handle.stderr);
    assert.equal(connection.isWritable(), true);
    assert.equal(connection.isKilled(), false);
  });

  test('a Host launch rejection surfaces as the attach error, not a half-built connection', async () => {
    const failure = Object.assign(new Error('host refused launch'), { code: 'launch_denied' });
    await assert.rejects(
      attachWorkerChildConnection(async () => {
        throw failure;
      }),
      (error) => error === failure && error.code === 'launch_denied',
    );
  });

  test('writes reach the Host callable and a rejected write is a terminal pipe failure', async () => {
    const fake = fakeHandle();
    const connection = await attachWorkerChildConnection(async () => fake.handle);

    connection.write('{"jsonrpc":"2.0"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(fake.writes, ['{"jsonrpc":"2.0"}\n']);
    assert.equal(connection.isWritable(), true);

    const rejection = new Error('EPIPE');
    const broken = fakeHandle({ writeRejects: rejection });
    const brokenConnection = await attachWorkerChildConnection(async () => broken.handle);
    const seen = [];
    brokenConnection.onError((error) => seen.push(error));

    brokenConnection.write('next\n');
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(seen, [rejection], 'the first async write failure becomes an onError fact');
    assert.equal(brokenConnection.isWritable(), false);
    assert.equal(brokenConnection.isKilled(), true);
    assert.throws(() => brokenConnection.write('again\n'), rejection, 'later writes throw the real cause');
  });

  test('a Host error reaches every listener, including listeners attached after termination', async () => {
    const fake = fakeHandle();
    const connection = await attachWorkerChildConnection(async () => fake.handle);
    const errors = [];
    connection.onError((error) => errors.push(error));

    const cause = new Error('child crashed');
    fake.emitError(cause);
    await new Promise((resolve) => setImmediate(resolve));
    connection.onError((error) => errors.push(error));

    assert.deepEqual(errors, [cause, cause]);
    assert.equal(connection.isWritable(), false);
  });

  test('a Host error makes the transport unusable', async () => {
    const fake = fakeHandle();
    const connection = await attachWorkerChildConnection(async () => fake.handle);

    fake.emitError(new Error('child crashed'));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(connection.isKilled(), true, 'an errored connection cannot be reused');
  });

  test('writing to an errored child throws its cause instead of feeding a dead handle', async () => {
    const fake = fakeHandle();
    const connection = await attachWorkerChildConnection(async () => fake.handle);

    const cause = new Error('child crashed');
    fake.emitError(cause);
    await new Promise((resolve) => setImmediate(resolve));

    assert.throws(() => connection.write('after the crash\n'), cause);
    assert.deepEqual(fake.writes, [], 'no bytes reach a child the Host already reported dead');
  });

  test('shutdown forwards grace and stdin policy to the Host and stays idempotent', async () => {
    const fake = fakeHandle();
    const connection = await attachWorkerChildConnection(async () => fake.handle);

    await connection.shutdown(1500, true);
    assert.deepEqual(fake.shutdownArgs, { graceMs: 1500, endStdin: true });
  });

  test('isWritable tracks the Host answer as liveness changes', async () => {
    const fake = fakeHandle();
    const connection = await attachWorkerChildConnection(async () => fake.handle);

    assert.equal(connection.isWritable(), true);
    fake.setWritable(false);
    // The attach snapshot cannot know a Host-side writable flip; only a live probe can.
    assert.equal(connection.isWritable(), true, 'snapshot liveness, not a live probe');

    fake.emitExit(0, null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(connection.isWritable(), false);
    assert.equal(connection.isKilled(), true);
  });
});
