import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { createPostCompactContextProjector } = await import(
  '../dist/domains/cats/services/agents/routing/post-compact-context-projector.js'
);
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { DeliveryCursorStore } = await import('../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js');
const { cursorFor } = await import('../dist/domains/cats/services/stores/cursor.js');

describe('F296 B3b-3: post-compact projection reuses the cold packet without replaying read history', () => {
  test('only the unread tail is projected and both durable cursors remain unchanged', async () => {
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const old = messageStore.append({
      threadId: 'thread-1',
      userId: 'user-1',
      catId: null,
      content: 'READ-HISTORY-MUST-NOT-REPLAY',
      mentions: [],
      timestamp: 1_000,
    });
    const unread = messageStore.append({
      threadId: 'thread-1',
      userId: 'user-1',
      catId: null,
      content: 'UNREAD-TAIL-MUST-RETURN',
      mentions: [],
      timestamp: 2_000,
    });
    const boundary = cursorFor(old);
    await deliveryCursorStore.ackCursor('user-1', 'opus', 'thread-1', boundary);
    await deliveryCursorStore.ackSeenCursor('user-1', 'opus', 'thread-1', boundary);

    const project = createPostCompactContextProjector({
      services: {},
      invocationDeps: {},
      messageStore,
      deliveryCursorStore,
    });
    const result = await project({
      record: { userId: 'user-1', catId: 'opus', threadId: 'thread-1' },
      decision: {
        contextEpoch: 2,
        contextMode: 'cold',
        transition: 'context_compacted',
      },
    });

    assert.match(result.contextPacket, /"contextMode":"cold"/);
    assert.match(result.contextPacket, /UNREAD-TAIL-MUST-RETURN/);
    assert.doesNotMatch(result.contextPacket, /READ-HISTORY-MUST-NOT-REPLAY/);
    assert.deepEqual(result.projectedMessageIds, [unread.id]);
    assert.equal(await deliveryCursorStore.getCursor('user-1', 'opus', 'thread-1'), boundary);
    assert.equal(await deliveryCursorStore.getSeenCursor('user-1', 'opus', 'thread-1'), boundary);
  });

  test('zero unread messages still produce an explicit trusted cold packet', async () => {
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const project = createPostCompactContextProjector({
      services: {},
      invocationDeps: {},
      messageStore,
      deliveryCursorStore,
    });

    const result = await project({
      record: { userId: 'user-1', catId: 'opus', threadId: 'thread-empty' },
      decision: {
        contextEpoch: 7,
        contextMode: 'cold',
        transition: 'context_compacted',
      },
    });

    assert.match(result.contextPacket, /\[Context Continuity\]/);
    assert.match(result.contextPacket, /"contextEpoch":7/);
    assert.match(result.contextPacket, /"contextMode":"cold"/);
    assert.deepEqual(result.projectedMessageIds, []);
    assert.deepEqual(result.exposedMessageIds, []);
  });
});
