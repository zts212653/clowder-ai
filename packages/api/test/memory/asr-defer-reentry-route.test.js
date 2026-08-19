import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const LINEAGE = `write_lineage_${'a'.repeat(32)}`;

describe('F276 generation+1 defer re-arms the claimed receipt', () => {
  let app;
  let registry;
  let messageStore;
  let delivered;
  let rearmed;
  let staged;
  let terminals;
  let invalidations;
  let purges;
  let hardForgotten;
  let afterRearm;

  const deliveredRecord = (overrides = {}) => ({
    v: 1,
    opportunityId: `write_opp_${'9'.repeat(32)}`,
    dedupeLineage: LINEAGE,
    generation: 2,
    reflexId: 'asr-person-memory',
    reflexVersion: 1,
    ownerUserId: 'owner-1',
    threadId: 'thread-current',
    consumerCatId: 'codex-sol',
    invocationId: 'INVOCATION_PLACEHOLDER',
    eligibleAt: 1,
    expiresAt: Date.now() + 86_400_000,
    rearmPredicate: 'next_eligible_owner_context_after_defer',
    destinationProposalContract: 'F276.CaptureCandidate.v1',
    sourceRefs: [
      {
        artifactId: 'meeting-intake-1',
        sourceRevision: `sha256:${'b'.repeat(64)}`,
        attributionRevision: `sha256:${'d'.repeat(64)}`,
        segmentStart: 0,
        segmentEnd: 128,
      },
    ],
    presentedAt: 2,
    generationId: `sha256:${'e'.repeat(64)}`,
    evidenceRef: `context-delivery:x:sha256:${'e'.repeat(64)}`,
    continuityDispositionRef: 'continuity:x',
    ...overrides,
  });

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
        async stage(input) {
          staged.push(input);
          return { outcome: 'conflict' };
        },
        async rearmWriteOpportunity(input) {
          rearmed.push(input);
          await afterRearm?.();
          return { outcome: 'rearmed', receipt: { receiptId: input.receiptId, state: 'deferred' } };
        },
        async hardForget(...args) {
          hardForgotten.push(args);
          return { outcome: 'purged' };
        },
        async get() {
          return null;
        },
        async withdraw() {
          return { outcome: 'not_available' };
        },
      },
      registryResolver: { resolve: async () => ({ kind: 'registered_person', ref: 'person_huang_ting' }) },
      writeOpportunityDeliveryStore: {
        async get(owner, opportunityId) {
          return (
            delivered.find((record) => record.ownerUserId === owner && record.opportunityId === opportunityId) ?? null
          );
        },
        async recordDelivered() {},
        async listInvocationOpportunityIds(owner, invocationId) {
          return delivered
            .filter((record) => record.ownerUserId === owner && record.invocationId === invocationId)
            .map((record) => record.opportunityId);
        },
        async purgeLineage(owner, lineage) {
          purges.push({ owner, lineage });
          return 1;
        },
      },
      writeOpportunityTerminalLedger: {
        async recordTerminal(input) {
          terminals.push(input);
        },
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
    delivered = [];
    rearmed = [];
    staged = [];
    terminals = [];
    invalidations = [];
    purges = [];
    hardForgotten = [];
    afterRearm = undefined;
  });

  async function ownerMessage(threadId, content) {
    return messageStore.append({
      userId: 'owner-1',
      catId: null,
      content,
      mentions: [],
      timestamp: Date.now(),
      threadId,
    });
  }

  async function invoke(body, origin, record) {
    const auth = await registry.create(
      'owner-1',
      'codex-sol',
      origin.threadId,
      undefined,
      undefined,
      undefined,
      origin.id,
    );
    record?.(auth);
    return app.inject({
      method: 'POST',
      url: '/api/callbacks/defer-person-memory',
      headers: {
        'x-invocation-id': auth.invocationId,
        'x-callback-token': auth.callbackToken,
        'content-type': 'application/json',
      },
      payload: body,
    });
  }

  const reentryBody = (factId, opportunityId, receipt = true) => ({
    subject: '黄挺',
    sources: [{ kind: 'message', messageId: factId }],
    clientRequestId: 'request-reentry',
    writeOpportunityRef: { opportunityId, dedupeLineage: LINEAGE, generation: 2 },
    ...(receipt ? { reentryReceipt: { receiptId: `deferred_person_${'f'.repeat(32)}`, claimId: 'claim-gen-2' } } : {}),
  });

  it('re-arms the claimed receipt instead of creating another one', async () => {
    const origin = await ownerMessage('thread-current', 'owner turn');
    const fact = await ownerMessage('thread-history', '黄挺 是产品经理');
    const opportunityId = `write_opp_${'9'.repeat(32)}`;
    const response = await invoke(reentryBody(fact.id, opportunityId), origin, (auth) => {
      delivered.push(deliveredRecord({ opportunityId, invocationId: auth.invocationId }));
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(staged.length, 0);
    assert.equal(rearmed.length, 1);
    assert.equal(rearmed[0].writeOpportunityLineage.generation, 2);
    assert.equal(rearmed[0].writeOpportunityReceipt.receiptId, `deferred_person_${'f'.repeat(32)}`);
    assert.equal(terminals[0].outcome, 'defer');
  });

  it('invalidates a re-armed lineage when its source drifts before terminal commit', async () => {
    const origin = await ownerMessage('thread-current', 'owner turn');
    const fact = await ownerMessage('thread-history', '黄挺 是产品经理');
    const opportunityId = `write_opp_${'7'.repeat(32)}`;
    afterRearm = () => messageStore.softDelete(fact.id, 'owner-1');
    const response = await invoke(reentryBody(fact.id, opportunityId), origin, (auth) => {
      delivered.push(deliveredRecord({ opportunityId, invocationId: auth.invocationId }));
    });

    assert.equal(response.statusCode, 409, response.body);
    assert.deepEqual(response.json(), { error: 'source_drift' });
    assert.equal(hardForgotten.length, 1);
    assert.equal(invalidations[0].reason, 'source_corrected');
    assert.deepEqual(purges, [{ owner: 'owner-1', lineage: LINEAGE }]);
    assert.deepEqual(terminals, []);
  });

  it('rejects generation+1 without the exact claimed receipt fence', async () => {
    const origin = await ownerMessage('thread-current', 'owner turn');
    const fact = await ownerMessage('thread-history', '黄挺 是产品经理');
    const opportunityId = `write_opp_${'8'.repeat(32)}`;
    const response = await invoke(reentryBody(fact.id, opportunityId, false), origin, (auth) => {
      delivered.push(deliveredRecord({ opportunityId, invocationId: auth.invocationId }));
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, 'write_opportunity_reentry_receipt_required');
    assert.equal(rearmed.length, 0);
  });
});
