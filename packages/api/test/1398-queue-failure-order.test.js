import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { InvocationRecordStore } from '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { queueHttpFixture } from './helpers/1398-queue-http-fixture.js';

async function send(f, cat, text) {
  const result = await f.app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: { 'x-cat-cafe-user': 'owner' },
    payload: { threadId: f.thread.id, content: `@${cat} ${text}`, mentions: [cat] },
  });
  assert.equal(result.statusCode, 202, result.body);
  return f.queue.list(f.thread.id, 'owner').at(-1);
}

for (const preceding of ['held-disjoint', 'busy-disjoint', 'held-same-target']) {
  test(`unavailable failure observes per-recipient Queue order behind ${preceding}`, async (t) => {
    const f = await queueHttpFixture(t);
    const firstCat = preceding === 'held-same-target' ? 'gemini' : 'opus';
    const first = await send(f, firstCat, 'earlier work');
    const later = await send(f, 'gemini', 'later work');
    const tracker = new InvocationTracker();
    if (preceding.startsWith('held')) {
      assert.ok(await f.queue.markProcessingByIdDurable(f.thread.id, first.id, firstCat));
      await f.queue.holdClaimedRoutingTarget(f.thread.id, [first.id], firstCat, f.messages);
      await f.queue.rollbackProcessingDurable(f.thread.id, first.id);
    } else {
      const controller = tracker.start(f.thread.id, firstCat, 'owner');
      t.after(() => tracker.complete(f.thread.id, firstCat, controller));
    }
    f.agents.markUnavailable('gemini', { code: 'rejected-account-binding', message: 'late outage' });
    f.router.refreshFromRegistry(f.agents);
    const processor = new QueueProcessor({
      queue: f.queue,
      invocationTracker: tracker,
      invocationRecordStore: new InvocationRecordStore(),
      messageStore: f.messages,
      router: f.router,
      socketManager: { emitToUser() {}, broadcastAgentMessage() {}, broadcastToRoom() {} },
      log: { info() {}, warn() {}, error() {} },
    });
    await processor.requestDrain(f.thread.id);
    const failures = f.messages
      .getByThread(f.thread.id)
      .filter((message) => message.lifecycle?.kind === 'delivery_failure');
    const sameTarget = preceding === 'held-same-target';
    assert.equal(failures.length, sameTarget ? 0 : 1, 'only overlapping recipients may hold back failure settlement');
    assert.deepEqual(
      f.queue.list(f.thread.id, 'owner').map((entry) => entry.id),
      sameTarget ? [first.id, later.id] : [first.id],
    );
    if (!sameTarget) assert.equal(failures[0].lifecycle.inputMessageId, later.payload.messageId);
  });
}

test('failure claim rejects a recipient change since the resolver selected the entry', async (t) => {
  const f = await queueHttpFixture(t);
  const entry = await send(f, 'gemini', 'bound original');
  await f.queue.reconcileQueuedMessageTargetsDurable(f.thread.id, 'owner', entry.id, ['codex'], ['gemini'], {});
  const claimed = await f.queue.claimPreAdmissionFailureAcrossUsersDurable(f.thread.id, entry.id, ['gemini']);
  assert.equal(claimed, null, 'the resolver cannot fail a replacement recipient it never examined');
  assert.deepEqual((await f.queue.getDurableEntry(f.thread.id, entry.id)).targets, ['codex']);
});
