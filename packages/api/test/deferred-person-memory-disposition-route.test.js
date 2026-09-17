import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import { writeOpportunityGenerationId } from '@cat-cafe/shared';
import Fastify from 'fastify';

describe('F276 unified clerk disposition callback', () => {
  let app;
  let registry;
  let receipt;
  let dispositions;
  let deliveryRecord;
  let terminals;

  before(async () => {
    const [routeMod, registryMod, authMod] = await Promise.all([
      import('../dist/routes/callback-defer-person-memory-routes.js'),
      import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'),
      import('../dist/routes/callback-auth-prehandler.js'),
    ]);
    registry = new registryMod.InvocationRegistry();
    app = Fastify();
    authMod.registerCallbackAuthHook(app, registry);
    routeMod.registerCallbackDeferPersonMemoryRoutes(app, {
      registry,
      messageStore: {
        async getById() {
          return null;
        },
      },
      receiptStore: {
        async get(_ownerUserId, receiptId) {
          return receipt?.receiptId === receiptId ? receipt : null;
        },
        async bindProcessorInvocation(input) {
          const current = receipt?.receiptId === input.receiptId ? receipt : null;
          if (
            !current ||
            current.state !== 'claimed' ||
            current.claimId !== input.claimId ||
            current.processorCatId !== input.processorCatId ||
            current.processingThreadId !== input.processingThreadId ||
            current.processingMessageId !== input.processingMessageId ||
            (current.claimUntil ?? 0) <= input.now ||
            (current.processorInvocationId !== undefined &&
              current.processorInvocationId !== input.processorInvocationId)
          ) {
            return { outcome: current ? 'conflict' : 'not_available' };
          }
          const outcome = current.processorInvocationId === input.processorInvocationId ? 'replayed' : 'bound';
          receipt = { ...current, processorInvocationId: input.processorInvocationId, updatedAt: input.now };
          return { outcome, receipt };
        },
        async disposeClaim(input) {
          dispositions.push(input);
          return {
            outcome: input.disposition === 'awaiting_confirmation' ? 'awaiting_confirmation' : 'not_actionable',
            receipt: {
              ...receipt,
              state: input.disposition === 'awaiting_confirmation' ? 'awaiting_confirmation' : 'not_actionable',
            },
          };
        },
      },
      registryResolver: {
        async resolve() {
          return { kind: 'unregistered' };
        },
      },
      writeOpportunityDeliveryStore: {
        async get(_ownerUserId, opportunityId) {
          return deliveryRecord?.opportunityId === opportunityId ? deliveryRecord : null;
        },
        async listInvocationOpportunityIds(_ownerUserId, invocationId) {
          return deliveryRecord?.invocationId === invocationId ? [deliveryRecord.opportunityId] : [];
        },
      },
      writeOpportunityTerminalLedger: {
        async readLineageStates() {
          return new Map();
        },
        async recordTerminal(input) {
          terminals.push(input);
        },
      },
    });
    await app.ready();
  });

  beforeEach(() => {
    dispositions = [];
    terminals = [];
    deliveryRecord = null;
    receipt = null;
  });

  async function invocation(
    catId = 'codex-terra',
    threadId = 'thread_memory_operations',
    originTriggerMessageId = 'scheduler-message',
  ) {
    return registry.create('owner-1', catId, threadId, undefined, undefined, undefined, originTriggerMessageId);
  }

  function headers(auth) {
    return {
      'x-invocation-id': auth.invocationId,
      'x-callback-token': auth.callbackToken,
      'content-type': 'application/json',
    };
  }

  it('accepts only the current processor grant, independent of the capture cat', async () => {
    const auth = await invocation();
    const receiptId = `deferred_person_${'a'.repeat(32)}`;
    receipt = {
      receiptId,
      ownerUserId: 'owner-1',
      requesterCatId: 'fable-5',
      state: 'claimed',
      claimId: 'claim-1',
      claimUntil: Date.now() + 60_000,
      processorCatId: 'codex-terra',
      processingThreadId: 'thread_memory_operations',
      processingMessageId: 'scheduler-message',
    };
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/person-memory/deferred/dispose',
      headers: headers(auth),
      payload: { receiptId, claimId: 'claim-1', disposition: 'insufficient_evidence' },
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(JSON.parse(response.body), { receiptId, status: 'not_actionable' });
    assert.equal(dispositions.length, 1);
    assert.equal(dispositions[0].processorCatId, 'codex-terra');
    assert.equal(JSON.stringify(dispositions[0]).includes('fable-5'), false);
  });

  it('rejects a latest same-cat successor that did not receive the claimed batch', async () => {
    const granted = await invocation('codex-terra', 'thread_memory_operations', 'scheduler-message-a');
    const successor = await invocation('codex-terra', 'thread_memory_operations', 'scheduler-message-b');
    const receiptId = `deferred_person_${'f'.repeat(32)}`;
    receipt = {
      receiptId,
      ownerUserId: 'owner-1',
      requesterCatId: 'codex-sol',
      state: 'claimed',
      claimId: 'claim-successor-fence',
      claimUntil: Date.now() + 60_000,
      processorCatId: 'codex-terra',
      processingThreadId: 'thread_memory_operations',
      processingMessageId: 'scheduler-message-a',
      processorInvocationId: granted.invocationId,
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/person-memory/deferred/dispose',
      headers: headers(successor),
      payload: { receiptId, claimId: receipt.claimId, disposition: 'insufficient_evidence' },
    });

    assert.equal(response.statusCode, 409, response.body);
    assert.deepEqual(dispositions, []);
  });

  it('fails closed for a stale claim or a different processing thread', async () => {
    const auth = await invocation();
    const receiptId = `deferred_person_${'b'.repeat(32)}`;
    receipt = {
      receiptId,
      ownerUserId: 'owner-1',
      requesterCatId: 'codex-sol',
      state: 'claimed',
      claimId: 'claim-2',
      claimUntil: Date.now() + 60_000,
      processorCatId: 'codex-terra',
      processingThreadId: 'some-entity-thread',
      processingMessageId: 'scheduler-message',
    };
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/person-memory/deferred/dispose',
      headers: headers(auth),
      payload: { receiptId, claimId: 'claim-2', disposition: 'awaiting_confirmation' },
    });

    assert.equal(response.statusCode, 409);
    assert.deepEqual(dispositions, []);
  });

  it('binds an ASR disposition to the exact next generation delivered to this invocation', async () => {
    const auth = await invocation();
    const receiptId = `deferred_person_${'c'.repeat(32)}`;
    const dedupeLineage = `write_lineage_${'d'.repeat(32)}`;
    const now = Date.now();
    const writeOpportunityRef = {
      opportunityId: writeOpportunityGenerationId(dedupeLineage, 2),
      dedupeLineage,
      generation: 2,
    };
    receipt = {
      receiptId,
      ownerUserId: 'owner-1',
      requesterCatId: 'fable-5',
      state: 'claimed',
      claimId: 'claim-asr',
      claimUntil: now + 60_000,
      processorCatId: 'codex-terra',
      processingThreadId: 'thread_memory_operations',
      processingMessageId: 'scheduler-message',
      writeOpportunityLineage: {
        reflexId: 'asr-person-memory',
        reflexVersion: 1,
        opportunityId: writeOpportunityGenerationId(dedupeLineage, 1),
        dedupeLineage,
        generation: 1,
      },
    };
    deliveryRecord = {
      v: 1,
      ...writeOpportunityRef,
      reflexId: 'asr-person-memory',
      reflexVersion: 1,
      ownerUserId: 'owner-1',
      threadId: 'thread_memory_operations',
      consumerCatId: 'codex-terra',
      invocationId: auth.invocationId,
      eligibleAt: now - 1_000,
      expiresAt: now + 60_000,
      rearmPredicate: 'next_eligible_owner_context_after_defer',
      destinationProposalContract: 'F276.CaptureCandidate.v1',
      sourceRefs: [
        {
          artifactId: 'meeting-1',
          sourceRevision: `sha256:${'a'.repeat(64)}`,
          attributionRevision: `sha256:${'b'.repeat(64)}`,
          segmentStart: 0,
          segmentEnd: 10,
        },
      ],
      presentedAt: now - 100,
      generationId: `sha256:${'e'.repeat(64)}`,
      evidenceRef: 'context-delivery:test',
      continuityDispositionRef: `sha256:${'f'.repeat(64)}`,
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/person-memory/deferred/dispose',
      headers: headers(auth),
      payload: { receiptId, claimId: 'claim-asr', disposition: 'awaiting_confirmation', writeOpportunityRef },
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].generation, 2);
    assert.equal(dispositions[0].disposition, 'awaiting_confirmation');
  });
});
