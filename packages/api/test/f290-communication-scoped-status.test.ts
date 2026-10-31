import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId, type InvocationTrajectorySummary } from '@cat-cafe/shared';
import { resolveScopedSessionTrajectory } from '../src/domains/cats/services/session/scoped-session-trajectory.js';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { SessionChainStore } from '../src/domains/cats/services/stores/ports/SessionChainStore.js';

function fixture() {
  const catId = createCatId('codex-sol');
  const session = new SessionChainStore().create({
    catId,
    userId: 'owner',
    threadId: 'scoped',
    scopedInvocation: { executionScope: 'collective-participation', invocationId: 'child', originMessageId: 'origin' },
  });
  const summary: InvocationTrajectorySummary = {
    invocationId: 'child',
    threadId: 'scoped',
    sessionId: session.id,
    sessionSeq: 0,
    sessionStatus: 'sealed',
    catId,
    status: 'done',
    startedAt: 10,
    endedAt: 20,
    durationMs: 10,
    eventCount: 1,
    statusEventCount: 0,
    toolUseCount: 0,
    toolResultCount: 0,
    messageCount: 0,
    errorCount: 0,
    toolNames: [],
    keyMessages: [],
  };
  const executions = new InMemoryTurnExecutionStore();
  executions.createRunning({
    invocationId: 'child',
    parentInvocationId: 'parent',
    threadId: 'scoped',
    userId: 'owner',
    catId,
    executionKind: 'ordinary',
    startedAt: 10,
  });
  return { session, summary, executions };
}

test('scoped provider done stays running until the real child settles', async () => {
  const f = fixture();
  const result = await resolveScopedSessionTrajectory(f.summary, f.session, f.executions);
  assert.equal(result.status, 'running');
  assert.equal(result.endedAt, undefined);
  f.executions.transitionTerminal('child', { status: 'failed', endedAt: 30, terminalReason: 'archive_failure' });
  assert.equal((await resolveScopedSessionTrajectory(f.summary, f.session, f.executions)).status, 'error');
});
test('unproved or mismatched scoped child identity fails closed', async () => {
  const f = fixture();
  assert.equal((await resolveScopedSessionTrajectory(f.summary, f.session)).status, 'error');
  const real = f.executions.get('child')!;
  for (const patch of [{ userId: 'foreign' }, { threadId: 'foreign' }, { catId: createCatId('opus') }]) {
    assert.equal(
      (await resolveScopedSessionTrajectory(f.summary, f.session, { get: () => ({ ...real, ...patch }) })).status,
      'error',
    );
  }
});
test('ordinary session trajectory is unchanged and does not consult scoped execution evidence', async () => {
  const f = fixture();
  assert.equal(
    await resolveScopedSessionTrajectory(
      f.summary,
      { ...f.session, scopedInvocation: undefined },
      {
        get: () => {
          throw new Error('ordinary session must keep its existing projection');
        },
      },
    ),
    f.summary,
  );
});
