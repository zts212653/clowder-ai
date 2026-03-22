/**
 * GameAutoPlayer Recovery Tests (F101 Phase G)
 *
 * AC-G1: API startup scans active games and restores startLoop()
 * AC-G3: After API restart, playing games resume (not stuck in "waiting")
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { GameAutoPlayer } from '../dist/domains/cats/services/game/GameAutoPlayer.js';
import { GameOrchestrator } from '../dist/domains/cats/services/game/GameOrchestrator.js';

const disableAiFactory = () => null;

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
    async listActiveGames() {
      const result = [];
      for (const [threadId, gameId] of activeByThread.entries()) {
        const game = games.get(gameId);
        if (game) result.push(structuredClone(game));
      }
      return result;
    },
  };
}

function createStubSocket() {
  return {
    broadcastToRoom() {},
    emitToUser() {},
  };
}

function makePlayingGame(gameId, threadId) {
  return {
    gameId,
    threadId,
    gameType: 'werewolf',
    status: 'playing',
    currentPhase: 'night_wolf',
    round: 1,
    seats: [
      { seatId: 'P1', actorType: 'cat', actorId: 'opus', role: 'wolf', alive: true, properties: {} },
      { seatId: 'P2', actorType: 'cat', actorId: 'codex', role: 'villager', alive: true, properties: {} },
      { seatId: 'P3', actorType: 'cat', actorId: 'gemini', role: 'villager', alive: true, properties: {} },
    ],
    definition: {
      gameType: 'werewolf',
      displayName: 'Werewolf',
      minPlayers: 3,
      maxPlayers: 3,
      roles: [
        { name: 'wolf', faction: 'wolf', description: '' },
        { name: 'villager', faction: 'village', description: '' },
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
    },
    eventLog: [],
    pendingActions: {},
    config: { timeoutMs: 30000, voiceMode: false, humanRole: 'observer' },
    phaseStartedAt: Date.now(),
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('AC-G1: listActiveGames returns playing games for recovery', () => {
  it('returns games with status=playing', async () => {
    const store = createStubGameStore();
    const playing = makePlayingGame('game-1', 'thread-1');
    await store.createGame(playing);

    const actives = await store.listActiveGames();
    assert.equal(actives.length, 1);
    assert.equal(actives[0].gameId, 'game-1');
    assert.equal(actives[0].status, 'playing');
  });

  it('does not return finished games', async () => {
    const store = createStubGameStore();
    const playing = makePlayingGame('game-2', 'thread-2');
    await store.createGame(playing);
    await store.endGame('game-2', 'wolf');

    const actives = await store.listActiveGames();
    assert.equal(actives.length, 0);
  });
});

describe('AC-G1: recoverActiveGames restores auto-play loops', () => {
  it('starts loop for each playing game found in store', async () => {
    const store = createStubGameStore();
    const socket = createStubSocket();
    const orchestrator = new GameOrchestrator({ gameStore: store, socketManager: socket });
    const autoPlayer = new GameAutoPlayer({ gameStore: store, orchestrator, aiPlayerFactory: disableAiFactory });

    // Simulate 2 playing games in Redis (as if API restarted)
    await store.createGame(makePlayingGame('game-a', 'thread-a'));
    await store.createGame(makePlayingGame('game-b', 'thread-b'));

    // Recovery should start loops
    const recovered = await autoPlayer.recoverActiveGames();
    assert.equal(recovered, 2, 'should recover 2 games');

    // Verify loops are tracked
    assert.equal(autoPlayer.isLoopActive('game-a'), true, 'game-a loop should be active');
    assert.equal(autoPlayer.isLoopActive('game-b'), true, 'game-b loop should be active');

    // Cleanup
    autoPlayer.stopLoop('game-a');
    autoPlayer.stopLoop('game-b');
  });

  it('skips finished games during recovery', async () => {
    const store = createStubGameStore();
    const socket = createStubSocket();
    const orchestrator = new GameOrchestrator({ gameStore: store, socketManager: socket });
    const autoPlayer = new GameAutoPlayer({ gameStore: store, orchestrator, aiPlayerFactory: disableAiFactory });

    await store.createGame(makePlayingGame('game-c', 'thread-c'));
    await store.endGame('game-c', 'village');

    const recovered = await autoPlayer.recoverActiveGames();
    assert.equal(recovered, 0, 'should not recover finished games');
  });
});

describe('AC-G2: GameAutoPlayer loop lifecycle', () => {
  it('startLoop activates loop and stopLoop deactivates it', async () => {
    const store = createStubGameStore();
    const socket = createStubSocket();
    const orchestrator = new GameOrchestrator({ gameStore: store, socketManager: socket });
    const autoPlayer = new GameAutoPlayer({ gameStore: store, orchestrator, aiPlayerFactory: disableAiFactory });

    await store.createGame(makePlayingGame('game-log', 'thread-log'));
    autoPlayer.startLoop('game-log');

    assert.ok(autoPlayer.isLoopActive('game-log'), 'loop should be active after startLoop');

    await new Promise((r) => setTimeout(r, 1200));
    autoPlayer.stopLoop('game-log');

    assert.ok(!autoPlayer.isLoopActive('game-log'), 'loop should be inactive after stopLoop');
  });
});
