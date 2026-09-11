/**
 * Phase C: multi_mention is an ordinary lifecycle fan-out.
 *
 * Every target shares one exact public Agent source and one Queue carrier before
 * drain. The caller's response is only the parent lineage; the source body is the
 * exact multi_mention work that every target receives. The retired
 * “A ⇉ B（并行 N/M）” system-message path must stay absent.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import Fastify from 'fastify';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { registerCallbackAuthHook } from '../dist/routes/callback-auth-prehandler.js';
import { resetMultiMentionOrchestrator } from '../dist/routes/callback-multi-mention-routes.js';
import { canonicalTestQueueInput } from './helpers/message-from-fixtures.js';

function createMockRegistry() {
  const records = new Map();
  return {
    register(catId, threadId, userId) {
      const invocationId = `inv-${records.size}`;
      const callbackToken = `tok-${records.size}`;
      records.set(invocationId, {
        catId,
        threadId,
        userId,
        invocationId,
        callbackToken,
        ownerAuthProvenance: 'strict',
      });
      return { invocationId, callbackToken };
    },
    async verify(invocationId, callbackToken) {
      const record = records.get(invocationId);
      if (!record) return { ok: false, reason: 'unknown_invocation' };
      if (record.callbackToken !== callbackToken) return { ok: false, reason: 'invalid_token' };
      return { ok: true, record };
    },
    isLatest: () => true,
    claimClientMessageId: () => true,
  };
}

function appendLifecycleSource(messageStore, creds) {
  return messageStore.append({
    from: { kind: 'agent', catId: 'opus' },
    userId: 'user-1',
    content: 'calling multi_mention',
    mentions: [],
    origin: 'stream',
    timestamp: 100,
    threadId: 'thread-par-1',
    idempotencyKey: `message-lifecycle-response:${creds.invocationId}`,
    lifecycle: {
      kind: 'response',
      orderKey: `100:${creds.invocationId}`,
      invocationId: creds.invocationId,
      targetId: 'opus',
      inputEntryIds: [],
      inputMessageIds: [],
      status: 'processing',
      startedAt: 100,
    },
  });
}

function createMockQueueProcessor() {
  const hooks = new Map();
  const drains = [];
  const timeline = [];
  return {
    registerEntryCompleteHook(entryId, hook, targetCatId) {
      const key = `${entryId}:${targetCatId ?? '*'}`;
      hooks.set(key, { entryId, targetCatId, hook });
      timeline.push(`custody:${key}`);
    },
    unregisterEntryCompleteHook(entryId) {
      for (const [key, registration] of hooks) {
        if (registration.entryId === entryId) hooks.delete(key);
      }
    },
    requestDrain(threadId) {
      drains.push(threadId);
      timeline.push(`drain:${threadId}`);
      return Promise.resolve();
    },
    releaseSlot() {},
    getHooks: () => hooks,
    getDrains: () => drains,
    timeline,
    simulateComplete(entryId, targetCatId, status, responseText) {
      const key = `${entryId}:${targetCatId}`;
      timeline.push(`terminal:${key}`);
      const registration = hooks.get(key);
      if (registration) registration.hook(entryId, status, responseText);
      hooks.delete(key);
    },
  };
}

describe('Phase C multi_mention lifecycle fan-out', () => {
  let app;
  let registry;
  let creds;
  let callerResponse;
  let messageStore;
  let invocationQueue;
  let queueProcessor;
  let socketMessages;

  beforeEach(async () => {
    resetMultiMentionOrchestrator();
    registry = createMockRegistry();
    creds = registry.register('opus', 'thread-par-1', 'user-1');
    messageStore = new MessageStore();
    callerResponse = appendLifecycleSource(messageStore, creds);
    invocationQueue = new InvocationQueue();
    queueProcessor = createMockQueueProcessor();
    socketMessages = [];

    app = Fastify({ logger: false });
    registerCallbackAuthHook(app, registry);
    const { registerMultiMentionRoutes } = await import('../dist/routes/callback-multi-mention-routes.js');
    registerMultiMentionRoutes(app, {
      registry,
      messageStore,
      socketManager: {
        broadcastAgentMessage(message, threadId) {
          socketMessages.push({ ...message, threadId });
        },
        broadcastToRoom() {},
        emitToUser() {},
      },
      router: { async *routeExecution() {} },
      invocationRecordStore: { create: () => ({ outcome: 'created', invocationId: 'inv-mm' }), update() {} },
      invocationTracker: {
        has: () => false,
        cancelInvocation: () => [],
        start: () => new AbortController(),
        startAll: () => new AbortController(),
        tryStartThreadAll: () => new AbortController(),
        complete() {},
        completeAll() {},
      },
      invocationQueue,
      queueProcessor,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  function dispatch(targets = ['codex', 'gemini']) {
    return app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: { targets, question: '独立看一眼', callbackTo: 'opus' },
    });
  }

  test('binds every target to one source and establishes hooks before drain', async () => {
    const response = await dispatch();
    assert.equal(response.statusCode, 200, response.body);

    const entries = invocationQueue.list('thread-par-1', 'user-1');
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].targets.toSorted(), ['codex', 'gemini']);
    const sourceId = entries[0].payload.messageId;
    for (const entry of entries) {
      assert.equal(entry.kind, 'message_wake');
      assert.equal(entry.payload.messageId, sourceId);
      assert.equal(entry.execution.a2aTriggerMessageId, sourceId);
    }
    assert.equal(queueProcessor.getHooks().size, 2);
    assert.equal(queueProcessor.getDrains().length, 1);
    const firstDrain = queueProcessor.timeline.findIndex((item) => item.startsWith('drain:'));
    assert.equal(queueProcessor.timeline.slice(0, firstDrain).filter((item) => item.startsWith('custody:')).length, 2);

    const persistedSource = await messageStore.getById(sourceId);
    assert.equal(persistedSource.id, sourceId);
    assert.equal(persistedSource.content, '[Multi-Mention from opus]\n\n独立看一眼');
    assert.equal(persistedSource.replyTo, callerResponse.id);
    assert.equal(persistedSource.queueCustody, undefined);
  });

  test('one terminal failure does not disturb its sibling carrier', async () => {
    const response = await dispatch();
    assert.equal(response.statusCode, 200, response.body);
    const [entry] = invocationQueue.list('thread-par-1', 'user-1');
    queueProcessor.simulateComplete(entry.id, 'codex', 'failed', 'dispatch failed');

    assert.ok(queueProcessor.getHooks().has(`${entry.id}:gemini`));
    assert.deepEqual(invocationQueue.list('thread-par-1', 'user-1')[0].targets.toSorted(), ['codex', 'gemini']);
  });

  test('source-row capacity never partially rejects sibling targets', async () => {
    for (let index = 0; index < 9; index += 1) {
      invocationQueue.enqueueDurableNow(
        canonicalTestQueueInput({
          sourceId: `partial-filler-${index}`,
          kind: 'conversation_input',
          threadId: 'thread-par-1',
          userId: 'user-1',
          ownerAuthProvenance: 'strict',
          content: `filler-${index}`,
          from: { kind: 'agent', catId: 'opus' },
          targetCats: ['opus'],
          intent: 'execute',
          autoExecute: true,
        }),
      );
    }

    const response = await dispatch();
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(queueProcessor.getHooks().size, 2);
    const [sourceEntry] = invocationQueue
      .list('thread-par-1', 'user-1')
      .filter((entry) => entry.targets.includes('codex') && entry.targets.includes('gemini'));
    const persistedSource = await messageStore.getById(sourceEntry.payload.messageId);
    assert.deepEqual(
      invocationQueue
        .list('thread-par-1', 'user-1')
        .filter((entry) => entry.payload.messageId === persistedSource.id)
        .flatMap((entry) => entry.targets)
        .toSorted(),
      ['codex', 'gemini'],
    );
    assert.equal(persistedSource.content, '[Multi-Mention from opus]\n\n独立看一眼');
    assert.equal(persistedSource.replyTo, callerResponse.id);
    assert.equal(persistedSource.queueCustody, undefined);
  });

  test('does not emit or persist the retired a2a_routing system row', async () => {
    const response = await dispatch();
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(
      socketMessages.some((message) => message.type === 'a2a_handoff'),
      false,
    );
    assert.equal(
      messageStore
        .getByThreadIncludingQueued('thread-par-1', 100, 'user-1')
        .some((message) => message.extra?.systemKind === 'a2a_routing'),
      false,
    );
  });

  test('fails closed when the exact lifecycle response source is absent', async () => {
    const missingApp = Fastify({ logger: false });
    registerCallbackAuthHook(missingApp, registry);
    const { registerMultiMentionRoutes } = await import('../dist/routes/callback-multi-mention-routes.js');
    registerMultiMentionRoutes(missingApp, {
      registry,
      messageStore: new MessageStore(),
      socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
      router: { async *routeExecution() {} },
      invocationRecordStore: { create: () => ({ outcome: 'created', invocationId: 'unused' }), update() {} },
      invocationQueue: new InvocationQueue(),
      queueProcessor: createMockQueueProcessor(),
    });
    await missingApp.ready();
    const response = await missingApp.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: { targets: ['codex'], question: 'no source', callbackTo: 'opus' },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().status, 'lifecycle_source_unavailable');
    await missingApp.close();
  });
});
