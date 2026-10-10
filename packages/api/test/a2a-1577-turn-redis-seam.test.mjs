import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Redis } from 'ioredis';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.ts';
import { serializeTurnExecutionIdentity } from '../src/domains/cats/services/stores/ports/TurnExecutionStore.ts';
import { RedisTurnExecutionStore } from '../src/domains/cats/services/stores/redis/RedisTurnExecutionStore.ts';

// No inherited REDIS_URL, TCP listener, cleanup/flush or runtime config. This
// fixture owns one Redis process and retains its RDB/AOF, logs and every key.
let directory;
let server;
let serverExit;
let redis;
let store;
let log = '';
const prefix = 'a2a-turn-fixture:';

async function start() {
  server = spawn(
    'redis-server',
    [
      '--port',
      '0',
      '--unixsocket',
      join(directory, 'redis.sock'),
      '--unixsocketperm',
      '700',
      '--dir',
      directory,
      '--appendonly',
      'yes',
      '--appendfsync',
      'always',
      '--dbfilename',
      'dump.rdb',
      '--daemonize',
      'no',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  serverExit = once(server, 'exit');
  let startupLog = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('owned Redis readiness timeout')), 5000);
    const collect = (chunk) => {
      log += chunk;
      startupLog += chunk;
      if (/Ready to accept connections/i.test(startupLog)) {
        clearTimeout(timer);
        resolve();
      }
    };
    server.stdout.on('data', collect);
    server.stderr.on('data', collect);
    server.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`owned Redis exited ${code}`));
    });
  });
  await ready;
  redis = new Redis({
    path: join(directory, 'redis.sock'),
    keyPrefix: prefix,
    lazyConnect: true,
    retryStrategy: () => null,
    maxRetriesPerRequest: 0,
  });
  redis.on('error', () => {});
  await redis.connect();
  assert.equal(await redis.ping(), 'PONG');
  store = new RedisTurnExecutionStore(redis);
}

async function stop() {
  if (!server || server.exitCode !== null) return;
  if (redis?.status === 'ready') {
    await redis.save();
    // Redis closes the client on an acknowledged shutdown; join the exact
    // child process rather than sleeping or touching any unrelated process.
    await redis.shutdown('SAVE').catch((error) => {
      if (!/Connection is closed|Connection is closed by server/i.test(error.message)) throw error;
    });
    redis.disconnect();
  } else {
    server.kill('SIGTERM'); // Only the fixture's own directly spawned child.
  }
  const [code, signal] = await serverExit;
  assert.equal(code, 0, `owned Redis exit signal=${signal}`);
}

before(async () => {
  directory = await mkdtemp('/tmp/a2a-turn-');
  await start();
});
after(async () => {
  try {
    await stop();
  } finally {
    if (directory) {
      await writeFile(join(directory, 'redis.log'), log);
      console.log(`retained owned Redis data: ${directory}`);
    }
  }
});

function input(id, overrides = {}) {
  return {
    invocationId: id,
    parentInvocationId: `${id}-parent`,
    threadId: 'fixture-thread',
    userId: 'fixture-user',
    catId: 'codex-sol',
    executionKind: 'ordinary',
    startedAt: 100,
    causal: { triggerMessageId: `${id}-source` },
    ...overrides,
  };
}

for (const policy of [undefined, 'explicit_source']) {
  for (const fence of ['open', 'gated']) {
    test(`real Redis independently persists policy=${policy ?? 'ordinary'} fence=${fence}`, async () => {
      const spec = input(`matrix-${policy ?? 'ordinary'}-${fence}`, {
        ...(policy ? { queueCompletionPolicy: policy } : {}),
        outputFence: fence,
      });
      const memory = new InMemoryTurnExecutionStore();
      const actual = await store.createRunning(spec);
      assert.deepEqual(actual, memory.createRunning(spec));
      const raw = await redis.hgetall(`turnexec:record:${spec.invocationId}`);
      assert.equal(raw.queueCompletionPolicy, policy ?? '');
      assert.equal(raw.outputFence, fence);
      assert.equal(await redis.ttl(`turnexec:record:${spec.invocationId}`), -1);
      assert.deepEqual(await new RedisTurnExecutionStore(redis).get(spec.invocationId), actual.record);
    });
  }
}

test('real Redis concurrent create and policy identity drift never replace the admitted child', async () => {
  const spec = input('concurrent', { queueCompletionPolicy: 'explicit_source', outputFence: 'gated' });
  const competitor = new RedisTurnExecutionStore(redis);
  const results = await Promise.all([store.createRunning(spec), competitor.createRunning(spec)]);
  assert.deepEqual(results.map((result) => result.outcome).sort(), ['created', 'replayed']);
  assert.equal((await competitor.createRunning({ ...spec, queueCompletionPolicy: undefined })).outcome, 'conflict');
  assert.equal((await store.get(spec.invocationId)).queueCompletionPolicy, 'explicit_source');
  assert.deepEqual(
    (await store.listByParent(spec.parentInvocationId)).map((record) => record.invocationId),
    ['concurrent'],
  );
});

test('late coverage and output verdict remain monotone without changing policy identity', async () => {
  const spec = input('coverage', { queueCompletionPolicy: 'explicit_source', outputFence: 'gated' });
  await store.createRunning(spec);
  const originalIdentity = await redis.hget('turnexec:record:coverage', 'immutableIdentity');
  const competitor = new RedisTurnExecutionStore(redis);
  const results = await Promise.all([
    store.bindCoveredMessageIds('coverage', ['coverage-source', 'extra']),
    competitor.bindCoveredMessageIds('coverage', ['coverage-source', 'extra']),
  ]);
  assert.deepEqual(results.map((result) => result.outcome).sort(), ['bound', 'replayed']);
  assert.equal((await store.bindCoveredMessageIds('coverage', ['different'])).outcome, 'conflict');
  assert.equal((await store.settleOutputFence('coverage', 'allowed')).outputFence, 'allowed');
  assert.equal((await competitor.settleOutputFence('coverage', 'rejected')).outputFence, 'rejected');
  assert.equal((await store.settleOutputFence('coverage', 'allowed')).outputFence, 'rejected');
  assert.equal((await store.createRunning(spec)).record.outputFence, 'rejected');
  assert.equal((await store.get('coverage')).queueCompletionPolicy, 'explicit_source');
  assert.equal(await redis.hget('turnexec:record:coverage', 'immutableIdentity'), originalIdentity);
});

for (const policy of [undefined, 'explicit_source']) {
  test(`existing no-fence hash (${policy ?? 'fork legacy'}) is read without rewriting stored evidence`, async () => {
    const spec = input(`legacy-${policy ?? 'fork'}`, policy ? { queueCompletionPolicy: policy } : {});
    const raw = {
      immutableIdentity: serializeTurnExecutionIdentity(spec),
      invocationId: spec.invocationId,
      parentInvocationId: spec.parentInvocationId,
      threadId: spec.threadId,
      userId: spec.userId,
      catId: spec.catId,
      executionKind: spec.executionKind,
      startedAt: String(spec.startedAt),
      causal: JSON.stringify(spec.causal),
      status: 'running',
      ...(policy ? { queueCompletionPolicy: policy } : {}),
    };
    await redis.hset(`turnexec:record:${spec.invocationId}`, raw);
    const legacy = await store.get(spec.invocationId);
    assert.equal(legacy.queueCompletionPolicy, policy);
    assert.equal(Object.hasOwn(legacy, 'outputFence'), false);
    assert.equal((await store.createRunning(spec)).outcome, 'replayed');
    assert.equal(Object.hasOwn(await store.settleOutputFence(spec.invocationId, 'allowed'), 'outputFence'), false);
    assert.deepEqual(await redis.hgetall(`turnexec:record:${spec.invocationId}`), raw);
  });
}

test('unknown or mismatched durable policy/fence fails closed, including read-only running projection', async () => {
  await store.createRunning(input('corrupt-policy'));
  await redis.hset('turnexec:record:corrupt-policy', 'queueCompletionPolicy', 'future-policy');
  await assert.rejects(store.get('corrupt-policy'), /corrupt turn execution record/);
  await assert.rejects(store.listRunningByUser('fixture-user'), /failed to hydrate/);
  await redis.hset('turnexec:record:corrupt-policy', 'queueCompletionPolicy', 'explicit_source');
  await assert.rejects(store.get('corrupt-policy'), /corrupt turn execution record/);
  // Restore only the fixture value to continue other tests, retaining the hash.
  await redis.hset('turnexec:record:corrupt-policy', 'queueCompletionPolicy', '');
  await store.createRunning(input('corrupt-fence'));
  await redis.hset('turnexec:record:corrupt-fence', 'outputFence', 'unknown');
  await assert.rejects(store.get('corrupt-fence'), /corrupt turn execution record/);
  await redis.hset('turnexec:record:corrupt-fence', 'outputFence', 'open');
});

test('failed/canceled race, response-pending and policy/fence survive actual Redis process restart', async () => {
  const spec = input('restart', { queueCompletionPolicy: 'explicit_source', outputFence: 'gated' });
  await store.createRunning(spec);
  await store.settleOutputFence('restart', 'rejected');
  const competitor = new RedisTurnExecutionStore(redis);
  const results = await Promise.all([
    store.transitionTerminal('restart', { status: 'failed', endedAt: 200, terminalReason: 'fixture_failure' }),
    competitor.transitionTerminal('restart', { status: 'canceled', endedAt: 201, terminalReason: 'fixture_cancel' }),
  ]);
  assert.deepEqual(results.map((result) => result.outcome).sort(), ['already_terminal', 'transitioned']);
  const terminal = await store.get('restart');
  await stop();
  await start();
  assert.deepEqual(await store.get('restart'), terminal);
  assert.equal(terminal.outputFence, 'rejected');
  assert.equal(terminal.queueCompletionPolicy, 'explicit_source');
  assert.deepEqual(
    (await store.listResponsePending()).map((record) => record.invocationId),
    ['restart'],
  );
  assert.equal((await store.createRunning(spec)).outcome, 'replayed');
  assert.deepEqual(await store.get('restart'), terminal);
  assert.equal(await redis.ttl('turnexec:record:restart'), -1);
  assert.ok((await readFile(join(directory, 'dump.rdb'))).length > 0);
});
