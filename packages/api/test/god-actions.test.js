import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { GameOrchestrator } from '../dist/domains/cats/services/game/GameOrchestrator.js';

/** Minimal in-memory game store for testing */
function createMockStore() {
  const games = new Map();
  return {
    createGame: async (runtime) => {
      games.set(runtime.gameId, structuredClone(runtime));
      return runtime;
    },
    getGame: async (id) => (games.has(id) ? structuredClone(games.get(id)) : null),
    getActiveGame: async (threadId) => {
      for (const g of games.values()) {
        if (g.threadId === threadId && g.status !== 'finished') return structuredClone(g);
      }
      return null;
    },
    updateGame: async (id, runtime) => {
      games.set(id, structuredClone(runtime));
    },
    endGame: async (id, reason) => {
      const g = games.get(id);
      if (g) {
        g.status = 'finished';
        g.winner = reason;
      }
    },
  };
}

function createMockSocket() {
  const events = [];
  return {
    broadcastToRoom: (room, event, data) => events.push({ room, event, data }),
    emitToUser: (userId, event, data) => events.push({ userId, event, data }),
    events,
  };
}

function createTestRuntime(threadId, overrides = {}) {
  return {
    gameId: `game-test-${Date.now()}`,
    threadId,
    gameType: 'werewolf',
    definition: {
      gameType: 'werewolf',
      displayName: 'Werewolf',
      minPlayers: 6,
      maxPlayers: 12,
      roles: [
        { name: 'wolf', faction: 'wolf', description: 'wolf' },
        { name: 'villager', faction: 'village', description: 'villager' },
      ],
      phases: [
        { name: 'night_wolf', type: 'night_action', actingRole: 'wolf', timeoutMs: 30000, autoAdvance: true },
        { name: 'day_discuss', type: 'day_discuss', timeoutMs: 30000, autoAdvance: true },
      ],
      actions: [],
      winConditions: [],
    },
    seats: [
      { seatId: 'P1', actorType: 'cat', actorId: 'opus', role: 'wolf', alive: true, properties: {} },
      { seatId: 'P2', actorType: 'cat', actorId: 'sonnet', role: 'villager', alive: true, properties: {} },
    ],
    currentPhase: 'night_wolf',
    round: 1,
    eventLog: [],
    pendingActions: {},
    status: 'playing',
    config: { timeoutMs: 30000, voiceMode: false, humanRole: 'god-view' },
    phaseStartedAt: Date.now(),
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('God Actions', () => {
  let store, socket, orchestrator;

  beforeEach(() => {
    store = createMockStore();
    socket = createMockSocket();
    orchestrator = new GameOrchestrator({ gameStore: store, socketManager: socket });
  });

  it('pauses a playing game', async () => {
    const runtime = createTestRuntime('thread-1');
    await store.createGame(runtime);

    await orchestrator.pauseGame(runtime.gameId);

    const updated = await store.getGame(runtime.gameId);
    assert.equal(updated.status, 'paused');

    const pauseEvent = socket.events.find((e) => e.event === 'game:paused');
    assert.ok(pauseEvent, 'should broadcast game:paused');
  });

  it('resumes a paused game', async () => {
    const runtime = createTestRuntime('thread-2', { status: 'paused' });
    await store.createGame(runtime);

    await orchestrator.resumeGame(runtime.gameId);

    const updated = await store.getGame(runtime.gameId);
    assert.equal(updated.status, 'playing');

    const resumeEvent = socket.events.find((e) => e.event === 'game:resumed');
    assert.ok(resumeEvent, 'should broadcast game:resumed');
  });

  it('skips current phase', async () => {
    const runtime = createTestRuntime('thread-3');
    await store.createGame(runtime);

    await orchestrator.skipPhase(runtime.gameId);

    const updated = await store.getGame(runtime.gameId);
    assert.equal(updated.currentPhase, 'day_discuss', 'should advance to next phase');

    const skipEvent = updated.eventLog.find((e) => e.type === 'god_skip');
    assert.ok(skipEvent, 'should log god_skip event');
  });

  it('rejects pause when not playing (400-equivalent)', async () => {
    const runtime = createTestRuntime('thread-4', { status: 'paused' });
    await store.createGame(runtime);

    await assert.rejects(() => orchestrator.pauseGame(runtime.gameId), { message: /not playing/ });
  });

  it('rejects resume when not paused (400-equivalent)', async () => {
    const runtime = createTestRuntime('thread-5');
    await store.createGame(runtime);

    await assert.rejects(() => orchestrator.resumeGame(runtime.gameId), { message: /not paused/ });
  });

  it('rejects skip when game is paused', async () => {
    const runtime = createTestRuntime('thread-6', { status: 'paused' });
    await store.createGame(runtime);

    await assert.rejects(() => orchestrator.skipPhase(runtime.gameId), { message: /not playing/ });
  });
});
