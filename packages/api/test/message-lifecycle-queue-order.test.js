import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { compareLifecycleQueueEntries } = await import(
  '../dist/domains/cats/services/agents/invocation/message-lifecycle-queue-order.js'
);

describe('canonical lifecycle Queue order', () => {
  it('sorts only by position, priority, FIFO time, and id', () => {
    const entries = [
      { id: 'normal-old', priority: 'normal', enqueuedAt: 10 },
      { id: 'urgent-new', priority: 'urgent', enqueuedAt: 30 },
      { id: 'urgent-old-z', priority: 'urgent', enqueuedAt: 20 },
      { id: 'urgent-old-a', priority: 'urgent', enqueuedAt: 20 },
      { id: 'positioned', priority: 'normal', position: 4, enqueuedAt: 40 },
    ];

    assert.deepEqual(
      entries.sort(compareLifecycleQueueEntries).map((entry) => entry.id),
      ['positioned', 'urgent-old-a', 'urgent-old-z', 'urgent-new', 'normal-old'],
    );
  });
});
