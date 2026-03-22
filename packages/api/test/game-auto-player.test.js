/**
 * GameAutoPlayer — TDD tests
 *
 * Verifies the auto-play loop submits correct actions for AI cat seats.
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { GameAutoPlayer } from '../dist/domains/cats/services/game/GameAutoPlayer.js';

const disableAiFactory = () => null;

/** Build a minimal GameRuntime for testing */
function buildRuntime(overrides = {}) {
  return {
    gameId: 'game-test-1',
    threadId: 'thread-1',
    gameType: 'werewolf',
    status: 'playing',
    currentPhase: 'night_wolf',
    round: 1,
    seats: [
      { seatId: 'P1', actorType: 'human', actorId: 'user-1', role: 'villager', alive: true, properties: {} },
      { seatId: 'P2', actorType: 'cat', actorId: 'opus', role: 'wolf', alive: true, properties: {} },
      { seatId: 'P3', actorType: 'cat', actorId: 'sonnet', role: 'seer', alive: true, properties: {} },
      { seatId: 'P4', actorType: 'cat', actorId: 'codex', role: 'witch', alive: true, properties: {} },
      { seatId: 'P5', actorType: 'cat', actorId: 'gemini', role: 'villager', alive: true, properties: {} },
      { seatId: 'P6', actorType: 'cat', actorId: 'gpt52', role: 'villager', alive: true, properties: {} },
      { seatId: 'P7', actorType: 'cat', actorId: 'spark', role: 'guard', alive: true, properties: {} },
    ],
    pendingActions: {},
    eventLog: [],
    definition: {
      gameType: 'werewolf',
      phases: [
        { name: 'night_guard', type: 'night_action', actingRole: 'guard', timeoutMs: 30000, autoAdvance: true },
        { name: 'night_wolf', type: 'night_action', actingRole: 'wolf', timeoutMs: 30000, autoAdvance: true },
        { name: 'night_seer', type: 'night_action', actingRole: 'seer', timeoutMs: 30000, autoAdvance: true },
        { name: 'night_witch', type: 'night_action', actingRole: 'witch', timeoutMs: 30000, autoAdvance: true },
        { name: 'night_resolve', type: 'resolve', timeoutMs: 5000, autoAdvance: true },
        { name: 'day_vote', type: 'day_vote', actingRole: '*', timeoutMs: 60000, autoAdvance: true },
      ],
      actions: [
        { name: 'kill', allowedRole: 'wolf', allowedPhase: 'night_wolf', targetRequired: true },
        { name: 'guard', allowedRole: 'guard', allowedPhase: 'night_guard', targetRequired: true },
        { name: 'divine', allowedRole: 'seer', allowedPhase: 'night_seer', targetRequired: true },
        { name: 'heal', allowedRole: 'witch', allowedPhase: 'night_witch', targetRequired: false },
        { name: 'vote', allowedRole: '*', allowedPhase: 'day_vote', targetRequired: true },
      ],
      roles: [
        { name: 'wolf', faction: 'wolf' },
        { name: 'seer', faction: 'village' },
        { name: 'witch', faction: 'village' },
        { name: 'guard', faction: 'village' },
        { name: 'villager', faction: 'village' },
      ],
    },
    config: { timeoutMs: 30000, voiceMode: false, humanRole: 'player', humanSeat: 'P1' },
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('GameAutoPlayer', () => {
  it('submits action for wolf seat during night_wolf phase', async () => {
    const runtime = buildRuntime({ currentPhase: 'night_wolf' });
    const actions = [];
    let callCount = 0;

    const mockStore = {
      getGame: async () => {
        callCount++;
        // First call: playing (auto-player acts), subsequent: finished (stop loop)
        if (callCount > 1) return { ...runtime, status: 'finished' };
        return runtime;
      },
    };
    const mockOrchestrator = {
      handlePlayerAction: async (_gameId, seatId, action) => {
        actions.push({ seatId, action });
        runtime.pendingActions[seatId] = action;
      },
    };

    const autoPlayer = new GameAutoPlayer({
      gameStore: mockStore,
      orchestrator: mockOrchestrator,
      aiPlayerFactory: disableAiFactory,
    });

    // Run one tick manually via actForPhase (exposed via the constructor pattern)
    // Since actForPhase is private, we test via the loop with immediate stop
    // Instead, call startLoop and let it run one tick (store returns finished after first read)
    autoPlayer.startLoop('game-test-1');

    // Wait for the loop to process
    await new Promise((r) => setTimeout(r, 200));

    // Wolf P2 should have submitted a kill action
    assert.equal(actions.length, 1);
    assert.equal(actions[0].seatId, 'P2');
    assert.equal(actions[0].action.actionName, 'kill');
    assert.ok(actions[0].action.targetSeat); // has a target
    assert.notEqual(actions[0].action.targetSeat, 'P2'); // not self
  });

  it('skips human seats (only cat seats act)', async () => {
    const runtime = buildRuntime({ currentPhase: 'day_vote' });
    const actingSeatIds = new Set();
    let callCount = 0;

    const mockStore = {
      getGame: async () => {
        callCount++;
        // Return finished after first call to stop loop
        if (callCount > 1) return { ...runtime, status: 'finished' };
        return runtime;
      },
    };
    const mockOrchestrator = {
      handlePlayerAction: async (_gameId, seatId, action) => {
        actingSeatIds.add(seatId);
        runtime.pendingActions[seatId] = action;
      },
    };

    const autoPlayer = new GameAutoPlayer({
      gameStore: mockStore,
      orchestrator: mockOrchestrator,
      aiPlayerFactory: disableAiFactory,
    });
    autoPlayer.startLoop('game-test-1');

    await new Promise((r) => setTimeout(r, 300));

    // P1 is human — should NOT be in the acting seats
    assert.ok(!actingSeatIds.has('P1'), 'Human seat P1 should not act');
    // All alive cat seats should have voted
    assert.ok(actingSeatIds.has('P2'));
    assert.ok(actingSeatIds.has('P3'));
    assert.ok(actingSeatIds.has('P4'));
    assert.ok(actingSeatIds.has('P5'));
    assert.ok(actingSeatIds.has('P6'));
    assert.ok(actingSeatIds.has('P7'));
  });

  it('calls tick() for resolve/announce phases (no player actions needed)', async () => {
    const runtime = buildRuntime({ currentPhase: 'night_resolve' });
    const actions = [];
    let tickCalled = false;
    let callCount = 0;

    const mockStore = {
      getGame: async () => {
        callCount++;
        if (callCount > 1) return { ...runtime, status: 'finished' };
        return runtime;
      },
    };
    const mockOrchestrator = {
      handlePlayerAction: async (_gameId, seatId, action) => {
        actions.push({ seatId, action });
      },
      tick: async () => {
        tickCalled = true;
      },
    };

    const autoPlayer = new GameAutoPlayer({
      gameStore: mockStore,
      orchestrator: mockOrchestrator,
      aiPlayerFactory: disableAiFactory,
    });
    autoPlayer.startLoop('game-test-1');

    await new Promise((r) => setTimeout(r, 600));

    assert.equal(actions.length, 0, 'No actions should be submitted in resolve phase');
    assert.ok(tickCalled, 'tick() should be called for resolve phases');
  });

  it('stops loop when game status is finished', async () => {
    const runtime = buildRuntime({ status: 'finished' });
    const actions = [];

    const mockStore = {
      getGame: async () => runtime,
    };
    const mockOrchestrator = {
      handlePlayerAction: async (_gameId, seatId, action) => {
        actions.push({ seatId, action });
      },
    };

    const autoPlayer = new GameAutoPlayer({
      gameStore: mockStore,
      orchestrator: mockOrchestrator,
      aiPlayerFactory: disableAiFactory,
    });
    autoPlayer.startLoop('game-test-1');

    await new Promise((r) => setTimeout(r, 200));

    assert.equal(actions.length, 0, 'No actions when game is finished');
  });

  it('does not submit duplicate actions for seats that already acted', async () => {
    const runtime = buildRuntime({
      currentPhase: 'night_wolf',
      pendingActions: { P2: { seatId: 'P2', actionName: 'kill', targetSeat: 'P1', submittedAt: Date.now() } },
    });
    const actions = [];
    let callCount = 0;

    const mockStore = {
      getGame: async () => {
        callCount++;
        if (callCount > 1) return { ...runtime, status: 'finished' };
        return runtime;
      },
    };
    const mockOrchestrator = {
      handlePlayerAction: async (_gameId, seatId, action) => {
        actions.push({ seatId, action });
      },
    };

    const autoPlayer = new GameAutoPlayer({
      gameStore: mockStore,
      orchestrator: mockOrchestrator,
      aiPlayerFactory: disableAiFactory,
    });
    autoPlayer.startLoop('game-test-1');

    await new Promise((r) => setTimeout(r, 200));

    assert.equal(actions.length, 0, 'Should not re-submit for seat that already acted');
  });
});
