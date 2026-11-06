import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseWatcherSessionState } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { _resetCachedConfig } from '../dist/config/cat-config-loader.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InMemoryQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { AgentRegistry } from '../dist/domains/cats/services/agents/registry/AgentRegistry.js';
import { AgentRouter } from '../dist/domains/cats/services/agents/routing/AgentRouter.js';
import { watcherSessionChainKey } from '../dist/domains/cats/services/session/session-scope.js';
import { watcherToolSurface } from '../dist/domains/concierge/watcher/watcher-surface.js';
import { watcherCallbackRoutes } from '../dist/routes/watcher-callbacks.js';
import { successorFixture } from './helpers/successor-routing-fixture.js';
import { watcherWorld } from './helpers/watcher-world.js';

async function setup(t, targetCatId = 'opus') {
  const catalog = successorFixture(t);
  const w = await watcherWorld();
  const [source] = await w.work('Original source.', { targets: [targetCatId] });
  const auth = await w.registry.create(
    'watcher-owner',
    'codex',
    w.thread.id,
    'watcher-parent',
    undefined,
    watcherToolSurface({}).policy,
  );
  await w.executions.createRunning({
    invocationId: auth.invocationId,
    parentInvocationId: 'watcher-parent',
    userId: 'watcher-owner',
    threadId: w.thread.id,
    catId: 'codex',
    executionKind: 'watcher',
    outputFence: 'open',
    startedAt: Date.now(),
  });
  const session = await w.sessions.create({
    userId: 'watcher-owner',
    threadId: w.thread.id,
    catId: 'codex',
    sessionPurpose: 'watcher',
    chainKey: watcherSessionChainKey('watcher-owner', 'codex', w.thread.id),
  });
  await w.sessions.compareAndSetWatcherState(session.id, 0, {
    ...parseWatcherSessionState(undefined),
    revision: 1,
    attempt: {
      invocationId: auth.invocationId,
      sourceInvocationId: source.invocationId,
      sourceSequence: source.settledSequence,
      phase: 'running',
      startedAt: Date.now(),
    },
  });
  const router = new AgentRouter({
    agentRegistry: new AgentRegistry(),
    registry: w.registry,
    messageStore: w.messages,
    threadStore: w.threads,
  });
  const queue = new InvocationQueue(new InMemoryQueueLedgerStore(), {
    resolveTargets: (...args) => router.resolveSendTargets(...args),
    resolvePreResolvedTargets: (...args) => router.resolveAdmissionTargets(...args),
  });
  const published = [];
  const receipts = [];
  const app = Fastify();
  t.after(() => app.close());
  await app.register(watcherCallbackRoutes, {
    ...w,
    queue,
    maySpeak: async () => true,
    publish: (message) => published.push(message.id),
    afterNudge: async (input) => {
      receipts.push(input);
      return { ok: true };
    },
  });
  async function nudge(callId) {
    await w.registry.consumeWatcherToolCall(auth.invocationId, callId, 'cat_cafe_watcher_nudge');
    return app.inject({
      method: 'POST',
      url: '/api/callbacks/watcher-nudge',
      headers: {
        'x-invocation-id': auth.invocationId,
        'x-callback-token': auth.callbackToken,
        'x-watcher-tool-call-id': callId,
      },
      payload: { sentence: 'A helpful precedent.', sourceMessageId: source.responseSettlement.messageId },
    });
  }
  function available(value) {
    catalog.template.roster[targetCatId].available = value;
    writeFileSync(catalog.templatePath, JSON.stringify(catalog.template));
    _resetCachedConfig();
  }
  return { ...w, auth, source, queue, published, receipts, nudge, available };
}

test('an unavailable exact nudge target returns an honest refusal, replaying no success side effects', async (t) => {
  const f = await setup(t);
  const first = await f.nudge('unavailable');
  const message = await f.messages.getByIdempotencyKey(
    'watcher-owner',
    f.thread.id,
    `watcher-nudge:${f.source.invocationId}`,
  );
  t.diagnostic(
    JSON.stringify({
      status: first.statusCode,
      response: first.json(),
      persisted: Boolean(message),
      queueRows: f.queue.list(f.thread.id, 'watcher-owner').length,
      published: f.published.length,
      receipts: f.receipts.length,
      replayStatus: (await f.nudge('unavailable')).statusCode,
    }),
  );
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().delivered, false);
  assert.equal(first.json().reason, 'target_unavailable');
  assert.equal(first.json().targetCatId, 'opus');
  assert.equal(first.json().messageId, message.id);
  assert.deepEqual(f.queue.list(f.thread.id, 'watcher-owner'), []);
  assert.deepEqual(f.published, []);
  assert.deepEqual(f.receipts, []);
  for (const callId of ['unavailable', 'new-attempt']) {
    const replay = await f.nudge(callId);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json(), first.json());
  }
  assert.equal(
    (await f.messages.getByIdempotencyKey('watcher-owner', f.thread.id, `watcher-nudge:${f.source.invocationId}`)).id,
    message.id,
  );
  assert.deepEqual(f.queue.list(f.thread.id, 'watcher-owner'), []);
  assert.deepEqual(f.published, []);
  assert.deepEqual(f.receipts, []);
  f.available(true);
  assert.deepEqual((await f.nudge('unavailable')).json(), first.json(), 'a completed tool receipt stays immutable');
  const retried = await f.nudge('recovered');
  assert.equal(retried.json().delivered, true, retried.body);
  assert.equal(retried.json().messageId, message.id);
  assert.deepEqual(
    f.queue.list(f.thread.id, 'watcher-owner').map((row) => row.targets),
    [['opus']],
  );
  assert.deepEqual(f.published, [message.id]);
  assert.equal(f.receipts.length, 1);
});

test('an admitted nudge keeps its exact recipient and replay receipt across later unavailability', async (t) => {
  const f = await setup(t, 'opus-5');
  const first = await f.nudge('available');
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().delivered, true, first.body);
  assert.deepEqual(
    f.queue.list(f.thread.id, 'watcher-owner').map((row) => row.targets),
    [['opus-5']],
  );
  f.available(false);
  assert.deepEqual((await f.nudge('available')).json(), first.json());
  assert.equal(f.published.length, 1);
  assert.equal(f.receipts.length, 1);
  const next = await f.nudge('another-call');
  assert.equal(next.json().delivered, true, next.body);
  assert.equal(next.json().messageId, first.json().messageId);
  assert.deepEqual(
    f.queue.list(f.thread.id, 'watcher-owner').map((row) => row.targets),
    [['opus-5']],
  );
});

test('unrelated queue failures remain errors instead of target-unavailable refusals', async (t) => {
  const f = await setup(t, 'opus-5');
  f.queue.enqueueExistingMessageDurable = async () => {
    throw new Error('ledger write failed');
  };
  const result = await f.nudge('storage-failure');
  assert.equal(result.statusCode, 500, result.body);
  assert.equal(result.json().message, 'ledger write failed');
  assert.deepEqual(f.published, []);
  assert.deepEqual(f.receipts, []);
});
