/**
 * GameOrchestrator Tests (F101 Task A5)
 * Tests system-driven tick, action handling, phase advancement, and scoped broadcasts.
 *
 * Uses in-memory stubs for GameStore and SocketManager.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { GameOrchestrator } from '../dist/domains/cats/services/game/GameOrchestrator.js';

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

/** Socket broadcast spy */
function createStubSocket() {
  const broadcasts = [];
  return {
    broadcasts,
    broadcastToRoom(room, event, data) {
      broadcasts.push({ room, event, data });
    },
    emitToUser(userId, event, data) {
      broadcasts.push({ userId, event, data });
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
      {
        name: 'night_wolf',
        type: 'night_action',
        actingRole: 'wolf',
        timeoutMs: 30000,
        autoAdvance: true,
      },
      {
        name: 'day_vote',
        type: 'day_vote',
        actingRole: '*',
        timeoutMs: 60000,
        autoAdvance: true,
      },
    ],
    actions: [
      { name: 'kill', allowedRole: 'wolf', allowedPhase: 'night_wolf', targetRequired: true, schema: {} },
      { name: 'vote', allowedRole: '*', allowedPhase: 'day_vote', targetRequired: true, schema: {} },
    ],
    winConditions: [],
  };
}

function makeSeats() {
  return [
    { seatId: 'P1', actorType: 'cat', actorId: 'opus', role: 'wolf', alive: true, properties: {} },
    { seatId: 'P2', actorType: 'human', actorId: 'owner', role: 'villager', alive: true, properties: {} },
  ];
}

describe('GameOrchestrator', () => {
  let store;
  let socket;
  let orchestrator;

  beforeEach(() => {
    store = createStubGameStore();
    socket = createStubSocket();
    orchestrator = new GameOrchestrator({ gameStore: store, socketManager: socket });
  });

  describe('startGame', () => {
    it('creates game and broadcasts initial state', async () => {
      const result = await orchestrator.startGame({
        threadId: 'thread-001',
        definition: makeDefinition(),
        seats: makeSeats(),
        config: { timeoutMs: 30000, voiceMode: false, humanRole: 'player' },
      });

      assert.equal(result.status, 'playing');
      assert.equal(result.threadId, 'thread-001');
      assert.equal(result.seats.length, 2);

      // Should broadcast game_started to thread room
      const startEvent = socket.broadcasts.find((b) => b.event === 'game:started');
      assert.ok(startEvent, 'should broadcast game:started');
      assert.equal(startEvent.room, 'thread:thread-001');
    });
  });

  describe('handlePlayerAction', () => {
    it('accepts valid action from correct role in correct phase', async () => {
      const game = await orchestrator.startGame({
        threadId: 'thread-002',
        definition: makeDefinition(),
        seats: makeSeats(),
        config: { timeoutMs: 30000, voiceMode: false, humanRole: 'player' },
      });

      // day_vote: both players need to act, so one action won't auto-advance
      const stored = await store.getGame(game.gameId);
      stored.currentPhase = 'day_vote';
      stored.round = 1;
      await store.updateGame(game.gameId, stored);

      await orchestrator.handlePlayerAction(game.gameId, 'P1', {
        seatId: 'P1',
        actionName: 'vote',
        targetSeat: 'P2',
        submittedAt: Date.now(),
      });

      // Action recorded, phase not advanced (P2 still pending)
      const updated = await store.getGame(game.gameId);
      assert.ok(updated.pendingActions.P1, 'P1 action should be recorded');
      assert.equal(updated.currentPhase, 'day_vote', 'should NOT advance yet');
    });

    it('rejects action from wrong role for phase', async () => {
      const game = await orchestrator.startGame({
        threadId: 'thread-003',
        definition: makeDefinition(),
        seats: makeSeats(),
        config: { timeoutMs: 30000, voiceMode: false, humanRole: 'player' },
      });

      const stored = await store.getGame(game.gameId);
      stored.currentPhase = 'night_wolf';
      stored.round = 1;
      await store.updateGame(game.gameId, stored);

      // P2 is villager, cannot act during night_wolf
      await assert.rejects(
        () =>
          orchestrator.handlePlayerAction(game.gameId, 'P2', {
            seatId: 'P2',
            actionName: 'vote',
            targetSeat: 'P1',
            submittedAt: Date.now(),
          }),
        /not allowed/i,
      );
    });

    it('auto-advances phase when all actions collected', async () => {
      const game = await orchestrator.startGame({
        threadId: 'thread-004',
        definition: makeDefinition(),
        seats: makeSeats(),
        config: { timeoutMs: 30000, voiceMode: false, humanRole: 'player' },
      });

      // night_wolf: only wolf (P1) needs to act
      const stored = await store.getGame(game.gameId);
      stored.currentPhase = 'night_wolf';
      stored.round = 1;
      await store.updateGame(game.gameId, stored);

      await orchestrator.handlePlayerAction(game.gameId, 'P1', {
        seatId: 'P1',
        actionName: 'kill',
        targetSeat: 'P2',
        submittedAt: Date.now(),
      });

      // Phase should advance to day_vote
      const updated = await store.getGame(game.gameId);
      assert.equal(updated.currentPhase, 'day_vote', 'should auto-advance to day_vote');

      // Should broadcast phase_changed
      const phaseEvent = socket.broadcasts.find((b) => b.event === 'game:phase_changed');
      assert.ok(phaseEvent, 'should broadcast game:phase_changed');
    });
  });

  describe('tick', () => {
    it('applies timeout default actions when timer expires', async () => {
      const game = await orchestrator.startGame({
        threadId: 'thread-005',
        definition: makeDefinition(),
        seats: makeSeats(),
        config: { timeoutMs: 30000, voiceMode: false, humanRole: 'player' },
      });

      const stored = await store.getGame(game.gameId);
      stored.currentPhase = 'night_wolf';
      stored.round = 1;
      // Set phase start to way in the past (expired)
      stored.phaseStartedAt = Date.now() - 60000;
      await store.updateGame(game.gameId, stored);

      await orchestrator.tick(game.gameId);

      // Should have applied default action and advanced
      const updated = await store.getGame(game.gameId);
      assert.equal(updated.currentPhase, 'day_vote', 'should advance after timeout');
    });

    it('does nothing if phase timer has not expired', async () => {
      const game = await orchestrator.startGame({
        threadId: 'thread-006',
        definition: makeDefinition(),
        seats: makeSeats(),
        config: { timeoutMs: 30000, voiceMode: false, humanRole: 'player' },
      });

      const stored = await store.getGame(game.gameId);
      stored.currentPhase = 'night_wolf';
      stored.round = 1;
      stored.phaseStartedAt = Date.now(); // just started
      await store.updateGame(game.gameId, stored);

      await orchestrator.tick(game.gameId);

      const updated = await store.getGame(game.gameId);
      assert.equal(updated.currentPhase, 'night_wolf', 'should not advance');
    });
  });

  describe('startGame — currentPhase (P1-1)', () => {
    it('sets currentPhase to first definition phase, not lobby', async () => {
      const game = await orchestrator.startGame({
        threadId: 'thread-phase-init',
        definition: makeDefinition(),
        seats: makeSeats(),
        config: { timeoutMs: 30000, voiceMode: false, humanRole: 'player' },
      });

      assert.equal(game.currentPhase, 'night_wolf', 'currentPhase must be first phase from definition, not lobby');
    });
  });

  describe('handlePlayerAction — version increment (P1-2)', () => {
    it('increments version on submitAction so store update succeeds', async () => {
      const game = await orchestrator.startGame({
        threadId: 'thread-version',
        definition: makeDefinition(),
        seats: makeSeats(),
        config: { timeoutMs: 30000, voiceMode: false, humanRole: 'player' },
      });

      const stored = await store.getGame(game.gameId);
      stored.currentPhase = 'day_vote';
      stored.round = 1;
      await store.updateGame(game.gameId, stored);

      const versionBefore = (await store.getGame(game.gameId)).version;

      await orchestrator.handlePlayerAction(game.gameId, 'P1', {
        seatId: 'P1',
        actionName: 'vote',
        targetSeat: 'P2',
        submittedAt: Date.now(),
      });

      const versionAfter = (await store.getGame(game.gameId)).version;
      assert.ok(versionAfter > versionBefore, 'version must increase after submitAction');
    });
  });

  describe('broadcastGameState', () => {
    it('emits scoped game views per connected seat', async () => {
      const game = await orchestrator.startGame({
        threadId: 'thread-007',
        definition: makeDefinition(),
        seats: makeSeats(),
        config: { timeoutMs: 30000, voiceMode: false, humanRole: 'player' },
      });

      // Clear broadcasts from startGame
      socket.broadcasts.length = 0;

      await orchestrator.broadcastGameState(game.gameId);

      // Should broadcast a game:state_update to the thread room
      const stateEvent = socket.broadcasts.find((b) => b.event === 'game:state_update');
      assert.ok(stateEvent, 'should broadcast game:state_update');
    });

    it('sends per-seat scoped views, not god view (P0-2)', async () => {
      const definition = makeDefinition();
      const seats = makeSeats();
      const game = await orchestrator.startGame({
        threadId: 'thread-scoped-bc',
        definition,
        seats,
        config: { timeoutMs: 30000, voiceMode: false, humanRole: 'player' },
      });

      // Add a faction:wolf event so wolf and villager get different event counts
      const stored = await store.getGame(game.gameId);
      stored.currentPhase = 'night_wolf';
      stored.round = 1;
      stored.eventLog.push({
        eventId: 'evt-test',
        round: 1,
        phase: 'night_wolf',
        type: 'wolf_kill',
        scope: 'faction:wolf',
        payload: { target: 'P2' },
        timestamp: Date.now(),
      });
      await store.updateGame(game.gameId, stored);

      socket.broadcasts.length = 0;
      await orchestrator.broadcastGameState(game.gameId);

      // Must emit per-seat views (via emitToUser), not a single room broadcast
      const perSeatEmits = socket.broadcasts.filter((b) => b.event === 'game:state_update' && b.userId);
      assert.ok(perSeatEmits.length >= 2, 'should emit per-seat state_update to each seat actor');

      // Wolf seat (opus) should see wolf_kill; villager (owner) should NOT
      const wolfEmit = perSeatEmits.find((b) => b.userId === 'opus');
      const villagerEmit = perSeatEmits.find((b) => b.userId === 'owner');
      assert.ok(wolfEmit, 'wolf seat should receive per-seat view');
      assert.ok(villagerEmit, 'villager seat should receive per-seat view');

      const wolfHasKill = wolfEmit.data.view.visibleEvents.some((e) => e.type === 'wolf_kill');
      assert.ok(wolfHasKill, 'wolf should see wolf_kill event');

      const villagerHasKill = villagerEmit.data.view.visibleEvents.some((e) => e.type === 'wolf_kill');
      assert.equal(villagerHasKill, false, 'villager must NOT see wolf_kill event');
    });
  });

  describe('advancePhase — auto-skip when no actors for role', () => {
    it('skips night_guard phase when no guard role exists in seats', async () => {
      // Definition includes night_guard → night_wolf → day_vote
      // But seats have NO guard role — only wolf + villager
      const def = {
        gameType: 'werewolf',
        displayName: 'Werewolf',
        minPlayers: 2,
        maxPlayers: 8,
        roles: [
          { name: 'wolf', faction: 'wolf', description: 'Kills at night' },
          { name: 'villager', faction: 'village', description: 'Votes by day' },
          { name: 'guard', faction: 'village', description: 'Protects at night' },
        ],
        phases: [
          { name: 'night_guard', type: 'night_action', actingRole: 'guard', timeoutMs: 30000, autoAdvance: true },
          { name: 'night_wolf', type: 'night_action', actingRole: 'wolf', timeoutMs: 30000, autoAdvance: true },
          { name: 'day_vote', type: 'day_vote', actingRole: '*', timeoutMs: 60000, autoAdvance: true },
        ],
        actions: [
          { name: 'guard', allowedRole: 'guard', allowedPhase: 'night_guard', targetRequired: true, schema: {} },
          { name: 'kill', allowedRole: 'wolf', allowedPhase: 'night_wolf', targetRequired: true, schema: {} },
          { name: 'vote', allowedRole: '*', allowedPhase: 'day_vote', targetRequired: true, schema: {} },
        ],
        winConditions: [],
      };

      // Seats: wolf + villager — NO guard
      const seats = [
        { seatId: 'P1', actorType: 'cat', actorId: 'opus', role: 'wolf', alive: true, properties: {} },
        { seatId: 'P2', actorType: 'cat', actorId: 'codex', role: 'villager', alive: true, properties: {} },
      ];

      const runtime = await orchestrator.startGame({
        threadId: 'thread-skip-test',
        definition: def,
        seats,
        config: { timeoutMs: 30000, voiceMode: false, humanRole: 'god-view' },
      });

      // Game should start at night_guard but immediately skip to night_wolf
      // because no seat has role 'guard'
      const game = await store.getGame(runtime.gameId);
      assert.notEqual(game.currentPhase, 'night_guard', 'Should NOT stay on night_guard when no guard exists');
      assert.equal(game.currentPhase, 'night_wolf', 'Should auto-skip to night_wolf');

      // Should have a phase_skip event for the skipped phase
      const skipEvent = game.eventLog.find((e) => e.type === 'phase_skip' && e.payload?.skippedPhase === 'night_guard');
      assert.ok(skipEvent, 'Should log a phase_skip event for night_guard');
    });

    it('skips multiple consecutive phases with no actors', async () => {
      // night_guard → night_seer → night_wolf → day_vote
      // Only wolf + villager seats — no guard, no seer
      const def = {
        gameType: 'werewolf',
        displayName: 'Werewolf',
        minPlayers: 2,
        maxPlayers: 8,
        roles: [
          { name: 'wolf', faction: 'wolf', description: 'Kills' },
          { name: 'villager', faction: 'village', description: 'Votes' },
          { name: 'guard', faction: 'village', description: 'Protects' },
          { name: 'seer', faction: 'village', description: 'Divines' },
        ],
        phases: [
          { name: 'night_guard', type: 'night_action', actingRole: 'guard', timeoutMs: 30000, autoAdvance: true },
          { name: 'night_seer', type: 'night_action', actingRole: 'seer', timeoutMs: 30000, autoAdvance: true },
          { name: 'night_wolf', type: 'night_action', actingRole: 'wolf', timeoutMs: 30000, autoAdvance: true },
          { name: 'day_vote', type: 'day_vote', actingRole: '*', timeoutMs: 60000, autoAdvance: true },
        ],
        actions: [
          { name: 'guard', allowedRole: 'guard', allowedPhase: 'night_guard', targetRequired: true, schema: {} },
          { name: 'divine', allowedRole: 'seer', allowedPhase: 'night_seer', targetRequired: true, schema: {} },
          { name: 'kill', allowedRole: 'wolf', allowedPhase: 'night_wolf', targetRequired: true, schema: {} },
          { name: 'vote', allowedRole: '*', allowedPhase: 'day_vote', targetRequired: true, schema: {} },
        ],
        winConditions: [],
      };

      const seats = [
        { seatId: 'P1', actorType: 'cat', actorId: 'opus', role: 'wolf', alive: true, properties: {} },
        { seatId: 'P2', actorType: 'cat', actorId: 'codex', role: 'villager', alive: true, properties: {} },
      ];

      const runtime = await orchestrator.startGame({
        threadId: 'thread-multi-skip',
        definition: def,
        seats,
        config: { timeoutMs: 30000, voiceMode: false, humanRole: 'god-view' },
      });

      const game = await store.getGame(runtime.gameId);
      assert.equal(game.currentPhase, 'night_wolf', 'Should skip guard + seer, land on night_wolf');
    });
  });
});
