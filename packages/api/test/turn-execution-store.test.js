import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { InMemoryTurnExecutionStore } = await import(
  '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js'
);

function runningInput(overrides = {}) {
  return {
    invocationId: 'child-1',
    parentInvocationId: 'parent-1',
    threadId: 'thread-1',
    userId: 'user-1',
    catId: 'codex-sol',
    executionKind: 'ordinary',
    startedAt: 100,
    causal: { triggerMessageId: 'msg-1' },
    ...overrides,
  };
}

describe('InMemoryTurnExecutionStore', () => {
  test('creates one hydratable running child and lists it by parent in start order', async () => {
    const store = new InMemoryTurnExecutionStore();
    const later = runningInput({ invocationId: 'child-2', executionKind: 'routing_guard', startedAt: 200 });
    const earlier = runningInput();

    assert.equal((await store.createRunning(later)).outcome, 'created');
    assert.equal((await store.createRunning(earlier)).outcome, 'created');

    assert.deepEqual(await store.get('child-1'), {
      ...earlier,
      status: 'running',
    });
    assert.deepEqual(
      (await store.listByParent('parent-1')).map((record) => [record.invocationId, record.executionKind]),
      [
        ['child-1', 'ordinary'],
        ['child-2', 'routing_guard'],
      ],
    );
  });

  test('same immutable create replays without changing startedAt; identity drift conflicts', async () => {
    const store = new InMemoryTurnExecutionStore();
    const input = runningInput();
    const first = await store.createRunning(input);
    const replay = await store.createRunning({ ...input, causal: { triggerMessageId: 'msg-1' } });
    const conflict = await store.createRunning({ ...input, catId: 'opus' });

    assert.equal(first.outcome, 'created');
    assert.equal(replay.outcome, 'replayed');
    assert.equal(conflict.outcome, 'conflict');
    assert.deepEqual(await store.get(input.invocationId), { ...input, status: 'running' });
  });

  test('causal field insertion order does not turn an idempotent create into an identity conflict', async () => {
    const store = new InMemoryTurnExecutionStore();
    const input = runningInput({
      executionKind: 'freshness_supplement',
      causal: { triggerMessageId: 'msg-1', freshnessSupplementId: 'supplement-1' },
    });
    assert.equal((await store.createRunning(input)).outcome, 'created');
    assert.equal(
      (
        await store.createRunning({
          ...input,
          causal: { freshnessSupplementId: 'supplement-1', triggerMessageId: 'msg-1' },
        })
      ).outcome,
      'replayed',
    );
  });

  test('prompt coverage is an immutable causal set: order replays, membership drift conflicts', async () => {
    const store = new InMemoryTurnExecutionStore();
    const input = runningInput({
      causal: { triggerMessageId: 'msg-1', coveredMessageIds: ['msg-1', 'msg-context'] },
    });

    assert.equal((await store.createRunning(input)).outcome, 'created');
    assert.equal(
      (
        await store.createRunning({
          ...input,
          causal: { coveredMessageIds: ['msg-context', 'msg-1'], triggerMessageId: 'msg-1' },
        })
      ).outcome,
      'replayed',
    );
    assert.equal(
      (
        await store.createRunning({
          ...input,
          causal: { triggerMessageId: 'msg-1', coveredMessageIds: ['msg-1', 'msg-other'] },
        })
      ).outcome,
      'conflict',
    );
  });

  test('binds factory-owned prompt coverage exactly once after child admission', async () => {
    const store = new InMemoryTurnExecutionStore();
    const input = runningInput();
    await store.createRunning(input);

    assert.equal((await store.bindCoveredMessageIds('child-1', ['msg-1', 'msg-context'])).outcome, 'bound');
    assert.equal((await store.bindCoveredMessageIds('child-1', ['msg-context', 'msg-1'])).outcome, 'replayed');
    assert.equal((await store.bindCoveredMessageIds('child-1', ['msg-1', 'msg-other'])).outcome, 'conflict');
    assert.equal((await store.bindCoveredMessageIds('missing', ['msg-1'])).outcome, 'not_found');
    assert.deepEqual((await store.get('child-1')).causal, {
      triggerMessageId: 'msg-1',
      coveredMessageIds: ['msg-1', 'msg-context'],
    });
    assert.equal((await store.createRunning(input)).outcome, 'replayed');
  });

  test('success-vs-cancel race produces one immutable terminal winner', async () => {
    const store = new InMemoryTurnExecutionStore();
    await store.createRunning(runningInput());

    const [success, canceled] = await Promise.all([
      store.transitionTerminal('child-1', { status: 'succeeded', endedAt: 300 }),
      store.transitionTerminal('child-1', {
        status: 'canceled',
        endedAt: 301,
        terminalReason: 'user_cancel',
      }),
    ]);
    const outcomes = [success.outcome, canceled.outcome].sort();

    assert.deepEqual(outcomes, ['already_terminal', 'transitioned']);
    const terminal = await store.get('child-1');
    assert.ok(terminal);
    assert.notEqual(terminal.status, 'running');
    assert.equal(terminal.endedAt === 300 || terminal.endedAt === 301, true);

    const duplicate = await store.transitionTerminal('child-1', {
      status: terminal.status === 'succeeded' ? 'failed' : 'succeeded',
      endedAt: 400,
      ...(terminal.status === 'succeeded' ? { terminalReason: 'late_error' } : {}),
    });
    assert.equal(duplicate.outcome, 'already_terminal');
    assert.deepEqual(await store.get('child-1'), terminal);
  });

  test('returned records are detached snapshots and cannot mutate canonical causal truth', async () => {
    const store = new InMemoryTurnExecutionStore();
    const input = runningInput({
      causal: { triggerMessageId: 'msg-1', coveredMessageIds: ['msg-1', 'msg-context'] },
    });
    const created = await store.createRunning(input);
    created.record.causal.triggerMessageId = 'tampered';
    created.record.causal.coveredMessageIds.push('tampered-array');
    input.causal.triggerMessageId = 'tampered-input';
    input.causal.coveredMessageIds.push('tampered-input-array');

    const reread = await store.get('child-1');
    assert.equal(reread.causal.triggerMessageId, 'msg-1');
    assert.deepEqual(reread.causal.coveredMessageIds, ['msg-1', 'msg-context']);
  });

  test('interruptRunningBefore transitions only pre-cutoff running records', async () => {
    const store = new InMemoryTurnExecutionStore();
    await store.createRunning(runningInput({ invocationId: 'old', startedAt: 99 }));
    await store.createRunning(runningInput({ invocationId: 'boundary', startedAt: 100 }));
    await store.createRunning(runningInput({ invocationId: 'new', startedAt: 101 }));
    await store.transitionTerminal('old', { status: 'succeeded', endedAt: 110 });

    const interrupted = await store.interruptRunningBefore(101, {
      endedAt: 200,
      terminalReason: 'process_restart',
    });

    assert.deepEqual(
      interrupted.map((record) => record.invocationId),
      ['boundary'],
    );
    assert.equal((await store.get('old')).status, 'succeeded');
    assert.equal((await store.get('boundary')).status, 'interrupted');
    assert.equal((await store.get('new')).status, 'running');
  });

  test('rejects invalid non-success terminal records and missing children', async () => {
    const store = new InMemoryTurnExecutionStore();
    await store.createRunning(runningInput());

    assert.throws(() => store.transitionTerminal('child-1', { status: 'failed', endedAt: 200 }), /terminalReason/);
    assert.throws(() => store.transitionTerminal('child-1', { status: 'succeeded', endedAt: 99 }), /endedAt/);
    assert.equal(store.transitionTerminal('missing', { status: 'succeeded', endedAt: 200 }).outcome, 'not_found');
  });

  test('F297 P1-2: listRunningByUser scopes to the owner and excludes terminal children', async () => {
    const store = new InMemoryTurnExecutionStore();
    await store.createRunning(runningInput({ invocationId: 'mine-1', userId: 'alice', startedAt: 100 }));
    await store.createRunning(
      runningInput({ invocationId: 'mine-2', userId: 'alice', threadId: 'thread-2', startedAt: 200 }),
    );
    await store.createRunning(runningInput({ invocationId: 'theirs', userId: 'bob', startedAt: 150 }));
    await store.createRunning(runningInput({ invocationId: 'mine-done', userId: 'alice', startedAt: 50 }));
    await store.transitionTerminal('mine-done', { status: 'succeeded', endedAt: 300 });

    const running = await store.listRunningByUser('alice');
    assert.deepEqual(
      running.map((record) => record.invocationId),
      ['mine-1', 'mine-2'],
      'user scoping is the store\u2019s own responsibility, not a caller-side re-filter',
    );
    assert.deepEqual(await store.listRunningByUser('carol'), []);
  });

  test('F297 P1-2: listRunningByUser reaches a child whose parent was never a running record', async () => {
    const store = new InMemoryTurnExecutionStore();
    await store.createRunning(runningInput({ invocationId: 'orphan', parentInvocationId: 'parent-absent' }));

    assert.deepEqual(await store.listByParent('parent-absent'), await store.listByParent('parent-absent'));
    const running = await store.listRunningByUser('user-1');
    assert.deepEqual(
      running.map((record) => record.invocationId),
      ['orphan'],
      'the enumerator must not depend on parent-side reachability',
    );
  });
});
