/**
 * PR-3a (contract 2.4, 3.8, 3.10; Astra R1 P1-5): the owner-room events this PR adds reach the person
 * whose page shows the thread, not the identity a message was stored under.
 *
 * A scheduler's web digest or memory-curation receipt is stored as `scheduler` inside a person's
 * thread, and a scheduler-owned run's reply belongs to `scheduler`. The person's page joins only
 * `user:<person>`; before this, those hints and terminal snapshots went to `user:scheduler`, where no
 * page listens, so the person's Sidebar badge and background toast never moved.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

const { createOwnerRoomNotifier } = await import('../dist/domains/messaging/owner-room/owner-room-notifier.js');
const { createPublishingMessageStore } = await import('../dist/domains/messaging/publishing-message-store.js');
const { createMessagingStores } = await import('../dist/domains/messaging/stores/factory.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

const PERSON = 'operator';

function recordingSocket() {
  const sent = [];
  return { sent, emitToUser: (userId, event, data) => sent.push({ room: `user:${userId}`, event, data }) };
}

describe('PR-3a owner room: who hears the events this PR adds', () => {
  let threads;
  let socket;
  let errors;
  let notifier;
  let messages;
  let threadId;

  beforeEach(async () => {
    threads = new ThreadStore();
    socket = recordingSocket();
    errors = [];
    notifier = createOwnerRoomNotifier({
      socket: () => socket,
      threads: () => threads,
      onError: (error, message, stage) => errors.push({ stage, id: message.id, error: error.message }),
    });
    const stores = createMessagingStores();
    messages = createPublishingMessageStore(new MessageStore(), {
      events: stores.events,
      publications: stores.publications,
      onPublishFailure: (error) => {
        throw error;
      },
      lifecycleObserver: {
        committed: (message, commit) => {
          void notifier.lifecycleCommitted(message, commit);
        },
        failed: (error) => {
          throw error;
        },
      },
    });
    threadId = (await threads.create(PERSON, 'Daily digest')).id;
  });

  const settle = () => new Promise((resolve) => setImmediate(resolve));

  test("a scheduler's standalone notice in a person's thread reaches the person's room", async () => {
    const notice = await messages.append({
      userId: 'scheduler',
      threadId,
      from: { kind: 'system', service: 'scheduler' },
      content: '今日网页摘要',
      mentions: [],
      mentionsUser: true,
      timestamp: 10,
    });

    await notifier.messageAppended(notice);

    assert.deepEqual(socket.sent, [
      {
        room: `user:${PERSON}`,
        event: 'thread_message_appended',
        data: { threadId, messageId: notice.id, mentionsUser: true },
      },
    ]);
    assert.equal(notice.userId, 'scheduler', 'the stored identity is unchanged');
  });

  test("a scheduler-owned run's applied terminal reaches the person's room, marked applied", async () => {
    const placeholder = await messages.append({
      userId: 'scheduler',
      threadId,
      from: { kind: 'agent', catId: 'opus' },
      content: '',
      mentions: [],
      timestamp: 100,
      lifecycle: {
        kind: 'response',
        orderKey: '100:turn-1',
        invocationId: 'turn-1',
        targetId: 'opus',
        inputEntryIds: ['entry-1'],
        inputMessageIds: ['source-1'],
        status: 'processing',
        startedAt: 100,
      },
    });

    await messages.commitLifecycleResponseTerminal(placeholder.id, {
      invocationId: 'turn-1',
      status: 'failed',
      completedAt: 200,
      content: '摘要失败',
      mentions: [],
      reason: 'provider exited',
    });
    await settle();

    const snapshots = socket.sent.filter((entry) => entry.event === 'message_lifecycle_updated');
    assert.deepEqual(
      snapshots.map(({ room, data }) => [room, data.commit, data.message.lifecycle.status]),
      [[`user:${PERSON}`, 'applied', 'failed']],
    );
  });

  test('a person writing in their own thread is unchanged', async () => {
    const post = await messages.append({
      userId: PERSON,
      threadId,
      from: { kind: 'agent', catId: 'opus' },
      content: 'hi',
      mentions: [],
      timestamp: 1,
    });
    await notifier.messageAppended(post);
    assert.equal(socket.sent[0].room, `user:${PERSON}`);
  });

  test('falls back to the stored identity when the thread cannot be found or read', async () => {
    const orphan = { id: 'm-orphan', threadId: 'thread-gone', userId: 'scheduler', catId: 'opus', content: 'x' };
    await notifier.messageAppended(orphan);

    threads = {
      get: () => {
        throw new Error('redis down');
      },
    };
    await notifier.messageAppended({ ...orphan, id: 'm-unreadable', threadId });

    assert.deepEqual(
      socket.sent.map(({ room, data }) => [room, data.messageId]),
      [
        ['user:scheduler', 'm-orphan'],
        ['user:scheduler', 'm-unreadable'],
      ],
    );
    assert.deepEqual(errors, [{ stage: 'owner', id: 'm-unreadable', error: 'redis down' }]);
  });

  test('sends nothing for lifecycle or queued messages, and never throws without a socket', async () => {
    await notifier.messageAppended({ id: 'q', threadId, userId: PERSON, deliveryStatus: 'queued', content: '' });
    await notifier.messageAppended({
      id: 'l',
      threadId,
      userId: PERSON,
      content: '',
      lifecycle: { kind: 'response', status: 'processing' },
    });
    assert.deepEqual(socket.sent, []);
    socket = null;
    await notifier.messageAppended({ id: 'm', threadId, userId: PERSON, content: 'x' });
    assert.deepEqual(errors, []);
  });
});
