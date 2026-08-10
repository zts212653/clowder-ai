import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('F276 deferred person-memory daily clerk task', () => {
  it('admits only the bounded deferred queue and invokes the original requester from exact refs', async () => {
    const { createDeferredPersonMemoryDailyTaskSpec } = await import(
      '../dist/domains/memory/DeferredPersonMemoryDailyTaskSpec.js'
    );
    const calls = { listed: [], claimed: [], delivered: [], triggered: [], released: [] };
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
    const spec = createDeferredPersonMemoryDailyTaskSpec({
      receiptStore: {
        async listReady(ownerUserId, limit) {
          calls.listed.push([ownerUserId, limit]);
          return [receipt];
        },
        async claim(input) {
          calls.claimed.push(input);
          return {
            outcome: 'claimed',
            receipt: { ...receipt, state: 'claimed', claimId: input.claimId, claimUntil: input.now + input.leaseMs },
          };
        },
        async release(...args) {
          calls.released.push(args);
          return true;
        },
      },
      ownerUserId: 'owner-1',
      now: () => 1_000,
      randomId: () => 'claim-daily-1',
    });
    const admission = await spec.admission.gate({});

    assert.equal(admission.run, true);
    assert.deepEqual(calls.listed, [['owner-1', 8]]);
    assert.equal(admission.workItems.length, 1);
    assert.equal(admission.workItems[0].signal.receiptId, receipt.receiptId);

    await spec.run.execute(admission.workItems[0].signal, admission.workItems[0].subjectKey, {
      assignedCatId: null,
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

    assert.equal(calls.delivered.length, 1);
    assert.equal(calls.delivered[0].threadId, 'thread_current');
    assert.equal(calls.delivered[0].userId, 'scheduler');
    assert.equal(calls.delivered[0].extra.scheduler.hiddenTrigger, true);
    assert.match(calls.delivered[0].content, new RegExp(receipt.receiptId));
    assert.match(calls.delivered[0].content, /thread_history#message_fact/);
    assert.equal(calls.delivered[0].content.includes('private transcript body'), false);
    assert.equal(calls.triggered[0][0], 'thread_current');
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
      state: 'claimed',
      claimId: 'claim-daily-2',
      claimUntil: 2_000,
    };
    const spec = createDeferredPersonMemoryDailyTaskSpec({
      receiptStore: {
        async listReady() {
          return [];
        },
        async claim() {
          return { outcome: 'not_available' };
        },
        async release(...args) {
          released.push(args);
          return true;
        },
      },
      ownerUserId: 'owner-1',
      now: () => 1_000,
    });

    await assert.rejects(
      spec.run.execute(receipt, receipt.receiptId, {
        assignedCatId: null,
        deliver: async () => 'message-daily',
        invokeTrigger: { trigger: async () => Promise.reject(new Error('invoke failed')) },
      }),
      /invoke failed/,
    );
    assert.deepEqual(released, [['owner-1', receipt.receiptId, 'claim-daily-2', 1_000]]);
  });
});
