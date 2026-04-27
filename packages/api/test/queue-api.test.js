/**
 * Queue Management API tests (F39 Task 4)
 * Tests: GET/DELETE/POST/PATCH queue endpoints with auth + isolation.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import Fastify from 'fastify';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');

/** Build deps with stubs */
function buildDeps(overrides = {}) {
  const invocationQueue = new InvocationQueue();
  return {
    threadStore: {
      get: mock.fn(async (id) => ({
        id,
        title: 'Test Thread',
        createdBy: 'system', // default: public thread
      })),
    },
    invocationQueue,
    queueProcessor: {
      processNext: mock.fn(async () => ({ started: false })),
      isPaused: mock.fn(() => false),
      getPauseReason: mock.fn(() => undefined),
      clearPause: mock.fn(() => {}),
      releaseSlot: mock.fn(() => {}),
      releaseThread: mock.fn(() => {}),
    },
    invocationTracker: {
      has: mock.fn(() => false),
      getUserId: mock.fn(() => null),
      cancel: mock.fn(() => ({ cancelled: false, catIds: [] })),
      getActiveSlots: mock.fn(() => []),
    },
    socketManager: {
      broadcastAgentMessage: mock.fn(),
      broadcastToRoom: mock.fn(),
      emitToUser: mock.fn(),
    },
    ...overrides,
  };
}

/** Enqueue a test entry */
function enqueueEntry(queue, overrides = {}) {
  return queue.enqueue({
    threadId: 't1',
    userId: 'user-a',
    content: 'hello',
    source: 'user',
    targetCats: ['opus'],
    intent: 'execute',
    ...overrides,
  });
}

describe('Queue Management API', () => {
  let app;
  let deps;

  beforeEach(async () => {
    deps = buildDeps();
    const { queueRoutes } = await import('../dist/routes/queue.js');
    app = Fastify();
    await app.register(queueRoutes, deps);
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  // ── Auth ──

  it('returns 401 when userId header missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/t1/queue',
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 404 when thread not found', async () => {
    deps.threadStore.get.mock.mockImplementation(async () => null);
    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/t1/queue',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    assert.equal(res.statusCode, 404);
  });

  it('returns 403 when userId does not match thread owner', async () => {
    deps.threadStore.get.mock.mockImplementation(async () => ({
      id: 't1',
      title: 'Private',
      createdBy: 'user-b', // not system, not user-a
    }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/t1/queue',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('allows access when createdBy is system (default thread)', async () => {
    // Default: createdBy='system' — any user can access
    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/t1/queue',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    assert.equal(res.statusCode, 200);
  });

  // ── User isolation (scopeKey) ──

  it('GET /queue returns only requesting user entries', async () => {
    enqueueEntry(deps.invocationQueue, { userId: 'user-a', content: 'a msg' });
    enqueueEntry(deps.invocationQueue, { userId: 'user-b', content: 'b msg', targetCats: ['codex'] });

    // user-a sees only their entry
    const resA = await app.inject({
      method: 'GET',
      url: '/api/threads/t1/queue',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    const bodyA = JSON.parse(resA.body);
    assert.equal(bodyA.queue.length, 1);
    assert.equal(bodyA.queue[0].content, 'a msg');

    // user-b sees only their entry
    const resB = await app.inject({
      method: 'GET',
      url: '/api/threads/t1/queue',
      headers: { 'x-cat-cafe-user': 'user-b' },
    });
    const bodyB = JSON.parse(resB.body);
    assert.equal(bodyB.queue.length, 1);
    assert.equal(bodyB.queue[0].content, 'b msg');
  });

  it('DELETE /queue/:entryId returns 404 for another user entry', async () => {
    const r = enqueueEntry(deps.invocationQueue, { userId: 'user-a' });
    // user-b tries to delete user-a's entry
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/threads/t1/queue/${r.entry.id}`,
      headers: { 'x-cat-cafe-user': 'user-b' },
    });
    assert.equal(res.statusCode, 404);
  });

  it('DELETE /queue clears only requesting user entries', async () => {
    enqueueEntry(deps.invocationQueue, { userId: 'user-a', targetCats: ['a'] });
    enqueueEntry(deps.invocationQueue, { userId: 'user-a', targetCats: ['b'] });
    enqueueEntry(deps.invocationQueue, { userId: 'user-b', targetCats: ['c'] });

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/threads/t1/queue',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.cleared.length, 2);

    // user-b's entry unaffected
    assert.equal(deps.invocationQueue.list('t1', 'user-b').length, 1);
  });

  it('POST /queue/next only processes requesting user queue', async () => {
    enqueueEntry(deps.invocationQueue, { userId: 'user-a' });
    enqueueEntry(deps.invocationQueue, { userId: 'user-b', targetCats: ['codex'] });

    deps.queueProcessor.processNext.mock.mockImplementation(async (_threadId, userId) => {
      // Simulate processing user's queue
      return { started: true, entry: { userId } };
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/t1/queue/next',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.started, true);

    // Verify processNext was called with user-a
    const call = deps.queueProcessor.processNext.mock.calls[0];
    assert.equal(call.arguments[0], 't1');
    assert.equal(call.arguments[1], 'user-a');
  });

  // ── Functional: GET paused state (P1-2 fix) ──

  it('GET /queue returns paused=true when queueProcessor reports paused', async () => {
    enqueueEntry(deps.invocationQueue);
    // Stub isPaused to return true
    deps.queueProcessor.isPaused = mock.fn(() => true);
    deps.queueProcessor.getPauseReason = mock.fn(() => 'canceled');

    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/t1/queue',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.paused, true);
  });

  it('GET /queue returns paused=false when queueProcessor reports not paused', async () => {
    enqueueEntry(deps.invocationQueue);
    deps.queueProcessor.isPaused = mock.fn(() => false);
    deps.queueProcessor.getPauseReason = mock.fn(() => undefined);

    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/t1/queue',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.paused, false);
  });

  it('GET /queue returns pauseReason when paused', async () => {
    enqueueEntry(deps.invocationQueue);
    deps.queueProcessor.isPaused = mock.fn(() => true);
    deps.queueProcessor.getPauseReason = mock.fn(() => 'failed');

    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/t1/queue',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.paused, true);
    assert.equal(body.pauseReason, 'failed');
  });

  // ── Functional: GET ──

  it('GET /queue returns entries', async () => {
    enqueueEntry(deps.invocationQueue, { content: 'first', targetCats: ['a'] });
    enqueueEntry(deps.invocationQueue, { content: 'second', targetCats: ['b'] });

    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/t1/queue',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.queue.length, 2);
    assert.equal(body.queue[0].content, 'first');
  });

  // ── Functional: DELETE entry ──

  it('DELETE /queue/:entryId removes entry and emits queue_updated', async () => {
    const r = enqueueEntry(deps.invocationQueue);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/threads/t1/queue/${r.entry.id}`,
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(deps.invocationQueue.list('t1', 'user-a').length, 0);

    // Should emit queue_updated
    const emitCalls = deps.socketManager.emitToUser.mock.calls;
    const updateCall = emitCalls.find((c) => c.arguments[1] === 'queue_updated');
    assert.ok(updateCall);
    assert.equal(updateCall.arguments[2].action, 'removed');
  });

  it('DELETE /queue/:entryId rejects processing entry (409)', async () => {
    enqueueEntry(deps.invocationQueue);
    deps.invocationQueue.markProcessing('t1', 'user-a');

    const entries = deps.invocationQueue.list('t1', 'user-a');
    const processingEntry = entries.find((e) => e.status === 'processing');

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/threads/t1/queue/${processingEntry.id}`,
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    assert.equal(res.statusCode, 409);
  });

  // ── Functional: POST next ──

  it('POST /queue/next triggers next entry processing', async () => {
    deps.queueProcessor.processNext.mock.mockImplementation(async () => ({ started: true, entry: { id: 'e1' } }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/t1/queue/next',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.started, true);
  });

  it('POST /queue/next returns started=false when empty', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/t1/queue/next',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.started, false);
  });

  // ── Functional: DELETE clear ──

  it('DELETE /queue clears all entries for user', async () => {
    enqueueEntry(deps.invocationQueue, { targetCats: ['a'] });
    enqueueEntry(deps.invocationQueue, { targetCats: ['b'] });

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/threads/t1/queue',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.cleared.length, 2);
    assert.equal(deps.invocationQueue.list('t1', 'user-a').length, 0);

    // Should emit queue_updated with action='cleared'
    const emitCalls = deps.socketManager.emitToUser.mock.calls;
    const updateCall = emitCalls.find((c) => c.arguments[1] === 'queue_updated');
    assert.ok(updateCall);
    assert.equal(updateCall.arguments[2].action, 'cleared');
  });

  // ── Functional: PATCH move ──

  it('PATCH /queue/:entryId/move up swaps with previous entry', async () => {
    enqueueEntry(deps.invocationQueue, { content: 'first', targetCats: ['a'] });
    const r2 = enqueueEntry(deps.invocationQueue, { content: 'second', targetCats: ['b'] });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/threads/t1/queue/${r2.entry.id}/move`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { direction: 'up' },
    });
    assert.equal(res.statusCode, 200);

    const queue = deps.invocationQueue.list('t1', 'user-a');
    assert.equal(queue[0].content, 'second');
    assert.equal(queue[1].content, 'first');

    // Should emit queue_updated with action='reordered'
    const emitCalls = deps.socketManager.emitToUser.mock.calls;
    const updateCall = emitCalls.find((c) => c.arguments[1] === 'queue_updated');
    assert.ok(updateCall);
    assert.equal(updateCall.arguments[2].action, 'reordered');
  });

  it('PATCH /queue/:entryId/move down swaps with next entry', async () => {
    const r1 = enqueueEntry(deps.invocationQueue, { content: 'first', targetCats: ['a'] });
    enqueueEntry(deps.invocationQueue, { content: 'second', targetCats: ['b'] });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/threads/t1/queue/${r1.entry.id}/move`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { direction: 'down' },
    });
    assert.equal(res.statusCode, 200);

    const queue = deps.invocationQueue.list('t1', 'user-a');
    assert.equal(queue[0].content, 'second');
  });

  it('PATCH /queue/:entryId/move rejects processing entry (409)', async () => {
    enqueueEntry(deps.invocationQueue);
    deps.invocationQueue.markProcessing('t1', 'user-a');

    const entries = deps.invocationQueue.list('t1', 'user-a');
    const processingEntry = entries.find((e) => e.status === 'processing');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/threads/t1/queue/${processingEntry.id}/move`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { direction: 'up' },
    });
    assert.equal(res.statusCode, 409);
  });

  // ── Functional: POST steer ──

  it('POST /queue/:entryId/steer promote moves entry to front of queued entries', async () => {
    enqueueEntry(deps.invocationQueue, { content: 'first', targetCats: ['opus'] });
    const r2 = enqueueEntry(deps.invocationQueue, { content: 'second', targetCats: ['codex'] });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${r2.entry.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { mode: 'promote' },
    });
    assert.equal(res.statusCode, 200);

    const queue = deps.invocationQueue.list('t1', 'user-a');
    assert.equal(queue[0].content, 'second');
    assert.equal(queue[1].content, 'first');
  });

  it('POST /queue/:entryId/steer returns 409 when entry is processing', async () => {
    enqueueEntry(deps.invocationQueue);
    deps.invocationQueue.markProcessing('t1', 'user-a');
    const entries = deps.invocationQueue.list('t1', 'user-a');
    const processingEntry = entries.find((e) => e.status === 'processing');

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${processingEntry.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { mode: 'promote' },
    });
    assert.equal(res.statusCode, 409);
  });

  it('POST /queue/:entryId/steer immediate cancels active invocation and starts processing', async () => {
    const r1 = enqueueEntry(deps.invocationQueue, { content: 'first' });
    enqueueEntry(deps.invocationQueue, { content: 'second' });

    deps.invocationTracker.has = mock.fn(() => true);
    deps.invocationTracker.getUserId = mock.fn(() => 'user-a');
    deps.invocationTracker.cancel = mock.fn(() => ({ cancelled: true, catIds: ['codex'] }));
    deps.queueProcessor.processNext = mock.fn(async () => ({ started: true, entry: { id: r1.entry.id } }));

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${r1.entry.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { mode: 'immediate' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(deps.invocationTracker.cancel.mock.calls.length, 1);
    assert.equal(deps.queueProcessor.processNext.mock.calls.length, 1);
    // Bugfix: steer must broadcast cancel+done so frontend clears old invocation's "正在回复中"
    const broadcastCalls = deps.socketManager.broadcastAgentMessage.mock.calls;
    assert.ok(broadcastCalls.length >= 2, 'should broadcast system_info + done for canceled invocation');
    const doneCall = broadcastCalls.find((c) => c.arguments[0].type === 'done');
    assert.ok(doneCall, 'should broadcast done event to clear frontend loading state');
    assert.equal(doneCall.arguments[0].isFinal, true);
  });

  it('POST /queue/:entryId/steer immediate releases QueueProcessor mutex after cancel (P2 race)', async () => {
    const r1 = enqueueEntry(deps.invocationQueue, { content: 'first' });
    enqueueEntry(deps.invocationQueue, { content: 'second' });

    deps.invocationTracker.has = mock.fn(() => true);
    deps.invocationTracker.getUserId = mock.fn(() => 'user-a');
    deps.invocationTracker.cancel = mock.fn(() => ({ cancelled: true, catIds: ['codex'] }));

    let locked = true;
    deps.queueProcessor.releaseSlot = mock.fn(() => {
      locked = false;
    });
    deps.queueProcessor.processNext = mock.fn(async () => {
      if (locked) return { started: false };
      return { started: true, entry: { id: r1.entry.id } };
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${r1.entry.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { mode: 'immediate' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(deps.queueProcessor.releaseSlot.mock.calls.length, 1);
  });

  it('POST /queue/:entryId/steer immediate scopes cancel broadcast to steered cat only (P1 cloud review)', async () => {
    const r1 = enqueueEntry(deps.invocationQueue, { content: 'first', targetCats: ['opus'] });
    enqueueEntry(deps.invocationQueue, { content: 'second' });

    deps.invocationTracker.has = mock.fn(() => true);
    deps.invocationTracker.getUserId = mock.fn(() => 'user-a');
    // cancel returns multi-cat catIds (co-dispatched), but steer targets only opus
    deps.invocationTracker.cancel = mock.fn(() => ({ cancelled: true, catIds: ['opus', 'codex'] }));
    deps.queueProcessor.processNext = mock.fn(async () => ({ started: true, entry: { id: r1.entry.id } }));

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${r1.entry.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { mode: 'immediate' },
    });
    assert.equal(res.statusCode, 200);

    // done should only be broadcast for opus (the steered cat), NOT codex
    const broadcastCalls = deps.socketManager.broadcastAgentMessage.mock.calls;
    const doneCalls = broadcastCalls.filter((c) => c.arguments[0].type === 'done');
    assert.equal(doneCalls.length, 1, 'should broadcast exactly 1 done event (steered cat only)');
    assert.equal(doneCalls[0].arguments[0].catId, 'opus');
    // codex should NOT receive a done event
    const codexDone = broadcastCalls.find((c) => c.arguments[0].type === 'done' && c.arguments[0].catId === 'codex');
    assert.equal(codexDone, undefined, 'codex should NOT receive cancel done when not steered');
  });

  it('POST /queue/:entryId/steer promote works on agent-sourced entries (F122B)', async () => {
    // Agent entry under user-a's scope (A2A on behalf of user)
    const r1 = enqueueEntry(deps.invocationQueue, {
      content: 'A2A handoff',
      source: 'agent',
      autoExecute: true,
      callerCatId: 'codex',
    });
    // User entry after it
    enqueueEntry(deps.invocationQueue, { content: 'user msg', targetCats: ['codex'] });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${r1.entry.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { mode: 'promote' },
    });
    assert.equal(res.statusCode, 200);
    // Agent entry should be promoted to front
    const queue = deps.invocationQueue.list('t1', 'user-a');
    assert.equal(queue[0].source, 'agent', 'agent entry should be first after promote');
  });

  it('POST /queue/:entryId/steer returns 404 for another user entry', async () => {
    const r = enqueueEntry(deps.invocationQueue, { userId: 'user-a' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${r.entry.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-b', 'content-type': 'application/json' },
      payload: { mode: 'promote' },
    });
    assert.equal(res.statusCode, 404);
  });

  // ── F122B AC-B9: Per-cat cancel ──

  it('POST /cancel/:catId cancels active cat and broadcasts done (AC-B9)', async () => {
    deps.invocationTracker.has = mock.fn(() => true);
    deps.invocationTracker.cancel = mock.fn(() => ({ cancelled: true, catIds: ['opus'] }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/t1/cancel/opus',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.cancelled, true);
    assert.deepEqual(deps.invocationTracker.cancel.mock.calls[0].arguments, ['t1', 'opus', 'user-a', 'user_cancel']);

    // Should broadcast done for opus
    const doneCalls = deps.socketManager.broadcastAgentMessage.mock.calls.filter((c) => c.arguments[0].type === 'done');
    assert.equal(doneCalls.length, 1);
    assert.equal(doneCalls[0].arguments[0].catId, 'opus');
  });

  it('POST /cancel/:catId returns 404 when cat is not active (AC-B9)', async () => {
    deps.invocationTracker.has = mock.fn(() => false);

    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/t1/cancel/codex',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'CAT_NOT_ACTIVE');
  });

  // ── F175 Task 6: PATCH /queue/reorder ──

  it('PATCH /queue/reorder sets positions on multiple entries (F175)', async () => {
    const r1 = enqueueEntry(deps.invocationQueue, { content: 'a' });
    const r2 = enqueueEntry(deps.invocationQueue, { content: 'b' });
    const r3 = enqueueEntry(deps.invocationQueue, { content: 'c' });

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/threads/t1/queue/reorder',
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: {
        positions: [
          { entryId: r3.entry.id, position: 0 },
          { entryId: r1.entry.id, position: 1 },
          { entryId: r2.entry.id, position: 2 },
        ],
      },
    });
    assert.equal(res.statusCode, 200);

    const next = deps.invocationQueue.peekOldestAcrossUsers('t1');
    assert.equal(next.content, 'c', 'entry c should be first after reorder');

    const emitCalls = deps.socketManager.emitToUser.mock.calls;
    const updateCall = emitCalls.find((c) => c.arguments[1] === 'queue_updated');
    assert.ok(updateCall);
    assert.equal(updateCall.arguments[2].action, 'reordered');
  });

  it('PATCH /queue/reorder rejects position on processing entry (F175)', async () => {
    enqueueEntry(deps.invocationQueue, { content: 'a' });
    deps.invocationQueue.markProcessing('t1', 'user-a');
    const entries = deps.invocationQueue.list('t1', 'user-a');
    const processingEntry = entries.find((e) => e.status === 'processing');

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/threads/t1/queue/reorder',
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { positions: [{ entryId: processingEntry.id, position: 0 }] },
    });
    assert.equal(res.statusCode, 400);
  });

  it('PATCH /queue/reorder rejects invalid body (F175)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/threads/t1/queue/reorder',
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { positions: 'not-an-array' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('P2-4: PATCH /queue/reorder does not partial-write on failure', async () => {
    const r1 = enqueueEntry(deps.invocationQueue, { content: 'a' });
    enqueueEntry(deps.invocationQueue, { content: 'b' });

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/threads/t1/queue/reorder',
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: {
        positions: [
          { entryId: r1.entry.id, position: 5 },
          { entryId: 'nonexistent', position: 0 },
        ],
      },
    });
    assert.equal(res.statusCode, 400);

    const entries = deps.invocationQueue.list('t1', 'user-a');
    const first = entries.find((e) => e.id === r1.entry.id);
    assert.equal(first.position, undefined, 'first entry position should NOT be written when batch fails');
  });
});
