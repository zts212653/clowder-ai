/**
 * ThreadStore Tests
 * 测试对话管理：创建、查询、参与者追踪、LRU 淘汰
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('ThreadStore', () => {
  test('create() returns a thread with generated id', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    const thread = store.create('user-1', 'My thread');

    assert.ok(thread.id.startsWith('thread_'));
    assert.equal(thread.title, 'My thread');
    assert.equal(thread.createdBy, 'user-1');
    assert.deepEqual(thread.participants, []);
    assert.ok(thread.createdAt > 0);
  });

  test('get() returns null for nonexistent thread', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    assert.equal(store.get('nonexistent'), null);
  });

  test('get() auto-creates default thread', async () => {
    const { ThreadStore, DEFAULT_THREAD_ID } = await import(
      '../dist/domains/cats/services/stores/ports/ThreadStore.js'
    );

    const store = new ThreadStore();
    const thread = store.get(DEFAULT_THREAD_ID);

    assert.ok(thread);
    assert.equal(thread.id, DEFAULT_THREAD_ID);
    assert.equal(thread.createdBy, 'system');
    assert.deepEqual(thread.participants, []);
  });

  test('list() returns user threads + default, sorted by lastActiveAt desc', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    const t1 = store.create('alice', 'Thread 1');
    const t2 = store.create('alice', 'Thread 2');
    store.create('bob', 'Bob thread'); // different user

    // Access default to auto-create it
    store.get('default');

    const aliceThreads = store.list('alice');
    // Should include alice's threads + default
    assert.ok(aliceThreads.length >= 2);
    assert.ok(aliceThreads.some((t) => t.id === t1.id));
    assert.ok(aliceThreads.some((t) => t.id === t2.id));
    // Default always included
    assert.ok(aliceThreads.some((t) => t.id === 'default'));
  });

  test('addParticipants() adds unique cats', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    const thread = store.create('user-1');

    store.addParticipants(thread.id, ['opus', 'codex']);
    assert.deepEqual(store.getParticipants(thread.id), ['opus', 'codex']);

    // Adding opus again should not duplicate
    store.addParticipants(thread.id, ['opus', 'gemini']);
    assert.deepEqual(store.getParticipants(thread.id), ['opus', 'codex', 'gemini']);
  });

  test('getParticipants() returns empty array for nonexistent thread', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    assert.deepEqual(store.getParticipants('nonexistent'), []);
  });

  test('set/consumeMentionRoutingFeedback() is one-shot per thread+cat', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    const thread = store.create('user-1', 'Feedback');

    store.setMentionRoutingFeedback(thread.id, 'codex', {
      sourceMessageId: 'msg-1',
      sourceTimestamp: 1700000000000,
      items: [{ targetCatId: 'opus', reason: 'no_action' }],
    });

    const first = store.consumeMentionRoutingFeedback(thread.id, 'codex');
    assert.ok(first, 'first consume should return feedback');
    assert.equal(first?.sourceMessageId, 'msg-1');
    assert.deepEqual(first?.items, [{ targetCatId: 'opus', reason: 'no_action' }]);

    const second = store.consumeMentionRoutingFeedback(thread.id, 'codex');
    assert.equal(second, null, 'second consume should clear one-shot feedback');
  });

  test('updateLastActive() refreshes timestamp and LRU position', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    const t1 = store.create('user-1', 'Old');
    const originalTime = t1.lastActiveAt;

    // Wait a ms to ensure timestamp changes
    await new Promise((r) => setTimeout(r, 5));
    store.updateLastActive(t1.id);

    const updated = store.get(t1.id);
    assert.ok(updated.lastActiveAt >= originalTime);
  });

  test('updateMentionActionabilityMode() stores relaxed and clears on strict', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    const thread = store.create('user-1', 'Mention mode');

    store.updateMentionActionabilityMode(thread.id, 'relaxed');
    assert.equal(store.get(thread.id)?.mentionActionabilityMode, 'relaxed');

    store.updateMentionActionabilityMode(thread.id, 'strict');
    assert.equal(store.get(thread.id)?.mentionActionabilityMode, undefined);
  });

  test('delete() removes thread, but not default', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    const thread = store.create('user-1', 'Deletable');
    assert.ok(store.get(thread.id));

    const deleted = store.delete(thread.id);
    assert.equal(deleted, true);
    assert.equal(store.get(thread.id), null);

    // Cannot delete default
    store.get('default'); // auto-create
    const deletedDefault = store.delete('default');
    assert.equal(deletedDefault, false);
    assert.ok(store.get('default'));
  });

  test('LRU eviction when exceeding maxThreads', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore({ maxThreads: 3 });

    const t1 = store.create('u', 'T1');
    const t2 = store.create('u', 'T2');
    const t3 = store.create('u', 'T3');
    // Store is at capacity (3). Creating a 4th should evict t1 (oldest).
    const t4 = store.create('u', 'T4');

    assert.equal(store.size, 3);
    assert.equal(store.get(t1.id), null); // evicted (oldest)
    assert.ok(store.get(t2.id));
    assert.ok(store.get(t3.id));
    assert.ok(store.get(t4.id));
  });

  test('LRU eviction skips default thread and evicts next oldest (regression)', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore({ maxThreads: 3 });

    // Access default first — it becomes the oldest key in the Map
    store.get('default');
    const t1 = store.create('u', 'T1');
    const t2 = store.create('u', 'T2');
    // Now: default, t1, t2 → size=3, at capacity

    // Creating t3 should evict t1 (oldest non-default), NOT break
    const t3 = store.create('u', 'T3');

    assert.equal(store.size, 3); // was 4 before fix
    assert.ok(store.get('default')); // protected
    assert.equal(store.get(t1.id), null); // evicted (oldest non-default)
    assert.ok(store.get(t2.id));
    assert.ok(store.get(t3.id));

    // Creating t4 should evict t2
    const t4 = store.create('u', 'T4');
    assert.equal(store.size, 3);
    assert.equal(store.get(t2.id), null);
    assert.ok(store.get(t3.id));
    assert.ok(store.get(t4.id));
  });

  test('create() with no title sets null', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    const thread = store.create('user-1');
    assert.equal(thread.title, null);
  });

  test('create() defaults projectPath to "default"', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    const thread = store.create('user-1', 'My thread');
    assert.equal(thread.projectPath, 'default');
  });

  test('create() with explicit projectPath sets it', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    const thread = store.create('user-1', 'In project', '/home/user/projects/cat-cafe');
    assert.equal(thread.projectPath, '/home/user/projects/cat-cafe');
  });

  test('get() auto-created default thread has projectPath "default"', async () => {
    const { ThreadStore, DEFAULT_THREAD_ID } = await import(
      '../dist/domains/cats/services/stores/ports/ThreadStore.js'
    );

    const store = new ThreadStore();
    const thread = store.get(DEFAULT_THREAD_ID);
    assert.equal(thread.projectPath, 'default');
  });

  test('listByProject() returns only threads in that project', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    store.create('alice', 'In cat-cafe', '/projects/cat-cafe');
    store.create('alice', 'Also cat-cafe', '/projects/cat-cafe');
    store.create('alice', 'In relay', '/projects/relay');
    store.create('alice', 'No project'); // defaults to 'default'

    const catCafeThreads = store.listByProject('alice', '/projects/cat-cafe');
    assert.equal(catCafeThreads.length, 2);
    assert.ok(catCafeThreads.every((t) => t.projectPath === '/projects/cat-cafe'));

    const relayThreads = store.listByProject('alice', '/projects/relay');
    assert.equal(relayThreads.length, 1);

    // 'default' project includes auto-created default thread + thread with no explicit project
    store.get('default'); // trigger auto-create
    const defaultThreads = store.listByProject('alice', 'default');
    assert.ok(defaultThreads.length >= 1);
  });

  test('updatePin() sets pinned=true and pinnedAt timestamp', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    const thread = store.create('user-1', 'Pinnable');

    assert.equal(thread.pinned, undefined);
    assert.equal(thread.pinnedAt, undefined);

    store.updatePin(thread.id, true);
    const updated = store.get(thread.id);
    assert.equal(updated.pinned, true);
    assert.ok(updated.pinnedAt > 0);
  });

  test('updatePin(false) clears pinned and sets pinnedAt to null', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    const thread = store.create('user-1', 'Pinnable');

    store.updatePin(thread.id, true);
    assert.equal(store.get(thread.id).pinned, true);

    store.updatePin(thread.id, false);
    const updated = store.get(thread.id);
    assert.equal(updated.pinned, false);
    assert.equal(updated.pinnedAt, null);
  });

  test('updateFavorite() sets favorited=true and favoritedAt timestamp', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    const thread = store.create('user-1', 'Fav');

    store.updateFavorite(thread.id, true);
    const updated = store.get(thread.id);
    assert.equal(updated.favorited, true);
    assert.ok(updated.favoritedAt > 0);
  });

  test('updateFavorite(false) clears favorited and sets favoritedAt to null', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    const thread = store.create('user-1', 'Fav');

    store.updateFavorite(thread.id, true);
    store.updateFavorite(thread.id, false);
    const updated = store.get(thread.id);
    assert.equal(updated.favorited, false);
    assert.equal(updated.favoritedAt, null);
  });

  test('updatePin() does nothing for nonexistent thread', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    // Should not throw
    store.updatePin('nonexistent', true);
  });

  test('updateFavorite() does nothing for nonexistent thread', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    // Should not throw
    store.updateFavorite('nonexistent', true);
  });

  // F032 Phase C: Thread activity tests
  test('getParticipantsWithActivity() returns empty for thread with no participants', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    const thread = store.create('user-1', 'Test');
    const activity = store.getParticipantsWithActivity(thread.id);
    assert.deepEqual(activity, []);
  });

  // Cloud Codex P1 fix: Tests now use updateParticipantActivity for activity tracking
  test('getParticipantsWithActivity() tracks activity when updateParticipantActivity called', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    const thread = store.create('user-1', 'Test');

    // Simulate: opus sends a message
    store.updateParticipantActivity(thread.id, 'opus');
    const activity1 = store.getParticipantsWithActivity(thread.id);
    assert.equal(activity1.length, 1);
    assert.equal(activity1[0].catId, 'opus');
    assert.equal(activity1[0].messageCount, 1);
    assert.ok(activity1[0].lastMessageAt > 0);

    // Simulate: codex sends a message
    store.updateParticipantActivity(thread.id, 'codex');
    const activity2 = store.getParticipantsWithActivity(thread.id);
    assert.equal(activity2.length, 2);
  });

  test('getParticipantsWithActivity() increments messageCount on repeated activity', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    const thread = store.create('user-1', 'Test');

    // Simulate: opus sends 3 messages
    store.updateParticipantActivity(thread.id, 'opus');
    store.updateParticipantActivity(thread.id, 'opus');
    store.updateParticipantActivity(thread.id, 'opus');

    const activity = store.getParticipantsWithActivity(thread.id);
    assert.equal(activity.length, 1);
    assert.equal(activity[0].catId, 'opus');
    assert.equal(activity[0].messageCount, 3);
  });

  test('getParticipantsWithActivity() sorts by lastMessageAt descending', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    const thread = store.create('user-1', 'Test');

    // Simulate messages in order: opus, codex, gemini
    store.updateParticipantActivity(thread.id, 'opus');
    await new Promise((r) => setTimeout(r, 5)); // Small delay to ensure different timestamps
    store.updateParticipantActivity(thread.id, 'codex');
    await new Promise((r) => setTimeout(r, 5));
    store.updateParticipantActivity(thread.id, 'gemini');

    // Activity should be sorted: gemini (most recent), codex, opus (oldest)
    const activity = store.getParticipantsWithActivity(thread.id);
    assert.equal(activity.length, 3);
    assert.equal(activity[0].catId, 'gemini');
    assert.equal(activity[1].catId, 'codex');
    assert.equal(activity[2].catId, 'opus');
  });

  // Cloud Codex P1: addParticipants should NOT update activity
  test('addParticipants() does NOT update messageCount (activity only via updateParticipantActivity)', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    const thread = store.create('user-1', 'Test');

    // Add participants — this should NOT create activity records
    store.addParticipants(thread.id, ['opus', 'codex']);

    // Activity should be zero for all participants (no messages sent yet)
    const activity = store.getParticipantsWithActivity(thread.id);
    assert.equal(activity.length, 2);
    assert.equal(activity[0].messageCount, 0, 'messageCount should be 0 before any message');
    assert.equal(activity[1].messageCount, 0, 'messageCount should be 0 before any message');
  });

  // F032 P1-2 fix: updateParticipantActivity tests
  test('updateParticipantActivity() updates lastMessageAt for existing participant', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    const thread = store.create('user-1', 'Test');

    // Add participant first
    store.addParticipants(thread.id, ['opus']);
    const before = store.getParticipantsWithActivity(thread.id);
    const oldTimestamp = before[0].lastMessageAt;

    // Wait a bit and update activity
    await new Promise((r) => setTimeout(r, 10));
    store.updateParticipantActivity(thread.id, 'opus');

    const after = store.getParticipantsWithActivity(thread.id);
    assert.ok(after[0].lastMessageAt > oldTimestamp, 'lastMessageAt should be updated');
    // Cloud Codex P1 fix: addParticipants no longer sets messageCount, so first update = 1
    assert.equal(after[0].messageCount, 1, 'messageCount should be 1 after first updateParticipantActivity');
  });

  test('updateParticipantActivity() adds new participant if not exists', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    const thread = store.create('user-1', 'Test');

    // Update activity for cat not in participants list
    store.updateParticipantActivity(thread.id, 'codex');

    const participants = store.getParticipants(thread.id);
    assert.ok(participants.includes('codex'), 'codex should be added to participants');

    const activity = store.getParticipantsWithActivity(thread.id);
    assert.equal(activity.length, 1);
    assert.equal(activity[0].catId, 'codex');
    assert.equal(activity[0].messageCount, 1);
  });

  test('updateParticipantActivity() re-sorts participants by activity', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    const thread = store.create('user-1', 'Test');

    // Cloud Codex P1 fix: Use updateParticipantActivity instead of addParticipants for activity setup
    // Simulate: opus sends message first, then codex sends message
    store.updateParticipantActivity(thread.id, 'opus');
    await new Promise((r) => setTimeout(r, 5));
    store.updateParticipantActivity(thread.id, 'codex');

    // codex should be first (most recent message)
    let activity = store.getParticipantsWithActivity(thread.id);
    assert.equal(activity[0].catId, 'codex');
    assert.equal(activity[1].catId, 'opus');

    // Update opus activity — now opus should be first
    await new Promise((r) => setTimeout(r, 5));
    store.updateParticipantActivity(thread.id, 'opus');

    activity = store.getParticipantsWithActivity(thread.id);
    assert.equal(activity[0].catId, 'opus', 'opus should now be first after activity update');
    assert.equal(activity[1].catId, 'codex');
  });

  // Cloud Codex R3 P2: Activity should be cleaned up when thread is deleted
  test('delete() cleans up activity data to prevent memory leak', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    const thread = store.create('user-1', 'Test');

    // Create activity for multiple cats
    store.updateParticipantActivity(thread.id, 'opus');
    store.updateParticipantActivity(thread.id, 'codex');

    let activity = store.getParticipantsWithActivity(thread.id);
    assert.equal(activity.length, 2, 'Should have 2 participants with activity');

    // Delete the thread
    const deleted = store.delete(thread.id);
    assert.equal(deleted, true);

    // Activity should be cleaned up
    activity = store.getParticipantsWithActivity(thread.id);
    assert.equal(activity.length, 0, 'Activity should be cleaned up after delete');
  });

  test('linkBacklogItem() stores reverse backlog reference on thread', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    const thread = store.create('user-1', 'Backlog dispatch target');

    store.linkBacklogItem(thread.id, 'blg_123');
    const updated = store.get(thread.id);
    assert.equal(updated?.backlogItemId, 'blg_123');
  });

  // ── F079: Voting State ──

  test('getVotingState() returns null when no vote', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const store = new ThreadStore();
    const thread = store.create('user-1', 'Vote test');
    assert.equal(store.getVotingState(thread.id), null);
  });

  test('updateVotingState() stores and retrieves voting state', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const store = new ThreadStore();
    const thread = store.create('user-1', 'Vote test');

    const state = {
      v: 1,
      question: 'Best cat?',
      options: ['opus', 'codex'],
      votes: {},
      anonymous: false,
      deadline: Date.now() + 60000,
      createdBy: 'user-1',
      status: 'active',
    };
    store.updateVotingState(thread.id, state);

    const retrieved = store.getVotingState(thread.id);
    assert.equal(retrieved?.question, 'Best cat?');
    assert.deepEqual(retrieved?.options, ['opus', 'codex']);
  });

  test('updateVotingState(null) clears voting state', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const store = new ThreadStore();
    const thread = store.create('user-1', 'Vote test');

    store.updateVotingState(thread.id, {
      v: 1,
      question: 'q?',
      options: ['a', 'b'],
      votes: {},
      anonymous: false,
      deadline: Date.now() + 60000,
      createdBy: 'user-1',
      status: 'active',
    });
    assert.ok(store.getVotingState(thread.id));

    store.updateVotingState(thread.id, null);
    assert.equal(store.getVotingState(thread.id), null);
  });

  // ── #813: Pending continuation per-cat isolation ──

  test('#813: setPendingContinuation + consumePendingContinuation per-cat isolation', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const store = new ThreadStore();
    const thread = store.create('user-1', 'cont-test');

    const capsuleA = { summary: 'cat A context' };
    const capsuleB = { summary: 'cat B context' };

    // Write continuation for two cats (same user)
    store.setPendingContinuation(thread.id, 'catA', 'user-1', { capsule: capsuleA, createdAt: 1000 });
    store.setPendingContinuation(thread.id, 'catB', 'user-1', { capsule: capsuleB, createdAt: 2000 });

    // Consume catA — catB should remain
    const resultA = store.consumePendingContinuation(thread.id, 'catA', 'user-1');
    assert.ok(resultA);
    assert.deepEqual(resultA.capsule, capsuleA);
    assert.equal(resultA.createdAt, 1000);

    // catB still present
    const resultB = store.consumePendingContinuation(thread.id, 'catB', 'user-1');
    assert.ok(resultB);
    assert.deepEqual(resultB.capsule, capsuleB);
    assert.equal(resultB.createdAt, 2000);
  });

  test('#813: consumePendingContinuation returns null for non-existent cat', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const store = new ThreadStore();
    const thread = store.create('user-1', 'cont-test-2');

    store.setPendingContinuation(thread.id, 'catA', 'user-1', { capsule: { x: 1 }, createdAt: 1000 });

    const result = store.consumePendingContinuation(thread.id, 'catX', 'user-1');
    assert.equal(result, null);

    // catA still available
    const resultA = store.consumePendingContinuation(thread.id, 'catA', 'user-1');
    assert.ok(resultA);
  });

  test('#813: consumePendingContinuation is one-shot (second call returns null)', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const store = new ThreadStore();
    const thread = store.create('user-1', 'cont-test-3');

    store.setPendingContinuation(thread.id, 'catA', 'user-1', { capsule: { data: 'once' }, createdAt: 500 });

    const first = store.consumePendingContinuation(thread.id, 'catA', 'user-1');
    assert.ok(first);
    const second = store.consumePendingContinuation(thread.id, 'catA', 'user-1');
    assert.equal(second, null);
  });

  // Cloud Codex P1: cross-user isolation — user B must not consume user A's continuation
  test('#813: pending continuation is scoped per-user (cross-user isolation)', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const store = new ThreadStore();
    const thread = store.create('user-1', 'cont-test-user-scope');

    const capsuleUserA = { summary: 'user A sealed context' };
    store.setPendingContinuation(thread.id, 'catA', 'user-1', { capsule: capsuleUserA, createdAt: 1000 });

    // user-2 consuming same cat in same thread should get null
    const resultB = store.consumePendingContinuation(thread.id, 'catA', 'user-2');
    assert.equal(resultB, null);

    // user-1 can still consume their own
    const resultA = store.consumePendingContinuation(thread.id, 'catA', 'user-1');
    assert.ok(resultA);
    assert.deepEqual(resultA.capsule, capsuleUserA);
  });

  // #836: Reborn session strategy tests
  test('#836: updateMemberSessionStrategy sets and clears reborn', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const store = new ThreadStore();
    const thread = store.create('user-1', 'reborn-test');

    // Initially no strategy set — isRebornSession returns false
    assert.equal(store.isRebornSession(thread.id, 'catA'), false);

    // Set reborn strategy
    store.updateMemberSessionStrategy(thread.id, 'catA', 'reborn');
    assert.equal(store.isRebornSession(thread.id, 'catA'), true);

    // Other cats not affected
    assert.equal(store.isRebornSession(thread.id, 'catB'), false);

    // Clear by setting null (removes override)
    store.updateMemberSessionStrategy(thread.id, 'catA', null);
    assert.equal(store.isRebornSession(thread.id, 'catA'), false);

    // Verify container is cleaned up
    const updated = store.get(thread.id);
    assert.equal(updated.memberSessionStrategy, undefined);
  });

  test('#836: resume strategy is treated as default (not reborn)', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const store = new ThreadStore();
    const thread = store.create('user-1', 'resume-test');

    // Explicitly setting 'resume' also clears the override (it's the default)
    store.updateMemberSessionStrategy(thread.id, 'catA', 'reborn');
    assert.equal(store.isRebornSession(thread.id, 'catA'), true);

    store.updateMemberSessionStrategy(thread.id, 'catA', 'resume');
    assert.equal(store.isRebornSession(thread.id, 'catA'), false);
  });

  test('#836: getMemberSessionStrategy exposes coordinator policy read', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const store = new ThreadStore();
    const thread = store.create('user-1', 'strategy-read-test');

    assert.equal(store.getMemberSessionStrategy(thread.id, 'catA', 'user-1'), undefined);
    store.updateMemberSessionStrategy(thread.id, 'catA', 'reborn');
    assert.equal(store.getMemberSessionStrategy(thread.id, 'catA', 'user-1'), 'reborn');
    store.updateMemberSessionStrategy(thread.id, 'catA', 'resume');
    assert.equal(store.getMemberSessionStrategy(thread.id, 'catA', 'user-1'), undefined);
  });

  test('#836: reborn is per-cat-per-thread (isolation)', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const store = new ThreadStore();
    const threadA = store.create('user-1', 'thread-a');
    const threadB = store.create('user-1', 'thread-b');

    // Set reborn for catA in threadA only
    store.updateMemberSessionStrategy(threadA.id, 'catA', 'reborn');

    assert.equal(store.isRebornSession(threadA.id, 'catA'), true);
    // Same cat in different thread — not reborn
    assert.equal(store.isRebornSession(threadB.id, 'catA'), false);
    // Different cat in same thread — not reborn
    assert.equal(store.isRebornSession(threadA.id, 'catB'), false);
  });

  test('#836: isRebornSession returns false for non-existent thread', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const store = new ThreadStore();
    assert.equal(store.isRebornSession('ghost-thread', 'catA'), false);
  });
});
