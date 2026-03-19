/**
 * Game Command Bridge Integration Test (F101)
 *
 * Verifies that /game commands in POST /api/messages are intercepted
 * and routed to GameOrchestrator instead of AI agents.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Fastify from 'fastify';
import { messagesRoutes } from '../dist/routes/messages.js';

/** In-memory GameStore stub */
function createStubGameStore() {
  const games = new Map();
  const activeByThread = new Map();
  return {
    games,
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

/** Stub message store — tracks appended messages */
function createStubMessageStore() {
  const messages = [];
  let idCounter = 0;
  return {
    messages,
    async append(msg) {
      const id = `msg-${++idCounter}`;
      const stored = { ...msg, id };
      messages.push(stored);
      return stored;
    },
    async getMessages() {
      return messages;
    },
  };
}

function createStubSocket() {
  const events = [];
  return {
    events,
    broadcastToRoom(room, event, data) {
      events.push({ room, event, data });
    },
    emitToUser(userId, event, data) {
      events.push({ userId, event, data });
    },
    broadcastAgentMessage() {},
  };
}

/** Minimal router stub — should NOT be called for /game commands */
function createStubRouter() {
  let routeCalled = false;
  return {
    get routeCalled() {
      return routeCalled;
    },
    async resolveTargetsAndIntent() {
      routeCalled = true;
      return { targetCats: ['opus'], intent: { intent: 'execute', explicit: false, promptTags: [] } };
    },
    async *routeExecution() {
      routeCalled = true;
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
    },
    async *route() {
      routeCalled = true;
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
    },
    async ackCollectedCursors() {},
  };
}

function createStubRegistry() {
  return {
    get() {
      return undefined;
    },
  };
}

function createStubThreadStore() {
  let nextId = 1;
  return {
    async get(id) {
      return { id, title: 'Test Thread', deletedAt: null };
    },
    async updateTitle() {},
    async create(userId, title, projectPath) {
      const id = `thread_game_${nextId++}`;
      return {
        id,
        title,
        projectPath,
        createdBy: userId,
        participants: [],
        lastActiveAt: Date.now(),
        createdAt: Date.now(),
      };
    },
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

describe('/game command bridge in POST /api/messages', () => {
  let app;
  let gameStore;
  let messageStore;
  let socketStub;
  let routerStub;

  before(async () => {
    app = Fastify();
    gameStore = createStubGameStore();
    messageStore = createStubMessageStore();
    socketStub = createStubSocket();
    routerStub = createStubRouter();

    await app.register(messagesRoutes, {
      registry: createStubRegistry(),
      messageStore,
      socketManager: socketStub,
      router: routerStub,
      threadStore: createStubThreadStore(),
      gameStore,
      invocationTracker: {
        has: () => false,
        isDeleting: () => false,
        tryStartThread: () => new AbortController(),
        start: () => new AbortController(),
        complete: () => {},
      },
      invocationRecordStore: {
        create: async () => ({ outcome: 'created', invocationId: 'inv-stub' }),
        update: async () => {},
      },
    });

    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it('intercepts /game werewolf god-view voice and starts a game', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: {
        content: '/game werewolf god-view voice',
        threadId: 'thread-test-1',
      },
    });

    const body = res.json();
    assert.equal(body.status, 'game_started');
    assert.ok(body.gameId, 'should return gameId');
    assert.ok(body.gameThreadId, 'should return gameThreadId for the independent game thread');
    assert.ok(body.userMessageId, 'should return userMessageId');

    // User message stored in the game thread (not source thread)
    assert.equal(messageStore.messages.length, 1);
    assert.equal(messageStore.messages[0].content, '/game werewolf god-view voice');
    assert.equal(messageStore.messages[0].threadId, body.gameThreadId);

    // Game created in store — runs in the new game thread
    assert.equal(gameStore.games.size, 1);
    const game = [...gameStore.games.values()][0];
    assert.equal(game.threadId, body.gameThreadId, 'game should run in the new game thread');
    assert.notEqual(game.threadId, 'thread-test-1', 'game should NOT run in the source thread');
    assert.equal(game.status, 'playing');
    assert.equal(game.config.voiceMode, true);
    assert.equal(game.config.humanRole, 'god-view');
    assert.equal(game.seats.length, 7);

    // All seats should have roles assigned (via WerewolfLobby)
    for (const seat of game.seats) {
      assert.ok(seat.role, `seat ${seat.seatId} should have a role assigned`);
    }

    // AI routing NOT invoked
    assert.equal(routerStub.routeCalled, false, 'AI router should not be called for /game commands');
  });

  it('passes normal messages through to AI routing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: {
        content: 'hello world',
        threadId: 'thread-test-2',
      },
    });

    // Should go through normal routing (may fail due to minimal stubs, but router should be called)
    assert.equal(routerStub.routeCalled, true, 'AI router should be called for normal messages');
  });

  it('broadcasts game:started and game:state_update WebSocket events', async () => {
    // Reset socket events
    socketStub.events.length = 0;

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: {
        content: '/game werewolf player voice',
        threadId: 'thread-test-3',
      },
    });

    const body = res.json();
    assert.equal(body.status, 'game_started');

    // Should have game:thread_created broadcast to source thread
    const threadCreatedEvents = socketStub.events.filter((e) => e.event === 'game:thread_created');
    assert.ok(threadCreatedEvents.length >= 1, 'should broadcast game:thread_created to source thread');
    assert.equal(threadCreatedEvents[0].room, 'thread:thread-test-3');
    assert.equal(
      threadCreatedEvents[0].data.initiatorUserId,
      'owner',
      'should include initiatorUserId for frontend guard',
    );

    // Should have game:started broadcast to the NEW game thread
    const startedEvents = socketStub.events.filter((e) => e.event === 'game:started');
    assert.equal(startedEvents.length, 1);
    assert.ok(startedEvents[0].room.startsWith('thread:thread_game_'), 'game:started should be on game thread');

    // Should have game:state_update for each seat (≥7: initial broadcast + auto-play may add more)
    const stateEvents = socketStub.events.filter((e) => e.event === 'game:state_update');
    assert.ok(stateEvents.length >= 7, `should broadcast state to all 7 seats (got ${stateEvents.length})`);
  });

  it('sets humanSeat=P1 for player mode', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: {
        content: '/game werewolf player',
        threadId: 'thread-test-4',
      },
    });

    const body = res.json();
    assert.equal(body.status, 'game_started');

    // Find the game created for this request (latest one)
    const game = [...gameStore.games.values()].find((g) => g.gameId === body.gameId);
    assert.ok(game, 'should find the created game');
    assert.equal(game.config.humanRole, 'player');
    assert.equal(game.config.humanSeat, 'P1');
    assert.equal(game.config.voiceMode, false);
    // P1 should be human
    assert.equal(game.seats[0].actorType, 'human');
    assert.equal(game.seats[0].actorId, 'owner');
  });

  it('each /game command creates a separate game thread (no 409 conflict)', async () => {
    // First game
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: {
        content: '/game werewolf player',
        threadId: 'thread-test-multi',
      },
    });
    assert.equal(res1.json().status, 'game_started');
    const threadId1 = res1.json().gameThreadId;

    // Second game from same source — should also succeed (new thread)
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: {
        content: '/game werewolf god-view',
        threadId: 'thread-test-multi',
      },
    });
    assert.equal(res2.json().status, 'game_started');
    const threadId2 = res2.json().gameThreadId;
    assert.notEqual(threadId1, threadId2, 'each game should get its own thread');
  });

  it('stops injected auto-player loops on app close', async () => {
    const localApp = Fastify();
    const autoPlayer = createStubAutoPlayer();

    await localApp.register(messagesRoutes, {
      registry: createStubRegistry(),
      messageStore: createStubMessageStore(),
      socketManager: createStubSocket(),
      router: createStubRouter(),
      threadStore: createStubThreadStore(),
      gameStore: createStubGameStore(),
      autoPlayer,
      invocationTracker: {
        has: () => false,
        isDeleting: () => false,
        tryStartThread: () => new AbortController(),
        start: () => new AbortController(),
        complete: () => {},
      },
      invocationRecordStore: {
        create: async () => ({ outcome: 'created', invocationId: 'inv-stub' }),
        update: async () => {},
      },
    });
    await localApp.ready();

    const res = await localApp.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: {
        content: '/game werewolf player',
        threadId: 'thread-test-close',
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(autoPlayer.startedGameIds.length, 1, 'should start injected auto-player');

    await localApp.close();

    assert.equal(autoPlayer.stopCalls, 1, 'should stop auto-player loops during close');
  });
});
