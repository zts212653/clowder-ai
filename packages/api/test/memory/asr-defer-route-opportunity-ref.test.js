import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const OPPORTUNITY = `write_opp_${'c'.repeat(32)}`;
const LINEAGE = `write_lineage_${'a'.repeat(32)}`;

describe('F276 defer route binds a validated write-opportunity ref', () => {
  let app;
  let registry;
  let messageStore;
  let staged;
  let terminals;
  let delivered;
  let invalidations;
  let purges;
  let storedReceipts;
  let rearmed;
  let hardForgotten;
  let afterRearm;
  let afterTerminal;
  let TerminalConflictError;

  const deliveredRecord = (overrides = {}) => ({
    v: 1,
    opportunityId: OPPORTUNITY,
    dedupeLineage: LINEAGE,
    generation: 1,
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
    const [routeMod, registryMod, messageMod, authMod, ledgerMod] = await Promise.all([
      import('../../dist/routes/callback-defer-person-memory-routes.js'),
      import('../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'),
      import('../../dist/domains/cats/services/stores/ports/MessageStore.js'),
      import('../../dist/routes/callback-auth-prehandler.js'),
      import('../../dist/domains/memory/people/WriteOpportunityTerminalLedger.js'),
    ]);
    TerminalConflictError = ledgerMod.WriteOpportunityTerminalConflictError;
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
          return {
            outcome: 'created',
            receipt: {
              ...input,
              state: input.ready ? 'deferred' : 'awaiting_confirmation',
              retention: 'owner_controlled_no_ttl',
              updatedAt: input.createdAt,
            },
          };
        },
        async hardForget(...args) {
          hardForgotten.push(args);
          return { outcome: 'purged' };
        },
        async get(_owner, receiptId) {
          return storedReceipts.find((r) => r.receiptId === receiptId) ?? null;
        },
        async withdraw(_ownerUserId, receiptId) {
          const found = storedReceipts.find((r) => r.receiptId === receiptId);
          return { outcome: 'withdrawn', receipt: found ?? { receiptId } };
        },
        async rearmWriteOpportunity(input) {
          rearmed.push(input);
          await afterRearm?.(input);
          return {
            outcome: 'rearmed',
            receipt: { receiptId: input.receiptId, state: 'deferred' },
          };
        },
      },
      registryResolver: { resolve: async () => ({ kind: 'registered_person', ref: 'person_huang_ting' }) },
      writeOpportunityDeliveryStore: {
        async get(owner, opportunityId) {
          return delivered.find((r) => r.ownerUserId === owner && r.opportunityId === opportunityId) ?? null;
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
          await afterTerminal?.(input);
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
    staged = [];
    terminals = [];
    delivered = [];
    invalidations = [];
    purges = [];
    storedReceipts = [];
    rearmed = [];
    hardForgotten = [];
    afterRearm = undefined;
    afterTerminal = undefined;
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

  async function invoke(payload, origin, onAuth) {
    const auth = await registry.create(
      'owner-1',
      'codex-sol',
      origin.threadId,
      undefined,
      undefined,
      undefined,
      origin.id,
    );
    onAuth?.(auth);
    return app.inject({
      method: 'POST',
      url: '/api/callbacks/defer-person-memory',
      headers: {
        'x-invocation-id': auth.invocationId,
        'x-callback-token': auth.callbackToken,
        'content-type': 'application/json',
      },
      payload,
    });
  }

  const payload = (ref) => ({
    subject: '黄挺',
    sources: [{ kind: 'message', messageId: 'MESSAGE_PLACEHOLDER' }],
    clientRequestId: 'request-1',
    ...(ref ? { writeOpportunityRef: ref } : {}),
  });

  it('stages the receipt with server-derived lineage and records the generation terminal', async () => {
    const origin = await ownerMessage('thread-current', 'owner turn');
    const fact = await ownerMessage('thread-history', '黄挺 是产品经理');
    const body = payload({ opportunityId: OPPORTUNITY, dedupeLineage: LINEAGE, generation: 1 });
    body.sources = [{ kind: 'message', messageId: fact.id }];

    const response = await invoke(body, origin, (auth) => {
      delivered.push(deliveredRecord({ invocationId: auth.invocationId }));
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(staged.length, 1);
    assert.deepEqual(staged[0].writeOpportunityLineage, {
      reflexId: 'asr-person-memory',
      reflexVersion: 1,
      opportunityId: OPPORTUNITY,
      dedupeLineage: LINEAGE,
      generation: 1,
    });
    assert.equal(staged[0].writeOpportunityReceipt.opportunityId, OPPORTUNITY);
    assert.equal(staged[0].writeOpportunityReceipt.dedupeLineage, LINEAGE);
    assert.equal(staged[0].writeOpportunityReceipt.receiptId, staged[0].receiptId);
    assert.equal(JSON.stringify(staged[0].writeOpportunityReceipt).includes('private transcript body'), false);
    assert.deepEqual(terminals, [
      {
        ownerUserId: 'owner-1',
        dedupeLineage: LINEAGE,
        generation: 1,
        outcome: 'defer',
        recordedAt: terminals[0].recordedAt,
      },
    ]);
  });

  it('fails closed on a ref with no server-held delivery evidence', async () => {
    const origin = await ownerMessage('thread-current', 'owner turn');
    const fact = await ownerMessage('thread-history', '黄挺 是产品经理');
    const body = payload({ opportunityId: OPPORTUNITY, dedupeLineage: LINEAGE, generation: 1 });
    body.sources = [{ kind: 'message', messageId: fact.id }];

    // delivered stays empty: nothing was ever presented to this cat
    const response = await invoke(body, origin);

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, 'write_opportunity_ref_rejected');
    assert.equal(response.json().reason, 'unknown_opportunity');
    assert.equal(staged.length, 0, 'a rejected ref must not leave an unattributed receipt behind');
    assert.deepEqual(terminals, []);
  });

  it('fails closed on a ref replayed from an earlier invocation', async () => {
    const origin = await ownerMessage('thread-current', 'owner turn');
    const fact = await ownerMessage('thread-history', '黄挺 是产品经理');
    const body = payload({ opportunityId: OPPORTUNITY, dedupeLineage: LINEAGE, generation: 1 });
    body.sources = [{ kind: 'message', messageId: fact.id }];

    delivered.push(deliveredRecord({ invocationId: 'some-older-invocation' }));
    const response = await invoke(body, origin);

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().reason, 'invocation_mismatch');
    assert.equal(staged.length, 0);
  });

  it('fails closed on lineage or generation drift inside the ref', async () => {
    for (const [ref, expected] of [
      [
        { opportunityId: OPPORTUNITY, dedupeLineage: `write_lineage_${'9'.repeat(32)}`, generation: 1 },
        'lineage_mismatch',
      ],
      [{ opportunityId: OPPORTUNITY, dedupeLineage: LINEAGE, generation: 4 }, 'generation_mismatch'],
    ]) {
      // Reset per iteration: a stale record from the previous loop would be matched first and the
      // assertion would silently pass on the wrong rejection reason.
      delivered = [];
      const origin = await ownerMessage('thread-current', 'owner turn');
      const fact = await ownerMessage('thread-history', '黄挺 是产品经理');
      const body = payload(ref);
      body.sources = [{ kind: 'message', messageId: fact.id }];

      const response = await invoke(body, origin, (auth) => {
        delivered.push(deliveredRecord({ invocationId: auth.invocationId }));
      });
      assert.equal(response.statusCode, 409, `${expected} must fail closed`);
      assert.equal(response.json().reason, expected);
    }
  });

  it('leaves the ordinary defer path untouched when no ref is supplied', async () => {
    const origin = await ownerMessage('thread-current', 'owner turn');
    const fact = await ownerMessage('thread-history', '黄挺 是产品经理');
    const body = payload();
    body.sources = [{ kind: 'message', messageId: fact.id }];

    const response = await invoke(body, origin);

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(staged.length, 1);
    assert.equal(staged[0].writeOpportunityLineage, undefined);
    assert.deepEqual(terminals, [], 'no opportunity means no generation to close');
  });

  it('keeps a staged defer retryable when terminal authority is temporarily unavailable', async () => {
    const origin = await ownerMessage('thread-current', 'owner turn');
    const fact = await ownerMessage('thread-history', '黄挺 是产品经理');
    const body = payload({ opportunityId: OPPORTUNITY, dedupeLineage: LINEAGE, generation: 1 });
    body.sources = [{ kind: 'message', messageId: fact.id }];
    afterTerminal = () => {
      throw new Error('redis unavailable');
    };

    const response = await invoke(body, origin, (auth) => {
      delivered.push(deliveredRecord({ invocationId: auth.invocationId }));
    });

    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.json().error, 'write_opportunity_terminal_authority_unavailable');
    assert.deepEqual(hardForgotten, [], 'a transient authority failure must not evaporate the staged defer');
  });

  it('purges a staged defer when another disposition already closed the generation', async () => {
    const origin = await ownerMessage('thread-current', 'owner turn');
    const fact = await ownerMessage('thread-history', '黄挺 是产品经理');
    const body = payload({ opportunityId: OPPORTUNITY, dedupeLineage: LINEAGE, generation: 1 });
    body.sources = [{ kind: 'message', messageId: fact.id }];
    afterTerminal = () => {
      throw new TerminalConflictError(LINEAGE, 1, 'propose');
    };

    const response = await invoke(body, origin, (auth) => {
      delivered.push(deliveredRecord({ invocationId: auth.invocationId }));
    });

    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error, 'write_opportunity_generation_conflict');
    assert.equal(hardForgotten.length, 1, 'a conflicting terminal must not leave a live defer receipt');
  });

  it('requires an explicit ref when this invocation received a write opportunity', async () => {
    const origin = await ownerMessage('thread-current', 'owner turn');
    const fact = await ownerMessage('thread-history', '黄挺 是产品经理');
    const body = payload();
    body.sources = [{ kind: 'message', messageId: fact.id }];

    const response = await invoke(body, origin, (auth) => {
      delivered.push(deliveredRecord({ invocationId: auth.invocationId }));
    });

    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.json(), {
      error: 'write_opportunity_ref_rejected',
      reason: 'write_opportunity_ref_required',
    });
    assert.equal(staged.length, 0, 'missing attribution must not fall through to an ordinary defer');
    assert.deepEqual(terminals, []);
  });
});
