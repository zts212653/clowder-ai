import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  captureNamedAlphaRedisIdentity,
  pingNamedAlphaRedis,
  verifyNamedAlphaRedisIdentity,
} from './alpha-redis-process.mjs';
import { redisFixture } from './alpha-redis-process-test-fixture.mjs';

const listenerTimeout = () => Object.assign(new Error('spawnSync lsof ETIMEDOUT'), { code: 'ETIMEDOUT' });

// Mock observations use a logical clock; real Git fixture latency is not a simulated timeout.
const observationNow = () => 0;

test('Redis verification reobserves a transient unreadable argv with the entire ownership scope', (t) => {
  const f = redisFixture(t);
  const proof = captureNamedAlphaRedisIdentity(f.raw, f.deps);
  let listeners = 0;
  let captures = 0;
  assert.equal(
    verifyNamedAlphaRedisIdentity(f.raw, proof, {
      observationNow,
      readListeners: () => {
        listeners += 1;
        return [proof.pid];
      },
      capture: () =>
        ++captures === 1 ? { ...f.identity, command: '(redis-server)', argvAvailable: false } : f.identity,
    }),
    true,
  );
  assert.equal(listeners, 2, 'a readable process alone cannot reuse the first listener observation');
  assert.equal(captures, 2);
});

test('argv reobservation refuses replacement, persistent uncertainty, changed scope and late success', (t) => {
  const f = redisFixture(t);
  const proof = captureNamedAlphaRedisIdentity(f.raw, f.deps);
  const unreadable = { ...f.identity, command: '(redis-server)', argvAvailable: false };
  for (const outcome of ['replaced-listener', 'replaced-process', 'unreadable', 'late']) {
    let listeners = 0;
    let captures = 0;
    let elapsed = 0;
    assert.throws(
      () =>
        verifyNamedAlphaRedisIdentity(f.raw, proof, {
          readListeners: () => [++listeners === 2 && outcome === 'replaced-listener' ? proof.pid + 1 : proof.pid],
          capture: () => {
            if (++captures === 1 || outcome === 'unreadable') return unreadable;
            if (outcome === 'replaced-process')
              return { ...f.identity, startedAtEpochMs: f.identity.startedAtEpochMs + 1 };
            if (outcome === 'late') elapsed = 1001;
            return f.identity;
          },
          observationNow: () => elapsed,
        }),
      /replaced|incarnation|argv unavailable|budget/,
    );
    assert.equal(listeners, 2, 'one bounded extra observation, including persistent uncertainty');
  }
  let captures = 0;
  assert.throws(
    () =>
      verifyNamedAlphaRedisIdentity(f.raw, proof, {
        ...f.deps,
        observationNow,
        capture: () => {
          captures += 1;
          f.f.git(['checkout', '--detach'], f.f.alphaRoot);
          return unreadable;
        },
      }),
    /checkout|branch|target/i,
  );
  assert.equal(captures, 1, 'the retry must revalidate the checkout before reading process identity again');
});

test('listener timeout and unreadable argv share one reobservation allowance', (t) => {
  const f = redisFixture(t);
  const proof = captureNamedAlphaRedisIdentity(f.raw, f.deps);
  let listeners = 0;
  let captures = 0;
  assert.throws(
    () =>
      verifyNamedAlphaRedisIdentity(f.raw, proof, {
        observationNow,
        readListeners: () => {
          if (++listeners === 1) throw listenerTimeout();
          return [proof.pid];
        },
        capture: () => {
          captures += 1;
          return { ...f.identity, command: '(redis-server)', argvAvailable: false };
        },
      }),
    /argv unavailable/,
  );
  assert.equal(listeners, 2);
  assert.equal(captures, 1, 'changing failure kind cannot grant a third attempt');
});

test('a transient listener timeout reobserves the complete Redis identity before granting ownership', (t) => {
  const f = redisFixture(t);
  const proof = captureNamedAlphaRedisIdentity(f.raw, f.deps);
  for (const operation of [
    (deps) => captureNamedAlphaRedisIdentity(f.raw, deps),
    (deps) => verifyNamedAlphaRedisIdentity(f.raw, proof, deps),
  ]) {
    let reads = 0;
    const value = operation({
      ...f.deps,
      observationNow,
      readListeners: () => {
        if (++reads === 1) throw listenerTimeout();
        return [proof.pid];
      },
    });
    assert.ok(value);
    assert.equal(reads, 2);
  }
});

test('listener reobservation never accepts replacement, stale scope or an exhausted budget', (t) => {
  const f = redisFixture(t);
  const proof = captureNamedAlphaRedisIdentity(f.raw, f.deps);
  for (const failAgain of [true, false]) {
    let reads = 0;
    assert.throws(
      () =>
        verifyNamedAlphaRedisIdentity(f.raw, proof, {
          ...f.deps,
          observationNow,
          readListeners: () => {
            reads += 1;
            if (reads === 1 || failAgain) throw listenerTimeout();
            return [proof.pid + 1];
          },
        }),
      failAgain ? /ETIMEDOUT/ : /replaced/,
    );
    assert.equal(reads, 2, 'one bounded retry, not an unbounded polling loop');
  }
  let elapsed = 0;
  let reads = 0;
  assert.throws(
    () =>
      verifyNamedAlphaRedisIdentity(f.raw, proof, {
        ...f.deps,
        observationNow: () => elapsed,
        readListeners: () => {
          if (++reads === 1) throw listenerTimeout();
          elapsed += 1001;
          return [proof.pid];
        },
      }),
    /budget|deadline/,
  );
  assert.equal(reads, 2);
  reads = 0;
  assert.throws(
    () =>
      verifyNamedAlphaRedisIdentity(f.raw, proof, {
        ...f.deps,
        observationNow,
        readListeners: () => {
          reads += 1;
          f.f.git(['checkout', '--detach'], f.f.alphaRoot);
          throw listenerTimeout();
        },
      }),
    /checkout|branch|target/i,
  );
  assert.equal(reads, 1, 'retry revalidates the entire Git scope before another listener read');
});

test('a new incarnation after listener timeout cannot receive a protocol command', (t) => {
  const f = redisFixture(t);
  const proof = captureNamedAlphaRedisIdentity(f.raw, f.deps);
  let reads = 0;
  let commands = 0;
  assert.throws(
    () =>
      pingNamedAlphaRedis(f.raw, proof, {
        now: observationNow,
        readListeners: () => {
          if (++reads === 1) throw listenerTimeout();
          return [proof.pid];
        },
        capture: () => ({ ...f.identity, startedAtEpochMs: f.identity.startedAtEpochMs + 1000 }),
        run: () => {
          commands += 1;
          return 'PONG';
        },
      }),
    /incarnation changed/,
  );
  assert.equal(reads, 2);
  assert.equal(commands, 0);
});
