import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Fastify from 'fastify';

const { ContextEpochOwner, contextEpochScopeKey } = await import(
  '../dist/domains/cats/services/session/ContextEpochOwner.js'
);
const { InMemoryContextEpochStore } = await import('../dist/domains/cats/services/stores/ports/ContextEpochStore.js');
const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
const { SessionSealer } = await import('../dist/domains/cats/services/session/SessionSealer.js');
const { sessionHooksRoutes } = await import('../dist/routes/session-hooks.js');
const { mapToPresentation } = await import('../dist/domains/cats/services/session/context-presentation.js');
const { InMemoryPresentationLedgerStore, PresentationLedger } = await import(
  '../dist/domains/cats/services/session/PresentationLedger.js'
);
const { mintDeliveryReceipt } = await import('../dist/domains/cats/services/session/delivery-receipt.js');
const { createPostCompactContextProjector } = await import(
  '../dist/domains/cats/services/agents/routing/post-compact-context-projector.js'
);
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { DeliveryCursorStore } = await import('../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js');
const { cursorFor } = await import('../dist/domains/cats/services/stores/cursor.js');

const HOOK_TOKEN = 'f296-b3b3-hook-token';
const SCOPE = { userId: 'user-1', catId: 'opus', threadId: 'thread-1' };

function printCapability() {
  return {
    provider: 'anthropic',
    carrier: 'print_sdk',
    observesCompression: true,
    reportsRuntimeWindow: true,
    authoritativeUsage: true,
    usageTelemetry: 'available',
    nativeWindowControl: false,
    nativeCompressionControl: false,
    reason: 'fixture',
  };
}

describe('F296 B3b-3: authenticated PreCompact → epoch → post-compact packet', () => {
  test('one event advances once, resets epoch-scoped dedupe, and GET returns the trusted cold packet', async () => {
    const epochStore = new InMemoryContextEpochStore();
    const contextEpochOwner = new ContextEpochOwner(epochStore);
    const before = await contextEpochOwner.resolve({
      ...SCOPE,
      disposition: { state: 'unknown', reason: 'signal_unavailable', evidenceRef: 'launch:unknown' },
    });

    const ledger = new PresentationLedger(new InMemoryPresentationLedgerStore(), { now: () => 1_000 });
    const claim = mapToPresentation({
      subjectKey: 'task:42',
      asOf: { kind: 'version', value: 'rev-1' },
      sourceTier: 'T1',
      invalidator: { owner: 'task-store', ref: 'task:42' },
      requested: 'state',
    });
    const oldReservation = await ledger.reserve(
      claim,
      { scopeKey: before.scopeKey, contextEpoch: before.contextEpoch },
      { promptGenerationId: 'old-generation' },
    );
    assert.equal(oldReservation.admitted, true);
    await ledger.commit(
      oldReservation.reservation,
      mintDeliveryReceipt({
        promptGenerationId: 'old-generation',
        providerReceivedAt: 1_000,
        providerAdapterId: 'claude/print_sdk',
      }),
    );

    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const alreadyRead = messageStore.append({
      threadId: SCOPE.threadId,
      userId: SCOPE.userId,
      catId: null,
      content: 'READ-HISTORY-MUST-NOT-REPLAY',
      mentions: [],
      timestamp: 1_000,
    });
    messageStore.append({
      threadId: SCOPE.threadId,
      userId: SCOPE.userId,
      catId: null,
      content: 'UNREAD-TAIL-MUST-RETURN',
      mentions: [],
      timestamp: 2_000,
    });
    const deliveryBoundary = cursorFor(alreadyRead);
    await deliveryCursorStore.ackCursor(SCOPE.userId, SCOPE.catId, SCOPE.threadId, deliveryBoundary);
    await deliveryCursorStore.ackSeenCursor(SCOPE.userId, SCOPE.catId, SCOPE.threadId, deliveryBoundary);

    const sessionChainStore = new SessionChainStore();
    const record = sessionChainStore.create({
      ...SCOPE,
      cliSessionId: 'claude-runtime-1',
      compressionCount: 0,
    });
    sessionChainStore.applyPolicySnapshot(record.id, {
      config: {
        strategy: 'compress',
        thresholds: { warn: 0.75, action: 0.85 },
        turnBudget: 12_000,
        safetyMargin: 4_000,
      },
      source: 'runtime_override',
      revision: 'policy:1',
      changedAt: 0,
      execution: { status: 'active', missingCapabilities: [] },
    });
    const app = Fastify();
    await app.register(sessionHooksRoutes, {
      sessionChainStore,
      sessionSealer: new SessionSealer(sessionChainStore),
      transcriptReader: { readDigest: async () => null, readEvents: async () => ({ events: [], hasMore: false }) },
      contextEpochOwner,
      resolveContextCapability: printCapability,
      postCompactContextProjector: createPostCompactContextProjector({
        services: {},
        invocationDeps: {},
        messageStore,
        deliveryCursorStore,
      }),
      hookToken: HOOK_TOKEN,
    });
    await app.ready();

    const preCompact = await app.inject({
      method: 'POST',
      url: '/api/sessions/seal',
      headers: { 'x-cat-cafe-hook-token': HOOK_TOKEN },
      payload: { cliSessionId: 'claude-runtime-1', reason: 'claude-code-compact-auto' },
    });
    assert.equal(preCompact.statusCode, 200);
    const preBody = preCompact.json();
    assert.equal(preBody.contextEpoch.status, 'observed');
    assert.equal(preBody.contextEpoch.decision.contextEpoch, before.contextEpoch + 1);
    assert.equal(preBody.contextEpoch.decision.contextMode, 'cold');

    const nextEpochReservation = await ledger.reserve(
      claim,
      { scopeKey: contextEpochScopeKey(SCOPE), contextEpoch: preBody.contextEpoch.decision.contextEpoch },
      { promptGenerationId: 'post-compact-generation' },
    );
    assert.equal(nextEpochReservation.admitted, true, 'new epoch resets presentation dedupe by key scope');

    const postCompact = await app.inject({
      method: 'GET',
      url: '/api/sessions/latest-digest?cliSessionId=claude-runtime-1',
      headers: { 'x-cat-cafe-hook-token': HOOK_TOKEN },
    });
    assert.equal(postCompact.statusCode, 200);
    const postBody = postCompact.json();
    assert.equal(postBody.postCompact.status, 'projected');
    assert.equal(postBody.postCompact.contextEpoch, before.contextEpoch + 1, 'GET replays, but never advances again');
    assert.equal(postBody.postCompact.transition, 'context_compaction_replay');
    assert.match(postBody.postCompact.contextPacket, /"contextMode":"cold"/);
    assert.match(postBody.postCompact.contextPacket, /UNREAD-TAIL-MUST-RETURN/);
    assert.doesNotMatch(postBody.postCompact.contextPacket, /READ-HISTORY-MUST-NOT-REPLAY/);
    assert.equal(await deliveryCursorStore.getCursor(SCOPE.userId, SCOPE.catId, SCOPE.threadId), deliveryBoundary);
    assert.equal(await deliveryCursorStore.getSeenCursor(SCOPE.userId, SCOPE.catId, SCOPE.threadId), deliveryBoundary);

    await app.close();
  });

  test('an authenticated hook on an unproven Claude carrier is explicit unsupported', async () => {
    const sessionChainStore = new SessionChainStore();
    const record = sessionChainStore.create({
      ...SCOPE,
      cliSessionId: 'claude-bg-runtime',
      compressionCount: 0,
    });
    sessionChainStore.applyPolicySnapshot(record.id, {
      config: {
        strategy: 'compress',
        thresholds: { warn: 0.75, action: 0.85 },
        turnBudget: 12_000,
        safetyMargin: 4_000,
      },
      source: 'runtime_override',
      revision: 'policy:bg',
      changedAt: 0,
      execution: { status: 'active', missingCapabilities: [] },
    });
    const app = Fastify();
    await app.register(sessionHooksRoutes, {
      sessionChainStore,
      sessionSealer: new SessionSealer(sessionChainStore),
      transcriptReader: { readDigest: async () => null, readEvents: async () => ({ events: [], hasMore: false }) },
      contextEpochOwner: new ContextEpochOwner(new InMemoryContextEpochStore()),
      resolveContextCapability: () => ({ ...printCapability(), carrier: 'bg' }),
      hookToken: HOOK_TOKEN,
    });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/seal',
      headers: { 'x-cat-cafe-hook-token': HOOK_TOKEN },
      payload: { cliSessionId: 'claude-bg-runtime', reason: 'claude-code-compact-auto' },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().contextEpoch, {
      status: 'unsupported',
      reason: 'carrier_event_delivery_unproven',
    });
    await app.close();
  });
});
