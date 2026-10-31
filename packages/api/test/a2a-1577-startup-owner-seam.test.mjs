import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { StartupReconciler } from '../src/domains/cats/services/agents/invocation/StartupReconciler.ts';
import { TurnExecutionStartupReconciler } from '../src/domains/cats/services/agents/invocation/TurnExecutionStartupReconciler.ts';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.ts';
import { InvocationRecordStore } from '../src/domains/cats/services/stores/ports/InvocationRecordStore.ts';

test('C7 startup has one canonical pending ledger and cannot reconstruct old Message-custody work', () => {
  const root = new URL('../src/', import.meta.url);
  for (const name of [
    'QueuedMessageCustodyStartupReconciler',
    'QueuedMessageCustodyStartupMessageReconciler',
    'QueuedMessageCustodyStartupQueueEntry',
    'QueuedMessageCustodyStartupTypes',
    'QueuedMessageCustodyRestartTargets',
    'QueuedMessageCustodyRestartWitness',
    'queue-source-completion-policy',
  ]) {
    assert.equal(
      existsSync(new URL(`domains/cats/services/agents/invocation/${name}.ts`, root)),
      false,
      `retired recovery owner/support: ${name}`,
    );
  }
  const index = readFileSync(new URL('index.ts', root), 'utf8');
  assert.equal(index.includes('QueuedMessageCustodyStartupReconciler'), false);
  const hydrate = index.indexOf('await invocationQueue.hydrateFromLedger(messageStore)');
  const listen = index.indexOf('address = await listenBeforeTurnExecutionRecovery');
  const child = index.indexOf('new TurnExecutionStartupReconciler');
  const parent = index.indexOf('await reconciler.reconcileOrphans()');
  assert.ok(hydrate >= 0 && hydrate < listen && listen < child && child < parent);
});

function fixture(t, status = 'running', targets = ['opus']) {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const records = new InvocationRecordStore();
  const { invocationId } = records.create({
    threadId: 'owned-thread',
    userId: 'owned-user',
    targetCats: targets,
    intent: 'execute',
    idempotencyKey: 'owned-startup',
    actionLeaseCarrier: { kind: 'none' },
  });
  if (status === 'running') records.update(invocationId, { status: 'running', expectedStatus: 'queued' });
  records.scanByStatus = async (wanted) => (records.get(invocationId)?.status === wanted ? [invocationId] : []);
  const turns = new InMemoryTurnExecutionStore();
  const actions = { cleared: 0, notices: 0, warnings: [] };
  const child = (catId = 'opus', overrides = {}) =>
    turns.createRunning({
      invocationId: `child-${catId}`,
      parentInvocationId: invocationId,
      threadId: 'owned-thread',
      userId: 'owned-user',
      catId,
      executionKind: 'ordinary',
      startedAt: 1100,
      ...overrides,
    }).record;
  now = 1000000;
  const run = (turnExecutionStore = turns) =>
    new StartupReconciler({
      invocationRecordStore: records,
      turnExecutionStore,
      processStartAt: 2000,
      taskProgressStore: {
        async deleteSnapshot() {
          actions.cleared++;
        },
      },
      messageStore: {
        async append() {
          actions.notices++;
        },
      },
      log: {
        info() {},
        warn(value) {
          actions.warnings.push(value);
        },
      },
    }).reconcileOrphans();
  return { records, turns, actions, child, run, invocationId };
}

for (const status of ['running', 'queued']) {
  test(`old ${status} parent stays live while its exact surviving child is running`, async (t) => {
    const f = fixture(t, status);
    const child = f.child();
    const before = structuredClone(f.records.get(f.invocationId));
    const result = await f.run();
    assert.equal(result.swept, 0);
    assert.deepEqual(f.records.get(f.invocationId), before);
    assert.deepEqual(f.turns.get(child.invocationId), child);
    assert.equal(f.actions.cleared, 0);
    assert.equal(f.actions.notices, 0);
  });
  test(`unavailable child truth does not mark an old ${status} parent interrupted`, async (t) => {
    const f = fixture(t, status);
    const before = structuredClone(f.records.get(f.invocationId));
    const result = await f.run({
      async listByParent() {
        throw new Error('child ledger unavailable');
      },
    });
    assert.equal(result.swept, 0);
    assert.deepEqual(f.records.get(f.invocationId), before);
    assert.equal(f.actions.cleared, 0);
    assert.equal(f.actions.notices, 0);
    assert.match(f.actions.warnings.join('\n'), /child ledger unavailable/);
  });
}

test('one ended sibling cannot authorize interruption or progress deletion for a live sibling', async (t) => {
  const f = fixture(t, 'running', ['opus', 'codex']);
  f.child('opus');
  f.child('codex');
  f.turns.transitionTerminal('child-codex', { status: 'failed', endedAt: 1200, terminalReason: 'fixture_failure' });
  assert.equal((await f.run()).swept, 0);
  assert.equal(f.records.get(f.invocationId).status, 'running');
  assert.equal(f.actions.cleared, 0);
});

test('post-listen child recovery and parent recovery preserve the same exact detached owner', async (t) => {
  const f = fixture(t, 'running', ['opus', 'codex']);
  f.child('opus');
  f.child('codex');
  const recovery = new TurnExecutionStartupReconciler({ store: f.turns, now: () => 1000000 });
  const pass = await recovery.reconcile({ processStartedAt: 2000, protectedInvocationIds: ['child-opus'] });
  assert.deepEqual(pass.invocationIds, ['child-codex']);
  assert.equal(f.turns.get('child-codex').status, 'interrupted');
  assert.equal(f.turns.get('child-opus').status, 'running');
  assert.equal((await f.run()).swept, 0);
  assert.equal(f.records.get(f.invocationId).status, 'running');
  assert.equal(f.actions.cleared, 0);
  assert.equal(f.actions.notices, 0);
  assert.equal((await f.run()).swept, 0, 'repeat recovery does not interrupt the protected owner');
});

for (const mismatch of [
  { parentInvocationId: 'other-parent' },
  { threadId: 'other-thread' },
  { userId: 'other-user' },
  { catId: 'other-target' },
]) {
  test(`inconsistent child snapshot preserves uncertainty: ${JSON.stringify(mismatch)}`, async (t) => {
    const f = fixture(t);
    const child = f.child();
    const before = structuredClone(f.records.get(f.invocationId));
    assert.equal(
      (
        await f.run({
          async listByParent() {
            return [{ ...child, ...mismatch }];
          },
        })
      ).swept,
      0,
    );
    assert.deepEqual(f.records.get(f.invocationId), before);
    assert.equal(f.actions.cleared, 0);
    assert.match(f.actions.warnings.join('\n'), /child.*identity/i);
  });
}

test('confirmed empty child ledger settles the orphan projection without adding a second chat result', async (t) => {
  const f = fixture(t);
  assert.equal((await f.run()).running, 1);
  assert.equal(f.records.get(f.invocationId).status, 'failed');
  assert.equal(f.records.get(f.invocationId).error, 'process_restart');
  assert.equal(f.actions.cleared, 1);
  assert.equal(f.actions.notices, 0);
});

test('unknown child lifecycle cannot authorize parent interruption', async (t) => {
  const f = fixture(t);
  const child = f.child();
  const before = structuredClone(f.records.get(f.invocationId));
  assert.equal(
    (
      await f.run({
        async listByParent() {
          return [{ ...child, status: 'unknown' }];
        },
      })
    ).swept,
    0,
  );
  assert.deepEqual(f.records.get(f.invocationId), before);
  assert.equal(f.actions.cleared, 0);
  assert.equal(f.actions.notices, 0);
  assert.match(f.actions.warnings.join('\n'), /unknown child lifecycle/i);
});

test('all exact children already ended allows parent sweep without changing child terminal evidence', async (t) => {
  const f = fixture(t);
  f.child();
  f.turns.transitionTerminal('child-opus', { status: 'failed', endedAt: 1200, terminalReason: 'fixture_failure' });
  const terminal = structuredClone(f.turns.get('child-opus'));
  assert.equal((await f.run()).running, 1);
  assert.deepEqual(f.turns.get('child-opus'), terminal);
  assert.equal(f.records.get(f.invocationId).status, 'failed');
  assert.equal(f.records.get(f.invocationId).successfulCatIds, undefined);
});
