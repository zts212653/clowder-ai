import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const LINEAGE = `write_lineage_${'a'.repeat(32)}`;
const OPPORTUNITY = `write_opp_${'c'.repeat(32)}`;

describe('F276 deferred receipt lifecycle invalidates write-opportunity lineage', () => {
  let app;
  let registry;
  let messageStore;
  let storedReceipts;
  let invalidations;
  let purges;

  before(async () => {
    const [routeMod, registryMod, messageMod, authMod] = await Promise.all([
      import('../../dist/routes/callback-defer-person-memory-routes.js'),
      import('../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'),
      import('../../dist/domains/cats/services/stores/ports/MessageStore.js'),
      import('../../dist/routes/callback-auth-prehandler.js'),
    ]);
    registry = new registryMod.InvocationRegistry();
    messageStore = new messageMod.MessageStore();
    app = Fastify();
    authMod.registerCallbackAuthHook(app, registry);
    routeMod.registerCallbackDeferPersonMemoryRoutes(app, {
      registry,
      messageStore,
      receiptStore: {
        async stage() {
          return { outcome: 'conflict' };
        },
        async rearmWriteOpportunity() {
          return { outcome: 'conflict' };
        },
        async get(_owner, receiptId) {
          return storedReceipts.find((receipt) => receipt.receiptId === receiptId) ?? null;
        },
        async withdraw(_owner, receiptId) {
          const receipt = storedReceipts.find((candidate) => candidate.receiptId === receiptId);
          return receipt ? { outcome: 'withdrawn', receipt } : { outcome: 'not_available' };
        },
        async hardForget() {
          return { outcome: 'purged' };
        },
      },
      registryResolver: { resolve: async () => ({ kind: 'registered_person', ref: 'person_huang_ting' }) },
      writeOpportunityDeliveryStore: {
        async recordDelivered() {},
        async get() {
          return null;
        },
        async listInvocationOpportunityIds() {
          return [];
        },
        async purgeLineage(ownerUserId, dedupeLineage) {
          purges.push({ ownerUserId, dedupeLineage });
          return 1;
        },
      },
      writeOpportunityTerminalLedger: {
        async recordTerminal() {},
        async recordInvalidated(input) {
          invalidations.push(input);
        },
        async readLineageStates() {
          return new Map();
        },
      },
    });
    await app.ready();
  });

  beforeEach(() => {
    storedReceipts = [];
    invalidations = [];
    purges = [];
  });

  const lineageReceipt = (receiptId) => ({
    receiptId,
    writeOpportunityLineage: {
      reflexId: 'asr-person-memory',
      reflexVersion: 1,
      opportunityId: OPPORTUNITY,
      dedupeLineage: LINEAGE,
      generation: 1,
    },
  });

  async function post(action, receiptId) {
    const origin = await messageStore.append({
      userId: 'owner-1',
      catId: null,
      content: 'owner turn',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread-current',
    });
    const auth = await registry.create(
      'owner-1',
      'codex-sol',
      origin.threadId,
      undefined,
      undefined,
      undefined,
      origin.id,
    );
    return app.inject({
      method: 'POST',
      url: `/api/callbacks/person-memory/deferred/${action}`,
      headers: {
        'x-invocation-id': auth.invocationId,
        'x-callback-token': auth.callbackToken,
        'content-type': 'application/json',
      },
      payload: { receiptId },
    });
  }

  it('kills lineage on withdraw', async () => {
    const receiptId = `deferred_person_${'a'.repeat(32)}`;
    storedReceipts.push(lineageReceipt(receiptId));
    const response = await post('withdraw', receiptId);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(invalidations[0].reason, 'superseded');
    assert.deepEqual(purges, [{ ownerUserId: 'owner-1', dedupeLineage: LINEAGE }]);
  });

  it('reads lineage before hard forget purges the receipt', async () => {
    const receiptId = `deferred_person_${'b'.repeat(32)}`;
    storedReceipts.push(lineageReceipt(receiptId));
    const response = await post('forget', receiptId);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(invalidations[0].reason, 'source_forgotten');
    assert.deepEqual(purges, [{ ownerUserId: 'owner-1', dedupeLineage: LINEAGE }]);
  });

  it('leaves lineage-free receipts alone', async () => {
    const receiptId = `deferred_person_${'e'.repeat(32)}`;
    storedReceipts.push({ receiptId });
    await post('withdraw', receiptId);
    assert.deepEqual(invalidations, []);
    assert.deepEqual(purges, []);
  });
});
