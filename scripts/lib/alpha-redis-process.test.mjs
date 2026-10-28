import assert from 'node:assert/strict';
import { symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as redisProcess from './alpha-redis-process.mjs';
import { captureNamedAlphaRedisIdentity, verifyNamedAlphaRedisIdentity } from './alpha-redis-process.mjs';
import { redisFixture } from './alpha-redis-process-test-fixture.mjs';
import './alpha-redis-listener-observation.test.mjs';

test('named Redis ownership captures the listener pidfile and canonical start identity without protocol reads', (t) => {
  const { raw, deps, identity } = redisFixture(t);
  const proof = captureNamedAlphaRedisIdentity(raw, deps);
  assert.equal(proof.pid, 41021);
  assert.deepEqual(proof.process, identity);
  assert.equal(verifyNamedAlphaRedisIdentity(raw, proof, deps), true);
});

test('serving tracked changes retain captured Redis identity without authorizing a new capture', (t) => {
  const { f, raw, deps, identity } = redisFixture(t);
  const proof = captureNamedAlphaRedisIdentity(raw, deps);
  writeFileSync(join(f.alphaRoot, 'packages/web/package.json'), '{"generatedDuringServing":true}\n');
  assert.throws(() => captureNamedAlphaRedisIdentity(raw, deps), /tracked changes/);
  assert.equal(verifyNamedAlphaRedisIdentity(raw, proof, deps), true);
  assert.throws(() => verifyNamedAlphaRedisIdentity(raw, proof, { ...deps, readListeners: () => [41022] }), /replaced/);
  assert.throws(
    () => verifyNamedAlphaRedisIdentity(raw, proof, { ...deps, capture: () => ({ ...identity, cwd: '/foreign' }) }),
    /incarnation/,
  );
  writeFileSync(join(f.alphaRoot, 'packages/api/dist/.build-commit'), 'not-the-captured-revision');
  assert.throws(() => verifyNamedAlphaRedisIdentity(raw, proof, deps), /compiled revision/);
});

test('replacement listener or stale same PID refuses before any Redis protocol or process signal', (t) => {
  const { raw, deps, identity } = redisFixture(t);
  const proof = captureNamedAlphaRedisIdentity(raw, deps);
  let osReads = 0;
  assert.throws(
    () =>
      verifyNamedAlphaRedisIdentity(raw, proof, {
        readListeners: () => [41022],
        capture: () => {
          osReads += 1;
          return identity;
        },
      }),
    /replaced/,
  );
  assert.equal(osReads, 0, 'foreign listener is rejected before even its process metadata is read');
  for (const changed of [
    { ...identity, startedAtEpochMs: identity.startedAtEpochMs + 1000 },
    { ...identity, cwd: '/foreign' },
    { ...identity, command: 'redis-server fake-alias' },
    { ...identity, ucomm: 'node' },
  ])
    assert.throws(() => verifyNamedAlphaRedisIdentity(raw, proof, { ...deps, capture: () => changed }), /incarnation/);
});

test('pidfile aliases, unrelated PIDs and forged command aliases cannot mint ownership', (t) => {
  const { raw, deps, identity, pidFile } = redisFixture(t);
  assert.throws(() => captureNamedAlphaRedisIdentity(raw, { ...deps, readListeners: () => [41022] }), /pidfile/);
  assert.throws(
    () =>
      captureNamedAlphaRedisIdentity(raw, {
        ...deps,
        capture: () => ({ ...identity, command: 'python redis-server' }),
      }),
    /process identity/,
  );
  writeFileSync(pidFile, '9'.repeat(33));
  assert.throws(() => captureNamedAlphaRedisIdentity(raw, deps), /bounded/);
  // Use a second fixture scope for the final-component link, preserving the first fact.
  const linked = redisFixture(t);
  const other = join(linked.f.directory, 'other.pid');
  writeFileSync(other, '41021\n');
  unlinkSync(linked.pidFile);
  symlinkSync(other, linked.pidFile);
  assert.throws(() => captureNamedAlphaRedisIdentity(linked.raw, linked.deps), /regular file/);
});

test('Redis capture and verification distinguish unreadable argv from a replaced process', (t) => {
  const { raw, deps, identity } = redisFixture(t);
  const proof = captureNamedAlphaRedisIdentity(raw, deps);
  const unavailable = { ...identity, command: '(redis-server)', argvAvailable: false };
  const capture = () => unavailable;
  assert.throws(() => captureNamedAlphaRedisIdentity(raw, { ...deps, capture }), /process identity unreadable/);
  assert.throws(() => verifyNamedAlphaRedisIdentity(raw, proof, { ...deps, capture }), /process identity unreadable/);
  assert.throws(
    () => verifyNamedAlphaRedisIdentity(raw, { ...proof, process: unavailable }, deps),
    /process identity unreadable/,
  );
  for (const delta of [
    { startedAtEpochMs: identity.startedAtEpochMs + 1000 },
    { cwd: '/foreign' },
    { ucomm: 'node' },
  ]) {
    assert.throws(
      () => verifyNamedAlphaRedisIdentity(raw, proof, { ...deps, capture: () => ({ ...unavailable, ...delta }) }),
      /incarnation changed/,
    );
  }
  assert.throws(
    () => captureNamedAlphaRedisIdentity(raw, { ...deps, capture: () => ({ ...unavailable, cwd: '/foreign' }) }),
    /does not match its new home/,
  );
});

test('failed Redis captures preserve their cause and remain unproven', (t) => {
  const { raw, deps } = redisFixture(t);
  const proof = captureNamedAlphaRedisIdentity(raw, deps);
  const cause = new Error('fixture process read failed');
  const capture = () => {
    throw cause;
  };
  for (const action of [
    () => captureNamedAlphaRedisIdentity(raw, { ...deps, capture }),
    () => verifyNamedAlphaRedisIdentity(raw, proof, { ...deps, capture }),
  ]) {
    assert.throws(action, (error) => {
      assert.match(error.message, /process identity unreadable/);
      assert.equal(error.cause, cause);
      assert.ok(error.message.includes(cause.message), error.message);
      return true;
    });
  }
});

function readinessFixture(t, observations) {
  const f = redisFixture(t);
  const proof = captureNamedAlphaRedisIdentity(f.raw, f.deps);
  let elapsed = 0;
  const calls = [];
  let reads = 0;
  const deps = {
    readListeners: () => {
      calls.push('listeners');
      return [proof.pid];
    },
    capture: () => {
      calls.push('identity');
      const next = observations[Math.min(reads++, observations.length - 1)];
      elapsed += next.elapsed ?? 0;
      if (next.error) throw next.error;
      return { ...f.identity, ...next };
    },
    now: () => elapsed,
    sleep: (ms) => {
      elapsed += ms;
      calls.push('wait');
    },
    run: (command, args, options) => {
      calls.push('protocol');
      assert.equal(command, 'redis-cli');
      assert.deepEqual(args, ['-h', '127.0.0.1', '-p', '15397', '--raw', 'ping']);
      assert.equal(options.timeout, 2000);
      return 'PONG\n';
    },
  };
  return { ...f, proof, deps, calls, reads: () => reads, elapsed: () => elapsed };
}

const unreadable = { command: '(redis-server)', argvAvailable: false };

test('startup PING rechecks complete identity after transient unreadable argv, never using cached fields', (t) => {
  const f = readinessFixture(t, [unreadable, {}]);
  const savedProof = structuredClone(f.proof);
  assert.equal(redisProcess.pingNamedAlphaRedis(f.raw, f.proof, f.deps), true);
  assert.deepEqual(f.calls, ['listeners', 'identity', 'wait', 'listeners', 'identity', 'protocol']);
  assert.deepEqual(f.proof, savedProof, 'an unreadable sample must not modify the stored ownership proof');
});

test('startup PING preserves a permanently unreadable refusal and has bounded rereads', (t) => {
  const f = readinessFixture(t, [unreadable]);
  assert.throws(() => redisProcess.pingNamedAlphaRedis(f.raw, f.proof, f.deps), /argv unavailable/);
  assert.ok(f.reads() > 1 && f.reads() <= 10);
  assert.ok(f.elapsed() <= 1000);
  assert.equal(f.calls.includes('protocol'), false);
});

test('startup PING stops on a conclusive identity difference even when argv is unreadable', (t) => {
  for (const delta of [
    { cwd: '/foreign' },
    { startedAtEpochMs: 123 },
    { ucomm: 'node' },
    { command: 'redis-server foreign', argvAvailable: true },
  ]) {
    const f = readinessFixture(t, [{ ...unreadable, ...delta }, {}]);
    assert.throws(() => redisProcess.pingNamedAlphaRedis(f.raw, f.proof, f.deps), /incarnation/);
    assert.equal(f.reads(), 1);
    assert.equal(f.calls.includes('wait'), false);
    assert.equal(f.calls.includes('protocol'), false);
  }
});

test('startup PING rejects replacement listeners, invalid stored proof and capture exceptions without retries', (t) => {
  const replaced = readinessFixture(t, [{}]);
  assert.throws(
    () =>
      redisProcess.pingNamedAlphaRedis(replaced.raw, replaced.proof, {
        ...replaced.deps,
        readListeners: () => [41022],
      }),
    /replaced/,
  );
  assert.equal(replaced.calls.length, 0);
  const unproven = readinessFixture(t, [{}]);
  assert.throws(
    () =>
      redisProcess.pingNamedAlphaRedis(
        unproven.raw,
        {
          ...unproven.proof,
          process: { ...unproven.proof.process, ...unreadable },
        },
        unproven.deps,
      ),
    /unreadable/,
  );
  assert.equal(unproven.reads(), 1);
  assert.equal(unproven.calls.includes('protocol'), false);
  const gone = readinessFixture(t, [{ error: new Error('fixture ESRCH') }, {}]);
  assert.throws(() => redisProcess.pingNamedAlphaRedis(gone.raw, gone.proof, gone.deps), /fixture ESRCH/);
  assert.equal(gone.reads(), 1);
  assert.equal(gone.calls.includes('protocol'), false);
});

test('a listener replaced during the retry wait never receives a PING', (t) => {
  const f = readinessFixture(t, [unreadable, {}]);
  let listeners = 0;
  assert.throws(
    () =>
      redisProcess.pingNamedAlphaRedis(f.raw, f.proof, {
        ...f.deps,
        readListeners: () => [++listeners === 1 ? 41021 : 41022],
      }),
    /replaced/,
  );
  assert.equal(listeners, 2);
  assert.equal(f.reads(), 1, 'second listener check refuses before another identity read');
  assert.equal(f.calls.includes('protocol'), false);
});

test('startup identity rereads cannot extend the replaced one-second wait or publish late success', (t) => {
  const unknown = readinessFixture(t, [unreadable, { ...unreadable, elapsed: 980 }, {}]);
  assert.throws(() => redisProcess.pingNamedAlphaRedis(unknown.raw, unknown.proof, unknown.deps), /argv unavailable/);
  assert.equal(unknown.reads(), 2, 'do not start another observation after the retry deadline');
  assert.equal(unknown.calls.includes('protocol'), false);
  const slow = readinessFixture(t, [unreadable, { elapsed: 1001 }]);
  assert.throws(() => redisProcess.pingNamedAlphaRedis(slow.raw, slow.proof, slow.deps), /wait budget/);
  assert.equal(slow.calls.includes('protocol'), false);
});

test('the original first identity check does not consume the one-second settling allowance', (t) => {
  const readable = readinessFixture(t, [{ elapsed: 1200 }]);
  assert.equal(redisProcess.pingNamedAlphaRedis(readable.raw, readable.proof, readable.deps), true);
  assert.equal(readable.reads(), 1);
  const recovered = readinessFixture(t, [{ ...unreadable, elapsed: 1200 }, { elapsed: 350 }]);
  assert.equal(redisProcess.pingNamedAlphaRedis(recovered.raw, recovered.proof, recovered.deps), true);
  assert.equal(recovered.reads(), 2);
  assert.ok(
    recovered.elapsed() - 1200 < 1000,
    'only the extra observation and wait use the replaced settling allowance',
  );
});

test('repeated unavailable samples never slide the original retry deadline forward', (t) => {
  const f = readinessFixture(t, [{ ...unreadable, elapsed: 120 }]);
  assert.throws(() => redisProcess.pingNamedAlphaRedis(f.raw, f.proof, f.deps), /wait budget/);
  assert.equal(f.reads(), 8, 'seven additional observations fit; a fresh budget for every refusal would allow ten');
  assert.equal(f.elapsed(), 1120, 'the retry allowance starts once, after the first 120ms observation');
  assert.equal(f.calls.includes('protocol'), false);
});

test('startup PING reports protocol refusal separately and does not replay a protocol command', (t) => {
  for (const result of ['NOAUTH Authentication required.', new Error('fixture connection refused')]) {
    const f = readinessFixture(t, [{}]);
    let pings = 0;
    assert.throws(
      () =>
        redisProcess.pingNamedAlphaRedis(f.raw, f.proof, {
          ...f.deps,
          run: () => {
            pings += 1;
            if (result instanceof Error) throw result;
            return result;
          },
        }),
      /Alpha Redis PING.*(NOAUTH|connection refused)/,
    );
    assert.equal(pings, 1);
    assert.equal(f.reads(), 1);
  }
});
