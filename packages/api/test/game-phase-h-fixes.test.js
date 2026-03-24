/**
 * Phase H1+H2 P1 Fix Tests — Red→Green
 *
 * P1-1: day_last_words must produce last_words event after exile
 * P1-2: messageStore dual-write must use game-creator userId, not 'system'
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { GameOrchestrator } from '../dist/domains/cats/services/game/GameOrchestrator.js';

// GameAutoPlayer not needed for these orchestrator-level tests

/** In-memory GameStore stub */
function createStubGameStore() {
  const games = new Map();
  const activeByThread = new Map();
  return {
    games,
    async createGame(runtime) {
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
    async endGame(gameId) {
      const g = games.get(gameId);
      if (g) {
        g.status = 'finished';
        activeByThread.delete(g.threadId);
      }
    },
    async listActiveGames() {
      return [];
    },
  };
}

function createStubSocket() {
  return {
    broadcasts: [],
    broadcastToRoom(room, event, data) {
      this.broadcasts.push({ room, event, data });
    },
    emitToUser(userId, event, data) {
      this.broadcasts.push({ userId, event, data });
    },
  };
}

/** Spy messageStore — captures all append() calls */
function createSpyMessageStore() {
  const messages = [];
  return {
    messages,
    async append(msg) {
      messages.push(structuredClone(msg));
      return { id: `msg-${messages.length}`, ...msg };
    },
    getByThread() {
      return [];
    },
    getByThreadAfter() {
      return [];
    },
    getByThreadBefore() {
      return [];
    },
  };
}

/** Build a minimal 7-person werewolf definition with correct phase order */
function makeWerewolfDefinition() {
  // Import the actual definition to get the real phase order
  return {
    gameType: 'werewolf',
    displayName: 'Werewolf 7p',
    minPlayers: 7,
    maxPlayers: 7,
    roles: [
      { name: 'wolf', faction: 'wolf', description: 'Kill' },
      { name: 'seer', faction: 'village', description: 'Divine' },
      { name: 'guard', faction: 'village', description: 'Guard' },
      { name: 'villager', faction: 'village', description: 'Vote' },
    ],
    phases: [
      { name: 'night_guard', type: 'night_action', actingRole: 'guard', timeoutMs: 0, autoAdvance: true },
      { name: 'night_wolf', type: 'night_action', actingRole: 'wolf', timeoutMs: 0, autoAdvance: true },
      { name: 'night_seer', type: 'night_action', actingRole: 'seer', timeoutMs: 0, autoAdvance: true },
      { name: 'night_resolve', type: 'resolve', timeoutMs: 0, autoAdvance: true },
      { name: 'day_announce', type: 'announce', timeoutMs: 0, autoAdvance: true },
      { name: 'day_discuss', type: 'day_discuss', actingRole: '*', timeoutMs: 0, autoAdvance: true },
      { name: 'day_vote', type: 'day_vote', actingRole: '*', timeoutMs: 0, autoAdvance: true },
      { name: 'day_exile', type: 'resolve', timeoutMs: 0, autoAdvance: true },
      { name: 'day_last_words', type: 'announce', timeoutMs: 0, autoAdvance: true },
    ],
    actions: [
      { name: 'kill', allowedRole: 'wolf', allowedPhase: 'night_wolf', targetRequired: true, schema: {} },
      { name: 'divine', allowedRole: 'seer', allowedPhase: 'night_seer', targetRequired: true, schema: {} },
      { name: 'guard', allowedRole: 'guard', allowedPhase: 'night_guard', targetRequired: true, schema: {} },
      { name: 'speak', allowedRole: '*', allowedPhase: 'day_discuss', targetRequired: false, schema: {} },
      { name: 'vote', allowedRole: '*', allowedPhase: 'day_vote', targetRequired: true, schema: {} },
    ],
    presets: {},
  };
}

function makeSeats() {
  return [
    { seatId: 'P1', actorType: 'cat', actorId: 'opus', role: 'wolf', alive: true, properties: {} },
    { seatId: 'P2', actorType: 'cat', actorId: 'codex', role: 'wolf', alive: true, properties: {} },
    { seatId: 'P3', actorType: 'cat', actorId: 'gemini', role: 'seer', alive: true, properties: {} },
    { seatId: 'P4', actorType: 'cat', actorId: 'gpt52', role: 'guard', alive: true, properties: {} },
    { seatId: 'P5', actorType: 'cat', actorId: 'sonnet', role: 'villager', alive: true, properties: {} },
    { seatId: 'P6', actorType: 'cat', actorId: 'dare', role: 'villager', alive: true, properties: {} },
    { seatId: 'P7', actorType: 'cat', actorId: 'spark', role: 'villager', alive: true, properties: {} },
  ];
}

describe('Phase H P1 Fixes — definition-level regression guards', () => {
  it('P1-1 guard: WerewolfDefinition has day_last_words AFTER day_exile', async () => {
    const { createWerewolfDefinition } = await import(
      '../dist/domains/cats/services/game/werewolf/WerewolfDefinition.js'
    );
    const def = createWerewolfDefinition(7);
    const phaseNames = def.phases.map((p) => p.name);
    const exileIdx = phaseNames.indexOf('day_exile');
    const lastWordsIdx = phaseNames.indexOf('day_last_words');
    assert.ok(exileIdx >= 0, 'day_exile should exist in phases');
    assert.ok(lastWordsIdx >= 0, 'day_last_words should exist in phases');
    assert.ok(
      lastWordsIdx > exileIdx,
      `day_last_words (idx=${lastWordsIdx}) must come AFTER day_exile (idx=${exileIdx})`,
    );
  });

  it('P1-2 guard: observerUserId flows through to messageStore in all modes', async () => {
    // Behavioral test: start game in PLAYER mode, trigger announce, verify userId in messageStore
    const { GameOrchestrator } = await import('../dist/domains/cats/services/game/GameOrchestrator.js');
    const store = createStubGameStore();
    const socket = createStubSocket();
    const msgStore = createSpyMessageStore();
    const orch = new GameOrchestrator({ gameStore: store, socketManager: socket, messageStore: msgStore });

    const game = await orch.startGame({
      threadId: 'thread-p2-behavioral',
      definition: makeWerewolfDefinition(),
      seats: makeSeats(),
      config: { humanRole: 'player', humanSeat: 'P1', observerUserId: 'user-behavioral-test' },
    });

    // Night actions → resolve → dawn announce
    await orch.handlePlayerAction(game.gameId, 'P4', {
      seatId: 'P4',
      actionName: 'guard',
      targetSeat: 'P3',
      submittedAt: Date.now(),
    });
    let rt = await store.getGame(game.gameId);
    if (rt.currentPhase === 'night_wolf') {
      await orch.handlePlayerAction(game.gameId, 'P1', {
        seatId: 'P1',
        actionName: 'kill',
        targetSeat: 'P5',
        submittedAt: Date.now(),
      });
      await orch.handlePlayerAction(game.gameId, 'P2', {
        seatId: 'P2',
        actionName: 'kill',
        targetSeat: 'P5',
        submittedAt: Date.now(),
      });
    }
    rt = await store.getGame(game.gameId);
    if (rt.currentPhase === 'night_seer') {
      await orch.handlePlayerAction(game.gameId, 'P3', {
        seatId: 'P3',
        actionName: 'divine',
        targetSeat: 'P1',
        submittedAt: Date.now(),
      });
    }
    // Force-tick through resolve
    async function forceTick() {
      const g = await store.getGame(game.gameId);
      if (g) {
        g.phaseStartedAt = 0;
        await store.updateGame(game.gameId, g);
      }
      await orch.tick(game.gameId);
    }
    rt = await store.getGame(game.gameId);
    if (rt.currentPhase === 'night_resolve') await forceTick();
    await new Promise((r) => setTimeout(r, 50));

    // Verify: ALL messageStore messages use the game creator's userId, not 'system'
    assert.ok(msgStore.messages.length > 0, 'Should have at least one announce message');
    for (const msg of msgStore.messages) {
      assert.equal(
        msg.userId,
        'user-behavioral-test',
        `All game messages must use creator userId (got userId=${msg.userId} for content="${msg.content?.slice(0, 40)}")`,
      );
    }
  });

  it('P2 guard: /api/game/start route injects observerUserId into game config', async () => {
    // Route-level test: spin up Fastify with gameRoutes, POST to start game,
    // verify the created game runtime has observerUserId from auth header
    const { default: Fastify } = await import('fastify');
    const { gameRoutes } = await import('../dist/routes/games.js');
    const routeStore = createStubGameStore();
    const routeSocket = createStubSocket();
    const routeMsgStore = createSpyMessageStore();

    const app = Fastify();
    await app.register(gameRoutes, {
      gameStore: routeStore,
      socketManager: routeSocket,
      threadStore: {
        async create(userId, title, category) {
          return { id: 'game-thread-route', userId, title, category, createdAt: Date.now() };
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
      },
      messageStore: routeMsgStore,
    });

    const resp = await app.inject({
      method: 'POST',
      url: '/api/game/start',
      headers: { 'x-cat-cafe-user': 'route-test-user' },
      payload: {
        gameType: 'werewolf',
        playerCount: 7,
        humanRole: 'player',
        voiceMode: false,
        catIds: ['opus', 'codex', 'gemini', 'gpt52', 'sonnet', 'dare'],
      },
    });

    assert.equal(resp.statusCode, 200, `Expected 200, got ${resp.statusCode}: ${resp.body}`);
    const body = JSON.parse(resp.body);

    // Verify the game was created with observerUserId from x-user-id header
    const game = await routeStore.getGame(body.gameId);
    assert.ok(game, 'Game should exist in store');
    assert.equal(
      game.config.observerUserId,
      'route-test-user',
      'Route must inject observerUserId from auth header into game config',
    );

    await app.close();
  });

  it('P2 guard: /api/messages /game command also injects observerUserId', async () => {
    const { default: Fastify } = await import('fastify');
    const { messagesRoutes } = await import('../dist/routes/messages.js');
    const routeStore = createStubGameStore();
    const routeMsgStore = createSpyMessageStore();

    let threadCounter = 0;
    const app = Fastify();
    await app.register(messagesRoutes, {
      registry: {
        get() {
          return undefined;
        },
      },
      messageStore: routeMsgStore,
      socketManager: { broadcastToRoom() {}, emitToUser() {}, broadcastAgentMessage() {} },
      router: {
        async resolveTargetsAndIntent() {
          return { targetCats: ['opus'], intent: { intent: 'execute', explicit: false, promptTags: [] } };
        },
        async *routeExecution() {
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        },
        async *route() {
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        },
        async ackCollectedCursors() {},
      },
      threadStore: {
        async get(id) {
          return { id, title: 'Test', deletedAt: null };
        },
        async updateTitle() {},
        async create(userId, title, projectPath) {
          return {
            id: `thread_game_${++threadCounter}`,
            title,
            projectPath,
            createdBy: userId,
            participants: [],
            lastActiveAt: Date.now(),
            createdAt: Date.now(),
          };
        },
      },
      gameStore: routeStore,
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

    const resp = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'msg-route-user' },
      payload: { content: '/game werewolf god-view', threadId: 'thread-msg-test' },
    });

    assert.equal(resp.statusCode, 200, `Expected 200, got ${resp.statusCode}: ${resp.body}`);
    const body = JSON.parse(resp.body);
    // /api/messages game response uses status='game_started' + gameId
    assert.ok(
      body.gameId || body.status === 'game_started',
      `Response must include gameId or game_started status (got: ${JSON.stringify(body).slice(0, 200)})`,
    );
    const game = routeStore.games?.get?.(body.gameId) ?? (await routeStore.getGame(body.gameId));
    assert.ok(game, 'Game should exist in store');
    assert.equal(
      game.config.observerUserId,
      'msg-route-user',
      '/api/messages /game command must inject observerUserId from auth header',
    );
    await app.close();
  });
});

describe('Phase H P1 Fixes', () => {
  let store, socket, msgStore, orchestrator;

  beforeEach(() => {
    store = createStubGameStore();
    socket = createStubSocket();
    msgStore = createSpyMessageStore();
    orchestrator = new GameOrchestrator({ gameStore: store, socketManager: socket, messageStore: msgStore });
  });

  describe('P1-1: day_last_words produces last_words event after exile', () => {
    it('resolveLastWords finds vote_resolved and writes last_words + messageStore', async () => {
      // Start game
      const game = await orchestrator.startGame({
        threadId: 'thread-p1-1',
        definition: makeWerewolfDefinition(),
        seats: makeSeats(),
        config: { humanRole: 'god', observerUserId: 'user-landy' },
      });
      const gameId = game.gameId;

      // Fast-forward: night → resolve → announce → discuss → vote → exile → last_words
      // night_guard: P4 (guard) guards P3
      await orchestrator.handlePlayerAction(gameId, 'P4', {
        seatId: 'P4',
        actionName: 'guard',
        targetSeat: 'P3',
        submittedAt: Date.now(),
      });
      // night_wolf: P1+P2 (wolves) kill P5
      let rt = await store.getGame(gameId);
      if (rt.currentPhase === 'night_wolf') {
        await orchestrator.handlePlayerAction(gameId, 'P1', {
          seatId: 'P1',
          actionName: 'kill',
          targetSeat: 'P5',
          submittedAt: Date.now(),
        });
        await orchestrator.handlePlayerAction(gameId, 'P2', {
          seatId: 'P2',
          actionName: 'kill',
          targetSeat: 'P5',
          submittedAt: Date.now(),
        });
      }
      // night_seer: P3 (seer) divines P1
      rt = await store.getGame(gameId);
      if (rt.currentPhase === 'night_seer') {
        await orchestrator.handlePlayerAction(gameId, 'P3', {
          seatId: 'P3',
          actionName: 'divine',
          targetSeat: 'P1',
          submittedAt: Date.now(),
        });
      }
      // Helper: force-expire phase timeout (bypasses grace period on round 1)
      async function forceTick() {
        const g = await store.getGame(gameId);
        if (g) {
          g.phaseStartedAt = 0;
          await store.updateGame(gameId, g);
        }
        await orchestrator.tick(gameId);
      }

      // night_resolve: tick through
      rt = await store.getGame(gameId);
      if (rt.currentPhase === 'night_resolve') await forceTick();
      // day_announce: tick through
      rt = await store.getGame(gameId);
      if (rt.currentPhase === 'day_announce') await forceTick();
      // day_discuss: submit speaks for all alive players
      rt = await store.getGame(gameId);
      if (rt.currentPhase === 'day_discuss') {
        const aliveSeats = rt.seats.filter((s) => s.alive);
        for (const seat of aliveSeats) {
          await orchestrator.handlePlayerAction(gameId, seat.seatId, {
            seatId: seat.seatId,
            actionName: 'speak',
            params: { speechText: `I am ${seat.actorId}` },
            submittedAt: Date.now(),
          });
        }
      }
      // day_vote: all vote for P6
      rt = await store.getGame(gameId);
      if (rt.currentPhase === 'day_vote') {
        const aliveSeats = rt.seats.filter((s) => s.alive);
        for (const seat of aliveSeats) {
          const target = seat.seatId === 'P6' ? 'P7' : 'P6';
          await orchestrator.handlePlayerAction(gameId, seat.seatId, {
            seatId: seat.seatId,
            actionName: 'vote',
            targetSeat: target,
            submittedAt: Date.now(),
          });
        }
      }
      // day_exile: tick through (should resolve vote + exile P6)
      rt = await store.getGame(gameId);
      if (rt.currentPhase === 'day_exile') await forceTick();

      // NOW: should be at day_last_words
      rt = await store.getGame(gameId);
      assert.equal(rt.currentPhase, 'day_last_words', 'Phase should advance to day_last_words after day_exile');

      // Tick day_last_words — resolveLastWords should fire
      await forceTick();

      rt = await store.getGame(gameId);
      const lastWordsEvents = rt.eventLog.filter((e) => e.type === 'last_words');
      assert.ok(lastWordsEvents.length > 0, 'day_last_words phase should produce at least one last_words event');

      // Verify the last_words is from the exiled player (P6)
      const lw = lastWordsEvents[0];
      assert.equal(lw.payload.seatId, 'P6', 'last_words should be from exiled player P6');
      assert.ok(lw.payload.text.length > 0, 'last_words should have text content');

      // Verify messageStore got the speech
      const speechMessages = msgStore.messages.filter((m) => m.catId === 'dare');
      assert.ok(speechMessages.length > 0, 'messageStore should have speech message from exiled player (dare)');
    });
  });

  describe('P1-2: messageStore uses game-creator userId, not system', () => {
    it('player mode: announce messages use creating userId, not system', async () => {
      const game = await orchestrator.startGame({
        threadId: 'thread-p1-2',
        definition: makeWerewolfDefinition(),
        seats: makeSeats(),
        config: { humanRole: 'player', humanSeat: 'P1', observerUserId: 'user-landy' },
      });
      const gameId = game.gameId;

      // Submit night actions to reach day_announce
      // night_guard: P4 guards P3
      await orchestrator.handlePlayerAction(gameId, 'P4', {
        seatId: 'P4',
        actionName: 'guard',
        targetSeat: 'P3',
        submittedAt: Date.now(),
      });
      let rt = await store.getGame(gameId);
      // night_wolf: P1+P2 kill P5
      if (rt.currentPhase === 'night_wolf') {
        await orchestrator.handlePlayerAction(gameId, 'P1', {
          seatId: 'P1',
          actionName: 'kill',
          targetSeat: 'P5',
          submittedAt: Date.now(),
        });
        await orchestrator.handlePlayerAction(gameId, 'P2', {
          seatId: 'P2',
          actionName: 'kill',
          targetSeat: 'P5',
          submittedAt: Date.now(),
        });
      }
      // night_seer: P3 divines P1
      rt = await store.getGame(gameId);
      if (rt.currentPhase === 'night_seer') {
        await orchestrator.handlePlayerAction(gameId, 'P3', {
          seatId: 'P3',
          actionName: 'divine',
          targetSeat: 'P1',
          submittedAt: Date.now(),
        });
      }
      // Force-tick through resolve phases (bypasses grace period)
      async function forceTick2() {
        const g = await store.getGame(gameId);
        if (g) {
          g.phaseStartedAt = 0;
          await store.updateGame(gameId, g);
        }
        await orchestrator.tick(gameId);
      }
      rt = await store.getGame(gameId);
      if (rt.currentPhase === 'night_resolve') await forceTick2();

      // dawn_announce should have been written to messageStore
      // Wait for fire-and-forget promises
      await new Promise((r) => setTimeout(r, 50));

      const announceMessages = msgStore.messages.filter((m) => m.catId === null);
      assert.ok(announceMessages.length > 0, 'Should have announce messages in messageStore');

      // P1-2: All messages should use the creating user's ID, NOT 'system'
      for (const msg of msgStore.messages) {
        assert.notEqual(
          msg.userId,
          'system',
          `Message should not have userId=system (got: ${JSON.stringify({ catId: msg.catId, content: msg.content?.slice(0, 40) })})`,
        );
        assert.equal(msg.userId, 'user-landy', 'Message userId should be the game creator');
      }
    });
  });
});
