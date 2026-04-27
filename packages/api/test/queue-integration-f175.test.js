/**
 * F175 regression + integration tests
 * Task 7: #564 scenario + cross-priority auto-dequeue chain
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');

describe('#564 regression: urgent connector does not break A2A chain', () => {
  it('urgent enqueue does not abort active signal', () => {
    const queue = new InvocationQueue();

    // 1. Simulate active invocation (signal alive)
    const controller = new AbortController();

    // 2. Urgent connector message arrives and enqueues (F175: no preemption)
    const result = queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'CI failed',
      source: 'connector',
      targetCats: ['opus'],
      intent: 'execute',
      priority: 'urgent',
      sourceCategory: 'ci',
    });

    // 3. Signal NOT aborted (the critical invariant from #564)
    assert.equal(controller.signal.aborted, false, 'active signal must not be aborted by urgent enqueue');

    // 4. Urgent message is in queue, not executing
    assert.equal(result.outcome, 'enqueued');
    const entries = queue.list('t1', 'u1');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].priority, 'urgent');
    assert.equal(entries[0].sourceCategory, 'ci');
  });

  it('multiple urgent enqueues during active invocation all preserve signal', () => {
    const queue = new InvocationQueue();
    const controller = new AbortController();

    for (let i = 0; i < 3; i++) {
      queue.enqueue({
        threadId: 't1',
        userId: 'u1',
        content: `urgent-${i}`,
        source: 'connector',
        targetCats: ['opus'],
        intent: 'execute',
        priority: 'urgent',
      });
    }

    assert.equal(controller.signal.aborted, false);
    assert.equal(queue.list('t1', 'u1').length, 3, 'all urgent messages should be queued');
  });
});

describe('cross-priority auto-dequeue', () => {
  it('urgent dequeues before normal regardless of enqueue order', () => {
    const queue = new InvocationQueue();

    // Normal enqueued first
    queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'normal first',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
      priority: 'normal',
    });

    // Urgent enqueued second
    queue.enqueue({
      threadId: 't1',
      userId: 'u2',
      content: 'urgent second',
      source: 'connector',
      targetCats: ['opus'],
      intent: 'execute',
      priority: 'urgent',
    });

    // markProcessingAcrossUsers should pick urgent first
    const first = queue.markProcessingAcrossUsers('t1');
    assert.equal(first.priority, 'urgent');
    assert.equal(first.content, 'urgent second');
  });

  it('after urgent completes, normal entry is next in line', () => {
    const queue = new InvocationQueue();

    queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'normal',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
      priority: 'normal',
    });
    queue.enqueue({
      threadId: 't1',
      userId: 'u2',
      content: 'urgent',
      source: 'connector',
      targetCats: ['opus'],
      intent: 'execute',
      priority: 'urgent',
    });

    // Process urgent
    const urgent = queue.markProcessingAcrossUsers('t1');
    assert.equal(urgent.priority, 'urgent');
    queue.removeProcessedAcrossUsers('t1', urgent.id);

    // Next should be normal
    const normal = queue.peekOldestAcrossUsers('t1');
    assert.equal(normal.priority, 'normal');
    assert.equal(normal.content, 'normal');
  });

  it('position override trumps priority in dequeue order', () => {
    const queue = new InvocationQueue();

    const urgentResult = queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'urgent',
      source: 'connector',
      targetCats: ['opus'],
      intent: 'execute',
      priority: 'urgent',
    });

    const normalResult = queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'normal-pinned',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
      priority: 'normal',
    });

    // User drags normal entry to position 0
    queue.setPosition('t1', 'u1', normalResult.entry.id, 0);

    const next = queue.peekOldestAcrossUsers('t1');
    assert.equal(next.content, 'normal-pinned', 'position override should trump urgent priority');
  });
});
