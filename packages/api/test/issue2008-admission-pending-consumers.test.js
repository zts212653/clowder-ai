import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StartupReconciler } from '../dist/domains/cats/services/agents/invocation/StartupReconciler.js';
import { appendA2ASourceWithLedgerAdmission } from '../dist/routes/callback-a2a-trigger.js';
import { admissionFixture, enqueueUser, gateAttempt, socketFixture } from './helpers/stop-admission-fixture.js';
import { waitFor } from './helpers/stop-private-fixture.js';

for (const { producer, restart } of [
  { producer: 'user' },
  { producer: 'a2a' },
  { producer: 'private' },
  { producer: 'user', restart: true },
  { producer: 'a2a', restart: true },
]) {
  test(`#2008 unstarted ${producer} record/consumer remain pending, startup sweep=${!!restart}`, async (t) => {
    const h = await admissionFixture(t);
    const stop = await socketFixture(t, h);
    let source;
    if (producer === 'a2a') {
      await appendA2ASourceWithLedgerAdmission(
        { messageStore: h.messages, invocationQueue: h.queue },
        {
          userId: 'default-user',
          threadId: 'thread',
          from: { kind: 'agent', catId: 'gemini' },
          content: 'pending source',
          mentions: ['sonnet'],
          timestamp: Date.now(),
        },
        {
          plan: { requestedTargetCats: ['sonnet'], acceptedTargetCats: ['sonnet'], streakTargetCats: ['sonnet'] },
          ownerAuthProvenance: 'strict',
        },
      );
      source = { entry: h.queue.listPendingAcrossUsers('thread')[0] };
    } else if (producer === 'private') {
      source = await h.queue.enqueueDurable(
        h.privateInput('private source', {
          userId: 'default-user',
          targetCats: ['sonnet'],
        }),
      );
    } else source = await enqueueUser(h);
    const originalDeliveryStatus = source.entry.payload.messageId
      ? (await h.messages.getById(source.entry.payload.messageId)).deliveryStatus
      : undefined;
    const hooks = [];
    const commits = [];
    h.processor.sessionContinuationCoordinator = { commitInvocationOutcome: async (input) => commits.push(input) };
    h.processor.registerEntryCompleteHook(source.entry.id, (_id, status) => hooks.push(status), 'sonnet');
    let recordId;
    const create = h.records.create.bind(h.records);
    h.records.create = async (...args) => {
      const result = await create(...args);
      recordId = result.invocationId;
      return result;
    };
    const gate = gateAttempt(h, source, 'record');
    t.after(() => gate.release());
    const drain = h.processor.requestDrain('thread');
    await gate.waiting;
    // Stop retires an accumulated private recipient (ADR-043 D9.6). Exercise
    // private pre-start deferral through its actual busy-target path instead.
    const controller =
      producer === 'private'
        ? h.tracker.start('thread', 'sonnet', 'other-owner', ['sonnet'], 'foreign-busy')
        : await stop('sonnet', 'default-user');
    gate.release();
    await drain;
    await waitFor(() => !h.processor.hasProcessingSlotReservation('thread', 'sonnet'));
    assert.deepEqual(h.starts, []);
    assert.deepEqual(hooks, [], 'a pending source has no terminal callback');
    assert.deepEqual(commits, [], 'unstarted owner/continuation outcome is not terminal');
    const record = await h.records.get(recordId);
    assert.equal(record.status, 'queued');
    assert.equal(record.userMessageId, source.entry.payload.messageId ?? null);
    assert.equal((await h.queue.getDurableEntry('thread', source.entry.id)).status, 'queued');
    if (restart) {
      record.createdAt -= 6 * 60_000;
      // Memory storage has no SCAN; expose the one real record to the production reconciler.
      h.records.scanByStatus = async (status) => ((await h.records.get(recordId)).status === status ? [recordId] : []);
      const reconciler = new StartupReconciler({
        invocationRecordStore: h.records,
        invocationQueue: h.queue,
        messageStore: h.messages,
        taskProgressStore: { getSnapshot: async () => null },
        log: { info() {}, warn() {} },
      });
      assert.equal((await reconciler.reconcileOrphans()).queued, 1);
      assert.equal((await h.records.get(recordId)).error, 'process_restart');
      assert.equal((await h.messages.getById(source.entry.payload.messageId)).deliveryStatus, originalDeliveryStatus);
    }
    h.tracker.complete('thread', 'sonnet', controller);
    assert.equal((await h.processor.processNext('thread', 'default-user')).started, true);
    await waitFor(() => !h.processor.hasProcessingSlotReservation('thread', 'sonnet'));
    assert.deepEqual(h.starts, [producer === 'private' ? 'private source' : 'pending source']);
    assert.deepEqual(hooks, ['succeeded'], 'the actual execution delivers its one-shot response once');
    assert.equal(commits.length, 1);
    assert.equal((await h.records.get(recordId)).status, 'succeeded');
  });
}
