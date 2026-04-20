import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Fastify from 'fastify';
import { GameOrchestrator } from '../dist/domains/cats/services/game/GameOrchestrator.js';
import { WerewolfLobby } from '../dist/domains/cats/services/game/werewolf/WerewolfLobby.js';
import { clearGameNonces, gameActionRoutes } from '../dist/routes/game-actions.js';

function createStubGameStore() {
  const games = new Map();
  const activeByThread = new Map();
  return {
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

function createStubThreadStore(threadId, ownerId) {
  return {
    async get(id) {
      if (id === threadId) return { id: threadId, createdBy: ownerId };
      return null;
    },
  };
}

function createStubSocket() {
  return {
    broadcastToRoom() {},
    emitToUser() {},
  };
}

function makePlayers(count) {
  const catIds = ['opus', 'codex', 'gemini', 'gpt52', 'sonnet', 'dare', 'opencode', 'spark', 'antigravity'];
  return catIds.slice(0, count).map((id) => ({ actorType: 'cat', actorId: id }));
}

async function setupGameForTest(gameStore, socket) {
  const playerCount = 7;
  const lobby = new WerewolfLobby();
  const lobbyRuntime = lobby.createLobby({
    threadId: 'test-thread',
    playerCount,
    players: makePlayers(playerCount),
  });
  lobby.startGame(lobbyRuntime);

  const orchestrator = new GameOrchestrator({ gameStore, socketManager: socket });
  const runtime = await orchestrator.startGame({
    threadId: 'test-thread',
    definition: lobbyRuntime.definition,
    seats: lobbyRuntime.seats,
    config: { viewMode: 'god', voiceMode: false, humanSeat: null },
  });

  return { runtime, orchestrator };
}

const THREAD_OWNER = 'test-user-123';

describe('POST /api/game/:gameId/action — catId enforcement', () => {
  let app;
  let gameStore;
  let runtime;

  before(async () => {
    gameStore = createStubGameStore();
    const socket = createStubSocket();
    const { runtime: r, orchestrator } = await setupGameForTest(gameStore, socket);
    runtime = r;
    const threadStore = createStubThreadStore('test-thread', THREAD_OWNER);

    app = Fastify();
    await app.register(gameActionRoutes, { gameStore, orchestrator, threadStore });
    await app.ready();
  });

  after(async () => {
    clearGameNonces(runtime.gameId);
    await app.close();
  });

  it('rejects request without x-cat-id header (401)', async () => {
    const seat = runtime.seats[0];
    const res = await app.inject({
      method: 'POST',
      url: `/api/game/${runtime.gameId}/action`,
      payload: {
        round: runtime.round,
        phase: runtime.currentPhase,
        seat: parseInt(seat.seatId.slice(1)),
        action: 'kill',
        target: 2,
        nonce: 'test-nonce-1',
      },
    });
    assert.equal(res.statusCode, 401);
    assert.match(res.json().error, /x-cat-id/);
  });

  it('rejects when catId does not match seat actor (403)', async () => {
    const seat = runtime.seats[0];
    const res = await app.inject({
      method: 'POST',
      url: `/api/game/${runtime.gameId}/action`,
      headers: { 'x-cat-id': 'wrong-cat', 'x-cat-cafe-user': THREAD_OWNER },
      payload: {
        round: runtime.round,
        phase: runtime.currentPhase,
        seat: parseInt(seat.seatId.slice(1)),
        action: 'kill',
        target: 2,
        nonce: 'test-nonce-2',
      },
    });
    assert.equal(res.statusCode, 403);
    assert.match(res.json().error, /not the actor/);
  });

  it('accepts valid action with matching catId', async () => {
    const phase = runtime.currentPhase;
    const phaseToRole = { night_guard: 'guard', night_wolf: 'wolf', night_seer: 'seer', night_witch: 'witch' };
    const phaseToAction = { night_guard: 'guard', night_wolf: 'kill', night_seer: 'divine', night_witch: 'heal' };

    const expectedRole = phaseToRole[phase];
    const actionName = phaseToAction[phase];
    assert.ok(expectedRole, `Unexpected starting phase: ${phase}`);

    const seat = runtime.seats.find((s) => s.role === expectedRole);
    assert.ok(seat, `No seat with role ${expectedRole} found`);

    const targetSeat = runtime.seats.find((s) => s.seatId !== seat.seatId && s.alive);
    const res = await app.inject({
      method: 'POST',
      url: `/api/game/${runtime.gameId}/action`,
      headers: { 'x-cat-id': seat.actorId, 'x-cat-cafe-user': THREAD_OWNER },
      payload: {
        round: runtime.round,
        phase,
        seat: parseInt(seat.seatId.slice(1)),
        action: actionName,
        target: parseInt(targetSeat.seatId.slice(1)),
        nonce: 'test-nonce-3',
      },
    });
    assert.equal(res.statusCode, 200, `Expected 200 but got ${res.statusCode}: ${JSON.stringify(res.json())}`);
    assert.equal(res.json().accepted, true);
  });

  it('deduplicates same nonce', async () => {
    const phase = runtime.currentPhase;
    const phaseToRole = { night_guard: 'guard', night_wolf: 'wolf', night_seer: 'seer', night_witch: 'witch' };
    const phaseToAction = { night_guard: 'guard', night_wolf: 'kill', night_seer: 'divine', night_witch: 'heal' };

    const expectedRole = phaseToRole[phase];
    const actionName = phaseToAction[phase];
    const seat = runtime.seats.find((s) => s.role === expectedRole);
    const targetSeat = runtime.seats.find((s) => s.seatId !== seat.seatId && s.alive);
    const res = await app.inject({
      method: 'POST',
      url: `/api/game/${runtime.gameId}/action`,
      headers: { 'x-cat-id': seat.actorId, 'x-cat-cafe-user': THREAD_OWNER },
      payload: {
        round: runtime.round,
        phase,
        seat: parseInt(seat.seatId.slice(1)),
        action: actionName,
        target: parseInt(targetSeat.seatId.slice(1)),
        nonce: 'test-nonce-3',
      },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().deduplicated, true);
  });

  it('rejects action for non-existent game (404)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/game/non-existent/action',
      headers: { 'x-cat-id': 'opus', 'x-cat-cafe-user': THREAD_OWNER },
      payload: {
        round: 1,
        phase: 'night_wolf',
        seat: 1,
        action: 'kill',
        target: 2,
        nonce: 'test-nonce-4',
      },
    });
    assert.equal(res.statusCode, 404);
  });

  it('rejects with round mismatch (409)', async () => {
    const seat = runtime.seats[0];
    const res = await app.inject({
      method: 'POST',
      url: `/api/game/${runtime.gameId}/action`,
      headers: { 'x-cat-id': seat.actorId, 'x-cat-cafe-user': THREAD_OWNER },
      payload: {
        round: 99,
        phase: runtime.currentPhase,
        seat: parseInt(seat.seatId.slice(1)),
        action: 'kill',
        target: 2,
        nonce: 'test-nonce-5',
      },
    });
    assert.equal(res.statusCode, 409);
    assert.match(res.json().error, /Round mismatch/);
  });

  it('rejects request without x-cat-cafe-user header (401)', async () => {
    const seat = runtime.seats[0];
    const res = await app.inject({
      method: 'POST',
      url: `/api/game/${runtime.gameId}/action`,
      headers: { 'x-cat-id': seat.actorId },
      payload: {
        round: runtime.round,
        phase: runtime.currentPhase,
        seat: parseInt(seat.seatId.slice(1)),
        action: 'kill',
        target: 2,
        nonce: 'test-nonce-6',
      },
    });
    assert.equal(res.statusCode, 401);
    assert.match(res.json().error, /x-cat-cafe-user/);
  });

  it('rejects when userId does not own the game thread (403)', async () => {
    const seat = runtime.seats[0];
    const res = await app.inject({
      method: 'POST',
      url: `/api/game/${runtime.gameId}/action`,
      headers: { 'x-cat-id': seat.actorId, 'x-cat-cafe-user': 'intruder-user' },
      payload: {
        round: runtime.round,
        phase: runtime.currentPhase,
        seat: parseInt(seat.seatId.slice(1)),
        action: 'kill',
        target: 2,
        nonce: 'test-nonce-7',
      },
    });
    assert.equal(res.statusCode, 403);
    assert.match(res.json().error, /do not own/);
  });

  it('accepts valid action when callback invocation correlation header is present', async () => {
    const phase = runtime.currentPhase;
    const phaseToRole = { night_guard: 'guard', night_wolf: 'wolf', night_seer: 'seer', night_witch: 'witch' };
    const phaseToAction = { night_guard: 'guard', night_wolf: 'kill', night_seer: 'divine', night_witch: 'heal' };

    const expectedRole = phaseToRole[phase];
    const actionName = phaseToAction[phase];
    const seat = runtime.seats.find((s) => s.role === expectedRole);
    const targetSeat = runtime.seats.find((s) => s.seatId !== seat.seatId && s.alive);

    const res = await app.inject({
      method: 'POST',
      url: `/api/game/${runtime.gameId}/action`,
      headers: {
        'x-cat-id': seat.actorId,
        'x-cat-cafe-user': THREAD_OWNER,
        'x-callback-invocation-id': 'inv-game-123',
      },
      payload: {
        round: runtime.round,
        phase,
        seat: parseInt(seat.seatId.slice(1)),
        action: actionName,
        target: parseInt(targetSeat.seatId.slice(1)),
        nonce: 'test-nonce-8',
      },
    });

    assert.equal(res.statusCode, 200, `Expected 200 but got ${res.statusCode}: ${JSON.stringify(res.json())}`);
    assert.equal(res.json().accepted, true);
  });
});

describe('POST /api/game/:gameId/action — actionNotifier integration', () => {
  let app;
  let runtime;
  let notifiedActions;

  before(async () => {
    const gameStore = createStubGameStore();
    const socket = createStubSocket();
    const { runtime: r, orchestrator } = await setupGameForTest(gameStore, socket);
    runtime = r;
    notifiedActions = [];

    const stubNotifier = {
      onActionReceived(gameId, seatId) {
        notifiedActions.push({ gameId, seatId });
      },
      waitForAction() {
        return Promise.resolve(true);
      },
      waitForAllActions() {
        return Promise.resolve();
      },
      cleanup() {},
    };

    const threadStore = createStubThreadStore('test-thread', THREAD_OWNER);
    app = Fastify();
    await app.register(gameActionRoutes, {
      gameStore,
      orchestrator,
      threadStore,
      actionNotifier: stubNotifier,
    });
    await app.ready();
  });

  after(async () => {
    clearGameNonces(runtime.gameId);
    await app.close();
  });

  it('calls actionNotifier.onActionReceived after successful action', async () => {
    const phase = runtime.currentPhase;
    const phaseToRole = { night_guard: 'guard', night_wolf: 'wolf', night_seer: 'seer', night_witch: 'witch' };
    const phaseToAction = { night_guard: 'guard', night_wolf: 'kill', night_seer: 'divine', night_witch: 'heal' };

    const expectedRole = phaseToRole[phase];
    const actionName = phaseToAction[phase];
    const seat = runtime.seats.find((s) => s.role === expectedRole);
    const targetSeat = runtime.seats.find((s) => s.seatId !== seat.seatId && s.alive);

    const res = await app.inject({
      method: 'POST',
      url: `/api/game/${runtime.gameId}/action`,
      headers: { 'x-cat-id': seat.actorId, 'x-cat-cafe-user': THREAD_OWNER },
      payload: {
        round: runtime.round,
        phase,
        seat: parseInt(seat.seatId.slice(1)),
        action: actionName,
        target: parseInt(targetSeat.seatId.slice(1)),
        nonce: 'notifier-test-1',
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(notifiedActions.length, 1);
    assert.equal(notifiedActions[0].gameId, runtime.gameId);
    assert.equal(notifiedActions[0].seatId, seat.seatId);
  });

  it('does not call actionNotifier on failed action', async () => {
    const beforeCount = notifiedActions.length;
    const res = await app.inject({
      method: 'POST',
      url: `/api/game/${runtime.gameId}/action`,
      headers: { 'x-cat-id': 'wrong-cat', 'x-cat-cafe-user': THREAD_OWNER },
      payload: {
        round: runtime.round,
        phase: runtime.currentPhase,
        seat: 1,
        action: 'kill',
        target: 2,
        nonce: 'notifier-test-2',
      },
    });
    assert.notEqual(res.statusCode, 200);
    assert.equal(notifiedActions.length, beforeCount);
  });
});
