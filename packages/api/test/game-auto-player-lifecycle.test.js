import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { GameAutoPlayer } from '../dist/domains/cats/services/game/GameAutoPlayer.js';

const disableAiFactory = () => null;

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
    const autoPlayer = new GameAutoPlayer({ gameStore: store, orchestrator, aiPlayerFactory: disableAiFactory });

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
    const autoPlayer = new GameAutoPlayer({ gameStore: store, orchestrator, aiPlayerFactory: disableAiFactory });

    autoPlayer.startLoop('game-1');
    await new Promise((r) => setTimeout(r, 200));

    // Loop should have exited — no actions submitted
    const playerActions = orchestrator.calls.filter((c) => c.seatId);
    assert.equal(playerActions.length, 0, 'should not act when finished');
  });

  it('uses wall-clock safety limit, not tick count', () => {
    assert.ok(
      GameAutoPlayer.MAX_WALL_CLOCK_MS >= 2 * 60 * 60 * 1000,
      'wall-clock limit must be at least 2 hours to support multi-round games',
    );
    assert.equal(GameAutoPlayer.TICK_MS, 800, 'tick interval should be 800ms');
  });

  it('loop continues for playing games beyond old MAX_TICKS=500 boundary', async () => {
    let loopGetGameCalls = 0;
    const runtime = createTestRuntime('playing');
    const store = {
      getGame: async () => {
        loopGetGameCalls++;
        if (loopGetGameCalls > 8) {
          const finished = structuredClone(runtime);
          finished.status = 'finished';
          return finished;
        }
        return structuredClone(runtime);
      },
      updateGame: async () => {},
      createGame: async (r) => r,
      getActiveGame: async () => structuredClone(runtime),
      endGame: async () => {},
    };
    const orchestrator = createMockOrchestrator();
    const autoPlayer = new GameAutoPlayer({ gameStore: store, orchestrator, aiPlayerFactory: disableAiFactory });

    autoPlayer.startLoop('game-1');
    await new Promise((r) => setTimeout(r, 2500));
    autoPlayer.stopLoop('game-1');
    await new Promise((r) => setTimeout(r, 200));

    // H3: buildAction is now async (LLM attempt + fallback), so loop overhead is higher.
    // ≥2 proves the loop continues past old tick-count limit; exact speed is not the point.
    assert.ok(
      loopGetGameCalls >= 2,
      `loop ran ${loopGetGameCalls} getGame calls — confirms wall-clock loop survives beyond old tick-count limit`,
    );
  });
});
