/**
 * GameStore Tests (F101 Task A4)
 * Tests RedisGameStore with optimistic concurrency + single-game-per-thread (KD-15).
 *
 * Run: pnpm --filter @cat-cafe/api test:redis
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

function createTestRuntime(overrides = {}) {
  return {
    gameId: `game-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    threadId: 'thread-test-001',
    gameType: 'werewolf',
    definition: {
      gameType: 'werewolf',
      displayName: 'Werewolf',
      minPlayers: 3,
      maxPlayers: 12,
      roles: [],
      phases: [],
      actions: [],
      winConditions: [],
    },
    seats: [
      { seatId: 'P1', actorType: 'cat', actorId: 'opus', role: 'wolf', alive: true, properties: {} },
      { seatId: 'P2', actorType: 'human', actorId: 'owner', role: 'villager', alive: true, properties: {} },
    ],
    currentPhase: 'lobby',
    round: 0,
    eventLog: [],
    pendingActions: {},
    status: 'playing',
    config: { timeoutMs: 30000, voiceMode: false, humanRole: 'player' },
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('RedisGameStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisGameStore;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisGameStore');

    const storeModule = await import('../dist/domains/cats/services/stores/redis/RedisGameStore.js');
    RedisGameStore = storeModule.RedisGameStore;
    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[game-store.test] Redis unreachable, skipping tests');
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisGameStore(redis);
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, ['game:*']);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['game:*']);
  });

  it('createGame persists to Redis, returns GameRuntime', async (t) => {
    if (!connected) {
      t.skip();
      return;
    }
    const runtime = createTestRuntime();
    const result = await store.createGame(runtime);
    assert.equal(result.gameId, runtime.gameId);
    assert.equal(result.status, 'playing');
  });

  it('getGame loads from Redis', async (t) => {
    if (!connected) {
      t.skip();
      return;
    }
    const runtime = createTestRuntime();
    await store.createGame(runtime);
    const loaded = await store.getGame(runtime.gameId);
    assert.ok(loaded);
    assert.equal(loaded.gameId, runtime.gameId);
    assert.equal(loaded.gameType, 'werewolf');
    assert.equal(loaded.seats.length, 2);
  });

  it('getActiveGame returns active game for thread (KD-15)', async (t) => {
    if (!connected) {
      t.skip();
      return;
    }
    const runtime = createTestRuntime();
    await store.createGame(runtime);
    const active = await store.getActiveGame(runtime.threadId);
    assert.ok(active);
    assert.equal(active.gameId, runtime.gameId);
  });

  it('createGame rejects if thread already has active game (KD-15)', async (t) => {
    if (!connected) {
      t.skip();
      return;
    }
    const runtime1 = createTestRuntime();
    await store.createGame(runtime1);
    const runtime2 = createTestRuntime({ gameId: 'game-duplicate', threadId: runtime1.threadId });
    await assert.rejects(() => store.createGame(runtime2), /already has an active game/);
  });

  it('updateGame with version check (optimistic concurrency)', async (t) => {
    if (!connected) {
      t.skip();
      return;
    }
    const runtime = createTestRuntime();
    await store.createGame(runtime);
    runtime.currentPhase = 'night_wolf';
    runtime.version = 2;
    await store.updateGame(runtime.gameId, runtime);
    const loaded = await store.getGame(runtime.gameId);
    assert.equal(loaded.currentPhase, 'night_wolf');
    assert.equal(loaded.version, 2);
  });

  it('updateGame rejects stale version', async (t) => {
    if (!connected) {
      t.skip();
      return;
    }
    const runtime = createTestRuntime();
    await store.createGame(runtime);
    runtime.currentPhase = 'night_wolf';
    // Don't increment version — should fail
    await assert.rejects(() => store.updateGame(runtime.gameId, runtime), /version conflict/i);
  });

  it('endGame marks as finished and clears active thread mapping', async (t) => {
    if (!connected) {
      t.skip();
      return;
    }
    const runtime = createTestRuntime();
    await store.createGame(runtime);
    await store.endGame(runtime.gameId, 'villager');
    const loaded = await store.getGame(runtime.gameId);
    assert.equal(loaded.status, 'finished');
    assert.equal(loaded.winner, 'villager');
    // No active game on thread after end
    const active = await store.getActiveGame(runtime.threadId);
    assert.equal(active, null);
  });
});
