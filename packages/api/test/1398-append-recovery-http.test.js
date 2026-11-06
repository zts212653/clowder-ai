import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { queueRoutes } from '../dist/routes/queue.js';
import { appendRecoveryFixture } from './helpers/append-recovery-fixture.js';

for (const acceptance of ['not_accepted', 'unknown']) {
  test(`actual Append HTTP returns durable ${acceptance} recovery instead of a false delivery error`, async (t) => {
    const f = await appendRecoveryFixture(async () => ({ accepted: false, reason: 'active_run_closed', acceptance }));
    const app = Fastify();
    t.after(() => app.close());
    await app.register(queueRoutes, {
      threadStore: { get: async (id) => (id === 'thread' ? { id, createdBy: 'owner' } : null) },
      invocationQueue: f.queue,
      queueProcessor: f.processor,
      invocationTracker: f.invocationTracker,
      messageStore: f.messageStore,
      socketManager: { emitToUser() {}, broadcastAgentMessage() {}, getActiveInvocations: () => [] },
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/threads/thread/queue/${f.admission.entry.id}/append`,
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: {
        expectedQueueRevision: f.queue.snapshotRevision('thread', 'owner'),
        expectedRuns: [{ targetId: 'opus', invocationId: 'turn', responseMessageId: f.response.id }],
      },
    });
    assert.equal(response.statusCode, 202, response.body);
    assert.equal(response.json().outcome, 'recovered');
    assert.equal(response.json().recovery[0].acceptance, acceptance);
    if (acceptance === 'not_accepted') assert.equal(response.json().queue[0].id, f.admission.entry.id);
    else assert.deepEqual(response.json().queue, []);
  });
}

test('actual History HTTP offers a new input without any Queue row, and deduplicates repeat clicks', async (t) => {
  const f = await appendRecoveryFixture(async () => ({ accepted: false, reason: 'exception', acceptance: 'unknown' }));
  await f.append();
  await f.processor.requestDrain('thread');
  await f.processor.reconcileAppendDeliveries('thread');
  const app = Fastify();
  t.after(() => app.close());
  await app.register(queueRoutes, {
    threadStore: { get: async (id) => (id === 'thread' ? { id, createdBy: 'owner' } : null) },
    invocationQueue: f.queue,
    queueProcessor: f.processor,
    invocationTracker: f.invocationTracker,
    messageStore: f.messageStore,
    socketManager: { emitToUser() {}, broadcastAgentMessage() {}, getActiveInvocations: () => [] },
  });
  const headers = { 'x-cat-cafe-user': 'owner' };
  const snapshot = await app.inject({ method: 'GET', url: '/api/threads/thread/queue', headers });
  assert.equal(snapshot.statusCode, 200, snapshot.body);
  assert.deepEqual(snapshot.json().queue, []);
  const method = 'POST';
  const url = `/api/threads/thread/messages/${f.admission.message.id}/routing-targets/opus/repeat`;
  const payload = { expectedResponseMessageId: f.response.id, expectedInvocationId: 'turn' };
  assert.equal((await app.inject({ method, url })).statusCode, 401);
  assert.equal((await app.inject({ method, url, headers: { 'x-cat-cafe-user': 'someone-else' } })).statusCode, 403);
  assert.equal(
    (await app.inject({ method, url, headers: { ...headers, origin: 'http://localhost:3100' } })).statusCode,
    401,
  );
  const [retried, concurrent] = await Promise.all([
    app.inject({ method, url, headers, payload }),
    app.inject({ method, url, headers, payload }),
  ]);
  assert.equal(concurrent.statusCode, 202, concurrent.body);
  assert.equal(concurrent.json().messageId, retried.json().messageId);
  assert.equal(retried.statusCode, 202, retried.body);
  assert.equal(retried.json().status, 'repeated');
  assert.notEqual(retried.json().messageId, f.admission.message.id);
  const replay = await app.inject({ method, url, headers, payload });
  assert.equal(replay.statusCode, 202, replay.body);
  assert.equal(replay.json().messageId, retried.json().messageId);
  const original = await f.queue.getDurableEntry('thread', f.admission.entry.id);
  assert.equal(original, null);
  const repeated = await f.queue.getDurableEntry('thread', retried.json().entryId);
  assert.ok(repeated);
  assert.deepEqual(repeated.targets, ['opus']);
  assert.equal(repeated.payload.content, f.admission.message.content);
  assert.equal(
    f.messageStore
      .getByThread('thread', 100, 'owner', { includeQueuedUserMessages: true })
      .filter((message) => message.from.kind === 'user').length,
    2,
  );
  assert.equal((await app.inject({ method: 'POST', url: url.replace('/repeat', '/retry'), headers })).statusCode, 409);
});

test('a stale repeat request cannot create a new input after acceptance is known', async (t) => {
  const f = await appendRecoveryFixture(async () => ({ accepted: false, reason: 'exception', acceptance: 'unknown' }));
  await f.append();
  await f.processor.reconcileAppendDeliveries('thread');
  const source = f.messageStore.getById(f.admission.message.id);
  const ref = source.lifecycle.dispatchRefs[0];
  assert.equal(
    f.messageStore.advanceLifecycleInputDispatch(source.id, {
      orderKey: source.lifecycle.orderKey,
      targetId: 'opus',
      statusMessageId: f.response.id,
      phase: 'dispatched',
      dispatchedAt: ref.dispatchedAt,
      appendAcceptance: 'accepted',
    }).kind,
    'applied',
  );
  const app = Fastify();
  t.after(() => app.close());
  await app.register(queueRoutes, {
    threadStore: { get: async (id) => (id === 'thread' ? { id, createdBy: 'owner' } : null) },
    invocationQueue: f.queue,
    queueProcessor: f.processor,
    invocationTracker: f.invocationTracker,
    messageStore: f.messageStore,
    socketManager: { emitToUser() {}, broadcastAgentMessage() {}, getActiveInvocations: () => [] },
  });
  const headers = { 'x-cat-cafe-user': 'owner' };
  const result = await app.inject({
    method: 'POST',
    headers,
    url: `/api/threads/thread/messages/${source.id}/routing-targets/opus/repeat`,
    payload: { expectedResponseMessageId: f.response.id, expectedInvocationId: 'turn' },
  });
  assert.equal(result.statusCode, 409, result.body);
  const snapshot = await app.inject({ method: 'GET', url: '/api/threads/thread/queue', headers });
  assert.deepEqual(snapshot.json().queue, []);
  assert.equal(
    f.messageStore
      .getByThread('thread', 100, 'owner', { includeQueuedUserMessages: true })
      .filter((m) => m.from.kind === 'user').length,
    1,
  );
});

test('History reconciliation checks the exact original input without dispatching again, then rejects stale repeat', async (t) => {
  let dispatches = 0;
  let inspections = 0;
  let proof = 'unknown';
  const f = await appendRecoveryFixture(
    async () => {
      dispatches++;
      return { accepted: false, reason: 'exception', acceptance: 'unknown' };
    },
    {
      inspectInput: async () => {
        inspections++;
        return proof;
      },
    },
  );
  await f.append();
  await f.processor.reconcileAppendDeliveries('thread');
  const app = Fastify();
  t.after(() => app.close());
  await app.register(queueRoutes, {
    threadStore: { get: async (id) => (id === 'thread' ? { id, createdBy: 'owner' } : null) },
    invocationQueue: f.queue,
    queueProcessor: f.processor,
    invocationTracker: f.invocationTracker,
    messageStore: f.messageStore,
    socketManager: { emitToUser() {}, broadcastAgentMessage() {}, getActiveInvocations: () => [] },
  });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const path = `/api/threads/thread/messages/${f.admission.message.id}/routing-targets/opus`;
  const headers = { 'x-cat-cafe-user': 'owner', 'content-type': 'application/json' };
  const request = (action, body, extra = {}) =>
    fetch(origin + path + action, {
      method: 'POST',
      headers: { ...headers, ...extra },
      body: JSON.stringify(body),
    });
  const identity = { expectedResponseMessageId: f.response.id, expectedInvocationId: 'turn' };
  assert.equal((await request('/reconcile', identity, { 'x-cat-cafe-user': 'foreign' })).status, 403);
  assert.equal((await request('/reconcile', identity, { origin: 'http://localhost:3100' })).status, 401);
  assert.equal((await request('/reconcile', {})).status, 400);
  assert.equal((await request('/reconcile', { ...identity, expectedResponseMessageId: 'old' })).status, 409);
  const before = inspections;
  const checked = await request('/reconcile', identity);
  assert.equal(checked.status, 200);
  assert.deepEqual(await checked.json(), { status: 'checked' });
  assert.equal(inspections, before + 1);
  assert.equal(dispatches, 1);
  assert.deepEqual((await (await fetch(origin + '/api/threads/thread/queue', { headers })).json()).queue, []);
  proof = 'accepted';
  assert.equal((await request('/reconcile', identity)).status, 200);
  assert.equal((await request('/repeat', identity)).status, 409);
  assert.equal(
    (await f.messageStore.getById(f.admission.message.id)).lifecycle.dispatchRefs[0].appendAcceptance,
    'accepted',
  );
  assert.equal(dispatches, 1);
});
