import assert from 'node:assert/strict';
import { test } from 'node:test';
import { watcherSessionChainKey } from '../../dist/domains/cats/services/session/session-scope.js';

export function watcherRolloverCases(createStore) {
  async function seed() {
    const sessions = await createStore();
    const userId = crypto.randomUUID();
    const input = { userId, catId: 'codex', threadId: 'rollover-line' };
    const home = await sessions.create(input);
    const chainKey = watcherSessionChainKey(userId, input.catId, input.threadId);
    const old = await sessions.create({
      ...input,
      chainKey,
      sessionPurpose: 'watcher',
      cliSessionId: `native-${userId}`,
    });
    const progress = {
      afterSequence: 54,
      notes: 'retained notes',
      consumedThrough: 'original',
      messageOffset: 1240,
      backfillAfter: { messageId: 'restore-after-backfill', offset: 18 },
      rawSince: 1700000000000,
      activationCut: '0:1',
    };
    const operation = {
      id: `retire-${old.id}`,
      wakeInvocationId: 'old-wake',
      sourceInvocationId: 'old-source',
      sourceSequence: 55,
      oldSchemaHash: 'a'.repeat(64),
      nativeCliSessionId: old.cliSessionId,
      phase: 'pending',
      probes: 2,
    };
    await sessions.compareAndSetWatcherState(
      old.id,
      0,
      {
        revision: 1,
        ...progress,
        toolSchemaHash: operation.oldSchemaHash,
        rawWindowTokens: 128,
        directoryReads: [],
        skippedWindows: 3,
      },
      operation,
    );
    return { sessions, home, old, progress, operation, chainKey };
  }
  test('retirement remains discoverable after Host pointers clear; atomic successor carries only stable reading progress', async () => {
    const f = await seed();
    assert.ok((await f.sessions.listPendingWatcherSessions(f.old.userId)).some((s) => s.id === f.old.id));
    const oldState = (await f.sessions.get(f.old.id)).watcherState;
    await f.sessions.compareAndSetWatcherState(
      f.old.id,
      1,
      { ...oldState, revision: 2 },
      { ...f.operation, phase: 'idle' },
    );
    const input = {
      sessionId: f.old.id,
      expectedRevision: 2,
      expectedCliSessionId: f.old.cliSessionId,
      expectedNativeSessionBinding: undefined,
      retirementId: f.operation.id,
    };
    const [a, b] = await Promise.all([
      f.sessions.rolloverWatcherSession(input),
      f.sessions.rolloverWatcherSession(input),
    ]);
    assert.ok(a);
    assert.equal(a.id, b.id);
    assert.deepEqual(a.watcherState, { revision: 0, ...f.progress });
    assert.equal(a.cliSessionId, undefined);
    assert.equal(a.nativeSessionBinding, undefined);
    assert.equal(a.watcherRetirement, undefined);
    assert.equal((await f.sessions.getByChainKey(f.chainKey)).id, a.id);
    assert.equal((await f.sessions.getActive('codex', f.old.threadId, f.old.userId)).id, f.home.id);
    assert.equal((await f.sessions.getByCliSessionId(f.old.cliSessionId)).id, f.old.id);
    const retired = await f.sessions.get(f.old.id);
    assert.equal(retired.status, 'sealed');
    assert.equal(retired.watcherState.toolSchemaHash, f.operation.oldSchemaHash);
    assert.equal(retired.cliSessionId, f.old.cliSessionId);
    assert.equal(retired.watcherRetirement.successorSessionId, a.id);
    assert.deepEqual(await f.sessions.listPendingWatcherSessions(f.old.userId), []);
    assert.equal(
      await f.sessions.compareAndSetWatcherState(f.old.id, retired.watcherState.revision, {
        ...retired.watcherState,
        revision: retired.watcherState.revision + 1,
        notes: 'late callback',
      }),
      null,
    );
    assert.equal((await f.sessions.getChain('codex', f.old.threadId, f.old.userId)).length, 3);
  });
  for (const fence of ['revision', 'cli', 'binding', 'operation', 'pending']) {
    test(`successor publication fences ${fence} before changing any record or index`, async () => {
      const f = await seed();
      const state = (await f.sessions.get(f.old.id)).watcherState;
      if (fence !== 'pending')
        await f.sessions.compareAndSetWatcherState(
          f.old.id,
          1,
          { ...state, revision: 2 },
          { ...f.operation, phase: 'idle' },
        );
      const before = await f.sessions.get(f.old.id);
      const input = {
        sessionId: f.old.id,
        expectedRevision: fence === 'revision' ? 0 : before.watcherState.revision,
        expectedCliSessionId: fence === 'cli' ? 'wrong-native' : f.old.cliSessionId,
        expectedNativeSessionBinding: fence === 'binding' ? { v: 1 } : undefined,
        retirementId: fence === 'operation' ? 'wrong-operation' : f.operation.id,
      };
      assert.equal(await f.sessions.rolloverWatcherSession(input), null);
      assert.deepEqual(await f.sessions.get(f.old.id), before);
      assert.equal((await f.sessions.getByChainKey(f.chainKey)).id, f.old.id);
      assert.equal((await f.sessions.getChain('codex', f.old.threadId, f.old.userId)).length, 2);
    });
  }
  test('retirement CAS cannot reset probes, replace the original operation, or publish a retired marker without rollover', async () => {
    const f = await seed();
    for (const patch of [
      { probes: 0 },
      { id: 'different-wake' },
      { oldSchemaHash: 'b'.repeat(64) },
      { phase: 'retired' },
    ]) {
      const before = await f.sessions.get(f.old.id);
      await assert.rejects(async () =>
        f.sessions.compareAndSetWatcherState(
          f.old.id,
          1,
          { ...before.watcherState, revision: 2 },
          { ...f.operation, ...patch },
        ),
      );
      assert.deepEqual(await f.sessions.get(f.old.id), before);
    }
  });
}
