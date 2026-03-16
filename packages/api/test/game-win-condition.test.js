import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * P1-3: advancePhase must call checkWinCondition and set status='finished' when a side wins.
 * RED test — should fail until GameOrchestrator integrates win check.
 */

/** Stub game store — in-memory */
function createStubStore() {
  const games = new Map();
  return {
    async createGame(runtime) {
      games.set(runtime.gameId, structuredClone(runtime));
      return runtime;
    },
    async getGame(gameId) {
      const g = games.get(gameId);
      return g ? structuredClone(g) : null;
    },
    async updateGame(gameId, runtime) {
      games.set(gameId, structuredClone(runtime));
    },
    async deleteGame(gameId) {
      games.delete(gameId);
    },
    _games: games,
  };
}

/** Stub socket */
function createStubSocket() {
  const events = [];
  return {
    broadcastToRoom(room, event, data) {
      events.push({ room, event, data });
    },
    emitToUser(userId, event, data) {
      events.push({ userId, event, data });
    },
    events,
  };
}

/** Build a werewolf runtime where all wolves are dead (village should win) */
function buildWolvesDeadRuntime(gameId = 'game-win-1') {
  return {
    gameId,
    threadId: 'thread-1',
    gameType: 'werewolf',
    definition: {
      gameType: 'werewolf',
      displayName: 'Werewolf',
      minPlayers: 6,
      maxPlayers: 12,
      roles: [
        { name: 'wolf', faction: 'wolf', description: 'wolf' },
        { name: 'seer', faction: 'village', description: 'seer' },
        { name: 'villager', faction: 'village', description: 'villager' },
      ],
      phases: [
        { name: 'night_wolf', timeoutMs: 30000 },
        { name: 'day_vote', timeoutMs: 60000 },
      ],
      actions: [],
      winConditions: [],
    },
    seats: [
      { seatId: 'P1', actorType: 'cat', actorId: 'opus', role: 'wolf', alive: false, properties: {} },
      { seatId: 'P2', actorType: 'cat', actorId: 'codex', role: 'seer', alive: true, properties: {} },
      { seatId: 'P3', actorType: 'human', actorId: 'owner', role: 'villager', alive: true, properties: {} },
    ],
    currentPhase: 'day_vote',
    round: 2,
    eventLog: [
      {
        eventId: 'e1',
        round: 2,
        phase: 'day_vote',
        type: 'vote_result',
        scope: 'public',
        payload: { exiled: 'P1' },
        timestamp: 1000,
      },
    ],
    pendingActions: {},
    status: 'playing',
    config: { timeoutMs: 30000, voiceMode: false, humanRole: 'god-view' },
    version: 5,
    phaseStartedAt: Date.now() - 60001, // expired
    createdAt: 1000,
    updatedAt: Date.now(),
  };
}

/** Build a runtime where wolves outnumber villagers (wolf should win) */
function buildWolvesWinRuntime(gameId = 'game-win-2') {
  return {
    ...buildWolvesDeadRuntime(gameId),
    seats: [
      { seatId: 'P1', actorType: 'cat', actorId: 'opus', role: 'wolf', alive: true, properties: {} },
      { seatId: 'P2', actorType: 'cat', actorId: 'codex', role: 'seer', alive: false, properties: {} },
      { seatId: 'P3', actorType: 'human', actorId: 'owner', role: 'villager', alive: false, properties: {} },
    ],
    currentPhase: 'night_wolf',
  };
}

describe('P1-3: advancePhase triggers checkWinCondition', () => {
  it('sets status=finished and winner=village when all wolves are dead', async () => {
    const { GameOrchestrator } = await import('../dist/domains/cats/services/game/GameOrchestrator.js');

    const store = createStubStore();
    const socket = createStubSocket();
    const orch = new GameOrchestrator({ gameStore: store, socketManager: socket });

    const runtime = buildWolvesDeadRuntime();
    await store.createGame(runtime);

    // Tick should advance phase, and the new phase should trigger win check
    await orch.tick(runtime.gameId);

    const updated = await store.getGame(runtime.gameId);
    assert.equal(updated.status, 'finished', 'game should be finished when all wolves are dead');
    assert.equal(updated.winner, 'village', 'village should win');

    // Should have a game_end event in the log
    const endEvent = updated.eventLog.find((e) => e.type === 'game_end');
    assert.ok(endEvent, 'should have game_end event');
    assert.equal(endEvent.payload.winner, 'village');
  });

  it('sets status=finished and winner=wolf when wolves >= villagers', async () => {
    const { GameOrchestrator } = await import('../dist/domains/cats/services/game/GameOrchestrator.js');

    const store = createStubStore();
    const socket = createStubSocket();
    const orch = new GameOrchestrator({ gameStore: store, socketManager: socket });

    const runtime = buildWolvesWinRuntime();
    runtime.phaseStartedAt = Date.now() - 60001; // expired
    await store.createGame(runtime);

    await orch.tick(runtime.gameId);

    const updated = await store.getGame(runtime.gameId);
    assert.equal(updated.status, 'finished', 'game should be finished when wolves dominate');
    assert.equal(updated.winner, 'wolf', 'wolf should win');
  });

  it('does NOT finish the game when neither side has won', async () => {
    const { GameOrchestrator } = await import('../dist/domains/cats/services/game/GameOrchestrator.js');

    const store = createStubStore();
    const socket = createStubSocket();
    const orch = new GameOrchestrator({ gameStore: store, socketManager: socket });

    // Both sides still alive
    const runtime = buildWolvesDeadRuntime('game-no-win');
    runtime.seats[0].alive = true; // wolf alive
    runtime.phaseStartedAt = Date.now() - 60001;
    await store.createGame(runtime);

    await orch.tick(runtime.gameId);

    const updated = await store.getGame(runtime.gameId);
    assert.equal(updated.status, 'playing', 'game should still be playing');
  });
});
