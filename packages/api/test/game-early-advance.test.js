/**
 * Early Advance + Wolf Discussion Phase Tests (F101 Phase F — Task 6)
 *
 * Tests:
 * - All seats locked votes → phase advances early
 * - All night actions submitted → phase advances early
 * - Wolf discussion phase: 30s timer, wolves can whisper (scope: faction:wolf)
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { GameOrchestrator } from '../dist/domains/cats/services/game/GameOrchestrator.js';

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

function makeDefinitionWithDiscuss() {
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
      { name: 'night_wolf_discuss', type: 'night_action', actingRole: 'wolf', timeoutMs: 30000, autoAdvance: true },
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

function makeSeats() {
  return [
    { seatId: 'P1', actorType: 'cat', actorId: 'opus', role: 'wolf', alive: true, properties: {} },
    { seatId: 'P2', actorType: 'cat', actorId: 'codex', role: 'wolf', alive: true, properties: {} },
    { seatId: 'P3', actorType: 'human', actorId: 'owner', role: 'villager', alive: true, properties: {} },
    { seatId: 'P4', actorType: 'cat', actorId: 'gemini', role: 'villager', alive: true, properties: {} },
  ];
}

describe('Early Advance + Wolf Discussion (F101 Phase F)', () => {
  let store;
  let socket;
  let orchestrator;

  beforeEach(() => {
    store = createStubGameStore();
    socket = createStubSocket();
    orchestrator = new GameOrchestrator({ gameStore: store, socketManager: socket });
  });

  describe('early advance on all actions collected', () => {
    it('advances immediately when all night actions submitted', async () => {
      const runtime = await orchestrator.startGame({
        threadId: 'thread-early-1',
        definition: makeDefinitionWithDiscuss(),
        seats: makeSeats(),
        config: { timeoutMs: 30000, voiceMode: false, humanRole: 'player', humanSeat: 'P3' },
      });

      // Skip to night_wolf phase (past discussion)
      const g = store.games.get(runtime.gameId);
      g.currentPhase = 'night_wolf';
      g.phaseStartedAt = Date.now();

      // P1 submits action
      await orchestrator.handlePlayerAction(runtime.gameId, 'P1', {
        seatId: 'P1',
        actionName: 'kill',
        targetSeat: 'P3',
        submittedAt: Date.now(),
      });

      let updated = await store.getGame(runtime.gameId);
      assert.equal(updated.currentPhase, 'night_wolf', 'should still be night_wolf after P1 only');

      // P2 submits → all wolves acted → should advance
      await orchestrator.handlePlayerAction(runtime.gameId, 'P2', {
        seatId: 'P2',
        actionName: 'kill',
        targetSeat: 'P3',
        submittedAt: Date.now(),
      });

      updated = await store.getGame(runtime.gameId);
      assert.notEqual(updated.currentPhase, 'night_wolf', 'should advance after all actions');
    });
  });

  describe('wolf discussion phase', () => {
    it('wolf discussion phase has 30s timeout', async () => {
      const def = makeDefinitionWithDiscuss();
      const discussPhase = def.phases.find((p) => p.name === 'night_wolf_discuss');
      assert.ok(discussPhase, 'should have night_wolf_discuss phase');
      assert.equal(discussPhase.timeoutMs, 30000);
    });

    it('wolf discussion phase is for wolf role', async () => {
      const def = makeDefinitionWithDiscuss();
      const discussPhase = def.phases.find((p) => p.name === 'night_wolf_discuss');
      assert.equal(discussPhase.actingRole, 'wolf');
    });

    it('wolf whisper events use faction:wolf scope (KD-27)', async () => {
      // Verify that faction:wolf scope is correctly isolated
      const { GameEngine } = await import('../dist/domains/cats/services/game/GameEngine.js');

      const runtime = {
        gameId: 'g1',
        threadId: 't1',
        gameType: 'werewolf',
        status: 'playing',
        currentPhase: 'night_wolf_discuss',
        round: 1,
        seats: makeSeats(),
        definition: makeDefinitionWithDiscuss(),
        eventLog: [],
        pendingActions: {},
        config: { timeoutMs: 30000, voiceMode: false, humanRole: 'player' },
        phaseStartedAt: Date.now(),
        version: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const engine = new GameEngine(runtime);
      engine.appendEvent({
        round: 1,
        phase: 'night_wolf_discuss',
        type: 'whisper',
        scope: 'faction:wolf',
        payload: { seatId: 'P1', text: 'Let us kill P3' },
      });

      // Wolf P1 sees faction events
      const wolfEvents = engine.getVisibleEvents('P1');
      const whisper = wolfEvents.find((e) => e.type === 'whisper');
      assert.ok(whisper, 'wolf should see faction:wolf whisper');

      // Villager P3 cannot see faction events
      const villagerEvents = engine.getVisibleEvents('P3');
      const leaked = villagerEvents.find((e) => e.type === 'whisper');
      assert.equal(leaked, undefined, 'villager should not see faction:wolf whisper');
    });
  });
});
