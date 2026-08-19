import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const KEY_PREFIX = 'cat-cafe-f276-proposal-routes-test:';

describe('F276 person-memory proposal routes', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let app;
  let redis;
  let store;
  let routeStore;
  let registry;
  let messageStore;
  let workspaceResolution;
  let workspaceResolutions;
  let artifactResolutions;
  let socketEvents;
  let digestSourceMaterial;
  let personMemoryDeltaFingerprint;
  let proposalPersonMemoryDeltaCoordinates;
  let receiptStore;
  let stageCalls = 0;
  let afterStage;
  let beforeCommitEnvelope;
  let deferredReceipt;
  let deliveredWriteOpportunities;
  let writeOpportunityTerminals;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F276 proposal routes');
    const [
      routeMod,
      storeMod,
      registryMod,
      messageMod,
      authMod,
      redisMod,
      sourceResolverMod,
      receiptStoreMod,
      deltaLineageMod,
    ] = await Promise.all([
      import('../dist/routes/callback-propose-person-memory-routes.js'),
      import('../dist/domains/memory/people/RedisPersonMemoryStore.js'),
      import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'),
      import('../dist/domains/cats/services/stores/ports/MessageStore.js'),
      import('../dist/routes/callback-auth-prehandler.js'),
      import('@cat-cafe/shared/utils'),
      import('../dist/domains/memory/people/PersonMemorySourceBundleResolver.js'),
      import('../dist/domains/memory/RedisDeferredPersonMemoryReceiptStore.js'),
      import('../dist/domains/memory/people/person-memory-delta-lineage.js'),
    ]);
    digestSourceMaterial = sourceResolverMod.digestPersonMemorySourceMaterial;
    personMemoryDeltaFingerprint = deltaLineageMod.personMemoryDeltaFingerprint;
    proposalPersonMemoryDeltaCoordinates = deltaLineageMod.proposalPersonMemoryDeltaCoordinates;
    redis = redisMod.createRedisClient({ url: REDIS_URL, keyPrefix: KEY_PREFIX });
    try {
      await redis.ping();
      connected = true;
    } catch {
      await redis.quit().catch(() => {});
      return;
    }
    store = new storeMod.RedisPersonMemoryStore(redis);
    receiptStore = new receiptStoreMod.RedisDeferredPersonMemoryReceiptStore(redis);
    routeStore = new Proxy(store, {
      get(target, property) {
        if (property === 'stageCandidate') {
          return async (input) => {
            stageCalls += 1;
            const staged = await target.stageCandidate(input);
            if (afterStage) await afterStage(input);
            return staged;
          };
        }
        if (property === 'commitEnvelope') {
          return async (...args) => {
            if (beforeCommitEnvelope) await beforeCommitEnvelope(...args);
            return target.commitEnvelope(...args);
          };
        }
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    registry = new registryMod.InvocationRegistry();
    messageStore = new messageMod.MessageStore();
    const socketManager = {
      emitToUser(userId, event, payload) {
        socketEvents.push({ userId, event, payload });
      },
      broadcastToRoom() {},
    };
    app = Fastify();
    authMod.registerCallbackAuthHook(app, registry);
    routeMod.registerCallbackProposePersonMemoryRoutes(app, {
      registry,
      store: routeStore,
      messageStore,
      socketManager,
      workspacePersonResolver: {
        resolve: async (alias) => workspaceResolutions.get(alias) ?? workspaceResolution,
      },
      ownerPrivateArtifactResolver: {
        resolve: async (ownerUserId, artifactLocator) =>
          artifactResolutions.get(`${ownerUserId}:${artifactLocator}`) ?? null,
      },
      deferredReceiptStore: receiptStore,
      writeOpportunityDeliveryStore: {
        async get(ownerUserId, opportunityId) {
          return (
            deliveredWriteOpportunities.find(
              (record) => record.ownerUserId === ownerUserId && record.opportunityId === opportunityId,
            ) ?? null
          );
        },
        async recordDelivered() {},
        async listInvocationOpportunityIds(ownerUserId, invocationId) {
          return deliveredWriteOpportunities
            .filter((record) => record.ownerUserId === ownerUserId && record.invocationId === invocationId)
            .map((record) => record.opportunityId);
        },
        async purgeLineage() {
          return 0;
        },
      },
      writeOpportunityTerminalLedger: {
        async recordTerminal(input) {
          writeOpportunityTerminals.push(input);
        },
        async recordInvalidated() {},
        async readLineageStates() {
          return new Map();
        },
      },
    });
    await app.ready();
  });

  after(async () => {
    await app?.close();
    if (!connected) return;
    await cleanupClientKeyspace(redis);
    await redis.quit().catch(() => {});
  });

  beforeEach(async () => {
    if (connected) await cleanupClientKeyspace(redis);
    stageCalls = 0;
    afterStage = undefined;
    beforeCommitEnvelope = undefined;
    socketEvents = [];
    workspaceResolution = {
      status: 'resolved',
      entityRef: 'person:huang-ting-huawei',
      canonicalName: '黄挺',
    };
    workspaceResolutions = new Map();
    artifactResolutions = new Map();
    deferredReceipt = undefined;
    deliveredWriteOpportunities = [];
    writeOpportunityTerminals = [];
  });

  async function propose(body, originContent = '黄挺是终端用户计算开发部 21 级') {
    const origin = await messageStore.append({
      userId: 'owner-1',
      catId: null,
      content: originContent,
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread_people',
    });
    const response = await proposeFromOrigin(body, origin);
    return { response, origin };
  }

  async function proposeFromOrigin(body, origin, onAuth) {
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
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/propose-person-memory',
      headers: {
        'x-invocation-id': auth.invocationId,
        'x-callback-token': auth.callbackToken,
        'content-type': 'application/json',
      },
      payload: { sourceMessageId: origin.id, ...body },
    });
    return response;
  }

  const proposalBody = {
    person: { displayName: '黄挺', privateAliases: ['黄挺'] },
    claims: [
      {
        payload: {
          kind: 'reported_fact',
          predicate: 'organization_unit',
          value: '终端用户计算开发部',
          assertedBy: 'owner',
        },
        normalizedDraft: '黄挺属于终端用户计算开发部',
        sourceRole: 'owner_explicit',
        evidenceExcerpt: '黄挺是终端用户计算开发部 21 级',
      },
    ],
    clientRequestId: 'f276-route-1',
  };

  const writeOpportunityRef = {
    opportunityId: `write_opp_${'c'.repeat(32)}`,
    dedupeLineage: `write_lineage_${'a'.repeat(32)}`,
    generation: 1,
  };

  function deliveredWriteOpportunity(invocationId) {
    return {
      v: 1,
      ...writeOpportunityRef,
      reflexId: 'asr-person-memory',
      reflexVersion: 1,
      ownerUserId: 'owner-1',
      threadId: 'thread_people',
      consumerCatId: 'codex-sol',
      invocationId,
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
    };
  }

  it('binds an ASR proposal to delivered evidence and closes that generation', async () => {
    const origin = await messageStore.append({
      userId: 'owner-1',
      catId: null,
      content: '黄挺是终端用户计算开发部 21 级',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread_people',
    });
    const response = await proposeFromOrigin({ ...proposalBody, writeOpportunityRef }, origin, (auth) =>
      deliveredWriteOpportunities.push(deliveredWriteOpportunity(auth.invocationId)),
    );

    assert.equal(response.statusCode, 200, response.body);
    const candidateId = response.json().candidateId;
    assert.deepEqual(writeOpportunityTerminals, [
      {
        ownerUserId: 'owner-1',
        dedupeLineage: writeOpportunityRef.dedupeLineage,
        generation: 1,
        outcome: 'propose',
        recordedAt: writeOpportunityTerminals[0].recordedAt,
      },
    ]);
    const candidate = await store.getCandidateForOwner('owner-1', candidateId);
    assert.equal(candidate.publication.state, 'anchored');
    assert.deepEqual(candidate.writeOpportunityLineage, {
      reflexId: 'asr-person-memory',
      reflexVersion: 1,
      ...writeOpportunityRef,
    });
  });

  it('rejects an unattributed proposal when this invocation received an opportunity', async () => {
    const origin = await messageStore.append({
      userId: 'owner-1',
      catId: null,
      content: '黄挺是终端用户计算开发部 21 级',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread_people',
    });
    const response = await proposeFromOrigin(proposalBody, origin, (auth) =>
      deliveredWriteOpportunities.push(deliveredWriteOpportunity(auth.invocationId)),
    );

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().reason, 'write_opportunity_ref_required');
    assert.equal(stageCalls, 0);
    assert.deepEqual(writeOpportunityTerminals, []);
  });

  it('derives ownership and origin, persists the rich card, then anchors one candidate', async () => {
    const { response, origin } = await propose(proposalBody);
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    const candidate = await store.getCandidateForOwner('owner-1', body.candidateId);
    assert.equal(candidate.ownerUserId, 'owner-1');
    assert.equal(candidate.requesterCatId, 'codex-sol');
    assert.equal(candidate.sourceMessageRef.messageId, origin.id);
    assert.equal(candidate.personDraft.workspaceEntityLink.entityRef, 'person:huang-ting-huawei');
    assert.equal(candidate.personDraft.workspaceEntityLink.state, 'linked');
    assert.equal(typeof candidate.personDraft.workspaceEntityLink.checkedAt, 'number');
    assert.equal(candidate.publication.state, 'anchored');
    assert.equal(candidate.claimDrafts.length, 1);
    assert.match(candidate.claimDrafts[0].draftId, /^person_draft_/);

    const messages = await messageStore.getByThread('thread_people', 20, 'owner-1');
    const card = messages
      .flatMap((message) => message.extra?.rich?.blocks ?? [])
      .find((block) => block.meta?.kind === 'person_memory_proposal');
    assert.equal(card.meta.candidateId, body.candidateId);
    assert.equal(card.meta.subjectDisplayName, '黄挺');
    assert.deepEqual(
      card.actions.map((action) => action.action),
      ['person-memory:open-approval-hub'],
    );
  });

  it('atomically binds an exact claimed deferred receipt and rejects a withdraw race', async () => {
    const history = await messageStore.append({
      userId: 'owner-1',
      catId: null,
      content: '黄挺和我聊了三小时团队管理',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread_history',
    });
    const origin = await messageStore.append({
      userId: 'owner-1',
      catId: null,
      content: 'daily deferred memory clerk',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread_people',
    });
    const unrelated = await messageStore.append({
      userId: 'owner-1',
      catId: null,
      content: '这是一条未进入 deferred receipt 的其他人物证据',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread_history',
    });
    const sourceCoordinates = [
      {
        kind: 'message',
        sourceRef: { kind: 'message', threadId: 'thread_history', messageId: history.id },
        resolvedDigest: digestSourceMaterial(history.content),
      },
    ];
    const registryBinding = { kind: 'registered_entity', ref: 'person:huang-ting-huawei' };
    const receiptId = `deferred_person_${'a'.repeat(32)}`;
    const stagedReceipt = await receiptStore.stage({
      receiptId,
      ownerUserId: 'owner-1',
      requesterCatId: 'codex-sol',
      invocationId: 'invocation-deferred',
      originMessageRef: { kind: 'message', threadId: 'thread_people', messageId: origin.id },
      subject: '黄挺',
      normalizedSubject: '黄挺',
      registryBinding,
      sourceCoordinates,
      sourceBundleDigest: 'a'.repeat(64),
      dedupeHash: personMemoryDeltaFingerprint(registryBinding, sourceCoordinates),
      ready: true,
      createdAt: Date.now() - 1_000,
    });
    assert.equal(stagedReceipt.outcome, 'created');
    const claimedReceipt = await receiptStore.claim({
      ownerUserId: 'owner-1',
      receiptId,
      claimId: 'daily-claim-1',
      now: Date.now(),
      leaseMs: 60_000,
    });
    assert.equal(claimedReceipt.outcome, 'claimed');
    deferredReceipt = claimedReceipt.receipt;
    const body = {
      ...proposalBody,
      claims: [],
      interaction: {
        payload: {
          duration: { kind: 'approximate', raw: '约三小时', qualifier: 'about' },
          eventKind: 'meeting',
          headline: '黄挺与 You 交流团队管理',
          importanceOrTopic: '团队管理',
          uncertaintyNotes: ['具体发生时间未说明'],
        },
        normalizedDraft: '黄挺与 You 进行了约三小时的团队管理交流',
        sourceRole: 'owner_explicit',
        evidenceExcerpt: history.content,
        sources: [
          {
            messageId: history.id,
            evidenceExcerpt: history.content,
            supports: ['eventKind', 'headline', 'duration', 'importanceOrTopic', 'uncertaintyNotes'],
          },
        ],
      },
      sourceBundle: {
        sources: [
          {
            sourceId: 'history-message',
            kind: 'message_text',
            messageId: history.id,
            excerpt: history.content,
          },
        ],
        assertionBindings: [
          { sourceId: 'history-message', target: { kind: 'interaction', field: 'eventKind' }, role: 'reported_fact' },
          { sourceId: 'history-message', target: { kind: 'interaction', field: 'headline' }, role: 'reported_fact' },
          { sourceId: 'history-message', target: { kind: 'interaction', field: 'duration' }, role: 'reported_fact' },
          {
            sourceId: 'history-message',
            target: { kind: 'interaction', field: 'importanceOrTopic' },
            role: 'user_assessment',
          },
          {
            sourceId: 'history-message',
            target: { kind: 'interaction', field: 'uncertaintyNotes' },
            role: 'user_assessment',
          },
        ],
      },
      deferredReceipt: { receiptId: deferredReceipt.receiptId, claimId: 'daily-claim-1' },
      clientRequestId: deferredReceipt.receiptId,
    };

    afterStage = async () => {
      await receiptStore.withdraw('owner-1', deferredReceipt.receiptId, Date.now());
    };
    const racedRequestId = 'deferred-withdraw-race';
    const racedResponse = await proposeFromOrigin({ ...body, clientRequestId: racedRequestId }, origin);
    assert.equal(racedResponse.statusCode, 409, racedResponse.body);
    assert.deepEqual(JSON.parse(racedResponse.body), { error: 'deferred_receipt_transition_conflict' });
    const racedCandidateId = `person_candidate_${createHash('sha256')
      .update(['owner-1', 'codex-sol', racedRequestId].join('\0'))
      .digest('hex')
      .slice(0, 24)}`;
    const racedCandidate = await store.getCandidateForOwner('owner-1', racedCandidateId);
    assert.equal(racedCandidate.state, 'staged');
    assert.equal(racedCandidate.publication.state, 'staged');
    assert.deepEqual(await store.listPending('owner-1'), []);
    afterStage = undefined;

    const readyReceiptId = `deferred_person_${'b'.repeat(32)}`;
    const readyReceipt = await receiptStore.stage({
      receiptId: readyReceiptId,
      ownerUserId: 'owner-1',
      requesterCatId: 'codex-sol',
      invocationId: 'invocation-deferred-ready',
      originMessageRef: { kind: 'message', threadId: 'thread_people', messageId: origin.id },
      subject: '黄挺',
      normalizedSubject: '黄挺',
      registryBinding,
      sourceCoordinates,
      sourceBundleDigest: 'a'.repeat(64),
      dedupeHash: personMemoryDeltaFingerprint(registryBinding, sourceCoordinates),
      ready: true,
      createdAt: Date.now(),
    });
    assert.equal(readyReceipt.outcome, 'created');
    const readyClaim = await receiptStore.claim({
      ownerUserId: 'owner-1',
      receiptId: readyReceiptId,
      claimId: 'daily-claim-ready',
      now: Date.now(),
      leaseMs: 60_000,
    });
    assert.equal(readyClaim.outcome, 'claimed');
    deferredReceipt = readyClaim.receipt;
    const readyBody = {
      ...body,
      deferredReceipt: { receiptId: readyReceiptId, claimId: 'daily-claim-ready' },
      clientRequestId: readyReceiptId,
    };
    const extraSource = await proposeFromOrigin(
      {
        ...readyBody,
        sourceBundle: {
          ...readyBody.sourceBundle,
          sources: [
            ...readyBody.sourceBundle.sources,
            {
              sourceId: 'unrelated-message',
              kind: 'message_text',
              messageId: unrelated.id,
              excerpt: unrelated.content,
            },
          ],
        },
      },
      origin,
    );
    assert.equal(extraSource.statusCode, 409);
    assert.equal(JSON.parse(extraSource.body).error, 'deferred_receipt_source_conflict');

    const response = await proposeFromOrigin(readyBody, origin);

    assert.equal(response.statusCode, 200, response.body);
    const result = JSON.parse(response.body);
    const candidate = await store.getCandidateForOwner('owner-1', result.candidateId);
    assert.equal(candidate.deferredReceiptId, deferredReceipt.receiptId);
    const proposedReceipt = await receiptStore.get('owner-1', deferredReceipt.receiptId);
    assert.equal(proposedReceipt.state, 'proposed');
    assert.equal(proposedReceipt.proposalId, result.candidateId);

    const badClaim = await proposeFromOrigin(
      { ...readyBody, deferredReceipt: { receiptId: deferredReceipt.receiptId, claimId: 'wrong-claim' } },
      origin,
    );
    assert.equal(badClaim.statusCode, 409);
  });

  it('renews a reclaimed deferred receipt after its first approval card outlives claim expiry', async () => {
    const history = await messageStore.append({
      userId: 'owner-1',
      catId: null,
      content: '黄挺和我聊了三小时团队管理',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread_history',
    });
    const origin = await messageStore.append({
      userId: 'owner-1',
      catId: null,
      content: 'daily deferred memory clerk',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread_people',
    });
    const sourceCoordinates = [
      {
        kind: 'message',
        sourceRef: { kind: 'message', threadId: history.threadId, messageId: history.id },
        resolvedDigest: digestSourceMaterial(history.content),
      },
    ];
    const registryBinding = { kind: 'registered_entity', ref: 'person:huang-ting-huawei' };
    const receiptId = `deferred_person_${'9'.repeat(32)}`;
    const staged = await receiptStore.stage({
      receiptId,
      ownerUserId: 'owner-1',
      requesterCatId: 'codex-sol',
      invocationId: 'invocation-deferred-retry',
      originMessageRef: { kind: 'message', threadId: origin.threadId, messageId: origin.id },
      subject: '黄挺',
      normalizedSubject: '黄挺',
      registryBinding,
      sourceCoordinates,
      sourceBundleDigest: '9'.repeat(64),
      dedupeHash: personMemoryDeltaFingerprint(registryBinding, sourceCoordinates),
      ready: true,
      createdAt: Date.now() - 1_000,
    });
    assert.equal(staged.outcome, 'created');
    const claimA = await receiptStore.claim({
      ownerUserId: 'owner-1',
      receiptId,
      claimId: 'daily-claim-a',
      now: Date.now(),
      leaseMs: 60_000,
    });
    assert.equal(claimA.outcome, 'claimed');

    const body = {
      ...proposalBody,
      claims: [],
      interaction: {
        payload: {
          duration: { kind: 'approximate', raw: '约三小时', qualifier: 'about' },
          eventKind: 'meeting',
          headline: '黄挺与 You 交流团队管理',
          importanceOrTopic: '团队管理',
          uncertaintyNotes: ['具体发生时间未说明'],
        },
        normalizedDraft: '黄挺与 You 进行了约三小时的团队管理交流',
        sourceRole: 'owner_explicit',
        evidenceExcerpt: history.content,
        sources: [
          {
            messageId: history.id,
            evidenceExcerpt: history.content,
            supports: ['eventKind', 'headline', 'duration', 'importanceOrTopic', 'uncertaintyNotes'],
          },
        ],
      },
      sourceBundle: {
        sources: [
          {
            sourceId: 'history-message',
            kind: 'message_text',
            messageId: history.id,
            excerpt: history.content,
          },
        ],
        assertionBindings: [
          { sourceId: 'history-message', target: { kind: 'interaction', field: 'eventKind' }, role: 'reported_fact' },
          { sourceId: 'history-message', target: { kind: 'interaction', field: 'headline' }, role: 'reported_fact' },
          { sourceId: 'history-message', target: { kind: 'interaction', field: 'duration' }, role: 'reported_fact' },
          {
            sourceId: 'history-message',
            target: { kind: 'interaction', field: 'importanceOrTopic' },
            role: 'user_assessment',
          },
          {
            sourceId: 'history-message',
            target: { kind: 'interaction', field: 'uncertaintyNotes' },
            role: 'user_assessment',
          },
        ],
      },
      deferredReceipt: { receiptId, claimId: 'daily-claim-a' },
      clientRequestId: receiptId,
    };

    let expiredAfterCard = false;
    beforeCommitEnvelope = async () => {
      if (expiredAfterCard) return;
      expiredAfterCard = true;
      const receiptKey = receiptStore.keys.receipt('owner-1', receiptId);
      const current = JSON.parse(await redis.get(receiptKey));
      await redis.set(receiptKey, JSON.stringify({ ...current, claimUntil: Date.now() - 1 }));
    };
    const first = await proposeFromOrigin(body, origin);
    assert.equal(first.statusCode, 409, first.body);
    assert.deepEqual(JSON.parse(first.body), { error: 'deferred_receipt_transition_conflict' });
    const candidateId = `person_candidate_${createHash('sha256')
      .update(['owner-1', 'codex-sol', receiptId].join('\0'))
      .digest('hex')
      .slice(0, 24)}`;
    const stagedCandidate = await store.getCandidateForOwner('owner-1', candidateId);
    assert.equal(stagedCandidate.state, 'staged');
    assert.equal(stagedCandidate.deferredReceiptClaimId, 'daily-claim-a');
    const cardsAfterFirstAttempt = (await messageStore.getByThread('thread_people', 50, 'owner-1'))
      .flatMap((message) => message.extra?.rich?.blocks ?? [])
      .filter((block) => block.meta?.kind === 'person_memory_proposal' && block.meta.candidateId === candidateId);
    assert.equal(cardsAfterFirstAttempt.length, 1);

    beforeCommitEnvelope = undefined;
    const claimB = await receiptStore.claim({
      ownerUserId: 'owner-1',
      receiptId,
      claimId: 'daily-claim-b',
      now: Date.now(),
      leaseMs: 60_000,
    });
    assert.equal(claimB.outcome, 'claimed');
    const retried = await proposeFromOrigin(
      { ...body, deferredReceipt: { receiptId, claimId: 'daily-claim-b' } },
      origin,
    );
    assert.equal(retried.statusCode, 200, retried.body);

    const result = JSON.parse(retried.body);
    assert.equal(result.candidateId, candidateId);
    assert.equal(stageCalls, 1);
    const candidate = await store.getCandidateForOwner('owner-1', result.candidateId);
    assert.equal(candidate.state, 'pending_approval');
    assert.equal(candidate.publication.state, 'anchored');
    assert.equal(candidate.deferredReceiptClaimId, undefined);
    const terminalReceipt = await receiptStore.get('owner-1', receiptId);
    assert.equal(terminalReceipt.state, 'proposed');
    assert.equal(terminalReceipt.proposalId, result.candidateId);
    const cards = (await messageStore.getByThread('thread_people', 50, 'owner-1'))
      .flatMap((message) => message.extra?.rich?.blocks ?? [])
      .filter(
        (block) => block.meta?.kind === 'person_memory_proposal' && block.meta.candidateId === result.candidateId,
      );
    assert.equal(cards.length, 1);
  });

  it('rejects duplicate resolved coordinates in a direct proposal before any candidate or card write', async () => {
    const originContent = '黄挺是终端用户计算开发部 21 级';
    const clientRequestId = 'direct-duplicate-coordinate';
    const origin = await messageStore.append({
      userId: 'owner-1',
      catId: null,
      content: originContent,
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread_people',
    });
    const response = await proposeFromOrigin(
      {
        ...proposalBody,
        clientRequestId,
        sourceBundle: {
          sources: [
            {
              sourceId: 'same-coordinate-a',
              kind: 'message_text',
              messageId: origin.id,
              excerpt: originContent,
            },
            {
              sourceId: 'same-coordinate-b',
              kind: 'message_text',
              messageId: origin.id,
              excerpt: originContent,
            },
          ],
          assertionBindings: [
            { sourceId: 'same-coordinate-a', target: { kind: 'claim', index: 0 }, role: 'reported_fact' },
            { sourceId: 'same-coordinate-b', target: { kind: 'claim', index: 0 }, role: 'reported_fact' },
          ],
        },
      },
      origin,
    );

    assert.equal(response.statusCode, 422, response.body);
    assert.deepEqual(JSON.parse(response.body), { error: 'duplicate_source_coordinate' });
    assert.equal(stageCalls, 0);
    const candidateId = `person_candidate_${createHash('sha256')
      .update(['owner-1', 'codex-sol', clientRequestId].join('\0'))
      .digest('hex')
      .slice(0, 24)}`;
    assert.equal(await store.getCandidateForOwner('owner-1', candidateId), null);
    const cards = (await messageStore.getByThread('thread_people', 50, 'owner-1'))
      .flatMap((message) => message.extra?.rich?.blocks ?? [])
      .filter((block) => block.meta?.kind === 'person_memory_proposal' && block.meta.candidateId === candidateId);
    assert.deepEqual(cards, []);
  });

  it('rejects duplicate message coordinates even when an owner-private artifact makes the bundle fingerprint-unsupported', async () => {
    const originContent = '黄挺是终端用户计算开发部 21 级';
    const locator = 'workspace:people/huang-ting.md#organization';
    const artifactDigest = digestSourceMaterial(originContent);
    const clientRequestId = 'direct-mixed-duplicate-coordinate';
    artifactResolutions.set(`owner-1:${locator}`, {
      digest: artifactDigest,
      boundedText: originContent,
    });
    const evidence = await messageStore.append({
      userId: 'owner-1',
      catId: null,
      content: originContent,
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread_people',
    });
    const confirmation = await messageStore.append({
      userId: 'owner-1',
      catId: null,
      content: '对，这份记录内容准确。',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread_people',
    });

    const response = await proposeFromOrigin(
      {
        ...proposalBody,
        clientRequestId,
        sourceBundle: {
          sources: [
            {
              sourceId: 'mixed-private-artifact',
              kind: 'owner_private_artifact',
              artifactLocator: locator,
              expectedDigest: artifactDigest,
              boundedExcerpt: originContent,
              confirmationMessageId: confirmation.id,
            },
            {
              sourceId: 'mixed-same-coordinate-a',
              kind: 'message_text',
              messageId: evidence.id,
              excerpt: originContent,
            },
            {
              sourceId: 'mixed-same-coordinate-b',
              kind: 'message_text',
              messageId: evidence.id,
              excerpt: originContent,
            },
          ],
          assertionBindings: [
            {
              sourceId: 'mixed-private-artifact',
              target: { kind: 'claim', index: 0 },
              role: 'reported_fact',
            },
            {
              sourceId: 'mixed-same-coordinate-a',
              target: { kind: 'claim', index: 0 },
              role: 'reported_fact',
            },
            {
              sourceId: 'mixed-same-coordinate-b',
              target: { kind: 'claim', index: 0 },
              role: 'reported_fact',
            },
          ],
        },
      },
      confirmation,
    );

    assert.equal(response.statusCode, 422, response.body);
    assert.deepEqual(JSON.parse(response.body), { error: 'duplicate_source_coordinate' });
    assert.equal(stageCalls, 0);
    const candidateId = `person_candidate_${createHash('sha256')
      .update(['owner-1', 'codex-sol', clientRequestId].join('\0'))
      .digest('hex')
      .slice(0, 24)}`;
    assert.equal(await store.getCandidateForOwner('owner-1', candidateId), null);
    const cards = (await messageStore.getByThread('thread_people', 50, 'owner-1'))
      .flatMap((message) => message.extra?.rich?.blocks ?? [])
      .filter((block) => block.meta?.kind === 'person_memory_proposal' && block.meta.candidateId === candidateId);
    assert.deepEqual(cards, []);
  });

  it('detects duplicate attachment coordinates throughout a fingerprint-unsupported mixed bundle', () => {
    const digest = 'a'.repeat(64);
    const sourceRef = { threadId: 'thread_people', messageId: 'message-with-attachment' };
    const attachmentLocator = { surface: 'content_block', index: 0 };
    const coordinates = proposalPersonMemoryDeltaCoordinates({
      sources: [
        {
          sourceId: 'mixed-artifact',
          kind: 'owner_private_artifact',
          artifactLocator: 'workspace:people/huang-ting.md#organization',
          confirmationSourceRef: { threadId: 'thread_people', messageId: 'artifact-confirmation' },
          ownerUserId: 'owner-1',
          resolvedDigest: digest,
          boundedExcerpt: '黄挺属于终端用户计算开发部',
        },
        {
          sourceId: 'mixed-attachment-a',
          kind: 'message_attachment',
          sourceRef,
          ownerUserId: 'owner-1',
          attachmentLocator,
          resolvedDigest: digest,
          boundedTranscript: '黄挺属于终端用户计算开发部',
        },
        {
          sourceId: 'mixed-attachment-b',
          kind: 'message_attachment',
          sourceRef,
          ownerUserId: 'owner-1',
          attachmentLocator,
          resolvedDigest: digest,
          boundedTranscript: '黄挺属于终端用户计算开发部',
        },
      ],
      assertionBindings: [],
    });

    assert.deepEqual(coordinates, { status: 'duplicate' });
  });

  it('blocks an over-budget rendered card before staging with an actionable preflight', async () => {
    const oversizedDraft = `黄挺的职责是${'终端用户计算与主动记忆生产链路'.repeat(28)}`;
    const { response } = await propose({
      ...proposalBody,
      claims: [
        {
          ...proposalBody.claims[0],
          normalizedDraft: oversizedDraft,
        },
      ],
      clientRequestId: 'card-budget-preflight',
    });

    assert.equal(response.statusCode, 422, response.body);
    const payload = JSON.parse(response.body);
    assert.equal(payload.error, 'person_memory_preflight_failed');
    assert.equal(payload.preflight.status, 'blocked');
    assert.equal(payload.preflight.phase, 'card_budget');
    assert.equal(payload.preflight.issues[0].code, 'card_token_budget_exceeded');
    assert.equal(payload.preflight.budget.kind, 'candidate_card');
    assert.equal(payload.preflight.budget.maxTokens, 240);
    assert.equal(typeof payload.preflight.budget.estimatedTokens, 'number');
    assert.equal(JSON.stringify(payload).includes(oversizedDraft), false);
    assert.equal(stageCalls, 0);
  });

  it('maps known evidence-excerpt limits to actionable preflight without echoing source text', async () => {
    const privateExcerpt = '仅供本人确认的私密证据'.repeat(12);
    const { response } = await propose(
      {
        ...proposalBody,
        claims: [
          {
            ...proposalBody.claims[0],
            evidenceExcerpt: privateExcerpt,
          },
        ],
        clientRequestId: 'excerpt-budget-preflight',
      },
      privateExcerpt,
    );

    assert.equal(response.statusCode, 422, response.body);
    const payload = JSON.parse(response.body);
    assert.equal(payload.error, 'person_memory_preflight_failed');
    assert.equal(payload.preflight.phase, 'informed_approval');
    assert.equal(payload.preflight.issues[0].code, 'evidence_excerpt_budget_exceeded');
    assert.equal(payload.preflight.budget.kind, 'evidence_excerpt');
    assert.equal(payload.preflight.budget.maxTokens, 24);
    assert.equal(JSON.stringify(payload).includes(privateExcerpt), false);
    assert.equal(stageCalls, 0);
  });

  it('keeps the old proposal pending when a replacement card fails preflight', async () => {
    const original = await propose({ ...proposalBody, clientRequestId: 'replacement-preflight-original' });
    const originalId = JSON.parse(original.response.body).candidateId;
    const oversizedDraft = `黄挺的职责是${'终端用户计算与主动记忆生产链路'.repeat(28)}`;
    const corrected = await propose({
      ...proposalBody,
      claims: [{ ...proposalBody.claims[0], normalizedDraft: oversizedDraft }],
      replacesProposalId: originalId,
      clientRequestId: 'replacement-preflight-blocked',
    });

    assert.equal(corrected.response.statusCode, 422, corrected.response.body);
    assert.equal(stageCalls, 1);
    assert.equal((await store.getCandidateForOwner('owner-1', originalId)).state, 'pending_approval');
    assert.deepEqual(
      (await store.listPending('owner-1')).map((candidate) => candidate.candidateId),
      [originalId],
    );
  });

  it('accepts a digest-pinned owner attachment as typed claim evidence', async () => {
    const imageBlock = {
      type: 'image',
      url: '/uploads/zhou-yujing.png',
      alt: '截图显示周玉晶负责 proactive memory pipeline',
    };
    const origin = await messageStore.append({
      userId: 'owner-1',
      catId: null,
      content: '周玉晶的职责见附件截图。',
      contentBlocks: [imageBlock],
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread_people',
    });
    workspaceResolution = { status: 'not_found' };
    const response = await proposeFromOrigin(
      {
        person: { displayName: '周玉晶', privateAliases: ['周玉晶'] },
        claims: [
          {
            payload: {
              kind: 'reported_fact',
              predicate: 'project_role',
              value: '负责 proactive memory pipeline',
              assertedBy: 'owner',
            },
            normalizedDraft: '周玉晶负责 proactive memory pipeline',
            sourceRole: 'owner_explicit',
            evidenceExcerpt: imageBlock.alt,
          },
        ],
        sourceBundle: {
          sources: [
            {
              sourceId: 'zhou-screenshot',
              kind: 'message_attachment',
              messageId: origin.id,
              attachmentLocator: { surface: 'content_block', index: 0 },
              expectedDigest: digestSourceMaterial(imageBlock),
              boundedTranscript: imageBlock.alt,
            },
          ],
          assertionBindings: [
            {
              sourceId: 'zhou-screenshot',
              target: { kind: 'claim', index: 0 },
              role: 'reported_fact',
            },
          ],
        },
        clientRequestId: 'typed-attachment',
      },
      origin,
    );

    assert.equal(response.statusCode, 200, response.body);
    const candidate = await store.getCandidateForOwner('owner-1', JSON.parse(response.body).candidateId);
    assert.equal(candidate.sourceBundle.sources[0].kind, 'message_attachment');
    assert.equal(candidate.sourceBundle.sources[0].ownerUserId, 'owner-1');
    assert.equal(candidate.sourceBundle.sources[0].resolvedDigest, digestSourceMaterial(imageBlock));
    const messages = await messageStore.getByThread('thread_people', 20, 'owner-1');
    const card = messages
      .flatMap((message) => message.extra?.rich?.blocks ?? [])
      .find((block) => block.meta?.candidateId === candidate.candidateId);
    assert.match(card.bodyMarkdown, /message_attachment · reported_fact/);
  });

  it('accepts transcript-accuracy confirmation while preserving its epistemic role', async () => {
    const transcript = '周玉晶说她负责 proactive memory pipeline';
    const confirmation = await messageStore.append({
      userId: 'owner-1',
      catId: null,
      content: '对，这份转写准确。',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread_people',
    });
    workspaceResolution = { status: 'not_found' };
    const response = await proposeFromOrigin(
      {
        person: { displayName: '周玉晶', privateAliases: ['周玉晶'] },
        claims: [
          {
            payload: {
              kind: 'reported_fact',
              predicate: 'quoted_project_role',
              value: transcript,
              assertedBy: 'owner',
            },
            normalizedDraft: transcript,
            sourceRole: 'quoted_third_party',
            evidenceExcerpt: transcript,
          },
        ],
        sourceBundle: {
          sources: [
            {
              sourceId: 'confirmed-transcript',
              kind: 'owner_confirmed_transcript',
              transcript,
              transcriptDigest: digestSourceMaterial(transcript),
              confirmationMessageId: confirmation.id,
              confirmationScope: 'transcript_accuracy',
            },
          ],
          assertionBindings: [
            {
              sourceId: 'confirmed-transcript',
              target: { kind: 'claim', index: 0 },
              role: 'quoted_third_party',
            },
          ],
        },
        clientRequestId: 'typed-confirmed-transcript',
      },
      confirmation,
    );

    assert.equal(response.statusCode, 200, response.body);
    const candidate = await store.getCandidateForOwner('owner-1', JSON.parse(response.body).candidateId);
    assert.equal(candidate.sourceBundle.sources[0].confirmationScope, 'transcript_accuracy');
    assert.equal(candidate.sourceBundle.assertionBindings[0].role, 'quoted_third_party');
    const messages = await messageStore.getByThread('thread_people', 20, 'owner-1');
    const card = messages
      .flatMap((message) => message.extra?.rich?.blocks ?? [])
      .find((block) => block.meta?.candidateId === candidate.candidateId);
    assert.match(card.bodyMarkdown, /owner_confirmed_transcript · quoted_third_party · transcript_accuracy/);
  });

  it('shows one bounded typed source with the interaction fields and roles it supports', async () => {
    const sourceText = '我和周玉晶开会，这事很重要';
    const origin = await messageStore.append({
      userId: 'owner-1',
      catId: null,
      content: sourceText,
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread_people',
    });
    workspaceResolution = { status: 'not_found' };
    const response = await proposeFromOrigin(
      {
        person: { displayName: '周玉晶', privateAliases: ['周玉晶'] },
        claims: [],
        interaction: {
          payload: {
            eventKind: 'meeting',
            headline: '与周玉晶开会',
            importanceOrTopic: '这次会很重要',
            uncertaintyNotes: [],
          },
          normalizedDraft: '与周玉晶开会，这次会很重要',
          sourceRole: 'owner_explicit',
          evidenceExcerpt: sourceText,
        },
        sourceBundle: {
          sources: [
            {
              sourceId: 'meeting-source',
              kind: 'message_text',
              messageId: origin.id,
              excerpt: sourceText,
            },
          ],
          assertionBindings: [
            {
              sourceId: 'meeting-source',
              target: { kind: 'interaction', field: 'eventKind' },
              role: 'reported_fact',
            },
            {
              sourceId: 'meeting-source',
              target: { kind: 'interaction', field: 'headline' },
              role: 'reported_fact',
            },
            {
              sourceId: 'meeting-source',
              target: { kind: 'interaction', field: 'importanceOrTopic' },
              role: 'user_assessment',
            },
          ],
        },
        clientRequestId: 'typed-interaction-informed-card',
      },
      origin,
    );

    assert.equal(response.statusCode, 200, response.body);
    const candidateId = JSON.parse(response.body).candidateId;
    const messages = await messageStore.getByThread('thread_people', 20, 'owner-1');
    const card = messages
      .flatMap((message) => message.extra?.rich?.blocks ?? [])
      .find((block) => block.meta?.candidateId === candidateId);
    assert.match(card.bodyMarkdown, /证据 1.*事件类型、发生了什么、主题\/重要性/);
    assert.match(card.bodyMarkdown, /message_text/);
    assert.match(card.bodyMarkdown, /reported_fact/);
    assert.match(card.bodyMarkdown, /user_assessment/);
    assert.equal(card.bodyMarkdown.match(new RegExp(sourceText, 'g'))?.length, 1);
  });

  it('resolves an allowlisted owner-private artifact without accepting caller file paths', async () => {
    const locator = 'workspace:people/zhou-yujing.md#role';
    const boundedText = '周玉晶负责 proactive memory pipeline';
    const digest = digestSourceMaterial(boundedText);
    artifactResolutions.set(`owner-1:${locator}`, { digest, boundedText });
    const confirmation = await messageStore.append({
      userId: 'owner-1',
      catId: null,
      content: '对，这份记录内容准确。',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread_people',
    });
    workspaceResolution = { status: 'not_found' };
    const response = await proposeFromOrigin(
      {
        person: { displayName: '周玉晶', privateAliases: ['周玉晶'] },
        claims: [
          {
            payload: {
              kind: 'reported_fact',
              predicate: 'project_role',
              value: '负责 proactive memory pipeline',
              assertedBy: 'owner',
            },
            normalizedDraft: boundedText,
            sourceRole: 'owner_explicit',
            evidenceExcerpt: boundedText,
          },
        ],
        sourceBundle: {
          sources: [
            {
              sourceId: 'private-artifact',
              kind: 'owner_private_artifact',
              artifactLocator: locator,
              expectedDigest: digest,
              boundedExcerpt: boundedText,
              confirmationMessageId: confirmation.id,
            },
          ],
          assertionBindings: [
            {
              sourceId: 'private-artifact',
              target: { kind: 'claim', index: 0 },
              role: 'reported_fact',
            },
          ],
        },
        clientRequestId: 'typed-private-artifact',
      },
      confirmation,
    );
    assert.equal(response.statusCode, 200, response.body);
    const candidate = await store.getCandidateForOwner('owner-1', JSON.parse(response.body).candidateId);
    assert.equal(candidate.sourceBundle.sources[0].artifactLocator, locator);
    assert.equal(JSON.stringify(candidate).includes('/Users/'), false);
  });

  it('rejects transcript confirmation from another owner or without explicit accuracy confirmation', async () => {
    const transcript = '周玉晶说她负责 proactive memory pipeline';
    const origin = await messageStore.append({
      userId: 'owner-1',
      catId: null,
      content: '请处理这份转写。',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread_people',
    });
    const invalidConfirmations = [
      await messageStore.append({
        userId: 'owner-2',
        catId: null,
        content: '对，这份转写准确。',
        mentions: [],
        timestamp: Date.now(),
        threadId: 'thread_people',
      }),
      await messageStore.append({
        userId: 'owner-1',
        catId: null,
        content: '我先看看这份转写。',
        mentions: [],
        timestamp: Date.now(),
        threadId: 'thread_people',
      }),
    ];
    workspaceResolution = { status: 'not_found' };
    for (const [index, confirmation] of invalidConfirmations.entries()) {
      const response = await proposeFromOrigin(
        {
          person: { displayName: '周玉晶', privateAliases: ['周玉晶'] },
          claims: [
            {
              payload: {
                kind: 'reported_fact',
                predicate: 'quoted_project_role',
                value: transcript,
                assertedBy: 'owner',
              },
              normalizedDraft: transcript,
              sourceRole: 'quoted_third_party',
              evidenceExcerpt: transcript,
            },
          ],
          sourceBundle: {
            sources: [
              {
                sourceId: 'invalid-confirmation',
                kind: 'owner_confirmed_transcript',
                transcript,
                transcriptDigest: digestSourceMaterial(transcript),
                confirmationMessageId: confirmation.id,
                confirmationScope: 'transcript_accuracy',
              },
            ],
            assertionBindings: [
              {
                sourceId: 'invalid-confirmation',
                target: { kind: 'claim', index: 0 },
                role: 'quoted_third_party',
              },
            ],
          },
          clientRequestId: `invalid-transcript-confirmation-${index}`,
        },
        origin,
      );
      assert.equal(response.statusCode, 400);
      assert.equal(JSON.parse(response.body).error, 'invalid_transcript_confirmation');
    }
    assert.equal(stageCalls, 0);
  });

  it('rejects inference before staging and returns an owner-confirmation draft', async () => {
    const { response } = await propose({
      ...proposalBody,
      sourceBundle: {
        sources: [
          {
            sourceId: 'inference-source',
            kind: 'message_text',
            messageId: 'replaced-by-origin-below',
            excerpt: proposalBody.claims[0].evidenceExcerpt,
          },
        ],
        assertionBindings: [
          {
            sourceId: 'inference-source',
            target: { kind: 'claim', index: 0 },
            role: 'agent_inference',
          },
        ],
      },
      clientRequestId: 'inference-zero-write',
    });
    assert.equal(response.statusCode, 400);
    const payload = JSON.parse(response.body);
    assert.equal(payload.error, 'owner_confirmation_required');
    assert.equal(payload.draft, '我目前只能推断……如果你确认，请直接陈述要记录的事实。');
    assert.equal(payload.preflight.status, 'blocked');
    assert.equal(payload.preflight.phase, 'materializability');
    assert.equal(payload.preflight.issues[0].code, 'owner_confirmation_required');
    assert.equal(stageCalls, 0);
  });

  it('replaces an owner pending proposal only after the corrected card is anchored', async () => {
    const first = await propose({ ...proposalBody, clientRequestId: 'replace-original' });
    assert.equal(first.response.statusCode, 200);
    const originalId = JSON.parse(first.response.body).candidateId;

    const corrected = await propose(
      {
        ...proposalBody,
        claims: [
          {
            ...proposalBody.claims[0],
            normalizedDraft: '黄挺属于终端用户计算开发部（已纠正）',
          },
        ],
        replacesProposalId: originalId,
        clientRequestId: 'replace-corrected',
      },
      '黄挺是终端用户计算开发部 21 级，刚才那张卡请改成纠正版。',
    );
    assert.equal(corrected.response.statusCode, 200, corrected.response.body);
    const correctedId = JSON.parse(corrected.response.body).candidateId;

    const original = await store.getCandidateForOwner('owner-1', originalId);
    const replacement = await store.getCandidateForOwner('owner-1', correctedId);
    assert.equal(original.state, 'withdrawn');
    assert.equal(original.replacedByProposalId, correctedId);
    assert.equal(replacement.state, 'pending_approval');
    assert.equal(replacement.replacesProposalId, originalId);
    assert.deepEqual(
      socketEvents.find((entry) => entry.event === 'proposal_updated' && entry.payload.proposalId === originalId),
      {
        userId: 'owner-1',
        event: 'proposal_updated',
        payload: {
          proposalId: originalId,
          sourceFeatureId: 'F276',
          status: 'withdrawn',
          replacedByProposalId: correctedId,
        },
      },
    );
  });

  it('replaces the Agent Refractor typo with one complete AgentReflex snapshot and no correction event', async () => {
    workspaceResolution = { status: 'not_found' };
    const proposeAldenSnapshot = async (projectName, clientRequestId, replacesProposalId) => {
      const content = `Alden 负责 ${projectName}；我们聊过主动记忆，这次讨论很重要。`;
      const origin = await messageStore.append({
        userId: 'owner-1',
        catId: null,
        content,
        mentions: [],
        timestamp: Date.now(),
        threadId: 'thread_people',
      });
      const sourceBundle = {
        sources: [
          {
            sourceId: 'alden-owner-message',
            kind: 'message_text',
            messageId: origin.id,
            excerpt: content,
          },
        ],
        assertionBindings: [
          { sourceId: 'alden-owner-message', target: { kind: 'claim', index: 0 }, role: 'reported_fact' },
          {
            sourceId: 'alden-owner-message',
            target: { kind: 'interaction', field: 'eventKind' },
            role: 'reported_fact',
          },
          {
            sourceId: 'alden-owner-message',
            target: { kind: 'interaction', field: 'headline' },
            role: 'reported_fact',
          },
          {
            sourceId: 'alden-owner-message',
            target: { kind: 'interaction', field: 'importanceOrTopic' },
            role: 'user_assessment',
          },
        ],
      };
      return proposeFromOrigin(
        {
          person: { displayName: 'Alden', privateAliases: ['Alden'] },
          claims: [
            {
              payload: {
                kind: 'reported_fact',
                predicate: 'project_role',
                value: projectName,
                assertedBy: 'owner',
              },
              normalizedDraft: `Alden 负责 ${projectName}`,
              sourceRole: 'owner_explicit',
              evidenceExcerpt: `负责 ${projectName}`,
            },
          ],
          interaction: {
            payload: {
              eventKind: 'conversation',
              headline: '与 Alden 讨论主动记忆',
              importanceOrTopic: '这次讨论很重要',
              uncertaintyNotes: [],
            },
            normalizedDraft: '与 Alden 讨论主动记忆',
            sourceRole: 'owner_explicit',
            evidenceExcerpt: '我们聊过主动记忆',
          },
          sourceBundle,
          ...(replacesProposalId ? { replacesProposalId } : {}),
          clientRequestId,
        },
        origin,
      );
    };

    const originalResponse = await proposeAldenSnapshot('Agent Refractor', 'alden-refractor', undefined);
    assert.equal(originalResponse.statusCode, 200, originalResponse.body);
    const originalId = JSON.parse(originalResponse.body).candidateId;
    const originalBefore = await store.getCandidateForOwner('owner-1', originalId);

    const correctedResponse = await proposeAldenSnapshot('AgentReflex', 'alden-reflex', originalId);
    assert.equal(correctedResponse.statusCode, 200, correctedResponse.body);
    const correctedId = JSON.parse(correctedResponse.body).candidateId;
    const originalAfter = await store.getCandidateForOwner('owner-1', originalId);
    const corrected = await store.getCandidateForOwner('owner-1', correctedId);

    assert.equal(originalBefore.claimDrafts.length, 1);
    assert.equal(originalBefore.interactionDraft.payload.headline, '与 Alden 讨论主动记忆');
    assert.equal(originalAfter.state, 'withdrawn');
    assert.equal(originalAfter.replacedByProposalId, correctedId);
    assert.equal(corrected.state, 'pending_approval');
    assert.equal(corrected.claimDrafts[0].normalizedDraft, 'Alden 负责 AgentReflex');
    assert.deepEqual(corrected.interactionDraft.payload, originalBefore.interactionDraft.payload);
    assert.equal(corrected.remainingDraftIds.length, 2);
    assert.equal(JSON.stringify(corrected.interactionDraft).includes('纠错'), false);
    assert.equal(await store.resolveDormantCandidateBySubject('owner-1', 'Alden'), null);

    const messages = await messageStore.getByThread('thread_people', 30, 'owner-1');
    const correctedCard = messages
      .flatMap((message) => message.extra?.rich?.blocks ?? [])
      .find((block) => block.meta?.candidateId === correctedId);
    assert.match(correctedCard.bodyMarkdown, /Alden 负责 AgentReflex/);
    assert.match(correctedCard.bodyMarkdown, /与 Alden 讨论主动记忆/);
    assert.equal(correctedCard.bodyMarkdown.includes('Agent Refractor'), false);
  });

  it('fails closed when one idempotency key changes its replacement target', async () => {
    const target = await propose({ ...proposalBody, clientRequestId: 'replacement-target' });
    const targetId = JSON.parse(target.response.body).candidateId;
    const sharedOrigin = await messageStore.append({
      userId: 'owner-1',
      catId: null,
      content: '黄挺是终端用户计算开发部 21 级',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread_people',
    });
    const prior = await proposeFromOrigin({ ...proposalBody, clientRequestId: 'stable-intent' }, sharedOrigin);
    const priorId = JSON.parse(prior.body).candidateId;

    const conflictingRetry = await proposeFromOrigin(
      {
        ...proposalBody,
        replacesProposalId: targetId,
        clientRequestId: 'stable-intent',
      },
      sharedOrigin,
    );

    assert.equal(conflictingRetry.statusCode, 409);
    assert.deepEqual(JSON.parse(conflictingRetry.body), { error: 'replacement_conflict' });
    assert.equal(stageCalls, 2);
    assert.equal((await store.getCandidateForOwner('owner-1', priorId)).state, 'pending_approval');
    assert.equal((await store.getCandidateForOwner('owner-1', targetId)).state, 'pending_approval');
  });

  it('fails closed before staging when a replacement names a different person', async () => {
    const first = await propose({ ...proposalBody, clientRequestId: 'replace-identity-original' });
    const originalId = JSON.parse(first.response.body).candidateId;
    workspaceResolution = {
      status: 'resolved',
      entityRef: 'person:guo-liang',
      canonicalName: '郭良',
    };

    const conflicting = await propose(
      {
        ...proposalBody,
        person: { displayName: '郭良', privateAliases: ['郭良'] },
        replacesProposalId: originalId,
        clientRequestId: 'replace-identity-conflict',
      },
      '黄挺是终端用户计算开发部 21 级；郭良的信息不能替换黄挺的卡。',
    );

    assert.equal(conflicting.response.statusCode, 409);
    assert.deepEqual(JSON.parse(conflicting.response.body), { error: 'identity_conflict' });
    assert.equal(stageCalls, 1);
    assert.equal((await store.getCandidateForOwner('owner-1', originalId)).state, 'pending_approval');
  });

  it('does not replace a proposal after it has reached a terminal decision', async () => {
    const first = await propose({ ...proposalBody, clientRequestId: 'replace-terminal-original' });
    const originalId = JSON.parse(first.response.body).candidateId;
    await store.rejectCandidate({
      ownerUserId: 'owner-1',
      candidateId: originalId,
      decisionId: 'decision_replace_terminal_original',
      decidedAt: Date.now(),
    });

    const corrected = await propose(
      {
        ...proposalBody,
        replacesProposalId: originalId,
        clientRequestId: 'replace-terminal-corrected',
      },
      '黄挺是终端用户计算开发部 21 级，这条信息要改成纠正版。',
    );

    assert.equal(corrected.response.statusCode, 409);
    assert.deepEqual(JSON.parse(corrected.response.body), { error: 'proposal_not_replaceable' });
    assert.equal(stageCalls, 1);
  });

  it('binds an event to ordered historical owner evidence instead of the anaphoric origin', async () => {
    const firstSource = await messageStore.append({
      userId: 'owner-1',
      catId: null,
      content: '7 月 23 日周三，我和黄挺线下见了大约两个小时。',
      mentions: [],
      timestamp: Date.now() - 2,
      threadId: 'thread_history',
    });
    const secondSource = await messageStore.append({
      userId: 'owner-1',
      catId: null,
      content: '我们聊了终端用户计算，这次见面对我挺重要，但日期和星期冲突。',
      mentions: [],
      timestamp: Date.now() - 1,
      threadId: 'thread_history',
    });
    const { response, origin } = await propose(
      {
        person: proposalBody.person,
        claims: [],
        interaction: {
          payload: {
            occurredAt: {
              kind: 'conflict',
              raw: '7 月 23 日（周三）',
              alternatives: [
                { label: 'explicit_date', value: '2026-07-23' },
                { label: 'weekday_resolution', value: '2026-07-22' },
              ],
            },
            duration: {
              kind: 'approximate',
              raw: '大约两个小时',
              qualifier: 'about',
            },
            eventKind: 'meeting',
            headline: '与黄挺线下见面并讨论终端用户计算',
            importanceOrTopic: '交流终端用户计算方向，也让双方关系更具体',
            uncertaintyNotes: ['日期与星期存在冲突'],
          },
          normalizedDraft: '与黄挺线下见面约两小时，讨论终端用户计算；日期待确认',
          sourceRole: 'owner_explicit',
          evidenceExcerpt: '线下见了大约两个小时',
          sources: [
            {
              messageId: firstSource.id,
              evidenceExcerpt: '线下见了大约两个小时',
              supports: ['eventKind', 'headline', 'occurredAt', 'duration'],
            },
            {
              messageId: secondSource.id,
              evidenceExcerpt: '聊了终端用户计算，这次见面对我挺重要，但日期和星期冲突',
              supports: ['importanceOrTopic', 'uncertaintyNotes'],
            },
          ],
        },
        clientRequestId: 'event-history-sources',
      },
      '再提一下那个黄挺事件卡。',
    );

    assert.equal(response.statusCode, 200);
    const candidate = await store.getCandidateForOwner('owner-1', JSON.parse(response.body).candidateId);
    assert.equal(candidate.sourceMessageRef.messageId, origin.id);
    assert.deepEqual(
      candidate.interactionDraft.sourceEvidence.map((source) => source.sourceRef),
      [
        { kind: 'message', threadId: 'thread_history', messageId: firstSource.id },
        { kind: 'message', threadId: 'thread_history', messageId: secondSource.id },
      ],
    );
    assert.equal(
      candidate.interactionDraft.sourceEvidence.some((source) => source.sourceRef.messageId === origin.id),
      false,
    );
    const messages = await messageStore.getByThread('thread_people', 20, 'owner-1');
    const card = messages
      .flatMap((message) => message.extra?.rich?.blocks ?? [])
      .find((block) => block.meta?.candidateId === candidate.candidateId);
    assert.match(card.bodyMarkdown, /人物：黄挺/);
    assert.match(card.bodyMarkdown, /发生了什么：与黄挺线下见面并讨论终端用户计算/);
    assert.match(card.bodyMarkdown, /时间：7 月 23 日（周三）/);
    assert.match(card.bodyMarkdown, /时长：大约两个小时/);
    assert.match(card.bodyMarkdown, /主题\/重要性：交流终端用户计算方向，也让双方关系更具体/);
    assert.match(card.bodyMarkdown, /仍不确定：日期与星期存在冲突/);
    assert.match(card.bodyMarkdown, /证据 1.*线下见了大约两个小时/);
    assert.match(card.bodyMarkdown, /证据 2.*聊了终端用户计算/);
  });

  it('blocks relayed-quote laundering into interaction fact fields', async () => {
    const origin = await messageStore.append({
      userId: 'owner-1',
      catId: null,
      content: '张三告诉我他昨天去了北京。',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread_people',
    });
    workspaceResolution = { status: 'not_found' };
    const response = await proposeFromOrigin(
      {
        person: { displayName: '张三', privateAliases: ['张三'] },
        claims: [],
        interaction: {
          payload: {
            eventKind: 'other',
            headline: '张三去了北京',
            importanceOrTopic: '出行',
            uncertaintyNotes: [],
          },
          normalizedDraft: '张三昨天去了北京',
          sourceRole: 'owner_explicit',
          evidenceExcerpt: '张三告诉我他昨天去了北京',
        },
        sourceBundle: {
          sources: [
            {
              sourceId: 'relayed-quote',
              kind: 'message_text',
              messageId: origin.id,
              excerpt: '他昨天去了北京',
            },
          ],
          assertionBindings: [
            {
              sourceId: 'relayed-quote',
              target: { kind: 'interaction', field: 'eventKind' },
              role: 'reported_fact',
            },
            {
              sourceId: 'relayed-quote',
              target: { kind: 'interaction', field: 'headline' },
              role: 'reported_fact',
            },
            {
              sourceId: 'relayed-quote',
              target: { kind: 'interaction', field: 'importanceOrTopic' },
              role: 'user_assessment',
            },
          ],
        },
        clientRequestId: 'relayed-quote-laundering',
      },
      origin,
    );

    assert.equal(response.statusCode, 400);
    const payload = JSON.parse(response.body);
    assert.equal(payload.error, 'invalid_assertion_binding');
    assert.equal(payload.preflight.phase, 'materializability');
    assert.equal(payload.preflight.issues[0].code, 'assertion_not_materializable');
    assert.equal(JSON.stringify(payload).includes(origin.id), false);
    assert.equal(stageCalls, 0);
  });

  it('blocks common Chinese hearsay variants from laundering into interaction facts', async () => {
    const relayedStatements = [
      '听说张三昨天去了北京。',
      '据说张三昨天去了北京。',
      '张三说的，他昨天去了北京。',
      '张三讲过他昨天去了北京。',
      '别人说张三昨天去了北京。',
    ];
    workspaceResolution = { status: 'not_found' };

    for (const [index, content] of relayedStatements.entries()) {
      const origin = await messageStore.append({
        userId: 'owner-1',
        catId: null,
        content,
        mentions: [],
        timestamp: Date.now() + index,
        threadId: 'thread_people',
      });
      const sourceId = `relayed-hearsay-${index}`;
      const response = await proposeFromOrigin(
        {
          person: { displayName: '张三', privateAliases: ['张三'] },
          claims: [],
          interaction: {
            payload: {
              eventKind: 'other',
              headline: '张三去了北京',
              importanceOrTopic: '出行',
              uncertaintyNotes: [],
            },
            normalizedDraft: '张三昨天去了北京',
            sourceRole: 'owner_explicit',
            evidenceExcerpt: content,
          },
          sourceBundle: {
            sources: [
              {
                sourceId,
                kind: 'message_text',
                messageId: origin.id,
                excerpt: content,
              },
            ],
            assertionBindings: [
              {
                sourceId,
                target: { kind: 'interaction', field: 'eventKind' },
                role: 'reported_fact',
              },
              {
                sourceId,
                target: { kind: 'interaction', field: 'headline' },
                role: 'reported_fact',
              },
              {
                sourceId,
                target: { kind: 'interaction', field: 'importanceOrTopic' },
                role: 'user_assessment',
              },
            ],
          },
          clientRequestId: `relayed-hearsay-${index}`,
        },
        origin,
      );

      assert.equal(response.statusCode, 400, content);
      const payload = JSON.parse(response.body);
      assert.equal(payload.error, 'invalid_assertion_binding', content);
      assert.equal(payload.preflight.issues[0].code, 'assertion_not_materializable', content);
      assert.equal(JSON.stringify(payload).includes(content), false);
    }
    assert.equal(stageCalls, 0);
  });

  it('rejects wrong attachment digests and source drift with zero pending card', async () => {
    const imageBlock = {
      type: 'image',
      url: '/uploads/source-drift.png',
      alt: '截图显示周玉晶负责 proactive memory pipeline',
    };
    const origin = await messageStore.append({
      userId: 'owner-1',
      catId: null,
      content: '职责见截图。',
      contentBlocks: [imageBlock],
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread_people',
    });
    workspaceResolution = { status: 'not_found' };
    const base = {
      person: { displayName: '周玉晶', privateAliases: ['周玉晶'] },
      claims: [
        {
          payload: {
            kind: 'reported_fact',
            predicate: 'project_role',
            value: '负责 proactive memory pipeline',
            assertedBy: 'owner',
          },
          normalizedDraft: '周玉晶负责 proactive memory pipeline',
          sourceRole: 'owner_explicit',
          evidenceExcerpt: imageBlock.alt,
        },
      ],
      sourceBundle: {
        sources: [
          {
            sourceId: 'drifting-attachment',
            kind: 'message_attachment',
            messageId: origin.id,
            attachmentLocator: { surface: 'content_block', index: 0 },
            expectedDigest: digestSourceMaterial(imageBlock),
            boundedTranscript: imageBlock.alt,
          },
        ],
        assertionBindings: [
          {
            sourceId: 'drifting-attachment',
            target: { kind: 'claim', index: 0 },
            role: 'reported_fact',
          },
        ],
      },
    };
    const wrongDigest = await proposeFromOrigin(
      {
        ...base,
        sourceBundle: {
          ...base.sourceBundle,
          sources: [{ ...base.sourceBundle.sources[0], expectedDigest: 'f'.repeat(64) }],
        },
        clientRequestId: 'wrong-attachment-digest',
      },
      origin,
    );
    assert.equal(wrongDigest.statusCode, 400);
    assert.equal(JSON.parse(wrongDigest.body).error, 'source_digest_mismatch');
    assert.equal(stageCalls, 0);

    afterStage = async () => {
      await messageStore.softDelete(origin.id, 'owner-1');
    };
    const drift = await proposeFromOrigin({ ...base, clientRequestId: 'attachment-source-drift' }, origin);
    assert.equal(drift.statusCode, 409);
    assert.deepEqual(JSON.parse(drift.body), { error: 'source_drift' });
    assert.equal(stageCalls, 1);
    const candidateId = `person_candidate_${createHash('sha256')
      .update(['owner-1', 'codex-sol', 'attachment-source-drift'].join('\0'))
      .digest('hex')
      .slice(0, 24)}`;
    assert.equal(await store.getCandidateForOwner('owner-1', candidateId), null);
  });

  it('binds claims to an exact historical owner source instead of a cat-triggered follow-up', async () => {
    const historicalSource = await messageStore.append({
      userId: 'owner-1',
      catId: null,
      content: '黄挺是终端用户计算开发部 21 级',
      mentions: [],
      timestamp: Date.now() - 1,
      threadId: 'thread_history',
    });
    const catTrigger = await messageStore.append({
      userId: 'owner-1',
      catId: 'codex-sol',
      content: '根据旧原话重建完整纠错卡。',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread_people',
    });
    const auth = await registry.create(
      'owner-1',
      'codex-sol',
      'thread_people',
      undefined,
      undefined,
      undefined,
      catTrigger.id,
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/propose-person-memory',
      headers: {
        'x-invocation-id': auth.invocationId,
        'x-callback-token': auth.callbackToken,
        'content-type': 'application/json',
      },
      payload: {
        ...proposalBody,
        sourceMessageId: historicalSource.id,
        clientRequestId: 'historical-claim-source',
      },
    });

    assert.equal(response.statusCode, 200);
    const candidate = await store.getCandidateForOwner('owner-1', JSON.parse(response.body).candidateId);
    assert.equal(candidate.sourceMessageRef.messageId, catTrigger.id);
    assert.deepEqual(candidate.sourceBundle.sources[0].sourceRef, {
      kind: 'message',
      threadId: 'thread_history',
      messageId: historicalSource.id,
    });
    const currentMessages = await messageStore.getByThread('thread_people', 20, 'owner-1');
    const historicalMessages = await messageStore.getByThread('thread_history', 20, 'owner-1');
    assert.equal(
      currentMessages.some((message) =>
        message.extra?.rich?.blocks?.some((block) => block.meta?.candidateId === candidate.candidateId),
      ),
      true,
    );
    assert.equal(
      historicalMessages.some((message) =>
        message.extra?.rich?.blocks?.some((block) => block.meta?.candidateId === candidate.candidateId),
      ),
      false,
    );
  });

  it('creates an informative Alden card in the current thread from typed owner sources in another thread', async () => {
    workspaceResolution = { status: 'not_found' };
    const identitySource = await messageStore.append({
      userId: 'owner-1',
      catId: null,
      content: 'Alden 是我讨论 agent 自进化和评估的技术交流对象。',
      mentions: [],
      timestamp: Date.now() - 2,
      threadId: 'thread_alden_history',
    });
    const interactionSource = await messageStore.append({
      userId: 'owner-1',
      catId: null,
      content: '我和 Alden 讨论过可信 loss 和 proactive 度量；我认为他第一性原理视角很强。',
      mentions: [],
      timestamp: Date.now() - 1,
      threadId: 'thread_alden_history',
    });
    const origin = await messageStore.append({
      userId: 'owner-1',
      catId: null,
      content: '给 Alden 建一张有信息量的人物卡，用我之前讲过的原话。',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread_current',
    });
    const response = await proposeFromOrigin(
      {
        person: { displayName: 'Alden', privateAliases: ['Alden'] },
        claims: [
          {
            payload: {
              kind: 'reported_fact',
              predicate: 'technical_exchange_context',
              value: '讨论 agent 自进化和评估的技术交流对象',
              assertedBy: 'owner',
            },
            normalizedDraft: 'Alden 是讨论 agent 自进化和评估的技术交流对象',
            sourceRole: 'owner_explicit',
            evidenceExcerpt: '讨论 agent 自进化和评估的技术交流对象',
          },
        ],
        interaction: {
          payload: {
            eventKind: 'conversation',
            headline: '与 Alden 讨论可信 loss 和 proactive 度量',
            importanceOrTopic: 'You 认为他第一性原理视角很强',
            uncertaintyNotes: [],
          },
          normalizedDraft: '与 Alden 讨论可信 loss 和 proactive 度量',
          sourceRole: 'owner_explicit',
          evidenceExcerpt: '讨论过可信 loss 和 proactive 度量',
        },
        sourceMessageId: identitySource.id,
        sourceBundle: {
          sources: [
            {
              sourceId: 'alden-identity',
              kind: 'message_text',
              messageId: identitySource.id,
              excerpt: '讨论 agent 自进化和评估的技术交流对象',
            },
            {
              sourceId: 'alden-conversation',
              kind: 'message_text',
              messageId: interactionSource.id,
              excerpt: '讨论过可信 loss 和 proactive 度量；我认为他第一性原理视角很强',
            },
          ],
          assertionBindings: [
            { sourceId: 'alden-identity', target: { kind: 'claim', index: 0 }, role: 'reported_fact' },
            {
              sourceId: 'alden-conversation',
              target: { kind: 'interaction', field: 'eventKind' },
              role: 'reported_fact',
            },
            {
              sourceId: 'alden-conversation',
              target: { kind: 'interaction', field: 'headline' },
              role: 'reported_fact',
            },
            {
              sourceId: 'alden-conversation',
              target: { kind: 'interaction', field: 'importanceOrTopic' },
              role: 'user_assessment',
            },
          ],
        },
        clientRequestId: 'alden-cross-thread-informed-card',
      },
      origin,
    );

    assert.equal(response.statusCode, 200, response.body);
    const candidate = await store.getCandidateForOwner('owner-1', JSON.parse(response.body).candidateId);
    assert.deepEqual(candidate.sourceMessageRef, {
      kind: 'message',
      threadId: 'thread_current',
      messageId: origin.id,
    });
    assert.deepEqual(
      candidate.sourceBundle.sources.map((source) => source.sourceRef),
      [
        { kind: 'message', threadId: 'thread_alden_history', messageId: identitySource.id },
        { kind: 'message', threadId: 'thread_alden_history', messageId: interactionSource.id },
      ],
    );
    const currentMessages = await messageStore.getByThread('thread_current', 20, 'owner-1');
    const card = currentMessages
      .flatMap((message) => message.extra?.rich?.blocks ?? [])
      .find((block) => block.meta?.candidateId === candidate.candidateId);
    assert.match(card.bodyMarkdown, /技术交流对象/);
    assert.match(card.bodyMarkdown, /第一性原理视角很强/);
    assert.match(card.bodyMarkdown, /可信 loss 和 proactive 度量/);
    const historicalMessages = await messageStore.getByThread('thread_alden_history', 20, 'owner-1');
    assert.equal(
      historicalMessages.some((message) =>
        message.extra?.rich?.blocks?.some((block) => block.meta?.candidateId === candidate.candidateId),
      ),
      false,
    );
  });

  it('rejects historical claim sources that are not exact eligible owner messages', async () => {
    const deletedSource = await messageStore.append({
      userId: 'owner-1',
      catId: null,
      content: proposalBody.claims[0].evidenceExcerpt,
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread_people',
    });
    await messageStore.softDelete(deletedSource.id, 'owner-1');
    const invalidSources = [
      await messageStore.append({
        userId: 'owner-2',
        catId: null,
        content: proposalBody.claims[0].evidenceExcerpt,
        mentions: [],
        timestamp: Date.now(),
        threadId: 'thread_other',
      }),
      await messageStore.append({
        userId: 'owner-1',
        catId: null,
        content: proposalBody.claims[0].evidenceExcerpt,
        mentions: [],
        timestamp: Date.now(),
        threadId: 'thread_other',
        source: { connector: 'test', label: 'Test Connector', icon: 'test' },
      }),
      await messageStore.append({
        userId: 'owner-1',
        catId: 'codex-sol',
        content: proposalBody.claims[0].evidenceExcerpt,
        mentions: [],
        timestamp: Date.now(),
        threadId: 'thread_people',
      }),
      await messageStore.append({
        userId: 'owner-1',
        catId: null,
        content: proposalBody.claims[0].evidenceExcerpt,
        mentions: [],
        timestamp: Date.now(),
        threadId: 'thread_other',
        deliveryStatus: 'queued',
      }),
      deletedSource,
      await messageStore.append({
        userId: 'owner-1',
        catId: null,
        content: '同一 owner 的另一条消息，但没有精确证据子串。',
        mentions: [],
        timestamp: Date.now(),
        threadId: 'thread_people',
      }),
    ];

    for (const [index, source] of invalidSources.entries()) {
      const { response } = await propose({
        ...proposalBody,
        sourceMessageId: source.id,
        clientRequestId: `invalid-historical-claim-source-${index}`,
      });
      assert.equal(response.statusCode, 400);
      assert.equal(JSON.parse(response.body).error, 'invalid_proposal_source');
    }
    assert.equal(stageCalls, 0);
  });

  it('rejects the whole event when any evidence source is not an exact eligible owner message', async () => {
    const deletedSource = await messageStore.append({
      userId: 'owner-1',
      catId: null,
      content: '已经删除的事实来源',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread_people',
    });
    await messageStore.softDelete(deletedSource.id, 'owner-1');
    const excerptMismatch = await messageStore.append({
      userId: 'owner-1',
      catId: null,
      content: '实际原文没有提到虚构时长',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread_people',
    });
    const invalidSources = [
      await messageStore.append({
        userId: 'owner-2',
        catId: null,
        content: '跨 thread 的事实来源',
        mentions: [],
        timestamp: Date.now(),
        threadId: 'thread_other',
      }),
      await messageStore.append({
        userId: 'owner-1',
        catId: null,
        content: 'connector 洗白的事实来源',
        mentions: [],
        timestamp: Date.now(),
        threadId: 'thread_other',
        source: { connector: 'test', label: 'Test Connector', icon: 'test' },
      }),
      await messageStore.append({
        userId: 'owner-2',
        catId: null,
        content: '另一个 owner 的事实来源',
        mentions: [],
        timestamp: Date.now(),
        threadId: 'thread_people',
      }),
      await messageStore.append({
        userId: 'owner-1',
        catId: 'codex-sol',
        content: '猫写的推断不是 owner 来源',
        mentions: [],
        timestamp: Date.now(),
        threadId: 'thread_people',
      }),
      deletedSource,
      { id: 'missing_message', content: '不存在的来源' },
      { ...excerptMismatch, content: '虚构的三小时' },
    ];

    for (const [index, source] of invalidSources.entries()) {
      const { response } = await propose({
        person: proposalBody.person,
        claims: [],
        interaction: {
          payload: {
            eventKind: 'meeting',
            headline: '与黄挺线下见面',
            importanceOrTopic: '讨论终端用户计算',
            uncertaintyNotes: [],
          },
          normalizedDraft: '与黄挺线下见面',
          sourceRole: 'owner_explicit',
          evidenceExcerpt: source.content,
          sources: [
            {
              messageId: source.id,
              evidenceExcerpt: source.content,
              supports: ['eventKind', 'headline', 'importanceOrTopic'],
            },
          ],
        },
        clientRequestId: `invalid-event-source-${index}`,
      });
      assert.equal(response.statusCode, 400);
      assert.equal(JSON.parse(response.body).error, 'invalid_interaction_source');
    }
    assert.equal(stageCalls, 0);
  });

  it('deduplicates retries and rejects an invalid caller-selected source message', async () => {
    const first = await propose(proposalBody);
    const second = await proposeFromOrigin(proposalBody, first.origin);
    assert.equal(JSON.parse(first.response.body).candidateId, JSON.parse(second.body).candidateId);
    assert.equal(JSON.parse(second.body).deduped, true);

    const forged = await propose({ ...proposalBody, sourceMessageId: 'msg_forged', clientRequestId: 'forged' });
    assert.equal(forged.response.statusCode, 400);
    assert.equal(JSON.parse(forged.response.body).error, 'invalid_proposal_source');
  });

  it('rejects the same idempotency key when resolved source content changes', async () => {
    workspaceResolution = { status: 'not_found' };
    const firstOrigin = await messageStore.append({
      userId: 'owner-1',
      catId: null,
      content: '周玉晶负责 proactive memory pipeline',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread_people',
    });
    const secondOrigin = await messageStore.append({
      userId: 'owner-1',
      catId: null,
      content: '周玉晶不负责 proactive memory pipeline',
      mentions: [],
      timestamp: Date.now() + 1,
      threadId: 'thread_people',
    });
    const bodyFor = (origin, value) => ({
      person: { displayName: '周玉晶', privateAliases: ['周玉晶'] },
      claims: [
        {
          payload: {
            kind: 'reported_fact',
            predicate: 'project_role',
            value,
            assertedBy: 'owner',
          },
          normalizedDraft: value,
          sourceRole: 'owner_explicit',
          evidenceExcerpt: value,
        },
      ],
      sourceBundle: {
        sources: [
          {
            sourceId: 'role-source',
            kind: 'message_text',
            messageId: origin.id,
            excerpt: value,
          },
        ],
        assertionBindings: [
          {
            sourceId: 'role-source',
            target: { kind: 'claim', index: 0 },
            role: 'reported_fact',
          },
        ],
      },
      clientRequestId: 'source-digest-conflict',
    });
    const first = await proposeFromOrigin(bodyFor(firstOrigin, '周玉晶负责 proactive memory pipeline'), firstOrigin);
    const conflict = await proposeFromOrigin(
      bodyFor(secondOrigin, '周玉晶不负责 proactive memory pipeline'),
      secondOrigin,
    );
    assert.equal(first.statusCode, 200);
    assert.equal(conflict.statusCode, 409);
    assert.deepEqual(JSON.parse(conflict.body), { error: 'source_conflict' });
    assert.equal(stageCalls, 1);
  });

  it('accepts a matching caller link only as an assertion and derives canonical link state', async () => {
    const { response } = await propose({
      ...proposalBody,
      person: {
        ...proposalBody.person,
        workspaceEntityLink: {
          entityRef: 'person:huang-ting-huawei',
          state: 'stale',
          checkedAt: 1,
        },
      },
      clientRequestId: 'matching-link',
    });
    assert.equal(response.statusCode, 200);
    const candidate = await store.getCandidateForOwner('owner-1', JSON.parse(response.body).candidateId);
    assert.equal(candidate.personDraft.workspaceEntityLink.state, 'linked');
    assert.notEqual(candidate.personDraft.workspaceEntityLink.checkedAt, 1);
  });

  it('allows a private-only candidate only after a healthy not-found resolution', async () => {
    workspaceResolution = { status: 'not_found' };
    const { response } = await propose({ ...proposalBody, clientRequestId: 'private-only' });
    assert.equal(response.statusCode, 200);
    const candidate = await store.getCandidateForOwner('owner-1', JSON.parse(response.body).candidateId);
    assert.equal(candidate.personDraft.workspaceEntityLink, undefined);
    assert.equal(stageCalls, 1);
  });

  it('binds through a private alias when the display name is not a workspace alias', async () => {
    workspaceResolutions.set('H. Ting', { status: 'not_found' });
    workspaceResolutions.set('黄挺', {
      status: 'resolved',
      entityRef: 'person:huang-ting-huawei',
      canonicalName: '黄挺',
    });
    const { response } = await propose({
      ...proposalBody,
      person: {
        displayName: 'H. Ting',
        privateAliases: ['黄挺'],
      },
      clientRequestId: 'private-alias-identity-root',
    });

    assert.equal(response.statusCode, 200);
    const candidate = await store.getCandidateForOwner('owner-1', JSON.parse(response.body).candidateId);
    assert.equal(candidate.personDraft.workspaceEntityLink.entityRef, 'person:huang-ting-huawei');
    assert.equal(stageCalls, 1);
  });

  it('fails closed when identity-bearing aliases resolve to different workspace people', async () => {
    workspaceResolutions.set('H. Ting', {
      status: 'resolved',
      entityRef: 'person:huang-ting-huawei',
      canonicalName: '黄挺',
    });
    workspaceResolutions.set('黄挺', {
      status: 'resolved',
      entityRef: 'person:different',
      canonicalName: '另一位黄挺',
    });
    const { response } = await propose({
      ...proposalBody,
      person: {
        displayName: 'H. Ting',
        privateAliases: ['黄挺'],
      },
      clientRequestId: 'private-alias-conflict',
    });

    assert.equal(response.statusCode, 409);
    assert.equal(JSON.parse(response.body).error, 'identity_conflict');
    assert.equal(stageCalls, 0);
  });

  it('fails closed when any identity-bearing private alias is ambiguous or unavailable', async () => {
    for (const [status, statusCode, error] of [
      ['ambiguous', 409, 'identity_ambiguous'],
      ['unavailable', 503, 'identity_resolution_unavailable'],
    ]) {
      workspaceResolutions.set('H. Ting', {
        status: 'resolved',
        entityRef: 'person:huang-ting-huawei',
        canonicalName: '黄挺',
      });
      workspaceResolutions.set('黄挺', { status });
      const { response } = await propose({
        ...proposalBody,
        person: {
          displayName: 'H. Ting',
          privateAliases: ['黄挺'],
        },
        clientRequestId: `private-alias-${status}`,
      });

      assert.equal(response.statusCode, statusCode);
      assert.equal(JSON.parse(response.body).error, error);
    }
    assert.equal(stageCalls, 0);
  });

  it('fails closed with zero writes when caller link conflicts with the resolved identity', async () => {
    const { response } = await propose({
      ...proposalBody,
      person: {
        ...proposalBody.person,
        workspaceEntityLink: {
          entityRef: 'person:different',
          state: 'linked',
          checkedAt: Date.now(),
        },
      },
      clientRequestId: 'conflicting-link',
    });
    assert.equal(response.statusCode, 409);
    assert.equal(JSON.parse(response.body).error, 'identity_conflict');
    assert.equal(stageCalls, 0);
  });

  it('fails closed when a caller asserts a workspace link after a healthy not-found resolution', async () => {
    workspaceResolution = { status: 'not_found' };
    const { response } = await propose({
      ...proposalBody,
      person: {
        ...proposalBody.person,
        workspaceEntityLink: {
          entityRef: 'person:caller-only',
          state: 'linked',
          checkedAt: Date.now(),
        },
      },
      clientRequestId: 'unverified-caller-link',
    });
    assert.equal(response.statusCode, 409);
    assert.equal(JSON.parse(response.body).error, 'identity_conflict');
    assert.equal(stageCalls, 0);
  });

  it('fails closed with zero writes when workspace identity is ambiguous', async () => {
    workspaceResolution = { status: 'ambiguous' };
    const { response } = await propose({ ...proposalBody, clientRequestId: 'ambiguous' });
    assert.equal(response.statusCode, 409);
    assert.equal(JSON.parse(response.body).error, 'identity_ambiguous');
    assert.equal(stageCalls, 0);
  });

  it('fails closed with zero writes when workspace identity resolution is unavailable', async () => {
    workspaceResolution = { status: 'unavailable' };
    const { response } = await propose({ ...proposalBody, clientRequestId: 'unavailable' });
    assert.equal(response.statusCode, 503);
    assert.equal(JSON.parse(response.body).error, 'identity_resolution_unavailable');
    assert.equal(stageCalls, 0);
  });
});
