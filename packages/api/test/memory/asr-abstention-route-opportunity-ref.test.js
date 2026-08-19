import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const OPPORTUNITY = `write_opp_${'c'.repeat(32)}`;
const LINEAGE = `write_lineage_${'a'.repeat(32)}`;
const REF = { opportunityId: OPPORTUNITY, dedupeLineage: LINEAGE, generation: 1 };

describe('F276 abstention route binds a validated write-opportunity ref', () => {
  let app;
  let registry;
  let delivered;
  let terminals;
  let lineageState;

  const deliveredRecord = (overrides = {}) => ({
    v: 1,
    ...REF,
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
    const [routeMod, registryMod, authMod] = await Promise.all([
      import('../../dist/routes/callback-record-proactive-memory-abstention-routes.js'),
      import('../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'),
      import('../../dist/routes/callback-auth-prehandler.js'),
    ]);
    registry = new registryMod.InvocationRegistry();
    app = Fastify();
    authMod.registerCallbackAuthHook(app, registry);
    routeMod.registerCallbackRecordProactiveMemoryAbstentionRoutes(app, {
      registry,
      writeOpportunityDeliveryStore: {
        async get(ownerUserId, opportunityId) {
          return (
            delivered.find((record) => record.ownerUserId === ownerUserId && record.opportunityId === opportunityId) ??
            null
          );
        },
        async recordDelivered() {},
        async listInvocationOpportunityIds(ownerUserId, invocationId) {
          return delivered
            .filter((record) => record.ownerUserId === ownerUserId && record.invocationId === invocationId)
            .map((record) => record.opportunityId);
        },
        async purgeLineage() {
          return 0;
        },
      },
      writeOpportunityTerminalLedger: {
        async recordTerminal(input) {
          terminals.push(input);
        },
        async recordInvalidated() {},
        async readLineageStates() {
          return new Map([[LINEAGE, lineageState]]);
        },
      },
    });
    await app.ready();
  });

  beforeEach(() => {
    delivered = [];
    terminals = [];
    lineageState = { terminalGenerations: new Map() };
  });

  async function invoke(payload, onAuth) {
    const auth = await registry.create('owner-1', 'codex-sol', 'thread-current');
    onAuth?.(auth);
    return app.inject({
      method: 'POST',
      url: '/api/callbacks/record-proactive-memory-abstention',
      headers: {
        'x-invocation-id': auth.invocationId,
        'x-callback-token': auth.callbackToken,
        'content-type': 'application/json',
      },
      payload,
    });
  }

  it('records an abstain terminal from server-held delivered evidence', async () => {
    const response = await invoke({ reasonCode: 'insufficient_owner_evidence', writeOpportunityRef: REF }, (auth) =>
      delivered.push(deliveredRecord({ invocationId: auth.invocationId })),
    );

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { status: 'recorded' });
    assert.deepEqual(terminals, [
      {
        ownerUserId: 'owner-1',
        dedupeLineage: LINEAGE,
        generation: 1,
        outcome: 'abstain',
        recordedAt: terminals[0].recordedAt,
      },
    ]);
    assert.equal(response.body.includes('insufficient_owner_evidence'), false);
    assert.equal(response.body.includes(OPPORTUNITY), false);
  });

  it('requires an explicit ref when this invocation received an opportunity', async () => {
    const response = await invoke({ reasonCode: 'bad_timing' }, (auth) =>
      delivered.push(deliveredRecord({ invocationId: auth.invocationId })),
    );
    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.json(), {
      error: 'write_opportunity_ref_rejected',
      reason: 'write_opportunity_ref_required',
    });
    assert.deepEqual(terminals, []);
  });

  it('rejects a ref replayed from another invocation', async () => {
    delivered.push(deliveredRecord({ invocationId: 'older-invocation' }));
    const response = await invoke({ reasonCode: 'bad_timing', writeOpportunityRef: REF });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().reason, 'invocation_mismatch');
    assert.deepEqual(terminals, []);
  });

  it('rejects late disposition after correction invalidated the lineage even if delivery purge lagged', async () => {
    lineageState = { invalidatedReason: 'source_corrected', terminalGenerations: new Map() };
    const response = await invoke({ reasonCode: 'bad_timing', writeOpportunityRef: REF }, (auth) =>
      delivered.push(deliveredRecord({ invocationId: auth.invocationId })),
    );
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().reason, 'write_opportunity_lineage_invalidated');
    assert.deepEqual(terminals, []);
  });

  it('preserves ordinary F282 abstention when no opportunity was delivered', async () => {
    const response = await invoke({ reasonCode: 'not_continuity_valued' });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { status: 'recorded' });
    assert.deepEqual(terminals, []);
  });
});
