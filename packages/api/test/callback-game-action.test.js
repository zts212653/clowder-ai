/**
 * Callback Game Action Tests
 * POST /api/callbacks/submit-game-action
 *
 * Verifies non-Claude cats (OpenCode/Codex/Gemini) can submit game actions
 * via HTTP callback auth, proxied to the existing game action route.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';

describe('Callback Game Action', () => {
  let registry;
  let threadStore;
  let messageStore;
  let socketManager;
  let gameStore;
  let orchestrator;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    registry = new InvocationRegistry();
    threadStore = new ThreadStore();
    messageStore = new MessageStore();
    socketManager = {
      broadcastAgentMessage() {},
      getMessages() {
        return [];
      },
    };

    // Minimal game store stub
    const games = new Map();
    gameStore = {
      async getGame(id) {
        return games.get(id) ?? null;
      },
      _set(id, runtime) {
        games.set(id, runtime);
      },
    };

    // Minimal orchestrator stub — captures the last action for assertions
    orchestrator = {
      _lastAction: null,
      async handlePlayerAction(gameId, seatId, action) {
        orchestrator._lastAction = { gameId, seatId, action };
      },
    };
  });

  async function createApp() {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const { gameActionRoutes } = await import('../dist/routes/game-actions.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      threadStore,
    });
    await app.register(gameActionRoutes, {
      gameStore,
      orchestrator,
      threadStore,
    });
    return app;
  }

  function makeRuntime(gameId, threadId, userId, catId) {
    return {
      gameId,
      threadId,
      round: 1,
      currentPhase: 'night_wolf',
      status: 'playing',
      seats: [
        { seatId: 'P1', actorId: catId, role: 'wolf', alive: true },
        { seatId: 'P2', actorId: 'npc-2', role: 'villager', alive: true },
      ],
      eventLog: [],
    };
  }

  test('returns 401 with invalid callback credentials', async () => {
    const app = await createApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/submit-game-action',
      payload: {
        invocationId: 'fake',
        callbackToken: 'fake',
        gameId: 'game-1',
        round: 1,
        phase: 'night_wolf',
        seat: 1,
        action: 'kill',
        target: 2,
        nonce: 'nonce-1',
      },
    });
    assert.equal(response.statusCode, 401);
  });

  test('returns 400 with missing required fields', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'codex');
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/submit-game-action',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        // missing gameId, round, phase, seat, action, nonce
      },
    });
    assert.equal(response.statusCode, 400);
  });

  test('proxies valid action to game action route and returns accepted', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', 'game thread');
    const { invocationId, callbackToken } = registry.create('user-1', 'codex', thread.id);
    const runtime = makeRuntime('game-1', thread.id, 'user-1', 'codex');
    gameStore._set('game-1', runtime);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/submit-game-action',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        gameId: 'game-1',
        round: 1,
        phase: 'night_wolf',
        seat: 1,
        action: 'kill',
        target: 2,
        nonce: 'nonce-abc',
      },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.accepted, true);
    assert.deepEqual(orchestrator._lastAction.seatId, 'P1');
    assert.deepEqual(orchestrator._lastAction.action.actionName, 'kill');
    assert.deepEqual(orchestrator._lastAction.action.targetSeat, 'P2');
  });

  test('returns 404 when game does not exist', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', 'game thread');
    const { invocationId, callbackToken } = registry.create('user-1', 'codex', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/submit-game-action',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        gameId: 'nonexistent',
        round: 1,
        phase: 'night_wolf',
        seat: 1,
        action: 'kill',
        target: 2,
        nonce: 'nonce-1',
      },
    });

    assert.equal(response.statusCode, 404);
  });

  test('returns 403 when caller is not the actor for the seat', async () => {
    const app = await createApp();
    const thread = await threadStore.create('user-1', 'game thread');
    const { invocationId, callbackToken } = registry.create('user-1', 'gemini', thread.id);
    const runtime = makeRuntime('game-2', thread.id, 'user-1', 'codex'); // seat owned by codex
    gameStore._set('game-2', runtime);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/submit-game-action',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        gameId: 'game-2',
        round: 1,
        phase: 'night_wolf',
        seat: 1,
        action: 'kill',
        target: 2,
        nonce: 'nonce-2',
      },
    });

    assert.equal(response.statusCode, 403);
  });

  test('returns 403 when invocation threadId differs from game threadId (cross-game isolation)', async () => {
    const app = await createApp();
    const threadA = await threadStore.create('user-1', 'game A thread');
    const threadB = await threadStore.create('user-1', 'game B thread');

    // Invocation bound to threadA
    const { invocationId, callbackToken } = registry.create('user-1', 'codex', threadA.id);

    // Game belongs to threadB (same user, same cat, different thread)
    const runtime = makeRuntime('game-B', threadB.id, 'user-1', 'codex');
    gameStore._set('game-B', runtime);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/submit-game-action',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        gameId: 'game-B',
        round: 1,
        phase: 'night_wolf',
        seat: 1,
        action: 'kill',
        target: 2,
        nonce: 'nonce-cross',
      },
    });

    assert.equal(response.statusCode, 403);
    const body = JSON.parse(response.body);
    assert.ok(body.error.includes('thread'), 'error should mention thread mismatch');
    assert.equal(orchestrator._lastAction, null, 'action should NOT have been submitted');
  });
});
