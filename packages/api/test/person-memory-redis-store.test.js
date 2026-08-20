/**
 * F276 Task 2: Redis-backed owner-private person memory state machine.
 *
 * Run through the isolated Redis harness. The test uses its own keyPrefix so
 * concurrent files cannot erase this suite's state.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const KEY_PREFIX = 'cat-cafe-f276-person-memory-test:';

describe('RedisPersonMemoryStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisPersonMemoryStore;
  let RedisDeferredPersonMemoryReceiptStore;
  let BEGIN_HARD_FORGET_LUA;
  let FINISH_HARD_FORGET_LUA;
  let HumanDispositionKeys;
  let HumanDispositionLedger;
  let PersonMemoryDispositionProofResolver;
  let PersonMemoryKeys;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  const sourceMessageRef = {
    kind: 'message',
    threadId: 'thread_owner_private',
    messageId: 'msg_person_source',
  };

  const claimDraft = {
    draftId: 'person_draft_fact_1',
    payload: {
      kind: 'reported_fact',
      predicate: 'organization_unit',
      value: '终端用户计算开发部',
      assertedBy: 'owner',
    },
    normalizedDraft: '黄挺属于终端用户计算开发部',
    sourceRole: 'owner_explicit',
    evidenceExcerpt: '黄挺是终端用户计算开发部 21 级',
    decision: 'pending',
  };

  const eventDraft = {
    draftId: 'person_draft_event_1',
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
      headline: '线下见面',
      importanceOrTopic: '讨论终端用户计算方向，也让双方关系更具体',
      uncertaintyNotes: ['日期与星期存在冲突'],
    },
    normalizedDraft: '与黄挺线下见面，日期存在冲突，时长约两小时',
    sourceRole: 'owner_explicit',
    evidenceExcerpt: '7 月 23 日周三，见了大约两个小时',
    sourceEvidence: [
      {
        sourceRef: sourceMessageRef,
        evidenceExcerpt: '7 月 23 日周三，见了大约两个小时',
        supports: ['eventKind', 'headline', 'occurredAt', 'duration'],
      },
      {
        sourceRef: {
          kind: 'message',
          threadId: 'thread_owner_private',
          messageId: 'msg_person_source_topic',
        },
        evidenceExcerpt: '聊了终端用户计算，这次见面对我挺重要',
        supports: ['importanceOrTopic', 'uncertaintyNotes'],
      },
    ],
    decision: 'pending',
  };

  const sourceBundleFor = (input) => {
    const sources = [];
    const assertionBindings = [];
    for (const draft of input.claimDrafts) {
      const sourceId = `source-${draft.draftId}`;
      sources.push({
        sourceId,
        kind: 'message_text',
        sourceRef: input.sourceMessageRef,
        ownerUserId: input.ownerUserId,
        resolvedDigest: 'a'.repeat(64),
        excerpt: draft.evidenceExcerpt,
      });
      assertionBindings.push({
        sourceId,
        target: { kind: 'claim', draftId: draft.draftId },
        role: draft.payload.kind,
      });
    }
    if (input.relationshipDraft) {
      const sourceId = `source-${input.relationshipDraft.draftId}`;
      sources.push({
        sourceId,
        kind: 'message_text',
        sourceRef: input.sourceMessageRef,
        ownerUserId: input.ownerUserId,
        resolvedDigest: 'b'.repeat(64),
        excerpt: input.relationshipDraft.evidenceExcerpt,
      });
      assertionBindings.push({
        sourceId,
        target: { kind: 'relationship', draftId: input.relationshipDraft.draftId, field: 'status' },
        role: 'reported_fact',
      });
    }
    if (input.interactionDraft) {
      for (const [index, evidence] of input.interactionDraft.sourceEvidence.entries()) {
        const sourceId = `source-${input.interactionDraft.draftId}-${index}`;
        sources.push({
          sourceId,
          kind: 'message_text',
          sourceRef: evidence.sourceRef,
          ownerUserId: input.ownerUserId,
          resolvedDigest: `${index + 1}`.repeat(64),
          excerpt: evidence.evidenceExcerpt,
        });
        for (const field of evidence.supports) {
          assertionBindings.push({
            sourceId,
            target: { kind: 'interaction', draftId: input.interactionDraft.draftId, field },
            role: field === 'importanceOrTopic' || field === 'uncertaintyNotes' ? 'user_assessment' : 'reported_fact',
          });
        }
      }
    }
    return { sources, assertionBindings };
  };

  const candidateInput = (overrides = {}) => {
    const input = {
      candidateId: 'person_candidate_1',
      ownerUserId: 'owner-1',
      requesterCatId: 'codex-sol',
      sourceMessageRef,
      personDraft: {
        displayName: '黄挺',
        privateAliases: ['黄挺'],
      },
      claimDrafts: [claimDraft],
      interactionDraft: eventDraft,
      remainingDraftIds: [claimDraft.draftId, eventDraft.draftId],
      retention: 'owner_controlled_no_ttl',
      createdAt: 100,
      ...overrides,
    };
    return { ...input, sourceBundle: overrides.sourceBundle ?? sourceBundleFor(input) };
  };

  const envelopeFor = (input) => ({
    canonicalProposalId: input.candidateId,
    sourceFeatureId: 'F276',
    ownerUserId: input.ownerUserId,
    requesterCatId: input.requesterCatId,
    originRef: {
      kind: 'message',
      threadId: input.sourceMessageRef.threadId,
      messageId: input.sourceMessageRef.messageId,
    },
    approvalCardRef: {
      threadId: input.sourceMessageRef.threadId,
      messageId: `card_${input.candidateId}`,
    },
    createdAt: input.createdAt,
  });

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisPersonMemoryStore');
    const storeModule = await import('../dist/domains/memory/people/RedisPersonMemoryStore.js');
    RedisPersonMemoryStore = storeModule.RedisPersonMemoryStore;
    ({ RedisDeferredPersonMemoryReceiptStore } = await import(
      '../dist/domains/memory/RedisDeferredPersonMemoryReceiptStore.js'
    ));
    const luaModule = await import('../dist/domains/memory/people/person-memory-lua.js');
    BEGIN_HARD_FORGET_LUA = luaModule.BEGIN_HARD_FORGET_LUA;
    FINISH_HARD_FORGET_LUA = luaModule.FINISH_HARD_FORGET_LUA;
    const keysModule = await import('../dist/domains/memory/people/person-memory-keys.js');
    PersonMemoryKeys = keysModule.PersonMemoryKeys;
    const dispositionKeysModule = await import('../dist/domains/human-disposition/human-disposition-keys.js');
    HumanDispositionKeys = dispositionKeysModule.HumanDispositionKeys;
    const ledgerModule = await import('../dist/domains/human-disposition/HumanDispositionLedger.js');
    HumanDispositionLedger = ledgerModule.HumanDispositionLedger;
    const proofModule = await import('../dist/domains/memory/people/PersonMemoryDispositionProofResolver.js');
    PersonMemoryDispositionProofResolver = proofModule.PersonMemoryDispositionProofResolver;
    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: KEY_PREFIX });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[person-memory-redis-store.test] Redis unreachable, skipping');
      await redis.quit().catch(() => {});
    }
  });

  after(async () => {
    if (!connected) return;
    await cleanupClientKeyspace(redis);
    await redis.quit().catch(() => {});
  });

  beforeEach(async () => {
    if (connected) await cleanupClientKeyspace(redis);
    store = new RedisPersonMemoryStore(redis);
  });

  async function stageAndAnchor(input = candidateInput()) {
    const staged = await store.stageCandidate(input);
    assert.equal(staged.publication.state, 'staged');
    assert.deepEqual(await store.listPending(input.ownerUserId), []);
    await store.commitEnvelope(input.candidateId, envelopeFor(input));
    return input;
  }

  async function stageDeferredReceipt(receiptId, overrides = {}) {
    const receiptStore = new RedisDeferredPersonMemoryReceiptStore(redis);
    const staged = await receiptStore.stage({
      receiptId,
      ownerUserId: 'owner-1',
      requesterCatId: 'codex-sol',
      invocationId: 'invocation-deferred-forget',
      originMessageRef: sourceMessageRef,
      subject: '黄挺',
      normalizedSubject: '黄挺',
      registryBinding: { kind: 'registered_person', ref: 'person_huang_ting' },
      sourceCoordinates: [
        {
          kind: 'message',
          sourceRef: sourceMessageRef,
          resolvedDigest: '9'.repeat(64),
        },
      ],
      sourceBundleDigest: '8'.repeat(64),
      dedupeHash: receiptId.slice(-32).padStart(64, '7'),
      ready: true,
      createdAt: 100,
      ...overrides,
    });
    assert.equal(staged.outcome, 'created');
    return { receiptStore, receipt: staged.receipt };
  }

  async function claimDeferredReceiptForProposal(receiptStore, receipt, claimId) {
    const claimed = await receiptStore.claim({
      ownerUserId: receipt.ownerUserId,
      receiptId: receipt.receiptId,
      claimId,
      now: Date.now(),
      leaseMs: 60_000,
    });
    assert.equal(claimed.outcome, 'claimed');
    return {
      deferredReceiptId: receipt.receiptId,
      deferredReceiptClaimId: claimId,
      deltaFingerprint: receipt.dedupeHash,
    };
  }

  async function snapshotRedisBytes(keys) {
    return Object.fromEntries(
      await Promise.all(
        keys.map(async (key) => {
          const dump = await redis.dump(key);
          return [key, { type: await redis.type(key), dump: dump ? Buffer.from(dump).toString('base64') : null }];
        }),
      ),
    );
  }

  function pauseBeforeEval(script) {
    let release;
    let reached;
    let paused = false;
    const reachedPromise = new Promise((resolve) => {
      reached = resolve;
    });
    const releasePromise = new Promise((resolve) => {
      release = resolve;
    });
    const client = new Proxy(redis, {
      get(target, property) {
        if (property === 'eval') {
          return async (...args) => {
            if (!paused && args[0] === script) {
              paused = true;
              reached();
              await releasePromise;
            }
            return target.eval(...args);
          };
        }
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return { client, reached: reachedPromise, release };
  }

  it('makes a candidate visible only after its chat card envelope is anchored', async () => {
    const input = candidateInput();
    await store.stageCandidate(input);

    assert.equal((await store.getCandidateForOwner(input.ownerUserId, input.candidateId)).state, 'staged');
    assert.deepEqual(await store.listPending(input.ownerUserId), []);
    assert.equal(await store.getCandidateForOwner('other-owner', input.candidateId), null);

    await store.commitEnvelope(input.candidateId, envelopeFor(input));
    const pending = await store.listPending(input.ownerUserId);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].state, 'pending_approval');
    assert.equal(pending[0].publication.state, 'anchored');

    const fresh = new RedisPersonMemoryStore(redis);
    assert.equal((await fresh.getCandidateForOwner(input.ownerUserId, input.candidateId)).state, 'pending_approval');
  });

  it('shares one exact-delta lineage between immediate proposals and deferred capture', async () => {
    const deltaFingerprint = 'f'.repeat(64);
    const input = candidateInput({ deltaFingerprint });
    await store.stageCandidate(input);

    const receiptStore = new RedisDeferredPersonMemoryReceiptStore(redis);
    const receiptId = `deferred_person_${'d'.repeat(32)}`;
    const duplicate = await receiptStore.stage({
      receiptId,
      ownerUserId: input.ownerUserId,
      requesterCatId: input.requesterCatId,
      invocationId: 'invocation-after-immediate',
      originMessageRef: sourceMessageRef,
      subject: '黄挺',
      normalizedSubject: '黄挺',
      registryBinding: { kind: 'registered_person', ref: 'person_huang_ting' },
      sourceCoordinates: [
        {
          kind: 'message',
          sourceRef: sourceMessageRef,
          resolvedDigest: '9'.repeat(64),
        },
      ],
      sourceBundleDigest: '8'.repeat(64),
      dedupeHash: deltaFingerprint,
      ready: true,
      createdAt: 110,
    });

    assert.deepEqual(duplicate, {
      outcome: 'already_proposed',
      proposalId: input.candidateId,
    });
    assert.equal(await receiptStore.get(input.ownerUserId, receiptId), null);

    const deferredFirstFingerprint = 'a'.repeat(64);
    const deferredFirstReceiptId = `deferred_person_${'a'.repeat(32)}`;
    const deferredFirst = await receiptStore.stage({
      receiptId: deferredFirstReceiptId,
      ownerUserId: input.ownerUserId,
      requesterCatId: input.requesterCatId,
      invocationId: 'invocation-before-immediate',
      originMessageRef: sourceMessageRef,
      subject: '黄挺',
      normalizedSubject: '黄挺',
      registryBinding: { kind: 'registered_person', ref: 'person_huang_ting' },
      sourceCoordinates: [
        {
          kind: 'message',
          sourceRef: sourceMessageRef,
          resolvedDigest: '7'.repeat(64),
        },
      ],
      sourceBundleDigest: '6'.repeat(64),
      dedupeHash: deferredFirstFingerprint,
      ready: true,
      createdAt: 120,
    });
    assert.equal(deferredFirst.outcome, 'created');

    const immediateAfterDeferred = candidateInput({
      candidateId: 'person_candidate_after_deferred',
      deltaFingerprint: deferredFirstFingerprint,
    });
    await assert.rejects(
      () => store.stageCandidate(immediateAfterDeferred),
      /exact person-memory delta already has active lineage/,
    );
    assert.equal(
      await store.getCandidateForOwner(immediateAfterDeferred.ownerUserId, immediateAfterDeferred.candidateId),
      null,
    );
    assert.equal((await receiptStore.get(input.ownerUserId, deferredFirstReceiptId)).state, 'deferred');
  });

  it('atomically anchors a deferred proposal only while its exact claim remains active', async () => {
    const deltaFingerprint = 'e'.repeat(64);
    const receiptId = `deferred_person_${'e'.repeat(32)}`;
    const { receiptStore, receipt } = await stageDeferredReceipt(receiptId, {
      dedupeHash: deltaFingerprint,
    });
    const now = Date.now();
    const claim = await receiptStore.claim({
      ownerUserId: 'owner-1',
      receiptId,
      claimId: 'claim-atomic',
      now,
      leaseMs: 60_000,
    });
    assert.equal(claim.outcome, 'claimed');

    const input = candidateInput({
      candidateId: 'person_candidate_deferred_atomic',
      deferredReceiptId: receiptId,
      deferredReceiptClaimId: 'claim-atomic',
      deltaFingerprint,
    });
    await store.stageCandidate(input);
    await store.commitEnvelope(input.candidateId, envelopeFor(input));

    assert.equal((await store.getCandidateForOwner(input.ownerUserId, input.candidateId)).state, 'pending_approval');
    const proposedReceipt = await receiptStore.get(input.ownerUserId, receipt.receiptId);
    assert.equal(proposedReceipt.state, 'proposed');
    assert.equal(proposedReceipt.proposalId, input.candidateId);
    assert.equal(proposedReceipt.subject, undefined);
    assert.equal(proposedReceipt.sourceCoordinates, undefined);
    assert.equal(proposedReceipt.invocationId, undefined);

    const racedReceiptId = `deferred_person_${'c'.repeat(32)}`;
    const racedFingerprint = 'c'.repeat(64);
    const raced = await stageDeferredReceipt(racedReceiptId, { dedupeHash: racedFingerprint });
    await raced.receiptStore.claim({
      ownerUserId: 'owner-1',
      receiptId: racedReceiptId,
      claimId: 'claim-raced',
      now,
      leaseMs: 60_000,
    });
    const racedInput = candidateInput({
      candidateId: 'person_candidate_deferred_raced',
      deferredReceiptId: racedReceiptId,
      deferredReceiptClaimId: 'claim-raced',
      deltaFingerprint: racedFingerprint,
    });
    await store.stageCandidate(racedInput);
    await raced.receiptStore.withdraw('owner-1', racedReceiptId, now + 1);

    await assert.rejects(
      () => store.commitEnvelope(racedInput.candidateId, envelopeFor(racedInput)),
      /deferred receipt|CONFLICT/i,
    );
    assert.equal((await store.getCandidateForOwner('owner-1', racedInput.candidateId)).state, 'staged');
    assert.deepEqual(
      (await store.listPending('owner-1')).map((candidate) => candidate.candidateId),
      [input.candidateId],
    );

    const expiredReceiptId = `deferred_person_${'b'.repeat(32)}`;
    const expiredFingerprint = 'b'.repeat(64);
    const expired = await stageDeferredReceipt(expiredReceiptId, { dedupeHash: expiredFingerprint });
    await expired.receiptStore.claim({
      ownerUserId: 'owner-1',
      receiptId: expiredReceiptId,
      claimId: 'claim-expired-after-stage',
      now,
      leaseMs: 60_000,
    });
    const expiredInput = candidateInput({
      candidateId: 'person_candidate_deferred_expired_after_stage',
      targetPersonId: 'person_huang_ting',
      deferredReceiptId: expiredReceiptId,
      deferredReceiptClaimId: 'claim-expired-after-stage',
      deltaFingerprint: expiredFingerprint,
    });
    await store.stageCandidate(expiredInput);
    const expiredReceiptKey = expired.receiptStore.keys.receipt('owner-1', expiredReceiptId);
    const expiredReceipt = JSON.parse(await redis.get(expiredReceiptKey));
    await redis.set(expiredReceiptKey, JSON.stringify({ ...expiredReceipt, claimUntil: Date.now() - 1 }));

    await assert.rejects(
      () => store.commitEnvelope(expiredInput.candidateId, envelopeFor(expiredInput)),
      /deferred receipt|CONFLICT/i,
    );
    const reclaimed = await expired.receiptStore.claim({
      ownerUserId: 'owner-1',
      receiptId: expiredReceiptId,
      claimId: 'claim-reclaimed',
      now: Date.now(),
      leaseMs: 60_000,
    });
    assert.equal(reclaimed.outcome, 'claimed');
    const staleRenewal = await store.renewDeferredCandidateClaim({
      ownerUserId: 'owner-1',
      candidateId: expiredInput.candidateId,
      receiptId: expiredReceiptId,
      previousClaimId: 'not-the-staged-claim',
      nextClaimId: 'claim-reclaimed',
      deltaFingerprint: expiredFingerprint,
      renewedAt: Date.now(),
    });
    assert.equal(staleRenewal.outcome, 'conflict');
    assert.equal(
      (await store.getCandidateForOwner('owner-1', expiredInput.candidateId)).deferredReceiptClaimId,
      'claim-expired-after-stage',
    );
    const forgetFence = PersonMemoryKeys.forgetFence('owner-1', expiredInput.targetPersonId);
    await redis.set(forgetFence, 'forget-in-progress');
    const fencedRenewal = await store.renewDeferredCandidateClaim({
      ownerUserId: 'owner-1',
      candidateId: expiredInput.candidateId,
      receiptId: expiredReceiptId,
      previousClaimId: 'claim-expired-after-stage',
      nextClaimId: 'claim-reclaimed',
      deltaFingerprint: expiredFingerprint,
      renewedAt: Date.now(),
    });
    assert.equal(fencedRenewal.outcome, 'not_available');
    assert.equal(
      (await store.getCandidateForOwner('owner-1', expiredInput.candidateId)).deferredReceiptClaimId,
      'claim-expired-after-stage',
    );
    await redis.del(forgetFence);
    const renewed = await store.renewDeferredCandidateClaim({
      ownerUserId: 'owner-1',
      candidateId: expiredInput.candidateId,
      receiptId: expiredReceiptId,
      previousClaimId: 'claim-expired-after-stage',
      nextClaimId: 'claim-reclaimed',
      deltaFingerprint: expiredFingerprint,
      renewedAt: Date.now(),
    });
    assert.equal(renewed.outcome, 'renewed');
    assert.equal(renewed.candidate.deferredReceiptClaimId, 'claim-reclaimed');
    const replayedRenewal = await store.renewDeferredCandidateClaim({
      ownerUserId: 'owner-1',
      candidateId: expiredInput.candidateId,
      receiptId: expiredReceiptId,
      previousClaimId: 'claim-expired-after-stage',
      nextClaimId: 'claim-reclaimed',
      deltaFingerprint: expiredFingerprint,
      renewedAt: Date.now(),
    });
    assert.equal(replayedRenewal.outcome, 'replayed');
    await store.commitEnvelope(expiredInput.candidateId, envelopeFor(expiredInput));
    assert.equal((await store.getCandidateForOwner('owner-1', expiredInput.candidateId)).state, 'pending_approval');
  });

  it('aborts a staged candidate without leaving a pending dossier or alias', async () => {
    const input = candidateInput();
    await store.stageCandidate(input);
    await store.abortStaged(input.candidateId, 'chat_card_failed');

    assert.equal(await store.getCandidateForOwner(input.ownerUserId, input.candidateId), null);
    assert.deepEqual(await store.listPending(input.ownerUserId), []);
    assert.deepEqual(await store.resolveActivePersonByAlias(input.ownerUserId, '黄挺'), {
      status: 'not_available',
    });
  });

  it('materializes only selected draft IDs and purges proposal payload at terminal state', async () => {
    const input = await stageAndAnchor();

    const first = await store.approveDrafts({
      ownerUserId: input.ownerUserId,
      candidateId: input.candidateId,
      selectedDraftIds: [claimDraft.draftId],
      decisionId: 'decision_fact_1',
      authorizedAt: 200,
    });
    assert.equal(first.outcome, 'applied');
    assert.equal(first.receipt.state, 'partially_materialized');
    assert.deepEqual(first.receipt.remainingDraftIds, [eventDraft.draftId]);

    const claims = await store.listClaims(input.ownerUserId, first.receipt.personId);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].status, 'current');
    assert.deepEqual(
      claims[0].typedProvenance.assertionBindings.map((binding) => binding.target.draftId),
      [claimDraft.draftId],
    );
    assert.deepEqual(claims[0].sourceRefs, [sourceMessageRef]);
    const partial = await store.getCandidateForOwner(input.ownerUserId, input.candidateId);
    assert.deepEqual(
      [...new Set(partial.sourceBundle.assertionBindings.map((binding) => binding.target.draftId))],
      [claimDraft.draftId, eventDraft.draftId],
    );
    assert.equal(partial.sourceBundle.sources.length, 3);
    assert.deepEqual(await store.listInteractionEvents(input.ownerUserId, first.receipt.personId), []);

    const second = await store.approveDrafts({
      ownerUserId: input.ownerUserId,
      candidateId: input.candidateId,
      selectedDraftIds: [eventDraft.draftId],
      decisionId: 'decision_event_1',
      authorizedAt: 300,
    });
    assert.equal(second.outcome, 'applied');
    assert.equal(second.receipt.state, 'materialized');
    assert.deepEqual(second.receipt.remainingDraftIds, []);

    const terminal = await store.getCandidateForOwner(input.ownerUserId, input.candidateId);
    assert.equal(terminal.state, 'materialized');
    assert.equal(terminal.personDraft, undefined);
    assert.deepEqual(terminal.claimDrafts, []);
    assert.equal(terminal.interactionDraft, undefined);
    assert.equal(terminal.sourceBundle, undefined);
    assert.deepEqual(await store.listPending(input.ownerUserId), []);

    const events = await store.listInteractionEvents(input.ownerUserId, second.receipt.personId);
    assert.equal(events.length, 1);
    assert.equal(events[0].occurredAt.kind, 'conflict');
    assert.equal(events[0].duration.kind, 'approximate');
    assert.deepEqual(
      [...new Set(events[0].typedProvenance.assertionBindings.map((binding) => binding.target.draftId))],
      [eventDraft.draftId],
    );
  });

  it('preserves quoted-third-party role in canonical typed provenance', async () => {
    const quotedDraft = {
      ...claimDraft,
      draftId: 'person_draft_quoted_role',
      sourceRole: 'quoted_third_party',
      payload: {
        kind: 'reported_fact',
        predicate: 'quoted_project_role',
        value: '周玉晶说她负责 proactive memory pipeline',
        assertedBy: 'owner',
      },
      normalizedDraft: '周玉晶说她负责 proactive memory pipeline',
      evidenceExcerpt: '周玉晶说她负责 proactive memory pipeline',
    };
    const input = candidateInput({
      candidateId: 'person_candidate_quoted_role',
      claimDrafts: [quotedDraft],
      interactionDraft: undefined,
      remainingDraftIds: [quotedDraft.draftId],
    });
    input.sourceBundle.assertionBindings[0].role = 'quoted_third_party';
    await stageAndAnchor(input);
    const approved = await store.approveDrafts({
      ownerUserId: input.ownerUserId,
      candidateId: input.candidateId,
      selectedDraftIds: [quotedDraft.draftId],
      decisionId: 'decision_quoted_role',
      authorizedAt: 200,
    });
    const [claim] = await store.listClaims(input.ownerUserId, approved.receipt.personId);
    assert.equal(claim.typedProvenance.assertionBindings[0].role, 'quoted_third_party');
  });

  it('replays the same decision and permits only one winner for concurrent overlap', async () => {
    const input = candidateInput({
      candidateId: 'person_candidate_concurrent',
      interactionDraft: undefined,
      remainingDraftIds: [claimDraft.draftId],
    });
    await stageAndAnchor(input);

    const request = {
      ownerUserId: input.ownerUserId,
      candidateId: input.candidateId,
      selectedDraftIds: [claimDraft.draftId],
      decisionId: 'decision_retry',
      authorizedAt: 200,
    };
    const [first, replay] = await Promise.all([store.approveDrafts(request), store.approveDrafts(request)]);
    assert.deepEqual([first.outcome, replay.outcome].sort(), ['applied', 'replayed']);
    assert.deepEqual(first.receipt, replay.receipt);

    const personId = first.receipt.personId;
    assert.equal((await store.listClaims(input.ownerUserId, personId)).length, 1);

    const other = await store.approveDrafts({
      ...request,
      decisionId: 'decision_competing',
    });
    assert.equal(other.outcome, 'conflict');
    assert.equal((await store.listClaims(input.ownerUserId, personId)).length, 1);
  });

  it('atomically permits only one active person per owner and workspace Entity', async () => {
    const linkedDraft = {
      displayName: '黄挺',
      privateAliases: ['黄挺'],
      workspaceEntityLink: {
        entityRef: 'person:huang-ting-huawei',
        state: 'linked',
        checkedAt: 150,
      },
    };
    const firstInput = candidateInput({
      candidateId: 'person_candidate_entity_race_a',
      personDraft: linkedDraft,
      interactionDraft: undefined,
      remainingDraftIds: [claimDraft.draftId],
    });
    const secondInput = candidateInput({
      candidateId: 'person_candidate_entity_race_b',
      personDraft: linkedDraft,
      interactionDraft: undefined,
      remainingDraftIds: [claimDraft.draftId],
      createdAt: 101,
    });
    await store.stageCandidate(firstInput);
    await store.stageCandidate(secondInput);
    await store.commitEnvelope(firstInput.candidateId, envelopeFor(firstInput));
    await store.commitEnvelope(secondInput.candidateId, envelopeFor(secondInput));

    const [first, second] = await Promise.all([
      store.approveDrafts({
        ownerUserId: firstInput.ownerUserId,
        candidateId: firstInput.candidateId,
        selectedDraftIds: [claimDraft.draftId],
        decisionId: 'decision_entity_race_a',
        authorizedAt: 200,
      }),
      store.approveDrafts({
        ownerUserId: secondInput.ownerUserId,
        candidateId: secondInput.candidateId,
        selectedDraftIds: [claimDraft.draftId],
        decisionId: 'decision_entity_race_b',
        authorizedAt: 201,
      }),
    ]);

    assert.deepEqual([first.outcome, second.outcome].sort(), ['applied', 'conflict']);
    const winner = first.outcome === 'applied' ? first : second;
    assert.deepEqual(await store.resolveActivePersonByWorkspaceEntityRef('owner-1', 'person:huang-ting-huawei'), {
      status: 'resolved',
      person: await store.getPerson('owner-1', winner.receipt.personId),
    });
  });

  it('keeps workspace Entity extensions isolated across owners', async () => {
    const linkedDraft = {
      displayName: '黄挺',
      privateAliases: ['黄挺'],
      workspaceEntityLink: {
        entityRef: 'person:huang-ting-huawei',
        state: 'linked',
        checkedAt: 150,
      },
    };
    const firstInput = candidateInput({
      candidateId: 'person_candidate_entity_owner_a',
      personDraft: linkedDraft,
      interactionDraft: undefined,
      remainingDraftIds: [claimDraft.draftId],
    });
    const secondInput = candidateInput({
      candidateId: 'person_candidate_entity_owner_b',
      ownerUserId: 'owner-2',
      personDraft: linkedDraft,
      interactionDraft: undefined,
      remainingDraftIds: [claimDraft.draftId],
      createdAt: 101,
    });
    await stageAndAnchor(firstInput);
    await stageAndAnchor(secondInput);

    const first = await store.approveDrafts({
      ownerUserId: firstInput.ownerUserId,
      candidateId: firstInput.candidateId,
      selectedDraftIds: [claimDraft.draftId],
      decisionId: 'decision_entity_owner_a',
      authorizedAt: 200,
    });
    const second = await store.approveDrafts({
      ownerUserId: secondInput.ownerUserId,
      candidateId: secondInput.candidateId,
      selectedDraftIds: [claimDraft.draftId],
      decisionId: 'decision_entity_owner_b',
      authorizedAt: 201,
    });

    assert.equal(first.outcome, 'applied');
    assert.equal(second.outcome, 'applied');
    assert.notEqual(first.receipt.personId, second.receipt.personId);
    assert.equal(
      (await store.resolveActivePersonByWorkspaceEntityRef('owner-1', 'person:huang-ting-huawei')).person.personId,
      first.receipt.personId,
    );
    assert.equal(
      (await store.resolveActivePersonByWorkspaceEntityRef('owner-2', 'person:huang-ting-huawei')).person.personId,
      second.receipt.personId,
    );
  });

  it('does not silently attach a legacy private-only person to a workspace Entity', async () => {
    const legacyInput = candidateInput({
      candidateId: 'person_candidate_legacy_private',
      interactionDraft: undefined,
      remainingDraftIds: [claimDraft.draftId],
    });
    await stageAndAnchor(legacyInput);
    const legacyDecision = await store.approveDrafts({
      ownerUserId: legacyInput.ownerUserId,
      candidateId: legacyInput.candidateId,
      selectedDraftIds: [claimDraft.draftId],
      decisionId: 'decision_legacy_private',
      authorizedAt: 200,
    });
    assert.equal(legacyDecision.outcome, 'applied');

    const linkedInput = candidateInput({
      candidateId: 'person_candidate_legacy_link_attempt',
      targetPersonId: legacyDecision.receipt.personId,
      personDraft: {
        displayName: '黄挺',
        privateAliases: ['黄挺'],
        workspaceEntityLink: {
          entityRef: 'person:huang-ting-huawei',
          state: 'linked',
          checkedAt: 250,
        },
      },
      interactionDraft: undefined,
      remainingDraftIds: [claimDraft.draftId],
      createdAt: 201,
    });
    await stageAndAnchor(linkedInput);
    const linkAttempt = await store.approveDrafts({
      ownerUserId: linkedInput.ownerUserId,
      candidateId: linkedInput.candidateId,
      selectedDraftIds: [claimDraft.draftId],
      decisionId: 'decision_legacy_link_attempt',
      authorizedAt: 300,
    });

    assert.equal(linkAttempt.outcome, 'not_available');
    assert.equal(
      (await store.getPerson(legacyInput.ownerUserId, legacyDecision.receipt.personId)).workspaceEntityLink,
      undefined,
    );
    assert.deepEqual(
      await store.resolveActivePersonByWorkspaceEntityRef(legacyInput.ownerUserId, 'person:huang-ting-huawei'),
      { status: 'not_available' },
    );
  });

  it('undoes a terminal materialization without retaining private payload in the receipt', async () => {
    const input = candidateInput({
      candidateId: 'person_candidate_undo_terminal',
      personDraft: {
        displayName: '黄挺',
        privateAliases: ['黄挺'],
        workspaceEntityLink: {
          entityRef: 'person:huang-ting-huawei',
          state: 'linked',
          checkedAt: 150,
        },
      },
      interactionDraft: undefined,
      remainingDraftIds: [claimDraft.draftId],
    });
    await stageAndAnchor(input);
    const approved = await store.approveDrafts({
      ownerUserId: input.ownerUserId,
      candidateId: input.candidateId,
      selectedDraftIds: [claimDraft.draftId],
      decisionId: 'decision_undo_terminal',
      authorizedAt: 200,
    });

    const undoInput = {
      ownerUserId: input.ownerUserId,
      candidateId: input.candidateId,
      decisionId: approved.receipt.decisionId,
      requestId: 'undo_terminal_1',
      undoneAt: 250,
    };
    const first = await store.undoDecision(undoInput);
    const replay = await store.undoDecision(undoInput);

    assert.equal(first.outcome, 'applied');
    assert.equal(replay.outcome, 'replayed');
    assert.deepEqual(first.receipt, replay.receipt);
    assert.equal((await store.getCandidateForOwner(input.ownerUserId, input.candidateId)).state, 'withdrawn');
    assert.equal(await store.getPerson(input.ownerUserId, approved.receipt.personId), null);
    assert.deepEqual(await store.listClaims(input.ownerUserId, approved.receipt.personId), []);
    assert.deepEqual(await store.listRelationships(input.ownerUserId, approved.receipt.personId), []);
    assert.deepEqual(await store.resolveActivePersonByAlias(input.ownerUserId, '黄挺'), {
      status: 'not_available',
    });
    assert.deepEqual(
      await store.resolveActivePersonByWorkspaceEntityRef(input.ownerUserId, 'person:huang-ting-huawei'),
      { status: 'not_available' },
    );
    assert.equal(
      await redis.get(PersonMemoryKeys.workspaceEntityPerson(input.ownerUserId, 'person:huang-ting-huawei')),
      null,
    );
    assert.doesNotMatch(JSON.stringify(first.receipt), /黄挺|终端用户计算开发部|msg_person_source/);

    const forgotten = await store.hardForget({
      ownerUserId: input.ownerUserId,
      personId: approved.receipt.personId,
      requestId: 'person_forget_after_undo',
      requestedAt: 300,
    });
    assert.equal(forgotten.verdict, 'purged');
    assert.equal(await store.getCandidateForOwner(input.ownerUserId, input.candidateId), null);
  });

  it('restores a partial proposal to pending when its only decision is undone', async () => {
    const input = await stageAndAnchor(candidateInput({ candidateId: 'person_candidate_undo_partial' }));
    const approved = await store.approveDrafts({
      ownerUserId: input.ownerUserId,
      candidateId: input.candidateId,
      selectedDraftIds: [claimDraft.draftId],
      decisionId: 'decision_undo_partial',
      authorizedAt: 200,
    });
    assert.equal(approved.receipt.state, 'partially_materialized');

    const undone = await store.undoDecision({
      ownerUserId: input.ownerUserId,
      candidateId: input.candidateId,
      decisionId: approved.receipt.decisionId,
      requestId: 'undo_partial_1',
      undoneAt: 250,
    });

    assert.equal(undone.outcome, 'applied');
    const candidate = await store.getCandidateForOwner(input.ownerUserId, input.candidateId);
    assert.equal(candidate.state, 'pending_approval');
    assert.deepEqual([...candidate.remainingDraftIds].sort(), [claimDraft.draftId, eventDraft.draftId].sort());
    assert.deepEqual(await store.listPending(input.ownerUserId), [candidate]);
    assert.deepEqual(await store.listClaims(input.ownerUserId, approved.receipt.personId), []);
  });

  it('keeps not-now owner-visible but non-recallable, then rejects and purges payload', async () => {
    const input = candidateInput({
      candidateId: 'person_candidate_not_now',
      personDraft: {
        displayName: ' 黄挺 ',
        privateAliases: ['黄挺', 'Huang Ting', 'HUANG TING'],
      },
      interactionDraft: undefined,
      remainingDraftIds: [claimDraft.draftId],
    });
    await stageAndAnchor(input);

    assert.equal((await store.markNotNow(input.ownerUserId, input.candidateId, 200)).state, 'not_now');
    assert.equal((await store.listPending(input.ownerUserId))[0].state, 'not_now');
    assert.equal(
      (await store.resolvePendingCandidateBySubject(input.ownerUserId, 'HUANG TING')).candidateId,
      input.candidateId,
    );
    assert.deepEqual(await store.resolveActivePersonByAlias(input.ownerUserId, '黄挺'), {
      status: 'not_available',
    });

    const rejected = await store.rejectCandidate({
      ownerUserId: input.ownerUserId,
      candidateId: input.candidateId,
      decisionId: 'decision_reject_not_now',
      feedback: { reasonCode: 'other', detail: '  不应进入人物记忆  ' },
      decidedAt: 300,
    });
    assert.equal(rejected.outcome, 'applied');
    assert.equal(rejected.candidate.state, 'rejected');
    assert.equal(rejected.candidate.personDraft, undefined);
    assert.deepEqual(rejected.candidate.claimDrafts, []);
    assert.equal(rejected.candidate.sourceBundle, undefined);
    assert.deepEqual(rejected.candidate.latestHumanDisposition, {
      reasonCode: 'other',
      detail: '不应进入人物记忆',
    });
    assert.deepEqual(await store.listPending(input.ownerUserId), []);
    assert.equal(await store.resolvePendingCandidateBySubject(input.ownerUserId, '黄挺'), null);
    assert.deepEqual(await store.resolveDormantCandidateBySubject(input.ownerUserId, 'huang ting'), {
      tokenId: 'person_suppression_not_now',
      ownerUserId: input.ownerUserId,
      candidateId: input.candidateId,
      subjectRefs: ['黄挺', 'huang ting'],
      createdAt: 300,
    });
    assert.equal(await store.resolveDormantCandidateBySubject('owner-2', '黄挺'), null);

    const replay = await store.rejectCandidate({
      ownerUserId: input.ownerUserId,
      candidateId: input.candidateId,
      decisionId: 'decision_reject_not_now',
      feedback: { reasonCode: 'other', detail: '不应进入人物记忆' },
      decidedAt: 301,
    });
    assert.equal(replay.outcome, 'replayed');
    const conflict = await store.rejectCandidate({
      ownerUserId: input.ownerUserId,
      candidateId: input.candidateId,
      decisionId: 'decision_reject_not_now',
      feedback: { reasonCode: 'wrong' },
      decidedAt: 302,
    });
    assert.equal(conflict.outcome, 'conflict');
  });

  it('classifies concurrent exact rejection as one apply plus one replay', async () => {
    const input = await stageAndAnchor(
      candidateInput({
        candidateId: 'person_candidate_reject_concurrent',
        interactionDraft: undefined,
        remainingDraftIds: [claimDraft.draftId],
      }),
    );
    const decision = {
      ownerUserId: input.ownerUserId,
      candidateId: input.candidateId,
      decisionId: 'decision_reject_concurrent',
      feedback: { reasonCode: 'wrong' },
      decidedAt: 300,
    };

    const results = await Promise.all([store.rejectCandidate(decision), store.rejectCandidate(decision)]);
    assert.deepEqual(results.map((result) => result.outcome).sort(), ['applied', 'replayed']);
    assert.equal(
      (
        await store.rejectCandidate({
          ...decision,
          decisionId: 'decision_reject_concurrent_changed',
          decidedAt: 301,
        })
      ).outcome,
      'conflict',
    );
  });

  it('keeps no-feedback rejection replayable without accepting a new feedback payload', async () => {
    const input = await stageAndAnchor(
      candidateInput({
        candidateId: 'person_candidate_reject_legacy',
        interactionDraft: undefined,
        remainingDraftIds: [claimDraft.draftId],
      }),
    );
    assert.equal(
      (
        await store.rejectCandidate({
          ownerUserId: input.ownerUserId,
          candidateId: input.candidateId,
          decisionId: 'decision_reject_legacy_seed',
          decidedAt: 300,
        })
      ).outcome,
      'applied',
    );

    assert.equal(
      (
        await store.rejectCandidate({
          ownerUserId: input.ownerUserId,
          candidateId: input.candidateId,
          decisionId: 'decision_reject_legacy_seed',
          decidedAt: 301,
        })
      ).outcome,
      'replayed',
    );
    assert.equal(
      (
        await store.rejectCandidate({
          ownerUserId: input.ownerUserId,
          candidateId: input.candidateId,
          decisionId: 'decision_reject_legacy_feedback',
          feedback: { reasonCode: 'wrong' },
          decidedAt: 302,
        })
      ).outcome,
      'conflict',
    );
  });

  it('rejects a partial candidate while preserving already materialized objects', async () => {
    const input = await stageAndAnchor(candidateInput({ candidateId: 'person_candidate_reject_partial' }));
    const approved = await store.approveDrafts({
      ownerUserId: input.ownerUserId,
      candidateId: input.candidateId,
      selectedDraftIds: [claimDraft.draftId],
      decisionId: 'decision_reject_partial_seed',
      authorizedAt: 200,
    });
    assert.equal(approved.receipt.state, 'partially_materialized');

    const result = await store.rejectCandidate({
      ownerUserId: input.ownerUserId,
      candidateId: input.candidateId,
      decisionId: 'decision_reject_partial',
      feedback: { reasonCode: 'bad_evidence' },
      decidedAt: 300,
    });
    assert.equal(result.outcome, 'applied');
    assert.equal(result.candidate.state, 'rejected');
    assert.deepEqual(result.candidate.remainingDraftIds, []);
    assert.equal((await store.listClaims(input.ownerUserId, approved.receipt.personId)).length, 1);
    assert.equal((await store.getPerson(input.ownerUserId, approved.receipt.personId)).status, 'active');
  });

  it('does not overwrite a fully materialized candidate with rejection feedback', async () => {
    const input = await stageAndAnchor(candidateInput({ candidateId: 'person_candidate_reject_materialized' }));
    const approved = await store.approveDrafts({
      ownerUserId: input.ownerUserId,
      candidateId: input.candidateId,
      selectedDraftIds: [claimDraft.draftId, eventDraft.draftId],
      decisionId: 'decision_reject_materialized_seed',
      authorizedAt: 200,
    });
    assert.equal(approved.receipt.state, 'materialized');

    assert.equal(
      (
        await store.rejectCandidate({
          ownerUserId: input.ownerUserId,
          candidateId: input.candidateId,
          decisionId: 'decision_reject_materialized',
          feedback: { reasonCode: 'wrong' },
          decidedAt: 300,
        })
      ).outcome,
      'conflict',
    );
    assert.equal((await store.getCandidateForOwner(input.ownerUserId, input.candidateId)).state, 'materialized');
  });

  it('atomically anchors a replacement and withdraws the superseded pending proposal', async () => {
    const original = await stageAndAnchor(
      candidateInput({
        candidateId: 'person_candidate_replace_original',
      }),
    );
    const replacement = candidateInput({
      candidateId: 'person_candidate_replace_corrected',
      replacesProposalId: original.candidateId,
      interactionDraft: undefined,
      remainingDraftIds: [claimDraft.draftId],
      createdAt: 101,
    });

    await store.stageCandidate(replacement);
    await store.commitEnvelope(replacement.candidateId, envelopeFor(replacement));

    const superseded = await store.getCandidateForOwner(original.ownerUserId, original.candidateId);
    const corrected = await store.getCandidateForOwner(replacement.ownerUserId, replacement.candidateId);
    assert.equal(superseded.state, 'withdrawn');
    assert.equal(superseded.replacedByProposalId, replacement.candidateId);
    assert.equal(superseded.personDraft, undefined);
    assert.deepEqual(superseded.claimDrafts, []);
    assert.deepEqual(superseded.remainingDraftIds, []);
    assert.equal(superseded.sourceBundle, undefined);
    assert.equal(corrected.state, 'pending_approval');
    assert.equal(corrected.replacesProposalId, original.candidateId);
    assert.equal(corrected.interactionDraft, undefined);
    assert.deepEqual(corrected.remainingDraftIds, [claimDraft.draftId]);
    assert.deepEqual(
      (await store.listPending(original.ownerUserId)).map((candidate) => candidate.candidateId),
      [replacement.candidateId],
    );
    assert.equal(await store.resolveDormantCandidateBySubject(original.ownerUserId, '黄挺'), null);
  });

  it('owns one opaque lineage handle per person-bound replacement closure', async () => {
    const seed = await stageAndAnchor(
      candidateInput({
        candidateId: 'person_candidate_disposition_seed',
        interactionDraft: undefined,
        remainingDraftIds: [claimDraft.draftId],
      }),
    );
    const approved = await store.approveDrafts({
      ownerUserId: seed.ownerUserId,
      candidateId: seed.candidateId,
      selectedDraftIds: [claimDraft.draftId],
      decisionId: 'decision_disposition_seed',
      authorizedAt: 200,
    });
    const fixedRandom = (size) => new Uint8Array(size).fill(7);
    store = new RedisPersonMemoryStore(redis, { humanDispositionRandomBytesSource: fixedRandom });

    const root = candidateInput({
      candidateId: 'person_candidate_disposition_root',
      targetPersonId: approved.receipt.personId,
      interactionDraft: undefined,
      remainingDraftIds: [claimDraft.draftId],
      createdAt: 300,
    });
    await stageAndAnchor(root);
    const anchoredRoot = await store.getCandidateForOwner(root.ownerUserId, root.candidateId);
    const bindingKey = PersonMemoryKeys.dispositionLineageBinding(root.ownerUserId, root.candidateId);
    assert.equal(anchoredRoot.dispositionLineageBindingKey, bindingKey);
    const binding = JSON.parse(await redis.get(bindingKey));
    const locatorKey = PersonMemoryKeys.dispositionLineageHandleLocator(root.ownerUserId, binding.opaqueLineageHandle);
    assert.deepEqual(JSON.parse(await redis.get(locatorKey)), {
      bindingKey,
      closurePersonId: approved.receipt.personId,
    });
    assert.equal(
      await redis.sismember(
        PersonMemoryKeys.personArtifacts(root.ownerUserId, approved.receipt.personId),
        `${KEY_PREFIX}${bindingKey}`,
      ),
      1,
    );
    assert.equal(
      await redis.sismember(
        PersonMemoryKeys.personArtifacts(root.ownerUserId, approved.receipt.personId),
        `${KEY_PREFIX}${locatorKey}`,
      ),
      1,
    );

    const replacement = candidateInput({
      candidateId: 'person_candidate_disposition_replacement',
      replacesProposalId: root.candidateId,
      targetPersonId: approved.receipt.personId,
      interactionDraft: undefined,
      remainingDraftIds: [claimDraft.draftId],
      createdAt: 301,
    });
    await store.stageCandidate(replacement);
    await store.commitEnvelope(replacement.candidateId, envelopeFor(replacement));
    const anchoredReplacement = await store.getCandidateForOwner(replacement.ownerUserId, replacement.candidateId);
    const rotatedBinding = JSON.parse(await redis.get(bindingKey));
    assert.equal(anchoredReplacement.dispositionLineageBindingKey, bindingKey);
    assert.equal(rotatedBinding.opaqueLineageHandle, binding.opaqueLineageHandle);
    assert.equal(rotatedBinding.currentCandidateId, replacement.candidateId);
    assert.equal(
      await redis.get(locatorKey),
      JSON.stringify({ bindingKey, closurePersonId: approved.receipt.personId }),
    );

    const collidingRoot = candidateInput({
      candidateId: 'person_candidate_disposition_collision',
      targetPersonId: approved.receipt.personId,
      interactionDraft: undefined,
      remainingDraftIds: [claimDraft.draftId],
      createdAt: 302,
    });
    await store.stageCandidate(collidingRoot);
    await assert.rejects(
      () => store.commitEnvelope(collidingRoot.candidateId, envelopeFor(collidingRoot)),
      /collision retry exhausted/,
    );
    assert.equal(
      (await store.getCandidateForOwner(collidingRoot.ownerUserId, collidingRoot.candidateId)).state,
      'staged',
    );
    assert.equal(
      await redis.get(PersonMemoryKeys.dispositionLineageBinding(collidingRoot.ownerUserId, collidingRoot.candidateId)),
      null,
    );
    assert.equal(
      await redis.get(locatorKey),
      JSON.stringify({ bindingKey, closurePersonId: approved.receipt.personId }),
    );
  });

  it('preflights root and replacement lineage keys before anchor mutation', async () => {
    const seed = await stageAndAnchor(
      candidateInput({
        candidateId: 'person_candidate_anchor_guard_seed',
        interactionDraft: undefined,
        remainingDraftIds: [claimDraft.draftId],
      }),
    );
    const approved = await store.approveDrafts({
      ownerUserId: seed.ownerUserId,
      candidateId: seed.candidateId,
      selectedDraftIds: [claimDraft.draftId],
      decisionId: 'decision_anchor_guard_seed',
      authorizedAt: 200,
    });
    const fixedRandom = (size) => new Uint8Array(size).fill(12);
    store = new RedisPersonMemoryStore(redis, { humanDispositionRandomBytesSource: fixedRandom });
    const root = candidateInput({
      candidateId: 'person_candidate_anchor_guard_root',
      targetPersonId: approved.receipt.personId,
      interactionDraft: undefined,
      remainingDraftIds: [claimDraft.draftId],
      createdAt: 300,
    });
    await store.stageCandidate(root);
    const rootKey = PersonMemoryKeys.candidate(root.ownerUserId, root.candidateId);
    const rootBefore = await redis.get(rootKey);
    const lineageHandle = `f281_lineage_${Buffer.from(new Uint8Array(32).fill(12)).toString('base64url')}`;
    const locatorKey = PersonMemoryKeys.dispositionLineageHandleLocator(root.ownerUserId, lineageHandle);
    await redis.sadd(locatorKey, 'wrong-type');
    await assert.rejects(() => store.commitEnvelope(root.candidateId, envelopeFor(root)), /TYPE_CONFLICT/);
    assert.equal(await redis.get(rootKey), rootBefore);
    assert.equal(await redis.get(PersonMemoryKeys.dispositionLineageBinding(root.ownerUserId, root.candidateId)), null);

    await redis.del(locatorKey);
    await store.commitEnvelope(root.candidateId, envelopeFor(root));
    const anchoredRoot = await store.getCandidateForOwner(root.ownerUserId, root.candidateId);
    const bindingKey = anchoredRoot.dispositionLineageBindingKey;
    const bindingBefore = await redis.get(bindingKey);
    const replacement = candidateInput({
      candidateId: 'person_candidate_anchor_guard_replacement',
      replacesProposalId: root.candidateId,
      targetPersonId: approved.receipt.personId,
      interactionDraft: undefined,
      remainingDraftIds: [claimDraft.draftId],
      createdAt: 301,
    });
    await store.stageCandidate(replacement);
    const replacementKey = PersonMemoryKeys.candidate(replacement.ownerUserId, replacement.candidateId);
    const replacementBefore = await redis.get(replacementKey);
    await redis.del(bindingKey);
    await redis.hset(bindingKey, 'wrong', 'type');
    await assert.rejects(
      () => store.commitEnvelope(replacement.candidateId, envelopeFor(replacement)),
      /binding conflict|WRONGTYPE/,
    );
    assert.equal(await redis.get(replacementKey), replacementBefore);
    assert.equal((await store.getCandidateForOwner(root.ownerUserId, root.candidateId)).state, 'pending_approval');
    assert.equal(await redis.type(bindingKey), 'hash');
    assert.notEqual(bindingBefore, null);
  });

  it('atomically records and hydrates a person-bound disposition without exposing F276 identity', async () => {
    const seed = await stageAndAnchor(
      candidateInput({
        candidateId: 'person_candidate_ledger_seed',
        interactionDraft: undefined,
        remainingDraftIds: [claimDraft.draftId],
      }),
    );
    const approved = await store.approveDrafts({
      ownerUserId: seed.ownerUserId,
      candidateId: seed.candidateId,
      selectedDraftIds: [claimDraft.draftId],
      decisionId: 'decision_ledger_seed',
      authorizedAt: 200,
    });
    const pending = candidateInput({
      candidateId: 'person_candidate_ledger_pending',
      targetPersonId: approved.receipt.personId,
      interactionDraft: undefined,
      remainingDraftIds: [claimDraft.draftId],
      createdAt: 300,
    });
    await stageAndAnchor(pending);

    const applied = await store.rejectCandidate({
      ownerUserId: pending.ownerUserId,
      candidateId: pending.candidateId,
      decisionId: 'decision_ledger_reject',
      feedback: { reasonCode: 'bad_evidence' },
      decidedAt: 400,
    });
    assert.equal(applied.outcome, 'applied');
    const entry = applied.candidate.humanDispositionLedgerEntry;
    assert.equal(entry.episode.subjectRef.startsWith('f281_lineage_'), true);
    assert.equal(entry.episode.sourceRef.startsWith('f281_receipt_'), true);
    assert.equal(entry.episode.feedback.reasonCode, 'bad_evidence');

    const receiptRaw = await redis.hget(HumanDispositionKeys.receipts(pending.ownerUserId), entry.episode.sourceRef);
    const receipt = JSON.parse(receiptRaw);
    assert.deepEqual(Object.keys(receipt).sort(), ['decidedAt', 'interactionKind', 'sourceRef', 'subjectRef']);
    const serializedReceipt = JSON.stringify(receipt);
    assert.equal(serializedReceipt.includes(pending.candidateId), false);
    assert.equal(serializedReceipt.includes(approved.receipt.personId), false);
    assert.equal(serializedReceipt.includes('bad_evidence'), false);
    assert.equal(await redis.ttl(HumanDispositionKeys.receipts(pending.ownerUserId)), -1);
    assert.equal(
      await redis.zscore(HumanDispositionKeys.episodes(pending.ownerUserId), entry.episode.sourceRef),
      '400',
    );
    assert.equal(
      await redis.zscore(
        HumanDispositionKeys.subject(pending.ownerUserId, entry.episode.subjectRef),
        entry.episode.sourceRef,
      ),
      '400',
    );

    const ledger = new HumanDispositionLedger(redis, new PersonMemoryDispositionProofResolver(redis));
    assert.deepEqual(await ledger.get(pending.ownerUserId, entry.episode.sourceRef), entry);
    assert.equal(await ledger.get('owner-2', entry.episode.sourceRef), null);
    assert.equal(
      (
        await store.rejectCandidate({
          ownerUserId: pending.ownerUserId,
          candidateId: pending.candidateId,
          decisionId: 'decision_ledger_reject',
          feedback: { reasonCode: 'bad_evidence' },
          decidedAt: 999,
        })
      ).outcome,
      'replayed',
    );
    assert.equal(
      (
        await store.rejectCandidate({
          ownerUserId: pending.ownerUserId,
          candidateId: pending.candidateId,
          decisionId: 'decision_ledger_changed',
          feedback: { reasonCode: 'wrong' },
          decidedAt: 999,
        })
      ).outcome,
      'conflict',
    );

    const candidateKey = PersonMemoryKeys.candidate(pending.ownerUserId, pending.candidateId);
    const candidateBeforeInvariantProbe = await redis.get(candidateKey);
    await redis.hdel(HumanDispositionKeys.receipts(pending.ownerUserId), entry.episode.sourceRef);
    assert.equal(
      (
        await store.rejectCandidate({
          ownerUserId: pending.ownerUserId,
          candidateId: pending.candidateId,
          decisionId: 'decision_ledger_reject',
          feedback: { reasonCode: 'bad_evidence' },
          decidedAt: 999,
        })
      ).outcome,
      'invariant_failure',
    );
    assert.equal(await redis.get(candidateKey), candidateBeforeInvariantProbe);
    await redis.hset(HumanDispositionKeys.receipts(pending.ownerUserId), entry.episode.sourceRef, receiptRaw);

    const bindingKey = applied.candidate.dispositionLineageBindingKey;
    const binding = JSON.parse(await redis.get(bindingKey));
    const lineageLocatorKey = PersonMemoryKeys.dispositionLineageHandleLocator(
      pending.ownerUserId,
      binding.opaqueLineageHandle,
    );
    const decisionLocatorKey = PersonMemoryKeys.dispositionDecisionReceiptLocator(
      pending.ownerUserId,
      entry.episode.sourceRef,
    );
    const lineageLocatorRaw = await redis.get(lineageLocatorKey);
    await redis.set(lineageLocatorKey, '{');
    await assert.rejects(
      () =>
        store.hardForget({
          ownerUserId: pending.ownerUserId,
          personId: approved.receipt.personId,
          requestId: 'person_forget_disposition_ledger',
          requestedAt: 1_000,
        }),
      /lineage locator/,
    );
    assert.equal(await redis.get(candidateKey), candidateBeforeInvariantProbe);
    assert.notEqual(await redis.get(bindingKey), null);
    assert.notEqual(await redis.get(decisionLocatorKey), null);
    assert.notEqual(
      await redis.hget(HumanDispositionKeys.receipts(pending.ownerUserId), entry.episode.sourceRef),
      null,
    );
    assert.equal(
      await redis.get(PersonMemoryKeys.forgetReceipt(pending.ownerUserId, 'person_forget_disposition_ledger')),
      null,
    );
    assert.equal(
      await redis.get(PersonMemoryKeys.forgetFence(pending.ownerUserId, approved.receipt.personId)),
      'person_forget_disposition_ledger',
    );
    await redis.set(lineageLocatorKey, lineageLocatorRaw);
    const deletion = await store.hardForget({
      ownerUserId: pending.ownerUserId,
      personId: approved.receipt.personId,
      requestId: 'person_forget_disposition_ledger',
      requestedAt: 1_000,
    });
    assert.equal(deletion.verdict, 'purged');
    assert.equal(await redis.get(bindingKey), null);
    assert.equal(await redis.get(lineageLocatorKey), null);
    assert.equal(await redis.get(decisionLocatorKey), null);
    assert.equal(await redis.hget(HumanDispositionKeys.receipts(pending.ownerUserId), entry.episode.sourceRef), null);
    assert.equal(await redis.zscore(HumanDispositionKeys.episodes(pending.ownerUserId), entry.episode.sourceRef), null);
    assert.equal(
      await redis.zscore(
        HumanDispositionKeys.subject(pending.ownerUserId, entry.episode.subjectRef),
        entry.episode.sourceRef,
      ),
      null,
    );
    assert.equal(await ledger.get(pending.ownerUserId, entry.episode.sourceRef), null);
  });

  it('records and hard-forgets a pure-unbound disposition through one exact proposal', async () => {
    const pending = await stageAndAnchor(
      candidateInput({
        candidateId: 'person_candidate_unbound_disposition',
        interactionDraft: undefined,
        remainingDraftIds: [claimDraft.draftId],
      }),
    );
    const applied = await store.rejectCandidate({
      ownerUserId: pending.ownerUserId,
      candidateId: pending.candidateId,
      decisionId: 'decision_unbound_disposition',
      feedback: { reasonCode: 'wrong_lane' },
      decidedAt: 500,
    });
    assert.equal(applied.outcome, 'applied');
    const entry = applied.candidate.humanDispositionLedgerEntry;
    assert.ok(entry);
    assert.equal(entry.episode.feedback.reasonCode, 'wrong_lane');
    assert.equal(entry.episode.subjectRef.startsWith('f281_lineage_'), true);
    assert.equal(applied.candidate.dispositionLineageBindingKey.endsWith(pending.candidateId), true);

    const ledger = new HumanDispositionLedger(redis, new PersonMemoryDispositionProofResolver(redis));
    assert.deepEqual(await ledger.get(pending.ownerUserId, entry.episode.sourceRef), entry);
    assert.equal(await ledger.get('owner-2', entry.episode.sourceRef), null);

    const foreign = await store.hardForgetProposal({
      ownerUserId: 'owner-2',
      proposalId: pending.candidateId,
      requestId: 'person_forget_proposal_foreign',
      requestedAt: 600,
    });
    assert.equal(foreign.outcome, 'already_absent');
    assert.notEqual(await store.getCandidateForOwner(pending.ownerUserId, pending.candidateId), null);

    const bindingKey = applied.candidate.dispositionLineageBindingKey;
    const binding = JSON.parse(await redis.get(bindingKey));
    const lineageLocatorKey = PersonMemoryKeys.dispositionLineageHandleLocator(
      pending.ownerUserId,
      binding.opaqueLineageHandle,
    );
    const decisionLocatorKey = PersonMemoryKeys.dispositionDecisionReceiptLocator(
      pending.ownerUserId,
      entry.episode.sourceRef,
    );
    const lineageLocatorRaw = await redis.get(lineageLocatorKey);
    const candidateRaw = await redis.get(PersonMemoryKeys.candidate(pending.ownerUserId, pending.candidateId));
    await redis.set(lineageLocatorKey, '{');
    await assert.rejects(
      () =>
        store.hardForgetProposal({
          ownerUserId: pending.ownerUserId,
          proposalId: pending.candidateId,
          requestId: 'person_forget_proposal_unbound',
          requestedAt: 600,
        }),
      /lineage locator/,
    );
    assert.equal(await redis.get(PersonMemoryKeys.candidate(pending.ownerUserId, pending.candidateId)), candidateRaw);
    assert.notEqual(
      await redis.hget(HumanDispositionKeys.receipts(pending.ownerUserId), entry.episode.sourceRef),
      null,
    );
    assert.equal(
      await redis.get(
        PersonMemoryKeys.proposalForgetReceipt(
          pending.ownerUserId,
          pending.candidateId,
          'person_forget_proposal_unbound',
        ),
      ),
      null,
    );
    await redis.set(lineageLocatorKey, lineageLocatorRaw);
    const forgotten = await store.hardForgetProposal({
      ownerUserId: pending.ownerUserId,
      proposalId: pending.candidateId,
      requestId: 'person_forget_proposal_unbound',
      requestedAt: 600,
    });
    assert.equal(forgotten.outcome, 'purged');
    assert.deepEqual(Object.keys(forgotten.receipt).sort(), [
      'completedAt',
      'ownerUserId',
      'purgedSurfaceCounts',
      'requestId',
      'verdict',
    ]);
    assert.equal(JSON.stringify(forgotten.receipt).includes(pending.candidateId), false);
    assert.equal(JSON.stringify(forgotten.receipt).includes('wrong_lane'), false);
    assert.equal(await store.getCandidateForOwner(pending.ownerUserId, pending.candidateId), null);
    assert.equal(await redis.get(PersonMemoryKeys.suppression(pending.ownerUserId, pending.candidateId)), null);
    assert.equal(await redis.get(bindingKey), null);
    assert.equal(await redis.get(lineageLocatorKey), null);
    assert.equal(await redis.get(decisionLocatorKey), null);
    assert.equal(await redis.hget(HumanDispositionKeys.receipts(pending.ownerUserId), entry.episode.sourceRef), null);
    assert.equal(await redis.zscore(HumanDispositionKeys.episodes(pending.ownerUserId), entry.episode.sourceRef), null);
    assert.equal(
      await redis.zscore(
        HumanDispositionKeys.subject(pending.ownerUserId, entry.episode.subjectRef),
        entry.episode.sourceRef,
      ),
      null,
    );
    assert.equal(await ledger.get(pending.ownerUserId, entry.episode.sourceRef), null);

    const replayed = await store.hardForgetProposal({
      ownerUserId: pending.ownerUserId,
      proposalId: pending.candidateId,
      requestId: 'person_forget_proposal_unbound',
      requestedAt: 999,
    });
    assert.deepEqual(replayed, forgotten);
  });

  const exactProposalWrongTypeCases = [
    {
      name: 'suppression subject SET',
      key: ({ ownerUserId, subjectRef }) => PersonMemoryKeys.suppressionSubject(ownerUserId, subjectRef),
      poison: async (key) => {
        await redis.del(key);
        await redis.set(key, 'wrong-type-string');
      },
    },
    {
      name: 'pending ZSET',
      key: ({ ownerUserId }) => PersonMemoryKeys.pending(ownerUserId),
      poison: async (key) => {
        await redis.del(key);
        await redis.set(key, 'wrong-type-string');
      },
    },
    {
      name: 'candidate-person STRING',
      key: ({ ownerUserId, candidateId }) => PersonMemoryKeys.candidatePerson(ownerUserId, candidateId),
      poison: async (key) => {
        await redis.hset(key, 'unexpected', 'value');
      },
    },
    {
      name: 'candidate-decisions SET',
      key: ({ ownerUserId, candidateId }) => PersonMemoryKeys.candidateDecisions(ownerUserId, candidateId),
      poison: async (key) => {
        await redis.hset(key, 'unexpected', 'value');
      },
    },
    {
      name: 'F281 receipt HASH',
      key: ({ ownerUserId }) => HumanDispositionKeys.receipts(ownerUserId),
      poison: async (key) => {
        await redis.del(key);
        await redis.set(key, 'wrong-type-string');
      },
    },
    {
      name: 'F281 owner index ZSET',
      key: ({ ownerUserId }) => HumanDispositionKeys.episodes(ownerUserId),
      poison: async (key) => {
        await redis.del(key);
        await redis.set(key, 'wrong-type-string');
      },
    },
    {
      name: 'F281 subject index ZSET',
      key: ({ ownerUserId, entry }) => HumanDispositionKeys.subject(ownerUserId, entry.episode.subjectRef),
      poison: async (key) => {
        await redis.del(key);
        await redis.set(key, 'wrong-type-string');
      },
    },
    {
      name: 'candidate-owner STRING',
      key: ({ candidateId }) => PersonMemoryKeys.candidateOwner(candidateId),
      poison: async (key) => {
        await redis.del(key);
        await redis.hset(key, 'unexpected', 'value');
      },
    },
  ];

  for (const wrongTypeCase of exactProposalWrongTypeCases) {
    it(`keeps exact-proposal purge byte-atomic when ${wrongTypeCase.name} has the wrong type`, async () => {
      const suffix = wrongTypeCase.name.replaceAll(/[^A-Za-z]+/g, '_').toLowerCase();
      const pending = await stageAndAnchor(
        candidateInput({
          candidateId: `person_candidate_unbound_type_${suffix}`,
          interactionDraft: undefined,
          remainingDraftIds: [claimDraft.draftId],
        }),
      );
      const applied = await store.rejectCandidate({
        ownerUserId: pending.ownerUserId,
        candidateId: pending.candidateId,
        decisionId: `decision_unbound_type_${suffix}`,
        feedback: { reasonCode: 'wrong_lane' },
        decidedAt: 500,
      });
      assert.equal(applied.outcome, 'applied');
      const entry = applied.candidate.humanDispositionLedgerEntry;
      assert.ok(entry);
      const bindingKey = applied.candidate.dispositionLineageBindingKey;
      const binding = JSON.parse(await redis.get(bindingKey));
      const lineageLocatorKey = PersonMemoryKeys.dispositionLineageHandleLocator(
        pending.ownerUserId,
        binding.opaqueLineageHandle,
      );
      const decisionLocatorKey = PersonMemoryKeys.dispositionDecisionReceiptLocator(
        pending.ownerUserId,
        entry.episode.sourceRef,
      );
      const suppressionRaw = await redis.get(PersonMemoryKeys.suppression(pending.ownerUserId, pending.candidateId));
      const suppression = JSON.parse(suppressionRaw);
      const subjectRef = suppression.subjectRefs[0];
      assert.equal(typeof subjectRef, 'string');
      const context = {
        ownerUserId: pending.ownerUserId,
        candidateId: pending.candidateId,
        entry,
        subjectRef,
      };
      const poisonedKey = wrongTypeCase.key(context);
      await wrongTypeCase.poison(poisonedKey);

      const resultReceiptKey = PersonMemoryKeys.proposalForgetReceipt(
        pending.ownerUserId,
        pending.candidateId,
        `person_forget_proposal_type_${suffix}`,
      );
      const protectedKeys = [
        PersonMemoryKeys.candidate(pending.ownerUserId, pending.candidateId),
        PersonMemoryKeys.candidateOwner(pending.candidateId),
        PersonMemoryKeys.candidatePerson(pending.ownerUserId, pending.candidateId),
        PersonMemoryKeys.candidateDecisions(pending.ownerUserId, pending.candidateId),
        PersonMemoryKeys.pending(pending.ownerUserId),
        PersonMemoryKeys.suppression(pending.ownerUserId, pending.candidateId),
        PersonMemoryKeys.suppressionSubject(pending.ownerUserId, subjectRef),
        bindingKey,
        lineageLocatorKey,
        decisionLocatorKey,
        HumanDispositionKeys.receipts(pending.ownerUserId),
        HumanDispositionKeys.episodes(pending.ownerUserId),
        HumanDispositionKeys.subject(pending.ownerUserId, entry.episode.subjectRef),
        resultReceiptKey,
      ];
      const before = await snapshotRedisBytes(protectedKeys);
      let result;
      let failure;
      try {
        result = await store.hardForgetProposal({
          ownerUserId: pending.ownerUserId,
          proposalId: pending.candidateId,
          requestId: `person_forget_proposal_type_${suffix}`,
          requestedAt: 600,
        });
      } catch (error) {
        failure = error;
      }
      if (result) {
        assert.equal(result.outcome, 'conflict');
      } else {
        assert.match(String(failure), /WRONGTYPE|type|invariant/i);
      }
      assert.deepEqual(await snapshotRedisBytes(protectedKeys), before);
    });
  }

  it('purges a pre-Phase-C unbound rejection without synthetic ledger backfill', async () => {
    const pending = await stageAndAnchor(
      candidateInput({
        candidateId: 'person_candidate_unbound_legacy_forget',
        interactionDraft: undefined,
        remainingDraftIds: [claimDraft.draftId],
      }),
    );
    const candidateKey = PersonMemoryKeys.candidate(pending.ownerUserId, pending.candidateId);
    const legacy = JSON.parse(await redis.get(candidateKey));
    legacy.state = 'rejected';
    legacy.claimDrafts = [];
    legacy.remainingDraftIds = [];
    legacy.latestDecisionId = 'decision_unbound_legacy_forget';
    legacy.latestHumanDisposition = { reasonCode: 'wrong' };
    delete legacy.personDraft;
    delete legacy.sourceBundle;
    await redis.set(candidateKey, JSON.stringify(legacy));
    await redis.zrem(PersonMemoryKeys.pending(pending.ownerUserId), pending.candidateId);
    const suppression = {
      tokenId: 'person_suppression_unbound_legacy_forget',
      ownerUserId: pending.ownerUserId,
      candidateId: pending.candidateId,
      subjectRefs: ['黄挺'],
      createdAt: 300,
    };
    await redis.set(
      PersonMemoryKeys.suppression(pending.ownerUserId, pending.candidateId),
      JSON.stringify(suppression),
    );
    await redis.sadd(PersonMemoryKeys.suppressionSubject(pending.ownerUserId, '黄挺'), pending.candidateId);

    assert.equal(
      (
        await store.rejectCandidate({
          ownerUserId: pending.ownerUserId,
          candidateId: pending.candidateId,
          decisionId: 'decision_unbound_legacy_forget',
          feedback: { reasonCode: 'wrong' },
          decidedAt: 400,
        })
      ).outcome,
      'legacy_disposition_unmigrated',
    );
    assert.deepEqual(await redis.hgetall(HumanDispositionKeys.receipts(pending.ownerUserId)), {});

    const forgotten = await store.hardForgetProposal({
      ownerUserId: pending.ownerUserId,
      proposalId: pending.candidateId,
      requestId: 'person_forget_proposal_unbound_legacy',
      requestedAt: 500,
    });
    assert.equal(forgotten.outcome, 'purged');
    assert.equal(forgotten.receipt.purgedSurfaceCounts.dispositionEntries, 0);
    assert.equal(await redis.get(candidateKey), null);
    assert.equal(await redis.get(PersonMemoryKeys.suppression(pending.ownerUserId, pending.candidateId)), null);
    assert.equal(
      await redis.sismember(PersonMemoryKeys.suppressionSubject(pending.ownerUserId, '黄挺'), pending.candidateId),
      0,
    );
  });

  it('purges a pure-unbound replacement chain from an exact ancestor proposal', async () => {
    const root = await stageAndAnchor(
      candidateInput({
        candidateId: 'person_candidate_unbound_chain_root',
        interactionDraft: undefined,
        remainingDraftIds: [claimDraft.draftId],
      }),
    );
    const successor = candidateInput({
      candidateId: 'person_candidate_unbound_chain_successor',
      replacesProposalId: root.candidateId,
      interactionDraft: undefined,
      remainingDraftIds: [claimDraft.draftId],
      createdAt: 301,
    });
    await store.stageCandidate(successor);
    await store.commitEnvelope(successor.candidateId, envelopeFor(successor));
    assert.equal((await store.getCandidateForOwner(root.ownerUserId, root.candidateId)).state, 'withdrawn');

    const rejected = await store.rejectCandidate({
      ownerUserId: successor.ownerUserId,
      candidateId: successor.candidateId,
      decisionId: 'decision_unbound_chain',
      feedback: { reasonCode: 'not_important' },
      decidedAt: 400,
    });
    assert.equal(rejected.outcome, 'applied');
    assert.ok(rejected.candidate.humanDispositionLedgerEntry);

    const forgotten = await store.hardForgetProposal({
      ownerUserId: root.ownerUserId,
      proposalId: root.candidateId,
      requestId: 'person_forget_proposal_unbound_chain',
      requestedAt: 500,
    });
    assert.equal(forgotten.outcome, 'purged');
    assert.equal(forgotten.receipt.purgedSurfaceCounts.candidates, 2);
    assert.equal(await store.getCandidateForOwner(root.ownerUserId, root.candidateId), null);
    assert.equal(await store.getCandidateForOwner(successor.ownerUserId, successor.candidateId), null);
  });

  it('purges a linked deferred receipt when hard-forgetting its materialized person', async () => {
    const receiptId = `deferred_person_${'f'.repeat(32)}`;
    const { receiptStore, receipt } = await stageDeferredReceipt(receiptId);
    const lineage = await claimDeferredReceiptForProposal(receiptStore, receipt, 'claim-deferred-person-forget');
    const input = await stageAndAnchor(
      candidateInput({
        candidateId: 'person_candidate_deferred_person_forget',
        ...lineage,
        interactionDraft: undefined,
        remainingDraftIds: [claimDraft.draftId],
      }),
    );
    const approved = await store.approveDrafts({
      ownerUserId: input.ownerUserId,
      candidateId: input.candidateId,
      selectedDraftIds: [claimDraft.draftId],
      decisionId: 'decision_deferred_person_forget',
      authorizedAt: 200,
    });

    await store.hardForget({
      ownerUserId: input.ownerUserId,
      personId: approved.receipt.personId,
      requestId: 'person_forget_deferred_receipt',
      requestedAt: 500,
    });

    assert.equal(await receiptStore.get(input.ownerUserId, receiptId), null);
  });

  it('purges an actionable deferred receipt bound to the person before any proposal exists', async () => {
    const input = await stageAndAnchor(
      candidateInput({
        candidateId: 'person_candidate_deferred_preproposal_forget',
        interactionDraft: undefined,
        remainingDraftIds: [claimDraft.draftId],
      }),
    );
    const approved = await store.approveDrafts({
      ownerUserId: input.ownerUserId,
      candidateId: input.candidateId,
      selectedDraftIds: [claimDraft.draftId],
      decisionId: 'decision_deferred_preproposal_forget',
      authorizedAt: 200,
    });
    const receiptId = `deferred_person_${'b'.repeat(32)}`;
    const { receiptStore } = await stageDeferredReceipt(receiptId, {
      registryBinding: { kind: 'registered_person', ref: approved.receipt.personId },
      createdAt: 300,
    });

    const forgotten = await store.hardForget({
      ownerUserId: input.ownerUserId,
      personId: approved.receipt.personId,
      requestId: 'person_forget_deferred_preproposal_receipt',
      requestedAt: 500,
    });

    assert.equal(forgotten.verdict, 'purged');
    assert.equal(forgotten.purgedSurfaceCounts.deferredReceipts, 1);
    assert.equal(await receiptStore.get(input.ownerUserId, receiptId), null);
  });

  it('purges an actionable deferred receipt bound through the person workspace Entity', async () => {
    const entityRef = 'person:huang-ting-huawei';
    const input = await stageAndAnchor(
      candidateInput({
        candidateId: 'person_candidate_deferred_entity_preproposal_forget',
        personDraft: {
          displayName: '黄挺',
          privateAliases: ['黄挺'],
          workspaceEntityLink: { entityRef, state: 'linked', checkedAt: 150 },
        },
        interactionDraft: undefined,
        remainingDraftIds: [claimDraft.draftId],
      }),
    );
    const approved = await store.approveDrafts({
      ownerUserId: input.ownerUserId,
      candidateId: input.candidateId,
      selectedDraftIds: [claimDraft.draftId],
      decisionId: 'decision_deferred_entity_preproposal_forget',
      authorizedAt: 200,
    });
    const receiptId = `deferred_person_${'c'.repeat(32)}`;
    const { receiptStore } = await stageDeferredReceipt(receiptId, {
      registryBinding: { kind: 'registered_entity', ref: entityRef },
      createdAt: 300,
    });

    const forgotten = await store.hardForget({
      ownerUserId: input.ownerUserId,
      personId: approved.receipt.personId,
      requestId: 'person_forget_deferred_entity_preproposal_receipt',
      requestedAt: 500,
    });

    assert.equal(forgotten.purgedSurfaceCounts.deferredReceipts, 1);
    assert.equal(await receiptStore.get(input.ownerUserId, receiptId), null);
  });

  it('purges a deferred receipt by exact registered person ID even if canonical person truth is already absent', async () => {
    const personId = 'person_already_absent_with_deferred_receipt';
    const receiptId = `deferred_person_${'1'.repeat(32)}`;
    const { receiptStore } = await stageDeferredReceipt(receiptId, {
      registryBinding: { kind: 'registered_person', ref: personId },
    });

    const forgotten = await store.hardForget({
      ownerUserId: 'owner-1',
      personId,
      requestId: 'person_forget_absent_with_deferred_receipt',
      requestedAt: 500,
    });

    assert.equal(forgotten.verdict, 'purged');
    assert.equal(forgotten.purgedSurfaceCounts.deferredReceipts, 1);
    assert.equal(await receiptStore.get('owner-1', receiptId), null);
  });

  it('preflights deferred receipt indexes before any person hard-forget mutation', async () => {
    const receiptId = `deferred_person_${'d'.repeat(32)}`;
    const { receiptStore, receipt } = await stageDeferredReceipt(receiptId);
    const lineage = await claimDeferredReceiptForProposal(receiptStore, receipt, 'claim-deferred-forget-preflight');
    const input = await stageAndAnchor(
      candidateInput({
        candidateId: 'person_candidate_deferred_forget_preflight',
        ...lineage,
        interactionDraft: undefined,
        remainingDraftIds: [claimDraft.draftId],
      }),
    );
    const approved = await store.approveDrafts({
      ownerUserId: input.ownerUserId,
      candidateId: input.candidateId,
      selectedDraftIds: [claimDraft.draftId],
      decisionId: 'decision_deferred_forget_preflight',
      authorizedAt: 200,
    });
    const dedupeKey = receiptStore.keys.dedupe(input.ownerUserId, receipt.dedupeHash);
    await redis.del(dedupeKey);
    await redis.hset(dedupeKey, 'poisoned', 'wrong-type');

    await assert.rejects(
      store.hardForget({
        ownerUserId: input.ownerUserId,
        personId: approved.receipt.personId,
        requestId: 'person_forget_deferred_preflight',
        requestedAt: 500,
      }),
    );

    assert.notEqual(await store.getPerson(input.ownerUserId, approved.receipt.personId), null);
    assert.notEqual(await store.getCandidateForOwner(input.ownerUserId, input.candidateId), null);
    assert.notEqual(await receiptStore.get(input.ownerUserId, receiptId), null);
  });

  it('purges a proposed deferred receipt with its exact unbound proposal', async () => {
    const receiptId = `deferred_person_${'e'.repeat(32)}`;
    const { receiptStore, receipt } = await stageDeferredReceipt(receiptId);
    const proposalId = 'person_candidate_deferred_proposal_forget';
    const lineage = await claimDeferredReceiptForProposal(receiptStore, receipt, 'claim-deferred-proposal-forget');
    const input = await stageAndAnchor(
      candidateInput({
        candidateId: proposalId,
        ...lineage,
        interactionDraft: undefined,
        remainingDraftIds: [claimDraft.draftId],
      }),
    );
    assert.equal(
      (
        await store.rejectCandidate({
          ownerUserId: input.ownerUserId,
          candidateId: input.candidateId,
          decisionId: 'decision_deferred_proposal_forget',
          feedback: { reasonCode: 'wrong' },
          decidedAt: 300,
        })
      ).outcome,
      'applied',
    );

    assert.equal(
      (
        await store.hardForgetProposal({
          ownerUserId: input.ownerUserId,
          proposalId,
          requestId: 'person_forget_proposal_deferred_receipt',
          requestedAt: 500,
        })
      ).outcome,
      'purged',
    );
    assert.equal(await receiptStore.get(input.ownerUserId, receiptId), null);
  });

  it('preflights deferred receipt indexes before any exact proposal hard-forget mutation', async () => {
    const receiptId = `deferred_person_${'2'.repeat(32)}`;
    const { receiptStore, receipt } = await stageDeferredReceipt(receiptId);
    const proposalId = 'person_candidate_deferred_proposal_preflight';
    const lineage = await claimDeferredReceiptForProposal(receiptStore, receipt, 'claim-deferred-proposal-preflight');
    const input = await stageAndAnchor(
      candidateInput({
        candidateId: proposalId,
        ...lineage,
        interactionDraft: undefined,
        remainingDraftIds: [claimDraft.draftId],
      }),
    );
    await store.rejectCandidate({
      ownerUserId: input.ownerUserId,
      candidateId: input.candidateId,
      decisionId: 'decision_deferred_proposal_preflight',
      feedback: { reasonCode: 'wrong' },
      decidedAt: 300,
    });
    const dedupeKey = receiptStore.keys.dedupe(input.ownerUserId, receipt.dedupeHash);
    await redis.del(dedupeKey);
    await redis.hset(dedupeKey, 'poisoned', 'wrong-type');

    const forgotten = await store.hardForgetProposal({
      ownerUserId: input.ownerUserId,
      proposalId,
      requestId: 'person_forget_proposal_deferred_preflight',
      requestedAt: 500,
    });

    assert.equal(forgotten.outcome, 'conflict');
    assert.notEqual(await store.getCandidateForOwner(input.ownerUserId, proposalId), null);
    assert.notEqual(await receiptStore.get(input.ownerUserId, receiptId), null);
  });

  it('fails an unbound lineage-handle collision before producer or F281 mutation', async () => {
    const fixedRandom = (size) => new Uint8Array(size).fill(17);
    store = new RedisPersonMemoryStore(redis, { humanDispositionRandomBytesSource: fixedRandom });
    const first = await stageAndAnchor(
      candidateInput({
        candidateId: 'person_candidate_unbound_collision_first',
        interactionDraft: undefined,
        remainingDraftIds: [claimDraft.draftId],
      }),
    );
    const firstRejected = await store.rejectCandidate({
      ownerUserId: first.ownerUserId,
      candidateId: first.candidateId,
      decisionId: 'decision_unbound_collision_first',
      feedback: { reasonCode: 'wrong' },
      decidedAt: 400,
    });
    assert.equal(firstRejected.outcome, 'applied');

    const second = await stageAndAnchor(
      candidateInput({
        candidateId: 'person_candidate_unbound_collision_second',
        interactionDraft: undefined,
        remainingDraftIds: [claimDraft.draftId],
        createdAt: 401,
      }),
    );
    const secondKey = PersonMemoryKeys.candidate(second.ownerUserId, second.candidateId);
    const secondBefore = await redis.get(secondKey);
    const receiptsBefore = await redis.hgetall(HumanDispositionKeys.receipts(second.ownerUserId));
    const secondResult = await store.rejectCandidate({
      ownerUserId: second.ownerUserId,
      candidateId: second.candidateId,
      decisionId: 'decision_unbound_collision_second',
      feedback: { reasonCode: 'wrong_lane' },
      decidedAt: 500,
    });
    assert.equal(secondResult.outcome, 'conflict');
    assert.equal(await redis.get(secondKey), secondBefore);
    assert.deepEqual(await redis.hgetall(HumanDispositionKeys.receipts(second.ownerUserId)), receiptsBefore);
    assert.equal(
      await redis.get(PersonMemoryKeys.dispositionLineageBinding(second.ownerUserId, second.candidateId)),
      null,
    );
  });

  it('refuses exact-proposal forget for a person-bound lineage', async () => {
    const seed = await stageAndAnchor(
      candidateInput({
        candidateId: 'person_candidate_proposal_forget_bound_seed',
        interactionDraft: undefined,
        remainingDraftIds: [claimDraft.draftId],
      }),
    );
    const approved = await store.approveDrafts({
      ownerUserId: seed.ownerUserId,
      candidateId: seed.candidateId,
      selectedDraftIds: [claimDraft.draftId],
      decisionId: 'decision_proposal_forget_bound_seed',
      authorizedAt: 200,
    });
    const pending = await stageAndAnchor(
      candidateInput({
        candidateId: 'person_candidate_proposal_forget_bound',
        targetPersonId: approved.receipt.personId,
        interactionDraft: undefined,
        remainingDraftIds: [claimDraft.draftId],
        createdAt: 300,
      }),
    );
    const rejected = await store.rejectCandidate({
      ownerUserId: pending.ownerUserId,
      candidateId: pending.candidateId,
      decisionId: 'decision_proposal_forget_bound',
      feedback: { reasonCode: 'bad_evidence' },
      decidedAt: 400,
    });
    assert.equal(rejected.outcome, 'applied');
    const candidateBefore = await redis.get(PersonMemoryKeys.candidate(pending.ownerUserId, pending.candidateId));

    assert.deepEqual(
      await store.hardForgetProposal({
        ownerUserId: pending.ownerUserId,
        proposalId: pending.candidateId,
        requestId: 'person_forget_proposal_bound',
        requestedAt: 500,
      }),
      { outcome: 'person_bound' },
    );
    assert.equal(
      await redis.get(PersonMemoryKeys.candidate(pending.ownerUserId, pending.candidateId)),
      candidateBefore,
    );
  });

  it('keeps an unbound-root to bound-successor lineage outside Phase C', async () => {
    const personSeed = await stageAndAnchor(
      candidateInput({
        candidateId: 'person_candidate_mixed_seed',
        interactionDraft: undefined,
        remainingDraftIds: [claimDraft.draftId],
      }),
    );
    const approved = await store.approveDrafts({
      ownerUserId: personSeed.ownerUserId,
      candidateId: personSeed.candidateId,
      selectedDraftIds: [claimDraft.draftId],
      decisionId: 'decision_mixed_seed',
      authorizedAt: 200,
    });
    const unboundRoot = await stageAndAnchor(
      candidateInput({
        candidateId: 'person_candidate_mixed_unbound_root',
        interactionDraft: undefined,
        remainingDraftIds: [claimDraft.draftId],
        createdAt: 300,
      }),
    );
    const successor = candidateInput({
      candidateId: 'person_candidate_mixed_bound_successor',
      replacesProposalId: unboundRoot.candidateId,
      targetPersonId: approved.receipt.personId,
      interactionDraft: undefined,
      remainingDraftIds: [claimDraft.draftId],
      createdAt: 301,
    });
    await store.stageCandidate(successor);
    await store.commitEnvelope(successor.candidateId, envelopeFor(successor));
    const anchored = await store.getCandidateForOwner(successor.ownerUserId, successor.candidateId);
    assert.equal(anchored.dispositionLineageBindingKey, undefined);
    const rejected = await store.rejectCandidate({
      ownerUserId: successor.ownerUserId,
      candidateId: successor.candidateId,
      decisionId: 'decision_mixed_successor',
      feedback: { reasonCode: 'wrong' },
      decidedAt: 400,
    });
    assert.equal(rejected.outcome, 'applied');
    assert.equal(rejected.candidate.humanDispositionLedgerEntry, undefined);
    assert.deepEqual(await redis.hgetall(HumanDispositionKeys.receipts(successor.ownerUserId)), {});
  });

  it('fails a person-bound disposition before mutation on poisoned F281 or locator state', async () => {
    const seed = await stageAndAnchor(
      candidateInput({
        candidateId: 'person_candidate_poison_seed',
        interactionDraft: undefined,
        remainingDraftIds: [claimDraft.draftId],
      }),
    );
    const approved = await store.approveDrafts({
      ownerUserId: seed.ownerUserId,
      candidateId: seed.candidateId,
      selectedDraftIds: [claimDraft.draftId],
      decisionId: 'decision_poison_seed',
      authorizedAt: 200,
    });
    const fixedRandom = (size) => new Uint8Array(size).fill(9);
    store = new RedisPersonMemoryStore(redis, { humanDispositionRandomBytesSource: fixedRandom });
    const pending = candidateInput({
      candidateId: 'person_candidate_poison_pending',
      targetPersonId: approved.receipt.personId,
      interactionDraft: undefined,
      remainingDraftIds: [claimDraft.draftId],
      createdAt: 300,
    });
    await stageAndAnchor(pending);
    const candidateKey = PersonMemoryKeys.candidate(pending.ownerUserId, pending.candidateId);
    const candidateBefore = await redis.get(candidateKey);
    const pendingBefore = await redis.zrange(HumanDispositionKeys.episodes(pending.ownerUserId), 0, -1);
    await redis.set(HumanDispositionKeys.receipts(pending.ownerUserId), 'wrong-type');
    await assert.rejects(
      () =>
        store.rejectCandidate({
          ownerUserId: pending.ownerUserId,
          candidateId: pending.candidateId,
          decisionId: 'decision_poison_receipts',
          feedback: { reasonCode: 'wrong' },
          decidedAt: 400,
        }),
      /TYPE_CONFLICT/,
    );
    assert.equal(await redis.get(candidateKey), candidateBefore);
    assert.deepEqual(await redis.zrange(HumanDispositionKeys.episodes(pending.ownerUserId), 0, -1), pendingBefore);
    assert.equal(await redis.get(PersonMemoryKeys.suppression(pending.ownerUserId, pending.candidateId)), null);

    await redis.del(HumanDispositionKeys.receipts(pending.ownerUserId));
    const receiptHandle = `f281_receipt_${Buffer.from(new Uint8Array(32).fill(9)).toString('base64url')}`;
    const receiptLocatorKey = PersonMemoryKeys.dispositionDecisionReceiptLocator(pending.ownerUserId, receiptHandle);
    await redis.set(receiptLocatorKey, 'occupied-by-another-decision');
    assert.equal(
      (
        await store.rejectCandidate({
          ownerUserId: pending.ownerUserId,
          candidateId: pending.candidateId,
          decisionId: 'decision_poison_locator',
          feedback: { reasonCode: 'wrong' },
          decidedAt: 401,
        })
      ).outcome,
      'conflict',
    );
    assert.equal(await redis.get(candidateKey), candidateBefore);
    assert.equal(await redis.get(receiptLocatorKey), 'occupied-by-another-decision');
  });

  it('keeps producer and ledger truth byte-equal across the reject key-type matrix', async () => {
    const poisonCases = [
      {
        name: 'pending zset',
        key: ({ ownerUserId }) => PersonMemoryKeys.pending(ownerUserId),
        poison: (key) => redis.set(key, 'wrong-type'),
        type: 'string',
      },
      {
        name: 'suppression string',
        key: ({ ownerUserId, candidateId }) => PersonMemoryKeys.suppression(ownerUserId, candidateId),
        poison: (key) => redis.hset(key, 'bad', 'type'),
        type: 'hash',
      },
      {
        name: 'hard-forget fence',
        key: ({ ownerUserId, personId }) => PersonMemoryKeys.forgetFence(ownerUserId, personId),
        poison: (key) => redis.sadd(key, 'wrong-type'),
        type: 'set',
      },
      {
        name: 'receipt hash',
        key: ({ ownerUserId }) => HumanDispositionKeys.receipts(ownerUserId),
        poison: (key) => redis.set(key, 'wrong-type'),
        type: 'string',
      },
      {
        name: 'owner index',
        key: ({ ownerUserId }) => HumanDispositionKeys.episodes(ownerUserId),
        poison: (key) => redis.set(key, 'wrong-type'),
        type: 'string',
      },
      {
        name: 'subject index',
        key: ({ ownerUserId, subjectRef }) => HumanDispositionKeys.subject(ownerUserId, subjectRef),
        poison: (key) => redis.set(key, 'wrong-type'),
        type: 'string',
      },
      {
        name: 'suppression subject registry',
        key: ({ ownerUserId }) => PersonMemoryKeys.suppressionSubject(ownerUserId, '黄挺'),
        poison: (key) => redis.set(key, 'wrong-type'),
        type: 'string',
      },
      {
        name: 'decision locator',
        key: ({ ownerUserId, receiptHandle }) =>
          PersonMemoryKeys.dispositionDecisionReceiptLocator(ownerUserId, receiptHandle),
        poison: (key) => redis.sadd(key, 'wrong-type'),
        type: 'set',
      },
    ];

    for (const [index, poisonCase] of poisonCases.entries()) {
      await cleanupClientKeyspace(redis);
      const fixedRandom = (size) => new Uint8Array(size).fill(30 + index);
      store = new RedisPersonMemoryStore(redis, { humanDispositionRandomBytesSource: fixedRandom });
      const seed = await stageAndAnchor(
        candidateInput({
          candidateId: `person_candidate_matrix_seed_${index}`,
          interactionDraft: undefined,
          remainingDraftIds: [claimDraft.draftId],
        }),
      );
      const approved = await store.approveDrafts({
        ownerUserId: seed.ownerUserId,
        candidateId: seed.candidateId,
        selectedDraftIds: [claimDraft.draftId],
        decisionId: `decision_matrix_seed_${index}`,
        authorizedAt: 200,
      });
      const pending = candidateInput({
        candidateId: `person_candidate_matrix_pending_${index}`,
        targetPersonId: approved.receipt.personId,
        interactionDraft: undefined,
        remainingDraftIds: [claimDraft.draftId],
        createdAt: 300,
      });
      await stageAndAnchor(pending);
      const candidateKey = PersonMemoryKeys.candidate(pending.ownerUserId, pending.candidateId);
      const candidateBefore = await redis.get(candidateKey);
      const anchored = JSON.parse(candidateBefore);
      const binding = JSON.parse(await redis.get(anchored.dispositionLineageBindingKey));
      const subjectRef = binding.opaqueLineageHandle;
      const receiptHandle = `f281_receipt_${Buffer.from(new Uint8Array(32).fill(30 + index)).toString('base64url')}`;
      const poisonKey = poisonCase.key({
        ownerUserId: pending.ownerUserId,
        candidateId: pending.candidateId,
        personId: approved.receipt.personId,
        subjectRef,
        receiptHandle,
      });
      await poisonCase.poison(poisonKey);

      const result = await store
        .rejectCandidate({
          ownerUserId: pending.ownerUserId,
          candidateId: pending.candidateId,
          decisionId: `decision_matrix_reject_${index}`,
          feedback: { reasonCode: 'wrong' },
          decidedAt: 400,
        })
        .catch((error) => ({ outcome: 'error', error }));
      assert.equal(
        result.outcome === 'applied' || result.outcome === 'replayed',
        false,
        `${poisonCase.name} must fail closed`,
      );
      assert.equal(await redis.get(candidateKey), candidateBefore);
      assert.equal(await redis.type(poisonKey), poisonCase.type);
      assert.equal(
        await redis.type(PersonMemoryKeys.suppression(pending.ownerUserId, pending.candidateId)),
        poisonCase.name === 'suppression string' ? 'hash' : 'none',
      );
    }
  });

  it('fails closed for a legacy person-bound terminal without a ledger pair', async () => {
    const seed = await stageAndAnchor(
      candidateInput({
        candidateId: 'person_candidate_legacy_bound_seed',
        interactionDraft: undefined,
        remainingDraftIds: [claimDraft.draftId],
      }),
    );
    const approved = await store.approveDrafts({
      ownerUserId: seed.ownerUserId,
      candidateId: seed.candidateId,
      selectedDraftIds: [claimDraft.draftId],
      decisionId: 'decision_legacy_bound_seed',
      authorizedAt: 200,
    });
    const pending = candidateInput({
      candidateId: 'person_candidate_legacy_bound',
      targetPersonId: approved.receipt.personId,
      interactionDraft: undefined,
      remainingDraftIds: [claimDraft.draftId],
      createdAt: 300,
    });
    await stageAndAnchor(pending);
    const candidateKey = PersonMemoryKeys.candidate(pending.ownerUserId, pending.candidateId);
    const current = JSON.parse(await redis.get(candidateKey));
    const bindingKey = current.dispositionLineageBindingKey;
    const binding = JSON.parse(await redis.get(bindingKey));
    const locatorKey = PersonMemoryKeys.dispositionLineageHandleLocator(
      pending.ownerUserId,
      binding.opaqueLineageHandle,
    );
    delete current.dispositionLineageBindingKey;
    current.state = 'rejected';
    current.claimDrafts = [];
    current.remainingDraftIds = [];
    delete current.personDraft;
    delete current.sourceBundle;
    await redis.set(candidateKey, JSON.stringify(current));
    await redis.zrem(PersonMemoryKeys.pending(pending.ownerUserId), pending.candidateId);
    await redis.del(bindingKey, locatorKey);
    await redis.srem(
      PersonMemoryKeys.personArtifacts(pending.ownerUserId, approved.receipt.personId),
      `${KEY_PREFIX}${bindingKey}`,
      `${KEY_PREFIX}${locatorKey}`,
    );

    assert.equal(
      (
        await store.rejectCandidate({
          ownerUserId: pending.ownerUserId,
          candidateId: pending.candidateId,
          decisionId: 'decision_legacy_bound_retry',
          decidedAt: 400,
        })
      ).outcome,
      'legacy_disposition_unmigrated',
    );
    assert.equal(await redis.get(candidateKey), JSON.stringify(current));
    assert.deepEqual(await redis.hgetall(HumanDispositionKeys.receipts(pending.ownerUserId)), {});
  });

  it('withdraws a pending proposal without creating a suppression token', async () => {
    const input = await stageAndAnchor(
      candidateInput({
        candidateId: 'person_candidate_withdraw_pending',
        interactionDraft: undefined,
        remainingDraftIds: [claimDraft.draftId],
      }),
    );

    const withdrawn = await store.withdrawCandidate(input.ownerUserId, input.candidateId, 300);
    assert.equal(withdrawn.state, 'withdrawn');
    assert.equal(withdrawn.personDraft, undefined);
    assert.deepEqual(withdrawn.claimDrafts, []);
    assert.deepEqual(withdrawn.remainingDraftIds, []);
    assert.equal(withdrawn.sourceBundle, undefined);
    assert.deepEqual(await store.listPending(input.ownerUserId), []);
    assert.equal(await redis.get(PersonMemoryKeys.suppression(input.ownerUserId, input.candidateId)), null);
    assert.equal(await store.resolveDormantCandidateBySubject(input.ownerUserId, '黄挺'), null);
    assert.equal(
      (
        await store.rejectCandidate({
          ownerUserId: input.ownerUserId,
          candidateId: input.candidateId,
          decisionId: 'decision_reject_withdrawn',
          feedback: { reasonCode: 'wrong' },
          decidedAt: 301,
        })
      ).outcome,
      'conflict',
    );
  });

  it('hard-forget removes rejected subject suppression for a person-bound candidate', async () => {
    const seed = candidateInput({
      candidateId: 'person_candidate_forget_dormant_seed',
      interactionDraft: undefined,
      remainingDraftIds: [claimDraft.draftId],
    });
    await stageAndAnchor(seed);
    const approved = await store.approveDrafts({
      ownerUserId: seed.ownerUserId,
      candidateId: seed.candidateId,
      selectedDraftIds: [claimDraft.draftId],
      decisionId: 'decision_forget_dormant_seed',
      authorizedAt: 200,
    });
    const pending = candidateInput({
      candidateId: 'person_candidate_forget_dormant_pending',
      targetPersonId: approved.receipt.personId,
      personDraft: {
        displayName: '黄挺',
        privateAliases: ['黄挺', 'Huang Ting'],
      },
      interactionDraft: undefined,
      remainingDraftIds: [claimDraft.draftId],
    });
    await stageAndAnchor(pending);
    await store.rejectCandidate({
      ownerUserId: pending.ownerUserId,
      candidateId: pending.candidateId,
      decisionId: 'decision_forget_dormant_pending',
      decidedAt: 300,
    });
    assert.equal(
      (await store.resolveDormantCandidateBySubject(pending.ownerUserId, 'huang ting')).candidateId,
      pending.candidateId,
    );

    await store.hardForget({
      ownerUserId: seed.ownerUserId,
      personId: approved.receipt.personId,
      requestId: 'person_forget_dormant',
      requestedAt: 500,
    });

    assert.equal(await store.resolveDormantCandidateBySubject(seed.ownerUserId, '黄挺'), null);
    assert.equal(await store.resolveDormantCandidateBySubject(seed.ownerUserId, 'huang ting'), null);
    assert.deepEqual(await redis.smembers(PersonMemoryKeys.suppressionSubject(seed.ownerUserId, 'huang ting')), []);
    assert.deepEqual(
      await redis.smembers(PersonMemoryKeys.personArtifacts(seed.ownerUserId, approved.receipt.personId)),
      [],
    );
  });

  it('atomically supersedes a current claim and rejects a stale correction anchor', async () => {
    const input = candidateInput({
      candidateId: 'person_candidate_correction',
      interactionDraft: undefined,
      remainingDraftIds: [claimDraft.draftId],
    });
    await stageAndAnchor(input);
    const approved = await store.approveDrafts({
      ownerUserId: input.ownerUserId,
      candidateId: input.candidateId,
      selectedDraftIds: [claimDraft.draftId],
      decisionId: 'decision_initial_claim',
      authorizedAt: 200,
    });
    const [current] = await store.listClaims(input.ownerUserId, approved.receipt.personId);

    const correctionInput = {
      ownerUserId: input.ownerUserId,
      personId: approved.receipt.personId,
      expectedCurrentClaimId: current.claimId,
      payload: {
        kind: 'reported_fact',
        predicate: 'organization_unit',
        value: '终端用户计算开发部（非 You 同部门）',
        assertedBy: 'owner',
      },
      sourceMessageRef,
      requestId: 'correction_1',
      correctedAt: 400,
    };
    const [a, b] = await Promise.all([
      store.correctClaim(correctionInput),
      store.correctClaim({ ...correctionInput, requestId: 'correction_2' }),
    ]);
    assert.equal([a.outcome, b.outcome].filter((value) => value === 'applied').length, 1);
    assert.equal([a.outcome, b.outcome].filter((value) => value === 'conflict').length, 1);

    const claims = await store.listClaims(input.ownerUserId, approved.receipt.personId);
    assert.equal(claims.length, 2);
    assert.equal(claims.filter((claim) => claim.status === 'current').length, 1);
    assert.equal(claims.filter((claim) => claim.status === 'superseded').length, 1);
  });

  it('appends a retirement version and removes the current projection', async () => {
    const input = candidateInput({
      candidateId: 'person_candidate_retirement',
      interactionDraft: undefined,
      remainingDraftIds: [claimDraft.draftId],
    });
    await stageAndAnchor(input);
    const approved = await store.approveDrafts({
      ownerUserId: input.ownerUserId,
      candidateId: input.candidateId,
      selectedDraftIds: [claimDraft.draftId],
      decisionId: 'decision_retirement_seed',
      authorizedAt: 200,
    });
    const [current] = await store.listClaims(input.ownerUserId, approved.receipt.personId);
    const retired = await store.retireClaim({
      ownerUserId: input.ownerUserId,
      personId: approved.receipt.personId,
      expectedCurrentClaimId: current.claimId,
      sourceMessageRef,
      requestId: 'retirement_1',
      retiredAt: 350,
    });
    assert.equal(retired.outcome, 'applied');
    const claims = await store.listClaims(input.ownerUserId, approved.receipt.personId);
    assert.deepEqual(
      claims.map((entry) => entry.status),
      ['superseded', 'retired'],
    );
    assert.equal(
      claims.some((entry) => entry.status === 'current'),
      false,
    );
  });

  it('redacts an exact claim payload and source without deleting the person', async () => {
    const input = candidateInput({
      candidateId: 'person_candidate_redaction',
      interactionDraft: undefined,
      remainingDraftIds: [claimDraft.draftId],
    });
    await stageAndAnchor(input);
    const approved = await store.approveDrafts({
      ownerUserId: input.ownerUserId,
      candidateId: input.candidateId,
      selectedDraftIds: [claimDraft.draftId],
      decisionId: 'decision_redaction_seed',
      authorizedAt: 200,
    });
    const [current] = await store.listClaims(input.ownerUserId, approved.receipt.personId);
    const redacted = await store.redactItem({
      ownerUserId: input.ownerUserId,
      personId: approved.receipt.personId,
      item: { kind: 'claim', id: current.claimId },
      requestId: 'redaction_1',
      redactedAt: 360,
    });
    assert.equal(redacted.outcome, 'applied');
    const [claim] = await store.listClaims(input.ownerUserId, approved.receipt.personId);
    assert.equal(claim.status, 'redacted');
    assert.deepEqual(claim.payload, { kind: 'redacted' });
    assert.deepEqual(claim.sourceRefs, []);
    assert.equal(claim.typedProvenance, undefined);
    assert.equal(JSON.stringify(claim).includes('终端用户计算开发部'), false);
    assert.notEqual(await store.getPerson(input.ownerUserId, approved.receipt.personId), null);
  });

  it('appends an interaction amendment instead of overwriting the original event', async () => {
    const input = candidateInput({
      candidateId: 'person_candidate_amend',
      claimDrafts: [],
      remainingDraftIds: [eventDraft.draftId],
    });
    await stageAndAnchor(input);
    const approved = await store.approveDrafts({
      ownerUserId: input.ownerUserId,
      candidateId: input.candidateId,
      selectedDraftIds: [eventDraft.draftId],
      decisionId: 'decision_initial_event',
      authorizedAt: 200,
    });
    const [original] = await store.listInteractionEvents(input.ownerUserId, approved.receipt.personId);

    const amended = await store.amendInteractionEvent({
      ownerUserId: input.ownerUserId,
      personId: approved.receipt.personId,
      expectedEventId: original.eventId,
      payload: {
        eventKind: 'meeting',
        headline: '线下见面（日期待确认）',
        occurredAt: eventDraft.payload.occurredAt,
        duration: eventDraft.payload.duration,
        importanceOrTopic: eventDraft.payload.importanceOrTopic,
        uncertaintyNotes: eventDraft.payload.uncertaintyNotes,
      },
      sourceMessageRef,
      requestId: 'event_amend_1',
      amendedAt: 400,
    });
    assert.equal(amended.outcome, 'applied');

    const events = await store.listInteractionEvents(input.ownerUserId, approved.receipt.personId);
    assert.equal(events.length, 2);
    assert.equal(events[0].amendsEventId, undefined);
    assert.equal(events[1].amendsEventId, original.eventId);
  });

  it('keeps a stable relationship ID and appends status transitions', async () => {
    const initialRelationship = {
      draftId: 'person_draft_relationship_current',
      payload: { status: 'current' },
      normalizedDraft: '黄挺与 You 当前有工作关系',
      sourceRole: 'owner_explicit',
      evidenceExcerpt: '我们现在有工作关系',
      decision: 'pending',
    };
    const input = candidateInput({
      candidateId: 'person_candidate_relationship_initial',
      claimDrafts: [],
      interactionDraft: undefined,
      relationshipDraft: initialRelationship,
      remainingDraftIds: [initialRelationship.draftId],
    });
    await stageAndAnchor(input);
    const approved = await store.approveDrafts({
      ownerUserId: input.ownerUserId,
      candidateId: input.candidateId,
      selectedDraftIds: [initialRelationship.draftId],
      decisionId: 'decision_relationship_initial',
      authorizedAt: 200,
    });
    const [initial] = await store.listRelationships(input.ownerUserId, approved.receipt.personId);
    assert.equal(initial.status, 'current');
    assert.equal(initial.transitions.length, 1);

    const formerRelationship = {
      ...initialRelationship,
      draftId: 'person_draft_relationship_former',
      payload: { status: 'former' },
      normalizedDraft: '黄挺与 You 的工作关系已结束',
      evidenceExcerpt: '我们现在不再共事',
    };
    const update = candidateInput({
      candidateId: 'person_candidate_relationship_update',
      targetPersonId: approved.receipt.personId,
      claimDrafts: [],
      interactionDraft: undefined,
      relationshipDraft: formerRelationship,
      remainingDraftIds: [formerRelationship.draftId],
      createdAt: 300,
    });
    await stageAndAnchor(update);
    const changed = await store.approveDrafts({
      ownerUserId: update.ownerUserId,
      candidateId: update.candidateId,
      selectedDraftIds: [formerRelationship.draftId],
      decisionId: 'decision_relationship_update',
      authorizedAt: 400,
    });
    const [current] = await store.listRelationships(update.ownerUserId, approved.receipt.personId);
    assert.equal(changed.receipt.materializedRelationshipIds[0], initial.relationshipId);
    assert.equal(current.relationshipId, initial.relationshipId);
    assert.equal(current.status, 'former');
    assert.deepEqual(
      current.transitions.map((transition) => transition.status),
      ['current', 'former'],
    );

    const undone = await store.undoDecision({
      ownerUserId: update.ownerUserId,
      candidateId: update.candidateId,
      decisionId: changed.receipt.decisionId,
      requestId: 'undo_relationship_update',
      undoneAt: 450,
    });
    assert.equal(undone.outcome, 'applied');
    const [restored] = await store.listRelationships(update.ownerUserId, approved.receipt.personId);
    assert.equal(restored.relationshipId, initial.relationshipId);
    assert.equal(restored.status, 'current');
    assert.deepEqual(
      restored.transitions.map((transition) => transition.status),
      ['current'],
    );
  });

  it('hard-forget purges canonical truth, aliases, candidates and caches with a content-free receipt', async () => {
    const input = candidateInput({
      candidateId: 'person_candidate_forget',
      personDraft: {
        displayName: '黄挺',
        privateAliases: ['黄挺'],
        workspaceEntityLink: {
          entityRef: 'person:huang-ting-huawei',
          state: 'linked',
          checkedAt: 150,
        },
      },
      interactionDraft: undefined,
      remainingDraftIds: [claimDraft.draftId],
    });
    await stageAndAnchor(input);
    const approved = await store.approveDrafts({
      ownerUserId: input.ownerUserId,
      candidateId: input.candidateId,
      selectedDraftIds: [claimDraft.draftId],
      decisionId: 'decision_forget_seed',
      authorizedAt: 200,
    });
    assert.equal((await store.resolveActivePersonByAlias(input.ownerUserId, '黄挺')).status, 'resolved');
    assert.equal(
      (await store.resolveActivePersonByWorkspaceEntityRef(input.ownerUserId, 'person:huang-ting-huawei')).status,
      'resolved',
    );
    const sharedEntitySentinel = 'entity-registry:person:huang-ting-huawei';
    await redis.set(sharedEntitySentinel, 'shared-entity-must-survive');

    const receipt = await store.hardForget({
      ownerUserId: input.ownerUserId,
      personId: approved.receipt.personId,
      requestId: 'person_forget_1',
      requestedAt: 500,
    });
    assert.equal(receipt.verdict, 'purged');
    assert.equal(await store.getPerson(input.ownerUserId, approved.receipt.personId), null);
    assert.deepEqual(await store.listClaims(input.ownerUserId, approved.receipt.personId), []);
    assert.deepEqual(await store.listInteractionEvents(input.ownerUserId, approved.receipt.personId), []);
    assert.equal(await store.getCandidateForOwner(input.ownerUserId, input.candidateId), null);
    assert.deepEqual(await store.resolveActivePersonByAlias(input.ownerUserId, '黄挺'), {
      status: 'not_available',
    });
    assert.deepEqual(
      await store.resolveActivePersonByWorkspaceEntityRef(input.ownerUserId, 'person:huang-ting-huawei'),
      { status: 'not_available' },
    );
    assert.equal(await redis.get(sharedEntitySentinel), 'shared-entity-must-survive');

    const serializedReceipt = JSON.stringify(receipt);
    assert.equal(serializedReceipt.includes('黄挺'), false);
    assert.equal(serializedReceipt.includes(sourceMessageRef.messageId), false);
  });

  it('does not clear a workspace Entity reverse key no longer owned by the forgotten person', async () => {
    const input = candidateInput({
      candidateId: 'person_candidate_forget_reassigned_reverse',
      personDraft: {
        displayName: '黄挺',
        privateAliases: ['黄挺'],
        workspaceEntityLink: {
          entityRef: 'person:huang-ting-huawei',
          state: 'linked',
          checkedAt: 150,
        },
      },
      interactionDraft: undefined,
      remainingDraftIds: [claimDraft.draftId],
    });
    await stageAndAnchor(input);
    const approved = await store.approveDrafts({
      ownerUserId: input.ownerUserId,
      candidateId: input.candidateId,
      selectedDraftIds: [claimDraft.draftId],
      decisionId: 'decision_forget_reassigned_reverse',
      authorizedAt: 200,
    });
    const reverseKey = PersonMemoryKeys.workspaceEntityPerson(input.ownerUserId, 'person:huang-ting-huawei');
    await redis.set(reverseKey, 'person_other_extension');

    const receipt = await store.hardForget({
      ownerUserId: input.ownerUserId,
      personId: approved.receipt.personId,
      requestId: 'person_forget_reassigned_reverse',
      requestedAt: 500,
    });

    assert.equal(receipt.verdict, 'purged');
    assert.equal(await redis.get(reverseKey), 'person_other_extension');
  });

  it('blocks a concurrent rejection from leaving suppression or pending state after hard-forget', async () => {
    const input = candidateInput({
      candidateId: 'person_candidate_forget_reject_seed',
      interactionDraft: undefined,
      remainingDraftIds: [claimDraft.draftId],
    });
    await stageAndAnchor(input);
    const approved = await store.approveDrafts({
      ownerUserId: input.ownerUserId,
      candidateId: input.candidateId,
      selectedDraftIds: [claimDraft.draftId],
      decisionId: 'decision_forget_reject_seed',
      authorizedAt: 200,
    });
    const pendingInput = candidateInput({
      candidateId: 'person_candidate_forget_reject_race',
      targetPersonId: approved.receipt.personId,
      interactionDraft: undefined,
      remainingDraftIds: [claimDraft.draftId],
    });
    await stageAndAnchor(pendingInput);

    const paused = pauseBeforeEval(FINISH_HARD_FORGET_LUA);
    const forgettingStore = new RedisPersonMemoryStore(paused.client);
    const forgetPromise = forgettingStore.hardForget({
      ownerUserId: input.ownerUserId,
      personId: approved.receipt.personId,
      requestId: 'person_forget_reject_race',
      requestedAt: 500,
    });
    await paused.reached;

    const rejection = await store.rejectCandidate({
      ownerUserId: input.ownerUserId,
      candidateId: pendingInput.candidateId,
      decisionId: 'decision_forget_reject_race',
      feedback: { reasonCode: 'wrong' },
      decidedAt: 510,
    });
    paused.release();
    const receipt = await forgetPromise;

    assert.equal(rejection.outcome, 'not_available');
    assert.equal(receipt.verdict, 'purged');
    assert.equal(await redis.get(PersonMemoryKeys.suppression(input.ownerUserId, pendingInput.candidateId)), null);
    assert.deepEqual(await redis.smembers(PersonMemoryKeys.suppressionSubject(input.ownerUserId, '黄挺')), []);
    assert.equal(await redis.zscore(PersonMemoryKeys.pending(input.ownerUserId), pendingInput.candidateId), null);
    assert.deepEqual(
      await redis.smembers(PersonMemoryKeys.personArtifacts(input.ownerUserId, approved.receipt.personId)),
      [],
    );
  });

  it('fences every person-bound candidate transition while hard-forget owns the person', async () => {
    const seed = candidateInput({
      candidateId: 'person_candidate_forget_transition_seed',
      interactionDraft: undefined,
      remainingDraftIds: [claimDraft.draftId],
    });
    await stageAndAnchor(seed);
    const seeded = await store.approveDrafts({
      ownerUserId: seed.ownerUserId,
      candidateId: seed.candidateId,
      selectedDraftIds: [claimDraft.draftId],
      decisionId: 'decision_forget_transition_seed',
      authorizedAt: 200,
    });
    const staged = candidateInput({
      candidateId: 'person_candidate_forget_transition_staged',
      targetPersonId: seeded.receipt.personId,
      interactionDraft: undefined,
      remainingDraftIds: [claimDraft.draftId],
    });
    await store.stageCandidate(staged);
    const approved = candidateInput({
      candidateId: 'person_candidate_forget_transition_approved',
      targetPersonId: seeded.receipt.personId,
      interactionDraft: undefined,
      remainingDraftIds: [claimDraft.draftId],
    });
    await stageAndAnchor(approved);
    const approvedDecision = await store.approveDrafts({
      ownerUserId: approved.ownerUserId,
      candidateId: approved.candidateId,
      selectedDraftIds: [claimDraft.draftId],
      decisionId: 'decision_forget_transition_approved',
      authorizedAt: 250,
    });
    const pending = candidateInput({
      candidateId: 'person_candidate_forget_transition_pending',
      targetPersonId: seeded.receipt.personId,
      interactionDraft: undefined,
      remainingDraftIds: [claimDraft.draftId],
    });
    await store.stageCandidate(pending);
    await store.commitEnvelope(pending.candidateId, envelopeFor(pending));
    const fenceKey = PersonMemoryKeys.forgetFence(seed.ownerUserId, seeded.receipt.personId);
    assert.equal(
      String(
        await redis.eval(
          BEGIN_HARD_FORGET_LUA,
          4,
          fenceKey,
          PersonMemoryKeys.forgetReceipt(seed.ownerUserId, 'person_forget_transition_fence'),
          PersonMemoryKeys.person(seed.ownerUserId, seeded.receipt.personId),
          PersonMemoryKeys.personArtifacts(seed.ownerUserId, seeded.receipt.personId),
          'person_forget_transition_fence',
          String(24 * 60 * 60 * 1_000),
        ),
      ),
      'FENCED',
    );

    await assert.rejects(() => store.commitEnvelope(staged.candidateId, envelopeFor(staged)), /NOT_AVAILABLE/);
    await store.abortStaged(staged.candidateId, 'forget_in_progress');
    assert.notEqual(await store.getCandidateForOwner(staged.ownerUserId, staged.candidateId), null);
    await assert.rejects(() => store.markNotNow(pending.ownerUserId, pending.candidateId, 300), /NOT_AVAILABLE/);
    assert.equal(
      (
        await store.rejectCandidate({
          ownerUserId: pending.ownerUserId,
          candidateId: pending.candidateId,
          decisionId: 'decision_forget_transition_pending_reject',
          decidedAt: 310,
        })
      ).outcome,
      'not_available',
    );
    assert.equal(
      (
        await store.approveDrafts({
          ownerUserId: pending.ownerUserId,
          candidateId: pending.candidateId,
          selectedDraftIds: [claimDraft.draftId],
          decisionId: 'decision_forget_transition_pending',
          authorizedAt: 320,
        })
      ).outcome,
      'not_available',
    );
    assert.equal(
      (
        await store.undoDecision({
          ownerUserId: approved.ownerUserId,
          candidateId: approved.candidateId,
          decisionId: approvedDecision.receipt.decisionId,
          requestId: 'undo_forget_transition_approved',
          undoneAt: 330,
        })
      ).outcome,
      'not_available',
    );
  });

  it('CAS-blocks finish when the Entity reverse key changes after the hard-forget snapshot', async () => {
    const input = candidateInput({
      candidateId: 'person_candidate_forget_reverse_race',
      personDraft: {
        displayName: '黄挺',
        privateAliases: ['黄挺'],
        workspaceEntityLink: {
          entityRef: 'person:huang-ting-huawei',
          state: 'linked',
          checkedAt: 150,
        },
      },
      interactionDraft: undefined,
      remainingDraftIds: [claimDraft.draftId],
    });
    await stageAndAnchor(input);
    const approved = await store.approveDrafts({
      ownerUserId: input.ownerUserId,
      candidateId: input.candidateId,
      selectedDraftIds: [claimDraft.draftId],
      decisionId: 'decision_forget_reverse_race',
      authorizedAt: 200,
    });
    const reverseKey = PersonMemoryKeys.workspaceEntityPerson(input.ownerUserId, 'person:huang-ting-huawei');
    const paused = pauseBeforeEval(FINISH_HARD_FORGET_LUA);
    const forgettingStore = new RedisPersonMemoryStore(paused.client);
    const firstAttempt = forgettingStore
      .hardForget({
        ownerUserId: input.ownerUserId,
        personId: approved.receipt.personId,
        requestId: 'person_forget_reverse_race',
        requestedAt: 500,
      })
      .then(
        (receipt) => ({ status: 'purged', receipt }),
        (error) => ({ status: 'conflict', error }),
      );
    await paused.reached;

    await redis.set(reverseKey, 'person_other_extension');
    paused.release();
    const firstResult = await firstAttempt;

    assert.equal(firstResult.status, 'conflict');
    assert.match(String(firstResult.error), /CONFLICT/);
    assert.equal(await redis.get(reverseKey), 'person_other_extension');

    const retried = await store.hardForget({
      ownerUserId: input.ownerUserId,
      personId: approved.receipt.personId,
      requestId: 'person_forget_reverse_race',
      requestedAt: 500,
    });
    assert.equal(retried.verdict, 'purged');
    assert.equal(await redis.get(reverseKey), 'person_other_extension');
  });

  it('preflights the complete hard-forget plan before the first deletion', async () => {
    const input = await stageAndAnchor(
      candidateInput({
        candidateId: 'person_candidate_forget_plan_guard',
        interactionDraft: undefined,
        remainingDraftIds: [claimDraft.draftId],
      }),
    );
    const approved = await store.approveDrafts({
      ownerUserId: input.ownerUserId,
      candidateId: input.candidateId,
      selectedDraftIds: [claimDraft.draftId],
      decisionId: 'decision_forget_plan_guard',
      authorizedAt: 200,
    });
    const fenceKey = PersonMemoryKeys.forgetFence(input.ownerUserId, approved.receipt.personId);
    const receiptKey = PersonMemoryKeys.forgetReceipt(input.ownerUserId, 'person_forget_plan_guard');
    const candidateKey = PersonMemoryKeys.candidate(input.ownerUserId, input.candidateId);
    assert.equal(
      String(
        await redis.eval(
          BEGIN_HARD_FORGET_LUA,
          4,
          fenceKey,
          receiptKey,
          PersonMemoryKeys.person(input.ownerUserId, approved.receipt.personId),
          PersonMemoryKeys.personArtifacts(input.ownerUserId, approved.receipt.personId),
          'person_forget_plan_guard',
          String(24 * 60 * 60 * 1_000),
        ),
      ),
      'FENCED',
    );
    const candidateBefore = await redis.get(candidateKey);
    const invalidPlans = [
      '{',
      JSON.stringify({
        fenceKeyIndexes: [],
        expectedTypes: [{ keyIndex: 3, type: 'string' }],
        preconditions: [],
        mutations: [{ op: 'unknown', keyIndex: 3 }],
      }),
      JSON.stringify({
        fenceKeyIndexes: [],
        expectedTypes: [{ keyIndex: 99, type: 'string' }],
        preconditions: [],
        mutations: [{ op: 'del', keyIndex: 99 }],
      }),
    ];
    for (const plan of invalidPlans) {
      assert.equal(
        String(
          await redis.eval(
            FINISH_HARD_FORGET_LUA,
            3,
            fenceKey,
            receiptKey,
            candidateKey,
            'person_forget_plan_guard',
            '{}',
            plan,
          ),
        ),
        'INVALID_PLAN',
      );
      assert.equal(await redis.get(candidateKey), candidateBefore);
      assert.equal(await redis.get(receiptKey), null);
      assert.equal(await redis.get(fenceKey), 'person_forget_plan_guard');
    }
  });

  it('expires an orphaned hard-forget fence so a new request can recover', async () => {
    const input = candidateInput({
      candidateId: 'person_candidate_forget_recovery',
      interactionDraft: undefined,
      remainingDraftIds: [claimDraft.draftId],
    });
    await stageAndAnchor(input);
    const approved = await store.approveDrafts({
      ownerUserId: input.ownerUserId,
      candidateId: input.candidateId,
      selectedDraftIds: [claimDraft.draftId],
      decisionId: 'decision_forget_recovery_seed',
      authorizedAt: 200,
    });
    const fenceKey = PersonMemoryKeys.forgetFence(input.ownerUserId, approved.receipt.personId);
    const begin = String(
      await redis.eval(
        BEGIN_HARD_FORGET_LUA,
        4,
        fenceKey,
        PersonMemoryKeys.forgetReceipt(input.ownerUserId, 'orphaned_forget_request'),
        PersonMemoryKeys.person(input.ownerUserId, approved.receipt.personId),
        PersonMemoryKeys.personArtifacts(input.ownerUserId, approved.receipt.personId),
        'orphaned_forget_request',
        String(24 * 60 * 60 * 1_000),
      ),
    );
    assert.equal(begin, 'FENCED');
    const fenceTtlMs = await redis.pttl(fenceKey);
    assert.ok(fenceTtlMs > 0 && fenceTtlMs <= 24 * 60 * 60 * 1_000);

    await redis.pexpireat(fenceKey, 1);
    assert.equal(await redis.get(fenceKey), null);
    const recovered = await store.hardForget({
      ownerUserId: input.ownerUserId,
      personId: approved.receipt.personId,
      requestId: 'person_forget_after_orphan',
      requestedAt: 600,
    });
    assert.equal(recovered.verdict, 'purged');
    assert.equal(await store.getPerson(input.ownerUserId, approved.receipt.personId), null);
  });
});
