import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stopFixture, waitFor } from './helpers/stop-private-fixture.js';

test('A2A queue action loads and interrupts through the same source and real Queue admission', async (t) => {
  const h = await stopFixture(t);
  const previousController = h.tracker.getController('thread', 'opus');
  const from = { kind: 'agent', catId: 'codex' };
  const source = await h.messages.append({
    from,
    userId: 'owner',
    threadId: 'thread',
    content: 'peer follow-up',
    mentions: ['opus'],
    timestamp: Date.now(),
  });
  const admitted = await h.queue.enqueueExistingMessageDurable(h.messages, source.id, {
    from,
    userId: 'owner',
    threadId: 'thread',
    kind: 'message_wake',
    sourceCategory: 'a2a',
    sourceId: source.id,
    messageId: source.id,
    content: source.content,
    targetCats: ['opus'],
    ownerAuthProvenance: 'strict',
    intent: 'execute',
    autoExecute: true,
    a2aParentInvocationId: 'original-caller',
    a2aTriggerMessageId: source.id,
    idempotencyKey: `a2a:${source.id}`,
  });
  assert.equal(admitted.outcome, 'enqueued');
  const entry = admitted.entry;
  const url = `/api/threads/thread/queue/${encodeURIComponent(entry.id)}/targets`;
  const opened = await h.app.inject({ url, headers: { 'x-cat-cafe-user': 'owner' } });
  assert.equal(opened.statusCode, 200, opened.body);
  assert.equal(opened.json().sourceRecordId, source.id);
  assert.deepEqual(opened.json().targets, [{ targetCatId: 'opus', state: 'pending', actionable: true }]);

  const confirmed = await h.app.inject({
    method: 'POST',
    url,
    headers: { 'x-cat-cafe-user': 'owner' },
    payload: {
      sourceRecordId: source.id,
      observedPendingTargetIds: ['opus'],
      targets: [{ targetCatId: 'opus', strategy: 'interrupt_reply', membershipAtOpen: 'member' }],
    },
  });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  assert.equal(confirmed.json().targets[0].status, 200);
  assert.equal(confirmed.json().targets[0].result.started, true);
  assert.equal(previousController.signal.aborted, true);
  await waitFor(() => h.starts.includes(source.content));
  await waitFor(() => !h.tracker.has('thread', 'opus'));

  const persisted = await h.messages.getById(source.id);
  assert.deepEqual(persisted.from, from);
  assert.equal(persisted.content, source.content);
  assert.equal(persisted.lifecycle.dispatchRefs.length, 1);
  const ref = persisted.lifecycle.dispatchRefs[0];
  assert.equal(ref.targetId, 'opus');
  const response = await h.messages.getById(ref.statusMessageId);
  assert.deepEqual(response.lifecycle.inputMessageIds, [source.id]);
  assert.equal(await h.queue.getDurableEntry('thread', entry.id), null);
  assert.equal(h.starts.filter((content) => content === source.content).length, 1);
});
