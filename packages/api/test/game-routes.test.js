/**
 * Game API Routes Tests (F101 Task A6)
 *
 * Tests HTTP endpoints for game lifecycle:
 * POST /api/threads/:threadId/game       — Start game
 * GET  /api/threads/:threadId/game       — Get current game view
 * POST /api/threads/:threadId/game/action — Submit action
 * DELETE /api/threads/:threadId/game     — Abort game
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';
import { gameRoutes } from '../dist/routes/games.js';

/** In-memory GameStore stub */
function createStubGameStore() {
  const games = new Map();
  const activeByThread = new Map();
  return {
    async createGame(runtime) {
      if (activeByThread.has(runtime.threadId)) {
        throw new Error(`Thread ${runtime.threadId} already has an active game`);
      }
      games.set(runtime.gameId, structuredClone(runtime));
      activeByThread.set(runtime.threadId, runtime.gameId);
      return structuredClone(runtime);
    },
    async getGame(gameId) {
      const g = games.get(gameId);
      return g ? structuredClone(g) : null;
    },
    async getActiveGame(threadId) {
      const id = activeByThread.get(threadId);
      if (!id) return null;
      return this.getGame(id);
    },
    async updateGame(gameId, runtime) {
      games.set(gameId, structuredClone(runtime));
    },
    async endGame(gameId, winner) {
      const g = games.get(gameId);
      if (g) {
        g.status = 'finished';
        g.winner = winner;
        activeByThread.delete(g.threadId);
      }
    },
  };
}

function createStubSocket() {
  return {
    broadcastToRoom() {},
    emitToUser() {},
  };
}

function createStubThreadStore() {
  let counter = 0;
  return {
    async create(userId, title, category) {
      counter++;
      return { id: `game-thread-${counter}`, userId, title, category, createdAt: Date.now() };
    },
    async get() {
      return null;
    },
    async list() {
      return [];
    },
    async update() {},
    async delete() {},
    async updateThinkingMode() {},
    async updatePin() {},
  };
}

function createStubMessageStore() {
  let counter = 0;
  return {
    async append(msg) {
      counter++;
      return { id: `msg-${counter}`, ...msg };
    },
    async get() {
      return null;
    },
    async getByThread() {
      return [];
    },
    async update() {},
    async delete() {},
  };
}

function createStubAutoPlayer() {
  return {
    startedGameIds: [],
    stopCalls: 0,
    startLoop(gameId) {
      this.startedGameIds.push(gameId);
    },
    stopAllLoops() {
      this.stopCalls += 1;
    },
  };
}

function makeDefinition() {
  return {
    gameType: 'werewolf',
    displayName: 'Werewolf',
    minPlayers: 2,
    maxPlayers: 8,
    roles: [
      { name: 'wolf', faction: 'wolf', description: 'Kills at night' },
      { name: 'villager', faction: 'village', description: 'Votes by day' },
    ],
    phases: [
      { name: 'night_wolf', type: 'night_action', actingRole: 'wolf', timeoutMs: 30000, autoAdvance: true },
      { name: 'day_vote', type: 'day_vote', actingRole: '*', timeoutMs: 60000, autoAdvance: true },
    ],
    actions: [
      { name: 'kill', allowedRole: 'wolf', allowedPhase: 'night_wolf', targetRequired: true, schema: {} },
      { name: 'vote', allowedRole: '*', allowedPhase: 'day_vote', targetRequired: true, schema: {} },
    ],
    winConditions: [],
  };
}

describe('Game API Routes', () => {
  let app;
  let gameStore;

  before(async () => {
    gameStore = createStubGameStore();
    const socketManager = createStubSocket();

    app = Fastify();
    const threadStore = createStubThreadStore();
    const messageStore = createStubMessageStore();
    await app.register(gameRoutes, { gameStore, socketManager, threadStore, messageStore });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  describe('POST /api/threads/:threadId/game', () => {
    it('starts a game and returns runtime', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/threads/thread-route-1/game',
        payload: {
          definition: makeDefinition(),
          seats: [
            { seatId: 'P1', actorType: 'cat', actorId: 'opus', role: 'wolf', alive: true, properties: {} },
            { seatId: 'P2', actorType: 'human', actorId: 'owner', role: 'villager', alive: true, properties: {} },
          ],
          config: { timeoutMs: 30000, voiceMode: false, humanRole: 'player', humanSeat: 'P2' },
        },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.threadId, 'thread-route-1');
      assert.equal(body.status, 'playing');
      assert.ok(body.gameId);
    });

    it('rejects if thread already has active game', async () => {
      // thread-route-1 already has a game from above test
      const res = await app.inject({
        method: 'POST',
        url: '/api/threads/thread-route-1/game',
        payload: {
          definition: makeDefinition(),
          seats: [{ seatId: 'P1', actorType: 'cat', actorId: 'opus', role: 'wolf', alive: true, properties: {} }],
          config: { timeoutMs: 30000, voiceMode: false, humanRole: 'player', humanSeat: 'P2' },
        },
      });

      assert.equal(res.statusCode, 409);
    });
  });

  describe('GET /api/threads/:threadId/game', () => {
    it('returns current game view', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/threads/thread-route-1/game',
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.threadId, 'thread-route-1');
      assert.equal(body.status, 'playing');
    });

    it('returns 200 null if no active game', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/threads/nonexistent/game',
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.json(), null);
    });
  });

  describe('POST /api/threads/:threadId/game/action', () => {
    it('rejects invalid payload', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/threads/thread-route-1/game/action',
        payload: { bad: 'data' },
      });

      assert.equal(res.statusCode, 400);
    });

    it('rejects action when seatId does not match humanSeat (P0-3)', async () => {
      // Start a game with humanSeat = P2
      await app.inject({
        method: 'POST',
        url: '/api/threads/thread-route-auth/game',
        payload: {
          definition: makeDefinition(),
          seats: [
            { seatId: 'P1', actorType: 'cat', actorId: 'opus', role: 'wolf', alive: true, properties: {} },
            { seatId: 'P2', actorType: 'human', actorId: 'owner', role: 'villager', alive: true, properties: {} },
          ],
          config: { timeoutMs: 30000, voiceMode: false, humanRole: 'player', humanSeat: 'P2' },
        },
      });

      // Try to submit an action as P1 (which is a cat seat, not the human's seat)
      const res = await app.inject({
        method: 'POST',
        url: '/api/threads/thread-route-auth/game/action',
        payload: {
          seatId: 'P1',
          actionName: 'vote',
          targetSeat: 'P2',
        },
      });

      assert.equal(res.statusCode, 403, 'should reject action from non-humanSeat');
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('seat'), 'error should mention seat mismatch');
    });
  });

  describe('DELETE /api/threads/:threadId/game', () => {
    it('aborts the active game', async () => {
      // Start a fresh game on a new thread
      await app.inject({
        method: 'POST',
        url: '/api/threads/thread-route-del/game',
        payload: {
          definition: makeDefinition(),
          seats: [{ seatId: 'P1', actorType: 'cat', actorId: 'opus', role: 'wolf', alive: true, properties: {} }],
          config: { timeoutMs: 30000, voiceMode: false, humanRole: 'player', humanSeat: 'P2' },
        },
      });

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/threads/thread-route-del/game',
      });

      assert.equal(res.statusCode, 200);

      // Should no longer have active game
      const getRes = await app.inject({
        method: 'GET',
        url: '/api/threads/thread-route-del/game',
      });
      assert.equal(getRes.statusCode, 200);
      assert.equal(getRes.json(), null);
    });

    it('returns 404 if no active game to abort', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/threads/no-game/game',
      });

      assert.equal(res.statusCode, 404);
    });
  });

  describe('POST /api/game/start (high-level)', () => {
    it('starts a game and returns gameId + gameThreadId', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/game/start',
        payload: {
          gameType: 'werewolf',
          humanRole: 'player',
          playerCount: 7,
          catIds: ['opus', 'sonnet', 'codex', 'gpt52', 'gemini', 'spark'],
          voiceMode: false,
        },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.status, 'game_started');
      assert.ok(body.gameId, 'should return gameId');
      assert.ok(body.gameThreadId, 'should return gameThreadId');
    });

    it('rejects invalid payload (missing gameType)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/game/start',
        payload: {
          humanRole: 'player',
          playerCount: 7,
          catIds: ['opus'],
        },
      });

      assert.equal(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error);
    });

    it('falls back to all cats when catIds are empty after sanitize', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/game/start',
        payload: {
          gameType: 'werewolf',
          humanRole: 'god-view',
          playerCount: 6,
          catIds: ['nonexistent-cat-xyz'],
          voiceMode: false,
        },
      });

      // Should still succeed — falls back to all config cats
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.status, 'game_started');
    });

    it('rejects invalid payload (missing catIds)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/game/start',
        payload: {
          gameType: 'werewolf',
          humanRole: 'player',
          playerCount: 7,
          voiceMode: false,
        },
      });

      assert.equal(res.statusCode, 400);
    });

    it('uses X-Cat-Cafe-User header for userId when provided', async () => {
      // Separate app instance with tracking threadStore
      const trackingCalls = [];
      const trackingThreadStore = {
        ...createStubThreadStore(),
        async create(userId, title, category) {
          trackingCalls.push({ userId, title, category });
          return { id: `game-thread-track`, userId, title, category, createdAt: Date.now() };
        },
      };
      const trackingApp = Fastify();
      await trackingApp.register(gameRoutes, {
        gameStore: createStubGameStore(),
        socketManager: createStubSocket(),
        threadStore: trackingThreadStore,
        messageStore: createStubMessageStore(),
      });
      await trackingApp.ready();

      const res = await trackingApp.inject({
        method: 'POST',
        url: '/api/game/start',
        headers: { 'x-cat-cafe-user': 'you' },
        payload: {
          gameType: 'werewolf',
          humanRole: 'player',
          playerCount: 7,
          catIds: ['opus', 'sonnet', 'codex', 'gpt52', 'gemini', 'spark'],
          voiceMode: false,
        },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(trackingCalls.length, 1, 'should have called threadStore.create');
      assert.equal(trackingCalls[0].userId, 'you', 'userId should come from header, not hardcoded');

      await trackingApp.close();
    });

    it('starts a detective mode game with detectiveCatId', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/game/start',
        payload: {
          gameType: 'werewolf',
          humanRole: 'detective',
          playerCount: 7,
          catIds: ['opus', 'sonnet', 'codex', 'gpt52', 'gemini', 'spark', 'antigravity'],
          voiceMode: false,
          detectiveCatId: 'codex',
        },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.status, 'game_started');
      assert.ok(body.gameId, 'should return gameId');
      assert.ok(body.gameThreadId, 'should return gameThreadId');
    });

    it('rejects detective mode when detectiveCatId is not in catIds without side effects', async () => {
      // Separate app instance with tracking stores to verify no orphan thread/message
      const createCalls = [];
      const appendCalls = [];
      const trackingThreadStore = {
        ...createStubThreadStore(),
        async create(userId, title, category) {
          createCalls.push({ userId, title, category });
          return { id: 'game-thread-track', userId, title, category, createdAt: Date.now() };
        },
      };
      const trackingMessageStore = {
        ...createStubMessageStore(),
        async append(msg) {
          appendCalls.push(msg);
          return { id: 'msg-track', ...msg };
        },
      };
      const trackingApp = Fastify();
      await trackingApp.register(gameRoutes, {
        gameStore: createStubGameStore(),
        socketManager: createStubSocket(),
        threadStore: trackingThreadStore,
        messageStore: trackingMessageStore,
      });
      await trackingApp.ready();

      const res = await trackingApp.inject({
        method: 'POST',
        url: '/api/game/start',
        payload: {
          gameType: 'werewolf',
          humanRole: 'detective',
          playerCount: 7,
          catIds: ['opus', 'sonnet', 'codex', 'gpt52', 'gemini', 'spark', 'antigravity'],
          voiceMode: false,
          detectiveCatId: 'nonexistent-cat',
        },
      });

      assert.equal(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('detectiveCatId'), 'error should mention detectiveCatId');
      assert.equal(createCalls.length, 0, 'should NOT create thread for invalid detectiveCatId');
      assert.equal(appendCalls.length, 0, 'should NOT append message for invalid detectiveCatId');

      await trackingApp.close();
    });

    it('rejects detective mode without detectiveCatId', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/game/start',
        payload: {
          gameType: 'werewolf',
          humanRole: 'detective',
          playerCount: 7,
          catIds: ['opus', 'sonnet', 'codex', 'gpt52', 'gemini', 'spark', 'antigravity'],
          voiceMode: false,
        },
      });

      assert.equal(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('detectiveCatId'), 'error should mention detectiveCatId');
    });

    it('stops injected auto-player loops on app close', async () => {
      const localApp = Fastify();
      const autoPlayer = createStubAutoPlayer();

      await localApp.register(gameRoutes, {
        gameStore: createStubGameStore(),
        socketManager: createStubSocket(),
        threadStore: createStubThreadStore(),
        messageStore: createStubMessageStore(),
        autoPlayer,
      });
      await localApp.ready();

      const res = await localApp.inject({
        method: 'POST',
        url: '/api/game/start',
        payload: {
          gameType: 'werewolf',
          humanRole: 'player',
          playerCount: 7,
          catIds: ['opus', 'sonnet', 'codex', 'gpt52', 'gemini', 'spark'],
          voiceMode: false,
        },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(autoPlayer.startedGameIds.length, 1, 'should start injected auto-player');

      await localApp.close();

      assert.equal(autoPlayer.stopCalls, 1, 'should stop auto-player loops during close');
    });
  });

  describe('thinkingMode: play (AC-I9)', () => {
    it('POST /api/game/start sets thinkingMode to play on new game thread', async () => {
      const thinkingModeCalls = [];
      const trackingThreadStore = {
        ...createStubThreadStore(),
        async create(userId, title, category) {
          return { id: 'tracked-game-thread', userId, title, category, createdAt: Date.now() };
        },
        async updateThinkingMode(threadId, mode) {
          thinkingModeCalls.push({ threadId, mode });
        },
      };
      const localApp = Fastify();
      await localApp.register(gameRoutes, {
        gameStore: createStubGameStore(),
        socketManager: createStubSocket(),
        threadStore: trackingThreadStore,
        messageStore: createStubMessageStore(),
      });
      await localApp.ready();

      const res = await localApp.inject({
        method: 'POST',
        url: '/api/game/start',
        payload: {
          gameType: 'werewolf',
          humanRole: 'player',
          playerCount: 7,
          catIds: ['opus', 'sonnet', 'codex', 'gpt52', 'gemini', 'spark'],
          voiceMode: false,
        },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(thinkingModeCalls.length, 1, 'should call updateThinkingMode once');
      assert.equal(thinkingModeCalls[0].threadId, 'tracked-game-thread');
      assert.equal(thinkingModeCalls[0].mode, 'play');

      await localApp.close();
    });

    it('POST /api/threads/:threadId/game sets thinkingMode to play on existing thread', async () => {
      const thinkingModeCalls = [];
      const trackingThreadStore = {
        ...createStubThreadStore(),
        async updateThinkingMode(threadId, mode) {
          thinkingModeCalls.push({ threadId, mode });
        },
      };
      const localApp = Fastify();
      await localApp.register(gameRoutes, {
        gameStore: createStubGameStore(),
        socketManager: createStubSocket(),
        threadStore: trackingThreadStore,
        messageStore: createStubMessageStore(),
      });
      await localApp.ready();

      const res = await localApp.inject({
        method: 'POST',
        url: '/api/threads/existing-thread-42/game',
        payload: {
          definition: makeDefinition(),
          seats: [
            { seatId: 'P1', actorType: 'cat', actorId: 'opus', role: 'wolf', alive: true, properties: {} },
            { seatId: 'P2', actorType: 'human', actorId: 'owner', role: 'villager', alive: true, properties: {} },
          ],
          config: { timeoutMs: 30000, voiceMode: false, humanRole: 'player', humanSeat: 'P2' },
        },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(thinkingModeCalls.length, 1, 'should call updateThinkingMode once');
      assert.equal(thinkingModeCalls[0].threadId, 'existing-thread-42');
      assert.equal(thinkingModeCalls[0].mode, 'play');

      await localApp.close();
    });
  });
});
