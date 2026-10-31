// @ts-check

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { admitThreadParticipants } from '../dist/routes/thread-participant-admission.js';

describe('thread participant admission fanout policy', () => {
  test('standard message admission preserves its event after router persistence', async () => {
    const threadStore = new ThreadStore();
    const thread = await threadStore.create('alice', 'Thread');
    await threadStore.addParticipants(thread.id, ['opus']);
    const events = [];

    const result = await admitThreadParticipants({
      userId: 'alice',
      threadId: thread.id,
      targetCats: ['opus'],
      threadStore,
      socketManager: { emitToUser: (...args) => events.push(args) },
      emitPolicy: 'always',
    });

    assert.equal(result.changed, false);
    assert.deepEqual(events, [['alice', 'thread_updated', { threadId: thread.id, participants: ['opus'] }]]);
  });

  test('proposal admission emits only for a real membership change', async () => {
    const threadStore = new ThreadStore();
    const thread = await threadStore.create('alice', 'Thread');
    const events = [];
    const input = {
      userId: 'alice',
      threadId: thread.id,
      targetCats: ['kimi'],
      threadStore,
      socketManager: { emitToUser: (...args) => events.push(args) },
      emitPolicy: 'membership-changed',
    };

    assert.equal((await admitThreadParticipants(input)).changed, true);
    assert.equal((await admitThreadParticipants(input)).changed, false);
    assert.deepEqual(events, [['alice', 'thread_updated', { threadId: thread.id, participants: ['kimi'] }]]);
  });

  test('missing threads fail closed without publishing ghost participants', async () => {
    const events = [];

    await assert.rejects(
      admitThreadParticipants({
        userId: 'alice',
        threadId: 'missing-thread',
        targetCats: ['kimi'],
        threadStore: new ThreadStore(),
        socketManager: { emitToUser: (...args) => events.push(args) },
        emitPolicy: 'membership-changed',
      }),
      /Cannot admit participants to missing thread/,
    );
    assert.deepEqual(events, []);
  });
});
