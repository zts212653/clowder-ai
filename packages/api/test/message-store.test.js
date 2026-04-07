/**
 * MessageStore Tests
 * 测试内存消息存储
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('MessageStore', () => {
  test('append() stores message and returns with id', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const store = new MessageStore();
    const result = store.append({
      userId: 'user-1',
      catId: null,
      content: 'Hello',
      mentions: [],
      timestamp: Date.now(),
    });

    assert.ok(typeof result.id === 'string');
    assert.ok(result.id.length > 0);
    assert.equal(result.content, 'Hello');
    assert.equal(result.userId, 'user-1');
    assert.equal(store.size, 1);
  });

  test('getRecent() returns last N messages', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const store = new MessageStore();

    for (let i = 0; i < 5; i++) {
      store.append({
        userId: 'user-1',
        catId: null,
        content: `Message ${i}`,
        mentions: [],
        timestamp: i,
      });
    }

    const recent = store.getRecent(3);
    assert.equal(recent.length, 3);
    assert.equal(recent[0].content, 'Message 2');
    assert.equal(recent[1].content, 'Message 3');
    assert.equal(recent[2].content, 'Message 4');
  });

  test('getMentionsFor() returns messages mentioning a specific cat', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const store = new MessageStore();

    store.append({
      userId: 'user-1',
      catId: null,
      content: '@opus help',
      mentions: ['opus'],
      timestamp: 1,
    });
    store.append({
      userId: 'user-1',
      catId: null,
      content: '@codex review',
      mentions: ['codex'],
      timestamp: 2,
    });
    store.append({
      userId: 'user-1',
      catId: null,
      content: '@opus and @codex',
      mentions: ['opus', 'codex'],
      timestamp: 3,
    });

    const opusMentions = store.getMentionsFor('opus', 10);
    assert.equal(opusMentions.length, 2);
    assert.equal(opusMentions[0].content, '@opus help');
    assert.equal(opusMentions[1].content, '@opus and @codex');

    const codexMentions = store.getMentionsFor('codex', 10);
    assert.equal(codexMentions.length, 2);
  });

  test('truncates when exceeding maxMessages', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const store = new MessageStore({ maxMessages: 5 });

    for (let i = 0; i < 8; i++) {
      store.append({
        userId: 'user-1',
        catId: null,
        content: `Message ${i}`,
        mentions: [],
        timestamp: i,
      });
    }

    assert.equal(store.size, 5);
    const recent = store.getRecent(10);
    assert.equal(recent[0].content, 'Message 3');
    assert.equal(recent[4].content, 'Message 7');
  });

  test('getRecent() filters by userId when provided', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const store = new MessageStore();
    store.append({ userId: 'user-1', catId: null, content: 'A from user-1', mentions: [], timestamp: 1 });
    store.append({ userId: 'user-2', catId: null, content: 'B from user-2', mentions: [], timestamp: 2 });
    store.append({ userId: 'user-1', catId: 'opus', content: 'C from user-1 opus', mentions: [], timestamp: 3 });

    const user1 = store.getRecent(10, 'user-1');
    assert.equal(user1.length, 2);
    assert.equal(user1[0].content, 'A from user-1');
    assert.equal(user1[1].content, 'C from user-1 opus');

    const user2 = store.getRecent(10, 'user-2');
    assert.equal(user2.length, 1);
    assert.equal(user2[0].content, 'B from user-2');

    // Without userId returns all
    const all = store.getRecent(10);
    assert.equal(all.length, 3);
  });

  test('getMentionsFor() filters by userId when provided', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const store = new MessageStore();
    store.append({ userId: 'user-1', catId: null, content: '@opus from user-1', mentions: ['opus'], timestamp: 1 });
    store.append({ userId: 'user-2', catId: null, content: '@opus from user-2', mentions: ['opus'], timestamp: 2 });

    const user1Mentions = store.getMentionsFor('opus', 10, 'user-1');
    assert.equal(user1Mentions.length, 1);
    assert.equal(user1Mentions[0].content, '@opus from user-1');

    // Without userId returns all
    const allMentions = store.getMentionsFor('opus', 10);
    assert.equal(allMentions.length, 2);
  });

  test('getMentionsFor() filters by threadId when provided', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const store = new MessageStore();
    store.append({
      userId: 'user-1',
      catId: null,
      content: '@opus in thread-A',
      mentions: ['opus'],
      timestamp: 1,
      threadId: 'thread-A',
    });
    store.append({
      userId: 'user-1',
      catId: null,
      content: '@opus in thread-B',
      mentions: ['opus'],
      timestamp: 2,
      threadId: 'thread-B',
    });
    store.append({
      userId: 'user-1',
      catId: null,
      content: '@opus in thread-A again',
      mentions: ['opus'],
      timestamp: 3,
      threadId: 'thread-A',
    });

    // With threadId: only thread-A mentions
    const threadA = store.getMentionsFor('opus', 10, undefined, 'thread-A');
    assert.equal(threadA.length, 2);
    assert.equal(threadA[0].content, '@opus in thread-A');
    assert.equal(threadA[1].content, '@opus in thread-A again');

    // With threadId: only thread-B mentions
    const threadB = store.getMentionsFor('opus', 10, undefined, 'thread-B');
    assert.equal(threadB.length, 1);
    assert.equal(threadB[0].content, '@opus in thread-B');

    // Without threadId: all mentions
    const all = store.getMentionsFor('opus', 10);
    assert.equal(all.length, 3);
  });

  test('getMentionsFor() combines userId and threadId filters', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const store = new MessageStore();
    store.append({
      userId: 'user-1',
      catId: null,
      content: '@opus u1-tA',
      mentions: ['opus'],
      timestamp: 1,
      threadId: 'thread-A',
    });
    store.append({
      userId: 'user-2',
      catId: null,
      content: '@opus u2-tA',
      mentions: ['opus'],
      timestamp: 2,
      threadId: 'thread-A',
    });
    store.append({
      userId: 'user-1',
      catId: null,
      content: '@opus u1-tB',
      mentions: ['opus'],
      timestamp: 3,
      threadId: 'thread-B',
    });

    // userId + threadId: only user-1 in thread-A
    const filtered = store.getMentionsFor('opus', 10, 'user-1', 'thread-A');
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].content, '@opus u1-tA');
  });

  test('getBefore() returns messages before timestamp', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const store = new MessageStore();
    store.append({ userId: 'u', catId: null, content: 'old', mentions: [], timestamp: 100 });
    store.append({ userId: 'u', catId: null, content: 'mid', mentions: [], timestamp: 200 });
    store.append({ userId: 'u', catId: null, content: 'new', mentions: [], timestamp: 300 });

    const before = store.getBefore(300, 10);
    assert.equal(before.length, 2);
    assert.equal(before[0].content, 'old');
    assert.equal(before[1].content, 'mid');
  });

  test('getBefore() filters by userId', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const store = new MessageStore();
    store.append({ userId: 'alice', catId: null, content: 'alice old', mentions: [], timestamp: 100 });
    store.append({ userId: 'bob', catId: null, content: 'bob old', mentions: [], timestamp: 150 });
    store.append({ userId: 'alice', catId: null, content: 'alice new', mentions: [], timestamp: 200 });

    const before = store.getBefore(200, 10, 'alice');
    assert.equal(before.length, 1);
    assert.equal(before[0].content, 'alice old');
  });

  test('empty store returns empty arrays', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const store = new MessageStore();
    assert.deepEqual(store.getRecent(), []);
    assert.deepEqual(store.getMentionsFor('opus'), []);
    assert.equal(store.size, 0);
  });

  test('append() defaults threadId to "default"', async () => {
    const { MessageStore, DEFAULT_THREAD_ID } = await import(
      '../dist/domains/cats/services/stores/ports/MessageStore.js'
    );

    const store = new MessageStore();
    const msg = store.append({
      userId: 'u1',
      catId: null,
      content: 'hi',
      mentions: [],
      timestamp: 1,
    });
    assert.equal(msg.threadId, DEFAULT_THREAD_ID);
  });

  test('append() preserves explicit threadId', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const store = new MessageStore();
    const msg = store.append({
      userId: 'u1',
      catId: null,
      content: 'hi',
      mentions: [],
      timestamp: 1,
      threadId: 'thread-abc',
    });
    assert.equal(msg.threadId, 'thread-abc');
  });

  test('append() with same idempotencyKey returns existing message', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const store = new MessageStore();
    const first = store.append({
      userId: 'u1',
      catId: null,
      content: 'kickoff',
      mentions: [],
      timestamp: 10,
      threadId: 'thread-abc',
      idempotencyKey: 'backlog:b1:attempt:a1',
    });

    const second = store.append({
      userId: 'u1',
      catId: null,
      content: 'kickoff retried',
      mentions: [],
      timestamp: 20,
      threadId: 'thread-abc',
      idempotencyKey: 'backlog:b1:attempt:a1',
    });

    assert.equal(first.id, second.id);
    assert.equal(store.size, 1);
    assert.equal(second.content, 'kickoff');
  });

  test('getByThread() returns messages for a specific thread', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const store = new MessageStore();
    store.append({ userId: 'u', catId: null, content: 'A', mentions: [], timestamp: 1, threadId: 'th-1' });
    store.append({ userId: 'u', catId: null, content: 'B', mentions: [], timestamp: 2, threadId: 'th-2' });
    store.append({ userId: 'u', catId: null, content: 'C', mentions: [], timestamp: 3, threadId: 'th-1' });
    store.append({ userId: 'u', catId: null, content: 'D', mentions: [], timestamp: 4 }); // default thread

    const th1 = store.getByThread('th-1');
    assert.equal(th1.length, 2);
    assert.equal(th1[0].content, 'A');
    assert.equal(th1[1].content, 'C');

    const th2 = store.getByThread('th-2');
    assert.equal(th2.length, 1);
    assert.equal(th2[0].content, 'B');

    const def = store.getByThread('default');
    assert.equal(def.length, 1);
    assert.equal(def[0].content, 'D');
  });

  test('getByThreadBefore() paginates within a thread', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const store = new MessageStore();
    store.append({ userId: 'u', catId: null, content: 'A', mentions: [], timestamp: 100, threadId: 'th-1' });
    store.append({ userId: 'u', catId: null, content: 'B', mentions: [], timestamp: 200, threadId: 'th-1' });
    store.append({ userId: 'u', catId: null, content: 'C', mentions: [], timestamp: 300, threadId: 'th-1' });
    store.append({ userId: 'u', catId: null, content: 'X', mentions: [], timestamp: 250, threadId: 'th-2' }); // different thread

    const before300 = store.getByThreadBefore('th-1', 300, 10);
    assert.equal(before300.length, 2);
    assert.equal(before300[0].content, 'A');
    assert.equal(before300[1].content, 'B');
  });

  test('append() preserves contentBlocks', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const store = new MessageStore();
    const blocks = [
      { type: 'text', text: 'hello' },
      { type: 'image', url: '/uploads/test.png' },
    ];
    const msg = store.append({
      userId: 'u',
      catId: null,
      content: 'hello',
      mentions: [],
      timestamp: 1,
      contentBlocks: blocks,
    });
    assert.deepEqual(msg.contentBlocks, blocks);
  });

  test('append() preserves toolEvents', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const store = new MessageStore();
    const toolEvents = [
      { id: 'tool-1', type: 'tool_use', label: 'opus → Read', detail: '{"path":"/a.ts"}', timestamp: 1000 },
      { id: 'toolr-1', type: 'tool_result', label: 'opus ← result', detail: 'file content...', timestamp: 1001 },
    ];
    const msg = store.append({
      userId: 'u',
      catId: 'opus',
      content: 'done',
      mentions: [],
      timestamp: 1,
      toolEvents,
    });
    assert.deepEqual(msg.toolEvents, toolEvents);

    // Verify toolEvents round-trip via getByThread
    const thread = store.getByThread(msg.threadId);
    assert.equal(thread.length, 1);
    assert.deepEqual(thread[0].toolEvents, toolEvents);
  });

  test('hardDelete() clears toolEvents', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const store = new MessageStore();
    const msg = store.append({
      userId: 'u',
      catId: 'opus',
      content: 'hi',
      mentions: [],
      timestamp: 1,
      toolEvents: [{ id: 't1', type: 'tool_use', label: 'test', timestamp: 1 }],
    });
    assert.ok(msg.toolEvents);

    const deleted = store.hardDelete(msg.id, 'admin');
    assert.ok(deleted);
    assert.equal(deleted.toolEvents, undefined);
  });

  test('hardDelete() clears thinking (F045 security)', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const store = new MessageStore();
    const msg = store.append({
      userId: 'u',
      catId: 'opus',
      content: 'response',
      mentions: [],
      timestamp: 1,
      thinking: 'secret reasoning that must not survive hard delete',
    });
    assert.equal(msg.thinking, 'secret reasoning that must not survive hard delete');

    const deleted = store.hardDelete(msg.id, 'admin');
    assert.ok(deleted);
    assert.equal(deleted.thinking, undefined, 'thinking must be cleared on hard delete');
  });

  // --- System-user visibility (scheduler messages must be visible to all) ---

  test('getByThread() includes scheduler messages when filtering by userId', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const store = new MessageStore();
    store.append({ userId: 'user-1', catId: 'opus', content: 'hello', mentions: [], timestamp: 1, threadId: 'th' });
    store.append({
      userId: 'scheduler',
      catId: 'system',
      content: '[定时任务] reminder',
      mentions: [],
      timestamp: 2,
      threadId: 'th',
    });
    store.append({ userId: 'user-2', catId: null, content: 'other user', mentions: [], timestamp: 3, threadId: 'th' });

    const msgs = store.getByThread('th', 50, 'user-1');
    assert.equal(msgs.length, 2, 'should include own message + scheduler message');
    assert.equal(msgs[0].content, 'hello');
    assert.equal(msgs[1].content, '[定时任务] reminder');
  });

  test('getByThreadBefore() includes scheduler messages when filtering by userId', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const store = new MessageStore();
    store.append({ userId: 'user-1', catId: 'opus', content: 'hello', mentions: [], timestamp: 100, threadId: 'th' });
    store.append({
      userId: 'scheduler',
      catId: 'system',
      content: '[定时任务] reminder',
      mentions: [],
      timestamp: 200,
      threadId: 'th',
    });
    store.append({ userId: 'user-1', catId: null, content: 'follow-up', mentions: [], timestamp: 300, threadId: 'th' });

    const msgs = store.getByThreadBefore('th', 350, 50, undefined, 'user-1');
    assert.equal(msgs.length, 3, 'should include all own messages + scheduler');
    assert.equal(msgs[1].userId, 'scheduler');
  });

  test('getByThreadAfter() includes scheduler messages when filtering by userId', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const store = new MessageStore();
    const first = store.append({
      userId: 'user-1',
      catId: null,
      content: 'start',
      mentions: [],
      timestamp: 100,
      threadId: 'th',
    });
    store.append({
      userId: 'scheduler',
      catId: 'system',
      content: '[定时任务] digest',
      mentions: [],
      timestamp: 200,
      threadId: 'th',
    });
    store.append({ userId: 'user-2', catId: null, content: 'other', mentions: [], timestamp: 300, threadId: 'th' });

    const msgs = store.getByThreadAfter('th', first.id, undefined, 'user-1');
    assert.equal(msgs.length, 1, 'should include scheduler message after cursor');
    assert.equal(msgs[0].userId, 'scheduler');
  });

  test('P1: forged userId=scheduler with non-system catId does NOT bypass filter', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const store = new MessageStore();
    store.append({ userId: 'user-1', catId: 'opus', content: 'legit', mentions: [], timestamp: 1, threadId: 'th' });
    store.append({
      userId: 'scheduler',
      catId: 'opus',
      content: 'forged system message',
      mentions: [],
      timestamp: 2,
      threadId: 'th',
    });

    const msgs = store.getByThread('th', 50, 'user-1');
    assert.equal(msgs.length, 1, 'forged scheduler message must NOT bypass userId filter');
    assert.equal(msgs[0].content, 'legit');
  });

  test('getByThread() includes system messages persisted with catId=null when filtering by userId', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const store = new MessageStore();
    store.append({ userId: 'user-1', catId: null, content: 'hello', mentions: [], timestamp: 1, threadId: 'th' });
    store.append({
      userId: 'system',
      catId: null,
      content: 'Error: stream_idle_stall: Gemini stopped responding',
      mentions: [],
      timestamp: 2,
      threadId: 'th',
    });

    const msgs = store.getByThread('th', 50, 'user-1');
    assert.equal(msgs.length, 2, 'should include own message + persisted system error');
    assert.equal(msgs[1].userId, 'system');
    assert.equal(msgs[1].catId, null);
  });
});
