/**
 * GameOrchestrator Fallback + Action Lifecycle Tests (F101 Phase F — Task 3)
 *
 * Tests:
 * - action.requested event logged when action first received
 * - action.submitted event logged on completion
 * - timeout fires → action.timeout for missing seats + action.fallback with random target
 * - grace period: first round gets extra time per cat breed
 * - after fallback → game advances (no stuck phase)
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
    { seatId: 'P2', actorType: 'cat', actorId: 'gemini', role: 'wolf', alive: true, properties: {} },
    { seatId: 'P3', actorType: 'human', actorId: 'owner', role: 'villager', alive: true, properties: {} },
    { seatId: 'P4', actorType: 'cat', actorId: 'codex', role: 'villager', alive: true, properties: {} },
  ];
}

describe('GameOrchestrator — Fallback + Action Lifecycle (F101 Phase F)', () => {
  let store;
  let socket;
  let orchestrator;
  let runtime;

  beforeEach(async () => {
    store = createStubGameStore();
    socket = createStubSocket();
    orchestrator = new GameOrchestrator({ gameStore: store, socketManager: socket });
    runtime = await orchestrator.startGame({
      threadId: 'thread-fallback-test',
      definition: makeDefinition(),
      seats: makeSeats(),
      config: { timeoutMs: 30000, voiceMode: false, humanRole: 'player', humanSeat: 'P3' },
    });
  });

  describe('action lifecycle events', () => {
    it('logs action.requested when action first received', async () => {
      await orchestrator.handlePlayerAction(runtime.gameId, 'P1', {
        seatId: 'P1',
        actionName: 'kill',
        targetSeat: 'P3',
        submittedAt: Date.now(),
      });

      const updated = await store.getGame(runtime.gameId);
      const requested = updated.eventLog.find((e) => e.type === 'action.requested');
      assert.ok(requested, 'should log action.requested event');
      assert.equal(requested.payload.seatId, 'P1');
    });

    it('logs action.submitted when action completed', async () => {
      await orchestrator.handlePlayerAction(runtime.gameId, 'P1', {
        seatId: 'P1',
        actionName: 'kill',
        targetSeat: 'P3',
        submittedAt: Date.now(),
      });

      const updated = await store.getGame(runtime.gameId);
      const submitted = updated.eventLog.find((e) => e.type === 'action.submitted');
      assert.ok(submitted, 'should log action.submitted event');
      assert.equal(submitted.payload.seatId, 'P1');
    });

    it('sets pending action status to acted after submission', async () => {
      await orchestrator.handlePlayerAction(runtime.gameId, 'P1', {
        seatId: 'P1',
        actionName: 'kill',
        targetSeat: 'P3',
        submittedAt: Date.now(),
      });

      const updated = await store.getGame(runtime.gameId);
      const pending = updated.pendingActions['P1'];
      assert.ok(pending, 'should have pending action');
      assert.equal(pending.status, 'acted');
    });
  });

  describe('timeout fallback', () => {
    it('applies fallback for missing seats on timeout', async () => {
      // P1 submits, P2 does not (both wolves)
      await orchestrator.handlePlayerAction(runtime.gameId, 'P1', {
        seatId: 'P1',
        actionName: 'kill',
        targetSeat: 'P3',
        submittedAt: Date.now(),
      });

      // Simulate timeout by backdating phaseStartedAt
      const g = store.games.get(runtime.gameId);
      g.phaseStartedAt = Date.now() - 60000;

      await orchestrator.tick(runtime.gameId);

      const updated = await store.getGame(runtime.gameId);
      const fallbackEvents = updated.eventLog.filter((e) => e.type === 'action.fallback');
      assert.ok(fallbackEvents.length >= 1, 'should have at least 1 fallback event');

      const p2Fallback = fallbackEvents.find((e) => e.payload.seatId === 'P2');
      assert.ok(p2Fallback, 'P2 should have a fallback event');
      assert.equal(p2Fallback.payload.fallbackSource, 'random');
    });

    it('logs action.timeout for missing seats', async () => {
      // No one submits, then timeout
      const g = store.games.get(runtime.gameId);
      g.phaseStartedAt = Date.now() - 60000;

      await orchestrator.tick(runtime.gameId);

      const updated = await store.getGame(runtime.gameId);
      const timeoutEvents = updated.eventLog.filter((e) => e.type === 'action.timeout');
      assert.ok(timeoutEvents.length >= 1, 'should have timeout events');
    });

    it('game advances after fallback (not stuck)', async () => {
      // No one submits, timeout
      const g = store.games.get(runtime.gameId);
      g.phaseStartedAt = Date.now() - 60000;

      await orchestrator.tick(runtime.gameId);

      const updated = await store.getGame(runtime.gameId);
      assert.notEqual(updated.currentPhase, 'night_wolf', 'should have advanced past night_wolf');
    });
  });

  describe('grace period', () => {
    it('does not timeout on round 1 if within grace period', async () => {
      // Gemini (P2) has 30s grace. Total timeout = 30000 + 30000 = 60000
      // Elapsed = 35000 → still within grace
      const g = store.games.get(runtime.gameId);
      g.phaseStartedAt = Date.now() - 35000; // 35s elapsed, base timeout 30s

      await orchestrator.tick(runtime.gameId);

      const updated = await store.getGame(runtime.gameId);
      // Should NOT have advanced because grace period extends the timeout
      assert.equal(updated.currentPhase, 'night_wolf', 'should still be in night_wolf due to grace');
    });

    it('grace period only applies on round 1', async () => {
      // Force round 2
      const g = store.games.get(runtime.gameId);
      g.round = 2;
      g.phaseStartedAt = Date.now() - 35000; // 35s > 30s base timeout

      await orchestrator.tick(runtime.gameId);

      const updated = await store.getGame(runtime.gameId);
      // Should have advanced because no grace period on round 2
      assert.notEqual(updated.currentPhase, 'night_wolf', 'should advance on round 2 without grace');
    });
  });
});
