/**
 * Callback Bootcamp State Tests
 * POST /api/callbacks/update-bootcamp-state
 *
 * Uses lightweight Fastify injection (no real HTTP server).
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';

describe('Callback Bootcamp State', () => {
  let registry;
  let threadStore;
  let messageStore;
  let socketManager;
  let achievementStore;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { AchievementStore } = await import('../dist/domains/leaderboard/achievement-store.js');

    registry = new InvocationRegistry();
    threadStore = new ThreadStore();
    messageStore = new MessageStore();
    achievementStore = new AchievementStore();
    socketManager = {
      broadcastAgentMessage() {},
      getMessages() {
        return [];
      },
    };
  });

  async function createApp(opts = {}) {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const { leaderboardEventsRoutes } = await import('../dist/routes/leaderboard-events.js');
    const { GameStore } = await import('../dist/domains/leaderboard/game-store.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      threadStore,
      sharedBank: 'cat-cafe-shared',
      ...opts,
    });
    // Register leaderboard events route for achievement pipeline (P2 fix)
    await app.register(leaderboardEventsRoutes, {
      gameStore: new GameStore(),
      achievementStore,
    });
    return app;
  }

  test('returns 401 without valid credentials', async () => {
    const app = await createApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-bootcamp-state',
      headers: { 'x-invocation-id': 'fake-id', 'x-callback-token': 'fake-token' },
      payload: {
        threadId: 'thread-1',
        phase: 'phase-1-intro',
      },
    });

    assert.equal(response.statusCode, 401);
  });

  test('updates phase and leadCat', async () => {
    const app = await createApp();

    // Create a thread with initial bootcamp state
    const thread = await threadStore.create('user-1', '🎓 训练营');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', thread.id);
    await threadStore.updateBootcampState(thread.id, {
      v: 1,
      phase: 'phase-0-select-cat',
      startedAt: 1000,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-bootcamp-state',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        threadId: thread.id,
        phase: 'phase-1-intro',
        leadCat: 'opus',
      },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.bootcampState.phase, 'phase-1-intro');
    assert.equal(body.bootcampState.leadCat, 'opus');
    assert.equal(body.bootcampState.startedAt, 1000); // preserved
  });

  test('preserves existing fields on partial update', async () => {
    const app = await createApp();

    const thread = await threadStore.create('user-1', '🎓 训练营');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', thread.id);
    await threadStore.updateBootcampState(thread.id, {
      v: 1,
      phase: 'phase-3-config-help',
      leadCat: 'opus',
      startedAt: 1000,
    });

    // Only update phase (skip 3.5 allowed), leadCat should be preserved
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-bootcamp-state',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        threadId: thread.id,
        phase: 'phase-4-task-select',
        selectedTaskId: 'Q3',
      },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.bootcampState.phase, 'phase-4-task-select');
    assert.equal(body.bootcampState.leadCat, 'opus'); // preserved
    assert.equal(body.bootcampState.selectedTaskId, 'Q3');
    assert.equal(body.bootcampState.startedAt, 1000); // preserved
  });

  test('returns 404 for non-existent thread', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', 'nonexistent');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-bootcamp-state',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        threadId: 'nonexistent',
        phase: 'phase-1-intro',
      },
    });

    assert.equal(response.statusCode, 404);
  });

  test('returns 400 for invalid phase', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    const thread = await threadStore.create('user-1', '🎓 训练营');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-bootcamp-state',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        threadId: thread.id,
        phase: 'phase-99-invalid',
      },
    });

    assert.equal(response.statusCode, 400);
  });

  test('P1: rejects cross-thread write (invocation bound to thread A, writing thread B)', async () => {
    const app = await createApp();
    const threadA = await threadStore.create('user-1', 'Thread A');
    const threadB = await threadStore.create('user-1', 'Thread B');
    await threadStore.updateBootcampState(threadB.id, {
      v: 1,
      phase: 'phase-0-select-cat',
      startedAt: 1000,
    });

    // Invocation is bound to thread A
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', threadA.id);

    // Try to write to thread B — should be rejected
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-bootcamp-state',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        threadId: threadB.id,
        phase: 'phase-11-farewell',
      },
    });

    assert.equal(response.statusCode, 403);

    // Verify thread B state was NOT modified
    const threadBAfter = await threadStore.get(threadB.id);
    assert.equal(threadBAfter.bootcampState.phase, 'phase-0-select-cat');
  });

  test('P1: rejects default-thread invocation writing another thread', async () => {
    const app = await createApp();
    const threadB = await threadStore.create('user-1', 'Thread B');
    await threadStore.updateBootcampState(threadB.id, {
      v: 1,
      phase: 'phase-0-select-cat',
      startedAt: 1000,
    });

    // Invocation with default thread (no threadId passed)
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    // Try to write thread B — should be rejected
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-bootcamp-state',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        threadId: threadB.id,
        phase: 'phase-11-farewell',
      },
    });

    assert.equal(response.statusCode, 403);
    const after = await threadStore.get(threadB.id);
    assert.equal(after.bootcampState.phase, 'phase-0-select-cat');
  });

  test('P2: ignores stale invocation (superseded by newer invocation)', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', '🎓 训练营');
    await threadStore.updateBootcampState(thread.id, {
      v: 1,
      phase: 'phase-0-select-cat',
      startedAt: 1000,
    });

    // First invocation (will become stale)
    const old = registry.create('user-1', 'opus', thread.id);
    // Second invocation supersedes the first
    registry.create('user-1', 'opus', thread.id);

    // Old invocation tries to write — should be ignored
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-bootcamp-state',
      headers: { 'x-invocation-id': old.invocationId, 'x-callback-token': old.callbackToken },
      payload: {
        threadId: thread.id,
        phase: 'phase-11-farewell',
      },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.status, 'stale_ignored');

    // Verify state was NOT modified
    const after = await threadStore.get(thread.id);
    assert.equal(after.bootcampState.phase, 'phase-0-select-cat');
  });

  test('P1: rejects phase skip (phase-0 → phase-11 directly)', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', '🎓 训练营');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', thread.id);
    await threadStore.updateBootcampState(thread.id, {
      v: 1,
      phase: 'phase-0-select-cat',
      startedAt: 1000,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-bootcamp-state',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { threadId: thread.id, phase: 'phase-11-farewell' },
    });

    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.ok(body.error.includes('Phase skip not allowed'));

    // Verify state was NOT modified
    const after = await threadStore.get(thread.id);
    assert.equal(after.bootcampState.phase, 'phase-0-select-cat');

    // Verify no achievement was emitted
    const unlocked = achievementStore.getUnlocked('user-1');
    assert.equal(unlocked.length, 0, 'No achievements should be unlocked on invalid transition');
  });

  test('P1: rejects backward phase transition', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', '🎓 训练营');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', thread.id);
    await threadStore.updateBootcampState(thread.id, {
      v: 1,
      phase: 'phase-5-kickoff',
      startedAt: 1000,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-bootcamp-state',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { threadId: thread.id, phase: 'phase-2-env-check' },
    });

    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.ok(body.error.includes('must advance forward'));
  });

  test('allows skipping phase-3.5-advanced (optional)', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', '🎓 训练营');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', thread.id);
    await threadStore.updateBootcampState(thread.id, {
      v: 1,
      phase: 'phase-3-config-help',
      startedAt: 1000,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-bootcamp-state',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { threadId: thread.id, phase: 'phase-4-task-select' },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.bootcampState.phase, 'phase-4-task-select');
  });

  test('emits bootcamp-enrolled achievement on phase-1-intro transition', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', '🎓 训练营');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', thread.id);
    await threadStore.updateBootcampState(thread.id, {
      v: 1,
      phase: 'phase-0-select-cat',
      startedAt: 1000,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-bootcamp-state',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { threadId: thread.id, phase: 'phase-1-intro', leadCat: 'opus' },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.unlockedAchievement, 'bootcamp-enrolled');

    // Verify achievement is in the store
    const unlocked = achievementStore.getUnlocked('user-1');
    assert.ok(
      unlocked.some((a) => a.id === 'bootcamp-enrolled'),
      'Should have bootcamp-enrolled achievement',
    );
  });

  test('emits bootcamp-graduated achievement on phase-11-farewell', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', '🎓 训练营');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', thread.id);
    await threadStore.updateBootcampState(thread.id, {
      v: 1,
      phase: 'phase-10-retro',
      leadCat: 'opus',
      startedAt: 1000,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-bootcamp-state',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        threadId: thread.id,
        phase: 'phase-11-farewell',
        completedAt: Date.now(),
      },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.unlockedAchievement, 'bootcamp-graduated');
    assert.equal(body.bootcampState.phase, 'phase-11-farewell');

    const unlocked = achievementStore.getUnlocked('user-1');
    assert.ok(unlocked.some((a) => a.id === 'bootcamp-graduated'));
  });

  test('does not emit achievement for phases without mapping', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', '🎓 训练营');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', thread.id);
    await threadStore.updateBootcampState(thread.id, {
      v: 1,
      phase: 'phase-1-intro',
      leadCat: 'opus',
      startedAt: 1000,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-bootcamp-state',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { threadId: thread.id, phase: 'phase-2-env-check' },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.unlockedAchievement, undefined, 'No achievement for phase-2-env-check');
  });

  test('does not return unlockedAchievement when events pipeline fails', async () => {
    // Create app WITHOUT leaderboard events route → app.inject to /api/leaderboard/events returns 404
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      threadStore,
      sharedBank: 'cat-cafe-shared',
    });
    // Deliberately NOT registering leaderboardEventsRoutes

    const thread = await threadStore.create('user-1', '🎓 训练营');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', thread.id);
    await threadStore.updateBootcampState(thread.id, {
      v: 1,
      phase: 'phase-0-select-cat',
      startedAt: 1000,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-bootcamp-state',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { threadId: thread.id, phase: 'phase-1-intro', leadCat: 'opus' },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    // Phase transition succeeds but achievement NOT reported (events route unavailable)
    assert.equal(body.unlockedAchievement, undefined, 'Should not report achievement when events pipeline fails');
    assert.equal(body.bootcampState.phase, 'phase-1-intro', 'Phase should still advance');
  });

  test('rejects re-submitting same phase (not forward)', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', '🎓 训练营');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', thread.id);
    await threadStore.updateBootcampState(thread.id, {
      v: 1,
      phase: 'phase-1-intro',
      leadCat: 'opus',
      startedAt: 1000,
    });

    // Try to submit same phase again — rejected (not forward)
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-bootcamp-state',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { threadId: thread.id, phase: 'phase-1-intro' },
    });

    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.ok(body.error.includes('must advance forward'));
  });

  test('auto-pins thread when advancing to phase-11-farewell', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', '🎓 训练营');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', thread.id);
    await threadStore.updateBootcampState(thread.id, {
      v: 1,
      phase: 'phase-10-retro',
      leadCat: 'opus',
      startedAt: 1000,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-bootcamp-state',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        threadId: thread.id,
        phase: 'phase-11-farewell',
        completedAt: Date.now(),
      },
    });

    assert.equal(response.statusCode, 200);
    const after = await threadStore.get(thread.id);
    assert.equal(after.bootcampState.phase, 'phase-11-farewell');
    assert.equal(after.pinned, true, 'Thread should be auto-pinned on farewell');
  });
});
