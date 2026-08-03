import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

function userMessage(content, timestamp, extra = {}) {
  return {
    userId: 'user-1',
    catId: null,
    content,
    mentions: [],
    timestamp,
    threadId: 'thread-1',
    ...extra,
  };
}

function finalMessage(content, timestamp) {
  return {
    userId: 'user-1',
    catId: 'codex-sol',
    content,
    mentions: [],
    timestamp,
    threadId: 'thread-1',
    origin: 'stream',
    idempotencyKey: 'freshness-closure:closure-1:final',
  };
}

describe('F254 Phase E — atomic output commit boundary', () => {
  it('publishes unconditionally and returns the exact pre-append frontier', async () => {
    const store = new MessageStore();
    const trigger = await store.append(userMessage('question', 100));
    const racing = await store.append(userMessage('new information', 150));

    const result = await store.appendAndObservePriorFrontier(finalMessage('published answer', 200));

    assert.equal(result.kind, 'committed');
    assert.equal(result.priorFrontierMessageId, racing.id);
    assert.equal(result.idempotent, false);
    assert.equal(result.message.content, 'published answer');
    assert.deepEqual(result.message.extra?.freshness, {
      kind: 'scan_pending',
      priorFrontierMessageId: racing.id,
    });
    assert.deepEqual(
      (await store.getByThread('thread-1')).map((item) => item.content),
      ['question', 'new information', 'published answer'],
    );
    assert.notEqual(result.priorFrontierMessageId, trigger.id);
  });

  it('idempotent publish replay preserves the first observation boundary', async () => {
    const store = new MessageStore();
    const trigger = await store.append(userMessage('question', 100));
    const first = await store.appendAndObservePriorFrontier(finalMessage('first body', 200));
    await store.append(userMessage('later message', 250));

    const replay = await store.appendAndObservePriorFrontier(finalMessage('must not replace', 300));

    assert.equal(replay.idempotent, true);
    assert.equal(replay.message.id, first.message.id);
    assert.equal(replay.message.content, 'first body');
    assert.equal(replay.priorFrontierMessageId, trigger.id);
    assert.equal((await store.getByThread('thread-1')).filter((item) => item.catId === 'codex-sol').length, 1);
  });

  it('observes queued rows in the unconditional raw frontier', async () => {
    const store = new MessageStore();
    await store.append(userMessage('question', 100));
    const queued = await store.append(userMessage('queued follow-up', 150, { deliveryStatus: 'queued' }));

    const result = await store.appendAndObservePriorFrontier(finalMessage('published despite queue', 200));

    assert.equal(result.priorFrontierMessageId, queued.id);
    assert.equal(result.message.content, 'published despite queue');
  });

  it('commits exactly once when the raw thread frontier matches', async () => {
    const store = new MessageStore();
    const trigger = await store.append(userMessage('question', 100));
    assert.equal(await store.getLatestThreadMessageIdIncludingQueued('thread-1'), trigger.id);

    const first = await store.appendIfThreadFrontier(finalMessage('fresh answer', 200), trigger.id);
    assert.equal(first.kind, 'committed');
    const retry = await store.appendIfThreadFrontier(finalMessage('must dedupe', 300), 'wrong-frontier');
    assert.equal(retry.kind, 'committed');
    assert.equal(retry.message.id, first.message.id);
    assert.equal((await store.getByThread('thread-1')).filter((m) => m.catId === 'codex-sol').length, 1);
  });

  it('writes no message or idempotency claim when another message wins the frontier race', async () => {
    const store = new MessageStore();
    const trigger = await store.append(userMessage('question', 100));
    const racing = await store.append(userMessage('new information', 150));

    const lost = await store.appendIfThreadFrontier(finalMessage('stale answer', 200), trigger.id);
    assert.deepEqual(lost, { kind: 'frontier_advanced', actualLatestMessageId: racing.id });
    assert.equal(
      (await store.getByThread('thread-1')).some((m) => m.content === 'stale answer'),
      false,
    );

    const won = await store.appendIfThreadFrontier(finalMessage('fresh retry', 250), racing.id);
    assert.equal(won.kind, 'committed', 'failed compare must not retain the idempotency claim');
  });

  it('includes queued messages in the raw frontier', async () => {
    const store = new MessageStore();
    const trigger = await store.append(userMessage('question', 100));
    const queued = await store.append(userMessage('queued follow-up', 150, { deliveryStatus: 'queued' }));
    assert.equal(await store.getLatestThreadMessageIdIncludingQueued('thread-1'), queued.id);

    const lost = await store.appendIfThreadFrontier(finalMessage('did not cover queue', 200), trigger.id);
    assert.equal(lost.kind, 'frontier_advanced');
    assert.equal(lost.actualLatestMessageId, queued.id);
  });
});
