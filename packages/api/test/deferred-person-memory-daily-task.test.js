import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('F276 deferred person-memory daily clerk task', () => {
  it('batches the bounded queue into one Memory Operations invocation assigned independently of capture provenance', async () => {
    const { createDeferredPersonMemoryDailyTaskSpec } = await import(
      '../dist/domains/memory/DeferredPersonMemoryDailyTaskSpec.js'
    );
    const calls = {
      listed: [],
      claimed: [],
      bound: [],
      delivered: [],
      triggered: [],
      released: [],
      preflighted: [],
      ensured: 0,
    };
    const receipt = {
      receiptId: `deferred_person_${'a'.repeat(32)}`,
      ownerUserId: 'owner-1',
      requesterCatId: 'codex-sol',
      invocationId: 'invocation-1',
      originMessageRef: { kind: 'message', threadId: 'thread_current', messageId: 'message_origin' },
      subject: '黄挺',
      normalizedSubject: '黄挺',
      registryBinding: { kind: 'registered_person', ref: 'person_huang_ting' },
      sourceCoordinates: [
        {
          kind: 'message',
          sourceRef: { kind: 'message', threadId: 'thread_history', messageId: 'message_fact' },
          resolvedDigest: 'b'.repeat(64),
        },
      ],
      sourceBundleDigest: 'c'.repeat(64),
      dedupeHash: 'd'.repeat(64),
      state: 'deferred',
      retention: 'owner_controlled_no_ttl',
      createdAt: 100,
      updatedAt: 100,
    };
    const secondReceipt = {
      ...receipt,
      receiptId: `deferred_person_${'e'.repeat(32)}`,
      requesterCatId: 'fable-5',
      subject: '刘赫伟',
      normalizedSubject: '刘赫伟',
      registryBinding: { kind: 'registered_person', ref: 'person_liu_he_wei' },
      dedupeHash: 'f'.repeat(64),
    };
    const spec = createDeferredPersonMemoryDailyTaskSpec({
      receiptStore: {
        async listReady(ownerUserId, limit) {
          calls.listed.push([ownerUserId, limit]);
          return [receipt, secondReceipt];
        },
        async get(_ownerUserId, receiptId) {
          return [receipt, secondReceipt].find((candidate) => candidate.receiptId === receiptId) ?? null;
        },
        async claim(input) {
          calls.claimed.push(input);
          const current = [receipt, secondReceipt].find((candidate) => candidate.receiptId === input.receiptId);
          return {
            outcome: 'claimed',
            receipt: {
              ...current,
              state: 'claimed',
              claimId: input.claimId,
              claimUntil: input.now + input.leaseMs,
              processorCatId: input.processorCatId,
              processingThreadId: input.processingThreadId,
            },
          };
        },
        async bindProcessingMessage(input) {
          calls.bound.push(input);
          return { outcome: 'bound', receipt: { receiptId: input.receiptId } };
        },
        async release(...args) {
          calls.released.push(args);
          return true;
        },
      },
      ensureSystemThread: async () => {
        calls.ensured += 1;
        return 'thread_memory_operations';
      },
      routingDispatchPreflight: {
        async preflight(input) {
          calls.preflighted.push(input);
          return {
            v: 1,
            ownerId: input.ownerId,
            observedAt: 1_000,
            resolverState: 'fresh',
            targets: [{ targetCatId: input.targetCatIds[0], disposition: 'allowed', reasons: [], alternatives: [] }],
          };
        },
      },
      ownerUserId: 'owner-1',
      now: () => 1_000,
      randomId: (() => {
        let value = 0;
        return () => `claim-daily-${++value}`;
      })(),
    });
    const admission = await spec.admission.gate({});

    assert.equal(admission.run, true);
    assert.deepEqual(calls.listed, [['owner-1', 8]]);
    assert.equal(admission.workItems.length, 1);
    assert.deepEqual(admission.workItems[0].signal.receiptIds, [receipt.receiptId, secondReceipt.receiptId]);
    assert.deepEqual(calls.claimed, []);

    await spec.run.execute(admission.workItems[0].signal, admission.workItems[0].subjectKey, {
      assignedCatId: 'codex-sol',
      deliver: async (input) => {
        calls.delivered.push(input);
        return 'daily-trigger-message';
      },
      invokeTrigger: {
        async trigger(...args) {
          calls.triggered.push(args);
        },
      },
    });

    assert.equal(calls.ensured, 1);
    assert.deepEqual(calls.preflighted, [{ ownerId: 'owner-1', targetCatIds: ['codex-sol'] }]);
    assert.equal(calls.claimed.length, 2);
    assert.ok(calls.claimed.every((claim) => claim.processorCatId === 'codex-sol'));
    assert.ok(calls.claimed.every((claim) => claim.processingThreadId === 'thread_memory_operations'));
    assert.equal(calls.delivered.length, 1);
    assert.equal(calls.bound.length, 2);
    assert.ok(calls.bound.every((binding) => binding.processingMessageId === 'daily-trigger-message'));
    assert.equal(calls.delivered[0].threadId, 'thread_memory_operations');
    assert.equal(calls.delivered[0].userId, 'scheduler');
    assert.equal(calls.delivered[0].extra.scheduler.hiddenTrigger, true);
    assert.match(calls.delivered[0].content, new RegExp(receipt.receiptId));
    assert.match(calls.delivered[0].content, new RegExp(secondReceipt.receiptId));
    assert.match(calls.delivered[0].content, /thread_history#message_fact/);
    assert.equal(calls.delivered[0].content.includes('private transcript body'), false);
    assert.equal(calls.triggered.length, 1);
    assert.equal(calls.triggered[0][0], 'thread_memory_operations');
    assert.equal(calls.triggered[0][1], 'codex-sol');
    assert.equal(calls.triggered[0][2], 'owner-1');
    assert.deepEqual(calls.released, []);
  });

  it('releases the exact claim when durable delivery or invocation fails', async () => {
    const { createDeferredPersonMemoryDailyTaskSpec } = await import(
      '../dist/domains/memory/DeferredPersonMemoryDailyTaskSpec.js'
    );
    const released = [];
    const receipt = {
      receiptId: `deferred_person_${'e'.repeat(32)}`,
      ownerUserId: 'owner-1',
      requesterCatId: 'codex-sol',
      originMessageRef: { kind: 'message', threadId: 'thread_current', messageId: 'message_origin' },
      subject: '黄挺',
      registryBinding: { kind: 'registered_entity', ref: 'entity_huang_ting' },
      sourceCoordinates: [
        {
          kind: 'message',
          sourceRef: { kind: 'message', threadId: 'thread_history', messageId: 'message_fact' },
          resolvedDigest: 'f'.repeat(64),
        },
      ],
      dedupeHash: 'd'.repeat(64),
      state: 'deferred',
    };
    const spec = createDeferredPersonMemoryDailyTaskSpec({
      receiptStore: {
        async listReady() {
          return [receipt];
        },
        async get() {
          return receipt;
        },
        async claim(input) {
          return {
            outcome: 'claimed',
            receipt: {
              ...receipt,
              state: 'claimed',
              claimId: input.claimId,
              claimUntil: input.now + input.leaseMs,
              processorCatId: input.processorCatId,
              processingThreadId: input.processingThreadId,
            },
          };
        },
        async bindProcessingMessage(input) {
          return { outcome: 'bound', receipt: { receiptId: input.receiptId } };
        },
        async release(...args) {
          released.push(args);
          return true;
        },
      },
      ensureSystemThread: async () => 'thread_memory_operations',
      routingDispatchPreflight: {
        async preflight(input) {
          return {
            v: 1,
            ownerId: input.ownerId,
            observedAt: 1_000,
            resolverState: 'fresh',
            targets: [{ targetCatId: input.targetCatIds[0], disposition: 'allowed', reasons: [], alternatives: [] }],
          };
        },
      },
      ownerUserId: 'owner-1',
      now: () => 1_000,
      randomId: () => 'claim-daily-2',
    });
    const admission = await spec.admission.gate({});

    await assert.rejects(
      spec.run.execute(admission.workItems[0].signal, admission.workItems[0].subjectKey, {
        assignedCatId: 'codex-terra',
        deliver: async () => 'message-daily',
        invokeTrigger: { trigger: async () => Promise.reject(new Error('invoke failed')) },
      }),
      /invoke failed/,
    );
    assert.deepEqual(released, [['owner-1', receipt.receiptId, 'claim-daily-2', 1_000]]);
  });

  it('terminalizes an expired prior clerk attempt instead of waking another cat', async () => {
    const { createDeferredPersonMemoryDailyTaskSpec } = await import(
      '../dist/domains/memory/DeferredPersonMemoryDailyTaskSpec.js'
    );
    const receipt = {
      receiptId: `deferred_person_${'7'.repeat(32)}`,
      ownerUserId: 'owner-1',
      requesterCatId: 'fable-5',
      state: 'claimed',
      claimId: 'old-claim',
      claimUntil: 999,
    };
    const expired = [];
    const spec = createDeferredPersonMemoryDailyTaskSpec({
      receiptStore: {
        async listReady() {
          return [receipt];
        },
        async expireClaim(input) {
          expired.push(input);
          return { outcome: 'not_actionable', receipt: { ...receipt, state: 'not_actionable' } };
        },
      },
      ownerUserId: 'owner-1',
      now: () => 1_000,
      ensureSystemThread: async () => {
        throw new Error('must not ensure a thread without admitted work');
      },
      routingDispatchPreflight: { async preflight() {} },
    });

    assert.deepEqual(await spec.admission.gate({}), {
      run: false,
      reason: 'no confirmed deferred person-memory receipts',
    });
    assert.deepEqual(expired, [
      { ownerUserId: 'owner-1', receiptId: receipt.receiptId, claimId: 'old-claim', now: 1_000 },
    ]);
  });

  it('parks the batch when F293 dispatch preflight does not allow the selected actor', async () => {
    const { createDeferredPersonMemoryDailyTaskSpec } = await import(
      '../dist/domains/memory/DeferredPersonMemoryDailyTaskSpec.js'
    );
    const receipt = {
      receiptId: `deferred_person_${'8'.repeat(32)}`,
      ownerUserId: 'owner-1',
      requesterCatId: 'fable-5',
      state: 'deferred',
    };
    let touched = false;
    const spec = createDeferredPersonMemoryDailyTaskSpec({
      receiptStore: {
        async listReady() {
          return [receipt];
        },
        async get() {
          touched = true;
          return receipt;
        },
      },
      ownerUserId: 'owner-1',
      now: () => 1_000,
      ensureSystemThread: async () => {
        touched = true;
        return 'thread_memory_operations';
      },
      routingDispatchPreflight: {
        async preflight(input) {
          return {
            v: 1,
            ownerId: input.ownerId,
            observedAt: 1_000,
            resolverState: 'fresh',
            targets: [
              {
                targetCatId: input.targetCatIds[0],
                disposition: 'rejected',
                reasons: ['unavailable'],
                alternatives: [],
              },
            ],
          };
        },
      },
    });
    const admission = await spec.admission.gate({});
    await spec.run.execute(admission.workItems[0].signal, admission.workItems[0].subjectKey, {
      assignedCatId: 'codex-terra',
      deliver: async () => {
        touched = true;
        return 'unexpected';
      },
      invokeTrigger: { async trigger() {} },
    });
    assert.equal(touched, false);
  });
});
