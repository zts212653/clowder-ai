import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createExitedCliExecutionRecovery } from '../dist/domains/cats/services/agents/invocation/ExitedCliExecutionRecovery.js';
import { InvocationOwnerReaper } from '../dist/domains/cats/services/agents/invocation/InvocationOwnerReaper.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { getCliExecutionExit, getPersistedCliExecutionExit } from '../dist/utils/CliExecutionObservation.js';
import { recoverCliExecutionStop } from '../dist/utils/cli-execution-stop-recovery.js';
import { completeCliProcessOwnerCleanup } from '../dist/utils/cli-process-ownership.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

async function fixture(
  t,
  processStartedAt = 10,
  readProcessSnapshot = () => new Map(),
  store = new InMemoryTurnExecutionStore(),
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'provider-stop-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const owner = {
    executionId: randomUUID(),
    invocationId: randomUUID(),
    threadId: 'restart-thread',
    userId: 'restart-user',
    catId: 'opus55',
  };
  const manifest = {
    v: 1,
    ownerId: randomUUID(),
    createdAt: 1,
    execution: owner,
    supervisor: { pid: 424242, ppid: 424240, pgid: 424242, startedAt: 'Mon Nov 2 00:00:00 2026' },
  };
  const directory = join(dataDir, 'cli-process-owners');
  await mkdir(directory);
  const record = { path: join(directory, `${manifest.ownerId}.json`), manifest };
  await writeFile(record.path, JSON.stringify(manifest));
  const tracker = new InvocationTracker({ maxSlotTtlMs: 1 });
  await store.createRunning({
    ...owner,
    parentInvocationId: owner.executionId,
    executionKind: 'ordinary',
    startedAt: 1,
    providerLifecycleTracked: true,
  });
  await store.markProviderStarted(owner.invocationId, 1);
  const calls = [];
  const recoveryLog = [];
  const reaper = new InvocationOwnerReaper({
    invocationTracker: tracker,
    invocationRecordStore: {
      get: () => ({
        id: owner.executionId,
        threadId: owner.threadId,
        userId: owner.userId,
        status: 'running',
        targetCats: [owner.catId],
        createdAt: 1,
      }),
    },
    listRunningRecords: () => [
      {
        id: owner.executionId,
        threadId: owner.threadId,
        userId: owner.userId,
        status: 'running',
        targetCats: [owner.catId],
        createdAt: 1,
      },
    ],
    turnExecutionStore: store,
    ...createExitedCliExecutionRecovery(tracker, { dataDir, processStartedAt, readProcessSnapshot }),
    getProviderLifecycle: () => undefined,
    reconcileZombie: async () => {
      calls.push('reconcile');
      return { reconciled: 1, alreadyTerminal: 0, errors: 0 };
    },
    releaseExactOwner: () => {
      calls.push('release');
    },
    now: () => Date.now() + 10 * 60_000,
    ownerLeaseTtlMs: 1,
    log: {
      info(value) {
        recoveryLog.push(value);
      },
      warn() {},
    },
  });
  return { dataDir, owner, record, tracker, store, reaper, calls, recoveryLog };
}

test('cleanup persists exact tree-stop evidence before losing the owner; a fresh API recovers durable occupancy', async (t) => {
  const h = await fixture(t);
  // This cleanup primitive is reached only after supervisor/reaper proved its owned tree empty.
  completeCliProcessOwnerCleanup(h.record);
  await assert.rejects(readFile(h.record.path), { code: 'ENOENT' });
  assert.equal(h.tracker.getExecutionId(h.owner.threadId, h.owner.catId), undefined);
  assert.equal(h.store.get(h.owner.invocationId)?.status, 'running');
  const result = await h.reaper.runOnce();
  assert.equal(result.releasedTerminal, 1);
  const terminal = h.store.get(h.owner.invocationId);
  assert.equal(terminal?.status, 'interrupted');
  assert.ok(terminal?.providerTeardownAt);
  assert.deepEqual(h.calls, ['reconcile', 'release']);
  assert.deepEqual(h.recoveryLog.find((row) => row.event === 'provider_stop_proof_recovered').origins, ['cleanup']);
});

test('no process handle and no exact stop evidence never become teardown proof', async (t) => {
  const h = await fixture(t);
  await rm(h.record.path);
  await h.reaper.runOnce();
  assert.equal(h.store.get(h.owner.invocationId)?.status, 'running');
  assert.deepEqual(h.calls, []);
});

test('a new exact-scope supervisor vetoes old receipt recovery', async (t) => {
  const h = await fixture(t);
  completeCliProcessOwnerCleanup(h.record);
  await writeFile(h.record.path, JSON.stringify(h.record.manifest));
  await h.reaper.runOnce();
  assert.equal(h.store.get(h.owner.invocationId)?.status, 'running');
  assert.deepEqual(h.calls, []);
});

test('a replacement local controller cannot be aborted or released by old durable recovery', async (t) => {
  const h = await fixture(t);
  completeCliProcessOwnerCleanup(h.record);
  const controller = h.tracker.start(h.owner.threadId, h.owner.catId, h.owner.userId, [h.owner.catId], 'replacement');
  await h.reaper.runOnce();
  assert.equal(controller.signal.aborted, false);
  assert.equal(h.store.get(h.owner.invocationId)?.status, 'running');
  assert.deepEqual(h.calls, []);
});

test('evidence persistence failure retains the active manifest and never releases occupancy', async (t) => {
  const h = await fixture(t);
  await writeFile(join(h.dataDir, 'cli-execution-stops'), 'not a directory');
  assert.throws(() => completeCliProcessOwnerCleanup(h.record));
  assert.deepEqual(JSON.parse(await readFile(h.record.path, 'utf8')), h.record.manifest);
  await h.reaper.runOnce();
  assert.equal(h.store.get(h.owner.invocationId)?.status, 'running');
  assert.deepEqual(h.calls, []);
});

test('a current-boot child cannot use restart fencing just because its controller is missing', async (t) => {
  const h = await fixture(t, 0);
  completeCliProcessOwnerCleanup(h.record);
  await h.reaper.runOnce();
  assert.equal(h.store.get(h.owner.invocationId)?.status, 'running');
  assert.deepEqual(h.calls, []);
});

test('an old API actor still alive or an unavailable host probe vetoes restart recovery', async (t) => {
  for (const snapshot of [new Map([[424240, {}]]), null]) {
    const h = await fixture(t, 10, () => snapshot);
    completeCliProcessOwnerCleanup(h.record);
    await h.reaper.runOnce();
    assert.equal(h.store.get(h.owner.invocationId)?.status, 'running');
    assert.deepEqual(h.calls, []);
  }
});

test('authentic archived owner recovery previews first, publishes only observed proof, and leaves ledger retirement to its owner', async (t) => {
  const h = await fixture(t);
  await rm(h.record.path); // The archived record is retained; the active manifest was lost.
  const input = { record: h.record, expected: h.owner, dataDir: h.dataDir, readSnapshot: () => new Map() };
  assert.deepEqual(recoverCliExecutionStop(input), {
    verified: true,
    applied: false,
    reason: 'exact_owned_tree_stopped',
  });
  await h.reaper.runOnce();
  assert.equal(h.store.get(h.owner.invocationId)?.status, 'running', 'preview must not manufacture a receipt');
  assert.equal(recoverCliExecutionStop({ ...input, apply: true }).applied, true);
  assert.deepEqual(getPersistedCliExecutionExit(h.owner, { dataDir: h.dataDir }).origins, [
    'operator_archived_manifest',
  ]);
  assert.equal(h.store.get(h.owner.invocationId)?.status, 'running', 'the helper never writes the execution ledger');
  assert.equal((await h.reaper.runOnce()).releasedTerminal, 1);
  assert.deepEqual(h.recoveryLog.find((row) => row.event === 'provider_stop_proof_recovered').origins, [
    'operator_archived_manifest',
  ]);
});

test('same-child owners must all clear before proof aggregation, preserving host PID union', async (t) => {
  const h = await fixture(t);
  completeCliProcessOwnerCleanup(h.record);
  const second = {
    ...h.record.manifest,
    ownerId: randomUUID(),
    supervisor: { ...h.record.manifest.supervisor, pid: 424252, ppid: 424250 },
  };
  const record = { path: join(h.dataDir, 'cli-process-owners', `${second.ownerId}.json`), manifest: second };
  await writeFile(record.path, JSON.stringify(second));
  assert.equal(getPersistedCliExecutionExit(h.owner, { dataDir: h.dataDir }), undefined);
  await h.reaper.runOnce();
  assert.equal(h.store.get(h.owner.invocationId).status, 'running');
  completeCliProcessOwnerCleanup(record);
  const proof = getPersistedCliExecutionExit(h.owner, { dataDir: h.dataDir });
  assert.deepEqual(new Set(proof.hostPids), new Set([424240, 424250]));
  assert.deepEqual(proof.origins, ['cleanup']);
  assert.equal((await h.reaper.runOnce()).releasedTerminal, 1);
});

test('an active sibling child vetoes recovery of a proved older child', async (t) => {
  const h = await fixture(t);
  completeCliProcessOwnerCleanup(h.record);
  const sibling = {
    ...h.record.manifest,
    ownerId: randomUUID(),
    execution: { ...h.owner, invocationId: 'another-child' },
  };
  await writeFile(join(h.dataDir, 'cli-process-owners', `${sibling.ownerId}.json`), JSON.stringify(sibling));
  await h.reaper.runOnce();
  assert.equal(h.store.get(h.owner.invocationId).status, 'running');
  assert.deepEqual(h.calls, []);
});

test('malformed sibling proof prevents the entire child from acquiring stop authority', async (t) => {
  const h = await fixture(t);
  completeCliProcessOwnerCleanup(h.record);
  const [scopeKey] = await readdir(join(h.dataDir, 'cli-execution-stops'));
  await writeFile(join(h.dataDir, 'cli-execution-stops', scopeKey, 'bad.json'), '{}');
  await h.reaper.runOnce();
  assert.equal(h.store.get(h.owner.invocationId).status, 'running');
  assert.deepEqual(h.calls, []);
});

test('disk proof uses exactly five identity coordinates; normal reads never consult persisted proof', async (t) => {
  const h = await fixture(t);
  completeCliProcessOwnerCleanup(h.record);
  const richerScope = { ...h.owner, turnInvocationId: h.owner.invocationId };
  assert.ok(getPersistedCliExecutionExit(richerScope, { dataDir: h.dataDir }));
  const prior = process.env.CAT_CAFE_DATA_DIR;
  process.env.CAT_CAFE_DATA_DIR = h.dataDir;
  try {
    assert.equal(getCliExecutionExit(h.owner), undefined, 'ordinary settlement reads only current-process events');
  } finally {
    if (prior === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = prior;
  }
});

test('archived owner recovery rejects a foreign scope, old host, original process, descendant, or incomplete scan', async (t) => {
  const h = await fixture(t);
  await rm(h.record.path);
  const input = { record: h.record, expected: h.owner, dataDir: h.dataDir, apply: true };
  const sameSupervisor = new Map([[h.record.manifest.supervisor.pid, h.record.manifest.supervisor]]);
  const descendant = {
    pid: 424244,
    ppid: 1,
    pgid: 424244,
    startedAt: 'Mon Nov 2 01:00:00 2026',
    commandAndEnvironment: `CAT_CAFE_PROCESS_OWNER_ID=${h.record.manifest.ownerId}`,
  };
  const cases = [
    { ...input, expected: { ...h.owner, userId: 'foreign' }, readSnapshot: () => new Map() },
    { ...input, readSnapshot: () => new Map([[424240, {}]]) },
    { ...input, readSnapshot: () => sameSupervisor },
    {
      ...input,
      readSnapshot: (options) => (options.includeEnvironment ? new Map([[descendant.pid, descendant]]) : new Map()),
    },
    { ...input, readSnapshot: () => null },
  ];
  for (const value of cases) assert.equal(recoverCliExecutionStop(value).verified, false);
  await h.reaper.runOnce();
  assert.equal(h.store.get(h.owner.invocationId)?.status, 'running');
  assert.deepEqual(h.calls, []);
});

test('operator preview rejects invalid JSON without printing its contents', async (t) => {
  const h = await fixture(t);
  const file = join(h.dataDir, 'wrong-input');
  await writeFile(file, 'sensitive-content-that-must-not-be-echoed');
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../dist/scripts/recover-cli-execution-stop.js', import.meta.url)),
      '--manifest',
      file,
      '--expected-scope',
      file,
      '--data-dir',
      h.dataDir,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Recovery input could not be read as JSON/);
  assert.equal((result.stdout + result.stderr).includes('sensitive-content-that-must-not-be-echoed'), false);
});

test(
  'restart stop proof commits a persistent Redis terminal before parent release',
  {
    skip: redisIsolationSkipReason(process.env.REDIS_URL),
  },
  async (t) => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'provider-restart-stop');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    const { RedisTurnExecutionStore } = await import(
      '../dist/domains/cats/services/stores/redis/RedisTurnExecutionStore.js'
    );
    const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `provider-stop:${randomUUID()}:` });
    try {
      const h = await fixture(t, 10, () => new Map(), new RedisTurnExecutionStore(redis));
      completeCliProcessOwnerCleanup(h.record);
      assert.equal((await h.reaper.runOnce()).releasedTerminal, 1);
      const record = await new RedisTurnExecutionStore(redis).get(h.owner.invocationId);
      assert.equal(record.status, 'interrupted');
      assert.ok(record.providerTeardownAt);
      assert.equal(await redis.ttl(`turnexec:record:${h.owner.invocationId}`), -1);
      assert.deepEqual(h.calls, ['reconcile', 'release']);
    } finally {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  },
);
