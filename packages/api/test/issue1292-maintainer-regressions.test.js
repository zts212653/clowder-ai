import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import { routingConfirmationRequiredSchema } from '@cat-cafe/shared/routing-preview';
import Fastify from 'fastify';
import { getRoster, resolveCatSuccessor } from '../dist/config/cat-config-loader.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { messagesRoutes } from '../dist/routes/messages.js';
import { privateInput, successorFixture } from './helpers/successor-routing-fixture.js';

async function appFor(t, h) {
  const app = Fastify();
  t.after(() => app.close());
  await app.register(messagesRoutes, {
    registry: new InvocationRegistry(),
    router: h.router,
    messageStore: h.messages,
    threadStore: h.threads,
    invocationQueue: h.queue,
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
  });
  return app;
}

it('system send cannot consume another successor after its async policy boundary', async (t) => {
  const h = successorFixture(t);
  const queue = new InvocationQueue(h.ledger, {
    resolvePreResolvedTargets: (...args) => h.router.resolveAdmissionTargets(...args),
    resolveTargets: async (...args) => {
      const targets = await h.router.resolveSendTargets(...args);
      getRoster()['opus-5'] = { ...getRoster()['opus-5'], available: false, successor: 'codex' };
      return targets;
    },
  });
  const input = privateInput(h.threadId, { kind: 'conversation_input' });
  await assert.rejects(
    queue.send(
      h.messages,
      {
        threadId: h.threadId,
        userId: 'owner',
        from: input.from,
        content: input.content,
        mentions: [],
        timestamp: 1,
        deliveryStatus: 'queued',
        idempotencyKey: randomUUID(),
      },
      input,
    ),
    /target/i,
  );
  assert.deepEqual(input.targetCats, ['opus']);
  assert.equal(resolveCatSuccessor('opus'), null);
  assert.deepEqual(await h.ledger.list(h.threadId), []);
  assert.deepEqual(await h.messages.getByThread(h.threadId), []);
  await h.queue.hydrateFromLedger(h.messages);
  await h.processor.requestDrain(h.threadId);
  assert.deepEqual(h.calls, []);
});

for (const stage of ['pending', 'partial', 'retired', 'reopened']) {
  it(`confirmed HTTP replay retains its receipt after target disablement: ${stage}`, async (t) => {
    const h = successorFixture(t);
    let app = await appFor(t, h);
    const request = {
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: {
        threadId: h.threadId,
        content: '@opus work',
        idempotencyKey: randomUUID(),
        confirmedTargetCats: ['opus-5', 'codex'],
      },
    };
    const first = await app.inject(request);
    assert.equal(first.statusCode, 202, first.body);
    const [row] = await h.ledger.list(h.threadId);
    getRoster()['opus-5'] = { ...getRoster()['opus-5'], available: false, successor: 'codex' };
    if (stage !== 'pending') {
      await h.ledger.claim(h.threadId, row.id, 'first', 200, 'opus-5');
      await h.ledger.commit(h.threadId, row.id, 'first', 'processing', 201);
    }
    if (stage === 'retired' || stage === 'reopened') {
      await h.ledger.claim(h.threadId, row.id, 'last', 202, 'codex');
      await h.ledger.commit(h.threadId, row.id, 'last', 'processing', 203);
    }
    if (stage === 'reopened') {
      const queue = new InvocationQueue(h.ledger, {
        resolveTargets: () => assert.fail('receipt replay must not resolve targets'),
        resolvePreResolvedTargets: () => assert.fail('receipt replay must not project successors'),
      });
      app = await appFor(t, { ...h, queue });
    }
    const replay = await app.inject(request);
    assert.equal(replay.statusCode, 202, replay.body);
    assert.equal(replay.json().userMessageId, first.json().userMessageId);
    assert.equal((await h.messages.getById(first.json().userMessageId)).extra.routingTargetSource, 'explicit');
    assert.deepEqual((await h.messages.getById(first.json().userMessageId)).mentions, ['opus-5', 'codex']);
    assert.deepEqual(
      (await h.ledger.list(h.threadId)).flatMap((entry) => entry.targets),
      stage === 'pending' ? ['opus-5', 'codex'] : stage === 'partial' ? ['codex'] : [],
    );
    for (const changed of [
      { confirmedTargetCats: ['codex'] },
      { confirmedTargetCats: ['opus-5', 'opus'] },
      { content: '@opus different work' },
      { contextAttachments: [{ v: 1, id: 'different', kind: 'thread', threadId: 'other', title: 'other' }] },
    ]) {
      const conflict = await app.inject({ ...request, payload: { ...request.payload, ...changed } });
      assert.notEqual(conflict.statusCode, 202, conflict.body);
      assert.match(conflict.body, /identity conflict/);
    }
    assert.deepEqual(h.calls, []);
  });
}

it('disabled exact Queue recipient fails settlement without executing its successor', async (t) => {
  const h = successorFixture(t);
  const app = await appFor(t, h);
  const response = await app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: { 'x-cat-cafe-user': 'owner' },
    payload: {
      threadId: h.threadId,
      content: '@opus work',
      confirmedTargetCats: ['opus-5'],
      idempotencyKey: randomUUID(),
    },
  });
  assert.equal(response.statusCode, 202, response.body);
  getRoster()['opus-5'] = { ...getRoster()['opus-5'], available: false, successor: 'codex' };
  await h.processor.requestDrain(h.threadId);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(await h.ledger.list(h.threadId), []);
  assert.ok((await h.messages.getByThread(h.threadId)).some((m) => m.lifecycle?.reason === 'invalid_explicit_target'));
});

it('HTTP no-successor rejection never asks for confirmation of an empty target set', async (t) => {
  const h = successorFixture(t, { opus: { successor: 'ghost' } });
  const app = await appFor(t, h);
  const response = await app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: { 'x-cat-cafe-user': 'owner' },
    payload: { threadId: h.threadId, content: '@opus work', idempotencyKey: randomUUID() },
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, 'ROUTING_TARGET_UNAVAILABLE');
  assert.equal(response.json().routingWarnings[0].kind, 'cat_disabled');
  assert.equal(routingConfirmationRequiredSchema.safeParse(response.json()).success, false);
  assert.equal(response.json().targets, undefined);
  assert.deepEqual(await h.messages.getByThread(h.threadId), []);
  assert.deepEqual(await h.ledger.list(h.threadId), []);
  assert.deepEqual(h.threads.get(h.threadId).participants, []);
  await h.processor.requestDrain(h.threadId);
  assert.deepEqual(h.calls, []);
});
