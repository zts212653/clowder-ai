import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindAppendRun, harness, waitFor } from './helpers/issue1371-queue-harness.js';

function receipt(h, catId) {
  return h.store.getById(h.source.id).lifecycle.dispatchRefs.find((ref) => ref.targetId === catId);
}

function assertOriginalSource(h) {
  const sources = h.store.getByThread('thread-1', 20, undefined, { includeQueuedUserMessages: true });
  assert.deepEqual(
    sources.filter((message) => message.from?.kind === 'user').map((message) => message.id),
    [h.source.id],
    'recovery must reuse the original input rather than copy its body into another source',
  );
}

// The fixture pauses a real native boundary while the sibling uses the same HTTP
// request and Queue. Only explicit non-acceptance may schedule the original input again.
for (const firstResult of ['accepted', 'rejected', 'unconfirmed', 'throws']) {
  test(`one guide request preserves the original Queue owner across a delayed ${firstResult} ACK`, async (t) => {
    const h = await harness({ guide: true });
    h.releaseCreate();
    const runs = { opus: bindAppendRun(h, 'opus'), codex: bindAppendRun(h, 'codex') };
    let releaseAck;
    const ackGate = new Promise((resolve) => {
      releaseAck = resolve;
    });
    t.after(async () => {
      releaseAck();
      for (const catId of ['opus', 'codex']) h.tracker.completeAll('thread-1', [catId], runs[catId].controller);
      await h.app.close();
    });
    const calls = [];
    for (const catId of ['opus', 'codex']) {
      assert.ok(
        h.tracker.bindAgentClientActiveRunDispatcher('thread-1', catId, {
          invocationId: runs[catId].invocationId,
          capabilities: { append: true, steer: true, inputReadReceipt: true },
          handle: { provider: 'openai_codex', carrier: 'codex_app_server' },
          dispatch: async (input, options) => {
            calls.push({ catId, messageIds: input.messageIds, invocationId: options.expectedInvocationId });
            if (catId === 'opus') {
              await ackGate;
              if (firstResult === 'throws') throw new Error('connection lost after native write');
              if (firstResult === 'rejected') {
                return { accepted: false, reason: 'provider_rejected', acceptance: 'not_accepted' };
              }
              if (firstResult === 'unconfirmed') return { accepted: false, reason: 'provider_rejected' };
            }
            return { accepted: true, handle: {} };
          },
        }),
      );
    }
    let requestFinished = false;
    const request = h.app
      .inject({
        method: 'POST',
        url: `/api/threads/thread-1/queue/${h.entry.id}/targets`,
        headers: { 'x-cat-cafe-user': 'user-1' },
        payload: {
          sourceRecordId: h.source.id,
          observedPendingTargetIds: ['opus', 'codex'],
          targets: ['opus', 'codex'].map((targetCatId) => ({
            targetCatId,
            strategy: 'guide_reply',
            membershipAtOpen: 'member',
          })),
        },
      })
      .then((response) => {
        requestFinished = true;
        return response;
      });
    let blocked;
    try {
      await waitFor(() => receipt(h, 'codex')?.appendAcceptance === 'accepted');
      assert.equal(requestFinished, false, 'the HTTP result still includes the held native ACK');
      const pending = await h.queue.getDurableEntry('thread-1', h.entry.id);
      assert.ok(pending, 'the first Queue owner survives until exact acceptance or recovery is committed');
      assert.deepEqual(pending.targets, ['opus'], 'the accepted sibling retires without waiting for the held target');
      assert.equal(pending.payload.messageId, h.source.id);
      assert.equal(pending.payload.sourceRecordId, h.source.id);
      assert.equal(pending.enqueuedAt, h.entry.enqueuedAt);
      assert.equal(pending.delivery.appendPendingByTarget.opus.invocationId, runs.opus.invocationId);
      assert.equal(pending.delivery.appendPendingByTarget.opus.responseMessageId, runs.opus.responseId);
      assert.equal(receipt(h, 'opus').appendAcceptance, 'pending');
      assert.equal(receipt(h, 'opus').inputRead.status, 'pending');
      assert.equal(receipt(h, 'codex').inputRead.status, 'pending', 'acceptance is not model-read evidence');
      assertOriginalSource(h);
    } catch (error) {
      blocked = error;
    } finally {
      releaseAck();
    }
    const response = await request;
    assert.ifError(blocked);
    assert.equal(response.statusCode, 200, response.body);
    const targets = response.json().targets;
    const expectedCalls = ['opus', 'codex'].map((catId) => ({
      catId,
      messageIds: [h.source.id],
      invocationId: runs[catId].invocationId,
    }));
    assert.deepEqual(calls, expectedCalls, 'one exact native delivery per target');
    assert.equal(targets[1].result.outcome, 'appended');
    assert.equal(targets[1].status, 200);
    assert.equal(receipt(h, 'codex').statusMessageId, runs.codex.responseId);
    assert.deepEqual(h.store.getById(runs.codex.responseId).lifecycle.inputMessageIds, [h.source.id]);

    if (firstResult === 'accepted') {
      assert.equal(targets[0].result.outcome, 'appended');
      assert.equal(await h.queue.getDurableEntry('thread-1', h.entry.id), null);
      assert.equal(receipt(h, 'opus').appendAcceptance, 'accepted');
      assert.equal(receipt(h, 'opus').inputRead.status, 'pending');
      assert.deepEqual(h.store.getById(runs.opus.responseId).lifecycle.inputMessageIds, [h.source.id]);
    } else {
      assert.equal(targets[0].status, 502);
      assert.equal(targets[0].result.code, 'PROVIDER_REJECTED');
      const pending = await h.queue.getDurableEntry('thread-1', h.entry.id);
      assert.ok(pending);
      assert.deepEqual(pending.targets, ['opus']);
      assert.equal(pending.payload.messageId, h.source.id);
      assert.equal(pending.enqueuedAt, h.entry.enqueuedAt);
      const expectedAcceptance = firstResult === 'rejected' ? 'not_accepted' : 'unknown';
      const failure = h.store.getById(h.source.id).lifecycle.appendFailures.find((item) => item.targetId === 'opus');
      assert.equal(failure.acceptance, expectedAcceptance);
      assert.equal(failure.reason, firstResult === 'throws' ? 'exception' : 'provider_rejected');
      assert.equal(failure.invocationId, runs.opus.invocationId);
      assert.equal(failure.responseMessageId, runs.opus.responseId);
      assert.equal(pending.delivery.appendRecoveryByTarget.opus.acceptance, expectedAcceptance);
      assert.equal(h.store.getById(runs.opus.responseId).lifecycle.kind, 'response');
      assert.equal(h.store.getById(runs.opus.responseId).lifecycle.status, 'processing');
      assert.equal(h.routeExecution.mock.callCount(), 0, 'a busy original receiver is not interrupted by recovery');

      if (firstResult === 'rejected') {
        assert.equal(receipt(h, 'opus'), undefined);
        assert.deepEqual(h.store.getById(runs.opus.responseId).lifecycle.inputMessageIds, []);
        assert.equal(pending.delivery.routingHeldTargetIds?.includes('opus') ?? false, false);
        h.tracker.completeAll('thread-1', ['opus'], runs.opus.controller);
        await h.processor.requestDrain('thread-1');
        await waitFor(async () => (await h.queue.getDurableEntry('thread-1', h.entry.id)) === null);
        assert.deepEqual(
          h.routeExecution.mock.calls.map((call) => [call.arguments[3], call.arguments[4]]),
          [[h.source.id, ['opus']]],
          'definite non-acceptance schedules only the original input and original failed target next turn',
        );
      } else {
        assert.deepEqual(pending.delivery.routingHeldTargetIds, ['opus']);
        assert.equal(receipt(h, 'opus').statusMessageId, runs.opus.responseId);
        assert.equal(receipt(h, 'opus').inputRead.status, 'pending');
        assert.deepEqual(h.store.getById(runs.opus.responseId).lifecycle.inputMessageIds, [h.source.id]);
        await h.processor.reconcileAppendDeliveries('thread-1');
        h.tracker.completeAll('thread-1', ['opus'], runs.opus.controller);
        await h.processor.requestDrain('thread-1');
        const unresolved = await h.queue.getDurableEntry('thread-1', h.entry.id);
        assert.deepEqual(unresolved.targets, ['opus']);
        assert.equal(unresolved.delivery.appendRecoveryByTarget.opus.acceptance, 'unknown');
        assert.ok(Number.isFinite(unresolved.delivery.appendRecoveryByTarget.opus.checkedAt));
        assert.equal(
          h.routeExecution.mock.callCount(),
          0,
          'an idle receiver does not authorize replaying an unknown input',
        );
      }
    }
    await h.processor.requestDrain('thread-1');
    assert.deepEqual(calls, expectedCalls, 'recovery and another drain never repeat the native append');
    assertOriginalSource(h);
  });
}
