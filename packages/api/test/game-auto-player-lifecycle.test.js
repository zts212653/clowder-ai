import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { GameAutoPlayer } from '../dist/domains/cats/services/game/GameAutoPlayer.js';

/** Minimal mock store */
function createMockStore(runtime) {
  return {
    getGame: async () => (runtime ? structuredClone(runtime) : null),
    updateGame: async () => {},
    createGame: async (r) => r,
    getActiveGame: async () => (runtime ? structuredClone(runtime) : null),
    endGame: async () => {},
  };
}

function createMockOrchestrator() {
  const calls = [];
  return {
    handlePlayerAction: async (gameId, seatId, action) => {
      calls.push({ gameId, seatId, action });
    },
    tick: async (gameId) => {
      calls.push({ gameId, type: 'tick' });
    },
    broadcastGameState: async () => {},
    calls,
  };
}

function createTestRuntime(status = 'playing') {
  return {
    gameId: 'game-1',
    threadId: 'thread-1',
    gameType: 'werewolf',
    definition: {
      gameType: 'werewolf',
      displayName: 'Werewolf',
      minPlayers: 6,
      maxPlayers: 12,
      roles: [{ name: 'wolf', faction: 'wolf', description: 'wolf' }],
      phases: [{ name: 'night_wolf', type: 'night_action', actingRole: 'wolf', timeoutMs: 30000, autoAdvance: true }],
      actions: [],
      winConditions: [],
    },
    seats: [{ seatId: 'P1', actorType: 'cat', actorId: 'opus', role: 'wolf', alive: true, properties: {} }],
    currentPhase: 'night_wolf',
    round: 1,
    eventLog: [],
    pendingActions: {},
    status,
    config: { timeoutMs: 30000, voiceMode: false, humanRole: 'god-view' },
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('GameAutoPlayer lifecycle', () => {
  it('does not act when game status is paused', async () => {
    const runtime = createTestRuntime('paused');
    const store = createMockStore(runtime);
    const orchestrator = createMockOrchestrator();
    const autoPlayer = new GameAutoPlayer({ gameStore: store, orchestrator });

    // startLoop runs async; give it a brief moment to attempt actions
    autoPlayer.startLoop('game-1');
    await new Promise((r) => setTimeout(r, 200));
    autoPlayer.stopLoop('game-1');

    // Should not have submitted any player actions (only might have ticked or done nothing)
    const playerActions = orchestrator.calls.filter((c) => c.seatId);
    assert.equal(playerActions.length, 0, 'should not submit actions when paused');
  });

  it('exits loop when game status is finished', async () => {
    const runtime = createTestRuntime('finished');
    const store = createMockStore(runtime);
    const orchestrator = createMockOrchestrator();
    const autoPlayer = new GameAutoPlayer({ gameStore: store, orchestrator });

    autoPlayer.startLoop('game-1');
    await new Promise((r) => setTimeout(r, 200));

    // Loop should have exited — no actions submitted
    const playerActions = orchestrator.calls.filter((c) => c.seatId);
    assert.equal(playerActions.length, 0, 'should not act when finished');
  });
});
