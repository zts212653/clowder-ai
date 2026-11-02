import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stopFixture, waitFor } from './helpers/stop-private-fixture.js';

test('retiring one private target settles its hook and preserves sibling delivery and admission identity', async (t) => {
  const h = await stopFixture(t, { idle: true });
  const input = h.privateInput('shared', { targetCats: ['opus', 'codex'] });
  const { entry } = await h.queue.enqueueDurable(input);
  const completed = [];
  for (const catId of ['opus', 'codex'])
    h.processor.registerEntryCompleteHook(entry.id, (_id, status) => completed.push([catId, status]), catId);
  await h.processor.retirePendingPrivateInputs('thread', 'owner', 'opus');
  assert.deepEqual((await h.queue.getDurableEntry('thread', entry.id)).targets, ['codex']);
  assert.deepEqual(completed, [['opus', 'canceled_by_user']]);
  assert.equal((await h.queue.enqueueDurable(input)).deduped, true);
  await assert.rejects(() => h.queue.enqueueDurable({ ...input, content: 'changed' }), /identity conflict/i);
  assert.deepEqual((await h.queue.getDurableEntry('thread', entry.id)).targets, ['codex']);
  await h.processor.requestDrain('thread');
  await waitFor(() => completed.length === 2);
  assert.deepEqual(completed[1], ['codex', 'succeeded']);
  assert.deepEqual(h.starts, ['shared']);
});

test('Steer is a replacement, not a user Stop of pending internal work', async (t) => {
  const h = await stopFixture(t);
  await h.queue.enqueueDurable(h.privateInput('pending-after-steer'));
  h.tracker.cancel('thread', 'opus', 'owner', 'steer');
  await waitFor(() => !h.processor.hasProcessingSlotReservation('thread', 'opus'));
  assert.deepEqual(h.starts, ['active', 'pending-after-steer']);
});

test('Stop retires a pending recipient even while another member owns the shared input claim', async (t) => {
  const h = await stopFixture(t);
  const { entry } = await h.queue.enqueueDurable(h.privateInput('shared-claimed', { targetCats: ['opus', 'codex'] }));
  const claimed = await h.queue.markProcessingByIdDurable('thread', entry.id, 'codex');
  assert.ok(claimed);
  assert.equal((await h.stop()).statusCode, 200);
  await waitFor(() => !h.processor.hasProcessingSlotReservation('thread', 'opus'));
  const remaining = await h.queue.getDurableEntry('thread', entry.id);
  assert.deepEqual(remaining.targets, ['codex']);
  assert.equal(remaining.status, 'claimed');
  assert.equal(remaining.claimId, claimed.claimId);
  assert.deepEqual(remaining.claimedTargetIds, ['codex']);
  assert.deepEqual(h.starts, ['active']);
  assert.equal(await h.queue.commitClaimedProcessing('thread', [entry.id]), true);
});

test('stopping a secondary member retires its backlog while the primary continues its live response', async (t) => {
  const h = await stopFixture(t, { activeTargets: ['opus', 'codex'] });
  const { entry } = await h.queue.enqueueDurable(h.privateInput('stopped-secondary', { targetCats: ['codex'] }));
  assert.equal((await h.stop(false, 'codex')).statusCode, 200);
  await h.processor.requestDrain('thread');
  await waitFor(async () => !(await h.queue.getDurableEntry('thread', entry.id)));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.starts, ['active'], 'the still-running primary must not postpone secondary Stop retirement');
  assert.equal(h.tracker.has('thread', 'opus'), true);
  await h.queue.enqueueDurable(h.privateInput('fresh-secondary', { targetCats: ['codex'] }));
  await h.processor.requestDrain('thread');
  await waitFor(() => h.starts.includes('fresh-secondary'));
  h.finishMember('opus');
  await waitFor(() => !h.processor.hasProcessingSlotReservation('thread', 'opus'));
  assert.deepEqual(h.starts, ['active', 'fresh-secondary']);
});

test('a retirement write failure still cleans up the active execution and prevents immediate hidden drain', async (t) => {
  const h = await stopFixture(t);
  const { entry } = await h.queue.enqueueDurable(h.privateInput('write-fails'));
  const reconcile = h.ledger.reconcileTargets.bind(h.ledger);
  h.ledger.reconcileTargets = async (...args) => {
    if (args[1] === entry.id) throw new Error('retirement write unavailable');
    return reconcile(...args);
  };
  assert.equal((await h.stop()).statusCode, 200);
  await waitFor(() => !h.processor.hasProcessingSlotReservation('thread', 'opus'));
  assert.equal(h.tracker.has('thread', 'opus'), false, 'retirement must not skip terminal tracker cleanup');
  assert.deepEqual(h.starts, ['active'], 'a failed withdrawal cannot silently start the stopped work');
  assert.equal((await h.queue.getDurableEntry('thread', entry.id)).status, 'queued');
  assert.ok(h.events.some((event) => event.type === 'error' && event.code === 'PRIVATE_STOP_RETIREMENT_FAILED'));
});

for (const mode of ['process', 'reconcile', 'control-failure', 'legacy-orphan', 'legacy-lock', 'force-reset'])
  test(`${mode} Stop retires the same hidden backlog without a live tracker`, async (t) => {
    const processOwner = {
      executionId: 'parent',
      invocationId: 'child',
      threadId: 'thread',
      catId: 'opus',
      userId: 'owner',
      startedAt: Date.now(),
    };
    const h = await stopFixture(t, {
      idle: true,
      routes: {
        cliExecutionOwnerService: {
          listLive: async () => ({
            owners: mode === 'process' ? [processOwner] : [],
            complete: mode !== 'control-failure',
          }),
          terminateExact: async () => ({ matched: 1, signaled: 1, complete: true }),
        },
        ...(mode === 'legacy-lock'
          ? {
              agentSessionMutex: {
                forceReleaseByScope: () => ({ releasedHolders: 1, rejectedWaiters: 0, catIds: ['opus'] }),
              },
            }
          : {}),
      },
    });
    const { entry } = await h.queue.enqueueDurable(h.privateInput('old-notice'));
    if (mode === 'legacy-orphan') {
      h.records.listRunningByThread = async () => [{ id: 'parent', userId: 'owner', targetCats: ['opus'] }];
    }
    const response = await h.app.inject({
      method: 'POST',
      url:
        mode === 'force-reset'
          ? '/api/threads/thread/force-reset'
          : mode.startsWith('legacy-')
            ? '/api/threads/thread/cancel/opus'
            : '/api/threads/thread/executions/live/parent/cancel',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: { catId: 'opus' },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(await h.queue.getDurableEntry('thread', entry.id), null);
    await h.processor.requestDrain('thread');
    assert.deepEqual(h.starts, []);
  });
