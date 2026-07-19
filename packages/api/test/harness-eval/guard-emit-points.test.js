/**
 * F257 V2/Phase B — API-route emit points behavior (AC-B1 route-layer side).
 *
 * Focus: the CONDITIONAL emit semantics on the hold-ball schema 400 —
 * only the ungrounded-timer reject (wakeAfterMs without waitSourceRef,
 * the PR-O3 structural pot) is a pot firing; ordinary schema violations
 * are plain input errors and must NOT enter the ledger.
 *
 * The 429 emit is covered by the coalescing/escalation suites; skip /
 * gate-keeping / publish-403 emits are same-shape mechanical wiring
 * (declared in the PR body for reviewer verification).
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';
import Fastify from 'fastify';

describe('F257 V2: hold-ball route conditional guard emit', () => {
  let registry;
  let threadStore;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { ThreadStore } = await import('../../dist/domains/cats/services/stores/ports/ThreadStore.js');
    registry = new InvocationRegistry();
    threadStore = new ThreadStore();
  });

  function makeFakeLog() {
    const appended = [];
    return {
      append: mock.fn(async (event) => {
        appended.push(event);
      }),
      _appended: appended,
    };
  }

  async function createApp(guardRejectionLog) {
    const { callbacksRoutes } = await import('../../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore: {
        async getMessagesForThread() {
          return [];
        },
      },
      socketManager: {
        broadcastAgentMessage() {},
        getMessages() {
          return [];
        },
      },
      threadStore,
      evidenceStore: {
        async store() {},
        async search() {
          return [];
        },
      },
      markerQueue: { enqueue() {} },
      reflectionService: { async run() {} },
      holdBallDeps: {
        registry,
        taskRunner: { registerDynamic() {}, unregister() {} },
        templateRegistry: { get() {} },
        dynamicTaskStore: { insert() {}, getAll: () => [], remove: () => true },
        messageStore: { async append() {} },
        socketManager: { broadcastToRoom() {} },
        guardRejectionLog,
      },
    });
    return app;
  }

  test('ungrounded timer 400 emits http_schema_reject with full octet + response ledgerId', async () => {
    const log = makeFakeLog();
    const app = await createApp(log);
    const thread = await threadStore.create('user-ep-1', 'ep1');
    const { invocationId, callbackToken } = await registry.create('user-ep-1', 'codex', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      // wakeAfterMs WITHOUT waitSourceRef — the PR-O3 structural pot.
      payload: { reason: 'waiting for CI', nextStep: 'check build', wakeAfterMs: 60_000 },
    });

    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.equal(body.ledgerId, 'mcp/hold-ball-wait-source-ref', 'rejection response carries the pot coordinate');

    // Fire-and-forget append — give it a tick to settle.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(log._appended.length, 1, 'exactly one guard event for the pot firing');
    const event = log._appended[0];
    assert.equal(event.kind, 'http_schema_reject');
    assert.equal(event.guardId, 'hold_ball_wait_source_ref');
    assert.equal(event.ledgerId, 'mcp/hold-ball-wait-source-ref');
    assert.equal(event.catId, 'codex');
    assert.equal(event.threadId, thread.id);
    assert.equal(event.invocationId, invocationId, 'route handler has the real invocationId');
    assert.equal(event.correlationConfidence, 'exact');
    assert.equal(event.sourceTool, 'hold_ball');
    assert.equal(event.normalizedReason, 'missing_wait_source_ref');
    assert.equal(event.layer, 'api-route');
  });

  test('ordinary schema 400 (missing reason, wakeWhen mode) does NOT emit — not a pot', async () => {
    const log = makeFakeLog();
    const app = await createApp(log);
    const thread = await threadStore.create('user-ep-2', 'ep2');
    const { invocationId, callbackToken } = await registry.create('user-ep-2', 'codex', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      // Missing `reason` — a plain input error. wakeWhen mode is self-grounded,
      // so the ungrounded-timer condition does not apply.
      payload: { nextStep: 'check build', wakeWhen: { command: 'echo ok' } },
    });

    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.equal(body.ledgerId, undefined, 'no pot coordinate on ordinary input errors');

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(log._appended.length, 0, 'ordinary schema violations must not enter the ledger');
  });
});
