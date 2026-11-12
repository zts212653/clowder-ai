import assert from 'node:assert/strict';
import { test } from 'node:test';
import { realDeps, realPresenceSource, startRunningRecord } from './helpers/f297-presence-fixtures.js';

async function fixture(ownerSnapshot) {
  const deps = await realDeps();
  const threadId = 'restarted-provider';
  const userId = 'alice';
  const catId = 'opus55';
  const old = await startRunningRecord(deps, { threadId, userId, catId });
  await deps.recordStore.update(old, { status: 'succeeded', successfulCatIds: [catId] });
  const parent = await startRunningRecord(deps, { threadId, userId, catId });
  const child = {
    invocationId: 'orphan-child',
    parentInvocationId: parent,
    threadId,
    userId,
    catId,
    executionKind: 'ordinary',
    startedAt: 1000,
    providerLifecycleTracked: true,
  };
  await deps.turnExecutionStore.createRunning(child);
  await deps.turnExecutionStore.markProviderStarted(child.invocationId, 1100);
  let ownerReads = 0;
  const view = await realPresenceSource(deps, {
    serviceDeps: {
      cliExecutionOwnerService: {
        listLive: async () => {
          ownerReads++;
          return typeof ownerSnapshot === 'function' ? ownerSnapshot(child) : ownerSnapshot;
        },
      },
    },
  });
  return { deps, ...view, child, parent, threadId, userId, catId, ownerReads: () => ownerReads };
}

for (const complete of [true, false])
  test(`a durable running child with ${complete ? 'complete empty' : 'unknown'} process evidence is never Working or old Done`, async () => {
    const h = await fixture({ complete, owners: [] });
    const presence = (await h.source.getPresence([h.threadId], h.userId)).get(h.threadId);
    assert.equal(presence?.status, 'idle', 'unknown execution stays neutral, never Working or prior terminal fallback');
    assert.equal(h.ownerReads(), 1, 'the user-scoped process snapshot is captured once per presence request');
    assert.equal((await h.service.resolveWorkingPresence(h.threadId, h.userId)).complete, false);
    const child = await h.deps.turnExecutionStore.get(h.child.invocationId);
    assert.equal(child.status, 'running');
    assert.equal(child.outputFence, 'open');
    assert.equal(child.providerTeardownAt, undefined, 'reading a presentation never manufactures stop proof');
    if (complete) assert.deepEqual(await h.service.resolveActiveInvocations(h.threadId, h.userId), []);
  });

test('a verified external CLI owner remains Working without a local tracker, using the same owner snapshot', async () => {
  const h = await fixture((child) => ({
    complete: true,
    owners: [{ ...child, executionId: child.parentInvocationId, startedAt: 2000 }],
  }));
  const presence = (await h.source.getPresence([h.threadId], h.userId)).get(h.threadId);
  assert.equal(presence?.status, 'working');
  assert.deepEqual(presence.cats, [h.catId]);
  assert.equal(
    presence.activeSince,
    2000,
    'an unverified earlier ledger timestamp must not inflate the live owner timer',
  );
  assert.equal(h.ownerReads(), 1);
  assert.equal((await h.service.resolveWorkingPresence(h.threadId, h.userId)).complete, true);
});

test('a current tracker with complete process evidence reports complete working truth to control consumers', async () => {
  const h = await fixture({ complete: true, owners: [] });
  h.deps.invocationTracker.start(h.threadId, h.catId, h.userId, [h.catId], h.parent);
  const working = await h.service.resolveWorkingPresence(h.threadId, h.userId);
  assert.deepEqual(working.catIds, [h.catId]);
  assert.equal(working.complete, true, 'seal consumers must distinguish verified work from unavailable evidence');
});

test('a live member never certifies another member with an unresolved old child on the same thread', async () => {
  const h = await fixture({ complete: true, owners: [] });
  h.deps.invocationTracker.start(h.threadId, h.catId, h.userId, [h.catId], h.parent);
  const siblingParent = await startRunningRecord(h.deps, {
    threadId: h.threadId,
    userId: h.userId,
    catId: 'codex',
  });
  await h.deps.turnExecutionStore.createRunning({
    ...h.child,
    invocationId: 'unverified-sibling',
    parentInvocationId: siblingParent,
    catId: 'codex',
  });
  const working = await h.service.resolveWorkingPresence(h.threadId, h.userId);
  assert.deepEqual(working.catIds, [h.catId]);
  assert.equal(working.complete, false, 'thread-level controls remain conservative for the unresolved sibling');
});

test('a current exact tracker remains Working even when external process evidence is unavailable', async () => {
  const h = await fixture(() => {
    throw new Error('unavailable process table');
  });
  h.deps.invocationTracker.start(h.threadId, h.catId, h.userId, [h.catId], h.parent);
  const presence = (await h.source.getPresence([h.threadId], h.userId)).get(h.threadId);
  assert.equal(presence?.status, 'working');
  assert.deepEqual(presence.cats, [h.catId]);
});
