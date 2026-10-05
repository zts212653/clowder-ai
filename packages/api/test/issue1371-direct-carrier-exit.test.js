import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createExitedCliExecutionRecovery } from '../dist/domains/cats/services/agents/invocation/ExitedCliExecutionRecovery.js';
import { InvocationOwnerReaper } from '../dist/domains/cats/services/agents/invocation/InvocationOwnerReaper.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { createDirectAgentCarrierSession } from '../dist/domains/cats/services/agents/providers/DirectAgentCarrierSession.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { getCliExecutionExit } from '../dist/utils/CliExecutionObservation.js';

test('real direct carrier produces exact exit evidence consumed by the existing owner reaper', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'issue1371-direct-'));
  const owner = {
    executionId: randomUUID(),
    invocationId: randomUUID(),
    threadId: randomUUID(),
    userId: 'fixture-owner',
    catId: 'codex-sol',
  };
  const tracker = new InvocationTracker({ maxSlotTtlMs: 1 });
  const controller = tracker.start(owner.threadId, owner.catId, owner.userId, [owner.catId], owner.executionId);
  const store = new InMemoryTurnExecutionStore();
  await store.createRunning({
    ...owner,
    parentInvocationId: owner.executionId,
    executionKind: 'ordinary',
    startedAt: Date.now(),
  });
  const session = await createDirectAgentCarrierSession(
    {
      command: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify({result:"done"})+"\\n")'],
      env: { CAT_CAFE_DATA_DIR: dataDir },
      invocationId: owner.invocationId,
    },
    { executionOwner: owner },
  );
  try {
    const output = [];
    for await (const item of session.read()) output.push(item);
    assert.deepEqual(output, [{ result: 'done' }]);
    assert.ok(getCliExecutionExit(owner)?.exitedAt, 'direct carrier must publish its own exact process exit');
    assert.equal(getCliExecutionExit({ ...owner, userId: 'foreign' }), undefined);
    const transitions = [];
    const reaper = new InvocationOwnerReaper({
      invocationTracker: tracker,
      invocationRecordStore: {
        get: () => ({
          id: owner.executionId,
          threadId: owner.threadId,
          userId: owner.userId,
          targetCats: [owner.catId],
          status: 'running',
          createdAt: 1,
        }),
      },
      turnExecutionStore: store,
      ...createExitedCliExecutionRecovery(tracker),
      getProviderLifecycle: () => undefined,
      reconcileZombie: async () => {
        transitions.push('parent');
        return { reconciled: 1, alreadyTerminal: 0, errors: 0 };
      },
      releaseExactOwner: () => {
        transitions.push('release');
        tracker.completeByExecutionId(owner.threadId, owner.catId, owner.executionId);
      },
      now: () => Date.now() + 8 * 60 * 60 * 1000,
      log: { info() {}, warn() {} },
    });
    assert.equal((await reaper.runOnce()).releasedTerminal, 1);
    assert.equal(controller.signal.aborted, true);
    assert.equal(store.get(owner.invocationId).status, 'interrupted');
    assert.deepEqual(transitions, ['parent', 'release']);
  } finally {
    await session.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('direct unsupervised carrier bounds actual exit with inherited stdout and preserves buffered JSON', async () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  let session;
  try {
    // Exercise the real unsupervised platform branch on every OS; no fake child or pipe.
    Object.defineProperty(process, 'platform', { value: 'win32' });
    session = await createDirectAgentCarrierSession({
      command: process.execPath,
      args: [
        '-e',
        'require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>{},3000)"],{stdio:["ignore",1,2]});process.stdout.write("{\\"n\\":1}\\n{\\"n\\":2}\\n");process.exit(0)',
      ],
      invocationId: randomUUID(),
    });
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
  let first;
  const seen = new Promise((resolve) => {
    first = resolve;
  });
  const output = [];
  const reading = (async () => {
    for await (const item of session.read()) {
      output.push(item);
      first();
      await delay(40);
    }
  })();
  try {
    await seen;
    const bounded = await Promise.race([reading.then(() => true), delay(1500).then(() => false)]);
    await reading; // The fixture descendant exits naturally even on RED.
    assert.equal(bounded, true, 'direct carrier must not wait for inherited pipes beyond exit drain');
    assert.deepEqual(output, [{ n: 1 }, { n: 2 }]);
  } finally {
    await session.close();
  }
});

test('direct identity mismatch and pre-aborted turns are refused before process creation', async () => {
  const invocationId = randomUUID();
  const options = { command: 'must-not-spawn-fixture', args: [], invocationId };
  const owner = { executionId: randomUUID(), invocationId, threadId: randomUUID(), userId: 'u', catId: 'codex-sol' };
  await assert.rejects(
    createDirectAgentCarrierSession(options, { executionOwner: { ...owner, invocationId: 'foreign-child' } }),
    /direct_carrier_owner_mismatch/,
  );
  const controller = new AbortController();
  controller.abort(new Error('fixture already cancelled'));
  await assert.rejects(
    createDirectAgentCarrierSession({ ...options, signal: controller.signal }, { executionOwner: owner }),
    /fixture already cancelled/,
  );
  assert.equal(getCliExecutionExit(owner), undefined);
});

test('direct nonzero exit keeps stderr diagnostics while cleaning inherited stderr', async () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  let session;
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    session = await createDirectAgentCarrierSession({
      command: process.execPath,
      args: [
        '-e',
        'require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>process.stderr.write(\\"delayed diagnostic\\"),150);setTimeout(()=>{},2500)"],{stdio:["ignore","ignore",2]});process.stdout.write("{\\"n\\":1}\\n");process.exit(7)',
      ],
      invocationId: randomUUID(),
    });
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
  try {
    await assert.rejects(async () => {
      for await (const _item of session.read()) {
        /* Consume until the real error. */
      }
    }, /code 7: delayed diagnostic/);
  } finally {
    await session.close();
  }
});
