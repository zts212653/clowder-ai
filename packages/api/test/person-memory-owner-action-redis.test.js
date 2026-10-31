import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const KEY_PREFIX = 'cat-cafe-f276-owner-action-test:';
const ownerUserId = 'owner-1';
const sourceRef = { kind: 'message', threadId: 'thread-owner-action', messageId: 'message-owner-action' };
const lineage = {
  reflexId: 'asr-person-memory',
  reflexVersion: 1,
  opportunityId: `write_opp_${'c'.repeat(32)}`,
  dedupeLineage: `write_lineage_${'a'.repeat(32)}`,
  generation: 2,
};

const claimDraft = {
  draftId: 'person_draft_owner_action_claim',
  payload: {
    kind: 'reported_fact',
    predicate: 'organization_unit',
    value: '终端用户计算开发部',
    assertedBy: 'owner',
  },
  normalizedDraft: '黄挺属于终端用户计算开发部',
  sourceRole: 'owner_explicit',
  evidenceExcerpt: '黄挺在终端用户计算开发部',
  decision: 'pending',
};
const relationshipDraft = {
  draftId: 'person_draft_owner_action_relationship',
  payload: { status: 'current' },
  normalizedDraft: '与黄挺当前有工作关系',
  sourceRole: 'owner_explicit',
  evidenceExcerpt: '我们现在有工作关系',
  decision: 'pending',
};
const eventDraft = {
  draftId: 'person_draft_owner_action_event',
  payload: {
    eventKind: 'meeting',
    headline: '线下见面',
    importanceOrTopic: '项目协作',
    uncertaintyNotes: [],
  },
  normalizedDraft: '与黄挺线下见面',
  sourceRole: 'owner_explicit',
  evidenceExcerpt: '线下见面讨论项目协作',
  sourceEvidence: [
    {
      sourceRef,
      evidenceExcerpt: '线下见面讨论项目协作',
      supports: ['eventKind', 'headline', 'importanceOrTopic'],
    },
  ],
  decision: 'pending',
};

function candidateInput() {
  return {
    candidateId: 'person_candidate_owner_action_seed',
    ownerUserId,
    requesterCatId: 'codex-sol',
    sourceMessageRef: sourceRef,
    personDraft: {
      displayName: '黄挺',
      privateAliases: ['黄挺'],
      workspaceEntityLink: {
        entityRef: 'person:huang-ting-shared',
        state: 'linked',
        checkedAt: 90,
      },
    },
    claimDrafts: [claimDraft],
    relationshipDraft,
    interactionDraft: eventDraft,
    sourceBundle: {
      sources: [
        {
          sourceId: 'source-owner-action-claim',
          kind: 'message_text',
          sourceRef,
          ownerUserId,
          resolvedDigest: 'a'.repeat(64),
          excerpt: claimDraft.evidenceExcerpt,
        },
        {
          sourceId: 'source-owner-action-relationship',
          kind: 'message_text',
          sourceRef,
          ownerUserId,
          resolvedDigest: 'b'.repeat(64),
          excerpt: relationshipDraft.evidenceExcerpt,
        },
        {
          sourceId: 'source-owner-action-event',
          kind: 'message_text',
          sourceRef,
          ownerUserId,
          resolvedDigest: 'c'.repeat(64),
          excerpt: eventDraft.evidenceExcerpt,
        },
      ],
      assertionBindings: [
        {
          sourceId: 'source-owner-action-claim',
          target: { kind: 'claim', draftId: claimDraft.draftId },
          role: 'reported_fact',
        },
        {
          sourceId: 'source-owner-action-relationship',
          target: { kind: 'relationship', draftId: relationshipDraft.draftId, field: 'status' },
          role: 'reported_fact',
        },
        ...eventDraft.sourceEvidence[0].supports.map((field) => ({
          sourceId: 'source-owner-action-event',
          target: { kind: 'interaction', draftId: eventDraft.draftId, field },
          role: field === 'importanceOrTopic' ? 'user_assessment' : 'reported_fact',
        })),
      ],
    },
    writeOpportunityLineage: lineage,
    remainingDraftIds: [claimDraft.draftId, relationshipDraft.draftId, eventDraft.draftId],
    retention: 'owner_controlled_no_ttl',
    createdAt: 100,
  };
}

function envelopeFor(input) {
  return {
    canonicalProposalId: input.candidateId,
    sourceFeatureId: 'F276',
    ownerUserId: input.ownerUserId,
    requesterCatId: input.requesterCatId,
    originRef: { kind: 'message', threadId: sourceRef.threadId, messageId: sourceRef.messageId },
    approvalCardRef: { threadId: sourceRef.threadId, messageId: 'card-owner-action' },
    createdAt: input.createdAt,
  };
}

describe('F276 owner action Redis transaction', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let createRedisClient;
  let RedisPersonMemoryStore;
  let RedisDeferredPersonMemoryReceiptStore;
  let RedisWriteOpportunityDeliveryStore;
  let RedisWriteOpportunityTerminalLedger;
  let OwnerMemoryActionEvidenceIssuer;
  let ownerActionRequestDigest;
  let personAggregateOwnerRevision;
  let personClaimOwnerRevision;
  let personInteractionOwnerRevision;
  let PersonMemoryKeys;
  let WriteOpportunityDeliveryKeys;
  let WriteOpportunityTerminalKeys;
  let personMemoryOwnerReadRoutes;
  let sessionAuthPlugin;
  let sessionRoute;
  let PersonMemoryRecallService;
  let PersonMemoryCueSource;
  let redis;
  let store;
  let issuer;
  let deliveryStore;
  let terminalLedger;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F276 owner action Redis transaction');
    ({ createRedisClient } = await import('@cat-cafe/shared/utils'));
    ({ RedisPersonMemoryStore } = await import('../dist/domains/memory/people/RedisPersonMemoryStore.js'));
    ({ RedisDeferredPersonMemoryReceiptStore } = await import(
      '../dist/domains/memory/RedisDeferredPersonMemoryReceiptStore.js'
    ));
    ({ RedisWriteOpportunityDeliveryStore, WriteOpportunityDeliveryKeys } = await import(
      '../dist/domains/memory/people/RedisWriteOpportunityDeliveryStore.js'
    ));
    ({ RedisWriteOpportunityTerminalLedger } = await import(
      '../dist/domains/memory/people/RedisWriteOpportunityTerminalLedger.js'
    ));
    ({ WriteOpportunityTerminalKeys } = await import(
      '../dist/domains/memory/people/write-opportunity-terminal-redis-contract.js'
    ));
    ({ OwnerMemoryActionEvidenceIssuer, ownerActionRequestDigest } = await import(
      '../dist/domains/memory/people/OwnerMemoryActionEvidenceIssuer.js'
    ));
    ({ personAggregateOwnerRevision, personClaimOwnerRevision, personInteractionOwnerRevision } = await import(
      '../dist/domains/memory/people/person-memory-owner-revision.js'
    ));
    ({ PersonMemoryKeys } = await import('../dist/domains/memory/people/person-memory-keys.js'));
    ({ PersonMemoryRecallService } = await import('../dist/domains/memory/people/PersonMemoryRecallService.js'));
    ({ PersonMemoryCueSource } = await import('../dist/domains/memory/cue/sources/PersonMemoryCueSource.js'));
    ({ personMemoryOwnerReadRoutes } = await import('../dist/routes/person-memory-owner-read.js'));
    ({ sessionAuthPlugin, sessionRoute } = await import('../dist/infrastructure/session-auth.js'));
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: KEY_PREFIX });
    try {
      await redis.ping();
      connected = true;
    } catch {
      await redis.quit().catch(() => {});
    }
  });

  after(async () => {
    if (!connected) return;
    await cleanupClientKeyspace(redis);
    await redis.quit().catch(() => {});
  });

  beforeEach(async () => {
    if (!connected) return;
    await cleanupClientKeyspace(redis);
    store = new RedisPersonMemoryStore(redis);
    issuer = new OwnerMemoryActionEvidenceIssuer();
    deliveryStore = new RedisWriteOpportunityDeliveryStore(redis);
    terminalLedger = new RedisWriteOpportunityTerminalLedger(redis);
  });

  async function seed(input = candidateInput()) {
    await store.stageCandidate(input);
    await store.commitEnvelope(input.candidateId, envelopeFor(input));
    const approved = await store.approveDrafts({
      ownerUserId,
      candidateId: input.candidateId,
      selectedDraftIds: input.remainingDraftIds,
      decisionId: 'decision_owner_action_seed',
      authorizedAt: 200,
    });
    assert.equal(approved.outcome, 'applied');
    return approved.receipt.personId;
  }

  function actionInput(command, issuedAt, sourceState = 'live') {
    const requestDigest = ownerActionRequestDigest(ownerUserId, command);
    return {
      ownerUserId,
      command,
      requestDigest,
      evidence: issuer.issue({
        ownerUserId,
        sessionBindingId: 'browser-session-owner-action',
        csrfToken: 'csrf-owner-action',
        command,
        requestDigest,
        sourceState,
        issuedAt,
      }),
    };
  }

  async function recordDelivery(
    opportunityId = lineage.opportunityId,
    invocationId = 'inv-owner-action',
    deliveryLineage = lineage,
  ) {
    await deliveryStore.recordDelivered({
      v: 1,
      opportunityId,
      dedupeLineage: deliveryLineage.dedupeLineage,
      generation: deliveryLineage.generation,
      reflexId: deliveryLineage.reflexId,
      reflexVersion: deliveryLineage.reflexVersion,
      ownerUserId,
      threadId: sourceRef.threadId,
      consumerCatId: 'codex-sol',
      invocationId,
      eligibleAt: 1,
      expiresAt: 10_000,
      rearmPredicate: 'next_eligible_owner_context_after_defer',
      destinationProposalContract: 'F276.CaptureCandidate.v1',
      sourceRefs: [
        {
          artifactId: 'meeting-owner-action',
          sourceRevision: `sha256:${'1'.repeat(64)}`,
          attributionRevision: `sha256:${'2'.repeat(64)}`,
          segmentStart: 0,
          segmentEnd: 10,
        },
      ],
      presentedAt: 2,
      generationId: `sha256:${'3'.repeat(64)}`,
      evidenceRef: 'evidence-owner-action',
      continuityDispositionRef: 'disposition-owner-action',
    });
  }

  it('admits one double-tab correction, replays exact requests, rejects digest reuse, and atomically invalidates F296', async () => {
    const personId = await seed();
    await recordDelivery();
    const deferredLineage = {
      ...lineage,
      opportunityId: `write_opp_${'e'.repeat(32)}`,
      dedupeLineage: `write_lineage_${'f'.repeat(32)}`,
    };
    const deferredStore = new RedisDeferredPersonMemoryReceiptStore(redis);
    const deferredReceiptId = `deferred_person_${'7'.repeat(32)}`;
    const deferred = await deferredStore.stage({
      receiptId: deferredReceiptId,
      ownerUserId,
      requesterCatId: 'codex-sol',
      invocationId: 'inv-deferred-owner-action',
      originMessageRef: sourceRef,
      subject: '黄挺',
      normalizedSubject: '黄挺',
      registryBinding: { kind: 'registered_person', ref: personId },
      sourceCoordinates: [{ kind: 'message', sourceRef, resolvedDigest: '9'.repeat(64) }],
      sourceBundleDigest: '8'.repeat(64),
      dedupeHash: '7'.repeat(64),
      writeOpportunityLineage: deferredLineage,
      writeOpportunityReceipt: {
        v: 1,
        receiptId: deferredReceiptId,
        ...deferredLineage,
        sourceRefs: [
          {
            artifactId: 'meeting-deferred-owner-action',
            sourceRevision: `sha256:${'4'.repeat(64)}`,
            attributionRevision: `sha256:${'5'.repeat(64)}`,
            segmentStart: 0,
            segmentEnd: 10,
          },
        ],
        eligibleAt: 200,
        expiresAt: 10_000,
        rearmPredicate: 'next_eligible_owner_context_after_defer',
        destinationProposalContract: 'F276.CaptureCandidate.v1',
        state: 'deferred',
      },
      ready: true,
      createdAt: 210,
    });
    assert.equal(deferred.outcome, 'created');
    await recordDelivery(deferredLineage.opportunityId, 'inv-deferred-owner-action', deferredLineage);
    const [original] = await store.listClaims(ownerUserId, personId);
    const expectedRevision = personClaimOwnerRevision(original);
    const first = {
      action: 'correct_claim',
      personId,
      requestId: 'owner_action_correct_aaaaaaaa',
      claimId: original.claimId,
      expectedRevision,
      payload: { ...original.payload, value: '云计算产品部' },
    };
    const second = {
      ...first,
      requestId: 'owner_action_correct_bbbbbbbb',
      payload: { ...original.payload, value: '计算产品部' },
    };
    const forged = actionInput(first, 299);
    forged.evidence = JSON.parse(JSON.stringify(forged.evidence));
    assert.equal((await store.executeOwnerAction(forged)).outcome, 'mutation_unavailable');
    assert.equal((await store.listClaims(ownerUserId, personId)).length, 1);
    assert.equal(await redis.get(PersonMemoryKeys.ownerActionReceipt(ownerUserId, first.requestId)), null);
    assert.equal(await redis.get(PersonMemoryKeys.ownerActionGeneration(ownerUserId, personId)), null);
    assert.notEqual(await deliveryStore.get(ownerUserId, lineage.opportunityId), null);
    assert.equal(
      (await terminalLedger.readLineageStates(ownerUserId, [lineage.dedupeLineage])).get(lineage.dedupeLineage)
        .invalidatedReason,
      undefined,
    );
    const [left, right] = await Promise.all([
      store.executeOwnerAction(actionInput(first, 300)),
      store.executeOwnerAction(actionInput(second, 301)),
    ]);
    assert.deepEqual([left.outcome, right.outcome].sort(), ['applied', 'stale_revision']);
    const winner = left.outcome === 'applied' ? first : second;
    const winnerInput = left.outcome === 'applied' ? actionInput(first, 300) : actionInput(second, 301);
    assert.equal((await store.executeOwnerAction(winnerInput)).outcome, 'replayed');

    const conflicting = {
      ...winner,
      payload: { ...original.payload, value: '不同内容复用同一 requestId' },
    };
    assert.equal((await store.executeOwnerAction(actionInput(conflicting, 302))).outcome, 'idempotency_conflict');

    const claims = await store.listClaims(ownerUserId, personId);
    assert.equal(claims.filter((item) => item.status === 'current').length, 1);
    assert.equal(claims.filter((item) => item.status === 'superseded').length, 1);
    const current = claims.find((item) => item.status === 'current');
    assert.deepEqual(current.sourceRefs, []);
    assert.equal(current.materializedBy.kind, 'owner_memory_action');
    const lineageState = (await terminalLedger.readLineageStates(ownerUserId, [lineage.dedupeLineage])).get(
      lineage.dedupeLineage,
    );
    assert.equal(lineageState.invalidatedReason, 'source_corrected');
    assert.equal(await deliveryStore.get(ownerUserId, lineage.opportunityId), null);
    assert.deepEqual(await deliveryStore.listInvocationOpportunityIds(ownerUserId, 'inv-owner-action'), []);
    const deferredState = (await terminalLedger.readLineageStates(ownerUserId, [deferredLineage.dedupeLineage])).get(
      deferredLineage.dedupeLineage,
    );
    assert.equal(deferredState.invalidatedReason, 'source_corrected');
    assert.equal(await deliveryStore.get(ownerUserId, deferredLineage.opportunityId), null);
  });

  it('keeps retirement in history and lets a fresh owner action re-declare it as current', async () => {
    const personId = await seed();
    const [original] = await store.listClaims(ownerUserId, personId);
    const retire = {
      action: 'retire_claim',
      personId,
      requestId: 'owner_action_retire_aaaaaaaa',
      claimId: original.claimId,
      expectedRevision: personClaimOwnerRevision(original),
    };
    assert.equal((await store.executeOwnerAction(actionInput(retire, 300))).outcome, 'applied');
    const retired = (await store.listClaims(ownerUserId, personId)).find((item) => item.status === 'retired');
    assert.ok(retired);
    const redeclare = {
      action: 'correct_claim',
      personId,
      requestId: 'owner_action_redeclare_aaaaaa',
      claimId: retired.claimId,
      expectedRevision: personClaimOwnerRevision(retired),
      payload: { ...retired.payload, value: '终端云产品部' },
    };
    assert.equal((await store.executeOwnerAction(actionInput(redeclare, 400))).outcome, 'applied');
    const claims = await store.listClaims(ownerUserId, personId);
    assert.equal(claims.find((item) => item.claimId === retired.claimId).status, 'retired');
    assert.equal(claims.filter((item) => item.status === 'current').length, 1);
  });

  it('allows one amendment child per exact event revision and retains the original event', async () => {
    const personId = await seed();
    const [original] = await store.listInteractionEvents(ownerUserId, personId);
    const command = {
      action: 'amend_event',
      personId,
      requestId: 'owner_action_amend_aaaaaaaaa',
      eventId: original.eventId,
      expectedRevision: personInteractionOwnerRevision(original),
      payload: {
        eventKind: 'meeting',
        headline: '线上复盘',
        importanceOrTopic: '项目复盘',
        uncertaintyNotes: [],
      },
    };
    assert.equal((await store.executeOwnerAction(actionInput(command, 300))).outcome, 'applied');
    const competing = {
      ...command,
      requestId: 'owner_action_amend_bbbbbbbbb',
      payload: { ...command.payload, headline: '另一个分支' },
    };
    assert.equal((await store.executeOwnerAction(actionInput(competing, 301))).outcome, 'stale_revision');
    const events = await store.listInteractionEvents(ownerUserId, personId);
    assert.equal(events.length, 2);
    assert.equal(events[0].eventId, original.eventId);
    assert.equal(events[0].status, 'superseded');
    assert.equal(events[1].amendsEventId, original.eventId);
    assert.equal(events[1].status, 'active');
    const legacy = await store.amendInteractionEvent({
      ownerUserId,
      personId,
      expectedEventId: original.eventId,
      sourceMessageRef: sourceRef,
      payload: { ...command.payload, headline: '旧 writer 试图分叉' },
      requestId: 'legacy_amend_after_owner_aaaa',
      amendedAt: 400,
    });
    assert.equal(legacy.outcome, 'not_available');
    assert.equal(
      (await store.listInteractionEvents(ownerUserId, personId)).filter(
        (event) => event.amendsEventId === original.eventId && event.status === 'active',
      ).length,
      1,
    );
  });

  it('keeps owner-action correction, retirement, redeclaration and amendment readable through recall and cues', async () => {
    const personId = await seed();
    const message = {
      id: sourceRef.messageId,
      threadId: sourceRef.threadId,
      userId: ownerUserId,
      catId: null,
      content: '黄挺在终端用户计算开发部，我们线下见面讨论了项目协作。',
      timestamp: 90,
      deliveryStatus: 'delivered',
    };
    const recall = new PersonMemoryRecallService(store, { resolve: async () => ({ status: 'not_found' }) });
    const cue = new PersonMemoryCueSource({
      recall,
      messageStore: { getById: async (messageId) => (messageId === message.id ? message : null) },
    });
    const cueInput = {
      ownerUserId,
      threadId: sourceRef.threadId,
      entityId: 'person:huang-ting-shared',
      matchedAlias: '黄挺',
      sourceMessageId: sourceRef.messageId,
    };
    const assertSurfaces = async ({ factCount, factProvenance, headline }) => {
      const [byId, byAlias] = await Promise.all([
        recall.recallByPersonId(ownerUserId, personId),
        recall.recallByAlias(ownerUserId, '黄挺'),
      ]);
      for (const result of [byId, byAlias]) {
        assert.equal(result.status, 'resolved');
        assert.equal(result.card.facts.length, factCount);
        if (factProvenance) assert.equal(result.card.facts[0].provenanceKind, factProvenance);
        if (headline) assert.equal(result.card.latestInteraction.headline, headline);
      }
      const candidate = await cue.resolve(cueInput);
      assert.ok(candidate);
      assert.equal(
        (
          await cue.read({
            ownerUserId,
            anchor: candidate.anchor,
            expectedRevision: candidate.revision,
          })
        ).status,
        'ok',
      );
      return candidate;
    };

    const initialCue = await assertSurfaces({ factCount: 1, factProvenance: 'message', headline: '线下见面' });
    let current = (await store.listClaims(ownerUserId, personId)).find((claim) => claim.status === 'current');
    assert.equal(
      (
        await store.executeOwnerAction(
          actionInput(
            {
              action: 'correct_claim',
              personId,
              requestId: 'owner_action_recall_correct_aaaa',
              claimId: current.claimId,
              expectedRevision: personClaimOwnerRevision(current),
              payload: { ...current.payload, value: '云计算产品部' },
            },
            300,
          ),
        )
      ).outcome,
      'applied',
    );
    assert.deepEqual(
      await cue.read({ ownerUserId, anchor: initialCue.anchor, expectedRevision: initialCue.revision }),
      { status: 'not_available', invalidationReason: 'source_corrected' },
    );
    const correctedCue = await assertSurfaces({
      factCount: 1,
      factProvenance: 'owner_memory_action',
      headline: '线下见面',
    });
    current = (await store.listClaims(ownerUserId, personId)).find((claim) => claim.status === 'current');
    assert.deepEqual(
      await recall.drill({
        ownerUserId,
        turnId: 'turn-corrected-owner-action',
        personId,
        item: { kind: 'claim', id: current.claimId },
        timeWindow: { from: 0, to: 1_000 },
      }),
      { status: 'not_available', reason: 'owner_action_has_no_message_source' },
    );

    assert.equal(
      (
        await store.executeOwnerAction(
          actionInput(
            {
              action: 'retire_claim',
              personId,
              requestId: 'owner_action_recall_retire_aaaa',
              claimId: current.claimId,
              expectedRevision: personClaimOwnerRevision(current),
            },
            400,
          ),
        )
      ).outcome,
      'applied',
    );
    assert.deepEqual(
      await cue.read({ ownerUserId, anchor: correctedCue.anchor, expectedRevision: correctedCue.revision }),
      { status: 'not_available', invalidationReason: 'source_corrected' },
    );
    const retiredCue = await assertSurfaces({ factCount: 0, headline: '线下见面' });
    const retired = (await store.listClaims(ownerUserId, personId)).find((claim) => claim.status === 'retired');
    assert.equal(
      (
        await store.executeOwnerAction(
          actionInput(
            {
              action: 'correct_claim',
              personId,
              requestId: 'owner_action_recall_redeclare_aa',
              claimId: retired.claimId,
              expectedRevision: personClaimOwnerRevision(retired),
              payload: { ...retired.payload, value: '终端云产品部' },
            },
            500,
          ),
        )
      ).outcome,
      'applied',
    );
    assert.deepEqual(
      await cue.read({ ownerUserId, anchor: retiredCue.anchor, expectedRevision: retiredCue.revision }),
      { status: 'not_available', invalidationReason: 'source_corrected' },
    );
    const redeclaredCue = await assertSurfaces({
      factCount: 1,
      factProvenance: 'owner_memory_action',
      headline: '线下见面',
    });

    const originalEvent = (await store.listInteractionEvents(ownerUserId, personId)).find(
      (event) => event.status === 'active',
    );
    assert.equal(
      (
        await store.executeOwnerAction(
          actionInput(
            {
              action: 'amend_event',
              personId,
              requestId: 'owner_action_recall_amend_aaaaa',
              eventId: originalEvent.eventId,
              expectedRevision: personInteractionOwnerRevision(originalEvent),
              payload: {
                eventKind: 'meeting',
                headline: '线上复盘',
                importanceOrTopic: '项目复盘',
                uncertaintyNotes: [],
              },
            },
            600,
          ),
        )
      ).outcome,
      'applied',
    );
    assert.deepEqual(
      await cue.read({ ownerUserId, anchor: redeclaredCue.anchor, expectedRevision: redeclaredCue.revision }),
      { status: 'not_available', invalidationReason: 'source_corrected' },
    );
    await assertSurfaces({ factCount: 1, factProvenance: 'owner_memory_action', headline: '线上复盘' });
    const amended = (await store.listInteractionEvents(ownerUserId, personId)).find(
      (event) => event.status === 'active',
    );
    assert.deepEqual(
      await recall.drill({
        ownerUserId,
        turnId: 'turn-amended-owner-action',
        personId,
        item: { kind: 'event', id: amended.eventId },
        timeWindow: { from: 0, to: 1_000 },
      }),
      { status: 'not_available', reason: 'owner_action_has_no_message_source' },
    );
  });

  it('releases the hard-forget fence without deleting anything when the aggregate person revision is stale', async () => {
    const personId = await seed();
    const person = await store.getPerson(ownerUserId, personId);
    const [claims, relationships, events] = await Promise.all([
      store.listClaims(ownerUserId, personId),
      store.listRelationships(ownerUserId, personId),
      store.listInteractionEvents(ownerUserId, personId),
    ]);
    const stalePersonRevision = personAggregateOwnerRevision({ person, claims, relationships, events });
    const correct = {
      action: 'correct_claim',
      personId,
      requestId: 'owner_action_stale_forget_correct',
      claimId: claims[0].claimId,
      expectedRevision: personClaimOwnerRevision(claims[0]),
      payload: { ...claims[0].payload, value: '云计算产品部' },
    };
    assert.equal((await store.executeOwnerAction(actionInput(correct, 300))).outcome, 'applied');
    const forget = {
      action: 'hard_forget_person',
      personId,
      requestId: 'person_forget_stale_owner_action_aaaaaaaa',
      expectedPersonRevision: stalePersonRevision,
      confirmed: true,
    };
    assert.equal((await store.executeOwnerAction(actionInput(forget, 400))).outcome, 'stale_revision');
    assert.notEqual(await store.getPerson(ownerUserId, personId), null);
    assert.notDeepEqual(await store.listClaims(ownerUserId, personId), []);
    assert.equal(await redis.get(PersonMemoryKeys.forgetFence(ownerUserId, personId)), null);
    assert.equal(await redis.get(PersonMemoryKeys.forgetReceipt(ownerUserId, forget.requestId)), null);
  });

  it('hard-forgets the full owner-action/F296 closure while preserving original chat and shared Entity truth', async () => {
    const personId = await seed();
    const [claim] = await store.listClaims(ownerUserId, personId);
    const correct = {
      action: 'correct_claim',
      personId,
      requestId: 'owner_action_before_forget_aaaa',
      claimId: claim.claimId,
      expectedRevision: personClaimOwnerRevision(claim),
      payload: { ...claim.payload, value: '云计算产品部' },
    };
    assert.equal((await store.executeOwnerAction(actionInput(correct, 300))).outcome, 'applied');
    const secondOpportunityId = `write_opp_${'d'.repeat(32)}`;
    await recordDelivery(secondOpportunityId, 'inv-owner-action-after-correct');
    await redis.set('message:original-owner-action', 'original chat must survive');
    await redis.set('entity-registry:person:huang-ting-shared', 'shared Entity must survive');

    const person = await store.getPerson(ownerUserId, personId);
    const [claims, relationships, events] = await Promise.all([
      store.listClaims(ownerUserId, personId),
      store.listRelationships(ownerUserId, personId),
      store.listInteractionEvents(ownerUserId, personId),
    ]);
    const command = {
      action: 'hard_forget_person',
      personId,
      requestId: 'person_forget_owner_action_aaaaaaaa',
      expectedPersonRevision: personAggregateOwnerRevision({ person, claims, relationships, events }),
      confirmed: true,
    };
    const forgotten = await store.executeOwnerAction(actionInput(command, 500));
    assert.equal(forgotten.outcome, 'applied');
    assert.equal(forgotten.receipt.verdict, 'purged');
    assert.equal(await store.getPerson(ownerUserId, personId), null);
    assert.deepEqual(await store.listClaims(ownerUserId, personId), []);
    assert.deepEqual(await store.listRelationships(ownerUserId, personId), []);
    assert.deepEqual(await store.listInteractionEvents(ownerUserId, personId), []);
    assert.equal(await redis.get(PersonMemoryKeys.ownerActionReceipt(ownerUserId, correct.requestId)), null);
    assert.equal(await redis.get(PersonMemoryKeys.ownerActionGeneration(ownerUserId, personId)), null);
    assert.equal(await redis.get(WriteOpportunityTerminalKeys.lineage(ownerUserId, lineage.dedupeLineage)), null);
    assert.equal(await redis.get(WriteOpportunityDeliveryKeys.delivered(ownerUserId, secondOpportunityId)), null);
    assert.equal(await redis.get('message:original-owner-action'), 'original chat must survive');
    assert.equal(await redis.get('entity-registry:person:huang-ting-shared'), 'shared Entity must survive');
    const receiptText = JSON.stringify(forgotten.receipt);
    assert.equal(receiptText.includes(personId), false);
    assert.equal(receiptText.includes('黄挺'), false);
    assert.equal(receiptText.includes(sourceRef.messageId), false);

    assert.equal((await store.executeOwnerAction(actionInput(command, 500))).outcome, 'replayed');
    const newRequest = { ...command, requestId: 'person_forget_owner_action_bbbbbbbb' };
    assert.equal((await store.executeOwnerAction(actionInput(newRequest, 600))).outcome, 'not_available');
  });

  it('runs the browser owner journey end to end through revisions, synthetic sources, retirement, amendment and forget', async () => {
    const legacyInput = candidateInput();
    delete legacyInput.sourceBundle;
    const personId = await seed(legacyInput);
    const message = {
      id: sourceRef.messageId,
      threadId: sourceRef.threadId,
      userId: ownerUserId,
      catId: null,
      content: '黄挺在终端用户计算开发部，我们线下见面讨论了项目协作。',
      timestamp: 90,
      deliveryStatus: 'delivered',
    };
    const app = Fastify();
    await app.register(cookie);
    await app.register(sessionAuthPlugin);
    await app.register(sessionRoute, { ownerUserId });
    await app.register(personMemoryOwnerReadRoutes, {
      ownerUserId,
      store,
      messageStore: { getById: async (id) => (id === message.id ? message : null) },
      threadStore: {
        get: async (id) =>
          id === sourceRef.threadId
            ? { id, title: '人物来源对话', createdBy: ownerUserId, visibility: 'private' }
            : null,
        list: async () => [],
      },
    });
    await app.ready();
    try {
      const login = await app.inject({
        method: 'GET',
        url: '/api/session',
        headers: { origin: 'http://localhost:3003' },
      });
      const sessionCookie = login.headers['set-cookie'].split(';', 1)[0];
      const csrfToken = login.json().csrfToken;
      const getDetail = async () => {
        const response = await app.inject({
          method: 'GET',
          url: `/api/memory/people/${personId}`,
          headers: { cookie: sessionCookie },
        });
        assert.equal(response.statusCode, 200, response.body);
        return response.json();
      };
      const post = (payload) =>
        app.inject({
          method: 'POST',
          url: `/api/memory/people/${personId}/actions`,
          headers: {
            cookie: sessionCookie,
            origin: 'http://localhost:3003',
            'x-csrf-token': csrfToken,
            'content-type': 'application/json',
          },
          payload,
        });

      let detail = await getDetail();
      const originalClaim = detail.claims.find((item) => item.status === 'current');
      const corrected = await post({
        action: 'correct_claim',
        requestId: 'owner_action_http_correct_0123456789abcdef',
        claimId: originalClaim.claimId,
        expectedRevision: originalClaim.revision,
        payload: { ...originalClaim.payload, value: '云计算产品部' },
      });
      assert.equal(corrected.statusCode, 200, corrected.body);
      const correctedResult = corrected.json();
      const source = await app.inject({
        method: 'GET',
        url: `/api/memory/people/${personId}/source?kind=claim&itemId=${correctedResult.itemId}`,
        headers: { cookie: sessionCookie },
      });
      assert.equal(source.statusCode, 200, source.body);
      assert.equal(source.json().sources[0].kind, 'owner_action');
      assert.equal(source.json().sources[0].canOpen, false);

      detail = await getDetail();
      const currentAfterCorrection = detail.claims.find((item) => item.status === 'current');
      const retired = await post({
        action: 'retire_claim',
        requestId: 'owner_action_http_retire_0123456789abcdef',
        claimId: currentAfterCorrection.claimId,
        expectedRevision: currentAfterCorrection.revision,
      });
      assert.equal(retired.statusCode, 200, retired.body);
      detail = await getDetail();
      const retiredClaim = detail.claims.find((item) => item.claimId === retired.json().itemId);
      assert.equal(retiredClaim.status, 'retired');

      const redeclared = await post({
        action: 'correct_claim',
        requestId: 'owner_action_http_redeclare_0123456789ab',
        claimId: retiredClaim.claimId,
        expectedRevision: retiredClaim.revision,
        payload: { ...retiredClaim.payload, value: '终端云产品部' },
      });
      assert.equal(redeclared.statusCode, 200, redeclared.body);
      detail = await getDetail();
      assert.equal(detail.claims.find((item) => item.claimId === retiredClaim.claimId).status, 'retired');
      assert.equal(detail.claims.filter((item) => item.status === 'current').length, 1);

      const originalEvent = detail.interactions.find((item) => item.status === 'active');
      const amended = await post({
        action: 'amend_event',
        requestId: 'owner_action_http_amend_0123456789abcdef',
        eventId: originalEvent.eventId,
        expectedRevision: originalEvent.revision,
        payload: {
          eventKind: 'meeting',
          headline: '线上复盘',
          importanceOrTopic: '项目复盘',
          uncertaintyNotes: [],
        },
      });
      assert.equal(amended.statusCode, 200, amended.body);
      detail = await getDetail();
      assert.equal(detail.interactions.filter((item) => item.status === 'active').length, 1);
      assert.equal(detail.interactions.find((item) => item.eventId === originalEvent.eventId).status, 'superseded');

      await redis.set('entity-registry:person:huang-ting-shared', 'shared Entity must survive');
      const forgotten = await post({
        action: 'hard_forget_person',
        requestId: 'person_forget_http_owner_action_0123456789abcdef',
        expectedPersonRevision: detail.personRevision,
        confirmed: true,
      });
      assert.equal(forgotten.statusCode, 200, forgotten.body);
      assert.equal(
        (
          await app.inject({
            method: 'GET',
            url: `/api/memory/people/${personId}`,
            headers: { cookie: sessionCookie },
          })
        ).statusCode,
        404,
      );
      assert.equal(message.content.includes('黄挺'), true);
      assert.equal(await redis.get('entity-registry:person:huang-ting-shared'), 'shared Entity must survive');
    } finally {
      await app.close();
    }
  });
});
