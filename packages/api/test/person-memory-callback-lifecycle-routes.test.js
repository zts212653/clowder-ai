import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import Fastify from 'fastify';
import { writeOpportunityLineage } from './memory/person-memory-write-opportunity-fixture.js';

describe('F276 callback recall and lifecycle routes', () => {
  let app;
  const calls = [];
  const invalidations = [];
  before(async () => {
    const [routeMod, registryMod, authMod] = await Promise.all([
      import('../dist/routes/callback-person-memory-routes.js'),
      import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'),
      import('../dist/routes/callback-auth-prehandler.js'),
    ]);
    const registry = new registryMod.InvocationRegistry();
    const auth = await registry.create(
      'owner-1',
      'codex-sol',
      'thread_people',
      undefined,
      undefined,
      undefined,
      'message_source',
    );
    const store = {
      getCandidateForOwner: async (ownerUserId, candidateId) => {
        calls.push(['status', { ownerUserId, candidateId }]);
        if (ownerUserId !== 'owner-1') return null;
        if (candidateId === 'person_candidate_lineage') {
          return { candidateId, ownerUserId, writeOpportunityLineage };
        }
        if (candidateId !== 'person_candidate_live_status') return null;
        return {
          candidateId,
          ownerUserId,
          state: 'materialized',
          remainingDraftIds: [],
          publication: {
            state: 'anchored',
            envelope: {
              approvalCardRef: { threadId: 'thread_people', messageId: 'message_card' },
            },
          },
          latestDecisionReceipt: {
            decisionId: 'decision_live_status',
            state: 'materialized',
          },
        };
      },
      correctClaim: async (input) => {
        calls.push(['correct', input]);
        if (input.requestId === 'correction_conflict') return { outcome: 'conflict' };
        return { outcome: 'applied', claim: { claimId: 'person_claim_new' } };
      },
      retireClaim: async (input) => {
        calls.push(['retire', input]);
        return { outcome: 'applied', claim: { claimId: 'person_claim_retired' } };
      },
      amendInteractionEvent: async (input) => {
        calls.push(['amend', input]);
        return { outcome: 'applied', event: { eventId: 'person_event_new' } };
      },
      hardForget: async (input) => {
        calls.push(['forget', input]);
        return {
          requestId: input.requestId,
          ownerUserId: input.ownerUserId,
          completedAt: input.requestedAt,
          purgedSurfaceCounts: {},
          verdict: 'purged',
        };
      },
      hardForgetProposal: async (input) => {
        calls.push(['forget-proposal', input]);
        if (input.proposalId === 'person_candidate_bound') return { outcome: 'person_bound' };
        return {
          outcome: 'purged',
          receipt: {
            requestId: input.requestId,
            ownerUserId: input.ownerUserId,
            completedAt: input.requestedAt,
            purgedSurfaceCounts: { candidates: 1 },
            verdict: 'purged',
          },
        };
      },
      redactItem: async (input) => {
        calls.push(['redact', input]);
        return { outcome: 'applied', item: input.item };
      },
      listCandidateIdsForPerson: async (ownerUserId, personId) => {
        calls.push(['list-person-candidates', { ownerUserId, personId }]);
        return personId === 'person_lineage' ? ['person_candidate_lineage'] : [];
      },
    };
    const recallService = {
      recallByAlias: async (ownerUserId, alias) => {
        calls.push(['recall', { ownerUserId, alias }]);
        return { status: 'not_available' };
      },
      drill: async (input) => {
        calls.push(['drill', input]);
        return { status: 'not_available' };
      },
      clearPerson: (ownerUserId, personId) => calls.push(['clear', { ownerUserId, personId }]),
    };
    app = Fastify();
    authMod.registerCallbackAuthHook(app, registry);
    routeMod.registerCallbackPersonMemoryRoutes(app, {
      store,
      recallService,
      writeOpportunityTerminalLedger: {
        async recordTerminal() {},
        async recordInvalidated(input) {
          invalidations.push(['terminal', input]);
        },
        async readLineageStates() {
          return new Map();
        },
      },
      writeOpportunityDeliveryStore: {
        async recordDelivered() {},
        async get() {
          return null;
        },
        async listInvocationOpportunityIds() {
          return [];
        },
        async purgeLineage(ownerUserId, dedupeLineage) {
          invalidations.push(['purge', { ownerUserId, dedupeLineage }]);
          return 1;
        },
      },
    });
    await app.ready();
    app.authHeaders = {
      'x-invocation-id': auth.invocationId,
      'x-callback-token': auth.callbackToken,
      'content-type': 'application/json',
    };
  });

  const post = (url, payload) =>
    app.inject({
      method: 'POST',
      url,
      headers: app.authHeaders,
      payload,
    });

  it('resolves the authoritative live proposal status from the authenticated owner', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/callbacks/person-memory/proposals/person_candidate_live_status/status',
      headers: app.authHeaders,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), {
      proposalId: 'person_candidate_live_status',
      status: 'materialized',
      remainingDraftIds: [],
      publicationState: 'anchored',
      approvalCardMessageId: 'message_card',
      decisionReceipt: {
        decisionId: 'decision_live_status',
        state: 'materialized',
      },
    });
    assert.deepEqual(calls.find(([kind]) => kind === 'status')[1], {
      ownerUserId: 'owner-1',
      candidateId: 'person_candidate_live_status',
    });
  });

  it('derives owner and turn identity for recall and drill', async () => {
    assert.equal((await post('/api/callbacks/person-memory/recall', { alias: '黄挺' })).statusCode, 200);
    assert.equal(
      (
        await post('/api/callbacks/person-memory/drill', {
          personId: 'person_recall',
          item: { kind: 'claim', id: 'person_claim_recall' },
          timeWindow: { from: 0, to: 1_000 },
        })
      ).statusCode,
      200,
    );
    assert.deepEqual(calls.find(([kind]) => kind === 'recall')[1], {
      ownerUserId: 'owner-1',
      alias: '黄挺',
    });
    assert.equal(calls.find(([kind]) => kind === 'drill')[1].ownerUserId, 'owner-1');
    assert.equal(typeof calls.find(([kind]) => kind === 'drill')[1].turnId, 'string');
  });

  it('requires the authenticated exact source for correction and supports retire/amend/forget', async () => {
    const forged = await post('/api/callbacks/person-memory/correct-claim', {
      personId: 'person_recall',
      expectedCurrentClaimId: 'person_claim_recall',
      payload: {
        kind: 'reported_fact',
        predicate: 'organization_unit',
        value: 'new',
        assertedBy: 'owner',
      },
      sourceMessageId: 'message_forged',
      requestId: 'correction_forged',
    });
    assert.equal(forged.statusCode, 400);

    const source = { sourceMessageId: 'message_source' };
    assert.equal(
      (
        await post('/api/callbacks/person-memory/retire-claim', {
          personId: 'person_recall',
          expectedCurrentClaimId: 'person_claim_recall',
          requestId: 'retirement_1',
          ...source,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await post('/api/callbacks/person-memory/amend-event', {
          personId: 'person_recall',
          expectedEventId: 'person_event_recall',
          payload: {
            eventKind: 'meeting',
            headline: '日期仍待确认',
            importanceOrTopic: '保留这次见面的连续性',
            uncertaintyNotes: ['具体日期仍待确认'],
          },
          requestId: 'amendment_1',
          ...source,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await post('/api/callbacks/person-memory/forget', {
          personId: 'person_recall',
          requestId: 'person_forget_1',
        })
      ).statusCode,
      200,
    );
    assert.equal(
      calls.some(([kind]) => kind === 'clear'),
      true,
    );
    assert.equal(
      (
        await post('/api/callbacks/person-memory/redact', {
          personId: 'person_recall',
          item: { kind: 'claim', id: 'person_claim_recall' },
          requestId: 'redaction_1',
        })
      ).statusCode,
      200,
    );
  });

  it('hard-forgets one exact unbound proposal and refuses a person-bound proposal', async () => {
    const forgotten = await post('/api/callbacks/person-memory/forget-proposal', {
      proposalId: 'person_candidate_unbound',
      requestId: 'person_forget_proposal_1',
    });
    assert.equal(forgotten.statusCode, 200);
    assert.equal(JSON.parse(forgotten.body).result.verdict, 'purged');
    assert.deepEqual(calls.find(([kind]) => kind === 'forget-proposal')[1], {
      ownerUserId: 'owner-1',
      proposalId: 'person_candidate_unbound',
      requestId: 'person_forget_proposal_1',
      requestedAt: calls.find(([kind]) => kind === 'forget-proposal')[1].requestedAt,
    });

    const personBound = await post('/api/callbacks/person-memory/forget-proposal', {
      proposalId: 'person_candidate_bound',
      requestId: 'person_forget_proposal_2',
    });
    assert.equal(personBound.statusCode, 409);
    assert.deepEqual(JSON.parse(personBound.body), { error: 'person_bound_use_forget_person' });

    const forged = await post('/api/callbacks/person-memory/forget-proposal', {
      proposalId: 'person_candidate_unbound',
      ownerUserId: 'owner-2',
      requestId: 'person_forget_proposal_3',
    });
    assert.equal(forged.statusCode, 400);
  });

  it('invalidates and purges bound opportunity lineages only after a successful canonical mutation', async () => {
    invalidations.length = 0;
    const source = { sourceMessageId: 'message_source' };
    const corrected = await post('/api/callbacks/person-memory/correct-claim', {
      personId: 'person_lineage',
      expectedCurrentClaimId: 'person_claim_old',
      payload: {
        kind: 'reported_fact',
        predicate: 'organization_unit',
        value: 'corrected',
        assertedBy: 'owner',
      },
      requestId: 'correction_lineage',
      ...source,
    });
    assert.equal(corrected.statusCode, 200, corrected.body);
    assert.deepEqual(
      invalidations.map(([kind]) => kind),
      ['terminal', 'purge'],
    );
    assert.equal(invalidations[0][1].ownerUserId, 'owner-1');
    assert.equal(invalidations[0][1].dedupeLineage, writeOpportunityLineage.dedupeLineage);
    assert.equal(invalidations[0][1].reason, 'source_corrected');
    assert.equal(typeof invalidations[0][1].recordedAt, 'number');

    invalidations.length = 0;
    const conflicted = await post('/api/callbacks/person-memory/correct-claim', {
      personId: 'person_lineage',
      expectedCurrentClaimId: 'person_claim_old',
      payload: {
        kind: 'reported_fact',
        predicate: 'organization_unit',
        value: 'conflicted',
        assertedBy: 'owner',
      },
      requestId: 'correction_conflict',
      ...source,
    });
    assert.equal(conflicted.statusCode, 200, conflicted.body);
    assert.deepEqual(invalidations, []);
  });
  it('resolves proposal lineage before a destructive proposal forget and then invalidates it', async () => {
    invalidations.length = 0;
    const response = await post('/api/callbacks/person-memory/forget-proposal', {
      proposalId: 'person_candidate_lineage',
      requestId: 'person_forget_proposal_lineage',
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(
      invalidations.map(([kind]) => kind),
      ['terminal', 'purge'],
    );
    assert.equal(invalidations[0][1].reason, 'source_forgotten');
    assert.equal(invalidations[0][1].dedupeLineage, writeOpportunityLineage.dedupeLineage);
  });
});
