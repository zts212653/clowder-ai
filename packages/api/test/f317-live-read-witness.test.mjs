import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { buildHandedEvent } from '../dist/domains/ball-custody/ball-custody-events.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import {
  createInitialQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { getQueueReadEvidence } from '../dist/domains/cats/services/agents/invocation/QueueReadEvidence.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { callbacksRoutes } from '../dist/routes/callbacks.js';
import { LiveCarrierOperationGate } from '../src/domains/concierge/live/LiveCarrierOperationGate.ts';

test('only full contiguous body return adds independent read provenance to canonical custody', async () => {
  const registry = new InvocationRegistry();
  const identity = await registry.create('owner', 'codex', 'home');
  const messages = new MessageStore();
  const queue = new InvocationQueue();
  const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: messages });
  const executions = new InMemoryTurnExecutionStore();
  executions.createRunning({
    invocationId: identity.invocationId,
    parentInvocationId: identity.invocationId,
    userId: 'owner',
    catId: 'codex',
    threadId: 'home',
    executionKind: 'ordinary',
    queueCompletionPolicy: 'explicit_source',
    startedAt: 1,
  });
  const source = messages.append({
    userId: 'owner',
    catId: 'opus',
    threadId: 'home',
    content: 'A source to inspect',
    mentions: ['codex'],
    timestamp: Date.now(),
    deliveryStatus: 'queued',
  });
  const admitted = queue.enqueue({
    threadId: 'home',
    userId: 'owner',
    content: source.content,
    messageId: source.id,
    source: 'agent',
    targetCats: ['codex'],
    intent: 'execute',
    ownerAuthProvenance: 'strict',
  });
  assert.equal(admitted.outcome, 'enqueued');
  const entry = admitted.entry;
  messages.initializeQueueCustody(source.id, createInitialQueuedMessageCustody(entry));
  queue.markQueuedSeen('home', 'owner', entry.id, 'codex', identity.invocationId, 100);
  await coordinator.persistEntry(queue.getEntrySnapshot('home', 'owner', entry.id));
  const app = Fastify();
  const gate = new LiveCarrierOperationGate();
  const handoffs = {
    read: async () => [
      buildHandedEvent({ threadId: 'home', fromCatId: 'opus', toCatId: 'codex', messageId: source.id, at: 200 }),
    ],
  };
  await app.register(callbacksRoutes, {
    registry,
    messageStore: messages,
    invocationQueue: queue,
    queueCustodyCoordinator: coordinator,
    turnExecutionStore: executions,
    withLiveCarrierOperation: (_query, operation) => gate.run(operation),
    ballCustodyEventLog: handoffs,
    socketManager: { broadcastAgentMessage() {}, emitToUser() {}, broadcastToRoom() {} },
  });
  const headers = { 'x-invocation-id': identity.invocationId, 'x-callback-token': identity.callbackToken };
  try {
    for (const query of ['', '?responseMode=full&keyword=inspect']) {
      assert.equal(
        (await app.inject({ method: 'GET', url: `/api/callbacks/thread-context${query}`, headers })).statusCode,
        200,
      );
      assert.equal(messages.getById(source.id).queueCustody.readEvidenceWitnesses, undefined);
    }
    const full = await app.inject({ method: 'GET', url: '/api/callbacks/thread-context?responseMode=full', headers });
    assert.equal(full.statusCode, 200, full.body);
    assert.ok(full.json().messages.some((message) => message.content?.includes(source.content)));
    const custody = messages.getById(source.id).queueCustody;
    assert.equal(custody.bodyExposures[0].seenAt, 100, 'first body exposure stays immutable');
    const witness = custody.readEvidenceWitnesses?.[0];
    assert.ok(witness, 'full read must have its own durable witness even without a provider notice');
    assert.equal(witness.targetCatId, 'codex');
    assert.equal(witness.invocationId, identity.invocationId);
    assert.equal(witness.evidenceKind, 'full_contiguous_thread_context');
    assert.ok(witness.seenAt > 100);
    const query = { threadId: 'home', catId: 'codex', invocationId: identity.invocationId, messageId: source.id };
    assert.deepEqual(await getQueueReadEvidence(messages, query), {
      messageId: source.id,
      seenAt: witness.seenAt,
      evidenceKind: witness.evidenceKind,
    });
    for (const changed of [
      { invocationId: 'another-call' },
      { catId: 'opus' },
      { threadId: 'another-thread' },
      { messageId: 'other-source' },
    ]) {
      assert.equal(await getQueueReadEvidence(messages, { ...query, ...changed }), null);
    }
    assert.deepEqual(custody.handledByCatIds, [], 'reading is not completion');
    await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/callbacks/thread-context?responseMode=full', headers })).statusCode,
      200,
    );
    assert.equal(
      messages.getById(source.id).queueCustody.readEvidenceWitnesses.length,
      1,
      'FC-3: repeated reads of the same handoff must not grow permanent duplicate witnesses',
    );
    await coordinator.persistEntry(queue.getEntrySnapshot('home', 'owner', entry.id));
    assert.deepEqual(
      messages.getById(source.id).queueCustody.readEvidenceWitnesses,
      [witness],
      'subsequent Queue persistence cannot drop source-owned read proof',
    );
    const beforeRemoval = messages.getById(source.id).queueCustody;
    assert.throws(
      () =>
        messages.transitionQueueCustody(source.id, {
          expectedRevision: beforeRemoval.revision,
          next: {
            ...beforeRemoval,
            revision: beforeRemoval.revision + 1,
            readEvidenceWitnesses: [],
            updatedAt: Date.now(),
          },
        }),
      /read.*append-only/,
    );
    let entered;
    let release;
    const readStarted = new Promise((resolve) => {
      entered = resolve;
    });
    const originalRead = handoffs.read;
    handoffs.read = async () => {
      entered();
      await new Promise((resolve) => {
        release = resolve;
      });
      return originalRead();
    };
    const inFlight = app
      .inject({ method: 'GET', url: '/api/callbacks/thread-context?responseMode=full', headers })
      .then((response) => response);
    await readStarted;
    gate.close();
    let drained = false;
    const stopped = gate.drain().then(() => {
      drained = true;
    });
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/callbacks/thread-context?responseMode=full', headers })).statusCode,
      409,
    );
    assert.equal(drained, false, 'accepted full-read owns an operation until its body/provenance commits');
    handoffs.read = originalRead;
    release();
    assert.equal((await inFlight).statusCode, 200);
    await stopped;
    executions.transitionTerminal(identity.invocationId, { status: 'succeeded', endedAt: Date.now() });
    const late = await app.inject({ method: 'GET', url: '/api/callbacks/thread-context?responseMode=full', headers });
    assert.equal(late.statusCode, 409, 'terminal child cannot create a new body/read exposure');
    assert.deepEqual(messages.getById(source.id).queueCustody.readEvidenceWitnesses, [witness]);
  } finally {
    await app.close();
  }
});
