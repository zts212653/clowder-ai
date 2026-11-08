/**
 * PR-3a (docs/plans/2026-11-05-hub-pr3-background-thread-contract.md 2.4, 3.5, 3.8).
 *
 * Background threads will stop joining their thread rooms, so what a page learns about them must
 * reach the owner's user room:
 *  - every lifecycle terminal commit is observed at the one store seam it passes, marked with
 *    whether it was applied now or replayed — a page may announce only `applied`;
 *  - a stored standalone message produces a body-free hint, so the Sidebar's unread and the owner
 *    mention notification survive without the room.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { canonicalTestMessageInput } from './helpers/message-from-fixtures.js';

const { createPublishingMessageStore } = await import('../dist/domains/messaging/publishing-message-store.js');
const { createMessagingStores } = await import('../dist/domains/messaging/stores/factory.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { emitLifecycleMessageUpdated } = await import(
  '../dist/domains/cats/services/agents/invocation/lifecycle-message-update.js'
);
const { threadMessageAppendedHint } = await import(
  '../dist/domains/messaging/owner-room/thread-message-appended-hint.js'
);

const THREAD = 'thread-bg';

function processingResponse(overrides = {}) {
  return {
    userId: 'owner',
    threadId: THREAD,
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
    ...overrides,
  };
}

const terminal = (status, overrides = {}) => ({
  invocationId: 'turn-1',
  status,
  completedAt: 200,
  content: '完成了',
  mentions: [],
  ...overrides,
});

describe('PR-3a store seam: lifecycle terminal commits reach the Hub observer', () => {
  let observed;
  let failures;
  let published;
  let throwFromObserver;
  let store;

  beforeEach(() => {
    observed = [];
    failures = [];
    published = [];
    throwFromObserver = false;
    const stores = createMessagingStores();
    store = createPublishingMessageStore(new MessageStore(), {
      events: stores.events,
      publications: stores.publications,
      onMessagePublished: (message) => published.push(message.id),
      onPublishFailure: (error) => {
        throw error;
      },
      lifecycleObserver: {
        committed: (message, commit) => {
          if (throwFromObserver) throw new Error('socket down');
          observed.push({ id: message.id, status: message.lifecycle?.status, commit, userId: message.userId });
        },
        failed: (error, message) => failures.push({ id: message.id, error: error.message }),
      },
    });
  });

  test('a processing placeholder is not observed; its terminal is, as applied, for its owner', async () => {
    const placeholder = await store.append(processingResponse());
    assert.deepEqual(observed, []);

    const result = await store.commitLifecycleResponseTerminal(placeholder.id, terminal('completed'));
    assert.equal(result.kind, 'applied');
    assert.deepEqual(observed, [{ id: placeholder.id, status: 'completed', commit: 'applied', userId: 'owner' }]);
  });

  test('an identical terminal again is observed as replayed; a different one is not observed', async () => {
    const placeholder = await store.append(processingResponse());
    await store.commitLifecycleResponseTerminal(placeholder.id, terminal('canceled'));

    const replay = await store.commitLifecycleResponseTerminal(placeholder.id, terminal('canceled'));
    const different = await store.commitLifecycleResponseTerminal(placeholder.id, terminal('failed'));

    assert.equal(replay.kind, 'replayed');
    assert.equal(different.kind, 'conflict');
    assert.deepEqual(
      observed.map(({ status, commit }) => [status, commit]),
      [
        ['canceled', 'applied'],
        ['canceled', 'replayed'],
      ],
    );
  });

  test('a whisper reply is observed although the subscriber stream skips it', async () => {
    const placeholder = await store.append(processingResponse({ visibility: 'whisper', whisperTo: ['opus'] }));
    await store.commitLifecycleResponseTerminal(placeholder.id, terminal('completed'));

    assert.deepEqual(published, [], 'subscriber filters still apply to publish()');
    assert.equal(observed.length, 1);
  });

  test('an observer failure is reported and neither fails the commit nor the publish', async () => {
    const placeholder = await store.append(processingResponse());
    throwFromObserver = true;

    const result = await store.commitLifecycleResponseTerminal(placeholder.id, terminal('completed'));

    assert.equal(result.kind, 'applied');
    assert.deepEqual(published, [placeholder.id]);
    assert.deepEqual(failures, [{ id: placeholder.id, error: 'socket down' }]);
  });

  test('a pre-admission failure is observed with its input, both applied', async () => {
    const source = await store.append(
      canonicalTestMessageInput({
        userId: 'owner',
        threadId: THREAD,
        catId: 'opus',
        content: '@codex please review',
        mentions: ['codex'],
        timestamp: 90,
        origin: 'callback',
        lifecycle: { kind: 'input', orderKey: '90:entry-wake', dispatchRefs: [] },
      }),
    );

    const result = await store.commitLifecyclePreAdmissionFailure({
      sourceMessageId: source.id,
      expectedEntryId: 'entry-wake',
      requestedTargets: ['codex'],
      reason: 'invalid_explicit_target',
      content: '消息未能送达：指定的接收对象当前无效。',
      failedAt: 100,
    });

    assert.equal(result.kind, 'applied');
    assert.deepEqual(
      observed.map(({ id, commit }) => [id, commit]),
      [
        [source.id, 'applied'],
        [result.failureMessage.id, 'applied'],
      ],
    );
  });
});

describe('PR-3a lifecycle snapshot payload', () => {
  const message = {
    id: 'resp-1',
    threadId: THREAD,
    userId: 'owner',
    catId: 'opus',
    content: 'ok',
    timestamp: 1,
    lifecycle: { kind: 'response', status: 'completed' },
  };

  test('carries the commit marker only when the seam gives one', () => {
    const sent = [];
    const emitter = { emitToUser: (userId, event, data) => sent.push({ userId, event, data }) };

    emitLifecycleMessageUpdated(emitter, 'owner', message, 'applied');
    emitLifecycleMessageUpdated(emitter, 'owner', message);

    assert.equal(sent[0].event, 'message_lifecycle_updated');
    assert.equal(sent[0].data.commit, 'applied');
    assert.equal('commit' in sent[1].data, false);
  });
});

describe('PR-3a owner-room hint for a stored standalone message', () => {
  const base = { id: 'post-1', threadId: THREAD, userId: 'owner', catId: 'opus', content: 'hi', timestamp: 1 };

  test('a standalone cat message produces a body-free hint', () => {
    assert.deepEqual(threadMessageAppendedHint({ ...base, mentionsUser: true }), {
      threadId: THREAD,
      messageId: 'post-1',
      catId: 'opus',
      mentionsUser: true,
    });
    assert.deepEqual(threadMessageAppendedHint({ ...base, catId: null }), { threadId: THREAD, messageId: 'post-1' });
  });

  test('a whisper keeps its hint but not the owner mention', () => {
    assert.deepEqual(threadMessageAppendedHint({ ...base, mentionsUser: true, visibility: 'whisper' }), {
      threadId: THREAD,
      messageId: 'post-1',
      catId: 'opus',
    });
  });

  test('lifecycle messages and queued messages are left to their own owner-room events', () => {
    assert.equal(threadMessageAppendedHint({ ...base, lifecycle: { kind: 'response', status: 'processing' } }), null);
    assert.equal(threadMessageAppendedHint({ ...base, lifecycle: { kind: 'input', orderKey: 'k' } }), null);
    assert.equal(threadMessageAppendedHint({ ...base, deliveryStatus: 'queued' }), null);
  });
});
