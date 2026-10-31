import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindAppendRun, harness, waitFor } from './helpers/issue1371-queue-harness.js';

for (const strategy of ['guide_reply', 'interrupt_reply']) {
  test(`old Console follow-up after ${strategy} cannot deliver or interrupt twice`, async (t) => {
    const h = await harness({ guide: strategy === 'guide_reply' });
    t.after(() => h.app.close());
    h.releaseCreate();
    let nativeCalls = 0;
    if (strategy === 'guide_reply') {
      const run = bindAppendRun(h, 'opus');
      h.tracker.bindAgentClientActiveRunDispatcher('thread-1', 'opus', {
        invocationId: run.invocationId,
        capabilities: { append: true, steer: true },
        handle: { provider: 'openai_codex', carrier: 'codex_app_server' },
        dispatch: async () => {
          nativeCalls++;
          return { accepted: true, handle: {} };
        },
      });
    }
    const first = await h.app.inject({
      method: 'POST',
      url: `/api/threads/thread-1/queue/${h.entry.id}/targets`,
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: {
        sourceRecordId: h.source.id,
        observedPendingTargetIds: ['opus', 'codex'],
        targets: [{ targetCatId: 'opus', strategy, membershipAtOpen: 'member' }],
      },
    });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(h.queue.list('thread-1', 'user-1').length, 0);
    const after = JSON.stringify(h.store.getById(h.source.id).lifecycle);
    const duplicate = await h.app.inject({
      method: 'POST',
      url: `/api/threads/thread-1/queue/${h.entry.id}/${strategy === 'guide_reply' ? 'continue' : 'steer'}`,
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { targetCatId: 'opus' },
    });
    assert.equal(duplicate.statusCode, 404, duplicate.body);
    assert.equal(duplicate.json().code, 'ENTRY_NOT_FOUND');
    assert.equal(JSON.stringify(h.store.getById(h.source.id).lifecycle), after);
    assert.equal(nativeCalls, strategy === 'guide_reply' ? 1 : 0);
    assert.equal(h.queue.list('thread-1', 'user-1').length, 0);
  });
}

test('one Steer request interrupts two busy targets through real Queue handoff and replays without new runs', async (t) => {
  const h = await harness();
  t.after(() => h.app.close());
  const opus = h.tracker.start('thread-1', 'opus', 'user-1', ['opus'], 'old-opus');
  const codex = h.tracker.start('thread-1', 'codex', 'user-1', ['codex'], 'old-codex');
  h.releaseCreate();
  const input = {
    method: 'POST',
    url: `/api/threads/thread-1/queue/${h.entry.id}/targets`,
    headers: { 'x-cat-cafe-user': 'user-1' },
    payload: {
      sourceRecordId: h.source.id,
      observedPendingTargetIds: ['opus', 'codex'],
      targets: [
        { targetCatId: 'opus', strategy: 'interrupt_reply', membershipAtOpen: 'member' },
        { targetCatId: 'codex', strategy: 'interrupt_reply', membershipAtOpen: 'member' },
      ],
    },
  };
  const res = await h.app.inject(input);
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(
    res.json().targets.map((target) => [target.targetCatId, target.status, target.result.started]),
    [
      ['opus', 200, true],
      ['codex', 200, true],
    ],
  );
  assert.equal(opus.signal.aborted, true);
  assert.equal(codex.signal.aborted, true);
  assert.equal(h.queue.list('thread-1', 'user-1').length, 0);
  assert.deepEqual(
    h.store
      .getById(h.source.id)
      .lifecycle.dispatchRefs.map((ref) => ref.targetId)
      .sort(),
    ['codex', 'opus'],
  );
  const before = h.records.create.mock.callCount();
  const replay = await h.app.inject(input);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(replay.json().targets, []);
  assert.deepEqual(replay.json().skippedAlreadyDispatched, ['opus', 'codex']);
  assert.equal(h.records.create.mock.callCount(), before);
});

test('#1371: explicit Steer consumes one target and preserves the busy sibling', async (t) => {
  const h = await harness();
  t.after(() => h.app.close());
  const busy = h.tracker.start('thread-1', 'opus', 'user-1', ['opus'], 'independent-work');

  const claimed = await h.queue.claimExactSteerEntryDurable('thread-1', 'user-1', h.entry.id, 'codex');
  assert.equal(claimed.outcome, 'claimed');
  const started = h.processor.processClaimedSteerEntries(
    'thread-1',
    'user-1',
    claimed.entries.map((entry) => entry.id),
    'codex',
  );
  await waitFor(() => h.records.create.mock.calls.length === 1);
  h.releaseCreate();
  assert.equal((await started).started, true);
  await waitFor(
    () => h.store.getById(h.source.id).lifecycle?.dispatchRefs?.some((ref) => ref.targetId === 'codex') === true,
  );
  assert.equal(busy.signal.aborted, false);
  assert.deepEqual(
    h.routeExecution.mock.calls.map((call) => call.arguments[4]),
    [['codex']],
  );
  assert.deepEqual(h.queue.getEntrySnapshot('thread-1', 'user-1', h.entry.id).targets, ['opus']);

  h.tracker.completeAll('thread-1', ['opus'], busy);
  await h.processor.processNext('thread-1', 'user-1');
  await waitFor(() => h.queue.list('thread-1', 'user-1').length === 0);
  assert.deepEqual(
    h.routeExecution.mock.calls.map((call) => call.arguments[4]),
    [['codex'], ['opus']],
  );
});

for (const entryPoint of ['manual', 'automatic']) {
  test(`#1371: ${entryPoint} drain keeps the exact target set queued while one sibling is busy`, async (t) => {
    const h = await harness();
    t.after(() => h.app.close());
    const busy = h.tracker.start('thread-1', 'opus', 'user-1', ['opus'], 'independent-work');

    if (entryPoint === 'manual') {
      await h.processor.processNext('thread-1', 'user-1');
    } else {
      await h.processor.requestDrain('thread-1');
    }

    assert.equal(h.records.create.mock.calls.length, 0);
    assert.equal(h.routeExecution.mock.calls.length, 0);
    assert.deepEqual(h.queue.getEntrySnapshot('thread-1', 'user-1', h.entry.id).targets, ['opus', 'codex']);

    h.tracker.completeAll('thread-1', ['opus'], busy);
    await h.processor.processNext('thread-1', 'user-1');
    await waitFor(() => h.records.create.mock.calls.length === 1);
    h.releaseCreate();
    await waitFor(() => h.queue.list('thread-1', 'user-1').length === 0);
    assert.deepEqual(
      h.routeExecution.mock.calls.map((call) => call.arguments[4]),
      [['opus', 'codex']],
    );
    assert.deepEqual(
      h.store
        .getById(h.source.id)
        .lifecycle.dispatchRefs.map((ref) => [ref.targetId, ref.phase])
        .sort(),
      [
        ['codex', 'settled'],
        ['opus', 'settled'],
      ],
    );
  });
}

test('#1371: a sibling becoming busy during ordinary preflight requeues without losing or failing custody', async (t) => {
  const h = await harness();
  t.after(() => h.app.close());
  await h.processor.processNext('thread-1', 'user-1');
  await waitFor(() => h.records.create.mock.calls.length === 1);

  const busy = h.tracker.start('thread-1', 'codex', 'user-1', ['codex'], 'independent-work');
  h.releaseCreate();
  await waitFor(() => h.queue.getEntrySnapshot('thread-1', 'user-1', h.entry.id)?.status === 'queued');

  const remaining = h.queue.getEntrySnapshot('thread-1', 'user-1', h.entry.id);
  assert.equal(remaining.status, 'queued');
  assert.deepEqual(remaining.queuedFailedByCatIds ?? [], []);
  assert.deepEqual(remaining.targets, ['opus', 'codex']);
  assert.deepEqual(h.store.getById(h.source.id).lifecycle?.dispatchRefs ?? [], []);
  assert.equal(h.routeExecution.mock.calls.length, 0);
  assert.equal(busy.signal.aborted, false);
  assert.equal((await h.records.get('inv-1')).status, 'canceled');
  assert.equal((await h.records.get('inv-1')).error, 'queue_target_became_busy');

  h.tracker.completeAll('thread-1', ['codex'], busy);
  await h.processor.processNext('thread-1', 'user-1');
  await waitFor(() => h.queue.list('thread-1', 'user-1').length === 0);
  assert.deepEqual(
    h.routeExecution.mock.calls.map((call) => call.arguments[4]),
    [['opus', 'codex']],
  );
});

test('#1371: force-reset retires a recordless pre-start target without running the provider', async (t) => {
  const h = await harness();
  t.after(() => h.app.close());
  await h.processor.processNext('thread-1', 'user-1');
  await waitFor(() => h.records.create.mock.calls.length === 1);

  const reset = await h.app.inject({
    method: 'POST',
    url: '/api/threads/thread-1/force-reset',
    headers: { 'x-cat-cafe-user': 'user-1' },
  });
  h.releaseCreate();
  assert.equal(reset.statusCode, 200, reset.body);
  assert.equal(h.routeExecution.mock.calls.length, 0);
  assert.deepEqual(h.queue.list('thread-1', 'user-1'), []);
  assert.equal(h.store.getById(h.source.id).deliveryStatus, 'canceled');
  assert.deepEqual(h.store.getById(h.source.id).lifecycle.dispatchRefs, []);
});

test('#1371: pre-start terminal write failure is visible and the exact retry succeeds', async (t) => {
  const h = await harness();
  t.after(() => h.app.close());
  await h.processor.processNext('thread-1', 'user-1');
  await waitFor(() => h.records.create.mock.calls.length === 1);
  const removeProcessed = h.queue.removeProcessedAcrossUsersDurable.bind(h.queue);
  h.queue.removeProcessedAcrossUsersDurable = async () => null;
  const request = {
    method: 'POST',
    url: '/api/threads/thread-1/force-reset',
    headers: { 'x-cat-cafe-user': 'user-1' },
  };
  const failed = await h.app.inject(request);
  assert.equal(failed.statusCode, 503, failed.body);
  h.queue.removeProcessedAcrossUsersDurable = removeProcessed;
  const retried = await h.app.inject(request);
  h.releaseCreate();
  assert.equal(retried.statusCode, 200, retried.body);
  assert.equal(h.routeExecution.mock.calls.length, 0);
  assert.deepEqual(h.queue.list('thread-1', 'user-1'), []);
});

test('#1371: live pre-start recovery never acquires another user live target', async (t) => {
  const h = await harness();
  t.after(() => h.app.close());
  await h.processor.processNext('thread-1', 'user-1');
  await waitFor(() => h.records.create.mock.calls.length === 1);
  const foreign = h.tracker.start('thread-1', 'codex', 'other-user', ['codex'], 'foreign-work');

  const reset = await h.app.inject({
    method: 'POST',
    url: '/api/threads/thread-1/force-reset',
    headers: { 'x-cat-cafe-user': 'user-1' },
  });

  assert.equal(reset.statusCode, 409, reset.body);
  assert.equal(foreign.signal.aborted, false);
  assert.equal(h.tracker.getUserId('thread-1', 'codex'), 'other-user');
  assert.equal(h.store.getById(h.source.id).deliveryStatus, 'queued');
  assert.equal(h.queue.getEntrySnapshot('thread-1', 'user-1', h.entry.id).status, 'claimed');

  h.releaseCreate();
  await waitFor(() => h.queue.getEntrySnapshot('thread-1', 'user-1', h.entry.id)?.status === 'queued');
});
